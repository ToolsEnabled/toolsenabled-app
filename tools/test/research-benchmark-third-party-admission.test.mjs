// Can a benchmark ToolsEnabled did not write get all the way through the core?
//
// research-benchmark-registry.test.mjs proves the registry ROUTES to a third
// party. This suite asks the harder question end to end, and it asks it with a
// plugin that lives OUTSIDE src/: tools/test/fixtures/
// research-benchmark-third-party-plugin.mjs. That fixture is not listed in
// plugins.mjs, is not in RUNTIME_FILES, and nothing under src/benchmark/
// contains the strings `sql-bench` or `sql-compare`. If the core ever has to
// learn one of those names, these tests are what notices.
//
// The domain is deliberately NEITHER of the two the core used to allowlist. It
// is not `lean-bench`, so it inherits none of the vertical's branches, and it
// is not `generic`, so it inherits none of the core's own domain's affordances.
//
// Everything here asserts BEHAVIOUR by calling with values: freeze it, export
// it, read the profile the core derived, run it. The final test is the control
// -- take the registration away and the identical study must be refused -- so a
// green here cannot be a study that would have been admitted anyway.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, validateStudy } from '../../src/benchmark/study.mjs'
import { newExperimentDraft, genericStarter } from '../../src/benchmark/starters.mjs'
import { projectFiles, zipFiles } from '../../src/benchmark/export.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { informationFieldInventory } from '../../src/research-information-fields.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { extractSource, sourceFailureClassification, SOURCE_FORMAT_VIOLATION } from '../../src/benchmark/extraction.mjs'
import { benchmarkFor, extractionPolicyFor, gradingKind, registerBenchmark, registeredBenchmarks, registeredStarters, resetRegistry } from '../../src/benchmark/registry.mjs'
import '../../src/benchmark/plugins.mjs'
import { SQL_DOMAIN, SQL_BENCHMARK_ID, SQL_DESCRIPTOR, SQL_EXTRACTION_POLICY, SQL_FENCED_REPLY, registerSqlBench, sqlBenchDraft } from './fixtures/research-benchmark-third-party-plugin.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))

// The registry is process-wide. Capture what the build ships PLUS the fixture,
// once at load, so every test starts from the same set whatever order they run
// in and whatever a test did to the registry before it.
const LOADED = registeredBenchmarks()
function restoreLoaded() {
  resetRegistry()
  for (const entry of LOADED) registerBenchmark(entry)
}
async function withRegistry(body) {
  restoreLoaded()
  try { return await body() } finally { restoreLoaded() }
}

function sqlStudy() {
  return sqlBenchDraft(newExperimentDraft(genericStarter(), { initializePopulation: true }))
}
const freeze = async study => freezeStudy(await bindRuntimeSources(study, sources))

test('the fixture plugin registered itself by being imported, exactly as lean-plugin.mjs does', () => {
  const ids = registeredBenchmarks().map(entry => entry.id)
  assert.ok(ids.includes(SQL_BENCHMARK_ID), 'importing a plugin module registers its benchmark')
  assert.ok(ids.includes('lean-bench'), 'and it did not displace the benchmark this tree ships')
  assert.equal(benchmarkFor({ domain: SQL_DOMAIN }).id, SQL_BENCHMARK_ID)
  assert.equal(benchmarkFor({ domain: 'lean-bench' }).id, 'lean-bench')
  assert.equal(registeredStarters().some(starter => starter.id === 'sql-basic'), true,
    'and the page can offer it without the page being edited')
})

test('no core module knows this benchmark by name', async () => {
  const named = []
  for (const [file, text] of Object.entries(sources)) {
    if (/sql-bench|sql-compare|sqlDialect/.test(text)) named.push(file)
  }
  assert.deepEqual(named, [], 'a core module naming the third-party benchmark means the seam regressed')
})

test('freezeStudy admits a domain no core module has heard of', async () => {
  const project = await freeze(sqlStudy())
  assert.equal(project.spec.domain, SQL_DOMAIN)
  assert.equal(project.spec.protocol.grading.kind, 'exact', 'it froze under a core grading contract it did not have to declare')
  assert.ok(project.schedule.length > 0, 'the study froze a real schedule, not an empty one')
  assert.equal(project.tasks.length, 2)
})

