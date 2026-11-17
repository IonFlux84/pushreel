// Story templates and rules for the agent. A template names the scene slots the agent fills (launch: hook, three
// features, call to action) and carries rules for captions, paths, lengths and post texts. The project file
// pushreel.style.json can name a template ("template") and lay its own rules over it ("rules").
//
// The validator enforces what can be measured (slots, word counts, banned words, emoji, paths, lengths, hashtags)
// as errors the agent must fix. Person, language and tone cannot be measured: they are instructions in the brief.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT, userHome } from './util.js';
import { readStyleFile, readProjectStyle, PROJECT_STYLE, isObj, clone } from './style.js';

export const TEMPLATE_DIR = join(PLUGIN_ROOT, 'templates');
export const templateLibrary = () => join(userHome(), 'templates');
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const names = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } };
export const builtinTemplates = () => names(TEMPLATE_DIR);
export const libraryTemplates = () => names(templateLibrary());
export const allTemplates = () => [...new Set([...builtinTemplates(), ...libraryTemplates()])].sort();

/** A template by name: your library wins over a built-in of the same name. { template, file, kind } or { error }. */
export function loadTemplate(name) {
  if (!NAME.test(String(name || ''))) return { error: `There is no template "${name}". Templates: ${allTemplates().join(', ')}.` };
  const lib = join(templateLibrary(), `${name}.json`), built = join(TEMPLATE_DIR, `${name}.json`);
  const file = existsSync(lib) ? lib : existsSync(built) ? built : null;
  if (!file) return { error: `There is no template "${name}". Templates: ${allTemplates().join(', ')}. Your own go into ${templateLibrary()}/<name>.json.` };
  const r = readStyleFile(file);
  if (r.error) return { error: `Template "${name}": ${r.error}.` };
  const problems = templateProblems(r.data, `Template "${name}"`);
  if (problems.length) return { error: problems.join(' ') };
  return { template: { name, ...r.data }, file, kind: file === lib ? 'library' : 'built-in' };
}

