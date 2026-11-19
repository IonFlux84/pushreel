// `pushreel login`: a saved browser session for apps without a password form (OAuth, magic links, SSO).
//
// Interactive: a VISIBLE browser window opens on the app, the user signs in by hand, and when they press Enter in
// the terminal or close the window, the browser's storage state (cookies, localStorage) is saved to
// .pushreel/auth.json. Every later explore and record run starts from it.
// Scripted (`--script steps.json`), for CI and tests: the same result from login steps run headlessly.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { launch, newContext, runStep, navigate, settle, abs, pathOf, looksLikeLogin, redirectedTo, leftThePage, NAV_TIMEOUT } from './browser.js';
import { paths, ensureDir, writeJson, readJson, sleep } from './util.js';
import { checkTarget } from './origin.js';
import { E, PushreelError } from './errors.js';
import { wrapState, describeState, parseLoginScript, gitignoreAdvice, removeSaved, KIND_AUTH } from './session.js';
import { stepProblem } from './shotlist.js';
import { localTime } from './record.js';

/** What the user is told after a session was saved. Pure apart from reading .gitignore. */
export function savedMessage(dir, saved, { how }) {
  const d = describeState(saved), lines = [];
  lines.push(`✓ Session saved to .pushreel/auth.json (${d.cookies} ${d.cookies === 1 ? 'cookie' : 'cookies'}${d.hosts.length ? ` for ${d.hosts.join(', ')}` : ''}${d.storageOrigins ? `, local storage of ${d.storageOrigins} ${d.storageOrigins === 1 ? 'origin' : 'origins'}` : ''}).`);
  if (!d.cookies && !d.storageOrigins) lines.push('  ! The browser held no cookie and no local storage. If you did not sign in, run the command again.');
  lines.push('  Explore and record runs load it from now on: scenes behind the login open signed in.');
  lines.push('  The file contains session cookies. Anyone who has it is signed in as this user: do not commit it, do not share it.');
  const advice = gitignoreAdvice(dir);
  lines.push(advice ? `  ! ${advice}` : '  .pushreel/ is already ignored by Git here.');
  lines.push('  Remove it with: pushreel logout   (in Claude Code: /pushreel logout)');
  lines.push(d.nextExpiry ? `  The first cookie runs out on ${localTime(d.nextExpiry)}. When the app signs you out, Pushreel says "Your saved session has expired" and you run the login again.` : '  When the app signs you out, Pushreel says "Your saved session has expired" and you run the login again.');
  if (how === 'script') lines.push('  Made by a login script (--script): meant for CI and tests, where nobody can sign in by hand.');
  return lines.join('\n');
}

/**
 * Opens a visible browser and waits until the user confirms.
 * @param {string} dir
 * @param {{ baseUrl: string, url?: string, say?: Function, timeoutMs?: number, input?: NodeJS.ReadableStream }} o
 */
