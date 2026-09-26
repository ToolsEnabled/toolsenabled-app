import { PYTHON_COMMAND, PYTHON_ARGS } from './lib/python-command.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { requirementFieldInventory, createRequirementFieldDraft, compileRequirementFields, requirementValueField, requirementFieldValue } from '../../src/benchmark/requirement-fields.mjs'
import { qualifyRequirements, requirementInterpretation, assertSelectedInputQualification } from '../../src/benchmark/requirements.mjs'
import { simulateTradingMarket } from '../../src/benchmark/trading-market.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { operationalRequirementFixture } from './fixtures/research-benchmark-requirements.mjs'
import { nestedRequirementFieldFixture } from './fixtures/research-benchmark-requirement-fields.mjs'

test('field roster enumerates every nested occurrence and explicit information reading without treating empty fields as independent truth', async () => {
  const { inventory } = await nestedRequirementFieldFixture()
  assert.equal(inventory.rows.length, 17); assert.equal(inventory.blocking.length, 0)
  const draft = createRequirementFieldDraft(inventory)
  assert.ok(draft.targets.every(target => target.rationale === '' && target.probes[0].assertions.length === 0 && target.wrongReadings.length === 0 && target.activation[0].name === ''))
  const spec = await operationalRequirementFixture(), task = spec.tasks[0]
  delete spec.requirementPlan; spec.tasks = [task]; task.familyId = 'withheld-threshold'
  task.information = { version: 1, scope: 'declared-set', responseMode: 'raw', withheldPaths: ['root/buy_reason'], rationale: 'Two explicitly supplied readings.',
    readings: [10000, 9999].map((threshold, index) => { const root = structuredClone(task.root); root.slots.buy_reason.params.threshold = threshold; return { id: 'reading-' + index, root, rationale: 'A supplied threshold meaning.' } }) }
  const expanded = await requirementFieldInventory(spec)
  assert.equal(expanded.rows.length, 10)
  assert.equal(expanded.rows.filter(row => row.readingId === 'reading-0').length, 5)
  assert.equal(expanded.rows.filter(row => row.readingId === 'reading-1').length, 5)
  assert.ok(expanded.rows.every(row => row.readingId !== null))
  const synchronous = await requirementFieldInventory(await leanStarter())
  assert.ok(synchronous.rows.some(row => row.activationMode === 'unsupported'))
  assert.ok(synchronous.blocking.some(row => row.reason.includes('No occurrence-level activation metric')))
  await assert.rejects(compileRequirementFields(await leanStarter(), createRequirementFieldDraft(synchronous)), /No occurrence-level activation metric/)
})

test('fields preserve unfinished values, reject stale or partial rosters and never silently truncate the target budget', async () => {
  const { spec, draft } = await nestedRequirementFieldFixture()
  assert.throws(() => requirementFieldValue({ kind: 'number', text: '1e' }), /unfinished/)
  assert.throws(() => requirementFieldValue({ kind: 'number', text: '' }), /unfinished/)
  const values = { empty: '', nested: [true, null, 2.5], __safe: 'value' }
  assert.deepEqual(requirementFieldValue(requirementValueField(values)), values)
  const stale = structuredClone(spec); stale.tasks[0].input.bars[0].prices.SPY += 1
  await assert.rejects(compileRequirementFields(stale, draft), /changed/)
  await assert.rejects(compileRequirementFields(spec, { ...draft, targets: draft.targets.slice(1) }), /exactly one/)
  const unfinished = structuredClone(draft); unfinished.targets[1].wrongReadings[0].value = { kind: 'number', text: 'unfinished' }
  await assert.rejects(compileRequirementFields(spec, unfinished), /unfinished/)
  const tooMany = structuredClone(spec); tooMany.tasks = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(spec.tasks[0]), id: 'nested-' + index }))
  const inventory = await requirementFieldInventory(tooMany)
  assert.equal(inventory.rows.length, 136)
  assert.match(inventory.blocking.map(row => row.reason).join(' '), /136 occurrence targets.*544.*no occurrences were omitted/)
  await assert.rejects(compileRequirementFields(tooMany, createRequirementFieldDraft(inventory)), /no occurrences were omitted/)
})

