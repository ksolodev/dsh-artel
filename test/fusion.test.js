import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DISPUTES_MARKER,
  FUSION_SLOT_COUNT,
  PANEL_SIZE,
  fusionFailureNotice,
  hasDecision,
  judgeDecision,
} from '../lib/fusion.js'
import { fusionImplementPrompt, fusionJudgePrompt, fusionPanelPrompt } from '../lib/prompts.js'

test('a fusion run has three panel models plus a judge and an implementer', () => {
  assert.equal(PANEL_SIZE, 3)
  assert.equal(FUSION_SLOT_COUNT, 5)
  assert.equal(DISPUTES_MARKER, 'DISPUTES:')
})

test('judgeDecision splits the merged decision from the disputed marker', () => {
  const decision = judgeDecision('## Merged decision\nDo B, not A.\n\nDISPUTES: 2\n')
  assert.equal(decision.text, '## Merged decision\nDo B, not A.')
  assert.equal(decision.disputes, 2)
})

test('judgeDecision keeps every non-marker line and tolerates marker formatting', () => {
  const decision = judgeDecision('Line one\n  disputes :   1  \nLine two')
  assert.equal(decision.text, 'Line one\nLine two')
  assert.equal(decision.disputes, 1)
})

test('judgeDecision reports no disputes when the marker is missing or malformed', () => {
  assert.deepEqual(judgeDecision('just a decision'), { text: 'just a decision', disputes: null })
  assert.deepEqual(judgeDecision('decision\nDISPUTES: many'), { text: 'decision', disputes: null })
  assert.deepEqual(judgeDecision('decision\nDISPUTES: -1'), { text: 'decision', disputes: null })
  assert.deepEqual(judgeDecision('   '), { text: '', disputes: null })
  assert.deepEqual(judgeDecision(null), { text: '', disputes: null })
})

test('hasDecision is false for a marker-only answer', () => {
  assert.equal(hasDecision('Do B.\nDISPUTES: 0'), true)
  assert.equal(hasDecision('DISPUTES: 3'), false)
  assert.equal(hasDecision(''), false)
})

test('the failure notice says what happens to the stage next', () => {
  assert.equal(fusionFailureNotice('panelist', 'Orion', 'error'), 'Orion stopped (error). The panel continues without it.')
  assert.equal(fusionFailureNotice('judge', 'Atlas', 'max-tokens'), 'Atlas stopped (max-tokens). Artel keeps the answers and asks the judge again.')
  assert.equal(fusionFailureNotice('implementer', 'Nova', 'blocked'), 'Nova stopped (blocked). The copy keeps whatever was already written.')
})

test('the panel prompt keeps the models independent and read-only', () => {
  const prompt = fusionPanelPrompt({
    copyPath: 'C:\\copy',
    projectPath: 'C:\\project',
    task: 'Add a settings screen',
    selfName: 'Vega',
    panelSize: 3,
  })
  assert.match(prompt, /Vega/)
  assert.match(prompt, /3 independent models/)
  assert.match(prompt, /DO NOT EDIT ANYTHING/)
  assert.match(prompt, /read-only copy/)
  assert.match(prompt, /RECOMMENDATION:/)
  assert.match(prompt, /Add a settings screen/)
})

test('the judge prompt carries every answer verbatim and demands the marker', () => {
  const prompt = fusionJudgePrompt({
    task: 'Add a settings screen',
    answers: [
      { name: 'Vega', model: 'Test/Fast', text: 'Approach A: extend the main screen.' },
      { name: 'Orion', model: 'Test/Slow', text: 'Approach B: add a separate route.' },
    ],
    panelSize: 3,
  })
  assert.match(prompt, /### Answer 1: Vega — Test\/Fast/)
  assert.match(prompt, /### Answer 2: Orion — Test\/Slow/)
  assert.match(prompt, /Approach A: extend the main screen\./)
  assert.match(prompt, /Approach B: add a separate route\./)
  assert.match(prompt, /## Merged decision/)
  assert.match(prompt, /## Where the answers converged/)
  assert.match(prompt, /## Where they diverged/)
  assert.match(prompt, /## What only one answer saw/)
  assert.match(prompt, /## Disputed places/)
  assert.match(prompt, /DISPUTES: <number of real disagreements/)
  assert.match(prompt, /2 of 3 independent models/)
  assert.match(prompt, /Add a settings screen/)
})

test('the implementer prompt hands over the merged decision as the plan', () => {
  const prompt = fusionImplementPrompt({
    copyPath: 'C:\\copy',
    projectPath: 'C:\\project',
    task: 'Add a settings screen',
    decision: '## Merged decision\nExtend the main screen in src/app.js.',
  })
  assert.match(prompt, /THE MERGED DECISION:/)
  assert.match(prompt, /Extend the main screen in src\/app\.js\./)
  assert.match(prompt, /ONE copy of the user's project: C:\\copy/)
  assert.match(prompt, /Add a settings screen/)
  assert.ok(!/DISPUTES:/.test(prompt))
})

test('the implementer prompt survives an empty decision', () => {
  const prompt = fusionImplementPrompt({ copyPath: 'C:\\copy', projectPath: 'C:\\project', task: 'Do it', decision: ' ' })
  assert.match(prompt, /the judge produced no text/)
})
