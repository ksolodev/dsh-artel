import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { ArtelGit, GIT_INSTALL_URL, GitError, MIN_GIT_VERSION, compareVersions, formatBytes, gitProbeHint, parseGitVersion, probeGit, projectKey, repoDirFor, requireGit, worktreeRootFor } from '../lib/git.js'

const execFileAsync = promisify(execFile)

test('parseGitVersion reads the version out of git --version', () => {
  assert.equal(parseGitVersion('git version 2.30.0.windows.1'), '2.30.0')
  assert.equal(parseGitVersion('git version 2.56.1'), '2.56.1')
  assert.equal(parseGitVersion('nonsense'), null)
})

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('2.30.0', '2.30.0'), 0)
  assert.equal(compareVersions('2.9.0', '2.30.0'), -1)
  assert.equal(compareVersions('3.0.0', '2.30.0'), 1)
})

test('projectKey is stable, path-case tolerant and differs per project', () => {
  const a = projectKey(path.join(os.tmpdir(), 'ArtelDemo'))
  const b = projectKey(path.join(os.tmpdir(), 'arteldemo') + path.sep)
  assert.match(a, /^[0-9a-f]{20}$/)
  if (process.platform === 'win32') assert.equal(a, b)
  assert.notEqual(a, projectKey(path.join(os.tmpdir(), 'ArtelOther')))
})

test('repo and worktree dirs live under stateDir', () => {
  const stateDir = path.join(os.tmpdir(), 'artel-state')
  const project = path.join(os.tmpdir(), 'artel-project')
  assert.equal(repoDirFor(stateDir, project), path.join(stateDir, 'repos', `${projectKey(project)}.git`))
  assert.equal(worktreeRootFor(stateDir, project), path.join(stateDir, 'worktrees', projectKey(project)))
})

test('requireGit reports a missing or old git binary', async () => {
  const missing = await requireGit({ runner: async () => { throw new Error('spawn git ENOENT') } }).catch((error) => error)
  assert.ok(missing instanceof GitError)
  assert.equal(missing.code, 'artel/git-missing')
  assert.equal(missing.details.reason, 'missing')
  assert.equal(missing.details.minimum, MIN_GIT_VERSION)
  assert.equal(missing.details.installUrl, GIT_INSTALL_URL)

  const old = await requireGit({ runner: async () => ({ stdout: 'git version 2.20.0\n', stderr: '' }) }).catch((error) => error)
  assert.ok(old instanceof GitError)
  assert.equal(old.code, 'artel/git-missing')
  assert.equal(old.details.reason, 'old')
  assert.equal(old.details.found, '2.20.0')
  assert.match(old.message, new RegExp(MIN_GIT_VERSION.replaceAll('.', '\\.')))
})

test('probeGit never throws and names the reason it failed', async () => {
  const missing = await probeGit({ runner: async () => { throw new Error('spawn git ENOENT') } })
  assert.deepEqual({ ok: missing.ok, reason: missing.reason, minimum: missing.minimum }, { ok: false, reason: 'missing', minimum: MIN_GIT_VERSION })
  assert.match(gitProbeHint(missing), /Install Git/)
  assert.ok(gitProbeHint(missing).includes(GIT_INSTALL_URL))

  const unreadable = await probeGit({ runner: async () => ({ stdout: 'not a version\n', stderr: '' }) })
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.reason, 'unreadable')
  assert.match(gitProbeHint(unreadable), /git --version/)

  const old = await probeGit({ runner: async () => ({ stdout: 'git version 2.20.0.windows.1\n', stderr: '' }) })
  assert.deepEqual({ ok: old.ok, reason: old.reason, version: old.version }, { ok: false, reason: 'old', version: '2.20.0' })
  assert.match(gitProbeHint(old), /2\.20\.0/)

  const good = await probeGit({ runner: async () => ({ stdout: 'git version 2.43.0\n', stderr: '' }) })
  assert.deepEqual({ ok: good.ok, reason: good.reason, version: good.version }, { ok: true, reason: null, version: '2.43.0' })
  assert.equal(gitProbeHint(good), '')
})

