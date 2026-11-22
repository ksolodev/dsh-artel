/**
 * HTTP routes for dsh-artel.
 *
 * The plugin ships its own small same-origin API instead of a Typert Remote
 * namespace: the browser module calls plain `fetch`, the Host serves plain
 * `node:http`, and no client code generation is involved.
 *
 * Every route sits behind a loopback fence copied from the shipped plugins:
 * plugin routes get no Host authentication, so a request must come from this
 * machine, from the page this Host serves.
 */

import path from 'node:path'

import { projectKeyOf } from './project-key.js'
import { queueModeRefusal } from './queue.js'
import { availableLocales, isValidLanguageTag, readSettings, writeSettings } from './settings.js'

/** Prefix shared by every artel route. */
export const API_PREFIX = '/api/dsh-artel'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 512 * 1024

/**
 * An error with an HTTP status and a stable code.
 */
export class RouteError extends Error {
  /**
   * @param {string} message - human-readable message.
   * @param {number} [status] - HTTP status.
   * @param {string} [code] - stable machine code.
   * @param {object | null} [params] - message parameters the client interpolates.
   */
  constructor(message, status = 500, code = 'artel/error', params = null) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
    this.params = params
  }
}

/**
 * Whether a request comes from this machine and from the page this Host serves.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {boolean} true when the request may reach a artel route.
 */
export function isLoopbackRequest(request) {
  const socket = request.socket
  const remote = socket?.remoteAddress
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  const hostname = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return false
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return false
    }
    if (originHost !== host) return false
  }
  return true
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - response to write.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 */
export function writeJson(response, status, body) {
  const text = JSON.stringify(body ?? null)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(text)
}

/**
 * Write one JSON error.
 * @param {import('node:http').ServerResponse} response - response to write.
 * @param {number} status - HTTP status.
 * @param {string} message - message shown to the user.
 * @param {string} [code] - stable machine code.
 * @param {unknown} [details] - extra payload the client needs to act (drift files, merge conflicts).
 * @param {object | null} [params] - message parameters the client interpolates.
 */
export function writeError(response, status, message, code, details = null, params = null) {
  const body = { error: message, code }
  if (details !== null && details !== undefined) body.details = details
  if (params !== null && params !== undefined) body.params = params
  writeJson(response, status, body)
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {number} [maxBytes] - largest accepted body.
 * @returns {Promise<unknown>} parsed body, or undefined when empty.
 */
export async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new RouteError('Request body is too large', 413, 'artel/body-too-large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new RouteError('Request body is not valid JSON', 400, 'artel/bad-json')
  }
}

/**
 * Read one query parameter.
 * @param {URL} url - request URL.
 * @param {string} name - parameter name.
 * @returns {string | undefined} parameter value.
 */
export function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/**
 * Resolve the project a chat session belongs to, for the Artel hero.
 *
 * The session's own working directory wins; a fresh session may not have one
 * yet, so the profile's `workingDirectory.defaultDirectory` is the fallback.
 * When neither exists the answer is null and the client shows its "no project"
 * state instead of an error.
 * @param {object} request - resolution inputs.
 * @param {string | undefined} request.sessionId - chat session id from the query string.
 * @param {(sessionId: string) => Promise<string> | string} [request.resolveProjectPath] - project lookup used by POST /runs.
 * @param {string | (() => string | undefined)} [request.defaultDirectory] - profile fallback working directory.
 * @returns {Promise<{ projectPath: string | null, name: string | null, projectKey: string | null }>} project path, its basename and its canonical key.
 */
export async function resolveProject({ sessionId, resolveProjectPath, defaultDirectory }) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new RouteError('sessionId is required', 400, 'artel/bad-request')
  }
  let projectPath
  if (typeof resolveProjectPath === 'function') {
    try {
      projectPath = await resolveProjectPath(sessionId)
    } catch (error) {
      if (error?.code === 'artel/unknown-session') throw error
      // The session may be too fresh to have a project directory: try the fallback.
      projectPath = undefined
    }
  }
  if (typeof projectPath !== 'string' || projectPath === '') {
    const fallback = typeof defaultDirectory === 'function' ? defaultDirectory() : defaultDirectory
    projectPath = typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  }
  if (typeof projectPath !== 'string' || projectPath === '') return { projectPath: null, name: null, projectKey: null }
  const resolved = path.resolve(projectPath)
  // The client compares this key with the keys in `GET /chats` to show only the
  // chats of the project whose panel is open.
  return { projectPath: resolved, name: path.basename(resolved), projectKey: await projectKeyOf(resolved) }
}

