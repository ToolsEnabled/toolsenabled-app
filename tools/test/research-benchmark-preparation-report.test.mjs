import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { analyze, bindRuntimeSources, freezeStudy, gradeResponse, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { assertSelectedInputQualification, qualifyRequirements, qualificationPreparationLedger } from '../../src/benchmark/requirements.mjs'
import { validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const at = '2026-09-09T01:00:00.000Z'

async function fixture() {
  const { spec } = await genericActivationFixture()
  // These report fixtures use the supported direct API proof contract. The two
  // tiny interpreters execute in process; no external process receipt is claimed.
  delete spec.requirementPlan.interpreters; spec.inputs = []
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  const interpret = async task => ({ observation: String(task.compiled.semantic.a + task.compiled.semantic.b + task.input.offset), activation: { counters: { evaluated: 1 }, transitions: {} } })
  const independent = async task => {
    let total = 0
    for (const term of [task.compiled.semantic.a, task.compiled.semantic.b, task.input.offset]) for (let i = 0; i < Math.abs(term); i++) total += Math.sign(term)
    return { observation: String(total), activation: { counters: { evaluated: 1 }, transitions: {} } }
  }
  const record = { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256,
    runtimeSources: project.spec.runtimeSources, requirements: await qualifyRequirements(project.requirements, { interpret, independent }) }
  assertSelectedInputQualification(project, record)
  return { project, record }
}

function journal(project, record) {
  const events = []
  const add = event => { const row = { ...event, seq: events.length + 1, projectSha256: project.sha256, at }; events.push(row); return row }
  const start = () => add({ type: 'qualification-started', timeoutMs: 1000, settlementMs: 5000, reservedMs: 6000 })
  const qualify = (intent, elapsedMs = 0) => add({ type: 'qualification', preparationSeq: intent.seq, elapsedMs, budgetChargeMs: elapsedMs, record })
  const fail = (intent, status, elapsedMs, reason = 'Synthetic preparation stop') => add({ type: 'qualification-failed', preparationSeq: intent.seq, status, elapsedMs,
    budgetChargeMs: status === 'interrupted' ? intent.reservedMs : elapsedMs, reason })
  const complete = () => {
    const trial = project.schedule[0], task = project.tasks.find(row => row.id === trial.taskId), binding = { trialId: trial.id, attempt: 1 }
    add({ type: 'started', ...binding, readinessSha256: project.readiness.sha256, executionPurpose: project.spec.executionPlan.purpose, promptSha256: task.compiled.promptSha256 })
    add({ type: 'finished', ...binding, status: 'completed', elapsedMs: 7, response: { output: task.expected }, grade: gradeResponse(project, task, task.expected) })
  }
  return { events, add, start, qualify, fail, complete }
}

test('timed qualification preserves grades and trial latency without inventing provider accounting', async () => {
  const { project, record } = await fixture(), modern = journal(project, record), legacy = journal(project, record)
  const duration = 236.7491779999997
  modern.qualify(modern.start(), duration); modern.complete()
  legacy.add({ type: 'qualification', record }); legacy.complete()
  const modernFiles = await researchReportFiles(project, modern.events), legacyFiles = await researchReportFiles(project, legacy.events)
  const current = JSON.parse(modernFiles['summary.json']), prior = JSON.parse(legacyFiles['summary.json'])
  assert.deepEqual(current.selectedInputPreparation, qualificationPreparationLedger(project, modern.events))
  assert.equal(current.selectedInputPreparation.elapsedMs, duration); assert.equal(current.selectedInputPreparation.budgetChargeMs, duration)
  for (const key of ['rows', 'groups', 'contrasts', 'primaryPopulation', 'attempts', 'completed']) assert.deepEqual(current[key], prior[key], key)
  assert.equal(current.rows[0].latencyMs, 7); assert.equal(current.observations, undefined)
  assert.equal(modernFiles['results.csv'], legacyFiles['results.csv'])
  assert.deepEqual(await researchReportFiles(project, JSON.parse(canonical(modern.events))), modernFiles)
  const accepted = modern.events.find(row => row.type === 'qualification')
  assert.ok(modernFiles['qualification-receipts/' + accepted.seq + '/record.json'])
  assert.ok(modernFiles['tables/selected-input-preparation.csv'].includes(`"${duration}","Measured","${duration}","measured","Settled"`))
  assert.match(modernFiles['report.html'], /known subtotal 236\.749 ms/)
  assert.doesNotMatch(modernFiles['report.html'], /236\.7491779999997/)
  assert.ok(modernFiles['report.md'].includes('236\\.749 | Measured | 236\\.749'))
  assert.match(modernFiles['report.html'], /selected input preparation table"\] table\{min-width:92rem\}/)
  assert.match(modernFiles['report.md'], /total study wall-clock time/)
  assert.equal(prior.selectedInputPreparation.missingElapsed, 1); assert.equal(prior.selectedInputPreparation.missingCharge, 1)
  assert.equal(prior.selectedInputPreparation.elapsedMs, null); assert.equal(prior.selectedInputPreparation.budgetChargeMs, null)
  assert.match(legacyFiles['tables/selected-input-preparation.csv'], /"Unavailable","Legacy unavailable","Unavailable","unavailable"/)
  assert.match(legacyFiles['report.html'], /known subtotal Unavailable/)
  assert.doesNotMatch(legacyFiles['report.html'], /known subtotal 0 ms/)
})

test('failed and open preparation keeps partial elapsed coverage separate from reserved charges before any trial', async () => {
  const { project, record } = await fixture(), retained = journal(project, record)
  retained.fail(retained.start(), 'cancelled', 12, '<script>Synthetic cancellation</script>')
  const open = retained.start(), partial = await researchReportFiles(project, retained.events)
  let summary = JSON.parse(partial['summary.json']), preparation = summary.selectedInputPreparation
  assert.equal(summary.attempts, 0); assert.equal(summary.completed, 0); assert.equal(summary.pending, project.schedule.length)
  assert.equal(preparation.preparations, 2); assert.equal(preparation.qualified, 0); assert.equal(preparation.open, 1)
  assert.equal(preparation.knownElapsedMs, 12); assert.equal(preparation.elapsedMs, null); assert.equal(preparation.missingElapsed, 1)
  assert.equal(preparation.budgetChargeMs, 6012); assert.equal(preparation.missingCharge, 0)
  assert.match(partial['report.html'], /12 ms \(partial\)/)
  assert.match(partial['report.html'], /&lt;script&gt;Synthetic cancellation&lt;\/script&gt;/)
  assert.doesNotMatch(partial['report.html'], /<script>/)
  assert.match(partial['tables/selected-input-preparation.csv'], /"open","Unavailable","Unavailable","6000","reserved","Not established"/)
  retained.fail(open, 'interrupted', null)
  const recovered = await researchReportFiles(project, retained.events)
  summary = JSON.parse(recovered['summary.json']); preparation = summary.selectedInputPreparation
  assert.equal(preparation.open, 0); assert.equal(preparation.interrupted, 1)
  assert.equal(preparation.elapsedMs, null); assert.equal(preparation.budgetChargeMs, 6012)
  assert.equal(summary.rows[0].latencyMs, null)
  const invalid = structuredClone(retained.events)
  invalid.find(row => row.type === 'qualification-failed').elapsedMs = -1
  await assert.rejects(researchReportFiles(project, invalid), /elapsed|duration|charge/i)
})

test('empty preparation and a measured zero remain distinct, and legacy timing cannot be invented on resume', async () => {
  const { project, record } = await fixture(), current = journal(project, record)
  const empty = await researchReportFiles(project, [])
  assert.match(empty['report.html'], /No selected-input preparation is recorded/)
  assert.doesNotMatch(empty['report.html'], /known subtotal 0 ms/)
  current.qualify(current.start(), 0)
  const zero = await researchReportFiles(project, current.events), summary = JSON.parse(zero['summary.json'])
  assert.equal(summary.attempts, 0); assert.equal(summary.selectedInputPreparation.missingElapsed, 0)
  assert.equal(summary.selectedInputPreparation.elapsedMs, 0)
  assert.match(zero['tables/selected-input-preparation.csv'], /"0","Measured","0","measured"/)
  assert.match(zero['report.html'], /known subtotal 0 ms/)
  const tiny = journal(project, record); tiny.qualify(tiny.start(), 0.00004)
  const tinyFiles = await researchReportFiles(project, tiny.events)
  assert.match(tinyFiles['report.html'], /known subtotal &lt;0\.001 ms/)
  assert.doesNotMatch(tinyFiles['report.html'], /known subtotal 0 ms/)
  assert.match(tinyFiles['tables/selected-input-preparation.csv'], /"0\.00004","Measured","0\.00004"/)
  assert.equal(JSON.parse(tinyFiles['summary.json']).selectedInputPreparation.elapsedMs, 0.00004)
  const legacy = journal(project, record); legacy.add({ type: 'qualification', record }); legacy.start()
  await assert.rejects(researchReportFiles(project, legacy.events), /legacy|unavailable preparation charges/i)
  const modified = structuredClone(current.events); modified.find(row => row.type === 'qualification').budgetChargeMs = 1
  assert.throws(() => validateJournal(project, modified), /elapsed|charge/i)
})

test('mounted Research import displays legacy availability, real zero and reserved open preparation from the shared summary', async t => {
  const installed = installDomStandIn(globalThis), cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  let view
  t.after(() => { view?.destroy(); view?.el.remove(); installed.restore(); if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto })
  const { project, record } = await fixture(), downloads = []
  const account = { async getSetting() { return { ok: true, value: null } }, async putSetting() { return { ok: true } } }
  view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) })
  document.body.append(view.el)
  const field = name => view.el.querySelector(`[data-bench-${name}]`)
  const idle = async () => { for (let i = 0; i < 200; i++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('Preparation evidence view did not settle') }
  const click = async name => { assert.equal(field(name).disabled, false); field(name).click(); await idle() }
  const imported = async (name, value) => { const text = JSON.stringify(value); field(name).files = [{ size: text.length, text: async () => text }]; field(name).dispatch('change'); await idle() }
  await view.setContext('rp-' + 'a'.repeat(36), 'live'); await idle()
  await imported('import', { spec: project.spec }); await click('freeze')
  const legacy = journal(project, record); legacy.add({ type: 'qualification', record }); legacy.complete()
  await imported('import-evidence', { projectSha256: project.sha256, events: legacy.events })
  assert.match(field('status').textContent, /Evidence imported/)
  assert.match(field('preparation-results').textContent, /duration available for 0 of 1; known subtotal Unavailable/)
  assert.match(field('preparation-results').textContent, /Legacy receipts lack paired timing/)
  assert.doesNotMatch(field('preparation-results').textContent, /known subtotal 0 ms/)
  await click('export-evidence')
  assert.deepEqual(JSON.parse(downloads.at(-1).contents).summary, analyze(project, legacy.events))
  const fresh = journal(project, record); fresh.qualify(fresh.start(), 0)
  await imported('import-evidence', { projectSha256: project.sha256, events: fresh.events })
  assert.match(field('preparation-results').textContent, /duration available for 1 of 1; known subtotal 0 ms/)
  assert.match(field('results').textContent, /0 of 1 trials completed/)
  for (const [duration, displayed] of [[236.7491779999997, '236.749'], [45.10000000000001, '45.1'], [0.00004, '<0.001']]) {
    const fractional = journal(project, record); fractional.qualify(fractional.start(), duration)
    await imported('import-evidence', { projectSha256: project.sha256, events: fractional.events })
    // This structural DOM stand-in retains HTML entities in textContent.
    const encoded = displayed.replace('<', '&lt;')
    assert.ok(field('preparation-results').textContent.includes('known subtotal ' + encoded + ' ms'))
    assert.equal(field('preparation-results').querySelectorAll('tbody td')[2].textContent, encoded)
    await click('export-evidence')
    assert.equal(JSON.parse(downloads.at(-1).contents).summary.selectedInputPreparation.elapsedMs, duration)
  }
  const open = journal(project, record); open.start()
  await imported('import-evidence', { projectSha256: project.sha256, events: open.events })
  assert.match(field('preparation-results').textContent, /Budget charges available for 1 of 1; known subtotal 6000 ms/)
  assert.match(field('preparation-results').textContent, /reserved charge/)
  assert.match(field('preparation-results').textContent, /Not established/)
})
