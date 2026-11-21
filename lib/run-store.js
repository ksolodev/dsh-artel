/**
 * Durable bookkeeping for Artel runs.
 *
 * The run record is a derived cache of what the plugin did: it is not the
 * conversation log (agents keep their own session logs) and never replaces a
 * session event. It lives under the plugin's storage directory as an index plus
 * one JSONL feed per run, so a GUI reload or a restart still shows what happened.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export const STATUSES = ['preparing', 'planning', 'running', 'waiting', 'finished', 'failed', 'interrupted', 'applied', 'discarded']

const TRANSITIONS = {
  preparing: ['planning', 'running', 'failed', 'discarded'],
  planning: ['running', 'waiting', 'failed', 'discarded', 'interrupted'],
  running: ['waiting', 'finished', 'failed', 'discarded', 'interrupted'],
  waiting: ['running', 'finished', 'failed', 'applied', 'discarded', 'interrupted'],
  finished: ['running', 'applied', 'discarded'],
  failed: ['running', 'discarded', 'applied'],
  interrupted: ['running', 'applied', 'discarded'],
  applied: [],
  discarded: [],
}

export function canTransition(from, to) {
  if (from === to) return true
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function isActiveStatus(status) {
  return ['preparing', 'planning', 'running'].includes(status)
}

export function isTerminalStatus(status) {
  return ['applied', 'discarded', 'failed'].includes(status)
}

/**
 * Ids stay short and readable (`fg-<ms in base36>-<4 chars>`) because they are
 * directory names and URL segments. Two runs started in the same millisecond
 * must still get different ids, so the low two base36 characters come from a
 * process counter and only the high two are random; 1296 ids per millisecond is
 * far above anything the plugin can start.
 */
let idCounter = 0

export function newRunId(now = Date.now(), random = Math.random) {
  const stamp = now.toString(36)
  idCounter = (idCounter + 1) % 36 ** 2
  const randomPart = Math.floor(random() * 36 ** 2) * 36 ** 2
  const suffix = (randomPart + idCounter).toString(36).padStart(4, '0')
  return `fg-${stamp}-${suffix}`
}

/** Longest phase hint kept on a run: one short line for the client's session rail. */
export const PHASE_MAX_LENGTH = 120

/**
 * Normalize one phase text: the rail has room for a single short line, so
 * newlines and repeated spaces collapse into one space and the result is capped.
 * @param {unknown} text - raw phase text.
 * @returns {string | undefined} single-line hint of at most PHASE_MAX_LENGTH characters, or undefined when there is no text.
 */
export function phaseText(text) {
  if (typeof text !== 'string') return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length > PHASE_MAX_LENGTH ? line.slice(0, PHASE_MAX_LENGTH) : line
}

/**
 * Turn one feed event into the "what is happening now" hint of a run.
 *
 * Only `status` and `plan` lines are phases: they describe the stage of the run
 * itself, while agent messages and tool calls are conversation, not a phase.
 * @param {{ kind?: unknown, text?: unknown }} event - feed event.
 * @returns {string | undefined} phase hint, or undefined when the event is not a phase.
 */
export function phaseOfFeedEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.kind !== 'status' && event.kind !== 'plan') return undefined
  return phaseText(event.text)
}

/**
 * Client-facing view of the plan an Orchestrator run works from. The worker and
 * reviewer session ids stay on the host: the client only shows what the user
 * needs to follow the parts.
 * @param {object | null | undefined} plan - stored plan.
 * @returns {{ summary: string | null, parts: object[] } | null} plan summary.
 */
export function planSummary(plan) {
  if (plan === null || typeof plan !== 'object') return null
  return {
    summary: typeof plan.summary === 'string' && plan.summary.trim() !== '' ? plan.summary.trim() : null,
    parts: (Array.isArray(plan.parts) ? plan.parts : []).map((part) => ({
      id: String(part?.id ?? ''),
      title: String(part?.title ?? ''),
      goal: String(part?.goal ?? ''),
      conditions: Array.isArray(part?.conditions) ? part.conditions.filter((condition) => typeof condition === 'string') : [],
      files: Array.isArray(part?.files) ? part.files.filter((file) => typeof file === 'string') : [],
      status: String(part?.status ?? 'pending'),
      rounds: part?.rounds ?? 0,
      remarks: typeof part?.remarks === 'string' && part.remarks.trim() !== '' ? part.remarks : null,
      workerName: typeof part?.workerName === 'string' ? part.workerName : null,
      reviewerName: typeof part?.reviewerName === 'string' ? part.reviewerName : null,
    })),
  }
}

/**
 * Client-facing view of the assembly a run produced: which files more than one
 * part edited, and which of them still need a decision.
 * @param {object | null | undefined} merge - stored merge record.
 * @returns {{ conflicts: Array<{ path: string, parts: string[] }>, unresolved: string[], merged: boolean } | null} merge summary.
 */