test('generator produces isolated local mutations and rejects unsupported metrics or unchanged meanings', async () => {
  const { spec, draft, inventory } = await nestedRequirementFieldFixture(), original = canonical(spec)
  const generated = await compileRequirementFields(spec, draft)
  assert.equal(canonical(spec), original)
  assert.equal(generated.plan.selectedInput.policy, 'require-composition')
  assert.equal(generated.registry.selectedInput.compositionOccurrences, 17)
  assert.deepEqual(generated.registry.selectedInput.unregistered, [])
  assert.equal(generated.registry.targets.length, 17)
  const changed = generated.plan.targets[2].wrongReadings[0].root
  assert.equal(changed.slots.child1.slots.buy_reason.params.threshold, 11000)
  assert.deepEqual(changed.slots.child2, spec.tasks[0].root.slots.child2)
  assert.ok(generated.plan.targets.every((target, index) => target.requirementId === inventory.rows[index].requirementId))
  const fake = structuredClone(draft); fake.targets[0].activation[0].name = 'invented-success'
  await assert.rejects(compileRequirementFields(spec, fake), /actually supplied/)
  const unchanged = structuredClone(draft); unchanged.targets[2].wrongReadings[0].value = requirementValueField(5000)
  await assert.rejects(compileRequirementFields(spec, unchanged), /must change the target semantics/)
  const absent = structuredClone(draft); absent.targets[0].probes[0].assertions = []
  await assert.rejects(compileRequirementFields(spec, absent), /independent observable assertion/)
})

test('generic module fields bind two distinct source files and retain explicitly declared activation', async () => {
  const spec = genericStarter(); spec.tasks = [{ id: 'addition', root: { use: 'task' }, input: null, expected: '5', split: 'development' }]
  spec.inputs = [{ path: 'reference.mjs', sha256: 'a'.repeat(64) }, { path: 'independent.mjs', sha256: 'b'.repeat(64) }]
  const inventory = await requirementFieldInventory(spec), draft = createRequirementFieldDraft(inventory)
  assert.equal(inventory.rows[0].activationMode, 'module-declared')
  draft.rationale = 'Explicit addition counterpart fixture.'
  draft.interpreters = { reference: 'reference.mjs', independent: 'independent.mjs', rationale: 'The selected sources implement addition through different algorithms.' }
  const target = draft.targets[0]; target.rationale = 'Two plus three is five.'; target.activation = [{ kind: 'counter', name: 'evaluated', minimum: '1' }]
  target.probes[0].assertions = [{ path: [], value: requirementValueField('5') }]
  target.wrongReadings = [{ id: 'wrong-operand', kind: 'parameter', parameter: 'a', value: requirementValueField(3), rationale: 'Changing the first operand changes the answer.' }]
  const generated = await compileRequirementFields(spec, draft)
  assert.equal(generated.registry.interpreters.reference.file, 'reference.mjs')
  const interpret = async task => ({ observation: String(Number(task.compiled.semantic.a) + Number(task.compiled.semantic.b)), activation: { counters: { evaluated: 1 }, transitions: {} } })
  const independent = async task => { let answer = Number(task.compiled.semantic.a); for (let count = Number(task.compiled.semantic.b); count > 0; count--) answer++; return { observation: String(answer), activation: { counters: { evaluated: 1 }, transitions: {} } } }
  const result = await qualifyRequirements(generated.registry, { interpret, independent })
  assert.equal(result.selectedInput.compositionStatus, 'qualified')
  const inactive = fn => async task => ({ ...await fn(task), activation: { counters: { evaluated: 0 }, transitions: {} } })
  const unobserved = await qualifyRequirements(generated.registry, { interpret: inactive(interpret), independent: inactive(independent) })
  assert.equal(unobserved.selectedInput.compositionStatus, 'incomplete', 'Generated controls do not imply observed activation.')
  const same = structuredClone(draft); same.interpreters.independent = same.interpreters.reference
  await assert.rejects(compileRequirementFields(spec, same), /two distinct/)
  // This callback fixture is not a module-host process execution receipt.
})

