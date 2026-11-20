# Auto-queue on a git core: per-task commits, branches and merges

- **Status:** draft for review
- **Date:** 2026-11-21
- **Baseline:** 0.10.0 (`3d3d354`)
- **Target:** 0.12.0 (core + branch merge), 0.13.0 (follow-ups)
- **Supersedes:** the 0.8.3 queue-mode guard from issue #3 (disabled Orchestrator entry in the queue picker and explicit `queue/mode-unsupported` refusals)

## 1. Summary

The auto-queue gets a version-control core: an app-owned git repository next to the
project, one commit per queued task, parallel branches, real merges, and a reviewable
apply that can rebuild a branch when the user unselects a task. The Orchestrator becomes
a normal queue mode: it starts from the branch tip tree, auto-approves its plan in the
queue, and repairs a failed check with a fixer agent on the assembled copy.

The project directory itself stays a plain directory for the app: the app writes files to
it exactly as today, and the user's own git repository (if any) is never touched. The git
core only stores trees and history; the user does not get `.git` files inside the project.

## 2. Context

The auto-queue promises that every task starts from the last successful version, so a
night shift builds on itself. In 0.8.0 the queue accepted only `solo`, `swarm`,
`conductor` and `fusion` because the Orchestrator ignored `basePath`: it hashed the real
project, copied its parts from `run.projectPath`, and assembled from `run.projectPath`.
Issue #3 asked for the fifth mode. 0.8.3 shipped a temporary guard — the picker lists the
Orchestrator as disabled with a one-line reason, and the route answers
`400 queue/mode-unsupported` instead of silently running Solo.

The owner then asked for a design that actually supports the Orchestrator in the queue.
Two decisions shaped it:

- **Per-task changes (variant B).** A cumulative "everything a night shift produced"
  diff cannot be read or fixed: the user wants every queued task to be an isolated,
  reviewable change. This replaces the current cumulative `lastVersion` model for the
  whole queue, not only for the Orchestrator.
- **A real version-control core.** Hand-rolling branches, merges, rebases and rollbacks
  over full project copies would be writing a VCS: one full copy per version, custom
  3-way merges, custom rollback. The queue therefore uses git objects and git merge
  machinery, kept in a repository the app owns.

## 3. Goals

- The Orchestrator is selectable in the auto-queue and works unattended: plan is approved
  automatically, parts and assembly start from the branch tip, a failed check is repaired
  by a fixer agent, and a task that cannot finish parks with a clear reason.
- Every queued task is one commit. Its diff is parent → commit, readable on the run page.
- Parallel branches: create, switch, rename, delete, and merge (merge commit).
- Apply a branch to the project: default all commits; unselecting a commit rebuilds the
  chain via cherry-pick. Conflicts never reach the project silently.
- Manual project edits are treated as uncommitted changes: they are merged when possible,
  shown when not.
- Storage is compact: commits are git objects (compressed, delta-friendly); only the
  directory a run edits is materialised at a time. Existing 0.10.0 queues keep working
  through a legacy mode until they are drained.

## 4. Non-goals (0.12.0)

- Exporting queue branches/commits into the user's own git repository (0.13.0).
- Reverting an already applied change (0.13.0; git history makes it possible later).
- Tracking the contents of nested git repositories or submodules (they are excluded like
  `node_modules` and documented).
- Age-based cleanup of old branches/objects (manual delete + disk warnings in 0.12.0).
- Per-task branch selection in the queue add row (the current branch is the target).
- Cross-project branches; one app repository per project directory.

