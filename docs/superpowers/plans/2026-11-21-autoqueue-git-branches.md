# Git-Backed Auto-Queue Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cumulative auto-queue version model with an app-owned Git repository: every queue task becomes one commit on a branch, branches can be reviewed, applied, rebuilt and merged, and the Orchestrator becomes a selectable queue mode.

**Architecture:** A new `lib/git.js` wraps the `git` binary and owns one repository per project under `<stateDir>/repos/<projectKey>.git`; the project directory itself is the work tree and keeps its own `.git` untouched. `lib/branches.js` is the only service that mutates the repository (branch records, apply/rebuild, branch merge, write-back to the project). `lib/engine.js` gains isolated seeded runs (diff against the seed, not the real project) and commit-backed review; `lib/queue-runner.js` drives the task lifecycle (start from a branch tip, commit on pass, legacy mode for 0.10 queues); the client renders the current branch, a branch modal and the apply dialog.

**Tech Stack:** Node.js ESM (Node >= 22.19), no npm dependencies, the `git` CLI (>= 2.30.0), node:test + node:assert/strict for tests, existing DSH Host plugin APIs (web routes, client bundle).

**Spec:** `docs/superpowers/specs/2026-11-21-autoqueue-git-branches-design.md`

## Global Constraints

- Node 22.19+ / 24+; no new npm dependencies; the only new runtime requirement is a `git` binary, version `2.30.0` or newer, detected at boot.
- Never read or write the user's own `.git`; all Artel Git state lives in `<stateDir>/repos/<projectKey>.git`, temporary worktrees in `<stateDir>/worktrees/<projectKey>/`, and no `.git` entry may appear inside a copy, seed or work tree handed to an agent (linked-worktree `.git` files are removed by `ArtelGit.materialize`).
- Text-safe commits: `core.autocrlf=false`, `core.safecrlf=false`, `core.fileMode=false`, `core.hooksPath=<repo>/hooks-off`, `core.longpaths=true` on Windows, info/attributes `* -text -filter`; binary files move through `Buffer` APIs, never through string round-trips.
- One queue task = one commit; commit subject is the task title; author is `Artel <artel@local>`.
- Apply writes back only added/modified/deleted paths and updates `refs/heads/applied`; it never silently drops drift and never leaves a partially written project.
- Branch queues use `queue.model === 'branches'`; queues created by 0.10 without that field stay on the legacy path until drained. `localStorage`/`snap` shapes: none of the new fields are persisted outside `stateDir`.
- Every user-facing string goes into all three dictionaries in `lib/client.js` (en, ru, zh); no string literals in components.
- Version for this feature: `0.11.0` in `package.json`, `lib/index.js` `version`, `lib/client.js` `CLIENT_VERSION`, tests; `0.12.0` items stay out of this plan.
- Run the whole suite before every commit: `node --test test/*.test.js` (Windows PowerShell: same command). Commit after each task.

## File Structure

Create:
- `lib/git.js` — git binary gate, repository layout, `ArtelGit` (init/open, refs, commits, worktrees, diff/log/status, merge/cherry-pick).
- `lib/branches.js` — `BranchService`: branch records, project state, apply/rebuild pipeline, branch merge, write-back.
- `test/git.test.js` — repository and plumbing tests.
- `test/branches.test.js` — branch service tests.
- `test/queue.test.js` — queue model v2 pure-function tests.

Modify:
- `lib/engine.js` — `isolateFromBase`, seeded orchestrator, commit-backed review, `markCommitted`, `markApplied`, `refreshInstall`, `assist`, `repairArtifact`, Git resolver.
- `lib/prompts.js` — `branchMergePrompt`, `branchConflictPrompt`.
- `lib/queue.js` — `QUEUE_MODES` + orchestrator, branch records, queue/task fields, summary shape.
- `lib/queue-runner.js` — branch lifecycle, orchestrator check fixer, branch delegation methods, legacy guard.
- `lib/index.js` — wire the Git resolver and the branch service.
- `lib/routes.js` — branch routes, orchestrator accepted, error mapping.
- `lib/client.js` — branch chip, picker, results card, branch modal, apply dialog, API calls, CSS, dictionaries.
- `test/engine.test.js`, `test/queue-runner.test.js`, `test/routes.test.js`, `test/client.test.js` — extended coverage.
- `package.json`, `lib/index.js`, `CHANGELOG.md`, `ARCHITECTURE.md`, `README.md`, `docs/guide.md`, `docs/guide.ru.md`, `docs/guide.zh.md` — release 0.11.0.

---

### Task 1: Git executable gate and repository identity helpers

**Files:**
- Create: `lib/git.js`
- Test: `test/git.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `MIN_GIT_VERSION = '2.30.0'`; `class GitError extends Error` with fields `code`, `stderr`, `args`, `exitCode`; `parseGitVersion(text): string`; `compareVersions(a, b): -1 | 0 | 1`; `projectKey(projectPath): string`; `repoDirFor(stateDir, projectPath): string`; `worktreeRootFor(stateDir, projectPath): string`; `async requireGit({ runner } = {}): { version: string }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/git.test.js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — `Cannot find module '../lib/git.js'`

- [ ] **Step 3: Write the minimal implementation**

```js
// lib/git.js
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The oldest git Artel supports: worktrees, update-ref CAS and porcelain v1 -z. */
export const MIN_GIT_VERSION = '2.30.0'

/** A git failure the plugin can explain to the client. */
export class GitError extends Error {
  constructor(message, { code = 'artel/git-failed', stderr = '', args = [], exitCode = null } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
    this.args = args
    this.exitCode = exitCode
  }
}

/**
 * Read a dotted version out of `git --version` output.
 * @param {string} text - command output.
 * @returns {string | null} version like '2.30.0', or null.
 */
export function parseGitVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`
}

/**
 * Compare dotted versions numerically.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {-1 | 0 | 1} order.
 */
export function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

/**
 * Stable repository key for a project path: the path is normalised (and
 * lower-cased on Windows) so the same project maps to the same repository.
 * @param {string} projectPath - project directory.
 * @returns {string} 20 hex chars.
 */
export function projectKey(projectPath) {
  const resolved = path.resolve(projectPath)
  const normalised = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  return crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 20)
}

/** @param {string} stateDir - plugin state dir. @param {string} projectPath - project. @returns {string} repo dir. */
export function repoDirFor(stateDir, projectPath) {
  return path.join(stateDir, 'repos', `${projectKey(projectPath)}.git`)
}

/** @param {string} stateDir - plugin state dir. @param {string} projectPath - project. @returns {string} worktree root. */
export function worktreeRootFor(stateDir, projectPath) {
  return path.join(stateDir, 'worktrees', projectKey(projectPath))
}

let cachedGit = null

/**
 * Ensure a usable git binary, once per process.
 * @param {{ runner?: () => Promise<{ stdout: string, stderr: string }> }} [options] - injectable runner for tests.
 * @returns {Promise<{ version: string }>} detected version.
 */
export async function requireGit({ runner = null } = {}) {
  if (runner === null && cachedGit !== null) return cachedGit
  let stdout
  try {
    const result = runner === null ? await execFileAsync('git', ['--version'], { windowsHide: true }) : await runner()
    stdout = String(result.stdout ?? '')
  } catch (error) {
    throw new GitError('Artel needs the git command line tool (2.30.0 or newer) to keep queue versions. Install Git and restart the session.', {
      code: 'artel/git-missing',
      stderr: String(error?.message ?? error),
    })
  }
  const version = parseGitVersion(stdout)
  if (version === null) throw new GitError(`Could not read the git version from: ${stdout.trim()}`, { code: 'artel/git-missing' })
  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    throw new GitError(`Artel needs git ${MIN_GIT_VERSION} or newer; this machine has ${version}. Upgrade Git and restart the session.`, { code: 'artel/git-missing' })
  }
  const result = { version }
  if (runner === null) cachedGit = result
  return result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS (6 tests). The last one needs a real `git` on PATH — CI installs it on `windows-latest`.

- [ ] **Step 5: Commit**

```powershell
git add lib/git.js test/git.test.js
git commit -m "feat: add the git executable gate and repo layout helpers"
```

---

### Task 2: ArtelGit repository lifecycle and command plumbing

**Files:**
- Modify: `lib/git.js` (append)
- Test: `test/git.test.js` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `class ArtelGit` with `constructor({ stateDir, projectPath, repoDir })`, `repoDir`, `projectPath`, `stateDir`; `static async init({ stateDir, projectPath, exclude = [] })`; `static async open({ stateDir, projectPath })` → instance | null; `async exec(args, { cwd = null, input = null, allowNonZero = false, env = {} } = {})` → `{ stdout: Buffer, stderr: string, exitCode: number }`; `async head()`; `async ref(name)`; `async refs(prefix = '')`; `async updateRef(name, sha, oldSha = null)`; `async deleteRef(name)`.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/git.test.js
import fs from 'node:fs/promises'

import { ArtelGit } from '../lib/git.js'

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
  await execFile('git', ['init'], { cwd: project })
  await execFile('git', ['config', 'user.email', 'user@example.com'], { cwd: project })
  await execFile('git', ['config', 'user.name', 'User'], { cwd: project })
  await execFile('git', ['add', '--all'], { cwd: project })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: project })
  const headBefore = await fs.readFile(path.join(project, '.git', 'HEAD'), 'utf8')

  await ArtelGit.init({ stateDir, projectPath: project })

  assert.equal(await fs.readFile(path.join(project, '.git', 'HEAD'), 'utf8'), headBefore)
  const status = await execFile('git', ['status', '--porcelain'], { cwd: project })
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
```

Note: this test block imports `execFile` from `node:child_process` (already used by the module under test, not exported) — add `import { execFile } from 'node:child_process'` and `import { promisify } from 'node:util'` at the top of `test/git.test.js`, plus `const execFileAsync = promisify(execFile)`; use `execFileAsync` for the git calls above.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — `ArtelGit is not a constructor` / import error.

- [ ] **Step 3: Write the minimal implementation**

```js
// append to lib/git.js

/** Repository config this plan relies on: text-safe, hook-free, worktree-based. */
const BASE_CONFIG = {
  'core.bare': 'false',
  'core.logallrefupdates': 'true',
  'core.autocrlf': 'false',
  'core.safecrlf': 'false',
  'core.filemode': 'false',
  'core.hooksPath': 'hooks-off',
  'core.longpaths': 'true',
  'gc.auto': '0',
  'advice.detachedHead': 'false',
  'user.name': 'Artel',
  'user.email': 'artel@local',
}

/**
 * Convert a simple glob (supporting `**`, `*`, `?`) into a RegExp.
 * @param {string} pattern - glob.
 * @returns {RegExp} matcher for posix paths.
 */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Test whether a relative posix path matches one of the configured globs.
 * @param {string} relPath - posix relative path.
 * @param {string[]} patterns - globs.
 * @returns {boolean} true when matched.
 */
function matchesAny(relPath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(relPath) || relPath === pattern || relPath.startsWith(`${pattern.replace(/\/+$/, '')}/`))
}

/**
 * Find nested git repositories inside a project, so they can be excluded from
 * the app repository (they are separate projects and must stay untouched).
 * @param {string} root - project dir.
 * @param {string[]} patterns - configured excludes.
 * @returns {Promise<string[]>} posix relative dirs.
 */
async function findNestedRepos(root, patterns = []) {
  const found = []
  async function walk(dir, rel) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (matchesAny(childRel, patterns)) continue
      const child = path.join(dir, entry.name)
      const dotGit = await fs.stat(path.join(child, '.git')).then(() => true).catch(() => false)
      if (dotGit) {
        found.push(childRel)
        continue
      }
      await walk(child, childRel)
    }
  }
  await walk(root, '')
  return found
}

/** The app-owned git repository of one project. */
export class ArtelGit {
  /**
   * @param {{ stateDir: string, projectPath: string, repoDir: string }} options - paths.
   */
  constructor({ stateDir, projectPath, repoDir }) {
    this.stateDir = stateDir
    this.projectPath = path.resolve(projectPath)
    this.repoDir = repoDir
  }

  /**
   * Create the repository for a project (does not import anything yet).
   * @param {{ stateDir: string, projectPath: string, exclude?: string[] }} options - inputs.
   * @returns {Promise<ArtelGit>} the repository.
   */
  static async init({ stateDir, projectPath, exclude = [] }) {
    await requireGit()
    const repoDir = repoDirFor(stateDir, projectPath)
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, 'artel-global.gitconfig'), '')
    await execFileAsync('git', ['init', '--bare', '--quiet', repoDir], { windowsHide: true })
    const git = new ArtelGit({ stateDir, projectPath, repoDir })
    for (const [key, value] of Object.entries(BASE_CONFIG)) {
      if (key === 'core.hooksPath') continue
      await git.exec(['config', key, value], { cwd: repoDir })
    }
    await git.exec(['config', 'core.hooksPath', path.join(repoDir, 'hooks-off')], { cwd: repoDir })
    await fs.mkdir(path.join(repoDir, 'hooks-off'), { recursive: true })
    await git.exec(['symbolic-ref', 'HEAD', 'refs/heads/applied'], { cwd: repoDir })

    await fs.mkdir(path.join(repoDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'info', 'attributes'), '* -text -filter\n')
    const nested = await findNestedRepos(projectPath, exclude)
    const ignoreLines = ['node_modules/', '.git'].concat(exclude.map((pattern) => `${pattern.replace(/\/+$/, '')}/`)).concat(nested.map((rel) => `/${rel}/`))
    await fs.writeFile(path.join(repoDir, 'info', 'exclude'), `${[...new Set(ignoreLines)].join('\n')}\n`)
    return git
  }

  /**
   * Open an existing repository, or null when this project has none.
   * @param {{ stateDir: string, projectPath: string }} options - inputs.
   * @returns {Promise<ArtelGit | null>} the repository.
   */
  static async open({ stateDir, projectPath }) {
    const repoDir = repoDirFor(stateDir, projectPath)
    const exists = await fs.stat(path.join(repoDir, 'HEAD')).then(() => true).catch(() => false)
    return exists ? new ArtelGit({ stateDir, projectPath, repoDir }) : null
  }

  /**
   * Open the repository, initialising it when the project has none.
   * @param {{ stateDir: string, projectPath: string, exclude?: string[] }} options - inputs.
   * @returns {Promise<{ git: ArtelGit, created: boolean }>} repository and whether it was created.
   */
  static async ensure({ stateDir, projectPath, exclude = [] }) {
    const opened = await ArtelGit.open({ stateDir, projectPath })
    if (opened !== null) return { git: opened, created: false }
    return { git: await ArtelGit.init({ stateDir, projectPath, exclude }), created: true }
  }

  /** Environment shared by every git call of this repository. */
  #baseEnv() {
    return {
      GIT_DIR: this.repoDir,
      GIT_WORK_TREE: this.projectPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(this.repoDir, 'artel-global.gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1',
    }
  }

  /**
   * Run git.
   *
   * Without `cwd` the call runs against the configured work tree; with `cwd`
   * the app env is removed so `git -C <dir>` discovers a linked worktree's
   * `.git` file. Explicit `env.GIT_DIR`/`env.GIT_WORK_TREE` wins over both
   * modes, which is how commitDir stages an arbitrary directory.
   * @param {string[]} args - git arguments.
   * @param {{ cwd?: string | null, input?: string | Buffer | null, allowNonZero?: boolean, env?: Record<string, string> }} [options] - call options.
   * @returns {Promise<{ stdout: Buffer, stderr: string, exitCode: number }>} output.
   */
  async exec(args, { cwd = null, input = null, allowNonZero = false, env: extraEnv = {} } = {}) {
    const env = { ...process.env, ...this.#baseEnv(), ...extraEnv }
    if (cwd !== null && extraEnv.GIT_DIR === undefined) {
      delete env.GIT_DIR
      delete env.GIT_WORK_TREE
      delete env.GIT_INDEX_FILE
    }
    const argv = cwd !== null ? ['-C', cwd, ...args] : args
    return await new Promise((resolve, reject) => {
      const child = spawn('git', argv, { cwd: cwd ?? this.repoDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const out = []
      const err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      child.on('error', (error) => {
        reject(new GitError(`git ${args[0] ?? ''} could not start: ${error.message}`, { code: 'artel/git-missing', args, stderr: error.message }))
      })
      child.on('close', (exitCode) => {
        const stderr = Buffer.concat(err).toString('utf8').trim()
        if (exitCode !== 0 && allowNonZero !== true) {
          reject(new GitError(`git ${args.join(' ')} failed: ${stderr || `exit code ${exitCode}`}`, { args, stderr, exitCode }))
          return
        }
        resolve({ stdout: Buffer.concat(out), stderr, exitCode: exitCode ?? 1 })
      })
      if (input !== null && input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    })
  }

  /** @returns {Promise<string | null>} the applied commit. */
  async head() {
    return await this.ref('refs/heads/applied')
  }

  /** @param {string} name - full ref. @returns {Promise<string | null>} commit or null. */
  async ref(name) {
    try {
      const result = await this.exec(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: this.repoDir, allowNonZero: true })
      const sha = result.stdout.toString('utf8').trim()
      return sha === '' ? null : sha
    } catch {
      return null
    }
  }

  /** @param {string} [prefix] - ref prefix. @returns {Promise<Map<string, string>>} refs and commits. */
  async refs(prefix = '') {
    const result = await this.exec(['for-each-ref', '--format=%(refname) %(objectname)', prefix], { cwd: this.repoDir })
    const refs = new Map()
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const [name, sha] = line.trim().split(' ')
      if (name && sha) refs.set(name, sha)
    }
    return refs
  }

  /**
   * Move a ref only if it still points at `oldSha` (null = must not exist).
   * @param {string} name - full ref.
   * @param {string} sha - new commit.
   * @param {string | null} [oldSha] - expected current commit.
   * @returns {Promise<void>} completes when moved.
   */
  async updateRef(name, sha, oldSha = null) {
    const expected = oldSha === null ? '0'.repeat(40) : oldSha
    try {
      await this.exec(['update-ref', name, sha, expected], { cwd: this.repoDir })
    } catch (error) {
      if (error instanceof GitError) {
        throw new GitError(`Reference ${name} changed under Artel`, { code: 'artel/git-ref-changed', args: error.args, stderr: error.stderr, exitCode: error.exitCode })
      }
      throw error
    }
  }

  /** @param {string} name - full ref. @returns {Promise<void>} completes when deleted (missing refs are fine). */
  async deleteRef(name) {
    await this.exec(['update-ref', '-d', name], { cwd: this.repoDir, allowNonZero: true })
  }
}
```

Add `import { spawn } from 'node:child_process'` to the imports of `lib/git.js` (keep `execFile`/`promisify` for `requireGit`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```powershell
git add lib/git.js test/git.test.js
git commit -m "feat: model the app-owned git repository and its ref plumbing"
```

---

### Task 3: Commits, snapshots, diff, log and status

**Files:**
- Modify: `lib/git.js` (append methods to `ArtelGit`)
- Test: `test/git.test.js` (append)

**Interfaces:**
- Consumes: Task 2.
- Produces (methods on `ArtelGit`): `async importProject({ message = 'Import project' } = {})` → sha; `async commitDir(dir, { parent = null, message })` → sha; `async worktreeAdd(dir, commit)`; `async worktreeRemove(dir)`; `async pruneWorktrees()`; `async materialize(dir, commit)` → dir; `async tree(commit)` → `{ path, mode, type, sha }[]`; `async show(commit, relPath)` → string | null; `async blob(commit, relPath)` → Buffer | null; `async changes(from, to)` → `{ path, status, added, removed, binary }[]`; `async log(ref, { max = 50 } = {})` → `{ commit, parents, author, date, subject }[]`; `async revList({ from = null, to })` → string[] oldest→newest; `async status()` → `{ path, status }[]`.

> **Already implemented (Task 2 deviation, commit `2ff3f6d`):** `importProject()` and `commitDir()` moved into Task 2 because its refs test needs them, and `init()` now also sets `core.worktree`. Do not re-add these two methods; check they already exist and match this task's tests, then implement only `worktreeAdd`, `worktreeRemove`, `pruneWorktrees`, `materialize`, `tree`, `show`, `blob`, `changes`, `log`, `revList`, `status`, and append the tests that are not already present.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/git.test.js

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — `git.importProject is not a function`.

- [ ] **Step 3: Write the minimal implementation**

```js
// append to lib/git.js

/** @param {Buffer} buffer - output to split. @returns {string[]} NUL-separated tokens. */
function splitZ(buffer) {
  return buffer.toString('utf8').split('\0').filter((part) => part !== '')
}

// inside class ArtelGit, after deleteRef():

  /**
   * Snapshot the project as the first commit of the applied ref.
   * @param {{ message?: string }} [options] - commit message.
   * @returns {Promise<string>} commit.
   */
  async importProject({ message = 'Import project' } = {}) {
    const commit = await this.commitDir(this.projectPath, { parent: null, message })
    await this.updateRef('refs/heads/applied', commit, null)
    return commit
  }

  /**
   * Stage a directory and write one commit (never touches the real project or
   * the user's repository; a temporary index is used).
   * @param {string} dir - directory to snapshot.
   * @param {{ parent?: string | null, message: string }} options - commit inputs.
   * @returns {Promise<string>} commit.
   */
  async commitDir(dir, { parent = null, message }) {
    const indexFile = path.join(this.repoDir, `index-${crypto.randomUUID()}`)
    const env = { GIT_DIR: this.repoDir, GIT_WORK_TREE: path.resolve(dir), GIT_INDEX_FILE: indexFile }
    try {
      await this.exec(['read-tree', '--empty'], { cwd: dir, env })
      await this.exec(['add', '--all'], { cwd: dir, env })
      const tree = (await this.exec(['write-tree'], { cwd: dir, env })).stdout.toString('utf8').trim()
      const args = ['commit-tree', tree, '-m', message]
      if (parent !== null) args.push('-p', parent)
      return (await this.exec(args, { cwd: dir, env })).stdout.toString('utf8').trim()
    } finally {
      await fs.rm(indexFile, { force: true })
    }
  }

  /** @param {string} dir - target dir. @param {string} commit - commit. @returns {Promise<void>} completes when added. */
  async worktreeAdd(dir, commit) {
    await this.pruneWorktrees()
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await this.exec(['worktree', 'add', '--detach', '--force', path.resolve(dir), commit], { cwd: this.repoDir })
  }

  /** @param {string} dir - worktree dir. @returns {Promise<void>} completes when removed. */
  async worktreeRemove(dir) {
    await this.exec(['worktree', 'remove', '--force', path.resolve(dir)], { cwd: this.repoDir, allowNonZero: true })
    await fs.rm(dir, { recursive: true, force: true })
  }

  /** @returns {Promise<void>} completes when stale worktree registrations are pruned. */
  async pruneWorktrees() {
    await this.exec(['worktree', 'prune'], { cwd: this.repoDir, allowNonZero: true })
  }

  /**
   * Plain copy of a commit: a linked worktree without its `.git` file, so an
   * agent (or the engine copying a seed) sees a normal directory.
   * @param {string} dir - target dir.
   * @param {string} commit - commit.
   * @returns {Promise<string>} dir.
   */
  async materialize(dir, commit) {
    await fs.rm(dir, { recursive: true, force: true })
    await this.worktreeAdd(dir, commit)
    const dotGit = path.join(dir, '.git')
    const stat = await fs.stat(dotGit).then((value) => value).catch(() => null)
    if (stat !== null && stat.isFile()) await fs.rm(dotGit, { force: true })
    return dir
  }

  /** @param {string} commit - commit. @returns {Promise<{ path: string, mode: string, type: string, sha: string }[]>} entries. */
  async tree(commit) {
    const tokens = splitZ((await this.exec(['ls-tree', '-r', '-z', commit], { cwd: this.repoDir })).stdout)
    return tokens.map((token) => {
      const [meta, relPath] = token.split('\t')
      const [mode, type, sha] = meta.split(' ')
      return { path: relPath, mode, type, sha }
    })
  }

  /** @param {string} commit - commit. @param {string} relPath - posix path. @returns {Promise<string | null>} text or null. */
  async show(commit, relPath) {
    const buffer = await this.blob(commit, relPath)
    if (buffer === null) return null
    if (buffer.includes(0)) return null
    return buffer.toString('utf8')
  }

  /** @param {string} commit - commit. @param {string} relPath - posix path. @returns {Promise<Buffer | null>} bytes or null. */
  async blob(commit, relPath) {
    try {
      const result = await this.exec(['cat-file', 'blob', `${commit}:${relPath}`], { cwd: this.repoDir, allowNonZero: true })
      if (result.exitCode !== 0) return null
      return result.stdout
    } catch {
      return null
    }
  }

  /**
   * Compare two commits.
   * @param {string} from - older commit.
   * @param {string} to - newer commit.
   * @returns {Promise<{ path: string, status: string, added: number, removed: number, binary: boolean }[]>} changes.
   */
  async changes(from, to) {
    const statuses = splitZ((await this.exec(['diff', '--name-status', '-z', '--no-renames', from, to], { cwd: this.repoDir })).stdout)
    const numbers = splitZ((await this.exec(['diff', '--numstat', '-z', '--no-renames', from, to], { cwd: this.repoDir })).stdout)
    const counts = new Map()
    for (const token of numbers) {
      const [added, removed, relPath] = token.split('\t')
      if (relPath !== undefined) counts.set(relPath, { added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), binary: added === '-' })
    }
    const names = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }
    const result = []
    for (let index = 0; index + 1 < statuses.length; index += 2) {
      const status = names[statuses[index]] ?? 'modified'
      const relPath = statuses[index + 1]
      const count = counts.get(relPath) ?? { added: 0, removed: 0, binary: false }
      result.push({ path: relPath, status, ...count })
    }
    return result
  }

  /**
   * Read the log of a ref.
   * @param {string} ref - rev or ref.
   * @param {{ max?: number }} [options] - page size.
   * @returns {Promise<{ commit: string, parents: string[], author: string, date: string, subject: string }[]>} newest first.
   */
  async log(ref, { max = 50 } = {}) {
    const output = (await this.exec(['log', `--format=%H%x00%P%x00%an%x00%ai%x00%s`, '-n', String(max), ref], { cwd: this.repoDir, allowNonZero: true })).stdout.toString('utf8')
    const rows = []
    for (const line of output.split('\n')) {
      if (line.trim() === '') continue
      const [commit, parents, author, date, subject] = line.split('\0')
      rows.push({ commit, parents: parents === '' ? [] : parents.split(' '), author, date, subject })
    }
    return rows
  }

  /**
   * Commits between two refs, oldest first.
   * @param {{ from?: string | null, to: string }} options - range.
   * @returns {Promise<string[]>} commits.
   */
  async revList({ from = null, to }) {
    const range = from === null ? to : `${from}..${to}`
    const output = (await this.exec(['rev-list', '--reverse', range], { cwd: this.repoDir })).stdout.toString('utf8')
    return output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  }

  /**
   * Project drift against the applied head.
   * @returns {Promise<{ path: string, status: string }[]>} changed and untracked paths.
   */
  async status() {
    if (await this.head() === null) return []
    await this.exec(['read-tree', 'HEAD'], { cwd: this.projectPath, allowNonZero: true })
    const tokens = splitZ((await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: this.projectPath, allowNonZero: true })).stdout)
    const result = []
    for (const token of tokens) {
      if (token.length < 4) continue
      const code = token.slice(0, 2)
      const relPath = token.slice(3)
      let status = 'modified'
      if (code === '??') status = 'untracked'
      else if (code.includes('A')) status = 'added'
      else if (code.includes('D')) status = 'deleted'
      else if (code.includes('R')) status = 'renamed'
      result.push({ path: relPath, status })
    }
    return result
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```powershell
git add lib/git.js test/git.test.js
git commit -m "feat: commit snapshots, materialise them and read diffs from git"
```

