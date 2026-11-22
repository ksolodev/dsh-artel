/**
 * Branch service — the app-owned git repository of one queue.
 *
 * A branch queue keeps every task version as a commit on an Artel branch
 * (`refs/heads/artel/<branchId>`), never in the user's repository. This module
 * owns the repository lifecycle, the branch records of the queue and the commit
 * listing; applying and merging branches is added on top of it.
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { ArtelGit, GitError } from './git.js'
import { branchConflictPrompt, branchMergePrompt } from './prompts.js'
import { QUEUE_MODEL_BRANCHES, createBranchRecord } from './queue.js'

/** Most characters a branch name may have. */
const MAX_BRANCH_NAME = 80

/** How long the project's own check command may run during an apply. */
const CHECK_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Run the project's own check command in a worktree.
 *
 * The command is a user-configured shell string, so it goes through the
 * platform shell (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` elsewhere). The
 * string is handed to Node as one shell command (`shell: true`) instead of a
 * hand-built argv: Node then quotes it for the platform shell verbatim, so
 * quotes inside the command survive and the check runs exactly what the user
 * wrote (#24). The output is bounded to the last 4000 characters and a timeout
 * fails the check instead of hanging the apply.
 * @param {{ command: string, cwd: string, timeoutMs?: number }} options - command, directory and budget.
 * @returns {Promise<{ ok: boolean, output: string, skipped: boolean }>} outcome and output tail.
 */
export async function runCheckCommand({ command, cwd, timeoutMs = CHECK_TIMEOUT_MS }) {
  return await new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env })
    const finish = (ok, note = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: (output + note).slice(-4000), skipped: false })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(false, `\n[artel] check timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(false, `\n[artel] ${error.message}`))
    child.on('close', (code) => finish(code === 0))
  })
}

/**
 * Link the project's `node_modules` into a worktree, so the check command can
 * resolve dependencies without copying them.
 * @param {string} projectPath - the real project.
 * @param {string} workdir - the worktree to link into.
 * @returns {Promise<boolean>} whether a link now exists.
 */
export async function linkNodeModules(projectPath, workdir) {
  const source = path.join(projectPath, 'node_modules')
  const exists = await fsp.stat(source).catch(() => null)
  if (exists === null) return false
  const target = path.join(workdir, 'node_modules')
  const linked = await fsp.stat(target).catch(() => null)
  if (linked !== null) return true
  try {
    await fsp.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    return false
  }
}

