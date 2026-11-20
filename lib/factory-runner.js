import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as checkModule from './check.js'
import * as trackerModule from './trackers.js'
import { changeDigest } from './conductor.js'
import {
  autoAnswerPrompt,
  checkRepairPrompt,
  factoryAppCheckPrompt,
  factoryRepairPrompt,
  factoryReviewPrompt,
  factoryWorkPrompt,
  triagePrompt,
} from './prompts.js'
import {
  FACTORY_ROUTES,
  MAX_TICKET_ATTACHMENTS,
  boardSummary,
  createBoardRecord,
  createTicketRecord,
  dayKey,
  isRoute,
  nextTicketNumber,
  parseAppCheck,
  parseReview,
  parseTriage,
  prBody,
  prTitle,
  readinessProblems,
  readinessReport,
  recordBoardEvent,
  recordTicketEvent,
  routeLabel,
  settingsProblems,
  sourceKey,
  templateOf,
  ticketCriteria,
  ticketIsUi,
  ticketSummary,
  ticketTouchedTests,
  waitingLabel,
} from './factory.js'

/** Timing and size limits of the ticket pipeline. */
export const FACTORY_TUNING = {
  /** How often each board pump looks at its runs and tickets. */
  pollMs: 1000,
  /** Tracker polling interval: every five minutes, as the spec says. */
  trackerPollMs: 5 * 60 * 1000,
  /** The pipeline's own check/test commands never run forever. */
  checkTimeoutMs: 15 * 60 * 1000,
  /** Git and `gh` calls are shorter: they either answer or fail. */
  execTimeoutMs: 30 * 1000,
  /** How much check output the ticket keeps and the repair prompt reads. */
  maxOutputBytes: 40 * 1000,
  /** Attachment limit: one screenshot or log file, not a repository dump. */
  maxAttachmentBytes: 5 * 1024 * 1024,
}

/** The stages during which a ticket occupies a worker slot. */
const PIPELINE_STAGES = new Set(['triage', 'working', 'tests', 'check', 'review'])

/** Runs that are still doing something; the pump waits instead of moving on. */
const LIVE_STATUSES = new Set(['preparing', 'planning', 'running'])

/**
 * A readable board/ticket error for the HTTP layer: `status` and `code` travel
 * to the client, the message is shown as is.
 */
export class FactoryError extends Error {
  /**
   * @param {string} message - human-readable reason.
   * @param {number} [status] - HTTP status.
   * @param {string} [code] - stable error code.
   */
  constructor(message, status = 400, code = 'artel/factory') {
    super(message)
    this.name = 'FactoryError'
    this.status = status
    this.code = code
  }
}

/**
 * Execute a program and collect its output; a non-zero exit is data, not a
 * throw. Windows resolves `git`/`gh` through the command name, which `execFile`
 * handles without a shell.
 * @param {string} command - program to run.
 * @param {string[]} args - arguments.
 * @param {{ cwd?: string, timeoutMs?: number }} [options] - working directory and timeout.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} result.
 */
export function runProgram(command, args, { cwd = '', timeoutMs = FACTORY_TUNING.execTimeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error?.code === 'number' ? error.code : 1
      resolve({
        code,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' && stderr !== '' ? stderr : String(error?.message ?? ''),
      })
    })
  })
}

/**
 * Turn a change list into the lines a prompt can carry, and keep the file names
 * for the PR body.
 * @param {object[]} changes - change entries from `lib/copy.js`.
 * @returns {{ lines: string[], files: string[] }} digest lines and file names.
 */
function digestOf(changes) {
  const lines = []
  const files = []
  for (const change of Array.isArray(changes) ? changes : []) {
    files.push(change.path)
    lines.push(`- ${change.status} ${change.path}${typeof change.added === 'number' ? ` (+${change.added}/-${change.removed})` : ''}`)
    if (lines.length >= 200) break
  }
  return { lines, files }
}

/**
 * The tail of a check output: long enough to be useful in a prompt, short
 * enough to keep the state file small.
 * @param {string} text - output.
 * @param {number} [max] - maximum characters.
 * @returns {string} bounded tail.
 */
function tailText(text, max = FACTORY_TUNING.maxOutputBytes) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `…${value.slice(value.length - max)}`
}

/**
 * A safe attachment file name: no path separators, no leading dots.
 * @param {string} name - requested name.
 * @returns {string} safe name.
 */
function safeFileName(name) {
  const base = path.basename(String(name ?? 'file'))
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '')
  return cleaned === '' ? 'file' : cleaned.slice(0, 120)
}

/**
 * The routes a board allows, as the triage prompt lists them.
 * @param {object} board - board record.
 * @returns {string[]} allowed routes.
 */
function allowedRoutes(board) {
  const routes = (board.routes ?? []).filter((route) => isRoute(route))
  return routes.length > 0 ? routes : [...FACTORY_ROUTES]
}

/**
 * Pick the route a ticket actually runs: the triage choice when the board allows
 * it, otherwise a cheaper one, because the Factory may only cheapen a run.
 * @param {object} board - board record.
 * @param {string | null} requested - route triage proposed.
 * @returns {{ mode: string, requested: string, notes: string[] }} chosen route and trim notes.
 */
function chooseRoute(board, requested) {
  const allowed = allowedRoutes(board)
  const want = isRoute(requested) ? requested : 'solo'
  if (allowed.includes(want)) return { mode: want, requested: want, notes: [] }
  const wantIndex = FACTORY_ROUTES.indexOf(want)
  let best = null
  for (const route of allowed) {
    if (FACTORY_ROUTES.indexOf(route) <= wantIndex) best = route
  }
  if (best === null) best = allowed[0]
  const note = `Маршрут «${routeLabel(want)}» запрещён настройками — взят «${routeLabel(best)}».`
  return { mode: best, requested: want, notes: [note] }
}

/**
 * The lines a repair turn must fix: blockers, important findings and unmet
 * acceptance criteria.
 * @param {object | null} review - parsed review.
 * @returns {string[]} findings.
 */
function reviewFindings(review) {
  const findings = []
  for (const entry of review?.blockers ?? []) findings.push(entry)
  for (const entry of review?.important ?? []) findings.push(entry)
  for (const entry of review?.criteria ?? []) {
    if (entry.met === false) findings.push(`не выполнен критерий: ${entry.text}`)
  }
  return findings.slice(0, 20)
}

/**
 * The pipeline that moves tickets across one project board: triage, work in a
 * copy, tests, app check, review, repair loops, and «Готово к PR».
 *
 * The runner never sends anything outward by itself: PR and merge are explicit
 * user actions on the ticket card. Everything it starts is an ordinary Artel run
 * (`engine.start`) with a per-ticket engine session.
 */
export class FactoryRunner {
  #engine
  #store
  #stateDir
  #log
  #now
  #tuning
  #exec
  #closed = false
  /** boardId -> Map(ticketId -> pipeline state) */
  #active = new Map()
  /** boardId -> { timer, busy } */
  #pumps = new Map()
  #trackerTimer = null

