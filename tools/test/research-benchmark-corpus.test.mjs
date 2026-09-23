import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { corpusPlanFromTask, generateCorpus } from '../../src/benchmark/corpus.mjs'
import { canonical, createReviewRecord, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, materializeCorpus, RUNTIME_FILES, verifyProject } from '../../src/benchmark/study.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { coverageFixture } from './fixtures/research-benchmark-coverage.mjs'

function recipe() {
  const plan = corpusPlanFromTask(genericStarter().tasks[0])
  plan.families[0].id = 'addition-family'
  plan.families[0].axes = [
    { id: 'number', choices: [2, 4].map(value => ({ id: `n-${value}`, edits: [{ kind: 'parameter', path: ['task'], name: 'a', value }, { kind: 'expected', value: String(value + 3) }] })) },
    { id: 'depth', choices: [0, 2].map(repeat => ({ id: `depth-${repeat}`, edits: [{ kind: 'wrap', path: [], bundleId: 'context', slot: 'task', repeat, params: { instruction: 'Follow this nested instruction.' } }] })) },
  ]
  plan.coverage = [{ dimension: 'axis:number', minimum: 1 }, { dimension: 'axis:depth', minimum: 1 }]
  return plan
}

test('nested corpus recipes reproduce task identities, exact choices and complete candidate ledgers', async () => {
  const plan = recipe(), catalog = genericStarter().catalog
  const result = await generateCorpus(plan, catalog)
  assert.deepEqual(await generateCorpus(plan, catalog), result)
  assert.equal(result.tasks.length, 4); assert.equal(result.manifest.candidateCount, 4)
  assert.equal(result.manifest.status, 'ready')
  assert.ok(result.manifest.coverage.every(cell => cell.selected === 2))
  assert.ok(result.tasks.every(task => task.familyId === 'addition-family' && task.split === 'development'))
  assert.equal(result.tasks.find(task => task.factors.number === 'n-4' && task.factors.depth === 'depth-2').root.slots.task.slots.task.slots.task.params.a, 4)
  const spec = genericStarter(); spec.corpusPlan = plan; spec.tasks = result.tasks
  const project = await freezeStudy(spec)
  assert.equal(project.tasks.filter(task => task.compiled.depth === 3).length, 2)
  assert.equal(project.corpus.sha256, result.manifestSha256)
  await verifyProject(project)
})

test('constraints preserve excluded candidates and balanced selection reports its actual quotas', async () => {
  const plan = recipe()
  plan.families[0].constraints = [{ id: 'exclude-one-pair', when: { number: ['n-4'], depth: ['depth-2'] }, reason: 'Declared compatibility control.' }]
  plan.selection = { kind: 'balanced', limit: 2 }
  const result = await generateCorpus(plan, genericStarter().catalog)
  assert.equal(result.tasks.length, 2)
  assert.equal(result.manifest.status, 'ready')
  assert.ok(result.manifest.coverage.every(cell => cell.selected >= cell.minimum))
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'constraint-excluded').length, 1)
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'sample-excluded').length, 1)
  assert.equal(result.manifest.candidates.find(row => row.disposition === 'constraint-excluded').reasons[0].constraintId, 'exclude-one-pair')
  plan.selection.limit = 1
  const insufficient = await generateCorpus(plan, genericStarter().catalog)
  assert.equal(insufficient.manifest.status, 'coverage-unmet')
  assert.ok(insufficient.manifest.unmetCoverage.length > 0)
  const spec = genericStarter(); spec.corpusPlan = plan; spec.tasks = insufficient.tasks
  await assert.rejects(freezeStudy(spec), /coverage-unmet/)
})

test('an entirely excluded level remains visible as unavailable coverage', async () => {
  const plan = recipe()
  plan.families[0].constraints = [{ id: 'exclude-number', when: { number: ['n-4'] }, reason: 'Excluded for this control.' }]
  const { manifest } = await generateCorpus(plan, genericStarter().catalog)
  assert.equal(manifest.status, 'coverage-unmet')
  assert.deepEqual(manifest.unmetCoverage.map(row => [row.dimension, row.value, row.available, row.selected]), [['axis:number', 'n-4', 0, 0]])
})

