/**
 * The Orchestrator run: the plan the planner writes, the verdict a reviewer
 * gives back, and the text this plugin renders for both.
 *
 * The mode itself lives in `engine.js`. Everything here is a pure function of
 * strings so it can be tested without a DSH host, without a copy of the project
 * and without any agent at all.
 */

/** Marker that starts the planner's answer. */
export const PLAN_MARKER = 'PLAN:'
/** Marker that starts one part. */
export const PART_MARKER = 'PART'
/** Marker with the goal of a part. */
export const GOAL_MARKER = 'GOAL:'
/** Marker with the completion conditions of a part. */
export const DONE_MARKER = 'DONE:'
/** Marker with the files a part starts from. */
export const FILES_MARKER = 'FILES:'
/** Marker that starts a reviewer verdict. */
export const VERDICT_MARKER = 'VERDICT:'
/** Marker with the concrete defects of a part. */
export const PROBLEMS_MARKER = 'PROBLEMS:'
/** A goal is never split into more parts than this. */
export const MAX_ORCHESTRATOR_PARTS = 4
/** A part is sent back for rework at most this many times. */
export const MAX_ORCHESTRATOR_REWORK = 2
/** Statuses a part moves through. */
export const PART_STATUSES = ['pending', 'working', 'reviewing', 'rework', 'accepted', 'failed']

