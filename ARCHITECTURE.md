# dsh-artel — architecture (working plan)

Status: v0.1 shipped; the current tree is v0.8 — in-chat artel since v0.2, Conductor mode added on top
of Swarm, Fusion mode added on top of the model routing, Orchestrator in v0.7, and in v0.8 the
unattended **auto-queue** and the **Factory** ticket pipeline on top of ordinary runs. This is the
design and implementation plan, kept for contributors. Where it describes an earlier iteration and
differs from the shipped code — for example, run copies are plain directory copies (not git worktrees)
and run state lives under `<DSH_HOME>/artel/<profile>` — the README and the source are authoritative.
The v0.2 UX/architecture change is specified in `docs/artel-in-chat/DESIGN.md`.

## What it is

A DSH bundle plugin (`dsh-artel`) that turns "develop this in my project" into a managed run:

- **Solo** — 1 agent, its own copy of the project, works end to end. Live feed, user can message it mid-run, only the user's Apply button changes the real project.
- **Swarm** — 3 agents, ONE shared copy and ONE agent tree (the first agent is the tree root, the other two are its continuable subagents), so they can really message each other with the standard team tools. First turn is planning/ownership only (no edits), then parallel work in disjoint file areas. One combined diff, one Apply.
- **Conductor** — 1 conductor + `swarmAgentCount` workers (three by default), ONE shared copy and ONE agent tree like Swarm: the conductor is the root Session, the workers are its subagents. The first turn is planning only — the workers propose the shares and the conductor approves or reassigns them, its word is final. While the workers edit in parallel, a worker's question reaches the conductor and is answered without the user, and a failed worker's share is moved to a live worker. When every worker is idle the conductor reviews the whole copy (changed files + the project's checks) against the task and answers `VERDICT: accept` or `VERDICT: rework` with remarks, at most two rework rounds; accepted work still waits for the user's Apply.
- **Orchestrator** — a planner reads the real project (read-only) and splits the goal into parts with done conditions; each part is worked and reviewed in its own copy, and the accepted parts are assembled into one copy by the host (a merger resolves only real conflicts). One combined diff, one Apply, still only by the user.
- **Auto-queue** (v0.8) — a per-chat-session queue of tasks that runs unattended when the «Автоочередь» toggle is on. Every task is an ordinary run; a finished task passes the check command, becomes its own version, and the next task is seeded from the last successful version (`basePath`) while the diff base stays the real project. Night-shift rules, a check gate, parking and a results card; the Orchestrator is not a queue mode.
- **Factory** (v0.8) — a per-project ticket board run by agents: incoming tickets go through triage, work, tests, app check and review with repair rounds and land in «Готово к PR», where only the user opens a PR or merges. Tickets come from the board's incoming field, GitHub issues and GitHub/GitLab/Jira/Linear polling. The factory itself never sends anything outward.

The real project is never written by an agent: agents run with cwd = copy. Apply is a user action, in our UI.

## Entry point / surface (v0.2 — artel works from the chat)

Artel lives inside the chat, not in the right sidebar:

- **Launcher**: a button in the standard composer tool row (`conversation.input.left`, entry id
  `artel-launcher`, registered by the client bundle). Click opens the artel surface.
- **Surface**: a full-bleed overlay over the conversation region, portalled to `document.body` and
  positioned from `[data-conversation-content]`. It is rendered by the same `conversation.input.left`
  entry as the launcher (the composer dock slots do not exist in the hero/blank phase, so the
  launcher entry is the only mount point present everywhere). It works on a blank/new session and on
  an active one; the standard composer stays mounted underneath and returns instantly on close
  («Чат»).
- Why not a `conversation.view`: `DefaultConversationViews` renders nothing for a blank session
  (`session.blank` → `null`), so a hero/launch screen could never appear in a fresh chat; view
  activation would also need an extra, not-yet-verified API (`uiConversation.binding(id).activate`).
  The overlay has none of those constraints. See `docs/artel-in-chat/DESIGN.md`.
- The v0.1 right-sidebar tab type (`dsh-artel`/`artel`, `sidebar.right.pane.tab` body/title), its
  guide entry and the conversation-header action are removed in v0.2.

Surface layout: a left **rail** of this session's artel runs (status dot, title, meta
`Solo · 3/6 · phase`, «Новая сессия») and a workspace — hero for a new run, run page for an
existing one. "The project" is still the current session's working directory (fallback: the
plugin's default working directory), resolved by the host (`GET /project`), no project picker.

v0.8 does not add a sidebar tab either: the same launcher opens the session's **queue column**
(the «Ожидают» list and the «Автоочередь» toggle, next to the run page) and the per-project
**Factory board** («Фабрика»), which has its own view and a «Назад к сессиям» way out. The queue
belongs to the chat session; a board belongs to the project and survives sessions.

## UX (v0.2)

### Empty state — hero for a new run
Title «Новая задача», task textarea («Опишите задачу для агентов…»), mode picker (Solo / Swarm / Conductor / Fusion / Orchestrator with 1 line each;
in Fusion the single route chip is replaced by five route slots — three panel slots, the judge and the implementer),
primary button «Поехали →», and the isolated-copy note naming the project. The rail below shows
previous runs of this session.

### Run page (all modes)
- Header: mode tag, status (`preparing`, `planning`, `running`, `waiting for you`, `done`, `failed`,
  interrupted, applied, discarded), phase line (`phase` from the run summary), project chip, Stop.
- **Feed**: append-only, rendered as real chat messages — each agent reply is a full message with
  avatar, name, role and Markdown, plus compact tool rows, status rows, plan card, user messages
  (with recipient), peer messages, collision and error rows. Cursor-based incremental polling.
- **Composer**: artel's own composer inside the surface (recipient picker: all / a specific agent;
  Enter sends, Shift+Enter is a newline). «Leave a remark» is the same box — it wakes a finished solo
  agent too.
- **Changes**: file list with +N/−M, lazy per-file unified diff, colored with theme tokens. Refresh.
  Empty state "no changes yet" (also the swarm phase-1 state).
- **Actions**: `Apply changes` (primary, confirmation, all or selected files), `Discard run`
  (destructive, confirm). Apply only enabled when there are changes and the run is not running.
- **Agents** (all modes): rows with name, role, claimed files, state and the two route pickers; collisions flagged.