const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
const isRange = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x >= 0) && v[0] <= v[1];
/** Shape problems of a template file. Pure. */
export function templateProblems(t, label = 'Template') {
  const out = [];
  if (!isObj(t)) return [`${label} must be one JSON object.`];
  if (t.slots !== undefined) {
    if (!Array.isArray(t.slots) || !t.slots.length) out.push(`${label}: "slots" must be a list of { "id", "min", "max", "brief" }.`);
    else {
      const ids = new Set();
      t.slots.forEach((s, i) => {
        if (!isObj(s) || !/^[a-z][a-z0-9-]{0,23}$/.test(s.id || '')) out.push(`${label}: slot ${i + 1} needs an "id" of a-z, 0-9 and -, e.g. "hook".`);
        else if (ids.has(s.id)) out.push(`${label}: slot "${s.id}" is named twice.`);
        else ids.add(s.id);
        if (isObj(s) && !(Number.isInteger(s.min) && Number.isInteger(s.max) && s.min >= 0 && s.max >= Math.max(1, s.min) && s.max <= 12)) out.push(`${label}: slot "${s && s.id}" needs whole numbers "min" (0 or more) and "max" (at least min and 1, at most 12).`);
      });
    }
  }
  if (t.rules !== undefined) out.push(...rulesProblems(t.rules, label));
  return out;
}
/** Shape problems of a rules object (from a template or from pushreel.style.json). Pure. */
export function rulesProblems(r, label = 'Rules') {
  const out = [];
  if (!isObj(r)) return [`${label}: "rules" must be an object.`];
  const known = { captions: ['maxWords', 'person', 'language', 'bannedWords', 'noEmoji'], paths: ['mustShow', 'neverShow'], length: ['total', 'scene'], posts: ['tone', 'language', 'noEmoji', 'bannedWords', 'hashtags'] };
  for (const [g, v] of Object.entries(r)) {
    if (!known[g]) { out.push(`${label}: "rules.${g}" is not a rule. Rules: ${Object.keys(known).join(', ')}.`); continue; }
    if (!isObj(v)) { out.push(`${label}: "rules.${g}" must be an object.`); continue; }
    for (const k of Object.keys(v)) if (!known[g].includes(k)) out.push(`${label}: "rules.${g}.${k}" is not a rule. In "${g}": ${known[g].join(', ')}.`);
  }
  const c = r.captions || {}, p = r.paths || {}, l = r.length || {}, po = r.posts || {};
  if (c.maxWords !== undefined && !(Number.isInteger(c.maxWords) && c.maxWords >= 1 && c.maxWords <= 30)) out.push(`${label}: "rules.captions.maxWords" must be a whole number from 1 to 30.`);
  if (c.person !== undefined && !['I', 'you', 'we', null].includes(c.person)) out.push(`${label}: "rules.captions.person" must be "I", "you", "we" or null.`);
  for (const [k, v] of [['captions.language', c.language], ['posts.language', po.language], ['posts.tone', po.tone]]) if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 300)) out.push(`${label}: "rules.${k}" must be text (at most 300 characters).`);
  for (const [k, v] of [['captions.bannedWords', c.bannedWords], ['posts.bannedWords', po.bannedWords], ['paths.mustShow', p.mustShow], ['paths.neverShow', p.neverShow]]) if (v !== undefined && !isStrList(v)) out.push(`${label}: "rules.${k}" must be a list of text.`);
  for (const k of ['mustShow', 'neverShow']) if (isStrList(p[k]) && p[k].some((x) => !x.startsWith('/'))) out.push(`${label}: every path in "rules.paths.${k}" starts with "/", e.g. "/pricing" or "/admin*".`);
  for (const [k, v] of [['captions.noEmoji', c.noEmoji], ['posts.noEmoji', po.noEmoji]]) if (v !== undefined && typeof v !== 'boolean') out.push(`${label}: "rules.${k}" must be true or false.`);
  for (const k of ['total', 'scene']) if (l[k] !== undefined && !isRange(l[k])) out.push(`${label}: "rules.length.${k}" must be [min, max] in seconds, e.g. [20, 45].`);
  if (po.hashtags !== undefined) {
    const h = po.hashtags;
    if (!isObj(h)) out.push(`${label}: "rules.posts.hashtags" must be an object, e.g. { "max": 3, "required": ["#buildinpublic"] }.`);
    else {
      if (h.max !== undefined && !(Number.isInteger(h.max) && h.max >= 0 && h.max <= 30)) out.push(`${label}: "rules.posts.hashtags.max" must be a whole number from 0 to 30.`);
      for (const k of ['required', 'banned']) if (h[k] !== undefined && !(isStrList(h[k]) && h[k].every((x) => /^#[\p{L}\p{N}_]+$/u.test(x)))) out.push(`${label}: "rules.posts.hashtags.${k}" must be a list of hashtags like "#buildinpublic".`);
    }
  }
  return out;
}

/** Rules laid over rules: objects merge one level deep, lists and values are replaced. Pure. */
export function mergeRules(a = {}, b = {}) {
  const out = clone(a || {});
  for (const [g, v] of Object.entries(b || {})) out[g] = isObj(v) && isObj(out[g]) ? { ...out[g], ...clone(v) } : clone(v);
  if (isObj(a && a.posts && a.posts.hashtags) && isObj(b && b.posts && b.posts.hashtags)) out.posts.hashtags = { ...a.posts.hashtags, ...b.posts.hashtags };
  return out;
}

/**
 * The template and rules of a run.
 * @param {string} projectDir
 * @param {{ name?: string, nameFrom?: string, raw?: object, noProject?: boolean }} o name: --template or the remembered choice
 * @returns {{ name: string|null, from: string|null, template: object|null, kind: string|null, rules: object, rulesFrom: string[], errors: string[] }}
 */
export function resolveTemplate(projectDir, o = {}) {
  const errors = [], raw = o.raw || {}, proj = o.noProject ? null : readProjectStyle(projectDir), pd = proj && proj.data ? proj.data : {};
  let name = null, from = null;
  if (o.name) { name = o.name; from = o.nameFrom || '--template'; }
  else if (typeof raw.template === 'string' && raw.template) { name = raw.template; from = 'the shot list ("template")'; }
  else if (typeof pd.template === 'string' && pd.template) { name = pd.template; from = `${PROJECT_STYLE} ("template")`; }
  if (raw.template !== undefined && raw.template !== null && typeof raw.template !== 'string') errors.push('Shot list: "template" must be the name of a template, e.g. "launch".');
  let template = null, kind = null;
  if (name && name !== 'none') { const t = loadTemplate(name); if (t.error) errors.push(t.error); else { template = t.template; kind = t.kind; } }
  if (name === 'none') { name = null; from = null; }
  const rulesFrom = [];
  let rules = template && template.rules ? clone(template.rules) : {};
  if (template && template.rules) rulesFrom.push(`template "${template.name}"`);
  if (pd.rules !== undefined) {
    const pr = rulesProblems(pd.rules, PROJECT_STYLE);
    if (pr.length) errors.push(...pr); else { rules = mergeRules(rules, pd.rules); rulesFrom.push(PROJECT_STYLE); }
  }
  return { name: template ? template.name : null, from: template ? from : null, template, kind, rules, rulesFrom, errors };
}

const range = (r) => `${r[0]} to ${r[1]} s`;
/** The instructions for the agent: which slots to fill and the rules. Printed by `pushreel begin`. Pure. */
export function brief(t) {
  const L = [];
  if (t.template) {
    L.push(`Template: ${t.template.name}${t.kind === 'library' ? ' (your library)' : ''}, chosen by ${t.from}. ${t.template.description || ''}`.trim());
    L.push('Fill these slots in this order, one scene per slot, and put "slot": "<id>" on every included scene:');
    for (const s of t.template.slots || []) L.push(`  ${s.id.padEnd(9)} ${s.min === s.max ? `${s.min} ${s.min === 1 ? 'scene ' : 'scenes'}` : `${s.min} to ${s.max} scenes`}  ${s.brief || ''}`);
    L.push(`Write "template": "${t.template.name}" into the shot list.`);
  }
  const r = t.rules || {}, c = r.captions || {}, p = r.paths || {}, l = r.length || {}, po = r.posts || {};
  const caps = [];
  if (c.maxWords) caps.push(`at most ${c.maxWords} words`);
  if (c.person) caps.push(c.person === 'I' ? 'first person ("I")' : c.person === 'we' ? 'first person plural ("we")' : 'address the viewer ("you")');
  if (c.language) caps.push(`in ${c.language}`);
  if (c.noEmoji) caps.push('no emoji');
  if (c.bannedWords && c.bannedWords.length) caps.push(`never: ${c.bannedWords.join(', ')}`);
  const lines = [];
  if (caps.length) lines.push(`  Captions and cover headline: ${caps.join('; ')}.`);
  if (p.mustShow && p.mustShow.length) lines.push(`  Must show (a scene each): ${p.mustShow.join(', ')}.`);
  if (p.neverShow && p.neverShow.length) lines.push(`  Never show: ${p.neverShow.join(', ')} (no scene and no goto there).`);
  if (l.total) lines.push(`  Total length with the cards: ${range(l.total)}.`);
  if (l.scene) lines.push(`  Every scene: ${range(l.scene)} ("duration").`);
  const posts = [];
  if (po.tone) posts.push(`tone: ${po.tone.replace(/[.\s]+$/, '')}`);
  if (po.language) posts.push(`in ${po.language}`);
  if (po.noEmoji) posts.push('no emoji');
  const h = po.hashtags || {};
  if (h.max !== undefined) posts.push(h.max === 0 ? 'no hashtags' : `at most ${h.max} hashtags each`);
  if (h.required && h.required.length) posts.push(`always ${h.required.join(' ')}`);
  if (h.banned && h.banned.length) posts.push(`never ${h.banned.join(' ')}`);
  if (po.bannedWords && po.bannedWords.length) posts.push(`never: ${po.bannedWords.join(', ')}`);
  if (posts.length) lines.push(`  Post texts: ${posts.join('; ')}.`);
  if (lines.length) { L.push(`Rules${t.rulesFrom.length ? ` (from ${t.rulesFrom.join(' + ')})` : ''}. validate-shotlist checks the ones it can measure:`); L.push(...lines); }
  return L.join('\n');
}

// ---------- checking a shot list ----------
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
export const hasEmoji = (s) => EMOJI.test(String(s || ''));
/** Words of a caption: runs that contain a letter or a digit. Pure. */
export const wordCount = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The banned words or phrases that occur in a text, as whole words, ignoring case. Pure. */
export function bannedIn(text, banned = []) {
  const t = String(text || '').normalize('NFC');
  return banned.filter((b) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(b.normalize('NFC')).replace(/[- ]+/g, '[\\s\\-]+')}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(t));
}
const pathOnly = (u) => { let x = String(u || ''); try { if (/^https?:\/\//.test(x)) x = new URL(x).pathname; } catch { /* keep */ } return (x.split(/[?#]/)[0].replace(/\/+$/, '') || '/'); };
/** A scene address against a rule path: "/pricing" is that page, "/admin*" anything under it. Pure. */
export function pathMatches(url, rule) {
  const u = pathOnly(url);
  if (rule.endsWith('*')) { const base = rule.slice(0, -1).replace(/\/+$/, ''); return u === (base || '/') || u.startsWith((base || '') + '/') || (base !== '' && u.startsWith(base)); }
  return u === pathOnly(rule);
}
const hashtags = (s) => (String(s || '').match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).map((h) => h.trim());

/**
 * Errors of a normalized shot list against a template and rules: the measurable part only. Pure.
 * @param {object} s normalized (and styled) shot list
 * @param {{ template?: object|null, rules?: object }} t from resolveTemplate
 * @param {{ total: number }} m the planned total length in seconds, cards included
 */
export function checkRules(s, t, m) {
  const errors = [], inc = s.scenes.filter((x) => x.include !== false), r = t.rules || {};
  const tpl = t.template, by = (label) => `${label}${tpl ? ` (template "${tpl.name}")` : ''}`;
  if (tpl && tpl.slots) {
    const ids = tpl.slots.map((x) => x.id);
    for (const sc of inc) {
      if (sc.slot === undefined || sc.slot === null || sc.slot === '') errors.push(`Scene ${sc.id}: "slot" is missing. Template "${tpl.name}" has the slots ${ids.join(', ')}; put the one this scene fills, e.g. "slot": "${ids[0]}".`);
      else if (!ids.includes(sc.slot)) errors.push(`Scene ${sc.id}: "slot" is "${sc.slot}". Template "${tpl.name}" has the slots ${ids.join(', ')}.`);
    }
    for (const sl of tpl.slots) {
      const got = inc.filter((x) => x.slot === sl.id);
      if (got.length < sl.min || got.length > sl.max) {
        const want = sl.min === sl.max ? `${sl.min}` : `${sl.min} to ${sl.max}`;
        errors.push(`Slot "${sl.id}" of template "${tpl.name}" needs ${want} ${sl.max === 1 ? 'scene' : 'scenes'}, the shot list has ${got.length}${got.length ? ` (scene ${got.map((x) => x.id).join(', ')})` : ''}. ${got.length < sl.min ? `Add ${sl.min - got.length === 1 ? 'a scene' : `${sl.min - got.length} scenes`} with "slot": "${sl.id}"${sl.brief ? `: ${sl.brief}` : '.'}` : `Remove ${got.length - sl.max === 1 ? 'one' : got.length - sl.max} or switch ${got.length - sl.max === 1 ? 'it' : 'them'} off ("include": false).`}`);
      }
    }
    const order = inc.map((x) => ids.indexOf(x.slot)).filter((i) => i >= 0);
    const bad = order.findIndex((v, i) => i > 0 && v < order[i - 1]);
    if (bad > 0 && inc.every((x) => ids.includes(x.slot))) errors.push(`The scenes are not in the order of template "${tpl.name}" (${ids.join(' → ')}): scene ${inc[bad].id} ("${inc[bad].slot}") comes after a "${inc[bad - 1].slot}" scene. Reorder the scenes.`);
  }
  const c = r.captions || {};
  const texts = inc.filter((x) => x.caption).map((x) => ({ where: `Scene ${x.id}: the caption "${x.caption}"`, text: x.caption }));
  if (s.cover && typeof s.cover.headline === 'string' && s.cover.headline) texts.push({ where: `"cover.headline" "${s.cover.headline}"`, text: s.cover.headline });
  for (const { where, text } of texts) {
    if (c.maxWords && wordCount(text) > c.maxWords) errors.push(`${where} has ${wordCount(text)} words. ${by('The limit')} is ${c.maxWords}. Shorten it.`);
    const b = bannedIn(text, c.bannedWords || []);
    if (b.length) errors.push(`${where} uses ${b.map((x) => `"${x}"`).join(', ')}, which ${b.length === 1 ? 'is' : 'are'} banned (rules.captions.bannedWords). Use other words.`);
    if (c.noEmoji && hasEmoji(text)) errors.push(`${where} has an emoji. ${by('The rules')} say no emoji. Remove it.`);
  }
  const p = r.paths || {};
  for (const rule of p.mustShow || []) if (!inc.some((x) => pathMatches(x.url, rule))) errors.push(`No included scene shows ${rule}, which the rules require (rules.paths.mustShow). Add a scene with "url": "${rule.replace(/\*$/, '')}".`);
  for (const rule of p.neverShow || []) {
    for (const x of inc) {
      if (pathMatches(x.url, rule)) errors.push(`Scene ${x.id} shows ${pathOnly(x.url)}, which the rules forbid (rules.paths.neverShow: ${rule}). Remove the scene or switch it off ("include": false).`);
      (x.steps || []).forEach((st, j) => { if (st && st.do === 'goto' && pathMatches(st.url, rule)) errors.push(`Scene ${x.id}, step ${j + 1} goes to ${pathOnly(st.url)}, which the rules forbid (rules.paths.neverShow: ${rule}).`); });
    }
  }
  const l = r.length || {};
  if (l.total && (m.total < l.total[0] || m.total > l.total[1])) errors.push(`The video runs ${m.total} s with the cards. ${by('The rules')} want ${range(l.total)} (rules.length.total). ${m.total < l.total[0] ? 'Lengthen a scene or add one.' : 'Shorten a scene or switch one off.'}`);
  if (l.scene) for (const x of inc) if (x.duration < l.scene[0] || x.duration > l.scene[1]) errors.push(`Scene ${x.id}: "duration" is ${x.duration} s. ${by('The rules')} want ${range(l.scene)} per scene (rules.length.scene).`);
  const po = r.posts || {}, h = po.hashtags || {}, banned = po.bannedWords || c.bannedWords || [];
  for (const [k, post] of Object.entries(s.posts || {})) {
    if (!isObj(post)) continue;
    const text = Object.values(post).filter((v) => typeof v === 'string').join('\n');
    if (!text.trim()) continue;
    const tags = hashtags(text);
    if (h.max !== undefined && tags.length > h.max) errors.push(`"posts.${k}" has ${tags.length} hashtags. ${by('The rules')} allow ${h.max} (rules.posts.hashtags.max).`);
    for (const need of h.required || []) if (!tags.some((x) => x.toLowerCase() === need.toLowerCase())) errors.push(`"posts.${k}" lacks ${need}, which the rules require (rules.posts.hashtags.required).`);
    for (const no of h.banned || []) if (tags.some((x) => x.toLowerCase() === no.toLowerCase())) errors.push(`"posts.${k}" uses ${no}, which the rules forbid (rules.posts.hashtags.banned).`);
    const b = bannedIn(text, banned);
    if (b.length) errors.push(`"posts.${k}" uses ${b.map((x) => `"${x}"`).join(', ')}, which ${b.length === 1 ? 'is' : 'are'} banned (rules.${po.bannedWords ? 'posts' : 'captions'}.bannedWords).`);
    if (po.noEmoji && hasEmoji(text)) errors.push(`"posts.${k}" has an emoji. ${by('The rules')} say no emoji in post texts.`);
  }
  return errors;
}
