// The model note: which model the Claude Code session runs, what one run is expected to cost on it,
// and how that compares with the recommended model. Shown before the model-driven part starts.
// Never blocks: the user decides to continue or to stop and switch with /model.
import { readFileSync } from 'node:fs';
import { loadPrices, priceFor, costOf, findTranscripts, parseTranscript, promptTimes, k } from './cost.js';
import { paths, readJson, writeJson, sleep } from './util.js';
import { dontAskModels } from './userconfig.js';

/** The model of a session, read from its transcript: the latest model notice or assistant message wins. */
export function sessionModel(sessionId, files = findTranscripts(sessionId)) {
  if (!files.length) return null;
  let model = null, text = '';
  try { text = readFileSync(files[0], 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes('"model')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain) continue;
    const id = (o.type === 'attachment' && o.attachment && o.attachment.type === 'model' && o.attachment.identity && o.attachment.identity.modelId)
      || (o.type === 'assistant' && o.message && o.message.model !== '<synthetic>' && o.message.model);
    if (typeof id === 'string' && id) model = id;
  }
  return model;
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const tokensIn = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

/**
 * What the session looks like right now, from transcript text. Pure.
 * @returns {null | { contextTokens, messages, usage }}
 *   contextTokens: tokens the latest turn read (fresh input, cache read and cache write): the size of the context each further turn carries
 *   messages:      assistant messages since the prompt that started this run
 *   usage:         their tokens by kind, i.e. what this run has already used
 */
export function sessionContext(text) {
  const all = parseTranscript(text);
  if (!all.length) return null;
  const prompt = promptTimes(text).pop() ?? 0;
  const run = all.filter((m) => m.at >= prompt), usage = ZERO();
  for (const m of run) {
    const u = m.usage, w = u.cache_creation_input_tokens || 0, w1h = u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens || 0 : 0;
    usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.cacheWrite1h += w1h; usage.cacheWrite5m += w - w1h;
  }
  // the largest of the last three turns: a turn right after a cache miss or a compaction can read little
  const contextTokens = Math.max(...all.slice(-3).map((m) => tokensIn(m.usage)));
  return { contextTokens, messages: run.length, usage };
}

const priceOfUsage = (u, price) => {
  const base = { ...price }; delete base.over; // the Haiku long-prompt tier is not applied to a sum of requests
  return costOf({ input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite5m + u.cacheWrite1h, cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite5m, ephemeral_1h_input_tokens: u.cacheWrite1h } }, base);
};

/**
 * The expected model cost of one run as a range. Pure.
 *
 * A run is a number of agent turns. Every turn reads the whole context again (cache read), adds a little to it
 * (cache write) and writes some output. So the cost is: turns × context size × cache-read price, plus the new
 * tokens, plus the output, plus what the run has already used. Low and high come from the turn profile in
 * config/prices.json ("runProfile": fewest and most turns, least and most new tokens per turn).
 *
 * @param {object} prices config/prices.json
 * @param {object} price  one row of prices.models
 * @param {null | { contextTokens, messages, usage }} ctx from sessionContext(); null = nothing measured: the profile's
 *        default context, and the context is written to the cache once (a fresh session)
 * @returns {null | { low, high, contextTokens, measured }}
 */
