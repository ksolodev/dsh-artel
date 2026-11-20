import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BranchService, BranchError } from '../lib/branches.js'
import { QueueStore, QUEUE_MODEL_BRANCHES } from '../lib/queue.js'

function makeEngine({ assist = null } = {}) {
  const calls = { markApplied: [], refreshInstall: [], assists: [] }
  return {
    calls,
    async assist({ copyPath, prompt, title }) {
      calls.assists.push({ copyPath, prompt, title })
      if (assist !== null) return await assist({ copyPath, prompt })
      return { message: 'no changes' }
    },
    async markApplied(runId) {
      calls.markApplied.push(runId)
    },
    async refreshInstall(runId) {
      calls.refreshInstall.push(runId)
      return null
    },
  }
}

async function fixture({ assist = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-branches-'))
  const stateDir = path.join(root, 'state')
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()
  await store.ensure('s1', { projectPath })
  let clock = 1_700_000_000_000
  const engine = makeEngine({ assist })
  const service = new BranchService({ store, stateDir, engine, exclude: ['node_modules'], now: () => (clock += 1) })
  await service.ensure('s1')
  return { root, stateDir, projectPath, store, service, engine, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

async function commitOnBranch(fx, branch, { file, content, subject, parent = null }) {
  const git = await fx.service.ensure('s1')
  const base = parent ?? branch.tipCommit ?? branch.baseCommit
  const work = path.join(fx.root, `work-${Math.random().toString(36).slice(2, 8)}`)
  await git.materialize(work, base)
  await fs.writeFile(path.join(work, file), content)
  const commit = await git.commitDir(work, { parent: base, message: subject })
  await git.updateRef(branch.ref, commit, base)
  const queue = await fx.store.get('s1')
  await fx.store.patch('s1', {
    branches: queue.branches.map((entry) => (entry.id === branch.id ? { ...entry, tipCommit: commit } : entry)),
  })
  return commit
}

async function commitToApplied(fx, { file, content, subject }) {
  const git = await fx.service.ensure('s1')
  const queue = await fx.store.get('s1')
  const head = queue.project.head
  const work = path.join(fx.root, `applied-${Math.random().toString(36).slice(2, 8)}`)
  await git.materialize(work, head)
  await fs.writeFile(path.join(work, file), content)
  const commit = await git.commitDir(work, { parent: head, message: subject })
  await git.updateRef('refs/heads/applied', commit, head)
  // Deviation from the plan: moving the applied ref alone would leave the
  // project work tree out of sync with it, and apply() reads that difference as
  // drift. A real apply writes the files back, so the helper does the same.
  await fs.mkdir(path.dirname(path.join(fx.projectPath, file)), { recursive: true })
  await fs.writeFile(path.join(fx.projectPath, file), content)
  await fx.store.patch('s1', { project: { ...queue.project, head: commit } })
  return commit
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

test('apply() fast-forwards a branch cut from the applied head', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Fast' })
    const commit = await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Answer 2' })
    await fx.store.patch('s1', {
      tasks: [{ id: 'q-1', text: 'Answer 2', title: 'Answer 2', mode: 'solo', status: 'passed', runId: 'run-1', commit, branchId: branch.id, files: [], changeCount: 1 }],
    })

    const result = await fx.service.apply('s1', { branchId: branch.id })

    assert.equal(result.applied.commit, commit)
    assert.equal(result.applied.files, 1)
    assert.equal(result.applied.driftCommit, null)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
    assert.deepEqual(fx.engine.calls.markApplied, ['run-1'])
    const after = await fx.store.get('s1')
    assert.equal(after.project.head, commit)
    assert.equal(after.project.applied.branchId, branch.id)
    assert.ok(after.branches[0].appliedAt)
  } finally {
    await fx.cleanup()
  }
})

test('apply() merges when the project moved on after the branch was cut', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Later' })
    const branchCommit = await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Branch answer' })
    const appliedCommit = await commitToApplied(fx, { file: 'README.md', content: '# Demo moved\n', subject: 'Project moved' })

    const result = await fx.service.apply('s1', { branchId: branch.id })

    assert.match(result.applied.commit, /^[0-9a-f]{40}$/)
    const git = await fx.service.ensure('s1')
    const [entry] = await git.log(result.applied.commit, { max: 1 })
    assert.deepEqual([...entry.parents].sort(), [appliedCommit, branchCommit].sort())
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'README.md'), 'utf8'), '# Demo moved\n')
  } finally {
    await fx.cleanup()
  }
})

test('apply() rebuilds only the commits that stay checked', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Rebuild' })
    const first = await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'First' })
    const second = await commitOnBranch(fx, branch, { file: 'README.md', content: '# Task two\n', subject: 'Second', parent: first })

    const result = await fx.service.apply('s1', { branchId: branch.id, commitIds: [second] })

    assert.equal(result.applied.files, 1)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'README.md'), 'utf8'), '# Task two\n')
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await fx.cleanup()
  }
})

