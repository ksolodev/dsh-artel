import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HostDriver,
  addUsage,
  breakdownOf,
  clip,
  isEditTool,
  isTransientDelivery,
  mapSessionEvent,
  peerTextOf,
  toolArgsOf,
  toolPathOf,
  usageOf,
} from '../lib/host-driver.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Minimal fake Session: records the durable policy events Artel appends. */
function fakeSession(id, mode = 'read-only') {
  const session = {
    id,
    header: { id },
    mode,
    appended: [],
    append(type, data) {
      session.appended.push({ type, data })
      if (type === 'sandbox/mode') session.mode = data.mode
      return { type, data }
    },
    ownEvents() {
      return session.appended.map((entry) => ({ type: entry.type, data: entry.data }))
    },
  }
  return session
}

/** Minimal fake Workspace entity with the members the sidebar bridge touches. */
function fakeWorkspace({ id = 'ws-1', path = 'C:\\project', sessionIds = [] } = {}) {
  const state = { record: { id, path, title: 'project', sessionIds: [...sessionIds], createdAt: 1, updatedAt: 1 } }
  const paths = new Map()
  const writes = []
  const host = {
    rememberSessionPath(sessionId, projectPath) {
      paths.set(sessionId, projectPath)
    },
    candidateMatches(sessionId, projectPath) {
      return paths.get(sessionId) === projectPath
    },
  }
  return {
    id,
    path,
    host,
    paths,
    writes,
    get record() {
      return state.record
    },
    get sessionIds() {
      return state.record.sessionIds.filter((sessionId) => host.candidateMatches(sessionId, state.record.path))
    },
    mutate(change) {
      const next = change(state.record)
      if (next === state.record) throw new Error('no change')
      state.record = { ...next, updatedAt: 2 }
      writes.push({ ...next })
    },
  }
}

