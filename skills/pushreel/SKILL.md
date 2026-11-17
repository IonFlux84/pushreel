---
name: pushreel
description: Record the user's running web app in 9:16 and export a YouTube Short, an Instagram Reel and a TikTok with burned-in captions, a cover image and post texts. Use when the user types /pushreel or asks for a short vertical demo video, reel, short or TikTok of their app.
argument-hint: "[url] [--yes] | login [url] | logout | resume [--skip 3,4] | cancel | rerender | record | status | studio | setup | activate <key> | licence | deactivate | config"
allowed-tools: Bash(pushreel *), Bash(pushreel), Read, Glob, Grep, Write, Edit
---

# Pushreel

You are running Pushreel in the user's project. Arguments: `$ARGUMENTS`

Pushreel has two halves. **You** read the project, explore the app and write the shot list and the texts.
**Fixed code** (the `pushreel` command) starts the app, records, cuts and exports. It uses no model.
Never improvise during recording: you do not click, record or cut yourself. You only write `shotlist.json`.

The user typed `/pushreel` (the long form `/pushreel:pushreel` is the same command). When you name a command to the user, use the short form.

The command `pushreel` is on your PATH while this plugin is enabled. If the shell cannot find it, call
`"${CLAUDE_PLUGIN_ROOT}/bin/pushreel"` instead (keep the quotes). Run every command from the project root.

Run each `pushreel` command as its own Bash call: no `&&`, no `;`, no pipes, no `echo`, no heredocs. Chained
commands are refused by the permission rules. Write files with the Write tool.

## Two rules that hold everywhere

**Every turn costs.** Each of your turns reads the whole session context again; in a large project that is
100k tokens and more per turn. So: few turns. Use the batch forms below, call independent tools in the same
turn, do not re-read a file whose content is already in your context (CLAUDE.md, a README you were given),
and do not narrate between tool calls.

**Paste blocks.** The user does not see tool output. When a `pushreel` command prints lines between

```
----- PUSHREEL: copy the lines between these two markers into the chat, word for word … -----
----- END -----
```

you write exactly those lines into the chat: same words, same numbers, same language (English), same order,
every row, nothing added, nothing left out, not translated, not turned into another table. Leave out the two
marker lines themselves. Put the lines into one fenced code block so the columns stay aligned.

## 0. Which mode

Look at the arguments first.

| Arguments | Do this |
|---|---|
| `activate <key>` | Run `pushreel activate <key>` and show the answer word for word: it says what was sent and what was stored. Stop. |
| `licence` (or `licence check`), `deactivate`, `config` (or `config reset`), `doctor`, `setup` | Run the same `pushreel` command and show the answer. Stop. (`setup` downloads Chromium, about 100 MB; the user asked for it by typing it.) |
| `status` | Run `pushreel status` and show the answer. Stop. |
| `login` (optional URL) | First tell the user in one sentence: "A browser window opens on your app. Sign in there, then close the window." Then run `pushreel login` (with the URL, if given) with a 10 minute timeout and show its answer word for word: it says where the session is stored, that the file must not be committed, and how to remove it. Stop. Never ask for a password and never type one yourself. |
| `logout` | Run `pushreel logout` and show the answer. Stop. |
| `resume` (optional `--skip 3,4`) | Run `pushreel resume` with the same options. Go to step 5. |
| `cancel` | Run `pushreel cancel` and show the answer. Stop. |
| `rerender` | Run `pushreel rerender`. Go to step 5. Use it after captions, lengths, included scenes or targets changed. |
| `record` | Run `pushreel run`. It records the saved shot list again, for example after the UI changed. Go to step 5. |
| `studio` | Start `pushreel studio --no-open` with `run_in_background: true` and tell the user to open http://localhost:4317. Stop. |
| empty, a URL, and/or `--yes` | The full flow below. A URL is the address of the running app. `--yes` skips the confirmation in step 3. |

`resume`, `cancel`, `rerender`, `record`, `login` and `logout` are fixed code. Do not read the project or explore for them. They cost almost no tokens, and that is the point.

## 1. Begin: one call

