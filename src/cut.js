// Cut and export. Fixed code, ffmpeg only: remove waits, zoom on clicks, burn in captions, end card, three files.
import { writeFileSync, statSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FRAME, PLATFORMS, ENCODE, END_CARD_SECONDS, clickRects } from './presets.js';
import { planScene, planVideo, ffExpr, toCut } from './timeline.js';
import { renderOverlays } from './render.js';
import { layoutAt, clickFocus } from './place.js';
import { run, ensureDir, readJson, round, which } from './util.js';
import { E } from './errors.js';

const KIND_NAMES = { headline: "the page's headline", heading: 'a heading', bar: 'a fixed bar', picture: 'a picture', title: 'a card title', page: 'the page' };

export function requireFfmpeg() {
  if (!which('ffmpeg') || !which('ffprobe')) throw E.ffmpegMissing();
}
const diskFull = (e) => (/No space left|ENOSPC/i.test(String(e.message) + String(e.stderr || '')) ? E.diskFull() : e);

/** Cuts one recorded scene to its planned length and applies the click zoom. */
async function cutScene(rawFile, plan, zoomOn, out) {
  const W = FRAME.width, H = FRAME.height, f = [];
  plan.keep.forEach(([a, b], i) => f.push(`[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[k${i}]`));
  let last = plan.keep.length === 1 ? 'k0' : 'c';
  if (plan.keep.length > 1) f.push(`${plan.keep.map((_, i) => `[k${i}]`).join('')}concat=n=${plan.keep.length}:v=1:a=0[c]`);
  // always pad a little, so that rounding never leaves the clip a frame short; -frames:v sets the exact length
  f.push(`[${last}]tpad=stop_mode=clone:stop_duration=${round(plan.pad + 0.5)},fps=${FRAME.fps}[p]`); last = 'p';
  if (zoomOn && plan.zoom.length) {
    const z = `(${ffExpr(plan.zoom, 'z', 1)})`, x = `(${ffExpr(plan.zoom, 'x', 0.5)})`, y = `(${ffExpr(plan.zoom, 'y', 0.5)})`;
    // The crop must not use iw and ih: the crop filter reads them once, from the first (unzoomed) frame, so the
    // focus would be clamped to the top left corner for the whole scene. The scaled size is computed from z instead.
    const sw = `(trunc(${W}*${z}/2)*2)`, sh = `(trunc(${H}*${z}/2)*2)`;
    f.push(`[p]scale=w='${sw}':h='${sh}':eval=frame:flags=bicubic,` +
      `crop=${W}:${H}:x='min(max(${x}*${sw}-${W / 2},0),${sw}-${W})':y='min(max(${y}*${sh}-${H / 2},0),${sh}-${H})',setsar=1[v]`);
    last = 'v';
  }
  await run('ffmpeg', ['-v', 'error', '-y', '-i', rawFile, '-filter_complex', f.join(';'), '-map', `[${last}]`,
    '-frames:v', String(Math.round(plan.length * FRAME.fps)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an', out]).catch((e) => { throw diskFull(e); });
}

/**
 * Cuts every scene and plans the whole video.
 * @returns {Promise<{ video, plans, stats, clips }>}
 */
export async function cutAll({ dirs, shotlist, scenes, onEvent = () => {} }) {
  requireFfmpeg();
  ensureDir(dirs.cut);
  const plans = [], clips = [];
  for (const sc of scenes) {
    const ev = readJson(join(dirs.raw, `scene-${sc.id}.json`));
    const plan = planScene(ev, sc, shotlist.cut);
    const out = join(dirs.cut, `scene-${sc.id}.mp4`);
    await cutScene(join(dirs.raw, ev.file), plan, shotlist.cut.zoom > 1, out);
    plans.push({ id: sc.id, caption: shotlist.cut.captions ? sc.caption : '', ...plan });
    clips.push(out);
    onEvent({ type: 'cut-scene', scene: sc.id, length: plan.length, removed: plan.removedSeconds, overrun: plan.overrun, trimmed: plan.trimmed, wanted: sc.duration });
  }
  const video = planVideo(plans, { endCard: shotlist.cut.endCard, endSeconds: END_CARD_SECONDS, fps: FRAME.fps });
  const stats = {
    waitsRemoved: plans.reduce((n, p) => n + p.waitsRemoved, 0), removedSeconds: round(plans.reduce((n, p) => n + p.removedSeconds, 0), 1),
    zooms: shotlist.cut.zoom > 1 ? plans.reduce((n, p) => n + p.clicks.length, 0) : 0, captions: video.scenes.filter((s) => s.caption).length,
    rawSeconds: round(scenes.reduce((n, sc) => n + (readJson(join(dirs.raw, `scene-${sc.id}.json`)).duration || 0), 0), 1),
    threshold: shotlist.cut.removeWaitsOver, endCard: !!video.endCard, total: video.total,
  };
  return { video, plans, stats, clips };
}

/**
 * Exports one file per target, the cover and captions.md into outDir.
 * @returns {Promise<Array<{ name, kind, target?, bytes, seconds? }>>}
 */
export async function exportAll({ dirs, outDir, shotlist, scenes, cut, onEvent = () => {} }) {
  requireFfmpeg();
  ensureDir(outDir);
  const slug = shotlist.app.slug, { video, clips, plans } = cut, files = [];
  for (const t of shotlist.targets) {
    if (video.total > PLATFORMS[t].maxSeconds + 0.05) throw E.invalidShotlist([`The video runs ${round(video.total, 1)} s. That is over the limit for ${PLATFORMS[t].name} (${PLATFORMS[t].maxSeconds} s). Shorten a scene or turn that target off.`]);
  }

  // Cover frame. Default: the first scene once the page has settled, before its first click (no zoom, no half-done
  // action, never the last frame). The shot list can name another moment: cover: { scene, at }.
  const coverScene = video.scenes.find((s) => s.id === (shotlist.cover && shotlist.cover.scene)) || video.scenes[0];
  const cp = plans.find((p) => p.id === coverScene.id);
  const coverAt = coverTime(shotlist.cover && shotlist.cover.at, cp, coverScene.length);
  const coverEv = readJson(join(dirs.raw, `scene-${coverScene.id}.json`)) || {};
  const coverFrame = join(dirs.cut, 'cover-frame.png');
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(round(Math.max(0, coverAt))), '-i', join(dirs.cut, `scene-${coverScene.id}.mp4`), '-frames:v', '1', coverFrame]);
  const coverOut = join(outDir, `${slug}-cover.png`);
  const headline = shotlist.cover && typeof shotlist.cover.headline === 'string' ? shotlist.cover.headline : (scenes.find((s) => s.id === coverScene.id) || {}).caption || '';
  const withClicks = scenes.map((s) => {
    const plan = plans.find((p) => p.id === s.id) || { clicks: [], length: s.duration };
    const ev = readJson(join(dirs.raw, `scene-${s.id}.json`)) || {};
    // The layout snapshots are in raw time; the cut removed waits, so they move to cut time like the clicks did.
    const layout = (ev.layout || []).map((l) => ({ ...l, t: toCut(l.t, plan.removed || []) }));
    return { ...s, place: { clicks: plan.clicks.flatMap((c) => clickRects(clickFocus(c), shotlist.cut.zoom)), layout, length: plan.length, zoom: shotlist.cut.zoom > 1 ? plan.zoom || [] : [] } };
  });
  const ov = await renderOverlays({ dir: dirs.cut, shotlist, scenes: withClicks, targets: shotlist.targets, coverFrame, coverOut, coverHeadline: headline, coverLayout: layoutAt(coverEv.layout || [], coverAt) });
  const moved = [], covered = [];
  const what = (by) => Object.entries(by || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `up to ${Math.round(v * 100)} % of it on ${KIND_NAMES[k] || k}`).join(', ');
  for (const t of Object.keys(ov.captions)) for (const [id, c] of Object.entries(ov.captions[t])) {
    if (c.band !== 'bottom') moved.push(`scene ${id} on ${PLATFORMS[t].name}: ${c.band}${c.covers.click ? ', still touches the click target' : ''}`);
    if (!c.free) covered.push(`scene ${id} on ${PLATFORMS[t].name}: no free spot, took the one that covers least (${[c.covers.click ? 'touches the click target' : '', what(c.covers.kinds)].filter(Boolean).join(', ') || 'a little of the page'})`);
  }
  onEvent({ type: 'placement', moved, covered, cover: { scene: coverScene.id, at: round(coverAt, 2), band: ov.coverBand || 'center', covers: what(ov.coverCovers) } });
  const outside = [];
  for (const t of Object.keys(ov.captions)) for (const [id, c] of Object.entries(ov.captions[t])) if (!c.inside) outside.push(`scene ${id} on ${PLATFORMS[t].name}`);
  onEvent({ type: 'captions', count: cut.stats.captions, outside });

  const list = join(dirs.cut, 'scenes.ffconcat');
  writeFileSync(list, 'ffconcat version 1.0\n' + clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const scenesLen = video.endCard ? video.endCard.start : video.total;

  for (const t of shotlist.targets) {
    const P = PLATFORMS[t], name = `${slug}-${P.suffix}.mp4`, out = join(outDir, name);
    const args = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
    const f = []; let last = '0:v', n = 1;
    for (const s of video.scenes) {
      const c = s.caption && ov.captions[t] && ov.captions[t][s.id];
      if (!c) continue;
      args.push('-i', c.file);
      f.push(`[${n}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[o${n}]`);
      f.push(`[${last}][o${n}]overlay=0:0:enable='between(t,${s.caption.from},${s.caption.to})'[v${n}]`);
      last = `v${n}`; n++;
    }
    if (video.endCard) {
      args.push('-loop', '1', '-framerate', String(FRAME.fps), '-t', String(video.endCard.length), '-i', ov.endCard);
      f.push(`[${last}]trim=end=${scenesLen},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[body]`);
      f.push(`[${n}:v]scale=${FRAME.width}:${FRAME.height}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setsar=1,fps=${FRAME.fps}[end]`);
      f.push(`[body][end]concat=n=2:v=1:a=0[out]`);
      n++;
    } else f.push(`[${last}]format=yuv420p,setsar=1[out]`);
    args.push('-f', 'lavfi', '-t', String(video.total), '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-filter_complex', f.join(';'), '-map', '[out]', '-map', `${n}:a`, ...ENCODE.video, ...ENCODE.audio, ...ENCODE.container,
      '-frames:v', String(Math.round(video.total * FRAME.fps)), '-t', String(video.total), out);
    await run('ffmpeg', args).catch((e) => { throw diskFull(e); });
    const file = { name, kind: 'video', target: t, bytes: statSync(out).size, seconds: round(video.total, 1) };
    files.push(file);
    onEvent({ type: 'export', ...file });
  }
  files.push({ name: `${slug}-cover.png`, kind: 'cover', bytes: statSync(coverOut).size, note: `1080×1920, frame from scene ${coverScene.id} at ${round(coverAt, 1)} s` });
  writeFileSync(join(outDir, 'captions.md'), captionsMd(shotlist, video));
  files.push({ name: 'captions.md', kind: 'texts', bytes: statSync(join(outDir, 'captions.md')).size, note: `${shotlist.targets.length} ${shotlist.targets.length === 1 ? 'text' : 'texts'}` });
  return files;
}

/**
 * The moment of the cover frame inside its (cut) scene, in seconds. Pure.
 * @param {undefined|'start'|'end'|number} at from cover.at
 * @param {{ clicks: Array<{t}> }} plan the scene's cut plan
 */
export function coverTime(at, plan, length) {
  const last = Math.max(0, length - 0.1);
  if (typeof at === 'number') return Math.min(last, Math.max(0, at));
  if (at === 'end') return last;
  const first = plan && plan.clicks && plan.clicks[0];
  // settled: a moment after the scene starts, and well before the cursor moves and the zoom begins
  return round(Math.max(0, Math.min(last, 0.5, first ? first.t - 0.9 : 0.5)));
}

/** captions.md: one post text per platform. The texts come from shotlist.posts (written by the model, edited by you). */
export function captionsMd(shotlist, video) {
  const posts = shotlist.posts || {}, L = [`# Post texts for ${shotlist.app.name}`, ''];
  const written = shotlist.targets.some((t) => posts[t] && Object.values(posts[t]).some((v) => v));
  L.push(written ? 'Drafts written from your README and the shot list. Read them before you post. Nothing was uploaded.' : 'No post texts were written for this run (it ran without the agent). The lines below are the scene captions as a starting point.', '');
  const fallback = shotlist.scenes.filter((s) => s.include !== false && s.caption).map((s) => s.caption).join(' ') + (shotlist.app.address ? `\n\n${shotlist.app.address}` : '');
  for (const t of shotlist.targets) {
    const P = PLATFORMS[t], post = posts[t] || {};
    L.push(`## ${P.name}`, '', `File: \`${shotlist.app.slug}-${P.suffix}.mp4\`${video ? ` · ${round(video.total, 1)} s` : ''}`, '');
    for (const [field, max] of Object.entries(P.post.fields)) {
      const v = post[field] || (field === 'title' ? shotlist.app.name : fallback);
      L.push(`### ${field[0].toUpperCase() + field.slice(1)} (${v.length} of ${max} characters)`, '', v, '');
    }
  }
  return L.join('\n');
}

/** Copies shotlist.json and run.log next to the videos. */
export function copyExtras({ shotlistFile, runLog, outDir }) {
  const files = [];
  if (existsSync(shotlistFile)) { copyFileSync(shotlistFile, join(outDir, 'shotlist.json')); files.push({ name: 'shotlist.json', kind: 'shotlist', bytes: statSync(join(outDir, 'shotlist.json')).size }); }
  if (existsSync(runLog)) { copyFileSync(runLog, join(outDir, 'run.log')); files.push({ name: 'run.log', kind: 'log', bytes: statSync(join(outDir, 'run.log')).size }); }
  return files;
}
export { rmSync };
