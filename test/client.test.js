'use strict'

/**
 * Client-half tests for dsh-artel.
 *
 * The bundle is a classic script for the DSH client module loader, so the test
 * runs it inside a fake browser realm: a tiny React renderer with hook state,
 * fake timers, a fake fetch router and a fake slots/locale Cordis context.
 *
 * What is covered:
 *  - plugin shape and the single `conversation.input.left` registration
 *    (no sidebar-right tab, no header action, no composer.dock entry);
 *  - ru/en/zh dictionaries and the Host-facing diagnostics report;
 *  - pure view-model helpers through `window.__DSH_ARTEL_DEBUG__`;
 *  - the per-session store (runs load, persisted active run, start a run);
 *  - a rendered launcher -> overlay -> hero -> start -> live feed flow.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = fs.readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/* ------------------------------------------------------------------ react */

function createReact() {
  const isArray = Array.isArray

  function flatten(list, out) {
    for (const item of list) {
      if (isArray(item)) flatten(item, out)
      else out.push(item)
    }
    return out
  }

  function h(type, props, ...children) {
    const next = Object.assign({}, props ?? {})
    const merged = []
    if (next.children !== undefined) merged.push(next.children)
    for (const child of children) merged.push(child)
    next.children = flatten(merged, [])
    return { type, props: next, key: next.key ?? null }
  }

  const React = { createElement: h, Fragment: Symbol('Fragment'), useState: null, useEffect: null, useMemo: null, useRef: null, useCallback: null }
  return { React, h, flatten }
}

/* --------------------------------------------------------------- renderer */

function createRenderer(react) {
  const { React, h } = react
  const holders = new Map()
  let currentHolder = null
  let dirty = false
  let pendingEffects = []
  let rootVNode = null

  function hookKey(holder, index) {
    return holder.key + '#' + index
  }

  function slot(holder, index, factory) {
    const key = hookKey(holder, index)
    if (!holder.slots.has(key)) holder.slots.set(key, factory())
    return holder.slots.get(key)
  }

  function useState(initial) {
    const holder = currentHolder
    const index = holder.index++
    const store = slot(holder, index, () => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [
      store.value,
      (next) => {
        const value = typeof next === 'function' ? next(store.value) : next
        if (Object.is(value, store.value)) return
        store.value = value
        dirty = true
      },
    ]
  }

  function useMemo(factory, deps) {
    const holder = currentHolder
    const index = holder.index++
    const store = slot(holder, index, () => ({ deps: undefined, value: undefined }))
    if (store.deps === undefined || !sameDeps(store.deps, deps)) {
      store.value = factory()
      store.deps = deps
    }
    return store.value
  }

  function useRef(initial) {
    const holder = currentHolder
    const index = holder.index++
    return slot(holder, index, () => ({ current: initial }))
  }

  function useCallback(fn) {
    return fn
  }

  function useEffect(fn, deps) {
    const holder = currentHolder
    const index = holder.index++
    const key = hookKey(holder, index)
    const previous = holder.effects.get(key)
    if (previous !== undefined && sameDeps(previous.deps, deps)) return
    holder.effects.set(key, { deps, fn })
    pendingEffects.push({ key, fn })
  }

  React.useState = useState
  React.useEffect = useEffect
  React.useMemo = useMemo
  React.useRef = useRef
  React.useCallback = useCallback

  function sameDeps(a, b) {
    if (a === undefined || b === undefined || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) if (!Object.is(a[index], b[index])) return false
    return true
  }

  function renderComponent(type, props, keyPath) {
    const name = type.displayName ?? type.name ?? 'Anonymous'
    const instanceKey = keyPath + '|' + name
    let holder = holders.get(instanceKey)
    if (holder === undefined) {
      holder = { key: instanceKey, index: 0, slots: new Map(), effects: new Map() }
      holders.set(instanceKey, holder)
    }
    holder.index = 0
    const previous = currentHolder
    currentHolder = holder
    let output
    try {
      output = type(props)
    } finally {
      currentHolder = previous
    }
    if (output === null || output === undefined) return null
    return renderVNode(output, keyPath + '>')
  }

  function renderVNode(vnode, keyPath) {
    if (vnode === null || vnode === undefined || vnode === false || vnode === true) return null
    if (typeof vnode === 'string' || typeof vnode === 'number') return { kind: 'text', text: String(vnode) }
    if (typeof vnode === 'function') return null
    if (typeof vnode !== 'object') return { kind: 'text', text: String(vnode) }
    if (vnode.__portal !== undefined) return renderVNode(vnode.__portal, keyPath + 'p')
    if (vnode.type === React.Fragment) {
      const children = react.flatten([vnode.props.children], [])
      const rendered = []
      children.forEach((child, index) => {
        const node = renderVNode(child, keyPath + '.' + index)
        if (node !== null) rendered.push(node)
      })
      return { kind: 'host', type: 'fragment', props: {}, children: rendered }
    }
    if (typeof vnode.type === 'function') return renderComponent(vnode.type, vnode.props, keyPath)
    if (typeof vnode.type !== 'string') return null
    const childList = react.flatten([vnode.props.children], [])
    const children = []
    childList.forEach((child, index) => {
      const node = renderVNode(child, keyPath + '.' + index)
      if (node !== null) children.push(node)
    })
    return { kind: 'host', type: vnode.type, props: vnode.props, children }
  }

  function runPendingEffects() {
    const queue = pendingEffects
    pendingEffects = []
    let ran = false
    for (const effect of queue) {
      ran = true
      try {
        effect.fn()
      } catch (error) {
        throw error
      }
    }
    return ran
  }

  let rootTree = null

  async function flush() {
    for (let iteration = 0; iteration < 40; iteration += 1) {
      dirty = false
      pendingEffects = []
      const tree = rootVNode === null ? null : renderVNode(rootVNode, 'root')
      rootTree = tree
      const ran = runPendingEffects()
      await Promise.resolve()
      await Promise.resolve()
      if (dirty === false && ran === false) return tree
    }
    return rootTree
  }

  function mount(component, props) {
    rootVNode = h(component, props)
    holders.clear()
    dirty = true
    return flush()
  }

  function tree() {
    return rootTree
  }

  function setProps(props) {
    rootVNode = h(rootVNode.type, props)
    dirty = true
  }

  return { mount, flush, tree, setProps, h, React }
}

/* ------------------------------------------------------------------- tree */

function walk(node, visit) {
  if (node === null || node === undefined) return
  visit(node)
  if (Array.isArray(node.children)) for (const child of node.children) walk(child, visit)
}

function findAll(tree, predicate) {
  const matches = []
  walk(tree, (node) => { if (node.kind === 'host' && predicate(node)) matches.push(node) })
  return matches
}

function findByClass(tree, className) {
  return findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className))[0]
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.kind === 'text') return node.text
  let text = ''
  for (const name of ['title', 'aria-label', 'placeholder']) {
    if (typeof node.props?.[name] === 'string' && (name === 'title' || name === 'aria-label')) text += ' ' + node.props[name]
  }
  if (Array.isArray(node.children)) for (const child of node.children) text += ' ' + textOf(child)
  return text
}

function findButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node).includes(label))[0]
}

function pickerTriggers(tree) {
  return findAll(tree, (node) => node.type === 'button'
    && typeof node.props?.className === 'string'
    && node.props.className.split(/\s+/).includes('dsh-artel-select'))
}

function pickOption(tree, value) {
  const menu = findByClass(tree, 'dsh-artel-menu')
  assert.ok(menu !== undefined, 'the picker menu is open')
  const option = findAll(menu, (node) => node.props?.role === 'option' && node.props['data-value'] === value)[0]
  assert.ok(option !== undefined, 'option ' + value + ' is in the menu')
  option.props.onClick()
}

/* ------------------------------------------------------------------ realm */

const DEFAULT_PROJECT = { projectPath: 'C:\\work\\artel-toy', name: 'artel-toy' }
const DEFAULT_RUN = {
  id: 'run-1',
  sessionId: 'sess-1',
  mode: 'swarm',
  task: 'Add a button',
  status: 'running',
  phase: 'planning',
  projectPath: 'C:\\work\\artel-toy',
  changes: [],
  changeCount: 0,
  agents: [
    { id: 'a1', name: 'Vega', role: 'lead', status: 'idle' },
    { id: 'a2', name: 'Nova', role: 'dev', status: 'working' },
    { id: 'a3', name: 'Rill', role: 'review', status: 'starting' },
  ],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:05:00.000Z',
}

/** An interrupted run with a reviewable copy but `changeCount: 0` (Host quirk). */
const REVIEW_RUN = {
  ...DEFAULT_RUN,
  id: 'run-review',
  status: 'interrupted',
  phase: 'You stopped the run.',
  changeCount: 0,
}

const REVIEW_CHANGES = [
  {
    path: 'src/math.js',
    status: 'modified',
    added: 4,
    removed: 1,
    binary: false,
    hunks: [{
      header: '@@ -1,3 +1,6 @@',
      lines: [
        { type: ' ', text: 'export function add(a, b) {' },
        { type: '-', text: '  return a + b' },
        { type: '+', text: '  return a + b' },
        { type: '+', text: '}' },
      ],
    }],
  },
  {
    path: 'test/math.test.js',
    status: 'added',
    added: 8,
    removed: 0,
    binary: false,
    hunks: [{
      header: '@@ -0,0 +1,8 @@',
      lines: [{ type: '+', text: "import { sub } from '../src/math.js'" }],
    }],
  },
  { path: 'assets/logo.png', status: 'binary', added: 0, removed: 0, binary: true, hunks: [] },
]

function createRealm(options = {}) {
  const react = createReact()
  const renderer = createRenderer(react)
  const timers = new Map()
  let timerSeq = 0
  const calls = []
  const localStorageMap = new Map()
  const styleElements = []
  const windowListeners = new Map()
  let scenario = options.scenario ?? {}

  function addWindowListener(type, handler) {
    if (typeof handler !== 'function') return
    const key = String(type)
    const listeners = windowListeners.get(key) ?? new Set()
    listeners.add(handler)
    windowListeners.set(key, listeners)
  }

  function removeWindowListener(type, handler) {
    const listeners = windowListeners.get(String(type))
    if (listeners !== undefined) listeners.delete(handler)
  }

  function dispatchWindowEvent(type, event) {
    const listeners = windowListeners.get(String(type))
    if (listeners === undefined) return 0
    let handled = 0
    for (const handler of Array.from(listeners)) {
      handled += 1
      handler(event)
    }
    return handled
  }

  const document = {
    baseURI: 'http://127.0.0.1:61327/',
    getElementById(id) {
      return styleElements.find((element) => element.id === id) ?? null
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        id: '',
        textContent: '',
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value) },
      }
    },
    head: { appendChild(element) { styleElements.push(element) } },
    body: { appendChild() {} },
    querySelector() { return null },
    querySelectorAll() { return [] },
  }

  const window = {
    __DSH_BOOT__: { rev: 'test-rev' },
    __ModuleLoader__: null,
    addEventListener(type, handler) { addWindowListener(type, handler) },
    removeEventListener(type, handler) { removeWindowListener(type, handler) },
    location: { href: 'http://127.0.0.1:61327/' },
  }

  const localStorage = {
    getItem(key) { return localStorageMap.has(key) ? localStorageMap.get(key) : null },
    setItem(key, value) { localStorageMap.set(String(key), String(value)) },
    removeItem(key) { localStorageMap.delete(key) },
  }

  function setTimeoutFake(fn, ms) {
    timerSeq += 1
    timers.set(timerSeq, { fn, ms })
    return timerSeq
  }

  function clearTimeoutFake(id) {
    timers.delete(id)
  }

  async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  }

  async function pump() {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      await settle()
      await renderer.flush()
      const pending = timers.size
      if (pending === 0) {
        await settle()
        await renderer.flush()
        return
      }
      break
    }
  }

  function json(payload, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Error',
      async text() { return JSON.stringify(payload) },
    }
  }

  function notFound() {
    return json({ error: 'not_found', message: 'no route' }, 404)
  }

  async function fetchFake(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    const raw = String(url)
    const parsed = new URL(raw, document.baseURI)
    const pathname = parsed.pathname
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ method, pathname, url: raw, body })
    if (pathname.endsWith('/client-report')) return json({ ok: true })
    const handler = scenario.route
    if (typeof handler === 'function') {
      const result = handler({ method, pathname, search: parsed.searchParams, body, scenario })
      if (result !== undefined) return result
    }
    if (pathname === '/api/dsh-artel/project') return json(scenario.project ?? DEFAULT_PROJECT)
    if (pathname === '/api/dsh-artel/models') {
      return json(scenario.models ?? {
        providers: [{
          id: 'test',
          name: 'Test',
          models: [
            { id: 'fast', name: 'Fast', efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low' },
            { id: 'slow', name: 'Slow', efforts: [] },
          ],
        }],
        default: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
      })
    }
    const modelMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/agents\/([^/]+)\/model$/.exec(pathname)
    if (modelMatch !== null && method === 'POST') {
      const runId = decodeURIComponent(modelMatch[1])
      const agentId = decodeURIComponent(modelMatch[2])
      const selection = body.model
      const runs = scenario.runs ?? []
      const run = runs.find((entry) => entry.id === runId) ?? DEFAULT_RUN
      const patched = {
        ...run,
        agents: run.agents.map((agent) => agent.id === agentId ? { ...agent, model: selection } : agent),
      }
      scenario.runs = runs.map((entry) => entry.id === runId ? patched : entry)
      return json({ run: patched })
    }
    if (pathname === '/api/dsh-artel/runs' && method === 'GET') return json({ runs: scenario.runs ?? [] })
    if (pathname === '/api/dsh-artel/runs' && method === 'POST') {
      const run = {
        ...DEFAULT_RUN,
        id: scenario.nextRunId ?? 'run-new',
        task: body.task,
        mode: body.mode,
        projectPath: body.projectPath ?? DEFAULT_PROJECT.projectPath,
        status: 'running',
        agents: DEFAULT_RUN.agents,
        updatedAt: '2026-01-01T11:00:00.000Z',
      }
      scenario.runs = [run, ...(scenario.runs ?? [])]
      scenario.feed = Object.assign({}, scenario.feed, { [run.id]: scenario.newRunFeed ?? [] })
      return json({ run }, 201)
    }
    const runMatch = /^\/api\/dsh-artel\/runs\/([^/]+)$/.exec(pathname)
    if (runMatch !== null && method === 'GET') {
      const runId = decodeURIComponent(runMatch[1])
      const runs = scenario.runs ?? []
      const run = runs.find((entry) => entry.id === runId) ?? DEFAULT_RUN
      const events = (scenario.feed ?? {})[runId] ?? []
      return json({ run, feed: { events, cursor: events.length } })
    }
    const changesMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/changes$/.exec(pathname)
    if (changesMatch !== null && method === 'GET') {
      return json({ changes: scenario.changes ?? [] })
    }
    const applyMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/apply$/.exec(pathname)
    if (applyMatch !== null && method === 'POST') {
      const runId = decodeURIComponent(applyMatch[1])
      const current = (scenario.runs ?? []).find((entry) => entry.id === runId) ?? {}
      const applied = scenario.applyResult ?? (scenario.changes ?? []).map((entry) => entry.path)
      scenario.runs = Array.isArray(scenario.runs)
        ? scenario.runs.map((entry) => entry.id === runId ? { ...entry, status: 'applied' } : entry)
        : scenario.runs
      return json({ applied, skipped: scenario.applySkipped ?? [], run: { ...DEFAULT_RUN, ...current, id: runId, status: 'applied' } })
    }
    const discardMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/discard$/.exec(pathname)
    if (discardMatch !== null && method === 'POST') {
      const runId = decodeURIComponent(discardMatch[1])
      const current = (scenario.runs ?? []).find((entry) => entry.id === runId) ?? {}
      scenario.runs = Array.isArray(scenario.runs)
        ? scenario.runs.map((entry) => entry.id === runId ? { ...entry, status: 'discarded' } : entry)
        : scenario.runs
      return json({ run: { ...DEFAULT_RUN, ...current, id: runId, status: 'discarded' } })
    }
    return notFound()
  }

  const requireFake = (id) => {
    if (id === 'react') return react.React
    if (id === 'react-dom') {
      return { createPortal: (node) => ({ __portal: node }) }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        MarkdownText: function MarkdownText(props) {
          const labels = props.labels?.code
          return react.h(
            'div',
            {
              className: 'fake-markdown',
              'data-code-label': labels?.toolbarLabels?.codeLabel ?? '',
              'data-copy-label': labels?.copyLabel ?? '',
            },
            props.text,
          )
        },
        StateDot: function StateDot(props) { return react.h('span', { className: 'fake-dot', 'data-state': props.state }) },
        Tooltip: function Tooltip(props) { return react.h('span', null, props.children) },
      }
    }
    throw new Error('unknown module: ' + id)
  }

  function load() {
    let definition = null
    window.__ModuleLoader__ = { load(def) { definition = def } }
    const factory = new Function(
      'window', 'document', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'localStorage', 'navigator', 'ResizeObserver', 'CSS', 'AbortController', 'globalThis',
      SOURCE,
    )
    factory(
      window,
      document,
      fetchFake,
      setTimeoutFake,
      setTimeoutFake,
      clearTimeoutFake,
      clearTimeoutFake,
      localStorage,
      { userAgent: 'node-test' },
      undefined,
      { escape: (value) => String(value) },
      AbortController,
      globalThis,
    )
    assert.ok(definition !== null, 'bundle registered a module')
    assert.equal(definition.id, 'dsh-artel')
    return definition.factory(requireFake)
  }

  async function runTimerWithDelay(ms) {
    const due = Array.from(timers.entries()).find(([, timer]) => timer.ms <= ms)
    if (due === undefined) return false
    timers.delete(due[0])
    due[1].fn()
    await settle()
    return true
  }

  return {
    react,
    renderer,
    document,
    window,
    windowListeners,
    dispatchWindowEvent,
    localStorage,
    calls,
    timers,
    load,
    settle,
    pump,
    runTimerWithDelay,
    styleElements,
    get scenario() { return scenario },
    setScenario(next) { scenario = next },
  }
}

