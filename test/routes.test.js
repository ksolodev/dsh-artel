import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { registerArtelRoutes, registerFactoryRoutes, registerQueueRoutes, API_PREFIX } from '../lib/routes.js'

/** The canonical project key the routes compute (realpath, lowercased on Windows). */
async function projectKeyFor(directory) {
  const resolved = path.resolve(directory)
  let canonical = resolved
  try {
    canonical = await fs.realpath(resolved)
  } catch {
    // the directory may not exist yet; path.resolve is the documented fallback
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** Fake Host web server that keeps the routes it was given. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** A run summary as the engine returns it (plain object, no wrapper). */
function summary(overrides = {}) {
  return {
    id: 'fg-1',
    sessionId: 'session-1',
    mode: 'solo',
    task: 'Add a settings screen',
    projectPath: 'C:\\work\\app',
    copyPath: 'C:\\data\\copies\\fg-1',
    status: 'waiting',
    error: null,
    agents: [{ id: 'fg-1-a1', name: 'Vega', role: 'solo', status: 'idle', claimed: [], sessionId: 'session-a1' }],
    createdAt: 1,
    updatedAt: 2,
    finishedAt: null,
    appliedAt: null,
    changeCount: 1,
    ...overrides,
  }
}

/** Fake engine recording what the routes asked for. */
function fakeEngine() {
  const calls = []
  const engine = {
    calls,
    listRuns(sessionId) {
      calls.push({ method: 'listRuns', sessionId })
      return [summary()]
    },
    getRun(runId) {
      calls.push({ method: 'getRun', runId })
      return summary({ id: runId })
    },
    async readFeed(runId, options) {
      calls.push({ method: 'readFeed', runId, options })
      return { events: [{ seq: 1, at: 10, kind: 'status', text: 'Working' }], cursor: 1 }
    },
    async start(request) {
      calls.push({ method: 'start', request })
      return summary({ status: 'running' })
    },
    async message(runId, message) {
      calls.push({ method: 'message', runId, message })
      return summary({ id: runId, status: 'running' })
    },
    async interrupt(runId) {
      calls.push({ method: 'interrupt', runId })
      return summary({ id: runId, status: 'interrupted' })
    },
    async models() {
      calls.push({ method: 'models' })
      return {
        providers: [{ id: 'test', name: 'Test', models: [{ id: 'fast', name: 'Fast', efforts: [{ id: 'low' }] }] }],
        default: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
      }
    },
    async listChats() {
      calls.push({ method: 'listChats' })
      return [
        {
          sessionId: 'session-2',
          title: 'Artel · Second task',
          lastTask: 'Second task',
          projectPath: 'C:\\work\\app',
          projectKey: 'c:\\work\\app',
          runCount: 2,
          lastRunId: 'fg-2',
          status: 'finished',
          mode: 'swarm',
          updatedAt: 20,
        },
        {
          sessionId: 'session-1',
          title: 'Artel · Add a settings screen',
          lastTask: 'Add a settings screen',
          projectPath: 'C:\\work\\app',
          projectKey: 'c:\\work\\app',
          runCount: 1,
          lastRunId: 'fg-1',
          status: 'waiting',
          mode: 'solo',
          updatedAt: 10,
        },
      ]
    },
    async setAgentModel(runId, agentId, model) {
      calls.push({ method: 'setAgentModel', runId, agentId, model })
      return summary({ id: runId, agents: [{ ...summary().agents[0], model }] })
    },
    async changes(runId) {
      calls.push({ method: 'changes', runId })
      return [{ path: 'index.html', status: 'modified', added: 2, removed: 0, hunks: [] }]
    },
    async fileDiff(runId, path) {
      calls.push({ method: 'fileDiff', runId, path })
      return { path, status: 'modified', added: 2, removed: 0, hunks: [] }
    },
    async apply(runId, paths) {
      calls.push({ method: 'apply', runId, paths })
      return { applied: ['index.html'], skipped: [] }
    },
    async discard(runId) {
      calls.push({ method: 'discard', runId })
      return summary({ id: runId, status: 'discarded' })
    },
    async installPlan(runId, options) {
      calls.push({ method: 'installPlan', runId, options })
      return {
        detectedAt: 5,
        bundle: { name: '@local/demo', version: '1.0.0', patch: 'cordis.patch.yml', installable: true, canInstall: true, status: null, result: null },
        steps: [{ id: 'step-1', index: 0, title: 'Runtime', command: 'node install.mjs', origin: 'manifest', status: 'idle' }],
        warnings: [],
      }
    },
    async installBundle(runId) {
      calls.push({ method: 'installBundle', runId })
      return summary({
        id: runId,
        status: 'applied',
        install: {
          detectedAt: 5,
          bundle: { name: '@local/demo', installable: true, canInstall: true, status: 'restart-required', result: { status: 'restart-required' } },
          steps: [],
          warnings: [],
        },
      })
    },
    async runInstallStep(runId, index) {
      calls.push({ method: 'runInstallStep', runId, index })
      return summary({
        id: runId,
        status: 'applied',
        install: {
          detectedAt: 5,
          bundle: null,
          steps: [{ id: 'step-1', index: 0, title: 'Runtime', command: 'node install.mjs', status: 'done', output: 'ok', exitCode: 0 }],
          warnings: [],
        },
      })
    },
  }
  return engine
}

/** Build a fake request. */
function requestFor(path, { method = 'GET', body, headers = {}, remote = '127.0.0.1' } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  stream.method = method
  stream.url = path
  stream.headers = { host: '127.0.0.1:57257', 'sec-fetch-site': 'same-origin', ...headers }
  stream.socket = { remoteAddress: remote }
  return stream
}

/** Build a fake response that records status and body. */
function fakeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    text: '',
    headersSent: false,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
      response.headersSent = true
    },
    end(text) {
      response.text = text ?? ''
    },
  }
  return response
}