/** Minimal fake Host services: session controller, agent registry, subagent runtime, policies. */
function fakeHost(options = {}) {
  const calls = {
    created: [],
    renames: [],
    prompts: [],
    cancels: [],
    activations: [],
    memberPrompts: [],
    interrupts: [],
    policies: [],
  }
  const liveAgents = new Map()
  const sessions = new Map()
  const selections = []
  const selected = new Map()
  const attachModel = (agent) => {
    if (options.agentModels === false) return agent
    agent.model = {
      current() { return selected.get(agent.id) },
      select(selection) {
        if (options.rejectModel === true) throw new Error('the adapter refused the route')
        selections.push({ sessionId: agent.id, selection })
        selected.set(agent.id, selection)
      },
    }
    return agent
  }
  const sessionOf = (sessionId, mode) => {
    let session = sessions.get(sessionId)
    if (session === undefined) {
      session = fakeSession(sessionId, mode)
      sessions.set(sessionId, session)
    }
    return session
  }
  const parentAgent = {
    id: options.parentSessionId ?? 'session-1',
    session: sessionOf(options.parentSessionId ?? 'session-1', options.parentMode ?? 'workspace-write'),
  }
  liveAgents.set(parentAgent.id, parentAgent)
  const controller = {
    async create(request) {
      calls.created.push(request)
      const session = sessionOf(request.sessionId, options.childMode ?? 'read-only')
      const agent = options.noSessions === true ? { id: request.sessionId } : { id: request.sessionId, session }
      liveAgents.set(request.sessionId, attachModel(agent))
      // The real controller creates the Session and only then tries the
      // Workspace attach, reporting the failure with the id it made.
      if (request.workspaceId !== undefined && options.attachFailureId !== undefined) {
        const error = new Error(`session could not attach to workspace ${request.workspaceId}`)
        error.code = 'session/workspace-attach-failed'
        error.details = { sessionId: options.attachFailureId, workspaceId: request.workspaceId }
        throw error
      }
      return { sessionId: request.sessionId }
    },
    async rename(request) {
      calls.renames.push(request)
    },
    async prompt(request) {
      calls.prompts.push(request)
    },
    cancel(request) {
      calls.cancels.push(request)
      return Promise.resolve()
    },
  }
  const agents = {
    get(sessionId) {
      return liveAgents.get(sessionId)
    },
  }
  const subagents = {
    getProvider(name) {
      return name === 'spawn' && options.peers !== false ? { name } : undefined
    },
    async startActivation(spec) {
      calls.activations.push(spec)
      // The real runtime attaches the child Session before the activation
      // resolves; the fake does the same so the driver can reach it.
      const childId = options.childId ?? 'member-1'
      const childSession = sessionOf(childId, options.memberMode ?? 'read-only')
      liveAgents.set(childId, attachModel({ id: childId, session: childSession }))
      return {
        childId,
        name: spec.name,
        result: Promise.resolve({ ok: true }),
        dispose: async () => {},
      }
    },
    async prompt(request) {
      calls.memberPrompts.push(request)
      if (calls.memberPrompts.length === 1 && options.closingOnce === true) {
        throw { code: 'subagent/delivery-unavailable', message: 'subagent follow-up is temporarily unavailable' }
      }
      return { messageId: 'm1' }
    },
    interrupt(sessionId, authority) {
      calls.interrupts.push({ sessionId, authority })
    },
  }
  const approval = options.noApproval === true ? undefined : {
    setPolicy(agent, policy) {
      calls.policies.push({ agentId: agent?.id, policy })
    },
  }
  const sandboxPolicy = options.noSandbox === true ? undefined : {
    resolve(request = {}) {
      return { mode: request.session?.mode ?? 'read-only', workspaceRoot: 'C:\\workspace' }
    },
  }
  const handlers = new Map()
  const llm = options.noLlm === true ? undefined : {
    listProviders: () => options.providers ?? [{ id: 'test', name: 'Test' }],
    listModels: (providerId) => (options.modelsByProvider ?? {})[providerId] ?? [
      { id: 'fast', name: 'Fast' },
      { id: 'slow', name: 'Slow' },
    ],
    // The real service is `resolveModelInfo(provider, model, signal?)`: a pair
    // object silently degrades every effort list to empty, so the fake refuses
    // one and records the positional arguments.
    resolveModelInfo: (providerId, modelId) => {
      if (typeof providerId !== 'string' || typeof modelId !== 'string') {
        throw new Error('resolveModelInfo takes the provider route and the model id, not a pair object')
      }
      options.infoCalls?.push([providerId, modelId])
      return (options.infoByModel ?? {})[modelId] ?? (modelId === 'fast'
        ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
        : {})
    },
  }
  const defaultModel = {
    currentSelection: () => options.defaultSelection ?? { provider: 'test', model: 'fast', reasoningEffort: 'low' },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionController') return options.noController === true ? undefined : controller
      if (name === 'agents') return agents
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return options.noDefaultModel === true ? undefined : defaultModel
      if (name === 'subagents') return options.peers === false ? undefined : subagents
      if (name === 'sessions') return options.noSessions === true ? undefined : { get: (sessionId) => sessions.get(sessionId) }
      if (name === 'sessionQuery') return options.sessionQuery
      if (name === 'approval') return approval
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'tokenMeter') return options.tokenMeter
      if (name === 'sessionProjections') return options.projections
      if (name === 'workspaceRegistry') {
        if (options.workspaceRegistry !== undefined) return options.workspaceRegistry
        const workspaces = Array.isArray(options.workspaces) ? options.workspaces : null
        if (workspaces === null) return undefined
        return {
          list: () => workspaces,
          get: (id) => workspaces.find((workspace) => workspace.id === id),
          async resolveByPath(projectPath) {
            return workspaces.find((workspace) => workspace.path === projectPath)
          },
        }
      }
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  return { ctx, calls, handlers, parentAgent, subagents, sessions, agents, selections }
}

