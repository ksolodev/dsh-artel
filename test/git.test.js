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
