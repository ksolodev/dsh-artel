import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONDUCTOR_ADDRESS,
  MAX_REWORK_ROUNDS,
  REWORK_MARKER,
  SHARES_MARKER,
  VERDICT_MARKER,
  capText,
  changeDigest,
  failureKindOf,
  leastLoadedName,
  parseShares,
  parseVerdict,
} from '../lib/conductor.js'
import {
  conductorDecidePrompt,
  conductorHandoverPrompt,
  conductorPlanPrompt,
  conductorReviewPrompt,
  conductorReworkPrompt,
  conductorShareUpdatePrompt,
  conductorWorkerGoPrompt,
  conductorWorkerPlanPrompt,
} from '../lib/prompts.js'

const WORKERS = ['Iris', 'Juno', 'Rover']

test('conductor constants match the contract', () => {
  assert.equal(CONDUCTOR_ADDRESS, 'conductor')
  assert.equal(SHARES_MARKER, 'SHARES:')
  assert.equal(VERDICT_MARKER, 'VERDICT:')
  assert.equal(REWORK_MARKER, 'REWORK:')
  assert.equal(MAX_REWORK_ROUNDS, 2)
})

/* ----------------------------------------------------------------- shares */

test('parseShares approves the proposal on a whole-line approve', () => {
  assert.deepEqual(parseShares('SHARES: approve', WORKERS), { mode: 'approve', entries: [], unknown: [] })
  assert.deepEqual(parseShares('  shares: APPROVE  ', WORKERS), { mode: 'approve', entries: [], unknown: [] })
})

test('parseShares rebuilds the assignments from one line per worker', () => {
  const text = `The areas look good.\nSHARES: Iris = src/api/**, src/types.ts\nSHARES: Juno = docs/**\nSHARES: Rover = README.md; package.json`
  assert.deepEqual(parseShares(text, WORKERS), {
    mode: 'assign',
    entries: [
      { name: 'Iris', paths: ['src/api/**', 'src/types.ts'] },
      { name: 'Juno', paths: ['docs/**'] },
      { name: 'Rover', paths: ['README.md', 'package.json'] },
    ],
    unknown: [],
  })
})

test('parseShares treats none/nothing/placeholder values as an empty share', () => {
  assert.deepEqual(parseShares('SHARES: Juno = none', WORKERS).entries, [{ name: 'Juno', paths: [] }])
  assert.deepEqual(parseShares('SHARES: Juno = nothing', WORKERS).entries, [{ name: 'Juno', paths: [] }])
  assert.deepEqual(parseShares('SHARES: Juno = —', WORKERS).entries, [{ name: 'Juno', paths: [] }])
  assert.deepEqual(parseShares('SHARES: Juno = nothing; —', WORKERS).entries, [{ name: 'Juno', paths: [] }])
  assert.deepEqual(parseShares('SHARES: Juno = none, docs/a.md', WORKERS).entries, [{ name: 'Juno', paths: ['docs/a.md'] }])
})

test('parseShares keeps raw path strings and matches worker names case-insensitively', () => {
  const parsed = parseShares('SHARES: iris = `src/app.js`\nSHARES: JUNO = docs', WORKERS)
  assert.equal(parsed.mode, 'assign')
  assert.deepEqual(parsed.entries, [
    { name: 'Iris', paths: ['`src/app.js`'] },
    { name: 'Juno', paths: ['docs'] },
  ])
})

test('parseShares drops duplicate names to the last line', () => {
  const parsed = parseShares('SHARES: Iris = old.js\nSHARES: Iris = new.js\nSHARES: Juno = docs', WORKERS)
  assert.deepEqual(parsed.entries, [
    { name: 'Iris', paths: ['new.js'] },
    { name: 'Juno', paths: ['docs'] },
  ])
})

