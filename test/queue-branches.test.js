import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { QueueRunner } from '../lib/queue-runner.js'
import { QueueStore } from '../lib/queue.js'

/**
 * Poll a predicate until it returns a truthy value.
 * @param {() => unknown | Promise<unknown>} predicate - the check.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<unknown>} the truthy value.
 */
async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the queue')
}

/**
 * Build one isolated branch-queue fixture.
 * @param {{ empty?: boolean }} [options] - whether the agent makes a change.
 * @returns {Promise<object>} fixture.
 */
async function fixture({ empty = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-queue-branches-'))
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()

  let count = 0
  const engine = {
    projectPath,
    copyRoot,
    starts: [],
    marked: [],
    changesByRun: new Map(),
    runs: new Map(),
    async start(request) {
      count += 1
      const id = `run-${count}`
      const copyPath = path.join(copyRoot, id)
      await fs.cp(request.basePath ?? projectPath, copyPath, { recursive: true })
      if (empty !== true) {
        const file = path.join(copyPath, 'src', 'app.js')
        const existing = await fs.readFile(file, 'utf8')
        await fs.writeFile(file, existing.replace(/answer = \d+/, `answer = ${count + 1}`))
      }
      const run = {
        id,
        sessionId: request.sessionId,
        mode: request.mode,
        task: request.task,
        projectPath: request.projectPath,
        copyPath,
        basePath: request.basePath,
        isolate: request.isolateFromBase === true,
        // The fake agent is finished as soon as its copy is laid down: the next
        // pump tick collects the changes, the way a real engine would report them.
        status: 'finished',
        changeCount: empty === true ? 0 : 1,
        autoqueue: true,
      }
      engine.runs.set(id, run)
      engine.starts.push(request)
      engine.changesByRun.set(id, empty === true ? [] : [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1 }])
      return run
    },
    getRun(runId) {
      const run = engine.runs.get(runId)
      if (!run) throw new Error('run lost')
      return run
    },
    listRuns() {
      return [...engine.runs.values()]
    },
    async changes(runId) {
      return engine.changesByRun.get(runId) ?? []
    },
    readFeed() {
      return { events: [], cursor: 0 }
    },
    async message() {},
    async interrupt(runId) {
      const run = engine.runs.get(runId)
      if (run && run.status === 'running') run.status = 'interrupted'
    },
    async markCommitted(runId, info) {
      engine.marked.push({ runId, ...info })
      const run = engine.runs.get(runId)
      if (run) {
        run.commit = info.commit
        run.status = 'waiting'
      }
    },
  }

  const runner = new QueueRunner({ engine, store, stateDir, copyRoot, log: { warn() {} } })
  await runner.init()
  await store.ensure('s1', { projectPath })
  await runner.ensureBranches('s1')
  return {
    root,
    stateDir,
    projectPath,
    store,
    runner,
    engine,
    /**
     * Turn the queue on: doing it before the tasks exist would end an empty
     * queue immediately, so every test calls this after adding its tasks.
     * @returns {Promise<object>} the toggle result.
     */
    auto: () => runner.setAutopilot({ sessionId: 's1', projectPath, autopilot: true, decisions: true, checkDisabled: true }),
    /**
     * Stop the pump and remove the fixture directory.
     * @returns {Promise<void>} resolves when clean.
     */
    cleanup: async () => {
      runner.dispose()
      // A pump tick can still be writing under state/queue when dispose()
      // returns, so Windows may report ENOTEMPTY while the tree is removed.
      await fs
        .rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => {})
    },
  }
}

test('the first branch task starts from the applied commit and becomes a commit', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    const queued = await fx.store.get('s1')
    assert.equal(queued.branches.length, 1)
    assert.equal(queued.currentBranchId, queued.branches[0].id)
    assert.equal(queued.tasks[0].branchId, queued.branches[0].id)

    await fx.auto()
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'passed')

    const queue = await fx.store.get('s1')
    const task = queue.tasks[0]
    const branch = queue.branches[0]
    assert.match(task.commit, /^[0-9a-f]{40}$/)
    assert.equal(branch.tipCommit, task.commit)
    assert.equal(fx.engine.starts[0].isolateFromBase, true)
    assert.notEqual(fx.engine.starts[0].basePath, fx.projectPath)
    assert.equal(fx.engine.starts[0].branchId, branch.id)
    assert.equal(fx.engine.starts[0].parentCommit, branch.baseCommit)
    assert.equal(fx.engine.marked.length, 1)
    assert.equal(fx.engine.marked[0].parentCommit, branch.baseCommit)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')

    const { git } = await fx.runner.ensureBranches('s1')
    const [entry] = await git.log(branch.ref, { max: 1 })
    assert.equal(entry.subject, 'Answer two')
  } finally {
    await fx.cleanup()
  }
})

