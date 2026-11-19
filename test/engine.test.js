import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ArtelEngine, ArtelError } from '../lib/engine.js'
import { RunStore } from '../lib/run-store.js'

/**
 * A driver that records prompts and lets the test emit agent events by hand, so
 * every orchestration step is observed deterministically (no real agents).
 *
 * It models the real driver's two kinds of agents: an ordinary Session (the solo
 * agent and the swarm lead) and a subagent member that lives inside the lead's
 * conversation tree.
 */
class FakeDriver {
  created = []
  members = []
  /** Prompts in delivery order: plan turns first, then every follow-up. */
  prompts = []
  interrupted = []
  disposed = false
  /** Set to false to model a profile without the subagent stack. */
  peers = true
  /** Set to true to model a host that refuses every prompt. */
  failPrompt = false
  /** Optional async hook run before a prompt is accepted or refused. */
  onPrompt = null
  /** Catalog this fake profile advertises. */
  models = {
    providers: [{
      id: 'test',
      name: 'Test',
      models: [
        { id: 'fast', name: 'Fast', efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
        { id: 'slow', name: 'Slow', efforts: [] },
      ],
    }],
    default: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
  }
  /** Routes written through `selectModel`. */
  selections = []

  async listModels() {
    return this.models
  }

  async selectModel(handle, selection) {
    this.selections.push({ agent: handle.name, selection })
    handle.model = selection
    return selection
  }

  supportsPeers() {
    return this.peers
  }

  async createAgent({ name, mode, projectPath, copyPath, agentId, parentSessionId, model }) {
    const handle = {
      id: agentId,
      kind: 'session',
      sessionId: `session-${this.created.length + 1}`,
      name,
      mode,
      projectPath,
      copyPath,
      parentSessionId,
      model,
      listeners: new Set(),
    }
    this.created.push(handle)
    return handle
  }

  async spawnMember({ parent, name, displayName, label, promptText, copyPath, projectPath, agentId, mode, model }) {
    if (!this.peers) throw new Error('this profile has no subagent stack')
    const handle = {
      id: agentId,
      kind: 'member',
      sessionId: `member-${this.members.length + 1}`,
      name: displayName,
      subagentName: name,
      parentSessionId: parent.sessionId,
      label,
      mode,
      projectPath,
      copyPath,
      model,
      initialPrompt: promptText,
      listeners: new Set(),
    }
    this.members.push(handle)
    // The spawn prompt is a real first turn, delivered by the subagent runtime.
    this.prompts.push({ agent: displayName, kind: 'spawn', text: promptText })
    return handle
  }

  subscribe(handle, listener) {
    handle.listeners.add(listener)
    return () => handle.listeners.delete(listener)
  }

  async prompt(handle, text) {
    this.prompts.push({ agent: handle.name, kind: handle.kind ?? 'session', text })
    if (this.onPrompt !== null) await this.onPrompt(handle, text)
    if (this.failPrompt === true) throw new Error('the host rejected the prompt')
  }

  async interrupt(handle) {
    this.interrupted.push(handle.name)
  }

  async dispose() {
    this.disposed = true
  }

  /** Deliver one event to one agent and wait until the engine finished reacting. */
  async emit(handle, event) {
    const results = []
    for (const listener of handle.listeners) results.push(listener(event))
    await Promise.all(results)
  }

  /** Every agent of the run: the lead Session first, then the members. */
  all() {
    return [...this.created, ...this.members]
  }

  handleFor(name) {
    return this.all().find((handle) => handle.name === name)
  }
}

async function fixture(name, extraConfig = {}, options = {}) {
  const root = path.join(process.cwd(), 'test', '.tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  const projectPath = path.join(root, 'project')
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(stateDir, 'copies')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  const driver = new FakeDriver()
  if (options.peers === false) driver.peers = false
  const store = new RunStore({ dir: path.join(stateDir, 'runs') })
  const engine = await new ArtelEngine({
    store,
    driver,
    copyRoot,
    config: { swarmAgentCount: 3, ...extraConfig },
    log: { warn() {} },
  }).init()
  return {
    root,
    projectPath,
    copyRoot,
    stateDir,
    driver,
    engine,
    store,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

test('solo run: copy, work, review and apply', async () => {
  const f = await fixture('solo')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer to 2' })
    assert.equal(run.status, 'running')
    assert.equal(run.mode, 'solo')
    assert.equal(run.agents.length, 1)
    assert.equal(f.driver.created.length, 1)
    assert.equal(f.driver.created[0].copyPath, run.copyPath)
    assert.equal(f.driver.created[0].projectPath, f.projectPath)
    assert.match(f.driver.prompts[0].text, /Change the answer to 2/)
    assert.ok(await fs.stat(run.copyPath))

    const handle = f.driver.created[0]
    await f.driver.emit(handle, { kind: 'assistant', text: 'Reading src/app.js and the README.' })
    await f.driver.emit(handle, { kind: 'tool', tool: 'edit', path: 'src/app.js' })
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the project is untouched before apply')

    await f.driver.emit(handle, { kind: 'turn-end' })
    const waiting = f.engine.listRuns('s1')[0]
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.changeCount, 1)
    assert.equal(waiting.agents[0].status, 'idle')

    const changes = await f.engine.changes(run.id)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].path, 'src/app.js')
    assert.equal(changes[0].status, 'modified')
    assert.equal(changes[0].added, 1)
    assert.equal(changes[0].removed, 1)

    const applied = await f.engine.apply(run.id)
    assert.deepEqual(applied.applied, ['src/app.js'])
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
    assert.equal(f.engine.listRuns('s1')[0].status, 'applied')
    await assert.rejects(() => fs.stat(run.copyPath), 'the isolated copy is deleted once the run is applied')
    assert.deepEqual(await f.engine.changes(run.id), [], 'a retired copy reports no changes')

    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.length >= 3)
    assert.ok(feed.events.some((event) => event.kind === 'assistant'))
    assert.ok(feed.events.some((event) => event.kind === 'tool'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the run phase tracks the latest status line, even on terminal runs', async () => {
  const f = await fixture('phase')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    assert.equal(f.engine.listRuns('s1')[0].phase, 'Vega is starting on the task.')
    const handle = f.driver.created[0]
    await f.driver.emit(handle, { kind: 'assistant', text: 'Looking at the project first.' })
    assert.equal(f.engine.listRuns('s1')[0].phase, 'Vega is starting on the task.', 'agent text is not a phase')

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await f.driver.emit(handle, { kind: 'turn-end' })
    assert.equal(
      f.engine.listRuns('s1')[0].phase,
      'Every agent is idle. 1 file changed — review the diff and apply what you like.',
    )

    await f.engine.apply(run.id)
    const applied = f.engine.listRuns('s1')[0]
    assert.equal(applied.status, 'applied')
    assert.equal(applied.phase, 'Applied 1 file to your project.', 'the terminal run still keeps its last phase')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('apply never overwrites a file the user edited during the run', async () => {
  const f = await fixture('conflict')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'touch both files' })
    const handle = f.driver.created[0]
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo v2\n')
    await f.driver.emit(handle, { kind: 'turn-end' })
    // The user edits one of the files while the agent works.
    await fs.writeFile(path.join(f.projectPath, 'README.md'), '# My own edit\n')

    await assert.rejects(
      () => f.engine.apply(run.id),
      (error) => error instanceof ArtelError && /Nothing was applied/.test(error.message) && /README\.md/.test(error.message),
    )
    const applied = await f.engine.apply(run.id, ['src/app.js'])
    assert.deepEqual(applied.applied, ['src/app.js'])
    assert.equal(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8'), '# My own edit\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('swarm run: first turn only divides ownership, then the agents work', async () => {
  const f = await fixture('swarm')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'Rewrite the app and the readme' })
    assert.equal(run.status, 'planning')
    assert.equal(run.agents.length, 3)
    // One lead Session plus two subagent members: the three agents live in one
    // conversation tree, which is what lets them message each other.
    assert.equal(f.driver.created.length, 1)
    assert.equal(f.driver.members.length, 2)
    assert.deepEqual(run.agents.map((agent) => agent.kind), ['session', 'member', 'member'])
    assert.match(f.driver.members[0].subagentName, /^[a-z][a-z0-9-]*$/)
    for (const prompt of f.driver.prompts) assert.match(prompt.text, /DO NOT EDIT/i)
    const planTexts = f.driver.prompts.map((prompt) => prompt.text)
    assert.ok(
      planTexts.some((text) => /send_message/.test(text) && /list_agents/.test(text)),
      'the planning turn explains how to talk to the team',
    )
    assert.ok(planTexts.every((text) => !/does not reach the other agents/.test(text)))

    const vega = f.driver.created[0]
    assert.equal(vega.parentSessionId, 's1', 'the lead is a child of the chat Session')
    const [orion, lyra] = f.driver.members
    await f.driver.emit(vega, { kind: 'assistant', text: 'I will take the source file.\nOWNERSHIP: src/app.js' })
    await f.driver.emit(vega, { kind: 'turn-end' })
    assert.equal(f.engine.listRuns('s1')[0].status, 'planning', 'still planning while peers have not answered')
    await f.driver.emit(orion, { kind: 'assistant', text: 'OWNERSHIP: README.md' })
    await f.driver.emit(orion, { kind: 'turn-end' })
    await f.driver.emit(lyra, { kind: 'assistant', text: 'OWNERSHIP: docs/**' })
    await f.driver.emit(lyra, { kind: 'turn-end' })

    const running = f.engine.listRuns('s1')[0]
    assert.equal(running.status, 'running')
    assert.deepEqual(running.agents.map((agent) => agent.claimed), [['src/app.js'], ['README.md'], ['docs/**']])
    const goPrompts = f.driver.prompts.slice(3)
    assert.equal(goPrompts.length, 3)
    assert.ok(goPrompts.some((prompt) => /src\/app\.js/.test(prompt.text)))
    assert.ok(goPrompts.every((prompt) => /send_message/.test(prompt.text)), 'the go-ahead keeps the team reachable')
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    const plan = feed.events.find((event) => event.kind === 'plan')
    assert.ok(plan, 'the division is announced in the shared feed')
    assert.match(plan.text, /Vega: src\/app\.js/)

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo three\n')
    for (const handle of f.driver.all()) {
      await f.driver.emit(handle, { kind: 'turn-end' })
    }
    const waiting = f.engine.listRuns('s1')[0]
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.changeCount, 2)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('swarm contested files: first claimant keeps the area and the feed says so', async () => {
  const f = await fixture('contested')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'both edit the same file' })
    const vega = f.driver.created[0]
    const [orion, lyra] = f.driver.members
    await f.driver.emit(vega, { kind: 'assistant', text: 'OWNERSHIP: src/app.js' })
    await f.driver.emit(orion, { kind: 'assistant', text: 'OWNERSHIP: src/app.js' })
    await f.driver.emit(lyra, { kind: 'assistant', text: 'OWNERSHIP: README.md' })
    for (const handle of f.driver.all()) await f.driver.emit(handle, { kind: 'turn-end' })
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    const plan = feed.events.find((event) => event.kind === 'plan')
    assert.match(plan.text, /Contested/)
    assert.match(plan.text, /Orion claimed it, Vega keeps it/)
    const phase = f.engine.listRuns('s1')[0].phase
    assert.match(phase, /^Work divided\./)
    assert.ok(phase.length <= 120, 'the plan phase is truncated to the rail line')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('swarm planning hands unclaimed files to the agents that lost the claim', async () => {
  const f = await fixture('swarm-grant')
  try {
    await fs.writeFile(path.join(f.projectPath, 'docs.md'), '# Docs\n')
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'everyone wants the same file' })
    for (const handle of f.driver.all()) {
      await f.driver.emit(handle, { kind: 'assistant', text: 'OWNERSHIP: src/app.js' })
      await f.driver.emit(handle, { kind: 'turn-end' })
    }
    const running = f.engine.listRuns('s1')[0]
    assert.equal(running.status, 'running')
    assert.deepEqual(running.agents.map((agent) => agent.claimed), [['src/app.js'], ['README.md'], ['docs.md']])
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    const plan = feed.events.find((event) => event.kind === 'plan')
    assert.match(plan.text, /Orion: README\.md \(nobody claimed it\)/)
    assert.match(plan.text, /Lyra: docs\.md \(nobody claimed it\)/)
    const goPrompts = f.driver.prompts.slice(3).map((prompt) => prompt.text)
    assert.ok(goPrompts.some((text) => /Your area: README\.md/.test(text)))
    assert.ok(goPrompts.some((text) => /Your area: docs\.md/.test(text)))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('planning falls back to a top-level split when nobody announces ownership', async () => {
  const f = await fixture('fallback')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'no ownership lines' })
    for (let round = 0; round < 2; round += 1) {
      for (const handle of f.driver.all()) {
        await f.driver.emit(handle, { kind: 'assistant', text: 'Working on it.' })
        await f.driver.emit(handle, { kind: 'turn-end' })
      }
    }
    const running = f.engine.listRuns('s1')[0]
    assert.equal(running.status, 'running')
    assert.ok(running.agents.some((agent) => agent.claimed.length > 0), 'somebody owns something after the fallback')
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => /split the top level/.test(event.text ?? '')))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('message wakes idle agents, interrupt stops them, discard removes the copy', async () => {
  const f = await fixture('messages')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'change it' })
    const handle = f.driver.created[0]
    await f.driver.emit(handle, { kind: 'turn-end' })
    assert.equal(f.engine.listRuns('s1')[0].status, 'waiting')