test('apply() refuses uncommitted project changes unless the drift is confirmed', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Drift' })
    await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Branch' })
    await fs.writeFile(path.join(fx.projectPath, 'README.md'), '# Local edit\n')

    await assert.rejects(fx.service.apply('s1', { branchId: branch.id }), (error) => {
      assert.equal(error.code, 'artel/project-drift')
      assert.deepEqual(error.details.drift.files, ['README.md'])
      return true
    })

    const result = await fx.service.apply('s1', { branchId: branch.id, confirmDrift: true })
    assert.match(result.applied.driftCommit, /^[0-9a-f]{40}$/)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'README.md'), 'utf8'), '# Local edit\n')
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
  } finally {
    await fx.cleanup()
  }
})

test('apply() refuses a failing check unless the user forces it', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Check' })
    await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Branch' })
    // Deviation from the plan: `node -e "process.exit(1)"` is mangled by Node's
    // Windows argument quoting when spawned as cmd.exe /d /s /c <command> (the
    // planned runCheckCommand shape), so cmd exits 0. Without inner quotes the
    // same command exits non-zero through that shape on Windows and Unix alike.
    const checkCommand = 'node -e process.exit(1)'

    await assert.rejects(fx.service.apply('s1', { branchId: branch.id, checkCommand }), (error) => {
      assert.equal(error.code, 'artel/check-failed')
      assert.equal(error.details.check.ok, false)
      return true
    })

    const forced = await fx.service.apply('s1', { branchId: branch.id, checkCommand, force: true })
    assert.equal(forced.check.ok, false)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 2\n')
  } finally {
    await fx.cleanup()
  }
})

test('apply() reports a conflict when the fixer cannot converge', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Conflict' })
    await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Branch answer' })
    await commitToApplied(fx, { file: 'src/app.js', content: 'export const answer = 3\n', subject: 'Project answer' })

    await assert.rejects(fx.service.apply('s1', { branchId: branch.id }), (error) => {
      assert.equal(error.code, 'artel/apply-conflict')
      assert.deepEqual(error.details.conflicts, ['src/app.js'])
      return true
    })
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 3\n')
  } finally {
    await fx.cleanup()
  }
})

test('apply() lets the fixer converge a merge conflict', async () => {
  const fx = await fixture({
    assist: async ({ copyPath, prompt }) => {
      assert.match(prompt, /conflict/i)
      await fs.writeFile(path.join(copyPath, 'src', 'app.js'), 'export const answer = 4\n')
    },
  })
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Fixer' })
    await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Branch answer' })
    await commitToApplied(fx, { file: 'src/app.js', content: 'export const answer = 3\n', subject: 'Project answer' })

    const result = await fx.service.apply('s1', { branchId: branch.id })

    assert.match(result.applied.commit, /^[0-9a-f]{40}$/)
    assert.equal(fx.engine.calls.assists.length, 1)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 4\n')
  } finally {
    await fx.cleanup()
  }
})

test('merge() creates a merge commit and leaves the source branch untouched', async () => {
  const fx = await fixture()
  try {
    const { branch: main } = await fx.service.createBranch('s1', { name: 'Main' })
    const { branch: side } = await fx.service.createBranch('s1', { name: 'Side', fromCommit: main.baseCommit })
    const mainCommit = await commitOnBranch(fx, main, { file: 'README.md', content: '# Main\n', subject: 'Main work' })
    const sideCommit = await commitOnBranch(fx, side, { file: 'src/app.js', content: 'export const answer = 4\n', subject: 'Side work' })

    const result = await fx.service.merge('s1', { targetBranchId: main.id, sourceBranchId: side.id })

    const git = await fx.service.ensure('s1')
    const [entry] = await git.log(result.mergeCommit, { max: 1 })
    assert.deepEqual([...entry.parents].sort(), [mainCommit, sideCommit].sort())
    assert.equal(await git.ref(main.ref), result.mergeCommit)
    assert.equal(await git.ref(side.ref), sideCommit)
    const queue = await fx.store.get('s1')
    assert.equal(queue.project.head, main.baseCommit)
  } finally {
    await fx.cleanup()
  }
})

test('merge() lets the fixer resolve a conflict between branches', async () => {
  const fx = await fixture({
    assist: async ({ copyPath }) => {
      await fs.writeFile(path.join(copyPath, 'src/app.js'), 'export const answer = 5\n')
    },
  })
  try {
    const { branch: main } = await fx.service.createBranch('s1', { name: 'Main' })
    const { branch: side } = await fx.service.createBranch('s1', { name: 'Side', fromCommit: main.baseCommit })
    await commitOnBranch(fx, main, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Main answer' })
    await commitOnBranch(fx, side, { file: 'src/app.js', content: 'export const answer = 3\n', subject: 'Side answer' })

    const result = await fx.service.merge('s1', { targetBranchId: main.id, sourceBranchId: side.id })

    assert.equal(fx.engine.calls.assists.length, 1)
    const git = await fx.service.ensure('s1')
    const work = path.join(fx.root, 'merged-check')
    await git.materialize(work, result.mergeCommit)
    assert.equal(await fs.readFile(path.join(work, 'src/app.js'), 'utf8'), 'export const answer = 5\n')
  } finally {
    await fx.cleanup()
  }
})
