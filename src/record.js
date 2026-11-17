// Pass 2, Record. Fixed code, no model: replays exactly the steps of shotlist.json.
import { writeFile } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newContext, runStep, openScene, settle, signIn, looksLikeLogin, looksLikeVerification, abs, pathOf, readLogin, redirectedTo, leftThePage, captureLayout, runPrepare } from './browser.js';
import { readSaved, sessionKey, usableSession, saveSession, parsePrepare, otherOrigin, laneOf } from './session.js';
import { sceneHash } from './shotlist.js';
import { FRAME } from './presets.js';
import { E, PushreelError } from './errors.js';
import { ensureDir, readJson, writeJson, run, round, sleep, paths } from './util.js';

export const MAX_TRIES = 3; // first try plus 2 retries, waits doubled each time

/** Captures the page as numbered JPEG frames with timestamps (CDP screencast: one frame per painted frame). */
class Capture {
  constructor(page, cdp, dir) { this.page = page; this.cdp = cdp; this.dir = dir; this.frames = []; this.writes = []; this.t0 = null; this.on = false; }
  async start() {
    ensureDir(this.dir);
    this.handler = (f) => {
      if (!this.on) return;
      const ts = f.metadata.timestamp, i = this.frames.length;
      if (this.t0 === null) this.t0 = ts;
      const file = join(this.dir, `f${String(i).padStart(6, '0')}.jpg`);
      this.frames.push({ t: ts - this.t0, file });
      this.writes.push(writeFile(file, Buffer.from(f.data, 'base64')));
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    };
    this.cdp.on('Page.screencastFrame', this.handler);
    this.on = true;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1, maxWidth: FRAME.width, maxHeight: FRAME.height });
    // The screencast sends a frame only when something is painted. Nudge one paint so that t0 is "now".
    for (let i = 0; i < 12 && this.t0 === null; i++) {
      await this.page.evaluate(() => new Promise((r) => { const c = document.getElementById('__pushreel_cursor') || document.documentElement; c.style.opacity = c.style.opacity === '0.999' ? '1' : '0.999'; requestAnimationFrame(() => r()); })).catch(() => {});
      await sleep(50);
    }
    if (this.t0 === null) throw new Error('The browser produced no picture for this page.');
  }
  now() { return Date.now() / 1000 - this.t0; }
  async stop() {
    const end = this.now();
    this.on = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    this.cdp.off('Page.screencastFrame', this.handler);
    await Promise.all(this.writes);
    return end;
  }
}