test('parseShares reports unknown names without turning them into entries', () => {
  const parsed = parseShares('SHARES: Iris = src/a.js\nSHARES: Ghost = src/b.js\nSHARES: Nobody = none', WORKERS)
  assert.equal(parsed.mode, 'assign')
  assert.deepEqual(parsed.entries, [{ name: 'Iris', paths: ['src/a.js'] }])
  assert.deepEqual(parsed.unknown, ['Ghost', 'Nobody'])
  // Unknown names alone are not a decision at all.
  assert.equal(parseShares('SHARES: Ghost = src/b.js', WORKERS).mode, 'missing')
})

test('parseShares lets entries win over approve and returns missing without a marker', () => {
  const mixed = parseShares('SHARES: approve\nSHARES: Iris = src/a.js', WORKERS)
  assert.equal(mixed.mode, 'assign')
  assert.match(parseShares('SHARES: approve', WORKERS).mode, /approve/)
  assert.deepEqual(parseShares('', WORKERS), { mode: 'missing', entries: [], unknown: [] })
  assert.deepEqual(parseShares(undefined, WORKERS), { mode: 'missing', entries: [], unknown: [] })
  assert.deepEqual(parseShares('I approve the distribution.', WORKERS), { mode: 'missing', entries: [], unknown: [] })
  assert.equal(parseShares('- SHARES: Iris = src/a.js', []).mode, 'missing', 'no worker list means no known names')
})

/* ---------------------------------------------------------------- verdict */

test('parseVerdict reads accept and rework verdicts with their notes', () => {
  const accepted = parseVerdict('VERDICT: accept — every check passes and the task is closed')
  assert.deepEqual(accepted, { verdict: 'accept', notes: 'every check passes and the task is closed', reworkNames: [] })

  const rework = parseVerdict('Read everything first.\nVERDICT: rework — the API branch still returns the old error\nREWORK: Iris, Rover')
  assert.equal(rework.verdict, 'rework')
  assert.equal(rework.notes, 'the API branch still returns the old error')
  assert.deepEqual(rework.reworkNames, ['Iris', 'Rover'])
})

test('parseVerdict falls back to the prose after an empty verdict line', () => {
  const parsed = parseVerdict('VERDICT: accept\nEverything matches the task.\nThe checks pass on the whole copy.\nREWORK: Iris')
  assert.equal(parsed.verdict, 'accept')
  assert.equal(parsed.notes, 'Everything matches the task. The checks pass on the whole copy.')
  assert.deepEqual(parsed.reworkNames, [])
})

test('parseVerdict reads the last verdict and requires a word boundary', () => {
  assert.equal(parseVerdict('VERDICT: rework — first\nVERDICT: accept — final').verdict, 'accept')
  assert.equal(parseVerdict('VERDICT: accepted').verdict, 'missing')
  assert.equal(parseVerdict('VERDICT: maybe later').verdict, 'missing')
  assert.deepEqual(parseVerdict('looks good to me'), { verdict: 'missing', notes: '', reworkNames: [] })
  assert.deepEqual(parseVerdict(null), { verdict: 'missing', notes: '', reworkNames: [] })
})

test('parseVerdict expands REWORK all/everyone/* to the whole team', () => {
  for (const everyone of ['all', 'everyone', '*', 'ALL']) {
    const parsed = parseVerdict(`VERDICT: rework — not done\nREWORK: ${everyone}`)
    assert.deepEqual(parsed.reworkNames, [], `${everyone} means every worker`)
  }
  assert.deepEqual(parseVerdict('VERDICT: rework — not done').reworkNames, [])
  assert.deepEqual(parseVerdict('VERDICT: rework — not done\nREWORK: Rover').reworkNames, ['Rover'], 'case is preserved')
})

test('parseVerdict caps very long notes', () => {
  const parsed = parseVerdict(`VERDICT: accept — ${'x'.repeat(2000)}`)
  assert.equal(parsed.notes.length, 1201)
  assert.ok(parsed.notes.endsWith('…'))
})

/* ---------------------------------------------------------------- failures */