test('requireGit accepts the installed git', async () => {
  const result = await requireGit()
  assert.match(result.version, /^\d+\.\d+\.\d+$/)
  assert.ok(compareVersions(result.version, MIN_GIT_VERSION) >= 0)
})

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function makeProject() {
  const dir = await tempDir('artel-project-')
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n')
  return dir
}

async function makeGitProject() {
  const dir = await makeProject()
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'user@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'User'], { cwd: dir })
  await execFileAsync('git', ['add', '--all'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir })
  return dir
}

function normalisePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Resolve Windows 8.3 short names before comparing: os.tmpdir() can hand back
 * `RUNNER~1` while git reports the long `runneradmin` path, and both name the
 * same directory.
 */
async function normaliseRealPath(value) {
  return normalisePath(await fs.realpath(value))
}

test('init creates an app repo without touching the project', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const before = (await fs.readdir(project)).sort()

  const git = await ArtelGit.init({ stateDir, projectPath: project })

  assert.equal(git.repoDir, repoDirFor(stateDir, project))
  assert.deepEqual((await fs.readdir(project)).sort(), before)
  assert.equal(await fs.stat(path.join(project, '.git')).then(() => true).catch(() => false), false)
  assert.equal((await git.exec(['config', 'core.bare'], { cwd: git.repoDir })).stdout.toString().trim(), 'false')
  assert.equal((await git.exec(['config', 'core.worktree'], { cwd: git.repoDir })).stdout.toString().trim(), path.resolve(project))
  assert.equal((await git.exec(['symbolic-ref', 'HEAD'], { cwd: git.repoDir })).stdout.toString().trim(), 'refs/heads/applied')
  assert.equal(await git.head(), null)
})

test('init writes text-safe attributes and excludes generated dirs', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  await fs.mkdir(path.join(project, 'node_modules', 'dep'), { recursive: true })
  await fs.writeFile(path.join(project, 'node_modules', 'dep', 'index.js'), 'x\n')
  await fs.mkdir(path.join(project, 'vendor', 'lib'), { recursive: true })
  await fs.writeFile(path.join(project, 'vendor', 'lib', 'x.js'), 'x\n')

  await ArtelGit.init({ stateDir, projectPath: project, exclude: ['vendor/**'] })

  const git = await ArtelGit.open({ stateDir, projectPath: project })
  const attributes = await fs.readFile(path.join(git.repoDir, 'info', 'attributes'), 'utf8')
  const exclude = await fs.readFile(path.join(git.repoDir, 'info', 'exclude'), 'utf8')
  assert.match(attributes, /\* -text -filter/)
  assert.match(exclude, /node_modules\//)
  assert.match(exclude, /vendor\//)
})

test('a project that is already a git repository keeps its .git untouched', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  await execFileAsync('git', ['init'], { cwd: project })
  await execFileAsync('git', ['config', 'user.email', 'user@example.com'], { cwd: project })
  await execFileAsync('git', ['config', 'user.name', 'User'], { cwd: project })
  await execFileAsync('git', ['add', '--all'], { cwd: project })
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: project })
  const headBefore = await fs.readFile(path.join(project, '.git', 'HEAD'), 'utf8')

  await ArtelGit.init({ stateDir, projectPath: project })

  assert.equal(await fs.readFile(path.join(project, '.git', 'HEAD'), 'utf8'), headBefore)
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: project })
  assert.equal(status.stdout.trim(), '')
})

