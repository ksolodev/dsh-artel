import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { ArtelGit, GitError, MIN_GIT_VERSION, compareVersions, parseGitVersion, projectKey, repoDirFor, requireGit, worktreeRootFor } from '../lib/git.js'

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

  const old = await requireGit({ runner: async () => ({ stdout: 'git version 2.20.0\n', stderr: '' }) }).catch((error) => error)
  assert.ok(old instanceof GitError)
  assert.equal(old.code, 'artel/git-missing')
  assert.match(old.message, new RegExp(MIN_GIT_VERSION.replaceAll('.', '\\.')))
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

  await assert.rejects(git.updateRef('refs/heads/artel/b1', imported, '0'.repeat(40)), (error) => error.code === 'artel/git-ref-changed')
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