---

### Task 4: Merge, cherry-pick and worktree commits

**Files:**
- Modify: `lib/git.js` (append methods to `ArtelGit`)
- Test: `test/git.test.js` (append)

**Interfaces:**
- Consumes: Task 3.
- Produces (methods on `ArtelGit`): `async unmergedPaths(dir)` → string[]; `async addAll(dir)`; `async commitWorktree(dir, { message })` → sha; `async mergeInto(dir, { source, message })` → `{ conflicts: string[], mergeCommit: string | null }`; `async mergeContinue(dir, { message })` → sha | null; `async cherryPick(dir, sha)` → `{ conflicts: string[] }`; `async quitCherryPick(dir)`.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/git.test.js

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/git.test.js`
Expected: FAIL — `git.mergeInto is not a function`.

- [ ] **Step 3: Write the minimal implementation**

```js
// append to lib/git.js (inside ArtelGit, after status())

  /** @param {string} dir - worktree. @returns {Promise<string[]>} conflicted paths. */
  async unmergedPaths(dir) {
    const tokens = splitZ((await this.exec(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: dir, allowNonZero: true })).stdout)
    return tokens.map((path) => path.trim()).filter((path) => path !== '')
  }

  /** @param {string} dir - worktree. @returns {Promise<void>} completes when staged. */
  async addAll(dir) {
    await this.exec(['add', '--all'], { cwd: dir })
  }

  /**
   * Commit the current worktree.
   * @param {string} dir - worktree.
   * @param {{ message: string }} options - message.
   * @returns {Promise<string>} commit.
   */
  async commitWorktree(dir, { message }) {
    await this.addAll(dir)
    await this.exec(['commit', '--allow-empty', '-m', message], { cwd: dir })
    return (await this.exec(['rev-parse', 'HEAD'], { cwd: dir })).stdout.toString('utf8').trim()
  }

  /**
   * Merge one commit into a worktree without committing yet.
   * @param {string} dir - worktree checked out at the target commit.
   * @param {{ source: string, message: string }} options - merge inputs.
   * @returns {Promise<{ conflicts: string[], mergeCommit: string | null }>} outcome.
   */
  async mergeInto(dir, { source, message }) {
    await this.exec(['merge', '--no-ff', '--no-commit', source], { cwd: dir, allowNonZero: true })
    const conflicts = await this.unmergedPaths(dir)
    if (conflicts.length > 0) return { conflicts, mergeCommit: null }
    return { conflicts: [], mergeCommit: await this.commitWorktree(dir, { message }) }
  }

  /**
   * Complete a merge after the fixer resolved the working tree.
   * @param {string} dir - worktree with MERGE_HEAD.
   * @param {{ message: string }} options - message.
   * @returns {Promise<string | null>} merge commit or null when no merge is in progress.
   */
  async mergeContinue(dir, { message }) {
    const mergeHead = await this.exec(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: dir, allowNonZero: true }).then((result) => result.stdout.toString('utf8').trim()).catch(() => '')
    if (mergeHead === '') return null
    const conflicts = await this.unmergedPaths(dir)
    if (conflicts.length > 0) throw new GitError(`Merge still has conflicts: ${conflicts.join(', ')}`, { code: 'artel/git-conflict', args: ['merge'] })
    await this.addAll(dir)
    await this.exec(['commit', '--allow-empty', '-m', message], { cwd: dir })
    return (await this.exec(['rev-parse', 'HEAD'], { cwd: dir })).stdout.toString('utf8').trim()
  }

  /**
   * Apply one commit onto the worktree index without committing.
   * @param {string} dir - worktree at the target head.
   * @param {string} sha - commit to apply.
   * @returns {Promise<{ conflicts: string[] }>} conflicted paths.
   */
  async cherryPick(dir, sha) {
    await this.exec(['cherry-pick', '-n', sha], { cwd: dir, allowNonZero: true })
    return { conflicts: await this.unmergedPaths(dir) }
  }

  /** @param {string} dir - worktree. @returns {Promise<void>} completes when sequencer state is cleared. */
  async quitCherryPick(dir) {
    await this.exec(['cherry-pick', '--quit'], { cwd: dir, allowNonZero: true })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/git.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```powershell
git add lib/git.js test/git.test.js
git commit -m "feat: merge, cherry-pick and worktree commits for queue branches"
```

---

### Task 5: Engine — isolated seeded runs and commit-backed review

**Files:**
- Modify: `lib/engine.js`
- Test: `test/engine.test.js` (append; reuse the existing `fixture()` helper at line 159)

**Interfaces:**
- Consumes: Tasks 1–4 (`ArtelGit`), existing `copyProjectTree`/`hashTree`/`removeCopy` from `lib/copy.js`, `detectInstallNeeds` from `lib/install.js`.
- Produces:
  - `constructor` accepts `gitResolver?: ((projectPath: string) => Promise<ArtelGit | null>) | null`; `setGitResolver(resolver)`.
  - `start()` options gain `isolateFromBase = false`, `branchId = null`, `parentCommit = null`; run record gains `isolated: boolean`, `branchId: string | null`, `parentCommit: string | null`, `commit: string | null`.
  - `async changes(runId)` returns stored `run.files` (each with `hunks: []`) when `run.commit` is set.
  - `async fileDiff(runId, relPath)` resolves committed runs through `git.show(parentCommit|commit, relPath)`.
  - `async apply(runId)` throws 409 `artel/branch-apply-required` for isolated or committed runs.
  - `async discard(runId)` throws 409 `artel/commit-owned` for committed runs.
  - `async markCommitted(runId, { branchId, parentCommit, commit, files, changeCount })` → run summary.
  - `async markApplied(runId, { commit = null } = {})` → run summary.
  - `async refreshInstall(runId)` → install needs | null.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/engine.test.js
import { ArtelGit } from '../lib/git.js'
import { hashTree } from '../lib/copy.js'

test('an isolated seeded run diffs against its seed and refuses a direct apply', async () => {
  const f = await fixture('isolated')
  try {
    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'src', 'app.js'), 'export const answer = 2\n')
    const seedManifest = await hashTree(seed)

    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer', basePath: seed, isolateFromBase: true })
    assert.equal(run.isolated, true)
    assert.equal(run.basePath, seed)
    assert.deepEqual(Object.keys(run.baseHashes).sort(), ['README.md', 'src/app.js'])
    assert.equal(run.baseHashes['src/app.js'].hash, seedManifest.files['src/app.js'].hash)
    assert.notEqual(run.baseHashes['src/app.js'].hash, (await hashTree(f.projectPath)).files['src/app.js'].hash)

    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    const changes = await f.engine.changes(run.id)
    assert.deepEqual(changes.map((change) => change.path), ['src/app.js'])
    await assert.rejects(f.engine.apply(run.id), (error) => error.code === 'artel/branch-apply-required')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('a committed run is reviewed through git and refuses apply and discard', async () => {
  const f = await fixture('committed')
  try {
    const git = await ArtelGit.init({ stateDir: f.stateDir, projectPath: f.projectPath })
    const imported = await git.importProject()
    f.engine.setGitResolver(async (projectPath) => (path.resolve(projectPath) === path.resolve(f.projectPath) ? git : null))

    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'src', 'app.js'), 'export const answer = 2\n')
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Change the answer', basePath: seed, isolateFromBase: true })
    const handle = f.driver.created[0]
    await fs.writeFile(path.join(run.copyPath, 'src', 'app.js'), 'export const answer = 3\n')
    await f.driver.emit(handle, { kind: 'turn-end' })
    const waiting = f.engine.listRuns('s1')[0]
    assert.equal(waiting.status, 'waiting')

    const files = await f.engine.changes(run.id)
    const commit = await git.commitDir(run.copyPath, { parent: imported, message: 'Task: answer to 3' })
    await f.engine.markCommitted(run.id, { branchId: 'b1', parentCommit: imported, commit, files, changeCount: files.length })
    const committed = f.engine.listRuns('s1')[0]
    assert.equal(committed.commit, commit)
    assert.equal(committed.copyPath, null)
    await assert.rejects(() => fs.stat(run.copyPath))
    assert.deepEqual((await f.engine.changes(run.id)).map((change) => change.path), ['src/app.js'])

    const diff = await f.engine.fileDiff(run.id, 'src/app.js')
    assert.match(diff.before, /answer = 2/)
    assert.match(diff.after, /answer = 3/)

    await assert.rejects(f.engine.apply(run.id), (error) => error.code === 'artel/branch-apply-required')
    await assert.rejects(f.engine.discard(run.id), (error) => error.code === 'artel/commit-owned')

    await f.engine.markApplied(run.id, { commit })
    assert.equal(f.engine.listRuns('s1')[0].status, 'applied')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('refreshInstall discovers install needs on the project', async () => {
  const f = await fixture('install')
  try {
    await fs.writeFile(path.join(f.projectPath, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, null, 2))
    await fs.writeFile(path.join(f.projectPath, 'cordis.patch.yml'), 'patches: []\n')
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Touch the README' })
    const install = await f.engine.refreshInstall(run.id)
    assert.notEqual(install, null)
    assert.equal(f.engine.getRun(run.id).install, install)
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — `run.isolated` is undefined / `setGitResolver is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Edit `lib/engine.js`:

1) Constructor (~line 220) — accept the resolver and add the helper:

```js
constructor({ store, driver, copyRoot, config = {}, log = console, now = () => Date.now(), gitResolver = null }) {
  // ...existing fields...
  this.#gitResolver = typeof gitResolver === 'function' ? gitResolver : null
}

/**
 * Install the resolver the queue uses to find the app-owned repository.
 * @param {((projectPath: string) => Promise<object | null>) | null} resolver - resolver.
 */
setGitResolver(resolver) {
  this.#gitResolver = typeof resolver === 'function' ? resolver : null
}

async #gitFor(projectPath) {
  if (this.#gitResolver === null) return null
  try {
    return await this.#gitResolver(projectPath)
  } catch {
    return null
  }
}

/** The directory a run's changes are compared against. */
#beforeRoot(run) {
  if (run.mode === 'orchestrator') return typeof run.basePath === 'string' && run.basePath !== '' ? run.basePath : run.projectPath
  if (run.isolated === true && typeof run.basePath === 'string' && run.basePath !== '') return run.basePath
  return run.projectPath
}
```

2) `start()` signature (~line 487) becomes:

```js
async start({ sessionId, projectPath, mode, task, model, models, basePath = null, sandboxMode = null, autoqueue = false, planApproval = false, isolateFromBase = false, branchId = null, parentCommit = null }) {
```

After the basePath resolution (~line 531) reject an isolated run without a seed:

```js
if (isolateFromBase === true && sourcePath === project) {
  throw new ArtelError('An isolated queue run needs a base version to start from.', 400, 'artel/bad-request')
}
```

3) Run record (~line 565) gains `isolated: isolateFromBase === true, branchId, parentCommit, commit: null`.

4) Seeded copy (~line 647) — the old expression
`const base = sourcePath === project ? copied.base : (await hashTree(project, { exclude })).files`
becomes:

```js
const base = isolateFromBase === true ? copied.base : (await hashTree(project, { exclude: this.#config.excludeGlobs ?? [] })).files
```

so an isolated run also diffs `changes()` as parent-copy instead of copy-project.

5) `changes(runId)` (~line 2521) starts with the committed short-circuit and the helper root:

```js
async changes(runId) {
  const run = this.#requireRun(runId)
  if (typeof run.commit === 'string' && run.commit !== '') {
    return (run.files ?? []).map((file) => ({ ...file, hunks: [] }))
  }
  // ...existing guard for a missing copyPath...
  const options = { exclude: this.#config.excludeGlobs ?? [], context: this.#config.diffContext }
  return (await collectChanges({ copyRoot: run.copyPath, beforeRoot: this.#beforeRoot(run), base: run.baseHashes ?? {}, options })).map(/* existing mapping */)
}
```

6) `fileDiff(runId, relPath)` (~line 2544) — before reading files, resolve a commit through git and keep the existing return shape:

```js
async fileDiff(runId, relPath) {
  const run = this.#requireRun(runId)
  if (typeof run.commit === 'string' && run.commit !== '') {
    const git = await this.#gitFor(run.projectPath)
    if (git !== null) {
      const before = run.parentCommit === null ? null : await git.show(run.parentCommit, relPath)
      const after = await git.show(run.commit, relPath)
      if (before === null && after === null) return { path: relPath, before: '', after: '', binary: true, hunks: [] }
      return { path: relPath, before: before ?? '', after: after ?? '', binary: false, hunks: diffFile(relPath, before ?? '', after ?? '') }
    }
  }
  // ...existing implementation, but read the before file under this.#beforeRoot(run)...
}
```

7) `apply()` (~line 2575) — first statement after `const run = this.#requireRun(runId)`:

```js
if (typeof run.commit === 'string' && run.commit !== '') throw new ArtelError('This run is a commit on an auto-queue branch: apply the branch from the queue.', 409, 'artel/branch-apply-required')
if (run.isolated === true) throw new ArtelError('This run is isolated on an auto-queue branch: apply the branch from the queue.', 409, 'artel/branch-apply-required')
```

8) `discard()` (~line 2802) — first statement after the run lookup:

```js
if (typeof run.commit === 'string' && run.commit !== '') throw new ArtelError('This run is a branch commit: delete the branch instead of discarding the run.', 409, 'artel/commit-owned')
```

9) Append the new public methods near `apply()`:

```js
/**
 * Store that the run's copy has become a commit on a queue branch; the copy is
 * deleted because the commit owns the content now.
 * @param {string} runId - run id.
 * @param {{ branchId: string, parentCommit: string, commit: string, files: object[], changeCount: number }} input - commit facts.
 * @returns {Promise<object>} run summary.
 */
async markCommitted(runId, { branchId, parentCommit, commit, files, changeCount }) {
  const run = this.#requireRun(runId)
  await this.#removePartCopies(run)
  if (typeof run.copyPath === 'string' && run.copyPath !== '') await removeCopy(run.copyPath).catch(() => {})
  await this.#store.patch(runId, {
    copyPath: null,
    copyKind: null,
    branchId,
    parentCommit,
    commit,
    files: (files ?? []).map((file) => ({ path: file.path, status: file.status, added: file.added, removed: file.removed, binary: file.binary === true })),
    changeCount,
    status: 'waiting',
  })
  const rt = this.#runtime(runId)
  if (rt !== undefined) rt.record = this.#store.get(runId)
  await this.#feed(runId, { kind: 'status', text: `Commit ${String(commit).slice(0, 7)} is on the branch.`, commit })
  return this.#store.get(runId)
}

/** @param {string} runId - run id. @param {{ commit?: string | null }} [input] - applied commit. @returns {Promise<object>} run summary. */
async markApplied(runId, { commit = null } = {}) {
  const run = this.#requireRun(runId)
  if (typeof run.commit !== 'string' || run.commit === '') throw new ArtelError('The run has no branch commit to mark as applied.', 409, 'artel/not-committed')
  await this.#store.patch(runId, { status: 'applied', appliedAt: this.#now(), ...(commit === null ? {} : { appliedCommit: commit }) })
  await this.#retire(runId)
  await this.#feed(runId, { kind: 'status', text: 'The branch commit landed in your project.' })
  return this.#store.get(runId)
}

/** @param {string} runId - run id. @returns {Promise<object | null>} install needs discovered on the project. */
async refreshInstall(runId) {
  const run = this.#requireRun(runId)
  const install = await detectInstallNeeds(run.projectPath).catch(() => null)
  if (install !== null && install !== undefined) await this.#store.patch(runId, { install })
  return install ?? null
}
```

Add `gitResolver = null` to the destructured constructor options and `this.#gitResolver = ...` under the existing private-field declarations (`#gitResolver = null`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS — all previous engine tests plus 3 new ones.

- [ ] **Step 5: Commit**

```powershell
git add lib/engine.js test/engine.test.js
git commit -m "feat: isolated seeded runs and commit-backed review in the engine"
```

---

### Task 6: Engine — Orchestrator seeded from a base version, fixer primitives

**Files:**
- Modify: `lib/engine.js`
- Test: `test/engine.test.js` (append)

**Interfaces:**
- Consumes: Task 5 (`#beforeRoot`, `#gitFor`), existing `#createOrchestratorAgent(runId, run, runtime, { role, copyPath, sandboxMode, title })`, `#send(runId, rt, text)`, `#feed`, `#config`.
- Produces:
  - Orchestrator runs with `basePath` keep every read/edit below the seed: planner reads `run.basePath` through its own copy, parts are copied from `run.basePath`, assembly is copied from `run.basePath`, conflict bundles take the base file from `run.basePath`, and `changes()`/`#partDigest` compare against `run.basePath` (via `#beforeRoot`).
  - `async assist({ projectPath, copyPath, prompt, title = 'Artel fixer', model = null, sandboxMode = null, timeoutMs = 600000 })` → `{ message: string, agentId: string }`.
  - `async repairArtifact(runId, { prompt, purpose = 'check' })` → `{ agentId: string, changeCount: number }`; allowed only for an Orchestrator run at `status === 'waiting'` with `run.merge.stage === 'assembled'`, one fixer at a time (409 `artel/fixer-busy`).

- [ ] **Step 1: Write the failing tests**

```js
// append to test/engine.test.js

test('a seeded Orchestrator reads and copies the seed, not the real project', async () => {
  const f = await fixture('orchestrator-seeded')
  try {
    const seed = path.join(f.root, 'seed')
    await fs.cp(f.projectPath, seed, { recursive: true })
    await fs.writeFile(path.join(seed, 'README.md'), '# Seed\n')
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'orchestrator', task: 'Ship the seed', basePath: seed, isolateFromBase: true })
    assert.equal(run.mode, 'orchestrator')
    assert.equal(run.basePath, seed)
    const planner = f.driver.created[0]
    assert.notEqual(path.resolve(planner.copyPath), path.resolve(f.projectPath))
    assert.equal(await fs.readFile(path.join(planner.copyPath, 'README.md'), 'utf8'), '# Seed\n')
    assert.equal(await fs.readFile(path.join(f.projectPath, 'README.md'), 'utf8'), '# Demo\n')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('assist runs one short-lived agent and returns its report', async () => {
  const f = await fixture('assist')
  try {
    const copy = path.join(f.root, 'fixer-copy')
    await fs.cp(f.projectPath, copy, { recursive: true })
    const promise = f.engine.assist({ projectPath: f.projectPath, copyPath: copy, prompt: 'Resolve the conflict in README.md' })
    await new Promise((resolve) => setImmediate(resolve))
    const fixer = f.driver.created[0]
    assert.match(f.driver.prompts[0].text, /Resolve the conflict/)
    await f.driver.emit(fixer, { kind: 'assistant', text: 'Merged both intents.' })
    await f.driver.emit(fixer, { kind: 'turn-end' })
    const result = await promise
    assert.equal(result.message, 'Merged both intents.')
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})

test('repairArtifact only accepts an assembled Orchestrator run', async () => {
  const f = await fixture('repair-guard')
  try {
    const run = await f.engine.start({ sessionId: 's1', projectPath: f.projectPath, mode: 'solo', task: 'Touch the readme' })
    await assert.rejects(
      f.engine.repairArtifact(run.id, { prompt: 'fix it' }),
      (error) => error.code === 'artel/bad-mode',
    )
  } finally {
    await f.engine.dispose()
    await f.cleanup()
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/engine.test.js`
Expected: FAIL — seeded orchestrator planner reads the real project; `assist` missing.

- [ ] **Step 3: Write the minimal implementation**

Edit `lib/engine.js`:

1) Add the helper next to `#beforeRoot`:

```js
/** The tree an Orchestrator copies from: the seed when the run has one. */
#orchestratorSource(run) {
  return typeof run.basePath === 'string' && run.basePath !== '' && run.basePath !== run.projectPath ? run.basePath : run.projectPath
}
```

2) `#startOrchestrator()` (~line 1509) — the planner must read a copy of the seed:

```js
async #startOrchestrator(runId) {
  const run = this.#requireRun(runId)
  const runtime = this.#runtime(runId)
  const source = this.#orchestratorSource(run)
  const plannerCopy = source === run.projectPath ? run.projectPath : path.join(this.#copyRoot, `${run.id}-planner`)
  if (plannerCopy !== run.projectPath) {
    await copyProjectTree(source, plannerCopy, { exclude: this.#config.excludeGlobs ?? [], linkNodeModules: true })
  }
  const planner = await this.#createOrchestratorAgent(runId, run, runtime, { role: 'planner', copyPath: plannerCopy, sandboxMode: 'read-only', title: 'Planner' })
  runtime.orch.stage = 'planning'
  await this.#store.patch(runId, { status: 'planning' })
  await this.#feed(runId, { kind: 'status', text: `${planner.record.name} is reading the project and splitting the goal into parts. Nothing is edited in this step.` })
  planner.done = false
  await this.#send(runId, planner, orchestratorPlanPrompt({ projectPath: source, task: run.task, maxParts: this.#orchestratorPartLimit() }))
}
```

Keep the rest of the method (idle checks, timers) exactly as it is.

3) `#startOrchestratorParts()` (~line 1683) — copy from the seed and compare against it:

```js
const source = this.#orchestratorSource(run)
// inside the per-part loop, replace run.projectPath with source:
const copied = await copyProjectTree(source, part.copyPath, { exclude: this.#config.excludeGlobs ?? [], linkNodeModules: true })
if (index === 0) {
  runtime.base = copied.base
  runtime.orch.baseHashes = copied.base
  await this.#store.patch(runId, { baseHashes: copied.base })
}
// the worker prompt keeps `projectPath: run.projectPath` (the user's path is informational)
```

4) `#partDigest()` (~line 1754) — replace `beforeRoot: run.projectPath` with:

```js
beforeRoot: this.#beforeRoot(run),
```

5) `#startOrchestratorMerge()` (~line 1946) — replace the assembly source and conflict base:

```js
const source = this.#orchestratorSource(run)
const copied = await copyProjectTree(source, run.copyPath, { exclude: this.#config.excludeGlobs ?? [], linkNodeModules: true })
runtime.base = copied.base
await this.#store.patch(runId, { baseHashes: copied.base, copyKind: 'directory' })
```

and in `#writeConflictBundles()` (~line 2081):

```js
const basePath = path.join(this.#orchestratorSource(run), entry.path)
```

6) Append the two fixer primitives near `markApplied`:

```js
/**
 * Run one short-lived fixer agent over a copy and wait for its turn to end.
 * @param {{ projectPath: string, copyPath: string, prompt: string, title?: string, model?: string | null, sandboxMode?: string | null, timeoutMs?: number }} input - fixer inputs.
 * @returns {Promise<{ message: string, agentId: string }>} the fixer report.
 */
async assist({ projectPath, copyPath, prompt, title = 'Artel fixer', model = null, sandboxMode = null, timeoutMs = 10 * 60 * 1000 }) {
  const agentId = `assist-${crypto.randomUUID().slice(0, 8)}`
  const handle = await this.#driver.createAgent({ name: 'Fixer', mode: 'solo', projectPath, copyPath, agentId, parentSessionId: null, model, sandboxMode })
  let text = ''
  let settled = false
  const listeners = new Set()
  const done = new Promise((resolve) => {
    listeners.add((event) => {
      if (event.kind === 'assistant' && typeof event.text === 'string') text += event.text
      if (event.kind === 'turn-end' && settled === false) { settled = true; resolve(null) }
    })
  })
  const unsubscribe = this.#driver.subscribe(handle, (event) => { for (const listener of listeners) listener(event) })
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (settled === false) { settled = true; resolve('timeout') } }, timeoutMs); timer.unref?.() })
  try {
    await this.#driver.prompt(handle, prompt)
    const outcome = await Promise.race([done, timeout])
    if (outcome === 'timeout') throw new ArtelError('The fixer agent did not finish in time.', 504, 'artel/assist-timeout')
    if (text.trim() === '') throw new ArtelError('The fixer agent finished without a report.', 500, 'artel/assist-empty')
    return { message: text.trim(), agentId }
  } finally {
    clearTimeout(timer)
    unsubscribe?.()
    await this.#driver.interrupt(handle).catch(() => {})
    await this.#driver.release().catch(() => {})
  }
}

/**
 * Ask a fixer to repair the assembled result of an Orchestrator run (a failed
 * check or a conflict), then refresh the run's change count.
 * @param {string} runId - run id.
 * @param {{ prompt: string, purpose?: 'check' | 'merge' }} input - fixer prompt.
 * @returns {Promise<{ agentId: string, changeCount: number }>} fixer id and refreshed count.
 */
async repairArtifact(runId, { prompt, purpose = 'check' }) {
  const run = this.#requireRun(runId)
  const runtime = this.#runtime(runId)
  if (run.mode !== 'orchestrator') throw new ArtelError('Only an Orchestrator run can be repaired in place.', 409, 'artel/bad-mode')
  if (run.status !== 'waiting' || run.merge?.stage !== 'assembled') throw new ArtelError('The run is not assembled, so there is nothing to repair.', 409, 'artel/bad-stage')
  if (runtime?.orch?.fixing === true) throw new ArtelError('A fixer is already working on the assembly.', 409, 'artel/fixer-busy')
  runtime.orch.fixing = true
  try {
    const title = purpose === 'check' ? 'Fix the failed check' : 'Fix the assembled result'
    const fixer = await this.#createOrchestratorAgent(runId, run, runtime, { role: 'fixer', copyPath: run.copyPath, sandboxMode: run.sandboxMode, title })
    await this.#send(runId, fixer, prompt)
    await this.#waitForTurnEnd(fixer.handle)
    const changes = await this.changes(runId)
    await this.#store.patch(runId, { changeCount: changes.length })
    await this.#feed(runId, { kind: 'status', text: `The fixer updated ${changes.length} file(s).` })
    return { agentId: fixer.record.id, changeCount: changes.length }
  } finally {
    runtime.orch.fixing = false
  }
}

/**
 * Wait for the next `turn-end` event of one agent handle.
 * @param {object} handle - driver handle.
 * @param {number} [timeoutMs] - limit.
 * @returns {Promise<void>} completes on turn end.
 */
#waitForTurnEnd(handle, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe?.(); reject(new ArtelError('The agent did not finish in time.', 504, 'artel/assist-timeout')) }, timeoutMs)
    timer.unref?.()
    const unsubscribe = this.#driver.subscribe(handle, (event) => {
      if (event.kind !== 'turn-end') return
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    })
  })
}
```

`#send(runId, rt, text)` already appends night-shift rules for `run.autoqueue === true`, so the fixer inherits them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/engine.test.js`
Expected: PASS — 3 new tests plus the previous ones.

- [ ] **Step 5: Commit**

```powershell
git add lib/engine.js test/engine.test.js
git commit -m "feat: seed the Orchestrator from a base version and add fixer primitives"
```

---

### Task 7: Queue model v2 — branch records and the Orchestrator mode

**Files:**
- Modify: `lib/queue.js`
- Test: Create `test/queue.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `QUEUE_MODES` includes `'orchestrator'`; `queueModeRefusal('orchestrator')` → null, only unknown modes are refused; `QUEUE_MODEL_BRANCHES = 'branches'`; `isBranchQueue(queue)`; `branchRefFor(branchId)` → `` `refs/heads/artel/${branchId}` ``; `createBranchRecord({ name, baseCommit, tipCommit = null, now })` → `{ id, name, ref, baseCommit, tipCommit, status: 'active', createdAt, updatedAt, appliedAt: null }`; `createQueueRecord` adds `model`, `project: null`, `currentBranchId: null`, `branches: []`; `createTaskRecord` adds `branchId: null, parentCommit: null, commit: null`; `queueSummary` exposes `model`, `project`, `currentBranchId`, `branches`, and each task's `branchId`/`commit`; `resultsCard` passed entries carry `branchId` and `commit`.

- [ ] **Step 1: Write the failing tests**

```js
// test/queue.test.js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/queue.test.js`
Expected: FAIL — missing exports.

- [ ] **Step 3: Write the minimal implementation**

Edit `lib/queue.js`:

1) `QUEUE_MODES` (~line 31):

```js
export const QUEUE_MODES = ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion']
```

2) The comment above it and `queueModeRefusal` (~line 89) — only unknown modes are refused:

```js
/**
 * Why the queue cannot run a mode; null when it can. The Orchestrator became a
 * queue mode in 0.11: a queued task starts from a saved branch commit and its
 * parts are seeded from that commit too.
 */
export function queueModeRefusal(mode) {
  if (isQueueMode(mode)) return null
  return { code: 'queue/mode-unknown', message: `Unknown auto-queue mode '${mode}': a task runs in ${QUEUE_MODES.join(', ')}.` }
}
```

3) After `QUEUE_MODES`, add the branch model constants and factory:

```js
/** Queues created from 0.11 on are git-backed branch queues. */
export const QUEUE_MODEL_BRANCHES = 'branches'

/** @param {object} queue - queue record. @returns {boolean} whether it is a branch queue. */
export function isBranchQueue(queue) {
  return queue?.model === QUEUE_MODEL_BRANCHES
}

/** @param {string} branchId - branch id. @returns {string} full ref name. */
export function branchRefFor(branchId) {
  return `refs/heads/artel/${branchId}`
}

/**
 * Create a branch record (the git ref is created separately by the branch
 * service, which owns the repository).
 * @param {{ name: string, baseCommit: string, tipCommit?: string | null, now?: number }} input - branch fields.
 * @returns {object} branch record.
 */
export function createBranchRecord({ name, baseCommit, tipCommit = null, now = Date.now() }) {
  const id = `b-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    name: String(name ?? '').trim() || `Ветка ${id.slice(2, 6)}`,
    ref: branchRefFor(id),
    baseCommit,
    tipCommit,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
  }
}
```

4) `createQueueRecord` (~line 110) — add to the returned object:

```js
model: QUEUE_MODEL_BRANCHES,
project: null,
currentBranchId: null,
branches: [],
```

5) `createTaskRecord` (~line 146) — add to the returned object:

```js
branchId: null,
parentCommit: null,
commit: null,
```

6) `queueSummary` (~line 350) — add to the returned object and the task mapping:

```js
model: queue.model ?? null,
project: queue.project ?? null,
currentBranchId: queue.currentBranchId ?? null,
branches: queue.branches ?? [],
// inside the tasks mapping:
branchId: task.branchId ?? null,
parentCommit: task.parentCommit ?? null,
commit: task.commit ?? null,
```

7) `resultsCard` (~line 314) — inside the `passed` mapping add:

```js
branchId: task.branchId ?? null,
commit: task.commit ?? null,
```

8) Add `createBranchRecord`, `isBranchQueue`, `branchRefFor`, `QUEUE_MODEL_BRANCHES` to the default export object (~line 581).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/queue.test.js` and then the whole suite `node --test test/*.test.js`
Expected: new file PASS; the legacy `queueModeRefusal` test in `test/routes.test.js` now fails and is fixed in Task 13.

- [ ] **Step 5: Commit**

```powershell
git add lib/queue.js test/queue.test.js
git commit -m "feat: branch queue model with the Orchestrator as a queue mode"
```

### Task 8: BranchService core — repository, branches, commits

**Files:**
- Create: `lib/branches.js`
- Test: `test/branches.test.js`

**Interfaces:**
- Consumes: `ArtelGit` and `ArtelGit.ensure({ stateDir, projectPath, exclude })` from `lib/git.js`; `QueueStore` (`get`, `patch`, `addTask`) from `lib/queue.js`; `QUEUE_MODEL_BRANCHES`, `createBranchRecord({ name, baseCommit, tipCommit = null, now })` from `lib/queue.js`.
- Produces: `class BranchError extends Error { message, status, code, details }`; `class BranchService` with `constructor({ store, stateDir, engine = null, exclude = [], now = () => Date.now(), log = console })`; `async ensure(sessionId)` → `ArtelGit`; `async list(sessionId)` → `{ queue, project: { head, repoDir, drift }, currentBranchId, branches }`; `async projectState(sessionId)` → `{ head, branchId, drift }`; `async createBranch(sessionId, { name = '', fromCommit = null, switchTo = true } = {})` → `{ branch, queue, project, currentBranchId, branches }`; `async renameBranch(sessionId, branchId, name)` → same list shape; `async switchBranch(sessionId, branchId)` → same list shape; `async removeBranch(sessionId, branchId)` → same list shape; `async commits(sessionId, branchId, { max = 200 } = {})` → `{ commit, parents, subject, date, files, changeCount }[]` newest first.

- [ ] **Step 1: Write the failing tests**

Create `test/branches.test.js`:

```js
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
    await fx.store.addTask('s1', { text: 'Work', mode: 'solo', branchId: busy.branch.id })
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/branches.test.js`
Expected: FAIL — `Cannot find module '../lib/branches.js'`.

- [ ] **Step 3: Implement `lib/branches.js`**

```js
import path from 'node:path'

import { ArtelGit } from './git.js'
import { QUEUE_MODEL_BRANCHES, createBranchRecord } from './queue.js'

const MAX_BRANCH_NAME = 80

export class BranchError extends Error {
  constructor(message, status, code, details = null) {
    super(message)
    this.name = 'BranchError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export class BranchService {
  #store
  #stateDir
  #engine
  #exclude
  #now
  #log

  constructor({ store, stateDir, engine = null, exclude = [], now = () => Date.now(), log = console }) {
    this.#store = store
    this.#stateDir = stateDir
    this.#engine = engine
    this.#exclude = Array.isArray(exclude) ? exclude : []
    this.#now = now
    this.#log = log
  }

  get engine() {
    return this.#engine
  }

  async ensure(sessionId) {
    const queue = await this.#requireQueue(sessionId)
    if (queue.project?.repoDir) {
      const opened = await ArtelGit.open({ stateDir: this.#stateDir, projectPath: queue.projectPath })
      if (opened !== null) return opened
    }

    const git = await ArtelGit.ensure({ stateDir: this.#stateDir, projectPath: queue.projectPath, exclude: this.#exclude })
    let head = await git.head()
    if (head === null) head = await git.importProject({ message: 'Import project' })
    const project = {
      repoDir: git.repoDir,
      head,
      importedAt: queue.project?.importedAt ?? this.#now(),
      applied: queue.project?.applied ?? null,
    }
    await this.#store.patch(sessionId, {
      model: QUEUE_MODEL_BRANCHES,
      project,
      currentBranchId: queue.currentBranchId ?? null,
      branches: Array.isArray(queue.branches) ? queue.branches : [],
    })
    return git
  }

  async list(sessionId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    return {
      queue,
      project: { head: queue.project?.head ?? null, repoDir: queue.project?.repoDir ?? null, drift: await this.#drift(git) },
      currentBranchId: queue.currentBranchId ?? null,
      branches: queue.branches ?? [],
    }
  }

  async projectState(sessionId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    return { head: queue.project?.head ?? null, branchId: queue.currentBranchId ?? null, drift: await this.#drift(git) }
  }

  async createBranch(sessionId, { name = '', fromCommit = null, switchTo = true } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const base = fromCommit ?? queue.project?.head ?? null
    if (base === null) throw new BranchError('The project has no imported commit yet.', 409, 'artel/no-base-commit')
    if ((await git.ref(base)) === null) throw new BranchError(`Unknown commit ${base}.`, 400, 'artel/bad-request', { commit: base })

    const branches = queue.branches ?? []
    const record = createBranchRecord({ name: this.#branchName(name, branches.length + 1), baseCommit: base, now: this.#now() })
    await git.updateRef(record.ref, base, null)

    const patch = { branches: [...branches, record] }
    if (switchTo === true) patch.currentBranchId = record.id
    await this.#store.patch(sessionId, patch)
    return { branch: record, ...(await this.list(sessionId)) }
  }

  async renameBranch(sessionId, branchId, name) {
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    const nextName = this.#branchName(name, 1)
    const branches = (queue.branches ?? []).map((entry) =>
      entry.id === branch.id ? { ...entry, name: nextName, updatedAt: this.#now() } : entry,
    )
    await this.#store.patch(sessionId, { branches })
    return this.list(sessionId)
  }

  async switchBranch(sessionId, branchId) {
    const queue = await this.#requireQueue(sessionId)
    this.#branch(queue, branchId)
    await this.#store.patch(sessionId, { currentBranchId: branchId })
    return this.list(sessionId)
  }

  async removeBranch(sessionId, branchId) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    if (queue.project?.applied?.branchId === branch.id) {
      throw new BranchError('This branch is already applied to the project.', 409, 'artel/branch-applied')
    }
    if (queue.project?.head === (branch.tipCommit ?? branch.baseCommit)) {
      throw new BranchError('This branch is already applied to the project.', 409, 'artel/branch-applied')
    }
    const busy = (queue.tasks ?? []).some(
      (task) => task.branchId === branch.id && (task.status === 'queued' || task.status === 'running'),
    )
    if (busy) throw new BranchError('The branch still has queued or running tasks.', 409, 'artel/branch-busy')

    await git.deleteRef(branch.ref)
    const branches = (queue.branches ?? []).filter((entry) => entry.id !== branch.id)
    const currentBranchId = queue.currentBranchId === branch.id ? (branches[0]?.id ?? null) : (queue.currentBranchId ?? null)
    await this.#store.patch(sessionId, { branches, currentBranchId })
    return this.list(sessionId)
  }

  async commits(sessionId, branchId, { max = 200 } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)
    const entries = await git.log(branch.ref, { max })
    const commits = []
    for (const entry of entries) {
      const parent = Array.isArray(entry.parents) && entry.parents.length > 0 ? entry.parents[0] : null
      const changes = parent === null ? [] : await git.changes(parent, entry.commit)
      commits.push({
        commit: entry.commit,
        parents: entry.parents ?? [],
        subject: entry.subject,
        date: entry.date,
        files: changes.map((change) => change.path),
        changeCount: changes.length,
      })
    }
    return commits
  }

  async #drift(git) {
    const entries = await git.status()
    return { dirty: entries.length > 0, files: entries.map((entry) => entry.path).slice(0, 40) }
  }

  async #requireQueue(sessionId) {
    const queue = await this.#store.get(sessionId)
    if (!queue) throw new BranchError(`No auto-queue for session ${sessionId}.`, 404, 'artel/queue-missing')
    if (!queue.projectPath) throw new BranchError('The auto-queue has no project path.', 409, 'artel/no-project')
    return queue
  }

  #branch(queue, branchId) {
    const branch = (queue.branches ?? []).find((entry) => entry.id === branchId)
    if (!branch) throw new BranchError(`No branch ${branchId}.`, 404, 'artel/branch-missing')
    return branch
  }

  #branchName(name, index) {
    const cleaned = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
    if (cleaned.length === 0) return `Ветка ${index}`
    if (cleaned.length > MAX_BRANCH_NAME) {
      throw new BranchError(`The branch name is longer than ${MAX_BRANCH_NAME} characters.`, 400, 'artel/bad-request')
    }
    return cleaned
  }
}
```

- [ ] **Step 4: Run the test again**

Run: `node --test test/branches.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the whole suite to prove nothing else broke**

Run: `node --test test/*.test.js`
Expected: PASS — the existing suite plus 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add lib/branches.js test/branches.test.js
git commit -m "feat: branch service core for the git-backed auto-queue"
```

Notes for the next task: `BranchService` gets its apply/merge methods in Tasks 9–10. `store.addTask` is `async addTask(sessionId, task)`; it fills in `createTaskRecord` defaults, so the test passes only `{ text, mode, branchId }`.

### Task 9: Apply pipeline — failing tests for fast-forward, merge, rebuild, drift and check

**Files:**
- Modify: `test/branches.test.js` (replace the `fixture()` helper, add a fake engine and commit helpers, add seven apply tests)
- Later in Task 10: Modify `lib/prompts.js`, `lib/branches.js`

**Interfaces:**
- Consumes: `BranchService` from Task 8; `ArtelGit.materialize/commitDir/updateRef/revList/mergeInto/mergeContinue/cherryPick/quitCherryPick/commitWorktree/changes/blob/worktreeAdd/worktreeRemove/pruneWorktrees/status/exec`.
- Produces (test contract for Task 10): `async apply(sessionId, { branchId, commitIds = null, confirmDrift = false, checkCommand = '', force = false } = {})` → `{ queue, applied: { branchId, branchName, commit, driftCommit, files, at }, check }`; `BranchError` codes `artel/branch-empty`, `artel/project-drift` (details.drift), `artel/apply-conflict` (details.conflicts), `artel/check-failed` (details.check); fake engine tracks `calls.markApplied`, `calls.refreshInstall`, `calls.assists`.

- [ ] **Step 1: Replace the fixture and append the apply tests**

In `test/branches.test.js`, replace the whole existing `async function fixture() { … }` with this version (the Task 8 tests keep working through the default argument), and append the helpers below it:

```js
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
  await fx.store.patch('s1', { project: { ...queue.project, head: commit } })
  return commit
}
```

Then append these seven tests at the end of the file:

```js
test('apply() fast-forwards a branch cut from the applied head', async () => {
  const fx = await fixture()
  try {
    const { branch } = await fx.service.createBranch('s1', { name: 'Fast' })
    const commit = await commitOnBranch(fx, branch, { file: 'src/app.js', content: 'export const answer = 2\n', subject: 'Answer 2' })
    const queue = await fx.store.get('s1')
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
    const checkCommand = 'node -e "process.exit(1)"'

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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/branches.test.js`
Expected: FAIL — the seven new tests fail with `TypeError: fx.service.apply is not a function`; the five Task 8 tests still pass.

### Task 10: BranchService apply — drift synthesis, check gate, rebuild and write-back

**Files:**
- Modify: `lib/prompts.js`
- Modify: `lib/branches.js`
- Test: `test/branches.test.js` (the tests written in Task 9 are the contract for this task)

**Interfaces:**
- Consumes: `BranchService`/`BranchError` from Task 8, `ArtelGit` from Tasks 1–4, the test contract from Task 9, the fake engine's `assist`.
- Produces: `BranchService.apply(sessionId, { branchId, commitIds = null, confirmDrift = false, checkCommand = '', force = false } = {})` → `{ queue, applied: { branchId, branchName, commit, driftCommit, files, at }, check }`; `runCheckCommand({ command, cwd, timeoutMs })` → `{ ok, output, skipped }`; `linkNodeModules(projectPath, workdir)`; helpers `#writeBack`, `#markAppliedRuns`, `#installNeeds`, `#fixConflicts`, `#conflictMarkers`; errors `artel/branch-empty`, `artel/project-drift` (`details.drift`), `artel/apply-conflict` (`details.conflicts`), `artel/check-failed` (`details.check`).

- [ ] **Step 1: Add the conflict and merge fixer prompts to `lib/prompts.js`**

Append at the end of `lib/prompts.js`:

```js
export function branchConflictPrompt({ branchName = '', commit = null, conflicts = [] } = {}) {
  const lines = []
  lines.push(
    commit === null
      ? `The auto-queue branch «${branchName}» is being applied to the project and the merge stopped on conflicts.`
      : `The auto-queue branch «${branchName}» is being rebuilt and commit ${commit} conflicts with the current project state.`,
  )
  lines.push('Resolve the conflict markers in these files so the result keeps both sides as one working change:')
  for (const file of conflicts) lines.push(`- ${file}`)
  lines.push('Edit the files in your working copy. Do not run git commands, do not commit, do not touch other files.')
  lines.push('When every file reads as one finished change with no conflict markers left, stop.')
  return lines.join('\n')
}

export function branchMergePrompt({ targetName = '', branchName = '', conflicts = [] } = {}) {
  const lines = []
  lines.push(`The auto-queue branch «${branchName}» is being merged into «${targetName || 'the current branch'}» and the merge stopped on conflicts.`)
  lines.push('Resolve the conflict markers in these files so the merge keeps both branches working as one change:')
  for (const file of conflicts) lines.push(`- ${file}`)
  lines.push('Edit the files in your working copy. Do not run git commands, do not commit, do not touch other files.')
  lines.push('When every file reads as one finished change with no conflict markers left, stop.')
  return lines.join('\n')
}
```

- [ ] **Step 2: Implement `BranchService.apply()` in `lib/branches.js`**

Change the file header to:

```js
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { ArtelGit } from './git.js'
import { branchConflictPrompt, branchMergePrompt } from './prompts.js'
import { QUEUE_MODEL_BRANCHES, createBranchRecord } from './queue.js'
```

Add above `export class BranchService`:

```js
const CHECK_TIMEOUT_MS = 15 * 60 * 1000

export async function runCheckCommand({ command, cwd, timeoutMs = CHECK_TIMEOUT_MS }) {
  const windows = process.platform === 'win32'
  const shell = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = windows ? ['/d', '/s', '/c', command] : ['-c', command]
  return await new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(shell, args, { cwd, windowsHide: true, env: process.env })
    const finish = (ok, note = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: (output + note).slice(-4000), skipped: false })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(false, `\n[artel] check timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(false, `\n[artel] ${error.message}`))
    child.on('close', (code) => finish(code === 0))
  })
}

export async function linkNodeModules(projectPath, workdir) {
  const source = path.join(projectPath, 'node_modules')
  const exists = await fsp.stat(source).catch(() => null)
  if (exists === null) return false
  const target = path.join(workdir, 'node_modules')
  const linked = await fsp.stat(target).catch(() => null)
  if (linked !== null) return true
  try {
    await fsp.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    return false
  }
}
```

Add these methods inside `BranchService` (after `commits()`):

```js
  async apply(sessionId, { branchId, commitIds = null, confirmDrift = false, checkCommand = '', force = false } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const branch = this.#branch(queue, branchId)

    const history = await git.revList({ from: branch.baseCommit, to: branch.tipCommit ?? branch.ref })
    if (history.length === 0) throw new BranchError('The branch has no commits to apply.', 409, 'artel/branch-empty')

    let selected = history
    if (Array.isArray(commitIds)) {
      const wanted = new Set(commitIds)
      const known = new Set(history)
      for (const commit of wanted) {
        if (!known.has(commit)) throw new BranchError(`Commit ${commit} is not part of branch ${branch.id}.`, 400, 'artel/bad-request', { commit })
      }
      selected = history.filter((commit) => wanted.has(commit))
      if (selected.length === 0) throw new BranchError('No commits were selected to apply.', 400, 'artel/bad-request')
    }
    const full = selected.length === history.length

    const head = queue.project?.head ?? null
    if (head === null) throw new BranchError('The project has no imported commit yet.', 409, 'artel/no-base-commit')

    let base = head
    let driftCommit = null
    const drift = await this.#drift(git)
    if (drift.dirty) {
      if (confirmDrift !== true) {
        throw new BranchError('The project has uncommitted changes. Confirm the drift to apply anyway.', 409, 'artel/project-drift', { drift })
      }
      driftCommit = await git.commitDir(queue.projectPath, { parent: head, message: 'Uncommitted project changes' })
      await git.updateRef('refs/heads/applied', driftCommit, head)
      base = driftCommit
    }

    const worktreeRoot = path.join(this.#stateDir, 'worktrees')
    const workdir = path.join(worktreeRoot, `apply-${branch.id}-${this.#now()}`)
    await fsp.mkdir(worktreeRoot, { recursive: true })
    let target = null
    let check = null
    try {
      if (full && branch.baseCommit === base) {
        target = branch.tipCommit ?? (await git.ref(branch.ref))
      } else {
        await git.worktreeAdd(workdir, base)
        if (full) {
          const merged = await git.mergeInto(workdir, { source: branch.tipCommit ?? branch.ref, message: `Apply «${branch.name}»` })
          if (merged.conflicts.length > 0) {
            const resolved = await this.#fixConflicts({ git, queue, branch, workdir, conflicts: merged.conflicts, commit: null })
            if (!resolved) throw new BranchError(`The branch «${branch.name}» conflicts with the project.`, 409, 'artel/apply-conflict', { conflicts: merged.conflicts })
            await git.addAll(workdir)
            target = (await git.mergeContinue(workdir, { message: `Apply «${branch.name}»` })) ?? (await git.commitWorktree(workdir, { message: `Apply «${branch.name}»` }))
          } else {
            target = merged.mergeCommit
          }
        } else {
          for (const commit of selected) {
            const picked = await git.cherryPick(workdir, commit)
            if (picked.conflicts.length === 0) continue
            const resolved = await this.#fixConflicts({ git, queue, branch, workdir, conflicts: picked.conflicts, commit })
            if (!resolved) {
              await git.quitCherryPick(workdir).catch(() => {})
              throw new BranchError(`Commit ${commit} conflicts with the project.`, 409, 'artel/apply-conflict', { conflicts: picked.conflicts, commit })
            }
            await git.addAll(workdir)
            await git.quitCherryPick(workdir).catch(() => {})
          }
          target = await git.commitWorktree(workdir, { message: `Apply ${selected.length} commit(s) from «${branch.name}»` })
        }
      }

      if (typeof checkCommand === 'string' && checkCommand.trim() !== '') {
        const stat = await fsp.stat(workdir).catch(() => null)
        if (stat === null) await git.worktreeAdd(workdir, target)
        await linkNodeModules(queue.projectPath, workdir)
        check = await runCheckCommand({ command: checkCommand.trim(), cwd: workdir })
        if (check.ok !== true && force !== true) {
          throw new BranchError('The check failed on the applied branch.', 409, 'artel/check-failed', { check })
        }
      }

      if (target === null) throw new BranchError('The apply produced no commit.', 500, 'artel/apply-empty')
      const changes = await git.changes(base, target)
      await this.#writeBack(queue.projectPath, git, target, changes)
      await git.updateRef('refs/heads/applied', target, base)
      await git.exec(['read-tree', 'HEAD'])

      const installNeeds = await this.#installNeeds(queue, selected)
      const applied = { branchId: branch.id, branchName: branch.name, commit: target, driftCommit, files: changes.length, at: this.#now() }
      const branches = (queue.branches ?? []).map((entry) =>
        entry.id === branch.id ? { ...entry, appliedAt: applied.at, updatedAt: applied.at, installNeeds } : entry,
      )
      const project = { ...queue.project, head: target, appliedAt: applied.at, applied }
      await this.#store.patch(sessionId, { project, branches })
      await this.#markAppliedRuns(queue, selected)
      return { queue: await this.#requireQueue(sessionId), applied, check }
    } finally {
      await git.worktreeRemove(workdir).catch(() => {})
      await git.pruneWorktrees().catch(() => {})
    }
  }
```

Add these private helpers inside `BranchService` (next to `#drift`):

```js
  async #writeBack(projectPath, git, target, changes) {
    for (const change of changes) {
      const full = path.join(projectPath, change.path)
      if (change.status === 'deleted') {
        await fsp.rm(full, { force: true })
        continue
      }
      const buffer = await git.blob(target, change.path)
      if (buffer === null) continue
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, buffer)
    }
  }

  async #markAppliedRuns(queue, selected) {
    if (!this.#engine || typeof this.#engine.markApplied !== 'function') return
    for (const task of queue.tasks ?? []) {
      if (!selected.includes(task.commit) || typeof task.runId !== 'string') continue
      try {
        await this.#engine.markApplied(task.runId)
      } catch (error) {
        this.#log?.warn?.(`artel: could not mark run ${task.runId} applied: ${error?.message ?? error}`)
      }
    }
  }

  async #installNeeds(queue, selected) {
    if (!this.#engine || typeof this.#engine.refreshInstall !== 'function') return null
    const tipTask = [...(queue.tasks ?? [])].reverse().find((task) => selected.includes(task.commit) && typeof task.runId === 'string')
    if (!tipTask) return null
    try {
      return (await this.#engine.refreshInstall(tipTask.runId)) ?? null
    } catch (error) {
      this.#log?.warn?.(`artel: could not refresh install needs: ${error?.message ?? error}`)
      return null
    }
  }

  async #fixConflicts({ git, queue, branch, workdir, conflicts, commit }) {
    if (!this.#engine || typeof this.#engine.assist !== 'function') return false
    const prompt = commit === null
      ? branchMergePrompt({ branchName: branch.name, conflicts })
      : branchConflictPrompt({ branchName: branch.name, commit, conflicts })
    try {
      await this.#engine.assist({
        projectPath: queue.projectPath,
        copyPath: workdir,
        title: commit === null ? `Merge «${branch.name}»` : `Rebuild «${branch.name}»`,
        prompt,
        sandboxMode: 'workspace-write',
      })
    } catch (error) {
      this.#log?.warn?.(`artel: conflict fixer failed: ${error?.message ?? error}`)
      return false
    }
    const markers = await this.#conflictMarkers(git, workdir)
    return markers.length === 0
  }

  async #conflictMarkers(git, workdir) {
    const result = await git.exec(['grep', '-l', '-E', '^(<<<<<<<|=======|>>>>>>>)', '--', '.'], { cwd: workdir, allowNonZero: true })
    const text = result.stdout.toString('utf8').trim()
    return text === '' ? [] : text.split(/\r?\n/)
  }
```

- [ ] **Step 3: Run the branch tests**

Run: `node --test test/branches.test.js`
Expected: PASS — 12 tests (5 from Task 8, 7 from Task 9).

- [ ] **Step 4: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — the existing suite plus 12 branch tests. If a Windows check-command test flakes, rerun once; the command `node -e "process.exit(1)"` must exit non-zero through `cmd.exe`.

- [ ] **Step 5: Commit**

```bash
git add lib/branches.js lib/prompts.js test/branches.test.js
git commit -m "feat: apply a queue branch to the project with drift and check gates"
```

### Task 11: BranchService merge — branch-to-branch merges with the fixer

**Files:**
- Modify: `lib/branches.js`
- Modify: `test/branches.test.js`

**Interfaces:**
- Consumes: `ArtelGit.ref/mergeInto/addAll/mergeContinue/commitWorktree/materialize/updateRef/worktreeAdd/worktreeRemove/pruneWorktrees/log`, `#fixConflicts`, `#requireQueue`, `#branch`.
- Produces: `async merge(sessionId, { targetBranchId, sourceBranchId, checkCommand = '', force = false } = {})` → `{ queue, mergeCommit, check }`; the target ref moves to the merge commit, the source branch is left untouched, the project work tree is not modified; errors `artel/bad-request`, `artel/branch-empty`, `artel/merge-conflict` (details.conflicts/sourceBranchId/targetBranchId), `artel/check-failed`.

- [ ] **Step 1: Append the failing merge tests**

Append to `test/branches.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/branches.test.js`
Expected: FAIL — the two new tests fail with `TypeError: fx.service.merge is not a function`.

- [ ] **Step 3: Implement `BranchService.merge()`**

Add inside `BranchService` (after `apply()`):

```js
  async merge(sessionId, { targetBranchId, sourceBranchId, checkCommand = '', force = false } = {}) {
    const git = await this.ensure(sessionId)
    const queue = await this.#requireQueue(sessionId)
    const target = this.#branch(queue, targetBranchId)
    const source = this.#branch(queue, sourceBranchId)
    if (target.id === source.id) throw new BranchError('A branch cannot be merged into itself.', 400, 'artel/bad-request')

    const targetTip = await git.ref(target.ref)
    const sourceTip = await git.ref(source.ref)
    if (targetTip === null) throw new BranchError(`Branch «${target.name}» has no base commit.`, 409, 'artel/no-base-commit')
    if (sourceTip === null || sourceTip === source.baseCommit) {
      throw new BranchError(`Branch «${source.name}» has no commits to merge.`, 409, 'artel/branch-empty')
    }

    const worktreeRoot = path.join(this.#stateDir, 'worktrees')
    const workdir = path.join(worktreeRoot, `merge-${target.id}-${this.#now()}`)
    await fsp.mkdir(worktreeRoot, { recursive: true })
    let check = null
    try {
      await git.worktreeAdd(workdir, targetTip)
      const merged = await git.mergeInto(workdir, { source: sourceTip, message: `Merge «${source.name}» into «${target.name}»` })
      let mergeCommit = merged.mergeCommit
      if (merged.conflicts.length > 0) {
        const resolved = await this.#fixConflicts({ git, queue, branch: source, workdir, conflicts: merged.conflicts, commit: null })
        if (!resolved) {
          throw new BranchError(`«${source.name}» conflicts with «${target.name}».`, 409, 'artel/merge-conflict', {
            conflicts: merged.conflicts,
            sourceBranchId: source.id,
            targetBranchId: target.id,
          })
        }
        await git.addAll(workdir)
        mergeCommit =
          (await git.mergeContinue(workdir, { message: `Merge «${source.name}» into «${target.name}»` })) ??
          (await git.commitWorktree(workdir, { message: `Merge «${source.name}» into «${target.name}»` }))
      }
      if (typeof checkCommand === 'string' && checkCommand.trim() !== '') {
        await linkNodeModules(queue.projectPath, workdir)
        check = await runCheckCommand({ command: checkCommand.trim(), cwd: workdir })
        if (check.ok !== true && force !== true) {
          throw new BranchError('The check failed on the merged branch.', 409, 'artel/check-failed', { check })
        }
      }

      await git.updateRef(target.ref, mergeCommit, targetTip)
      const branches = (queue.branches ?? []).map((entry) =>
        entry.id === target.id ? { ...entry, tipCommit: mergeCommit, updatedAt: this.#now() } : entry,
      )
      await this.#store.patch(sessionId, { branches })
      return { queue: await this.#requireQueue(sessionId), mergeCommit, check }
    } finally {
      await git.worktreeRemove(workdir).catch(() => {})
      await git.pruneWorktrees().catch(() => {})
    }
  }
```

- [ ] **Step 4: Run the branch tests**

Run: `node --test test/branches.test.js`
Expected: PASS — 14 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — the existing suite plus 14 branch tests.

- [ ] **Step 6: Commit**

```bash
git add lib/branches.js test/branches.test.js
git commit -m "feat: merge queue branches with the conflict fixer"
```

### Task 12: QueueRunner branch lifecycle — seed from the tip, commit on pass

**Files:**
- Modify: `lib/queue-runner.js`
- Create: `test/queue-branches.test.js`

**Interfaces:**
- Consumes: `BranchService` from `lib/branches.js`; `isBranchQueue`, `QUEUE_MODEL_BRANCHES` from `lib/queue.js`; the existing `#store`, `#engine`, `#stateDir`, `#now`, `#event`, `#parkTask`, `#active`.
- Produces: `QueueRunner` gains a private `#branches = new BranchService({ store, stateDir, engine, exclude, now, log })`; `async ensureBranches(sessionId)` → `{ queue, git }`; `addTasks()` sets `task.branchId` (auto-creates the current branch from the first task title); `#startBranchTask()` materialises the branch tip and starts the engine with `{ basePath: seed, isolateFromBase: true, branchId, parentCommit }`; `#commitTaskRun()` writes a commit and records `task.commit`/`branch.tipCommit`/`engine.markCommitted`; stalled legacy queues keep the old path, and an orchestrator task in a legacy queue parks with an explicit reason.

- [ ] **Step 1: Write the failing branch-queue tests**

Create `test/queue-branches.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { QueueRunner } from '../lib/queue-runner.js'
import { QueueStore } from '../lib/queue.js'

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the queue')
}

async function fixture({ empty = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-queue-branches-'))
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()

  let count = 0
  const engine = {
    projectPath,
    copyRoot,
    starts: [],
    marked: [],
    changes: new Map(),
    runs: new Map(),
    async start(request) {
      count += 1
      const id = `run-${count}`
      const copyPath = path.join(copyRoot, id)
      await fs.cp(request.basePath ?? projectPath, copyPath, { recursive: true })
      if (empty !== true) {
        const file = path.join(copyPath, 'src', 'app.js')
        const existing = await fs.readFile(file, 'utf8')
        await fs.writeFile(file, existing.replace(/answer = \d+/, `answer = ${count + 1}`))
      }
      const run = {
        id,
        sessionId: request.sessionId,
        mode: request.mode,
        task: request.task,
        projectPath: request.projectPath,
        copyPath,
        basePath: request.basePath,
        isolate: request.isolateFromBase === true,
        status: 'running',
        changeCount: empty === true ? 0 : 1,
        autoqueue: true,
      }
      engine.runs.set(id, run)
      engine.starts.push(request)
      engine.changes.set(id, empty === true ? [] : [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1 }])
      return run
    },
    getRun(runId) {
      const run = engine.runs.get(runId)
      if (!run) throw new Error('run lost')
      return run
    },
    listRuns() {
      return [...engine.runs.values()]
    },
    async changes(runId) {
      return engine.changes.get(runId) ?? []
    },
    readFeed() {
      return { events: [], cursor: 0 }
    },
    async message() {},
    async markCommitted(runId, info) {
      engine.marked.push({ runId, ...info })
      const run = engine.runs.get(runId)
      if (run) {
        run.commit = info.commit
        run.status = 'waiting'
      }
    },
  }

  const runner = new QueueRunner({ engine, store, stateDir, copyRoot, log: { warn() {} } })
  await runner.init()
  await store.ensure('s1', { projectPath })
  await runner.ensureBranches('s1')
  await runner.setAutopilot({ sessionId: 's1', projectPath, autopilot: true, decisions: true, checkDisabled: true })
  return { root, stateDir, projectPath, store, runner, engine, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('the first branch task starts from the applied commit and becomes a commit', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    const queued = await fx.store.get('s1')
    assert.equal(queued.branches.length, 1)
    assert.equal(queued.currentBranchId, queued.branches[0].id)
    assert.equal(queued.tasks[0].branchId, queued.branches[0].id)

    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'passed')

    const queue = await fx.store.get('s1')
    const task = queue.tasks[0]
    const branch = queue.branches[0]
    assert.match(task.commit, /^[0-9a-f]{40}$/)
    assert.equal(branch.tipCommit, task.commit)
    assert.equal(fx.engine.starts[0].isolateFromBase, true)
    assert.notEqual(fx.engine.starts[0].basePath, fx.projectPath)
    assert.equal(fx.engine.starts[0].branchId, branch.id)
    assert.equal(fx.engine.starts[0].parentCommit, branch.baseCommit)
    assert.equal(fx.engine.marked.length, 1)
    assert.equal(fx.engine.marked[0].parentCommit, branch.baseCommit)
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')

    const { git } = await fx.runner.ensureBranches('s1')
    const [entry] = await git.log(branch.ref, { max: 1 })
    assert.equal(entry.subject, 'Answer two')
  } finally {
    await fx.cleanup()
  }
})

test('the next task starts from the branch tip and commits on top of the previous one', async () => {
  const fx = await fixture()
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer two'], mode: 'solo' })
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'passed')
    const first = (await fx.store.get('s1')).tasks[0]

    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Answer three'], mode: 'solo' })
    await waitFor(async () => (await fx.store.get('s1')).tasks[1].status === 'passed')

    const queue = await fx.store.get('s1')
    const second = queue.tasks[1]
    assert.match(second.commit, /^[0-9a-f]{40}$/)
    assert.equal(fx.engine.starts[1].parentCommit, first.commit)
    assert.equal(fx.engine.starts[1].branchId, first.branchId)
    assert.equal(fx.engine.marked[1].parentCommit, first.commit)

    const { git } = await fx.runner.ensureBranches('s1')
    const [entry] = await git.log(second.commit, { max: 1 })
    assert.deepEqual(entry.parents, [first.commit])
    assert.equal(queue.branches[0].tipCommit, second.commit)
  } finally {
    await fx.cleanup()
  }
})

test('a branch task that changed nothing is parked and never committed', async () => {
  const fx = await fixture({ empty: true })
  try {
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Do nothing'], mode: 'solo' })
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'parked')

    const queue = await fx.store.get('s1')
    assert.equal(queue.tasks[0].commit, null)
    assert.equal(queue.branches[0].tipCommit, null)
    assert.equal(fx.engine.marked.length, 0)
    assert.match(queue.tasks[0].reason, /ничего не изменил/i)
  } finally {
    await fx.cleanup()
  }
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/queue-branches.test.js`
Expected: FAIL — `runner.ensureBranches is not a function`.

- [ ] **Step 3: Add the branch plumbing to `lib/queue-runner.js`**

Change the imports:

```js
import fs from 'node:fs/promises'
import path from 'node:path'
import { BranchService } from './branches.js'
import * as checkModule from './check.js'
import { autoAnswerPrompt, checkRepairPrompt } from './prompts.js'
import {
  QUEUE_TUNING,
  classifyFailure,
  createTaskRecord,
  endsWithQuestion,
  isBranchQueue,
  nextQueuedTask,
  parkedBranch,
  queueSummary,
  resultsCard,
  stopReasonLabel,
  taskTitle,
} from './queue.js'
```

Add the field next to the other class fields:

```js
  #tuning
  #branches
  #pumps = new Map()
```

In the constructor, after `this.#tuning = …` add:

```js
    this.#branches = new BranchService({
      store,
      stateDir,
      engine,
      exclude: Array.isArray(engine?.config?.excludeGlobs) ? engine.config.excludeGlobs : [],
      now,
      log,
    })
```

Add a public helper after `init()` (Task 13 uses it for routing):

```js
  /**
   * Open the git repository of a session queue and make sure the queue record
   * carries the branch model fields.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ queue: object, git: object }>} queue record and repository.
   */
  async ensureBranches(sessionId) {
    await this.#store.ensure(sessionId)
    const git = await this.#branches.ensure(sessionId)
    return { queue: this.#store.get(sessionId), git }
  }
```

In `init()`, right after `for (const queue of this.#store.list()) {` add:

```js
      if (isBranchQueue(queue)) {
        try {
          await this.#branches.ensure(queue.sessionId)
        } catch (error) {
          this.#log?.warn?.(`artel: cannot open the queue repository for ${queue.sessionId}: ${error?.message ?? error}`)
        }
      }
```

In `addTasks()`, replace this block:

```js
    const now = this.#now()
    const created = list.map((text) => {
      const record = createTaskRecord({ text, mode, model, now })
      if (typeof basePath === 'string' && basePath !== '') record.basePath = basePath
      return record
    })
```

with:

```js
    const now = this.#now()
    const created = list.map((text) => createTaskRecord({ text, mode, model, now }))
    if (isBranchQueue(queue)) {
      await this.#branches.ensure(sessionId)
      const branch =
        this.#currentBranch(sessionId) ??
        (await this.#branches.createBranch(sessionId, { name: created[0].title, switchTo: true })).branch
      for (const record of created) record.branchId = branch.id
    } else {
      for (const record of created) {
        if (typeof basePath === 'string' && basePath !== '') record.basePath = basePath
      }
    }
```

In `retryTask()`, after the existing `await this.#event(...)` line, add:

```js
    const retried = this.#store.get(sessionId)
    if (isBranchQueue(retried)) {
      const branch = (retried.branches ?? []).find((entry) => entry.id === task.branchId) ?? null
      if (branch !== null) {
        await this.#store.updateTask(sessionId, taskId, { parentCommit: branch.tipCommit ?? branch.baseCommit })
      }
    }
```

In `#startTask()`, replace the top:

```js
  async #startTask(sessionId, task) {
    const queue = this.#store.get(sessionId)
    const startedAt = this.#now()
    // A retried task continues from its own parked copy; every other task starts
    // from the last successful version.
    let basePath = task.basePath ?? queue.lastVersion?.path ?? null
```

with:

```js
  async #startTask(sessionId, task) {
    const queue = this.#store.get(sessionId)
    const startedAt = this.#now()
    if (isBranchQueue(queue)) {
      await this.#startBranchTask(sessionId, task, queue, startedAt)
      return
    }
    if (task.mode === 'orchestrator') {
      await this.#parkTask(sessionId, task.id, 'Оркестратор в автоочереди работает только с ветками: обновите очередь до новой модели.', { interrupt: false })
      return
    }
    // A retried task continues from its own parked copy; every other task starts
    // from the last successful version.
    let basePath = task.basePath ?? queue.lastVersion?.path ?? null
```

Add these private methods after `#startTask()`:

```js
  /**
   * Start a task from the tip of its queue branch: materialise the tip as a
   * plain directory, hand it to the engine as an isolated base and remove the
   * materialisation once the engine has copied it.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @param {object} queue - queue record.
   * @param {number} startedAt - start timestamp.
   * @returns {Promise<void>} resolves when the run is live or the task is parked.
   */
  async #startBranchTask(sessionId, task, queue, startedAt) {
    let git = null
    let branch = null
    try {
      git = await this.#branches.ensure(sessionId)
      branch = this.#branchForTask(sessionId, task)
    } catch (error) {
      await this.#parkTask(sessionId, task.id, `Не удалось открыть ветку задачи: ${error?.message ?? error}`, { interrupt: false })
      return
    }
    const tip = branch.tipCommit ?? branch.baseCommit
    const seed = path.join(this.#stateDir, 'worktrees', `seed-${task.id}-${this.#now()}`)
    await fs.mkdir(path.dirname(seed), { recursive: true })
    try {
      await git.materialize(seed, tip)
    } catch (error) {
      await this.#parkTask(sessionId, task.id, `Не удалось подготовить ветку: ${error?.message ?? error}`, { interrupt: false })
      return
    }
    let run = null
    try {
      run = await this.#engine.start({
        sessionId,
        projectPath: queue.projectPath,
        mode: task.mode,
        task: task.text,
        model: task.model,
        basePath: seed,
        isolateFromBase: true,
        branchId: branch.id,
        parentCommit: tip,
        autoqueue: true,
      })
    } catch (error) {
      if (error?.code === 'artel/busy') return
      await this.#parkTask(sessionId, task.id, `Не удалось начать задачу: ${error?.message ?? error}`, { interrupt: false })
      return
    } finally {
      await fs.rm(seed, { recursive: true, force: true })
    }
    if (run === null) return
    await this.#store.updateTask(sessionId, task.id, {
      status: 'running',
      runId: run.id,
      basePath: null,
      branchId: branch.id,
      parentCommit: tip,
      startedAt,
      reason: null,
    })
    const fresh = this.#store.get(sessionId)
    fresh.stats.taken += 1
    fresh.stats.startedAt = fresh.stats.startedAt ?? startedAt
    await this.#store.replace(sessionId, fresh)
    this.#active.set(sessionId, {
      taskId: task.id,
      runId: run.id,
      cursor: 0,
      phase: 'run',
      fixes: task.fixes ?? 0,
      startedAt,
      errorText: '',
      lastText: '',
    })
    await this.#event(sessionId, { kind: 'started', text: `Работа: ${task.title}`, taskId: task.id })
  }

  /**
   * The branch a task belongs to.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @returns {object} branch record.
   */
  #branchForTask(sessionId, task) {
    const queue = this.#store.get(sessionId)
    const branch = (queue?.branches ?? []).find((entry) => entry.id === task.branchId) ?? null
    if (branch === null) throw new Error(`Ветка задачи ${task.id} не найдена`)
    return branch
  }

  /**
   * The branch new tasks are added to.
   * @param {string} sessionId - chat session id.
   * @returns {object | null} branch record or null.
   */
  #currentBranch(sessionId) {
    const queue = this.#store.get(sessionId)
    if (queue === null) return null
    return (queue.branches ?? []).find((entry) => entry.id === queue.currentBranchId) ?? null
  }

  /**
   * Commit the copy of a passed run into its queue branch.
   * @param {string} sessionId - chat session id.
   * @param {object} task - queue task.
   * @param {object} run - run summary.
   * @param {object[]} changes - run changes.
   * @returns {Promise<string>} the new commit sha.
   */
  async #commitTaskRun(sessionId, task, run, changes) {
    const git = await this.#branches.ensure(sessionId)
    const queue = this.#store.get(sessionId)
    const branch = this.#branchForTask(sessionId, task)
    const parent = task.parentCommit ?? branch.tipCommit ?? branch.baseCommit
    const commit = await git.commitDir(run.copyPath, { parent, message: task.title })
    await git.updateRef(branch.ref, commit, parent)
    const files = (changes ?? []).map((change) => change.path).slice(0, 40)
    if (typeof this.#engine.markCommitted === 'function') {
      await this.#engine.markCommitted(run.id, {
        branchId: branch.id,
        parentCommit: parent,
        commit,
        files,
        changeCount: run?.changeCount ?? files.length,
      })
    }
    const fresh = this.#store.get(sessionId)
    fresh.branches = (fresh.branches ?? []).map((entry) =>
      entry.id === branch.id ? { ...entry, tipCommit: commit, updatedAt: this.#now() } : entry,
    )
    await this.#store.replace(sessionId, fresh)
    await git.pruneWorktrees().catch(() => {})
    return commit
  }
