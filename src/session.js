// The saved browser session. Two files in .pushreel/:
//   auth.json     written by `pushreel login`: the storage state of a browser in which the user signed in
//   session.json  the state recordings start from, one per lane: "user" (scenes with requiresLogin) is auth.json
//                 plus what `prepare` did; "guest" (all other scenes) is a visitor's browser plus `prepare`.
//                 Updated after each recorded scene so cookies and storage carry on to the next one in its lane.
// Both contain session cookies and must never be committed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './util.js';

export const KIND_AUTH = 'pushreel-auth', KIND_SESSION = 'pushreel-session';

const isState = (s) => !!s && typeof s === 'object' && Array.isArray(s.cookies) && Array.isArray(s.origins);
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** Wraps a Playwright storage state for saving. */
export function wrapState(storageState, { kind = KIND_AUTH, baseUrl = null, how = null, key = null, now = new Date() } = {}) {
  if (!isState(storageState)) throw new Error('Not a browser storage state.');
  return { kind, version: 1, savedAt: now.toISOString(), origin: originOf(baseUrl), ...(how ? { how } : {}), ...(key ? { key } : {}), storageState };
}

/** Reads auth.json. Returns null for a missing, broken or foreign file. A bare Playwright state is accepted too. */
export function readSaved(file) {
  const raw = readJson(file);
  if (!raw) return null;
  if (isState(raw)) return { kind: KIND_AUTH, version: 1, savedAt: null, origin: null, storageState: raw };
  if (raw.kind !== KIND_AUTH || raw.version !== 1 || !isState(raw.storageState)) return null;
  return raw;
}

/** Facts about a saved state for messages: how many cookies, for which hosts, and whether every dated cookie has run out. */
export function describeState(saved, now = Date.now()) {
  const cookies = saved.storageState.cookies, dated = cookies.filter((c) => typeof c.expires === 'number' && c.expires > 0);
  const live = dated.filter((c) => c.expires * 1000 > now);
  return {
    cookies: cookies.length, hosts: [...new Set(cookies.map((c) => String(c.domain || '').replace(/^\./, '')))].filter(Boolean),
    storageOrigins: saved.storageState.origins.length,
    allExpired: cookies.length > 0 && dated.length === cookies.length && live.length === 0,
    nextExpiry: live.length ? new Date(Math.min(...live.map((c) => c.expires)) * 1000).toISOString() : null,
  };
}

/** True when the saved state was made on another address than the one that is recorded now (localhost ≠ 127.0.0.1 for cookies). */
export function otherOrigin(saved, baseUrl) {
  const now = originOf(baseUrl);
  return !!(saved && saved.origin && now && saved.origin !== now);
}

/** Identifies what a session.json was built from. Changes when `prepare`, the login file or the address change. */
export function sessionKey({ prepare = null, authSavedAt = null, baseUrl = '' } = {}) {
  return createHash('sha256').update(JSON.stringify({ prepare, authSavedAt, origin: originOf(baseUrl) })).digest('hex').slice(0, 16);
}

export const LANES = ['guest', 'user'];
/**
 * Which browser session a scene is recorded in. Pure.
 * 'user':  scenes with "requiresLogin": they start from the saved login.
 * 'guest': every other scene: a visitor who is not signed in (a landing page sends a signed-in user away).
 */
export const laneOf = (scene) => (scene && scene.requiresLogin ? 'user' : 'guest');

/**
 * Reads session.json: one saved state per lane, built from the same inputs (key), otherwise null for that lane
 * (prepare has to run again). @returns {{ guest: null|{storageState}, user: null|{storageState, signedIn} }}
 */
export function usableSession(file, key) {
  const raw = readJson(file), out = { guest: null, user: null };
  if (!raw || raw.kind !== KIND_SESSION || raw.version !== 1 || raw.key !== key || !raw.lanes) return out;
  for (const lane of LANES) { const l = raw.lanes[lane]; if (l && isState(l.storageState)) out[lane] = { storageState: l.storageState, signedIn: !!l.signedIn }; }
  return out;
}

/** Saves the state of one lane and keeps the other. */
export function saveSession(file, lane, storageState, { baseUrl, key, signedIn = false, now = new Date() }) {
  if (!LANES.includes(lane) || !isState(storageState)) throw new Error('Not a browser storage state.');
  const old = readJson(file), lanes = old && old.kind === KIND_SESSION && old.key === key && old.lanes ? old.lanes : {};
  writeJson(file, { kind: KIND_SESSION, version: 1, savedAt: now.toISOString(), origin: originOf(baseUrl), key, lanes: { ...lanes, [lane]: { storageState, signedIn: !!signedIn, savedAt: now.toISOString() } } });
}

/** Removes the saved login and everything built on it. @returns {string[]} names of the removed files */
export function removeSaved(p) {
  const gone = [];
  for (const [name, f] of [['auth.json', p.auth], ['session.json', p.session], ['explore-session.json', p.exploreSession]]) if (existsSync(f)) { rmSync(f, { force: true }); gone.push(name); }
  return gone;
}

/**
 * Normalizes `prepare` from the shot list: a list of steps, or { url, steps }. Returns null when there is nothing to do.
 * Prepare runs before the recording and is never in the video.
 */
export function parsePrepare(raw) {
  if (raw === undefined || raw === null) return null;
  const p = Array.isArray(raw) ? { url: '/', steps: raw } : { url: '/', ...raw };
  if (!Array.isArray(p.steps) || !p.steps.length) return null;
  return { url: typeof p.url === 'string' && p.url ? p.url : '/', steps: p.steps };
}

/** Reads a login script: a list of steps, or { url, steps }. Throws with a plain message when the file is not one. */
export function parseLoginScript(raw) {
  const s = Array.isArray(raw) ? { url: '/', steps: raw } : raw;
  if (!s || typeof s !== 'object' || !Array.isArray(s.steps) || !s.steps.length) throw new Error('A login script is a JSON list of steps, or {"url": "/login", "steps": [ … ]}, with the same steps as a scene.');
  return { url: typeof s.url === 'string' && s.url ? s.url : '/', steps: s.steps, expect: typeof s.expect === 'string' ? s.expect : null };
}

/**
 * What to tell the user about .gitignore. Returns null when .pushreel/ is already ignored (in .gitignore or .git/info/exclude).
 */
export function gitignoreAdvice(projectDir) {
  const lines = [];
  for (const f of [join(projectDir, '.gitignore'), join(projectDir, '.git', 'info', 'exclude')]) { try { lines.push(...readFileSync(f, 'utf8').split(/\r?\n/)); } catch { /* not there */ } }
  const ignored = lines.map((l) => l.trim()).some((l) => /^\/?\.pushreel(\/\*{0,2})?\/?$/.test(l));
  if (ignored) return null;
  return existsSync(join(projectDir, '.git'))
    ? 'Add this line to .gitignore before you commit:  .pushreel/'
    : 'If this folder becomes a Git repository, add this line to .gitignore:  .pushreel/';
}
