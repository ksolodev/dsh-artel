import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import checkModule, {
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_OUTPUT_BYTES,
  freeDiskBytes,
  runCheck,
  scanHygiene,
  scanOutward,
  suggestCheckCommand,
} from '../lib/check.js'

const TMP_ROOT = path.join(process.cwd(), 'test', '.tmp')

/** Create a uniquely named directory under test/.tmp for one test. */
async function freshDir(name) {
  const dir = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Write { relativePath: content } files below root. */
async function makeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content)
  }
}

/** Remove test directories, never failing the test on a cleanup error. */
async function cleanUp(...dirs) {
  for (const dir of dirs) {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Build a Windows-safe `node -e` command line for the current executable. */
function nodeEval(script) {
  return `"${process.execPath}" -e ${JSON.stringify(script)}`
}

/** Build a change entry shaped like lib/copy.js, with the given added lines. */
function addedChange(filePath, lines, extra = {}) {
  const hunks = lines.length === 0
    ? []
    : [{ header: '@@ -0,0 +1', lines: lines.map((text) => ({ type: 'add', text })) }]
  return { path: filePath, status: 'added', added: lines.length, removed: 0, binary: false, hunks, ...extra }
}

/* ------------------------------------------------------------ module contract */

test('exposes the documented constants and default export', () => {
  assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 15 * 60 * 1000)
  assert.equal(MAX_CHECK_OUTPUT_BYTES, 40000)
  assert.equal(checkModule.DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS)
  assert.equal(checkModule.MAX_CHECK_OUTPUT_BYTES, MAX_CHECK_OUTPUT_BYTES)
  for (const name of ['suggestCheckCommand', 'runCheck', 'scanHygiene', 'scanOutward', 'freeDiskBytes']) {
    assert.equal(typeof checkModule[name], 'function', `default export exposes ${name}`)
  }
})

/* ------------------------------------------------------- suggestCheckCommand */

test('suggestCheckCommand prefers check, then descends the package.json script order', async () => {
  const allScripts = await freshDir('suggest-all')
  const placeholderThenBuild = await freshDir('suggest-placeholder')
  const testOnly = await freshDir('suggest-test')
  try {
    await makeTree(allScripts, {
      'package.json': JSON.stringify({
        scripts: {
          build: 'tsc',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'node --test',
          check: 'npm run lint && npm test',
        },
      }),
    })
    assert.deepEqual(await suggestCheckCommand({ projectPath: allScripts }), {
      command: 'npm run check',
      source: 'package.json:check',
    })

    await makeTree(placeholderThenBuild, {
      'package.json': JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' },
      }),
    })
    assert.deepEqual(await suggestCheckCommand({ projectPath: placeholderThenBuild }), {
      command: 'npm run build',
      source: 'package.json:build',
    })

    await makeTree(testOnly, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    assert.deepEqual(await suggestCheckCommand({ projectPath: testOnly }), {
      command: 'npm test',
      source: 'package.json:test',
    })
  } finally {
    await cleanUp(allScripts, placeholderThenBuild, testOnly)
  }
})

test('suggestCheckCommand returns null when nothing is detectable', async () => {
  const placeholderOnly = await freshDir('suggest-placeholder-only')
  const empty = await freshDir('suggest-empty')
  try {
    await makeTree(placeholderOnly, {
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    })
    assert.equal(await suggestCheckCommand({ projectPath: placeholderOnly }), null)
    assert.equal(await suggestCheckCommand({ projectPath: empty }), null)
    assert.equal(await suggestCheckCommand({ projectPath: '' }), null)
    assert.equal(await suggestCheckCommand({}), null)
    assert.equal(await suggestCheckCommand({ projectPath: path.join(TMP_ROOT, 'no-such-project') }), null)
  } finally {
    await cleanUp(placeholderOnly, empty)
  }
})

test('suggestCheckCommand detects a Makefile test target and survives a broken package.json', async () => {
  const withTarget = await freshDir('suggest-make')
  const withoutTarget = await freshDir('suggest-make-empty')
  const brokenManifest = await freshDir('suggest-broken-json')
  try {
    await makeTree(withTarget, { Makefile: 'build:\n\tnode -e "process.exit(0)"\n\ntest:\n\tnode --test\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: withTarget }), {
      command: 'make test',
      source: 'Makefile',
    })

    await makeTree(withoutTarget, { Makefile: 'build:\n\techo hi\n' })
    assert.equal(await suggestCheckCommand({ projectPath: withoutTarget }), null)

    await makeTree(brokenManifest, {
      'package.json': '{ not json',
      Makefile: 'test:\n\tnode --test\n',
    })
    assert.deepEqual(await suggestCheckCommand({ projectPath: brokenManifest }), {
      command: 'make test',
      source: 'Makefile',
    })
  } finally {
    await cleanUp(withTarget, withoutTarget, brokenManifest)
  }
})

