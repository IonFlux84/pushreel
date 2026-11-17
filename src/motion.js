// Scrolling and still tails. Pure functions, unit tested.

export const SCROLL = { msPerPx: 0.9, base: 350, min: 450, max: 2600 };

/** How long a scroll over `distance` CSS px takes: proportional to the distance, capped at both ends. */
export function scrollDuration(distance, o = SCROLL) {
  const d = Math.abs(distance);
  if (d < 1) return 0;
  return Math.round(Math.min(o.max, Math.max(o.min, o.base + d * o.msPerPx)));
}

/** Ease in and out (cubic): slow start, slow end. p and the result are 0..1. */
export const easeInOut = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * The scroll as per-frame steps (used when a page scrolls inside a container and only wheel events reach it).
 * @returns {number[]} deltas in px, one per frame; they add up to `distance`
 */
export function scrollDeltas(distance, ms = scrollDuration(distance), frameMs = 16) {
  const n = Math.max(1, Math.round(ms / frameMs)), out = [];
  let prev = 0;
  for (let i = 1; i <= n; i++) { const pos = distance * easeInOut(i / n); out.push(pos - prev); prev = pos; }
  return out;
}

/**
 * Rough length of a scene's steps in seconds, without a browser. For the validator's still-picture warning.
 * Technical waits count at most the cut threshold, because the cut shortens them.
 */
export function estimateStepsSeconds(steps = [], cut = {}) { return estimateEnds(steps, cut).steps; }

/** As estimateStepsSeconds, plus when the last action (anything but hold, wait, waitFor) ends. */
export function estimateEnds(steps = [], { removeWaitsOver = 0.6 } = {}) {
  let s = 0, action = 0;
  for (const st of steps) {
    switch (st.do) {
      case 'hold': s += (st.ms || 0) / 1000; break;
      case 'wait': s += removeWaitsOver > 0 ? Math.min((st.ms || 0) / 1000, removeWaitsOver) : (st.ms || 0) / 1000; break;
      case 'click': s += 0.8; break;
      case 'hover': s += 0.6; break;
      case 'type': s += 0.6 + String(st.value || '').length * ((st.delay ?? 45) / 1000); break;
      case 'press': s += 0.15; break;
      case 'scroll': s += (typeof st.y === 'number' ? scrollDuration(st.y) : 900) / 1000 + 0.25; break;
      case 'goto': s += 0.6; break;
      case 'waitFor': s += 0.2; break;
    }
    if (!['hold', 'wait', 'waitFor'].includes(st.do)) action = s;
  }
  return { steps: Math.round(s * 10) / 10, lastAction: Math.round(action * 10) / 10 };
}

export const STILL_TAIL = 2; // seconds of picture kept after the last step when tails are trimmed

export const HOLD_PAD = 0.4; // picture kept after a final hold: the hold itself is the pause

/**
 * The length a scene gets when its still tail is trimmed.
 * The picture stands still from the last action on (a click, a scroll, typing). A `hold` after it is a pause the
 * shot list asked for and is kept; what is trimmed is the filler up to the scene's duration.
 * @param {number} wanted    the scene's duration from the shot list
 * @param {number} stepsEnd  when its last step ended, holds included (cut time, seconds)
 * @param {number|false} tail seconds of still picture kept after the last action; 0 or false = do not trim
 * @param {number} [actionEnd] when its last action ended (cut time); default: stepsEnd
 * @returns {{ length: number, trimmed: number }} length is rounded up to half seconds so small timing differences do not change it
 */
export function trimTail(wanted, stepsEnd, tail = STILL_TAIL, actionEnd = stepsEnd, minimum = 2) {
  if (!tail || tail <= 0 || !(stepsEnd >= 0)) return { length: wanted, trimmed: 0 };
  const end = Math.max((actionEnd >= 0 ? actionEnd : stepsEnd) + tail, stepsEnd + HOLD_PAD);
  const cap = Math.max(minimum, Math.ceil(end * 2 - 0.02) / 2);
  if (cap >= wanted) return { length: wanted, trimmed: 0 };
  return { length: cap, trimmed: Math.round((wanted - cap) * 1000) / 1000 };
}
