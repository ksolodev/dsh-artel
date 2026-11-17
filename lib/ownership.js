/**
 * Swarm ownership bookkeeping.
 *
 * In swarm mode the agents announce the files they intend to own on their first
 * (write-free) turn in a machine-readable line:
 *
 *     OWNERSHIP: src/api/**, src/lib/db.ts
 *
 * The host parses those lines, detects overlaps, hands contested paths to the
 * first claimant, and uses the resulting map both for the go-ahead prompt and
 * for flagging edits outside an agent's area in the shared feed.
 */

import { normalizeRelPath, toPosix } from './paths.js'

/** How many unclaimed files one idle agent may be handed. */
const MAX_GRANTED_FILES = 6

function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++ }
      else out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** A claim that opens with a placeholder word means "I claim nothing". */
const PLACEHOLDER_CLAIM = /^(?:none|nothing|n\/a|na|нет|никто|ничего)\b/i

/**
 * Prose that a model wrote next to its OWNERSHIP line ("verifying the whole
 * shared copy instead") is not a path. Text with whitespace but no path-ish
 * character is treated as prose; real paths keep their slashes, dots or globs.
 * @param {string} text - normalized claim candidate.
 * @returns {boolean} true when the candidate cannot be a path.
 */
function looksLikeProse(text) {
  return /\s/.test(text) && !/[./*?\\]/.test(text)
}

/**
 * Parse one claim string into { kind: 'file' | 'dir' | 'glob', path, raw, test() }.
 * Returns null for placeholders such as "none" and for prose fragments.
 */
export function parseClaim(raw) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^[-*•\s([{]+/, '').replace(/[`"'«]/g, '').replace(/[\])}.)\s]+$/, '')
  text = toPosix(text).replace(/^\.\//, '')
  if (text === '' || PLACEHOLDER_CLAIM.test(text) || looksLikeProse(text)) return null
  // An em dash is a sentence, not a path character: claims that contain one are
  // prose that leaked into the OWNERSHIP line.
  if (/[—–]/.test(text)) return null
  if (text.endsWith('/**')) {
    const base = normalizeRelPath(text.slice(0, -3))
    return { kind: 'dir', path: base, raw: text, test: (candidate) => candidate === base || candidate.startsWith(`${base}/`) }
  }
  if (text.endsWith('/')) {
    const base = normalizeRelPath(text.slice(0, -1))
    return { kind: 'dir', path: base, raw: text, test: (candidate) => candidate === base || candidate.startsWith(`${base}/`) }
  }
  if (text.includes('*') || text.includes('?')) {
    const path = text
    const regex = globToRegExp(path)
    return { kind: 'glob', path, raw: text, test: (candidate) => regex.test(candidate) }
  }
  const path = normalizeRelPath(text)
  return { kind: 'file', path, raw: text, test: (candidate) => candidate === path }
}

/** Pull every OWNERSHIP line out of a planning message and normalize the claims. */
export function parseOwnership(text) {
  const claims = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*(?:[-*]\s*)?OWNERSHIP\s*:\s*(.*)$/i.exec(line)
    if (!match) continue
    for (const piece of match[1].split(/[,;]+/)) {
      const claim = parseClaim(piece)
      if (claim && !claims.some((existing) => existing.raw === claim.raw)) claims.push(claim)
    }
  }
  return claims
}

export function claimsOverlap(a, b) {
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'file' && b.kind === 'dir') return b.test(a.path)
  if (a.kind === 'dir' && b.kind === 'file') return a.test(b.path)
  if (a.kind === 'dir' && b.kind === 'dir') {
    return a.path === b.path || a.test(b.path) || b.test(a.path)
  }
  return a.test(b.path) || b.test(a.path) || a.path === b.path
}

/**
 * Assign claims to agents in the given order; the first claimant of a path keeps
 * it, later overlapping claims become conflicts.
 *
 * Agents that end up with nothing are then handed the project files nobody
 * claimed, round-robin, so a swarm never turns three agents into one worker and
 * two bystanders. Granted claims carry `granted: true` and the same `test()`.
 *
 * @param {Array<{ id: string, name: string, claims: ReturnType<typeof parseClaim>[] }>} agents
 * @param {{ files?: string[] }} [options] - project files used to fill empty agents.
 * @returns {{ assignments: Record<string, object[]>, conflicts: Array<object>, granted: Array<object> }}
 */
export function assignOwnership(agents, options = {}) {
  const assignments = {}
  const assigned = [] // { agentId, claim }
  const conflicts = []
  for (const agent of agents) {
    assignments[agent.id] = []
    for (const claim of agent.claims) {
      const clash = assigned.find((entry) => claimsOverlap(entry.claim, claim))
      if (clash) {
        conflicts.push({
          path: claim.raw,
          claimedBy: agent.id,
          claimedByName: agent.name,
          owner: clash.agentId,
          ownerClaim: clash.claim.raw,
        })
        continue
      }
      assigned.push({ agentId: agent.id, claim })
      assignments[agent.id].push(claim)
    }
  }
  const granted = grantUnclaimed(agents, assignments, assigned, options.files)
  return { assignments, conflicts, granted }
}

/** Hand files nobody claimed to agents that claimed nothing. */
function grantUnclaimed(agents, assignments, assigned, files) {
  const granted = []
  if (!Array.isArray(files) || files.length === 0) return granted
  const needy = agents.filter((agent) => (assignments[agent.id] ?? []).length === 0)
  if (needy.length === 0) return granted
  const uncovered = []
  for (const file of [...files].sort()) {
    if (assigned.some((entry) => entry.claim.test(file))) continue
    if (uncovered.includes(file)) continue
    uncovered.push(file)
  }
  // Prefer files that live next to claimed work: an agent that kept nothing is
  // far more useful with sibling files than with an unrelated first alphabetically.
  const claimedTops = new Set()
  for (const entry of assigned) {
    const top = entry.claim.path.split('/')[0]
    if (top !== '') claimedTops.add(top)
  }
  const near = uncovered.filter((file) => claimedTops.has(file.split('/')[0]))
  const candidates = near.length > 0 ? near : uncovered
  candidates.slice(0, needy.length * MAX_GRANTED_FILES).forEach((file, index) => {
    const agent = needy[index % needy.length]
    const claim = {
      kind: 'file',
      path: file,
      raw: file,
      granted: true,
      test: (candidate) => candidate === file,
    }
    assignments[agent.id].push(claim)
    granted.push({ agentId: agent.id, name: agent.name, claim })
  })
  return granted
}

/** Which agent (if any) owns this changed path, per the assignment map. */
export function pathOwner(assignments, relPath) {
  let candidate
  try {
    candidate = normalizeRelPath(relPath)
  } catch {
    return undefined
  }
  for (const [agentId, claims] of Object.entries(assignments)) {
    if (claims.some((claim) => claim.test(candidate))) return agentId
  }
  return undefined
}

/** Human-readable ownership block for the go-ahead prompt. */
export function describeOwnership(agents, assignments) {
  return agents
    .map((agent) => {
      const claims = assignments[agent.id] ?? []
      const list = claims.length > 0
        ? claims.map((claim) => (claim.granted ? `${claim.raw} (nobody claimed it)` : claim.raw)).join(', ')
        : 'nothing (read-only help)'
      return `- ${agent.name}: ${list}`
    })
    .join('\n')
}
