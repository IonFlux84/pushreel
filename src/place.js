// Where overlays sit. Pure functions over rectangles: no browser, no files. Everything here is unit tested.
//
// A caption sits at the bottom of the platform's safe area. The rules, in this order:
//   1. never cover the element that is being clicked
//   2. avoid large headings, fixed bars, pictures (images, avatars, drawings) and card titles of the page, also
//      where the click zoom moves and enlarges them
//   if no spot is free: the spot that covers least, by measured overlap (the run log says what it covers)
//   3. otherwise stay as close to the preferred position as possible
// One position per scene: the function is called once per scene and platform.
import { FRAME, PLATFORMS, safeRect } from './presets.js';

export const GRAZE = 0.12; // share of a click target that may disappear under a caption's edge
export const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Finds the vertical position of a box inside an area.
 * @param {object} o
 *   area   { x, y, w, h }   where the box may sit (px)
 *   size   { w, h }         measured box
 *   align  'left' | 'center'
 *   hard   [{x,y,w,h}]      must not be covered (rule 1); `hard` in the result is the covered share of the worst one
 *   soft   [{x,y,w,h,weight?}]  should not be covered (rule 2); weight = share of the scene it is visible, default 1
 *   prefer 'bottom' | 'center'
 *   step   distance between candidate positions (px)
 * @returns {{ x, y, band, hard, soft, moved }} band: 'bottom' | 'lower-middle' | 'upper-middle' | 'top' | 'center'
 */
export function placeBand({ area, size, align = 'center', hard = [], soft = [], prefer = 'bottom', step = 48 }) {
  const x = align === 'left' ? area.x : area.x + (area.w - size.w) / 2;
  const maxY = area.y + Math.max(0, area.h - size.h), minY = area.y;
  const home = prefer === 'center' ? Math.round(area.y + (area.h - size.h) / 2) : maxY;
  const ys = new Set([home]);
  for (let y = home - step; y >= minY; y -= step) ys.add(Math.round(y));
  for (let y = home + step; y <= maxY; y += step) ys.add(Math.round(y));
  if (maxY > minY) { ys.add(minY); ys.add(maxY); }
  const boxArea = Math.max(1, size.w * size.h);
  const score = (y) => {
    const box = { x, y, w: size.w, h: size.h };
    // hard: the largest share of any one target that the box would cover (of the box, if the target is the larger
    // one). Grazing a target's edge (under GRAZE) counts as not covering it: the element stays readable, and the caption does not flee across the picture.
    const h = hard.reduce((n, r) => Math.max(n, overlap(box, r) / Math.max(1, Math.min(r.w * r.h, boxArea))), 0);
    const s = soft.reduce((n, r) => n + overlap(box, r) * (r.weight ?? 1), 0) / boxArea;
    // soft overlap is compared in steps of a tenth of the box, so that a sliver of a heading does not decide
    return { y, hard: h < GRAZE ? 0 : h, soft: s < 0.06 ? 0 : Math.round(s / 0.1) * 0.1, dist: Math.abs(y - home) };
  };
  const all = [...ys].map(score).sort((a, b) => a.hard - b.hard || a.soft - b.soft || a.dist - b.dist || b.y - a.y), best = all[0];
  // What the chosen spot still covers, by kind and share of the box: logged when no free spot existed.
  const box = { x, y: best.y, w: size.w, h: size.h }, by = {};
  // the worst moment per kind: the largest share of the caption that one element covers
  for (const r of soft) { const o = Math.min(1, overlap(box, r) / boxArea); if (o > 0.02) by[r.kind || 'page'] = round2(Math.max(by[r.kind || 'page'] || 0, o)); }
  return { x: Math.round(x), y: best.y, band: bandName(best.y + size.h / 2, best.y === home, prefer), hard: round2(best.hard), soft: round2(best.soft), moved: best.y !== home, covers: by, free: !best.hard && !best.soft };
}
const round2 = (n) => Math.round(n * 100) / 100;
function bandName(centerY, isHome, prefer) {
  if (isHome) return prefer;
  const f = centerY / FRAME.height;
  return f < 0.3 ? 'top' : f < 0.5 ? 'upper-middle' : 'lower-middle';
}

/**
 * The part of a clicked element that must stay visible: the element itself, but at most CLICK_REACH of the frame
 * height around the click point. A whole card that is clicked does not forbid half the picture. Pure.
 * @param {{x,y,w,h}} click fractions of the frame; (x, y) is the click point
 */
export const CLICK_REACH = 0.16;
export const clickFocus = (click) => ({ ...click, h: Math.min(click.h || 0.05, CLICK_REACH) });

/** Fractions of the frame → pixels. */
export const toPx = (r) => ({ x: r.x * FRAME.width, y: r.y * FRAME.height, w: r.w * FRAME.width, h: r.h * FRAME.height });

/**
 * How much each kind of page element counts when a caption would cover it (rule 2). The page's h1 counts double;
 * pictures (images, avatars, mascots, drawings, canvas, video, background images) count more than text, because a
 * caption on a face or an illustration is what a viewer notices first; card titles count less, they are content.
 */
export const WEIGHTS = { headline: 2, heading: 1, bar: 1, picture: 1.5, title: 0.6 };
export const SAMPLE = 0.25; // seconds between the moments a scene is looked at

