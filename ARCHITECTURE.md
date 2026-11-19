# dsh-artel — architecture (working plan)

Status: v0.1 shipped; v0.2 (in-chat artel) is in progress on branch `feat/artel-in-chat`. This is the
design and implementation plan, kept for contributors. Where it
describes an earlier iteration and differs from the shipped code — for example, run copies are plain
directory copies (not git worktrees) and run state lives under `<DSH_HOME>/artel/<profile>` — the
README and the source are authoritative. The v0.2 UX/architecture change is specified in
`docs/artel-in-chat/DESIGN.md`.

## What it is

A DSH bundle plugin (`dsh-artel`) that turns "develop this in my project" into a managed run:

- **Solo** — 1 agent, its own copy of the project, works end to end. Live feed, user can message it mid-run, only the user's Apply button changes the real project.
- **Swarm** — 3 agents, ONE shared copy and ONE agent tree (the first agent is the tree root, the other two are its continuable subagents), so they can really message each other with the standard team tools. First turn is planning/ownership only (no edits), then parallel work in disjoint file areas. One combined diff, one Apply.

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
  («← Чат»).
- Why not a `conversation.view`: `DefaultConversationViews` renders nothing for a blank session
  (`session.blank` → `null`), so a hero/launch screen could never appear in a fresh chat; view
  activation would also need an extra, not-yet-verified API (`uiConversation.binding(id).activate`).
  The overlay has none of those constraints. See `docs/artel-in-chat/DESIGN.md`.
- The v0.1 right-sidebar tab type (`dsh-artel`/`artel`, `sidebar.right.pane.tab` body/title), its
  guide entry and the conversation-header action are removed in v0.2.

Surface layout: a left **rail** of this session's artel runs (status dot, title, meta
`Solo · 3/6 · phase`, «+ Новая артель») and a workspace — hero for a new run, run page for an
existing one. "The project" is still the current session's working directory (fallback: the
plugin's default working directory), resolved by the host (`GET /project`), no project picker.

## UX (v0.2)

### Empty state — hero for a new run
Title «Новая артель в <проект>», one-line explanation, mode picker (Solo / Swarm with 1 line each),
task textarea («Опишите задачу, как коллеге»), primary button «Поехали →». The rail below shows
previous runs of this session.

### Run page (both modes)
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
- **Agents** (swarm): rows with name, claimed files, state; collisions flagged.

### Swarm turn-1 protocol (product requirement: "правок пока нет")
1. Host creates one copy, creates the team (see **Agents** below), prompts all three with: project description, the task, and the ownership protocol — *"This is turn 1. Do not create, edit or delete any file. You can message the other agents; end your turn with one OWNERSHIP line."*
2. Host waits for all three turns to end, collects claims from the agents' messages/plans, resolves overlaps (host assigns contested paths to the first claimant, tells the loser to re-claim inside the first message), then sends all three the go-ahead prompt containing the final ownership map: *"Work now. Your files: … . Do not write outside them. Message the owner instead. Read the copy as the others write. Report when done."*
3. Host tracks feeds; on `turn/end` for all three, status = `waiting for you`, compute combined diff of the shared copy.
4. Collisions that happen despite the map are shown in the feed (`edited outside assigned area`) by matching tool calls' file paths against the map — no hard blocking in v1.

## Data model

Persisted at `<DSH_HOME>/artel/runs.json` (atomic write, written on every transition; not the source of truth for conversation content — only run bookkeeping, which is allowed by the practices rules since we cannot append custom session events).

