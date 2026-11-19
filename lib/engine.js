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
 * A Conductor run puts a lead above the workers: they propose the shares, the
 * conductor approves them, answers the workers while they edit, reassigns the
 * share of a worker that stopped, and reviews the whole copy before the user
 * sees it — sending it back for rework at most twice.
 *
 * The project itself is never written by a run; only `apply()` writes to it.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { applyChanges, collectChanges, copyProjectTree, preflightApply, removeCopy, sweepCopies } from './copy.js'
import { parseClaim, parseOwnership, assignOwnership, describeOwnership } from './ownership.js'
import {
  CONDUCTOR_ADDRESS,
  MAX_REWORK_ROUNDS,
  changeDigest,
  failureKindOf,
  leastLoadedName,
  parseShares,
  parseVerdict,
} from './conductor.js'
import {
  collisionNotice,
  conductorDecidePrompt,
  conductorHandoverPrompt,
  conductorPlanPrompt,
  conductorReviewPrompt,
  conductorReworkPrompt,
  conductorShareUpdatePrompt,
  conductorWorkerGoPrompt,
  conductorWorkerPlanPrompt,
  soloPrompt,
  swarmGoPrompt,
  swarmPlanPrompt,
  userMessagePrompt,
} from './prompts.js'
import { describeSelection, normalizeSelection, validateSelection } from './models.js'
import { diffFile } from './diff.js'
import { newRunId, phaseOfFeedEvent, toSummary } from './run-store.js'

/**
 * Tells whether a path exists, without throwing on a missing entry.
 *
 * The isolated copy of a run is deleted once the run is applied or discarded,
 * so change detection and terminal accounting must tolerate a retired copy.
 * @param {string} target - path to probe.
 * @returns {Promise<boolean>} true when the path can be stat-ed.
 */
