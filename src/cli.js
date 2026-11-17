// The deterministic tool surface. Every command here runs without a model.
// In Claude Code the agent calls these; you can call them yourself from a terminal.
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { paths, readJson, writeJson, ensureDir, VERSION, which, PLUGIN_ROOT, fmtSize } from './util.js';
import { E, PushreelError, formatError } from './errors.js';

const HELP = `Pushreel ${VERSION}: records your running web app in 9:16 and exports a Short, a Reel and a TikTok.

Usage: pushreel <command> [options]        (every command accepts --project <dir>, default: current directory)

The pipeline (fixed code, no model, 0 tokens)
  run [url] [--shotlist <file>]   start or find the app, record every scene, cut, export, stop the app again
  resume [--skip 3,4]             continue a paused run: records only the failed and remaining scenes
  cancel                          end a paused run, stop the app if Pushreel started it, keep scenes and shot list
  rerender                        cut and export again from the recorded footage (captions, lengths, scenes, targets)
  status [--json]                 what state the run is in and what to do next

Login for apps without a password form (OAuth, magic links, SSO): a saved browser session
  login [url]                     opens a visible browser window on your app; sign in by hand, then press Enter or close
                                  the window. The session is saved to .pushreel/auth.json and used by every later run.
  login --script <steps.json>     the same without a window, from login steps (for CI and tests; docs/LOGIN.md)
  logout                          removes the saved session

Tools the agent uses while exploring
  begin [url] [--session <id>] [--yes]     one call for the start of a run: doctor, cost tracking, model note, find the app
  detect-app [url] [--start] [--json]      find the running app; with --start, start it with the project's command
  stop-app                                 stop the app, only if Pushreel started it
  explore-shot <url> [<url> …] [--steps '<json>'] [--name scene-1] [--login] [--consent accept] [--json]
                                           open pages, save a still each, list what is on them; reports a consent dialog.
                                           Pages are opened as a visitor; --login opens them signed in (saved session)
  explore-shot --batch '[{"url":"/","name":"scene-1","steps":[…]},{"url":"/app","requiresLogin":true}, …]'
                                           several pages in one call, each with its own steps and its own session
  validate-shotlist [file]                 check a shot list and say exactly what is wrong
  set-shotlist <file>                      validate a shot list and save it as .pushreel/shotlist.json
  cost mark <step> [--session <id>]        note that a step begins (start, explore, shotlist); run marks the rest itself
  cost report [--session <id>] [--json]    tokens and estimated cost per step, USD and EUR

Review
  studio [--port 4317] [--no-open]         local review screen, bound to 127.0.0.1

Before a run (the agent calls these)
  model-check [--session <id>] [--model <id>] [--yes]   which model the session runs, the estimated cost of a run,
                                           and whether to ask "continue or switch?"
  model-remember [--session <id>] [--model <id>]        do not ask again for this model

Licence
  activate <key> [--name <label>]   activate this machine: one request to the licence provider, then offline.
                                    Sent: the key and a neutral label ("Pushreel on macOS · 3f9a"), never the hostname.
                                    --name replaces the label with your own text; that text is sent to Dodo Payments.
  licence                           show the licence state (offline)        licence check   ask the provider now
  deactivate [--force]              free this machine's place so the key can move to another machine

Setup
  doctor             check Node, ffmpeg, the browser, the licence
  setup              download the recording browser (Chromium, about 100 MB)
  config             show the user settings (~/.pushreel/config.json)       config reset    ask about the model again
`;

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opt[k] = v;
      else if (['json', 'yes', 'start', 'no-open', 'help', 'fresh', 'force', 'login'].includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) opt[k] = true;
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}
const out = (s = '') => process.stdout.write(s + '\n');
/** What explore-shot saw on each page: url, finalUrl and headings, from .pushreel/stills/*.json. */
function readStills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f))).filter(Boolean);
}
const ids = (v) => String(v || '').split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n));

