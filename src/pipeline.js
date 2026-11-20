// The pipeline: record → cut → export. Fixed code, runs without any model, given a shotlist.json.
// It keeps its state in .pushreel/run.json so that a run can pause at a failed scene and continue later.
import { rmSync, existsSync, copyFileSync, lstatSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { paths, readJson, writeJson, appendLine, ensureDir, ownsProcess, signalOwned, processStart, insideDir, today, clock, fmtSize, fmtDur, round, run as exec } from './util.js';
import { loadShotlist, totalSeconds } from './shotlist.js';
import { ensureLicence } from './license.js';
import { ensureApp, stopApp, appInfo } from './detect.js';
import { recordScenes, recorded, MAX_TRIES } from './record.js';
import { cutAll, exportAll, copyExtras, requireFfmpeg } from './cut.js';
import { PLATFORMS } from './presets.js';
import { E, PushreelError } from './errors.js';
import { styleLine } from './style.js';
import { originProblems } from './origin.js';

export const readRun = (dir) => readJson(paths(dir).runJson);

/**
 * Runs the pipeline.
 * @param {string} dir project directory
 * @param {object} o { mode: 'fresh' | 'resume' | 'rerender', skip?: number[], url?: string, shotlistFile?: string, say?: (line) => void,
 *   style?: string, template?: string, noProjectStyle?: boolean }  --style, --template and --no-project-style of this command
 * @returns {Promise<{ status: 'done' | 'paused', run: object }>}
 */
export async function pipeline(dir, o = {}) {
  const p = paths(dir), mode = o.mode || 'fresh', say = o.say || (() => {});
  const licence = await ensureLicence();
  const prev = readRun(dir);
  if (prev && ownsProcess(prev) && ['recording', 'cutting', 'exporting'].includes(prev.status)) throw E.busy(prev.pid);
  if (mode === 'resume' && !(prev && prev.status === 'paused')) throw E.nothingToResume();
  requireFfmpeg();
  const linked = linkedFolders(p);
  if (linked.length) throw E.linkedFolder(linked);

  if (o.shotlistFile && o.shotlistFile !== p.shotlist) { ensureDir(p.state); copyFileSync(o.shotlistFile, p.shotlist); }
  const { shotlist, warnings, info, style, template } = loadShotlist(p.shotlist, dir, { style: o.style, template: o.template, noProjectStyle: o.noProjectStyle, allowRemote: !!o.allowRemote });
  const dirs = { raw: p.raw, cut: p.cut, failed: p.failed };

  if (mode === 'fresh') { rmSync(p.run, { recursive: true, force: true }); }
  ensureDir(p.run);
  rmSync(p.cut, { recursive: true, force: true });
  const skip = mode === 'fresh' ? [] : [...new Set([...((prev && prev.skip) || []), ...(o.skip || [])])];
  if (mode !== 'fresh' && o.skip && o.skip.length) {
    const unknown = o.skip.filter((id) => !shotlist.scenes.some((s) => s.id === id));
    if (unknown.length) throw E.invalidShotlist([`--skip names scene ${unknown.join(', ')}. The shot list has scenes ${shotlist.scenes.map((s) => s.id).join(', ')}.`]);
  }
  const included = shotlist.scenes.filter((s) => s.include && !skip.includes(s.id));
  if (!included.length) throw E.invalidShotlist(['No scene is left to export: every scene is switched off or skipped.']);

  const t0 = Date.now();
  const run = {
    id: mode === 'fresh' || !prev ? new Date().toISOString().replace(/[:.]/g, '-') : prev.id,
    mode, status: 'recording', pid: process.pid, pidStart: processStart(process.pid), startedAt: mode === 'fresh' || !prev ? new Date().toISOString() : prev.startedAt, updatedAt: null,
    app: { name: shotlist.app.name, slug: shotlist.app.slug }, baseUrl: (prev && mode !== 'fresh' && prev.baseUrl) || null, userUrl: o.url || (prev && mode !== 'fresh' && prev.userUrl) || null, appStartedByPushreel: !!(appInfo(dir) || {}).ours, appStopped: false,
    skip, error: null, outDir: null, files: [], stats: (prev && mode !== 'fresh' && prev.stats) || { retries: 0 }, elapsed: (prev && mode === 'resume' && prev.elapsed) || 0,
    licence: licence.devOnly ? 'dev licence' : 'licensed',
    style: { line: styleLine(style), base: style.base, baseFrom: style.baseFrom, layers: style.layers.map((l) => ({ label: l.label, kind: l.kind })) },
    template: template.name ? { name: template.name, from: template.from, kind: template.kind, rulesFrom: template.rulesFrom } : template.rulesFrom.length ? { name: null, rulesFrom: template.rulesFrom } : null,
    scenes: shotlist.scenes.map((s) => ({ id: s.id, title: s.title, url: s.url, duration: s.duration, status: !s.include ? 'off' : skip.includes(s.id) ? 'skipped' : recorded(dirs, shotlist, s) ? 'recorded' : 'waiting' })),
    steps: [],
  };
  const save = () => { run.updatedAt = new Date().toISOString(); writeJson(p.runJson, run); };
  const log = (line) => { appendLine(p.runLog, `${clock()}  ${line}`); };
  const emit = (line, quiet) => { log(line); if (!quiet) say(line); };
  const step = (id, label, patch) => {
    let s = run.steps.find((x) => x.id === id);
    if (!s) { s = { id, label, status: 'waiting', note: '' }; run.steps.push(s); }
    Object.assign(s, patch); save();
  };
  const sceneState = (id, patch) => { Object.assign(run.scenes.find((s) => s.id === id), patch); save(); };

  let stop = false;
  const onSignal = () => { stop = true; };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);

  const toRecord = included.filter((s) => !recorded(dirs, shotlist, s));
  step('record', 'Record from shotlist.json', {});
  step('cut', 'Cut', {});
  step('captions', 'Captions', {});
  for (const t of shotlist.targets) step(`export-${t}`, `Export ${PLATFORMS[t].name}`, {});
  step('extras', 'Cover and post texts', {});
  step('stopapp', 'Stop the app', {});
  log(`--- pushreel ${mode} · ${shotlist.app.name} · ${included.length} scenes · targets ${shotlist.targets.join(', ')} ---`);
  emit(`● Style: ${styleLine(style)}`);
  emit(`● Template: ${template.name ? `${template.name} (${template.kind}), chosen by ${template.from}` : 'none'}${template.rulesFrom.length ? `; rules from ${template.rulesFrom.join(' + ')}` : ''}`);
  for (const w of warnings) emit(`! ${w}`);
  for (const w of info) emit(`· ${w}`);

  const pause = async (error, sceneId) => {
    run.status = 'paused'; run.pid = null; run.elapsed += (Date.now() - t0) / 1000;
    run.error = { ...error.toJSON(), at: new Date().toISOString(), screenshot: error.screenshot ? relative(p.root, error.screenshot) : null, sawUrl: error.sawUrl || null };
    const rec = run.scenes.filter((s) => s.status === 'recorded').map((s) => s.id);
    const app = (appInfo(dir) || {}).ours ? appInfo(dir) : null;
    run.error.saved = `${rec.length ? `Scene${rec.length > 1 ? 's' : ''} ${list(rec)} ${rec.length > 1 ? 'are' : 'is'} recorded and saved.` : 'No scene is recorded yet.'} Nothing is lost.` +
      (app ? ` Your app keeps running at ${app.url}. Pushreel started it and stops it after you resume or cancel.` : '') +
      (run.error.screenshot ? `\nScreenshot of what the browser saw: ./${run.error.screenshot}` : '');
    error.saved = run.error.saved;
    run.steps.forEach((s) => { if (s.status === 'running') s.status = 'failed'; });
    if (sceneId) sceneState(sceneId, { status: 'failed', error: error.code });
    save();
    log(`✗ paused: ${error.title}`);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    return { status: 'paused', run, error };
  };

  try {
    // ---------- record ----------
    step('record', 'Record from shotlist.json', { status: 'running', note: toRecord.length ? 'Starting' : 'Nothing to record' });
    if (toRecord.length) {
      const app = await ensureApp(dir, { url: run.userUrl || shotlist.baseUrl, allowRemote: !!o.allowRemote, log: (l) => emit(`● ${l}`) });
      // Every address of the shot list stays on the app (src/origin.js), unless the user typed --allow-remote.
      const off = originProblems(shotlist, app.url, { allowRemote: !!o.allowRemote });
      if (off.length) throw E.invalidShotlist(off);
      run.baseUrl = app.url; run.appStartedByPushreel = app.startedByPushreel; save();
      emit(app.already ? `● Using your app at ${app.url}${app.startedByPushreel ? ' (started by Pushreel earlier)' : '. Pushreel leaves it running.'}` : `● App is up at ${app.url}`);
      emit(`● Recording from shotlist.json (fixed steps, no model calls) at 1080×1920`);
      const res = await recordScenes({
        projectDir: dir, shotlist, scenes: toRecord, baseUrl: app.url, allowRemote: !!o.allowRemote, dirs, shouldStop: () => stop,
        onEvent: (e) => {
          if (e.type === 'session' || e.type === 'prepare') emit(`● ${e.message}`);
          if (e.type === 'scene-start') { sceneState(e.scene, { status: 'recording', attempt: e.attempt }); step('record', '', { note: `Scene ${e.scene} of ${shotlist.scenes.length} · ${e.url}${e.attempt > 1 ? ` · try ${e.attempt} of ${MAX_TRIES}` : ''}` }); }
          if (e.type === 'scene-retry') { run.stats.retries = (run.stats.retries || 0) + 1; save(); emit(`  ↻ ${e.message}`); }
          if (e.type === 'scene-done') { sceneState(e.scene, { status: 'recorded', attempt: e.attempt, rawSeconds: e.duration, error: null }); emit(`  ✓ Scene ${e.scene}  ${e.url.padEnd(14)} ${e.duration.toFixed(1)} s${e.attempt > 1 ? `  (try ${e.attempt} of ${MAX_TRIES})` : ''}`); if (e.redirectedTo) emit(`    ! Scene ${e.scene} asked for ${e.url} and the app sent the browser to ${e.redirectedTo}. The video shows that page. ${e.lane === 'guest' ? 'The scene was recorded as a visitor; if it is behind the login, set "requiresLogin": true.' : 'The scene was recorded signed in; if it is a page for visitors (a landing page), remove "requiresLogin".'}`); }
        },
      });
      if (res.failed) {
        const { scene, error } = res.failed;
        if (!(error instanceof PushreelError)) throw Object.assign(error, { sceneId: scene.id });
        if (res.failed.prepare) { emit(`  ✗ Prepare stopped: ${error.code.replace(/_/g, ' ')}`); return await pause(error, null); }
        if (error.code !== 'stopped') emit(`  ✗ Scene ${scene.id}  ${scene.url.padEnd(14)} stopped: ${error.code.replace(/_/g, ' ')}`);
        return await pause(error, error.code === 'stopped' ? null : scene.id);
      }
    } else emit('● All scenes are already recorded. Re-cutting from the saved footage, no browser needed.');
    step('record', 'Record from shotlist.json', { status: 'done', note: `${included.length} ${included.length === 1 ? 'scene' : 'scenes'} at 1080×1920${toRecord.length < included.length ? `, ${included.length - toRecord.length} reused` : ''}` });
    // A still per recorded scene for the Studio preview: the frame shortly after the first click.
    ensureDir(p.stills);
    for (const sc of included) {
      const ev = readJson(join(p.raw, `scene-${sc.id}.json`));
      const at = ev.clicks.length ? Math.min(ev.duration - 0.1, ev.clicks[0].t + 0.5) : Math.min(ev.duration - 0.1, 1);
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(round(at)), '-i', join(p.raw, ev.file), '-frames:v', '1', '-vf', 'scale=540:-1', join(p.stills, `scene-${sc.id}.png`)]).catch(() => {});
      writeJson(join(p.stills, `scene-${sc.id}.json`), { url: sc.url, clicks: ev.clicks.slice(0, 1).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })), from: 'recording', at: ev.recordedAt });
    }
    if (stop) return await pause(E.stopped());

    // ---------- cut ----------
    run.status = 'cutting'; step('cut', 'Cut', { status: 'running', note: 'Removing waits, zooming on clicks' });
    emit('● Cutting');
    let trimmedAny = false;
    const cut = await cutAll({ dirs, shotlist, scenes: included, onEvent: (e) => {
      if (e.overrun > 0.05) emit(`  ! Scene ${e.scene} runs ${e.length.toFixed(1)} s, ${e.overrun.toFixed(1)} s longer than planned, because its steps take that long.`);
      if (e.trimmed > 0.05) { emit(`  ✓ Scene ${e.scene}: ${e.trimmed.toFixed(1)} s of still picture trimmed from its end, it runs ${e.length.toFixed(1)} s instead of ${e.wanted} s`); trimmedAny = true; }
    } });
    if (trimmedAny) emit('    ("cut": { "trimStillTails": false } keeps every scene at its full length)');
    Object.assign(run.stats, cut.stats);
    const st = cut.stats;
    const cutNote = [st.threshold > 0 ? `${st.waitsRemoved} ${st.waitsRemoved === 1 ? 'wait' : 'waits'} over ${st.threshold} s removed (${st.removedSeconds} s)` : 'waits kept', st.zooms ? `zoom on ${st.zooms} ${st.zooms === 1 ? 'click' : 'clicks'}` : 'no zoom'];
    emit(`  ✓ ${cutNote.join('   ✓ ')}`);
    step('cut', 'Cut', { status: 'done', note: cutNote.join(', ') });
    if (stop) return await pause(E.stopped());

    // ---------- export ----------
    run.status = 'exporting'; step('captions', 'Captions', { status: 'running', note: 'Rendering' });
    // A new run never overwrites the folder of an earlier run; resume and rerender write into their run's folder.
    // run.json is not trusted: an earlier folder is reused only when it lies inside pushreel-out/.
    const reuse = mode !== 'fresh' && prev && prev.app && prev.app.slug === shotlist.app.slug && safeOutDir(p, prev.outDir);
    const outDir = reuse || join(p.root, freeOutDir(p, `${today()}-${shotlist.app.slug}`, prev));
    run.outDir = relative(p.root, outDir); save();
    emit('● Exporting');
    const files = await exportAll({
      dirs, outDir, shotlist, scenes: included, cut, projectDir: dir,
      onEvent: (e) => {
        if (e.type === 'captions') {
          step('captions', 'Captions', { status: 'done', note: shotlist.cut.captions ? `${e.count} ${e.count === 1 ? 'caption' : 'captions'} burned in${e.outside.length ? `, outside the safe area: ${e.outside.join('; ')}` : ', all inside the safe areas'}` : 'Captions off' });
          if (e.outside.length) emit(`  ! Caption outside the safe area: ${e.outside.join('; ')}. Shorten it.`);
          step(`export-${shotlist.targets[0]}`, '', { status: 'running', note: 'Encoding' });
        }
        if (e.type === 'placement') {
          for (const m of e.moved) emit(`  ✓ Caption moved off the page's content, ${m}`, true);
          if (e.moved.length) emit(`  ✓ ${e.moved.length} caption ${e.moved.length === 1 ? 'position' : 'positions'} moved off a click target, heading, picture or bar (details in run.log)`);
          for (const c of e.covered || []) emit(`  · Caption of ${c}`, true);
          if ((e.covered || []).length) emit(`  · ${e.covered.length} caption ${e.covered.length === 1 ? 'position has' : 'positions have'} no free spot; each took the least covered one (details in run.log)`);
          run.cover = e.cover;
        }
        if (e.type === 'export') {
          emit(`  ✓ ${e.name.padEnd(24)} ${PLATFORMS[e.target].name.padEnd(15)} ${String(e.seconds)} s  ${fmtSize(e.bytes)}`);
          step(`export-${e.target}`, '', { status: 'done', note: `${e.name} · ${fmtSize(e.bytes)}` });
          const next = shotlist.targets[shotlist.targets.indexOf(e.target) + 1];
          if (next) step(`export-${next}`, '', { status: 'running', note: 'Encoding' });
        }
      },
    });
    step('extras', 'Cover and post texts', { status: 'running' });
    emit(`  ✓ ${files.find((f) => f.kind === 'cover').name.padEnd(24)} Cover image     1080×1920, scene ${run.cover ? `${run.cover.scene} at ${run.cover.at} s` : '1'}`);
    emit(`  ✓ ${'captions.md'.padEnd(24)} Post texts      ${files.find((f) => f.kind === 'texts').note}`);
    step('extras', 'Cover and post texts', { status: 'done', note: `${shotlist.app.slug}-cover.png, captions.md` });

    // ---------- stop the app, finish ----------
    step('stopapp', 'Stop the app', { status: 'running' });
    const stopped = await stopApp(dir);
    run.appStopped = stopped.stopped;
    step('stopapp', 'Stop the app', { status: 'done', note: stopped.stopped ? `Stopped "${stopped.command}". ${portOf(stopped.url)} is free again.` : 'Not started by Pushreel, left running.' });
    run.elapsed += (Date.now() - t0) / 1000;
    run.status = 'done'; run.pid = null; run.error = null; run.finishedAt = new Date().toISOString();
    run.total = cut.video.total;
    run.video = cut.video;
    log(`Done in ${fmtDur(run.elapsed)}. ./${run.outDir}/`);
    if (stopped.stopped) log(`Stopped the dev server Pushreel started (${stopped.command}).`);
    run.files = [...files, ...copyExtras({ shotlistFile: p.shotlist, runLog: p.runLog, outDir })];
    save();
    say('');
    say(`Done in ${fmtDur(run.elapsed)}.  ./${run.outDir}/`);
    say(stopped.stopped ? `● Stopped the dev server I started. ${portOf(stopped.url)} is free again.` : toRecord.length ? '● Your app was already running. Pushreel left it running.' : '● Nothing was recorded, so your app was not needed.');
    return { status: 'done', run };
  } catch (e) {
    run.elapsed += (Date.now() - t0) / 1000;
    if (e instanceof PushreelError && run.scenes.some((s) => s.status === 'recorded')) return await pause(e, e.scene);
    run.status = 'failed'; run.pid = null; run.error = e instanceof PushreelError ? e.toJSON() : { code: 'unexpected', title: 'Pushreel hit an unexpected error', text: String(e.message || e), next: ['pushreel status', 'Send .pushreel/run/run.log to hello@pushreel.dev'] };
    run.steps.forEach((s) => { if (s.status === 'running') s.status = 'failed'; });
    save(); log(`✗ failed: ${e.stack || e.message || e}`);
    throw e;
  } finally {
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
  }
}
/**
 * The absolute output folder named by run.json, or null when it is not a folder below <project>/pushreel-out/.
 * run.json may come from a cloned repository: nothing is ever written outside pushreel-out/ because of it.
 */
