# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.1] — 2026-11-21

### Added

- **The panel lists every chat of the project that owns Artel runs (issue #11).** Above the run groups
  the rail now has a **«Чаты проекта»** block: one row per chat of the current project with Artel tasks,
  carrying the chat title, its last run status, when it last moved and how many tasks it holds. A click
  switches DSH to that chat with the workspace's `openSession`, and the panel stays open, bound to that
  chat's latest run — its rail, composer, changes card and Apply/Diff actions are the chosen chat's.
- **Sidebar badges mark the chats that own Artel tasks (issue #11).** A new
  `sidebar.session.row.trailing` entry renders a compact Artel badge with the task count on every chat
  that has runs, with the tooltip «N задач Артели · последний статус». Chats without tasks are
  untouched, and the badge needs neither the panel to be open nor the chat to be current.
- `GET /api/dsh-artel/chats` returns one record per chat with runs — `sessionId`, `title`, `lastTask`,
  `projectPath`, `projectKey`, `runCount`, `lastRunId`, `status`, `mode`, `updatedAt` — grouped in the
  engine by `sessionId`, newest run first. `projectKey` is the real path of the project
  (`fs.realpath`, lowercased on Windows), so the same project reached through another spelling or a
  junction keeps its chats together; `GET /project` returns the same key.
- The run record and `RunSummary` carry `chatTitle` — the title the host gave the task chat at
  creation — so the chat list keeps a readable name before the live session snapshot is loaded.

### Changed

- The rail's empty state now waits for both the chat list and the run list, so a project chat with
  runs no longer looks like an empty panel for a moment.
- Switching to another project chat from the rail reuses the per-chat store: the target chat opens
  with its latest run selected, and the panel closes again if DSH cannot perform the switch (for
  example, no workspace service).
- Locales ru/en/zh gained the chat-block and badge strings; the Russian count follows the 1/2–4/5+
  rule.

### Fixed

- Chats of one project no longer split into two groups when the project is reached by different paths.

## [0.11.0] — 2026-11-21

### Added

- **Every run gets its own chat in the project (issue #10).** Starting a task from the Artel panel no
  longer attaches the run to whatever chat happens to be open: the host creates a dedicated chat titled
  `Artel · <task>` in the project's workspace (`sessionController.create({ workspaceId })`), pins it
  read-only, binds the run to it and switches the client to it with the workspace's `openSession`. The
  source chat keeps no run and no panel — an unrelated chat is never hijacked again. The new chat is
  marked as started with an empty finished turn, so its title is visible in the sidebar at once and the
  client cannot reuse it as the project's next New Session draft; `newChat: false` on `POST /runs` keeps
  the old behavior for callers that already own a chat.
- **Every agent chat is filed under the project in the sidebar (issue #10).** Agents still work only in
  the isolated copy — the sandbox boundary does not move — but Artel now adds their sessions to the
  project's workspace record (`Workspace.host.rememberSessionPath` + `Workspace.mutate`). The sidebar
  keeps one project group with the task chat and all agents (Solo, Swarm, Conductor, Fusion, and the
  Orchestrator planner, parts, reviewer and merger) instead of showing the copy folders as separate
  projects. `engine.restoreProjectChats()` re-files these chats at every DSH start, so a restart keeps
  the grouping; old runs are not migrated.
- **Open the agent conversation from the run page.** The route bar under the header and the **Right now**
  strip now carry a chat button next to every agent: it switches to that agent's chat
  (`run.openSession`, defined since 0.8 but unused until now).
- `lib/project-chats.js` — the host half of this: workspace lookup by real path, task-chat creation,
  membership injection and the restart re-filing, all feature-detected (`HostDriver.supportsProjectChats()`);
  a profile without a workspace registry keeps the previous grouping.

### Changed

- The Artel panel still opens from any chat, but the run page now lives in the run's task chat: the rail
  in the source chat stays empty, the rail in the task chat lists the run.
- The run record gains `taskChat`, `taskChatWorkspaceId`, `projectChats` and `originSessionId`; `run.sessionId`
  now names the task chat. `POST /api/dsh-artel/runs` gained `newChat` (default `true`).
- `maxRunsPerSession` is counted by `originSessionId` — the chat the task was started from — so a task chat
  cannot lift the per-chat run cap into a no-op.
- Queue runs keep the chat that owns the queue and Factory runs stay chatless, so background work does
  not spawn chats.

### Fixed

- A run started from the panel no longer shows up in an unrelated chat, and copy directories no longer
  appear as separate sidebar projects (issue #10).

## [0.10.0] — 2026-11-21

### Added

- **Every block of the run page can be folded, hidden and resized (issue #8).** The plan card, agent
  replies, grouped tool calls, the parts card, the changes card and the queue strip follow one block
  contract: the header is a button, it folds the block to a single line («ПЛАН · 24 строки»,
  «Олег · 6 строк», «Инструментов: 4»), and the folded state is remembered per chat session in
  `localStorage` (`dsh-artel:blocks:<sessionId>`), so it survives a re-render and a page reload.
- **A block toolbar above the feed.** Chips hide or bring back each kind of block (План / Агенты /
  Инструменты / Части / Изменения / Очередь), **Компактно** folds every block at once, and
  **Свернуть все** / **Развернуть все** do the same in one click; the choice is remembered per session.
- **Long blocks stay inside their own frame.** The plan text, agent replies, tool output, the parts
  card, the changes card and the queue strip are clamped to a comfortable max-height (40vh / 36vh / 32vh
  by kind, or the height you dragged), scroll inside it, and offer **Показать целиком** / **Свернуть**
  when the content runs past the frame.
- **Drag the bottom edge of any block,** and the handle above the composer, to size the feed and the
  write field IDE-panel style; the dragged heights are remembered together with the folds.
- The plan card no longer floats over the feed: the parts card, the changes card and the queue strip
  live in the same scroll region as the feed (`.dsh-artel-run__below`), and the composer is pinned
  outside it after a draggable split, so no block can be painted over another.

### Fixed

- **The plan card no longer covers the feed and the composer no longer covers the queue (issue #8).**
  In 0.9.1 the run column was one scroll region, but every non-feed block still rendered at full
  height: a 24-line plan took half the pane, the parts card pushed the changes card out of view, and
  the queue strip was clipped to its first line. With folding, clamping and the block toolbar the feed
  keeps a usable viewport at any panel height, while the auto-queue results card (issue #7) still
  scrolls itself into view when a shift finishes.

## [0.9.1] — 2026-11-21

### Fixed

- **The auto-queue results card can no longer slide under the composer (issue #7).** Parts, changes and the
  queue strip were direct flex children of the run column: under vertical pressure they shrank to zero
  height while still painting their content outside themselves, so the green «Итоги автоочереди» card
  ended up under the composer and past the panel bottom, and the only scroll region wrapped the feed, so
  nothing could scroll it into view. The below-feed stack now lives inside the run column's scroll region
  (`.dsh-artel-run__below`), the queue strip refuses to shrink (`flex: none`), the agent route and live
  strips stay fixed above it, and the composer stays pinned below — so a short panel scrolls through the
  parts, changes and results instead of hiding them.
- **The results card collapses into its title row.** «Итоги автоочереди» is now a toggle with the entry
  count; collapsing hides the rows and keeps the card at a 46px title, so a finished night shift does not
  take half of a short panel.
- **When a shift finishes the results card scrolls itself into view,** and the feed keeps auto-following
  new messages only while its tail is actually on screen, so the two no longer fight over the bottom.
- **The launch screen scrolls instead of clipping.** The hero was a centred flex column with no overflow:
  a tall queue strip pushed the title above the panel top and the queue below the panel bottom. It now
  scrolls, while auto margins keep the short layout centred.

## [0.9.0] — 2026-11-21

### Added

- **The applied project can now be installed into DSH — explicitly, from the changes card (issue #9).**
  Apply only writes files, by design, so a project that is a DSH bundle or ships its own installer used to
  end its run with no next step: the generated MCP bundle whose `install/install.py` materialises
  `~/.pybrowser/runtime` was "applied", and DSH still knew nothing about it. `apply()` now detects what
  the project needs (`detectInstallNeeds` in `lib/install.js`) and stores a read-only record on the run:
  a bundle (`package.json` `dsh.bundle.patch`, or a root `cordis.patch.yml`) and install steps
  (`artel.install.json`, or a conventional `install/install.py`, `scripts/install.mjs`, …). The changes
  card keeps an **Install** block open under the applied plate. **Install into DSH** calls the Host
  plugin manager's `installBundle` with the project folder — a local `link:` dependency in the active
  profile — and reports installed, restart required, overridden, already installed or failed; each
  declared step gets its own row and a **Run** button that runs that one command in the project folder
  with a five-minute limit, then shows the exit code and the captured output. Nothing installs and no
  command runs without a click.
- **The plan knows install is not a part.** The Orchestrator planner prompt now says installing happens
  after Apply with the exact command, so a run no longer schedules an install part it cannot execute; the
  worker prompts say the same and point at `artel.install.json` and the README instead of trying to write
  the profile or run an installer (their sessions keep approval policy `never`).
- **Routes:** `GET /api/dsh-artel/runs/:id/install` (the record, `?refresh=1` re-reads the project),
  `POST /api/dsh-artel/runs/:id/install/bundle`, `POST /api/dsh-artel/runs/:id/install/steps/:index`.
  All three require an applied run and take a per-run lock.
- **A profile without the plugin manager degrades to manual steps.** The card shows the project folder to
  add by hand (DSH → Plugins → Add plugin) and the bundle route answers `501 artel/install-unsupported`.

### Changed

- `RunSummary` carries `install` (the detected record, or `null`). The changes card checks for it once on
  a run that was applied before this version, so an old bundle project offers the install button without
  a second Apply.

## [0.8.3] — 2026-11-21

### Fixed

- **The auto-queue picker now explains the missing Orchestrator.** The «Автоочередь» mode picker lists
  **Оркестратор** after Solo, Swarm, Conductor and Fusion, disabled and with a one-line reason: a queued
  task starts from the last saved version, and the Orchestrator cannot start from a saved version yet. The
  keyboard model and clicks skip the disabled entry, so it cannot be chosen by accident (issue #3).
- **A queue request with an unsupported mode is refused instead of silently becoming Solo.** `POST
  /api/dsh-artel/queue` with `mode: "orchestrator"` answers `400 queue/mode-unsupported` with that
  explanation, and an unknown mode answers `400 queue/mode-unknown` listing the four modes a task may use;
  previously `createTaskRecord` quietly replaced any other mode with `solo`.

## [0.8.2] — 2026-11-21

### Fixed

- **The composer row no longer reads as two loading indicators.** The launcher was a bare 15px 8-ray
  mark — the exact shape of a spinner — so when the host painted its own loading ring (`StateDot`) in the
  same composer row, the pair looked like a duplicated, broken indicator (issue #2). The launcher is now a
  labelled brand chip: the violet Artel surface, the mark and the name «Артель», collapsing to the mark
  alone in a row narrower than 460px. The busy state moved from the old bottom-corner dot to a 7px corner
  badge, and no `.dsh-artel-spin` is ever attached to the launcher, so Artel paints no loader in that row
  and the host's ring stays the only one there.

## [0.8.1] — 2026-11-20

### Fixed

- **The GitHub issue import now explains itself.** The row under «Входящие» is titled **Из GitHub issue**,
  carries a hint for all three accepted forms (`#12` — the board project's own repository, `owner/repo#12`
  and an issue link — any repository) and names the `gh` requirement instead of leaving an unlabeled field
  and button. The input is labelled for screen readers and Enter imports.
- **A failed import says why instead of doing nothing.** `readGitHubIssue` in `lib/trackers.js` classifies a
  failed `gh issue view` — CLI missing, not signed in, repository missing, issue missing, unreadable output
  or anything else — and the route answers with a stable code (`factory/gh-missing`, `factory/gh-auth`,
  `factory/repo-not-found`, `factory/issue-not-found`, `factory/issue-unreadable`,
  `factory/issue-unavailable`); the board renders the reason inline under the field in the current locale.
- **The Host error message is no longer lost.** The client read `{ error }` of an error response as the
  *code*, so every failed request showed only `HTTP 400`; it now reads `{ error, code }` as written by
  `writeError` and keeps the old shape as a fallback.
- `dismissError` clears the factory error banners too, so the factory banner's close button works.

## [0.8.0] — 2026-11-20

### Added

- **Автоочередь — an unattended night shift for a chat session.** A chat session can stack tasks in its
  queue and run them one after another while the «Автоочередь» toggle is on. Each finished task is saved as
  its own version (the project's check command decides whether it is a version), and the next task starts
  from the last successful version: the copy is seeded from that version's path through `basePath`, while
  the diff base stays the real project. Tasks stay ordinary Artel runs with their own mode and model —
  `QUEUE_MODES` accepts `solo`, `swarm`, `conductor` and `fusion`, and the orchestrator is not a queue mode.
- **Night-shift rules inside every turn.** An unattended run gets the night-shift suffix appended to every
  turn: nobody will answer, so the agent must not ask or wait, must write the smallest reasonable
  assumption down and continue; never send anything outward (no push, pull/merge request, publish, deploy,
  tracker comment or message outside the machine), never raise a preview and never start a long-running dev
  server, stay inside its copy and finish with a short summary. The first question of a task is
  auto-answered («решай сам и запиши допущение»), the second parks the task.
- **A finished task must pass the check.** With a queue running, the runner suggests the project's own check
  command from its manifests (`suggestCheckCommand`, overtaken by the configured command) and runs it after
  the agent's turn; a failed check sends the bounded output back to the same worker as a repair turn, at
  most twice (`checkRepairPrompt`). The change set is scanned for secrets and junk (`scanHygiene`) and the
  agent's text for an attempt to publish outward (`scanOutward`); either finding parks the task instead of
  saving a version.
- **«Отложенное» and how the queue ends.** A task that fails — the check still failing after two fixes, a
  secret or junk in its diff, an attempt to publish outward, or a `BLOCKED:` report — is parked under a
  `vf/parked-…` label and listed in «Отложенное»; the queue continues with the next task, and a parked task
  can be retried from its own partial copy. A subscription limit only pauses the queue with `retryAt`
  (`classifyFailure`); a lost login ends it. «Стоп» interrupts the agent and parks the partial work,
  «Закончить после текущей» lets the current task finish, and switching the toggle off stops taking new
  tasks. The queue also ends itself when it is empty, after the task limit, after three parks in a row, when
  the login is lost, or when the disk is low (`freeDiskBytes`, at least 500 MB free). The run produces an
  «Итоги автоочереди» result card with the saved versions and their checks, the parked tasks and the reason
  the queue stopped.
- **Фабрика — a per-project ticket pipeline maintained by agents.** A board per project carries tickets
  through Входящие → Разбор → Работа → Тесты → Проверка → Ревью → Готово к PR → Готово, with «Ждёт вас» as
  the human lane. The stage graph is explicit (`STAGE_TRANSITIONS`); triage is a read-only agent that
  answers with `SPEC:`/`CRITERIA:`/`ROUTE:`/`ASSUMPTION:`/`QUESTION:` markers, takes the cheapest sufficient
  route out of the allowed ones (`solo`/`swarm`/`fusion`/`orchestrator`) and may ask a `QUESTION:` that
  sends the ticket to «Ждёт вас». Work, tests and the app check are ordinary Artel runs started in the
  background; the factory may only cheapen the route, never upgrade it.
- **Repair loop and «Ждёт вас».** A failed review, a failed test command or a failing app check goes back to
  «Работа» as a repair turn with the findings, up to the template's repair rounds; when the rounds are
  exhausted the ticket waits in «Ждёт вас» with the findings. The same lane collects triage questions, an
  orchestrator plan waiting for approval (`approvePlan` starts the parts), an interrupted ticket, a run that
  had nothing to do, and tickets postponed by hand. Every failure is recorded as a board and ticket event,
  and the pump never dies on a ticket.
- **Templates.** «Обычный» — two repair rounds, the app check and one reviewer; «Быстрый» — one round, no
  app check; «Строгий» — three rounds, the app check and two reviewers. A board starts with the template's
  `repairRounds`, `appCheck` and `reviewers`; the app check runs only for UI tickets (`ticketIsUi`) and only
  when the template wants it, a preview command and Playwright are configured.
- **Readiness check before a board is enabled.** A board can only be switched on when the project is a git
  repository, has a first commit (the factory diffs against it) and at least one engine is logged in — these
  three block; a test command (or a suggested one), a preview command and Playwright are reported but do not
  block. `checkReadiness` probes the real project, and enabling without a passing report is refused.
- **Tickets come from wherever they are written.** The «Входящие» field takes a title, text and up to eight
  attachments; a GitHub issue arrives as `#12`, `owner/repo#12` or its URL through `gh issue view` and is
  imported never twice (deduplicated by `sourceKey`); GitHub, GitLab, Jira and Linear are polled every five
  minutes (`TRACKER_KINDS`, config per kind, a board's tracker list) with optional comment back; every board
  belongs to one project.
- **PR flow, merge and takeover.** A ticket in «Готово к PR» offers **Pull Request** — which requires a clean
  working tree and a remote, creates `factory/ticket-<number>`, applies the ticket's run to the real project,
  commits, pushes and calls `gh pr create --body <prBody>`, then comments the link back when the tracker asks
  for it — «Влить», which applies the ticket's cumulative diff to the real project without a branch, and
  «Вернуть с комментарием», which turns the comment into a repair turn. «Открыть сессию» attaches to the
  ticket's session for a manual takeover, and «Пауза» stops the board's pump. The factory itself never sends
  anything outward: push, PR and comments happen only when the user presses the button.
- **Factory settings.** Per-role models (`triage`, `work`, `tests`, `review`), the allowed routes, workers per
  ticket, tickets at once and per day, API-engine and low-subscription allowances, test/check/preview
  commands, the «дописать тесты» quirk (`appendTests` asks for a test step when the change touched none) and
  the board's tracker list; `settingsProblems` rejects an unknown template, an empty route list and
  non-positive limits.
- **Host plumbing — `lib/check.js`.** The guard rails around unattended work, kept pure and injectable:
  `suggestCheckCommand` reads the manifests (`package.json` scripts in priority order, then a Makefile
  `test:` target, `Cargo.toml`, `go.mod` and Python markers), `runCheck` runs one command through the
  platform shell with a clean environment, a hard timeout that kills the whole process tree and a bounded
  output tail, `scanHygiene` reports secret and junk paths plus credential-shaped added lines, `scanOutward`
  matches only whole outward verb phrases, and `freeDiskBytes` reports free space without throwing.
- **Host plumbing — `lib/trackers.js`.** `parseIssueRef` accepts a bare `#12`, `owner/repo#12` and a GitHub
  issue URL; `normalizeIssue` gives every source a stable external id (`gh:<repo>#<n>`, `gl:<repo>#<iid>`,
  `jira:<KEY>`, `lin:<identifier>`); `listTrackerIssues` and `commentTrackerIssue` cover GitHub, GitLab,
  Jira and Linear with per-kind configs; `trackerProblems` reports what a tracker entry is missing. The
  module never throws: a failing tracker becomes an `{error}` the board records.
- **Host plumbing — queue.** `lib/queue.js` holds the queue record, task records and pure helpers
  (`createQueueRecord`, `createTaskRecord`, `queueCounts`, `queueProgress`, `nextQueuedTask`,
  `canTransitionTask`, `classifyFailure`, `parkedBranch`, `resultsCard`, `queueSummary`, `stopReasonLabel`)
  and `QueueStore`, which keeps one JSON file per chat session under `state/queue`; `lib/queue-runner.js`
  holds `QueueRunner` — the pump, the pre-flight, version saving and postponing, the stop modes, the check
  and hygiene gates and the persistence of the «Итоги» card. The pre-flight makes you decide about earlier
  versions that were never saved or postponed before the toggle turns on.
- **Host plumbing — factory.** `lib/factory.js` holds the ticket board and ticket records, the stages and
  `STAGE_TRANSITIONS`, the templates, the triage/review/app-check parsers, the readiness report, the PR
  title and body builder and `TicketStore` (`state/tickets/boards.json`); `lib/factory-runner.js` holds
  `FactoryRunner` — the pump, the stage machine, the repair loop, the read-only app check, the reviewer step,
  PR/merge, the tracker poll and the attachment store. Attachments land under
  `state/attachments/<boardId>/<ticketId>/`; mid-pipeline tickets are adopted after a host restart.
- **Engine and run record.** `start` gains `basePath` (seed the copy from a saved version instead of the
  project), `sandboxMode` (force the run's sandbox) and `autoqueue` (night-shift prompt suffix on every
  turn); `planApproval` turns an orchestrator run into plan-then-approve, and `approvePlan(runId)` starts the
  parts once the plan is approved. `toSummary` exposes `autoqueue`, `basePath`, `planApproval` and
  `planApproved` so the client can show a run's origin and gate.
- **Routes and data layout.** New routes under `/api/dsh-artel/queue` (summary, tasks, pre-flight,
  autopilot, stop, finish-after-current, clear, retry/move, version save/postpone) and
  `/api/dsh-artel/factory` (boards, settings, readiness, tickets, answers, approve-plan, repair, return,
  comment, pull-request, merge, import, tracker poll); both return `503 artel/unavailable` on a host without
  the runner. Queue records live in `<DSH_HOME>/artel/<profile>/state/queue`, ticket boards in
  `<DSH_HOME>/artel/<profile>/state/tickets/boards.json` and attachments in
  `<DSH_HOME>/artel/<profile>/state/attachments/`.
- **Version follow-ups.** In «История» every auto-queue run carries an «Автоочередь» tag in the rail and in
  the run header; the «Итоги автоочереди» card offers «Открыть» a saved version, «Доработать» it as a new
  task seeded from that version's copy (`basePath`) and «Откатить» it (the version run is discarded and
  history refreshed). A ticket keeps its last five work versions and continues from a surviving copy when
  the latest one is gone.
- **Manual takeover and ticket versions.** «Открыть сессию» attaches the user to a ticket's run; «Взять
  вручную» interrupts live ticket runs, parks the ticket in «Ждёт вас» as postponed and takes it off the
  pipeline; the factory records the run and copy path of every work version so the ticket panel can show
  them and a retried ticket resumes from the last surviving version.
- **«Сейчас» — what each agent does and what the run waits for.** While a run is active or waiting, a strip
  under the header lists every agent with its state dot, its last step — the tool call it is running (`write
  src/app.js`) or «writing a reply» — the time spent on the current turn and the fill of its context window in
  tokens and percent. The header itself names the wait («Waiting for your answer», «Waiting for plan approval»,
  «Waiting for Nova», «The agents are working», «Assembling the result») and how long it has been waiting, so a
  run parked at the plan gate says what it is parked on. Both come from the run summary the Host already sends
  (`activity`, `turns`, `turnStartedAt`, `waitingFor` in `toSummary`), so the live state costs no extra request
  and never enters the JSONL feed.
- **Tool rows open.** A tool call that has something to show — the arguments the agent passed and the output (or
  the error) the tool returned — is now a button: it expands onto both, the chevron turns down, `aria-expanded`
  follows, and «Свернуть все» closes every open row. Rows that only repeat the name (`read README.md`) stay plain.
  The driver keeps `tool/call` arguments (capped at 4000 characters) and returns successful `tool/result` content
  (capped at 1200) as a `tool-result` event, matched to its call by `callId`.
- **Context and spend meters.** Every agent row shows how full its context window is — tokens of the window, the
  percent and a bar that turns amber at 50% and red at 80% — with the composition (system, tools, messages) in the
  tooltip; the run header adds the tokens the whole run has spent, with input, output and cache in the tooltip.
  The numbers come from the official token metering: `tokenMeter.contextPressure(session)` for the prompt size and
  the window, the `contextBreakdown` projection for the composition, and the provider's `usage` on every
  `assistant/message` for the spend.
- **Tests, docs and locale.** New `test/check.test.js`, `test/trackers.test.js`, `test/queue-runner.test.js`
  and `test/factory-runner.test.js` suites (23 and 26 tests in the first two) and new engine, client and
  routes flows for the queue and the Factory, plus engine, client and host-driver tests for the live strip,
  the tool disclosure and the context meters; README, ARCHITECTURE,
  the en/ru/zh guides and the plugin's locale descriptions now cover Автоочередь and Фабрика; version
  `0.8.0` in `package.json`.

## [0.7.0] — 2026-11-20

### Added

- **Orchestrator mode — a large goal split into verified parts.** You describe the goal; a planner reads
  the project and answers with a plan: up to `orchestratorParts` independent parts (three by default,
  four at most), each with a title, a goal, a `DONE` condition and the files it expects to touch. The
  plan arrives as a feed **Plan** card before any work starts, so the split is visible up front. The
  planner is the only agent at start and it runs in the `read-only` sandbox.
- **One copy and two agents per part.** After the plan, Artel makes one copy of the project per part,
  starts a part agent in each (ordinary DSH sessions, titled `Artel · Part N — <title> · <agent>`) and a
  reviewer next to it (`Artel · Review · Part N — <title> · <agent>`, pinned to `read-only`). The part
  agents inherit the chat session's sandbox mode; separate copies mean parallel parts cannot collide on
  disk and the planner never edits anything.
- **A reviewer checks every part against the plan.** When a part agent finishes, its reviewer reads the
  changes and compares them with the part's written conditions, then answers `VERDICT: accept` or
  `VERDICT: rework` with a `PROBLEMS:` list. A reworked part goes back to its agent with those problems,
  at most twice; after that it is accepted with the reviewer's remarks on record. A part that fails its
  reviewer never reaches you, and a part agent or reviewer that stops fails the whole run before
  assembly.
- **Assembly with a merger for shared files.** When every part is accepted, the accepted changes are
  written into one assembled copy. Files that only one part changed are applied directly; files that
  several parts changed with identical content are applied once; real conflicts are bundled under
  `.dsh-artel/conflicts/<nn>/` in the assembly copy and handed to a merger agent (ordinary session,
  role `merger`), which resolves them at their real paths. Artel then validates every conflicted file
  against the base state: a file the merger left untouched is unresolved, the merger is asked once more,
  and a second failure fails the run with the merge recorded — the assembled copy is kept for the diff,
  but `POST /api/dsh-artel/runs/:id/apply` answers `409 artel/merge-incomplete` until the work is
  discarded.
- **Plan and merge in the run record.** `run.plan` keeps the summary and each part's title, goal,
  conditions, files, status (`pending`/`working`/`reviewing`/`rework`/`accepted`/`failed`), rework
  rounds, remarks and the worker/reviewer names; `run.merge` keeps `conflicts`, `unresolved` and
  `merged`. `toSummary` exposes both, the feed reuses the existing `plan`/`status`/`error` kinds, and the
  run page gets a **Parts** card with per-part status chips and the plan's done conditions. Stage
  (`planning`/`working`/`merging`/`merge-stopped`/`assembled`) stays host-only, like Fusion and
  Conductor.
- **Host plumbing.** `lib/orchestrator.js` — a pure module with the plan markers (`PLAN:`, `PART n:`,
  `GOAL:`, `DONE:`, `FILES:`), the review markers (`VERDICT:`, `PROBLEMS:`), `parsePlan`, `parseReview`,
  `planCard`, `assembledCard`, `partLabel`, `MAX_ORCHESTRATOR_PARTS` and `MAX_ORCHESTRATOR_REWORK` —
  covered by `test/orchestrator.test.js`; the engine runs the orchestrator stage machine (planner →
  parts → per-part review/rework loop → assembly → merger validation), applies the same interruption and
  failure rules as Conductor, cleans up part copies once assembled and never writes the project before
  **Apply**.
- **`orchestratorParts` configuration.** New key in the plugin configuration (default `3`, clamped
  `2–4`); a plan with more parts than the limit is folded into the last kept part, with the folded goals
  and conditions appended.
- **Tests, docs and locale.** Seven new Orchestrator flow tests in `test/engine.test.js` (start and
  planning, happy path with a rework round and assembly and apply, conflicting files and the merger,
  a merger that fails twice, stopping during the merge, a worker that stops, an unreadable plan) and
  thirteen `test/orchestrator.test.js` unit tests; README, ARCHITECTURE, the en/ru/zh guide and the
  plugin's locale description now cover Orchestrator; version `0.7.0` in `package.json` and
  `lib/index.js`.

## [0.6.0] — 2026-11-20

### Added

- **Fusion mode — one question, several models, one decision.** Three panel models (roles `panelist`)
  receive the same task at the same moment and answer independently: separate conversations, no peer
  tools, no shared turns, so no model ever sees another's answer. The panel runs in the `read-only`
  sandbox and the approval policy is `never`, so a panel model physically cannot edit the copy — the
  deliberation is about *how* to do the work, and nothing is touched. A separate judge model
  (role `judge`) merges the three answers into one shared decision: where they converged, where they
  diverged, what only one of them noticed, and the merged plan. Nobody wins — the strong parts of each
  answer are kept. The merged decision arrives as a feed **Plan** card, and the status line counts the
  disputed places reported by the judge (`DISPUTES:` marker).
- **One model implements the merged decision.** The implementer (role `implementer`) receives the whole
  decision with the normal work rules, edits the copy and runs the project's checks. From there the run
  behaves like Solo: the usual diff review, **Apply** and **Discard**. A stopped panelist is skipped and
  the judge merges the answers that are in; if every panelist stops the run fails before anything is
  edited; a judge that stops or answers nothing gets one retry, then the run fails; a failed implementer
  leaves the run waiting with the partial diff.
- **Five route slots in the new-task form.** In Fusion mode the single model/effort chip is replaced by
  five slots — Panel 1, Panel 2, Panel 3, Judge, Implementer — each with its own model and reasoning
  effort picker. The panel is pre-seeded with distinct catalog rows and the judge/implementer start on
  the profile default; every slot can still be rerouted from the run page before its first turn. The
  `POST /api/dsh-artel/runs` body accepts `models: { panel?: [Selection, Selection, Selection], judge?:
  Selection, implementer?: Selection }`, and each selection is validated against the live catalog before
  the copy is created.
- **Host plumbing.** `lib/fusion.js` — pure stage names, panel size, `judgeDecision`, `hasDecision` and
  `fusionFailureNotice` — with `test/fusion.test.js`; the engine runs the panel/judge/working stage
  machine and only starts the implementer once a decision exists; `driver.createAgent` accepts
  `sandboxMode`; the host-driver pins the panel and the judge to `read-only`; the feed reuses the
  existing `plan`/`status`/`error` kinds, so there is no new surface. Fusion needs no subagent stack.
- **Docs and locale.** README, ARCHITECTURE (Fusion section, stage table, milestone M7), the en/ru/zh
  guide (a three-act Fusion walkthrough) and the plugin's locale description now cover Fusion; version
  `0.6.0` in `package.json`, `lib/index.js` and the client bundle.

### Changed

- The mode picker now offers four modes; the conductor round keeps its existing behaviour unchanged.

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
