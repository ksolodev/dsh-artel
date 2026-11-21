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
 * An Orchestrator run starts with one planner: it splits the user's goal into
 * independent parts with explicit completion conditions. Each part then gets its
 * own copy of the project, its own worker and its own reviewer; a part is
 * accepted only when the reviewer confirms that the plan conditions hold, and a
 * part that fails is sent back to its worker instead of reaching the user. When
 * every part is accepted the changes are combined in one assembly copy; files
 * that more than one part edited are resolved by a merger. The user applies the
 * assembled result with the usual Apply button, or discards it.
 *
 * The project itself is never written by a run; only `apply()` writes to it.
 *
 * After Apply the engine also reads what the project says it still needs: a DSH
 * bundle to install into the running profile, and the project's own install
 * commands. The changes card offers both, and neither the bundle install nor a
 * command ever runs without the user clicking that exact action.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  applyChanges,
  collectChanges,
  copyProjectTree,
  hashFile,
  hashTree,
  preflightApply,
  removeCopy,
  sweepCopies,
} from './copy.js'
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
  MAX_ORCHESTRATOR_PARTS,
  MAX_ORCHESTRATOR_REWORK,
  assembledCard,
  parsePlan,
  parseReview,
  partLabel,
  planCard,
} from './orchestrator.js'
import { FUSION_SLOT_COUNT, PANEL_SIZE, fusionFailureNotice, judgeDecision } from './fusion.js'
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
  fusionImplementPrompt,
  fusionJudgePrompt,
  fusionPanelPrompt,
  nightShiftRules,
  orchestratorMergePrompt,
  orchestratorPlanPrompt,
  orchestratorReviewPrompt,
  orchestratorReworkPrompt,
  orchestratorWorkerPrompt,
  soloPrompt,
  swarmGoPrompt,
  swarmPlanPrompt,
  userMessagePrompt,
} from './prompts.js'
import { describeSelection, normalizeSelection, validateSelection } from './models.js'
import { diffFile } from './diff.js'
import { newRunId, phaseOfFeedEvent, toSummary } from './run-store.js'
import {
  bundleResultLine,
  detectInstallNeeds,
  installFeedLine,
  installNeeded,
  mergeInstallRecord,
  normalizeBundleResult,
  runInstallCommand,
} from './install.js'
import { projectKeyOf } from './project-key.js'
import { taskChatTitle } from './project-chats.js'

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

/** Longest "what this agent is doing" line kept on a run summary. */
const ACTIVITY_MAX_LENGTH = 240

/**
 * Flatten one message into the single line the agent row has room for.
 * @param {unknown} text - assistant text.
 * @returns {string} one line, capped at ACTIVITY_MAX_LENGTH characters.
 */
function activityText(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > ACTIVITY_MAX_LENGTH ? `${flat.slice(0, ACTIVITY_MAX_LENGTH - 1)}…` : flat
}

/**
 * Add one agent's spend to the run total.
 * @param {object | null} total - running total, or null before the first agent.
 * @param {object} usage - one agent's usage counters.
 * @returns {object} new total.
 */
function addUsage(total, usage) {
  const base = total ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0 }
  return {
    inputTokens: base.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: base.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: base.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: base.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    totalTokens: base.totalTokens + (usage.totalTokens ?? 0),
    requests: (base.requests ?? 0) + (usage.requests ?? 0),
  }
}

const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'multiedit', 'patch', 'str_replace_editor'])

const DEFAULT_CONFIG = {
  swarmAgentCount: 3,
  orchestratorParts: 3,
  maxRunsPerSession: 10,
  keepCopiesHours: 72,
  diffContext: 3,
  idleGraceMs: 0,
}

