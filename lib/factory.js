/**
 * The Factory: a ticket board the agents keep themselves. Everything here is
 * plain data and pure string work — the pipeline itself (which agent runs when,
 * how a copy is seeded, when the repair loop stops) lives in
 * `factory-runner.js`, and the agents are ordinary Artel runs started through
 * `engine.js`.
 *
 * The module owns three things:
 *   1. the ticket and board records, including their persisted state;
 *   2. the marker parsers for the three roles the Factory calls (triage,
 *      review, app check), written to be as tolerant as `orchestrator.js`;
 *   3. the labels, templates and readiness report the server and the board
 *      share.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

import { gitProbeHint } from './git.js'

/** Marker that starts the triage summary. */
export const TRIAGE_SPEC_MARKER = 'SPEC:'
/** Marker that starts one acceptance criterion. */
export const TRIAGE_CRITERIA_MARKER = 'CRITERIA:'
/** Marker with the route the ticket should take. */
export const TRIAGE_ROUTE_MARKER = 'ROUTE:'
/** Marker with a question the user must answer before work starts. */
export const TRIAGE_QUESTION_MARKER = 'QUESTION:'
/** Marker with an assumption triage made instead of asking. */
export const TRIAGE_ASSUMPTION_MARKER = 'ASSUMPTION:'
/** Marker that starts a reviewer verdict. */
export const FACTORY_VERDICT_MARKER = 'VERDICT:'
/** Marker with a finding that stops the ticket. */
export const FACTORY_BLOCKER_MARKER = 'BLOCKER:'
/** Marker with a finding that must be fixed. */
export const FACTORY_IMPORTANT_MARKER = 'IMPORTANT:'
/** Marker with a finding that goes into the PR body only. */
export const FACTORY_MINOR_MARKER = 'MINOR:'
/** Marker with the state of one acceptance criterion. */
export const FACTORY_CRITERIA_MARKER = 'CRITERIA:'
/** Marker that starts an app check verdict. */
export const APP_CHECK_VERDICT_MARKER = 'CHECK:'

/** Every stage a ticket can stand in, in pipeline order. */
export const FACTORY_STAGES = ['incoming', 'triage', 'working', 'tests', 'check', 'review', 'ready', 'waiting', 'done']
/** Stages a ticket still moves through on its own. */
export const OPEN_STAGES = ['incoming', 'triage', 'working', 'tests', 'check', 'review']
/** Stages that are waiting for the user or finished. */
export const SETTLED_STAGES = ['ready', 'waiting', 'done']
/** What `moveTicket` allows: everything else is a bug, not a state. */
export const STAGE_TRANSITIONS = {
  incoming: ['triage', 'waiting', 'done'],
  triage: ['working', 'waiting', 'incoming', 'done'],
  working: ['tests', 'check', 'waiting', 'triage', 'done'],
  tests: ['check', 'working', 'waiting', 'done'],
  check: ['review', 'ready', 'working', 'waiting', 'done'],
  review: ['ready', 'working', 'waiting', 'done'],
  ready: ['done', 'working', 'waiting'],
  waiting: ['incoming', 'triage', 'working', 'ready', 'done'],
  done: [],
}

/** The three pipeline templates the settings offer. */
export const FACTORY_TEMPLATES = {
  normal: { id: 'normal', repairRounds: 2, appCheck: true, reviewers: 1 },
  fast: { id: 'fast', repairRounds: 1, appCheck: false, reviewers: 1 },
  strict: { id: 'strict', repairRounds: 3, appCheck: true, reviewers: 2 },
}
/** Template ids in the order the settings show them. */
export const TEMPLATE_IDS = ['normal', 'fast', 'strict']
/** Routes a ticket may take, from cheapest to most expensive. */
export const FACTORY_ROUTES = ['solo', 'swarm', 'fusion', 'orchestrator']

/** Why a ticket stands in «Ждёт вас». */
export const WAITING_KINDS = ['triage-questions', 'plan', 'repair-exhausted', 'interrupted', 'nothing-to-run', 'postponed']

/** Board columns of the full board. */
export const BOARD_COLUMNS = [
  { id: 'incoming', label: 'Входящие', stages: ['incoming'] },
  { id: 'triage', label: 'Разбор', stages: ['triage'] },
  { id: 'working', label: 'В работе', stages: ['working'] },
  { id: 'tests', label: 'Тесты', stages: ['tests'] },
  { id: 'check', label: 'Проверка', stages: ['check'] },
  { id: 'review', label: 'Ревью', stages: ['review'] },
  { id: 'ready', label: 'Готово к PR', stages: ['ready'] },
  { id: 'waiting', label: 'Ждёт вас', stages: ['waiting'] },
  { id: 'done', label: 'Готово', stages: ['done'] },
]
/** Board columns of the app board: tests, app check and review share one column. */
export const APP_BOARD_COLUMNS = [
  { id: 'incoming', label: 'Входящие', stages: ['incoming'] },
  { id: 'triage', label: 'Разбор', stages: ['triage'] },
  { id: 'working', label: 'Работа', stages: ['working'] },
  { id: 'checks', label: 'Проверки', stages: ['tests', 'check', 'review'] },
  { id: 'ready', label: 'Готово к PR', stages: ['ready'] },
  { id: 'waiting', label: 'Ждёт вас', stages: ['waiting'] },
  { id: 'done', label: 'Готово', stages: ['done'] },
]

