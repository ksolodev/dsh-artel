# 0.13.0 — export, revert, maintenance and per-task branches

## Goal

Finish the auto-queue branch model: export a queue branch into the user's own git
repository (opt-in), revert the last applied branch, add repository maintenance, let a
single task pick its branch, add «Доработать с этого результата» and polish the branch
graph. Ship as 0.13.0 on top of 0.12.1.

## Architecture

The 0.12.x model stays: the app owns a git repository per project, one queue branch is a
git branch, one task is one commit, apply/merge run in detached worktrees. 0.13.0 only
adds commands on top of it:

- **Export** runs one `git fetch` from the app repository into the user's checkout, into
  `refs/heads/artel/<id>` only; it never touches the user work tree or HEAD.
- **Revert** appends a new commit whose tree is the previous applied state and writes the
  inverse diff back; apply history is recorded in `queue.project.applies`.
- **Maintenance** wraps `git count-objects -v`, `git gc` and `git gc --auto`.
- **Per-task branch** is an add-time `branchId` on the task record.
- **Rework from result** creates a branch whose base is the applied project head.
- **Graph polish** is a glyph column and base/tip shas in the branch modal.

## Tech Stack

Node ESM >= 22.19, no new dependencies, the `git` CLI already gated at >= 2.30.0,
`node --test`, the existing client (React.createElement, inline dictionaries).

## Spec

`docs/superpowers/specs/2026-11-21-autoqueue-git-branches-design.md` — sections 16.1–16.7.

