/**
 * Post-apply installation for a finished run.
 *
 * Artel only writes files into the user's project: it never installs anything
 * into the running DSH profile and never runs a project's own installer. That is
 * exactly what a task like «add this capability to DSH» needs after Apply, and
 * without a hint a run ended on "Applied N file(s)" with nothing live (issue #9).
 * This module reads what a project offers once its files landed:
 *
 * - a DSH bundle, detected from `package.json` → `dsh.bundle.patch` (or a
 *   `cordis.patch.yml` at the project root), which the changes card can install
 *   through the Host plugin manager;
 * - project install steps, declared in `artel.install.json`
 *   (`{ "steps": [{ "title": "...", "command": "..." }] }`) or detected from a
 *   conventional installer script (`install/install.py`, `install.sh`, ...),
 *   which the changes card runs only after the user confirms that command.
 *
 * Everything here is read-only except `runInstallCommand`, which the engine calls
 * for exactly one declared command at a time, with the project as the working
 * directory. The user's click is the consent: a command is never run on its own.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Project-root file that declares the commands a project needs after Apply. */
export const INSTALL_MANIFEST = 'artel.install.json'

/** How many install steps one project may offer; the rest is dropped with a warning. */
export const MAX_INSTALL_STEPS = 8

/** Longest title accepted from the manifest. */
export const MAX_STEP_TITLE = 120

/** Longest command accepted from the manifest. */
export const MAX_STEP_COMMAND = 600

/** Largest manifest read; a bigger file is ignored as malformed. */
export const MAX_MANIFEST_BYTES = 64 * 1024

/** A step the user did not stop is killed after this long. */
export const INSTALL_STEP_TIMEOUT_MS = 300_000

const OUTPUT_HEAD = 6_000
const OUTPUT_TAIL = 6_000
const OUTPUT_LIMIT = OUTPUT_HEAD + OUTPUT_TAIL

/** Python executable a detected installer is launched with on this platform. */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/**
 * Conventional installer scripts, most specific first. A command is built from a
 * file that actually exists: Artel never guesses a command for a missing script.
 */
const AUTO_INSTALLERS = [
  { script: 'install/install.py', command: () => `${PYTHON} install/install.py` },
  { script: 'scripts/install.py', command: () => `${PYTHON} scripts/install.py` },
  { script: 'install.py', command: () => `${PYTHON} install.py` },
  { script: 'install/install.mjs', command: () => 'node install/install.mjs' },
  { script: 'install/install.cjs', command: () => 'node install/install.cjs' },
  { script: 'install/install.js', command: () => 'node install/install.js' },
  { script: 'scripts/install.mjs', command: () => 'node scripts/install.mjs' },
  { script: 'install.mjs', command: () => 'node install.mjs' },
  ...(process.platform === 'win32'
    ? []
    : [
      { script: 'install/install.sh', command: () => 'bash install/install.sh' },
      { script: 'install.sh', command: () => 'bash install.sh' },
    ]),
]

function messageOf(error) {
  return error instanceof Error && typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return null
  const title = value.replace(/\s+/g, ' ').trim()
  return title === '' ? null : title.slice(0, MAX_STEP_TITLE)
}

function normalizeCommand(value) {
  if (typeof value !== 'string') return null
  const command = value.trim()
  if (command === '' || command.length > MAX_STEP_COMMAND) return null
  // One shell line only: a newline would smuggle a second command past the card.
  if (/[\u0000\r\n]/.test(command)) return null
  return command
}

/**
 * Build one persisted install step.
 * @param {number} index - zero-based position.
 * @param {string} title - what the person sees.
 * @param {string} command - the shell line, run in the project root.
 * @param {'manifest' | 'detected'} origin - where the step came from.
 * @returns {object} step record.
 */
function makeStep(index, title, command, origin) {
  return {
    id: `step-${index + 1}`,
    index,
    title,
    command,
    origin,
    status: 'idle',
    output: null,
    outputTruncated: false,
    exitCode: null,
    timedOut: false,
    startedAt: null,
    finishedAt: null,
  }
}

async function readPackage(root, warnings) {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`package.json could not be read (${messageOf(error)}), so Artel cannot tell whether this is a DSH bundle.`)
    return null
  }
}

/**
 * Describe the DSH bundle a project declares, if it declares one.
 * @param {string} root - applied project root.
 * @param {object | null} pkg - parsed package.json.
 * @param {string[]} warnings - collected non-fatal problems.
 * @returns {Promise<object | null>} bundle record or null.
 */
