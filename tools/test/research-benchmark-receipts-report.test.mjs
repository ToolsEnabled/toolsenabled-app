// The two receipts that travel beside a run's journal: the pre-collection
// qualification receipt (`node cli.mjs qualify`, results/qualification.json)
// and the native verification receipt (`node cli.mjs verify-native`,
// results/native-verification.json). The report renders each only when it
// binds to the frozen project and the attempt journal being rendered, prints it
// under the SHA-256 of its canonical bytes, retains it under paper/, and says
// Not declared when none was supplied. A receipt that does not bind is refused,
// never rendered.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle, canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { verifyNativeJournalEvidence } from '../../src/benchmark/audit.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const REVIEWER = 'RECEIPT REPORT FIXTURE MARKER ONLY', AT = '2026-09-10T00:00:00.000Z'
// report.md escapes markdown punctuation and report.html escapes markup, so a
// search for a sentence must undo that escaping rather than pin its spelling.
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[match]))
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]
const retained = receipt => JSON.stringify(JSON.parse(canonical(receipt)), null, 2) + '\n'
// A table row, whichever way the two renderers draw it: pipes in Markdown, cells in HTML.
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasRow = (text, cells) => new RegExp('\\| ' + cells.map(escapeRegExp).join(' \\| ') + ' \\|').test(text) || new RegExp('<t[dh][^>]*>' + cells.map(escapeRegExp).join('</t[dh]><t[dh][^>]*>') + '</t[dh]>').test(text)
// The binding check is imported lazily so that, on a tree without it, the
// rendering assertions below still fail on their own terms.
const boundReceipts = async (...args) => (await import('../../src/benchmark/report.mjs')).boundReceipts(...args)

// A recorded replay run of the Lean Bench starter: the journal a qualification
// receipt is rendered beside.
async function recordedRun() {
  let spec = newExperimentDraft(leanStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, AT, { catalog: spec.catalog })))
  const project = await freezeStudy(spec)
  return { project, events: (await runStudy(project)).events }
}

// A qualification receipt in the shape `node cli.mjs qualify` writes, bound to
// the given project. Its three checks are recorded data, not executions: one
// whose interpreters agree, one whose recorded Python result differs from the
// JavaScript one, and one the qualifier could not judge.
function qualificationReceipt(project) {
  const trace = [{ bar: 0, path: 'root/strategy', symbol: 'SPY', quantity: 2, priceCents: 10000, reason: 'buy' }]
  const process = { exitCode: 0, signal: null, stdout: '', stderr: '' }
  return { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources,
    environment: { node: 'v22.0.0', platform: 'linux', architecture: 'x64', python: 'python3' },
    checks: [
      { fixtureId: 'flat-canary', passed: true, kind: 'apparatus-control', javascript: { trace, cashCents: 1001400, lots: {}, coverage: ['root/strategy:buy'] },
        python: { result: { cashCents: 1001400, coverage: ['root/strategy:buy'], lots: {}, trace }, process } },
      { taskId: 'flat-canary', variantId: 'shifted', passed: true, kind: 'independent-interpretation', expected: trace, javascript: { trace },
        python: { result: { trace: [] }, process } },
      { fixtureId: 'custom-rule', passed: null, kind: 'custom-grader', reason: 'Supply independent fixtures for this custom grading rule.' },
    ],
    scope: 'RECEIPT FIXTURE SCOPE SENTENCE; no model or engine ran.' }
}

// A lean-python run with one completed, synthetically retained native attempt,
// and the native verification receipt verify-native would write for exactly
// this journal. Nothing here executed a program or an engine.
async function nativeRun() {
  const code = '# SYNTHETIC RETAINED SOURCE; NEVER EXECUTED BY THIS TEST\n'
  let spec = newExperimentDraft(leanStarter(), { purpose: 'apparatus-development', initializePopulation: true })
  spec.id = 'receipt-native-fixture'; spec.name = 'Receipt fixture with a retained native attempt'
  const task = spec.tasks[0]
  task.root.slots.strategy.slots.buy_reason.params = { threshold: 1 }
  task.expected = await deriveTaskExpected(spec, task)
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'c'.repeat(64)
  spec.conditions = [{ id: 'saved-control', model: { provider: 'fixture', id: 'never-executed', settings: {} }, adapter: { kind: 'replay', responses: { [task.id]: code } } }]
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC FIXTURE RECORD; NO PERSONAL APPROVAL', { at: AT })))
  const project = await freezeStudy(spec), trial = project.schedule[0], id = trial.id + '-1'
  const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
  const grade = { passed: true, score: 1, classification: 'correct', trace: [], directory: 'artifacts/' + id, files: [id + '.json'],
    image: spec.environment.leanImage, candidateSha256: await sha256(code.trim()), execution }
  const common = { projectSha256: project.sha256, trialId: trial.id, attempt: 1 }
  const events = [{ ...common, seq: 1, type: 'started', at: AT, promptSha256: project.tasks[0].compiled.promptSha256, readinessSha256: project.readiness.sha256, executionPurpose: 'apparatus-development' },
    { ...common, seq: 2, type: 'finished', at: AT, elapsedMs: 1, status: 'completed', response: { output: code }, grade }]
  const prefix = 'native/' + id + '/', json = value => canonical(value) + '\n'
  const files = { ...Object.fromEntries(Object.entries(sources).map(([name, contents]) => ['runtime/' + name, contents])),
    [prefix + 'main.py']: code.trim() + '\n', [prefix + 'config.json']: json(leanConfig(id)), [prefix + 'execution.json']: json(execution),
    [prefix + 'result.json']: json({ state: { Status: 'Completed' }, orders: {} }) }
  return { project, events, receipt: await verifyNativeJournalEvidence({ project, events, files }) }
}

