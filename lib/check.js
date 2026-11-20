/**
 * Check commands, hygiene and outward-action scanning: the guard rails around
 * unattended work.
 *
 * Two features build on this module. The unattended auto-queue needs to run a
 * project's own checks after a run before it queues the next step; it does not
 * know the project's command, so `suggestCheckCommand` reads the manifests and
 * `runCheck` executes the answer with a hard timeout and a bounded output tail.
 * The ticket factory turns a request into a run and must not hand the user
 * anything that leaks secrets, drags build junk into the saved version, or
 * reaches the network / a remote, so `scanHygiene` reads the change set and
 * `scanOutward` reads the agent's prose, while `freeDiskBytes` keeps the queue
 * from filling the volume.
 *
 * Kept pure and injectable like the other lib modules: no state, no
 * module-level timers and no filesystem access that a caller cannot replace
 * with an injected `readFile`. Everything here is Windows-safe.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Default wall-clock limit for one check command: 15 minutes. */
export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000
/** Default number of output bytes kept from the end of a check run. */
export const MAX_CHECK_OUTPUT_BYTES = 40000

/** Marker put in front of a check output tail that had its head cut off. */
const TRIMMED_MARKER = '[… output trimmed …]'
/** Longest detail fragment a hygiene finding may carry. */
const DETAIL_MAX = 80
/** Most added text one hygiene scan reads from a single file, in characters. */
const MAX_SCAN_TEXT = 512 * 1024
/** How long to wait for a killed shell's pipes to drain before settling anyway. */
const KILL_FAILSAFE_MS = 5000

/** package.json script names to suggest, in priority order. */
const PACKAGE_SCRIPT_ORDER = ['check', 'test', 'lint', 'typecheck', 'build']
/** The test script npm writes when a package has no tests yet. */
const PLACEHOLDER_TEST = /no test specified/i
/** A Makefile `test:` target at column 0, but not a `test :=` assignment. */
const MAKE_TEST_TARGET = /^test[ \t]*:(?!=)/m

/** Extensions whose files are keys or certificates. */
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx'])
/** Basename prefixes that mark a secret file. */
const SECRET_PREFIXES = ['id_rsa', 'id_ed25519', 'secrets.']
/** Operating-system junk by exact basename (lower-case). */
const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
/** Directory names that carry dependencies or caches rather than source. */
const JUNK_SEGMENTS = new Set(['node_modules', '__pycache__', '.venv'])
/** Extensions of temporary, backup and editor leftovers. */
const JUNK_EXTENSIONS = /\.(?:log|tmp|orig|rej|swp)$/i
/** Paths that are binary and therefore not content-scanned. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf', 'zip', 'gz', 'tgz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'wasm', 'node', 'exe',
  'dll', 'so', 'dylib', 'class', 'jar', 'sqlite', 'db',
])

/**
 * Credential shapes that are secrets wherever they appear in added text.
 * `-----BEGIN` is matched without a leading word boundary: the hyphen is not a
 * word character, so a `\b` in front of it could never fire on its own line.
 */
const SECRET_TOKEN = /(?:\b(?:PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-)|-----BEGIN)/
/** `password = "…"`-style assignments to a secret keyword. */
const SECRET_ASSIGNMENT = /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i

/**
 * Outward actions worth stopping before they leave the machine. Each pattern
 * needs the whole verb phrase, so `git status`, `git commit`, `npm test`,
 * `gh issue view` and a plain `curl <url>` never match.
 */
const OUTWARD_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgh\s+pr\s+create\b/i,
  /\b(?:npm|yarn|pnpm)\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\bkubectl\s+apply\b/i,
  /\bhelm\s+upgrade\b/i,
  /\bvercel\s+deploy\b/i,
  /\bnetlify\s+deploy\b/i,
  /\bfly\s+deploy\b/i,
  /\bheroku\b/i,
  /\baws\s+s3\s+(?:cp|sync)\b/i,
  /\bgcloud\b[^\n]{0,60}?\bdeploy\b/i,
  /\bcurl\b[^\n]{0,80}?\s-X\s*POST\b/i,
]