/** Longest ticket text the board takes. */
export const MAX_TICKET_TEXT = 8000
/** Longest ticket title the board takes. */
export const MAX_TICKET_TITLE = 160
/** Most attachments one ticket can carry. */
export const MAX_TICKET_ATTACHMENTS = 8
/** Most events one board keeps for its feed. */
export const MAX_BOARD_EVENTS = 300
/** Most events one ticket keeps for its own page. */
export const MAX_TICKET_EVENTS = 120
/** How many tickets a board takes at once by default. */
export const DEFAULT_TICKETS_AT_ONCE = 1
/** How many tickets a board takes per day by default. */
export const DEFAULT_TICKETS_PER_DAY = 20

const BULLET = /^(?:[>#*_-]+|\d+[.)])\s*/
const SPEC_LINE = /^SPEC\s*[:.]?\s*(.*)$/i
const CRITERIA_LINE = /^CRITERI(?:A|ON)\s*[:.]?\s*(.*)$/i
const ROUTE_LINE = /^ROUTE\s*[:.]?\s*(.*)$/i
const QUESTION_LINE = /^QUESTION\s*[:.]?\s*(.*)$/i
const ASSUMPTION_LINE = /^ASSUMPTION\s*[:.]?\s*(.*)$/i
const VERDICT_LINE = /^VERDICT\s*[:.]?\s*(.*)$/i
const BLOCKER_LINE = /^BLOCK(?:ER|ING)\s*[:.]?\s*(.*)$/i
const IMPORTANT_LINE = /^IMPORTANT\s*[:.]?\s*(.*)$/i
const MINOR_LINE = /^MINOR\s*[:.]?\s*(.*)$/i
const FACTORY_CRITERIA_LINE = /^CRITERI(?:A|ON)\s*[:.]?\s*(.*)$/i
const CHECK_LINE = /^CHECK\s*[:.]?\s*(.*)$/i
const ACCEPT_WORD = /^(?:accept|accepted|approve|approved|ok|okay|pass|passed|ready)\b/i
const REWORK_WORD = /^(?:rework|revise|redo|reject|rejected|changes?|fix|back)\b/i
const PASS_WORD = /^(?:pass|passed|ok|okay|good|success|succeeded)\b/i
const FAIL_WORD = /^(?:fail|failed|broken|bad|error|errors)\b/i
const SKIP_WORD = /^(?:skip|skipped|n\/a|not[ -]?applicable|missing)\b/i
const MET_WORD = /^(?:met|done|passed|pass|ok|yes)\b/i
const UNMET_WORD = /^(?:unmet|not[ -]?met|missing|failed|fail|no)\b/i

/* ------------------------------------------------------------------ labels */

/**
 * Human label of one stage.
 * @param {string} stage - stage id.
 * @returns {string} label.
 */
export function stageLabel(stage) {
  switch (stage) {
    case 'incoming':
      return 'Входящие'
    case 'triage':
      return 'Разбор'
    case 'working':
      return 'В работе'
    case 'tests':
      return 'Тесты'
    case 'check':
      return 'Проверка'
    case 'review':
      return 'Ревью'
    case 'ready':
      return 'Готово к PR'
    case 'waiting':
      return 'Ждёт вас'
    case 'done':
      return 'Готово'
    default:
      return String(stage ?? '')
  }
}

/**
 * Human label of one route.
 * @param {string} route - route id.
 * @returns {string} label.
 */
export function routeLabel(route) {
  switch (route) {
    case 'solo':
      return 'Соло'
    case 'swarm':
      return 'Рой'
    case 'fusion':
      return 'Фьюжн'
    case 'orchestrator':
      return 'Дирижёр'
    default:
      return String(route ?? '')
  }
}

/**
 * Human label of one waiting reason.
 * @param {string} kind - waiting kind.
 * @returns {string} label.
 */
export function waitingLabel(kind) {
  switch (kind) {
    case 'triage-questions':
      return 'Вопросы разбора'
    case 'plan':
      return 'Ждёт согласования плана'
    case 'repair-exhausted':
      return 'Круг починки кончился'
    case 'interrupted':
      return 'Работа прервана'
    case 'nothing-to-run':
      return 'Не на чем запускать'
    case 'postponed':
      return 'Отложено вами'
    default:
      return String(kind ?? '')
  }
}

/**
 * The template record for an id, falling back to «Обычный».
 * @param {string} id - template id.
 * @returns {{ id: string, repairRounds: number, appCheck: boolean, reviewers: number }} template.
 */
export function templateOf(id) {
  return FACTORY_TEMPLATES[id] ?? FACTORY_TEMPLATES.normal
}

/**
 * The template list in settings order.
 * @returns {Array<{ id: string, repairRounds: number, appCheck: boolean, reviewers: number }>} templates.
 */
export function templateList() {
  return TEMPLATE_IDS.map((id) => FACTORY_TEMPLATES[id])
}

/**
 * One-line description of a template for the settings card.
 * @param {string} id - template id.
 * @returns {string} description.
 */
export function templateLabel(id) {
  const template = templateOf(id)
  const rounds = template.repairRounds === 1 ? '1 круг починки' : `${template.repairRounds} круга починки`
  const checks = template.appCheck ? 'тесты, проверка приложения и ревью' : 'тесты и ревью без проверки приложения'
  return `${checks}, ${rounds}`
}

/* ------------------------------------------------------------------ routes */

/**
 * Whether a value is a route the Factory understands.
 * @param {string} route - candidate.
 * @returns {boolean} true when valid.
 */
export function isRoute(route) {
  return FACTORY_ROUTES.includes(route)
}

/**
 * The cheapest route that can still do the job. The Factory may only make a
 * run cheaper (fusion → swarm → solo); Orchestrator is the user's route and is
 * never downgraded.
 * @param {string} route - requested route.
 * @returns {string} allowed route.
 */
export function cheapestRoute(route) {
  switch (route) {
    case 'fusion':
      return 'swarm'
    case 'swarm':
      return 'solo'
    case 'orchestrator':
      return 'orchestrator'
    default:
      return 'solo'
  }
}

/**
 * Pick the route a route line names, or null when it names none.
 * @param {string} raw - text after the ROUTE marker.
 * @returns {string | null} route id.
 */
export function routeOf(raw) {
  const text = String(raw ?? '').toLowerCase()
  if (/\borchestrator\b|\bдириж[её]р\b/.test(text)) return 'orchestrator'
  if (/\bfusion\b|\bфьюжн\b/.test(text)) return 'fusion'
  if (/\bswarm\b|\bрой\b/.test(text)) return 'swarm'
  if (/\bsolo\b|\bсоло\b/.test(text)) return 'solo'
  return null
}

/* --------------------------------------------------------- marker helpers */

/**
 * Strip the decoration a model likes to add in front of a marker line.
 * @param {string} line - one raw line.
 * @returns {string} undecorated line.
 */
function undecorate(line) {
  let text = String(line ?? '').replace(/\*\*|__|`/g, '').trim()
  while (BULLET.test(text)) text = text.replace(BULLET, '').trim()
  return text
}

/**
 * Split a marker payload into separate entries.
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
 * Collapse whitespace and cut a string at a length.
 * @param {string} value - input.
 * @param {number} max - maximum length.
 * @returns {string} cleaned text.
 */
export function capText(value, max = 240) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/* ----------------------------------------------------------------- triage */

/**
 * Parse the triage answer: the spec, the criteria, the route, the questions the
 * user has to answer and the assumptions triage made instead of asking.
 * @param {string} text - triage model output.
 * @returns {{ summary: string, criteria: string[], route: string | null, questions: string[], assumptions: string[] }} parsed triage.
 */
export function parseTriage(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const summary = []
  const criteria = []
  const questions = []
  const assumptions = []
  let route = null
  let section = 'spec'
  for (const raw of lines) {
    const line = undecorate(raw)
    if (line === '') {
      continue
    }
    const specMatch = SPEC_LINE.exec(line)
    if (specMatch) {
      section = 'spec'
      if (specMatch[1].trim() !== '') summary.push(specMatch[1].trim())
      continue
    }
    const criteriaMatch = CRITERIA_LINE.exec(line)
    if (criteriaMatch) {
      section = 'criteria'
      criteria.push(...splitList(criteriaMatch[1]))
      continue
    }
    const routeMatch = ROUTE_LINE.exec(line)
    if (routeMatch) {
      section = 'route'
      route = routeOf(routeMatch[1]) ?? route
      continue
    }
    const questionMatch = QUESTION_LINE.exec(line)
    if (questionMatch) {
      section = 'question'
      const entry = capText(questionMatch[1], 300)
      if (entry !== '') questions.push(entry)
      continue
    }
    const assumptionMatch = ASSUMPTION_LINE.exec(line)
    if (assumptionMatch) {
      section = 'assumption'
      const entry = capText(assumptionMatch[1], 300)
      if (entry !== '') assumptions.push(entry)
      continue
    }
    if (section === 'criteria') {
      criteria.push(...splitList(line))
    } else if (section === 'question') {
      const entry = capText(line, 300)
      if (entry !== '') questions.push(entry)
    } else if (section === 'assumption') {
      const entry = capText(line, 300)
      if (entry !== '') assumptions.push(entry)
    } else if (section === 'route') {
      route = routeOf(line) ?? route
    } else if (summary.length < 12) {
      summary.push(line)
    }
  }
  return {
    summary: capText(summary.join(' '), 1200),
    criteria: dedupe(criteria).slice(0, 8),
    route,
    questions: dedupe(questions).slice(0, 8),
    assumptions: dedupe(assumptions).slice(0, 8),
  }
}

/* ----------------------------------------------------------------- review */

/**
 * Parse a reviewer verdict: accept or rework, with the findings split by
 * severity and the state of every acceptance criterion.
 * @param {string} text - reviewer output.
 * @returns {{ verdict: 'accept' | 'rework' | 'missing', blockers: string[], important: string[], minor: string[], criteria: Array<{ text: string, met: boolean | null }>, notes: string }} parsed verdict.
 */
export function parseReview(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let verdict = null
  const blockers = []
  const important = []
  const minor = []
  const criteria = []
  const notes = []
  for (const raw of lines) {
    const line = undecorate(raw)
    if (line === '') continue
    const verdictMatch = VERDICT_LINE.exec(line)
    if (verdictMatch) {
      verdict = readVerdict(verdictMatch[1]) ?? verdict
      continue
    }
    const blockMatch = BLOCKER_LINE.exec(line)
    if (blockMatch) {
      const entry = capText(blockMatch[1], 300)
      if (entry !== '') blockers.push(entry)
      continue
    }
    const importantMatch = IMPORTANT_LINE.exec(line)
    if (importantMatch) {
      const entry = capText(importantMatch[1], 300)
      if (entry !== '') important.push(entry)
      continue
    }
    const minorMatch = MINOR_LINE.exec(line)
    if (minorMatch) {
      const entry = capText(minorMatch[1], 300)
      if (entry !== '') minor.push(entry)
      continue
    }
    const criterionMatch = FACTORY_CRITERIA_LINE.exec(line)
    if (criterionMatch) {
      criteria.push(...readCriteria(criterionMatch[1]))
      continue
    }
    if (verdict === null) {
      verdict = readVerdict(line)
      if (verdict !== null) continue
    }
    notes.push(capText(line, 240))
  }
  return {
    verdict: verdict ?? 'missing',
    blockers: dedupe(blockers).slice(0, 12),
    important: dedupe(important).slice(0, 12),
    minor: dedupe(minor).slice(0, 12),
    criteria: criteria.slice(0, 8),
    notes: capText(notes.join(' '), 600),
  }
}

/**
 * Read a verdict word out of a line.
 * @param {string} raw - line text.
 * @returns {'accept' | 'rework' | null} verdict.
 */
function readVerdict(raw) {
  const text = String(raw ?? '').trim()
  if (ACCEPT_WORD.test(text)) return 'accept'
  if (REWORK_WORD.test(text)) return 'rework'
  return null
}

/**
 * Read criterion marks like "1. met", "2. not met" or "the button works: met".
 * @param {string} raw - payload after the CRITERIA marker.
 * @returns {Array<{ text: string, met: boolean | null }>} criteria states.
 */
function readCriteria(raw) {
  return splitList(raw).map((entry) => {
    const cleaned = entry.replace(/^=?\s*/, '')
    const marked = cleaned.match(/^(.+?)\s*[:=]?\s*(met|unmet|not[ -]?met|pass(?:ed)?|fail(?:ed)?|done|missing)\s*$/i)
    if (marked) {
      const word = marked[2].toLowerCase()
      const met = MET_WORD.test(word) ? true : UNMET_WORD.test(word) ? false : null
      return { text: capText(marked[1], 300), met }
    }
    return { text: capText(cleaned, 300), met: null }
  })
}

/* ------------------------------------------------------------- app check */

/**
 * Parse the app check verdict.
 * @param {string} text - app-check model output.
 * @returns {{ verdict: 'pass' | 'fail' | 'skip' | 'missing', reason: string, findings: string[] }} parsed check.
 */
export function parseAppCheck(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  let verdict = null
  let reason = ''
  const findings = []
  for (const raw of lines) {
    const line = undecorate(raw)
    if (line === '') continue
    const checkMatch = CHECK_LINE.exec(line)
    if (checkMatch) {
      const payload = checkMatch[1].trim()
      const word = payload.toLowerCase()
      if (PASS_WORD.test(word)) verdict = 'pass'
      else if (FAIL_WORD.test(word)) verdict = 'fail'
      else if (SKIP_WORD.test(word)) verdict = 'skip'
      const rest = payload.replace(/^(?:pass(?:ed)?|fail(?:ed)?|skip(?:ped)?)\b[\s,:.-]*/i, '').trim()
      if (rest !== '') reason = capText(rest, 400)
      continue
    }
    if (verdict === null) {
      if (PASS_WORD.test(line)) {
        verdict = 'pass'
        continue
      }
      if (FAIL_WORD.test(line)) {
        verdict = 'fail'
        continue
      }
      if (SKIP_WORD.test(line)) {
        verdict = 'skip'
        continue
      }
    }
    if (/^FINDING\s*[:.]?\s*/i.test(line)) {
      findings.push(capText(line.replace(/^FINDING\s*[:.]?\s*/i, ''), 300))
      continue
    }
    if (verdict === 'skip' && reason === '') reason = capText(line, 400)
  }
  return { verdict: verdict ?? 'missing', reason, findings: dedupe(findings).slice(0, 10) }
}

/* ----------------------------------------------------------- board records */

/**
 * Remove duplicates from a list of strings, keeping the first spelling.
 * @param {string[]} values - entries.
 * @returns {string[]} unique entries.
 */
function dedupe(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const key = String(value ?? '').toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/**
 * A stable day key for the daily ticket counter.
 * @param {number} at - epoch milliseconds.
 * @returns {string} `YYYY-MM-DD` in UTC.
 */
export function dayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Shape of a ticket when it is created. The caller fills the board, the number
 * and the source; the pipeline fills everything after `incoming`.
 * @param {{ title: string, text: string, attachments?: Array<object>, source?: object, now?: number }} input - ticket fields.
 * @returns {object} a new ticket record, not yet stored.
 */
export function createTicketRecord({ title, text, attachments = [], source = null, now = Date.now() }) {
  const cleanTitle = capText(title, MAX_TICKET_TITLE)
  const cleanText = String(text ?? '').trim().slice(0, MAX_TICKET_TEXT)
  return {
    id: `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    number: 0,
    title: cleanTitle === '' ? capText(cleanText.split(/\r?\n/)[0] ?? '', MAX_TICKET_TITLE) : cleanTitle,
    text: cleanText,
    attachments: attachments.slice(0, MAX_TICKET_ATTACHMENTS),
    source: source === null || typeof source !== 'object' ? null : source,
    stage: 'incoming',
    waiting: null,
    spec: null,
    route: null,
    check: null,
    review: null,
    repairRound: 0,
    triageRunId: null,
    runId: null,
    versions: [],
    branch: null,
    pr: null,
    sessionId: null,
    events: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The board record of one project, before the readiness check runs.
 * @param {{ projectPath: string, name?: string | null, now?: number }} input - board fields.
 * @returns {object} board record, not yet stored.
 */
export function createBoardRecord({ projectPath, name = null, now = Date.now() }) {
  return {
    id: `b-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    projectPath,
    name: name === null || name === '' ? 'Проект' : capText(name, 120),
    // «Фабрика включена»: new tickets go to work by themselves.
    enabled: false,
    paused: false,
    template: 'normal',
    models: { triage: null, work: null, tests: null, review: null },
    routes: [...FACTORY_ROUTES],
    limits: {
      workersPerTicket: 1,
      ticketsAtOnce: DEFAULT_TICKETS_AT_ONCE,
      ticketsPerDay: DEFAULT_TICKETS_PER_DAY,
      allowApiEngine: true,
      allowLowSubscriptions: false,
    },
    commands: { test: '', check: '', preview: '' },
    quirks: { appendTests: false },
    trackers: [],
    readiness: null,
    counters: { day: dayKey(now), started: 0, created: 0, merged: 0 },
    ticketSeq: 0,
    tickets: [],
    eventSeq: 0,
    events: [],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The next ticket number of a board.
 * @param {object} board - board record.
 * @returns {number} the number the next ticket gets.
 */
export function nextTicketNumber(board) {
  return (board.ticketSeq ?? 0) + 1
}

/**
 * Whether a ticket is about the app interface, which is what the app check is
 * for. A backend ticket should skip it with a reason instead of failing.
 * @param {object} ticket - ticket record.
 * @returns {boolean} true when the ticket looks like UI work.
 */
export function ticketIsUi(ticket) {
  const text = `${ticket?.title ?? ''}\n${ticket?.text ?? ''}\n${ticket?.spec?.summary ?? ''}`.toLowerCase()
  return /интерфейс|экран|кнопк|страниц|форм[аыуе]?\b|вёрстк|верстк|стил(?:ь|и|ей)|тема|тёмн|темн|макет|меню|дизайн|анимаци|hover|layout|button|page|screen|form|css|design|frontend|ui\b|ux\b/.test(text)
}

/**
 * Whether the change touched any test file. «Дописывать тесты» uses it to add an
 * implementer step when the working run changed code but no test.
 * @param {object[]} changes - change entries from `lib/copy.js`.
 * @returns {boolean} true when a test file changed.
 */
export function ticketTouchedTests(changes) {
  return (Array.isArray(changes) ? changes : []).some((change) => {
    const path = String(change?.path ?? '')
    return /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) || /(^|\/)test_[^/]+\.py$/i.test(path)
  })
}

/**
 * The dedupe key of a ticket source: one tracker issue must never open twice.
 * @param {object | null} source - ticket source record.
 * @returns {string} key, or '' for a hand-written ticket.
 */
export function sourceKey(source) {
  if (source === null || typeof source !== 'object') return ''
  if (typeof source.externalId === 'string' && source.externalId !== '') return `id:${source.externalId}`
  if (typeof source.url === 'string' && source.url !== '') return `url:${source.url}`
  return ''
}

/**
 * The board a project already has, or none.
 * @param {object[]} boards - board list.
 * @param {string} projectPath - absolute project path.
 * @returns {object | undefined} board.
 */
export function boardForProject(boards, projectPath) {
  return (Array.isArray(boards) ? boards : []).find((board) => board.projectPath === projectPath)
}


/**
 * The raw ticket as one block of text: title, text, attachments and source.
 * @param {object} ticket - ticket record.
 * @returns {string} prompt-ready ticket text.
 */
export function ticketPromptText(ticket) {
  const lines = [`Ticket #${ticket.number}: ${ticket.title}`, '', ticket.text]
  if (Array.isArray(ticket.attachments) && ticket.attachments.length > 0) {
    lines.push('', 'Attachments (read them from these paths):')
    for (const attachment of ticket.attachments) {
      lines.push(`- ${attachment.path}${attachment.name && attachment.name !== attachment.path ? ` (${attachment.name})` : ''}`)
    }
  }
  if (ticket.source && ticket.source.url) lines.push('', `Source: ${ticket.source.url}`)
  if (ticket.source && ticket.source.externalId) lines.push(`Tracker id: ${ticket.source.externalId}`)
  return lines.join('\n')
}

/**
 * The acceptance criteria of a ticket, as plain lines.
 * @param {object | null} ticket - ticket record.
 * @returns {string[]} criteria lines.
 */
export function ticketCriteria(ticket) {
  const criteria = ticket?.spec?.criteria
  return Array.isArray(criteria) ? criteria.filter((entry) => typeof entry === 'string' && entry !== '') : []
}

/**
 * Record one event on a ticket (its own feed) and one on the board (the bottom
 * log). Both lists are capped; the board cap is larger.
 * @param {object} board - board record.
 * @param {object} ticket - ticket record.
 * @param {{ kind: string, text: string, at?: number, stage?: string }} event - event to record.
 * @returns {{ board: object, ticket: object }} event with its sequence numbers set.
 */
export function recordTicketEvent(board, ticket, event) {
  const at = event.at ?? Date.now()
  board.eventSeq = (board.eventSeq ?? 0) + 1
  board.events = [...(board.events ?? []), { seq: board.eventSeq, at, ticketId: ticket.id, kind: event.kind, text: capText(event.text, 400), stage: event.stage ?? ticket.stage }]
  if (board.events.length > MAX_BOARD_EVENTS) board.events = board.events.slice(-MAX_BOARD_EVENTS)
  ticket.eventSeq = (ticket.eventSeq ?? 0) + 1
  ticket.events = [...(ticket.events ?? []), { seq: ticket.eventSeq, at, kind: event.kind, text: capText(event.text, 400) }]
  if (ticket.events.length > MAX_TICKET_EVENTS) ticket.events = ticket.events.slice(-MAX_TICKET_EVENTS)
  ticket.updatedAt = at
  return { board, ticket }
}

/**
 * Record one board-level event (no single ticket): settings changes, tracker
 * polls, readiness runs. These appear in the bottom event log of the board.
 * @param {object} board - board record.
 * @param {{ kind: string, text: string, at?: number, ticketId?: string | null }} event - event to record.
 * @returns {object} the recorded event.
 */
export function recordBoardEvent(board, event) {
  const at = event.at ?? Date.now()
  board.eventSeq = (board.eventSeq ?? 0) + 1
  const recorded = { seq: board.eventSeq, at, ticketId: event.ticketId ?? null, kind: event.kind, text: capText(event.text, 400), stage: null }
  board.events = [...(board.events ?? []), recorded]
  if (board.events.length > MAX_BOARD_EVENTS) board.events = board.events.slice(-MAX_BOARD_EVENTS)
  board.updatedAt = at
  return recorded
}

/**
 * Client-facing ticket shape: everything the card and the ticket page need and
 * nothing the server only uses internally.
 * @param {object} ticket - ticket record.
 * @returns {object} ticket summary.
 */
export function ticketSummary(ticket) {
  return {
    id: ticket.id,
    boardId: ticket.boardId ?? null,
    number: ticket.number,
    title: ticket.title,
    text: ticket.text,
    stage: ticket.stage,
    waiting: ticket.waiting ?? null,
    spec: ticket.spec ?? null,
    route: ticket.route ?? null,
    check: ticket.check ?? null,
    review: ticket.review ?? null,
    repairRound: ticket.repairRound ?? 0,
    triageRunId: ticket.triageRunId ?? null,
    runId: ticket.runId ?? null,
    versions: (ticket.versions ?? []).map((version) => ({ runId: version.runId, title: version.title, changeCount: version.changeCount ?? 0, at: version.at })),
    branch: ticket.branch ?? null,
    pr: ticket.pr ?? null,
    sessionId: ticket.sessionId ?? null,
    source: ticket.source ?? null,
    attachments: ticket.attachments ?? [],
    events: (ticket.events ?? []).slice(-40),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}

/**
 * Client-facing board shape: settings, counters and the ticket list.
 * @param {object} board - board record.
 * @returns {object} board summary.
 */
export function boardSummary(board) {
  return {
    id: board.id,
    projectPath: board.projectPath,
    name: board.name,
    enabled: board.enabled === true,
    paused: board.paused === true,
    template: board.template,
    models: board.models ?? {},
    limits: board.limits ?? {},
    commands: board.commands ?? {},
    trackers: board.trackers ?? [],
    readiness: board.readiness ?? null,
    counters: board.counters ?? {},
    eventSeq: board.eventSeq ?? 0,
    events: (board.events ?? []).slice(-60),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  }
}

/* ------------------------------------------------------------- readiness */

/**
 * Turn the probes the settings card ran into the readiness report it shows.
 * A usable git binary, a project repository with a first commit and a
 * logged-in engine block enabling the board; a test command, preview and
 * Playwright only degrade the pipeline, so their absence is a warning with a
 * reason the board displays later.
 *
 * The git binary and the project repository are separate checks on purpose: a
 * machine without git must be told to install it, not to run `git init` in a
 * project that is already a repository.
 * @param {{ git: boolean | { ok?: boolean, reason?: string | null, version?: string | null }, repo: boolean, commit: boolean, engines: boolean, testCommand: boolean, preview: boolean, playwright: boolean }} probes - probe results.
 * @returns {{ ready: boolean, checks: Array<{ id: string, label: string, ok: boolean, blocking: boolean, hint: string, reason?: string | null, found?: string | null }> }} readiness.
 */
export function readinessReport(probes) {
  const git = gitProbeOf(probes?.git)
  const checks = [
    { id: 'git', label: 'Git', ok: git.ok, blocking: true, hint: gitProbeHint(git), reason: git.reason, found: git.version },
    { id: 'repo', label: 'Git repository', ok: probes?.repo === true, blocking: true, hint: git.ok ? 'The project is not a git repository: run “git init” in it, or pick another project.' : 'Git is needed before the project repository can be checked.', reason: git.ok ? null : 'no-git' },
    { id: 'commit', label: 'First commit', ok: probes?.commit === true, blocking: true, hint: 'Make at least one commit; the Factory diffs against it.' },
    { id: 'engines', label: 'Engines', ok: probes?.engines === true, blocking: true, hint: 'Log in to at least one engine in the session.' },
    { id: 'testCommand', label: 'Test command', ok: probes?.testCommand === true, blocking: false, hint: 'Tests will be skipped: set a test command in the board settings.' },
    { id: 'preview', label: 'Preview', ok: probes?.preview === true, blocking: false, hint: 'The app check will be skipped: no preview command.' },
    { id: 'playwright', label: 'Playwright', ok: probes?.playwright === true, blocking: false, hint: 'The app check will be skipped: Playwright is not installed.' },
  ]
  return { ready: checks.every((check) => !check.blocking || check.ok), checks }
}

/**
 * Read a readiness git probe: either the `probeGit` object or, for callers
 * that only know whether git answered, a boolean.
 * @param {boolean | { ok?: boolean, reason?: string | null, version?: string | null } | undefined} value - incoming probe.
 * @returns {{ ok: boolean, reason: string | null, version: string | null }} normalized probe.
 */
function gitProbeOf(value) {
  if (value !== null && typeof value === 'object') {
    const ok = value.ok === true
    return { ok, reason: ok ? null : value.reason ?? 'missing', version: typeof value.version === 'string' ? value.version : null }
  }
  const ok = value === true
  return { ok, reason: ok ? null : 'missing', version: null }
}

/**
 * Blocking readiness problems, ready for an error message.
 * @param {object | null} readiness - readiness report.
 * @returns {string[]} problems.
 */
export function readinessProblems(readiness) {
  if (readiness === null || typeof readiness !== 'object') return ['Run the readiness check first.']
  const checks = readiness.checks ?? []
  // A missing git already explains the repository check, so report one problem
  // instead of telling the user to install Git and to run `git init` at once.
  const gitFailed = checks.some((check) => check.id === 'git' && !check.ok)
  return checks.filter((check) => check.blocking && !check.ok && !(gitFailed && check.id === 'repo')).map((check) => check.hint)
}

/* ------------------------------------------------------------- PR assembly */

/**
 * Title of the pull request a ready ticket opens.
 * @param {object} ticket - ticket record.
 * @returns {string} PR title.
 */
export function prTitle(ticket) {
  return `#${ticket.number} ${ticket.title}`
}

/**
 * Body of the pull request: what was asked, how the criteria stand, what the
 * checks said and which assumptions were made.
 * @param {{ ticket: object, changeCount?: number, files?: string[], check?: object | null, review?: object | null }} input - pieces.
 * @returns {string} markdown body.
 */
export function prBody({ ticket, changeCount = 0, files = [], check = null, review = null }) {
  const lines = []
  lines.push(`Ticket #${ticket.number}: ${ticket.title}`)
  lines.push('')
  if (ticket.spec?.summary) {
    lines.push('## What was asked')
    lines.push(ticket.spec.summary)
    lines.push('')
  }
  const criteria = ticketCriteria(ticket)
  if (criteria.length > 0) {
    lines.push('## Acceptance criteria')
    const marks = new Map((review?.criteria ?? []).map((entry) => [entry.text.toLowerCase(), entry.met]))
    for (const criterion of criteria) {
      const met = marks.get(criterion.toLowerCase())
      lines.push(`- [${met === true ? 'x' : ' '}] ${criterion}`)
    }
    lines.push('')
  }
  lines.push('## Checks')
  lines.push(`- Change: ${changeCount} file${changeCount === 1 ? '' : 's'}${files.length > 0 ? ` (${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''})` : ''}`)
  if (check?.tests) {
    lines.push(`- Tests: ${check.tests.ok ? 'passed' : 'failed'}${check.tests.command ? ` (${check.tests.command})` : ''}`)
  }
  if (check?.app) {
    lines.push(`- App check: ${check.app.verdict}${check.app.reason ? ` — ${check.app.reason}` : ''}`)
  }
  if (review?.verdict) lines.push(`- Review: ${review.verdict}`)
  lines.push('')
  if (Array.isArray(ticket.spec?.assumptions) && ticket.spec.assumptions.length > 0) {
    lines.push('## Assumptions')
    for (const assumption of ticket.spec.assumptions) lines.push(`- ${assumption}`)
    lines.push('')
  }
  if (Array.isArray(review?.minor) && review.minor.length > 0) {
    lines.push('## Minor notes')
    for (const note of review.minor) lines.push(`- ${note}`)
    lines.push('')
  }
  if (ticket.source?.externalId && ticket.source.kind === 'github') {
    const ref = ticket.source.externalId.replace(/^gh:[^#]+#/, '')
    lines.push(`Closes #${ref}`)
    lines.push('')
  }
  lines.push('Opened by the Artel Factory. Nothing was merged by an agent.')
  return lines.join('\n')
}

/* ------------------------------------------------------------ validation */

/**
 * Whether a board settings patch is usable. Returns a list of problems so the
 * settings card can show them next to the fields.
 * @param {object} settings - proposed settings.
 * @returns {string[]} problems.
 */
export function settingsProblems(settings) {
  const problems = []
  if (settings.template !== undefined && !TEMPLATE_IDS.includes(settings.template)) {
    problems.push('Unknown pipeline template.')
  }
  if (settings.routes !== undefined) {
    if (!Array.isArray(settings.routes) || settings.routes.length === 0 || settings.routes.some((route) => !isRoute(route))) {
      problems.push('Allowed routes must be a non-empty list of known routes.')
    }
  }
  const limits = settings.limits
  if (limits !== undefined) {
    for (const key of ['workersPerTicket', 'ticketsAtOnce', 'ticketsPerDay']) {
      if (!Number.isInteger(limits[key]) || limits[key] < 1) problems.push(`${key} must be a positive integer.`)
    }
  }
  return problems
}

/**
 * Whether a ticket may move from one stage to another.
 * @param {string} from - current stage.
 * @param {string} to - target stage.
 * @returns {boolean} true when the move is allowed.
 */
export function canMoveStage(from, to) {
  if (from === to) return true
  return (STAGE_TRANSITIONS[from] ?? []).includes(to)
}

/* ---------------------------------------------------------------- storage */

/** The persisted ticket boards: `<stateDir>/tickets/boards.json`. */
export class TicketStore {
  #dir
  #file
  #boards = new Map()
  #queue = Promise.resolve()

  /**
   * @param {{ dir: string }} options - where the boards live.
   */
  constructor({ dir }) {
    this.#dir = dir
    this.#file = `${dir}/boards.json`
  }

  /** Read the boards from disk; missing files mean no boards yet. */
  async init() {
    this.#boards.clear()
    let raw
    try {
      raw = await readFile(this.#file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw)
    const boards = Array.isArray(parsed?.boards) ? parsed.boards : []
    this.#boards = new Map(boards.map((board) => [board.id, board]))
  }

  /**
   * All boards, newest first.
   * @returns {object[]} boards.
   */
  list() {
    return [...this.#boards.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * One board by id.
   * @param {string} boardId - board id.
   * @returns {object | undefined} board.
   */
  get(boardId) {
    return this.#boards.get(boardId)
  }

  /**
   * The board of a project, if one exists.
   * @param {string} projectPath - absolute project path.
   * @returns {object | undefined} board.
   */
  forProject(projectPath) {
    return this.list().find((board) => board.projectPath === projectPath)
  }

  /**
   * Store a new board.
   * @param {object} board - board record.
   * @returns {Promise<object>} the stored board.
   */
  async add(board) {
    this.#boards.set(board.id, board)
    await this.#persist()
    return board
  }

  /**
   * Mutation helper: runs the callback with the board and stores the result.
   * The callback receives the board (already a private copy) and returns void or
   * a replacement board.
   * @param {string} boardId - board id.
   * @param {(board: object) => void | object | Promise<void | object>} mutate - mutation.
   * @returns {Promise<object>} the stored board after the mutation.
   */
  async update(boardId, mutate) {
    const board = this.#boards.get(boardId)
    if (!board) return undefined
    const draft = structuredClone(board)
    const replaced = await mutate(draft)
    const next = replaced ?? draft
    next.updatedAt = draft.updatedAt ?? Date.now()
    this.#boards.set(boardId, next)
    await this.#persist()
    return next
  }

  /**
   * Delete a board.
   * @param {string} boardId - board id.
   * @returns {Promise<boolean>} whether a board was removed.
   */
  async remove(boardId) {
    const existed = this.#boards.delete(boardId)
    if (existed) await this.#persist()
    return existed
  }

  /** Atomically rewrite the boards file. */
  async #persist() {
    const write = async () => {
      await mkdir(this.#dir, { recursive: true })
      const payload = JSON.stringify({ version: 1, boards: [...this.#boards.values()] })
      const temp = `${this.#file}.${process.pid}.tmp`
      await writeFile(temp, payload, 'utf8')
      await rename(temp, this.#file)
    }
    // A failed write must not poison every later one: run the next write after
    // either outcome.
    this.#queue = this.#queue.then(write, write)
    return this.#queue
  }
}

export default {
  FACTORY_STAGES,
  OPEN_STAGES,
  STAGE_TRANSITIONS,
  FACTORY_TEMPLATES,
  TEMPLATE_IDS,
  FACTORY_ROUTES,
  WAITING_KINDS,
  BOARD_COLUMNS,
  APP_BOARD_COLUMNS,
  stageLabel,
  routeLabel,
  waitingLabel,
  templateOf,
  templateList,
  templateLabel,
  isRoute,
  cheapestRoute,
  routeOf,
  parseTriage,
  parseReview,
  parseAppCheck,
  dayKey,
  createTicketRecord,
  createBoardRecord,
  nextTicketNumber,
  ticketIsUi,
  ticketTouchedTests,
  sourceKey,
  boardForProject,
  ticketPromptText,
  ticketCriteria,
  recordTicketEvent,
  recordBoardEvent,
  ticketSummary,
  boardSummary,
  readinessReport,
  readinessProblems,
  prTitle,
  prBody,
  settingsProblems,
  canMoveStage,
  capText,
  TicketStore,
}
