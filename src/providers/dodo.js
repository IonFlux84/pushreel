// Licence provider: Dodo Payments (merchant of record), https://docs.dodopayments.com/features/license-keys
//
// Three endpoints, all public by Dodo's design ("No API Key Required", meant for desktop apps and CLIs),
// so this file holds no secret:
//   POST /licenses/activate    { license_key, name }                         → 201 { id: "lki_…", product: { product_id }, … }
//                                                                              403 key inactive · 404 unknown key · 422 activation limit reached
//   POST /licenses/validate    { license_key, license_key_instance_id? }     → 200 { valid: boolean }
//   POST /licenses/deactivate  { license_key, license_key_instance_id }      → 200 · 403 instance not found for this key · 404 unknown key
// Base URLs: https://live.dodopayments.com (live), https://test.dodopayments.com (test mode).
//
// Because the endpoints are public, ANY Dodo licence key of ANY merchant activates successfully. The check
// that makes a key a Pushreel key is the product id in the activate response; it must be listed in
// config/license.json. Without a configured product id this provider refuses to activate.
//
// Written from the documentation (read 2026-11-17). NOT yet run against the live or test API: see
// docs/LICENSING.md for the 10-minute check.
import { join } from 'node:path';
import { readJson, PLUGIN_ROOT, VERSION } from '../util.js';
import { readUserConfig } from '../userconfig.js';
import { testSupportOn } from '../license.js';

export const BASE = { live: 'https://live.dodopayments.com', test: 'https://test.dodopayments.com' };
export const SUPPORT = 'hello@pushreel.dev';
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).map((s) => s.trim()).filter(Boolean);

/**
 * Effective settings. Mode: PUSHREEL_DODO_MODE, then ~/.pushreel/config.json ("dodo": {"mode": "test"}),
 * then config/license.json, then "live". Product ids: PUSHREEL_DODO_PRODUCT_ID (comma separated) or
 * config/license.json dodo.productId.<mode>.
 * A different base URL is only accepted inside the test harness (enableTestSupport in src/license.js, which
 * nothing in the shipped files calls) and only on this machine: that is how the tests reach the mock.
 */
export function settings(env = process.env, cfg = readJson(join(PLUGIN_ROOT, 'config', 'license.json'), {}), user = readUserConfig(), testHarness = testSupportOn()) {
  const d = (cfg && cfg.dodo) || {};
  const pick = [env.PUSHREEL_DODO_MODE, user.dodo && user.dodo.mode, d.mode].find((m) => m === 'test' || m === 'live');
  const mode = pick || 'live';
  const productIds = env.PUSHREEL_DODO_PRODUCT_ID ? list(env.PUSHREEL_DODO_PRODUCT_ID.split(',')) : list(d.productId && d.productId[mode]);
  const override = testHarness && LOOPBACK.test(env.PUSHREEL_DODO_BASE_URL || '') ? env.PUSHREEL_DODO_BASE_URL : null;
  const days = Number.isFinite(Number(d.revalidateDays)) ? Math.max(0, Number(d.revalidateDays)) : 30;
  return { mode, baseUrl: override || BASE[mode], testEndpoint: !!override, productIds, revalidateDays: days };
}