function createCtx(realm, options = {}) {
  const dictionaries = {}
  const locale = options.locale ?? 'ru'
  const slots = { entries: [], injections: [] }
  const effects = []
  const ctx = {
    effect(fn, _label) {
      effects.push(fn)
      fn()
      return () => {}
    },
    on() { return () => {} },
    get() { return undefined },
    locale: {
      register(namespace, localeOrTable, maybeTable) {
        if (typeof localeOrTable === 'string') {
          dictionaries[namespace] = {
            ...(dictionaries[namespace] ?? {}),
            [localeOrTable]: maybeTable,
          }
          return () => {}
        }
        dictionaries[namespace] = localeOrTable
        return () => {}
      },
      bind(namespace) {
        return (key) => {
          const table = dictionaries[namespace]?.[locale] ?? {}
          return table[key] !== undefined ? table[key] : key
        }
      },
    },
    slots: {
      spec() { return undefined },
      inject(slotName, factory) {
        slots.injections.push({ slotName, factory })
        const disposer = factory()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(definition, component) {
        slots.entries.push({ definition, component })
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, dictionaries, slots, effects }
}

function setup(options = {}) {
  const realm = createRealm(options)
  const plugin = realm.load()
  const context = createCtx(realm)
  const ctx = context.ctx
  const returned = plugin.apply(ctx)
  // Cordis treats the plugin apply() return value as an effect, so the plugin
  // must return undefined and publish its diagnostics on the window instead.
  assert.equal(returned, undefined, 'client apply must not return a report object')
  const report = realm.window.__DSH_ARTEL_CLIENT__
  return { realm, plugin, ctx, report, ...context }
}

function launcherEntry(slots) {
  return slots.entries.find((entry) => entry.definition.name === 'conversation.input.left')
}

/** Render the registered launcher/SurfaceRoot component with the Host kit props. */
async function renderLauncher(state, props = {}) {
  const entry = launcherEntry(state.slots)
  assert.ok(entry !== undefined, 'launcher entry is registered')
  const sessionId = props.sessionId ?? 'sess-1'
  const t = state.ctx.locale.bind('dsh-artel')
  const injected = typeof entry.definition.inject === 'function' ? entry.definition.inject(sessionId) : {}
  const kit = {
    sessionId,
    t,
    useSessions: () => props.sessionCwd,
    useSession: () => undefined,
    useConversation: () => undefined,
    useInput: () => undefined,
    inputActions: {},
    renderFactorySlot: () => null,
    ...props.extra,
  }
  const tree = await state.realm.renderer.mount(entry.component, { ...kit, ...injected })
  return tree
}

/* ------------------------------------------------------------------ tests */

test('plugin registers one conversation.input.left entry and diagnostics', async () => {
  const state = setup()
  assert.deepEqual(state.plugin.inject, ['slots', 'locale'])
  assert.equal(state.plugin.name, 'dsh-artel')

  const entry = launcherEntry(state.slots)
  assert.ok(entry !== undefined)
  assert.deepEqual(entry.definition, {
    name: 'conversation.input.left',
    id: 'artel-launcher',
    order: 40,
    locale: 'dsh-artel',
    inject: entry.definition.inject,
  })
  assert.equal(typeof entry.definition.inject, 'function')
  assert.deepEqual(entry.definition.inject('sess-1'), { sessionId: 'sess-1' })

  const slotNames = state.slots.injections.map((injection) => injection.slotName)
  assert.deepEqual(slotNames, ['conversation.input.left'])
  assert.equal(state.slots.entries.some((candidate) => candidate.definition.name === 'conversation.composer.dock'), false)
  assert.equal(state.slots.entries.some((candidate) => String(candidate.definition.id).includes('sidebarRightTabs')), false)

  assert.equal(state.realm.styleElements.length, 1)
  assert.equal(state.realm.styleElements[0].id, 'dsh-artel-style')
  assert.equal(state.realm.styleElements[0].attributes['data-plugin'], 'dsh-artel')
  assert.match(state.realm.styleElements[0].textContent, /\.dsh-artel-surface/)
  assert.match(state.realm.styleElements[0].textContent, /\.dsh-artel-launcher/)
  assert.doesNotMatch(state.realm.styleElements[0].textContent, /dsh-artel-model-pick::after/, 'the chip paints no second chevron')
  assert.match(state.realm.styleElements[0].textContent, /dsh-artel-hero__textarea:focus-visible/, 'the card owns the only focus ring')
  assert.match(state.realm.styleElements[0].textContent, /dsh-artel-btn--primary\[disabled\]:hover/, 'a disabled primary keeps its gradient on hover')
  assert.match(state.realm.styleElements[0].textContent, /\.dsh-artel-menu \{/, 'the pickers paint their own menu')
  assert.match(state.realm.styleElements[0].textContent, /backdrop-filter: blur\(28px\)/, 'the menu is a translucent glass panel')

  assert.ok(state.dictionaries['dsh-artel'] !== undefined)
  const ru = state.dictionaries['dsh-artel'].ru
  const en = state.dictionaries['dsh-artel'].en
  const zh = state.dictionaries['dsh-artel'].zh
  assert.ok(ru !== undefined && en !== undefined && zh !== undefined)
  for (const key of ['surface.title', 'launcher.open', 'rail.title', 'hero.start', 'feed.tools', 'error.timeout']) {
    assert.equal(typeof en[key], 'string', 'en has ' + key)
    assert.equal(typeof ru[key], 'string', 'ru has ' + key)
    assert.equal(typeof zh[key], 'string', 'zh has ' + key)
  }

  assert.equal(state.report.stage, 'ready')
  const reportCall = state.realm.calls.find((call) => call.pathname.endsWith('/client-report'))
  assert.ok(reportCall !== undefined, 'client-report was sent')
  assert.equal(state.realm.window.__DSH_ARTEL_CLIENT__.stage, 'ready')
  assert.ok(state.realm.window.__DSH_ARTEL_DEBUG__ !== undefined)
})

test('pure view model helpers behave as the design requires', () => {
  const realm = createRealm()
  const plugin = realm.load()
  plugin.apply(createCtx(realm).ctx)
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  assert.ok(debug !== undefined)
  const ru = debug.dictionaries.ru
  const t = (key) => (ru[key] !== undefined ? ru[key] : key)

  assert.equal(debug.fill('{a} / {b}', { a: 'Solo', b: 3 }), 'Solo / 3')
  assert.equal(debug.baseName('C:\\work\\artel-toy'), 'artel-toy')

  assert.equal(debug.statusTone('running'), 'active')
  assert.equal(debug.statusTone('finished'), 'ok')
  assert.equal(debug.statusTone('failed'), 'error')
  assert.equal(debug.statusDotState('running'), 'ongoing')
  assert.equal(debug.statusDotState('finished'), 'done')
  assert.equal(debug.statusDotState('failed'), 'error')
  assert.equal(debug.statusLabel(t, 'running'), 'В работе')
  assert.equal(debug.modeLabel(t, 'swarm'), 'Swarm')

  assert.equal(debug.isActiveRun({ status: 'running' }), true)
  assert.equal(debug.isActiveRun({ status: 'finished' }), false)

  const meta = debug.runMeta(t, DEFAULT_RUN)
  assert.equal(meta, 'Swarm · 1/3 · planning')

  assert.equal(debug.phaseOf(t, { status: 'waiting', phase: null }), 'Ждёт вас')
  assert.equal(debug.phaseOf(t, { status: 'running', phase: '  пишет тесты  ' }), 'пишет тесты')

  const groups = debug.groupRunsByProject([
    { id: 'a', projectPath: 'C:\\p\\one', updatedAt: '2026-01-01T10:00:00Z' },
    { id: 'b', projectPath: 'C:\\p\\two', updatedAt: '2026-01-02T10:00:00Z' },
    { id: 'c', projectPath: 'C:\\p\\one', updatedAt: '2026-01-03T10:00:00Z' },
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].runs.map((run) => run.id), ['c', 'a'])
  assert.deepEqual(groups[1].runs.map((run) => run.id), ['b'])

  assert.deepEqual(debug.chooseProject({ projectPath: 'C:\\p\\live', name: 'live' }, [], 'C:\\p\\cwd'), { projectPath: 'C:\\p\\live', name: 'live' })
  assert.deepEqual(debug.chooseProject(null, [{ projectPath: 'C:\\p\\run' }], 'C:\\p\\cwd'), { projectPath: 'C:\\p\\run', name: 'run' })
  assert.deepEqual(debug.chooseProject(null, [], 'C:\\p\\cwd'), { projectPath: 'C:\\p\\cwd', name: 'cwd' })
  assert.deepEqual(debug.chooseProject(null, [], undefined), { projectPath: '', name: '' })

  assert.equal(debug.chooseActiveRunId([{ id: 'x' }, { id: 'y' }], 'y'), 'y')
  assert.equal(debug.chooseActiveRunId([{ id: 'x' }, { id: 'y' }], 'gone'), 'x')
  assert.equal(debug.chooseActiveRunId([], 'gone'), null)

  const events = [
    { seq: 1, kind: 'status', text: 'Планирую' },
    { seq: 2, kind: 'tool', agent: 'Vega', tool: 'read', path: 'src/a.js' },
    { seq: 3, kind: 'tool', agent: 'Vega', tool: 'write', path: 'src/a.js' },
    { seq: 4, kind: 'tool', agent: 'Nova', tool: 'read', path: 'src/b.js' },
    { seq: 5, kind: 'assistant', agent: 'Vega', text: 'Готово' },
    { seq: 6, kind: 'user', agent: 'Vega', text: 'Сделай' },
    { seq: 7, kind: 'collision', text: 'Конфликт правок', path: 'src/a.js' },
  ]
  const feed = debug.feedGroups(events)
  assert.equal(feed.length, 6)
  assert.equal(feed[0].type, 'status')
  assert.equal(feed[1].type, 'tools')
  assert.deepEqual(feed[1].items.map((event) => event.seq), [2, 3])
  assert.equal(feed[2].type, 'tools')
  assert.deepEqual(feed[2].items.map((event) => event.seq), [4])
  assert.equal(feed[3].type, 'assistant')
  assert.equal(feed[4].type, 'user')
  assert.equal(feed[5].type, 'collision')

  assert.deepEqual(debug.recipientsOf(DEFAULT_RUN).map((agent) => agent.name), ['Vega', 'Nova', 'Rill'])
  assert.equal(debug.changeTotal([{ changeCount: 2 }, { changeCount: 3 }, {}]), 5)
  assert.ok(debug.avatarTone('Vega') >= 0 && debug.avatarTone('Vega') < 8)
  assert.equal(debug.avatarTone('Vega'), debug.avatarTone('Vega'))
  assert.equal(debug.formatWhen(t, Date.now() - 5 * 60 * 1000), '5 мин назад')
})

test('store loads runs, persists the active run and starts new ones', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN],
      feed: {
        'run-1': [
          { seq: 1, at: '2026-01-01T10:01:00Z', kind: 'status', text: 'Планирую' },
          { seq: 2, at: '2026-01-01T10:02:00Z', kind: 'assistant', agent: 'Vega', text: 'Привет, я лид.' },
        ],
      },
      nextRunId: 'run-2',
      newRunFeed: [{ seq: 1, at: '2026-01-01T11:00:00Z', kind: 'assistant', agent: 'Nova', text: 'Пишу код.' }],
    },
  })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const store = debug.getStore('sess-1')

  store.open()
  await state.realm.settle()
  await state.realm.settle()

  const snap = store.getSnapshot()
  assert.equal(snap.open, true)
  assert.equal(snap.runsLoaded, true)
  assert.equal(snap.runs.length, 1)
  assert.equal(snap.activeRunId, 'run-1')
  assert.equal(snap.run.task, 'Add a button')
  assert.equal(snap.feed.length, 2)
  assert.equal(state.realm.localStorage.getItem('dsh-artel:last-run:sess-1'), 'run-1')
  assert.ok(state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'GET'))
  assert.ok(!state.realm.calls.some((call) => call.pathname.includes('sidebar')), 'no sidebar APIs are used')

  await store.startRun({ task: 'Сделай красиво', mode: 'swarm', projectPath: DEFAULT_PROJECT.projectPath })
  await state.realm.settle()
  await state.realm.settle()

  const started = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(started !== undefined, 'run was POSTed')
  assert.deepEqual(started.body, { sessionId: 'sess-1', mode: 'swarm', task: 'Сделай красиво', projectPath: DEFAULT_PROJECT.projectPath })

  const after = store.getSnapshot()
  assert.equal(after.activeRunId, 'run-2')
  assert.equal(after.run.task, 'Сделай красиво')
  assert.equal(state.realm.localStorage.getItem('dsh-artel:last-run:sess-1'), 'run-2')
  assert.equal(after.feed.length, 1)
  assert.equal(after.feed[0].text, 'Пишу код.')

  /* The new-session action must keep the hero even after a background refresh:
   * the refresh used to restore the stored run and steal the hero. */
  store.selectRun(null)
  assert.equal(store.getSnapshot().activeRunId, null)
  assert.equal(state.realm.localStorage.getItem('dsh-artel:last-run:sess-1'), null)
  await store.refreshRuns()
  await state.realm.settle()
  const heroState = store.getSnapshot()
  assert.equal(heroState.activeRunId, null, 'background refresh does not steal the hero')
  assert.equal(heroState.newRun, true)
  assert.equal(heroState.runs.length, 2, 'the run list is still refreshed')

  store.close()
  await state.realm.settle()
  assert.equal(store.getSnapshot().open, false)
  store.dispose()
})

