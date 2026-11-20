import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BranchService, BranchError } from '../lib/branches.js'
import { QueueStore, QUEUE_MODEL_BRANCHES } from '../lib/queue.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-branches-'))
  const stateDir = path.join(root, 'state')
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()
  await store.ensure('s1', { projectPath })
  const service = new BranchService({ store, stateDir, exclude: ['node_modules'] })
  await service.ensure('s1')
  return { root, stateDir, projectPath, store, service, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('ensure() creates the app repository, imports the project and patches the queue', async () => {
  const fx = await fixture()
  try {
    const queue = await fx.store.get('s1')
    assert.equal(queue.model, QUEUE_MODEL_BRANCHES)
    assert.match(queue.project.repoDir, /repos[\\/][0-9a-f]{20}\.git$/)
    await fs.access(queue.project.repoDir)
    assert.match(queue.project.head, /^[0-9a-f]{40}$/)
    await assert.rejects(fs.access(path.join(fx.projectPath, '.git')), { code: 'ENOENT' })
    assert.deepEqual(queue.branches, [])
    assert.equal(queue.currentBranchId, null)

    const state = await fx.service.projectState('s1')
    assert.equal(state.head, queue.project.head)
    assert.equal(state.drift.dirty, false)

    const again = await fx.service.ensure('s1')
    assert.equal(await again.head(), queue.project.head)
  } finally {
    await fx.cleanup()
  }
})

test('createBranch() creates a ref at the imported commit and selects it; rename and switch work', async () => {
  const fx = await fixture()
  try {
    const created = await fx.service.createBranch('s1', { name: 'Night work' })
    const branch = created.branch
    assert.match(branch.id, /^b-[a-z0-9]+-[a-z0-9]+$/)
    assert.equal(branch.ref, `refs/heads/artel/${branch.id}`)
    assert.equal(branch.name, 'Night work')
    assert.equal(branch.baseCommit, created.project.head)
    assert.equal(created.currentBranchId, branch.id)

    const git = await fx.service.ensure('s1')
    assert.equal(await git.ref(branch.ref), created.project.head)

    await fx.service.renameBranch('s1', branch.id, 'Ночная смена')
    const renamed = await fx.service.list('s1')
    assert.equal(renamed.branches[0].name, 'Ночная смена')

    const second = await fx.service.createBranch('s1', { name: 'Second' })
    assert.equal(second.currentBranchId, second.branch.id)
    const switched = await fx.service.switchBranch('s1', branch.id)
    assert.equal(switched.currentBranchId, branch.id)
  } finally {
    await fx.cleanup()
  }
})

test('commits() lists branch commits newest first with files and a change count', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Task branch' })
    const git = await fx.service.ensure('s1')
    const work = path.join(fx.root, 'work')
    await git.materialize(work, branch.baseCommit)
    await fs.writeFile(path.join(work, 'src', 'app.js'), 'export const answer = 2\n')
    const commit = await git.commitDir(work, { parent: branch.baseCommit, message: 'Task one' })
    await git.updateRef(branch.ref, commit, branch.baseCommit)

    const commits = await fx.service.commits('s1', branch.id)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].commit, commit)
    assert.equal(commits[0].subject, 'Task one')
    assert.deepEqual(commits[0].files, ['src/app.js'])
    assert.equal(commits[0].changeCount, 1)
  } finally {
    await fx.cleanup()
  }
})

test('removeBranch() refuses an applied or busy branch and deletes a free one', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Applied' })
    const queue = await fx.store.get('s1')
    await fx.store.patch('s1', { project: { ...queue.project, applied: { branchId: branch.id, commit: queue.project.head } } })
    await assert.rejects(fx.service.removeBranch('s1', branch.id), (error) => {
      assert.ok(error instanceof BranchError)
      assert.equal(error.code, 'artel/branch-applied')
      return true
    })

    const queue2 = await fx.store.get('s1')
    await fx.store.patch('s1', { project: { ...queue2.project, applied: null } })
    const busy = await fx.service.createBranch('s1', { name: 'Busy' })
    // Deviation from the plan: QueueStore.addTask pushes the record verbatim (it
    // does not fill createTaskRecord defaults), so the status is explicit here.
    await fx.store.addTask('s1', { text: 'Work', mode: 'solo', branchId: busy.branch.id, status: 'queued' })
    await assert.rejects(fx.service.removeBranch('s1', busy.branch.id), (error) => {
      assert.equal(error.code, 'artel/branch-busy')
      return true
    })

    const free = await fx.service.createBranch('s1', { name: 'Free' })
    const after = await fx.service.removeBranch('s1', free.branch.id)
    assert.equal(after.branches.some((entry) => entry.id === free.branch.id), false)
    const git = await fx.service.ensure('s1')
    assert.equal(await git.ref(free.branch.ref), null)
  } finally {
    await fx.cleanup()
  }
})

test('projectState() reports uncommitted project changes as drift', async () => {
  const fx = await fixture()
  try {
    await fs.writeFile(path.join(fx.projectPath, 'README.md'), '# Demo edited\n')
    const state = await fx.service.projectState('s1')
    assert.equal(state.drift.dirty, true)
    assert.ok(state.drift.files.includes('README.md'))
  } finally {
    await fx.cleanup()
  }
})
