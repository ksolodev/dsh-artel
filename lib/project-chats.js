/**
 * Project chats for dsh-artel.
 *
 * DeepSeek Harness groups the sidebar by Workspace, and a Workspace only lists a
 * Session whose immutable header `cwd` resolves to the Workspace path. Artel
 * agents must run with `cwd = <run copy>` so the shipped sandbox policy keeps the
 * real project unreachable — which is exactly why the host files every agent
 * conversation under its own copy directory instead of the project.
 *
 * This module bridges the two. The Workspace registry keeps an in-memory index
 * from Session id to the real path of the Session cwd (`host.candidateMatches`),
 * and derives `workspace.sessionIds` from it. Priming that index for an agent
 * Session (`host.rememberSessionPath`) and then appending the Session through the
 * same `workspace.mutate()` the controller uses makes the Session a member of
 * the project Workspace while its real cwd stays the copy. The `mutate()` write
 * is durable (workspace.json keeps the id), but the cwd index is derived at
 * startup from the stored Session headers, so it has to be primed again after a
 * host restart — that is what `restoreProjectChats()` does.
 *
 * Nothing here imports a harness package: `entity.host`, `entity.mutate()` and
 * `registry.resolveByPath()` are public members of the running services, and
 * every step is best-effort. A profile without the Workspace services, an
 * unsaved project folder, or a Workspace record that changed under us leaves the
 * old behaviour (the run stays in the chat it was started from) in place instead
 * of failing the run.
 */

/** Real chat Session ids look like this; Factory runs use synthetic ids. */
const SESSION_ID_PATTERN = /^session-/

/** Longest task snippet kept in a task chat title. */
const TITLE_TASK_LIMIT = 60

/**
 * Whether a value names a real chat Session.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true for ids the host created for a chat.
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Resolve the host Workspace registry, if this profile has one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object | null} the registry, or null when the profile has none.
 */
export function workspaceRegistryOf(ctx) {
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    return null
  }
  if (registry === null || registry === undefined) return null
  if (typeof registry.resolveByPath !== 'function' || typeof registry.get !== 'function') return null
  return registry
}

/**
 * Find the Workspace that owns a project directory.
 *
 * `resolveByPath` canonicalizes its argument itself (realpath + case rules of
 * the platform), so the caller passes a plain filesystem path.
 * @param {object | null} registry - Workspace registry.
 * @param {string} projectPath - project directory.
 * @returns {Promise<object | null>} Workspace entity, or null when the folder is
 *   not an open Workspace (for example an unsaved chat directory).
 */
export async function projectWorkspaceOf(registry, projectPath) {
  if (registry === null || registry === undefined) return null
  if (typeof projectPath !== 'string' || projectPath.trim() === '') return null
  try {
    const workspace = await registry.resolveByPath(projectPath)
    if (workspace === null || workspace === undefined) return null
    if (typeof workspace.id !== 'string' || workspace.id === '') return null
    if (typeof workspace.path !== 'string' || workspace.path === '') return null
    return workspace
  } catch {
    return null
  }
}

/**
 * Make one Session a member of a Workspace without changing its cwd.
 *
 * The registry decides membership by comparing the canonical cwd of the Session
 * header with the Workspace path. An Artel agent lives in the run copy, so its
 * header cwd can never match; priming the index for exactly this Workspace and
 * Session makes the filter pass without touching the Session itself. Both writes
 * are the same ones `WorkspaceEntity.attachSession()` performs, just without its
 * cwd check.
 * @param {object} workspace - Workspace entity.
 * @param {string} sessionId - Session to add.
 * @param {Pick<Console, 'warn'> | null} [log] - logger for best-effort failures.
 * @returns {boolean} true when the Workspace now lists the Session.
 */
