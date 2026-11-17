import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { RunStore, canTransition, newRunId, toSummary } from '../lib/run-store.js'

async function freshStore(name, options = {}) {
  const dir = path.join(process.cwd(), 'test', '.tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  const store = await new RunStore({ dir, ...options }).init()
  return { store, dir }
}

function makeRun(overrides = {}) {
  return {
    id: newRunId(),
    sessionId: 's1',
    mode: 'solo',
    task: 'fix the header',
    projectPath: 'C:/work/project',
    copyPath: 'C:/dsh/artel/copies/run1',
    baseHashes: { 'a.txt': { hash: 'x', size: 1 } },
    status: 'preparing',
    agents: [{ id: 'a1', name: 'Vega', role: 'solo', status: 'idle', claimed: [] }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

test('add, list by session and reload from disk', async () => {
  const { store, dir } = await freshStore('store')
  const run = makeRun()
  await store.add(run)
  await store.add(makeRun({ sessionId: 's2' }))
  assert.equal(store.list('s1').length, 1)
  assert.equal(store.list('s2').length, 1)
  assert.equal(store.get(run.id).task, 'fix the header')

  const reloaded = await new RunStore({ dir }).init()
  assert.equal(reloaded.list('s1').length, 1)
  assert.equal(reloaded.get(run.id).sessionId, 's1')
  await fs.rm(dir, { recursive: true, force: true })
})

test('status transitions are validated', async () => {
  const { store, dir } = await freshStore('transitions')
  const run = makeRun()
  await store.add(run)
  await store.patch(run.id, { status: 'running' })
  await store.patch(run.id, { status: 'waiting' })
  await store.patch(run.id, { status: 'applied' })
  await assert.rejects(() => store.patch(run.id, { status: 'running' }), /cannot move run/)
  assert.equal(canTransition('applied', 'running'), false)
  assert.equal(canTransition('planning', 'running'), true)
  assert.equal(canTransition('waiting', 'applied'), true)
  await fs.rm(dir, { recursive: true, force: true })
})

test('feed appends get increasing sequence numbers and are readable by cursor', async () => {
  const { store, dir } = await freshStore('feed')
  const run = makeRun()
  await store.add(run)
  await store.appendFeed(run.id, [{ kind: 'status', text: 'copying' }])
  const second = await store.appendFeed(run.id, [
    { kind: 'assistant', text: 'reading code' },
    { kind: 'tool', text: 'read src/app.ts', tool: 'read' },
  ])
  assert.equal(second.cursor, 3)

  const page = await store.readFeed(run.id, { cursor: 0 })
  assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 3])
  assert.equal(page.events[2].tool, 'read')
  assert.equal(page.events[2].kind, 'tool')

  const tail = await store.readFeed(run.id, { cursor: 2 })
  assert.deepEqual(tail.events.map((event) => event.seq), [3])
  assert.equal(tail.cursor, 3)

  const reloaded = await new RunStore({ dir }).init()
  assert.equal(reloaded.get(run.id).feedSeq, 3)
  await fs.rm(dir, { recursive: true, force: true })
})

test('feeds are trimmed to the configured limit', async () => {
  const { store, dir } = await freshStore('trim', { feedLimitPerRun: 3 })
  const run = makeRun()
  await store.add(run)
  for (let i = 0; i < 7; i++) await store.appendFeed(run.id, [{ kind: 'assistant', text: `m${i}` }])
  const page = await store.readFeed(run.id, { cursor: 0 })
  assert.deepEqual(page.events.map((event) => event.text), ['m4', 'm5', 'm6'])
  assert.equal(store.get(run.id).feedFloor, 5)
  await fs.rm(dir, { recursive: true, force: true })
})

test('toSummary drops hashes and keeps the client-facing fields', async () => {
  const run = makeRun({ status: 'waiting', changeCount: 2 })
  const summary = toSummary(run)
  assert.equal(summary.baseHashes, undefined)
  assert.equal(summary.changeCount, 2)
  assert.equal(summary.agents[0].name, 'Vega')
  assert.equal(summary.task, 'fix the header')
})

test('remove deletes a run and its feed', async () => {
  const { store, dir } = await freshStore('remove')
  const run = makeRun()
  await store.add(run)
  await store.appendFeed(run.id, [{ kind: 'status', text: 'x' }])
  await store.remove(run.id)
  assert.equal(store.get(run.id), undefined)
  await assert.rejects(() => fs.stat(store.feedPath(run.id)), /ENOENT/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('newRunId is unique-ish and readable', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, /^fg-[0-9a-z]+-[0-9a-z]{4}$/)
})