test('mapSessionEvent turns durable events into feed events', () => {
  assert.deepEqual(
    mapSessionEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I am on it.' }] } } }),
    { kind: 'assistant', text: 'I am on it.' },
  )
  assert.deepEqual(
    mapSessionEvent({
      type: 'user/message',
      data: {
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'member-2' },
        content: [{ type: 'text', text: 'Agent orion sent a message: README.md is stale.' }],
      },
    }),
    { kind: 'peer', text: 'README.md is stale.', senderSessionId: 'member-2' },
  )
  assert.equal(
    mapSessionEvent({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'the prompt we sent' }] },
    }),
    null,
    'our own prompts are not news in the feed',
  )
  assert.deepEqual(
    mapSessionEvent({ type: 'tool/call', data: { name: 'edit', arguments: '{"path":"src/app.js"}' } }),
    {
      kind: 'tool',
      tool: 'edit',
      text: 'edit {"path":"src/app.js"}',
      path: 'src/app.js',
      edit: true,
      args: '{\n  "path": "src/app.js"\n}',
    },
    'the arguments behind the chevron are the full call, not the 160-char preview',
  )
  assert.deepEqual(
    mapSessionEvent({ type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: { command: 'ls' } } }),
    { kind: 'tool', tool: 'pwsh', text: 'pwsh {"command":"ls"}', callId: 'call-1', args: '{\n  "command": "ls"\n}' },
  )
  assert.deepEqual(
    mapSessionEvent({
      type: 'tool/result',
      data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'a.js\n' }] } },
    }),
    { kind: 'tool-result', ok: true, text: 'a.js', callId: 'call-1' },
    'a successful call keeps its output and the id of the call it answers',
  )
  assert.deepEqual(
    mapSessionEvent({
      type: 'tool/result',
      data: { callId: 'call-0', message: { content: [{ type: 'text', text: 'legacy' }] } },
    }),
    { kind: 'tool-result', ok: true, text: 'legacy', callId: 'call-0' },
    'a host that only reports the id on the event data still pairs the result',
  )
  assert.deepEqual(
    mapSessionEvent({
      type: 'tool/result',
      data: { message: { toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: 'no such file' }] } },
    }),
    { kind: 'tool-result', ok: false, text: 'no such file', callId: 'call-2' },
    'a failed call is marked failed even when the host sends no error object',
  )
  assert.equal(
    mapSessionEvent({ type: 'tool/result', data: { message: { content: [] } } }),
    null,
    'an empty result without a call id has nothing to show',
  )
  assert.deepEqual(
    mapSessionEvent({ type: 'tool/result', data: { error: { name: 'edit', reason: 'no such file' } } }),
    { kind: 'error', text: 'edit: no such file' },
  )
  assert.deepEqual(
    mapSessionEvent({
      type: 'tool/result',
      data: {
        error: { name: 'SubagentError', code: 'NOT_RESUMABLE' },
        message: { content: [{ type: 'text', text: 'Error: subagent "Orion" is unavailable' }] },
      },
    }),
    { kind: 'error', text: 'SubagentError: subagent "Orion" is unavailable (NOT_RESUMABLE)' },
    'the feed needs the human text and the code, not just the error class',
  )
  assert.deepEqual(mapSessionEvent({ type: 'turn/start' }), { kind: 'turn-start' })
  assert.deepEqual(mapSessionEvent({ type: 'turn/end', data: { reason: 'done' } }), { kind: 'turn-end', reason: 'done' })
  assert.equal(mapSessionEvent({ type: 'assistant/thinking' }), null)
})

test('toolPathOf reads the path out of every accepted argument shape', () => {
  assert.equal(toolPathOf({ path: 'a.js' }), 'a.js')
  assert.equal(toolPathOf({ file_path: 'b.js' }), 'b.js')
  assert.equal(toolPathOf('{"filePath":"c.js"}'), 'c.js')
  assert.equal(toolPathOf('broken {"target_file": "d.js"} tail'), 'd.js')
  assert.equal(toolPathOf({ command: 'ls' }), null)
  assert.equal(toolPathOf(null), null)
  assert.equal(toolPathOf('{"path":"e\\\\f.js"}'), 'e\\f.js')
})

test('peerTextOf strips the subagent relay framing', () => {
  assert.equal(peerTextOf([{ type: 'text', text: 'Agent orion sent a message: I take README.md.' }]), 'I take README.md.')
  assert.equal(peerTextOf([{ type: 'text', text: 'plain text' }]), 'plain text')
  assert.equal(peerTextOf([{ type: 'image' }]), '')
})

test('isTransientDelivery only accepts the closing-window refusals', () => {
  assert.equal(isTransientDelivery({ code: 'subagent/delivery-unavailable' }), true)
  assert.equal(isTransientDelivery({ cause: { code: 'ACTIVATION_CLOSING' } }), true)
  assert.equal(isTransientDelivery(new Error('subagent tree root is not live')), true)
  assert.equal(isTransientDelivery({ code: 'subagent/unauthorized' }), false)
  assert.equal(isEditTool('apply_patch'), true)
  assert.equal(isEditTool('read'), false)
})

