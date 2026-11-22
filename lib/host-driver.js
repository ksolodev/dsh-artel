/**
 * Host driver for dsh-artel.
 *
 * The engine knows nothing about DeepSeek Harness. This module is the only
 * place that touches the harness: it creates the Sessions that run the agents
 * inside the run copy, delivers prompts, stops work on request, and turns
 * durable `session/event` records into the flat event stream the engine
 * consumes.
 *
 * Solo runs, the swarm lead and the conductor are ordinary Sessions created
 * through the official session controller. Swarm members and conductor workers
 * are continuable subagents of that lead Session, so the whole team lives in ONE
 * agent tree: the standard team tools (`send_message`, `list_agents`) reach every
 * member, and a message one agent writes shows up in the others' conversation —
 * and in the shared feed.
 * Turns for those children are delivered through the subagent runtime, because
 * the session controller keeps subagent-owned Sessions behind its routing fence.
 *
 * Every agent works with `cwd = <run copy path>`, so the shipped sandbox policy
 * makes the real project unreachable for the agent: the copy is the only
 * writable root.
 */

import { randomUUID } from 'node:crypto'

import { buildCatalog, normalizeSelection, sameSelection } from './models.js'
import {
  attachSessionToWorkspace,
  isSessionId,
  projectWorkspaceOf,
  restoreProjectChats,
  taskChatTitle,
  workspaceRegistryOf,
} from './project-chats.js'

/** Tool-name pattern that marks a tool call as a file edit. */
const EDIT_TOOL_PATTERN = /write|edit|patch|apply|create|replace/i

/** Argument keys that can carry the edited file path. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'target_file', 'file', 'notebook_path']

/** Longest tool argument preview kept in the feed. */
const ARGUMENT_PREVIEW = 160

/** Longest full tool-argument payload kept for the expanded feed row. */
const ARGUMENT_LIMIT = 4000

/** Longest tool output kept for the expanded feed row. */
const RESULT_LIMIT = 1200

/** Prefix the subagent runtime frames every peer message with. */
const PEER_PREFIX = /^Agent\s+.+?\s+sent a message:\s*/i

/** How many times a member prompt is retried while its activation closes. */
const DELIVERY_ATTEMPTS = 8

/** How often to look for a just-created child Session, and how long to wait. */
const SESSION_LOOKUP_ATTEMPTS = 4
const SESSION_LOOKUP_DELAY_MS = 25

/**
 * How long to wait for the live `Agent` of a freshly started subagent before
 * giving up on its model selection: the subagent runtime attaches the child
 * Agent a moment after `startActivation` resolves.
 */
const MODEL_LOOKUP_ATTEMPTS = 12
const MODEL_LOOKUP_DELAY_MS = 40

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read the edited path out of one tool-call argument payload.
 * @param {unknown} raw - raw JSON string, object, or nothing.
 * @returns {string | null} the path, or null when the payload carries none.
 */
export function toolPathOf(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      const match = /"(?:path|file_path|filePath|filename|target_file)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
      return match ? match[1].replace(/\\(.)/g, '$1') : null
    }
  }
  if (value === null || typeof value !== 'object') return null
  for (const key of PATH_KEYS) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

/**
 * Whether a tool call is a file edit, judged by its name.
 * @param {string} name - tool name.
 * @returns {boolean} true for edit-like tools.
 */
export function isEditTool(name) {
  return typeof name === 'string' && EDIT_TOOL_PATTERN.test(name)
}

/**
 * Join the text blocks of one message content array.
 * @param {unknown} content - a content block array.
 * @returns {string} trimmed text, empty when the content carries none.
 */
export function contentTextOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Join the text blocks of one assistant message.
 * @param {unknown} message - an assistant message value.
 * @returns {string} trimmed text, empty when the message carries none.
 */
export function assistantTextOf(message) {
  return contentTextOf(message?.content)
}

/**
 * Read a peer message out of a user message framed by the subagent runtime.
 * @param {unknown} content - the user message content blocks.
 * @returns {string} the text without the `Agent <name> sent a message:` prefix.
 */
export function peerTextOf(content) {
  return contentTextOf(content).replace(PEER_PREFIX, '').trim()
}

/**
 * Shorten a tool argument payload for one feed line.
 * @param {unknown} raw - raw tool arguments.
 * @returns {string} single-line preview.
 */
function previewOf(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ARGUMENT_PREVIEW ? `${flat.slice(0, ARGUMENT_PREVIEW - 1)}…` : flat
}

/**
 * Cut a string to `limit` characters, marking the cut.
 * @param {string} text - source text.
 * @param {number} limit - longest allowed length.
 * @returns {string} the text, with an ellipsis when it was cut.
 */
export function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Keep the full tool-argument payload so the expanded row can show what the
 * agent actually asked for. Objects are pretty-printed once, on the host.
 * @param {unknown} raw - raw tool arguments.
 * @returns {string | undefined} the payload, or undefined when there is none.
 */
export function toolArgsOf(raw) {
  if (raw === null || raw === undefined) return undefined
  let text
  if (typeof raw === 'string') {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      text = raw
    }
  } else {
    text = JSON.stringify(raw, null, 2)
  }
  const trimmed = String(text ?? '').trim()
  return trimmed === '' ? undefined : clip(trimmed, ARGUMENT_LIMIT)
}

/**
 * Read the provider-reported token usage of one assistant message.
 * @param {unknown} raw - `event.data.usage`.
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number } | null} usage counts, or null.
 */
