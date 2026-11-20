import test from 'node:test'
import assert from 'node:assert/strict'

import orchestrator, {
  MAX_ORCHESTRATOR_PARTS,
  MAX_ORCHESTRATOR_REWORK,
  PART_STATUSES,
  PLAN_MARKER,
  assembledCard,
  parsePlan,
  parseReview,
  partLabel,
  planCard,
} from '../lib/orchestrator.js'

const TWO_PART_PLAN = [
  'PLAN: Rework the demo app in two independent parts.',
  '',
  'PART 1: Core change',
  'GOAL: The answer becomes 2 in src/app.js.',
  'DONE: src/app.js exports answer 2; the existing call sites still work',
  'FILES: src/app.js',
  '',
  'PART 2: Docs',
  'GOAL: The README explains the answer.',
  'DONE: README.md mentions the new answer',
  'FILES: README.md',
].join('\n')

const FIVE_PART_PLAN = [
  'PLAN: Five parts that fit in four.',
  'PART 1: One',
  'GOAL: Goal one',
  'DONE: one done',
  'PART 2: Two',
  'GOAL: Goal two',
  'DONE: two done',
  'PART 3: Three',
  'GOAL: Goal three',
  'DONE: three done',
  'PART 4: Four',
  'GOAL: Goal four',
  'DONE: four done',
  'PART 5: Five',
  'GOAL: Goal five',
  'DONE: five done',
].join('\n')

test('orchestrator constants are the documented ones', () => {
  assert.equal(PLAN_MARKER, 'PLAN:')
  assert.equal(MAX_ORCHESTRATOR_PARTS, 4)
  assert.equal(MAX_ORCHESTRATOR_REWORK, 2)
  assert.deepEqual(PART_STATUSES, ['pending', 'working', 'reviewing', 'rework', 'accepted', 'failed'])
  assert.equal(orchestrator.parsePlan, parsePlan)
  assert.equal(orchestrator.MAX_ORCHESTRATOR_PARTS, MAX_ORCHESTRATOR_PARTS)
})

test('parsePlan reads the markers the planner is asked to write', () => {
  const plan = parsePlan(TWO_PART_PLAN)
  assert.equal(plan.summary, 'Rework the demo app in two independent parts.')
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.folded, 0)
  assert.deepEqual(plan.parts, [
    {
      id: 'p1',
      title: 'Core change',
      goal: 'The answer becomes 2 in src/app.js.',
      conditions: ['src/app.js exports answer 2', 'the existing call sites still work'],
      files: ['src/app.js'],
    },
    {
      id: 'p2',
      title: 'Docs',
      goal: 'The README explains the answer.',
      conditions: ['README.md mentions the new answer'],
      files: ['README.md'],
    },
  ])
})

test('parsePlan survives decoration, bold markers and prose around the plan', () => {
  const plan = parsePlan([
    'Sure! I looked at the project and this is my plan.',
    '',
    '**PLAN:** Do it in two parts.',
    '- **PART 1 — Core**',
    '  **GOAL:** Change the answer.',
    '  **DONE:** the answer is 2; tests still pass',
    '  **FILES:** src/app.js, README.md',
    '',
    '> PART 2: Docs',
    '> GOAL: Explain it.',
    '> DONE: README mentions it',
    '',
    'That is the split.',
  ].join('\n'))
  assert.equal(plan.summary, 'Do it in two parts.')
  assert.equal(plan.parts.length, 2)
  assert.equal(plan.parts[0].title, 'Core')
  assert.deepEqual(plan.parts[0].conditions, ['the answer is 2', 'tests still pass'])
  assert.deepEqual(plan.parts[0].files, ['src/app.js', 'README.md'])
  assert.equal(plan.parts[1].title, 'Docs')
  assert.deepEqual(plan.parts[1].conditions, ['README mentions it'])
})

test('parsePlan keeps a field open when the planner wraps over one line', () => {
  const plan = parsePlan([
    'PART 1: Core',
    'GOAL: The answer becomes 2',
    'and the call sites keep working.',
    'DONE: tests pass',
    'FILES: src/app.js',
  ].join('\n'))
  assert.equal(plan.parts[0].goal, 'The answer becomes 2 and the call sites keep working.')
  assert.deepEqual(plan.parts[0].conditions, ['tests pass'])
})

test('parsePlan falls back to a title when the planner left it empty', () => {
  const plan = parsePlan([
    'PART 1:',
    'GOAL: Make the answer two everywhere so the demo works.',
    'DONE: the demo works',
  ].join('\n'))
  assert.equal(plan.parts[0].title, 'Make the answer two everywhere so the demo works.')
  const long = parsePlan(['PART 1:', `GOAL: ${'x'.repeat(90)}`, 'DONE: it works'].join('\n'))
  assert.equal(long.parts[0].title.length, 61)
  assert.ok(long.parts[0].title.endsWith('…'))
})