test('clip cuts to the budget and toolArgsOf keeps the whole call', () => {
  assert.equal(clip('short', 20), 'short')
  const long = 'a'.repeat(50)
  const cut = clip(long, 20)
  assert.equal(cut.length, 20, 'the ellipsis is part of the budget')
  assert.ok(cut.endsWith('…'))
  assert.equal(toolArgsOf(undefined), undefined)
  assert.equal(toolArgsOf(''), undefined)
  assert.equal(toolArgsOf('{"path":"a.js"}'), '{\n  "path": "a.js"\n}')
  assert.equal(toolArgsOf('not json'), 'not json', 'a plain-text argument still shows as typed')
  assert.ok(toolArgsOf({ command: 'x'.repeat(9000) }).length <= 4000 + 1, 'a huge payload is capped')
})

test('usageOf reads what the provider billed, and addUsage sums it up', () => {
  assert.equal(usageOf(null), null)
  assert.equal(usageOf({}), null)
  assert.equal(usageOf({ inputTokens: 0, outputTokens: 0 }), null)
  assert.deepEqual(usageOf({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 8 }), {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 400,
    cacheWriteTokens: 8,
    totalTokens: 150,
  })
  assert.equal(usageOf({ inputTokens: 120, outputTokens: 30, totalTokens: 999 }).totalTokens, 999, 'a reported total wins over the sum')

  const one = addUsage(null, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 12 })
  const two = addUsage(one, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 })
  assert.deepEqual(two, {
    inputTokens: 11,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 14,
    requests: 2,
  })
})

test('breakdownOf reads the token meter composition through the projection registry', () => {
  assert.equal(breakdownOf(null, {}), null, 'a stripped profile shows no composition')
  const asked = []
  const registry = {
    snapshot(session, keys) {
      asked.push({ session, keys })
      return { asOfSeq: 4, values: { contextBreakdown: { systemTokens: 900, toolsTokens: 2400, messageTokens: 6100 } } }
    },
  }
  const session = fakeSession('s1')
  assert.deepEqual(breakdownOf(registry, session), { system: 900, tools: 2400, messages: 6100 })
  assert.deepEqual(asked[0].keys, ['contextBreakdown'], 'only the unit the row needs is computed')

  const broken = { snapshot() { throw new Error('not prepared') } }
  assert.equal(breakdownOf(broken, session), null, 'a Session with no sized request is not a failure')
  const absent = { snapshot: () => ({ asOfSeq: 1, values: {} }) }
  assert.equal(breakdownOf(absent, session), null)
})

test('the driver meters each agent context and spend as its events arrive', async () => {
  const pressures = [
    { pressureTokens: 40_000, contextWindow: 128_000 },
    { pressureTokens: 96_000, contextWindow: 128_000 },
  ]
  const meter = { contextPressure: () => pressures.shift() ?? { pressureTokens: 96_000, contextWindow: 128_000 } }
  const projections = {
    snapshot: () => ({ asOfSeq: 3, values: { contextBreakdown: { systemTokens: 900, toolsTokens: 2500, messageTokens: 6000 } } }),
  }
  const host = fakeHost({ tokenMeter: meter, projections })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({ name: 'Orion', mode: 'swarm', projectPath: 'C:\\project', copyPath: 'C:\\copy', agentId: 'a1' })
  assert.deepEqual(driver.statsOf(handle), { context: null, usage: null }, 'nothing is guessed before the first event')

  const session = host.sessions.get(handle.sessionId)
  const emit = host.handlers.get('session/event')
  emit(session, { type: 'turn/start', data: {} })
  assert.deepEqual(driver.statsOf(handle).context, {
    tokens: 40_000,
    window: 128_000,
    breakdown: { system: 900, tools: 2500, messages: 6000 },
    at: driver.statsOf(handle).context.at,
  })

  emit(session, {
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 1_200, outputTokens: 340, cacheReadTokens: 900 },
    },
  })
  const stats = driver.statsOf(handle)
  assert.equal(stats.context.tokens, 96_000, 'the ring follows the newest request')
  assert.deepEqual(stats.usage, {
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    totalTokens: 1_540,
    requests: 1,
  })
  assert.deepEqual(driver.statsOf({ sessionId: 'unknown' }), { context: null, usage: null })
  await driver.dispose()
  assert.deepEqual(driver.statsOf(handle), { context: null, usage: null }, 'dispose forgets the numbers')
})

