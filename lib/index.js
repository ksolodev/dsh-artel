/**
 * dsh-artel — Host half.
 *
 * Runs a development task in an isolated copy of the current project, either
 * with one agent (solo), with three agents that first divide the files between
 * themselves (swarm), with the same team under a conductor that hands out the
 * shares and accepts the work as a whole (conductor), with a panel that answers
 * and a judge that decides before one implementer writes (fusion), or with a
 * planner that splits a big goal into parts worked in parallel copies and a
 * reviewer that checks every part against the plan (orchestrator). The user
 * watches a live feed, reviews a line-by-line diff, and applies what they like
 * with one button.
 *
 * Nothing here ever writes to the real project except the explicit Apply call,
 * and the agents themselves only ever see the copy: each agent Session is
 * created with `cwd = <copy>`.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { ArtelEngine } from './engine.js'
import { FactoryRunner } from './factory-runner.js'
import { TicketStore } from './factory.js'
import { HostDriver } from './host-driver.js'
import { QueueRunner } from './queue-runner.js'
import { QueueStore } from './queue.js'
import { RunStore } from './run-store.js'
import { API_PREFIX, registerArtelRoutes } from './routes.js'

/** Package name, also the loader module id and the patch row id. */
export const name = 'dsh-artel'

/** Services this plugin needs before it may start. */
export const inject = ['webServer']

/** Version reported by the health route. */
export const version = '0.10.0'

/** Directory under `<DSH_HOME>` that holds every profile's copies and run state. */
const DATA_DIR = 'artel'

/** The same directory under the plugin's pre-rename name (`dsh-forge`). */
const LEGACY_DATA_DIR = 'forge'

/** `DSH_HOME`, defaulting to `~/.dsh`. */
function dshHomeOf(env, home) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : path.join(home, '.dsh')
}

/** Default copy/state root: `<DSH_HOME>/artel/<profile>`. */
export function defaultDataRoot(env = process.env, home = homedir()) {
  return path.join(dshHomeOf(env, home), DATA_DIR, profileOf(env))
}

/** Data root of the pre-rename build: `<DSH_HOME>/forge/<profile>`. */
export function legacyDataRoot(env = process.env, home = homedir()) {
  return path.join(dshHomeOf(env, home), LEGACY_DATA_DIR, profileOf(env))
}

/**
 * Move the previous build's runs and copies to the new data root, once.
 *
 * The plugin was renamed from `dsh-forge` to `dsh-artel`, so an installed
 * profile keeps its old history under `<DSH_HOME>/forge/<profile>`. Rename the
 * directory on the first start (cheap: copies and feed files usually sit on the
 * same volume); if the rename is refused — typically because the old process
 * still holds a lock — copy the tree instead and leave the old directory for the
 * user to delete. An existing new root always wins: migration never merges or
 * overwrites.
 * @param {Record<string, string | undefined>} [env] - environment override source.
 * @param {string} [home] - home directory used when DSH_HOME is unset.
 * @returns {{ moved: boolean, from?: string, to?: string, how?: 'renamed' | 'copied', error?: string }} migration result.
 */
export function migrateDataRoot(env = process.env, home = homedir()) {
  const to = defaultDataRoot(env, home)
  const from = legacyDataRoot(env, home)
  if (from === to || !existsSync(from) || existsSync(to)) return { moved: false, from, to }
  try {
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(from, to)
    return { moved: true, from, to, how: 'renamed' }
  } catch (renameError) {
    try {
      cpSync(from, to, { recursive: true, force: true })
      try {
        rmSync(from, { recursive: true, force: true })
      } catch {}
      return { moved: true, from, to, how: 'copied' }
    } catch (copyError) {
      return { moved: false, from, to, error: String(copyError?.message ?? renameError?.message ?? copyError) }
    }
  }
}

/** Profile name used in the data path, from `DSH_PROFILE` or the profile directory. */
export function profileOf(env = process.env) {
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== '') return env.DSH_PROFILE
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR !== '') {
    const base = path.basename(path.resolve(env.DSH_PROFILE_DIR))
    if (base !== '' && base !== '.' && base !== path.sep) return base
  }
  return 'default'
}

/**
 * Validate and normalize plugin configuration.
 * @param {Record<string, unknown>} [config] - raw config from the patch row.
 * @param {Record<string, string | undefined>} [env] - environment override source.
 * @returns {{ copyRoot: string, stateDir: string, swarmAgentCount: number, orchestratorParts: number, maxRunsPerSession: number, keepCopiesHours: number, diffContext: number, idleGraceMs: number, excludeGlobs: string[] }} settings.
 */
