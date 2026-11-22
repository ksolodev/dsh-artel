import test from 'node:test'
import assert from 'node:assert/strict'

import trackers, {
  TRACKER_KINDS,
  TRACKER_LABELS,
  parseIssueRef,
  normalizeIssue,
  readGitHubIssue,
  fetchGitHubIssue,
  listTrackerIssues,
  commentTrackerIssue,
  trackerProblems,
} from '../lib/trackers.js'

/** The `--json` field list every GitHub call must request. */
const FIELDS = 'number,title,body,url,labels'

/**
 * Build an injected exec that records every call and answers with `handler`.
 * @param {(call: { command: string, args: string[], options: object }) => unknown} handler - answer factory.
 * @returns {{ exec: Function, calls: Array<{ command: string, args: string[], options: object }> }} injected exec and its calls.
 */
function makeExec(handler) {
  const calls = []
  const exec = async (command, args, options) => {
    calls.push({ command, args, options })
    return handler({ command, args, options })
  }
  return { exec, calls }
}

/**
 * Build an injected fetch that records every call and answers with `handler`.
 * @param {(call: { url: string, options: object }) => unknown} handler - answer factory.
 * @returns {{ fetchFn: Function, calls: Array<{ url: string, options: object }> }} injected fetch and its calls.
 */
function makeFetch(handler) {
  const calls = []
  const fetchFn = async (url, options) => {
    calls.push({ url, options })
    return handler({ url, options })
  }
  return { fetchFn, calls }
}

/**
 * A minimal fetch Response stand-in.
 * @param {unknown} payload - value returned by `json()`.
 * @param {number} [status] - HTTP status.
 * @returns {{ ok: boolean, status: number, json: () => Promise<unknown> }} response stand-in.
 */
function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

/* ----------------------------------------------------------------- constants */

test('tracker constants match the contract', () => {
  assert.deepEqual(TRACKER_KINDS, ['github', 'gitlab', 'jira', 'linear'])
  assert.deepEqual(TRACKER_LABELS, { github: 'GitHub', gitlab: 'GitLab', jira: 'Jira', linear: 'Linear' })
  assert.deepEqual(Object.keys(trackers).sort(), [
    'TRACKER_KINDS',
    'TRACKER_LABELS',
    'commentTrackerIssue',
    'fetchGitHubIssue',
    'listTrackerIssues',
    'normalizeIssue',
    'parseIssueRef',
    'readGitHubIssue',
    'trackerProblems',
  ].sort())
})

/* -------------------------------------------------------------- parseIssueRef */

test('parseIssueRef reads a bare issue number anywhere in text', () => {
  assert.deepEqual(parseIssueRef('#12'), { number: 12, owner: null, repo: null })
  assert.deepEqual(parseIssueRef('Fixes #42 please'), { number: 42, owner: null, repo: null })
  assert.deepEqual(parseIssueRef('see #7.'), { number: 7, owner: null, repo: null })
  assert.deepEqual(parseIssueRef('#123'), { number: 123, owner: null, repo: null }, 'the whole digit run is the number')
})

