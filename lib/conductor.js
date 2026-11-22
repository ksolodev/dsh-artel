/**
 * Conductor-mode bookkeeping: the pure part.
 *
 * Conductor mode puts a lead agent above a swarm: the workers propose who edits
 * what, the conductor approves or redraws the shares, and at the end it reviews
 * the whole shared copy and either accepts it or sends part of the work back
 * (at most twice). The host owns the state machine and the feeds; this module
 * only reads the machine-readable lines the conductor writes and derives the
 * few values the host feeds back into prompts and run records.
 *
 * Kept pure — no I/O and no imports — so the engine tests can exercise every
 * parser without a mounted harness.
 */

/** Address of the conductor's own agent session. */
export const CONDUCTOR_ADDRESS = 'conductor'
/** Marker of the conductor's decision: approve or hand out shares. */
export const SHARES_MARKER = 'SHARES:'
/** Marker of the conductor's final review verdict. */
export const VERDICT_MARKER = 'VERDICT:'
/** Optional marker naming the workers that must redo their share. */
export const REWORK_MARKER = 'REWORK:'
/** Hard limit on review rounds: a third rework request is coerced to accept. */
export const MAX_REWORK_ROUNDS = 2

/** A share value that means "this worker gets no files". */
const NO_SHARE = /^(?:none|nothing|—|-)$/i
/** Failure reasons the run records and displays. */
const FAILURE_KINDS = new Set(['error', 'max-tokens', 'blocked', 'aborted', 'interrupted'])
/** Words that mean "every worker" on a REWORK line. */
const EVERYONE = new Set(['all', 'everyone', '*'])
/** Lines that carry a marker but are not part of the verdict prose. */
const MARKER_LINE = /^\s*(?:[-*]\s*)?(?:VERDICT|REWORK|SHARES|OWNERSHIP)\s*:/i

/**
 * Parse the conductor's SHARES decision out of one turn of text.
 *
 * Every `SHARES:` line is either the whole approval form
 *
 *     SHARES: approve
 *
 * or one worker's share:
 *
 *     SHARES: Iris = src/api/**, src/types.ts
 *     SHARES: Juno = none
 *
 * Unknown names are reported separately and never become entries; a duplicate
 * worker keeps the last line; `= none` (or nothing/nothing at all) closes the
 * share. When no SHARES line is present the turn is `missing` and the host asks
 * again.
 * @param {string} text - the conductor's turn text.
 * @param {string[]} workerNames - worker display names the conductor may assign.
 * @returns {{ mode: 'approve' | 'assign' | 'missing', entries: Array<{ name: string, paths: string[] }>, unknown: string[] }} parsed decision.
 */
export function parseShares(text, workerNames) {
  const workers = (Array.isArray(workerNames) ? workerNames : []).filter((name) => typeof name === 'string' && name !== '')
  const entries = []
  const unknown = []
  let approved = false
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?SHARES\s*:\s*(.*)$/i.exec(line)
    if (!match) continue
    const value = match[1].trim()
    if (value === '') continue
    if (value.toLowerCase() === 'approve') {
      approved = true
      continue
    }
    const separator = value.indexOf('=')
    const rawName = (separator === -1 ? value : value.slice(0, separator)).trim()
    const rawPaths = separator === -1 ? '' : value.slice(separator + 1)
    if (rawName === '') continue
    const worker = workers.find((name) => name.toLowerCase() === rawName.toLowerCase())
    if (worker === undefined) {
      unknown.push(rawName)
      continue
    }
    const paths = rawPaths
      .split(/[,;]+/)
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '' && !NO_SHARE.test(piece))
    // The later line for the same worker wins; keep the latest order.
    const previous = entries.findIndex((entry) => entry.name === worker)
    if (previous !== -1) entries.splice(previous, 1)
    entries.push({ name: worker, paths })
  }
  if (entries.length > 0) return { mode: 'assign', entries, unknown }
  if (approved) return { mode: 'approve', entries: [], unknown: [] }
  return { mode: 'missing', entries: [], unknown: [] }
}

/**
 * Parse the conductor's review verdict out of one turn of text.
 *
 * The last `VERDICT:` line is the decision:
 *
 *     VERDICT: accept — the checks pass and every requirement is covered
 *     VERDICT: rework — the API branch still returns the old error
 *     REWORK: Iris, Juno
 *
 * Notes are the rest of the verdict line; when the conductor put them on the
 * lines below instead, the prose after the verdict line is joined and capped.
 * With a rework verdict the optional REWORK line names the workers that must go
 * back to work; `all`, `everyone` or `*` (or no names) means the whole team.
 * @param {string} text - the conductor's turn text.
 * @returns {{ verdict: 'accept' | 'rework' | 'missing', notes: string, reworkNames: string[] }} parsed verdict.
 */
export function parseVerdict(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let verdict = 'missing'
  let notes = ''
  let markerIndex = -1
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*(?:[-*]\s*)?VERDICT\s*:\s*(.*)$/i.exec(lines[index])
    if (!match) continue
    markerIndex = index
    const value = match[1].trim()
    const keyword = /^(accept|rework)\b/i.exec(value)
    if (keyword === null) continue
    verdict = keyword[1].toLowerCase()
    notes = value.slice(keyword[0].length).replace(/^[\s\-—–:,.]+/, '').trim()
  }
  if (verdict === 'missing') return { verdict, notes: '', reworkNames: [] }
  if (notes === '' && markerIndex !== -1) {
    const tail = lines
      .slice(markerIndex + 1)
      .filter((line) => !MARKER_LINE.test(line))
      .map((line) => line.trim())
      .filter((line) => line !== '')
    notes = tail.join(' ')
  }
  const reworkNames = verdict === 'rework' ? parseReworkNames(lines) : []
  return { verdict, notes: capText(notes), reworkNames }
}

