import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachProjectChat,
  attachSessionToWorkspace,
  isSessionId,
  projectWorkspaceOf,
  restoreProjectChats,
  taskChatTitle,
  workspaceRegistryOf,
} from '../lib/project-chats.js'

/**
 * Minimal Workspace entity with the members the bridge touches.
 *
 * It reproduces the two behaviours that matter: `sessionIds` is filtered through
 * `host.candidateMatches` (so an id is only visible after the cwd index was
 * primed), and `mutate()` rewrites the durable record.
 * @param {{ id?: string, path?: string, sessionIds?: string[] }} [options] - record.
 * @returns {object} fake entity, plus `paths` (primed index) and `writes`.
 */
function fakeWorkspace({ id = 'ws-1', path = 'C:\\project', sessionIds = [] } = {}) {
  const state = { record: { id, path, title: 'project', sessionIds: [...sessionIds], createdAt: 1, updatedAt: 1 } }
  const paths = new Map()
  const writes = []
  const host = {
    rememberSessionPath(sessionId, projectPath) {
      paths.set(sessionId, projectPath)
    },
    candidateMatches(sessionId, projectPath) {
      return paths.get(sessionId) === projectPath
    },
  }
  const workspace = {
    id,
    path,
    host,
    paths,
    writes,
    get record() {
      return state.record
    },
    get sessionIds() {
      return state.record.sessionIds.filter((sessionId) => host.candidateMatches(sessionId, state.record.path))
    },
    mutate(change) {
      const next = change(state.record)
      if (next === state.record) {
        const error = new Error('no change')
        error.name = 'UnchangedSentinel'
        throw error
      }
      state.record = { ...next, updatedAt: 2 }
      writes.push({ ...next })
    },
  }
  return workspace
}

/** Registry resolving by canonical project path, like the real service. */
function fakeRegistry({ workspaces = [], byPath } = {}) {
  const map = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  return {
    list: () => [...map.values()],
    get: (id) => [...map.values()].find((workspace) => workspace.id === id),
    async resolveByPath(projectPath) {
      if (typeof byPath === 'function') return byPath(projectPath)
      return map.get(projectPath)
    },
  }
}

test('isSessionId only accepts real chat ids', () => {
  assert.equal(isSessionId('session-123'), true)
  assert.equal(isSessionId('factory-board-1-2'), false, 'factory runs are synthetic')
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(null), false)
})

test('workspaceRegistryOf tolerates a profile without the Workspace services', () => {
  assert.equal(workspaceRegistryOf({ get: () => undefined }), null)
  assert.equal(workspaceRegistryOf({ get: () => null }), null)
  assert.equal(workspaceRegistryOf({}), null)
  const registry = fakeRegistry()
  assert.equal(workspaceRegistryOf({ get: () => registry }), registry)
  assert.equal(workspaceRegistryOf({ get: () => ({ resolveByPath() {} }) }), null, 'an incomplete service is not used')
})

test('projectWorkspaceOf finds the Workspace of a project directory', async () => {
  const workspace = fakeWorkspace()
  const registry = fakeRegistry({ workspaces: [workspace] })
  assert.equal(await projectWorkspaceOf(registry, 'C:\\project'), workspace)
  assert.equal(await projectWorkspaceOf(registry, 'C:\\nope'), null)
  assert.equal(await projectWorkspaceOf(null, 'C:\\project'), null)
  assert.equal(await projectWorkspaceOf(registry, ''), null)
  const failing = fakeRegistry({ byPath: async () => { throw new Error('realpath failed') } })
  assert.equal(await projectWorkspaceOf(failing, 'C:\\project'), null, 'a broken lookup is not a crash')
})

