// The one renderer for everything that is drawn on top of the footage: captions, end card, cover, intro card and the
// corner logo. It lays text out in headless Chromium (real fonts, real line breaking) and saves transparent PNGs,
// which ffmpeg overlays. ffmpeg needs no text support for this.
//
// What they look like comes from the run's style (src/style.js). The page builders below take URL resolvers, so the
// Studio's Style screen shows exactly these pages, with http:// addresses instead of file:// ones.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAME, PLATFORMS, captionBox, insideSafe, safeRect } from './presets.js';
import { placeCaption, placeCover, COVER_AREA } from './place.js';
import { ensureDir } from './util.js';
import { BUNDLED_FONTS, FONT_DIR, STYLE_DIR, fontOf, projectFile, inkOn, css } from './style.js';
import { E } from './errors.js';

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A value for a single-quoted CSS string or url('…'): quotes, backslashes, line breaks and "<" escaped. Pure. */
export const cssStr = (s) => String(s).replace(/[\\'"<>\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
export { inkOn };

let BOLD = null;
/** The complete built-in "bold" style: the look when a caller passes none (tests, old callers). */
export function defaultLook() {
  if (!BOLD) { const d = JSON.parse(readFileSync(join(STYLE_DIR, 'bold.json'), 'utf8')); delete d.$schema; delete d.name; delete d.description; BOLD = d; }
  return JSON.parse(JSON.stringify(BOLD));
}

/** Caption markup: the longest word is the stressed one and gets the highlight. Same rule as the Studio preview. */
export function captionHTML(text, highlight = true) {
  if (!text) return '';
  if (!highlight) return esc(text);
  const words = text.split(/(\s+)/);
  let best = -1, len = 3;
  words.forEach((w, i) => { const n = w.replace(/[^\p{L}\p{N}]/gu, '').length; if (n > len) { len = n; best = i; } });
  return words.map((w, i) => {
    if (i !== best) return esc(w);
    const m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    return esc(m[1]) + '<mark>' + esc(m[2]) + '</mark>' + esc(m[3]);
  }).join('');
}

/** URL resolvers for the CLI: bundled fonts and project files as file:// addresses. */
export const fileUrls = { font: (name) => pathToFileURL(join(FONT_DIR, name)).href, file: (abs) => pathToFileURL(abs).href };

const UNICODE = {
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  ext: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
};
/**
 * The fonts a look uses: @font-face rules and a CSS family per font value. A font file of the project gets its own
 * family name, declared for every weight so Chromium uses the file as it is and does not fake a bold.
 */
export function fontsFor(look, { projectDir, urls = fileUrls } = {}) {
  const rules = [], fam = {};
  for (const [name, f] of Object.entries(BUNDLED_FONTS)) {
    const [latin, ext] = f.files;
    rules.push(`@font-face { font-family: '${name}'; font-weight: ${f.weights[0]} ${f.weights[1]}; src: url('${cssStr(urls.font(latin))}') format('woff2'); unicode-range: ${UNICODE.latin}; }`);
    rules.push(`@font-face { font-family: '${name}'; font-weight: ${f.weights[0]} ${f.weights[1]}; src: url('${cssStr(urls.font(ext))}') format('woff2'); unicode-range: ${UNICODE.ext}; }`);
  }
  let n = 0;
  const values = [look.captions.font, look.endCard.font, look.endCard.textFont, look.cover.font];
  for (const v of values) {
    if (fam[v]) continue;
    const f = fontOf(projectDir, v);
    if (f.bundled) fam[v] = { css: `'${f.bundled}'`, weights: BUNDLED_FONTS[f.bundled].weights };
    else if (f.file) {
      const alias = `Pushreel Project Font ${++n}`, ext = f.file.split('.').pop().toLowerCase(), format = { woff2: 'woff2', ttf: 'truetype', otf: 'opentype' }[ext];
      rules.push(`@font-face { font-family: '${alias}'; font-weight: 100 900; src: url('${cssStr(urls.file(f.file, f.rel))}') format('${format}'); }`);
      fam[v] = { css: `'${alias}'`, weights: [100, 900] };
    } else fam[v] = { css: "'Sofia Sans Condensed'", weights: [600, 900] };
  }
  const family = (v) => `${(fam[v] || fam[look.captions.font]).css}, 'Sofia Sans', system-ui, sans-serif`;
  const weight = (v, want) => { const w = (fam[v] || { weights: [100, 900] }).weights; return Math.max(w[0], Math.min(w[1], want)); };
  return { css: rules.join('\n'), family, weight };
}
/** A logo of the project as an image address, or null. */
function logoUrl(projectDir, value, urls) {
  if (!value) return null;
  const f = projectFile(projectDir, value, 'image');
  return f.file ? urls.file(f.file, f.rel) : null;
}

const SHADOWS = {
  none: () => 'none',
  soft: () => '0 14px 44px rgb(10 8 25 / .26), 0 2px 6px rgb(10 8 25 / .18)',
  hard: (c) => `8px 8px 0 ${css(c)}`,
  glow: (c) => `0 0 0 2px ${css(c)}, 0 0 34px ${css(c)}`,
};
const ink = (color, bg) => (color === 'auto' ? inkOn(bg) : color);

function head(fonts, extra = '') {
  return `<!doctype html><meta charset="utf-8"><style>
${fonts.css}
* { box-sizing: border-box; margin: 0; }
html, body { width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; background: transparent; }
body { position: relative; }
${extra}</style>`;
}

/** The caption's CSS for a look. Exported for tests. */
export function captionCSS(look, fonts) {
  const c = look.captions, hl = c.highlight !== 'none' ? c.highlight : null;
  const glowCol = hl || c.border !== 'none' && c.border || '#ffffff';
  const shadow = c.shadow === 'hard' || c.shadow === 'glow' ? SHADOWS[c.shadow](c.shadow === 'glow' && c.border !== 'none' ? c.border : glowCol) : SHADOWS[c.shadow]();
  const markBox = hl && c.highlightStyle === 'box';
  return `.cap { position: absolute; display: flex; }
.cap .box { background: ${css(c.background)}; color: ${css(c.color)}; border-radius: ${c.radius}px; padding: .28em .5em .32em; font-family: ${fonts.family(c.font)}; font-weight: ${fonts.weight(c.font, c.weight)}; line-height: 1.16; max-width: 100%; text-wrap: balance; overflow-wrap: anywhere;${c.uppercase ? ' text-transform: uppercase; letter-spacing: .02em;' : ''}${c.border !== 'none' ? ` border: 4px solid ${css(c.border)};` : ''} box-shadow: ${shadow}; }
.cap mark { ${markBox ? `background: ${css(hl)}; color: ${css(ink(c.highlightText, hl))}; border-radius: .16em; padding: 0 .14em; margin: 0 -.02em; -webkit-box-decoration-break: clone; box-decoration-break: clone;` : hl ? `background: none; color: ${css(hl)};` : 'background: none; color: inherit;'}${hl && c.shadow === 'glow' ? ` text-shadow: 0 0 18px ${css(hl)};` : ''} }`;
}

/** The caption page for one platform; the box starts at its home position (bottom or top of the safe area). */
export function captionPage(platform, text, look = defaultLook(), o = {}) {
  const fonts = fontsFor(look, o), b = captionBox(platform), c = look.captions;
  const edge = c.position === 'top' ? `top:${safeRect(platform).y}px` : `bottom:${b.bottom}px`;
  return `${head(fonts, captionCSS(look, fonts))}<div class="cap" style="left:${b.left}px;width:${b.width}px;${edge};justify-content:${b.align === 'left' ? 'flex-start' : 'center'}">
<div class="box" id="box" style="font-size:${c.size}px;text-align:${b.align}">${captionHTML(text, c.highlight !== 'none')}</div></div>`;
}

/** The end card. */
export function endCardPage(app, look = defaultLook(), o = {}) {
  const fonts = fontsFor(look, o), e = look.endCard, bg = e.background, fg = ink(e.color, bg);
  const pillBg = e.accent === 'auto' ? fg : e.accent, pillFg = inkOn(pillBg);
  const glow = look.cover.shadow === 'glow', logo = logoUrl(o.projectDir, e.logo, o.urls || fileUrls);
  const text = e.text || app.name || '', cta = e.cta === null || e.cta === undefined ? app.address || '' : e.cta;
  return `${head(fonts, `html, body { background: ${css(bg)}; }
.end { position: absolute; left: 110px; right: 110px; top: 300px; bottom: 700px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: ${css(fg)}; }
.end img { max-width: 340px; max-height: 260px; object-fit: contain; margin-bottom: 56px; }
.end b { font-family: ${fonts.family(e.font)}; font-weight: ${fonts.weight(e.font, 900)}; font-size: ${look.cover.uppercase ? 140 : 168}px; line-height: .95; letter-spacing: -.01em; text-wrap: balance; overflow-wrap: anywhere;${look.cover.uppercase ? ' text-transform: uppercase;' : ''}${glow ? ` text-shadow: 0 0 36px ${css(look.cover.accent)};` : ''} }
.end span { margin-top: 56px; font-family: ${fonts.family(e.textFont)}; font-weight: ${fonts.weight(e.textFont, 700)}; font-size: 58px; line-height: 1; background: ${css(pillBg)}; color: ${css(pillFg)}; padding: 26px 52px 28px; border-radius: 80px; max-width: 100%; overflow-wrap: anywhere;${glow ? ` box-shadow: 0 0 44px ${css(pillBg)};` : ''} }
.end small { margin-top: 52px; font-family: ${fonts.family(e.textFont)}; font-weight: ${fonts.weight(e.textFont, 600)}; font-size: 46px; line-height: 1.25; opacity: .88; text-wrap: balance; }`)}
<div class="end" id="box">${logo ? `<img src="${esc(logo)}" alt="">` : ''}${text ? `<b>${esc(text)}</b>` : ''}${cta ? `<span>${esc(cta)}</span>` : ''}${e.tagline && app.tagline ? `<small>${esc(app.tagline)}</small>` : ''}</div>`;
}

/** The cover: a frame of the video with the headline box (and the logo on top of it). */
export function coverPage(frameUrl, headline, look = defaultLook(), o = {}) {
  // The headline stays inside the part of the picture that survives the 4:5 and 1:1 grid crops (COVER_AREA).
  // It starts in the centre; renderOverlays moves it when the page's own headline is there.
  const fonts = fontsFor(look, o), cv = look.cover, a = COVER_AREA, logo = logoUrl(o.projectDir, cv.logo, o.urls || fileUrls);
  const shadow = cv.shadow === 'hard' ? `11px 11px 0 ${css(cv.accent)}` : cv.shadow === 'glow' ? `0 0 0 3px ${css(cv.accent)}, 0 0 48px ${css(cv.accent)}` : SHADOWS[cv.shadow]();
  const show = headline || logo;
  return `${head(fonts, `html, body { background: #0e0a1f ${frameUrl ? `url('${cssStr(frameUrl)}') center / cover no-repeat` : ''}; }
.cov { position: absolute; left: ${a.x}px; width: ${a.w}px; top: ${a.y}px; height: ${a.h}px; display: flex; align-items: center; justify-content: center; }
.stack { display: flex; flex-direction: column; align-items: center; gap: 30px; max-width: 82%; }
.stack img { max-width: 300px; max-height: 150px; object-fit: contain; padding: 22px 30px; border-radius: ${Math.max(12, cv.radius)}px; background: ${css(cv.background)}; box-shadow: ${shadow}; }
.hl { background: ${css(cv.background)}; color: ${css(cv.color)}; font-family: ${fonts.family(cv.font)}; font-weight: ${fonts.weight(cv.font, 900)}; font-size: ${cv.uppercase ? 96 : 112}px; line-height: 1; padding: .2em .34em .24em; border-radius: ${cv.radius}px; text-align: center; text-wrap: balance; box-shadow: ${shadow}; overflow-wrap: anywhere;${cv.uppercase ? ' text-transform: uppercase; letter-spacing: .01em;' : ''} }`)}
${show ? `<div class="cov"><div class="stack" id="box">${logo ? `<img src="${esc(logo)}" alt="">` : ''}${headline ? `<div class="hl">${esc(headline)}</div>` : ''}</div></div>` : ''}`;
}

/** The intro card before the first scene. */
export function introPage(text, look = defaultLook(), o = {}) {
  const fonts = fontsFor(look, o), it = look.intro, bg = it.background, fg = ink(it.color, bg), logo = logoUrl(o.projectDir, it.logo, o.urls || fileUrls);
  const glow = look.cover.shadow === 'glow';
  return `${head(fonts, `html, body { background: ${css(bg)}; }
.intro { position: absolute; left: 110px; right: 110px; top: 300px; bottom: 700px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 56px; text-align: center; color: ${css(fg)}; }
.intro img { max-width: 380px; max-height: 300px; object-fit: contain; }
.intro b { font-family: ${fonts.family(look.endCard.font)}; font-weight: ${fonts.weight(look.endCard.font, 900)}; font-size: ${look.cover.uppercase ? 120 : 140}px; line-height: 1; letter-spacing: -.01em; text-wrap: balance; overflow-wrap: anywhere;${look.cover.uppercase ? ' text-transform: uppercase;' : ''}${glow ? ` text-shadow: 0 0 36px ${css(look.cover.accent)};` : ''} }`)}
<div class="intro" id="box">${logo ? `<img src="${esc(logo)}" alt="">` : ''}${text ? `<b>${esc(text)}</b>` : ''}</div>`;
}

/** Where the corner logo sits on one platform: a corner of the safe area. Pure. */
export function watermarkRect(platform, look, aspect = 1) {
  const w = look.watermark, r = safeRect(platform), width = w.size, height = Math.round(Math.min(w.size, width / Math.max(0.2, aspect)));
  const x = w.corner.endsWith('left') ? r.x : r.x + r.w - width, y = w.corner.startsWith('top') ? r.y : r.y + r.h - height;
  return { x: Math.round(x), y: Math.round(y), w: width, h: height };
}
export function watermarkPage(platform, look, o = {}) {
  const logo = logoUrl(o.projectDir, look.watermark.logo, o.urls || fileUrls);
  if (!logo) return null;
  const r = watermarkRect(platform, look);
  return `${head({ css: '' }, `img { position: absolute; left: ${r.x}px; ${look.watermark.corner.startsWith('top') ? `top: ${r.y}px` : `bottom: ${FRAME.height - r.y - r.h}px`}; width: ${r.w}px; max-height: ${r.w}px; object-fit: contain; object-position: ${look.watermark.corner.endsWith('left') ? 'left' : 'right'} ${look.watermark.corner.startsWith('top') ? 'top' : 'bottom'}; opacity: ${look.watermark.opacity}; }`)}<img id="box" src="${esc(logo)}" alt="">`;
}

/**
 * Renders all overlays for one cut.
 * @param {object} o { dir, shotlist, scenes: [{id, caption, place}], targets, coverFrame?, coverOut?, coverHeadline?, coverLayout?, projectDir? }
 * @returns {Promise<{ captions: { [platform]: { [sceneId]: { file, rect, fontSize, inside } } }, endCard: string|null, cover: string|null, intro: string|null, watermark: { [platform]: { file, rect } } }>}
 */
export async function renderOverlays(o) {
  const { dir, shotlist, scenes, targets } = o, look = shotlist.look || defaultLook(), po = { projectDir: o.projectDir };
  ensureDir(dir);
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { throw E.browserMissing(); }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { if (/Executable doesn't exist|playwright install/i.test(String(e.message))) throw E.browserMissing(); throw e; }
  const out = { captions: {}, endCard: null, cover: null, intro: null, watermark: {} };
  try {
    const page = await browser.newPage({ viewport: { width: FRAME.width, height: FRAME.height }, deviceScaleFactor: 1 });
    const htmlFile = join(dir, 'overlay.html');
    const show = async (html) => { writeFileSync(htmlFile, html); await page.goto(pathToFileURL(htmlFile).href); await page.evaluate(() => document.fonts.ready); await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))))); };
    const rectOf = () => page.evaluate(() => { const b = document.getElementById('box'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

    // The corner logo first: the captions keep off it.
    if (look.watermark.enabled && look.watermark.logo) {
      for (const t of targets) {
        const html = watermarkPage(t, look, po);
        if (!html) break;
        await show(html);
        const rect = await rectOf(), file = join(dir, `wm-${t}.png`);
        await page.screenshot({ path: file, omitBackground: true });
        out.watermark[t] = { file, rect };
      }
    }
    if (shotlist.cut.captions) {
      const base = look.captions.size;
      for (const t of targets) {
        out.captions[t] = {};
        const box = captionBox(t), avoid = out.watermark[t] ? [{ ...out.watermark[t].rect, kind: 'logo', weight: 3 }] : [];
        for (const sc of scenes) {
          if (!sc.caption) continue;
          await show(captionPage(t, sc.caption, look, po));
          let size = base, rect = await rectOf();
          while (rect.h > box.maxHeight || rect.h > size * 1.16 * 3 + size) { // more than three lines: shrink
            if (size <= 44) break;
            size -= 4;
            await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, size);
            rect = await rectOf();
          }
          const where = { ...(sc.place || {}), prefer: look.captions.position, avoid };
          // One position per scene: the home position of the style (bottom or top of the safe area), unless the clicked
          // element, a large heading, a picture, a fixed bar or the corner logo is there (src/place.js). If no position
          // is free at this size, a smaller caption may fit instead of moving onto the page's headline.
          let spot = placeCaption(t, rect, where);
          // To get off a click target the type may go down to 50 px; to get off page content only to 62 px (or the
          // style's own size if that is smaller), so that a caption stays easy to read on a phone.
          const floorHard = Math.min(50, base), floorSoft = Math.min(62, base);
          for (let smaller = size - 8; (spot.hard > 0 && smaller >= floorHard) || (spot.soft > 0 && smaller >= floorSoft); smaller -= 8) {
            await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, smaller);
            const r2 = await rectOf(), s2 = placeCaption(t, r2, where);
            if (s2.hard < spot.hard || (s2.hard === spot.hard && s2.soft < spot.soft)) { spot = s2; rect = r2; size = smaller; if (!s2.hard && !s2.soft) break; }
          }
          await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, size);
          await page.evaluate((y) => { const c = document.querySelector('.cap'); c.style.bottom = 'auto'; c.style.top = y + 'px'; }, spot.y);
          rect = await rectOf();
          const file = join(dir, `cap-${t}-${sc.id}.png`);
          await page.screenshot({ path: file, omitBackground: true });
          out.captions[t][sc.id] = { file, rect, fontSize: size, band: spot.band, home: spot.home, free: spot.free, covers: { click: spot.hard, page: spot.soft, kinds: spot.covers }, inside: insideSafe(t, rect) };
        }
      }
    }
    if (shotlist.cut.endCard) {
      await show(endCardPage(shotlist.app, look, po));
      out.endCard = join(dir, 'endcard.png');
      await page.screenshot({ path: out.endCard });
    }
    if (shotlist.cut.introSeconds > 0) {
      await show(introPage(look.intro.text || (shotlist.cover && shotlist.cover.headline) || shotlist.app.name, look, po));
      out.intro = join(dir, 'intro.png');
      await page.screenshot({ path: out.intro });
    }
    if (o.coverFrame && o.coverOut) {
      await show(coverPage(pathToFileURL(o.coverFrame).href, o.coverHeadline || '', look, po));
      const rect = await rectOf();
      if (rect) {
        const spot = placeCover(rect, o.coverLayout || {});
        if (spot.moved) await page.evaluate((y) => { const c = document.querySelector('.cov'); c.style.height = 'auto'; c.style.top = y + 'px'; }, spot.y);
        out.coverBand = spot.band; out.coverCovers = spot.covers;
      }
      await page.screenshot({ path: o.coverOut });
      out.cover = o.coverOut;
    }
  } finally { await browser.close().catch(() => {}); }
  return out;
}
export { PLATFORMS };