test('refs read, compare-and-swap and delete', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const imported = await git.importProject({ message: 'Import project' })
  assert.equal(await git.head(), imported)
  assert.equal(await git.ref('refs/heads/applied'), imported)

  await git.updateRef('refs/heads/artel/b1', imported, null)
  assert.equal(await git.ref('refs/heads/artel/b1'), imported)
  const refs = await git.refs('refs/heads/artel/')
  assert.deepEqual([...refs.keys()], ['refs/heads/artel/b1'])

  await assert.rejects(git.updateRef('refs/heads/artel/b1', imported, '0'.repeat(40)), (error) => (
    error.code === 'artel/git-ref-changed' &&
    // A ref that moved under us is a conflict for the client, not a 500 (#39).
    error.status === 409
  ))
  await git.deleteRef('refs/heads/artel/b1')
  assert.equal(await git.ref('refs/heads/artel/b1'), null)
})

test('importProject snapshots the project and materialize returns a clean copy', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  await fs.mkdir(path.join(project, 'node_modules', 'dep'), { recursive: true })
  await fs.writeFile(path.join(project, 'node_modules', 'dep', 'index.js'), 'x\n')
  const git = await ArtelGit.init({ stateDir, projectPath: project })

  const commit = await git.importProject()
  assert.equal(await git.head(), commit)
  const paths = (await git.tree(commit)).map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['README.md', 'src/app.js'])

  const dir = await tempDir('artel-snapshot-')
  await git.materialize(dir, commit)
  assert.equal(await fs.readFile(path.join(dir, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  assert.equal(await fs.stat(path.join(dir, '.git')).then(() => true).catch(() => false), false)
  assert.equal(await fs.stat(path.join(dir, 'node_modules')).then(() => true).catch(() => false), false)
})

test('commitDir builds a child commit with the given parent', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const first = await git.importProject()

  const work = await tempDir('artel-work-')
  await fs.mkdir(path.join(work, 'src'), { recursive: true })
  await fs.writeFile(path.join(work, 'src', 'app.js'), 'export const answer = 2\n')
  const second = await git.commitDir(work, { parent: first, message: 'Task: change answer' })

  assert.notEqual(second, first)
  const log = await git.log('refs/heads/applied', { max: 1 })
  assert.equal(log[0].commit, first)
  const history = await git.revList({ from: null, to: second })
  assert.deepEqual(history, [first, second])
})

test('changes, show, blob and log describe commits', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const first = await git.importProject()
  const work = await tempDir('artel-work-')
  await fs.mkdir(path.join(work, 'src'), { recursive: true })
  await fs.writeFile(path.join(work, 'README.md'), '# demo\n')
  await fs.writeFile(path.join(work, 'src', 'app.js'), 'export const answer = 2\n')
  await fs.writeFile(path.join(work, 'src', 'extra.js'), 'export const extra = true\n')
  const second = await git.commitDir(work, { parent: first, message: 'Task: change answer' })

  const changes = (await git.changes(first, second)).sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(changes.map((change) => [change.path, change.status]), [['src/app.js', 'modified'], ['src/extra.js', 'added']])
  assert.equal(await git.show(second, 'src/app.js'), 'export const answer = 2\n')
  assert.equal(await git.show(second, 'missing.txt'), null)
  assert.deepEqual((await git.blob(second, 'src/extra.js')).toString('utf8'), 'export const extra = true\n')

  const log = await git.log(second, { max: 2 })
  assert.equal(log[0].commit, second)
  assert.match(log[0].subject, /Task: change answer/)
  assert.deepEqual(log[1].parents, [])
})

test('status reports project drift against the applied head', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  await git.importProject()

  assert.deepEqual(await git.status(), [])
  await fs.writeFile(path.join(project, 'src', 'app.js'), 'export const answer = 3\n')
  await fs.writeFile(path.join(project, 'src', 'new.js'), 'export const fresh = true\n')
  const drift = (await git.status()).sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(drift, [
    { path: 'src/app.js', status: 'modified' },
    { path: 'src/new.js', status: 'untracked' },
  ])
})