## 5. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | Each queued task is one commit; diff is parent → commit | Readable per-task review; no cumulative "night" diff |
| D2 | Apply defaults to the whole branch; unselecting commits triggers a cherry-pick rebuild | Owner's hybrid choice: simple by default, controllable when needed |
| D3 | Parallel branches with merge commits; source branch is kept after merge | Owner asked for full branches; git provides the semantics |
| D4 | New tasks and the night shift target the current branch (selected in the queue panel) | Predictable unattended behaviour with several branches |
| D5 | The Orchestrator plan is auto-approved in the queue and shown in the run page | Unattended shifts cannot wait for a human; the morning review is the diff |
| D6 | A failed check spawns a fixer agent on the assembled copy (up to two attempts, then park) | The Orchestrator has no idle agents after assembly; parking every failed check would move work to the morning |
| D7 | Branch graph, merge and details live in an expandable modal; the queue shows only the current branch | Owner's pick: morning work stays in the queue, branch topology does not crowd it |
| D8 | Manual project edits are uncommitted changes; they are merged, never silently overwritten | Matches how the user works; nothing is lost without showing where |
| D9 | The git core is an app-owned repository with the project as its work tree | No dependency on the project being a git repo; no `.git` in the project; the user's repo is untouched |
| D10 | Branch merge ships in 0.12.0, not later | git makes merge a small addition once branches exist |
| D11 | Two releases: 0.12.0 core + merge, 0.13.0 export/revert/polish | The core is large; the most complex UI can follow real usage |

## 6. Architecture

### 6.1 App-owned git repository

- Location: `<stateDir>/repos/<projectKey>.git` (key = hash of the canonical project
  path). One repository per project directory.
- The repository is initialised with `git init --bare`, then configured as non-bare with
  `core.worktree = <project path>`. HEAD points at `refs/heads/applied`.
- Every git invocation passes explicit `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`
  (index in the state directory) and `GIT_CONFIG_NOSYSTEM=1` with a minimal
  `GIT_CONFIG_GLOBAL`. Git discovery is never used, so a surrounding user repository is
  never found or written to.
- Config: `core.autocrlf=false`, `core.safecrlf=false`, `core.fileMode=false`,
  `core.symlinks=false`, `core.longpaths=true`, `core.hooksPath=<empty dir>`,
  `gc.auto=0`. `info/attributes` neutralises external filters: `* -text -filter -diff`.
- `info/exclude` holds the tracked-file policy: `node_modules/`, `.git/`, the configured
  `excludeGlobs`, and directories that contain a nested `.git`. Those paths are copied
  into run directories by the engine as today (node_modules is linked), but they are not
  versioned.
- Requirement: a `git` binary, version 2.30 or newer. Missing/old git gates the queue
  with `artel/git-missing` and a readable UI message; legacy queues can still be drained
  without git.
- The project directory never receives a `.git` file or `.git` directory from the app.
  A user repository inside the project keeps working normally; the app only writes files.
- All git writes are serialised by a per-project mutex owned by the queue runner: the
  pump, apply, merge and branch operations await the same lock, so `update-ref` calls and
  worktree mutations never interleave.

### 6.2 Queue data model v2

`queue.json` gains a `model: "branches"` marker and keeps `version: 1` fields that remain
meaningful (session, project, tasks, events, stats). New fields:

```js
{
  model: 'branches',
  project: {
    repoDir: '<state>/repos/<key>.git',
    head: '<sha>',                 // applied project state (app repo HEAD)
    importedAt: '<iso>',
    applied: { branchId, commit, at } | null
  },
  currentBranchId: 'b-...',
  branches: [{
    id: 'b-...',
    name: 'Починить логин',
    ref: 'refs/heads/artel/b-...',
    baseCommit: '<sha>',           // project HEAD when created, or a picked commit
    tipCommit: '<sha>',
    status: 'active' | 'archived',
    createdAt: '<iso>',
    appliedAt: null
  }],
  tasks: [{ /* existing fields */, branchId, parentCommit, commit, worktree: null }]
}
```

- A task becomes a commit: `parentCommit` is the branch tip at start, `commit` is the
  created commit. Failed/parked tasks have no `commit` and do not move the branch.
- Run records gain `branchId`, `parentCommit`, `commit`. The run id keeps working as the
  commit's UI identity.
- The app repository is the source of truth for trees; no per-version project copies are
  kept after a task commits. The directory a run edits is removed after the commit (as
  current copies are removed after apply).
- The old version bookkeeping is retired for branch-model queues: `lastVersion`,
  `ignoredVersions`, save/postpone decisions and the autopilot's pending-version preflight
  no longer exist (commits are saved automatically). The autopilot preflight keeps the
  check command, the limit and the disk check. Legacy queues keep the old behaviour until
  they are drained.
