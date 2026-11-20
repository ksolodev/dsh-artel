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

/** A saved auto-queue version: the history and the run header must mark it. */
const AUTOQUEUE_RUN = {
  ...DEFAULT_RUN,
  id: 'run-auto',
  mode: 'solo',
  task: 'Ночная задача',
  status: 'waiting',
  phase: 'Готово',
  autoqueue: true,
  changeCount: 1,
  copyPath: 'C:\\tmp\\copies\\run-auto',
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

/* ------------------------------------------------------- orchestrator (0.7.0) */

const ORCHESTRATOR_PARTS = [
  {
    id: 'p1',
    title: 'Настроить кнопку',
    goal: 'Добавить кнопку на главный экран',
    conditions: ['Кнопка видна на главном экране', 'Клик открывает диалог'],
    files: ['src/app.js'],
    status: 'accepted',
    rounds: 0,
    remarks: null,
    workerName: 'Vega',
    reviewerName: 'Rill',
  },
  {
    id: 'p2',
    title: 'Проверить стили',
    goal: 'Подогнать стили под тему',
    conditions: ['Стили совпадают с макетом'],
    files: ['src/theme.css'],
    status: 'reviewing',
    rounds: 0,
    remarks: null,
    workerName: 'Nova',
    reviewerName: 'Orion',
  },
  {
    id: 'p3',
    title: 'Обновить тесты',
    goal: 'Добавить тест на кнопку',
    conditions: ['Тест падает без кнопки'],
    files: ['test/app.test.js'],
    status: 'rework',
    rounds: 1,
    remarks: 'Проверяющему не хватило проверки на клавиатуру.',
    workerName: 'Atlas',
    reviewerName: 'Pax',
  },
]

const ORCHESTRATOR_PLAN = { summary: 'Сначала кнопка, потом стили и тесты.', parts: ORCHESTRATOR_PARTS }

const ORCHESTRATOR_RUN = {
  ...DEFAULT_RUN,
  id: 'run-orch',
  mode: 'orchestrator',
  task: 'Добавь кнопку и тесты',
  status: 'waiting',
  phase: 'Сборка',
  changeCount: 0,
  plan: ORCHESTRATOR_PLAN,
  merge: { conflicts: [{ path: 'src/app.js', parts: ['p1', 'p2'] }], unresolved: [] },
  agents: [
    { id: 'o1', name: 'Metis', role: 'planner', status: 'idle' },
    { id: 'o2', name: 'Vega', role: 'part', status: 'idle' },
    { id: 'o3', name: 'Rill', role: 'reviewer', status: 'idle' },
    { id: 'o4', name: 'Atlas', role: 'merger', status: 'idle' },
  ],
}

/** A run the Host reports failed mid-merge: apply must stay closed. */
const ORCHESTRATOR_BLOCKED_RUN = {
  ...ORCHESTRATOR_RUN,
  id: 'run-orch-blocked',
  status: 'failed',
  phase: 'Сборка не завершена',
  merge: { conflicts: [{ path: 'src/app.js', parts: ['p1', 'p2'] }], unresolved: ['src/app.js'] },
}

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
  const launcherCss = state.realm.styleElements[0].textContent
  assert.match(launcherCss, /\.dsh-artel-launcher:focus-visible/, 'the launcher keeps a visible focus ring')
  assert.match(launcherCss, /\.dsh-artel-launcher \{[^}]*border: 1px solid rgba\(124, 108, 255, 0\.32\)/, 'the launcher paints the Artel chip instead of a bare glyph')
  assert.match(launcherCss, /\.dsh-artel-launcher \{[^}]*linear-gradient\(180deg, rgba\(124, 108, 255, 0\.24\)/, 'the chip carries the brand fill')
  assert.match(launcherCss, /\.dsh-artel-launcher__label/, 'the chip names itself next to the mark')
  assert.match(launcherCss, /@container \(max-width: 460px\)/, 'a narrow row keeps only the mark')
  assert.doesNotMatch(launcherCss, /\.dsh-artel-launcher[^{]*\.dsh-artel-spin/, 'no spinner ring is ever attached to the launcher')
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

  // Right now: what each agent is doing, how long its turn runs, how full its
  // context is, and what the run itself is waiting for.
  assert.equal(debug.tokenCount(812), '812')
  assert.equal(debug.tokenCount(4_200), '4.2K')
  assert.equal(debug.tokenCount(128_000), '128K')
  assert.equal(debug.tokenCount(1_300_000), '1.3M')
  assert.equal(debug.tokenCount(undefined), '')

  const agentWithContext = {
    stats: {
      context: { tokens: 40_000, window: 128_000, breakdown: { system: 900, tools: 2_500, messages: 6_000 } },
      usage: null,
    },
  }
  assert.equal(debug.contextShare(agentWithContext), 31)
  assert.equal(debug.contextShare({ stats: { context: null } }), null)
  assert.equal(debug.contextShare({}), null)
  assert.deepEqual(debug.compositionOf(agentWithContext), { system: 900, tools: 2_500, messages: 6_000 })
  assert.equal(debug.compositionOf({ stats: { context: { tokens: 1, window: 2 } } }), null)
  assert.equal(debug.contextHint(t, agentWithContext), '40K из 128K токенов · 31% окна\nсистема 900 · инструменты 2.5K · сообщения 6K')
  assert.equal(debug.contextHint(t, {}), '')

  const started = Date.now() - 65 * 1000
  assert.equal(debug.durationLabel(started), '1:05')
  assert.equal(debug.durationLabel(Date.now() - 12_000), '12s')
  assert.equal(debug.durationLabel(null), '')

  assert.deepEqual(debug.activityOf({ activity: { kind: 'tool', tool: 'write', text: 'write src/app.js' } }), { kind: 'tool', tool: 'write', text: 'src/app.js' })
  assert.deepEqual(debug.activityOf({ activity: { kind: 'assistant', text: 'Готово' } }), { kind: 'assistant', tool: '', text: 'Готово' })
  assert.equal(debug.activityOf({}), null)

  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'user' } }), 'Ждёт вашего ответа')
  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'approval' } }), 'Ждёт утверждения плана')
  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'agents', names: ['Orion', 'Lyra'] } }), 'Ждём: Orion и Lyra')
  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'agents', names: ['Nova'] } }), 'Ждём: Nova')
  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'agents', names: ['A', 'B', 'C'] } }), 'Ждём: A, B, C')
  assert.equal(debug.waitingLabel(t, { waitingFor: { kind: 'host' } }), 'Сводит результат')
  assert.equal(debug.waitingLabel(t, {}), '')

  assert.equal(debug.agentDotState({ status: 'working' }), 'ongoing')
  assert.equal(debug.agentDotState({ status: 'idle' }), 'done')
  assert.equal(debug.agentDotState({ status: 'failed' }), 'error')
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
  assert.equal(findByClass(launcher, 'dsh-artel-spin'), undefined, 'the composer row shows no Artel spinner next to the mark')
  assert.equal(findByClass(launcher, 'dsh-artel-dot'), undefined, 'an idle launcher paints no status badge')
  assert.match(textOf(findByClass(launcher, 'dsh-artel-launcher__label')), /Артель/, 'the chip names itself so it cannot read as a second spinner')
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
  assert.equal(findByClass(opened, 'dsh-artel-parts'), undefined, 'ordinary modes render no parts card')
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

