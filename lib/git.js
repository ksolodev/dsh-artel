import { execFile, spawn } from 'node:child_process'
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
}
