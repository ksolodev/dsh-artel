import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { FactoryRunner, FactoryError } from '../lib/factory-runner.js'
import { TicketStore } from '../lib/factory.js'

/**
 * Poll a predicate until it returns a truthy value.
 * @param {() => unknown | Promise<unknown>} predicate - the check.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<unknown>} the truthy value.
 */
async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const TRIAGE_TEXT = ['SPEC: Add a settings screen with a dark theme.', 'CRITERIA:', '- The settings screen opens.', '- The theme can be switched.', 'ROUTE: solo'].join('\n')
const TRIAGE_ORCHESTRATOR = TRIAGE_TEXT.replace('ROUTE: solo', 'ROUTE: orchestrator')
const REWORK_TEXT = 'VERDICT: rework\nBLOCKER: The header still shows the old theme.'

/**
 * A fake engine for the factory pipeline.
 */
class FakeEngine {
  /**
   * @param {{ copyRoot: string }} options - where the run copies live.
   */
  constructor({ copyRoot }) {
    this.copyRoot = copyRoot
    this.started = []
    this.calls = []
    this.runs = new Map()
    this.feeds = new Map()
    this.changesByRun = new Map()
    this.stale = new Set()
    this.nextId = 0
    this.defaultChanges = [{ path: 'src/app.js', status: 'modified', added: 1, removed: 1, hunks: [] }]
  }

  /**
   * Start a fake run.
   * @param {object} request - the engine start request.
   * @returns {Promise<object>} run summary.
   */
  async start(request) {
    this.calls.push({ method: 'start', request })
    const id = `frun-${(this.nextId += 1)}`
    const copyPath = path.join(this.copyRoot, id)
    await fs.mkdir(path.join(copyPath, 'src'), { recursive: true })
    await fs.writeFile(path.join(copyPath, 'src', 'app.js'), 'export const answer = 2\n')
    const run = {
      id,
      sessionId: request.sessionId,
      mode: request.mode,
      task: request.task,
      projectPath: request.projectPath,
      copyPath,
      basePath: request.basePath ?? null,
      status: 'running',
      error: null,
      changeCount: 1,
      autoqueue: request.autoqueue === true,
      planApproval: request.planApproval === true,
      planApproved: false,
      plan: null,
      agents: [],
    }
    this.runs.set(id, run)
    this.feeds.set(id, [])
    this.changesByRun.set(id, [...this.defaultChanges])
    this.started.push(run)
    return { ...run }
  }

  /**
   * @param {string} id - run id.
   * @returns {object} run summary.
   */
  getRun(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error(`unknown run ${id}`)
    return { ...run }
  }

  /**
   * @returns {Promise<object>} model catalog.
   */
  async models() {
    return { providers: [{ id: 'test', name: 'Test', models: [{ id: 'fast', name: 'Fast' }] }] }
  }

  /**
   * The feed page of a run. Mirrors the real engine: `readFeed` is async, so the
   * factory runner must await it.
   * @param {string} id - run id.
   * @param {{ cursor?: number }} options - read options.
   * @returns {Promise<{ runId: string, events: object[], cursor: number }>} feed page.
   */
  async readFeed(id, { cursor = 0 } = {}) {
    const events = this.feeds.get(id) ?? []
    return { runId: id, events: events.slice(cursor), cursor: events.length }
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<object[]>} changes.
   */
  async changes(id) {
    return [...(this.changesByRun.get(id) ?? [])]
  }

