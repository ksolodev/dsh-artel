/**
 * Ticket-tracker adapters: the pure, injectable part of the ticket factory.
 *
 * The factory imports work items from GitHub, GitLab, Jira and Linear, stores
 * them in one normalized shape, and (optionally) comments back on the source
 * issue when a ticket is done. Everything that reaches the outside world is
 * injected — `exec` runs the `gh` CLI and `fetchFn` performs HTTP requests — so
 * every adapter is testable without network access, real CLIs or credentials.
 *
 * The functions that touch a tracker never throw: they report their failure as
 * `{ issues: [], error }`, `{ ok: false, error }` or `null`. Configuration
 * mistakes are surfaced separately by {@link trackerProblems} so the UI can
 * disable a tracker before any request is attempted.
 */

/** Tracker kinds the factory understands, in display order. */
export const TRACKER_KINDS = ['github', 'gitlab', 'jira', 'linear']

/** Human-readable names of the tracker kinds. */
export const TRACKER_LABELS = { github: 'GitHub', gitlab: 'GitLab', jira: 'Jira', linear: 'Linear' }

/** Title used when a tracker returns a blank or missing one. */
const UNTITLED = '(untitled)'
/** Timeout handed to the `gh` CLI; HTTP requests rely on the caller's fetch. */
const TIMEOUT_MS = 30000
/** Fields requested from `gh issue ...` in one place for all GitHub calls. */
const GITHUB_FIELDS = 'number,title,body,url,labels'
/** Default GitLab host when the config does not name one. */
const GITLAB_DEFAULT_HOST = 'https://gitlab.com'
/** Linear's single GraphQL endpoint. */
const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
/** Characters allowed in a GitHub owner or repository name. */
const REPO_PART = '[A-Za-z0-9_.-]+'
/** A full GitHub issue URL; group 3 is the number. */
const GITHUB_URL_REF_SOURCE = `(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/(${REPO_PART})\\/(${REPO_PART})\\/issues\\/(\\d+)(?![0-9A-Za-z_])`
/** A `owner/repo#12` reference; group 3 is the number. */
const REPO_REF_SOURCE = `(${REPO_PART})\\/(${REPO_PART})#(\\d+)(?![0-9A-Za-z_])`
/** A bare `#12` reference; group 1 is the number. */
const BARE_REF_SOURCE = '#(\\d+)(?![0-9A-Za-z_])'

/**
 * Parse a GitHub issue reference out of user text.
 *
 * Accepted forms are a bare `#number`, `owner/repo#number` and a
 * `https://github.com/owner/repo/issues/number` URL (trailing slash, query and
 * fragment are fine). The number is the greedy run of digits, so `#123` never
 * parses as 12, and it must be greater than zero; an invalid match like `#0`
 * is skipped in favour of a later valid one. Text without a reference returns
 * null.
 * @param {unknown} text - user text that may carry an issue reference.
 * @returns {{ number: number, owner: string | null, repo: string | null } | null} parsed reference, or null.
 */
export function parseIssueRef(text) {
  if (typeof text !== 'string' || text === '') return null
  const url = firstIssueMatch(text, GITHUB_URL_REF_SOURCE, 3)
  if (url !== null) return { number: url.number, owner: url.match[1], repo: url.match[2] }
  const repoRef = firstIssueMatch(text, REPO_REF_SOURCE, 3)
  if (repoRef !== null) return { number: repoRef.number, owner: repoRef.match[1], repo: repoRef.match[2] }
  const bare = firstIssueMatch(text, BARE_REF_SOURCE, 1)
  if (bare !== null) return { number: bare.number, owner: null, repo: null }
  return null
}

/**
 * Find the first match of a reference pattern whose number is a positive
 * integer, skipping matches such as `#0`.
 * @param {string} text - text to scan.
 * @param {string} source - regular expression source with the number in a group.
 * @param {number} numberGroup - index of the group holding the number.
 * @returns {{ match: RegExpExecArray, number: number } | null} match and parsed number.
 */
