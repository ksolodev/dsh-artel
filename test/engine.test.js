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

  supportsPeers() {
    return this.peers
  }

  async createAgent({ name, mode, projectPath, copyPath, agentId, parentSessionId }) {
    const handle = {
      id: agentId,
      kind: 'session',
      sessionId: `session-${this.created.length + 1}`,
      name,
      mode,
      projectPath,
      copyPath,
      parentSessionId,
      listeners: new Set(),
    }
    this.created.push(handle)
    return handle
  }

  async spawnMember({ parent, name, displayName, label, promptText, copyPath, projectPath, agentId, mode }) {
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
