// Cost display: tokens and estimated cost per step.
//
// What is possible: Claude Code writes every assistant message of a session, with its token usage, to a
// transcript file (~/.claude/projects/<project>/<session-id>.jsonl, plus <session-id>/subagents/*.jsonl).
// The layout of that file is not documented by Anthropic; it is read here defensively.
// Per-step numbers are an approximation: the agent runs `pushreel cost mark <step>` when a step begins,
// and every message is counted into the step whose mark precedes it. See docs/COSTS.md for the limits.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJson, writeJson, PLUGIN_ROOT, paths } from './util.js';

export const STEPS = {
  explore: 'Read project and explore',
  shotlist: 'Shot list and post texts',
  pipeline: 'Record, retry, cut, export',
  summary: 'Summary in the chat',
};

/** Older step names that still work: the post texts are written together with the shot list. */
export const STEP_ALIAS = { texts: 'shotlist' };

export const loadPrices = () => readJson(join(PLUGIN_ROOT, 'config', 'prices.json'));

/** Finds the price row for a model id such as "claude-sonnet-5-5-20261001". */
export function priceFor(prices, model) {
  if (!model) return null;
  const ids = Object.keys(prices.models).sort((a, b) => b.length - a.length);
  const id = ids.find((k) => model === k || model.startsWith(k));
  return id ? { id, ...prices.models[id] } : null;
}

/**
 * Cost in USD of one usage record.
 * usage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation?: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } }
 * @returns {number|null} null when the model has no price row
 */
export function costOf(usage, price) {
  if (!price) return null;
  const u = usage || {};
  const inp = u.input_tokens || 0, out = u.output_tokens || 0, read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
  const w1h = u.cache_creation ? u.cache_creation.ephemeral_1h_input_tokens || 0 : 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens || 0) : write;
  const rest = Math.max(0, write - w1h - w5m); // unknown split counts as 5 minute writes
  const p = price.over && inp + read + write > price.over.promptTokens ? { ...price, ...price.over } : price;
  return (inp * p.input + out * p.output + read * p.cacheRead + (w5m + rest) * p.cacheWrite5m + w1h * p.cacheWrite1h) / 1e6;
}

/** Reads assistant messages from transcript text. One row per API message (streamed blocks repeat the id). */
export function parseTranscript(text) {
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.type === 'assistant' && o.message;
    if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
    // One API message is written as several lines (one per content block). The first line marks when the
    // message began, the last one carries the final usage.
    const id = m.id || o.uuid, seen = byId.get(id), at = Date.parse(o.timestamp) || 0;
    // Does this message write the shot list? Then the "shot list" step begins here, whether or not the agent marked it.
    const writes = Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_use' && (b.name === 'Write' || b.name === 'Edit') && /(^|[\\/])\.pushreel[\\/]shotlist\.json$/.test(String((b.input && b.input.file_path) || '')));
    byId.set(id, { id, at: seen ? Math.min(seen.at, at) : at, model: m.model, usage: m.usage, writesShotlist: writes || !!(seen && seen.writesShotlist) });
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Times at which the user sent a prompt (typed text or a slash command; tool results do not count). */
export function promptTimes(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'user' && !o.isMeta && !o.isSidechain && o.message && typeof o.message.content === 'string') out.push(Date.parse(o.timestamp) || 0);
  }
  return out.sort((a, b) => a - b);
}

/** Locates the transcript of a session. Returns the main file and the files of its subagents. */
export function findTranscripts(sessionId, base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')) {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId) || !existsSync(base)) return [];
  const out = [];
  for (const dir of readdirSync(base)) {
    const main = join(base, dir, `${sessionId}.jsonl`);
    if (!existsSync(main)) continue;
    out.push(main);
    const sub = join(base, dir, sessionId, 'subagents');
    if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(join(sub, f));
  }
  return out;
}

