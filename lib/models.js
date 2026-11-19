/**
 * Model-catalog helpers for dsh-artel.
 *
 * Artel lets the user route every agent to any provider/model the running DSH
 * profile advertises, with the model's own reasoning effort. The catalog is
 * built from the live `ctx.llm` registry (never from a hard-coded list), so the
 * picker shows exactly what the profile can actually call.
 *
 * This module holds the pure parts — normalization and validation — so the
 * engine and its tests do not need a mounted harness. The driver owns the
 * `ctx.llm` calls that fill the catalog in.
 */

/** Stable error code for an unusable model selection. */
export const MODEL_UNAVAILABLE = 'artel/model-unavailable'

/**
 * Normalize one `{ provider, model, reasoningEffort? }` value.
 *
 * Trims the ids and drops an empty effort, so `{ effort: '' }` and an absent
 * effort mean the same thing: the adapter's own default.
 * @param {unknown} input - raw selection from a request body or a run record.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} normalized selection, or null when incomplete.
 */
export function normalizeSelection(input) {
  if (input === null || typeof input !== 'object') return null
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === '' || model === '') return null
  const effort = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : ''
  return effort === ''
    ? { provider, model }
    : { provider, model, reasoningEffort: effort }
}

/**
 * Whether two selections name the same route and effort.
 * @param {unknown} left - one selection.
 * @param {unknown} right - the other selection.
 * @returns {boolean} true when both normalize to the same value.
 */
export function sameSelection(left, right) {
  const a = normalizeSelection(left)
  const b = normalizeSelection(right)
  if (a === null || b === null) return a === b
  return a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '')
}

/**
 * Build the client-facing catalog from raw registry parts.
 *
 * Kept separate from the `ctx.llm` calls so the shape the browser parses is
 * testable without a harness: providers without models are dropped and each
 * model carries the efforts its adapter advertises (none when it advertises no
 * reasoning metadata).
 * @param {object} parts - registry read results.
 * @param {Array<{ id: string, name?: string }>} [parts.providers] - registered provider routes.
 * @param {(provider: string) => Array<{ id: string, name?: string }>} [parts.modelsOf] - models per provider.
 * @param {(provider: string, model: string) => { reasoning?: { efforts?: Array<{ id: string, label?: string }>, defaultEffort?: string } } | undefined} [parts.infoOf] - resolved model info.
 * @param {unknown} [parts.defaultSelection] - deployment default selection.
 * @returns {{ providers: Array<{ id: string, name: string, models: Array<{ id: string, name: string, efforts: Array<{ id: string, label?: string }>, defaultEffort?: string }> }>, default: { provider: string, model: string, reasoningEffort?: string } | null }} catalog.
 */
export function buildCatalog({ providers = [], modelsOf, infoOf, defaultSelection } = {}) {
  const groups = []
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (id === '') continue
    const models = typeof modelsOf === 'function' ? modelsOf(id) : []
    const entries = []
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = typeof model?.id === 'string' ? model.id : ''
      if (modelId === '') continue
      const info = typeof infoOf === 'function' ? infoOf(id, modelId) : undefined
      const efforts = (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [])
        .filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
        .map((effort) => {
          // `ctx.llm` names an effort's display text `name`; `label` is accepted
          // too so hand-written catalogs and tests can stay terse.
          const label = typeof effort.name === 'string' && effort.name !== ''
            ? effort.name
            : typeof effort.label === 'string' && effort.label !== ''
              ? effort.label
              : ''
          return { id: effort.id, ...(label === '' ? {} : { label }) }
        })
      const defaultEffort = info?.reasoning?.defaultEffort
      entries.push({
        id: modelId,
        name: typeof model?.name === 'string' && model.name !== '' ? model.name : modelId,
        efforts,
        ...(typeof defaultEffort === 'string' && defaultEffort !== '' ? { defaultEffort } : {}),
      })
    }
    if (entries.length === 0) continue
    groups.push({ id, name: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id, models: entries })
  }
  const fallback = groups[0] === undefined
    ? null
    : { provider: groups[0].id, model: groups[0].models[0].id, ...(effortDefaultOf(groups[0].models[0])) }
  const normalizedDefault = normalizeSelection(defaultSelection) ?? fallback
  return { providers: groups, default: normalizedDefault }
}

/**
 * The default effort advertised by one catalog model, if any.
 * @param {{ defaultEffort?: string }} model - catalog model entry.
 * @returns {{ reasoningEffort?: string }} patch to merge into a selection.
 */
function effortDefaultOf(model) {
  return typeof model?.defaultEffort === 'string' && model.defaultEffort !== ''
    ? { reasoningEffort: model.defaultEffort }
    : {}
}

/**
 * Find one catalog model entry.
 * @param {object} catalog - catalog built by {@link buildCatalog}.
 * @param {unknown} selection - selection to look up.
 * @returns {{ provider: object, model: object } | null} the provider group and model entry, or null.
 */
export function findCatalogModel(catalog, selection) {
  const normalized = normalizeSelection(selection)
  if (normalized === null) return null
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const provider = providers.find((group) => group?.id === normalized.provider)
  if (provider === undefined) return null
  const model = (Array.isArray(provider.models) ? provider.models : []).find((entry) => entry?.id === normalized.model)
  if (model === undefined) return null
  return { provider, model }
}

/**
 * Check a selection against the live catalog.
 *
 * An empty catalog means the profile could not report any provider (a stripped
 * deployment): validation is skipped rather than blocking every run.
 * @param {object} catalog - catalog built by {@link buildCatalog}.
 * @param {unknown} selection - selection to check.
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }} validation result.
 */
export function validateSelection(catalog, selection) {
  const normalized = normalizeSelection(selection)
  if (normalized === null) {
    return { ok: false, code: MODEL_UNAVAILABLE, reason: 'Pick a provider and a model first.' }
  }
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  if (providers.length === 0) return { ok: true }
  const found = findCatalogModel(catalog, normalized)
  if (found === null) {
    return {
      ok: false,
      code: MODEL_UNAVAILABLE,
      reason: `${normalized.provider}/${normalized.model} is not available in this DSH profile.`,
    }
  }
  const effort = normalized.reasoningEffort
  if (effort !== undefined) {
    const efforts = Array.isArray(found.model.efforts) ? found.model.efforts : []
    if (!efforts.some((entry) => entry.id === effort)) {
      return {
        ok: false,
        code: MODEL_UNAVAILABLE,
        reason: `${normalized.provider}/${normalized.model} does not offer the "${effort}" reasoning effort.`,
      }
    }
  }
  return { ok: true }
}

/**
 * Short human label for one selection, e.g. `deepseek/deepseek-chat · high`.
 * @param {object} catalog - catalog used to resolve the display names.
 * @param {unknown} selection - selection to describe.
 * @returns {string} label, or '' when the selection is incomplete.
 */
export function describeSelection(catalog, selection) {
  const normalized = normalizeSelection(selection)
  if (normalized === null) return ''
  const found = findCatalogModel(catalog, normalized)
  const providerName = found?.provider?.name ?? normalized.provider
  const modelName = found?.model?.name ?? normalized.model
  const effort = normalized.reasoningEffort === undefined ? '' : ` · ${normalized.reasoningEffort}`
  return `${providerName}/${modelName}${effort}`
}