```

In `#finishTask()`, replace the block from `const changeCount = …` through the `if (accepted === true) { … } else { … }` block and the `await this.#store.replace(sessionId, queue)` line with:

```js
    const changeCount = run?.changeCount ?? changes.length
    let files = (changes ?? []).map((change) => change.path).slice(0, 40)
    const finishedAt = this.#now()
    const branchQueue = isBranchQueue(queue)
    let commit = null
    if (accepted !== true && branchQueue) {
      try {
        commit = await this.#commitTaskRun(sessionId, task, run, changes)
      } catch (error) {
        await this.#parkTask(sessionId, active.taskId, `Не удалось сохранить задачу в ветку: ${error?.message ?? error}`)
        return
      }
    }
    const current = this.#store.get(sessionId)
    if (accepted === true) {
      // Applied by the user: the project itself is now the base for what comes
      // next, so the queue must not seed the next task from an older copy.
      current.lastVersion = null
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
    } else if (branchQueue) {
      // The change already lives in its own commit; there is no copy to keep.
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
      current.results = null
      current.stopReason = null
    } else {
      current.lastVersion = { runId: run.id, path: run.copyPath, title: task.title, changeCount, at: finishedAt }
      current.stats.passed += 1
      current.stats.consecutiveParks = 0
      current.results = null
      current.stopReason = null
    }
    await this.#store.replace(sessionId, current)
```

