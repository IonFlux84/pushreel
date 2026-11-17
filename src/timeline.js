// Cut planning. Pure functions: no files, no ffmpeg. Everything here is unit tested.
//
// Vocabulary
//   raw time  = seconds in the recorded scene clip
//   cut time  = seconds in the scene after waits were removed
//   wait      = a technical pause ("wait", "waitFor", page loads). Waits longer than the threshold are shortened to it.
//   hold      = a pause for the viewer. Never cut.

import { round } from './util.js';
import { trimTail } from './motion.js';

export const ZOOM = { in: 0.35, hold: 1.2, out: 0.45, pan: 0.4, lead: 0.1 };
export const TAIL = 0.4;        // picture kept after the last action, at least
export const CAPTION_IN = 0.15; // caption appears this long after the scene starts
export const CAPTION_OUT = 0.1; // and leaves this long before it ends

/**
 * Which parts of the raw clip are removed.
 * A wait of length L > threshold keeps threshold/2 at its start and at its end.
 * @returns {Array<[number, number]>} sorted, non-overlapping raw intervals to remove
 */
export function removals(segments, threshold) {
  if (!threshold || threshold <= 0) return [];
  const out = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const len = s.end - s.start;
    if (len <= threshold + 0.05) continue;
    let a = s.start + threshold / 2, b = s.end - threshold / 2;
    const last = out[out.length - 1];
    if (last && a < last[1]) a = last[1];
    if (b - a > 0.02) out.push([round(a), round(b)]);
  }
  return out;
}

/** Raw time → cut time, given the removed intervals. A time inside a removed interval maps to its start. */
export function toCut(t, removed) {
  let shift = 0;
  for (const [a, b] of removed) {
    if (t >= b) shift += b - a;
    else if (t > a) { shift += t - a; break; } else break;
  }
  return round(t - shift);
}

/**
 * Plans one scene.
 * @param {object} ev     recorded events: { duration, segments:[{start,end}], clicks:[{t,x,y}], lastActionEnd }
 * @param {object} scene  { duration } wanted length in seconds
 * @param {object} cut    { removeWaitsOver, zoom }
 * @returns {{ keep: Array<[number,number]>, removed: Array<[number,number]>, removedSeconds: number, waitsRemoved: number,
 *            content: number, pad: number, length: number, overrun: number, clicks: Array<{t,x,y}>, zoom: Array }}
 */
export function planScene(ev, scene, cut) {
  const removed = removals(ev.segments || [], cut.removeWaitsOver).filter(([a]) => a < ev.duration)
    .map(([a, b]) => [a, Math.min(b, ev.duration)]);
  const removedSeconds = round(removed.reduce((n, [a, b]) => n + (b - a), 0));
  const cutLen = round(ev.duration - removedSeconds);
  const minimum = round(Math.min(cutLen, toCut(ev.lastActionEnd || 0, removed) + TAIL));
  // A scene whose steps end early would show seconds of still picture: by default the tail is trimmed (cut.trimStillTails).
  const tail = trimTail(scene.duration, typeof ev.stepsEnd === 'number' ? toCut(ev.stepsEnd, removed) : NaN, cut.trimStillTails, toCut(ev.lastActionEnd || 0, removed));
  const want = tail.length;

  let length, pad = 0;
  if (cutLen >= want) length = Math.max(want, minimum);   // trim the tail, never an action
  else { length = want; pad = round(want - cutLen); }      // hold the last frame
  length = round(length);
  const content = round(Math.min(cutLen, length));

  // keep intervals in raw time, clipped so that their total is `content`
  const keep = [];
  let pos = 0, left = content;
  for (const [a, b] of [...removed, [ev.duration, ev.duration]]) {
    if (left <= 0) break;
    const end = Math.min(a, pos + left);
    if (end - pos > 0.001) { keep.push([round(pos), round(end)]); left = round(left - (end - pos)); }
    pos = b;
  }
  const clicks = (ev.clicks || []).map((c) => ({ t: toCut(c.t, removed), x: c.x, y: c.y, w: c.w, h: c.h })).filter((c) => c.t < length - 0.05);
  return {
    keep, removed, removedSeconds, waitsRemoved: removed.length, content, pad, length, trimmed: tail.trimmed,
    overrun: round(Math.max(0, length - want)), clicks, zoom: zoomKeyframes(clicks, length, cut.zoom),
  };
}

/**
 * Zoom keyframes for a scene: [{ t, z, x, y }] with z = zoom factor and (x, y) = focus point as a fraction of the frame.
 * Between keyframes the value moves with a smoothstep. Clicks that follow each other closely share one zoom;
 * the focus pans from one to the next instead of zooming out and in again.
 */