test('failureKindOf knows every displayed kind and rejects the rest', () => {
  for (const kind of ['error', 'max-tokens', 'blocked', 'aborted', 'interrupted']) {
    assert.equal(failureKindOf({ kind }), kind)
  }
  assert.equal(failureKindOf({ kind: 'unknown' }), null)
  assert.equal(failureKindOf({}), null)
  assert.equal(failureKindOf(null), null)
  assert.equal(failureKindOf(undefined), null)
  assert.equal(failureKindOf('error'), null)
  assert.equal(failureKindOf({ kind: 42 }), null)
})

/* ------------------------------------------------------------------ digest */

test('changeDigest renders statuses, counts and binaries', () => {
  const digest = changeDigest([
    { path: 'src/app.js', status: 'modified', added: 3, removed: 1, binary: false },
    { path: 'docs/guide.md', status: 'added', added: 10, removed: 0, binary: false },
    { path: 'logo.png', status: 'modified', added: 0, removed: 0, binary: true },
  ])
  assert.equal(digest, '- modified src/app.js (+3/-1)\n- added docs/guide.md (+10/-0)\n- binary logo.png')
})

test('changeDigest is empty for no changes and caps long change sets', () => {
  assert.equal(changeDigest([]), '')
  assert.equal(changeDigest(undefined), '')
  const many = Array.from({ length: 43 }, (_, index) => ({ path: `src/f${index}.js`, status: 'modified', added: 1, removed: 0 }))
  const digest = changeDigest(many)
  assert.equal(digest.split('\n').length, 41, '40 files plus the omitted-count line')
  assert.ok(digest.endsWith('… and 3 more file(s)'))
  const short = changeDigest(many, { maxFiles: 2 })
  assert.equal(short.split('\n').length, 3)
  assert.ok(short.endsWith('… and 41 more file(s)'))
})

/* ------------------------------------------------------------ least loaded */

test('leastLoadedName picks the alive worker with the fewest claims', () => {
  const assignments = { Iris: [1, 2], Juno: [1], Rover: [] }
  assert.equal(leastLoadedName(assignments, ['Iris', 'Juno', 'Rover']), 'Rover')
  assert.equal(leastLoadedName({ Iris: [1, 2], Juno: [1] }, ['Iris', 'Juno']), 'Juno')
  assert.equal(leastLoadedName({}, ['Iris']), 'Iris')
  assert.equal(leastLoadedName({ Iris: [1] }, []), null)
  assert.equal(leastLoadedName({}, null), null)
})

test('leastLoadedName breaks ties by the given team order', () => {
  const assignments = { Iris: [], Juno: [] }
  assert.equal(leastLoadedName(assignments, ['Iris', 'Juno']), 'Iris')
  assert.equal(leastLoadedName(assignments, ['Iris', 'Juno'], ['Juno', 'Iris']), 'Juno')
  const mixed = { Iris: [1], Juno: [], Rover: [] }
  assert.equal(leastLoadedName(mixed, ['Iris', 'Juno', 'Rover'], ['Rover', 'Juno', 'Iris']), 'Rover')
  // Workers the ranking omits stay eligible and keep their alive order.
  assert.equal(leastLoadedName({ Iris: [], Juno: [] }, ['Iris', 'Juno'], ['Juno']), 'Juno')
})

/* ---------------------------------------------------------------- capText */

test('capText collapses whitespace, trims and cuts with an ellipsis', () => {
  assert.equal(capText('  hello\n\nworld\t!  '), 'hello world !')
  assert.equal(capText(''), '')
  assert.equal(capText(null), '')
  assert.equal(capText('abc', 10), 'abc')
  assert.equal(capText('abcdefghij', 5), 'abcde…')
  assert.equal(capText('x'.repeat(1300)).length, 1201)
})

/* ----------------------------------------------------------------- prompts */

