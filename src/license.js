// Licence handling. One check at activation, then offline.
//
// Network requests Pushreel makes on its own, all of them to the licence provider and nowhere else:
//   1. activate: once, when the user runs `pushreel activate <key>`.
//   2. deactivate: once, when the user runs `pushreel deactivate`.
//   3. re-check: at most once every 30 days, only when a recording command runs and the provider answers.
//      (User-facing sentence: offlineNote() below.)
//      If the machine is offline or the provider is down, the run goes on. It never blocks. Only a clear
//      "this key is no longer valid" answer (refund, disabled key) stops recording.
// No telemetry, no update check, nothing else.
//
// A provider is an object (see src/providers/dodo.js):
//   name, label?, devOnly?
//   normalizeKey?(key)            how the typed key is cleaned (default: trim)
//   sends?(ctx)                   one phrase: what activate transmits
//   activate(key, { machine, machineName, custom })   machineName is the label that is sent; custom = given with --name
//        → { ok: true, instanceId?, extra?, devOnly? } | { ok: false, code, reason }   reason is shown as written
//   validate?(record, { timeoutMs })  → { ok: true, valid, code? } | { ok: false, code }
//   deactivate?(record)           → { ok: true, already? } | { ok: false, code, reason }
//   revalidateDays?()             → days between re-checks, 0 = never

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readJson, writeJson, userHome, PLUGIN_ROOT } from './util.js';
import { E, PushreelError } from './errors.js';

const DAY = 86400e3;
export const licenceFile = () => join(userHome(), 'license.json');

// Test support. The shipped files contain no caller of enableTestSupport() and no provider besides Dodo:
// no environment variable, option or config value switches this on. The test harness (in the test folder,
// which is not shipped) calls it in its own process to add a test provider and to allow a local mock of Dodo.
// scripts/check-release.sh fails if anything in the shipped file set reaches it.
let testSupport = null;
/** TESTS ONLY. `providers` is { name: provider }; `false` switches test support off again. */
export function enableTestSupport(providers = {}) { testSupport = providers ? { providers } : null; }
export const testSupportOn = () => !!testSupport;

/** A stable, non-reversible id of this machine and user. Stays on this machine; it is never sent. */
export function machineId() {
  let user = 'user';
  try { user = userInfo().username; } catch { /* no user database */ }
  return createHash('sha256').update(`pushreel:${hostname()}:${user}`).digest('hex').slice(0, 24);
}
const OS = { darwin: 'macOS', win32: 'Windows' }; // every other platform Node runs on is reported as Linux
export const osName = (platform = process.platform) => OS[platform] || 'Linux';
const TAG = /^[0-9a-f]{4}$/;
/**
 * The label the provider stores for this activation. Neutral on purpose: the operating system and four
 * random hex characters, so the buyer can tell machines apart. Never the hostname or the user name: both
 * can contain a person's name.
 */
export const machineLabel = (tag, platform) => `Pushreel on ${osName(platform)} · ${tag}`;
/** The four characters: made once, kept with the licence record, reused when this machine activates again. */
function machineTag() {
  const prev = readJson(licenceFile());
  return prev && prev.machine === machineId() && TAG.test(prev.machineTag || '') ? prev.machineTag : randomBytes(2).toString('hex');
}

/** The sentence about the re-check, the same wherever it is shown. */
export function offlineNote(provider) {
  const days = provider && provider.validate ? (provider.revalidateDays ? provider.revalidateDays() : 30) : 0;
  if (!(days > 0)) return 'Works offline. Pushreel does not contact the licence provider again.';
  return `Works offline. At most once every ${days} days, when you are online and start a recording, Pushreel re-checks the key with ${provider.label || provider.name}. Offline never blocks.`;
}

const seal = (r) => createHmac('sha256', r.machine)
  .update([r.key, r.provider, r.activatedAt, r.instanceId || '', r.devOnly ? 'dev' : '', r.mode || '', r.lastValidatedAt || '', r.lastAttemptAt || '', r.revoked ? `${r.revoked.at}:${r.revoked.code}` : ''].join('|'))
  .digest('hex').slice(0, 32);