test('the next task starts from the branch tip and commits on top of the previous one', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    await fx.auto()
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'passed')
    const first = (await fx.store.get('s1')).tasks[0]

    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer three'], mode: 'solo' })
    await fx.auto()
    await waitFor(async () => (await fx.store.get('s1')).tasks[1].status === 'passed')

    const queue = await fx.store.get('s1')
    const second = queue.tasks[1]
    assert.match(second.commit, /^[0-9a-f]{40}$/)
    assert.equal(fx.engine.starts[1].parentCommit, first.commit)
    assert.equal(fx.engine.starts[1].branchId, first.branchId)
    assert.equal(fx.engine.marked[1].parentCommit, first.commit)

    const { git } = await fx.runner.ensureBranches('s1')
    const [entry] = await git.log(second.commit, { max: 1 })
    assert.deepEqual(entry.parents, [first.commit])
    assert.equal(queue.branches[0].tipCommit, second.commit)
  } finally {
    await fx.cleanup()
  }
})

test('addTasks() puts a task on the chosen branch without switching the current one', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    const original = (await fx.store.get('s1')).branches[0]
    const second = await fx.runner.createBranch('s1', { name: 'Second', switchTo: false })
    assert.notEqual(second.branch.id, original.id)

    await fx.runner.addTasks({
      sessionId: 's1',
      projectPath: fx.projectPath,
      task: 'On branch two',
      branchId: second.branch.id,
    })
    const queue = await fx.store.get('s1')
    assert.equal(queue.tasks.length, 2)
    assert.equal(queue.tasks[1].branchId, second.branch.id)
    assert.equal(queue.currentBranchId, original.id)
  } finally {
    await fx.cleanup()
  }
})

test('addTasks() refuses an unknown branch id and adds no task', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    const error = await fx.runner
      .addTasks({ sessionId: 's1', projectPath: fx.projectPath, task: 'Lost', branchId: 'missing-branch' })
      .then(() => null, (failure) => failure)
    assert.ok(error instanceof Error)
    assert.equal(error.status, 409)
    assert.equal(error.code, 'artel/branch-missing')
    assert.equal((await fx.store.get('s1')).tasks.length, 1)
  } finally {
    await fx.cleanup()
  }
})

test('maintenance, revertApply and exportBranch delegate to the branch service', async () => {
  const fx = await fixture()
  try {
    const maintenance = await fx.runner.maintenance('s1')
    assert.equal(typeof maintenance.before.objects, 'number')
    assert.equal(typeof maintenance.after.objects, 'number')
    assert.equal(typeof maintenance.freedBytes, 'number')
    assert.ok(maintenance.freedBytes >= 0)

    const revert = await fx.runner.revertApply('s1', {}).then(() => null, (failure) => failure)
    assert.equal(revert.status, 409)
    assert.equal(revert.code, 'artel/nothing-to-revert')

    const second = await fx.runner.createBranch('s1', { name: 'Second', switchTo: false })
    const exported = await fx.runner
      .exportBranch('s1', { branchId: second.branch.id })
      .then(() => null, (failure) => failure)
    assert.equal(exported.status, 409)
    assert.equal(exported.code, 'artel/not-a-git-project')
  } finally {
    await fx.cleanup()
  }
})

test('a branch task that changed nothing is parked and never committed', async () => {
  const fx = await fixture({ empty: true })
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Do nothing'], mode: 'solo' })
    await fx.auto()
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'parked')

    const queue = await fx.store.get('s1')
    assert.equal(queue.tasks[0].commit, null)
    assert.equal(queue.branches[0].tipCommit, null)
    assert.equal(fx.engine.marked.length, 0)
    assert.match(queue.tasks[0].reason, /ничего не изменил/i)
  } finally {
    await fx.cleanup()
  }
})