/**
 * Suggest the project's own check command from its manifests.
 *
 * A package.json wins over every other manifest; inside it the first script in
 * priority order (`check`, `test`, `lint`, `typecheck`, `build`) is proposed,
 * except that npm's placeholder test script ("no test specified") is skipped so
 * a package without tests falls through to the next script or manifest. Without
 * a usable package.json answer the fallbacks are a Makefile with a `test:`
 * target, `Cargo.toml`, `go.mod`, then Python (`pyproject.toml`, a `tests/`
 * directory or `pytest.ini`); a requirements.txt that lists pytest is not
 * enough, because plenty of projects ship one without any tests to run.
 * @param {{ projectPath?: string, readFile?: (filePath: string) => Promise<string | Buffer> }} [options] - project root and an optional reader so tests need no disk.
 * @returns {Promise<{ command: string, source: string } | null>} the command to run and which manifest suggested it, or null when nothing was found.
 */
export async function suggestCheckCommand({ projectPath, readFile = fs.readFile } = {}) {
  const root = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (root === '') return null
  const reader = typeof readFile === 'function' ? readFile : fs.readFile
  // A tests/ probe needs a real directory. With an injected reader the caller
  // is describing a virtual project, so only manifest files are consulted.
  const canProbeDirectories = reader === fs.readFile

  const packageJson = await readText(reader, path.join(root, 'package.json'))
  if (packageJson !== null) {
    const fromScripts = packageScriptSuggestion(packageJson)
    if (fromScripts !== null) return fromScripts
  }

  const makefile = await readText(reader, path.join(root, 'Makefile'))
  if (makefile !== null && MAKE_TEST_TARGET.test(makefile)) {
    return { command: 'make test', source: 'Makefile' }
  }
  if (await fileExists(reader, path.join(root, 'Cargo.toml'))) {
    return { command: 'cargo test', source: 'Cargo.toml' }
  }
  if (await fileExists(reader, path.join(root, 'go.mod'))) {
    return { command: 'go test ./...', source: 'go.mod' }
  }
  if (await fileExists(reader, path.join(root, 'pyproject.toml'))) {
    return { command: 'pytest', source: 'pyproject.toml' }
  }
  if (canProbeDirectories && (await isDirectory(path.join(root, 'tests')))) {
    return { command: 'pytest', source: 'tests/' }
  }
  if (await fileExists(reader, path.join(root, 'pytest.ini'))) {
    return { command: 'pytest', source: 'pytest.ini' }
  }
  return null
}

/**
 * Run one shell command in a directory, capturing a bounded tail of output.
 *
 * Spawned through the platform shell (so a suggested `npm test` or `make test`
 * works as written) with a clean CI-style environment. stdout and stderr are
 * merged into one buffer; only the last `maxOutputBytes` bytes survive so a
 * chatty build cannot blow up the run record. When the timeout fires the whole
 * process tree is killed and the run still resolves with `timedOut: true`
 * rather than hanging an unattended queue. A non-zero exit is data, not an
 * error: only a spawn failure (bad cwd, no shell) rejects.
 * @param {{ command?: string, cwd?: string, timeoutMs?: number, maxOutputBytes?: number }} [options] - command line, working directory and limits.
 * @returns {Promise<{ ok: boolean, command: string, cwd: string, code: number | null, signal: string | null, timedOut: boolean, output: string, durationMs: number }>} the run result.
 */
