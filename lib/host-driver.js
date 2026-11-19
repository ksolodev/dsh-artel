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

/** Tool-name pattern that marks a tool call as a file edit. */
const EDIT_TOOL_PATTERN = /write|edit|patch|apply|create|replace/i

/** Argument keys that can carry the edited file path. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'target_file', 'file', 'notebook_path']

/** Longest tool argument preview kept in the feed. */
const ARGUMENT_PREVIEW = 160

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
 * @property {string} mode - solo, swarm or conductor.
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
  #peers = false
  #unlisten = null
  #entries = new Map()
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
   * Find the project directory of a chat Session: the copy is made from it and
   * the user's own project is never touched by an agent.
   * @param {string} sessionId - chat Session whose project Artel should copy.
   * @returns {string} absolute project directory.
   */
  projectPathOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('Artel needs the chat session that owns the project')
    }
    const sessions = this.#ctx.get?.('sessions')
    const session = sessions?.get?.(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
    const fallback = this.#ctx.get?.('workingDirectory')?.defaultDirectory
    if (typeof fallback === 'string' && fallback !== '') return fallback
    throw new Error('This chat session has no project directory yet, so there is nothing to copy')
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
   * at once and the agent keeps going — and, when the chat Session is known, the
   * sandbox mode the user runs that chat under.
   *
   * Both writes are the durable events the host services use themselves:
   * `ApprovalService.setPolicy(agent, 'never')` appends `approval/policy` (and
   * tells the agent about it), `setSandboxMode` appends `sandbox/mode`. Artel
   * appends them directly so the driver imports no package that only exists
   * inside the running profile. Every step is best-effort: a stripped profile or
   * a Session that is already gone must never break agent creation.
   * @param {{ sessionId: string, parentSessionId?: string, name: string }} request
   * @returns {Promise<void>} completes once both policies were attempted.
   */
  async #adoptChildSession({ sessionId, parentSessionId, name }) {
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

    if (typeof parentSessionId !== 'string' || parentSessionId === '') return
    try {
      const parent = this.#sessionOf(parentSessionId)
      const sandboxPolicy = this.#ctx.get?.('sandboxPolicy')
      if (parent === undefined || typeof sandboxPolicy?.resolve !== 'function') return
      const mode = sandboxPolicy.resolve({ session: parent })?.mode
      if (typeof mode !== 'string' || mode === '') return
      if (typeof session.append === 'function') session.append('sandbox/mode', { mode })
    } catch (error) {
      this.#log?.warn?.(`dsh-artel: could not copy the sandbox mode to ${name}: ${error?.message ?? error}`)
    }
  }

  /**
   * Create one ordinary Session whose working directory is the run copy.
   * @param {{ name: string, mode: string, projectPath: string, copyPath: string, agentId: string, title?: string, parentSessionId?: string, model?: object }} request
   * @returns {Promise<DriverHandle>} handle used for later prompts.
   */
  async createAgent({ name, mode, projectPath, copyPath, agentId, title, parentSessionId, model }) {
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
    await this.#adoptChildSession({ sessionId, parentSessionId, name })
    if (model !== undefined && model !== null) await this.#applyModel(handle, model)
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
      return text === '' ? null : { kind: 'assistant', text }
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
      return event2
    }
    case 'tool/result': {
      const error = event.data?.error
      if (error === null || error === undefined) return null
      const name = typeof error.name === 'string' ? error.name : 'tool error'
      const reason = typeof error.reason === 'string' && error.reason !== '' ? `: ${error.reason}` : ''
      const code = typeof error.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
      // The human-readable text lives in the error message content; error.name
      // alone ("SubagentError") tells the user nothing.
      const detail = contentTextOf(event.data?.message?.content).replace(/^Error:\s*/i, '')
      if (detail === '') return { kind: 'error', text: `${name}${reason}${code}` }
      return { kind: 'error', text: `${name}: ${detail}${code}` }
    }
    case 'turn/start':
      return { kind: 'turn-start' }
    case 'turn/end':
      return { kind: 'turn-end', reason: event.data?.reason }
    default:
      return null
  }
}
