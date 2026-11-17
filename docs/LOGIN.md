# Login, consent banners and the browser session

Three things decide what the recording browser sees before the first scene starts: whether it is signed
in, what was dismissed beforehand, and what carries on from scene to scene. All three are fixed code.

The short version: a scene with `"requiresLogin": true` is recorded **signed in**, every other scene **as a
visitor**. `prepare` runs once for each of the two, before the recording. Within each, the browser session
carries on from scene to scene.

## Showing what is behind a login

There are two ways. Pick by how your app signs people in.

| Your app signs in with | Use | What you do |
|---|---|---|
| Google, GitHub, Discord or another OAuth provider, a magic link, SSO, a passkey, or anything else without a password form | **a saved session** | `pushreel login` (in Claude Code: `/pushreel login`), sign in by hand once |
| an email and password form, and you have a test user without 2FA | **a test account** | `export PUSHREEL_LOGIN="email:password"` (or the same line in `.env.local`) |

Both can exist at once. The saved session is loaded first; the test account is used when a page still
answers with a login form.

Either way, mark the scenes: `"requiresLogin": true`. Scenes without it are recorded as a visitor who is
not signed in, also when a login is saved. That is what a landing page or a public profile needs: many apps
send a signed-in user away from their landing page, and a public page looks different to its owner. A
typical video has both kinds of scenes.

### `pushreel login [url]`

```
pushreel login                       # the app Pushreel finds or starts
pushreel login http://localhost:3000 # an app you started yourself
```

1. A **visible** browser window opens on your app.
2. You sign in there the way you always do. Pushreel does not see or store what you type.
3. Press Enter in the terminal, or close the window. (In Claude Code there is no terminal to press Enter
   in: close the window.)
4. Pushreel saves the cookies and the local storage of that window to `.pushreel/auth.json` and prints:

```
✓ Session saved to .pushreel/auth.json (3 cookies for localhost).
  Explore and record runs load it from now on: scenes behind the login open signed in.
  The file contains session cookies. Anyone who has it is signed in as this user: do not commit it, do not share it.
  ! Add this line to .gitignore before you commit:  .pushreel/
  Remove it with: pushreel logout   (in Claude Code: /pushreel logout)
  The first cookie runs out on 2026-12-01. When the app signs you out, Pushreel says "Your saved session has expired" and you run the login again.
```

You can close the window right after the app has signed you in: the cookies are read after every page load
in the window, not only every 0.7 s, and once more when the window closes.

Tested for real in a visible window (`scripts/e2e/login-window.mjs`, 0.4.0): headed Chromium on the
fixture's OAuth-style login, the sign-in clicked in that window, then each way to finish (Enter in a
terminal, closing the window at once, and the shipped CLI in a real pseudo terminal with Enter). Each time
`.pushreel/auth.json` held the app's session cookie and a page behind the login opened signed in from it.
Not tested: a person clicking the window's close button (the test closes the window's only tab, which is
what the button does to a one-tab window), Linux and Windows, and `/pushreel login` typed in Claude Code.

The `.gitignore` line is printed only when `.pushreel/` is not ignored yet (`.gitignore` and
`.git/info/exclude` are both read). Pushreel never edits `.gitignore` itself.

If no app is running, `pushreel login` starts it with the project's own command and leaves it running: an
app that keeps its sessions in memory would forget the login if it were stopped. The next run uses the app
and stops it at the end; `pushreel stop-app` stops it right away.

Use a test user, not your own account, if the app shows private data: what the signed-in user sees is what
the video shows.

### What it cannot do

- **2FA or a captcha on every visit.** The session is saved after you passed them once. If the app asks
  again in every new browser, the recording stops at that step and says so.
- **Sessions bound to the browser or the IP** in a way a copied cookie does not satisfy. Rare for local
  development.
- **Another address.** Cookies belong to one host. A session saved for `http://localhost:3000` is not sent
  to `http://127.0.0.1:3000`. Pushreel says so when the addresses differ; run `pushreel login` with the
  address you record.

### When the session runs out

Sessions end: the cookie expires, the app restarts and forgets its sessions, or you signed out. A scene
with `"requiresLogin": true` then lands on a login page or is sent away from its address, and the run
pauses:

```
✗ Scene 3: your saved session has expired

Your saved session has expired. Run /pushreel login again. (/settings sent the browser to /welcome, although .pushreel/auth.json holds a saved login.)

Next:
  pushreel login   (in Claude Code: /pushreel login), then: pushreel resume
  pushreel resume --skip 3   (export without this scene)
  pushreel logout   (removes the saved session)
  pushreel cancel
```

Nothing is retried (waiting does not bring a session back), recorded scenes are kept, and `pushreel resume`
goes on after the new login.

How Pushreel tells: the scene is marked `requiresLogin`, a saved session exists, and the app answered with
a login-looking page or with a redirect that leaves the asked page (`/entdecken` → `/`; a redirect deeper
into the same page, `/app` → `/app/home`, does not count).

A scene behind the login that is **not** marked `requiresLogin` is opened as a visitor. If the app answers
with a login form, the run pauses and says: "The scene is recorded as a visitor, because it is not marked
as being behind the login … add "requiresLogin": true". If the app quietly sends the visitor to another
page, the scene is recorded as the app shows it, with a warning line in the output.

### Without any login

A scene with `requiresLogin` and neither a saved session nor a test account stops as a login wall, and the
message offers both ways:

```
✗ Scene 3 stopped at a login page

/settings redirected to /welcome, and Pushreel has no way to sign in yet. There are two:
- Sign in once by hand (works for every app, also Google, GitHub and other OAuth logins, magic links, SSO): "pushreel login" opens a browser window, you sign in, Pushreel keeps the session in .pushreel/auth.json.
- A test account with a password form: set PUSHREEL_LOGIN="email:password" (a test user without 2FA) and Pushreel fills the form.
```

### `pushreel logout`

Removes `.pushreel/auth.json`, `.pushreel/session.json` and the explore session. It does not sign the user
out in the app: the session there stays valid until it expires. Deleting the files by hand does the same.

### `pushreel login --script <steps.json>`: for CI and tests

Where nobody can sign in by hand, the same file can be produced from login steps, headlessly:

```json
{
  "url": "/welcome?next=/settings",
  "steps": [
    { "do": "click", "selector": "#demo-signin" },
    { "do": "click", "selector": "#provider-continue" },
    { "do": "waitFor", "text": "Your habits" }
  ],
  "expect": "/settings"
}
```

- `steps` use the vocabulary of scenes (`click`, `type`, `press`, `waitFor`, …). A plain list of steps works
  too; it then starts at `/`.
- `expect` (optional) is a page behind the login. After the steps it must open without sending the browser
  away; otherwise nothing is saved and the command fails with a screenshot in `.pushreel/run/failed/login.png`.
- One step exists only here: `{ "do": "post", "url": "/auth/dev", "form": { "key": "…" } }` sends a form
  from inside the page, same origin, with the page's CSRF token (`meta[name=csrf-token]` or the
  `XSRF-TOKEN` cookie). It is for local development logins that have a route and no button. Shot lists do
  not know this step.
- Do not put a real password into the script. This is meant for throwaway test users and local dev logins.
  For a real OAuth provider there is nothing to script: sign in by hand.

The fixture app shows it: `fixtures/tinywins/login-demo.json` clicks "Sign in with Demo", passes a fake
provider page and comes back signed in, with no password form anywhere (`TW_AUTH=oauth`).

## Consent banners and other setup: `prepare`

A cookie or consent dialog, a newsletter popup, a theme switch: things that have to happen once, and that
nobody wants to watch. They go into `prepare` in the shot list:

```json
"prepare": [
  { "do": "click", "text": "Reject all" }
]
```

- Same step vocabulary as scenes. A list starts at `/`; `{ "url": "/welcome", "steps": [ … ] }` starts
  elsewhere.
- It runs **before the recording starts** and is **never in the video**. It runs once per lane (see below):
  once as a visitor, and once signed in if the shot list has scenes behind the login.
- A step whose element is not on the page is skipped, with a line in the log (the banner may already be
  gone). Anything else that goes wrong (the app is down, an error page) pauses the run like a failed scene.
- Changing `prepare` records all scenes again: what it does can change every picture.

**Which button.** While exploring, `pushreel explore-shot` looks for consent dialogs (buttons with labels
like "Reject all", "Necessary only", "Ablehnen", "Nur notwendige", "Accept all", "Akzeptieren" inside a
container that talks about cookies, consent or tracking and sits on top of the page). It reports the
dialog, clicks it away so the stills show the app, and returns the step for `prepare`. The default is the
option that hides the banner with the **least tracking**: reject or "necessary only". Only when there is no
such button does it take accept. If you want accept (to show the app with its analytics-dependent parts),
say so: the agent then explores with `--consent accept`. You can always write the step yourself.

`pushreel validate-shotlist` reminds you when exploring found a dialog and the shot list has no `prepare`.

## One browser session for the run, per kind of scene

Scenes are no longer recorded in a fresh browser each. There are two sessions ("lanes"), each **one browser
context for the whole run**:

| Lane | Scenes | Starts from |
|---|---|---|
| signed in | `"requiresLogin": true` | the saved login (`auth.json`), or empty when `PUSHREEL_LOGIN` signs in |
| visitor | all others | an empty browser |

Within a lane, cookies and storage carry on from scene to scene: a banner dismissed in `prepare` stays
dismissed, a login made once holds for every scene, and what scene 1 changed in the app's local storage is
still changed in scene 2. The two lanes do not share anything, like two people.

The state lives in `.pushreel/session.json`, one entry per lane:

1. A lane is opened when its first scene comes up.
2. `prepare` runs in it (so a consent banner is dismissed once as a visitor and once signed in). The result
   is saved.
3. After every recorded scene of the lane it is saved again.

A retry starts from the state saved after the scene before it, so a half-finished attempt leaves nothing
behind in the browser (the app's server may still remember what the attempt did). `pushreel resume` and a
single re-recorded scene (`rerender` after its steps changed) load the file instead of running `prepare`
or the login again. A new login, other `prepare` steps or another app address make the file invalid, and
it is rebuilt at the start of the next run.

What does not carry on: `sessionStorage` (it belongs to a tab, and every scene is a new tab), and anything
the server keeps per session if the app restarts between runs.

## The files

| File | Written by | Holds | Commit it? |
|---|---|---|---|
| `.pushreel/auth.json` | `pushreel login` | cookies and local storage of the browser you signed in with | **never** |
| `.pushreel/session.json` | every run | the same, plus what `prepare` and the scenes changed | **never** |
| `.pushreel/explore-session.json` | `pushreel explore-shot` | the same, for exploring | **never** |
| `.pushreel/consent.json` | `pushreel explore-shot` | the consent button it found (label and step), no cookies | no need |

Add `.pushreel/` to `.gitignore`. Pushreel sends these files nowhere, and the agent is told never to open
or print them.
