// `pushreel style init`: reads the brand of the running app (main colour, main font, logo) and proposes a
// pushreel.style.json. The page is read in headless Chromium: computed styles, the theme-color meta, CSS custom
// properties named like "primary" or "brand", the favicon and the logo element. Fixed code, no model.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { launch, newContext, settle, abs } from './browser.js';
import { BUNDLED_FONTS, FONT_EXT, IMAGE_EXT, parseColor, luminance, projectFile } from './style.js';

/** Runs in the page. Collects colour, font and logo candidates. Must not use anything from outside. */
export function collect() {
  const out = { colors: [], fonts: {}, logos: [], faces: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.1; };
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && meta.content) out.colors.push({ value: meta.content.trim(), source: '<meta name="theme-color">', rank: 2 });
  const rootVars = new Set();
  for (const sheet of [...document.styleSheets]) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of [...rules]) {
      if (r.type === 1 && /(^|,)\s*(:root|html)\s*($|,)/.test(r.selectorText || '')) for (const n of [...r.style]) if (n.startsWith('--')) rootVars.add(n);
      if (r.type === 5) out.faces.push({ family: r.style.getPropertyValue('font-family').replace(/["']/g, '').trim(), src: r.style.getPropertyValue('src') });
    }
  }
  const rs = getComputedStyle(document.documentElement);
  for (const n of rootVars) if (/primary|brand|accent|main/i.test(n)) out.colors.push({ value: rs.getPropertyValue(n).trim(), source: `CSS variable ${n}`, rank: 1 });
  // Buttons and links that look like buttons: their background, weighted by area.
  const area = {};
  for (const el of [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')].slice(0, 300)) {
    if (!vis(el) || el.closest('#__pushreel_cursor')) continue;
    const r = el.getBoundingClientRect(), bg = getComputedStyle(el).backgroundColor;
    if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) area[bg] = (area[bg] || 0) + r.width * r.height;
  }
  for (const [value, a] of Object.entries(area).sort((x, y) => y[1] - x[1]).slice(0, 4)) out.colors.push({ value, source: 'background of buttons', rank: 3, area: a });
  const link = [...document.querySelectorAll('a')].find((a) => vis(a));
  if (link) out.colors.push({ value: getComputedStyle(link).color, source: 'link colour', rank: 4 });
  const h1 = [...document.querySelectorAll('h1')].find(vis);
  if (h1) out.colors.push({ value: getComputedStyle(h1).color, source: 'colour of the h1', rank: 5 });
  out.fonts.heading = h1 ? getComputedStyle(h1).fontFamily : null;
  out.fonts.body = getComputedStyle(document.body).fontFamily;
  const href = (el, attr) => { try { return new URL(el.getAttribute(attr), location.href).href; } catch (e) { return null; } };
  for (const el of [...document.querySelectorAll('img')].filter(vis)) {
    const s = `${el.alt} ${el.className} ${el.id} ${el.getAttribute('src')}`;
    if (/logo|brand/i.test(s) || el.closest('header, nav, [class*="logo" i], [class*="brand" i]')) out.logos.push({ url: href(el, 'src'), source: `<img${el.alt ? ` alt="${el.alt}"` : ''}> on the page`, rank: /logo|brand/i.test(s) ? 1 : 2 });
  }
  const svg = [...document.querySelectorAll('[class*="logo" i] svg, [id*="logo" i] svg, svg[class*="logo" i], header svg, a[href="/"] svg')].find(vis);
  for (const el of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')) out.logos.push({ url: href(el, 'href'), source: `<link rel="${el.getAttribute('rel')}">`, rank: el.getAttribute('rel') === 'apple-touch-icon' ? 3 : 4 });
  // An inline SVG is often an icon, not the logo: only when no file was found.
  if (svg) out.logos.push({ inline: svg.outerHTML.slice(0, 200000), source: 'an inline <svg> logo on the page', rank: 5 });
  return out;
}

/** "rgb(91, 61, 245)" or "#5b3df5" → "#5b3df5", or null. Pure. */
export function toHex(v) {
  const s = String(v || '').trim();
  if (parseColor(s)) { const c = parseColor(s); return '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join(''); }
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < (m[4].endsWith('%') ? 50 : 0.5)) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
}
/** A colour that can carry a brand: not near white, black or grey. Pure. */
export function chromatic(hex) {
  const c = parseColor(hex);
  if (!c) return false;
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b), l = luminance(c);
  return max - min > 40 && l > 0.02 && l < 0.85;
}
/**
 * The brand colour from the page's candidates, chromatic only. What the site declares comes first (a CSS variable
 * named primary or brand, then the theme-color meta), then what it shows (buttons by area, links, the h1). Among
 * buttons a colour that is also a link colour or the theme colour wins over a palette colour. Pure.
 */
export function pickColor(cands) {
  const list = cands.map((c) => ({ ...c, hex: toHex(c.value) })).filter((c) => c.hex && chromatic(c.hex));
  const seen = (hex) => new Set(list.filter((c) => c.hex === hex).map((c) => c.source)).size;
  list.sort((a, b) => a.rank - b.rank || seen(b.hex) - seen(a.hex) || (b.area || 0) - (a.area || 0));
  return list[0] || null;
}
/** The first family of a CSS font-family list, without quotes. Pure. */
export const firstFamily = (ff) => String(ff || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

const WEB_ROOTS = ['', 'public', 'static', 'assets', 'dist', 'build', 'web', 'www', 'src', 'app', 'resources', 'storage/app/public'];
const SKIP = new Set(['node_modules', '.git', '.pushreel', 'pushreel-out', 'vendor', '.next', '.nuxt', '.svelte-kit', 'coverage']);
/**
 * The file in the project that an address of the running app serves, found by its path under the usual web roots, then
 * by its file name (at most 6 folders deep). Only files with one of `exts`.
 */
export function findProjectFile(dir, url, exts) {
  let path;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  const ext = extname(path).toLowerCase();
  if (!exts.includes(ext) || path.includes('..')) return null;
  for (const r of WEB_ROOTS) { const f = join(dir, r, path); if (existsSync(f) && statSync(f).isFile()) return relative(dir, f).split(sep).join('/'); }
  const name = basename(path), hits = [];
  const walk = (d, depth) => {
    if (depth > 6 || hits.length) return;
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), depth + 1); }
      else if (e.name === name) hits.push(join(d, e.name));
    }
  };
  walk(dir, 0);
  return hits[0] ? relative(dir, hits[0]).split(sep).join('/') : null;
}
/** The face file of a family from the page's @font-face rules, if the project has it. */
function fontFile(dir, family, faces, baseUrl) {
  for (const f of faces.filter((x) => x.family.toLowerCase() === family.toLowerCase())) {
    for (const m of String(f.src).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      let u; try { u = new URL(m[1], baseUrl).href; } catch { continue; }
      const rel = findProjectFile(dir, u, FONT_EXT);
      if (rel) return rel;
    }
  }
  return null;
}
const nearestBundled = (family) => (/mono|code|courier/i.test(family) ? 'Spline Sans Mono' : /condensed|narrow|compressed/i.test(family) ? 'Sofia Sans Condensed' : 'Sofia Sans');