test('parseIssueRef reads owner/repo references and GitHub URLs', () => {
  assert.deepEqual(parseIssueRef('owner/repo#7'), { number: 7, owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseIssueRef('my-org/my.repo#31'), { number: 31, owner: 'my-org', repo: 'my.repo' })
  assert.deepEqual(parseIssueRef('https://github.com/owner/repo/issues/12'), { number: 12, owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseIssueRef('https://github.com/owner/repo/issues/12/'), { number: 12, owner: 'owner', repo: 'repo' })
  assert.deepEqual(parseIssueRef('https://github.com/owner/repo/issues/12?foo=bar'), { number: 12, owner: 'owner', repo: 'repo' })
})

test('parseIssueRef rejects non-references and zero', () => {
  assert.equal(parseIssueRef('no ref'), null)
  assert.equal(parseIssueRef('#0'), null)
  assert.equal(parseIssueRef('#abc'), null)
  assert.equal(parseIssueRef(''), null)
  assert.equal(parseIssueRef(null), null)
  assert.equal(parseIssueRef(undefined), null)
  assert.equal(parseIssueRef(42), null)
  assert.deepEqual(parseIssueRef('#0 and #12'), { number: 12, owner: null, repo: null }, 'a later valid ref wins')
})

/* ------------------------------------------------------------- normalizeIssue */

test('normalizeIssue maps a GitHub issue', () => {
  const normalized = normalizeIssue('github', {
    number: 12,
    title: 'Fix login',
    body: 'Steps to reproduce',
    url: 'https://github.com/o/r/issues/12',
    labels: [{ name: 'bug' }, { name: 'p1' }],
  }, { label: 'bug', repo: 'o/r' })
  assert.deepEqual(normalized, {
    externalId: 'gh:o/r#12',
    title: 'Fix login',
    text: 'Steps to reproduce',
    url: 'https://github.com/o/r/issues/12',
    labels: ['bug', 'p1'],
    source: { kind: 'github', label: 'bug', repo: 'o/r' },
  })
})

test('normalizeIssue maps a GitLab issue with string labels', () => {
  const normalized = normalizeIssue('gitlab', {
    iid: 7,
    title: 'Docs',
    description: 'Body text',
    web_url: 'https://gitlab.com/g/p/-/issues/7',
    labels: ['docs', 'docs', ''],
  }, { repo: 'g/p' })
  assert.equal(normalized.externalId, 'gl:g/p#7')
  assert.equal(normalized.title, 'Docs')
  assert.equal(normalized.text, 'Body text')
  assert.equal(normalized.url, 'https://gitlab.com/g/p/-/issues/7')
  assert.deepEqual(normalized.labels, ['docs'], 'duplicates and blanks are dropped')
  assert.deepEqual(normalized.source, { kind: 'gitlab', label: null, repo: 'g/p' })
})

test('normalizeIssue flattens a Jira Atlassian document description', () => {
  const normalized = normalizeIssue('jira', {
    key: 'ABC-42',
    fields: {
      summary: 'Broken build',
      description: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First ' }, { type: 'text', text: 'line' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
        ],
      },
      labels: ['backend'],
    },
  }, { label: 'bug' })
  assert.equal(normalized.externalId, 'jira:ABC-42')
  assert.equal(normalized.title, 'Broken build')
  assert.equal(normalized.text, 'First line\nSecond paragraph')
  assert.equal(normalized.url, '')
  assert.deepEqual(normalized.labels, ['backend'])
  assert.deepEqual(normalized.source, { kind: 'jira', label: 'bug', repo: null })
})

test('normalizeIssue maps a Linear issue with label nodes', () => {
  const normalized = normalizeIssue('linear', {
    id: 'uuid-1',
    identifier: 'ENG-7',
    title: 'Add cache',
    description: 'Cache it',
    url: 'https://linear.app/x/issue/ENG-7',
    labels: { nodes: [{ name: 'infra' }, { name: 'infra' }, { name: ' ' }] },
  }, { label: 'infra' })
  assert.equal(normalized.externalId, 'lin:ENG-7')
  assert.equal(normalized.title, 'Add cache')
  assert.equal(normalized.text, 'Cache it')
  assert.equal(normalized.url, 'https://linear.app/x/issue/ENG-7')
  assert.deepEqual(normalized.labels, ['infra'])
  assert.deepEqual(normalized.source, { kind: 'linear', label: 'infra', repo: null })
})

test('normalizeIssue falls back for missing titles, text and repository', () => {
  const normalized = normalizeIssue('github', { number: 5 })
  assert.equal(normalized.externalId, 'gh:-#5')
  assert.equal(normalized.title, '(untitled)')
  assert.equal(normalized.text, '')
  assert.equal(normalized.url, '')
  assert.deepEqual(normalized.labels, [])
  assert.deepEqual(normalized.source, { kind: 'github', label: null, repo: null })
  assert.equal(normalizeIssue('jira', {}).title, '(untitled)', 'no fields or summary')
  assert.equal(normalizeIssue('gitlab', {}).text, '')
})

