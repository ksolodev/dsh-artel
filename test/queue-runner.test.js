import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { QueueRunner } from '../lib/queue-runner.js'
import { QueueStore } from '../lib/queue.js'
import { autoAnswerPrompt } from '../lib/prompts.js'

/**
 * Poll a predicate until it returns a truthy value.
 * @param {() => unknown | Promise<unknown>} predicate - the check.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<unknown>} the truthy value.
 */
async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * A fake engine that records calls and lets a test drive the run lifecycle.
 */
class FakeEngine {
  /**
   * @param {{ copyRoot: string }} options - where the copies live.
   */
  constructor({ copyRoot }) {
    this.copyRoot = copyRoot
    this.calls = []
    this.runs = new Map()
    this.feeds = new Map()
    this.changesByRun = new Map()
    this.started = []
    this.nextId = 0
    this.defaultChanges = [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1 }]
  }

  /**
   * Start a run and lay down its copy.
   * @param {object} request - the start request.
   * @returns {Promise<object>} run summary.
   */
  async start(request) {
    this.calls.push({ method: 'start', request })
    const run = await this.#newRun(request)
    this.started.push(run)
    return this.#summary(run)
  }

  /**
   * Seed a run that the runner only observes (a pending version).
   * @param {object} fields - run fields.
   * @returns {Promise<object>} run summary.
   */
  async seedRun({ sessionId = 's1', status = 'waiting', changeCount = 1, task = 'Old work', error = null } = {}) {
    const run = await this.#newRun({ sessionId, mode: 'solo', task, projectPath: null, basePath: null })
    run.status = status
    run.changeCount = changeCount
    run.error = error
    return this.#summary(run)
  }

  /**
   * Create a run and its copy directory.
   * @param {object} request - start-like request.
   * @returns {Promise<object>} run record.
   */
  async #newRun(request) {
    const id = `run-${(this.nextId += 1)}`
    const copyPath = path.join(this.copyRoot, id)
    await fs.mkdir(path.join(copyPath, 'src'), { recursive: true })
    await fs.writeFile(path.join(copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    const run = {
      id,
      sessionId: request.sessionId,
      mode: request.mode ?? 'solo',
      task: request.task ?? '',
      projectPath: request.projectPath ?? null,
      copyPath,
      basePath: request.basePath ?? null,
      status: 'running',
      error: null,
      changeCount: 0,
      autoqueue: request.autoqueue === true,
    }
    this.runs.set(id, run)
    this.feeds.set(id, [])
    this.changesByRun.set(id, [...this.defaultChanges])
    return run
  }

  /**
   * The stored run as a summary the runner can read.
   * @param {object} run - run record.
   * @returns {object} summary.
   */
  #summary(run) {
    return { ...run }
  }

  /**
   * @param {string} id - run id.
   * @returns {object} run summary.
   */
  getRun(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`unknown run ${id}`)
    return this.#summary(run)
  }

  /**
   * @param {string} sessionId - session id.
   * @returns {object[]} run summaries.
   */
  listRuns(sessionId) {
    return [...this.runs.values()].filter((run) => !sessionId || run.sessionId === sessionId).map((run) => this.#summary(run))
  }

  /**
   * @param {string} id - run id.
   * @param {{ cursor?: number }} options - read options.
   * @returns {Promise<{ runId: string, events: object[], cursor: number }>} feed page.
   */
  async readFeed(id, { cursor = 0 } = {}) {
    const events = this.feeds.get(id) ?? []
    return { runId: id, events: events.slice(cursor), cursor: events.length }
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<object[]>} changes.
   */
  async changes(id) {
    return [...(this.changesByRun.get(id) ?? [])]
  }

  /**
   * @param {string} id - run id.
   * @param {{ text: string }} message - prompt.
   * @returns {Promise<void>} resolves after the prompt.
   */
  async message(id, message) {
    this.calls.push({ method: 'message', runId: id, text: message?.text ?? '' })
    const run = this.runs.get(id)
    if (run) run.status = 'running'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the interrupt.
   */
  async interrupt(id) {
    this.calls.push({ method: 'interrupt', runId: id })
    const run = this.runs.get(id)
    if (run && run.status === 'running') run.status = 'interrupted'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the apply.
   */
  async apply(id) {
    this.calls.push({ method: 'apply', runId: id })
    const run = this.runs.get(id)
    if (run) run.status = 'applied'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the discard.
   */
  async discard(id) {
    this.calls.push({ method: 'discard', runId: id })
    const run = this.runs.get(id)
    if (run) run.status = 'discarded'
  }

  /**
   * Set the run status and extra fields.
   * @param {string} id - run id.
   * @param {string} status - new status.
   * @param {object} [extra] - extra fields.
   */
  setStatus(id, status, extra = {}) {
    const run = this.runs.get(id)
    Object.assign(run, { status }, extra)
  }

  /**
   * Set what `changes()` returns for a run.
   * @param {string} id - run id.
   * @param {object[]} changes - change entries.
   */
  setChanges(id, changes) {
    this.changesByRun.set(id, changes)
  }

  /**
   * Append one feed event.
   * @param {string} id - run id.
   * @param {object} event - feed event.
   */
  pushFeed(id, event) {
    const feed = this.feeds.get(id)
    feed.push({ seq: feed.length + 1, kind: 'status', text: '', ...event })
  }

  /**
   * All recorded calls of one kind.
   * @param {string} method - method name.
   * @returns {object[]} calls.
   */
  findCall(method) {
    return this.calls.filter((call) => call.method === method)
  }

  /**
   * The last recorded call of one kind.
   * @param {string} method - method name.
   * @returns {object | undefined} call.
   */
  lastCall(method) {
    const calls = this.findCall(method)
    return calls[calls.length - 1]
  }
}

/**
 * Build one isolated queue fixture.
 * @param {string} name - fixture name.
 * @param {{ clock?: { value: number } }} [options] - optional clock.
 * @returns {Promise<object>} fixture.
 */
async function fixture(name, options = {}) {
  const root = path.join(process.cwd(), 'test', '.tmp', `queue-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  const projectPath = path.join(root, 'project')
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  const clock = options.clock ?? { value: Date.now() }
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }))
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(copyRoot, { recursive: true })
  const engine = new FakeEngine({ copyRoot })
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()
  const runner = new QueueRunner({ engine, store, stateDir, copyRoot, now: () => clock.value, tuning: { pollMs: 10, checkTimeoutMs: 5000 } })
  return {
    root,
    projectPath,
    stateDir,
    copyRoot,
    engine,
    store,
    runner,
    clock,
    /**
     * Read the current queue summary.
     * @returns {Promise<object>} summary.
     */
    summary: () => runner.summary('s1', { projectPath }),
    /**
     * Stop the pump and remove the fixture directory.
     * @returns {Promise<void>} resolves when clean.
     */
    cleanup: async () => {
      runner.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test('queue summary reports counts and progress, addTasks fills the queue', async () => {
  const f = await fixture('summary')
  try {
    const empty = await f.summary()
    assert.equal(empty.sessionId, 's1')
    assert.equal(empty.projectPath, f.projectPath)
    assert.equal(empty.counts.total, 0)
    assert.equal(empty.autopilot, false)
    assert.equal(empty.progress.text, 'В очереди · 0')
    assert.equal(empty.progress.key, 'queue.progress.queued')
    assert.deepEqual(empty.progress.params, { queued: 0 })

    const added = await f.runner.addTasks({
      sessionId: 's1',
      projectPath: f.projectPath,
      texts: ['Add a settings screen\nwith a dark theme', 'Fix the header'],
      task: 'Write the docs',
      mode: 'swarm',
    })
    assert.equal(added.added, 3)
    assert.equal(added.queue.counts.total, 3)
    assert.equal(added.queue.counts.queued, 3)
    assert.deepEqual(
      added.queue.tasks.map((task) => task.title),
      ['Add a settings screen', 'Fix the header', 'Write the docs'],
    )
    assert.equal(added.queue.tasks[0].mode, 'swarm')
    assert.equal(added.queue.progress.text, 'В очереди · 3')
    assert.equal(added.queue.progress.key, 'queue.progress.queued')
    assert.deepEqual(added.queue.progress.params, { queued: 3 })

    const prepended = await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['First now'], prepend: true })
    assert.equal(prepended.added, 1)
    assert.equal(prepended.queue.tasks[0].title, 'First now')

    // «Доработать» seeds a task from an existing version copy instead of the last one.
    const seeded = await f.runner.addTasks({
      sessionId: 's1',
      projectPath: f.projectPath,
      task: 'Rework the version',
      basePath: 'C:\\work\\copies\\run-1',
    })
    assert.equal(seeded.added, 1)
    assert.equal(seeded.queue.tasks.at(-1).title, 'Rework the version')
    assert.equal(f.store.get('s1').tasks.at(-1).basePath, 'C:\\work\\copies\\run-1')

    const none = await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: [], task: '   ' })
    assert.equal(none.added, 0)
    assert.equal(none.queue.counts.total, 5)
  } finally {
    await f.cleanup()
  }
})

test('preflight reports pending versions, the guessed check command and the limit', async () => {
  const f = await fixture('preflight')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Ship it'] })
    const pending = await f.engine.seedRun({ sessionId: 's1', status: 'waiting', changeCount: 2, task: 'Rework the theme' })
    await f.engine.seedRun({ sessionId: 's1', status: 'running', changeCount: 1, task: 'Live work' })
    await f.engine.seedRun({ sessionId: 's1', status: 'finished', changeCount: 0, task: 'Clean work' })

    const preflight = await f.runner.preflight('s1', { projectPath: f.projectPath })
    assert.equal(preflight.limit, 20)
    assert.equal(preflight.pendingVersions.length, 1)
    assert.equal(preflight.pendingVersions[0].runId, pending.id)
    assert.equal(preflight.pendingVersions[0].changeCount, 2)
    assert.equal(preflight.pendingVersions[0].title, 'Rework the theme')
    assert.equal(preflight.busy, true)
    assert.equal(preflight.taskCount, 1)
    assert.equal(preflight.check.command, 'npm test')
    assert.equal(preflight.check.guessed, true)
    assert.equal(preflight.check.disabled, false)
    assert.ok(preflight.diskBytes === null || typeof preflight.diskBytes === 'number')
  } finally {
    await f.cleanup()
  }
})

test('setAutopilot starts the pump with autoqueue and no base version', async () => {
  const f = await fixture('autopilot-start')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Do the thing'] })
    const result = await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      checkCommand: 'node -e "process.exit(0)"',
    })
    assert.equal(result.blocked, null)
    assert.equal(result.queue.autopilot, true)
    assert.equal(result.queue.stopReason, null)

    const start = await waitFor(() => f.engine.lastCall('start'))
    assert.equal(start.request.autoqueue, true)
    assert.equal(start.request.basePath, null)
    assert.equal(start.request.mode, 'solo')
    assert.equal(start.request.task, 'Do the thing')
    assert.equal(start.request.sessionId, 's1')
    assert.equal(start.request.projectPath, f.projectPath)

    const summary = await f.summary()
    assert.equal(summary.progress.running, true)
    assert.match(summary.progress.text, /^Автоочередь идёт · 0 из 1$/)
    assert.equal(summary.progress.key, 'queue.progress.auto')
    assert.deepEqual(summary.progress.params, { done: 0, total: 1 })
  } finally {
    await f.cleanup()
  }
})

test('setAutopilot blocks on pending versions until a decision is made', async () => {
  const f = await fixture('autopilot-blocked')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Change the palette'] })
    const pending = await f.engine.seedRun({ sessionId: 's1', status: 'waiting', changeCount: 3, task: 'Change the palette' })

    const blocked = await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true })
    assert.ok(blocked.blocked !== null)
    assert.equal(blocked.blocked.pendingVersions.length, 1)
    assert.equal(blocked.blocked.pendingVersions[0].runId, pending.id)
    assert.equal(blocked.queue.autopilot, false)
    assert.equal(f.engine.findCall('start').length, 0, 'the pump does not start before the decision')

    const allowed = await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      decisions: true,
      saveVersionRunIds: [pending.id],
    })
    assert.equal(allowed.blocked, null)
    assert.equal(allowed.queue.autopilot, true)
    assert.equal(allowed.queue.lastVersion.runId, pending.id)
    assert.equal(allowed.queue.lastVersion.path, pending.copyPath)

    const start = await waitFor(() => f.engine.lastCall('start'))
    assert.equal(start.request.basePath, pending.copyPath)
    assert.equal(start.request.autoqueue, true)
  } finally {
    await f.cleanup()
  }
})

test('setAutopilot can postpone a version instead of saving it', async () => {
  const f = await fixture('autopilot-postpone')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Rework the header'] })
    const pending = await f.engine.seedRun({ sessionId: 's1', status: 'finished', changeCount: 1, task: 'Rework the header' })

    const allowed = await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      decisions: true,
      postponeVersionRunIds: [pending.id],
      checkCommand: 'node -e "process.exit(0)"',
    })
    assert.equal(allowed.blocked, null)
    assert.equal(allowed.queue.lastVersion, null)

    const start = await waitFor(() => f.engine.lastCall('start'))
    assert.equal(start.request.basePath, null)

    const preflight = await f.runner.preflight('s1', { projectPath: f.projectPath })
    assert.equal(preflight.pendingVersions.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a passing check marks the task passed, saves the version and continues', async () => {
  const f = await fixture('check-pass')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['First task', 'Second task'] })
    await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      checkCommand: 'node -e "process.exit(0)"',
    })
    const start = await waitFor(() => f.engine.findCall('start')[0])
    const first = f.engine.started.find((run) => run.task === 'First task')
    assert.ok(first)
    assert.equal(start.request.task, 'First task')

    f.engine.setStatus(first.id, 'finished', { changeCount: 1 })
    const task = await waitFor(async () => {
      const summary = await f.summary()
      return summary.tasks[0].status === 'passed' ? summary.tasks[0] : null
    })
    assert.equal(task.check.ok, true)
    assert.equal(task.check.skipped, false)
    assert.equal(task.changeCount, 1)
    assert.deepEqual(task.files, ['src/app.js'])

    const summary = await f.summary()
    assert.equal(summary.lastVersion.runId, first.id)
    assert.equal(summary.lastVersion.path, first.copyPath)
    assert.equal(summary.counts.passed, 1)

    const passedEvent = await waitFor(async () => {
      const current = await f.summary()
      return current.events.find((event) => event.kind === 'passed') ?? null
    })
    assert.equal(passedEvent.key, passedEvent.params.commit === '' ? 'queue.event.passed' : 'queue.event.passed.commit')
    assert.equal(passedEvent.params.title, 'First task')
    assert.equal(passedEvent.params.count, 1)
    assert.equal(typeof passedEvent.params.commit, 'string')
    assert.equal(passedEvent.text.startsWith('Версия готова: First task · 1 файл(ов)'), true)
    assert.ok(summary.events.some((event) => event.key === 'queue.event.autopilot-on'))
    assert.ok(summary.events.some((event) => event.key === 'queue.event.check-command'))
    assert.ok(summary.events.some((event) => event.key === 'queue.event.started'))

    const second = await waitFor(() => f.engine.findCall('start')[1])
    assert.equal(second.request.task, 'Second task')
    assert.equal(second.request.basePath, first.copyPath)
  } finally {
    await f.cleanup()
  }
})

test('a failing check asks for repairs and parks the task after two fixes', async () => {
  const f = await fixture('check-fail')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Break the build'] })
    await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      checkCommand: 'node -e "process.exit(1)"',
    })
    const run = await waitFor(() => f.engine.started[0])
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      f.engine.setStatus(run.id, 'finished', { changeCount: 1 })
      const message = await waitFor(() => {
        const calls = f.engine.findCall('message')
        return calls.length >= attempt ? calls[attempt - 1] : null
      })
      assert.match(message.text, new RegExp(`fix attempt ${attempt} of 2`))
      assert.match(message.text, /process\.exit\(1\)/)
      assert.equal(message.runId, run.id)
    }

    f.engine.setStatus(run.id, 'finished', { changeCount: 1 })
    const task = await waitFor(async () => {
      const summary = await f.summary()
      return summary.tasks[0].status === 'parked' ? summary.tasks[0] : null
    })
    assert.match(task.reason, /после 2 починок/)
    assert.equal(task.reasonKey, 'queue.reason.check-failed')
    assert.deepEqual(task.reasonParams, { count: 2 })
    assert.equal(task.fixes, 2)
    assert.equal(f.engine.findCall('interrupt').length, 1)
    assert.equal(f.engine.findCall('message').length, 2)
  } finally {
    await f.cleanup()
  }
})

test('a first question gets the auto-answer, a second one parks the task', async () => {
  const f = await fixture('questions')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Add the export button'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    f.engine.pushFeed(run.id, { kind: 'assistant', text: 'Which database should I use for this project?' })
    const message = await waitFor(() => f.engine.lastCall('message'))
    assert.equal(message.text, autoAnswerPrompt())
    const answered = await waitFor(async () => {
      const summary = await f.summary()
      return summary.tasks[0].questions === 1 ? summary : null
    })
    assert.ok(answered)

    f.engine.pushFeed(run.id, { kind: 'assistant', text: 'Should I also update the deployment scripts?' })
    const task = await waitFor(async () => {
      const summary = await f.summary()
      return summary.tasks[0].status === 'parked' ? summary.tasks[0] : null
    })
    assert.match(task.reason, /второй вопрос/)
    assert.equal(task.reasonKey, 'queue.reason.second-question')
    assert.equal(f.engine.findCall('interrupt')[0].runId, run.id)
  } finally {
    await f.cleanup()
  }
})

test('outward text in the feed parks the task instead of shipping', async () => {
  const f = await fixture('outward')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Publish the change'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    f.engine.pushFeed(run.id, { kind: 'assistant', text: 'I will git push origin main to publish it.' })
    const task = await waitFor(async () => {
      const summary = await f.summary()
      return summary.tasks[0].status === 'parked' ? summary.tasks[0] : null
    })
    assert.match(task.reason, /наружу/)
    assert.match(task.reason, /git push/)
    assert.equal(task.reasonKey, 'queue.reason.outward')
    assert.match(task.reasonParams.detail, /git push/)
    assert.equal(f.engine.findCall('interrupt').length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a failed run with auth text finishes the queue with login-lost', async () => {
  const f = await fixture('login-lost')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Do the work'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    f.engine.setStatus(run.id, 'failed', { error: 'Not authenticated: login required.' })
    const summary = await waitFor(async () => {
      const current = await f.summary()
      return current.stopReason === 'login-lost' ? current : null
    })
    assert.equal(summary.autopilot, false)
    assert.equal(summary.tasks[0].status, 'queued')
    assert.match(summary.tasks[0].reason, /не авторизован/)
    assert.equal(summary.tasks[0].reasonKey, 'queue.reason.login-lost')
    assert.equal(summary.results.stopKey, 'queue.stop.login-lost')
    assert.equal(summary.results.stopReason, 'login-lost')
    assert.equal(summary.results.passed.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('a rate-limited run is requeued with retryAt and the queue continues later', async () => {
  const f = await fixture('rate-limit')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Do the work'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    f.engine.setStatus(run.id, 'failed', { error: 'Rate limit reached: resets in 30 minutes.' })
    const waiting = await waitFor(async () => {
      const current = await f.summary()
      return current.retryAt !== null ? current : null
    })
    assert.equal(waiting.autopilot, true)
    assert.equal(waiting.tasks[0].status, 'queued')
    assert.match(waiting.tasks[0].reason, /лимит/)
    assert.equal(waiting.tasks[0].reasonKey, 'queue.reason.rate-limit')
    assert.ok(waiting.retryAt > f.clock.value)

    f.clock.value = waiting.retryAt + 1000
    const second = await waitFor(() => f.engine.findCall('start')[1])
    assert.equal(second.request.task, 'Do the work')
    const resumed = await waitFor(async () => {
      const current = await f.summary()
      return current.retryAt === null ? current : null
    })
    assert.equal(resumed.tasks[0].status, 'running')
  } finally {
    await f.cleanup()
  }
})

test('stop parks the running task and finishes with stopped', async () => {
  const f = await fixture('stop')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Long task'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    const summary = await f.runner.stop('s1')
    assert.equal(summary.stopReason, 'stopped')
    assert.equal(summary.autopilot, false)
    assert.equal(summary.tasks[0].status, 'parked')
    assert.match(summary.tasks[0].reason, /Вы остановили автоочередь/)
    assert.equal(summary.tasks[0].reasonKey, 'queue.reason.stopped')
    assert.equal(summary.results.stopKey, 'queue.stop.stopped')
    assert.equal(f.engine.findCall('interrupt')[0].runId, run.id)
    assert.equal(summary.results.stopReason, 'stopped')
  } finally {
    await f.cleanup()
  }
})

test('finishAfterCurrent lets the running task settle before finishing', async () => {
  const f = await fixture('after-current')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['Last task'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })
    const run = await waitFor(() => f.engine.started[0])

    const pending = await f.runner.finishAfterCurrent('s1')
    assert.equal(pending.stopAfterCurrent, true)
    assert.equal(pending.autopilot, false)
    assert.equal(pending.stopReason, null)

    f.engine.setStatus(run.id, 'finished', { changeCount: 1 })
    const summary = await waitFor(async () => {
      const current = await f.summary()
      return current.stopReason === 'after-current' ? current : null
    })
    assert.equal(summary.tasks[0].status, 'passed')
    assert.equal(summary.tasks[0].runId, run.id)
  } finally {
    await f.cleanup()
  }
})

test('retryTask, moveTask, removeTask and clearFinished edit the queue', async () => {
  const f = await fixture('edits')
  try {
    const added = await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['A', 'B', 'C'] })
    const [a, b, c] = added.queue.tasks.map((task) => task.id)

    const moved = await f.runner.moveTask('s1', c, { direction: 'up' })
    assert.deepEqual(moved.tasks.map((task) => task.title), ['A', 'C', 'B'])
    const unchanged = await f.runner.moveTask('s1', a, { direction: 'up' })
    assert.deepEqual(unchanged.tasks.map((task) => task.title), ['A', 'C', 'B'])
    const down = await f.runner.moveTask('s1', a, { direction: 'down' })
    assert.deepEqual(down.tasks.map((task) => task.title), ['C', 'A', 'B'])

    await f.store.updateTask('s1', c, { status: 'parked', reason: 'test parked' })
    const cleared = await f.runner.clearFinished('s1')
    assert.deepEqual(cleared.tasks.map((task) => task.title), ['A', 'B'])

    await f.store.updateTask('s1', a, { status: 'parked', reason: 'test parked' })
    const retried = await f.runner.retryTask('s1', a)
    assert.equal(retried.tasks.find((task) => task.id === a).status, 'queued')
    assert.equal(retried.tasks.find((task) => task.id === a).reason, null)

    const removed = await f.runner.removeTask('s1', b)
    assert.equal(removed.counts.total, 1)
    assert.equal(removed.tasks[0].id, a)
  } finally {
    await f.cleanup()
  }
})

test('the limit stops the pump after the allowed number of tasks', async () => {
  const f = await fixture('limit')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['First', 'Second'] })
    await f.runner.setAutopilot({
      sessionId: 's1',
      projectPath: f.projectPath,
      autopilot: true,
      limit: 1,
      checkCommand: 'node -e "process.exit(0)"',
    })
    const run = await waitFor(() => f.engine.started[0])
    f.engine.setStatus(run.id, 'finished', { changeCount: 1 })

    const summary = await waitFor(async () => {
      const current = await f.summary()
      return current.stopReason === 'limit' ? current : null
    })
    assert.equal(summary.counts.passed, 1)
    assert.equal(summary.counts.queued, 1)
    assert.equal(f.engine.findCall('start').length, 1)
    assert.equal(summary.results.notTaken.length, 1)
    assert.equal(summary.results.stopKey, 'queue.stop.limit')
  } finally {
    await f.cleanup()
  }
})

test('three consecutive parks stop the queue with parks', async () => {
  const f = await fixture('parks')
  try {
    await f.runner.addTasks({ sessionId: 's1', projectPath: f.projectPath, texts: ['One', 'Two', 'Three'] })
    await f.runner.setAutopilot({ sessionId: 's1', projectPath: f.projectPath, autopilot: true, checkCommand: 'node -e "process.exit(0)"' })

    for (let index = 0; index < 3; index += 1) {
      // started[] is filled after the call is recorded, so wait for the run
      // itself instead of the call log before reading its id.
      const run = await waitFor(() => f.engine.started[index])
      f.engine.setChanges(run.id, [])
      f.engine.setStatus(run.id, 'finished', { changeCount: 0 })
      await waitFor(async () => {
        const current = await f.summary()
        return current.tasks[index].status === 'parked' ? current : null
      })
    }

    const summary = await waitFor(async () => {
      const current = await f.summary()
      return current.stopReason === 'parks' ? current : null
    })
    assert.equal(summary.counts.parked, 3)
    assert.equal(summary.counts.queued, 0)
    assert.equal(f.engine.findCall('start').length, 3)
    assert.equal(summary.results.stopText.length > 0, true)
    assert.equal(summary.results.stopKey, 'queue.stop.parks')
    assert.equal(summary.results.stopText, 'Три задачи подряд ушли в «Отложенное».')
  } finally {
    await f.cleanup()
  }
})