/**
 * Reads the brand of the app at `url`.
 * @returns {Promise<{ color: {hex, source}|null, colors: Array, font: { value, family, source, note? }, logo: { value, source, note? }|null, notes: string[] }>}
 */
export async function detectBrand(dir, { url, path = '/' }) {
  const { browser, vp } = await launch(360);
  const notes = [];
  try {
    const ctx = await newContext(browser, vp, { cursor: false });
    const page = await ctx.newPage();
    const target = abs(url, path);
    await page.goto(target, { waitUntil: 'load', timeout: 20000 });
    await settle(page);
    const raw = await page.evaluate(collect);
    const color = pickColor(raw.colors);
    if (!color) notes.push('No brand colour found (no chromatic button, link, theme-color or CSS variable). The style keeps the colours of its base style.');
    // font: the heading's family, else the body's
    const fam = firstFamily(raw.fonts.heading) || firstFamily(raw.fonts.body);
    let font;
    const bundled = Object.keys(BUNDLED_FONTS).find((n) => n.toLowerCase() === fam.toLowerCase());
    if (bundled) font = { value: bundled, family: fam, source: 'bundled with Pushreel' };
    else {
      const file = fam ? fontFile(dir, fam, raw.faces, page.url()) : null;
      if (file) font = { value: file, family: fam, source: `your project's font file (from the page's @font-face)` };
      else { font = { value: nearestBundled(fam), family: fam, source: 'the nearest bundled font', note: fam ? `Your app uses "${fam}", and its font file (.ttf, .otf or .woff2) was not found in the project. Using ${nearestBundled(fam)}; to use yours, copy the file into the project and run: pushreel style set captions.font=<path>` : 'No font found on the page.' }; notes.push(font.note); }
    }
    // logo: a logo image of the project, an inline SVG (written next to the style file), the favicon
    let logo = null;
    for (const l of raw.logos.sort((a, b) => a.rank - b.rank)) {
      if (l.url) { const rel = findProjectFile(dir, l.url, IMAGE_EXT); if (rel && !projectFile(dir, rel, 'image').problem) { logo = { value: rel, source: l.source }; break; } }
      else if (l.inline && !logo) {
        const svg = l.inline.includes('xmlns=') ? l.inline : l.inline.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        logo = { value: 'pushreel.logo.svg', source: l.source, inline: svg };
        break;
      }
    }
    if (!logo) notes.push(raw.logos.length ? 'A logo was named by the page, but no PNG or SVG file of it was found in the project (a .ico favicon cannot be used). Add one with: pushreel style set endCard.logo=<file.png|svg>' : 'No logo found. Add one with: pushreel style set endCard.logo=<file.png|svg>');
    return { color, colors: raw.colors.map((c) => ({ ...c, hex: toHex(c.value) })).filter((c) => c.hex), font, logo, notes, page: page.url() };
  } finally { await browser.close().catch(() => {}); }
}