/* ---------------------------------------------------------- fetchGitHubIssue */

test('fetchGitHubIssue pins the repo with -R and normalizes the output', async () => {
  const { exec, calls } = makeExec(() => ({
    code: 0,
    stdout: JSON.stringify({ number: 12, title: 'Fix login', body: 'Steps', url: 'u', labels: [{ name: 'bug' }] }),
    stderr: '',
  }))
  const issue = await fetchGitHubIssue({ ref: { number: 12, owner: 'o', repo: 'r' }, cwd: 'C:\\work\\repo', exec })
  assert.equal(issue.externalId, 'gh:o/r#12')
  assert.equal(issue.title, 'Fix login')
  assert.deepEqual(issue.labels, ['bug'])
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args, ['issue', 'view', '12', '--json', FIELDS, '-R', 'o/r'])
  assert.deepEqual(calls[0].options, { cwd: 'C:\\work\\repo', timeout: 30000 })
})

test('fetchGitHubIssue omits -R without an owner and repo', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: JSON.stringify({ number: 3, title: 'T' }), stderr: '' }))
  const issue = await fetchGitHubIssue({ ref: { number: 3 }, exec })
  assert.equal(issue.externalId, 'gh:-#3')
  assert.deepEqual(calls[0].args, ['issue', 'view', '3', '--json', FIELDS])
  assert.deepEqual(calls[0].options, { cwd: '', timeout: 30000 })
})

test('fetchGitHubIssue returns null on every failure path', async () => {
  const failed = await fetchGitHubIssue({
    ref: { number: 12, owner: 'o', repo: 'r' },
    exec: async () => ({ code: 1, stdout: '', stderr: 'not found' }),
  })
  assert.equal(failed, null)

  const garbage = await fetchGitHubIssue({
    ref: { number: 12, owner: 'o', repo: 'r' },
    exec: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
  })
  assert.equal(garbage, null)

  const thrown = await fetchGitHubIssue({
    ref: { number: 12, owner: 'o', repo: 'r' },
    exec: async () => {
      throw new Error('spawn failed')
    },
  })
  assert.equal(thrown, null)

  const { exec, calls } = makeExec(() => ({ code: 0, stdout: '{}', stderr: '' }))
  assert.equal(await fetchGitHubIssue({ ref: null, exec }), null, 'no reference')
  assert.equal(await fetchGitHubIssue({ ref: { number: 0 }, exec }), null, 'invalid number')
  assert.equal(await fetchGitHubIssue({ ref: { number: 12 }, exec: null }), null, 'no exec')
  assert.equal(calls.length, 0, 'nothing ran for a bad reference')
})

/* ---------------------------------------------------------- readGitHubIssue */

test('readGitHubIssue returns the issue and no reason on success', async () => {
  const { exec } = makeExec(() => ({ code: 0, stdout: JSON.stringify({ number: 12, title: 'Fix login', url: 'u' }), stderr: '' }))
  const read = await readGitHubIssue({ ref: { number: 12, owner: 'o', repo: 'r' }, exec })
  assert.equal(read.reason, null)
  assert.equal(read.detail, '')
  assert.equal(read.issue.externalId, 'gh:o/r#12')
  assert.equal(read.issue.title, 'Fix login')
})

test('readGitHubIssue recovers the repository from the issue URL for a bare reference (#25)', async () => {
  const { exec } = makeExec(() => ({
    code: 0,
    stdout: JSON.stringify({ number: 12, title: 'Fix login', url: 'https://github.com/acme/repo/issues/12', labels: [] }),
    stderr: '',
  }))
  const read = await readGitHubIssue({ ref: { number: 12 }, exec })
  assert.equal(read.reason, null)
  assert.equal(read.issue.externalId, 'gh:acme/repo#12')
  assert.deepEqual(read.issue.source, { kind: 'github', label: null, repo: 'acme/repo' })
})