  /**
   * @param {object} options - dependencies.
   * @param {object} options.engine - `ArtelEngine`.
   * @param {object} options.store - `TicketStore`.
   * @param {string} options.stateDir - where attachments live.
   * @param {object} [options.log] - logger.
   * @param {() => number} [options.now] - clock.
   * @param {object} [options.tuning] - overrides of {@link FACTORY_TUNING}.
   * @param {Function | null} [options.exec] - injected program runner (tests).
   */
  constructor({ engine, store, stateDir, log = console, now = () => Date.now(), tuning = {}, exec = null }) {
    this.#engine = engine
    this.#store = store
    this.#stateDir = stateDir
    this.#log = log
    this.#now = now
    this.#tuning = { ...FACTORY_TUNING, ...tuning }
    this.#exec = typeof exec === 'function' ? exec : runProgram
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Adopt tickets that were mid-pipeline when the plugin stopped, mark the ones
   * whose run is gone, and restart the pumps of enabled boards.
   * @returns {Promise<FactoryRunner>} this runner.
   */
  async init() {
    for (const board of this.#store.list()) {
      for (const ticket of board.tickets ?? []) {
        this.#adoptTicket(board, ticket)
      }
      if (board.enabled === true) this.#ensurePump(board)
    }
    this.#trackerTimer = setInterval(() => {
      this.pollTrackers().catch((error) => this.#log.warn?.(`[artel] tracker poll failed: ${error?.message ?? error}`))
    }, this.#tuning.trackerPollMs)
    this.#trackerTimer.unref?.()
    return this
  }

  /**
   * Re-create the pipeline state of a ticket or park it when its run died.
   * @param {object} board - board record.
   * @param {object} ticket - ticket record.
   */
  #adoptTicket(board, ticket) {
    if (!PIPELINE_STAGES.has(ticket.stage)) return
    const runId = ticket.stage === 'triage' ? ticket.triageRunId : ticket.runId
    let run = null
    if (typeof runId === 'string' && runId !== '') {
      try {
        run = this.#engine.getRun(runId)
      } catch {
        run = null
      }
    }
    const state = this.#blankState(ticket.stage)
    if (run !== null) state.runId = run.id
    if (ticket.stage === 'triage' && run !== null) state.runId = run.id
    if (run !== null && (LIVE_STATUSES.has(run.status) || run.status === 'waiting' || run.status === 'finished')) {
      state.runId = run.id
      this.#activeOf(board.id).set(ticket.id, state)
      return
    }
    // The run is gone: a ticket with a change keeps it, one without starts over.
    this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      if (ticket.stage === 'triage') {
        stored.stage = 'incoming'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Плагин перезапустился во время разбора — тикет вернулся во «Входящие».' })
        return
      }
      stored.stage = 'waiting'
      stored.waiting = {
        kind: 'interrupted',
        reason: 'Плагин перезапустился во время работы. Версия сохранена, если агент что-то изменил.',
      }
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Плагин перезапустился во время работы — тикет ждёт вас.' })
    }).catch((error) => this.#log.warn?.(`[artel] could not adopt ticket: ${error?.message ?? error}`))
  }

  /** Stop every pump and the tracker timer. */
  dispose() {
    this.#closed = true
    for (const boardId of [...this.#pumps.keys()]) this.#stopPump(boardId)
    if (this.#trackerTimer !== null) clearInterval(this.#trackerTimer)
    this.#trackerTimer = null
    this.#active.clear()
  }

  /* ------------------------------------------------------------------- boards */

  /**
   * The boards of this profile, newest first, as client summaries.
   * @returns {object[]} board summaries.
   */
  listBoards() {
    return this.#store.list().map((board) => boardSummary(board))
  }

  /**
   * One board with its tickets and the bottom event log.
   * @param {string} boardId - board id.
   * @returns {{ board: object, tickets: object[] }} board view.
   */
  view(boardId) {
    const board = this.#requireBoard(boardId)
    return {
      board: boardSummary(board),
      tickets: (board.tickets ?? []).map((ticket) => ticketSummary(ticket)),
    }
  }

  /**
   * Open the board of a project, creating it the first time. One project has
   * one board; opening it again returns the stored one.
   * @param {{ projectPath: string, name?: string | null }} input - project to open.
   * @returns {Promise<{ board: object, created: boolean }>} board summary.
   */
  async createBoard({ projectPath, name = null }) {
    const existing = this.#store.forProject(projectPath)
    if (existing) return { board: boardSummary(existing), created: false }
    const board = createBoardRecord({ projectPath, name, now: this.#now() })
    await this.#store.add(board)
    return { board: boardSummary(board), created: true }
  }

  /**
   * Apply a settings patch (template, models, routes, limits, commands,
   * trackers, pause, «Фабрика включена»). Enabling requires a passing readiness
   * check; the check runs automatically when the board never had one.
   * @param {string} boardId - board id.
   * @param {object} patch - settings to change.
   * @returns {Promise<object>} board summary.
   */
  async updateBoard(boardId, patch = {}) {
    const board = this.#requireBoard(boardId)
    const problems = settingsProblems(patch)
    if (problems.length > 0) throw new FactoryError(problems.join(' '), 400, 'factory/bad-settings')
    if (Array.isArray(patch.trackers)) {
      for (const tracker of patch.trackers) {
        const trackerProblems = trackerModule.trackerProblems(tracker?.config ?? {})
        if (trackerProblems.length > 0) throw new FactoryError(`Приём тикетов: ${trackerProblems.join(' ')}`, 400, 'factory/bad-tracker')
      }
    }
    if (patch.enabled === true && board.enabled !== true) {
      let readiness = board.readiness
      if (readiness === null || readiness === undefined) readiness = (await this.checkReadiness(boardId)).readiness
      const blocking = readinessProblems(readiness)
      if (blocking.length > 0) throw new FactoryError(`Фабрику нельзя включить: ${blocking.join(' ')}`, 409, 'factory/not-ready')
    }
    const updated = await this.#update(boardId, (draft) => {
      if (patch.template !== undefined) draft.template = patch.template
      if (patch.models !== undefined) draft.models = { ...draft.models, ...patch.models }
      if (patch.routes !== undefined) draft.routes = [...patch.routes]
      if (patch.limits !== undefined) draft.limits = { ...draft.limits, ...patch.limits }
      if (patch.commands !== undefined) draft.commands = { ...draft.commands, ...patch.commands }
      if (patch.quirks !== undefined) draft.quirks = { ...draft.quirks, ...patch.quirks }
      if (patch.trackers !== undefined) draft.trackers = patch.trackers.map((tracker) => ({ enabled: true, commentBack: false, lastPollAt: null, lastError: null, ...tracker }))
      if (patch.paused !== undefined) draft.paused = patch.paused === true
      if (patch.enabled !== undefined) draft.enabled = patch.enabled === true
      recordBoardEvent(draft, {
        kind: 'status',
        text: patch.enabled === true ? 'Фабрика включена.' : patch.paused === true ? 'Фабрика на паузе: новые тикеты не берутся.' : 'Настройки фабрики обновлены.',
      })
    })
    if (updated.enabled === true) this.#ensurePump(updated)
    return boardSummary(updated)
  }

  /**
   * Probe the project and record the readiness report the settings card shows.
   * @param {string} boardId - board id.
   * @returns {Promise<{ board: object, readiness: object }>} readiness.
   */
  async checkReadiness(boardId) {
    const board = this.#requireBoard(boardId)
    const cwd = board.projectPath
    const git = await this.#exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    const gitOk = git.code === 0 && git.stdout.trim() === 'true'
    let commitOk = false
    if (gitOk) {
      const head = await this.#exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd })
      commitOk = head.code === 0
    }
    let enginesOk = false
    try {
      const catalog = await this.#engine.models()
      enginesOk = (catalog?.providers ?? []).some((provider) => Array.isArray(provider?.models) && provider.models.length > 0)
    } catch {
      enginesOk = false
    }
    const testCommand = (typeof board.commands?.test === 'string' && board.commands.test.trim() !== '') || (await this.#suggestCommand(board)) !== null
    const preview = typeof board.commands?.preview === 'string' && board.commands.preview.trim() !== ''
    const playwright = await this.#hasPlaywright(board)
    const readiness = readinessReport({ git: gitOk, commit: commitOk, engines: enginesOk, testCommand, preview, playwright })
    const updated = await this.#update(boardId, (draft) => {
      draft.readiness = readiness
    })
    return { board: boardSummary(updated), readiness }
  }

  /* ------------------------------------------------------------------ tickets */

  /**
   * Add a hand-written ticket to «Входящие». Attachments arrive either as
   * already-saved `{ name, path }` entries or as base64 `{ name, data }` payloads
   * that are written under the state directory.
   * @param {string} boardId - board id.
   * @param {{ title?: string, text: string, attachments?: object[], source?: object | null }} input - ticket fields.
   * @returns {Promise<object>} the stored ticket summary.
   */
  async addTicket(boardId, { title = '', text, attachments = [], source = null }) {
    const board = this.#requireBoard(boardId)
    const cleanText = String(text ?? '').trim()
    if (cleanText === '' && title.trim() === '') throw new FactoryError('Опишите тикет: заголовок или текст.', 400, 'factory/empty-ticket')
    const key = sourceKey(source)
    if (key !== '') {
      const duplicate = (board.tickets ?? []).find((ticket) => sourceKey(ticket.source) === key)
      if (duplicate) throw new FactoryError(`Этот тикет уже открыт: #${duplicate.number}.`, 409, 'factory/duplicate-ticket')
    }
    const ticket = createTicketRecord({ title, text: cleanText, attachments: [], source, now: this.#now() })
    const savedAttachments = await this.#saveAttachments(board, ticket.id, attachments)
    ticket.attachments = savedAttachments
    let stored
    await this.#update(boardId, (draft) => {
      this.#dayReset(draft)
      ticket.number = nextTicketNumber(draft)
      ticket.boardId = draft.id
      draft.ticketSeq = ticket.number
      draft.counters.created = (draft.counters.created ?? 0) + 1
      draft.tickets = [...(draft.tickets ?? []), ticket]
      recordTicketEvent(draft, ticket, { kind: 'status', text: `Входящие: #${ticket.number} ${ticket.title}` })
      stored = ticket
    })
    if (this.#store.get(boardId)?.enabled === true) this.#ensurePump(this.#store.get(boardId))
    return ticketSummary(stored ?? ticket)
  }

  /**
   * Import one GitHub issue by `#12` or a link. The issue is never opened twice:
   * its source key dedupes it.
   * @param {string} boardId - board id.
   * @param {string} ref - issue reference or URL.
   * @returns {Promise<object>} the stored ticket summary.
   */
  async importGithubIssue(boardId, ref) {
    const board = this.#requireBoard(boardId)
    const parsed = trackerModule.parseIssueRef(String(ref ?? ''))
    if (parsed === null) throw new FactoryError('Укажите номер issue («#12») или ссылку.', 400, 'factory/bad-issue-ref')
    const issue = await trackerModule.fetchGitHubIssue({ ref: parsed, cwd: board.projectPath, exec: this.#exec })
    if (issue === null) throw new FactoryError('Не удалось прочитать issue: проверьте номер, репозиторий и вход в gh.', 400, 'factory/issue-not-found')
    return this.addTicket(boardId, {
      title: issue.title,
      text: issue.text,
      source: { kind: 'github', externalId: issue.externalId, url: issue.url, labels: issue.labels, number: parsed.number },
    })
  }

  /**
   * Poll every tracker the enabled boards subscribe to and turn new issues into
   * tickets. Every failure is a board event, never a throw per tracker.
   * @param {string | null} [onlyBoardId] - poll one board instead of all.
   * @returns {Promise<{ added: number, errors: string[] }>} poll result.
   */
  async pollTrackers(onlyBoardId = null) {
    if (this.#closed) return { added: 0, errors: [] }
    const boards = onlyBoardId === null ? this.#store.list() : [this.#requireBoard(onlyBoardId)]
    let added = 0
    const errors = []
    for (const board of boards) {
      if (board.enabled !== true) continue
      const trackers = (board.trackers ?? []).filter((tracker) => tracker.enabled !== false && typeof tracker.kind === 'string')
      for (const tracker of trackers) {
        const { issues, error } = await trackerModule.listTrackerIssues({
          kind: tracker.kind,
          config: tracker.config ?? {},
          exec: this.#exec,
          fetchFn: globalThis.fetch,
        })
        if (error !== null && error !== undefined) {
          errors.push(`${tracker.kind}: ${error}`)
          await this.#update(board.id, (draft) => {
            const stored = (draft.trackers ?? []).find((entry) => entry.kind === tracker.kind && entry.label === tracker.label)
            if (stored) {
              stored.lastPollAt = this.#now()
              stored.lastError = String(error)
            }
          }).catch(() => {})
          continue
        }
        for (const issue of issues ?? []) {
          try {
            await this.addTicket(board.id, {
              title: issue.title,
              text: issue.text,
              source: { kind: tracker.kind, externalId: issue.externalId, url: issue.url, labels: issue.labels, label: tracker.label ?? null },
            })
            added += 1
          } catch (failure) {
            if (failure?.code !== 'factory/duplicate-ticket') throw failure
          }
        }
        await this.#update(board.id, (draft) => {
          const stored = (draft.trackers ?? []).find((entry) => entry.kind === tracker.kind && entry.label === tracker.label)
          if (stored) {
            stored.lastPollAt = this.#now()
            stored.lastError = null
          }
        }).catch(() => {})
      }
    }
    return { added, errors }
  }

  /**
   * One ticket with its own feed: the summary plus the ordinary Artel feed of
   * the working run (the same messages «Открыть сессию» shows).
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {{ cursor?: number }} [options] - feed cursor.
   * @returns {Promise<{ ticket: object, feed: object[] }>} ticket view.
   */
  async ticketView(boardId, ticketId, { cursor = 0 } = {}) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    let feed = []
    const runId = ticket.runId ?? ticket.triageRunId
    if (typeof runId === 'string' && runId !== '') {
      try {
        const page = await this.#engine.readFeed(runId, { cursor, limit: 300 })
        feed = page?.events ?? []
      } catch {
        feed = []
      }
    }
    return { ticket: ticketSummary(ticket), feed }
  }

  /* ---------------------------------------------------------- user decisions */

  /**
   * Answer the triage questionnaire (or a stalled work run). Answering a triage
   * question sends the ticket back to «Разбор» with the answers appended to its
   * text, exactly like editing the ticket and pressing «Вернуть фабрике».
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {{ text?: string, answers?: string[] }} input - the answer.
   * @returns {Promise<object>} ticket summary.
   */
  async answerQuestions(boardId, ticketId, { text = '', answers = [] } = {}) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    const lines = [...(Array.isArray(answers) ? answers : []), text].map((line) => String(line ?? '').trim()).filter((line) => line !== '')
    if (lines.length === 0) throw new FactoryError('Напишите ответ на вопросы разбора.', 400, 'factory/empty-answer')
    const kind = ticket.waiting?.kind ?? null
    if (kind !== 'triage-questions' && kind !== 'interrupted' && ticket.stage !== 'waiting') {
      throw new FactoryError('Этот тикет сейчас не ждёт ответа.', 409, 'factory/not-waiting')
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.answers = [...(stored.answers ?? []), ...lines]
      const block = `\n\nОтветы на вопросы разбора:\n${lines.map((line) => `- ${line}`).join('\n')}`
      if (stored.text.length + block.length <= 12000) stored.text = `${stored.text}${block}`
      stored.waiting = null
      if (kind === 'interrupted' && typeof stored.runId === 'string' && stored.runId !== '') {
        stored.stage = 'working'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Ответ получен — работа продолжается.' })
      } else {
        stored.stage = 'incoming'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Ответы получены — тикет снова на разборе.' })
      }
    })
    if (kind === 'interrupted' && ticket.runId) {
      try {
        await this.#engine.message(ticket.runId, { text: lines.join('\n') })
        this.#resetState(boardId, ticketId, 'working', ticket.runId)
      } catch (error) {
        this.#log.warn?.(`[artel] could not resume the ticket run: ${error?.message ?? error}`)
      }
    }
    const stored = this.#ticketIn(updated ?? this.#requireBoard(boardId), ticketId)
    return ticketSummary(stored)
  }

  /**
   * Approve the orchestrator plan of a ticket route: the parts start now.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @returns {Promise<object>} ticket summary.
   */
  async approvePlan(boardId, ticketId) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.waiting?.kind !== 'plan' || typeof ticket.runId !== 'string') {
      throw new FactoryError('У этого тикета нет плана, ждущего согласия.', 409, 'factory/no-plan')
    }
    try {
      await this.#engine.approvePlan(ticket.runId)
    } catch (error) {
      throw new FactoryError(String(error?.message ?? error), 409, 'factory/plan-rejected')
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.waiting = null
      stored.stage = 'working'
      recordTicketEvent(draft, stored, { kind: 'status', text: 'План согласован — части запущены.' })
    })
    this.#resetState(boardId, ticketId, 'working', ticket.runId)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /**
   * The three buttons of «кругов починки не осталось»: one more round, accept
   * as is, or postpone.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {{ action: string }} input - `more`, `accept` or `postpone`.
   * @returns {Promise<object>} ticket summary.
   */
  async repairAction(boardId, ticketId, { action }) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.waiting?.kind !== 'repair-exhausted') throw new FactoryError('Починка этого тикета сейчас не ждёт решения.', 409, 'factory/not-repairing')
    const findings = ticket.waiting?.findings ?? []
    if (action === 'more') {
      if (typeof ticket.runId !== 'string') throw new FactoryError('Версия тикета не найдена.', 409, 'factory/no-run')
      const round = (ticket.repairRound ?? 0) + 1
      try {
        await this.#engine.message(ticket.runId, { text: factoryRepairPrompt({ ticket, findings, round, rounds: round }) })
      } catch (error) {
        throw new FactoryError(String(error?.message ?? error), 409, 'factory/repair-failed')
      }
      const updated = await this.#update(boardId, (draft) => {
        const stored = this.#ticketIn(draft, ticketId)
        if (!stored) return
        stored.repairRound = round
        stored.extraRounds = (stored.extraRounds ?? 0) + 1
        stored.waiting = null
        stored.stage = 'working'
        recordTicketEvent(draft, stored, { kind: 'status', text: `Ещё круг починки ${round}.` })
      })
      this.#resetState(boardId, ticketId, 'working', ticket.runId)
      return ticketSummary(this.#ticketIn(updated, ticketId))
    }
    if (action === 'accept') {
      const updated = await this.#update(boardId, (draft) => {
        const stored = this.#ticketIn(draft, ticketId)
        if (!stored) return
        stored.waiting = null
        stored.stage = 'ready'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Принято как есть: замечания записаны в карточку.' })
      })
      this.#dropActive(boardId, ticketId)
      return ticketSummary(this.#ticketIn(updated, ticketId))
    }
    if (action === 'postpone') {
      const updated = await this.#update(boardId, (draft) => {
        const stored = this.#ticketIn(draft, ticketId)
        if (!stored) return
        stored.waiting = { kind: 'postponed', reason: 'Отложено вами после кругов починки.', findings }
        stored.stage = 'waiting'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Отложено вами.' })
      })
      this.#dropActive(boardId, ticketId)
      return ticketSummary(this.#ticketIn(updated, ticketId))
    }
    throw new FactoryError('Неизвестное действие починки.', 400, 'factory/bad-action')
  }

  /**
   * «Вернуть фабрике»: after the user edited a waiting ticket, it passes triage
   * again. The old triage/working runs are dropped, its text is kept.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {{ text?: string, title?: string }} [input] - optional edited text.
   * @returns {Promise<object>} ticket summary.
   */
  async returnToFactory(boardId, ticketId, { text = null, title = null } = {}) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (!['waiting', 'ready'].includes(ticket.stage)) throw new FactoryError('Вернуть фабрике можно только ждущий тикет.', 409, 'factory/not-waiting')
    if (typeof text === 'string' && text.trim() !== '') {
      ticket.text = text.trim()
    }
    if (typeof title === 'string' && title.trim() !== '') ticket.title = title.trim()
    for (const runId of [ticket.triageRunId, ticket.runId]) {
      if (typeof runId === 'string' && runId !== '') {
        try {
          await this.#engine.discard(runId)
        } catch {
          /* the run may already be decided; nothing to release */
        }
      }
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      if (typeof text === 'string' && text.trim() !== '') stored.text = text.trim()
      if (typeof title === 'string' && title.trim() !== '') stored.title = title.trim()
      stored.stage = 'incoming'
      stored.waiting = null
      stored.spec = null
      stored.route = null
      stored.check = null
      stored.review = null
      stored.repairRound = 0
      stored.triageRunId = null
      stored.runId = null
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Возвращено фабрике: тикет снова пройдёт разбор.' })
    })
    this.#dropActive(boardId, ticketId)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /**
   * «Вернуть с комментарием» from «Готово к PR»: the comment becomes a repair
   * turn of the existing working copy, so the ticket keeps its version.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {{ comment?: string }} [input] - what to fix.
   * @returns {Promise<object>} ticket summary.
   */
  async returnWithComment(boardId, ticketId, { comment = '' } = {}) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.stage !== 'ready') throw new FactoryError('Комментарий можно отправить только из «Готово к PR».', 409, 'factory/not-ready')
    const note = String(comment ?? '').trim()
    if (note === '') throw new FactoryError('Напишите, что поправить.', 400, 'factory/empty-comment')
    if (typeof ticket.runId !== 'string') throw new FactoryError('Версия тикета не найдена.', 409, 'factory/no-run')
    try {
      await this.#engine.message(ticket.runId, { text: `The user returned ticket #${ticket.number} with a comment:\n${note}\n\nFix exactly this in the ticket copy, keep the passing criteria passing, run the project's checks, and finish with a short summary.` })
    } catch (error) {
      throw new FactoryError(String(error?.message ?? error), 409, 'factory/comment-failed')
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.stage = 'working'
      stored.waiting = null
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Возврат с комментарием — тикет снова в работе.' })
    })
    this.#resetState(boardId, ticketId, 'working', ticket.runId)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /**
   * «Взять вручную» / «Стоп» on a ticket card: stop whatever the factory is
   * doing, keep the versions it already saved, and park the ticket in «Ждёт
   * вас» as postponed. It comes back through «Вернуть фабрике».
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @returns {Promise<object>} ticket summary.
   */
  async takeOver(boardId, ticketId) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.stage === 'done') throw new FactoryError('Тикет уже готов — брать вручную нечего.', 409, 'factory/done')
    const state = this.#activeOf(boardId).get(ticketId)
    const runIds = [state?.runId, ticket.runId, ticket.triageRunId]
    for (const runId of runIds) {
      if (typeof runId !== 'string' || runId === '') continue
      try {
        await this.#engine.interrupt(runId)
      } catch {
        /* the run may already be decided; nothing to stop */
      }
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.stage = 'waiting'
      stored.waiting = { kind: 'postponed', reason: 'Взято вручную: тикет снят с конвейера. Верните его фабрике, когда закончите.' }
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Взято вручную — тикет снят с конвейера.' })
    })
    this.#dropActive(boardId, ticketId)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /**
   * Open the pull request of a ready ticket: apply the version, branch, commit,
   * push and `gh pr create`. This is the only outward action, and it happens
   * only because the user pressed the button. The plugin itself merges nothing.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @returns {Promise<object>} ticket summary after the PR.
   */
  async openPullRequest(boardId, ticketId) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.stage !== 'ready') throw new FactoryError('Pull Request открывается из «Готово к PR».', 409, 'factory/not-ready')
    if (typeof ticket.runId !== 'string') throw new FactoryError('Версия тикета не найдена.', 409, 'factory/no-run')
    const run = this.#runOf(ticket.runId)
    if (run === null) throw new FactoryError('Версия тикета больше не доступна.', 409, 'factory/no-run')
    const changes = await this.#changesOf(ticket.runId)
    const { files } = digestOf(changes)
    const body = prBody({ ticket, changeCount: files.length, files, check: ticket.check, review: ticket.review })
    const title = prTitle(ticket)
    const cwd = board.projectPath

    const status = await this.#exec('git', ['status', '--porcelain'], { cwd })
    if (status.code !== 0) throw new FactoryError(`Git не отвечает: ${tailText(status.stderr, 300)}`, 409, 'factory/git-failed')
    if (status.stdout.trim() !== '') throw new FactoryError('В проекте есть незакоммиченные изменения: PR собирается из чистого дерева.', 409, 'factory/dirty-tree')
    const remote = await this.#exec('git', ['remote'], { cwd })
    if (remote.code !== 0 || remote.stdout.trim() === '') throw new FactoryError('У проекта нет удалённого репозитория: сначала добавьте origin.', 409, 'factory/no-remote')

    const branch = `factory/ticket-${ticket.number}`
    const checkout = await this.#exec('git', ['checkout', '-b', branch], { cwd })
    if (checkout.code !== 0) throw new FactoryError(`Не удалось создать ветку ${branch}: ${tailText(checkout.stderr, 300)}`, 409, 'factory/git-failed')
    try {
      await this.#engine.apply(ticket.runId)
    } catch (error) {
      throw new FactoryError(`Не удалось применить версию: ${error?.message ?? error}`, 409, 'factory/apply-failed')
    }
    const add = await this.#exec('git', ['add', '-A'], { cwd })
    if (add.code !== 0) throw new FactoryError(`git add: ${tailText(add.stderr, 300)}`, 409, 'factory/git-failed')
    const commit = await this.#exec('git', ['commit', '-m', title], { cwd })
    if (commit.code !== 0) throw new FactoryError(`git commit: ${tailText(commit.stderr, 300)}`, 409, 'factory/git-failed')
    const push = await this.#exec('git', ['push', '-u', 'origin', branch], { cwd })
    let url = null
    let problem = null
    if (push.code !== 0) {
      problem = `Ветка ${branch} закоммичена, но push не прошёл: ${tailText(push.stderr, 300)}`
    } else {
      const created = await this.#exec('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch], { cwd })
      if (created.code === 0) {
        url = /https:\/\/\S+/.exec(created.stdout)?.[0] ?? null
      } else {
        problem = `Ветка ${branch} отправлена, но PR не создан: ${tailText(created.stderr, 300)}`
      }
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.stage = 'done'
      stored.waiting = null
      stored.branch = branch
      stored.pr = { url, branch, at: this.#now(), error: problem }
      recordTicketEvent(draft, stored, { kind: 'status', text: problem === null ? `Pull Request: ${url ?? branch}` : problem })
    })
    this.#dropActive(boardId, ticketId)
    if (problem === null) await this.#commentBack(board, ticket, `Готово: ${url ?? branch}\n\n${body}`)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /**
   * «Влить»: apply the ticket version into the user's project and finish the
   * ticket. The plugin merges no branches and pushes nothing.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @returns {Promise<object>} ticket summary.
   */
  async mergeTicket(boardId, ticketId) {
    const board = this.#requireBoard(boardId)
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket) throw new FactoryError('Unknown ticket', 404, 'factory/unknown-ticket')
    if (ticket.stage !== 'ready') throw new FactoryError('Влить можно тикет из «Готово к PR».', 409, 'factory/not-ready')
    if (typeof ticket.runId !== 'string') throw new FactoryError('Версия тикета не найдена.', 409, 'factory/no-run')
    try {
      await this.#engine.apply(ticket.runId)
    } catch (error) {
      throw new FactoryError(`Не удалось применить версию: ${error?.message ?? error}`, 409, 'factory/apply-failed')
    }
    const updated = await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      this.#dayReset(draft)
      stored.stage = 'done'
      stored.waiting = null
      draft.counters.merged = (draft.counters.merged ?? 0) + 1
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Влито в проект.' })
    })
    this.#dropActive(boardId, ticketId)
    await this.#commentBack(board, ticket, `Влито в проект (тикет #${ticket.number}).`)
    return ticketSummary(this.#ticketIn(updated, ticketId))
  }

  /* ------------------------------------------------------------------- pumps */

  /**
   * Start or stop the pump of a board according to its settings.
   * @param {object} board - board record.
   */
  #ensurePump(board) {
    if (this.#closed) return
    const active = this.#activeOf(board.id)
    const shouldRun = board.enabled === true || active.size > 0
    if (!shouldRun) {
      this.#stopPump(board.id)
      return
    }
    if (this.#pumps.has(board.id)) return
    const timer = setInterval(() => {
      this.#tick(board.id).catch((error) => this.#log.warn?.(`[artel] factory tick failed: ${error?.message ?? error}`))
    }, this.#tuning.pollMs)
    timer.unref?.()
    this.#pumps.set(board.id, { timer, busy: false })
  }

  /**
   * Stop one board pump.
   * @param {string} boardId - board id.
   */
  #stopPump(boardId) {
    const pump = this.#pumps.get(boardId)
    if (pump) clearInterval(pump.timer)
    this.#pumps.delete(boardId)
  }

  /**
   * One pump tick: advance the active tickets, then feed new ones from
   * «Входящие» while the board has free slots and daily budget.
   * @param {string} boardId - board id.
   */
  async #tick(boardId) {
    if (this.#closed) return
    const pump = this.#pumps.get(boardId)
    if (!pump || pump.busy) return
    pump.busy = true
    try {
      await this.#advance(boardId)
    } finally {
      pump.busy = false
    }
  }

  /**
   * The actual pump step.
   * @param {string} boardId - board id.
   */
  async #advance(boardId) {
    let board = this.#store.get(boardId)
    if (!board) {
      this.#stopPump(boardId)
      return
    }
    const active = this.#activeOf(boardId)
    for (const ticketId of [...active.keys()]) {
      const current = this.#store.get(boardId)
      if (!current) break
      await this.#step(current, ticketId)
    }
    board = this.#store.get(boardId)
    if (!board) {
      this.#stopPump(boardId)
      return
    }
    if (board.paused === true || board.enabled !== true) {
      if (active.size === 0) this.#stopPump(boardId)
      return
    }
    const slots = Math.max(1, Number(board.limits?.ticketsAtOnce) || 1) - active.size
    if (slots <= 0) return
    const limit = Number(board.limits?.ticketsPerDay) || 0
    const counters = board.counters ?? {}
    const startedToday = counters.day === dayKey(this.#now()) ? Number(counters.started) || 0 : 0
    if (limit > 0 && startedToday >= limit) return
    const incoming = (board.tickets ?? []).filter((ticket) => ticket.stage === 'incoming').slice(0, slots)
    for (const ticket of incoming) {
      await this.#beginTriage(boardId, ticket.id)
    }
  }

  /**
   * Start the triage run of an incoming ticket.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   */
  async #beginTriage(boardId, ticketId) {
    const board = this.#store.get(boardId)
    if (!board) return
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket || ticket.stage !== 'incoming') return
    const sessionId = `factory-${board.id}-${ticket.id}`
    let run
    try {
      run = await this.#engine.start({
        sessionId,
        projectPath: board.projectPath,
        mode: 'solo',
        task: triagePrompt({ ticket: this.#triageTicket(ticket), projectPath: board.projectPath, routes: allowedRoutes(board) }),
        model: board.models?.triage ?? null,
        sandboxMode: 'read-only',
      })
    } catch (error) {
      await this.#update(boardId, (draft) => {
        const stored = this.#ticketIn(draft, ticketId)
        if (!stored) return
        stored.stage = 'waiting'
        stored.waiting = { kind: 'nothing-to-run', reason: `Разбор не запустился: ${error?.message ?? error}` }
        recordTicketEvent(draft, stored, { kind: 'error', text: `Разбор не запустился: ${error?.message ?? error}` })
      })
      this.#dropActive(boardId, ticketId)
      return
    }
    await this.#update(boardId, (draft) => {
      this.#dayReset(draft)
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.stage = 'triage'
      stored.triageRunId = run.id
      stored.sessionId = sessionId
      draft.counters.started = (draft.counters.started ?? 0) + 1
      recordTicketEvent(draft, stored, { kind: 'status', text: `Разбор: #${ticket.number} ${ticket.title}` })
    })
    this.#activeOf(boardId).set(ticketId, this.#blankState('triage', run.id))
  }

  /* --------------------------------------------------------------- pipeline */

  /**
   * One step of the pipeline for one ticket, chosen by its current stage.
   * @param {object} board - board snapshot.
   * @param {string} ticketId - ticket id.
   */
  async #step(board, ticketId) {
    const ticket = this.#ticketIn(board, ticketId)
    const state = this.#active.get(board.id)?.get(ticketId)
    if (!ticket || !state) {
      this.#dropActive(board.id, ticketId)
      return
    }
    if (!PIPELINE_STAGES.has(ticket.stage)) {
      this.#dropActive(board.id, ticketId)
      return
    }
    try {
      if (ticket.stage === 'triage') await this.#stepTriage(board, ticket, state)
      else if (ticket.stage === 'working') await this.#stepWorking(board, ticket, state)
      else if (ticket.stage === 'tests') await this.#stepTests(board, ticket, state)
      else if (ticket.stage === 'check') await this.#stepCheck(board, ticket, state)
      else if (ticket.stage === 'review') await this.#stepReview(board, ticket, state)
    } catch (error) {
      this.#log.warn?.(`[artel] factory step failed for ${ticket.id}: ${error?.stack ?? error}`)
      await this.#failTicket(board.id, ticketId, `Шаг фабрики упал: ${error?.message ?? error}`)
    }
  }

  /**
   * Read the new feed events of a run and collect the assistant text.
   * @param {string} runId - run id.
   * @param {{ cursor: number, texts: string[] }} state - pipeline state to advance.
   * @returns {Promise<object | null>} refreshed run summary.
   */
  async #pollRun(runId, state) {
    let run = null
    try {
      run = this.#runOf(runId)
    } catch {
      run = null
    }
    try {
      const page = await this.#engine.readFeed(runId, { cursor: state.cursor, limit: 200 })
      for (const event of page?.events ?? []) {
        if (event.kind === 'assistant' && typeof event.text === 'string' && event.text.trim() !== '') state.texts.push(event.text)
      }
      state.cursor = page?.cursor ?? state.cursor
    } catch {
      /* a run may be pruned while the pipeline still holds its id */
    }
    return run
  }

  /**
   * Whether the run is still doing something the pump must wait for.
   * @param {object | null} run - run summary.
   * @returns {boolean} true while preparing, planning or running.
   */
  #isLive(run) {
    return run !== null && LIVE_STATUSES.has(run.status)
  }

  /**
   * Whether the run is idle enough to move the ticket on.
   * @param {object | null} run - run summary.
   * @returns {boolean} true for waiting/finished.
   */
  #isSettled(run) {
    return run !== null && (run.status === 'waiting' || run.status === 'finished')
  }

  /**
   * Triage step: read the verdict, park on questions, or move to work.
   * @param {object} board - board snapshot.
   * @param {object} ticket - ticket record.
   * @param {object} state - pipeline state.
   */
  async #stepTriage(board, ticket, state) {
    const run = await this.#pollRun(state.runId ?? ticket.triageRunId, state)
    if (this.#isLive(run)) return
    if (run === null || run.status === 'failed' || run.status === 'interrupted') {
      const reason = run?.error ?? 'Разбор прервался.'
      await this.#toWaiting(board.id, ticket.id, { kind: 'nothing-to-run', reason })
      return
    }
    if (!this.#isSettled(run)) return
    const parsed = parseTriage(state.texts.join('\n'))
    if (parsed.questions.length > 0) {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.spec = {
          summary: parsed.summary,
          criteria: parsed.criteria,
          assumptions: parsed.assumptions,
          route: null,
        }
        stored.stage = 'waiting'
        stored.waiting = { kind: 'triage-questions', questions: parsed.questions }
        recordTicketEvent(draft, stored, { kind: 'status', text: `Разбор: вопросов — ${parsed.questions.length}. Нужен ваш ответ.` })
      })
      await this.#discardRun(state.runId ?? ticket.triageRunId)
      this.#dropActive(board.id, ticket.id)
      return
    }
    const route = chooseRoute(board, parsed.route)
    const spec = {
      summary: parsed.summary,
      criteria: parsed.criteria,
      assumptions: parsed.assumptions,
      route: route.mode,
      requested: route.requested,
      notes: route.notes,
    }
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      stored.spec = spec
      stored.route = { mode: route.mode, requested: route.requested, notes: route.notes }
      stored.stage = 'working'
      stored.repairRound = 0
      recordTicketEvent(draft, stored, {
        kind: 'status',
        text: `Разбор: ${parsed.criteria.length} критерия, маршрут «${routeLabel(route.mode)}»${route.notes.length > 0 ? ` (${route.notes.join(' ')})` : ''}`,
      })
    })
    await this.#discardRun(state.runId ?? ticket.triageRunId)
    state.runId = null
    state.cursor = 0
    state.texts = []
    state.questions = 0
    await this.#beginWork(board.id, ticket.id)
  }

  /**
   * Start the working run of a triaged ticket. A new run starts from the last
   * version copy when that copy is still on disk and from the project otherwise;
   * every started run is recorded in `ticket.versions` for the ticket panel.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   */
  async #beginWork(boardId, ticketId) {
    const board = this.#store.get(boardId)
    if (!board) return
    const ticket = this.#ticketIn(board, ticketId)
    if (!ticket || ticket.stage !== 'working') return
    const mode = ticket.route?.mode ?? 'solo'
    const sessionId = ticket.sessionId ?? `factory-${board.id}-${ticket.id}`
    const versions = Array.isArray(ticket.versions) ? ticket.versions : []
    const previous = versions.length > 0 ? versions[versions.length - 1] : null
    const startWork = (basePath) => this.#engine.start({
      sessionId,
      projectPath: board.projectPath,
      mode,
      task: factoryWorkPrompt({ ticket, copyPath: '', projectPath: board.projectPath }),
      model: board.models?.work ?? null,
      basePath,
      autoqueue: true,
      planApproval: mode === 'orchestrator',
    })
    let basePath = typeof previous?.copyPath === 'string' && previous.copyPath !== '' ? previous.copyPath : null
    let run = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        run = await startWork(basePath)
        break
      } catch (error) {
        if (attempt === 0 && basePath !== null && error?.code === 'artel/no-base-version') {
          basePath = null
          continue
        }
        const reason = String(error?.message ?? error)
        if (error?.code === 'factory/no-run') {
          await this.#toWaiting(boardId, ticketId, { kind: 'nothing-to-run', reason })
          return
        }
        await this.#toWaiting(boardId, ticketId, { kind: 'interrupted', reason: `Работа не запустилась: ${reason}` })
        return
      }
    }
    if (run === null) return
    await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.runId = run.id
      stored.sessionId = sessionId
      const recorded = Array.isArray(stored.versions) ? stored.versions : []
      recorded.push({ runId: run.id, copyPath: run.copyPath ?? null, at: Date.now() })
      stored.versions = recorded.slice(-5)
      recordTicketEvent(draft, stored, { kind: 'status', text: `Работа: #${ticket.number} (маршрут «${routeLabel(mode)}»)` })
    })
    const state = this.#blankState('working', run.id)
    this.#activeOf(boardId).set(ticketId, state)
  }

  /**
   * Working step: watch the run, auto-answer the first question, wait for plan
   * approval, then move to the tests stage.
   * @param {object} board - board snapshot.
   * @param {object} ticket - ticket record.
   * @param {object} state - pipeline state.
   */
  async #stepWorking(board, ticket, state) {
    const runId = state.runId ?? ticket.runId
    const run = await this.#pollRun(runId, state)
    if (run === null) {
      await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: 'Версия задачи пропала из истории.' })
      return
    }
    const text = state.texts.join('\n')
    if (run.planApproval === true && run.planApproved !== true && run.status === 'waiting') {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.stage = 'waiting'
        stored.waiting = { kind: 'plan', plan: run.plan ?? null }
        recordTicketEvent(draft, stored, { kind: 'status', text: 'План готов — ждёт вашего согласия на карточке тикета.' })
      })
      this.#dropActive(board.id, ticket.id)
      return
    }
    const asked = this.#questionCount(text)
    if (asked > state.questions) {
      state.questions = asked
      if (asked >= 2) {
        await this.#engine.interrupt(runId).catch(() => {})
        await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: 'Агент задал второй вопрос: без вашего ответа задачу не продолжить.' })
        return
      }
      try {
        await this.#engine.message(runId, { text: autoAnswerPrompt() })
      } catch {
        /* the run may have finished in the same moment; the settle below decides */
      }
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (stored) recordTicketEvent(draft, stored, { kind: 'status', text: 'Вопрос агента — автоответ: решай сам и запиши допущение.' })
      })
      return
    }
    if (this.#isLive(run)) return
    if (run.status === 'applied') {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.stage = 'done'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Версию влили вручную — тикет закрыт.' })
      })
      this.#dropActive(board.id, ticket.id)
      return
    }
    if (run.status === 'discarded') {
      await this.#toWaiting(board.id, ticket.id, { kind: 'postponed', reason: 'Версию отменили вручную.' })
      return
    }
    if (run.status === 'failed' || run.status === 'interrupted') {
      await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: run.error ?? 'Работа прервана.' })
      return
    }
    if (this.#isSettled(run)) {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.stage = 'tests'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Работа готова — дальше тесты.' })
      })
      state.stage = 'tests'
      state.cursor = 0
      state.texts = []
      return
    }
  }

  /**
   * Tests step: run the board's test command in the ticket copy, repair up to
   * the template's rounds, then move to the app check.
   * @param {object} board - board snapshot.
   * @param {object} ticket - ticket record.
   * @param {object} state - pipeline state.
   */
  async #stepTests(board, ticket, state) {
    const run = this.#runOf(ticket.runId)
    if (run === null) {
      await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: 'Версия тикета не найдена.' })
      return
    }
    if (this.#isLive(run)) return
    if (!this.#isSettled(run) && run.status !== 'failed' && run.status !== 'interrupted') {
      await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: run.error ?? 'Работа закончилась без результата.' })
      return
    }
    const changes = await this.#changesOf(ticket.runId)
    const template = templateOf(board.template)
    if (board.quirks?.appendTests === true && state.appendedTests !== true && changes.length > 0 && !ticketTouchedTests(changes)) {
      state.appendedTests = true
      try {
        await this.#engine.message(ticket.runId, {
          text: `The change for ticket #${ticket.number} touched no tests. Add or adjust tests that check the acceptance criteria${ticketCriteria(ticket).length > 0 ? `:\n${ticketCriteria(ticket).map((criterion) => `- ${criterion}`).join('\n')}` : '.'}\n\nRun the project's own check, then finish with a short summary.`,
        })
      } catch (error) {
        await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: `Не удалось попросить тесты: ${error?.message ?? error}` })
        return
      }
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (stored) recordTicketEvent(draft, stored, { kind: 'status', text: 'Дописать тесты: дополнительный шаг реализации.' })
      })
      state.cursor = 0
      state.texts = []
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (stored) stored.stage = 'working'
      })
      return
    }
    const command = await this.#testCommand(board)
    if (command === null) {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.check = { ...(stored.check ?? {}), tests: { ok: true, skipped: true, reason: 'Нет команды тестов: задайте её в настройках доски.', command: null } }
        stored.stage = 'check'
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Тесты пропущены: нет команды тестов.' })
      })
      state.stage = 'check'
      return
    }
    const check = await this.#callCheck('runCheck', {
      command,
      cwd: run.copyPath,
      timeoutMs: this.#tuning.checkTimeoutMs,
      maxOutputBytes: this.#tuning.maxOutputBytes,
    })
    const result = check ?? { ok: false, command, output: 'Проверка недоступна.', code: null, timedOut: false }
    if (result.ok === true) {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.check = { ...(stored.check ?? {}), tests: { ok: true, command, output: tailText(result.output, 8000), durationMs: result.durationMs ?? null } }
        stored.stage = 'check'
        recordTicketEvent(draft, stored, { kind: 'status', text: `Тесты пройдены: ${command}` })
      })
      state.stage = 'check'
      return
    }
    const rounds = template.repairRounds
    const round = (ticket.repairRound ?? 0) + 1
    if (round <= rounds) {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.repairRound = round
        stored.check = { ...(stored.check ?? {}), tests: { ok: false, command, output: tailText(result.output, 8000), timedOut: result.timedOut === true } }
        stored.stage = 'working'
        recordTicketEvent(draft, stored, { kind: 'status', text: `Тесты не прошли — круг починки ${round} из ${rounds}.` })
      })
      try {
        await this.#engine.message(ticket.runId, { text: checkRepairPrompt({ command, output: tailText(result.output, 8000), attempt: round, attempts: rounds }) })
      } catch (error) {
        await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: `Не удалось запустить починку: ${error?.message ?? error}` })
        return
      }
      state.stage = 'working'
      state.cursor = 0
      state.texts = []
      state.questions = 0
      return
    }
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      stored.check = { ...(stored.check ?? {}), tests: { ok: false, command, output: tailText(result.output, 8000), timedOut: result.timedOut === true } }
    })
    await this.#toWaiting(board.id, ticket.id, {
      kind: 'repair-exhausted',
      reason: `Тесты не прошли после ${rounds} кругов починки.`,
      findings: [`Тесты: ${command}`, tailText(result.output, 1600)],
    })
  }

  /**
   * App-check step: replay nothing, then either skip with a reason or run the
   * read-only app checker over a copy seeded from the ticket version.
   * @param {object} board - board snapshot.
   * @param {object} ticket - ticket record.
   * @param {object} state - pipeline state.
   */
  async #stepCheck(board, ticket, state) {
    const template = templateOf(board.template)
    if (template.appCheck !== true) {
      await this.#skipAppCheck(board.id, ticket.id, 'Шаблон без проверки приложения.')
      return
    }
    if (typeof board.commands?.preview !== 'string' || board.commands.preview.trim() === '') {
      await this.#skipAppCheck(board.id, ticket.id, 'Нет preview: добавьте команду preview в настройках доски.')
      return
    }
    if (this.#readinessOk(board, 'playwright') !== true) {
      await this.#skipAppCheck(board.id, ticket.id, 'Нет Playwright: проверка приложения пропущена.')
      return
    }
    if (!ticketIsUi(ticket)) {
      await this.#skipAppCheck(board.id, ticket.id, 'Тикет не про интерфейс: проверка приложения не нужна.')
      return
    }
    const workRun = this.#runOf(ticket.runId)
    if (workRun === null) {
      await this.#skipAppCheck(board.id, ticket.id, 'Версия тикета не найдена.')
      return
    }
    if (state.appRunId === null || state.appRunId === undefined) {
      let run
      try {
        run = await this.#engine.start({
          sessionId: `${ticket.sessionId ?? `factory-${board.id}-${ticket.id}`}-app`,
          projectPath: board.projectPath,
          mode: 'solo',
          task: factoryAppCheckPrompt({ ticket, copyPath: '', previewCommand: board.commands.preview }),
          basePath: workRun.copyPath,
          sandboxMode: 'read-only',
        })
      } catch (error) {
        await this.#skipAppCheck(board.id, ticket.id, `Проверка приложения не запустилась: ${error?.message ?? error}`)
        return
      }
      state.appRunId = run.id
      state.appCursor = 0
      state.appTexts = []
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.check = { ...(stored.check ?? {}), app: { verdict: 'running', reason: '', findings: [] } }
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Проверка приложения: агент запущен.' })
      })
      return
    }
    const appState = { cursor: state.appCursor ?? 0, texts: state.appTexts ?? [] }
    const run = await this.#pollRun(state.appRunId, appState)
    state.appCursor = appState.cursor
    state.appTexts = appState.texts
    if (this.#isLive(run)) return
    const parsed = parseAppCheck(appState.texts.join('\n'))
    await this.#discardRun(state.appRunId)
    state.appRunId = null
    const verdict = parsed.verdict === 'missing' ? 'skip' : parsed.verdict
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      stored.check = { ...(stored.check ?? {}), app: { verdict, reason: parsed.reason, findings: parsed.findings } }
      recordTicketEvent(draft, stored, { kind: 'status', text: `Проверка приложения: ${verdict}${parsed.reason ? ` — ${parsed.reason}` : ''}` })
    })
    if (verdict === 'fail') {
      const rounds = template.repairRounds
      const round = (ticket.repairRound ?? 0) + 1
      if (round <= rounds) {
        try {
          await this.#engine.message(ticket.runId, {
            text: factoryRepairPrompt({ ticket, findings: [parsed.reason, ...parsed.findings].filter((line) => String(line ?? '').trim() !== ''), round, rounds }),
          })
        } catch (error) {
          await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: `Не удалось запустить починку: ${error?.message ?? error}` })
          return
        }
        await this.#update(board.id, (draft) => {
          const stored = this.#ticketIn(draft, ticket.id)
          if (!stored) return
          stored.repairRound = round
          stored.stage = 'working'
          recordTicketEvent(draft, stored, { kind: 'status', text: `Проверка приложения не прошла — круг починки ${round} из ${rounds}.` })
        })
        this.#resetState(board.id, ticket.id, 'working', ticket.runId)
        return
      }
      await this.#toWaiting(board.id, ticket.id, {
        kind: 'repair-exhausted',
        reason: `Проверка приложения не прошла после ${rounds} кругов.`,
        findings: [parsed.reason, ...parsed.findings].filter((line) => String(line ?? '').trim() !== ''),
      })
      return
    }
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      stored.stage = 'review'
      recordTicketEvent(draft, stored, { kind: 'status', text: 'Проверки пройдены — дальше ревью.' })
    })
    state.stage = 'review'
    state.reviewRuns = []
    state.reviewIndex = 0
  }

  /**
   * Skip the app check with the reason the card shows.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {string} reason - why it was skipped.
   */
  async #skipAppCheck(boardId, ticketId, reason) {
    await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.check = { ...(stored.check ?? {}), app: { verdict: 'skip', reason, findings: [] } }
      stored.stage = 'review'
      recordTicketEvent(draft, stored, { kind: 'status', text: `Проверка приложения: пропущена — ${reason}` })
    })
  }

  /**
   * Review step: run one or two read-only reviewers over the ticket diff, then
   * accept, repair or park.
   * @param {object} board - board snapshot.
   * @param {object} ticket - ticket record.
   * @param {object} state - pipeline state.
   */
  async #stepReview(board, ticket, state) {
    const template = templateOf(board.template)
    const reviewers = Math.max(1, Number(template.reviewers) || 1)
    const workRun = this.#runOf(ticket.runId)
    if (workRun === null) {
      await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: 'Версия тикета не найдена.' })
      return
    }
    if (!Array.isArray(state.reviewRuns)) state.reviewRuns = []
    if (state.reviewRunId === null || state.reviewRunId === undefined) {
      const changes = await this.#changesOf(ticket.runId)
      const { lines } = digestOf(changes)
      let run
      try {
        run = await this.#engine.start({
          sessionId: `${ticket.sessionId ?? `factory-${board.id}-${ticket.id}`}-review-${state.reviewIndex ?? 0}`,
          projectPath: board.projectPath,
          mode: 'solo',
          task: factoryReviewPrompt({ ticket, copyPath: '', projectPath: board.projectPath, digest: changeDigest(changes).trim() === '' ? lines.join('\n') : changeDigest(changes) }),
          basePath: workRun.copyPath,
          sandboxMode: 'read-only',
          model: board.models?.review ?? null,
        })
      } catch (error) {
        await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: `Ревью не запустилось: ${error?.message ?? error}` })
        return
      }
      state.reviewRunId = run.id
      state.reviewCursor = 0
      state.reviewTexts = []
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (stored) recordTicketEvent(draft, stored, { kind: 'status', text: `Ревью ${(state.reviewIndex ?? 0) + 1} из ${reviewers}: запущено.` })
      })
      return
    }
    const reviewState = { cursor: state.reviewCursor ?? 0, texts: state.reviewTexts ?? [] }
    const run = await this.#pollRun(state.reviewRunId, reviewState)
    state.reviewCursor = reviewState.cursor
    state.reviewTexts = reviewState.texts
    if (this.#isLive(run)) return
    const parsed = parseReview(reviewState.texts.join('\n'))
    state.reviewRuns.push(parsed)
    await this.#discardRun(state.reviewRunId)
    state.reviewRunId = null
    state.reviewIndex = (state.reviewIndex ?? 0) + 1
    if (state.reviewRuns.length < reviewers && parsed.verdict !== 'rework') return
    const combined = this.#combineReviews(state.reviewRuns)
    if (combined.verdict === 'missing') {
      if (state.reviewRetried !== true) {
        state.reviewRetried = true
        state.reviewRuns = []
        await this.#update(board.id, (draft) => {
          const stored = this.#ticketIn(draft, ticket.id)
          if (stored) recordTicketEvent(draft, stored, { kind: 'status', text: 'Ревью не дало вердикта — повторный проход.' })
        })
        return
      }
      await this.#toWaiting(board.id, ticket.id, { kind: 'nothing-to-run', reason: 'Ревью не дало читаемого вердикта. Верните тикет фабрике или посмотрите сессию.' })
      return
    }
    if (combined.verdict !== 'rework') {
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.review = combined
        stored.stage = 'ready'
        stored.waiting = null
        recordTicketEvent(draft, stored, { kind: 'status', text: 'Ревью: принято — готово к PR.' })
      })
      this.#dropActive(board.id, ticket.id)
      return
    }
    const findings = reviewFindings(combined)
    const rounds = template.repairRounds
    const round = (ticket.repairRound ?? 0) + 1
    if (round <= rounds) {
      try {
        await this.#engine.message(ticket.runId, { text: factoryRepairPrompt({ ticket, findings, round, rounds }) })
      } catch (error) {
        await this.#toWaiting(board.id, ticket.id, { kind: 'interrupted', reason: `Не удалось запустить починку: ${error?.message ?? error}` })
        return
      }
      await this.#update(board.id, (draft) => {
        const stored = this.#ticketIn(draft, ticket.id)
        if (!stored) return
        stored.repairRound = round
        stored.review = combined
        stored.stage = 'working'
        recordTicketEvent(draft, stored, { kind: 'status', text: `Ревью: замечаний — ${findings.length}, круг починки ${round} из ${rounds}.` })
      })
      this.#resetState(board.id, ticket.id, 'working', ticket.runId)
      return
    }
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (!stored) return
      stored.review = combined
      stored.stage = 'waiting'
      stored.waiting = {
        kind: 'repair-exhausted',
        reason: `Ревью: замечания после ${rounds} кругов починки.`,
        findings,
      }
      recordTicketEvent(draft, stored, { kind: 'status', text: `Ревью: замечания после ${rounds} кругов — нужен ваш выбор.` })
    })
    this.#dropActive(board.id, ticket.id)
  }

  /**
   * Merge several reviewer verdicts: any rework wins, unmet criteria win.
   * @param {object[]} reviews - parsed reviews.
   * @returns {object} combined review.
   */
  #combineReviews(reviews) {
    const verdict = reviews.some((review) => review.verdict === 'rework') ? 'rework' : reviews.every((review) => review.verdict === 'accept') ? 'accept' : 'missing'
    const blockers = []
    const important = []
    const minor = []
    const criteria = new Map()
    for (const review of reviews) {
      blockers.push(...review.blockers)
      important.push(...review.important)
      minor.push(...review.minor)
      for (const entry of review.criteria) {
        const key = entry.text.toLowerCase()
        const previous = criteria.get(key)
        criteria.set(key, { text: entry.text, met: previous?.met === false ? false : entry.met })
      }
    }
    return {
      verdict,
      blockers: [...new Set(blockers)].slice(0, 20),
      important: [...new Set(important)].slice(0, 20),
      minor: [...new Set(minor)].slice(0, 20),
      criteria: [...criteria.values()],
      reviews: reviews.length,
    }
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * The board, or a 404 error.
   * @param {string} boardId - board id.
   * @returns {object} board record.
   */
  #requireBoard(boardId) {
    const board = this.#store.get(String(boardId ?? ''))
    if (!board) throw new FactoryError('Доска фабрики не найдена.', 404, 'factory/unknown-board')
    return board
  }

  /**
   * One ticket of a board.
   * @param {object} board - board record.
   * @param {string} ticketId - ticket id.
   * @returns {object | undefined} ticket record.
   */
  #ticketIn(board, ticketId) {
    return (board?.tickets ?? []).find((ticket) => ticket.id === ticketId)
  }

  /**
   * Persist a board mutation and keep the pump in sync.
   * @param {string} boardId - board id.
   * @param {(draft: object) => void | Promise<void>} mutate - mutation.
   * @returns {Promise<object | undefined>} the stored board.
   */
  async #update(boardId, mutate) {
    const board = await this.#store.update(boardId, async (draft) => {
      draft.updatedAt = this.#now()
      await mutate(draft)
    })
    if (board) this.#ensurePump(board)
    return board
  }

  /**
   * The pipeline state map of a board.
   * @param {string} boardId - board id.
   * @returns {Map<string, object>} state map.
   */
  #activeOf(boardId) {
    let active = this.#active.get(boardId)
    if (!active) {
      active = new Map()
      this.#active.set(boardId, active)
    }
    return active
  }

  /**
   * A fresh pipeline state.
   * @param {string} stage - pipeline stage.
   * @param {string | null} [runId] - run to watch.
   * @returns {object} state.
   */
  #blankState(stage, runId = null) {
    return { stage, runId, cursor: 0, texts: [], questions: 0, appendedTests: false, appRunId: null, appCursor: 0, appTexts: [], reviewRuns: [], reviewIndex: 0, reviewRunId: null, reviewCursor: 0, reviewTexts: [], reviewRetried: false }
  }

  /**
   * Reset the watch state of a ticket after a new turn was sent to its run.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {string} stage - next stage.
   * @param {string | null} runId - run to watch.
   */
  #resetState(boardId, ticketId, stage, runId) {
    const previous = this.#active.get(boardId)?.get(ticketId) ?? {}
    this.#activeOf(boardId).set(ticketId, { ...this.#blankState(stage, runId), appendedTests: previous.appendedTests === true })
  }

  /**
   * Forget the pipeline state of a ticket.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   */
  #dropActive(boardId, ticketId) {
    this.#active.get(boardId)?.delete(ticketId)
    const board = this.#store.get(boardId)
    if (board && board.enabled !== true && (this.#active.get(boardId)?.size ?? 0) === 0) this.#stopPump(boardId)
  }

  /**
   * Daily counters roll over at midnight UTC.
   * @param {object} board - board record (mutated).
   */
  #dayReset(board) {
    const day = dayKey(this.#now())
    if (board.counters?.day === day) return
    board.counters = { day, started: 0, created: board.counters?.created ?? 0, merged: board.counters?.merged ?? 0 }
  }

  /**
   * Move a ticket to «Ждёт вас» with a reason.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {object} waiting - waiting record ({ kind, reason, ... }).
   */
  async #toWaiting(boardId, ticketId, waiting) {
    await this.#update(boardId, (draft) => {
      const stored = this.#ticketIn(draft, ticketId)
      if (!stored) return
      stored.stage = 'waiting'
      stored.waiting = waiting
      recordTicketEvent(draft, stored, { kind: 'status', text: `Ждёт вас: ${waitingLabel(waiting.kind)} — ${waiting.reason ?? ''}`.trim() })
    })
    this.#dropActive(boardId, ticketId)
  }

  /**
   * Mark a ticket failed because a pipeline step threw.
   * @param {string} boardId - board id.
   * @param {string} ticketId - ticket id.
   * @param {string} reason - what went wrong.
   */
  async #failTicket(boardId, ticketId, reason) {
    await this.#toWaiting(boardId, ticketId, { kind: 'nothing-to-run', reason })
  }

  /**
   * The current summary of a run, or null when it is not available anymore.
   * @param {string} runId - run id.
   * @returns {object | null} run summary.
   */
  #runOf(runId) {
    if (typeof runId !== 'string' || runId === '') return null
    try {
      return this.#engine.getRun(runId)
    } catch {
      return null
    }
  }

  /**
   * The changes of a run, or [] when the run has none.
   * @param {string} runId - run id.
   * @returns {Promise<object[]>} changes.
   */
  async #changesOf(runId) {
    try {
      const changes = await this.#engine.changes(runId)
      return Array.isArray(changes) ? changes : []
    } catch {
      return []
    }
  }

  /**
   * Release a staged run and its copy; a decided run is left alone.
   * @param {string} runId - run id.
   */
  async #discardRun(runId) {
    if (typeof runId !== 'string' || runId === '') return
    try {
      const run = this.#engine.getRun(runId)
      if (run.status === 'discarded' || run.status === 'applied') return
      await this.#engine.discard(runId)
    } catch {
      /* already decided or pruned: nothing to release */
    }
  }

  /**
   * The check/test command of a board: the configured one, else the suggestion
   * for the project, cached on the board.
   * @param {object} board - board record.
   * @returns {Promise<string | null>} command, or null when there is none.
   */
  async #testCommand(board) {
    const configured = typeof board.commands?.test === 'string' ? board.commands.test.trim() : ''
    if (configured !== '') return configured
    const fallback = typeof board.commands?.check === 'string' ? board.commands.check.trim() : ''
    if (fallback !== '') return fallback
    const suggested = await this.#suggestCommand(board)
    return suggested?.command ?? null
  }

  /**
   * Guess the project's check command.
   * @param {object} board - board record.
   * @returns {Promise<{ command: string, source: string } | null>} suggestion.
   */
  async #suggestCommand(board) {
    try {
      return await this.#callCheck('suggestCheckCommand', { projectPath: board.projectPath })
    } catch {
      return null
    }
  }

  /**
   * Call a helper of `lib/check.js` if it exists. A profile that installed an
   * older copy of the plugin must not break the whole board over one helper.
   * @param {string} name - exported helper name.
   * @param {object} input - helper input.
   * @returns {Promise<unknown>} helper result, or null when unavailable.
   */
  async #callCheck(name, input) {
    const helper = checkModule?.[name]
    if (typeof helper !== 'function') return null
    return helper(input)
  }

  /**
   * Whether a readiness probe passed; a board that never ran the check answers
   * false and the stage skips with a reason.
   * @param {object} board - board record.
   * @param {string} id - probe id.
   * @returns {boolean} probe state.
   */
  #readinessOk(board, id) {
    const check = (board.readiness?.checks ?? []).find((entry) => entry.id === id)
    return check?.ok === true
  }

  /**
   * Whether Playwright is installed in the project.
   * @param {object} board - board record.
   * @returns {Promise<boolean>} true when `@playwright/test` or `playwright` is available.
   */
  async #hasPlaywright(board) {
    try {
      const raw = await readFile(path.join(board.projectPath, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw)
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }
      if (deps['@playwright/test'] !== undefined || deps.playwright !== undefined) return true
    } catch {
      /* no package.json: fall through to node_modules */
    }
    for (const candidate of [['node_modules', '@playwright', 'test', 'package.json'], ['node_modules', 'playwright', 'package.json']]) {
      try {
        await access(path.join(board.projectPath, ...candidate))
        return true
      } catch {
        /* try the next location */
      }
    }
    return false
  }

  /**
   * Count the questions in a turn's assistant text: a line ending with `?` after
   * a line that reads like prose. One question gets the auto-answer, a second
   * parks the ticket.
   * @param {string} text - assistant text.
   * @returns {number} question marks at line ends.
   */
  #questionCount(text) {
    let count = 0
    for (const line of String(text ?? '').split(/\r?\n/)) {
      if (/\?\s*$/.test(line.trim()) && line.trim().length > 12) count += 1
    }
    return count
  }

  /**
   * Save base64 attachments of a new ticket under the state directory.
   * @param {object} board - board record.
   * @param {string} ticketId - ticket id.
   * @param {object[]} attachments - `{ name, data }` or `{ name, path }` entries.
   * @returns {Promise<object[]>} saved attachment records.
   */
  async #saveAttachments(board, ticketId, attachments) {
    const saved = []
    const list = Array.isArray(attachments) ? attachments.slice(0, MAX_TICKET_ATTACHMENTS) : []
    if (list.length === 0) return saved
    const dir = path.join(this.#stateDir, 'attachments', board.id, ticketId)
    for (const file of list) {
      const name = safeFileName(file?.name ?? 'file')
      if (typeof file?.data === 'string' && file.data !== '') {
        const bytes = Buffer.from(file.data, 'base64')
        if (bytes.byteLength > this.#tuning.maxAttachmentBytes) throw new FactoryError(`Файл «${name}» больше допустимого размера.`, 413, 'factory/attachment-too-large')
        await mkdir(dir, { recursive: true })
        const target = path.join(dir, name)
        await writeFile(target, bytes)
        saved.push({ name, path: target, bytes: bytes.byteLength })
        continue
      }
      if (typeof file?.path === 'string' && file.path !== '') saved.push({ name, path: path.resolve(file.path), bytes: file.bytes ?? null })
    }
    return saved
  }

  /**
   * The ticket text triage reads: the user's edit plus the answers they already
   * gave to a previous questionnaire.
   * @param {object} ticket - ticket record.
   * @returns {object} ticket-shaped prompt input.
   */
  #triageTicket(ticket) {
    return ticket
  }

  /**
   * Comment the pipeline result back into the source tracker issue when the
   * board asked for it.
   * @param {object} board - board record.
   * @param {object} ticket - ticket record.
   * @param {string} body - comment body.
   */
  async #commentBack(board, ticket, body) {
    if (!ticket.source?.externalId) return
    const tracker = (board.trackers ?? []).find((entry) => entry.kind === ticket.source.kind && entry.commentBack === true)
    if (!tracker) return
    const result = await trackerModule.commentTrackerIssue({ kind: ticket.source.kind, config: tracker.config ?? {}, externalId: ticket.source.externalId, body, exec: this.#exec })
    await this.#update(board.id, (draft) => {
      const stored = this.#ticketIn(draft, ticket.id)
      if (stored) recordTicketEvent(draft, stored, { kind: 'status', text: result.ok === true ? 'Комментарий отправлен в трекер.' : `Комментарий в трекер не ушёл: ${result.error}` })
    }).catch(() => {})
  }
}

export default {
  FactoryRunner,
  FactoryError,
  FACTORY_TUNING,
  runProgram,
}