    await f.engine.message(run.id, { text: 'Also rename the constant.' })
    assert.equal(f.engine.listRuns('s1')[0].status, 'running')
    assert.match(f.driver.prompts.at(-1).text, /Also rename the constant/)
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => event.kind === 'user'))

    const interrupted = await f.engine.interrupt(run.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.deepEqual(f.driver.interrupted, [handle.name])

    await f.engine.discard(run.id)
    assert.equal(f.engine.listRuns('s1')[0].status, 'discarded')
    await assert.rejects(() => fs.stat(run.copyPath), /ENOENT/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('stopping a run publishes the diff count the review panel will list', async () => {
  const f = await fixture('interrupt-count')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'change both files' })
    const handle = f.driver.created[0]
    assert.equal(handle.parentSessionId, 's1', 'the chat Session is the parent the agent inherits policy from')
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo v2\n')

    const interrupted = await f.engine.interrupt(run.id)
    assert.equal(interrupted.status, 'interrupted')
    assert.equal(interrupted.changeCount, 2, 'a stopped run still shows what the user can review')
    assert.equal((await f.engine.changes(run.id)).length, 2)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a failed start keeps the changes it already has', async () => {
  const f = await fixture('failed-count')
  try {
    f.driver.failPrompt = true
    // The first prompt is delivered only after the copy exists, so the hook can
    // put a real edit on disk before the host refuses the turn.
    f.driver.onPrompt = async (handle) => {
      await fs.writeFile(path.join(handle.copyPath, 'README.md'), '# Demo failed\n')
    }
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'fail after the copy' }),
      (error) => error instanceof ArtelError && error.code === 'artel/agent-failed',
    )
    const failed = f.engine.listRuns('s1')[0]
    assert.equal(failed.status, 'failed')
    assert.equal(failed.changeCount, 1, 'the terminal summary counts the copy diff')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('dispose counts the diff before interrupting the run', async () => {
  const f = await fixture('dispose-count')
  const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'stop the plugin' })
  try {
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 9\n')
    await f.engine.dispose()
    const stopped = f.store.get(run.id)
    assert.equal(stopped.status, 'interrupted')
    assert.equal(stopped.changeCount, 1)
  } finally {
    await f.cleanup()
  }
})

