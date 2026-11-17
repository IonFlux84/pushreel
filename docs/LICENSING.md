# Licensing

One edition, €79 once. Payment and licence keys come from **Dodo Payments** (merchant of record). The
buyer gets a key by email and activates it once per machine. One key is meant for **up to 3 active
machines**:

```
pushreel activate <your-licence-key>          (in Claude Code: /pushreel activate <your-licence-key>)
```

> **Status (0.5.0):** the live and test product ids are set in `config/license.json`. Activation, a second
> activation on the same machine, `licence check`, the limit of 3 machines, moving and deactivating were run
> against Dodo's test mode with a real test purchase. A live purchase, refunds and revoked keys have not been
> tried against the real API yet.

## What the user sees

| Command | What it does | Network |
|---|---|---|
| `pushreel activate <key>` | Activates this machine. Says what is sent before it sends it. | one request |
| `pushreel licence` (or `licence status`) | Shows the stored state: key (masked), date, this machine's label, last confirmation, the re-check sentence. Exit code 3 if not active. | none |
| `pushreel licence check` | Asks Dodo now whether the key and this machine's activation are still valid. | one or two requests |
| `pushreel deactivate` | Frees this machine's place so the key can be used on another machine, then removes the local file. | one request |
| `pushreel deactivate --force` | Removes the local file even if Dodo cannot be reached. The place stays used at Dodo. | tries one request |

Without a valid activation, `run`, `record`, `resume` and `rerender` exit with code 3 and the activation
hint. Nothing is recorded. `validate-shotlist`, `status`, `doctor`, `studio`, `config` and the explore tools
still work; the skill stops before exploring if the licence is missing.

## What is sent, what is stored

**Sent to Dodo Payments at activation, once:** the licence key and a label for this machine. The label is
neutral: `Pushreel on <macOS|Linux|Windows> · <4 hex characters>`, for example `Pushreel on macOS · 3f9a`.
The four characters are random, made once on this machine and kept in the licence file, so the buyer can
tell their machines apart; `pushreel licence` shows the label. **The hostname is never sent**, and neither
is the user name: both can contain a person's name. No email, no project data, no machine fingerprint. The
same request carries a `User-Agent: pushreel/<version>` header. Dodo sees the IP address, as every server
does.

`--name <label>` is an explicit opt-in: it replaces the neutral label with the user's own text, and **that
text is sent to Dodo Payments** and shown in the dashboard. The message printed before the request says
which of the two is sent:

```
Checking the key with Dodo Payments. Sent, once: the licence key and a neutral label for this machine ("Pushreel on macOS · 3f9a"; no hostname, no user name). Nothing else.
Checking the key with Dodo Payments. Sent, once: the licence key and the label you gave with --name ("studio"). Nothing else.
```

**Stored in `~/.pushreel/license.json`** (`PUSHREEL_HOME` moves the folder), never in the project:

```jsonc
{
  "key": "…",                 // the key, in clear: validate and deactivate need it
  "provider": "dodo", "mode": "live",
  "instanceId": "lki_…",      // Dodo's id of this activation
  "licenceKeyId": "lic_…", "productId": "pdt_…",
  "machineName": "Pushreel on macOS · 3f9a",   // the label that was sent (or the --name text)
  "machineTag": "3f9a",       // the four random characters, reused if this machine activates again
  "activatedAt": "…", "lastValidatedAt": "…",
  "machine": "…",             // SHA-256 of hostname and user name, 24 hex characters; never sent, ties the file to this machine
  "seal": "…"                 // detects a copied or edited file
}
```

The activate response from Dodo also contains the buyer's name and email. Pushreel does not store them.

## The promise, stated honestly

The sentence used in every user-facing text (activate output, `pushreel licence`, the "not activated"
message, README):

> **Works offline. At most once every 30 days, when you are online and start a recording, Pushreel
> re-checks the key with Dodo Payments. Offline never blocks.**

`offlineNote()` in `src/license.js` builds it from the configured interval, so the number in the text is
always the number in `config/license.json`. In detail:

1. **Activation** is one request. Without network it fails and says so; nothing is stored.
2. **Every later check is local**: the file must exist, belong to this machine and user, and be unchanged.
3. **Re-check, at most once every 30 days, only when a recording command runs and Dodo answers.** One
   request with the key and the activation id (two if the first answer is "not valid", to tell a revoked
   key from a removed activation). The timeout is 4 seconds.
   - Offline, behind a firewall, Dodo down: the run goes on. Nothing is blocked, ever, for lack of an answer.
     The next attempt is a day later at the earliest.
   - Dodo says the key is no longer valid (refunded, disabled, expired): recording stops with exit code 3
     and a message that says why and what to do. Shot lists, footage and finished videos are untouched.
   - Dodo says the key is fine but this machine's activation is gone: a different message; activating
     again fixes it.
   - A wrong "not valid" can be undone: `pushreel licence check` asks again and restores the licence.
