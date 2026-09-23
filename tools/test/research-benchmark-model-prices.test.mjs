import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { priceTableIdentity, priceTermsFor, validatePriceTable } from '../../src/benchmark/observations.mjs'

// R1220. The committed table is the only place a rate may come from. These tests never reach a
// network and never assert that a rate is correct pricing: they assert the table says what it was
// read to say, that every derivation from it is refusable, and that a missing fact is never
// silently worth zero. Real rates were compiled by Worker 5 from the providers' official pages
// (evidence/manager-45-20260910/R1220/PRICE-SOURCES.json); the fixture below is SYNTHETIC.
const table = JSON.parse(await readFile(new URL('../../src/benchmark/model-prices.json', import.meta.url), 'utf8'))

const cite = { url: 'https://example.invalid/pricing', retrievedAt: '2026-09-11', contentSha256: 'f'.repeat(64), quote: 'synthetic' }
const row = (billingModelId, cachedInputConvention, rates) => ({ billingModelId, provider: 'Synthetic', serviceTier: 'Standard, short context', cachedInputConvention, rates, source: cite })
const synthetic = {
  schemaVersion: 1, frozenAsOf: '2026-09-11', currency: 'USD', unit: 1000000,
  note: 'SYNTHETIC FIXTURE RATES - not actual provider pricing.',
  knownUnpriced: [],
  models: [
    row('synthetic-excludes', 'input-excludes-cached', { inputTokens: '3', outputTokens: '15', cachedInputTokens: '0.30' }),
    row('synthetic-includes', 'input-includes-cached', { inputTokens: '3', outputTokens: '15', cachedInputTokens: '0.30' }),
    row('synthetic-no-convention', null, { inputTokens: '3', outputTokens: '15', cachedInputTokens: '0.30' }),
    row('synthetic-no-output-rate', 'input-excludes-cached', { inputTokens: '3' }),
  ],
  tierMap: [{ tier: 'synthetic-tier', billingModelId: 'synthetic-excludes', asOf: '2026-09-11', source: cite }],
}

test('the committed table declares its frozen date, currency, unit and per-row citations', () => {
  validatePriceTable(table)
  assert.equal(table.schemaVersion, 1)
  assert.ok(table.frozenAsOf <= '2026-09-11')
  assert.equal(table.currency, 'USD')
  assert.equal(table.unit, 1000000)
  assert.ok(table.models.length > 0)
  for (const model of table.models) {
    assert.ok(model.billingModelId && model.provider, model.billingModelId)
    assert.ok(model.source.url.startsWith('https://'), model.billingModelId)
    assert.equal(model.source.retrievedAt, '2026-09-11', model.billingModelId)
    assert.ok(typeof model.source.quote === 'string' && model.source.quote.length > 0, model.billingModelId)
    assert.ok(typeof model.serviceTier === 'string' && model.serviceTier.length > 0, model.billingModelId)
  }
})

test('the committed table carries the exact billing ids and rates read from the official pages', () => {
  const find = id => table.models.find(model => model.billingModelId === id)
  assert.equal(find('Claude Sonnet 5').rates.inputTokens, '2')
  assert.equal(find('Claude Sonnet 5').rates.outputTokens, '10')
  assert.equal(find('Claude Sonnet 5').rates.cachedInputTokens, '0.20')
  assert.equal(find('gpt-5.6-luna').rates.inputTokens, '0.20')
  assert.equal(find('gpt-5.6-luna').rates.outputTokens, '1.20')
  assert.equal(find('gpt-5.6-luna').rates.cachedInputTokens, '0.02')
  assert.match(find('gpt-5.6-luna').serviceTier, /Standard/)
})

test('a model in neither the rows nor the tier map is UNPRICED, never free', () => {
  const result = priceTermsFor(synthetic, 'a-model-nobody-priced')
  assert.equal(result.status, 'unpriced')
  assert.equal(result.reason, 'model-not-in-price-table')
  assert.equal(result.terms, undefined)
})

test('a row missing a rate for a priced quantity is refused, never treated as zero', () => {
  const result = priceTermsFor(synthetic, 'synthetic-no-output-rate')
  assert.equal(result.status, 'unpriced')
  assert.equal(result.reason, 'missing-rate')
  assert.deepEqual(result.missing, ['outputTokens'])
})

test('a tier name resolves through the declared dated map and is labelled tier-mapped', () => {
  const result = priceTermsFor(synthetic, 'synthetic-tier')
  assert.equal(result.status, 'priced')
  assert.equal(result.basis, 'tier-mapped')
  assert.equal(result.billingModelId, 'synthetic-excludes')
  assert.equal(result.tierMappedAsOf, '2026-09-11')
  assert.equal(priceTermsFor(synthetic, 'synthetic-excludes').basis, 'exact-billing-model-id')
})