test('construction failures and duplicate constructions have explicit ledger entries', async () => {
  const plan = recipe(); plan.coverage = []
  plan.families[0].axes[0].choices.push({ id: 'duplicate', edits: [] })
  plan.families[0].axes[0].choices.push({ id: 'bad-path', edits: [{ kind: 'parameter', path: ['missing'], name: 'a', value: 2 }] })
  const result = await generateCorpus(plan, genericStarter().catalog)
  assert.equal(result.manifest.candidateCount, 8)
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'construction-excluded').length, 2)
  // Explicit a=2 and the atom's implicit default are semantically identical.
  // Canonical aliases are excluded before sampling, with their own evidence.
  const spec = genericStarter(); spec.corpusPlan = plan; spec.tasks = result.tasks
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'duplicate-excluded').length, 2)
  await freezeStudy(spec)
  plan.families[0].axes[0].choices[2].edits = structuredClone(plan.families[0].axes[0].choices[0].edits)
  const duplicate = await generateCorpus(plan, genericStarter().catalog)
  assert.equal(duplicate.manifest.candidates.filter(row => row.disposition === 'duplicate-excluded').length, 2)
})

test('task mutations cannot retain a corpus recipe attribution', async () => {
  const spec = genericStarter(); spec.corpusPlan = recipe(); spec.tasks = (await materializeCorpus(spec)).tasks
  spec.tasks[0].expected = 'altered'
  await assert.rejects(freezeStudy(spec), /tasks differ from their task recipe/)
})

test('sampling changes selection without changing stable identities of the candidates', async () => {
  const plan = recipe(); plan.coverage = []; plan.selection = { kind: 'seeded', limit: 2 }
  const first = await generateCorpus(plan, genericStarter().catalog)
  plan.seed = 873
  const second = await generateCorpus(plan, genericStarter().catalog)
  assert.deepEqual(first.manifest.candidates.map(row => row.taskId), second.manifest.candidates.map(row => row.taskId))
  assert.notEqual(first.manifest.recipeSha256, second.manifest.recipeSha256)
  assert.equal(second.tasks.length, 2)
})

test('canonical eligibility precedes sampling and recipe typos cannot silently become ignored constraints', async () => {
  const spec = genericStarter(); spec.corpusPlan = recipe(); spec.corpusPlan.selection = { kind: 'seeded', limit: 1 }; spec.corpusPlan.coverage = []
  spec.catalog.find(bundle => bundle.id === 'task').parameterSchema = { a: { type: 'integer', maximum: 3 }, b: { type: 'integer' } }
  const generated = await materializeCorpus(spec)
  assert.equal(generated.manifest.candidates.filter(row => row.disposition === 'construction-excluded').length, 2)
  assert.ok(generated.tasks.every(task => task.factors.number === 'n-2'))
  spec.corpusPlan.selection.stratify = 'undeclared behavior'
  await assert.rejects(materializeCorpus(spec), /Selection policy contains an unsupported field/)
})

test('LEAN recipes use the shared semantic oracle and require its current human reviews at freeze', async () => {
  const spec = leanStarter(); spec.corpusPlan = corpusPlanFromTask(spec.tasks[0])
  spec.corpusPlan.families[0].axes = [{ id: 'shares', choices: [1, 3].map(value => ({ id: `shares-${value}`, edits: [{ kind: 'parameter', path: ['strategy', 'buy_process'], name: 'quantity', value }] })) }]
  const result = await materializeCorpus(spec); spec.tasks = result.tasks
  assert.deepEqual(spec.tasks.map(task => task.expected.map(fill => fill.quantity)), [[1, -1], [3, -3]])
  assert.equal(result.manifest.oracle.independentQualificationRequired, true)
  await assert.rejects(freezeStudy(spec), /needs review/)
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC CORPUS FIXTURE ONLY')))
  const project = await freezeStudy(spec)
  assert.equal(project.tasks.length, 2)
  assert.equal(project.corpus.manifest.selectedCount, 2)
})

