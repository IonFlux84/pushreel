// Pass 1 helper. The model decides where to look; this tool opens addresses, optionally performs steps,
// saves a still per address and reports what is on the page. Nothing is recorded.
//
// One call can look at several pages (a batch): one browser start and one agent turn instead of one per page.
// Pages are looked at the way they will be recorded (src/session.js, laneOf): a shot with "requiresLogin": true
// in the signed-in session, which starts from the saved login (.pushreel/auth.json); every other shot as a
// visitor. Both sessions are kept between calls (.pushreel/explore-session.json). A consent dialog is detected,
// reported with the step that belongs into the shot list's `prepare`, and dismissed, so the stills show the app.
import { join } from 'node:path';
import { launch, newContext, runStep, openScene, settle, abs, pathOf, readLogin, looksLikeLogin, redirectedTo, leftThePage } from './browser.js';
import { paths, ensureDir, writeJson, readJson, round, sleep } from './util.js';
import { PushreelError } from './errors.js';
import { collectConsentCandidates, pickConsent } from './consent.js';
import { readSaved, usableSession, saveSession, laneOf } from './session.js';

/**
 * @param {string} dir project
 * @param {object} o { baseUrl, shots: [{ url, steps?, name?, requiresLogin? }], viewportWidth?, login?, consent?: 'reject' | 'accept' }
 * @returns {Promise<object[]>} one JSON-serialisable report per shot
 */
export async function exploreShots(dir, o) {
  const p = paths(dir), creds = readLogin(dir), prefer = o.consent === 'accept' ? 'accept' : 'reject';
  const auth = readSaved(p.auth);
  // the explore sessions are only good for the login and the address they were built on
  const key = `${auth ? auth.savedAt : 'no-login'} ${o.baseUrl}`, kept = usableSession(p.exploreSession, key);
  const { browser, vp } = await launch(o.viewportWidth || 360);
  const reports = [], ctxs = {};
  const ctxFor = async (lane) => (ctxs[lane] ||= await newContext(browser, vp, { cursor: true, storageState: kept[lane] ? kept[lane].storageState : lane === 'user' && auth ? auth.storageState : null }));
  const canSignIn = !!(auth || creds);
  try {
    for (let n = 0; n < o.shots.length; n++) {
      const shot = o.shots[n], name = (shot.name || (o.shots.length > 1 ? `still-${n + 1}` : 'still')).replace(/[^a-z0-9_-]/gi, '-');
      const still = join(ensureDir(p.stills), `${name}.png`), lane = laneOf(shot), ctx = await ctxFor(lane);
      const report = { ok: true, name, url: shot.url, still, viewedAs: lane === 'user' ? (auth ? `signed in: saved session from "pushreel login"${auth.savedAt ? ` (${auth.savedAt.slice(0, 10)})` : ''}` : creds ? 'signed in with PUSHREEL_LOGIN when the app asks' : 'requiresLogin, but there is no login: no saved session (pushreel login) and PUSHREEL_LOGIN is not set') : `a visitor, not signed in${canSignIn ? ' (a login is available: add "requiresLogin": true to see this page signed in)' : ''}` };
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
      const t0 = Date.now();
      const state = { vp, mult: 1, baseUrl: o.baseUrl, sceneId: name, attempt: 1, creds: null, mouse: null, events: { segments: [], clicks: [] }, now: () => (Date.now() - t0) / 1000 };
      try {
        const full = abs(o.baseUrl, shot.url);
        const { loggedIn } = await openScene(page, full, state, { creds: lane === 'user' ? creds : null, loginCfg: o.login, savedSession: lane === 'user' && !!auth });
        report.neededLogin = loggedIn;
        const movedTo = redirectedTo(full, page.url());
        if (movedTo) {
          const left = leftThePage(full, movedTo);
          const why = !left ? '' : lane === 'user'
            ? (auth ? 'This page was opened signed in. Either it is a page for visitors (a landing page sends signed-in users on): then drop "requiresLogin" for it. Or the saved session has expired: then the user runs /pushreel login again.' : 'It needs a login and there is none: the user runs /pushreel login (any login, also OAuth) or sets PUSHREEL_LOGIN (password form).')
            : (canSignIn ? 'This page was opened as a visitor. If it is behind the login, explore it again with "requiresLogin": true and mark the scene the same way.' : 'If the page is behind the login, it cannot be recorded without one: the user runs /pushreel login (any login, also OAuth) or sets PUSHREEL_LOGIN (password form).');
          report.redirected = { from: pathOf(full), to: movedTo, note: `The app sent the browser to another page. This still shows that page, not the one you asked for. ${why}`.trim() };
        }
        await settle(page);
        // Consent or cookie dialog: report it once, with the step for "prepare", and get it out of the way.
        const consent = await dismissConsent(page, prefer, state);
        if (consent) {
          report.consent = consent;
          writeJson(p.consent, { ...consent, url: shot.url, at: new Date().toISOString() });
        }
        const steps = shot.steps || [];
        const t1 = state.now();
        for (let i = 0; i < steps.length; i++) await runStep(page, steps[i], state, i);
        await settle(page, 400);
        report.stepsSeconds = round(state.now() - t1, 1);
      } catch (e) {
        if (!(e instanceof PushreelError)) throw e;
        report.ok = false; report.problem = e.toJSON();
      }
      await page.screenshot({ path: still, scale: 'css' }).catch(() => {}); // CSS pixels: small enough for the agent to look at cheaply
      report.finalUrl = pathOf(page.url());
      report.title = await page.title().catch(() => '');
      report.loginPage = await looksLikeLogin(page);
      report.clicks = state.events.clicks.map((c) => ({ x: round(c.x, 3), y: round(c.y, 3), w: round(c.w, 3), h: round(c.h, 3) }));
      report.consoleErrors = consoleErrors.slice(0, 5);
      report.page = await page.evaluate(describePage).catch(() => null);
      writeJson(join(p.stills, `${name}.json`), { url: shot.url, finalUrl: report.finalUrl, clicks: report.clicks, headings: (report.page && report.page.headings) || [], at: new Date().toISOString() });
      await page.close().catch(() => {});
      reports.push(report);
    }
    for (const [lane, ctx] of Object.entries(ctxs)) { saveSession(p.exploreSession, lane, await ctx.storageState(), { baseUrl: o.baseUrl, key }); await ctx.close(); }
  } finally { await browser.close().catch(() => {}); }
  const known = readJson(p.consent);
  if (known && known.prepare) for (const r of reports) if (!r.consent) r.consentPrepare = known.prepare; // remind on every report: it belongs into "prepare"
  return reports;
}