export function safeOutDir(p, outDir) {
  if (typeof outDir !== 'string' || !outDir) return null;
  if (linkedFolders(p).includes('pushreel-out')) return null;
  const abs = resolve(p.root, outDir);
  if (abs === resolve(p.outRoot) || !abs.startsWith(resolve(p.outRoot) + sep) || !insideDir(p.outRoot, abs)) return null;
  return abs;
}
/**
 * The folders Pushreel writes into that are symbolic links (or lead outside the project): '.pushreel' and
 * 'pushreel-out'. A cloned repository could ship them as links, and every write would land where they point.
 */
export function linkedFolders(p) {
  return [['.pushreel', p.state], ['pushreel-out', p.outRoot]].filter(([, f]) => {
    try { if (lstatSync(f).isSymbolicLink()) return true; } catch { return false; }
    return !insideDir(p.root, f);
  }).map(([name]) => name);
}
/** The output folder of a fresh run: pushreel-out/<date>-<slug>, with -2, -3 … when an earlier run already has that name. */
export function freeOutDir(p, name, prev) {
  const rel = (n) => relative(p.root, join(p.outRoot, n));
  if (!existsSync(join(p.outRoot, name))) return rel(name);
  for (let i = 2; i < 1000; i++) if (!existsSync(join(p.outRoot, `${name}-${i}`))) return rel(`${name}-${i}`);
  return rel(name);
}
const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : String(a[0] ?? ''));
const portOf = (url) => { try { return `Port ${new URL(url).port || 80}`; } catch { return 'The port'; } };

