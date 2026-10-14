import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { operationalStarter, operationalStrategy, generateOperationalTasks } from '../../src/benchmark/trading-catalog.mjs'
import { compileTask, deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, verifyProject, gradeResponse, materializeCorpus } from '../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { createTaskReviewRecord } from '../../src/benchmark/information.mjs'
import { corpusPlanFromTask } from '../../src/benchmark/corpus.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject } from '../../src/benchmark/cli.mjs'
import { simulateTradingMarket } from '../../src/benchmark/trading-market.mjs'
import { nativeTradingObservation, observeTradingArtifacts, tradingObservationContract } from '../../src/benchmark/trading-observations.mjs'
import { operationalCandidateFiles } from '../../src/benchmark/trading-study.mjs'
import { auditReferencePaths, sealAuditReference } from '../../src/benchmark/audit.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { leanConfig } from '../../src/benchmark/lean-observations.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'

const root = resolve('src/benchmark'), sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(resolve(root, file), 'utf8')])))
const reviewed = async spec => {
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC OPERATIONAL STUDY TEST ONLY')))
  return spec
}
const independent = (task, input = task.input) => {
  const result = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', resolve(root, 'trading_market.py')], { input: canonical({ ir: task.compiled.operational, input }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout)
}

test('operational authoring preserves review gates and freezes a composition-bound IR and complete observation', async () => {
  const draft = await operationalStarter()
  await assert.rejects(freezeStudy(draft), /needs review/)
  const spec = await reviewed(draft), project = await freezeStudy(spec), task = project.tasks[0]
  assert.equal(task.compiled.operational.compositionSha256, await sha256(canonical(task.compiled.composition)))
  assert.deepEqual(task.expected.orders.map(order => order.quantity), [4, 4, -4, -4, 4, -4])
  assert.deepEqual(task.expected.events.filter(event => event.quantity).map(event => event.quantity), [2, 2, 2, 2, -2, -2, -2, -2, 2, 2, -2, -2])
  assert.equal(task.expected.cashFromFillsCents, 150000)
  assert.deepEqual(simulateTradingMarket(task.compiled.operational, task.input), independent(task))
  await verifyProject(project)
  const wrong = structuredClone(spec); wrong.tasks[0].expected.orders.pop()
  await assert.rejects(freezeStudy(wrong), /expected operational observation disagrees/)
  const changedSource = { ...sources, 'trading_broker.py': sources['trading_broker.py'] + '\n# changed source\n' }
  await assert.rejects(freezeStudy(await bindLeanReview(spec, changedSource)), /needs review/)
  const unknown = structuredClone(spec); unknown.leanProfile = 'invented'
  await assert.rejects(freezeStudy(unknown), /supported Lean profile/)
})

test('all operational catalog template arities, RACE choices, gates and resets agree with independent Python', async () => {
  const spec = await operationalStarter(), base = spec.tasks[0]
  for (const bundle of spec.catalog.filter(bundle => bundle.kind === 'template' && bundle.id !== 'op-strategy')) {
    const task = { ...base, root: { use: bundle.id, slots: Object.fromEntries(Object.keys(bundle.slots).map(slot => [slot, operationalStrategy()])) } }
    task.input = structuredClone(task.input)
    task.input.execution.cashCents = 200000
    task.input.bars = Array.from({ length: 20 }, (_, i) => ({ time: 1704205860 + 60 * i, prices: { SPY: i < 3 || i >= 8 && i < 12 ? 10000 : 12000 } }))
    // Keep explicit caps sufficient at all future fixture prices.
    for (const child of Object.values(task.root.slots)) child.slots.buy_process.params = { cashCapCents: 50000 }
    task.expected = await deriveTaskExpected(spec, task)
    const compiled = await compileTask(spec, task, { requireReview: false })
    assert.deepEqual(simulateTradingMarket(compiled.compiled.operational, task.input), independent(compiled), bundle.id)
  }
})