/** One page: kept for callers that look at a single address. */
export async function exploreShot(dir, o) {
  return (await exploreShots(dir, { ...o, shots: [{ url: o.url, steps: o.steps, name: o.name, requiresLogin: !!o.requiresLogin }] }))[0];
}

/**
 * Finds a consent dialog, clicks the button with the least tracking (or "accept" when asked) and reports the step.
 * @returns {Promise<null | { found: true, action, button, prepare: object[], dismissed: boolean, note }>}
 */
export async function dismissConsent(page, prefer, state) {
  const pick = pickConsent(await page.evaluate(collectConsentCandidates).catch(() => []), prefer);
  if (!pick) return null;
  const quiet = { ...state, events: { segments: [], clicks: [] }, now: () => 0 };
  let dismissed = true;
  try { await runStep(page, { ...pick.step, timeout: 2500 }, quiet, 0); await sleep(400); } catch { dismissed = false; }
  state.mouse = quiet.mouse;
  return {
    found: true, action: pick.action, button: pick.label, prepare: [pick.step], dismissed,
    note: `A consent dialog covers the page. Put this step into "prepare" of the shot list, never into a scene: prepare runs before the recording and is not in the video. ` +
      `Chosen: "${pick.label}" (${pick.action === 'reject' ? 'the option with the least tracking' : pick.action === 'accept' ? (prefer === 'accept' ? 'accept, as asked' : 'there is no reject button') : 'closes the dialog'}). ` +
      (dismissed ? 'It was clicked here so the stills show the app; it stays dismissed for the following explore calls.' : 'The click did not work here; check the selector.'),
  };
}

/** Runs in the page: headings and the interactive elements with a selector each. */
function describePage() {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 3; };
  const txt = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const q = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return 0; } };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const selectorFor = (el) => {
    if (el.id && q('#' + esc(el.id)) === 1) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) { const v = el.getAttribute(a); if (v && q(`[${a}="${v.replace(/"/g, '\\"')}"]`) === 1) return `[${a}="${v.replace(/"/g, '\\"')}"]`; }
    for (const a of el.attributes) { if (a.name.startsWith('data-') && a.value && q(`[${a.name}="${a.value.replace(/"/g, '\\"')}"]`) === 1) return `[${a.name}="${a.value.replace(/"/g, '\\"')}"]`; }
    if (el.tagName === 'A' && el.getAttribute('href') && q(`a[href="${el.getAttribute('href')}"]`) === 1) return `a[href="${el.getAttribute('href')}"]`;
    return null;
  };
  const els = [...document.querySelectorAll('a[href], button, [role="button"], [role="tab"], [role="switch"], [role="link"], input, select, textarea, summary, [onclick], [tabindex="0"]')]
    .filter((el) => vis(el) && !el.closest('#__pushreel_cursor')).slice(0, 60);
  return {
    // the page's h1 first: the validator compares captions with these, and the list is cut at 12
    headings: [...document.querySelectorAll('h1'), ...document.querySelectorAll('h2, h3')].filter(vis).map((h) => h.innerText.replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 12),
    scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
    interactive: els.map((el) => {
      const r = el.getBoundingClientRect(), t = txt(el), sel = selectorFor(el);
      // useText must be findable as one piece of text: the first line of the element, not all its lines run together
      const line = (el.innerText || '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).find(Boolean) || t;
      return { tag: el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? `[${el.type}]` : ''), text: t, selector: sel, useText: !sel && t ? line.slice(0, 60) : undefined, href: el.tagName === 'A' ? el.getAttribute('href') : undefined, inView: r.top >= 0 && r.bottom <= innerHeight };
    }),
  };
}