export function resolveConfig(config = {}, env = process.env) {
  const root = defaultDataRoot(env)
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(parsed)))
  }
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? path.resolve(value) : fallback)
  const globs = Array.isArray(config.exclude) ? config.exclude.filter((item) => typeof item === 'string' && item !== '') : []
  return {
    copyRoot: text(config.copyRoot, path.join(root, 'copies')),
    stateDir: text(config.stateDir, path.join(root, 'state')),
    swarmAgentCount: number(config.swarmAgentCount, 3, 2, 8),
    // How many parts the Orchestrator planner is asked for. The hard cap is
    // MAX_ORCHESTRATOR_PARTS in lib/orchestrator.js: a longer plan is folded.
    orchestratorParts: number(config.orchestratorParts, 3, 2, 4),
    maxRunsPerSession: number(config.maxRunsPerSession, 10, 1, 100),
    keepCopiesHours: number(config.keepCopiesHours, 72, 0, 24 * 365),
    diffContext: number(config.diffContext, 3, 0, 12),
    // Shared-conversation swarms keep talking after a turn ends; a short grace
    // period keeps a transient "everyone is idle" out of the feed.
    idleGraceMs: number(config.idleGraceMs, 1200, 0, 10_000),
    excludeGlobs: globs,
  }
}

/**
 * Start the Host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - plugin config from the bundle patch row.
 * @returns {Promise<void>} completes once storage, agents and routes are ready.
 */