test('item 6: a bound qualification receipt is rendered under its SHA-256 with per-check interpreter agreement, retained at paper/qualification.json and listed in the manifest', async () => {
  const { project, events } = await recordedRun(), receipt = qualificationReceipt(project), digest = await sha256(canonical(receipt))
  const files = await researchReportFiles(project, events, { qualification: receipt })
  for (const text of both(files)) {
    assert.ok(text.includes('Pre-collection qualification receipt'), 'the item 6 subsection is present')
    assert.ok(text.includes('Receipt SHA-256 ' + digest), 'the receipt digest is printed')
    assert.ok(text.includes('pins the same ' + Object.keys(project.spec.runtimeSources).length + ' runtime file digests'), 'the runtime binding is stated as verified')
    assert.ok(text.includes('JavaScript and Python agree'), 'the agreeing check is recomputed from the receipt')
    assert.ok(text.includes('JavaScript and Python DISAGREE'), 'a recorded disagreement is shown, not smoothed over')
    assert.ok(text.includes('expected observation NOT matched'), 'the recorded Python result is compared with the declared expectation')
    assert.ok(text.includes('not applicable'), 'a check the qualifier could not judge is not called passed')
    assert.ok(text.includes('Supply independent fixtures for this custom grading rule.'), 'the recorded reason is shown')
    assert.ok(text.includes('Recorded environment: Node v22.0.0 on linux x64; Python command python3.'), 'the recorded environment is shown')
    assert.ok(text.includes('Receipt scope, verbatim: RECEIPT FIXTURE SCOPE SENTENCE; no model or engine ran.'), 'the receipt scope is quoted verbatim')
    assert.ok(!text.includes('No qualification receipt (results/qualification.json'), 'the absence sentence is not printed beside a receipt')
  }
  assert.equal(files['paper/qualification.json'], retained(receipt), 'the receipt is retained canonically under paper/')
  assert.ok(JSON.parse(files['execution-manifest.json']).files.includes('paper/qualification.json'), 'the manifest lists the retained receipt')
  const bound = await boundReceipts(project, events, { qualification: receipt })
  assert.equal(bound.qualificationSha256, digest, 'the binding check reports the digest the report prints')
  assert.equal(bound.nativeVerificationSha256, null)
})

test('item 6: without a qualification receipt the section says Not declared and names the command that writes one', async () => {
  const { project, events } = await recordedRun(), files = await researchReportFiles(project, events)
  for (const text of both(files)) {
    assert.ok(text.includes('Not declared. No qualification receipt (results/qualification.json, written by node cli.mjs qualify) was supplied with this journal'), 'absence is stated, not guessed')
    assert.ok(!text.includes('Receipt SHA-256'), 'no digest is invented')
  }
  assert.equal('paper/qualification.json' in files, false)
})

test('a qualification receipt for another project, another runtime or of another shape is refused, not rendered', async () => {
  const { project, events } = await recordedRun(), receipt = qualificationReceipt(project)
  await assert.rejects(researchReportFiles(project, events, { qualification: { ...receipt, projectSha256: '0'.repeat(64) } }), /different frozen project/)
  await assert.rejects(researchReportFiles(project, events, { qualification: { ...receipt, runtimeSources: { ...receipt.runtimeSources, 'cli.mjs': 'f'.repeat(64) } } }), /different runtime/)
  await assert.rejects(researchReportFiles(project, events, { qualification: { verified: true } }), /not a version 1 research-benchmark-qualification record/)
  await assert.rejects(researchReportFiles(project, events, { qualification: [] }), /not a version 1 research-benchmark-qualification record/)
})