Then in the same method replace the `updateTask` payload and the passed event text:

```js
    await this.#store.updateTask(sessionId, task.id, {
      status: 'passed',
      changeCount,
      files,
      check: check ?? task.check ?? null,
      finishedAt,
      reason: accepted ? reason : null,
      ...(commit === null ? {} : { commit }),
    })
    const fresh = this.#store.get(sessionId)
    this.#active.delete(sessionId)
    await this.#event(sessionId, {
      kind: 'passed',
      text: `Версия готова: ${task.title} · ${changeCount} файл(ов)${commit === null ? '' : ` · ${commit.slice(0, 7)}`}${check?.skipped ? ' · проверка отключена' : ''}`,
      taskId: task.id,
    })
```

- [ ] **Step 4: Run the branch-queue tests**

Run: `node --test test/queue-branches.test.js`
Expected: PASS — 3 tests. The autopilot pump polls every 700 ms, so each test takes a few seconds.

- [ ] **Step 5: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — the existing queue-runner tests (legacy queues without `model: 'branches'` keep the old path) plus the 3 new branch tests.

- [ ] **Step 6: Commit**

```bash
git add lib/queue-runner.js test/queue-branches.test.js
git commit -m "feat: run queue tasks from branch tips and commit their changes"
```

### Task 13: Migration, the Orchestrator check fixer, branch API and plugin wiring

