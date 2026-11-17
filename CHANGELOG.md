# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-17

First public release.

### Added

- **Solo** mode: one coding agent runs the task in its own copy of the project, end to end.
- **Swarm** mode: three agents share one copy and one agent tree. They open with a planning turn
  that divides the files, then work in parallel, read each other's edits, and message each other
  with the standard `send_message` / `list_agents` tools. Peer messages appear in the shared feed.
- Live run feed: agent messages, tool calls, status changes, ownership plans and collision notices.
  You can write to a running agent without stopping it, and interrupt the run at any time.
- Per-file diff review with added/removed line counts and a line-by-line unified diff.
- Manual **Apply**: only the files you tick are copied into your project. A file you edited during
  the run is reported and never overwritten.
- **Discard** removes the copy; nothing reaches the project.
- The run copy lives outside the project under `<DSH home>/artel/<profile>/copies` and is swept
  after `keepCopiesHours` (72 by default).
- Locales: English, Russian, Chinese.
- Loopback-only HTTP API under `/api/dsh-artel/*`, fenced by local socket, local `Host` header and
  a same-origin `Origin` check.
- First start moves the data root of the pre-rename `dsh-forge` build to the new `artel` directory,
  so existing run records, feeds and copies keep working.

### Notes

- The plugin was renamed from `dsh-forge` (the npm name `dsh-forge` belongs to an unrelated
  placeholder package). The tab id changed as well, so an already open Forge tab does not restore —
  open the **Artel** tab once after the restart.
- Requires DSH `^0.2.2-rc.1` and Node `^22.19.0 || >=24`.
- No build step: the host half is plain ESM and the client half is hand-written
  `React.createElement`.

[0.1.0]: https://github.com/ksolodev/dsh-artel/releases/tag/v0.1.0