const BULLET = /^(?:[>#*_-]+|\d+[.)])\s*/
const PLAN_LINE = /^PLAN\s*:/i
const PART_LINE = /^PART\s+(\d+)\b\s*[:.–—-]?\s*(.*)$/i
const GOAL_LINE = /^GOAL\s*:/i
const DONE_LINE = /^DONE\s*:/i
const FILES_LINE = /^FILES\s*:/i
const VERDICT_LINE = /^VERDICT\s*:\s*(.*)$/i
const PROBLEMS_LINE = /^PROBLEMS?\s*:\s*(.*)$/i
const ACCEPT_WORD = /^(?:accept|accepted|approve|approved|ok|okay|pass|passed|done|ship)\b/i
const REWORK_WORD = /^(?:rework|revise|redo|reject|rejected|changes?|fix|back)\b/i

/**
 * Strip the decoration a model likes to add in front of a marker line: block
 * quote arrows, list bullets, numbering and bold marker runs.
 * @param {string} line - one raw line.
 * @returns {string} the line without decoration.
 */
function undecorate(line) {
  let text = String(line ?? '').replace(/\*\*|__|`/g, '').trim()
  while (BULLET.test(text)) text = text.replace(BULLET, '').trim()
  return text
}

/**
 * Split a marker payload into separate conditions or paths.
 * @param {string} raw - payload after the marker.
 * @returns {string[]} cleaned entries.
 */
function splitList(raw) {
  return String(raw ?? '')
    .split(/[;\u2022]|(?<!\d),(?!\d)/)
    .map((part) => part.replace(BULLET, '').trim())
    .map((part) => part.replace(/^[-–—:]\s*/, '').trim())
    .filter((part) => part !== '')
}

/**
 * Normalize one condition line: drop a leading bullet or separator.
 * @param {string} raw - condition text.
 * @returns {string} cleaned condition.
 */
function cleanCondition(raw) {
  return String(raw ?? '')
    .replace(BULLET, '')
    .replace(/^[-–—:;.]+/, '')
    .trim()
}

/**
 * Give a part a display title when the planner left it empty.
 * @param {object} part - part being built.
 * @param {number} index - declared part number.
 * @returns {string} the title.
 */
function titleOf(part, index) {
  if (part.title !== '') return part.title
  if (part.goal !== '') {
    const goal = part.goal.replace(/\s+/g, ' ').trim()
    return goal.length > 60 ? `${goal.slice(0, 60)}…` : goal
  }
  return `Part ${index}`
}

/**
 * Parse the plan the planner wrote.
 *
 * The expected shape (one line per field, any order inside a part):
 *
 * ```
 * PLAN: <one sentence summary>
 * PART 1: <short title>
 * GOAL: <what this part must produce>
 * DONE: <condition>; <condition>
 * FILES: src/a.js, src/b.js
 * ```
 *
 * Everything a model adds around that shape is ignored; a plan with no parts
 * is reported as a plan with problems instead of throwing.
 * @param {string} text - the planner's answer.
 * @param {{ maxParts?: number }} [options] - hard cap on the number of parts.
 * @returns {{ summary: string, parts: object[], problems: string[], folded: number }} parsed plan.
 */
export function parsePlan(text, options = {}) {
  const maxParts = Number.isFinite(options.maxParts) ? Math.max(1, Math.floor(options.maxParts)) : MAX_ORCHESTRATOR_PARTS
  const lines = String(text ?? '').split(/\r?\n/)
  const parts = []
  let summary = ''
  let current = null
  let field = null
  let sawPart = false

  for (const raw of lines) {
    const trimmed = String(raw ?? '').trim()
    if (trimmed === '') continue
    const line = undecorate(trimmed)

    const planMatch = PLAN_LINE.exec(line)
    if (planMatch) {
      const rest = line.replace(PLAN_LINE, '').trim()
      if (rest !== '') summary = rest
      continue
    }

    const partMatch = PART_LINE.exec(line)
    if (partMatch) {
      sawPart = true
      current = {
        index: Number(partMatch[1]),
        title: cleanCondition(partMatch[2] ?? ''),
        goal: '',
        conditions: [],
        files: [],
      }
      parts.push(current)
      field = null
      continue
    }

    if (current === null) {
      // Prose before the first part is the planner thinking out loud.
      continue
    }

    if (GOAL_LINE.test(line)) {
      const rest = line.replace(GOAL_LINE, '').trim()
      if (rest !== '') current.goal = cleanCondition(rest)
      field = 'goal'
      continue
    }

    if (DONE_LINE.test(line)) {
      const rest = line.replace(DONE_LINE, '').trim()
      const entries = splitList(rest)
      if (entries.length > 0) current.conditions.push(...entries)
      field = 'done'
      continue
    }

    if (FILES_LINE.test(line)) {
      const rest = line.replace(FILES_LINE, '').trim()
      const entries = splitList(rest)
      if (entries.length > 0) current.files.push(...entries)
      field = 'files'
      continue
    }

    // A plain line inside a part continues the last open field. Prose that
    // follows a finished list (for example a closing sentence) is not a
    // condition or a path, so only list-shaped lines extend DONE and FILES.
    const continuation = cleanCondition(line)
    if (continuation === '') continue
    const listed = BULLET.test(trimmed) || /^\d+[.)]/.test(trimmed)
    if (field === 'goal') current.goal = current.goal === '' ? continuation : `${current.goal} ${continuation}`
    else if (field === 'done' && listed) current.conditions.push(continuation)
    else if (field === 'files' && listed) current.files.push(continuation)
  }

  // Fold the tail into the last kept part so a planner that wrote five parts
  // still produces a plan this plugin can run.
  let folded = 0
  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts)
    const extra = parts.slice(maxParts)
    folded = extra.length
    const last = kept[kept.length - 1]
    for (const part of extra) {
      const title = titleOf(part, part.index)
      if (part.goal !== '') last.goal = last.goal === '' ? part.goal : `${last.goal} Also: ${part.goal}`
      for (const condition of part.conditions) last.conditions.push(`${title}: ${condition}`)
      last.files.push(...part.files)
    }
    parts.splice(0, parts.length, ...kept)
  }

  const finalParts = parts.map((part, index) => {
    const conditions = [...new Set(part.conditions.map((condition) => condition.trim()).filter((condition) => condition !== ''))]
    const files = [...new Set(part.files.map((file) => file.trim()).filter((file) => file !== ''))]
    return {
      id: `p${index + 1}`,
      title: titleOf(part, part.index || index + 1),
      goal: part.goal.trim(),
      conditions,
      files,
    }
  })

  const problems = []
  if (finalParts.length === 0) {
    problems.push(sawPart ? 'the plan has no readable parts' : 'the answer has no PART lines')
  }
  finalParts.forEach((part, index) => {
    if (part.goal === '') problems.push(`part ${index + 1} has no GOAL line`)
    if (part.conditions.length === 0) problems.push(`part ${index + 1} has no DONE conditions`)
  })
  return { summary, parts: finalParts, problems, folded }
}

/**
 * Parse a reviewer verdict.
 *
 * The expected shape:
 *
 * ```
 * VERDICT: accept
 * PROBLEMS: <one concrete defect per line>
 * ```
 *
 * @param {string} text - the reviewer's answer.
 * @returns {{ verdict: 'accept' | 'rework' | 'missing', problems: string[], notes: string }} verdict.
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let verdict = 'missing'
  let notes = ''
  const problems = []
  let field = null

  for (const raw of lines) {
    const trimmed = String(raw ?? '').trim()
    if (trimmed === '') continue
    const line = undecorate(trimmed)

    const verdictMatch = VERDICT_LINE.exec(line)
    if (verdictMatch) {
      const value = String(verdictMatch[1] ?? '').trim()
      if (ACCEPT_WORD.test(value)) verdict = 'accept'
      else if (REWORK_WORD.test(value)) verdict = 'rework'
      if (verdict !== 'missing') {
        notes = value.replace(/^[A-Za-z]+\s*[:–—-]?\s*/, '').trim()
        if (notes === value) notes = ''
      }
      field = null
      continue
    }

    const problemsMatch = PROBLEMS_LINE.exec(line)
    if (problemsMatch) {
      const rest = String(problemsMatch[1] ?? '').trim()
      if (rest !== '') problems.push(cleanCondition(rest))
      field = 'problems'
      continue
    }

    const continuation = cleanCondition(line)
    if (continuation === '') continue
    if (field === 'problems') problems.push(continuation)
    else if (verdict === 'rework' && notes !== '') notes = `${notes} ${continuation}`
  }

  return {
    verdict,
    problems: [...new Set(problems.filter((problem) => problem !== ''))],
    notes,
  }
}

/**
 * Stable label for one part in the feed, prompts and the summary.
 * @param {object} part - part record.
 * @param {number} [index] - zero-based position when the record has no id yet.
 * @returns {string} label like `Part 1 — Import flow`.
 */
export function partLabel(part, index = 0) {
  const number = /^p(\d+)$/.exec(String(part?.id ?? ''))?.[1] ?? String(index + 1)
  const title = String(part?.title ?? '').trim()
  return title === '' ? `Part ${number}` : `Part ${number} — ${title}`
}

/**
 * Render the plan as the feed plan card the user sees before any agent writes.
 * @param {{ summary?: string, parts?: object[] }} plan - parsed plan.
 * @returns {string} human-readable plan text.
 */
export function planCard(plan) {
  const parts = Array.isArray(plan?.parts) ? plan.parts : []
  const answer = [String(plan?.summary ?? '').trim() !== '' ? `Plan: ${plan.summary.trim()}` : 'Plan:']

  parts.forEach((part, index) => {
    const lines = [`${index + 1}. ${String(part.title ?? '').trim() || `Part ${index + 1}`}`]
    if (String(part.goal ?? '').trim() !== '') lines.push(`   Goal: ${part.goal.trim()}`)
    const conditions = Array.isArray(part.conditions) ? part.conditions.filter((condition) => typeof condition === 'string' && condition.trim() !== '') : []
    if (conditions.length > 0) lines.push(`   Done when: ${conditions.join('; ')}`)
    const files = Array.isArray(part.files) ? part.files.filter((file) => typeof file === 'string' && file.trim() !== '') : []
    if (files.length > 0) lines.push(`   Starts from: ${files.join(', ')}`)
    answer.push('', lines.join('\n'))
  })

  return answer.join('\n').trimEnd()
}

/**
 * Render the assembled-work card once every part was accepted.
 * @param {{ parts?: object[] }} plan - accepted plan.
 * @param {{ conflicts?: number, files?: number }} [extra] - merge totals.
 * @returns {string} human-readable result text.
 */
export function assembledCard(plan, extra = {}) {
  const parts = Array.isArray(plan?.parts) ? plan.parts : []
  const files = Number.isFinite(extra.files) ? extra.files : null
  const conflicts = Number.isFinite(extra.conflicts) ? extra.conflicts : 0
  const lines = ['The parts are assembled in one copy.']
  parts.forEach((part) => {
    const mark = part.status === 'accepted' ? 'accepted' : String(part.status ?? 'pending')
    lines.push(`- ${partLabel(part)}: ${mark}`)
  })
  if (files !== null) lines.push(`Changed files: ${files}.`)
  if (conflicts > 0) lines.push(`Conflicts resolved by the merger: ${conflicts}.`)
  return lines.join('\n')
}

export default {
  PLAN_MARKER,
  PART_MARKER,
  GOAL_MARKER,
  DONE_MARKER,
  FILES_MARKER,
  VERDICT_MARKER,
  PROBLEMS_MARKER,
  MAX_ORCHESTRATOR_PARTS,
  MAX_ORCHESTRATOR_REWORK,
  PART_STATUSES,
  parsePlan,
  parseReview,
  partLabel,
  planCard,
  assembledCard,
}