test('input-excludes-cached charges input and cached separately, with no subtraction', () => {
  const result = priceTermsFor(synthetic, 'synthetic-excludes')
  assert.equal(result.status, 'priced')
  const input = result.terms.find(term => term.id === 'input')
  assert.deepEqual(input.add, ['inputTokens'])
  assert.deepEqual(input.subtract, [])
  assert.deepEqual(result.terms.find(term => term.id === 'cached-input').add, ['cachedInputTokens'])
})

test('input-includes-cached subtracts cached tokens from the full-rate term, so no token is charged twice', () => {
  const result = priceTermsFor(synthetic, 'synthetic-includes')
  assert.equal(result.status, 'priced')
  const input = result.terms.find(term => term.id === 'input')
  assert.deepEqual(input.add, ['inputTokens'])
  assert.deepEqual(input.subtract, ['cachedInputTokens'])
  const cached = result.terms.find(term => term.id === 'cached-input')
  assert.deepEqual(cached.add, ['cachedInputTokens'])
  assert.deepEqual(cached.subtract, [])
  assert.equal(result.terms.flatMap(term => term.add).filter(field => field === 'cachedInputTokens').length, 1)
})

test('a model with no cited cached-token convention is refused rather than guessed', () => {
  const result = priceTermsFor(synthetic, 'synthetic-no-convention')
  assert.equal(result.status, 'unpriced')
  assert.equal(result.reason, 'cached-convention-undeclared')
})

test('the table has an identity, and changing any rate changes it', async () => {
  const before = await priceTableIdentity(synthetic)
  assert.match(before, /^[a-f0-9]{64}$/)
  const changed = JSON.parse(canonical(synthetic))
  changed.models[0].rates.inputTokens = '4'
  assert.notEqual(await priceTableIdentity(changed), before)
  assert.equal(await priceTableIdentity(JSON.parse(canonical(synthetic))), before)
  assert.equal(before, await sha256(canonical(synthetic)))
})

test('the strings that are not models are absent, and no unmatched string is priced', () => {
  const ids = table.models.map(model => model.billingModelId)
  const tiers = table.tierMap.map(entry => entry.tier)
  // gemini-1 and grok-1 are SEAT ids; bare gpt-5.6 is the example-fleet simulation default.
  // None is a model, so none may appear as a row, as a map entry, or as a priced result.
  for (const notAModel of ['gemini-1', 'grok-1', 'gpt-5.6']) {
    assert.ok(!ids.includes(notAModel), notAModel)
    assert.ok(!tiers.includes(notAModel), notAModel)
    assert.equal(priceTermsFor(table, notAModel).status, 'unpriced', notAModel)
  }
  assert.deepEqual(table.knownUnpriced, [])
})

test('the Claude bare aliases are mapped, dated and labelled; the Codex tiers need no map', () => {
  for (const [tier, billingModelId] of [['fable', 'Claude Fable 5.1'], ['sonnet', 'Claude Sonnet 5'], ['opus', 'Claude Opus 5']]) {
    const result = priceTermsFor(table, tier)
    assert.equal(result.status, 'priced', tier)
    assert.equal(result.basis, 'tier-mapped', tier)
    assert.equal(result.billingModelId, billingModelId)
    assert.equal(result.tierMappedAsOf, '2026-09-11')
  }
  // Codex tiers are the billing ids themselves, so they resolve exactly and are NOT in the map.
  for (const exact of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.equal(priceTermsFor(table, exact).basis, 'exact-billing-model-id', exact)
    assert.ok(!table.tierMap.some(entry => entry.tier === exact), exact)
  }
})

test("every Anthropic cache-hit rate matches the official footnote's multiplier of base input", () => {
  // Footnote 1: cache hits and refreshes cost 0.025x base input for Fable 5.1, 0.1x for the rest.
  // Arithmetic on the committed rates, so a mistyped rate is caught rather than trusted.
  for (const model of table.models.filter(model => model.provider === 'Anthropic')) {
    const expected = model.billingModelId === 'Claude Fable 5.1' ? 0.025 : 0.1
    const actual = Number(model.rates.cachedInputTokens) / Number(model.rates.inputTokens)
    assert.ok(Math.abs(actual - expected) < 1e-9, `${model.billingModelId} cache hit is ${actual} of base input, expected ${expected}`)
    assert.equal(model.cacheHitMultiplierOfBaseInput, String(expected))
  }
})

test('the checker credit weights are never a price source', () => {
  assert.match(table.doNotUse, /CHECKER_RATE_CARD/)
  assert.match(table.doNotUse, /not currency/)
})

