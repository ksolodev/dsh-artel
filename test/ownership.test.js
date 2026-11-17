import test from 'node:test'
import assert from 'node:assert/strict'
import { assignOwnership, claimsOverlap, describeOwnership, parseClaim, parseOwnership, pathOwner } from '../lib/ownership.js'

test('parseClaim understands files, dirs and globs', () => {
  const file = parseClaim('src/app.ts')
  assert.equal(file.kind, 'file')
  assert.equal(file.test('src/app.ts'), true)
  assert.equal(file.test('src/app.tsx'), false)

  const dir = parseClaim('src/api/**')
  assert.equal(dir.kind, 'dir')
  assert.equal(dir.test('src/api/users.ts'), true)
  assert.equal(dir.test('src/apix/users.ts'), false)

  const glob = parseClaim('src/*.ts')
  assert.equal(glob.kind, 'glob')
  assert.equal(glob.test('src/a.ts'), true)
  assert.equal(glob.test('src/deep/a.ts'), false)

  assert.equal(parseClaim('none'), null)
  assert.equal(parseClaim(''), null)
  assert.equal(parseClaim('none — claiming no files'), null, 'a placeholder followed by prose is still no claim')
  assert.equal(parseClaim('(none — claiming no files'), null, 'leading brackets are stripped before the placeholder check')
  assert.equal(parseClaim('verifying the whole shared copy instead'), null, 'prose without a path character is ignored')
  assert.equal(parseClaim('src/My Notes.md').path, 'src/My Notes.md', 'real paths may contain spaces')
  assert.equal(parseClaim('- `src/lib/`').path, 'src/lib')
})

test('parseOwnership reads only OWNERSHIP lines', () => {
  const text = `I will take the API layer.
OWNERSHIP: src/api/**, src/types.ts
Some more prose, src/ignored.ts
- OWNERSHIP: docs/**; README.md
`
  const claims = parseOwnership(text)
  assert.deepEqual(claims.map((claim) => claim.raw), ['src/api/**', 'src/types.ts', 'docs/**', 'README.md'])
})

test('prose leaked into the OWNERSHIP line is not a claim', () => {
  // Observed in a real run: the agent explained itself on the ownership line and
  // the prose fragments became claims, so the go-ahead prompt told it to verify
  // instead of edit. A placeholder word must kill the fragment.
  assert.deepEqual(parseOwnership('OWNERSHIP: none — claiming no files, verifying the whole shared copy instead'), [])
  const mixed = parseOwnership('OWNERSHIP: none — claiming no files, verifying the whole shared copy instead, src/app.js')
  assert.deepEqual(mixed.map((claim) => claim.raw), ['src/app.js'], 'concrete paths next to the prose still count')
})

test('overlap detection is segment-aware', () => {
  const a = parseClaim('src/api/**')
  const b = parseClaim('src/api/users.ts')
  const c = parseClaim('src/api2/users.ts')
  const d = parseClaim('src/**')
  assert.equal(claimsOverlap(a, b), true)
  assert.equal(claimsOverlap(b, a), true)
  assert.equal(claimsOverlap(a, c), false)
  assert.equal(claimsOverlap(d, c), true)
  assert.equal(claimsOverlap(parseClaim('src/*.ts'), b), false)
})