/**
 * Build one route handler that adds the fence and the error mapping.
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, url: URL) => Promise<void> | void} handler
 * @param {{ log?: Pick<Console, 'warn'> }} [options]
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} route handler.
 */
function fenced(handler, options = {}) {
  return (request, response) => {
    if (!isLoopbackRequest(request)) {
      writeError(response, 403, 'Artel routes only accept requests from this machine', 'artel/forbidden')
      return
    }
    let url
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    } catch {
      writeError(response, 400, 'Invalid request URL', 'artel/bad-url')
      return
    }
    Promise.resolve()
      .then(() => handler(request, response, url))
      .catch((error) => {
        const status = Number.isInteger(error?.status) ? error.status : 500
        const code = typeof error?.code === 'string' ? error.code : 'artel/internal'
        if (status >= 500) options.log?.warn?.(`dsh-artel route failed: ${error?.stack ?? String(error)}`)
        if (!response.headersSent) writeError(response, status, error?.message ?? 'Artel failed', code, error?.details ?? null, error?.params ?? null)
        else response.end()
      })
  }
}

/**
 * Split the tail of a artel run URL into decoded path segments.
 * @param {string} pathname - request pathname.
 * @param {string} prefix - route prefix.
 * @returns {string[]} segments after the prefix.
 */
export function tailSegments(pathname, prefix) {
  const tail = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
  return tail.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      throw new RouteError('Malformed path', 400, 'artel/bad-path')
    }
  })
}

/**
 * Register the artel HTTP API on the Host web server.
 * @param {object} options - route dependencies.
 * @param {{ register(route: { kind: 'prefix' | 'exact', path: string, handler: Function }): () => void }} options.webServer - Host web server.
 * @param {import('./engine.js').ArtelEngine} options.engine - run orchestrator.
 * @param {(sessionId: string) => Promise<string> | string} [options.resolveProjectPath] - looks the project directory up from the chat session.
 * @param {(sessionId: string) => boolean | Promise<boolean>} [options.hasSession] - tells a real chat session from a stale id before a run starts.
 * @param {string | (() => string | undefined)} [options.defaultDirectory] - profile working directory used when the session has none yet.
 * @param {() => Record<string, unknown>} [options.diagnostics] - reports how the Host wired this package.
 * @param {(() => Promise<object> | object) | object} [options.gitStatus] - probe of the git binary used by the queue and the Factory; a function is called on every health request.
 * @param {string} options.version - plugin version reported by the API.
 * @param {import('./queue-runner.js').QueueRunner} [options.queueRunner] - «Автоочередь» runner; queue routes are skipped when absent.
 * @param {import('./factory-runner.js').FactoryRunner} [options.factoryRunner] - «Фабрика» runner; factory routes are skipped when absent.
 * @param {string | null} [options.stateDir] - profile state directory that holds `settings.json`; the settings routes need it and a `localeDir`.
 * @param {string | null} [options.localeDir] - directory with the `<tag>.json` catalogs; the settings routes need it and a `stateDir`.
 * @param {Pick<Console, 'warn' | 'info'>} [options.log] - logger.
 * @returns {Array<() => void>} disposers for the registered routes.
 */