  /**
   * @param {string} id - run id.
   * @param {{ text: string }} message - prompt.
   * @returns {Promise<void>} resolves after the prompt.
   */
  async message(id, message) {
    this.calls.push({ method: 'message', runId: id, text: message?.text ?? '' })
    if (this.stale.has(id)) {
      const error = new Error('This run is no longer active')
      error.code = 'artel/not-live'
      error.status = 409
      throw error
    }
    const run = this.runs.get(id)
    if (run) run.status = 'running'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the interrupt.
   */
  async interrupt(id) {
    this.calls.push({ method: 'interrupt', runId: id })
    const run = this.runs.get(id)
    if (run) run.status = 'interrupted'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the apply.
   */
  async apply(id) {
    this.calls.push({ method: 'apply', runId: id })
    const run = this.runs.get(id)
    if (run) run.status = 'applied'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the discard.
   */
  async discard(id) {
    this.calls.push({ method: 'discard', runId: id })
    const run = this.runs.get(id)
    if (run) run.status = 'discarded'
  }

  /**
   * @param {string} id - run id.
   * @returns {Promise<void>} resolves after the approval.
   */
  async approvePlan(id) {
    this.calls.push({ method: 'approvePlan', runId: id })
    if (this.stale.has(id)) {
      const error = new Error('This run is no longer active')
      error.code = 'artel/not-live'
      error.status = 409
      throw error
    }
    const run = this.runs.get(id)
    if (run) {
      run.planApproved = true
      run.status = 'running'
    }
  }

  /**
   * Set the run status and extra fields.
   * @param {string} id - run id.
   * @param {string} status - new status.
   * @param {object} [extra] - extra fields.
   */
  setStatus(id, status, extra = {}) {
    const run = this.runs.get(id)
    Object.assign(run, { status }, extra)
  }

  /**
   * Append one feed event.
   * @param {string} id - run id.
   * @param {object} event - event.
   */
  pushFeed(id, event) {
    const feed = this.feeds.get(id)
    feed.push({ seq: feed.length + 1, kind: 'assistant', text: '', ...event })
  }

  /**
   * All recorded calls of one kind.
   * @param {string} method - method name.
   * @returns {object[]} calls.
   */
  findCall(method) {
    return this.calls.filter((call) => call.method === method)
  }
}

/**
 * Build the executable stub that answers git/gh calls without touching the real
 * tools. The state object lets a test break one command at a time.
 * @param {object} state - mutable exec state.
 * @returns {(command: string, args: string[], options?: object) => Promise<{ code: number, stdout: string, stderr: string }>} stub.
 */
function makeExec(state) {
  return async (command, args, options = {}) => {
    state.calls.push({ command, args: [...args], cwd: options?.cwd ?? '' })
    if (command === 'git') {
      const line = args.join(' ')
      if (line === 'rev-parse --is-inside-work-tree') return { code: state.gitOk ? 0 : 1, stdout: state.gitOk ? 'true\n' : '', stderr: state.gitOk ? '' : 'not a git repository' }
      if (line === 'rev-parse --verify HEAD') return { code: state.commitOk ? 0 : 1, stdout: state.commitOk ? 'abc123\n' : '', stderr: '' }
      if (line === 'status --porcelain') return { code: 0, stdout: state.dirty ? ' M src/app.js\n' : '', stderr: '' }
      if (line === 'remote') return { code: 0, stdout: state.remote ? 'origin\n' : '', stderr: '' }
      if (args[0] === 'checkout' && args[1] === '-b' && state.branchExists) return { code: 1, stdout: '', stderr: 'already exists' }
      if (args[0] === 'checkout' || args[0] === 'add') return { code: 0, stdout: '', stderr: '' }
      if (args.includes('commit')) return { code: state.failCommit ? 1 : 0, stdout: state.failCommit ? '' : '[main abc123] commit\n', stderr: state.failCommit ? 'fatal: unable to auto-detect email address' : '' }
      if (args[0] === 'push') return { code: state.pushOk ? 0 : 1, stdout: '', stderr: state.pushOk ? '' : 'rejected' }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'gh') {
      if (args[0] === 'issue') {
        if (!state.issueOk) return { code: 1, stdout: '', stderr: state.issueError ?? 'not logged in' }
        return { code: 0, stdout: JSON.stringify({ number: 12, title: 'Fix the login', body: 'The login button is dead', url: 'https://github.com/acme/repo/issues/12', labels: [] }), stderr: '' }
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        if (!state.prOk) return { code: 1, stdout: '', stderr: 'failed to create' }
        return { code: 0, stdout: 'https://github.com/acme/repo/pull/7\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/**
 * Build one isolated factory fixture.
 * @param {string} name - fixture name.
 * @param {{ gitProbe?: () => Promise<object> }} [options] - probe override.
 * @returns {Promise<object>} fixture.
 */
async function fixture(name, options = {}) {
  const root = path.join(process.cwd(), 'test', '.tmp', `factory-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  const projectPath = path.join(root, 'project')
  const stateDir = path.join(root, 'state')
  const copyRoot = path.join(root, 'copies')
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(0)"' } }))
  await fs.writeFile(path.join(projectPath, 'src', 'app.js'), 'export const answer = 1\n')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# Demo\n')
  await fs.mkdir(path.join(stateDir, 'tickets'), { recursive: true })
  await fs.mkdir(copyRoot, { recursive: true })
  const execState = { calls: [], gitOk: true, commitOk: true, dirty: false, remote: true, pushOk: true, prOk: true, issueOk: true, issueError: null, failCommit: false, branchExists: false }
  const engine = new FakeEngine({ copyRoot })
  const store = new TicketStore({ dir: path.join(stateDir, 'tickets') })
  await store.init()
  const runner = new FactoryRunner({
    engine,
    store,
    stateDir,
    tuning: { pollMs: 10, checkTimeoutMs: 5000, trackerPollMs: 10 * 60 * 1000 },
    exec: makeExec(execState),
    // Issue #13: the git binary is a separate readiness probe from the project
    // repository, so the stub answers it without touching the machine's git.
    gitProbe: typeof options.gitProbe === 'function' ? options.gitProbe : async () => ({ ok: true, version: '2.40.0', minimum: '2.30.0', reason: null }),
  })
  await runner.init()
  const settled = new Set()
  return {
    root,
    projectPath,
    stateDir,
    copyRoot,
    engine,
    store,
    runner,
    execState,
    settled,
    /**
     * Read the current ticket summary.
     * @param {string} boardId - board id.
     * @param {string} ticketId - ticket id.
     * @returns {Promise<object | undefined>} ticket summary.
     */
    ticketOf: async (boardId, ticketId) => {
      const view = await runner.view(boardId)
      return view.tickets.find((ticket) => ticket.id === ticketId)
    },
    /**
     * Stop the pipeline and remove the fixture directory.
     * @returns {Promise<void>} resolves when clean.
     */
    cleanup: async () => {
      runner.dispose()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Wait until a ticket satisfies a predicate.
 * @param {object} f - fixture.
 * @param {string} boardId - board id.
 * @param {string} ticketId - ticket id.
 * @param {(ticket: object) => boolean} predicate - the check.
 * @returns {Promise<object>} ticket summary.
 */
function waitTicket(f, boardId, ticketId, predicate) {
  return waitFor(async () => {
    const ticket = await f.ticketOf(boardId, ticketId)
    return ticket && predicate(ticket) ? ticket : null
  })
}

/**
 * Wait for the next not-yet-settled run matching a predicate.
 * @param {object} f - fixture.
 * @param {(run: object) => boolean} predicate - the check.
 * @returns {Promise<object>} run record.
 */
function takeRun(f, predicate) {
  return waitFor(() => f.engine.started.find((run) => !f.settled.has(run.id) && predicate(run)))
}

/**
 * Finish a run: append its final assistant text and mark it settled.
 * @param {object} f - fixture.
 * @param {object} run - run record.
 * @param {string} [text] - assistant text.
 * @returns {Promise<void>} resolves when finished.
 */
async function settleRun(f, run, text = '') {
  if (text !== '') f.engine.pushFeed(run.id, { kind: 'assistant', text })
  f.engine.setStatus(run.id, 'finished', { changeCount: run.changeCount ?? 1 })
  f.settled.add(run.id)
}

/**
 * Create a board, configure it and add one ticket.
 * @param {object} f - fixture.
 * @param {object} [input] - ticket and board fields.
 * @returns {Promise<{ boardId: string, ticketId: string }>} ids.
 */
async function createTicket(f, input = {}) {
  const created = await f.runner.createBoard({ projectPath: f.projectPath, name: 'Demo' })
  const boardId = created.board.id
  await f.runner.updateBoard(boardId, {
    commands: { test: 'node -e "process.exit(0)"', preview: 'npm run dev' },
    ...(input.settings ?? {}),
  })
  const ticket = await f.runner.addTicket(boardId, {
    title: input.title ?? 'Add the settings screen',
    text: input.text ?? 'Add a settings screen with a dark theme.',
    attachments: input.attachments,
    source: input.source,
  })
  return { boardId, ticketId: ticket.id }
}

/**
 * Enable a board and wait until its ticket is being triaged.
 * @param {object} f - fixture.
 * @param {string} boardId - board id.
 * @param {string} ticketId - ticket id.
 * @returns {Promise<object>} the triage run.
 */
async function startTriage(f, boardId, ticketId) {
  await f.runner.updateBoard(boardId, { enabled: true })
  return takeRun(f, (run) => run.sessionId === `factory-${boardId}-${ticketId}`)
}

/**
 * Drive a ticket from triage to the first review run.
 * @param {object} f - fixture.
 * @param {string} boardId - board id.
 * @param {string} ticketId - ticket id.
 * @returns {Promise<{ triage: object, work: object, review: object }>} runs.
 */
async function pipelineToReview(f, boardId, ticketId) {
  const triage = await startTriage(f, boardId, ticketId)
  await settleRun(f, triage, TRIAGE_TEXT)
  const work = await takeRun(f, (run) => run.autoqueue === true)
  await settleRun(f, work)
  const review = await takeRun(f, (run) => run.sessionId.endsWith('-review-0'))
  return { triage, work, review }
}

/**
 * Drive a ticket all the way to «Готово к PR».
 * @param {object} f - fixture.
 * @param {string} boardId - board id.
 * @param {string} ticketId - ticket id.
 * @returns {Promise<{ triage: object, work: object, review: object, ticket: object }>} runs and the ready ticket.
 */
async function pipelineToReady(f, boardId, ticketId) {
  const runs = await pipelineToReview(f, boardId, ticketId)
  await settleRun(f, runs.review, 'VERDICT: accept\nBLOCKER: none')
  const ticket = await waitTicket(f, boardId, ticketId, (item) => item.stage === 'ready')
  return { ...runs, ticket }
}

/**
 * Drive a ticket through three rework rounds until the repair budget is gone.
 * @param {object} f - fixture.
 * @param {string} boardId - board id.
 * @param {string} ticketId - ticket id.
 * @returns {Promise<{ work: object, ticket: object }>} work run and waiting ticket.
 */
async function exhaustRepairs(f, boardId, ticketId) {
  const runs = await pipelineToReview(f, boardId, ticketId)
  let review = runs.review
  for (let round = 1; round <= 2; round += 1) {
    await settleRun(f, review, REWORK_TEXT)
    await waitFor(() => f.engine.runs.get(runs.work.id).status === 'running')
    await waitTicket(f, boardId, ticketId, (ticket) => ticket.repairRound === round)
    await settleRun(f, runs.work)
    review = await takeRun(f, (run) => run.sessionId.endsWith('-review-0'))
  }
  await settleRun(f, review, REWORK_TEXT)
  const ticket = await waitTicket(f, boardId, ticketId, (item) => item.waiting?.kind === 'repair-exhausted')
  return { work: runs.work, ticket }
}

test('createBoard makes one board per project', async () => {
  const f = await fixture('boards')
  try {
    const first = await f.runner.createBoard({ projectPath: f.projectPath })
    assert.equal(first.created, true)
    assert.equal(first.board.enabled, false)
    assert.equal(first.board.template, 'normal')
    assert.equal(first.board.name, 'Проект')
    assert.equal(first.board.projectPath, f.projectPath)

    const second = await f.runner.createBoard({ projectPath: f.projectPath, name: 'Other' })
    assert.equal(second.created, false)
    assert.equal(second.board.id, first.board.id)
    assert.equal(f.runner.listBoards().length, 1)

    const view = await f.runner.view(first.board.id)
    assert.equal(view.board.id, first.board.id)
    assert.deepEqual(view.tickets, [])

    // A board of a folder that does not exist can never run, so it is refused.
    await assert.rejects(f.runner.createBoard({ projectPath: path.join(f.projectPath, 'no-such-folder') }), (error) => {
      assert.equal(error.code, 'factory/bad-project')
      assert.equal(error.status, 400)
      return true
    })
  } finally {
    await f.cleanup()
  }
})

test('updateBoard rejects unusable settings', async () => {
  const f = await fixture('settings')
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const boardId = created.board.id
    await assert.rejects(
      () => f.runner.updateBoard(boardId, { template: 'turbo' }),
      (error) => error instanceof FactoryError && error.status === 400 && error.code === 'factory/bad-settings',
    )
    await assert.rejects(
      () => f.runner.updateBoard(boardId, { limits: { ticketsAtOnce: 0 } }),
      (error) => error instanceof FactoryError && error.status === 400 && error.code === 'factory/bad-settings',
    )
    await assert.rejects(
      () => f.runner.updateBoard('b-missing', {}),
      (error) => error instanceof FactoryError && error.status === 404 && error.code === 'factory/unknown-board',
    )
  } finally {
    await f.cleanup()
  }
})

test('checkReadiness reports its probes and enabling needs a passing readiness', async () => {
  const f = await fixture('readiness')
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const boardId = created.board.id

    f.execState.gitOk = false
    await assert.rejects(
      () => f.runner.updateBoard(boardId, { enabled: true }),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/not-ready',
    )
    assert.equal(f.store.get(boardId).enabled, false)

    f.execState.gitOk = true
    const result = await f.runner.checkReadiness(boardId)
    assert.equal(result.readiness.ready, true)
    // Issue #13: the git binary and the project repository are two checks, so a
    // machine without git is not told to run `git init`.
    assert.deepEqual(
      result.readiness.checks.map((check) => check.id),
      ['git', 'repo', 'commit', 'engines', 'testCommand', 'preview', 'playwright'],
    )
    assert.equal(result.readiness.checks.find((check) => check.id === 'git').ok, true)
    assert.equal(result.readiness.checks.find((check) => check.id === 'repo').ok, true)
    assert.equal(result.board.readiness.ready, true)
    assert.ok(f.execState.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'rev-parse --is-inside-work-tree'))
    assert.ok(f.execState.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'rev-parse --verify HEAD'))

    const enabled = await f.runner.updateBoard(boardId, { enabled: true })
    assert.equal(enabled.enabled, true)
  } finally {
    await f.cleanup()
  }
})

test('checkReadiness blames git, not the project, when the binary is missing', async () => {
  const f = await fixture('readiness-no-git', {
    gitProbe: async () => ({ ok: false, version: null, minimum: '2.30.0', reason: 'missing', detail: 'spawn git ENOENT' }),
  })
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const result = await f.runner.checkReadiness(created.board.id)
    const git = result.readiness.checks.find((check) => check.id === 'git')
    const repo = result.readiness.checks.find((check) => check.id === 'repo')
    assert.equal(git.ok, false)
    assert.equal(git.reason, 'missing')
    assert.match(git.hint, /Install Git/)
    assert.equal(repo.ok, false)
    assert.equal(repo.reason, 'no-git')
    await assert.rejects(
      () => f.runner.updateBoard(created.board.id, { enabled: true }),
      (error) => error instanceof FactoryError && error.code === 'factory/not-ready' && /Install Git/.test(error.message) && !/git init/.test(error.message),
    )
  } finally {
    await f.cleanup()
  }
})

test('addTicket numbers tickets, rejects duplicates and empty tickets', async () => {
  const f = await fixture('tickets')
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const boardId = created.board.id
    const first = await f.runner.addTicket(boardId, {
      title: 'Add the settings screen',
      text: 'The screen needs a dark theme.',
      attachments: [{ name: 'note.txt', data: Buffer.from('hello').toString('base64') }],
    })
    assert.equal(first.number, 1)
    assert.equal(first.stage, 'incoming')
    assert.equal(first.boardId, boardId)
    assert.equal(first.attachments.length, 1)
    assert.equal(first.attachments[0].name, 'note.txt')
    assert.equal(first.attachments[0].bytes, 5)
    assert.equal(await fs.readFile(first.attachments[0].path, 'utf8'), 'hello')

    const second = await f.runner.addTicket(boardId, { title: 'Fix the login', text: 'The button is dead.' })
    assert.equal(second.number, 2)
    assert.equal(f.store.get(boardId).ticketSeq, 2)

    await assert.rejects(
      () => f.runner.addTicket(boardId, { title: '  ', text: '   ' }),
      (error) => error instanceof FactoryError && error.status === 400 && error.code === 'factory/empty-ticket',
    )

    const source = { kind: 'github', externalId: 'gh:acme/repo#5', url: 'https://github.com/acme/repo/issues/5' }
    await f.runner.addTicket(boardId, { title: 'Imported once', text: 'Body.', source })
    await assert.rejects(
      () => f.runner.addTicket(boardId, { title: 'Imported twice', text: 'Body.', source }),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/duplicate-ticket',
    )
  } finally {
    await f.cleanup()
  }
})

test('importGithubIssue turns one issue into a ticket exactly once', async () => {
  const f = await fixture('import-ok')
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const boardId = created.board.id
    const ticket = await f.runner.importGithubIssue(boardId, 'acme/repo#12')
    assert.equal(ticket.number, 1)
    assert.equal(ticket.title, 'Fix the login')
    assert.equal(ticket.source.kind, 'github')
    assert.equal(ticket.source.url, 'https://github.com/acme/repo/issues/12')
    assert.equal(ticket.source.externalId, 'gh:acme/repo#12')
    const call = f.execState.calls.find((entry) => entry.command === 'gh' && entry.args[0] === 'issue')
    assert.ok(call.args.includes('-R'), 'an owner/repo reference is pinned with -R')
    assert.equal(call.args[call.args.indexOf('-R') + 1], 'acme/repo')

    // A short `#12` resolves to the same repository through the issue URL, so
    // the second import is refused instead of opening a duplicate (#25).
    await assert.rejects(
      () => f.runner.importGithubIssue(boardId, '#12'),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/duplicate-ticket',
    )
    await assert.rejects(
      () => f.runner.importGithubIssue(boardId, 'acme/repo#12'),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/duplicate-ticket',
    )
  } finally {
    await f.cleanup()
  }
})

test('importGithubIssue names the reason a gh lookup failed', async () => {
  const f = await fixture('import')
  try {
    const created = await f.runner.createBoard({ projectPath: f.projectPath })
    const boardId = created.board.id
    await assert.rejects(
      () => f.runner.importGithubIssue(boardId, 'nonsense'),
      (error) => error instanceof FactoryError
        && error.status === 400
        && error.code === 'factory/bad-issue-ref'
        && error.key === 'factory.error.bad-issue-ref'
        && error.params !== null,
    )

    const cases = [
      ['not logged in', 'factory/gh-auth'],
      ['spawn gh ENOENT', 'factory/gh-missing'],
      ["'gh' is not recognized as an internal or external command", 'factory/gh-missing'],
      ['Could not resolve to a Repository with the name acme/missing.', 'factory/repo-not-found'],
      ['Could not resolve to an issue or pull request with the number of 12.', 'factory/issue-not-found'],
      ['HTTP 404: Not Found', 'factory/issue-not-found'],
      ['something went wrong', 'factory/issue-unavailable'],
    ]
    f.execState.issueOk = false
    for (const [stderr, code] of cases) {
      f.execState.issueError = stderr
      await assert.rejects(
        () => f.runner.importGithubIssue(boardId, '#12'),
        (error) => error instanceof FactoryError && error.code === code && typeof error.key === 'string' && error.key.startsWith('factory.error.'),
        stderr,
      )
    }
    f.execState.issueError = 'Could not resolve to an issue or pull request with the number of 12.'
    await assert.rejects(
      () => f.runner.importGithubIssue(boardId, '#12'),
      (error) => error instanceof FactoryError
        && error.code === 'factory/issue-not-found'
        && error.key === 'factory.error.issue-not-found'
        && error.params.ref === '#12',
    )
    assert.ok(f.execState.calls.some((call) => call.command === 'gh' && call.args[0] === 'issue' && call.args.includes('12')))
  } finally {
    await f.cleanup()
  }
})

test('the happy path moves a ticket from incoming to ready', async () => {
  const f = await fixture('happy')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReview(f, boardId, ticketId)

    const triageRequest = f.engine.findCall('start')[0].request
    assert.equal(triageRequest.mode, 'solo')
    assert.equal(triageRequest.sandboxMode, 'read-only')
    assert.equal(triageRequest.autoqueue, undefined)
    assert.match(triageRequest.task, /Add the settings screen/)
    assert.match(triageRequest.task, /THE TICKET #1/)

    const workRequest = f.engine.findCall('start')[1].request
    assert.equal(workRequest.mode, 'solo')
    assert.equal(workRequest.autoqueue, true)
    assert.equal(workRequest.sessionId, triageRequest.sessionId)

    const reviewRequest = f.engine.findCall('start')[2].request
    assert.equal(reviewRequest.mode, 'solo')
    assert.equal(reviewRequest.sandboxMode, 'read-only')
    assert.equal(reviewRequest.basePath, runs.work.copyPath)
    assert.match(reviewRequest.sessionId, /-review-0$/)

    const triaged = await waitTicket(f, boardId, ticketId, (ticket) => ticket.stage === 'tests' || ticket.stage === 'check' || ticket.stage === 'review')
    assert.equal(triaged.spec.criteria.length, 2)
    assert.equal(triaged.route.mode, 'solo')

    await settleRun(f, runs.review, 'VERDICT: accept\nBLOCKER: none')
    const ticket = await waitTicket(f, boardId, ticketId, (item) => item.stage === 'ready')
    assert.equal(ticket.review.verdict, 'accept')
    assert.equal(ticket.check.tests.ok, true)
    assert.equal(ticket.check.app.verdict, 'skip')
    assert.match(ticket.check.app.reason, /Playwright/)
    const workVersion = ticket.versions.find((version) => version.runId === runs.work.id)
    assert.equal(workVersion.title, ticket.title, 'a version carries the ticket title')
    assert.equal(workVersion.changeCount, 1, 'a version carries the size of its own change')
    const discarded = f.engine.findCall('discard').map((call) => call.runId)
    assert.ok(discarded.includes(runs.triage.id))
    assert.ok(discarded.includes(runs.review.id))
  } finally {
    await f.cleanup()
  }
})

test('review rework sends the repair prompt to the work run and increments the round', async () => {
  const f = await fixture('rework')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReview(f, boardId, ticketId)
    await settleRun(f, runs.review, REWORK_TEXT)

    const message = await waitFor(() => f.engine.findCall('message').find((call) => call.runId === runs.work.id))
    assert.match(message.text, /The header still shows the old theme/)
    const repaired = await waitTicket(f, boardId, ticketId, (ticket) => ticket.repairRound === 1)
    assert.equal(repaired.stage, 'working')

    await waitFor(() => f.engine.runs.get(runs.work.id).status === 'running')
    await settleRun(f, runs.work)
    const nextReview = await takeRun(f, (run) => run.sessionId.endsWith('-review-0'))
    await settleRun(f, nextReview, 'VERDICT: accept\nBLOCKER: none')
    const ticket = await waitTicket(f, boardId, ticketId, (item) => item.stage === 'ready')
    assert.equal(ticket.review.verdict, 'accept')
  } finally {
    await f.cleanup()
  }
})

test('repair exhaustion waits for the user and "more" resumes the work', async () => {
  const f = await fixture('repair-more')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const { work, ticket: waiting } = await exhaustRepairs(f, boardId, ticketId)
    assert.equal(waiting.stage, 'waiting')
    assert.equal(waiting.waiting.kind, 'repair-exhausted')
    assert.ok(waiting.waiting.findings.length > 0)

    const resumed = await f.runner.repairAction(boardId, ticketId, { action: 'more' })
    assert.equal(resumed.stage, 'working')
    assert.equal(resumed.repairRound, 3)
    const message = f.engine.findCall('message').find((call) => call.runId === work.id)
    assert.ok(message)

    await waitFor(() => f.engine.runs.get(work.id).status === 'running')
    await settleRun(f, work)
    const nextReview = await takeRun(f, (run) => run.sessionId.endsWith('-review-0'))
    await settleRun(f, nextReview, 'VERDICT: accept\nBLOCKER: none')
    const ready = await waitTicket(f, boardId, ticketId, (item) => item.stage === 'ready')
    assert.equal(ready.stage, 'ready')
  } finally {
    await f.cleanup()
  }
})

test('repair exhaustion can be accepted or postponed', async () => {
  const f = await fixture('repair-decide')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const { ticket } = await exhaustRepairs(f, boardId, ticketId)
    assert.equal(ticket.waiting.kind, 'repair-exhausted')

    const accepted = await f.runner.repairAction(boardId, ticketId, { action: 'accept' })
    assert.equal(accepted.stage, 'ready')
    assert.equal(accepted.waiting, null)
  } finally {
    await f.cleanup()
  }

  const g = await fixture('repair-postpone')
  try {
    const { boardId, ticketId } = await createTicket(g)
    await exhaustRepairs(g, boardId, ticketId)
    const postponed = await g.runner.repairAction(boardId, ticketId, { action: 'postpone' })
    assert.equal(postponed.stage, 'waiting')
    assert.equal(postponed.waiting.kind, 'postponed')
  } finally {
    await g.cleanup()
  }
})

test('triage questions wait for the user and the answers send the ticket back', async () => {
  const f = await fixture('triage-questions')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, 'SPEC: Add a settings screen.\nQUESTION: Which theme should the settings screen use?')
    const waiting = await waitTicket(f, boardId, ticketId, (ticket) => ticket.waiting?.kind === 'triage-questions')
    assert.equal(waiting.stage, 'waiting')
    assert.equal(waiting.waiting.reasonKey, 'factory.waiting.triage-questions')
    assert.deepEqual(waiting.waiting.reasonParams, { count: 1 })
    assert.match(waiting.waiting.questions[0], /Which theme/)

    const answered = await f.runner.answerQuestions(boardId, ticketId, { answers: ['Dark theme'] })
    assert.equal(answered.stage, 'incoming')
    assert.equal(answered.waiting, null)
    assert.match(answered.text, /Dark theme/)
  } finally {
    await f.cleanup()
  }
})

test('answerQuestions resumes an interrupted working run', async () => {
  const f = await fixture('interrupted')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, TRIAGE_TEXT)
    const work = await takeRun(f, (run) => run.autoqueue === true)
    f.engine.setStatus(work.id, 'interrupted', { error: 'The run was interrupted.' })
    const waiting = await waitTicket(f, boardId, ticketId, (ticket) => ticket.waiting?.kind === 'interrupted')
    assert.equal(waiting.stage, 'waiting')

    const answered = await f.runner.answerQuestions(boardId, ticketId, { text: 'Continue please' })
    assert.equal(answered.stage, 'working')
    await waitFor(() => f.engine.findCall('message').find((call) => call.runId === work.id && call.text === 'Continue please'))
  } finally {
    await f.cleanup()
  }
})