/**
 * Sums messages into steps.
 * @param {Array} messages from parseTranscript
 * @param {Array<{step: string, at: number}>} marks sorted by time; a message belongs to the last mark before it
 * @param {object} prices
 * @param {{ from?: number, to?: number }} window only messages in this time window count
 */
export function summarize(messages, marks, prices, window = {}) {
  const order = Object.keys(STEPS);
  const rows = Object.fromEntries(order.map((k) => [k, { step: k, label: STEPS[k], in: 0, out: 0, usd: 0, messages: 0 }]));
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  // The shot list step, read from the transcript: it begins with the first message that writes .pushreel/shotlist.json.
  if (!sorted.some((x) => x.step === 'shotlist')) {
    const first = messages.find((m) => m.writesShotlist && m.at >= (window.from ?? (sorted[0] ? sorted[0].at : 0)));
    const pipe = sorted.find((x) => x.step === 'pipeline');
    if (first && (!pipe || first.at < pipe.at)) { sorted.push({ step: 'shotlist', at: first.at }); sorted.sort((a, b) => a.at - b.at); }
  }
  const from = window.from ?? (sorted[0] ? sorted[0].at : 0), to = window.to ?? Infinity;
  const models = new Set(), unpriced = new Set();
  for (const m of messages) {
    if (m.at < from || m.at > to) continue;
    let step = window.before || null; // messages between the prompt and the first mark
    for (const k of sorted) { if (k.at <= m.at) step = STEP_ALIAS[k.step] || k.step; else break; }
    if (!step || !rows[step]) continue;
    const u = m.usage, price = priceFor(prices, m.model), usd = costOf(u, price);
    models.add(price ? price.name : m.model);
    if (usd === null) unpriced.add(m.model);
    const r = rows[step];
    // "in" is everything the model read: fresh input, cache writes and cache reads.
    r.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    r.out += u.output_tokens || 0; r.usd += usd || 0; r.messages++;
  }
  const list = order.map((k) => rows[k]);
  const total = list.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out, usd: a.usd + r.usd }), { in: 0, out: 0, usd: 0 });
  const rate = prices.usdToEur.rate;
  return {
    rows: list.map((r) => ({ ...r, usd: round2(r.usd), eur: round2(r.usd * rate) })),
    total: { in: total.in, out: total.out, usd: round2(total.usd), eur: round2(total.usd * rate) },
    models: [...models], unpriced: [...unpriced], usdToEur: rate, pricesChecked: prices.lastChecked, priceSource: prices.source,
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

export const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 || n % 1000 === 0 ? 0 : 1)}k` : String(n));

/** Table for the terminal. */
export function formatReport(rep) {
  const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
  const lines = [`${pad('Model cost', 30)}${lpad('Tokens in', 11)}${lpad('Tokens out', 12)}${lpad('USD', 9)}${lpad('EUR', 9)}`];
  for (const r of rep.rows) lines.push(`${pad(r.label, 30)}${lpad(k(r.in), 11)}${lpad(k(r.out), 12)}${lpad('$' + r.usd.toFixed(2), 9)}${lpad('€' + r.eur.toFixed(2), 9)}`);
  lines.push(`${pad('Total', 30)}${lpad(k(rep.total.in), 11)}${lpad(k(rep.total.out), 12)}${lpad('≈ $' + rep.total.usd.toFixed(2), 9)}${lpad('€' + rep.total.eur.toFixed(2), 9)}`);
  lines.push('');
  lines.push(`Estimate at API list prices${rep.models.length ? ' for ' + rep.models.join(', ') : ''} (checked ${rep.pricesChecked}), 1 USD = ${rep.usdToEur} EUR.`);
  lines.push('"Tokens in" includes cached tokens, which cost a small fraction of fresh input (config/prices.json). Record, retry, cut and export are fixed code: 0 tokens.');
  lines.push('The split per step is approximate. "Summary in the chat" is the answer that shows this table: it is 0 here and counted afterwards (pushreel cost report).');
  lines.push('On a Claude subscription this counts against your plan limits, no extra charge.');
  if (rep.unpriced.length) lines.push(`No price in config/prices.json for: ${rep.unpriced.join(', ')}. Their tokens are counted, their cost is not.`);
  if (rep.note) lines.push(rep.note);
  return lines.join('\n');
}

/** Records that a step begins now. Called by the agent through the CLI. */
export function mark(projectDir, step, sessionId) {
  const p = paths(projectDir);
  const data = readJson(p.costMarks, { session: null, marks: [] });
  step = STEP_ALIAS[step] || step;
  if (step === 'start' || (sessionId && data.session && data.session !== sessionId)) { data.marks = []; delete data.usedBy; }
  if (sessionId) data.session = sessionId;
  if (step !== 'start') data.marks.push({ step, at: Date.now() });
  else data.startedAt = Date.now();
  writeJson(p.costMarks, data);
  return data;
}

/**
 * Says which run the marks belong to. A later run started from a plain terminal (outside Claude Code, no new "start"
 * mark) must not show the tokens of the session that made the earlier run: its marks are dropped.
 * @returns {boolean} true when the marks are current for this run
 */
export function claimMarks(projectDir, runId, fresh, env = process.env) {
  const p = paths(projectDir), data = readJson(p.costMarks);
  if (!data || !data.session) return false;
  // Claude Code gives its shell the session id (seen in 2.1.325, not documented); without it, "inside Claude Code" has to do
  const sameSession = env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID === data.session : !!env.CLAUDECODE;
  if (fresh && !sameSession && data.usedBy && data.usedBy !== runId) { writeJson(p.costMarks, { session: null, marks: [] }); writeJson(p.costJson, { ...summarize([], [], loadPrices()), measured: false, session: null, note: 'This run was started from the plain CLI, so no model was used: 0 tokens.', at: new Date().toISOString() }); return false; }
  if (!data.usedBy) { data.usedBy = runId; writeJson(p.costMarks, data); }
  return true;
}

/** Builds the report for the current project from the marks and the session transcript. */
export function report(projectDir, sessionId) {
  const p = paths(projectDir), prices = loadPrices();
  const data = readJson(p.costMarks, { session: null, marks: [] });
  const session = sessionId || data.session;
  const files = findTranscripts(session);
  let rep;
  if (!session || !files.length) {
    rep = summarize([], data.marks, prices);
    rep.measured = false;
    rep.note = session ? `No transcript found for session ${session}. Token numbers are not available for this run.` : 'No Claude Code session is known for this run (it was started from the plain CLI), so no model was used: 0 tokens.';
  } else {
    const texts = files.map((f) => readFileSync(f, 'utf8'));
    const messages = texts.flatMap((t) => parseTranscript(t));
    // The run begins with the prompt that started it (/pushreel), not with the first mark: the first answer
    // already costs tokens. Everything before the first mark counts as exploring.
    const start = data.startedAt || (data.marks[0] && data.marks[0].at) || 0;
    const prompt = promptTimes(texts[0]).filter((t) => t <= start).pop();
    rep = summarize(messages, data.marks, prices, { from: prompt ?? start, before: 'explore' });
    rep.measured = true;
  }
  rep.session = session || null;
  rep.at = new Date().toISOString();
  writeJson(p.costJson, rep);
  return rep;
}

/**
 * Stop hook: Claude Code calls this when the agent has finished answering. It refreshes .pushreel/cost.json
 * so that the Studio also counts the last answer. Reads the hook input (JSON with session_id and cwd) from stdin.
 * Does nothing, silently, unless this project has a Pushreel run of the same session.
 */
export async function hook(input) {
  try {
    const h = JSON.parse(input || '{}');
    const dir = h.cwd || process.cwd();
    const data = readJson(paths(dir).costMarks);
    if (!data || !data.session || data.session !== h.session_id || !data.marks.length) return false;
    await new Promise((r) => setTimeout(r, 1200)); // the transcript can lag behind the answer by a moment
    report(dir, h.session_id);
    return true;
  } catch { return false; }
}
