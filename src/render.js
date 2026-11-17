// The one renderer for everything that is drawn on top of the footage: captions, end card, cover.
// It lays text out in headless Chromium (real fonts, real line breaking) and saves transparent PNGs,
// which ffmpeg overlays. ffmpeg needs no text support for this.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAME, PLATFORMS, captionBox, insideSafe } from './presets.js';
import { placeCaption, placeCover, COVER_AREA } from './place.js';
import { PLUGIN_ROOT, ensureDir } from './util.js';
import { E } from './errors.js';

const FONTS = pathToFileURL(join(PLUGIN_ROOT, 'src', 'studio', 'public', 'fonts')).href;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Caption markup: the longest word is the stressed one and gets the highlight box. Same rule as the Studio preview. */
export function captionHTML(text) {
  if (!text) return '';
  const words = text.split(/(\s+)/);
  let best = -1, len = 3;
  words.forEach((w, i) => { const n = w.replace(/[^\p{L}\p{N}]/gu, '').length; if (n > len) { len = n; best = i; } });
  return words.map((w, i) => {
    if (i !== best) return esc(w);
    const m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
    return esc(m[1]) + '<mark>' + esc(m[2]) + '</mark>' + esc(m[3]);
  }).join('');
}

const HEAD = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: 'Sofia Sans Condensed'; font-weight: 600 900; src: url('${FONTS}/sofia-sans-condensed-latin.woff2') format('woff2'); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: 'Sofia Sans Condensed'; font-weight: 600 900; src: url('${FONTS}/sofia-sans-condensed-latin-ext.woff2') format('woff2'); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: 'Sofia Sans'; font-weight: 400 800; src: url('${FONTS}/sofia-sans-latin.woff2') format('woff2'); }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; background: transparent; }
body { position: relative; font-family: 'Sofia Sans Condensed', 'Arial Narrow', system-ui, sans-serif; }
.cap { position: absolute; display: flex; }
.cap .box { background: #0e0a1f; color: #fff; border-radius: 16px; padding: .28em .5em .32em; font-weight: 800; line-height: 1.16; max-width: 100%; text-wrap: balance; overflow-wrap: anywhere; }
.cap mark { background: #d7ff1f; color: #0e0a1f; border-radius: .16em; padding: 0 .14em; margin: 0 -.02em; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
</style>`;

function captionPage(platform, text) {
  const b = captionBox(platform), edge = `bottom:${b.bottom}px`;
  return `${HEAD}<div class="cap" style="left:${b.left}px;width:${b.width}px;${edge};justify-content:${b.align === 'left' ? 'flex-start' : 'center'}">
<div class="box" id="box" style="font-size:74px;text-align:${b.align}">${captionHTML(text)}</div></div>`;
}

/** Picks black or white text for a background colour. */
export function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0e0a1f' : '#ffffff';
}

function endCardPage(app) {
  const bg = /^#[0-9a-f]{6}$/i.test(app.brandColor || '') ? app.brandColor : '#0e0a1f', ink = inkOn(bg);
  const pill = ink === '#ffffff' ? ['#ffffff', '#0e0a1f'] : ['#0e0a1f', '#ffffff'];
  return `${HEAD}<style>html, body { background: ${bg}; }
.end { position: absolute; left: 110px; right: 110px; top: 300px; bottom: 700px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: ${ink}; }
.end b { font-weight: 900; font-size: 168px; line-height: .95; letter-spacing: -.01em; text-wrap: balance; }
.end span { margin-top: 56px; font: 700 58px/1 'Sofia Sans', system-ui, sans-serif; background: ${pill[0]}; color: ${pill[1]}; padding: 26px 52px 28px; border-radius: 80px; max-width: 100%; overflow-wrap: anywhere; }
.end small { margin-top: 52px; font: 600 46px/1.25 'Sofia Sans', system-ui, sans-serif; opacity: .88; text-wrap: balance; }
</style><div class="end" id="box"><b>${esc(app.name)}</b>${app.address ? `<span>${esc(app.address)}</span>` : ''}${app.tagline ? `<small>${esc(app.tagline)}</small>` : ''}</div>`;
}

function coverPage(frameFile, headline) {
  // The headline stays inside the part of the picture that survives the 4:5 and 1:1 grid crops (COVER_AREA).
  // It starts in the centre; renderOverlays moves it when the page's own headline is there.
  const a = COVER_AREA;
  return `${HEAD}<style>html, body { background: #0e0a1f url('${pathToFileURL(frameFile).href}') center / cover no-repeat; }
.cov { position: absolute; left: ${a.x}px; width: ${a.w}px; top: ${a.y}px; height: ${a.h}px; display: flex; align-items: center; justify-content: center; }
.cov .box { background: #0e0a1f; color: #fff; font-weight: 900; font-size: 112px; line-height: 1; padding: .2em .34em .24em; border-radius: 24px; text-align: center; text-wrap: balance; box-shadow: 11px 11px 0 #d7ff1f; max-width: 82%; overflow-wrap: anywhere; }
</style>${headline ? `<div class="cov"><div class="box" id="box">${esc(headline)}</div></div>` : ''}`;
}

/**
 * Renders all overlays for one cut.
 * @param {object} o { dir, shotlist, scenes: [{id, caption}], targets, coverFrame?: string, coverOut?: string }
 * @returns {Promise<{ captions: { [platform]: { [sceneId]: { file, rect, fontSize, inside } } }, endCard: string|null, cover: string|null }>}
 */
export async function renderOverlays(o) {
  const { dir, shotlist, scenes, targets } = o;
  ensureDir(dir);
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { throw E.browserMissing(); }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { if (/Executable doesn't exist|playwright install/i.test(String(e.message))) throw E.browserMissing(); throw e; }
  const out = { captions: {}, endCard: null, cover: null };
  try {
    const page = await browser.newPage({ viewport: { width: FRAME.width, height: FRAME.height }, deviceScaleFactor: 1 });
    const htmlFile = join(dir, 'overlay.html');
    const show = async (html) => { writeFileSync(htmlFile, html); await page.goto(pathToFileURL(htmlFile).href); await page.evaluate(() => document.fonts.ready); };
    const rectOf = () => page.evaluate(() => { const b = document.getElementById('box'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

    if (shotlist.cut.captions) {
      for (const t of targets) {
        out.captions[t] = {};
        const box = captionBox(t);
        for (const sc of scenes) {
          if (!sc.caption) continue;
          await show(captionPage(t, sc.caption));
          let size = 74, rect = await rectOf();
          while (rect.h > box.maxHeight || rect.h > size * 1.16 * 3 + size) { // more than three lines: shrink
            if (size <= 44) break;
            size -= 4;
            await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, size);
            rect = await rectOf();
          }
          // One position per scene: the bottom of the safe area, unless the clicked element, a large heading
          // or a fixed bar of the page is there (src/place.js). If no position is free at this size, a smaller
          // caption may fit under the click target instead of moving onto the page's headline.
          let spot = placeCaption(t, rect, sc.place || {});
          // To get off a click target the type may go down to 50 px; to get off page content only to 62 px, so that
          // a caption stays easy to read on a phone (page content is covered by something anyway).
          for (let smaller = size - 8; (spot.hard > 0 && smaller >= 50) || (spot.soft > 0 && smaller >= 62); smaller -= 8) {
            await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, smaller);
            const r2 = await rectOf(), s2 = placeCaption(t, r2, sc.place || {});
            if (s2.hard < spot.hard || (s2.hard === spot.hard && s2.soft < spot.soft)) { spot = s2; rect = r2; size = smaller; if (!s2.hard && !s2.soft) break; }
          }
          await page.evaluate((s) => { document.getElementById('box').style.fontSize = s + 'px'; }, size);
          rect = await rectOf();
          if (spot.moved) {
            await page.evaluate((y) => { const c = document.querySelector('.cap'); c.style.bottom = 'auto'; c.style.top = y + 'px'; }, spot.y);
            rect = await rectOf();
          }
          const file = join(dir, `cap-${t}-${sc.id}.png`);
          await page.screenshot({ path: file, omitBackground: true });
          out.captions[t][sc.id] = { file, rect, fontSize: size, band: spot.band, free: spot.free, covers: { click: spot.hard, page: spot.soft, kinds: spot.covers }, inside: insideSafe(t, rect) };
        }
      }
    }
    if (shotlist.cut.endCard) {
      await show(endCardPage(shotlist.app));
      out.endCard = join(dir, 'endcard.png');
      await page.screenshot({ path: out.endCard });
    }
    if (o.coverFrame && o.coverOut) {
      await show(coverPage(o.coverFrame, o.coverHeadline || ''));
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