export function mergeSummary(merge) {
  if (merge === null || typeof merge !== 'object') return null
  return {
    conflicts: (Array.isArray(merge.conflicts) ? merge.conflicts : []).map((conflict) => ({
      path: String(conflict?.path ?? ''),
      parts: Array.isArray(conflict?.parts) ? conflict.parts.filter((label) => typeof label === 'string') : [],
    })),
    unresolved: Array.isArray(merge.unresolved) ? merge.unresolved.filter((path) => typeof path === 'string') : [],
    merged: merge.merged === true,
  }
}

/**
 * Client-facing view of the result of one bundle install.
 * @param {object | null | undefined} result - stored bundle result.
 * @returns {object | null} result summary.
 */
function bundleResultSummary(result) {
  if (result === null || typeof result !== 'object') return null
  return {
    status: typeof result.status === 'string' ? result.status : 'failed',
    application: typeof result.application === 'string' ? result.application : null,
    restartReason: typeof result.restartReason === 'string' ? result.restartReason : null,
    bundle: typeof result.bundle === 'string' ? result.bundle : null,
    version: typeof result.version === 'string' ? result.version : null,
    errorCode: typeof result.errorCode === 'string' ? result.errorCode : null,
    errorMessage: typeof result.errorMessage === 'string' ? result.errorMessage : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning) => typeof warning === 'string') : [],
    at: typeof result.at === 'number' ? result.at : null,
  }
}

/**
 * Client-facing view of what a finished project still needs after Apply: the DSH
 * bundle it declares and the install steps the user may run, with each result.
 * @param {object | null | undefined} install - stored install record.
 * @returns {{ detectedAt: number | null, bundle: object | null, steps: object[], warnings: string[] } | null} install summary.
 */
export function installSummary(install) {
  if (install === null || typeof install !== 'object') return null
  const steps = (Array.isArray(install.steps) ? install.steps : []).map((step, index) => ({
    id: typeof step?.id === 'string' ? step.id : `step-${index + 1}`,
    index,
    title: typeof step?.title === 'string' ? step.title : '',
    command: typeof step?.command === 'string' ? step.command : '',
    origin: step?.origin === 'manifest' ? 'manifest' : 'detected',
    status: typeof step?.status === 'string' ? step.status : 'idle',
    output: typeof step?.output === 'string' ? step.output : null,
    outputTruncated: step?.outputTruncated === true,
    exitCode: typeof step?.exitCode === 'number' ? step.exitCode : null,
    timedOut: step?.timedOut === true,
    startedAt: typeof step?.startedAt === 'number' ? step.startedAt : null,
    finishedAt: typeof step?.finishedAt === 'number' ? step.finishedAt : null,
  }))
  const bundle = install.bundle !== null && typeof install.bundle === 'object'
    ? {
      name: typeof install.bundle.name === 'string' ? install.bundle.name : '',
      version: typeof install.bundle.version === 'string' ? install.bundle.version : null,
      patch: typeof install.bundle.patch === 'string' ? install.bundle.patch : '',
      installable: install.bundle.installable === true,
      status: typeof install.bundle.status === 'string' ? install.bundle.status : null,
      result: bundleResultSummary(install.bundle.result),
    }
    : null
  return {
    detectedAt: typeof install.detectedAt === 'number' ? install.detectedAt : null,
    bundle,
    steps,
    warnings: Array.isArray(install.warnings) ? install.warnings.filter((warning) => typeof warning === 'string') : [],
  }
}

/** Client-facing view of a run: no path hashes, no feed. */
export function toSummary(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    mode: run.mode,
    task: run.task,
    chatTitle: typeof run.chatTitle === 'string' && run.chatTitle !== '' ? run.chatTitle : null,
    projectPath: run.projectPath,
    copyPath: run.copyPath,
    status: run.status,
    error: run.error,
    phase: phaseText(run.phase) ?? null,
    // The catalogue key the phase line came from, so the rail can translate it.
    phaseKey: typeof run.phaseKey === 'string' && run.phaseKey !== '' ? run.phaseKey : null,
    phaseParams: run.phaseParams !== null && typeof run.phaseParams === 'object' ? run.phaseParams : null,
    agents: (run.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      kind: agent.kind ?? null,
      status: agent.status,
      claimed: agent.claimed ?? [],
      sessionId: agent.sessionId ?? null,
      model: agent.model ?? null,
    })),
    plan: planSummary(run.plan),
    merge: mergeSummary(run.merge),
    // What the project still needs after Apply: a DSH bundle to install, or the
    // project's own install steps the user may run from the changes card.
    install: installSummary(run.install),
    // Unattended runs: the version chip in the rail ("Автоочередь"), the version
    // copy this run was seeded from, and the Factory's plan-approval gate.
    autoqueue: run.autoqueue === true,
    basePath: typeof run.basePath === 'string' && run.basePath !== '' ? run.basePath : null,
    planApproval: run.planApproval === true,
    planApproved: run.planApproved === true,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
    appliedAt: run.appliedAt ?? null,
    changeCount: run.changeCount ?? 0,
  }
}

export class RunStore {
  #dir
  #runs = new Map()
  #queue = Promise.resolve()
  #feedQueue = new Map()
  #feedLimits

