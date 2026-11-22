import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ArtelEngine, ArtelError } from '../lib/engine.js'
import { RunStore } from '../lib/run-store.js'
import { projectKeyOf } from '../lib/project-key.js'
import { ArtelGit } from '../lib/git.js'
import { hashTree } from '../lib/copy.js'

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
  /** Live Host numbers per agent session, keyed like the real driver. */
  stats = new Map()
  /** Set to false to model a profile without the plugin manager. */
  bundleInstall = true
  /** Projects the engine asked the plugin manager to install. */
  bundleInstalls = []
  /** What the fake plugin manager answers, or the Error it throws. */
  bundleResult = { changed: true, application: 'restart-required', stage: 'install', target: '', restartReason: 'no-hmr' }
  /** Set to false to model a profile without the Workspace registry. */
  projectChats = true
  /** Task chats the engine asked for, in start order. */
  taskChats = []
  /** Runs the engine handed to `restoreProjectChats`. */
  restoredRuns = null
  /** Set to true to model a project folder that is not an open Workspace. */
  noWorkspace = false
  /** Makes `createTaskChat` throw, like a host that refuses a new chat. */
  taskChatError = null

  supportsPeers() {
    return this.peers
  }

  supportsProjectChats() {
    return this.projectChats
  }

  async createTaskChat({ projectPath, task, sandboxMode = 'read-only' }) {
    if (this.taskChatError !== null) throw this.taskChatError
    if (this.noWorkspace === true) return null
    const sessionId = `session-task-${this.taskChats.length + 1}`
    this.taskChats.push({ sessionId, projectPath, task, sandboxMode })
    return { sessionId, workspaceId: 'ws-1', title: `Artel · ${task}` }
  }

  async restoreProjectChats(runs) {
    const eligible = (Array.isArray(runs) ? runs : []).filter((run) => run?.projectChats === true)
    this.restoredRuns = eligible
    return { attached: eligible.length, skipped: 0, failed: 0 }
  }

  async listModels() {
    return this.models
  }

  /** What the real driver reads from the Host token meter and the usage reports. */
  statsOf(handle) {
    return this.stats.get(handle.sessionId) ?? { context: null, usage: null }
  }

  async selectModel(handle, selection) {
    this.selections.push({ agent: handle.name, selection })
    handle.model = selection
    return selection
  }

  supportsBundleInstall() {
    return this.bundleInstall
  }

  async installBundle(projectPath) {
    this.bundleInstalls.push(projectPath)
    if (this.bundleResult instanceof Error) throw this.bundleResult
    return this.bundleResult
  }

  async createAgent({ name, mode, projectPath, copyPath, agentId, parentSessionId, model, sandboxMode }) {
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
      sandboxMode,
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

    const firstStatus = feed.events.find((event) => event.kind === 'status')
    const projectName = path.basename(f.projectPath)
    assert.equal(firstStatus.key, 'feed.copy.preparing')
    assert.deepEqual(firstStatus.params, { project: projectName })
    assert.equal(firstStatus.text, `Preparing a copy of ${projectName}.`)
    const legacyEvent = feed.events.find((event) => event.kind === 'assistant')
    assert.equal(legacyEvent.key, undefined, 'an agent-authored event carries no host key')
    assert.equal(legacyEvent.text, 'Reading src/app.js and the README.')
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
    assert.equal(applied.phaseKey, 'feed.change.applied-one', 'the phase row carries the key its line came from')
    assert.deepEqual(applied.phaseParams, {})
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the run keeps the tokens it spent after its live agents are released', async () => {
  const f = await fixture('spend-kept')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const handle = f.driver.created[0]
    f.driver.stats.set(handle.sessionId, {
      context: null,
      usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 100, totalTokens: 1_200, requests: 1 },
    })

    await f.engine.discard(run.id)
    const summary = f.engine.getRun(run.id)
    assert.equal(summary.status, 'discarded')
    assert.deepEqual(summary.spend, {
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 100,
      cacheWriteTokens: 100,
      totalTokens: 1_200,
      requests: 1,
    }, 'the token tag survives the Released agents')
    assert.equal(f.engine.listRuns('s1')[0].spend.totalTokens, 1_200, 'the saved record carries the counters across a restart')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the run summary says what each agent is doing and what the run waits for', async () => {
  const f = await fixture('live-view')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const handle = f.driver.created[0]

    let summary = f.engine.getRun(run.id)
    assert.equal(summary.agents[0].activity, null, 'a fresh agent has done nothing yet')
    assert.equal(summary.agents[0].turns, 0)
    assert.deepEqual(
      { kind: summary.waitingFor.kind, names: summary.waitingFor.names },
      { kind: 'agents', names: ['Vega'] },
      'a starting agent is what the run waits on',
    )
    assert.equal(summary.spend, null, 'no provider usage yet, so no spend is invented')

    f.driver.stats.set(handle.sessionId, {
      context: { tokens: 40_000, window: 128_000, breakdown: { system: 900, tools: 2_500, messages: 6_000 }, at: 1 },
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_200, requests: 1 },
    })
    await f.driver.emit(handle, { kind: 'turn-start' })
    summary = f.engine.getRun(run.id)
    assert.equal(summary.agents[0].status, 'working')
    assert.equal(summary.agents[0].turns, 1)
    assert.equal(typeof summary.agents[0].turnStartedAt, 'number')
    assert.equal(summary.agents[0].stats.context.tokens, 40_000)
    assert.deepEqual(summary.agents[0].stats.context.breakdown, { system: 900, tools: 2_500, messages: 6_000 })
    assert.equal(summary.spend.totalTokens, 1_200, 'the run spend is the sum of what the provider billed')
    assert.equal(summary.spend.requests, 1)
    assert.deepEqual(summary.waitingFor.names, ['Vega'], 'the open turn is what the user is waiting on')
    assert.equal(summary.waitingFor.kind, 'agents')

    await f.driver.emit(handle, { kind: 'tool', tool: 'write', text: 'write src/app.js', path: 'src/app.js' })
    summary = f.engine.getRun(run.id)
    assert.deepEqual(summary.agents[0].activity, {
      kind: 'tool',
      tool: 'write',
      text: 'write src/app.js',
      at: summary.agents[0].activity.at,
    })

    await f.driver.emit(handle, { kind: 'assistant', text: 'Now the README.' })
    summary = f.engine.getRun(run.id)
    assert.deepEqual(summary.agents[0].activity, {
      kind: 'assistant',
      text: 'Now the README.',
      at: summary.agents[0].activity.at,
    })

    await f.driver.emit(handle, { kind: 'turn-end' })
    summary = f.engine.getRun(run.id)
    assert.equal(summary.agents[0].activity, null, 'an idle agent is doing nothing')
    assert.equal(summary.agents[0].turnStartedAt, null)
    assert.equal(summary.waitingFor.kind, 'user', 'the turn is over, so the run waits for you')
    assert.equal(summary.status, 'waiting')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a run parked at the plan gate says it waits for approval', async () => {
  const f = await fixture('live-approval')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'orchestrator',
      task: 'Rework the demo app',
      planApproval: true,
    })
    await runTurn(f.driver, f.driver.created[0], ORCH_PLAN)
    const planned = latestRun(f)
    assert.equal(planned.status, 'waiting')
    assert.equal(planned.waitingFor.kind, 'approval', 'the header must say approval, not a generic wait')
    assert.equal(typeof planned.waitingFor.since, 'number')
    assert.equal(planned.agents[0].activity, null, 'the planner finished its turn')
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
    assert.equal(plan.key, undefined, 'a plan card written for the agents carries no host key')
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

    const discarded = await f.engine.discard(run.id)
    assert.equal(discarded.status, 'discarded')
    assert.equal(discarded.changeCount, 0, 'the header no longer claims changes after the copy is gone')
    const finalFeed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(
      finalFeed.events.some((event) => event.kind === 'status' && event.key === 'feed.finish.discarded'),
      'the feed records the discard instead of leaving the stop message in place',
    )
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

/* -------------------------------------------------------------------- fusion */

/**
 * Start a Fusion run with a distinct route for every slot, so the tests can tell
 * the panel, the judge and the implementer apart by model as well as by name.
 * @param {object} f - fixture.
 * @param {object} [extra] - extra start options.
 * @returns {Promise<object>} the run summary.
 */
async function startFusion(f, extra = {}) {
  const models = {
    panel: [
      { provider: 'test', model: 'fast' },
      { provider: 'test', model: 'slow' },
      { provider: 'test', model: 'fast' },
    ],
    judge: { provider: 'test', model: 'slow' },
    implementer: { provider: 'test', model: 'fast' },
    ...(extra.models ?? {}),
  }
  const options = { ...extra }
  delete options.models
  return f.engine.start({
    sessionId: 's1',
    projectPath: f.projectPath,
    mode: 'fusion',
    task: 'Pick the approach for the answer change',
    models,
    ...options,
  })
}

/** Answer every panelist with a distinct short position. */
async function answerPanel(f) {
  const [vega, orion, lyra] = f.driver.created
  await runTurn(f.driver, vega, 'Approach A: change the answer in src/app.js.')
  await runTurn(f.driver, orion, 'Approach B: add a function and update the test fixture.')
  await runTurn(f.driver, lyra, 'Approach A, with a README note.')
}

