# Styles and templates

Two things keep every run in one project looking and reading the same:

- A **style** is the look: caption type and colours, the end card, the cover, the pointer and the click zoom,
  an optional intro card and an optional corner logo. Fixed code applies it. It costs 0 tokens, and changing it
  never needs the model: `pushreel rerender` draws the new look on the footage you already have.
- A **template** is the story: which scenes the agent has to find (a hook, three features, the price) and the
  rules its captions and post texts must keep. `pushreel validate-shotlist` checks every rule that can be
  measured and refuses the shot list until the agent has fixed it.

Both are included in the licence.

## Quick start

```bash
pushreel style init          # in Claude Code: /pushreel style init
```

reads your running app (main colour, main font, logo) and writes `pushreel.style.json` into the project root.
It prints what it found and where from; correct anything with `pushreel style set`, or in the Studio
(`pushreel studio`, then **Style**). Commit the file: every later run in this project uses it, with no question
from the agent.

```bash
/pushreel --template launch          # in Claude Code: hook, three features, price
/pushreel --style neon               # try a built-in style for this run
pushreel rerender --style clean      # the same video in another look, no model, no new recording
```

## The built-in styles

| Name | Look |
|---|---|
| `bold` (default) | Pushreel's own look: heavy condensed type (Sofia Sans Condensed 800) on an ink box, the stressed word on volt, a hard volt shadow on the cover, the arrow pointer, zoom 1.4. Exactly the look of every version before 0.6.0. |
| `clean` | Quiet and product-like: Sofia Sans 700 on a white pill with a soft shadow, the stressed word in blue, a light end card with a blue address pill, a dot pointer, zoom 1.3, slower scrolling. |
| `neon` | Loud: upper-case Spline Sans Mono on a near-black box with a cyan edge and glow, the stressed word on hot pink, a black end card, a pink-glowing cover, zoom 1.55, faster scrolling. |

`pushreel style list` lists them with your own; `pushreel style show neon` prints every value of one.
Contact sheets of all three on the test app: `field-tests/styles/` in the source folder.

## Where styles live, and which value wins

A run's style is built in layers. Each layer sets only the values it names; a later layer wins.

1. **Built-in** style, shipped in the plugin (`styles/clean.json`, `bold.json`, `neon.json`).
2. **Your library**: `~/.pushreel/styles/<name>.json` (`PUSHREEL_HOME` moves `~/.pushreel`). A file there is a
   style you can use in every project (`--style acme`). It can start from another with `"extends"`. A file with
   the name of a built-in (`bold.json`) is laid over that built-in.
3. **The project file** `pushreel.style.json` in the project root. Meant to be committed.
4. **The shot list**, for one run: `"style": { "captions": { "size": 68 } }`, and the older single values
   `cut.zoom` (→ `motion.zoom`), `cut.endCard` (→ `endCard.enabled`), `"cursor": false` (→ `motion.cursor:
   "none"`) and `cover.scene`.

`app.brandColor` in the shot list still colours the end card, as before. It sits **under** the project file: if
`pushreel.style.json` sets `endCard.background`, the shot list's colour is not used, and the run says so.

Which named style is the base: `--style <name>` on the command, else `"style": "<name>"` in the shot list, else
`"extends"` in the project file, else `bold`. The project file is still laid over the base; to look at a style on
its own, add `--no-project-style`. `--style` on `run` and `rerender` holds for that run only. On `/pushreel` the
choice is remembered for the run in `.pushreel/choice.json`.

Every run writes the result into `run.log` and the summary, for example
`Style: neon (built-in) + pushreel.style.json + the shot list; "neon" chosen by --style`, and
`pushreel style show` prints every value with the layer it came from.

## Example

```json
{
  "$schema": "https://raw.githubusercontent.com/IonFlux84/pushreel/main/docs/style.schema.json",
  "extends": "clean",
  "template": "launch",
  "captions": { "font": "public/fonts/Inter-Bold.woff2", "highlight": "#e8590c", "position": "auto" },
  "endCard": { "background": "#1c1917", "logo": "public/logo.svg", "cta": "Try it free at acme.app" },
  "cover": { "logo": "public/logo.svg", "scene": 2 },
  "motion": { "cursor": "dot", "zoom": 1.5 },
  "watermark": { "enabled": true, "logo": "public/logo.png", "corner": "top-right" },
  "rules": {
    "captions": { "maxWords": 6, "person": "you", "language": "English", "bannedWords": ["simply", "just"] },
    "paths": { "mustShow": ["/pricing"], "neverShow": ["/admin*", "/settings/billing"] },
    "posts": { "hashtags": { "max": 2, "required": ["#buildinpublic"] } }
  }
}
```

The JSON schema is [`docs/style.schema.json`](style.schema.json); editors that read `$schema` complete and check
the keys as you type.

## Every setting

Colours are `#rgb`, `#rrggbb` or `#rrggbbaa` (the last two digits are opacity). Sizes are pixels of the
1080×1920 frame. File paths are relative to the project folder.

### `captions`