test('first claimant keeps a path; later claims become conflicts', () => {
  const agents = [
    { id: 'a1', name: 'Vega', claims: [parseClaim('src/api/**'), parseClaim('src/shared.ts')] },
    { id: 'a2', name: 'Orion', claims: [parseClaim('src/api/users.ts'), parseClaim('src/ui/**')] },
    { id: 'a3', name: 'Lyra', claims: [parseClaim('src/ui/button.tsx'), parseClaim('src/ui/**')] },
  ]
  const { assignments, conflicts } = assignOwnership(agents)
  assert.deepEqual(assignments.a1.map((claim) => claim.raw), ['src/api/**', 'src/shared.ts'])
  assert.deepEqual(assignments.a2.map((claim) => claim.raw), ['src/ui/**'])
  assert.deepEqual(assignments.a3.map((claim) => claim.raw), [])
  // a2 loses src/api/users.ts to a1; a3 loses both of its claims to a2.
  assert.equal(conflicts.length, 3)
  assert.equal(conflicts[0].owner, 'a1')
  assert.equal(conflicts[0].claimedBy, 'a2')
  assert.equal(conflicts[1].owner, 'a2')
  assert.equal(conflicts[2].owner, 'a2')

  assert.equal(pathOwner(assignments, 'src/api/users.ts'), 'a1')
  assert.equal(pathOwner(assignments, 'src/ui/button.tsx'), 'a2')
  assert.equal(pathOwner(assignments, 'src/other.ts'), undefined)
})

test('describeOwnership renders a prompt block', () => {
  const agents = [
    { id: 'a1', name: 'Vega', claims: [parseClaim('src/api/**')] },
    { id: 'a2', name: 'Orion', claims: [] },
  ]
  const { assignments } = assignOwnership(agents)
  const text = describeOwnership(agents, assignments)
  assert.match(text, /Vega: src\/api\/\*\*/)
  assert.match(text, /Orion: nothing/)
})

test('agents that lost every claim get the project files nobody claimed', () => {
  const agents = [
    { id: 'a1', name: 'Vega', claims: [parseClaim('index.html')] },
    { id: 'a2', name: 'Orion', claims: [parseClaim('index.html')] },
    { id: 'a3', name: 'Lyra', claims: [parseClaim('index.html')] },
  ]
  const files = ['index.html', 'pages/faq.html', 'pages/home.html', 'pages/pricing.html', 'styles/base.css']
  const { assignments, granted } = assignOwnership(agents, { files })
  assert.deepEqual(assignments.a1.map((claim) => claim.raw), ['index.html'])
  assert.deepEqual(assignments.a2.map((claim) => claim.raw), ['pages/faq.html', 'pages/pricing.html'])
  assert.deepEqual(assignments.a3.map((claim) => claim.raw), ['pages/home.html', 'styles/base.css'])
  assert.equal(granted.length, 4)
  assert.equal(granted[0].claim.granted, true)
  assert.equal(pathOwner(assignments, 'pages/faq.html'), 'a2')
  assert.match(describeOwnership(agents, assignments), /Orion: pages\/faq\.html \(nobody claimed it\)/)
  assert.match(describeOwnership(agents, assignments), /Lyra: pages\/home\.html \(nobody claimed it\)/)
})

test('agents with a claim of their own are not handed extra files', () => {
  const agents = [
    { id: 'a1', name: 'Vega', claims: [parseClaim('src/app.js')] },
    { id: 'a2', name: 'Orion', claims: [parseClaim('README.md')] },
  ]
  const { assignments, granted } = assignOwnership(agents, { files: ['README.md', 'src/app.js', 'docs/x.md'] })
  assert.deepEqual(granted, [])
  assert.deepEqual(assignments.a1.map((claim) => claim.raw), ['src/app.js'])
  assert.deepEqual(assignments.a2.map((claim) => claim.raw), ['README.md'])
})

test('files handed to an empty agent sit next to the claimed work when possible', () => {
  const agents = [
    { id: 'a1', name: 'Vega', claims: [parseClaim('src/app.js')] },
    { id: 'a2', name: 'Orion', claims: [] },
  ]
  const files = ['README.md', 'docs/x.md', 'src/styles.css', 'src/util.js']
  const { assignments, granted } = assignOwnership(agents, { files })
  assert.ok(granted.length > 0)
  for (const claim of assignments.a2) assert.match(claim.path, /^src\//)
  assert.match(describeOwnership(agents, assignments), /\(nobody claimed it\)/)
})