async function detectBundle(root, pkg, warnings) {
  const declared = typeof pkg?.dsh?.bundle?.patch === 'string' && pkg.dsh.bundle.patch.trim() !== ''
    ? pkg.dsh.bundle.patch.trim()
    : null
  const hasRootPatch = await exists(path.join(root, 'cordis.patch.yml'))
  const patch = declared ?? (hasRootPatch ? 'cordis.patch.yml' : null)
  if (patch === null) return null
  const patchExists = await exists(path.join(root, patch))
  if (!patchExists) warnings.push(`The bundle patch ${patch} is declared but missing, so DSH cannot install this project.`)
  if (typeof pkg?.name !== 'string' || pkg.name.trim() === '') warnings.push('package.json has no name, so the bundle cannot be installed by name.')
  const name = typeof pkg?.name === 'string' && pkg.name.trim() !== '' ? pkg.name.trim() : path.basename(root)
  const version = typeof pkg?.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : null
  return {
    name,
    version,
    patch,
    installable: patchExists && typeof pkg?.name === 'string' && pkg.name.trim() !== '',
    status: null,
    result: null,
  }
}

/**
 * Read the project's own install manifest.
 * @param {string} root - applied project root.
 * @param {string[]} warnings - collected non-fatal problems.
 * @returns {Promise<{ steps: object[] }>} declared steps.
 */
async function readInstallManifest(root, warnings) {
  const file = path.join(root, INSTALL_MANIFEST)
  let raw
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_MANIFEST_BYTES) {
      warnings.push(`${INSTALL_MANIFEST} is larger than ${Math.round(MAX_MANIFEST_BYTES / 1024)} KB, so Artel offers no install steps.`)
      return { steps: [] }
    }
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`${INSTALL_MANIFEST} could not be read (${messageOf(error)}).`)
    return { steps: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnings.push(`${INSTALL_MANIFEST} is not valid JSON, so Artel offers no install steps.`)
    return { steps: [] }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.steps) ? parsed.steps : null
  if (list === null) {
    warnings.push(`${INSTALL_MANIFEST} has no "steps" array, so Artel offers no install steps.`)
    return { steps: [] }
  }
  const steps = []
  for (const item of list) {
    if (steps.length >= MAX_INSTALL_STEPS) {
      warnings.push(`Only the first ${MAX_INSTALL_STEPS} install steps of ${INSTALL_MANIFEST} are offered.`)
      break
    }
    const command = normalizeCommand(item?.command)
    if (command === null) {
      warnings.push(`A ${INSTALL_MANIFEST} step has no runnable "command" and was skipped.`)
      continue
    }
    const title = normalizeTitle(item?.title) ?? command
    steps.push(makeStep(steps.length, title, command, 'manifest'))
  }
  return { steps }
}

/**
 * Detect a conventional installer script the project ships.
 * @param {string} root - applied project root.
 * @returns {Promise<object[]>} detected steps.
 */
async function detectInstallSteps(root) {
  const steps = []
  for (const candidate of AUTO_INSTALLERS) {
    if (steps.length >= MAX_INSTALL_STEPS) break
    if (await exists(path.join(root, candidate.script))) {
      const title = 'Run the project installer'
      steps.push(makeStep(steps.length, title, candidate.command(), 'detected'))
    }
  }
  return steps
}

/**
 * Inspect an applied project: everything the changes card could install or run.
 *
 * Read-only and tolerant: an unreadable file becomes a warning, never a failed
 * apply. The returned record is persisted on the run as `install`.
 * @param {string} projectPath - the user's project, after the applied files landed.
 * @returns {Promise<{ detectedAt: number, bundle: object | null, steps: object[], warnings: string[] }>} install record.
 */
export async function detectInstallNeeds(projectPath) {
  const root = typeof projectPath === 'string' && projectPath !== '' ? projectPath : '.'
  const warnings = []
  const pkg = await readPackage(root, warnings)
  const bundle = await detectBundle(root, pkg, warnings)
  const manifest = await readInstallManifest(root, warnings)
  // An explicit manifest is the project's own contract: it wins over detection.
  const steps = manifest.steps.length > 0 ? manifest.steps : await detectInstallSteps(root)
  return { detectedAt: Date.now(), bundle, steps, warnings }
}