export function estimateRange(prices, price, ctx = null) {
  const P = prices.runProfile;
  if (!price || !P) return null;
  const measured = !!(ctx && ctx.contextTokens > 0);
  const C = measured ? ctx.contextTokens : P.defaultContext, done = measured ? ctx.messages || 0 : 0, used = (measured && ctx.usage) || ZERO();
  const long = !measured || used.cacheWrite1h >= used.cacheWrite5m; // the cache lifetime this session writes with
  const at = (i) => {
    const r = Math.max(P.minRemaining || 4, P.messages[i] - done), g = P.newTokensPerMessage[i], u = { ...used };
    u.cacheRead += r * C + (g * r * (r - 1)) / 2;
    const write = g * r + (measured ? 0 : C);
    if (long) u.cacheWrite1h += write; else u.cacheWrite5m += write;
    if (!measured) u.cacheRead -= C; // the first turn of a fresh session writes the context instead of reading it
    u.output += (P.outputTokens[i] * r) / P.messages[i];
    return priceOfUsage(u, price);
  };
  return { low: at(0), high: at(1), contextTokens: C, measured };
}
const mid = (r) => (r.low + r.high) / 2;
const round2 = (n) => Math.round(n * 100) / 100;
/** Rounds a range outwards to steps a person reads: 5 cents, or 1 cent below 20 cents. */
export function niceRange(low, high) {
  const step = high < 0.2 ? 0.01 : 0.05, lo = Math.max(step, Math.floor(low / step + 1e-9) * step), hi = Math.max(lo + step, Math.ceil(high / step - 1e-9) * step);
  return [round2(lo), round2(hi)];
}
const usd = (n) => `≈ $${Math.max(0.01, n).toFixed(2)}`;
export const times = (r) => (r >= 10 ? String(Math.round(r)) : r.toFixed(1).replace(/\.0$/, '')) + '×';

/**
 * The decision, pure.
 * @param {{ prices: object, modelId: string|null, yes?: boolean, dontAsk?: string[], context?: object|null }} o
 * @returns {{ model: {id, name, priced}, recommended: {id, name}, usd, usdLow, usdHigh, eur, recUsd, recLow, recHigh, contextTokens, measured, ratio, kind, ask, why, headline, range, note, basis, text, block }}
 *   kind: 'recommended' | 'pricier' | 'cheaper' | 'haiku' | 'unpriced' | 'unknown'
 *   ask:  true when the user should be asked "continue or switch?"; false means go on
 *   usd:  the middle of the range (for comparisons); usdLow and usdHigh are the range that is shown
 */
export function modelNote({ prices, modelId, yes = false, dontAsk = [], context = null }) {
  const rec = { id: prices.recommended, ...prices.models[prices.recommended] };
  const recR = estimateRange(prices, rec, context), rate = prices.usdToEur.rate;
  const [recLow, recHigh] = niceRange(recR.low, recR.high);
  const price = priceFor(prices, modelId);
  const model = { id: price ? price.id : modelId || null, name: price ? price.name : modelId || 'unknown', priced: !!price };
  const out = { model, recommended: { id: rec.id, name: rec.name }, usd: null, usdLow: null, usdHigh: null, eur: null, recUsd: round2(mid(recR)), recLow, recHigh, contextTokens: recR.contextTokens, measured: recR.measured, ratio: null, kind: 'unknown', ask: false, why: '', headline: '', range: '', note: '' };
  const span = (lo, hi) => `about $${lo.toFixed(2)} to $${hi.toFixed(2)}, €${(lo * rate).toFixed(2)} to €${(hi * rate).toFixed(2)}`;
  const carries = recR.measured
    ? `your session carries about ${k(Math.round(recR.contextTokens / 1000) * 1000)} tokens of context per turn${recR.contextTokens >= 60000 ? '; a large CLAUDE.md, many plugins and MCP servers are what make it large' : ''}`
    : `the context of this session could not be measured, so this assumes a small one of about ${k(recR.contextTokens)} tokens per turn`;
  const recLine = `On ${rec.name}, the recommended model, a run like this costs ${span(recLow, recHigh)}.`;

  if (!modelId) {
    out.headline = `Pushreel could not read which model this session runs.`;
    out.range = `${recLine} (${carries[0].toUpperCase() + carries.slice(1)}.)`;
  } else if (!price) {
    out.kind = 'unpriced';
    out.headline = `This session runs ${modelId}. There is no price for it in config/prices.json, so no estimate.`;
    out.range = `${recLine} (${carries[0].toUpperCase() + carries.slice(1)}.)`;
  } else {
    const r = estimateRange(prices, price, context), [lo, hi] = niceRange(r.low, r.high), cost = mid(r);
    out.usd = round2(cost); out.usdLow = lo; out.usdHigh = hi; out.eur = round2(cost * rate); out.ratio = Math.round((cost / mid(recR)) * 10) / 10;
    out.headline = `Model: ${price.name}${price.id === rec.id ? ', the recommended model' : ''}.`;
    out.range = `Estimated for this run on ${price.name}: ${span(lo, hi)} (${carries}).`;
    if (price.id === rec.id) out.kind = 'recommended';
    else if (/haiku/i.test(price.id)) {
      out.kind = 'haiku';
      out.note = `${price.name} works for re-renders and caption edits, but the first shot list may be weak: ${rec.name} picks better scenes (about $${recLow.toFixed(2)} to $${recHigh.toFixed(2)} per run). Switch with /model, or continue.`;
    } else if (cost > mid(recR) * 1.15) {
      out.kind = 'pricier';
      out.note = `This session runs ${price.name}. A run costs about ${times(cost / mid(recR))} what it costs on ${rec.name} (about $${recLow.toFixed(2)} to $${recHigh.toFixed(2)} there). Switch with /model, or continue.`;
    } else {
      out.kind = 'cheaper';
      out.note = `${rec.name} is the recommended model (about $${recLow.toFixed(2)} to $${recHigh.toFixed(2)} for this run).`;
    }
  }
  const wants = out.kind === 'pricier' || out.kind === 'haiku';
  if (!wants) out.why = 'nothing to decide';
  else if (yes) out.why = '--yes';
  else if (dontAsk.includes(model.id)) out.why = 'you chose not to be asked again for this model; reset with: pushreel config reset';
  else out.ask = true;
  out.basis = `A range, not a quote: ${recR.measured ? 'measured from this session\'s transcript' : 'not measured'}, times the turn profile of our first runs, at API list prices (checked ${prices.lastChecked}). On a Claude subscription this counts against your plan limits, no extra charge.`;
  const lines = [out.headline, out.range, out.note, out.basis].filter(Boolean);
  out.block = pasteBlock(lines);
  out.text = [out.block, out.ask ? 'Decision: ask' : `Decision: continue${wants ? ` (${out.why})` : ''}`].join('\n');
  return out;
}

