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

const DEFAULT_PROJECT = { projectPath: 'C:\\work\\artel-toy', name: 'artel-toy', projectKey: 'c:\\work\\artel-toy' }
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

/* ------------------------------------------- post-apply install (0.9.0) */

const INSTALL_STEP = {
  id: 'step-1',
  index: 0,
  title: 'Install the runtime',
  command: 'python install/install.py',
  origin: 'manifest',
  status: 'idle',
  output: null,
  outputTruncated: false,
  exitCode: null,
  timedOut: false,
  startedAt: null,
  finishedAt: null,
}

/** The record the Host stores on an applied run (issue #9: DSH bundle + its installer). */
const INSTALL_RECORD = {
  detectedAt: 1700000000000,
  bundle: {
    name: '@local/pybrowser-mcp',
    version: '1.0.0',
    patch: 'cordis.patch.yml',
    installable: true,
    status: null,
    result: null,
    canInstall: true,
  },
  steps: [INSTALL_STEP],
  warnings: [],
}

const APPLIED_INSTALL_RUN = {
  ...DEFAULT_RUN,
  id: 'run-applied',
  mode: 'solo',
  status: 'applied',
  phase: 'Applied 3 files to your project.',
  changeCount: 3,
  install: INSTALL_RECORD,
}

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
    documentElement: { lang: 'ru' },
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
    // Issue #13: the panel reads the git verdict once when it opens.
    if (pathname === '/api/dsh-artel/health') {
      return json({ ok: true, version: '0.1.0', git: scenario.git ?? { ok: true, version: '2.43.0', minimum: '2.30.0', reason: null } })
    }
    if (pathname === '/api/dsh-artel/settings' && method === 'GET') {
      return json(scenario.settings ?? {
        language: null,
        available: [
          { id: 'en', nativeName: 'English' },
          { id: 'ru', nativeName: 'Русский' },
          { id: 'zh', nativeName: '中文' },
        ],
      })
    }
    if (pathname === '/api/dsh-artel/settings' && method === 'POST') {
      scenario.settings = { language: body?.language ?? null, available: scenario.settings?.available ?? [] }
      return json(scenario.settings)
    }
    // Issue #11: the project-chat index used by the rail block and the badge.
    if (pathname === '/api/dsh-artel/chats') return json({ chats: scenario.chats ?? [] })
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
    function patchRun(runId, patch) {
      const runs = scenario.runs ?? []
      scenario.runs = runs.map((entry) => entry.id === runId ? { ...entry, ...patch } : entry)
      return (scenario.runs.find((entry) => entry.id === runId)) ?? { ...DEFAULT_RUN, id: runId, ...patch }
    }
    const installStepMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/install\/steps\/(\d+)$/.exec(pathname)
    if (installStepMatch !== null && method === 'POST') {
      const runId = decodeURIComponent(installStepMatch[1])
      return json({ run: patchRun(runId, { install: scenario.installAfterStep ?? null }) })
    }
    const installBundleMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/install\/bundle$/.exec(pathname)
    if (installBundleMatch !== null && method === 'POST') {
      const runId = decodeURIComponent(installBundleMatch[1])
      return json({ run: patchRun(runId, { install: scenario.installAfterBundle ?? null }) })
    }
    const installMatch = /^\/api\/dsh-artel\/runs\/([^/]+)\/install$/.exec(pathname)
    if (installMatch !== null && method === 'GET') {
      const runId = decodeURIComponent(installMatch[1])
      const run = (scenario.runs ?? []).find((entry) => entry.id === runId) ?? DEFAULT_RUN
      const install = scenario.install !== undefined ? scenario.install : (run.install ?? null)
      return json({ install, run: { ...run, install } })
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
  assert.deepEqual(slotNames, ['conversation.input.left', 'sidebar.session.row.trailing'])
  const badgeEntry = state.slots.entries.find((candidate) => candidate.definition.name === 'sidebar.session.row.trailing')
  assert.ok(badgeEntry !== undefined, 'the sidebar chat-row badge is registered')
  assert.deepEqual(badgeEntry.definition, {
    name: 'sidebar.session.row.trailing',
    id: 'artel-chat-badge',
    order: 60,
    locale: 'dsh-artel',
  })
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
  assert.match(launcherCss, /\.dsh-artel-chats__title/, 'the rail paints the project-chat block')
  assert.match(launcherCss, /\.dsh-artel-badge \{/, 'the sidebar badge has its own pill')
  assert.match(launcherCss, /\.dsh-artel-row__count/, 'a chat with several runs shows its count')
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

test('project chat helpers group, pluralize and title rows', async () => {
  const realm = createRealm()
  const plugin = realm.load()
  plugin.apply(createCtx(realm).ctx)
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  realm.document.documentElement = { lang: 'ru' }
  await debug.language.init()
  const ru = debug.dictionaries.ru
  const t = (key) => (ru[key] !== undefined ? ru[key] : key)

  const chats = debug.normalizeChats({
    chats: [
      { sessionId: 'sess-b', title: 'B', projectKey: 'c:\\p', runCount: 2, lastRunId: 'run-b', status: 'running', updatedAt: 20 },
      { sessionId: 'sess-a', title: 'A', projectKey: 'c:\\p', runCount: 5, lastRunId: 'run-a', status: 'finished', updatedAt: 30 },
      { sessionId: '', title: 'broken' },
      { title: 'no session' },
    ],
  })
  assert.deepEqual(chats.map((chat) => chat.sessionId), ['sess-a', 'sess-b'], 'newest chat first, broken rows dropped')
  assert.equal(chats[0].runCount, 5)
  assert.equal(chats[1].lastRunId, 'run-b')

  assert.deepEqual(debug.chatsOfProject(chats, 'c:\\p').map((chat) => chat.sessionId), ['sess-a', 'sess-b'])
  assert.deepEqual(debug.chatsOfProject(chats, undefined), [], 'without a project key nothing from another project leaks in')
  assert.deepEqual(debug.chatsOfProject(chats, 'c:\\other'), [])

  assert.equal(debug.chatTitleOf({ title: 'Artel · Add a button' }), 'Artel · Add a button')
  assert.equal(debug.chatTitleOf({ lastTask: 'Add a button' }), 'Add a button')
  assert.equal(debug.chatTitleOf({ sessionId: 'session-42' }), 'session-42')

  assert.equal(debug.chatTasksLabel(1), '1 задача Артели')
  assert.equal(debug.chatTasksLabel(3), '3 задачи Артели')
  assert.equal(debug.chatTasksLabel(5), '5 задач Артели')
  assert.equal(debug.chatTasksLabel(11), '11 задач Артели')
  assert.equal(debug.chatTasksLabel(21), '21 задача Артели')
  assert.equal(debug.chatTasksLabel(22), '22 задачи Артели')
  assert.equal(debug.chatBadgeLabel(t, { runCount: 3, status: 'finished' }), '3 задачи Артели · последний статус: Готово')

  for (const locale of ['en', 'ru', 'zh']) {
    const table = debug.dictionaries[locale]
    for (const key of ['chats.title', 'chats.hint', 'chats.open', 'chats.badge']) {
      assert.equal(typeof table[key], 'string', locale + ' has ' + key)
      assert.notEqual(table[key], key, locale + ' translates ' + key)
    }
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      const key = 'chats.tasks.' + category
      assert.equal(typeof table[key], 'string', locale + ' has ' + key)
      assert.notEqual(table[key], key, locale + ' translates ' + key)
    }
  }
})

test('the sidebar badge marks only chats that own Artel runs', async () => {
  const state = setup({
    scenario: {
      chats: [
        { sessionId: 'sess-1', title: 'Artel · Add a button', projectKey: 'c:\\work\\artel-toy', runCount: 3, lastRunId: 'run-1', status: 'running', updatedAt: 300 },
        { sessionId: 'sess-2', title: 'Artel · Second task', projectKey: 'c:\\work\\artel-toy', runCount: 1, lastRunId: 'run-2', status: 'finished', updatedAt: 200 },
      ],
    },
  })
  const realm = state.realm
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  const t = state.ctx.locale.bind('dsh-artel')
  await realm.settle()
  await debug.refreshChatIndex(true)

  const badge = await realm.renderer.mount(debug.ArtelChatBadge, { sessionId: 'sess-1', t })
  assert.ok(badge !== null && badge !== undefined, 'a chat with runs gets the badge')
  assert.equal(badge.props.className, 'dsh-artel-badge')
  assert.equal(badge.props['data-chat-id'], 'sess-1')
  assert.equal(badge.props['data-status'], 'running')
  assert.equal(badge.props.title, '3 задачи Артели · последний статус: В работе')
  assert.equal(badge.props['aria-label'], badge.props.title)
  assert.match(textOf(findByClass(badge, 'dsh-artel-badge__count')), /\b3\b/)

  const plain = await realm.renderer.mount(debug.ArtelChatBadge, { sessionId: 'sess-9', t })
  assert.equal(plain, null, 'an ordinary chat keeps its row untouched')
  const noId = await realm.renderer.mount(debug.ArtelChatBadge, { t })
  assert.equal(noId, null)
})

test('the rail lists project chats and switches to the chosen one', async () => {
  const otherRun = {
    ...DEFAULT_RUN,
    id: 'run-2',
    sessionId: 'sess-2',
    task: 'Second task',
    status: 'finished',
    updatedAt: '2026-01-01T12:00:00.000Z',
  }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN, otherRun],
      chats: [
        { sessionId: 'sess-1', title: 'Artel · Add a button', projectKey: DEFAULT_PROJECT.projectKey, runCount: 1, lastRunId: 'run-1', status: 'running', updatedAt: 100 },
        { sessionId: 'sess-2', title: 'Artel · Second task', projectKey: DEFAULT_PROJECT.projectKey, runCount: 2, lastRunId: 'run-2', status: 'finished', updatedAt: 200 },
        { sessionId: 'sess-foreign', title: 'Other project', projectKey: 'c:\\work\\elsewhere', runCount: 1, lastRunId: 'run-x', status: 'running', updatedAt: 300 },
      ],
    },
  })
  const realm = state.realm
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  const opened = []
  debug.installSessionOpener({ openSession: (sessionId) => { opened.push(sessionId) } })

  const tree = await renderLauncher(state, { sessionCwd: DEFAULT_PROJECT.projectPath })
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await realm.settle()
  const view = await realm.renderer.flush()

  const block = findByClass(view, 'dsh-artel-chats')
  assert.ok(block !== undefined, 'the rail block lists chats of the open project')
  assert.match(textOf(findByClass(block, 'dsh-artel-chats__title')), /Чаты проекта · 2/)
  const rows = findAll(block, (node) => node.props?.className === 'dsh-artel-row dsh-artel-row--chat')
  assert.equal(rows.length, 2, 'a chat from another project is not offered')
  assert.deepEqual(rows.map((row) => row.props['data-chat-id']), ['sess-2', 'sess-1'], 'newest chat first')
  assert.equal(rows[0].props['data-active'], 'false')
  assert.equal(rows[1].props['data-active'], 'true', 'the open chat is marked')
  assert.match(textOf(rows[0]), /Artel · Second task/)
  assert.match(textOf(rows[0]), /Готово/)
  assert.match(textOf(findByClass(rows[0], 'dsh-artel-row__count')), /\b2\b/, 'a chat with two runs shows its count')

  rows[0].props.onClick()
  await realm.settle()
  await realm.settle()

  assert.deepEqual(opened, ['sess-2'], 'the host was asked to switch chats')
  assert.equal(realm.localStorage.getItem('dsh-artel:last-run:sess-2'), 'run-2', 'the chosen chat remembers its newest run')
  const target = debug.getStore('sess-2')
  assert.equal(target.getSnapshot().open, true, 'the panel is open in the chosen chat')
  assert.equal(target.getSnapshot().activeRunId, 'run-2')
  assert.equal(debug.getStore('sess-1').getSnapshot().open, false, 'the surface moves to the chosen chat instead of leaving two panels open')
  target.dispose()
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