test('conductorPlanPrompt embeds the team, the paths, the task and the markers', () => {
  const text = conductorPlanPrompt({
    copyPath: '/tmp/copy',
    projectPath: '/tmp/project',
    task: 'Fix the login bug',
    workers: [{ name: 'Iris', address: 'iris' }, 'Juno'],
    selfName: 'Mercury',
  })
  assert.ok(text.includes('Mercury'))
  assert.ok(text.includes('/tmp/copy'))
  assert.ok(text.includes('/tmp/project'))
  assert.ok(text.includes('Fix the login bug'))
  assert.ok(text.includes('Iris'))
  assert.ok(text.includes('"iris"'))
  assert.ok(text.includes('Juno'))
  assert.ok(text.includes('OWNERSHIP:'))
  assert.ok(text.includes('SHARES:'))
  assert.match(text, /acceptance criteria/i)
  assert.match(text, /DO NOT EDIT/i)
})

test('conductorWorkerPlanPrompt demands one ownership line and teaches the team rules', () => {
  const text = conductorWorkerPlanPrompt({
    copyPath: '/tmp/copy',
    projectPath: '/tmp/project',
    task: 'Fix the login bug',
    peers: [{ name: 'Mercury', address: 'conductor' }, { name: 'Juno', address: 'juno' }],
    selfName: 'Iris',
    selfAddress: 'iris',
    canMessage: true,
  })
  assert.ok(text.includes('/tmp/copy'))
  assert.ok(text.includes('Fix the login bug'))
  assert.ok(text.includes('"conductor"'))
  assert.ok(text.includes('"iris"'))
  assert.ok(text.includes('OWNERSHIP:'))
  assert.match(text, /exactly one line/i)
  assert.match(text, /first claim wins/i)
  assert.ok(text.includes('wait_agent'))
  assert.match(text, /never edit/i)
})

test('conductorDecidePrompt shows the proposal and each worker raw claims and asks for one block', () => {
  const text = conductorDecidePrompt({
    proposalMap: '- Iris: src/api/**\n- Juno: docs/**',
    claims: [
      { name: 'Iris', claims: ['src/api/**'] },
      { name: 'Juno', claims: [] },
    ],
    task: 'Fix the login bug',
    workers: [{ name: 'Iris', address: 'iris' }, { name: 'Juno', address: 'juno' }],
  })
  assert.ok(text.includes('- Iris: src/api/**'))
  assert.ok(text.includes('- Juno: docs/**'))
  assert.ok(text.includes('- Iris: src/api/**'))
  assert.ok(text.includes('- Juno: nothing'))
  assert.ok(text.includes('SHARES: approve'))
  assert.ok(text.includes('= none'))
  assert.ok(text.includes('Iris'))
  assert.ok(text.includes('Juno'))
  assert.ok(text.includes('Fix the login bug'))
  assert.match(text, /exactly one decision block/i)
})

test('conductorWorkerGoPrompt pins the approved map, owns area and peer rules', () => {
  const text = conductorWorkerGoPrompt({
    copyPath: '/tmp/copy',
    ownershipMap: '- Iris: src/**\n- Juno: docs/**',
    ownClaims: ['src/app.js'],
    contested: [{ path: 'src/other.js', ownerName: 'Juno' }],
    task: 'Fix the login bug',
    peers: [{ name: 'Mercury', address: 'conductor' }],
    selfAddress: 'iris',
    canMessage: true,
  })
  assert.ok(text.includes('The conductor approved the shares'))
  assert.ok(text.includes('/tmp/copy'))
  assert.ok(text.includes('src/app.js'))
  assert.ok(text.includes('src/other.js belongs to Juno'))
  assert.ok(text.includes('"conductor"'))
  assert.ok(text.includes('Fix the login bug'))
  assert.match(text, /Do not commit/)
  assert.match(text, /end your turn/i)
})

