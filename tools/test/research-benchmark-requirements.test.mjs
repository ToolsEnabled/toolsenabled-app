import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, prepareStudyReview, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { qualifyProject } from '../../src/benchmark/qualify.mjs'
import { qualifyRequirements, firstObservableDifference, validateRequirementPlan } from '../../src/benchmark/requirements.mjs'
import { shrinkSequence, valueAt } from '../../src/benchmark/shrinking.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { readProject } from '../../src/benchmark/cli.mjs'
import { operationalRequirementFixture } from './fixtures/research-benchmark-requirements.mjs'

const root = resolve('src/benchmark'), sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(resolve(root, file), 'utf8')])))
const reviewed = async spec => {
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC REQUIREMENT APPARATUS TEST ONLY')))
  return spec
}
const prepare = async spec => ({ ...await prepareStudyReview(spec), sha256: 'SYNTHETIC UNFROZEN APPARATUS PREVIEW' })

test('registered four-role and RACE requirements qualify independent witnesses and shrink each diagnostic', async () => {
  const project = await freezeStudy(await reviewed(await operationalRequirementFixture({ shrink: true })))
  await verifyProject(project)
  const record = await qualifyProject(root, project), report = record.requirements
  assert.equal(report.status, 'qualified')
  assert.equal(report.targets.length, 5)
  assert.ok(report.unregistered.length > 0, 'Five witnesses cannot claim the whole study is covered')
  assert.equal(report.nativeValidated, false); assert.equal(report.personalApproval, false)
  for (const target of report.targets) {
    assert.equal(target.status, 'qualified'); assert.equal(target.detectedWrongReadings, 1)
    const probe = target.probes[0], wrong = probe.wrongReadings[0], shrink = wrong.shrink
    assert.equal(probe.baseline.status, 'agreed'); assert.ok(probe.assertions.every(row => row.passed)); assert.ok(probe.active)
    assert.equal(wrong.outcome.status, 'agreed'); assert.equal(wrong.detected, true); assert.ok(wrong.difference)
    assert.equal(shrink.oneMinimal, true); assert.equal(shrink.exhausted, false)
    assert.ok(shrink.finalLength < shrink.originalLength)
    assert.deepEqual(shrink.input.bars, shrink.keptIndices.map(index => project.requirements.targets.find(row => row.id === target.id).probes[0].reference.input.bars[index]))
    assert.equal(project.requirements.targets.find(row => row.id === target.id).probes[0].reference.input.bars.length, 10)
  }
})

test('hand-truth failure, inactive requirements and undetected wrong readings never become qualified', async () => {
  const failure = await operationalRequirementFixture(); failure.requirementPlan.targets = [failure.requirementPlan.targets[0]]
  failure.requirementPlan.targets[0].probes[0].assertions[0].equals = 1
  const failed = (await qualifyProject(root, await prepare(failure))).requirements
  assert.equal(failed.status, 'failed'); assert.equal(failed.targets[0].probes[0].wrongReadings[0].detected, false)
  const inactive = await operationalRequirementFixture(); inactive.requirementPlan.targets = [inactive.requirementPlan.targets[0]]
  inactive.requirementPlan.targets[0].activation[0].minimum = 100
  const unactivated = (await qualifyProject(root, await prepare(inactive))).requirements
  assert.equal(unactivated.status, 'incomplete'); assert.equal(unactivated.targets[0].probes[0].active, false)
  assert.ok(unactivated.targets[0].probes[0].wrongReadings[0].difference, 'A difference alone must not satisfy activation')
  const survivor = await operationalRequirementFixture(); survivor.requirementPlan.targets = [survivor.requirementPlan.targets[0]]
  // Both predicates are true on the same bar, despite different rules.
  survivor.requirementPlan.targets[0].wrongReadings[0].root.slots.buy_reason.params.threshold = 10002
  for (const bar of survivor.requirementPlan.targets[0].probes[0].input.bars.slice(1)) bar.prices.SPY = 10003
  const survived = (await qualifyProject(root, await prepare(survivor))).requirements
  assert.equal(survived.status, 'incomplete'); assert.equal(survived.targets[0].probes[0].wrongReadings[0].difference, null)
})

