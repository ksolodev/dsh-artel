/**
 * The Artel run engine.
 *
 * Owns no DSH API: every interaction with the harness goes through the small
 * `driver` port, so the whole orchestration can be exercised with a fake driver
 * in tests. Host code binds the real driver in lib/index.js.
 *
 * A run is:
 *   preparing → copy of the project → one agent (solo) or three agents (swarm)
 *   planning  → (swarm only) agents announce file ownership, nothing is edited
 *   running   → agents work in the copy
 *   waiting   → every agent is idle, the user reviews the diff
 *   applied / discarded / failed / interrupted
 *
 * The project itself is never written by a run; only `apply()` writes to it.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { applyChanges, collectChanges, copyProjectTree, preflightApply, removeCopy, sweepCopies } from './copy.js'
import { parseClaim, parseOwnership, assignOwnership, describeOwnership } from './ownership.js'
import { collisionNotice, soloPrompt, swarmGoPrompt, swarmPlanPrompt, userMessagePrompt } from './prompts.js'
import { diffFile } from './diff.js'
import { newRunId, toSummary } from './run-store.js'

/** Names for swarm members: short, pronounceable, stable across a run. */
export const AGENT_NAMES = ['Vega', 'Orion', 'Lyra', 'Atlas', 'Nova', 'Rhea', 'Mira', 'Kai']

/** Agent statuses used by the client panel. */
export const AGENT_STATUSES = ['starting', 'planning', 'working', 'idle', 'failed']

const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'multiedit', 'patch', 'str_replace_editor'])

const DEFAULT_CONFIG = {
  swarmAgentCount: 3,
  maxRunsPerSession: 10,
  keepCopiesHours: 72,
  diffContext: 3,
  idleGraceMs: 0,
}

/**
 * The `send_message` name for one swarm agent.
 *
 * Subagent names are the shared address every member types into `send_message`,
 * so they must follow the subagent rules (lowercase letters, digits, hyphens,
 * starting with a letter, never "lead") even though the display name is
 * "Orion".
 * @param {string} name - display name chosen for the agent.
 * @returns {string} subagent-safe address.
 */
function agentAddress(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  if (slug === '') return 'agent'
  const safe = /^[a-z]/.test(slug) ? slug : `agent-${slug}`
  const trimmed = safe.replace(/-+$/g, '')
  return trimmed === 'lead' ? 'lead-2' : trimmed
}

export class ArtelError extends Error {
  constructor(message, status = 400, code = 'artel/bad-request') {
    super(message)
    this.name = 'ArtelError'
    this.status = status
    this.code = code
  }
}

export class ArtelEngine {
  #store
  #driver
  #copyRoot
  #config
  #log
  #now
  #runs = new Map()
  #feedQueues = new Map()
  #closed = false

  constructor({ store, driver, copyRoot, config = {}, log = console, now = () => Date.now() }) {
    this.#store = store
    this.#driver = driver
    this.#copyRoot = copyRoot
    this.#config = { ...DEFAULT_CONFIG, ...config }
    this.#log = log
    this.#now = now
  }

  get config() {
    return this.#config
  }

  get copyRoot() {
    return this.#copyRoot
  }