4. **Deactivation** is one request.

A user who is never online while recording is never re-checked. That is the price of the offline promise
and it is accepted: the re-check exists so that a refund ends a normal user's licence, not to stop someone
determined. `dodo.revalidateDays` in `config/license.json` changes the interval; `0` switches the
re-check off, and then the short promise is literally true.

Wording for the product page: the sentence above, after "Your key is checked once when you activate."

There is no telemetry, no update check and no other request anywhere in the code.

## Messages

| Situation | Message (title, then the gist) |
|---|---|
| Unknown key (404) | "This licence key is not known": copy it from the purchase email exactly, case matters |
| Key disabled, refunded, expired at activation (403) | "This licence key is not active any more": write to hello@pushreel.dev with the order number |
| Activation limit reached (422) | Title "No free place on this licence key", then: "This key is already active on 3 machines. Run `pushreel deactivate` on one of them (or `/pushreel deactivate` in Claude Code), then activate again." plus "No access to any of them? Write to hello@pushreel.dev and we free a place." The **3 comes from Dodo's answer** if it carries the limit (`activations_limit`, also looked for as `activation_limit`, `max_activations`, `limit`, at the top level or under `license_key`, `error`, `details`). Dodo's documentation does not describe the 422 body, so this is a guess; without a number the text says "on as many machines as the licence allows". |
| Network down at activation | "The licence provider could not be reached": check connection, VPN or firewall, run again; nothing was stored |
| Dodo error (5xx or anything undocumented) | "The licence key was not accepted": Dodo answered with HTTP n, try again in a few minutes |
| Key of another product or merchant | "This key is for another product"; the activation Dodo just created is given back |
| Same key, already activated here | "already activated with this key. Nothing was sent and no second place was used." |
| Another key already active here | "This machine already has a licence": deactivate first |
| Refund found by the re-check | "This licence key is no longer valid" … "Nothing was recorded" … `pushreel licence check`, new key, hello@pushreel.dev |
| Activation removed elsewhere | "This machine is no longer activated": the key is still good, activate again |
| Deactivate while offline | "The licence was not removed": stays on this machine; go online, or `--force` |

## How it is built

`src/license.js` is the gate and the stored file. `src/providers/dodo.js` is the provider. The provider
interface is at the top of `src/license.js`.

Dodo endpoints used (https://docs.dodopayments.com/features/license-keys and
`/api-reference/licenses/activate-license`, `validate-license`, `deactivate-license`; read 2026-11-17):

| Call | Request | Documented answers |
|---|---|---|
| `POST /licenses/activate` | `{ license_key, name }` | 201 `{ id: "lki_…", license_key_id, product: { product_id }, customer, … }` · 403 inactive · 404 not found · 422 limit reached |
| `POST /licenses/validate` | `{ license_key, license_key_instance_id? }` | 200 `{ valid: boolean }` |
| `POST /licenses/deactivate` | `{ license_key, license_key_instance_id }` | 200 · 403 instance not found for this key · 404 key not found |

Base URLs: `https://live.dodopayments.com` and `https://test.dodopayments.com`.

**No secret in the plugin.** Dodo documents all three as public endpoints that need no API key and are
meant for desktop apps and CLIs. The plugin sends no `Authorization` header (tested).

**The product id is the real check.** Because the endpoints are public, the key of any Dodo merchant
activates successfully. What makes a key a Pushreel key is `product.product_id` in the activate response.
It must be listed in `config/license.json`; otherwise the provider deactivates the instance it just created
and refuses. With no product id configured, activation is refused before anything is sent.

**Key format.** Dodo does not specify one. The API reference shows a UUID
(`2b1f8e2d-c41e-4e8f-b2d3-d9fd61c38f43`); the feature page shows `PRO-AAAA-BBBB-CCCC-DDDD` for keys the
merchant supplies. Pushreel treats the key as opaque: it trims spaces and changes nothing else. Texts say
`<your-licence-key>`.

## Configuration

`config/license.json` (ships with the plugin):

```json
{
  "provider": "dodo",
  "dodo": {
    "mode": "live",
    "productId": { "live": "pdt_…", "test": "pdt_…" },
    "revalidateDays": 30
  }
}
```

