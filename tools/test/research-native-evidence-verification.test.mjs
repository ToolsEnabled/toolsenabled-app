import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { operationalCandidateFiles } from '../../src/benchmark/trading-study.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { compileTask, deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord, decodeInformationResponse, gradeInterpretations, informationDisposition } from '../../src/benchmark/information.mjs'
import { leanConfig, nativeObservation, pythonSource } from '../../src/benchmark/lean-observations.mjs'
import * as leanObservationModule from '../../src/benchmark/lean-observations.mjs'
import { NATIVE_EVIDENCE_LIMITS, nativeEvidencePaths, verifyNativeAttemptEvidence, verifyNativeJournalEvidence, auditFileBytes, sealAuditReference } from '../../src/benchmark/audit.mjs'
import { evaluateReadiness } from '../../src/benchmark/readiness.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { leanInformationFixture } from './fixtures/research-benchmark-information.mjs'

// All process/result records are hand-authored offline controls. These tests
// never execute a candidate, native host, provider, grader callback or process.
const code = '# SYNTHETIC SOURCE; NO NATIVE EXECUTION', at = '2026-09-09T00:00:00.000Z'
const reviewer = 'SYNTHETIC NATIVE EVIDENCE API CONTROL; NO PERSONAL APPROVAL'
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const binary = { encoding: 'base64', data: Buffer.from([0, 255, 123, 10]).toString('base64') }
const evidenceRoot = process.env.RESEARCH_NATIVE_VERIFIER_EVIDENCE
const copy = value => structuredClone(value)
const end = fixture => fixture.events.find(event => event.type === 'finished')
const prefix = fixture => 'native/' + fixture.project.schedule[0].id + '-1/'
async function retain(name, value) {
  if (!evidenceRoot) return
  const path = resolve(evidenceRoot, name); await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}