| Key | Values | Default (bold) | What it does |
|---|---|---|---|
| `font` | `"Sofia Sans"`, `"Sofia Sans Condensed"`, `"Spline Sans Mono"`, or a `.ttf`/`.otf`/`.woff2` file in the project | `"Sofia Sans Condensed"` | Caption type |
| `weight` | 400 to 900 | 800 | Bundled fonts have Sofia Sans 400 to 800, Condensed 600 to 900, Mono 400 to 700; the nearest is used |
| `size` | 44 to 110 | 74 | Type size. A long caption gets smaller by itself (and to get off the clicked element) |
| `color` | colour | `#ffffff` | Text colour |
| `background` | colour | `#0e0a1f` | Box colour. A see-through box (`#0e0a1f99`) is warned about below 60 % |
| `highlight` | colour or `"none"` | `#d7ff1f` | The stressed word (the longest one of the caption) |
| `highlightText` | colour or `"auto"` | `"auto"` | Text colour of the stressed word in a `box` highlight; `auto` picks black or white |
| `highlightStyle` | `"box"`, `"text"` | `"box"` | The word on a coloured box, or the word in the colour |
| `uppercase` | true, false | false | |
| `position` | `"bottom"`, `"top"`, `"auto"` | `"bottom"` | Where a caption starts. `auto` takes the end with less on it, bottom on a tie |
| `radius` | 0 to 60 | 16 | Corner radius of the box |
| `shadow` | `"none"`, `"soft"`, `"hard"`, `"glow"` | `"none"` | `hard` and `glow` use the highlight (or border) colour |
| `border` | colour or `"none"` | `"none"` | A 4 px edge |

**Position still follows the rules.** Wherever a caption starts, it stays inside the platform's safe area and
moves off the element that is clicked, the page's headings, pictures, fixed bars and the corner logo
(docs/ARCHITECTURE.md, "Cut"). The style only says where it starts.

### `endCard`

| Key | Values | Default | |
|---|---|---|---|
| `enabled` | true, false | true | |
| `background` | colour | `#0e0a1f` (or `app.brandColor`) | |
| `color` | colour or `"auto"` | `"auto"` | Text colour |
| `accent` | colour or `"auto"` | `"auto"` | The address pill; `auto` uses the text colour |
| `font`, `textFont` | as `captions.font` | Condensed, Sofia Sans | The name, and the address and tagline |
| `logo` | `.png`/`.svg` in the project, or null | null | Above the name |
| `text` | up to 40 characters, or null | null = `app.name` | The big line |
| `cta` | up to 60 characters, or null | null = `app.address` | The pill: an address or a call to action |
| `tagline` | true, false | true | Show `app.tagline` |
| `duration` | 1 to 5 seconds | 2 | |

### `cover`

| Key | Values | Default | |
|---|---|---|---|
| `scene` | a scene id, or null | null = the first scene | `cover.scene` in the shot list wins |
| `font` | as `captions.font` | Condensed | |
| `background`, `color` | colour | ink, white | The headline box |
| `accent` | colour | volt | Colour of a `hard` or `glow` shadow |
| `uppercase` | true, false | false | |
| `radius` | 0 to 60 | 24 | |
| `shadow` | `"none"`, `"soft"`, `"hard"`, `"glow"` | `"hard"` | |
| `logo` | `.png`/`.svg` in the project, or null | null | On top of the headline |

### `motion`

| Key | Values | Default | |
|---|---|---|---|
| `zoom` | 1 to 2.5 | 1.4 | Click zoom; 1 = off. `cut.zoom` in the shot list wins |
| `cursor` | `"arrow"`, `"dot"`, `"none"` | `"arrow"` | The drawn pointer |
| `clickColor` | colour | `#ff2a8a` | The ring on every click |
| `scrollSpeed` | 0.5 to 2 | 1 | 2 = twice as fast |

The pointer, the click ring and the scroll speed are in the footage: changing them records the scenes again on
the next `rerender` (fixed code, no model). Everything else is drawn on the saved footage.

### `watermark` (corner logo, off by default)

| Key | Values | Default |
|---|---|---|
| `enabled` | true, false | false |
| `logo` | `.png`/`.svg` in the project | null |
| `corner` | `"top-left"`, `"top-right"`, `"bottom-left"`, `"bottom-right"` | `"top-right"` |
| `size` | 48 to 260 (width) | 120 |
| `opacity` | 0.2 to 1 | 0.9 |

Your own brand in a corner of the platform's safe area, on every scene (not on the cards). Captions keep off it.
Pushreel never adds a mark of its own.

### `intro` (off by default)

| Key | Values | Default |
|---|---|---|
| `enabled` | true, false | false |
| `text` | up to 40 characters, or null | null = the cover headline, else the app name |
| `logo` | `.png`/`.svg` in the project, or null | null |
| `background` | colour | `#0e0a1f` (bold) |
| `color` | colour or `"auto"` | `"auto"` |
| `duration` | 0.8 to 3 seconds | 1.2 |

### Other keys

