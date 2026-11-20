/**
 * Branch service — the app-owned git repository of one queue.
 *
 * A branch queue keeps every task version as a commit on an Artel branch
 * (`refs/heads/artel/<branchId>`), never in the user's repository. This module
 * owns the repository lifecycle, the branch records of the queue and the commit
 * listing; applying and merging branches is added on top of it.
 */

import path from 'node:path'

import { ArtelGit } from './git.js'
import { QUEUE_MODEL_BRANCHES, createBranchRecord } from './queue.js'

/** Most characters a branch name may have. */
const MAX_BRANCH_NAME = 80

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
   * The queue with its branches, the project head and the uncommitted drift.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ queue: object, project: { head: string | null, repoDir: string | null, drift: object }, currentBranchId: string | null, branches: object[] }>} branch state.
   */
  async list(sessionId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    return {
      queue,
      project: { head: queue.project?.head ?? null, repoDir: queue.project?.repoDir ?? null, drift: await this.#drift(git) },
      currentBranchId: queue.currentBranchId ?? null,
      branches: queue.branches ?? [],
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
   * Uncommitted changes of the project.
   * @param {ArtelGit} git - the app repository.
   * @returns {Promise<{ dirty: boolean, files: string[] }>} drift.
   */
  async #drift(git) {
    const entries = await git.status()
    return { dirty: entries.length > 0, files: entries.map((entry) => entry.path).slice(0, 40) }
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
