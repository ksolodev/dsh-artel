/**
 * Client-half tests for dsh-artel.
 *
 * The browser module cannot be imported: it is a classic script that hands a
 * factory to `window.__ModuleLoader__`. This test recreates the loader, provides
 * a small React stand-in with real hook state (one render pass per state
 * change), a fake DSH client context, and a fake fetch that answers the Host
 * routes. It then drives the real page component: start a run, watch a swarm
 * planning feed, and apply a reviewed diff.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const KEYED_SLOTS = new Set(['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])

/* ------------------------------------------------------------------ React */

function createReact() {
  const state = {
    hooks: [], cursor: 0, effects: [], effectCursor: 0, dirty: false, elements: [], effectState: new Map(),
  }
  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    Fragment: Symbol.for('react.fragment'),
  }
  React.useState = (initial) => {
    const index = state.cursor++
    if (!(index in state.hooks)) state.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      const value = typeof next === 'function' ? next(state.hooks[index]) : next
      if (!Object.is(value, state.hooks[index])) {
        state.hooks[index] = value
        state.dirty = true
      }
    }
    return [state.hooks[index], set]
  }
  React.useRef = (initial) => {
    const index = state.cursor++
    if (!(index in state.hooks)) state.hooks[index] = { current: initial }
    return state.hooks[index]
  }
  React.useMemo = (factory) => factory()
  React.useCallback = (fn) => fn
  React.useEffect = (fn, deps) => {
    state.effects.push({ index: state.effectCursor++, fn, deps })
  }
  return { React, state }
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/* --------------------------------------------------------------- renderer */

function renderTree(node, state) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((item) => renderTree(item, state)).join('')
  const { type, props } = node
  if (typeof type === 'function') return renderTree(type(props), state)
  if (typeof type === 'symbol') return renderTree(props?.children, state)
  if (typeof type === 'string') {
    state.elements.push(node)
    return `${renderTree(props?.children, state)}`
  }
  return renderTree(props?.children, state)
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && typeof node.type === 'string') return [textOf(node.props?.children), textOf(node.props?.title)].filter(Boolean).join(' ')
  return ''
}

/* ----------------------------------------------------------------- loaders */

function memoryStorage() {
  const items = new Map()
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)) },
    removeItem: (key) => { items.delete(key) },
  }
}