test('fresh standalone export reconstructs the corpus and retains its source recipe', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'canonical-corpus-')); t.after(() => rm(root, { recursive: true, force: true }))
  const spec = genericStarter(); spec.corpusPlan = recipe(); spec.tasks = (await materializeCorpus(spec)).tasks
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
  for (const command of ['verify', 'run']) {
    const output = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(output.status, 0, output.stderr)
  }
  assert.equal(canonical(JSON.parse(await readFile(resolve(root, 'corpus/recipe.json'), 'utf8'))), canonical(spec.corpusPlan))
  assert.equal(JSON.parse(await readFile(resolve(root, 'corpus/manifest.json'), 'utf8')).sha256, project.corpus.sha256)
  assert.equal(JSON.parse(await readFile(resolve(root, 'results/summary.json'), 'utf8')).completed, 4)
})

test('pairwise sampling covers every pair across three binary factors where marginal coverage misses pairs', async () => {
  const spec = await coverageFixture(), result = await materializeCorpus(spec)
  assert.equal(result.manifest.status, 'ready'); assert.equal(result.tasks.length, 4)
  assert.deepEqual(await materializeCorpus(spec), result)
  for (const [first, second] of [['number', 'wording'], ['number', 'depth'], ['wording', 'depth']]) {
    assert.equal(new Set(result.tasks.map(task => task.factors[first] + '/' + task.factors[second])).size, 4)
  }
  const marginal = structuredClone(spec)
  marginal.corpusPlan.coverage = ['number', 'wording', 'depth'].map(axis => ({ dimension: 'axis:' + axis, minimum: 1 }))
  marginal.corpusPlan.selection.limit = 2
  const smaller = await materializeCorpus(marginal)
  assert.equal(smaller.manifest.status, 'ready')
  assert.equal(new Set(smaller.tasks.map(task => task.factors.number + '/' + task.factors.wording)).size, 2)
  spec.corpusPlan.selection.limit = 3
  const incomplete = await materializeCorpus(spec); spec.tasks = incomplete.tasks
  assert.equal(incomplete.manifest.status, 'coverage-unmet')
  await assert.rejects(freezeStudy(spec), /coverage-unmet/)
})

test('joint universes retain impossible pairs, exclusions and absent dimensions across heterogeneous families', async () => {
  const spec = await coverageFixture(), plan = spec.corpusPlan
  plan.selection.limit = 8; plan.coverage = [{ dimensions: ['axis:number', 'axis:wording'], minimum: 1 }]
  plan.families[0].constraints = [{ id: 'forbid-red-four', when: { number: ['n-4'], wording: ['red'] }, reason: 'Synthetic incompatibility.' }]
  let result = await materializeCorpus(spec)
  assert.equal(result.manifest.status, 'coverage-unmet')
  const missing = result.manifest.unmetCoverage[0]
  assert.deepEqual(missing.values, { 'axis:number': 'n-4', 'axis:wording': 'red' })
  assert.equal(missing.available, 0); assert.equal(missing.candidates, 2); assert.deepEqual(missing.excluded, { 'constraint-excluded': 2 })
  plan.families = ['number', 'wording'].map(name => ({ ...structuredClone(plan.families[0]), id: name + '-family', axes: [plan.families[0].axes.find(axis => axis.id === name)], constraints: [] }))
  result = await materializeCorpus(spec)
  assert.equal(result.manifest.coverage.length, 4)
  assert.ok(result.manifest.coverage.every(cell => cell.available === 0 && cell.candidates === 0))
  assert.equal(result.manifest.coverageDefinition.rules[0].unclassifiedCandidates, 4)
  assert.equal(result.manifest.status, 'coverage-unmet')
})

