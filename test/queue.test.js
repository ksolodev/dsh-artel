import test from 'node:test'
import assert from 'node:assert/strict'

import {
  QUEUE_MODES,
  QUEUE_MODEL_BRANCHES,
  branchRefFor,
  createBranchRecord,
  createQueueRecord,
  createTaskRecord,
  isBranchQueue,
  queueModeRefusal,
  queueProgress,
  queueSummary,
  resultsCard,
  stopReasonKey,
  stopReasonLabel,
  taskTitle,
} from '../lib/queue.js'

test('the Orchestrator is a queue mode now; only unknown modes are refused', () => {
  assert.deepEqual(QUEUE_MODES, ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  assert.equal(queueModeRefusal('solo'), null)
  assert.equal(queueModeRefusal('orchestrator'), null)
  const unknown = queueModeRefusal('banana')
  assert.equal(unknown.code, 'queue/mode-unknown')
  assert.match(unknown.message, /banana/)
})

test('a new queue is a branch queue', () => {
  const queue = createQueueRecord('s1', { projectPath: 'C:\\work\\app' })
  assert.equal(queue.model, QUEUE_MODEL_BRANCHES)
  assert.equal(queue.project, null)
  assert.equal(queue.currentBranchId, null)
  assert.deepEqual(queue.branches, [])
  assert.equal(isBranchQueue(queue), true)
  assert.equal(isBranchQueue({ version: 1 }), false)
})

test('branches have stable refs and metadata', () => {
  const branch = createBranchRecord({ name: 'Ночная смена', baseCommit: 'a'.repeat(40) })
  assert.match(branch.id, /^b-/)
  assert.equal(branch.ref, branchRefFor(branch.id))
  assert.match(branch.ref, /^refs\/heads\/artel\/b-/)
  assert.equal(branch.tipCommit, null)
  assert.equal(branch.status, 'active')
  assert.equal(branch.appliedAt, null)
})

test('tasks carry branch fields and accept the Orchestrator', () => {
  const task = createTaskRecord({ text: 'Ночная задача', mode: 'orchestrator' })
  assert.equal(task.mode, 'orchestrator')
  assert.equal(task.branchId, null)
  assert.equal(task.parentCommit, null)
  assert.equal(task.commit, null)
  assert.equal(createTaskRecord({ text: 'x', mode: 'banana' }).mode, 'solo')
})

test('the summary and the results card expose branches and commits', () => {
  const queue = createQueueRecord('s1', { projectPath: 'C:\\work\\app' })
  queue.branches = [createBranchRecord({ name: 'Ветка 1', baseCommit: 'b'.repeat(40) })]
  queue.currentBranchId = queue.branches[0].id
  queue.project = { head: 'b'.repeat(40), importedAt: 1, applied: null }
  queue.tasks = [{ ...createTaskRecord({ text: 'Task' }), branchId: queue.branches[0].id, commit: 'c'.repeat(40), status: 'passed', changeCount: 2, files: ['a.js', 'b.js'] }]

  const summary = queueSummary(queue)
  assert.equal(summary.model, QUEUE_MODEL_BRANCHES)
  assert.equal(summary.currentBranchId, queue.currentBranchId)
  assert.equal(summary.branches.length, 1)
  assert.equal(summary.project.head, 'b'.repeat(40))
  assert.equal(summary.tasks[0].commit, 'c'.repeat(40))

  const card = resultsCard({ ...queue, results: null })
  assert.equal(card.passed[0].commit, 'c'.repeat(40))
  assert.equal(card.passed[0].branchId, queue.branches[0].id)
})

test('host strings carry catalogue keys next to their legacy text', () => {
  assert.equal(taskTitle(''), '')
  assert.equal(taskTitle('  \n  хвост'), '')
  assert.equal(taskTitle('  хвост  '), 'хвост')

  const auto = queueProgress({ autopilot: true, tasks: [{ status: 'passed' }, { status: 'queued' }] })
  assert.equal(auto.key, 'queue.progress.auto')
  assert.deepEqual(auto.params, { done: 1, total: 2 })
  assert.equal(auto.text, 'Автоочередь идёт · 1 из 2')

  const queued = queueProgress({ autopilot: false, tasks: [{ status: 'queued' }, { status: 'queued' }] })
  assert.equal(queued.key, 'queue.progress.queued')
  assert.deepEqual(queued.params, { queued: 2 })
  assert.equal(queued.text, 'В очереди · 2')

  assert.equal(stopReasonKey('parks'), 'queue.stop.parks')
  assert.equal(stopReasonKey(null), null)
  assert.equal(stopReasonKey(undefined), null)
  assert.equal(stopReasonKey(''), null)
  assert.equal(stopReasonLabel('parks'), 'Три задачи подряд ушли в «Отложенное».')
})

test('an auto-generated branch name is a catalogue key; an explicit one is data', () => {
  const auto = createBranchRecord({ baseCommit: 'a'.repeat(40) })
  assert.match(auto.name, /^Ветка [0-9a-z]{4}$/)
  assert.equal(auto.nameKey, 'queue.branch.default')
  assert.deepEqual(auto.nameParams, { id: auto.id.slice(2, 6) })

  const named = createBranchRecord({ name: 'Ночная смена', baseCommit: 'a'.repeat(40) })
  assert.equal(named.name, 'Ночная смена')
  assert.equal(named.nameKey, null)
  assert.equal(named.nameParams, null)
})

test('a parked task and the results card carry reason and stop keys', () => {
  const queue = createQueueRecord('s1', { projectPath: 'C:\\work\\app' })
  queue.tasks = [{
    ...createTaskRecord({ text: 'Ночная задача' }),
    status: 'parked',
    reason: 'Проверка не прошла после 2 починок.',
    reasonKey: 'queue.reason.check-failed',
    reasonParams: { count: 2 },
  }]
  queue.stopReason = 'parks'
  queue.results = null

  const summary = queueSummary(queue)
  assert.equal(summary.tasks[0].reasonKey, 'queue.reason.check-failed')
  assert.deepEqual(summary.tasks[0].reasonParams, { count: 2 })

  const card = resultsCard(queue)
  assert.equal(card.stopKey, 'queue.stop.parks')
  assert.deepEqual(card.stopParams, {})
  assert.equal(card.stopText, 'Три задачи подряд ушли в «Отложенное».')
  assert.equal(card.parked[0].reasonKey, 'queue.reason.check-failed')
  assert.deepEqual(card.parked[0].reasonParams, { count: 2 })
})

test('an empty run gets the default stop key', () => {
  const queue = createQueueRecord('s1', { projectPath: 'C:\\work\\app' })
  const card = resultsCard(queue)
  assert.equal(card.stopKey, 'queue.stop.default')
  assert.equal(card.stopText, 'Автоочередь закончилась.')
})