async function makeFixture({ operational = true, information = true, tagged = false, output = code, additionalInputs = {}, legacy = false, container = false } = {}) {
  let spec = operational ? await operationalStarter() : leanInformationFixture(), task = spec.tasks[0]
  if (operational) {
    const stack = [task.root]
    while (stack.length) {
      const node = stack.pop()
      if (node.use === 'op-above') node.params = { ...(node.params || {}), threshold: 99999999 }
      stack.push(...Object.values(node.slots || {}))
    }
    task.expected = await deriveTaskExpected(spec, task); task.familyId = 'quiet-reading-family'
    task.information = { version: 1, scope: 'declared-set', responseMode: 'raw',
      rationale: 'Synthetic quiet observation, not an activation or native execution claim.', withheldPaths: ['root/child1/buy_process'],
      readings: [2, 3].map(quantity => {
        const root = copy(task.root); root.slots.child1.slots.buy_process.params = { ...(root.slots.child1.slots.buy_process.params || {}), quantity }
        return { id: 'quantity-' + quantity, rationale: 'Synthetic inactive quantity ' + quantity + '.', root }
      }) }
  } else {
    task.input.bars.forEach(bar => { bar.prices.SPY = 11000 }); task.expected = []
  }
  if (!information) delete task.information
  else task.information.responseMode = tagged ? 'tagged-json' : 'raw'
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.protocol.replicates = 1; spec.protocol.maxAttemptsPerTrial = 1; spec.protocol.maxTotalAttempts = 1
  spec.environment.leanImage = 'synthetic-unavailable-image@sha256:' + 'a'.repeat(64)
  spec.conditions = [{ id: 'saved-control', adapter: { kind: 'replay', responses: { [task.id]: output } } }]
  const inputs = { 'fixtures/private-input.bin': binary, ...additionalInputs }
  spec.inputs = await Promise.all(Object.entries(inputs).map(async ([path, value]) => ({ path, sha256: await sha256(auditFileBytes(value)) })))
  spec = await bindLeanReview(await bindRuntimeSources(legacy ? spec : developmentDraft(spec), sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, reviewer, { at })))
  if (information) {
    const compiled = await compileTask(spec, spec.tasks[0], { requireTaskReview: false })
    spec.taskReviews = [await createTaskReviewRecord(compiled, reviewer, at)]
  }
  const project = await freezeStudy(spec), frozenTask = project.tasks[0], trial = project.schedule[0], id = trial.id + '-1'
  const files = Object.fromEntries(Object.entries(sources).map(([path, value]) => ['runtime/' + path, value]))
  for (const [path, value] of Object.entries(inputs)) files['inputs/' + path] = copy(value)
  const decoded = information ? decodeInformationResponse(frozenTask, output) : { behavior: 'answer', answer: output }
  let grade, extracted, raw
  if (decoded.behavior !== 'answer') grade = informationDisposition(decoded)
  else {
    try { extracted = pythonSource(decoded.answer) } catch (error) { grade = { passed: false, score: 0, classification: 'no-program', reason: error.message } }
    if (extracted !== undefined) {
      raw = operational ? { state: { Status: 'Completed' }, orders: {}, algorithmConfiguration: { accountCurrency: 'USD' },
        totalPerformance: { portfolioStatistics: { startEquity: '1500', endEquity: '1500' } } } : { state: { Status: 'Completed' }, orders: {} }
      const trace = nativeObservation(raw, null, frozenTask)
      assert.deepEqual(trace, frozenTask.expected)
      const execution = { exitCode: 0, signal: null, stdout: 'SYNTHETIC PROCESS RECORD; NO NATIVE RUN', stderr: '' }
      grade = { ...(information ? gradeInterpretations(frozenTask, trace, 'json') : { passed: true, score: 1, classification: 'correct' }), trace,
        directory: 'artifacts/' + id, files: [id + '.json'], image: spec.environment.leanImage, candidateSha256: await sha256(extracted), execution,
        ...(container ? { container: leanObservationModule.leanContainerRecord({ projectSha256: project.sha256, image: spec.environment.leanImage }) } : {}) }
      const programs = operational ? operationalCandidateFiles(frozenTask, extracted, sources) : { 'main.py': extracted + '\n' }
      for (const [path, value] of Object.entries({ ...programs, 'config.json': canonical(leanConfig(id)), 'execution.json': canonical(execution), 'result.json': canonical(raw) })) files['native/' + id + '/' + path] = value
    }
  }
  const events = [{ type: 'started', projectSha256: project.sha256, seq: 1, trialId: trial.id, attempt: 1, at, promptSha256: frozenTask.compiled.promptSha256,
    ...(project.version === 2 ? { readinessSha256: project.readiness.sha256, executionPurpose: project.spec.executionPlan.purpose } : {}) },
  { type: 'finished', projectSha256: project.sha256, seq: 2, trialId: trial.id, attempt: 1, status: 'completed', elapsedMs: 1,
    response: { output, usage: null }, grade }]
  return { project, events, files, raw }
}
let operation, synchronous
const operationalFixture = () => operation ||= makeFixture()
const synchronousFixture = () => synchronous ||= makeFixture({ operational: false })
const verify = fixture => verifyNativeJournalEvidence({ project: fixture.project, events: fixture.events, files: fixture.files })
function assertScope(receipt) {
  assert.equal(receipt.evidenceStatus, 'retained-artifact-consistency')
  assert.match(receipt.scope, /native execution, preparation and experimental admission are not established/)
  assert.ok(receipt.limitations.length > 0)
  for (const key of ['admitted', 'qualified', 'nativeExecuted', 'verified']) assert.equal(Object.hasOwn(receipt, key), false)
}
async function rejectBoth(fixture, expression) {
  await assert.rejects(verify(fixture), expression)
  await assert.rejects(verifyNativeAttemptEvidence({ project: fixture.project, attempt: end(fixture), files: fixture.files }), expression)
}