/**
 * Read the last REWORK line into the list of workers sent back to work.
 * @param {string[]} lines - the conductor's lines.
 * @returns {string[]} worker names as written, or [] for "everyone".
 */
function parseReworkNames(lines) {
  let value = ''
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?REWORK\s*:\s*(.*)$/i.exec(line)
    if (match) value = match[1].trim()
  }
  if (value === '') return []
  const names = value
    .split(/[,;]+/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (names.some((name) => EVERYONE.has(name.toLowerCase()))) return []
  return names
}

/**
 * Normalise one agent turn's failure reason into the kind the run shows.
 *
 * The host records `{ kind }` on a turn end when the agent did not finish its
 * turn normally; only the reasons the product understands are reported, anything
 * else means "this turn ended fine".
 * @param {unknown} reason - `event.reason` from a turn-end event.
 * @returns {'error' | 'max-tokens' | 'blocked' | 'aborted' | 'interrupted' | null} known failure kind, or null.
 */
export function failureKindOf(reason) {
  const kind = reason?.kind
  return typeof kind === 'string' && FAILURE_KINDS.has(kind) ? kind : null
}

/**
 * Pull the provider's own words out of a turn-end failure reason.
 *
 * `failureKindOf` only says *that* the turn failed; the host also keeps the
 * `LlmFailure` in `reason.error` (`{ message, code }`). Repeating that text in
 * the feed is the difference between "Vega stopped (error)" and "Vega stopped
 * (error): 403 Forbidden [provider/forbidden]", so the user can tell a dead
 * provider route from a bug in Artel.
 * @param {unknown} reason - `event.reason` from a turn-end event.
 * @returns {string} one-line detail, or '' when the reason carries none.
 */
export function failureDetailOf(reason) {
  const failure = reason?.error
  if (typeof failure === 'string') return failure.trim().slice(0, 300)
  if (failure === null || typeof failure !== 'object') return ''
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  const code = typeof failure.code === 'string' ? failure.code.trim() : ''
  const parts = []
  if (message !== '') parts.push(message)
  if (code !== '' && !message.includes(code)) parts.push(`[${code}]`)
  return parts.join(' ').slice(0, 300)
}

/**
 * One readable block describing the whole copy's changes for the review prompt.
 *
 * Each changed file becomes a line with its status and, for text files, the
 * added/removed line counts; binary files are marked as such. A long change set
 * is truncated with a count of the files left out, so the prompt stays below the
 * model's attention budget while still telling it how much it has not seen.
 * @param {Array<{ path?: string, status?: string, added?: number, removed?: number, binary?: boolean }>} changes - `engine.changes()` entries.
 * @param {{ maxFiles?: number }} [options] - truncation limit (default 40 files).
 * @returns {string} digest lines, or '' when nothing changed.
 */
export function changeDigest(changes, options = {}) {
  const list = Array.isArray(changes) ? changes : []
  if (list.length === 0) return ''
  const requested = options?.maxFiles
  const maxFiles = typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? Math.floor(requested)
    : 40
  const shown = list.slice(0, maxFiles)
  const lines = shown.map((change) => {
    const path = typeof change?.path === 'string' ? change.path : String(change?.path ?? '')
    if (change?.binary === true) return `- binary ${path}`
    const status = typeof change?.status === 'string' && change.status !== '' ? change.status : 'modified'
    const counts = typeof change?.added === 'number' && typeof change?.removed === 'number'
      ? ` (+${change.added}/-${change.removed})`
      : ''
    return `- ${status} ${path}${counts}`
  })
  const omitted = list.length - shown.length
  if (omitted > 0) lines.push(`… and ${omitted} more file(s)`)
  return lines.join('\n')
}

/**
 * Pick the alive worker carrying the fewest shares.
 *
 * Used when the conductor does not answer a handover: the failed share goes to
 * the worker with the fewest claims, ties broken by the team order so the same
 * run always makes the same choice.
 * @param {Record<string, Array<unknown>>} assignments - claims per worker display name.
 * @param {string[]} aliveNames - workers that can still take work.
 * @param {string[]} [order] - preferred order of the alive workers (team order).
 * @returns {string | null} the chosen display name, or null when no worker is alive.
 */
export function leastLoadedName(assignments, aliveNames, order) {
  const alive = (Array.isArray(aliveNames) ? aliveNames : []).filter((name) => typeof name === 'string' && name !== '')
  if (alive.length === 0) return null
  const ranking = Array.isArray(order) ? order : []
  const rank = (name) => {
    const index = ranking.indexOf(name)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  // Stable sort keeps the given alive order for workers the ranking omits.
  const ordered = [...alive].sort((left, right) => rank(left) - rank(right))
  let chosen = null
  let fewest = Number.POSITIVE_INFINITY
  for (const name of ordered) {
    const claims = assignments?.[name]
    const count = Array.isArray(claims) ? claims.length : 0
    if (count < fewest) {
      fewest = count
      chosen = name
    }
  }
  return chosen
}

/**
 * Collapse a free-text block into one trimmed line, capped for a prompt.
 * @param {string} text - text to cap.
 * @param {number} [max] - maximum characters before the ellipsis.
 * @returns {string} single-line capped text.
 */
export function capText(text, max = 1200) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : 1200
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}…`
}