**Files:**
- Modify: `lib/queue-runner.js`
- Modify: `lib/index.js`
- Create: `test/queue-migration.test.js`

**Interfaces:**
- Consumes: `BranchService`, `isBranchQueue`, `QUEUE_MODEL_BRANCHES`, `createBranchRecord`; `engine.listRuns()`, `engine.repairArtifact()` (Task 6), `ArtelGit.open()`.
- Produces: `QueueRunner` branch API `branchesSummary(sessionId)` → `BranchService.list()` shape; `createBranch(sessionId, { name })`; `renameBranch(sessionId, branchId, name)`; `switchBranch(sessionId, branchId)`; `removeBranch(sessionId, branchId)`; `branchCommits(sessionId, branchId)`; `applyBranch(sessionId, input)` → `BranchService.apply()` shape; `mergeBranches(sessionId, input)` → `BranchService.merge()` shape; `projectState(sessionId)` → `{ head, branchId, drift }`; a legacy queue is upgraded to the branch model on the first queue interaction when it has no pending saved versions, otherwise it keeps the old path and `ensureBranches()` throws 409 `artel/legacy-queue`; an Orchestrator run whose check fails is repaired with `engine.repairArtifact()`; the plugin wires `engine.setGitResolver()`.

- [ ] **Step 1: Write the failing migration and fixer tests**

Create `test/queue-migration.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { QueueRunner } from '../lib/queue-runner.js'
import { QueueStore } from '../lib/queue.js'

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the queue')
}

async function makeProject(root) {
  const projectPath = path.join(root, 'project')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  return projectPath
}

async function fixture({ runs = [], checkCommand = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artel-queue-migration-'))
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  const projectPath = await makeProject(root)

  const engine = {
    projectPath,
    copyRoot,
    starts: [],
    repairs: [],
    messages: [],
    runs: new Map(),
    async listRuns() {
      return runs
    },
    async start(request) {
      const id = `run-${engine.starts.length + 1}`
      const copyPath = path.join(copyRoot, id)
      await fs.cp(request.basePath ?? projectPath, copyPath, { recursive: true })
      const run = {
        id,
        sessionId: request.sessionId,
        mode: request.mode,
        task: request.task,
        projectPath: request.projectPath,
        copyPath,
        basePath: request.basePath,
        status: 'running',
        changeCount: 1,
        autoqueue: true,
      }
      engine.runs.set(id, run)
      engine.starts.push(request)
      engine.changes = async () => [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1 }]
      return run
    },
    getRun(runId) {
      const run = engine.runs.get(runId)
      if (!run) throw new Error('run lost')
      return run
    },
    readFeed() {
      return { events: [], cursor: 0 }
    },
    async message(runId, input) {
      engine.messages.push({ runId, input })
    },
    async repairArtifact(runId, input) {
      engine.repairs.push({ runId, input })
      const run = engine.runs.get(runId)
      if (run) run.status = 'waiting'
    },
    async markCommitted() {},
  }

  const store = new QueueStore({ dir: path.join(stateDir, 'queue') })
  await store.init()
  await store.ensure('s1', { projectPath })
  if (checkCommand !== '') await store.patch('s1', { checkCommand })
  const runner = new QueueRunner({ engine, store, stateDir, copyRoot, log: { warn() {} } })
  await runner.init()
  return { root, stateDir, copyRoot, projectPath, store, runner, engine, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('a legacy queue with a saved version becomes a branch with one imported commit', async () => {
  const fx = await fixture()
  try {
    const versionDir = path.join(fx.root, 'saved-version')
    await fs.cp(fx.projectPath, versionDir, { recursive: true })
    await fs.writeFile(path.join(versionDir, 'src', 'app.js'), 'export const answer = 2\n')
    await fx.store.patch('s1', {
      lastVersion: { runId: 'old-run', path: versionDir, title: 'Старая версия', changeCount: 1, at: Date.now() },
    })

    const { queue, git } = await fx.runner.ensureBranches('s1')

    assert.equal(queue.model, 'branches')
    assert.equal(queue.lastVersion, null)
    assert.equal(queue.branches.length, 1)
    const branch = queue.branches[0]
    assert.match(branch.tipCommit, /^[0-9a-f]{40}$/)
    assert.equal(branch.baseCommit, queue.project.head)
    assert.equal(queue.currentBranchId, branch.id)

    const [entry] = await git.log(branch.ref, { max: 1 })
    assert.equal(entry.subject, 'Импортированная версия 0.10: Старая версия')
    const changes = await git.changes(branch.baseCommit, branch.tipCommit)
    assert.deepEqual(changes.map((change) => change.path), ['src/app.js'])
    assert.equal(await fs.readFile(path.join(fx.projectPath, 'src', 'app.js'), 'utf8'), 'export const answer = 1\n')
  } finally {
    await fx.cleanup()
  }
})

test('a legacy queue with unsaved versions keeps the old model', async () => {
  const fx = await fixture({ runs: [{ id: 'run-9', status: 'waiting', changeCount: 2 }] })
  try {
    await assert.rejects(fx.runner.ensureBranches('s1'), (error) => error.code === 'artel/legacy-queue')

    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Keep going'], mode: 'solo' })
    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'running')

    const queue = await fx.store.get('s1')
    assert.equal(queue.model, undefined)
    assert.equal(queue.branches, undefined)
    assert.equal(fx.engine.starts[0].isolateFromBase, undefined)
    assert.equal(fx.engine.starts[0].basePath, null)
  } finally {
    await fx.cleanup()
  }
})

test('a failed Orchestrator check is repaired on the assembled copy and then parked', async () => {
  const fx = await fixture({ checkCommand: 'node -e "process.exit(1)"' })
  try {
    await fx.runner.ensureBranches('s1')
    await fx.runner.setAutopilot({ sessionId: 's1', projectPath: fx.projectPath, autopilot: true, decisions: true, checkDisabled: false })
    await fx.runner.addTasks({ sessionId: 's1', projectPath: fx.projectPath, texts: ['Собери отчёт'], mode: 'orchestrator' })

    await waitFor(async () => (await fx.store.get('s1')).tasks[0].status === 'parked', 20000)

    const queue = await fx.store.get('s1')
    assert.match(queue.tasks[0].reason, /Проверка не прошла/i)
    assert.equal(fx.engine.repairs.length, 2)
    assert.equal(fx.engine.repairs[0].runId, 'run-1')
    assert.match(fx.engine.repairs[0].input.prompt, /process\.exit\(1\)/)
    assert.equal(fx.engine.messages.length, 0)
    assert.equal(queue.branches[0].tipCommit, null)
  } finally {
    await fx.cleanup()
  }
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/queue-migration.test.js`
Expected: FAIL — `ensureBranches` does not upgrade legacy queues and never rejects with `artel/legacy-queue`; `repairArtifact` is never called.

- [ ] **Step 3: Implement the migration and the fixer in `lib/queue-runner.js`**