test('init requires the session controller and detects the peer stack', async () => {
  const broken = fakeHost({ noController: true })
  await assert.rejects(() => new HostDriver(broken.ctx).init(), /session controller/)

  const host = fakeHost()
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  assert.equal(driver.supportsPeers(), true)

  const stripped = fakeHost({ peers: false })
  const legacy = new HostDriver(stripped.ctx, { log: { warn() {} } })
  await legacy.init()
  assert.equal(legacy.supportsPeers(), false)
})

test('a Session agent is created, titled and prompted through the controller', async () => {
  const host = fakeHost()
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()

  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
    title: 'Artel · Vega',
  })
  assert.equal(handle.kind, 'session')
  assert.equal(handle.sessionId, host.calls.created[0].sessionId)
  assert.equal(host.calls.created[0].cwd, 'C:\\copy')
  assert.deepEqual(host.calls.renames[0], { sessionId: handle.sessionId, title: 'Artel · Vega' })

  await driver.prompt(handle, 'do the thing')
  assert.equal(host.calls.prompts[0].sessionId, handle.sessionId)
  assert.deepEqual(host.calls.prompts[0].content, [{ type: 'text', text: 'do the thing' }])
  assert.equal(host.calls.prompts[0].mode, 'queue')
  await driver.dispose()
})

test('a child Session is made unattended and inherits the chat sandbox mode', async () => {
  const host = fakeHost({ parentSessionId: 'session-chat', parentMode: 'danger-full-access' })
  const warns = []
  const driver = new HostDriver(host.ctx, { log: { warn: (message) => warns.push(message) } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
    parentSessionId: 'session-chat',
  })
  const child = host.sessions.get(handle.sessionId)
  assert.deepEqual(
    host.calls.policies,
    [{ agentId: handle.sessionId, policy: 'never' }],
    'the ApprovalService is asked to auto-reject instead of waiting for a human',
  )
  assert.deepEqual(
    child.appended,
    [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
    'the child works under the same sandbox mode as the chat that started the run',
  )
  assert.equal(child.mode, 'danger-full-access')
  assert.deepEqual(warns, [])
  await driver.dispose()
})

test('without the approval service the durable policy event is appended', async () => {
  const host = fakeHost({ noApproval: true })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
  })
  const child = host.sessions.get(handle.sessionId)
  assert.deepEqual(child.appended, [{ type: 'approval/policy', data: { policy: 'never' } }])
  await driver.dispose()
})

test('making a child unattended never breaks agent creation', async () => {
  const host = fakeHost({ noSessions: true })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
  })
  assert.equal(handle.kind, 'session')
  assert.equal(host.calls.created.length, 1)
  await driver.dispose()
})

test('a swarm member is spawned as a continuable subagent of the lead Session', async () => {
  const host = fakeHost()
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const lead = await driver.createAgent({
    name: 'Vega',
    mode: 'swarm',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
  })
  const member = await driver.spawnMember({
    parent: lead,
    name: 'orion',
    displayName: 'Orion',
    label: 'Artel swarm · Orion',
    promptText: 'plan the work',
    copyPath: 'C:\\copy',
    projectPath: 'C:\\project',
    agentId: 'a2',
    mode: 'swarm',
  })
  assert.equal(member.kind, 'member')
  assert.equal(member.sessionId, 'member-1')
  assert.equal(member.subagentName, 'orion')
  const spec = host.calls.activations[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.name, 'orion')
  assert.equal(spec.parent.id, lead.sessionId, 'the lead Session is the tree root')
  assert.equal(spec.delivery, 'caller', 'the lead is not pinged when a member finishes a turn')
  assert.equal(spec.cwd, 'C:\\copy')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'plan the work' }])
  await driver.dispose()
})