| Value | Where | Meaning |
|---|---|---|
| Product id, live | `dodo.productId.live` | `pdt_…` of the Pushreel product in live mode. A string or a list. Set since 0.4.0. |
| Product id, test | `dodo.productId.test` | the same for test mode (test and live products have different ids) |
| Mode | `dodo.mode`, default `live` | which Dodo environment `activate` talks to |
| Mode, per machine | `PUSHREEL_DODO_MODE=test` or `"dodo": { "mode": "test" }` in `~/.pushreel/config.json` | overrides the shipped mode; the environment variable wins |
| Product id, per shell | `PUSHREEL_DODO_PRODUCT_ID=pdt_…` | overrides the shipped id, for the check below |
| Re-check interval | `dodo.revalidateDays` | days, `0` = never |

The mode a key was activated in is stored with it, so a later mode switch does not break a stored licence.

**Machines per key: 3.** The licence is meant for up to 3 active machines (laptop, desktop, one spare).
The number is **not in the plugin and the plugin does not enforce it**: it is the **activation limit** of
the licence key entitlement in the Dodo Payments dashboard, and Dodo refuses the fourth activation.
`pushreel deactivate` frees a place, so nobody who still has the old machine is stranded; for a lost machine
the founder removes the activation in the dashboard. The texts that say "up to 3 machines" (activate
output, `pushreel licence`, README, this page) are plain text: change them together with the dashboard.

## Founder checklist (Dodo dashboard)

- [ ] Product "Pushreel", one-time payment, €79.
- [ ] Licence key entitlement attached to the product: **activation limit = 3**, no expiration, automatic
      fulfilment.
- [ ] Product ids in `config/license.json` (`dodo.productId.live`, `dodo.productId.test`).
- [ ] The 10-minute check below, in test mode, then steps 1, 2 and 4 in live mode.
- [ ] Look at one real "limit reached" answer (step 6) and note whether it carries the number.
- [ ] `scripts/check-release.sh --out <folder>` passes; publish that folder (see "What is shipped").

## The dev provider: tests only, not shipped

`test/support/dev-provider.js` accepts self-made keys (`PR-XXXX-XXXX-XXXX` with a checksum that is in the
file). It exists so the pipeline tests need no network. It is **not part of the shipped plugin**:

- `src/` has one provider, Dodo Payments, in a fixed list (`PROVIDERS` in `src/license.js`). There is no
  `dev-key` command, no `PUSHREEL_DEV` switch and no import whose path is built at run time. `--provider dev`
  and `PUSHREEL_LICENSE_PROVIDER=dev` end in "Unknown licence provider".
- The only door is `enableTestSupport()` in `src/license.js`, a function that nothing in the shipped files
  calls and that no environment variable, option or config value reaches. The test entry
  `test/support/pushreel-test.js` calls it in its own process: it registers the dev provider, adds
  `dev-key`, and lets the Dodo provider talk to the local mock (`PUSHREEL_DODO_BASE_URL`, loopback
  addresses only). The unit tests call it directly; `scripts/e2e/pipeline.sh` runs the test entry.
- Activations made that way are marked test-only and count only inside the test harness: the shipped
  `bin/pushreel` answers "not activated" for them. Tested.
- **This removes the accident and the casual route, not a determined person.** The source is readable by
  design, and the seal on the licence file uses a secret that is in the source. Someone who writes their own
  script around `src/` or edits the code has a working Pushreel. Nothing in a plugin that runs on the
  buyer's machine can prevent that.

## What is shipped

The shipped file set is the `files` list in `package.json` plus `package.json` itself: `.claude-plugin/`,
`bin/`, `config/`, `hooks/`, `skills/`, `src/`, `README.md`, `LICENSE`, `package-lock.json`, five pages of `docs/` and `docs/example-shotlist.json`.
**Not shipped:** `test/` (dev provider, Dodo mock, test entry), `fixtures/`, `sample-output/`, `scripts/`
(with `scripts/e2e/`), `STATUS.md`, `docs/TESTING.md`.

```
scripts/check-release.sh                 stages the set in a temporary folder and checks it
scripts/check-release.sh --out <folder>  the same, and keeps the staged folder for publishing
```

The check fails if `test/`, `fixtures/`, `sample-output/` or `scripts/` are in the set, if any shipped code,
config, hook or skill file mentions `dev-key`, the dev provider, `PUSHREEL_DEV` or `test/support`, if
anything calls `enableTestSupport`, if an import builds its path at run time or leaves the set, or if the
staged CLI accepts `dev-key`, `--provider dev`, another base URL or a self-made dev activation. It makes no
network request.

**Publish the staged folder, not the working folder.** `.claude-plugin/marketplace.json` has
`"source": "./"`, so a marketplace that points at the development repository ships everything in it,
tests included. The `files` list only takes effect through this script (or `npm pack`, which leaves out
`package-lock.json`). The README links only to files in the set; the example shot list ships as
`docs/example-shotlist.json`.

## Tests

- `test/support/dodo-mock.js`: a local HTTP server with the three endpoints, built from the documented
  shapes. It is **not** Dodo. Where the documentation is silent (error bodies, what `validate` answers for an
  unknown key) the mock guesses: unknown key → `200 { valid: false }`.
