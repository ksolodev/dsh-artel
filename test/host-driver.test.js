import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HostDriver,
  isEditTool,
  isTransientDelivery,
  mapSessionEvent,
  peerTextOf,
  toolPathOf,
} from '../lib/host-driver.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Minimal fake Host services: session controller, agent registry, subagent runtime. */
function fakeHost(options = {}) {
  const calls = { created: [], renames: [], prompts: [], cancels: [], activations: [], memberPrompts: [], interrupts: [] }
  const liveAgents = new Map()
  const controller = {
    async create(request) {
      calls.created.push(request)
      const agent = { id: request.sessionId }
      liveAgents.set(request.sessionId, agent)
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
  const parentAgent = { id: options.parentSessionId ?? 'session-1' }
  liveAgents.set(parentAgent.id, parentAgent)
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
      return {
        childId: options.childId ?? 'member-1',
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
  const handlers = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessionController') return options.noController === true ? undefined : controller
      if (name === 'agents') return agents
      if (name === 'subagents') return options.peers === false ? undefined : subagents
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  return { ctx, calls, handlers, parentAgent, subagents }
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
    { kind: 'tool', tool: 'edit', text: 'edit {"path":"src/app.js"}', path: 'src/app.js', edit: true },
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