test('fusion run: panel answers, judge merges, implementer works', async () => {
  const f = await fixture('fusion')
  try {
    const run = await startFusion(f)
    assert.equal(run.mode, 'fusion')
    assert.equal(run.status, 'planning')
    assert.equal(run.agents.length, 5)
    assert.deepEqual(run.agents.map((agent) => agent.role), ['panelist', 'panelist', 'panelist', 'judge', 'implementer'])
    assert.ok(run.agents.every((agent) => agent.kind === 'session'))
    assert.equal(f.driver.created.length, 5)
    assert.equal(f.driver.members.length, 0)
    assert.deepEqual(f.driver.created.map((handle) => handle.sandboxMode), ['read-only', 'read-only', 'read-only', 'read-only', undefined])
    assert.deepEqual(f.driver.created.map((handle) => [handle.name, handle.model?.model ?? null]), [
      ['Vega', 'fast'],
      ['Orion', 'slow'],
      ['Lyra', 'fast'],
      ['Atlas', 'slow'],
      ['Nova', 'fast'],
    ])
    assert.deepEqual(run.agents.map((agent) => agent.model?.model ?? null), ['fast', 'slow', 'fast', 'slow', 'fast'])
    assert.equal(f.driver.prompts.length, 3, 'only the panel is prompted at the start')
    assert.deepEqual(f.driver.prompts.map((entry) => entry.agent), ['Vega', 'Orion', 'Lyra'])
    assert.match(f.driver.prompts[0].text, /independent models/)
    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === 'Three models are answering the same question independently. Nothing is edited in this step.'))

    const [vega] = f.driver.created
    await runTurn(f.driver, vega, 'Approach A: change the answer in src/app.js.')
    assert.equal(latestRun(f).status, 'planning')
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Atlas').length, 0, 'the judge waits for every panelist')

    await runTurn(f.driver, f.driver.created[1], 'Approach B: add a function and update the test fixture.')
    await runTurn(f.driver, f.driver.created[2], 'Approach A, with a README note.')
    const judgePrompt = f.driver.prompts.find((entry) => entry.agent === 'Atlas')
    assert.ok(judgePrompt !== undefined)
    assert.match(judgePrompt.text, /Approach A: change the answer/)
    assert.match(judgePrompt.text, /Approach B: add a function/)
    assert.match(judgePrompt.text, /Test\/Fast/)
    assert.match(judgePrompt.text, /Test\/Slow/)
    assert.equal(latestRun(f).status, 'planning')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'All three answers are in. The judge is merging them into one decision.'))

    await runTurn(f.driver, f.driver.handleFor('Atlas'), '## Merged decision\nChange src/app.js and keep the tests green.\n## Where the answers converged\n- src/app.js\n## Where they diverged\n- tests\n## What only one answer saw\n- README\n## Disputed places\n- test fixture\nDISPUTES: 1')
    const implementPrompt = f.driver.prompts.find((entry) => entry.agent === 'Nova')
    assert.ok(implementPrompt !== undefined)
    assert.match(implementPrompt.text, /## Merged decision/)
    assert.match(implementPrompt.text, /Change src\/app\.js and keep the tests green\./)
    assert.ok(!/DISPUTES: 1/.test(implementPrompt.text), 'the marker line never reaches the implementer')
    assert.equal(latestRun(f).status, 'running')
    const afterJudge = await feedOf(f, run.id)
    assert.ok(afterJudge.some((event) => event.kind === 'plan' && /## Merged decision/.test(event.text)))
    assert.ok(afterJudge.some((event) => event.kind === 'status' && event.text === 'The judge merged 3 answers into one decision. 1 disputed place. Nova is implementing it.'))

    const implementer = f.driver.handleFor('Nova')
    await f.driver.emit(implementer, { kind: 'tool', tool: 'edit', path: 'src/app.js' })
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, implementer, 'Changed the answer and ran the tests.')
    const waiting = latestRun(f)
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.changeCount, 1)
    assert.equal(waiting.agents[4].status, 'idle')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The implementer is idle. 1 file changed — review the diff and apply what you like.'))
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the real project is untouched before apply')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('fusion start validates every slot route before copying', async () => {
  const f = await fixture('fusion-model')
  try {
    await assert.rejects(
      () => startFusion(f, { models: { panel: [{ provider: 'test', model: 'nope' }] } }),
      (error) => error instanceof ArtelError && error.code === 'artel/model-unavailable',
    )
    assert.deepEqual(f.engine.listRuns('s1'), [])
    assert.equal(f.driver.created.length, 0)
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [])
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a stopped panelist is skipped and the judge merges the rest', async () => {
  const f = await fixture('fusion-panel-failure')
  try {
    const run = await startFusion(f)
    const [vega, orion, lyra] = f.driver.created
    await runTurn(f.driver, vega, 'Approach A: change src/app.js.')
    await f.driver.emit(orion, { kind: 'turn-start' })
    await f.driver.emit(orion, { kind: 'turn-end', reason: { kind: 'error' } })
    await runTurn(f.driver, lyra, 'Approach C: change src/app.js and the README.')

    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'error' && event.text === 'Orion stopped (error). The panel continues without it.'))
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === '2 of 3 answers are in (a panel model stopped). The judge is merging them into one decision.'))
    const judgePrompt = f.driver.prompts.find((entry) => entry.agent === 'Atlas')
    assert.ok(judgePrompt !== undefined)
    assert.match(judgePrompt.text, /Approach A/)
    assert.match(judgePrompt.text, /Approach C/)
    assert.ok(!/Approach B/.test(judgePrompt.text))
    assert.equal(latestRun(f).agents[1].status, 'failed')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a single surviving panel answer is merged with singular wording', async () => {
  const f = await fixture('fusion-panel-one')
  try {
    const run = await startFusion(f)
    const [vega, orion, lyra] = f.driver.created
    await runTurn(f.driver, vega, 'Approach A: change src/app.js.')
    await f.driver.emit(orion, { kind: 'turn-start' })
    await f.driver.emit(orion, { kind: 'turn-end', reason: { kind: 'error' } })
    await f.driver.emit(lyra, { kind: 'turn-start' })
    await f.driver.emit(lyra, { kind: 'turn-end', reason: { kind: 'error' } })

    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'status' && event.text === '1 of 3 answers is in (a panel model stopped). The judge is merging them into one decision.'))
    const judgePrompt = f.driver.prompts.find((entry) => entry.agent === 'Atlas')
    assert.ok(judgePrompt !== undefined)
    assert.match(judgePrompt.text, /Approach A/)
    assert.ok(!/Approach B/.test(judgePrompt.text))

    await runTurn(f.driver, f.driver.handleFor('Atlas'), '## Merged decision\nDo A.\nDISPUTES: 0')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The judge merged 1 answer into one decision. None of the answers disagree. Nova is implementing it.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a fusion run fails when every panelist stops', async () => {
  const f = await fixture('fusion-panel-dead')
  try {
    const run = await startFusion(f)
    for (const handle of f.driver.created.slice(0, 3)) {
      await f.driver.emit(handle, { kind: 'turn-start' })
      await f.driver.emit(handle, { kind: 'turn-end', reason: { kind: 'error' } })
    }
    const failed = latestRun(f)
    assert.equal(failed.status, 'failed')
    assert.equal(f.store.get(run.id).error, 'Every panel model stopped before answering. Nothing was edited.')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a fusion failure carries the provider message from every stopped panelist', async () => {
  const f = await fixture('fusion-panel-detail')
  try {
    const run = await startFusion(f)
    const reasons = [
      { kind: 'error', error: { message: '403 Forbidden', code: 'provider/forbidden' } },
      { kind: 'error', error: { message: 'model not found', code: 'provider/not-found' } },
      { kind: 'error', error: { message: '403 Forbidden', code: 'provider/forbidden' } },
    ]
    const handles = f.driver.created.slice(0, 3)
    for (const [index, handle] of handles.entries()) {
      await f.driver.emit(handle, { kind: 'turn-start' })
      await f.driver.emit(handle, { kind: 'turn-end', reason: reasons[index] })
    }

    const feed = await feedOf(f, run.id)
    assert.ok(feed.some((event) => event.kind === 'error' && event.text.includes('Provider: 403 Forbidden [provider/forbidden]')), 'the feed repeats the provider text')
    const failed = latestRun(f)
    assert.equal(failed.status, 'failed')
    const error = f.store.get(run.id).error
    assert.match(error, /Failed models/)
    assert.match(error, /Vega \(test\/fast\): 403 Forbidden \[provider\/forbidden\]/)
    assert.match(error, /Orion \(test\/slow\): model not found \[provider\/not-found\]/)
    assert.match(error, /Lyra \(test\/fast\): 403 Forbidden \[provider\/forbidden\]/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('an empty judge answer is asked once more, then the run continues', async () => {
  const f = await fixture('fusion-judge')
  try {
    const run = await startFusion(f)
    await answerPanel(f)
    const atlas = f.driver.handleFor('Atlas')
    await f.driver.emit(atlas, { kind: 'turn-start' })
    await f.driver.emit(atlas, { kind: 'turn-end' })
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The judge answered nothing. Asking it once more.'))
    const retries = f.driver.prompts.filter((entry) => entry.agent === 'Atlas')
    assert.equal(retries.length, 2)
    assert.match(retries[1].text, /previous answer was empty/)
    assert.equal(latestRun(f).status, 'planning')

    await runTurn(f.driver, atlas, '## Merged decision\nDo B.\nDISPUTES: 0')
    assert.equal(latestRun(f).status, 'running')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The judge merged 3 answers into one decision. None of the answers disagree. Nova is implementing it.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a judge that fails twice fails the fusion run', async () => {
  const f = await fixture('fusion-judge-failure')
  try {
    const run = await startFusion(f)
    await answerPanel(f)
    const atlas = f.driver.handleFor('Atlas')
    await f.driver.emit(atlas, { kind: 'turn-start' })
    await f.driver.emit(atlas, { kind: 'turn-end', reason: { kind: 'error' } })
    await f.driver.emit(atlas, { kind: 'turn-start' })
    await f.driver.emit(atlas, { kind: 'turn-end', reason: { kind: 'error' } })
    assert.equal(latestRun(f).status, 'failed')
    assert.equal(f.store.get(run.id).error, 'The judge could not merge the panel answers. Nothing was edited.')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('fusion messages reach only the active stage', async () => {
  const f = await fixture('fusion-message')
  try {
    const run = await startFusion(f)
    const rows = latestRun(f).agents
    const rejected = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/planning'
    await assert.rejects(() => f.engine.message(run.id, { text: 'hello', agentId: rows[4].id }), rejected, 'the implementer waits for the merged decision')

    const before = f.driver.prompts.length
    const answered = await f.engine.message(run.id, { text: 'Please consider the tests', agentId: rows[0].id })
    assert.equal(answered.status, 'planning', 'a panel message does not start the work')
    const prompts = f.driver.prompts.slice(before)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].agent, 'Vega')
    assert.match(prompts[0].text, /Please consider the tests/)
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'user' && event.text === 'Please consider the tests'))

    const broadcastBefore = f.driver.prompts.length
    const broadcast = await f.engine.message(run.id, { text: 'Show the trade-offs too' })
    assert.equal(broadcast.status, 'planning', 'a broadcast does not start the work either')
    const broadcastPrompts = f.driver.prompts.slice(broadcastBefore)
    assert.deepEqual(broadcastPrompts.map((entry) => entry.agent), ['Vega', 'Orion', 'Lyra'], 'everyone means the panel only')
    assert.ok(broadcastPrompts.every((entry) => /Show the trade-offs too/.test(entry.text)))
    assert.equal(latestRun(f).agents[3].name, 'Atlas', 'the judge was not prompted')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

/* ----------------------------------------------------------- orchestrator */

const ORCH_PLAN = [
  'PLAN: Rework the demo app in two parts.',
  'PART 1: Core change',
  'GOAL: The answer becomes 2 in src/app.js.',
  'DONE: src/app.js exports answer 2; the existing call sites still work',
  'FILES: src/app.js',
  'PART 2: Docs',
  'GOAL: The README explains the answer.',
  'DONE: README.md mentions the new answer',
  'FILES: README.md',
].join('\n')

/** Start an Orchestrator run in the fixture's project. */
async function startOrchestrator(f, task = 'Rework the demo app') {
  return f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'orchestrator', task })
}

/** Let the planner write the two-part plan and wait until the parts exist. */
async function planOrchestrator(f) {
  const run = await startOrchestrator(f)
  await runTurn(f.driver, f.driver.created[0], ORCH_PLAN)
  return run
}

test('orchestrator start: one planner reads the project, no copy is made yet', async () => {
  const f = await fixture('orchestrator-start')
  try {
    const run = await startOrchestrator(f)
    assert.equal(run.mode, 'orchestrator')
    assert.equal(run.status, 'planning')
    assert.equal(run.agents.length, 1, 'only the planner exists before the plan')
    assert.equal(run.agents[0].role, 'planner')
    assert.equal(run.agents[0].name, 'Vega')
    assert.equal(run.agents[0].kind, 'session')
    assert.equal(f.driver.created.length, 1)
    assert.equal(f.driver.members.length, 0, 'orchestrator agents are ordinary sessions')
    assert.equal(f.driver.created[0].copyPath, f.projectPath, 'the planner reads the real project')
    assert.equal(f.driver.created[0].sandboxMode, 'read-only', 'the planner can never write to the project')
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'no copy before the plan is known')
    assert.match(f.driver.prompts[0].text, /Rework the demo app/)
    assert.match(f.driver.prompts[0].text, /PLAN:/)
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'Vega is reading the project and splitting the goal into parts. Nothing is edited in this step.'))

    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/planning'
    await assert.rejects(() => f.engine.message(run.id, { text: 'hello' }), refused, 'the planner owns the conversation until the plan exists')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: one copy per part, a reviewer per copy, rework and one assembly', async () => {
  const f = await fixture('orchestrator-happy')
  try {
    const run = await planOrchestrator(f)
    let latest = latestRun(f)
    assert.equal(latest.status, 'running')
    assert.equal(latest.plan.summary, 'Rework the demo app in two parts.')
    assert.deepEqual(latest.plan.parts.map((part) => part.title), ['Core change', 'Docs'])
    assert.deepEqual(latest.plan.parts.map((part) => part.status), ['working', 'working'])
    assert.deepEqual(latest.plan.parts.map((part) => part.workerName), ['Orion', 'Atlas'])
    assert.deepEqual(latest.plan.parts.map((part) => part.reviewerName), ['Lyra', 'Nova'])
    assert.deepEqual(latest.agents.map((agent) => agent.role), ['planner', 'part', 'reviewer', 'part', 'reviewer'])
    assert.deepEqual(f.driver.created.map((handle) => handle.sandboxMode), ['read-only', undefined, 'read-only', undefined, 'read-only'])
    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const p2 = path.join(f.copyRoot, `${run.id}-p2`)
    assert.ok(await fs.stat(p1))
    assert.ok(await fs.stat(p2))
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the user project is untouched')

    const afterPlan = await feedOf(f, run.id)
    assert.ok(afterPlan.some((event) => event.kind === 'plan' && event.text.startsWith('Plan: Rework the demo app in two parts.')))
    assert.ok(afterPlan.some((event) => event.kind === 'status' && event.text === 'Preparing 2 copies of the project, one per part.'))
    assert.ok(afterPlan.some((event) => event.kind === 'status' && event.text === '2 agents are working on 2 parts in separate copies. The user project is untouched.'))
    const workerPrompt = f.driver.prompts.find((entry) => entry.agent === 'Orion')
    assert.match(workerPrompt.text, /Core change/)
    assert.match(workerPrompt.text, /src\/app\.js/)

    // First part: the worker edits its own copy, the reviewer accepts it.
    await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Orion'), 'Changed the answer to 2.')
    const reviewPrompt = f.driver.prompts.find((entry) => entry.agent === 'Lyra')
    assert.ok(reviewPrompt !== undefined)
    assert.match(reviewPrompt.text, /src\/app\.js/)
    assert.match(reviewPrompt.text, /VERDICT:/)
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'Part 1 — Core change: Orion is done; Lyra is checking the copy against the plan.'))
    await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — the plan conditions are met.')
    latest = latestRun(f)
    assert.equal(latest.plan.parts[0].status, 'accepted')
    assert.equal(latest.status, 'running', 'the run waits for the second part')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'Part 1 — Core change: accepted — the plan conditions are met.'))

    // Second part: the reviewer sends it back once, the worker fixes it, the
    // second review accepts it.
    const readme = path.join(p2, 'README.md')
    await fs.writeFile(readme, '# Demo\n\nThe answer is 1.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Documented the answer.')
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: rework — the README does not mention the new answer.\nPROBLEMS:\n- README still says the answer is 1')
    latest = latestRun(f)
    assert.equal(latest.plan.parts[1].status, 'rework')
    assert.equal(latest.plan.parts[1].rounds, 1)
    assert.equal(latest.plan.parts[1].remarks, 'README still says the answer is 1')
    const reworkPrompts = f.driver.prompts.filter((entry) => entry.agent === 'Atlas')
    assert.match(reworkPrompts.at(-1).text, /README still says the answer is 1/)
    const reworkFeed = await feedOf(f, run.id)
    assert.ok(reworkFeed.some((event) => event.kind === 'status' && event.text === 'Part 2 — Docs: sent back to Atlas (rework 1 of 2).'))
    assert.ok(reworkFeed.some((event) => event.kind === 'status' && event.text === 'Part 2 — Docs review: README still says the answer is 1'))
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Nova').length, 1)

    await fs.writeFile(readme, '# Demo\n\nThe answer is 2.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'README now says the answer is 2.')
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Nova').length, 2, 'the reworked part is reviewed again')
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — the README matches the new answer.')

    latest = latestRun(f)
    assert.equal(latest.status, 'waiting')
    assert.equal(latest.merge.merged, true)
    assert.deepEqual(latest.merge.unresolved, [])
    assert.ok(latest.plan.parts.every((part) => part.status === 'accepted'))
    assert.equal(latest.changeCount, 2)
    assert.deepEqual((await f.engine.changes(run.id)).map((change) => change.path), ['README.md', 'src/app.js'])
    const finalFeed = await feedOf(f, run.id)
    assert.ok(finalFeed.some((event) => event.kind === 'plan' && /The parts are assembled in one copy\./.test(event.text)))
    assert.ok(finalFeed.some((event) => event.kind === 'status' && event.text === 'The work is assembled in one copy. Review the diff and apply it, or discard the run.'))
    assert.deepEqual(await fs.readdir(f.copyRoot), [run.id], 'the part copies are gone, the assembly stays')

    const applied = await f.engine.apply(run.id)
    assert.deepEqual(applied.applied, ['README.md', 'src/app.js'])
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8'), '# Demo\n\nThe answer is 2.\n')
    assert.equal(latestRun(f).status, 'applied')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

/** Accept both parts editing the same file with different content. */
async function conflictOrchestrator(f) {
  const run = await planOrchestrator(f)
  const p1 = path.join(f.copyRoot, `${run.id}-p1`)
  const p2 = path.join(f.copyRoot, `${run.id}-p2`)
  await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
  await runTurn(f.driver, f.driver.handleFor('Orion'), 'Answer is 2.')
  await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — done.')
  await fs.writeFile(path.join(p2, 'src', 'app.js'), 'export const answer = 3\n')
  await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Answer is 3.')
  await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — done.')
  return run
}

test('orchestrator: overlapping edits wait for the merger and then apply', async () => {
  const f = await fixture('orchestrator-conflict')
  try {
    const run = await conflictOrchestrator(f)
    const pending = latestRun(f)
    assert.equal(pending.status, 'running', 'the run is not published before the merge is decided')
    assert.equal(pending.merge.merged, false)
    assert.deepEqual(pending.merge.unresolved, ['src/app.js'])
    assert.equal(pending.merge.conflicts[0].path, 'src/app.js')
    assert.equal(pending.merge.conflicts[0].parts.length, 2)
    assert.equal(await fs.readFile(path.join(run.copyPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the conflicting file stays at its base version until the merger decides')
    assert.ok(await fs.stat(path.join(run.copyPath, '.dsh-artel', 'conflicts', '01', 'path.txt')))
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === '1 file(s) were edited by more than one part (src/app.js). Rhea is resolving them.'))
    assert.equal(f.driver.handleFor('Rhea').copyPath, run.copyPath, 'the merger works in the assembly copy')

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Rhea'), 'Both parts wanted an answer change; kept 2.')
    const assembled = latestRun(f)
    assert.equal(assembled.status, 'waiting')
    assert.equal(assembled.merge.merged, true)
    assert.deepEqual(assembled.merge.unresolved, [])
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'plan' && /Conflicts resolved by the merger: 1\./.test(event.text)))

    await f.engine.apply(run.id)
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: a merger that cannot decide fails the run and blocks apply', async () => {
  const f = await fixture('orchestrator-merge-unresolved')
  try {
    const run = await conflictOrchestrator(f)
    const merger = f.driver.handleFor('Rhea')
    await runTurn(f.driver, merger, 'I cannot decide between the two answers.')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The merger left 1 file(s) unresolved (src/app.js). Asking once more.'))
    assert.equal(latestRun(f).status, 'running')
    const mergerPrompts = f.driver.prompts.filter((entry) => entry.agent === 'Rhea')
    assert.equal(mergerPrompts.length, 2)
    assert.match(mergerPrompts[1].text, /src\/app\.js/)

    await runTurn(f.driver, merger, 'Still not sure.')
    assert.equal(latestRun(f).status, 'failed')
    assert.equal(f.store.get(run.id).error, 'The merge could not be finished: 1 file(s) still need a decision (src/app.js). The assembled copy is kept.')
    assert.deepEqual(f.store.get(run.id).merge.unresolved, ['src/app.js'])
    const blocked = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/merge-incomplete'
    await assert.rejects(() => f.engine.apply(run.id), blocked)
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'nothing reached the project')
    assert.deepEqual(await fs.readdir(f.copyRoot), [run.id], 'the assembly is kept for the diff, the part copies are gone')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: stopping the run during the merge keeps apply blocked', async () => {
  const f = await fixture('orchestrator-merge-stop')
  try {
    const run = await conflictOrchestrator(f)
    const stopped = await f.engine.interrupt(run.id)
    assert.equal(stopped.status, 'interrupted')
    assert.deepEqual(f.store.get(run.id).merge.unresolved, ['src/app.js'])
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && /middle of the merge/.test(event.text)))
    const blocked = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/merge-incomplete'
    await assert.rejects(() => f.engine.apply(run.id), blocked)
    assert.deepEqual(await fs.readdir(f.copyRoot), [run.id], 'the assembly stays, the part copies are gone')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: a stopped worker fails the run before anything is assembled', async () => {
  const f = await fixture('orchestrator-worker-failure')
  try {
    const run = await planOrchestrator(f)
    const orion = f.driver.handleFor('Orion')
    await f.driver.emit(orion, { kind: 'turn-start' })
    await f.driver.emit(orion, { kind: 'turn-end', reason: { kind: 'error' } })
    const failed = latestRun(f)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.plan.parts[0].status, 'failed')
    assert.equal(f.store.get(run.id).error, 'Part 1 — Core change: Orion stopped (error). The parts were not assembled, so nothing reaches your project.')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'the per-part copies are gone and no assembly exists')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: an unreadable plan is asked once more, then the run fails', async () => {
  const f = await fixture('orchestrator-bad-plan')
  try {
    const run = await startOrchestrator(f)
    const planner = f.driver.handleFor('Vega')
    await runTurn(f.driver, planner, 'I will just do it, no plan needed.')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The planner did not write a readable plan. Asking once more.'))
    assert.equal(latestRun(f).status, 'planning')
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Vega').length, 2)

    await runTurn(f.driver, planner, 'Still no plan.')
    assert.equal(latestRun(f).status, 'failed')
    assert.equal(f.store.get(run.id).error, 'The planner could not split the goal into parts. Nothing was edited.')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: two parts finish together and both reviews are taken', async () => {
  const f = await fixture('orchestrator-overlapping-reviews')
  try {
    const run = await planOrchestrator(f)
    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const p2 = path.join(f.copyRoot, `${run.id}-p2`)

    // The first part reaches its reviewer...
    await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Orion'), 'Changed the answer to 2.')
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Lyra').length, 1)

    // ...and the second part finishes while that review is still open. It must
    // start its own review instead of waiting for one shared slot.
    await fs.writeFile(path.join(p2, 'README.md'), '# Demo\n\nThe answer is 2.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Documented the answer.')
    assert.equal(f.driver.prompts.filter((entry) => entry.agent === 'Nova').length, 1, 'the second review starts in parallel')
    assert.deepEqual(latestRun(f).plan.parts.map((part) => part.status), ['reviewing', 'reviewing'])

    // The second reviewer answers first: its part is accepted, the first review
    // stays open and must still produce a verdict afterwards.
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — the README matches.')
    let latest = latestRun(f)
    assert.deepEqual(latest.plan.parts.map((part) => part.status), ['reviewing', 'accepted'])
    assert.equal(latest.status, 'running')

    await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — the answer is 2.')
    latest = latestRun(f)
    assert.deepEqual(latest.plan.parts.map((part) => part.status), ['accepted', 'accepted'])
    assert.equal(latest.status, 'waiting', 'both verdicts are taken and the work is assembled')
    assert.equal(latest.merge.merged, true)
    assert.deepEqual(latest.merge.unresolved, [])
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: stopping before the assembly keeps the part copies and the run can continue', async () => {
  const f = await fixture('orchestrator-interrupt-parts')
  try {
    const run = await planOrchestrator(f)
    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const stopped = await f.engine.interrupt(run.id)
    assert.equal(stopped.status, 'interrupted')
    assert.ok(await fs.stat(p1), 'the part copies stay, so the run can be resumed')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && /part copies are still there/.test(event.text)))

    const resumed = await f.engine.message(run.id, { text: 'Продолжайте.' })
    assert.equal(resumed.status, 'running')
    assert.equal(latestRun(f).status, 'running')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator: a message after the assembly is refused', async () => {
  const f = await fixture('orchestrator-message-assembled')
  try {
    const run = await planOrchestrator(f)
    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const p2 = path.join(f.copyRoot, `${run.id}-p2`)
    await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Orion'), 'Changed the answer to 2.')
    await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — done.')
    await fs.writeFile(path.join(p2, 'README.md'), '# Demo\n\nThe answer is 2.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Documented the answer.')
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — done.')
    assert.equal(latestRun(f).status, 'waiting')

    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/bad-stage'
    await assert.rejects(
      () => f.engine.message(run.id, { text: 'Поменяй ответ на 3.' }),
      refused,
      'the part copies are gone; the assembled result goes to Apply or Discard',
    )
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})


/* ------------------------------------------------- new start options */

/** Write a version directory with the given files, relative to the fixture root. */
async function writeVersionDir(root, name, files) {
  const dir = path.join(root, 'versions', name)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return dir
}

test('start with basePath: the copy is seeded from the version, the diff base stays the real project', async () => {
  const f = await fixture('start-base-path')
  try {
    const versionDir = await writeVersionDir(f.root, 'v1', {
      'src/app.js': 'export const answer = 2\n',
      'README.md': '# Demo\n\nThe answer is 2.\n',
    })
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Continue the work',
      basePath: versionDir,
    })
    assert.equal(run.basePath, path.resolve(versionDir), 'the summary names the seed copy')
    assert.equal(run.autoqueue, false)
    assert.equal(await fs.readFile(path.join(run.copyPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n', 'the copy starts from the version, not the project')
    assert.equal(await fs.readFile(path.join(run.copyPath, 'README.md'), 'utf8'), '# Demo\n\nThe answer is 2.\n')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the user project is untouched')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'Copy ready: 2 files, seeded from the previous version.'), 'the feed names the seed')
    const changes = await f.engine.changes(run.id)
    assert.deepEqual(changes.map((change) => change.path), ['README.md', 'src/app.js'], 'the version content shows against the real project')
    assert.equal(f.store.get(run.id).baseHashes['src/app.js'] !== undefined, true, 'the manifest was taken from the real project')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('start with a missing basePath: the run is refused and nothing is copied', async () => {
  const f = await fixture('start-base-path-missing')
  try {
    const missing = path.join(f.root, 'versions', 'gone')
    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/no-base-version'
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Continue the work', basePath: missing }),
      refused,
      'a version that was swept away is reported, not silently replaced',
    )
    assert.deepEqual(f.engine.listRuns('s1'), [], 'no run was recorded')
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'no copy was made')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('autoqueue: the first prompt carries the night-shift rules', async () => {
  const f = await fixture('start-autoqueue')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Build the settings screen',
      autoqueue: true,
    })
    assert.equal(run.autoqueue, true, 'the run is marked as unattended')
    assert.equal(latestRun(f).autoqueue, true)
    const prompt = f.driver.prompts[0].text
    assert.match(prompt, /Build the settings screen/)
    assert.match(prompt, /UNATTENDED RUN/)
    assert.match(prompt, /nobody will answer/)
    assert.match(prompt, /Never send anything outward/)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('sandboxMode is forwarded to the solo agent', async () => {
  const f = await fixture('start-sandbox-mode')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Inspect the project',
      sandboxMode: 'read-only',
    })
    assert.equal(f.driver.created.length, 1)
    assert.equal(f.driver.created[0].sandboxMode, 'read-only')
    assert.equal(f.driver.created[0].copyPath, run.copyPath)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a run started from an Artel task chat writes its copy', async () => {
  const f = await fixture('start-task-chat-sandbox')
  try {
    await f.store.add({
      id: 'run-task-chat',
      sessionId: 'session-task-9',
      originSessionId: 's1',
      projectPath: f.projectPath,
      task: 'Earlier step',
      status: 'applied',
      mode: 'solo',
      taskChat: true,
      chatTitle: 'Artel · Earlier step',
      createdAt: 1,
      updatedAt: 2,
    })
    const run = await f.engine.start({
      sessionId: 'session-task-9',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Next step',
      autoqueue: true,
    })
    assert.equal(f.driver.created.length, 1)
    assert.equal(
      f.driver.created[0].sandboxMode,
      'workspace-write',
      'the task chat is read-only, but its run works in a copy and must be able to edit it',
    )
    assert.equal(f.store.get(run.id).sandboxMode, 'workspace-write')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('an ordinary chat keeps the driver default sandbox', async () => {
  const f = await fixture('start-chat-sandbox')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Inspect the project',
    })
    assert.equal(f.driver.created[0].sandboxMode, undefined, 'no mode is invented for a normal chat')
    assert.equal(f.store.get(run.id).sandboxMode, null)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a copy directory reports the project it was copied from', async () => {
  const f = await fixture('project-of-copy')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Inspect the project',
    })
    assert.equal(f.engine.projectPathForCopy(run.copyPath), f.projectPath, 'the copy root maps back')
    assert.equal(f.engine.projectPathForCopy(path.join(run.copyPath, 'src')), f.projectPath, 'a directory inside the copy maps back too')
    assert.equal(f.engine.projectPathForCopy(f.projectPath), null, 'a real project is not remapped')
    assert.equal(f.engine.projectPathForCopy(''), null)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('orchestrator planApproval: the plan waits for approvePlan before any copy or part', async () => {
  const f = await fixture('orchestrator-plan-approval')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'orchestrator',
      task: 'Rework the demo app',
      planApproval: true,
    })
    assert.equal(run.planApproval, true)
    assert.equal(run.planApproved, false)
    assert.equal(run.status, 'planning')
    const noPlanYet = (error) => error instanceof ArtelError && error.status === 400 && error.code === 'artel/no-plan'
    await assert.rejects(() => f.engine.approvePlan(run.id), noPlanYet, 'there is no plan to approve before the planner answers')

    await runTurn(f.driver, f.driver.created[0], ORCH_PLAN)
    const planned = latestRun(f)
    assert.equal(planned.status, 'waiting', 'the planner answer stops at the approval gate')
    assert.equal(planned.plan.parts.length, 2, 'the plan is stored before the gate')
    assert.deepEqual(planned.plan.parts.map((part) => part.status), ['pending', 'pending'])
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'nothing is copied before the approval')
    assert.equal(f.driver.created.length, 1, 'only the planner exists before the approval')
    const gateFeed = await feedOf(f, run.id)
    assert.ok(gateFeed.some((event) => event.kind === 'plan'))
    assert.ok(gateFeed.some((event) => event.kind === 'status' && event.text === 'The plan is ready. Nothing is copied and nothing is edited until you approve it.'))

    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/plan-approval'
    await assert.rejects(() => f.engine.message(run.id, { text: 'Start now' }), refused, 'a chat line is not an approval')

    const approved = await f.engine.approvePlan(run.id)
    assert.equal(approved.status, 'running')
    assert.equal(approved.planApproved, true)
    assert.deepEqual(approved.plan.parts.map((part) => part.status), ['working', 'working'])
    assert.ok(await fs.stat(path.join(f.copyRoot, `${run.id}-p1`)))
    assert.ok(await fs.stat(path.join(f.copyRoot, `${run.id}-p2`)))
    assert.equal(f.driver.created.length, 5, 'the planner plus two workers and two reviewers')
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The plan is approved. The parts are starting now.'))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('approvePlan: an ordinary run and an unknown run are refused', async () => {
  const f = await fixture('approve-plan-refused')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const noPlan = (error) => error instanceof ArtelError && error.status === 400 && error.code === 'artel/no-plan'
    await assert.rejects(() => f.engine.approvePlan(run.id), noPlan, 'a solo run has no gated plan')
    const unknown = (error) => error instanceof ArtelError && error.status === 404 && error.code === 'artel/unknown-run'
    await assert.rejects(() => f.engine.approvePlan('fg-does-not-exist'), unknown)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('approvePlan refuses a plan whose runtime died with a restart (#31)', async () => {
  const f = await fixture('orchestrator-plan-restart')
  let restarted = null
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'orchestrator',
      task: 'Rework the demo app',
      planApproval: true,
    })
    await runTurn(f.driver, f.driver.created[0], ORCH_PLAN)
    assert.equal(latestRun(f).status, 'waiting', 'the planner stops at the approval gate')
    assert.equal(f.driver.created.length, 1, 'only the planner exists before the approval')

    // A fresh engine over the same run store models the host restart: the run is
    // on disk, but there is no runtime, planner session or agent tree any more.
    restarted = await new ArtelEngine({
      store: new RunStore({ dir: path.join(f.stateDir, 'runs') }),
      driver: new FakeDriver(),
      copyRoot: f.copyRoot,
      config: { swarmAgentCount: 3 },
      log: { warn() {} },
    }).init()
    const notLive = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/not-live'
    await assert.rejects(() => restarted.approvePlan(run.id), notLive, 'a dead run cannot be approved')

    const stored = restarted.getRun(run.id)
    assert.equal(stored.status, 'waiting', 'the run is not moved to running')
    assert.equal(stored.planApproved, false, 'the plan is not marked approved')
    assert.equal(stored.agents.length, 1, 'no part agents were created')
    assert.deepEqual(stored.plan.parts.map((part) => part.status), ['pending', 'pending'], 'the parts stay pending')
    assert.deepEqual(await fs.readdir(f.copyRoot).catch(() => []), [], 'no copies were made')
  } finally {
    if (restarted !== null) await restarted.dispose()
    await f.engine.dispose()
    await f.cleanup()
  }
})

const BUNDLE_PACKAGE = JSON.stringify({
  name: '@local/demo',
  version: '1.0.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)
const BUNDLE_PATCH = '- insert:\n    - id: demo\n      name: demo\n'
const INSTALL_MANIFEST = 'artel.install.json'

/** Write files into the fixture project before a run copies it. */
async function writeProjectFiles(projectPath, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const file = path.join(projectPath, relPath)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
}

/** Start a solo run, change one file in the copy, finish the turn and apply it. */
async function startAndApply(f, task = 'Change the answer') {
  const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task })
  const handle = f.driver.created[f.driver.created.length - 1]
  await f.driver.emit(handle, { kind: 'tool', tool: 'edit', path: 'src/app.js' })
  await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 9\n')
  await f.driver.emit(handle, { kind: 'turn-end' })
  await f.engine.apply(run.id)
  return run
}

test('apply records a DSH bundle and the card can install it into the running DSH', async () => {
  const f = await fixture('install-bundle')
  try {
    await writeProjectFiles(f.projectPath, { 'package.json': BUNDLE_PACKAGE, 'cordis.patch.yml': BUNDLE_PATCH })
    const run = await startAndApply(f)

    const applied = f.engine.getRun(run.id)
    assert.equal(applied.status, 'applied')
    assert.equal(applied.install.bundle.name, '@local/demo')
    assert.equal(applied.install.bundle.version, '1.0.0')
    assert.equal(applied.install.bundle.installable, true)
    assert.equal(applied.install.bundle.canInstall, true, 'this fake profile has a plugin manager')
    assert.equal(applied.install.bundle.status, null)
    assert.deepEqual(applied.install.steps, [])
    const applyFeed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(applyFeed.events.some((event) => event.kind === 'status' && /DSH bundle/.test(event.text)), 'the run says what is still to install')

    const installed = await f.engine.installBundle(run.id)
    assert.deepEqual(f.driver.bundleInstalls, [f.projectPath], 'the plugin manager is asked for the real project folder')
    assert.equal(installed.install.bundle.status, 'restart-required')
    assert.equal(installed.install.bundle.result.restartReason, 'no-hmr')
    const installFeed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(installFeed.events.some((event) => event.kind === 'status' && /Restart DSH/.test(event.text)))

    const plan = await f.engine.installPlan(run.id)
    assert.equal(plan.bundle.status, 'restart-required', 'a refresh keeps the finished result')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a profile without a plugin manager offers the manual steps instead', async () => {
  const f = await fixture('install-unsupported')
  try {
    f.driver.bundleInstall = false
    await writeProjectFiles(f.projectPath, { 'package.json': BUNDLE_PACKAGE, 'cordis.patch.yml': BUNDLE_PATCH })
    const run = await startAndApply(f)
    assert.equal(f.engine.getRun(run.id).install.bundle.canInstall, false)
    const unsupported = (error) => error instanceof ArtelError && error.status === 501 && error.code === 'artel/install-unsupported'
    await assert.rejects(() => f.engine.installBundle(run.id), unsupported)
    assert.deepEqual(f.driver.bundleInstalls, [], 'nothing was installed behind the user')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a bundle the profile already has is reported as already installed', async () => {
  const f = await fixture('install-already')
  try {
    f.driver.bundleResult = { changed: false, application: 'applied', stage: 'install', target: '' }
    await writeProjectFiles(f.projectPath, { 'package.json': BUNDLE_PACKAGE, 'cordis.patch.yml': BUNDLE_PATCH })
    const run = await startAndApply(f)
    const installed = await f.engine.installBundle(run.id)
    assert.equal(installed.install.bundle.status, 'already-installed')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a failed install is reported without losing the changed bundle files', async () => {
  const f = await fixture('install-failed')
  try {
    f.driver.bundleResult = new Error('the plugin manager refused the folder')
    await writeProjectFiles(f.projectPath, { 'package.json': BUNDLE_PACKAGE, 'cordis.patch.yml': BUNDLE_PATCH })
    const run = await startAndApply(f)
    const installed = await f.engine.installBundle(run.id)
    assert.equal(installed.install.bundle.status, 'failed')
    assert.match(installed.install.bundle.result.errorMessage, /refused the folder/)
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => event.kind === 'status' && /Could not install/.test(event.text)))
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('install steps run one click at a time and record their output', async () => {
  const f = await fixture('install-steps')
  try {
    await writeProjectFiles(f.projectPath, {
      [INSTALL_MANIFEST]: JSON.stringify({
        steps: [
          { title: 'Runtime', command: 'node -e "process.stdout.write(\'runtime ready\')"' },
          { title: 'Broken', command: 'node -e "process.exit(4)"' },
        ],
      }),
    })
    const run = await startAndApply(f)
    const applied = f.engine.getRun(run.id)
    assert.equal(applied.install.steps.length, 2)
    assert.deepEqual(applied.install.steps.map((step) => step.status), ['idle', 'idle'])
    assert.equal(applied.install.steps[0].origin, 'manifest')

    const afterFirst = await f.engine.runInstallStep(run.id, 0)
    assert.equal(afterFirst.install.steps[0].status, 'done')
    assert.equal(afterFirst.install.steps[0].exitCode, 0)
    assert.match(afterFirst.install.steps[0].output, /runtime ready/)
    assert.equal(afterFirst.install.steps[1].status, 'idle', 'one click runs one step')

    const afterSecond = await f.engine.runInstallStep(run.id, 1)
    assert.equal(afterSecond.install.steps[1].status, 'failed')
    assert.equal(afterSecond.install.steps[1].exitCode, 4)

    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.ok(feed.events.some((event) => event.kind === 'status' && /Install step “Runtime” finished\./.test(event.text)))
    assert.ok(feed.events.some((event) => event.kind === 'status' && /failed \(exit code 4\)/.test(event.text)))

    const unknown = (error) => error instanceof ArtelError && error.status === 404 && error.code === 'artel/unknown-install-step'
    await assert.rejects(() => f.engine.runInstallStep(run.id, 7), unknown)
    assert.equal(f.engine.getRun(run.id).install.steps[0].status, 'done', 'a refused click changes nothing')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the install offers are only available on an applied run', async () => {
  const f = await fixture('install-gated')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/bad-status'
    await assert.rejects(() => f.engine.installPlan(run.id), refused, 'nothing is applied yet')
    await assert.rejects(() => f.engine.installBundle(run.id), refused)
    await assert.rejects(() => f.engine.runInstallStep(run.id, 0), refused)
    await assert.rejects(() => f.engine.installPlan('fg-does-not-exist'), (error) => error instanceof ArtelError && error.status === 404 && error.code === 'artel/unknown-run')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('installPlan re-reads the manifest and keeps a step that already ran', async () => {
  const f = await fixture('install-refresh')
  try {
    const command = 'node -e "process.stdout.write(\'first\')"'
    await writeProjectFiles(f.projectPath, {
      [INSTALL_MANIFEST]: JSON.stringify({ steps: [{ title: 'First', command }] }),
    })
    const run = await startAndApply(f)
    await f.engine.runInstallStep(run.id, 0)
    assert.equal(f.engine.getRun(run.id).install.steps[0].status, 'done')

    await fs.writeFile(path.join(f.projectPath, INSTALL_MANIFEST), JSON.stringify({
      steps: [
        { title: 'First', command },
        { title: 'Second', command: 'node -e "process.stdout.write(\'second\')"' },
      ],
    }))
    const refreshed = await f.engine.installPlan(run.id, { refresh: true })
    assert.equal(refreshed.steps.length, 2, 'the new manifest is read from the project')
    assert.equal(refreshed.steps[0].status, 'done', 'the finished step keeps its result')
    assert.match(refreshed.steps[0].output, /first/)
    assert.equal(refreshed.steps[1].status, 'idle')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a run without install needs reports no install offers', async () => {
  const f = await fixture('install-none')
  try {
    const run = await startAndApply(f)
    assert.equal(f.engine.getRun(run.id).install, null)
    assert.equal(await f.engine.installPlan(run.id), null)
    const feed = await f.engine.readFeed(run.id, { cursor: 0 })
    assert.equal(feed.events.some((event) => event.kind === 'status' && /install/i.test(event.text)), false, 'no install talk on a plain change')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a task started from a chat gets its own chat and the run moves there', async () => {
  const f = await fixture('task-chat')
  try {
    const run = await f.engine.start({
      sessionId: 's1',
      projectPath: f.projectPath,
      mode: 'solo',
      task: 'Add a settings screen',
      newChat: true,
    })
    assert.equal(run.sessionId, 'session-task-1', 'the run is bound to the new chat')
    assert.equal(f.driver.taskChats.length, 1)
    assert.equal(f.driver.taskChats[0].projectPath, f.projectPath)
    assert.equal(f.driver.taskChats[0].task, 'Add a settings screen')
    assert.equal(f.driver.taskChats[0].sandboxMode, 'read-only', 'the task chat cannot write into the project')
    assert.equal(f.store.get(run.id).taskChat, true)
    assert.equal(f.store.get(run.id).projectChats, true, 'the run opts into the sidebar filing')
    assert.equal(f.store.get(run.id).originSessionId, 's1', 'the per-chat run cap counts from the source chat')
    // The source chat keeps no run; the new chat lists it.
    assert.deepEqual(f.engine.listRuns('s1'), [])
    assert.equal(f.engine.listRuns('session-task-1').length, 1)
    // The agents still start in the copy and inherit from the source chat, not
    // from the read-only task chat.
    assert.equal(f.driver.created[0].parentSessionId, 's1')
    assert.equal(f.driver.created[0].copyPath, run.copyPath)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('peer modes start their agents from the source chat, not the read-only task chat', async () => {
  for (const mode of ['swarm', 'conductor']) {
    const f = await fixture(`task-chat-${mode}`)
    try {
      const run = await f.engine.start({
        sessionId: 's1',
        projectPath: f.projectPath,
        mode,
        task: 'Rework the demo app',
        newChat: true,
      })
      assert.equal(run.sessionId, 'session-task-1', 'the run moves to the task chat')
      assert.equal(f.driver.taskChats[0].sandboxMode, 'read-only', 'the task chat itself cannot write')
      assert.equal(f.driver.created[0].parentSessionId, 's1', `the ${mode} lead inherits the sandbox of the chat the task came from`)
      for (const member of f.driver.members) {
        assert.equal(member.parentSessionId, f.driver.created[0].sessionId, 'the members live in the lead tree')
      }
    } finally {
      await f.engine.dispose()
      await f.cleanup()
    }
  }
})

test('fusion and orchestrator agents inherit the source chat, not the read-only task chat', async () => {
  const models = {
    panel: [
      { provider: 'test', model: 'fast' },
      { provider: 'test', model: 'slow' },
      { provider: 'test', model: 'fast' },
    ],
    judge: { provider: 'test', model: 'slow' },
    implementer: { provider: 'test', model: 'fast' },
  }
  const fusion = await fixture('task-chat-fusion')
  try {
    const run = await fusion.engine.start({
      sessionId: 's1',
      projectPath: fusion.projectPath,
      mode: 'fusion',
      task: 'Pick the approach for the answer change',
      models,
      newChat: true,
    })
    assert.equal(run.sessionId, 'session-task-1')
    assert.deepEqual(fusion.driver.created.map((handle) => handle.parentSessionId), ['s1', 's1', 's1', 's1', 's1'])
    assert.deepEqual(fusion.driver.created.map((handle) => handle.sandboxMode), ['read-only', 'read-only', 'read-only', 'read-only', undefined], 'only the panel and the judge stay read-only')
  } finally {
    await fusion.engine.dispose()
    await fusion.cleanup()
  }

  const orch = await fixture('task-chat-orchestrator')
  try {
    const run = await orch.engine.start({
      sessionId: 's1',
      projectPath: orch.projectPath,
      mode: 'orchestrator',
      task: 'Rework the demo app',
      newChat: true,
    })
    assert.equal(run.sessionId, 'session-task-1')
    await runTurn(orch.driver, orch.driver.created[0], ORCH_PLAN)
    assert.equal(orch.driver.created.length, 5, 'the planner, both workers and both reviewers exist')
    assert.deepEqual(orch.driver.created.map((handle) => handle.parentSessionId), ['s1', 's1', 's1', 's1', 's1'])
    assert.deepEqual(orch.driver.created.map((handle) => handle.sandboxMode), ['read-only', undefined, 'read-only', undefined, 'read-only'], 'the workers inherit the source chat, the reviewers stay read-only')
  } finally {
    await orch.engine.dispose()
    await orch.cleanup()
  }
})

test('the per-chat run cap counts task chats by the chat the task came from', async () => {
  const f = await fixture('task-chat-prune', { maxRunsPerSession: 1 })
  try {
    const first = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'First', newChat: true })
    // Older by a second, so the order does not depend on the clock granularity.
    await f.store.patch(first.id, { status: 'finished', createdAt: f.store.get(first.id).createdAt - 1000 })
    const second = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Second', newChat: true })
    assert.equal(f.store.get(first.id), undefined, 'the older task chat run is pruned by its source chat')
    assert.notEqual(second.id, first.id)
    assert.equal(f.store.all().length, 1)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('without an open project workspace the run stays in the chat it came from', async () => {
  const f = await fixture('task-chat-no-workspace')
  f.driver.noWorkspace = true
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Stay here', newChat: true })
    assert.equal(run.sessionId, 's1', 'the old behaviour is the fallback')
    assert.equal(f.store.get(run.id).taskChat, false)
    assert.equal(f.engine.listRuns('s1').length, 1)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a host that refuses the task chat never fails the run', async () => {
  const f = await fixture('task-chat-refused')
  f.driver.taskChatError = new Error('the workspace index is gone')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Still runs', newChat: true })
    assert.equal(run.sessionId, 's1')
    assert.equal(f.store.get(run.id).taskChat, false)
    assert.equal(f.engine.listRuns('s1').length, 1)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('newChat=false keeps the previous chat', async () => {
  const f = await fixture('task-chat-off')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Keep the chat' })
    assert.equal(run.sessionId, 's1')
    assert.equal(f.driver.taskChats.length, 0)
    assert.equal(f.store.get(run.id).taskChat, false)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('the project chats of stored runs are re-filed on startup, old runs are left alone', async () => {
  const f = await fixture('task-chat-restore')
  try {
    const fresh = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Fresh', newChat: true })
    assert.equal(f.store.get(fresh.id).projectChats, true)
    // An old run: it never opted into the sidebar filing.
    await f.store.patch(fresh.id, { projectChats: false })
    const legacy = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Legacy' })
    assert.equal(legacy.sessionId, 's1')
    const result = await f.engine.restoreProjectChats()
    assert.equal(result.attached, 1)
    assert.equal(f.driver.restoredRuns.length, 1)
    assert.equal(f.driver.restoredRuns[0].id, legacy.id, 'only the run that opted in is re-filed')
    assert.equal(f.driver.restoredRuns[0].agents[0].sessionId, 'session-2')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('restoreProjectChats is a no-op without the Workspace bridge', async () => {
  const f = await fixture('task-chat-restore-off')
  f.driver.projectChats = false
  try {
    await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'No bridge' })
    const result = await f.engine.restoreProjectChats()
    assert.deepEqual(result, { attached: 0, skipped: 0, failed: 0 })
    assert.equal(f.driver.restoredRuns, null)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('listChats groups runs by chat, keeps the newest and names the chat', async () => {
  const store = {
    all() {
      return [
        { id: 'run-1', sessionId: 'session-task-1', projectPath: 'C:\\work\\app', task: 'Add a screen', status: 'finished', mode: 'solo', taskChat: true, chatTitle: 'Artel · Add a screen', createdAt: 10, updatedAt: 20 },
        { id: 'run-2', sessionId: 'session-task-1', projectPath: 'C:\\work\\app', task: 'Fix it', status: 'running', mode: 'swarm', taskChat: true, chatTitle: 'Artel · Fix it', createdAt: 30, updatedAt: 40 },
        { id: 'run-3', sessionId: 'session-9', projectPath: 'C:\\work\\app', task: 'Old chat', status: 'applied', mode: 'solo', taskChat: false, createdAt: 5, updatedAt: 6 },
        { id: 'run-4', sessionId: 'session-8', projectPath: 'C:\\other', task: 'Elsewhere', status: 'failed', mode: 'solo', taskChat: false, createdAt: 7, updatedAt: 8 },
        { id: 'run-5', sessionId: 'session-7', projectPath: 'C:\\work\\app', task: 'Legacy task', status: 'finished', mode: 'solo', taskChat: true, createdAt: 1, updatedAt: 2 },
      ]
    },
    async add() {},
    async patch() {},
    get() {
      return null
    },
  }
  const engine = new ArtelEngine({ store, driver: {}, copyRoot: 'C:\\tmp', config: {} })
  const chats = await engine.listChats()

  assert.deepEqual(chats.map((chat) => chat.sessionId), ['session-task-1', 'session-8', 'session-9', 'session-7'], 'newest chat first')
  const grouped = chats[0]
  assert.equal(grouped.runCount, 2, 'two runs of one chat are one row')
  assert.equal(grouped.lastRunId, 'run-2', 'the newest run wins')
  assert.equal(grouped.title, 'Artel · Fix it')
  assert.equal(grouped.status, 'running')
  assert.equal(grouped.lastTask, 'Fix it')
  assert.equal(grouped.mode, 'swarm')
  assert.equal(grouped.updatedAt, 40)
  assert.equal(grouped.projectKey, await projectKeyOf('C:\\work\\app'))

  const withoutStoredTitle = chats.find((chat) => chat.sessionId === 'session-7')
  assert.equal(withoutStoredTitle.title, 'Artel · Legacy task', 'a task chat without a stored title is named from its task')
  const plainChat = chats.find((chat) => chat.sessionId === 'session-9')
  assert.equal(plainChat.title, null, 'a chat that predates task chats has no invented title')
  assert.equal(plainChat.lastTask, 'Old chat')
})

/* -------------------------------------------- isolated branch runs */

test('an isolated seeded run diffs against its seed and refuses a direct apply', async () => {
  const f = await fixture('isolated')
  try {
    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'src', 'app.js'), 'export const answer = 2\n')
    const seedManifest = await hashTree(seed)

    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer', basePath: seed, isolateFromBase: true })
    assert.equal(run.isolated, true)
    assert.equal(run.basePath, path.resolve(seed))
    assert.equal(run.branchId, null)
    assert.equal(run.parentCommit, null)
    assert.equal(run.commit, null)
    // The diff base is the seed, not the real project: the run is one step of a
    // branch and sees only its own change, not the whole chain up to the project.
    const stored = f.store.get(run.id)
    assert.deepEqual(Object.keys(stored.baseHashes).sort(), ['README.md', 'src/app.js'])
    assert.equal(stored.baseHashes['src/app.js'].hash, seedManifest.files['src/app.js'].hash)
    assert.notEqual(stored.baseHashes['src/app.js'].hash, (await hashTree(f.projectPath)).files['src/app.js'].hash)

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    const changes = await f.engine.changes(run.id)
    assert.deepEqual(changes.map((change) => change.path), ['src/app.js'])
    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/branch-apply-required'
    await assert.rejects(() => f.engine.apply(run.id), refused, 'the branch is applied from the queue, never the run')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('an isolated run without a base version is refused', async () => {
  const f = await fixture('isolated-no-seed')
  try {
    const refused = (error) => error instanceof ArtelError && error.status === 400 && error.code === 'artel/bad-request'
    await assert.rejects(
      () => f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'No seed', isolateFromBase: true }),
      refused,
      'an isolated queue run must start from a base version',
    )
    assert.deepEqual(f.engine.listRuns('s1'), [], 'no run was recorded')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a committed run is reviewed through git and refuses apply and discard', async () => {
  const f = await fixture('committed')
  try {
    const git = await ArtelGit.init({ stateDir: f.stateDir, projectPath: f.projectPath })
    const imported = await git.importProject()
    f.engine.setGitResolver(async (projectPath) => (path.resolve(projectPath) === path.resolve(f.projectPath) ? git : null))

    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'src', 'app.js'), 'export const answer = 2\n')
    // A branch task starts from its branch tip, and the tip is a commit: the run
    // commit is made on top of it, so the review reads seed -> working copy.
    const seedCommit = await git.commitDir(seed, { parent: imported, message: 'Seed version' })
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer', basePath: seed, isolateFromBase: true })
    const handle = f.driver.created[0]
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    await f.driver.emit(handle, { kind: 'turn-end' })
    const waiting = f.engine.listRuns('s1')[0]
    assert.equal(waiting.status, 'waiting')

    const files = await f.engine.changes(run.id)
    const commit = await git.commitDir(run.copyPath, { parent: seedCommit, message: 'Task: answer to 3' })
    await f.engine.markCommitted(run.id, { branchId: 'b1', parentCommit: seedCommit, commit, files, changeCount: files.length })
    const committed = f.engine.listRuns('s1')[0]
    assert.equal(committed.commit, commit)
    assert.equal(committed.branchId, 'b1')
    assert.equal(committed.parentCommit, seedCommit)
    assert.equal(committed.copyPath, null, 'the commit owns the content now')
    await assert.rejects(() => fs.stat(run.copyPath))
    const stored = await f.engine.changes(run.id)
    assert.deepEqual(stored.map((change) => change.path), ['src/app.js'])
    assert.deepEqual(stored[0].hunks, [], 'a committed change is reviewed through git, not a copy')

    const diff = await f.engine.fileDiff(run.id, 'src/app.js')
    assert.match(diff.before, /answer = 2/)
    assert.match(diff.after, /answer = 3/)

    const refusedApply = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/branch-apply-required'
    const refusedDiscard = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/commit-owned'
    await assert.rejects(() => f.engine.apply(run.id), refusedApply, 'the branch is applied from the queue')
    await assert.rejects(() => f.engine.discard(run.id), refusedDiscard, 'deleting the branch owns the commit')

    await f.engine.markApplied(run.id, { commit })
    assert.equal(f.engine.listRuns('s1')[0].status, 'applied')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('fileDiff refuses paths outside the run copy', async () => {
  const f = await fixture('diff-path')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const refused = (error) => error instanceof ArtelError && error.status === 400 && /Invalid file path/.test(error.message)
    await assert.rejects(() => f.engine.fileDiff(run.id, '../secret.txt'), refused, 'a parent segment is refused')
    await assert.rejects(() => f.engine.fileDiff(run.id, 'src\\..\\..\\secret.txt'), refused, 'a nested parent segment is refused')
    await assert.rejects(() => f.engine.fileDiff(run.id, path.join(f.root, 'secret.txt')), refused, 'an absolute path is refused')
    await assert.rejects(() => f.engine.fileDiff(run.id, 'C:secret.txt'), refused, 'a drive-relative path is refused')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('fileDiff answers 404 for a path the run never had (#28)', async () => {
  const f = await fixture('diff-missing')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const missing = (error) => error instanceof ArtelError && error.status === 404 && error.code === 'artel/unknown-file'
    await assert.rejects(() => f.engine.fileDiff(run.id, 'nope.txt'), missing, 'a missing top-level file is a 404')
    await assert.rejects(() => f.engine.fileDiff(run.id, 'src/deep/nope.txt'), missing, 'a missing nested file is a 404')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('markApplied refuses a run without a branch commit', async () => {
  const f = await fixture('mark-applied-uncommitted')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    const refused = (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/not-committed'
    await assert.rejects(() => f.engine.markApplied(run.id), refused)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('refreshInstall discovers install needs on the project', async () => {
  const f = await fixture('install')
  try {
    await fs.writeFile(path.join(f.projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, null, 2))
    await fs.writeFile(path.join(f.projectPath, 'cordis.patch.yml'), 'patches: []\n')
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Touch the README' })
    const install = await f.engine.refreshInstall(run.id)
    assert.notEqual(install, null)
    assert.equal(f.store.get(run.id).install, install, 'the discovered record is stored on the run')
    const view = f.engine.getRun(run.id).install
    assert.equal(view.bundle.name, 'demo')
    assert.equal(view.bundle.patch, 'cordis.patch.yml')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

/* ------------------------------ seeded orchestrators and the fixer */

test('a seeded Orchestrator reads and copies the seed, not the real project', async () => {
  const f = await fixture('orchestrator-seed')
  try {
    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'README.md'), '# Seed\n')

    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'orchestrator', task: 'Ship the seed', basePath: seed, isolateFromBase: true })
    assert.equal(run.mode, 'orchestrator')
    assert.equal(run.basePath, path.resolve(seed))
    assert.equal(f.driver.created.length, 1)

    const planner = f.driver.created[0]
    assert.notEqual(path.resolve(planner.copyPath), path.resolve(f.projectPath), 'the planner reads a copy, never the real project')
    assert.equal(await fs.readFile(path.join(planner.copyPath, 'README.md'), 'utf8'), '# Seed\n')
    assert.ok(f.driver.prompts[0].text.includes(planner.copyPath), 'the planner is pointed at its read-only copy of the seed')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8'), '# Demo\n', 'the real project is untouched')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a seeded Orchestrator takes every part copy and the assembly from the seed', async () => {
  const f = await fixture('orchestrator-seed-parts')
  try {
    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'README.md'), '# Seed\n')
    await fs.writeFile(path.join(seed, 'src', 'app.js'), 'export const answer = 5\n')
    const seedManifest = await hashTree(seed)

    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'orchestrator', task: 'Ship the seed', basePath: seed, isolateFromBase: true })
    await runTurn(f.driver, f.driver.created[0], ORCH_PLAN)

    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const p2 = path.join(f.copyRoot, `${run.id}-p2`)
    assert.equal(await fs.readFile(path.join(p1, 'src', 'app.js'), 'utf8'), 'export const answer = 5\n', 'the parts start from the seed')
    assert.equal(await fs.readFile(path.join(p2, 'README.md'), 'utf8'), '# Seed\n')
    const stored = f.store.get(run.id)
    assert.equal(stored.baseHashes['src/app.js'].hash, seedManifest.files['src/app.js'].hash, 'the run diffs against the seed manifest')
    assert.notEqual(stored.baseHashes['src/app.js'].hash, (await hashTree(f.projectPath)).files['src/app.js'].hash)

    await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Orion'), 'The answer is 2.')
    await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — done.')
    await fs.writeFile(path.join(p2, 'README.md'), '# Seed\n\nThe answer is 2.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Documented the answer.')
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — done.')

    const latest = latestRun(f)
    assert.equal(latest.status, 'waiting')
    assert.equal(latest.merge.merged, true)
    assert.equal(await fs.readFile(path.join(run.copyPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n', 'the assembly starts from the seed')
    assert.match(await fs.readFile(path.join(run.copyPath, 'README.md'), 'utf8'), /^# Seed\n\nThe answer is 2\./)
    const changes = await f.engine.changes(run.id)
    assert.deepEqual(changes.map((change) => change.path), ['README.md', 'src/app.js'])
    const diff = await f.engine.fileDiff(run.id, 'README.md')
    const diffLines = diff.hunks.flatMap((hunk) => hunk.lines)
    assert.ok(diffLines.some((line) => line.type === ' ' && line.text === '# Seed'), 'the review reads the seed as the before side')
    assert.ok(diffLines.some((line) => line.type === '+' && line.text === 'The answer is 2.'))
    assert.ok(!diffLines.some((line) => line.text === '# Demo'), 'the real project is not the before side')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n', 'the real project never changed')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('assist runs one short-lived agent and returns its report', async () => {
  const f = await fixture('assist')
  try {
    const copyPath = path.join(f.root, 'fixer-copy')
    await fs.cp(f.projectPath, copyPath, { recursive: true })
    const promise = f.engine.assist({ projectPath: f.projectPath, copyPath, prompt: 'Resolve the conflict in README.md' })
    await new Promise(setImmediate)
    const handle = f.driver.created[0]
    assert.equal(handle.mode, 'solo')
    assert.equal(handle.copyPath, copyPath)
    assert.match(f.driver.prompts[0].text, /Resolve the conflict/)

    await f.driver.emit(handle, { kind: 'turn-start' })
    await f.driver.emit(handle, { kind: 'assistant', text: 'Merged both intents.' })
    await f.driver.emit(handle, { kind: 'turn-end' })
    const result = await promise
    assert.equal(result.message, 'Merged both intents.')
    assert.equal(typeof result.agentId, 'string')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('assist stops the fixer when the turn never ends', async () => {
  const f = await fixture('assist-timeout')
  try {
    const copyPath = path.join(f.root, 'fixer-copy')
    await fs.cp(f.projectPath, copyPath, { recursive: true })
    const refused = (error) => error instanceof ArtelError && error.status === 504 && error.code === 'artel/assist-timeout'
    await assert.rejects(
      () => f.engine.assist({ projectPath: f.projectPath, copyPath, prompt: 'Resolve the conflict', timeoutMs: 20 }),
      refused,
      'a fixer that never finishes must not wait for ever',
    )
    assert.deepEqual(f.driver.interrupted, ['Fixer'], 'the fixer session is interrupted')
    assert.equal(f.driver.created[0].listeners.size, 0, 'the engine stops listening to the fixer')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('repairArtifact only accepts an assembled Orchestrator run', async () => {
  const f = await fixture('repair-guard')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer' })
    await assert.rejects(
      () => f.engine.repairArtifact(run.id, { prompt: 'fix it' }),
      (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/bad-mode',
      'a solo run has no Orchestrator assembly to repair',
    )
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('repairArtifact sends one fixer to the assembled copy and refreshes the changes', async () => {
  const f = await fixture('repair-fixer')
  try {
    const run = await planOrchestrator(f)
    const p1 = path.join(f.copyRoot, `${run.id}-p1`)
    const p2 = path.join(f.copyRoot, `${run.id}-p2`)
    await fs.writeFile(path.join(p1, 'src', 'app.js'), 'export const answer = 2\n')
    await runTurn(f.driver, f.driver.handleFor('Orion'), 'Changed the answer to 2.')
    await runTurn(f.driver, f.driver.handleFor('Lyra'), 'VERDICT: accept — done.')
    await fs.writeFile(path.join(p2, 'README.md'), '# Demo\n\nThe answer is 2.\n')
    await runTurn(f.driver, f.driver.handleFor('Atlas'), 'Documented the answer.')
    await runTurn(f.driver, f.driver.handleFor('Nova'), 'VERDICT: accept — done.')
    assert.equal(latestRun(f).status, 'waiting')
    assert.equal(latestRun(f).changeCount, 2)

    const fixing = f.engine.repairArtifact(run.id, { prompt: 'The check fails: the answer must be 3.', purpose: 'check' })
    // The fixer is created and prompted through the same async path as a run
    // agent, so wait until the prompt reached the driver.
    for (let attempt = 0; attempt < 200 && !(f.driver.prompts.at(-1)?.text ?? '').includes('the answer must be 3'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const fixer = f.driver.created.at(-1)
    const fixerRecord = latestRun(f).agents.at(-1)
    assert.equal(fixerRecord.role, 'fixer')
    assert.equal(fixer.name, fixerRecord.name)
    assert.equal(fixer.copyPath, run.copyPath, 'the fixer edits the assembly the user is reviewing')
    assert.match(f.driver.prompts.at(-1).text, /the answer must be 3/)
    await assert.rejects(
      () => f.engine.repairArtifact(run.id, { prompt: 'again' }),
      (error) => error instanceof ArtelError && error.status === 409 && error.code === 'artel/fixer-busy',
      'only one fixer may work on the assembly',
    )

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    await runTurn(f.driver, fixer, 'Changed the answer to 3.')
    const result = await fixing
    assert.equal(result.agentId, fixerRecord.id)
    assert.equal(result.changeCount, 2, 'the assembled copy still changes two files')
    assert.equal(latestRun(f).changeCount, 2)
    assert.ok((await feedOf(f, run.id)).some((event) => event.kind === 'status' && event.text === 'The fixer updated 2 file(s).'))
    assert.equal(latestRun(f).status, 'waiting', 'the run stays reviewable after the repair')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})
