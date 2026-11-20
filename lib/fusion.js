/**
 * Pure helpers for Fusion runs.
 *
 * A Fusion run asks three independent models the same question, lets a judge
 * turn their answers into one merged decision, and hands that decision to a
 * single implementer. The host owns the sessions and the stage machine; this
 * module owns the small, testable pieces: the stage names, the marker the judge
 * ends with, the parser that separates the merged decision from that marker, and
 * the feed line a stopped agent leaves behind.
 *
 * It imports nothing (like `conductor.js`), so the behaviour is testable on its
 * own and the rest of the host can stay a thin orchestrator.
 */

/** The panel answers first, then the judge merges, then the implementer works. */
export const PANEL_STAGE = 'panel'
export const JUDGE_STAGE = 'judge'
export const WORK_STAGE = 'working'

/** A Fusion run always has three models on the panel. */
export const PANEL_SIZE = 3

/** Three panelists, one judge and one implementer share one run. */
export const FUSION_SLOT_COUNT = PANEL_SIZE + 2

/** The judge ends its answer with this line; it is a machine marker for the host. */
export const DISPUTES_MARKER = 'DISPUTES:'

const DISPUTES_LINE = /^disputes\s*:/i

/**
 * Split the judge's final answer into the merged decision and the disputed count.
 *
 * The judge is asked to end with `DISPUTES: <n>`. That line is a marker, not part
 * of the decision, so it never reaches the client: it is removed from `text` and
 * parsed into `disputes`. A malformed or missing marker simply yields `null`.
 * @param {string} text - the judge's whole final answer.
 * @returns {{ text: string, disputes: number | null }} decision and marker value.
 */
export function judgeDecision(text) {
  if (typeof text !== 'string' || text.trim() === '') return { text: '', disputes: null }
  const kept = []
  let disputes = null
  for (const line of text.split('\n')) {
    if (DISPUTES_LINE.test(line.trim())) {
      const value = Number.parseInt(line.trim().replace(DISPUTES_LINE, '').trim(), 10)
      if (Number.isSafeInteger(value) && value >= 0) disputes = value
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n').trim(), disputes }
}

/**
 * Whether the judge's answer carries a usable merged decision.
 * @param {string} text - the judge's whole final answer.
 * @returns {boolean} true when something is left after the markers are removed.
 */
export function hasDecision(text) {
  return judgeDecision(text).text !== ''
}

/**
 * The feed line for an agent that stopped during a Fusion stage.
 *
 * What happens next is different per role, so the sentence says it: a stopped
 * panelist is skipped, a stopped judge is retried once, and a stopped
 * implementer leaves whatever the copy already contains.
 * @param {string} role - `panelist`, `judge` or `implementer`.
 * @param {string} name - the agent's display name.
 * @param {string} kind - failure kind from `failureKindOf` (`error`, `max-tokens`, …).
 * @returns {string} one feed sentence.
 */
export function fusionFailureNotice(role, name, kind) {
  const stopped = `${name} stopped (${kind}).`
  if (role === 'panelist') return `${stopped} The panel continues without it.`
  if (role === 'judge') return `${stopped} Artel keeps the answers and asks the judge again.`
  return `${stopped} The copy keeps whatever was already written.`
}
