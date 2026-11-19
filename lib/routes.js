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
   */
  constructor(message, status = 500, code = 'artel/error') {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
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
 */
export function writeError(response, status, message, code) {
  writeJson(response, status, { error: message, ...(code === undefined ? {} : { code }) })
}

/**
 * Read a JSON request body.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {Promise<unknown>} parsed body, or undefined when empty.
 */
export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RouteError('Request body is too large', 413, 'artel/body-too-large')
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
 * @returns {Promise<{ projectPath: string | null, name: string | null }>} project path and its basename.
 */
export async function resolveProject({ sessionId, resolveProjectPath, defaultDirectory }) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new RouteError('sessionId is required', 400, 'artel/bad-request')
  }
  let projectPath
  if (typeof resolveProjectPath === 'function') {
    try {
      projectPath = await resolveProjectPath(sessionId)
    } catch {
      // The session may be too fresh to have a project directory: try the fallback.
      projectPath = undefined
    }
  }
  if (typeof projectPath !== 'string' || projectPath === '') {
    const fallback = typeof defaultDirectory === 'function' ? defaultDirectory() : defaultDirectory
    projectPath = typeof fallback === 'string' && fallback !== '' ? fallback : undefined
  }
  if (typeof projectPath !== 'string' || projectPath === '') return { projectPath: null, name: null }
  const resolved = path.resolve(projectPath)
  return { projectPath: resolved, name: path.basename(resolved) }
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
        if (!response.headersSent) writeError(response, status, error?.message ?? 'Artel failed', code)
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
 * @param {string | (() => string | undefined)} [options.defaultDirectory] - profile working directory used when the session has none yet.
 * @param {() => Record<string, unknown>} [options.diagnostics] - reports how the Host wired this package.
 * @param {string} options.version - plugin version reported by the API.
 * @param {Pick<Console, 'warn' | 'info'>} [options.log] - logger.
 * @returns {Array<() => void>} disposers for the registered routes.
 */
export function registerArtelRoutes({ webServer, engine, resolveProjectPath, defaultDirectory, version, diagnostics, writeClientReport, log = console }) {
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
          const explicit = typeof body?.projectPath === 'string' && body.projectPath !== '' ? body.projectPath : undefined
          const projectPath = explicit ?? (typeof resolveProjectPath === 'function' ? await resolveProjectPath(sessionId) : undefined)
          const run = await engine.start({
            sessionId,
            projectPath,
            mode: body?.mode,
            task: body?.task,
            model: body?.model,
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

  return disposers
}