Extend the queue.js import from Task 12 with `createBranchRecord`:

```js
import {
  QUEUE_TUNING,
  classifyFailure,
  createBranchRecord,
  createTaskRecord,
  endsWithQuestion,
  isBranchQueue,
  nextQueuedTask,
  parkedBranch,
  queueSummary,
  resultsCard,
  stopReasonLabel,
  taskTitle,
} from './queue.js'
```

Replace the `init()` repository block added in Task 12 with a migration-aware version:

```js
      if (isBranchQueue(queue)) {
        try {
          await this.#branches.ensure(queue.sessionId)
        } catch (error) {
          this.#log?.warn?.(`artel: cannot open the queue repository for ${queue.sessionId}: ${error?.message ?? error}`)
        }
      } else {
        try {
          await this.#maybeUpgrade(queue.sessionId)
        } catch (error) {
          this.#log?.warn?.(`artel: cannot migrate the queue for ${queue.sessionId}: ${error?.message ?? error}`)
        }
      }
```

Replace `ensureBranches()` from Task 12 with:

```js
  /**
   * Open the git repository of a session queue, upgrading a legacy queue first
   * when its saved versions have all been reviewed.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<{ queue: object, git: object }>} queue record and repository.
   */
  async ensureBranches(sessionId) {
    await this.#store.ensure(sessionId)
    const upgraded = await this.#maybeUpgrade(sessionId)
    if (upgraded !== true && !isBranchQueue(this.#store.get(sessionId))) {
      const error = new Error('The auto-queue still runs on the old model until its saved versions are reviewed.')
      error.status = 409
      error.code = 'artel/legacy-queue'
      throw error
    }
    const git = await this.#branches.ensure(sessionId)
    return { queue: this.#store.get(sessionId), git }
  }

  /**
   * A legacy queue may switch to the branch model only when no saved run is
   * waiting for review — otherwise the 0.10 results card is still in charge.
   * @param {string} queue - queue record.
   * @returns {Promise<boolean>} true when the queue may be upgraded.
   */
  async #canUpgrade(queue) {
    if (isBranchQueue(queue)) return false
    if (queue.lastVersion?.path) return true
    const runs = await this.#engine.listRuns(queue.sessionId)
    return !(runs ?? []).some(
      (run) => run.status !== 'applied' && run.status !== 'discarded' && (run.changeCount ?? 0) > 0,
    )
  }

  /**
   * Upgrade a legacy queue in place: import the project, turn the saved 0.10
   * version into a branch commit and drop the single-version pointer.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<boolean>} true when the queue ended up on the branch model.
   */
  async #maybeUpgrade(sessionId) {
    const queue = this.#store.get(sessionId)
    if (queue === null) return false
    if (isBranchQueue(queue)) return true
    if ((await this.#canUpgrade(queue)) !== true) return false

    const legacy = queue.lastVersion
    const git = await this.#branches.ensure(sessionId)
    const fresh = this.#store.get(sessionId)
    if (legacy?.path) {
      const base = fresh.project?.head ?? (await git.head())
      const message = `Импортированная версия 0.10: ${legacy.title ?? 'версия'}`
      const commit = await git.commitDir(legacy.path, { parent: base, message })
      const name = (legacy.title ?? 'Версия 0.10').trim().slice(0, 80)
      const record = createBranchRecord({ name, baseCommit: base, tipCommit: commit, now: this.#now() })
      await git.updateRef(record.ref, commit, null)
      await this.#store.patch(sessionId, {
        branches: [...(fresh.branches ?? []), record],
        currentBranchId: record.id,
        lastVersion: null,
      })
    } else {
      await this.#store.patch(sessionId, { lastVersion: null })
    }
    return true
  }
```

In `addTasks()`, replace the Task 12 sibling block with a migration-aware one:

```js
    const now = this.#now()
    await this.#maybeUpgrade(sessionId)
    const current = this.#store.get(sessionId)
    const created = list.map((text) => createTaskRecord({ text, mode, model, now }))
    if (isBranchQueue(current)) {
      const branch =
        this.#currentBranch(sessionId) ??
        (await this.#branches.createBranch(sessionId, { name: created[0].title, switchTo: true })).branch
      for (const record of created) record.branchId = branch.id
    } else {
      for (const record of created) {
        if (typeof basePath === 'string' && basePath !== '') record.basePath = basePath
      }
    }
```

In `#settleTask()`, replace the failed-check repair call

```js
              await this.#engine.message(run.id, { text: checkRepairPrompt({ command: check.command, output: check.output, attempt: fixes, attempts }) })
```

with:

```js
              const prompt = checkRepairPrompt({ command: check.command, output: check.output, attempt: fixes, attempts })
              if (run?.mode === 'orchestrator' && typeof this.#engine.repairArtifact === 'function') {
                await this.#engine.repairArtifact(run.id, { prompt, purpose: 'check' })
              } else {
                await this.#engine.message(run.id, { text: prompt })
              }
```

Add the public branch API after `ensureBranches()`:

```js
  /**
   * Branch panel payload for a session queue.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} branches, current branch, project head and drift.
   */
  async branchesSummary(sessionId) {
    await this.ensureBranches(sessionId)
    return this.#branches.list(sessionId)
  }

  /**
   * Create a branch in the queue.
   * @param {string} sessionId - chat session id.
   * @param {{ name?: string, fromCommit?: string|null, switchTo?: boolean }} input - branch options.
   * @returns {Promise<object>} queue and branch state.
   */
  async createBranch(sessionId, input = {}) {
    await this.ensureBranches(sessionId)
    return this.#branches.createBranch(sessionId, input)
  }

  /**
   * Rename a queue branch.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @param {string} name - new name.
   * @returns {Promise<object>} queue and branch state.
   */
  async renameBranch(sessionId, branchId, name) {
    await this.ensureBranches(sessionId)
    return this.#branches.renameBranch(sessionId, branchId, name)
  }

  /**
   * Select the branch new tasks go to.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} queue and branch state.
   */
  async switchBranch(sessionId, branchId) {
    await this.ensureBranches(sessionId)
    return this.#branches.switchBranch(sessionId, branchId)
  }

  /**
   * Delete a queue branch that is not applied and has no live tasks.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object>} queue and branch state.
   */
  async removeBranch(sessionId, branchId) {
    await this.ensureBranches(sessionId)
    return this.#branches.removeBranch(sessionId, branchId)
  }

  /**
   * Commits of a queue branch, newest first.
   * @param {string} sessionId - chat session id.
   * @param {string} branchId - branch id.
   * @returns {Promise<object[]>} commit cards.
   */
  async branchCommits(sessionId, branchId) {
    await this.ensureBranches(sessionId)
    return this.#branches.commits(sessionId, branchId)
  }

  /**
   * Apply a branch (or a checked subset of its commits) to the project.
   * @param {string} sessionId - chat session id.
   * @param {object} input - apply options from the client.
   * @returns {Promise<object>} apply result with queue, applied commit and check.
   */
  async applyBranch(sessionId, input = {}) {
    await this.ensureBranches(sessionId)
    return this.#branches.apply(sessionId, input)
  }

  /**
   * Merge one queue branch into another.
   * @param {string} sessionId - chat session id.
   * @param {object} input - merge options from the client.
   * @returns {Promise<object>} merge result with queue, merge commit and check.
   */
  async mergeBranches(sessionId, input = {}) {
    await this.ensureBranches(sessionId)
    return this.#branches.merge(sessionId, input)
  }

  /**
   * Current project head and uncommitted drift for the queue panel.
   * @param {string} sessionId - chat session id.
   * @returns {Promise<object>} project state.
   */
  async projectState(sessionId) {
    await this.ensureBranches(sessionId)
    return this.#branches.projectState(sessionId)
  }
```

- [ ] **Step 4: Wire the git resolver in `lib/index.js`**

Add the import:

```js
import { ArtelGit } from './git.js'
```

Right after `const queueRunner = new QueueRunner({ engine, store: queueStore, stateDir, rootCopyRoot: copyRoot, log })` (keep the constructor call as written there), add:

```js
  engine.setGitResolver(async (projectPath) => await ArtelGit.open({ stateDir, projectPath }))
```

- [ ] **Step 5: Run the migration tests**

Run: `node --test test/queue-migration.test.js`
Expected: PASS — 3 tests. The Orchestrator test needs the autopilot pump, so it takes a few seconds.

- [ ] **Step 6: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — existing queue-runner tests keep the legacy path (their queues have no `model` and their FakeEngine reports no runs with changes), plus the 3 new tests.

- [ ] **Step 7: Commit**

```bash
git add lib/queue-runner.js lib/index.js test/queue-migration.test.js
git commit -m "feat: migrate queues to branch versions and repair orchestrator checks"
```

### Task 14: Branch routes and error details

**Files:**
- Modify: `lib/routes.js`
- Modify: `test/routes.test.js`

**Interfaces:**
- Consumes: `queueRunner.branchesSummary/createBranch/renameBranch/switchBranch/removeBranch/branchCommits/applyBranch/mergeBranches/projectState` from Task 13; `BranchError.details`.
- Produces: `GET /queue/branches` → branch list; `POST /queue/branches` `{ sessionId, name, fromCommit?, switchTo? }`; `PATCH /queue/branches/:id` `{ sessionId, name }`; `DELETE /queue/branches/:id?sessionId=`; `POST /queue/branches/:id/switch`; `GET /queue/branches/:id/commits` → `{ commits }`; `POST /queue/branches/:id/apply` `{ sessionId, commitIds?, confirmDrift?, checkCommand?, force? }`; `POST /queue/branches/:id/merge` `{ sessionId, sourceBranchId, checkCommand?, force? }`; `GET /queue/project-state?sessionId=`; every JSON error keeps `{ error, code }` and now carries `details` when the error has one; `POST /queue` already accepts `mode: 'orchestrator'` through Task 7's `queueModeRefusal`.

- [ ] **Step 1: Extend the fake queue runner and write the failing route tests**

In `test/routes.test.js`, add these methods to `fakeQueueRunner()` after `postponeVersion()`:

```js
    async branchesSummary(sessionId) {
      calls.push({ method: 'branchesSummary', args: [sessionId] })
      return {
        queue: { sessionId },
        project: { head: 'a'.repeat(40), repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
        currentBranchId: 'b-1',
        branches: [{ id: 'b-1', name: 'Main', ref: 'refs/heads/artel/b-1', baseCommit: 'a'.repeat(40), tipCommit: null }],
      }
    },
    async createBranch(sessionId, input) {
      calls.push({ method: 'createBranch', args: [sessionId, input] })
      return { branch: { id: 'b-2', name: input.name }, branches: [] }
    },
    async renameBranch(sessionId, branchId, name) {
      calls.push({ method: 'renameBranch', args: [sessionId, branchId, name] })
      return { currentBranchId: branchId, branches: [] }
    },
    async switchBranch(sessionId, branchId) {
      calls.push({ method: 'switchBranch', args: [sessionId, branchId] })
      return { currentBranchId: branchId, branches: [] }
    },
    async removeBranch(sessionId, branchId) {
      calls.push({ method: 'removeBranch', args: [sessionId, branchId] })
      return { currentBranchId: null, branches: [] }
    },
    async branchCommits(sessionId, branchId) {
      calls.push({ method: 'branchCommits', args: [sessionId, branchId] })
      return [{ commit: 'c'.repeat(40), parents: ['a'.repeat(40)], subject: 'Answer two', date: '2026-11-21T00:00:00.000Z', files: ['src/app.js'], changeCount: 1 }]
    },
    async applyBranch(sessionId, input) {
      calls.push({ method: 'applyBranch', args: [sessionId, input] })
      return { applied: { branchId: input.branchId, commit: 'c'.repeat(40), files: 1 }, check: null }
    },
    async mergeBranches(sessionId, input) {
      calls.push({ method: 'mergeBranches', args: [sessionId, input] })
      return { mergeCommit: 'd'.repeat(40), check: null }
    },
    async projectState(sessionId) {
      calls.push({ method: 'projectState', args: [sessionId] })
      return { head: 'a'.repeat(40), branchId: 'b-1', drift: { dirty: false, files: [] } }
    },
```

Replace the test `'the queue route refuses modes it cannot run instead of silently running Solo'` with:

```js
test('the queue route accepts the Orchestrator and still refuses unknown modes', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const orchestrator = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'Plan the release', mode: 'orchestrator' },
  })
  assert.equal(orchestrator.status, 200)
  assert.equal(queueRunner.calls.length, 1)
  assert.equal(queueRunner.calls[0].method, 'addTasks')
  assert.equal(queueRunner.calls[0].args[0].mode, 'orchestrator')

  const unknown = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'Do the thing', mode: 'banana' },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'queue/mode-unknown')
  assert.match(unknown.body.error, /banana/)
  assert.match(unknown.body.error, /solo, swarm, conductor, orchestrator, fusion/)
  assert.equal(queueRunner.calls.length, 1, 'an unknown mode never reaches addTasks')
})
```

Add these tests after it:

```js
test('the queue branch routes forward branch operations', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const list = await call(webServer.routes, `${API_PREFIX}/queue/branches?sessionId=s1`)
  assert.equal(list.status, 200)
  assert.equal(list.body.currentBranchId, 'b-1')
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'branchesSummary', args: ['s1'] })

  const created = await call(webServer.routes, `${API_PREFIX}/queue/branches`, {
    method: 'POST',
    body: { sessionId: 's1', name: 'Night', fromCommit: 'a'.repeat(40) },
  })
  assert.equal(created.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'createBranch',
    args: ['s1', { name: 'Night', fromCommit: 'a'.repeat(40), switchTo: true }],
  })

  const renamed = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1`, {
    method: 'PATCH',
    body: { sessionId: 's1', name: 'Renamed' },
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'renameBranch', args: ['s1', 'b-1', 'Renamed'] })

  const switched = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/switch`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(switched.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'switchBranch', args: ['s1', 'b-1'] })

  const commits = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/commits?sessionId=s1`)
  assert.equal(commits.status, 200)
  assert.equal(commits.body.commits[0].subject, 'Answer two')
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'branchCommits', args: ['s1', 'b-1'] })

  const applied = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/apply`, {
    method: 'POST',
    body: { sessionId: 's1', commitIds: ['c1', 5], confirmDrift: true, checkCommand: 'npm test', force: true },
  })
  assert.equal(applied.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'applyBranch',
    args: ['s1', { branchId: 'b-1', commitIds: ['c1'], confirmDrift: true, checkCommand: 'npm test', force: true }],
  })

  const merged = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/merge`, {
    method: 'POST',
    body: { sessionId: 's1', sourceBranchId: 'b-2' },
  })
  assert.equal(merged.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'mergeBranches',
    args: ['s1', { targetBranchId: 'b-1', sourceBranchId: 'b-2', checkCommand: '', force: false }],
  })

  const removed = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1?sessionId=s1`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'removeBranch', args: ['s1', 'b-1'] })

  const project = await call(webServer.routes, `${API_PREFIX}/queue/project-state?sessionId=s1`)
  assert.equal(project.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'projectState', args: ['s1'] })

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/queue/branches?sessionId=s1`, { method: 'PUT' })
  assert.equal(wrongMethod.status, 405)
  const noSource = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/merge`, { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(noSource.status, 400)
  assert.equal(noSource.body.code, 'artel/bad-request')
})

test('a branch error keeps its status, code and details in the JSON body', async () => {
  const queueRunner = fakeQueueRunner()
  queueRunner.applyBranch = async () => {
    const error = new Error('The project has uncommitted changes.')
    error.status = 409
    error.code = 'artel/project-drift'
    error.details = { drift: { dirty: true, files: ['src/app.js'] }, branchId: 'b-1' }
    throw error
  }
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/apply`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'artel/project-drift')
  assert.deepEqual(response.body.details, { drift: { dirty: true, files: ['src/app.js'] }, branchId: 'b-1' })
})
```

- [ ] **Step 2: Run the route tests and confirm they fail**

Run: `node --test test/routes.test.js`
Expected: FAIL — the branch URLs fall through to `artel/not-found`, the Orchestrator is still refused, and the error body has no `details`.

- [ ] **Step 3: Extend `writeError` and `fenced` in `lib/routes.js`**

Replace `writeError` (around line 92) with:

```js
export function writeError(response, status, message, code, details = null) {
  const body = { error: message, code }
  if (details !== null && details !== undefined) body.details = details
  writeJson(response, status, body)
}
```

In `fenced()`, replace the error write:

```js
        if (!response.headersSent) writeError(response, status, error?.message ?? 'Artel failed', code, error?.details ?? null)
```

- [ ] **Step 4: Add the branch routes to `registerQueueRoutes()`**

Insert after the `versions` block (before the final `throw new RouteError('Unknown queue route', 404, 'artel/not-found')`):

```js
      if (action === 'project-state') {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const sessionId = requireSessionId(queryParam(url, 'sessionId'))
        writeJson(response, 200, await queueRunner.projectState(sessionId))
        return
      }

      if (action === 'branches') {
        const branchId = segments[1]
        const verb = segments[2]

        if (branchId === undefined) {
          if (method === 'GET') {
            const sessionId = requireSessionId(queryParam(url, 'sessionId'))
            writeJson(response, 200, await queueRunner.branchesSummary(sessionId))
            return
          }
          if (method === 'POST') {
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body?.sessionId)
            const name = typeof body?.name === 'string' ? body.name : ''
            const fromCommit = typeof body?.fromCommit === 'string' && body.fromCommit !== '' ? body.fromCommit : null
            writeJson(response, 200, await queueRunner.createBranch(sessionId, { name, fromCommit, switchTo: body?.switchTo !== false }))
            return
          }
          throw new RouteError('Method not allowed', 405, 'artel/method')
        }

        if (verb === undefined) {
          if (method === 'PATCH') {
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body?.sessionId)
            if (typeof body?.name !== 'string' || body.name.trim() === '') throw new RouteError('name is required', 400, 'artel/bad-request')
            writeJson(response, 200, await queueRunner.renameBranch(sessionId, branchId, body.name))
            return
          }
          if (method === 'DELETE') {
            const sessionId = requireSessionId(queryParam(url, 'sessionId'))
            writeJson(response, 200, await queueRunner.removeBranch(sessionId, branchId))
            return
          }
          throw new RouteError('Method not allowed', 405, 'artel/method')
        }

        if (verb === 'switch') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          writeJson(response, 200, await queueRunner.switchBranch(sessionId, branchId))
          return
        }

        if (verb === 'commits') {
          if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
          const sessionId = requireSessionId(queryParam(url, 'sessionId'))
          writeJson(response, 200, { commits: await queueRunner.branchCommits(sessionId, branchId) })
          return
        }

        if (verb === 'apply') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          writeJson(response, 200, await queueRunner.applyBranch(sessionId, {
            branchId,
            commitIds: Array.isArray(body?.commitIds) ? body.commitIds.filter((item) => typeof item === 'string') : null,
            confirmDrift: body?.confirmDrift === true,
            checkCommand: typeof body?.checkCommand === 'string' ? body.checkCommand : '',
            force: body?.force === true,
          }))
          return
        }

        if (verb === 'merge') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          const sourceBranchId = typeof body?.sourceBranchId === 'string' && body.sourceBranchId !== '' ? body.sourceBranchId : null
          if (sourceBranchId === null) throw new RouteError('sourceBranchId is required', 400, 'artel/bad-request')
          writeJson(response, 200, await queueRunner.mergeBranches(sessionId, {
            targetBranchId: branchId,
            sourceBranchId,
            checkCommand: typeof body?.checkCommand === 'string' ? body.checkCommand : '',
            force: body?.force === true,
          }))
          return
        }

        throw new RouteError('Unknown queue route', 404, 'artel/not-found')
      }
```

- [ ] **Step 5: Run the route tests**

Run: `node --test test/routes.test.js`
Expected: PASS — the 0.8.3 refusal test is replaced by the Orchestrator-accepted test, the branch routes are covered and the 409 details round-trip.

- [ ] **Step 6: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — no other route test asserts an exact error body except `{ error, code }`, which stays unchanged when an error has no details.

- [ ] **Step 7: Commit**

```bash
git add lib/routes.js test/routes.test.js
git commit -m "feat: expose the queue branch API and error details"
```

### Task 15: Client API, store and the five-mode queue picker

**Files:**
- Modify: `lib/client.js`
- Modify: `test/client.test.js`

**Interfaces:**
- Consumes: the routes from Task 14.
- Produces: `api.queueBranches/queueBranchCreate/queueBranchRename/queueBranchSwitch/queueBranchRemove/queueBranchCommits/queueBranchApply/queueBranchMerge/queueProjectState`; `request()` attaches the JSON `details` to thrown errors as `error.details`; `QUEUE_MODE_IDS = ['solo','swarm','conductor','orchestrator','fusion']` and `queueModeOptions(tt)` returns five plain enabled options; the debug bridge keeps `queueHelpers.modes`/`queueHelpers.modeOptions`; the store snapshot gains `queueBranches: null`, `queueBranchError: null`, `branchCommits: []`; store methods `loadQueueBranches()`, `createBranch(input)`, `renameBranch(branchId, name)`, `switchBranch(branchId)`, `removeBranch(branchId)`, `loadBranchCommits(branchId)`, `applyBranch(branchId, input)`, `mergeBranch(targetBranchId, input)`; failures publish `{ text, code, details }` into `queueBranchError`.

- [ ] **Step 1: Update the client tests**

In `test/client.test.js`, change the dictionary count assertion (line 2503):

```js
  assert.equal(queueAndFactory.length, 190, 'every queue and factory string is present')