test('returnToFactory resets a waiting ticket to incoming', async () => {
  const f = await fixture('return')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, TRIAGE_TEXT)
    const work = await takeRun(f, (run) => run.autoqueue === true)
    f.engine.setStatus(work.id, 'interrupted', { error: 'The run was interrupted.' })
    await waitTicket(f, boardId, ticketId, (ticket) => ticket.waiting?.kind === 'interrupted')

    const returned = await f.runner.returnToFactory(boardId, ticketId)
    assert.equal(returned.stage, 'incoming')
    assert.equal(returned.runId, null)
    assert.equal(returned.triageRunId, null)
    assert.equal(returned.spec, null)
    assert.equal(returned.route, null)
    assert.ok(f.engine.findCall('discard').some((call) => call.runId === work.id))
  } finally {
    await f.cleanup()
  }
})

test('takeOver stops a live work run and parks the ticket as postponed', async () => {
  const f = await fixture('takeover')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, TRIAGE_TEXT)
    const work = await takeRun(f, (run) => run.autoqueue === true)

    const ticket = await f.runner.takeOver(boardId, ticketId)
    assert.equal(ticket.stage, 'waiting')
    assert.equal(ticket.waiting.kind, 'postponed')
    assert.ok(f.engine.findCall('interrupt').some((call) => call.runId === work.id))
    assert.ok(Array.isArray(ticket.versions) && ticket.versions.some((version) => version.runId === work.id), 'the work run is recorded as a version')
    const view = await f.runner.view(boardId)
    assert.ok(view.board.events.some((event) => /Взято вручную/.test(event.text)))
  } finally {
    await f.cleanup()
  }
})