### Swarm turn-1 protocol (product requirement: "правок пока нет")
1. Host creates one copy, creates the team (see **Agents** below), prompts all three with: project description, the task, and the ownership protocol — *"This is turn 1. Do not create, edit or delete any file. You can message the other agents; end your turn with one OWNERSHIP line."*
2. Host waits for all three turns to end, collects claims from the agents' messages/plans, resolves overlaps (host assigns contested paths to the first claimant, tells the loser to re-claim inside the first message), then sends all three the go-ahead prompt containing the final ownership map: *"Work now. Your files: … . Do not write outside them. Message the owner instead. Read the copy as the others write. Report when done."*
3. Host tracks feeds; on `turn/end` for all three, status = `waiting for you`, compute combined diff of the shared copy.
4. Collisions that happen despite the map are shown in the feed (`edited outside assigned area`) by matching tool calls' file paths against the map — no hard blocking in v1.

## Data model

Persisted at `<DSH_HOME>/artel/<profile>/state/runs/` — one JSON per run plus the per-run feed (atomic write, written on every transition; not the source of truth for conversation content — only run bookkeeping, which is allowed by the practices rules since we cannot append custom session events).

```ts
type Mode = 'solo' | 'swarm' | 'conductor' | 'fusion' | 'orchestrator'
type RunStatus = 'preparing' | 'planning' | 'running' | 'waiting' | 'finished' | 'failed' | 'interrupted' | 'applied' | 'discarded'

interface RunRecord {
  id: string
  sessionId: string        // owning chat session
  mode: Mode
  task: string
  projectPath: string
  copyPath: string
  copyKind: 'worktree' | 'directory'
  baseCommit?: string      // git only
  baseHashes: Record<string, string> // project file hash at run start (for apply conflict guard)
  status: RunStatus
  error?: string
  autoqueue?: boolean      // unattended run: night-shift rules are appended to every prompt
  basePath?: string | null // seeded run: the version copy it started from (null = from the project)
  sandboxMode?: string | null // pinned sandbox mode (factory triage, app check, review agents)
  planApproval?: boolean   // orchestrator run that stops after the plan until approved
  planApproved?: boolean   // parts have been started by approvePlan()
  agents: AgentRecord[]
  plan?: OrchestratorPlan   // orchestrator runs
  merge?: MergeRecord       // orchestrator runs
  createdAt: number
  updatedAt: number
}
interface OrchestratorPlan {
  summary: string | null
  parts: Array<{
    id: string              // 'p1', 'p2', ...
    title: string
    goal: string
    conditions: string[]    // the plan's "done when" conditions
    files: string[]         // expected files, a hint only
    status: 'pending' | 'working' | 'reviewing' | 'rework' | 'accepted' | 'failed'
    rounds: number          // rework rounds
    remarks: string | null  // reviewer problems, then the accept notes
    workerId: string | null
    workerName: string | null
    reviewerId: string | null
    reviewerName: string | null
    copyPath: string | null // this part's copy, deleted once assembled
  }>
  folded: number            // parts folded into the last one by the max-parts cap
  problems: string[]
}
interface MergeRecord {
  conflicts: Array<{ path: string, parts: string[] }>
  unresolved: string[]
  merged: boolean
}
interface AgentRecord {
  sessionId: string
  name: string
  role: 'solo' | 'swarm' | 'conductor' | 'worker' | 'panelist' | 'judge' | 'implementer'
        | 'planner' | 'part' | 'reviewer' | 'merger'
                        // 'panelist'/'judge'/'implementer' in a Fusion run;
                        // 'planner'/'part'/'reviewer'/'merger' in an Orchestrator run
  kind: 'session' | 'member' // ordinary Session or subagent of the lead/conductor
  claimed: string[]
  status: 'starting' | 'planning' | 'working' | 'idle' | 'failed'
  // live, host-only, merged by ArtelEngine#summary and never persisted:
  activity: { kind: 'tool', tool: string, text: string, at: number }
          | { kind: 'assistant', text: string, at: number } | null
  turns: number             // turns this agent has started
  turnStartedAt: number | null  // when the open turn began, null between turns
  stats: {
    context: { tokens: number, window: number,
               breakdown: { system: number, tools: number, messages: number } | null,
               at: number } | null
    usage: { inputTokens: number, outputTokens: number, cacheReadTokens: number,
             cacheWriteTokens: number, totalTokens: number, requests: number } | null
  }
}
interface FeedEvent {
  seq: number
  at: number
  agent?: string      // agent sessionId/name
  kind: 'user' | 'assistant' | 'tool' | 'tool-result' | 'status' | 'error' | 'plan'
       | 'collision' | 'peer' | 'turn-start' | 'turn-end'
  text: string
  tool?: string
  path?: string       // for tool events, best-effort target
  edit?: boolean      // the tool changed the copy
  callId?: string     // tool/tool-result: links a result to its call
  args?: string       // tool: the arguments the agent passed, capped
  ok?: boolean        // tool-result/error: whether the tool succeeded
  from?: string       // peer events: display name of the sending agent
}
```

Feed events are kept in memory + appended to `<DSH_HOME>/artel/<profile>/state/feeds/<id>.jsonl` (capped, rotated at ~2 MB) so a reload/GUI restart still shows history. Live stream can be re-read by cursor. `RunSummary` (what the client gets) adds `phase`, `changeCount`, `finishedAt`, `appliedAt`, `feedSeq`/`feedFloor`, for Orchestrator runs `plan` and `merge`, and in v0.8 `autoqueue`, `basePath`, `planApproval` and `planApproved`; the full `RunRecord` stays host-side.

The same summary carries the live view added in v0.8: `waitingFor` (`{kind: 'user' | 'approval' | 'agents' | 'host', names?, stage?, since}` — why the run is held and since when, cached in `runtime.waitSince` and cleared when a turn starts) and `spend` (the summed `usage` of every agent). Both are computed in `ArtelEngine#summary` from the runtime and the driver's `statsOf`, so they are read-only projections: they are never persisted and never appended to the feed. `agent.activity` is the last session event of that agent (`tool` with its name, or `assistant` with the first 240 characters), `agent.turns`/`turnStartedAt` come from `#onTurnStart`/`#onTurnEnd`.

A Conductor run also keeps an in-memory `runtime.stage` (`planning`, `shares`, `working`, `review`, `rework`, `handover`, `accepted`). It is host-side only and never persisted; the persisted status keeps its existing meaning — `planning` during `planning`/`shares`, `running` during `working`/`review`/`rework`/`handover`, `waiting` after an accept. There are no new statuses and no new feed kinds: `plan` carries the share, rework and accept cards, `status` the stage lines, `peer` the agent messages and `error` the failures.

