// R1220. An attempt that reports tokens but no charge is estimated from the frozen,
// dated, cited table and from nothing else. Every rule here is a place where the wrong
// answer is a plausible number rather than a visible failure, so each is asserted:
// an unpriced model is unavailable and never zero, a missing quantity leaves the
// estimate unavailable so a full total stays null, and a convention the provider never
// stated is refused instead of guessed. No network is reached.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { observationPlanFromSpec, observeResponse } from '../../src/benchmark/observations.mjs'

const table = JSON.parse(await readFile(new URL('../../src/benchmark/model-prices.json', import.meta.url), 'utf8'))
const specFor = (pricing, costEstimate = null) => ({ observationPlan: { ...observationPlanFromSpec(), costEstimate }, ...(pricing ? { pricing } : {}) })
const conditionFor = declared => ({ id: 'c1', model: { provider: 'anthropic', id: declared }, adapter: { kind: 'command' } })
const responseWith = (usage, reported = null) => ({ identity: reported ? { id: reported } : {}, usage, completion: { status: 'complete' } })
const TOKENS = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, totalTokens: 1500 }
const estimate = (spec, condition, response) => observeResponse(spec, condition, response).estimatedCost

test('an attempt reporting tokens but no charge is priced from the frozen table', () => {
  const result = estimate(specFor(table), conditionFor('Claude Sonnet 5'), responseWith(TOKENS))
  assert.equal(result.status, 'estimated')
  assert.equal(result.basis, 'estimated-at-list-prices')
  assert.equal(result.currency, 'USD')
  assert.equal(result.billingModelId, 'Claude Sonnet 5')
  assert.equal(result.priceTableFrozenAsOf, '2026-09-11')
  // 1000 input at 2/MTok plus 500 output at 10/MTok plus 0 cached at 0.20/MTok.
  assert.ok(Math.abs(Number(result.amount) - 0.007) < 1e-12, result.amount)
})

test('the reported charge stays separate: this estimate never overwrites one', () => {
  const observed = observeResponse(specFor(table), conditionFor('Claude Sonnet 5'), responseWith(TOKENS))
  assert.equal(observed.reportedCost.status, 'unavailable')
  assert.equal(observed.reportedCost.amount, null)
})

test('a model the table does not price is unavailable, never zero', () => {
  const result = estimate(specFor(table), conditionFor('a-model-nobody-priced'), responseWith(TOKENS))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'model-not-in-price-table')
  assert.equal(result.amount, null)
})

test('a missing measured quantity leaves the estimate unavailable, so a full total stays null', () => {
  const partial = { inputTokens: 1000, cachedInputTokens: 0, totalTokens: 1000 }
  const result = estimate(specFor(table), conditionFor('Claude Sonnet 5'), responseWith(partial))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.amount, null)
  assert.equal(result.reason, 'missing-estimation-quantity')
})

test('a rate that changes with context length is refused when the token count is unknown', () => {
  const noTotal = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }
  const result = estimate(specFor(table), conditionFor('grok-4.6'), responseWith(noTotal))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'context-tier-unresolved')
  assert.equal(result.amount, null)
})

test('the model the adapter reports is priced, not the one the condition declared', () => {
  const result = estimate(specFor(table), conditionFor('sonnet'), responseWith(TOKENS, 'Claude Opus 5'))
  assert.equal(result.status, 'estimated')
  assert.equal(result.billingModelId, 'Claude Opus 5')
  assert.equal(result.pricedModelId, 'Claude Opus 5')
  assert.equal(result.pricedModelSource, 'adapter-reported')
  // With nothing reported, the declared identifier is priced and labelled as declared.
  const declared = estimate(specFor(table), conditionFor('sonnet'), responseWith(TOKENS))
  assert.equal(declared.billingModelId, 'Claude Sonnet 5')
  assert.equal(declared.pricedModelSource, 'condition-declared')
})

test('a study that declares its own estimate keeps it; the table never overrides a declaration', () => {
  const declaredEstimate = { kind: 'per-started-attempt', amount: '1.00', currency: 'USD', rationale: 'declared', sourcePaths: ['prices.json'] }
  const result = estimate(specFor(table, declaredEstimate), conditionFor('Claude Sonnet 5'), responseWith(TOKENS))
  assert.equal(result.basis, 'declared-allocation-per-started-attempt')
  // The declared path normalises trailing zeros, so '1.00' is retained as '1'.
  assert.equal(Number(result.amount), 1)
})

test('a study with no table and no declaration is unchanged: no convention, no estimate', () => {
  const result = estimate(specFor(null), conditionFor('Claude Sonnet 5'), responseWith(TOKENS))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'no-estimation-convention')
  assert.equal(result.amount, null)
})

test('the estimate carries the citation the rate came from, so a report can print it', () => {
  const result = estimate(specFor(table), conditionFor('Claude Sonnet 5'), responseWith(TOKENS))
  assert.ok(result.source.url.startsWith('https://'))
  assert.equal(result.source.retrievedAt, '2026-09-11')
  assert.ok(result.source.quote.length > 0)
  assert.ok(result.declaredConventions.length > 0)
  assert.ok(result.excludes.some(line => /Unpriced components for Claude Sonnet 5/.test(line)))
})

// ---- The attach rule ----
// A study that says nothing about cost gets the committed table at freeze time, and
// only at freeze time. Rebuilding a project must never attach, or every project frozen
// before this existed would stop verifying, and a study that declares its own estimate
// or its own table must be left exactly as it is.
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, prepareStudyReview, verifyProject, RUNTIME_FILES } from '../../src/benchmark/study.mjs'

