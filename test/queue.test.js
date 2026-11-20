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
  queueSummary,
  resultsCard,
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
