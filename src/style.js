// Styles: the look of captions, end card, cover, intro, corner logo and motion. Applied by fixed code, 0 tokens.
//
// A style is built in layers; each one overrides single values of the one before (docs/STYLES.md):
//   1. a built-in style (styles/<name>.json: clean, bold, neon)
//   2. your library, ~/.pushreel/styles/<name>.json (PUSHREEL_HOME moves it); same name as a built-in = laid over it
//   3. the project file pushreel.style.json in the project root (meant to be committed)
//   4. single values in the shot list for one run: "style": { … }, cut.zoom, cursor, cut.endCard, cover.scene
// `app.brandColor` (the end card colour, as before 0.6.0) sits under the project file: a style file the user made
// wins over a colour the agent wrote.
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, extname, sep, isAbsolute, relative } from 'node:path';
import { PLUGIN_ROOT, readJson, userHome } from './util.js';

export const STYLE_DIR = join(PLUGIN_ROOT, 'styles');
export const PROJECT_STYLE = 'pushreel.style.json';
export const DEFAULT_STYLE = 'bold';
export const libraryDir = () => join(userHome(), 'styles');
export const FONT_DIR = join(PLUGIN_ROOT, 'src', 'studio', 'public', 'fonts');

/** Fonts that ship with Pushreel (SIL Open Font License 1.1), by name. */
export const BUNDLED_FONTS = {
  'Sofia Sans': { weights: [400, 800], files: ['sofia-sans-latin.woff2', 'sofia-sans-latin-ext.woff2'] },
  'Sofia Sans Condensed': { weights: [600, 900], files: ['sofia-sans-condensed-latin.woff2', 'sofia-sans-condensed-latin-ext.woff2'] },
  'Spline Sans Mono': { weights: [400, 700], files: ['spline-sans-mono-latin.woff2', 'spline-sans-mono-latin-ext.woff2'] },
};
export const FONT_EXT = ['.ttf', '.otf', '.woff2'];
export const IMAGE_EXT = ['.png', '.svg'];
export const LIMITS = { fontBytes: 10e6, imageBytes: 5e6 };

/**
 * Every value a style can set: its type and range. The validator, the JSON schema in docs/style.schema.json and the
 * Studio's form are made from this one table.
 */