test('launcher opens the overlay, hero shows the project and starts a run', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      nextRunId: 'run-live',
      newRunFeed: [{ seq: 1, at: '2026-01-01T11:00:00Z', kind: 'assistant', agent: 'Nova', text: 'Готово, кнопка на месте.' }],
    },
  })
  const tree = await renderLauncher(state, { sessionCwd: 'C:\\cwd\\other' })
  const launcher = findByClass(tree, 'dsh-artel-launcher')
  assert.ok(launcher !== undefined, 'launcher button rendered')
  assert.equal(state.realm.renderer.tree().kind, 'host')

  launcher.props.onClick()
  await state.realm.settle()
  const opened = await state.realm.renderer.flush()
  const surface = findByClass(opened, 'dsh-artel-surface')
  assert.ok(surface !== undefined, 'overlay is mounted from the launcher entry')
  assert.ok(findByClass(opened, 'dsh-artel-rail') !== undefined, 'rail is rendered')
  assert.equal(findByClass(opened, 'dsh-artel-run'), undefined, 'hero is shown before a run is selected')

  const heroText = textOf(findByClass(opened, 'dsh-artel-hero'))
  assert.match(heroText, /artel-toy/, 'the heading area names the project the run will touch')
  assert.match(heroText, /Новая задача/, 'the form title is plain language')
  assert.doesNotMatch(heroText, /артель/i, 'no artel jargon leaks into the new-run page')
  assert.match(heroText, /Swarm/)
  assert.equal(findAll(opened, (node) => node.props?.className === 'dsh-artel-hero__eyebrow').length, 0, 'no project badge above the title')
  assert.equal(findByClass(opened, 'dsh-artel-rail__new'), undefined, 'the create button is not duplicated on the form')
  assert.equal(findByClass(opened, 'dsh-artel-rail__footer'), undefined, 'no zero counters before the first run')
  assert.equal(findByClass(opened, 'dsh-artel-refresh'), undefined, 'no refresh control on a form with nothing to refresh')
  assert.match(heroText, /Один агент, одна копия/, 'the mode toggle explains itself')

  const textarea = findAll(opened, (node) => node.type === 'textarea' && node.props.className === 'dsh-artel-hero__textarea')[0]
  assert.ok(textarea !== undefined)
  textarea.props.onChange({ target: { value: 'Добавь кнопку' } })
  await state.realm.renderer.flush()

  const startButton = findButton(state.realm.renderer.tree(), 'Поехали →')
  assert.ok(startButton !== undefined, 'primary start button is rendered')
  assert.equal(startButton.props.disabled, false)
  startButton.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const started = await state.realm.renderer.flush()

  const post = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(post !== undefined, 'run start was sent to the Host')
  assert.equal(post.body.task, 'Добавь кнопку')
  assert.equal(post.body.sessionId, 'sess-1')

  assert.ok(findByClass(started, 'dsh-artel-run') !== undefined, 'run pane replaces the hero')
  const runText = textOf(findByClass(started, 'dsh-artel-run'))
  assert.match(runText, /Готово, кнопка на месте\./)
  assert.match(runText, /Nova/)
  assert.match(runText, /dsh-artel-composer|Ctrl\+Enter/, 'own composer is present')

  /* Fenced code blocks read `labels.code` inside the Host markdown primitive
   * and throw without it, which used to take down the whole slot entry. */
  const markdown = findAll(started, (node) => node.props?.className === 'fake-markdown')[0]
  assert.ok(markdown !== undefined, 'agent reply goes through the Host markdown primitive')
  assert.equal(markdown.props['data-code-label'], 'Код', 'code-block labels are passed to the primitive')
  assert.equal(markdown.props['data-copy-label'], 'Копировать', 'code-block copy label is localized')

  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  debug.getStore('sess-1').dispose()
})