test('readGitHubIssue keeps an unknown repository when the URL is not a GitHub issue', async () => {
  const { exec } = makeExec(() => ({
    code: 0,
    stdout: JSON.stringify({ number: 3, title: 'No URL' }),
    stderr: '',
  }))
  const read = await readGitHubIssue({ ref: { number: 3 }, exec })
  assert.equal(read.issue.externalId, 'gh:-#3')
  assert.equal(read.issue.source.repo, null)
})

test('readGitHubIssue names why a gh lookup failed', async () => {
  const cases = [
    ['spawn gh ENOENT', 'gh-missing'],
    ["'gh' is not recognized as an internal or external command", 'gh-missing'],
    ['gh: command not found', 'gh-missing'],
    ['not logged in to any GitHub hosts. Run gh auth login', 'gh-auth'],
    ['HTTP 401: Bad credentials', 'gh-auth'],
    ['Could not resolve to a Repository with the name acme/missing.', 'repo-not-found'],
    ['Could not resolve to an issue or pull request with the number of 12.', 'not-found'],
    ['HTTP 404: Not Found', 'not-found'],
    ['dial tcp: i/o timeout', 'unavailable'],
  ]
  for (const [stderr, reason] of cases) {
    const read = await readGitHubIssue({
      ref: { number: 12, owner: 'acme', repo: 'repo' },
      exec: async () => ({ code: 1, stdout: '', stderr }),
    })
    assert.equal(read.reason, reason, stderr)
    assert.equal(read.issue, null)
    assert.ok(read.detail.length > 0, `a detail is kept for ${reason}`)
  }
})

test('readGitHubIssue keeps the first stderr line as the detail', async () => {
  const read = await readGitHubIssue({
    ref: { number: 12 },
    exec: async () => ({ code: 1, stdout: '', stderr: '\n  first line  \nsecond line\n' }),
  })
  assert.equal(read.reason, 'unavailable')
  assert.equal(read.detail, 'first line')
})

test('readGitHubIssue treats unreadable output and a thrown exec as failures', async () => {
  const garbage = await readGitHubIssue({
    ref: { number: 12 },
    exec: async () => ({ code: 0, stdout: 'not json', stderr: '' }),
  })
  assert.equal(garbage.reason, 'unreadable')
  assert.equal(garbage.issue, null)

  const array = await readGitHubIssue({
    ref: { number: 12 },
    exec: async () => ({ code: 0, stdout: '[]', stderr: '' }),
  })
  assert.equal(array.reason, 'unreadable')

  const thrown = await readGitHubIssue({
    ref: { number: 12 },
    exec: async () => {
      throw new Error('spawn failed')
    },
  })
  assert.equal(thrown.reason, 'unavailable')
  assert.equal(thrown.detail, 'spawn failed')
})

test('readGitHubIssue reports a bad reference without running gh', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: '{}', stderr: '' }))
  assert.equal((await readGitHubIssue({ ref: null, exec })).reason, 'bad-ref')
  assert.equal((await readGitHubIssue({ ref: { number: 0 }, exec })).reason, 'bad-ref')
  assert.equal((await readGitHubIssue({ ref: { number: '12x' }, exec })).reason, 'bad-ref')
  assert.equal((await readGitHubIssue({ ref: { number: 12 }, exec: null })).reason, 'bad-ref')
  assert.equal(calls.length, 0, 'nothing ran for a bad reference')
})

/* --------------------------------------------------------- listTrackerIssues */

test('listTrackerIssues lists GitHub issues with label and repo', async () => {
  const { exec, calls } = makeExec(() => ({
    code: 0,
    stdout: JSON.stringify([{ number: 3, title: 'A', body: 'a', url: 'u', labels: ['x'] }]),
    stderr: '',
  }))
  const result = await listTrackerIssues({ kind: 'github', config: { label: 'bug', repo: 'o/r' }, exec })
  assert.equal(result.error, null)
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].externalId, 'gh:o/r#3')
  assert.equal(result.issues[0].source.label, 'bug')
  assert.deepEqual(calls[0].args, [
    'issue', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS, '--label', 'bug', '-R', 'o/r',
  ])
  assert.deepEqual(calls[0].options, { timeout: 30000 })

  const bare = await listTrackerIssues({ kind: 'github', exec })
  assert.equal(bare.error, null)
  assert.deepEqual(calls[1].args, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS])
})

