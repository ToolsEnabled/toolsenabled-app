import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, validateStudy } from '../../src/benchmark/study.mjs'
import { canonical } from '../../src/benchmark/prompts.mjs'
// PROMPT B: the operational roles are declared beside their own contract now.
import { OPERATIONAL_STRATEGY_ROLES as ROLES } from '../../src/benchmark/trading-ir.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { observationPlanFromSpec } from '../../src/benchmark/observations.mjs'
import { workflowDraft } from '../../src/benchmark/workflow.mjs'
import { auditFixture } from './fixtures/research-benchmark-audit.mjs'
import { workflowEnvelope, workflowFixture } from './fixtures/research-benchmark-workflow.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const views = [], A = 'rp-' + 'a'.repeat(36)
let installed, cryptoDescriptor, downloads
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const status = view => field(view, 'status').textContent
const specOf = view => JSON.parse(field(view, 'spec-json').value)
async function idle(view) {
  for (let count = 0; count < 800; count++) { if (view.el.getAttribute('aria-busy') === 'false') return; await pause() }
  assert.fail('Recorded reset builder did not settle: ' + status(view))
}
function fill(view, name, value) {
  const input = field(view, name); assert.ok(input, name); assert.equal(input.disabled, false)
  input.value = value; input.dispatch('input')
}
async function click(view, name) {
  const button = field(view, name); assert.ok(button, name); assert.equal(button.disabled, false, name + ': ' + status(view))
  button.click(); await idle(view)
}
async function mount() {
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } },
    async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live'); await idle(view); return view
}
async function apply(view, spec) {
  fill(view, 'spec-json', JSON.stringify(spec)); await click(view, 'apply-spec')
  assert.match(status(view), /Full specification applied/)
}
async function evidence(view) { await click(view, 'export-evidence'); return JSON.parse(downloads.at(-1).contents) }
async function retain(name, value) {
  const directory = process.env.RESEARCH_RECORDED_RESET_EVIDENCE_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
function noCurrentResult(view) {
  assert.equal(field(view, 'export-evidence').disabled, true)
  assert.equal(field(view, 'run').disabled, true)
  assert.doesNotMatch(field(view, 'frozen').textContent, /SHA-256/)
  assert.equal(field(view, 'results').textContent, '')
}
function noQualification(spec) {
  assert.equal(spec.requirementPlan, undefined)
  assert.equal(spec.reviews?.length || 0, 0); assert.equal(spec.taskReviews?.length || 0, 0)
}
function ordinaryEnvelopeSpec() {
  const spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.identity.policy = 'require-match'; spec.observationPlan.completion.policy = 'require-complete'
  spec.conditions[0].model.settings = { temperature: 0, topP: 1 }
  spec.conditions[0].adapter.mode = 'envelope'
  spec.conditions[0].adapter.responses = { 'addition-a': workflowEnvelope('5', 2, '0.01'), 'addition-b': workflowEnvelope('11', 4, '0.02') }
  return spec
}
function addSimpleWorkflow(spec) {
  const draft = workflowDraft(spec)
  spec.workflowPlan = draft.plan; spec.observationPlan = observationPlanFromSpec()
  for (const condition of spec.conditions) {
    condition.workflowId = 'prompt-flow'; condition.adapter.mode = 'envelope'
    condition.adapter.workflowResponses = Object.fromEntries(spec.tasks.map(task => [task.id, { answer: workflowEnvelope({ stale: task.id }) }]))
  }
  return spec
}

beforeEach(() => {
  installed = installDomStandIn(globalThis); cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); downloads = []
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause(); installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto
})