/** Directory inside an assembly copy that holds the unresolved conflict bundles. */
const CONFLICT_DIR = '.dsh-artel'

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
  /** Runs with an install action in flight: one install at a time per run. */
  #installing = new Set()
  /** Finds the app-owned repository of a project; wired by the plugin/queue. */
  #gitResolver = null

  constructor({ store, driver, copyRoot, config = {}, log = console, now = () => Date.now(), gitResolver = null }) {
    this.#store = store
    this.#driver = driver
    this.#copyRoot = copyRoot
    this.#config = { ...DEFAULT_CONFIG, ...config }
    this.#log = log
    this.#now = now
    this.#gitResolver = typeof gitResolver === 'function' ? gitResolver : null
  }

  /**
   * Install the resolver used to find a project's app-owned repository.
   *
   * The engine never guesses a git path: the plugin (or the queue runner) owns
   * the repository layout and hands the answer in here. Committed runs are
   * reviewed through that repository, so a missing resolver leaves them opaque
   * instead of reading the wrong directory.
   * @param {((projectPath: string) => Promise<object | null>) | null} resolver - resolver, or null to drop it.
   */
  setGitResolver(resolver) {
    this.#gitResolver = typeof resolver === 'function' ? resolver : null
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
          key: 'feed.run.restarted',
          text: 'The plugin restarted, so this run was interrupted. The diff is still available.',
        })
      }
      if (run.copyPath && !['applied', 'discarded'].includes(run.status)) keep.add(path.basename(run.copyPath))
    }
    await sweepCopies(this.#copyRoot, keep).catch((error) => this.#log.warn?.(`artel: copy sweep failed: ${error.message}`))
    return this
  }

  /**
   * Re-file the stored project chats under their project after a host restart.
   *
   * The sidebar derives Workspace membership from the stored Session headers, and
   * an Artel agent header points at the run copy (that is what keeps the sandbox
   * boundary on the copy). The durable Workspace record still lists the chat, so
   * the membership only has to be re-indexed. Runs from older versions are left
   * untouched on purpose.
   * @returns {Promise<{ attached: number, skipped: number, failed: number }>} counts.
   */
  async restoreProjectChats() {
    if (typeof this.#driver.restoreProjectChats !== 'function') return { attached: 0, skipped: 0, failed: 0 }
    if (this.#driver.supportsProjectChats?.() !== true) return { attached: 0, skipped: 0, failed: 0 }
    const result = await this.#driver.restoreProjectChats(this.#store.all())
    if (result.attached > 0) this.#log.info?.(`dsh-artel: re-filed ${result.attached} project chat(s) in the sidebar`)
    return result
  }

  /* ------------------------------------------------------------------ reads */

  listRuns(sessionId) {
    return this.#store.list(sessionId).map((run) => this.#summary(run))
  }

  /**
   * Every chat that owns Artel runs, newest activity first.
   *
   * One chat holds several runs; its row shows the newest one's status and the
   * total count, and `lastRunId` is the run the client opens after switching to
   * it. This is what `GET /chats` answers (issue #11): the rail lists the chats
   * of the open project, and the sidebar badge marks every chat with tasks.
   * @returns {Promise<Array<object>>} one entry per chat, sorted by `updatedAt`.
   */
  async listChats() {
    const chats = new Map()
    for (const run of this.#store.all()) {
      const entry = chats.get(run.sessionId)
      if (entry === undefined) {
        chats.set(run.sessionId, { latest: run, count: 1 })
        continue
      }
      entry.count += 1
      if ((run.createdAt ?? 0) > (entry.latest.createdAt ?? 0)) entry.latest = run
    }
    const list = []
    for (const [sessionId, entry] of chats) {
      const latest = entry.latest
      // Older runs have no stored title: a task chat is named after its task,
      // and any other chat keeps its DSH title, which the client overlays from
      // the sessions snapshot.
      const stored = typeof latest.chatTitle === 'string' && latest.chatTitle !== '' ? latest.chatTitle : null
      const title = stored ?? (latest.taskChat === true && typeof latest.task === 'string' && latest.task !== '' ? taskChatTitle(latest.task) : null)
      list.push({
        sessionId,
        title,
        lastTask: typeof latest.task === 'string' ? latest.task : null,
        projectPath: typeof latest.projectPath === 'string' && latest.projectPath !== '' ? latest.projectPath : null,
        projectKey: typeof latest.projectPath === 'string' && latest.projectPath !== '' ? await projectKeyOf(latest.projectPath) : null,
        runCount: entry.count,
        lastRunId: latest.id ?? null,
        status: latest.status ?? null,
        mode: latest.mode ?? null,
        updatedAt: typeof latest.updatedAt === 'number' ? latest.updatedAt : null,
      })
    }
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return list
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

  /**
   * Client-facing run view.
   *
   * The stored record says what a run IS; the live runtime says what it is DOING
   * — which agent is on which tool right now, how full its context is, how long
   * its turn has been running and what the host itself is waiting for. Both are
   * merged here, so one `getRun` poll carries the live picture and the page needs
   * no second endpoint.
   * @param {object} run - stored run record.
   * @returns {object} run summary.
   */
  #summary(run) {
    const summary = toSummary(run)
    summary.install = this.#installView(run)
    // Branch runs: the client shows the seeding step, the branch and the commit
    // that owns the content now; `toSummary` intentionally carries no internals.
    summary.isolated = run.isolated === true
    summary.branchId = typeof run.branchId === 'string' && run.branchId !== '' ? run.branchId : null
    summary.parentCommit = typeof run.parentCommit === 'string' && run.parentCommit !== '' ? run.parentCommit : null
    summary.commit = typeof run.commit === 'string' && run.commit !== '' ? run.commit : null
    const runtime = this.#runtime(run.id)
    if (runtime === undefined) return summary
    const byId = new Map()
    for (const rt of runtime.agents.values()) byId.set(rt.record.id, rt)
    let spend = null
    summary.agents = summary.agents.map((agent) => {
      const rt = byId.get(agent.id)
      if (rt === undefined) return agent
      const stats = typeof this.#driver.statsOf === 'function' ? this.#driver.statsOf(rt.handle) : null
      if (stats !== null && stats !== undefined && stats.usage !== null) spend = addUsage(spend, stats.usage)
      return {
        ...agent,
        activity: rt.activity ?? null,
        turnStartedAt: typeof rt.turnStartedAt === 'number' ? rt.turnStartedAt : null,
        turns: rt.turns ?? 0,
        stats: stats ?? null,
      }
    })
    summary.waitingFor = this.#waitingFor(run, runtime)
    summary.spend = spend
    return summary
  }

  /**
   * The install record as the client may act on it.
   *
   * The stored record says what Apply detected. Only the live Host can say
   * whether this profile is able to install a bundle into itself, so that answer
   * is merged in on every read instead of being stored: a profile that gained the
   * plugin manager later starts offering the button without re-applying anything.
   * @param {object} run - stored run record.
   * @returns {object | null} install record with `bundle.canInstall`, or null.
   */
  #installView(run) {
    const install = run.install
    if (install === null || typeof install !== 'object') return null
    const view = {
      ...install,
      steps: Array.isArray(install.steps) ? install.steps : [],
      warnings: Array.isArray(install.warnings) ? install.warnings : [],
      bundle: null,
    }
    if (install.bundle === null || typeof install.bundle !== 'object') return view
    const supported = typeof this.#driver.supportsBundleInstall === 'function' && this.#driver.supportsBundleInstall() === true
    view.bundle = { ...install.bundle, canInstall: install.bundle.installable === true && supported }
    return view
  }

  /**
   * What the run is waiting for right now, in the smallest form the client can
   * turn into a sentence: the user (a question, or a plan to approve), a named
   * set of agents, or the host itself (merging, assembling, reading a plan).
   * @param {object} run - stored run record.
   * @param {object} runtime - live runtime.
   * @returns {{ kind: 'user' | 'approval' | 'agents' | 'host', names?: string[], stage?: string | null, since: number } | null} waiting state, or null when the run is not live.
   */
  #waitingFor(run, runtime) {
    const now = this.#now()
    if (run.status === 'waiting') {
      if (runtime.waitSince === undefined) runtime.waitSince = now
      if (run.planApproval === true && run.planApproved !== true) {
        return { kind: 'approval', since: runtime.waitSince }
      }
      return { kind: 'user', since: runtime.waitSince }
    }
    if (run.status !== 'preparing' && run.status !== 'planning' && run.status !== 'running') return null
    const live = [...runtime.agents.values()]
    const busy = live.filter((rt) => rt.record.status === 'working')
    if (busy.length > 0) {
      return {
        kind: 'agents',
        names: busy.map((rt) => rt.record.name),
        since: Math.min(...busy.map((rt) => (typeof rt.turnStartedAt === 'number' ? rt.turnStartedAt : now))),
      }
    }
    const starting = live.filter((rt) => rt.record.status === 'starting')
    if (starting.length > 0) {
      return { kind: 'agents', names: starting.map((rt) => rt.record.name), since: run.updatedAt ?? now }
    }
    // Nobody is talking: the host is parsing a plan, merging parts or assembling
    // the result, which is still work the user is waiting on.
    const stage = run.mode === 'orchestrator' ? runtime.orch?.stage ?? null : runtime.stage ?? null
    return { kind: 'host', stage, since: run.updatedAt ?? now }
  }

  /**
   * Remember what one agent is doing, for the run page's live row.
   *
   * This never touches storage: it is the answer to "чем занят каждый прямо
   * сейчас", refreshed by every session event and dropped when the turn ends.
   * @param {object} rt - agent runtime row.
   * @param {object} event - driver event.
   */
  #noteActivity(rt, event) {
    if (event.kind === 'tool') {
      rt.activity = {
        kind: 'tool',
        tool: String(event.tool ?? 'tool'),
        text: String(event.text ?? ''),
        at: this.#now(),
      }
      return
    }
    if (event.kind === 'assistant' && typeof event.text === 'string' && event.text.trim() !== '') {
      rt.activity = { kind: 'assistant', text: activityText(event.text), at: this.#now() }
    }
  }

  /**
   * Keep at most `maxRunsPerSession` decided runs per session: the newest ones
   * stay reviewable, the oldest are dropped with their copies. Runs that still
   * need the user (waiting) are never pruned.
   */
  async #pruneRuns(sessionId) {
    const limit = Math.max(1, Number(this.#config.maxRunsPerSession) || 10)
    // A v0.11 run lives in its own task chat, so the limit is counted per chat
    // the run was started from; runs from older versions have no origin and are
    // counted by their own session.
    const runs = this.#store
      .all()
      .filter((run) => (run.originSessionId ?? run.sessionId) === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
    if (runs.length <= limit) return
    const decided = ['applied', 'discarded', 'failed', 'interrupted', 'finished']
    for (const run of runs.slice(limit)) {
      if (!decided.includes(run.status)) continue
      await this.#removePartCopies(run)
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

  /**
   * The directory a run's changes are compared against.
   *
   * An isolated queue run diffs against the branch tip it was seeded from, and
   * an Orchestrator assembly against its own base copy; every other run diffs
   * against the real project the user opened.
   * @param {object} run - stored run record.
   * @returns {string} the root the before-files are read from.
   */
  #beforeRoot(run) {
    if (run.mode === 'orchestrator') return typeof run.basePath === 'string' && run.basePath !== '' ? run.basePath : run.projectPath
    if (run.isolated === true && typeof run.basePath === 'string' && run.basePath !== '') return run.basePath
    return run.projectPath
  }

  /**
   * The directory an Orchestrator run copies its parts and assembly from.
   *
   * A seeded Orchestrator works below its base version: the planner, every part
   * copy and the assembly must all start from the seed, or the run would read
   * the real project while claiming the seed as its before side.
   * @param {object} run - stored run record.
   * @returns {string} the root every copy of the run is taken from.
   */
  #orchestratorSource(run) {
    return typeof run.basePath === 'string' && run.basePath !== '' ? run.basePath : run.projectPath
  }

  /**
   * The app-owned repository of a run's project, or null when git is unavailable.
   *
   * Review must never fail because the repository cannot be opened: a committed
   * run falls back to an opaque diff when the resolver throws or has nothing.
   * @param {string} projectPath - path of the user's project.
   * @returns {Promise<object | null>} `ArtelGit` instance or null.
   */
  async #gitFor(projectPath) {
    if (this.#gitResolver === null) return null
    try {
      return await this.#gitResolver(projectPath)
    } catch {
      return null
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  async start({ sessionId, projectPath, mode, task, model, models, basePath = null, sandboxMode = null, autoqueue = false, planApproval = false, isolateFromBase = false, branchId = null, parentCommit = null, newChat = false }) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new ArtelError('Missing session')
    if (typeof projectPath !== 'string' || projectPath === '') throw new ArtelError('Missing project directory')
    if (mode !== 'solo' && mode !== 'swarm' && mode !== 'conductor' && mode !== 'fusion' && mode !== 'orchestrator') {
      throw new ArtelError('Mode must be solo, swarm, conductor, fusion or orchestrator')
    }
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

    // A Fusion run is the only mode where the agents may use different models:
    // `models` carries three panel routes, a judge route and an implementer
    // route. Every slot falls back to the single `model` route and then to the
    // deployment default (null), so a plain `model` request still works.
    const fusionModels = mode === 'fusion'
      ? await this.#fusionModels({ models, fallback: requested })
      : null

    const project = path.resolve(projectPath)
    const stat = await fs.stat(project).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new ArtelError('The project directory does not exist', 400, 'artel/no-project')
    // An unattended queue or the Factory can seed a run from an earlier version
    // copy instead of the real project ("the next task starts from the last
    // successful version"). Only the COPY source changes: the diff base stays the
    // real project, so every version shows and applies the cumulative change.
    let sourcePath = project
    if (basePath !== null && basePath !== undefined) {
      if (typeof basePath !== 'string' || basePath === '') {
        throw new ArtelError('The base version path is not a directory', 400, 'artel/no-base-version')
      }
      sourcePath = path.resolve(basePath)
      const baseStat = await fs.stat(sourcePath).catch(() => null)
      if (!baseStat || !baseStat.isDirectory()) {
        throw new ArtelError('The base version copy is gone; the run starts from the real project', 409, 'artel/no-base-version')
      }
    }
    // An isolated queue run is one step of a branch: without a tip to start from
    // there is nothing to diff against and nothing its commit could build on.
    if (isolateFromBase === true && sourcePath === project) {
      throw new ArtelError('An isolated queue run needs a base version to start from.', 400, 'artel/bad-request')
    }
    if (this.#store.list(sessionId).some((run) => ['preparing', 'planning', 'running'].includes(run.status))) {
      throw new ArtelError('Another run is already in progress in this session', 409, 'artel/busy')
    }

    // A task started from a chat gets its own conversation in the project: the
    // issue asks for that so a run never hangs on whatever chat the panel
    // happened to be in, and the source chat keeps no run. The chat is created
    // after every validation, so a rejected start leaves no orphan behind; when
    // the project folder is not an open Workspace, the run stays where it was
    // started (the previous behaviour).
    let runSessionId = sessionId
    let taskChat = null
    if (newChat === true) {
      try {
        taskChat = (await this.#driver.createTaskChat?.({ projectPath: project, task: task.trim() })) ?? null
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not create a task chat, the run stays in this chat: ${error?.message ?? error}`)
        taskChat = null
      }
      if (taskChat !== null && typeof taskChat.sessionId === 'string' && taskChat.sessionId !== '') {
        runSessionId = taskChat.sessionId
      }
    }

    const runId = newRunId(this.#now())
    const copyPath = path.join(this.#copyRoot, runId)
    const createdAt = this.#now()
    const configured = Math.max(1, Number(this.#config.swarmAgentCount) || 3)
    // An Orchestrator run starts with ONE agent: the planner. Its part workers,
    // reviewers and the merger are created only after the plan is parsed.
    const count = mode === 'orchestrator'
      ? 1
      : mode === 'conductor'
        ? Math.min(8, Math.max(2, configured))
        : mode === 'swarm'
          ? configured
          : mode === 'fusion'
            ? FUSION_SLOT_COUNT
            : 1
    const names = AGENT_NAMES.slice(0, mode === 'conductor' ? count + 1 : count)
    /** @param {number} index - slot index in `names`. @returns {string} stored role. */
    const roleOf = (index) => {
      if (mode === 'orchestrator') return 'planner'
      if (mode === 'conductor') return index === 0 ? 'conductor' : 'worker'
      if (mode === 'swarm') return 'swarm'
      if (mode === 'fusion') return index < PANEL_SIZE ? 'panelist' : index === PANEL_SIZE ? 'judge' : 'implementer'
      return 'solo'
    }
    const run = {
      id: runId,
      sessionId: runSessionId,
      // The chat the task was started from: `sessionId` may be the task chat, and
      // the per-chat run cap counts by where the user started.
      originSessionId: sessionId,
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
        role: roleOf(index),
        status: 'starting',
        claimed: [],
        model: mode === 'fusion' ? fusionModels[index] ?? null : requested,
      })),
      createdAt,
      updatedAt: createdAt,
      changeCount: 0,
      feedSeq: 0,
      // Orchestrator only: the plan the run follows and the assembly record.
      plan: null,
      merge: null,
      // Unattended runs: `autoqueue` marks the version chip and adds the night
      // rules to every prompt; `basePath` records which version copy seeded this
      // one. `planApproval` stops an Orchestrator run after its plan until the
      // user approves it on the run page (the Factory route does this).
      autoqueue: autoqueue === true,
      basePath: sourcePath === project ? null : sourcePath,
      // Auto-queue branch runs: `isolated` means the run diffs against its seed
      // (the branch tip) instead of the real project, `branchId`/`parentCommit`
      // name the branch step and `commit` is set once the copy became a commit.
      isolated: isolateFromBase === true,
      branchId: typeof branchId === 'string' && branchId !== '' ? branchId : null,
      parentCommit: typeof parentCommit === 'string' && parentCommit !== '' ? parentCommit : null,
      commit: null,
      sandboxMode: typeof sandboxMode === 'string' && sandboxMode !== '' ? sandboxMode : null,
      planApproval: mode === 'orchestrator' && planApproval === true,
      planApproved: false,
      // The chat that hosts this run. `taskChat` means it was created for the run
      // (and the client switches to it); `projectChats` means this version files
      // the agent conversations under the project group in the sidebar, so the
      // membership has to be restored after a host restart.
      taskChat: taskChat !== null,
      taskChatWorkspaceId: taskChat?.workspaceId ?? null,
      // The title of the chat the run lives in. The client lists project chats
      // before their DSH titles are loaded, so the name is kept with the run.
      chatTitle: typeof taskChat?.title === 'string' && taskChat.title !== '' ? taskChat.title : null,
      projectChats: this.#driver.supportsProjectChats?.() === true,
    }
    await this.#store.add(run)
    await this.#pruneRuns(sessionId)
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.copy.preparing',
      params: { project: path.basename(project) },
      text: `Preparing a copy of ${path.basename(project)}.`,
    })

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
      // Orchestrator only: the host-side stage machine (never persisted).
      orch: null,
    }
    this.#runs.set(runId, runtime)

    if (mode === 'orchestrator') {
      // An Orchestrator run copies nothing yet: the parts are unknown until the
      // planner answers. It only records the base state the run works from — the
      // real project, or the base version a seeded run starts below — so every
      // part copy and the assembly can be diffed against it later.
      try {
        const tree = await hashTree(sourcePath, { exclude: this.#config.excludeGlobs ?? [] })
        runtime.base = tree.files
        await this.#store.patch(runId, { baseHashes: tree.files, copyKind: 'directory' })
        await this.#feed(runId, {
          kind: 'status',
          key: 'feed.plan.reading-project',
          text: 'Reading the project and splitting the goal into parts. Nothing is edited in this step.',
        })
      } catch (error) {
        await this.#fail(runId, error)
        throw new ArtelError(`Could not read the project: ${error.message}`, 500, 'artel/copy-failed')
      }
    } else {
      try {
        const copied = await copyProjectTree(sourcePath, copyPath, {
          exclude: this.#config.excludeGlobs ?? [],
        })
        // Seeded from a version copy: the manifest must still be the REAL project
        // content, or the version would show and apply only its own delta — except
        // for an isolated queue run, which is one step of a branch and diffs
        // against its own seed (the branch tip it started from).
        const base = isolateFromBase === true
          ? copied.base
          : sourcePath === project
            ? copied.base
            : (await hashTree(project, { exclude: this.#config.excludeGlobs ?? [] })).files
        runtime.base = base
        await this.#store.patch(runId, { baseHashes: base, copyKind: 'directory' })
        const copyReadyKey = copied.linkedNodeModules
          ? (sourcePath === project ? 'feed.copy.ready-linked' : 'feed.copy.ready-linked-seeded')
          : (sourcePath === project ? 'feed.copy.ready' : 'feed.copy.ready-seeded')
        await this.#feed(runId, {
          kind: 'status',
          key: copyReadyKey,
          params: { files: copied.files },
          text: `Copy ready: ${copied.files} files${copied.linkedNodeModules ? ', node_modules linked' : ''}${sourcePath === project ? '' : ', seeded from the previous version'}.`,
        })
      } catch (error) {
        await this.#fail(runId, error)
        throw new ArtelError(`Could not copy the project: ${error.message}`, 500, 'artel/copy-failed')
      }
    }

    // Swarm runs go peer-first: when the profile provides the subagent stack,
    // the three agents live in ONE conversation tree and can message each other.
    // Without it, the legacy independent-session swarm still works.
    const peerSwarm = mode === 'swarm' && run.agents.length > 1 && this.#driver.supportsPeers?.() === true
    try {
      if (mode === 'orchestrator') {
        await this.#startOrchestrator(runId, run, runtime, { project })
      } else if (mode === 'conductor') {
        await this.#startConductor(runId, run, runtime, { project, copyPath })
      } else if (mode === 'fusion') {
        await this.#startFusion(runId, run, runtime, { project, copyPath })
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
            sandboxMode: sandboxMode ?? undefined,
          })
          this.#register(runId, runtime, agent, handle)
          await this.#warnAboutModel(runId, handle)
        }
        await this.#syncAgents(runId, runtime, 'planning')

        if (mode === 'solo') {
          await this.#store.patch(runId, { status: 'running' })
          await this.#feed(runId, { kind: 'status', key: 'feed.agent.starting', params: { agent: names[0] }, text: `${names[0]} is starting on the task.` })
          const rt = [...runtime.agents.values()][0]
          await this.#send(runId, rt, soloPrompt({ copyPath, projectPath: project, task: run.task }))
        } else {
          await this.#store.patch(runId, { status: 'planning' })
          await this.#feed(runId, { kind: 'status', key: 'feed.agents.planning', text: 'All three agents are reading the project and dividing the work. Nothing is edited in this step.' })
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

    // A Fusion run routes every slot itself, so one shared route line would be a
    // lie; the per-agent model pickers on the run page show the real routes.
    if (requested !== null && mode !== 'fusion') {
      const catalog = await this.#catalog()
      const route = describeSelection(catalog, requested)
      const single = names.length === 1
      await this.#feed(runId, {
        kind: 'status',
        key: single ? 'feed.run.route' : 'feed.run.route-all',
        params: single ? { agent: names[0], route } : { route },
        text: `${single ? names[0] : 'All agents'} runs on ${route}${single ? '' : ' (one route each)'}.`,
      })
    }

    return this.#summary(this.#requireRun(runId))
  }

  /**
   * Validate the per-slot routes of a Fusion run.
   *
   * The request carries a small map — `panel` (three selections, in order),
   * `judge` and `implementer` — because Fusion is the only mode where every
   * agent may use a different model. A missing slot falls back to the single
   * `model` route and then to the deployment default (`null`), which the driver
   * leaves alone.
   * @param {{ models?: object, fallback?: object | null }} request - routes.
   * @returns {Promise<Array<object | null>>} one validated selection per slot.
   */
  async #fusionModels({ models, fallback = null }) {
    const panel = Array.isArray(models?.panel) ? models.panel : []
    const slots = []
    for (let index = 0; index < PANEL_SIZE; index += 1) slots.push(panel[index] ?? fallback ?? null)
    slots.push(models?.judge ?? fallback ?? null)
    slots.push(models?.implementer ?? fallback ?? null)

    if (slots.every((entry) => entry === null || entry === undefined)) return slots.map(() => null)
    const catalog = await this.#catalog()
    return slots.map((entry) => {
      if (entry === null || entry === undefined) return null
      const selection = normalizeSelection(entry)
      if (selection === null) throw new ArtelError('Pick a provider and a model first', 400, 'artel/bad-model')
      const check = validateSelection(catalog, selection)
      if (!check.ok) throw new ArtelError(check.reason, 400, check.code)
      return selection
    })
  }

  /**
   * Start a Fusion run: three panel models answer the task independently, a
   * judge merges their answers, and an implementer carries the merged decision
   * into the copy.
   *
   * The panel and the judge are created read-only, so the product rule — nobody
   * touches a file while the team is still deciding how to do the work — is
   * enforced by the sandbox, not only by the prompt. The judge and the
   * implementer are created now but prompted in their stage; until then their
   * `done` flag is true so the idle check ignores them.
   * @param {string} runId - run id.
   * @param {object} run - stored run record.
   * @param {object} runtime - run runtime.
   * @param {{ project: string, copyPath: string }} paths - project and copy.
   * @returns {Promise<void>} completes once the panel was prompted.
   */
  async #startFusion(runId, run, runtime, { project, copyPath }) {
    runtime.stage = 'panel'
    runtime.panelAnswers = []
    runtime.synthesis = ''
    runtime.disputes = null
    runtime.judgeRetries = 0
    runtime.judgePrompt = ''

    const titleTask = run.task.length > 48 ? `${run.task.slice(0, 48)}…` : run.task
    for (const agent of run.agents) {
      const readOnly = agent.role === 'panelist' || agent.role === 'judge'
      const handle = await this.#driver.createAgent({
        name: agent.name,
        mode: 'fusion',
        projectPath: project,
        copyPath,
        agentId: agent.id,
        parentSessionId: run.sessionId,
        title: `Artel · Fusion · ${agent.name} — ${titleTask}`,
        model: agent.model ?? null,
        sandboxMode: readOnly ? 'read-only' : undefined,
      })
      const record = this.#register(runId, runtime, agent, handle)
      runtime.agents.get(record.id).fusionText = ''
      await this.#warnAboutModel(runId, handle)
    }
    for (const rt of runtime.agents.values()) {
      if (rt.record.role !== 'panelist') rt.done = true
    }
    await this.#store.patch(runId, { status: 'planning' })
    await this.#syncAgents(runId, runtime)
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.fusion.panel',
      text: 'Three models are answering the same question independently. Nothing is edited in this step.',
    })
    for (const agent of run.agents) {
      if (agent.role !== 'panelist') continue
      const rt = runtime.agents.get(agent.id)
      rt.done = false
      await this.#send(runId, rt, fusionPanelPrompt({
        copyPath,
        projectPath: project,
        task: run.task,
        selfName: agent.name,
        panelSize: PANEL_SIZE,
      }))
    }
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
    const who = others.length === 1
      ? `${roster[0]} and ${others[0]}`
      : `${roster.slice(0, -1).join(', ')} and ${others[others.length - 1]}`
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.agents.planning-together',
      params: { agents: who },
      text: `${who} are reading the project and dividing the work. They can message each other; nothing is edited in this step.`,
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
      key: 'feed.agents.conductor-planning',
      params: { conductor: conductor.name, workers: workers.length },
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
        await this.#feed(runId, { kind: 'status', key: 'feed.plan.no-ownership', text: 'No ownership lines were announced. Asking the agents to divide the work again.' })
        const retry = 'You did not announce any files. Reply with exactly one line `OWNERSHIP: <paths>` naming the files or folders you will edit. Do not edit anything yet. If you must agree with a teammate first, send them one short message.'
        for (const row of aliveRows) {
          const rt = runtime.agents.get(row.id)
          rt.done = false
          await this.#send(runId, rt, retry)
        }
        return
      }
      aliveRows = await this.#fallbackClaims(run, runtime, aliveRows)
      await this.#feed(runId, { kind: 'status', key: 'feed.plan.top-level-split', text: 'Nobody announced ownership twice, so Artel split the top level of the project between the agents.' })
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
    await this.#feed(runId, { kind: 'plan', key: 'feed.plan.shares', params: { map }, text: `Proposed shares (the conductor decides):\n${map}`, map })
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
        await this.#feed(runId, { kind: 'status', key: 'feed.plan.shares-retry', text: 'The conductor did not announce the shares. Asking again.' })
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
    await this.#feed(runId, { kind: 'plan', key: 'feed.plan.shares-handout', params: { map }, text: `The shares are handed out. No edits yet.\n${map}`, map })
    await this.#feed(runId, { kind: 'status', key: 'feed.run.parallel-edits', text: 'The files are being edited in parallel. Your project stays untouched until you apply.' })

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
    await this.#feed(runId, { kind: 'status', key: 'feed.run.review', text: 'Every agent is idle. The conductor is reviewing the whole copy.' })
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
        await this.#feed(runId, { kind: 'status', key: 'feed.run.verdict-retry', text: 'The conductor did not give a verdict. Asking again.' })
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
      await this.#feed(runId, { kind: 'status', key: 'feed.run.rework-limit', text: 'The conductor asked for another pass, but the two-round limit is reached. The work goes to you with its remarks.' })
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
    const names = targets.map((row) => row.record.name).join(', ')
    const acceptedNames = others.map((row) => row.record.name).join(', ')
    const planKey = others.length > 0
      ? (verdict.notes !== '' ? 'feed.plan.rework-accepted-remarks' : 'feed.plan.rework-accepted')
      : (verdict.notes !== '' ? 'feed.plan.rework-remarks' : 'feed.plan.rework')
    await this.#feed(runId, {
      kind: 'plan',
      key: planKey,
      params: { round: runtime.reviewRounds, targets: names, accepted: acceptedNames, remarks: verdict.notes },
      text: lines.join('\n'),
    })
    const tail = others.length > 0 ? '; the other shares are accepted for now.' : '.'
    const backKey = others.length > 0
      ? (targets.length === 1 ? 'feed.run.rework-back-one-accepted' : 'feed.run.rework-back-accepted')
      : (targets.length === 1 ? 'feed.run.rework-back-one' : 'feed.run.rework-back')
    await this.#feed(runId, { kind: 'status', key: backKey, params: { names }, text: `${names} ${targets.length === 1 ? 'is' : 'are'} back for rework${tail}` })

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
      key: notes === '' ? 'feed.plan.accepted' : 'feed.plan.accepted-notes',
      params: notes === '' ? {} : { notes },
      text: notes === '' ? 'The conductor accepted the work.' : `The conductor accepted the work.\n${notes}`,
    })
    await this.#feed(runId, { kind: 'status', key: 'feed.run.checks-accepted', text: 'The checks ran on the whole copy and the conductor accepted the result. The decision is yours.' })
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
      await this.#feed(runId, { kind: 'error', key: 'feed.agent.stopped', params: { agent: name, kind }, text: `${name} stopped (${kind}). The team continues without it.` })
      return 'continue'
    }
    if (['working', 'review', 'rework'].includes(runtime.stage)) {
      runtime.stage = 'handover'
      runtime.failure = { agentId: rt.record.id, name, kind }
      runtime.shareRetries = 0
      await this.#feed(runId, { kind: 'error', key: 'feed.agent.stopped-share', params: { agent: name, kind }, text: `${name} stopped (${kind}). The conductor is moving that share.` })
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
    await this.#feed(runId, { kind: 'error', key: 'feed.agent.stopped', params: { agent: name, kind }, text: `${name} stopped (${kind}). The team continues without it.` })
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
      await this.#feed(runId, { kind: 'status', key: 'feed.run.share-moved-fallback', params: { receiver }, text: `The conductor did not answer; Artel moved the share to ${receiver}.` })
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
      await this.#feed(runId, { kind: 'plan', key: 'feed.plan.share-closed', params: { agent: failure.name }, text: `The conductor closed ${failure.name}'s share: nothing was assigned to it.` })
      return false
    }
    await this.#feed(runId, {
      kind: 'plan',
      key: 'feed.plan.share-moved',
      params: { agent: failure.name, receiver: receiverName, paths: paths.join(', ') },
      text: `The conductor moved ${failure.name}'s share to ${receiverName}.\n${paths.join(', ')}`,
    })
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

  /* ----------------------------------------------------------- orchestrator */

  /**
   * How many parts the planner is asked for. The configuration asks for a
   * number; the plan itself may still be longer, and then it is folded down to
   * MAX_ORCHESTRATOR_PARTS by `parsePlan`.
   * @returns {number} part limit between 2 and MAX_ORCHESTRATOR_PARTS.
   */
  #orchestratorPartLimit() {
    const configured = Number(this.#config.orchestratorParts)
    const wanted = Number.isFinite(configured) ? Math.trunc(configured) : 3
    return Math.min(MAX_ORCHESTRATOR_PARTS, Math.max(2, wanted))
  }

  /**
   * Start an Orchestrator run: only the planner is created, and it is asked for
   * the plan. Every part copy and every part agent is created later, when the
   * plan is actually known.
   * @param {string} runId - run id.
   * @param {object} run - stored run record.
   * @param {object} runtime - host-side runtime of the run.
   * @param {{ project: string }} request - paths of the run.
   * @returns {Promise<void>} completes once the planner was prompted.
   */
  async #startOrchestrator(runId, run, runtime, { project }) {
    runtime.orch = {
      stage: 'planning',
      planRetries: 0,
      // Several parts can be under review at the same time: retries are counted
      // per part, so a silent reviewer of one part cannot consume another's retry.
      reviewRetries: {},
      mergerTries: 0,
      conflicts: [],
      mergerId: null,
      // One fixer at a time repairs the assembled copy after a failed check.
      fixing: false,
    }
    await this.#store.patch(runId, { status: 'planning' })
    // A seeded Orchestrator reads the base version, never the real project: the
    // planner gets its own copy of the seed, materialised exactly like a part.
    const source = this.#orchestratorSource(run)
    const seeded = path.resolve(source) !== path.resolve(run.projectPath)
    let copyPath = source
    if (seeded) {
      copyPath = path.join(this.#copyRoot, `${run.id}-planner`)
      await copyProjectTree(source, copyPath, { exclude: this.#config.excludeGlobs ?? [] })
      await this.#feed(runId, {
        kind: 'status',
        key: 'feed.plan.read-only-copy',
        text: 'The planner reads a read-only copy of the base version. Nothing is edited in this step.',
      })
    }
    const planner = run.agents[0]
    const snippet = run.task.length > 48 ? `${run.task.slice(0, 48)}…` : run.task
    const handle = await this.#driver.createAgent({
      name: planner.name,
      mode: 'orchestrator',
      projectPath: project,
      // The planner reads the real project — or, for a seeded run, its own copy
      // of the base version; either way it is read-only in the sandbox, so it can
      // never write to it.
      copyPath,
      agentId: planner.id,
      parentSessionId: run.sessionId,
      title: `Artel · Orchestrator · ${planner.name} — ${snippet}`,
      model: planner.model ?? null,
      sandboxMode: 'read-only',
    })
    this.#register(runId, runtime, planner, handle)
    await this.#warnAboutModel(runId, handle)
    await this.#syncAgents(runId, runtime)
    const rt = runtime.agents.get(planner.id)
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.plan.planner-reading',
      params: { agent: planner.name },
      text: `${planner.name} is reading the project and splitting the goal into parts. Nothing is edited in this step.`,
    })
    rt.done = false
    await this.#send(runId, rt, orchestratorPlanPrompt({
      // The prompt names the copy the planner can actually read.
      projectPath: copyPath,
      task: run.task,
      maxParts: this.#orchestratorPartLimit(),
    }))
  }

  /**
   * Create one more agent of an Orchestrator run and attach it to the run.
   *
   * Orchestrator agents are ordinary Session runs (like Fusion), not subagents:
   * a part is isolated by its copy and by its sandbox, not by a conversation
   * tree. Names come from the same pool, so a full run reads as one team.
   * @param {string} runId - run id.
   * @param {object} run - stored run record (new agent is pushed into it).
   * @param {object} runtime - host-side runtime of the run.
   * @param {{ role: string, copyPath: string, sandboxMode?: string, title: string }} request - agent slot.
   * @returns {Promise<object>} the runtime row of the new agent.
   */
  async #createOrchestratorAgent(runId, run, runtime, { role, copyPath, sandboxMode, title }) {
    const index = run.agents.length
    const name = AGENT_NAMES[index] ?? `Agent ${index + 1}`
    const plannerModel = run.agents[0]?.model ?? null
    const agent = {
      id: `${run.id}-a${index + 1}`,
      name,
      role,
      status: 'starting',
      claimed: [],
      model: plannerModel,
    }
    run.agents.push(agent)
    const snippet = run.task.length > 48 ? `${run.task.slice(0, 48)}…` : run.task
    const handle = await this.#driver.createAgent({
      name,
      mode: 'orchestrator',
      projectPath: run.projectPath,
      copyPath,
      agentId: agent.id,
      parentSessionId: run.sessionId,
      title: `${title} · ${name} — ${snippet}`,
      model: plannerModel,
      sandboxMode,
    })
    this.#register(runId, runtime, agent, handle)
    await this.#warnAboutModel(runId, handle)
    return runtime.agents.get(agent.id)
  }

  /**
   * Settle the planner's turn: parse the plan, store it, then build the parts.
   *
   * An unreadable plan is asked for once more; a second failure ends the run,
   * because without a plan there is nothing to split and nothing to check.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes once the parts are started or the run failed.
   */
  async #settleOrchestratorPlanning(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch || runtime.orch.stage !== 'planning' || run.status !== 'planning') return
    this.#cancelIdleCheck(runId)
    const plannerRt = [...runtime.agents.values()].find((row) => row.record.role === 'planner')
    if (!plannerRt) {
      await this.#fail(runId, new ArtelError('The planner is gone, so the goal could not be split.', 500, 'artel/plan-failed'))
      return
    }
    const parsed = parsePlan(plannerRt.turnText !== '' ? plannerRt.turnText : plannerRt.planText, { maxParts: this.#orchestratorPartLimit() })
    if (parsed.parts.length === 0) {
      runtime.orch.planRetries += 1
      if (runtime.orch.planRetries <= 1) {
        plannerRt.done = false
        plannerRt.planText = ''
        await this.#feed(runId, { kind: 'status', key: 'feed.plan.unreadable-retry', text: 'The planner did not write a readable plan. Asking once more.' })
        await this.#send(runId, plannerRt, orchestratorPlanPrompt({
          projectPath: run.projectPath,
          task: run.task,
          maxParts: this.#orchestratorPartLimit(),
          retry: true,
        }))
        return
      }
      await this.#fail(runId, new ArtelError('The planner could not split the goal into parts. Nothing was edited.', 500, 'artel/plan-failed'))
      return
    }

    // The plan is the contract of the whole run: store it before a single copy
    // exists, so a restart leaves the user with the plan and not with silent work.
    const plan = {
      summary: parsed.summary !== '' ? parsed.summary : null,
      parts: parsed.parts.map((part) => ({
        ...part,
        status: 'pending',
        rounds: 0,
        remarks: null,
        workerId: null,
        workerName: null,
        reviewerId: null,
        reviewerName: null,
        copyPath: null,
      })),
      folded: parsed.folded,
      problems: parsed.problems,
    }
    await this.#store.patch(runId, { plan })
    await this.#feed(runId, { kind: 'plan', text: planCard(plan) })
    if (parsed.problems.length > 0) {
      await this.#feed(runId, {
        kind: 'status',
        key: 'feed.plan.incomplete',
        params: { problems: parsed.problems.join('; ') },
        text: `The plan is incomplete (${parsed.problems.join('; ')}); the run starts with what it has.`,
      })
    }
    // Factory tickets can require the user's approval of the plan before a single
    // part copy is made: nobody may approve an epic merge on the user's behalf.
    if (run.planApproval === true && run.planApproved !== true) {
      await this.#store.patch(runId, { status: 'waiting' })
      await this.#feed(runId, {
        kind: 'status',
        key: 'feed.plan.ready',
        text: 'The plan is ready. Nothing is copied and nothing is edited until you approve it.',
      })
      return
    }
    try {
      await this.#startOrchestratorParts(runId)
    } catch (error) {
      await this.#fail(runId, error instanceof ArtelError ? error : new ArtelError(`Could not start the parts: ${error.message}`, 500, 'artel/part-failed'))
    }
  }

  /**
   * Build the parts of a stored plan: one copy per part, one worker and one
   * reviewer per copy, then every worker starts on its own part.
   *
   * The copies are made from the user's real project and added to the copy root
   * with a `-p<n>` suffix, so they are cleaned up by the ordinary copy sweep.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes once every worker was prompted.
   */
  async #startOrchestratorParts(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch || run.mode !== 'orchestrator') return
    const plan = run.plan
    if (!plan || plan.parts.length === 0) return
    const parts = plan.parts
    this.#cancelIdleCheck(runId)
    await this.#feed(runId, {
      kind: 'status',
      key: parts.length === 1 ? 'feed.copy.preparing-parts-one' : 'feed.copy.preparing-parts',
      params: parts.length === 1 ? {} : { n: parts.length },
      text: `Preparing ${parts.length} ${parts.length === 1 ? 'copy' : 'copies'} of the project, one per part.`,
    })

    // A seeded run copies its parts from the base version, never from the real
    // project: the whole run works below the seed and the diff says so.
    const source = this.#orchestratorSource(run)
    let base = null
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      part.copyPath = path.join(this.#copyRoot, `${run.id}-p${index + 1}`)
      const copied = await copyProjectTree(source, part.copyPath, { exclude: this.#config.excludeGlobs ?? [] })
      // All parts and the assembly are diffed against the SAME base manifest:
      // the first copy is the run's snapshot of the base version.
      if (base === null) {
        base = copied.base
        runtime.base = base
        await this.#store.patch(runId, { baseHashes: base })
      }
    }
    // The planner is done reading: its copy is not needed again.
    await this.#removePlannerCopy(run)

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const label = partLabel(part, index)
      const worker = await this.#createOrchestratorAgent(runId, run, runtime, {
        role: 'part',
        copyPath: part.copyPath,
        title: `Artel · ${label}`,
      })
      const reviewer = await this.#createOrchestratorAgent(runId, run, runtime, {
        role: 'reviewer',
        copyPath: part.copyPath,
        sandboxMode: 'read-only',
        title: `Artel · Review · ${label}`,
      })
      part.workerId = worker.record.id
      part.workerName = worker.record.name
      part.reviewerId = reviewer.record.id
      part.reviewerName = reviewer.record.name
      part.status = 'working'
    }

    await this.#store.patch(runId, { plan })
    runtime.orch.stage = 'working'
    await this.#syncAgents(runId, runtime, 'idle')
    await this.#store.patch(runId, { status: 'running' })
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.agents.parts-working',
      params: { n: parts.length },
      text: `${parts.length} agents are working on ${parts.length} parts in separate copies. The user project is untouched.`,
    })
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const workerRt = runtime.agents.get(part.workerId)
      if (!workerRt) continue
      workerRt.done = false
      await this.#send(runId, workerRt, orchestratorWorkerPrompt({
        copyPath: part.copyPath,
        projectPath: run.projectPath,
        task: run.task,
        part,
        partNumber: index + 1,
        partCount: parts.length,
      }))
    }
  }

  /**
   * A part worker is done: ask its reviewer to check the copy against the plan.
   * @param {string} runId - run id.
   * @param {string} partId - id of the part that was finished.
   * @returns {Promise<void>} completes once the reviewer was prompted.
   */
  async #startOrchestratorReview(runId, partId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch) return
    const part = (run.plan?.parts ?? []).find((entry) => entry.id === partId)
    if (!part || (part.status !== 'working' && part.status !== 'rework')) return
    const reviewerRt = runtime.agents.get(part.reviewerId)
    if (!reviewerRt) {
      await this.#fail(runId, new ArtelError(`The reviewer of ${partLabel(part)} is gone.`, 500, 'artel/part-failed'))
      return
    }
    part.status = 'reviewing'
    await this.#store.patch(runId, { plan: run.plan })
    runtime.orch.reviewRetries[partId] = 0
    reviewerRt.done = false
    await this.#feed(runId, {
      kind: 'status',
      key: part.workerName ? 'feed.part.review' : 'feed.part.review-generic',
      params: part.workerName
        ? { part: partLabel(part), worker: part.workerName, reviewer: part.reviewerName }
        : { part: partLabel(part), reviewer: part.reviewerName },
      text: `${partLabel(part)}: ${part.workerName ?? 'the worker'} is done; ${part.reviewerName} is checking the copy against the plan.`,
    })
    await this.#send(runId, reviewerRt, orchestratorReviewPrompt({
      copyPath: part.copyPath,
      projectPath: run.projectPath,
      task: run.task,
      part,
      digest: await this.#partDigest(run, part),
      round: part.rounds ?? 0,
    }))
  }

  /**
   * Describe the changes inside one part copy for the reviewer prompt.
   * @param {object} run - stored run record.
   * @param {object} part - part record with its `copyPath`.
   * @returns {Promise<string>} change digest, empty when nothing changed.
   */
  async #partDigest(run, part) {
    if (typeof part?.copyPath !== 'string' || part.copyPath === '') return ''
    const changes = await collectChanges({
      copyRoot: part.copyPath,
      beforeRoot: this.#beforeRoot(run),
      base: run.baseHashes ?? {},
      options: { exclude: this.#config.excludeGlobs ?? [], context: this.#config.diffContext },
    }).catch(() => [])
    return changeDigest(changes)
  }

  /**
   * Take the reviewer's verdict on one part.
   *
   * accept — the part is done and waits for the assembly; rework — the part goes
   * back to its worker with the concrete defects, at most
   * MAX_ORCHESTRATOR_REWORK times, after which the part is accepted with the
   * remarks so the user sees what is still open.
   * @param {string} runId - run id.
   * @param {string} partId - id of the part under review.
   * @returns {Promise<void>} completes when the part moved on.
   */
  async #applyOrchestratorVerdict(runId, partId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch) return
    const part = (run.plan?.parts ?? []).find((entry) => entry.id === partId)
    if (!part || part.status !== 'reviewing') return
    const reviewerRt = runtime.agents.get(part.reviewerId)
    if (!reviewerRt) {
      await this.#fail(runId, new ArtelError(`The reviewer of ${partLabel(part)} is gone.`, 500, 'artel/part-failed'))
      return
    }
    const parsed = parseReview(reviewerRt.turnText !== '' ? reviewerRt.turnText : reviewerRt.lastText)

    if (parsed.verdict === 'missing') {
      const retries = runtime.orch.reviewRetries ?? (runtime.orch.reviewRetries = {})
      const tried = retries[partId] ?? 0
      retries[partId] = tried + 1
      if (tried < 1) {
        reviewerRt.done = false
        await this.#feed(runId, { kind: 'status', key: 'feed.part.review-retry', params: { part: partLabel(part) }, text: `${partLabel(part)}: the reviewer gave no readable verdict. Asking once more.` })
        await this.#send(runId, reviewerRt, orchestratorReviewPrompt({
          copyPath: part.copyPath,
          projectPath: run.projectPath,
          task: run.task,
          part,
          digest: await this.#partDigest(run, part),
          round: part.rounds ?? 0,
          retry: true,
        }))
        return
      }
      await this.#acceptOrchestratorPart(runId, part, parsed.notes !== '' ? `The reviewer gave no verdict: ${parsed.notes}` : 'The reviewer gave no verdict twice.')
      return
    }

    if (parsed.verdict === 'accept') {
      await this.#acceptOrchestratorPart(runId, part, parsed.notes)
      return
    }

    const round = part.rounds ?? 0
    if (round >= MAX_ORCHESTRATOR_REWORK) {
      const problems = parsed.problems.length > 0 ? parsed.problems.join('; ') : parsed.notes
      await this.#acceptOrchestratorPart(runId, part, `Sent back ${round} times. Last review: ${problems}`)
      return
    }
    const workerRt = runtime.agents.get(part.workerId)
    if (!workerRt) {
      await this.#fail(runId, new ArtelError(`The worker of ${partLabel(part)} is gone.`, 500, 'artel/part-failed'))
      return
    }
    part.status = 'rework'
    part.rounds = round + 1
    part.remarks = parsed.problems.length > 0 ? parsed.problems.join('\n') : parsed.notes
    await this.#store.patch(runId, { plan: run.plan })
    await this.#feed(runId, {
      kind: 'status',
      key: 'feed.part.rework',
      params: { part: partLabel(part), worker: part.workerName, round: part.rounds, total: MAX_ORCHESTRATOR_REWORK },
      text: `${partLabel(part)}: sent back to ${part.workerName} (rework ${part.rounds} of ${MAX_ORCHESTRATOR_REWORK}).`,
    })
    if (parsed.problems.length > 0) {
      await this.#feed(runId, {
        kind: 'status',
        text: `${partLabel(part)} review: ${parsed.problems.join('; ').slice(0, 600)}`,
      })
    }
    workerRt.done = false
    await this.#send(runId, workerRt, orchestratorReworkPrompt({
      copyPath: part.copyPath,
      projectPath: run.projectPath,
      task: run.task,
      part,
      problems: parsed.problems,
      round: part.rounds,
      maxRounds: MAX_ORCHESTRATOR_REWORK,
      partNumber: (run.plan.parts.findIndex((entry) => entry.id === part.id) ?? 0) + 1,
      partCount: run.plan.parts.length,
    }))
  }

  /**
   * Accept one part: record it, tell the user, and move on when every part is
   * accepted.
   * @param {string} runId - run id.
   * @param {object} part - part record from the stored plan.
   * @param {string} [notes] - reviewer notes or rework summary kept for the user.
   * @returns {Promise<void>} completes when the run moved on.
   */
  async #acceptOrchestratorPart(runId, part, notes) {
    const run = this.#requireRun(runId)
    const plan = run.plan
    if (!plan) return
    part.status = 'accepted'
    if (typeof notes === 'string' && notes.trim() !== '') part.remarks = notes.trim()
    await this.#store.patch(runId, { plan })
    const note = part.remarks ? ` — ${part.remarks.split('\n')[0].slice(0, 300)}` : ''
    const line = `${partLabel(part)}: accepted${note}`
    await this.#feed(runId, {
      kind: 'status',
      text: /[.!?]$/.test(line) ? line : `${line}.`,
    })
    await this.#afterOrchestratorPart(runId)
  }

  /**
   * Check whether every part is accepted, and start the assembly when it is.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes when the run moved on.
   */
  async #afterOrchestratorPart(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch) return
    const parts = run.plan?.parts ?? []
    if (parts.length === 0) return
    if (parts.some((part) => part.status === 'failed')) return
    if (parts.every((part) => part.status === 'accepted')) await this.#startOrchestratorMerge(runId)
  }

  /**
   * Assemble every accepted part into one copy.
   *
   * Changes are collected per part against the run's base manifest. A file only
   * one part changed is copied into the assembly as is; a file several parts
   * changed with identical content is copied once; the rest is a conflict and
   * goes to a merger with the base and every variant on disk.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes once the assembly is done or the merger started.
   */
  async #startOrchestratorMerge(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch || runtime.orch.stage !== 'working') return
    runtime.orch.stage = 'merging'
    this.#cancelIdleCheck(runId)
    const accepted = (run.plan?.parts ?? []).filter((part) => part.status === 'accepted')
    if (accepted.length === 0) {
      await this.#fail(runId, new ArtelError('No part was accepted, so there is nothing to assemble.', 500, 'artel/merge-incomplete'))
      return
    }
    await this.#feed(runId, {
      kind: 'status',
      text: `Every part is accepted. Assembling ${accepted.length} ${accepted.length === 1 ? 'part' : 'parts'} into one copy.`,
    })
    try {
      // A seeded run assembles from its base version, like every part did.
      const copied = await copyProjectTree(this.#orchestratorSource(run), run.copyPath, { exclude: this.#config.excludeGlobs ?? [] })
      runtime.base = copied.base
      await this.#store.patch(runId, { baseHashes: copied.base, copyKind: 'directory' })
    } catch (error) {
      await this.#fail(runId, new ArtelError(`Could not create the assembly copy: ${error.message}`, 500, 'artel/merge-incomplete'))
      return
    }

    const variants = new Map()
    for (const part of accepted) {
      const changes = await collectChanges({
        copyRoot: part.copyPath,
        beforeRoot: this.#beforeRoot(run),
        base: run.baseHashes ?? {},
        options: { exclude: this.#config.excludeGlobs ?? [], context: this.#config.diffContext },
      }).catch(() => [])
      for (const change of changes) {
        const entry = variants.get(change.path) ?? { path: change.path, items: [] }
        entry.items.push({ part, change })
        variants.set(change.path, entry)
      }
    }

    const direct = []
    const conflicts = []
    for (const entry of [...variants.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (entry.items.length === 1) {
        direct.push(entry.items[0])
        continue
      }
      const hashes = []
      for (const item of entry.items) {
        if (item.change.status === 'deleted') {
          hashes.push('deleted')
          continue
        }
        const file = await hashFile(path.join(item.part.copyPath, entry.path)).catch(() => null)
        hashes.push(file?.hash ?? 'missing')
      }
      if (hashes.every((hash) => hash === hashes[0])) direct.push(entry.items[0])
      else conflicts.push(entry)
    }
    for (const item of direct) await this.#copyVariantToAssembly(run, item)

    if (conflicts.length === 0) {
      await this.#finishOrchestratorMerge(runId, 0)
      return
    }

    const conflictsDir = path.join(run.copyPath, CONFLICT_DIR, 'conflicts')
    await this.#writeConflictBundles(run, conflicts, conflictsDir)
    const storedConflicts = conflicts.map((entry) => ({
      path: entry.path,
      parts: entry.items.map((item) => partLabel(item.part)),
    }))
    runtime.orch.conflicts = conflicts
    run.merge = { conflicts: storedConflicts, unresolved: storedConflicts.map((entry) => entry.path), merged: false }
    await this.#store.patch(runId, { merge: run.merge })
    await this.#syncAgents(runId, runtime, 'idle')

    const merger = await this.#createOrchestratorAgent(runId, run, runtime, {
      role: 'merger',
      copyPath: run.copyPath,
      title: 'Artel · Merge',
    })
    runtime.orch.mergerId = merger.record.id
    await this.#store.patch(runId, { agents: run.agents })
    await this.#feed(runId, {
      kind: 'status',
      text: `${conflicts.length} file(s) were edited by more than one part (${storedConflicts.map((entry) => entry.path).join(', ')}). ${merger.record.name} is resolving them.`,
    })
    merger.done = false
    await this.#send(runId, merger, orchestratorMergePrompt({
      copyPath: run.copyPath,
      projectPath: run.projectPath,
      task: run.task,
      conflicts: this.#conflictPromptEntries(run, conflictsDir),
      conflictsDir,
    }))
  }

  /**
   * Copy one part's variant of a file into the assembly copy.
   * @param {object} run - stored run record (assembly at `copyPath`).
   * @param {{ part: object, change: object }} item - the variant to apply.
   * @returns {Promise<void>} completes when the file is written or removed.
   */
  async #copyVariantToAssembly(run, item) {
    const target = path.join(run.copyPath, item.change.path)
    if (item.change.status === 'deleted') {
      await fs.rm(target, { force: true })
      return
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(item.part.copyPath, item.change.path), target)
  }

  /**
   * Prompt-side description of every conflict bundle, in bundle order.
   * @param {object} run - stored run record.
   * @param {string} conflictsDir - directory holding the bundles.
   * @returns {Array<{ path: string, dir: string, parts: string[] }>} prompt entries.
   */
  #conflictPromptEntries(run, conflictsDir) {
    return (run.merge?.conflicts ?? []).map((entry, index) => ({
      path: entry.path,
      dir: path.join(conflictsDir, String(index + 1).padStart(2, '0')),
      parts: entry.parts,
    }))
  }

  /**
   * Write one conflict bundle per conflicting file: the path, the base version
   * and every part's variant. A part that deleted the file leaves a marker.
   * @param {object} run - stored run record.
   * @param {Array<{ path: string, items: Array<{ part: object, change: object }> }>} conflicts - conflicts to draw.
   * @param {string} conflictsDir - directory to write the bundles into.
   * @returns {Promise<void>} completes when all bundles exist.
   */
  async #writeConflictBundles(run, conflicts, conflictsDir) {
    await fs.mkdir(conflictsDir, { recursive: true })
    for (let index = 0; index < conflicts.length; index += 1) {
      const entry = conflicts[index]
      const bundle = path.join(conflictsDir, String(index + 1).padStart(2, '0'))
      await fs.mkdir(bundle, { recursive: true })
      await fs.writeFile(path.join(bundle, 'path.txt'), `${entry.path}\n`, 'utf8')
      // The base file of a conflict comes from the run's base version, not the
      // real project: a seeded run never shows the user's newer edits as "base".
      const base = path.join(this.#orchestratorSource(run), entry.path)
      await fs.copyFile(base, path.join(bundle, 'base')).catch(() => {})
      for (const item of entry.items) {
        const label = String(item.part.id ?? 'part')
        if (item.change.status === 'deleted') {
          await fs.writeFile(path.join(bundle, `${label}.deleted`), '', 'utf8')
          continue
        }
        await fs.copyFile(path.join(item.part.copyPath, entry.path), path.join(bundle, label)).catch(() => {})
      }
    }
  }

  /**
   * Check the merger's work: every conflicting path must differ from the base
   * version now. One retry, then the run fails with `merge.unresolved` stored,
   * which also blocks Apply in `apply()`.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes when assembly finished or failed.
   */
  async #validateOrchestratorMerge(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch || runtime.orch.stage !== 'merging') return
    const conflicts = runtime.orch.conflicts ?? []
    const unresolved = []
    for (const entry of conflicts) {
      const target = path.join(run.copyPath, entry.path)
      const current = await hashFile(target).catch(() => null)
      const baseHash = run.baseHashes?.[entry.path]?.hash ?? null
      if (baseHash === null) {
        // A file that did not exist before must exist now.
        if (current === null) unresolved.push(entry.path)
        continue
      }
      // The merger must produce a version different from the user's base: the
      // variants were all different, so leaving the base means nothing was decided.
      if (current !== null && current.hash === baseHash) unresolved.push(entry.path)
    }

    if (unresolved.length === 0) {
      await this.#finishOrchestratorMerge(runId, conflicts.length)
      return
    }
    run.merge = {
      ...(run.merge ?? { conflicts: [] }),
      unresolved,
      merged: false,
    }
    await this.#store.patch(runId, { merge: run.merge })
    runtime.orch.mergerTries += 1
    const mergerRt = runtime.orch.mergerId === null ? null : runtime.agents.get(runtime.orch.mergerId)
    if (runtime.orch.mergerTries > 1 || !mergerRt) {
      await this.#fail(runId, new ArtelError(
        `The merge could not be finished: ${unresolved.length} file(s) still need a decision (${unresolved.join(', ')}). The assembled copy is kept.`,
        500,
        'artel/merge-incomplete',
      ))
      return
    }
    const conflictsDir = path.join(run.copyPath, CONFLICT_DIR, 'conflicts')
    await this.#feed(runId, {
      kind: 'status',
      text: `The merger left ${unresolved.length} file(s) unresolved (${unresolved.join(', ')}). Asking once more.`,
    })
    mergerRt.done = false
    await this.#send(runId, mergerRt, orchestratorMergePrompt({
      copyPath: run.copyPath,
      projectPath: run.projectPath,
      task: run.task,
      conflicts: this.#conflictPromptEntries(run, conflictsDir),
      conflictsDir,
      unresolved,
      retry: true,
    }))
  }

  /**
   * Finish the assembly: clear the unresolved list, hand the assembled work to
   * the user, and drop the per-part copies (the assembly now holds the run).
   * @param {string} runId - run id.
   * @param {number} conflictCount - how many conflicts the merger resolved.
   * @returns {Promise<void>} completes once the run is waiting for the user.
   */
  async #finishOrchestratorMerge(runId, conflictCount) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime?.orch) return
    runtime.orch.stage = 'assembled'
    run.merge = {
      conflicts: run.merge?.conflicts ?? [],
      unresolved: [],
      merged: true,
    }
    await this.#store.patch(runId, { merge: run.merge })
    await this.#syncAgents(runId, runtime, 'idle')
    const changes = await this.changes(runId).catch(() => [])
    await this.#store.patch(runId, { status: 'waiting', changeCount: changes.length })
    await this.#feed(runId, { kind: 'plan', text: assembledCard(run.plan, { conflicts: conflictCount, files: changes.length }) })
    await this.#feed(runId, {
      kind: 'status',
      text: changes.length > 0
        ? 'The work is assembled in one copy. Review the diff and apply it, or discard the run.'
        : 'The parts were assembled, but they changed no files. Discard the run.',
    })
    await this.#removePartCopies(run)
  }

  /**
   * Drop the per-part copies of a run; the assembly copy is the run's copy now.
   * @param {object} run - stored run record.
   * @returns {Promise<void>} completes when the copies are gone.
   */
  async #removePartCopies(run) {
    const parts = run?.plan?.parts ?? []
    for (const part of parts) {
      if (typeof part?.copyPath !== 'string' || part.copyPath === '') continue
      await removeCopy(this.#copyRoot, part.copyPath).catch(() => {})
    }
    await this.#removePlannerCopy(run)
  }

  /**
   * Drop the planner's read-only copy of a seeded Orchestrator run.
   * @param {object} run - stored run record.
   * @returns {Promise<void>} completes when the copy is gone.
   */
  async #removePlannerCopy(run) {
    if (run?.mode !== 'orchestrator') return
    await removeCopy(this.#copyRoot, path.join(this.#copyRoot, `${run.id}-planner`)).catch(() => {})
  }

  /**
   * A part worker, reviewer or the merger stopped. An Orchestrator run is
   * all-or-nothing: one part that cannot be finished fails the whole run, so no
   * half-checked result ever reaches the user. The merger gets one retry.
   * @param {string} runId - run id.
   * @param {object} run - stored run record.
   * @param {object} runtime - host-side runtime of the run.
   * @param {object} rt - runtime row of the stopped agent.
   * @param {string} kind - failure kind from `failureKindOf`.
   * @returns {Promise<'continue' | 'fatal'>} whether the run can go on.
   */
  async #handleOrchestratorFailure(runId, run, runtime, rt, kind) {
    const role = rt.record.role
    const name = rt.record.name
    if (role === 'merger') {
      runtime.orch.mergerTries += 1
      if (runtime.orch.mergerTries <= 1) {
        const conflictsDir = path.join(run.copyPath, CONFLICT_DIR, 'conflicts')
        rt.done = false
        await this.#feed(runId, { kind: 'status', text: `The merger ${name} stopped (${kind}). Asking once more.` })
        await this.#send(runId, rt, orchestratorMergePrompt({
          copyPath: run.copyPath,
          projectPath: run.projectPath,
          task: run.task,
          conflicts: this.#conflictPromptEntries(run, conflictsDir),
          conflictsDir,
          unresolved: run.merge?.unresolved ?? [],
          retry: true,
        }))
        return 'continue'
      }
      await this.#fail(runId, new ArtelError(`The merger ${name} stopped (${kind}) and the merge is not finished. Nothing reaches your project; discard the run.`, 500, 'artel/merge-incomplete'))
      return 'fatal'
    }
    if (role === 'planner') {
      await this.#fail(runId, new ArtelError(`The planner ${name} stopped before the plan was ready (${kind}). Nothing was edited.`, 500, 'artel/plan-failed'))
      return 'fatal'
    }
    const part = (run.plan?.parts ?? []).find((entry) => entry.workerId === rt.record.id || entry.reviewerId === rt.record.id)
    if (part && part.status !== 'accepted') {
      part.status = 'failed'
      part.remarks = `${name} stopped (${kind}).`
      await this.#store.patch(runId, { plan: run.plan })
    }
    const where = part ? `${partLabel(part)}: ` : ''
    await this.#fail(runId, new ArtelError(`${where}${name} stopped (${kind}). The parts were not assembled, so nothing reaches your project.`, 500, 'artel/part-failed'))
    return 'fatal'
  }

  /**
   * Route the end of an Orchestrator turn to the stage that was waiting for it.
   * Anything unexpected is ignored: a stray turn must not move the run.
   * @param {string} runId - run id.
   * @param {object} run - stored run record.
   * @param {object} runtime - host-side runtime of the run.
   * @param {object} rt - runtime row of the agent that finished its turn.
   * @returns {Promise<boolean>} true when the turn advanced the run.
   */
  async #onOrchestratorTurnEnd(runId, run, runtime, rt) {
    const orch = runtime.orch
    if (!orch) return false
    const role = rt.record.role
    if (role === 'planner' && orch.stage === 'planning') {
      await this.#settleOrchestratorPlanning(runId)
      return true
    }
    if (role === 'part') {
      // Several parts can be finished at once, and a reviewer can still be busy
      // with another part: the part record decides, not one shared "awaiting" slot.
      const part = (run.plan?.parts ?? []).find((entry) => entry.workerId === rt.record.id)
      if (part?.status === 'working' || part?.status === 'rework') {
        await this.#startOrchestratorReview(runId, part.id)
        return true
      }
      return false
    }
    if (role === 'reviewer') {
      const part = (run.plan?.parts ?? []).find((entry) => entry.reviewerId === rt.record.id)
      if (part?.status === 'reviewing') {
        await this.#applyOrchestratorVerdict(runId, part.id)
        return true
      }
      return false
    }
    if (role === 'merger' && orch.stage === 'merging') {
      await this.#validateOrchestratorMerge(runId)
      return true
    }
    return false
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
    // The Orchestrator plan is still a conversation with the planner: there is
    // nobody to message yet, and a second task would only derail the split.
    if (run.mode === 'orchestrator' && run.status === 'planning') {
      throw new ArtelError('Wait until the planner splits the goal into parts', 409, 'artel/planning')
    }
    // A gated plan has no agents to message yet, and a chat line must not be read
    // as an approval: the card's Approve button is the only way forward.
    if (run.mode === 'orchestrator' && run.planApproval === true && run.planApproved !== true) {
      throw new ArtelError('Approve the plan first; then you can talk to the parts.', 409, 'artel/plan-approval')
    }
    // A stopped merge cannot be resumed: the assembled copy is kept for the diff,
    // but it cannot be handed to anyone until the conflicts are decided.
    if (run.mode === 'orchestrator' && runtime.orch?.stage === 'merge-stopped') {
      throw new ArtelError('The merge was stopped. Discard the run and plan it again.', 409, 'artel/merge-incomplete')
    }
    // After the assembly the per-part copies are gone: a message to a part agent
    // would wake it in a directory that no longer exists. The assembled result
    // belongs to the user now, so the run accepts Apply or Discard only.
    if (run.mode === 'orchestrator' && runtime.orch?.stage === 'assembled') {
      throw new ArtelError('The work is assembled. Review the diff and apply it, or discard the run.', 409, 'artel/bad-stage')
    }
    // During the Fusion panel and judge stages the run status stays `planning`:
    // the answers are a conversation, not work on the copy. Only the agents of
    // the active stage accept a message then; the others would derail the stage.
    if (run.mode === 'fusion' && run.status === 'planning') {
      const allowed = runtime.stage === 'judge' ? 'judge' : 'panelist'
      const explicitlyChosen = agentId !== undefined && agentId !== 'all'
      if (explicitlyChosen && targets.some((rt) => rt.record.role !== allowed)) {
        const where = allowed === 'judge' ? 'judge is still merging the answers' : 'panel is still answering'
        throw new ArtelError(`The Fusion ${where}. Wait until the work starts.`, 409, 'artel/planning')
      }
      // "Everyone" means the agents of the active stage: the other stages have no
      // conversation open yet (or are already done), and a message there would
      // only derail the merge.
      const recipients = explicitlyChosen
        ? targets
        : [...runtime.agents.values()].filter((rt) => rt.record.role === allowed)
      const broadcast = recipients.length > 1
      for (const rt of recipients) {
        await this.#feed(runId, { kind: 'user', text: text.trim(), agent: rt.record.name })
        rt.done = false
        await this.#send(runId, rt, userMessagePrompt({ text: text.trim(), broadcast, agentName: rt.record.name }))
      }
      return this.#summary(this.#requireRun(runId))
    }
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
    let stoppedText = 'You stopped the run. The copy is still here, so the diff stays available.'
    if (runtime) {
      // A stopped conductor run cannot resume its own review: fall back to the
      // working stage, so the diff is simply reviewable by the user.
      if (run.mode === 'conductor' && ['shares', 'review', 'handover'].includes(runtime.stage)) {
        runtime.stage = 'working'
        runtime.failure = null
      }
      // A stopped Fusion run cannot resume the deliberation: the panel and the
      // judge are already decided or gone. The copy is simply reviewable.
      if (run.mode === 'fusion') runtime.stage = 'working'
      // An Orchestrator run without an assembly has nothing to review yet, but its
      // per-part copies are kept: a message can still continue the run. A merge
      // stopped halfway keeps its assembly but stays blocked for Apply until the
      // conflicts are decided; the per-part copies are useless then.
      if (run.mode === 'orchestrator' && runtime.orch) {
        const stage = runtime.orch.stage
        if (stage === 'merging') {
          runtime.orch.stage = 'merge-stopped'
          stoppedText = 'You stopped the run in the middle of the merge. The assembled copy is kept, but it cannot be applied until the merge is finished. Discard the run if you do not need it.'
          await this.#removePartCopies(run)
        } else if (stage === 'assembled') {
          stoppedText = 'You stopped the run. The assembled copy is still here, so the diff stays available.'
          await this.#removePartCopies(run)
        } else {
          stoppedText = 'You stopped the run before the parts were assembled. Nothing reached your project; the part copies are still there, so you can send a message to continue.'
        }
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
    await this.#feed(runId, { kind: 'status', text: stoppedText })
    return this.#summary(this.#requireRun(runId))
  }

  /**
   * Approve the plan of an Orchestrator run that was started with
   * `planApproval: true`. The planned parts are built only after this call.
   * @param {string} runId - run id.
   * @returns {Promise<object>} the run summary after the parts were started.
   */
  async approvePlan(runId) {
    const run = this.#requireRun(runId)
    if (run.mode !== 'orchestrator' || run.planApproval !== true || run.plan === null) {
      throw new ArtelError('This run has no plan waiting for approval', 400, 'artel/no-plan')
    }
    if (run.status !== 'waiting') throw new ArtelError('The plan is not waiting for approval', 409, 'artel/bad-status')
    if (run.planApproved === true) return this.#summary(this.#requireRun(runId))
    // The planner's plan is the contract: approve it, then let the parts start
    // exactly the way they would in an unsupervised run.
    await this.#store.patch(runId, { planApproved: true, status: 'running' })
    await this.#feed(runId, { kind: 'status', text: 'The plan is approved. The parts are starting now.' })
    try {
      await this.#startOrchestratorParts(runId)
    } catch (error) {
      await this.#fail(runId, error instanceof ArtelError ? error : new ArtelError(`Could not start the parts: ${error.message}`, 500, 'artel/part-failed'))
      throw new ArtelError(`Could not start the parts: ${error.message}`, 500, 'artel/part-failed')
    }
    return this.#summary(this.#requireRun(runId))
  }

  /* ---------------------------------------------------------------- review */

  async changes(runId) {
    const run = this.#requireRun(runId)
    // A committed run has no copy: the commit owns the content and the stored
    // descriptors are the review (the trees themselves are read from git).
    if (typeof run.commit === 'string' && run.commit !== '') {
      return (run.files ?? []).map((file) => ({ ...file, hunks: [] }))
    }
    if (!run.copyPath) return []
    if (!(await pathExists(run.copyPath))) return []
    const changes = await collectChanges({
      copyRoot: run.copyPath,
      beforeRoot: this.#beforeRoot(run),
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
    // A committed run has no copy any more: read both sides from the repository.
    if (typeof run.commit === 'string' && run.commit !== '') {
      const git = await this.#gitFor(run.projectPath)
      if (git !== null) {
        const parent = typeof run.parentCommit === 'string' && run.parentCommit !== '' ? run.parentCommit : null
        const before = parent === null ? null : await git.show(parent, relPath)
        const after = await git.show(run.commit, relPath)
        if (before === null && after === null) return { path: relPath, before: '', after: '', binary: true, hunks: [] }
        const diff = diffFile({ path: relPath, before: before ?? '', after: after ?? '', context: this.#config.diffContext })
        return { ...diff, before: before ?? '', after: after ?? '' }
      }
    }
    const before = await fs.readFile(path.join(this.#beforeRoot(run), relPath), 'utf8').catch(() => null)
    const after = typeof run.copyPath === 'string' && run.copyPath !== ''
      ? await fs.readFile(path.join(run.copyPath, relPath), 'utf8').catch(() => null)
      : null
    return diffFile({ path: relPath, before, after, context: this.#config.diffContext })
  }

  async changeCount(runId) {
    const changes = await this.changes(runId)
    return changes.length
  }

  /**
   * Run one short-lived fixer session on a copy and return its report.
   *
   * The auto-queue uses it to resolve a conflicted cherry-pick: the agent edits
   * `copyPath` (a scratch worktree), never the user's project, and the caller
   * gets the report of its last turn. The session is created, prompted, awaited
   * and released here, so no caller can leak an agent on a timeout or an error.
   * @param {object} request - fixer request.
   * @param {string} request.projectPath - project the copy belongs to.
   * @param {string} request.copyPath - scratch copy the fixer may edit.
   * @param {string} request.prompt - instruction for the fixer.
   * @param {string} [request.title] - window title of the session.
   * @param {object | null} [request.model] - model route, deployment default when null.
   * @param {string | null} [request.sandboxMode] - sandbox of the session.
   * @param {number} [request.timeoutMs] - how long to wait for the turn.
   * @returns {Promise<{ message: string, agentId: string }>} the fixer's report.
   */
  async assist({ projectPath, copyPath, prompt, title = 'Artel fixer', model = null, sandboxMode = null, timeoutMs = 10 * 60 * 1000 } = {}) {
    if (this.#closed) throw new ArtelError('The engine is closed', 503, 'artel/closed')
    if (typeof projectPath !== 'string' || projectPath === '' || typeof copyPath !== 'string' || copyPath === '') {
      throw new ArtelError('An assist run needs a project and a copy', 400, 'artel/bad-request')
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new ArtelError('Write a prompt first', 400, 'artel/bad-request')
    const agentId = `assist-${randomUUID().slice(0, 8)}`
    const handle = await this.#driver.createAgent({
      name: 'Fixer',
      mode: 'solo',
      projectPath,
      copyPath,
      agentId,
      parentSessionId: null,
      title,
      model,
      sandboxMode: sandboxMode ?? undefined,
    })
    let text = ''
    let unsubscribe = null
    let timer = null
    try {
      // The turn is awaited through the event stream, like a run turn, but the
      // agent stays unregistered: it belongs to no run and no runtime cleanup.
      const turn = new Promise((resolve, reject) => {
        unsubscribe = this.#driver.subscribe(handle, (event) => {
          if (event?.kind === 'assistant' && typeof event.text === 'string') text += event.text
          if (event?.kind === 'turn-end') resolve()
        })
        timer = setTimeout(() => reject(new ArtelError('The fixer did not finish in time.', 504, 'artel/assist-timeout')), timeoutMs)
      })
      // A failing prompt must not leave the turn promise unhandled: wait for
      // whichever settles first, then for the turn itself.
      await Promise.race([this.#driver.prompt(handle, prompt), turn])
      await turn
    } finally {
      if (timer !== null) clearTimeout(timer)
      try {
        unsubscribe?.()
      } catch {}
      await Promise.resolve(this.#driver.interrupt?.(handle)).catch(() => {})
      await Promise.resolve(this.#driver.release?.(handle)).catch(() => {})
    }
    const message = text.trim()
    if (message === '') throw new ArtelError('The fixer finished without a report.', 500, 'artel/assist-empty')
    return { message, agentId }
  }

  /**
   * Send one fixer to an assembled Orchestrator copy and wait for its turn.
   *
   * The auto-queue calls it when the user's check fails: the fixer edits the
   * assembly the user is reviewing, then the run returns to `waiting` with a
   * fresh change count, ready for the next check or Apply. Only one fixer works
   * on a run at a time.
   * @param {string} runId - run id.
   * @param {{ prompt: string, purpose?: string }} request - fixer instruction.
   * @returns {Promise<{ agentId: string, changeCount: number }>} the fixer and the new count.
   */
  async repairArtifact(runId, { prompt, purpose = 'check' } = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new ArtelError('Write a prompt first', 400, 'artel/bad-request')
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (run.mode !== 'orchestrator') throw new ArtelError('Only an Orchestrator run has an assembled result to repair.', 409, 'artel/bad-mode')
    if (runtime?.orch?.fixing === true) throw new ArtelError('The fixer is already working on the assembled result.', 409, 'artel/fixer-busy')
    if (run.status !== 'waiting' || runtime?.orch?.stage !== 'assembled' || run.merge?.merged !== true) {
      throw new ArtelError('Only an assembled Orchestrator run can be repaired.', 409, 'artel/bad-stage')
    }
    runtime.orch.fixing = true
    try {
      const fixer = await this.#createOrchestratorAgent(runId, run, runtime, {
        role: 'fixer',
        copyPath: run.copyPath,
        sandboxMode: run.sandboxMode,
        title: purpose === 'check' ? 'Fix the failed check' : 'Fix the assembled result',
      })
      try {
        await this.#send(runId, fixer, prompt)
        await this.#waitForTurnEnd(fixer.handle)
      } catch (error) {
        this.#unsubscribe(fixer)
        await Promise.resolve(this.#driver.interrupt?.(fixer.handle)).catch(() => {})
        await Promise.resolve(this.#driver.release?.(fixer.handle)).catch(() => {})
        throw error
      }
      const changes = await this.changes(runId)
      await this.#store.patch(runId, { changeCount: changes.length })
      await this.#feed(runId, { kind: 'status', text: `The fixer updated ${changes.length} file(s).` })
      return { agentId: fixer.record.id, changeCount: changes.length }
    } finally {
      if (runtime.orch) runtime.orch.fixing = false
    }
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
    // A branch step is never applied on its own: the queue applies the branch
    // when the user asks for it, and a commit already owns the content.
    if (typeof run.commit === 'string' && run.commit !== '') throw new ArtelError('This run is a commit on an auto-queue branch: apply the branch from the queue.', 409, 'artel/branch-apply-required')
    if (run.isolated === true) throw new ArtelError('This run is isolated on an auto-queue branch: apply the branch from the queue.', 409, 'artel/branch-apply-required')
    if (!['waiting', 'finished', 'interrupted', 'failed'].includes(run.status)) {
      throw new ArtelError(`You cannot apply a ${run.status} run`, 409, 'artel/bad-status')
    }
    // The assembly may contain files several parts changed differently: until the
    // merger decided them, the copy is not one whole result and must not be
    // applied piecemeal. The list survives an interrupt on purpose.
    if (run.mode === 'orchestrator' && Array.isArray(run.merge?.unresolved) && run.merge.unresolved.length > 0) {
      throw new ArtelError('The merge is not finished, so nothing can be applied yet.', 409, 'artel/merge-incomplete')
    }
    const changes = await collectChanges({
      copyRoot: run.copyPath,
      beforeRoot: this.#beforeRoot(run),
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
    // Install needs are read from the project now that the files are really
    // there. It is a read, never an install: the changes card shows what was
    // found, and the user decides. A read failure must not turn a successful
    // apply into an error, and a project with nothing to install stores nothing.
    const install = await detectInstallNeeds(run.projectPath).catch((error) => {
      this.#log.warn?.(`artel: could not read install needs: ${error?.message ?? error}`)
      return null
    })
    if (installNeeded(install)) {
      await this.#store.patch(runId, { install })
      const line = installFeedLine(install)
      if (line !== null) await this.#feed(runId, { kind: 'status', text: line })
    }
    await this.#retire(runId)
    await removeCopy(this.#copyRoot, run.copyPath).catch(() => {})
    await this.#removePartCopies(run)
    return { applied: result.applied, skipped: result.skipped }
  }

  /**
   * Store that a run's copy became a commit on a queue branch.
   *
   * The commit owns the content now: the copy is deleted, the stored descriptors
   * answer `changes()` and the review reads the two trees from git.
   * @param {string} runId - run id.
   * @param {{ branchId: string, parentCommit: string, commit: string, files: Array<object | string>, changeCount: number }} input - commit facts.
   * @returns {Promise<object>} run summary.
   */
  async markCommitted(runId, { branchId, parentCommit, commit, files, changeCount }) {
    const run = this.#requireRun(runId)
    await this.#removePartCopies(run)
    if (typeof run.copyPath === 'string' && run.copyPath !== '') await removeCopy(this.#copyRoot, run.copyPath).catch(() => {})
    await this.#store.patch(runId, {
      copyPath: null,
      copyKind: null,
      branchId,
      parentCommit,
      commit,
      // The queue runner records the changed paths; a full descriptor is kept
      // when the caller has one, so a stored review is still readable.
      files: (files ?? []).map((file) => (typeof file === 'string'
        ? { path: file }
        : { path: file.path, status: file.status, added: file.added, removed: file.removed, binary: file.binary === true })),
      changeCount,
      status: 'waiting',
    })
    const rt = this.#runtime(runId)
    if (rt !== undefined) rt.record = this.#store.get(runId)
    await this.#feed(runId, { kind: 'status', text: `Commit ${String(commit).slice(0, 7)} is on the branch.`, commit })
    return this.#summary(this.#requireRun(runId))
  }

  /**
   * Mark a committed run as applied to the project by the branch action.
   * @param {string} runId - run id.
   * @param {{ commit?: string | null }} [input] - the commit that landed in the project.
   * @returns {Promise<object>} run summary.
   */
  async markApplied(runId, { commit = null } = {}) {
    const run = this.#requireRun(runId)
    if (typeof run.commit !== 'string' || run.commit === '') throw new ArtelError('The run has no branch commit to mark as applied.', 409, 'artel/not-committed')
    await this.#store.patch(runId, { status: 'applied', appliedAt: this.#now(), ...(commit === null ? {} : { appliedCommit: commit }) })
    await this.#retire(runId)
    await this.#feed(runId, { kind: 'status', text: 'The branch commit landed in your project.' })
    return this.#summary(this.#requireRun(runId))
  }

  /**
   * Read the install needs of a run's project again, after a branch landed.
   * @param {string} runId - run id.
   * @returns {Promise<object | null>} install needs discovered on the project.
   */
  async refreshInstall(runId) {
    const run = this.#requireRun(runId)
    const install = await detectInstallNeeds(run.projectPath).catch(() => null)
    if (install !== null && install !== undefined) await this.#store.patch(runId, { install })
    return install ?? null
  }

  /**
   * Everything an applied run still needs: the DSH bundle to install and the
   * project's own install steps.
   *
   * Detection already ran once, when the files were applied, and is stored on the
   * run, so a read is free. `refresh` re-reads the project after the user changed
   * it by hand, keeping the result of every step whose command did not change.
   * @param {string} runId - run id.
   * @param {{ refresh?: boolean }} [options] - re-detect instead of using the stored record.
   * @returns {Promise<object | null>} install record, or null when there is nothing to install.
   */
  async installPlan(runId, { refresh = false } = {}) {
    const run = this.#requireRun(runId)
    if (run.status !== 'applied') {
      throw new ArtelError('Install becomes available after the changes are applied', 409, 'artel/bad-status')
    }
    if (refresh !== true && run.install !== null && typeof run.install === 'object') return this.#installView(run)
    const fresh = await detectInstallNeeds(run.projectPath)
    const merged = mergeInstallRecord(run.install ?? null, fresh)
    await this.#store.patch(runId, { install: installNeeded(merged) ? merged : null })
    return this.#installView(this.#requireRun(runId))
  }

  /**
   * Install the applied project into the running DSH profile as a bundle.
   *
   * The project was written by Apply; this is the one action that also changes
   * the user's DSH profile, so it happens only when the user clicks the install
   * button in the changes card. The Host plugin manager reads the project's
   * `dsh.bundle.patch`, adds the project to the active profile and reports
   * whether a restart is needed for the bundle to become live.
   * @param {string} runId - run id.
   * @returns {Promise<object>} refreshed run summary.
   */
  async installBundle(runId) {
    const run = this.#requireRun(runId)
    if (run.status !== 'applied') {
      throw new ArtelError('Install becomes available after the changes are applied', 409, 'artel/bad-status')
    }
    const install = run.install
    if (install === null || typeof install !== 'object' || install.bundle === null || typeof install.bundle !== 'object') {
      throw new ArtelError('This run applied no DSH bundle', 409, 'artel/install-unavailable')
    }
    const bundle = install.bundle
    if (bundle.installable !== true) {
      throw new ArtelError(
        `This project declares a DSH bundle that cannot be installed: ${bundle.patch || 'its patch'} is missing, or package.json has no name.`,
        409,
        'artel/install-unavailable',
      )
    }
    if (typeof this.#driver.supportsBundleInstall === 'function' && this.#driver.supportsBundleInstall() !== true) {
      throw new ArtelError(
        'This DSH profile has no plugin manager, so the bundle has to be installed by hand (see the install steps).',
        501,
        'artel/install-unsupported',
      )
    }
    if (this.#installing.has(runId)) throw new ArtelError('Another install action is already running for this run', 409, 'artel/install-busy')
    this.#installing.add(runId)
    try {
      await this.#store.patch(runId, { install: { ...install, bundle: { ...bundle, status: 'installing', result: null } } })
      await this.#feed(runId, { kind: 'status', text: `Installing ${bundle.name} into DSH…` })
      let result
      try {
        result = normalizeBundleResult(await this.#driver.installBundle(run.projectPath))
      } catch (error) {
        result = normalizeBundleResult(null, error)
      }
      const current = this.#store.get(runId)
      const latest = current?.install !== null && typeof current?.install === 'object' ? current.install : install
      await this.#store.patch(runId, {
        install: { ...latest, bundle: { ...(latest.bundle ?? bundle), status: result.status, result } },
      })
      await this.#feed(runId, { kind: 'status', text: bundleResultLine(bundle.name, result) })
      return this.#summary(this.#requireRun(runId))
    } finally {
      this.#installing.delete(runId)
    }
  }

  /**
   * Run one install step of an applied run, in the project root.
   *
   * The step is one command the project declared (or one detected installer), and
   * it runs only after the user confirmed that exact command in the changes card.
   * Its output is kept on the run, bounded, so the card can show what happened.
   * @param {string} runId - run id.
   * @param {number} index - zero-based step position in the stored install record.
   * @returns {Promise<object>} refreshed run summary.
   */
  async runInstallStep(runId, index) {
    const run = this.#requireRun(runId)
    if (run.status !== 'applied') {
      throw new ArtelError('Install becomes available after the changes are applied', 409, 'artel/bad-status')
    }
    const install = run.install
    const steps = Array.isArray(install?.steps) ? install.steps : []
    const position = Number(index)
    if (!Number.isInteger(position) || position < 0 || position >= steps.length) {
      throw new ArtelError('Unknown install step', 404, 'artel/unknown-install-step')
    }
    if (this.#installing.has(runId)) throw new ArtelError('Another install action is already running for this run', 409, 'artel/install-busy')
    const step = steps[position]
    if (step.status === 'running') throw new ArtelError('This install step is already running', 409, 'artel/install-busy')
    this.#installing.add(runId)
    try {
      const startedAt = this.#now()
      const running = {
        ...step,
        status: 'running',
        output: null,
        outputTruncated: false,
        exitCode: null,
        timedOut: false,
        startedAt,
        finishedAt: null,
      }
      await this.#store.patch(runId, {
        install: { ...install, steps: steps.map((item, at) => (at === position ? running : item)) },
      })
      const outcome = await runInstallCommand({ command: step.command, cwd: run.projectPath })
      const status = outcome.exitCode === 0 && outcome.timedOut !== true ? 'done' : 'failed'
      const finished = {
        ...running,
        status,
        output: outcome.output === '' ? null : outcome.output,
        outputTruncated: outcome.outputTruncated === true,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut === true,
        finishedAt: this.#now(),
      }
      const current = this.#store.get(runId)
      const latest = current?.install !== null && typeof current?.install === 'object' ? current.install : install
      const latestSteps = Array.isArray(latest.steps) ? latest.steps : steps
      await this.#store.patch(runId, {
        install: { ...latest, steps: latestSteps.map((item, at) => (at === position ? finished : item)) },
      })
      const text = status === 'done'
        ? `Install step “${step.title}” finished.`
        : outcome.timedOut === true
          ? `Install step “${step.title}” timed out and was stopped.`
          : `Install step “${step.title}” failed${typeof outcome.exitCode === 'number' ? ` (exit code ${outcome.exitCode})` : ''}.`
      await this.#feed(runId, { kind: 'status', text })
      return this.#summary(this.#requireRun(runId))
    } finally {
      this.#installing.delete(runId)
    }
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
    // The commit is the run's content now: discarding the run would forget a
    // branch step that was never applied. The branch owns that decision.
    if (typeof run.commit === 'string' && run.commit !== '') throw new ArtelError('This run is a branch commit: delete the branch instead of discarding the run.', 409, 'artel/commit-owned')
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
    await this.#removePartCopies(run)
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
    // Unattended runs repeat the night rules on every turn: a task that runs
    // while the user is away must never ask, publish or deploy, and the model
    // reads the rule block next to the instruction it is acting on.
    const run = this.#store.get(runId)
    const payload = run?.autoqueue === true ? `${text}\n\n${nightShiftRules()}` : text
    await this.#driver.prompt(rt.handle, payload)
  }

  /**
   * Wait for one agent turn to end, or fail when it never does.
   *
   * Repair turns are driven by the engine, not by the run's stage machine: the
   * turn-end event is the only signal that the fixer is done, so it is awaited
   * directly. The timer keeps a silent agent from blocking the caller for ever.
   * @param {object} handle - driver handle of the agent.
   * @param {number} [timeoutMs] - how long to wait for the turn end.
   * @returns {Promise<void>} resolves on the turn-end event.
   */
  #waitForTurnEnd(handle, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      let timer = null
      let unsubscribe = null
      let settled = false
      const finish = (settle, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        try {
          unsubscribe?.()
        } catch {}
        settle(value)
      }
      timer = setTimeout(() => {
        finish(reject, new ArtelError('The agent did not finish in time.', 504, 'artel/assist-timeout'))
      }, timeoutMs)
      unsubscribe = this.#driver.subscribe(handle, (event) => {
        if (event?.kind === 'turn-end') finish(resolve)
      })
    })
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
    // The call id and the full arguments let the run page expand one call into
    // what the agent asked for and what came back; the preview above stays the
    // one-line form the feed shows when collapsed.
    if (event.callId !== undefined) feedEvent.callId = String(event.callId)
    if (event.args !== undefined) feedEvent.args = String(event.args)
    if (event.ok !== undefined) feedEvent.ok = event.ok === true
    this.#noteActivity(rt, event)
    if (event.kind === 'assistant' && typeof event.text === 'string') {
      rt.lastText = event.text
      rt.turnText += `${event.text}\n`
      // Fusion waits for every agent to be idle before the stage settle reads the
      // answers, and a user message can start a new turn in the meantime. Keep
      // the whole deliberation per agent so a late turn cannot erase an answer.
      if (run.mode === 'fusion') rt.fusionText = `${rt.fusionText ?? ''}${event.text}\n`
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
    // The live row counts turns and how long the current one has been going; a
    // turn start also ends any wait the page was showing.
    rt.turnStartedAt = this.#now()
    rt.turns = (rt.turns ?? 0) + 1
    rt.activity = null
    runtime.waitSince = undefined
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
    // Every Orchestrator agent writes in its own copy, so two agents editing the
    // same path is not a collision: the merger decides the overlapping files.
    if (run.mode === 'orchestrator') return
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
    // The agent is no longer doing anything: the row falls back to its status.
    rt.turnStartedAt = null
    rt.activity = null

    const kind = ['conductor', 'fusion', 'orchestrator'].includes(run.mode) ? failureKindOf(event?.reason) : null
    if (kind !== null && run.mode === 'conductor') {
      const outcome = await this.#handleAgentFailure(runId, run, runtime, rt, kind)
      if (outcome === 'fatal') return
    }
    if (kind !== null && run.mode === 'orchestrator') {
      const outcome = await this.#handleOrchestratorFailure(runId, run, runtime, rt, kind)
      if (outcome === 'fatal') return
    }

    rt.record = { ...rt.record, status: kind === null ? 'idle' : 'failed' }
    await this.#patchAgent(runId, rt.record)

    // A stopped Fusion agent is not fatal on its own: the panel continues with
    // the answers that are in, the judge gets one retry, and a stopped
    // implementer leaves the copy reviewable. The stage settle decides.
    if (kind !== null && run.mode === 'fusion') {
      await this.#feed(runId, {
        kind: 'error',
        agent: rt.record.name,
        text: fusionFailureNotice(rt.record.role, rt.record.name, kind),
      })
    }

    const current = this.#store.get(runId)
    if (!current) return
    if (current.mode === 'conductor') {
      const handled = await this.#onConductorTurnEnd(runId, current, runtime, rt)
      if (handled === true) return
    }
    if (current.mode === 'orchestrator') {
      const handled = await this.#onOrchestratorTurnEnd(runId, current, runtime, rt)
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
      if (run.mode === 'fusion') {
        await this.#settleFusionPlanning(runId)
        return
      }
      if (run.mode === 'conductor') {
        if (runtime.stage === 'planning') await this.#settleConductorPlanning(runId)
        return
      }
      if (run.mode === 'orchestrator') {
        if (runtime.orch?.stage === 'planning') await this.#settleOrchestratorPlanning(runId)
        return
      }
      await this.#settlePlanning(runId)
      return
    }
    if (run.status !== 'running') return

    if (run.mode === 'orchestrator') {
      // The Orchestrator only publishes the diff after the assembly. While the
      // parts are still being reviewed or merged there is nothing to publish yet.
      const stage = runtime.orch?.stage
      if (stage === 'assembled') {
        // The team was woken after the assembly and is idle again: publish it once
        // more, so the user can still review the extra changes and apply them.
        const changes = await this.changes(runId).catch(() => [])
        const after = this.#store.get(runId)
        if (!after || after.status !== 'running') return
        await this.#store.patch(runId, { status: 'waiting', changeCount: changes.length })
        await this.#feed(runId, { kind: 'status', text: 'The parts are idle again. Review the diff and apply what you like.' })
        return
      }
      if (stage === 'working') {
        // Safety net for a lost turn end: while the whole team is idle, a part
        // marked as working has not been reviewed yet; a part marked as reviewing
        // has a reviewer whose answer has not been taken yet. Several parts can be
        // in either state at the same time, so the part records decide.
        const parts = run.plan?.parts ?? []
        const pending = parts.find((part) => part.status === 'working' || part.status === 'rework')
        if (pending) {
          await this.#startOrchestratorReview(runId, pending.id)
          return
        }
        const reviewing = parts.find((part) => part.status === 'reviewing'
          && (runtime.agents.get(part.reviewerId)?.done ?? true))
        if (reviewing) await this.#applyOrchestratorVerdict(runId, reviewing.id)
      }
      return
    }

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
    if (run.mode === 'fusion') {
      const summary = changes.length === 0
        ? 'The implementer is idle. There are no changes yet.'
        : `The implementer is idle. ${changes.length} file${changes.length === 1 ? '' : 's'} changed — review the diff and apply what you like.`
      await this.#feed(runId, { kind: 'status', text: summary })
      return
    }
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

  /**
   * Advance a Fusion run while its status is still `planning`.
   *
   * In the panel stage the independent answers are collected and handed to the
   * judge. In the judge stage the merged decision becomes a `plan` card and the
   * implementer's prompt, and the run moves to `running` because editing starts
   * there. A stopped panelist is skipped (the panel continues with the rest); a
   * stopped or empty judge is retried once, then the run fails.
   * @param {string} runId - run id.
   * @returns {Promise<void>} completes once the stage moved or the run failed.
   */
  async #settleFusionPlanning(runId) {
    const run = this.#requireRun(runId)
    const runtime = this.#runtime(runId)
    if (!runtime) return
    this.#cancelIdleCheck(runId)

    if (runtime.stage === 'panel') {
      const panelists = [...runtime.agents.values()].filter((rt) => rt.record.role === 'panelist')
      const answered = panelists.filter((rt) => rt.record.status !== 'failed' && (rt.fusionText ?? '').trim() !== '')
      if (answered.length === 0) {
        await this.#fail(runId, new ArtelError(
          'Every panel model stopped before answering. Nothing was edited.',
          500,
          'artel/fusion-panel-failed',
        ))
        return
      }
      runtime.panelAnswers = answered.map((rt) => ({
        name: rt.record.name,
        model: rt.record.model,
        text: (rt.fusionText ?? '').trim(),
      }))
      runtime.stage = 'judge'
      const count = answered.length
      const label = count === panelists.length
        ? count === PANEL_SIZE ? 'All three answers are in' : `All ${count} answers are in`
        : `${count} of ${panelists.length} answers ${count === 1 ? 'is' : 'are'} in (a panel model stopped)`
      await this.#feed(runId, { kind: 'status', text: `${label}. The judge is merging them into one decision.` })

      const catalog = await this.#catalog()
      const answers = runtime.panelAnswers.map((answer) => ({
        name: answer.name,
        model: answer.model ? describeSelection(catalog, answer.model) : '',
        text: answer.text,
      }))
      runtime.judgePrompt = fusionJudgePrompt({ task: run.task, answers, panelSize: PANEL_SIZE })
      const judgeRt = [...runtime.agents.values()].find((rt) => rt.record.role === 'judge')
      judgeRt.done = false
      await this.#send(runId, judgeRt, runtime.judgePrompt)
      return
    }

    if (runtime.stage !== 'judge') return
    const judgeRt = [...runtime.agents.values()].find((rt) => rt.record.role === 'judge')
    const decision = judgeDecision(judgeRt.fusionText ?? '')
    const judgeFailed = judgeRt.record.status === 'failed'
    if (judgeFailed || decision.text === '') {
      runtime.judgeRetries = (runtime.judgeRetries ?? 0) + 1
      if (runtime.judgeRetries <= 1) {
        await this.#feed(runId, { kind: 'status', text: 'The judge answered nothing. Asking it once more.' })
        judgeRt.done = false
        judgeRt.fusionText = ''
        if (judgeFailed) {
          judgeRt.record = { ...judgeRt.record, status: 'working' }
          await this.#patchAgent(runId, judgeRt.record)
        }
        const retry = runtime.judgePrompt === ''
          ? 'Your previous answer was empty. Merge the panel answers into one decision now.'
          : `Your previous answer was empty or cut off. Merge the same panel answers again, keep the required structure, and end with the DISPUTES: line.\n\n${runtime.judgePrompt}`
        await this.#send(runId, judgeRt, retry)
        return
      }
      await this.#fail(runId, new ArtelError(
        'The judge could not merge the panel answers. Nothing was edited.',
        500,
        'artel/fusion-judge-failed',
      ))
      return
    }

    runtime.stage = 'working'
    runtime.synthesis = decision.text
    runtime.disputes = decision.disputes
    const implementerRt = [...runtime.agents.values()].find((rt) => rt.record.role === 'implementer')
    await this.#store.patch(runId, { status: 'running' })
    await this.#feed(runId, { kind: 'plan', text: decision.text })
    const disputes = decision.disputes === null
      ? ''
      : decision.disputes === 0
        ? ' None of the answers disagree.'
        : ` ${decision.disputes} disputed ${decision.disputes === 1 ? 'place' : 'places'}.`
    await this.#feed(runId, {
      kind: 'status',
      text: `The judge merged ${runtime.panelAnswers.length} answer${runtime.panelAnswers.length === 1 ? '' : 's'} into one decision.${disputes} ${implementerRt.record.name} is implementing it.`,
    })
    implementerRt.done = false
    await this.#send(runId, implementerRt, fusionImplementPrompt({
      copyPath: run.copyPath,
      projectPath: run.projectPath,
      task: run.task,
      decision: decision.text,
    }))
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
    // An Orchestrator run keeps its assembly for the diff, but the per-part
    // copies are useless once the run is over.
    await this.#removePartCopies(run)
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