test('composition depth and bundle groups use canonical nodes, exclude dependencies, and count each candidate once', async () => {
  const spec = await coverageFixture(), plan = spec.corpusPlan
  spec.catalog.push({ ...structuredClone(spec.catalog.find(row => row.id === 'task')), id: 'provenance-only' })
  spec.catalog.find(row => row.id === 'task').dependencies = ['provenance-only']
  plan.features.push({ id: 'dependency', bundles: ['provenance-only'], rationale: 'A dependency is not an AST occurrence.' })
  plan.coverage.push({ dimension: 'feature:dependency', levels: { 'feature:dependency': ['absent'] }, minimum: 4 }, { dimension: 'composition-nodes', minimum: 1 })
  const result = await materializeCorpus(spec); spec.tasks = result.tasks
  const project = await freezeStudy(spec)
  for (const task of project.tasks) {
    const row = result.manifest.candidates.find(row => row.taskId === task.id)
    assert.equal(row.composition.depth, task.compiled.depth); assert.equal(row.composition.nodes, task.compiled.nodeCount)
    assert.equal(row.composition.features.dependency, 'absent')
    assert.equal(row.composition.features['outer-wrapper'], task.factors.depth === 'd-2' ? 'present' : 'absent')
  }
  const wrappers = result.manifest.coverage.find(row => row.dimension === 'feature:outer-wrapper' && row.value === 'present')
  assert.equal(wrappers.available, 4); assert.equal(wrappers.selected, 2) // Two repeated wrappers do not double-count tasks.
  plan.coverage.push({ dimensions: ['composition-depth', 'feature:outer-wrapper'], minimum: 1 })
  const coupled = await materializeCorpus(spec)
  assert.equal(coupled.manifest.unmetCoverage.length, 2) // depth 1/present and depth 3/absent are impossible.
  plan.coverage.pop()
  for (const [depth, presence] of [['1', 'absent'], ['3', 'present']]) plan.coverage.push({ dimensions: ['composition-depth', 'feature:outer-wrapper'],
    levels: { 'composition-depth': [depth], 'feature:outer-wrapper': [presence] }, minimum: 1 })
  assert.equal((await materializeCorpus(spec)).manifest.status, 'ready') // Disjoint justified scopes can request only meaningful combinations.
  plan.coverage.at(-1).levels['composition-depth'].push('1'); plan.coverage.at(-1).levels['feature:outer-wrapper'].push('absent')
  await assert.rejects(materializeCorpus(spec), /rules overlap/)
})

test('explicit levels retain unconstructed depths and count out-of-scope and failed candidates honestly', async () => {
  const spec = await coverageFixture(), plan = spec.corpusPlan
  plan.coverage = [{ dimension: 'composition-depth', levels: { 'composition-depth': ['3', '9'] }, minimum: 1 }]
  plan.families[0].axes[0].choices.push({ id: 'broken', edits: [{ kind: 'parameter', path: ['missing'], name: 'a', value: 1 }] })
  const result = await materializeCorpus(spec), rule = result.manifest.coverageDefinition.rules[0]
  assert.equal(rule.unclassifiedCandidates, 4); assert.equal(rule.outsideDeclaredLevels, 4)
  assert.deepEqual(result.manifest.unmetCoverage.map(row => [row.value, row.available, row.selected]), [['9', 0, 0]])
  plan.families[0].constraints = [{ id: 'exclude-all', when: { number: ['n-2', 'n-4', 'broken'] }, reason: 'Empty control.' }]
  const empty = await materializeCorpus(spec)
  assert.equal(empty.manifest.status, 'empty'); assert.equal(empty.manifest.coverage.length, 2)
  delete plan.coverage[0].levels
  await assert.rejects(materializeCorpus(spec), /no compiled levels/)
})