test('corpus regeneration keeps ordinary envelope interpretation and newly refilled metadata while refusing the preceding journal', async () => {
  const view = await mount(), original = ordinaryEnvelopeSpec(); await apply(view, original)
  await click(view, 'seed-corpus'); await click(view, 'generate-corpus')
  assert.match(status(view), /1 tasks generated from 1 candidates/)
  let generated = specOf(view), condition = generated.conditions[0]
  assert.equal(condition.adapter.mode, 'envelope')
  assert.equal(Object.hasOwn(condition.adapter, 'workflowResponses'), false)
  assert.deepEqual(condition.adapter.responses, {})
  assert.deepEqual(condition.model, original.conditions[0].model)
  assert.deepEqual(generated.observationPlan, original.observationPlan)
  noQualification(generated); noCurrentResult(view)
  const taskId = generated.tasks[0].id
  condition.adapter.responses = { [taskId]: workflowEnvelope('5', 7, '0.07') }
  fill(view, 'conditions', JSON.stringify(generated.conditions)); await click(view, 'apply-protocol')
  assert.match(status(view), /Protocol applied/)
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false)
  await click(view, 'run'); const prior = await evidence(view)
  assert.equal(prior.summary.completed, 1); assert.equal(prior.summary.groups[0].passed, 1)
  const priorFinish = prior.events.find(row => row.type === 'finished')
  assert.equal(priorFinish.response.output, '5')
  assert.equal(priorFinish.observations.reported.usage.outputTokens.value, 7)
  await retain('corpus-prior-journal', prior)

  // No intervening input event: the generator itself must clear this live
  // frozen result, even though the recipe and resulting task IDs are unchanged.
  await click(view, 'generate-corpus')
  assert.match(status(view), /1 tasks generated from 1 candidates/)
  generated = specOf(view); condition = generated.conditions[0]
  assert.equal(generated.tasks[0].id, taskId)
  assert.equal(condition.adapter.mode, 'envelope')
  assert.equal(Object.hasOwn(condition.adapter, 'workflowResponses'), false)
  assert.deepEqual(condition.adapter.responses, {}); noCurrentResult(view)
  assert.deepEqual(generated.observationPlan, original.observationPlan)
  assert.equal(generated.executionPlan.purpose, 'recorded-diagnostic'); noQualification(generated)
  condition.adapter.responses = { [taskId]: workflowEnvelope('5', 19, '0.19') }
  fill(view, 'conditions', JSON.stringify(generated.conditions)); await click(view, 'apply-protocol'); await click(view, 'freeze')
  assert.equal(field(view, 'run').disabled, false)
  const priorBytes = JSON.stringify(prior), input = field(view, 'import-evidence')
  input.files = [{ size: priorBytes.length, text: async () => priorBytes }]; input.dispatch('change'); await idle(view)
  // The refusal now names both projects and the path that does work. Still an exact
  // match, and stricter than before: it also checks the two identities are the right
  // way round.
  const heldSha = field(view, 'frozen').textContent.match(/SHA-256 ([a-f0-9]{64})/)[1]
  assert.equal(status(view), 'This evidence belongs to a different frozen project. It was produced for '
    + prior.projectSha256.slice(0, 16) + '\u2026, and this page holds ' + heldSha.slice(0, 16) + '\u2026.'
    + ' Open that project\u2019s exported ZIP with Open exported project: the <identifier>.zip that Export runnable ZIP downloaded.'
    + ' This page will then hold it and admit this evidence.'
    + ' Freezing the same draft here reproduces that project only while this page\u2019s runtime bytes are unchanged; otherwise run the exported'
    + ' project\u2019s cli.mjs and import the evidence it writes for the project this page holds.')
  assert.equal(field(view, 'export-evidence').disabled, true)
  await click(view, 'run'); const current = await evidence(view)
  assert.notEqual(current.projectSha256, prior.projectSha256)
  assert.equal(current.summary.completed, 1); assert.equal(current.summary.groups[0].passed, 1)
  assert.equal(current.events.filter(row => row.type === 'started').length, 1)
  assert.ok(current.events.every(row => row.projectSha256 === current.projectSha256 && !row.type.includes('qualification')))
  const finish = current.events.find(row => row.type === 'finished'), reported = finish.observations.reported
  assert.equal(finish.response.output, '5'); assert.equal(reported.identityStatus, 'match')
  assert.equal(reported.completion.status.value, 'complete')
  assert.equal(reported.usage.outputTokens.value, 19); assert.equal(reported.reportedCost.amount, '0.19')
  assert.equal(reported.reportedCost.currency, 'USD')
  assert.equal(current.summary.execution.purpose, 'recorded-diagnostic')
  await retain('corpus-refilled-journal', current); await retain('corpus-refilled-spec', specOf(view))
})