test('the surface survives the host switching the active chat', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [] } })
  let tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  tree = await state.realm.renderer.flush()
  assert.ok(findByClass(tree, 'dsh-artel-surface') !== undefined)

  // The host re-creates the composer slot for the agent chat a run just created.
  tree = await renderLauncher(state, { sessionId: 'sess-2' })
  assert.ok(findByClass(tree, 'dsh-artel-surface') !== undefined, 'the open panel stays on the new chat')
  assert.equal(findByClass(tree, 'dsh-artel-launcher').props['aria-expanded'], true)

  findByClass(tree, 'dsh-artel-surface__back').props.onClick()
  await state.realm.renderer.flush()
  tree = state.realm.renderer.tree()
  assert.equal(findByClass(tree, 'dsh-artel-surface'), undefined, 'the header back button still closes it')
  assert.equal(findByClass(tree, 'dsh-artel-launcher').props['aria-expanded'], false)

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-2').dispose()
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
  assert.match(snap.changesError, /The branch conflicts with the project\./)
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

test('an applied bundle offers Install into DSH and reports the restart', async () => {
  const restart = {
    ...INSTALL_RECORD,
    bundle: {
      ...INSTALL_RECORD.bundle,
      status: 'restart-required',
      result: {
        status: 'restart-required',
        application: 'restart-required',
        restartReason: 'no-hmr',
        bundle: '@local/pybrowser-mcp',
        version: '1.0.0',
        errorCode: null,
        errorMessage: null,
        warnings: [],
        at: 1700000001000,
      },
    },
  }
  const state = setup({
    scenario: { project: DEFAULT_PROJECT, runs: [APPLIED_INSTALL_RUN], installAfterBundle: restart },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const card = findByClass(opened, 'dsh-artel-changes')
  assert.ok(card !== undefined, 'an applied run keeps the changes card')
  assert.match(textOf(card), /Применено/)
  const block = findByClass(opened, 'dsh-artel-install')
  assert.ok(block !== undefined, 'the install block is rendered under the applied plate')
  assert.match(textOf(block), /Этот проект — бандл DSH/)
  assert.match(textOf(block), /@local\/pybrowser-mcp/)
  assert.match(textOf(block), /python install\/install\.py/)
  assert.equal(
    state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-applied/install' && call.method === 'GET'),
    false,
    'a stored install record is not re-read',
  )

  findButton(block, 'Установить в DSH').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.ok(
    state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-applied/install/bundle' && call.method === 'POST'),
    'the button installs the project folder',
  )
  assert.match(textOf(findByClass(opened, 'dsh-artel-install')), /перезапустите DSH/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('install steps run one at a time and show their output', async () => {
  const done = {
    ...INSTALL_RECORD,
    steps: [{
      ...INSTALL_STEP,
      status: 'done',
      exitCode: 0,
      output: 'runtime installed to C:\\Users\\dev\\.pybrowser\\runtime',
      startedAt: 1700000000000,
      finishedAt: 1700000004000,
    }],
  }
  const state = setup({
    scenario: { project: DEFAULT_PROJECT, runs: [APPLIED_INSTALL_RUN], installAfterStep: done },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const block = findByClass(opened, 'dsh-artel-install')
  assert.ok(block !== undefined)
  assert.match(textOf(block), /Шаги установки/)
  const runButton = findButton(block, 'Запустить')
  assert.ok(runButton !== undefined, 'a declared step has its own Run button')
  runButton.props.onClick()
  opened = await state.realm.renderer.flush()
  const confirm = findByClass(opened, 'dsh-artel-install__confirm')
  assert.ok(confirm !== undefined, 'Run asks before it executes the command')
  assert.match(textOf(confirm), /Запустить эту команду в папке проекта\?/)
  assert.equal(
    state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-applied/install/steps/0' && call.method === 'POST'),
    false,
    'nothing runs before the confirmation',
  )

  findButton(confirm, 'Запустить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.ok(
    state.realm.calls.some((call) => call.pathname === '/api/dsh-artel/runs/run-applied/install/steps/0' && call.method === 'POST'),
    'the confirmed step runs exactly one command',
  )
  const finished = findByClass(opened, 'dsh-artel-install')
  assert.match(textOf(finished), /Готово/)
  assert.match(textOf(finished), /код 0/)
  const show = findButton(finished, 'Показать вывод')
  assert.ok(show !== undefined, 'a finished step keeps its output behind a toggle')
  show.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.match(textOf(findByClass(opened, 'dsh-artel-install__output')), /runtime installed to C:\\Users\\dev\\\.pybrowser\\runtime/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('an applied run from an older version asks the Host once for its install plan', async () => {
  const oldRun = { ...APPLIED_INSTALL_RUN, install: null }
  const state = setup({
    scenario: { project: DEFAULT_PROJECT, runs: [oldRun], install: INSTALL_RECORD },
  })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  let opened = await state.realm.renderer.flush()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()

  const installCalls = state.realm.calls.filter((call) => call.pathname === '/api/dsh-artel/runs/run-applied/install')
  assert.equal(installCalls.length, 1, 'the card asks for the install plan exactly once')
  assert.match(installCalls[0].url, /refresh=1/, 'the check re-reads the project')
  const block = findByClass(opened, 'dsh-artel-install')
  assert.ok(block !== undefined, 'the run that never stored a record still offers the install block')
  assert.match(textOf(block), /Установить в DSH/)
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
  assert.equal(state.report.version, '0.14.0', 'the diagnostics report carries the release version')
  assert.equal(state.realm.window.__DSH_ARTEL_DEBUG__.version, '0.14.0')
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

  // The panel starts inside the default provider: its only other route first,
  // then the default route repeated; judge and implementer use the default.
  const values = () => fusionChips().map((chip) => pickerTriggers(chip)[0].props['data-value'])
  assert.deepEqual(values(), ['test/slow', 'test/fast', 'test/fast', 'test/fast', 'test/fast'])

  // Picking another model for the first panel slot leaves the other four slots intact.
  pickerTriggers(fusionChips()[0])[0].props.onClick()
  await state.realm.renderer.flush()
  pickOption(state.realm.renderer.tree(), 'test/fast')
  await state.realm.renderer.flush()
  assert.deepEqual(values(), ['test/fast', 'test/fast', 'test/fast', 'test/fast', 'test/fast'])

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
      { provider: 'test', model: 'fast', reasoningEffort: 'low' },
      { provider: 'test', model: 'fast', reasoningEffort: 'low' },
      { provider: 'test', model: 'fast', reasoningEffort: 'low' },
    ],
    judge: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
    implementer: { provider: 'test', model: 'fast', reasoningEffort: 'low' },
  })
  assert.ok(findByClass(state.realm.renderer.tree(), 'dsh-artel-run') !== undefined, 'the run pane replaces the hero')

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the Fusion form seeds the panel from the default provider only', async () => {
  const models = {
    providers: [
      {
        id: 'deepseek-account',
        name: 'DeepSeek Account',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', efforts: [] },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', efforts: [] },
        ],
      },
      {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (New)', efforts: [] },
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', efforts: [{ id: 'low', label: 'Low' }, { id: 'max', label: 'Max' }], defaultEffort: 'max' },
          { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: [] },
        ],
      },
    ],
    default: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  }
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [], models } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const heroNow = () => findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  const radios = () => findAll(findByClass(heroNow(), 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  const chips = () => findAll(findByClass(heroNow(), 'dsh-artel-hero__fusion'), (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-hero__fusion-pick'))
  const values = () => chips().map((chip) => pickerTriggers(chip)[0].props['data-value'])
  const labels = () => chips().map((chip) => textOf(findByClass(chip, 'dsh-artel-select__value')).trim())

  radios()[3].props.onClick()
  await state.realm.renderer.flush()

  assert.deepEqual(values(), [
    'opencode-go/deepseek-v4-pro',
    'opencode-go/claude-haiku-5-5',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
  ], 'the panel stays inside the default provider and repeats the default route when it runs out')
  assert.deepEqual(labels(), [
    'DeepSeek V4 Pro (New)',
    'Claude Haiku 5.5',
    'DeepSeek V4.1 Flash',
    'DeepSeek V4.1 Flash',
    'DeepSeek V4.1 Flash',
  ], 'the chips show the names the providers declare')
  assert.deepEqual(
    [...new Set(values().map((value) => value.slice(0, value.indexOf('/'))))],
    ['opencode-go'],
    'the panel never borrows a provider that was not selected by the user',
  )

  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the Fusion panel repeats the default route instead of borrowing another provider', async () => {
  const models = {
    providers: [
      { id: 'dead', name: 'Dead provider', models: [{ id: 'alpha', name: 'Alpha', efforts: [] }] },
      {
        id: 'working',
        name: 'Working provider',
        models: [
          { id: 'one', name: 'One', efforts: [] },
          { id: 'two', name: 'Two', efforts: [] },
          { id: 'three', name: 'Three', efforts: [] },
        ],
      },
    ],
    default: { provider: 'dead', model: 'alpha' },
  }
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [], models } })
  const tree = await renderLauncher(state)
  findByClass(tree, 'dsh-artel-launcher').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  await state.realm.renderer.flush()

  const heroNow = () => findByClass(state.realm.renderer.tree(), 'dsh-artel-hero')
  const radios = () => findAll(findByClass(heroNow(), 'dsh-artel-segmented'), (node) => node.type === 'button' && node.props.role === 'radio')
  radios()[3].props.onClick()
  await state.realm.renderer.flush()
  const chips = () => findAll(findByClass(heroNow(), 'dsh-artel-hero__fusion'), (node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('dsh-artel-hero__fusion-pick'))
  assert.deepEqual(
    chips().map((chip) => pickerTriggers(chip)[0].props['data-value']),
    ['dead/alpha', 'dead/alpha', 'dead/alpha', 'dead/alpha', 'dead/alpha'],
    'with no sibling route the panel stays on the default instead of seeding untrusted providers',
  )

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
  const PLURAL = /\.(zero|one|two|few|many|other)$/
  const english = Object.keys(dictionaries.en).filter((key) => !PLURAL.test(key)).sort()
  for (const locale of ['ru', 'zh']) {
    assert.deepEqual(Object.keys(dictionaries[locale]).filter((key) => !PLURAL.test(key)).sort(), english, locale + ' has every English key')
  }
  const queueAndFactory = english.filter((key) => key.startsWith('queue.') || key.startsWith('factory.'))
  assert.equal(queueAndFactory.length, 423, 'every queue and factory string is present')
  const expected = {
    en: {
      'queue.title': 'Waiting',
      'queue.autopilot': 'Auto-queue',
      'queue.progress.auto': 'Auto-queue running · {done} of {total}',
      'queue.task.title': 'Task',
      'queue.branch.default': 'Branch {id}',
      'queue.stop.empty': 'The queue is empty.',
      'queue.event.started': 'Task “{title}” started',
      'queue.reason.login-lost': 'Could not continue: the engine is not authorized.',
      'factory.title': 'Factory',
      'factory.column.checks': 'Checks',
      'factory.column.review': 'Review',
      'factory.mode.orchestrator': 'Orchestrator',
      'factory.repair.rounds': 'Repair round {round} of {total}',
      'factory.waiting.triage-questions': 'Triage has questions',
      'factory.waiting.version-gone': 'The ticket version is no longer available.',
      'factory.event.ticket-added': 'Incoming: #{number} {title}',
      'factory.error.duplicate-ticket': 'This ticket is already open: #{number}.',
      'factory.template.fast': 'Fast',
    },
    ru: {
      'queue.title': 'Ожидают',
      'queue.autopilot': 'Автоочередь',
      'queue.preflight': 'Перед запуском',
      'queue.results': 'Итоги автоочереди',
      'queue.progress.auto': 'Автоочередь идёт · {done} из {total}',
      'queue.task.title': 'Задача',
      'queue.branch.default': 'Ветка {id}',
      'queue.stop.empty': 'Очередь пуста.',
      'queue.event.started': 'Работа: {title}',
      'queue.reason.check-failed': 'Проверка не прошла после {count} починок.',
      'factory.title': 'Фабрика',
      'factory.column.incoming': 'Входящие',
      'factory.column.working': 'Работа',
      'factory.column.tests': 'Тесты',
      'factory.column.checks': 'Проверки',
      'factory.column.ready': 'Готово к PR',
      'factory.column.waiting': 'Ждёт вас',
      'factory.mode.solo': 'Соло',
      'factory.repair.rounds': 'Круг починки {round} из {total}',
      'factory.waiting.repair-exhausted': 'Круги починки кончились',
      'factory.event.waiting.plan': 'Ждёт вас: согласование плана.',
      'factory.spec': 'Спецификация',
      'factory.criteria': 'Критерии',
    },
    zh: {
      'queue.title': '等待中',
      'queue.autopilot': '自动队列',
      'queue.progress.auto': '自动队列进行中 · {done}/{total}',
      'queue.task.title': '任务',
      'queue.stop.empty': '队列为空。',
      'queue.event.started': '任务「{title}」已开始',
      'factory.title': '工厂',
      'factory.column.checks': '检查',
      'factory.column.review': '评审',
      'factory.mode.fusion': '融合',
      'factory.repair.rounds': '修复轮次 {round}/{total}',
      'factory.error.unknown-ticket': '未找到工单。',
    },
  }
  for (const locale of Object.keys(expected)) {
    for (const key of Object.keys(expected[locale])) {
      assert.equal(dictionaries[locale][key], expected[locale][key], locale + ' has ' + key)
    }
  }
})

test('a loaded language store follows the DSH language and switches instantly', async () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru' }
  await debug.language.init()
  assert.equal(debug.language.get().effective, 'ru')
  assert.equal(debug.language.t('surface.title'), 'Артель')

  await debug.language.set('en')
  assert.equal(debug.language.get().effective, 'en')
  assert.equal(debug.language.t('surface.title'), 'Artel')
})

test('plural labels use Intl.PluralRules for each language', async () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru' }
  await debug.language.init()
  assert.match(debug.chatTasksLabel(1), /задача/)
  assert.match(debug.chatTasksLabel(3), /задачи/)
  assert.match(debug.chatTasksLabel(5), /задач/)
  await debug.language.set('zh')
  assert.match(debug.chatTasksLabel(3), /任务/)
})

test('dates follow the chosen language, not the browser', () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru' }
  assert.equal(debug.dateLocale(), 'ru')
})

test('describeError prefers a translated error code over the host message', async () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru' }
  await debug.language.init()
  const message = debug.describeError({ code: 'artel/not-found', message: 'Не найдено' })
  assert.notEqual(message, 'Не найдено')
  assert.match(message, /«Артели»/)
  assert.equal(
    debug.describeError({ code: 'artel/bad-language', message: 'Unsupported language', params: { language: 'de' } }),
    'Язык de недоступен.',
  )
})

test('describeError words an Artel code before the generic status fallbacks', async () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru' }
  await debug.language.init()
  // A 404 from an Artel route used to collapse into the generic "not found".
  assert.equal(
    debug.describeError({ code: 'artel/unknown-session', message: 'unknown session', status: 404 }),
    'Этот чат больше не существует.',
  )
  assert.equal(
    debug.describeError({ code: 'artel/queue-missing', message: 'No auto-queue for session s1.', status: 404 }),
    'Этой автоочереди больше нет.',
  )
  // A code without params still wins over the Host's English text.
  assert.equal(
    debug.describeError({ code: 'artel/branch-busy', message: 'The branch still has queued or running tasks.', status: 409 }),
    'В ветке ещё есть задачи в очереди или в работе.',
  )
  // With the component's `t` the same catalogue is used.
  const t = state.ctx.locale.bind('dsh-artel')
  assert.equal(
    debug.describeError({ code: 'artel/project-drift', message: 'The project has uncommitted changes.', status: 409 }, t),
    'В проекте есть незакоммиченные изменения — подтвердите расхождение, чтобы продолжить.',
  )
  // An unknown code keeps the previous fallback chain intact.
  assert.equal(debug.describeError({ code: 'artel/made-up', message: 'Host raw', status: 404 }), 'This Artel run no longer exists')
})