test('a spawned swarm member is made unattended like the lead', async () => {
  const host = fakeHost({ parentSessionId: 'session-chat', parentMode: 'danger-full-access' })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const lead = await driver.createAgent({
    name: 'Vega',
    mode: 'swarm',
    projectPath: 'C:\\project',
    copyPath: 'C:\\copy',
    agentId: 'a1',
    parentSessionId: 'session-chat',
  })
  const member = await driver.spawnMember({
    parent: lead,
    name: 'orion',
    displayName: 'Orion',
    promptText: 'plan the work',
    copyPath: 'C:\\copy',
    projectPath: 'C:\\project',
    agentId: 'a2',
    mode: 'swarm',
  })
  assert.deepEqual(
    host.calls.policies.at(-1),
    { agentId: member.sessionId, policy: 'never' },
    'the subagent child auto-rejects escalations too',
  )
  const memberSession = host.sessions.get(member.sessionId)
  assert.ok(
    memberSession.appended.some((entry) => entry.type === 'sandbox/mode' && entry.data.mode === 'danger-full-access'),
    'the member inherits the sandbox mode through its lead Session',
  )
  assert.equal(memberSession.mode, 'danger-full-access')
  await driver.dispose()
})

test('member prompts use the subagent runtime and retry while the activation closes', async () => {
  const host = fakeHost({ closingOnce: true })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const lead = await driver.createAgent({ name: 'Vega', mode: 'swarm', projectPath: 'p', copyPath: 'c', agentId: 'a1' })
  const member = await driver.spawnMember({
    parent: lead,
    name: 'lyra',
    displayName: 'Lyra',
    promptText: 'plan',
    copyPath: 'c',
    projectPath: 'p',
    agentId: 'a3',
    mode: 'swarm',
  })

  await driver.prompt(member, 'go ahead')
  assert.equal(host.calls.memberPrompts.length, 2, 'the closing window is retried')
  assert.deepEqual(host.calls.memberPrompts[1], {
    requestId: host.calls.memberPrompts[1].requestId,
    childSessionId: 'member-1',
    delivery: 'queue',
    content: [{ type: 'text', text: 'go ahead' }],
  })
  assert.equal(host.calls.prompts.length, 0, 'a subagent Session is never prompted through the controller')

  await driver.interrupt(member)
  assert.deepEqual(host.calls.interrupts[0], { sessionId: 'member-1', authority: { kind: 'user' } })
  await driver.dispose()
})

test('session events reach the engine as peer messages', async () => {
  const host = fakeHost()
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const lead = await driver.createAgent({ name: 'Vega', mode: 'swarm', projectPath: 'p', copyPath: 'c', agentId: 'a1' })
  const received = []
  driver.subscribe(lead, (event) => received.push(event))
  const publish = host.handlers.get('session/event')
  assert.equal(typeof publish, 'function')

  publish({ header: { id: lead.sessionId } }, {
    type: 'user/message',
    data: {
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'member-2' },
      content: [{ type: 'text', text: 'Agent orion sent a message: I take README.md.' }],
    },
  })
  publish({ header: { id: 'unknown-session' } }, { type: 'turn/start' })
  await flush()
  assert.deepEqual(received, [{ kind: 'peer', text: 'I take README.md.', senderSessionId: 'member-2' }])

  await driver.dispose()
  const afterDispose = host.handlers.get('session/event')
  if (afterDispose) {
    afterDispose({ header: { id: lead.sessionId } }, { type: 'turn/start' })
    await flush()
  }
  assert.equal(received.length, 1, 'a disposed driver stops observing')
})

test('listModels builds the catalog the Host can really call', async () => {
  const infoCalls = []
  const host = fakeHost({ infoCalls })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const catalog = await driver.listModels()
  assert.deepEqual(infoCalls, [['test', 'fast'], ['test', 'slow']], 'metadata is resolved per provider route and model id')
  assert.deepEqual(catalog.providers, [{
    id: 'test',
    name: 'Test',
    models: [
      { id: 'fast', name: 'Fast', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low' },
      { id: 'slow', name: 'Slow', efforts: [] },
    ],
  }])
  assert.deepEqual(catalog.default, { provider: 'test', model: 'fast', reasoningEffort: 'low' })
  await driver.dispose()
})

test('a created agent is routed to the run selection from its next step', async () => {
  const host = fakeHost()
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'p',
    copyPath: 'c',
    agentId: 'a1',
    model: { provider: 'test', model: 'fast', reasoningEffort: 'high' },
  })
  assert.deepEqual(handle.model, { provider: 'test', model: 'fast', reasoningEffort: 'high' })
  assert.deepEqual(host.selections, [{ sessionId: handle.sessionId, selection: { provider: 'test', model: 'fast', reasoningEffort: 'high' } }])

  const rerouted = await driver.selectModel(handle, { provider: 'test', model: 'slow' })
  assert.deepEqual(rerouted, { provider: 'test', model: 'slow' })
  assert.deepEqual(handle.model, { provider: 'test', model: 'slow' })
  assert.equal(host.selections.length, 2, 'the routable agent is written through agent.model.select')
  await driver.dispose()
})

