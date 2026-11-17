// Consent and cookie dialogs. The page side collects candidates, the choice is a pure function (unit tested).
// Default: the button that hides the dialog with the least tracking (reject, necessary only).

const REJECT = /^(alle\s+)?(ablehnen|verweigern)\b|^nur\s+(notwendige|erforderliche|essenzielle|technisch)|^(reject|decline|deny|refuse)\b|\b(necessary|essential|required)(\s+cookies)?\s+only\b|^only\s+(necessary|essential|required)|^use\s+(necessary|essential)|^no,?\s+thanks|^nein\b|^nicht\s+(zustimmen|akzeptieren|erlauben)|^ohne\s+.{0,30}(fortfahren|weiter)|^continue\s+without|^(tout\s+)?refuser|^rechazar/i;
const ACCEPT = /^(alle\s+)?(akzeptieren|annehmen|zustimmen|erlauben)\b|^(accept|allow|agree)\b|^i\s+agree|^(ok(ay)?|got\s+it|verstanden|einverstanden|ja)\b|^(tout\s+)?accepter|^aceptar/i;
const CLOSE = /^(close|schlie(ß|ss)en|dismiss|×|x)$/i;
export const CONSENT_WORDS = /cookie|consent|einwillig|datenschutz|privacy|tracking|gdpr|dsgvo|besuche\s+zählen|analytics|statistik/i;

/** What kind of button a label is: 'reject' | 'accept' | 'close' | null. */
export function consentKind(label) {
  const t = String(label || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 48) return null;
  return REJECT.test(t) ? 'reject' : ACCEPT.test(t) ? 'accept' : CLOSE.test(t) ? 'close' : null;
}

/**
 * Chooses the button that dismisses a consent dialog.
 * @param {Array<{ text, selector?, group, overlay? }>} candidates buttons inside containers that talk about cookies or consent;
 *        `group` identifies the container, `overlay` says the container is a dialog or fixed to the viewport
 * @param {'reject'|'accept'} prefer
 * @returns {null | { action: 'reject'|'accept'|'close', label: string, step: object }} step is a shot list step for `prepare`
 */
export function pickConsent(candidates = [], prefer = 'reject') {
  const order = prefer === 'accept' ? ['accept', 'reject', 'close'] : ['reject', 'accept', 'close'];
  const groups = new Map();
  for (const c of candidates) { const k = consentKind(c.text); if (!k) continue; if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push({ ...c, kind: k }); }
  // a real consent dialog offers a choice or sits on top of the page; a lone "OK" somewhere in the text does not count
  const usable = [...groups.values()].filter((g) => g.some((c) => c.overlay) || new Set(g.map((c) => c.kind)).size > 1);
  usable.sort((a, b) => Number(b.some((c) => c.overlay)) - Number(a.some((c) => c.overlay)));
  for (const g of usable) {
    for (const kind of order) {
      const c = g.find((x) => x.kind === kind);
      if (!c) continue;
      const label = c.text.replace(/\s+/g, ' ').trim();
      return { action: kind, label, step: c.selector ? { do: 'click', selector: c.selector } : { do: 'click', text: label } };
    }
  }
  return null;
}

/** Runs in the page: buttons that sit in a container talking about cookies, consent or tracking. */
export function collectConsentCandidates() {
  const WORDS = /cookie|consent|einwillig|datenschutz|privacy|tracking|gdpr|dsgvo|besuche\s+zählen|analytics|statistik/i;
  const NAMES = /cookie|consent|gdpr|dsgvo|cmp|privacy-banner|cc-window|onetrust|usercentrics|klaro/i;
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const q = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return 0; } };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const selectorFor = (el) => {
    if (el.id && q('#' + esc(el.id)) === 1) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) { const v = el.getAttribute(a); if (v && q(`[${a}="${v.replace(/"/g, '\\"')}"]`) === 1) return `[${a}="${v.replace(/"/g, '\\"')}"]`; }
    return null;
  };
  const groups = [], out = [];
  for (const el of [...document.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]')].filter(vis).slice(0, 120)) {
    if (el.closest('#__pushreel_cursor')) continue;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 48) continue;
    let box = null, node = el.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body && node !== document.documentElement; i++, node = node.parentElement) {
      const label = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''} ${node.getAttribute('aria-label') || ''}`;
      const t = (node.innerText || '').slice(0, 2000);
      if (NAMES.test(label) || (t.length < 1800 && WORDS.test(t))) { box = node; if (NAMES.test(label) || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true') break; }
    }
    if (!box) continue;
    let overlay = false;
    for (let n = box; n && n !== document.documentElement; n = n.parentElement) { const s = getComputedStyle(n); if (s.position === 'fixed' || s.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG') { overlay = true; break; } }
    let g = groups.indexOf(box); if (g < 0) { groups.push(box); g = groups.length - 1; }
    out.push({ text, selector: selectorFor(el), group: g, overlay });
  }
  return out;
}