A Fusion run keeps its own in-memory `runtime.stage` (`panel`, `judge`, `working`). It is host-side only too: the run stays `planning` while the panel and the judge deliberate (nothing is edited), turns `running` when the implementer starts, and `waiting` when the implementer's turn ends and the diff is computed. No new statuses or feed kinds: `plan` carries the merged decision card, `status` the stage lines and `error` the failures.

An Orchestrator run keeps an in-memory `runtime.orch` (`stage` one of `planning`, `working`, `merging`, `merge-stopped`, `assembled`, plus the plan retry counter, the part awaiting review, the merge retry counter, the conflict list and the merger's agent id). It is host-side only as well: the run stays `planning` while the planner reads the project (nothing is edited), `running` while the parts work, are reviewed, reworked and assembled, `merge-stopped` if you stop it in the middle of the merge, and `waiting` once the assembly is finished. The plan and the merge state themselves are persisted on the run record (`plan`, `merge`) because the client renders them; there are still no new statuses and no new feed kinds.

An **auto-queue** is stored separately from the run record: `<DSH_HOME>/artel/<profile>/state/queue/<encoded-sessionId>.json`, one JSON per chat session (`QueueStore` in `lib/queue.js`, atomic tmp+rename, serialized writes). The queue record holds the switch and limit, the check command (explicit, disabled, or guessed by `suggestCheckCommand`), the task list (`queued`, `running`, `passed`, `parked`, `skipped`, `stopped`), `lastVersion {runId, path, title, changeCount, at}`, `stats {taken, passed, parked, consecutiveParks, startedAt}`, the event log, the results card, `stopReason`, `retryAt` and `ignoredVersions`. A task is not a run of its own kind: its `runId` and `basePath` point at an ordinary run and its seeded copy, so a queue version is a normal Artel version the user reviews, applies or discards.

**Factory** state is `<DSH_HOME>/artel/<profile>/state/tickets/boards.json` (`TicketStore` in `lib/factory.js`): board settings (template, per-role models, allowed routes, limits, commands, trackers, readiness) and the tickets in stages `incoming → triage → working → tests → check → review → ready / waiting → done`, each with its spec, route, repair round, run ids, versions, branch/PR and event log. Ticket attachments are ordinary files under `<DSH_HOME>/artel/<profile>/state/attachments/<boardId>/<ticketId>/`. Both runners reconcile their store with the run store on boot: a live run is adopted, a dead one parks or requeues its task or ticket; no runner keeps the only copy of anything.

## Host ⇄ client protocol

Chosen transport: **plugin HTTP routes** (`ctx.webServer`) + `fetch` from the tab body, the pattern already proven by `dsh-config-manager` in this profile. (Typert Remote is the alternative; revisit only if routes turn out to be restricted.)

All routes under `/api/dsh-artel/**`, JSON, same-origin + the connection's trust header as config-manager does it. Every route validates that `sessionId` exists and that the run belongs to it; all paths are compared after `path.resolve` containment checks.

| method | path | body/query | result |
|---|---|---|---|
| GET | `/api/dsh-artel/health` | — | `{ ok, version, ... }` |
| GET | `/api/dsh-artel/project` | `sessionId` | `{ projectPath, name }` (`projectPath: null` when unresolved) |
| GET | `/api/dsh-artel/runs` | `sessionId` | `{ runs: RunSummary[] }` |
| POST | `/api/dsh-artel/runs` | `{ sessionId, projectPath?, mode, task, model?, models? }` | 201 `{ run }` |
| GET | `/api/dsh-artel/runs/:id` | `cursor?`, `limit?` | `{ run, feed, cursor }` |
| POST | `/api/dsh-artel/runs/:id/messages` | `{ text, agentId? }` | `{ ok }` |
| POST | `/api/dsh-artel/runs/:id/interrupt` | — | `{ ok }` |
| GET | `/api/dsh-artel/runs/:id/changes` | — | `{ files: FileChange[] }` |
| GET | `/api/dsh-artel/runs/:id/diff` | `path` | `{ patch }` |
| POST | `/api/dsh-artel/runs/:id/apply` | `{ paths? }` | `{ ...result, run }` |
| POST | `/api/dsh-artel/runs/:id/discard` | — | `{ ok, run }` |

v0.2 additions to the summary: `phase` (last `status`/`plan` line, ≤120 chars) so the rail can show
`Solo · 3/6 · планирует` without fetching the feed. Requests are loopback-fenced
(`isLoopbackRequest`) and validated against the owning `sessionId`.

v0.8 adds two route groups. They are registered only when the Host has the runners (`queueRunner` and
`factoryRunner` are optional plugin arguments, so an older Host does not serve them at all; the client
then shows nothing and a direct call gets `503 artel/unavailable`).

| method | path | body/query | result |
|---|---|---|---|
| GET | `/api/dsh-artel/queue` | `sessionId`, `projectPath` | queue summary (tasks, toggle state, stats, results, check command) |
| POST | `/api/dsh-artel/queue` | `{ sessionId, texts[], task?, mode?, model?, prepend?, basePath? }` | `{ queue }` — adds tasks; never starts them; `basePath` seeds a task from a saved version copy |
| GET | `/api/dsh-artel/queue/preflight` | `sessionId`, `projectPath` | unsaved versions, check command, limit, disk, whether a run is live |
| POST | `/api/dsh-artel/queue/autopilot` | `{ sessionId, projectPath, autopilot, limit?, checkCommand?, checkDisabled?, saveVersionRunIds?, postponeVersionRunIds?, decisions? }` | `{ queue, blocked? }` |
| POST | `/api/dsh-artel/queue/stop` | `sessionId` | stops the agent, parks partial work |
| POST | `/api/dsh-artel/queue/finish-after-current` | `sessionId` | stops after the current task |
| POST | `/api/dsh-artel/queue/clear` | `sessionId` | drops finished tasks and the results card |
| DELETE | `/api/dsh-artel/queue/tasks/:taskId` | `sessionId` | `{ queue }` |
| POST | `/api/dsh-artel/queue/tasks/:taskId/retry` | `sessionId` | `{ queue }` |
| POST | `/api/dsh-artel/queue/tasks/:taskId/move` | `{ sessionId, direction }` | `{ queue }` |
| POST | `/api/dsh-artel/queue/versions/:runId/save` | `sessionId` | make the version the queue's `lastVersion` |
| POST | `/api/dsh-artel/queue/versions/:runId/postpone` | `sessionId` | park it instead |

| method | path | body/query | result |
|---|---|---|---|
| GET | `/api/dsh-artel/factory` | — | `{ boards }` |
| POST | `/api/dsh-artel/factory` | `{ projectPath, name? }` | create a board |
| GET | `/api/dsh-artel/factory/:boardId` | — | `{ boards, board, tickets }` |
| POST | `/api/dsh-artel/factory/:boardId/settings` | template/models/routes/limits/commands/quirks/trackers/pause/enabled | `{ board }` (enabling runs readiness) |
| POST | `/api/dsh-artel/factory/:boardId/readiness` | — | `{ readiness }` |
| POST | `/api/dsh-artel/factory/:boardId/poll` | — | poll this board's trackers |
| POST | `/api/dsh-artel/factory/poll-trackers` | `{ boardId? }` | poll one or all boards → `{ added, errors }` |
| POST | `/api/dsh-artel/factory/:boardId/tickets` | `{ title, text, attachments?, source? }` | add a ticket (≤8 attachments, 16 MB body) |
| GET | `/api/dsh-artel/factory/:boardId/tickets/:ticketId` | `cursor?` | `{ ticket, feed }` (the ticket's working run feed) |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/answers` | `{ text }` | answer triage questions |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/approve-plan` | — | release a gated Orchestrator plan |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/repair` | `{ action: 'more'\|'accept'\|'postpone' }` | resolve an exhausted repair loop |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/return` | — | re-triage after the user edits the ticket |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/comment` | `{ text }` | return to work with the comment as a repair turn |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/pull-request` | — | branch + commit + push + `gh pr create` (clean tree required) |
| POST | `/api/dsh-artel/factory/:boardId/tickets/:ticketId/merge` | — | apply the ticket diff into the real project |
| POST | `/api/dsh-artel/factory/:boardId/import` | `{ ref }` | import a GitHub issue (`#12`, `owner/repo#12` or a URL) |

## Copy, diff, apply

- **Copy**: git repo → detached worktree at `<copyRoot>/<runId>` (`git worktree add --detach`), recorded base commit; non-git → recursive directory copy excluding `node_modules`, `.git`, and the copy root itself.
- **Diff**: git copy → `git add -A` (in the copy) then `git diff --cached <baseCommit>`; non-git → compare against the base hash manifest, diff each changed text file with a small internal line diff (LCS). Result: `[{path, status: 'added'|'modified'|'deleted', added, removed, binary}]` + per-file patch text.
- **Apply**: for each changed file, verify the project file still matches `baseHashes` (otherwise `skipped: user edited this file during the run`), then write/delete it. Git repo additionally offers nothing fancier in v1 — copy-back is predictable and works for new/deleted files. Report a per-file result; never partially apply silently. An Orchestrator run with an unfinished merge (`merge.unresolved` non-empty) is refused before any of this with `409 artel/merge-incomplete`.
- **Cleanup**: `discard`/`apply` removes the worktree (`git worktree remove --force`) or deletes the copy dir; a startup sweep removes copies whose run is terminal and older than `keepCopiesHours`; the project itself is only ever touched by `apply`.

## Agents

Solo agents, the Swarm lead and the Conductor are ordinary Sessions created through the plugin-facing
session controller with `cwd = copyPath`, so each gets normal DSH tools, sandbox and approvals. Messages
to them are queued prompts; interrupt is `cancel`. Feed = durable `session/event` records filtered by
session id (`assistant/message`, `tool/call`, `tool/result`, `turn/start`, `turn/end`, and
`user/message` whose source is `{kind:'agent-message'}` → `peer`).

`mapSessionEvent` (lib/host-driver.js) keeps more than the feed needs, because the run page shows it: a
`tool/call` carries its `callId` and the pretty-printed `args` (capped at 4000 characters), a successful
`tool/result` becomes a `tool-result` event with the content text (capped at 1200) and the same
`callId`, so the client can fold a result into the call that produced it, and an `assistant/message`
carries the provider's `usage`. The driver also reads the official token metering on every event:
`tokenMeter.contextPressure(session)` → `{tokens, window}` for the agent's occupancy, the
`contextBreakdown` projection through the `sessionProjections` registry → `{system, tools, messages}`,
and it sums `usage` per agent. `#stats` is keyed by session id and exposed as `statsOf(handle)`;
`dispose()` forgets it. None of this is persisted: it is live state for the run summary only.

Swarm members are continuable subagents of the lead Session (`ctx.subagents.startActivation({provider:'spawn', parent: leadAgent, delivery:'caller', cwd: copyPath})`), so the whole team lives in ONE agent tree: `send_message`/`list_agents` reach every member, and a message one agent writes arrives in the other's conversation as a real turn. Two transport details follow from the host's fencing rules:

- The session controller refuses to prompt or cancel a Session whose `session.header.origin === 'subagent'` (`session "<id>" is owned by subagent routing`). Member turns therefore go through `ctx.subagents.prompt({childSessionId, delivery:'queue', content})`, which is the user-attributed path the Web UI itself uses; interrupts go through `ctx.subagents.interrupt(childSessionId, {kind:'user'})`.
- A local child settles and disposes its activation after each turn and is cold-resumed by the next delivery. During that closing window `subagents.prompt` fails with `subagent/delivery-unavailable`; the driver retries the same prompt with backoff (8 attempts, 40ms→1200ms). This requires the lead Session to stay live for the lifetime of the run.

`delivery:'caller'` keeps member completions out of the lead's model context (the engine learns turn ends from Session events instead). The run page offers "open conversation" for solo agents and the lead only; members have no separate chat.

Conductor runs use the same machinery with a lead that stays for the whole run: the conductor is the ordinary Session (`driver.createAgent`, address `conductor`) and the workers are its subagent children (`driver.spawnMember`, one address per worker), so the team lives in ONE agent tree and `send_message`/`list_agents` work across it. Before a Conductor run creates its copy, the driver checks `supportsPeers()`; a profile without the subagent stack is refused with `artel/peers-required` — unlike Swarm, Conductor has no independent-session fallback.

Fusion runs are five ordinary Sessions and need no subagent stack. The engine creates all five up front with `driver.createAgent` — so the panel, the judge and the implementer can be routed before their first turn — but prompts only the panel. The panel and the judge are created with `sandboxMode: 'read-only'`: the driver writes a `sandbox/mode` event that pins that Session, and because the driver also sets the approval policy to `never`, no escalation is possible, so a panel or judge model physically cannot edit the copy. The implementer keeps the chat session's inherited mode. The five sessions appear in the sidebar as separate chats; they stay inert after their turns.

Orchestrator runs are ordinary Sessions too and need no subagent stack. Only the planner exists at start: it is created with `sandboxMode: 'read-only'` and its working directory is the real project, so it can read the code but cannot edit anything. Once the plan is parsed the engine appends a part agent (role `part`) and a reviewer (role `reviewer`) per part to `run.agents` and creates their Sessions after the part copies exist — the part agent with `cwd = <part copy>` and the chat session's inherited sandbox mode, the reviewer with the same copy and `sandboxMode: 'read-only'`. When the parts are assembled, one merger Session (role `merger`) is created in the assembled copy with the inherited mode — only if the assembly has conflicting files. Every Orchestrator agent is titled after its part (`Artel · Part N — <title> · <agent>`, `Artel · Review · Part N — <title> · <agent>`, `Artel · Merge · <agent>`) and appears in the sidebar; all stay inert after their turns.

### Provider, model and reasoning effort

The picker catalog is built host-side from `ctx.llm`: `listProviders()` → `listModels(provider)` → `resolveModelInfo({provider, model})`, seeded with `ctx.agentDefaultModel.currentSelection()`. `lib/models.js` is pure (build/normalize/validate/describe), so the shape is unit-tested without DSH.

The route is applied per agent through `agent.model.select({provider, model, reasoningEffort})` — the live Agent is reached with `ctx.agents.get(sessionId)` (the controller registry, not the handle). We deliberately do NOT use the Remote `sessionController.selectModel`: it also rewrites the user's profile default as a side effect, and a reroute of one Artel agent must not change what the next chat starts on. Selection is validated against the catalog first (`artel/model-unavailable`); a route the Host then refuses degrades to a feed warning and the agent keeps the profile default, so a mistyped route never kills a run.

The spawn-based swarm cannot take a model at creation time (`subagents.startActivation` has no model/agentOptions fields), so a member is routed right after its child Session appears and is reachable through `ctx.agents.get(childId)` (12 attempts × 40 ms). Its first planning step may therefore run on the default route.

## Conductor

Mode `conductor` reuses Swarm's one-copy, one-tree model and puts a lead on top. The team is 1 conductor
plus `swarmAgentCount` workers (2–8, three by default): `run.agents[0]` is the conductor with role
`conductor`, the rest are workers with role `worker`. A Conductor run therefore starts
`1 + swarmAgentCount` agents — one more than the configured Swarm count — and the conductor counts as
the root of the agent tree, not as a worker.

The host keeps a `runtime.stage` for the run (host-side only, never persisted — see **Data model**):

| stage | run status | what the host does |
|---|---|---|
| `planning` | `planning` | Starts the conductor and the workers; workers answer with an `OWNERSHIP:` line, the conductor ends its turn with a `SHARES:` line. |
| `shares` | `planning` | Parses the worker proposals and prompts the conductor to decide; `parseShares` turns its `SHARES:` answer into the final worker→files map (approving the proposal or reassigning it). A missing decision is retried once. |
| `working` | `running` | Sends each worker its final share, tracks `turn/end`, and watches for failures: a stopped worker's share is moved by the conductor to the least loaded live worker; the move is a `plan` card. |
| `review` | `running` | Every worker idle → prompts the conductor to read the changed files, run the project's checks and compare the copy with the task. A missing verdict is retried once. |
| `rework` | `running` | `VERDICT: rework` with an optional `REWORK:` list sends the named shares back while the others are accepted for now. Capped at `MAX_REWORK_ROUNDS = 2`; a third request is coerced to an accept with remarks. |
| `handover` | `running` | An in-flight share move: the conductor names the receiver, and a missing answer makes Artel pick the least loaded worker itself. |
| `accepted` | `waiting` | `VERDICT: accept` → the run goes to `waiting for you` with the combined diff; the user still has to press Apply. |

- **Markers**: workers close their planning turn with `OWNERSHIP:`, the conductor uses `SHARES:`,
  `VERDICT:` and `REWORK:`. The parsers, the failure classifier, the change digest and the handover
  helpers live in `lib/conductor.js` as pure functions (`parseShares`, `parseVerdict`,
  `failureKindOf`, `changeDigest`, `leastLoadedName`, `capText`) and are unit-tested without DSH.
- **The conductor never edits and never applies.** Its prompts forbid writes in the copy, and the host
  applies the mechanical consequences (share move, rework round). The review is a review of the whole
  copy: changed files plus the project's checks, not a per-file diff.
- While the conductor decides — stages `shares`, `review`, `handover` — `message()` is refused with
  `artel/reviewing`; `interrupt()` in those stages resets the stage to `working` and clears the failure.
- **No new surface**: no new feed kinds, routes or statuses. The existing `plan` kind carries the
  proposed shares, the handed-out shares, the rework round and the accept card; `status` carries the
  stage lines; `peer` carries the agent messages; `error` carries worker and conductor failures. Copy,
  diff, apply/discard and model routing are unchanged from Swarm.

## Fusion

Mode `fusion` adds a "one question, several models, one decision" run on top of Solo. The run has five
agents: `run.agents[0..2]` are panelists (roles `panelist`, names `Vega`, `Orion`, `Lyra`),
`run.agents[3]` is the judge (`judge`, `Atlas`) and `run.agents[4]` is the implementer (`implementer`,
`Nova`). Each agent record carries its own `model` selection, taken from the start request:

```ts
start({ sessionId, projectPath, mode: 'fusion', task, models?: {
  panel?: [Selection, Selection, Selection],
  judge?: Selection,
  implementer?: Selection,
} })
```

A selection is the same `{provider, model, reasoningEffort?}` shape the route pickers use. Missing slots
fall back to the request's `model` (or the profile default when that is absent too); every provided
selection is normalized and validated against the live catalog before the copy is created, so a bad
route fails the start with `artel/model-unavailable` and nothing is copied.

The host keeps a `runtime.stage` for the run (host-side only, never persisted — see **Data model**):

| stage | run status | what the host does |
|---|---|---|
| `panel` | `planning` | Prompts the three panelists in the same step, each with its own name and the read-only rule. They answer independently and never see each other — no peer tools, no shared turns. Collects each answer's final text verbatim. |
| `judge` | `planning` | Renders the three answers (verbatim, with the model label) into the judge prompt; the judge merges them into one decision and closes with `DISPUTES: <n>`. A missing answer is retried once. The merged decision becomes a `plan` card. |
| `working` | `running` | Sends the implementer the full merged decision with the normal Solo work rules; it edits the copy and runs the project's checks. Its idle settle produces the usual diff and `waiting for you`. |

- **Failure handling**: a panelist that stops is skipped — the judge merges the answers that are in; if
  every panelist stops, the run fails before anything is edited. A judge that stops or answers nothing is
  asked once more, then the run fails. A failed implementer leaves the run waiting with whatever diff
  exists — the normal idle-settle path, no special state.
- **Read-only**: the panelists and the judge are pinned to the `read-only` sandbox mode by the driver;
  the task is a discussion about *how*, so the run cannot touch the copy until the implementer starts.
  This is why the stage is host-only: it is a scheduling fact, not a state the user must review.
- **Markers**: the judge closes its answer with `DISPUTES:`. `lib/fusion.js` is pure — stage names, panel
  size, `judgeDecision` (splits the merged text from the marker, parses the count, tolerates a missing
  marker), `hasDecision`, `fusionFailureNotice` — and unit-tested without DSH.
- **Messages**: while the run is `planning`, `message()` accepts only a message to the agents of the
  active stage (panelists during `panel`, the judge during `judge`) and never patches the status; a
  message that targets a finished or not-yet-started role is refused with `artel/planning`. Once the
  implementer starts, the normal running/waiting message rules apply. `interrupt()` ends the run in
  `working` — a stopped Fusion run cannot resume the panel.
- **No new surface**: the existing `plan` kind carries the merged decision card, `status` carries the
  stage lines and `error` carries the failures. Copy, diff, apply/discard and model routing are
  unchanged from Solo; the run page already renders one route row per agent.

## Orchestrator

Mode `orchestrator` turns a goal into parts, works each part in its own copy, verifies each part against
the plan's conditions and then assembles the accepted parts into one copy. It reuses Solo's diff/apply
path — nothing reaches the user's project before **Apply** — and needs no subagent stack. The run starts
with a single agent, `run.agents[0]` (role `planner`), created with `sandboxMode: 'read-only'` and
`cwd = projectPath`: it reads the real project and cannot edit anything. No copy is made at start; the
engine records `baseHashes` with `hashTree(project)` and keeps that manifest as the common base for every
part copy. The start request asks the planner for `orchestratorParts` parts (default 3, clamped 2–4); the
parser never accepts more than `MAX_ORCHESTRATOR_PARTS = 4` and folds the rest into the last part.

The host keeps a `runtime.orch` for the run (host-side only, never persisted — see **Data model**):

| stage | run status | what the host does |
|---|---|---|
| `planning` | `planning` | Prompts the planner with the plan markers (`PLAN:`, `PART n:`, `GOAL:`, `DONE:`, `FILES:`); `parsePlan` reads the answer, a missing or unreadable plan is retried once. On success persists `run.plan`, writes the **Plan** card and starts the parts. |
| `working` | `running` | Makes one copy per part (`<copyRoot>/<runId>-p<i>`) and creates a part agent and a reviewer per part. Sends each part agent its contract; when a part agent finishes, the reviewer gets the part's change digest and the written conditions. `parseReview` gives `accept` or `rework`; a reworked part goes back to its agent with the reviewer's problems (at most `MAX_ORCHESTRATOR_REWORK = 2`, after that the part is accepted with the remarks on record). A missing verdict is retried once. When every part is accepted, drives the merge. |
| `merging` | `running` | Copies the project into `run.copyPath`, replays each accepted part's changes against the common base, applies paths changed by a single part (or by several with identical content) directly, bundles real conflicts under `<copyPath>/.dsh-artel/conflicts/<nn>/` (always excluded from diff and apply) and prompts the merger with that bundle. Artel then validates each conflict: the file at its real path must differ from the base. Unresolved files get one more merger attempt; a second failure fails the run with `merge.unresolved` persisted. |
| `merge-stopped` | `interrupted` | The user interrupted during the merge. The assembled copy and `merge.unresolved` are kept; **Apply** is refused until the run is discarded. |
| `assembled` | `waiting` | Every conflict resolved (or none at all): `merge.unresolved` is cleared, `merge.merged = true`, part copies are deleted, the diff of the assembled copy is published and the run waits for the user like any other mode. |

- **Markers**: the planner answers with `PLAN:`, `PART n:`, `GOAL:`, `DONE:` (conditions separated by
  `;`) and `FILES:`; the reviewer answers with `VERDICT: accept|rework` and an optional `PROBLEMS:` list.
  The parsers, the plan/assembly cards and the constants live in `lib/orchestrator.js` as pure functions
  (`parsePlan`, `parseReview`, `planCard`, `assembledCard`, `partLabel`,
  `MAX_ORCHESTRATOR_PARTS`, `MAX_ORCHESTRATOR_REWORK`) and are unit-tested without DSH.
- **Isolation**: each part has its own copy, so parallel parts cannot collide on disk and the engine
  never emits edit collisions in this mode (`#noteEdit` is skipped). The reviewer and the planner are
  read-only; only a part agent writes, and only inside its own part copy. Overlaps are resolved at the
  merge step, by content, not by watching tools.
- **Failure handling**: a planner that stops or cannot produce a readable plan twice fails the run before
  anything is edited. A part agent or a reviewer that stops fails the whole run: the parts are not
  assembled, so nothing reaches the user's project (the error names the part), and the part copies are
  removed. A merger that stops is retried like an unresolved merge. An interrupted run before assembly
  keeps no copies; interrupted during the merge keeps the assembly for the diff but blocks **Apply**.
- **Messages**: the run is `planning` while the planner works, so `message()` is refused there with
  `artel/planning`; during `running` the normal rules apply (write to every agent or one named agent),
  and `merge-stopped` is refused with `artel/merge-incomplete`. A stopped run cannot resume a stage.
- **No new surface**: no new feed kinds or routes. `plan` carries the plan card, each part verdict and
  the assembly card; `status` carries the stage lines; `error` carries failures. `apply` gains one guard
  (`409 artel/merge-incomplete` while `merge.unresolved` is non-empty) and the run summary gains `plan`
  and `merge`, which the run page renders as the **Parts** card.

## Auto-queue (v0.8)

A queue is a per-chat-session list of ordinary tasks that runs unattended while the «Автоочередь» toggle
is on. The pure half is `lib/queue.js`: task states (`queued`, `running`, `passed`, `parked`, `skipped`,
`stopped`), the transition table `TASK_TRANSITIONS`, `QUEUE_MODES` (Solo, Swarm, Conductor, Fusion — the
Orchestrator is deliberately not a queue mode), the helpers `nextQueuedTask`, `queueCounts`, `endsWithQuestion`,
`parkedBranch`, `classifyFailure`, `resetMinutes`, `stopReasonLabel`, `resultsCard` and `queueSummary`, the
constants (`DEFAULT_QUEUE_LIMIT = 20`, `MAX_QUEUE_TASKS = 200`, `QUEUE_TUNING { maxFixes: 2, maxQuestions: 1,
maxConsecutiveParks: 3, retryDelayMs: 15 min, minDiskBytes: 500 MB, checkTimeoutMs: 15 min }`) and
`QueueStore`, which persists one JSON per session with atomic tmp+rename writes.

`lib/queue-runner.js` is the pump (`QueueRunner`). Two design points keep it small:

- **A task is just a run.** `addTasks` only writes task records; `setAutopilot` flips the switch. The pump
  takes the next queued task, starts an ordinary run via `engine.start` with `autoqueue: true` and, when the
  queue already has a successful version, `basePath = lastVersion.path`, so the run is seeded from that
  version's copy while its diff base stays the real project. When the run settles, its diff is a normal Artel
  version — `saveVersion` records it as the queue's `lastVersion`, while the pre-flight's `postponeVersion` puts
  an older untracked version into `ignoredVersions`.
- **The gate is check + hygiene.** A finished task passes when the run is idle/waiting, the change scan found
  no secret or junk file and no outward command (`scanHygiene`, `scanOutward`), and `runCheck` with the queue's
  check command passed (or the check is disabled, or no command could be guessed). A failure is fed back with
  `checkRepairPrompt` for `maxFixes = 2` attempts, then the task is parked. A task is also parked on an
  unanswered second question (the first one is answered with `autoAnswerPrompt`), a `BLOCKED:` summary, or a
  hygiene/outward finding; parked work keeps its copy and gets the branch `vf/parked-<runId>`, and «Отложенное»
  is the parked list.

`classifyFailure` decides where a failure goes: `login-lost` ends the queue, `rate-limit` only pauses it (the
reset time parsed out of the text when there is one, otherwise `retryDelayMs = 15 min`), anything else parks the
task. Night-shift rules are not a queue concern:
`engine.start` with `autoqueue: true` appends `nightShiftRules()` to every prompt, so the agent does not ask,
writes assumptions, ends with `BLOCKED:` when stuck, never sends outward and never raises a preview. The pump
itself refuses to start a task when `freeDiskBytes(stateDir) < minDiskBytes`. The queue ends on empty, the task
limit, three parks in a row, a lost login or low disk, and produces the `resultsCard` («Итоги автоочереди»).
Stop modes are `stop` (kill the agent, park the partial work), `finishAfterCurrent` and the toggle off; while a
queue is live the pump ticks every `pollMs = 700` ms, and `summary()` is what the client reads for the
«Ожидают» column and the «Итоги» card.

## Factory (v0.8)

The domain half is `lib/factory.js`: `FACTORY_STAGES` (`incoming`, `triage`, `working`, `tests`, `check`,
`review`, `ready`, `waiting`, `done`), `STAGE_TRANSITIONS`, `FACTORY_TEMPLATES` (`normal`: 2 repair rounds,
app check, 1 reviewer; `fast`: 1 round, no app check; `strict`: 3 rounds, app check, 2 reviewers),
`BOARD_COLUMNS` (the nine-stage board) and `APP_BOARD_COLUMNS` (the app board folds tests/check/review into
«Проверки»), `WAITING_KINDS`, the marker parsers `parseTriage`, `parseReview` and `parseAppCheck`, the ticket
helpers (`createTicketRecord`, `ticketCriteria`, `ticketIsUi`, `sourceKey`, `readinessReport`,
`readinessProblems`, `prTitle`, `prBody`, `settingsProblems`, `canMoveStage`) and `TicketStore` at
`<stateDir>/tickets/boards.json`. Triage and review markers are exported from `lib/prompts.js`
(`SPEC:`, `CRITERIA:`, `ROUTE:`, `QUESTION:`, `ASSUMPTION:`, `VERDICT:`, `BLOCKER:`, `IMPORTANT:`, `MINOR:`,
`CHECK:`) together with the prompts `triagePrompt`, `factoryWorkPrompt`, `factoryRepairPrompt`,
`factoryReviewPrompt` and `factoryAppCheckPrompt`.

`lib/factory-runner.js` is the pump (`FactoryRunner`, one per Host). `#tick` fills free slots
(`ticketsAtOnce - active.size`) inside the daily budget (`ticketsPerDay`), `#advance` moves tickets through the
pipeline and `#step` drives the current stage:

- **triage** — a read-only run over the real project with `triagePrompt`; `parseTriage` writes `spec`
  (summary, criteria, assumptions) and a route into the ticket. The Factory may only *cheapen* the route the
  triage chose; questions park the ticket under «Ждёт вас» (`triage-questions`).
- **working** — a normal run (`mode = route`, `autoqueue: true`, `planApproval` for the Orchestrator route, so
  the run stops after its plan until `approvePlan`). The first question is auto-answered, the second parks the
  ticket (`interrupted`); an Orchestrator plan waits as `plan`.
- **tests** — `runCheck` with the board's test command (suggested when empty); **check** — the app check, only
  for UI tickets (`ticketIsUi`), only when the template wants it, a preview command is configured and Playwright
  is installed: a read-only solo run seeded with `basePath = workRun.copyPath`, its verdict read by
  `parseAppCheck`; **review** — one or two read-only reviewers over the ticket diff (`parseReview`), combined so
  any rework or unmet criterion wins.
- Any failing stage returns to **working** with the findings for up to `template.repairRounds` rounds, then the
  ticket waits as `repair-exhausted` (`repairAction` accepts another round, accepts as is, or postpones). Passing
  review moves the ticket to `ready` («Готово к PR»).
- **PR / merge** — `openPullRequest` only from `ready` and only on a clean tree: branch `factory/ticket-<number>`,
  apply the ticket run into the real project, `git add -A`, commit, push, `gh pr create` with `prBody` (spec,
  criteria, checks, assumptions, minor notes); `mergeTicket` applies the cumulative diff without a branch. Both
  are user buttons; the pipe itself never pushes, merges or sends anything outward.
- **intake** — tickets are created in «Входящие», imported from GitHub issues (`parseIssueRef` in
  `lib/trackers.js` accepts `#12`, `owner/repo#12` and an issue URL, `gh issue view` fetches it), or pulled from a
  board's trackers: GitHub, GitLab, Jira and Linear through `listTrackerIssues`, with `commentTrackerIssue` as
  the optional comment-back. `pollTrackers` runs every `trackerPollMs = 5 min`; every tracker import carries a
  stable `externalId` (`gh:<repo>#<n>`, `gl:<repo>#<iid>`, `jira:<KEY>`, `lin:<identifier>`), `sourceKey` dedupes
  on it (or on the issue URL), and a duplicate add is `409 artel/factory/duplicate-ticket`.
- **restart** — `init` adopts every ticket whose pipeline run is still alive; a ticket whose run died is parked
  or restarted from its stage instead of being forgotten.

### Engine support for unattended runs (v0.8)

- `engine.start({ ..., basePath, sandboxMode, autoqueue, planApproval })` — `basePath` seeds the new copy from
  an existing version copy instead of the project (the queue's version-to-version seeding); `sandboxMode` pins
  the new Session's sandbox (`read-only` for the Factory's triage, app-check and review agents); `autoqueue`
  marks the run and appends `nightShiftRules()` to every prompt; `planApproval` is accepted only for the
  Orchestrator and gates the run after the plan. The summary gains `autoqueue`, `basePath` (`null` when the run
  was seeded from the project), `planApproval` and `planApproved`.
- `engine.approvePlan(runId)` — releases a gated Orchestrator run. It is refused unless the run is a
  `planApproval` Orchestrator run with a parsed plan, and idempotent (an already approved run returns its
  summary); otherwise it sets `planApproved: true` and starts the parts.
- `checkRepairPrompt()` from `lib/prompts.js` and the check/hygiene helpers in `lib/check.js` are what the
  queue's gate and the Factory's test stage share; `lib/check.js` exports `suggestCheckCommand`, `runCheck`,
  `scanHygiene`, `scanOutward` and `freeDiskBytes`, all injectable and unit-tested without DSH.

## Package layout (no build step)

```
dsh-artel/
  package.json            # dsh.bundle.patch, dsh.client{platform:'web',inject:[...]}, exports './client', './locale/*.json', './icon'
  cordis.patch.yml        # - insert: [{ id: dsh-artel, name: dsh-artel }]
  lib/index.js            # Host half, plain ESM, export const inject, Config, apply(ctx, config)
  lib/client.js           # window.__ModuleLoader__.load({ id:'dsh-artel', factory(require){...} })
  lib/*.js                # host modules: run-store.js copy.js diff.js models.js conductor.js fusion.js orchestrator.js
                          #   check.js trackers.js queue.js queue-runner.js factory.js factory-runner.js routes.js host-driver.js engine.js
  locale/{en,ru,zh}.json  # meta.title/meta.description + strings
  icon.svg
  README.md, LICENSE
  docs/guide.md           # meta.detail (en; guide.ru.md / guide.zh.md are the localized copies)
  test/                   # node:test unit tests for pure logic
```

Server code is plain ESM JavaScript (no TS) so nothing has to be compiled; the client half is hand-written `React.createElement` (no JSX) inside the loader factory.

## Config (schemastery)

`copyRoot` (default `<DSH_HOME>/artel/<profile>/copies`), `stateDir` (default `<DSH_HOME>/artel/<profile>/state`; run records and feeds live in `runs/` and `feeds/`, and the v0.8 stores in `queue/`, `tickets/boards.json` and `attachments/`), `swarmAgentCount` (3, 2..8; a Conductor run starts one conductor on top, so `1 + this` agents), `orchestratorParts` (3, 2..4; an Orchestrator plan with more parts is folded into the last one), `maxRunsPerSession` (10), `keepCopiesHours` (72), `diffContext` (3), `idleGraceMs` (1200, how long a potential peer message may still be in flight before the run is called idle), `excludeGlobs` for non-git copies. The auto-queue and the Factory add no config keys: their settings are per session (queue) and per board (tickets). No behavior-changing defaults that surprise.

## Milestones

1. **M1 skeleton**: package installs, Artel tab appears in the guide page and opens, page renders empty state + locale + icon. No agents yet.
2. **M2 Solo**: copy creation, agent start, live feed, message, interrupt, finish detection.
3. **M3 Review**: changes list + per-file diff + apply (with conflict guard) + discard + cleanup.
4. **M4 Swarm**: 3 agents, planning turn, ownership map, go-ahead, combined diff, collision notices.
5. **M5 Ship**: ru/zh strings, README + guide doc, unit tests, restart safety, `dshmarket` packaging notes, install + end-to-end verification in the running GUI.
6. **M6 Conductor**: one conductor + N workers, share proposal/approval, peer Q&A through the conductor, failure handover, whole-copy review with checks, two-round rework cap, accepted work waiting for the user's Apply.
7. **M7 Fusion**: three independent panel answers, a judge merge with a disputes count, one implementer; read-only panel and judge; five route pickers in the hero form; panelist/judge failure handling; the merged decision as a plan card; accepted work still waiting for the user's Apply.
8. **M8 Orchestrator**: a planner splits the goal into parts with done conditions; one copy and two agents (a part agent and a read-only reviewer) per part; per-part accept/rework loop capped at two rounds; assembly of the accepted parts into one copy; a merger for files several parts changed, validated by the host; `plan`/`merge` in the run summary and a Parts card; apply refused while the merge is unfinished.
9. **M9 Auto-queue**: a per-session queue store and pump; tasks as ordinary runs seeded from the last successful version (`basePath`); night-shift prompt rules and one auto-answered question; check gate with two repair attempts and a hygiene/outward scan; version saving; parking to `vf/parked-…` with «Отложенное»; failure classification with `retryAt` for subscription limits; stop/finish-after-current/toggle-off and the auto-end conditions; the «Итоги автоочереди» results card. Orchestrator stays out of the queue.
10. **M10 Factory**: ticket boards with their own store, stages and transitions; the three templates; triage → work → tests → app check → review with repair rounds; «Ждёт вас» and the manual actions; readiness; ticket intake from «Входящие», GitHub issues and GitHub/GitLab/Jira/Linear polling; the «Готово к PR» flow (Pull Request, Merge, Return with a comment); engine `planApproval`/`approvePlan` and the read-only app check; nothing sent outward by the pipe.