test('a tool call row expands onto its arguments and output', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN],
      feed: {
        'run-1': [
          {
            seq: 1,
            at: '2026-01-01T10:01:00Z',
            kind: 'tool',
            agent: 'Nova',
            tool: 'write',
            text: 'write src/app.js',
            path: 'src/app.js',
            callId: 'call-1',
            args: '{\n  "path": "src/app.js"\n}',
          },
          { seq: 2, at: '2026-01-01T10:01:05Z', kind: 'tool-result', agent: 'Nova', callId: 'call-1', ok: true, text: 'wrote 12 bytes' },
          { seq: 3, at: '2026-01-01T10:02:00Z', kind: 'tool', agent: 'Nova', tool: 'read', text: 'read README.md' },
        ],
      },
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const tools = findByClass(opened, 'dsh-artel-tools')
  assert.ok(tools !== undefined, 'the tool calls are in the feed')
  const head = findAll(tools, (node) => node.type === 'button' && node.props.className === 'dsh-artel-tool__head')
  assert.equal(head.length, 1, 'only the call with something to show is a disclosure')
  assert.equal(head[0].props['aria-expanded'], false)
  assert.equal(findByClass(opened, 'dsh-artel-tool__code'), undefined, 'the payload stays hidden until asked for')

  head[0].props.onClick()
  opened = await state.realm.renderer.flush()
  const openHead = findAll(opened, (node) => node.type === 'button' && node.props.className === 'dsh-artel-tool__head')[0]
  assert.equal(openHead.props['aria-expanded'], true, 'the row reports its state to assistive tech')
  const codes = findAll(opened, (node) => node.props?.className === 'dsh-artel-tool__code').map(textOf)
  assert.equal(codes.length, 2)
  assert.match(codes[0], /"path": "src\/app\.js"/)
  assert.equal(codes[1].trim(), 'wrote 12 bytes', 'the output of the call is shown, not just its name')
  assert.ok(findButton(findByClass(opened, 'dsh-artel-tools'), 'Свернуть все') !== undefined, 'one click collapses every open row')

  const collapse = findButton(findByClass(opened, 'dsh-artel-tools'), 'Свернуть все')
  collapse.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.equal(findByClass(opened, 'dsh-artel-tool__code'), undefined, 'collapsing all hides the payload again')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the live strip says what each agent does and what the run waits for', async () => {
  const turnStart = Date.now() - 65_000
  const liveRun = {
    ...DEFAULT_RUN,
    waitingFor: { kind: 'agents', names: ['Nova'], since: Date.now() - 90_000 },
    spend: { inputTokens: 9_000, outputTokens: 2_000, cacheReadTokens: 1_000, cacheWriteTokens: 0, totalTokens: 12_000, requests: 4 },
    agents: [
      { id: 'a1', name: 'Vega', role: 'lead', status: 'idle' },
      {
        id: 'a2',
        name: 'Nova',
        role: 'dev',
        status: 'working',
        turns: 2,
        turnStartedAt: turnStart,
        activity: { kind: 'tool', tool: 'write', text: 'write src/app.js', at: turnStart + 1_000 },
        stats: {
          context: { tokens: 54_000, window: 128_000, breakdown: { system: 900, tools: 2_500, messages: 6_000 } },
          usage: { inputTokens: 9_000, outputTokens: 2_000, cacheReadTokens: 1_000, totalTokens: 12_000, requests: 4 },
        },
      },
      { id: 'a3', name: 'Rill', role: 'review', status: 'starting' },
    ],
  }
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [liveRun], feed: { 'run-1': [] } } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const strip = findByClass(opened, 'dsh-artel-live')
  assert.ok(strip !== undefined, 'a running run shows the live strip')
  assert.equal(strip.props.role, 'list')
  const rows = findAll(strip, (node) => node.props?.role === 'listitem')
  assert.equal(rows.length, 3, 'every agent gets a row')
  const nova = rows.find((row) => row.props['data-agent-id'] === 'a2')
  const novaText = textOf(nova)
  assert.match(novaText, /Nova/)
  assert.match(novaText, /write/, 'the last tool call is named')
  assert.match(novaText, /src\/app\.js/, 'and what it was called on')
  assert.match(novaText, /1:05/, 'the current turn shows how long it already runs')
  assert.match(novaText, /54K/)
  assert.match(novaText, /42%/)
  assert.equal(nova.props['data-status'], 'working')
  assert.equal(findByClass(nova, 'dsh-artel-live__ctx').props['data-tone'], 'low')

  const vega = rows.find((row) => row.props['data-agent-id'] === 'a1')
  assert.equal(vega.props['data-status'], 'idle', 'an idle agent is shown as done, not busy')
  assert.ok(findByClass(vega, 'dsh-artel-live__ctx--empty') !== undefined, 'no metering yet reads as a dash')
  assert.equal(findByClass(vega, 'dsh-artel-live__clock'), undefined, 'only a running turn has a clock')

  const waiting = findByClass(opened, 'dsh-artel-run__waiting')
  assert.ok(waiting !== undefined, 'the header names what the run waits for')
  assert.equal(waiting.props['data-kind'], 'agents')
  assert.match(textOf(waiting), /Ждём: Nova/)
  assert.match(textOf(waiting), /1:30/, 'and how long it waits already')

  const spend = findAll(opened, (node) => String(node.props?.className ?? '') === 'dsh-artel-tag').map(textOf).join(' ')
  assert.match(spend, /12K/, 'the header sums the tokens the run has spent')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('a finished run shows no live strip', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [{ ...DEFAULT_RUN, status: 'applied' }], feed: { 'run-1': [] } } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.equal(findByClass(opened, 'dsh-artel-live'), undefined, 'nothing is live once the run is over')
  assert.equal(findByClass(opened, 'dsh-artel-run__waiting'), undefined)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

/* ------------------------------------------------------- conductor (0.5.0) */

