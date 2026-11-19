# Architecture

## The split

| Half | Who | What | Tokens |
|---|---|---|---|
| Explore, shot list, captions, post texts | the model of your Claude Code session, steered by `skills/pushreel/SKILL.md` | reads the project, calls the CLI tools, writes `.pushreel/shotlist.json` | yes |
| Start app, record, retry, cut, export, Studio | fixed code in `src/`, called as `pushreel <command>` | replays exactly the steps in the shot list | 0 |

The contract between the two halves is one file: `shotlist.json`. Given that file, the pipeline runs from a
plain terminal with no model at all.

## Folder map

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   makes this folder a one-plugin marketplace
skills/pushreel/SKILL.md          the instructions for the agent (the /pushreel command)
hooks/hooks.json                  PostToolUse hook (model note after `begin`) and Stop hook (cost numbers); both run src/hook.js
bin/pushreel                      the CLI entry
src/cli.js                        every command
src/pipeline.js                   record → cut → export, run state, pause, resume, cancel
src/detect.js                     find the running app, start it, stop it
src/origin.js                     which addresses may be opened: the app on this machine, --allow-remote
src/browser.js                    Chromium launch at 1080×1920, visible cursor, step executor, smooth scroll, layout capture, prepare, login form
src/record.js                     records scenes in one browser context, saves the session, retries with doubled waits
src/session.js                    the saved browser session (pure): auth.json, session.json, prepare, .gitignore advice
src/login.js                      pushreel login: visible window or login script, logout
src/consent.js                    consent dialogs: candidates from the page, the choice (pure)
src/explore.js                    explore-shot: one or several pages, a still each, what is on them, consent dialog
src/place.js                      where captions and the cover headline sit (pure): click target, headings, pictures, titles, bars, zoom
src/notegate.js                   the model note: the hook that shows it after `begin`, and the gate of explore-shot
src/motion.js                     scroll easing and length, step time estimate, still-tail trimming (pure)
src/timeline.js                   cut planning (pure): waits, lengths, zoom keyframes, video plan
src/cut.js                        ffmpeg: cut, zoom, overlays, three exports, cover, captions.md
src/render.js                     the one renderer for captions, end card, cover, intro card and corner logo (Chromium → PNG),
                                  page builders shared with the Studio's Style screen
src/style.js                      styles: the table of settings (SPEC), layers and sources, validation, contrast, files
src/template.js                   story templates and rules: brief for the agent, checks for the validator (pure)
src/brand.js                      style init: brand colour, font and logo of the running app
styles/                           the built-in styles clean, bold, neon (JSON)
templates/                        the built-in templates launch, feature, changelog (JSON)
docs/style.schema.json            JSON schema of pushreel.style.json, written from SPEC by scripts/style-schema.mjs
src/presets.js                    platform presets: safe areas, length caps, encoder settings
src/shotlist.js                   validation, defaults, scene fingerprint
src/license.js, src/providers/    licence gate behind a provider interface; providers/dodo.js is the real one
src/model.js                      the model note: session model, the session's measured context, cost range, ask or continue
src/userconfig.js                 ~/.pushreel/config.json (remembered model choices, Dodo mode)
src/cost.js                       tokens and cost per step from the session transcript
src/errors.js                     the failure catalogue
src/studio/server.js              local review server, JSON API, server-sent events
src/studio/public/                the Studio pages, styles, fonts (all self-hosted)
config/prices.json                editable price table with a "last checked" date
config/license.json               licence provider, Dodo product ids and mode, re-check interval
fixtures/tinywins/                the test app
test/                             unit tests (node:test); test/support/ holds the Dodo mock, the dev licence provider and the test entry (not shipped)
scripts/e2e/                      end-to-end scripts
```

One dependency: `playwright` (pinned). ffmpeg is the system binary. No build step.

## State in the user's project

```
.pushreel/
  shotlist.json          the working shot list
  stills/scene-N.png     still per scene (from exploring, replaced by a frame of the recording)
  run.json               state of the current run
  app.json, app.log      the app process, only if Pushreel started it
  address.json           the app address the user passed (detect-app <url>, run <url>); later commands use it
  auth.json              the saved login of `pushreel login` (session cookies: never commit)
  session.json           the browser state every recording starts from: auth.json + prepare + the scenes so far
  explore-session.json   the same for exploring      consent.json   the consent button exploring found
  cost-marks.json        step markers                   cost.json   last cost report
  model.json             the last model note with the measured context (for the Studio)
  choice.json            --style and --template of the last /pushreel (begin); used when the shot list names none
  run/raw/scene-N.mp4    recorded footage per scene     run/raw/scene-N.json   its events
  run/failed/scene-N.png what the browser saw when a scene failed
  run/cut/               intermediate files of the last cut
  run/run.log
