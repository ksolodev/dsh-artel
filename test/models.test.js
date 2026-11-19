import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_UNAVAILABLE,
  buildCatalog,
  describeSelection,
  findCatalogModel,
  normalizeSelection,
  sameSelection,
  validateSelection,
} from '../lib/models.js'

function catalog() {
  return buildCatalog({
    providers: [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'empty', name: 'Empty' },
    ],
    modelsOf: (provider) => {
      if (provider === 'deepseek') {
        return [{ id: 'chat', name: 'DeepSeek Chat' }, { id: 'reasoner', name: 'DeepSeek Reasoner' }]
      }
      if (provider === 'openai') return [{ id: 'gpt' }]
      return []
    },
    infoOf: (provider, model) => {
      if (provider === 'deepseek' && model === 'chat') {
        return { reasoning: { efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultEffort: 'low' } }
      }
      if (provider === 'deepseek' && model === 'reasoner') {
        return { reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }
      }
      return undefined
    },
    defaultSelection: { provider: 'deepseek', model: 'chat', reasoningEffort: 'low' },
  })
}

test('buildCatalog keeps providers that have models and their advertised efforts', () => {
  const built = catalog()
  assert.equal(built.providers.length, 2, 'a provider without models is dropped')
  assert.deepEqual(built.providers.map((group) => group.id), ['deepseek', 'openai'])
  assert.deepEqual(built.providers[0].models[0], {
    id: 'chat',
    name: 'DeepSeek Chat',
    efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    defaultEffort: 'low',
  })
  assert.deepEqual(built.providers[0].models[1], {
    id: 'reasoner',
    name: 'DeepSeek Reasoner',
    // `ctx.llm` advertises the display text as `name`; the catalog keeps it as `label`.
    efforts: [{ id: 'max', label: 'Max' }],
  })
  assert.deepEqual(built.providers[1].models[0], { id: 'gpt', name: 'gpt', efforts: [] })
  assert.deepEqual(built.default, { provider: 'deepseek', model: 'chat', reasoningEffort: 'low' })
})

test('buildCatalog falls back to the first model when the profile has no default', () => {
  const built = buildCatalog({
    providers: [{ id: 'p', name: 'P' }],
    modelsOf: () => [{ id: 'm', name: 'M' }],
  })
  assert.deepEqual(built.default, { provider: 'p', model: 'm' })
})

test('normalizeSelection trims ids and drops an empty effort', () => {
  assert.deepEqual(normalizeSelection({ provider: ' p ', model: ' m ', reasoningEffort: '  ' }), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: ' high ' }), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(normalizeSelection({ provider: 'p' }), null)
  assert.equal(normalizeSelection(null), null)
})

test('sameSelection compares the route and the effort', () => {
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: ' p ', model: 'm', reasoningEffort: '' }), true)
  assert.equal(sameSelection({ provider: 'p', model: 'm', reasoningEffort: 'low' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), false)
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, null), false)
})

test('validateSelection accepts a known route and effort', () => {
  assert.deepEqual(validateSelection(catalog(), { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'max' }), { ok: true })
  assert.deepEqual(validateSelection(catalog(), { provider: 'openai', model: 'gpt' }), { ok: true })
})

test('validateSelection refuses an unknown model and an unknown effort', () => {
  const unknownModel = validateSelection(catalog(), { provider: 'deepseek', model: 'nope' })
  assert.equal(unknownModel.ok, false)
  assert.equal(unknownModel.code, MODEL_UNAVAILABLE)
  assert.match(unknownModel.reason, /not available/)

  const unknownEffort = validateSelection(catalog(), { provider: 'deepseek', model: 'chat', reasoningEffort: 'max' })
  assert.equal(unknownEffort.ok, false)
  assert.match(unknownEffort.reason, /does not offer the "max" reasoning effort/)

  const noEfforts = validateSelection(catalog(), { provider: 'openai', model: 'gpt', reasoningEffort: 'low' })
  assert.equal(noEfforts.ok, false)
})

test('validateSelection skips the check when the profile reports no providers', () => {
  assert.deepEqual(validateSelection({ providers: [], default: null }, { provider: 'any', model: 'any' }), { ok: true })
})

test('findCatalogModel and describeSelection resolve display names', () => {
  const built = catalog()
  assert.equal(findCatalogModel(built, { provider: 'deepseek', model: 'chat' })?.model.name, 'DeepSeek Chat')
  assert.equal(findCatalogModel(built, { provider: 'deepseek', model: 'nope' }), null)
  assert.equal(describeSelection(built, { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }), 'DeepSeek/DeepSeek Chat · high')
  assert.equal(describeSelection(built, null), '')
})