test('listTrackerIssues builds the GitLab URL, query and token header', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse([
    { iid: 5, title: 'GL', description: 'd', web_url: 'w', labels: ['a'] },
  ]))
  const result = await listTrackerIssues({
    kind: 'gitlab',
    config: { host: 'https://git.example.com/', project: 'group/project', token: 'tok', label: 'bug' },
    fetchFn,
  })
  assert.equal(result.error, null)
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].externalId, 'gl:group/project#5')
  assert.equal(calls[0].url, 'https://git.example.com/api/v4/projects/group%2Fproject/issues?state=opened&per_page=50&labels=bug')
  assert.deepEqual(calls[0].options.headers, { 'PRIVATE-TOKEN': 'tok' })
})

test('listTrackerIssues builds the Jira jql and the Basic auth header', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse({
    issues: [{ key: 'ABC-1', fields: { summary: 'S', description: 'D', labels: ['bug'] } }],
  }))
  const config = { baseUrl: 'https://jira.example.com/', email: 'me@example.com', token: 'secret', label: 'bug' }
  const result = await listTrackerIssues({ kind: 'jira', config, fetchFn })
  assert.equal(result.error, null)
  assert.equal(result.issues[0].externalId, 'jira:ABC-1')
  assert.equal(result.issues[0].title, 'S')
  assert.equal(result.issues[0].text, 'D')
  const jql = 'labels = "bug" AND statusCategory != Done'
  assert.equal(
    calls[0].url,
    `https://jira.example.com/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,description,labels`,
  )
  const header = calls[0].options.headers.Authorization
  assert.match(header, /^Basic /)
  assert.equal(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8'), 'me@example.com:secret')

  await listTrackerIssues({ kind: 'jira', config: { ...config, label: undefined }, fetchFn })
  assert.ok(calls[1].url.includes(encodeURIComponent('statusCategory != Done')))
})

test('listTrackerIssues posts the Linear GraphQL query with team and label', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse({
    data: {
      issues: {
        nodes: [{
          id: 'uuid-1',
          identifier: 'ENG-1',
          title: 'L',
          description: 'd',
          url: 'u',
          labels: { nodes: [{ name: 'bug' }] },
        }],
      },
    },
  }))
  const config = { apiKey: 'lin_key', teamId: 'team-1', label: 'bug' }
  const result = await listTrackerIssues({ kind: 'linear', config, fetchFn })
  assert.equal(result.error, null)
  assert.equal(result.issues[0].externalId, 'lin:ENG-1')
  assert.equal(calls[0].url, 'https://api.linear.app/graphql')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json', Authorization: 'lin_key' })
  const body = JSON.parse(calls[0].options.body)
  assert.match(body.query, /issues\(first: 50/)
  assert.match(body.query, /\$teamId/)
  assert.match(body.query, /labels: \{ some: \{ name: \{ eq: \$label \} \} \}/)
  assert.deepEqual(body.variables, { teamId: 'team-1', label: 'bug' })

  await listTrackerIssues({ kind: 'linear', config: { ...config, label: '' }, fetchFn })
  const bare = JSON.parse(calls[1].options.body)
  assert.equal(bare.variables.label, undefined, 'no label filter')
  assert.ok(!bare.query.includes('$label'))
})