test('all 17 nested field controls qualify against independently executed Python on both witnesses and selected input', async t => {
  const { spec, draft } = await nestedRequirementFieldFixture(), { registry, inventory, plan } = await compileRequirementFields(spec, draft)
  const unique = new Map(), key = task => canonical({ ir: task.compiled.operational, input: task.input })
  for (const target of registry.targets) for (const probe of [...target.probes, target.selectedInput]) for (const task of [probe.reference, ...probe.wrongReadings.map(row => row.task)]) unique.set(key(task), task)
  const requests = [...unique.keys()].map(raw => JSON.parse(raw)), script = 'import json,sys\nfrom trading_market import simulate\nprint(json.dumps([simulate(row["ir"],row["input"]) for row in json.load(sys.stdin)],separators=(",",":"),allow_nan=False))\n'
  const directory = await mkdtemp(resolve('..', 'requirement-fields-controls-')), input = canonical(requests) + '\n'
  const processResult = spawnSync(PYTHON_COMMAND, [...PYTHON_ARGS, '-B', '-c', script], { cwd: resolve('src/benchmark'), input, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
  const sources = Object.fromEntries(await Promise.all(['requirement-fields.mjs', 'requirements.mjs', 'trading-market.mjs', 'trading-runtime.mjs', 'trading_market.py', 'trading_reference.py'].map(async file => [file, await sha256(await readFile(resolve('src/benchmark', file)))])))
  await Promise.all([writeFile(resolve(directory, 'input.json'), input), writeFile(resolve(directory, 'driver.py'), script), writeFile(resolve(directory, 'stdout.json'), processResult.stdout || ''),
    writeFile(resolve(directory, 'stderr.txt'), processResult.stderr || ''), writeFile(resolve(directory, 'fields.json'), canonical(draft)), writeFile(resolve(directory, 'plan.json'), canonical(plan)),
    writeFile(resolve(directory, 'process.json'), canonical({ executable: PYTHON_COMMAND, arguments: ['-B', '-c', script], exitCode: processResult.status, signal: processResult.signal, error: processResult.error?.message || null, sources,
      requestSha256: await sha256(input), driverSha256: await sha256(script), pythonProcesses: 1, pythonSimulationsRequested: requests.length, nativeRuns: 0, providerCalls: 0 }))])
  t.diagnostic('Retained independent control evidence: ' + directory + '; ' + requests.length + ' distinct Python simulations in one process, no native or provider runs.')
  assert.equal(processResult.status, 0, processResult.stderr)
  const raw = JSON.parse(processResult.stdout), python = new Map([...unique.keys()].map((id, index) => [id, raw[index]])), javascript = new Map([...unique].map(([id, task]) => [id, simulateTradingMarket(task.compiled.operational, task.input)]))
  assert.equal(raw.length, requests.length)
  for (const [id, result] of javascript) assert.deepEqual(python.get(id), result)
  const report = await qualifyRequirements(registry, { interpret: async (task, target) => requirementInterpretation(task, target, javascript.get(key(task))), independent: async (task, target) => requirementInterpretation(task, target, python.get(key(task))) })
  await writeFile(resolve(directory, 'qualification.json'), canonical(report))
  assert.equal(report.status, 'qualified', report.targets.filter(row => row.status !== 'qualified').map(row => row.id + ':' + row.status).join(', '))
  assert.equal(report.selectedInput.compositionStatus, 'qualified')
  assert.equal(report.selectedInput.qualifiedOccurrences, 17)
  const project = { spec, tasks: inventory.tasks, requirements: registry, sha256: 'UNFROZEN LOCAL APPARATUS PREVIEW' }
  const record = { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256, runtimeSources: spec.runtimeSources || {}, requirements: report }
  assertSelectedInputQualification(project, record)
  await writeFile(resolve(directory, 'result.json'), canonical({ status: 'qualified', targets: 17, selectedInputTargets: 17, interpreterComparisons: 68, distinctJavaScriptSimulations: javascript.size, distinctPythonSimulations: raw.length, personalApproval: false, nativeValidated: false }))
})
