// Small shared helpers: paths inside the user's project, JSON files, child processes.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;

/** All paths Pushreel uses inside one project. State lives in .pushreel/, results in pushreel-out/. */
export function paths(projectDir) {
  const root = resolve(projectDir);
  const state = join(root, '.pushreel');
  const run = join(state, 'run');
  return {
    root, state, run,
    shotlist: join(state, 'shotlist.json'),
    runJson: join(state, 'run.json'),
    appJson: join(state, 'app.json'),
    appLog: join(state, 'app.log'),
    addressJson: join(state, 'address.json'),
    costMarks: join(state, 'cost-marks.json'),
    costJson: join(state, 'cost.json'),
    modelJson: join(state, 'model.json'),
    auth: join(state, 'auth.json'),
    session: join(state, 'session.json'),
    exploreSession: join(state, 'explore-session.json'),
    consent: join(state, 'consent.json'),
    choice: join(state, 'choice.json'),
    stills: join(state, 'stills'),
    raw: join(run, 'raw'),
    cut: join(run, 'cut'),
    failed: join(run, 'failed'),
    runLog: join(run, 'run.log'),
    events: join(run, 'events.jsonl'),
    outRoot: join(root, 'pushreel-out'),
  };
}

/** User-level folder for the licence file. PUSHREEL_HOME overrides it (used by tests). */
export const userHome = () => process.env.PUSHREEL_HOME || join(homedir(), '.pushreel');

/**
 * Creates a folder. The project's .pushreel/ and the user's ~/.pushreel/ (and PUSHREEL_HOME) are kept private:
 * mode 0700, also when they already existed with a wider mode. Best effort: on Windows chmod changes little.
 */
export const ensureDir = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); privateDirs(d); return d; };
function privateDirs(d) {
  const abs = resolve(d), parts = abs.split(sep), targets = [];
  const home = resolve(userHome());
  if (abs === home || abs.startsWith(home + sep)) targets.push(home);
  const i = parts.lastIndexOf('.pushreel');
  if (i > 0) targets.push(parts.slice(0, i + 1).join(sep) || sep);
  for (const t of targets) { try { if ((statSync(t).mode & 0o777) !== 0o700) chmodSync(t, 0o700); } catch { /* best effort */ } }
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
/**
 * Atomic write, so a reader (the Studio) never sees half a file. `{ secret: true }` writes the file with mode 0600
 * (saved logins, sessions, the licence, the user config); an existing file with a wider mode is narrowed, because
 * the temporary file replaces it.
 */
export function writeJson(file, data, { secret = false } = {}) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', secret ? { mode: 0o600 } : undefined);
  if (secret) { try { chmodSync(tmp, 0o600); } catch { /* best effort */ } }
  renameSync(tmp, file);
  if (secret) { try { chmodSync(file, 0o600); } catch { /* best effort */ } }
}
export const appendLine = (file, line) => { ensureDir(dirname(file)); appendFileSync(file, line + '\n'); };

export function slugify(s) {
  return String(s || 'app').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'app';
}
export const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const clock = () => new Date().toTimeString().slice(0, 8);
export const fmtSize = (bytes) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
export const fmtDur = (s) => { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };

/** A pid Pushreel may look at or signal: a whole number above 1 that is not this process. Pure. */
export const validPid = (pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid;

/**
 * True when a process with this pid runs and belongs to this user. EPERM (someone else's process, e.g. pid 1)
 * counts as not alive: Pushreel never signals it. Invalid pids (0, 1, negative, not a whole number) are never alive.
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * The start time of a process as the system reports it, or null. Pushreel stores it next to every pid it saves
 * (.pushreel/app.json, .pushreel/run.json) and signals a pid only when it still matches: a pid from a planted or
 * stale file, or a pid the system gave to another process since, is never signalled.
 * macOS and Linux: `ps -o lstart= -p <pid>`. Windows: PowerShell's Get-Process StartTime.
 */
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const r = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    const v = r.status === 0 ? String(r.stdout || '').trim().replace(/\s+/g, ' ') : '';
    return v || null;
  } catch { return null; }
}

/** True when `rec.pid` is a valid, living process of this user that started at `rec.pidStart`. */
export function ownsProcess(rec) {
  if (!rec || !validPid(rec.pid) || typeof rec.pidStart !== 'string' || !rec.pidStart) return false;
  if (!isAlive(rec.pid)) return false;
  return processStart(rec.pid) === rec.pidStart;
}

/**
 * Sends a signal to a process Pushreel started, and only to that. `group: true` signals its process group
 * (the dev server and its children; the pid leads the group because Pushreel spawned it detached).
 * Never signals pid 0, 1, a negative pid, this process, or a process whose start time differs from the record.
 * @returns {boolean} whether a signal was sent
 */
export function signalOwned(rec, signal = 'SIGTERM', { group = false } = {}) {
  if (!ownsProcess(rec)) return false;
  try {
    if (group && process.platform !== 'win32') process.kill(-rec.pid, signal);
    else process.kill(rec.pid, signal);
    return true;
  } catch { return false; }
}

/** True when `target` (after resolving symbolic links as far as it exists) lies inside `root`. */
export function insideDir(root, target) {
  const real = (p) => {
    let cur = resolve(p), rest = [];
    for (;;) {
      try { return join(realpathSync(cur), ...rest); } catch { /* not there yet */ }
      const up = dirname(cur); if (up === cur) return resolve(p);
      rest.unshift(cur.slice(up.length).replace(/^[\\/]+/, '')); cur = up;
    }
  };
  const r = real(root), t = real(target);
  return t === r || t.startsWith(r + sep);
}

/** Reads KEY=value lines from .env files. Later files win. Does not expand variables. */
export function readEnvFiles(projectDir, names = ['.env', '.env.development', '.env.local']) {
  const out = {};
  for (const n of names) {
    const f = join(projectDir, n);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      out[m[1]] = v;
    }
  }
  return out;
}

/** Runs a binary and collects output. Rejects with the last stderr lines on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', rej);
    p.on('close', (code) => {
      if (code === 0) return res({ out, err });
      const e = new Error(`${cmd} exited with code ${code}\n${err.split('\n').slice(-12).join('\n')}`);
      e.exitCode = code; e.stderr = err; rej(e);
    });
  });
}
export function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}