export async function apply(ctx, config = {}) {
  const migration = migrateDataRoot()
  const log = {
    info: (...args) => console.info('[dsh-artel]', ...args),
    warn: (...args) => console.warn('[dsh-artel]', ...args),
    error: (...args) => console.error('[dsh-artel]', ...args),
  }
  const settings = resolveConfig(config)
  const trace = (line) => {
    try {
      appendFileSync(path.join(settings.stateDir, 'startup.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
  trace(`apply start version=${version}`)
  if (migration.moved) {
    trace(`data root migrated ${migration.how} ${migration.from} -> ${migration.to}`)
    log.info?.(`dsh-artel: moved the previous data root to ${migration.to} (${migration.how})`)
  } else if (migration.error) {
    trace(`data root migration failed: ${migration.error}`)
    log.warn?.(`dsh-artel: could not move the previous data root: ${migration.error}`)
  }
  const store = new RunStore({ dir: path.join(settings.stateDir, 'runs'), feedLimitPerRun: 5000 })
  const driver = new HostDriver(ctx, { log })
  const engine = new ArtelEngine({
    store,
    driver,
    copyRoot: settings.copyRoot,
    config: {
      swarmAgentCount: settings.swarmAgentCount,
      orchestratorParts: settings.orchestratorParts,
      maxRunsPerSession: settings.maxRunsPerSession,
      keepCopiesHours: settings.keepCopiesHours,
      diffContext: settings.diffContext,
      idleGraceMs: settings.idleGraceMs,
      excludeGlobs: settings.excludeGlobs,
    },
    log,
  })

  const webServerUpFront = ctx.get?.('webServer')
  trace(`apply: webServer=${webServerUpFront ? 'present' : 'missing'} sessionController=${ctx.get?.('sessionController') ? 'present' : 'missing'}`)

  /**
   * Report how the Host wired this package, so an operator can tell a missing
   * client bundle from a browser-side failure without reading Host logs.
   * @returns {Record<string, unknown>} diagnostic fields for the health route.
   */
  const diagnostics = () => {
    const report = {}
    report.env = {
      profile: process.env.DSH_PROFILE ?? null,
      profileDir: process.env.DSH_PROFILE_DIR ?? null,
      home: process.env.DSH_HOME ?? null,
      dataRoot: settings.stateDir,
    }
    try {
      const clientModules = ctx.get?.('clientModules')
      if (clientModules === undefined || clientModules === null) {
        report.clientModules = 'missing'
      } else {
        report.clientModuleInstanceKeys = (() => {
          try {
            return Object.getOwnPropertyNames(clientModules).slice(0, 60)
          } catch {
            return null
          }
        })()
        report.clientModulePath = typeof clientModules.clientPath === 'function'
          ? (clientModules.clientPath(name) ?? null)
          : 'no-clientPath'

        try {
          const graph = typeof clientModules.graph === 'function' ? clientModules.graph() : undefined
          const entries = Array.isArray(graph?.entries) ? graph.entries : []
          report.clientModuleEntries = entries.length
          report.clientModuleRowPresent = entries.some((entry) => entry?.id === name)
          report.clientModuleRows = entries
            .filter((entry) => entry?.id === name)
            .map((entry) => ({ id: entry.id, url: entry.url, rev: entry.rev, immediately: entry.immediately }))
          try {
            const responses = clientModules.responses
            report.clientModuleResponseKeys = responses instanceof Map || responses instanceof Set
              ? responses.size
              : responses !== null && typeof responses === 'object' ? Object.keys(responses).length : 'unknown'
          } catch (error) {
            report.clientModuleResponseError = String(error?.message ?? error)
          }
        } catch (error) {
          report.clientModuleGraphError = String(error?.message ?? error)
        }
      }
    } catch (error) {
      report.clientModulesError = String(error?.message ?? error)
    }
    try {
      const loader = ctx.loader
      report.loaderEntries = typeof loader?.entries === 'function'
        ? [...loader.entries()].map((entry) => entry?.options?.name).filter((entryName) => typeof entryName === 'string')
        : null
    } catch (error) {
      report.loaderError = String(error?.message ?? error)
    }
    return report
  }

  let started = false

  /**
   * Bind the Host half to the services it needs. Runs once the web server and
   * the session controller are mounted, which can be after this plugin starts:
   * a plugin fiber may be created before its sibling services are ready, and
   * losing that race must not silently leave the Artel page without an API.
   * @param {import('@deepseek-ai/cordis').Context} scope - context with both services.
   * @returns {Promise<void>} completes once routes are registered.
   */
  const boot = async (scope) => {
    if (started) return
    started = true
    const owner = scope?.effect ? scope : ctx
    const webServer = scope?.get?.('webServer') ?? ctx.get?.('webServer')
    trace(`boot: webServer=${webServer ? 'present' : 'missing'} sessionController=${scope?.get?.('sessionController') ? 'present' : 'missing'}`)
    if (!webServer) {
      started = false
      log.warn?.('dsh-artel: no Host web server in this profile, so the Artel page cannot be served')
      return
    }
    let queueRunner = null
    let factoryRunner = null
    try {
      await store.init()
      await driver.init()
      await engine.init()
      const queueStore = new QueueStore({ dir: path.join(settings.stateDir, 'queue') })
      await queueStore.init()
      queueRunner = new QueueRunner({
        engine,
        store: queueStore,
        stateDir: settings.stateDir,
        copyRoot: settings.copyRoot,
        log,
      })
      await queueRunner.init()
      const ticketStore = new TicketStore({ dir: path.join(settings.stateDir, 'tickets') })
      await ticketStore.init()
      factoryRunner = new FactoryRunner({
        engine,
        store: ticketStore,
        stateDir: settings.stateDir,
        log,
      })
      await factoryRunner.init()
    } catch (error) {
      started = false
      trace(`boot failed: ${String(error?.message ?? error)}`)
      log.error?.(`dsh-artel: could not start: ${String(error?.stack ?? error)}`)
      return
    }

    /**
     * Fallback project directory of the profile: a fresh chat session may not
     * have a working directory of its own yet, and the hero still needs a
     * project to start the first run in.
     * @returns {string | undefined} profile default working directory.
     */
    const defaultProjectDirectory = () => {
      try {
        const service = scope?.get?.('workingDirectory') ?? ctx.get?.('workingDirectory')
        const directory = service?.defaultDirectory
        return typeof directory === 'string' && directory !== '' ? directory : undefined
      } catch {
        return undefined
      }
    }

    const disposers = registerArtelRoutes({
      webServer,
      engine,
      version,
      log,
      diagnostics,
      resolveProjectPath: (sessionId) => driver.projectPathOf(sessionId),
      defaultDirectory: defaultProjectDirectory,
      queueRunner,
      factoryRunner,
      writeClientReport: (body) => {
        const line = `${JSON.stringify({ at: new Date().toISOString(), report: body })}\n`
        appendFileSync(path.join(settings.stateDir, 'client.log'), line)
        return { ok: true, bytes: line.length }
      },
    })
    trace(`routes registered ${disposers.length}; port=${webServer.port}`)

    owner.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          log.warn?.(`dsh-artel: route cleanup failed: ${String(error)}`)
        }
      }
    }, 'dsh-artel: http routes')

    owner.effect(() => () => {
      Promise.resolve(engine.dispose?.()).catch((error) => {
        log.warn?.(`dsh-artel: shutdown failed: ${String(error)}`)
      })
      try {
        queueRunner?.dispose?.()
        factoryRunner?.dispose?.()
      } catch (error) {
        log.warn?.(`dsh-artel: runner shutdown failed: ${String(error)}`)
      }
    }, 'dsh-artel: engine')

    log.info?.(`dsh-artel: ready on ${API_PREFIX} (data in ${settings.stateDir})`)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'sessionController'], (scope) => {
        void boot(scope).catch((error) => {
          trace(`boot rejected: ${String(error?.message ?? error)}`)
        })
      })
    } catch (error) {
      trace(`inject unavailable: ${String(error?.message ?? error)}`)
      void boot(ctx)
    }
  } else {
    void boot(ctx)
  }
}
