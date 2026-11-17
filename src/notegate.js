// The model note has to reach the chat before any token is spent on exploring.
//
// Asking the agent to paste it failed in three model runs in a row: in a non-interactive run the agent went from
// `begin` straight to the next tool call. So the next tool needs it: `explore-shot` reads the session transcript and
// refuses to run until an assistant message written after `begin` contains the note's numbers. The refusal prints
// the note again and says exactly what to do. Nothing else unlocks it, and the check fails open (it never blocks)
// when there is no session or no transcript to read, for example in a plain terminal.
import { readFileSync } from 'node:fs';
import { findTranscripts } from './cost.js';
import { paths, readJson, writeJson, sleep } from './util.js';

/** The amounts that must appear in the chat: the range shown for this session's model. Pure. */
export function noteAmounts(note) {
  if (!note) return [];
  const lo = note.usdLow ?? note.recLow, hi = note.usdHigh ?? note.recHigh;
  return lo != null && hi != null ? [`$${Number(lo).toFixed(2)}`, `$${Number(hi).toFixed(2)}`] : [];
}

/**
 * True when an assistant message of the main conversation, begun at or after `since` (ms), carries the note:
 * both amounts of its range in its text. Translation or reformatting does not matter; the numbers do. Pure.
 */
export function noteRelayed(transcriptText, note, since = 0) {
  const need = noteAmounts(note);
  if (!need.length) return true;
  for (const line of String(transcriptText).split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"text"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
    if ((Date.parse(o.timestamp) || 0) < since) continue;
    const text = o.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
    if (need.every((a) => text.includes(a))) return true;
  }
  return false;
}

/**
 * Called by `explore-shot` before it opens a browser.
 * @returns {Promise<{ ok: boolean, why: string, block?: string }>}
 */
export async function checkNoteGate(projectDir, { waitMs = 2000, find = findTranscripts } = {}) {
  const p = paths(projectDir), marks = readJson(p.costMarks), note = readJson(p.modelJson);
  if (!marks || !marks.session || !note || note.session !== marks.session) return { ok: true, why: 'no session run' };
  if (note.relayedAt) return { ok: true, why: 'already in the chat' };
  if (note.shownAt) return { ok: true, why: 'shown to the user by the hook after begin' };
  const since = marks.startedAt || 0;
  // The transcript can lag behind the message that makes this call by a moment: look a few times.
  for (let waited = 0; ; waited += 400) {
    const files = find(marks.session);
    if (!files.length) return { ok: true, why: 'no transcript to check' };
    let text = ''; try { text = readFileSync(files[0], 'utf8'); } catch { return { ok: true, why: 'transcript not readable' }; }
    if (noteRelayed(text, note, since)) { writeJson(p.modelJson, { ...note, relayedAt: new Date().toISOString() }); return { ok: true, why: 'found in the chat' }; }
    if (waited >= waitMs) break;
    await sleep(400);
  }
  return { ok: false, why: 'not in the chat', block: note.block };
}

/** The refusal, as printed by `explore-shot`. Pure. */
export function gateMessage(block) {
  return [
    'Not yet: the user has not seen the model note, so nothing was explored and no tokens were spent on it.',
    'Write the lines between the two markers below into the chat as plain text, in one code block, word for word.',
    'They must be the visible text of your reply: what you write in your thinking is not shown to the user and does not count.',
    'Then make this same explore-shot call again, in the same message, after that text. Pushreel reads the session',
    'transcript to see that the note is there; nothing else unlocks exploring.',
    '',
    block || '',
  ].join('\n');
}

/** The note as the user reads it: the lines of the paste block without its two marker lines. Pure. */
export const noteLines = (block) => String(block || '').split('\n').filter((l) => !/^----- (PUSHREEL|END)/.test(l)).join('\n');

/**
 * PostToolUse hook after `pushreel begin` (hooks/hooks.json, only for that command). Claude Code shows a hook's
 * `systemMessage` to the user, so the note reaches the chat by fixed code, whatever the agent writes. The model put
 * the note into its thinking in the first 0.4.0 run, where nobody sees it.
 * @param {string} input the hook's stdin (JSON with session_id, cwd)
 * @returns {null | object} the hook's JSON answer, or null to stay silent
 */
export function noteHook(input) {
  try {
    const h = JSON.parse(input || '{}');
    const dir = h.cwd || process.cwd(), p = paths(dir);
    const note = readJson(p.modelJson), marks = readJson(p.costMarks);
    if (!note || !note.block || !h.session_id || note.session !== h.session_id || !marks || marks.session !== h.session_id) return null;
    if (note.shownAt || note.relayedAt) return null;
    writeJson(p.modelJson, { ...note, shownAt: new Date().toISOString(), shownBy: 'hook' });
    return { systemMessage: `Pushreel: ${noteLines(note.block)}` };
  } catch { return null; }
}
