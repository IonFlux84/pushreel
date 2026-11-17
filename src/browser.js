// Headless browser: launch at 1080×1920, the visible cursor, and the step executor used by both
// exploring (model-driven, one still) and recording (fixed code).
import { viewportFor } from './presets.js';
import { E, PushreelError } from './errors.js';
import { sleep, readEnvFiles } from './util.js';
import { scrollDuration, scrollDeltas } from './motion.js';

export const DEFAULT_TIMEOUT = 5000;   // per action, doubled on each retry
export const NAV_TIMEOUT = 15000;      // per page load, doubled on each retry

/** Launches Chromium so that a CSS viewport of e.g. 360×640 is rendered and captured at 1080×1920. */
export async function launch(viewportWidth = 360, { headless = true } = {}) {
  const vp = viewportFor(viewportWidth);
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { throw E.browserMissing(); }
  let browser;
  try {
    // The forced scale factor makes the compositor surface really 1080×1920, so the screencast is sharp.
    browser = await chromium.launch(headless ? { args: [`--force-device-scale-factor=${vp.scale}`, '--hide-scrollbars', '--disable-lcd-text'] } : { headless: false });
  } catch (e) {
    if (/Executable doesn't exist|playwright install/i.test(String(e.message))) throw E.browserMissing();
    throw e;
  }
  return { browser, vp };
}

export async function newContext(browser, vp, { storageState, colorScheme = 'light', cursor = true, cursorKind = 'arrow', clickColor = '#ff2a8a' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale, isMobile: false, hasTouch: false,
    colorScheme, reducedMotion: 'no-preference', storageState: storageState || undefined, locale: 'en-US',
  });
  if (cursor && cursorKind !== 'none') await ctx.addInitScript(cursorScript, { kind: cursorKind === 'dot' ? 'dot' : 'arrow', ring: /^#[0-9a-f]{6}$/i.test(clickColor || '') ? clickColor : '#ff2a8a' });
  return ctx;
}

/** Runs inside every page: draws a pointer (an arrow or a dot, from the style) that follows the mouse and a ring on every click. */
function cursorScript(opt) {
  if (window.top !== window || window.__pushreelCursor) return;
  const kind = (opt && opt.kind) || 'arrow', ringColor = (opt && opt.ring) || '#ff2a8a';
  const hex = ringColor.replace('#', ''), rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',');
  window.__pushreelCursor = true;
  const KEY = '__pushreel_xy';
  const make = () => {
    if (document.getElementById('__pushreel_cursor')) return;
    const root = document.createElement('div');
    root.id = '__pushreel_cursor';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;contain:layout style;';
    root.innerHTML = '<div data-ring style="position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid ' + ringColor + ';background:rgba(' + rgb + ',.18);opacity:0;transform:scale(.3);"></div>' +
      (kind === 'dot'
        ? '<div data-arrow style="position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;background:rgba(14,10,31,.5);border:2.5px solid #fff;box-shadow:0 1px 4px rgba(14,10,31,.4);"></div>'
        : '<svg data-arrow viewBox="0 0 20 20" width="30" height="30" style="position:absolute;left:-4.5px;top:-3px;filter:drop-shadow(0 1px 2px rgba(14,10,31,.45));"><path d="M3 2l13 6.2-5.6 1.7L8.2 16z" fill="#fff" stroke="#0e0a1f" stroke-width="1.6" stroke-linejoin="round"/></svg>');
    (document.body || document.documentElement).appendChild(root);
    const ring = root.querySelector('[data-ring]');
    const place = (x, y) => { root.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
    let saved = null; try { saved = JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { /* storage blocked */ }
    place(saved ? saved[0] : innerWidth * 0.52, saved ? saved[1] : innerHeight * 0.84);
    // Hidden until the mouse moves: the settled first picture of a scene (the cover) shows no parked arrow.
    const arrow = root.querySelector('[data-arrow]');
    let hidden = false;
    window.__pushreelHideCursor = () => { hidden = true; arrow.style.transition = 'none'; arrow.style.opacity = '0'; };
    addEventListener('mousemove', (e) => {
      place(e.clientX, e.clientY);
      if (hidden) { hidden = false; arrow.style.transition = 'opacity 140ms ease-out'; arrow.style.opacity = '1'; }
      try { sessionStorage.setItem(KEY, JSON.stringify([e.clientX, e.clientY])); } catch (err) { /* storage blocked */ }
    }, true);
    addEventListener('mousedown', () => {
      ring.getAnimations().forEach((a) => a.cancel());
      ring.animate([{ opacity: 1, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.5)' }], { duration: 650, easing: 'ease-out' });
    }, true);
  };
  if (document.body) make(); else addEventListener('DOMContentLoaded', make);
}

/** Reads the test account. Order: environment, then .env files of the project. Never logged, never stored. */
export function readLogin(projectDir) {
  const raw = process.env.PUSHREEL_LOGIN || (projectDir ? readEnvFiles(projectDir).PUSHREEL_LOGIN : '') || '';
  const i = raw.indexOf(':');
  if (i < 1 || i === raw.length - 1) return null;
  return { email: raw.slice(0, i), password: raw.slice(i + 1) };
}

export const abs = (baseUrl, url) => (/^https?:\/\//.test(url) ? url : baseUrl.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url));
/** Where the app sent the browser instead of the asked address (path only, without query), or null. Pure. */
export function redirectedTo(asked, got) {
  // (see leftThePage for "is this a login wall?")
  const norm = (u) => (pathOf(u).split(/[?#]/)[0].replace(/\/+$/, '') || '/');
  const a = norm(asked), g = norm(got);
  return a === g ? null : g;
}
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
/**
 * True when a redirect took the browser off the asked page altogether: /entdecken → / is, /app → /app/home is not.
 * For a scene behind the login this is how an app without a login form (OAuth, magic link) shows its login wall. Pure.
 */
export function leftThePage(asked, movedTo) {
  if (!movedTo) return false;
  const a = (pathOf(asked).split(/[?#]/)[0].replace(/\/+$/, '') || '/');
  return !(movedTo === a || movedTo.startsWith(a === '/' ? '/' : a + '/'));
}

/** True when the page looks like a login page: a visible password field, or a login-like address. */
export async function looksLikeLogin(page) {
  const path = pathOf(page.url()).toLowerCase();
  const pw = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  return pw || /\/(login|log-in|signin|sign-in|sign_in|auth\/login|users\/sign_in|session\/new)(\/|\?|$)/.test(path);
}
/** True when the page asks for a one-time code or shows a captcha. */
export async function looksLikeVerification(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    if ([...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile')].some(vis)) return true;
    if ([...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], input[name*="2fa" i], input[name*="verification" i]')].some(vis)) return true;
    return false;
  }).catch(() => false);
}

function locate(page, step) {
  if (step.selector) return page.locator(step.selector).first();
  return page.getByText(step.text, { exact: false }).first();
}
const describe = (step) => (step.text ? `"${step.text}"` : `"${step.selector}"`);

/** Moves the mouse along an eased path so the drawn cursor glides instead of jumping. */
async function glide(page, state, x, y, ms = 420) {
  const from = state.mouse || { x: state.vp.width * 0.52, y: state.vp.height * 0.84 };
  const dist = Math.hypot(x - from.x, y - from.y);
  const dur = Math.max(160, Math.min(ms, 140 + dist * 1.1)), n = Math.max(4, Math.round(dur / 16));
  const t0 = Date.now();
  for (let i = 1; i <= n; i++) {
    const p = i / n, e = p * p * (3 - 2 * p);
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    const due = t0 + (dur * i) / n - Date.now();
    if (due > 0) await sleep(due);
  }
  state.mouse = { x, y };
}

/**
 * Executes one step. `state` carries { vp, mouse, mult, baseUrl, now(), events: { segments, clicks }, sceneId, creds }.
 * Technical pauses are logged as segments so the cut can remove them. Clicks are logged with their position.
 */
export async function runStep(page, step, state, index) {
  const timeout = (step.timeout || DEFAULT_TIMEOUT) * state.mult;
  const fill = (v) => String(v).replace(/\{\{email\}\}/g, state.creds ? state.creds.email : '').replace(/\{\{password\}\}/g, state.creds ? state.creds.password : '');
  const seg = async (type, fn) => { const start = state.now(); try { return await fn(); } finally { state.events.segments.push({ type, start, end: state.now(), step: index }); } };
  const notFound = (e) => (/Timeout|waiting for/i.test(String(e && e.message)) ? E.elementNotFound(state.sceneId, describe(step), state.attempt || 1) : e);

  const target = async () => {
    const loc = locate(page, step);
    try { await seg('wait', () => loc.waitFor({ state: 'visible', timeout })); } catch (e) { throw notFound(e); }
    await loc.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw E.elementNotFound(state.sceneId, describe(step), state.attempt || 1);
    const x = box.x + box.width * (step.at ? step.at[0] : 0.5), y = box.y + box.height * (step.at ? step.at[1] : 0.5);
    return { loc, box, x, y };
  };

  switch (step.do) {
    case 'click': {
      const t = await target();
      await glide(page, state, t.x, t.y);
      await sleep(110);
      const hit = await t.loc.evaluate((el, [x, y]) => { const e = document.elementFromPoint(x, y); return !!e && (el === e || el.contains(e) || e.contains(el)); }, [t.x, t.y]).catch(() => false);
      const at = state.now();
      if (hit) { await page.mouse.down(); await sleep(70); await page.mouse.up(); }
      else { try { await t.loc.click({ timeout }); } catch (e) { throw notFound(e); } }
      state.events.clicks.push({ t: at, x: t.x / state.vp.width, y: t.y / state.vp.height, step: index, w: t.box.width / state.vp.width, h: t.box.height / state.vp.height });
      await sleep(120);
      // a click may start a page load: that is waiting time
      await seg('wait', () => page.waitForLoadState('load', { timeout: NAV_TIMEOUT * state.mult }).catch(() => {}));
      break;
    }
    case 'hover': { const t = await target(); await glide(page, state, t.x, t.y); await sleep(200); break; }
    case 'type': {
      const t = await target();
      await glide(page, state, t.x, t.y);
      await page.mouse.down(); await sleep(60); await page.mouse.up();
      await t.loc.focus().catch(() => {});
      if (step.clear !== false) await t.loc.fill('').catch(() => {});
      await page.keyboard.type(fill(step.value), { delay: step.delay ?? 45 });
      break;
    }
    case 'press': await page.keyboard.press(step.key); await sleep(120); break;
    case 'scroll': {
      let dy = step.y;
      if (step.selector) {
        const loc = locate(page, step);
        try { await seg('wait', () => loc.waitFor({ state: 'attached', timeout })); } catch (e) { throw notFound(e); }
        // the distance that brings the element to the middle of the window
        dy = await loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 - innerHeight / 2; }).catch((e) => { throw notFound(e); });
      }
      const t0 = state.now(), moved = await smoothScroll(page, dy, state.scrollSpeed || 1);
      if (state.events.scrolls) state.events.scrolls.push({ t: t0, end: state.now(), px: Math.round(moved.moved), ms: moved.ms, step: index });
      await sleep(250);
      break;
    }
    case 'goto': await seg('wait', async () => { await navigate(page, abs(state.baseUrl, step.url), state); }); break;
    case 'wait': await seg('wait', () => sleep(step.ms * state.mult)); break;
    case 'hold': await sleep(step.ms); break;
    case 'waitFor': try { await seg('wait', () => locate(page, step).waitFor({ state: 'visible', timeout })); } catch (e) { throw notFound(e); } break;
    default: throw new Error(`Unknown step "${step.do}"`);
  }
}

/**
 * Scrolls the page by `dy` CSS px as an eased animation, one position per painted frame, so the recording shows
 * a movement and not a jump. Its length grows with the distance and is capped (src/motion.js).
 * A page that scrolls inside a container gets the same curve as wheel events.
 * @returns {Promise<{ moved: number, ms: number }>}
 */
export async function smoothScroll(page, dy, speed = 1) {
  const length = (d) => Math.max(200, Math.round(scrollDuration(d) / Math.max(0.5, Math.min(2, speed || 1))));
  const room = await page.evaluate((d) => { const el = document.scrollingElement || document.documentElement; const max = el.scrollHeight - el.clientHeight; return Math.max(0, Math.min(max, el.scrollTop + d)) - el.scrollTop; }, dy).catch(() => 0);
  if (Math.abs(room) >= 1) {
    const ms = length(room);
    await page.evaluate(({ d, ms }) => new Promise((done) => {
      const el = document.scrollingElement || document.documentElement, html = document.documentElement;
      const from = el.scrollTop, before = html.style.scrollBehavior;
      html.style.scrollBehavior = 'auto'; // the page's own smooth scrolling would fight the animation
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / ms), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        el.scrollTop = from + d * e;
        if (p < 1) requestAnimationFrame(tick); else { html.style.scrollBehavior = before; done(); }
      };
      requestAnimationFrame(tick);
    }), { d: room, ms });
    return { moved: room, ms };
  }
  if (Math.abs(dy) < 1) return { moved: 0, ms: 0 };
  const ms = length(dy), deltas = scrollDeltas(dy, ms);
  const t0 = Date.now();
  for (let i = 0; i < deltas.length; i++) { await page.mouse.wheel(0, deltas[i]); const due = t0 + (ms * (i + 1)) / deltas.length - Date.now(); if (due > 0) await sleep(due); }
  return { moved: dy, ms };
}

/**
 * What the page shows right now, for the caption and cover placement: boxes of the visible large headings
 * (h1, h2, role=heading up to level 2), smaller titles (card titles), bars fixed or stuck to the top or bottom
 * edge, and pictures (img, svg, canvas, video, background images; not icons). Fractions of the viewport.
 */
export async function captureLayout(page) {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight, r4 = (n) => Math.round(n * 10000) / 10000;
    const box = (el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (r.width < 8 || r.height < 8 || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
      const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(W, r.right), y1 = Math.min(H, r.bottom);
      if (x1 - x0 < 8 || y1 - y0 < 8) return null;
      return { x: r4(x0 / W), y: r4(y0 / H), w: r4((x1 - x0) / W), h: r4((y1 - y0) / H) };
    };
    // Large headings only: the page's h1, and h2 or role=heading (level 1 or 2) set in a large type.
    // A list of cards with an h2 each is content, not a headline. `big` marks the h1: it weighs double.
    const headings = [];
    for (const el of document.querySelectorAll('h1, h2, [role="heading"]')) {
      if (el.closest('#__pushreel_cursor')) continue;
      const level = Number(el.getAttribute('aria-level') || (el.tagName === 'H1' ? 1 : 2));
      if (level > 2) continue;
      const px = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (level === 2 && px < 22) continue;
      const b = box(el); if (b && headings.length < 12) headings.push(level === 1 ? { ...b, big: true } : b);
    }
    // Smaller headings and bold labels: card titles and section titles. A caption on them hides what a card is about.
    const titles = [];
    for (const el of document.querySelectorAll('h2, h3, h4, [role="heading"]')) {
      if (titles.length >= 16 || el.closest('#__pushreel_cursor')) continue;
      const level = Number(el.getAttribute('aria-level') || (el.tagName === 'H1' ? 1 : el.tagName === 'H2' ? 2 : el.tagName === 'H3' ? 3 : 4));
      if (level === 1 || (level === 2 && (parseFloat(getComputedStyle(el).fontSize) || 0) >= 22)) continue; // already a large heading
      const b = box(el); if (b) titles.push(b);
    }
    const bars = [], pictures = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 4000; i++) {
      const el = all[i];
      if (el.id === '__pushreel_cursor' || el.closest('#__pushreel_cursor')) continue;
      const s = getComputedStyle(el), pos = s.position, tag = el.tagName;
      if ((pos === 'fixed' || pos === 'sticky') && bars.length < 6) {
        const r = el.getBoundingClientRect();
        if (r.width >= W * 0.6 && r.height >= 16 && r.height <= H * 0.3 && (r.top <= 8 || r.bottom >= H - 8)) { const b = box(el); if (b) bars.push(b); }
      }
      // Pictures: images, drawings, canvas, video and background images. Icons (under 28 CSS px) are not pictures;
      // a backdrop that fills most of the screen is not one either, or no spot would ever be free.
      // Bold labels: the title of a card or tile that is not marked up as a heading (a <b> or a bold <div>).
      if (titles.length < 28 && !/^(H[1-6]|SVG|PATH|IMG|CANVAS|VIDEO|HTML|BODY)$/i.test(tag) && !el.closest('h1, h2, h3, h4, [role="heading"]')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (own && (Number(s.fontWeight) || 400) >= 600 && (parseFloat(s.fontSize) || 0) >= 15) { const b = box(el); if (b) titles.push(b); }
      }
      const pic = tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO' || (tag.toLowerCase() === 'svg' && !el.ownerSVGElement) || (s.backgroundImage && s.backgroundImage.includes('url('));
      if (!pic) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 28 || r.height < 28 || r.width * r.height > W * H * 0.6) continue;
      const b = box(el); if (b) pictures.push(b);
    }
    pictures.sort((a, b) => b.w * b.h - a.w * a.h);
    return { headings, bars, pictures: pictures.slice(0, 24), titles };
  }).catch(() => ({ headings: [], bars: [], pictures: [], titles: [] }));
}

/**
 * Runs the `prepare` steps of a shot list: consent choice, a popup to close, a theme to set. Nothing is recorded.
 * A step whose element is not there is skipped (the banner may already be gone), because prepare describes a state
 * to reach, not a story to show. Other failures (the app is down, an error page) stop the run.
 * @returns {Promise<{ done: number, skipped: string[] }>}
 */
export async function runPrepare(page, prepare, state) {
  const quiet = { ...state, sceneId: 'prepare', events: { segments: [], clicks: [] }, now: () => 0 };
  await navigate(page, abs(state.baseUrl, prepare.url), quiet);
  await settle(page, 250);
  let done = 0; const skipped = [];
  for (let i = 0; i < prepare.steps.length; i++) {
    const step = prepare.steps[i], targeted = ['click', 'hover', 'type', 'waitFor', 'scroll'].includes(step.do) && (step.selector || step.text);
    try { await runStep(page, targeted && !step.timeout ? { ...step, timeout: 2500 } : step, quiet, i); done++; }
    catch (e) {
      if (e instanceof PushreelError && e.code === 'element_not_found') { skipped.push(`step ${i + 1} (${step.do} ${describe(step)}): not on the page, skipped`); continue; }
      throw e;
    }
  }
  await page.waitForLoadState('load', { timeout: NAV_TIMEOUT * (state.mult || 1) }).catch(() => {});
  await sleep(350); // let the page write its cookie or storage entry
  return { done, skipped };
}

/** Opens an address. Maps connection failures and 5xx answers to catalogue errors. */
export async function navigate(page, url, state) {
  let res;
  try { res = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT * (state.mult || 1) }); } catch (e) {
    const m = String(e.message);
    if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_NAME_NOT_RESOLVED/.test(m)) throw E.appDown(state.sceneId, state.baseUrl);
    if (/Timeout/i.test(m)) throw E.timeout(state.sceneId, `Loading ${pathOf(url)}`);
    throw e;
  }
  if (res && res.status() >= 500) throw E.pageError(state.sceneId, pathOf(url), res.status());
  return res;
}

/** Waits until fonts are loaded and two frames were painted, so the first recorded frame is the finished page. */
export async function settle(page, ms = 150) {
  await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : null)).catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await waitScrollStill(page);
  await sleep(ms);
}

/**
 * Waits until the page has stopped scrolling by itself. A scene address with an anchor (`/#price`) on a page with
 * `scroll-behavior: smooth` glides to its section after the load; without this wait the recording started in the
 * middle of that glide and the scene's first `scroll` step fought with it (found recording pushreel.dev).
 * Still = the same position in `still` samples in a row, `every` ms apart; gives up after `max` ms.
 */
export async function waitScrollStill(page, { every = 50, still = 3, max = 2500 } = {}) {
  const read = () => page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return `${Math.round(el.scrollLeft)},${Math.round(el.scrollTop)}`;
  }).catch(() => null);
  let last = await read(), same = 0;
  for (let waited = 0; waited < max && same < still; waited += every) {
    await sleep(every);
    const now = await read();
    if (now === null) return false;
    same = now === last ? same + 1 : 0; last = now;
  }
  return same >= still;
}

