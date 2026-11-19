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
  planning: ['running', 'failed', 'discarded', 'interrupted'],
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

export function newRunId(now = Date.now(), random = Math.random) {
  const stamp = now.toString(36)
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')
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

/** Client-facing view of a run: no path hashes, no feed. */
export function toSummary(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    mode: run.mode,
    task: run.task,
    projectPath: run.projectPath,
    copyPath: run.copyPath,
    status: run.status,
    error: run.error,
    phase: phaseText(run.phase) ?? null,
    agents: (run.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      kind: agent.kind ?? null,
      status: agent.status,
      claimed: agent.claimed ?? [],
      sessionId: agent.sessionId ?? null,
    })),
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

  /** Append feed events, assigning monotonically increasing seq numbers. */
  async appendFeed(runId, events) {
    const run = this.#runs.get(runId)
    if (!run) throw new Error(`unknown run ${runId}`)
    const incoming = (Array.isArray(events) ? events : [events]).filter(Boolean)
    if (incoming.length === 0) return { cursor: run.feedSeq ?? 0 }
    let seq = run.feedSeq ?? 0
    const lines = []
    for (const event of incoming) {
      seq += 1
      lines.push(JSON.stringify({ seq, at: event.at ?? Date.now(), ...event }))
    }
    await fs.mkdir(path.join(this.#dir, 'feeds'), { recursive: true })
    await fs.appendFile(this.feedPath(runId), `${lines.join('\n')}\n`, 'utf8')
    const next = { ...run, feedSeq: seq, updatedAt: Date.now() }
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