export const SPEC = {
  'captions.font': { type: 'font', doc: 'A bundled font by name, or a .ttf/.otf/.woff2 file inside the project.' },
  'captions.weight': { type: 'int', min: 400, max: 900, doc: 'Font weight. Bundled fonts: Sofia Sans 400 to 800, Sofia Sans Condensed 600 to 900, Spline Sans Mono 400 to 700.' },
  'captions.size': { type: 'int', min: 44, max: 110, doc: 'Type size in px of the 1080×1920 frame. Long captions get smaller by themselves.' },
  'captions.color': { type: 'color', doc: 'Text colour.' },
  'captions.background': { type: 'color', doc: 'Box colour; #rrggbbaa for a see-through box.' },
  'captions.highlight': { type: 'colorOrNone', doc: 'Colour of the stressed word (the longest one), or "none".' },
  'captions.highlightText': { type: 'colorOrAuto', doc: 'Text colour of the stressed word in a "box" highlight; "auto" picks black or white.' },
  'captions.highlightStyle': { type: 'enum', values: ['box', 'text'], doc: '"box": the word on a coloured box. "text": the word in the colour.' },
  'captions.uppercase': { type: 'bool', doc: 'Upper-case captions.' },
  'captions.position': { type: 'enum', values: ['bottom', 'top', 'auto'], doc: 'Where the caption starts. It still moves off the clicked element, headings and pictures, inside the platform\'s safe area. "auto": the end with less on it.' },
  'captions.radius': { type: 'int', min: 0, max: 60, doc: 'Corner radius of the box in px.' },
  'captions.shadow': { type: 'enum', values: ['none', 'soft', 'hard', 'glow'], doc: '"hard" and "glow" use the highlight colour.' },
  'captions.border': { type: 'colorOrNone', doc: 'A 4 px edge around the box, or "none".' },
  'endCard.enabled': { type: 'bool', doc: 'Show the end card.' },
  'endCard.background': { type: 'color', doc: 'Background colour.' },
  'endCard.color': { type: 'colorOrAuto', doc: 'Text colour; "auto" picks black or white for the background.' },
  'endCard.accent': { type: 'colorOrAuto', doc: 'Colour of the address pill; "auto" uses the text colour.' },
  'endCard.font': { type: 'font', doc: 'Font of the name.' },
  'endCard.textFont': { type: 'font', doc: 'Font of the address and the tagline.' },
  'endCard.logo': { type: 'image', doc: 'A PNG or SVG file inside the project, shown above the name; null for none.' },
  'endCard.text': { type: 'text', max: 40, doc: 'The big line; null = the app name from the shot list.' },
  'endCard.cta': { type: 'text', max: 60, doc: 'The address or call to action in the pill; null = app.address from the shot list.' },
  'endCard.tagline': { type: 'bool', doc: 'Show app.tagline under the pill.' },
  'endCard.duration': { type: 'number', min: 1, max: 5, doc: 'Seconds.' },
  'cover.scene': { type: 'scene', doc: 'Which scene the cover frame comes from; null = the first one. cover.scene in the shot list wins.' },
  'cover.font': { type: 'font', doc: 'Font of the cover headline.' },
  'cover.background': { type: 'color', doc: 'Headline box colour.' },
  'cover.color': { type: 'color', doc: 'Headline text colour.' },
  'cover.accent': { type: 'color', doc: 'Colour of a "hard" or "glow" shadow.' },
  'cover.uppercase': { type: 'bool', doc: 'Upper-case headline.' },
  'cover.radius': { type: 'int', min: 0, max: 60, doc: 'Corner radius in px.' },
  'cover.shadow': { type: 'enum', values: ['none', 'soft', 'hard', 'glow'], doc: 'Shadow of the headline box.' },
  'cover.logo': { type: 'image', doc: 'A PNG or SVG file inside the project, shown on top of the headline; null for none.' },
  'motion.zoom': { type: 'number', min: 1, max: 2.5, doc: 'Click zoom factor; 1 = no zoom. cut.zoom in the shot list wins.' },
  'motion.cursor': { type: 'enum', values: ['arrow', 'dot', 'none'], doc: 'The drawn pointer. Changing it records the scenes again.' },
  'motion.clickColor': { type: 'color', doc: 'Colour of the ring drawn on every click. Changing it records the scenes again.' },
  'motion.scrollSpeed': { type: 'number', min: 0.5, max: 2, doc: 'Scroll speed; 2 = twice as fast. Changing it records the scenes again.' },
  'watermark.enabled': { type: 'bool', doc: 'Your own logo in a corner of every scene (not on the end card). Off by default.' },
  'watermark.logo': { type: 'image', doc: 'PNG or SVG inside the project.' },
  'watermark.corner': { type: 'enum', values: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], doc: 'Corner of the platform\'s safe area.' },
  'watermark.size': { type: 'int', min: 48, max: 260, doc: 'Width in px (the height follows).' },
  'watermark.opacity': { type: 'number', min: 0.2, max: 1, doc: 'Opacity.' },
  'intro.enabled': { type: 'bool', doc: 'A card before the first scene. Off by default.' },
  'intro.text': { type: 'text', max: 40, doc: 'Its line; null = the cover headline, else the app name.' },
  'intro.logo': { type: 'image', doc: 'PNG or SVG inside the project; null for none.' },
  'intro.background': { type: 'color', doc: 'Background colour.' },
  'intro.color': { type: 'colorOrAuto', doc: 'Text colour; "auto" picks black or white.' },
  'intro.duration': { type: 'number', min: 0.8, max: 3, doc: 'Seconds.' },
};
/** Keys a style file may carry besides the values. */
export const META_KEYS = ['$schema', 'name', 'description', 'extends', 'template', 'rules'];
export const GROUPS = [...new Set(Object.keys(SPEC).map((k) => k.split('.')[0]))];