```

Replace the debug-bridge mode assertions (lines 2552-2559) with:

```js
  assert.deepEqual(debug.queueHelpers.modes, ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  const modeOptions = debug.queueHelpers.modeOptions(ruT)
  assert.deepEqual(modeOptions.map((option) => option.value), ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  assert.equal(modeOptions.length, 5)
  assert.equal(modeOptions[3].label, 'Оркестратор')
  assert.ok(modeOptions.every((option) => option.disabled !== true && option.hint === undefined), 'every queue mode is selectable')
```

Replace the test `'the queue mode picker shows the Orchestrator disabled and cannot choose it'` (line 2676 to the end of that test) with:

```js
test('the queue picker offers the Orchestrator and queues it', async () => {
  const current = { queue: queueFixture() }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(current.queue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          const added = { ...queueFixture().tasks[0], id: 'q-new', text: body.task, title: body.task, mode: body.mode }
          current.queue = { ...current.queue, tasks: [...current.queue.tasks, added] }
          return reply({ queue: current.queue, added: 1 })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  assert.ok(findByClass(opened, 'dsh-artel-queue') !== undefined, 'the hero shows the «Ожидают» strip')
  const selectTrigger = () => findAll(findByClass(opened, 'dsh-artel-queue__add'), (node) => node.type === 'button'
    && String(node.props.className).split(/\s+/).includes('dsh-artel-select'))[0]
  selectTrigger().props.onClick()
  opened = await state.realm.renderer.flush()
  const menu = findByClass(opened, 'dsh-artel-menu')
  assert.ok(menu !== undefined, 'the mode picker opens')
  const options = findAll(menu, (node) => node.props?.role === 'option')
  assert.deepEqual(options.map((node) => node.props['data-value']), ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  assert.ok(options.every((node) => node.props['aria-disabled'] !== 'true' && node.props['data-disabled'] !== 'true'), 'all five modes are selectable')
  assert.match(textOf(menu), /Оркестратор/)

  pickOption(opened, 'orchestrator')
  opened = await state.realm.renderer.flush()
  assert.equal(selectTrigger().props['data-value'], 'orchestrator')
  assert.equal(findByClass(opened, 'dsh-artel-menu'), undefined)

  const input = findAll(opened, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-queue__input'))[0]
  input.props.onChange({ target: { value: 'Собери релиз' } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-queue'), 'В очередь').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const posted = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/queue' && call.method === 'POST')
  assert.ok(posted !== undefined, 'adding a task reached the Host')
  assert.equal(posted.body.mode, 'orchestrator')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('branch actions load branch state and keep error details for the panel', async () => {
  const branches = {
    queue: { sessionId: 'sess-1' },
    project: { head: 'a'.repeat(40), repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b-1',
    branches: [{ id: 'b-1', name: 'Night', ref: 'refs/heads/artel/b-1', baseCommit: 'a'.repeat(40), tipCommit: null }],
  }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture())
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') return reply(branches)
        if (pathname === '/api/dsh-artel/queue/branches/b-1/apply' && method === 'POST') {
          return reply({ error: 'The project has uncommitted changes.', code: 'artel/project-drift', details: { drift: { dirty: true, files: ['src/app.js'] } } }, 409)
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const store = state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1')
  assert.equal(store.getSnapshot().queueBranches, null)
  assert.equal(store.getSnapshot().queueBranchError, null)

  const loaded = await store.loadQueueBranches()
  assert.equal(loaded.currentBranchId, 'b-1')
  assert.equal(store.getSnapshot().queueBranches.currentBranchId, 'b-1', 'branch state lands in the snapshot')

  const applied = await store.applyBranch('b-1', {})
  assert.equal(applied, null)
  assert.equal(store.getSnapshot().queueBranchError.code, 'artel/project-drift')
  assert.deepEqual(store.getSnapshot().queueBranchError.details.drift.files, ['src/app.js'])
  assert.match(store.getSnapshot().queueBranchError.text, /uncommitted changes/)
  store.dispose()
})
```

- [ ] **Step 2: Run the client tests and confirm they fail**

Run: `node --test test/client.test.js`
Expected: FAIL — the picker still shows four selectable modes plus a disabled Orchestrator, the dictionary count is 187, and the store has no branch methods.

- [ ] **Step 3: Attach error details and add the branch API calls**

In `createApi().request` (around line 3186), after `error.code = code`, add:

```js
            if (payload !== null && payload !== undefined && payload.details !== undefined && payload.details !== null) error.details = payload.details
```

Add the branch methods after `queuePostponeVersion` (around line 3241):

```js
        queueProjectState: (sessionId) => request('GET', '/queue/project-state?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 20000 }),
        queueBranches: (sessionId) => request('GET', '/queue/branches?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 20000 }),
        queueBranchCreate: (payload) => request('POST', '/queue/branches', payload, { timeoutMs: 180000 }),
        queueBranchRename: (sessionId, branchId, name) =>
          request('PATCH', '/queue/branches/' + encodeURIComponent(branchId), { sessionId, name }, { timeoutMs: 20000 }),
        queueBranchSwitch: (sessionId, branchId) =>
          request('POST', '/queue/branches/' + encodeURIComponent(branchId) + '/switch', { sessionId }, { timeoutMs: 20000 }),
        queueBranchRemove: (sessionId, branchId) =>
          request('DELETE', '/queue/branches/' + encodeURIComponent(branchId) + '?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 20000 }),
        queueBranchCommits: (sessionId, branchId) =>
          request('GET', '/queue/branches/' + encodeURIComponent(branchId) + '/commits?sessionId=' + encodeURIComponent(sessionId), undefined, { timeoutMs: 20000 }),
        queueBranchApply: (sessionId, branchId, input) =>
          request('POST', '/queue/branches/' + encodeURIComponent(branchId) + '/apply', { sessionId, ...(input ?? {}) }, { timeoutMs: 300000 }),
        queueBranchMerge: (sessionId, targetBranchId, input) =>
          request('POST', '/queue/branches/' + encodeURIComponent(targetBranchId) + '/merge', { sessionId, ...(input ?? {}) }, { timeoutMs: 300000 }),
```

- [ ] **Step 4: Make the Orchestrator a normal queue mode in the picker**

Replace the block from `/** Modes the «Автоочередь» accepts (the orchestrator is not a queue mode). */` through the end of `queueModeOptions()` (around lines 3375-3400) with:

```js
    /** Modes the «Автоочередь» accepts; one task still becomes one commit. */
    const QUEUE_MODE_IDS = ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion']

    /**
     * Options of the queue mode picker.
     * @param {Function} tt - translation function.
     * @returns {Array<{ value: string, label: string }>} options.
     */
    function queueModeOptions(tt) {
      return QUEUE_MODE_IDS.map((id) => ({ value: id, label: modeLabel(tt, id) }))
    }
```

- [ ] **Step 5: Update the three dictionaries**

In each dictionary (`en` around line 345, `ru` around line 805, `zh` around line 1265), right after `'queue.addPlaceholder'`, add the branch strings and delete `'queue.mode.orchestratorReason'`:

```js
      'queue.branch': 'Branch',
      'queue.branchAll': 'All branches',
      'queue.branchCurrent': 'Current branch',
      'queue.commit': 'Commit',
```

```js
      'queue.branch': 'Ветка',
      'queue.branchAll': 'Все ветки',
      'queue.branchCurrent': 'Текущая ветка',
      'queue.commit': 'Коммит',
```

```js
      'queue.branch': '分支',
      'queue.branchAll': '所有分支',
      'queue.branchCurrent': '当前分支',
      'queue.commit': '提交',
```

- [ ] **Step 6: Add the branch state to the store**

In the initial snapshot object (around line 4111, next to `queuePreflight: null`), add:

```js
        queueBranches: null,
        queueBranchError: null,
        branchCommits: [],
```

After `dismissQueuePreflight()` (around line 4581), add:

```js
      /** Branch state of the current queue, loaded on demand by the branch panel. */
      async function loadQueueBranches(options = {}) {
        try {
          const payload = await api.queueBranches(sessionId)
          publish({ queueBranches: payload ?? null, ...(options.silent === true ? {} : { queueBranchError: null }) })
          return payload ?? null
        } catch (error) {
          publish({ queueBranchError: branchError(error) })
          return null
        }
      }

      /** One branch action: run the API call, then reload the branches it touched. */
      async function queueBranchAction(run) {
        if (snapshot.queueBusy === true) return null
        publish({ queueBusy: true, queueBranchError: null })
        try {
          const payload = await run()
          if (payload?.queue !== undefined && payload.queue !== null) publish(queuePatch(payload))
          await loadQueueBranches({ silent: true })
          publish({ queueBusy: false })
          return payload ?? null
        } catch (error) {
          publish({ queueBusy: false, queueBranchError: branchError(error) })
          return null
        }
      }

      /** A panel-facing error: message, stable code and the structured details. */
      function branchError(error) {
        return {
          text: describeError(error, t),
          code: typeof error?.code === 'string' ? error.code : null,
          details: error?.details ?? null,
        }
      }

      function createBranch(input) { return queueBranchAction(() => api.queueBranchCreate({ sessionId, ...(input ?? {}) })) }
      function renameBranch(branchId, name) { return queueBranchAction(() => api.queueBranchRename(sessionId, branchId, name)) }
      function switchBranch(branchId) { return queueBranchAction(() => api.queueBranchSwitch(sessionId, branchId)) }
      function removeBranch(branchId) { return queueBranchAction(() => api.queueBranchRemove(sessionId, branchId)) }
      function loadBranchCommits(branchId) {
        return queueBranchAction(async () => {
          const payload = await api.queueBranchCommits(sessionId, branchId)
          publish({ branchCommits: Array.isArray(payload?.commits) ? payload.commits : [] })
          return payload ?? null
        })
      }
      function applyBranch(branchId, input = {}) {
        return queueBranchAction(async () => {
          const payload = await api.queueBranchApply(sessionId, branchId, input)
          await refreshRuns({ silent: true })
          await loadQueue({ silent: true })
          return payload ?? null
        })
      }
      function mergeBranch(targetBranchId, input = {}) {
        return queueBranchAction(async () => {
          const payload = await api.queueBranchMerge(sessionId, targetBranchId, input)
          await loadQueue({ silent: true })
          return payload ?? null
        })
      }
```

Add these keys to the object returned by `createArtelStore()` where the queue actions are exported (around line 4924):

```js
        loadQueueBranches,
        createBranch,
        renameBranch,
        switchBranch,
        removeBranch,
        loadBranchCommits,
        applyBranch,
        mergeBranch,
```

- [ ] **Step 7: Run the client tests**

Run: `node --test test/client.test.js`
Expected: PASS — the picker lists five selectable modes, the Orchestrator round-trips into the add-task POST, the dictionaries stay in sync at 190 queue+factory keys, and branch state plus error details are covered.

- [ ] **Step 8: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS — no other test asserts the old four-mode picker or the disabled entry.

- [ ] **Step 9: Commit**

```bash
git add lib/client.js test/client.test.js
git commit -m "feat: queue the Orchestrator and load branch state in the client"
```

### Task 16: Branch chip, branch modal and apply/merge dialogs

**Files:**
- Modify: `lib/client.js`
- Modify: `test/client.test.js`

**Interfaces:**
- Consumes: Task 15's store actions and snapshot fields (`snap.queueBranches`, `snap.queueBranchError`, `snap.branchCommits`), Task 14's routes.
- Produces: `BranchModal({ t, store, snap, onClose })` rendered from `QueueStrip`; the queue head gains a `.dsh-artel-queue__branchChip` trigger and the modal replaces the pre-flight card for branch queues; a results-card row gains the short commit and an apply shortcut; new `queue.branch*` dictionary keys; CSS for the modal, chip and commit rows.

- [ ] **Step 1: Write the failing client tests**

Add these two tests to `test/client.test.js` next to the queue tests:

```js
test('the queue head shows the current branch and opens the branch panel', async () => {
  const base = 'a'.repeat(40)
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b-1',
    branches: [
      { id: 'b-1', name: 'Ночная', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: 'c'.repeat(40) },
      { id: 'b-2', name: 'Дневная', ref: 'refs/heads/artel/b-2', baseCommit: base, tipCommit: null },
    ],
  }
  const commits = { commits: [
    { commit: 'c'.repeat(40), parents: [base], subject: 'Первая правка', date: '2026-11-21T03:00:00Z', files: 1, changeCount: 1 },
    { commit: 'd'.repeat(40), parents: ['c'.repeat(40)], subject: 'Вторая правка', date: '2026-11-21T04:00:00Z', files: 2, changeCount: 2 },
  ] }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          return reply({ queue: branchQueue, project: branchQueue.project, currentBranchId: 'b-1', branches: branchQueue.branches })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/commits' && method === 'GET') return reply(commits)
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  const chip = findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))[0]
  assert.ok(chip !== undefined, 'a branch queue shows the current-branch chip')
  assert.match(textOf(chip), /Текущая ветка/)
  assert.match(textOf(chip), /Ночная/)

  chip.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  const modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.ok(modal !== undefined, '«Все ветки» opens the branch panel')
  assert.match(textOf(modal), /Дневная/)
  assert.match(textOf(modal), /Первая правка/)
  assert.match(textOf(modal), /Вторая правка/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the branch apply dialog sends the checked commits and the drift confirmation', async () => {
  const base = 'a'.repeat(40)
  const commitsList = [
    { commit: '1'.repeat(40), parents: [base], subject: 'Первая правка', date: '2026-11-21T01:00:00Z', files: 1, changeCount: 1 },
    { commit: '2'.repeat(40), parents: ['1'.repeat(40)], subject: 'Вторая правка', date: '2026-11-21T02:00:00Z', files: 1, changeCount: 1 },
    { commit: '3'.repeat(40), parents: ['2'.repeat(40)], subject: 'Третья правка', date: '2026-11-21T03:00:00Z', files: 1, changeCount: 1 },
  ]
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: true, files: ['src/app.js'] } },
    currentBranchId: 'b-1',
    branches: [{ id: 'b-1', name: 'Ночная', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: '3'.repeat(40) }],
  }
  let applies = 0
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          return reply({ queue: branchQueue, project: branchQueue.project, currentBranchId: 'b-1', branches: branchQueue.branches })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/commits' && method === 'GET') return reply({ commits: commitsList })
        if (pathname === '/api/dsh-artel/queue/branches/b-1/apply' && method === 'POST') {
          applies += 1
          assert.deepEqual(body.commitIds, ['1'.repeat(40), '3'.repeat(40)])
          if (applies === 1) {
            return reply({ error: 'The project has uncommitted changes.', code: 'artel/project-drift', details: { drift: { dirty: true, files: ['src/app.js'] } } }, 409)
          }
          assert.equal(body.confirmDrift, true)
          return reply({ queue: { ...branchQueue, project: { ...branchQueue.project, head: '3'.repeat(40), drift: { dirty: false, files: [] } } } })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))[0].props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  const modal = findByClass(opened, 'dsh-artel-branchModal')
  findAll(modal, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-branchModal__apply'))[0].props.onClick()
  opened = await state.realm.renderer.flush()

  const boxes = findAll(findByClass(opened, 'dsh-artel-branchModal'), (node) => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(boxes.length, 3, 'the apply dialog lists every commit of the branch')
  boxes[1].props.onChange({ target: { checked: false } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-branchModal'), 'Применить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  const errorPanel = findByClass(opened, 'dsh-artel-branchModal__error')
  assert.ok(errorPanel !== undefined, 'a drift refusal is explained in the panel')
  assert.match(textOf(errorPanel), /src\/app\.js/)
  findButton(findByClass(opened, 'dsh-artel-branchModal'), 'Всё равно применить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  assert.equal(applies, 2, 'the second click applies after confirming the drift')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})
```

- [ ] **Step 2: Run the client tests and confirm they fail**

Run: `node --test test/client.test.js`
Expected: FAIL — the queue head has no branch chip, no `BranchModal` exists, and the new dictionary keys are missing.

- [ ] **Step 3: Add the `BranchModal` component**

In `lib/client.js`, insert this component right after the `Switch` component (before the `QueueStrip` JSDoc, around line 7966):

```js
    const shortCommit = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : (sha ?? ''))

    /**
     * «Все ветки»: branch list, commit list and the apply/merge dialogs.
     * Rendered on top of the queue strip so the night-shift results stay in
     * place while the user reads and applies one branch.
     */
    function BranchModal(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const onClose = props.onClose
      const state = snap.queueBranches
      const branches = Array.isArray(state?.branches) ? state.branches : []
      const currentId = state?.currentBranchId ?? snap.queue?.currentBranchId ?? null
      const commits = Array.isArray(snap.branchCommits) ? snap.branchCommits : []
      const error = snap.queueBranchError ?? null
      const [selectedId, setSelectedId] = useState(currentId)
      const [applyOpen, setApplyOpen] = useState(false)
      const [chosen, setChosen] = useState(null)
      const [confirmDrift, setConfirmDrift] = useState(false)
      const [force, setForce] = useState(false)
      const [checkCommand, setCheckCommand] = useState('')
      const [mergeOpen, setMergeOpen] = useState(false)
      const [sourceId, setSourceId] = useState(null)
      const [newName, setNewName] = useState('')
      const [renameOpen, setRenameOpen] = useState(false)
      const [removeOpen, setRemoveOpen] = useState(false)
      const selected = branches.find((branch) => branch.id === selectedId) ?? null
      const sources = branches.filter((branch) => branch.id !== currentId)

      useEffect(() => {
        if (selectedId === null || selectedId === undefined) return
        void store.loadBranchCommits(selectedId)
      }, [selectedId])

      const toggleCommit = (sha) => setChosen((current) => {
        const list = current ?? commits.map((commit) => commit.commit)
        return list.includes(sha) ? list.filter((item) => item !== sha) : [...list, sha]
      })
      const selectedCommits = () => {
        if (chosen === null) return null
        const ordered = commits.map((commit) => commit.commit).filter((sha) => chosen.includes(sha))
        return ordered.length === commits.length ? null : ordered
      }
      const apply = (overrides = {}) => {
        if (selectedId === null || selectedId === undefined) return
        const payload = {
          commitIds: selectedCommits(),
          confirmDrift,
          checkCommand: checkCommand.trim(),
          force,
          ...overrides,
        }
        void store.applyBranch(selectedId, payload)
      }
      const merge = (overrides = {}) => {
        if (currentId === null || currentId === undefined || sourceId === null) return
        void store.mergeBranch(currentId, { sourceBranchId: sourceId, checkCommand: checkCommand.trim(), force, ...overrides })
      }
      const stop = (event) => { if (event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation() }

      const errorCard = error === null
        ? null
        : h(
          'div',
          { className: 'dsh-artel-branchModal__error' },
          h('span', null, error.text),
          error.code === 'artel/project-drift' && error.details?.drift !== undefined
            ? h('span', { className: 'dsh-artel-branchModal__drift' }, t('queue.driftWarning') + ': ' + (error.details.drift.files ?? []).join(', '))
            : null,
          error.code === 'artel/project-drift'
            ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: snap.queueBusy === true, onClick: () => { setConfirmDrift(true); apply({ confirmDrift: true }) } }, t('queue.applyAnyway'))
            : null,
          error.code === 'artel/apply-conflict' || error.code === 'artel/merge-conflict'
            ? h('span', null, t('queue.conflicts') + ': ' + (error.details?.conflicts ?? []).join(', '))
            : null,
          error.code === 'artel/check-failed' && error.details?.check !== undefined
            ? h('span', { className: 'dsh-artel-branchModal__drift' }, t('queue.checkFailed') + ': ' + (error.details.check.output ?? ''))
            : null,
          error.code === 'artel/check-failed'
            ? h('button', { type: 'button', className: 'dsh-artel-btn', disabled: snap.queueBusy === true, onClick: () => { setForce(true); apply({ force: true }) } }, t('queue.applyAnyway'))
            : null,
          error.code === 'artel/legacy-queue' ? h('span', { className: 'dsh-artel-branchModal__drift' }, t('queue.legacyQueue')) : null,
        )

      const applyPanel = applyOpen !== true
        ? null
        : h(
          'div',
          { className: 'dsh-artel-branchModal__panel' },
          h('span', { className: 'dsh-artel-branchModal__panelTitle' }, t('queue.branchApplyTitle')),
          state?.project?.drift?.dirty === true
            ? h('span', { className: 'dsh-artel-branchModal__drift' }, t('queue.driftWarning') + ': ' + (state.project.drift.files ?? []).join(', '))
            : null,
          commits.length === 0
            ? h('span', { className: 'dsh-artel-queue__hint' }, t('queue.branchEmpty'))
            : h(
              'div',
              { className: 'dsh-artel-branchModal__commits' },
              justify(commits, (commit) => h(
                'label',
                { key: commit.commit, className: 'dsh-artel-branchModal__commit' },
                h('input', { type: 'checkbox', checked: chosen === null || chosen.includes(commit.commit), onChange: () => toggleCommit(commit.commit) }),
                h('span', { className: 'dsh-artel-branchModal__commitText' }, commit.subject ?? commit.commit),
                h('span', { className: 'dsh-artel-queue__commit' }, shortCommit(commit.commit)),
              )),
            ),
          h(
            'label',
            { className: 'dsh-artel-queue__field' },
            h('span', { className: 'dsh-artel-queue__label' }, t('queue.checkCommand')),
            h('input', { type: 'text', className: 'dsh-artel-input', value: checkCommand, onChange: (event) => setCheckCommand(event.target.value) }),
          ),
          h(
            'label',
            { className: 'dsh-artel-queue__check' },
            h('input', { type: 'checkbox', checked: force, onChange: (event) => setForce(event.target.checked) }),
            h('span', null, t('queue.applyAnyway')),
          ),
          errorCard,
          h(
            'div',
            { className: 'dsh-artel-branchModal__row' },
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: snap.queueBusy === true || commits.length === 0, onClick: () => apply() }, t('queue.apply')),
            h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => setApplyOpen(false) }, t('queue.close')),
          ),
        )

      const mergePanel = mergeOpen !== true
        ? null
        : h(
          'div',
          { className: 'dsh-artel-branchModal__panel' },
          h('span', { className: 'dsh-artel-branchModal__panelTitle' }, t('queue.branchMergeTitle')),
          sources.length === 0
            ? h('span', { className: 'dsh-artel-queue__hint' }, t('queue.branchEmpty'))
            : h(
              'label',
              { className: 'dsh-artel-queue__field' },
              h('span', { className: 'dsh-artel-queue__label' }, t('queue.sourceBranch')),
              h(
                'select',
                { className: 'dsh-artel-input', value: sourceId ?? '', onChange: (event) => setSourceId(event.target.value) },
                h('option', { value: '' }, '—'),
                justify(sources, (branch) => h('option', { key: branch.id, value: branch.id }, branch.name)),
              ),
            ),
          errorCard,
          h(
            'div',
            { className: 'dsh-artel-branchModal__row' },
            h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary', disabled: snap.queueBusy === true || sourceId === null, onClick: () => merge() }, t('queue.branchMerge')),
            h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => setMergeOpen(false) }, t('queue.close')),
          ),
        )

      return h(
        'div',
        { className: 'dsh-artel-modalBackdrop', onClick: onClose },
        h(
          'div',
          { className: 'dsh-artel-branchModal', onClick: stop },
          h(
            'div',
            { className: 'dsh-artel-branchModal__head' },
            h('span', { className: 'dsh-artel-branchModal__title' }, t('queue.branchAll')),
            h('button', { type: 'button', className: 'dsh-artel-btn', onClick: onClose }, t('queue.close')),
          ),
          errorCard,
          h(
            'div',
            { className: 'dsh-artel-branchModal__branches' },
            branches.length === 0
              ? h('span', { className: 'dsh-artel-queue__hint' }, t('queue.branchEmpty'))
              : justify(branches, (branch) => h(
                'button',
                {
                  key: branch.id,
                  type: 'button',
                  className: 'dsh-artel-branchModal__branch',
                  'data-active': branch.id === selectedId ? 'true' : 'false',
                  onClick: () => setSelectedId(branch.id),
                },
                h('span', { className: 'dsh-artel-branchModal__branchName' }, branch.name),
                branch.id === currentId ? h('span', { className: 'dsh-artel-queue__taskMeta' }, t('queue.branchCurrentMark')) : null,
                branch.appliedAt !== null && branch.appliedAt !== undefined ? h('span', { className: 'dsh-artel-queue__taskMeta' }, t('queue.branchAppliedMark')) : null,
                h('span', { className: 'dsh-artel-queue__commit' }, shortCommit(branch.tipCommit ?? branch.baseCommit)),
              )),
          ),
          selected === null
            ? null
            : h(
              'div',
              { className: 'dsh-artel-branchModal__panel' },
              h('span', { className: 'dsh-artel-branchModal__panelTitle' }, selected.name),
              h('span', { className: 'dsh-artel-queue__hint' }, t('queue.commitList') + ': ' + String(commits.length)),
              renameOpen === true
                ? h(
                  'div',
                  { className: 'dsh-artel-branchModal__row' },
                  h('input', { type: 'text', className: 'dsh-artel-input', value: newName, placeholder: selected.name, onChange: (event) => setNewName(event.target.value) }),
                  h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => { const name = newName.trim(); if (name !== '') { void store.renameBranch(selected.id, name); setRenameOpen(false); setNewName('') } } }, t('queue.branchRename')),
                )
                : null,
              removeOpen === true
                ? h(
                  'div',
                  { className: 'dsh-artel-branchModal__row' },
                  h('span', { className: 'dsh-artel-queue__hint' }, t('queue.branchRemoveConfirm')),
                  h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--danger', disabled: snap.queueBusy === true, onClick: () => { void store.removeBranch(selected.id); setRemoveOpen(false) } }, t('queue.branchRemove')),
                )
                : null,
              h(
                'div',
                { className: 'dsh-artel-branchModal__row' },
                h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--primary dsh-artel-branchModal__apply', disabled: snap.queueBusy === true, onClick: () => { setApplyOpen(true); setMergeOpen(false) } }, t('queue.branchApply')),
                h('button', { type: 'button', className: 'dsh-artel-btn', disabled: snap.queueBusy === true || sources.length === 0, onClick: () => { setMergeOpen(true); setApplyOpen(false) } }, t('queue.branchMerge')),
                selected.id === currentId ? null : h('button', { type: 'button', className: 'dsh-artel-btn', disabled: snap.queueBusy === true, onClick: () => { void store.switchBranch(selected.id) } }, t('queue.branchSwitch')),
                h('button', { type: 'button', className: 'dsh-artel-btn', onClick: () => { setRenameOpen(renameOpen !== true); setRemoveOpen(false) } }, t('queue.branchRename')),
                h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--danger', onClick: () => { setRemoveOpen(removeOpen !== true); setRenameOpen(false) } }, t('queue.branchRemove')),
              ),
              applyPanel,
              mergePanel,
            ),
          h(
            'div',
            { className: 'dsh-artel-branchModal__row' },
            h('input', { type: 'text', className: 'dsh-artel-input', value: newName, placeholder: t('queue.newName'), onChange: (event) => setNewName(event.target.value) }),
            h('button', { type: 'button', className: 'dsh-artel-btn', disabled: snap.queueBusy === true, onClick: () => { void store.createBranch({ name: newName.trim() }); setNewName('') } }, t('queue.create')),
          ),
        ),
      )
    }
```

- [ ] **Step 4: Patch `QueueStrip`**

In `QueueStrip`, add the branch state after the `resultsOpen` state:

```js
      const [branchOpen, setBranchOpen] = useState(false)
```

After the `resultsAt` line (around line 7988), add:

```js
      const branchesState = snap.queueBranches
      const branchQueue = queue?.model === 'branches'
      const branchCurrentId = branchesState?.currentBranchId ?? queue?.currentBranchId ?? null
      const branchCurrent = (Array.isArray(branchesState?.branches) ? branchesState.branches : []).find((branch) => branch.id === branchCurrentId) ?? null
      const openBranches = () => { setBranchOpen(true); void store.loadQueueBranches() }
```

In the head, just before the `h('div', { className: 'dsh-artel-surface__spacer' })` line (around line 8266), add:

```js
          branchQueue
            ? h(
              'button',
              { type: 'button', className: 'dsh-artel-queue__branchChip', disabled: busy, title: t('queue.branchAll'), onClick: openBranches },
              h('span', null, t('queue.branchCurrent') + ':'),
              h('span', { className: 'dsh-artel-queue__branchName' }, branchCurrent?.name ?? t('queue.branch')),
            )
            : null,
```

In the body, after the `resultsCard` element (around line 8331), add:

```js
            branchOpen === true ? h(BranchModal, { t, store, snap, onClose: () => setBranchOpen(false) }) : null,
```

In the results-card passed row, after the version meta span and before the open-run button (around line 8222), add:

```js
                  typeof entry.commit === 'string' ? h('span', { className: 'dsh-artel-queue__commit' }, shortCommit(entry.commit)) : null,
                  typeof entry.commit === 'string' ? h('button', { type: 'button', className: 'dsh-artel-btn dsh-artel-btn--ghost', disabled: busy, onClick: openBranches }, t('queue.branchApply')) : null,
```

- [ ] **Step 5: Add the dictionary keys**

In each dictionary (`en`/`ru`/`zh`), right after the four branch keys added in Task 15, add:

```js
      'queue.branchNew': 'New branch',
      'queue.branchRename': 'Rename',
      'queue.branchSwitch': 'Switch',
      'queue.branchRemove': 'Remove',
      'queue.branchRemoveConfirm': 'Remove the branch with all its commits?',
      'queue.branchApply': 'Apply branch',
      'queue.branchApplyTitle': 'Apply the branch to the project',
      'queue.branchMerge': 'Merge',
      'queue.branchMergeTitle': 'Merge another branch into this one',
      'queue.branchCurrentMark': 'current',
      'queue.branchAppliedMark': 'applied',
      'queue.branchEmpty': 'Nothing here yet.',
      'queue.commitList': 'Commits',
      'queue.applyAnyway': 'Apply anyway',
      'queue.driftWarning': 'The project has uncommitted changes',
      'queue.conflicts': 'Conflicts',
      'queue.checkFailed': 'The check failed',
      'queue.sourceBranch': 'Source branch',
      'queue.create': 'Create',
      'queue.apply': 'Apply',
      'queue.newName': 'Name',
      'queue.branchRenameTitle': 'Rename the branch',
```

```js
      'queue.branchNew': 'Новая ветка',
      'queue.branchRename': 'Переименовать',
      'queue.branchSwitch': 'Переключиться',
      'queue.branchRemove': 'Удалить',
      'queue.branchRemoveConfirm': 'Удалить ветку со всеми коммитами?',
      'queue.branchApply': 'Применить ветку',
      'queue.branchApplyTitle': 'Применить ветку к проекту',
      'queue.branchMerge': 'Слить',
      'queue.branchMergeTitle': 'Слить другую ветку в эту',
      'queue.branchCurrentMark': 'текущая',
      'queue.branchAppliedMark': 'применена',
      'queue.branchEmpty': 'Здесь пока пусто.',
      'queue.commitList': 'Коммиты',
      'queue.applyAnyway': 'Всё равно применить',
      'queue.driftWarning': 'В проекте есть незафиксированные изменения',
      'queue.conflicts': 'Конфликты',
      'queue.checkFailed': 'Проверка не прошла',
      'queue.sourceBranch': 'Исходная ветка',
      'queue.create': 'Создать',
      'queue.apply': 'Применить',
      'queue.newName': 'Название',
      'queue.branchRenameTitle': 'Переименовать ветку',
```

```js
      'queue.branchNew': '新分支',
      'queue.branchRename': '重命名',
      'queue.branchSwitch': '切换',
      'queue.branchRemove': '删除',
      'queue.branchRemoveConfirm': '删除这个分支及其所有提交？',
      'queue.branchApply': '应用分支',
      'queue.branchApplyTitle': '把分支应用到项目',
      'queue.branchMerge': '合并',
      'queue.branchMergeTitle': '把另一个分支合入这个分支',
      'queue.branchCurrentMark': '当前',
      'queue.branchAppliedMark': '已应用',
      'queue.branchEmpty': '这里还是空的。',
      'queue.commitList': '提交',
      'queue.applyAnyway': '仍然应用',
      'queue.driftWarning': '项目里还有未提交的改动',
      'queue.conflicts': '冲突',
      'queue.checkFailed': '检查未通过',
      'queue.sourceBranch': '源分支',
      'queue.create': '创建',
      'queue.apply': '应用',
      'queue.newName': '名称',
      'queue.branchRenameTitle': '重命名分支',
```

Then update the dictionary-count assertion in `test/client.test.js` (set in Task 15 to 190) to the count the test reports; with these 22 keys it becomes **212**.

- [ ] **Step 6: Add the CSS**

In `STYLES`, after the `.dsh-artel-queue__hint` rule, add:

```css
      .dsh-artel-queue__branchChip { display: inline-flex; align-items: center; gap: 5px; max-width: 260px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--a-line, rgba(255, 255, 255, 0.14)); background: transparent; color: var(--a-fg-2, rgba(255, 255, 255, 0.72)); font-size: 11px; cursor: pointer; overflow: hidden; white-space: nowrap; }
      .dsh-artel-queue__branchName { color: var(--a-fg-1); font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
      .dsh-artel-queue__commit { font-family: var(--a-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--a-fg-3, rgba(255, 255, 255, 0.5)); }
      .dsh-artel-modalBackdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; padding: 24px; }
      .dsh-artel-branchModal { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 760px; max-height: 80vh; overflow: auto; padding: 16px; border-radius: 12px; border: 1px solid var(--a-line, rgba(255, 255, 255, 0.12)); background: var(--a-bg-2, #17181c); color: var(--a-fg-1); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
      .dsh-artel-branchModal__head { display: flex; align-items: center; gap: 8px; }
      .dsh-artel-branchModal__title { flex: 1; font-weight: 600; }
      .dsh-artel-branchModal__branches { display: flex; flex-direction: column; gap: 2px; }
      .dsh-artel-branchModal__branch { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; font-size: 12px; text-align: left; cursor: pointer; }
      .dsh-artel-branchModal__branch[data-active="true"] { border-color: var(--a-line, rgba(255, 255, 255, 0.16)); background: var(--a-bg-3, rgba(255, 255, 255, 0.05)); }
      .dsh-artel-branchModal__branchName { flex: 1; font-weight: 500; }
      .dsh-artel-branchModal__panel { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 8px; border: 1px solid var(--a-line, rgba(255, 255, 255, 0.12)); }
      .dsh-artel-branchModal__panelTitle { font-weight: 600; font-size: 12px; }
      .dsh-artel-branchModal__commits { display: flex; flex-direction: column; gap: 2px; }
      .dsh-artel-branchModal__commit { display: flex; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 6px; font-size: 12px; }
      .dsh-artel-branchModal__commit:hover { background: var(--a-bg-3, rgba(255, 255, 255, 0.05)); }
      .dsh-artel-branchModal__commitText { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-artel-branchModal__row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .dsh-artel-branchModal__drift { font-size: 12px; color: var(--a-warn, #e0a32e); }
      .dsh-artel-branchModal__error { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--a-danger, #e5534b); font-size: 12px; color: var(--a-danger, #e5534b); }
```

- [ ] **Step 7: Run the client tests**

Run: `node --test test/client.test.js`
Expected: PASS — the chip shows «Текущая ветка: Ночная», the modal lists branches and commits, the apply dialog defaults to all commits and posts the unchecked subset with `confirmDrift` on the retry.

- [ ] **Step 8: Run the whole suite**

Run: `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/client.js test/client.test.js
git commit -m "feat: show auto-queue branches, commits and apply/merge in the client"
```

### Task 17: Docs, changelog and the 0.11.0 release

**Files:**
- Modify: `package.json`
- Modify: `lib/index.js`
- Modify: `lib/client.js`
- Modify: `test/client.test.js`
- Modify: `CHANGELOG.md`
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/guide.md`, `docs/guide.ru.md`, `docs/guide.zh.md` (only the paragraphs that describe auto-queue versions)
- Modify: issue #12 through the GitHub API

**Interfaces:**
- Consumes: everything built in Tasks 1–16.
- Produces: a consistent 0.11.0 version string, changelog, architecture and guides, a tagged release and an updated issue checklist.

- [ ] **Step 1: Bump the version everywhere**

Run `grep -rn "0\.10\.0" package.json lib test | head -20` and update every real version reference:

```bash
git grep -n "0\.10\.0"
```

The expected places are `package.json:3` (`"version": "0.10.0"`), the `export const version` in `lib/index.js`, `CLIENT_VERSION` in `lib/client.js`, and the version assertions in `test/client.test.js` (grep for `0.10.0`). Change each to `'0.11.0'` / `"0.11.0"`.

- [ ] **Step 2: Write the changelog and fix the section order**

In `CHANGELOG.md`, add a new section at the top:

```markdown
## [0.11.0] — 2026-11-21

The auto-queue keeps its history in a git repository owned by the app. One task
is one commit on a branch; the night shift stops being a single repeated diff.

### Added

- **Queue branches.** Every queue has a current branch and a git repository of
  its own (`<state>/repos/<projectKey>.git`); the project's own `.git` is never
  touched and non-git projects work the same way.
- **Per-task versions.** A passed task becomes its own commit with a message,
  a parent and a small reviewable diff — the run page shows that diff, not the
  whole night.
- **Apply and rebuild.** «Применить ветку» applies the whole branch in one
  action; unchecking a commit rebuilds the remaining ones on the current applied
  state. Uncommitted project changes are detected and become an explicit drift
  commit instead of being silently overwritten.
- **Branch merges.** Branches merge like git branches (`--no-ff`, merge commit),
  with a fixer agent that resolves textual conflicts before the merge commit.
- **The Orchestrator in the auto-queue.** It is a normal queue mode now: its
  plan is accepted automatically, it is seeded from the branch tip, and a failed
  check is repaired by a fixer on the assembled copy (two attempts, then park).
- **Queue UI.** The queue head shows the current branch; «Все ветки» opens a
  modal with the branch graph, commit list and apply/merge dialogs.

### Changed

- `POST /api/dsh-artel/queue` accepts `mode: "orchestrator"`; unknown modes keep
  answering `400 queue/mode-unknown`.
- The 0.8.3 disabled-Orchestrator picker entry is gone: all five modes are
  selectable.
- Legacy 0.10 queues migrate on the first pump: the saved version becomes one
  imported commit on a branch; queues with pending unsaved versions stay in
  legacy mode until those runs are dealt with.

### Fixed

- Queue versions are no longer cumulative diffs of the project: each version is
  the change of its own task, and the branch chain is what gets applied.
```

Then move the existing `## [0.9.1]` section below `## [0.10.0]` so the file is in descending version order.

- [ ] **Step 3: Update the architecture and the guides**

In `ARCHITECTURE.md`:

- Replace the auto-queue bullet around line 19 (`the Orchestrator is not a queue mode yet — the picker shows it disabled with the reason and the API refuses it with 400 queue/mode-unsupported.`) with: `the queue keeps its history in an app-owned git repository: one task becomes one commit on a branch, apply rewrites the project from the branch, and the Orchestrator is a queue mode like any other.`
- Replace the `QUEUE_MODES` / `queueModeRefusal` sentences around lines 439-441 with the branch-model description: branches live under `refs/heads/artel/<branchId>`, `refs/heads/applied` is the project's tip, and `queueModeRefusal` only rejects unknown modes.
- In the Orchestrator section, replace the closing note that it ignores `basePath` and is therefore not a queue mode with: the planner reads a read-only copy of the seed, every part copy starts from the seed, and the assembled run is committed on the branch — that is what makes it a queue mode.
- Add a short section `## Queue branches and the git core` after the auto-queue section: repo location, worktree materialisation, `apply`/`rebuild`/`merge` semantics, drift, migration and cleanup (worktrees pruned, run directories removed after their commit).

In `README.md`, update the auto-queue intro (around lines 154-159): versions are branch commits, «Применить ветку» applies the branch, «Все ветки» opens the branch modal, and the Orchestrator is selectable in the queue.

In `docs/guide.md`, `docs/guide.ru.md` and `docs/guide.zh.md`, update the sentences that describe the queue versions and the Orchestrator in the queue (grep for `Автоочередь`, `auto-queue`, `Orchestrator`, `верси`). Keep the style of each language; do not translate code identifiers.

- [ ] **Step 4: Run the whole suite one last time**

Run: `node --test test/*.test.js`
Expected: PASS. If a version assertion fails, fix the expected string instead of the source.

- [ ] **Step 5: Commit and tag**

```bash
git add package.json lib/index.js lib/client.js test/client.test.js CHANGELOG.md ARCHITECTURE.md README.md docs/guide.md docs/guide.ru.md docs/guide.zh.md
git commit -m "dsh-artel 0.11.0: git-backed queue branches and the Orchestrator in the auto-queue"
git tag v0.11.0
git push origin main
git push origin v0.11.0
```

Expected: the working tree is clean except `no-store/` and any unrelated work in progress; the tag points at the release commit. Never use `git add -A` here — stage only the paths above.

- [ ] **Step 6: Update issue #12 and verify CI**

Fetch a token without printing it and update the checklist in issue #12 (tick the completed lines; leave the 0.12.0 follow-ups unticked):

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$token = ($cred | Select-String '^password=').Line.Substring(9)
$headers = @{ Authorization = "Bearer $token"; 'User-Agent' = 'dsh-artel-release'; Accept = 'application/vnd.github+json' }
$issue = Invoke-RestMethod -Uri 'https://api.github.com/repos/ksolodev/dsh-artel/issues/12' -Headers $headers
$body = (Get-Content -Raw -LiteralPath 'no-store/issue-012-body.md')
Invoke-RestMethod -Method Patch -Uri 'https://api.github.com/repos/ksolodev/dsh-artel/issues/12' -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ body = $body } | ConvertTo-Json -Depth 4))) | Select-Object number, state
$runs = Invoke-RestMethod -Uri 'https://api.github.com/repos/ksolodev/dsh-artel/actions/runs?per_page=3' -Headers $headers
$runs.workflow_runs | Select-Object head_sha, status, conclusion, html_url
```

Expected: issue #12 shows the updated checklist, and the CI run for the release commit finishes with `conclusion: success`.

## Self-review before handing the plan over

- [x] Task 5's test now compares `run.baseHashes['src/app.js'].hash` with the `hashTree(seed)` manifest and with the real-project manifest, so it proves the isolated seed base (fixed while writing).
- [x] Grepped the plan for `TBD`, `TODO`, `similar to`, `handle edge cases`: no matches; ellipses appear only in prose, never inside code fences.
- [x] Checked interface names across tasks: `ArtelGit` methods (Tasks 1–4) are the ones `BranchService` calls (Tasks 8–11); `BranchService.apply/merge` return shapes feed `QueueRunner` and the routes (Tasks 12–14); Task 14 route paths match the Task 15 client calls; the Task 15 store methods are the ones `BranchModal` calls (Task 16); the dictionary count goes 187 → 190 (Task 15) → 212 (Task 16).
- [x] Verified the File Structure map covers every created/modified path named in the tasks (`test/git.test.js`, `test/branches.test.js`, `test/queue.test.js`, `test/queue-branches.test.js`, `test/queue-migration.test.js` are created; the rest are modifies).
- [ ] Run `git status` immediately before committing the plan: `docs/superpowers/plans/` is the only path this plan work adds. Any other modified source file in the tree belongs to unrelated work in progress — leave it alone and stage only the plan directory (`git add docs/superpowers/plans/`), never `git add -A`.
- [ ] Before implementation, re-check `git status` again: do not start a task on top of unrelated uncommitted changes; ask the user to commit or stash them first.

## Execution choice

The plan is ready. Before implementation, pick how to run it:

1. **Subagent-driven (recommended).** One fresh subagent per task, with a short review between tasks: the subagent gets only the task section, its write scope is disjoint from the others, and a reviewer checks the diff and the expected test output before the next task starts. Costs more tokens but keeps each context small and catches drift early.
2. **Inline.** Execute the tasks one by one in this session, stopping after each failing-test step if something does not match the code. Cheaper, but the whole plan then lives in one context and a mistake can poison several later tasks.

Ask the user which one they want, then start with Task 1 only.