  constructor({ dir, feedLimitPerRun = 5000 }) {
    this.#dir = dir
    this.#feedLimits = feedLimitPerRun
  }

  get dir() {
    return this.#dir
  }

  #indexPath() {
    return path.join(this.#dir, 'index.json')
  }

  feedPath(runId) {
    return path.join(this.#dir, 'feeds', `${runId}.jsonl`)
  }

  async init() {
    await fs.mkdir(path.join(this.#dir, 'feeds'), { recursive: true })
    try {
      const raw = await fs.readFile(this.#indexPath(), 'utf8')
      const parsed = JSON.parse(raw)
      for (const run of parsed.runs ?? []) this.#runs.set(run.id, run)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this
  }

  list(sessionId) {
    return [...this.#runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  all() {
    return [...this.#runs.values()]
  }

  get(runId) {
    return this.#runs.get(runId)
  }

  #persist() {
    const snapshot = JSON.stringify({ version: 1, runs: [...this.#runs.values()] }, null, 0)
    this.#queue = this.#queue.then(async () => {
      const tmp = `${this.#indexPath()}.tmp`
      await fs.mkdir(this.#dir, { recursive: true })
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.#indexPath())
    }).catch(() => {})
    return this.#queue
  }

  async add(run) {
    if (this.#runs.has(run.id)) throw new Error(`run ${run.id} already exists`)
    this.#runs.set(run.id, run)
    await this.#persist()
    return run
  }

  async patch(runId, changes) {
    const run = this.#runs.get(runId)
    if (!run) throw new Error(`unknown run ${runId}`)
    if (changes.status && !canTransition(run.status, changes.status)) {
      throw new Error(`cannot move run ${runId} from ${run.status} to ${changes.status}`)
    }
    const next = { ...run, ...changes, updatedAt: changes.updatedAt ?? Date.now() }
    this.#runs.set(runId, next)
    await this.#persist()
    return next
  }

  /**
   * Append feed events, assigning monotonically increasing seq numbers.
   *
   * Appends are serialized per run and the record is read again after the file
   * write: a status or changeCount patch that lands while the feed is being
   * written must survive this bookkeeping update. Without both, a concurrent
   * appendFeed could write back the stale copy it captured before the patch and
   * silently move a waiting run back to running.
   */
  appendFeed(runId, events) {
    if (!this.#runs.has(runId)) return Promise.reject(new Error(`unknown run ${runId}`))
    const incoming = (Array.isArray(events) ? events : [events]).filter(Boolean)
    if (incoming.length === 0) return Promise.resolve({ cursor: this.#runs.get(runId).feedSeq ?? 0 })
    const previous = this.#feedQueue.get(runId) ?? Promise.resolve()
    const job = previous.then(() => this.#appendFeedNow(runId, incoming))
    const tail = job.then(() => {}, () => {})
    this.#feedQueue.set(runId, tail)
    void tail.then(() => {
      if (this.#feedQueue.get(runId) === tail) this.#feedQueue.delete(runId)
    })
    return job
  }

  async #appendFeedNow(runId, incoming) {
    const run = this.#runs.get(runId)
    if (!run) throw new Error(`unknown run ${runId}`)
    let seq = run.feedSeq ?? 0
    const lines = []
    for (const event of incoming) {
      seq += 1
      lines.push(JSON.stringify({ seq, at: event.at ?? Date.now(), ...event }))
    }
    await fs.mkdir(path.join(this.#dir, 'feeds'), { recursive: true })
    await fs.appendFile(this.feedPath(runId), `${lines.join('\n')}\n`, 'utf8')
    // Read the record again: a patch may have landed while the file was written.
    const current = this.#runs.get(runId) ?? run
    const next = { ...current, feedSeq: seq, updatedAt: Date.now() }
    this.#runs.set(runId, next)
    await this.#persist()
    if (seq > this.#feedLimits) await this.#trimFeed(runId, seq)
    return { cursor: seq }
  }

  async #trimFeed(runId, seq) {
    const file = this.feedPath(runId)
    const raw = await fs.readFile(file, 'utf8').catch(() => '')
    const rows = raw.split('\n').filter(Boolean)
    const keep = rows.slice(-this.#feedLimits)
    await fs.writeFile(file, keep.length > 0 ? `${keep.join('\n')}\n` : '', 'utf8')
    const run = this.#runs.get(runId)
    if (run) {
      const first = keep.length > 0 ? JSON.parse(keep[0]).seq : seq + 1
      this.#runs.set(runId, { ...run, feedFloor: first })
      await this.#persist()
    }
  }

  /** Read feed events after `cursor` (a seq number). */
  async readFeed(runId, { cursor = 0, limit = 500 } = {}) {
    const raw = await fs.readFile(this.feedPath(runId), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const events = []
    let last = cursor
    for (const line of raw.split('\n')) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.seq <= cursor) continue
      events.push(event)
      last = event.seq
      if (events.length >= limit) break
    }
    return { events, cursor: last }
  }

  async remove(runId) {
    this.#runs.delete(runId)
    await this.#persist()
    await fs.rm(this.feedPath(runId), { force: true })
  }
}
