import assert from 'node:assert/strict'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { registerArtelRoutes, API_PREFIX } from '../lib/routes.js'

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

test('registers a health route, a model catalog route, a project route, a client-report route and a runs prefix', () => {
  const { webServer, disposers } = setup()
  assert.equal(webServer.routes.length, 5)
  assert.deepEqual(webServer.routes.map((route) => [route.kind, route.path]), [
    ['exact', `${API_PREFIX}/client-report`],
    ['exact', `${API_PREFIX}/health`],
    ['exact', `${API_PREFIX}/models`],
    ['exact', `${API_PREFIX}/project`],
    ['prefix', `${API_PREFIX}/runs`],
  ])
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(webServer.routes.length, 4)
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
  })
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

test('the project route resolves the session directory and its name', async () => {
  const projectDir = path.join(process.cwd(), 'test', '.tmp', 'session-project')
  const { webServer } = setup({
    resolveProjectPath: async (sessionId) => (sessionId === 'session-1' ? projectDir : undefined),
  })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=session-1`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { projectPath: path.resolve(projectDir), name: 'session-project' })
})

test('the project route falls back to the profile working directory', async () => {
  const fallbackDir = path.join(process.cwd(), 'test', '.tmp', 'profile-project')
  const { webServer } = setup({
    resolveProjectPath: async () => undefined,
    defaultDirectory: () => fallbackDir,
  })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=fresh-session`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { projectPath: path.resolve(fallbackDir), name: 'profile-project' })
})

test('the project route answers with nulls when no project is known yet', async () => {
  const { webServer } = setup({ resolveProjectPath: async () => undefined })
  const response = await call(webServer.routes, `${API_PREFIX}/project?sessionId=fresh-session`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { projectPath: null, name: null })
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
