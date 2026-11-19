# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-11-20

### Added

- **Conductor mode — a swarm with a lead that accepts the work.** One conductor plus `swarmAgentCount`
  workers (three by default) share one copy, like Swarm, but the conductor stands above the team. The
  first turn is planning only: the workers propose their shares, the conductor approves or reassigns
  them (`SHARES:`), and nothing is edited until the shares are handed out. While the workers edit in
  parallel, a worker's question reaches the conductor and is answered without the user, and when a
  worker stops the conductor moves its share to another worker.
- **Whole-copy review with checks.** When every worker is idle, the conductor reads the changed files,
  runs the project's checks and compares the copy with the task, then ends with `VERDICT: accept` or
  `VERDICT: rework` plus the optional `REWORK:` list of who must redo their share. A run gets at most
  two rework rounds; a third request is turned into an accept with remarks, and the remarks travel with
  the changes.
- **Accepted work still waits for you.** A conductor run ends `waiting for you` with one combined diff;
  only your **Apply** writes the project. Conductor needs the subagent stack: a profile without it
  refuses the run (`artel/peers-required`) instead of falling back to independent sessions.
- **Conductor in the UI.** The new-run form has a third mode, **Conductor** ("Three agents divide the
  files; the conductor accepts the work"), and the feed labels the conductor's role separately
  (`conductor` in en, «дирижёр» in ru, 指挥 in zh) from the workers' agent label. The run page lists the
  conductor on top of the workers, and messages are refused with «The conductor is deciding» while the
  shares, the review or a handover are in flight.
- `lib/conductor.js` — pure share/verdict parsers, failure classification, change digest and handover
  helpers — with `test/conductor.test.js`; the engine and client tests cover the conductor flow.
- The README, ARCHITECTURE.md, the en/ru/zh guide (a five-act Conductor walkthrough), the publishing
  checklist and the plugin's locale description now cover Conductor; version `0.5.0` in
  `package.json`, `lib/index.js` and the client bundle.

### Changed

- `swarmAgentCount` now also sets the number of Conductor workers; a Conductor run starts
  `1 + swarmAgentCount` agents, and the docs no longer describe the plugin as Solo and Swarm only.

## [0.4.0] — 2026-11-19

### Changed

- **A redesigned surface.** The overlay is now a layered glass sheet on a small token system
  (`--a-accent`, `--a-grad`, `--a-line`, `--a-ease`): 20px corners, layered radial/linear lighting,
  a softer and larger shadow, custom scrollbars and a visible `:focus-visible` ring on every control.
- The rail turned into cards: the new-run control is an accent pill, each run row lifts on hover and
  an active run carries an accent bar on its leading edge.
- The new-run form reads as one composer card: a short «New task» title, the task field on top and a
  footer holding the mode switch, the model and effort pickers (pill-shaped, borderless chips with
  a single chevron) and a gradient primary action.
- The new-run page lost the project/mode eyebrow and the jargon heading: one «New task» title, one
  plus on the create action, one back arrow on the chat button, and one chevron per picker. The
  create action is hidden while the form is already open, and the project name moved into the note
  under the form.
- **Apple-style picker menus.** The model and effort pickers no longer open the native white OS
  popup: each one paints a translucent, blurred panel with provider captions, rounded rows, a
  checkmark on the current value and the arrow/Home/End/Enter/Esc keyboard model. The same menu
  serves the agent route bar and the composer recipient picker.
- The agent route bar is a row of pills with the agent avatar, and the feed gained avatar rings, role
  pills, entrance animation, tool cards with a monospace tool chip, an accent bar on plans and a
  gradient user bubble.
- The launcher glows while a run is live and pulses its dot while one is starting or working; the
  overlay header carries the accent mark.
- The surface clamps itself to the viewport, so a stale or oversized conversation box can no longer
  push the panel past the window edge. Narrow windows keep the rail at a 200px floor, and
  `prefers-reduced-motion` disables the entrance and pulse animations.

## [0.3.0] — 2026-11-19

### Added

- **Provider, model and reasoning effort per agent.** The new-run form now shows a **Model** picker
  (every provider the profile advertises, grouped) and an **Effort** picker for the model's reasoning
  efforts (`Auto` = the adapter default). The whole run starts on that route, and the run refuses a
  route the profile does not advertise (`artel/model-unavailable`).
- A route bar on the run page: each agent has its own model and effort selectors. Changing one row
  reroutes only that agent, from its next step, through `agent.model.select()` — the running step
  keeps the route it started with. The bar is read-only for applied and discarded runs.
- `GET /api/dsh-artel/models` returns the catalog built from `ctx.llm` (providers, models, reasoning
  efforts, the profile default), and `POST /api/dsh-artel/runs/:id/agents/:agentId/model` reroutes one
  live agent. Run summaries now carry each agent's `model`.
- `lib/models.js` (pure helpers: `buildCatalog`, `normalizeSelection`, `validateSelection`, …) with
  its own test file; the catalog is cached for 30 s and refreshed on demand.

### Changed

- A route the Host cannot reach (missing Agent, refusing adapter) does not fail the run: the agent
  stays on the profile default and the feed carries a warning.
- The spawn-based swarm applies the route right after the child Session exists, because the subagent
  spawn provider takes no model options at creation time.

### Fixed

- The catalog asked `ctx.llm.resolveModelInfo()` with a single pair object, but the service takes the
  provider route and the model id as two arguments. Registries rejected the lookup, so every model
  looked effort-free and no effort picker appeared; metadata is now requested per provider/model, and
  an effort's display text is read from `name` (the `ctx.llm` field) as well as `label`.

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