- A parked task does not pin its old base: "Повторить" starts it again from the current
  branch tip at retry time (new `parentCommit`), so the retried task includes work that
  landed after it parked.

### 6.3 Aligning git commits with the existing run flow

The engine keeps creating a run directory and driving agents exactly as today. Only the
final step changes:

1. The queue materialises the branch tip tree into the run's base directory (or reuses
   the tip commit's materialisation).
2. `engine.start` seeds from that directory (see 6.4); agents edit `run.copyPath`.
3. When the run settles and passes the check gate, the queue commits `run.copyPath` into
   the app repository:
   - temporary index: `GIT_INDEX_FILE=<state>/index-<runId>` with `--work-tree=<copyPath>`,
     `git add -A` (respects `info/exclude`), `git write-tree`,
     `git commit-tree <tree> -p <parentCommit> -m <task title>`; author
     `Artel <artel@local>`;
   - `git update-ref refs/heads/artel/<branchId> <commit> <oldTip>` (compare-and-swap);
   - store the commit on the task and run, remove the run directory.
4. Review afterwards reads trees from git: `changes()`/`fileDiff()` use `git diff-tree`
   and `git show <commit>:<path>` when a run has a `commit`; the existing diff renderer
   turns the two strings into line hunks. `git ls-tree` supplies file status/size data.

`engine.apply`, `preflightApply` and `applyChanges` stay in the code base for legacy runs
(0.10.0 queues and manual runs); branch runs never call them.

### 6.4 Seeded runs and the diff base

`engine.start` gains `isolateFromBase` (internal, set by the queue):

- Seed resolution is unchanged: `basePath` is resolved to `sourcePath`.
- With `isolateFromBase: true`, `baseHashes` is the manifest of the **seed tree**
  (`hashTree(sourcePath)`), and the run records the project manifest at start separately
  for drift reporting. `changes()` therefore returns parent → copy. `apply()` refuses
  these runs (409 `artel/branch-apply-required`); the queue applies through the branch
  pipeline.
- Without the flag, seeded runs keep today's semantics (diff against the real project),
  so manual runs and the Factory behave as before.
- The Orchestrator seeding fix applies regardless of the flag: when `basePath` is given,
  the planner reads a read-only base copy, parts copy the seed, the assembly starts from
  the seed, the conflict bundle base is the seed file, and merge validation compares
  against the seed manifest. This is the fix that issue #3 asked for.

### 6.5 Orchestrator in the queue

- `QUEUE_MODES` becomes `['solo', 'swarm', 'conductor', 'fusion', 'orchestrator']`;
  `queueModeRefusal` keeps only the unknown-mode error. The queue picker lists the
  Orchestrator enabled; the 0.8.3 disabled entry and its reason string are removed.
- The queue never passes `planApproval`, so the plan gate does not trigger: the plan is
  stored, shown in the run page, and the parts start immediately.
- The night-shift rules still ride on every turn (`autoqueue: true`).
- Check repair: `engine.message` currently refuses an Orchestrator at the `assembled`
  stage. A new engine method `repairArtifact(runId, { prompt, purpose })` is introduced:
  it creates a short-lived fixer agent on `run.copyPath` (same mode/project, sandbox as
  the run), sends the prompt, waits for the turn to finish, refreshes the change count,
  and returns the agent's summary. The queue uses it for a failed check on a finished
  Orchestrator (max two attempts, then park with the check output as the reason).
- The assembled copy is committed only after the check gate passes, so repair edits land
  in the commit.

### 6.6 Apply pipeline (branch → project)

Input: branch id, optional selected commit ids (default: all commits of the branch).

1. **Target tree.**
   - All commits selected and project clean relative to app HEAD: merge the branch tip
     into HEAD (`git merge --no-ff`) in a temporary worktree; conflicts go to the fixer.
   - Some commits unselected: rebuild (see 6.7) into a synthetic commit on the branch
     base.
   - Fast-forward when the branch base is HEAD and every commit is selected: the result
     is the tip tree (no merge commit needed); otherwise a merge commit is created.
2. **Drift.** If the project working tree differs from HEAD, copy the changed/untracked
   files into the temporary worktree as a synthetic commit before merging; conflicts go
   to the fixer. Excluded paths (`node_modules`, nested repos) are never part of drift.