test('suggestCheckCommand falls back to Cargo, Go and Python manifests', async () => {
  const dirs = {
    cargo: await freshDir('suggest-cargo'),
    go: await freshDir('suggest-go'),
    pyproject: await freshDir('suggest-pyproject'),
    tests: await freshDir('suggest-tests'),
    pytestIni: await freshDir('suggest-pytest-ini'),
    requirements: await freshDir('suggest-requirements'),
  }
  try {
    await makeTree(dirs.cargo, { 'Cargo.toml': '[package]\nname = "demo"\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: dirs.cargo }), {
      command: 'cargo test',
      source: 'Cargo.toml',
    })

    await makeTree(dirs.go, { 'go.mod': 'module example.com/demo\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: dirs.go }), {
      command: 'go test ./...',
      source: 'go.mod',
    })

    await makeTree(dirs.pyproject, { 'pyproject.toml': '[tool.pytest.ini_options]\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: dirs.pyproject }), {
      command: 'pytest',
      source: 'pyproject.toml',
    })

    await makeTree(dirs.tests, { 'tests/test_demo.py': 'def test_demo():\n    assert True\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: dirs.tests }), {
      command: 'pytest',
      source: 'tests/',
    })

    await makeTree(dirs.pytestIni, { 'pytest.ini': '[pytest]\n' })
    assert.deepEqual(await suggestCheckCommand({ projectPath: dirs.pytestIni }), {
      command: 'pytest',
      source: 'pytest.ini',
    })

    // A requirements.txt that merely lists pytest does not prove there are tests.
    await makeTree(dirs.requirements, { 'requirements.txt': 'pytest\n' })
    assert.equal(await suggestCheckCommand({ projectPath: dirs.requirements }), null)
  } finally {
    await cleanUp(dirs.cargo, dirs.go, dirs.pyproject, dirs.tests, dirs.pytestIni, dirs.requirements)
  }
})