export function registerArtelRoutes({ webServer, engine, resolveProjectPath, hasSession = null, defaultDirectory, version, diagnostics, gitStatus = null, writeClientReport, queueRunner = null, factoryRunner = null, stateDir = null, localeDir = null, log = console }) {
  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/client-report`,
    handler: fenced(async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method !== 'POST') throw new RouteError('method not allowed', 405, 'artel/method')
      const body = await readJsonBody(request)
      let stored = { ok: false, error: 'no client-report sink' }
      if (typeof writeClientReport === 'function') {
        try {
          stored = await writeClientReport(body)
        } catch (error) {
          stored = { ok: false, error: String(error?.message ?? error) }
        }
      }
      writeJson(response, 200, stored)
    }, { log }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/health`,
    handler: fenced(async (request, response) => {
      const report = { ok: true, version }
      if (gitStatus !== null && gitStatus !== undefined) {
        try {
          report.git = typeof gitStatus === 'function' ? await gitStatus() : gitStatus
        } catch (error) {
          report.git = { ok: false, reason: 'unreadable', detail: String(error?.message ?? error) }
        }
      }
      if (typeof diagnostics === 'function') {
        try {
          report.diagnostics = diagnostics()
        } catch (error) {
          report.diagnostics = { error: String(error?.message ?? error) }
        }
      }
      writeJson(response, 200, report)
    }, { log }),
  }))

  // The language lives per profile, so the routes only exist when the Host
  // told us where the profile state and the bundled catalogs are.
  if (typeof stateDir === 'string' && stateDir !== '' && typeof localeDir === 'string' && localeDir !== '') {
    const settingsBody = async () => ({
      language: (await readSettings(stateDir)).language,
      available: (await availableLocales(localeDir)).map(({ id, nativeName }) => ({ id, nativeName })),
    })

    disposers.push(webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: fenced(async (request, response) => {
        const method = (request.method ?? 'GET').toUpperCase()
        if (method === 'GET') {
          writeJson(response, 200, await settingsBody())
          return
        }
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const language = body?.language ?? null
        if (language !== null) {
          if (!isValidLanguageTag(language)) throw new RouteError('Unsupported language', 400, 'artel/bad-language', { language })
          const available = await availableLocales(localeDir)
          if (!available.some((entry) => entry.id === language)) {
            throw new RouteError('Unsupported language', 400, 'artel/bad-language', { language })
          }
        }
        await writeSettings(stateDir, { language })
        writeJson(response, 200, await settingsBody())
      }, { log }),
    }))
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/models`,
    handler: fenced(async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
      const catalog = await engine.models()
      writeJson(response, 200, catalog)
    }, { log }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/project`,
    handler: fenced(async (request, response, url) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
      writeJson(response, 200, await resolveProject({
        sessionId: queryParam(url, 'sessionId'),
        resolveProjectPath,
        defaultDirectory,
      }))
    }, { log }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/chats`,
    handler: fenced(async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
      // Issue #11: one Artel project spans several chats (the task chat, the
      // Orchestrator, Fusion, review chats). The rail and the sidebar badge need
      // that list, not the runs of the chat that happens to be open.
      writeJson(response, 200, { chats: await engine.listChats() })
    }, { log }),
  }))

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${API_PREFIX}/runs`,
    handler: fenced(async (request, response, url) => {
      const segments = tailSegments(url.pathname, `${API_PREFIX}/runs`)
      const method = (request.method ?? 'GET').toUpperCase()

      if (segments.length === 0) {
        if (method === 'GET') {
          const sessionId = queryParam(url, 'sessionId')
          if (sessionId === undefined || sessionId === '') {
            throw new RouteError('sessionId is required', 400, 'artel/bad-request')
          }
          writeJson(response, 200, { runs: engine.listRuns(sessionId) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(request)
          const sessionId = body?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new RouteError('sessionId is required', 400, 'artel/bad-request')
          }
          if (typeof hasSession === 'function' && !(await hasSession(sessionId))) {
            throw new RouteError('Unknown chat session', 404, 'artel/unknown-session')
          }
          const explicit = typeof body?.projectPath === 'string' && body.projectPath !== '' ? body.projectPath : undefined
          const projectPath = explicit ?? (typeof resolveProjectPath === 'function' ? await resolveProjectPath(sessionId) : undefined)
          const run = await engine.start({
            sessionId,
            projectPath,
            mode: body?.mode,
            task: body?.task,
            model: body?.model,
            models: body?.models,
            // A task started from a chat gets its own chat in the project, so the
            // run is never tied to whatever conversation the panel was in.
            newChat: body?.newChat !== false,
          })
          writeJson(response, 201, { run })
          return
        }
        throw new RouteError('Method not allowed', 405, 'artel/method')
      }

      const runId = segments[0]
      const action = segments[1]

      if (action === undefined) {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const cursor = Number(queryParam(url, 'cursor') ?? '0')
        const limit = Number(queryParam(url, 'limit') ?? '200')
        const run = engine.getRun(runId)
        const feed = await engine.readFeed(runId, {
          cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
          limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 200,
        })
        writeJson(response, 200, { run, feed })
        return
      }

      if (action === 'agents') {
        const agentId = segments[2]
        if (segments.length !== 4 || segments[3] !== 'model' || agentId === undefined) {
          throw new RouteError('Unknown artel route', 404, 'artel/not-found')
        }
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        // Accept both `{ model: {…} }` and the bare selection, so a caller can
        // post what it read from the run record without re-wrapping it. The
        // bare shape has a string `model` property of its own, so a plain
        // `body.model ?? body` would hand the engine the model id alone.
        const selection = body !== null && typeof body === 'object' && body.model !== null && typeof body.model === 'object'
          ? body.model
          : body
        writeJson(response, 200, { run: await engine.setAgentModel(runId, agentId, selection) })
        return
      }

      if (action === 'install') {
        // GET  /runs/:id/install             — what the applied project needs
        // POST /runs/:id/install/bundle      — install the project into DSH
        // POST /runs/:id/install/steps/:i    — run one declared step, after a click
        if (segments.length === 2) {
          if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
          const refresh = queryParam(url, 'refresh')
          const install = await engine.installPlan(runId, { refresh: refresh === '1' || refresh === 'true' })
          writeJson(response, 200, { install, run: engine.getRun(runId) })
          return
        }
        if (segments.length === 3 && segments[2] === 'bundle') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          writeJson(response, 200, { run: await engine.installBundle(runId) })
          return
        }
        if (segments.length === 4 && segments[2] === 'steps' && segments[3] !== undefined) {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          writeJson(response, 200, { run: await engine.runInstallStep(runId, Number(segments[3])) })
          return
        }
        throw new RouteError('Unknown artel route', 404, 'artel/not-found')
      }

      if (segments.length !== 2) throw new RouteError('Unknown artel route', 404, 'artel/not-found')

      if (action === 'messages') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        writeJson(response, 200, {
          run: await engine.message(runId, { text: body?.text, agentId: body?.agentId }),
        })
        return
      }

      if (action === 'interrupt') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        writeJson(response, 200, { run: await engine.interrupt(runId) })
        return
      }

      if (action === 'changes') {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        writeJson(response, 200, { changes: await engine.changes(runId) })
        return
      }

      if (action === 'diff') {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const path = queryParam(url, 'path')
        if (path === undefined || path === '') throw new RouteError('path is required', 400, 'artel/bad-request')
        writeJson(response, 200, { file: await engine.fileDiff(runId, path) })
        return
      }

      if (action === 'apply') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const paths = Array.isArray(body?.paths) ? body.paths.filter((item) => typeof item === 'string') : undefined
        const result = await engine.apply(runId, paths)
        writeJson(response, 200, { ...result, run: engine.getRun(runId) })
        return
      }

      if (action === 'discard') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        writeJson(response, 200, { run: await engine.discard(runId) })
        return
      }

      throw new RouteError('Unknown artel route', 404, 'artel/not-found')
    }, { log }),
  }))

  if (queueRunner !== null && queueRunner !== undefined) {
    disposers.push(...registerQueueRoutes({ webServer, queueRunner, resolveProjectPath, defaultDirectory, log }))
  }
  if (factoryRunner !== null && factoryRunner !== undefined) {
    disposers.push(...registerFactoryRoutes({ webServer, factoryRunner, resolveProjectPath, defaultDirectory, log }))
  }

  return disposers
}