export async function loginInteractive(dir, o) {
  const p = paths(dir), say = o.say || (() => {});
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { throw E.browserMissing(); }
  let browser;
  try { browser = await chromium.launch({ headless: false }); } catch (e) {
    if (/Executable doesn't exist|playwright install/i.test(String(e.message))) throw E.browserMissing();
    throw new PushreelError('no_window', { title: 'Pushreel could not open a browser window', text: `A visible window is needed so you can sign in by hand (${String(e.message).split('\n')[0]}). On a machine without a screen, use a login script: pushreel login --script steps.json (see docs/LOGIN.md).`, next: ['pushreel login --script steps.json'] });
  }
  const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, storageState: (readJson(p.auth) || {}).storageState || undefined });
  const page = await ctx.newPage();
  const target = abs(o.baseUrl, o.url || '/');
  checkTarget(target, o.baseUrl, { allowRemote: !!o.allowRemote });
  await page.goto(target, { waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(() => {});
  const tty = !!(o.input && o.input.isTTY);
  say(`A browser window is open at ${target}.`);
  say('Sign in there the way you always do (Google, GitHub, a magic link, a password: anything works).');
  say(tty ? 'When you are signed in, press Enter here, or close the window.' : 'When you are signed in, close the window.');
  say('Pushreel does not see or store what you type. It saves the cookies and local storage of that window, nothing else.');

  // The state is read again and again while the window is open: when the user closes it, the last reading is saved.
  let latest = await ctx.storageState().catch(() => null), open = true, why = 'closed';
  const poll = (async () => { while (open) { await sleep(700); const s = await ctx.storageState().catch(() => null); if (s) latest = s; else break; } })();
  // Also read it after every page load: a user who closes the window right after the app signed them in (within
  // the 700 ms of the poll) must not lose the login, also where closing the last window quits the browser.
  const refresh = () => { ctx.storageState().then((s) => { if (s && open) latest = s; }).catch(() => {}); };
  const watch = (pg) => pg.on('load', refresh);
  ctx.pages().forEach(watch); ctx.on('page', watch);
  await new Promise((done) => {
    const finish = (reason) => { if (!open) return; open = false; why = reason; done(); };
    browser.on('disconnected', () => finish('closed'));
    ctx.on('close', () => finish('closed'));
    page.on('close', () => { if (!ctx.pages().length) finish('closed'); });
    if (o.input) { o.input.on('data', (d) => { if (/\n|\r/.test(String(d))) finish('enter'); }); if (o.input.resume) o.input.resume(); }
    setTimeout(() => finish('timeout'), o.timeoutMs || 9.5 * 60 * 1000).unref();
  });
  // Read once more: after Enter, and also after the window was closed (on macOS the browser and the context live on
  // without a window). Where the browser is gone, the last reading stands.
  { const s = await ctx.storageState().catch(() => null); if (s) latest = s; }
  await poll.catch(() => {});
  await browser.close().catch(() => {});
  if (o.input && o.input.pause) o.input.pause();
  if (!latest) throw new PushreelError('login_not_saved', { title: 'The session could not be read', text: 'The browser window closed before Pushreel could read its cookies. Run the command again and wait a second after signing in.', next: ['pushreel login'] });
  const saved = wrapState(latest, { kind: KIND_AUTH, baseUrl: o.baseUrl, how: 'by hand' });
  ensureDir(p.state); writeJson(p.auth, saved, { secret: true });
  removeDerived(p);
  return { saved, why };
}

/**
 * Runs login steps headlessly and saves the state. For CI and tests.
 * Script: a list of steps or { url, steps, expect }. `expect` is a page behind the login: after the steps it must
 * open without sending the browser away, otherwise nothing is saved.
 * One extra step exists only here: { "do": "post", "url": "/auth/dev", "form": { … } } sends a form the way the
 * app's own page would (same origin, with its CSRF token), for local dev logins that have no button.
 */
export async function loginScript(dir, o) {
  const p = paths(dir);
  const raw = readJson(o.scriptFile);
  if (raw === null) throw E.invalidShotlist([`${o.scriptFile} is not there or is not valid JSON.`]);
  let script;
  try { script = parseLoginScript(raw); } catch (e) { throw E.invalidShotlist([e.message]); }
  const problems = script.steps.map((st, i) => { const pr = st && st.do === 'post' ? postProblem(st) : stepProblem(st); return pr ? `login script, step ${i + 1}: ${pr}` : null; }).filter(Boolean);
  if (problems.length) throw E.invalidShotlist(problems);

  const { browser, vp } = await launch(360);
  try {
    const ctx = await newContext(browser, vp, { cursor: false });
    const page = await ctx.newPage();
    const state = { vp, mult: 1, baseUrl: o.baseUrl, allowRemote: !!o.allowRemote, sceneId: 'login', attempt: 1, creds: null, mouse: null, events: { segments: [], clicks: [] }, now: () => 0 };
    try {
      await navigate(page, abs(o.baseUrl, o.url || script.url), state);
      await settle(page, 200);
      for (let i = 0; i < script.steps.length; i++) {
        const st = script.steps[i];
        if (st.do === 'post') { checkTarget(abs(o.baseUrl, st.url), o.baseUrl, { allowRemote: !!o.allowRemote, what: 'The login script\'s "post" address' }); }
        if (st.do === 'post') await postForm(page, abs(o.baseUrl, st.url), st.form || {});
        else await runStep(page, st, state, i);
      }
      await page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {});
      await sleep(300);
      if (script.expect) {
        const want = abs(o.baseUrl, script.expect);
        await navigate(page, want, state);
        const moved = redirectedTo(want, page.url());
        if ((moved && leftThePage(want, moved)) || (await looksLikeLogin(page))) throw new PushreelError('login_failed', { title: 'The login script ran, but the app is not signed in', text: `After the steps, ${pathOf(want)} sent the browser to ${moved || pathOf(page.url())}. Nothing was saved.`, next: ['Check the steps in the script, then run it again'] });
      }
    } catch (e) {
      const shot = join(ensureDir(p.failed), 'login.png');
      await page.screenshot({ path: shot }).catch(() => {});
      if (e instanceof PushreelError) { e.title = e.title.replace(/^Scene login /, 'The login script '); e.scene = null; e.saved = `Screenshot of what the browser saw: ./.pushreel/run/failed/login.png`; e.next = ['Fix the script, then: pushreel login --script <file>']; }
      throw e;
    }
    const saved = wrapState(await ctx.storageState(), { kind: KIND_AUTH, baseUrl: o.baseUrl, how: 'script' });
    ensureDir(p.state); writeJson(p.auth, saved, { secret: true });
    removeDerived(p);
    await ctx.close();
    return { saved, why: 'script' };
  } finally { await browser.close().catch(() => {}); }
}

/** session.json and the explore session were built on the old login: they are rebuilt on the next run. */
function removeDerived(p) { for (const f of [p.session, p.exploreSession]) rmSync(f, { force: true }); }

function postProblem(st) {
  if (typeof st.url !== 'string' || !/^(\/|https?:\/\/)/.test(st.url)) return '"post" needs "url", e.g. "/auth/dev".';
  if (st.form !== undefined && (typeof st.form !== 'object' || st.form === null || Array.isArray(st.form))) return '"post" takes "form": an object of field names and values.';
  return null;
}

/** Sends a form from inside the page (same origin, cookies included), with the CSRF token the page carries. */
async function postForm(page, url, form) {
  const r = await page.evaluate(async ({ url, form }) => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const xsrf = (document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) || '').split('=').slice(1).join('=');
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html, application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (meta) headers['X-CSRF-TOKEN'] = meta.getAttribute('content');
    if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
    const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(form).toString(), credentials: 'same-origin', redirect: 'follow' });
    return { status: res.status, url: res.url };
  }, { url, form }).catch((e) => ({ status: 0, error: String(e.message) }));
  if (!r.status || r.status >= 400) throw new PushreelError('login_failed', { title: 'The login script could not send its form', text: `POST ${pathOf(url)} answered ${r.status || r.error}. Nothing was saved.`, next: ['Check the address and the fields in the script'] });
}

/** `pushreel logout`. */
export function logout(dir) { return removeSaved(paths(dir)); }