test('withheld operational quantities yield exact visible agreement and privately distinct native observations', async () => {
  const spec = await reviewed(await operationalStarter()), task = spec.tasks[0]
  const roots = [2, 4].map(quantity => { const ref = structuredClone(task.root); ref.slots.child1.slots.buy_process.params = { quantity }; return ref })
  task.familyId = 'private-quantity'
  task.information = { version: 1, scope: 'declared-set', responseMode: 'raw', withheldPaths: ['root/child1/buy_process'], rationale: 'Synthetic private quantity alternatives.',
    readings: roots.map((root, i) => ({ id: 'quantity-' + i, root, rationale: 'Explicit synthetic quantity.' })) }
  const compiled = await compileTask(spec, task, { requireTaskReview: false })
  assert.equal(compiled.informationPacket.observableClasses.length, 2)
  assert.ok(compiled.interpretations.every(reading => reading.compiled.text === compiled.compiled.text))
  const environments = compiled.interpretations.map(reading => operationalCandidateFiles({ ...compiled, compiled: reading.compiled }, '# candidate', sources))
  assert.deepEqual(environments[0], environments[1], 'The candidate mount must not disclose the hidden reading')
  assert.ok(!environments[0]['main.py'].includes('operational-ir') && !environments[0]['main.py'].includes('cashCapCents'))
  await assert.rejects(freezeStudy(spec), /complete admissible-reading packet/)
  spec.taskReviews = [await createTaskReviewRecord(compiled, 'SYNTHETIC OPERATIONAL INFORMATION TEST ONLY')]
  const project = await freezeStudy(spec)
  assert.deepEqual(gradeResponse(project, project.tasks[0], compiled.interpretations[0].expected).matchingReadings, ['quantity-0'])
  assert.deepEqual(independent({ ...task, compiled: compiled.interpretations[0].compiled }).observation, compiled.interpretations[0].expected)
})

test('a subtree reset requests every cancellation before their terminal acknowledgments release resources', async () => {
  const spec = await operationalStarter(), task = spec.tasks[0]
  task.root = { use: 'op-reset-all-2', params: { threshold: 11000 }, slots: { child1: operationalStrategy(), child2: operationalStrategy() } }
  for (const leaf of Object.values(task.root.slots)) leaf.slots.buy_process.params = { cashCapCents: 50000 }
  task.input.bars[1].prices.SPY = 12000
  task.expected = await deriveTaskExpected(spec, task)
  const compiled = await compileTask(spec, task, { requireReview: false })
  assert.deepEqual(task.expected.events.filter(event => event.time === task.input.bars[1].time).map(event => [event.order, event.status]),
    [[1, 'partial'], [2, 'partial'], [1, 'cancel-pending'], [2, 'cancel-pending'], [1, 'cancelled'], [2, 'cancelled']])
  assert.deepEqual(simulateTradingMarket(compiled.compiled.operational, task.input), independent(compiled))
})

