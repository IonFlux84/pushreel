// shotlist.json: the contract between the model (which writes it) and the fixed code (which replays it).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PLATFORMS, PLATFORM_KEYS, VIEWPORTS, END_CARD_SECONDS } from './presets.js';
import { readJson, slugify, paths } from './util.js';
import { E } from './errors.js';
import { parsePrepare } from './session.js';
import { estimateEnds, trimTail, STILL_TAIL } from './motion.js';
import { resolveStyle, applyStyle } from './style.js';
import { resolveTemplate, checkRules } from './template.js';
import { originProblems, isAbsolute, isLocalUrl, sameOrigin, originOf } from './origin.js';

export const STEP_KINDS = ['click', 'type', 'press', 'hover', 'scroll', 'goto', 'wait', 'waitFor', 'hold'];
export const DEFAULT_CUT = { zoom: 1.4, removeWaitsOver: 0.6, captions: true, endCard: true, trimStillTails: STILL_TAIL };
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const LIMITS = { minScene: 2, maxScene: 30, maxScenes: 12, maxSteps: 40 };

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Fills defaults. Does not validate. Returns a new object. */
export function normalize(raw) {
  const s = JSON.parse(JSON.stringify(raw || {}));
  s.version = s.version || 1;
  s.app = s.app || {};
  if (isStr(s.app.name) && !isStr(s.app.slug)) s.app.slug = slugify(s.app.name);
  s.viewport = { width: 360, ...(s.viewport || {}) };
  s.targets = Array.isArray(s.targets) ? s.targets : [...PLATFORM_KEYS];
  s.cut = { ...DEFAULT_CUT, ...(s.cut || {}) };
  if (s.cut.zoom === true) s.cut.zoom = DEFAULT_CUT.zoom;
  if (s.cut.zoom === false || s.cut.zoom === 0) s.cut.zoom = 1;
  if (s.cut.removeWaitsOver === false) s.cut.removeWaitsOver = 0;
  if (s.cut.trimStillTails === true) s.cut.trimStillTails = STILL_TAIL;
  if (s.cut.trimStillTails === false) s.cut.trimStillTails = 0;
  s.cursor = s.cursor !== false;
  s.scenes = (Array.isArray(s.scenes) ? s.scenes : []).map((sc, i) => ({
    id: i + 1, title: `Scene ${i + 1}`, duration: 6, caption: '', include: true, requiresLogin: false, steps: [], ...sc,
  }));
  return s;
}

/**
 * Checks a shot list. Returns { errors: string[], warnings: string[], info: string[] }.
 * Errors block recording. Warnings are shown and do not block; each one asks for a change.
 * Info lines need no action (for example still picture that the cut trims by itself).
 */