test('one active run per session', async () => {
  const f = await fixture('busy')
  try {
    await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'first' })
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'second' }),
      (error) => error instanceof ArtelError && error.code === 'artel/busy',
    )
    // Another session may run concurrently.
    const other = await f.engine.start({ sessionId: 's2', projectPath: f.projectPath, mode: 'solo', task: 'other session' })
    assert.equal(other.status, 'running')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('an edit outside the claimed area is reported as a collision in the feed', async () => {
  const f = await fixture('collision')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'two areas' })
    const vega = f.driver.created[0]
    const [orion, lyra] = f.driver.members
    await f.driver.emit(vega, { kind: 'assistant', text: 'OWNERSHIP: src/app.js' })
    await f.driver.emit(orion, { kind: 'assistant', text: 'OWNERSHIP: README.md' })
    await f.driver.emit(lyra, { kind: 'assistant', text: 'OWNERSHIP: docs/**' })
    for (const handle of f.driver.all()) await f.driver.emit(handle, { kind: 'turn-end' })

    await f.driver.emit(vega, { kind: 'tool', tool: 'edit', path: 'src/app.js' })
    await f.driver.emit(orion, { kind: 'tool', tool: 'edit', path: 'src/app.js' })
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    const collision = feed.events.find((event) => event.kind === 'collision')
    assert.ok(collision, 'the shared feed shows the clash')
    assert.match(collision.text, /src\/app\.js/)
    assert.match(collision.text, /Vega/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a message between swarm agents shows up in the shared feed', async () => {
  const f = await fixture('swarm-peer')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'talk it through' })
    const vega = f.driver.created[0]
    const [orion] = f.driver.members
    await f.driver.emit(vega, {
      kind: 'peer',
      senderSessionId: orion.sessionId,
      text: 'I am taking README.md — the install section is stale.',
    })
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    const peer = feed.events.find((event) => event.kind === 'peer')
    assert.ok(peer, 'the feed shows agent-to-agent traffic')
    assert.equal(peer.from, 'Orion')
    assert.equal(peer.agent, 'Vega')
    assert.match(peer.text, /install section is stale/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a peer message that wakes an idle agent puts the run back to work', async () => {
  const f = await fixture('swarm-wake')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'talk and edit' })
    for (const handle of f.driver.all()) {
      await f.driver.emit(handle, { kind: 'assistant', text: `OWNERSHIP: ${handle === f.driver.created[0] ? 'src/app.js' : 'README.md'}` })
      await f.driver.emit(handle, { kind: 'turn-end' })
    }
    assert.equal(f.engine.listRuns('s1')[0].status, 'running')
    for (const handle of f.driver.all()) await f.driver.emit(handle, { kind: 'turn-end' })
    assert.equal(f.engine.listRuns('s1')[0].status, 'waiting')

    const vega = f.driver.created[0]
    const [orion] = f.driver.members
    await f.driver.emit(vega, { kind: 'peer', senderSessionId: orion.sessionId, text: 'One question about src/app.js.' })
    await f.driver.emit(vega, { kind: 'turn-start' })
    const awake = f.engine.listRuns('s1')[0]
    assert.equal(awake.status, 'running', 'the run is not "finished" while teammates still talk')
    assert.equal(awake.agents[0].status, 'working')
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => /still working/.test(event.text ?? '')))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('swarm without the subagent stack falls back to separate sessions', async () => {
  const f = await fixture('legacy', {}, { peers: false })
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'legacy transport' })
    assert.equal(f.driver.created.length, 3)
    assert.equal(f.driver.members.length, 0)
    assert.deepEqual(run.agents.map((agent) => agent.kind), ['session', 'session', 'session'])
    assert.ok(f.driver.prompts.every((prompt) => /DO NOT EDIT/i.test(prompt.text)))
    assert.ok(f.driver.prompts.some((prompt) => /Do not try to reach the other agents/.test(prompt.text)))
    for (const handle of f.driver.created) {
      await f.driver.emit(handle, { kind: 'assistant', text: 'OWNERSHIP: src/app.js' })
      await f.driver.emit(handle, { kind: 'turn-end' })
    }
    const running = f.engine.listRuns('s1')[0]
    assert.equal(running.status, 'running')
    assert.ok(f.driver.prompts.some((prompt) => /send_message does not reach/.test(prompt.text)))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('runs beyond maxRunsPerSession are pruned with their copies', async () => {
  const f = await fixture('prune', { maxRunsPerSession: 1 })
  try {
    const first = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'first' })
    await f.engine.interrupt(first.id)
    const firstCopy = first.copyPath
    await fs.stat(firstCopy)

    const second = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'second' })
    const kept = await f.store.list('s1')
    assert.deepEqual(kept.map((run) => run.id), [second.id])
    await assert.rejects(fs.stat(firstCopy), 'the pruned copy is deleted from disk')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a run starts on the chosen provider, model and reasoning effort', async () => {
  const f = await fixture('model-start')
  try {
    const model = { provider: 'test', model: 'slow' }
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'route me', model })
    assert.deepEqual(run.agents[0].model, model, 'the summary reports the route')
    assert.deepEqual(f.driver.created[0].model, model, 'the agent handle carries the route')
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => event.kind === 'status' && /runs on Test\/Slow/.test(event.text)))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a run refuses a model or effort the profile does not advertise', async () => {
  const f = await fixture('model-refuse')
  try {
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'x', model: { provider: 'test', model: 'nope' } }),
      (error) => error instanceof ArtelError && error.code === 'artel/model-unavailable',
    )
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'x', model: { provider: 'test', model: 'slow', reasoningEffort: 'high' } }),
      (error) => error instanceof ArtelError && /does not offer/.test(error.message),
    )
    assert.equal(f.driver.created.length, 0, 'nothing starts when the route is refused')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('every swarm member starts on the chosen route', async () => {
  const f = await fixture('model-swarm')
  try {
    const model = { provider: 'test', model: 'fast', reasoningEffort: 'high' }
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'split', model })
    assert.equal(run.agents.length, 3)
    for (const agent of run.agents) assert.deepEqual(agent.model, model)
    assert.ok(f.driver.created.every((handle) => handle.model !== undefined))
    assert.ok(f.driver.members.every((handle) => handle.model !== undefined))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('one live agent can be rerouted without touching the others', async () => {
  const f = await fixture('model-reroute')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'swarm', task: 'split' })
    const target = run.agents[1]
    const model = { provider: 'test', model: 'slow' }
    const patched = await f.engine.setAgentModel(run.id, target.id, model)
    assert.deepEqual(patched.agents[1].model, model)
    assert.equal(patched.agents[0].model, null, 'the other agents keep their route')
    assert.deepEqual(f.driver.selections.at(-1), { agent: target.name, selection: model })
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => event.kind === 'status' && /now runs on Test\/Slow/.test(event.text)))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('rerouting validates the agent, the route and the run status', async () => {
  const f = await fixture('model-errors')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'x' })
    await assert.rejects(
      () => f.engine.setAgentModel(run.id, 'nope', { provider: 'test', model: 'slow' }),
      (error) => error instanceof ArtelError && error.status === 404,
    )
    await assert.rejects(
      () => f.engine.setAgentModel(run.id, run.agents[0].id, { provider: 'test', model: 'nope' }),
      (error) => error instanceof ArtelError && error.code === 'artel/model-unavailable',
    )
    await f.engine.interrupt(run.id)
    const discarded = await f.engine.discard(run.id)
    assert.equal(discarded.status, 'discarded')
    await assert.rejects(
      () => f.engine.setAgentModel(run.id, run.agents[0].id, { provider: 'test', model: 'slow' }),
      (error) => error instanceof ArtelError && error.status === 409,
    )
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the models route exposes the profile catalog', async () => {
  const f = await fixture('model-catalog')
  try {
    const catalog = await f.engine.models()
    assert.equal(catalog.providers[0].id, 'test')
    assert.deepEqual(catalog.default, { provider: 'test', model: 'fast', reasoningEffort: 'low' })
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

/* ---------------------------------------------------------------- conductor */

/** Start a conductor run in the fixture's project. */
async function startConductor(f, task = 'Rework the demo app') {
  return f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'conductor', task })
}