/** Ends a paused run: stops the app if Pushreel started it, keeps the recorded scenes and shotlist.json. */
export async function cancel(dir) {
  const p = paths(dir), run = readRun(dir);
  // Only a run of this user that Pushreel started (same pid and start time in run.json) is signalled.
  if (run) signalOwned(run, 'SIGTERM');
  const stopped = await stopApp(dir);
  const kept = run && Array.isArray(run.scenes) ? run.scenes.filter((s) => existsSync(join(p.raw, `scene-${s.id}.mp4`))).map((s) => s.id) : [];
  if (run) {
    const was = run.status;
    run.status = 'cancelled'; run.pid = null; run.appStopped = stopped.stopped; run.cancelledAt = new Date().toISOString(); run.wasStatus = was;
    writeJson(p.runJson, run);
    appendLine(p.runLog, `${clock()}  Run cancelled.${stopped.stopped ? ` Stopped "${stopped.command}".` : ''} Kept: scenes ${kept.join(', ') || 'none'}, shotlist.json.`);
  }
  return { hadRun: !!run, stopped, kept, shotlist: existsSync(p.shotlist) };
}

/** Human summary of the current state, for `pushreel status` and for the agent. */
export function describe(dir) {
  const p = paths(dir), run = readRun(dir), app = appInfo(dir), lines = [];
  if (!run) lines.push(existsSync(p.shotlist) ? 'No run yet. A shot list exists: pushreel run' : 'No run yet and no shot list. In Claude Code: /pushreel');
  else {
    lines.push(`Run ${run.status}${run.status === 'paused' && run.error ? `: ${run.error.title}` : ''} · ${run.app.name}`);
    for (const s of run.scenes) lines.push(`  ${String(s.id).padStart(2)}  ${s.title.padEnd(22).slice(0, 22)} ${s.url.padEnd(16).slice(0, 16)} ${s.status}${s.error ? ` (${s.error.replace(/_/g, ' ')})` : ''}`);
    if (run.status === 'paused' && run.error) { lines.push('', run.error.text, run.error.saved || '', '', 'Next:', ...run.error.next.map((n) => `  ${n}`)); }
    if (run.status === 'done') { lines.push('', `Files in ./${run.outDir}/`, ...run.files.map((f) => `  ${f.name.padEnd(24)} ${f.seconds ? f.seconds + ' s  ' : ''}${fmtSize(f.bytes)}`)); }
  }
  if (app && app.ours) lines.push('', `App started by Pushreel: ${app.url} (${app.command}, pid ${app.pid})`);
  return lines.join('\n');
}
export { totalSeconds, round };
