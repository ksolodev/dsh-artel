/**
 * Автоочередь — the queue of tasks a session stacks up for later.
 *
 * This module owns the queue record and its persistence. The unattended part —
 * starting the next task, answering the first question, running the check,
 * saving each task as its own version — lives in `queue-runner.js`; the tasks
 * themselves are ordinary Artel runs started through `engine.js`.
 *
 * A queue belongs to one chat session: the board, the strip above the composer
 * and the new-session screen all read and write the record of that session.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** How a task moves through the queue. */
export const TASK_STATUSES = ['queued', 'running', 'passed', 'parked', 'skipped', 'stopped']
/** Allowed transitions of one task. */
export const TASK_TRANSITIONS = {
  queued: ['running', 'skipped', 'stopped', 'parked'],
  running: ['passed', 'parked', 'stopped', 'queued'],
  passed: [],
  parked: ['queued'],
  skipped: ['queued'],
  stopped: ['queued'],
}
/**
 * Modes a queue task may run in; the Orchestrator is not one of them because
 * it cannot start from a saved version yet (see `queueModeRefusal`).
 */
export const QUEUE_MODES = ['solo', 'swarm', 'conductor', 'fusion']
/** Default for «не больше N задач за запуск». */
export const DEFAULT_QUEUE_LIMIT = 20
/** Most tasks one queue can hold. */
export const MAX_QUEUE_TASKS = 200
/** Most events one queue keeps for its feed. */
export const MAX_QUEUE_EVENTS = 400
/** Tuning of the runner; exported so tests and settings share one number. */
export const QUEUE_TUNING = {
  maxFixes: 2,
  maxQuestions: 1,
  maxConsecutiveParks: 3,
  pollMs: 700,
  checkTimeoutMs: 15 * 60 * 1000,
  retryDelayMs: 15 * 60 * 1000,
  minDiskBytes: 500 * 1024 * 1024,
}

const AUTH_PATTERN = /login|log in|sign in|unauthori[sz]ed|not authenticated|401|auth(?:entication)? (?:failed|required|expired)|invalid api key|token expired/i
const RATE_PATTERN = /rate limit|rate-limit|too many requests|429|quota|usage limit|limit reached|out of (?:credits|tokens)|resets? (?:at|in|on)|try again (?:later|in)/i
const RESET_PATTERN = /(?:resets?|try again|available)\s+(?:in|after)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|h)\b/i
const RESET_AT_PATTERN = /resets?\s+at\s+(\d{1,2}):(\d{2})/i
const QUESTION_TAIL = /(?:[?.!]\s*)$/
const EDGE_PUNCTUATION = /[.!:;,\s]+$/

/**
 * A short title for a task: the first line of its text.
 * @param {string} text - task text.
 * @returns {string} title.
 */
export function taskTitle(text) {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (firstLine === '') return 'Задача'
  return firstLine.length > 120 ? `${firstLine.slice(0, 119).trimEnd()}…` : firstLine
}

/**
 * Whether a value is a mode a queue task may use.
 * @param {string} mode - candidate.
 * @returns {boolean} true when the mode is allowed.
 */
export function isQueueMode(mode) {
  return QUEUE_MODES.includes(mode)
}

/**
 * Why a mode cannot be queued, or null when the queue takes it.
 *
 * The queue promises that every task starts from the last saved version. The
 * Orchestrator plans against the real project and copies it again per part, so
 * it cannot honour that promise yet — the picker shows it disabled and the API
 * refuses it instead of silently running Solo.
 * @param {string} mode - candidate mode.
 * @returns {{ code: string, message: string } | null} refusal, or null.
 */
export function queueModeRefusal(mode) {
  if (isQueueMode(mode)) return null
  if (mode === 'orchestrator') {
    return {
      code: 'queue/mode-unsupported',
      message:
        'The Orchestrator is not an auto-queue mode: a queued task starts from the last saved version, and the Orchestrator cannot start from a saved version yet. Start it as a normal run instead.',
    }
  }
  return {
    code: 'queue/mode-unknown',
    message: `Unknown auto-queue mode '${mode}': a task runs in ${QUEUE_MODES.join(', ')}.`,
  }
}