/** Route through the real registration and capture one exchange. */
async function call(routes, path, options) {
  const url = new URL(path, 'http://127.0.0.1:57257')
  const route = routes.find((candidate) => candidate.kind === 'prefix'
    ? url.pathname === candidate.path || url.pathname.startsWith(`${candidate.path}/`)
    : url.pathname === candidate.path)
  assert.ok(route, `no route for ${path}`)
  const response = fakeResponse()
  route.handler(requestFor(path, options), response)
  // Handlers may await a realpath: wait for the response instead of assuming
  // one macrotask is enough.
  const deadline = Date.now() + 5000
  while (response.status === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  let body
  try {
    body = JSON.parse(response.text)
  } catch {
    body = response.text
  }
  return { status: response.status, body }
}

/** Wiring shared by the tests. */
function setup(options = {}) {
  const webServer = fakeWebServer()
  const engine = fakeEngine()
  const resolved = []
  const disposers = registerArtelRoutes({
    webServer,
    engine,
    version: '0.1.0',
    resolveProjectPath: async (sessionId) => {
      resolved.push(sessionId)
      return 'C:\\work\\app'
    },
    ...options,
  })
  return { webServer, engine, resolved, disposers }
}

test('registers a health route, a model catalog route, a project route, a chats route, a client-report route and a runs prefix', () => {
  const { webServer, disposers } = setup()
  assert.equal(webServer.routes.length, 6)
  assert.deepEqual(webServer.routes.map((route) => [route.kind, route.path]), [
    ['exact', `${API_PREFIX}/client-report`],
    ['exact', `${API_PREFIX}/health`],
    ['exact', `${API_PREFIX}/models`],
    ['exact', `${API_PREFIX}/project`],
    ['exact', `${API_PREFIX}/chats`],
    ['prefix', `${API_PREFIX}/runs`],
  ])
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(webServer.routes.length, 5)
})

test('the model catalog route answers without a session', async () => {
  const { webServer, engine } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/models`)
  assert.equal(response.status, 200)
  assert.equal(response.body.providers[0].id, 'test')
  assert.deepEqual(response.body.default, { provider: 'test', model: 'fast', reasoningEffort: 'low' })
  assert.deepEqual(engine.calls.at(-1), { method: 'models' })
  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/models`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

test('one agent can be rerouted through the run route', async () => {
  const { webServer, engine } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/agents/fg-1-a1/model`, {
    method: 'POST',
    body: { model: { provider: 'test', model: 'fast', reasoningEffort: 'low' } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.run.agents[0].model.model, 'fast')
  assert.deepEqual(engine.calls.at(-1), {
    method: 'setAgentModel',
    runId: 'fg-1',
    agentId: 'fg-1-a1',
    model: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
  })

  const bare = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/agents/fg-1-a1/model`, {
    method: 'POST',
    body: { provider: 'test', model: 'fast' },
  })
  assert.equal(bare.status, 200, 'a bare selection is accepted too')
  assert.deepEqual(engine.calls.at(-1).model, { provider: 'test', model: 'fast' })
})

test('an unknown sub-route of a run is a 404', async () => {
  const { webServer } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/agents/fg-1-a1/other`, { method: 'POST' })
  assert.equal(response.status, 404)
  const tooShort = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/agents/fg-1-a1`, { method: 'POST' })
  assert.equal(tooShort.status, 404)
})

test('health reports the version and the diagnostics', async () => {
  const { webServer } = setup({ diagnostics: () => ({ clientModuleRowPresent: true }) })
  const response = await call(webServer.routes, `${API_PREFIX}/health`)
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.version, '0.1.0')
  assert.deepEqual(response.body.diagnostics, { clientModuleRowPresent: true })
  assert.equal('git' in response.body, false, 'no git status when the Host did not wire one')
})

test('health carries the git verdict so the panel can warn at open (issue #13)', async () => {
  const probe = { ok: false, version: null, minimum: '2.30.0', reason: 'missing', detail: 'spawn git ENOENT' }
  const { webServer } = setup({ gitStatus: async () => probe })
  const response = await call(webServer.routes, `${API_PREFIX}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.git, probe)

  const broken = setup({ gitStatus: async () => { throw new Error('probe crashed') } })
  const failed = await call(broken.webServer.routes, `${API_PREFIX}/health`)
  assert.equal(failed.status, 200)
  assert.equal(failed.body.ok, true, 'a failing probe must not take the health route down')
  assert.equal(failed.body.git.ok, false)
  assert.equal(failed.body.git.reason, 'unreadable')
  assert.match(failed.body.git.detail, /probe crashed/)
})

test('run detail returns one run and one awaited feed page', async () => {
  const { webServer, engine } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/runs/fg-1?cursor=0&limit=10`)
  assert.equal(response.status, 200)
  assert.equal(response.body.run.id, 'fg-1', 'the run is not wrapped twice')
  assert.equal(response.body.run.run, undefined)
  assert.equal(response.body.feed.events.length, 1)
  assert.equal(response.body.feed.cursor, 1, 'the feed promise is awaited')
  assert.deepEqual(engine.calls.find((entry) => entry.method === 'readFeed').options, { cursor: 0, limit: 10 })
})

test('run list needs a session and passes it down', async () => {
  const { webServer, engine } = setup()
  const missing = await call(webServer.routes, `${API_PREFIX}/runs`)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'artel/bad-request')
  const response = await call(webServer.routes, `${API_PREFIX}/runs?sessionId=session-1`)
  assert.equal(response.status, 200)
  assert.equal(response.body.runs.length, 1)
  assert.deepEqual(engine.calls.at(-1), { method: 'listRuns', sessionId: 'session-1' })
})

test('starting a run uses the body project path or resolves it', async () => {
  const { webServer, engine, resolved } = setup()
  const explicit = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-1', projectPath: 'C:\\work\\app', mode: 'solo', task: 'Add a screen' },
  })
  assert.equal(explicit.status, 201)
  assert.equal(explicit.body.run.status, 'running')
  assert.equal(resolved.length, 0, 'an explicit project path is used as is')
  const resolvedCall = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-2', mode: 'swarm', task: 'Split the work' },
  })
  assert.equal(resolvedCall.status, 201)
  assert.deepEqual(resolved, ['session-2'])
  assert.deepEqual(engine.calls.find((entry) => entry.method === 'start').request, {
    sessionId: 'session-1',
    projectPath: 'C:\\work\\app',
    mode: 'solo',
    task: 'Add a screen',
    model: undefined,
    models: undefined,
    // A task started from a chat gets its own chat in the project.
    newChat: true,
  })
})

test('a start rejects a missing or unknown chat session before copying anything', async () => {
  const { webServer, engine, resolved } = setup({ hasSession: (sessionId) => sessionId === 'session-1' })
  const missing = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { mode: 'solo', task: 'Nowhere' },
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'artel/bad-request')
  assert.equal(missing.body.error, 'sessionId is required')

  const unknown = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-nope', projectPath: 'C:\\work\\app', mode: 'solo', task: 'Nowhere' },
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'artel/unknown-session')
  assert.equal(engine.calls.some((entry) => entry.method === 'start'), false, 'no agent may start for an unknown chat')
  assert.deepEqual(resolved, [])

  const known = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-1', projectPath: 'C:\\work\\app', mode: 'solo', task: 'Copy it' },
  })
  assert.equal(known.status, 201)
})