test('item 10: a native verification receipt bound to this journal renders verified-versus-declared rows, per-attempt grade agreement and its SHA-256, retained at paper/native-verification.json', async () => {
  const { project, events, receipt } = await nativeRun(), digest = await sha256(canonical(receipt))
  assert.equal(receipt.journalSha256, await sha256(canonical(events)), 'the fixture receipt really hashes this journal')
  const files = await researchReportFiles(project, events, { nativeVerification: receipt })
  for (const text of both(files)) {
    assert.ok(text.includes('Native verification receipt'), 'the item 10 subsection is present')
    assert.ok(text.includes('Receipt SHA-256 ' + digest), 'the receipt digest is printed')
    assert.ok(hasRow(text, ['Receipt names this frozen project', 'Verified here', 'projectSha256 ' + project.sha256]), 'the project binding is a verified row')
    assert.ok(text.includes('journalSha256 ' + receipt.journalSha256), 'the journal digest the receipt carries is printed')
    assert.ok(text.includes('filesSha256 ' + receipt.filesSha256 + '; retained bytes were not re-read for this report'), 'the file digest is declared, not verified')
    assert.ok(text.includes('1 receipt attempt for 1 completed attempt in the journal'), 'coverage is counted against the journal')
    assert.ok(text.includes('reconstructed correct (passed true); journal correct (passed true)'), 'the reconstructed grade is compared with the journal grade')
    assert.ok(hasRow(text, ['Evidence status', 'Declared by the receipt', 'retained-artifact-consistency']), 'the evidence status is declared, not upgraded')
    assert.ok(hasRow(text, ['Receipt hashes exactly this attempt journal', 'Verified here', 'journalSha256 ' + receipt.journalSha256]), 'the journal binding is a verified row')
    for (const limitation of receipt.limitations) assert.ok(text.includes(limitation), 'each declared limitation is quoted verbatim')
    assert.ok(text.includes('Receipt scope, verbatim: ' + receipt.scope), 'the receipt scope is quoted verbatim')
  }
  assert.equal(files['paper/native-verification.json'], retained(receipt))
  assert.ok(JSON.parse(files['execution-manifest.json']).files.includes('paper/native-verification.json'))
  const bound = await boundReceipts(project, events, { nativeVerification: receipt })
  assert.equal(bound.nativeVerificationSha256, digest)
  // A receipt whose reconstructed grade no longer matches the journal is still
  // bound to this journal, and the report says the two disagree rather than
  // picking one.
  const contradicted = structuredClone(receipt); contradicted.attempts[0].reconstructedGrade.classification = 'trace-mismatch'
  const disagreeing = await researchReportFiles(project, events, { nativeVerification: contradicted })
  for (const text of both(disagreeing)) {
    assert.ok(text.includes('DISAGREES with the journal'), 'a contradiction between receipt and journal is named')
    assert.ok(text.includes('Receipt SHA-256 ' + await sha256(canonical(contradicted))), 'the contradicted receipt is printed under its own digest')
  }
})

test('item 10: a receipt hashed over a different journal or another project is refused; without one the section says Not declared', async () => {
  const { project, events, receipt } = await nativeRun()
  await assert.rejects(researchReportFiles(project, events, { nativeVerification: { ...receipt, journalSha256: '1'.repeat(64) } }), /different attempt journal/)
  await assert.rejects(researchReportFiles(project, events, { nativeVerification: { ...receipt, projectSha256: '2'.repeat(64) } }), /different frozen project/)
  await assert.rejects(researchReportFiles(project, events, { nativeVerification: { ...receipt, attempts: 'none' } }), /lists no attempts/)
  await assert.rejects(researchReportFiles(project, events, { nativeVerification: { verified: true } }), /not a version 1 benchmark-native-journal-verification record/)
  const files = await researchReportFiles(project, events)
  for (const text of both(files)) assert.ok(text.includes('Not declared. No native verification receipt (results/native-verification.json, written by node cli.mjs verify-native) was supplied with this journal'))
  assert.equal('paper/native-verification.json' in files, false)
})

test('the package with receipts is deterministic and stays additive over the package without them', async () => {
  const { project, events, receipt } = await nativeRun(), qualification = qualificationReceipt(project)
  const plain = await researchReportFiles(project, events)
  const once = await researchReportFiles(project, events, { qualification, nativeVerification: receipt })
  const twice = await researchReportFiles(project, events, { qualification, nativeVerification: receipt })
  assert.deepEqual(Object.keys(twice).sort(), Object.keys(once).sort())
  for (const name of Object.keys(once)) assert.equal(twice[name], once[name], name + ' is not reproducible')
  assert.deepEqual(Object.keys(once).filter(name => !(name in plain)).sort(), ['paper/native-verification.json', 'paper/qualification.json'])
  for (const name of Object.keys(plain)) if (!['report.md', 'report.html', 'execution-manifest.json'].includes(name)) assert.equal(once[name], plain[name], name + ' must not change when receipts are supplied')
  assert.deepEqual(JSON.parse(once['execution-manifest.json']).files, Object.keys(once).filter(name => name !== 'execution-manifest.json').sort())
})