/**
 * A fresh queue record for one session.
 * @param {string} sessionId - chat session id.
 * @param {{ projectPath?: string | null, now?: number }} options - initial project.
 * @returns {object} queue record.
 */
export function createQueueRecord(sessionId, { projectPath = null, now = Date.now() } = {}) {
  return {
    version: 1,
    sessionId,
    projectPath,
    // «Автоочередь»: run the queue unattended instead of one task at a time.
    autopilot: false,
    // «не больше N задач за запуск».
    limit: DEFAULT_QUEUE_LIMIT,
    // The check command every finished task passes before it is saved.
    checkCommand: '',
    checkDisabled: false,
    checkGuessed: false,
    tasks: [],
    eventSeq: 0,
    events: [],
    // The «Итоги автоочереди» card of the last autopilot run.
    results: null,
    stopReason: null,
    // «Закончить после текущей»: finish the current task, then stop.
    stopAfterCurrent: false,
    // The last version the next task starts from.
    lastVersion: null,
    stats: { taken: 0, passed: 0, parked: 0, consecutiveParks: 0, startedAt: null },
    // A subscription limit parks the queue until this moment instead of failing it.
    retryAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * A fresh task record for a queue.
 * @param {{ text: string, mode?: string, model?: object | null, now?: number }} input - task fields.
 * @returns {object} task record.
 */
export function createTaskRecord({ text, mode = 'solo', model = null, now = Date.now() }) {
  const clean = String(text ?? '').trim()
  return {
    id: `q-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    title: taskTitle(clean),
    mode: isQueueMode(mode) ? mode : 'solo',
    model: model ?? null,
    status: 'queued',
    runId: null,
    basePath: null,
    reason: null,
    questions: 0,
    fixes: 0,
    check: null,
    changeCount: 0,
    files: [],
    parkedBranch: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  }
}

/**
 * Count the tasks of a queue by status.
 * @param {object} queue - queue record.
 * @returns {{ total: number, queued: number, running: number, passed: number, parked: number, skipped: number, stopped: number, done: number, remaining: number }} counts.
 */
export function queueCounts(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : []
  const counts = { total: tasks.length, queued: 0, running: 0, passed: 0, parked: 0, skipped: 0, stopped: 0 }
  for (const task of tasks) {
    if (Object.hasOwn(counts, task.status)) counts[task.status] += 1
  }
  const done = counts.passed + counts.parked + counts.skipped + counts.stopped
  return { ...counts, done, remaining: counts.queued + counts.running }
}

/**
 * The queue header text for the «Ожидают» column: «Автоочередь идёт · 3 из 7».
 * @param {object} queue - queue record.
 * @returns {{ running: boolean, done: number, total: number, text: string }} header state.
 */
export function queueProgress(queue) {
  const counts = queueCounts(queue)
  const total = Math.max(counts.total, counts.done)
  const text = queue?.autopilot === true ? `Автоочередь идёт · ${counts.done} из ${total}` : `В очереди · ${counts.queued}`
  return { running: queue?.autopilot === true || counts.running > 0, done: counts.done, total, text }
}

/**
 * Whether a task may move to another status.
 * @param {string} from - current status.
 * @param {string} to - target status.
 * @returns {boolean} true when allowed.
 */
export function canTransitionTask(from, to) {
  if (from === to) return true
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * The queue task the runner should start next: the first queued one.
 * @param {object} queue - queue record.
 * @returns {object | undefined} next task.
 */
export function nextQueuedTask(queue) {
  return (queue?.tasks ?? []).find((task) => task.status === 'queued')
}

/**
 * Whether the model ended its turn with a question the user would have to answer.
 * @param {string} text - assistant text.
 * @returns {boolean} true when it is a question.
 */
export function endsWithQuestion(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return false
  return QUESTION_TAIL.test(trimmed) && (trimmed.match(/\?/g) ?? []).length > 0
}

/**
 * The name a parked task is labelled with («Отложенное»): a branch name that is
 * never pushed — the plugin does not write the user's repository.
 * @param {object} task - task record.
 * @returns {string} branch label.
 */
export function parkedBranch(task) {
  const id = String(task?.id ?? 'task').replace(/[^a-zA-Z0-9-]+/g, '')
  return `vf/parked-${id.toLowerCase()}`
}

/**
 * Minutes until a subscription limit resets, read out of the last feed text.
 * @param {string} text - text that mentioned the limit.
 * @returns {number | null} minutes, or null when the text does not say.
 */
export function resetMinutes(text) {
  const raw = String(text ?? '')
  const relative = RESET_PATTERN.exec(raw)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    if (Number.isFinite(amount) && amount > 0) return unit.startsWith('h') ? amount * 60 : amount
  }
  const clock = RESET_AT_PATTERN.exec(raw)
  if (clock) {
    const now = new Date()
    const target = new Date(now)
    target.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000))
  }
  return null
}

/**
 * Classify why a task failed, so the queue knows whether to stop, wait or just
 * park the task and continue.
 * @param {string} text - error text (feed line or run error).
 * @param {number} now - current epoch milliseconds.
 * @returns {{ kind: 'login-lost' | 'rate-limit' | 'other', retryAt: number | null }} classification.
 */
export function classifyFailure(text, now = Date.now()) {
  const raw = String(text ?? '')
  if (AUTH_PATTERN.test(raw)) return { kind: 'login-lost', retryAt: null }
  if (RATE_PATTERN.test(raw)) {
    const minutes = resetMinutes(raw)
    return { kind: 'rate-limit', retryAt: now + (minutes === null ? QUEUE_TUNING.retryDelayMs / 60000 : minutes) * 60000 }
  }
  return { kind: 'other', retryAt: null }
}

/**
 * Why the queue stopped, in the words of the «Итоги» card.
 * @param {string} reason - stop reason id.
 * @returns {string} human text.
 */
export function stopReasonLabel(reason) {
  switch (reason) {
    case 'empty':
      return 'Очередь пуста.'
    case 'limit':
      return 'Кончился лимит задач на этот запуск.'
    case 'parks':
      return 'Три задачи подряд ушли в «Отложенное».'
    case 'login-lost':
      return 'Потерян вход в движок.'
    case 'disk':
      return 'На диске кончилось место.'
    case 'stopped':
      return 'Вы остановили автоочередь.'
    case 'after-current':
      return 'Очередь остановлена после текущей задачи.'
    case 'error':
      return 'Очередь остановилась из-за ошибки.'
    default:
      return 'Автоочередь закончилась.'
  }
}

/**
 * The «Итоги автоочереди» card: versions with title, files, check result and
 * spend; parked tasks with the reason; tasks that were not taken and why.
 * @param {object} queue - queue record.
 * @returns {object | null} results card payload.
 */
export function resultsCard(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : []
  const passed = tasks
    .filter((task) => task.status === 'passed')
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      runId: task.runId,
      files: task.files ?? [],
      changeCount: task.changeCount ?? 0,
      check: task.check ?? null,
    }))
  const parked = tasks
    .filter((task) => task.status === 'parked')
    .map((task) => ({ taskId: task.id, title: task.title, reason: task.reason ?? '', branch: task.parkedBranch ?? null }))
  const notTaken = tasks
    .filter((task) => task.status === 'queued' || task.status === 'skipped' || task.status === 'stopped')
    .map((task) => ({ taskId: task.id, title: task.title, status: task.status, reason: task.reason ?? '' }))
  return {
    at: Date.now(),
    stopReason: queue?.stopReason ?? null,
    stopText: stopReasonLabel(queue?.stopReason),
    startedAt: queue?.stats?.startedAt ?? null,
    limit: queue?.limit ?? DEFAULT_QUEUE_LIMIT,
    passed,
    parked,
    notTaken,
    stats: { ...(queue?.stats ?? {}) },
  }
}

/**
 * The queue's own days/attempts counters, without exposing the tasks.
 * @param {object} queue - queue record.
 * @returns {object} client-facing queue summary.
 */
export function queueSummary(queue) {
  const counts = queueCounts(queue)
  const progress = queueProgress(queue)
  const tasks = (queue?.tasks ?? []).map((task) => ({
    id: task.id,
    text: task.text,
    title: task.title,
    mode: task.mode,
    status: task.status,
    runId: task.runId ?? null,
    reason: task.reason ?? null,
    questions: task.questions ?? 0,
    fixes: task.fixes ?? 0,
    check: task.check ?? null,
    changeCount: task.changeCount ?? 0,
    files: task.files ?? [],
    parkedBranch: task.parkedBranch ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
  }))
  return {
    sessionId: queue?.sessionId ?? null,
    projectPath: queue?.projectPath ?? null,
    autopilot: queue?.autopilot === true,
    limit: queue?.limit ?? DEFAULT_QUEUE_LIMIT,
    checkCommand: queue?.checkCommand ?? '',
    checkDisabled: queue?.checkDisabled === true,
    checkGuessed: queue?.checkGuessed === true,
    running: queue?.stats?.taken > 0,
    stopAfterCurrent: queue?.stopAfterCurrent === true,
    stopReason: queue?.stopReason ?? null,
    retryAt: queue?.retryAt ?? null,
    lastVersion: queue?.lastVersion ?? null,
    results: queue?.results ?? null,
    counts,
    progress,
    tasks,
    events: (queue?.events ?? []).slice(-60),
    createdAt: queue?.createdAt ?? null,
    updatedAt: queue?.updatedAt ?? null,
  }
}

/**
 * The persisted queues: one JSON file per chat session under
 * `<stateDir>/queue/`. Every mutation rewrites the file atomically; writes are
 * serialized per session so two quick clicks cannot interleave.
 */
export class QueueStore {
  #dir
  #queues = new Map()
  #queuesInFlight = new Map()

  /**
   * @param {{ dir: string }} options - where queue files live.
   */
  constructor({ dir }) {
    this.#dir = dir
  }

  /** Read every queue file on disk. */
  async init() {
    this.#queues.clear()
    let entries
    try {
      entries = await readdir(this.#dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const name of entries) {
      if (!name.endsWith('.json') || name.includes('.tmp')) continue
      try {
        const raw = await readFile(path.join(this.#dir, name), 'utf8')
        const record = JSON.parse(raw)
        if (typeof record?.sessionId === 'string') this.#queues.set(record.sessionId, record)
      } catch {
        // One broken file must not take the whole queue list down.
      }
    }
  }

  /**
   * Every queue, newest first.
   * @returns {object[]} queues.
   */
  list() {
    return [...this.#queues.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  }

  /**
   * One queue by session id.
   * @param {string} sessionId - chat session id.
   * @returns {object | undefined} queue.
   */
  get(sessionId) {
    return this.#queues.get(sessionId)
  }

  /**
   * The queue of a session, created (and stored) on first use.
   * @param {string} sessionId - chat session id.
   * @param {{ projectPath?: string | null, now?: number }} options - initial project.
   * @returns {Promise<object>} queue record.
   */
  async ensure(sessionId, { projectPath = null, now = Date.now() } = {}) {
    const existing = this.#queues.get(sessionId)
    if (existing) {
      if (projectPath && existing.projectPath !== projectPath) {
        return this.patch(sessionId, { projectPath, updatedAt: now })
      }
      return existing
    }
    const record = createQueueRecord(sessionId, { projectPath, now })
    this.#queues.set(sessionId, record)
    await this.#persist(sessionId)
    return record
  }

  /**
   * Change top-level fields of a queue.
   * @param {string} sessionId - chat session id.
   * @param {object} changes - fields to merge.
   * @returns {Promise<object | undefined>} the stored queue.
   */
  async patch(sessionId, changes) {
    const record = this.#queues.get(sessionId)
    if (!record) return undefined
    const next = { ...record, ...changes, updatedAt: Date.now() }
    this.#queues.set(sessionId, next)
    await this.#persist(sessionId)
    return next
  }

  /**
   * Replace the queue record wholesale (the runner builds the next state).
   * @param {string} sessionId - chat session id.
   * @param {object} record - next queue record.
   * @returns {Promise<object>} the stored queue.
   */
  async replace(sessionId, record) {
    const next = { ...record, sessionId, updatedAt: Date.now() }
    this.#queues.set(sessionId, next)
    await this.#persist(sessionId)
    return next
  }

  /**
   * Append a task to the queue.
   * @param {string} sessionId - chat session id.
   * @param {object} task - task record.
   * @returns {Promise<object | undefined>} the updated queue.
   */
  async addTask(sessionId, task) {
    const record = this.#queues.get(sessionId)
    if (!record) return undefined
    if (record.tasks.length >= MAX_QUEUE_TASKS) throw new Error('Очередь переполнена')
    record.tasks.push(task)
    record.updatedAt = Date.now()
    await this.#persist(sessionId)
    return record
  }

  /**
   * Change one task, enforcing the status transitions.
   * @param {string} sessionId - chat session id.
   * @param {string} taskId - task id.
   * @param {object} changes - fields to merge.
   * @returns {Promise<{ queue: object, task: object } | undefined>} updated records.
   */
  async updateTask(sessionId, taskId, changes) {
    const record = this.#queues.get(sessionId)
    if (!record) return undefined
    const index = record.tasks.findIndex((task) => task.id === taskId)
    if (index < 0) return undefined
    const current = record.tasks[index]
    if (changes.status !== undefined && !canTransitionTask(current.status, changes.status)) {
      throw new Error(`Задача не может перейти из «${current.status}» в «${changes.status}»`)
    }
    const task = { ...current, ...changes }
    record.tasks[index] = task
    record.updatedAt = Date.now()
    await this.#persist(sessionId)
    return { queue: record, task }
  }

  /**
   * Append an event to the queue feed.
   * @param {string} sessionId - chat session id.
   * @param {{ kind: string, text: string, taskId?: string | null, at?: number }} event - event.
   * @returns {Promise<object | undefined>} the updated queue.
   */
  async appendEvent(sessionId, event) {
    const record = this.#queues.get(sessionId)
    if (!record) return undefined
    const at = event.at ?? Date.now()
    record.eventSeq = (record.eventSeq ?? 0) + 1
    record.events.push({
      seq: record.eventSeq,
      at,
      kind: event.kind,
      text: event.text,
      taskId: event.taskId ?? null,
    })
    if (record.events.length > MAX_QUEUE_EVENTS) record.events = record.events.slice(-MAX_QUEUE_EVENTS)
    record.updatedAt = at
    await this.#persist(sessionId)
    return record
  }

  /**
   * Delete the queue of a session.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<boolean>} whether a queue was removed.
   */
  async remove(sessionId) {
    const existed = this.#queues.delete(sessionId)
    if (!existed) return false
    try {
      await rm(this.#fileOf(sessionId), { force: true })
    } catch {
      // A queue file that is already gone is fine.
    }
    return true
  }

  /**
   * Absolute path of one queue file.
   * @param {string} sessionId - chat session id.
   * @returns {string} file path.
   */
  #fileOf(sessionId) {
    const safe = encodeURIComponent(String(sessionId)).replace(/%/g, '_').slice(0, 160)
    return path.join(this.#dir, `${safe}.json`)
  }

  /**
   * Write one queue file atomically, serialized with the previous write.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<void>} resolves when written.
   */
  async #persist(sessionId) {
    const record = this.#queues.get(sessionId)
    if (!record) return
    const write = async () => {
      await mkdir(this.#dir, { recursive: true })
      const file = this.#fileOf(sessionId)
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(record), 'utf8')
      await rename(temp, file)
    }
    const previous = this.#queuesInFlight.get(sessionId) ?? Promise.resolve()
    const next = previous.then(write, write)
    this.#queuesInFlight.set(sessionId, next)
    await next
  }
}

export default {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  QUEUE_MODES,
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_TASKS,
  MAX_QUEUE_EVENTS,
  QUEUE_TUNING,
  taskTitle,
  isQueueMode,
  queueModeRefusal,
  createQueueRecord,
  createTaskRecord,
  queueCounts,
  queueProgress,
  canTransitionTask,
  nextQueuedTask,
  endsWithQuestion,
  parkedBranch,
  resetMinutes,
  classifyFailure,
  stopReasonLabel,
  resultsCard,
  queueSummary,
  QueueStore,
}