test('worktrees are linked, removable and prunable', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const commit = await git.importProject()
  const dir = path.join(await tempDir('artel-worktrees-'), 'w1')

  await git.worktreeAdd(dir, commit)
  assert.equal((await fs.stat(path.join(dir, '.git'))).isFile(), true)
  await git.worktreeRemove(dir)
  assert.equal(await fs.stat(dir).then(() => true).catch(() => false), false)
  await git.pruneWorktrees()
})

async function workFrom(project) {
  const dir = await tempDir('artel-work-')
  await fs.cp(project, dir, { recursive: true })
  return dir
}

async function repoFixture() {
  const stateDir = await tempDir('artel-state-')
  const project = await makeProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const base = await git.importProject()
  return { stateDir, project, git, base }
}

test('mergeInto creates a merge commit with two parents', async () => {
  const { git, base } = await repoFixture()
  const branchWork = await workFrom(await git.materialize(path.join(await tempDir('artel-base-'), 'b'), base))
  await fs.writeFile(path.join(branchWork, 'README.md'), '# branch\n')
  const branchCommit = await git.commitDir(branchWork, { parent: base, message: 'Task: branch readme' })
  await git.updateRef('refs/heads/artel/b1', branchCommit, null)

  const work = path.join(await tempDir('artel-wt-'), 'merge')
  await git.worktreeAdd(work, base)
  const result = await git.mergeInto(work, { source: branchCommit, message: 'Merge b1' })
  assert.deepEqual(result.conflicts, [])
  assert.notEqual(result.mergeCommit, null)

  const log = await git.log(result.mergeCommit, { max: 1 })
  assert.deepEqual([...log[0].parents].sort(), [base, branchCommit].sort())
})

test('merge conflict is reported and mergeContinue completes after resolution', async () => {
  const { git, base } = await repoFixture()
  const branchWork = await workFrom(await git.materialize(path.join(await tempDir('artel-base-'), 'b'), base))
  await fs.writeFile(path.join(branchWork, 'README.md'), '# branch\n')
  const branchCommit = await git.commitDir(branchWork, { parent: base, message: 'Task: branch readme' })

  const appliedWork = await workFrom(await git.materialize(path.join(await tempDir('artel-base-'), 'm'), base))
  await fs.writeFile(path.join(appliedWork, 'README.md'), '# main\n')
  const appliedCommit = await git.commitDir(appliedWork, { parent: base, message: 'Other branch' })
  await git.updateRef('refs/heads/applied', appliedCommit, base)

  const work = path.join(await tempDir('artel-wt-'), 'merge')
  await git.worktreeAdd(work, appliedCommit)
  const result = await git.mergeInto(work, { source: branchCommit, message: 'Merge b1' })
  assert.deepEqual(result.conflicts, ['README.md'])
  assert.equal(result.mergeCommit, null)

  await fs.writeFile(path.join(work, 'README.md'), '# merged\n')
  await git.addAll(work)
  const mergeCommit = await git.mergeContinue(work, { message: 'Merge b1' })
  assert.notEqual(mergeCommit, null)
  assert.equal(await git.show(mergeCommit, 'README.md'), '# merged\n')
})

test('cherryPick applies one commit and reports conflicts, quit clears state', async () => {
  const { git, base } = await repoFixture()
  const branchWork = await workFrom(await git.materialize(path.join(await tempDir('artel-base-'), 'b'), base))
  await fs.writeFile(path.join(branchWork, 'src', 'app.js'), 'export const answer = 2\n')
  const branchCommit = await git.commitDir(branchWork, { parent: base, message: 'Task: answer' })

  const work = path.join(await tempDir('artel-wt-'), 'pick')
  await git.worktreeAdd(work, base)
  const clean = await git.cherryPick(work, branchCommit)
  assert.deepEqual(clean.conflicts, [])
  const picked = await git.commitWorktree(work, { message: 'Apply answer' })
  assert.equal(await git.show(picked, 'src/app.js'), 'export const answer = 2\n')

  const conflictWork = path.join(await tempDir('artel-wt-'), 'conflict')
  await git.worktreeAdd(conflictWork, base)
  await fs.writeFile(path.join(conflictWork, 'src', 'app.js'), 'export const answer = 9\n')
  await git.addAll(conflictWork)
  await git.commitWorktree(conflictWork, { message: 'Different edit' })
  const conflicted = await git.cherryPick(conflictWork, branchCommit)
  assert.deepEqual(conflicted.conflicts, ['src/app.js'])
  await git.quitCherryPick(conflictWork)
})