test('reasoning tokens are charged only where the provider reports them outside its output count', () => {
  // Google reports thoughtsTokenCount SEPARATELY and prices output as including thinking, so the
  // output term adds it. xAI already counts reasoning inside completion_tokens, so adding it would
  // charge the same tokens twice. Getting either backwards is a silent mispricing.
  const google = priceTermsFor(table, 'gemini-3.1-pro-preview', { totalTokens: 100000 })
  assert.equal(google.status, 'priced')
  assert.deepEqual(google.terms.find(term => term.id === 'output').add, ['outputTokens', 'reasoningTokens'])
  assert.equal(google.reasoningConvention, 'separate-billed-as-output')
  assert.ok(google.declaredConventions.some(line => /reasoning tokens/.test(line)), 'the declared convention is labelled on the estimate')

  const xai = priceTermsFor(table, 'grok-4.6', { totalTokens: 100000 })
  assert.equal(xai.status, 'priced')
  assert.deepEqual(xai.terms.find(term => term.id === 'output').add, ['outputTokens'])
  assert.equal(xai.reasoningConvention, 'inside-output')
  for (const model of ['sonnet', 'gpt-6-astra']) {
    assert.deepEqual(priceTermsFor(table, model).terms.find(term => term.id === 'output').add, ['outputTokens'], model)
  }
})

test('three providers nest cached tokens inside the input count and one does not', () => {
  const subtractFor = (model, options) => priceTermsFor(table, model, options).terms.find(term => term.id === 'input').subtract
  assert.deepEqual(subtractFor('sonnet'), [], 'Anthropic input excludes cached, so nothing is removed')
  assert.deepEqual(subtractFor('gpt-6-astra'), ['cachedInputTokens'])
  assert.deepEqual(subtractFor('gemini-3.1-pro-preview', { totalTokens: 100000 }), ['cachedInputTokens'])
  assert.deepEqual(subtractFor('grok-4.6', { totalTokens: 100000 }), ['cachedInputTokens'])
  for (const model of table.models) {
    assert.equal(model.inputIncludesCached, model.provider !== 'Anthropic', model.billingModelId)
    assert.ok(model.usageConventionQuote.length > 0, model.billingModelId)
  }
})

test('a context-tiered model takes the rate for the side of the threshold it actually fell on', () => {
  const below = priceTermsFor(table, 'gemini-3.1-pro-preview', { totalTokens: 200000 })
  const above = priceTermsFor(table, 'gemini-3.1-pro-preview', { totalTokens: 200001 })
  assert.equal(below.terms.find(term => term.id === 'input').amount, '2.00')
  assert.equal(above.terms.find(term => term.id === 'input').amount, '4.00', 'the short rate is never applied above the threshold')
  assert.equal(below.terms.find(term => term.id === 'output').amount, '12.00')
  assert.equal(above.terms.find(term => term.id === 'output').amount, '18.00')
  // Without a token count there is no way to know which side it fell on, so it is unpriced.
  assert.equal(priceTermsFor(table, 'grok-4.6').status, 'unpriced')
  assert.equal(priceTermsFor(table, 'grok-4.6').reason, 'context-tier-unresolved')
})

test('cache writes are declared priced-but-unreported or absent, and never silently dropped', () => {
  for (const model of table.models) {
    assert.ok(['priced-but-unreported', 'absent'].includes(model.cacheWrites), model.billingModelId)
  }
  assert.ok(table.excludes.some(line => /Cache-write/i.test(line)), 'the table names cache writes as excluded')
  assert.ok(table.excludes.some(line => /cache storage/i.test(line)), 'the table names time-billed cache storage as excluded')
  const priced = priceTermsFor(table, 'sonnet')
  assert.ok(priced.excludes.some(line => /Unpriced components for Claude Sonnet 5/.test(line)), 'the estimate carries the row-level exclusions')
})

test('a row that declares a cached-token convention never tells the owner cached terms are refused', () => {
  // A row's caveat is printed to the owner in declaredConventions, beside the estimate it qualifies.
  // gemini-3.1-pro-preview and grok-4.6 each said "cached terms are refused for this model" while
  // declaring input-includes-cached, so one report both charged cached tokens and said it had not.
  // The committed table must never say both, and the loader must refuse a table that does.
  for (const model of table.models) {
    if (!model.cachedInputConvention) continue
    assert.doesNotMatch(model.caveat ?? '', /cached[^.]*\brefus/i,
      `${model.billingModelId} declares ${model.cachedInputConvention}, so its cached tokens are charged and its caveat cannot say they are refused`)
  }
  validatePriceTable(table)
  // The guard lives in the loader, not only in this file: a contradictory row is refused at freeze
  // time, so it can never reach a report at all.
  const contradictory = JSON.parse(canonical(table))
  contradictory.models.find(model => model.billingModelId === 'grok-4.6').caveat =
    'The cached-token convention is not stated, so cached terms are refused for this model.'
  assert.throws(() => validatePriceTable(contradictory), /its caveat says they are refused/)
})