async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}
/** Names for swarm members: short, pronounceable, stable across a run. */
export const AGENT_NAMES = ['Vega', 'Orion', 'Lyra', 'Atlas', 'Nova', 'Rhea', 'Mira', 'Kai', 'Iris', 'Juno']

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
  #catalogCache = null
  #catalogAt = 0

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

  /**
   * Describe the model catalog the profile advertises, for the picker.
   * @returns {Promise<{ providers: Array<object>, default: object | null }>} provider-grouped models.
   */
  async models() {
    return this.#catalog({ refresh: true })
  }

  /**
   * Read (and briefly cache) the model catalog.
   *
   * Listing resolves adapter metadata for every model, so a run start and the
   * picker share one read instead of probing the registry on every keystroke.
   * @param {{ refresh?: boolean }} [options] - force a fresh read.
   * @returns {Promise<{ providers: Array<object>, default: object | null }>} catalog.
   */
  async #catalog({ refresh = false } = {}) {
    if (typeof this.#driver.listModels !== 'function') return { providers: [], default: null }
    const now = this.#now()
    if (refresh !== true && this.#catalogCache !== null && now - this.#catalogAt < 30_000) return this.#catalogCache
    const catalog = await this.#driver.listModels()
    this.#catalogCache = catalog
    this.#catalogAt = now
    return catalog
  }

  /**
   * Route one live agent to another provider/model/reasoning effort.
   *
   * The write lands on the agent's own model selection, so the next step of
   * that agent — and only that agent — uses the new route.
   * @param {string} runId - run id.
   * @param {string} agentId - agent to change.
   * @param {unknown} model - requested `{ provider, model, reasoningEffort? }`.
   * @returns {Promise<object>} refreshed run summary.
   */
  async setAgentModel(runId, agentId, model) {
    const run = this.#requireRun(runId)
    if (['applied', 'discarded'].includes(run.status)) {
      throw new ArtelError(`This run is already ${run.status}`, 409, 'artel/bad-status')
    }
    const runtime = this.#runtime(runId)
    if (!runtime) throw new ArtelError('This run is no longer active', 409, 'artel/not-live')
    const rt = [...runtime.agents.values()].find((candidate) => candidate.record.id === agentId)
    if (rt === undefined) throw new ArtelError('Unknown agent', 404, 'artel/unknown-agent')
    if (typeof this.#driver.selectModel !== 'function') {
      throw new ArtelError('This DSH profile cannot change an agent model', 501, 'artel/model-unsupported')
    }
    const selection = normalizeSelection(model)
    if (selection === null) throw new ArtelError('Pick a provider and a model first', 400, 'artel/bad-model')
    const catalog = await this.#catalog()
    const check = validateSelection(catalog, selection)
    if (!check.ok) throw new ArtelError(check.reason, 400, check.code)

    const applied = await this.#driver.selectModel(rt.handle, selection).catch((error) => {
      throw new ArtelError(String(error?.message ?? error), 409, 'artel/model-rejected')
    })
    rt.record = { ...rt.record, model: applied ?? selection }
    await this.#patchAgent(runId, rt.record)
    await this.#feed(runId, {
      kind: 'status',
      text: `${rt.record.name} now runs on ${describeSelection(catalog, selection)} — from its next step.`,
    })
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

  async start({ sessionId, projectPath, mode, task, model }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new ArtelError('Missing session')
    if (typeof projectPath !== 'string' || projectPath === '') throw new ArtelError('Missing project directory')
    if (mode !== 'solo' && mode !== 'swarm' && mode !== 'conductor') throw new ArtelError('Mode must be solo, swarm or conductor')
    if (typeof task !== 'string' || task.trim() === '') throw new ArtelError('Describe the task first')
    if (this.#closed) throw new ArtelError('The plugin is shutting down', 503, 'artel/closed')
    // A conductor run is a peer team by definition: without the subagent stack
    // there is no tree to put a conductor above, and there is no fallback.
    if (mode === 'conductor' && this.#driver.supportsPeers?.() !== true) {
      throw new ArtelError('Conductor mode needs the subagent stack in this profile.', 400, 'artel/peers-required')
    }

    // `model` is optional: without it every agent keeps the deployment default.
    const requested = model === undefined || model === null ? null : normalizeSelection(model)
    if (model !== undefined && model !== null && requested === null) {
      throw new ArtelError('Pick a provider and a model first', 400, 'artel/bad-model')
    }
    if (requested !== null) {
      const check = validateSelection(await this.#catalog(), requested)
      if (!check.ok) throw new ArtelError(check.reason, 400, check.code)
    }

    const project = path.resolve(projectPath)
    const stat = await fs.stat(project).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new ArtelError('The project directory does not exist', 400, 'artel/no-project')
    if (this.#store.list(sessionId).some((run) => ['preparing', 'planning', 'running'].includes(run.status))) {
      throw new ArtelError('Another run is already in progress in this session', 409, 'artel/busy')
    }

    const runId = newRunId(this.#now())
    const copyPath = path.join(this.#copyRoot, runId)
    const createdAt = this.#now()
    const configured = Math.max(1, Number(this.#config.swarmAgentCount) || 3)
    const count = mode === 'conductor' ? Math.min(8, Math.max(2, configured)) : mode === 'swarm' ? configured : 1
    const names = AGENT_NAMES.slice(0, mode === 'conductor' ? count + 1 : count)
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
        role: mode === 'conductor' ? (index === 0 ? 'conductor' : 'worker') : mode === 'swarm' ? 'swarm' : 'solo',
        status: 'starting',
        claimed: [],
        model: requested,
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
      if (mode === 'conductor') {
        await this.#startConductor(runId, run, runtime, { project, copyPath })
      } else if (peerSwarm) {
        await this.#startPeerSwarm(runId, run, runtime, { project, copyPath })
      } else {
        for (const agent of run.agents) {
          const handle = await this.#driver.createAgent({
            name: agent.name,
            mode,
            projectPath: project,
            copyPath,
            agentId: agent.id,
            parentSessionId: sessionId,
            title: `Artel · ${agent.name} — ${task.length > 48 ? `${task.slice(0, 48)}…` : task}`,
            model: requested,
          })
          this.#register(runId, runtime, agent, handle)
          await this.#warnAboutModel(runId, handle)
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

    if (requested !== null) {
      const catalog = await this.#catalog()
      await this.#feed(runId, {
        kind: 'status',
        text: `${names.length === 1 ? names[0] : 'All agents'} runs on ${describeSelection(catalog, requested)}${names.length === 1 ? '' : ' (one route each)'}.`,
      })
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
      parentSessionId: run.sessionId,
      title: `Artel · ${lead.name} — ${title}`,
      model: lead.model ?? null,
    })
    this.#register(runId, runtime, lead, leadHandle)
    await this.#warnAboutModel(runId, leadHandle)

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
        model: member.model ?? null,
      })
      this.#register(runId, runtime, member, handle)
      await this.#warnAboutModel(runId, handle)
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

  /* ------------------------------------------------------------ conductor */

  /**
   * Start a Conductor run: one ordinary Session as the lead, N worker children
   * spawned under it. They plan first; the workers propose shares, the conductor
   * approves them, and only then does anybody edit.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - engine runtime for the run.
   * @param {{ project: string, copyPath: string }} paths - project and copy.
   */
  async #startConductor(runId, run, runtime, { project, copyPath }) {
    const [conductor, ...workers] = run.agents
    runtime.stage = 'planning'
    runtime.proposal = null
    runtime.approved = null
    runtime.reviewRounds = 0
    runtime.reviewRetries = 0
    runtime.shareRetries = 0
    runtime.failure = null
    runtime.lastRemarks = ''

    const addresses = new Map([[conductor.id, CONDUCTOR_ADDRESS]])
    for (const worker of workers) addresses.set(worker.id, agentAddress(worker.name))
    runtime.addresses = addresses

    const title = run.task.length > 48 ? `${run.task.slice(0, 48)}…` : run.task
    const conductorHandle = await this.#driver.createAgent({
      name: conductor.name,
      mode: run.mode,
      projectPath: project,
      copyPath,
      agentId: conductor.id,
      parentSessionId: run.sessionId,
      title: `Artel · ${conductor.name} — ${title}`,
      model: conductor.model ?? null,
    })
    this.#register(runId, runtime, conductor, conductorHandle)
    await this.#warnAboutModel(runId, conductorHandle)

    for (const worker of workers) {
      const promptText = conductorWorkerPlanPrompt({
        copyPath,
        projectPath: project,
        task: run.task,
        peers: this.#conductorPeers(run, runtime, worker.id),
        selfName: worker.name,
        selfAddress: addresses.get(worker.id),
        canMessage: true,
      })
      const handle = await this.#driver.spawnMember({
        parent: conductorHandle,
        name: addresses.get(worker.id),
        displayName: worker.name,
        label: `Artel conductor · ${worker.name}`,
        promptText,
        copyPath,
        projectPath: project,
        agentId: worker.id,
        mode: run.mode,
        model: worker.model ?? null,
      })
      this.#register(runId, runtime, worker, handle)
      await this.#warnAboutModel(runId, handle)
    }

    // The workers are already planning (their spawn prompt is the plan turn);
    // the conductor's plan prompt is delivered here, once the team exists.
    await this.#syncAgents(runId, runtime, 'working')
    await this.#store.patch(runId, { status: 'planning' })
    await this.#feed(runId, {
      kind: 'status',
      text: `The conductor ${conductor.name} and ${workers.length} agents are reading the project. The team proposes who takes which files, the conductor approves the shares; nothing is edited in this step.`,
    })
    const conductorRt = runtime.agents.get(conductor.id)
    conductorRt.done = false
    await this.#send(runId, conductorRt, conductorPlanPrompt({
      copyPath,
      projectPath: project,
      task: run.task,
      workers: workers.map((worker) => ({ name: worker.name, address: addresses.get(worker.id) ?? null })),
      selfName: conductor.name,
    }))
  }

  /**
   * The other members of a conductor run, as `{ name, address }` peers. Agents
   * that already failed are left out: nobody should message a dead teammate.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {string} agentId - the agent asking for its peers.
   * @returns {Array<{ name: string, address: string | null }>} peers.
   */
  #conductorPeers(run, runtime, agentId) {
    return run.agents
      .filter((agent) => agent.id !== agentId)
      .filter((agent) => runtime.agents.get(agent.id)?.record.status !== 'failed')
      .map((agent) => ({ name: agent.name, address: runtime.addresses?.get(agent.id) ?? null }))
  }

  /**
   * The whole conductor team is idle in the planning stage: turn the workers'
   * OWNERSHIP lines into a proposed share map, publish it, and ask the conductor
   * to approve or change it.
   * @param {string} runId - run id.
   */
  async #settleConductorPlanning(runId) {
    const run = this.#store.get(runId)
    const runtime = this.#runtime(runId)
    if (!run || !runtime || runtime.stage !== 'planning') return
    this.#cancelIdleCheck(runId)

    const workerRows = [...runtime.agents.values()].filter((rt) => rt.record.role === 'worker')
    let aliveRows = workerRows
      .filter((rt) => rt.record.status !== 'failed')
      .map((rt) => ({ id: rt.record.id, name: rt.record.name, claims: parseOwnership(rt.planText ?? '') }))
    if (aliveRows.length === 0) {
      await this.#fail(runId, 'No agent is left to finish the work. The changes are still available in the diff.')
      return
    }

    if (aliveRows.every((row) => row.claims.length === 0)) {
      runtime.planningRounds = (runtime.planningRounds ?? 0) + 1
      if (runtime.planningRounds <= 1) {
        await this.#feed(runId, { kind: 'status', text: 'No ownership lines were announced. Asking the agents to divide the work again.' })
        const retry = 'You did not announce any files. Reply with exactly one line `OWNERSHIP: <paths>` naming the files or folders you will edit. Do not edit anything yet. If you must agree with a teammate first, send them one short message.'
        for (const row of aliveRows) {
          const rt = runtime.agents.get(row.id)
          rt.done = false
          await this.#send(runId, rt, retry)
        }
        return
      }
      aliveRows = await this.#fallbackClaims(run, runtime, aliveRows)
      await this.#feed(runId, { kind: 'status', text: 'Nobody announced ownership twice, so Artel split the top level of the project between the agents.' })
    }

    const records = aliveRows.map((row) => runtime.agents.get(row.id).record)
    const { assignments, conflicts } = assignOwnership(
      aliveRows.map((row) => ({ id: row.id, name: row.name, claims: row.claims })),
      { files: Object.keys(run.baseHashes ?? {}) },
    )
    const map = describeOwnership(records, assignments)
    runtime.proposal = { assignments, map, conflicts }
    runtime.stage = 'shares'
    runtime.shareRetries = 0
    await this.#feed(runId, { kind: 'plan', text: `Proposed shares (the conductor decides):\n${map}`, map })
    await this.#sendConductorDecidePrompt(runId, run, runtime, aliveRows)
  }

  /**
   * Ask the conductor to approve the proposal or rewrite it with `SHARES:` lines.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {Array<{ id: string, name: string }>} workerRows - workers still alive.
   */
  async #sendConductorDecidePrompt(runId, run, runtime, workerRows) {
    const claims = workerRows.map((row) => ({
      name: row.name,
      claims: parseOwnership(runtime.agents.get(row.id)?.planText ?? '').map((claim) => claim.raw),
    }))
    const conductorRt = [...runtime.agents.values()].find((rt) => rt.record.role === 'conductor')
    conductorRt.done = false
    await this.#send(runId, conductorRt, conductorDecidePrompt({
      proposalMap: runtime.proposal?.map ?? '',
      claims,
      task: run.task,
      workers: workerRows.map((row) => ({ name: row.name, address: runtime.addresses?.get(row.id) ?? null })),
    }))
  }

  /**
   * The conductor answered the decision prompt: apply its verdict (approve the
   * proposal, or rebuild the shares from its `SHARES:` lines) and send the
   * workers to work.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {object} rt - conductor runtime row.
   */
  async #applyConductorShares(runId, run, runtime, rt) {
    const aliveWorkerRows = [...runtime.agents.values()]
      .filter((row) => row.record.role === 'worker' && row.record.status !== 'failed')
    const decision = parseShares(rt.turnText ?? '', aliveWorkerRows.map((row) => row.record.name))
    const proposal = runtime.proposal ?? { assignments: {}, map: '', conflicts: [] }

    if (decision.mode === 'missing') {
      runtime.shareRetries = (runtime.shareRetries ?? 0) + 1
      if (runtime.shareRetries <= 1) {
        await this.#feed(runId, { kind: 'status', text: 'The conductor did not announce the shares. Asking again.' })
        await this.#sendConductorDecidePrompt(runId, run, runtime, aliveWorkerRows.map((row) => ({ id: row.record.id, name: row.record.name })))
        return
      }
    }

    let assignments = proposal.assignments ?? {}
    let conflicts = proposal.conflicts ?? []
    let map = proposal.map ?? ''
    if (decision.mode === 'assign') {
      const claimantRows = aliveWorkerRows.map((row) => {
        const entry = decision.entries.find((candidate) => candidate.name.toLowerCase() === row.record.name.toLowerCase())
        return {
          id: row.record.id,
          name: row.record.name,
          claims: (entry?.paths ?? []).map((raw) => parseClaim(raw)).filter(Boolean),
        }
      })
      const resolved = assignOwnership(claimantRows, { files: [] })
      assignments = resolved.assignments
      conflicts = resolved.conflicts
      map = describeOwnership(aliveWorkerRows.map((row) => row.record), assignments)
    }

    runtime.approved = { assignments, map, conflicts }
    runtime.stage = 'working'
    runtime.shareRetries = 0
    for (const row of runtime.agents.values()) {
      const claimed = row.record.role === 'worker' ? (assignments[row.record.id] ?? []).map((claim) => claim.raw) : []
      const status = row.record.role === 'conductor' ? 'idle' : row.record.status === 'failed' ? 'failed' : 'working'
      row.record = { ...row.record, claimed, status }
    }
    await this.#syncAgents(runId, runtime)
    await this.#store.patch(runId, { status: 'running' })
    await this.#feed(runId, { kind: 'plan', text: `The shares are handed out. No edits yet.\n${map}`, map })
    await this.#feed(runId, { kind: 'status', text: 'The files are being edited in parallel. Your project stays untouched until you apply.' })

    const nameById = new Map(aliveWorkerRows.map((row) => [row.record.id, row.record.name]))
    for (const row of aliveWorkerRows) {
      row.done = false
      await this.#send(runId, row, conductorWorkerGoPrompt({
        copyPath: run.copyPath,
        ownershipMap: map,
        ownClaims: (assignments[row.record.id] ?? []).map((claim) => claim.raw),
        contested: conflicts
          .filter((conflict) => conflict.claimedBy === row.record.id)
          .map((conflict) => ({ ...conflict, ownerName: nameById.get(conflict.owner) ?? 'the first claimant' })),
        task: run.task,
        peers: this.#conductorPeers(run, runtime, row.record.id),
        selfAddress: runtime.addresses?.get(row.record.id) ?? null,
        canMessage: true,
      }))
    }
  }

  /**
   * Dispatch a conductor turn end on the current stage. Returns true when the
   * flow consumed the turn and the generic idle check must not run.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {object} rt - agent runtime row.
   * @returns {Promise<boolean>} true when nothing else must react to the idle team.
   */
  async #onConductorTurnEnd(runId, run, runtime, rt) {
    if (run.mode !== 'conductor' || rt.record.role !== 'conductor') return false
    if (runtime.stage === 'shares') {
      await this.#applyConductorShares(runId, run, runtime, rt)
      return true
    }
    if (runtime.stage === 'review') {
      await this.#applyConductorVerdict(runId, run, runtime, rt)
      return true
    }
    if (runtime.stage === 'handover') return await this.#applyConductorHandover(runId, run, runtime, rt)
    return false
  }

  /**
   * All agents are idle in the working (or rework) stage: send the conductor to
   * review the whole copy. The run stays `running` until the verdict.
   * @param {string} runId - run id.
   */
  async #startConductorReview(runId) {
    const run = this.#store.get(runId)
    const runtime = this.#runtime(runId)
    if (!run || !runtime) return
    if (runtime.stage !== 'working' && runtime.stage !== 'rework') return
    runtime.stage = 'review'
    runtime.reviewRetries = 0
    await this.#feed(runId, { kind: 'status', text: 'Every agent is idle. The conductor is reviewing the whole copy.' })
    await this.#sendConductorReviewPrompt(runId, run, runtime)
  }

  /**
   * Send (or resend) the review prompt with a fresh digest of the whole copy.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   */
  async #sendConductorReviewPrompt(runId, run, runtime) {
    const changes = await this.changes(runId).catch(() => [])
    const conductorRt = [...runtime.agents.values()].find((rt) => rt.record.role === 'conductor')
    conductorRt.done = false
    await this.#send(runId, conductorRt, conductorReviewPrompt({
      digest: changeDigest(changes),
      ownershipMap: runtime.approved?.map ?? '',
      task: run.task,
      roundsLeft: Math.max(0, MAX_REWORK_ROUNDS - (runtime.reviewRounds ?? 0)),
      previousRemarks: runtime.lastRemarks ?? '',
    }))
  }

  /**
   * The conductor gave its verdict: accept the work, or send (at most twice) the
   * named shares back for rework.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {object} rt - conductor runtime row.
   */
  async #applyConductorVerdict(runId, run, runtime, rt) {
    const verdict = parseVerdict(rt.turnText ?? '')
    if (verdict.verdict === 'missing') {
      runtime.reviewRetries = (runtime.reviewRetries ?? 0) + 1
      if (runtime.reviewRetries <= 1) {
        await this.#feed(runId, { kind: 'status', text: 'The conductor did not give a verdict. Asking again.' })
        await this.#sendConductorReviewPrompt(runId, run, runtime)
        return
      }
      await this.#acceptConductorWork(runId, runtime, String(rt.turnText ?? '').trim())
      return
    }
    if (verdict.verdict === 'accept') {
      await this.#acceptConductorWork(runId, runtime, verdict.notes)
      return
    }
    if ((runtime.reviewRounds ?? 0) >= MAX_REWORK_ROUNDS) {
      await this.#feed(runId, { kind: 'status', text: 'The conductor asked for another pass, but the two-round limit is reached. The work goes to you with its remarks.' })
      await this.#acceptConductorWork(runId, runtime, verdict.notes)
      return
    }

    runtime.reviewRounds = (runtime.reviewRounds ?? 0) + 1
    runtime.stage = 'rework'
    runtime.lastRemarks = verdict.notes
    const alive = [...runtime.agents.values()]
      .filter((row) => row.record.role === 'worker' && row.record.status !== 'failed')
    let targets = alive
    if (verdict.reworkNames.length > 0) {
      const named = alive.filter((row) => verdict.reworkNames.some((name) => name.toLowerCase() === row.record.name.toLowerCase()))
      if (named.length > 0) targets = named
    }
    if (targets.length === 0) {
      await this.#acceptConductorWork(runId, runtime, verdict.notes)
      return
    }
    const targetIds = new Set(targets.map((row) => row.record.id))
    const others = alive.filter((row) => !targetIds.has(row.record.id))
    const lines = [
      `Rework round ${runtime.reviewRounds} of 2.`,
      `Back for rework: ${targets.map((row) => row.record.name).join(', ')}`,
    ]
    if (others.length > 0) lines.push(`Accepted for now: ${others.map((row) => row.record.name).join(', ')}`)
    if (verdict.notes !== '') lines.push(`Remarks: ${verdict.notes}`)
    await this.#feed(runId, { kind: 'plan', text: lines.join('\n') })
    const names = targets.map((row) => row.record.name).join(', ')
    const tail = others.length > 0 ? '; the other shares are accepted for now.' : '.'
    await this.#feed(runId, { kind: 'status', text: `${names} ${targets.length === 1 ? 'is' : 'are'} back for rework${tail}` })

    for (const row of runtime.agents.values()) {
      if (row.record.role === 'conductor') {
        row.record = { ...row.record, status: 'idle' }
        continue
      }
      if (row.record.status === 'failed') continue
      row.record = { ...row.record, status: targetIds.has(row.record.id) ? 'working' : 'idle' }
    }
    await this.#syncAgents(runId, runtime)
    for (const row of targets) {
      row.done = false
      await this.#send(runId, row, conductorReworkPrompt({
        copyPath: run.copyPath,
        ownershipMap: runtime.approved?.map ?? '',
        ownClaims: (runtime.approved?.assignments?.[row.record.id] ?? []).map((claim) => claim.raw),
        remarks: verdict.notes,
        task: run.task,
        peers: this.#conductorPeers(run, runtime, row.record.id),
        selfAddress: runtime.addresses?.get(row.record.id) ?? null,
        canMessage: true,
      }))
    }
  }

  /**
   * The conductor accepted the work as a whole: publish the run for the user.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {string} notes - the conductor's notes (may be empty).
   */
  async #acceptConductorWork(runId, runtime, notes) {
    runtime.stage = 'accepted'
    const changes = await this.changes(runId).catch(() => [])
    await this.#store.patch(runId, { status: 'waiting', changeCount: changes.length })
    await this.#feed(runId, {
      kind: 'plan',
      text: notes === '' ? 'The conductor accepted the work.' : `The conductor accepted the work.\n${notes}`,
    })
    await this.#feed(runId, { kind: 'status', text: 'The checks ran on the whole copy and the conductor accepted the result. The decision is yours.' })
    for (const row of runtime.agents.values()) {
      row.record = { ...row.record, status: row.record.status === 'failed' ? 'failed' : 'idle' }
    }
    await this.#syncAgents(runId, runtime)
  }

  /**
   * One conductor-run agent ended its turn with a failure reason. The host marks
   * it failed and, depending on the stage, continues or starts a handover.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {object} rt - failed agent runtime row.
   * @param {string} kind - failure kind from `failureKindOf`.
   * @returns {Promise<'fatal' | 'continue'>} whether the run died.
   */
  async #handleAgentFailure(runId, run, runtime, rt, kind) {
    const name = rt.record.name
    rt.record = { ...rt.record, status: 'failed' }
    await this.#patchAgent(runId, rt.record)

    if (rt.record.role === 'conductor') {
      await this.#fail(runId, `The conductor ${name} failed, so the work could not be accepted. The changes are still available in the diff.`)
      return 'fatal'
    }

    const alive = [...runtime.agents.values()]
      .filter((row) => row.record.role === 'worker' && row.record.status !== 'failed')
    if (alive.length === 0) {
      await this.#fail(runId, 'No agent is left to finish the work. The changes are still available in the diff.')
      return 'fatal'
    }

    if (['planning', 'shares', 'accepted'].includes(runtime.stage)) {
      await this.#feed(runId, { kind: 'error', text: `${name} stopped (${kind}). The team continues without it.` })
      return 'continue'
    }
    if (['working', 'review', 'rework'].includes(runtime.stage)) {
      runtime.stage = 'handover'
      runtime.failure = { agentId: rt.record.id, name, kind }
      runtime.shareRetries = 0
      await this.#feed(runId, { kind: 'error', text: `${name} stopped (${kind}). The conductor is moving that share.` })
      const conductorRt = [...runtime.agents.values()].find((row) => row.record.role === 'conductor')
      conductorRt.done = false
      await this.#send(runId, conductorRt, conductorHandoverPrompt({
        failedName: name,
        failedFiles: [...(rt.record.claimed ?? [])],
        ownershipMap: runtime.approved?.map ?? '',
        aliveNames: alive.map((row) => row.record.name),
        task: run.task,
      }))
      return 'continue'
    }
    await this.#feed(runId, { kind: 'error', text: `${name} stopped (${kind}). The team continues without it.` })
    return 'continue'
  }

  /**
   * The conductor answered the handover prompt: move the fallen worker's share
   * to an alive worker (or close it) and send the receiver to work.
   * @param {string} runId - run id.
   * @param {object} run - run record.
   * @param {object} runtime - run runtime.
   * @param {object} rt - conductor runtime row.
   * @returns {Promise<boolean>} true when the flow consumed the turn.
   */
  async #applyConductorHandover(runId, run, runtime, rt) {
    const failure = runtime.failure
    if (!failure) {
      runtime.stage = 'working'
      return false
    }
    const alive = [...runtime.agents.values()]
      .filter((row) => row.record.role === 'worker' && row.record.status !== 'failed')
    if (alive.length === 0) {
      await this.#fail(runId, 'No agent is left to finish the work. The changes are still available in the diff.')
      return true
    }
    const aliveNames = alive.map((row) => row.record.name)
    const decision = parseShares(rt.turnText ?? '', aliveNames)
    const failedRow = [...runtime.agents.values()].find((row) => row.record.id === failure.agentId)
    const failedFiles = [...(failedRow?.record.claimed ?? [])]
    const byName = {}
    for (const row of runtime.agents.values()) byName[row.record.name] = runtime.approved?.assignments?.[row.record.id] ?? []
    const leastLoaded = leastLoadedName(byName, aliveNames, aliveNames)

    const resend = async () => {
      rt.done = false
      await this.#send(runId, rt, conductorHandoverPrompt({
        failedName: failure.name,
        failedFiles,
        ownershipMap: runtime.approved?.map ?? '',
        aliveNames,
        task: run.task,
      }))
    }
    const noAnswer = async (receiver) => {
      await this.#feed(runId, { kind: 'status', text: `The conductor did not answer; Artel moved the share to ${receiver}.` })
    }

    let receiverName = null
    let paths = []
    if (decision.mode === 'missing') {
      runtime.shareRetries = (runtime.shareRetries ?? 0) + 1
      if (runtime.shareRetries <= 1) {
        await resend()
        return true
      }
      receiverName = leastLoaded
      paths = failedFiles
      await noAnswer(receiverName)
    } else if (decision.mode === 'approve') {
      receiverName = leastLoaded
      paths = failedFiles
    } else {
      const entry = decision.entries[0]
      if (entry === undefined) {
        receiverName = leastLoaded
        paths = failedFiles
        await noAnswer(receiverName)
      } else {
        receiverName = aliveNames.find((name) => name.toLowerCase() === entry.name.toLowerCase()) ?? null
        paths = entry.paths
        if (receiverName === null) {
          receiverName = leastLoaded
          paths = failedFiles
        }
      }
    }
    if (receiverName === null) {
      runtime.stage = 'working'
      runtime.failure = null
      return false
    }

    const receiverRow = alive.find((row) => row.record.name === receiverName)
    const assignments = { ...(runtime.approved?.assignments ?? {}) }
    assignments[failure.agentId] = []
    if (paths.length > 0 && receiverRow !== undefined) {
      assignments[receiverRow.record.id] = [
        ...(assignments[receiverRow.record.id] ?? []),
        ...paths.map((raw) => parseClaim(raw)).filter(Boolean),
      ]
    }
    const map = describeOwnership(alive.map((row) => row.record), assignments)
    runtime.approved = { assignments, map, conflicts: runtime.approved?.conflicts ?? [] }

    if (failedRow) failedRow.record = { ...failedRow.record, claimed: [], status: 'failed' }
    if (receiverRow !== undefined && paths.length > 0) {
      receiverRow.record = {
        ...receiverRow.record,
        claimed: [...(receiverRow.record.claimed ?? []), ...paths],
        status: paths.length > 0 ? 'working' : receiverRow.record.status,
      }
    }
    await this.#syncAgents(runId, runtime)
    runtime.stage = 'working'
    runtime.failure = null
    runtime.shareRetries = 0

    if (paths.length === 0 || receiverRow === undefined) {
      await this.#feed(runId, { kind: 'plan', text: `The conductor closed ${failure.name}'s share: nothing was assigned to it.` })
      return false
    }
    await this.#feed(runId, { kind: 'plan', text: `The conductor moved ${failure.name}'s share to ${receiverName}.\n${paths.join(', ')}` })
    receiverRow.done = false
    await this.#send(runId, receiverRow, conductorShareUpdatePrompt({
      copyPath: run.copyPath,
      ownershipMap: map,
      ownClaims: [...(receiverRow.record.claimed ?? [])],
      task: run.task,
      peers: this.#conductorPeers(run, runtime, receiverRow.record.id),
      selfAddress: runtime.addresses?.get(receiverRow.record.id) ?? null,
      canMessage: true,
    }))
    return true
  }

  /**
   * Say in the feed when a requested route could not be applied, instead of
   * pretending the agent uses a model it does not.
   * @param {string} runId - run id.
   * @param {object | undefined} handle - agent handle returned by the driver.
   * @returns {Promise<void>} always completes.
   */
  async #warnAboutModel(runId, handle) {
    if (typeof handle?.modelError !== 'string' || handle.modelError === '') return
    await this.#feed(runId, {
      kind: 'error',
      text: `${handle.name} stayed on the profile default model: ${handle.modelError}`,
    })
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
      model: handle?.model ?? agent.model ?? null,
    }
    runtime.agents.set(agent.id, { record, handle, unsubscribe, done: false, planText: '', lastText: '', turnText: '' })
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

    if (run.mode === 'conductor' && ['shares', 'review', 'handover'].includes(runtime.stage)) {
      throw new ArtelError('The conductor is deciding. Wait for the next stage.', 409, 'artel/reviewing')
    }
    // The user can ask for more after the conductor accepted the work: the team
    // goes back to work and the conductor reviews the result once more. No rework
    // rounds are left at that point, so the conductor can only accept it (with
    // remarks), which keeps the run from looping.
    if (run.mode === 'conductor' && runtime.stage === 'accepted') runtime.stage = 'working'
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
      // A stopped conductor run cannot resume its own review: fall back to the
      // working stage, so the diff is simply reviewable by the user.
      if (run.mode === 'conductor' && ['shares', 'review', 'handover'].includes(runtime.stage)) {
        runtime.stage = 'working'
        runtime.failure = null
      }
      this.#cancelIdleCheck(runId)
      for (const rt of runtime.agents.values()) {
        await Promise.resolve(this.#driver.interrupt(rt.handle)).catch(() => {})
      }
    }
    // A stopped run keeps its diff available, so the session rail must show the
    // same count the review panel will list — recalculate it before the run
    // becomes terminal, not only when the agents go idle by themselves.
    const changeCount = await this.#countChangesQuietly(runId)
    await this.#store.patch(runId, {
      status: 'interrupted',
      ...(changeCount === undefined ? {} : { changeCount }),
    })
    await this.#feed(runId, { kind: 'status', text: 'You stopped the run. The copy is still here, so the diff stays available.' })
    return this.#summary(this.#requireRun(runId))
  }

  /* ---------------------------------------------------------------- review */

  async changes(runId) {
    const run = this.#requireRun(runId)
    if (!run.copyPath) return []
    if (!(await pathExists(run.copyPath))) return []
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

  /**
   * Best-effort change count for a run that is about to become terminal.
   *
   * A run stopped before its copy finished must keep the stored count: hashing a
   * missing or partial copy would report every project file as changed, which is
   * not what the user can review. Only a fully copied run is counted, and a
   * failure while hashing keeps the previous value instead of blocking the
   * status transition.
   * @param {string} runId - run id.
   * @returns {Promise<number | undefined>} count to store, or undefined to keep it.
   */
  async #countChangesQuietly(runId) {
    const run = this.#store.get(runId)
    if (!run || typeof run.copyPath !== 'string' || run.copyPath === '' || run.copyKind !== 'directory') return undefined
    const changes = await this.changes(runId).catch(() => null)
    return changes === null ? undefined : changes.length
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
    await removeCopy(this.#copyRoot, run.copyPath).catch(() => {})
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
      await this.#onTurnEnd(runId, runtime, rt, event)
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
      rt.turnText += `${event.text}\n`
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
    rt.turnText = ''
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

  /**
   * One agent ended its turn. In a conductor run a failure reason also hands the
   * fallen agent's share to the conductor, and a conductor turn end may be the
   * planning, decision, review or handover answer the host is waiting for.
   * @param {string} runId - run id.
   * @param {object} runtime - run runtime.
   * @param {object} rt - agent runtime row.
   * @param {object} [event] - the driver turn-end event.
   */
  async #onTurnEnd(runId, runtime, rt, event) {
    const run = this.#store.get(runId)
    if (!run) return
    if (rt.done) return
    rt.done = true

    const kind = run.mode === 'conductor' ? failureKindOf(event?.reason) : null
    if (kind !== null) {
      const outcome = await this.#handleAgentFailure(runId, run, runtime, rt, kind)
      if (outcome === 'fatal') return
    }

    rt.record = { ...rt.record, status: kind === null ? 'idle' : 'failed' }
    await this.#patchAgent(runId, rt.record)

    const current = this.#store.get(runId)
    if (!current) return
    if (current.mode === 'conductor') {
      const handled = await this.#onConductorTurnEnd(runId, current, runtime, rt)
      if (handled === true) return
    }

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
      if (run.mode === 'conductor') {
        if (runtime.stage === 'planning') await this.#settleConductorPlanning(runId)
        return
      }
      await this.#settlePlanning(runId)
      return
    }
    if (run.status !== 'running') return

    if (run.mode === 'conductor') {
      // A conductor run only publishes the diff after the conductor accepted it.
      if (runtime.stage === 'working' || runtime.stage === 'rework') await this.#startConductorReview(runId)
      if (runtime.stage === 'accepted') {
        // The team was woken after acceptance and is idle again: publish it once
        // more, so the user can still review the extra changes and apply them.
        const changes = await this.changes(runId).catch(() => [])
        const after = this.#store.get(runId)
        if (!after || after.status !== 'running') return
        await this.#store.patch(runId, { status: 'waiting', changeCount: changes.length })
        await this.#feed(runId, { kind: 'status', text: 'The team is idle again. Review the diff and apply what you like.' })
      }
      return
    }

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
  async #fallbackClaims(run, runtime, rows = null) {
    const entries = await fs.readdir(run.copyPath).catch(() => [])
    const usable = entries.filter((entry) => !['node_modules', '.git', '.dsh-artel'].includes(entry)).sort()
    const targets = rows ?? [...runtime.agents.values()].map((rt) => ({ id: rt.record.id, name: rt.record.name }))
    if (targets.length === 0) return []
    return targets.map((row, index) => ({
      id: row.id,
      name: row.name,
      claims: usable
        .filter((_, position) => position % targets.length === index)
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

  /**
   * Append one feed event and keep the run's phase hint in step with it.
   *
   * Feeds from different agents arrive concurrently, so appends are queued per
   * run: sequence numbers stay ordered and the phase always ends up matching the
   * last status/plan line that was stored.
   * @param {string} runId - run id.
   * @param {object} event - feed event.
   * @returns {Promise<void>} completes once the event and its phase are stored.
   */
  async #feed(runId, event) {
    const previous = this.#feedQueues.get(runId) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        await this.#store.appendFeed(runId, event)
        // Only a stored event may become the phase: a failed append must not
        // advertise a line the client can never read from the feed.
        await this.#publishPhase(runId, event)
      })
      .catch((error) => this.#log.warn?.(`artel: could not append feed for ${runId}: ${error.message}`))
    this.#feedQueues.set(runId, next)
    await next
  }

  /**
   * Mirror the latest phase line into the run record, where the client's
   * session rail reads it without loading the feed.
   *
   * Patching only `phase` never re-runs the status machine, so this stays safe
   * on terminal runs: the final "Applied …" line lands after `status: applied`.
   * A run pruned meanwhile is simply ignored.
   * @param {string} runId - run id.
   * @param {object} event - feed event that was just appended.
   * @returns {Promise<void>} always completes.
   */
  async #publishPhase(runId, event) {
    const phase = phaseOfFeedEvent(event)
    if (phase === undefined) return
    const run = this.#store.get(runId)
    if (!run || run.phase === phase) return
    await this.#store.patch(runId, { phase }).catch(() => {})
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
    const changeCount = await this.#countChangesQuietly(runId)
    await this.#store.patch(runId, {
      status: 'failed',
      error: message,
      ...(changeCount === undefined ? {} : { changeCount }),
    }).catch(() => {})
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
        const changeCount = await this.#countChangesQuietly(runId)
        await this.#store.patch(runId, {
          status: 'interrupted',
          ...(changeCount === undefined ? {} : { changeCount }),
        }).catch(() => {})
        await this.#store.appendFeed(runId, { kind: 'status', text: 'The plugin stopped. The diff is still available.' }).catch(() => {})
      }
    }
    this.#runs.clear()
    this.#feedQueues.clear()
    await Promise.resolve(this.#driver.dispose?.()).catch(() => {})
  }
}

export { DEFAULT_CONFIG }