test('returnWithComment sends the comment back to the work run', async () => {
  const f = await fixture('comment')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    const ticket = await f.runner.returnWithComment(boardId, ticketId, { comment: 'Please fix the header spacing.' })
    assert.equal(ticket.stage, 'working')
    await waitFor(() => f.engine.findCall('message').find((call) => call.runId === runs.work.id && /Please fix the header spacing/.test(call.text)))
  } finally {
    await f.cleanup()
  }
})

test('returnWithComment starts a fresh version when the old run is no longer live (#29)', async () => {
  const f = await fixture('comment-restart')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    // A DSH restart leaves the stored run behind but not its live runtime.
    f.engine.stale.add(runs.work.id)
    const starts = f.engine.findCall('start').length

    const ticket = await f.runner.returnWithComment(boardId, ticketId, { comment: 'Please fix the header spacing.' })

    assert.equal(ticket.stage, 'working')
    assert.notEqual(ticket.runId, runs.work.id, 'a new version is started')
    const started = f.engine.findCall('start')
    assert.equal(started.length, starts + 1, 'exactly one new work run is started')
    const restart = started[started.length - 1].request
    assert.equal(restart.basePath, runs.work.copyPath, 'the new version grows from the last copy')
    assert.match(restart.task, /Please fix the header spacing/)
    const updated = await f.ticketOf(boardId, ticketId)
    assert.ok(updated.versions.some((version) => version.runId === ticket.runId), 'the new run is recorded as a version')
  } finally {
    await f.cleanup()
  }
})