pushreel-out/<date>-<slug>/   the result (a new run never overwrites an earlier one: -2, -3 …; resume and rerender write into their run's folder)
```

Everything in `.pushreel/` can be deleted. Next to it, in the project root, `pushreel.style.json` (the project's
style, written by `style init`, `style set` or the Studio) is meant to be committed.

User-level state is in `~/.pushreel/` (`PUSHREEL_HOME` moves it): `license.json` (the activation) and
`config.json` (models with "don't ask again", optional Dodo mode). Nothing is written into `~/.claude`.

## shotlist.json

```jsonc
{
  "version": 1,
  "app": { "name": "Tiny Wins", "slug": "tinywins", "address": "tinywins.app", "tagline": "…", "brandColor": "#5b3df5" },
  "baseUrl": "http://localhost:5173",          // optional; otherwise detected
  "viewport": { "width": 360 },                // 360, 432 or 540 CSS px; the picture is always 1080×1920
  "colorScheme": "light",                      // or "dark"
  "cursor": true,                              // draw the cursor
  "targets": ["short", "reel", "tiktok"],
  "cut": { "zoom": 1.4, "removeWaitsOver": 0.6, "captions": true, "endCard": true,
           "trimStillTails": 2 },             // seconds of still picture kept after a scene's last step; false = never trim
  "prepare": [ { "do": "click", "text": "Reject all" } ],   // optional: runs before the recording, never in the video; or { "url": "/", "steps": [ … ] }
  "login": { "url": "/login", "steps": [ { "do": "type", "selector": "#email", "value": "{{email}}" }, … ] },  // optional, for PUSHREEL_LOGIN
  "cover": { "scene": 4, "at": "start", "headline": "21 days of tiny wins" },   // at: "start" (default: settled, before the first click), "end", or seconds
  "scenes": [
    { "id": 1, "title": "Today screen", "url": "/today", "duration": 6, "caption": "Four habits, one tap each.",
      "include": true, "requiresLogin": false,
      "steps": [ { "do": "hold", "ms": 1400 }, { "do": "click", "selector": "[data-habit=read]" } ] }
  ],
  "posts": { "short": { "title": "", "description": "" }, "reel": { "caption": "" }, "tiktok": { "caption": "" } },
  "style": "neon",                             // optional (0.6.0): a style name, or single values for this run:
                                               // { "extends": "neon", "captions": { "size": 68 } }
  "template": "launch"                         // optional (0.6.0); then every included scene has "slot": "hook" | …
}
```

Since 0.6.0 the look (caption type and colours, end card, cover, intro, corner logo, pointer, zoom) comes from a
style (docs/STYLES.md): `src/style.js` resolves the layers (built-in, `~/.pushreel/styles`, `pushreel.style.json`,
the shot list) into one complete style and `applyStyle` writes it into the normalized shot list (`cut.zoom`,
`cut.endSeconds`, `cut.introSeconds`, `cursor`, `motion`, `look`). `cut.zoom`, `cut.endCard`, `cursor: false`
and `cover.scene` in the shot list are its last layer; `app.brandColor` sits under the project file.
`prepareShotlist` validates the shot list, the style and the template rules in one pass; `validate-shotlist`,
`run` and the Studio all use it.

Steps

| `do` | Fields | In the cut |
|---|---|---|
| `click`, `hover` | `selector` (CSS or Playwright selector) or `text`; optional `at: [0.5, 0.5]`, `timeout` | click → zoom |
| `type` | `selector`, `value`; optional `delay`, `clear` | kept |
| `press` | `key` | kept |
| `scroll` | `y` (CSS px, down is positive) or `selector` (brought to the middle) | kept; an eased movement, 350 ms + 0.9 ms per px, between 450 ms and 2.6 s |
| `goto` | `url` | load time counts as a wait |
| `hold` | `ms` | kept: a pause for the viewer |
| `wait` | `ms` | technical wait: shortened to the threshold, doubled on a retry |
| `waitFor` | `selector` or `text`; optional `timeout` | technical wait |

`app.slug` may contain a-z, 0-9 and single hyphens. Since 0.4.0 `validate-shotlist` prints three kinds of
lines: errors (block the run), `!` warnings (each asks for a change, for example a caption that repeats a
heading that exploring saw on that page, from `.pushreel/stills/*.json`) and `·` information that needs no
action (still picture the cut trims by itself). `pushreel validate-shotlist` checks all of it and names
the scene and the step of every problem. It warns when a scene ends in more than about 2 s of still picture
(its duration is much longer than its steps take), and when exploring found a consent dialog that the shot
list does not dismiss in `prepare`.

## Recording

- Chromium is launched with a forced device scale factor (3 for a 360 px wide viewport) and the same factor
  in the page, so the page is laid out like a phone and rendered at exactly 1080×1920.
- The picture comes from the DevTools screencast: one JPEG per painted frame, with its timestamp. Frames are
  then encoded to a constant 30 fps clip per scene (`run/raw/scene-N.mp4`). A screenshot loop was tried first
  and dropped: it reached only 30 pictures per second and at the wrong resolution.
- The cursor is an element injected into the page that follows the real mouse; clicks draw a ring. The mouse
  glides to its target with an eased path. The arrow is hidden at the start of each scene and appears with
  the first mouse move (0.4.0), so the settled opening picture, which is also the default cover, has no
  parked arrow in it.
- Every step is timed. Clicks are logged with time, position and target size; waits with start and end;
  scrolls with distance and length. At the start of a scene and after every step that can change the page,
  the boxes of the visible large headings (`h1`, `h2`, `role=heading` up to level 2), of smaller titles
  (`h2` to `h4` in small type, and bold labels of 15 px and more, such as card and tile titles), of pictures
  (`img`, `svg`, `canvas`, `video` and elements with a background image, 28 CSS px and larger, not a
  backdrop that fills most of the screen) and of bars fixed or stuck to the top or bottom edge are written
  into the scene log (`layout`). The caption and cover placement read them.
- `scroll` is animated in the page, one position per painted frame, with an ease-in-out curve. The page's
  own `scroll-behavior` is switched off for the moment. A page that scrolls inside a container gets the
  same curve as wheel events.
- **One browser context for the whole run, per lane.** Scenes with `requiresLogin` are recorded in the
  "user" lane, which starts from the saved login (`auth.json`); all other scenes in the "guest" lane, a
  visitor who is not signed in (a landing page sends a signed-in user away). A lane is opened at its first
  scene: the `prepare` steps run in it, unrecorded, and its state goes to `.pushreel/session.json`. Every
  scene is a new tab in its lane's context, so cookies and local storage carry on. After every recorded
  scene the lane's state is saved again. A retry closes the context and reopens it from the last saved
  state, so a failed attempt leaves nothing behind in the browser and does not click a toggle a second
  time. `resume` and a single re-recorded scene load the file instead of repeating `prepare` or the login.
  `explore-shot` opens pages the same way (`"requiresLogin": true` per page). See docs/LOGIN.md.
- A failing scene is retried up to 2 times. Each retry doubles every `wait`, every timeout and the page-load
  timeout. No model is involved. Login walls, expired sessions and verification steps are not retried,
  because waiting does not help.
- If a scene still fails, the run is paused: recorded scenes stay, a screenshot is saved, the app keeps
  running (if Pushreel started it), and the message names the next commands.

## Styles in the pipeline

Nothing about the look is decided by the model. `begin --style --template` checks the names, prints the style
line and the template brief, and remembers the choice in `.pushreel/choice.json`. The agent fills the slots;
`validate-shotlist` turns every broken measurable rule into an error (src/template.js, `checkRules`). The
renderer reads the complete style from the shot list (`look`); its page builders take URL resolvers, so the
Studio's Style screen shows exactly the pages the renderer draws (fonts from `/fonts/`, project files from
`/media/project/`, which serves only fonts and logos inside the project). The pointer, the click ring and the
scroll speed are part of the scene fingerprint only when they differ from the look before 0.6.0, so older
footage stays valid with the default style.

## Cut

`src/timeline.js` plans, `src/cut.js` executes.

1. Waits longer than the threshold are shortened to the threshold (half kept at each end).
2. The scene is trimmed to its `duration`, never inside an action. If the steps take longer than the
   duration, the scene runs longer and the log says so. If the footage is shorter, the last frame is held.
   That is why changing a duration never needs a new recording.
   **Still tails:** a scene whose steps end early would show seconds of frozen page. By default the scene
   ends 2 s after its last action (a click, a scroll, typing); a `hold` after it is kept whole, plus 0.4 s.
   The length is rounded up to half seconds and is at least 2 s, and the log says how much was trimmed. `"cut": { "trimStillTails": false }` keeps every scene at its full duration; a number sets
   the seconds. The footage is always recorded to the full duration, so switching it needs no new recording.
3. Zoom: for every click the picture scales to 1.4× around the click point (0.35 s in, 1.2 s hold, 0.45 s
   out, smoothstep). Clicks close together share one zoom and the focus pans.
4. Captions, end card and cover are rendered by one renderer (HTML in headless Chromium → PNG) and overlaid
   by ffmpeg. **Caption placement** (`src/place.js`): the caption sits on the bottom edge of the platform's
   safe area. The renderer measures the box, then the rules apply in this order: (1) never cover the element
   that is clicked, neither where it is on the page nor where the zoom shows it (of a large element, the
   16 % of the frame height around the click point count; grazing under 12 % of the target does not count);
   (2) avoid what the page shows, weighted by kind and by how long it is on screen during the scene: the
   `h1` (×2), pictures (×1.5: images, avatars, mascots, drawings), large headings and fixed bars (×1), card
   titles and bold labels (×0.6). The scene is looked at every 0.25 s, and while the picture is zoomed every
   box is moved and enlarged the way the zoom shows it (0.4.0); (3) stay as close to the bottom edge as
   possible. Candidates are positions 48 px apart inside the safe area, so a caption that has to move goes
   to the nearest free band above. If no position is free, the caption is tried in smaller type (down to
   50 px to get off a click target, down to 62 px to get off page content) and then takes the position that
   covers least, by measured overlap; the log says so and what it covers ("no free spot, took the one that
   covers least (up to 23 % of it on a picture)"). One position per scene and platform, never a jump inside a
   scene. The log names every caption that moved and any caption outside the safe area. Not known to the
   placement: plain text (paragraphs, numbers in normal weight) and faces as such; a face counts only as
   part of the picture it is in.
   **Zoom focus:** the crop follows the click point (fixed in 0.3.0: the crop filter read the frame size
   once, so every zoom before 0.3.0 showed the top left corner of the page instead of the click).
   **Cover:** a frame of the cover scene (`cover.scene`, default the first scene) at `cover.at` (default:
   0.5 s in, or earlier if the first click comes sooner, so the page has settled and nothing is zoomed).
   The headline box (112 px type since 0.4.0, at most 82 % of the width) sits in the centre of the part that
   survives the 4:5 and 1:1 grid crops and moves by the same rules when the page's own headline is there; it
   also avoids pictures, titles and bars where it can. No cursor arrow in the default cover frame.
   **Since 0.6.0** the caption starts at the style's `captions.position` (bottom, top, or `auto`: the end that
   covers less, bottom on a tie) and keeps off the corner logo (weight 3); the rules above apply unchanged.
5. Per target: optional intro card + scenes + captions + corner logo + end card (2 s by default; the style sets
   1 to 5 s) + silent stereo AAC → H.264 High, yuv420p, 30 fps constant,
   BT.709, CRF 18 capped at 12 Mbit/s, `+faststart`.

## Re-render without re-recording

Each recorded scene stores a fingerprint of what determines its picture: address, steps, viewport, cursor,
colour scheme, login. Captions, durations, `include`, targets and cut settings are not part of it. `rerender`
and `resume` record only scenes whose fingerprint has no matching footage; everything else is cut from disk.

## App lifecycle

`detect.js` looks for evidence of the port (start script, `.env`, framework default, the entry file) and
probes it. If nothing answers, it starts the project's own command in its own process group, waits until a
port answers, and remembers the process in `.pushreel/app.json`. Ports that already answered before the
start are never taken for the app. Only an app recorded in `app.json` is ever stopped (`run` at the end,
`cancel`, `stop-app`).

The files in `.pushreel/` are not trusted (a cloned repository may carry them). Since 0.6.1:

- **Process ownership.** `app.json` and `run.json` store `pid` and `pidStart`, the process start time the
  system reports (`ps -o lstart= -p <pid>` with `LC_ALL=C TZ=UTC` on macOS and Linux, PowerShell's
  `Get-Process` `StartTime` on Windows). `src/util.js` `signalOwned` signals only a whole pid above 1 that is
  not Pushreel itself, of this user (EPERM counts as not alive), whose start time still matches. A recycled or
  planted pid is never signalled; there is no fallback from the group to another target. The app's group is
  signalled as `-pid` only after that check. Chosen over a token in the child's environment because reading
  another process's environment is not portable, while the start time is. A record without `pidStart`
  (written by 0.6.0) is not stopped.
- **Paths.** The Vite hot file is removed only at `<project>/public/hot` (real path inside the project), and
  only when the local server it names is gone. `run.outDir` is used (resume, rerender, Studio save,
  `/media/out/`) only when it resolves inside `<project>/pushreel-out/`, symbolic links included.
- **Addresses** (`src/origin.js`). Every address is pinned to the app on this machine: `localhost`,
  `*.localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`, `*.test`. Explicit URLs of `run`, `begin`, `detect-app`,
  `explore-shot`, `login` and `style init` are checked before any request; remembered addresses
  (`address.json`, `app.json`, `run.json`) that are not local are ignored; every scene, `goto`, `prepare` and
  `login.url` must be on the app's origin (validator, pipeline, and again in `navigate()` before the browser
  opens it). `--allow-remote` lifts this for one command; it is never stored. `PUSHREEL_LOGIN` is typed only
  when the page's origin equals the app's (`runStep`), with or without the flag.

## Studio

`pushreel studio` serves `src/studio/public/` on 127.0.0.1:4317. Markup and styles are the approved
prototype; `studio.js` replaces the prototype's mock data with `/api/state` and `/api/events`.
"Record and export" starts the same CLI pipeline as a child process; the page follows `run.json`.
The server refuses requests with a foreign `Host` header, and writes whose `Origin` is not exactly the
Studio's own (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) or missing. Fonts are in
`public/fonts/`; the pages load nothing from the network.

## Decisions

1. **Command name: `/pushreel`.** Claude Code namespaces plugin skills (`/pushreel:pushreel`), but a plugin
   skill whose frontmatter sets `name` is also reachable by that bare name "unless another command already
   uses that name" (code.claude.com/docs/en/skills, "How a skill gets its command name"). The skill's `name`
   is `pushreel`, so `/pushreel` works with nothing installed outside the plugin. Verified in 2.1.326:
   Claude Code itself rewrites `/pushreel status` to `/pushreel:pushreel` with the arguments `status`, before
   any model is involved. Rejected: a shim skill or command written into `~/.claude` (a second file to keep
   in step with plugin updates, and it would take the name away from the plugin skill); installing the whole
   plugin under `~/.claude/skills/pushreel/` (no marketplace updates). The only case where `/pushreel` is
   not Pushreel is a user or project command of the same name; then the user's command wins, which is
   right, `pushreel doctor` says so, and `/pushreel:pushreel` remains.
2. **`.pushreel/shotlist.json`** is the working copy (not the project root), a copy goes into the output folder.
3. **TikTok cap 180 s**, not 600 s: 3 minutes is what every account can post.
4. **Captions may move to the top edge of the safe area** when they would hide the click. The safe areas
   from the ad specs reserve the lower 35 % of the frame, which puts a bottom caption in the middle of the app.
5. **A fifth cost row, "Summary in the chat"**, because the agent's last answer costs tokens and belongs to
   no pipeline step.
6. **One browser context per run, saved after every scene** (0.3.0; before: a fresh session per scene, which
   showed a consent banner in every scene of a real app). Determinism is kept by retrying from the last
   saved state. Scenes build on each other like a user's session does; the skill tells the agent so.
7. **Post texts are written before the pipeline runs**, so one run produces `captions.md` with them.
8. **`/pushreel record`** exists next to `rerender`: record the saved shot list again after a UI change.
9. **Raw footage stays in `.pushreel/run/raw/`**, not in the output folder.
10. **Licence provider: Dodo Payments**, through its three public licence endpoints; no secret in the plugin.
    It is the only provider in `src/`; the dev provider for the tests lives in `test/support/` and is not
    shipped (`scripts/check-release.sh`). Activation sends the key and a neutral machine label, never the
    hostname. Works offline; at most once every 30 days, when online and a recording starts, the key is
    re-checked; offline never blocks. One key is meant for up to 3 machines (set in the Dodo dashboard).
    See docs/LICENSING.md.
11. **The model is recommended, never enforced.** `pushreel begin` (or `model-check`) reads the session's
    model and its context size from the transcript, estimates the run as a range, and tells the
    agent whether to ask. The decision logic is fixed code (`src/model.js`); the agent only relays it.
    On a more expensive model the note is printed a second time by fixed code under the cost table.
12. **A saved browser session for logins without a password form** (`pushreel login`), next to
    `PUSHREEL_LOGIN`. Rejected: driving the OAuth provider (2FA, bot checks, the provider's terms),
    importing cookies from the user's own browser profile (touches data Pushreel has no business with).
13. **Consent dialogs go into `prepare`, and the default is the button with the least tracking.** A demo
    video should not make a privacy choice for the viewer's eyes; reject also keeps analytics out of the
    recording session.
14. **The cost estimate is a range measured from the session**, not a fixed profile: the context a turn
    carries differs by a factor of five between a small and a large project, and it is what a run mostly
    pays for. See docs/COSTS.md.
15. **The agent's turns are budgeted**: `begin` replaces five calls, `explore-shot --batch` looks at all
    pages in one call, the shot list is written once with its post texts, and the pipeline marks its own
    cost steps. Every saved turn saves one re-read of the whole context.
16. **Lines the user must see are printed between markers** and the skill tells the agent to paste them
    unchanged, because tool output is not visible in the chat and agents paraphrase.
17. **Styles are data, applied by fixed code** (0.6.0). A JSON file per style, one table of settings (`SPEC`)
    from which the validator, the JSON schema and the Studio form are made. Rejected: CSS files supplied by the
    user (no validation, no contrast check, and a stylesheet can load from the network).
18. **Fonts and logos only from inside the project**, checked by real path (symbolic links included), extension,
    content and size. The Studio serves them for previews under the same check.
19. **Templates enforce only what can be measured.** Person, language and tone go to the agent as instructions;
    slots, word counts, banned words, emoji, paths, lengths and hashtags are errors. A rule that cannot be
    checked would only cost turns.
20. **`app.brandColor` under the project file.** The second field test showed an agent copying the example's
    purple; a style file the user made must win over a colour the agent wrote. `explore-shot` now reports the
    app's own colour (`brand`), and the skill's example no longer carries one.