test('suggestCheckCommand reads only package.json through an injected reader', async () => {
  const readPaths = []
  const readerFor = (scripts) => async (filePath) => {
    const name = path.basename(filePath)
    readPaths.push(name)
    if (name === 'package.json') return JSON.stringify({ scripts })
    throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' })
  }
  const virtualProject = path.join(TMP_ROOT, 'virtual-project')

  readPaths.length = 0
  assert.deepEqual(
    await suggestCheckCommand({
      projectPath: virtualProject,
      readFile: readerFor({ build: 'tsc', lint: 'eslint .', test: 'node --test', check: 'npm run lint && npm test' }),
    }),
    { command: 'npm run check', source: 'package.json:check' },
  )
  assert.equal(readPaths[0], 'package.json')
  assert.ok(!readPaths.includes('tests'), 'an injected reader never triggers a real directory probe')

  readPaths.length = 0
  assert.deepEqual(
    await suggestCheckCommand({
      projectPath: virtualProject,
      readFile: readerFor({ test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit' }),
    }),
    { command: 'npm run typecheck', source: 'package.json:typecheck' },
  )

  readPaths.length = 0
  assert.equal(
    await suggestCheckCommand({
      projectPath: virtualProject,
      readFile: readerFor({ test: 'echo "Error: no test specified" && exit 1' }),
    }),
    null,
  )
  assert.ok(readPaths.includes('Makefile'), 'other manifests are still consulted through the reader')
})

/* ---------------------------------------------------------------- runCheck */

test('runCheck resolves a successful command', async () => {
  const dir = await freshDir('run-ok')
  const command = nodeEval('process.exit(0)')
  try {
    const result = await runCheck({ command, cwd: dir, timeoutMs: 30000 })
    assert.equal(result.ok, true)
    assert.equal(result.command, command)
    assert.equal(result.cwd, dir)
    assert.equal(result.code, 0)
    assert.equal(result.signal, null)
    assert.equal(result.timedOut, false)
    assert.equal(result.output, '')
    assert.equal(typeof result.durationMs, 'number')
    assert.ok(result.durationMs >= 0)
  } finally {
    await cleanUp(dir)
  }
})

test('runCheck reports a non-zero exit as data without throwing', async () => {
  const dir = await freshDir('run-fail')
  try {
    const result = await runCheck({
      command: nodeEval("process.stderr.write('boom-output'); process.exit(3)"),
      cwd: dir,
      timeoutMs: 30000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 3)
    assert.equal(result.timedOut, false)
    assert.ok(result.output.length > 0)
    assert.match(result.output, /boom-output/)
  } finally {
    await cleanUp(dir)
  }
})

test('runCheck treats an unknown command as a failed run', async () => {
  const dir = await freshDir('run-unknown')
  try {
    const result = await runCheck({
      command: 'artel-command-that-does-not-exist --version',
      cwd: dir,
      timeoutMs: 30000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
  } finally {
    await cleanUp(dir)
  }
})

test('runCheck rejects a missing command but not a non-zero exit', async () => {
  await assert.rejects(() => runCheck({ command: '' }), /command/)

  const missingCwd = path.join(TMP_ROOT, `missing-cwd-${Date.now()}`)
  await assert.rejects(
    () => runCheck({ command: nodeEval('process.exit(0)'), cwd: missingCwd, timeoutMs: 30000 }),
    (error) => error instanceof Error,
  )
})

test('runCheck kills a command that outlives its timeout', async () => {
  const dir = await freshDir('run-timeout')
  const startedAt = Date.now()
  try {
    const result = await runCheck({
      command: nodeEval('setTimeout(() => {}, 5000)'),
      cwd: dir,
      timeoutMs: 200,
    })
    const elapsedMs = Date.now() - startedAt
    assert.equal(result.timedOut, true)
    assert.equal(result.ok, false)
    assert.ok(result.code === null || typeof result.code === 'number')
    assert.ok(elapsedMs < 5000, `the child was killed after ${elapsedMs}ms`)
  } finally {
    await cleanUp(dir)
  }
})

test('runCheck keeps only the tail of a long output', async () => {
  const dir = await freshDir('run-tail')
  const marker = 'LAST-LINE-MARKER'
  const command = nodeEval(`process.stdout.write('A'.repeat(4000)); process.stdout.write('${marker}')`)
  try {
    const result = await runCheck({ command, cwd: dir, timeoutMs: 30000, maxOutputBytes: 100 })
    assert.equal(result.ok, true)
    assert.ok(result.output.length <= 130, `trimmed output was ${result.output.length} characters`)
    assert.ok(result.output.includes('output trimmed'), 'the trimming notice is present')
    assert.ok(result.output.endsWith(marker), 'the newest text survives trimming')
  } finally {
    await cleanUp(dir)
  }
})

/* -------------------------------------------------------------- scanHygiene */

test('scanHygiene flags secret and junk paths without opening files', async () => {
  const changes = [
    { path: '.env', status: 'modified', added: 1, removed: 0, binary: false, hunks: [] },
    { path: 'deploy/id_ed25519', status: 'added', binary: false, hunks: [] },
    { path: 'assets/.DS_Store', status: 'added', binary: false, hunks: [] },
    { path: 'node_modules/pkg/index.js', status: 'modified', binary: false, hunks: [] },
    { path: 'debug.log', status: 'added', binary: false, hunks: [] },
  ]
  const { findings } = await scanHygiene({ changes })
  assert.equal(findings.length, 5)
  assert.equal(findings.filter((finding) => finding.kind === 'secret').length, 2)
  assert.equal(findings.filter((finding) => finding.kind === 'junk').length, 3)
  assert.deepEqual(
    findings.filter((finding) => finding.kind === 'secret').map((finding) => finding.path),
    ['.env', 'deploy/id_ed25519'],
  )
  for (const finding of findings) {
    assert.equal(typeof finding.detail, 'string')
    assert.ok(finding.detail.length > 0)
  }
})

test('scanHygiene scans added hunk lines for credential shapes', async () => {
  const { findings } = await scanHygiene({
    changes: [
      addedChange('src/config.js', [
        'export const retries = 2',
        'const apiKey = "sk-abcdefghijklmnopqrstuv"',
      ]),
    ],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].path, 'src/config.js')
  assert.equal(findings[0].kind, 'secret')
  assert.ok(findings[0].detail.length <= 80)
})

test('scanHygiene accepts raw diff strings and ignores removed lines', async () => {
  const rawAdd = {
    path: 'config/settings.js',
    status: 'modified',
    binary: false,
    hunks: [{ header: '@@ -1 +1 @@', lines: ['+password = "supersecretvalue"'] }],
  }
  const rawDel = {
    path: 'docs/old.md',
    status: 'modified',
    binary: false,
    hunks: [{ header: '@@ -1 +1 @@', lines: ['-token = "abcdefghijklmnop"', '+export const ok = true'] }],
  }
  const { findings } = await scanHygiene({ changes: [rawAdd, rawDel] })
  assert.deepEqual(findings, [
    { path: 'config/settings.js', kind: 'secret', detail: 'password = "supersecretvalue"' },
  ])
})

test('scanHygiene scans the lib/diff.js line shape and caps long details', async () => {
  const diffShape = {
    path: 'src/auth.js',
    status: 'modified',
    binary: false,
    hunks: [
      {
        header: '@@ -1 +1 @@',
        lines: [
          { type: 'context', text: 'const token = "aaaaaaaaaaaaaaaa"' },
          { type: 'del', text: 'const token = "removedvalue12345"' },
          { type: '+', text: 'const token = "abcdefgh12345678"' },
        ],
      },
    ],
  }
  const longFake = 'sk-'.concat('a'.repeat(200))
  const longChange = addedChange('src/deep.js', [`const key = "${longFake}"`])
  const { findings } = await scanHygiene({ changes: [diffShape, longChange] })
  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map((finding) => finding.path), ['src/auth.js', 'src/deep.js'])
  for (const finding of findings) assert.equal(finding.kind, 'secret')
  assert.equal(findings[1].detail.length, 80)
  assert.ok(findings[1].detail.endsWith('…'), 'a long token is truncated, never kept whole')
})

test('scanHygiene reads an added file with no hunk text from rootDir', async () => {
  const dir = await freshDir('hygiene-read')
  try {
    await makeTree(dir, { 'src/creds.js': 'export const port = 8080\nconst token = "abcdefgh12345678"\n' })
    const { findings } = await scanHygiene({
      changes: [addedChange('src/creds.js', [])],
      rootDir: dir,
    })
    assert.equal(findings.length, 1)
    assert.equal(findings[0].path, 'src/creds.js')
    assert.equal(findings[0].kind, 'secret')
  } finally {
    await cleanUp(dir)
  }
})

test('scanHygiene reads added content through an injected reader', async () => {
  const reads = []
  const { findings } = await scanHygiene({
    changes: [addedChange('src/creds.js', [])],
    rootDir: path.join('C:', 'virtual'),
    readFile: async (filePath) => {
      reads.push(filePath)
      return 'const token = "abcdefgh12345678"\n'
    },
  })
  assert.equal(reads.length, 1)
  assert.ok(reads[0].endsWith('creds.js'))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'secret')
})

test('scanHygiene stays quiet on clean text, skips binary changes and deduplicates', async () => {
  const { findings } = await scanHygiene({
    changes: [
      addedChange('src/app.js', ['export const answer = 1']),
      {
        path: 'logo.png',
        status: 'modified',
        binary: true,
        hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', text: 'const apiKey = "sk-abcdefghijklmnopqrstuv"' }] }],
      },
      addedChange('src/multi.js', [
        'const apiKey = "sk-abcdefghijklmnopqrstuv"',
        'const token = "abcdefgh12345678"',
      ]),
    ],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].path, 'src/multi.js')
  assert.equal(findings[0].kind, 'secret')
})

/* -------------------------------------------------------------- scanOutward */

test('scanOutward catches real outward actions', () => {
  const cases = [
    'I ran git push origin main',
    'npm publish --access public',
    'gh pr create --title x',
    'curl -X POST https://x',
    'docker push ghcr.io/acme/app',
    'kubectl apply -f k8s/',
    'helm upgrade app chart',
    'aws s3 cp dist/ s3://bucket/',
    'gcloud run deploy my-service',
    'vercel deploy --prod',
    'netlify deploy --prod',
    'fly deploy',
    'yarn publish',
    'pnpm publish',
  ]
  for (const text of cases) {
    const phrase = scanOutward(text)
    assert.ok(phrase, `expected a match for: ${text}`)
    assert.equal(typeof phrase, 'string')
    assert.ok(phrase.length <= 80, `phrase for "${text}" is too long: ${phrase.length}`)
  }
  assert.match(scanOutward('I ran git push origin main'), /git push/)
  assert.match(scanOutward('npm publish --access public'), /npm publish/)
  assert.match(scanOutward('gh pr create --title x'), /gh pr create/)
  assert.match(scanOutward('curl -X POST https://x'), /curl/)
})

test('scanOutward ignores local and harmless commands', () => {
  const safe = [
    'git status',
    'git commit -m "x"',
    'npm test',
    'npm run build',
    'curl https://example.com',
    'gh issue view 12',
    '',
  ]
  for (const text of safe) {
    assert.equal(scanOutward(text), null, `expected no match for: ${text}`)
  }
  assert.equal(scanOutward(undefined), null)
  assert.equal(scanOutward(null), null)
})

test('scanOutward caps the phrase it reports, even from long prose', () => {
  const longLine = `${'x'.repeat(200)} npm publish ${'y'.repeat(200)}`
  const phrase = scanOutward(longLine)
  assert.ok(phrase)
  assert.ok(phrase.length <= 80)
  assert.match(phrase, /npm publish/)
})

/* ------------------------------------------------------------- freeDiskBytes */

test('freeDiskBytes reports bytes or null and never throws', async () => {
  const bytes = await freeDiskBytes(os.tmpdir())
  assert.ok(bytes === null || (typeof bytes === 'number' && bytes > 0), `got ${String(bytes)}`)

  const missing = await freeDiskBytes(path.join(TMP_ROOT, `missing-volume-${Date.now()}`))
  assert.equal(missing, null)
})