export function usageOf(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const inputTokens = count(raw.inputTokens)
  const outputTokens = count(raw.outputTokens)
  const cacheReadTokens = count(raw.cacheReadTokens)
  const cacheWriteTokens = count(raw.cacheWriteTokens)
  const reported = count(raw.totalTokens)
  const totalTokens = reported > 0 ? reported : inputTokens + outputTokens
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) return null
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
}

/**
 * Add one request's usage to a running total.
 * @param {object | null | undefined} total - previous total.
 * @param {object} usage - usage of the new request.
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number, requests: number }} the new total.
 */
export function addUsage(total, usage) {
  const base = total ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, requests: 0 }
  return {
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cacheReadTokens: base.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + usage.cacheWriteTokens,
    totalTokens: base.totalTokens + usage.totalTokens,
    requests: (base.requests ?? 0) + 1,
  }
}

/**
 * Composition of one Session's prompt surface: the system prompts, the tool
 * schemas and the messages, as the token meter's `contextBreakdown` projection
 * prices them.
 *
 * The projection is client-visible, so it is read through the projection
 * registry rather than registered a second time: a duplicate registration of an
 * existing key is an error, and the heuristic composition is not ours to keep.
 * @param {unknown} projections - `ctx.sessionProjections` registry, if mounted.
 * @param {unknown} session - the Session to read.
 * @returns {{ system: number, tools: number, messages: number } | null} the composition, or null when unavailable.
 */
export function breakdownOf(projections, session) {
  if (typeof projections?.snapshot !== 'function') return null
  let view
  try {
    view = projections.snapshot(session, ['contextBreakdown'])?.values?.contextBreakdown
  } catch {
    // A Session with no sized request yet has no breakdown; that is not a failure.
    return null
  }
  if (view === null || typeof view !== 'object') return null
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  return { system: count(view.systemTokens), tools: count(view.toolsTokens), messages: count(view.messageTokens) }
}

/**
 * Whether a failed member delivery is worth retrying.
 *
 * A local child settles and disposes its activation right after each turn, so a
 * prompt that lands inside that closing window is refused with
 * `subagent/delivery-unavailable`. The child is cold-resumable a moment later,
 * so the same prompt can be delivered again.
 * @param {unknown} error - the refusal.
 * @returns {boolean} true when the message can be retried.
 */
export function isTransientDelivery(error) {
  const code = error?.code
  if (code === 'subagent/delivery-unavailable') return true
  const cause = error?.cause
  const causeCode = cause?.code
  if (causeCode === 'ACTIVATION_CLOSING' || causeCode === 'DRAINING' || causeCode === 'CONTINUATION_UNAVAILABLE') return true
  return /temporarily unavailable|closing|draining|not live|tree root/i.test(String(error?.message ?? ''))
}

/**
 * One agent attached to this driver.
 * @typedef {object} DriverHandle
 * @property {'session' | 'member'} kind - ordinary Session or subagent member.
 * @property {string} sessionId - Session that runs the agent.
 * @property {string} name - display name chosen by the engine.
 * @property {string} agentId - engine-side agent id.
 * @property {string} mode - solo, swarm, conductor or fusion.
 * @property {string} copyPath - isolated project copy the Session owns.
 * @property {{ provider: string, model: string, reasoningEffort?: string }} [model] - route applied to the agent, once selected.
 * @property {string} [modelError] - why the requested route could not be applied.
 */

/**
 * Harness adapter used by `ArtelEngine`.
 */
export class HostDriver {
  #ctx
  #log
  #controller = null
  #agents = null
  #subagents = null
  #meter = null
  #projections = null
  #peers = false
  #unlisten = null
  #entries = new Map()
  /** Per-session live numbers: prompt size against the context window, and token spend. */
  #stats = new Map()
  #workspaces = null
  #closed = false

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {{ log?: Pick<Console, 'warn' | 'error' | 'info'> }} [options]
   */
  constructor(ctx, options = {}) {
    this.#ctx = ctx
    this.#log = options.log ?? console
  }