test('a refused or unreachable route degrades to a warning, it does not kill the run', async () => {
  const host = fakeHost({ rejectModel: true })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'p',
    copyPath: 'c',
    agentId: 'a1',
    model: { provider: 'test', model: 'fast' },
  })
  assert.equal(handle.model, undefined, 'the route was never recorded')
  assert.match(handle.modelError, /refused the route/)
  await assert.rejects(
    () => driver.selectModel(handle, { provider: 'test', model: 'fast' }),
    /refused the route/,
    'an explicit reroute surfaces the error to the caller',
  )
  await driver.dispose()

  const blind = fakeHost({ agentModels: false })
  const blindDriver = new HostDriver(blind.ctx, { log: { warn() {} } })
  await blindDriver.init()
  const blindHandle = await blindDriver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'p',
    copyPath: 'c',
    agentId: 'a1',
    model: { provider: 'test', model: 'fast' },
  })
  assert.match(blindHandle.modelError, /cannot reach the live Agent/)
  await blindDriver.dispose()
})

test('the driver files an agent chat under its project without touching its cwd', async () => {
  const workspace = fakeWorkspace()
  const host = fakeHost({ workspaces: [workspace] })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  try {
    assert.equal(driver.supportsProjectChats(), true)
    const handle = await driver.createAgent({
      name: 'Vega',
      mode: 'solo',
      projectPath: 'C:\\project',
      copyPath: 'C:\\copies\\run-1',
      agentId: 'run-1-a1',
    })
    // The sandbox boundary stays the copy: the Session is still created with
    // cwd = copy and no workspaceId.
    assert.deepEqual(host.calls.created[0], { sessionId: handle.sessionId, cwd: 'C:\\copies\\run-1' })
    assert.ok(workspace.record.sessionIds.includes(handle.sessionId), 'the chat is in the project record')
    assert.equal(workspace.paths.get(handle.sessionId), 'C:\\project', 'the cwd index is primed for the project')
    assert.ok(workspace.sessionIds.includes(handle.sessionId), 'the sidebar filter shows the chat')
  } finally {
    await driver.dispose()
  }
})

test('a project folder that is not an open Workspace keeps the old grouping', async () => {
  const host = fakeHost({ workspaces: [] })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  const handle = await driver.createAgent({
    name: 'Vega',
    mode: 'solo',
    projectPath: 'C:\\loose',
    copyPath: 'C:\\copies\\run-1',
    agentId: 'run-1-a1',
  })
  assert.equal(driver.supportsProjectChats(), true, 'the registry exists, the folder just is not in it')
  assert.equal(handle.sessionId.startsWith('session-'), true, 'the agent session is still created')
  await driver.dispose()
})