test('approvePlan starts a new version when the plan run died with a restart (#31)', async () => {
  const f = await fixture('plan-restart')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, TRIAGE_ORCHESTRATOR)
    const work = await takeRun(f, (run) => run.autoqueue === true)
    assert.equal(work.planApproval, true, 'the orchestrator work run carries the approval gate')
    f.engine.setStatus(work.id, 'waiting', { planApproval: true, planApproved: false, plan: { parts: [{ id: 'p1', title: 'Part one' }] } })
    const gated = await waitTicket(f, boardId, ticketId, (ticket) => ticket.waiting?.kind === 'plan')
    assert.equal(gated.stage, 'waiting')

    // A DSH restart leaves the stored plan run behind but not its live runtime.
    f.engine.stale.add(work.id)
    const starts = f.engine.findCall('start').length
    const ticket = await f.runner.approvePlan(boardId, ticketId)

    assert.equal(ticket.stage, 'working', 'the ticket is not parked on the dead run')
    assert.equal(ticket.waiting, null)
    assert.notEqual(ticket.runId, work.id, 'a new version is started')
    const started = f.engine.findCall('start')
    assert.equal(started.length, starts + 1, 'exactly one new work run is started')
    assert.equal(started[started.length - 1].request.planApproval, true, 'the fresh orchestrator version asks for the plan again')
    assert.ok(ticket.events.some((event) => event.key === 'factory.event.plan-restarted'), 'the card explains the restart')
    const updated = await f.ticketOf(boardId, ticketId)
    assert.ok(updated.versions.some((version) => version.runId === ticket.runId), 'the new run is recorded as a version')
  } finally {
    await f.cleanup()
  }
})