3. **Check gate.** If the queue has a check command, run it in the merged worktree (with
   linked `node_modules`). Failure blocks the apply, returns the output and offers
   "apply anyway" with an explicit confirmation.
4. **Write-back.** Compute the file diff between the old HEAD and the result commit; write
   added/modified files from the worktree into the project, delete removed files, and
   update `refs/heads/applied` (HEAD) to the result commit. Files the user changed by hand
   but the merge did not touch stay untouched.
5. **Bookkeeping.** Mark the branch applied (`appliedAt`, applied commit) and the
   involved runs applied; run `detectInstallNeeds(run.projectPath)` once and store the
   result on the applied tip run. When the result is a synthetic rebuild or merge commit
   with no run of its own, store the install needs on the branch and surface them in the
   queue results card. The project install/bundle flow (`GET /runs/:id/install`, bundle,
   steps) keeps working from the run that produced the applied tip.

Nothing is written before step 4. Conflict or check failures return a 409 payload with
the file list, the involved commits and the offered actions (keep the commit, re-run a
dependent task from the new base, cancel).

### 6.7 Rebuild with unselected commits

In a temporary worktree materialised at the branch `baseCommit`:

- For each selected commit in order: `git cherry-pick -n <commit>`; on conflict, run the
  fixer agent with the conflict files and the task text; after resolution `git add -A`.
- Commit the result as a synthetic commit on top of the base (`rebuild of <branch>`), with
  the same author, and validate that no unmerged paths remain.
- The rebuilt result goes through 6.6 steps 2–5.

The original branch and its commits are not rewritten; the rebuilt result is what reaches
the project. If the user wants to keep the rebuild, the branch can be reworked from the
result (a follow-up action, not part of 0.12.0).

### 6.8 Branch merge

Source branch tip → target branch tip (target may be the current branch):

- Temporary worktree at the target tip, `git merge --no-ff <source tip>`; conflicts go
  to the fixer agent on that worktree.
- A merge commit is created with both parents; the target branch ref moves to it; the
  source branch stays.
- The merge commit is a normal branch commit: reviewable diff (against the first parent),
  included in later applies. `git log --graph` supplies the graph data.
- Rebase-style "apply commits one by one" is not a separate operation; it is the rebuild
  path (6.7) used during apply.

### 6.9 Drift detection and reporting

- `git status --porcelain --untracked-files=all` with the app repository and project work
  tree yields the uncommitted edits.
- The queue exposes a drift flag and file count; the UI shows a banner in the queue panel
  and in the branch modal. Apply merges them as described; nothing is auto-committed to
  the app repository on the user's behalf.

### 6.10 Fixer agent primitive

The queue apply/merge/check code needs an agent that edits a directory and stops. The
engine exposes `assist({ projectPath, copyPath, task, prompt, sandboxMode })`:

- creates a short-lived agent session on `copyPath` through the existing driver;
- sends one prompt (conflict files or check output + context), waits for it to go idle,
  interrupts on timeout;
- returns `{ message, changedFiles }`; no run record is created and no diff is applied.

This primitive is shared by check repair (6.5) and conflict resolution (6.6–6.8).

## 7. UI

### 7.1 Queue panel

- Current branch chip/selector at the top of the queue strip, with the applied/dirty
  state; a "Все ветки" button next to it.
- Below the add row: the current branch's commits as compact rows (task title, file and
  agent count, status), newest first; a commit row opens the run page.
- The 0.9.1 «Итоги автоочереди» results card adapts: passed entries are the current
  branch's commits; «Доработать» starts a new task from that commit; «Откатить» either
  deletes an unapplied branch or applies the branch with that commit unchecked (rebuild).
  Reverting already-applied changes stays out of 0.12.0.
- The add-task row is unchanged; the mode picker offers all five modes, Orchestrator
  enabled with no reason line.
- Drift banner when the project has uncommitted edits: "В проекте есть незафиксированные
  правки — они будут сведены при применении".

### 7.2 Branch modal

A full-size modal (expandable to the panel width/height) with:

- graph from `git log --graph --all` with commit nodes, branch labels, merge nodes,
  applied markers;
