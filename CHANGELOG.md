# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-19

### Added

- In-chat launcher: an **Artel** button in the chat composer tool row (next to **+**) opens a panel over
  the current conversation. The chat stays mounted underneath, and a dot on the button marks a run in
  progress.
- Panel with a **Sessions** rail: every Artel run of the chat session, grouped by project, with a status
  dot, the mode/counts/phase meta line, the active run highlighted, **+ New Artel** and session
  counters.
- New-run form in the panel: project and mode in the heading, a task field, the Solo/Swarm selector with
  hints, the **Go →** primary button (Ctrl+Enter) and a note that the run works in an isolated copy.
- Run page in the panel: task, mode tag, status pill and phase line, a two-step **Stop** confirmation,
  and a feed of full agent replies (avatar, name, role, time, markdown), grouped tool calls, and
  status, plan, user, peer, collision and error rows.
- Message composer on the run page: "Write to the agents…", a recipient picker (**Everyone** or a
  specific agent) and Ctrl+Enter; a message also wakes a waiting or stopped run.
- **Changes** card on the run page: the run's file list with added/removed line counts, lazy diffs,
  all-files **Apply** and **Discard** with inline confirmations, and applied/discarded/skipped states.
- The panel works on a blank chat session too: the profile's default working directory is used, so a
  run can be started before the first message.

### Changed

- Agents run unattended: Artel sets their approval policy to `never` and inherits the sandbox mode of
  the parent chat session, so a run no longer stalls on an approval prompt.
- **Apply** writes every changed file; the per-file tick list and the "Apply N files" button are gone.
  A conflict with a file changed in the project still rejects the whole apply.
- The run's diff count and status are visible in its header and in the rail while and after the agents
  work.
- After **Apply** the isolated copy is deleted right away, like **Discard** already did; a run whose
  copy is gone reports no changed files.
- The user guide and README now describe the in-chat launcher and the panel instead of the sidebar tab,
  and ship screenshots of the new UI.

### Removed

- The right-sidebar Artel tab and its standalone page. The client half now registers a single launcher
  in the chat composer tool row and renders the panel as an overlay over the conversation.
- Per-file selection in the changes review, the "Open conversation" action and the session-header
  status list.

### Fixed

- `changeCount` is recalculated when a run is interrupted or fails, so the review card and the rail show
  the real number of changed files instead of zero.
- The review card loads the run's changes when the run enters review, so the card no longer depends on
  the Host-reported count to become visible.
- A Swarm planning turn no longer stalls when an agent calls `wait_agent`; the planning prompt tells
  agents to announce their files and end the turn instead.

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

[0.2.0]: https://github.com/ksolodev/dsh-artel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ksolodev/dsh-artel/releases/tag/v0.1.0