test('openPullRequest rejects a dirty worktree', async () => {
  const f = await fixture('dirty')
  try {
    const { boardId, ticketId } = await createTicket(f)
    await pipelineToReady(f, boardId, ticketId)
    f.execState.dirty = true
    await assert.rejects(
      () => f.runner.openPullRequest(boardId, ticketId),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/dirty-tree',
    )
  } finally {
    await f.cleanup()
  }
})

test('openPullRequest applies the version, pushes a branch and opens the PR', async () => {
  const f = await fixture('pull-request')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    f.execState.calls.length = 0

    const ticket = await f.runner.openPullRequest(boardId, ticketId)
    assert.equal(ticket.stage, 'done')
    assert.equal(ticket.branch, 'factory/ticket-1')
    assert.equal(ticket.pr.url, 'https://github.com/acme/repo/pull/7')
    assert.equal(ticket.pr.error, null)
    assert.ok(f.engine.findCall('apply').some((call) => call.runId === runs.work.id))

    const lines = f.execState.calls.map((call) => `${call.command} ${call.args.join(' ')}`)
    assert.equal(lines[0], 'git status --porcelain')
    assert.equal(lines[1], 'git remote')
    assert.equal(lines[2], 'git checkout -b factory/ticket-1')
    assert.equal(lines[3], 'git add -A')
    assert.equal(lines[4], `git -c user.name=Artel -c user.email=artel@artel.invalid commit -m #1 ${ticket.title}`)
    assert.equal(lines[5], 'git push -u origin factory/ticket-1')
    assert.match(lines[6], /^gh pr create --title #1 /)
  } finally {
    await f.cleanup()
  }
})