`extends` (the base style), `template` (the template `/pushreel` uses here when none is passed), `rules` (see
below), and `name`, `description`, `$schema`, which are only read by people and editors.

### What is checked

Every value is checked before a run, with the file and the key in the message (`pushreel.style.json:
"captions.size" is 300. It must be a whole number from 44 to 110.`). An unknown key is a warning, so a typo
shows. A contrast below 4.5:1 between caption text and its box (and the stressed word and its highlight, the
cover headline and its box, card text you set by hand) is a warning: the run goes on, the message says which
value to change.

**Fonts and logos** are read from inside the project only: a path that leads outside it, also through a
symbolic link, is refused. The file must exist, have the right extension and the right content (a `.png` must
be a PNG), and be at most 10 MB (fonts) or 5 MB (logos). You are responsible for having the licence to use a
font file you add; the three bundled fonts are under the SIL Open Font License.

## Templates

| Name | Slots, in order | Rules it brings |
|---|---|---|
| `launch` | `hook` (1) → `feature` (3) → `cta` (1) | captions at most 7 words, "you", no emoji, no hype words; 20 to 45 s, scenes 3 to 9 s; posts plain, at most 3 hashtags, no emoji |
| `feature` | `before` (1 to 2) → `after` (1 to 2) | captions at most 8 words, no emoji; 10 to 30 s, scenes 3 to 10 s |
| `changelog` | `change` (1 to 5) → `cta` (0 to 1) | captions at most 6 words, no emoji; 8 to 40 s, scenes 3 to 8 s |

`pushreel template show launch` prints a template exactly as the agent gets it from `begin`.

**How the agent uses one.** `/pushreel --template launch` (or `"template": "launch"` in `pushreel.style.json`)
makes `begin` print the slots with a short brief each, and the rules. The agent explores screens that fit the
slots, writes `"template": "launch"` into the shot list and `"slot": "hook"` (and so on) on every included scene.

**Your own** go into `~/.pushreel/templates/<name>.json`; one with the name of a built-in replaces it:

```json
{
  "description": "A product tour for the docs.",
  "slots": [
    { "id": "start", "min": 1, "max": 1, "brief": "The empty start screen." },
    { "id": "step", "min": 2, "max": 4, "brief": "One step of the setup per scene, in order." }
  ],
  "rules": { "captions": { "maxWords": 6 } }
}
```

Slot ids are a-z, 0-9 and `-`; `min` 0 to 12, `max` at least 1.

## Rules

Rules come from the template, with the project file's `"rules"` laid over them (a group like `captions` is
merged key by key; lists are replaced). Without a template, the project's rules apply on their own.

| Rule | Checked by validate-shotlist |
|---|---|
| `captions.maxWords` | yes: every included caption and the cover headline |
| `captions.bannedWords` | yes: whole words or phrases, any case; `game-changer` also matches "game changer" |
| `captions.noEmoji` | yes |
| `captions.person` (`"I"`, `"you"`, `"we"`), `captions.language` | no: told to the agent |
| `paths.mustShow` | yes: each path is the address of an included scene. `/admin*` means everything under `/admin` |
| `paths.neverShow` | yes: no included scene and no `goto` step goes there |
| `length.total` `[min, max]` | yes: seconds, intro and end card included |
| `length.scene` `[min, max]` | yes: every included scene's `duration` |
| `posts.hashtags.max`, `.required`, `.banned` | yes, per platform text |
| `posts.bannedWords` (default: the caption list), `posts.noEmoji` | yes |
| `posts.tone`, `posts.language` | no: told to the agent |
| slots of the template | yes: every included scene has a known slot, every slot has its number of scenes, in the template's order |

A broken rule is an error (`Scene 1: the caption "…" has 9 words. The limit (template "launch") is 7. Shorten
it.`): the agent has to fix it before anything is recorded, and `pushreel run` refuses the shot list too.
What cannot be measured is never an error.

## In the Studio

`pushreel studio`, then **Style**: every value of the run's style with where it comes from, a form to change
them, and live previews of a caption (per platform), the end card, the cover and the intro card. The previews
are the renderer's own pages, drawn on a real frame of the last recording. **Save** writes
`pushreel.style.json`; **Save and re-render** also draws the videos again (fixed code, no model). The Studio
stays on 127.0.0.1 and loads nothing from the network; it serves project files only for previews, and only
fonts and logos from inside the project.

## Commands

| Command | |
|---|---|
| `pushreel style init [url] [--force] [--style <base>]` | read the running app and write `pushreel.style.json` |
| `pushreel style list` | built-in styles, your library, the project file |
| `pushreel style show [name] [--json]` | the run's style (or one named style), each value with its source |
| `pushreel style set <key=value> …`, `style unset <key> …` | change the project file; refused values change nothing |
| `pushreel template list`, `template show <name>` | the templates; one as the agent gets it |
| `run`, `rerender`, `validate-shotlist` with `--style <name>`, `--template <name>`, `--no-project-style` | for this command only |
| `/pushreel --style <name> --template <name>` | the whole flow with them |