const REVIEWER = 'PRICE ATTACH FIXTURE MARKER ONLY'
const runtime = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
async function study({ edit = () => {} } = {}) {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  // A study that accounts for attempts at all is the only kind a price table can serve,
  // so the fixture declares the plan the attach rule now requires.
  spec.observationPlan = observationPlanFromSpec()
  edit(spec)
  spec = await bindRuntimeSources(spec, await runtime())
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return spec
}

test('freezing a study that declares no cost convention attaches the committed table', async () => {
  const project = await freezeStudy(await study())
  assert.equal(project.spec.pricing.frozenAsOf, '2026-09-11')
  assert.equal(project.spec.pricing.currency, 'USD')
  assert.equal(project.spec.pricing.models.length, table.models.length)
  await verifyProject(project)
})

test('a study that already carries a table keeps its own, untouched', async () => {
  const mine = { ...table, note: 'CARRIED BY THE STUDY, NOT ATTACHED' }
  const project = await freezeStudy(await study({ edit: spec => { spec.pricing = mine } }))
  assert.equal(project.spec.pricing.note, 'CARRIED BY THE STUDY, NOT ATTACHED')
  await verifyProject(project)
})

test('a study that declares its own estimate is left unpriced by the table', async () => {
  const project = await freezeStudy(await study({ edit: spec => {
    spec.inputs = [...spec.inputs, { path: 'prices.json', sha256: 'a'.repeat(64) }]
    spec.observationPlan = { ...observationPlanFromSpec(), costEstimate: { kind: 'per-started-attempt', amount: '1', currency: 'USD', rationale: 'declared', sourcePaths: ['prices.json'] } }
  } }))
  assert.equal(project.spec.pricing, undefined)
  await verifyProject(project)
})

test('only a freeze attaches: rebuilding and reviewing never do', async () => {
  const spec = await study()
  const review = await prepareStudyReview(spec)
  assert.equal(review.spec.pricing, undefined, 'preparing a review is not a freeze and must not attach a table')
  // The rebuild verifyProject performs is the same non-attaching path, so a project
  // frozen before this field existed keeps verifying rather than gaining one.
  const project = await freezeStudy(spec)
  await verifyProject(project)
  assert.equal((await freezeStudy(project.spec)).sha256, project.sha256, 're-freezing a frozen spec is a fixed point')
})

// ---- What the report prints ----
// The frozen table has to be visible to a reader: named in the front matter, stated as
// an estimate wherever amounts appear, rolled up per condition and per billing model,
// and cited to the page each rate was read from.
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const reportFor = async spec => {
  const project = await freezeStudy(spec)
  const files = await researchReportFiles(project, (await runStudy(project)).events)
  return { project, files, md: unescapeMarkdown(files['report.md']) }
}

test('the front matter names the frozen price table, its date, its size and its identity', async () => {
  const { md } = await reportFor(await study())
  assert.match(md, /\|\s*Price table\s*\|\s*frozen 2026-09-11, 10 models, identity sha256:[a-f0-9]{64}\s*\|/)
})

test('every estimated amount is stated as an estimate at list prices on the frozen date', async () => {
  const { md } = await reportFor(await study())
  assert.ok(md.includes('Estimated at list API prices as of 2026-09-11.'), 'the statement names the date the rates were frozen')
  assert.ok(md.includes('Estimated API cost at list prices'), 'the cost block has its own heading')
  assert.ok(md.includes('not a charge any provider reported'), 'an estimate is never presented as a reported charge')
})

test('an attempt the table cannot price prints its reason, never a zero', async () => {
  const { md } = await reportFor(await study())
  // The generic starter replays recorded responses that carry no usage, so nothing is
  // estimable. That is the case that must never render as a total of zero.
  assert.match(md, /unavailable: [a-z-]+/)
  // "0 / 2" is a count of estimable attempts, not money. What must never appear is a
  // zero in the subtotal or total column; both read as not declared instead.
  assert.match(md, /\| 0 \/ \d+ \| Not declared \| Not declared \|/, 'an unpriced roll-up leaves both money columns not declared, never zero')
})

test('the roll-up is grouped per condition and per billing model', async () => {
  const { md } = await reportFor(await study())
  assert.ok(md.includes('Estimated attempts'), 'the roll-up states how many attempts were estimable')
  assert.ok(md.includes('Billing model'), 'a per-billing-model roll-up is present')
  assert.ok(md.includes('two conditions on one model combine here'), 'the per-model table says what it groups')
})

test('the references cite the page each rate was read from, with its date and quoted line', async () => {
  const { md } = await reportFor(await study())
  assert.ok(md.includes('Price table sources'), 'the references carry a price table section')
  assert.ok(md.includes('https://platform.claude.com/docs/en/about-claude/pricing'), 'the official page is printed')
  assert.ok(md.includes('Claude Sonnet 5'), 'each priced billing model is listed')
  assert.match(md, /2026-09-11/, 'the retrieval date is printed')
})

test('a study with no frozen table says so rather than inventing one', async () => {
  const { md } = await reportFor(await study({ edit: spec => {
    spec.inputs = [...spec.inputs, { path: 'prices.json', sha256: 'a'.repeat(64) }]
    spec.observationPlan = { ...observationPlanFromSpec(), costEstimate: { kind: 'per-started-attempt', amount: '1', currency: 'USD', rationale: 'declared', sourcePaths: ['prices.json'] } }
  } }))
  assert.ok(!md.includes('Estimated at list API prices'), 'no list-price statement without a frozen table')
  assert.ok(!md.includes('Price table sources'), 'no price citations without a frozen table')
})