test('the driver creates a read-only task chat inside the project workspace', async () => {
  const workspace = fakeWorkspace()
  const host = fakeHost({ workspaces: [workspace] })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  try {
    const chat = await driver.createTaskChat({ projectPath: 'C:\\project', task: 'Add a settings screen' })
    assert.equal(chat.workspaceId, 'ws-1')
    assert.equal(chat.title, 'Artel · Add a settings screen')
    // A legit member: the controller receives workspaceId, not cwd.
    assert.deepEqual(host.calls.created[0], { sessionId: chat.sessionId, workspaceId: 'ws-1' })
    assert.deepEqual(host.calls.renames[0], { sessionId: chat.sessionId, title: 'Artel · Add a settings screen' })
    const session = host.sessions.get(chat.sessionId)
    assert.deepEqual(session.appended.find((event) => event.type === 'sandbox/mode'), { type: 'sandbox/mode', data: { mode: 'read-only' } })
    // A blank chat would hide its title behind the New Session label and could be
    // reused as the next draft, so the chat gets one empty finished turn.
    const turnStart = session.appended.findIndex((event) => event.type === 'turn/start')
    const turnEnd = session.appended.findIndex((event) => event.type === 'turn/end')
    assert.ok(turnStart >= 0, 'the task chat is marked as started')
    assert.ok(turnEnd > turnStart, 'the synthetic turn is closed right away')
    assert.deepEqual(session.appended[turnStart], { type: 'turn/start', data: { turn: 1 } })
    assert.deepEqual(session.appended[turnEnd], { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.ok(workspace.record.sessionIds.includes(chat.sessionId), 'the membership is repaired defensively')
  } finally {
    await driver.dispose()
  }
})

test('a task chat stays reachable when the workspace attach fails after creation', async () => {
  const workspace = fakeWorkspace()
  const host = fakeHost({ workspaces: [workspace], attachFailureId: 'session-recovered' })
  // The recovered chat already carries a turn (the attach failed after the chat
  // was used), so the mark-started repair must not append a second one.
  const recovered = fakeSession('session-recovered')
  recovered.appended.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  host.sessions.set('session-recovered', recovered)
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  try {
    const chat = await driver.createTaskChat({ projectPath: 'C:\\project', task: 'Still start' })
    assert.equal(chat.sessionId, 'session-recovered', 'the created chat is not lost with the attach error')
    assert.ok(workspace.record.sessionIds.includes('session-recovered'), 'the bridge files it anyway')
    assert.equal(recovered.appended.filter((event) => event.type === 'turn/start').length, 1, 'an already started chat is left alone')
  } finally {
    await driver.dispose()
  }
})

test('no workspace for this version means no task chat and no bridge', async () => {
  const loose = fakeHost({ workspaces: [] })
  const looseDriver = new HostDriver(loose.ctx, { log: { warn() {} } })
  await looseDriver.init()
  assert.equal(await looseDriver.createTaskChat({ projectPath: 'C:\\loose', task: 'x' }), null)
  assert.deepEqual(loose.calls.created, [])
  await looseDriver.dispose()

  const bare = fakeHost()
  const bareDriver = new HostDriver(bare.ctx, { log: { warn() {} } })
  await bareDriver.init()
  assert.equal(bareDriver.supportsProjectChats(), false)
  assert.equal(await bareDriver.createTaskChat({ projectPath: 'C:\\project', task: 'x' }), null)
  assert.equal(await bareDriver.attachProjectChat({ sessionId: 'session-1', projectPath: 'C:\\project' }), null)
  await bareDriver.dispose()
})

test('hasSession finds a cold chat in sessionQuery and projectPathOf reads its cwd', async () => {
  let disposed = 0
  const host = fakeHost({
    sessionQuery: {
      async observeSession(id) {
        return {
          header: { id, cwd: 'C:\\cold-project' },
          [Symbol.dispose]() {
            disposed += 1
          },
        }
      },
    },
  })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  assert.equal(await driver.hasSession('session-cold'), true)
  assert.equal(await driver.projectPathOf('session-cold'), 'C:\\cold-project')
  assert.equal(disposed, 2, 'every prepared observation is disposed')
})

test('an unknown session is rejected instead of falling back to the profile directory', async () => {
  const host = fakeHost({
    sessionQuery: {
      async observeSession() {
        throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      },
    },
  })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  assert.equal(await driver.hasSession('session-missing'), false)
  await assert.rejects(() => driver.projectPathOf('session-missing'), /Unknown chat session/)
})

test('restoreProjectChats re-primes the chats of opted-in runs only', async () => {
  const workspace = fakeWorkspace()
  const host = fakeHost({ workspaces: [workspace] })
  const driver = new HostDriver(host.ctx, { log: { warn() {} } })
  await driver.init()
  try {
    const result = await driver.restoreProjectChats([
      { projectChats: true, projectPath: 'C:\\project', sessionId: 'session-task-1', agents: [{ sessionId: 'session-agent-1' }] },
      { projectPath: 'C:\\project', sessionId: 'session-old', agents: [{ sessionId: 'session-old-agent' }] },
    ])
    assert.deepEqual(result, { attached: 2, skipped: 0, failed: 0 })
    assert.ok(workspace.record.sessionIds.includes('session-agent-1'))
    assert.equal(workspace.record.sessionIds.includes('session-old-agent'), false)
  } finally {
    await driver.dispose()
  }
})