export function zoomKeyframes(clicks, length, factor) {
  if (!factor || factor <= 1 || !clicks.length) return [];
  const Z = factor, kf = [];
  const groups = [];
  for (const c of clicks) {
    const g = groups[groups.length - 1];
    if (g && c.t - g[g.length - 1].t < ZOOM.hold + ZOOM.out + ZOOM.in) g.push(c); else groups.push([c]);
  }
  for (const g of groups) {
    const first = g[0], last = g[g.length - 1];
    const start = Math.max(0, first.t - ZOOM.in);
    kf.push({ t: round(start), z: 1, x: first.x, y: first.y });
    kf.push({ t: round(Math.max(start + 0.05, first.t - 0.02)), z: Z, x: first.x, y: first.y });
    for (let i = 1; i < g.length; i++) {
      const arrive = g[i].t - ZOOM.lead, leave = Math.max(g[i - 1].t + 0.25, arrive - ZOOM.pan);
      if (arrive - leave > 0.05) {
        kf.push({ t: round(leave), z: Z, x: g[i - 1].x, y: g[i - 1].y });
        kf.push({ t: round(arrive), z: Z, x: g[i].x, y: g[i].y });
      } else kf.push({ t: round(g[i].t - 0.02), z: Z, x: g[i].x, y: g[i].y });
    }
    const holdEnd = Math.min(last.t + ZOOM.hold, length - ZOOM.out);
    if (holdEnd > kf[kf.length - 1].t + 0.05) kf.push({ t: round(holdEnd), z: Z, x: last.x, y: last.y });
    const base = kf[kf.length - 1].t;
    kf.push({ t: round(Math.min(length, base + ZOOM.out)), z: 1, x: last.x, y: last.y });
  }
  // keyframes must be strictly increasing in time
  const out = [];
  for (const k of kf) { if (!out.length || k.t > out[out.length - 1].t + 0.001) out.push(k); else out[out.length - 1] = { ...k, t: out[out.length - 1].t }; }
  return out;
}

/** Value of the zoom at time t, for tests and for the Studio preview. */
export function zoomAt(kf, t) {
  if (!kf.length || t <= kf[0].t) return { z: 1, x: kf[0]?.x ?? 0.5, y: kf[0]?.y ?? 0.5 };
  for (let i = 1; i < kf.length; i++) {
    const a = kf[i - 1], b = kf[i];
    if (t <= b.t) { const p = (t - a.t) / (b.t - a.t), e = p * p * (3 - 2 * p); return { z: a.z + (b.z - a.z) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }; }
  }
  const l = kf[kf.length - 1];
  return { z: l.z, x: l.x, y: l.y };
}

/**
 * Turns keyframes into an ffmpeg expression in `t` (piecewise smoothstep).
 * @param {string} key "z" | "x" | "y"
 * @param {number} rest value outside all keyframes
 */
export function ffExpr(kf, key, rest) {
  if (!kf.length) return String(rest);
  const n = (v) => String(round(v, 4));
  const parts = [`lt(t,${n(kf[0].t)})*${n(key === 'z' ? rest : kf[0][key])}`];
  for (let i = 1; i < kf.length; i++) {
    const a = kf[i - 1], b = kf[i], d = b.t - a.t;
    const cond = `gte(t,${n(a.t)})*lt(t,${n(b.t)})`;
    if (Math.abs(a[key] - b[key]) < 1e-6) parts.push(`${cond}*${n(a[key])}`);
    else { const p = `((t-${n(a.t)})/${n(d)})`; parts.push(`${cond}*(${n(a[key])}+${n(b[key] - a[key])}*${p}*${p}*(3-2*${p}))`); }
  }
  const l = kf[kf.length - 1];
  parts.push(`gte(t,${n(l.t)})*${n(key === 'z' ? rest : l[key])}`);
  return parts.join('+');
}

/**
 * The whole video: where each scene starts, when its caption shows, where the end card sits.
 * @param {Array<{id, length, caption}>} scenes planned scenes in order
 */
export function planVideo(scenes, { endCard = true, endSeconds = 2, fps = 30 } = {}) {
  let t = 0;
  const frame = (s) => Math.round(s * fps) / fps;
  const out = scenes.map((s) => {
    const len = frame(s.length), start = t; t = frame(t + len);
    return { id: s.id, start, length: len, end: t, caption: s.caption ? { text: s.caption, from: round(start + CAPTION_IN), to: round(t - CAPTION_OUT) } : null };
  });
  const end = endCard && out.length ? { start: t, length: endSeconds } : null;
  return { scenes: out, endCard: end, total: round(t + (end ? end.length : 0)) };
}