export async function main(argv, { entry } = {}) {
  const { pos, opt } = parse(argv);
  if (entry) SELF = entry;
  const cmd = pos.shift();
  const dir = resolve(opt.project || process.cwd());
  try {
    const code = await dispatch(cmd, pos, opt, dir);
    process.exitCode = code || 0;
  } catch (e) {
    if (opt.json) out(JSON.stringify({ ok: false, error: e instanceof PushreelError ? e.toJSON() : { code: 'unexpected', title: String(e.message || e) } }, null, 2));
    else process.stderr.write('\n' + formatError(e) + '\n');
    process.exitCode = e instanceof PushreelError ? (e.code === 'no_licence' || e.code === 'licence_revoked' ? 3 : 1) : 70;
  }
}

/** The script the Studio starts for a run: this plugin's own bin, or the entry that started this process (the test harness passes its own). */
let SELF = join(PLUGIN_ROOT, 'bin', 'pushreel');

async function dispatch(cmd, pos, opt, dir) {
  const p = paths(dir);
  switch (cmd) {
    case undefined: case 'help': case '--help': out(HELP); return 0;
    case 'version': out(VERSION); return 0;

    case 'run': case 'record': case 'resume': case 'rerender': {
      const { pipeline } = await import('./pipeline.js');
      const mode = cmd === 'resume' ? 'resume' : cmd === 'rerender' ? 'rerender' : 'fresh';
      const { report, formatReport, mark, claimMarks } = await import('./cost.js');
      // Cost tracking: the marks of a Claude Code session count for this run only if that session started it.
      const tracked = claimMarks(dir, new Date().toISOString(), mode === 'fresh');
      // The pipeline step begins here, by fixed code: the agent's message that starts it belongs to the step before,
      // so this row is 0 tokens by construction.
      if (tracked) mark(dir, 'pipeline');
      const res = await pipeline(dir, { mode, skip: ids(opt.skip), url: pos[0], shotlistFile: opt.shotlist ? resolve(opt.shotlist) : undefined, say: out });
      if (res.status === 'paused') { process.stderr.write('\n' + formatError(res.error) + '\n'); return 2; }
      const marks = readJson(p.costMarks);
      if (tracked) mark(dir, 'summary'); // whatever the agent writes from here on is the summary
      const { pasteBlock, lastModelNote } = await import('./model.js');
      const lines = [`Files in ./${res.run.outDir}/`, ...res.run.files.filter((f) => f.kind === 'video' || f.kind === 'cover' || f.kind === 'texts').map((f) => `  ${f.name.padEnd(24)} ${f.seconds ? `${f.seconds} s  ` : ''}${fmtSize(f.bytes)}${f.kind === 'cover' ? '  cover image' : f.kind === 'texts' ? '  post texts (drafts)' : ''}`), '', formatReport(report(dir, opt.session))];
      // The estimate and the model note again, from fixed code: an agent in a non-interactive run often writes
      // nothing between its tool calls, so the note of `begin` may never have reached the chat. Here it stands
      // next to what the run really cost.
      const note = tracked && marks ? lastModelNote(dir) : null;
      if (note && note.session === marks.session) {
        if (note.usdLow != null) lines.push(`Estimate before the run: about $${note.usdLow.toFixed(2)} to $${note.usdHigh.toFixed(2)} on ${note.model.name}${note.measured ? ` (this session carries about ${Math.round(note.contextTokens / 1000)}k tokens of context per turn)` : ''}.`);
        if (note.note && (note.kind === 'pricier' || note.kind === 'haiku')) lines.push(`Model: ${note.note.replace(/ Switch with \/model, or continue\.$/, ' Switch with /model before the next run if you want the cheaper one.')}`);
      }
      out('');
      // In a Claude Code session the agent must show this to the user unchanged: tool output is not visible in the chat.
      out(tracked ? pasteBlock(lines).replace('word for word (not the markers)', 'word for word (not the markers), inside one code block') : lines.join('\n'));
      out(''); out(`Nothing was uploaded. Posting is up to you. Review: pushreel studio  →  http://localhost:4317/result`);
      return 0;
    }
    case 'cancel': {
      const { cancel } = await import('./pipeline.js');
      const r = await cancel(dir);
      if (!r.hadRun && !r.stopped.stopped) { out('Nothing to cancel: there is no run in this project and Pushreel has no app running.'); return 0; }
      out('Run cancelled.');
      out(r.stopped.stopped ? `● Stopped the app Pushreel started ("${r.stopped.command}", ${r.stopped.url}). The port is free again.` : '● Pushreel had not started your app, so nothing was stopped.');
      out(`● Kept: ${r.kept.length ? `recorded scene${r.kept.length > 1 ? 's' : ''} ${r.kept.join(', ')}` : 'no recorded scenes'}${r.shotlist ? ' and .pushreel/shotlist.json' : ''}.`);
      out('Start again any time: pushreel rerender (reuses the recorded scenes) or pushreel run (records everything again).');
      return 0;
    }
    case 'status': {
      const { describe, readRun } = await import('./pipeline.js');
      const { appInfo } = await import('./detect.js');
      const lic = (await import('./license.js')).status();
      if (opt.json) out(JSON.stringify({ run: readRun(dir), app: appInfo(dir), shotlist: existsSync(p.shotlist), licence: lic }, null, 2));
      else { out(describe(dir)); out(''); out(licenceLine(lic)); }
      return 0;
    }

    case 'detect-app': {
      const { detectApp, startApp } = await import('./detect.js');
      let d = await detectApp(dir, pos[0]);
      if (!d.running && opt.start && !d.explicit) { const s = await startApp(dir, { command: d.command, ports: d.ports, assetPorts: d.assetPorts, log: opt.json ? () => {} : out }); d = { ...d, running: true, ...s, justStarted: true }; }
      if (opt.json) out(JSON.stringify(d, null, 2));
      else if (d.running) out(d.justStarted ? `App is up at ${d.url}. Pushreel started it with "${d.command}" and stops it at the end of the run.` : `App is running at ${d.url}${d.startedByPushreel ? ' (started by Pushreel)' : `${d.remembered ? ' (the address you passed earlier)' : ''}. Pushreel uses it and leaves it running`}.`);
      else out(d.explicit ? `Nothing answers at ${d.url}.` : `No app is running${d.ports.length ? ` on port ${d.ports.join(', ')}` : ''}. ${d.command ? `Start command found: "${d.command}". Run: pushreel detect-app --start` : 'No start command found. Start the app yourself and pass its address: pushreel run http://localhost:3000'}`);
      return d.running ? 0 : 4;
    }
    case 'stop-app': {
      const r = await (await import('./detect.js')).stopApp(dir);
      out(r.stopped ? `Stopped the app Pushreel started (${r.url}).` : 'Pushreel has not started an app in this project. Nothing was stopped.');
      return 0;
    }
    case 'begin': {
      // One call instead of five: doctor, cost marks, the model note and the app. Fewer agent turns, fewer tokens.
      const session = typeof opt.session === 'string' ? opt.session : process.env.CLAUDE_CODE_SESSION_ID;
      const code = await dispatch('doctor', [], { brief: true }, dir);
      if (code) { out(''); out('Stop here: fix the line marked ✗ above, then run /pushreel again.'); return code; }
      const c = await import('./cost.js');
      c.mark(dir, 'start', session); c.mark(dir, 'explore');
      const { checkModel } = await import('./model.js');
      const note = await checkModel(dir, { sessionId: session, modelId: typeof opt.model === 'string' ? opt.model : undefined, yes: !!opt.yes });
      const { detectApp, startApp } = await import('./detect.js');
      let d = await detectApp(dir, pos[0]), appLine;
      try {
        if (!d.running && !d.explicit) { const s = await startApp(dir, { command: d.command, ports: d.ports, assetPorts: d.assetPorts, log: () => {} }); d = { ...d, running: true, ...s, justStarted: true }; }
        appLine = d.running ? (d.justStarted ? `App: up at ${d.url}. Pushreel started it with "${d.command}" and stops it at the end of the run.` : `App: running at ${d.url}. Pushreel uses it and leaves it running.`) : `App: nothing answers at ${d.url}. Ask the user to start the app or to pass its address, and stop.`;
      } catch (e) { if (!(e instanceof PushreelError)) throw e; appLine = `App: ${e.title}. ${e.text}`; d = { running: false }; }
      const { readSaved } = await import('./session.js');
      const auth = readSaved(p.auth);
      out(appLine);
      out(`Login: ${auth ? `a saved session is on file (pushreel login${auth.savedAt ? `, ${auth.savedAt.slice(0, 10)}` : ''}); pages behind the login open signed in` : process.env.PUSHREEL_LOGIN ? 'PUSHREEL_LOGIN is set (password form)' : 'none. Pages behind a login cannot be shown until the user runs /pushreel login (any login, also OAuth) or sets PUSHREEL_LOGIN (password form)'}.`);
      out(note.text);
      if (d.running && session) out('Next: Pushreel shows the note above to the user by itself (a hook). explore-shot refuses to run until the user has seen it; if it answers "Not yet", write the note as the visible text of your reply and repeat the call.');
      return d.running ? 0 : 4;
    }
    case 'login': {
      const { detectApp } = await import('./detect.js');
      const { loginInteractive, loginScript, savedMessage } = await import('./login.js');
      let base = null, start = '/';
      if (pos[0] && /^https?:\/\//.test(pos[0])) { const u = new URL(pos[0]); base = u.origin; start = u.pathname + u.search; }
      else {
        // No address given: use the running app, or start it. It is left running: a login in a stopped app may be gone.
        const app = await (await import('./detect.js')).ensureApp(dir, { log: out });
        base = app.url; if (pos[0]) start = pos[0];
        if (!app.already) out(`Pushreel started your app for the login (${app.url}) and leaves it running. The next run uses it and stops it at the end; "pushreel stop-app" stops it now.`);
      }
      if (pos[0] && /^https?:\/\//.test(pos[0])) { ensureDir(p.state); writeJson(p.addressJson, { url: base, at: new Date().toISOString() }); }
      const r = typeof opt.script === 'string'
        ? await loginScript(dir, { baseUrl: base, url: start !== '/' ? start : undefined, scriptFile: resolve(opt.script) })  // the script's own start address wins over a bare origin
        : await loginInteractive(dir, { baseUrl: base, url: start, say: out, input: process.stdin, timeoutMs: opt.timeout ? Number(opt.timeout) * 1000 : undefined });
      if (r.why === 'timeout') out('The window was open for a long time, so Pushreel saved what was there and closed it.');
      out(savedMessage(dir, r.saved, { how: r.why === 'script' ? 'script' : 'hand' }));
      return 0;
    }
    case 'logout': {
      const gone = (await import('./login.js')).logout(dir);
      out(gone.length ? `Removed the saved session (${gone.map((g) => '.pushreel/' + g).join(', ')}). Scenes behind the login need "pushreel login" again. The app itself was not signed out: its session stays valid until it expires.` : 'There was no saved session in this project.');
      return 0;
    }
    case 'explore-shot': {
      if (!pos[0] && !opt.batch) throw new PushreelError('usage', { title: 'explore-shot needs an address', text: 'Usage: pushreel explore-shot /today --name scene-1 --steps \'[{"do":"click","selector":"#save"}]\'', next: [] });
      // The model note must be in the chat before exploring spends tokens (src/notegate.js).
      const gate = await (await import('./notegate.js')).checkNoteGate(dir);
      if (!gate.ok) { out((await import('./notegate.js')).gateMessage(gate.block)); return 6; }
      const { detectApp } = await import('./detect.js');
      const { exploreShots } = await import('./explore.js');
      let shots;
      if (opt.batch) {
        try { shots = JSON.parse(opt.batch); } catch { throw E.invalidShotlist(['--batch is not valid JSON. It must be a list like [{"url":"/","name":"scene-1"},{"url":"/today","name":"scene-2","steps":[{"do":"click","selector":"#save"}]}].']); }
        if (!Array.isArray(shots) || !shots.length || shots.some((s) => !s || typeof s.url !== 'string')) throw E.invalidShotlist(['--batch must be a list of objects with "url" (and optional "name", "steps", "requiresLogin").']);
        if (shots.length > 8) throw E.invalidShotlist([`--batch has ${shots.length} pages. Look at 8 at most in one call.`]);
      }
      let base = opt.base;
      const firstUrl = shots ? shots[0].url : pos[0];
      if (!base && /^https?:\/\//.test(firstUrl)) base = new URL(firstUrl).origin;
      if (!base) { const d = await detectApp(dir); if (!d.running) throw E.appNotRunning(d.command, d.ports); base = d.url; }
      let steps = [];
      if (opt.steps) { try { steps = JSON.parse(opt.steps); } catch { throw E.invalidShotlist(['--steps is not valid JSON. It must be a list like [{"do":"click","selector":"#save"}].']); } }
      const sl = readJson(p.shotlist);
      if (!shots) shots = pos.map((url, i) => ({ url, steps: pos.length === 1 ? steps : [], name: pos.length === 1 ? opt.name : opt.name ? `${opt.name}-${i + 1}` : undefined, requiresLogin: !!opt.login }));
      const reps = await exploreShots(dir, { baseUrl: base, shots, login: sl && sl.login, consent: opt.consent === 'accept' ? 'accept' : 'reject', viewportWidth: opt.viewport ? Number(opt.viewport) : (sl && sl.viewport && sl.viewport.width) || 360 });
      for (const rep of reps) rep.still = './' + relative(dir, rep.still);
      out(JSON.stringify(reps.length === 1 ? reps[0] : reps, null, opt.json ? 2 : 1));
      return reps.every((r) => r.ok) ? 0 : 1;
    }
    case 'validate-shotlist': case 'set-shotlist': {
      const { validate, normalize, totalSeconds, headlineWarnings } = await import('./shotlist.js');
      const file = pos[0] ? resolve(pos[0]) : p.shotlist;
      if (!existsSync(file)) throw E.noShotlist(file);
      const raw = readJson(file);
      const res = raw === null ? { errors: [`${file} is not valid JSON.`], warnings: [] } : validate(raw);
      // Captions that repeat the page's own headings, from what exploring saw (.pushreel/stills/*.json).
      if (!res.errors.length) res.warnings.push(...headlineWarnings(normalize(raw), readStills(p.stills)));
      if (opt.json) out(JSON.stringify({ ok: !res.errors.length, ...res }, null, 2));
      else {
        for (const w of res.warnings) out(`! ${w}`);
        for (const w of res.info || []) out(`· ${w}`);
        if (res.errors.length) throw E.invalidShotlist(res.errors);
        const s = normalize(raw), inc = s.scenes.filter((x) => x.include);
        // Exploring found a consent dialog and the shot list does nothing about it: it would be in the video.
        const consent = readJson(p.consent);
        if (consent && consent.prepare && !s.prepare) out(`! Exploring found a consent dialog ("${consent.button}"), and this shot list has no "prepare". Add  "prepare": ${JSON.stringify(consent.prepare)}  so the dialog is dismissed before the recording and never shows in the video.`);
        out(`✓ Shot list is valid: ${inc.length} of ${s.scenes.length} scenes, ${totalSeconds(s)} s with the end card, targets ${s.targets.join(', ')}.`);
        out(res.warnings.length ? 'Lines marked ! ask for a change. Lines marked · need none.' : `Nothing to change${res.info && res.info.length ? ' (lines marked · are information only)' : ''}. Go on.`);
      }
      if (cmd === 'set-shotlist' && !res.errors.length && file !== p.shotlist) { ensureDir(p.state); copyFileSync(file, p.shotlist); out(`Saved as ./${relative(dir, p.shotlist)}`); }
      return res.errors.length ? 1 : 0;
    }

    case 'note': { // called by hooks/hooks.json after `pushreel begin`; prints a hook answer or nothing, never fails
      if (pos[0] !== 'hook') throw new PushreelError('usage', { title: 'Unknown command: note ' + (pos[0] || ''), text: 'Only "pushreel note hook" exists; Claude Code calls it.', next: [] });
      let input = ''; try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
      const r = (await import('./notegate.js')).noteHook(input);
      if (r) out(JSON.stringify(r));
      return 0;
    }
    case 'cost': {
      const c = await import('./cost.js');
      if (pos[0] === 'hook') { // called by hooks/hooks.json; never prints, never fails
        let input = ''; try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
        await c.hook(input); return 0;
      }
      if (pos[0] === 'mark') {
        const step = c.STEP_ALIAS[pos[1]] || pos[1];
        if (step !== 'start' && !c.STEPS[step]) throw new PushreelError('usage', { title: `Unknown step "${step}"`, text: `Known steps: start, ${Object.keys(c.STEPS).join(', ')}.`, next: [] });
        c.mark(dir, step, opt.session);
        out(step === 'start' ? 'Cost tracking started.' : `Marked: ${c.STEPS[step]}`);
        return 0;
      }
      const rep = c.report(dir, opt.session);
      out(opt.json ? JSON.stringify(rep, null, 2) : c.formatReport(rep));
      return 0;
    }

    case 'studio': {
      const { startStudio } = await import('./studio/server.js');
      const s = await startStudio(dir, { port: opt.port ? Number(opt.port) : 4317, entry: SELF });
      out(`Studio is running at ${s.url}  (only on this machine). Press Ctrl+C to stop it.`);
      if (!opt['no-open'] && process.stdout.isTTY) spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [s.url], { stdio: 'ignore' });
      return new Promise(() => {});
    }

    case 'activate': {
      const lic = await import('./license.js');
      const r = await lic.activate(pos[0], { provider: opt.provider, name: typeof opt.name === 'string' ? opt.name : undefined, onRequest: (prov, ctx) => out(`Checking the key with ${prov.label || prov.name}. Sent, once: ${prov.sends(ctx)}. Nothing else.`) });
      if (!r.ok) throw new PushreelError('activation_failed', { title: TITLES[r.code] || 'The licence key was not accepted', text: r.reason, next: NEXT[r.code] || ['pushreel activate <your-licence-key>'] });
      if (r.already) { out(`✓ This machine is already activated with this key (${lic.maskKey(r.record.key)}). Nothing was sent and no second place was used.`); return 0; }
      out(`✓ Pushreel is activated on this machine (${lic.maskKey(r.record.key)}).`);
      if (r.record.devOnly) out('  TEST ONLY: this activation came from a test provider or a test endpoint. It only counts inside the test harness.');
      out(`  This machine's label at ${r.provider.label || r.provider.name}: "${r.record.machineName}". "pushreel licence" shows it again, so you can tell your machines apart.`);
      out(`  Stored in ${lic.licenceFile()}: the key, the activation id, the label and the date.`);
      out(`  ${lic.offlineNote(r.provider)}`);
      out('  One key is meant for up to 3 machines. Moving to another machine: run "pushreel deactivate" here, then activate there.');
      return 0;
    }
    case 'deactivate': {
      const r = await (await import('./license.js')).deactivate({ force: !!opt.force });
      if (!r.ok) throw new PushreelError('deactivation_failed', { title: 'The licence was not removed', text: `${r.reason} The licence stays on this machine, so nothing is lost.`, next: ['Go online and run: pushreel deactivate', 'pushreel deactivate --force   (removes it from this machine only; the place stays used until hello@pushreel.dev frees it)'] });
      if (!r.was) out('There was no licence on this machine.');
      else if (!r.hasRemote) out('Licence removed from this machine.');
      else if (r.freed) out(`Licence removed from this machine (${r.key}). ${r.already ? 'The provider had no activation for this machine any more.' : `${r.provider} freed its place: you can activate the key on another machine now.`}`);
      else out(`Licence removed from this machine only (${r.key}). ${r.provider} could not be reached, so the place is still counted as used. Write to hello@pushreel.dev if you run into the limit.`);
      return 0;
    }
    case 'licence': case 'license': {
      const lic = await import('./license.js');
      let checked = null;
      if (pos[0] === 'check') checked = await lic.revalidate({ force: true });
      else if (pos[0] && pos[0] !== 'status') throw new PushreelError('usage', { title: `Unknown licence command "${pos[0]}"`, text: 'Use: pushreel licence, pushreel licence status, pushreel licence check', next: [] });
      const s = lic.status();
      if (opt.json) { out(JSON.stringify({ ...s, checked })); return s.valid ? 0 : 3; }
      if (checked) out(checked.checked ? (checked.valid ? '✓ The provider confirms: the key is valid and this machine is activated.' : '✗ The provider says this licence is no longer valid for this machine.') : `No answer from the provider (${checked.skipped}). The stored state is unchanged.`);
      out(licenceLine(s));
      if (s.valid || s.revoked) {
        out(`  Provider: ${await providerLine(s.provider)}`);
        out(`  Activated ${s.activatedAt.slice(0, 10)}${s.machineName ? ` as "${s.machineName}"` : ''}; last confirmed by the provider ${s.lastValidatedAt.slice(0, 10)}.`);
        if (s.machineName) out('  That label is the name of this machine in the list of activations (up to 3 machines per key).');
        const prov = await lic.loadProvider(s.provider).catch(() => null);
        if (s.valid && prov) out(`  ${lic.offlineNote(prov)}`);
        out(`  File: ${lic.licenceFile()}`);
      }
      if (!s.valid) out(s.revoked ? '  Ask again: pushreel licence check    New key: pushreel activate <your-licence-key>' : '  Activate with: pushreel activate <your-licence-key>');
      return s.valid ? 0 : 3;
    }
    case 'model-check': {
      const { checkModel } = await import('./model.js');
      const note = await checkModel(dir, { sessionId: typeof opt.session === 'string' ? opt.session : undefined, modelId: typeof opt.model === 'string' ? opt.model : undefined, yes: !!opt.yes });
      out(opt.json ? JSON.stringify(note, null, 2) : note.text);
      return 0;
    }
    case 'model-remember': {
      const { sessionModel, lastModelNote } = await import('./model.js');
      const { priceFor, loadPrices } = await import('./cost.js');
      const { rememberModel, userConfigFile } = await import('./userconfig.js');
      const last = lastModelNote(dir);
      const raw = (typeof opt.model === 'string' && opt.model) || sessionModel(typeof opt.session === 'string' ? opt.session : undefined) || (last && last.model && last.model.id);
      if (!raw) throw new PushreelError('usage', { title: 'Which model?', text: 'Pushreel could not read the model of this session. Pass it: pushreel model-remember --model claude-opus-5-5', next: [] });
      const price = priceFor(loadPrices(), raw), id = price ? price.id : raw;
      rememberModel(id);
      out(`Saved: Pushreel will not ask again for ${price ? price.name : id}. It still prints the cost note.`);
      out(`Stored in ${userConfigFile()}. Undo with: pushreel config reset`);
      return 0;
    }
    case 'config': {
      const uc = await import('./userconfig.js');
      const { priceFor, loadPrices } = await import('./cost.js');
      const prices = loadPrices(), nameOf = (id) => { const p = priceFor(prices, id); return p ? `${p.name} (${id})` : id; };
      if (pos[0] === 'reset') {
        const had = uc.resetModelChoices();
        out(had.length ? `Reset. Pushreel asks again before a run on: ${had.map(nameOf).join(', ')}.` : 'Nothing to reset: no model choice was saved.');
        return 0;
      }
      if (pos[0]) throw new PushreelError('usage', { title: `Unknown config command "${pos[0]}"`, text: 'Use: pushreel config, pushreel config reset', next: [] });
      const list = uc.dontAskModels(), rec = prices.models[prices.recommended].name;
      if (opt.json) { out(JSON.stringify({ file: uc.userConfigFile(), config: uc.readUserConfig() }, null, 2)); return 0; }
      out(`User settings: ${uc.userConfigFile()}`);
      out(`Recommended model: ${rec}. Before a run on a more expensive model, or on Haiku, Pushreel shows the cost and asks "continue or switch?".`);
      out(list.length ? `Not asked again for: ${list.map(nameOf).join(', ')}.   Ask again: pushreel config reset` : 'Model question: asked every time (no "don\'t ask again" saved).');
      out(`Licence provider: ${await providerLine()}`);
      return 0;
    }
    case 'setup': {
      const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { stdio: 'inherit' });
      if (r.status !== 0) { out('The browser download failed. If node_modules is missing, run "npm install" in ' + PLUGIN_ROOT + ' first.'); return 1; }
      return 0;
    }
    case 'doctor': {
      const rows = [];
      const major = Number(process.versions.node.split('.')[0]);
      rows.push([major >= 20, `Node.js ${process.versions.node}`, 'Pushreel needs Node.js 20 or newer.']);
      const ff = which('ffmpeg'), fp = which('ffprobe');
      rows.push([!!(ff && fp), ff && fp ? `ffmpeg at ${ff}` : 'ffmpeg not found', 'Install: brew install ffmpeg (macOS), sudo apt install ffmpeg (Debian, Ubuntu), winget install ffmpeg (Windows).']);
      let browser = false, why = 'Run: pushreel setup';
      try { const { chromium } = await import('playwright'); browser = existsSync(chromium.executablePath()); } catch { why = `Run "npm install" in ${PLUGIN_ROOT}, then: pushreel setup`; }
      rows.push([browser, browser ? 'Recording browser (Chromium) installed' : 'Recording browser missing', why]);
      const lic = (await import('./license.js')).status();
      rows.push([lic.valid, lic.valid ? licenceLine(lic).replace('Licence: active', 'Licence active') : `Licence: ${lic.reason}`, lic.revoked ? 'Run: pushreel licence check   or activate a new key: pushreel activate <your-licence-key>' : 'Run: pushreel activate <your-licence-key>']);
      const clash = commandClash(dir);
      rows.push([true, clash ? `Command: another command named /pushreel exists (${clash}). It wins, so use /pushreel:pushreel for this plugin.` : 'Command in Claude Code: /pushreel', '']);
      if (opt.brief && rows.every((r) => r[0])) out(`✓ Pushreel ${VERSION} is ready (Node, ffmpeg, recording browser, licence).`);
      else for (const [ok, label, fix] of rows) out(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    ${fix}`}`);
      return rows.every((r) => r[0]) ? 0 : 1;
    }
    default:
      throw new PushreelError('usage', { title: `Unknown command "${cmd}"`, text: 'Run "pushreel help" for the list of commands.', next: ['pushreel help'] });
  }
}

const TITLES = { network: 'The licence provider could not be reached', limit: 'No free place on this licence key', inactive: 'This licence key is not active any more', invalid_key: 'This licence key is not known', wrong_product: 'This key is for another product', not_configured: 'This build has no product to check keys against', other_key: 'This machine already has a licence' };
const NEXT = { limit: ['pushreel deactivate   (on one of the other machines; in Claude Code: /pushreel deactivate)', 'pushreel activate <your-licence-key>   (here, afterwards)'], network: ['pushreel activate <your-licence-key>   (again, when you are online)'], other_key: ['pushreel licence', 'pushreel deactivate'], not_configured: ['See docs/LICENSING.md, "Set up Dodo Payments"'] };

function licenceLine(s) {
  if (s.valid) return `Licence: active (${s.key}${s.devOnly ? ', TEST ONLY activation' : ''}${s.mode === 'test' ? ', Dodo test mode' : ''})`;
  if (s.revoked) return `Licence: not valid any more (${s.key}): ${s.reason}.`;
  return `Licence: ${s.reason}. Run: pushreel activate <your-licence-key>`;
}
async function providerLine(name) {
  const lic = await import('./license.js');
  try { const p = await lic.loadProvider(name); return p.describe ? p.describe() : p.label || p.name; } catch { return `${name || lic.configuredProvider()} (not available in this build)`; }
}
/** A user or project command that takes the short name /pushreel away from the plugin. */
function commandClash(dir) {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const spots = [join(home, 'skills', 'pushreel', 'SKILL.md'), join(home, 'commands', 'pushreel.md'), join(dir, '.claude', 'skills', 'pushreel', 'SKILL.md'), join(dir, '.claude', 'commands', 'pushreel.md')];
  return spots.find((f) => existsSync(f)) || null;
}
export { fmtSize, writeJson, readFileSync, writeFileSync };
