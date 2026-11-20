import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import { GitError, MIN_GIT_VERSION, compareVersions, parseGitVersion, projectKey, repoDirFor, requireGit, worktreeRootFor } from '../lib/git.js'

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