/** Turns the timestamped frames into a constant 30 fps clip. Each frame is shown until the next one arrives. */
async function encodeFrames(frames, duration, out, listFile) {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : duration;
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, next - f.t).toFixed(6)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  await writeFile(listFile, lines.join('\n') + '\n');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${FRAME.fps},scale=${FRAME.width}:${FRAME.height}:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,setsar=1`,
    '-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '15',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an', out]);
}

/**
 * Records one scene once, in a new page of the run's browser context.
 * Throws a PushreelError on failure (with .screenshot set when a picture was saved).
 * @returns {Promise<object>} the events of the recording
 */
async function recordOnce(ctx, vp, shotlist, scene, ctxState, opts) {
  const { baseUrl, attempt, dirs } = opts;
  // A scene that is not marked "requiresLogin" is recorded as a visitor: it never signs in, with nothing.
  const creds = scene.requiresLogin ? opts.creds : null, canSignIn = !scene.requiresLogin && !!(opts.creds || opts.hasAuth);
  const mult = 2 ** (attempt - 1);
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000 * mult);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const frameDir = join(dirs.raw, `scene-${scene.id}.frames`);
  rmSync(frameDir, { recursive: true, force: true });
  const state = { vp, mult, baseUrl, sceneId: scene.id, attempt, creds: null, mouse: null, scrollSpeed: (shotlist.motion && shotlist.motion.scrollSpeed) || 1, events: { segments: [], clicks: [], scrolls: [] }, now: () => 0 };
  let cap = null;
  try {
    const url = abs(baseUrl, scene.url);
    if (scene.requiresLogin && !ctxState.signedIn && creds) { // without an account the scene is opened anyway, so the screenshot shows the login wall
      if (shotlist.login && shotlist.login.url) { state.creds = creds; await signIn(page, state, shotlist.login); ctxState.signedIn = true; }
    }
    let loggedIn = false;
    try { ({ loggedIn } = await openScene(page, url, state, { creds, loginCfg: shotlist.login, savedSession: ctxState.auth })); }
    catch (e) { if (e instanceof PushreelError && e.code === 'login_wall' && canSignIn) throw E.notMarked(scene.id, pathOf(url), e.sawTo || pathOf(page.url()).split('?')[0]); throw e; }
    if (loggedIn) ctxState.signedIn = true;
    state.creds = null;
    // The app answered with another page. An app without a login form (OAuth, magic link) sends guests to its
    // start page: for a scene behind the login that is the login wall.
    const movedTo = redirectedTo(url, page.url());
    if (movedTo && scene.requiresLogin && !ctxState.signedIn) {
      if (ctxState.auth && leftThePage(url, movedTo)) throw E.sessionExpired(scene.id, pathOf(url), movedTo);
      if (!ctxState.auth && !creds) throw E.loginWall(scene.id, pathOf(url), movedTo);
    }
    await settle(page);
    // park the cursor at its start position so the first move is drawn from there
    const start = state.mouse || { x: vp.width * 0.52, y: vp.height * 0.84 };
    await page.mouse.move(start.x, start.y); state.mouse = start;
    // the arrow appears with the first move of the scene, so the opening picture (and the cover) has none
    await page.evaluate(() => { if (window.__pushreelHideCursor) window.__pushreelHideCursor(); }).catch(() => {});

    const cdp = await ctx.newCDPSession(page);
    cap = new Capture(page, cdp, frameDir);
    await cap.start();
    state.now = () => cap.now();
    // What the page shows (large headings, fixed bars), at the start and after every step that can change it.
    const layout = [{ t: 0, ...(await captureLayout(page)) }];
    let lastActionEnd = 0;
    for (let i = 0; i < scene.steps.length; i++) {
      await runStep(page, scene.steps[i], state, i);
      if (!['wait', 'waitFor', 'hold'].includes(scene.steps[i].do)) { lastActionEnd = cap.now(); layout.push({ t: round(cap.now()), ...(await captureLayout(page)) }); }
    }
    const stepsEnd = cap.now();
    if (await looksLikeVerification(page)) throw E.verification(scene.id, pathOf(page.url()));
    if (!creds && !ctxState.signedIn && (await looksLikeLogin(page)) && !/login|sign/i.test(scene.url)) {
      const to = pathOf(page.url()).split('?')[0];
      throw ctxState.auth ? E.sessionExpired(scene.id, pathOf(url), to) : canSignIn ? E.notMarked(scene.id, pathOf(url), to) : E.loginWall(scene.id, pathOf(url), to);
    }
    // Fill the scene up to its length. Waits that the cut will shorten do not count.
    const thr = shotlist.cut.removeWaitsOver;
    const cutAway = () => state.events.segments.reduce((n, s) => n + (thr > 0 && s.end - s.start > thr + 0.05 ? s.end - s.start - thr : 0), 0);
    const remaining = scene.duration + 0.25 - (cap.now() - cutAway());
    if (remaining > 0) await sleep(remaining * 1000);
    const duration = await cap.stop();
    const finalUrl = page.url();
    await cdp.detach().catch(() => {});
    await page.close();

    const out = join(dirs.raw, `scene-${scene.id}.mp4`);
    await encodeFrames(cap.frames, duration, out, join(frameDir, 'frames.ffconcat'));
    const lastPaint = cap.frames.length ? cap.frames[cap.frames.length - 1].t : 0;
    rmSync(frameDir, { recursive: true, force: true });
    const ev = {
      scene: scene.id, hash: sceneHash(shotlist, scene), file: `scene-${scene.id}.mp4`, duration: round(duration), frames: cap.frames.length,
      segments: state.events.segments.map((s) => ({ type: s.type, start: round(s.start), end: round(s.end), step: s.step })).filter((s) => s.end - s.start > 0.02),
      clicks: state.events.clicks.map((c) => ({ ...c, t: round(c.t), x: round(c.x, 4), y: round(c.y, 4), w: round(c.w, 4), h: round(c.h, 4) })),
      scrolls: state.events.scrolls.map((s) => ({ ...s, t: round(s.t), end: round(s.end) })),
      lastActionEnd: round(lastActionEnd), stepsEnd: round(stepsEnd), lastPaint: round(lastPaint), layout,
      attempt, ...(movedTo ? { redirectedTo: movedTo } : {}), recordedAt: new Date().toISOString(), finalUrl: pathOf(finalUrl), consoleErrors: consoleErrors.slice(0, 10),
    };
    writeJson(join(dirs.raw, `scene-${scene.id}.json`), ev);
    return ev;
  } catch (e) {
    if (cap && cap.on) await cap.stop().catch(() => {});
    const shot = join(ensureDir(dirs.failed), `scene-${scene.id}.png`);
    await page.screenshot({ path: shot }).then(() => { e.screenshot = shot; e.sawUrl = pathOf(page.url()); }).catch(() => {});
    await page.close().catch(() => {});
    rmSync(frameDir, { recursive: true, force: true });
    if (e instanceof PushreelError) throw e;
    if (/Timeout/i.test(String(e.message))) { const t = E.timeout(scene.id, 'A step'); t.screenshot = e.screenshot; t.sawUrl = e.sawUrl; throw t; }
    if (/Target (page|closed)|browser has been closed|ERR_CONNECTION/i.test(String(e.message))) { const t = E.appDown(scene.id, baseUrl); t.screenshot = e.screenshot; throw t; }
    throw e;
  }
}

/** A recorded clip can be reused when its fingerprint still matches the scene in the shot list. */
export function recorded(dirs, shotlist, scene) {
  const ev = readJson(join(dirs.raw, `scene-${scene.id}.json`));
  return ev && ev.hash === sceneHash(shotlist, scene) && existsSync(join(dirs.raw, ev.file)) ? ev : null;
}

/**
 * Records the given scenes in order. The browser session carries on from scene to scene instead of starting fresh,
 * so a consent banner or a login appears once, not per scene.
 *
 * There are two lanes, each one browser context for the whole run (src/session.js, laneOf):
 *   "user"   scenes with "requiresLogin": starts from the saved login (.pushreel/auth.json, from `pushreel login`)
 *   "guest"  every other scene: a visitor who is not signed in. A landing page would send a signed-in user away.
 * A lane is opened when its first scene comes up: the shot list's `prepare` steps run in it, unrecorded, and its
 * state is saved to .pushreel/session.json. After every recorded scene the lane's state is saved again. A retry,
 * a resume and a single re-recorded scene start from the last saved state, so a half-finished attempt leaves
 * nothing behind in the browser.
 *
 * A failing scene is retried up to 2 times with all waits doubled (0 tokens).
 * Stops at the first scene that still fails; scenes recorded before stay on disk.
 * @param {object} o { projectDir, shotlist, scenes, baseUrl, dirs, onEvent, shouldStop }
 * @returns {Promise<{ done: object[], failed: null | { scene, error } }>}
 */
export async function recordScenes(o) {
  const { shotlist, scenes, baseUrl, dirs, onEvent = () => {}, shouldStop = () => false } = o;
  ensureDir(dirs.raw);
  const p = paths(o.projectDir);
  const creds = readLogin(o.projectDir);
  const auth = readSaved(p.auth), prepare = parsePrepare(shotlist.prepare);
  const key = sessionKey({ prepare, authSavedAt: auth ? auth.savedAt : null, baseUrl });
  const kept = usableSession(p.session, key);
  const { browser, vp } = await launch(shotlist.viewport.width);
  const m = shotlist.motion || {};
  const ctxOpts = { cursor: shotlist.cursor, cursorKind: m.cursor, clickColor: m.clickColor, colorScheme: shotlist.colorScheme || 'light' };
  const lanes = {}; // lane name → { ctx, state: { storage, auth, signedIn, savedSignedIn } }
  const done = [];
  const save = async (name) => { const l = lanes[name]; l.state.storage = await l.ctx.storageState(); l.state.savedSignedIn = l.state.signedIn; saveSession(p.session, name, l.state.storage, { baseUrl, key, signedIn: l.state.signedIn }); };
  const reopen = async (name) => { const l = lanes[name]; if (l.ctx) await l.ctx.close().catch(() => {}); l.ctx = await newContext(browser, vp, { ...ctxOpts, storageState: l.state.storage }); };
  /** Opens a lane on first use: from session.json, or from the saved login (user lane) plus `prepare`. */
  const open = async (name) => {
    if (lanes[name]) return null;
    const useAuth = name === 'user' && !!auth, l = lanes[name] = { ctx: null, state: { storage: null, auth: useAuth, signedIn: false, savedSignedIn: false } };
    if (useAuth) onEvent({ type: 'session', message: `Scenes behind the login use the saved login from .pushreel/auth.json${auth.savedAt ? ` (saved ${localTime(auth.savedAt)})` : ''}.${otherOrigin(auth, baseUrl) ? ` It was saved for ${auth.origin}, the app runs at ${baseUrl}: cookies of another address are not sent. If scenes behind the login fail, run "pushreel login ${baseUrl}".` : ''}` });
    if (kept[name]) {
      l.state.storage = kept[name].storageState; l.state.signedIn = l.state.savedSignedIn = kept[name].signedIn;
      await reopen(name);
      if (prepare) onEvent({ type: 'prepare', message: `Prepare (${laneLabel(name)}): already done for this shot list (.pushreel/session.json), not repeated.` });
      return null;
    }
    l.state.storage = useAuth ? auth.storageState : null;
    await reopen(name);
    if (prepare) {
      const page = await l.ctx.newPage();
      try {
        const r = await runPrepare(page, prepare, { vp, mult: 1, baseUrl, attempt: 1, creds: null, mouse: null });
        onEvent({ type: 'prepare', message: `Prepare (${laneLabel(name)}): ${r.done} of ${prepare.steps.length} ${prepare.steps.length === 1 ? 'step' : 'steps'} done before recording (not in the video)${r.skipped.length ? `; ${r.skipped.join('; ')}` : ''}.` });
      } catch (e) {
        const shot = join(ensureDir(dirs.failed), 'prepare.png');
        await page.screenshot({ path: shot }).then(() => { e.screenshot = shot; }).catch(() => {});
        if (e instanceof PushreelError) { e.title = `Prepare failed: ${e.title.replace(/^Scene prepare /, '')}`; e.scene = null; }
        return e;
      } finally { await page.close().catch(() => {}); }
    }
    await save(name);
    return null;
  };
  try {
    for (const scene of scenes) {
      if (shouldStop()) return { done, failed: { scene, error: E.stopped() } };
      const name = laneOf(scene);
      const failedPrepare = await open(name);
      if (failedPrepare) return { done, failed: { scene, error: failedPrepare, prepare: true } };
      const lane = lanes[name];
      let lastError = null;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        onEvent({ type: 'scene-start', scene: scene.id, attempt, url: scene.url });
        try {
          const ev = await recordOnce(lane.ctx, vp, shotlist, scene, lane.state, { baseUrl, attempt, dirs, creds, hasAuth: !!auth });
          rmSync(join(dirs.failed, `scene-${scene.id}.png`), { force: true });
          await save(name);
          onEvent({ type: 'scene-done', scene: scene.id, attempt, url: scene.url, duration: ev.duration, clicks: ev.clicks.length, redirectedTo: ev.redirectedTo, lane: name });
          done.push(ev); lastError = null; break;
        } catch (e) {
          lastError = e;
          // throw away whatever the failed attempt left in the browser: back to the last saved state
          await reopen(name).catch(() => {});
          lane.state.signedIn = lane.state.savedSignedIn; // a login made with PUSHREEL_LOGIN in the failed attempt is gone with its context
          const retry = e instanceof PushreelError && e.retryable && attempt < MAX_TRIES && !shouldStop();
          if (!retry) break;
          onEvent({ type: 'scene-retry', scene: scene.id, attempt: attempt + 1, of: MAX_TRIES, url: scene.url, reason: e.code,
            message: `Scene ${scene.id} ${e.code === 'timeout' ? 'timed out' : e.code === 'element_not_found' ? 'timed out waiting for ' + e.title.replace(/^Scene \d+ could not find /, '') : 'failed (' + e.title.replace(/^Scene \d+ /, '') + ')'}. Retrying with double the wait (fixed code, 0 tokens), try ${attempt + 1} of ${MAX_TRIES}` });
        }
      }
      if (lastError) {
        if (lastError instanceof PushreelError && lastError.code === 'element_not_found') lastError.text = lastError.text.replace(/after \d+ tr(y|ies)/, `after ${MAX_TRIES} tries`);
        return { done, failed: { scene, error: lastError } };
      }
    }
    return { done, failed: null };
  } finally {
    await browser.close().catch(() => {});
  }
}
const laneLabel = (name) => (name === 'user' ? 'signed in' : 'as a visitor');
/** An ISO time as local date and time, for messages. */
export const localTime = (iso) => { const d = new Date(iso); const z = (n) => String(n).padStart(2, '0'); return Number.isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