test('the hero picks a provider model and effort, and one agent can be rerouted', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      nextRunId: 'run-live',
      newRunFeed: [{ seq: 1, at: '2026-01-01T11:00:00Z', kind: 'assistant', agent: 'Nova', text: 'Готово.' }],
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  assert.ok(state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/models' && call.method === 'GET'), 'the catalog is loaded for the hero')

  let hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  assert.ok(hero !== undefined, 'the hero shows the profile catalog')
  assert.equal(findAll(hero, (node) => node.type === 'select').length, 0, 'no native select survives in the form')
  let triggers = pickerTriggers(hero)
  assert.equal(triggers.length, 2, 'the model and its effort are two pickers')
  assert.equal(triggers[0].props['data-value'], 'test/fast', 'the profile default model is preselected')
  assert.equal(triggers[1].props['data-value'], 'low', 'the model default effort is preselected')
  assert.equal(findByClass(hero, 'dsh-artel-menu'), undefined, 'the menu is closed until the picker opens')

  triggers[0].props.onClick()
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  const openedMenu = findByClass(hero, 'dsh-artel-menu')
  assert.ok(openedMenu !== undefined, 'the picker opens its own menu, not the native popup')
  triggers = pickerTriggers(hero)
  assert.equal(triggers[0].props['aria-owns'], openedMenu.props.id, 'the combobox owns its listbox for assistive tech')
  assert.equal(triggers[0].props['data-open'], 'true', 'the open trigger exposes its state to CSS')
  pickOption(hero, 'test/slow')
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  triggers = pickerTriggers(hero)
  assert.equal(findByClass(hero, 'dsh-artel-menu'), undefined, 'choosing an option closes the menu')
  assert.equal(triggers[0].props['data-open'], 'false', 'the closed trigger clears its open state')
  assert.equal(triggers.length, 1, 'a model without reasoning efforts hides the effort picker')
  assert.equal(triggers[0].props['data-value'], 'test/slow')

  triggers[0].props.onClick()
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  pickOption(hero, 'test/fast')
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  triggers = pickerTriggers(hero)
  assert.equal(triggers.length, 2, 'the effort picker returns with the model')
  triggers[1].props.onClick()
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  pickerTriggers(hero)[1].props.onKeyDown({ key: 'Escape', preventDefault() {} })
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  assert.equal(findByClass(hero, 'dsh-artel-menu'), undefined, 'Escape closes the menu')
  pickerTriggers(hero)[1].props.onClick()
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero__models')
  pickOption(hero, 'high')
  await state.realm.renderer.flush()

  const textarea = findAll(state.realm.renderer.tree(), (node) => node.type === 'textarea' && node.props.className === 'dsh-artel-hero__textarea')[0]
  assert.ok(textarea !== undefined, 'the hero still offers a task box')
  textarea.props.onChange({ target: { value: 'Сделай кнопку' } })
  await state.realm.renderer.flush()
  findButton(state.realm.renderer.tree(), 'Поехали →').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const started = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(started !== undefined, 'the run was started')
  assert.deepEqual(started.body.model, { provider: 'test', model: 'fast', reasoningEffort: 'high' }, 'the hero route travels with the run')

  const bar = findByClass(state.realm.renderer.tree(), 'dsh-artel-models')
  assert.ok(bar !== undefined, 'every live agent gets a model row')
  const rows = findAll(bar, (node) => node.props?.className === 'dsh-artel-models__row')
  assert.equal(rows.length, DEFAULT_RUN.agents.length)
  const agentTriggers = pickerTriggers(rows[1])
  assert.equal(agentTriggers[0].props['data-value'], '', 'an agent without a route shows the profile default')
  agentTriggers[0].props.onClick()
  await state.realm.renderer.flush()
  pickOption(state.realm.renderer.tree(), 'test/slow')
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const rerouted = state.realm.calls.find((call) => call.method === 'POST' && call.pathname === '/api/dsh-artel/runs/run-live/agents/a2/model')
  assert.ok(rerouted !== undefined, 'the agent reroute reached the Host')
  assert.deepEqual(rerouted.body, { model: { provider: 'test', model: 'slow' } })

  const rerendered = findAll(findByClass(state.realm.renderer.tree(), 'dsh-artel-models'), (node) => node.props?.className === 'dsh-artel-models__row')
  assert.equal(pickerTriggers(rerendered[1])[0].props['data-value'], 'test/slow', 'the bar shows the new route')
  assert.equal(pickerTriggers(rerendered[0])[0].props['data-value'], '', 'the other agents keep their route')

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('closing the surface from its header returns to the chat', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [] } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  assert.ok(findByClass(opened, 'dsh-artel-surface') !== undefined)

  const back = findByClass(opened, 'dsh-artel-surface__back')
  assert.ok(back !== undefined)
  assert.equal(back.props.title, 'Вернуться в чат', 'the back control tooltip matches its label')
  assert.equal(findAll(back, (node) => node.type === 'svg').length, 1, 'the header back button draws one chevron')
  back.props.onClick()
  await state.realm.renderer.flush()
  opened = state.realm.renderer.tree()
  assert.equal(findByClass(opened, 'dsh-artel-surface'), undefined)
  assert.ok(findByClass(opened, 'dsh-artel-launcher') !== undefined)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('change helpers title, total and group the card files', () => {
  const realm = createRealm()
  const plugin = realm.load()
  plugin.apply(createCtx(realm).ctx)
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  assert.ok(debug !== undefined)
  const ru = debug.dictionaries.ru
  const t = (key) => (ru[key] !== undefined ? ru[key] : key)

  assert.equal(debug.isReviewStatus('interrupted'), true)
  assert.equal(debug.isReviewStatus('running'), false)

  assert.equal(debug.changeTitle(t, 0), 'Изменения')
  assert.equal(debug.changeTitle(t, 1), 'Изменения · 1 файл')
  assert.equal(debug.changeTitle(t, 2), 'Изменения · 2 файла')
  assert.equal(debug.changeTitle(t, 5), 'Изменения · 5 файлов')

  const normalized = debug.normalizeChanges({ changes: REVIEW_CHANGES })
  assert.equal(normalized.length, 3)
  assert.deepEqual(normalized.map((entry) => entry.status), ['modified', 'added', 'binary'])
  assert.equal(normalized[2].binary, true)
  assert.equal(normalized[0].hunks.length, 1)

  assert.deepEqual(debug.changeTotals(normalized), { files: 3, added: 12, removed: 1 })
  assert.deepEqual(debug.changeTotals([]), { files: 0, added: 0, removed: 0 })

  const groups = debug.groupChangesByStatus(normalized)
  assert.deepEqual(groups.map((group) => group.status), ['added', 'modified', 'binary'])
  assert.deepEqual(groups[0].items.map((entry) => entry.path), ['test/math.test.js'])
  assert.deepEqual(groups[1].items.map((entry) => entry.path), ['src/math.js'])
  assert.deepEqual(
    debug.orderedChanges(normalized).map((entry) => entry.path),
    ['test/math.test.js', 'src/math.js', 'assets/logo.png'],
  )

  assert.equal(debug.changeStatusLabel(t, 'modified'), 'изменён')
  assert.equal(debug.changeStatusLabel(t, 'binary'), 'двоичный')

  assert.equal(debug.showsChanges(REVIEW_RUN), true)
  assert.equal(debug.showsChanges({ status: 'waiting' }), true)
  assert.equal(debug.showsChanges({ status: 'applied' }), true)
  assert.equal(debug.showsChanges({ status: 'discarded' }), true)
  assert.equal(debug.showsChanges({ status: 'running' }), false)
  assert.equal(debug.showsChanges({ status: 'running', changeCount: 2 }), true)
  assert.equal(debug.showsChanges(null), false)
})

test('store loads changes for a review run and applies them', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [REVIEW_RUN],
      changes: REVIEW_CHANGES,
      applyResult: ['src/math.js', 'test/math.test.js', 'assets/logo.png'],
    },
  })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const store = debug.getStore('sess-1')
  store.open()
  await state.realm.settle()
  await state.realm.settle()

  let snap = store.getSnapshot()
  assert.equal(snap.activeRunId, 'run-review')
  assert.equal(snap.run.status, 'interrupted')
  assert.equal(snap.changesLoaded, true)
  assert.equal(snap.changes.length, 3)
  assert.deepEqual(snap.changes.map((entry) => entry.path), ['src/math.js', 'test/math.test.js', 'assets/logo.png'])
  assert.equal(snap.decided, null)
  assert.ok(state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-review/changes' && call.method === 'GET'))

  await store.applyChanges()
  await state.realm.settle()
  await state.realm.settle()

  snap = store.getSnapshot()
  assert.equal(snap.applying, false)
  assert.equal(snap.decided, 'applied')
  assert.deepEqual(snap.appliedFiles, ['src/math.js', 'test/math.test.js', 'assets/logo.png'])
  assert.deepEqual(snap.skippedFiles, [])
  assert.equal(snap.run.status, 'applied')
  assert.equal(snap.changesError, null)
  assert.ok(state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-review/apply' && call.method === 'POST'))

  // A decided run cannot be applied twice.
  await store.applyChanges()
  await state.realm.settle()
  assert.equal(state.realm.calls.filter((call) => call.pathname.endsWith('/apply')).length, 1)

  store.dispose()
})