test('strict attempt and journal APIs reconstruct hand-authored synchronous and operational evidence with explicit limits', async () => {
  for (const [name, fixture] of [['operational', await operationalFixture()], ['synchronous', await synchronousFixture()]]) {
    const batch = await verify(fixture), attempt = await verifyNativeAttemptEvidence({ project: fixture.project, attempt: end(fixture), files: fixture.files })
    assert.equal(batch.format, 'benchmark-native-journal-verification'); assert.equal(attempt.format, 'benchmark-native-attempt-verification')
    assertScope(batch); assertScope(attempt); assert.equal(batch.attempts.length, 1); assert.deepEqual(batch.attempts[0], attempt)
    assert.equal(attempt.disposition, 'observed'); assert.deepEqual(attempt.observation, end(fixture).grade.trace)
    assert.equal(attempt.reconstructedGrade.passed, true); assert.equal(attempt.reconstructedGrade.score, 1)
    assert.deepEqual(attempt.reconstructedGrade.matchingReadings, end(fixture).grade.matchingReadings)
    assert.equal(attempt.projectSha256, fixture.project.sha256)
    assert.equal(attempt.candidateSha256, await sha256(code)); assert.match(attempt.evidenceSha256, /^[a-f0-9]{64}$/)
    assert.equal(attempt.sourceFileHashes['inputs/fixtures/private-input.bin'], await sha256(auditFileBytes(binary)))
    assert.equal(batch.journalSha256, await sha256(canonical(fixture.events)))
    await retain(name + '/bundle.json', { format: 'benchmark-native-evidence', version: 1, ...fixture, raw: undefined })
    await retain(name + '/verification.json', batch)
  }
})

test('deterministic plans require complete source/input/candidate environments independently of forged grade metadata', async () => {
  const fixture = await operationalFixture(), expected = nativeEvidencePaths(fixture.project, [end(fixture)])
  assert.equal(expected.version, 1); assert.equal(expected.projectSha256, fixture.project.sha256)
  assert.deepEqual(expected.limits, NATIVE_EVIDENCE_LIMITS)
  assert.equal(expected.files.filter(file => file.key.startsWith('runtime/')).length, RUNTIME_FILES.length)
  const p = prefix(fixture)
  for (const name of ['main.py', 'candidate.py', 'trading_broker.py', 'config.json', 'execution.json']) assert.equal(expected.files.find(file => file.key === p + name).required, true)
  for (const name of ['result.json', 'order-events.json']) assert.equal(expected.files.find(file => file.key === p + name).required, false)
  for (const alter of [grade => { delete grade.directory; delete grade.files; delete grade.trace }, grade => { grade.directory = '../../other'; grade.files = []; grade.classification = 'execution-error' }]) {
    const attempt = copy(end(fixture)); alter(attempt.grade)
    assert.deepEqual(nativeEvidencePaths(fixture.project, [attempt]), expected)
  }
  assert.throws(() => nativeEvidencePaths(fixture.project, [end(fixture), end(fixture)]), /duplicate|distinct|once/i)
  assert.throws(() => nativeEvidencePaths(fixture.project, [{ ...end(fixture), trialId: 'unknown-trial' }]), /trial|schedule/i)
  await retain('roster.json', expected)
})

test('source and pinned binary inputs cannot be replaced even after resealing an outer audit hash', async () => {
  const fixture = await operationalFixture(), rejected = []
  for (const path of ['runtime/runner.mjs', 'runtime/trading_broker.py', 'inputs/fixtures/private-input.bin']) {
    const changed = copy(fixture)
    changed.files[path] = path.startsWith('inputs/') ? { encoding: 'base64', data: Buffer.from('different bytes').toString('base64') } : changed.files[path] + '\n# changed pinned source\n'
    const outer = { format: 'benchmark-audit-reference', version: 1, project: changed.project, events: changed.events, files: changed.files }
    const resealed = { ...outer, sha256: await sha256(canonical(outer)) }
    await rejectBoth(changed, /source|runtime|input|pin|hash/i); rejected.push({ path, resealedSha256: resealed.sha256 })
  }
  const counterfeit = copy(fixture)
  // Serialized project records have independent compiled/source objects. Do
  // not let structuredClone's retained aliases mutate the authored oracle too.
  counterfeit.project = JSON.parse(canonical(fixture.project))
  counterfeit.project.tasks[0].expected.cashFromFillsCents++
  assert.deepEqual(counterfeit.project.spec, fixture.project.spec)
  const { sha256: ignored, ...payload } = counterfeit.project
  counterfeit.project.sha256 = await sha256(canonical(payload))
  for (const event of counterfeit.events) event.projectSha256 = counterfeit.project.sha256
  await rejectBoth(counterfeit, /frozen project changed|rebuild/i)
  await retain('negative/source-input.json', rejected)
})