Run `pushreel begin --session ${CLAUDE_SESSION_ID}`, with the URL if the user passed one and with `--yes`
if the arguments contain `--yes`. It checks the machine and the licence, starts the cost tracking, finds the
app (or starts it with the project's own command; the pipeline stops it again at the end) and prints the
model note.

- A line marked `✗` (licence not active, ffmpeg or the recording browser missing): show the message and its
  fix line and stop. Do not explore without a licence. For the browser, tell the user that `pushreel setup`
  downloads Chromium once (about 100 MB, from Playwright's download server) and ask whether to run it now.
  Run `pushreel setup` only after the user says yes; otherwise stop.
- `App: nothing answers …` or `App: … did not start`: show the message, ask the user to start the app or to
  pass an address (`/pushreel http://localhost:3000`), and stop.
- The paste block is the model note: which model this session runs and what this run is expected to cost,
  as a range measured from this session. **Pushreel shows it to the user itself**, right after `begin` (a
  Claude Code hook), so you do not paste it. Do not add your own opinion about models. If `explore-shot`
  refuses with "Not yet: the user has not seen the model note", the hook could not show it: then write the
  note as the visible text of your reply (not in your thinking: the user does not see that) and repeat the
  call in the same message. If the block says it could not read the model, run
  `pushreel model-check --model <your exact model id>` once and paste that block.
- The last line decides:
  - `Decision: continue …`: go on with step 2. With `--yes` this is always the case.
  - `Decision: ask`: ask exactly this and end your turn: "Continue with this model, or stop and switch with /model? (You can also say: continue and don't ask again for this model.)" Do nothing else until the user answers.
    - "continue", "yes": go on with step 2.
    - "don't ask again": run `pushreel model-remember --session ${CLAUDE_SESSION_ID}`, show its answer, go on with step 2.
    - "stop", "switch": say "Nothing was explored or recorded. Switch with /model, then run /pushreel again." and stop.
    This is a note, never a gate: any answer that is not "stop" means continue.
- The `Login:` line says whether a saved session exists. Remember it for step 2.

## 2. Pass 1: explore (nothing is recorded)

Goal: 3 to 5 scenes that show what the app does, in 20 to 40 seconds.

1. You need the product in one sentence, the main screens with their routes, and the public address
   (domain) for the end card. If CLAUDE.md or other project text in your context already tells you, **do
   not read any file**. Otherwise read the README and the route list, in one turn, and nothing else.
2. Look at all candidate screens **in one call**:
   `pushreel explore-shot --batch '[{"url":"/","name":"scene-1"},{"url":"/streaks","name":"scene-2"},{"url":"/settings","name":"scene-3","requiresLogin":true}]'`
   For each page it prints the final address, headings, the interactive elements with a `selector` (or
   `useText`) each, whether it is a login page, and the path of a still. Read a still only when the JSON is
   not enough to judge the screen.
3. Pick the action that makes each scene worth watching (one or two clicks, a typed word, a scroll), then
   **test all scenes in one call**, each with its steps:
   `pushreel explore-shot --batch '[{"url":"/","name":"scene-1","steps":[{"do":"click","selector":"#save"}]}, …]'`
   Only steps that ran here go into the shot list. The still saved under the scene's name is what the Studio
   shows. Aim for two explore calls in total and use at most four.
4. **Consent and cookie dialogs.** If a report has `consent`, the page showed a consent or cookie dialog.
   The tool already clicked the option with the least tracking (reject, necessary only) so the stills show
   the app. Copy `consent.prepare` into the shot list's `prepare` list. **Never put a consent click into a
   scene**: `prepare` runs before the recording and is not in the video, and the choice then holds for all
   scenes. Only if the user said they want the accept option, add `--consent accept` to the explore calls
   and use the `prepare` step that comes back. Other one-off setup (closing a newsletter popup, switching a
   theme) also belongs in `prepare`, with the same step vocabulary as scenes.
5. **Login: visitor or signed in.** Every page is opened the way it will be recorded. Without
   `"requiresLogin": true` a page is opened **as a visitor**, also when a login is saved: that is how a
   landing page or a public profile must look (an app often sends a signed-in user away from its landing
   page). With `"requiresLogin": true` in the batch entry, the page is opened **signed in**, and the scene
   gets the same `"requiresLogin": true` in the shot list. So when the `Login:` line of step 1 says a
   session is saved (or `PUSHREEL_LOGIN` is set), put the app's signed-in screens (dashboard, the user's
   own pages, community areas) into the first batch with `"requiresLogin": true`, next to the public pages
   without it. A good video usually has both: what a visitor sees, then what the product does once you are
   in. A report says how it was opened (`viewedAs`); `redirected` tells you when the choice was wrong.
   Without any login, a page behind it shows up as `redirected` or as
   `"problem": {"code": "login_wall"}`: leave that scene out and tell the user at the end, in one
   sentence, that `/pushreel login` adds what is behind the login (it works for Google, GitHub and other
   OAuth logins, magic links and SSO, because the user signs in by hand in a browser window), or
   `PUSHREEL_LOGIN="email:password"` for an app with a password form. If a report says the saved session
   has expired, tell the user to run `/pushreel login` again. Never ask for a password in the chat, never
   write one into a file. Logins with 2FA or a captcha on every visit cannot be recorded.
   In scenes behind the login only look: open, switch tabs, compare. Do not create, change, delete or send
   anything in the user's account unless the user asked for exactly that.
6. Leave out screens that look the same in every app (settings, profile, legal) unless they are the point
   of the product.

## 3. Shot list and post texts: one file, written once

Write `.pushreel/shotlist.json` with the Write tool, complete, including `posts`:

```json
{
  "version": 1,
  "app": { "name": "Tiny Wins", "slug": "tinywins", "address": "tinywins.app", "tagline": "Four habits. One tap each.", "brandColor": "#5b3df5" },
  "viewport": { "width": 360 },
  "targets": ["short", "reel", "tiktok"],
  "cut": { "zoom": 1.4, "removeWaitsOver": 0.6, "captions": true, "endCard": true },
  "prepare": [ { "do": "click", "text": "Reject all" } ],
  "cover": { "scene": 1, "headline": "Four habits, one tap" },
  "scenes": [
    { "id": 1, "title": "Today screen", "url": "/today", "duration": 5, "caption": "Four habits, one tap each.",
      "steps": [ { "do": "hold", "ms": 1200 }, { "do": "click", "selector": "[data-habit=read]" } ] }
  ],
  "posts": { "short": { "title": "", "description": "" }, "reel": { "caption": "" }, "tiktok": { "caption": "" } }
}
```

Rules for scenes

- `steps` kinds: `click`, `hover` (`selector` or `text`), `type` (`selector`, `value`), `press` (`key`), `scroll` (`y` or `selector`), `goto` (`url`), `hold` (`ms`), `wait` (`ms`), `waitFor` (`selector` or `text`).
- `hold` is a pause for the viewer and stays in the video. `wait` and `waitFor` are technical waits; the cut removes waits over 0.6 s, and a retry doubles them. To show an animation, use `hold`.
- Start each scene with a `hold` of about 1 s so the viewer can read the screen before the first action.
- `scroll` is an eased movement, about 1 s per 700 px. A scene that only scrolls needs a `hold` of about 1 s between scrolls.
- `duration` is the length of the scene in the video, 4 to 10 s: the time the steps take (explore-shot reports `stepsSeconds`) plus about 2 s. More than about 2 s of still picture after the last action is trimmed by the cut, by itself. Do not pad scenes.
- `prepare` (optional): steps that run once before the recording and are never in the video. Consent dialogs go here (step 2.4).
- The browser session carries on from scene to scene: cookies and storage stay, so what scene 1 changed is still changed in scene 2. Do not repeat a click that an earlier scene already made. (Visitor scenes and signed-in scenes each have their own session.)
- `caption`: one plain sentence, at most 40 characters, what the viewer sees and why it matters. No hype words, no emoji, no exclamation mark. Pushreel places it; you do not choose a position.
- **A caption adds something the picture does not say.** Never repeat a heading that is on screen in that scene (the page's headline, a card title): the viewer reads it twice. Say what the viewer gets from the screen, or what the action just did ("One link for your whole setup", not the page's own "Zeig, womit du wirfst."). The validator warns when a caption repeats a heading that exploring saw on the page.
- `requiresLogin: true` for scenes behind the login: they are recorded signed in. All other scenes are recorded as a visitor.
- `cover`: choose it on purpose. `scene` is the scene whose opening picture shows the product best at a glance (usually the screen with the most recognisable content, not a form and not a list of text). The cover is that scene's settled page before its first click; `"at": 3.5` picks another second of the scene, `"at": "end"` its last frame. `headline`: at most 4 words, and not the same words as the page's own headline.
- `app.brandColor` is the background of the end card: the app's main colour as `#rrggbb`. `app.address` is the public address from the README, not localhost. `app.slug`: a-z, 0-9 and hyphens.
- A candidate you leave out can stay in the list with `"include": false`.

Post texts (`posts`), written from what you know about the product and the scenes, in the user's voice,
first person where it fits. No invented numbers, no claims the project does not make.

- `posts.short`: `title` (at most 100 characters, may end with `#Shorts`) and `description` (2 to 4 sentences and the address).
- `posts.reel`: `caption`. The first line is the hook. At most 5 hashtags, or none.
- `posts.tiktok`: `caption`. One or two short lines. Links are not clickable there. At most 5 hashtags, or none.

Then run `pushreel validate-shotlist`. Do not continue with errors. Lines that start with `·` are
information and need nothing from you (for example still picture that the cut trims by itself): do not
change the file because of them. Lines that start with an exclamation mark ask for a change:
- a consent dialog without `prepare`: add the `prepare` it prints;
- a caption that repeats a heading on the page: write one that adds something;
- a long caption: shorten it.
If something has to change, write the whole corrected file again with one Write call. Not several Edit
calls, and never `sed` or another shell command: each call is a turn, and shell edits are refused. The last
line says "Nothing to change. Go on." when there is nothing to do.

### Confirm

- With `--yes`: do not ask and do not print the table. Go straight to step 4.
- Otherwise show the scenes as a table (number, scene, route, length, caption), the total length including
  the 2 s end card, the targets, the cover scene, and one line on what you left out and why. Ask "Record it
  like this?" and mention the review screen: the user can run `/pushreel studio` to see the stills, the safe
  areas per platform and to edit scenes at http://localhost:4317. Apply changes the user asks for to
  `.pushreel/shotlist.json`, validate again, and continue once they say yes. If the Studio is open, re-read
  the file before you continue, because the user may have edited it there.

## 4. The pipeline

Run `pushreel run` with a 10 minute timeout (add the URL if the user passed one). It prints each scene, the
cut, the exported files and, at the end, a paste block with the files and the cost table.

## 5. After the pipeline

**Exit code 0, done.** Your answer is, in this order and without embellishment:

1. The paste block, pasted as it is (see "Paste blocks"): the folder, the files, the complete cost table
   with all its rows including the last row "Summary in the chat" and the "Total" row, and the lines under
   it. If the output had no paste block, run `pushreel cost report` and paste that table unchanged.
2. One line: "This answer is not in the table yet. `pushreel cost report` or the Studio shows the final numbers."
3. Three lines: all videos use the same footage and differ in where the caption sits; the texts in `captions.md` are drafts to read before posting; nothing was uploaded.
4. If Pushreel started the app, say that it stopped it again. If you left out scenes behind a login, the sentence from step 2.5.

**Exit code 2, paused.** A scene failed even after two retries with doubled waits, or needs a login, or the saved session has expired. Show the message exactly as printed: it names the scene, what the browser saw, what is saved and the next commands (`/pushreel login`, `/pushreel resume`, `resume --skip <n>`, `cancel`). Do not re-explore and do not try a fix on your own; wait for the user. If the user then asks you to repair a scene (a selector changed), edit only that scene in `.pushreel/shotlist.json`, validate, and run `pushreel resume`.

**Any other exit code.** Show the message and its "Next" lines. If Pushreel started the app in step 1 and the run will not continue, run `pushreel stop-app`.

## Hard rules

- Never upload, post or send the videos or the project anywhere. Pushreel has no upload.
- Never write a password, token or the value of `PUSHREEL_LOGIN` into a file or into the chat. Never open, print or copy `.pushreel/auth.json` or `.pushreel/session.json`: they hold session cookies.
- Do not change the user's source code. You write only inside `.pushreel/`.
- Do not start or kill the user's dev server yourself. `begin`, `run`, `cancel` and `stop-app` do that.
- `.pushreel/` (state, raw footage, the saved login) and `pushreel-out/` (videos) do not belong in Git. If the project has a `.gitignore` without them, suggest adding both lines; do not edit it unasked.