test('readiness gives it the third-party-declared-endpoint profile, and no ToolsEnabled admission', async () => {
  const project = await freeze(sqlStudy())
  const profile = project.readiness.profile
  assert.equal(profile.id, 'third-party-declared-endpoint')
  assert.match(profile.scope, /no ToolsEnabled scientific-validity admission is claimed/)
  // The line the owner drew: it runs, and it does not inherit the claim.
  assert.notEqual(profile.id, 'generic-interpreted-answer')
  assert.notEqual(profile.id, 'lean-semantic-answer')
  assert.deepEqual(project.readiness.scientificBlockers ?? [], [])
  assert.ok(project.readiness.requiredProofs.some(proof => proof.kind === 'third-party-declared-apparatus'),
    'the contract records that the registering benchmark, not ToolsEnabled, qualifies its apparatus')
})

test('the benchmark own grading contract freezes, and its own precondition refuses', async () => {
  const study = sqlStudy()
  study.protocol = { ...study.protocol, grading: { kind: 'sql-compare' } }
  const project = await freeze(study)
  assert.equal(project.spec.protocol.grading.kind, 'sql-compare')
  assert.equal(project.readiness.profile.id, 'third-party-declared-endpoint')
  assert.equal(gradingKind('sql-compare').benchmarkId, SQL_BENCHMARK_ID)
  // assertReady belongs to whoever implemented the contract, and it bites.
  const missing = sqlStudy()
  missing.protocol = { ...missing.protocol, grading: { kind: 'sql-compare' } }
  delete missing.environment.sqlDialect
  assert.throws(() => validateStudy(missing), /Declare environment\.sqlDialect/)
})

test('exporting a third-party project succeeds and produces a readable archive', async () => {
  const project = await freeze(sqlStudy())
  const files = await projectFiles(project, sources)
  for (const name of ['project.json', 'specification.json', 'README.md', 'package.json', 'readiness/contract.json']) {
    assert.ok(typeof files[name] === 'string' && files[name].length > 0, `the export is missing ${name}`)
  }
  // The vertical's extra files are a descriptor capability. This benchmark
  // declares no projectFiles, so none of Lean's appear in its archive.
  assert.equal(Object.keys(files).some(name => name.startsWith('lean-bench/')), false)
  const spec = JSON.parse(files['specification.json'])
  assert.equal(spec.domain ?? JSON.parse(files['project.json']).spec.domain, SQL_DOMAIN)
  assert.match(files['readiness/contract.json'], /third-party-declared-endpoint/)
  assert.match(files['readiness/contract.json'], /no ToolsEnabled scientific-validity admission is claimed/)
  const zip = zipFiles(files)
  assert.ok(zip.length > 0, 'the archive bytes were produced')
})