export function attachSessionToWorkspace(workspace, sessionId, log = null) {
  if (workspace === null || workspace === undefined) return false
  if (!isSessionId(sessionId)) return false
  const host = workspace.host
  if (typeof host?.rememberSessionPath !== 'function') return false
  if (typeof workspace.mutate !== 'function') return false
  try {
    host.rememberSessionPath(sessionId, workspace.path)
  } catch (error) {
    log?.warn?.(`dsh-artel: could not index session ${sessionId} for its project: ${error?.message ?? error}`)
    return false
  }
  if (spaceIncludes(workspace, sessionId)) return true
  try {
    workspace.mutate((record) => {
      if (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)) return record
      const sessionIds = Array.isArray(record?.sessionIds) ? [sessionId, ...record.sessionIds] : [sessionId]
      return { ...record, sessionIds }
    })
  } catch (error) {
    // `mutate()` reports a no-op through a private sentinel and also rejects a
    // record another writer just changed; the Session may have landed anyway.
    if (spaceIncludes(workspace, sessionId)) return true
    log?.warn?.(`dsh-artel: could not add session ${sessionId} to its project sidebar: ${error?.message ?? error}`)
    return false
  }
  return spaceIncludes(workspace, sessionId)
}

/**
 * Read whether the Workspace record currently lists a Session.
 * @param {object} workspace - Workspace entity.
 * @param {string} sessionId - Session id.
 * @returns {boolean} true when the id is in the record.
 */
function spaceIncludes(workspace, sessionId) {
  try {
    const record = workspace.record
    return Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Put one task chat (a real Session in the project) into its Workspace.
 *
 * The controller already attaches a chat created with `workspaceId`, so this is
 * the repair path for a failed attach; it is idempotent.
 * @param {{ registry: object | null, sessionId: string, projectPath: string, log?: Pick<Console, 'warn'> | null }} request
 * @returns {Promise<string | null>} Workspace id, or null when nothing was done.
 */
export async function attachProjectChat({ registry, sessionId, projectPath, log = null }) {
  const workspace = await projectWorkspaceOf(registry, projectPath)
  if (workspace === null) return null
  return attachSessionToWorkspace(workspace, sessionId, log) ? workspace.id : null
}

/**
 * Title for the per-task chat: the issue asks for "Artel · <task>".
 * @param {string} task - the task text.
 * @returns {string} one-line title.
 */
export function taskChatTitle(task) {
  const line = String(task ?? '').replace(/\s+/g, ' ').trim()
  if (line === '') return 'Artel · Task'
  const snippet = line.length > TITLE_TASK_LIMIT ? `${line.slice(0, TITLE_TASK_LIMIT - 1).trimEnd()}…` : line
  return `Artel · ${snippet}`
}

/**
 * Re-prime the project membership of the chats of stored runs.
 *
 * The durable Workspace record already keeps the Session ids; the derived cwd
 * index is rebuilt from the Session headers on every host start, so a chat whose
 * header cwd is the run copy (every Artel agent) falls out of the sidebar after a
 * restart. Runs started by this version carry `projectChats: true`; older runs
 * are left alone, exactly as the issue asks.
 * @param {{ registry: object | null, runs: Array<object>, log?: Pick<Console, 'warn'> | null }} request
 * @returns {Promise<{ attached: number, skipped: number, failed: number }>} counts.
 */
export async function restoreProjectChats({ registry, runs, log = null }) {
  const result = { attached: 0, skipped: 0, failed: 0 }
  if (registry === null || typeof registry.resolveByPath !== 'function') return result
  const byProject = new Map()
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run === null || typeof run !== 'object') continue
    if (run.projectChats !== true) continue
    const projectPath = run.projectPath
    if (typeof projectPath !== 'string' || projectPath === '') continue
    let workspace = byProject.get(projectPath)
    if (workspace === undefined) {
      workspace = await projectWorkspaceOf(registry, projectPath)
      byProject.set(projectPath, workspace)
    }
    if (workspace === null) {
      result.skipped += 1
      continue
    }
    const sessionIds = []
    // The task chat is a real member already (its header cwd is the project);
    // adding it again is a cheap idempotent assertion.
    if (isSessionId(run.sessionId)) sessionIds.push(run.sessionId)
    for (const agent of Array.isArray(run.agents) ? run.agents : []) {
      if (isSessionId(agent?.sessionId)) sessionIds.push(agent.sessionId)
    }
    for (const sessionId of new Set(sessionIds)) {
      if (attachSessionToWorkspace(workspace, sessionId, log)) result.attached += 1
      else result.failed += 1
    }
  }
  return result
}