export async function runCheck({ command, cwd, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, maxOutputBytes = MAX_CHECK_OUTPUT_BYTES } = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('runCheck needs a non-empty command')
  }
  const workdir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  const limit = byteLimit(maxOutputBytes)
  const timeout = timeoutLimit(timeoutMs)
  const startedAt = process.hrtime.bigint()

  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, {
        cwd: workdir,
        shell: true,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
        windowsHide: true,
        // On POSIX a process group lets the timeout take the shell's children
        // down too; on Windows `taskkill /T` does that job.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(error)
      return
    }

    const tail = createTailBuffer(limit)
    let timedOut = false
    let settled = false
    let timer = null
    let failSafe = null

    const finish = (code, signal, failure) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (failSafe !== null) clearTimeout(failSafe)
      if (failure) {
        reject(failure)
        return
      }
      resolve({
        ok: code === 0 && !timedOut,
        command,
        cwd: workdir,
        code: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        timedOut,
        output: tail.text(),
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
      })
    }

    child.stdout?.on('data', (chunk) => tail.push(chunk))
    child.stderr?.on('data', (chunk) => tail.push(chunk))
    // 'error' means spawn itself failed; a normal run always ends in 'close'.
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal, null))

    const onTimeout = () => {
      timedOut = true
      killChildTree(child)
      // A shell that survives the kill must not hang the queue: settle with
      // whatever was captured once the pipes had a moment to drain.
      failSafe = setTimeout(() => finish(null, 'SIGKILL', null), KILL_FAILSAFE_MS)
      failSafe.unref?.()
    }
    timer = setTimeout(onTimeout, timeout)
    timer.unref?.()
  })
}

/**
 * Scan a run's changes for secrets and junk before an unattended version is
 * saved.
 *
 * Two independent checks feed one finding list. First the path: files that are
 * secrets by name (`.env*`, keys, SSH keys, registry credentials) and files that
 * are junk (OS droppings, dependency/cache trees, logs and editor leftovers)
 * are reported without opening anything, so a binary or unreadable file is
 * still caught. Then added text: each added line is scanned for credential
 * shapes and for `password = "…"`-style assignments. Only added lines are
 * scanned, and a change flagged binary is never scanned. A newly added file
 * whose hunk carries no added text is read from `rootDir` (failure ignored) so
 * a caller that only got a stat-style change still gets content coverage.
 * Findings are deduplicated per path and kind; the detail is a short fragment,
 * never a whole line.
 * @param {{ changes?: Array<object>, rootDir?: string, readFile?: (filePath: string) => Promise<string | Buffer> }} [options] - the `lib/copy.js` change entries, the copy root and an optional reader.
 * @returns {Promise<{ findings: Array<{ path: string, kind: 'secret' | 'junk', detail: string }> }>} findings in change order.
 */