function firstIssueMatch(text, source, numberGroup) {
  const pattern = new RegExp(source, 'gi')
  let match
  while ((match = pattern.exec(text)) !== null) {
    const number = positiveInteger(match[numberGroup])
    if (number !== null) return { match, number }
  }
  return null
}

/**
 * Normalize one tracker's raw issue into the shape the ticket store uses.
 *
 * Every tracker has its own field names (`body`/`description`, `iid`/`number`,
 * labels as strings or objects) and Jira wraps its description in an Atlassian
 * document. This maps all of that to `{ externalId, title, text, url, labels,
 * source }` so the store never branches on the tracker kind.
 *
 * The external id is stable per tracker and carries what a comment needs:
 * `gh:<repo>#<n>`, `gl:<repo>#<iid>`, `jira:<KEY>`, `lin:<identifier>`; an
 * unknown repository becomes `-` (for example `gh:-#12`). `label` is the
 * configured label filter, not the issue's labels, and is null when unset.
 * @param {string} kind - one of {@link TRACKER_KINDS}.
 * @param {unknown} raw - the tracker's issue object.
 * @param {{ label?: string | null, repo?: string | null }} [options] - configured label and repository.
 * @returns {{ externalId: string, title: string, text: string, url: string, labels: string[], source: { kind: string, label: string | null, repo: string | null } }} normalized issue.
 */
export function normalizeIssue(kind, raw, { label = null, repo = null } = {}) {
  const issue = objectOf(raw)
  const fields = objectOf(issue.fields)
  const labelName = nonEmpty(label)
  const repoName = nonEmpty(repo)
  const title = nonEmpty(kind === 'jira' ? fields.summary : issue.title) ?? UNTITLED
  const url = textOf(issue.url) || textOf(issue.html_url) || textOf(issue.web_url)
  const labels = labelsOf(kind === 'jira' ? fields.labels : issue.labels)
  return {
    externalId: externalIdOf(kind, issue, repoName),
    title,
    text: issueText(kind, issue),
    url,
    labels,
    source: { kind, label: labelName, repo: repoName },
  }
}

/**
 * Read one GitHub issue with the `gh` CLI and say why it failed.
 *
 * This is the detailed form of {@link fetchGitHubIssue}: the reason is one of
 * `bad-ref` (no usable reference), `gh-missing` (the CLI is not installed),
 * `gh-auth` (the CLI is installed but not signed in), `repo-not-found`,
 * `not-found`, `unreadable` (output that is not an issue object) or
 * `unavailable` (any other `gh` failure). `detail` carries the first line of
 * the CLI's own message, so the caller can show or log it. The function never
 * throws.
 * @param {{ ref: { number?: unknown, owner?: string | null, repo?: string | null } | null, cwd?: string, exec: (command: string, args: string[], options: object) => Promise<{ code?: number, stdout?: string, stderr?: string }> }} input - reference, working directory and injected exec.
 * @returns {Promise<{ issue: ReturnType<typeof normalizeIssue> | null, reason: string | null, detail: string }>} normalized issue or a failure reason.
 */
export async function readGitHubIssue({ ref = null, cwd = '', exec = null } = {}) {
  const number = positiveInteger(ref?.number)
  if (number === null || typeof exec !== 'function') return { issue: null, reason: 'bad-ref', detail: '' }
  const owner = nonEmpty(ref?.owner)
  const repo = nonEmpty(ref?.repo)
  const args = ['issue', 'view', String(number), '--json', GITHUB_FIELDS]
  if (owner !== null && repo !== null) args.push('-R', `${owner}/${repo}`)
  let result
  try {
    result = await exec('gh', args, { cwd: typeof cwd === 'string' ? cwd : '', timeout: TIMEOUT_MS })
  } catch (error) {
    result = { code: 1, stdout: '', stderr: errorText(error) }
  }
  if (execFailed(result)) return { issue: null, reason: classifyGhFailure(result), detail: firstLine(result?.stderr) }
  const parsed = parseJson(result?.stdout)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { issue: null, reason: 'unreadable', detail: firstLine(result?.stdout) }
  return {
    issue: normalizeIssue('github', parsed, { repo: owner !== null && repo !== null ? `${owner}/${repo}` : null }),
    reason: null,
    detail: '',
  }
}