test('a start can keep the chat it came from', async () => {
  const { webServer, engine } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-1', projectPath: 'C:\\work\\app', mode: 'solo', task: 'Stay here', newChat: false },
  })
  assert.equal(response.status, 201)
  assert.equal(engine.calls.find((entry) => entry.method === 'start').request.newChat, false)
})

test('a Fusion start passes the per-slot routes through', async () => {
  const { webServer, engine } = setup()
  const models = {
    panel: [{ provider: 'test', model: 'fast' }, { provider: 'test', model: 'slow' }, { provider: 'test', model: 'fast' }],
    judge: { provider: 'test', model: 'slow' },
    implementer: { provider: 'test', model: 'fast' },
  }
  const response = await call(webServer.routes, `${API_PREFIX}/runs`, {
    method: 'POST',
    body: { sessionId: 'session-1', projectPath: 'C:\\work\\app', mode: 'fusion', task: 'Pick an approach', models },
  })
  assert.equal(response.status, 201)
  const request = engine.calls.find((entry) => entry.method === 'start').request
  assert.equal(request.mode, 'fusion')
  assert.deepEqual(request.models, models)
})

test('messages, interrupt, changes, diff, apply and discard answer with their payloads', async () => {
  const { webServer } = setup()
  const message = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/messages`, { method: 'POST', body: { text: 'Also add a test' } })
  assert.equal(message.status, 200)
  assert.equal(message.body.run.status, 'running')
  const interrupt = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/interrupt`, { method: 'POST' })
  assert.equal(interrupt.body.run.status, 'interrupted')
  const changes = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/changes`)
  assert.equal(changes.body.changes[0].path, 'index.html')
  const diff = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/diff?path=src%2Fapp.js`)
  assert.equal(diff.body.file.path, 'src/app.js')
  const missingPath = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/diff`)
  assert.equal(missingPath.status, 400)
  const apply = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/apply`, { method: 'POST', body: { paths: ['index.html'] } })
  assert.equal(apply.status, 200)
  assert.deepEqual(apply.body.applied, ['index.html'])
  assert.equal(apply.body.run.id, 'fg-1')
  const discard = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/discard`, { method: 'POST' })
  assert.equal(discard.body.run.status, 'discarded')
})

test('the install routes answer with the plan, the bundle result and the step result', async () => {
  const { webServer, engine } = setup()
  const plan = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install?refresh=1`)
  assert.equal(plan.status, 200)
  assert.equal(plan.body.install.bundle.name, '@local/demo')
  assert.equal(plan.body.run.id, 'fg-1')
  assert.deepEqual(engine.calls.at(-2), { method: 'installPlan', runId: 'fg-1', options: { refresh: true } })

  const cached = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install`)
  assert.equal(cached.status, 200)
  assert.deepEqual(engine.calls.at(-2), { method: 'installPlan', runId: 'fg-1', options: { refresh: false } })

  const bundle = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install/bundle`, { method: 'POST' })
  assert.equal(bundle.status, 200)
  assert.equal(bundle.body.run.install.bundle.status, 'restart-required')
  assert.deepEqual(engine.calls.at(-1), { method: 'installBundle', runId: 'fg-1' })

  const step = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install/steps/0`, { method: 'POST' })
  assert.equal(step.status, 200)
  assert.equal(step.body.run.install.steps[0].status, 'done')
  assert.deepEqual(engine.calls.at(-1), { method: 'runInstallStep', runId: 'fg-1', index: 0 })

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install/bundle`)
  assert.equal(wrongMethod.status, 405)
  const unknown = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/install/nope`, { method: 'POST' })
  assert.equal(unknown.status, 404)
})

test('the project route resolves the session directory and its name', async () => {
  const projectDir = path.join(process.cwd(), 'test', '.tmp', 'session-project')
  const { webServer } = setup({
    resolveProjectPath: async (sessionId) => (sessionId === 'session-1' ? projectDir : undefined),
  })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-1`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    projectPath: path.resolve(projectDir),
    name: 'session-project',
    projectKey: await projectKeyFor(projectDir),
  })
})

test('the project route falls back to the profile working directory', async () => {
  const fallbackDir = path.join(process.cwd(), 'test', '.tmp', 'profile-project')
  const { webServer } = setup({
    resolveProjectPath: async () => undefined,
    defaultDirectory: () => fallbackDir,
  })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=fresh-session`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    projectPath: path.resolve(fallbackDir),
    name: 'profile-project',
    projectKey: await projectKeyFor(fallbackDir),
  })
})

test('the project route answers with nulls when no project is known yet', async () => {
  const { webServer } = setup({ resolveProjectPath: async () => undefined })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=fresh-session`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { projectPath: null, name: null, projectKey: null })
})

test('two spellings of the same project share one key', async () => {
  const projectDir = path.join(process.cwd(), 'test', '.tmp', 'session-project')
  const alias = path.join(process.cwd(), 'test', '.tmp', '..', '.tmp', 'session-project')
  const { webServer } = setup({
    resolveProjectPath: async (sessionId) => (sessionId === 'session-a' ? projectDir : alias),
  })
  const first = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-a`)
  const second = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-b`)
  assert.equal(first.body.projectKey, second.body.projectKey, 'the rail must not split one project in two')
})

