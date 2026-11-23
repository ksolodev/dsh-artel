/**
 * The unattended part of Автоочередь: it starts the next task when the session
 * is free, answers the first question of the agent, runs the project check,
 * parks what cannot be saved and keeps going until the queue ends by itself or
 * the user asks it to stop after the current task.
 *
 * The state lives in `queue.js`; the tasks are ordinary Artel runs started
 * through `engine.js`, so a version of the queue is a normal version: the user
 * reviews it, applies it or discards it exactly like a manual run.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { BranchService, MAX_BRANCH_NAME } from './branches.js'
import * as checkModule from './check.js'
import { autoAnswerPrompt, checkRepairPrompt } from './prompts.js'
import {
  MAX_QUEUE_TASKS,
  QUEUE_TUNING,
  classifyFailure,
  createBranchRecord,
  createTaskRecord,
  endsWithQuestion,
  isBranchQueue,
  nextQueuedTask,
  parkedBranch,
  queueSummary,
  resultsCard,
  stopReasonKey,
  stopReasonLabel,
  taskTitle,
} from './queue.js'

const FINISHED_STATUSES = new Set(['waiting', 'finished'])
const FAILED_STATUSES = new Set(['failed', 'interrupted'])

/**
 * Build an error whose HTTP status the route fence can carry to the client.
 * @param {string} message - user-facing message.
 * @param {number} status - HTTP status.
 * @param {string} code - stable error code.
 * @returns {Error} tagged error.
 */
function queueError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * Call one function of the check module defensively: the module is injected so
 * tests can swap it, and a missing helper only disables one safety net.
 * @param {string} name - exported helper name.
 * @param {...unknown} args - arguments.
 * @returns {Promise<unknown>} whatever the helper answers, or undefined.
 */
async function callCheck(name, ...args) {
  const fn = checkModule[name]
  if (typeof fn !== 'function') return undefined
  return fn(...args)
}

/**
 * The queue runner of one plugin instance. It keeps one pump per chat session
 * and at most one live queue task per session.
 */
export class QueueRunner {
  #engine
  #store
  #stateDir
  #copyRoot
  #log
  #now
  #tuning
  #branches
  #pumps = new Map()
  #active = new Map()
  #chains = new Map()
  #checks = new Map()
  #cancelled = new Set()
  #closed = false

