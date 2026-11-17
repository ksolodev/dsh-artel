# dsh-artel — architecture (working plan)

Status: v0.1 shipped. This is the design and implementation plan, kept for contributors. Where it
describes an earlier iteration and differs from the shipped code — for example, run copies are plain
directory copies (not git worktrees) and run state lives under `<DSH_HOME>/artel/<profile>` — the
README and the source are authoritative.

## What it is

A DSH bundle plugin (`dsh-artel`) that turns "develop this in my project" into a managed run:

- **Solo** — 1 agent, its own copy of the project, works end to end. Live feed, user can message it mid-run, only the user's Apply button changes the real project.
- **Swarm** — 3 agents, ONE shared copy and ONE agent tree (the first agent is the tree root, the other two are its continuable subagents), so they can really message each other with the standard team tools. First turn is planning/ownership only (no edits), then parallel work in disjoint file areas. One combined diff, one Apply.

The real project is never written by an agent: agents run with cwd = copy. Apply is a user action, in our UI.

## Entry point / surface

- Right-sidebar **tab type** (session-scoped): `id: 'dsh-artel'`, `kind: 'artel'`, claimed via a `dsh-resource://artel/...` address, registered with `ctx.sidebarRightTabs.register` + keyed `sidebar.right.pane.tab` body + `sidebar.right.pane.tab.title`.
- Guide entry (`guide: { order, title(), description(), icon? }`) so it is discoverable from the right sidebar's guide page.
- Optionally also reachable from our own conversation-side button later; commands are a stretch goal.
- The tab is opened by the user (`ctx.sidebarRight.openTab`/`openResource`) and can be widened/fullscreened via the sidebar controls; the page is laid out to work at ~420px wide and at fullscreen.

Because the tab is session-scoped, "the project" = the current session's working directory. No project picker in v1.

## UX

### Empty state
Title, one-sentence explanation, mode picker (Solo / Swarm with 1 line each), task textarea ("Write the task as you would to a colleague"), Start button. Below: previous runs for this session.

### Run page (both modes)
- Header: mode chip, status chip (`preparing`, `planning`, `running`, `waiting for you`, `done`, `failed`, `applied`, `discarded`), project path, "open conversation" per agent.
- **Feed**: append-only lines — agent messages, tool calls (one line each: name + target), user messages, status changes. Incremental polling with a cursor. For swarm, each line is prefixed by the agent's name/color.
- **Composer**: message box that sends to the run (solo: the agent; swarm: broadcast or per-agent selector). "Leave a remark" is the same box — it wakes a finished solo agent too.
- **Changes**: file list with +N/−M, expandable per-file unified diff, colored with theme tokens. Refresh button. Empty state "no changes yet" (this is also the swarm phase-1 state).
- **Actions**: `Apply changes` (primary, asks for confirmation, applies all or selected files), `Discard run` (destructive, confirm). Apply only enabled when there are changes and the run is not running.
- **Agents** (swarm): 3 rows with name, claimed files, state; collisions flagged.

### Swarm turn-1 protocol (product requirement: "правок пока нет")
1. Host creates one copy, creates the team (see **Agents** below), prompts all three with: project description, the task, and the ownership protocol — *"This is turn 1. Do not create, edit or delete any file. You can message the other agents; end your turn with one OWNERSHIP line."*
2. Host waits for all three turns to end, collects claims from the agents' messages/plans, resolves overlaps (host assigns contested paths to the first claimant, tells the loser to re-claim inside the first message), then sends all three the go-ahead prompt containing the final ownership map: *"Work now. Your files: … . Do not write outside them. Message the owner instead. Read the copy as the others write. Report when done."*
3. Host tracks feeds; on `turn/end` for all three, status = `waiting for you`, compute combined diff of the shared copy.
4. Collisions that happen despite the map are shown in the feed (`edited outside assigned area`) by matching tool calls' file paths against the map — no hard blocking in v1.

## Data model

Persisted at `<DSH_HOME>/artel/runs.json` (atomic write, written on every transition; not the source of truth for conversation content — only run bookkeeping, which is allowed by the practices rules since we cannot append custom session events).

```ts
type Mode = 'solo' | 'swarm'
type RunStatus = 'preparing' | 'planning' | 'running' | 'waiting' | 'finished' | 'failed' | 'applied' | 'discarded'

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
  status: 'idle' | 'running' | 'done' | 'failed'
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

Feed events are kept in memory + appended to `<DSH_HOME>/artel/runs/<id>.jsonl` (capped, rotated at ~2 MB) so a reload/GUI restart still shows history. Live stream can be re-read by cursor.

## Host ⇄ client protocol

Chosen transport: **plugin HTTP routes** (`ctx.webServer`) + `fetch` from the tab body, the pattern already proven by `dsh-config-manager` in this profile. (Typert Remote is the alternative; revisit only if routes turn out to be restricted.)

All routes under `/api/dsh-artel/**`, JSON, same-origin + the connection's trust header as config-manager does it. Every route validates that `sessionId` exists and that the run belongs to it; all paths are compared after `path.resolve` containment checks.

| method | path | body/query | result |
|---|---|---|---|
| GET | `/api/dsh-artel/runs` | `sessionId` | `{ runs: RunSummary[] }` |
| POST | `/api/dsh-artel/runs` | `{ sessionId, mode, task }` | `{ run }` |
| GET | `/api/dsh-artel/runs/:id` | `sessionId`, `cursor?` | `{ run, events, cursor }` |
| POST | `/api/dsh-artel/runs/:id/message` | `{ sessionId, text, agent? }` | `{ ok }` |
| POST | `/api/dsh-artel/runs/:id/interrupt` | `{ sessionId, agent? }` | `{ ok }` |
| POST | `/api/dsh-artel/runs/:id/go` | `{ sessionId }` | `{ ok }` (swarm phase 2, auto unless locked) |
| GET | `/api/dsh-artel/runs/:id/changes` | `sessionId` | `{ files: FileChange[] }` |
| GET | `/api/dsh-artel/runs/:id/changes/file` | `sessionId`, `path` | `{ patch }` |
| POST | `/api/dsh-artel/runs/:id/apply` | `{ sessionId, paths? }` | `{ applied, skipped: {path,reason}[] }` |
| POST | `/api/dsh-artel/runs/:id/discard` | `{ sessionId }` | `{ ok }` |

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