test('the study is graded by the plugin own extraction policy, not Lean Bench own', async () => {
  const project = await freeze(sqlStudy())
  assert.equal(extractionPolicyFor(project.spec).language, 'sql')
  assert.equal(extractionPolicyFor(project.spec).pick, 'last')
  assert.equal(extractSource(SQL_FENCED_REPLY, extractionPolicyFor(project.spec)), 'SELECT COUNT(*) FROM orders;')
  // The same reply under Lean Bench's frozen policy is a format violation.
  assert.throws(() => extractSource(SQL_FENCED_REPLY, extractionPolicyFor({ domain: 'lean-bench' })),
    error => sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
  const result = await runStudy(project, { now: () => 1700000000000 })
  assert.equal(result.summary.completed, project.schedule.length)
  assert.ok(result.summary.completed > 0)
})

// AN INFORMATION TREATMENT IS A REGISTRATION TOO. tasks.mjs carried
// ['exact', 'json', 'lean-python'] as a literal, so a benchmark's own grading
// contract was refused here whatever else the core had been opened up -- the
// same allowlist class as the four domain lists, with a vertical's own contract
// inside it. Whether a contract can carry an information treatment now belongs
// to whoever implemented the contract.
const infoTreatment = () => ({
  version: 1, scope: 'declared-set', responseMode: 'raw',
  rationale: 'Synthetic third-party admission apparatus; the question wording is the withheld information.',
  withheldPaths: ['root'],
  readings: [{ id: 'literal', root: { use: 'ask' }, expected: 'SELECT COUNT(*) FROM orders;', rationale: 'The only admissible reading.' }],
})
function informationStudy() {
  const study = sqlStudy()
  study.tasks[0].familyId = 'counts'
  study.tasks[0].information = infoTreatment()
  study.protocol = { ...study.protocol, grading: { kind: 'sql-compare' } }
  return study
}

test('a contract that does not declare supportsInformation still refuses an information treatment', async () => {
  const study = informationStudy()
  await assert.rejects(() => compileTask(study, study.tasks[0], { requireReview: false, requireTaskReview: false }),
    /Information treatments require exact or JSON grading/)
})

test('a contract that declares supportsInformation carries one, and Lean Bench own still does', async () => {
  await withRegistry(async () => {
    resetRegistry()
    for (const entry of LOADED) if (entry.id !== SQL_BENCHMARK_ID) registerBenchmark(entry)
    // The identical descriptor, with the one field added.
    registerBenchmark({ ...SQL_DESCRIPTOR, gradingKinds: [{ ...SQL_DESCRIPTOR.gradingKinds[0], supportsInformation: true }] })
    const study = informationStudy()
    const compiled = await compileTask(study, study.tasks[0], { requireReview: false, requireTaskReview: false })
    assert.equal(compiled.interpretations.length, 1, 'the treatment compiled its declared reading')
  })
  // Unchanged for the contract this tree ships: lean-python still carries one.
  assert.equal(gradingKind('lean-python').supportsInformation, true)
  // And a core contract that never could still cannot.
  assert.equal(gradingKind('judge-audit').supportsInformation, undefined)
})

// THE SAME ALLOWLIST ONE LAYER UP. The page's information-field editor carried
// its own ['exact', 'json', 'lean-python'] literal, and it compiles through
// compileTask -- so the page refusing what the compiler admits is the two
// disagreeing, not a second opinion.
test('the page information-field editor asks the registry the same question the compiler does', async () => {
  const study = informationStudy()
  await assert.rejects(() => informationFieldInventory(study, 'count-orders'),
    /registered grading contract that declares it can carry an information treatment/)
  await withRegistry(async () => {
    resetRegistry()
    for (const entry of LOADED) if (entry.id !== SQL_BENCHMARK_ID) registerBenchmark(entry)
    registerBenchmark({ ...SQL_DESCRIPTOR, gradingKinds: [{ ...SQL_DESCRIPTOR.gradingKinds[0], supportsInformation: true }] })
    const inventory = await informationFieldInventory(study, 'count-orders')
    assert.equal(inventory.domain, SQL_DOMAIN, 'the editor authored fields for a domain no core module knows')
  })
})

// A CONTRACT WITH NO CONFIGURATION IS BARELY A CONTRACT. study.mjs spelled the
// per-contract field list as `kind === 'lean-python' ? ['executionTimeoutMs']`,
// so a third-party contract could declare nothing but `kind`: every other field
// came back as an unsupported field on the grading contract.
test('a grading contract may declare its own protocol.grading fields, and only those', async () => {
  const configured = sqlStudy()
  configured.protocol = { ...configured.protocol, grading: { kind: 'sql-compare', normalise: 'whitespace' } }
  assert.throws(() => validateStudy(configured), /Grading contract contains unsupported fields: normalise/)
  await withRegistry(async () => {
    resetRegistry()
    for (const entry of LOADED) if (entry.id !== SQL_BENCHMARK_ID) registerBenchmark(entry)
    registerBenchmark({ ...SQL_DESCRIPTOR, gradingKinds: [{ ...SQL_DESCRIPTOR.gradingKinds[0], fields: ['normalise'] }] })
    validateStudy(configured)
    // Declaring one field does not open the rest.
    const other = sqlStudy()
    other.protocol = { ...other.protocol, grading: { kind: 'sql-compare', normalise: 'whitespace', dialect: 'ansi' } }
    assert.throws(() => validateStudy(other), /unsupported fields: dialect/)
  })
  // Unchanged for the contract this tree already had. The field check lives in
  // the modern-schema branch, so this uses a schema-2-or-later Lean study; the
  // legacy starter never reaches it, which is why it is not the fixture here.
  assert.deepEqual(gradingKind('lean-python').fields, ['executionTimeoutMs'])
  const leanStudy = () => {
    const lean = developmentDraft(leanStarter())
    lean.environment = { ...lean.environment, leanImage: 'quantconnect/lean@sha256:' + 'a'.repeat(64) }
    lean.protocol = { ...lean.protocol, timeoutMs: 150000 }
    return lean
  }
  const allowed = leanStudy()
  allowed.protocol = { ...allowed.protocol, grading: { kind: 'lean-python', executionTimeoutMs: 60000 } }
  validateStudy(allowed)
  const extra = leanStudy()
  extra.protocol = { ...extra.protocol, grading: { kind: 'lean-python', executionTimeoutMs: 60000, retries: 2 } }
  assert.throws(() => validateStudy(extra), /unsupported fields: retries/)
})

// A declaration the registry cannot check is a declaration nobody can rely on.
test('the registry refuses environment and information declarations it could not honour', async () => {
  await withRegistry(async () => {
    const base = { id: 'bad-bench', label: 'Bad', domains: ['bad-domain'], matches: () => false }
    assert.throws(() => registerBenchmark({ ...base, environmentKeys: 'sqlDialect' }), /environmentKeys as an array/)
    assert.throws(() => registerBenchmark({ ...base, environmentKeys: ['sqlDialect', ''] }), /environmentKeys as an array/)
    // A benchmark cannot claim a key the core already owns and change its meaning.
    assert.throws(() => registerBenchmark({ ...base, environmentKeys: ['python'] }), /none of which may be a core key/)
    assert.throws(() => registerBenchmark({ ...base, gradingKinds: [{ value: 'x', title: 'X', label: 'X', supportsInformation: 'yes' }] }),
      /supportsInformation as a boolean/)
    assert.throws(() => registerBenchmark({ ...base, gradingKinds: [{ value: 'x', title: 'X', label: 'X', fields: 'normalise' }] }),
      /fields as an array/)
    // A contract cannot claim `kind` itself and shadow the core's own field.
    assert.throws(() => registerBenchmark({ ...base, gradingKinds: [{ value: 'x', title: 'X', label: 'X', fields: ['kind'] }] }),
      /never "kind"/)
  })
})

// QUALIFICATION INTERPRETERS. study.mjs wrote `spec.domain === 'generic'` where
// it meant "no benchmark supplies this domain's semantics", which refused every
// third-party domain -- while readiness records `third-party-declared-apparatus`
// against that same study, asking the benchmark to qualify its own interpreter.
const interpreterPlan = () => ({
  version: 1,
  targets: [{ id: 'rows', taskId: 'count-orders', requirementId: 'a count query returns exactly one row',
    rationale: 'Synthetic third-party interpreter apparatus.',
    activation: [{ kind: 'counter', name: 'rows', minimum: 1 }],
    probes: [{ id: 'p1', input: null, assertions: [{ path: ['observation'], equals: null }] }],
    wrongReadings: [] }],
  interpreters: { reference: 'ref.mjs', independent: 'ind.mjs', rationale: 'The registering benchmark qualifies its own interpreter pair.' },
})
const INTERPRETER_INPUTS = [{ path: 'ref.mjs', sha256: 'a'.repeat(64) }, { path: 'ind.mjs', sha256: 'b'.repeat(64) }]

test('a third party may declare its own qualification interpreters; the benchmark that ships an oracle may not', () => {
  const study = sqlStudy()
  study.requirementPlan = interpreterPlan()
  study.inputs = INTERPRETER_INPUTS
  validateStudy(study)
  // Unchanged where the rule was actually aimed: Lean Bench supplies its own
  // oracle, so a module pair cannot replace it, and the refusal now says whose.
  const lean = leanStarter()
  lean.requirementPlan = interpreterPlan()
  lean.requirementPlan.targets[0].taskId = lean.tasks[0].id
  lean.inputs = [...(lean.inputs || []), ...INTERPRETER_INPUTS]
  assert.throws(() => validateStudy(lean), /Lean Bench supplies for this domain/)
})

// THE CONTROL. Everything above is only evidence if the same study is refused
// when the plugin is not registered. Without this, a green suite could mean the
// core admits anything.
test('without the plugin registered, the identical study is refused at freeze', async () => {
  await withRegistry(async () => {
    resetRegistry()
    // Only the benchmarks this build ships, minus the fixture.
    for (const entry of LOADED) if (entry.id !== SQL_BENCHMARK_ID) registerBenchmark(entry)
    assert.equal(benchmarkFor({ domain: SQL_DOMAIN })?.id, 'lean-bench',
      'with the plugin gone the domain falls to the shipped fallback, which does not own it')
    await assert.rejects(() => freeze(sqlStudy()), /registered benchmark domain/)
    assert.throws(() => validateStudy(sqlStudy()), /registered benchmark domain/)
    // And its grading contract is gone with it: the core never knew 'sql-compare'.
    assert.equal(gradingKind('sql-compare'), null)
    const study = sqlStudy()
    study.protocol = { ...study.protocol, grading: { kind: 'sql-compare' } }
    study.domain = 'generic'
    assert.throws(() => validateStudy(study), /supported built-in or custom grading contract/)
    // Extraction falls back to the core default, which is not the SQL policy.
    assert.notEqual(extractionPolicyFor({ domain: SQL_DOMAIN }).language, 'sql')
    // Put the registration back and the identical study freezes again, so the
    // refusal was the missing registration and nothing else about the study.
    registerSqlBench()
    const project = await freeze(sqlStudy())
    assert.equal(project.readiness.profile.id, 'third-party-declared-endpoint')
    assert.equal(extractionPolicyFor(project.spec), SQL_EXTRACTION_POLICY)
  })
})