/** Build one plugin instance: executed source, fake host, fake browser. */
function loadPlugin(scenario) {
  const calls = []
  const timers = { timeouts: [], intervals: [] }
  const sandbox = {
    captured: null,
    styles: [],
  }
  const { React, state } = createReact()
  const localStorage = memoryStorage()

  const windowStub = {
    localStorage,
    __ModuleLoader__: {
      load(entry) { sandbox.captured = entry },
    },
  }
  const documentStub = {
    baseURI: 'http://127.0.0.1:54351/',
    getElementById: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: (element) => sandbox.styles.push(element) },
  }
  const fetchStub = async (url, init) => {
    const parsed = new URL(url, 'http://127.0.0.1:54351/')
    const method = String(init?.method ?? 'GET').toUpperCase()
    calls.push({
      method,
      pathname: parsed.pathname,
      search: Object.fromEntries(parsed.searchParams.entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    let payload
    if (parsed.pathname === '/api/dsh-artel/runs' && method === 'GET') {
      payload = { runs: scenario.runs ?? [] }
    } else if (parsed.pathname === '/api/dsh-artel/runs' && method === 'POST') {
      payload = { run: scenario.started ?? scenario.run }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1' && method === 'GET') {
      payload = { run: scenario.run ?? null, feed: { events: scenario.feed ?? [], cursor: (scenario.feed ?? []).length } }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1/changes' && method === 'GET') {
      payload = { changes: scenario.changes ?? [] }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1/apply' && method === 'POST') {
      payload = {
        applied: (scenario.changes ?? []).map((change) => change.path),
        skipped: [],
        run: { ...(scenario.run ?? {}), status: 'applied', changeCount: 0 },
      }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1/discard' && method === 'POST') {
      payload = { run: { ...(scenario.run ?? {}), status: 'discarded' } }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1/messages' && method === 'POST') {
      payload = { run: { ...(scenario.run ?? {}), status: 'running' } }
    } else if (parsed.pathname === '/api/dsh-artel/runs/fg-1/interrupt' && method === 'POST') {
      payload = { run: { ...(scenario.run ?? {}), status: 'interrupted' } }
    } else {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found', code: 'artel/not-found' }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }

  const execute = new Function(
    'window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    SOURCE,
  )
  execute(
    windowStub,
    documentStub,
    fetchStub,
    (fn, ms) => { const id = `timeout-${timers.timeouts.length}`; timers.timeouts.push({ id, fn, ms }); return id },
    (fn, ms) => { const id = `interval-${timers.intervals.length}`; timers.intervals.push({ id, fn, ms }); return id },
    () => {},
    () => {},
  )
  assert.ok(sandbox.captured !== null, 'module did not register with the loader')
  const entry = sandbox.captured
  const plugin = entry.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require("${specifier}")`)
  })

  const record = { tabTypes: [], registrations: [], dictionaries: [], openTabIn: [], openTab: [], openSessions: [], effects: [] }
  const ctx = {
    slots: {
      spec: (name) => ({ kind: KEYED_SLOTS.has(name) ? 'keyed' : 'list' }),
      inject: (name, factory) => {
        const dispose = factory()
        assert.equal(typeof dispose, 'function')
        return () => { if (typeof dispose === 'function') dispose() }
      },
      register: (options, component) => {
        record.registrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      bind: () => (key) => key,
      register: (ns, dictionaries) => { record.dictionaries.push({ ns, dictionaries }); return () => {} },
    },
    get: (name) => {
      if (name === 'sidebarRightTabs') {
        return { register: (definition) => { record.tabTypes.push(definition); return () => {} } }
      }
      if (name === 'sidebarRight') {
        return {
          openTabIn: (...args) => record.openTabIn.push(args),
          openTab: (...args) => record.openTab.push(args),
        }
      }
      if (name === 'uiWorkspace') return { openSession: (id) => record.openSessions.push(id) }
      return undefined
    },
    effect: (factory, label) => {
      const dispose = factory()
      record.effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    inject: (names, factory) => { factory(); return () => {} },
  }

  /** Render a component until its effects and state settle (bounded). */
  const render = async (component, props, passes = 8) => {
    let output = ''
    for (let pass = 0; pass < passes; pass += 1) {
      state.cursor = 0
      state.effectCursor = 0
      state.effects = []
      state.elements = []
      state.dirty = false
      output = renderTree(React.createElement(component, props), state)
      const collected = state.effects
      const nextEffects = new Map()
      for (const { index, fn, deps } of collected) {
        const previous = state.effectState.get(index)
        if (previous !== undefined && sameDeps(previous.deps, deps)) {
          nextEffects.set(index, previous)
          continue
        }
        if (previous !== undefined && typeof previous.cleanup === 'function') {
          try { previous.cleanup() } catch { /* effects are best effort in the stand-in */ }
        }
        let cleanup
        try {
          cleanup = fn()
        } catch (failure) {
          throw new Error(`effect at ${index} threw: ${failure instanceof Error ? failure.message : String(failure)}`)
        }
        nextEffects.set(index, { deps, cleanup })
      }
      state.effectState = nextEffects
      await new Promise((resolve) => setImmediate(resolve))
      if (!state.dirty) break
    }
    return output
  }

  const findButton = (label) => state.elements.find((element) => (
    element.type === 'button' && textOf(element).includes(label)
  ))
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  return { entry, plugin, ctx, record, render, calls, timers, findButton, flush, elements: () => state.elements }
}

/** A finished diff that is ready for review. */
function waitingRun(overrides = {}) {
  return {
    id: 'fg-1',
    sessionId: 'session-1',
    mode: 'solo',
    task: 'Add a settings screen',
    projectPath: 'C:\\work\\demo',
    copyPath: 'C:\\dsh\\artel\\default\\copies\\fg-1',
    status: 'waiting',
    error: null,
    agents: [{ id: 'fg-1-a1', name: 'Vega', role: 'worker', status: 'idle', claimed: [], sessionId: 'session-a1' }],
    createdAt: 1,
    updatedAt: 2,
    finishedAt: 3,
    appliedAt: null,
    changeCount: 1,
    ...overrides,
  }
}

function waitingScenario() {
  return {
    runs: [waitingRun()],
    run: waitingRun(),
    feed: [
      { seq: 1, at: 4, kind: 'status', text: 'Preparing' },
      { seq: 2, at: 5, kind: 'user', text: 'Add a settings screen' },
      { seq: 3, at: 6, kind: 'assistant', agent: 'Vega', text: 'I added the screen.' },
      { seq: 4, at: 7, kind: 'tool', agent: 'Vega', tool: 'write', text: 'write src/app/settings.js', path: 'src/app/settings.js', edit: true },
      { seq: 5, at: 8, kind: 'status', text: 'Every agent is idle. 1 file changed — review the diff and apply what you like.' },
    ],
    changes: [{
      path: 'src/app/settings.js',
      status: 'modified',
      added: 12,
      removed: 3,
      binary: false,
      hunks: [{
        header: '@@ -1,3 +1,4 @@',
        lines: [
          { type: ' ', text: 'export const settings = {' },
          { type: '-', text: '  theme: "light",' },
          { type: '+', text: '  theme: "dark",' },
          { type: '+', text: '  density: "compact",' },
          { type: ' ', text: '}' },
        ],
      }],
    }],
  }
}

function getRegistration(record, slotName, keyOrId) {
  return record.registrations.find((entry) => (
    entry.options.name === slotName
    && (keyOrId === undefined || entry.options.key === keyOrId || entry.options.id === keyOrId)
  ))
}

/* ------------------------------------------------------------------- tests */

test('the module loads through the client loader and registers one tab type plus its decorations', () => {
  const app = loadPlugin(waitingScenario())
  assert.equal(app.entry.id, 'dsh-artel')
  assert.equal(app.plugin.name, 'dsh-artel')
  assert.deepEqual(app.plugin.inject, ['slots', 'locale'])

  app.plugin.apply(app.ctx)

  assert.equal(app.record.tabTypes.length, 1)
  const definition = app.record.tabTypes[0]
  assert.equal(definition.id, 'dsh-artel')
  assert.equal(definition.kind, 'artel')
  assert.equal(definition.keepMounted, true)
  assert.equal(definition.title(), 'Artel')
  assert.equal(Array.isArray(definition.guide), true, 'guide is a list of entries')
  assert.equal(definition.guide.length, 1)
  const guide = definition.guide[0]
  assert.equal(guide.id, 'dsh-artel')
  assert.equal(guide.order, 45)
  assert.equal(guide.title(), 'Artel')
  assert.equal(typeof guide.description(), 'string')

  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  assert.ok(body !== undefined, 'tab body is registered for the tab id')
  assert.equal(body.options.locale, 'dsh-artel')
  const deps = body.options.inject()
  assert.equal(typeof deps.api.listRuns, 'function')
  assert.equal(typeof deps.tt, 'function')

  assert.ok(getRegistration(app.record, 'sidebar.right.pane.tab.title', 'dsh-artel') !== undefined, 'tab title is registered')
  const header = getRegistration(app.record, 'conversation.session.header.actions', 'dsh-artel')
  assert.ok(header !== undefined, 'session header action is registered')
  assert.equal(header.options.order, 12)

  assert.equal(app.record.dictionaries.length, 1)
  const dictionaries = app.record.dictionaries[0]
  assert.equal(dictionaries.ns, 'dsh-artel')
  assert.equal(typeof dictionaries.dictionaries.en['action.open'], 'string')
  assert.equal(typeof dictionaries.dictionaries.ru['action.open'], 'string')
  assert.equal(app.calls.length, 1, 'registration reports itself once and calls nothing else')
  const report = app.calls[0]
  assert.equal(report.method, 'POST')
  assert.equal(report.pathname, '/api/dsh-artel/client-report')
  assert.equal(report.body.stage, 'ready')
  assert.ok(report.body.steps.length >= 4, 'the report carries the registration steps')
})

test('the session header button opens the Artel tab in the current session', async () => {
  const app = loadPlugin(waitingScenario())
  app.plugin.apply(app.ctx)
  const header = getRegistration(app.record, 'conversation.session.header.actions', 'dsh-artel')
  const props = header.options.inject('session-42')
  const html = await app.render(header.component, props)
  assert.equal(html, '', 'the header button renders an icon only')

  const button = app.findButton('Open Artel')
  assert.ok(button !== undefined, 'header button found by its title')
  button.props.onClick({ preventDefault() {} })
  await app.flush()
  assert.deepEqual(app.record.openTabIn, [['session-42', 'artel']])
  assert.equal(app.record.openTab.length, 0, 'the session-scoped opener wins')
})

test('an empty session shows the task form and starts a Solo run', async () => {
  const scenario = waitingScenario()
  scenario.runs = []
  scenario.run = null
  scenario.feed = []
  scenario.changes = []
  scenario.started = waitingRun({ status: 'running', changeCount: 0, finishedAt: null })
  const app = loadPlugin(scenario)
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const deps = body.options.inject()
  const props = { ...deps, sessionId: 'session-1' }

  let html = await app.render(body.component, props)
  assert.match(html, /Start a Artel run/)
  assert.match(html, /Solo/)
  assert.match(html, /Swarm/)
  assert.equal(app.findButton('Start').props.disabled, true, 'Start stays disabled without a task')

  const rendered = app.elements()
  const textarea = rendered.find((element) => element.type === 'textarea')
  textarea.props.onChange({ target: { value: 'Add a settings screen' } })
  await app.flush()
  html = await app.render(body.component, props)
  const start = app.findButton('Start')
  assert.equal(start.props.disabled, false)
  start.props.onClick({ preventDefault() {} })
  await app.flush()
  await app.render(body.component, props)

  const created = app.calls.find((call) => call.method === 'POST' && call.pathname === '/api/dsh-artel/runs')
  assert.ok(created !== undefined, 'POST /runs was called')
  assert.deepEqual(created.body, { sessionId: 'session-1', mode: 'solo', task: 'Add a settings screen' })
})

test('the Swarm card is picked by click and the form posts mode swarm', async () => {
  const scenario = waitingScenario()
  scenario.runs = []
  scenario.run = null
  scenario.feed = []
  scenario.changes = []
  scenario.started = waitingRun({ status: 'planning', mode: 'swarm', changeCount: 0, finishedAt: null })
  const app = loadPlugin(scenario)
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const props = { ...body.options.inject(), sessionId: 'session-1' }

  await app.render(body.component, props)
  const swarm = app.findButton('Swarm')
  assert.ok(swarm !== undefined, 'the Swarm card is rendered')
  assert.equal(swarm.props['aria-pressed'], false, 'Solo is picked first')
  swarm.props.onClick({ preventDefault() {} })
  await app.flush()
  await app.render(body.component, props)
  assert.equal(app.findButton('Swarm').props['aria-pressed'], true, 'the click selects Swarm')

  const textarea = app.elements().find((element) => element.type === 'textarea')
  textarea.props.onChange({ target: { value: 'Divide the pages' } })
  await app.flush()
  await app.render(body.component, props)
  app.findButton('Start').props.onClick({ preventDefault() {} })
  await app.flush()
  await app.render(body.component, props)

  const created = app.calls.find((call) => call.method === 'POST' && call.pathname === '/api/dsh-artel/runs')
  assert.ok(created !== undefined, 'POST /runs was called')
  assert.deepEqual(created.body, { sessionId: 'session-1', mode: 'swarm', task: 'Divide the pages' })
})

test('New task leaves the run view and shows the start form again', async () => {
  const scenario = waitingScenario()
  scenario.started = waitingRun({ status: 'running' })
  const app = loadPlugin(scenario)
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const props = { ...body.options.inject(), sessionId: 'session-1' }

  let html = await app.render(body.component, props)
  assert.match(html, /Waiting for you/)
  app.findButton('New task').props.onClick({ preventDefault() {} })
  await app.flush()
  html = await app.render(body.component, props)

  assert.match(html, /Start a Artel run/)
  // The previous-runs row below the form still says "Waiting for you"; the run
  // view itself must be gone.
  assert.doesNotMatch(html, /Work feed/)
  assert.doesNotMatch(html, /Apply 1 file/)
  // The run list keeps polling behind the form; it must not drag the user back
  // into the run they dismissed.
  const runs = Array.isArray(scenario.runs) ? scenario.runs : []
  assert.equal(runs.length, 1, 'the dismissed run is still in the list')
  assert.match(html, /Solo/)
  assert.match(html, /Swarm/)
})

test('a waiting run renders its feed, agents, and diff, and applies the selected files', async () => {
  const app = loadPlugin(waitingScenario())
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const props = { ...body.options.inject(), sessionId: 'session-1' }

  const html = await app.render(body.component, props)
  assert.match(html, /Waiting for you/)
  assert.match(html, /Add a settings screen/)
  assert.match(html, /Vega/)
  assert.match(html, /I added the screen\./)
  assert.match(html, /src\/app\/settings\.js/)
  assert.match(html, /Apply 1 file/)

  const apply = app.findButton('Apply 1 file')
  assert.ok(apply !== undefined)
  assert.equal(apply.props.disabled, false)
  apply.props.onClick({ preventDefault() {} })
  await app.flush()
  await app.render(body.component, props)

  const applied = app.calls.find((call) => call.method === 'POST' && call.pathname === '/api/dsh-artel/runs/fg-1/apply')
  assert.ok(applied !== undefined, 'POST /apply was called')
  assert.deepEqual(applied.body, { paths: ['src/app/settings.js'] })
})

test('a swarm planning run shows the divided work and each agent claim', async () => {
  const scenario = waitingScenario()
  const run = waitingRun({
    id: 'fg-1',
    mode: 'swarm',
    status: 'planning',
    changeCount: 0,
    agents: [
      { id: 'fg-1-a1', name: 'Vega', role: 'planner', status: 'planning', claimed: [], sessionId: 'session-a1' },
      { id: 'fg-1-a2', name: 'Orion', role: 'planner', status: 'planning', claimed: [], sessionId: 'session-a2' },
      { id: 'fg-1-a3', name: 'Lyra', role: 'planner', status: 'planning', claimed: [], sessionId: 'session-a3' },
    ],
  })
  scenario.runs = [run]
  scenario.run = run
  scenario.changes = []
  scenario.feed = [
    { seq: 1, at: 4, kind: 'status', text: 'Dividing work' },
    { seq: 2, at: 5, kind: 'plan', text: 'Work divided.\nsrc/app/** — Vega\nsrc/ui/** — Orion\nREADME.md — Lyra', agent: 'Artel' },
  ]
  const app = loadPlugin(scenario)
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const props = { ...body.options.inject(), sessionId: 'session-1' }

  const html = await app.render(body.component, props)
  assert.match(html, /Dividing work/)
  assert.match(html, /Swarm/)
  assert.match(html, /Orion/)
  assert.match(html, /Lyra/)
  assert.match(html, /Work divided\./)
  assert.match(html, /src\/app\/\*\*/)
  assert.equal(app.findButton('Apply 1 file'), undefined, 'a planning run has nothing to apply')
})

test('opening an agent conversation routes through uiWorkspace', async () => {
  const app = loadPlugin(waitingScenario())
  app.plugin.apply(app.ctx)
  const body = getRegistration(app.record, 'sidebar.right.pane.tab', 'dsh-artel')
  const props = { ...body.options.inject(), sessionId: 'session-1' }
  await app.render(body.component, props)

  const openAgent = app.elements().find((element) => (
    element.type === 'button' && element.props.title === 'Open conversation'
  ))
  assert.ok(openAgent !== undefined, 'agent rows expose an open-conversation button')
  openAgent.props.onClick({ preventDefault() {} })
  assert.deepEqual(app.record.openSessions, ['session-a1'])
})