// ---------- colours ----------
/** '#rgb' | '#rrggbb' | '#rrggbbaa' → { r, g, b, a } (0..255, a 0..1), or null. Pure. */
export function parseColor(v) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(v || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
/**
 * WCAG contrast ratio of a text colour on a background. A see-through background is judged at its worst: over
 * black and over white, the lower of the two. Pure.
 */
export function contrast(text, background) {
  const t = parseColor(text), b = parseColor(background);
  if (!t || !b) return null;
  const ratio = (x, y) => { const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (l1 + 0.05) / (l2 + 0.05); };
  const backs = b.a >= 0.999 ? [b] : [over(b, { r: 0, g: 0, b: 0, a: 1 }), over(b, { r: 255, g: 255, b: 255, a: 1 })];
  return Math.round(Math.min(...backs.map((bb) => ratio(t.a >= 0.999 ? t : over(t, bb), bb))) * 100) / 100;
}
/** Black-ish or white text for a background. Same rule as before 0.6.0 (src/render.js inkOn). Pure. */
export function inkOn(hex) {
  const c = parseColor(hex);
  if (!c) return '#ffffff';
  return luminance(c) > 0.4 ? '#0e0a1f' : '#ffffff';
}
/** A colour as CSS (keeps the alpha). */
export const css = (hex) => { const c = parseColor(hex); return c ? (c.a >= 0.999 ? `rgb(${c.r} ${c.g} ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${Math.round(c.a * 1000) / 1000})`) : 'transparent'; };

// ---------- objects ----------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function getPath(o, key) { return key.split('.').reduce((a, k) => (isObj(a) ? a[k] : undefined), o); }
function setPath(o, key, v) { const ks = key.split('.'); let a = o; for (const k of ks.slice(0, -1)) { if (!isObj(a[k])) a[k] = {}; a = a[k]; } a[ks[ks.length - 1]] = v; }
/** The value keys a style object sets (known or not), as 'group.key'. */
function leaves(o) {
  const out = [];
  for (const [g, v] of Object.entries(o || {})) {
    if (META_KEYS.includes(g)) continue;
    if (isObj(v)) for (const k of Object.keys(v)) out.push(`${g}.${k}`); else out.push(g);
  }
  return out;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- files inside the project ----------
const MAGIC = {
  '.woff2': (b) => b.slice(0, 4).toString('latin1') === 'wOF2',
  '.ttf': (b) => b.readUInt32BE(0) === 0x00010000 || b.slice(0, 4).toString('latin1') === 'true',
  '.otf': (b) => b.slice(0, 4).toString('latin1') === 'OTTO',
  '.png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.svg': (b) => /<svg[\s>]/i.test(b.toString('utf8')),
};
function head(file, n) { const fd = openSync(file, 'r'); try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { closeSync(fd); } }

/**
 * Checks that a style's file value is a usable file inside the project. Fonts and logos are only ever read from the
 * project folder: no path outside it, no symbolic link that leads out of it.
 * @param {'font'|'image'} kind
 * @returns {{ file?: string, rel?: string, problem?: string }}
 */
export function projectFile(projectDir, value, kind) {
  const exts = kind === 'font' ? FONT_EXT : IMAGE_EXT, ext = extname(String(value)).toLowerCase();
  if (!exts.includes(ext)) return { problem: `must be a ${exts.join(', ')} file${kind === 'font' ? ' or the name of a bundled font' : ''}, got "${value}"` };
  if (!projectDir) return { problem: 'needs a project folder to look in' };
  let root;
  try { root = realpathSync(projectDir); } catch { return { problem: `the project folder ${projectDir} does not exist` }; }
  const full = isAbsolute(value) ? value : resolve(projectDir, value);
  if (!existsSync(full)) return { problem: `the file "${value}" does not exist (paths are relative to the project folder)` };
  let real;
  try { real = realpathSync(full); } catch { return { problem: `the file "${value}" cannot be read` }; }
  if (!(real === root || real.startsWith(root + sep))) return { problem: `"${value}" is outside the project folder. Fonts and logos are only read from inside the project: copy the file into it` };
  const st = statSync(real);
  if (!st.isFile()) return { problem: `"${value}" is not a file` };
  const max = kind === 'font' ? LIMITS.fontBytes : LIMITS.imageBytes;
  if (st.size > max) return { problem: `"${value}" is ${(st.size / 1e6).toFixed(1)} MB; the limit is ${max / 1e6} MB` };
  if (st.size < 8 || !MAGIC[ext](head(real, ext === '.svg' ? 2048 : 8))) return { problem: `"${value}" is not a ${ext.slice(1).toUpperCase()} file (its content does not match the extension)` };
  return { file: real, rel: relative(root, real).split(sep).join('/') };
}
/** A font value: { bundled: name } or { file, rel } or { problem }. */
export function fontOf(projectDir, value) {
  if (typeof value !== 'string' || !value.trim()) return { problem: 'must be a font name or a font file' };
  if (FONT_EXT.includes(extname(value).toLowerCase())) return projectFile(projectDir, value, 'font');
  const name = Object.keys(BUNDLED_FONTS).find((n) => n.toLowerCase() === value.trim().toLowerCase());
  return name ? { bundled: name } : { problem: `"${value}" is not a bundled font. Bundled: ${Object.keys(BUNDLED_FONTS).join(', ')}. Or give a .ttf, .otf or .woff2 file inside the project` };
}

// ---------- validation ----------
const fmt = (v) => JSON.stringify(v);
/**
 * Checks one style layer (all of it or a few values). Unknown keys are warnings, so a typo is visible.
 * @param {object} o the layer
 * @param {{ label: string, projectDir?: string, files?: boolean }} ctx label names the file in every message
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateStyle(o, { label = 'style', projectDir, files = true } = {}) {
  const errors = [], warnings = [];
  if (!isObj(o)) return { errors: [`${label}: must be one JSON object.`], warnings };
  for (const k of Object.keys(o)) {
    if (META_KEYS.includes(k)) continue;
    if (!GROUPS.includes(k)) warnings.push(`${label}: "${k}" is not a style setting and is ignored. Known: ${GROUPS.join(', ')}.`);
    else if (!isObj(o[k])) errors.push(`${label}: "${k}" must be an object, e.g. "${k}": { … }.`);
  }
  if (o.extends !== undefined && (typeof o.extends !== 'string' || !o.extends.trim())) errors.push(`${label}: "extends" must be the name of a style, e.g. "bold".`);
  if (o.template !== undefined && o.template !== null && (typeof o.template !== 'string' || !o.template.trim())) errors.push(`${label}: "template" must be the name of a template, e.g. "launch".`);
  for (const key of leaves(o)) {
    if (!key.includes('.') || !GROUPS.includes(key.split('.')[0])) continue;
    const spec = SPEC[key], v = getPath(o, key);
    if (!spec) { const near = Object.keys(SPEC).filter((s) => s.startsWith(key.split('.')[0] + '.')).map((s) => s.split('.')[1]); warnings.push(`${label}: "${key}" is not a style setting and is ignored. In "${key.split('.')[0]}": ${near.join(', ')}.`); continue; }
    const p = valueProblem(spec, v, projectDir, files);
    if (p) errors.push(`${label}: "${key}" ${p}`);
  }
  return { errors, warnings };
}
function valueProblem(spec, v, projectDir, files) {
  const range = () => `from ${spec.min} to ${spec.max}`;
  switch (spec.type) {
    case 'int': return Number.isInteger(v) && v >= spec.min && v <= spec.max ? null : `is ${fmt(v)}. It must be a whole number ${range()}.`;
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max ? null : `is ${fmt(v)}. It must be a number ${range()}.`;
    case 'bool': return typeof v === 'boolean' ? null : `is ${fmt(v)}. It must be true or false.`;
    case 'enum': return spec.values.includes(v) ? null : `is ${fmt(v)}. It must be one of ${spec.values.map(fmt).join(', ')}.`;
    case 'color': return parseColor(v) ? null : `is ${fmt(v)}. It must be a colour like "#0e0a1f" (#rgb, #rrggbb or #rrggbbaa).`;
    case 'colorOrNone': return v === 'none' || parseColor(v) ? null : `is ${fmt(v)}. It must be a colour like "#d7ff1f", or "none".`;
    case 'colorOrAuto': return v === 'auto' || parseColor(v) ? null : `is ${fmt(v)}. It must be a colour like "#ffffff", or "auto".`;
    case 'text': return v === null || (typeof v === 'string' && v.length <= spec.max) ? null : typeof v === 'string' ? `has ${v.length} characters. The limit is ${spec.max}.` : `is ${fmt(v)}. It must be text, or null.`;
    case 'scene': return v === null || (Number.isInteger(v) && v >= 1) ? null : `is ${fmt(v)}. It must be a scene id (1, 2, …) or null.`;
    case 'font': { if (!files) return typeof v === 'string' && v.trim() ? null : 'must be a font name or a font file.'; const f = fontOf(projectDir, v); return f.problem ? `${f.problem}.` : null; }
    case 'image': { if (v === null) return null; if (typeof v !== 'string' || !v.trim()) return `is ${fmt(v)}. It must be a PNG or SVG file inside the project, or null.`; if (!files) return null; const f = projectFile(projectDir, v, 'image'); return f.problem ? `${f.problem}.` : null; }
    default: return null;
  }
}

/** Contrast and other warnings about a complete style. Pure. */
export function styleWarnings(st) {
  const w = [], c = st.captions;
  const low = (a, b, what, fix) => { const r = contrast(a, b); if (r !== null && r < 4.5) w.push(`${what}: contrast ${r}:1, below 4.5:1. It is hard to read on a phone. ${fix}`); };
  low(c.color, c.background, 'Caption text on the caption box', 'Change "captions.color" or "captions.background".');
  if (c.highlight !== 'none') {
    if (c.highlightStyle === 'box') low(c.highlightText === 'auto' ? inkOn(c.highlight) : c.highlightText, c.highlight, 'The stressed word on its highlight', 'Change "captions.highlightText" or "captions.highlight".');
    else low(c.highlight, c.background, 'The stressed word (highlight colour) on the caption box', 'Change "captions.highlight" or "captions.background".');
  }
  const bgA = parseColor(c.background);
  if (bgA && bgA.a < 0.6) w.push(`"captions.background" is ${Math.round(bgA.a * 100)} % opaque: the caption sits on the app's own picture, which changes from scene to scene.`);
  low(st.cover.color, st.cover.background, 'Cover headline on its box', 'Change "cover.color" or "cover.background".');
  if (st.endCard.enabled && st.endCard.color !== 'auto') low(st.endCard.color, st.endCard.background, 'End card text on its background', 'Change "endCard.color", or set it to "auto".');
  if (st.intro.enabled && st.intro.color !== 'auto') low(st.intro.color, st.intro.background, 'Intro text on its background', 'Change "intro.color", or set it to "auto".');
  if (st.watermark.enabled && !st.watermark.logo) w.push('"watermark.enabled" is true but "watermark.logo" names no file: no corner logo is drawn.');
  const font = st.captions.font, b = BUNDLED_FONTS[font];
  if (b && (st.captions.weight < b.weights[0] || st.captions.weight > b.weights[1])) w.push(`"captions.weight" ${st.captions.weight} is outside what ${font} has (${b.weights[0]} to ${b.weights[1]}); the nearest weight is used.`);
  return w;
}

// ---------- the layers ----------
export const builtinNames = () => (existsSync(STYLE_DIR) ? readdirSync(STYLE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : []);
export const libraryNames = () => { try { return readdirSync(libraryDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } };
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
/** Reads a style file. { data } or { error } with the reason. */
export function readStyleFile(file) {
  if (!existsSync(file)) return { error: `${file} does not exist` };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { error: `${file} cannot be read (${e.code || e.message})` }; }
  try { const data = JSON.parse(text); return isObj(data) ? { data } : { error: `${file} must contain one JSON object` }; } catch (e) { return { error: `${file} is not valid JSON (${e.message.replace(/^JSON\.parse: /, '')})` }; }
}
export const projectStyleFile = (projectDir) => join(projectDir, PROJECT_STYLE);
export function readProjectStyle(projectDir) {
  const file = projectStyleFile(projectDir);
  if (!existsSync(file)) return null;
  return { file, ...readStyleFile(file) };
}

/** The layers of a named style: built-in and/or library, following "extends" (at most 4 deep). */
function namedLayers(name, errors, seen = []) {
  if (!NAME.test(name)) { errors.push(`There is no style "${name}". A style name is letters, digits, - and _. Styles: ${allNames().join(', ')}.`); return []; }
  if (seen.includes(name) || seen.length > 4) { errors.push(`The style "${seen[0]}" extends itself (${[...seen, name].join(' → ')}).`); return []; }
  const lib = join(libraryDir(), `${name}.json`), built = join(STYLE_DIR, `${name}.json`), out = [];
  const hasLib = existsSync(lib), hasBuilt = existsSync(built);
  if (!hasLib && !hasBuilt) { errors.push(`There is no style "${name}". Styles: ${allNames().join(', ')}. Your own go into ${libraryDir()}/<name>.json.`); return []; }
  if (hasBuilt) out.push({ label: `built-in style "${name}"`, kind: 'built-in', name, file: built, data: readStyleFile(built).data || {} });
  if (hasLib) {
    const r = readStyleFile(lib);
    if (r.error) { errors.push(`Your style "${name}": ${r.error}.`); return out; }
    if (r.data.extends && r.data.extends !== name) out.unshift(...namedLayers(r.data.extends, errors, [...seen, name]));
    out.push({ label: `your library (${lib.replace(userHomeTilde(), '~/')})`, kind: 'library', name, file: lib, data: r.data });
  }
  return out;
}
const userHomeTilde = () => { const h = process.env.HOME || ''; return h ? h.replace(/\/?$/, '/') : '\u0000'; };
export const allNames = () => [...new Set([...builtinNames(), ...libraryNames()])].sort();

/** Turns the shot list's own values into a style layer. */
export function shotlistLayer(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  if (isObj(raw.style)) for (const g of GROUPS) if (isObj(raw.style[g])) out[g] = clone(raw.style[g]);
  const cut = isObj(raw.cut) ? raw.cut : {};
  if (cut.zoom !== undefined) setPath(out, 'motion.zoom', cut.zoom === true ? 1.4 : cut.zoom === false || cut.zoom === 0 ? 1 : cut.zoom);
  if (cut.endCard !== undefined) setPath(out, 'endCard.enabled', !!cut.endCard);
  if (raw.cursor === false) setPath(out, 'motion.cursor', 'none');
  if (isObj(raw.cover) && raw.cover.scene !== undefined) setPath(out, 'cover.scene', raw.cover.scene);
  return out;
}

/**
 * The style of a run, with where each value came from.
 * @param {string} projectDir
 * @param {{ name?: string, nameFrom?: string, raw?: object, noProject?: boolean, projectData?: object|null }} o name: --style or the
 *   remembered choice; projectData: use this instead of the project file on disk
 * @returns {{ style, sources: {[key]: string}, layers: Array<{label, kind, file?}>, base: string, baseFrom: string, project: string|null, errors: string[], warnings: string[], projectData: object|null }}
 */
export function resolveStyle(projectDir, o = {}) {
  const errors = [], warnings = [], raw = o.raw || {};
  // o.projectData: a draft of the project file (the Studio's Style screen previews it before it is saved)
  const proj = o.noProject ? null : o.projectData !== undefined ? (o.projectData ? { file: projectStyleFile(projectDir), data: o.projectData } : null) : readProjectStyle(projectDir);
  if (proj && proj.error) errors.push(`${PROJECT_STYLE}: ${proj.error.replace(proj.file, 'the file')}.`);
  const projData = proj && proj.data ? proj.data : null;
  const rawStyle = raw.style;
  if (rawStyle !== undefined && typeof rawStyle !== 'string' && !isObj(rawStyle)) errors.push('Shot list: "style" must be a style name, e.g. "neon", or an object of single values, e.g. { "captions": { "size": 68 } }.');
  const fromShot = typeof rawStyle === 'string' ? rawStyle : isObj(rawStyle) && typeof rawStyle.extends === 'string' ? rawStyle.extends : null;
  let base = DEFAULT_STYLE, baseFrom = 'the default';
  if (o.name) { base = o.name; baseFrom = o.nameFrom || '--style'; }
  else if (fromShot) { base = fromShot; baseFrom = 'the shot list ("style")'; }
  else if (projData && typeof projData.extends === 'string') { base = projData.extends; baseFrom = `${PROJECT_STYLE} ("extends")`; }

  const layers = [{ label: `built-in style "${DEFAULT_STYLE}"`, kind: 'built-in', name: DEFAULT_STYLE, file: join(STYLE_DIR, `${DEFAULT_STYLE}.json`), data: readStyleFile(join(STYLE_DIR, `${DEFAULT_STYLE}.json`)).data || {}, quiet: base !== DEFAULT_STYLE }];
  const named = namedLayers(base, errors);
  for (const l of named) if (!(l.kind === 'built-in' && l.file === layers[0].file)) layers.push(l);
  if (named.length && named.every((l) => l.kind === 'built-in' && l.file === layers[0].file)) layers[0].quiet = false;
  const brand = isObj(raw.app) && typeof raw.app.brandColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.app.brandColor) ? raw.app.brandColor : null;
  if (brand) {
    if (projData && getPath(projData, 'endCard.background') !== undefined) warnings.push(`"app.brandColor" ${brand} in the shot list is not used: ${PROJECT_STYLE} sets "endCard.background".`);
    else layers.push({ label: 'the shot list ("app.brandColor")', kind: 'shotlist', data: { endCard: { background: brand } } });
  }
  if (projData) layers.push({ label: PROJECT_STYLE, kind: 'project', file: proj.file, data: projData });
  const shot = shotlistLayer(raw);
  if (Object.keys(shot).length) layers.push({ label: 'the shot list', kind: 'shotlist', data: shot });

  const style = {}, sources = {};
  for (const g of GROUPS) style[g] = {};
  for (const l of layers) {
    const v = validateStyle(l.data, { label: l.label === PROJECT_STYLE ? PROJECT_STYLE : l.label.replace(/^./, (c) => c.toUpperCase()), projectDir });
    errors.push(...v.errors); warnings.push(...v.warnings);
    for (const key of leaves(l.data)) if (SPEC[key]) { setPath(style, key, clone(getPath(l.data, key))); sources[key] = l.label; }
  }
  if (!errors.length) warnings.push(...styleWarnings(style));
  return {
    style, sources, base, baseFrom, errors, warnings, projectData: projData,
    project: projData ? PROJECT_STYLE : null,
    layers: layers.filter((l) => !l.quiet).map(({ label, kind, file, name }) => ({ label, kind, name: name || null, file: file || null })),
  };
}

/** One line for run.log and the result: "bold (built-in) + pushreel.style.json + the shot list". */
export function styleLine(r) {
  const names = r.layers.map((l) => (l.kind === 'built-in' ? `${l.name} (built-in)` : l.kind === 'library' ? `${l.name} (${l.label})` : l.label));
  return `${names.join(' + ')}${r.baseFrom !== 'the default' ? `; "${r.base}" chosen by ${r.baseFrom}` : ''}`;
}

/**
 * Writes the look into a normalized shot list: zoom, cursor, end card, intro, cover scene. Returns a new object;
 * `look` holds the complete style for the renderer.
 */
export function applyStyle(s, resolved) {
  const out = clone(s), st = resolved.style;
  out.cut = { ...out.cut, zoom: st.motion.zoom, endCard: st.endCard.enabled, endSeconds: st.endCard.duration, introSeconds: st.intro.enabled ? st.intro.duration : 0 };
  out.cursor = st.motion.cursor !== 'none';
  out.motion = { cursor: st.motion.cursor, clickColor: st.motion.clickColor, scrollSpeed: st.motion.scrollSpeed };
  if (st.cover.scene !== null && st.cover.scene !== undefined && !(out.cover && out.cover.scene !== undefined) && out.scenes.some((x) => x.id === st.cover.scene)) out.cover = { ...(out.cover || {}), scene: st.cover.scene };
  out.look = st;
  return out;
}

/** A style without the values that equal those of the style below it: what `style init` and the Studio save. */
export function diffStyle(full, below) {
  const out = {};
  for (const key of Object.keys(SPEC)) { const a = getPath(full, key), b = getPath(below, key); if (a !== undefined && JSON.stringify(a) !== JSON.stringify(b)) setPath(out, key, a); }
  return out;
}

/** Parses "captions.background=#000" into [key, value]; numbers, booleans and null are typed by the SPEC. */
export function parseAssignment(text) {
  const i = String(text).indexOf('=');
  if (i < 1) return { problem: `"${text}" is not key=value, e.g. captions.background=#0e0a1f` };
  const key = text.slice(0, i).trim(), rawV = text.slice(i + 1).trim(), spec = SPEC[key];
  if (!spec) return { problem: `"${key}" is not a style setting. Settings: ${Object.keys(SPEC).join(', ')}` };
  let v = rawV;
  if (rawV === 'null') v = null;
  else if (['int', 'number', 'scene'].includes(spec.type) && rawV !== '' && !Number.isNaN(Number(rawV))) v = Number(rawV);
  else if (spec.type === 'bool' && /^(true|false|on|off|yes|no)$/i.test(rawV)) v = /^(true|on|yes)$/i.test(rawV);
  return { key, value: v };
}
export { setPath, clone, isObj, leaves };

/** The JSON schema of a style file, made from SPEC (docs/style.schema.json is this, written by scripts/style-schema.mjs). */
export function styleSchema() {
  const color = { type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };
  const prop = (spec) => {
    const d = { description: spec.doc };
    switch (spec.type) {
      case 'int': return { ...d, type: 'integer', minimum: spec.min, maximum: spec.max };
      case 'number': return { ...d, type: 'number', minimum: spec.min, maximum: spec.max };
      case 'bool': return { ...d, type: 'boolean' };
      case 'enum': return { ...d, enum: spec.values };
      case 'color': return { ...d, ...color };
      case 'colorOrNone': return { ...d, anyOf: [color, { const: 'none' }] };
      case 'colorOrAuto': return { ...d, anyOf: [color, { const: 'auto' }] };
      case 'text': return { ...d, type: ['string', 'null'], maxLength: spec.max };
      case 'scene': return { ...d, type: ['integer', 'null'], minimum: 1 };
      case 'font': return { ...d, anyOf: [{ enum: Object.keys(BUNDLED_FONTS) }, { type: 'string', pattern: '\\.(ttf|otf|woff2)$' }] };
      case 'image': return { ...d, anyOf: [{ type: 'null' }, { type: 'string', pattern: '\\.(png|svg)$' }] };
      default: return d;
    }
  };
  const properties = {
    $schema: { type: 'string' }, name: { type: 'string', description: 'For library styles: the name, same as the file name.' }, description: { type: 'string' },
    extends: { type: 'string', description: 'The style this one starts from: clean, bold, neon or one of yours. Default: bold.' },
    template: { type: 'string', description: 'The story template /pushreel uses in this project when none is passed: launch, feature, changelog or one of yours.' },
    rules: { type: 'object', description: 'Rules for the agent, laid over the template\'s rules (docs/STYLES.md, "Rules").' },
  };
  for (const g of GROUPS) {
    const keys = Object.keys(SPEC).filter((k) => k.startsWith(g + '.'));
    properties[g] = { type: 'object', additionalProperties: false, properties: Object.fromEntries(keys.map((k) => [k.split('.')[1], prop(SPEC[k])])) };
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://raw.githubusercontent.com/IonFlux84/pushreel/main/docs/style.schema.json', title: 'Pushreel style (pushreel.style.json)', type: 'object', additionalProperties: false, properties };
}