/**
 * Fetch one GitHub issue with the `gh` CLI.
 *
 * The reference comes from {@link parseIssueRef}; when it names an owner and a
 * repository the command is pinned with `-R` so a checkout in another folder
 * cannot resolve the wrong issue. Any failure (a non-zero exit, unreadable
 * JSON, a missing ref or the exec itself throwing) returns null instead of
 * throwing; {@link readGitHubIssue} reports the reason.
 * @param {{ ref: { number?: unknown, owner?: string | null, repo?: string | null } | null, cwd?: string, exec: (command: string, args: string[], options: object) => Promise<{ code?: number, stdout?: string, stderr?: string }> }} input - reference, working directory and injected exec.
 * @returns {Promise<ReturnType<typeof normalizeIssue> | null>} normalized issue, or null on any failure.
 */
export async function fetchGitHubIssue({ ref = null, cwd = '', exec = null } = {}) {
  const { issue } = await readGitHubIssue({ ref, cwd, exec })
  return issue
}

/**
 * Classify a failed `gh issue view` into the reason the UI explains.
 * Order matters: a missing binary can also mention "not found", so it is
 * tested before the auth and issue patterns.
 * @param {unknown} result - `{ code, stdout, stderr }` of the failed call.
 * @returns {string} one of the reasons `readGitHubIssue` documents.
 */
function classifyGhFailure(result) {
  const text = `${textOf(result?.stderr)} ${textOf(result?.stdout)}`
  if (/ENOENT|not recognized as|не распознается|command not found|no such file or directory/i.test(text)) return 'gh-missing'
  if (/auth login|not logged in|not authenticated|authentication|bad credentials|HTTP 401|GH_TOKEN|oauth token|invalid token/i.test(text)) return 'gh-auth'
  if (/could not resolve to a (repository|repo)|repository not found/i.test(text)) return 'repo-not-found'
  if (/could not resolve to an issue|no issue found|issue not found|HTTP 404|not found/i.test(text)) return 'not-found'
  return 'unavailable'
}

/**
 * First non-empty line of a CLI message, trimmed and capped for a UI hint.
 * @param {unknown} value - raw stdout or stderr.
 * @returns {string} one readable line, possibly empty.
 */
function firstLine(value) {
  const line = textOf(value).split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== '')
  if (line === undefined) return ''
  return line.length > 300 ? line.slice(0, 300) + '…' : line
}

/**
 * List the open issues of one tracker that carry the configured label.
 *
 * The caller supplies the injected `exec` (GitHub only) and `fetchFn`; the
 * config shape depends on the kind: `{ label, repo? }` for GitHub,
 * `{ host?, project, token, label }` for GitLab, `{ baseUrl, email, token,
 * jql?, label }` for Jira and `{ apiKey, teamId, label }` for Linear. Every
 * issue is normalized by {@link normalizeIssue}. A failed request, a missing
 * setting or a rejected HTTP response becomes `{ issues: [], error }`; this
 * function never throws. An unknown kind reports `unknown-tracker`.
 * @param {{ kind?: string, config?: object, exec?: Function | null, fetchFn?: Function }} input - tracker kind, its config and the injected transports.
 * @returns {Promise<{ issues: Array<ReturnType<typeof normalizeIssue>>, error: string | null }>} normalized issues or a readable error.
 */
export async function listTrackerIssues({ kind, config = {}, exec = null, fetchFn = globalThis.fetch } = {}) {
  try {
    const settings = objectOf(config)
    switch (kind) {
      case 'github':
        return await listGitHubIssues(settings, exec)
      case 'gitlab':
        return await listGitLabIssues(settings, fetchFn)
      case 'jira':
        return await listJiraIssues(settings, fetchFn)
      case 'linear':
        return await listLinearIssues(settings, fetchFn)
      default:
        return { issues: [], error: 'unknown-tracker' }
    }
  } catch (err) {
    return { issues: [], error: errorText(err) }
  }
}

