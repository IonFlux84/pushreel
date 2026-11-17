# Pushreel

A plugin for Claude Code. You type one command in your project; the agent reads the project, explores the
running web app and proposes a shot list. After you confirm, fixed code records the app in a headless
browser in 9:16, cuts it and exports three files in one run:

```
pushreel-out/2026-11-17-tinywins/
  tinywins-short.mp4     YouTube Short     1080×1920, H.264/AAC, captions burned in
  tinywins-reel.mp4      Instagram Reel    same footage, caption placed for Reels
  tinywins-tiktok.mp4    TikTok            same footage, caption placed for TikTok
  tinywins-cover.png     Cover image       1080×1920
  captions.md            One post text per platform (drafts)
  shotlist.json          Your scenes, for re-rendering later
  run.log                What happened, step by step
```

Everything runs on your machine. Your app, your code and your videos are never uploaded. The only
network requests Pushreel makes are listed under [Data, network and privacy](#data-network-and-privacy).
Version 0.5.0.

Pushreel is paid software: it needs a licence key (one person, up to 3 machines), sold at
[pushreel.dev](https://pushreel.dev). The source is readable so you can check what it does; see
[LICENSE](LICENSE).

## Requirements

| | |
|---|---|
| Claude Code | tested with 2.1.326. Pushreel needs a local terminal, a browser and ffmpeg, so it works in Claude Code only, not in Claude chat or Cowork. |
| Node.js | 20 or newer (tested with 24.13) |
| ffmpeg and ffprobe | on your PATH (tested with 9.0.2). `brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install ffmpeg` |
| Chromium for Playwright | downloaded once by `pushreel setup`, about 100 MB |
| Operating system | tested on macOS only. Linux should work. Windows is untested. |

## Install

```bash
claude plugin marketplace add IonFlux84/pushreel
claude plugin install pushreel@pushreel
```

Claude Code copies the plugin into its plugin cache and installs its one npm dependency, Playwright
1.65.1, from the `package-lock.json` in the plugin root (exact versions, no install scripts, no custom
registry). Then download the recording browser once, in Claude Code:

```
/pushreel setup
```

or in a terminal: `pushreel setup`. This runs Playwright's own `install chromium`, which downloads
Chromium (about 100 MB) from Playwright's download server into Playwright's usual browser folder
(`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). If the browser is missing
when you start a run, Pushreel says so and asks before it downloads anything.

To try a local copy instead: `claude --plugin-dir /path/to/pushreel` after `npm install` in that folder.

## Activate

```
/pushreel activate <your-licence-key>
```

The key comes by email from Dodo Payments after the purchase. Activation is one request that sends the key
and a neutral label for this machine (`Pushreel on macOS · 3f9a`: the operating system and four random
characters) and nothing else. The hostname is never sent. `--name <label>` replaces the label with your own
text; that text is sent to Dodo Payments.

Works offline. At most once every 30 days, when you are online and start a recording, Pushreel re-checks
the key with Dodo Payments. Offline never blocks.

```
/pushreel licence            the stored state and this machine's label (offline)
/pushreel deactivate         frees this machine's place, so you can activate the key on another machine
```

One key is meant for up to 3 active machines. If all three are in use, run `/pushreel deactivate` on one
of them, then activate again. Details, messages and what is not yet verified against the real Dodo API:
[docs/LICENSING.md](docs/LICENSING.md).

## Use it in Claude Code

The command is `/pushreel`. Nothing has to be installed or written into your `~/.claude` folder for it:
Claude Code makes a plugin skill available under its short name as long as no other command uses that
name (tested with Claude Code 2.1.326, plugin installed through the marketplace commands).

| Command | What it does | Model |
|---|---|---|
| `/pushreel` | Explore, propose a shot list, ask, then record, cut, export | yes |
| `/pushreel --yes` | The same without asking | yes |
| `/pushreel http://localhost:3000` | Use the app at this address instead of finding or starting it | yes |
| `/pushreel login` | Open a browser window on your app; sign in by hand once, the session is saved for all later runs (OAuth, magic links, SSO) | no |
| `/pushreel logout` | Remove the saved session | no |
| `/pushreel studio` | Open the review screen at http://localhost:4317 | no |
| `/pushreel record` | Record the saved shot list again (your UI changed) | no |
| `/pushreel rerender` | Cut and export again after changing captions, lengths, scenes or targets | no |
| `/pushreel resume` | Continue a paused run; only failed and remaining scenes are recorded | no |
| `/pushreel resume --skip 3,4` | Continue without these scenes | no |
| `/pushreel cancel` | End a paused run, stop the app if Pushreel started it, keep scenes and shot list | no |
| `/pushreel status` | Where the run stands and what to do next | no |
| `/pushreel setup` | Download the recording browser (Chromium, about 100 MB) | no |
| `/pushreel activate <key>`, `licence`, `deactivate` | The licence, see above | no |
| `/pushreel config`, `/pushreel config reset` | Show the user settings; ask about the model again | no |

"no" means the agent only passes the command on; the work is fixed code and costs 0 tokens. The agent's
own short answer still costs a few tokens.

**If `/pushreel` does not start Pushreel:** you (or your project) have another command with that name, in
`~/.claude/skills/pushreel/`, `~/.claude/commands/pushreel.md` or the same under the project's `.claude/`.
Yours wins. Use the full name, which always works: `/pushreel:pushreel`, for example
`/pushreel:pushreel --yes`. `pushreel doctor` tells you if it sees such a command.

### The model

Pushreel uses the model your Claude Code session runs. Claude Sonnet 5.5 is the recommended one. Before
the agent starts exploring, Pushreel shows which model the session runs and what this run is expected to
cost, as a range measured from your session. It shows this note itself, through a Claude Code hook, and
exploring does not start before the note was shown:

```
Model: Claude Sonnet 5.5, the recommended model.
Estimated for this run on Claude Sonnet 5.5: about $0.60 to $1.00, €0.54 to €0.91 (your session carries about 127k tokens of context per turn; a large CLAUDE.md, many plugins and MCP servers are what make it large).
A range, not a quote: measured from this session's transcript, times the turn profile of our first runs, at API list prices (checked 2026-11-17). On a Claude subscription this counts against your plan limits, no extra charge.
```

(That run cost $0.62 with 0.4.0.) **What a run costs, measured with 0.4.0:** on Claude Sonnet 5.5 between
about $0.20 for a small project in a small session ($0.22 measured) and about $0.65 for a large project in a
fresh session ($0.62 measured). Two measured runs on this version, not a guarantee. What makes the difference
is not the app but the session: about three quarters of a large run is the first turn writing the session's
context (`CLAUDE.md`, plugins, MCP servers) into Claude's cache. **Tip: run `/pushreel` in a session you have
just been working in.** Its context is already cached, and the same run then costs a fraction (about $0.18
instead of $0.62 for DartStack, computed from the measured run). Details: [docs/COSTS.md](docs/COSTS.md).

On a model that costs more than Sonnet 5.5, and on Haiku (where the first shot list may be weak), it then
asks whether to continue or to stop and switch. Your answer decides; Pushreel never refuses a model.
"Continue and don't ask again" remembers the choice for that model in `~/.pushreel/config.json`;
`/pushreel config reset` forgets it. With `--yes` the note is printed and the run continues without a
question. The Studio shows the same note under the model chip.

## Use it without Claude Code

The whole pipeline runs from the terminal, given a shot list. This is the core promise: recording never
depends on a model.

```bash
pushreel activate <your-licence-key>
pushreel validate-shotlist my-shotlist.json
pushreel run --shotlist my-shotlist.json     # starts the app if needed, records, cuts, exports, stops the app
pushreel studio                              # review screen
pushreel help                                # every command
```

`pushreel` is `bin/pushreel` in the plugin folder. Inside Claude Code it is on the PATH of the Bash tool
while the plugin is enabled.

A complete example shot list: [docs/example-shotlist.json](docs/example-shotlist.json). The format
is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Logins and consent banners

**Showing what is behind a login.** Two ways, by how your app signs people in:

```bash
pushreel login                           # any login: Google, GitHub, magic link, SSO, password
export PUSHREEL_LOGIN="email:password"   # a test user for a plain email and password form
```

`pushreel login` (in Claude Code: `/pushreel login`) opens a visible browser window on your app. You sign
in by hand; when you press Enter or close the window, Pushreel saves that browser's session to
`.pushreel/auth.json`. Explore and record runs load it from then on. The file contains session cookies:
never commit it (`.pushreel/` belongs in `.gitignore`; the command says so if it is missing).
`pushreel logout` removes it. When the app has signed you out, the run pauses with "Your saved session has
expired. Run /pushreel login again."

With `PUSHREEL_LOGIN`, Pushreel fills the login form when a scene is redirected to it. The account is read
at run time and is never written to the shot list, the log or the output folder. Unusual forms can be
described with `login.steps` in the shot list.

Scenes behind the login are marked `"requiresLogin": true` and are recorded signed in. All other scenes
are recorded as a visitor, so a landing page looks the way a visitor sees it.

**Consent banners.** A cookie or consent dialog is dismissed once, before the recording, and is never in
the video: `"prepare": [ { "do": "click", "text": "Reject all" } ]` in the shot list. The agent finds the
dialog while exploring and puts the step there. By default it picks the option with the least tracking
(reject, necessary only); tell it if you want accept. Anything else that has to happen once (closing a
popup, switching the theme) goes into `prepare` too.

Logins with 2FA or a captcha on every visit cannot be recorded. All of it in detail:
[docs/LOGIN.md](docs/LOGIN.md).

## What Pushreel writes

| Folder | Content | Safe to delete |
|---|---|---|
| `.pushreel/` | shot list, stills, run state, raw footage, logs, the saved login (`auth.json`, `session.json`: session cookies) | yes, any time. You lose the recorded scenes and the saved login. |
| `pushreel-out/<date>-<app>/` | the finished files. A new run gets a new folder (`…-2`, `…-3`); `rerender` and `resume` write into their run's folder | yes |
| `~/.pushreel/license.json` | the activation: key, activation id, machine name, dates | run `pushreel deactivate` instead of deleting it, so the key's place is freed |
| `~/.pushreel/config.json` | models you chose "don't ask again" for; optional Dodo mode | yes |

Pushreel writes nothing into `~/.claude`. `PUSHREEL_HOME` moves `~/.pushreel` somewhere else.

Add this to your `.gitignore`:

```
.pushreel/
pushreel-out/
```

## Data, network and privacy

**Network requests.** Pushreel makes these requests and no others. There is no telemetry, no analytics,
no update check and no error reporting.

| When | To | What is sent |
|---|---|---|
| `pushreel activate <key>`, once per machine | Dodo Payments, `https://live.dodopayments.com/licenses/activate` | the licence key and a neutral machine label (`Pushreel on macOS · 3f9a`: operating system and four random characters). No hostname, no user name, no email, no project data. `--name <label>` sends your own label instead. |
| At most once every 30 days, when you are online and start a recording | Dodo Payments, `…/licenses/validate` | the licence key and the activation id. Offline never blocks: without an answer the run goes on. |
| `pushreel deactivate` | Dodo Payments, `…/licenses/deactivate` | the licence key and the activation id |
| `pushreel setup`, only when you run it or agree to it | Playwright's browser download server | a normal download request for Chromium |
| While exploring and recording | your own app, at the local address Pushreel found or you gave | the page requests a browser makes, plus the clicks and typing in the shot list |

Every request to Dodo Payments carries a `User-Agent: pushreel/<version>` header; Dodo sees your IP address,
as every server does. Dodo Payments is the merchant of record for the purchase; the activate answer
contains the buyer's name and email, and Pushreel does not store them. Details:
[docs/LICENSING.md](docs/LICENSING.md).

**What Pushreel runs on your machine.**

- If your app is not running, `begin` and `run` start it with your project's own start command (for
  example `npm run dev` or `composer run dev`, read from your project files) and stop it again at the end.
  An app that was already running is used and left running.
- A headless Chromium (Playwright) opens your app, clicks and types what the shot list says, and records
  it. If the page shows a cookie or consent dialog, Pushreel clicks the option with the least tracking
  (reject, necessary only) once, before recording, unless you ask for accept (`--consent accept`). This
  click happens in your app, so an app that keeps proof of consent records one answer per run.
- `pushreel login` opens a visible browser window on your app for you to sign in; the session is saved to
  `.pushreel/auth.json`. `PUSHREEL_LOGIN` (a test account for a password form) is read at run time and never
  written to disk by Pushreel.
- ffmpeg and ffprobe from your PATH cut and encode the videos.
- `pushreel studio` serves the review screen on `http://127.0.0.1:4317`, reachable from this machine only.
  It loads no remote fonts, scripts or images.
- Two Claude Code hooks (in `hooks/hooks.json`) run `node ${CLAUDE_PLUGIN_ROOT}/src/hook.js`: after
  `pushreel begin` it shows you the model and cost note as a system message, and after each answer it
  refreshes the token count of a running Pushreel run. Outside a Pushreel run both do nothing. Neither
  sends anything.

**The session transcript.** For the model note and the cost table, Pushreel reads the current Claude Code
session's transcript file (`~/.claude/projects/<project>/<session-id>.jsonl`) on your machine. It takes the
model name and the token counts of each answer. To check that you have seen the model note, it looks for
the note's two amounts in the assistant's visible text. It never stores or sends conversation content:
only model names, token counts, step times, the session id and the amounts it computes are written, to `.pushreel/cost.json`, `.pushreel/cost-marks.json`
and `.pushreel/model.json` in your project.

**Files Pushreel writes** (see also [What Pushreel writes](#what-pushreel-writes)): `.pushreel/` and
`pushreel-out/` in your project, and `~/.pushreel/license.json` and `~/.pushreel/config.json` in your home
folder. Nothing is written into `~/.claude`. All of it stays until you delete it.

**Privacy policy:** [pushreel.dev/privacy.html](https://pushreel.dev/privacy.html).
**Support and security reports:** [hello@pushreel.dev](mailto:hello@pushreel.dev).

## Troubleshooting

- `pushreel doctor` (or `/pushreel status`) checks Node, ffmpeg, the browser and the licence and prints a
  fix for each missing piece.
- Every run writes `run.log` into its output folder (and `.pushreel/run/run.log` while it runs); a paused run says how to go on
  with `/pushreel resume`, `/pushreel resume --skip 3,4` or `/pushreel cancel`.
- Licence messages and what to do about each: [docs/LICENSING.md](docs/LICENSING.md), "Messages".
- Logins, saved sessions and consent banners: [docs/LOGIN.md](docs/LOGIN.md).
- Still stuck: write to hello@pushreel.dev with the `run.log`.

## Limits

- Web apps only: anything that renders in Chromium. No native apps, no desktop apps, no extensions.
- Logins with 2FA or a captcha on every visit stop the scene.
- The browser session carries on from scene to scene (one for visitor scenes, one for signed-in scenes). What a scene changes in the app stays changed for the next one, like for a real user.
- Captions avoid the element that is clicked, large headings and fixed bars. They do not know about pictures, avatars or cards and can sit on those.
- Scenes whose steps end early are shortened: at most 2 s of still picture after the last action (`"cut": { "trimStillTails": false }` keeps the full length). The video can therefore be shorter than the sum of the durations.
- Pushreel clicks what a user would click. Point it at a development setup, not at production data.
- No voice-over and no music: the files have a silent audio track.
- Captions are in the language you (or the agent) write them in. One caption per scene.
- Recording captures up to 60 frames per second of real browser output and exports at a constant 30. Heavy WebGL or canvas scenes may stutter.
- The safe-area numbers are ad specifications or third-party figures, because none of the three platforms publishes numbers for normal posts. See [docs/PLATFORMS.md](docs/PLATFORMS.md).
- The per-step token numbers are an approximation. See [docs/COSTS.md](docs/COSTS.md).

## More

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it is built, the shot list format, the decisions
- [docs/LOGIN.md](docs/LOGIN.md): saved sessions, login scripts for CI, consent banners and `prepare`, the browser session
- [docs/PLATFORMS.md](docs/PLATFORMS.md): platform values with sources
- [docs/LICENSING.md](docs/LICENSING.md): Dodo Payments, what is sent and stored, the re-check, the founder's checklist
- [docs/COSTS.md](docs/COSTS.md): how tokens are counted and what the limits are
- [docs/example-shotlist.json](docs/example-shotlist.json): a complete shot list
- [LICENSE](LICENSE): the licence terms