/** Largest request body accepted by the factory routes, because tickets carry pasted screenshots. */
const FACTORY_MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Resolve the project for a queue or factory request: an explicit `projectPath`
 * wins, then the chat session's own directory, then the profile default.
 * @param {object} input - resolution inputs.
 * @param {Record<string, unknown> | undefined} [input.body] - request body.
 * @param {URL | null} [input.url] - request URL, for query parameters.
 * @param {(sessionId: string) => Promise<string> | string} [input.resolveProjectPath] - session lookup.
 * @param {string | (() => string | undefined)} [input.defaultDirectory] - profile fallback.
 * @returns {Promise<string | null>} resolved project path or null.
 */
async function projectForRequest({ body = null, url = null, resolveProjectPath, defaultDirectory }) {
  const fromBody = body !== null && body !== undefined && typeof body.projectPath === 'string' && body.projectPath !== '' ? body.projectPath : undefined
  const explicit = fromBody ?? (url instanceof URL ? queryParam(url, 'projectPath') : undefined)
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit)
  const sessionId = body?.sessionId ?? (url instanceof URL ? queryParam(url, 'sessionId') : undefined)
  if (typeof sessionId === 'string' && sessionId !== '' && typeof resolveProjectPath === 'function') {
    try {
      const found = await resolveProjectPath(sessionId)
      if (typeof found === 'string' && found !== '') return path.resolve(found)
    } catch (error) {
      // A stale id must not silently borrow the profile fallback: only a real
      // session that has no cwd yet may use the default directory.
      if (error?.code === 'artel/unknown-session') throw error
      // A fresh session may not have a project directory yet: try the fallback.
    }
  }
  const fallback = typeof defaultDirectory === 'function' ? defaultDirectory() : defaultDirectory
  return typeof fallback === 'string' && fallback !== '' ? path.resolve(fallback) : null
}