test('all three dictionaries carry the Conductor and Fusion mode and role labels', () => {
  const state = setup()
  const dictionaries = state.dictionaries['dsh-artel']
  assert.ok(dictionaries !== undefined)
  const expected = {
    en: {
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Three agents divide the files; the conductor accepts the work',
      'mode.fusion': 'Fusion',
      'mode.fusion.hint': 'Three models answer independently, a judge merges them, one model does the work',
      'role.conductor': 'conductor',
      'role.worker': 'agent',
      'role.panelist': 'panelist',
      'role.judge': 'judge',
      'role.implementer': 'implementer',
      'hero.fusion.title': 'Fusion routes',
      'hero.fusion.panel': 'Panel {n}',
      'hero.fusion.judge': 'Judge',
      'hero.fusion.implementer': 'Implementer',
    },
    ru: {
      'mode.conductor': 'Conductor',
      'mode.conductor.hint': 'Трое делят файлы, дирижёр принимает работу',
      'mode.fusion': 'Fusion',
      'mode.fusion.hint': 'Три модели отвечают независимо, судья сводит ответы, одна модель делает работу',
      'role.conductor': 'дирижёр',
      'role.worker': 'агент',
      'role.panelist': 'панелист',
      'role.judge': 'судья',
      'role.implementer': 'исполнитель',
      'hero.fusion.title': 'Маршруты Fusion',
      'hero.fusion.panel': 'Панель {n}',
      'hero.fusion.judge': 'Судья',
      'hero.fusion.implementer': 'Исполнитель',
    },
    zh: {
      'mode.conductor': '指挥',
      'mode.conductor.hint': '三个智能体划分文件，指挥验收成果',
      'mode.fusion': '融合',
      'mode.fusion.hint': '三个模型独立回答，评审汇总，一个模型执行',
      'role.conductor': '指挥',
      'role.worker': '智能体',
      'role.panelist': '组员',
      'role.judge': '评审',
      'role.implementer': '执行者',
      'hero.fusion.title': '融合路由',
      'hero.fusion.panel': '模型 {n}',
      'hero.fusion.judge': '评审',
      'hero.fusion.implementer': '执行者',
    },
  }
  for (const locale of Object.keys(expected)) {
    for (const key of Object.keys(expected[locale])) {
      assert.equal(dictionaries[locale]?.[key], expected[locale][key], locale + ' has ' + key)
    }
  }
  assert.equal(state.report.version, '0.8.3', 'the diagnostics report carries the release version')
  assert.equal(state.realm.window.__DSH_ARTEL_DEBUG__.version, '0.8.3')
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
  assert.equal(debug.modeLabel(enT, 'fusion'), 'Fusion')
  assert.equal(debug.modeLabel(zhT, 'fusion'), '融合')

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

  const fusionRun = {
    mode: 'fusion',
    status: 'running',
    agents: [
      { id: 'f1', name: 'Vega', role: 'panelist', status: 'idle' },
      { id: 'f2', name: 'Orion', role: 'panelist', status: 'working' },
      { id: 'f3', name: 'Atlas', role: 'judge', status: 'idle' },
      { id: 'f4', name: 'Nova', role: 'implementer', status: 'idle' },
    ],
  }
  assert.deepEqual(debug.agentProgress(fusionRun), { done: 3, total: 4 }, 'every Fusion agent is a share')
  assert.equal(debug.runMeta(ruT, fusionRun), 'Fusion · 3/4 · В работе')
  assert.equal(debug.agentRole(ruT, fusionRun, 'Orion'), 'панелист', 'the panelist role is translated')
  assert.equal(debug.agentRole(ruT, fusionRun, 'Atlas'), 'судья', 'the judge role is translated')
  assert.equal(debug.agentRole(ruT, fusionRun, 'Nova'), 'исполнитель', 'the implementer role is translated')
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
  assert.equal(options.length, 5, 'solo, swarm, conductor, fusion and orchestrator are the five modes')
  assert.deepEqual(options.map((option) => option.props.children[0]), ['Solo', 'Swarm', 'Conductor', 'Fusion', 'Оркестратор'])
  assert.equal(options[2].props.title, 'Трое делят файлы, дирижёр принимает работу', 'the option carries its own hint')
  assert.equal(options[3].props.title, 'Три модели отвечают независимо, судья сводит ответы, одна модель делает работу')
  assert.equal(
    options[4].props.title,
    'Цель режется на части, каждая в своей копии; старший проверяет каждую часть до сборки.',
    'the orchestrator option carries its own hint',
  )
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

test('hero shows the five Fusion routes and starts a fusion run', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      nextRunId: 'run-fusion',
      newRunFeed: [{ seq: 1, at: '2026-01-01T11:00:00Z', kind: 'status', text: 'Three models are answering the same question independently.' }],
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const heroNow = () => findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  const radios = () => findAll(findByClass(heroNow(), 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  const fusionChips = () => findAll(findByClass(heroNow(), 'dsh-artel-hero__fusion'), (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-hero__fusion-pick'))

  assert.ok(findByClass(heroNow(), 'dsh-artel-model-pick') !== undefined, 'solo/swarm keep the single route chip')
  assert.equal(findByClass(heroNow(), 'dsh-artel-hero__fusion'), undefined)

  radios()[3].props.onClick()
  await state.realm.renderer.flush()
  assert.ok(findByClass(heroNow(), 'dsh-artel-hero__fusion') !== undefined, 'Fusion replaces the single route with five slots')
  const chips = fusionChips()
  assert.equal(chips.length, 5, 'three panel slots, a judge and an implementer')
  assert.deepEqual(
    chips.map((chip) => textOf(findByClass(chip, 'dsh-artel-model-pick__label')).trim()),
    ['Панель 1', 'Панель 2', 'Панель 3', 'Судья', 'Исполнитель'],
  )

  // The panel is pre-seeded with distinct catalog rows, judge and implementer with the default.
  const values = () => fusionChips().map((chip) => pickerTriggers(chip)[0].props['data-value'])
  assert.deepEqual(values(), ['test/fast', 'test/slow', 'test/fast', 'test/fast', 'test/fast'])

  // Picking another model for the first panel slot leaves the other four slots intact.
  pickerTriggers(fusionChips()[0])[0].props.onClick()
  await state.realm.renderer.flush()
  pickOption(state.realm.renderer.tree(), 'test/slow')
  await state.realm.renderer.flush()
  assert.deepEqual(values(), ['test/slow', 'test/slow', 'test/fast', 'test/fast', 'test/fast'])

  const textarea = findAll(heroNow(), (node) => node.type === 'textarea' && node.props.className === 'dsh-artel-hero__textarea')[0]
  textarea.props.onChange({ target: { value: 'Выберите лучший подход к задаче' } })
  await state.realm.renderer.flush()
  findButton(state.realm.renderer.tree(), 'Поехали →').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const post = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(post !== undefined, 'the fusion run start reached the Host')
  assert.equal(post.body.mode, 'fusion')
  assert.equal(post.body.task, 'Выберите лучший подход к задаче')
  assert.deepEqual(post.body.models, {
    panel: [
      { provider: 'test', model: 'slow' },
      { provider: 'test', model: 'slow' },
      { provider: 'test', model: 'fast', reasoningEffort: 'low' },
    ],
    judge: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
    implementer: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
  })
  assert.ok(findByClass(state.realm.renderer.tree(), 'dsh-artel-run') !== undefined, 'the run pane replaces the hero')

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

  await store.startRun({ task: 'Сведи три ответа', mode: 'fusion', models: { panel: [], judge: null, implementer: null } })
  await state.realm.settle()
  assert.equal(posts().length, 4)
  assert.equal(posts()[3].body.mode, 'fusion', 'the fusion mode is passed through')
  assert.deepEqual(posts()[3].body.models, { panel: [], judge: null, implementer: null })

  await store.startRun({ task: 'Раздели на части', mode: 'orchestrator', projectPath: DEFAULT_PROJECT.projectPath })
  await state.realm.settle()
  assert.equal(posts().length, 5)
  assert.equal(posts()[4].body.mode, 'orchestrator', 'the orchestrator mode is passed through')

  store.dispose()
})

/* ---------------------------------------------------- orchestrator (0.7.0) */

test('all three dictionaries carry the Orchestrator mode, roles, part statuses and parts strings', () => {
  const state = setup()
  const dictionaries = state.dictionaries['dsh-artel']
  assert.ok(dictionaries !== undefined)
  const expected = {
    en: {
      'mode.orchestrator': 'Orchestrator',
      'mode.orchestrator.hint': 'The goal is split into parts, each built in its own copy and checked before the parts are assembled.',
      'role.planner': 'Planner',
      'role.part': 'Part agent',
      'role.reviewer': 'Reviewer',
      'role.merger': 'Merger',
      'partStatus.pending': 'Pending',
      'partStatus.working': 'Working',
      'partStatus.reviewing': 'In review',
      'partStatus.rework': 'Back to work',
      'partStatus.accepted': 'Accepted',
      'partStatus.failed': 'Failed',
      'parts.title': 'Parts',
      'parts.item': 'Part {n} — {title}',
      'parts.summaryLabel': 'Plan',
      'parts.conditionsLabel': 'Done when',
      'parts.filesLabel': 'Files',
      'parts.rounds': 'Rework round {n} of 2',
      'parts.mergeResolved': 'Merger resolved {n} conflict(s)',
      'parts.mergeUnresolved': 'The merge is not finished — apply is unavailable.',
      'parts.accepted': '{done}/{total} accepted',
    },
    ru: {
      'mode.orchestrator': 'Оркестратор',
      'mode.orchestrator.hint': 'Цель режется на части, каждая в своей копии; старший проверяет каждую часть до сборки.',
      'role.planner': 'Планировщик',
      'role.part': 'Агент части',
      'role.reviewer': 'Проверяющий',
      'role.merger': 'Сборщик',
      'partStatus.pending': 'Ожидает',
      'partStatus.working': 'В работе',
      'partStatus.reviewing': 'На проверке',
      'partStatus.rework': 'Возвращена в работу',
      'partStatus.accepted': 'Принята',
      'partStatus.failed': 'Ошибка',
      'parts.title': 'Части',
      'parts.item': 'Часть {n} — {title}',
      'parts.summaryLabel': 'План',
      'parts.conditionsLabel': 'Сделано, если',
      'parts.filesLabel': 'Файлы',
      'parts.rounds': 'Возврат {n} из 2',
      'parts.mergeResolved': 'Сборщик разрешил конфликтов: {n}',
      'parts.mergeUnresolved': 'Сборка не завершена — применить нельзя.',
      'parts.accepted': '{done}/{total} принято',
    },
    zh: {
      'mode.orchestrator': '编排',
      'mode.orchestrator.hint': '目标拆成多个部分，每部分在各自的副本中完成，组装前逐一验收。',
      'role.planner': '规划者',
      'role.part': '部分代理',
      'role.reviewer': '审查者',
      'role.merger': '合并者',
      'partStatus.pending': '等待',
      'partStatus.working': '进行中',
      'partStatus.reviewing': '审核中',
      'partStatus.rework': '返工',
      'partStatus.accepted': '已通过',
      'partStatus.failed': '失败',
      'parts.title': '部分',
      'parts.item': '第 {n} 部分 — {title}',
      'parts.summaryLabel': '计划',
      'parts.conditionsLabel': '完成条件',
      'parts.filesLabel': '文件',
      'parts.rounds': '返工 {n}/2',
      'parts.mergeResolved': '合并者解决了 {n} 处冲突',
      'parts.mergeUnresolved': '合并未完成——暂时无法应用。',
      'parts.accepted': '已通过 {done}/{total}',
    },
  }
  for (const locale of Object.keys(expected)) {
    for (const key of Object.keys(expected[locale])) {
      assert.equal(dictionaries[locale]?.[key], expected[locale][key], locale + ' has ' + key)
    }
  }
  // Key parity: no locale may silently lose one of the Orchestrator strings.
  const keys = Object.keys(expected.en)
  for (const locale of Object.keys(expected)) {
    for (const key of keys) assert.equal(typeof dictionaries[locale][key], 'string', locale + ' carries ' + key)
  }
  assert.deepEqual(state.realm.window.__DSH_ARTEL_DEBUG__.modes, ['solo', 'swarm', 'conductor', 'fusion', 'orchestrator'])
})

test('orchestrator helpers map plan parts to progress, labels and merge guards', () => {
  const state = setup()
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const t = (locale) => (key) => (debug.dictionaries[locale][key] !== undefined ? debug.dictionaries[locale][key] : key)
  const ruT = t('ru')
  const enT = t('en')
  const zhT = t('zh')

  assert.equal(debug.modeLabel(enT, 'orchestrator'), 'Orchestrator')
  assert.equal(debug.modeLabel(ruT, 'orchestrator'), 'Оркестратор')
  assert.equal(debug.modeLabel(zhT, 'orchestrator'), '编排')

  assert.equal(debug.roleLabel(ruT, 'planner'), 'Планировщик')
  assert.equal(debug.roleLabel(ruT, 'part'), 'Агент части')
  assert.equal(debug.roleLabel(ruT, 'reviewer'), 'Проверяющий')
  assert.equal(debug.roleLabel(ruT, 'merger'), 'Сборщик')
  assert.equal(debug.roleLabel(ruT, 'mystery-role'), 'mystery-role', 'an unknown role stays raw')
  assert.equal(debug.roleLabel(ruT, undefined), 'agent', 'a missing role keeps the untranslated agent fallback')

  assert.equal(debug.partStatusTone('pending'), 'muted')
  assert.equal(debug.partStatusTone('working'), 'active')
  assert.equal(debug.partStatusTone('reviewing'), 'active')
  assert.equal(debug.partStatusTone('rework'), 'warn')
  assert.equal(debug.partStatusTone('accepted'), 'ok')
  assert.equal(debug.partStatusTone('failed'), 'error')
  assert.equal(debug.partStatusTone('bogus'), 'muted')
  assert.equal(debug.partStatusLabel(ruT, 'rework'), 'Возвращена в работу')
  assert.equal(debug.partStatusLabel(enT, 'accepted'), 'Accepted')
  assert.equal(debug.partStatusLabel(zhT, 'failed'), '失败')
  assert.equal(debug.partStatusLabel(ruT, 'bogus'), 'bogus', 'an unknown part status stays raw')

  assert.deepEqual(debug.planParts(undefined), [], 'a run without a plan has no parts')
  assert.deepEqual(debug.planParts({ plan: null }), [])
  assert.equal(debug.planParts(ORCHESTRATOR_RUN).length, 3)
  assert.equal(debug.planParts(ORCHESTRATOR_RUN)[2].status, 'rework')

  assert.deepEqual(debug.agentProgress(ORCHESTRATOR_RUN), { done: 1, total: 3 }, 'accepted parts are the progress share')
  assert.deepEqual(debug.agentProgress({ ...ORCHESTRATOR_RUN, plan: null }), { done: 0, total: 0 }, 'no plan yet means empty progress')
  assert.deepEqual(
    debug.agentProgress({ mode: 'orchestrator', plan: { parts: [{ id: 'p1', status: 'accepted' }, { id: 'p2', status: 'working' }] } }),
    { done: 1, total: 2 },
    'only accepted parts count as done',
  )
  assert.equal(debug.runMeta(ruT, ORCHESTRATOR_RUN), 'Оркестратор · 1/3 · Сборка')

  assert.equal(debug.mergeBlocked(ORCHESTRATOR_RUN), false)
  assert.equal(debug.mergeBlocked(ORCHESTRATOR_BLOCKED_RUN), true, 'unresolved merge paths block apply')
  assert.equal(debug.mergeBlocked({}), false)
  assert.equal(debug.mergeBlocked({ merge: { unresolved: [] } }), false)

  assert.equal(debug.agentRole(ruT, ORCHESTRATOR_RUN, 'Metis'), 'Планировщик')
  assert.equal(debug.agentRole(ruT, ORCHESTRATOR_RUN, 'Vega'), 'Агент части')
  assert.equal(debug.agentRole(ruT, ORCHESTRATOR_RUN, 'Rill'), 'Проверяющий')
  assert.equal(debug.agentRole(ruT, ORCHESTRATOR_RUN, 'Atlas'), 'Сборщик')
})

test('hero offers the Orchestrator mode and starts an orchestrator run', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      nextRunId: 'run-orchestrator',
      newRunFeed: [
        { seq: 1, at: '2026-01-01T11:00:00Z', kind: 'plan', text: 'Цель разбита на три части.' },
        { seq: 2, at: '2026-01-01T11:01:00Z', kind: 'status', text: 'Part 1 — Настроить кнопку: accepted.' },
      ],
    },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const hero = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  assert.ok(hero !== undefined, 'the hero is shown before a run is selected')
  const options = findAll(findByClass(hero, 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  assert.equal(options.length, 5, 'the mode picker now offers five modes')
  assert.equal(options[4].props.children[0], 'Оркестратор')

  options[4].props.onClick()
  await state.realm.renderer.flush()
  const selected = findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  assert.ok(selected !== undefined, 'the hero stays mounted after the mode change')
  assert.equal(
    textOf(findByClass(selected, 'dsh-artel-hero__mode-hint')).trim(),
    'Цель режется на части, каждая в своей копии; старший проверяет каждую часть до сборки.',
    'the orchestrator hint follows the selected mode',
  )

  const textarea = findAll(selected, (node) => node.type === 'textarea' && node.props.className === 'dsh-artel-hero__textarea')[0]
  assert.ok(textarea !== undefined)
  textarea.props.onChange({ target: { value: 'Разделите работу на части' } })
  await state.realm.renderer.flush()
  findButton(state.realm.renderer.tree(), 'Поехали →').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const started = await state.realm.renderer.flush()

  const post = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/runs' && call.method === 'POST')
  assert.ok(post !== undefined, 'the orchestrator run start reached the Host')
  assert.equal(post.body.mode, 'orchestrator', 'the orchestrator mode travels with the run')
  assert.equal(post.body.task, 'Разделите работу на части')
  assert.ok(findByClass(started, 'dsh-artel-run') !== undefined, 'the run pane replaces the hero')
  const runText = textOf(findByClass(started, 'dsh-artel-run'))
  assert.match(runText, /Оркестратор/)
  assert.match(runText, /Цель разбита на три части\./)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('orchestrator run renders the parts card with plan, statuses and merge note', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [ORCHESTRATOR_RUN], changes: [] } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const card = findByClass(opened, 'dsh-artel-parts')
  assert.ok(card !== undefined, 'the parts card is rendered for an orchestrator run')
  const cardText = textOf(card)
  assert.match(cardText, /Части/)
  assert.match(cardText, /1\/3 принято/)
  assert.match(cardText, /План/)
  assert.match(cardText, /Сначала кнопка, потом стили и тесты\./)
  assert.match(cardText, /Часть 1 — Настроить кнопку/)
  assert.match(cardText, /Часть 2 — Проверить стили/)
  assert.match(cardText, /Часть 3 — Обновить тесты/)
  assert.match(cardText, /Принята/)
  assert.match(cardText, /На проверке/)
  assert.match(cardText, /Возвращена в работу/)
  assert.match(cardText, /Сделано, если/)
  assert.match(cardText, /Кнопка видна на главном экране/)
  assert.match(cardText, /Агент части: Vega/)
  assert.match(cardText, /Проверяющий: Rill/)
  assert.match(cardText, /Возврат 1 из 2/)
  assert.match(cardText, /не хватило проверки на клавиатуру/)
  assert.match(cardText, /Сборщик разрешил конфликтов: 1/)

  const rows = findAll(card, (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-part'))
  assert.equal(rows.length, 3, 'one row per plan part')
  assert.deepEqual(rows.map((row) => row.props['data-status']), ['accepted', 'reviewing', 'rework'])
  const pills = findAll(card, (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-pill'))
  assert.deepEqual(pills.map((pill) => pill.props['data-tone']), ['ok', 'active', 'warn'], 'each part status paints its own tone')

  const roles = findAll(opened, (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-models__role'))
  assert.deepEqual(roles.map((node) => textOf(node).trim()), ['Планировщик', 'Агент части', 'Проверяющий', 'Сборщик'])

  const railRows = findAll(opened, (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-row'))
  assert.equal(railRows.length, 1)
  assert.match(textOf(railRows[0]), /Оркестратор · 1\/3 · Сборка/, 'the rail shows accepted parts instead of agent statuses')

  assert.ok(findByClass(opened, 'dsh-artel-changes') !== undefined, 'the review card stays available for an Orchestrator run')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('a half-finished merge disables apply but keeps discard available', async () => {
  const state = setup({
    scenario: { project: DEFAULT_PROJECT, runs: [ORCHESTRATOR_BLOCKED_RUN], changes: REVIEW_CHANGES },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const parts = findByClass(opened, 'dsh-artel-parts')
  assert.ok(parts !== undefined)
  assert.match(textOf(parts), /Сборка не завершена — применить нельзя\./)

  const card = findByClass(opened, 'dsh-artel-changes')
  assert.ok(card !== undefined, 'the review card is rendered for a failed run')
  assert.match(textOf(card), /Сборка не завершена — применить нельзя\./, 'the review card explains why apply is closed')

  const actions = findByClass(opened, 'dsh-artel-changes__actions')
  assert.ok(actions !== undefined)
  const applyButton = findButton(actions, 'Применить')
  const discardButton = findButton(actions, 'Отклонить')
  assert.ok(applyButton !== undefined)
  assert.ok(discardButton !== undefined)
  assert.equal(applyButton.props.disabled, true, 'apply is disabled while the merge is unresolved')
  assert.equal(discardButton.props.disabled, false, 'discard stays available')

  applyButton.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.doesNotMatch(textOf(findByClass(opened, 'dsh-artel-changes')), /Применить изменения\?/, 'apply never reaches its confirmation')
  assert.equal(state.realm.calls.filter((call) => call.pathname.endsWith('/apply')).length, 0)

  discardButton.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.match(textOf(findByClass(opened, 'dsh-artel-changes')), /Отклонить изменения\?/, 'discard keeps its confirmation')
  findButton(findByClass(opened, 'dsh-artel-changes__actions'), 'Отклонить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.match(textOf(findByClass(opened, 'dsh-artel-changes')), /Отклонено/)
  assert.equal(state.realm.calls.filter((call) => call.pathname.endsWith('/discard') && call.method === 'POST').length, 1)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

/* ------------------------------------------- auto-queue & factory (0.8.0) */

/** Minimal fetch Response stand-in for scenario.route handlers. */
function reply(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload) },
  }
}

function queueFixture(overrides = {}) {
  return {
    sessionId: 'sess-1',
    projectPath: DEFAULT_PROJECT.projectPath,
    autopilot: false,
    limit: 20,
    checkCommand: 'npm test',
    checkDisabled: false,
    checkGuessed: true,
    tasks: [
      {
        id: 'q-1',
        text: 'Добавь кнопку',
        title: 'Добавь кнопку',
        mode: 'solo',
        status: 'queued',
        runId: null,
        reason: null,
        questions: 0,
        fixes: 0,
        check: null,
        changeCount: 0,
        files: [],
        parkedBranch: null,
        createdAt: '2026-01-01T10:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      },
    ],
    counts: { total: 1, queued: 1, running: 0, passed: 0, parked: 0, skipped: 0, stopped: 0, done: 0, remaining: 1 },
    progress: { text: 'В очереди · 1' },
    events: [],
    results: null,
    lastVersion: null,
    retryAt: null,
    stopReason: null,
    ignoredVersions: [],
    ...overrides,
  }
}

const FACTORY_BOARD = {
  id: 'board-1',
  projectPath: DEFAULT_PROJECT.projectPath,
  name: 'artel-toy',
  enabled: true,
  paused: false,
  template: 'normal',
  models: { triage: null, work: null, tests: null, review: null },
  routes: ['solo', 'swarm', 'fusion', 'orchestrator'],
  limits: { workersPerTicket: 1, ticketsAtOnce: 1, ticketsPerDay: 20, allowApiEngine: true, allowLowSubscriptions: false },
  commands: { test: 'npm test', check: '', preview: '' },
  quirks: { appendTests: false },
  trackers: [],
  readiness: {
    ready: true,
    checks: [
      { id: 'git', label: 'git', ok: true, blocking: true },
      { id: 'commit', label: 'Первый коммит', ok: true, blocking: true },
      { id: 'engines', label: 'Движки', ok: true, blocking: true },
      { id: 'testCommand', label: 'Тесты', ok: true, blocking: false },
      { id: 'playwright', label: 'Playwright', ok: false, blocking: false, hint: 'Нет Playwright' },
    ],
  },
  counters: { day: '2026-01-01', started: 1, created: 2, merged: 0 },
  eventSeq: 3,
  events: [
    { seq: 3, at: '2026-01-01T10:05:00.000Z', kind: 'status', text: 'Фабрика включена.', stage: null, ticketId: null },
  ],
}

const FACTORY_TICKET = {
  id: 't-12',
  boardId: 'board-1',
  number: 12,
  title: 'Тёмная тема',
  text: 'Сделай тёмную тему и переключатель.',
  stage: 'working',
  waiting: null,
  spec: {
    summary: 'Добавить тёмную тему и переключатель в шапке.',
    criteria: ['Тема переключается', 'Выбор сохраняется между запусками'],
    assumptions: ['Тема по умолчанию — системная'],
    route: 'solo',
  },
  route: { mode: 'solo', requested: 'solo', notes: [] },
  check: { command: 'npm test', ok: true, output: '', reason: null },
  review: null,
  repairRound: 0,
  triageRunId: null,
  runId: 'run-f12',
  versions: [],
  branch: null,
  pr: null,
  sessionId: 'factory-board-1-t-12',
  source: null,
  attachments: [],
  events: [],
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:05:00.000Z',
}

const FACTORY_WAITING_TICKET = {
  ...FACTORY_TICKET,
  id: 't-13',
  number: 13,
  title: 'Сброс пароля',
  stage: 'waiting',
  waiting: { kind: 'triage-questions', questions: ['Какой канал для сброса: письмо или SMS?'] },
  spec: { summary: 'Добавить сброс пароля на почту.', criteria: ['Письмо приходит'], assumptions: [], route: 'solo' },
}

async function openArtel(state) {
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    await state.realm.renderer.flush()
  }
  return state.realm.renderer.tree()
}

test('all three dictionaries carry the auto-queue and factory strings', () => {
  const state = setup()
  const dictionaries = state.dictionaries['dsh-artel']
  assert.ok(dictionaries !== undefined)
  const english = Object.keys(dictionaries.en).sort()
  for (const locale of ['ru', 'zh']) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), english, locale + ' has every English key')
  }
  const queueAndFactory = english.filter((key) => key.startsWith('queue.') || key.startsWith('factory.'))
  assert.equal(queueAndFactory.length, 187, 'every queue and factory string is present')
  const expected = {
    en: {
      'queue.title': 'Waiting',
      'queue.autopilot': 'Auto-queue',
      'factory.title': 'Factory',
      'factory.column.checks': 'Checks',
      'factory.waiting.triageQuestions': 'Triage has questions',
      'factory.template.fast': 'Fast',
    },
    ru: {
      'queue.title': 'Ожидают',
      'queue.autopilot': 'Автоочередь',
      'queue.preflight': 'Перед запуском',
      'queue.results': 'Итоги автоочереди',
      'factory.title': 'Фабрика',
      'factory.column.incoming': 'Входящие',
      'factory.column.working': 'Работа',
      'factory.column.checks': 'Проверки',
      'factory.column.ready': 'Готово к PR',
      'factory.column.waiting': 'Ждёт вас',
      'factory.waiting.repairExhausted': 'Круги починки кончились',
      'factory.spec': 'Спецификация',
      'factory.criteria': 'Критерии',
    },
    zh: {
      'queue.title': '等待中',
      'queue.autopilot': '自动队列',
      'factory.title': '工厂',
      'factory.column.checks': '检查',
    },
  }
  for (const locale of Object.keys(expected)) {
    for (const key of Object.keys(expected[locale])) {
      assert.equal(dictionaries[locale][key], expected[locale][key], locale + ' has ' + key)
    }
  }
})

test('queue and factory view-model helpers are exposed on the debug bridge', () => {
  const realm = createRealm()
  const plugin = realm.load()
  plugin.apply(createCtx(realm).ctx)
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  assert.ok(debug.queueHelpers !== undefined, 'queue helpers are published')
  assert.ok(debug.factoryHelpers !== undefined, 'factory helpers are published')
  const ruT = (key) => (debug.dictionaries.ru[key] !== undefined ? debug.dictionaries.ru[key] : key)
  const enT = (key) => (debug.dictionaries.en[key] !== undefined ? debug.dictionaries.en[key] : key)

  assert.deepEqual(debug.queueHelpers.modes, ['solo', 'swarm', 'conductor', 'fusion'])
  const modeOptions = debug.queueHelpers.modeOptions(ruT)
  assert.deepEqual(modeOptions.map((option) => option.value), ['solo', 'swarm', 'conductor', 'fusion', 'orchestrator'])
  assert.equal(modeOptions.length, 5)
  assert.equal(modeOptions[4].label, 'Оркестратор')
  assert.equal(modeOptions[4].disabled, true, 'the Orchestrator is shown disabled in the queue picker')
  assert.equal(modeOptions[4].hint, 'Недоступен: пока не умеет стартовать с сохранённой версии.')
  assert.ok(modeOptions.slice(0, 4).every((option) => option.disabled !== true && option.hint === undefined))
  assert.equal(debug.queueHelpers.statusLabel(ruT, 'queued'), 'В очереди')
  assert.equal(debug.queueHelpers.statusLabel(ruT, 'passed'), 'Версия сохранена')
  assert.equal(debug.queueHelpers.statusLabel(ruT, 'bogus'), 'bogus')
  assert.equal(debug.queueHelpers.statusTone('running'), 'active')
  assert.equal(debug.queueHelpers.statusTone('passed'), 'ok')
  assert.equal(debug.queueHelpers.statusTone('parked'), 'error')
  assert.equal(debug.queueHelpers.statusTone('stopped'), 'warn')
  assert.equal(debug.queueHelpers.dotState('running'), 'ongoing')
  assert.equal(debug.queueHelpers.dotState('passed'), 'done')
  assert.equal(debug.queueHelpers.dotState('parked'), 'error')
  assert.equal(debug.queueHelpers.bytesLabel(2 * 1024 * 1024 * 1024), '2.0 GB')
  const meta = debug.queueHelpers.taskMeta(ruT, { status: 'parked', mode: 'solo', questions: 1, fixes: 2, reason: 'Проверка не прошла' })
  assert.match(meta, /Solo/)
  assert.match(meta, /Проверка не прошла/)

  assert.deepEqual(debug.factoryHelpers.columns, ['incoming', 'triage', 'working', 'checks', 'ready', 'waiting', 'done'])
  assert.deepEqual(debug.factoryHelpers.stageColumn, {
    incoming: 'incoming',
    triage: 'triage',
    working: 'working',
    tests: 'checks',
    check: 'checks',
    review: 'checks',
    ready: 'ready',
    waiting: 'waiting',
    done: 'done',
  })
  assert.deepEqual(debug.factoryHelpers.templates, ['normal', 'fast', 'strict'])
  assert.equal(debug.factoryHelpers.templateLabel(ruT, 'fast'), 'Быстрый')
  assert.match(debug.factoryHelpers.templateHint(ruT, 'fast'), /один круг починки/)
  assert.equal(debug.factoryHelpers.columnLabel(ruT, 'checks'), 'Проверки')
  assert.equal(debug.factoryHelpers.stageLabel(ruT, 'tests'), 'Тесты')
  assert.equal(debug.factoryHelpers.waitingLabel(ruT, 'plan'), 'План ждёт утверждения')
  assert.equal(debug.factoryHelpers.ticketColumn({ stage: 'tests' }), 'checks')
  assert.equal(debug.factoryHelpers.ticketColumn(FACTORY_WAITING_TICKET), 'waiting')
  assert.equal(debug.factoryHelpers.ticketColumn({ stage: 'ready' }), 'ready')
  assert.equal(debug.factoryHelpers.ticketNumber({ number: 48 }), '#48')
  assert.equal(debug.factoryHelpers.ticketNumber({}), '#–')
  assert.deepEqual(
    debug.factoryHelpers.criteria({
      spec: { criteria: ['Тема переключается', { text: 'Выбор сохраняется', met: null }] },
      review: { criteria: [{ text: 'Тема переключается', met: true }, { text: 'Выбор сохраняется', met: false }] },
    }),
    [{ text: 'Тема переключается', met: true }, { text: 'Выбор сохраняется', met: false }],
  )
  assert.equal(debug.factoryHelpers.selectionKey({ provider: 'test', model: 'fast' }), 'test/fast')
  assert.deepEqual(debug.factoryHelpers.selectionOfKey('test/fast'), { provider: 'test', model: 'fast' })
  assert.equal(typeof debug.factoryHelpers.clockLabel('2026-01-01T10:05:00.000Z'), 'string')
})

test('the new-session screen queues a task and flips «Автоочередь»', async () => {
  const current = { queue: queueFixture() }
  const autopilotCalls = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(current.queue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          const added = (body.texts ?? []).map((text, index) => ({
            ...queueFixture().tasks[0],
            id: 'q-new-' + index,
            text,
            title: text,
          }))
          current.queue = { ...current.queue, tasks: [...current.queue.tasks, ...added] }
          return reply({ queue: current.queue, added: added.length })
        }
        if (pathname === '/api/dsh-artel/queue/autopilot' && method === 'POST') {
          autopilotCalls.push(body)
          current.queue = { ...current.queue, autopilot: body.autopilot === true }
          return reply({ queue: current.queue })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  assert.ok(strip !== undefined, 'the hero shows the «Ожидают» strip')
  assert.equal(strip.props['data-variant'], 'hero')
  const stripText = textOf(strip)
  assert.match(stripText, /Ожидают/)
  assert.match(stripText, /Автоочередь/)
  assert.match(stripText, /В очереди · 1/)
  assert.match(stripText, /Добавь кнопку/)

  const toggle = findAll(strip, (node) => node.type === 'button' && node.props.role === 'switch')[0]
  assert.ok(toggle !== undefined, 'the auto-queue switch is rendered')
  assert.equal(toggle.props['aria-checked'], false)
  toggle.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.equal(autopilotCalls.length, 1, 'the switch reaches the Host')
  assert.equal(autopilotCalls[0].autopilot, true)
  assert.ok(findAll(opened, (node) => node.type === 'button' && node.props.role === 'switch')[0].props['aria-checked'], 'the switch reflects the new state')

  const input = findAll(opened, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-queue__input'))[0]
  assert.ok(input !== undefined, 'the add-task input is rendered')
  input.props.onChange({ target: { value: 'Почини тесты' } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-queue'), 'В очередь').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()
  const posted = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/queue' && call.method === 'POST')
  assert.ok(posted !== undefined, 'adding a task reached the Host')
  assert.deepEqual(posted.body.texts, ['Почини тесты'])
  assert.equal(posted.body.mode, 'solo')
  assert.equal(posted.body.sessionId, 'sess-1')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the queue mode picker shows the Orchestrator disabled and cannot choose it', async () => {
  const current = { queue: queueFixture() }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(current.queue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          const added = { ...queueFixture().tasks[0], id: 'q-new', text: body.task, title: body.task, mode: body.mode }
          current.queue = { ...current.queue, tasks: [...current.queue.tasks, added] }
          return reply({ queue: current.queue, added: 1 })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  assert.ok(strip !== undefined, 'the hero shows the «Ожидают» strip')
  assert.ok(findByClass(strip, 'dsh-artel-queue__add') !== undefined, 'the add-task row is rendered')
  const selectTrigger = () => findAll(findByClass(opened, 'dsh-artel-queue__add'), (node) => node.type === 'button'
    && String(node.props.className).split(/\s+/).includes('dsh-artel-select'))[0]
  const trigger = selectTrigger()
  assert.ok(trigger !== undefined, 'the queue mode picker is rendered')
  trigger.props.onClick()
  opened = await state.realm.renderer.flush()
  const menu = findByClass(opened, 'dsh-artel-menu')
  assert.ok(menu !== undefined, 'the mode picker opens')
  const options = findAll(menu, (node) => node.props?.role === 'option')
  assert.deepEqual(options.map((node) => node.props['data-value']), ['solo', 'swarm', 'conductor', 'fusion', 'orchestrator'])
  const orchestrator = options.find((node) => node.props['data-value'] === 'orchestrator')
  assert.equal(orchestrator.props['aria-disabled'], 'true')
  assert.equal(orchestrator.props['data-disabled'], 'true')
  assert.match(textOf(orchestrator), /Недоступен: пока не умеет стартовать с сохранённой версии/)

  // A click on the disabled entry is ignored; the menu stays open to explain itself.
  orchestrator.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.equal(selectTrigger().props['data-value'], 'solo', 'the disabled entry cannot be chosen')
  assert.ok(findByClass(opened, 'dsh-artel-menu') !== undefined, 'the menu stays open after the disabled click')

  // The keyboard model skips the disabled entry: End lands on the last runnable mode,
  // and ArrowDown there does not reach the Orchestrator either.
  selectTrigger().props.onKeyDown({ key: 'End', preventDefault() {} })
  opened = await state.realm.renderer.flush()
  const active = () => findAll(findByClass(opened, 'dsh-artel-menu'), (node) => node.props?.role === 'option' && node.props['data-active'] === 'true')
  assert.equal(active().length, 1)
  assert.equal(active()[0].props['data-value'], 'fusion')
  selectTrigger().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  opened = await state.realm.renderer.flush()
  assert.equal(active()[0].props['data-value'], 'fusion')

  // A runnable mode still closes the menu and reaches the add-task call.
  pickOption(opened, 'swarm')
  opened = await state.realm.renderer.flush()
  assert.equal(selectTrigger().props['data-value'], 'swarm')
  assert.equal(findByClass(opened, 'dsh-artel-menu'), undefined)
  const input = findAll(opened, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-queue__input'))[0]
  input.props.onChange({ target: { value: 'Проверь очередь' } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-queue'), 'В очередь').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const posted = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/queue' && call.method === 'POST')
  assert.ok(posted !== undefined, 'adding a task reached the Host')
  assert.equal(posted.body.mode, 'swarm')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('history marks auto-queue versions and the run header too', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [AUTOQUEUE_RUN], changes: [] } })
  const opened = await openArtel(state)
  const row = findByClass(opened, 'dsh-artel-row')
  assert.ok(row !== undefined, 'the history row is rendered')
  assert.match(textOf(row), /Автоочередь/)
  row.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const tree = await state.realm.renderer.flush()
  const head = findByClass(tree, 'dsh-artel-run__head')
  assert.ok(head !== undefined, 'the run header is rendered')
  assert.match(textOf(head), /Автоочередь/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('auto-queue results let the user open, rework or roll back a version', async () => {
  const resultsQueue = queueFixture({
    autopilot: false,
    tasks: [],
    counts: { total: 1, queued: 0, running: 0, passed: 1, parked: 0, skipped: 0, stopped: 0, done: 1, remaining: 0 },
    progress: { text: 'Автоочередь идёт · 1 из 1' },
    results: {
      at: '2026-01-01T10:00:00.000Z',
      stopReason: 'empty',
      stopText: 'Очередь пуста.',
      startedAt: '2026-01-01T09:00:00.000Z',
      limit: 20,
      passed: [{ taskId: 'q-1', title: 'Ночная задача', runId: 'run-auto', files: ['src/app.js'], changeCount: 1, check: { ok: true, command: 'npm test' } }],
      parked: [],
      notTaken: [],
      stats: { taken: 1, passed: 1, parked: 0 },
    },
  })
  const posts = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [AUTOQUEUE_RUN],
      changes: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(resultsQueue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          posts.push(body)
          return reply({ queue: resultsQueue, added: 1 })
        }
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const results = findByClass(opened, 'dsh-artel-queue__results')
  assert.ok(results !== undefined, 'the results card is rendered')
  assert.match(textOf(results), /Итоги автоочереди/)
  findButton(results, 'Доработать').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  assert.equal(posts.length, 1, 'rework adds a new task')
  assert.deepEqual(posts[0].texts, ['Доработать: Ночная задача'])
  assert.equal(posts[0].basePath, 'C:\\tmp\\copies\\run-auto')
  const tree = await state.realm.renderer.flush()
  const again = findByClass(tree, 'dsh-artel-queue__results')
  findButton(again, 'Откатить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const discarded = state.realm.calls.find((call) => call.method === 'POST' && call.pathname === '/api/dsh-artel/runs/run-auto/discard')
  assert.ok(discarded !== undefined, 'roll back discards the version run')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('unsaved versions open the queue pre-flight and get saved as versions', async () => {
  const blocked = {
    pendingVersions: [{ runId: 'run-review', title: 'Add a button', status: 'interrupted', changeCount: 2 }],
    check: { command: 'npm test', guessed: true, disabled: false },
    limit: 20,
    taskCount: 0,
    diskBytes: 2 * 1024 * 1024 * 1024,
    busy: false,
  }
  const calls = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [REVIEW_RUN],
      changes: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture({ tasks: [], counts: { total: 0, queued: 0, running: 0, passed: 0, parked: 0, skipped: 0, stopped: 0, done: 0, remaining: 0 }, progress: { text: 'В очереди · 0' } }))
        if (pathname === '/api/dsh-artel/queue/autopilot' && method === 'POST') {
          calls.push(body)
          if (body.decisions !== true) return reply({ queue: queueFixture({ autopilot: false }), blocked })
          return reply({ queue: queueFixture({ autopilot: true }) })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  assert.ok(strip !== undefined, 'the run page shows the queue strip')
  findAll(strip, (node) => node.type === 'button' && node.props.role === 'switch')[0].props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const preflight = findByClass(opened, 'dsh-artel-queue__preflight')
  assert.ok(preflight !== undefined, 'the pre-flight check opens before a night shift')
  const preflightText = textOf(preflight)
  assert.match(preflightText, /Перед запуском/)
  assert.match(preflightText, /Не сохранённые версии/)
  assert.match(preflightText, /Add a button/)
  assert.equal(findAll(preflight, (node) => node.type === 'button' && node.props['data-active'] === 'true').length, 0, 'no decision picked yet')

  findButton(preflight, 'Сохранить версией').props.onClick()
  opened = await state.realm.renderer.flush()
  const marked = findByClass(opened, 'dsh-artel-queue__preflight')
  assert.equal(findAll(marked, (node) => node.type === 'button' && node.props['data-active'] === 'true').length, 1, 'the selected version is marked to be saved')

  findButton(marked, 'Продолжить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()
  const decided = calls.find((body) => body.decisions === true)
  assert.ok(decided !== undefined, 'the pre-flight decision reached the Host')
  assert.deepEqual(decided.saveVersionRunIds, ['run-review'])
  assert.deepEqual(decided.postponeVersionRunIds, [])
  assert.equal(decided.checkCommand, 'npm test')
  assert.equal(decided.autopilot, true)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the factory board renders the columns and opens a ticket', async () => {
  const boards = [FACTORY_BOARD]
  const tickets = [FACTORY_TICKET, FACTORY_WAITING_TICKET]
  const settingsCalls = []
  const takeoverCalls = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards })
        if (pathname === '/api/dsh-artel/factory/board-1' && method === 'GET') return reply({ boards, board: FACTORY_BOARD, tickets })
        if (pathname === '/api/dsh-artel/factory/board-1/tickets/t-12' && method === 'GET') {
          return reply({
            ticket: FACTORY_TICKET,
            feed: { events: [{ seq: 1, at: '2026-01-01T10:04:00.000Z', kind: 'status', text: 'Агент правит тему.' }], cursor: 1 },
          })
        }
        if (pathname === '/api/dsh-artel/factory/board-1/tickets/t-12/takeover' && method === 'POST') {
          takeoverCalls.push(body)
          return reply({ ticket: { ...FACTORY_TICKET, stage: 'waiting', waiting: { kind: 'postponed', reason: 'Взято вручную: тикет снят с конвейера.' } } })
        }
        if (pathname === '/api/dsh-artel/factory/board-1/settings' && method === 'POST') {
          settingsCalls.push(body)
          return reply({ board: { ...FACTORY_BOARD, ...body } })
        }
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture())
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const factoryButton = findAll(opened, (node) => node.type === 'button' && String(node.props.className ?? '').includes('dsh-artel-rail__factory'))[0]
  assert.ok(factoryButton !== undefined, 'the rail has a factory entry')
  factoryButton.props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }

  const pane = findByClass(opened, 'dsh-artel-factory')
  assert.ok(pane !== undefined, 'the factory pane opens in the workspace')
  const paneText = textOf(pane)
  assert.match(paneText, /Фабрика/)
  assert.match(paneText, /Входящие/)
  assert.match(paneText, /Разбор/)
  assert.match(paneText, /Работа/)
  assert.match(paneText, /Проверки/)
  assert.match(paneText, /Готово к PR/)
  assert.match(paneText, /Ждёт вас/)
  const columns = findAll(pane, (node) => String(node.props.className ?? '').split(/\s+/).includes('dsh-artel-factory__column'))
  assert.equal(columns.length, 7, 'the app board collapses the checks stages into one column')
  const cards = findAll(pane, (node) => node.type === 'button' && String(node.props.className ?? '').split(/\s+/).includes('dsh-artel-factory__card'))
  assert.equal(cards.length, 2, 'one card per ticket')
  assert.match(textOf(cards[0]), /#12/)
  assert.match(textOf(cards[1]), /#13/)
  assert.match(textOf(cards[1]), /У разбора есть вопросы/)
  assert.match(paneText, /Фабрика включена\./, 'the board shows its event log')

  cards[0].props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }
  const detail = findByClass(opened, 'dsh-artel-factory__detail')
  assert.ok(detail !== undefined, 'a ticket opens its panel')
  const detailText = textOf(detail)
  assert.match(detailText, /Тёмная тема/)
  assert.match(detailText, /Спецификация/)
  assert.match(detailText, /Добавить тёмную тему и переключатель в шапке\./)
  assert.match(detailText, /Критерии/)
  assert.match(detailText, /Тема переключается/)
  assert.match(detailText, /Выбор сохраняется между запусками/)
  assert.match(detailText, /Тема по умолчанию — системная/)
  assert.match(detailText, /npm test/)
  assert.match(detailText, /Агент правит тему\./, 'the ticket feed is rendered')
  assert.ok(findButton(opened, 'Открыть сессию') !== undefined, 'the ticket offers its ordinary session')
  const takeOver = findButton(opened, 'Взять вручную')
  assert.ok(takeOver !== undefined, 'the ticket can be taken over manually')
  takeOver.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  assert.equal(takeoverCalls.length, 1, 'taking the ticket over reached the Host')
  opened = await state.realm.renderer.flush()

  findButton(opened, 'Назад к доске').props.onClick()
  for (let iteration = 0; iteration < 2; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }
  findButton(findByClass(opened, 'dsh-artel-factory'), 'Настройки').props.onClick()
  opened = await state.realm.renderer.flush()
  const settings = findByClass(opened, 'dsh-artel-factory__settings')
  assert.ok(settings !== undefined, 'the settings view opens')
  findButton(opened, 'Сохранить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const saved = settingsCalls[0]
  assert.ok(saved !== undefined, 'saving the board settings reached the Host')
  assert.equal(saved.template, 'normal')
  assert.equal(saved.enabled, true)
  assert.deepEqual(saved.routes, ['solo', 'swarm', 'fusion', 'orchestrator'])
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the issue import row is labelled and explains a failed import', async () => {
  const boards = [FACTORY_BOARD]
  const importCalls = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards })
        if (pathname === '/api/dsh-artel/factory/board-1' && method === 'GET') return reply({ boards, board: FACTORY_BOARD, tickets: [FACTORY_TICKET] })
        if (pathname === '/api/dsh-artel/factory/board-1/import' && method === 'POST') {
          importCalls.push(body)
          return reply({ error: 'GitHub CLI не найден: установите `gh` и выполните `gh auth login`.', code: 'factory/gh-missing' }, 400)
        }
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture())
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const factoryButton = findAll(opened, (node) => node.type === 'button' && String(node.props.className ?? '').includes('dsh-artel-rail__factory'))[0]
  factoryButton.props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }

  const pane = findByClass(opened, 'dsh-artel-factory')
  const importBlock = findByClass(pane, 'dsh-artel-factory__import')
  assert.ok(importBlock !== undefined, 'the import row is grouped into its own block')
  const importText = textOf(importBlock)
  assert.match(importText, /Из GitHub issue/, 'the row is titled')
  assert.match(importText, /#12/, 'the hint explains the bare number form')
  assert.match(importText, /owner\/repo#12/, 'the hint explains the qualified form')
  assert.match(importText, /gh/, 'the hint names the gh requirement')

  const input = findAll(importBlock, (node) => node.type === 'input')[0]
  assert.equal(input.props['aria-label'], 'Из GitHub issue', 'the input is labelled for accessibility')
  input.props.onChange({ target: { value: '#12' } })
  opened = await state.realm.renderer.flush()
  const button = findButton(findByClass(opened, 'dsh-artel-factory__import'), 'Импорт')
  assert.ok(button !== undefined)
  assert.equal(button.props.disabled, false, 'a filled reference enables the button')
  button.props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }

  assert.deepEqual(importCalls, [{ ref: '#12' }], 'the typed reference reached the Host')
  const alert = findByClass(opened, 'dsh-artel-factory__importError')
  assert.ok(alert !== undefined, 'a failed import shows an inline error')
  assert.equal(alert.props.role, 'alert')
  assert.equal(textOf(alert).trim(), 'GitHub CLI не найден: установите `gh` (https://cli.github.com) и выполните `gh auth login`.')
  assert.equal(findByClass(opened, 'dsh-artel-banner__text'), undefined, 'the inline error is not duplicated in the banner')
  const retryInput = findAll(findByClass(opened, 'dsh-artel-factory__import'), (node) => node.type === 'input')[0]
  retryInput.props.onChange({ target: { value: '#13' } })
  opened = await state.realm.renderer.flush()
  assert.equal(findByClass(opened, 'dsh-artel-factory__importError'), undefined, 'editing the reference hides the old error')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})