/** The latest run summary of the fixture's single session. */
function latestRun(f) {
  return f.engine.listRuns('s1')[0]
}

/** Every feed event of one run. */
async function feedOf(f, runId) {
  const feed = await f.engine.readFeed(runId, { cursor: 0 })
  return feed.events
}

/** Emit one full assistant turn (start, optional text, end) on a fake agent. */
async function runTurn(driver, handle, text) {
  await driver.emit(handle, { kind: 'turn-start' })
  if (text !== undefined) await driver.emit(handle, { kind: 'assistant', text })
  await driver.emit(handle, { kind: 'turn-end' })
}

/**
 * Drive a conductor run to the working stage: the three workers announce their
 * files, the conductor ends its plan turn and approves the proposal.
 */
async function conductorWorking(f) {
  const run = await startConductor(f)
  const conductor = f.driver.created[0]
  const workers = f.driver.members
  await runTurn(f.driver, workers[0], 'OWNERSHIP: src/app.js')
  await runTurn(f.driver, workers[1], 'OWNERSHIP: README.md')
  await runTurn(f.driver, workers[2], 'OWNERSHIP: docs/**')
  await runTurn(f.driver, conductor, 'I am leading this team.')
  const proposal = (await feedOf(f, run.id)).find((event) => event.kind === 'plan')
  assert.ok(proposal, 'the proposal is published before the decision')
  assert.match(proposal.text, /^Proposed shares \(the conductor decides\):/)
  await runTurn(f.driver, conductor, 'SHARES: approve')
  assert.equal(latestRun(f).status, 'running', 'the team is working after the decision')
  return { runId: run.id, conductor, workers }
}

