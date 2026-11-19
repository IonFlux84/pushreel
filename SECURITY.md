# Security

## Reporting a problem

Please write to [hello@pushreel.dev](mailto:hello@pushreel.dev) with "Security" in the subject. Say which
version you use (`pushreel version`), what you found and how to reproduce it. Please do not open a public
issue for a security problem. You get an answer within a few days, and a fix is released as a new version of
the plugin: `claude plugin update pushreel@pushreel` (see "Updates" in the README).

Pushreel runs on your machine only. It has no server of its own, sends nothing to its maker, and talks to the
internet only for the licence (Dodo Payments) and, when you agree, the one-time Chromium download. The README
section "Data, network and privacy" lists every request, process and file.

## Fixed in 0.6.1

A review of 0.6.0 (19 November 2026) found four problems and a few places to harden. All are fixed in 0.6.1,
each with regression tests.

| Finding | Severity | Fixed in 0.6.1 |
|---|---|---|
| A planted `.pushreel/app.json` or `run.json` (for example committed to a cloned repository) could make Pushreel signal processes it did not start (pid 1 or -1: every process of the user), delete a file outside the project (`hotFile`) or write outside `pushreel-out/` (`outDir`) | Medium | Only whole pids above 1 that are not Pushreel itself; a pid is signalled only when its process start time matches the one Pushreel stored when it started it; no fallback to another signal target; the Vite hot file only at `<project>/public/hot`; output folders only inside `<project>/pushreel-out/` (symbolic links resolved) |
| The test account from `PUSHREEL_LOGIN` could be typed into a page on another host | Medium | Email and password are typed only into pages on the app's own origin; the shot list validator refuses an absolute `login.url` on another origin |
| Text on a recorded page could steer the agent, with pre-approved tools for any file and any URL | Medium | The skill pre-approves only `pushreel`, reading inside the project and writing inside `.pushreel/`; every address is pinned to the app on this machine, other hosts need `--allow-remote` typed by the user; page text is marked as data in the explore report, and the skill treats it so |
| Saved login, sessions and the licence were readable by other local users | Low | Written with mode 0600, `.pushreel/` and `~/.pushreel/` with 0700, also for files written before |

Also hardened: the Studio takes changes only from its own exact origin and port; the TLS check of the
"is the app up?" request is relaxed only for hosts on this machine; the SVG logo that `style init` copies from
a page is cleaned of scripts, event handlers, `foreignObject` and outside references; HTML escaping covers `'`
and file paths in CSS are escaped.

What you notice: an address that is not on this machine now needs `--allow-remote`; a login page on another
host (Google, GitHub, SSO) is no longer filled with `PUSHREEL_LOGIN` (use `pushreel login`); an app started by
Pushreel 0.6.0 and still running when you update is not stopped by 0.6.1 (its `app.json` has no start time):
stop it yourself once.