test('candidate code, public harness, attempt config and declared image must agree with the frozen retained response', async () => {
  const fixture = await operationalFixture(), rejected = []
  for (const name of ['candidate.py', 'main.py', 'trading_broker.py']) {
    const changed = copy(fixture); changed.files[prefix(changed) + name] += '\n# substituted program bytes\n'
    await rejectBoth(changed, /candidate|program|harness|source/i); rejected.push(name)
  }
  const response = copy(fixture); end(response).response.output += '\n# changed answer'; end(response).grade.candidateSha256 = await sha256(end(response).response.output)
  await rejectBoth(response, /candidate|program|harness|source/i)
  const config = copy(fixture); config.files[prefix(config) + 'config.json'] = canonical(leanConfig('another-trial-1'))
  await rejectBoth(config, /config|attempt/i)
  const image = copy(fixture); end(image).grade.image = 'other-image@sha256:' + 'b'.repeat(64)
  await rejectBoth(image, /image/i)
  const directory = copy(fixture); end(directory).grade.directory = 'artifacts/other-trial-1'
  await rejectBoth(directory, /directory|attempt/i)
  await retain('negative/candidate-bindings.json', { rejected, response, config, image, directory })
})

test('matching process metadata cannot turn nonzero exits, signals or unknown termination into an observed success', async () => {
  const fixture = await operationalFixture(), rejected = []
  for (const [name, values] of [['nonzero', { exitCode: 1 }], ['infrastructure', { exitCode: 125 }], ['signal', { signal: 'SIGKILL' }],
    ['unknown-exit', { exitCode: null }], ['fractional-exit', { exitCode: 0.5 }], ['nonstring-output', { stdout: {} }]]) {
    const changed = copy(fixture); Object.assign(end(changed).grade.execution, values)
    changed.files[prefix(changed) + 'execution.json'] = canonical(end(changed).grade.execution)
    await rejectBoth(changed, /execution|process|exit|signal|unsupported|completion/i); rejected.push({ name, events: changed.events })
  }
  const drift = copy(fixture); drift.files[prefix(drift) + 'execution.json'] = canonical({ ...end(drift).grade.execution, stdout: 'different retained process bytes' })
  await rejectBoth(drift, /execution|process/i)
  await retain('negative/process.json', rejected)
})

test('observed raw results and event presence control the proof branch, not a trace or files list chosen by the grade', async () => {
  const fixture = await operationalFixture()
  for (const change of [value => { delete value.files[prefix(value) + 'result.json'] }, value => { end(value).grade.files = [] },
    value => { delete end(value).grade.trace }, value => { end(value).grade.classification = 'execution-error'; end(value).grade.passed = false; end(value).grade.score = 0; end(value).grade.matchingReadings = [] }]) {
    const changed = copy(fixture); change(changed); await rejectBoth(changed, /result|trace|files|grade|observation|execution/i)
  }
  const raw = copy(fixture), value = JSON.parse(raw.files[prefix(raw) + 'result.json'])
  value.totalPerformance.portfolioStatistics.endEquity = '1501'; raw.files[prefix(raw) + 'result.json'] = canonical(value)
  await rejectBoth(raw, /equity|observation/i)
  const wrongProfile = copy(fixture); end(wrongProfile).grade.trace = []; Object.assign(end(wrongProfile).grade, gradeInterpretations(wrongProfile.project.tasks[0], [], 'json'))
  await rejectBoth(wrongProfile, /profile|trace|observation/i)
  const hiddenEvents = copy(fixture); hiddenEvents.files[prefix(hiddenEvents) + 'order-events.json'] = '[]'
  await rejectBoth(hiddenEvents, /files|roster|artifact/i)
  end(hiddenEvents).grade.files.push(hiddenEvents.project.schedule[0].id + '-1-order-events.json')
  const accepted = await verify(hiddenEvents); assert.deepEqual(accepted.attempts[0].observation, end(fixture).grade.trace)
  assert.ok(Object.hasOwn(accepted.attempts[0].artifactFileHashes, prefix(fixture) + 'order-events.json'))
})

