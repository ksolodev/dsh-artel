import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The oldest git Artel supports: worktrees, update-ref CAS and porcelain v1 -z. */
export const MIN_GIT_VERSION = '2.30.0'

/** Where a machine without a usable git gets one. */
export const GIT_INSTALL_URL = 'https://git-scm.com/downloads'

/** A git failure the plugin can explain to the client. */
export class GitError extends Error {
  constructor(message, { code = 'artel/git-failed', stderr = '', args = [], exitCode = null, details = null } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.stderr = stderr
    this.args = args
    this.exitCode = exitCode
    this.details = details
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
 * Render a byte count as a short, human-readable size.
 * @param {number} bytes - byte count.
 * @returns {string} size such as '0 B', '1.5 KiB' or '2.0 GiB'.
 */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.trunc(value)} B`
  const units = ['KiB', 'MiB', 'GiB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(1)} ${units[unit]}`
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
 * Look for a usable git binary without throwing. The startup notice and the
 * Factory readiness card need a verdict, not an exception.
 * @param {{ runner?: () => Promise<{ stdout: string, stderr: string }> }} [options] - injectable runner for tests.
 * @returns {Promise<{ ok: boolean, version: string | null, minimum: string, reason: 'missing' | 'old' | 'unreadable' | null, detail: string }>} probe result.
 */
export async function probeGit({ runner = null } = {}) {
  let stdout
  try {
    const result = runner === null ? await execFileAsync('git', ['--version'], { windowsHide: true }) : await runner()
    stdout = String(result.stdout ?? '')
  } catch (error) {
    return { ok: false, version: null, minimum: MIN_GIT_VERSION, reason: 'missing', detail: String(error?.message ?? error) }
  }
  const version = parseGitVersion(stdout)
  if (version === null) return { ok: false, version: null, minimum: MIN_GIT_VERSION, reason: 'unreadable', detail: stdout.trim() }
  if (compareVersions(version, MIN_GIT_VERSION) < 0) return { ok: false, version, minimum: MIN_GIT_VERSION, reason: 'old', detail: stdout.trim() }
  return { ok: true, version, minimum: MIN_GIT_VERSION, reason: null, detail: '' }
}

/**
 * Word a failed git probe for a log line or a readiness hint.
 * @param {{ reason?: string | null, version?: string | null }} probe - probe result.
 * @returns {string} English explanation; empty for a usable git.
 */
export function gitProbeHint(probe) {
  switch (probe?.reason) {
    case 'missing':
      return `Artel needs the git command line tool ${MIN_GIT_VERSION} or newer. Install Git from ${GIT_INSTALL_URL} and restart the session.`
    case 'old':
      return `Artel needs git ${MIN_GIT_VERSION} or newer; this machine has ${probe.version ?? 'an older one'}. Upgrade Git and restart the session.`
    case 'unreadable':
      return 'Could not read the git version from “git --version”. Check that the command works, then restart the session.'
    default:
      return ''
  }
}

/**
 * Ensure a usable git binary, once per process.
 * @param {{ runner?: () => Promise<{ stdout: string, stderr: string }> }} [options] - injectable runner for tests.
 * @returns {Promise<{ version: string }>} detected version.
 */
export async function requireGit({ runner = null } = {}) {
  if (runner === null && cachedGit !== null) return cachedGit
  const probe = await probeGit({ runner })
  const details = { reason: probe.reason, found: probe.version, minimum: probe.minimum, installUrl: GIT_INSTALL_URL }
  if (probe.reason === 'missing') {
    throw new GitError(`Artel needs the git command line tool (${MIN_GIT_VERSION} or newer) to keep queue versions. Install Git from ${GIT_INSTALL_URL} and restart the session.`, {
      code: 'artel/git-missing',
      stderr: probe.detail,
      details,
    })
  }
  if (probe.reason === 'unreadable') {
    throw new GitError(`Could not read the git version from: ${probe.detail}`, { code: 'artel/git-missing', details })
  }
  if (probe.reason === 'old') {
    throw new GitError(`Artel needs git ${MIN_GIT_VERSION} or newer; this machine has ${probe.version}. Upgrade Git and restart the session.`, { code: 'artel/git-missing', details })
  }
  const result = { version: probe.version }
  if (runner === null) cachedGit = result
  return result
}

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

/** The only ref namespace an export may write in the user's repository. */
const EXPORT_TARGET_PATTERN = /^refs\/heads\/artel\/[A-Za-z0-9._/-]+$/

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

/** @param {Buffer} buffer - output to split. @returns {string[]} NUL-separated tokens. */
function splitZ(buffer) {
  return buffer.toString('utf8').split('\0').filter((part) => part !== '')
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
    await git.exec(['config', 'core.worktree', path.resolve(projectPath)], { cwd: repoDir })
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
        reject(new GitError(`git ${args[0] ?? ''} could not start: ${error.message}`, {
          code: 'artel/git-missing',
          args,
          stderr: error.message,
          details: { reason: 'missing', found: null, minimum: MIN_GIT_VERSION, installUrl: GIT_INSTALL_URL },
        }))
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
   * The user's own git work tree, when the project lives inside one.
   * Reads only; it never creates a repository or a `.git` directory.
   * @returns {Promise<string | null>} absolute work tree root, or null.
   */
  async userRepoRoot() {
    const result = await this.exec(['rev-parse', '--show-toplevel'], { cwd: this.projectPath, allowNonZero: true })
    if (result.exitCode !== 0) return null
    const root = result.stdout.toString('utf8').trim()
    return root === '' ? null : root
  }

  /** @param {string} name - ref in the user's repository. @returns {Promise<string>} commit, or '' when missing. */
  async #userRef(name) {
    const result = await this.exec(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: this.projectPath, allowNonZero: true })
    return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : ''
  }

  /**
   * Import one queue branch into the user's own repository as a ref.
   *
   * Only `refs/heads/artel/*` may be written and updates are never forced, so
   * an export cannot touch the user's work tree or HEAD and cannot overwrite
   * their branches. A fast-forward re-export is allowed.
   * @param {{ sourceRef: string, targetRef: string }} options - app ref to copy and target ref.
   * @returns {Promise<{ target: string, commit: string }>} target ref and commit.
   */
  async exportRefToUserRepo({ sourceRef, targetRef }) {
    if (typeof targetRef !== 'string' || !EXPORT_TARGET_PATTERN.test(targetRef) || targetRef.includes('..') || targetRef.endsWith('.lock')) {
      throw new GitError(`Refusing to export to ${typeof targetRef === 'string' ? targetRef : String(targetRef)}: export targets must stay inside refs/heads/artel/.`, { code: 'artel/bad-request', args: ['fetch'] })
    }
    if (await this.userRepoRoot() === null) {
      throw new GitError('The project is not inside a git work tree, so there is no user repository to export into.', { code: 'artel/not-a-git-project', args: ['fetch'] })
    }
    const commit = await this.ref(sourceRef)
    if (commit === null) {
      throw new GitError(`Queue branch ${sourceRef} does not exist, so there is nothing to export.`, { code: 'artel/export-missing', args: ['fetch', sourceRef] })
    }
    const args = ['fetch', '--no-tags', '--no-write-fetch-head', this.repoDir, `${sourceRef}:${targetRef}`]
    try {
      await this.exec(args, { cwd: this.projectPath })
    } catch (error) {
      const stderr = error instanceof GitError ? error.stderr : String(error?.message ?? error)
      const errorArgs = error instanceof GitError ? error.args : args
      const exitCode = error instanceof GitError ? error.exitCode : null
      if (await this.#userRef(targetRef) !== '') {
        throw new GitError(`Ref ${targetRef} already exists in the user repository and this export is not a fast-forward. Pick another target.`, { code: 'artel/export-exists', stderr, args: errorArgs, exitCode })
      }
      throw new GitError(`Export to ${targetRef} failed: ${stderr || 'git fetch failed'}`, { code: 'artel/export-failed', stderr, args: errorArgs, exitCode })
    }
    if (await this.#userRef(targetRef) !== commit) {
      throw new GitError(`Export to ${targetRef} did not land on ${commit}.`, { code: 'artel/export-failed', args })
    }
    return { target: targetRef, commit }
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

  /**
   * Snapshot the project as the first commit of the applied ref.
   *
   * Deviation from the plan's task split: the Task 2 ref test already calls
   * this method, so it (and its helper) moved here from Task 3.
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

  /**
   * Write a commit for an existing tree, optionally on top of a parent.
   * @param {string} treeish - commit or tree to reuse.
   * @param {{ parent?: string | null, message: string }} options - parent and commit message.
   * @returns {Promise<string>} new commit.
   */
  async commitTree(treeish, { parent = null, message }) {
    const tree = (await this.exec(['rev-parse', '--verify', `${treeish}^{tree}`], { cwd: this.repoDir })).stdout.toString('utf8').trim()
    const args = ['commit-tree', tree, '-m', message]
    if (parent !== null) args.push('-p', parent)
    return (await this.exec(args, { cwd: this.repoDir })).stdout.toString('utf8').trim()
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
   * Object accounting for the app repository, used by the maintenance dialog.
   * @returns {Promise<{ objects: number, sizeBytes: number, sizeText: string }>} object count and size.
   */
  async countObjects() {
    const output = (await this.exec(['count-objects', '-v'], { cwd: this.repoDir })).stdout.toString('utf8')
    const numbers = new Map()
    for (const line of output.split('\n')) {
      const match = /^(count|in-pack|size|size-pack):\s*(\d+)$/.exec(line.trim())
      if (match !== null) numbers.set(match[1], Number(match[2]))
    }
    const objects = (numbers.get('count') ?? 0) + (numbers.get('in-pack') ?? 0)
    const sizeBytes = ((numbers.get('size') ?? 0) + (numbers.get('size-pack') ?? 0)) * 1024
    return { objects, sizeBytes, sizeText: formatBytes(sizeBytes) }
  }

  /**
   * Compact the app repository.
   * @param {{ pruneNow?: boolean }} [options] - prune unreachable objects immediately.
   * @returns {Promise<void>} completes when git gc finished.
   */
  async gc({ pruneNow = false } = {}) {
    const args = ['gc', '--quiet']
    if (pruneNow) args.push('--prune=now')
    await this.exec(args, { cwd: this.repoDir })
  }

  /** @returns {Promise<void>} completes when the best-effort auto gc finished. */
  async gcAuto() {
    try {
      await this.exec(['gc', '--auto', '--quiet'], { cwd: this.repoDir, allowNonZero: true })
    } catch {
      // Auto gc is housekeeping: it must never fail a user action.
    }
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
   *
   * Deviation from the plan: the plan passed `cwd: this.projectPath`, but
   * `exec()` drops the app env whenever a cwd is given, so git would search
   * from the project dir and never find the app repository. Running without
   * cwd keeps `GIT_DIR`/`GIT_WORK_TREE` (the repository's work tree is the
   * project), which is exactly what the repo's index and status need.
   * @returns {Promise<{ path: string, status: string }[]>} changed and untracked paths.
   */
  async status() {
    if (await this.head() === null) return []
    await this.exec(['read-tree', 'HEAD'], { allowNonZero: true })
    const tokens = splitZ((await this.exec(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowNonZero: true })).stdout)
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

  /** @param {string} dir - worktree. @returns {Promise<string[]>} conflicted paths. */
  async unmergedPaths(dir) {
    const tokens = splitZ((await this.exec(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: dir, allowNonZero: true })).stdout)
    return tokens.map((relPath) => relPath.trim()).filter((relPath) => relPath !== '')
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
    const mergeHead = await this.exec(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: dir, allowNonZero: true })
      .then((result) => result.stdout.toString('utf8').trim())
      .catch(() => '')
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
}
