// The Studio: a local review screen on 127.0.0.1:4317. A tiny JSON API plus server-sent events.
// It never listens on a public interface and it loads nothing from the network.
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { paths, readJson, writeJson, PLUGIN_ROOT, VERSION, isAlive, ensureDir, readEnvFiles } from '../util.js';
import { validate, normalize, sceneHash, totalSeconds } from '../shotlist.js';
import { PLATFORMS, PLATFORM_KEYS, FRAME, END_CARD_SECONDS, LAST_CHECKED } from '../presets.js';
import { status as licenceStatus } from '../license.js';
import { appInfo, probe, inspectProject } from '../detect.js';
import { cancel, readRun } from '../pipeline.js';
import { loadPrices, priceFor } from '../cost.js';
import { estimates, lastModelNote } from '../model.js';
import { dontAskModels, rememberModel } from '../userconfig.js';
import { captionsMd } from '../cut.js';

const PUBLIC = join(PLUGIN_ROOT, 'src', 'studio', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.log': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'studio.html', '/studio': 'studio.html', '/result': 'result.html', '/recovery': 'recovery.html' };

export async function buildState(dir) {
  const p = paths(dir), raw = readJson(p.shotlist), run = readRun(dir), app = appInfo(dir);
  const state = { version: VERSION, project: { name: basename(dir), dir }, frame: FRAME, endCardSeconds: END_CARD_SECONDS, platforms: PLATFORMS, platformKeys: PLATFORM_KEYS, presetsChecked: LAST_CHECKED };
  state.licence = licenceStatus();
  state.shotlist = null; state.errors = []; state.warnings = []; state.stills = {}; state.recorded = {};
  if (raw) {
    const v = validate(raw); state.errors = v.errors; state.warnings = v.warnings;
    const s = normalize(raw); state.shotlist = s;
    for (const sc of s.scenes) {
      const still = join(p.stills, `scene-${sc.id}.png`);
      if (existsSync(still)) state.stills[sc.id] = { src: `/media/stills/scene-${sc.id}.png?v=${Math.round(statSync(still).mtimeMs)}`, clicks: (readJson(join(p.stills, `scene-${sc.id}.json`)) || {}).clicks || [] };
      const ev = readJson(join(p.raw, `scene-${sc.id}.json`));
      state.recorded[sc.id] = !!(ev && ev.hash === sceneHash(s, sc) && existsSync(join(p.raw, ev.file)));
      if (ev && state.recorded[sc.id]) state.recorded[sc.id] = { clicks: ev.clicks.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })), rawSeconds: ev.duration, layout: (ev.layout || []).map((l) => ({ headings: l.headings, bars: l.bars })) };
    }
    state.total = totalSeconds(s, (run && run.status !== 'done' && run.skip) || []);
  }
  if (run) { run.alive = !!(run.pid && isAlive(run.pid)); if (!run.alive && ['recording', 'cutting', 'exporting'].includes(run.status)) run.status = 'interrupted'; }
  state.run = run;
  const info = inspectProject(dir);
  state.app = app ? { url: app.url, startedByPushreel: true, command: app.command, running: isAlive(app.pid) } : { url: (run && run.baseUrl) || (info.ports[0] ? `http://localhost:${info.ports[0]}` : null), startedByPushreel: false, command: info.command, running: null };
  if (!app && state.app.url) state.app.running = !!(await probe(state.app.url + '/', 600));
  // The cost of a run belongs to the session that made it. A report written before the current run started
  // (an earlier, unrelated run) is not shown next to it.
  const cost = readJson(p.costJson);
  state.cost = cost && run && run.startedAt && cost.at && Date.parse(cost.at) < Date.parse(run.startedAt) ? null : cost;
  const prices = loadPrices(), lastNote = lastModelNote(dir), ctx = lastNote && lastNote.context && lastNote.context.contextTokens ? { contextTokens: lastNote.context.contextTokens, messages: 0, usage: null } : null;
  state.prices = { lastChecked: prices.lastChecked, usdToEur: prices.usdToEur.rate, recommended: prices.models[prices.recommended].name, estimates: estimates(prices, ctx), contextTokens: ctx ? ctx.contextTokens : null };
  // The model note of the last /pushreel run in this project (written by `pushreel model-check`), and the
  // models the user chose not to be asked about again.
  const note = lastModelNote(dir), quiet = dontAskModels();
  state.model = note && note.model ? { id: note.model.id, name: note.model.name, kind: note.kind, usd: note.usd, recUsd: note.recUsd, ratio: note.ratio, note: note.note || '', headline: note.headline || '', at: note.at, dontAsk: quiet.includes(note.model.id) } : null;
  state.loginSet = !!(process.env.PUSHREEL_LOGIN || readEnvFiles(dir).PUSHREEL_LOGIN) || existsSync(p.auth);
  state.outDir = run && run.outDir ? `./${run.outDir}/` : null;
  state.files = run && run.status === 'done' ? run.files.map((f) => ({ ...f, src: `/media/out/${f.name}?v=${encodeURIComponent(run.finishedAt || '')}` })) : [];
  return state;
}