test('complete interpretation projection is checked, including shared observable classes and scoped attribution', async () => {
  const fixture = await operationalFixture()
  for (const [name, mutate] of [['score', grade => { grade.score = 0 }], ['classification', grade => { grade.classification = 'correct' }],
    ['scope', grade => { grade.interpretationScope = 'all-possible-meanings' }], ['behavior', grade => { grade.behavior = 'refusal' }],
    ['reading-subset', grade => { grade.matchingReadings = ['quantity-2'] }]]) {
    const changed = copy(fixture); mutate(end(changed).grade)
    await rejectBoth(changed, /grade|observable class|attribution|interpretation/i)
  }
  const ordinary = await makeFixture({ information: false })
  const accepted = await verify(ordinary); assert.equal(accepted.attempts[0].reconstructedGrade.classification, 'correct')
  end(ordinary).grade.classification = 'admissible'
  await rejectBoth(ordinary, /grade|classification/i)
})

test('a valid but incorrect native observation yields an observed failing result rather than invented artifact failure', async () => {
  const fixture = copy(await synchronousFixture()), task = fixture.project.tasks[0], id = fixture.project.schedule[0].id + '-1', time = task.input.bars[0].time
  const raw = { state: { Status: 'Completed' }, orders: { 1: { id: 1, tag: 'root/strategy|buy', type: 0, quantity: 1 } } }
  const events = [{ status: 'filled', orderId: 1, symbol: 'SPY', fillQuantity: 1, fillPrice: 110, time }]
  const trace = nativeObservation(raw, events, task)
  assert.deepEqual(trace.map(row => [row.bar, row.path, row.quantity, row.priceCents]), [[0, 'root/strategy', 1, 11000]])
  Object.assign(end(fixture).grade, gradeInterpretations(task, trace, 'json'), { trace, files: [id + '.json', id + '-order-events.json'] })
  end(fixture).grade.execution.stdout = 'Fabricated correct trace: ' + canonical(task.expected)
  fixture.files[prefix(fixture) + 'execution.json'] = canonical(end(fixture).grade.execution)
  fixture.files[prefix(fixture) + 'result.json'] = canonical(raw); fixture.files[prefix(fixture) + 'order-events.json'] = canonical(events)
  const checked = await verify(fixture)
  assert.equal(checked.attempts[0].disposition, 'observed'); assert.equal(checked.attempts[0].reconstructedGrade.passed, false)
  assert.equal(checked.attempts[0].reconstructedGrade.classification, 'outside-declared-set')
  delete fixture.files[prefix(fixture) + 'order-events.json']; end(fixture).grade.files = [id + '.json']
  await rejectBoth(fixture, /event|orders/i)
})

test('non-answer and no-program outcomes are rederived exactly without inventing native files or metadata', async () => {
  const outputs = [{ kind: 'clarification', message: 'Which quantity?' }, { kind: 'refusal', message: 'I decline.' },
    { kind: 'clarification', message: 'Which?', answer: 3 }]
  for (const output of outputs) {
    const fixture = await makeFixture({ tagged: true, output }), result = await verify(fixture)
    assert.equal(result.attempts[0].disposition, 'non-answer'); assert.equal(result.attempts[0].candidateSha256, null)
    assert.deepEqual(result.attempts[0].reconstructedGrade, informationDisposition(decodeInformationResponse(fixture.project.tasks[0], output)))
    assert.equal(Object.keys(result.attempts[0].artifactFileHashes).length, 0)
    end(fixture).grade.nativeExecuted = true; await rejectBoth(fixture, /grade|metadata|disposition|unsupported/i)
  }
  const empty = await makeFixture({ output: null }), result = await verify(empty)
  assert.equal(result.attempts[0].disposition, 'no-program'); assert.equal(result.attempts[0].observation, null)
  assert.equal(result.attempts[0].reconstructedGrade.score, 0)
  const reason = copy(empty); end(reason).grade.reason = 'Invented failure reason'; await rejectBoth(reason, /grade|reason|program/i)
  empty.files[prefix(empty) + 'main.py'] = code; await rejectBoth(empty, /file|roster|unexpected/i)
})

