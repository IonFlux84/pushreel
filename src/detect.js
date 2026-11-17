// Finds the user's running app, or starts it with the project's own command and stops it again later.
import { existsSync, openSync, readFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { paths, readJson, writeJson, readEnvFiles, ensureDir, isAlive, sleep } from './util.js';
import { rmSync } from 'node:fs';
import { E } from './errors.js';

const FRAMEWORK_PORTS = [
  ['vite', 5173], ['@sveltejs/kit', 5173], ['astro', 4321], ['next', 3000], ['nuxt', 3000], ['@remix-run/dev', 5173],
  ['react-scripts', 3000], ['@angular/cli', 4200], ['@vue/cli-service', 8080], ['gatsby', 8000], ['parcel', 1234],
  ['@11ty/eleventy', 8080], ['express', 3000], ['fastify', 3000], ['@nestjs/core', 3000], ['hono', 3000],
];

const COMMON_PORTS = [5173, 3000, 8080, 8000, 4321, 4200];

/** Ports named in a script line: --port 3000, -p 3000, PORT=3000, :3000 */
export function portsInScript(script) {
  const out = [];
  const re = /(?:--port[= ]|-p[= ]|\bPORT=|--listen[= ](?:tcp:\/\/)?(?:[\w.]+)?:?|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d{2,5})\b/g;
  let m; while ((m = re.exec(script || ''))) out.push(Number(m[1]));
  return out;
}

/**
 * Reads the project and says where the app probably listens and how to start it.
 * Pure apart from reading files. @returns {{ ports: number[], command: string|null, why: string[] }}
 */
export function inspectProject(dir) {
  const ports = [], why = [], assetPorts = [];
  // A server-rendered project (Laravel, Django, Rails) with Vite: the Vite port serves only scripts and
  // styles. The app is what the backend serves, so the Vite port is never probed or taken for the app.
  const backend = existsSync(join(dir, 'artisan')) || existsSync(join(dir, 'manage.py')) || existsSync(join(dir, 'bin', 'rails'));
  const asset = (p, reason) => { if (Number.isInteger(p) && !assetPorts.includes(p)) { assetPorts.push(p); why.push(`${p}: ${reason}, serves assets only, not the app`); } };
  const add = (p, reason) => { if (Number.isInteger(p) && p > 0 && p < 65536 && !ports.includes(p)) { ports.push(p); why.push(`${p}: ${reason}`); } };
  let command = null;
  const env = readEnvFiles(dir);
  for (const k of ['PORT', 'VITE_PORT', 'APP_PORT', 'SERVER_PORT']) if (env[k]) add(Number(env[k]), `${k} in .env`);
  for (const k of ['APP_URL', 'BASE_URL', 'NEXT_PUBLIC_APP_URL', 'VITE_APP_URL']) {
    const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(env[k] || ''); if (m) add(Number(m[1]), `${k} in .env`);
  }
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg) {
    const scripts = pkg.scripts || {};
    const name = ['dev', 'start', 'serve', 'develop'].find((n) => scripts[n]);
    if (name) {
      const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock')) ? 'bun' : 'npm';
      command = name === 'start' && pm !== 'bun' ? `${pm} start` : `${pm} run ${name}`;
      for (const p of portsInScript(scripts[name])) add(p, `"${name}" script in package.json`);
      // a plain Node entry file: look for `process.env.PORT || 5173` or `.listen(5173`
      const entry = /\b(?:node|tsx|ts-node|nodemon|bun)\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?js|ts))/.exec(scripts[name]);
      if (entry && existsSync(join(dir, entry[1]))) {
        const src = readFileSync(join(dir, entry[1]), 'utf8');
        const re = /(?:PORT\s*(?:\|\||\?\?)\s*['"]?|\.listen\(\s*)(\d{2,5})/g; let m;
        while ((m = re.exec(src))) add(Number(m[1]), `port in ${entry[1]}`);
      }
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [dep, port] of FRAMEWORK_PORTS) if (deps[dep]) (backend && dep === 'vite' ? asset : add)(port, `default port of ${dep}`);
    for (const f of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
      if (!existsSync(join(dir, f))) continue;
      const m = /port\s*:\s*(\d{2,5})/.exec(readFileSync(join(dir, f), 'utf8')); if (m) (backend ? asset : add)(Number(m[1]), `server.port in ${f}`);
    }
  }
  if (existsSync(join(dir, 'artisan'))) { command = command && pkg && (pkg.scripts || {}).dev && existsSync(join(dir, 'composer.json')) && /"dev"\s*:/.test(readFileSync(join(dir, 'composer.json'), 'utf8')) ? 'composer run dev' : command || 'php artisan serve'; add(8000, 'default port of php artisan serve'); }
  if (existsSync(join(dir, 'manage.py'))) { command = command || 'python manage.py runserver'; add(8000, 'default port of Django runserver'); }
  if (existsSync(join(dir, 'bin', 'rails')) || existsSync(join(dir, 'config.ru'))) { command = command || 'bin/rails server'; add(3000, 'default port of Rails'); }
  return { ports: ports.filter((p) => !assetPorts.includes(p) || !backend), command, why, assetPorts };
}