test('the chats route lists every chat that owns Artel runs', async () => {
  const { webServer, engine } = setup()
  const response = await call(webServer.routes, `${API_PREFIX}/chats`)
  assert.equal(response.status, 200)
  assert.deepEqual(engine.calls.at(-1), { method: 'listChats' })
  assert.deepEqual(response.body.chats.map((chat) => chat.sessionId), ['session-2', 'session-1'])
  assert.equal(response.body.chats[0].runCount, 2)
  assert.equal(response.body.chats[0].lastRunId, 'fg-2')
  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/chats`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  const foreign = await call(webServer.routes, `${API_PREFIX}/chats`, { remote: '10.0.0.5' })
  assert.equal(foreign.status, 403)
})

test('the project route validates the session and stays fenced', async () => {
  const { webServer } = setup()
  const missing = await call(webServer.routes, `${API_PREFIX}/project`)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'artel/bad-request')
  const empty = await call(webServer.routes, `${API_PREFIX}/project?sessionId=`)
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'artel/bad-request')
  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-1`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.code, 'artel/method')
  const foreign = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-1`, { remote: '10.0.0.5' })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.code, 'artel/forbidden')
})

test('unknown paths and wrong methods are rejected', async () => {
  const { webServer } = setup()
  const unknown = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/nope`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'artel/not-found')
  const wrong = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/changes`, { method: 'POST', body: {} })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.body.code, 'artel/method')
  const badJson = await call(webServer.routes, `${API_PREFIX}/runs/fg-1/messages`, { method: 'POST', body: { text: 'x' } })
  assert.equal(badJson.status, 200)
})

test('the fence rejects foreign, cross-site and unknown-host requests', async () => {
  const { webServer } = setup()
  const foreign = await call(webServer.routes, `${API_PREFIX}/health`, { remote: '10.0.0.5' })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.body.code, 'artel/forbidden')
  const crossSite = await call(webServer.routes, `${API_PREFIX}/health`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const badHost = await call(webServer.routes, `${API_PREFIX}/health`, { headers: { host: 'evil.example.com' } })
  assert.equal(badHost.status, 403)
  const ok = await call(webServer.routes, `${API_PREFIX}/health`)
  assert.equal(ok.status, 200)
})

test('a failing engine becomes a JSON error with its code and status', async () => {
  const { webServer, engine } = setup()
  engine.getRun = () => {
    const error = new Error('Run not found')
    error.status = 404
    error.code = 'artel/not-found'
    throw error
  }
  const response = await call(webServer.routes, `${API_PREFIX}/runs/missing`)
  assert.equal(response.status, 404)
  assert.equal(response.body.error, 'Run not found')
  assert.equal(response.body.code, 'artel/not-found')
})

/** Fake queue runner recording exactly what the routes forwarded. */
function fakeQueueRunner() {
  const calls = []
  const runner = {
    calls,
    async summary(sessionId, options) {
      calls.push({ method: 'summary', args: [sessionId, options] })
      return { sessionId, projectPath: options?.projectPath ?? null, autopilot: false, counts: { total: 0 } }
    },
    async addTasks(input) {
      calls.push({ method: 'addTasks', args: [input] })
      return { added: input.texts.length + (input.task ? 1 : 0), queue: { sessionId: input.sessionId } }
    },
    async preflight(sessionId, options) {
      calls.push({ method: 'preflight', args: [sessionId, options] })
      return { sessionId, pendingVersions: [], limit: 20 }
    },
    async setAutopilot(input) {
      calls.push({ method: 'setAutopilot', args: [input] })
      return { queue: { autopilot: input.autopilot }, blocked: null }
    },
    async stop(sessionId) {
      calls.push({ method: 'stop', args: [sessionId] })
      return { sessionId, stopReason: 'stopped' }
    },
    async finishAfterCurrent(sessionId) {
      calls.push({ method: 'finishAfterCurrent', args: [sessionId] })
      return { sessionId, stopAfterCurrent: true }
    },
    async clearFinished(sessionId) {
      calls.push({ method: 'clearFinished', args: [sessionId] })
      return { sessionId, tasks: [] }
    },
    async removeTask(sessionId, taskId) {
      calls.push({ method: 'removeTask', args: [sessionId, taskId] })
      return { sessionId, tasks: [] }
    },
    async retryTask(sessionId, taskId) {
      calls.push({ method: 'retryTask', args: [sessionId, taskId] })
      return { sessionId, tasks: [] }
    },
    async moveTask(sessionId, taskId, options) {
      calls.push({ method: 'moveTask', args: [sessionId, taskId, options] })
      return { sessionId, tasks: [] }
    },
    async saveVersion(sessionId, runId) {
      calls.push({ method: 'saveVersion', args: [sessionId, runId] })
      return { saved: true }
    },
    async postponeVersion(sessionId, runId) {
      calls.push({ method: 'postponeVersion', args: [sessionId, runId] })
      return { sessionId, ignored: [runId] }
    },
    async branchesSummary(sessionId) {
      calls.push({ method: 'branchesSummary', args: [sessionId] })
      return {
        queue: { sessionId },
        project: { head: 'a'.repeat(40), repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
        currentBranchId: 'b-1',
        branches: [{ id: 'b-1', name: 'Main', ref: 'refs/heads/artel/b-1', baseCommit: 'a'.repeat(40), tipCommit: null }],
      }
    },
    async createBranch(sessionId, input) {
      calls.push({ method: 'createBranch', args: [sessionId, input] })
      return { branch: { id: 'b-2', name: input.name }, branches: [] }
    },
    async renameBranch(sessionId, branchId, name) {
      calls.push({ method: 'renameBranch', args: [sessionId, branchId, name] })
      return { currentBranchId: branchId, branches: [] }
    },
    async switchBranch(sessionId, branchId) {
      calls.push({ method: 'switchBranch', args: [sessionId, branchId] })
      return { currentBranchId: branchId, branches: [] }
    },
    async removeBranch(sessionId, branchId) {
      calls.push({ method: 'removeBranch', args: [sessionId, branchId] })
      return { currentBranchId: null, branches: [] }
    },
    async branchCommits(sessionId, branchId) {
      calls.push({ method: 'branchCommits', args: [sessionId, branchId] })
      return [{ commit: 'c'.repeat(40), parents: ['a'.repeat(40)], subject: 'Answer two', date: '2026-11-21T00:00:00.000Z', files: ['src/app.js'], changeCount: 1 }]
    },
    async applyBranch(sessionId, input) {
      calls.push({ method: 'applyBranch', args: [sessionId, input] })
      return { applied: { branchId: input.branchId, commit: 'c'.repeat(40), files: 1 }, check: null }
    },
    async mergeBranches(sessionId, input) {
      calls.push({ method: 'mergeBranches', args: [sessionId, input] })
      return { mergeCommit: 'd'.repeat(40), check: null }
    },
    async projectState(sessionId) {
      calls.push({ method: 'projectState', args: [sessionId] })
      return { head: 'a'.repeat(40), branchId: 'b-1', drift: { dirty: false, files: [] } }
    },
    async exportBranch(sessionId, input) {
      calls.push({ method: 'exportBranch', args: [sessionId, input] })
      return {
        queue: { sessionId },
        exported: { target: input?.target ?? 'refs/heads/artel/b-1', commit: 'a'.repeat(40), at: 10 },
      }
    },
    async revertApply(sessionId, input) {
      calls.push({ method: 'revertApply', args: [sessionId, input] })
      return {
        queue: { sessionId },
        reverted: { branchId: input?.branchId ?? 'b-1', branchName: 'Main', commit: 'b'.repeat(40), undone: 'c'.repeat(40) },
      }
    },
    async maintenance(sessionId) {
      calls.push({ method: 'maintenance', args: [sessionId] })
      return {
        before: { objects: 5, sizeBytes: 4096, sizeText: '4.0 KiB' },
        after: { objects: 4, sizeBytes: 2048, sizeText: '2.0 KiB' },
        freedBytes: 2048,
      }
    },
  }
  return runner
}

/** Fake factory runner recording exactly what the routes forwarded. */
function fakeFactoryRunner() {
  const calls = []
  const record = (method, ...args) => calls.push({ method, args })
  const ticket = (overrides = {}) => ({ id: 't-1', number: 1, stage: 'incoming', ...overrides })
  const runner = {
    calls,
    listBoards() {
      record('listBoards')
      return [{ id: 'b-1' }]
    },
    view(boardId) {
      record('view', boardId)
      return { board: { id: boardId }, tickets: [ticket()] }
    },
    async createBoard(input) {
      record('createBoard', input)
      return { board: { id: 'b-1', projectPath: input.projectPath }, created: true }
    },
    async updateBoard(boardId, patch) {
      record('updateBoard', boardId, patch)
      return { id: boardId, enabled: patch?.enabled === true }
    },
    async checkReadiness(boardId) {
      record('checkReadiness', boardId)
      return { board: { id: boardId }, readiness: { ready: true, checks: [] } }
    },
    async addTicket(boardId, input) {
      record('addTicket', boardId, input)
      return ticket({ title: input.title, attachments: input.attachments })
    },
    async ticketView(boardId, ticketId, options) {
      record('ticketView', boardId, ticketId, options)
      return { ticket: ticket({ id: ticketId }), feed: [{ seq: 1 }] }
    },
    async answerQuestions(boardId, ticketId, input) {
      record('answerQuestions', boardId, ticketId, input)
      return ticket({ id: ticketId, stage: 'incoming' })
    },
    async approvePlan(boardId, ticketId) {
      record('approvePlan', boardId, ticketId)
      return ticket({ id: ticketId, stage: 'working' })
    },
    async repairAction(boardId, ticketId, input) {
      record('repairAction', boardId, ticketId, input)
      return ticket({ id: ticketId, stage: 'working' })
    },
    async returnToFactory(boardId, ticketId, input) {
      record('returnToFactory', boardId, ticketId, input)
      return ticket({ id: ticketId, stage: 'incoming' })
    },
    async returnWithComment(boardId, ticketId, input) {
      record('returnWithComment', boardId, ticketId, input)
      return ticket({ id: ticketId, stage: 'working' })
    },
    async openPullRequest(boardId, ticketId) {
      record('openPullRequest', boardId, ticketId)
      return ticket({ id: ticketId, stage: 'done', pr: { url: 'https://github.com/acme/repo/pull/7' } })
    },
    async mergeTicket(boardId, ticketId) {
      record('mergeTicket', boardId, ticketId)
      return ticket({ id: ticketId, stage: 'done' })
    },
    async takeOver(boardId, ticketId) {
      record('takeOver', boardId, ticketId)
      return ticket({ id: ticketId, stage: 'waiting', waiting: { kind: 'postponed' } })
    },
    async importGithubIssue(boardId, ref) {
      record('importGithubIssue', boardId, ref)
      return ticket({ id: 't-2', number: 2 })
    },
    async pollTrackers(onlyBoardId) {
      record('pollTrackers', onlyBoardId)
      return { added: 0, errors: [] }
    },
  }
  return runner
}

test('the queue route requires a session and resolves the project', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer, resolved } = setup({ queueRunner })
  assert.equal(webServer.routes.length, 7)
  const missing = await call(webServer.routes, `${API_PREFIX}/queue`)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'artel/bad-request')
  assert.equal(missing.body.error, 'sessionId is required')

  const response = await call(webServer.routes, `${API_PREFIX}/queue?sessionId=s1`)
  assert.equal(response.status, 200)
  assert.equal(response.body.sessionId, 's1')
  assert.equal(response.body.projectPath, 'C:\\work\\app')
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'summary', args: ['s1', { projectPath: 'C:\\work\\app' }] })
  assert.ok(resolved.includes('s1'))

  const badMethod = await call(webServer.routes, `${API_PREFIX}/queue?sessionId=s1`, { method: 'DELETE' })
  assert.equal(badMethod.status, 405)
  assert.equal(badMethod.body.code, 'artel/method')
})

test('the queue route forwards new tasks to addTasks', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', texts: ['First', 'Second'], task: 'Third', mode: 'swarm', model: 'fast', prepend: true },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.added, 3)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'addTasks',
    args: [{ sessionId: 's1', projectPath: 'C:\\work\\app', texts: ['First', 'Second'], task: 'Third', mode: 'swarm', model: 'fast', prepend: true, basePath: null }],
  })

  const seeded = await call(webServer.routes, `${API_PREFIX}/queue`, { method: 'POST', body: { sessionId: 's1', task: 'Rework the version', basePath: 'C:\\work\\copies\\run-1' } })
  assert.equal(seeded.status, 200)
  assert.equal(queueRunner.calls.at(-1).args[0].basePath, 'C:\\work\\copies\\run-1')

  const bare = await call(webServer.routes, `${API_PREFIX}/queue`, { method: 'POST', body: { sessionId: 's1', texts: ['Only'] } })
  assert.equal(bare.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1).args[0], {
    sessionId: 's1',
    projectPath: 'C:\\work\\app',
    texts: ['Only'],
    task: '',
    mode: 'solo',
    model: null,
    prepend: false,
    basePath: null,
  })

  const noSession = await call(webServer.routes, `${API_PREFIX}/queue`, { method: 'POST', body: { texts: ['x'] } })
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.code, 'artel/bad-request')

  const empty = await call(webServer.routes, `${API_PREFIX}/queue`, { method: 'POST', body: { sessionId: 's1', texts: [], task: '   ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'artel/bad-request')
  assert.equal(queueRunner.calls.at(-1).method, 'addTasks', 'the empty batch never reaches the runner')
})

test('a stale session id never borrows the fallback project directory', async () => {
  const unknown = async () => {
    const error = new Error('Unknown chat session')
    error.status = 404
    error.code = 'artel/unknown-session'
    throw error
  }
  const { webServer } = setup({ resolveProjectPath: unknown, queueRunner: fakeQueueRunner() })
  for (const path of [`${API_PREFIX}/project?sessionId=ghost`, `${API_PREFIX}/queue?sessionId=ghost`]) {
    const response = await call(webServer.routes, path)
    assert.equal(response.status, 404, path)
    assert.equal(response.body.code, 'artel/unknown-session', path)
  }
})

test('the queue route forwards a per-task branch id only when it is set', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const picked = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'x', branchId: 'b2' },
  })
  assert.equal(picked.status, 200)
  const pickedInput = queueRunner.calls.at(-1).args[0]
  assert.equal(pickedInput.branchId, 'b2')
  assert.equal(pickedInput.task, 'x')

  const unchanged = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'y' },
  })
  assert.equal(unchanged.status, 200)
  assert.equal('branchId' in queueRunner.calls.at(-1).args[0], false, 'no branch choice means no branchId key')

  const empty = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'z', branchId: '' },
  })
  assert.equal(empty.status, 200)
  assert.equal('branchId' in queueRunner.calls.at(-1).args[0], false, 'an empty branch id is not a choice')
})

test('the queue route accepts the Orchestrator and still refuses unknown modes', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const orchestrator = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'Plan the release', mode: 'orchestrator' },
  })
  assert.equal(orchestrator.status, 200)
  assert.equal(queueRunner.calls.length, 1)
  assert.equal(queueRunner.calls[0].method, 'addTasks')
  assert.equal(queueRunner.calls[0].args[0].mode, 'orchestrator')

  const unknown = await call(webServer.routes, `${API_PREFIX}/queue`, {
    method: 'POST',
    body: { sessionId: 's1', task: 'Do the thing', mode: 'banana' },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'queue/mode-unknown')
  assert.match(unknown.body.error, /banana/)
  assert.match(unknown.body.error, /solo, swarm, conductor, orchestrator, fusion/)
  assert.equal(queueRunner.calls.length, 1, 'an unknown mode never reaches addTasks')
})

test('the queue branch routes forward branch operations', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const list = await call(webServer.routes, `${API_PREFIX}/queue/branches?sessionId=s1`)
  assert.equal(list.status, 200)
  assert.equal(list.body.currentBranchId, 'b-1')
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'branchesSummary', args: ['s1'] })

  const created = await call(webServer.routes, `${API_PREFIX}/queue/branches`, {
    method: 'POST',
    body: { sessionId: 's1', name: 'Night', fromCommit: 'a'.repeat(40) },
  })
  assert.equal(created.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'createBranch',
    args: ['s1', { name: 'Night', fromCommit: 'a'.repeat(40), switchTo: true }],
  })

  const renamed = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1`, {
    method: 'PATCH',
    body: { sessionId: 's1', name: 'Renamed' },
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'renameBranch', args: ['s1', 'b-1', 'Renamed'] })

  const switched = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/switch`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(switched.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'switchBranch', args: ['s1', 'b-1'] })

  const commits = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/commits?sessionId=s1`)
  assert.equal(commits.status, 200)
  assert.equal(commits.body.commits[0].subject, 'Answer two')
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'branchCommits', args: ['s1', 'b-1'] })

  const applied = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/apply`, {
    method: 'POST',
    body: { sessionId: 's1', commitIds: ['c1', 5], confirmDrift: true, checkCommand: 'npm test', force: true },
  })
  assert.equal(applied.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'applyBranch',
    args: ['s1', { branchId: 'b-1', commitIds: ['c1'], confirmDrift: true, checkCommand: 'npm test', force: true }],
  })

  const merged = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/merge`, {
    method: 'POST',
    body: { sessionId: 's1', sourceBranchId: 'b-2' },
  })
  assert.equal(merged.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'mergeBranches',
    args: ['s1', { targetBranchId: 'b-1', sourceBranchId: 'b-2', checkCommand: '', force: false }],
  })

  const removed = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1?sessionId=s1`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'removeBranch', args: ['s1', 'b-1'] })

  const project = await call(webServer.routes, `${API_PREFIX}/queue/project-state?sessionId=s1`)
  assert.equal(project.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'projectState', args: ['s1'] })

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/queue/branches?sessionId=s1`, { method: 'PUT' })
  assert.equal(wrongMethod.status, 405)
  const noSource = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/merge`, { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(noSource.status, 400)
  assert.equal(noSource.body.code, 'artel/bad-request')
})

test('the queue branch export and revert routes forward their inputs', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })

  const exported = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/export`, {
    method: 'POST',
    body: { sessionId: 's1', target: 'refs/heads/artel/custom' },
  })
  assert.equal(exported.status, 200)
  assert.equal(exported.body.exported.target, 'refs/heads/artel/custom')
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'exportBranch',
    args: ['s1', { branchId: 'b-1', target: 'refs/heads/artel/custom' }],
  })

  const automatic = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/export`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(automatic.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'exportBranch',
    args: ['s1', { branchId: 'b-1', target: null }],
  })

  const reverted = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/revert`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(reverted.status, 200)
  assert.equal(reverted.body.reverted.branchId, 'b-1')
  // Revert refuses drift instead of overriding it: no force flag is forwarded.
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'revertApply', args: ['s1', { branchId: 'b-1' }] })

  const noSession = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/revert`, { method: 'POST', body: {} })
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.code, 'artel/bad-request')

  const wrongExport = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/export`)
  assert.equal(wrongExport.status, 405)
  const wrongRevert = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/revert`)
  assert.equal(wrongRevert.status, 405)
})

test('the queue maintenance route runs the cleanup for the session', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/maintenance`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.freedBytes, 2048)
  assert.equal(response.body.before.objects, 5)
  assert.equal(response.body.after.objects, 4)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'maintenance', args: ['s1'] })

  const noSession = await call(webServer.routes, `${API_PREFIX}/queue/maintenance`, { method: 'POST', body: {} })
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.code, 'artel/bad-request')

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/queue/maintenance`)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.code, 'artel/method')
})

test('an export error keeps its status, code and details in the JSON body', async () => {
  const queueRunner = fakeQueueRunner()
  queueRunner.exportBranch = async () => {
    const error = new Error('The target ref already exists.')
    error.status = 409
    error.code = 'artel/export-exists'
    error.details = { target: 'refs/heads/artel/b1' }
    throw error
  }
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/branches/b1/export`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'The target ref already exists.')
  assert.equal(response.body.code, 'artel/export-exists')
  assert.deepEqual(response.body.details, { target: 'refs/heads/artel/b1' })
})