test('ordinary nonzero engine exits retain only an explicit failing grade while unsupported historical outcomes stay unverified', async () => {
  const fixture = copy(await operationalFixture()), grade = end(fixture).grade
  delete grade.trace; delete grade.files
  for (const key of ['behavior', 'matchingReadings', 'interpretationScope']) delete grade[key]
  Object.assign(grade, { passed: false, score: 0, classification: 'execution-error' }); grade.execution.exitCode = 1
  fixture.files[prefix(fixture) + 'execution.json'] = canonical(grade.execution)
  const accepted = await verify(fixture)
  assert.equal(accepted.attempts[0].disposition, 'execution-failure'); assert.equal(accepted.attempts[0].observation, null)
  assert.equal(accepted.attempts[0].reconstructedGrade.passed, false)
  assert.ok(Object.hasOwn(accepted.attempts[0].artifactFileHashes, prefix(fixture) + 'result.json'), 'Optional raw artifacts remain bound despite no successful observation.')
  for (const classification of ['execution-timeout', 'invalid-engine-result']) {
    const changed = copy(fixture); end(changed).grade.classification = classification
    await rejectBoth(changed, /unsupported|incomplete|execution|grade/i)
  }
  for (const exitCode of [125, 126, 127]) {
    const changed = copy(fixture); end(changed).grade.execution.exitCode = exitCode; changed.files[prefix(changed) + 'execution.json'] = canonical(end(changed).grade.execution)
    await rejectBoth(changed, /infrastructure|unsupported|exit|execution/i)
  }
})

test('private captures survive concurrent caller mutation, and equivalent decoded bytes keep the same proof hashes', async () => {
  const fixture = await operationalFixture(), baseline = await verify(fixture), changed = copy(fixture)
  const pending = verify(changed)
  changed.project.tasks[0].expected.cashFromFillsCents++
  end(changed).grade.trace.cashFromFillsCents++
  changed.files[prefix(changed) + 'result.json'] = '{}'; changed.files['inputs/fixtures/private-input.bin'].data = 'AAAA'
  assert.deepEqual(await pending, baseline)
  const encoded = copy(fixture)
  for (const [key, value] of Object.entries(encoded.files)) if (typeof value === 'string') encoded.files[key] = { encoding: 'base64', data: Buffer.from(value).toString('base64') }
  const alternate = await verify(encoded)
  assert.equal(alternate.filesSha256, baseline.filesSha256)
  assert.deepEqual(alternate.attempts[0].sourceFileHashes, baseline.attempts[0].sourceFileHashes)
  assert.deepEqual(alternate.attempts[0].artifactFileHashes, baseline.attempts[0].artifactFileHashes)
  assert.equal(alternate.attempts[0].evidenceSha256, baseline.attempts[0].evidenceSha256)
})

test('safe exact file unions and complete settled modern journals are required', async () => {
  const fixture = await operationalFixture()
  for (const name of ['unplanned.txt', '../escape', 'runtime/RUNNER.mjs']) {
    const changed = copy(fixture); changed.files[name] = 'unplanned bytes'; await rejectBoth(changed, /path|file|roster|collision|case/i)
  }
  const missing = copy(fixture); delete missing.files['runtime/tasks.mjs']; await rejectBoth(missing, /runtime|file|source|missing/i)
  const open = copy(fixture); open.events.pop(); open.files = Object.fromEntries(Object.entries(open.files).filter(([key]) => !key.startsWith('native/')))
  await assert.rejects(verify(open), /open|finish|recover|interrupted|unfinished/i)
  const failed = copy(open)
  failed.events.push({ ...end(fixture), status: 'failed', phase: 'transport', reason: 'Synthetic transport interruption' })
  delete end(failed).grade; delete end(failed).response
  const unmeasured = await verify(failed); assert.deepEqual(unmeasured.attempts, [])
  const legacy = await makeFixture({ operational: false, legacy: true }); await rejectBoth(legacy, /modern|version.?2|schema.?2/i)
  const sparse = copy(fixture); delete sparse.project.spec.runtimeSources['trading_broker.py']; delete sparse.files['runtime/trading_broker.py']
  await rejectBoth(sparse, /runtime|source|inventory|frozen project/i)
})