const save = (r) => { r.seal = seal(r); writeJson(licenceFile(), r); return r; };
export const maskKey = (k) => { const s = String(k); return s.length > 10 ? `${s.slice(0, 4)}····${s.slice(-4)}` : '····'; };

/** The providers of a shipped build: a fixed list, no dynamic path. */
const PROVIDERS = { dodo: () => import('./providers/dodo.js') };
export function configuredProvider() {
  const cfg = readJson(join(PLUGIN_ROOT, 'config', 'license.json'), {});
  return (testSupport && process.env.PUSHREEL_LICENSE_PROVIDER) || cfg.provider || 'dodo';
}
export async function loadProvider(name) {
  const n = name || configuredProvider();
  if (testSupport && Object.hasOwn(testSupport.providers, n)) return testSupport.providers[n];
  if (!Object.hasOwn(PROVIDERS, n)) throw new PushreelError('unknown_provider', { title: `Unknown licence provider "${String(n).slice(0, 40)}"`, text: 'This build checks licence keys with Dodo Payments and with nothing else. Activate with the key from your purchase email.', next: ['pushreel activate <your-licence-key>'] });
  return (await PROVIDERS[n]()).default;
}

const WHY = {
  revoked: 'the key is no longer valid (refunded, disabled or expired)',
  instance_removed: 'the activation of this machine was removed',
};

/** Reads and judges the stored activation. Makes no network request. */
function read() {
  const r = readJson(licenceFile());
  if (!r) return { record: null, valid: false, reason: 'not activated' };
  if (r.machine !== machineId()) return { record: r, valid: false, reason: 'activated on another machine or user account' };
  if (r.seal !== seal(r)) return { record: r, valid: false, reason: 'the licence file was changed' };
  if (r.devOnly && !testSupport) return { record: r, valid: false, reason: 'it is a test activation, which only counts inside the test harness' };
  if (r.revoked) return { record: r, valid: false, intact: true, revoked: r.revoked.code, reason: WHY[r.revoked.code] || WHY.revoked };
  return { record: r, valid: true, intact: true };
}

/** Offline check of the stored activation. */
export function status() {
  const { record: r, valid, reason, revoked } = read();
  if (!r) return { valid: false, reason };
  const base = { key: maskKey(r.key), provider: r.provider, devOnly: !!r.devOnly, mode: r.mode || null, activatedAt: r.activatedAt, lastValidatedAt: r.lastValidatedAt || r.activatedAt, machineName: r.machineName || null, machineTag: r.machineTag || null, instanceId: r.instanceId || null };
  return valid ? { valid: true, ...base } : { valid: false, reason, revoked: revoked || null, ...base };
}

/**
 * One request to the provider, then the result is stored locally.
 * Running it again with the same key on an activated machine does nothing (and uses no second place).
 */
export async function activate(key, o = {}) {
  const provider = await loadProvider(o.provider);
  const k = provider.normalizeKey ? provider.normalizeKey(key) : String(key || '').trim();
  if (!k) return { ok: false, code: 'no_key', reason: 'No key given. Usage: pushreel activate <your-licence-key>' };
  const cur = read();
  if (cur.valid && cur.record.provider === provider.name) {
    if (cur.record.key === k) return { ok: true, record: cur.record, already: true, provider };
    return { ok: false, code: 'other_key', reason: `This machine is already activated with another key (${maskKey(cur.record.key)}). Run "pushreel deactivate" first if you want to switch keys.` };
  }
  const custom = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : null; // --name: the user's own text, sent as written
  const tag = machineTag();
  const ctx = { machine: machineId(), machineName: custom || machineLabel(tag), custom: !!custom };
  const no = provider.notReady ? provider.notReady() : null;
  if (no) return no;
  if (o.onRequest && provider.sends) o.onRequest(provider, ctx);
  const res = await provider.activate(k, ctx);
  if (!res.ok) return res;
  const now = new Date().toISOString();
  const record = save({ key: k, provider: provider.name, devOnly: !!(provider.devOnly || res.devOnly), instanceId: res.instanceId || '', machineName: ctx.machineName, machineTag: tag, ...(res.extra || {}), activatedAt: now, lastValidatedAt: now, machine: ctx.machine });
  return { ok: true, record, provider, sent: provider.sends ? provider.sends(ctx) : null };
}