  /**
   * Resolve the host services this driver needs.
   * @returns {Promise<void>} completes once events are observed.
   */
  async init() {
    const controller = this.#ctx.get?.('sessionController')
    if (controller === null || controller === undefined) {
      throw new Error('dsh-artel needs the Host session controller, which this profile does not provide')
    }
    this.#controller = controller
    // The peer stack is part of every base profile; resolve it best-effort so a
    // stripped deployment can still run Solo and the legacy independent swarm.
    this.#agents = this.#ctx.get?.('agents') ?? null
    const subagents = this.#ctx.get?.('subagents') ?? null
    this.#subagents = subagents
    // Context occupancy is the same official projection the chat composer ring
    // reads; it is optional so a stripped profile still runs the plugin.
    this.#meter = this.#ctx.get?.('tokenMeter') ?? null
    // Composition (system prompt, tool schemas, messages) is a separate
    // projection the token meter registers; read it through the registry.
    this.#projections = this.#ctx.get?.('sessionProjections') ?? null
    // The Workspace registry is what the sidebar groups by. It is optional: a
    // stripped profile still runs Artel, the chats just stay in the old place.
    this.#workspaces = workspaceRegistryOf(this.#ctx)
    this.#peers = Boolean(this.#agents && subagents && typeof subagents.getProvider === 'function' && subagents.getProvider('spawn'))
    this.#unlisten = this.#ctx.on('session/event', (session, event) => {
      this.#observe(session, event)
    })
  }

  /**
   * Whether this profile can host the shared-conversation swarm: one lead
   * Session plus continuable subagent children that can message each other.
   * @returns {boolean} true when the subagent stack is mounted.
   */
  supportsPeers() {
    return this.#peers
  }

  /**
   * Whether this profile can file Artel chats under their project.
   *
   * A profile without the Workspace registry keeps the previous behaviour: the
   * run stays in whatever chat started it and the agent Sessions show up where
   * their copy directory is.
   * @returns {boolean} true when the sidebar bridge is available.
   */
  supportsProjectChats() {
    return this.#registry() !== null
  }

  /**
   * Resolve the Workspace registry on demand.
   *
   * The registry is a sibling service, not a dependency of the session
   * controller, so it may mount after this driver was initialized. Looking it up
   * again until it appears keeps the bridge working regardless of boot order,
   * and costs one property read once it is there.
   * @returns {object | null} the registry, or null when this profile has none.
   */
  #registry() {
    if (this.#workspaces === null) this.#workspaces = workspaceRegistryOf(this.#ctx)
    return this.#workspaces
  }

  /**
   * Create the separate chat that hosts one task.
   *
   * The issue is explicit about the shape: a run started from any chat (even an
   * unrelated one) gets its own conversation inside the project group, titled
   * after the task, and the source chat gets neither the run nor the panel. The
   * controller creates such a chat when it is given a `workspaceId` — the header
   * cwd then IS the Workspace path, so membership is legitimate and survives
   * restarts without help. The chat is made read-only: it is the control room for
   * the run, the agents do the writing in their own copy.
   * @param {{ projectPath: string, task: string, sandboxMode?: string }} request - task.
   * @returns {Promise<{ sessionId: string, workspaceId: string, title: string } | null>}
   *   the new chat, or null when the project is not an open Workspace.
   */
  async createTaskChat({ projectPath, task, sandboxMode = 'read-only' }) {
    if (this.#closed) throw new Error('artel driver is closed')
    if (!this.supportsProjectChats()) return null
    const workspace = await projectWorkspaceOf(this.#registry(), projectPath)
    if (workspace === null) return null
    // An explicit identity keeps the controller from reusing another chat and
    // lets the run learn its id even when the Workspace attach fails.
    const requestedId = `session-${randomUUID()}`
    let sessionId = requestedId
    try {
      const created = await this.#controller.create({ sessionId: requestedId, workspaceId: workspace.id })
      sessionId = created?.sessionId ?? requestedId
    } catch (error) {
      // The controller creates the Session first and reports a failed Workspace
      // attach as an error carrying the id; that chat is still usable, so the run
      // must not be lost because the sidebar refused it.
      const created = error?.details?.sessionId
      if (typeof created !== 'string' || created === '') throw error
      sessionId = created
      this.#log?.warn?.(`dsh-artel: the task chat exists but is not in its project yet: ${error?.message ?? error}`)
    }
    const title = taskChatTitle(task)
    if (typeof this.#controller.rename === 'function') {
      try {
        await this.#controller.rename({ sessionId, title })
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not title the task chat: ${error?.message ?? error}`)
      }
    }
    await this.#adoptTaskChat(sessionId, sandboxMode)
    // Idempotent repair of the membership: cheap when the attach worked, and the
    // only chance for the failure path above.
    attachSessionToWorkspace(workspace, sessionId, this.#log)
    return { sessionId, workspaceId: workspace.id, title }
  }

  /**
   * Put one Artel chat into the project group of its run.
   *
   * Agent Sessions keep `cwd = <run copy>`: the sandbox boundary must stay the
   * copy, so membership is injected into the Workspace instead of changing the
   * Session (see `lib/project-chats.js`). Best-effort by design.
   * @param {{ sessionId: string, projectPath: string }} request - chat and project.
   * @returns {Promise<string | null>} Workspace id, or null when nothing was done.
   */
  async attachProjectChat({ sessionId, projectPath }) {
    if (!this.supportsProjectChats()) return null
    if (!isSessionId(sessionId)) return null
    const workspace = await projectWorkspaceOf(this.#registry(), projectPath)
    if (workspace === null) return null
    return attachSessionToWorkspace(workspace, sessionId, this.#log) ? workspace.id : null
  }

  /**
   * Re-prime the project membership of the chats of stored runs.
   *
   * The Workspace record is durable, but the sidebar filter is derived from the
   * stored Session headers at host start, so every agent chat (header cwd = run
   * copy) drops out of the project group after a restart until it is indexed
   * again.
   * @param {Array<object>} runs - stored run records.
   * @returns {Promise<{ attached: number, skipped: number, failed: number }>} counts.
   */
  async restoreProjectChats(runs) {
    if (!this.supportsProjectChats()) return { attached: 0, skipped: 0, failed: 0 }
    return restoreProjectChats({ registry: this.#registry(), runs, log: this.#log })
  }

  /**
   * Make a task chat read-only and past the blank-chat gate.
   *
   * The task chat is an ordinary chat the user may also talk in, so unlike an
   * agent Session it keeps the profile approval policy; only the sandbox is
   * pinned, because a run must never write into the real project from that chat.
   * @param {string} sessionId - task chat.
   * @param {string} mode - sandbox mode to pin.
   * @returns {Promise<void>} completes once the attempt was made.
   */
  async #adoptTaskChat(sessionId, mode) {
    let session
    for (let attempt = 0; attempt < SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
      session = this.#sessionOf(sessionId)
      if (session !== undefined) break
      if (attempt < SESSION_LOOKUP_ATTEMPTS - 1) await delay(SESSION_LOOKUP_DELAY_MS)
    }
    if (session === undefined) return
    if (typeof mode === 'string' && mode !== '') {
      try {
        if (typeof session.append === 'function') session.append('sandbox/mode', { mode })
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not make the task chat read-only: ${error?.message ?? error}`)
      }
    }
    this.#markTaskChatUsed(session, sessionId)
  }

  /**
   * Mark a fresh task chat as started so the sidebar stops treating it as a draft.
   *
   * A Chat is "blank" until a `turn/start` reaches its log, and a blank Session is
   * not a neutral state in the harness: it hides its title behind the localized
   * "New Session" label and can be reused as the next draft of the project, which
   * would silently turn the run's control room into a user chat. The run itself
   * lives outside the conversation log, so the task chat starts with one empty,
   * already-finished turn — the same log shape the harness writes when it closes
   * an interrupted turn (see `dsh-session/src/repair.ts`). Nothing is sent to a
   * model and no message reaches the context.
   * @param {object} session - live Session of the task chat.
   * @param {string} sessionId - task chat id, for the warning.
   * @returns {void}
   */
  #markTaskChatUsed(session, sessionId) {
    if (typeof session.append !== 'function') return
    try {
      const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
      if (Array.isArray(events) && events.some((event) => event?.type === 'turn/start')) return
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    } catch (error) {
      this.#log?.warn?.(`dsh-artel: could not mark the task chat ${sessionId} as started: ${error?.message ?? error}`)
    }
  }

  /**
   * Read the model catalog the running profile advertises.
   *
   * Providers, models and reasoning efforts come from `ctx.llm`, so the Artel
   * picker offers exactly the routes this Host can call. The deployment default
   * from `ctx.agentDefaultModel` seeds the initial choice.
   * @returns {Promise<{ providers: Array<object>, default: object | null }>} catalog.
   */
  async listModels() {
    const llm = this.#ctx.get?.('llm')
    const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
    const modelsByProvider = new Map()
    const infoByProvider = new Map()
    for (const provider of Array.isArray(providers) ? providers : []) {
      if (typeof provider?.id !== 'string' || provider.id === '') continue
      try {
        const listed = await llm.listModels(provider.id)
        const models = Array.isArray(listed) ? listed : []
        modelsByProvider.set(provider.id, models)
        const infos = new Map()
        for (const model of models) {
          if (typeof model?.id !== 'string' || model.id === '') continue
          try {
            infos.set(model.id, await llm.resolveModelInfo(provider.id, model.id))
          } catch (error) {
            // A model without resolvable metadata still lists; it just has no
            // effort row, which is exactly what an adapter without reasoning
            // metadata looks like.
            this.#log?.warn?.(`dsh-artel: could not describe ${provider.id}/${model.id}: ${error?.message ?? error}`)
          }
        }
        infoByProvider.set(provider.id, infos)
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not list the models of ${provider.id}: ${error?.message ?? error}`)
        modelsByProvider.set(provider.id, [])
      }
    }
    let defaultSelection
    try {
      defaultSelection = this.#ctx.get?.('agentDefaultModel')?.currentSelection?.()
    } catch {
      defaultSelection = undefined
    }
    return buildCatalog({
      providers,
      modelsOf: (provider) => modelsByProvider.get(provider) ?? [],
      infoOf: (provider, model) => infoByProvider.get(provider)?.get(model),
      defaultSelection,
    })
  }

  /**
   * Route one running agent to a provider/model/reasoning effort.
   *
   * Writes through `agent.model.select()`, the per-session selection the agent
   * loop snapshots at the next step boundary: a running step keeps the route it
   * started with, and the change applies from the following step.
   * @param {DriverHandle} handle - agent to change.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection - requested route.
   * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string }>} the applied selection.
   */
  async selectModel(handle, selection) {
    const normalized = normalizeSelection(selection)
    if (normalized === null) throw new Error('A provider and a model are required')
    const agent = await this.#agentOf(handle.sessionId)
    if (agent === undefined || typeof agent.model?.select !== 'function') {
      throw new Error(`Artel cannot reach the live Agent of "${handle.name}", so its model was not changed`)
    }
    const current = typeof agent.model.current === 'function' ? agent.model.current() : undefined
    if (!sameSelection(current, normalized)) agent.model.select(normalized)
    handle.model = normalized
    return normalized
  }

  /**
   * Wait for the live Agent behind a Session id.
   * @param {string} sessionId - Session whose Agent is wanted.
   * @returns {Promise<object | undefined>} live Agent, or undefined when it never attached.
   */
  async #agentOf(sessionId) {
    for (let attempt = 0; attempt < MODEL_LOOKUP_ATTEMPTS; attempt += 1) {
      const agent = this.#ctx.get?.('agents')?.get?.(sessionId)
      if (agent !== null && agent !== undefined) return agent
      if (attempt < MODEL_LOOKUP_ATTEMPTS - 1) await delay(MODEL_LOOKUP_DELAY_MS)
    }
    return undefined
  }

  /**
   * Resolve one chat Session from the live store or the durable session index.
   *
   * The live `sessions` service only knows Sessions that are currently mounted.
   * A chat opened after a Host restart is still a valid chat, but its Session is
   * prepared from persistence only when somebody asks for it; `sessionQuery`
   * performs that read without publishing the Session into the live store.
   * @param {string} sessionId - chat Session id.
   * @returns {Promise<{ live: boolean, cwd?: string } | undefined>} record, or undefined for an unknown id.
   */
  async #sessionRecord(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const session = this.#ctx.get?.('sessions')?.get?.(sessionId)
      if (session !== null && session !== undefined) return { live: true, cwd: session.header?.cwd }
    } catch {}
    const query = this.#ctx.get?.('sessionQuery')
    if (query === null || query === undefined || typeof query.observeSession !== 'function') return undefined
    let observation
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'none' })
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
    try {
      return { live: false, cwd: observation.header?.cwd }
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  /**
   * Whether a chat Session exists in this Host profile.
   * @param {string} sessionId - chat Session id.
   * @returns {Promise<boolean>} true when the Host can resolve that Session.
   */
  async hasSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const query = this.#ctx.get?.('sessionQuery')
    try {
      if (await this.#sessionRecord(sessionId) !== undefined) return true
      // A Host without the durable index cannot prove an id is stale. Keep the
      // old permissive behaviour there instead of blocking every cold chat.
      return query === null || query === undefined || typeof query.observeSession !== 'function'
    } catch {
      return false
    }
  }

  /**
   * Find the project directory of a chat Session: the copy is made from it and
   * the user's own project is never touched by an agent.
   * @param {string} sessionId - chat Session whose project Artel should copy.
   * @returns {Promise<string>} absolute project directory.
   */
  async projectPathOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('Artel needs the chat session that owns the project')
    }
    const record = await this.#sessionRecord(sessionId)
    if (record === undefined) {
      const error = new Error('Unknown chat session')
      error.status = 404
      error.code = 'artel/unknown-session'
      throw error
    }
    if (typeof record.cwd === 'string' && record.cwd !== '') return record.cwd
    const fallback = this.#ctx.get?.('workingDirectory')?.defaultDirectory
    if (typeof fallback === 'string' && fallback !== '') return fallback
    throw new Error('This chat session has no project directory yet, so there is nothing to copy')
  }

  /**
   * Whether this profile can install an applied project into itself.
   *
   * The plugin manager is a core DSH service, but Artel may run in a deployment
   * that mounts the web server without it. The changes card then has to offer
   * manual steps instead of a button that cannot work.
   * @returns {boolean} true when the running profile exposes the plugin manager.
   */
  supportsBundleInstall() {
    const manager = this.#ctx.get?.('pluginManager')
    return manager !== null && manager !== undefined && typeof manager.installBundle === 'function'
  }

  /**
   * Install one applied project into the running DSH profile as a bundle.
   *
   * This is the one Host action in Artel that changes something outside the
   * user's project, so the engine calls it only after the user clicked the
   * install button on the changes card. The Host plugin manager resolves the
   * absolute project path as a local `link:` dependency and reports whether the
   * profile must restart before the bundle is live.
   * @param {string} projectPath - absolute project directory that declares a DSH bundle.
   * @returns {Promise<object>} the plugin manager's ChangeResult.
   */
  async installBundle(projectPath) {
    const manager = this.#ctx.get?.('pluginManager')
    if (manager === null || manager === undefined || typeof manager.installBundle !== 'function') {
      throw new Error('this DSH profile has no plugin manager, so the bundle cannot be installed from Artel')
    }
    if (typeof projectPath !== 'string' || projectPath.trim() === '') {
      throw new Error('the project path is required to install the bundle')
    }
    return manager.installBundle(projectPath, {})
  }

  /**
   * Find the live Session behind a Session id, whichever host service exposes it.
   * @param {string} sessionId - Session id.
   * @returns {object | undefined} live Session, or undefined when it is not mounted.
   */
  #sessionOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const agent = this.#ctx.get?.('agents')?.get?.(sessionId)
    if (agent !== null && agent !== undefined && agent.session !== undefined) return agent.session
    return this.#ctx.get?.('sessions')?.get?.(sessionId)
  }

  /**
   * Make a freshly created child Session unattended.
   *
   * An Artel run has no human watching its own agents: a child that inherits the
   * profile's `ask` approval policy would block forever on the first escalation
   * (`sandbox_permissions` or an apply decision) and the whole run would hang.
   * The child therefore gets approval policy `never` — the tool call is refused
   * at once and the agent keeps going — and a sandbox mode: an explicit one for
   * modes that must not write (the Fusion panel and judge work read-only), else
   * the sandbox mode the user runs the chat Session under.
   *
   * Both writes are the durable events the host services use themselves:
   * `ApprovalService.setPolicy(agent, 'never')` appends `approval/policy` (and
   * tells the agent about it), `setSandboxMode` appends `sandbox/mode`. Artel
   * appends them directly so the driver imports no package that only exists
   * inside the running profile. Every step is best-effort: a stripped profile or
   * a Session that is already gone must never break agent creation.
   * @param {{ sessionId: string, parentSessionId?: string, name: string, sandboxMode?: string }} request
   * @returns {Promise<void>} completes once both policies were attempted.
   */
  async #adoptChildSession({ sessionId, parentSessionId, name, sandboxMode }) {
    // The subagent runtime may attach a just-spawned child a moment after
    // `startActivation` resolves, so a new child is looked up a few times.
    let session
    for (let attempt = 0; attempt < SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
      session = this.#sessionOf(sessionId)
      if (session !== undefined) break
      if (attempt < SESSION_LOOKUP_ATTEMPTS - 1) await delay(SESSION_LOOKUP_DELAY_MS)
    }
    if (session === undefined) {
      this.#log?.warn?.(`dsh-artel: could not reach Session "${sessionId}" of ${name} to make it unattended`)
      return
    }

    try {
      const agent = this.#ctx.get?.('agents')?.get?.(sessionId)
      const approval = this.#ctx.get?.('approval')
      if (agent !== null && agent !== undefined && typeof approval?.setPolicy === 'function') {
        approval.setPolicy(agent, 'never')
      } else if (typeof session.append === 'function') {
        // The durable form of the same policy write, for profiles where the
        // approval service is not the one holding this agent.
        session.append('approval/policy', { policy: 'never' })
      }
    } catch (error) {
      this.#log?.warn?.(`dsh-artel: could not set the approval policy of ${name}: ${error?.message ?? error}`)
    }

    // An explicit mode (the Fusion panel and judge are read-only) wins over the
    // inherited one: those agents must not be able to touch the copy at all.
    let mode = typeof sandboxMode === 'string' && sandboxMode !== '' ? sandboxMode : null
    if (mode === null) {
      if (typeof parentSessionId !== 'string' || parentSessionId === '') return
      try {
        const parent = this.#sessionOf(parentSessionId)
        const sandboxPolicy = this.#ctx.get?.('sandboxPolicy')
        if (parent === undefined || typeof sandboxPolicy?.resolve !== 'function') return
        const inherited = sandboxPolicy.resolve({ session: parent })?.mode
        if (typeof inherited !== 'string' || inherited === '') return
        mode = inherited
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not copy the sandbox mode to ${name}: ${error?.message ?? error}`)
        return
      }
    }
    try {
      if (typeof session.append === 'function') session.append('sandbox/mode', { mode })
    } catch (error) {
      this.#log?.warn?.(`dsh-artel: could not set the sandbox mode of ${name}: ${error?.message ?? error}`)
    }
  }

  /**
   * Create one ordinary Session whose working directory is the run copy.
   * @param {{ name: string, mode: string, projectPath: string, copyPath: string, agentId: string, title?: string, parentSessionId?: string, model?: object, sandboxMode?: string }} request
   * @returns {Promise<DriverHandle>} handle used for later prompts.
   */
  async createAgent({ name, mode, projectPath, copyPath, agentId, title, parentSessionId, model, sandboxMode }) {
    if (this.#closed) throw new Error('artel driver is closed')
    // An explicit identity keeps the controller from reusing a blank Session,
    // so every agent really gets its own conversation.
    const requestedId = `session-${randomUUID()}`
    const created = await this.#controller.create({ sessionId: requestedId, cwd: copyPath })
    const sessionId = created?.sessionId ?? requestedId
    if (typeof title === 'string' && title !== '' && typeof this.#controller.rename === 'function') {
      // A readable title is how the user tells Artel conversations apart in the
      // sidebar; a failed rename must never break the run.
      try {
        await this.#controller.rename({ sessionId, title })
      } catch (error) {
        this.#log?.warn?.(`dsh-artel: could not title agent session: ${error?.message ?? error}`)
      }
    }
    /** @type {DriverHandle} */
    const handle = {
      kind: 'session',
      sessionId,
      name,
      agentId,
      mode,
      projectPath,
      copyPath,
    }
    this.#entries.set(handle.sessionId, { handle, listener: null, chain: Promise.resolve() })
    await this.#adoptChildSession({ sessionId, parentSessionId, name, sandboxMode })
    if (model !== undefined && model !== null) await this.#applyModel(handle, model)
    // The conversation belongs to the project in the sidebar, while its sandbox
    // and file tools stay pointed at the copy.
    await this.attachProjectChat({ sessionId: handle.sessionId, projectPath })
    return handle
  }

  /**
   * Start one continuable subagent of `parent` inside the run copy. The child
   * receives `promptText` as its first turn and joins the same agent tree, so
   * every member can reach every other member with the standard team tools.
   * @param {{ parent: DriverHandle, name: string, displayName: string, label?: string, promptText: string, copyPath: string, projectPath: string, agentId: string, mode: string, model?: object }} request
   * @returns {Promise<DriverHandle>} member handle.
   */
  async spawnMember({ parent, name, displayName, label, promptText, copyPath, projectPath, agentId, mode, model }) {
    if (this.#closed) throw new Error('artel driver is closed')
    if (!this.#peers) {
      throw new Error('this DSH profile does not provide the subagent stack, so swarm agents cannot share one conversation')
    }
    const parentAgent = this.#agents.get?.(parent.sessionId)
    if (parentAgent === null || parentAgent === undefined) {
      throw new Error(`artel cannot reach the live Session "${parent.sessionId}" that hosts the swarm team`)
    }
    const activation = await this.#subagents.startActivation({
      provider: 'spawn',
      label: typeof label === 'string' && label !== '' ? label : 'Artel swarm member',
      name,
      prompt: [{ type: 'text', text: promptText }],
      parent: parentAgent,
      signal: new AbortController().signal,
      delivery: 'caller',
      cwd: copyPath,
    })
    // The activation result only reports how the first turn ended; the engine
    // learns everything it needs from Session events, so a failure must never
    // surface as an unhandled rejection.
    Promise.resolve(activation.result).then(
      () => {},
      (error) => this.#log?.warn?.(`dsh-artel: member ${displayName} activation ended: ${error?.message ?? error}`),
    )
    /** @type {DriverHandle} */
    const handle = {
      kind: 'member',
      sessionId: activation.childId,
      name: displayName,
      subagentName: typeof name === 'string' && name !== '' ? name : (activation.name ?? displayName),
      agentId,
      mode,
      projectPath,
      copyPath,
      activation,
    }
    this.#entries.set(handle.sessionId, { handle, listener: null, chain: Promise.resolve() })
    await this.#adoptChildSession({
      sessionId: handle.sessionId,
      parentSessionId: parent.sessionId,
      name: displayName,
    })
    if (model !== undefined && model !== null) await this.#applyModel(handle, model)
    return handle
  }

  /**
   * Apply a requested route to one freshly created agent, never failing the run.
   *
   * The engine records the requested selection either way; a refusal is kept on
   * the handle so the run feed can say that the agent stayed on its default.
   * @param {DriverHandle} handle - agent to route.
   * @param {object} model - requested selection.
   * @returns {Promise<void>} always completes.
   */
  async #applyModel(handle, model) {
    try {
      await this.selectModel(handle, model)
    } catch (error) {
      handle.modelError = String(error?.message ?? error)
      this.#log?.warn?.(`dsh-artel: could not route ${handle.name}: ${handle.modelError}`)
    }
  }

  /**
   * Observe one agent. Events are delivered one at a time, in order.
   * @param {DriverHandle} handle - agent handle.
   * @param {(event: object) => unknown} listener - engine callback.
   * @returns {() => void} unsubscribe.
   */
  subscribe(handle, listener) {
    const entry = this.#entries.get(handle.sessionId)
    if (entry === undefined) throw new Error(`artel driver does not know session "${handle.sessionId}"`)
    entry.listener = listener
    return () => {
      if (entry.listener === listener) entry.listener = null
    }
  }

  /**
   * Deliver one prompt as a queued turn.
   *
   * Ordinary Sessions go through the session controller. Subagent members go
   * through the subagent runtime with user attribution, which is the only
   * accepted way to prompt a child Session and the path the Web UI itself uses.
   * @param {DriverHandle} handle - target agent.
   * @param {string} text - prompt text.
   * @returns {Promise<void>} completes once the target accepted the prompt.
   */
  async prompt(handle, text) {
    if (handle.kind === 'member') {
      await this.#promptMember(handle, text)
      return
    }
    await this.#controller.prompt({
      requestId: randomUUID(),
      sessionId: handle.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  /**
   * Deliver one user-attributed prompt to a subagent member, retrying while a
   * just-settled activation finishes closing.
   * @param {DriverHandle} handle - member handle.
   * @param {string} text - prompt text.
   * @returns {Promise<void>} completes once a retry was accepted.
   */
  async #promptMember(handle, text) {
    const subagents = this.#subagents
    if (!subagents) throw new Error('dsh-artel: subagent transport is not available in this profile')
    const request = {
      requestId: randomUUID(),
      childSessionId: handle.sessionId,
      delivery: 'queue',
      content: [{ type: 'text', text }],
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await subagents.prompt(request, new AbortController().signal)
        return
      } catch (error) {
        if (attempt >= DELIVERY_ATTEMPTS - 1 || !isTransientDelivery(error)) throw error
        await delay(Math.min(1200, 40 * 2 ** attempt))
      }
    }
  }

  /**
   * Stop the agent's active turn.
   * @param {DriverHandle} handle - target agent.
   * @returns {Promise<void>} completes once cancellation is admitted.
   */
  async interrupt(handle) {
    if (handle.kind === 'member') {
      this.#subagents?.interrupt?.(handle.sessionId, { kind: 'user' })
      return
    }
    const accepted = this.#controller.cancel({ sessionId: handle.sessionId })
    if (accepted !== undefined && accepted !== null) await Promise.resolve(accepted).catch(() => {})
  }

  /**
   * Keep the Sessions for history; nothing to release per run.
   * @returns {Promise<void>} always complete.
   */
  async release() {}

  /**
   * Stop observing and forget every agent.
   * @returns {Promise<void>} always complete.
   */
  async dispose() {
    this.#closed = true
    this.#unlisten?.()
    this.#unlisten = null
    for (const entry of this.#entries.values()) {
      entry.listener = null
      try {
        if (entry.handle.kind === 'member') this.#subagents?.interrupt?.(entry.handle.sessionId, { kind: 'user' })
        else this.#controller?.cancel({ sessionId: entry.handle.sessionId })
      } catch (error) {
        this.#log.warn?.(`dsh-artel: could not stop agent ${entry.handle.name}: ${String(error)}`)
      }
    }
    this.#entries.clear()
    this.#stats.clear()
  }

  /**
   * Map one durable Session event onto the engine's flat event vocabulary.
   * @param {unknown} session - Session that published the event.
   * @param {unknown} event - durable Session event.
   */
  #observe(session, event) {
    if (this.#closed) return
    const sessionId = session?.header?.id ?? session?.id
    if (typeof sessionId !== 'string') return
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return
    this.#trackStats(session, sessionId, event)
    const mapped = mapSessionEvent(event)
    if (mapped === null) return
    const listener = entry.listener
    if (listener === null) return
    // Session dispatch is synchronous and ignores promises; chain per agent so
    // the engine sees events in log order even though it awaits storage.
    entry.chain = entry.chain
      .then(() => (entry.listener === null ? undefined : listener(mapped)))
      .catch((error) => {
        this.#log.warn?.(`dsh-artel: agent ${entry.handle.name} event failed: ${String(error)}`)
      })
  }

  /**
   * Refresh the live numbers of one agent: how full its context is and how many
   * tokens it has spent so far.
   *
   * Both come from the Host, never from a guess: the prompt size is the last
   * sized request against the model's window (the same projection the chat
   * composer ring reads), and the spend is the sum of the provider-reported
   * usages. Every session event settles these, so the run page can show them on
   * a poll without asking the provider for anything.
   * @param {unknown} session - Session that published the event.
   * @param {string} sessionId - its id.
   * @param {unknown} event - durable Session event.
   */
  #trackStats(session, sessionId, event) {
    const previous = this.#stats.get(sessionId) ?? { context: null, usage: null }
    let next = previous
    if (event?.type === 'assistant/message') {
      const usage = usageOf(event.data?.usage)
      if (usage !== null) next = { ...next, usage: addUsage(previous.usage, usage) }
    }
    if (typeof this.#meter?.contextPressure === 'function') {
      try {
        const pressure = this.#meter.contextPressure(session)
        const tokens = typeof pressure?.pressureTokens === 'number' ? pressure.pressureTokens : null
        const window = typeof pressure?.contextWindow === 'number' ? pressure.contextWindow : null
        if (tokens !== null || window !== null) {
          next = { ...next, context: { tokens, window, breakdown: previous.context?.breakdown ?? null, at: Date.now() } }
        }
      } catch (error) {
        // A brand-new session has no sized request yet; that is not a failure.
        this.#log.warn?.(`dsh-artel: could not read the context pressure of ${sessionId}: ${String(error)}`)
      }
    }
    const breakdown = breakdownOf(this.#projections, session)
    if (breakdown !== null) {
      const before = next.context?.breakdown
      const same = before !== null && before !== undefined
        && before.system === breakdown.system
        && before.tools === breakdown.tools
        && before.messages === breakdown.messages
      if (!same) {
        next = {
          ...next,
          context: {
            tokens: next.context?.tokens ?? null,
            window: next.context?.window ?? null,
            at: Date.now(),
            breakdown,
          },
        }
      }
    }
    if (next !== previous) this.#stats.set(sessionId, next)
  }

  /**
   * Live numbers of one agent, as of its last session event.
   * @param {{ sessionId?: string } | null | undefined} handle - agent handle.
   * @returns {{ context: { tokens: number | null, window: number | null, breakdown: { system: number, tools: number, messages: number } | null, at: number } | null, usage: object | null }} context occupancy, composition and token spend.
   */
  statsOf(handle) {
    const sessionId = handle?.sessionId
    const entry = typeof sessionId === 'string' ? this.#stats.get(sessionId) : undefined
    return {
      context: entry?.context ?? null,
      usage: entry?.usage ?? null,
    }
  }
}