- `test/dodo.test.js` (21 tests): settings and modes, what is sent (with `--name` and without: the neutral
  label, no hostname, no user name), no API key, stored record, offline checks, idempotent activation,
  deactivate, invalid key, disabled key, limit with and without a number in the answer, foreign product, no
  product id, network down, the 30-day rule, offline re-check, refund, removed activation, forced and
  offline deactivate, tampered file, test-endpoint lock.
- `test/licence-gate.test.js` (8 tests): the same paths through the CLI as a child process (the test entry
  for everything that needs the mock), including the gate in front of `run`, `record`, `resume`, `rerender`,
  three machines and the fourth refused, and the shipped `bin/pushreel` with every old test switch set.
- `test/license.test.js` (6 tests): dev keys, the machine label, no dev provider without the test harness.
- `scripts/check-release.sh`: the shipped file set, see above.

## Not verified against the real API

1. That the three endpoints behave as documented at all, in test and in live mode.
2. The status codes for limit (422), inactive (403), unknown (404), whether 422 is also used for a
   malformed request to `activate`, and **whether the 422 answer names the limit** (the "3" in the message
   depends on it; the mock sends `activations_limit` only where a test asks for it).
3. What `validate` returns for an unknown, disabled, refunded or expired key (the plugin treats
   `200 { valid: false }`, 403 and 404 as "not valid" and everything else as "no answer").
4. Whether `validate` with `license_key_instance_id` returns `false` after that instance was deactivated.
5. Whether a refund in the dashboard disables the key automatically or needs a manual step.
6. Rate limits on the public endpoints.
7. What a real key looks like.

## The 10-minute check with a test-mode product

Do this once in Dodo **test mode**, then repeat steps 1, 2 and 4 in live mode.

1. **Dashboard, test mode.** Create the product "Pushreel", one-time payment, €79. Create a **License
   Key** entitlement: activation limit `3`, no expiration, automatic fulfilment. Attach it to
   the product.
2. **Copy the product id** (`pdt_…`) into `config/license.json` → `dodo.productId.test`. (For this check
   only, `export PUSHREEL_DODO_PRODUCT_ID=pdt_…` does the same.)
3. `export PUSHREEL_DODO_MODE=test`
4. **Buy** the product through its checkout link with Dodo's test card. The key arrives by email and is
   listed in the dashboard under licence keys. Note what it looks like.
5. `pushreel activate <key>` → expect "✓ Pushreel is activated on this machine". The dashboard shows one
   activation named `Pushreel on macOS · xxxx` (not the hostname); `pushreel licence` shows the same label. Then `pushreel licence check` → "The provider confirms".
6. **Limit.** Pretend to be other machines with separate folders:
   `PUSHREEL_HOME=/tmp/pr-b pushreel activate <key>` → ✓, `PUSHREEL_HOME=/tmp/pr-c pushreel activate <key>` → ✓
   (three activations, three different labels in the dashboard).
   `PUSHREEL_HOME=/tmp/pr-d pushreel activate <key>` → expect "No free place on this licence key" and
   "This key is already active on 3 machines." If the text says "as many machines as the licence allows"
   instead, Dodo's answer does not carry the number: note the real answer body and adapt `limitFrom()` in
   `src/providers/dodo.js`.
7. **Deactivate.** `PUSHREEL_HOME=/tmp/pr-b pushreel deactivate` → "freed its place". The dashboard shows two
   activations again, and step 6's fourth command now succeeds.
8. **Wrong key.** `PUSHREEL_HOME=/tmp/pr-d pushreel activate not-a-key` → "This licence key is not known".
9. **Revoked key.** Disable the key in the dashboard (or refund the test order and look whether the key is
   disabled by that). `pushreel licence check` → "no longer valid for this machine"; `pushreel run` exits
   with code 3. Enable the key again → `pushreel licence check` restores it.
10. **Foreign product.** If there is a second test product with licence keys, activate one of its keys →
    "This key is for another product", and the dashboard shows no activation left on that key.

Anything that deviates is a bug in `src/providers/dodo.js` or a gap in Dodo's documentation; the mapping
from status code to message is one short block in that file. Afterwards: create the live product, put its
id into `dodo.productId.live`, leave `dodo.mode` at `live`, and say on the product page what the 30-day
re-check does.

## If Dodo ever closes the public endpoints

The design depends on activate, validate and deactivate needing no API key. If that changes, a secret
must not go into the plugin. The smallest replacement is one serverless function with three routes that
forwards the same three calls with the secret key and returns the same JSON; `BASE` in
`src/providers/dodo.js` then points at it. Nothing else in the plugin changes.