/**
 * Comment on the source issue after its ticket is done.
 *
 * The tracker and its settings come from the ticket's config, the target issue
 * from the normalized issue's `externalId` (see {@link normalizeIssue}): GitHub
 * parses `gh:<repo>#<n>`, GitLab `gl:<repo>#<iid>`, Jira `jira:<KEY>` and
 * Linear `lin:<identifier>` (Linear's comment mutation takes the identifier the
 * store kept). Any failure — unknown kind, unreadable external id, missing
 * setting, non-2xx response or a transport throwing — returns
 * `{ ok: false, error }`; this function never throws.
 * @param {{ kind?: string, config?: object, externalId?: string, body?: string, exec?: Function | null, fetchFn?: Function }} input - tracker kind, config, target external id, comment text and injected transports.
 * @returns {Promise<{ ok: boolean, error: string | null }>} whether the comment was posted and why not.
 */
export async function commentTrackerIssue({ kind, config = {}, externalId, body, exec = null, fetchFn = globalThis.fetch } = {}) {
  try {
    const settings = objectOf(config)
    const text = body === null || body === undefined ? '' : String(body)
    const id = nonEmpty(externalId)
    if (id === null) throw new Error('bad-external-id')
    switch (kind) {
      case 'github':
        return await commentGitHubIssue(id, text, exec)
      case 'gitlab':
        return await commentGitLabIssue(settings, id, text, fetchFn)
      case 'jira':
        return await commentJiraIssue(settings, id, text, fetchFn)
      case 'linear':
        return await commentLinearIssue(settings, id, text, fetchFn)
      default:
        return { ok: false, error: 'unknown-tracker' }
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

/**
 * List the blocking configuration problems of one tracker config.
 *
 * An empty array means the tracker is ready. GitHub only assumes the `gh` CLI,
 * GitLab needs `project` and `token`, Jira needs `baseUrl`, `email` and
 * `token`, and Linear needs `apiKey` and `teamId`. When `label` is present at
 * all it must be a non-empty string, and a present `commentBack` must be a
 * boolean; unknown kinds report `unknown-tracker`. Messages are meant for the
 * settings UI, not for retrying the request.
 * @param {object} [config] - tracker config with a `kind` field.
 * @returns {string[]} blocking messages; empty when the config is ready.
 */
export function trackerProblems(config = {}) {
  const settings = objectOf(config)
  const kind = settings.kind
  if (!TRACKER_KINDS.includes(kind)) return ['unknown-tracker']
  const problems = []
  if (kind === 'gitlab') {
    if (nonEmpty(settings.project) === null) problems.push('gitlab: project is required')
    if (nonEmpty(settings.token) === null) problems.push('gitlab: token is required')
  }
  if (kind === 'jira') {
    if (nonEmpty(settings.baseUrl) === null) problems.push('jira: baseUrl is required')
    if (nonEmpty(settings.email) === null) problems.push('jira: email is required')
    if (nonEmpty(settings.token) === null) problems.push('jira: token is required')
  }
  if (kind === 'linear') {
    if (nonEmpty(settings.apiKey) === null) problems.push('linear: apiKey is required')
    if (nonEmpty(settings.teamId) === null) problems.push('linear: teamId is required')
  }
  if (settings.label !== undefined && nonEmpty(settings.label) === null) {
    problems.push('label must be a non-empty string')
  }
  if (settings.commentBack !== undefined && typeof settings.commentBack !== 'boolean') {
    problems.push('commentBack must be a boolean')
  }
  return problems
}

/** Public API of the tracker adapters as one object. */
export default {
  TRACKER_KINDS,
  TRACKER_LABELS,
  parseIssueRef,
  normalizeIssue,
  readGitHubIssue,
  fetchGitHubIssue,
  listTrackerIssues,
  commentTrackerIssue,
  trackerProblems,
}

/* --------------------------------------------------------------- adapter helpers */

/**
 * Build the stable external id of one issue.
 * @param {string} kind - tracker kind.
 * @param {object} issue - raw issue object.
 * @param {string | null} repo - configured repository, if any.
 * @returns {string} external id.
 */
function externalIdOf(kind, issue, repo) {
  const where = repo ?? '-'
  switch (kind) {
    case 'github':
      return `gh:${where}#${digitsOf(issue.number)}`
    case 'gitlab':
      return `gl:${where}#${digitsOf(issue.iid)}`
    case 'jira':
      return `jira:${textOf(issue.key)}`
    case 'linear':
      return `lin:${textOf(issue.identifier)}`
    default:
      return `${kind}:${textOf(issue.identifier ?? issue.key ?? issue.id ?? issue.number)}`
  }
}

/**
 * Read the issue body the store shows in its ticket text.
 * @param {string} kind - tracker kind.
 * @param {object} issue - raw issue object.
 * @returns {string} plain text body, never null.
 */
function issueText(kind, issue) {
  const explicit = textOf(issue.text)
  if (explicit !== '') return explicit
  if (kind === 'github') return textOf(issue.body)
  if (kind === 'jira') return textOf(objectOf(issue.fields).description)
  return textOf(issue.description)
}

/**
 * Flatten a tracker's text field into plain text.
 *
 * Plain strings pass through; Atlassian documents (Jira's description) are
 * walked by their `content` tree, and any unknown object yields an empty
 * string instead of leaking `[object Object]` into a ticket.
 * @param {unknown} value - string, document, array or anything else.
 * @returns {string} extracted text.
 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textOf).filter((part) => part !== '').join('\n')
  if (typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.plain_text === 'string') return value.plain_text
  const content = value.content
  if (Array.isArray(content)) {
    const separator = value.type === 'paragraph' || value.type === 'heading' || value.type === 'codeBlock' ? '' : '\n'
    return content
      .map(textOf)
      .filter((part) => part !== '')
      .join(separator)
      .trim()
  }
  return ''
}

/**
 * Normalize labels from any tracker representation.
 *
 * Accepts a plain array of strings, an array of `{ name }` objects (GitHub) and
 * Linear's `{ nodes: [...] }`. Blank and duplicate names are dropped.
 * @param {unknown} value - raw labels field.
 * @returns {string[]} label names.
 */
function labelsOf(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.nodes) ? value.nodes : []
  const names = []
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : textOf(entry?.name)
    const trimmed = name.trim()
    if (trimmed !== '' && !names.includes(trimmed)) names.push(trimmed)
  }
  return names
}

/* --------------------------------------------------------------- github adapter */

/**
 * List open GitHub issues through the injected `gh` exec.
 * @param {object} config - `{ label?, repo? }`.
 * @param {Function | null} exec - injected CLI runner.
 * @returns {Promise<{ issues: object[], error: null }>} normalized issues.
 */
async function listGitHubIssues(config, exec) {
  if (typeof exec !== 'function') throw new Error('github: exec is required')
  const label = nonEmpty(config.label)
  const repo = nonEmpty(config.repo)
  const args = ['issue', 'list', '--state', 'open', '--limit', '50', '--json', GITHUB_FIELDS]
  if (label !== null) args.push('--label', label)
  if (repo !== null) args.push('-R', repo)
  const result = await exec('gh', args, { timeout: TIMEOUT_MS })
  if (execFailed(result)) throw new Error(execErrorText(result, 'gh issue list'))
  const parsed = parseJson(result?.stdout)
  if (!Array.isArray(parsed)) throw new Error('github: invalid issue list JSON')
  return {
    issues: parsed.map((raw) => normalizeIssue('github', raw, { label, repo })),
    error: null,
  }
}

/**
 * Comment on a GitHub issue through the injected `gh` exec.
 * @param {string} externalId - `gh:<repo>#<number>`; the repo replaces the one in config.
 * @param {string} body - comment text.
 * @param {Function | null} exec - injected CLI runner.
 * @returns {Promise<{ ok: true, error: null }>} posted comment.
 */
async function commentGitHubIssue(externalId, body, exec) {
  const match = /^gh:(.*)#(\d+)$/.exec(externalId)
  if (match === null) throw new Error('bad-external-id')
  if (typeof exec !== 'function') throw new Error('github: exec is required')
  const repo = match[1]
  const args = ['issue', 'comment', match[2], '--body', body]
  if (repo !== '' && repo !== '-') args.push('-R', repo)
  const result = await exec('gh', args, { timeout: TIMEOUT_MS })
  if (execFailed(result)) throw new Error(execErrorText(result, 'gh issue comment'))
  return { ok: true, error: null }
}

/* --------------------------------------------------------------- gitlab adapter */

/**
 * List open GitLab issues over the injected fetch.
 * @param {object} config - `{ host?, project, token, label }`.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ issues: object[], error: null }>} normalized issues.
 */
async function listGitLabIssues(config, fetchFn) {
  const project = requiredText(config.project, 'gitlab: project is required')
  const token = requiredText(config.token, 'gitlab: token is required')
  const label = nonEmpty(config.label)
  const base = baseUrlOf(config.host, GITLAB_DEFAULT_HOST)
  const query = `?state=opened&per_page=50${label === null ? '' : `&labels=${encodeURIComponent(label)}`}`
  const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/issues${query}`
  const response = await checkedFetch(fetchFn, url, { headers: { 'PRIVATE-TOKEN': token } }, 'gitlab')
  const payload = await responseJson(response, 'gitlab')
  if (!Array.isArray(payload)) throw new Error('gitlab: invalid issue list JSON')
  return {
    issues: payload.map((raw) => normalizeIssue('gitlab', raw, { label, repo: project })),
    error: null,
  }
}

/**
 * Post a note on a GitLab issue over the injected fetch.
 * @param {object} config - `{ host?, project, token }`.
 * @param {string} externalId - `gl:<repo>#<iid>`; its repo fills in a missing project.
 * @param {string} body - comment text.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ ok: true, error: null }>} posted note.
 */