/**
 * Keep the results of steps that are still the same after a re-detection.
 *
 * A refresh must not erase "this step already ran" just because the project was
 * read again; a step whose command changed starts over.
 * @param {object | null} previous - install record stored on the run.
 * @param {object} fresh - freshly detected record.
 * @returns {object} merged record.
 */
export function mergeInstallRecord(previous, fresh) {
  const record = fresh !== null && typeof fresh === 'object'
    ? { ...fresh, steps: Array.isArray(fresh.steps) ? fresh.steps : [] }
    : { detectedAt: Date.now(), bundle: null, steps: [], warnings: [] }
  if (previous === null || typeof previous !== 'object') return record
  const before = Array.isArray(previous.steps) ? previous.steps : []
  record.steps = record.steps.map((step, index) => {
    const old = before[index]
    if (old === null || typeof old !== 'object' || old.command !== step.command) return step
    return {
      ...step,
      status: typeof old.status === 'string' ? old.status : 'idle',
      output: typeof old.output === 'string' ? old.output : null,
      outputTruncated: old.outputTruncated === true,
      exitCode: typeof old.exitCode === 'number' ? old.exitCode : null,
      timedOut: old.timedOut === true,
      startedAt: typeof old.startedAt === 'number' ? old.startedAt : null,
      finishedAt: typeof old.finishedAt === 'number' ? old.finishedAt : null,
    }
  })
  const oldBundle = previous.bundle !== null && typeof previous.bundle === 'object' ? previous.bundle : null
  if (record.bundle !== null && typeof record.bundle === 'object' && oldBundle !== null && oldBundle.patch === record.bundle.patch) {
    record.bundle = { ...record.bundle, status: oldBundle.status ?? null, result: oldBundle.result ?? null }
  }
  return record
}

/**
 * Normal reason a bundle install ended, in the Host's vocabulary.
 * @param {object | null | undefined} result - ChangeResult from the plugin manager.
 * @param {unknown} [failure] - error thrown by the plugin manager instead.
 * @returns {object} stored bundle result.
 */
export function normalizeBundleResult(result, failure = null) {
  const at = Date.now()
  if (failure !== null && failure !== undefined) {
    const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : null
    const message = messageOf(failure)
    return {
      status: code === 'already-installed' ? 'already-installed' : 'failed',
      application: null,
      restartReason: null,
      bundle: null,
      version: null,
      errorCode: code,
      errorMessage: code === 'already-installed' ? null : message,
      warnings: [],
      at,
    }
  }
  if (result === null || typeof result !== 'object') {
    return {
      status: 'failed',
      application: null,
      restartReason: null,
      bundle: null,
      version: null,
      errorCode: null,
      errorMessage: 'the plugin manager returned no result',
      warnings: [],
      at,
    }
  }
  const application = typeof result.application === 'string' ? result.application : null
  const error = result.error !== null && typeof result.error === 'object' ? result.error : null
  let status
  if (result.changed === false) status = 'already-installed'
  else if (application === 'applied') status = 'installed'
  else if (application === 'restart-required') status = 'restart-required'
  else if (application === 'overridden') status = 'overridden'
  else if (application === 'cancelled') status = 'cancelled'
  else if (result.changed === false) status = 'already-installed'
  else status = 'failed'
  if (status === 'failed' && error?.code === 'already-installed') status = 'already-installed'
  return {
    status,
    application,
    restartReason: typeof result.restartReason === 'string' ? result.restartReason : null,
    bundle: typeof result.bundle === 'string' ? result.bundle : null,
    version: typeof result.version === 'string' ? result.version : null,
    errorCode: typeof error?.code === 'string' ? error.code : null,
    errorMessage: status === 'failed'
      ? (typeof error?.diagnostic === 'string' && error.diagnostic !== ''
        ? error.diagnostic
        : typeof error?.code === 'string' ? error.code : null)
      : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning) => typeof warning === 'string') : [],
    at,
  }
}

/**
 * Whether a detected install record has something the user can act on.
 *
 * A plain project detects nothing: no bundle, no steps. Storing that empty
 * record would make every applied run carry install fields the card never shows.
 * @param {object | null | undefined} install - record from `detectInstallNeeds`.
 * @returns {boolean} true when there is a bundle to install or a step to run.
 */