test('an unknown language falls back to the base language and then to English', async () => {
  const state = setup({ locale: 'ru' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  state.realm.document.documentElement = { lang: 'ru-RU' }
  await debug.language.init()
  assert.equal(debug.language.get().effective, 'ru')
  state.realm.document.documentElement = { lang: 'de-DE' }
  await debug.language.set(null)
  assert.equal(debug.language.get().effective, 'en')
})

test('localized prefers a host key over legacy text', () => {
  const state = setup({ locale: 'en' })
  const debug = state.realm.window.__DSH_ARTEL_DEBUG__
  const t = (key, params) => (key === 'feed.copy.preparing' ? `Preparing ${params.project}` : 'legacy')
  assert.equal(debug.localized(t, { key: 'feed.copy.preparing', params: { project: 'app' }, text: 'legacy' }), 'Preparing app')
})

test('the surface header offers a language switch', async () => {
  const state = setup({ locale: 'ru' })
  state.realm.document.documentElement = { lang: 'ru' }
  const surface = await openArtel(state)
  const picker = findByClass(surface, 'dsh-artel-lang')
  assert.ok(picker, 'language picker is rendered')
  assert.match(textOf(picker), /Русский/)
  assert.match(textOf(picker), /Как в DSH/)
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

  assert.deepEqual(debug.queueHelpers.modes, ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  const modeOptions = debug.queueHelpers.modeOptions(ruT)
  assert.deepEqual(modeOptions.map((option) => option.value), ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  assert.equal(modeOptions.length, 5)
  assert.equal(modeOptions[3].label, 'Оркестратор')
  assert.ok(modeOptions.every((option) => option.disabled !== true && option.hint === undefined), 'every queue mode is selectable')
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

  // Issue #13: readiness labels and hints are rendered by id, so the git binary
  // and the project repository read differently in the panel's language.
  assert.deepEqual(
    debug.factoryHelpers.readinessCheckText(ruT, { id: 'repo', ok: false, blocking: true, reason: 'no-git', label: 'Git repository', hint: 'Git is needed before the project repository can be checked.' }),
    { label: 'Git-репозиторий', hint: 'Без git репозиторий проекта не проверить.' },
  )
  assert.equal(debug.factoryHelpers.readinessCheckText(ruT, { id: 'commit', ok: true, label: 'First commit', hint: 'Make at least one commit.' }).hint, null)
  assert.equal(debug.factoryHelpers.readinessCheckText(ruT, { id: 'commit', ok: false, label: 'First commit', hint: 'Make at least one commit.' }).hint, 'Сделайте хотя бы один коммит: «Фабрика» сравнивает с ним.')
  assert.equal(debug.factoryHelpers.readinessCheckText(ruT, { id: 'custom', ok: false, label: 'Custom', hint: 'Server hint' }).hint, 'Server hint', 'an unknown check keeps the server wording')
  assert.match(debug.factoryHelpers.readinessCheckText(ruT, { id: 'git', ok: false, reason: 'old', found: '2.20.0', label: 'Git', hint: 'Upgrade Git.' }).hint, /2\.20\.0/)
})

test('a missing git is explained in the panel language and can be re-checked (issue #13)', async () => {
  const state = setup({ scenario: { git: { ok: false, version: '2.20.0', minimum: '2.30.0', reason: 'old' } } })
  const realm = state.realm
  const debug = realm.window.__DSH_ARTEL_DEBUG__
  const t = state.ctx.locale.bind('dsh-artel')
  const rechecked = []
  const store = { loadGit: async (options) => { rechecked.push(options) } }

  const banner = await realm.renderer.mount(debug.GitBanner, {
    t,
    store,
    snap: { git: { ok: false, version: '2.20.0', minimum: '2.30.0', reason: 'old' }, gitLoading: false },
  })
  assert.equal(banner.props['data-git-reason'], 'old')
  assert.equal(textOf(findByClass(banner, 'dsh-artel-banner__title')).trim(), 'Git не готов')
  const text = textOf(findByClass(banner, 'dsh-artel-banner__text'))
  assert.match(text, /2\.20\.0/)
  assert.match(text, /2\.30\.0/)
  assert.equal(findByClass(banner, 'dsh-artel-banner__link').props.href, 'https://git-scm.com/downloads')
  findByClass(banner, 'dsh-artel-btn').props.onClick()
  await realm.settle()
  assert.deepEqual(rechecked, [{ silent: false }], 'the recheck button asks the Host again')

  assert.equal(await realm.renderer.mount(debug.GitBanner, { t, store, snap: { git: { ok: true, version: '2.43.0', reason: null } } }), null, 'a usable git paints no banner')
  assert.equal(await realm.renderer.mount(debug.GitBanner, { t, store, snap: { git: null } }), null, 'before the health answer nothing is claimed')

  // The same failure reaches the user through the store's error banner when a
  // queue action fails, so describeError words it instead of the Host's English.
  assert.equal(debug.describeError({ code: 'artel/git-missing', message: 'Artel needs git', details: { reason: 'missing' } }, t), '«Артели» нужен Git (2.30.0 или новее): установите его и перезапустите сессию.')
  assert.equal(debug.describeError({ code: 'artel/git-missing', details: { reason: 'old', found: '2.20.0', minimum: '2.30.0' } }, t), '«Артели» нужен Git 2.30.0 или новее, а на этой машине 2.20.0. Обновите Git и перезапустите сессию.')
  assert.equal(debug.describeError({ code: 'artel/git-missing', details: { reason: 'unreadable' } }, t), 'Не удалось прочитать версию git. Проверьте «git --version» в терминале и перезапустите сессию.')

  // The store reads the verdict from the Host and publishes it for the banner.
  const artelStore = debug.createArtelStore('sess-1', t)
  const git = await artelStore.loadGit({ silent: true })
  assert.equal(git.reason, 'old')
  assert.equal(artelStore.getSnapshot().git.reason, 'old')
  assert.equal(artelStore.getSnapshot().gitLoaded, true)
  assert.equal(artelStore.getSnapshot().gitLoading, false)
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

test('the queue picker offers the Orchestrator and queues it', async () => {
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
  assert.ok(findByClass(opened, 'dsh-artel-queue') !== undefined, 'the hero shows the «Ожидают» strip')
  const selectTrigger = () => findAll(findByClass(opened, 'dsh-artel-queue__add'), (node) => node.type === 'button'
    && String(node.props.className).split(/\s+/).includes('dsh-artel-select'))[0]
  selectTrigger().props.onClick()
  opened = await state.realm.renderer.flush()
  const menu = findByClass(opened, 'dsh-artel-menu')
  assert.ok(menu !== undefined, 'the mode picker opens')
  const options = findAll(menu, (node) => node.props?.role === 'option')
  assert.deepEqual(options.map((node) => node.props['data-value']), ['solo', 'swarm', 'conductor', 'orchestrator', 'fusion'])
  assert.ok(options.every((node) => node.props['aria-disabled'] !== 'true' && node.props['data-disabled'] !== 'true'), 'all five modes are selectable')
  assert.match(textOf(menu), /Оркестратор/)

  pickOption(opened, 'orchestrator')
  opened = await state.realm.renderer.flush()
  assert.equal(selectTrigger().props['data-value'], 'orchestrator')
  assert.equal(findByClass(opened, 'dsh-artel-menu'), undefined)

  const input = findAll(opened, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-queue__input'))[0]
  input.props.onChange({ target: { value: 'Собери релиз' } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-queue'), 'В очередь').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  const posted = state.realm.calls.find((call) => call.pathname === '/api/dsh-artel/queue' && call.method === 'POST')
  assert.ok(posted !== undefined, 'adding a task reached the Host')
  assert.equal(posted.body.mode, 'orchestrator')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('branch actions load branch state and keep error details for the panel', async () => {
  const branches = {
    queue: { sessionId: 'sess-1' },
    project: { head: 'a'.repeat(40), repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b-1',
    branches: [{ id: 'b-1', name: 'Night', ref: 'refs/heads/artel/b-1', baseCommit: 'a'.repeat(40), tipCommit: null }],
  }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture())
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') return reply(branches)
        if (pathname === '/api/dsh-artel/queue/branches/b-1/apply' && method === 'POST') {
          return reply({ error: 'The project has uncommitted changes.', code: 'artel/project-drift', details: { drift: { dirty: true, files: ['src/app.js'] } } }, 409)
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const store = state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1')
  assert.equal(store.getSnapshot().queueBranches, null)
  assert.equal(store.getSnapshot().queueBranchError, null)

  const loaded = await store.loadQueueBranches()
  assert.equal(loaded.currentBranchId, 'b-1')
  assert.equal(store.getSnapshot().queueBranches.currentBranchId, 'b-1', 'branch state lands in the snapshot')

  const applied = await store.applyBranch('b-1', {})
  assert.equal(applied, null)
  assert.equal(store.getSnapshot().queueBranchError.code, 'artel/project-drift')
  assert.deepEqual(store.getSnapshot().queueBranchError.details.drift.files, ['src/app.js'])
  assert.match(store.getSnapshot().queueBranchError.text, /незакоммиченные изменения/)
  store.dispose()
})

test('the store exports, reverts and maintains queue branches', async () => {
  const base = 'a'.repeat(40)
  const branches = [
    { id: 'b-1', name: 'One', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: 'c'.repeat(40) },
    { id: 'b-2', name: 'Two', ref: 'refs/heads/artel/b-2', baseCommit: base, tipCommit: null },
  ]
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b-1',
    branches,
  }
  const branchState = { queue: branchQueue, project: branchQueue.project, currentBranchId: 'b-1', branches }
  const maintenance = {
    before: { objects: 4, sizeBytes: 8192, sizeText: '8 KB' },
    after: { objects: 2, sizeBytes: 4096, sizeText: '4 KB' },
    freedBytes: 4096,
  }
  const posted = []
  let branchLoads = 0
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          posted.push({ kind: 'add', body })
          return reply({ queue: branchQueue, added: 1 })
        }
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          branchLoads += 1
          return reply(branchState)
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/export' && method === 'POST') {
          posted.push({ kind: 'export', body })
          return reply({ queue: branchQueue, exported: { target: body.target ?? 'refs/heads/artel/b-1', commit: 'c'.repeat(40), at: 1 } })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/revert' && method === 'POST') {
          posted.push({ kind: 'revert', body })
          return reply({ queue: branchQueue, reverted: { branchId: 'b-1', branchName: 'One', commit: 'd'.repeat(40), undone: 'c'.repeat(40) } })
        }
        if (pathname === '/api/dsh-artel/queue/maintenance' && method === 'POST') {
          posted.push({ kind: 'maintenance', body })
          return reply(maintenance)
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  await openArtel(state)
  const store = state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1')
  assert.equal(store.getSnapshot().branchMaintenance, null, 'maintenance stats start empty')

  assert.equal(await store.addQueueTasks({ task: 'Проверь ветку', branchId: 'b-2' }), 1)
  const withBranch = posted.filter((entry) => entry.kind === 'add')
  assert.equal(withBranch.length, 1)
  assert.equal(withBranch[0].body.branchId, 'b-2', 'the chosen branch travels with the task')

  await store.addQueueTasks({ task: 'Без ветки' })
  const withoutBranch = posted.filter((entry) => entry.kind === 'add')[1]
  assert.equal(Object.prototype.hasOwnProperty.call(withoutBranch.body, 'branchId'), false, 'the current branch adds no branchId key')

  const loadsBeforeExport = branchLoads
  const exported = await store.exportBranch('b-1')
  assert.deepEqual(posted.find((entry) => entry.kind === 'export').body, { sessionId: 'sess-1' }, 'export without a target sends only the session')
  assert.ok(exported?.exported !== undefined, 'export returns the host payload')
  assert.equal(branchLoads, loadsBeforeExport + 1, 'export reloads the branch list')

  const targeted = await store.exportBranch('b-1', 'refs/heads/artel/custom')
  assert.equal(posted.filter((entry) => entry.kind === 'export')[1].body.target, 'refs/heads/artel/custom')
  assert.ok(targeted !== null)

  const loadsBeforeRevert = branchLoads
  assert.ok(await store.revertBranch('b-1') !== null)
  assert.deepEqual(posted.find((entry) => entry.kind === 'revert').body, { sessionId: 'sess-1' })
  assert.equal(branchLoads, loadsBeforeRevert + 1, 'revert reloads the branch list')

  const loadsBeforeMaintenance = branchLoads
  const stats = await store.maintainBranches()
  assert.deepEqual(stats, maintenance)
  assert.deepEqual(posted.find((entry) => entry.kind === 'maintenance').body, { sessionId: 'sess-1' })
  assert.deepEqual(store.getSnapshot().branchMaintenance, maintenance, 'maintenance stats land in the snapshot')
  assert.equal(branchLoads, loadsBeforeMaintenance + 1, 'maintenance reloads the branch list')
  store.dispose()
})

test('the add row picks a branch for a new queue task', async () => {
  const base = 'a'.repeat(40)
  const branches = [
    { id: 'b1', name: 'One', ref: 'refs/heads/artel/b1', baseCommit: base, tipCommit: null },
    { id: 'b2', name: 'Two', ref: 'refs/heads/artel/b2', baseCommit: base, tipCommit: null },
  ]
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b1',
    branches,
  }
  const branchState = { queue: branchQueue, project: branchQueue.project, currentBranchId: 'b1', branches }
  const posts = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue' && method === 'POST') {
          posts.push(body)
          return reply({ queue: branchQueue, added: 1 })
        }
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') return reply(branchState)
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const picker = () => findAll(findByClass(opened, 'dsh-artel-queue__add'), (node) => node.type === 'select')[0]
  const pickerNode = picker()
  assert.ok(pickerNode !== undefined, 'a branch queue with two branches offers the branch picker')
  assert.match(String(pickerNode.props.className), /dsh-artel-queue__branchPick/)
  assert.equal(pickerNode.props['aria-label'], 'Ветка')
  const options = findAll(pickerNode, (node) => node.type === 'option')
  assert.deepEqual(options.map((node) => node.props.value), ['', 'b1', 'b2'], 'the current branch comes first')
  assert.match(textOf(options[0]), /Текущая ветка/)
  assert.deepEqual(options.slice(1).map((node) => textOf(node).trim()), ['One', 'Two'])
  assert.equal(pickerNode.props.value, '', 'the current branch is the default')

  picker().props.onChange({ target: { value: 'b2' } })
  opened = await state.realm.renderer.flush()
  assert.equal(picker().props.value, 'b2', 'the picker keeps the chosen branch')

  const input = findAll(opened, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-queue__input'))[0]
  input.props.onChange({ target: { value: 'Проверь ветку два' } })
  opened = await state.realm.renderer.flush()
  findButton(findByClass(opened, 'dsh-artel-queue'), 'В очередь').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  assert.equal(posts.length, 1, 'adding a task reached the Host')
  assert.deepEqual(posts[0].texts, ['Проверь ветку два'])
  assert.equal(posts[0].branchId, 'b2', 'the chosen branch is posted with the task')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the queue head shows the current branch and opens the branch panel', async () => {
  const base = 'a'.repeat(40)
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: false, files: [] } },
    currentBranchId: 'b-1',
    branches: [
      { id: 'b-1', name: 'Ночная', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: 'c'.repeat(40) },
      { id: 'b-2', name: 'Дневная', ref: 'refs/heads/artel/b-2', baseCommit: base, tipCommit: null },
    ],
  }
  const commits = { commits: [
    { commit: 'c'.repeat(40), parents: [base], subject: 'Первая правка', date: '2026-11-21T03:00:00Z', files: 1, changeCount: 1 },
    { commit: 'd'.repeat(40), parents: ['c'.repeat(40)], subject: 'Вторая правка', date: '2026-11-21T04:00:00Z', files: 2, changeCount: 2 },
  ] }
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          return reply({ queue: branchQueue, project: branchQueue.project, currentBranchId: 'b-1', branches: branchQueue.branches })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/commits' && method === 'GET') return reply(commits)
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  const chip = findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))[0]
  assert.ok(chip !== undefined, 'a branch queue shows the current-branch chip')
  assert.match(textOf(chip), /Текущая ветка/)
  assert.match(textOf(chip), /Ночная/)

  chip.props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  const modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.ok(modal !== undefined, 'the chip opens the branch panel')
  assert.match(textOf(modal), /Дневная/)
  assert.match(textOf(modal), /Коммиты: 2/)

  findAll(modal, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-branchModal__apply'))[0].props.onClick()
  opened = await state.realm.renderer.flush()
  const commitList = findByClass(opened, 'dsh-artel-branchModal__commits')
  assert.ok(commitList !== undefined, 'the apply dialog lists the commits')
  assert.match(textOf(commitList), /Первая правка/)
  assert.match(textOf(commitList), /Вторая правка/)
  assert.match(textOf(commitList), /ccccccc/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the branch apply dialog sends the checked commits and the drift confirmation', async () => {
  const base = 'a'.repeat(40)
  const commitsList = [
    { commit: '1'.repeat(40), parents: [base], subject: 'Первая правка', date: '2026-11-21T01:00:00Z', files: 1, changeCount: 1 },
    { commit: '2'.repeat(40), parents: ['1'.repeat(40)], subject: 'Вторая правка', date: '2026-11-21T02:00:00Z', files: 1, changeCount: 1 },
    { commit: '3'.repeat(40), parents: ['2'.repeat(40)], subject: 'Третья правка', date: '2026-11-21T03:00:00Z', files: 1, changeCount: 1 },
  ]
  const branchQueue = {
    ...queueFixture(),
    model: 'branches',
    project: { head: base, repoDir: 'C:\\state\\repos\\key.git', drift: { dirty: true, files: ['src/app.js'] } },
    currentBranchId: 'b-1',
    branches: [{ id: 'b-1', name: 'Ночная', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: '3'.repeat(40) }],
  }
  const posts = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchQueue)
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          return reply({ queue: branchQueue, project: branchQueue.project, currentBranchId: 'b-1', branches: branchQueue.branches })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-1/commits' && method === 'GET') return reply({ commits: commitsList })
        if (pathname === '/api/dsh-artel/queue/branches/b-1/apply' && method === 'POST') {
          posts.push(body)
          if (posts.length === 1) {
            return reply({ error: 'The project has uncommitted changes.', code: 'artel/project-drift', details: { drift: { dirty: true, files: ['src/app.js'] } } }, 409)
          }
          return reply({ queue: { ...branchQueue, project: { ...branchQueue.project, drift: { dirty: false, files: [] } } } })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))[0].props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  const modal = findByClass(opened, 'dsh-artel-branchModal')
  findAll(modal, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-branchModal__apply'))[0].props.onClick()
  opened = await state.realm.renderer.flush()

  const commitList = findByClass(opened, 'dsh-artel-branchModal__commits')
  const boxes = findAll(commitList, (node) => node.type === 'input' && node.props?.type === 'checkbox')
  assert.equal(boxes.length, 3, 'the apply dialog lists every commit of the branch')
  assert.equal(boxes[1].props.checked, true, 'every commit starts checked')
  boxes[1].props.onChange({ target: { checked: false } })
  opened = await state.realm.renderer.flush()

  findAll(opened, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-branchModal__applyGo'))[0].props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.equal(posts.length, 1, 'the first apply reached the Host')
  assert.deepEqual(posts[0].commitIds, ['1'.repeat(40), '3'.repeat(40)], 'only the checked commits travel')
  assert.equal(posts[0].confirmDrift, false)
  assert.equal(posts[0].force, false)
  const errorPanel = findByClass(opened, 'dsh-artel-branchModal__error')
  assert.ok(errorPanel !== undefined, 'a drift refusal is explained in the panel')
  assert.match(textOf(errorPanel), /src\/app\.js/)

  findButton(findByClass(opened, 'dsh-artel-branchModal'), 'Всё равно применить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  assert.equal(posts.length, 2, 'the second click applies after confirming the drift')
  assert.equal(posts[1].confirmDrift, true)
  assert.deepEqual(posts[1].commitIds, ['1'.repeat(40), '3'.repeat(40)])
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the branch panel exports, reverts, cleans up and reworks from the applied result', async () => {
  const base = 'a'.repeat(40)
  const appliedHead = 'b'.repeat(40)
  const posts = { exported: [], reverted: [], maintained: [], created: [] }
  let exported = null
  let reverted = false
  const makeQueue = () => ({
    ...queueFixture(),
    model: 'branches',
    project: {
      head: appliedHead,
      repoDir: 'C:\\state\\repos\\key.git',
      drift: { dirty: false, files: [] },
      applied: { branchId: 'b-2', afterHead: appliedHead },
    },
    currentBranchId: 'b-1',
    branches: [
      { id: 'b-1', name: 'Ночная', ref: 'refs/heads/artel/b-1', baseCommit: base, tipCommit: 'c'.repeat(40) },
      {
        id: 'b-2',
        name: 'Дневная',
        ref: 'refs/heads/artel/b-2',
        baseCommit: base,
        tipCommit: appliedHead,
        ...(reverted ? { revertedAt: '2026-11-21T06:00:00Z' } : { appliedAt: '2026-11-21T05:00:00Z' }),
        ...(exported === null ? {} : { exported: { target: exported, at: '2026-11-21T06:00:00Z' } }),
      },
    ],
    repo: { objects: 12, sizeBytes: 1258291, sizeText: '1.2 MiB' },
  })
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        const queue = makeQueue()
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queue)
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'GET') {
          return reply({ queue, project: queue.project, currentBranchId: 'b-1', branches: queue.branches, repo: queue.repo })
        }
        if (/^\/api\/dsh-artel\/queue\/branches\/[^/]+\/commits$/.test(pathname) && method === 'GET') return reply({ commits: [] })
        if (pathname === '/api/dsh-artel/queue/branches/b-2/export' && method === 'POST') {
          posts.exported.push(body)
          exported = body.target ?? 'refs/heads/artel/b-2'
          return reply({ queue: makeQueue() })
        }
        if (pathname === '/api/dsh-artel/queue/branches/b-2/revert' && method === 'POST') {
          posts.reverted.push(body)
          reverted = true
          return reply({ queue: makeQueue() })
        }
        if (pathname === '/api/dsh-artel/queue/maintenance' && method === 'POST') {
          posts.maintained.push(body)
          return reply({ before: { objects: 12, sizeBytes: 1258291 }, after: { objects: 4, sizeBytes: 209715 }, freedBytes: 1048576 })
        }
        if (pathname === '/api/dsh-artel/queue/branches' && method === 'POST') {
          posts.created.push(body)
          return reply({ queue: makeQueue() })
        }
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  let opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))[0].props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  let modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.ok(modal !== undefined, 'the branch panel opens')
  assert.match(textOf(modal), /Размер хранилища: 1\.2 MiB/, 'the footer shows the repository size')
  const glyphs = findAll(modal, (node) => node.type === 'span' && String(node.props.className).includes('dsh-artel-branchModal__graph')).map((node) => textOf(node).trim())
  assert.deepEqual(glyphs, ['●', '◇'], 'the graph marks the current branch and the applied tip')
  assert.match(textOf(modal), /Основа aaaaaaa/, 'the branch row shows the short base commit')
  assert.match(textOf(modal), /bbbbbbb/, 'the branch row shows the short tip commit')

  findButton(modal, 'Дневная').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.ok(findButton(modal, 'Экспортировать в git') !== undefined, 'the selected branch can be exported')
  assert.ok(findButton(modal, 'Отменить применение') !== undefined, 'the applied branch can be reverted')
  assert.ok(findButton(modal, 'Доработать с этого результата') !== undefined, 'the applied result can be reworked')

  findButton(modal, 'Экспортировать в git').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.equal(posts.exported.length, 1, 'the export reached the Host')
  assert.deepEqual(posts.exported[0], { sessionId: 'sess-1' }, 'an empty target means automatic')
  assert.match(textOf(modal), /Экспортировано в: refs\/heads\/artel\/b-2/, 'the panel names the exported ref')

  const targetInput = findAll(modal, (node) => node.type === 'input' && String(node.props.className).includes('dsh-artel-branchModal__target'))[0]
  assert.ok(targetInput !== undefined, 'the export target input is in the panel')
  targetInput.props.onChange({ target: { value: 'refs/heads/artel/custom' } })
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  findButton(modal, 'Экспортировать в git').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.equal(posts.exported.length, 2, 'the custom export reached the Host')
  assert.deepEqual(posts.exported[1], { sessionId: 'sess-1', target: 'refs/heads/artel/custom' }, 'the typed target travels')
  assert.match(textOf(modal), /Экспортировано в: refs\/heads\/artel\/custom/)

  findButton(modal, 'Отменить применение').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.equal(posts.reverted.length, 1, 'the revert reached the Host')
  assert.deepEqual(posts.reverted[0], { sessionId: 'sess-1' })
  assert.match(textOf(modal), /отменена/, 'the reverted branch is marked')

  findButton(modal, 'Почистить').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  modal = findByClass(opened, 'dsh-artel-branchModal')
  assert.equal(posts.maintained.length, 1, 'the cleanup reached the Host')
  assert.deepEqual(posts.maintained[0], { sessionId: 'sess-1' })
  assert.match(textOf(modal), /Хранилище почищено: 1 MB/, 'the footer reports the freed bytes')

  findButton(modal, 'Доработать с этого результата').props.onClick()
  await state.realm.settle()
  await state.realm.settle()
  opened = await state.realm.renderer.flush()
  assert.equal(posts.created.length, 1, 'the rework branch reached the Host')
  assert.equal(posts.created[0].fromCommit, appliedHead, 'the rework starts at the applied head')
  assert.equal(posts.created[0].switchTo, true, 'the rework switches to the new branch')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('a legacy queue keeps the versions path and says so', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(queueFixture())
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  const chip = findAll(strip, (node) => node.type === 'button' && String(node.props.className).includes('dsh-artel-queue__branchChip'))
  assert.equal(chip.length, 0, 'a legacy queue shows no branch chip')
  assert.match(textOf(strip), /Старая очередь/)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('a passed branch result shows its short commit and the apply shortcut', async () => {
  const commit = 'f'.repeat(40)
  const branchResults = queueFixture({
    results: {
      at: null,
      stopReason: 'empty',
      stopText: 'Очередь пуста.',
      startedAt: '2026-01-01T09:00:00.000Z',
      limit: 20,
      passed: [{ taskId: 'q-1', title: 'Ночная задача', runId: 'run-auto', files: ['src/app.js'], changeCount: 1, check: { ok: true, command: 'npm test' }, commit }],
      parked: [],
      notTaken: [],
    },
  })
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(branchResults)
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const results = findByClass(opened, 'dsh-artel-queue__results')
  assert.ok(results !== undefined, 'the queue results card is rendered')
  assert.match(textOf(results), /fffffff/, 'a passed branch result shows its short commit')
  assert.match(textOf(results), /Применить ветку/, 'the result offers the branch apply shortcut')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('host keys translate the queue progress, task titles, branch names and result reasons', async () => {
  const keyedQueue = queueFixture({
    model: 'branches',
    tasks: [{
      id: 'q-1',
      text: 'Do the thing',
      title: '',
      mode: 'solo',
      status: 'parked',
      runId: null,
      reason: 'legacy reason',
      reasonKey: 'queue.reason.no-changes',
      reasonParams: {},
      questions: 0,
      fixes: 0,
      check: null,
      changeCount: 0,
      files: [],
      parkedBranch: null,
      createdAt: '2026-01-01T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    }],
    counts: { total: 1, queued: 0, running: 0, passed: 0, parked: 1, skipped: 0, stopped: 0, done: 1, remaining: 0 },
    progress: { key: 'queue.progress.queued', params: { queued: 1 }, text: 'legacy progress' },
    branches: [{
      id: 'b-1',
      name: 'legacy branch',
      nameKey: 'queue.branch.default',
      nameParams: { id: 'b-1' },
      baseCommit: 'a'.repeat(40),
      tipCommit: null,
      status: 'active',
      appliedAt: null,
    }],
    currentBranchId: 'b-1',
    results: {
      at: '2026-01-01T10:00:00.000Z',
      stopReason: 'empty',
      stopText: 'legacy stop',
      stopKey: 'queue.stop.empty',
      stopParams: {},
      startedAt: '2026-01-01T09:00:00.000Z',
      limit: 20,
      passed: [],
      parked: [{ taskId: 'q-1', title: '', reason: 'legacy parked', reasonKey: 'queue.reason.no-changes', reasonParams: {}, branch: 'b-1' }],
      notTaken: [],
    },
  })
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(keyedQueue)
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards: [] })
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const strip = findByClass(opened, 'dsh-artel-queue')
  const text = textOf(strip)
  assert.match(text, /Задача/, 'an empty task title falls back to the catalogue')
  assert.match(text, /Агент закончил и ничего не изменил\./, 'the task reason is translated')
  assert.match(text, /В очереди · 1/, 'the progress comes from the key')
  assert.doesNotMatch(text, /legacy progress/, 'the legacy progress text loses to the key')
  assert.match(text, /Ветка b-1/, 'the branch name comes from the key')
  assert.match(text, /Очередь пуста\./, 'the stop line comes from the stop key')
  assert.doesNotMatch(text, /legacy stop/, 'the legacy stop text loses to the key')
  assert.doesNotMatch(text, /legacy parked/, 'the parked reason comes from its key')
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

test('the run column scrolls the below-feed cards instead of hiding them under the composer (issue #7)', async () => {
  const resultsQueue = queueFixture({
    autopilot: false,
    tasks: [],
    counts: { total: 4, queued: 0, running: 0, passed: 4, parked: 0, skipped: 0, stopped: 0, done: 4, remaining: 0 },
    progress: { text: 'Автоочередь идёт · 4 из 4' },
    results: {
      at: '2026-01-01T10:00:00.000Z',
      stopReason: 'empty',
      stopText: 'Очередь пуста.',
      startedAt: '2026-01-01T09:00:00.000Z',
      limit: 20,
      passed: [
        { taskId: 'q-1', title: 'Ночная задача', runId: 'run-auto', files: ['src/app.js'], changeCount: 1, check: { ok: true, command: 'npm test' } },
        { taskId: 'q-2', title: 'Ещё задача', runId: 'run-auto', files: ['src/theme.css'], changeCount: 2, check: { ok: true, command: 'npm test' } },
      ],
      parked: [],
      notTaken: [],
      stats: { taken: 2, passed: 2, parked: 0 },
    },
  })
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [ORCHESTRATOR_RUN],
      changes: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(resultsQueue)
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const run = findByClass(opened, 'dsh-artel-run')
  assert.ok(run !== undefined, 'the run page is open')
  const scroller = findByClass(run, 'dsh-artel-run__scroll')
  assert.ok(scroller !== undefined, 'the run page has one scrolling column')
  const below = findByClass(scroller, 'dsh-artel-run__below')
  assert.ok(below !== undefined, 'the parts, changes and queue cards sit in the scrolling column')
  for (const className of ['dsh-artel-parts', 'dsh-artel-changes', 'dsh-artel-queue']) {
    assert.ok(findByClass(below, className) !== undefined, className + ' is reachable by scrolling')
    assert.equal(findByClass(run, className), findByClass(below, className), className + ' has a single home below the feed')
  }
  assert.ok(findByClass(scroller, 'dsh-artel-queue__results') !== undefined, 'the results card is inside the scrolling column too')
  const composer = findByClass(run, 'dsh-artel-composer')
  assert.ok(composer !== undefined, 'the composer stays pinned')
  assert.equal(findByClass(scroller, 'dsh-artel-composer'), undefined, 'the composer is not part of the scrolling area')
  const children = run.children.filter((node) => node !== null && node !== undefined)
  assert.equal(children[children.length - 1], composer, 'the composer is the last flex child of the run column')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the auto-queue results card collapses to its title and opens again', async () => {
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
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [AUTOQUEUE_RUN],
      changes: [],
      route: ({ method, pathname }) => {
        if (pathname === '/api/dsh-artel/queue' && method === 'GET') return reply(resultsQueue)
        return undefined
      },
    },
  })
  const opened = await openArtel(state)
  const results = findByClass(opened, 'dsh-artel-queue__results')
  assert.ok(results !== undefined, 'the results card is rendered')
  const toggle = findByClass(results, 'dsh-artel-queue__resultsToggle')
  assert.ok(toggle !== undefined, 'the results title is a toggle button')
  assert.equal(toggle.props['aria-expanded'], 'true', 'the results are open by default')
  assert.ok(findByClass(results, 'dsh-artel-queue__resultsBody') !== undefined, 'the open card renders its body')
  assert.ok(findButton(results, 'Доработать') !== undefined, 'the version actions are reachable while open')
  assert.match(textOf(findByClass(results, 'dsh-artel-queue__resultsCount')), /^ 1$|^1$/, 'the badge counts the versions')

  toggle.props.onClick()
  let collapsed = await state.realm.renderer.flush()
  let card = findByClass(collapsed, 'dsh-artel-queue__results')
  assert.ok(card !== undefined, 'the title row stays on screen')
  assert.match(textOf(card), /Итоги автоочереди/)
  assert.equal(findByClass(card, 'dsh-artel-queue__resultsToggle').props['aria-expanded'], 'false')
  assert.equal(findByClass(card, 'dsh-artel-queue__resultsBody'), undefined, 'the body is hidden while collapsed')
  assert.equal(findButton(card, 'Доработать'), undefined, 'the version actions hide with the body')

  findByClass(card, 'dsh-artel-queue__resultsToggle').props.onClick()
  collapsed = await state.realm.renderer.flush()
  card = findByClass(collapsed, 'dsh-artel-queue__results')
  assert.equal(findByClass(card, 'dsh-artel-queue__resultsToggle').props['aria-expanded'], 'true')
  assert.ok(findByClass(card, 'dsh-artel-queue__resultsBody') !== undefined, 'the body comes back')
  assert.ok(findButton(card, 'Доработать') !== undefined, 'the version actions come back')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the layout keeps the run column scrollable and the queue strip non-shrinking (issue #7)', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [AUTOQUEUE_RUN], changes: [] } })
  await openArtel(state)
  const css = state.realm.styleElements[0].textContent
  assert.match(css, /\.dsh-artel-run__below\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/, 'the below-feed stack is a column')
  assert.match(css, /\.dsh-artel-run__below\s*>\s*\.dsh-artel-queue\s*\{[^}]*flex:\s*none/, 'the below-feed cards do not shrink away')
  assert.match(css, /\.dsh-artel-queue\s*\{[^}]*flex:\s*none/, 'the queue strip no longer shrinks to zero height')
  assert.match(css, /\.dsh-artel-run__scroll\s*\{[^}]*overflow-y:\s*auto/, 'the run column scrolls')
  assert.match(css, /\.dsh-artel-models\s*\{[^}]*flex:\s*none/, 'the model bar keeps its height')
  assert.match(css, /\.dsh-artel-live\s*\{[^}]*flex:\s*none/, 'the live strip keeps its height')
  assert.match(css, /\.dsh-artel-hero\s*\{[^}]*overflow-y:\s*auto/, 'the hero scrolls when it overflows (issue #7, proposal 4)')
  assert.doesNotMatch(css, /\.dsh-artel-hero\s*\{[^}]*justify-content:\s*center/, 'the hero no longer clips a tall layout around its center')
  assert.match(css, /\.dsh-artel-hero::before,\s*\.dsh-artel-hero::after\s*\{[^}]*margin:\s*auto/, 'auto margins center the short hero and collapse when tall')
  assert.match(css, /\.dsh-artel-queue__resultsToggle\[aria-expanded="false"\]\s*svg\s*\{[^}]*rotate\(-90deg\)/, 'the collapsed results toggle points right')
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
  opened = await state.realm.renderer.flush()
  const savedMark = findByClass(opened, 'dsh-artel-factory__saved')
  assert.ok(savedMark !== undefined, 'a successful save says so next to the button')
  assert.equal(textOf(savedMark).trim(), 'Сохранено')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('creating the first factory board asks for confirmation first', async () => {
  const createCalls = []
  const boards = []
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [],
      route: ({ method, pathname, body }) => {
        if (pathname === '/api/dsh-artel/factory' && method === 'GET') return reply({ boards })
        if (pathname === '/api/dsh-artel/factory' && method === 'POST') {
          createCalls.push(body)
          const board = { ...FACTORY_BOARD, id: 'board-new', name: 'Новая доска' }
          boards.push(board)
          return reply({ board })
        }
        if (pathname === '/api/dsh-artel/factory/board-new' && method === 'GET') return reply({ boards, board: boards[0], tickets: [] })
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

  const empty = () => findByClass(opened, 'dsh-artel-factory__emptyState')
  assert.ok(empty() !== undefined, 'an empty factory offers to create a board')
  findButton(empty(), 'Создать доску').props.onClick()
  opened = await state.realm.renderer.flush()
  assert.deepEqual(createCalls, [], 'the first click only asks, it does not create')
  assert.match(textOf(empty()), /Создать её для этого проекта/)

  findButton(empty(), 'Отмена').props.onClick()
  opened = await state.realm.renderer.flush()
  assert.deepEqual(createCalls, [], 'cancelling creates nothing')
  assert.ok(findButton(empty(), 'Создать доску') !== undefined, 'the plain create button comes back')

  findButton(empty(), 'Создать доску').props.onClick()
  opened = await state.realm.renderer.flush()
  findButton(empty(), 'Да, создать').props.onClick()
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await state.realm.settle()
    opened = await state.realm.renderer.flush()
  }
  assert.equal(createCalls.length, 1, 'confirming reaches the Host once')
  assert.equal(findByClass(opened, 'dsh-artel-factory__emptyState'), undefined, 'the created board replaces the empty state')
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

/* ------------------------------------------------------- feed blocks (0.8.4) */

/** The localStorage payload the run pane writes its fold/hide state into. */
function storedBlocks(state) {
  return JSON.parse(state.realm.localStorage.getItem('dsh-artel:blocks:sess-1') ?? '{}')
}

/** The fold button of a managed block (plan, tools, …). */
function blockHead(block) {
  return findAll(block, (node) => node.type === 'button' && node.props.className === 'dsh-artel-block__head')[0]
}

test('a plan block folds to one line and the fold survives a render and a reload', async () => {
  const planText = Array.from({ length: 20 }, (_, index) => 'Строка плана ' + (index + 1)).join('\n')
  const scenario = {
    project: DEFAULT_PROJECT,
    runs: [DEFAULT_RUN],
    feed: { 'run-1': [{ seq: 1, at: '2026-01-01T10:01:00Z', kind: 'plan', text: planText }] },
  }
  const state = setup({ scenario })
  let opened = await openArtel(state)
  let plan = findByClass(opened, 'dsh-artel-plan')
  assert.ok(plan !== undefined, 'the plan is a card of its own')
  assert.equal(plan.props['data-collapsed'], 'false', 'the plan starts unfolded')
  assert.match(textOf(plan), /20 строк/, 'the header counts the plan lines')
  const head = blockHead(plan)
  assert.ok(head !== undefined, 'the plan has a disclosure header')
  assert.equal(head.props['aria-expanded'], true)
  assert.match(textOf(head), /План/)

  head.props.onClick()
  opened = await state.realm.renderer.flush()
  plan = findByClass(opened, 'dsh-artel-plan')
  assert.equal(plan.props['data-collapsed'], 'true', 'the card folds to one line')
  assert.equal(findByClass(plan, 'dsh-artel-plan__text'), undefined, 'the folded card keeps no text')
  assert.match(textOf(plan), /20 строк/, 'the folded line still says how much is inside')
  assert.equal(blockHead(plan).props['aria-expanded'], false)
  assert.equal(storedBlocks(state).collapsed['plan:1'], true, 'the fold is persisted per session')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()

  // Reload: a fresh realm that reads the same localStorage sees the folded card.
  const reloaded = setup({ scenario })
  reloaded.realm.localStorage.setItem('dsh-artel:blocks:sess-1', state.realm.localStorage.getItem('dsh-artel:blocks:sess-1'))
  const again = await openArtel(reloaded)
  assert.equal(findByClass(again, 'dsh-artel-plan').props['data-collapsed'], 'true', 'the folded plan survives a reload')
  reloaded.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('a long agent message shows the whole text when asked', async () => {
  const messageText = Array.from({ length: 16 }, (_, index) => 'Строка ответа ' + (index + 1)).join('\n')
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN],
      feed: { 'run-1': [{ seq: 1, at: '2026-01-01T10:02:00Z', kind: 'assistant', agent: 'Nova', text: messageText }] },
    },
  })
  let opened = await openArtel(state)
  const message = findByClass(opened, 'dsh-artel-msg')
  assert.equal(message.props['data-collapsed'], 'false')
  let clamp = findByClass(message, 'dsh-artel-clamp')
  assert.ok(clamp !== undefined, 'a long message is clamped to a readable height')
  assert.equal(clamp.props['data-tall'], 'false')
  const more = findByClass(clamp, 'dsh-artel-clamp__more')
  assert.ok(more !== undefined, 'a «показать целиком» control is offered')
  assert.equal(textOf(more).trim(), 'Показать целиком')

  more.props.onClick()
  opened = await state.realm.renderer.flush()
  clamp = findByClass(findByClass(opened, 'dsh-artel-msg'), 'dsh-artel-clamp')
  assert.equal(clamp.props['data-tall'], 'true', 'the clamp opens up to the whole text')
  assert.equal(textOf(findByClass(clamp, 'dsh-artel-clamp__more')).trim(), 'Свернуть')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the block toolbar hides a kind of block and remembers the choice', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN],
      feed: {
        'run-1': [
          { seq: 1, at: '2026-01-01T10:01:00Z', kind: 'plan', text: 'Короткий план' },
          { seq: 2, at: '2026-01-01T10:02:00Z', kind: 'assistant', agent: 'Nova', text: 'Ответ агента.' },
        ],
      },
    },
  })
  let opened = await openArtel(state)
  let manage = findByClass(opened, 'dsh-artel-manage')
  assert.ok(manage !== undefined, 'the run pane carries the blocks toolbar')
  assert.equal(manage.props.role, 'toolbar')
  const chips = findAll(manage, (node) => node.type === 'button'
    && String(node.props.className ?? '').split(/\s+/).includes('dsh-artel-manage__chip'))
  assert.equal(chips.length, 7, 'six block kinds plus the compact switch')
  assert.ok(findButton(manage, 'План') !== undefined)
  assert.ok(findButton(manage, 'Компактно') !== undefined)
  const planChip = findButton(manage, 'План')
  assert.equal(planChip.props['aria-pressed'], true)

  planChip.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.equal(findByClass(opened, 'dsh-artel-plan'), undefined, 'a hidden kind is not rendered at all')
  const stillThere = findByClass(opened, 'dsh-artel-msg')
  assert.ok(stillThere !== undefined, 'the other kinds stay in the feed')
  assert.equal(storedBlocks(state).hidden.plan, true, 'the choice is remembered per session')

  manage = findByClass(opened, 'dsh-artel-manage')
  const hiddenChip = findButton(manage, 'План')
  assert.equal(hiddenChip.props['aria-pressed'], false, 'the chip reports the hidden state')
  assert.equal(hiddenChip.props['data-active'], 'false')
  hiddenChip.props.onClick()
  opened = await state.realm.renderer.flush()
  assert.ok(findByClass(opened, 'dsh-artel-plan') !== undefined, 'the block comes back')
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('compact mode folds every block and «развернуть все» unfolds them', async () => {
  const state = setup({
    scenario: {
      project: DEFAULT_PROJECT,
      runs: [DEFAULT_RUN],
      feed: {
        'run-1': [
          { seq: 1, at: '2026-01-01T10:01:00Z', kind: 'plan', text: 'План' },
          { seq: 2, at: '2026-01-01T10:02:00Z', kind: 'assistant', agent: 'Nova', text: 'Ответ.' },
          { seq: 3, at: '2026-01-01T10:03:00Z', kind: 'tool', agent: 'Nova', tool: 'write', text: 'write src/app.js', callId: 'call-1' },
          { seq: 4, at: '2026-01-01T10:03:01Z', kind: 'tool-result', agent: 'Nova', callId: 'call-1', ok: true, text: 'ok' },
        ],
      },
    },
  })
  let opened = await openArtel(state)
  const compact = findButton(findByClass(opened, 'dsh-artel-manage'), 'Компактно')
  assert.ok(compact !== undefined)
  compact.props.onClick()
  opened = await state.realm.renderer.flush()
  for (const className of ['dsh-artel-plan', 'dsh-artel-msg', 'dsh-artel-tools']) {
    const block = findByClass(opened, className)
    assert.ok(block !== undefined, className + ' is in the feed')
    assert.equal(block.props['data-collapsed'], 'true', className + ' folds in compact mode')
  }
  assert.equal(findByClass(opened, 'dsh-artel-plan__text'), undefined)
  assert.equal(storedBlocks(state).compact, true)

  const unfold = findButton(findByClass(opened, 'dsh-artel-manage'), 'Развернуть все')
  assert.ok(unfold !== undefined, 'the toolbar can undo the whole mode')
  unfold.props.onClick()
  opened = await state.realm.renderer.flush()
  for (const className of ['dsh-artel-plan', 'dsh-artel-msg', 'dsh-artel-tools']) {
    assert.equal(findByClass(opened, className).props['data-collapsed'], 'false', className + ' unfolds again')
  }
  assert.ok(findByClass(opened, 'dsh-artel-plan__text') !== undefined)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})

test('the composer is pinned outside the scrolled feed and the split resizes it', async () => {
  const state = setup({ scenario: { project: DEFAULT_PROJECT, runs: [ORCHESTRATOR_RUN], changes: REVIEW_CHANGES } })
  let opened = await openArtel(state)
  const scroll = findByClass(opened, 'dsh-artel-run__scroll')
  assert.ok(scroll !== undefined)
  assert.ok(findByClass(scroll, 'dsh-artel-parts') !== undefined, 'the parts card scrolls with the feed')
  assert.equal(findByClass(scroll, 'dsh-artel-composer'), undefined, 'the composer never scrolls with the feed')

  const split = findByClass(opened, 'dsh-artel-run__split')
  assert.ok(split !== undefined, 'a split handle separates the feed from the composer')
  assert.equal(split.props.role, 'separator')
  assert.equal(split.props['aria-orientation'], 'horizontal')
  const textarea = findAll(findByClass(opened, 'dsh-artel-composer'), (node) => node.type === 'textarea')[0]
  assert.equal(textarea.props.style.maxHeight, 132, 'the composer starts at its compact height')

  split.props.onPointerDown({ button: 0, clientY: 100, preventDefault() {} })
  state.realm.dispatchWindowEvent('pointermove', { clientY: 180 })
  opened = await state.realm.renderer.flush()
  state.realm.dispatchWindowEvent('pointerup', {})
  const grown = findAll(findByClass(opened, 'dsh-artel-composer'), (node) => node.type === 'textarea')[0]
  assert.equal(grown.props.style.maxHeight, 212, 'dragging the split grows the composer')
  assert.equal(storedBlocks(state).heights.composer, 212, 'the dragged height is remembered')

  const parts = findByClass(opened, 'dsh-artel-parts')
  const partsToggle = findAll(parts, (node) => node.type === 'button' && node.props.className === 'dsh-artel-block__icon')[0]
  assert.ok(partsToggle !== undefined, 'the parts card folds from its own header')
  partsToggle.props.onClick()
  opened = await state.realm.renderer.flush()
  const folded = findByClass(opened, 'dsh-artel-parts')
  assert.equal(folded.props['data-collapsed'], 'true')
  assert.equal(findByClass(folded, 'dsh-artel-parts__body'), undefined, 'a folded parts card keeps only its header')
  assert.equal(storedBlocks(state).collapsed.parts, true)

  const changes = findByClass(opened, 'dsh-artel-changes')
  assert.ok(changes !== undefined, 'the changes card is in the same column')
  assert.equal(changes.props['data-block'], 'changes')
  const changesToggle = findAll(
    changes,
    (node) => node.type === 'button' && node.props.className === 'dsh-artel-changes__iconbtn',
  )[1]
  assert.ok(changesToggle !== undefined, 'the changes card folds from its own header')
  changesToggle.props.onClick()
  opened = await state.realm.renderer.flush()
  const foldedChanges = findByClass(opened, 'dsh-artel-changes')
  assert.equal(foldedChanges.props['data-collapsed'], 'true')
  assert.equal(findByClass(foldedChanges, 'dsh-artel-changes__body'), undefined)
  assert.equal(storedBlocks(state).collapsed.changes, true)
  state.realm.window.__DSH_ARTEL_DEBUG__.getStore('sess-1').dispose()
})
