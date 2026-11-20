import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QueueRunner } from '../lib/queue-runner.js'
import { QueueStore } from '../lib/queue.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error('waitFor: the expected state did not arrive in time')
}

async function makeProject(root) {
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n', 'utf8')
  return projectPath
}

async function fixture({ runs = [], checkCommand = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-queue-migration-'))
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  const projectPath = await makeProject(root)
  const engine = {
    starts: [],
    repairs: [],
    messages: [],
    runs: new Map(),
    changes: async () => [],
    listRuns: () => runs,
    async start(request) {
      const id = `run-${engine.starts.length + 1}`
      const copyPath = path.join(copyRoot, id)
      await fs.cp(request.basePath ?? projectPath, copyPath, { recursive: true })
      engine.starts.push(request)
      const run = {
        id,
        sessionId: request.sessionId,
        mode: request.mode,
        task: request.task,
        projectPath: request.projectPath,
        copyPath,
        basePath: request.basePath,
        // A run the queue sees idle must be in a finished status: the check is
        // settled when the engine says the agents are done.
        status: request.mode === 'orchestrator' ? 'waiting' : 'running',
        changeCount: 1,
        autoqueue: true,
      }
      engine.runs.set(id, run)
      engine.changes = async () => [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1 }]
      return run
    },
    getRun(runId) {
      const run = engine.runs.get(runId)
      if (run === undefined) throw new Error(`unknown run ${runId}`)
      return run
    },
    readFeed: () => ({ events: [], cursor: 0 }),
    async message(runId, input) {
      engine.messages.push({ runId, input })
    },
    async repairArtifact(runId, input) {
      engine.repairs.push({ runId, input })
      const run = engine.runs.get(runId)
      if (run !== undefined) run.status = 'waiting'
    },
    async interrupt() {},
    async markCommitted(runId) {
      const run = engine.runs.get(runId)
      if (run !== undefined) run.status = 'applied'
    },
    config: { excludeGlobs: [] },
  }
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()
  await store.ensure('s1', { projectPath })
  // A queue file written by Автоочередь 0.10 has no branch-model fields at all:
  // createQueueRecord hands every new queue the branch model, so strip those
  // fields to keep these tests about a real migration of an old queue.
  await store.patch('s1', { model: undefined, project: undefined, currentBranchId: undefined, branches: undefined })
  if (checkCommand !== '') await store.patch('s1', { checkCommand })
  const runner = new QueueRunner({ engine, store, stateDir, copyRoot, log: { warn() {} } })
  return {
    root,
    stateDir,
    copyRoot,
    projectPath,
    store,
    runner,
    engine,
    async cleanup() {
      runner.dispose()
      // Git on Windows may still hold the bare repository for a moment.
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    },
  }
}

test('a legacy queue upgrades to the branch model and imports its saved version', async () => {
  const fx = await fixture()
  try {
    const versionDir = path.join(fx.root, 'saved-version')
    await fs.cp(fx.projectPath, versionDir, { recursive: true })
    await fs.writeFile(path.join(versionDir, 'src', 'app.js'), 'export const answer = 2\n', 'utf8')
    await fx.store.patch('s1', {
      lastVersion: { runId: 'old-run', path: versionDir, title: 'Старая версия', changeCount: 1, at: Date.now() },
    })

    const { queue, git } = await fx.runner.ensureBranches('s1')

    assert.equal(queue.model, 'branches')
    assert.equal(queue.lastVersion, null)
    assert.equal(queue.branches.length, 1)
    const [branch] = queue.branches
    assert.match(branch.tipCommit, /^[0-9a-f]{40}$/)
    assert.equal(branch.baseCommit, queue.project.head)
    assert.equal(queue.currentBranchId, branch.id)
    const [commit] = await git.log(branch.ref, { max: 1 })
    assert.equal(commit.subject, 'Импортированная версия 0.10: Старая версия')
    const changes = await git.changes(branch.baseCommit, branch.tipCommit)
    assert.deepEqual(changes.map((entry) => entry.path), ['src/app.js'])
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await fx.cleanup()
  }
})

test('a legacy queue with unsaved versions keeps the old model', async () => {
  const fx = await fixture({ runs: [{ id: 'run-9', status: 'waiting', changeCount: 2 }] })
  try {
    await assert.rejects(fx.runner.ensureBranches('s1'), (error) => error?.code === 'artel/legacy-queue')

    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Keep going'], mode: 'solo' })
    // Adding tasks never starts the queue: the toggle does, and a pending saved
    // version must not block this start.
    await fx.runner.setAutopilot({
      sessionId: 's1',
      projectPath: fx.projectPath,
      autopilot: true,
      decisions: true,
      checkDisabled: true,
    })
    await waitFor(() => fx.store.get('s1').tasks[0].status === 'running')
    const queue = fx.store.get('s1')
    assert.equal(queue.model, undefined)
    assert.equal(queue.branches, undefined)
    assert.equal(fx.engine.starts.length, 1)
    assert.equal(fx.engine.starts[0].isolateFromBase, undefined)
    assert.equal(fx.engine.starts[0].basePath, null)
  } finally {
    await fx.cleanup()
  }
})

test('an Orchestrator check that fails is repaired through the engine and then parks', async () => {
  const fx = await fixture({ checkCommand: 'node -e "process.exit(1)"' })
  try {
    await fx.runner.ensureBranches('s1')
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Собери отчёт'], mode: 'orchestrator' })
    await fx.runner.setAutopilot({
      sessionId: 's1',
      projectPath: fx.projectPath,
      autopilot: true,
      decisions: true,
      checkDisabled: false,
    })
    await waitFor(() => fx.store.get('s1').tasks[0].status === 'parked', 20000)

    const task = fx.store.get('s1').tasks[0]
    assert.match(task.reason ?? '', /Проверка не прошла/i)
    assert.equal(fx.engine.repairs.length, 2)
    assert.equal(fx.engine.repairs[0].runId, 'run-1')
    assert.match(fx.engine.repairs[0].input.prompt, /process\.exit\(1\)/)
    assert.equal(fx.engine.messages.length, 0)
    assert.equal(fx.store.get('s1').branches[0].tipCommit, null)
  } finally {
    await fx.cleanup()
  }
})
