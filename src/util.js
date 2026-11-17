// Small shared helpers: paths inside the user's project, JSON files, child processes.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export const ensureDir = (d) => { mkdirSync(d, { recursive: true }); return d; };
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
/** Atomic write, so a reader (the Studio) never sees half a file. */
export function writeJson(file, data) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
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

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
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