/**
 * Turn one durable Session event into a driver event, or null when the event
 * carries nothing the feed needs.
 * @param {unknown} event - durable Session event.
 * @returns {object | null} driver event.
 */
export function mapSessionEvent(event) {
  if (event === null || typeof event !== 'object') return null
  switch (event.type) {
    case 'assistant/message': {
      const text = assistantTextOf(event.data?.message)
      const usage = usageOf(event.data?.usage)
      // A message with no text still carries the request's token usage, which is
      // what the run page counts; only an empty message without usage is noise.
      if (text === '' && usage === null) return null
      return usage === null ? { kind: 'assistant', text } : { kind: 'assistant', text, usage }
    }
    case 'user/message': {
      // Only peer traffic is news: the prompts Artel itself sends are already in
      // the feed, and injected context is not a turn the user needs to see.
      const data = event.data ?? {}
      const source = data.source
      if (source === null || typeof source !== 'object' || source.kind !== 'agent-message') return null
      const text = peerTextOf(data.content)
      if (text === '') return null
      return {
        kind: 'peer',
        text,
        senderSessionId: typeof source.senderSessionId === 'string' ? source.senderSessionId : null,
      }
    }
    case 'tool/call': {
      const data = event.data ?? {}
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const path = toolPathOf(data.arguments)
      const preview = previewOf(data.arguments)
      const event2 = { kind: 'tool', tool: name, text: preview === '' ? name : `${name} ${preview}` }
      if (path !== null) event2.path = path
      if (isEditTool(name)) event2.edit = true
      // The call id pairs the row with its result, and the full arguments are
      // what the collapsed row hides behind its chevron.
      if (typeof data.callId === 'string' && data.callId !== '') event2.callId = data.callId
      const args = toolArgsOf(data.arguments)
      if (args !== undefined) event2.args = args
      return event2
    }
    case 'tool/result': {
      const data = event.data ?? {}
      // The pairing id lives on the model-facing message (`ToolResultMessage.toolCallId`);
      // `data.callId` is only a fallback for older hosts. Without it the expanded
      // row would show what went in and forever claim the call still runs.
      const raw = data.message?.toolCallId ?? data.callId
      const callId = typeof raw === 'string' && raw !== '' ? raw : undefined
      const error = data.error
      if (error !== null && error !== undefined) {
        const name = typeof error.name === 'string' ? error.name : 'tool error'
        const reason = typeof error.reason === 'string' && error.reason !== '' ? `: ${error.reason}` : ''
        const code = typeof error.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
        // The human-readable text lives in the error message content; error.name
        // alone ("SubagentError") tells the user nothing.
        const detail = contentTextOf(data.message?.content).replace(/^Error:\s*/i, '')
        const text = detail === '' ? `${name}${reason}${code}` : `${name}: ${detail}${code}`
        return callId === undefined ? { kind: 'error', text } : { kind: 'error', text, callId, ok: false }
      }
      // A successful call has no other place in the feed: without this the
      // expanded row could only show what went in, never what came back.
      const output = clip(contentTextOf(data.message?.content).trim(), RESULT_LIMIT)
      if (callId === undefined && output === '') return null
      const event2 = { kind: 'tool-result', ok: data.message?.isError !== true, text: output }
      if (callId !== undefined) event2.callId = callId
      return event2
    }
    case 'turn/start':
      return { kind: 'turn-start' }
    case 'turn/end':
      return { kind: 'turn-end', reason: event.data?.reason }
    default:
      return null
  }
}