- branch cards: name, base, tip, commit count, applied state, actions (switch, apply,
  merge, rework from a commit, rename, delete, "Новая ветка");
- commit details: task title, files, per-commit diff (reuses the run diff renderer);
- the apply dialog: commit checkboxes (all checked), rebuild notice when the selection is
  partial, conflict/check-failure view with files and offered actions, progress states.

### 7.3 Run page

- Branch and parent chips; "Применить ветку" opens the apply dialog with the branch
  preselected; the per-run diff is the parent → commit diff.
- Orchestrator runs show the plan card (already present) and the fixer turns in the feed.
- Legacy runs keep the current apply button and diff.

## 8. HTTP API

All routes keep the existing prefix and local (no-auth) server model; errors keep
`{ error, code }` with `RouteError`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/queue` | extended: current branch, branches summary, commits of the current branch, drift |
| GET | `/queue/branches` | branches with base/tip/status/applied |
| POST | `/queue/branches` | create branch `{ sessionId, projectPath, name?, baseCommit? }` |
| PATCH | `/queue/branches/:id` | rename |
| DELETE | `/queue/branches/:id` | delete (confirm unapplied commits on the client) |
| POST | `/queue/branches/:id/switch` | make it the current branch |
| POST | `/queue/branches/:id/merge` | `{ sourceBranchId }` → merge commit; 409 with conflicts |
| POST | `/queue/branches/:id/apply` | `{ commitIds?, force? }` → applied result; 409 with conflicts/check output |
| GET | `/queue/branches/:id/commits` | commit list with stats |
| GET | `/queue/project-state?sessionId=<id>&projectPath=<path>` | head, applied, drift files |
| POST | `/queue` | unchanged shape; `mode: 'orchestrator'` now valid |

`GET /runs/:id` summaries gain `branchId`, `parentCommit`, `commit`.

## 9. Storage, cleanup, migration

- App repository objects live under the state directory; temporary worktrees under
  `<state>/worktrees/` and are removed after every operation and on start (`git worktree
  prune`), so a crash does not leave them behind.
- Run directories are removed after a commit; a materialisation helper recreates a branch
  tip tree when a new task starts or the modal shows diffs.
- Disk preflight uses the existing queue disk check; the warning text includes the app
  repository size (`git count-objects -vH`). No automatic object GC in 0.12.0; a manual
  "почистить" action can be added in 0.13.0.
- Delete branch: removes the ref and the queue metadata; objects stay until a later gc
  (they may still be referenced by merges).
- Migration from 0.10.0 queues (model absent):
  - no saved versions and no pending runs: initialise the app repository from the project
    (one "import" commit), create a branch from HEAD, convert queued tasks to target it;
  - a saved `lastVersion` and no pending runs: import the project, commit the saved
    version's directory as a single commit on a branch named after it (a one-time
    cumulative commit, labelled "imported 0.10 version"), then continue in v2;
  - pending unsaved versions: keep the old path in legacy mode; the queue banner asks the
    user to apply/discard them, and the model switches to v2 when they are gone.
- New sessions and projects initialise v2 on first queue use.

## 10. Error handling

| Situation | Behaviour |
|-----------|-----------|
| git missing/old | `artel/git-missing`; queue blocked with UI guidance; legacy queues drain without git |
| repo init/import fails | queue start fails with the git stderr tail; nothing in the project changes |
| worktree/materialisation fails | task parks with a reason; queue continues; temp dirs cleaned on start |
| disk full | preflight warns/stops as today, including repo + worktree needs |
| rebase/merge conflict not resolved by the fixer | nothing applied; 409 with files, commits, actions |
| check failure before apply | nothing applied; output shown; "apply anyway" requires explicit confirmation |
| app repo corruption/unreadable | surface the error, offer re-init from the project (branches lost) after a backup of `queue.json` |
| interrupt | commits already created stay; run copies removed; task parks/interrupts as today |

## 11. Testing

- **git layer unit tests:** init/config isolation (no `.git` in project, user repo
  untouched), import commit, commit a run directory, branch create/rename/delete/switch,
  materialise, diff between commits, drift detection, merge with/without conflicts,
  cherry-pick rebuild, worktree cleanup.
- **engine:** seeded isolated diff (parent base, not project), seeded cumulative diff for
  Factory/manual runs, Orchestrator seeded planner/parts/assembly/merge base, plan
  auto-start in queue, `assist` repair, interaction with the existing suite.
- **queue-runner:** first task creates the branch from HEAD, autopilot commits onto the
  current branch, failure creates no commit, next task continues from the tip, check gate
  before commit, orchestrator fixer path, disk preflight.
- **apply/merge pipeline:** clean apply, partial-selection rebuild, drift merge, conflict
  → fixer → success, conflict → 409, check failure blocks, write-back leaves unrelated
  manual edits alone, install needs detected after apply.
- **routes:** new branch/apply endpoints, orchestrator accepted by `POST /queue` (the 0.8.3
  refusal test is replaced), error codes.
- **client:** enabled Orchestrator in the picker, current-branch chip, commit list, branch
  modal graph and cards, apply dialog (all/none/partial, conflict and check states), drift
  banner, legacy banner. The 0.8.3 disabled-entry test and the dictionary counts are
  updated.
- **migration:** 0.10 queue with a saved version imports; with pending versions stays
  legacy; empty queue initialises.
- CI runs on windows-latest with the preinstalled git; a test asserts `git --version`.

## 12. Rollout

- **0.12.0:** everything in this document; version bumps (`package.json`,
  `lib/index.js`, `CLIENT_VERSION`), CHANGELOG, ARCHITECTURE, README and the three guides;
  the 0.8.3 guard is removed; issue #3 is referenced as fixed by this design.
- **0.13.0:** export a branch into the user's own git repository (opt-in), revert/undo an
  applied branch from our history, automatic object GC and performance work, graph
  polish, per-task branch selection in the add row.

## 13. Acceptance criteria

1. In the auto-queue the Orchestrator is selectable and runs unattended: plan saved, parts
   built from the branch tip, assembly committed, failed check repaired (or parked with
   the reason), and the task appears as one commit whose diff contains only its own
   change.
2. A direct `POST /queue` with `mode: 'orchestrator'` is accepted and creates an
   Orchestrator task (no 400, no silent Solo).
3. Two branches can coexist, each with its own commits; the current branch is what the
   night shift extends.
4. A branch can be merged into another branch (merge commit) and applied to the project;
   conflicts are never written silently.
5. Unselecting a commit in the apply dialog rebuilds the rest and applies the rebuilt
   result, or blocks with a conflict report and offered actions.
6. Manual project edits survive an apply unless the applied change touches the same
   files; in that case the merge result is written and reported.
7. The project directory contains no app-created `.git`, and a user repository in it is
   not modified by app git commands.
8. A 0.10.0 queue with a saved version migrates as described; pending-version queues stay
   usable in legacy mode.
9. Full suite green on node 22 and 24 on windows-latest, with new tests for every layer.

## 14. Risks and limitations

- **git dependency:** a git binary is now required for the queue. It is present on the
  supported CI and on machines that develop code; legacy queues still drain without it.
- **Exotic repositories:** nested repos/submodules are excluded, not versioned; external
  git filters/LFS attributes are neutralised by `info/attributes`, which may surprise a
  user who expects LFS in their own repo (the app does not touch their repo).
- **Large projects:** first import and per-task commit cost time and CPU; manifests for
  diffs are read from git, so review is O(changed files). The disk preflight and progress
  feed will show long imports.
- **Windows quirks:** long paths, junctions for `node_modules`, antivirus locks on worktree
  cleanup; worktree removal is retried and pruned on start.
- **Two apply paths during one release:** legacy runs keep `engine.apply`; branch runs use
  the new pipeline. The split is intentional and disappears when legacy queues are gone.

## 15. Open questions

- Minimum git version: proposed 2.30; verify against the pinned Windows CI image.
- Whether the apply check gate should default to blocking (proposed) or warn-only for
  projects with a slow check command (proposal: blocking, with an explicit "apply
  anyway").
- Whether the rebuild result should be written back to the branch as a new commit or only
  applied to the project (proposed: only applied; "rework from result" is a 0.13.0
  action).