export function validate(raw, ctx = {}) {
  const errors = [], warnings = [], info = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['The file must contain one JSON object.'], warnings, info };
  const s = normalize(raw);
  // The style decides the lengths of the end card and the intro (src/style.js); without one, 2 s and none.
  if (ctx.cut) Object.assign(s.cut, ctx.cut);
  if (s.version !== 1) errors.push(`"version" is ${s.version}. This Pushreel reads version 1.`);
  if (!isStr(s.app.name)) errors.push('"app.name" is missing. It is shown on the end card and used for file names.');
  if (s.app.slug && !SLUG.test(s.app.slug)) errors.push('"app.slug" may contain a-z, 0-9 and single hyphens between them (e.g. "tiny-wins"). It becomes the file name, e.g. tiny-wins-short.mp4.');
  if (s.baseUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(String(s.baseUrl))) errors.push('"baseUrl" must start with http:// or https://.');
  if (!VIEWPORTS[s.viewport.width]) errors.push(`"viewport.width" must be one of ${Object.keys(VIEWPORTS).join(', ')} (CSS pixels; the recording is always 1080×1920).`);
  if (!s.targets.length) errors.push('"targets" is empty. Turn on at least one of short, reel, tiktok.');
  for (const t of s.targets) if (!PLATFORMS[t]) errors.push(`"targets" contains "${t}". Known targets: ${PLATFORM_KEYS.join(', ')}.`);
  if (!isNum(s.cut.zoom) || s.cut.zoom < 1 || s.cut.zoom > 2.5) errors.push('"cut.zoom" must be a number from 1 (off) to 2.5. The default is 1.4.');
  if (!isNum(s.cut.removeWaitsOver) || s.cut.removeWaitsOver < 0 || s.cut.removeWaitsOver > 10) errors.push('"cut.removeWaitsOver" must be seconds from 0 (keep all waits) to 10. The default is 0.6.');

  if (!isNum(s.cut.trimStillTails) || s.cut.trimStillTails < 0 || s.cut.trimStillTails > 30) errors.push('"cut.trimStillTails" must be seconds from 0 (or false: keep every scene at its full length) to 30. The default is 2: at most 2 s of still picture after a scene\'s last step.');
  if (s.prepare !== undefined) {
    const steps = Array.isArray(s.prepare) ? s.prepare : s.prepare && s.prepare.steps;
    if (!Array.isArray(steps)) errors.push('"prepare" must be a list of steps, or {"url": "/", "steps": [ … ]}. It runs before the recording and is never in the video.');
    else {
      if (steps.length > LIMITS.maxSteps) errors.push(`"prepare" has ${steps.length} steps. The limit is ${LIMITS.maxSteps}.`);
      steps.forEach((st, j) => { const p = stepProblem(st); if (p) errors.push(`prepare, step ${j + 1}: ${p}`); });
      if (!Array.isArray(s.prepare) && s.prepare.url !== undefined && !(isStr(s.prepare.url) && /^(\/|https?:\/\/)/.test(s.prepare.url))) errors.push('"prepare.url" must start with "/" or with http(s)://.');
    }
  }
  if (!s.scenes.length) errors.push('"scenes" is empty. A shot list needs at least one scene.');
  if (s.scenes.length > LIMITS.maxScenes) errors.push(`There are ${s.scenes.length} scenes. The limit is ${LIMITS.maxScenes}.`);
  const ids = new Set();
  s.scenes.forEach((sc, i) => {
    const at = `Scene ${i + 1}`;
    if (!Number.isInteger(sc.id) || sc.id < 1) errors.push(`${at}: "id" must be a whole number from 1.`);
    else if (ids.has(sc.id)) errors.push(`${at}: "id" ${sc.id} is used twice.`);
    ids.add(sc.id);
    if (!isStr(sc.url)) errors.push(`${at}: "url" is missing, e.g. "/today".`);
    else if (!/^(\/|https?:\/\/)/.test(sc.url)) errors.push(`${at}: "url" must start with "/" or with http(s)://.`);
    if (!isNum(sc.duration) || sc.duration < LIMITS.minScene || sc.duration > LIMITS.maxScene) errors.push(`${at}: "duration" must be ${LIMITS.minScene} to ${LIMITS.maxScene} seconds.`);
    if (typeof sc.caption !== 'string') errors.push(`${at}: "caption" must be text (it may be empty).`);
    if (sc.slot !== undefined && sc.slot !== null && typeof sc.slot !== 'string') errors.push(`${at}: "slot" must be the name of a template slot, e.g. "hook".`);
    if (!Array.isArray(sc.steps)) { errors.push(`${at}: "steps" must be a list.`); return; }
    if (sc.steps.length > LIMITS.maxSteps) errors.push(`${at}: ${sc.steps.length} steps. The limit is ${LIMITS.maxSteps}.`);
    sc.steps.forEach((st, j) => { const p = stepProblem(st); if (p) errors.push(`${at}, step ${j + 1}: ${p}`); });
    if (sc.include && isNum(sc.duration) && isNum(s.cut.removeWaitsOver)) {
      // Still picture: from the last action (a click, a scroll, typing) to the end of the scene.
      const est = estimateEnds(sc.steps, s.cut), still = Math.round((sc.duration - est.lastAction) * 10) / 10, keep = s.cut.trimStillTails;
      const fit = trimTail(sc.duration, est.steps, STILL_TAIL, est.lastAction).length, cutTo = keep > 0 ? trimTail(sc.duration, est.steps, keep, est.lastAction) : { trimmed: 0 };
      // With trimming on (the default) this is information, not a task: the cut fixes it, and an agent that "fixes" it
      // anyway spends turns for nothing (7 of 15 turns in the second DartStack field test).
      if (still > STILL_TAIL + 1 && fit < sc.duration) {
        if (cutTo.trimmed > 0) info.push(`${at}: about ${still} s of still picture at its end (the last action ends after about ${est.lastAction} s). Trimmed automatically by the cut: the scene runs about ${cutTo.length} s. Nothing to change.`);
        else warnings.push(`${at}: about ${still} s of still picture at its end (the last action ends after about ${est.lastAction} s, the duration is ${sc.duration} s). The viewer watches a frozen page, because "cut.trimStillTails" is off. Add a step, or set "duration" to about ${fit}.`);
      }
    }
    if (sc.include) {
      for (const t of s.targets) {
        const P = PLATFORMS[t]; if (!P) continue;
        if (sc.caption.length > P.caption.softChars) warnings.push(`${at}: the caption has ${sc.caption.length} characters. Over ${P.caption.softChars} it gets small on ${P.name}.`);
      }
    }
  });

  if (s.login !== undefined) {
    if (!s.login || typeof s.login !== 'object') errors.push('"login" must be an object with "url" and optional "steps".');
    else {
      if (!isStr(s.login.url)) errors.push('"login.url" is missing, e.g. "/login".');
      else if (!/^(\/|https?:\/\/)/.test(s.login.url)) errors.push('"login.url" must start with "/" (a page of the app, e.g. "/login") or with http(s)://.');
      else if (isAbsolute(s.login.url)) {
        // The test account is typed into this page: it must be a page of the app itself.
        const base = isAbsolute(s.baseUrl) ? s.baseUrl : null;
        if (base ? !sameOrigin(s.login.url, base) : !(ctx.allowRemote || isLocalUrl(s.login.url))) errors.push(`"login.url" is ${s.login.url}, which is not on ${base ? `the app's origin (${originOf(base)})` : 'this machine'}. Pushreel types PUSHREEL_LOGIN only into pages of the app: use a path like "/login". For a login on another host, the user runs "pushreel login" once and signs in by hand.`);
      }
      if (s.login.steps !== undefined) {
        if (!Array.isArray(s.login.steps)) errors.push('"login.steps" must be a list.');
        else s.login.steps.forEach((st, j) => { const p = stepProblem(st); if (p) errors.push(`login, step ${j + 1}: ${p}`); });
        if (JSON.stringify(s.login.steps || []).match(/"(text|value)":\s*"(?!\{\{)[^"]*@[^"]*"/)) warnings.push('"login.steps" seems to contain a real email address. Use {{email}} and {{password}}; the values come from PUSHREEL_LOGIN at run time.');
      }
    }
  }
  if (s.cover !== undefined) {
    if (s.cover.scene !== undefined && !s.scenes.some((sc) => sc.id === s.cover.scene)) errors.push(`"cover.scene" is ${s.cover.scene}. There is no scene with that id.`);
    if (s.cover.headline !== undefined && typeof s.cover.headline !== 'string') errors.push('"cover.headline" must be text.');
    if (s.cover.at !== undefined && !(s.cover.at === 'start' || s.cover.at === 'end' || (isNum(s.cover.at) && s.cover.at >= 0 && s.cover.at <= LIMITS.maxScene))) errors.push('"cover.at" must be "start" (the settled page before the first click, the default), "end", or seconds into the cover scene.');
  }
  if (s.posts !== undefined) {
    for (const [k, post] of Object.entries(s.posts || {})) {
      const P = PLATFORMS[k];
      if (!P) { warnings.push(`"posts.${k}" is not a known target and is ignored.`); continue; }
      for (const [field, max] of Object.entries(P.post.fields)) {
        const v = post && post[field];
        if (v !== undefined && typeof v !== 'string') errors.push(`"posts.${k}.${field}" must be text.`);
        else if (typeof v === 'string' && v.length > max) errors.push(`"posts.${k}.${field}" has ${v.length} characters. ${P.name} allows ${max}.`);
      }
      if (P.post.hashtags) {
        const n = (Object.values(post || {}).join(' ').match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
        if (n > P.post.hashtags) warnings.push(`"posts.${k}" uses ${n} hashtags. ${P.name} is reported to cap them at ${P.post.hashtags}.`);
      }
    }
  }

  errors.push(...originProblems(s, null, { allowRemote: !!ctx.allowRemote }));
  if (!errors.length) {
    const total = totalSeconds(s);
    const inc = s.scenes.filter((sc) => sc.include);
    if (!inc.length) errors.push('Every scene is switched off ("include": false). Include at least one scene.');
    for (const t of s.targets) {
      const P = PLATFORMS[t];
      if (total > P.maxSeconds) errors.push(`The video runs ${total} s. That is ${total - P.maxSeconds} s over the limit for ${P.name} (${P.maxSeconds} s). Shorten a scene or turn that target off.`);
    }
    if (total > 60) warnings.push(`This video runs ${total} s. The presets are tuned for 20 to 40 s. Longer works, and you may want to skip a scene.`);
    if (inc.length && !inc.some((sc) => sc.steps.some((st) => st.do === 'click'))) warnings.push('No included scene has a click. The video will show static pages without a zoom.');
  }
  return { errors, warnings, info };
}

export function stepProblem(st) {
  if (!st || typeof st !== 'object') return 'a step must be an object like {"do": "click", "selector": "#save"}.';
  if (!STEP_KINDS.includes(st.do)) return `"do" is "${st.do}". Known steps: ${STEP_KINDS.join(', ')}.`;
  const target = isStr(st.selector) || isStr(st.text);
  switch (st.do) {
    case 'click': case 'hover': if (!target) return `"${st.do}" needs "selector" (CSS or a Playwright selector) or "text" (the visible label).`; break;
    case 'type': if (!isStr(st.selector)) return '"type" needs "selector".'; if (typeof st.value !== 'string') return '"type" needs "value", the text to type.'; break;
    case 'press': if (!isStr(st.key)) return '"press" needs "key", e.g. "Enter".'; break;
    case 'scroll': if (!isNum(st.y) && !isStr(st.selector)) return '"scroll" needs "y" (CSS pixels, down is positive) or "selector" (scroll it into view).'; break;
    case 'goto': if (!isStr(st.url)) return '"goto" needs "url".'; break;
    case 'wait': case 'hold': if (!isNum(st.ms) || st.ms < 0 || st.ms > 30000) return `"${st.do}" needs "ms" from 0 to 30000.`; break;
    case 'waitFor': if (!target) return '"waitFor" needs "selector" or "text".'; break;
  }
  if (st.timeout !== undefined && (!isNum(st.timeout) || st.timeout < 100 || st.timeout > 60000)) return '"timeout" must be 100 to 60000 ms.';
  return null;
}

/** Planned length of the final video in seconds: included scenes plus the end card and the intro card. */
export function totalSeconds(s, skip = []) {
  const scenes = s.scenes.filter((sc) => sc.include !== false && !skip.includes(sc.id));
  const sum = scenes.reduce((a, sc) => a + sc.duration, 0);
  const cards = scenes.length ? (s.cut.endCard ? s.cut.endSeconds ?? END_CARD_SECONDS : 0) + (s.cut.introSeconds || 0) : 0;
  return Math.round((sum + cards) * 10) / 10;
}

/**
 * Fingerprint of everything that changes the recorded picture of one scene.
 * Caption, duration, include and cut settings are not part of it: changing those re-cuts without re-recording.
 * (A longer duration is filled by holding the last frame.)
 */
export function sceneHash(s, scene) {
  const prepare = parsePrepare(s.prepare);
  // The motion values of a style change the picture (pointer, click ring, scroll speed). They are in the fingerprint
  // only when they differ from the look before 0.6.0, so footage recorded with an earlier version stays valid.
  const m = s.motion || {}, motion = {};
  if (s.cursor && m.cursor && m.cursor !== 'arrow') motion.cursorKind = m.cursor;
  if (s.cursor && m.clickColor && m.clickColor.toLowerCase() !== '#ff2a8a') motion.clickColor = m.clickColor.toLowerCase();
  if (m.scrollSpeed && m.scrollSpeed !== 1) motion.scrollSpeed = m.scrollSpeed;
  const rec = { url: scene.url, steps: scene.steps, requiresLogin: !!scene.requiresLogin, viewport: s.viewport.width, cursor: s.cursor, login: scene.requiresLogin ? s.login || null : null, colorScheme: s.colorScheme || 'light', ...(prepare ? { prepare } : {}), ...motion };
  return createHash('sha256').update(JSON.stringify(rec)).digest('hex').slice(0, 16);
}

/**
 * The style and template choice that `pushreel begin --style … --template …` remembered for this project
 * (.pushreel/choice.json). Used when the shot list does not name them itself.
 */
export function readChoice(projectDir) {
  const c = projectDir ? readJson(paths(projectDir).choice) : null;
  return c && typeof c === 'object' ? c : {};
}

/**
 * A shot list with its style and template: validated, normalized, styled. Errors include the style file's problems and
 * the template's measurable rules.
 * @param {object} raw the shot list as written
 * @param {string} projectDir
 * @param {{ style?: string, template?: string, noProjectStyle?: boolean }} o the --style and --template of this command
 * @returns {{ shotlist: object|null, errors: string[], warnings: string[], info: string[], style: object, template: object }}
 */
export function prepareShotlist(raw, projectDir, o = {}) {
  const choice = readChoice(projectDir);
  const style = resolveStyle(projectDir, {
    name: o.style || choice.style, nameFrom: o.style ? '--style' : choice.style ? '/pushreel --style (remembered in .pushreel/choice.json)' : undefined,
    raw: raw && typeof raw === 'object' ? raw : {}, noProject: !!o.noProjectStyle,
  });
  const template = resolveTemplate(projectDir, {
    name: o.template || choice.template, nameFrom: o.template ? '--template' : choice.template ? '/pushreel --template (remembered in .pushreel/choice.json)' : undefined,
    raw: raw && typeof raw === 'object' ? raw : {}, noProject: !!o.noProjectStyle,
  });
  const st = style.style, cut = st.endCard ? { endSeconds: st.endCard.duration, introSeconds: st.intro.enabled ? st.intro.duration : 0, endCard: shotlistEndCard(raw, st) } : {};
  const v = validate(raw, { cut, allowRemote: !!o.allowRemote });
  const errors = [...v.errors, ...style.errors, ...template.errors];
  let shotlist = null;
  if (!v.errors.length && !style.errors.length) {
    shotlist = applyStyle(normalize(raw), style);
    if (!template.errors.length) errors.push(...checkRules(shotlist, template, { total: totalSeconds(shotlist) }));
  }
  return { shotlist, errors, warnings: [...v.warnings, ...style.warnings], info: v.info, style, template };
}
const shotlistEndCard = (raw, st) => (raw && raw.cut && raw.cut.endCard !== undefined ? !!raw.cut.endCard : st.endCard.enabled);

/** Loads, validates and normalizes, with the style applied. Throws a PushreelError with every problem listed. */
export function loadShotlist(file, projectDir, o = {}) {
  if (!existsSync(file)) throw E.noShotlist(file);
  const raw = readJson(file);
  if (raw === null) throw E.invalidShotlist([`${file} is not valid JSON.`]);
  const r = prepareShotlist(raw, projectDir, o);
  if (r.errors.length) throw E.invalidShotlist(r.errors);
  return r;
}

const words = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
/**
 * The on-screen heading a caption repeats, or null. A caption should add something the page does not already say:
 * "Zeig, womit du wirfst." over a page whose headline is "Zeig, womit du wirfst." tells the viewer nothing. Pure.
 * Counts as a repeat: the same words, one inside the other (at least 3 words and most of the longer one), or
 * 80 % of the words shared.
 */
export function repeatsHeadline(caption, headings = []) {
  const c = words(caption);
  if (c.length < 2) return null;
  for (const h of headings) {
    const w = words(h);
    if (w.length < 2) continue;
    const a = c.join(' '), b = w.join(' ');
    if (a === b) return h;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (` ${long} `.includes(` ${short} `) && short.split(' ').length >= 3 && short.length >= long.length * 0.6) return h;
    const sc = new Set(c), sw = new Set(w), shared = [...sc].filter((x) => sw.has(x)).length;
    if (shared / Math.max(sc.size, sw.size) >= 0.8) return h;
  }
  return null;
}

/**
 * Warnings for captions that repeat what the page itself shows, from the headings explore-shot saw on each page
 * (.pushreel/stills/<name>.json). Pure.
 * @param {object} s normalized shot list
 * @param {Array<{url, finalUrl?, headings?: string[]}>} seen
 */
export function headlineWarnings(s, seen = []) {
  const out = [];
  const on = (url) => [...new Set(seen.filter((x) => x && (x.url === url || x.finalUrl === url)).flatMap((x) => x.headings || []))];
  for (const sc of s.scenes.filter((x) => x.include !== false)) {
    const h = sc.caption && repeatsHeadline(sc.caption, on(sc.url));
    if (h) out.push(`Scene ${sc.id}: the caption "${sc.caption}" repeats the page's own heading "${h}", which is on screen in this scene. Write what the picture does not already say: what the viewer gets from it, or what just happened.`);
  }
  const cs = s.cover && s.cover.headline && s.scenes.find((x) => x.id === (s.cover.scene || (s.scenes[0] && s.scenes[0].id)));
  const ch = cs && repeatsHeadline(s.cover.headline, on(cs.url));
  if (ch) out.push(`"cover.headline" "${s.cover.headline}" repeats the heading "${ch}" of the cover's page. Use other words.`);
  return out;
}