test('store discards the copy on request and keeps the project untouched', async () => {
  const state = setup({
    scenario: { project: DEFAULT_PROJECT, runs: [REVIEW_RUN], changes: REVIEW_CHANGES },
  })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const store = debug.getStore('sess-1')
  store.open()
  await state.realm.settle()
  await state.realm.settle()

  await store.discardChanges()
  await state.realm.settle()
  await state.realm.settle()

  const snap = store.getSnapshot()
  assert.equal(snap.discarding, false)
  assert.equal(snap.decided, 'discarded')
  assert.equal(snap.run.status, 'discarded')
  assert.equal(state.realm.calls.filter((call) => call.pathname === '/api/dsh-artel/runs/run-review/discard' && call.method === 'POST').length, 1)
  store.dispose()
})

test('store surfaces apply conflicts in the changes error', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [REVIEW_RUN],
      changes: REVIEW_CHANGES,
      route({ method, pathname }) {
        if (method === 'POST' && pathname === '/api/dsh-artel/runs/run-review/apply') {
          return {
            ok: false,
            status: 409,
            statusText: 'Conflict',
            async text() { return JSON.stringify({ error: 'artel/apply-conflict', message: 'Nothing was applied. src/math.js: changed on disk' }) },
          }
        }
        return undefined
      },
    },
  })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const store = debug.getStore('sess-1')
  store.open()
  await state.realm.settle()
  await state.realm.settle()

  await store.applyChanges()
  await state.realm.settle()

  const snap = store.getSnapshot()
  assert.equal(snap.applying, false)
  assert.equal(snap.decided, null)
  assert.match(snap.changesError, /Nothing was applied\. src\/math\.js: changed on disk/)
  assert.equal(state.realm.calls.filter((call) => call.pathname.endsWith('/apply')).length, 1)

  store.dismissChangesError()
  assert.equal(store.getSnapshot().changesError, null)
  store.dispose()
})