/** A rectangle (fractions of the unzoomed frame) where it shows while the picture is zoomed by z on (x, y). Pure. */
export function zoomRect(r, { z, x, y }) {
  const W = FRAME.width, H = FRAME.height;
  if (!(z > 1.001)) return toPx(r);
  const ox = Math.min(Math.max(x * W * z - W / 2, 0), W * z - W), oy = Math.min(Math.max(y * H * z - H / 2, 0), H * z - H);
  const x0 = Math.max(0, r.x * W * z - ox), y0 = Math.max(0, r.y * H * z - oy);
  const x1 = Math.min(W, (r.x + r.w) * W * z - ox), y1 = Math.min(H, (r.y + r.h) * H * z - oy);
  return x1 - x0 < 4 || y1 - y0 < 4 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The value of zoom keyframes at time t (same smoothstep as the cut). Pure. */
export function zoomAt(kf = [], t = 0) {
  if (!kf.length || t <= kf[0].t) return { z: 1, x: kf[0] ? kf[0].x : 0.5, y: kf[0] ? kf[0].y : 0.5 };
  for (let i = 1; i < kf.length; i++) {
    const a = kf[i - 1], b = kf[i];
    if (t <= b.t) { const p = (t - a.t) / Math.max(1e-6, b.t - a.t), e = p * p * (3 - 2 * p); return { z: a.z + (b.z - a.z) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }; }
  }
  const l = kf[kf.length - 1];
  return { z: l.z, x: l.x, y: l.y };
}

const KINDS = [['headings', (r) => (r.big ? 'headline' : 'heading')], ['bars', () => 'bar'], ['pictures', () => 'picture'], ['titles', () => 'title']];

/**
 * What the page shows during a scene, as weighted rectangles for rule 2. The scene is looked at every SAMPLE
 * seconds: the layout snapshot on screen then, moved and enlarged by the click zoom when it is zoomed in. So a card
 * title that the zoom blows up into the caption's band counts, and so does a picture that only scrolls in.
 * @param {Array<{t, headings, bars, pictures?, titles?}>} layout snapshots (fractions of the frame, scene time in s)
 * @param {number} length seconds the scene lasts
 * @param {Array<{t,z,x,y}>} zoom the scene's zoom keyframes (cut time), or none
 * @returns {Array<{x,y,w,h,weight,kind}>} px; weight = share of the scene the rectangle is there × WEIGHTS[kind]
 */
export function softRects(layout = [], length = 1, zoom = []) {
  const snaps = [...layout].sort((a, b) => a.t - b.t).filter((s) => s.t < length);
  if (!snaps.length) return [];
  const acc = new Map();
  for (let t0 = 0; t0 < length - 1e-6; t0 += SAMPLE) {
    const dt = Math.min(SAMPLE, length - t0), t = t0 + dt / 2;
    if (t < snaps[0].t) continue;
    const snap = layoutAt(snaps, t), z = zoomAt(zoom, t);
    for (const [field, kindOf] of KINDS) {
      for (const r of snap[field] || []) {
        const px = zoomRect(r, z); if (!px) continue;
        const kind = kindOf(r), q = { x: Math.round(px.x), y: Math.round(px.y), w: Math.round(px.w), h: Math.round(px.h) };
        const key = `${kind} ${q.x} ${q.y} ${q.w} ${q.h}`, cur = acc.get(key);
        if (cur) cur.share += dt; else acc.set(key, { ...q, kind, share: dt });
      }
    }
  }
  return [...acc.values()].map(({ share, ...r }) => ({ ...r, weight: Math.round(Math.max(0.05, Math.min(1, share / Math.max(0.1, length))) * WEIGHTS[r.kind] * 1000) / 1000 }));
}

/** The layout snapshot that is on screen at raw time t. */
export function layoutAt(layout = [], t = 0) {
  let cur = null;
  for (const s of [...layout].sort((a, b) => a.t - b.t)) { if (s.t <= t + 0.001) cur = s; else break; }
  return cur || layout[0] || { headings: [], bars: [] };
}

/**
 * Caption position for one scene on one platform.
 * @param {string} platform
 * @param {{w,h}} size measured caption box (px)
 * @param {{ clicks?: rect[], layout?: Array, length?: number }} scene clicks from clickRects() (px)
 */
export function placeCaption(platform, size, { clicks = [], layout = [], length = 1, zoom = [] } = {}) {
  return placeBand({ area: safeRect(platform), size, align: PLATFORMS[platform].caption.align, hard: clicks, soft: softRects(layout, length, zoom), prefer: 'bottom' });
}

/** The part of the cover that survives the 4:5 and 1:1 grid crops, minus a margin. */
export const COVER_AREA = { x: 90, y: 330, w: 900, h: 1260 };

/**
 * Position of the headline box on the cover: the centre, unless the page's own headline or a bar is there.
 * @param {{w,h}} size
 * @param {{headings?: rect[], bars?: rect[]}} snap layout at the cover frame (fractions)
 */
export function placeCover(size, snap = {}) {
  const soft = [...(snap.bars || []).map((r) => ({ ...toPx(r), kind: 'bar' })), ...(snap.pictures || []).map((r) => ({ ...toPx(r), kind: 'picture', weight: WEIGHTS.picture })), ...(snap.titles || []).map((r) => ({ ...toPx(r), kind: 'title', weight: WEIGHTS.title }))];
  return placeBand({ area: COVER_AREA, size, align: 'center', hard: (snap.headings || []).map(toPx), soft, prefer: 'center', step: 60 });
}