async function projectHead(project) {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim()
}

async function projectStatus(project) {
  return (await execFileAsync('git', ['status', '--porcelain'], { cwd: project })).stdout.trim()
}

async function userRef(project, name) {
  const result = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: project }).catch(() => null)
  return result === null ? null : result.stdout.trim()
}

test('userRepoRoot finds the user work tree and creates nothing', async () => {
  const stateDir = await tempDir('artel-state-')
  const plain = await makeProject()
  const plainGit = await ArtelGit.init({ stateDir, projectPath: plain })
  assert.equal(await plainGit.userRepoRoot(), null)
  assert.equal(await fs.stat(path.join(plain, '.git')).then(() => true).catch(() => false), false)

  const project = await makeGitProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const root = await git.userRepoRoot()
  assert.notEqual(root, null)
  assert.equal(await normaliseRealPath(root), await normaliseRealPath(project))
  assert.equal(await projectStatus(project), '')
})

test('exportRefToUserRepo imports a branch without touching the user work tree', async () => {
  const stateDir = await tempDir('artel-state-')
  const project = await makeGitProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  const base = await git.importProject()

  const branchWork = await git.materialize(path.join(await tempDir('artel-base-'), 'b1'), base)
  await fs.writeFile(path.join(branchWork, 'README.md'), '# branch\n')
  const branchCommit = await git.commitDir(branchWork, { parent: base, message: 'Task: branch readme' })
  await git.updateRef('refs/heads/artel/b1', branchCommit, null)

  const headBefore = await projectHead(project)
  const statusBefore = await projectStatus(project)

  const exported = await git.exportRefToUserRepo({ sourceRef: 'refs/heads/artel/b1', targetRef: 'refs/heads/artel/x' })
  assert.deepEqual(exported, { target: 'refs/heads/artel/x', commit: branchCommit })
  assert.equal(await userRef(project, 'refs/heads/artel/x'), branchCommit)
  assert.equal(await projectHead(project), headBefore)
  assert.equal(await projectStatus(project), statusBefore)
  assert.equal(await git.ref('refs/heads/applied'), base)
  assert.equal(await fs.stat(path.join(project, '.git', 'FETCH_HEAD')).then(() => true).catch(() => false), false)

  const tipWork = await git.materialize(path.join(await tempDir('artel-base-'), 'b2'), branchCommit)
  await fs.writeFile(path.join(tipWork, 'src', 'app.js'), 'export const answer = 2\n')
  const tip = await git.commitDir(tipWork, { parent: branchCommit, message: 'Task: answer' })
  await git.updateRef('refs/heads/artel/b1', tip, branchCommit)

  const fastForwarded = await git.exportRefToUserRepo({ sourceRef: 'refs/heads/artel/b1', targetRef: 'refs/heads/artel/x' })
  assert.deepEqual(fastForwarded, { target: 'refs/heads/artel/x', commit: tip })
  assert.equal(await userRef(project, 'refs/heads/artel/x'), tip)

  const userTree = (await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: project })).stdout.trim()
  const userCommit = (await execFileAsync('git', ['commit-tree', userTree, '-m', 'user work'], { cwd: project })).stdout.trim()
  await execFileAsync('git', ['update-ref', 'refs/heads/artel/x', userCommit], { cwd: project })
  const rejected = await git.exportRefToUserRepo({ sourceRef: 'refs/heads/artel/b1', targetRef: 'refs/heads/artel/x' }).catch((error) => error)
  assert.ok(rejected instanceof GitError)
  assert.equal(rejected.code, 'artel/export-exists')
  assert.equal(await userRef(project, 'refs/heads/artel/x'), userCommit)
  assert.equal(await projectHead(project), headBefore)
  assert.equal(await projectStatus(project), statusBefore)
})