export const PASTE_OPEN = '----- PUSHREEL: copy the lines between these two markers into the chat, word for word (not the markers) -----';
export const PASTE_CLOSE = '----- END -----';
/** Wraps lines the agent must relay unchanged. Tool output is not shown to the user, so the agent pastes it. */
export const pasteBlock = (lines) => [PASTE_OPEN, ...lines, PASTE_CLOSE].join('\n');

/** Estimates for every priced model, for the Studio. `context` as in estimateRange. */
export function estimates(prices = loadPrices(), context = null) {
  const recUsd = mid(estimateRange(prices, prices.models[prices.recommended], context));
  return Object.entries(prices.models).map(([id, p]) => { const r = estimateRange(prices, p, context), [low, high] = niceRange(r.low, r.high); return { id, name: p.name, usd: round2(mid(r)), low, high, ratio: Math.round((mid(r) / recUsd) * 10) / 10, recommended: id === prices.recommended, haiku: /haiku/i.test(id) }; });
}

/** Reads the session's transcript and measures its context. Waits a moment if the transcript lags behind. */
export async function measureSession(sessionId) {
  for (let i = 0; i < 4; i++) {
    const files = findTranscripts(sessionId);
    if (!files.length) return null;
    let ctx = null; try { ctx = sessionContext(readFileSync(files[0], 'utf8')); } catch { ctx = null; }
    if (ctx && ctx.messages > 0) return ctx;
    if (i === 3) return ctx;
    await sleep(300);
  }
  return null;
}

/** Runs the check for a project and remembers the result in .pushreel/model.json for the Studio. */
export async function checkModel(projectDir, { sessionId, modelId, yes = false } = {}) {
  const prices = loadPrices();
  const id = modelId || sessionModel(sessionId);
  const context = sessionId ? await measureSession(sessionId) : null;
  const note = modelNote({ prices, modelId: id, yes, dontAsk: dontAskModels(), context });
  writeJson(paths(projectDir).modelJson, { ...note, context: context ? { contextTokens: context.contextTokens, messages: context.messages } : null, session: sessionId || null, at: new Date().toISOString() });
  return note;
}
export const lastModelNote = (projectDir) => readJson(paths(projectDir).modelJson);