test('parsePlan folds parts above the hard cap into the last kept part', () => {
  const plan = parsePlan(FIVE_PART_PLAN, { maxParts: 4 })
  assert.equal(plan.parts.length, 4)
  assert.equal(plan.folded, 1)
  assert.equal(plan.parts[3].title, 'Four')
  assert.match(plan.parts[3].goal, /Also: Goal five/)
  assert.deepEqual(plan.parts[3].conditions, ['four done', 'Five: five done'])
})

test('parsePlan reports problems instead of throwing on a broken answer', () => {
  const empty = parsePlan('This is simple, I will just do it.')
  assert.deepEqual(empty.parts, [])
  assert.deepEqual(empty.problems, ['the answer has no PART lines'])

  const bare = parsePlan('PART 1: Core\nFILES: src/app.js')
  assert.equal(bare.parts.length, 1)
  assert.deepEqual(bare.problems, ['part 1 has no GOAL line', 'part 1 has no DONE conditions'])
})

test('parseReview reads accept and rework verdicts', () => {
  const accept = parseReview('VERDICT: accept — the plan conditions are met.')
  assert.equal(accept.verdict, 'accept')
  assert.equal(accept.notes, 'the plan conditions are met.')
  assert.deepEqual(accept.problems, [])

  const acceptBold = parseReview('**VERDICT:** accept')
  assert.equal(acceptBold.verdict, 'accept')

  const rework = parseReview([
    'VERDICT: rework — the README is still wrong.',
    'PROBLEMS:',
    '- README says the answer is 1',
    '- there is no test for the new answer',
  ].join('\n'))
  assert.equal(rework.verdict, 'rework')
  assert.equal(rework.notes, 'the README is still wrong.')
  assert.deepEqual(rework.problems, ['README says the answer is 1', 'there is no test for the new answer'])
})

test('parseReview takes the last verdict and tolerates decoration', () => {
  const plan = parseReview([
    '- VERDICT: rework — not yet.',
    'PROBLEMS:',
    '- the copy is missing',
    '> VERDICT: accept — fixed now.',
  ].join('\n'))
  assert.equal(plan.verdict, 'accept')
  assert.equal(plan.notes, 'fixed now.')
})

test('parseReview reports missing when the reviewer did not answer with a verdict', () => {
  const missing = parseReview('I looked at the copy and it seems fine.')
  assert.equal(missing.verdict, 'missing')
  assert.deepEqual(missing.problems, [])
})

test('partLabel numbers parts from the id', () => {
  assert.equal(partLabel({ id: 'p2', title: 'Docs' }), 'Part 2 — Docs')
  assert.equal(partLabel({ id: 'p1', title: 'Core' }), 'Part 1 — Core')
  assert.equal(partLabel({ title: 'No id' }, 2), 'Part 3 — No id')
  assert.equal(partLabel({}, 0), 'Part 1')
})

test('planCard renders the plan the user sees before any work starts', () => {
  const card = planCard({
    summary: 'Do the demo in two parts.',
    parts: [
      { id: 'p1', title: 'Core', goal: 'Change the answer.', conditions: ['answer is 2', 'tests pass'], files: ['src/app.js'] },
      { id: 'p2', title: 'Docs', goal: '', conditions: [], files: [] },
    ],
  })
  assert.match(card, /^Plan: Do the demo in two parts\./)
  assert.match(card, /\n\n1\. Core\n   Goal: Change the answer\.\n   Done when: answer is 2; tests pass\n   Starts from: src\/app\.js/)
  assert.match(card, /\n\n2\. Docs$/)
})

test('assembledCard lists the accepted parts and the merge totals', () => {
  const plan = {
    parts: [
      { id: 'p1', title: 'Core', status: 'accepted' },
      { id: 'p2', title: 'Docs', status: 'accepted' },
    ],
  }
  const card = assembledCard(plan, { files: 3, conflicts: 1 })
  assert.match(card, /^The parts are assembled in one copy\./)
  assert.match(card, /- Part 1 — Core: accepted/)
  assert.match(card, /- Part 2 — Docs: accepted/)
  assert.match(card, /Changed files: 3\./)
  assert.match(card, /Conflicts resolved by the merger: 1\./)

  const clean = assembledCard(plan, { files: 1, conflicts: 0 })
  assert.doesNotMatch(clean, /Conflicts resolved by the merger/)
})