test('conductorReviewPrompt shows the digest, map, rounds and previous remarks', () => {
  const text = conductorReviewPrompt({
    digest: '- modified src/app.js (+2/-1)',
    ownershipMap: '- Iris: src/**',
    task: 'Fix the login bug',
    roundsLeft: 2,
    previousRemarks: 'the tests still fail',
  })
  assert.ok(text.includes('- modified src/app.js (+2/-1)'))
  assert.ok(text.includes('- Iris: src/**'))
  assert.ok(text.includes('Fix the login bug'))
  assert.ok(text.includes('the tests still fail'))
  assert.ok(text.includes('VERDICT: accept'))
  assert.ok(text.includes('VERDICT: rework'))
  assert.ok(text.includes('REWORK:'))
  assert.match(text, /Rework rounds left after this verdict: 2/)
  assert.match(text, /DO NOT EDIT/i)
})

test('conductorReviewPrompt closes the rework option at zero rounds and handles an empty digest', () => {
  const text = conductorReviewPrompt({ digest: '', ownershipMap: '- Iris: src/**', task: 'Fix it', roundsLeft: 0 })
  assert.match(text, /NO REWORK ROUNDS ARE LEFT/)
  assert.ok(text.includes('No files changed in the copy.'))
  assert.ok(text.includes('REWORK:'))
})

test('conductorReworkPrompt carries the remarks verbatim and the own area', () => {
  const text = conductorReworkPrompt({
    copyPath: '/tmp/copy',
    ownershipMap: '- Iris: src/**',
    ownClaims: ['src/app.js'],
    remarks: 'the API branch still returns the old error',
    task: 'Fix the login bug',
    peers: ['Mercury'],
    selfAddress: 'iris',
    canMessage: true,
  })
  assert.ok(text.includes('the API branch still returns the old error'))
  assert.ok(text.includes('/tmp/copy'))
  assert.ok(text.includes('src/app.js'))
  assert.ok(text.includes('- Iris: src/**'))
  assert.ok(text.includes('Fix the login bug'))
  assert.match(text, /end your turn/i)
  const empty = conductorReworkPrompt({ copyPath: '/tmp/copy', ownershipMap: '- Iris: src/**', ownClaims: [], remarks: '', task: 'x', peers: [] })
  assert.match(empty, /no details/)
})

test('conductorHandoverPrompt shows the failed worker, its files and the answer forms', () => {
  const text = conductorHandoverPrompt({
    failedName: 'Juno',
    failedFiles: ['src/api/**', 'src/types.ts'],
    ownershipMap: '- Iris: src/**',
    aliveNames: ['Iris', 'Rover'],
    task: 'Fix the login bug',
  })
  assert.ok(text.includes('Juno stopped'))
  assert.ok(text.includes('src/api/**'))
  assert.ok(text.includes('src/types.ts'))
  assert.ok(text.includes('- Iris: src/**'))
  assert.ok(text.includes('Iris, Rover'))
  assert.ok(text.includes('SHARES: approve'))
  assert.ok(text.includes('= none'))
  assert.ok(text.includes('Fix the login bug'))
  assert.match(text, /DO NOT EDIT/i)
  const empty = conductorHandoverPrompt({ failedName: 'Juno', failedFiles: [], ownershipMap: '- Iris: src/**', aliveNames: [], task: 'x' })
  assert.ok(empty.includes('Its files were: nothing'))
})

test('conductorShareUpdatePrompt says which files were added and how to finish', () => {
  const text = conductorShareUpdatePrompt({
    copyPath: '/tmp/copy',
    ownershipMap: '- Iris: src/**',
    ownClaims: ['src/api/**'],
    task: 'Fix the login bug',
    peers: [{ name: 'Mercury', address: 'conductor' }],
    selfAddress: 'iris',
    canMessage: true,
  })
  assert.ok(text.includes('src/api/**'))
  assert.ok(text.includes('/tmp/copy'))
  assert.ok(text.includes('- Iris: src/**'))
  assert.ok(text.includes('Fix the login bug'))
  assert.match(text, /short summary/i)
  assert.match(text, /end your turn/i)
})