export function installNeeded(install) {
  if (install === null || typeof install !== 'object') return false
  if (install.bundle !== null && typeof install.bundle === 'object') return true
  return Array.isArray(install.steps) && install.steps.length > 0
}

/**
 * One feed line telling the user what is left to do after Apply, or null when
 * the project needs nothing.
 * @param {object | null} install - detected install record.
 * @returns {string | null} status line for the run feed.
 */
export function installFeedLine(install) {
  if (install === null || typeof install !== 'object') return null
  const bundle = install.bundle !== null && typeof install.bundle === 'object'
  const steps = Array.isArray(install.steps) ? install.steps.length : 0
  const stepWord = steps === 1 ? 'step' : 'steps'
  if (bundle && steps > 0) {
    return `The files are applied. This project is a DSH bundle and offers ${steps} install ${stepWord}: the changes card installs or runs them only when you click.`
  }
  if (bundle) {
    return 'The files are applied. This project is a DSH bundle: the changes card can install it into DSH when you are ready.'
  }
  if (steps > 0) {
    return `The files are applied. This project offers ${steps} install ${stepWord}: the changes card runs them only when you click.`
  }
  return null
}

/**
 * One feed line for a finished bundle install.
 * @param {string} name - bundle name the user installed.
 * @param {object | null} result - normalized bundle result.
 * @returns {string} status line for the run feed.
 */
export function bundleResultLine(name, result) {
  const bundle = typeof name === 'string' && name !== '' ? name : 'the bundle'
  switch (result?.status) {
    case 'installed':
      return `Installed ${bundle} into DSH. It is active now.`
    case 'restart-required':
      return `Installed ${bundle} into DSH. Restart DSH to load it.`
    case 'overridden':
      return `Installed ${bundle}, but another installed plugin overrides its row, so check the plugin list.`
    case 'already-installed':
      return `${bundle} is already installed in this DSH profile, so nothing changed.`
    case 'cancelled':
      return `The install of ${bundle} was cancelled, so nothing changed.`
    default:
      return `Could not install ${bundle}${typeof result?.errorMessage === 'string' && result.errorMessage !== '' ? `: ${result.errorMessage}` : '.'}`
  }
}

/** Collect a chunk into the head/tail window and report whether it overflowed. */
function makeOutputCollector() {
  let head = ''
  let tail = ''
  let total = 0
  return {
    append(text) {
      if (typeof text !== 'string' || text === '') return
      total += text.length
      if (head.length < OUTPUT_HEAD) {
        const room = OUTPUT_HEAD - head.length
        head += text.slice(0, room)
        text = text.slice(room)
      }
      if (text !== '') tail = (tail + text).slice(-OUTPUT_TAIL)
    },
    finish() {
      const output = head + tail
      return { output: total > OUTPUT_LIMIT ? `${head}\n…\n${tail}` : output, outputTruncated: total > OUTPUT_LIMIT }
    },
  }
}

/**
 * Run exactly one declared install command in the project root.
 *
 * Called by the engine only after the user confirmed that one step in the
 * changes card. Output is bounded so a chatty installer cannot grow the run
 * record without limit.
 * @param {object} request - run request.
 * @param {string} request.command - one shell line, already validated.
 * @param {string} request.cwd - working directory, the user's project root.
 * @param {number} [request.timeoutMs] - kill the step after this long.
 * @param {Record<string, string | undefined>} [request.env] - child environment.
 * @returns {Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean, output: string, outputTruncated: boolean, durationMs: number, error: string | null }>} outcome.
 */
export function runInstallCommand({ command, cwd, timeoutMs = INSTALL_STEP_TIMEOUT_MS, env = process.env }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const collector = makeOutputCollector()
    let child
    try {
      child = spawn(String(command), [], {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...(env ?? process.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        output: messageOf(error),
        outputTruncated: false,
        durationMs: Date.now() - startedAt,
        error: messageOf(error),
      })
      return
    }
    let settled = false
    let timedOut = false
    let spawnError = null
    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const { output, outputTruncated } = collector.finish()
      resolve({
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: typeof signal === 'string' ? signal : null,
        timedOut,
        output,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        error: spawnError,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch { /* the child is already gone */ }
    }, Math.max(1_000, Number.isFinite(timeoutMs) ? timeoutMs : INSTALL_STEP_TIMEOUT_MS))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => collector.append(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => collector.append(chunk))
    child.on('error', (error) => {
      spawnError = messageOf(error)
      collector.append(spawnError)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