/** A branch failure the client can explain. */
export class BranchError extends Error {
  /**
   * @param {string} message - human text.
   * @param {number} status - HTTP status.
   * @param {string} code - machine code like 'artel/branch-missing'.
   * @param {object | null} [details] - extra payload for the client.
   */
  constructor(message, status, code, details = null) {
    super(message)
    this.name = 'BranchError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The branch side of an auto-queue: repository, branches and commits. */
export class BranchService {
  #store
  #stateDir
  #engine
  #exclude
  #now
  #log

  /**
   * @param {{ store: object, stateDir: string, engine?: object | null, exclude?: string[], now?: () => number, log?: object }} options - dependencies.
   */
  constructor({ store, stateDir, engine = null, exclude = [], now = () => Date.now(), log = console }) {
    this.#store = store
    this.#stateDir = stateDir
    this.#engine = engine
    this.#exclude = Array.isArray(exclude) ? exclude : []
    this.#now = now
    this.#log = log
  }

  /** @returns {object | null} the engine used for conflict assist and run status. */
  get engine() {
    return this.#engine
  }

  /**
   * Open (creating and importing on first use) the app repository of a queue.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<ArtelGit>} the repository.
   */
  async ensure(sessionId) {
    const queue = await this.#requireQueue(sessionId)
    if (queue.project?.repoDir) {
      const opened = await ArtelGit.open({ stateDir: this.#stateDir, projectPath: queue.projectPath })
      if (opened !== null) return opened
    }

    const { git } = await ArtelGit.ensure({ stateDir: this.#stateDir, projectPath: queue.projectPath, exclude: this.#exclude })
    let head = await git.head()
    if (head === null) head = await git.importProject({ message: 'Import project' })
    const project = {
      repoDir: git.repoDir,
      head,
      importedAt: queue.project?.importedAt ?? this.#now(),
      applied: queue.project?.applied ?? null,
    }
    await this.#store.patch(sessionId, {
      model: QUEUE_MODEL_BRANCHES,
      project,
      currentBranchId: queue.currentBranchId ?? null,
      branches: Array.isArray(queue.branches) ? queue.branches : [],
    })
    return git
  }

  /**
   * The queue with its branches, the project head, the uncommitted drift and the
   * repository size.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ queue: object, project: { head: string | null, repoDir: string | null, drift: object }, currentBranchId: string | null, branches: object[], repo: { objects: number, sizeBytes: number, sizeText: string } }>} branch state.
   */
  async list(sessionId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    return {
      queue,
      project: { head: queue.project?.head ?? null, repoDir: queue.project?.repoDir ?? null, drift: await this.#drift(git) },
      currentBranchId: queue.currentBranchId ?? null,
      branches: queue.branches ?? [],
      repo: await git.countObjects(),
    }
  }

  /**
   * One branch record of a queue.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} branch record.
   */
  async getBranch(sessionId, branchId) {
    const queue = await this.#requireQueue(sessionId)
    return this.#branch(queue, branchId)
  }

  /**
   * Export a branch ref into the project's own git repository.
   *
   * The export only writes `refs/heads/artel/*`, never touches the user's HEAD
   * or work tree, and is refused when it would not fast-forward. A successful
   * export is recorded on the branch record.
   * @param {string} sessionId - chat session id.
   * @param {{ branchId?: string, target?: string | null }} [input] - branch and optional target ref.
   * @returns {Promise<{ queue: object, exported: { target: string, commit: string, at: number } }>} branch state and the export record.
   */
  async exportBranch(sessionId, { branchId, target = null } = {}) {
    const git = await this.ensure(sessionId)
    const branch = await this.getBranch(sessionId, branchId)
    const targetRef = typeof target === 'string' && target.trim() !== '' ? target.trim() : `refs/heads/artel/${branch.id}`
    let exported
    try {
      exported = await git.exportRefToUserRepo({ sourceRef: branch.ref, targetRef })
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      const statuses = {
        'artel/not-a-git-project': 409,
        'artel/export-exists': 409,
        'artel/export-missing': 409,
        'artel/bad-request': 400,
      }
      throw new BranchError(error.message, statuses[error.code] ?? 500, error.code, { code: error.code })
    }

    const at = this.#now()
    const queue = await this.#requireQueue(sessionId)
    const branches = (queue.branches ?? []).map((entry) =>
      entry.id === branch.id ? { ...entry, exported: { target: exported.target, at }, updatedAt: at } : entry,
    )
    await this.#store.patch(sessionId, { branches })
    return {
      queue: await this.#requireQueue(sessionId),
      exported: { target: exported.target, commit: exported.commit, at },
    }
  }

  /**
   * The current project head and its uncommitted changes.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ head: string | null, branchId: string | null, drift: { dirty: boolean, files: string[] } }>} project state.
   */
  async projectState(sessionId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    return { head: queue.project?.head ?? null, branchId: queue.currentBranchId ?? null, drift: await this.#drift(git) }
  }

  /**
   * Create a branch ref at a commit and (by default) select it.
   * @param {string} sessionId - chat session id.
   * @param {{ name?: string, fromCommit?: string | null, switchTo?: boolean }} [input] - branch options.
   * @returns {Promise<{ branch: object, queue: object, project: object, currentBranchId: string | null, branches: object[] }>} branch state with the new branch.
   */
  async createBranch(sessionId, { name = '', fromCommit = null, switchTo = true } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const base = fromCommit ?? queue.project?.head ?? null
    if (base === null) throw new BranchError('The project has no imported commit yet.', 409, 'artel/no-base-commit')
    if ((await git.ref(base)) === null) throw new BranchError(`Unknown commit ${base}.`, 400, 'artel/bad-request', { commit: base })

    const branches = queue.branches ?? []
    const record = createBranchRecord({ name: this.#branchName(name, branches.length + 1), baseCommit: base, now: this.#now() })
    await git.updateRef(record.ref, base, null)

    const patch = { branches: [...branches, record] }
    if (switchTo === true) patch.currentBranchId = record.id
    await this.#store.patch(sessionId, patch)
    return { branch: record, ...(await this.list(sessionId)) }
  }

  /**
   * Rename a branch of the queue.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @param {string} name - new name.
   * @returns {Promise<object>} branch state.
   */
  async renameBranch(sessionId, branchId, name) {
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    const nextName = this.#branchName(name, 1)
    const branches = (queue.branches ?? []).map((entry) =>
      entry.id === branch.id ? { ...entry, name: nextName, updatedAt: this.#now() } : entry,
    )
    await this.#store.patch(sessionId, { branches })
    return this.list(sessionId)
  }

  /**
   * Select the branch new tasks go to.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} branch state.
   */
  async switchBranch(sessionId, branchId) {
    const queue = await this.#requireQueue(sessionId)
    this.#branch(queue, branchId)
    await this.#store.patch(sessionId, { currentBranchId: branchId })
    return this.list(sessionId)
  }

  /**
   * Delete a branch that is neither applied nor has queued or running tasks.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} branch state.
   */
  async removeBranch(sessionId, branchId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    if (queue.project?.applied?.branchId === branch.id) {
      throw new BranchError('This branch is already applied to the project.', 409, 'artel/branch-applied')
    }
    if (branch.tipCommit !== null && queue.project?.head === branch.tipCommit) {
      throw new BranchError('This branch is already applied to the project.', 409, 'artel/branch-applied')
    }
    const busy = (queue.tasks ?? []).some(
      (task) => task.branchId === branch.id && (task.status === 'queued' || task.status === 'running'),
    )
    if (busy) throw new BranchError('The branch still has queued or running tasks.', 409, 'artel/branch-busy')

    await git.deleteRef(branch.ref)
    const branches = (queue.branches ?? []).filter((entry) => entry.id !== branch.id)
    const currentBranchId = queue.currentBranchId === branch.id ? (branches[0]?.id ?? null) : (queue.currentBranchId ?? null)
    await this.#store.patch(sessionId, { branches, currentBranchId })
    await git.gcAuto().catch(() => {})
    return this.list(sessionId)
  }

  /**
   * The commits of a branch, newest first.
   *
   * Only the commits the branch added over its base are listed: the imported
   * project commit is shared by every branch and is not a branch version.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @param {{ max?: number }} [options] - page size.
   * @returns {Promise<{ commit: string, parents: string[], subject: string, date: string, files: string[], changeCount: number }[]>} commit cards, newest first.
   */
  async commits(sessionId, branchId, { max = 200 } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
    if (limit === 0) return []
    const tip = branch.tipCommit ?? (await git.ref(branch.ref))
    if (tip === null) return []
    const own = await git.revList({ from: branch.baseCommit, to: tip })
    if (own.length === 0) return []
    const recent = own.slice(-limit)
    const rows = await git.log(tip, { max: recent.length + 1 })
    const byCommit = new Map(rows.map((row) => [row.commit, row]))
    const commits = []
    for (const sha of [...recent].reverse()) {
      const entry = byCommit.get(sha)
      const parents = Array.isArray(entry?.parents) ? entry.parents : []
      const parent = parents.length > 0 ? parents[0] : null
      const changes = parent === null ? [] : await git.changes(parent, sha)
      commits.push({
        commit: sha,
        parents,
        subject: entry?.subject ?? '',
        date: entry?.date ?? '',
        files: changes.map((change) => change.path),
        changeCount: changes.length,
      })
    }
    return commits
  }

  /**
   * Apply selected commits of a branch to the project.
   *
   * A branch cut from the current applied head fast-forwards; a project that
   * moved on is merged with `--no-ff`; a partial selection is rebuilt with
   * cherry-picks on the current applied head. A branch whose tip is already in
   * history (after its own revert, or after a repeated apply) cannot be merged —
   * git reports «Already up to date» — so its commits are replayed on the head
   * instead; an apply that changes no files is refused rather than moving the
   * head to an empty commit. Uncommitted project changes are
   * drift: refused unless confirmed, then committed onto the applied ref. A
   * conflict goes to the engine's fixer and is reported when it cannot converge;
   * the optional check command is a gate before any write-back. The real project
   * only receives the files the apply changed, and the applied ref moves with a
   * CAS against the drift/old head.
   * @param {string} sessionId - chat session id.
   * @param {{ branchId?: string, commitIds?: string[] | null, confirmDrift?: boolean, checkCommand?: string, force?: boolean }} [input] - apply options.
   * @returns {Promise<{ queue: object, applied: object, check: object | null }>} branch state, the apply record and the check outcome.
   */
  async apply(sessionId, { branchId, commitIds = null, confirmDrift = false, checkCommand = '', force = false } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)

    const history = await git.revList({ from: branch.baseCommit, to: branch.tipCommit ?? branch.ref })
    if (history.length === 0) throw new BranchError('The branch has no commits to apply.', 409, 'artel/branch-empty')

    let selected = history
    if (Array.isArray(commitIds)) {
      const wanted = new Set(commitIds)
      const known = new Set(history)
      for (const commit of wanted) {
        if (!known.has(commit)) throw new BranchError(`Commit ${commit} is not part of branch ${branch.id}.`, 400, 'artel/bad-request', { commit })
      }
      selected = history.filter((commit) => wanted.has(commit))
      if (selected.length === 0) throw new BranchError('No commits were selected to apply.', 400, 'artel/bad-request')
    }
    const full = selected.length === history.length

    const head = queue.project?.head ?? null
    if (head === null) throw new BranchError('The project has no imported commit yet.', 409, 'artel/no-base-commit')

    let base = head
    let driftCommit = null
    const drift = await this.#drift(git)
    if (drift.dirty) {
      if (confirmDrift !== true) {
        throw new BranchError('The project has uncommitted changes. Confirm the drift to apply anyway.', 409, 'artel/project-drift', { drift })
      }
      driftCommit = await git.commitDir(queue.projectPath, { parent: head, message: 'Uncommitted project changes' })
      await git.updateRef('refs/heads/applied', driftCommit, head)
      base = driftCommit
    }

    const worktreeRoot = path.join(this.#stateDir, 'worktrees')
    const workdir = path.join(worktreeRoot, `apply-${branch.id}-${this.#now()}`)
    await fsp.mkdir(worktreeRoot, { recursive: true })
    const tip = history[history.length - 1]
    let target = null
    let contained = false
    let check = null
    try {
      if (full && branch.baseCommit === base) {
        target = tip
      } else {
        await git.worktreeAdd(workdir, base)
        // A merge cannot bring the branch changes back when its tip is already
        // in history: git reports «Already up to date», and `commit --allow-empty`
        // would move the head to a commit that touches no files. That is exactly
        // the state after a revert (and after a repeated apply), so replay the
        // branch commits as cherry-picks — a reverted apply then restores them.
        contained = full && (await git.isAncestor(tip, base))
        if (full && !contained) {
          const merged = await git.mergeInto(workdir, { source: tip, message: `Apply «${branch.name}»` })
          if (merged.conflicts.length > 0) {
            const resolved = await this.#fixConflicts({ git, queue, branch, workdir, conflicts: merged.conflicts, commit: null })
            if (!resolved) throw new BranchError(`The branch «${branch.name}» conflicts with the project.`, 409, 'artel/apply-conflict', { conflicts: merged.conflicts })
            await git.addAll(workdir)
            target = (await git.mergeContinue(workdir, { message: `Apply «${branch.name}»` })) ?? (await git.commitWorktree(workdir, { message: `Apply «${branch.name}»` }))
          } else {
            target = merged.mergeCommit
          }
        } else {
          await this.#replayCommits({ git, queue, branch, workdir, commits: selected })
          target = await git.commitWorktree(workdir, {
            message: contained ? `Re-apply «${branch.name}»` : `Apply ${selected.length} commit(s) from «${branch.name}»`,
          })
        }
      }

      if (target === null) throw new BranchError('The apply produced no commit.', 500, 'artel/apply-empty')
      const changes = await git.changes(base, target)
      // An apply that leaves every file untouched is a false «applied» state:
      // refuse it before the head moves (a repeated apply, a branch of empty
      // commits) instead of recording an apply that changed nothing.
      if (changes.length === 0) {
        throw new BranchError(
          contained ? `The branch «${branch.name}» is already applied to the project.` : `The branch «${branch.name}» adds no changes to the project.`,
          409,
          'artel/apply-unchanged',
          { branchId: branch.id, head: base },
        )
      }

      if (typeof checkCommand === 'string' && checkCommand.trim() !== '') {
        const stat = await fsp.stat(workdir).catch(() => null)
        if (stat === null) await git.worktreeAdd(workdir, target)
        await linkNodeModules(queue.projectPath, workdir)
        check = await runCheckCommand({ command: checkCommand.trim(), cwd: workdir })
        if (check.ok !== true && force !== true) {
          throw new BranchError('The check failed on the applied branch.', 409, 'artel/check-failed', { check })
        }
      }

      await this.#writeBack(queue.projectPath, git, target, changes)
      await git.updateRef('refs/heads/applied', target, base)
      await git.exec(['read-tree', 'HEAD'])

      const installNeeds = await this.#installNeeds(queue, selected)
      const applied = { branchId: branch.id, branchName: branch.name, commit: target, driftCommit, files: changes.length, at: this.#now() }
      const branches = (queue.branches ?? []).map((entry) =>
        entry.id === branch.id ? { ...entry, appliedAt: applied.at, updatedAt: applied.at, installNeeds } : entry,
      )
      const project = { ...queue.project, head: target, appliedAt: applied.at, applied }
      await this.#store.patch(sessionId, { project, branches })
      const entry = {
        id: 'ap-' + applied.at.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        branchId: branch.id,
        branchName: branch.name,
        beforeHead: base,
        afterHead: target,
        driftCommit,
        commits: selected,
        at: applied.at,
      }
      await this.#store.patch(sessionId, {
        project: { ...project, applies: [...(queue.project.applies ?? []).slice(-19), entry] },
      })
      await git.gcAuto().catch(() => {})
      await this.#markAppliedRuns(queue, selected)
      return { queue: await this.#requireQueue(sessionId), applied, check }
    } finally {
      await git.worktreeRemove(workdir).catch(() => {})
      await git.pruneWorktrees().catch(() => {})
    }
  }

  /**
   * Undo the last apply of the queue.
   *
   * The revert is a new commit on top of the current applied head whose tree is
   * the tree from before that apply, so history stays linear and nothing is
   * rewritten. Only the last apply can be reverted and only while the project
   * head still matches it; uncommitted project changes are refused.
   * @param {string} sessionId - chat session id.
   * @param {{ branchId?: string | null }} [input] - optional expected branch of the last apply.
   * @returns {Promise<{ queue: object, reverted: { branchId: string, branchName: string, commit: string, undone: string } }>} branch state and the revert record.
   */
  async revertApply(sessionId, { branchId = null } = {}) {
    const git = await this.ensure(sessionId)
    const wanted = typeof branchId === 'string' && branchId.trim() !== '' ? branchId.trim() : null
    if (wanted !== null) await this.getBranch(sessionId, wanted)

    const queue = await this.#requireQueue(sessionId)
    const applies = queue.project?.applies ?? []
    const last = applies.at(-1)
    const head = queue.project?.head ?? null
    if (!last) throw new BranchError('There is no apply to revert.', 409, 'artel/nothing-to-revert')
    if (wanted !== null && wanted !== last.branchId) {
      throw new BranchError('Only the last apply can be reverted.', 409, 'artel/revert-not-last', { head, last })
    }
    if (head !== last.afterHead) {
      throw new BranchError('The project moved on after the last apply.', 409, 'artel/revert-not-last', { head, expected: last.afterHead })
    }
    const drift = await this.#drift(git)
    if (drift.dirty) {
      throw new BranchError('The project has uncommitted changes. Commit or discard them before reverting.', 409, 'artel/project-drift', { drift })
    }

    const target = await git.commitTree(last.beforeHead, { parent: head, message: `Revert apply of «${last.branchName}»` })
    const changes = await git.changes(head, target)
    await this.#writeBack(queue.projectPath, git, target, changes)
    await git.updateRef('refs/heads/applied', target, head)
    await git.exec(['read-tree', 'HEAD'])

    const at = this.#now()
    const branches = (queue.branches ?? []).map((entry) =>
      entry.id === last.branchId ? { ...entry, appliedAt: null, revertedAt: at, updatedAt: at } : entry,
    )
    const project = {
      ...queue.project,
      head: target,
      appliedAt: at,
      applied: null,
      applies: applies.slice(0, -1),
      reverted: { ...last, revertedAt: at, revertCommit: target },
    }
    await this.#store.patch(sessionId, { project, branches })
    await git.gcAuto().catch(() => {})
    return {
      queue: await this.#requireQueue(sessionId),
      reverted: { branchId: last.branchId, branchName: last.branchName, commit: target, undone: last.afterHead },
    }
  }

  /**
   * Merge one queue branch into another.
   *
   * The merge happens in a detached worktree at the target tip, so neither the
   * real project nor the source branch is touched. Conflicts go to the
   * engine's fixer; an unresolved conflict is reported and the target ref stays
   * put. The optional check command is a gate before the target ref moves with a
   * CAS against its old tip.
   * @param {string} sessionId - chat session id.
   * @param {{ targetBranchId?: string, sourceBranchId?: string, checkCommand?: string, force?: boolean }} [input] - merge options.
   * @returns {Promise<{ queue: object, mergeCommit: string, check: object | null }>} branch state, the merge commit and the check outcome.
   */
  async merge(sessionId, { targetBranchId, sourceBranchId, checkCommand = '', force = false } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const target = this.#branch(queue, targetBranchId)
    const source = this.#branch(queue, sourceBranchId)
    if (target.id === source.id) throw new BranchError('A branch cannot be merged into itself.', 400, 'artel/bad-request')

    const targetTip = await git.ref(target.ref)
    const sourceTip = await git.ref(source.ref)
    if (targetTip === null) throw new BranchError(`Branch «${target.name}» has no base commit.`, 409, 'artel/no-base-commit')
    if (sourceTip === null || sourceTip === source.baseCommit) {
      throw new BranchError(`Branch «${source.name}» has no commits to merge.`, 409, 'artel/branch-empty')
    }

    const worktreeRoot = path.join(this.#stateDir, 'worktrees')
    const workdir = path.join(worktreeRoot, `merge-${target.id}-${this.#now()}`)
    await fsp.mkdir(worktreeRoot, { recursive: true })
    let check = null
    try {
      await git.worktreeAdd(workdir, targetTip)
      const merged = await git.mergeInto(workdir, { source: sourceTip, message: `Merge «${source.name}» into «${target.name}»` })
      let mergeCommit = merged.mergeCommit
      if (merged.conflicts.length > 0) {
        const resolved = await this.#fixConflicts({ git, queue, branch: source, workdir, conflicts: merged.conflicts, commit: null })
        if (!resolved) {
          throw new BranchError(`«${source.name}» conflicts with «${target.name}».`, 409, 'artel/merge-conflict', {
            conflicts: merged.conflicts,
            sourceBranchId: source.id,
            targetBranchId: target.id,
          })
        }
        await git.addAll(workdir)
        mergeCommit =
          (await git.mergeContinue(workdir, { message: `Merge «${source.name}» into «${target.name}»` })) ??
          (await git.commitWorktree(workdir, { message: `Merge «${source.name}» into «${target.name}»` }))
      }
      // A merge that changes no files is a false success: git answers «Already
      // up to date» when the source tip is an ancestor of the target tip and
      // still hands back a commit. Refuse it instead of moving the target ref.
      const mergedChanges = await git.changes(targetTip, mergeCommit)
      if (mergedChanges.length === 0) {
        throw new BranchError(`Nothing to merge: «${source.name}» adds no changes to «${target.name}».`, 409, 'artel/merge-unchanged', {
          sourceBranchId: source.id,
          targetBranchId: target.id,
        })
      }
      if (typeof checkCommand === 'string' && checkCommand.trim() !== '') {
        await linkNodeModules(queue.projectPath, workdir)
        check = await runCheckCommand({ command: checkCommand.trim(), cwd: workdir })
        if (check.ok !== true && force !== true) {
          throw new BranchError('The check failed on the merged branch.', 409, 'artel/check-failed', { check })
        }
      }

      await git.updateRef(target.ref, mergeCommit, targetTip)
      const branches = (queue.branches ?? []).map((entry) =>
        entry.id === target.id ? { ...entry, tipCommit: mergeCommit, updatedAt: this.#now() } : entry,
      )
      await this.#store.patch(sessionId, { branches })
      await git.gcAuto().catch(() => {})
      return { queue: await this.#requireQueue(sessionId), mergeCommit, check }
    } finally {
      await git.worktreeRemove(workdir).catch(() => {})
      await git.pruneWorktrees().catch(() => {})
    }
  }

  /**
   * Compact the app repository and remove stale worktree registrations.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ before: { objects: number, sizeBytes: number, sizeText: string }, after: { objects: number, sizeBytes: number, sizeText: string }, freedBytes: number }>} repository accounting before and after.
   */
  async maintenance(sessionId) {
    const git = await this.ensure(sessionId)
    const before = await git.countObjects()
    await git.gc({ pruneNow: true })
    await git.pruneWorktrees()
    const after = await git.countObjects()
    return { before, after, freedBytes: Math.max(0, before.sizeBytes - after.sizeBytes) }
  }

  /**
   * Uncommitted changes of the project.
   * @param {ArtelGit} git - the app repository.
   * @returns {Promise<{ dirty: boolean, files: string[] }>} drift.
   */
  async #drift(git) {
    const entries = await git.status()
    return { dirty: entries.length > 0, files: entries.map((entry) => entry.path).slice(0, 40) }
  }

  /**
   * Copy the files a target commit changed into the real project.
   * @param {string} projectPath - the real project.
   * @param {ArtelGit} git - the app repository.
   * @param {string} target - commit applied to the project.
   * @param {{ path: string, status: string }[]} changes - files changed between the old and new applied head.
   * @returns {Promise<void>} completes when every file is written or removed.
   */
  async #writeBack(projectPath, git, target, changes) {
    for (const change of changes) {
      const full = path.join(projectPath, change.path)
      if (change.status === 'deleted') {
        await fsp.rm(full, { force: true })
        continue
      }
      const buffer = await git.blob(target, change.path)
      if (buffer === null) continue
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, buffer)
    }
  }

  /**
   * Tell the engine which runs are applied, so their changes cards close.
   * @param {object} queue - queue record.
   * @param {string[]} selected - applied commits.
   * @returns {Promise<void>} completes when every matching run is marked.
   */
  async #markAppliedRuns(queue, selected) {
    if (!this.#engine || typeof this.#engine.markApplied !== 'function') return
    for (const task of queue.tasks ?? []) {
      if (!selected.includes(task.commit) || typeof task.runId !== 'string') continue
      try {
        await this.#engine.markApplied(task.runId)
      } catch (error) {
        this.#log?.warn?.(`artel: could not mark run ${task.runId} applied: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Refresh the install needs of the applied tip run.
   * @param {object} queue - queue record.
   * @param {string[]} selected - applied commits.
   * @returns {Promise<object | null>} install needs, or null when no run matches.
   */
  async #installNeeds(queue, selected) {
    if (!this.#engine || typeof this.#engine.refreshInstall !== 'function') return null
    const tipTask = [...(queue.tasks ?? [])].reverse().find((task) => selected.includes(task.commit) && typeof task.runId === 'string')
    if (!tipTask) return null
    try {
      return (await this.#engine.refreshInstall(tipTask.runId)) ?? null
    } catch (error) {
      this.#log?.warn?.(`artel: could not refresh install needs: ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * Replay commits onto a worktree checked out at the apply base.
   *
   * A full apply normally merges, but a branch whose tip is already in history
   * (a revert, a repeated apply) has to be replayed: a merge would report
   * «Already up to date» and change nothing.
   * @param {{ git: ArtelGit, queue: object, branch: object, workdir: string, commits: string[] }} options - replay inputs.
   * @returns {Promise<void>} completes when every commit is staged; throws on an unresolved conflict.
   */
  async #replayCommits({ git, queue, branch, workdir, commits }) {
    for (const commit of commits) {
      const picked = await git.cherryPick(workdir, commit)
      if (picked.conflicts.length === 0) continue
      const resolved = await this.#fixConflicts({ git, queue, branch, workdir, conflicts: picked.conflicts, commit })
      if (!resolved) {
        await git.quitCherryPick(workdir).catch(() => {})
        throw new BranchError(`Commit ${commit} conflicts with the project.`, 409, 'artel/apply-conflict', { conflicts: picked.conflicts, commit })
      }
      await git.addAll(workdir)
      await git.quitCherryPick(workdir).catch(() => {})
    }
  }

  /**
   * Let the engine's fixer resolve conflicts in a worktree.
   * @param {{ git: ArtelGit, queue: object, branch: object, workdir: string, conflicts: string[], commit: string | null }} options - conflict inputs.
   * @returns {Promise<boolean>} whether the conflicts are gone; false without a fixer.
   */
  async #fixConflicts({ git, queue, branch, workdir, conflicts, commit }) {
    if (!this.#engine || typeof this.#engine.assist !== 'function') return false
    const prompt = commit === null
      ? branchMergePrompt({ branchName: branch.name, conflicts })
      : branchConflictPrompt({ branchName: branch.name, commit, conflicts })
    try {
      await this.#engine.assist({
        projectPath: queue.projectPath,
        copyPath: workdir,
        title: commit === null ? `Merge «${branch.name}»` : `Rebuild «${branch.name}»`,
        prompt,
        sandboxMode: 'workspace-write',
      })
    } catch (error) {
      this.#log?.warn?.(`artel: conflict fixer failed: ${error?.message ?? error}`)
      return false
    }
    const markers = await this.#conflictMarkers(git, workdir)
    return markers.length === 0
  }

  /**
   * Paths of a worktree that still contain git conflict markers.
   * @param {ArtelGit} git - the app repository.
   * @param {string} workdir - the conflicted worktree.
   * @returns {Promise<string[]>} files with marker lines.
   */
  async #conflictMarkers(git, workdir) {
    const result = await git.exec(['grep', '-l', '-E', '^(<<<<<<<|=======|>>>>>>>)', '--', '.'], { cwd: workdir, allowNonZero: true })
    const text = result.stdout.toString('utf8').trim()
    return text === '' ? [] : text.split(/\r?\n/)
  }

  /**
   * The queue of a session; 404 when it does not exist, 409 without a project.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} queue record.
   */
  async #requireQueue(sessionId) {
    const queue = await this.#store.get(sessionId)
    if (!queue) throw new BranchError(`No auto-queue for session ${sessionId}.`, 404, 'artel/queue-missing')
    if (!queue.projectPath) throw new BranchError('The auto-queue has no project path.', 409, 'artel/no-project')
    return queue
  }

  /**
   * One branch record of a queue.
   * @param {object} queue - queue record.
   * @param {string} branchId - branch id.
   * @returns {object} branch record.
   */
  #branch(queue, branchId) {
    const branch = (queue.branches ?? []).find((entry) => entry.id === branchId)
    if (!branch) throw new BranchError(`No branch ${branchId}.`, 404, 'artel/branch-missing')
    return branch
  }

  /**
   * Normalise a branch name: trimmed, single-spaced, defaulted and length-limited.
   * @param {string} name - raw name.
   * @param {number} index - position used for the default name.
   * @returns {string} branch name.
   */
  #branchName(name, index) {
    const cleaned = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
    if (cleaned.length === 0) return `Ветка ${index}`
    if (cleaned.length > MAX_BRANCH_NAME) {
      throw new BranchError(`The branch name is longer than ${MAX_BRANCH_NAME} characters.`, 400, 'artel/bad-request')
    }
    return cleaned
  }
}
