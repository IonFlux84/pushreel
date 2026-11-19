// Which addresses Pushreel opens. Since 0.6.1 every address is pinned to the app on this machine:
// localhost, *.localhost, 127.0.0.0/8, [::1], 0.0.0.0 and *.test (reserved names that never reach the internet).
// Anything else is refused unless the user typed --allow-remote on that very command. The flag is never stored
// in a file and never inferred from an address, so a shot list, a page or a cloned repository cannot switch it on.
import { E } from './errors.js';

/** True for a host name on this machine. Pure. */
export function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h.endsWith('.test') && h.length > 5;
}
/** True for an http(s) address on this machine. Pure. */
export function isLocalUrl(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && isLocalHost(u.hostname); } catch { return false; }
}
export const isAbsolute = (url) => /^https?:\/\//i.test(String(url || ''));
export function originOf(url) { try { return new URL(url).origin; } catch { return null; } }
export const sameOrigin = (a, b) => { const x = originOf(a); return !!x && x === originOf(b); };

/** Throws `remote_url` unless the address is on this machine or the user passed --allow-remote. */
export function checkAppUrl(url, { allowRemote = false, what = 'The address' } = {}) {
  if (allowRemote || isLocalUrl(url)) return;
  throw E.remoteUrl(url, what);
}

/**
 * An address a step or scene opens: a path is joined to the app's address; an absolute one must have the app's
 * origin, unless the user passed --allow-remote. Throws `remote_url`.
 */
export function checkTarget(url, baseUrl, { allowRemote = false, what = 'The address' } = {}) {
  if (allowRemote || !isAbsolute(url) || sameOrigin(url, baseUrl)) return;
  throw E.offOrigin(url, baseUrl, what);
}

/**
 * Every absolute address in a shot list that is not on the app's origin: scenes, goto steps, prepare and login.
 * `baseUrl` is the app's address (null: the shot list's own baseUrl, else "on this machine" is the rule). Pure.
 * @returns {string[]} one problem per address
 */
export function originProblems(s, baseUrl, { allowRemote = false } = {}) {
  if (allowRemote) return [];
  const base = baseUrl || (isAbsolute(s.baseUrl) && isLocalUrl(s.baseUrl) ? s.baseUrl : null), out = [];
  const bad = (u) => isAbsolute(u) && (base ? !sameOrigin(u, base) : !isLocalUrl(u));
  const where = base ? `the app's origin (${originOf(base)})` : 'this machine (localhost)';
  if (isAbsolute(s.baseUrl) && !isLocalUrl(s.baseUrl)) out.push(`"baseUrl" is ${s.baseUrl}, not on this machine. Pushreel records apps on this machine only; to record a remote address, the user (never the agent) adds --allow-remote to the command.`);
  const steps = (list, at) => (Array.isArray(list) ? list : []).forEach((st, j) => { if (st && st.do === 'goto' && bad(st.url)) out.push(`${at}, step ${j + 1}: "goto" opens ${st.url}, which is not on ${where}. Use a path like "/today".`); });
  (Array.isArray(s.scenes) ? s.scenes : []).forEach((sc, i) => {
    const at = `Scene ${i + 1}`;
    if (sc && typeof sc.url === 'string' && bad(sc.url)) out.push(`${at}: "url" is ${sc.url}, which is not on ${where}. Use a path like "/today". Only the user may record another host, with --allow-remote.`);
    if (sc) steps(sc.steps, at);
  });
  const prep = s.prepare && !Array.isArray(s.prepare) ? s.prepare : null;
  if (prep && typeof prep.url === 'string' && bad(prep.url)) out.push(`"prepare.url" is ${prep.url}, which is not on ${where}. Use a path like "/".`);
  steps(Array.isArray(s.prepare) ? s.prepare : prep && prep.steps, 'prepare');
  return out;
}
