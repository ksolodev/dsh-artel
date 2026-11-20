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