test('listTrackerIssues reports HTTP statuses, transport failures and bad payloads', async () => {
  const denied = await listTrackerIssues({
    kind: 'gitlab',
    config: { project: 'g/p', token: 't' },
    fetchFn: async () => jsonResponse({ message: 'denied' }, 401),
  })
  assert.deepEqual(denied.issues, [])
  assert.match(denied.error, /401/)

  const offline = await listTrackerIssues({
    kind: 'jira',
    config: { baseUrl: 'https://jira', email: 'e', token: 't' },
    fetchFn: async () => {
      throw new Error('offline')
    },
  })
  assert.deepEqual(offline.issues, [])
  assert.equal(offline.error, 'offline')

  const ghFailed = await listTrackerIssues({
    kind: 'github',
    exec: async () => ({ code: 1, stdout: '', stderr: 'gh: not logged in' }),
  })
  assert.deepEqual(ghFailed.issues, [])
  assert.equal(ghFailed.error, 'gh: not logged in')

  const ghGarbage = await listTrackerIssues({
    kind: 'github',
    exec: async () => ({ code: 0, stdout: 'nope', stderr: '' }),
  })
  assert.deepEqual(ghGarbage.issues, [])
  assert.match(ghGarbage.error, /invalid/i)

  const linearErrors = await listTrackerIssues({
    kind: 'linear',
    config: { apiKey: 'k', teamId: 't' },
    fetchFn: async () => jsonResponse({ errors: [{ message: 'bad team' }] }),
  })
  assert.deepEqual(linearErrors.issues, [])
  assert.match(linearErrors.error, /bad team/)
})

test('listTrackerIssues reports unknown kinds and missing GitHub exec', async () => {
  assert.deepEqual(await listTrackerIssues({ kind: 'asana' }), { issues: [], error: 'unknown-tracker' })
  assert.deepEqual(await listTrackerIssues({}), { issues: [], error: 'unknown-tracker' })
  const noExec = await listTrackerIssues({ kind: 'github' })
  assert.deepEqual(noExec.issues, [])
  assert.match(noExec.error, /exec/)
})

/* ------------------------------------------------------- commentTrackerIssue */

test('commentTrackerIssue posts a GitHub comment with the repo', async () => {
  const { exec, calls } = makeExec(() => ({ code: 0, stdout: '', stderr: '' }))
  const result = await commentTrackerIssue({ kind: 'github', externalId: 'gh:o/r#12', body: 'Done', exec })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args, ['issue', 'comment', '12', '--body', 'Done', '-R', 'o/r'])
  assert.deepEqual(calls[0].options, { timeout: 30000 })

  const unknownRepo = await commentTrackerIssue({ kind: 'github', externalId: 'gh:-#7', body: 'Done', exec })
  assert.deepEqual(unknownRepo, { ok: true, error: null })
  assert.deepEqual(calls[1].args, ['issue', 'comment', '7', '--body', 'Done'], 'no -R for an unknown repo')
})

test('commentTrackerIssue posts a GitLab note', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse({ id: 1 }, 201))
  const result = await commentTrackerIssue({
    kind: 'gitlab',
    config: { project: 'g/p', token: 'tok' },
    externalId: 'gl:g/p#5',
    body: 'Done',
    fetchFn,
  })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(calls[0].url, 'https://gitlab.com/api/v4/projects/g%2Fp/issues/5/notes')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['PRIVATE-TOKEN'], 'tok')
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: 'Done' })
})

test('commentTrackerIssue posts a Jira document comment', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse({ id: '10000' }, 201))
  const result = await commentTrackerIssue({
    kind: 'jira',
    config: { baseUrl: 'https://jira.example.com', email: 'me@example.com', token: 'secret' },
    externalId: 'jira:ABC-9',
    body: 'Done',
    fetchFn,
  })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(calls[0].url, 'https://jira.example.com/rest/api/3/issue/ABC-9/comment')
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
    },
  })
  const header = calls[0].options.headers.Authorization
  assert.equal(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8'), 'me@example.com:secret')
})

test('commentTrackerIssue posts a Linear comment mutation', async () => {
  const { fetchFn, calls } = makeFetch(() => jsonResponse({ data: { commentCreate: { success: true } } }))
  const result = await commentTrackerIssue({
    kind: 'linear',
    config: { apiKey: 'lin_key' },
    externalId: 'lin:ENG-7',
    body: 'Done',
    fetchFn,
  })
  assert.deepEqual(result, { ok: true, error: null })
  assert.equal(calls[0].url, 'https://api.linear.app/graphql')
  const body = JSON.parse(calls[0].options.body)
  assert.match(body.query, /commentCreate/)
  assert.match(body.query, /issueId/)
  assert.deepEqual(body.variables, { issueId: 'ENG-7', body: 'Done' })
  assert.equal(calls[0].options.headers.Authorization, 'lin_key')
})