  async init() {
    await this.#store.init()
    const keep = new Set()
    for (const run of this.#store.all()) {
      if (['preparing', 'planning', 'running'].includes(run.status)) {
        await this.#store.patch(run.id, { status: 'interrupted', error: 'The plugin restarted during this run.' })
        await this.#store.appendFeed(run.id, {
          kind: 'status',
          text: 'The plugin restarted, so this run was interrupted. The diff is still available.',
        })
      }
      if (run.copyPath && !['applied', 'discarded'].includes(run.status)) keep.add(path.basename(run.copyPath))
    }
    await sweepCopies(this.#copyRoot, keep).catch((error) => this.#log.warn?.(`artel: copy sweep failed: ${error.message}`))
    return this
  }

  /* ------------------------------------------------------------------ reads */

  listRuns(sessionId) {
    return this.#store.list(sessionId).map((run) => this.#summary(run))
  }

  getRun(runId) {
    return this.#summary(this.#requireRun(runId))
  }

  async readFeed(runId, { cursor = 0, limit = 500 } = {}) {
    this.#requireRun(runId)
    return this.#store.readFeed(runId, { cursor, limit })
  }

  #summary(run) {
    return toSummary(run)
  }

  /**
   * Keep at most `maxRunsPerSession` decided runs per session: the newest ones
   * stay reviewable, the oldest are dropped with their copies. Runs that still
   * need the user (waiting) are never pruned.
   */
  async #pruneRuns(sessionId) {
    const limit = Math.max(1, Number(this.#config.maxRunsPerSession) || 10)
    const runs = this.#store.list(sessionId)
    if (runs.length <= limit) return
    const decided = ['applied', 'discarded', 'failed', 'interrupted', 'finished']
    for (const run of runs.slice(limit)) {
      if (!decided.includes(run.status)) continue
      if (run.copyPath) await removeCopy(this.#copyRoot, run.copyPath).catch(() => {})
      await this.#store.remove(run.id).catch(() => {})
    }
  }

  #requireRun(runId) {
    const run = this.#store.get(runId)
    if (!run) throw new ArtelError(`Unknown run ${runId}`, 404, 'artel/unknown-run')
    return run
  }

  #runtime(runId) {
    return this.#runs.get(runId)
  }

  /* -------------------------------------------------------------- lifecycle */

  async start({ sessionId, projectPath, mode, task }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new ArtelError('Missing session')
    if (typeof projectPath !== 'string' || projectPath === '') throw new ArtelError('Missing project directory')
    if (mode !== 'solo' && mode !== 'swarm') throw new ArtelError('Mode must be solo or swarm')
    if (typeof task !== 'string' || task.trim() === '') throw new ArtelError('Describe the task first')
    if (this.#closed) throw new ArtelError('The plugin is shutting down', 503, 'artel/closed')

    const project = path.resolve(projectPath)
    const stat = await fs.stat(project).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new ArtelError('The project directory does not exist', 400, 'artel/no-project')
    if (this.#store.list(sessionId).some((run) => ['preparing', 'planning', 'running'].includes(run.status))) {
      throw new ArtelError('Another run is already in progress in this session', 409, 'artel/busy')
    }

    const runId = newRunId(this.#now())
    const copyPath = path.join(this.#copyRoot, runId)
    const createdAt = this.#now()
    const count = mode === 'swarm' ? Math.max(1, Number(this.#config.swarmAgentCount) || 3) : 1
    const names = AGENT_NAMES.slice(0, count)
    const run = {
      id: runId,
      sessionId,
      mode,
      task: task.trim(),
      projectPath: project,
      copyPath,
      copyKind: 'directory',
      baseHashes: {},
      status: 'preparing',
      error: null,
      agents: names.map((name, index) => ({
        id: `${runId}-a${index + 1}`,
        name,
        role: mode === 'swarm' ? 'swarm' : 'solo',
        status: 'starting',
        claimed: [],
      })),
      createdAt,
      updatedAt: createdAt,
      changeCount: 0,
      feedSeq: 0,
    }
    await this.#store.add(run)
    await this.#pruneRuns(sessionId)
    await this.#feed(runId, { kind: 'status', text: `Preparing a copy of ${path.basename(project)}.` })

    // `sessions` maps a live Session id back to its agent row so peer messages
    // can name the sender; `addresses` holds the `send_message` name of every
    // member of a shared-conversation swarm (null for legacy independent runs).
    const runtime = {
      agents: new Map(),
      base: {},
      byPath: new Map(),
      planningRounds: 0,
      sessions: new Map(),
      addresses: null,
      idleTimer: null,
    }
    this.#runs.set(runId, runtime)

    try {
      const copied = await copyProjectTree(project, copyPath, {
        exclude: this.#config.excludeGlobs ?? [],
      })
      runtime.base = copied.base
      await this.#store.patch(runId, { baseHashes: copied.base, copyKind: 'directory' })
      await this.#feed(runId, {
        kind: 'status',
        text: `Copy ready: ${copied.files} files${copied.linkedNodeModules ? ', node_modules linked' : ''}.`,
      })
    } catch (error) {
      await this.#fail(runId, error)
      throw new ArtelError(`Could not copy the project: ${error.message}`, 500, 'artel/copy-failed')
    }

    // Swarm runs go peer-first: when the profile provides the subagent stack,
    // the three agents live in ONE conversation tree and can message each other.
    // Without it, the legacy independent-session swarm still works.
    const peerSwarm = mode === 'swarm' && run.agents.length > 1 && this.#driver.supportsPeers?.() === true
    try {
      if (peerSwarm) {
        await this.#startPeerSwarm(runId, run, runtime, { project, copyPath })
      } else {
        for (const agent of run.agents) {
          const handle = await this.#driver.createAgent({
            name: agent.name,
            mode,
            projectPath: project,
            copyPath,
            agentId: agent.id,
            title: `Artel · ${agent.name} — ${task.length > 48 ? `${task.slice(0, 48)}…` : task}`,
          })
          this.#register(runId, runtime, agent, handle)
        }
        await this.#syncAgents(runId, runtime, 'planning')

        if (mode === 'solo') {
          await this.#store.patch(runId, { status: 'running' })
          await this.#feed(runId, { kind: 'status', text: `${names[0]} is starting on the task.` })
          const rt = [...runtime.agents.values()][0]
          await this.#send(runId, rt, soloPrompt({ copyPath, projectPath: project, task: run.task }))
        } else {
          await this.#store.patch(runId, { status: 'planning' })
          await this.#feed(runId, { kind: 'status', text: 'All three agents are reading the project and dividing the work. Nothing is edited in this step.' })
          for (const rt of runtime.agents.values()) {
            await this.#send(runId, rt, swarmPlanPrompt({
              copyPath,
              projectPath: project,
              task: run.task,
              peers: names.filter((name) => name !== rt.record.name),
              selfName: rt.record.name,
            }))
          }
        }
      }
    } catch (error) {
      await this.#fail(runId, error)
      throw new ArtelError(`Could not start the agents: ${error.message}`, 500, 'artel/agent-failed')
    }

    return this.#summary(this.#requireRun(runId))
  }

  /**
   * Start a swarm whose agents share one agent tree: the first agent is an
   * ordinary Session and the tree root (`lead`), the others are its continuable
   * subagents. The subagent runtime frames every cross-agent message, so the
   * team can really talk while it divides the work.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - engine runtime for the run.
   * @param {{ project: string, copyPath: string }} paths - project and copy.
   */
  async #startPeerSwarm(runId, run, runtime, { project, copyPath }) {
    const lead = run.agents[0]
    const members = run.agents.slice(1)
    const addresses = new Map([[lead.id, 'lead']])
    for (const member of members) addresses.set(member.id, agentAddress(member.name))
    runtime.addresses = addresses

    const title = run.task.length > 48 ? `${run.task.slice(0, 48)}…` : run.task
    const leadHandle = await this.#driver.createAgent({
      name: lead.name,
      mode: run.mode,
      projectPath: project,
      copyPath,
      agentId: lead.id,
      title: `Artel · ${lead.name} — ${title}`,
    })
    this.#register(runId, runtime, lead, leadHandle)

    const peersOf = (agent) => run.agents
      .filter((peer) => peer.id !== agent.id)
      .map((peer) => ({ name: peer.name, address: addresses.get(peer.id) ?? null }))

    for (const member of members) {
      const planText = swarmPlanPrompt({
        copyPath,
        projectPath: project,
        task: run.task,
        peers: peersOf(member),
        selfName: member.name,
        selfAddress: addresses.get(member.id),
        canMessage: true,
      })
      const handle = await this.#driver.spawnMember({
        parent: leadHandle,
        name: addresses.get(member.id),
        displayName: member.name,
        label: `Artel swarm · ${member.name}`,
        promptText: planText,
        copyPath,
        projectPath: project,
        agentId: member.id,
        mode: run.mode,
      })
      this.#register(runId, runtime, member, handle)
    }

    // The members started their planning turn when they were spawned; the lead's
    // prompt is delivered here so the whole team is already in the tree.
    await this.#syncAgents(runId, runtime, 'working')
    await this.#store.patch(runId, { status: 'planning' })
    const roster = run.agents.map((agent) => agent.name)
    const others = roster.slice(1)
    const sentence = others.length === 1
      ? `${roster[0]} and ${others[0]} are`
      : `${roster.slice(0, -1).join(', ')} and ${others[others.length - 1]} are`
    await this.#feed(runId, {
      kind: 'status',
      text: `${sentence} reading the project and dividing the work. They can message each other; nothing is edited in this step.`,
    })
    const leadRt = runtime.agents.get(lead.id)
    await this.#send(runId, leadRt, swarmPlanPrompt({
      copyPath,
      projectPath: project,
      task: run.task,
      peers: peersOf(lead),
      selfName: lead.name,
      selfAddress: addresses.get(lead.id),
      canMessage: true,
    }))
  }

  /**
   * Attach one created agent to its runtime row.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {object} agent - stored agent record.
   * @param {object} handle - driver handle.
   * @returns {object} the refreshed agent record.
   */
  #register(runId, runtime, agent, handle) {
    const unsubscribe = this.#driver.subscribe(handle, (event) => this.#onAgentEvent(runId, agent.id, event))
    const record = {
      ...agent,
      kind: handle?.kind ?? 'session',
      sessionId: handle?.sessionId ?? null,
    }
    runtime.agents.set(agent.id, { record, handle, unsubscribe, done: false, planText: '', lastText: '' })
    if (typeof handle?.sessionId === 'string') runtime.sessions.set(handle.sessionId, agent.id)
    return record
  }

  /**
   * Persist the live state of every agent back into the run record.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {string} [status] - override for every agent status.
   * @returns {Promise<object[]>} stored agent records.
   */
  async #syncAgents(runId, runtime, status) {
    const run = this.#requireRun(runId)
    const agents = run.agents.map((agent) => {
      const rt = runtime.agents.get(agent.id)
      if (!rt) return agent
      return {
        ...agent,
        ...rt.record,
        status: status ?? rt.record.status,
        sessionId: rt.record.sessionId ?? null,
      }
    })
    await this.#store.patch(runId, { agents })
    for (const [agentId, rt] of runtime.agents) {
      const record = agents.find((agent) => agent.id === agentId)
      if (record) rt.record = record
    }
    return agents
  }

  async message(runId, { text, agentId } = {}) {
    const run = this.#requireRun(runId)
    if (typeof text !== 'string' || text.trim() === '') throw new ArtelError('Write a message first')
    const runtime = this.#runtime(runId)
    if (!runtime) throw new ArtelError('This run is no longer active', 409, 'artel/not-live')

    const targets = agentId === undefined || agentId === 'all'
      ? [...runtime.agents.values()]
      : [[...runtime.agents.values()].find((rt) => rt.record.id === agentId)].filter(Boolean)
    if (targets.length === 0) throw new ArtelError('Unknown agent', 404, 'artel/unknown-agent')

    if (run.status === 'planning') throw new ArtelError('Wait until the agents finish dividing the work', 409, 'artel/planning')
    if (!['running', 'waiting', 'finished', 'failed', 'interrupted'].includes(run.status)) {
      throw new ArtelError(`You cannot message a ${run.status} run`, 409, 'artel/bad-status')
    }
    if (run.status !== 'running') await this.#store.patch(runId, { status: 'running', error: null })

    for (const rt of targets) {
      const broadcast = targets.length > 1
      await this.#feed(runId, { kind: 'user', text: text.trim(), agent: rt.record.name })
      rt.done = false
      await this.#send(runId, rt, userMessagePrompt({ text: text.trim(), broadcast, agentName: rt.record.name }))
    }
    return this.#summary(this.#requireRun(runId))
  }

  async interrupt(runId) {
    const run = this.#requireRun(runId)
    if (!['preparing', 'planning', 'running', 'waiting'].includes(run.status)) {
      throw new ArtelError(`This run is already ${run.status}`, 409, 'artel/bad-status')
    }
    const runtime = this.#runtime(runId)
    if (runtime) {
      this.#cancelIdleCheck(runId)
      for (const rt of runtime.agents.values()) {
        await Promise.resolve(this.#driver.interrupt(rt.handle)).catch(() => {})
      }
    }
    await this.#store.patch(runId, { status: 'interrupted' })
    await this.#feed(runId, { kind: 'status', text: 'You stopped the run. The copy is still here, so the diff stays available.' })
    return this.#summary(this.#requireRun(runId))
  }

  /* ---------------------------------------------------------------- review */

  async changes(runId) {
    const run = this.#requireRun(runId)
    if (!run.copyPath) return []
    const changes = await collectChanges({
      copyRoot: run.copyPath,
      beforeRoot: run.projectPath,
      base: run.baseHashes ?? {},
      options: { exclude: this.#config.excludeGlobs ?? [], context: this.#config.diffContext },
    })
    return changes.map((change) => ({
      path: change.path,
      status: change.status,
      added: change.added,
      removed: change.removed,
      binary: change.binary === true,
      hunks: (change.hunks ?? []).map((hunk) => ({
        header: hunk.header,
        lines: hunk.lines,
      })),
    }))
  }

  async fileDiff(runId, relPath) {
    const run = this.#requireRun(runId)
    if (typeof relPath !== 'string' || relPath === '') throw new ArtelError('Missing file path')
    const before = await fs.readFile(path.join(run.projectPath, relPath), 'utf8').catch(() => null)
    const after = await fs.readFile(path.join(run.copyPath, relPath), 'utf8').catch(() => null)
    return diffFile({ path: relPath, before, after, context: this.#config.diffContext })
  }

  async changeCount(runId) {
    const changes = await this.changes(runId)
    return changes.length
  }

  async apply(runId, paths) {
    const run = this.#requireRun(runId)
    if (!['waiting', 'finished', 'interrupted', 'failed'].includes(run.status)) {
      throw new ArtelError(`You cannot apply a ${run.status} run`, 409, 'artel/bad-status')
    }
    const changes = await collectChanges({
      copyRoot: run.copyPath,
      beforeRoot: run.projectPath,
      base: run.baseHashes ?? {},
      options: { exclude: this.#config.excludeGlobs ?? [] },
    })
    if (changes.length === 0) throw new ArtelError('There is nothing to apply', 409, 'artel/no-changes')
    const preflight = await preflightApply({
      projectRoot: run.projectPath,
      copyRoot: run.copyPath,
      base: run.baseHashes ?? {},
      changes,
      paths,
    })
    if (preflight.blocked.length > 0) {
      const reasons = preflight.blocked.map((skip) => `${skip.path}: ${skip.reason}`).join('; ')
      throw new ArtelError(`Nothing was applied. ${reasons}`, 409, 'artel/apply-conflict')
    }
    if (preflight.ready.length === 0) throw new ArtelError('There is nothing selected to apply', 409, 'artel/no-changes')
    const result = await applyChanges({
      projectRoot: run.projectPath,
      copyRoot: run.copyPath,
      base: run.baseHashes ?? {},
      changes,
      paths: preflight.ready,
    })
    if (result.applied.length === 0) {
      const reasons = result.skipped.map((skip) => `${skip.path}: ${skip.reason}`).join('; ')
      throw new ArtelError(`Nothing was applied. ${reasons}`, 409, 'artel/apply-conflict')
    }
    await this.#store.patch(runId, { status: 'applied', appliedAt: this.#now() })
    await this.#feed(runId, {
      kind: 'status',
      text: `Applied ${result.applied.length} file${result.applied.length === 1 ? '' : 's'} to your project.`,
    })
    await this.#retire(runId)
    return { applied: result.applied, skipped: result.skipped }
  }

  async #retire(runId) {
    const runtime = this.#runs.get(runId)
    if (!runtime) return
    this.#cancelIdleCheck(runId)
    for (const rt of runtime.agents.values()) {
      await Promise.resolve(this.#driver.interrupt?.(rt.handle)).catch(() => {})
      this.#unsubscribe(rt)
      await Promise.resolve(this.#driver.release?.(rt.handle)).catch(() => {})
    }
    this.#runs.delete(runId)
  }

  async discard(runId) {
    const run = this.#requireRun(runId)
    if (['applied', 'discarded'].includes(run.status)) throw new ArtelError(`This run is already ${run.status}`, 409, 'artel/bad-status')
    const runtime = this.#runtime(runId)
    this.#cancelIdleCheck(runId)
    if (runtime) {
      for (const rt of runtime.agents.values()) {
        await Promise.resolve(this.#driver.interrupt(rt.handle)).catch(() => {})
        this.#unsubscribe(rt)
        await Promise.resolve(this.#driver.release?.(rt.handle)).catch(() => {})
      }
      this.#runs.delete(runId)
    }
    await removeCopy(this.#copyRoot, run.copyPath).catch(() => {})
    await this.#store.patch(runId, { status: 'discarded' })
    return this.#summary(this.#requireRun(runId))
  }

  /* ------------------------------------------------------------- internals */

  async #send(runId, rt, text) {
    this.#cancelIdleCheck(runId)
    const runtime = this.#runtime(runId)
    const record = runtime ? this.#store.get(runId)?.agents.find((agent) => agent.id === rt.record.id) : undefined
    if (record) rt.record = record
    if (rt.record.status !== 'working') {
      rt.record = { ...rt.record, status: 'working' }
      await this.#patchAgent(runId, rt.record)
    }
    await this.#driver.prompt(rt.handle, text)
  }

  async #patchAgent(runId, agentRecord) {
    const run = this.#requireRun(runId)
    const agents = run.agents.map((agent) => (agent.id === agentRecord.id ? { ...agent, ...agentRecord } : agent))
    await this.#store.patch(runId, { agents })
  }

  async #onAgentEvent(runId, agentId, event) {
    if (this.#closed) return
    const run = this.#store.get(runId)
    if (!run) return
    const runtime = this.#runtime(runId)
    if (!runtime) return
    const rt = runtime.agents.get(agentId)
    if (!rt) return

    if (event.kind === 'turn-start') {
      await this.#onTurnStart(runId, runtime, rt)
      return
    }
    if (event.kind === 'peer') {
      await this.#onPeerMessage(runId, runtime, rt, event)
      return
    }
    if (event.kind === 'turn-end') {
      await this.#onTurnEnd(runId, rt)
      return
    }
    if (event.kind === 'tool' && event.path && EDIT_TOOLS.has(event.tool)) {
      await this.#noteEdit(runId, run, runtime, rt, event.path)
    }
    const feedEvent = { kind: event.kind, agent: rt.record.name }
    if (event.text !== undefined) feedEvent.text = String(event.text)
    if (event.tool !== undefined) feedEvent.tool = String(event.tool)
    if (event.path !== undefined) feedEvent.path = String(event.path)
    if (event.kind === 'assistant' && typeof event.text === 'string') {
      rt.lastText = event.text
      if (run.status === 'planning') rt.planText += `${event.text}\n`
    }
    await this.#feed(runId, feedEvent)
  }

  /**
   * An agent started a turn — it was prompted by Artel, or a peer woke it. The
   * run cannot be "waiting" while somebody is still talking.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {object} rt - agent runtime row.
   */
  async #onTurnStart(runId, runtime, rt) {
    this.#cancelIdleCheck(runId)
    const run = this.#store.get(runId)
    if (!run) return
    rt.done = false
    if (run.status === 'waiting') {
      await this.#store.patch(runId, { status: 'running' })
      await this.#feed(runId, { kind: 'status', text: 'A teammate is still working, so the run continues.' })
    }
    if (rt.record.status !== 'working') {
      rt.record = { ...rt.record, status: 'working' }
      await this.#patchAgent(runId, rt.record)
    }
  }

  /**
   * One member sent another member a message: it belongs in the shared feed,
   * attributed to the sender, because this is the whole point of the peer swarm.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {object} rt - recipient runtime row.
   * @param {object} event - driver peer event.
   */
  async #onPeerMessage(runId, runtime, rt, event) {
    this.#cancelIdleCheck(runId)
    const senderId = typeof event.senderSessionId === 'string' ? runtime.sessions.get(event.senderSessionId) : undefined
    const sender = senderId !== undefined ? runtime.agents.get(senderId) : undefined
    const feedEvent = {
      kind: 'peer',
      from: sender?.record.name ?? 'a teammate',
      agent: rt.record.name,
      text: String(event.text ?? ''),
    }
    if (typeof event.senderSessionId === 'string') feedEvent.senderSessionId = event.senderSessionId
    await this.#feed(runId, feedEvent)
  }

  async #noteEdit(runId, run, runtime, rt, rawPath) {
    let rel = String(rawPath).replace(/\\/g, '/')
    if (path.isAbsolute(rel)) rel = path.relative(run.copyPath, rel).replace(/\\/g, '/')
    if (rel === '' || rel.startsWith('..')) return
    const owner = runtime.byPath.get(rel)
    runtime.byPath.set(rel, rt.record.id)
    if (owner && owner !== rt.record.id) {
      const ownerRt = [...runtime.agents.values()].find((candidate) => candidate.record.id === owner)
      const text = collisionNotice({
        path: rel,
        ownerName: ownerRt?.record.name ?? 'another agent',
        ownerAgentName: rt.record.name,
        ownerAddress: runtime.addresses?.get(owner) ?? null,
        canMessage: runtime.addresses !== null && runtime.addresses !== undefined,
      })
      await this.#feed(runId, { kind: 'collision', text, path: rel, agent: rt.record.name })
    }
  }

  async #onTurnEnd(runId, rt) {
    const run = this.#store.get(runId)
    if (!run) return
    if (rt.done) return
    rt.done = true
    rt.record = { ...rt.record, status: 'idle' }
    await this.#patchAgent(runId, rt.record)
    const runtime = this.#runtime(runId)
    if (!runtime) return
    const allIdle = [...runtime.agents.values()].every((candidate) => candidate.done)
    if (!allIdle) return
    await this.#scheduleIdleCheck(runId)
  }

  /**
   * Wait a little before declaring the run idle when the agents can message each
   * other: a peer message may arrive right after a turn ends, and a transient
   * "everyone is idle" would be a lie. With `idleGraceMs = 0` (tests) the check
   * runs inline so runs stay deterministic.
   * @param {string} runId - run id.
   */
  async #scheduleIdleCheck(runId) {
    const runtime = this.#runtime(runId)
    if (!runtime) return
    this.#cancelIdleCheck(runId)
    const grace = Math.max(0, Number(this.#config.idleGraceMs) || 0)
    if (grace === 0) {
      await this.#settleIdle(runId)
      return
    }
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      this.#settleIdle(runId).catch((error) => this.#log.warn?.(`artel: idle check failed: ${error.message}`))
    }, grace)
    runtime.idleTimer.unref?.()
  }

  #cancelIdleCheck(runId) {
    const runtime = this.#runtime(runId)
    if (!runtime?.idleTimer) return
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }

  /**
   * The team really is idle: settle the planning turn, or publish the diff.
   * @param {string} runId - run id.
   */
  async #settleIdle(runId) {
    if (this.#closed) return
    const run = this.#store.get(runId)
    const runtime = this.#runtime(runId)
    if (!run || !runtime) return
    // A turn may have started while the grace timer was pending.
    if (![...runtime.agents.values()].every((candidate) => candidate.done)) return

    if (run.status === 'planning') {
      await this.#settlePlanning(runId)
      return
    }
    if (run.status !== 'running') return

    const changes = await this.changes(runId).catch(() => [])
    const after = this.#store.get(runId)
    if (!after || after.status !== 'running') return
    await this.#store.patch(runId, { status: 'waiting', changeCount: changes.length })
    const summary = changes.length === 0
      ? 'Every agent is idle. There are no changes yet.'
      : `Every agent is idle. ${changes.length} file${changes.length === 1 ? '' : 's'} changed — review the diff and apply what you like.`
    await this.#feed(runId, { kind: 'status', text: summary })
  }

  async #settlePlanning(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime) return
    this.#cancelIdleCheck(runId)
    const addresses = runtime.addresses ?? null
    const canMessage = addresses !== null && addresses.size > 1
    const peersOf = (agentId) => run.agents
      .filter((agent) => agent.id !== agentId)
      .map((agent) => ({ name: agent.name, address: addresses?.get(agent.id) ?? null }))
    const claimants = run.agents.map((agent) => {
      const rt = runtime.agents.get(agent.id)
      return { id: agent.id, name: agent.name, text: rt?.planText ?? '', claims: parseOwnership(rt?.planText ?? '') }
    })

    let resolved = claimants
    if (claimants.every((claimant) => claimant.claims.length === 0)) {
      runtime.planningRounds = (runtime.planningRounds ?? 0) + 1
      if (runtime.planningRounds <= 1) {
        await this.#feed(runId, { kind: 'status', text: 'No ownership lines were announced. Asking the agents to divide the work again.' })
        const retry = canMessage
          ? 'You did not announce any files. Reply with exactly one line `OWNERSHIP: <paths>` naming the files or folders you will edit. Do not edit anything yet. If you must agree with a teammate first, send them one short message.'
          : 'You did not announce any files. Reply with exactly one line `OWNERSHIP: <paths>` naming the files or folders you will edit. Do not edit anything yet.'
        for (const rt of runtime.agents.values()) {
          rt.done = false
          await this.#send(runId, rt, retry)
        }
        return
      }
      resolved = await this.#fallbackClaims(run, runtime)
      await this.#feed(runId, { kind: 'status', text: 'Nobody announced ownership twice, so Artel split the top level of the project between the agents.' })
    }

    const projectFiles = Object.keys(run.baseHashes ?? {})
    const { assignments, conflicts } = assignOwnership(
      resolved.map((claimant) => ({ id: claimant.id, name: claimant.name, claims: claimant.claims })),
      { files: projectFiles },
    )
    const agents = run.agents.map((agent) => ({
      ...agent,
      claimed: (assignments[agent.id] ?? []).map((claim) => claim.raw),
      status: 'working',
    }))
    await this.#store.patch(runId, { agents, status: 'running' })

    const map = describeOwnership(agents, assignments)
    const nameById = new Map(agents.map((agent) => [agent.id, agent.name]))
    await this.#feed(runId, {
      kind: 'plan',
      text: `Work divided.\n${map}${conflicts.length > 0 ? `\n\nContested (first claim wins):\n${conflicts.map((conflict) => `${conflict.path} — ${conflict.claimedByName} claimed it, ${nameById.get(conflict.owner) ?? 'the first claimant'} keeps it`).join('\n')}` : ''}`,
      map,
    })

    for (const rt of runtime.agents.values()) {
      rt.done = false
      const ownClaims = (assignments[rt.record.id] ?? []).map((claim) => claim.raw)
      await this.#send(runId, rt, swarmGoPrompt({
        copyPath: run.copyPath,
        ownershipMap: map,
        ownClaims,
        contested: conflicts
          .filter((conflict) => conflict.claimedBy === rt.record.id)
          .map((conflict) => ({ ...conflict, ownerName: nameById.get(conflict.owner) ?? 'the first claimant' })),
        task: run.task,
        peers: peersOf(rt.record.id),
        selfAddress: addresses?.get(rt.record.id) ?? null,
        canMessage,
      }))
    }
  }

  /** Last resort when nobody announced anything: split top-level entries round-robin. */
  async #fallbackClaims(run, runtime) {
    const entries = await fs.readdir(run.copyPath).catch(() => [])
    const usable = entries.filter((entry) => !['node_modules', '.git', '.dsh-artel'].includes(entry)).sort()
    const agents = [...runtime.agents.values()]
    return agents.map((rt, index) => ({
      id: rt.record.id,
      name: rt.record.name,
      claims: usable
        .filter((_, position) => position % agents.length === index)
        .map((entry) => parseClaim(`${entry}/**`))
        .filter(Boolean),
    }))
  }

  #unsubscribe(rt) {
    try {
      rt.unsubscribe?.()
    } catch {
      /* the driver may already be gone */
    }
  }

  async #feed(runId, event) {
    const previous = this.#feedQueues.get(runId) ?? Promise.resolve()
    const next = previous
      .then(() => this.#store.appendFeed(runId, event))
      .catch((error) => this.#log.warn?.(`artel: could not append feed for ${runId}: ${error.message}`))
    this.#feedQueues.set(runId, next)
    await next
  }

  async #fail(runId, error) {
    const message = error instanceof Error ? error.message : String(error)
    const run = this.#store.get(runId)
    if (!run) return
    if (['applied', 'discarded'].includes(run.status)) return
    const runtime = this.#runtime(runId)
    if (runtime) {
      this.#cancelIdleCheck(runId)
      for (const rt of runtime.agents.values()) {
        this.#unsubscribe(rt)
        await Promise.resolve(this.#driver.interrupt?.(rt.handle)).catch(() => {})
      }
      this.#runs.delete(runId)
    }
    await this.#store.patch(runId, { status: 'failed', error: message }).catch(() => {})
    await this.#feed(runId, { kind: 'error', text: message }).catch(() => {})
  }

  async dispose() {
    this.#closed = true
    for (const [runId, runtime] of this.#runs) {
      this.#cancelIdleCheck(runId)
      for (const rt of runtime.agents.values()) {
        this.#unsubscribe(rt)
        await Promise.resolve(this.#driver.interrupt?.(rt.handle)).catch(() => {})
      }
      const run = this.#store.get(runId)
      if (run && ['preparing', 'planning', 'running', 'waiting'].includes(run.status)) {
        await this.#store.patch(runId, { status: 'interrupted' }).catch(() => {})
        await this.#store.appendFeed(runId, { kind: 'status', text: 'The plugin stopped. The diff is still available.' }).catch(() => {})
      }
    }
    this.#runs.clear()
    this.#feedQueues.clear()
    await Promise.resolve(this.#driver.dispose?.()).catch(() => {})
  }
}

export { DEFAULT_CONFIG }