test('a branch error keeps its status, code and details in the JSON body', async () => {
  const queueRunner = fakeQueueRunner()
  queueRunner.applyBranch = async () => {
    const error = new Error('The project has uncommitted changes.')
    error.status = 409
    error.code = 'artel/project-drift'
    error.details = { drift: { dirty: true, files: ['src/app.js'] }, branchId: 'b-1' }
    throw error
  }
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/branches/b-1/apply`, {
    method: 'POST',
    body: { sessionId: 's1' },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'artel/project-drift')
  assert.deepEqual(response.body.details, { drift: { dirty: true, files: ['src/app.js'] }, branchId: 'b-1' })
})

test('the queue autopilot route forwards its flags and decisions', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/autopilot`, {
    method: 'POST',
    body: {
      sessionId: 's1',
      autopilot: true,
      limit: 3,
      checkCommand: 'npm test',
      checkDisabled: true,
      saveVersionRunIds: ['run-1', 5],
      postponeVersionRunIds: ['run-2'],
      decisions: true,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), {
    method: 'setAutopilot',
    args: [{
      sessionId: 's1',
      projectPath: 'C:\\work\\app',
      autopilot: true,
      limit: 3,
      checkCommand: 'npm test',
      checkDisabled: true,
      saveVersionRunIds: ['run-1'],
      postponeVersionRunIds: ['run-2'],
      decisions: true,
    }],
  })

  const preflight = await call(webServer.routes, `${API_PREFIX}/queue/preflight?sessionId=s1`)
  assert.equal(preflight.status, 200)
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'preflight', args: ['s1', { projectPath: 'C:\\work\\app' }] })

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/queue/autopilot`)
  assert.equal(wrongMethod.status, 405)
})

test('the queue autopilot route rejects a non-boolean toggle', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })
  const response = await call(webServer.routes, `${API_PREFIX}/queue/autopilot`, {
    method: 'POST',
    body: { sessionId: 's1', autopilot: 'yes' },
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'artel/bad-request')
  assert.equal(queueRunner.calls.length, 0, 'the runner must not be called for an invalid toggle')
})

test('the queue task and version sub-routes forward ids and verbs', async () => {
  const queueRunner = fakeQueueRunner()
  const { webServer } = setup({ queueRunner })
  await call(webServer.routes, `${API_PREFIX}/queue/tasks/t-1/retry`, { method: 'POST', body: { sessionId: 's1' } })
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'retryTask', args: ['s1', 't-1'] })

  await call(webServer.routes, `${API_PREFIX}/queue/tasks/t-1/move`, { method: 'POST', body: { sessionId: 's1', direction: 'down' } })
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'moveTask', args: ['s1', 't-1', { direction: 'down' }] })

  await call(webServer.routes, `${API_PREFIX}/queue/tasks/t-1?sessionId=s1`, { method: 'DELETE' })
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'removeTask', args: ['s1', 't-1'] })

  await call(webServer.routes, `${API_PREFIX}/queue/versions/run-1/save`, { method: 'POST', body: { sessionId: 's1' } })
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'saveVersion', args: ['s1', 'run-1'] })

  await call(webServer.routes, `${API_PREFIX}/queue/versions/run-1/postpone`, { method: 'POST', body: { sessionId: 's1' } })
  assert.deepEqual(queueRunner.calls.at(-1), { method: 'postponeVersion', args: ['s1', 'run-1'] })

  const unknown = await call(webServer.routes, `${API_PREFIX}/queue/versions/run-1/nope`, { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(unknown.status, 404)
  const badTask = await call(webServer.routes, `${API_PREFIX}/queue/tasks/t-1`, { method: 'POST', body: { sessionId: 's1' } })
  assert.equal(badTask.status, 404)
})

test('the queue route answers 503 when no runner is wired', async () => {
  const webServer = fakeWebServer()
  registerQueueRoutes({ webServer, queueRunner: null, resolveProjectPath: async () => 'C:\\work\\app' })
  const response = await call(webServer.routes, `${API_PREFIX}/queue?sessionId=s1`)
  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'artel/unavailable')
})

test('the factory route lists, creates and views boards', async () => {
  const factoryRunner = fakeFactoryRunner()
  const { webServer } = setup({ factoryRunner })
  assert.equal(webServer.routes.length, 7)
  const list = await call(webServer.routes, `${API_PREFIX}/factory`)
  assert.equal(list.status, 200)
  assert.deepEqual(list.body, { boards: [{ id: 'b-1' }] })

  const missing = await call(webServer.routes, `${API_PREFIX}/factory`, { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error, 'projectPath is required')

  const created = await call(webServer.routes, `${API_PREFIX}/factory`, { method: 'POST', body: { projectPath: 'C:\\work\\app', name: 'Demo' } })
  assert.equal(created.status, 200)
  assert.equal(created.body.board.id, 'b-1')
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'createBoard', args: [{ projectPath: 'C:\\work\\app', name: 'Demo' }] })

  const view = await call(webServer.routes, `${API_PREFIX}/factory/b-1`)
  assert.equal(view.status, 200)
  assert.equal(view.body.board.id, 'b-1')
  assert.equal(view.body.tickets.length, 1)
  assert.deepEqual(factoryRunner.calls.find((entry) => entry.method === 'view'), { method: 'view', args: ['b-1'] })

  const wrongMethod = await call(webServer.routes, `${API_PREFIX}/factory/b-1`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

test('the factory ticket POST forwards attachments and the source', async () => {
  const factoryRunner = fakeFactoryRunner()
  const { webServer } = setup({ factoryRunner })
  const attachments = [
    { name: 'shot.png', data: 'aGVsbG8=' },
    { name: 'big.zip', data: 'AAECAw==' },
  ]
  const response = await call(webServer.routes, `${API_PREFIX}/factory/b-1/tickets`, {
    method: 'POST',
    body: { title: 'Add the screen', text: 'Needs a dark theme.', attachments, source: { kind: 'github', externalId: 'gh:acme/repo#5' } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ticket.title, 'Add the screen')
  const forwarded = factoryRunner.calls.at(-1)
  assert.equal(forwarded.method, 'addTicket')
  assert.equal(forwarded.args[0], 'b-1')
  assert.deepEqual(forwarded.args[1].attachments, attachments, 'the base64 payload passes through untouched')
  assert.deepEqual(forwarded.args[1].source, { kind: 'github', externalId: 'gh:acme/repo#5' })
  assert.equal(forwarded.args[1].title, 'Add the screen')

  const view = await call(webServer.routes, `${API_PREFIX}/factory/b-1/tickets/t-1?cursor=4`)
  assert.equal(view.status, 200)
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'ticketView', args: ['b-1', 't-1', { cursor: 4 }] })
})

test('the factory ticket action routes forward their payloads', async () => {
  const factoryRunner = fakeFactoryRunner()
  const { webServer } = setup({ factoryRunner })
  const actions = [
    ['answers', { text: 'Use the dark theme.', answers: ['Dark theme'] }, 'answerQuestions'],
    ['approve-plan', {}, 'approvePlan'],
    ['repair', { action: 'more' }, 'repairAction'],
    ['return', { text: 'Back to triage', title: 'Rework' }, 'returnToFactory'],
    ['comment', { comment: 'Fix the header' }, 'returnWithComment'],
    ['pull-request', {}, 'openPullRequest'],
    ['merge', {}, 'mergeTicket'],
    ['takeover', {}, 'takeOver'],
  ]
  for (const [verb, payload, method] of actions) {
    const response = await call(webServer.routes, `${API_PREFIX}/factory/b-1/tickets/t-1/${verb}`, { method: 'POST', body: payload })
    assert.equal(response.status, 200, `${verb} answers 200`)
    assert.equal(factoryRunner.calls.at(-1).method, method)
    assert.equal(factoryRunner.calls.at(-1).args[0], 'b-1')
    assert.equal(factoryRunner.calls.at(-1).args[1], 't-1')
  }
  const byMethod = (method) => factoryRunner.calls.find((entry) => entry.method === method)
  assert.deepEqual(byMethod('answerQuestions').args[2], { text: 'Use the dark theme.', answers: ['Dark theme'] })
  assert.deepEqual(byMethod('repairAction').args, ['b-1', 't-1', { action: 'more' }])
  assert.deepEqual(byMethod('returnToFactory').args[2], { text: 'Back to triage', title: 'Rework' })
  assert.deepEqual(byMethod('returnWithComment').args[2], { comment: 'Fix the header' })

  const unknown = await call(webServer.routes, `${API_PREFIX}/factory/b-1/tickets/t-1/nope`, { method: 'POST', body: {} })
  assert.equal(unknown.status, 404)
})

test('the factory settings, readiness, poll and import routes forward', async () => {
  const factoryRunner = fakeFactoryRunner()
  const { webServer } = setup({ factoryRunner })
  await call(webServer.routes, `${API_PREFIX}/factory/b-1/settings`, { method: 'POST', body: { template: 'fast', enabled: false } })
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'updateBoard', args: ['b-1', { template: 'fast', enabled: false }] })

  await call(webServer.routes, `${API_PREFIX}/factory/b-1/readiness`, { method: 'POST', body: {} })
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'checkReadiness', args: ['b-1'] })

  await call(webServer.routes, `${API_PREFIX}/factory/b-1/poll`, { method: 'POST', body: {} })
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'pollTrackers', args: ['b-1'] })

  await call(webServer.routes, `${API_PREFIX}/factory/poll-trackers`, { method: 'POST', body: { boardId: 'b-1' } })
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'pollTrackers', args: ['b-1'] })

  const imported = await call(webServer.routes, `${API_PREFIX}/factory/b-1/import`, { method: 'POST', body: { ref: '#12' } })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.ticket.number, 2)
  assert.deepEqual(factoryRunner.calls.at(-1), { method: 'importGithubIssue', args: ['b-1', '#12'] })
})

test('the factory route answers 503 when no runner is wired', async () => {
  const webServer = fakeWebServer()
  registerFactoryRoutes({ webServer, factoryRunner: null, resolveProjectPath: async () => 'C:\\work\\app' })
  const response = await call(webServer.routes, `${API_PREFIX}/factory`)
  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'artel/unavailable')
})

test('the queue and factory routes stay loopback-only', async () => {
  const webServer = fakeWebServer()
  registerQueueRoutes({ webServer, queueRunner: fakeQueueRunner(), resolveProjectPath: async () => 'C:\\work\\app' })
  registerFactoryRoutes({ webServer, factoryRunner: fakeFactoryRunner(), resolveProjectPath: async () => 'C:\\work\\app' })
  const queue = await call(webServer.routes, `${API_PREFIX}/queue?sessionId=s1`, { remote: '10.0.0.5' })
  assert.equal(queue.status, 403)
  assert.equal(queue.body.code, 'artel/forbidden')
  const factory = await call(webServer.routes, `${API_PREFIX}/factory`, { remote: '10.0.0.5' })
  assert.equal(factory.status, 403)
  assert.equal(factory.body.code, 'artel/forbidden')
  const crossSite = await call(webServer.routes, `${API_PREFIX}/factory`, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
})

test('settings default to auto and list the bundled languages', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artel-routes-'))
  const { webServer } = setup({ stateDir, localeDir: path.resolve('locale') })
  const response = await call(webServer.routes, `${API_PREFIX}/settings`)
  assert.equal(response.status, 200)
  assert.equal(response.body.language, null)
  assert.deepEqual(response.body.available.map((entry) => entry.id), ['en', 'ru', 'zh'])
})

test('settings accept a bundled language and reject anything else', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artel-routes-'))
  const { webServer } = setup({ stateDir, localeDir: path.resolve('locale') })
  const saved = await call(webServer.routes, `${API_PREFIX}/settings`, { method: 'POST', body: { language: 'ru' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.language, 'ru')
  const reread = await call(webServer.routes, `${API_PREFIX}/settings`)
  assert.equal(reread.body.language, 'ru')

  const unknown = await call(webServer.routes, `${API_PREFIX}/settings`, { method: 'POST', body: { language: 'de' } })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'artel/bad-language')

  const malformed = await call(webServer.routes, `${API_PREFIX}/settings`, { method: 'POST', body: { language: 'ru ru' } })
  assert.equal(malformed.status, 400)

  const cleared = await call(webServer.routes, `${API_PREFIX}/settings`, { method: 'POST', body: { language: null } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.language, null)
})

test('a route error carries its code and params', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artel-routes-'))
  const { webServer } = setup({ stateDir, localeDir: path.resolve('locale') })
  const response = await call(webServer.routes, `${API_PREFIX}/settings`, { method: 'POST', body: { language: 'de' } })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'artel/bad-language')
  assert.deepEqual(response.body.params, { language: 'de' })
})
