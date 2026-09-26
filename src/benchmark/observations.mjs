// Portable observation contracts. Declarations, provider reports and host
// measurements are separate; unavailable measurements never become zero.
import { canonical, invariant, object, sha256 } from './prompts.mjs'

export const OBSERVATION_VERSION = 1
export const IDENTITY_FIELDS = ['provider', 'id', 'version', 'surface', 'fingerprint']
export const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens', 'toolCalls', 'generationMs']
export const TIMING_KINDS = ['attempt', 'collection', 'transport', 'response-extraction', 'response-persistence', 'grading', 'program-extraction', 'native-preparation', 'native-execution', 'native-observation', 'module-grader', 'cleanup', 'settlement']
const text = value => typeof value === 'string' && !!value.trim()
const keys = (value, allowed, label) => invariant(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label} contains an unsupported field.`)
const path = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(key => typeof key === 'string' && key.length > 0 && key.length <= 128 || Number.isSafeInteger(key) && key >= 0)
const currency = value => typeof value === 'string' && /^[A-Z][A-Z0-9_-]{2,11}$/.test(value)
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
const at = (value, location) => {
  if (!location) return undefined
  for (const key of location) { if (!own(value, key)) return undefined; value = value[key] }
  return value
}
const missing = (reason = 'not-reported') => ({ status: 'unavailable', value: null, reason })
function measured(value, valid, sourcePath) {
  if (value === undefined || value === null) return { ...missing(sourcePath ? 'not-reported' : 'not-mapped'), sourcePath: sourcePath || null }
  return valid(value) ? { status: 'observed', value, sourcePath, basis: 'adapter-reported' }
    : { status: 'invalid', value: null, sourcePath, reason: 'invalid-reported-value', raw: value }
}

export function observationPlanFromSpec() {
  return { version: OBSERVATION_VERSION, rationale: 'Record every attempt and distinguish requested controls, reported identity/usage, host timing and unavailable cost.',
    identity: { policy: 'record', fields: ['provider', 'id'] },
    completion: { policy: 'record' },
    mapping: { identity: Object.fromEntries(IDENTITY_FIELDS.map(field => [field, ['identity', field]])),
      completion: { status: ['completion', 'status'], reason: ['completion', 'reason'] },
      usage: Object.fromEntries(USAGE_FIELDS.map(field => [field, ['usage', field]])), cost: { amount: ['usage', 'cost', 'amount'], currency: ['usage', 'cost', 'currency'] } },
    costEstimate: null, overrides: {} }
}

// Exact decimal arithmetic retains reported money without a floating-point
// sum. Estimated prices use a declared rounding boundary of 18 decimal places.
function decimal(value, bounded = true) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value))
  if (!match) return null
  const fraction = match[2] || '', exponent = Number(match[3] || 0), scale = fraction.length - exponent
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 36 || scale > 18 || match[1].length + fraction.length > (bounded ? 38 : 160)) return null
  const coefficient = BigInt(match[1] + fraction) * (scale < 0 ? 10n ** BigInt(-scale) : 1n)
  if (bounded && coefficient > 10n ** 56n) return null
  return { coefficient, scale: Math.max(0, scale) }
}
function decimalString(coefficient, scale) {
  const digits = coefficient.toString().padStart(scale + 1, '0')
  return scale ? (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '') : digits
}
function addDecimals(values) {
  const parsed = values.map(value => decimal(value, false)), scale = Math.max(0, ...parsed.map(value => value.scale))
  return decimalString(parsed.reduce((sum, value) => sum + value.coefficient * 10n ** BigInt(scale - value.scale), 0n), scale)
}
function validateMapping(mapping, partial = false) {
  keys(mapping, ['identity', 'completion', 'usage', 'cost'], 'Observation mapping')
  for (const [group, fields] of [['identity', IDENTITY_FIELDS], ['completion', ['status', 'reason']], ['usage', USAGE_FIELDS], ['cost', ['amount', 'currency']]]) {
    if (partial && mapping[group] === undefined) continue
    keys(mapping[group], fields, `${group} mapping`)
    invariant(Object.values(mapping[group]).every(value => value === null || path(value)), `${group} mappings need a property path or explicit null.`)
  }
}
function validateIdentity(identity, condition) {
  keys(identity, ['policy', 'fields'], 'Identity policy')
  invariant(['record', 'require-match'].includes(identity.policy) && Array.isArray(identity.fields) && identity.fields.length > 0 && new Set(identity.fields).size === identity.fields.length && identity.fields.every(field => IDENTITY_FIELDS.includes(field)), 'Declare the identity policy and distinct comparison fields.')
  if (identity.policy === 'require-match') invariant(identity.fields.every(field => text(condition.model?.[field])), `${condition.id}: every required identity field needs an explicit requested value.`)
}
function validateEstimate(estimate, spec) {
  if (estimate === null) return
  invariant(object(estimate) && ['unit-prices', 'per-started-attempt'].includes(estimate.kind), 'Choose declared unit prices or an explicit allocation per started attempt.')
  keys(estimate, estimate.kind === 'unit-prices' ? ['kind', 'currency', 'rationale', 'sourcePaths', 'terms'] : ['kind', 'currency', 'rationale', 'sourcePaths', 'amount'], 'Cost estimate')
  invariant(currency(estimate.currency) && text(estimate.rationale) && Array.isArray(estimate.sourcePaths) && estimate.sourcePaths.length > 0 && estimate.sourcePaths.length <= 16 && new Set(estimate.sourcePaths).size === estimate.sourcePaths.length && estimate.sourcePaths.every(path => spec.inputs.some(input => input.path === path)), 'An estimate needs a currency, rationale and distinct pinned price/allocation source files.')
  if (estimate.kind === 'per-started-attempt') { invariant(decimal(estimate.amount), 'An allocation needs an exact nonnegative decimal amount.'); return }
  invariant(Array.isArray(estimate.terms) && estimate.terms.length > 0 && estimate.terms.length <= 16, 'Declare 1–16 cost terms.')
  const ids = new Set()
  for (const term of estimate.terms) {
    keys(term, ['id', 'add', 'subtract', 'amount', 'per'], 'Cost term')
    invariant(text(term.id) && !ids.has(term.id), 'Cost terms need distinct labels.'); ids.add(term.id)
    invariant(Array.isArray(term.add) && term.add.length > 0 && Array.isArray(term.subtract) && [...term.add, ...term.subtract].every(field => USAGE_FIELDS.includes(field) && field !== 'generationMs') && new Set([...term.add, ...term.subtract]).size === term.add.length + term.subtract.length, 'Cost quantities use distinct token/tool count fields, with explicit additions and subtractions.')
    invariant(decimal(term.amount) && Number.isSafeInteger(term.per) && term.per > 0 && term.per <= 1000000000, 'A cost term needs an exact nonnegative decimal price and a positive integer unit count.')
  }
}
// ---- R1220: the frozen, dated, cited model price table ----
// A rate may come only from the committed table. Nothing here reaches a network and
// nothing infers a rate: a fact the table does not state is refused rather than
// defaulted, because an unpriced model must never read as a free one.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const PRICED_QUANTITIES = ['inputTokens', 'outputTokens']
const CACHED_CONVENTIONS = ['input-excludes-cached', 'input-includes-cached']

export function validatePriceTable(table) {
  keys(table, ['schemaVersion', 'frozenAsOf', 'currency', 'unit', 'note', 'excludes', 'knownUnpriced', 'models', 'tierMap', 'modelStringInventory', 'doNotUse'], 'Price table')
  invariant(table.schemaVersion === 1, 'This runtime reads price table version 1.')
  invariant(ISO_DATE.test(table.frozenAsOf), 'The price table needs the date its rates were frozen.')
  invariant(currency(table.currency), 'The price table needs one currency for every rate in it.')
  invariant(Number.isSafeInteger(table.unit) && table.unit > 0, 'The price table needs a positive integer rate unit.')
  invariant(Array.isArray(table.models) && table.models.length > 0, 'The price table needs at least one priced model.')
  invariant(Array.isArray(table.tierMap), 'The price table needs a tier map, an empty one if nothing is aliased.')
  invariant(Array.isArray(table.knownUnpriced), 'The price table needs a known-unpriced list, an empty one if nothing is.')
  const ids = new Set()
  for (const model of table.models) {
    invariant(text(model.billingModelId) && !ids.has(model.billingModelId), 'Priced models need distinct billing identifiers.')
    ids.add(model.billingModelId)
    invariant(text(model.provider) && text(model.serviceTier), model.billingModelId + ': a priced model names its provider and the service tier the rate belongs to.')
    const source = model.source
    invariant(object(source) && typeof source.url === 'string' && source.url.startsWith('https://') && ISO_DATE.test(source.retrievedAt) && text(source.quote),
      model.billingModelId + ': every rate carries the official page it came from, the date it was read, and the line it was read from.')
    invariant(source.retrievedAt <= table.frozenAsOf, model.billingModelId + ': a rate cannot have been retrieved after the table was frozen.')
    // R1220. A row's caveat is printed to the owner in declaredConventions, beside the estimate it
    // qualifies. A row that declares a cached-token convention DOES charge cached tokens, so a caveat
    // saying they are refused is false next to the number it sits under. Refuse the table rather than
    // freeze the contradiction into a study and print it.
    invariant(!(CACHED_CONVENTIONS.includes(model.cachedInputConvention) && /cached[^.]*\brefus/i.test(model.caveat || '')),
      model.billingModelId + ': this row declares ' + model.cachedInputConvention + ', so its cached tokens are charged, but its caveat says they are refused. One of the two is wrong.')
    const sets = Array.isArray(model.contextTiers) ? model.contextTiers.map(tier => tier.rates) : [model.rates]
    invariant(sets.length > 0 && sets.every(rates => object(rates)), model.billingModelId + ': a priced model needs rates, or context tiers carrying them.')
    if (Array.isArray(model.contextTiers)) {
      invariant(model.contextTiers.every(tier => tier.upToTotalTokens === null || Number.isSafeInteger(tier.upToTotalTokens) && tier.upToTotalTokens > 0),
        model.billingModelId + ': a context tier ends at a positive token count, or is the open last one.')
      invariant(model.contextTiers[model.contextTiers.length - 1].upToTotalTokens === null,
        model.billingModelId + ': the last context tier must be open, so no context length is left unpriced by accident.')
    }
    for (const rates of sets) for (const [field, amount] of Object.entries(rates)) {
      invariant(USAGE_FIELDS.includes(field) && field !== 'generationMs', model.billingModelId + ': ' + field + ' is not a billable usage quantity.')
      invariant(typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount), model.billingModelId + ': rates are exact decimal strings, never numbers.')
    }
  }
  for (const entry of table.tierMap) {
    invariant(text(entry.tier) && ids.has(entry.billingModelId) && ISO_DATE.test(entry.asOf),
      'Each tier alias names a dated mapping to a billing identifier the table prices.')
    invariant(!ids.has(entry.tier), entry.tier + ': a tier alias cannot also be a billing identifier.')
  }
}

// The identity of the exact rates a study was priced with. Any changed rate changes it,
// so a frozen study can be bound to the table revision that priced it.
export async function priceTableIdentity(table) { return sha256(canonical(table)) }

// Resolve the rates for one model exactly as the runtime reports it. usage supplies the
// measured quantities a context-tiered rate depends on; without them the model is left
// unpriced rather than quietly charged at the cheaper tier.
export function priceTermsFor(table, modelId, usage = {}) {
  const unpriced = (reason, extra = {}) => ({ status: 'unpriced', reason, ...extra })
  if (!object(table) || !Array.isArray(table.models) || !text(modelId)) return unpriced('model-not-in-price-table')
  let row = table.models.find(model => model.billingModelId === modelId)
  let basis = 'exact-billing-model-id', tierMappedAsOf = null
  if (!row) {
    const entry = (Array.isArray(table.tierMap) ? table.tierMap : []).find(candidate => candidate.tier === modelId)
    if (!entry) return unpriced('model-not-in-price-table')
    row = table.models.find(model => model.billingModelId === entry.billingModelId)
    if (!row) return unpriced('model-not-in-price-table')
    basis = 'tier-mapped'; tierMappedAsOf = entry.asOf
  }
  let rates = row.rates
  if (Array.isArray(row.contextTiers)) {
    const total = usage.totalTokens
    if (!Number.isSafeInteger(total) || total < 0) return unpriced('context-tier-unresolved')
    const tier = row.contextTiers.find(candidate => candidate.upToTotalTokens === null || total <= candidate.upToTotalTokens)
    if (!tier) return unpriced('context-tier-unresolved')
    rates = tier.rates
  }
  if (!object(rates)) return unpriced('missing-rate', { missing: [...PRICED_QUANTITIES] })
  const hasCached = typeof rates.cachedInputTokens === 'string'
  // A cached rate whose nesting the provider never stated cannot be applied either way
  // without guessing, and guessing wrong charges the same tokens twice or not at all.
  if (hasCached && !CACHED_CONVENTIONS.includes(row.cachedInputConvention)) return unpriced('cached-convention-undeclared')
  const missing = PRICED_QUANTITIES.filter(field => typeof rates[field] !== 'string')
  if (missing.length) return unpriced('missing-rate', { missing })
  const includesCached = row.cachedInputConvention === 'input-includes-cached'
  const separateReasoning = row.reasoningConvention === 'separate-billed-as-output'
  const per = table.unit
  const terms = [
    { id: 'input', add: ['inputTokens'], subtract: includesCached && hasCached ? ['cachedInputTokens'] : [], amount: rates.inputTokens, per },
    ...(hasCached ? [{ id: 'cached-input', add: ['cachedInputTokens'], subtract: [], amount: rates.cachedInputTokens, per }] : []),
    { id: 'output', add: separateReasoning ? ['outputTokens', 'reasoningTokens'] : ['outputTokens'], subtract: [], amount: rates.outputTokens, per },
  ]
  const declaredConventions = [
    includesCached
      ? 'The provider counts cached tokens inside its input count, so the full-rate input term subtracts them and no token is charged twice.'
      : 'The provider reports input excluding cached tokens, so input and cached tokens are charged separately with nothing subtracted.',
    separateReasoning
      ? 'The provider reports reasoning tokens outside its output count and prices output as including them, so the output term charges reasoning tokens at the output rate.'
      : 'The provider already counts reasoning tokens inside its output count, so the output term charges the output count alone.',
    ...(text(row.usageConventionQuote) ? ['Usage convention, quoted from the provider: ' + row.usageConventionQuote] : []),
    ...(text(row.reasoningNote) ? [row.reasoningNote] : []),
    ...(text(row.caveat) ? [row.caveat] : []),
  ]
  const rowExcludes = object(row.unpricedComponents) && Object.keys(row.unpricedComponents).length
    ? ['Unpriced components for ' + row.billingModelId + ', excluded from every estimate: '
      + Object.entries(row.unpricedComponents).map(([name, amount]) => name + ' ' + amount + ' ' + table.currency + ' per ' + per + ' tokens').join('; ') + '.']
    : []
  return { status: 'priced', basis, billingModelId: row.billingModelId, ...(tierMappedAsOf ? { tierMappedAsOf } : {}),
    currency: table.currency, unit: per, frozenAsOf: table.frozenAsOf, source: row.source,
    reasoningConvention: separateReasoning ? 'separate-billed-as-output' : 'inside-output',
    cachedInputConvention: row.cachedInputConvention || null,
    declaredConventions, excludes: [...rowExcludes, ...(Array.isArray(table.excludes) ? table.excludes : [])], terms }
}

export function observationContract(spec, condition) {
  const plan = spec.observationPlan
  if (!plan) return null
  const override = plan.overrides?.[condition.id] || {}
  return { version: OBSERVATION_VERSION, identity: override.identity || plan.identity, completion: override.completion || plan.completion,
    mapping: Object.fromEntries(['identity', 'completion', 'usage', 'cost'].map(group => [group, { ...plan.mapping[group], ...override.mapping?.[group] }])),
    costEstimate: Object.hasOwn(override, 'costEstimate') ? override.costEstimate : plan.costEstimate,
    pricing: spec.pricing || null,
    requested: { model: condition.model || null, adapterKind: condition.adapter.kind, collection: condition.collection || null },
    timing: { clock: 'host-monotonic', unit: 'microseconds', root: 'attempt-start-through-settlement',
      generation: 'adapter-reported; not inferred from collection latency', execution: 'native process wrapper, including engine/container startup',
      concurrency: 'one active trial in this project; concurrent external projects and provider work are unobserved' } }
}
export function validateObservationPlan(spec) {
  const plan = spec.observationPlan
  if (plan === undefined) return
  keys(plan, ['version', 'rationale', 'identity', 'completion', 'mapping', 'costEstimate', 'overrides'], 'Observation plan')
  invariant(plan.version === OBSERVATION_VERSION && text(plan.rationale), 'Observation accounting needs version 1 and a rationale.')
  validateMapping(plan.mapping)
  invariant(object(plan.overrides) && Object.keys(plan.overrides).every(id => spec.conditions.some(condition => condition.id === id)), 'Observation overrides must name existing conditions.')
  for (const override of Object.values(plan.overrides)) {
    keys(override, ['identity', 'completion', 'mapping', 'costEstimate'], 'Observation override')
    if (override.mapping !== undefined) validateMapping(override.mapping, true)
  }
  for (const condition of spec.conditions) {
    const contract = observationContract(spec, condition)
    validateIdentity(contract.identity, condition); validateEstimate(contract.costEstimate, spec)
    keys(contract.completion, ['policy'], 'Generation completion policy')
    invariant(['record', 'require-complete'].includes(contract.completion.policy), 'Record reported generation completion, or explicitly require complete generation.')
    if (condition.collection !== undefined) {
      keys(condition.collection, ['comparisonUnit', 'instructions', 'tools', 'contextConstruction', 'sessionIsolation'], 'Collection controls')
      invariant(['model', 'system', 'apparatus'].includes(condition.collection.comparisonUnit) && text(condition.collection.contextConstruction) && text(condition.collection.sessionIsolation), 'Declare the comparison unit, context construction and session isolation.')
      keys(condition.collection.instructions, ['system', 'developer'], 'Requested instructions')
      invariant(Object.values(condition.collection.instructions).every(value => value === null || typeof value === 'string') && Array.isArray(condition.collection.tools), 'Requested instructions use text or explicit null; exposed tools are declared as an array.')
      canonical(condition.collection) // A declaration is not a receipt that the adapter enforced it.
    }
  }
}

// A declaration is not a receipt. Record what the adapter reported it applied beside what
// the condition declared, and keep silence distinguishable from a kept restriction: an
// unreported or invalid count is unknown, never none. A replay condition dispatched no
// request at all, so no policy was applied to anything in this run.
function toolPolicyObservation(condition, usage) {
  const declaredTools = Array.isArray(condition.collection?.tools) ? condition.collection.tools : null
  const declared = declaredTools === null ? 'not-declared' : declaredTools.length ? 'restricted' : 'none'
  const calls = usage.toolCalls, recorded = condition.adapter.kind === 'replay'
  const applied = recorded ? 'no-collection' : calls.status === 'observed' ? (calls.value > 0 ? 'used' : 'none') : 'unreported'
  const agreement = applied === 'no-collection' || declared !== 'none' ? 'not-applicable'
    : applied === 'used' ? 'violation' : applied === 'none' ? 'match' : 'unverified'
  return { declared, declaredTools, applied, calls: applied === 'used' || applied === 'none' ? calls.value : null,
    basis: recorded ? 'recorded-response' : calls.status === 'observed' ? 'adapter-reported' : 'not-reported', agreement }
}
export function observeResponse(spec, condition, response) {
  const contract = observationContract(spec, condition)
  invariant(contract, 'Freeze an observation plan before normalizing provider metadata.')
  const identity = Object.fromEntries(IDENTITY_FIELDS.map(field => {
    const location = contract.mapping.identity[field], observed = measured(at(response, location), text, location), requested = condition.model?.[field] ?? null
    return [field, { ...observed, requested, comparison: !text(requested) ? 'not-requested' : observed.status !== 'observed' ? 'unavailable' : observed.value === requested ? 'match' : 'mismatch' }]
  }))
  const compared = contract.identity.fields.map(field => identity[field]), mismatch = compared.some(field => field.comparison === 'mismatch'), unavailable = compared.some(field => field.comparison !== 'match' && field.comparison !== 'mismatch')
  const usage = Object.fromEntries(USAGE_FIELDS.map(field => [field, measured(at(response, contract.mapping.usage[field]),
    field === 'generationMs' ? value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && decimal(value) !== null : value => Number.isSafeInteger(value) && value >= 0, contract.mapping.usage[field])]))
  const money = measured(at(response, contract.mapping.cost.amount), value => decimal(value) !== null, contract.mapping.cost.amount)
  const unit = measured(at(response, contract.mapping.cost.currency), currency, contract.mapping.cost.currency)
  const reportedCost = money.status === 'observed' && unit.status === 'observed'
    ? { status: 'observed', amount: decimalString(decimal(money.value).coefficient, decimal(money.value).scale), currency: unit.value, basis: 'adapter-reported', sourcePaths: contract.mapping.cost }
    : { status: money.status === 'invalid' || unit.status === 'invalid' ? 'invalid' : 'unavailable', amount: null, currency: unit.status === 'observed' ? unit.value : null, reason: 'amount-and-currency-required', fields: { amount: money, currency: unit } }
  const toolPolicy = toolPolicyObservation(condition, usage)
  const identityStatus = mismatch ? 'mismatch' : unavailable ? 'unavailable' : 'match'
  const completion = { status: measured(at(response, contract.mapping.completion.status), value => ['complete', 'incomplete'].includes(value), contract.mapping.completion.status),
    reason: measured(at(response, contract.mapping.completion.reason), text, contract.mapping.completion.reason) }
  const ineligibility = [
    ...(contract.identity.policy === 'require-match' && identityStatus !== 'match' ? ['identity-' + identityStatus] : []),
    ...(contract.completion.policy === 'require-complete' && completion.status.value !== 'complete' ? [completion.status.value === 'incomplete' ? 'incomplete-generation' : 'completion-unverified'] : []),
    // Unconditional, and needs no policy to opt into: an attempt that declared no tools and
    // reports having used them contradicts its own condition, so it measures something other
    // than what the study says it measured. An unreported count is not a violation; it is
    // recorded as unverified and stays eligible.
    ...(toolPolicy.agreement === 'violation' ? ['tool-policy-violated'] : []),
  ]
  return { version: OBSERVATION_VERSION, metadataOrigin: condition.adapter.kind === 'replay' ? 'recorded-response' : 'adapter-reported', requested: contract.requested, identity, identityStatus,
    eligible: ineligibility.length === 0, ineligibility, completion, usage, toolPolicy, reportedCost,
    estimatedCost: !contract.costEstimate && contract.pricing ? estimateFromPriceTable(contract, identity, usage) : estimateCost(contract.costEstimate, usage) }
}
// R1220. Where a study freezes a price table and declares no estimate of its own, an
// attempt that reported tokens is priced from that table. A declared estimate always
// wins: a frozen table never overrides what the study itself declared. Nothing here
// invents a rate, and no refusal becomes a zero.
function estimateFromPriceTable(contract, identity, usage) {
  const table = contract.pricing
  // The model actually billed is the one the adapter reported. The declared identifier
  // is the fallback, and which of the two was priced is recorded either way, because a
  // condition that ran on a different model must not be priced as the one it declared.
  const reported = identity.id?.status === 'observed' ? identity.id.value : null
  const declared = contract.requested.model?.id ?? null
  const pricedModelId = reported || declared
  const carried = { pricedModelId: pricedModelId || null, pricedModelSource: reported ? 'adapter-reported' : 'condition-declared', priceTableFrozenAsOf: table.frozenAsOf }
  if (!text(pricedModelId)) return { status: 'unavailable', amount: null, currency: table.currency, reason: 'no-model-identifier', ...carried }
  const totalTokens = usage.totalTokens?.status === 'observed' ? usage.totalTokens.value : undefined
  const rates = priceTermsFor(table, pricedModelId, { totalTokens })
  if (rates.status !== 'priced') {
    return { status: 'unavailable', amount: null, currency: table.currency, reason: rates.reason, ...(rates.missing ? { missing: rates.missing } : {}), ...carried }
  }
  const applied = estimateCost({ kind: 'unit-prices', currency: rates.currency, terms: rates.terms, sourcePaths: [] }, usage)
  const identified = { ...carried, billingModelId: rates.billingModelId, modelResolution: rates.basis, ...(rates.tierMappedAsOf ? { tierMappedAsOf: rates.tierMappedAsOf } : {}) }
  if (applied.status !== 'estimated') {
    return { status: applied.status, amount: null, currency: applied.currency, reason: applied.reason, ...(applied.fields ? { fields: applied.fields } : {}), ...(applied.term ? { term: applied.term } : {}), ...identified }
  }
  return { status: 'estimated', amount: applied.amount, currency: applied.currency, terms: applied.terms, rounding: applied.rounding,
    basis: 'estimated-at-list-prices', statement: 'Estimated at list API prices as of ' + table.frozenAsOf + '.',
    source: rates.source, declaredConventions: rates.declaredConventions, excludes: rates.excludes, ...identified }
}

function estimateCost(estimate, usage) {
  if (!estimate) return { status: 'unavailable', amount: null, currency: null, reason: 'no-estimation-convention' }
  if (estimate.kind === 'per-started-attempt') {
    const amount = decimal(estimate.amount)
    return { status: 'estimated', amount: decimalString(amount.coefficient, amount.scale), currency: estimate.currency, basis: 'declared-allocation-per-started-attempt', sourcePaths: estimate.sourcePaths }
  }
  let total = 0n
  const terms = []
  for (const term of estimate.terms) {
    const fields = [...term.add, ...term.subtract]
    if (fields.some(field => usage[field].status !== 'observed')) return { status: 'unavailable', amount: null, currency: estimate.currency, reason: 'missing-estimation-quantity', fields: fields.filter(field => usage[field].status !== 'observed') }
    const count = term.add.reduce((sum, field) => sum + BigInt(usage[field].value), 0n) - term.subtract.reduce((sum, field) => sum + BigInt(usage[field].value), 0n)
    if (count < 0n) return { status: 'invalid', amount: null, currency: estimate.currency, reason: 'negative-estimation-quantity', term: term.id }
    const rate = decimal(term.amount), numerator = count * rate.coefficient * 10n ** BigInt(18 - rate.scale), denominator = BigInt(term.per)
    const amount = (numerator * 2n + denominator) / (2n * denominator)
    total += amount; terms.push({ id: term.id, quantity: count.toString(), amount: decimalString(amount, 18) })
  }
  return { status: 'estimated', amount: decimalString(total, 18), currency: estimate.currency, basis: 'declared-unit-prices',
    rounding: 'each term rounded half-up to 18 currency decimal places', sourcePaths: estimate.sourcePaths, terms }
}

// A nested interval tree prevents summing parent totals and child phases twice.
// Only host code receives this meter; its functions never enter system requests.
export function createObservationMeter(clock = () => performance.now()) {
  const origin = clock(), spans = [], active = new Set()
  let closed = false, last = 0
  const tick = () => {
    const next = Math.round((clock() - origin) * 1000)
    invariant(Number.isSafeInteger(next) && next >= last, 'The observation clock moved backwards or exceeded its integer range.')
    last = next; return next
  }
  const root = { id: 's0', parentId: null, kind: 'attempt', startUs: 0, endUs: null, status: 'open' }; spans.push(root); active.add(root)
  const scope = parent => ({
    async span(kind, work) {
      // Late resource cleanup must still execute after a cancellation cutoff.
      if (closed || !active.has(parent)) return work(undefined)
      invariant(TIMING_KINDS.includes(kind) && kind !== 'attempt', 'Measurement phases need a declared kind.')
      invariant(spans.length < 1024, 'An attempt exceeds the 1,024-span measurement budget.')
      const row = { id: 's' + spans.length, parentId: parent.id, kind, startUs: tick(), endUs: null, status: 'open' }
      spans.push(row); active.add(row)
      try { const value = await work(scope(row)); if (!closed && active.has(row)) row.status = 'completed'; return value }
      catch (error) { if (!closed && active.has(row)) row.status = 'failed'; throw error }
      finally { if (!closed && active.has(row)) { row.endUs = tick(); active.delete(row) } }
    },
  })
  return { ...scope(root), truncateOpen() {
    if (closed) return
    const end = tick()
    for (const row of active) if (row !== root) { row.endUs = end; row.status = 'truncated'; active.delete(row) }
  }, finish(status) {
    invariant(!closed, 'An attempt measurement can finish only once.')
    const end = tick(); closed = true
    for (const row of active) { row.endUs = end; row.status = row === root ? status : 'truncated' }
    const result = { version: OBSERVATION_VERSION, clock: 'host-monotonic', unit: 'microseconds', spans: structuredClone(spans) }
    validateTimings(result); return result
  } }
}
export const measuredPhase = (scope, kind, work) => scope ? scope.span(kind, work) : work(undefined)
export function validateTimings(record) {
  keys(record, ['version', 'clock', 'unit', 'spans'], 'Host timing record')
  invariant(record.version === OBSERVATION_VERSION && record.clock === 'host-monotonic' && record.unit === 'microseconds' && Array.isArray(record.spans) && record.spans.length > 0 && record.spans.length <= 1024, 'Host timing records need a bounded monotonic interval tree.')
  const byId = new Map()
  for (const [index, span] of record.spans.entries()) {
    keys(span, ['id', 'parentId', 'kind', 'startUs', 'endUs', 'status'], 'Timing span')
    invariant(span.id === 's' + index && TIMING_KINDS.includes(span.kind) && Number.isSafeInteger(span.startUs) && span.startUs >= 0 && Number.isSafeInteger(span.endUs) && span.endUs >= span.startUs && ['completed', 'failed', 'cancelled', 'truncated'].includes(span.status), 'A timing span is invalid.')
    if (index === 0) invariant(span.parentId === null && span.kind === 'attempt' && span.startUs === 0, 'A timing tree needs one attempt root.')
    else {
      const parent = byId.get(span.parentId)
      invariant(parent && span.kind !== 'attempt' && span.startUs >= parent.startUs && span.endUs <= parent.endUs, 'Timing spans must stay within their declared parent interval.')
      invariant(![...byId.values()].some(prior => prior.parentId === span.parentId && span.startUs < prior.endUs && prior.startUs < span.endUs), 'Sibling measurement intervals cannot overlap; use nesting for inclusive totals.')
    }
    byId.set(span.id, span)
  }
  return record
}
export function observationTimingSummary(record) {
  if (!record) return { status: 'unavailable', totalMs: null, reason: 'no-host-timing-record', phases: [] }
  validateTimings(record)
  return { status: 'measured', totalMs: record.spans[0].endUs / 1000, phases: record.spans.map(span => {
    const children = record.spans.filter(child => child.parentId === span.id), inclusiveUs = span.endUs - span.startUs
    return { ...span, inclusiveMs: inclusiveUs / 1000, exclusiveMs: (inclusiveUs - children.reduce((sum, child) => sum + child.endUs - child.startUs, 0)) / 1000 }
  }) }
}

export function metricAggregate(values, attempts, { money = false, continuous = false } = {}) {
  const observed = values.filter(value => value.status === 'observed' || value.status === 'estimated'), unavailable = values.filter(value => value.status === 'unavailable').length, invalid = values.filter(value => value.status === 'invalid').length
  const subtotal = observed.length ? (money || continuous ? addDecimals(observed.map(value => money ? value.amount : value.value)) : observed.reduce((sum, value) => sum + BigInt(value.value), 0n).toString()) : null
  const complete = attempts > 0 && observed.length === attempts
  return { status: complete ? 'complete' : observed.length ? 'partial' : 'unavailable', attempts, observed: observed.length, unavailable, invalid,
    observedSubtotal: subtotal, total: complete ? subtotal : null }
}

function observeWorkflow(spec, condition, workflow) {
  const calls = workflow.stages.map(record => ({ step: record.start.step, stageId: record.start.stageId, status: record.finish?.status || 'interrupted',
    reported: observeResponse(spec, { ...condition, collection: record.start.request.collection }, record.finish?.response) }))
  const observed = calls.map(call => call.reported), result = observeResponse(spec, condition, undefined), contract = observationContract(spec, condition)
  result.metadataOrigin += '-workflow'
  result.calls = calls
  result.scope = 'all-started-workflow-stages'
  for (const field of IDENTITY_FIELDS) {
    const values = observed.map(row => row.identity[field]), same = values.length > 0 && values.every(value => value.status === 'observed' && value.value === values[0].value)
    result.identity[field] = same ? { ...values[0], sourcePath: null, basis: 'all-stage-reports-agree' } : { ...result.identity[field], reason: 'stage-identity-missing-or-mixed', comparison: values.some(value => value.comparison === 'mismatch') ? 'mismatch' : 'unavailable' }
  }
  result.identityStatus = observed.some(row => row.identityStatus === 'mismatch') ? 'mismatch' : observed.length > 0 && observed.every(row => row.identityStatus === 'match') ? 'match' : 'unavailable'
  result.eligible = observed.length > 0 && observed.every(row => row.eligible)
  result.ineligibility = [...new Set(observed.flatMap(row => row.ineligibility))]
  if (!observed.length) result.ineligibility.push('no-stage-response')
  const completions = observed.map(row => row.completion.status)
  if (completions.length && completions.every(row => row.status === 'observed')) result.completion.status = { status: 'observed', value: completions.every(row => row.value === 'complete') ? 'complete' : 'incomplete', sourcePath: null, basis: 'all-stage-reports' }
  for (const field of USAGE_FIELDS) {
    const values = observed.map(row => row.usage[field]), all = values.length > 0 && values.every(row => row.status === 'observed')
    if (all) {
      const total = field === 'generationMs' ? Number(addDecimals(values.map(row => row.value))) : values.reduce((sum, row) => sum + row.value, 0)
      result.usage[field] = (field === 'generationMs' ? Number.isFinite(total) : Number.isSafeInteger(total)) ? { status: 'observed', value: total, sourcePath: null, basis: 'sum-of-all-stage-reports' } : { status: 'invalid', value: null, sourcePath: null, reason: 'stage-sum-exceeds-safe-range' }
    } else result.usage[field] = { status: values.some(row => row.status === 'invalid') ? 'invalid' : 'unavailable', value: null, sourcePath: null, reason: 'stage-measurement-missing-or-invalid' }
  }
  const costs = observed.map(row => row.reportedCost)
  if (costs.length && costs.every(row => row.status === 'observed' && row.currency === costs[0].currency)) result.reportedCost = { status: 'observed', amount: addDecimals(costs.map(row => row.amount)), currency: costs[0].currency, basis: 'sum-of-all-stage-reports', sourcePaths: null }
  else result.reportedCost = { status: costs.some(row => row.status === 'invalid') ? 'invalid' : 'unavailable', amount: null, currency: null, reason: 'stage-cost-missing-invalid-or-multiple-currencies; inspect-per-stage-records' }
  // A per-started-attempt allocation is charged once. Unit prices apply to
  // all stage quantities under the existing per-attempt rounding convention.
  result.estimatedCost = estimateCost(contract.costEstimate, result.usage)
  return result
}
export function attemptObservations(project, trial, event, timings = null) {
  if (!project.spec.observationPlan) return null
  const condition = project.spec.conditions.find(row => row.id === trial.conditionId)
  return { version: OBSERVATION_VERSION, reported: event.workflow ? observeWorkflow(project.spec, condition, event.workflow) : observeResponse(project.spec, condition, event.response), timings,
    timingUnavailableReason: timings ? null : event.status === 'interrupted' ? 'interrupted-before-durable-measurement' : 'no-host-timing-record' }
}
export function validateAttemptObservations(project, trial, event) {
  if (!project.spec.observationPlan) { invariant(event.observations === undefined, 'Observation records require their frozen mapping and policy.'); return }
  keys(event.observations, ['version', 'reported', 'timings', 'timingUnavailableReason'], 'Attempt observations')
  const expected = attemptObservations(project, trial, event, event.observations.timings)
  invariant(canonical(expected) === canonical(event.observations), 'The observation record disagrees with its retained response or frozen policy.')
  if (event.status === 'interrupted') invariant(event.observations.timings === null, 'Recovery cannot invent measured phase durations.')
  else {
    const timing = observationTimingSummary(event.observations.timings)
    invariant(timing.status === 'measured' && timing.totalMs === event.elapsedMs && event.observations.timings.spans[0].status === event.status, 'Attempt duration and measured root interval disagree.')
  }
  if (event.status === 'completed') invariant(expected.reported.eligible, 'A completed response violates the frozen observation policy.')
  if (event.phase === 'observation') invariant(event.status !== 'completed' && !expected.reported.eligible, 'An observation-policy failure needs an ineligible retained observation.')
}

export function attemptDisposition(event) {
  if (!event) return 'open'
  if (event.status === 'completed') return event.grade.classification || (event.grade.passed === null ? 'unscored' : event.grade.passed ? 'correct' : 'incorrect')
  if (event.status === 'cancelled' || event.status === 'interrupted') return event.status
  if (event.phase === 'extraction') return 'response-extraction-error'
  if (event.phase === 'observation') return event.observations?.reported.ineligibility.join('+') || 'observation-policy-failure'
  if (event.phase === 'workflow') return 'workflow-halted'
  return event.phase === 'grading' ? 'apparatus-error' : 'transport-error'
}

function costAggregate(values) {
  const available = values.filter(value => ['observed', 'estimated'].includes(value.status))
  const complete = values.length > 0 && available.length === values.length
  return { status: complete ? 'complete' : available.length ? 'partial' : 'unavailable', attempts: values.length,
    observed: available.length, unavailable: values.filter(value => value.status === 'unavailable').length, invalid: values.filter(value => value.status === 'invalid').length,
    // Unknown attempts might add cost in any currency. Only a complete set of
    // charges supports full per-currency totals; never produce a scalar sum.
    byCurrency: [...new Set(available.map(value => value.currency))].sort().map(currency => {
      const amounts = available.filter(value => value.currency === currency), subtotal = addDecimals(amounts.map(value => value.amount))
      return { currency, observed: amounts.length, observedSubtotal: subtotal, total: complete ? subtotal : null }
    }) }
}
const counts = (rows, field) => Object.fromEntries([...new Set(rows.map(field))].sort().map(value => [value, rows.filter(row => field(row) === value).length]))
const costsByOrigin = (rows, field) => ({ attempts: rows.length,
  byOrigin: [...new Set(rows.map(row => row.reported.metadataOrigin))].sort().map(origin => ({ origin, ...costAggregate(rows.filter(row => row.reported.metadataOrigin === origin).map(row => row.reported[field])) })) })
function observationGroup(rows) {
  const spans = rows.flatMap(row => row.timing.phases)
  const calls = rows.flatMap(row => row.reported.calls ? row.reported.calls.map(call => ({ reported: call.reported })) : [row])
  return { attempts: rows.length, outcomes: counts(rows, row => row.disposition), identities: counts(rows, row => row.reported.identityStatus),
    generation: counts(rows, row => row.reported.completion.status.status === 'observed' ? row.reported.completion.status.value : row.reported.completion.status.status),
    metadataOrigins: counts(rows, row => row.reported.metadataOrigin),
    ...(rows.some(row => row.reported.calls) ? { collectionCalls: calls.length, resourceUnit: 'started-collection-call; workflow stages counted separately' } : {}),
    usage: Object.fromEntries(USAGE_FIELDS.map(field => [field, metricAggregate(calls.map(row => row.reported.usage[field]), calls.length, { continuous: field === 'generationMs' })])),
    reportedCost: costsByOrigin(calls, 'reportedCost'), estimatedCost: costsByOrigin(rows, 'estimatedCost'),
    host: { attemptMs: metricAggregate(rows.map(row => row.timing.status === 'measured' ? { status: 'observed', value: row.timing.totalMs } : missing(row.timing.reason)), rows.length, { continuous: true }),
      recoveryBudgetChargeMs: rows.reduce((sum, row) => sum + (row.recoveryBudgetChargeMs ?? 0), 0), recoveredAttempts: rows.filter(row => row.status === 'interrupted').length,
      phases: TIMING_KINDS.map(kind => {
        const selected = spans.filter(span => span.kind === kind)
        return { kind, spans: selected.length, attempts: rows.filter(row => row.timing.phases.some(span => span.kind === kind)).length,
          truncated: selected.filter(span => span.status === 'truncated').length,
          inclusiveSubtotalMs: selected.length ? addDecimals(selected.map(span => span.inclusiveMs)) : null,
          exclusiveSubtotalMs: selected.length ? addDecimals(selected.map(span => span.exclusiveMs)) : null }
      }) } }
}

export function observationAnalysis(project, events) {
  if (!project.spec.observationPlan) return null
  validateObservationPlan(project.spec)
  const trials = new Map(project.schedule.map(trial => [trial.id, trial])), conditions = new Map(project.spec.conditions.map(condition => [condition.id, condition]))
  const ends = new Map(events.filter(event => event.type === 'finished').map(event => [event.trialId + ':' + event.attempt, event]))
  const stageRecords = new Map(), stageFinishes = new Map(), key = event => event.trialId + ':' + event.attempt
  for (const event of events) {
    if (event.type === 'workflow-started') { if (!stageRecords.has(key(event))) stageRecords.set(key(event), []); stageRecords.get(key(event)).push(event) }
    if (event.type === 'workflow-finished') stageFinishes.set(key(event) + ':' + event.step, event)
  }
  const rows = events.filter(event => event.type === 'started').map(start => {
    const trial = trials.get(start.trialId), end = ends.get(start.trialId + ':' + start.attempt), condition = conditions.get(trial.conditionId)
    const openWorkflow = condition.workflowId && !end?.observations ? { stages: (stageRecords.get(key(start)) || []).map(start => ({ start, finish: stageFinishes.get(key(start) + ':' + start.step) })) } : null
    const reported = end?.observations?.reported || (openWorkflow ? observeWorkflow(project.spec, condition, openWorkflow) : observeResponse(project.spec, condition, undefined))
    const timing = observationTimingSummary(end?.observations?.timings)
    if (timing.status === 'unavailable') timing.reason = end?.observations?.timingUnavailableReason || 'attempt-has-no-terminal-record'
    return { trialId: start.trialId, taskId: trial.taskId, conditionId: trial.conditionId, replicate: trial.replicate, attempt: start.attempt,
      startedAt: start.at, status: end?.status || 'open', disposition: attemptDisposition(end), selectedForScore: end?.status === 'completed',
      responseRetained: !!end && Object.hasOwn(end, 'response'), outputRetained: !!end?.response && Object.hasOwn(end.response, 'output'),
      reported, timing, recoveryBudgetChargeMs: end?.budgetChargeMs ?? null }
  })
  const attemptedTrials = new Set(rows.map(row => row.trialId))
  return JSON.parse(canonical({ version: OBSERVATION_VERSION, scope: 'all-started-collection-attempts', plan: project.spec.observationPlan,
    contracts: project.spec.conditions.map(condition => ({ condition: condition.id, ...observationContract(project.spec, condition) })),
    scheduled: project.schedule.length, unattempted: project.schedule.filter(trial => !attemptedTrials.has(trial.id)).length,
    totals: observationGroup(rows), groups: project.spec.conditions.map(condition => ({ condition: condition.id, ...observationGroup(rows.filter(row => row.conditionId === condition.id)) })),
    origins: [...new Set(rows.map(row => row.reported.metadataOrigin))].sort().map(origin => ({ origin, ...observationGroup(rows.filter(row => row.reported.metadataOrigin === origin)) })), rows,
    limitations: [
      'Resources include every started attempt, including retries, failures, cancellations and interrupted or open attempts. Only completed responses enter scoring; cost is never selected by output quality.',
      'Identity, generation status and usage are adapter reports, not independently authenticated receipts. Requested settings and collection controls are declarations; their enforcement is not inferred. Unknown generation status is not inferred from returned text or an arbitrary finish reason.',
      'Reported cost covers the mapped collection response only. Declared price or subscription allocations are separate estimates. Grader fees, host infrastructure charges and a complete experiment monetary cost are unobserved. Currencies are not converted or added together.',
      'Replay envelopes contain recorded metadata; their usage and charges do not represent new provider calls. Host timing measures the current replay or collection attempt.',
      'Host attempt time includes durable start, collection, extraction, persistence, grading and settlement; terminal journal writing, between-attempt work, preparation, later verification and offline time are outside that interval. Native execution time includes container/engine startup. Inclusive phase times overlap their children; only exclusive phase durations partition measured attempt time.',
      'Interrupted and open attempts have no inferred elapsed time. Recovery reserves the declared timeout against the run budget; that charge is not a measured duration. Cancellation may truncate in-flight phases; subsequent owned cleanup is included in settlement when observed. External project and provider concurrency are unobserved.',
    ] }))
}

export function observationProjectFiles(project) {
  if (!project.spec.observationPlan) return {}
  return { 'observations/plan.json': JSON.stringify(project.spec.observationPlan, null, 2) + '\n',
    'observations/contracts.json': JSON.stringify(project.spec.conditions.map(condition => ({ condition: condition.id, ...observationContract(project.spec, condition) })), null, 2) + '\n' }
}