test('decoded per-file and canonical aggregate bounds reject oversized proofs before they can become receipts', async () => {
  assert.deepEqual(NATIVE_EVIDENCE_LIMITS, { fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 })
  const fixture = copy(await operationalFixture()), key = prefix(fixture) + 'result.json', base = fixture.files[key]
  fixture.files[key] = base + ' '.repeat(NATIVE_EVIDENCE_LIMITS.fileBytes - Buffer.byteLength(base))
  const edge = await verify(fixture); assert.equal(edge.attempts[0].disposition, 'observed')
  fixture.files[key] += ' '
  await assert.rejects(verify(fixture), /16 MiB|file.*limit|file.*byte|oversized/i)
  // Two individually valid 16 MiB text inputs expand to over 64 MiB of the
  // canonical captured envelope because JSON must escape every quote.
  const quotes = '"'.repeat(NATIVE_EVIDENCE_LIMITS.fileBytes)
  const aggregate = await makeFixture({ additionalInputs: { 'fixtures/quotes-a.txt': quotes, 'fixtures/quotes-b.txt': quotes } })
  assert.ok(Object.values(aggregate.files).every(value => auditFileBytes(value).length <= NATIVE_EVIDENCE_LIMITS.fileBytes))
  await assert.rejects(verify(aggregate), /64 MiB|total|envelope|aggregate|proof.*limit/i)
})

test('finite JSON capture refuses values that serialization could omit, coerce or recurse indefinitely', async () => {
  const fixture = await operationalFixture()
  for (const mutate of [
    value => { end(value).grade.omitted = undefined },
    value => { end(value).grade.score = Number.NaN },
    value => { end(value).response.output = 1n },
    value => { end(value).response.output = new Date(at) },
    value => { end(value).grade.extra = []; end(value).grade.extra.length = 1 },
    value => { end(value).grade.extra = []; end(value).grade.extra.unserialized = 'hidden' },
    value => { end(value).grade.loop = end(value).grade },
  ]) {
    const changed = copy(fixture); mutate(changed)
    await rejectBoth(changed, /finite|plain JSON|acyclic|sparse|extended JSON/i)
  }
})

test('the new strict contract does not rewrite audit-v1 acceptance or remove native admission holds', async () => {
  const fixture = copy(await operationalFixture())
  end(fixture).grade.execution.exitCode = 1
  fixture.files[prefix(fixture) + 'execution.json'] = canonical(end(fixture).grade.execution)
  const historical = await sealAuditReference(fixture.project, fixture.events, fixture.files)
  assert.equal(historical.version, 1, 'Existing audit-v1 consistency rules remain inspectable with their original limitations.')
  await rejectBoth(fixture, /execution|process|exit|grade/i)
  assert.ok(evaluateReadiness(fixture.project, { operation: 'collect' }).blockers.some(row => row.code === 'native-admission-unavailable'))
  await retain('legacy-audit-v1-consistency-only.json', historical)
})

test('a native grade that records its container arguments verifies only when they are exactly the runtime\'s', async () => {
  assert.equal(typeof leanObservationModule.leanContainerRecord, 'function', 'lean-observations.mjs builds the recorded container arguments')
  const fixture = await makeFixture({ operational: false, container: true })
  assert.deepEqual(end(fixture).grade.container.arguments, leanObservationModule.leanContainerArguments({ projectSha256: fixture.project.sha256, image: fixture.project.spec.environment.leanImage }))
  assertScope(await verify(fixture))
  for (const mutate of [grade => grade.container.arguments.push('--privileged'), grade => { grade.container.engine = 'podman' }, grade => { grade.container.arguments[grade.container.arguments.indexOf('none')] = 'host' }]) {
    const forged = copy(fixture); mutate(end(forged).grade)
    await rejectBoth(forged, /disagrees with the reconstructed execution/)
  }
})
