# Using Pushreel in detail

The [README](../README.md) has the short version. This page has the rest.

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

A complete example shot list: [docs/example-shotlist.json](example-shotlist.json). The format
is described in [docs/ARCHITECTURE.md](ARCHITECTURE.md).

## Styles and templates

```bash
pushreel style init                          # read your running app, write pushreel.style.json
pushreel style set captions.size=68 endCard.cta="Try it free"
pushreel style show                          # every value of the run's style and where it comes from
pushreel run --style neon --template launch  # for this run only
pushreel rerender --style clean              # the same footage in another look, no model
```

`pushreel.style.json` belongs in Git: it is your brand, and every run in the project uses it. Your own styles for
all projects go into `~/.pushreel/styles/<name>.json`, your own templates into `~/.pushreel/templates/`. A new
pointer or scroll speed records the scenes again; every other style change is drawn on the saved footage. All of
it: [docs/STYLES.md](STYLES.md).

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
[docs/LOGIN.md](LOGIN.md).

## What Pushreel writes

| Folder | Content | Safe to delete |
|---|---|---|
| `.pushreel/` | shot list, stills, run state, raw footage, logs, the saved login (`auth.json`, `session.json`: session cookies) | yes, any time. You lose the recorded scenes and the saved login. |
| `pushreel-out/<date>-<app>/` | the finished files. A new run gets a new folder (`…-2`, `…-3`); `rerender` and `resume` write into their run's folder | yes |
| `~/.pushreel/license.json` | the activation: key, activation id, machine name, dates | run `pushreel deactivate` instead of deleting it, so the key's place is freed |
| `~/.pushreel/config.json` | models you chose "don't ask again" for; optional Dodo mode | yes |
| `pushreel.style.json` (project root) | your style, from `style init`, `style set` or the Studio | keep it and commit it |
| `~/.pushreel/styles/`, `~/.pushreel/templates/` | your own styles and templates, if you make any | yes |

Pushreel writes nothing into `~/.claude`. `PUSHREEL_HOME` moves `~/.pushreel` somewhere else.

Add this to your `.gitignore`:

```
.pushreel/
pushreel-out/
```

## Troubleshooting

- `pushreel doctor` (or `/pushreel status`) checks Node, ffmpeg, the browser and the licence and prints a
  fix for each missing piece.
- Every run writes `run.log` into its output folder (and `.pushreel/run/run.log` while it runs); a paused run says how to go on
  with `/pushreel resume`, `/pushreel resume --skip 3,4` or `/pushreel cancel`.
- Licence messages and what to do about each: [docs/LICENSING.md](LICENSING.md), "Messages".
- Logins, saved sessions and consent banners: [docs/LOGIN.md](LOGIN.md).
- Still stuck: write to hello@pushreel.dev with the `run.log`.

