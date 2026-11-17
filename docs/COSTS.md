# Cost display

After every run Pushreel shows tokens in and out and the estimated cost per step, in USD and EUR.

```
Model cost                      Tokens in  Tokens out      USD      EUR
Read project and explore             388k         838    $0.52    €0.47
Shot list and post texts             416k        1.5k    $0.08    €0.07
Record, retry, cut, export              0           0    $0.00    €0.00
Summary in the chat                  141k         637    $0.03    €0.03
Total                                946k        2.9k  ≈ $0.62    €0.57
```

(Real numbers: `pushreel cost report` after the DartStack run of 2026-11-17 with version 0.4.0 on Claude
Sonnet 5.5, run 9 below. Claude Code's own figure for the same session: $0.6243. Up to 0.2.1 the table had
a fifth row, "Captions and post texts"; the texts are now written together with the shot list.)

## Where the numbers come from

What was investigated, against the Claude Code documentation (https://code.claude.com/docs/en/hooks,
/statusline, /monitoring-usage, /headless, /skills, /costs), and what is used:

| Source | What it offers | Used |
|---|---|---|
| Session transcript (`~/.claude/projects/<project>/<session-id>.jsonl`, plus `<session-id>/subagents/*.jsonl`) | every assistant message with `message.usage` (input, output, cache read, cache write split into 5 minute and 1 hour) and the model | **yes** |
| `${CLAUDE_SESSION_ID}` in skill text | the id of the current session, substituted when the skill loads | **yes**, passed to `pushreel cost mark start --session …` |
| Hooks (`Stop`) | `session_id`, `transcript_path`, `cwd` on stdin; no token fields | **yes**, to refresh the report after the last answer |
| Status line input | `cost.total_cost_usd`, context window tokens | no: a plugin cannot read the status line of a session from a script, and it is a session total, not per step |
| OpenTelemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) | `claude_code.token.usage`, `claude_code.cost.usage` | no: it exports to a collector the user must run; nothing to read back locally |
| `claude -p --output-format json` | `total_cost_usd`, `usage`, `modelUsage` | only in tests, to compare |
| Environment variable with the session id for Bash commands | none is documented | no |

How it works

1. `pushreel begin --session <id>` (the first call of the skill) notes where the run starts. Everything the
   agent does from the prompt on counts as "Read project and explore".
2. "Shot list and post texts" begins with the first message of the agent that writes
   `.pushreel/shotlist.json`. That is read from the transcript (a `Write` or `Edit` call on that file), so
   it does not depend on the agent remembering a marker. `pushreel cost mark shotlist` still works and wins.
3. `pushreel run` marks "Record, retry, cut, export" when it starts and "Summary in the chat" when it is
   done. Both by fixed code. No message of the agent can begin inside the pipeline, so that row is 0.
4. `pushreel cost report` reads the transcript, takes one row per API message (a message is written as
   several lines; the first line gives its time, the last its usage), and adds each message to the step
   that was running when the message began.
5. Cost = input × price + output × price + cache read × price + cache write × price (5 minute and 1 hour
   writes have their own price), from `config/prices.json`.
6. The `Stop` hook runs the report again after the agent has finished, so `.pushreel/cost.json` and the
   Studio include the last answer.

## Limits, stated plainly

- **The transcript format is not documented.** Anthropic documents the path as "conversation JSON" and warns
  it can lag. The parser ignores lines it does not understand; if the layout changes, the table shows zeros
  and a note instead of wrong numbers.
- **The split per step is approximate.** A message that explores and then writes the shot list counts
  wholly as shot list. The total is not affected.
- **The table in the chat lacks the answer that prints it.** That answer does not exist yet when the table
  is made. `pushreel cost report` afterwards, or the Studio, has the full number (the Stop hook waits 1.2 s
  for the transcript).
- **"Tokens in" includes cached tokens** (cache reads and cache writes). Most of a long session is cache
  reads at a small fraction of the input price (a twentieth on Claude Sonnet 5.5, see config/prices.json), which is why 485k tokens cost under a dollar.
- **It is an estimate at list prices.** On a Claude subscription nothing is charged per token; the run counts
  against the plan limits.
- **The "Record, retry, cut, export" row is 0 by construction** since 0.3.0. The agent's message that starts
  the pipeline counts for the step before it, the message that reads its output is the summary.
- **A run from a plain terminal after an agent run shows 0**, not the tokens of the earlier session: the
  markers of a session are dropped when a new run starts outside that session.
