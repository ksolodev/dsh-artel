# dsh-artel — architecture (working plan)

Status: v0.1 shipped; the current tree is v0.6 — in-chat artel since v0.2, Conductor mode added on top
of Swarm, Fusion mode added on top of the model routing. This is the design and implementation plan,
kept for contributors. Where it describes an earlier iteration and differs from the shipped code — for
example, run copies are plain directory copies (not git worktrees) and run state lives under
`<DSH_HOME>/artel/<profile>` — the README and the source are authoritative. The v0.2 UX/architecture
change is specified in `docs/artel-in-chat/DESIGN.md`.

## What it is

A DSH bundle plugin (`dsh-artel`) that turns "develop this in my project" into a managed run:

- **Solo** — 1 agent, its own copy of the project, works end to end. Live feed, user can message it mid-run, only the user's Apply button changes the real project.
- **Swarm** — 3 agents, ONE shared copy and ONE agent tree (the first agent is the tree root, the other two are its continuable subagents), so they can really message each other with the standard team tools. First turn is planning/ownership only (no edits), then parallel work in disjoint file areas. One combined diff, one Apply.
- **Conductor** — 1 conductor + `swarmAgentCount` workers (three by default), ONE shared copy and ONE agent tree like Swarm: the conductor is the root Session, the workers are its subagents. The first turn is planning only — the workers propose the shares and the conductor approves or reassigns them, its word is final. While the workers edit in parallel, a worker's question reaches the conductor and is answered without the user, and a failed worker's share is moved to a live worker. When every worker is idle the conductor reviews the whole copy (changed files + the project's checks) against the task and answers `VERDICT: accept` or `VERDICT: rework` with remarks, at most two rework rounds; accepted work still waits for the user's Apply.
- **Fusion** — the task goes to three panel models at the same moment; each answers independently in a read-only session and never sees the others. A judge model merges the three answers into one decision (agreement, disagreement, what only one answer saw, `DISPUTES:` count), and a single implementer model receives that decision and does the work. Five ordinary Sessions, no subagent stack needed; only the implementer can edit the copy.

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

## UX (v0.2)

### Empty state — hero for a new run
Title «Новая задача», task textarea («Опишите задачу для агентов…»), mode picker (Solo / Swarm / Conductor / Fusion with 1 line each;
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

Persisted at `<DSH_HOME>/artel/runs.json` (atomic write, written on every transition; not the source of truth for conversation content — only run bookkeeping, which is allowed by the practices rules since we cannot append custom session events).

```ts
type Mode = 'solo' | 'swarm' | 'conductor' | 'fusion'
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
  agents: AgentRecord[]
  createdAt: number
  updatedAt: number
}
interface AgentRecord {
  sessionId: string
  name: string
  role: 'solo' | 'swarm' | 'conductor' | 'worker' | 'panelist' | 'judge' | 'implementer'
                        // 'panelist'/'judge'/'implementer' in a Fusion run
  kind: 'session' | 'member' // ordinary Session or subagent of the lead/conductor
  claimed: string[]
  status: 'starting' | 'planning' | 'working' | 'idle' | 'failed'
}
interface FeedEvent {
  seq: number
  at: number
  agent?: string      // agent sessionId/name
  kind: 'user' | 'assistant' | 'tool' | 'status' | 'error' | 'plan' | 'collision' | 'peer'
  text: string
  tool?: string
  path?: string       // for tool events, best-effort target
  from?: string       // peer events: display name of the sending agent
}
```

Feed events are kept in memory + appended to `<DSH_HOME>/artel/runs/<id>.jsonl` (capped, rotated at ~2 MB) so a reload/GUI restart still shows history. Live stream can be re-read by cursor. `RunSummary` (what the client gets) adds `phase`, `changeCount`, `finishedAt`, `appliedAt`, `feedSeq`/`feedFloor`; the full `RunRecord` stays host-side.

A Conductor run also keeps an in-memory `runtime.stage` (`planning`, `shares`, `working`, `review`, `rework`, `handover`, `accepted`). It is host-side only and never persisted; the persisted status keeps its existing meaning — `planning` during `planning`/`shares`, `running` during `working`/`review`/`rework`/`handover`, `waiting` after an accept. There are no new statuses and no new feed kinds: `plan` carries the share, rework and accept cards, `status` the stage lines, `peer` the agent messages and `error` the failures.

A Fusion run keeps its own in-memory `runtime.stage` (`panel`, `judge`, `working`). It is host-side only too: the run stays `planning` while the panel and the judge deliberate (nothing is edited), turns `running` when the implementer starts, and `waiting` when the implementer's turn ends and the diff is computed. No new statuses or feed kinds: `plan` carries the merged decision card, `status` the stage lines and `error` the failures.

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

## Copy, diff, apply

- **Copy**: git repo → detached worktree at `<copyRoot>/<runId>` (`git worktree add --detach`), recorded base commit; non-git → recursive directory copy excluding `node_modules`, `.git`, and the copy root itself.
- **Diff**: git copy → `git add -A` (in the copy) then `git diff --cached <baseCommit>`; non-git → compare against the base hash manifest, diff each changed text file with a small internal line diff (LCS). Result: `[{path, status: 'added'|'modified'|'deleted', added, removed, binary}]` + per-file patch text.
- **Apply**: for each changed file, verify the project file still matches `baseHashes` (otherwise `skipped: user edited this file during the run`), then write/delete it. Git repo additionally offers nothing fancier in v1 — copy-back is predictable and works for new/deleted files. Report a per-file result; never partially apply silently.
- **Cleanup**: `discard`/`apply` removes the worktree (`git worktree remove --force`) or deletes the copy dir; a startup sweep removes copies whose run is terminal and older than `keepCopiesHours`; the project itself is only ever touched by `apply`.

## Agents

Solo agents, the Swarm lead and the Conductor are ordinary Sessions created through the plugin-facing
session controller with `cwd = copyPath`, so each gets normal DSH tools, sandbox and approvals. Messages
to them are queued prompts; interrupt is `cancel`. Feed = durable `session/event` records filtered by
session id (`assistant/message`, `tool/call`, `tool/result`, `turn/start`, `turn/end`, and
`user/message` whose source is `{kind:'agent-message'}` → `peer`).

Swarm members are continuable subagents of the lead Session (`ctx.subagents.startActivation({provider:'spawn', parent: leadAgent, delivery:'caller', cwd: copyPath})`), so the whole team lives in ONE agent tree: `send_message`/`list_agents` reach every member, and a message one agent writes arrives in the other's conversation as a real turn. Two transport details follow from the host's fencing rules:

- The session controller refuses to prompt or cancel a Session whose `session.header.origin === 'subagent'` (`session "<id>" is owned by subagent routing`). Member turns therefore go through `ctx.subagents.prompt({childSessionId, delivery:'queue', content})`, which is the user-attributed path the Web UI itself uses; interrupts go through `ctx.subagents.interrupt(childSessionId, {kind:'user'})`.
- A local child settles and disposes its activation after each turn and is cold-resumed by the next delivery. During that closing window `subagents.prompt` fails with `subagent/delivery-unavailable`; the driver retries the same prompt with backoff (8 attempts, 40ms→1200ms). This requires the lead Session to stay live for the lifetime of the run.

`delivery:'caller'` keeps member completions out of the lead's model context (the engine learns turn ends from Session events instead). The run page offers "open conversation" for solo agents and the lead only; members have no separate chat.

Conductor runs use the same machinery with a lead that stays for the whole run: the conductor is the ordinary Session (`driver.createAgent`, address `conductor`) and the workers are its subagent children (`driver.spawnMember`, one address per worker), so the team lives in ONE agent tree and `send_message`/`list_agents` work across it. Before a Conductor run creates its copy, the driver checks `supportsPeers()`; a profile without the subagent stack is refused with `artel/peers-required` — unlike Swarm, Conductor has no independent-session fallback.

Fusion runs are five ordinary Sessions and need no subagent stack. The engine creates all five up front with `driver.createAgent` — so the panel, the judge and the implementer can be routed before their first turn — but prompts only the panel. The panel and the judge are created with `sandboxMode: 'read-only'`: the driver writes a `sandbox/mode` event that pins that Session, and because the driver also sets the approval policy to `never`, no escalation is possible, so a panel or judge model physically cannot edit the copy. The implementer keeps the chat session's inherited mode. The five sessions appear in the sidebar as separate chats; they stay inert after their turns.

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

## Package layout (no build step)

```
dsh-artel/
  package.json            # dsh.bundle.patch, dsh.client{platform:'web',inject:[...]}, exports './client', './locale/*.json', './icon'
  cordis.patch.yml        # - insert: [{ id: dsh-artel, name: dsh-artel }]
  lib/index.js            # Host half, plain ESM, export const inject, Config, apply(ctx, config)
  lib/client.js           # window.__ModuleLoader__.load({ id:'dsh-artel', factory(require){...} })
  lib/*.js                # host modules: run-store.js copy.js diff.js models.js conductor.js fusion.js routes.js host-driver.js engine.js
  locale/{en,ru,zh}.json  # meta.title/meta.description + strings
  icon.svg
  README.md, LICENSE
  docs/guide.md           # meta.detail
test/                     # node:test unit tests for pure logic
```

Server code is plain ESM JavaScript (no TS) so nothing has to be compiled; the client half is hand-written `React.createElement` (no JSX) inside the loader factory.

## Config (schemastery)

`copyRoot` (default `<DSH_HOME>/artel/copies`), `swarmAgentCount` (3, 2..8; a Conductor run starts one conductor on top, so `1 + this` agents), `maxRunsPerSession` (10), `keepCopiesHours` (72), `diffContext` (3), `idleGraceMs` (1200, how long a potential peer message may still be in flight before the run is called idle), `excludeGlobs` for non-git copies. No behavior-changing defaults that surprise.

## Milestones

1. **M1 skeleton**: package installs, Artel tab appears in the guide page and opens, page renders empty state + locale + icon. No agents yet.
2. **M2 Solo**: copy creation, agent start, live feed, message, interrupt, finish detection.
3. **M3 Review**: changes list + per-file diff + apply (with conflict guard) + discard + cleanup.
4. **M4 Swarm**: 3 agents, planning turn, ownership map, go-ahead, combined diff, collision notices.
5. **M5 Ship**: ru/zh strings, README + guide doc, unit tests, restart safety, `dshmarket` packaging notes, install + end-to-end verification in the running GUI.
6. **M6 Conductor**: one conductor + N workers, share proposal/approval, peer Q&A through the conductor, failure handover, whole-copy review with checks, two-round rework cap, accepted work waiting for the user's Apply.
7. **M7 Fusion**: three independent panel answers, a judge merge with a disputes count, one implementer; read-only panel and judge; five route pickers in the hero form; panelist/judge failure handling; the merged decision as a plan card; accepted work still waiting for the user's Apply.