test('openPullRequest resumes a retry after the version was already applied (#36)', async () => {
  const f = await fixture('pull-request-retry')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    f.execState.calls.length = 0
    // The first attempt applies the version and then fails at the commit: this
    // is exactly the dead end of issue #36.
    f.execState.failCommit = true
    await assert.rejects(
      () => f.runner.openPullRequest(boardId, ticketId),
      (error) => error instanceof FactoryError && error.status === 409 && error.code === 'factory/git-failed',
    )
    assert.equal((await f.ticketOf(boardId, ticketId)).stage, 'ready')
    assert.equal(f.engine.getRun(runs.work.id).status, 'applied')
    assert.equal(f.engine.findCall('apply').length, 1)

    // The retry finds the applied changes in the worktree and the branch the
    // failed attempt created; it commits and pushes instead of applying again.
    f.execState.failCommit = false
    f.execState.dirty = true
    f.execState.branchExists = true
    f.execState.calls.length = 0
    const ticket = await f.runner.openPullRequest(boardId, ticketId)
    assert.equal(ticket.stage, 'done')
    assert.equal(ticket.branch, 'factory/ticket-1')
    assert.equal(ticket.pr.url, 'https://github.com/acme/repo/pull/7')
    assert.equal(ticket.pr.error, null)
    assert.equal(f.engine.findCall('apply').length, 1, 'the retry must not apply the version a second time')
    const lines = f.execState.calls.map((call) => `${call.command} ${call.args.join(' ')}`)
    assert.ok(lines.includes('git checkout factory/ticket-1'), 'the existing branch is reused')
    assert.ok(lines.includes(`git -c user.name=Artel -c user.email=artel@artel.invalid commit -m #1 ${ticket.title}`))
    assert.ok(lines.includes('git push -u origin factory/ticket-1'))
  } finally {
    await f.cleanup()
  }
})