/** The project style that `style init` writes from what it found. Pure. */
export function styleFromBrand(found, base = 'bold') {
  const st = { $schema: 'https://raw.githubusercontent.com/IonFlux84/pushreel/main/docs/style.schema.json', extends: base };
  if (found.color) { st.endCard = { background: found.color.hex }; st.cover = { accent: found.color.hex }; }
  if (found.font && found.font.value) st.captions = { font: found.font.value };
  if (found.logo) { st.endCard = { ...(st.endCard || {}), logo: found.logo.value }; st.cover = { ...(st.cover || {}), logo: found.logo.value }; }
  return st;
}
/**
 * An inline SVG copied from the app's page, made safe to keep as a file: no <script>, no <foreignObject>, no
 * event handler attributes (on…), no javascript: and no reference to anything outside the file (href, xlink:href,
 * src or CSS url() other than "#id" or an embedded raster data: image), no DOCTYPE or entities. Pure.
 */
export function sanitizeSvg(svg) {
  let s = String(svg || '');
  for (let i = 0, before = null; i < 5 && before !== s; i++) {
    before = s;
    s = s.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '').replace(/<!ENTITY[\s\S]*?>/gi, '').replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<(script|foreignObject|iframe|object|embed|handler|listener)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|foreignObject|iframe|object|embed|handler|listener)\b[^>]*\/?>/gi, '')
      .replace(/<\/(script|foreignObject|iframe|object|embed|handler|listener)\s*>/gi, '')
      .replace(/\s(on[a-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s((?:xlink:)?href|src|action|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, name, _v, d, q, b) => {
        const v = (d ?? q ?? b ?? '').trim();
        return /^#[\w.:-]*$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i.test(v) ? m : '';
      })
      .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/<(a)\b[^>]*>/gi, '<g>').replace(/<\/a\s*>/gi, '</g>');
  }
  return s;
}
export function writeInlineLogo(dir, found) { if (found.logo && found.logo.inline) writeFileSync(join(dir, found.logo.value), sanitizeSvg(found.logo.inline) + '\n'); }