/**
 * Read one required session id.
 * @param {unknown} value - raw value.
 * @returns {string} session id.
 */
function requireSessionId(value) {
  if (typeof value !== 'string' || value === '') throw new RouteError('sessionId is required', 400, 'artel/bad-request')
  return value
}

/**
 * Register the «Автоочередь» routes: the queue itself, its pre-flight, the
 * toggle and the per-task actions of the queue column.
 * @param {object} options - dependencies.
 * @param {{ register(route: { kind: 'prefix' | 'exact', path: string, handler: Function }): () => void }} options.webServer - Host web server.
 * @param {import('./queue-runner.js').QueueRunner} options.queueRunner - queue runner.
 * @param {(sessionId: string) => Promise<string> | string} [options.resolveProjectPath] - session project lookup.
 * @param {string | (() => string | undefined)} [options.defaultDirectory] - profile fallback.
 * @param {Pick<Console, 'warn'>} [options.log] - logger.
 * @returns {Array<() => void>} disposers.
 */
export function registerQueueRoutes({ webServer, queueRunner, resolveProjectPath, defaultDirectory, log = console }) {
  const disposers = []

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${API_PREFIX}/queue`,
    handler: fenced(async (request, response, url) => {
      const segments = tailSegments(url.pathname, `${API_PREFIX}/queue`)
      const method = (request.method ?? 'GET').toUpperCase()
      const unavailable = () => { throw new RouteError('Autopilot is not available on this Host', 503, 'artel/unavailable') }
      if (queueRunner === null || queueRunner === undefined) unavailable()

      if (segments.length === 0) {
        if (method === 'GET') {
          const sessionId = requireSessionId(queryParam(url, 'sessionId'))
          const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, await queueRunner.summary(sessionId, { projectPath }))
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          const projectPath = await projectForRequest({ body, resolveProjectPath, defaultDirectory })
          const texts = Array.isArray(body?.texts) ? body.texts.filter((item) => typeof item === 'string') : []
          const task = typeof body?.task === 'string' ? body.task : ''
          if (texts.length === 0 && task.trim() === '') {
            throw new RouteError('texts or task is required', 400, 'artel/bad-request')
          }
          const mode = typeof body?.mode === 'string' && body.mode !== '' ? body.mode : 'solo'
          const refusal = queueModeRefusal(mode)
          if (refusal !== null) throw new RouteError(refusal.message, 400, refusal.code)
          const branchId = typeof body?.branchId === 'string' && body.branchId !== '' ? body.branchId : null
          const added = await queueRunner.addTasks({
            sessionId,
            projectPath,
            texts,
            task,
            mode,
            model: body?.model ?? null,
            prepend: body?.prepend === true,
            basePath: typeof body?.basePath === 'string' && body.basePath !== '' ? body.basePath : null,
            // Only a real choice is forwarded: 0.12 callers keep their exact payload.
            ...(branchId === null ? {} : { branchId }),
          })
          writeJson(response, 200, added)
          return
        }
        throw new RouteError('Method not allowed', 405, 'artel/method')
      }

      const action = segments[0]

      if (action === 'preflight') {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const sessionId = requireSessionId(queryParam(url, 'sessionId'))
        const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
        writeJson(response, 200, await queueRunner.preflight(sessionId, { projectPath }))
        return
      }

      if (action === 'autopilot') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body?.sessionId)
        if (typeof body?.autopilot !== 'boolean') {
          throw new RouteError('autopilot must be a boolean', 400, 'artel/bad-request')
        }
        const projectPath = await projectForRequest({ body, resolveProjectPath, defaultDirectory })
        writeJson(response, 200, await queueRunner.setAutopilot({
          sessionId,
          projectPath,
          autopilot: body.autopilot,
          limit: body?.limit,
          checkCommand: body?.checkCommand,
          checkDisabled: body?.checkDisabled,
          saveVersionRunIds: Array.isArray(body?.saveVersionRunIds) ? body.saveVersionRunIds.filter((item) => typeof item === 'string') : [],
          postponeVersionRunIds: Array.isArray(body?.postponeVersionRunIds) ? body.postponeVersionRunIds.filter((item) => typeof item === 'string') : [],
          decisions: body?.decisions === true,
        }))
        return
      }

      if (action === 'stop' || action === 'finish-after-current') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body?.sessionId)
        const queue = action === 'stop' ? await queueRunner.stop(sessionId) : await queueRunner.finishAfterCurrent(sessionId)
        writeJson(response, 200, { queue })
        return
      }

      if (action === 'clear') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body?.sessionId)
        writeJson(response, 200, { queue: await queueRunner.clearFinished(sessionId) })
        return
      }

      if (action === 'tasks') {
        const taskId = segments[1]
        if (taskId === undefined) throw new RouteError('Unknown queue route', 404, 'artel/not-found')
        const verb = segments[2]
        const body = method === 'POST' ? await readJsonBody(request) : undefined
        const sessionId = requireSessionId(body?.sessionId ?? queryParam(url, 'sessionId'))
        if (verb === undefined && method === 'DELETE') {
          writeJson(response, 200, { queue: await queueRunner.removeTask(sessionId, taskId) })
          return
        }
        if (verb === 'retry') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          writeJson(response, 200, { queue: await queueRunner.retryTask(sessionId, taskId) })
          return
        }
        if (verb === 'move') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          writeJson(response, 200, { queue: await queueRunner.moveTask(sessionId, taskId, { direction: body?.direction === 'down' ? 'down' : 'up' }) })
          return
        }
        throw new RouteError('Unknown queue route', 404, 'artel/not-found')
      }

      if (action === 'versions') {
        const runId = segments[1]
        const verb = segments[2]
        if (runId === undefined || (verb !== 'save' && verb !== 'postpone')) throw new RouteError('Unknown queue route', 404, 'artel/not-found')
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body?.sessionId)
        const result = verb === 'save' ? await queueRunner.saveVersion(sessionId, runId) : { queue: await queueRunner.postponeVersion(sessionId, runId) }
        writeJson(response, 200, result)
        return
      }

      if (action === 'project-state') {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const sessionId = requireSessionId(queryParam(url, 'sessionId'))
        // Resolve the project like the queue routes do: a stale session id
        // must fail here instead of silently borrowing the profile default.
        const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
        writeJson(response, 200, await queueRunner.projectState(sessionId, { projectPath }))
        return
      }

      if (action === 'maintenance') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body?.sessionId)
        // Resolve the project like the queue routes do: a stale session id
        // must fail here instead of silently borrowing the profile default.
        const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
        writeJson(response, 200, await queueRunner.maintenance(sessionId, { projectPath }))
        return
      }

      if (action === 'branches') {
        const branchId = segments[1]
        const verb = segments[2]

        if (branchId === undefined) {
          if (method === 'GET') {
            const sessionId = requireSessionId(queryParam(url, 'sessionId'))
            // Resolve the project like the queue routes do: a stale session id
            // must fail here instead of silently borrowing the profile default.
            const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
            writeJson(response, 200, await queueRunner.branchesSummary(sessionId, { projectPath }))
            return
          }
          if (method === 'POST') {
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body?.sessionId)
            const name = typeof body?.name === 'string' ? body.name : ''
            const fromCommit = typeof body?.fromCommit === 'string' && body.fromCommit !== '' ? body.fromCommit : null
            // Resolve the project like the queue routes do: a stale session id
            // must fail here instead of silently borrowing the profile default.
            const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
            writeJson(response, 200, await queueRunner.createBranch(sessionId, { name, fromCommit, switchTo: body?.switchTo !== false }, { projectPath }))
            return
          }
          throw new RouteError('Method not allowed', 405, 'artel/method')
        }

        if (verb === undefined) {
          if (method === 'PATCH') {
            const body = await readJsonBody(request)
            const sessionId = requireSessionId(body?.sessionId)
            if (typeof body?.name !== 'string' || body.name.trim() === '') throw new RouteError('name is required', 400, 'artel/bad-request')
            // Resolve the project like the queue routes do: a stale session id
            // must fail here instead of silently borrowing the profile default.
            const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
            writeJson(response, 200, await queueRunner.renameBranch(sessionId, branchId, body.name, { projectPath }))
            return
          }
          if (method === 'DELETE') {
            const sessionId = requireSessionId(queryParam(url, 'sessionId'))
            // Resolve the project like the queue routes do: a stale session id
            // must fail here instead of silently borrowing the profile default.
            const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
            writeJson(response, 200, await queueRunner.removeBranch(sessionId, branchId, { projectPath }))
            return
          }
          throw new RouteError('Method not allowed', 405, 'artel/method')
        }

        if (verb === 'switch') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, await queueRunner.switchBranch(sessionId, branchId, { projectPath }))
          return
        }

        if (verb === 'commits') {
          if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
          const sessionId = requireSessionId(queryParam(url, 'sessionId'))
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, { commits: await queueRunner.branchCommits(sessionId, branchId, { projectPath }) })
          return
        }

        if (verb === 'apply') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, await queueRunner.applyBranch(sessionId, {
            branchId,
            commitIds: Array.isArray(body?.commitIds) ? body.commitIds.filter((item) => typeof item === 'string') : null,
            confirmDrift: body?.confirmDrift === true,
            checkCommand: typeof body?.checkCommand === 'string' ? body.checkCommand : '',
            force: body?.force === true,
          }, { projectPath }))
          return
        }

        if (verb === 'merge') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          const sourceBranchId = typeof body?.sourceBranchId === 'string' && body.sourceBranchId !== '' ? body.sourceBranchId : null
          if (sourceBranchId === null) throw new RouteError('sourceBranchId is required', 400, 'artel/bad-request')
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, await queueRunner.mergeBranches(sessionId, {
            targetBranchId: branchId,
            sourceBranchId,
            checkCommand: typeof body?.checkCommand === 'string' ? body.checkCommand : '',
            force: body?.force === true,
          }, { projectPath }))
          return
        }

        if (verb === 'export') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          const target = typeof body?.target === 'string' && body.target !== '' ? body.target : null
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
          writeJson(response, 200, await queueRunner.exportBranch(sessionId, { branchId, target }, { projectPath }))
          return
        }

        if (verb === 'revert') {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request)
          const sessionId = requireSessionId(body?.sessionId)
          // Resolve the project like the queue routes do: a stale session id
          // must fail here instead of silently borrowing the profile default.
          const projectPath = await projectForRequest({ body, url, resolveProjectPath, defaultDirectory })
          // No force flag on purpose: a revert refuses drift instead of overriding it.
          writeJson(response, 200, await queueRunner.revertApply(sessionId, { branchId }, { projectPath }))
          return
        }

        throw new RouteError('Unknown queue route', 404, 'artel/not-found')
      }

      throw new RouteError('Unknown queue route', 404, 'artel/not-found')
    }, { log }),
  }))

  return disposers
}

/**
 * Register the «Фабрика» routes: boards, settings, readiness, tickets, the
 * pipeline actions and the tracker poll.
 * @param {object} options - dependencies.
 * @param {{ register(route: { kind: 'prefix' | 'exact', path: string, handler: Function }): () => void }} options.webServer - Host web server.
 * @param {import('./factory-runner.js').FactoryRunner} options.factoryRunner - factory runner.
 * @param {(sessionId: string) => Promise<string> | string} [options.resolveProjectPath] - session project lookup.
 * @param {string | (() => string | undefined)} [options.defaultDirectory] - profile fallback.
 * @param {Pick<Console, 'warn'>} [options.log] - logger.
 * @returns {Array<() => void>} disposers.
 */
export function registerFactoryRoutes({ webServer, factoryRunner, resolveProjectPath, defaultDirectory, log = console }) {
  const disposers = []

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${API_PREFIX}/factory`,
    handler: fenced(async (request, response, url) => {
      const segments = tailSegments(url.pathname, `${API_PREFIX}/factory`)
      const method = (request.method ?? 'GET').toUpperCase()
      if (factoryRunner === null || factoryRunner === undefined) {
        throw new RouteError('The factory is not available on this Host', 503, 'artel/unavailable')
      }

      if (segments.length === 0) {
        if (method === 'GET') {
          writeJson(response, 200, { boards: factoryRunner.listBoards() })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(request)
          const projectPath = await projectForRequest({ body, resolveProjectPath, defaultDirectory })
          if (projectPath === null) throw new RouteError('projectPath is required', 400, 'artel/bad-request')
          writeJson(response, 200, await factoryRunner.createBoard({ projectPath, name: typeof body?.name === 'string' ? body.name : null }))
          return
        }
        throw new RouteError('Method not allowed', 405, 'artel/method')
      }

      const boardId = segments[0]
      if (boardId === 'poll-trackers') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        writeJson(response, 200, await factoryRunner.pollTrackers(typeof body?.boardId === 'string' ? body.boardId : null))
        return
      }

      if (segments.length === 1) {
        if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
        const view = factoryRunner.view(boardId)
        writeJson(response, 200, { boards: factoryRunner.listBoards(), board: view.board, tickets: view.tickets })
        return
      }

      const section = segments[1]
      if (section === 'settings') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        writeJson(response, 200, { board: await factoryRunner.updateBoard(boardId, body ?? {}) })
        return
      }
      if (section === 'readiness') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        writeJson(response, 200, await factoryRunner.checkReadiness(boardId))
        return
      }
      if (section === 'poll') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        writeJson(response, 200, await factoryRunner.pollTrackers(boardId))
        return
      }
      if (section === 'tickets') {
        if (segments.length === 2) {
          if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
          const body = await readJsonBody(request, FACTORY_MAX_BODY_BYTES)
          const attachments = Array.isArray(body?.attachments) ? body.attachments.slice(0, 8) : []
          writeJson(response, 200, {
            ticket: await factoryRunner.addTicket(boardId, {
              title: typeof body?.title === 'string' ? body.title : '',
              text: body?.text,
              attachments,
              source: body?.source ?? null,
            }),
          })
          return
        }
        if (segments[2] === undefined) throw new RouteError('Unknown factory route', 404, 'artel/not-found')
        if (segments[3] === undefined) {
          if (method !== 'GET') throw new RouteError('Method not allowed', 405, 'artel/method')
          const cursor = Number(queryParam(url, 'cursor') ?? '0')
          writeJson(response, 200, await factoryRunner.ticketView(boardId, segments[2], { cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0 }))
          return
        }
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const ticketId = segments[2]
        const verb = segments[3]
        const body = await readJsonBody(request)
        let result
        if (verb === 'answers') {
          result = { ticket: await factoryRunner.answerQuestions(boardId, ticketId, { text: body?.text, answers: body?.answers }) }
        } else if (verb === 'approve-plan') {
          result = { ticket: await factoryRunner.approvePlan(boardId, ticketId) }
        } else if (verb === 'repair') {
          result = { ticket: await factoryRunner.repairAction(boardId, ticketId, { action: body?.action }) }
        } else if (verb === 'return') {
          result = { ticket: await factoryRunner.returnToFactory(boardId, ticketId, { text: body?.text ?? null, title: body?.title ?? null }) }
        } else if (verb === 'comment') {
          result = { ticket: await factoryRunner.returnWithComment(boardId, ticketId, { comment: body?.comment }) }
        } else if (verb === 'pull-request') {
          result = { ticket: await factoryRunner.openPullRequest(boardId, ticketId) }
        } else if (verb === 'merge') {
          result = { ticket: await factoryRunner.mergeTicket(boardId, ticketId) }
        } else if (verb === 'takeover') {
          result = { ticket: await factoryRunner.takeOver(boardId, ticketId) }
        } else {
          throw new RouteError('Unknown factory route', 404, 'artel/not-found')
        }
        writeJson(response, 200, result)
        return
      }
      if (section === 'import') {
        if (method !== 'POST') throw new RouteError('Method not allowed', 405, 'artel/method')
        const body = await readJsonBody(request)
        writeJson(response, 200, { ticket: await factoryRunner.importGithubIssue(boardId, body?.ref) })
        return
      }

      throw new RouteError('Unknown factory route', 404, 'artel/not-found')
    }, { log }),
  }))

  return disposers
}