test('attachSessionToWorkspace files a copy-backed chat under the project', () => {
  const workspace = fakeWorkspace()
  const log = []
  assert.equal(attachSessionToWorkspace(workspace, 'session-agent-1', { warn: (line) => log.push(line) }), true)
  assert.equal(workspace.paths.get('session-agent-1'), 'C:\\project', 'the cwd index is primed')
  assert.deepEqual(workspace.record.sessionIds, ['session-agent-1'])
  assert.deepEqual(workspace.sessionIds, ['session-agent-1'], 'the filtered view shows the chat')
  // The really important part: the durable record is written.
  assert.equal(workspace.writes.length, 1)

  // Idempotent: a second attach performs no write and reports success.
  assert.equal(attachSessionToWorkspace(workspace, 'session-agent-1'), true)
  assert.equal(workspace.writes.length, 1)
  assert.deepEqual(workspace.record.sessionIds, ['session-agent-1'])
})

test('attachSessionToWorkspace refuses synthetic ids and broken entities', () => {
  const workspace = fakeWorkspace()
  assert.equal(attachSessionToWorkspace(workspace, 'factory-1-2'), false)
  assert.equal(attachSessionToWorkspace(null, 'session-agent-1'), false)
  assert.equal(attachSessionToWorkspace(workspace, ''), false)
  const broken = { id: 'ws-1', path: 'C:\\project', record: { sessionIds: [] }, mutate() {} }
  assert.equal(attachSessionToWorkspace(broken, 'session-agent-1'), false, 'a host without the index is skipped')
})

test('attachSessionToWorkspace survives a lost mutate race', () => {
  const workspace = fakeWorkspace()
  // Another writer got there first: mutate would throw the unchanged sentinel,
  // but the record already lists the chat.
  workspace.mutate = () => {
    const error = new Error('already there')
    error.name = 'UnchangedSentinel'
    throw error
  }
  workspace.record.sessionIds.push('session-agent-1')
  assert.equal(attachSessionToWorkspace(workspace, 'session-agent-1'), true)
  assert.equal(workspace.record.sessionIds.length, 1)
})

test('attachProjectChat resolves the workspace and adds the chat', async () => {
  const workspace = fakeWorkspace()
  const registry = fakeRegistry({ workspaces: [workspace] })
  assert.equal(await attachProjectChat({ registry, sessionId: 'session-task-1', projectPath: 'C:\\project' }), 'ws-1')
  assert.deepEqual(workspace.record.sessionIds, ['session-task-1'])
  assert.equal(await attachProjectChat({ registry, sessionId: 'session-task-1', projectPath: 'C:\\nope' }), null)
})

test('taskChatTitle is one readable line', () => {
  assert.equal(taskChatTitle('Add a settings screen'), 'Artel · Add a settings screen')
  assert.equal(taskChatTitle('  Add\n\na settings\tscreen  '), 'Artel · Add a settings screen')
  assert.equal(taskChatTitle(''), 'Artel · Task')
  const long = taskChatTitle('x'.repeat(200))
  assert.ok(long.length <= 'Artel · '.length + 60, 'the title stops at the task snippet budget')
  assert.ok(long.endsWith('…'))
})

test('restoreProjectChats re-files only runs that opted in', async () => {
  const workspace = fakeWorkspace({ sessionIds: ['session-task-1'] })
  const registry = fakeRegistry({ workspaces: [workspace] })
  const runs = [
    { id: 'run-1', projectChats: true, projectPath: 'C:\\project', sessionId: 'session-task-1', agents: [{ sessionId: 'session-agent-1' }, { sessionId: null }] },
    { id: 'run-2', projectPath: 'C:\\project', sessionId: 'session-old', agents: [{ sessionId: 'session-old-agent' }] },
    { id: 'run-3', projectChats: true, projectPath: 'C:\\gone', sessionId: 'session-3', agents: [] },
  ]
  const result = await restoreProjectChats({ registry, runs })
  assert.deepEqual(result, { attached: 2, skipped: 1, failed: 0 })
  assert.deepEqual(workspace.record.sessionIds.slice().sort(), ['session-agent-1', 'session-task-1'], 'old runs are not touched')
  assert.equal(workspace.paths.get('session-agent-1'), 'C:\\project')
})

test('restoreProjectChats is a no-op without a registry', async () => {
  assert.deepEqual(await restoreProjectChats({ registry: null, runs: [{ projectChats: true }] }), { attached: 0, skipped: 0, failed: 0 })
})