test('joint coverage rejects ambiguous schemas, unknown classifications and unbounded cell products', async () => {
  const base = await coverageFixture()
  const mutations = [
    plan => { plan.features = null },
    plan => { plan.features[0].bundles = ['unknown-bundle'] },
    plan => { plan.coverage[0].dimension = 'family' },
    plan => { plan.coverage[0].dimensions = ['family'] },
    plan => { plan.coverage[0].dimensions = ['family', 'family'] },
    plan => { plan.coverage.push({ dimensions: [...plan.coverage[0].dimensions].reverse(), minimum: 1 }) },
    plan => { plan.coverage[0].levels = { 'axis:number': ['undeclared'] } },
    plan => { plan.coverage[0].levels = { 'axis:unknown': ['x'] } },
    plan => { plan.coverage[0] = { dimension: 'composition-depth', levels: { 'composition-depth': ['03'] }, minimum: 1 } },
    plan => { plan.coverage[0] = { dimension: 'feature:outer-wrapper', levels: { 'feature:outer-wrapper': ['yes'] }, minimum: 1 } },
    plan => { plan.coverage = Array.from({ length: 129 }, () => ({ dimension: 'family', minimum: 1 })) },
  ]
  for (const mutate of mutations) { const spec = structuredClone(base); mutate(spec.corpusPlan); await assert.rejects(materializeCorpus(spec)) }
  base.corpusPlan.coverage = [{ dimensions: ['composition-depth', 'composition-nodes', 'feature:outer-wrapper', 'feature:arithmetic'],
    levels: { 'composition-depth': Array.from({ length: 100 }, (_, i) => String(i)), 'composition-nodes': Array.from({ length: 100 }, (_, i) => String(i + 1)) }, minimum: 1 }]
  await assert.rejects(materializeCorpus(base), /16384-cell budget/)
})

test('duplicate aliases cannot supply joint quotas and frozen feature assignments cannot be forged', async () => {
  const spec = await coverageFixture(), plan = spec.corpusPlan
  plan.families[0].axes[0].choices.push({ ...structuredClone(plan.families[0].axes[0].choices[0]), id: 'alias' })
  plan.coverage = [{ dimensions: ['axis:number', 'axis:depth'], minimum: 1 }]
  const result = await materializeCorpus(spec)
  assert.equal(result.manifest.unmetCoverage.length, 2)
  assert.ok(result.manifest.unmetCoverage.every(row => row.excluded['duplicate-excluded'] === 2 && row.available === 0))
  const clean = await coverageFixture(), project = await freezeStudy(clean)
  project.corpus.manifest.candidates.find(row => row.composition).composition.depth = 999
  await assert.rejects(verifyProject(project))
})

test('standalone joint corpus verification reconstructs portable artifacts and refuses omitted or rehashed false ledgers', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'canonical-joint-corpus-')); t.after(() => rm(root, { recursive: true, force: true }))
  const spec = await coverageFixture()
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(project, sources)
  for (const [file, contents] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), contents) }
  const run = command => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command], { cwd: tmpdir(), encoding: 'utf8' })
  for (const command of ['verify', 'run', 'analyze']) { const output = run(command); assert.equal(output.status, 0, output.stderr) }
  assert.equal(JSON.parse(await readFile(resolve(root, 'results/summary.json'), 'utf8')).completed, 4)
  const report = await readFile(resolve(root, 'results/report.md'), 'utf8')
  assert.match(report, /Cartesian product/); assert.match(report, /not activation/)
  for (const file of ['corpus/recipe.json', 'corpus/manifest.json']) {
    const manifest = JSON.parse(files['manifest.json']); delete manifest.files[file]
    await writeFile(resolve(root, 'manifest.json'), canonical(manifest))
    let output = run('verify'); assert.notEqual(output.status, 0); assert.match(output.stderr, /omits a corpus artifact/)
    const falseBytes = '{}\n'; manifest.files[file] = await sha256(falseBytes)
    await writeFile(resolve(root, file), falseBytes); await writeFile(resolve(root, 'manifest.json'), canonical(manifest))
    output = run('verify'); assert.notEqual(output.status, 0); assert.match(output.stderr, /Generated corpus artifact changed/)
    await writeFile(resolve(root, file), files[file]); await writeFile(resolve(root, 'manifest.json'), files['manifest.json'])
  }
  assert.equal(run('verify').status, 0)
})