test('mergeTicket finishes a ticket whose version is already applied (#36)', async () => {
  const f = await fixture('merge-applied')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    // The earlier attempt applied the version and then its outward step failed.
    await f.engine.apply(runs.work.id)
    const ticket = await f.runner.mergeTicket(boardId, ticketId)
    assert.equal(ticket.stage, 'done')
    const view = await f.runner.view(boardId)
    assert.equal(view.board.counters.merged, 1)
    assert.equal(f.engine.findCall('apply').length, 1, 'merge must not apply an applied version again')
  } finally {
    await f.cleanup()
  }
})

test('mergeTicket applies the run and counts the merge', async () => {
  const f = await fixture('merge')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const runs = await pipelineToReady(f, boardId, ticketId)
    const ticket = await f.runner.mergeTicket(boardId, ticketId)
    assert.equal(ticket.stage, 'done')
    assert.ok(f.engine.findCall('apply').some((call) => call.runId === runs.work.id))
    const view = await f.runner.view(boardId)
    assert.equal(view.board.counters.merged, 1)
  } finally {
    await f.cleanup()
  }
})

test('a paused board finishes active tickets but starts no new ones', async () => {
  const f = await fixture('paused')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await f.runner.updateBoard(boardId, { paused: true })
    const second = await f.runner.addTicket(boardId, { title: 'Second ticket', text: 'Should wait for the user.' })

    await settleRun(f, triage, TRIAGE_TEXT)
    await takeRun(f, (run) => run.autoqueue === true)
    const secondTicket = await f.ticketOf(boardId, second.id)
    assert.equal(secondTicket.stage, 'incoming')
    assert.equal(f.engine.started.filter((run) => run.sessionId === `factory-${boardId}-${second.id}`).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('ticketsAtOnce limits how many tickets are triaged at the same time', async () => {
  const f = await fixture('at-once')
  try {
    const first = await createTicket(f, { settings: { limits: { workersPerTicket: 1, ticketsAtOnce: 1, ticketsPerDay: 20 } } })
    const second = await f.runner.addTicket(first.boardId, { title: 'Another ticket', text: 'One more thing.' })
    await f.runner.updateBoard(first.boardId, { enabled: true })

    await takeRun(f, (run) => run.sessionId === `factory-${first.boardId}-${first.ticketId}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const triageStarts = f.engine.started.filter((run) => run.sessionId.startsWith(`factory-${first.boardId}-`))
    assert.equal(triageStarts.length, 1)
    const waiting = await f.ticketOf(first.boardId, second.id)
    assert.equal(waiting.stage, 'incoming')
  } finally {
    await f.cleanup()
  }
})

test('ticketView returns the waited run feed instead of an unresolved Promise', async () => {
  const f = await fixture('ticket-view')
  try {
    const { boardId, ticketId } = await createTicket(f)
    const triage = await startTriage(f, boardId, ticketId)
    await settleRun(f, triage, TRIAGE_TEXT)
    const work = await takeRun(f, (run) => run.autoqueue === true)
    f.engine.pushFeed(work.id, { kind: 'assistant', text: 'Working on the settings screen.' })

    const view = await f.runner.ticketView(boardId, ticketId)
    assert.equal(view.ticket.id, ticketId)
    assert.ok(
      view.feed.some((event) => event.kind === 'assistant' && event.text === 'Working on the settings screen.'),
      'the feed page is awaited, not dropped as a Promise',
    )
  } finally {
    await f.cleanup()
  }
})