/** One GET. Resolves with the status code, or null when nothing answers. Any HTTP answer counts as "running". */
export function probe(url, timeout = 1500) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch { return res(null); }
    const req = (u.protocol === 'https:' ? https : http).get(u, { timeout, rejectUnauthorized: false, headers: { accept: 'text/html,*/*' } }, (r) => { r.resume(); res(r.statusCode); });
    req.on('timeout', () => { req.destroy(); res(null); });
    req.on('error', () => res(null));
  });
}
async function probePort(port) {
  for (const host of ['localhost', '127.0.0.1']) { if (await probe(`http://${host}:${port}/`)) return `http://${host}:${port}`; }
  return null;
}

export const appInfo = (dir) => readJson(paths(dir).appJson);
/** The address the user passed to an earlier command (detect-app <url>, run <url>), or null. */
export const rememberedAddress = (dir) => { const a = readJson(paths(dir).addressJson); return a && /^https?:\/\//.test(a.url || '') ? a.url : null; };

/**
 * Finds the running app. Order: explicit address, the app Pushreel started earlier, ports found in the project.
 * @returns {Promise<{ running: boolean, url?: string, startedByPushreel?: boolean, command: string|null, ports: number[], why: string[] }>}
 */
export async function detectApp(dir, explicitUrl) {
  const info = inspectProject(dir);
  if (explicitUrl) {
    const url = explicitUrl.replace(/\/+$/, '');
    const running = !!(await probe(url + '/'));
    // Remember the address the user passed: explore-shot, the Studio and resume use it without being told again.
    if (running) { ensureDir(paths(dir).state); writeJson(paths(dir).addressJson, { url, at: new Date().toISOString() }); }
    return { running, url, startedByPushreel: false, explicit: true, ...info };
  }
  const mine = appInfo(dir);
  if (mine && isAlive(mine.pid) && (await probe(mine.url + '/'))) return { running: true, url: mine.url, startedByPushreel: true, pid: mine.pid, ...info, command: mine.command };
  const given = rememberedAddress(dir);
  if (given && (await probe(given + '/'))) return { running: true, url: given, startedByPushreel: false, remembered: true, ...info };
  for (const port of info.ports) { const url = await probePort(port); if (url) return { running: true, url, startedByPushreel: false, ...info }; }
  return { running: false, ...info };
}

/**
 * Starts the app with the project's own command, in its own process group, and waits until it answers.
 * The process outlives this CLI call on purpose: a paused run keeps the app up until resume or cancel.
 */
export async function startApp(dir, { command, ports, assetPorts = [], timeoutMs = 60000, log = () => {} } = {}) {
  const p = paths(dir);
  if (!command) throw E.appNotStarted(null);
  ensureDir(p.state);
  // Ports that answered before the start belong to something else and are never taken for this app.
  const foreign = new Set(assetPorts);
  // Laravel: Vite writes public/hot while it runs. If the start command leaves it behind after a kill,
  // every page would ask a dead Vite server for its scripts. Remember whether it was there before.
  const hotFile = join(dir, 'public', 'hot');
  const hotBefore = existsSync(hotFile);
  for (const port of [...ports, ...COMMON_PORTS]) if (await probePort(port)) foreign.add(port);
  const fd = openSync(p.appLog, 'w');
  const child = spawn(command, { cwd: dir, shell: true, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' } });
  closeSync(fd);
  child.unref();
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 1; });
  log(`No app running on ${ports.length ? 'port ' + ports.slice(0, 3).join(', ') : 'a known port'}. Starting it with "${command}"`);
  const t0 = Date.now();
  let url = null;
  while (Date.now() - t0 < timeoutMs && exited === null) {
    await sleep(350);
    const printed = [];
    try { const re = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g; let m; const txt = readFileSync(p.appLog, 'utf8'); while ((m = re.exec(txt))) printed.push(Number(m[1])); } catch { /* log not there yet */ }
    for (const port of [...new Set([...printed, ...ports, ...COMMON_PORTS])]) { if (foreign.has(port)) continue; url = await probePort(port); if (url) break; }
    if (url) break;
  }
  if (!url) {
    killGroup(child.pid);
    if (!hotBefore) { await sleep(600); await removeStaleHot(hotFile); }
    let tail = ''; try { tail = readFileSync(p.appLog, 'utf8').trim().split('\n').slice(-12).join('\n'); } catch { /* nothing */ }
    throw E.appNotStarted(command, tail);
  }
  writeJson(p.appJson, { pid: child.pid, url, command, startedAt: new Date().toISOString(), ...(hotBefore ? {} : { hotFile }) });
  // The port answers before the app is whole: a dev server may still be building its scripts and styles.
  // Wait until the first page loads and every script and stylesheet it names answers.
  const ready = await firstPageReady(url, { timeoutMs: Math.max(3000, Math.min(20000, timeoutMs - (Date.now() - t0))), alive: () => exited === null });
  if (!ready.ok) log(`The app answers at ${url}, but ${ready.failed.length ? `${ready.failed.length} of its scripts or styles do not load yet (${ready.failed.slice(0, 2).join(', ')})` : 'its first page does not load yet'}. Going on; if the recording shows an unstyled page, start the app yourself.`);
  return { url, pid: child.pid, command, startedByPushreel: true, assetsReady: ready.ok };
}

/**
 * The scripts and stylesheets a page names, as absolute addresses on this machine or on the page's own host. Pure.
 * Assets from other hosts (a CDN) are left out: they do not depend on the app having started.
 */
export function assetUrls(html, base) {
  const out = new Set(), origin = new URL(base).origin;
  const add = (v) => { try { const u = new URL(v.replace(/&amp;/g, '&'), base); if (/^https?:$/.test(u.protocol) && (u.origin === origin || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) out.add(u.href); } catch { /* not an address */ } };
  let m;
  const scripts = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = scripts.exec(html))) add(m[1]);
  const links = /<link\b[^>]*>/gi;
  while ((m = links.exec(html))) { const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(m[0]), href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]); if (rel && href && /stylesheet|modulepreload/i.test(rel[1])) add(href[1]); }
  return [...out].slice(0, 16);
}