function handArtifacts() {
  const time = 1704205860, times = [time, time + 60, time + 120]
  const contract = { version: 1, currency: 'USD', cashCents: 10000, assets: [{ id: 'SPY', multiplier: 1, quantityStep: 1 }], limits: { intents: 100, events: 100 },
    owners: [{ path: 'root/a', asset: 'SPY' }, { path: 'root/b', asset: 'SPY' }], bars: times.map(time => ({ time, prices: { SPY: 100 } })) }
  const make = (id, owner, lot, quantity, reason, status, at = 0) => ({ id, type: 0, securityType: 1, priceCurrency: 'USD', symbol: { value: 'SPY' },
    time: new Date(times[at] * 1000).toISOString(), quantity, status, tag: canonical(['LB-OP-1', owner, lot, reason, 'ticket-' + id]) })
  const orders = { 7: make(7, 'root/a', 'alpha', 4, 'entry', 5), 9: make(9, 'root/b', 'alpha', 3, 'entry', 1), 12: make(12, 'root/a', 'alpha', -2, 'exit', 3, 1) }
  const event = (orderId, orderEventId, status, at, fillQuantity = 0) => ({ orderId, orderEventId, status, time: times[at], symbolValue: 'SPY', fillQuantity,
    fillPrice: fillQuantity ? 1 : 0, fillPriceCurrency: 'USD', orderFeeAmount: 0, orderFeeCurrency: 'USD' })
  const events = [event(7, 1, 'submitted', 0), event(9, 1, 'submitted', 0), event(7, 3, 'partiallyFilled', 1, 2),
    event(12, 1, 'submitted', 1), event(7, 4, 'cancelPending', 1), event(7, 5, 'canceled', 1), event(12, 3, 'filled', 2, -2)]
  return { contract, orders, events }
}
test('native observation retains unfilled entries, private lots, partial cancellation and opaque label normalization', () => {
  const { contract, orders, events } = handArtifacts(), observed = observeTradingArtifacts(contract, orders, events)
  assert.deepEqual(observed.orders.map(order => [order.order, order.filledQuantity, order.unfilledQuantity, order.pending]), [[1, 2, 2, false], [2, 0, 3, true], [3, 2, 0, false]])
  assert.deepEqual(observed.lots.map(lot => [lot.owner, lot.lot, lot.boughtQuantity, lot.quantity]), [['root/a', 1, 2, 0], ['root/b', 1, 0, 0]])
  assert.equal(observed.cashFromFillsCents, 10000)
  for (const order of Object.values(orders)) { const tag = JSON.parse(order.tag); tag[2] = 'arbitrary different lot spelling'; tag[4] += '-renamed'; order.tag = canonical(tag) }
  assert.deepEqual(observeTradingArtifacts(contract, orders, events), observed)
})

test('native observation refuses cross-owner sales, duplicate/missing receipts, overfills, fees and status inconsistencies', () => {
  const mutations = [
    ({ orders }) => { const tag = JSON.parse(orders[12].tag); tag[1] = 'root/b'; orders[12].tag = canonical(tag) },
    ({ events }) => events.push(structuredClone(events.at(-1))),
    ({ events }) => events.splice(1, 1),
    ({ events }) => { events[2].fillQuantity = 5 },
    ({ events }) => { events[0].orderFeeAmount = 1 },
    ({ events }) => { events[2].orderFeeCurrency = 'EUR' },
    ({ orders }) => { orders[7].status = 3 },
    ({ orders }) => { orders[9].tag = 'invented' },
    ({ events }) => { events[2].isAssignment = true },
    ({ events }) => { events[2].time += 1 },
  ]
  for (const mutate of mutations) { const fixture = handArtifacts(); mutate(fixture); assert.throws(() => observeTradingArtifacts(fixture.contract, fixture.orders, fixture.events)) }
})

test('native starting and ending equity must reconcile without accepting candidate diagnostic claims', async () => {
  const spec = await operationalStarter(), task = await compileTask(spec, spec.tasks[0], { requireReview: false })
  const quiet = structuredClone(task); quiet.input.bars = quiet.input.bars.slice(0, 1)
  const result = { state: { Status: 'Completed' }, orders: {}, algorithmConfiguration: { accountCurrency: 'USD' }, totalPerformance: { portfolioStatistics: { startEquity: '1500', endEquity: '1500' } } }
  const observation = nativeTradingObservation(result, null, quiet)
  result.diagnostic = { cashFromFillsCents: 123 }; assert.deepEqual(nativeTradingObservation(result, null, quiet), observation)
  result.totalPerformance.portfolioStatistics.endEquity = '1501'
  assert.throws(() => nativeTradingObservation(result, null, quiet), /equity differs/)
})

test('operational corpus generation and role products derive observations through the shared compiler', async () => {
  const spec = await operationalStarter()
  spec.tasks = generateOperationalTasks({ buy_reason: ['op-above', 'op-below'], buy_process: ['op-shares'], sell_reason: ['op-after'], sell_process: ['op-sell-all', 'op-sell-fraction'] }, { wrapper: 'op-all-2', input: spec.tasks[0].input })
  assert.equal(spec.tasks.length, 4)
  for (const task of spec.tasks) { task.expected = await deriveTaskExpected(spec, task); await compileTask(spec, task, { requireReview: false }) }
  spec.corpusPlan = corpusPlanFromTask(spec.tasks[0]); const generated = await materializeCorpus(spec)
  assert.equal(generated.manifest.status, 'ready')
  assert.equal(generated.tasks[0].expected.format, 'lean-operational-observation')
})