test('a missing wrong-reading registry and an unsupported domain remain explicit gaps', async () => {
  const spec = await operationalRequirementFixture(); spec.requirementPlan.targets = [spec.requirementPlan.targets[0]]
  spec.requirementPlan.targets[0].wrongReadings = []
  const project = await prepare(spec), report = (await qualifyProject(root, project)).requirements
  assert.equal(report.status, 'incomplete'); assert.equal(report.targets[0].registeredWrongReadings, 0)
  const unsupported = await qualifyRequirements(project.requirements)
  assert.equal(unsupported.status, 'unavailable'); assert.match(unsupported.reason, /both source-bound/)
})

test('requirement compilation rejects confounded, duplicated and stale semantic bindings', async () => {
  const spec = await operationalRequirementFixture(); spec.requirementPlan.targets = [spec.requirementPlan.targets[0]]
  const confounded = structuredClone(spec)
  confounded.requirementPlan.targets[0].wrongReadings[0].root.slots.buy_process.params.quantity = 2
  await assert.rejects(prepare(confounded), /unrelated requirement/)
  const duplicate = structuredClone(spec), second = structuredClone(duplicate.requirementPlan.targets[0].wrongReadings[0]); second.id = 'same-reading'
  duplicate.requirementPlan.targets[0].wrongReadings.push(second)
  await assert.rejects(prepare(duplicate), /Duplicate wrong-reading semantics/)
  const unchanged = structuredClone(spec); unchanged.requirementPlan.targets[0].wrongReadings[0].root = structuredClone(spec.tasks[0].root)
  await assert.rejects(prepare(unchanged), /must change the target semantics/)
  const stale = structuredClone(spec); stale.requirementPlan.targets[0].requirementId = 'root/buy_reason#missing'
  await assert.rejects(prepare(stale), /exact composition requirement/)
  const invalid = structuredClone(spec.requirementPlan); invalid.targets[0].probes[0].oracle = 'unregistered'
  assert.throws(() => validateRequirementPlan(invalid), /unsupported fields/)
  const changedSource = { ...sources, 'requirements.mjs': sources['requirements.mjs'] + '\n// changed qualifier\n' }
  await assert.rejects(freezeStudy(await bindLeanReview(await reviewed(spec), changedSource)), /needs review/)
})

test('information requirements cannot quietly select their private latent baseline', async () => {
  const spec = await operationalRequirementFixture(), task = spec.tasks[0]
  const roots = [10000, 9999].map(threshold => { const root = structuredClone(task.root); root.slots.buy_reason.params.threshold = threshold; return root })
  task.familyId = 'withheld-threshold'
  task.information = { version: 1, scope: 'declared-set', responseMode: 'raw', withheldPaths: ['root/buy_reason'], rationale: 'Synthetic alternatives only.',
    readings: roots.map((root, i) => ({ id: 'reading-' + i, root, rationale: 'Declared synthetic threshold reading.' })) }
  spec.requirementPlan.targets = [spec.requirementPlan.targets[0]]
  await assert.rejects(prepare(spec), /latent baseline cannot/)
  spec.requirementPlan.targets[0].readingId = 'reading-0'
  const project = await prepare(spec)
  assert.equal(project.requirements.targets[0].readingId, 'reading-0')
  assert.ok(project.requirements.unregistered.some(row => row.readingId === 'reading-1' && row.requirementId === 'root/buy_reason#op-above'))
})

test('generic interpreter callbacks retain disagreement and unavailable execution without invented detection', async () => {
  const spec = await operationalRequirementFixture(); spec.requirementPlan.targets = [spec.requirementPlan.targets[0]]
  const packet = (await prepare(spec)).requirements
  // The same generic qualifier accepts an arbitrary observation shape. No
  // LEAN controller is invoked by these evaluator callbacks.
  const encode = async task => ({ observation: { orders: [{ time: task.root.slots.buy_reason.params.threshold === 10000 ? 1704205920 : 1704205860 }] }, activation: { counters: { true: 1 }, transitions: {} } })
  const good = await qualifyRequirements(packet, { interpret: encode, independent: async task => JSON.parse(JSON.stringify(await encode(task))) })
  assert.equal(good.status, 'qualified')
  const mismatch = await qualifyRequirements(packet, { interpret: encode, independent: async task => ({ ...await encode(task), disagreement: true }) })
  assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.targets[0].probes[0].baseline.status, 'disagreed')
  const failure = await qualifyRequirements(packet, { interpret: encode, independent: async () => { const error = new Error('Independent process failed'); error.evidence = { exitCode: 7, stderr: 'fixture failure' }; throw error } })
  assert.equal(failure.status, 'failed'); assert.equal(failure.targets[0].probes[0].baseline.process.exitCode, 7)
  assert.equal(failure.targets[0].probes[0].wrongReadings[0].detected, false)
})