test('corpus generation preserves a frozen workflow and refuses empty stage fixtures instead of reusing prior responses', async () => {
  const view = await mount(), original = newExperimentDraft(workflowFixture(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  await apply(view, original); await click(view, 'seed-corpus'); await click(view, 'generate-corpus')
  assert.match(status(view), /1 tasks generated from 1 candidates/)
  const generated = specOf(view), condition = generated.conditions[0]
  assert.deepEqual(generated.workflowPlan, original.workflowPlan)
  assert.deepEqual(generated.observationPlan, original.observationPlan)
  assert.deepEqual(condition.collection, original.conditions[0].collection)
  assert.deepEqual(condition.model, original.conditions[0].model)
  assert.equal(condition.workflowId, 'revise'); assert.equal(condition.adapter.mode, 'envelope')
  assert.deepEqual(condition.adapter.responses, {}); assert.deepEqual(condition.adapter.workflowResponses, {})
  assert.equal(Object.hasOwn(condition.adapter, 'workflowResponses'), true)
  validateStudy(generated); noQualification(generated); noCurrentResult(view)
  await click(view, 'freeze'); assert.equal(field(view, 'run').disabled, false)
  await click(view, 'run'); const result = await evidence(view)
  assert.equal(result.summary.completed, 0); assert.equal(result.summary.failed, 1)
  assert.equal(result.events.filter(row => row.type === 'started').length, 1)
  assert.equal(result.events.filter(row => row.type === 'workflow-started').length, 1)
  assert.ok(result.events.every(row => row.type !== 'finished' || row.grade === undefined))
  assert.match(JSON.stringify(result.events), /No recorded workflow response for .*\/draft/)
  assert.doesNotMatch(JSON.stringify(result.events), /PRIVATE INTERMEDIATE NOTE|DO NOT TRANSFER THIS NOTE/)
  await retain('corpus-empty-workflow-spec', generated); await retain('corpus-empty-workflow-journal', result)
})

test('audit regeneration clears saved judge maps while preserving workflow, accounting and the sealed reference', async () => {
  const view = await mount(), audit = await auditFixture(sources), original = addSimpleWorkflow(audit.spec)
  await retain('audit-source-project', audit.source); await retain('audit-source-journal', audit.events)
  await apply(view, original); await click(view, 'freeze')
  assert.equal(field(view, 'export').disabled, false)
  const referenceBytes = canonical(specOf(view).auditPlan.reference)
  await click(view, 'generate-audit'); assert.match(status(view), /4 audit cases generated; 4 have reference labels/)
  const generated = specOf(view), condition = generated.conditions[0]
  assert.equal(condition.adapter.mode, 'envelope'); assert.equal(condition.workflowId, 'prompt-flow')
  assert.deepEqual(condition.adapter.responses, {}); assert.deepEqual(condition.adapter.workflowResponses, {})
  assert.deepEqual(condition.model, original.conditions[0].model)
  assert.deepEqual(generated.workflowPlan, original.workflowPlan)
  assert.deepEqual(generated.observationPlan, original.observationPlan)
  assert.equal(canonical(generated.auditPlan.reference), referenceBytes)
  assert.equal(generated.analysisPlan.primaryPopulation, 'reference-eligible')
  assert.equal(generated.executionPlan.purpose, 'apparatus-development')
  noQualification(generated); noCurrentResult(view); validateStudy(generated)
  await click(view, 'freeze'); assert.equal(field(view, 'export').disabled, false)
  assert.equal(field(view, 'export-evidence').disabled, true)
  await retain('audit-regenerated-spec', generated)
})

test('LEAN combination generation preserves workflow, explicit output and absent mode profiles without transferring qualification', async () => {
  const view = await mount(), original = addSimpleWorkflow(newExperimentDraft(leanStarter(), { initializePopulation: true }))
  const workflow = original.conditions[0]; workflow.id = 'workflow'; workflow.model.settings = { temperature: 0 }
  original.conditions.push({ ...structuredClone(workflow), id: 'explicit-output', adapter: { kind: 'replay', mode: 'output', responses: { stale: 'OLD OUTPUT' } } },
    { ...structuredClone(workflow), id: 'implicit-output', adapter: { kind: 'replay', responses: { stale: 'OLD OUTPUT' } } })
  delete original.conditions[1].workflowId; delete original.conditions[2].workflowId
  await apply(view, original)
  for (const role of ROLES) {
    const choices = [...view.el.querySelectorAll('[data-combination-role="' + role + '"]')]
    assert.ok(choices.length >= (role === 'buy_reason' ? 2 : 1))
    choices.forEach((choice, index) => { choice.checked = index === 0 || role === 'buy_reason' && index === 1 })
  }
  field(view, 'combination-wrapper').value = ''
  await click(view, 'generate'); assert.match(status(view), /2 task combinations generated with draft expected traces/)
  const generated = specOf(view)
  assert.equal(generated.tasks.length, 2)
  assert.deepEqual(generated.workflowPlan, original.workflowPlan); assert.deepEqual(generated.observationPlan, original.observationPlan)
  assert.deepEqual(generated.conditions.map(row => row.model), original.conditions.map(row => row.model))
  assert.deepEqual(generated.conditions.map(row => row.adapter.responses), [{}, {}, {}])
  assert.equal(generated.conditions[0].adapter.mode, 'envelope')
  assert.equal(generated.conditions[0].workflowId, 'prompt-flow')
  assert.deepEqual(generated.conditions[0].adapter.workflowResponses, {})
  assert.equal(generated.conditions[1].adapter.mode, 'output')
  assert.equal(Object.hasOwn(generated.conditions[2].adapter, 'mode'), false)
  assert.ok(generated.conditions.slice(1).every(row => !Object.hasOwn(row.adapter, 'workflowResponses') && !Object.hasOwn(row, 'workflowId')))
  assert.equal(generated.requireReview, true); assert.equal(generated.executionPlan.purpose, 'experiment')
  noQualification(generated); noCurrentResult(view); validateStudy(generated)
  await click(view, 'freeze'); assert.match(status(view), /needs review/)
  assert.equal(field(view, 'run').disabled, true); assert.equal(field(view, 'export-evidence').disabled, true)
  await retain('lean-combinations-regenerated-spec', generated)
})