/** Waits until the first page answers below 500 and all its local scripts and styles answer below 400. */
export async function firstPageReady(url, { timeoutMs = 15000, alive = () => true, fetchFn = fetch } = {}) {
  const t0 = Date.now();
  let failed = [];
  for (;;) {
    try {
      const res = await fetchFn(url + '/', { redirect: 'follow', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(4000) });
      if (res.status < 500) {
        const assets = /html/i.test(res.headers.get('content-type') || '') ? assetUrls(await res.text(), res.url || url + '/') : [];
        const codes = await Promise.all(assets.map((a) => fetchFn(a, { signal: AbortSignal.timeout(4000) }).then((r) => { if (r.body && r.body.cancel) r.body.cancel().catch(() => {}); return r.status; }, () => 0)));
        failed = assets.filter((_, i) => !codes[i] || codes[i] >= 400);
        if (!failed.length) return { ok: true, failed: [] };
      } else failed = [];
    } catch { failed = []; }
    if (Date.now() - t0 > timeoutMs || !alive()) return { ok: false, failed };
    await sleep(400);
  }
}

function killGroup(pid, signal = 'SIGTERM') {
  try { process.kill(-pid, signal); return true; } catch { try { process.kill(pid, signal); return true; } catch { return false; } }
}

/** Removes a Vite "hot" file that the app Pushreel started left behind, only if the server it names is gone. */
export async function removeStaleHot(file) {
  if (!file || !existsSync(file)) return false;
  let url = ''; try { url = readFileSync(file, 'utf8').trim(); } catch { return false; }
  if (!/^https?:\/\//.test(url)) return false;
  for (let i = 0; i < 6; i++) { if (!(await probe(url + '/', 500))) { rmSync(file, { force: true }); return true; } await sleep(250); }
  return false;
}

/** Stops the app if, and only if, Pushreel started it. @returns {Promise<{ stopped: boolean, url?: string }>} */
export async function stopApp(dir) {
  const p = paths(dir), mine = readJson(p.appJson);
  if (!mine) return { stopped: false };
  if (isAlive(mine.pid)) {
    killGroup(mine.pid, 'SIGTERM');
    for (let i = 0; i < 20 && isAlive(mine.pid); i++) await sleep(150);
    if (isAlive(mine.pid)) { killGroup(mine.pid, 'SIGKILL'); await sleep(200); }
  }
  await removeStaleHot(mine.hotFile);
  rmSync(p.appJson, { force: true });
  return { stopped: true, url: mine.url, command: mine.command };
}

/** Uses the running app or starts it. */
export async function ensureApp(dir, { url, log } = {}) {
  const d = await detectApp(dir, url);
  if (d.running) return { url: d.url, startedByPushreel: !!d.startedByPushreel, command: d.command, already: true };
  if (d.explicit) throw new (await import('./errors.js')).PushreelError('app_not_reachable', {
    title: `Nothing answers at ${d.url}`, text: 'You passed this address, and no app responds there. Start your app, check the port, then run the command again.',
    next: [`pushreel run ${d.url}`],
  });
  const started = await startApp(dir, { command: d.command, ports: d.ports, assetPorts: d.assetPorts, log });
  return { ...started, already: false };
}