async function commentGitLabIssue(config, externalId, body, fetchFn) {
  const match = /^gl:(.*)#(\d+)$/.exec(externalId)
  if (match === null) throw new Error('bad-external-id')
  const token = requiredText(config.token, 'gitlab: token is required')
  const repo = match[1] !== '' && match[1] !== '-' ? match[1] : ''
  const project = nonEmpty(config.project) ?? repo
  if (project === '') throw new Error('gitlab: project is required')
  const base = baseUrlOf(config.host, GITLAB_DEFAULT_HOST)
  const url = `${base}/api/v4/projects/${encodeURIComponent(project)}/issues/${match[2]}/notes`
  await checkedFetch(fetchFn, url, {
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  }, 'gitlab')
  return { ok: true, error: null }
}

/* ----------------------------------------------------------------- jira adapter */

/**
 * List open Jira issues over the injected fetch.
 * @param {object} config - `{ baseUrl, email, token, jql?, label }`.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ issues: object[], error: null }>} normalized issues.
 */
async function listJiraIssues(config, fetchFn) {
  const base = requiredText(baseUrlOf(config.baseUrl, ''), 'jira: baseUrl is required')
  const email = requiredText(config.email, 'jira: email is required')
  const token = requiredText(config.token, 'jira: token is required')
  const label = nonEmpty(config.label)
  const custom = nonEmpty(config.jql)
  const jql = custom ?? (label === null ? 'statusCategory != Done' : `labels = "${label}" AND statusCategory != Done`)
  const url = `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description,labels`
  const headers = { Authorization: basicAuth(email, token) }
  const response = await checkedFetch(fetchFn, url, { headers }, 'jira')
  const payload = await responseJson(response, 'jira')
  if (!Array.isArray(payload?.issues)) throw new Error('jira: invalid issue list JSON')
  return {
    issues: payload.issues.map((raw) => normalizeIssue('jira', raw, { label })),
    error: null,
  }
}