test('observable differences preserve missing versus null, array positions and literal own-key access', () => {
  assert.deepEqual(firstObservableDifference({ x: null }, {}), { path: ['x'], reference: { present: true, value: null }, wrongReading: { present: false } })
  assert.deepEqual(firstObservableDifference([1, 2], [1, 3]).path, [1])
  assert.equal(firstObservableDifference({ z: 1, a: 2 }, { a: 2, z: 1 }), null)
  assert.deepEqual(valueAt({}, ['toString']), { present: false })
})

test('sequence shrinking proves only bounded deletion minimality and never treats evaluator errors as rejection', async () => {
  const input = { items: ['noise', 'a', 'noise', 'b', 'noise'] }
  const result = await shrinkSequence(input, { path: ['items'], preserves: async next => next.items.includes('a') && next.items.includes('b') })
  assert.deepEqual(result.input.items, ['a', 'b']); assert.equal(result.oneMinimal, true); assert.deepEqual(input.items, ['noise', 'a', 'noise', 'b', 'noise'])
  const bounded = await shrinkSequence(input, { path: ['items'], maxEvaluations: 1, preserves: async () => true })
  assert.equal(bounded.exhausted, true); assert.equal(bounded.oneMinimal, false)
  const unavailable = await shrinkSequence({ items: [1] }, { path: ['items'], preserves: async next => { if (next.items.length === 0) throw new Error('Unknown, not rejected'); return true } })
  assert.equal(unavailable.oneMinimal, false); assert.equal(unavailable.attempts.at(-1).preserved, null)
  const controller = new AbortController(); controller.abort(new Error('Stop diagnostic work'))
  await assert.rejects(shrinkSequence(input, { path: ['items'], preserves: async () => true, signal: controller.signal }), /Stop diagnostic work/)
})

test('standalone exports bind requirement registries and preserve failed qualification with a nonzero CLI result', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'requirement-project-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = await reviewed(await operationalRequirementFixture()), project = await freezeStudy(spec), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), contents) }
  const cli = command => spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(cli('verify').status, 0)
  const qualified = cli('qualify'); assert.equal(qualified.status, 0, qualified.stderr)
  assert.equal(JSON.parse(await readFile(resolve(directory, 'results/qualification.json'), 'utf8')).requirements.status, 'qualified')
  assert.match(await readFile(resolve(directory, 'results/qualification/report.html'), 'utf8'), /occurrences remain unregistered/)
  assert.match(await readFile(resolve(directory, 'results/qualification/wrong-readings.csv'), 'utf8'), /wrong-entry-quantity/)
  const changed = 'requirements/registry.json', manifest = JSON.parse(files['manifest.json'])
  const forged = files[changed] + '\n'; manifest.files[changed] = await sha256(forged)
  await writeFile(resolve(directory, changed), forged); await writeFile(resolve(directory, 'manifest.json'), canonical(manifest))
  await assert.rejects(readProject(directory), /Generated requirement artifact changed/)
  delete manifest.files[changed]; await writeFile(resolve(directory, changed), files[changed]); await writeFile(resolve(directory, 'manifest.json'), canonical(manifest))
  await assert.rejects(readProject(directory), /omits a requirement artifact/)
  spec.requirementPlan.targets[0].probes[0].assertions[0].equals = 0
  const failing = await projectFiles(await freezeStudy(spec), sources)
  for (const [file, contents] of Object.entries(failing)) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), contents) }
  const failure = cli('qualify'); assert.equal(failure.status, 1, failure.stderr)
  const retained = JSON.parse(await readFile(resolve(directory, 'results/qualification.json'), 'utf8'))
  assert.equal(retained.requirements.status, 'failed'); assert.equal(retained.requirements.targets[0].probes[0].assertions[0].passed, false)
})