async function post(baseUrl, path, body, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const res = await fetchImpl(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `pushreel/${VERSION}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, data };
  } catch (e) { return { network: true, error: String((e && e.cause && e.cause.code) || (e && e.name) || e) }; }
}
const host = (u) => u.replace(/^https?:\/\//, '');

/**
 * The activation limit, if the 422 answer names it. Dodo's documentation does not describe the error body;
 * the licence key object calls the field `activations_limit`. Anything else: null, and the text has no number.
 */
export function limitFrom(data) {
  const seen = [data, data && data.license_key, data && data.error, data && data.details].filter((o) => o && typeof o === 'object');
  for (const o of seen) for (const f of ['activations_limit', 'activation_limit', 'max_activations', 'limit']) {
    const n = Number(o[f]);
    if (o[f] !== null && o[f] !== '' && Number.isInteger(n) && n > 0 && n < 1000) return n;
  }
  return null;
}
export function limitReason(n) {
  const many = n ? `${n} machine${n === 1 ? '' : 's'}` : 'as many machines as the licence allows';
  return `This key is already active on ${many}. Run \`pushreel deactivate\` on ${n === 1 ? 'it' : 'one of them'} (or \`/pushreel deactivate\` in Claude Code), then activate again. No access to ${n === 1 ? 'that machine' : 'any of them'}? Write to ${SUPPORT} and we free a place.`;
}

/** Builds the provider. Tests pass { fetchImpl } and their own settings. */
export function createDodo(o = {}) {
  const cfg = () => o.settings || settings();
  const call = (base, path, body, timeoutMs) => post(base, path, body, { fetchImpl: o.fetchImpl, timeoutMs });
  const baseOf = (record) => (record && record.baseUrl && cfg().testEndpoint ? record.baseUrl : BASE[(record && record.mode) || cfg().mode]);

  return {
    name: 'dodo',
    label: 'Dodo Payments',
    normalizeKey: (k) => String(k || '').trim(),
    revalidateDays: () => cfg().revalidateDays,
    describe() { const s = cfg(); return `Dodo Payments, ${s.mode} mode${s.testEndpoint ? ` (TEST ENDPOINT ${s.baseUrl})` : ''}${s.productIds.length ? '' : ', no product id configured'}`; },
    /** What activate sends, for the message shown before the request. */
    sends: (ctx) => (ctx.custom
      ? `the licence key and the label you gave with --name ("${ctx.machineName}")`
      : `the licence key and a neutral label for this machine ("${ctx.machineName}"; no hostname, no user name)`),

    /** A reason not to send anything at all, or null. */
    notReady() {
      const s = cfg();
      return s.productIds.length ? null : { ok: false, code: 'not_configured', reason: `This build is not set up for sale yet: no Dodo product id for ${s.mode} mode in config/license.json ("dodo.productId.${s.mode}"). Nothing was sent.` };
    },

    async activate(key, ctx) {
      const s = cfg();
      const no = this.notReady(); if (no) return no;
      const r = await call(s.baseUrl, '/licenses/activate', { license_key: key, name: ctx.machineName });
      if (r.network) return { ok: false, code: 'network', reason: `Could not reach Dodo Payments (${host(s.baseUrl)}) to check the key. Activation needs this one request. Check your connection, VPN or firewall and run the command again. Nothing was stored.` };
      if ((r.status === 200 || r.status === 201) && r.data && r.data.id) {
        const productId = r.data.product && r.data.product.product_id;
        if (!s.productIds.includes(String(productId))) {
          await call(s.baseUrl, '/licenses/deactivate', { license_key: key, license_key_instance_id: r.data.id }); // give the place back
          return { ok: false, code: 'wrong_product', reason: 'This key is valid, but it belongs to another product, not to Pushreel. Copy the Pushreel key from your purchase email.' };
        }
        return { ok: true, instanceId: r.data.id, extra: { mode: s.mode, licenceKeyId: r.data.license_key_id || '', productId: String(productId), ...(s.testEndpoint ? { baseUrl: s.baseUrl } : {}) }, devOnly: s.testEndpoint };
      }
      if (r.status === 404) return { ok: false, code: 'invalid_key', reason: `Dodo Payments does not know this key. Copy it from your purchase email exactly as written: no spaces, and upper and lower case matter.${s.mode === 'live' ? '' : ' (You are in test mode: only keys bought in test mode work here.)'}` };
      if (r.status === 403) return { ok: false, code: 'inactive', reason: `This key is not active any more: it was disabled, refunded or has expired. If that is a mistake, write to ${SUPPORT} with your order number.` };
      if (r.status === 422) return { ok: false, code: 'limit', limit: limitFrom(r.data), reason: limitReason(limitFrom(r.data)) };
      return { ok: false, code: 'provider_error', reason: `Dodo Payments answered with an error (HTTP ${r.status}). Try again in a few minutes. Nothing was stored.` };
    },

    /**
     * Is the key still good, and does this machine's activation still exist?
     * @returns {{ ok: true, valid: true } | { ok: true, valid: false, code: 'revoked' | 'instance_removed' } | { ok: false, code: 'network' | 'provider_error' }}
     */
    async validate(record, { timeoutMs = 10000 } = {}) {
      const base = baseOf(record);
      const one = async (body) => {
        const r = await call(base, '/licenses/validate', body, timeoutMs);
        if (r.network) return { ok: false, code: 'network' };
        if (r.status === 200 && r.data && typeof r.data.valid === 'boolean') return { ok: true, valid: r.data.valid };
        if (r.status === 404 || r.status === 403) return { ok: true, valid: false };
        return { ok: false, code: 'provider_error' };
      };
      const both = await one({ license_key: record.key, license_key_instance_id: record.instanceId || null });
      if (!both.ok || both.valid) return both;
      const keyOnly = await one({ license_key: record.key }); // tell "key revoked" from "this activation was removed"
      if (!keyOnly.ok) return keyOnly;
      return { ok: true, valid: false, code: keyOnly.valid ? 'instance_removed' : 'revoked' };
    },

    /** Frees this machine's place. 403/404 mean it is already gone, which is fine. */
    async deactivate(record) {
      if (!record.instanceId) return { ok: true, already: true };
      const base = baseOf(record);
      const r = await call(base, '/licenses/deactivate', { license_key: record.key, license_key_instance_id: record.instanceId });
      if (r.network) return { ok: false, code: 'network', reason: `Could not reach Dodo Payments (${host(base)}), so the place this machine uses could not be freed.` };
      if (r.status === 200 || r.status === 204) return { ok: true };
      if (r.status === 403 || r.status === 404) return { ok: true, already: true };
      return { ok: false, code: 'provider_error', reason: `Dodo Payments answered with an error (HTTP ${r.status}), so the place this machine uses could not be freed.` };
    },
  };
}

export default createDodo();