test('conductor start: one session leads three worker members in planning', async () => {
  const f = await fixture('conductor-start')
  try {
    const run = await startConductor(f)
    assert.equal(run.mode, 'conductor')
    assert.equal(run.status, 'planning')
    assert.equal(run.agents.length, 4)
    assert.deepEqual(run.agents.map((agent) => agent.role), ['conductor', 'worker', 'worker', 'worker'])
    assert.deepEqual(run.agents.map((agent) => agent.kind), ['session', 'member', 'member', 'member'])
    assert.equal(f.driver.created.length, 1)
    assert.equal(f.driver.members.length, 3)
    assert.deepEqual(f.driver.members.map((handle) => handle.subagentName), ['orion', 'lyra', 'atlas'])
    assert.equal(f.driver.created[0].parentSessionId, 's1', 'the conductor is a child of the chat Session')

    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'The conductor Vega and 3 agents are reading the project. The team proposes who takes which files, the conductor approves the shares; nothing is edited in this step.'))

    // Every worker planning turn asks for its OWNERSHIP line; the conductor's
    // prompt is delivered last, once the whole team exists.
    const spawnPrompts = f.driver.prompts.filter((prompt) => prompt.kind === 'spawn')
    assert.equal(spawnPrompts.length, 3)
    assert.ok(spawnPrompts.every((prompt) => /OWNERSHIP:/.test(prompt.text)))
    assert.equal(f.driver.prompts.length, 4)
    assert.equal(f.driver.prompts[3].agent, 'Vega')
    assert.match(f.driver.prompts[3].text, /Rework the demo app/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('conductor decides the shares and sends the workers to work', async () => {
  const f = await fixture('conductor-decide')
  try {
    const run = await startConductor(f)
    const conductor = f.driver.created[0]
    const [orion, lyra, atlas] = f.driver.members
    await runTurn(f.driver, orion, 'OWNERSHIP: src/app.js')
    await runTurn(f.driver, lyra, 'OWNERSHIP: README.md')
    await runTurn(f.driver, atlas, 'OWNERSHIP: docs/**')
    await runTurn(f.driver, conductor, 'I am leading this team.')

    const proposal = (await feedOf(f, run.id)).find((event) => event.kind === 'plan')
    assert.match(proposal.text, /^Proposed shares \(the conductor decides\):\n/)
    assert.match(proposal.text, /- Orion: src\/app\.js/)
    assert.match(proposal.text, /- Lyra: README\.md/)

    await runTurn(f.driver, conductor, 'SHARES:\nSHARES: Orion = src/app.js\nSHARES: Lyra = README.md\nSHARES: Atlas = docs/other.js')

    const running = latestRun(f)
    assert.equal(running.status, 'running')
    assert.deepEqual(running.agents.map((agent) => agent.claimed), [[], ['src/app.js'], ['README.md'], ['docs/other.js']])
    assert.deepEqual(running.agents.map((agent) => agent.role), ['conductor', 'worker', 'worker', 'worker'])
    assert.equal(running.agents[0].status, 'idle')

    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'plan' && /^The shares are handed out\. No edits yet\.\n- Orion: src\/app\.js/.test(event.text)))
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'The files are being edited in parallel. Your project stays untouched until you apply.'))
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'nothing reaches the project during work')

    const goPrompts = f.driver.prompts.slice(5)
    assert.equal(goPrompts.length, 3)
    assert.deepEqual(goPrompts.map((prompt) => prompt.agent).sort(), ['Atlas', 'Lyra', 'Orion'])
    assert.ok(goPrompts.every((prompt) => prompt.kind === 'member'))
    assert.ok(goPrompts.some((prompt) => /src\/app\.js/.test(prompt.text)))
    assert.ok(goPrompts.some((prompt) => /docs\/other\.js/.test(prompt.text)))
    assert.match(running.phase.length <= 120 ? running.phase : '', /.+/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('conductor can approve the proposal as it is', async () => {
  const f = await fixture('conductor-approve')
  try {
    const run = await startConductor(f)
    const conductor = f.driver.created[0]
    const [orion, lyra, atlas] = f.driver.members
    await runTurn(f.driver, orion, 'OWNERSHIP: src/app.js')
    await runTurn(f.driver, lyra, 'OWNERSHIP: README.md')
    await runTurn(f.driver, atlas, 'OWNERSHIP: docs/**')
    await runTurn(f.driver, conductor, 'I am leading this team.')
    await runTurn(f.driver, conductor, 'SHARES: approve')

    const running = latestRun(f)
    assert.equal(running.status, 'running')
    assert.deepEqual(running.agents.map((agent) => agent.claimed), [[], ['src/app.js'], ['README.md'], ['docs/**']])
    const handed = (await feedOf(f, run.id)).filter((event) => event.kind === 'plan').at(-1)
    assert.equal(handed.text, 'The shares are handed out. No edits yet.\n- Orion: src/app.js\n- Lyra: README.md\n- Atlas: docs/**')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('conductor rework: named shares get one more pass, twice at most', async () => {
  const f = await fixture('conductor-rework')
  try {
    const { runId, conductor, workers } = await conductorWorking(f)
    const run = latestRun(f)
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo three\n')
    for (const worker of workers) await f.driver.emit(worker, { kind: 'turn-end' })

    let feed = await feedOf(f, runId)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'Every agent is idle. The conductor is reviewing the whole copy.'))
    assert.equal(f.driver.prompts.at(-1).agent, 'Vega', 'the conductor reviews the copy')

    let before = f.driver.prompts.length
    await runTurn(f.driver, conductor, 'VERDICT: rework\nREWORK: Orion\nThe answer must stay 2.')
    feed = await feedOf(f, runId)
    const round1 = feed.find((event) => event.kind === 'plan' && event.text.startsWith('Rework round 1 of 2.'))
    assert.ok(round1, 'the first rework round is announced')
    assert.match(round1.text, /Back for rework: Orion/)
    assert.match(round1.text, /Accepted for now: Lyra, Atlas/)
    assert.match(round1.text, /Remarks: The answer must stay 2\./)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'Orion is back for rework; the other shares are accepted for now.'))
    const round1Prompts = f.driver.prompts.slice(before)
    assert.equal(round1Prompts.length, 1, 'only the named worker is woken')
    assert.equal(round1Prompts[0].agent, 'Orion')
    assert.match(round1Prompts[0].text, /The answer must stay 2/)
    assert.equal(latestRun(f).agents[1].status, 'working')

    await f.driver.emit(f.driver.handleFor('Orion'), { kind: 'turn-end' })
    assert.equal(f.driver.prompts.at(-1).agent, 'Vega', 'the conductor reviews round two')
    before = f.driver.prompts.length
    await runTurn(f.driver, conductor, 'VERDICT: rework\nREWORK: Lyra\nFix the readme title.')
    feed = await feedOf(f, runId)
    const round2 = feed.find((event) => event.kind === 'plan' && event.text.startsWith('Rework round 2 of 2.'))
    assert.ok(round2, 'the second rework round is announced')
    assert.match(round2.text, /Back for rework: Lyra/)
    assert.match(round2.text, /Accepted for now: Orion, Atlas/)
    const round2Prompts = f.driver.prompts.slice(before)
    assert.equal(round2Prompts.length, 1)
    assert.equal(round2Prompts[0].agent, 'Lyra')

    await f.driver.emit(f.driver.handleFor('Lyra'), { kind: 'turn-end' })
    assert.equal(f.driver.prompts.at(-1).agent, 'Vega', 'the conductor reviews round three')
    before = f.driver.prompts.length
    await runTurn(f.driver, conductor, 'VERDICT: rework\nREWORK: Atlas\nOne more pass.')
    const coerced = latestRun(f)
    assert.equal(coerced.status, 'waiting')
    assert.equal(coerced.changeCount, 2)
    feed = await feedOf(f, runId)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'The conductor asked for another pass, but the two-round limit is reached. The work goes to you with its remarks.'))
    assert.ok(feed.some((event) => event.kind === 'plan' && event.text === 'The conductor accepted the work.\nOne more pass.'))
    assert.equal(f.driver.prompts.slice(before).length, 0, 'the third request is coerced, nobody is woken')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('conductor acceptance publishes the whole copy for the user', async () => {
  const f = await fixture('conductor-accept')
  try {
    const { runId, conductor, workers } = await conductorWorking(f)
    const run = latestRun(f)
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo two\n')
    for (const worker of workers) await f.driver.emit(worker, { kind: 'turn-end' })
    await runTurn(f.driver, conductor, 'VERDICT: accept\nAll checks pass.')

    const waiting = latestRun(f)
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.changeCount, 2)
    assert.ok(waiting.agents.every((agent) => agent.status === 'idle'), 'the whole team is idle after the verdict')
    const feed = await feedOf(f, runId)
    assert.ok(feed.some((event) => event.kind === 'plan' && event.text === 'The conductor accepted the work.\nAll checks pass.'))
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'The checks ran on the whole copy and the conductor accepted the result. The decision is yours.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a message after the verdict wakes the team and the conductor reviews it again', async () => {
  const f = await fixture('conductor-after-accept')
  try {
    const { runId, conductor, workers } = await conductorWorking(f)
    const run = latestRun(f)
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    for (const worker of workers) await f.driver.emit(worker, { kind: 'turn-end' })
    await runTurn(f.driver, conductor, 'VERDICT: accept\nAll checks pass.')
    assert.equal(latestRun(f).status, 'waiting')

    // The user asks for more after the acceptance: the team goes back to work and
    // the run must become reviewable again instead of hanging in "running".
    const woken = await f.engine.message(runId, { text: 'Please also rename the demo title.' })
    assert.equal(woken.status, 'running')
    await fs.writeFile(path.join(run.copyPath, 'README.md'), '# Demo three\n')
    for (const worker of workers) {
      await f.driver.emit(worker, { kind: 'turn-start' })
      await f.driver.emit(worker, { kind: 'turn-end' })
    }
    await runTurn(f.driver, conductor, '')

    const reviewed = await feedOf(f, runId)
    assert.ok(reviewed.some((event) => event.kind === 'status' && event.text === 'Every agent is idle. The conductor is reviewing the whole copy.'), 'the conductor reviews the extra work')
    assert.equal(f.driver.prompts.at(-1).agent, 'Vega', 'the review prompt goes to the conductor')

    await runTurn(f.driver, conductor, 'VERDICT: accept\nAll good now.')
    const accepted = latestRun(f)
    assert.equal(accepted.status, 'waiting', 'the run is reviewable again after the extra work')
    assert.equal(accepted.changeCount, 2)
    const feed = await feedOf(f, runId)
    assert.ok(feed.some((event) => event.kind === 'plan' && event.text === 'The conductor accepted the work.\nAll good now.'))

    const applied = await f.engine.apply(runId)
    assert.equal(applied.applied.length, 2)
    assert.ok(applied.applied.includes('README.md'))
    assert.ok(applied.applied.includes('src/app.js'))
    assert.equal(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8'), '# Demo three\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a failed conductor worker hands its share to the teammate the conductor picks', async () => {
  const f = await fixture('conductor-handover')
  try {
    const run = await startConductor(f)
    const conductor = f.driver.created[0]
    const [orion, lyra, atlas] = f.driver.members
    await runTurn(f.driver, orion, 'OWNERSHIP: src/app.js')
    await runTurn(f.driver, lyra, 'OWNERSHIP: README.md')
    await runTurn(f.driver, atlas, 'OWNERSHIP: docs/**')
    await runTurn(f.driver, conductor, 'I am leading this team.')
    await runTurn(f.driver, conductor, 'SHARES: approve')

    await f.driver.emit(orion, { kind: 'turn-start' })
    await f.driver.emit(orion, { kind: 'assistant', text: 'Editing src/app.js.' })
    await f.driver.emit(orion, { kind: 'turn-end', reason: { kind: 'error' } })

    let feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'error' && event.text === 'Orion stopped (error). The conductor is moving that share.'))
    assert.equal(latestRun(f).status, 'running', 'the team continues without the fallen worker')
    assert.equal(latestRun(f).agents[1].status, 'failed')
    assert.deepEqual(latestRun(f).agents[1].claimed, ['src/app.js'])
    assert.equal(f.driver.prompts.at(-1).agent, 'Vega', 'the conductor is asked to move the share')
    assert.match(f.driver.prompts.at(-1).text, /Orion/)
    assert.match(f.driver.prompts.at(-1).text, /src\/app\.js/)

    const before = f.driver.prompts.length
    await runTurn(f.driver, conductor, 'SHARES: Lyra = src/app.js')
    feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'plan' && event.text === "The conductor moved Orion's share to Lyra.\nsrc/app.js"))
    const receiverPrompts = f.driver.prompts.slice(before)
    assert.equal(receiverPrompts.length, 1)
    assert.equal(receiverPrompts[0].agent, 'Lyra')
    assert.match(receiverPrompts[0].text, /src\/app\.js/)
    const handed = latestRun(f)
    assert.deepEqual(handed.agents[1].claimed, [])
    assert.equal(handed.agents[1].status, 'failed')
    assert.deepEqual(handed.agents[2].claimed, ['README.md', 'src/app.js'])

    await f.driver.emit(f.driver.handleFor('Lyra'), { kind: 'turn-end' })
    await f.driver.emit(f.driver.handleFor('Atlas'), { kind: 'turn-end' })
    feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'Every agent is idle. The conductor is reviewing the whole copy.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a failed conductor fails the whole conductor run', async () => {
  const f = await fixture('conductor-failure')
  try {
    const run = await startConductor(f)
    const conductor = f.driver.created[0]
    await f.driver.emit(conductor, { kind: 'turn-start' })
    await f.driver.emit(conductor, { kind: 'turn-end', reason: { kind: 'error' } })

    const failed = latestRun(f)
    assert.equal(failed.status, 'failed')
    assert.equal(f.store.get(run.id).error, 'The conductor Vega failed, so the work could not be accepted. The changes are still available in the diff.')
    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'error' && event.text === 'The conductor Vega failed, so the work could not be accepted. The changes are still available in the diff.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('conductor mode needs the subagent stack and fails before copying', async () => {
  const f = await fixture('conductor-peers', {}, { peers: false })
  try {
    await assert.rejects(
      () => startConductor(f),
      (error) => error instanceof ArtelError && error.status === 400 && error.code === 'artel/peers-required' && /subagent stack/.test(error.message),
    )
    assert.equal(f.driver.created.length, 0)
    assert.equal(f.driver.members.length, 0)
    assert.deepEqual(f.engine.listRuns('s1'), [])
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'no copy is created without the peers stack')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('message is refused while the conductor is deciding', async () => {
  const f = await fixture('conductor-message')
  try {
    const run = await startConductor(f)
    const conductor = f.driver.created[0]
    const [orion, lyra, atlas] = f.driver.members
    await runTurn(f.driver, orion, 'OWNERSHIP: src/app.js')
    await runTurn(f.driver, lyra, 'OWNERSHIP: README.md')
    await runTurn(f.driver, atlas, 'OWNERSHIP: docs/**')
    await runTurn(f.driver, conductor, 'I am leading this team.')

    const reviewing = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/reviewing'
    await assert.rejects(() => f.engine.message(run.id, { text: 'hurry up' }), reviewing, 'the conductor is deciding the shares')

    await runTurn(f.driver, conductor, 'SHARES: approve')
    for (const worker of f.driver.members) await f.driver.emit(worker, { kind: 'turn-end' })
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && /conductor is reviewing/.test(event.text)))
    await assert.rejects(() => f.engine.message(run.id, { text: 'hurry up' }), reviewing, 'the conductor is reviewing the copy')
    assert.equal(latestRun(f).status, 'running')

    const stopped = await f.engine.interrupt(run.id)
    assert.equal(stopped.status, 'interrupted')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})