test('Escape closes the overlay through a window keydown listener', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [] } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  assert.ok(findByClass(opened, 'dsh-artel-surface') !== undefined)
  assert.ok((state.realm.windowListeners.get('keydown')?.size ?? 0) > 0, 'window keydown listener is installed while open')

  const handled = state.realm.dispatchWindowEvent('keydown', { key: 'Escape' })
  assert.ok(handled > 0, 'the Escape key reached the listener')
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.equal(findByClass(opened, 'dsh-artel-surface'), undefined)
  assert.ok(findByClass(opened, 'dsh-artel-launcher') !== undefined)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('review run renders the changes card, expands a diff and applies', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [REVIEW_RUN],
      changes: REVIEW_CHANGES,
      applyResult: ['src/math.js', 'test/math.test.js', 'assets/logo.png'],
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const card = findByClass(opened, 'dsh-artel-changes')
  assert.ok(card !== undefined, 'changes card is rendered for an interrupted run')
  const cardText = textOf(card)
  assert.match(cardText, /Изменения · 3 файла/)
  assert.ok(cardText.includes('+12'), 'added lines total is shown')
  assert.ok(cardText.includes('−1'), 'removed lines total is shown')
  assert.ok(cardText.includes('Применить'))
  assert.ok(cardText.includes('Отклонить'))

  const rows = findAll(card, (node) => node.type === 'button' && node.props.className === 'dsh-artel-change')
  assert.equal(rows.length, 3)
  rows[0].props.onClick()
  opened = await state.realm.renderer.flush()
  const diff = findByClass(opened, 'dsh-artel-diff')
  assert.ok(diff !== undefined, 'diff is rendered on demand')
  assert.match(textOf(diff), /import \{ sub \} from/)

  const applyButton = findButton(findByClass(opened, 'dsh-artel-changes__actions'), 'Применить')
  assert.ok(applyButton !== undefined)
  applyButton.props.onClick()
  opened = await state.realm.renderer.flush()

  const confirming = findByClass(opened, 'dsh-artel-changes__actions')
  assert.ok(confirming !== undefined)
  const confirmText = textOf(confirming)
  assert.match(confirmText, /Применить изменения\?/)
  assert.match(confirmText, /Копия будет удалена/)
  assert.match(confirmText, /artel-toy/)

  findButton(confirming, 'Применить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  assert.match(textOf(findByClass(opened, 'dsh-artel-changes')), /Применено/)
  assert.ok(state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-review/apply' && call.method === 'POST'))
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

/* ------------------------------------------------------- conductor (0.5.0) */

test('all three dictionaries carry the Conductor mode and role labels', () => {
  const state = setup()
  const dictionaries = state.dictionaries['dsh-artel']
  assert.ok(dictionaries !== undefined)
  const expected = {
    en: {
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Three agents divide the files; the conductor accepts the work',
      'role.conductor': 'conductor',
      'role.worker': 'agent',
    },
    ru: {
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Трое делят файлы, дирижёр принимает работу',
      'role.conductor': 'дирижёр',
      'role.worker': 'агент',
    },
    zh: {
      'mode.conductor': '指挥',
      'mode.conductor.hint': '三个智能体划分文件，指挥验收成果',
      'role.conductor': '指挥',
      'role.worker': '智能体',
    },
  }
  for (const locale of Object.keys(expected)) {
    for (const key of Object.keys(expected[locale])) {
      assert.equal(dictionaries[locale]?.[key], expected[locale][key], locale + ' has ' + key)
    }
  }
  assert.equal(state.report.version, '0.5.0', 'the diagnostics report carries the release version')
  assert.equal(state.realm.window.__DSH_ARTEL_DEBUG__.version, '0.5.0')
})

test('modeLabel, agentProgress and agentRole know the conductor', () => {
  const realm = createRealm()
  const plugin = realm.load()
  plugin.apply(createCtx(realm).ctx)
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  assert.ok(debug !== undefined)
  const t = (locale) => (key) => (debug.dictionaries[locale][key] !== undefined ? debug.dictionaries[locale][key] : key)
  const ruT = t('ru')
  const enT = t('en')
  const zhT = t('zh')

  assert.equal(debug.modeLabel(enT, 'conductor'), 'Conductor')
  assert.equal(debug.modeLabel(zhT, 'conductor'), '指挥')

  const conductorRun = {
    mode: 'conductor',
    status: 'running',
    agents: [
      { id: 'c1', name: 'Iris', role: 'conductor', status: 'idle' },
      { id: 'a1', name: 'Vega', role: 'worker', status: 'idle' },
      { id: 'a2', name: 'Nova', role: 'worker', status: 'working' },
      { id: 'a3', name: 'Rill', role: 'worker', status: 'failed' },
    ],
  }
  assert.deepEqual(debug.agentProgress(conductorRun), { done: 2, total: 3 }, 'the conductor is not one of the shares')
  assert.deepEqual(debug.agentProgress({ agents: [conductorRun.agents[0]] }), { done: 0, total: 0 }, 'a conductor-only run has no shares')
  assert.equal(debug.runMeta(ruT, conductorRun), 'Conductor · 2/3 · В работе')

  assert.equal(typeof debug.agentRole, 'function', 'agentRole is exported for tests')
  assert.equal(debug.agentRole(ruT, conductorRun, 'Iris'), 'дирижёр', 'the conductor role is translated')
  assert.equal(debug.agentRole(ruT, conductorRun, 'Vega'), 'агент', 'the worker role is translated')
  assert.equal(debug.agentRole(ruT, DEFAULT_RUN, 'Nova'), 'dev', 'a role without a dictionary key stays raw')
  assert.equal(debug.agentRole(ruT, conductorRun, 'Nobody'), 'agent', 'an unknown agent keeps the plain fallback role')
})

test('hero offers the Conductor mode and starts a conductor run', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      nextRunId: 'run-conductor',
      newRunFeed: [{ seq: 1, at: '2026-01-01T11:00:00Z', kind: 'assistant', agent: 'Iris', text: 'Работа принята целиком.' }],
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  let hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  assert.ok(hero !== undefined, 'the hero is shown before a run is selected')
  let options = findAll(findByClass(hero, 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  assert.equal(options.length, 3, 'solo, swarm and conductor are the three modes')
  assert.deepEqual(options.map((option) => option.props.children[0]), ['Solo', 'Swarm', 'Conductor'])
  assert.equal(options[2].props.title, 'Трое делят файлы, дирижёр принимает работу', 'the option carries its own hint')
  assert.equal(options[2].props['aria-checked'], false)
  assert.equal(textOf(findByClass(hero, 'dsh-artel-hero__mode-hint')).trim(), 'Один агент, одна копия', 'the hint follows the selected mode')

  options[2].props.onClick()
  await state.realm.renderer.flush()
  hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  options = findAll(findByClass(hero, 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  assert.equal(options[2].props['aria-checked'], true, 'the conductor option becomes selected')
  assert.equal(textOf(findByClass(hero, 'dsh-artel-hero__mode-hint')).trim(), 'Трое делят файлы, дирижёр принимает работу')

  const textarea = findAll(hero, (node) => node.type === 'textarea' && node.props.className === 'dsh-artel-hero__textarea')[0]
  assert.ok(textarea !== undefined)
  textarea.props.onChange({ target: { value: 'Проведите работу через дирижёра' } })
  await state.realm.renderer.flush()
  findButton(state.realm.renderer.tree(), 'Поехали →').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const started = await state.realm.renderer.flush()

  const post = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(post !== undefined, 'the run start reached the Host')
  assert.equal(post.body.mode, 'conductor', 'the conductor mode travels with the run')
  assert.equal(post.body.task, 'Проведите работу через дирижёра')
  assert.ok(findByClass(started, 'dsh-artel-run') !== undefined, 'the run pane replaces the hero')
  const runText = textOf(findByClass(started, 'dsh-artel-run'))
  assert.match(runText, /Conductor/)
  assert.match(runText, /Работа принята целиком\./)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('store.startRun normalizes the conductor mode and keeps solo as the default', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [], nextRunId: 'run-normalized' } })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const store = debug.getStore('sess-1')
  store.open()
  await state.realm.settle()
  await state.realm.settle()

  const posts = () => state.realm.calls.filter((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')

  await store.startRun({ task: 'Собери команду', mode: 'conductor', projectPath: DEFAULT_PROJECT.projectPath })
  await state.realm.settle()
  assert.equal(posts().length, 1)
  assert.equal(posts()[0].body.mode, 'conductor', 'the conductor mode is passed through')

  await store.startRun({ task: 'Один агент', mode: 'solo' })
  await state.realm.settle()
  assert.equal(posts().length, 2)
  assert.equal(posts()[1].body.mode, 'solo', 'solo stays solo')

  await store.startRun({ task: 'Неизвестный режим', mode: 'bogus' })
  await state.realm.settle()
  assert.equal(posts().length, 3)
  assert.equal(posts()[2].body.mode, 'solo', 'an unknown mode falls back to solo')

  store.dispose()
})