test('an operational audit binds candidate and public harness bytes and regrades native artifacts after resealing', async () => {
  let spec = await operationalStarter()
  spec.tasks[0].root = operationalStrategy(); spec.tasks[0].root.slots.buy_reason.params = { threshold: 99999999 }
  spec.tasks[0].expected = await deriveTaskExpected(spec, spec.tasks[0])
  spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
  spec.environment.leanImage = 'synthetic/fixture@sha256:' + 'a'.repeat(64)
  // lean-python grades a program, so the saved replay response is one (8b7dc2ab refuses the starter's
  // JSON observation here); the adapter and grade below are supplied directly and nothing is executed.
  spec.conditions[0].adapter.responses = { 'operational-canary': '# OPERATIONAL AUDIT MARKER PROGRAM; NEVER EXECUTED\n' }
  spec = await reviewed(developmentDraft(spec))
  const project = await freezeStudy(spec), task = project.tasks[0], code = '# SYNTHETIC AUDIT ARTIFACT FIXTURE ONLY', id = project.schedule[0].id + '-1'
  const execution = { exitCode: 0, stdout: 'SYNTHETIC UNIT ARTIFACT', stderr: '', signal: null }
  const result = { state: { Status: 'Completed' }, orders: {}, algorithmConfiguration: { accountCurrency: 'USD' }, totalPerformance: { portfolioStatistics: { startEquity: '1500', endEquity: '1500' } } }
  const grade = { passed: true, score: 1, classification: 'correct', trace: nativeTradingObservation(result, null, task),
    directory: 'artifacts/' + id, files: [id + '.json'], image: spec.environment.leanImage, candidateSha256: await sha256(code), execution }
  const run = await runStudy(project, { adapter: async () => ({ output: code }), grade: async () => grade })
  const programs = operationalCandidateFiles(task, code, sources), files = Object.fromEntries(Object.entries(sources).map(([file, source]) => ['runtime/' + file, source]))
  for (const [file, source] of Object.entries({ ...programs, 'config.json': canonical(leanConfig(id)), 'execution.json': canonical(execution), 'result.json': canonical(result) })) files['native/' + id + '/' + file] = source
  assert.equal(auditReferencePaths(project, run.events).length, Object.keys(files).length)
  await sealAuditReference(project, run.events, files)
  for (const file of ['main.py', 'candidate.py', 'trading_broker.py']) {
    await assert.rejects(sealAuditReference(project, run.events, { ...files, ['native/' + id + '/' + file]: files['native/' + id + '/' + file] + '\n# changed\n' }), /archived native program differs from the retained candidate hash|program or public harness differs/)
  }
  const forged = structuredClone(run.events); forged.find(event => event.type === 'finished').grade.trace.cashFromFillsCents++
  await assert.rejects(sealAuditReference(project, forged, files), /trace disagrees/)
  result.totalPerformance.portfolioStatistics.endEquity = '1501'
  await assert.rejects(sealAuditReference(project, run.events, { ...files, ['native/' + id + '/result.json']: canonical(result) }), /equity differs/)
})

test('an operational export independently verifies, qualifies, runs and reports, refusing regenerated artifact tampering', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'operational-study-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = await reviewed(await operationalStarter()), project = await freezeStudy(spec), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), contents) }
  for (const command of ['verify', 'qualify', 'run', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
  }
  const evidence = JSON.parse(await readFile(resolve(directory, 'results/evidence.json'), 'utf8'))
  assert.equal(evidence.summary.completed, 1); assert.equal(evidence.summary.groups[0].passed, 1)
  const changed = 'lean/operational-canary/reference/main.py', text = files[changed] + '\n# forged generated source\n'
  await writeFile(resolve(directory, changed), text)
  const manifest = JSON.parse(files['manifest.json']); manifest.files[changed] = await sha256(text)
  await writeFile(resolve(directory, 'manifest.json'), canonical(manifest))
  await assert.rejects(readProject(directory), /Generated Lean artifact changed/)
})