test('commentTrackerIssue returns ok:false when the tracker fails', async () => {
  const ghFailed = await commentTrackerIssue({
    kind: 'github',
    externalId: 'gh:o/r#12',
    body: 'Done',
    exec: async () => ({ code: 1, stdout: '', stderr: 'forbidden' }),
  })
  assert.deepEqual(ghFailed, { ok: false, error: 'forbidden' })

  const glDenied = await commentTrackerIssue({
    kind: 'gitlab',
    config: { project: 'g/p', token: 'tok' },
    externalId: 'gl:g/p#5',
    body: 'Done',
    fetchFn: async () => jsonResponse({}, 500),
  })
  assert.equal(glDenied.ok, false)
  assert.match(glDenied.error, /500/)

  const unknown = await commentTrackerIssue({ kind: 'asana', externalId: 'x', body: 'Done' })
  assert.deepEqual(unknown, { ok: false, error: 'unknown-tracker' })

  const badId = await commentTrackerIssue({ kind: 'github', externalId: 'whatever', body: 'Done', exec: async () => ({ code: 0 }) })
  assert.equal(badId.ok, false)
  assert.ok(badId.error.length > 0)
})

/* ------------------------------------------------------------ trackerProblems */

test('trackerProblems accepts every ready configuration', () => {
  assert.deepEqual(trackerProblems({ kind: 'github' }), [])
  assert.deepEqual(trackerProblems({ kind: 'github', label: 'bug', repo: 'o/r', commentBack: true }), [])
  assert.deepEqual(trackerProblems({ kind: 'gitlab', project: 'g/p', token: 'tok', label: 'bug' }), [])
  assert.deepEqual(trackerProblems({ kind: 'jira', baseUrl: 'https://jira', email: 'e', token: 't', label: 'bug' }), [])
  assert.deepEqual(trackerProblems({ kind: 'linear', apiKey: 'k', teamId: 't', label: 'bug' }), [])
})

test('trackerProblems reports every missing field', () => {
  assert.deepEqual(trackerProblems({}), ['unknown-tracker'])
  assert.deepEqual(trackerProblems({ kind: 'asana' }), ['unknown-tracker'])
  assert.deepEqual(trackerProblems(null), ['unknown-tracker'])

  const gitlab = trackerProblems({ kind: 'gitlab' })
  assert.equal(gitlab.length, 2)
  assert.ok(gitlab.some((problem) => problem.includes('project')))
  assert.ok(gitlab.some((problem) => problem.includes('token')))
  assert.deepEqual(trackerProblems({ kind: 'gitlab', project: 'g/p', token: '  ' }).length, 1)

  const jira = trackerProblems({ kind: 'jira' })
  assert.equal(jira.length, 3)
  assert.ok(jira.some((problem) => problem.includes('baseUrl')))
  assert.ok(jira.some((problem) => problem.includes('email')))
  assert.ok(jira.some((problem) => problem.includes('token')))

  const linear = trackerProblems({ kind: 'linear', apiKey: 'k' })
  assert.equal(linear.length, 1)
  assert.ok(linear[0].includes('teamId'))
})

test('trackerProblems validates label and commentBack types', () => {
  assert.equal(trackerProblems({ kind: 'github', label: 42 }).length, 1)
  assert.equal(trackerProblems({ kind: 'github', label: '' }).length, 1)
  assert.equal(trackerProblems({ kind: 'github', label: '   ' }).length, 1)
  assert.equal(trackerProblems({ kind: 'github', commentBack: 'yes' }).length, 1)
  assert.equal(trackerProblems({ kind: 'github', commentBack: true }).length, 0)
  assert.equal(trackerProblems({ kind: 'gitlab', project: 'p', token: 't', commentBack: 1 }).length, 1)
})