- **Only the time between the `/pushreel` prompt and "now" is counted**, in the session that started the run.
  A later session that only runs `resume` counts separately.
- **Runs from the plain CLI** have no session: the table shows 0 and says so.
- In all eight measured sessions the total matched Claude Code's own `total_cost_usd` to the cent
  (for example $0.62 vs $0.6243). That is eight data points, not a guarantee.

## The price table

`config/prices.json`, USD per million tokens. Checked on 2026-11-17 against
https://platform.claude.com/docs/en/about-claude/pricing

| Model | Model id | Input | Output | Cache write 5 min | Cache write 1 h | Cache read |
|---|---|---|---|---|---|---|
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 | 10 | 2.50 | 4 | 0.10 |
| Claude Opus 5.5 | `claude-opus-5-5` | 4 | 20 | 5 | 8 | 0.20 |
| Claude Haiku 5.5, prompt up to 100k tokens | `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| Claude Haiku 5.5, prompt over 100k tokens | same | 0.50 | 2.50 | 0.625 | 1 | 0.05 |
| Claude Fable 5.2 | `claude-fable-5-2` | 8 | 40 | 10 | 16 | 0.20 |

The prices were read from the official page by a research step on the check date. claude.com/pricing itself
could not be read in full; the numbers are from the documentation page above. Fable 5.2 is in the table
because it is the default model on the test machine.

EUR: ECB euro reference rate of 2026-11-16, 1 EUR = 1.1014 USD, so 1 USD = 0.9079 EUR
(https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml). The rate is a fixed number in the file, not
fetched: Pushreel makes no network requests.

To update: edit the numbers, `lastChecked` and the rate. A model without a row is listed under the table;
its tokens are counted and its cost is not.

## What a run costs

| Run | Model | What | Turns | Claude Code's `total_cost_usd` |
|---|---|---|---|---|
| 1 | Fable 5.2 | fixture app, `/pushreel:pushreel --yes` (0.1.0), 3 scenes, 21 s video | | $0.81 |
| 2 + 3 | Fable 5.2 | fixture app, confirmed with a change in a second turn (0.1.0), 4 scenes with login, 29 s video | | $0.89 |
| 4 | Fable 5.2 | fixture app, `/pushreel --yes` (0.2.0), 3 scenes, 21 s video | | $0.92 |
| 5 | Sonnet 5.5 | DartStack, `/pushreel <url> --yes` (0.2.1), 3 public scenes, 24 s video | 21 | $0.77 |
| 6 | Sonnet 5.5 | DartStack, `/pushreel <url> --yes` (0.3.0), 4 scenes, 2 of them behind the login, 21.5 s video | 15 | $0.72 |
| 7 | Sonnet 5.5 | fixture app in a small session, `/pushreel --yes` (0.4.0 before the hook): stopped by the note gate, nothing explored | 7 | $0.14 |
| 8 | Sonnet 5.5 | fixture app in a small session, `/pushreel --yes` (0.4.0), 4 scenes, 20 s video | 12 | $0.22 |
| 9 | Sonnet 5.5 | DartStack, `/pushreel <url> --yes` (0.4.0), 4 scenes, 2 of them behind the login, 19 s video | 7 | $0.62 |

Runs 1 to 4 on Sonnet 5.5 prices would have cost about $0.24 (the same tokens at other prices; not run).
Run 7 is a failed run (details in docs/TESTING.md, "Field test 3"); it is in the table because it was paid.

| Run | Wall time | Turns | Estimate printed before exploring | Claude Code | Pushreel's report |
|---|---|---|---|---|---|
| 8, fixture, small session (35k tokens per turn) | 98 s | 12 | $0.15 to $0.50 | $0.2238 | $0.22 |
| 9, DartStack (127k tokens per turn) | 95 s | 7 | $0.60 to $1.00 | $0.6243 | $0.62 |

**For the landing page and the docs:** measured with 0.4.0, a run on Claude Sonnet 5.5 costs between about
**$0.20** (a small project in a small session: $0.22 measured) and about **$0.65** (a large project in a cold
session: DartStack, 183 KB `CLAUDE.md`, 127k tokens of context per turn: $0.62 measured). A run with change
requests or a failing scene costs more; earlier versions measured up to $0.77 on DartStack. Not a guarantee.
On a Claude subscription nothing is charged per run; it counts against the plan limits.

### Where the money goes

Run 9, by kind: cache write $0.51 (128k tokens at $4 per million), cache read $0.08 (817k tokens at $0.10),
output $0.03. **Three quarters of the bill is the cold start**: the very first turn wrote 114k tokens of the
session's context into Claude's cache ($0.46), before Pushreel had done anything. The six turns after it
cost $0.17 together. In the small session of run 8 the first turn wrote 22k tokens ($0.09 of $0.22).

The cold start does not depend on Pushreel. It depends on how large the session is:

- **A large `CLAUDE.md` raises the cost of every run**, and of everything else in that session. So do many
  plugins, MCP servers and a long conversation before `/pushreel`.
- **Turns cost.** Every turn of the agent reads the whole context again: at 130k tokens that is 1.3 cents
  per turn on Sonnet 5.5, whatever the turn does.

### Tip for users: run it in a warm session

Claude caches the session's context for a while (an hour in the sessions measured here). If you type
`/pushreel` in a session you have just been working in, the context is already in the cache: the run pays
cache reads for it ($0.10 instead of $4 per million tokens on Sonnet 5.5, a fortieth) instead of writing it
again. For run 9 that would have turned the $0.46 cold start into about $0.01, so the run would have cost
about **$0.18 instead of $0.62**, as long as the warm session is not much larger than the cold one. This is computed from run 9's numbers, not
measured: every measured run came from `claude -p`, which always starts cold. The same goes the other way:
a fresh terminal, `claude -p`, or a session that sat idle longer than its cache lifetime pays the cold
start. The estimate before the run sees which case it is (it reads the session's own numbers).

### Turns

0.3.0 cut the turns from 21 to 15 (`pushreel begin`, `explore-shot --batch`, one file for shot list and post
texts, cost steps by fixed code). 0.4.0 cut them from 15 to 7 on DartStack:

- The validator no longer warns about still picture that the cut trims anyway. It prints an information line
  marked `·` that ends in "Nothing to change", and a last line "Nothing to change. Go on." In run 6 the old
  warning cost 7 of 15 turns; in runs 8 and 9 it cost none (the agent validated once and went on).
- The model note reaches the user through a hook (see the next section), so the agent spends no turn on it.

Run 8 needed 12 turns on the small fixture: 3 of them were the agent's own detours (a glob pattern ripgrep
refused, a shot list written to a mistyped path, a refused `rm` to clean it up). None was caused by a
Pushreel message.

### Could a subagent make it cheaper? Investigated, not built

The idea: let a plugin subagent with a small context explore and write the shot list, so that its turns
re-read 10k to 30k tokens instead of the session's 130k.

What a plugin subagent gets, from the documentation (https://code.claude.com/docs/en/sub-agents, "What
loads at startup"): its own system prompt plus environment details, not Claude Code's system prompt and not
the conversation; **the full CLAUDE.md hierarchy, unless its definition sets `omitClaudeMd: true`**; the
built-in and MCP tools, narrowed by its `tools` list. Measured with a probe (two plugin agents in a session
whose folder holds DartStack's `CLAUDE.md`, `field-tests/dartstack-3/probes/`): the main session's first
turn read 118.5k tokens; an agent with `CLAUDE.md` started with 95.4k; an agent with `omitClaudeMd: true`
and only the Bash tool started with **3.2k**. So the small context is real.

Why it was not built: it would not touch the part that costs. The main session still pays the cold start
($0.46 of $0.62 in run 9) with its first turn, and it still needs about the same number of turns of its own
(begin, hand over to the subagent, start the pipeline, show the result), because a subagent is started and
read back by turns of the main session. Only the 3 to 4 exploring and writing turns would move into the
small context. Computed from run 9's numbers: the turns after the first cost $0.14 in cache reads and writes;
with a subagent the same work would cost about $0.11 (main session $0.04, the subagent's own cold start and
growth about $0.06, its reads $0.01). **About 3 cents, 5 % of the run.** Against that: the subagent would
lose the project text in `CLAUDE.md` that the agent now uses instead of reading files, so the main session
would have to pass a summary (more output tokens) or the subagent would read the README and routes (more
turns); the paste blocks and the note would still have to come from the main session; and it adds a moving
part to every run. Before 0.4.0, at 15 turns, the saving would have been about 10 cents; cutting the turns
was the better lever. If the turn count grows again (change requests in a long session), this is worth
measuring for real.

## The estimate before a run

Before exploring, `pushreel begin` prints what the run is expected to cost on the session's model. It is a
range, and it is measured from the session:

```
Model: Claude Sonnet 5.5, the recommended model.
Estimated for this run on Claude Sonnet 5.5: about $0.60 to $1.00, €0.54 to €0.91 (your session carries about 127k tokens of context per turn; a large CLAUDE.md, many plugins and MCP servers are what make it large).
A range, not a quote: measured from this session's transcript, times the turn profile of our first runs, at API list prices (checked 2026-11-17). On a Claude subscription this counts against your plan limits, no extra charge.
```

That is the note of run 6, which then cost $0.72; run 9 printed the same range and cost $0.62. The same
range is printed again under the cost table at the end ("Estimate before the run: …"), next to what the run
really cost.

**How the note reaches the user** (0.4.0). Asking the agent to paste it failed in three runs in a row. In
the first 0.4.0 run the reason showed: the agent wrote the note into its *thinking*, which the user never
sees, and believed it had shown it. Now two pieces of fixed code carry it:

1. A `PostToolUse` hook (`hooks/hooks.json`, filtered with `"if": "Bash(pushreel begin*)"`, so it runs for
   no other command) answers right after `begin` with a `systemMessage`: Claude Code shows that to the user
   in the chat, whatever the agent writes. In `claude -p --output-format stream-json` it arrives as a
   `system` message of subtype `informational` before the agent's next tool call (runs 8 and 9).
2. `explore-shot` refuses to run ("Not yet: the user has not seen the model note …", exit code 6) until
   either the hook has shown the note or an assistant text after `begin` carries both amounts of its range.
   Text in thinking does not count. Where neither the hook nor a transcript exists (a plain terminal), it
   never blocks.

How it is computed (`estimateRange` in `src/model.js`):

1. **Measure.** The transcript of the session says, for every turn, how many tokens the model read: fresh
   input, cache reads and cache writes. The largest of the last three turns is the context a further turn
   will carry. The turns since the `/pushreel` prompt are what the run has already used, with their real
   split into cache reads and cache writes. A cold start is in there, already paid.
2. **Project.** A run is a number of turns. Each remaining turn reads the context once (cache read price),
   adds new tokens to it (tool results and its own answer, at the cache write price of the lifetime this
   session writes with) and produces output.
3. **Range.** Low and high come from `runProfile` in `config/prices.json`: 9 to 18 turns per run, 1,500 to
   3,000 new tokens per turn, 3,500 to 7,000 output tokens per run. Then rounded outwards to 5 cents.

estimate = cost already used + turns left × (context × cache read price + new tokens × cache write price)
           + the growth of the context over those turns + output

| Session | What was measured | Estimate on Sonnet 5.5 | Measured |
|---|---|---|---|
| DartStack, cold (`claude -p`), run 6 | 127k tokens per turn, 114k of them just written to the cache | $0.60 to $1.00 | $0.72 |
| DartStack, cold, run 9 (0.4.0, 7 turns) | the same | $0.60 to $1.00 | $0.62, at the low end |
| fixture app, small session, run 8 (0.4.0, 12 turns) | 35k tokens per turn | $0.15 to $0.50 | $0.22 |
| DartStack, run 5, computed afterwards from its numbers | 105k per turn, cold | $0.55 to $0.95 | $0.77 |
| the same session warm (computed, not run) | 105k per turn, already cached | $0.15 to $0.55 | |
| fixture app, computed from runs 2 + 3 | 22k per turn, cold | $0.15 to $0.45 | $0.24 at Sonnet prices |
| nothing measured (no transcript) | assumes 30k per turn, cold | $0.20 to $0.55 | |

Limits of the estimate

- **The turn profile comes from six runs on two apps.** A run with many change requests, a model that
  explores more, or a failing scene that the user asks the agent to repair has more turns than the profile.
- **Runs 6, 8 and 9 were estimated before they ran**, and all three landed inside their range, in its lower
  half. The other rows apply the formula to runs that were already measured. With 7 turns, run 9 needed
  fewer than the profile's low end (9); the range was not narrowed, because two runs on 0.4.0 are too few.
- **Tool results can be larger than the profile assumes.** In run 6 one batch explore added about 6k tokens
  to the context; the profile assumes at most 3k per turn. The run stayed inside the range because it
  needed fewer turns than the high end.
- **The cache can expire.** If a session sat idle for longer than its cache lifetime, the next turn writes
  the context again. The estimate cannot see that coming and is then too low by about the cold start.
- **Other models** get the same tokens at their own prices, cache prices included. Only Sonnet 5.5 and
  Fable 5.2 were ever compared with a real bill. Haiku is priced at its normal tier.
- The comparison with Sonnet 5.5 ("costs about 3.6× …") uses the middle of both ranges and is shown when
  the session's model is more than 15 % above the recommended one.