/**
 * The re-check. Called before recording; also by `pushreel licence check` with force.
 * Never throws and never blocks on a network problem.
 * @returns {{ checked: boolean, valid?: boolean, code?: string, skipped?: string }}
 */
export async function revalidate({ force = false, now = Date.now() } = {}) {
  const cur = read();
  if (!cur.record || !cur.intact) return { checked: false, skipped: 'no usable activation' };
  const r = cur.record;
  if (r.revoked && !force) return { checked: false, skipped: 'already marked invalid' };
  let provider; try { provider = await loadProvider(r.provider); } catch { return { checked: false, skipped: 'provider not available' }; }
  if (!provider.validate) return { checked: false, skipped: 'provider has no re-check' };
  const days = provider.revalidateDays ? provider.revalidateDays() : 30;
  if (!force) {
    if (!(days > 0)) return { checked: false, skipped: 're-check is switched off' };
    if (now - Date.parse(r.lastValidatedAt || r.activatedAt) < days * DAY) return { checked: false, skipped: 'not due' };
    if (r.lastAttemptAt && now - Date.parse(r.lastAttemptAt) < DAY) return { checked: false, skipped: 'tried in the last 24 hours' };
  }
  let res; try { res = await provider.validate(r, { timeoutMs: force ? 10000 : 4000 }); } catch { res = { ok: false, code: 'network' }; }
  const stamp = new Date(now).toISOString();
  if (!res.ok) { save({ ...r, lastAttemptAt: stamp }); return { checked: false, skipped: res.code === 'network' ? 'offline' : 'provider error', offline: true }; }
  const next = { ...r, lastValidatedAt: stamp }; delete next.lastAttemptAt;
  if (res.valid) { delete next.revoked; save(next); return { checked: true, valid: true }; }
  next.revoked = { at: stamp, code: res.code || 'revoked' };
  save(next);
  return { checked: true, valid: false, code: next.revoked.code };
}

/**
 * Removes the activation. Asks the provider to free the place first, so the key can move to another
 * machine. If the provider cannot be reached, the local file stays unless `force` is set.
 */
export async function deactivate({ force = false } = {}) {
  const r = readJson(licenceFile());
  if (!r) return { ok: true, was: false };
  let freed = false, res = null;
  const provider = await loadProvider(r.provider).catch(() => null);
  if (provider && provider.deactivate) {
    try { res = await provider.deactivate(r); } catch { res = { ok: false, code: 'network', reason: 'The licence provider could not be reached.' }; }
    freed = !!res.ok;
    if (!res.ok && !force) return { ok: false, was: true, code: res.code, reason: res.reason };
  }
  rmSync(licenceFile(), { force: true });
  return { ok: true, was: true, freed, key: maskKey(r.key), provider: provider ? provider.label || provider.name : r.provider, already: !!(res && res.already), hasRemote: !!(provider && provider.deactivate) };
}

/** Throws unless a valid activation is stored. Offline. */
export function requireLicence() {
  const s = status();
  if (s.valid) return s;
  if (s.revoked) throw E.licenceRevoked(s.revoked, s.key);
  const e = E.noLicence(); if (s.reason !== 'not activated') e.text += ` (Found a licence file, but: ${s.reason}.)`;
  throw e;
}
/** The gate in front of recording: the occasional re-check, then the offline check. */
export async function ensureLicence() {
  await revalidate().catch(() => {});
  return requireLicence();
}