export async function scanHygiene({ changes = [], rootDir = '', readFile = fs.readFile } = {}) {
  const list = Array.isArray(changes) ? changes : []
  const reader = typeof readFile === 'function' ? readFile : fs.readFile
  const root = typeof rootDir === 'string' ? rootDir : ''
  const findings = []
  const seen = new Set()

  const addFinding = (changePath, kind, detail) => {
    const key = `${normalizeRelPath(changePath)}\u0000${kind}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ path: changePath, kind, detail })
  }

  for (const change of list) {
    if (change === null || typeof change !== 'object') continue
    const changePath = typeof change.path === 'string' ? change.path : ''
    if (changePath === '') continue

    const secretDetail = secretPathDetail(changePath)
    if (secretDetail !== null) addFinding(changePath, 'secret', secretDetail)
    const junkDetail = junkPathDetail(changePath)
    if (junkDetail !== null) addFinding(changePath, 'junk', junkDetail)

    if (change.binary === true || isBinaryPath(changePath)) continue

    const lines = addedLines(change)
    for (const line of lines) {
      const detail = secretLineDetail(line)
      if (detail !== null) addFinding(changePath, 'secret', detail)
    }
    if (lines.length === 0 && change.status === 'added' && root !== '') {
      const text = await readText(reader, path.join(root, changePath))
      if (text !== null) {
        const bounded = text.length > MAX_SCAN_TEXT ? text.slice(0, MAX_SCAN_TEXT) : text
        for (const line of bounded.split(/\r?\n/)) {
          const detail = secretLineDetail(line)
          if (detail !== null) addFinding(changePath, 'secret', detail)
        }
      }
    }
  }
  return { findings }
}

/**
 * Detect an attempt to publish or send out of the machine in agent text.
 *
 * Only whole outward verb phrases match: `git push`, `gh pr create`,
 * `npm|yarn|pnpm publish`, `docker push`, `kubectl apply`, `helm upgrade`, the
 * three `* deploy` CLIs, Heroku, `aws s3 cp|sync`, a `gcloud … deploy` and
 * `curl -X POST`. Everyday commands (`git status`, `git commit`, `npm test`,
 * `npm run build`, `gh issue view`, a plain `curl <url>`) return null.
 * @param {string} text - the agent's turn text or a proposed command line.
 * @returns {string | null} the matched phrase with a little surrounding text (at most 80 characters), or null.
 */
export function scanOutward(text) {
  const source = String(text ?? '')
  if (source === '') return null
  let best = null
  for (const pattern of OUTWARD_PATTERNS) {
    const match = pattern.exec(source)
    if (match === null) continue
    if (best === null || match.index < best.index) best = match
  }
  if (best === null) return null
  return windowAround(source, best.index, best[0].length)
}

/**
 * Free space on the volume holding dir.
 *
 * Advisory only: the queue uses it to refuse a new copy when the volume is
 * nearly full. Uses `fs.statfs` where the platform provides it and returns null
 * for any failure, so callers never need a try/catch.
 * @param {string} dir - a directory on the volume to measure.
 * @returns {Promise<number | null>} available bytes, or null when unknown.
 */
export async function freeDiskBytes(dir) {
  try {
    if (typeof fs.statfs !== 'function') return null
    const target = typeof dir === 'string' && dir !== '' ? dir : process.cwd()
    const stats = await fs.statfs(target)
    const available = Number(stats.bavail) * Number(stats.bsize)
    if (!Number.isFinite(available) || available < 0) return null
    return Math.floor(available)
  } catch {
    return null
  }
}

/* --------------------------------------------------------------- manifests */

/**
 * Pick the command a package.json's scripts block should suggest.
 * @param {string} text - package.json contents.
 * @returns {{ command: string, source: string } | null} suggestion, or null when no usable script exists.
 */
function packageScriptSuggestion(text) {
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    return null
  }
  const scripts = manifest?.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return null
  for (const name of PACKAGE_SCRIPT_ORDER) {
    const body = scripts[name]
    if (typeof body !== 'string' || body.trim() === '') continue
    if (name === 'test' && PLACEHOLDER_TEST.test(body)) continue
    return {
      command: name === 'test' ? 'npm test' : `npm run ${name}`,
      source: `package.json:${name}`,
    }
  }
  return null
}

/**
 * Read one file as text through the caller's reader.
 * @param {(filePath: string) => Promise<string | Buffer>} reader - reader to use.
 * @param {string} filePath - absolute path to read.
 * @returns {Promise<string | null>} file text, or null when it is missing or unreadable.
 */
async function readText(reader, filePath) {
  try {
    const value = await reader(filePath)
    if (value === null || value === undefined) return null
    return typeof value === 'string' ? value : String(value)
  } catch {
    return null
  }
}

/**
 * Report whether a manifest file exists, using the same reader as the content.
 * @param {(filePath: string) => Promise<string | Buffer>} reader - reader to use.
 * @param {string} filePath - absolute path to probe.
 * @returns {Promise<boolean>} true when the file could be read.
 */
async function fileExists(reader, filePath) {
  return (await readText(reader, filePath)) !== null
}

/**
 * Report whether a real directory exists; never throws.
 * @param {string} dirPath - absolute path to probe.
 * @returns {Promise<boolean>} true for an existing directory.
 */
async function isDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ checks */

/**
 * Normalise the byte budget of a run into a non-negative integer.
 * @param {unknown} value - caller's maxOutputBytes.
 * @returns {number} usable budget.
 */
function byteLimit(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return MAX_CHECK_OUTPUT_BYTES
}

/**
 * Normalise the timeout of a run into a non-negative integer of milliseconds.
 * @param {unknown} value - caller's timeoutMs.
 * @returns {number} usable timeout.
 */
function timeoutLimit(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return DEFAULT_CHECK_TIMEOUT_MS
}

/**
 * Build the bounded tail buffer one run streams its output into.
 * @param {number} limit - maximum bytes to keep from the end.
 * @returns {{ push: (chunk: unknown) => void, text: () => string }} buffer handle.
 */
function createTailBuffer(limit) {
  const chunks = []
  let bytes = 0
  let trimmed = false
  const push = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')
    if (buffer.length === 0) return
    chunks.push(buffer)
    bytes += buffer.length
    if (bytes <= limit) return
    trimmed = true
    let excess = bytes - limit
    while (excess > 0 && chunks.length > 0) {
      const first = chunks[0]
      if (first.length <= excess) {
        excess -= first.length
        bytes -= first.length
        chunks.shift()
        continue
      }
      // Drop exactly the excess, but keep the tail on a UTF-8 character
      // boundary so the first visible character is not a replacement mark.
      let cut = Math.min(excess, first.length)
      while (cut < first.length && (first[cut] & 0xc0) === 0x80) cut++
      chunks[0] = first.subarray(cut)
      bytes -= cut
      excess = 0
    }
  }
  const text = () => {
    const body = Buffer.concat(chunks).toString('utf8')
    return trimmed ? `${TRIMMED_MARKER}\n${body}` : body
  }
  return { push, text }
}

/**
 * Kill a check's whole process tree on timeout.
 * @param {import('node:child_process').ChildProcess} child - the spawned shell.
 * @returns {void}
 */
function killChildTree(child) {
  const pid = child?.pid
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform === 'win32') {
    // `taskkill /T` only finds descendants while the shell is still alive, so
    // kill the tree before touching the parent.
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return
  }
  try {
    // The detached child leads its own process group.
    process.kill(-pid, 'SIGKILL')
    return
  } catch {
    /* fall back to a direct kill below */
  }
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

/* ----------------------------------------------------------------- hygiene */

/**
 * Describe the secret-file pattern a path matches, if any.
 * @param {string} relPath - the changed file's relative path.
 * @returns {string | null} short detail for a finding, or null.
 */
function secretPathDetail(relPath) {
  const base = baseName(relPath)
  if (base === '.env' || base.startsWith('.env.')) return 'environment file'
  if (SECRET_EXTENSIONS.has(extensionOf(base))) return 'key or certificate file'
  if (base === '.npmrc' || base === '.pypirc') return 'package registry credentials'
  if (base === 'credentials.json') return 'credentials file'
  if (SECRET_PREFIXES.some((prefix) => base.startsWith(prefix))) return 'ssh or secrets file'
  return null
}

/**
 * Describe the junk-file pattern a path matches, if any.
 * @param {string} relPath - the changed file's relative path.
 * @returns {string | null} short detail for a finding, or null.
 */
function junkPathDetail(relPath) {
  const normalized = normalizeRelPath(relPath)
  const segments = normalized.split('/')
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  if (JUNK_BASENAMES.has(base)) return 'operating-system junk file'
  if (segments.some((segment) => JUNK_SEGMENTS.has(segment.toLowerCase()))) return 'dependency or cache directory'
  if (JUNK_EXTENSIONS.test(base)) return 'temporary or backup file'
  return null
}

/**
 * Report whether a path is a known binary by its extension.
 * @param {string} relPath - the changed file's relative path.
 * @returns {boolean} true when content scanning must be skipped.
 */
function isBinaryPath(relPath) {
  return BINARY_EXTENSIONS.has(extensionOf(baseName(relPath)))
}

/**
 * Collect the added lines of a change, tolerating both hunk line shapes.
 *
 * `lib/diff.js` hunks carry `{ type: '+', text }` (and `'add'`/`'ins'` from
 * other producers), while raw diff strings are prefixed with `+`. A raw `+++`
 * header is a file header, not an added line.
 * @param {object} change - one change entry.
 * @returns {string[]} added line texts, without their diff prefix.
 */
function addedLines(change) {
  const lines = []
  const hunks = Array.isArray(change?.hunks) ? change.hunks : []
  for (const hunk of hunks) {
    const hunkLines = Array.isArray(hunk?.lines) ? hunk.lines : []
    for (const line of hunkLines) {
      if (typeof line === 'string') {
        if (!line.startsWith('+') || line.startsWith('+++')) continue
        lines.push(line.slice(1))
        continue
      }
      if (line === null || typeof line !== 'object') continue
      if (line.type !== 'add' && line.type !== 'ins' && line.type !== '+') continue
      lines.push(typeof line.text === 'string' ? line.text : String(line.text ?? ''))
    }
  }
  return lines
}

/**
 * Find the first secret fragment in one added line.
 * @param {string} line - added text without its diff prefix.
 * @returns {string | null} capped matched fragment, or null.
 */
function secretLineDetail(line) {
  const text = String(line ?? '')
  if (text === '') return null
  const match = SECRET_TOKEN.exec(text) ?? SECRET_ASSIGNMENT.exec(text)
  if (match === null) return null
  // Only the matched fragment is kept: the rest of the line may hold source
  // context and the fragment is capped so a long token is never dumped whole.
  return capFragment(match[0])
}

/**
 * Collapse a fragment to one trimmed line of at most DETAIL_MAX characters.
 * @param {string} fragment - matched text.
 * @returns {string} the capped detail.
 */
function capFragment(fragment) {
  const collapsed = String(fragment ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= DETAIL_MAX) return collapsed
  return `${collapsed.slice(0, DETAIL_MAX - 1)}…`
}

/**
 * Normalise a relative path to forward slashes without a leading `./`.
 * @param {string} relPath - path as written by the caller.
 * @returns {string} normalised path.
 */
function normalizeRelPath(relPath) {
  return String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Lower-case basename of a path written with either separator.
 * @param {string} relPath - path to inspect.
 * @returns {string} lower-case basename.
 */
function baseName(relPath) {
  const normalized = normalizeRelPath(relPath)
  const slash = normalized.lastIndexOf('/')
  return (slash === -1 ? normalized : normalized.slice(slash + 1)).toLowerCase()
}

/**
 * Lower-case extension (without the dot) of a basename.
 * @param {string} base - a lower-case basename.
 * @returns {string} extension, or '' when there is none.
 */
function extensionOf(base) {
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1)
}

/* ----------------------------------------------------------------- outward */

/**
 * Cut a window of at most 80 characters around one match.
 * @param {string} text - full source text.
 * @param {number} index - match start index.
 * @param {number} length - match length.
 * @returns {string} the phrase to report.
 */
function windowAround(text, index, length) {
  const max = 80
  const half = Math.max(0, Math.floor((max - length) / 2))
  let start = Math.max(0, index - half)
  let end = Math.min(text.length, start + max)
  start = Math.max(0, end - max)
  const fragment = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const phrase = fragment === '' ? text.slice(index, index + length) : fragment
  return phrase.length <= max ? phrase : phrase.slice(0, max)
}

export default {
  suggestCheckCommand,
  runCheck,
  scanHygiene,
  scanOutward,
  freeDiskBytes,
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_OUTPUT_BYTES,
}