```ts
type Mode = 'solo' | 'swarm'
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
  role: 'solo' | 'swarm'
  kind: 'session' | 'member' // ordinary Session or subagent of the swarm lead
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

## Host ⇄ client protocol

Chosen transport: **plugin HTTP routes** (`ctx.webServer`) + `fetch` from the tab body, the pattern already proven by `dsh-config-manager` in this profile. (Typert Remote is the alternative; revisit only if routes turn out to be restricted.)

All routes under `/api/dsh-artel/**`, JSON, same-origin + the connection's trust header as config-manager does it. Every route validates that `sessionId` exists and that the run belongs to it; all paths are compared after `path.resolve` containment checks.

| method | path | body/query | result |
|---|---|---|---|
| GET | `/api/dsh-artel/health` | — | `{ ok, version, ... }` |
| GET | `/api/dsh-artel/project` | `sessionId` | `{ projectPath, name }` (`projectPath: null` when unresolved) |
| GET | `/api/dsh-artel/runs` | `sessionId` | `{ runs: RunSummary[] }` |
| POST | `/api/dsh-artel/runs` | `{ sessionId, projectPath?, mode, task }` | 201 `{ run }` |
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

Solo and the Swarm lead are ordinary Sessions created through the plugin-facing session controller with `cwd = copyPath`, so each gets normal DSH tools, sandbox and approvals. Messages to them are queued prompts; interrupt is `cancel`. Feed = durable `session/event` records filtered by session id (`assistant/message`, `tool/call`, `tool/result`, `turn/start`, `turn/end`, and `user/message` whose source is `{kind:'agent-message'}` → `peer`).

Swarm members are continuable subagents of the lead Session (`ctx.subagents.startActivation({provider:'spawn', parent: leadAgent, delivery:'caller', cwd: copyPath})`), so the whole team lives in ONE agent tree: `send_message`/`list_agents` reach every member, and a message one agent writes arrives in the other's conversation as a real turn. Two transport details follow from the host's fencing rules:

- The session controller refuses to prompt or cancel a Session whose `session.header.origin === 'subagent'` (`session "<id>" is owned by subagent routing`). Member turns therefore go through `ctx.subagents.prompt({childSessionId, delivery:'queue', content})`, which is the user-attributed path the Web UI itself uses; interrupts go through `ctx.subagents.interrupt(childSessionId, {kind:'user'})`.
- A local child settles and disposes its activation after each turn and is cold-resumed by the next delivery. During that closing window `subagents.prompt` fails with `subagent/delivery-unavailable`; the driver retries the same prompt with backoff (8 attempts, 40ms→1200ms). This requires the lead Session to stay live for the lifetime of the run.

`delivery:'caller'` keeps member completions out of the lead's model context (the engine learns turn ends from Session events instead). The run page offers "open conversation" for solo agents and the lead only; members have no separate chat.

## Package layout (no build step)

```
dsh-artel/
  package.json            # dsh.bundle.patch, dsh.client{platform:'web',inject:[...]}, exports './client', './locale/*.json', './icon'
  cordis.patch.yml        # - insert: [{ id: dsh-artel, name: dsh-artel }]
  lib/index.js            # Host half, plain ESM, export const inject, Config, apply(ctx, config)
  lib/client.js           # window.__ModuleLoader__.load({ id:'dsh-artel', factory(require){...} })
  lib/*.js                # host modules: runs.js copy.js diff.js agents.js routes.js
  locale/{en,ru,zh}.json  # meta.title/meta.description + strings
  icon.svg
  README.md, LICENSE
  docs/guide.md           # meta.detail
test/                     # node:test unit tests for pure logic
```

Server code is plain ESM JavaScript (no TS) so nothing has to be compiled; the client half is hand-written `React.createElement` (no JSX) inside the loader factory.

## Config (schemastery)

`copyRoot` (default `<DSH_HOME>/artel/copies`), `swarmAgentCount` (3, 2..8), `maxRunsPerSession` (10), `keepCopiesHours` (72), `diffContext` (3), `idleGraceMs` (1200, how long a potential peer message may still be in flight before the run is called idle), `excludeGlobs` for non-git copies. No behavior-changing defaults that surprise.

## Milestones

1. **M1 skeleton**: package installs, Artel tab appears in the guide page and opens, page renders empty state + locale + icon. No agents yet.
2. **M2 Solo**: copy creation, agent start, live feed, message, interrupt, finish detection.
3. **M3 Review**: changes list + per-file diff + apply (with conflict guard) + discard + cleanup.
4. **M4 Swarm**: 3 agents, planning turn, ownership map, go-ahead, combined diff, collision notices.
5. **M5 Ship**: ru/zh strings, README + guide doc, unit tests, restart safety, `dshmarket` packaging notes, install + end-to-end verification in the running GUI.