const DEFAULT_LOGIN_STEPS = [
  { do: 'type', selector: 'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"], input[type="text"]', value: '{{email}}' },
  { do: 'type', selector: 'input[type="password"]', value: '{{password}}' },
  { do: 'click', selector: 'button[type="submit"], input[type="submit"], form button' },
];

/**
 * Signs in with the test account on the page that is currently a login page (or on login.url).
 * Leaves the context signed in. Throws login_failed / verification.
 */
export async function signIn(page, state, loginCfg) {
  if (loginCfg && loginCfg.url && !(await looksLikeLogin(page))) await navigate(page, abs(state.baseUrl, loginCfg.url), state);
  const steps = (loginCfg && loginCfg.steps && loginCfg.steps.length ? loginCfg.steps : DEFAULT_LOGIN_STEPS);
  const quiet = { ...state, events: { segments: [], clicks: [] }, now: () => 0 };
  for (let i = 0; i < steps.length; i++) await runStep(page, steps[i], quiet, i);
  await page.waitForLoadState('load', { timeout: NAV_TIMEOUT * state.mult }).catch(() => {});
  await sleep(300);
  state.mouse = quiet.mouse;
  if (await looksLikeVerification(page)) throw E.verification(state.sceneId, pathOf(page.url()));
  if (await looksLikeLogin(page)) throw E.loginFailed(state.sceneId, pathOf(page.url()));
}

/**
 * Opens a scene's address in a fresh page and deals with the login wall.
 * @returns {Promise<{ loggedIn: boolean }>}
 */
export async function openScene(page, url, state, { creds, loginCfg, savedSession = false }) {
  await navigate(page, url, state);
  let loggedIn = false;
  if (await looksLikeVerification(page)) throw E.verification(state.sceneId, pathOf(page.url()));
  const wanted = pathOf(url), got = pathOf(page.url());
  if (wanted.split('?')[0] !== got.split('?')[0] && (await looksLikeLogin(page))) {
    if (!creds) throw savedSession ? E.sessionExpired(state.sceneId, wanted, got.split('?')[0]) : E.loginWall(state.sceneId, wanted, got.split('?')[0]);
    state.creds = creds;
    await signIn(page, state, loginCfg);
    loggedIn = true;
    if (pathOf(page.url()).split('?')[0] !== wanted.split('?')[0]) await navigate(page, url, state);
    if (await looksLikeLogin(page)) throw E.loginFailed(state.sceneId, pathOf(page.url()));
  }
  return { loggedIn };
}

export { PushreelError, pathOf };