test('exportRefToUserRepo refuses non-git projects, bad targets and missing branches', async () => {
  const plainState = await tempDir('artel-state-')
  const plain = await makeProject()
  const plainGit = await ArtelGit.init({ stateDir: plainState, projectPath: plain })
  await plainGit.importProject()
  const noRepo = await plainGit.exportRefToUserRepo({ sourceRef: 'refs/heads/applied', targetRef: 'refs/heads/artel/x' }).catch((error) => error)
  assert.ok(noRepo instanceof GitError)
  assert.equal(noRepo.code, 'artel/not-a-git-project')

  const stateDir = await tempDir('artel-state-')
  const project = await makeGitProject()
  const git = await ArtelGit.init({ stateDir, projectPath: project })
  await git.importProject()
  for (const targetRef of ['refs/heads/main', 'refs/heads/artel/', 'refs/heads/artel/../main', 'refs/heads/artel/x.lock', 'refs/tags/artel/x', 'refs/heads/artel/x y']) {
    const invalid = await git.exportRefToUserRepo({ sourceRef: 'refs/heads/applied', targetRef }).catch((error) => error)
    assert.ok(invalid instanceof GitError)
    assert.equal(invalid.code, 'artel/bad-request')
  }
  assert.equal(await userRef(project, 'refs/heads/artel/x'), null)

  const missing = await git.exportRefToUserRepo({ sourceRef: 'refs/heads/artel/nope', targetRef: 'refs/heads/artel/x' }).catch((error) => error)
  assert.ok(missing instanceof GitError)
  assert.equal(missing.code, 'artel/export-missing')
  assert.equal(await userRef(project, 'refs/heads/artel/x'), null)
})

test('commitTree writes a commit with the requested tree, parent and message', async () => {
  const { git, base } = await repoFixture()

  const root = await git.commitTree(base, { message: 'Revert apply' })
  assert.notEqual(root, base)
  assert.equal(await git.show(root, 'src/app.js'), 'export const answer = 1\n')
  const rootLog = await git.log(root, { max: 1 })
  assert.equal(rootLog[0].commit, root)
  assert.deepEqual(rootLog[0].parents, [])
  assert.equal(rootLog[0].subject, 'Revert apply')

  const child = await git.commitTree(base, { parent: base, message: 'Child commit' })
  const childLog = await git.log(child, { max: 1 })
  assert.equal(childLog[0].commit, child)
  assert.deepEqual(childLog[0].parents, [base])
  assert.equal(childLog[0].subject, 'Child commit')
  assert.equal(await git.show(child, 'README.md'), '# demo\n')
  assert.equal(await git.head(), base)
})

test('formatBytes renders binary sizes with one decimal above KiB', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MiB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GiB')
})

test('countObjects reports the repository size and gc runs', async () => {
  const { git } = await repoFixture()
  const before = await git.countObjects()
  assert.equal(typeof before.objects, 'number')
  assert.ok(before.objects > 0)
  assert.equal(typeof before.sizeBytes, 'number')
  assert.ok(before.sizeBytes >= 0)
  assert.equal(before.sizeText, formatBytes(before.sizeBytes))
  assert.match(before.sizeText, /^(?:\d+ B|\d+\.\d KiB|\d+\.\d MiB|\d+\.\d GiB)$/)

  await git.gc()
  const after = await git.countObjects()
  assert.equal(typeof after.objects, 'number')
  assert.ok(after.objects > 0)
  await git.gc({ pruneNow: true })
  await git.gcAuto()
  assert.equal(typeof (await git.countObjects()).objects, 'number')
})