  /**
   * @param {{
   *   engine: object,
   *   store: object,
   *   stateDir: string,
   *   copyRoot: string,
   *   log?: { warn?: Function, info?: Function },
   *   now?: () => number,
   *   tuning?: object,
   * }} options - runner dependencies.
   */
  constructor({ engine, store, stateDir, copyRoot, log = {}, now = () => Date.now(), tuning = {} }) {
    this.#engine = engine
    this.#store = store
    this.#stateDir = stateDir
    this.#copyRoot = copyRoot
    this.#log = log
    this.#now = now
    this.#tuning = { ...QUEUE_TUNING, ...tuning }
    this.#branches = new BranchService({
      store,
      stateDir,
      engine,
      exclude: Array.isArray(engine?.config?.excludeGlobs) ? engine.config.excludeGlobs : [],
      now,
      log,
    })
  }

  /**
   * Resume the queues that were running before the plugin restarted: a task
   * whose run did not survive is requeued, a task whose run is still alive is
   * adopted so its check is not lost.
   * @returns {Promise<void>} resolves when every queue is ready.
   */
  async init() {
    for (const queue of this.#store.list()) {
      if (isBranchQueue(queue)) {
        // A branch queue stored before its session had a project path has
        // nothing to open yet: ensureBranches() opens it on demand once a
        // request brings the project. Warning at startup only looked like a
        // failure while the queue was simply idle.
        const projectPath = typeof queue.projectPath === 'string' && queue.projectPath !== '' ? queue.projectPath : null
        if (projectPath !== null) {
          let exists = true
          try {
            await fs.access(projectPath)
          } catch {
            exists = false
          }
          if (!exists) {
            // A queue can outlive its project: an agent chat's queue is opened in
            // the run copy, and the copy is swept away once the run is applied.
            // A missing copy is expected, not a crash to warn about on every
            // restart; any other vanished project still deserves the warning.
            const copyRoot = path.resolve(this.#copyRoot)
            const fromCopy = path.resolve(projectPath).startsWith(copyRoot + path.sep)
            if (fromCopy) {
              this.#log?.info?.(`artel: the queue project of ${queue.sessionId} is a swept copy (${projectPath}); the queue stays idle`)
            } else {
              this.#log?.warn?.(`artel: cannot open the queue repository for ${queue.sessionId}: project ${projectPath} is missing`)
            }
          } else {
            try {
              await this.#branches.ensure(queue.sessionId)
            } catch (error) {
              this.#log?.warn?.(`artel: cannot open the queue repository for ${queue.sessionId}: ${error?.message ?? error}`)
            }
          }
        }
      } else {
        try {
          await this.#maybeUpgrade(queue.sessionId)
        } catch (error) {
          this.#log?.warn?.(`artel: cannot migrate the queue for ${queue.sessionId}: ${error?.message ?? error}`)
        }
      }
      for (const task of queue.tasks) {
        if (task.status !== 'running') continue
        let run = null
        try {
          run = task.runId === null ? null : this.#engine.getRun(task.runId)
        } catch {
          run = null
        }
        if (run !== null && ['preparing', 'planning', 'running', 'waiting'].includes(run.status)) {
          this.#active.set(queue.sessionId, {
            taskId: task.id,
            runId: run.id,
            cursor: 0,
            phase: 'run',
            fixes: task.fixes ?? 0,
            startedAt: task.startedAt ?? this.#now(),
            errorText: '',
            lastText: '',
          })
          continue
        }
        const changeCount = run?.changeCount ?? 0
        if (changeCount > 0) {
          await this.#parkTask(queue.sessionId, task.id, 'Плагин перезапустился во время задачи; частичная работа осталась в «Отложенном».', {
            interrupt: false,
            reasonKey: 'queue.reason.restarted-partial',
            reasonParams: {},
          })
        } else {
          await this.#store.updateTask(queue.sessionId, task.id, {
            status: 'queued',
            runId: null,
            reason: 'Плагин перезапустился до начала работы.',
            reasonKey: 'queue.reason.restarted-before-start',
            reasonParams: {},
          })
          await this.#event(queue.sessionId, {
            kind: 'status',
            key: 'queue.event.requeued-after-restart',
            params: { title: task.title },
            text: `Задача «${task.title}» снова в очереди: плагин перезапустился.`,
            taskId: task.id,
          })
        }
      }
      if (queue.autopilot === true && queue.stopReason === null) this.#ensurePump(queue.sessionId)
    }
  }

  /**
   * Open the git repository of a session queue, upgrading a legacy queue first
   * when its saved versions have all been reviewed.
   * @param {string} sessionId - chat session id.
   * @param {{ projectPath?: string | null }} [options] - project the session resolves to.
   * @returns {Promise<{ queue: object, git: object }>} queue record and repository.
   */
  async ensureBranches(sessionId, { projectPath = null } = {}) {
    // A queue created before the request carried a project path has no project
    // yet: store the resolved path so BranchService can open the repository.
    await this.#store.ensure(sessionId, projectPath === null ? {} : { projectPath })
    const upgraded = await this.#maybeUpgrade(sessionId)
    if (upgraded !== true && !isBranchQueue(this.#store.get(sessionId))) {
      const error = new Error('The auto-queue still runs on the old model until its saved versions are reviewed.')
      error.status = 409
      error.code = 'artel/legacy-queue'
      throw error
    }
    const git = await this.#branches.ensure(sessionId)
    return { queue: this.#store.get(sessionId), git }
  }

  /**
   * A legacy queue may switch to the branch model only when no saved run is
   * waiting for review — otherwise the 0.10 results card is still in charge.
   * @param {string} queue - queue record.
   * @returns {Promise<boolean>} true when the queue may be upgraded.
   */
  async #canUpgrade(queue) {
    if (isBranchQueue(queue)) return false
    if (queue.lastVersion?.path) return true
    const runs = await this.#engine.listRuns(queue.sessionId)
    return !(runs ?? []).some(
      (run) => run.status !== 'applied' && run.status !== 'discarded' && (run.changeCount ?? 0) > 0,
    )
  }

  /**
   * Upgrade a legacy queue in place: import the project, turn the saved 0.10
   * version into a branch commit and drop the single-version pointer.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<boolean>} true when the queue ended up on the branch model.
   */
  async #maybeUpgrade(sessionId) {
    const queue = this.#store.get(sessionId)
    if (queue === undefined || queue === null) return false
    // A queue already on the branch path has nothing left to migrate.
    if (this.#usesBranches(queue)) return true
    // A branch-model queue whose repository was never opened is handled by
    // ensureBranches() below; addTasks() keeps the 0.10 path until then.
    if (isBranchQueue(queue)) return false
    if ((await this.#canUpgrade(queue)) !== true) return false

    const legacy = queue.lastVersion
    const git = await this.#branches.ensure(sessionId)
    const fresh = this.#store.get(sessionId)
    if (legacy?.path) {
      const base = fresh.project?.head ?? (await git.head())
      const message = `Импортированная версия 0.10: ${legacy.title ?? 'версия'}`
      const commit = await git.commitDir(legacy.path, { parent: base, message })
      const name = (legacy.title ?? 'Версия 0.10').trim().slice(0, 80)
      const record = createBranchRecord({ name, baseCommit: base, tipCommit: commit, now: this.#now() })
      // The imported-version fallback name is host prose too: keep the legacy
      // `name` untouched and let the client translate the key instead.
      if (!(typeof legacy.title === 'string' && legacy.title.trim() !== '')) {
        record.nameKey = 'queue.branch.legacy'
        record.nameParams = {}
      }
      await git.updateRef(record.ref, commit, null)
      await this.#store.patch(sessionId, {
        branches: [...(fresh.branches ?? []), record],
        currentBranchId: record.id,
        lastVersion: null,
      })
    } else {
      await this.#store.patch(sessionId, { lastVersion: null })
    }
    return true
  }

  /**
   * Branch panel payload for a session queue.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} branches, current branch, project head and drift.
   */
  async branchesSummary(sessionId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.list(sessionId)
  }

  /**
   * Create a branch in the queue.
   * @param {string} sessionId - chat session id.
   * @param {{ name?: string, fromCommit?: string|null, switchTo?: boolean }} input - branch options.
   * @returns {Promise<object>} queue and branch state.
   */
  async createBranch(sessionId, input = {}, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.createBranch(sessionId, input)
  }

  /**
   * Rename a queue branch.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @param {string} name - new name.
   * @returns {Promise<object>} queue and branch state.
   */
  async renameBranch(sessionId, branchId, name, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.renameBranch(sessionId, branchId, name)
  }

  /**
   * Select the branch new tasks go to.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} queue and branch state.
   */
  async switchBranch(sessionId, branchId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.switchBranch(sessionId, branchId)
  }

  /**
   * Delete a queue branch that is not applied and has no live tasks.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} queue and branch state.
   */
  async removeBranch(sessionId, branchId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.removeBranch(sessionId, branchId)
  }

  /**
   * Commits of a queue branch, newest first.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object[]>} commit cards.
   */
  async branchCommits(sessionId, branchId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.commits(sessionId, branchId)
  }

  /**
   * Apply a branch (or a checked subset of its commits) to the project.
   * @param {string} sessionId - chat session id.
   * @param {object} input - apply options from the client.
   * @returns {Promise<object>} apply result with queue, applied commit and check.
   */
  async applyBranch(sessionId, input = {}, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.apply(sessionId, input)
  }

  /**
   * Merge one queue branch into another.
   * @param {string} sessionId - chat session id.
   * @param {object} input - merge options from the client.
   * @returns {Promise<object>} merge result with queue, merge commit and check.
   */
  async mergeBranches(sessionId, input = {}, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.merge(sessionId, input)
  }

  /**
   * Current project head and uncommitted drift for the queue panel.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} project state.
   */
  async projectState(sessionId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.projectState(sessionId)
  }

  /**
   * Export a queue branch into the project's own git repository.
   * @param {string} sessionId - chat session id.
   * @param {{ branchId?: string, target?: string | null }} [input] - branch and optional target ref.
   * @returns {Promise<object>} branch state and the export record.
   */
  async exportBranch(sessionId, input = {}, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.exportBranch(sessionId, input)
  }

  /**
   * Undo the last applied branch of the queue.
   * @param {string} sessionId - chat session id.
   * @param {{ branchId?: string | null }} [input] - optional expected branch of the last apply.
   * @returns {Promise<object>} branch state and the revert record.
   */
  async revertApply(sessionId, input = {}, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.revertApply(sessionId, input)
  }

  /**
   * Compact the queue repository and drop stale worktree registrations.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ before: object, after: object, freedBytes: number }>} repository accounting before and after.
   */
  async maintenance(sessionId, options = {}) {
    await this.ensureBranches(sessionId, options)
    return this.#branches.maintenance(sessionId)
  }

  /**
   * The queue of one session, created on first use.
   * @param {string} sessionId - chat session id.
   * @param {{ projectPath?: string | null }} options - current project.
   * @returns {Promise<object>} queue summary.
   */
  async summary(sessionId, { projectPath = null } = {}) {
    const queue = await this.#store.ensure(sessionId, { projectPath })
    return queueSummary(queue)
  }

  /**
   * Add one or more tasks to the queue.
   * @param {{
   *   sessionId: string,
   *   projectPath?: string | null,
   *   texts?: string[],
   *   task?: string,
   *   mode?: string,
   *   model?: object | null,
   *   prepend?: boolean,
   *   basePath?: string | null,
   *   branchId?: string | null,
   * }} input - tasks, optionally pinned to one queue branch.
   * @returns {Promise<{ queue: object, added: number }>} the updated queue summary.
   */
  async addTasks({ sessionId, projectPath = null, texts = [], task = '', mode = 'solo', model = null, prepend = false, basePath = null, branchId = null }) {
    const queue = await this.#store.ensure(sessionId, { projectPath })
    const list = [...(Array.isArray(texts) ? texts : []), task]
      .map((text) => String(text ?? '').trim())
      .filter((text) => text !== '')
    if (list.length === 0) return { queue: queueSummary(queue), added: 0 }
    const now = this.#now()
    await this.#maybeUpgrade(sessionId)
    const created = list.map((text) => createTaskRecord({ text, mode, model, now }))
    // A queue backed by a repository runs on the branch the user picked for the
    // task, otherwise on its current branch; a queue that is still on the 0.10
    // path (no imported project) keeps the old basePath flow.
    if (this.#usesBranches(this.#store.get(sessionId))) {
      let branch
      if (typeof branchId === 'string' && branchId !== '') {
        try {
          branch = await this.#branches.getBranch(sessionId, branchId)
        } catch (error) {
          // The branch service reports an unknown branch as a 404; adding tasks
          // to one is a conflict with the queue state the client shows (409).
          if (error?.code === 'artel/branch-missing') error.status = 409
          throw error
        }
      } else {
        // The title is cut at 120 characters, a branch name at 80. The branch is
        // generated here, so shorten it instead of refusing the whole task (#42).
        const title = created[0].title
        const name = title.length > MAX_BRANCH_NAME ? title.slice(0, MAX_BRANCH_NAME).trimEnd() : title
        branch =
          this.#currentBranch(sessionId) ??
          (await this.#branches.createBranch(sessionId, { name, switchTo: true })).branch
      }
      for (const record of created) record.branchId = branch.id
    } else {
      for (const record of created) {
        if (typeof basePath === 'string' && basePath !== '') record.basePath = basePath
      }
    }
    // Opening the repository replaces the queue record: append to the fresh one.
    const current = this.#store.get(sessionId)
    // The single-task writer in queue.js refuses task 201, so the bulk route must
    // refuse too: otherwise POST /queue bypasses MAX_QUEUE_TASKS entirely.
    if (current.tasks.length + created.length > MAX_QUEUE_TASKS) {
      throw queueError('Queue is full', 409, 'queue/full')
    }
    current.tasks = prepend ? [...created, ...current.tasks] : [...current.tasks, ...created]
    current.updatedAt = now
    await this.#store.replace(sessionId, current)
    for (const record of created) {
      await this.#event(sessionId, {
        kind: 'queued',
        key: 'queue.event.queued',
        params: { title: record.title },
        text: `В очередь: ${record.title}`,
        taskId: record.id,
      })
    }
    // The toggle is the switch: adding tasks never starts the queue by itself.
    return { queue: queueSummary(this.#store.get(sessionId)), added: created.length }
  }

  /**
   * Everything the pre-flight card needs: versions that would be lost, the check
   * command the queue would use, the task limit and the free disk space.
   * @param {string} sessionId - chat session id.
   * @param {{ projectPath?: string | null }} options - project.
   * @returns {Promise<object>} pre-flight report.
   */
  async preflight(sessionId, { projectPath = null } = {}) {
    const queue = await this.#store.ensure(sessionId, { projectPath })
    const runs = this.#engine.listRuns(sessionId)
    const ignored = new Set(queue.ignoredVersions ?? [])
    const lastRunId = queue.lastVersion?.runId ?? null
    const pendingVersions = runs
      .filter((run) => run.id !== lastRunId && !ignored.has(run.id))
      .filter((run) => (run.changeCount ?? 0) > 0)
      .filter((run) => ['waiting', 'finished', 'interrupted', 'failed'].includes(run.status))
      .map((run) => ({
        runId: run.id,
        title: taskTitle(run.task),
        status: run.status,
        changeCount: run.changeCount ?? 0,
      }))
    const suggestion = await this.#suggestCheck(queue.projectPath)
    const disk = await this.#freeBytes()
    return {
      sessionId,
      pendingVersions,
      check: {
        command: queue.checkCommand || suggestion,
        guessed: queue.checkCommand === '' && suggestion !== '',
        disabled: queue.checkDisabled === true,
      },
      limit: queue.limit,
      taskCount: queue.tasks.filter((task) => task.status === 'queued').length,
      diskBytes: disk,
      busy: runs.some((run) => ['preparing', 'planning', 'running'].includes(run.status)),
    }
  }

  /**
   * Turn «Автоочередь» on or off. Turning it on runs the pre-flight first: when
   * the user has unsaved versions, the answer carries the report instead of
   * starting, and the client shows the dialog and posts again with decisions.
   * @param {{
   *   sessionId: string,
   *   projectPath?: string | null,
   *   autopilot: boolean,
   *   limit?: number,
   *   checkCommand?: string,
   *   checkDisabled?: boolean,
   *   saveVersionRunIds?: string[],
   *   postponeVersionRunIds?: string[],
   *   decisions?: boolean,
   * }} input - toggle request.
   * @returns {Promise<{ queue: object, blocked: object | null }>} queue summary and a blocking pre-flight, if any.
   */
  async setAutopilot(input) {
    return this.#serialize(input.sessionId, () => this.#setAutopilotNow(input))
  }

  /**
   * The toggle body, run under the per-chat queue lock.
   * @param {{
   *   sessionId: string,
   *   projectPath?: string | null,
   *   autopilot: boolean,
   *   limit?: number,
   *   checkCommand?: string,
   *   checkDisabled?: boolean,
   *   saveVersionRunIds?: string[],
   *   postponeVersionRunIds?: string[],
   *   decisions?: boolean,
   * }} input - toggle request.
   * @returns {Promise<{ queue: object, blocked: object | null }>} queue summary and a blocking pre-flight, if any.
   */
  async #setAutopilotNow({
    sessionId,
    projectPath = null,
    autopilot,
    limit,
    checkCommand,
    checkDisabled,
    saveVersionRunIds = [],
    postponeVersionRunIds = [],
    decisions = false,
  }) {
    const queue = await this.#store.ensure(sessionId, { projectPath })
    if (Number.isInteger(limit) && limit >= 1) queue.limit = limit
    if (typeof checkCommand === 'string') {
      queue.checkCommand = checkCommand.trim()
      queue.checkGuessed = false
    }
    if (typeof checkDisabled === 'boolean') queue.checkDisabled = checkDisabled
    if (autopilot === true) {
      // A finished run keeps its counters for the results card. Starting a new
      // run must begin from zero, or its first `taken >= limit` check stops the
      // pump before the first task.
      if (queue.autopilot !== true) {
        queue.stats = { taken: 0, passed: 0, parked: 0, consecutiveParks: 0, startedAt: this.#now() }
      }
      const preflight = await this.preflight(sessionId, { projectPath })
      if (preflight.pendingVersions.length > 0 && decisions !== true) {
        await this.#store.replace(sessionId, queue)
        return { queue: queueSummary(this.#store.get(sessionId)), blocked: preflight }
      }
      for (const runId of saveVersionRunIds) {
        const saved = await this.saveVersion(sessionId, runId)
        if (saved.saved !== true) continue
      }
      if (postponeVersionRunIds.length > 0) {
        queue.ignoredVersions = [...new Set([...(queue.ignoredVersions ?? []), ...postponeVersionRunIds])]
      }
      queue.autopilot = true
      queue.stopReason = null
      queue.retryAt = null
      queue.stats.startedAt = queue.stats.startedAt ?? this.#now()
      await this.#store.replace(sessionId, queue)
      await this.#event(sessionId, { kind: 'status', key: 'queue.event.autopilot-on', params: {}, text: 'Автоочередь включена.' })
      this.#ensurePump(sessionId)
      return { queue: queueSummary(this.#store.get(sessionId)), blocked: null }
    }
    // Switching the toggle off finishes the current task and saves it, then the
    // queue stands: that is «Закончить после текущей».
    queue.autopilot = false
    const active = this.#active.get(sessionId)
    if (active === undefined) {
      await this.#store.replace(sessionId, queue)
      return { queue: queueSummary(await this.#finish(sessionId, 'stopped')), blocked: null }
    }
    queue.stopAfterCurrent = true
    await this.#store.replace(sessionId, queue)
    await this.#event(sessionId, { kind: 'status', key: 'queue.event.finish-after', params: {}, text: 'Очередь закончит после текущей задачи.' })
    return { queue: queueSummary(queue), blocked: null }
  }

  /**
   * Save the current changes of a run as the version the queue starts from.
   * @param {string} sessionId - chat session id.
   * @param {string} runId - run to keep as a version.
   * @returns {Promise<{ queue: object, saved: boolean }>} updated queue.
   */
  async saveVersion(sessionId, runId) {
    const queue = await this.#store.ensure(sessionId)
    let run
    try {
      run = this.#engine.getRun(runId)
    } catch {
      run = null
    }
    if (run === null) throw queueError('Run not found', 404, 'queue/unknown-run')
    if (!run.copyPath) return { queue: queueSummary(queue), saved: false }
    queue.lastVersion = { runId: run.id, path: run.copyPath, title: taskTitle(run.task), changeCount: run.changeCount ?? 0, at: this.#now() }
    queue.ignoredVersions = (queue.ignoredVersions ?? []).filter((id) => id !== run.id)
    await this.#store.replace(sessionId, queue)
    await this.#event(sessionId, {
      kind: 'version',
      key: 'queue.event.version-saved',
      params: { title: queue.lastVersion.title },
      text: `Версия сохранена: ${queue.lastVersion.title}`,
    })
    return { queue: queueSummary(this.#store.get(sessionId)), saved: true }
  }

  /**
   * Leave the changes of a run alone: the queue will not ask about them again.
   * @param {string} sessionId - chat session id.
   * @param {string} runId - run to postpone.
   * @returns {Promise<object>} updated queue summary.
   */
  async postponeVersion(sessionId, runId) {
    const queue = await this.#store.ensure(sessionId)
    let run
    try {
      run = this.#engine.getRun(runId)
    } catch {
      run = null
    }
    // Mirror saveVersion: an unknown run id is a client mistake, not a no-op.
    if (run === null) throw queueError('Run not found', 404, 'queue/unknown-run')
    queue.ignoredVersions = [...new Set([...(queue.ignoredVersions ?? []), runId])]
    await this.#store.replace(sessionId, queue)
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * «Стоп»: kill the current agent immediately, put its partial work into
   * «Отложенное» and end the queue.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} updated queue summary.
   */
  async stop(sessionId) {
    // «Стоп» must not wait for a long check or a start in flight: mark the
    // session cancelled (the pump step bails at its next await), abort the check
    // and only then serialize the final write with the pump.
    this.#cancelled.add(sessionId)
    this.#checks.get(sessionId)?.abort()
    try {
      return await this.#serialize(sessionId, () => this.#stopNow(sessionId))
    } finally {
      this.#cancelled.delete(sessionId)
    }
  }

  /**
   * The «Стоп» body, run under the per-chat queue lock.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} updated queue summary.
   */
  async #stopNow(sessionId) {
    const queue = await this.#store.ensure(sessionId)
    queue.autopilot = false
    queue.stopAfterCurrent = false
    await this.#store.replace(sessionId, queue)
    const active = this.#active.get(sessionId)
    if (active !== undefined) {
      await this.#parkTask(sessionId, active.taskId, 'Вы остановили автоочередь; частичная работа в «Отложенном».', {
        interrupt: true,
        reasonKey: 'queue.reason.stopped',
        reasonParams: {},
      })
    }
    return queueSummary(await this.#finish(sessionId, 'stopped'))
  }

  /**
   * «Закончить после текущей»: let the current task pass its check and then stop.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} updated queue summary.
   */
  async finishAfterCurrent(sessionId) {
    return this.#serialize(sessionId, () => this.#finishAfterCurrentNow(sessionId))
  }

  /**
   * The «Закончить после текущей» body, run under the per-chat queue lock.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} updated queue summary.
   */
  async #finishAfterCurrentNow(sessionId) {
    const queue = await this.#store.ensure(sessionId)
    if (this.#active.get(sessionId) === undefined) return queueSummary(await this.#finish(sessionId, 'after-current'))
    queue.stopAfterCurrent = true
    queue.autopilot = false
    await this.#store.replace(sessionId, queue)
    await this.#event(sessionId, { kind: 'status', key: 'queue.event.finish-after', params: {}, text: 'Очередь закончит после текущей задачи.' })
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * Put a parked/skipped/stopped task back into the queue.
   * @param {string} sessionId - chat session id.
   * @param {string} taskId - task id.
   * @returns {Promise<object>} updated queue summary.
   */
  async retryTask(sessionId, taskId) {
    const queue = await this.#store.ensure(sessionId)
    const task = queue.tasks.find((entry) => entry.id === taskId)
    if (task === undefined) throw queueError('Задача не найдена', 404, 'queue/unknown-task')
    if (task.status === 'running') throw queueError('Задача уже выполняется', 409, 'queue/task-running')
    // A queued task is already waiting; retrying it used to report success while
    // changing nothing. Say so instead of pretending the click worked.
    if (task.status === 'queued') throw queueError('Задача ещё не начиналась', 409, 'queue/task-not-retryable')
    await this.#store.updateTask(sessionId, taskId, {
      status: 'queued',
      reason: null,
      runId: null,
      // Keep `basePath`: a parked task is retried from its own partial copy.
      questions: 0,
      fixes: 0,
      check: null,
      finishedAt: null,
    })
    await this.#event(sessionId, { kind: 'queued', key: 'queue.event.returned', params: { title: task.title }, text: `Возвращена в очередь: ${task.title}`, taskId })
    const retried = this.#store.get(sessionId)
    if (this.#usesBranches(retried)) {
      const branch = (retried.branches ?? []).find((entry) => entry.id === task.branchId) ?? null
      if (branch !== null) {
        await this.#store.updateTask(sessionId, taskId, { parentCommit: branch.tipCommit ?? branch.baseCommit })
      }
    }
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * Remove a task that has not started yet (or whose result was seen).
   * @param {string} sessionId - chat session id.
   * @param {string} taskId - task id.
   * @returns {Promise<object>} updated queue summary.
   */
  async removeTask(sessionId, taskId) {
    const queue = await this.#store.ensure(sessionId)
    const task = queue.tasks.find((entry) => entry.id === taskId)
    if (task === undefined) throw queueError('Задача не найдена', 404, 'queue/unknown-task')
    if (task.status === 'running') throw queueError('Нельзя убрать задачу, которая уже выполняется', 409, 'queue/task-running')
    queue.tasks = queue.tasks.filter((entry) => entry.id !== taskId)
    await this.#store.replace(sessionId, queue)
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * Move a queued task up or down in the queue.
   * @param {string} sessionId - chat session id.
   * @param {string} taskId - task id.
   * @param {{ direction?: 'up' | 'down' }} options - direction.
   * @returns {Promise<object>} updated queue summary.
   */
  async moveTask(sessionId, taskId, { direction = 'up' } = {}) {
    const queue = await this.#store.ensure(sessionId)
    const index = queue.tasks.findIndex((entry) => entry.id === taskId)
    if (index < 0) throw queueError('Задача не найдена', 404, 'queue/unknown-task')
    const target = direction === 'down' ? index + 1 : index - 1
    if (target < 0 || target >= queue.tasks.length) return queueSummary(queue)
    const tasks = [...queue.tasks]
    const [task] = tasks.splice(index, 1)
    tasks.splice(target, 0, task)
    queue.tasks = tasks
    await this.#store.replace(sessionId, queue)
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * Drop finished tasks from the queue column.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} updated queue summary.
   */
  async clearFinished(sessionId) {
    const queue = await this.#store.ensure(sessionId)
    queue.tasks = queue.tasks.filter((task) => task.status === 'queued' || task.status === 'running')
    await this.#store.replace(sessionId, queue)
    return queueSummary(this.#store.get(sessionId))
  }

  /**
   * Run one queue operation after every earlier operation of the same chat.
   * The pump ticks are already serialized by `busy`; this lock also keeps the
   * user actions («Стоп», «Закончить после текущей», the toggle) from landing in
   * the middle of a pump step, where both sides would write the same task.
   * @param {string} sessionId - chat session id.
   * @param {() => Promise<unknown>} work - operation to run.
   * @returns {Promise<unknown>} whatever the operation resolves to.
   */
  #serialize(sessionId, work) {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.#chains.set(sessionId, next.then(() => {}, () => {}))
    return next
  }

  /**
   * Start (or keep) the poll pump of one session. Every tick is serialized, so a
   * slow check never overlaps the next one.
   * @param {string} sessionId - chat session id.
   * @returns {void}
   */
  #ensurePump(sessionId) {
    if (this.#closed) return
    const existing = this.#pumps.get(sessionId)
    if (existing !== undefined && existing.timer !== null) return
    const pump = existing ?? { timer: null, busy: false }
    pump.timer = setInterval(() => {
      this.#tick(sessionId).catch((error) => this.#log.warn?.(`artel: queue tick failed: ${error?.message ?? error}`))
    }, this.#tuning.pollMs)
    pump.timer.unref?.()
    this.#pumps.set(sessionId, pump)
    this.#tick(sessionId).catch((error) => this.#log.warn?.(`artel: queue tick failed: ${error?.message ?? error}`))
  }

  /**
   * Stop the pump of one session.
   * @param {string} sessionId - chat session id.
   * @returns {void}
   */
  #stopPump(sessionId) {
    const pump = this.#pumps.get(sessionId)
    if (pump === undefined) return
    if (pump.timer !== null) clearInterval(pump.timer)
    this.#pumps.delete(sessionId)
  }

  /**
   * One serialized step of the pump.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<void>} resolves when the step is done.
   */
  async #tick(sessionId) {
    if (this.#closed) return
    const pump = this.#pumps.get(sessionId)
    if (pump === undefined) return
    if (pump.busy) return
    pump.busy = true
    try {
      await this.#serialize(sessionId, () => this.#advance(sessionId))
    } finally {
      const current = this.#pumps.get(sessionId)
      if (current !== undefined) current.busy = false
    }
  }

  /**
   * Advance the queue by one visible step: start a task or move the live one.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<void>} resolves when the step is done.
   */
  async #advance(sessionId) {
    if (this.#cancelled.has(sessionId)) return
    const queue = this.#store.get(sessionId)
    if (queue === undefined) {
      this.#stopPump(sessionId)
      return
    }
    if (queue.stopReason !== null) {
      this.#stopPump(sessionId)
      return
    }
    if (queue.autopilot !== true && this.#active.get(sessionId) === undefined) {
      this.#stopPump(sessionId)
      return
    }
    if (queue.retryAt !== null && this.#now() < queue.retryAt) return
    if (queue.retryAt !== null) {
      // The subscription limit reset: put the waiting task back into the queue.
      queue.retryAt = null
      await this.#store.replace(sessionId, queue)
      await this.#event(sessionId, { kind: 'status', key: 'queue.event.retry-reset', params: {}, text: 'Лимит подписки сброшен, очередь продолжается.' })
      if (this.#cancelled.has(sessionId)) return
    }
    const active = this.#active.get(sessionId)
    if (active === undefined) {
      const reason = await this.#stopReason(queue)
      if (this.#cancelled.has(sessionId)) return
      if (reason !== null) {
        await this.#finish(sessionId, reason)
        return
      }
      const task = nextQueuedTask(queue)
      if (task === undefined) {
        await this.#finish(sessionId, 'empty')
        return
      }
      await this.#startTask(sessionId, task)
      return
    }
    await this.#stepActive(sessionId, active)
  }

  /**
   * Whether the queue should end before starting another task.
   * @param {object} queue - queue record.
   * @returns {Promise<string | null>} stop reason or null.
   */
  async #stopReason(queue) {
    if (queue.stats.taken >= queue.limit) return 'limit'
    if (queue.stats.consecutiveParks >= this.#tuning.maxConsecutiveParks) return 'parks'
    const free = await this.#freeBytes()
    if (free !== null && free < this.#tuning.minDiskBytes) return 'disk'
    return null
  }

  /**
   * Start the next queued task as an unattended Artel run, seeded from the last
   * successful version when there is one.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @returns {Promise<void>} resolves when the run exists (or the task was parked).
   */
  async #startTask(sessionId, task) {
    const queue = this.#store.get(sessionId)
    const startedAt = this.#now()
    // «Стоп» may have landed between the pump step and this start.
    if (this.#cancelled.has(sessionId)) return
    if (this.#usesBranches(queue)) {
      await this.#startBranchTask(sessionId, task, queue, startedAt)
      return
    }
    if (task.mode === 'orchestrator') {
      await this.#parkTask(sessionId, task.id, 'Оркестратор в автоочереди работает только с ветками: обновите очередь до новой модели.', {
        interrupt: false,
        reasonKey: 'queue.reason.orchestrator-legacy',
        reasonParams: {},
      })
      return
    }
    // A retried task continues from its own parked copy; every other task starts
    // from the last successful version.
    let basePath = task.basePath ?? queue.lastVersion?.path ?? null
    let run = null
    try {
      run = await this.#engine.start({
        sessionId,
        projectPath: queue.projectPath,
        mode: task.mode,
        task: task.text,
        model: task.model,
        basePath,
        autoqueue: true,
      })
    } catch (error) {
      if (this.#cancelled.has(sessionId)) return
      if (error?.code === 'artel/no-base-version' && basePath !== null) {
        // The previous version was applied or discarded meanwhile: start from the
        // real project and say so.
        await this.#event(sessionId, { kind: 'status', key: 'queue.event.base-version-lost', params: {}, text: 'Прошлая версия больше недоступна; задача начнётся от настоящего проекта.' })
        basePath = null
        const current = this.#store.get(sessionId)
        current.lastVersion = null
        await this.#store.replace(sessionId, current)
        try {
          run = await this.#engine.start({
            sessionId,
            projectPath: queue.projectPath,
            mode: task.mode,
            task: task.text,
            model: task.model,
            basePath: null,
            autoqueue: true,
          })
        } catch (retryError) {
          await this.#parkTask(sessionId, task.id, `Не удалось начать задачу: ${retryError?.message ?? retryError}`, {
            interrupt: false,
            reasonKey: 'queue.reason.start-failed',
            reasonParams: { error: String(retryError?.message ?? retryError) },
          })
          return
        }
      } else if (error?.code === 'artel/busy') {
        // Another run (usually the user's own) is live: wait for the session to free up.
        return
      } else {
        await this.#parkTask(sessionId, task.id, `Не удалось начать задачу: ${error?.message ?? error}`, {
          interrupt: false,
          reasonKey: 'queue.reason.start-failed',
          reasonParams: { error: String(error?.message ?? error) },
        })
        return
      }
    }
    if (run === null) return
    if (this.#cancelled.has(sessionId)) {
      // «Стоп» arrived while the run was starting: keep the partial work parked
      // and let the stop finish the queue instead of waiting on a fresh run.
      try {
        await this.#engine.interrupt(run.id)
      } catch {}
      await this.#parkTask(sessionId, task.id, 'Вы остановили автоочередь; частичная работа в «Отложенном».', {
        interrupt: false,
        reasonKey: 'queue.reason.stopped',
        reasonParams: {},
      })
      return
    }
    await this.#store.updateTask(sessionId, task.id, {
      status: 'running',
      runId: run.id,
      basePath,
      startedAt,
      reason: null,
    })
    const fresh = this.#store.get(sessionId)
    fresh.stats.taken += 1
    fresh.stats.startedAt = fresh.stats.startedAt ?? startedAt
    await this.#store.replace(sessionId, fresh)
    this.#active.set(sessionId, {
      taskId: task.id,
      runId: run.id,
      cursor: 0,
      phase: 'run',
      fixes: task.fixes ?? 0,
      startedAt,
      errorText: '',
      lastText: '',
    })
    await this.#event(sessionId, { kind: 'started', key: 'queue.event.started', params: { title: task.title }, text: `Работа: ${task.title}`, taskId: task.id })
  }

  /**
   * Start a task from the tip of its queue branch: materialise the tip as a
   * plain directory, hand it to the engine as an isolated base and remove the
   * materialisation once the engine has copied it.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @param {object} queue - queue record.
   * @param {number} startedAt - start timestamp.
   * @returns {Promise<void>} resolves when the run is live or the task is parked.
   */
  async #startBranchTask(sessionId, task, queue, startedAt) {
    let git = null
    let branch = null
    try {
      git = await this.#branches.ensure(sessionId)
      branch = this.#branchForTask(sessionId, task)
    } catch (error) {
      await this.#parkTask(sessionId, task.id, `Не удалось открыть ветку задачи: ${error?.message ?? error}`, {
        interrupt: false,
        reasonKey: 'queue.reason.branch-open-failed',
        reasonParams: { error: String(error?.message ?? error) },
      })
      return
    }
    const tip = branch.tipCommit ?? branch.baseCommit
    const seed = path.join(this.#stateDir, 'worktrees', `seed-${task.id}-${this.#now()}`)
    await fs.mkdir(path.dirname(seed), { recursive: true })
    try {
      await git.materialize(seed, tip)
    } catch (error) {
      await this.#parkTask(sessionId, task.id, `Не удалось подготовить ветку: ${error?.message ?? error}`, {
        interrupt: false,
        reasonKey: 'queue.reason.branch-prepare-failed',
        reasonParams: { error: String(error?.message ?? error) },
      })
      return
    }
    let run = null
    try {
      run = await this.#engine.start({
        sessionId,
        projectPath: queue.projectPath,
        mode: task.mode,
        task: task.text,
        model: task.model,
        basePath: seed,
        isolateFromBase: true,
        branchId: branch.id,
        parentCommit: tip,
        autoqueue: true,
      })
    } catch (error) {
      if (this.#cancelled.has(sessionId)) return
      if (error?.code === 'artel/busy') return
      await this.#parkTask(sessionId, task.id, `Не удалось начать задачу: ${error?.message ?? error}`, {
        interrupt: false,
        reasonKey: 'queue.reason.start-failed',
        reasonParams: { error: String(error?.message ?? error) },
      })
      return
    } finally {
      await fs.rm(seed, { recursive: true, force: true })
    }
    if (run === null) return
    if (this.#cancelled.has(sessionId)) {
      // «Стоп» arrived while the branch run was starting: park the partial work.
      try {
        await this.#engine.interrupt(run.id)
      } catch {}
      await this.#parkTask(sessionId, task.id, 'Вы остановили автоочередь; частичная работа в «Отложенном».', {
        interrupt: false,
        reasonKey: 'queue.reason.stopped',
        reasonParams: {},
      })
      return
    }
    await this.#store.updateTask(sessionId, task.id, {
      status: 'running',
      runId: run.id,
      basePath: null,
      branchId: branch.id,
      parentCommit: tip,
      startedAt,
      reason: null,
    })
    const fresh = this.#store.get(sessionId)
    fresh.stats.taken += 1
    fresh.stats.startedAt = fresh.stats.startedAt ?? startedAt
    await this.#store.replace(sessionId, fresh)
    this.#active.set(sessionId, {
      taskId: task.id,
      runId: run.id,
      cursor: 0,
      phase: 'run',
      fixes: task.fixes ?? 0,
      startedAt,
      errorText: '',
      lastText: '',
    })
    await this.#event(sessionId, { kind: 'started', key: 'queue.event.started', params: { title: task.title }, text: `Работа: ${task.title}`, taskId: task.id })
  }

  /**
   * Whether a queue runs on branches: the branch model with an opened repository.
   * Queues created before the branch model, or not opened yet, keep the 0.10 path.
   * @param {object} queue - queue record.
   * @returns {boolean} true when tasks are started from branch tips.
   */
  #usesBranches(queue) {
    return isBranchQueue(queue) && queue.project !== null && queue.project !== undefined
  }

  /**
   * The branch a task belongs to.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @returns {object} branch record.
   */
  #branchForTask(sessionId, task) {
    const queue = this.#store.get(sessionId)
    const branch = (queue?.branches ?? []).find((entry) => entry.id === task.branchId) ?? null
    if (branch === null) throw new Error(`Ветка задачи ${task.id} не найдена`)
    return branch
  }

  /**
   * The branch new tasks are added to.
   * @param {string} sessionId - chat session id.
   * @returns {object | null} branch record or null.
   */
  #currentBranch(sessionId) {
    const queue = this.#store.get(sessionId)
    if (queue === null) return null
    return (queue.branches ?? []).find((entry) => entry.id === queue.currentBranchId) ?? null
  }

  /**
   * Commit the copy of a passed run into its queue branch.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @param {object} run - run summary.
   * @param {object[]} changes - run changes.
   * @returns {Promise<string>} the new commit sha.
   */
  async #commitTaskRun(sessionId, task, run, changes) {
    const git = await this.#branches.ensure(sessionId)
    const branch = this.#branchForTask(sessionId, task)
    const parent = task.parentCommit ?? branch.tipCommit ?? branch.baseCommit
    const commit = await git.commitDir(run.copyPath, { parent, message: task.title })
    await git.updateRef(branch.ref, commit, parent)
    const files = (changes ?? []).map((change) => change.path).slice(0, 40)
    if (typeof this.#engine.markCommitted === 'function') {
      await this.#engine.markCommitted(run.id, {
        branchId: branch.id,
        parentCommit: parent,
        commit,
        files,
        changeCount: run?.changeCount ?? files.length,
      })
    }
    const fresh = this.#store.get(sessionId)
    fresh.branches = (fresh.branches ?? []).map((entry) =>
      entry.id === branch.id ? { ...entry, tipCommit: commit, updatedAt: this.#now() } : entry,
    )
    await this.#store.replace(sessionId, fresh)
    await git.pruneWorktrees().catch(() => {})
    return commit
  }

  /**
   * Move the live task forward: read its new feed lines, react to questions and
   * decide whether the run is finished, failed or still working.
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @returns {Promise<void>} resolves when the step is done.
   */
  async #stepActive(sessionId, active) {
    let run
    try {
      run = this.#engine.getRun(active.runId)
    } catch {
      await this.#parkTask(sessionId, active.taskId, 'Запуск потерян: движок больше не знает эту задачу.', {
        interrupt: false,
        reasonKey: 'queue.reason.run-lost',
        reasonParams: {},
      })
      return
    }
    if (run.status === 'applied') {
      // The user applied the version while the queue was still waiting: the
      // project now has the change, so there is nothing to keep as a version.
      await this.#finishTask(sessionId, active, {
        accepted: true,
        run,
        reason: 'Версия уже влита в проект.',
        reasonKey: 'queue.reason.already-applied',
        reasonParams: {},
      })
      return
    }
    if (run.status === 'discarded') {
      await this.#parkTask(sessionId, active.taskId, 'Вы отменили версию этой задачи.', {
        reasonKey: 'queue.reason.discarded',
        reasonParams: {},
      })
      return
    }
    const parked = await this.#scanFeed(sessionId, active)
    if (parked === true) return
    // «Стоп» landed during the scan: do not settle or fail the task afterwards.
    if (this.#cancelled.has(sessionId)) return
    if (active.phase === 'check') {
      // A check was interrupted by a restart; run it again on the new status.
      active.phase = 'run'
    }
    if (['preparing', 'planning', 'running'].includes(run.status)) {
      if (active.phase === 'fix') {
        // The repair turn is live: nothing to do but wait.
        return
      }
      return
    }
    if (FINISHED_STATUSES.has(run.status)) {
      const queue = this.#store.get(sessionId)
      // A turn that ended with a question is not a finished task: under the
      // toggle the runner already answered it above, otherwise the user has to.
      if (active.pendingQuestion != null && queue?.autopilot !== true) return
      await this.#settleTask(sessionId, active, run)
      return
    }
    if (FAILED_STATUSES.has(run.status)) {
      await this.#handleFailure(sessionId, active, run)
    }
  }

  /**
   * Read the feed lines the runner has not seen yet and react to what the agent
   * said: a question gets one automatic answer, and an attempt to publish
   * outward parks the task.
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @returns {Promise<boolean>} true when the task was parked or paused by this scan.
   */
  async #scanFeed(sessionId, active) {
    let feed
    try {
      feed = await this.#engine.readFeed(active.runId, { cursor: active.cursor, limit: 500 })
    } catch {
      return false
    }
    // «Стоп» landed while the feed was being read: the stop owns the final state.
    if (this.#cancelled.has(sessionId)) return true
    const events = Array.isArray(feed?.events) ? feed.events : []
    if (typeof feed?.cursor === 'number') active.cursor = feed.cursor
    for (const event of events) {
      if (event?.kind === 'error') {
        active.errorText = String(event.text ?? '')
        continue
      }
      const text = String(event?.text ?? '')
      if (text === '') continue
      const outward = await callCheck('scanOutward', text)
      if (typeof outward === 'string' && outward !== '') {
        await this.#parkTask(sessionId, active.taskId, `Агент попробовал отправить работу наружу (${outward}) — очередь этого не делает.`, {
          reasonKey: 'queue.reason.outward',
          reasonParams: { detail: outward },
        })
        return true
      }
      if (event?.kind !== 'assistant') continue
      if (endsWithQuestion(text)) {
        const queue = this.#store.get(sessionId)
        if (queue.autopilot !== true) {
          // The user is present: leave the question on the run page instead of
          // answering for them; the pipeline waits until it is answered.
          active.pendingQuestion = text
          continue
        }
        const task = queue.tasks.find((entry) => entry.id === active.taskId)
        if ((task?.questions ?? 0) >= this.#tuning.maxQuestions) {
          await this.#parkTask(sessionId, active.taskId, 'Агент задал второй вопрос: без ответа задачу не продолжить.', {
            reasonKey: 'queue.reason.second-question',
            reasonParams: {},
          })
          return true
        }
        await this.#store.updateTask(sessionId, active.taskId, { questions: 1 })
        await this.#event(sessionId, {
          kind: 'question',
          key: 'queue.event.question',
          params: { text: text.slice(0, 200) },
          text: `Вопрос агента: ${text.slice(0, 200)}`,
        })
        try {
          await this.#engine.message(active.runId, { text: autoAnswerPrompt() })
        } catch (error) {
          await this.#parkTask(sessionId, active.taskId, `Не удалось передать автоответ: ${error?.message ?? error}`, {
            reasonKey: 'queue.reason.auto-answer-failed',
            reasonParams: { error: String(error?.message ?? error) },
          })
          return true
        }
        active.pendingQuestion = null
        await this.#event(sessionId, { kind: 'auto-answer', key: 'queue.event.auto-answer', params: {}, text: 'Автоответ: решай сам и запиши допущение.' })
        return false
      }
      active.pendingQuestion = null
    }
    return false
  }

  /**
   * The agents of a run are idle: collect the changes, run the check and save
   * the run as a version, or send it to one more repair turn.
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @param {object} run - run summary.
   * @returns {Promise<void>} resolves when the step is done.
   */
  async #settleTask(sessionId, active, run) {
    const queue = this.#store.get(sessionId)
    const task = queue.tasks.find((entry) => entry.id === active.taskId)
    if (task === undefined) {
      this.#active.delete(sessionId)
      return
    }
    let changes = []
    try {
      changes = await this.#engine.changes(run.id)
    } catch {
      changes = []
    }
    // «Стоп» landed while the diff was being read: the stop owns the final state.
    if (this.#cancelled.has(sessionId)) return
    if (changes.length === 0) {
      await this.#parkTask(sessionId, active.taskId, 'Агент закончил и ничего не изменил.', {
        reasonKey: 'queue.reason.no-changes',
        reasonParams: {},
        // The agent is already idle: interrupting it only appends a misleading
        // «You stopped the run» event to the feed.
        interrupt: false,
      })
      return
    }
    // A secret or junk file must never become a version: check the diff itself,
    // not only what the check command says.
    const hygiene = await this.#hygiene(changes, run.copyPath)
    if (this.#cancelled.has(sessionId)) return
    if (hygiene.length > 0) {
      await this.#parkTask(sessionId, active.taskId, `В диффе секрет или мусор: ${hygiene.slice(0, 2).join('; ')}.`, {
        reasonKey: 'queue.reason.hygiene',
        reasonParams: { detail: hygiene.slice(0, 2).join('; ') },
      })
      return
    }
    const check = await this.#runTaskCheck(queue, run, changes)
    // The check is the longest step: Stop aborts it and must win the final state.
    if (this.#cancelled.has(sessionId)) return
    if (check.skipped !== true && check.ok !== true) {
      const fixes = (task.fixes ?? 0) + 1
      if (fixes <= this.#tuning.maxFixes) {
        await this.#store.updateTask(sessionId, active.taskId, { fixes, check: { ...check, attempt: fixes } })
        await this.#event(sessionId, {
          kind: 'check',
          key: 'queue.event.check-retry',
          params: { attempt: fixes + 1 },
          text: `Проверка не прошла (попытка ${fixes + 1}): агент исправляет.`,
          taskId: task.id,
        })
        try {
          const prompt = checkRepairPrompt({
            command: check.command ?? '',
            output: check.output ?? '',
            attempt: fixes,
            attempts: this.#tuning.maxFixes,
          })
          // An Orchestrator run repairs its assembled copy through the engine;
          // every other run is repaired by an ordinary message to its agents.
          if (run?.mode === 'orchestrator' && typeof this.#engine.repairArtifact === 'function') {
            await this.#engine.repairArtifact(run.id, { prompt, purpose: 'check' })
          } else {
            await this.#engine.message(run.id, { text: prompt })
          }
        } catch (error) {
          await this.#parkTask(sessionId, active.taskId, `Не удалось отправить задачу на починку: ${error?.message ?? error}`, {
            reasonKey: 'queue.reason.repair-failed',
            reasonParams: { error: String(error?.message ?? error) },
          })
          return
        }
        active.phase = 'fix'
        return
      }
      await this.#parkTask(sessionId, active.taskId, `Проверка не прошла после ${this.#tuning.maxFixes} починок.`, {
        reasonKey: 'queue.reason.check-failed',
        reasonParams: { count: this.#tuning.maxFixes },
      })
      return
    }
    await this.#finishTask(sessionId, active, { accepted: false, run, changes, check })
  }

  /**
   * Save a passed run as its own version and continue with the next task.
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @param {{ accepted: boolean, reason?: string, reasonKey?: string | null, reasonParams?: object | null, run?: object, changes?: object[], check?: object }} result - outcome.
   * @returns {Promise<void>} resolves when the next queue state is stored.
   */
  async #finishTask(sessionId, active, { accepted, reason = '', reasonKey = null, reasonParams = null, run = null, changes = [], check = null }) {
    const queue = this.#store.get(sessionId)
    const task = queue.tasks.find((entry) => entry.id === active.taskId)
    if (task === undefined) {
      this.#active.delete(sessionId)
      return
    }
    if (task.status !== 'running') {
      // The task was closed meanwhile (Stop parks it): a stopped task must not
      // turn into a passed version.
      this.#active.delete(sessionId)
      return
    }
    const changeCount = run?.changeCount ?? changes.length
    const files = (changes ?? []).map((change) => change.path).slice(0, 40)
    const finishedAt = this.#now()
    const branchQueue = this.#usesBranches(queue)
    let commit = null
    if (accepted !== true && branchQueue) {
      try {
        commit = await this.#commitTaskRun(sessionId, task, run, changes)
      } catch (error) {
        await this.#parkTask(sessionId, active.taskId, `Не удалось сохранить задачу в ветку: ${error?.message ?? error}`, {
          reasonKey: 'queue.reason.commit-failed',
          reasonParams: { error: String(error?.message ?? error) },
        })
        return
      }
    }
    const current = this.#store.get(sessionId)
    if (accepted === true) {
      // Applied by the user: the project itself is now the base for what comes
      // next, so the queue must not seed the next task from an older copy.
      current.lastVersion = null
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
    } else if (branchQueue) {
      // The change already lives in its own commit; there is no copy to keep.
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
      current.results = null
      current.stopReason = null
    } else {
      current.lastVersion = { runId: run.id, path: run.copyPath, title: task.title, changeCount, at: finishedAt }
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
      current.results = null
      current.stopReason = null
    }
    await this.#store.replace(sessionId, current)
    await this.#store.updateTask(sessionId, task.id, {
      status: 'passed',
      changeCount,
      files,
      check: check ?? task.check ?? null,
      finishedAt,
      reason: accepted ? reason : null,
      reasonKey: accepted ? reasonKey : null,
      reasonParams: accepted ? reasonParams : null,
      ...(commit === null ? {} : { commit }),
    })
    const fresh = this.#store.get(sessionId)
    this.#active.delete(sessionId)
    const shortCommit = commit === null ? '' : commit.slice(0, 7)
    const skipped = check?.skipped === true
    const baseText = `Версия готова: ${task.title} · ${changeCount} файл(ов)`
    const commitText = commit === null ? '' : ` · ${commit.slice(0, 7)}`
    const skippedText = check?.skipped ? ' · проверка отключена' : ''
    const passedKey = shortCommit === '' && !skipped
      ? 'queue.event.passed'
      : shortCommit !== '' && !skipped
        ? 'queue.event.passed.commit'
        : shortCommit === ''
          ? 'queue.event.passed.skipped'
          : 'queue.event.passed.commit-skipped'
    await this.#event(sessionId, {
      kind: 'passed',
      key: passedKey,
      params: { title: task.title, count: changeCount, commit: shortCommit },
      text: `${baseText}${commitText}${skippedText}`,
      taskId: task.id,
    })
    if (fresh.stopAfterCurrent === true) {
      await this.#finish(sessionId, 'after-current')
      return
    }
    if (fresh.autopilot !== true) this.#stopPump(sessionId)
  }

  /**
   * The run cannot continue: park the task and, when it is the third park in a
   * row, end the queue. A lost login ends it at once; a subscription limit only
   * makes it wait for the reset.
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @param {object} run - run summary.
   * @returns {Promise<void>} resolves when the queue moved on.
   */
  async #handleFailure(sessionId, active, run) {
    const text = [run.error, active.errorText].filter((part) => typeof part === 'string' && part !== '').join('\n')
    const failure = classifyFailure(text, this.#now())
    if (failure.kind === 'login-lost') {
      await this.#requeueTask(sessionId, active, 'Не удалось продолжить: движок не авторизован.', {
        reasonKey: 'queue.reason.login-lost',
        reasonParams: {},
      })
      await this.#finish(sessionId, 'login-lost')
      return
    }
    if (failure.kind === 'rate-limit') {
      await this.#requeueTask(sessionId, active, 'Подписка упёрлась в лимит: задача ждёт сброса.', {
        reasonKey: 'queue.reason.rate-limit',
        reasonParams: {},
      })
      const queue = this.#store.get(sessionId)
      queue.retryAt = failure.retryAt ?? this.#now() + this.#tuning.retryDelayMs
      await this.#store.replace(sessionId, queue)
      const when = new Date(queue.retryAt).toLocaleTimeString()
      await this.#event(sessionId, {
        kind: 'wait',
        key: 'queue.event.rate-limit-wait',
        params: { when },
        text: `Лимит подписки: очередь подождёт до ${when}.`,
      })
      return
    }
    const errorText = String(run.error ?? '').trim()
    const reason = errorText === '' ? 'Задача завершилась ошибкой.' : `Задача завершилась ошибкой: ${run.error}`
    await this.#parkTask(sessionId, active.taskId, reason, {
      interrupt: false,
      reasonKey: errorText === '' ? 'queue.reason.failed' : 'queue.reason.failed-detail',
      reasonParams: errorText === '' ? {} : { error: String(run.error) },
    })
  }

  /**
   * Put the live task back into the queue after a failure that is not the
   * task's fault (subscription limit, lost login).
   * @param {string} sessionId - chat session id.
   * @param {object} active - live task state.
   * @param {string} reason - human reason.
   * @param {{ reasonKey?: string | null, reasonParams?: object | null }} [options] - catalogue key of the reason.
   * @returns {Promise<void>} resolves when stored.
   */
  async #requeueTask(sessionId, active, reason, { reasonKey = null, reasonParams = null } = {}) {
    const current = this.#store.get(sessionId)
    const task = current?.tasks.find((entry) => entry.id === active.taskId)
    if (task === undefined || task.status !== 'running') {
      // The task was closed meanwhile (Stop parks it): do not requeue it.
      this.#active.delete(sessionId)
      return
    }
    await this.#store.updateTask(sessionId, active.taskId, {
      status: 'queued',
      runId: null,
      reason,
      reasonKey,
      reasonParams,
      finishedAt: this.#now(),
    })
    this.#active.delete(sessionId)
    await this.#event(sessionId, { kind: 'status', key: reasonKey, params: reasonParams, text: reason, taskId: active.taskId })
  }

  /**
   * Put a task into «Отложенное» and continue, unless that was the third park in
   * a row.
   * @param {string} sessionId - chat session id.
   * @param {string} taskId - task id.
   * @param {string} reason - why it was parked.
   * @param {{ interrupt?: boolean, reasonKey?: string | null, reasonParams?: object | null }} options - whether to stop the live agent.
   * @returns {Promise<void>} resolves when stored.
   */
  async #parkTask(sessionId, taskId, reason, { interrupt = true, reasonKey = null, reasonParams = null } = {}) {
    const queue = this.#store.get(sessionId)
    const task = queue?.tasks.find((entry) => entry.id === taskId)
    if (queue === undefined || task === undefined) {
      this.#active.delete(sessionId)
      return
    }
    if (task.status === 'parked') {
      // Another path (Stop, a restart) already parked this task: keep that first
      // reason instead of overwriting it with a late failure.
      this.#active.delete(sessionId)
      return
    }
    const active = this.#active.get(sessionId)
    let resumePath = null
    let runId = active?.taskId === taskId ? active.runId : task.runId
    if (runId !== null && runId !== undefined) {
      try {
        const run = this.#engine.getRun(runId)
        if ((run.changeCount ?? 0) > 0 && run.copyPath) resumePath = run.copyPath
      } catch {
        resumePath = null
      }
    }
    const branch = parkedBranch(task)
    // Park first, interrupt second: the interrupt is an asynchronous round trip
    // through the engine, and until the task is stored as parked a reader sees
    // `running` while the task is already being stopped. The status write is
    // local, so it is the cheap operation to do before awaiting the engine.
    await this.#store.updateTask(sessionId, taskId, {
      status: 'parked',
      reason,
      reasonKey,
      reasonParams,
      parkedBranch: branch,
      // A retried parked task continues from its own partial copy, not from the
      // last successful version: «Вернуть» must not throw the work away.
      ...(resumePath === null ? {} : { basePath: resumePath }),
      finishedAt: this.#now(),
    })
    if (interrupt && active !== undefined && active.taskId === taskId) {
      await Promise.resolve(this.#engine.interrupt(active.runId)).catch(() => {})
    }
    const fresh = this.#store.get(sessionId)
    fresh.stats.parked += 1
    fresh.stats.consecutiveParks += 1
    await this.#store.replace(sessionId, fresh)
    this.#active.delete(sessionId)
    await this.#event(sessionId, {
      kind: 'parked',
      key: 'queue.event.parked',
      params: { title: task.title },
      text: `Отложено: ${task.title} — ${reason}`,
      taskId,
    })
    if (fresh.stats.consecutiveParks >= this.#tuning.maxConsecutiveParks) {
      await this.#finish(sessionId, 'parks')
      return
    }
    if (fresh.stopAfterCurrent === true) {
      await this.#finish(sessionId, 'after-current')
    }
  }

  /**
   * End the queue: keep the results card, stop the pump and leave the queued
   * tasks waiting for the next run.
   * @param {string} sessionId - chat session id.
   * @param {string} reason - stop reason id.
   * @returns {Promise<object>} the finished queue record.
   */
  async #finish(sessionId, reason) {
    const queue = this.#store.get(sessionId)
    if (queue === undefined) return undefined
    queue.autopilot = false
    queue.stopAfterCurrent = false
    queue.stopReason = reason
    queue.retryAt = null
    queue.results = resultsCard(queue)
    const text = `Итоги автоочереди: ${queue.results.passed.length} версий, ${queue.results.parked.length} в «Отложенном». ${stopReasonLabel(reason)}`
    queue.eventSeq = (queue.eventSeq ?? 0) + 1
    queue.events = [
      ...(queue.events ?? []),
      {
        seq: queue.eventSeq,
        at: this.#now(),
        kind: 'results',
        key: 'queue.event.results',
        params: { passed: queue.results.passed.length, parked: queue.results.parked.length },
        stopKey: stopReasonKey(reason),
        stopParams: {},
        text,
        taskId: null,
      },
    ]
    await this.#store.replace(sessionId, queue)
    this.#stopPump(sessionId)
    return queue
  }

  /**
   * Append one line to the queue feed.
   * @param {string} sessionId - chat session id.
   * @param {{ kind: string, text: string, key?: string, params?: object, taskId?: string | null }} event - event.
   * @returns {Promise<void>} resolves when stored.
   */
  async #event(sessionId, event) {
    try {
      await this.#store.appendEvent(sessionId, { ...event, at: this.#now() })
    } catch (error) {
      this.#log.warn?.(`artel: queue event failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Guess the project check command for the pre-flight card.
   * @param {string | null} projectPath - project to inspect.
   * @returns {Promise<string>} command, or '' when nothing was guessed.
   */
  async #suggestCheck(projectPath) {
    if (typeof projectPath !== 'string' || projectPath === '') return ''
    try {
      const suggestion = await callCheck('suggestCheckCommand', { projectPath })
      if (typeof suggestion === 'string') return suggestion
      if (suggestion !== null && typeof suggestion === 'object' && typeof suggestion.command === 'string') return suggestion.command
      return ''
    } catch {
      return ''
    }
  }

  /**
   * Run the check of a finished task: the queue command when set, otherwise a
   * command guessed from the project. «Без проверки» marks the version instead.
   * @param {object} queue - queue record.
   * @param {object} run - run summary.
   * @param {object[]} changes - changed files.
   * @returns {Promise<{ ok: boolean, skipped: boolean, command: string | null, output?: string, durationMs?: number }>} check result.
   */
  async #runTaskCheck(queue, run, changes) {
    if (queue.checkDisabled === true) {
      return { ok: true, skipped: true, command: null }
    }
    let command = String(queue.checkCommand ?? '').trim()
    if (command === '') {
      command = await this.#suggestCheck(queue.projectPath)
      if (command !== '') {
        queue.checkCommand = command
        queue.checkGuessed = true
        await this.#store.replace(queue.sessionId, queue)
      }
    }
    if (command === '') return { ok: true, skipped: true, command: null }
    // «Стоп» aborts the running check instead of waiting out checkTimeoutMs.
    // The controller is registered before the event so a Stop that races with the
    // start of the check still reaches it.
    const controller = new AbortController()
    this.#checks.set(queue.sessionId, controller)
    await this.#event(queue.sessionId, { kind: 'check', key: 'queue.event.check-command', params: { command }, text: `Тесты: ${command}` })
    try {
      const result = await callCheck('runCheck', {
        command,
        cwd: run.copyPath,
        timeoutMs: this.#tuning.checkTimeoutMs,
        signal: controller.signal,
      })
      return {
        ok: result?.ok === true,
        skipped: false,
        command,
        output: String(result?.output ?? result?.stdout ?? result?.stderr ?? ''),
        durationMs: result?.durationMs ?? null,
      }
    } catch (error) {
      return { ok: false, skipped: false, command, output: String(error?.message ?? error) }
    } finally {
      this.#checks.delete(queue.sessionId)
    }
  }

  /**
   * Scan the diff for secrets and junk.
   * @param {object[]} changes - changed files.
   * @param {string} copyPath - root of the checked copy.
   * @returns {Promise<string[]>} problems.
   */
  async #hygiene(changes, copyPath) {
    try {
      const result = await callCheck('scanHygiene', {
        changes,
        rootDir: copyPath,
        readFile: (file) => fs.readFile(file, 'utf8'),
      })
      const findings = Array.isArray(result?.findings) ? result.findings : []
      return findings
        .map((finding) => (typeof finding === 'string' ? finding : `${finding?.path ?? 'файл'}: ${finding?.detail ?? finding?.kind ?? 'проблема'}`))
        .slice(0, 6)
    } catch {
      return []
    }
  }

  /**
   * Free bytes on the volume the state directory is on.
   * @returns {Promise<number | null>} bytes or null when unknown.
   */
  async #freeBytes() {
    try {
      const free = await callCheck('freeDiskBytes', this.#stateDir)
      return typeof free === 'number' && Number.isFinite(free) ? free : null
    } catch {
      return null
    }
  }

  /** Stop every pump; live runs are left to the engine's own shutdown. */
  dispose() {
    this.#closed = true
    for (const pump of this.#pumps.values()) {
      if (pump.timer !== null) clearInterval(pump.timer)
    }
    this.#pumps.clear()
    this.#active.clear()
    for (const controller of this.#checks.values()) {
      try {
        controller.abort()
      } catch {}
    }
    this.#checks.clear()
    this.#cancelled.clear()
    this.#chains.clear()
  }
}

export default { QueueRunner, QUEUE_TUNING, path }