/**
 * Post a comment on a Jira issue as an Atlassian document.
 * @param {object} config - `{ baseUrl, email, token }`.
 * @param {string} externalId - `jira:<KEY>`.
 * @param {string} body - comment text.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ ok: true, error: null }>} posted comment.
 */
async function commentJiraIssue(config, externalId, body, fetchFn) {
  const match = /^jira:(.+)$/.exec(externalId)
  if (match === null) throw new Error('bad-external-id')
  const base = requiredText(baseUrlOf(config.baseUrl, ''), 'jira: baseUrl is required')
  const email = requiredText(config.email, 'jira: email is required')
  const token = requiredText(config.token, 'jira: token is required')
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(match[1])}/comment`
  const document = {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
  }
  await checkedFetch(fetchFn, url, {
    method: 'POST',
    headers: { Authorization: basicAuth(email, token), 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  }, 'jira')
  return { ok: true, error: null }
}

/* --------------------------------------------------------------- linear adapter */

/**
 * List open Linear issues over the injected fetch.
 * @param {object} config - `{ apiKey, teamId, label }`.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ issues: object[], error: null }>} normalized issues.
 */
async function listLinearIssues(config, fetchFn) {
  const apiKey = requiredText(config.apiKey, 'linear: apiKey is required')
  const teamId = requiredText(config.teamId, 'linear: teamId is required')
  const label = nonEmpty(config.label)
  const variables = { teamId }
  const declaration = label === null ? '$teamId: String!' : '$teamId: String!, $label: String'
  const filter = label === null
    ? '{ team: { id: { eq: $teamId } } }'
    : '{ team: { id: { eq: $teamId } }, labels: { some: { name: { eq: $label } } } }'
  if (label !== null) variables.label = label
  const query = [
    `query FactoryIssues(${declaration}) {`,
    `  issues(first: 50, filter: ${filter}) {`,
    '    nodes { id identifier title description url labels { nodes { name } } }',
    '  }',
    '}',
  ].join('\n')
  const response = await checkedFetch(fetchFn, LINEAR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  }, 'linear')
  const payload = await responseJson(response, 'linear')
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  if (errors.length > 0) throw new Error(`linear: ${textOf(errors[0]?.message) || 'graphql error'}`)
  const nodes = payload?.data?.issues?.nodes
  if (!Array.isArray(nodes)) throw new Error('linear: invalid issue list JSON')
  return {
    issues: nodes.map((raw) => normalizeIssue('linear', raw, { label })),
    error: null,
  }
}

/**
 * Post a comment on a Linear issue through its comment mutation.
 * @param {object} config - `{ apiKey }`.
 * @param {string} externalId - `lin:<identifier>`.
 * @param {string} body - comment text.
 * @param {Function} fetchFn - injected fetch.
 * @returns {Promise<{ ok: true, error: null }>} posted comment.
 */
async function commentLinearIssue(config, externalId, body, fetchFn) {
  const match = /^lin:(.+)$/.exec(externalId)
  if (match === null) throw new Error('bad-external-id')
  const apiKey = requiredText(config.apiKey, 'linear: apiKey is required')
  const query = 'mutation FactoryComment($issueId: String!, $body: String!) {\n  commentCreate(input: { issueId: $issueId, body: $body }) { success }\n}'
  const response = await checkedFetch(fetchFn, LINEAR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables: { issueId: match[1], body } }),
  }, 'linear')
  const payload = await responseJson(response, 'linear')
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  if (errors.length > 0) throw new Error(`linear: ${textOf(errors[0]?.message) || 'graphql error'}`)
  return { ok: true, error: null }
}

/* ------------------------------------------------------------------ transports */

/**
 * Run one fetch and turn a non-2xx response into an error carrying its status.
 * @param {Function} fetchFn - injected fetch.
 * @param {string} url - request URL.
 * @param {object} options - fetch options.
 * @param {string} kind - tracker name for the message.
 * @returns {Promise<object>} the successful response.
 */
async function checkedFetch(fetchFn, url, options, kind) {
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable')
  const response = await fetchFn(url, options)
  const status = Number(response?.status)
  if (response?.ok === false || (Number.isFinite(status) && (status < 200 || status >= 300))) {
    throw new Error(`${kind} HTTP ${Number.isFinite(status) ? status : 'error'}`)
  }
  return response
}

/**
 * Read the JSON body of a fetch response with a readable failure message.
 * @param {object} response - fetch response.
 * @param {string} kind - tracker name for the message.
 * @returns {Promise<any>} parsed JSON.
 */
async function responseJson(response, kind) {
  if (response === null || typeof response !== 'object' || typeof response.json !== 'function') {
    throw new Error(`${kind}: unreadable response`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`${kind}: invalid response JSON`)
  }
}

/* --------------------------------------------------------------------- helpers */

/**
 * Parse JSON defensively.
 * @param {unknown} text - raw stdout.
 * @returns {any} parsed value, or null when missing or malformed.
 */
function parseJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * Whether an exec result means the command failed.
 * @param {unknown} result - `{ code, stdout, stderr }`.
 * @returns {boolean} true when the command ran and exited non-zero.
 */
function execFailed(result) {
  if (result === null || typeof result !== 'object') return true
  return typeof result.code === 'number' && result.code !== 0
}

/**
 * Readable message for a failed exec result.
 * @param {unknown} result - `{ code, stdout, stderr }`.
 * @param {string} fallback - message used without stderr.
 * @returns {string} error text.
 */
function execErrorText(result, fallback) {
  const stderr = textOf(result?.stderr).trim()
  if (stderr !== '') return stderr
  const code = result?.code
  return typeof code === 'number' && code !== 0 ? `${fallback} failed (exit ${code})` : fallback
}

/**
 * Build a Basic authorization header from an email and a token.
 * @param {string} email - account email.
 * @param {string} token - API token.
 * @returns {string} `Basic <base64(email:token)>`.
 */
function basicAuth(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
}

/**
 * Strip trailing slashes from a base URL, applying a fallback when blank.
 * @param {unknown} value - configured host or base URL.
 * @param {string} fallback - URL used when the value is blank.
 * @returns {string} base URL without a trailing slash.
 */
function baseUrlOf(value, fallback) {
  const given = nonEmpty(value)
  return (given ?? fallback).replace(/\/+$/, '')
}

/**
 * Read one required setting.
 * @param {unknown} value - configured value.
 * @param {string} message - error used when blank.
 * @returns {string} the trimmed value.
 */
function requiredText(value, message) {
  const text = nonEmpty(value)
  if (text === null) throw new Error(message)
  return text
}

/**
 * A trimmed non-empty string, or null for anything else.
 * @param {unknown} value - candidate value.
 * @returns {string | null} trimmed string or null.
 */
function nonEmpty(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Read one issue number as a positive integer.
 * @param {unknown} value - `number`/`iid`/a digit string.
 * @returns {number | null} positive integer or null.
 */
function positiveInteger(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/**
 * Read an issue number for an external id, tolerating a missing field.
 * @param {unknown} value - `number`/`iid`.
 * @returns {number} positive integer or 0.
 */
function digitsOf(value) {
  return positiveInteger(value) ?? 0
}

/**
 * A plain object, or an empty object for anything else.
 * @param {unknown} value - candidate.
 * @returns {object} safe object.
 */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Readable text for a thrown value.
 * @param {unknown} err - caught value.
 * @returns {string} message.
 */
function errorText(err) {
  if (err instanceof Error && typeof err.message === 'string' && err.message !== '') return err.message
  const text = textOf(err)
  return text !== '' ? text : 'unknown-error'
}