function send(res, code, body, type = 'application/json', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(data);
}
/** Serves a file from `root` only; supports byte ranges so videos can be scrubbed. */
function sendFile(req, res, root, name) {
  const file = resolve(root, name);
  if (!(file === resolve(root) || file.startsWith(resolve(root) + sep)) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  const size = statSync(file).size, type = TYPES[extname(file)] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}
const readBody = (req) => new Promise((ok, bad) => {
  let b = ''; req.on('data', (d) => { b += d; if (b.length > 2e6) { bad(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('The request body is not valid JSON.')); } });
});

export async function startStudio(dir, { port = 4317, entry = join(PLUGIN_ROOT, 'bin', 'pushreel') } = {}) {
  const p = paths(dir);
  let child = null, lastOutput = [];
  const clients = new Set();
  const push = async () => { if (!clients.size) return; const data = `event: state\ndata: ${JSON.stringify(await buildState(dir))}\n\n`; for (const c of clients) c.write(data); };
  let lastSig = '';
  const timer = setInterval(() => {
    let sig = '';
    for (const f of [p.runJson, p.shotlist, p.appJson, p.costJson]) { try { sig += statSync(f).mtimeMs + ';'; } catch { sig += '-;'; } }
    sig += child ? 'c' : '';
    if (sig !== lastSig) { lastSig = sig; push(); }
  }, 350);
  timer.unref();

  const startRun = (mode, skip) => {
    const args = [join(PLUGIN_ROOT, 'src', 'cli.js'), mode, '--project', dir];
    if (skip && skip.length) args.push('--skip', skip.join(','));
    lastOutput = [];
    child = spawn(process.execPath, [entry, ...args.slice(1)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const keep = (d) => { lastOutput.push(...String(d).split('\n').filter(Boolean)); lastOutput = lastOutput.slice(-80); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('exit', () => { child = null; push(); });
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine may talk to the Studio: refuse foreign Host headers (DNS rebinding) and cross-site writes.
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'The Studio only answers on localhost.' });
      const url = new URL(req.url, 'http://localhost'), path = decodeURIComponent(url.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) return send(res, 403, { error: 'Cross-site requests are refused.' });
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' });
      }
      if (req.method === 'GET' && PAGES[path]) return sendFile(req, res, PUBLIC, PAGES[path]);
      if (req.method === 'GET' && path === '/api/state') return send(res, 200, await buildState(dir));
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(await buildState(dir))}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && path === '/api/log') return send(res, 200, { lines: existsSync(p.runLog) ? readFileSync(p.runLog, 'utf8').trim().split('\n').slice(-60) : [], output: lastOutput });
      if (req.method === 'PUT' && path === '/api/shotlist') {
        const body = await readBody(req), v = validate(body);
        if (v.errors.length) return send(res, 422, { ok: false, errors: v.errors, warnings: v.warnings });
        ensureDir(p.state); writeJson(p.shotlist, body);
        // keep captions.md in the finished folder in step with edited post texts
        const run = readRun(dir);
        if (run && run.status === 'done' && run.outDir && existsSync(join(dir, run.outDir))) {
          const s = normalize(body);
          writeFileSync(join(dir, run.outDir, 'captions.md'), captionsMd(s, run.video || null));
          writeJson(join(dir, run.outDir, 'shotlist.json'), body);
        }
        return send(res, 200, { ok: true, warnings: v.warnings, state: await buildState(dir) });
      }
      if (req.method === 'POST' && path === '/api/run') {
        const body = await readBody(req), run = readRun(dir);
        if (child || (run && run.pid && isAlive(run.pid))) return send(res, 409, { ok: false, error: 'A run is already working.' });
        const mode = ['run', 'resume', 'rerender'].includes(body.mode) ? body.mode : 'run';
        startRun(mode, Array.isArray(body.skip) ? body.skip.filter(Number.isInteger) : []);
        return send(res, 202, { ok: true, mode });
      }
      if (req.method === 'POST' && path === '/api/model/remember') {
        const body = await readBody(req), price = priceFor(loadPrices(), typeof body.id === 'string' ? body.id : '');
        if (!price) return send(res, 422, { ok: false, error: 'Unknown model.' });
        rememberModel(price.id);
        return send(res, 200, { ok: true, state: await buildState(dir) });
      }
      if (req.method === 'POST' && path === '/api/stop') {
        const run = readRun(dir);
        if (child) child.kill('SIGTERM'); else if (run && run.pid && isAlive(run.pid)) process.kill(run.pid, 'SIGTERM');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/cancel') {
        if (child) child.kill('SIGTERM');
        const r = await cancel(dir);
        return send(res, 200, { ok: true, ...r, state: await buildState(dir) });
      }
      if (req.method === 'GET' && path.startsWith('/media/stills/')) return sendFile(req, res, p.stills, path.slice('/media/stills/'.length));
      if (req.method === 'GET' && path.startsWith('/media/failed/')) return sendFile(req, res, p.failed, path.slice('/media/failed/'.length));
      if (req.method === 'GET' && path.startsWith('/media/out/')) { const run = readRun(dir); if (!run || !run.outDir) return send(res, 404, { error: 'no output yet' }); return sendFile(req, res, join(dir, run.outDir), path.slice('/media/out/'.length)); }
      if (req.method === 'GET') return sendFile(req, res, PUBLIC, path.replace(/^\/+/, ''));
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { ok: false, error: String(e.message || e) }); }
  });
  await new Promise((ok, bad) => {
    server.once('error', (e) => bad(e.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${port} is in use. The Studio may already be open at http://localhost:${port}, or pass another port: pushreel studio --port 4318`), { code: 'EADDRINUSE' }) : e));
    server.listen(port, '127.0.0.1', ok);
  });
  const close = () => { clearInterval(timer); for (const c of clients) c.end(); if (child) child.kill('SIGTERM'); server.close(); };
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => { close(); process.exit(0); });
  return { url: `http://localhost:${port}`, port, close };
}