For agentic workers: read this whole plan and the spec sections it names before touching
code. Implement one task at a time, in order. Every task is TDD: write the failing test,
run it, implement, run it again, run the full suite, then commit only the task's files.
Never run `git add -A` (the tree may contain another agent's work). Never reset, stash or
checkout other people's files. Windows/PowerShell shell; `node --test test/<file>`.

## Global Constraints

- git >= 2.30.0; all git calls go through `lib/git.js` (`ArtelGit`), never `child_process`
  in `lib/branches.js` or `lib/queue-runner.js`.
- The app never creates or modifies `.git` inside the user project; export only writes a
  ref in the user's existing repository.
- Export targets are restricted to `refs/heads/artel/*`; no forced ref updates.
- Revert is append-only: new commits, compare-and-swap on `refs/heads/applied`, history is
  never rewritten.
- Status/code pairs are the API contract: `artel/not-a-git-project`, `artel/export-exists`,
  `artel/export-failed`, `artel/nothing-to-revert`, `artel/revert-not-last`,
  `artel/project-drift`, `artel/branch-missing`, `artel/git-missing`.
- Client dictionaries live inline in `lib/client.js` (en/ru/zh) and the dictionary-count
  assertions in `test/client.test.js` must be updated with the count the test reports.
- Keep legacy 0.10 queue behavior: `#usesBranches(queue)` gates every branch feature.
- No placeholders, no TODO, no dead code.

## File Structure

- Create: `test/git-export.test.js` (Task 1 helpers), `test/branches-013.test.js`
  (Task 2 export/revert/maintenance), `docs/…` already exists.
- Modify: `lib/git.js`, `lib/branches.js`, `lib/queue-runner.js`, `lib/routes.js`,
  `lib/client.js`, `test/git.test.js`, `test/branches.test.js`, `test/queue-branches.test.js`,
  `test/routes.test.js`, `test/client.test.js`, `package.json`, `lib/index.js`,
  `CHANGELOG.md`, `ARCHITECTURE.md`, `README.md`, `docs/guide*.md`.
- Tests for new git helpers may live in `test/git.test.js`; prefer extending it over a new
  file to keep the suite compact (the File Structure note above is advisory).

## Tasks

### Task 1: git — export into the user repository, tree commits, object accounting

**Files:** Modify `lib/git.js`; Test `test/git.test.js`.

**Interfaces (add to `class ArtelGit`):**

- `async userRepoRoot()` → `string | null`.
  Runs `git -C <this.projectPath> rev-parse --show-toplevel` with `cwd: this.projectPath,
  allowNonZero: true`; returns the trimmed absolute path, or `null` when the project is not
  inside a git work tree. Must not create anything.
- `async exportRefToUserRepo({ sourceRef, targetRef })` → `{ target, commit }`.
  - `targetRef` must match `^refs\/heads\/artel\/[A-Za-z0-9._/-]+$` and must not contain
    `..` or end in `.lock`; otherwise `GitError` `artel/bad-request`.
  - `userRepoRoot()` null → `GitError` code `artel/not-a-git-project`.
  - `commit = await this.ref(sourceRef)`; null → `GitError` code `artel/export-missing`.
  - Run `git -C <projectPath> fetch --no-tags --no-write-fetch-head <this.repoDir>
    <sourceRef>:<targetRef>` (no `+`). On failure: if `git -C <project> rev-parse --verify
    --quiet <targetRef>^{commit}` resolves → `GitError` code `artel/export-exists`;
    otherwise wrap with code `artel/export-failed`.
  - Verify the target now points at `commit`; return `{ target: targetRef, commit }`.
- `async commitTree(treeish, { parent = null, message })` → `string` sha.
  Resolve `<treeish>^{tree}`, run `commit-tree <tree> -m <message> [-p <parent>]` with the
  app env (`cwd: this.repoDir`), return the trimmed sha.
- `async countObjects()` → `{ objects, sizeBytes, sizeText }`.
  Parse `git count-objects -v` lines `count:`, `in-pack:`, `size:`, `size-pack:`
  (KiB values; missing → 0); `sizeBytes = (size + sizePack) * 1024`; `sizeText` via a small
  `formatBytes` helper (`B`, `KiB`, `MiB`, `GiB`, one decimal above KiB). Exported helper
  `formatBytes(bytes)`.
- `async gc({ pruneNow = false } = {})` → `void`; runs `git gc --quiet` plus
  `--prune=now` when asked.
- `async gcAuto()` → `void`; best effort `git gc --auto --quiet` with `allowNonZero: true`,
  errors swallowed.

**TDD steps:** add tests to `test/git.test.js`: fixture makes a project, runs `git init`,
config `user.name/user.email`, commits a file; `userRepoRoot()` equals the project path;
export from a branch tip creates `refs/heads/artel/x` in the user repo while
`git -C project rev-parse HEAD` and `git status --porcelain` stay unchanged; a second export
after a new commit fast-forwards, a conflicting target (manually moved ref) gives
`artel/export-exists`; a plain project without git gives `artel/not-a-git-project`; a
forbidden target gives `artel/bad-request`; `commitTree` creates a commit with the requested
parent and message; `countObjects().objects` is a number and `gc()` runs without throwing.
Run `node --test test/git.test.js`, then the full suite, commit.

### Task 2: BranchService — export, apply history, revert, maintenance

**Files:** Modify `lib/branches.js`; Test `test/branches.test.js`.

**Interfaces:**

- `async getBranch(sessionId, branchId)` → branch record; missing →
  `BranchError('...', 404, 'artel/branch-missing')`. Reuses `#branch`.
- `async exportBranch(sessionId, { branchId, target = null } = {})` →
  `{ queue, exported: { target, commit, at } }`.
  `ensure` → branch → `git.userRepoRoot()` null → `BranchError` 409
  `artel/not-a-git-project`; default `target = 'refs/heads/artel/' + branch.id`; call
  `git.exportRefToUserRepo({ sourceRef: branch.ref, targetRef: target })`; patch the branch
  with `exported: { target, at: this.#now() }` and `updatedAt`; return re-read queue.
  Map `GitError` codes through unchanged so the route can forward `status` (it throws with
  the same `.code`; set `.status` 409 for `export-exists`/`not-a-git-project` in the route
  layer via a small helper).
- In `apply(...)`: on success push an entry to `queue.project.applies` (max 20):
  `{ id: 'ap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
  branchId, branchName, beforeHead: base, afterHead: target, driftCommit, commits: selected,
  at: this.#now() }`; patch `project = { ...queue.project, head: target, appliedAt, applied,
  applies: [...(queue.project.applies ?? []).slice(-19), entry] }`. Call
  `git.gcAuto().catch(() => {})` after the patch (best effort).
- `async revertApply(sessionId, { branchId = null, force = false } = {})` →
  `{ queue, reverted }`.
  - `ensure`; queue; `applies = queue.project?.applies ?? []`; `last = applies.at(-1)`;
    none → 409 `artel/nothing-to-revert`.
  - `branchId` given and `last.branchId !== branchId` → 409 `artel/revert-not-last` with
    `details: { head: queue.project.head, last }`.
  - `queue.project.head !== last.afterHead` → 409 `artel/revert-not-last`.
  - drift dirty → 409 `artel/project-drift` with `details: { drift }`.
  - `target = await git.commitTree(last.beforeHead, { parent: head, message: 'Revert
    apply of «' + last.branchName + '»' })`; `changes = await git.changes(head, target)`;
    `#writeBack(queue.projectPath, git, target, changes)`; `updateRef('refs/heads/applied',
    target, head)`; `git.exec(['read-tree', 'HEAD'])`.
  - Patch branches: matching entry gets `appliedAt: null, revertedAt: at, updatedAt: at`;
    `project = { ...queue.project, head: target, appliedAt: at, applied: null,
    applies: applies.slice(0, -1), reverted: { ...last, revertedAt: at, revertCommit: target } }`;
    `gcAuto`; return `{ queue: re-read, reverted: { branchId: last.branchId, branchName:
    last.branchName, commit: target, undone: last.afterHead } }`.
- `async maintenance(sessionId)` → `{ before, after, freedBytes }`: `before =
  git.countObjects()`, `await git.gc({ pruneNow: true })`, `await git.pruneWorktrees()`,
  `after = git.countObjects()`, `freedBytes = Math.max(0, before.sizeBytes - after.sizeBytes)`.
- `list(sessionId)` gains `repo: await git.countObjects()` in the returned object.

**TDD steps:** in `test/branches.test.js` add tests: (a) export into a real user repo
(fixture project `git init` + commit), assert `refs/heads/artel/<id>` exists in the project
repo, the project work tree is unchanged, `queue.branches[i].exported.target` is recorded;
non-git project export → status 409 code `artel/not-a-git-project`; (b) apply twice via
`apply()` then `revertApply` restores the pre-second-apply content, history is append-only
(head moved with a new commit, `project.applies` shrank, `project.reverted.commit` set);
reverting the earlier branch gives `artel/revert-not-last`; reverting with a dirty project
gives `artel/project-drift`; empty history gives `artel/nothing-to-revert`; (c)
`maintenance()` returns numeric `before.objects`/`after.objects` and `freedBytes >= 0`;
(d) `getBranch` unknown id → 404 `artel/branch-missing`.
Run `node --test test/branches.test.js`, full suite, commit.

### Task 3: QueueRunner — branch per task, export/revert/maintenance delegation

**Files:** Modify `lib/queue-runner.js`; Test `test/queue-branches.test.js`.

**Interfaces:**

- `addTasks({ sessionId, projectPath = null, texts = [], task = '', mode = 'solo',
  model = null, prepend = false, basePath = null, branchId = null })`:
  in the branch path, when `typeof branchId === 'string' && branchId !== ''` use
  `branch = await this.#branches.getBranch(sessionId, branchId)` (BranchError propagates);
  otherwise keep the current/auto-create behavior. Set `record.branchId = branch.id` for
  every created task.
- New public methods, all `await this.ensureBranches(sessionId)` then delegate:
  `exportBranch(sessionId, input = {})`, `revertApply(sessionId, input = {})`,
  `maintenance(sessionId)`.
- `#event` unchanged.

**TDD steps:** in `test/queue-branches.test.js` add: create a second branch
(`runner.createBranch`), `addTasks({ ..., branchId: second.id })` puts the new task on
`second.id` while `queue.currentBranchId` stays unchanged; `branchId: 'missing'` rejects
with status 409 and code `artel/branch-missing`; delegators forward (`maintenance` returns
`before`/`after`; `exportBranch` on a fixture project with git returns `exported.target`).
Run `node --test test/queue-branches.test.js` (plus `test/queue-runner.test.js`), full
suite, commit.

### Task 4: routes — export, revert, maintenance, POST /queue branchId

**Files:** Modify `lib/routes.js`; Test `test/routes.test.js`.

**Interfaces:**

- `POST /queue` body reads `branchId` (string, non-empty) and passes it to
  `queueRunner.addTasks({ ..., branchId })`.
- Branch dispatch inside `registerQueueRoutes`: `verb === 'export'` (POST) →
  `queueRunner.exportBranch(sessionId, { branchId, target: typeof body.target === 'string'
  ? body.target : null })`; `verb === 'revert'` (POST) →
  `queueRunner.revertApply(sessionId, { branchId, force: body?.force === true })`.
- Top-level `action === 'maintenance'` (segments length 1, POST) → `requireSessionId(body)`
  → `queueRunner.maintenance(sessionId)`.
- Error mapping already forwards `error.status`/`error.code`/`error.details` through
  `fenced()`; verify `BranchError`/`GitError` reach it unchanged.

**TDD steps:** extend `test/routes.test.js`: fakeQueueRunner gains
`exportBranch/revertApply/maintenance`; POST `/queue` with `branchId` forwards it;
POST `/queue/branches/b1/export` forwards target; POST `/queue/branches/b1/revert` forwards
branchId/force; POST `/queue/maintenance` forwards sessionId; a fake error with
`status:409, code:'artel/export-exists', details:{target}` becomes a 409 JSON body with
`code` and `details.target`; wrong methods give 405. Run `node --test test/routes.test.js`,
full suite, commit.

### Task 5: client — API, store, add-row branch picker

**Files:** Modify `lib/client.js`; Test `test/client.test.js`.

**Interfaces:**

- `api` after `queueBranchMerge`:
  `queueBranchExport: (sessionId, branchId, target) => request('POST',
  '/queue/branches/' + encodeURIComponent(branchId) + '/export', { sessionId, ...(target
  ? { target } : {}) }, { timeoutMs: 120000 })`,
  `queueBranchRevert: (sessionId, branchId) => request('POST', '.../revert',
  { sessionId }, { timeoutMs: 300000 })`,
  `queueMaintenance: (sessionId) => request('POST', '/queue/maintenance', { sessionId },
  { timeoutMs: 300000 })`.
- `addQueueTasks(input)` payload gains `branchId: typeof input?.branchId === 'string' &&
  input.branchId !== '' ? input.branchId : null`.
- Snapshot: `branchMaintenance: null`.
- Store methods next to the branch methods: `exportBranch(branchId, target)` → api,
  then `queuePatch(result)` when `result.queue` exists, then `loadQueueBranches()`;
  `revertBranch(branchId)` similar; `maintainBranches()` → `branchMaintenance` + reload
  branches; on error `branchError(error)` as today.
- `QueueStrip`: once, when `snap.queue?.model === 'branches'` and
  `snap.queueBranches === null` and not loading, call `store.loadQueueBranches()` (effect).
  Add local state `branchPick` (string, default '' = current). In the add row, when
  branch queue and `(snap.queueBranches?.branches ?? []).length > 1`, render a `<select
  className="dsh-artel-input dsh-artel-queue__branchPick">` with first option value '' =
  `t('queue.branchCurrent')` and the rest branch names; `add()` posts
  `{ task: text.trim(), mode, branchId: branchPick || null }` (store passes it through).

**TDD steps:** in `test/client.test.js`: store test — `addQueueTasks({ task:'x',
branchId:'b2' })` posts `branchId:'b2'`; `maintainBranches()` posts `/queue/maintenance`
and publishes `branchMaintenance`; `exportBranch('b1')`/`revertBranch('b1')` hit their
routes and reload branches. UI test — queue strip on a branch queue with two branches
(stub `GET /queue/branches`) renders the select, changes to branch B, adds a task, and the
`POST /queue` body carries `branchId: 'b2'`. Update the dictionary counts with the number
the test reports. Run `node --test test/client.test.js`, full suite, commit.

### Task 6: client — export/revert/maintenance/rework buttons and graph polish

**Files:** Modify `lib/client.js`; Test `test/client.test.js`.

**Interfaces (all inside `BranchModal`):**

- Repo footer: `state?.repo` → `t('queue.repoSize') + ': ' + state.repo.sizeText` and a
  «Почистить» button calling `store.maintainBranches()`; when
  `snap.branchMaintenance` exists show `t('queue.cleanupDone')` with freed bytes.
- Selected-branch actions row: «Экспортировать в git» button (disabled when
  `snap.queueBusy`; hides when `snap.queueProjectState?.git === false` — the store loads
  `queueProjectState` when the modal opens), a target input (default empty = automatic) and
  the exported line `t('queue.branchExported') + ': ' + selected.exported.target` when set.
- «Отменить применение» button when `selected.appliedAt` or the last apply belongs to the
  branch (`state?.project?.applied?.branchId === selected.id`), calling
  `store.revertBranch(selected.id)`.
- «Доработать с этого результата» button when `state?.project?.head`, calling
  `store.createBranch({ name: '', fromCommit: state.project.head, switchTo: true })`.
- Branch rows: a `<span className="dsh-artel-branchModal__graph">` with `●` for the current
  branch, `◇` when `branch.tipCommit === state?.project?.head`, else `│`; below the name
  show short base/tip commits (`t('queue.branchBase') + ' ' + shortCommit(...)`,
  `shortCommit` already exists).
- Error card: map `artel/export-exists`, `artel/not-a-git-project`,
  `artel/nothing-to-revert`, `artel/revert-not-last`, `artel/branch-missing` to localized
  lines; `artel/project-drift` keeps the existing apply-anyway action but for revert only
  the message (no override).
- Dictionary keys (en/ru/zh): `queue.branchExport`, `queue.branchExported`,
  `queue.branchRevert`, `queue.branchReverted`, `queue.repoSize`, `queue.cleanup`,
  `queue.cleanupDone`, `queue.reworkFromResult`, `queue.branchBase`, `queue.exportExists`,
  `queue.notGitProject`, `queue.nothingToRevert`, `queue.revertNotLast`.
- CSS next to the branch modal rules: action row, repo footer, graph glyph column, exported
  line.

**TDD steps:** in `test/client.test.js` add a branch-modal test: open the queue strip on a
branch queue, open «Все ветки», select a branch, assert the repo size line, click
«Экспортировать в git» → `POST .../export`, click «Отменить применение» →
`POST .../revert`, click «Почистить» → `POST /queue/maintenance` and the freed-bytes line,
click «Доработать с этого результата» → `POST /queue/branches` with
`fromCommit` = project head; assert glyphs/base/tip render. Update the dictionary count the
test reports. Run `node --test test/client.test.js`, full suite, commit.

### Task 7: docs and release 0.13.0

**Files:** Modify `package.json` (version 0.13.0), `lib/index.js` (`export const version`),
`lib/client.js` (`CLIENT_VERSION`), `test/client.test.js` (version assertions),
`CHANGELOG.md` (new `## [0.13.0] — 2026-11-21` section: Added — export to the user's git,
revert the last apply, maintenance/GC, per-task branch picker, rework-from-result, graph
polish; Fixed — anything found), `ARCHITECTURE.md` (queue-branches section: export/revert/
maintenance/per-task branch; routes table rows; milestones), `README.md` (auto-queue
paragraph), `docs/guide.md`, `docs/guide.ru.md`, `docs/guide.zh.md` (short export/revert
mentions).

**Steps:** bump the four version sites, write the docs, run the full suite
(`node --test test/*.test.js`) until green, commit. Do **not** tag or push and do not touch
GitHub — the lead does that after review.

## Self-review checklist

- [ ] Every new public method used by a route exists on `BranchService` and is delegated by
      `QueueRunner` (names match the plan and the client API).
- [ ] `GitError`/`BranchError` codes reach the HTTP response with `status`, `code` and
      `details` intact.
- [ ] Export never writes outside `refs/heads/artel/*` in the user's repo and never touches
      its work tree/HEAD; tests assert `git status` and `HEAD` before/after.
- [ ] Revert is append-only (no `update-ref` to older values except the CAS to the new
      revert commit) and leaves the branch/commits intact.
- [ ] Legacy queues (`#usesBranches` false) keep working: no branch calls on them.
- [ ] Dictionary counts and version assertions updated; no placeholders or TODOs.
- [ ] Full suite green; every task committed separately with scoped `git add`.
