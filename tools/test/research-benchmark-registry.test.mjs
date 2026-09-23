// ToolsEnabled ships one benchmark today. The question this suite answers is
// whether it can ship a second one that ToolsEnabled did not write.
//
// Before the registry, nine core modules imported the Lean/trading vertical
// directly, so a third party could not add a benchmark without editing
// ToolsEnabled's own compiler. These tests register a benchmark that exists
// only inside this file -- no core module knows its name, its language or its
// extraction rule -- and then check that the core honours it. Everything here
// goes through registerBenchmark and the declared extraction contract; if a
// future change makes a second benchmark need an edit to audit.mjs, tasks.mjs
// or any other compiler module, one of these tests stops passing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { declareExtractionPolicy, extractSource, extractionPolicyRecord, sourceFailureClassification, EXTRACTION_POLICY_VERSION, SOURCE_FORMAT_VIOLATION, SOURCE_NO_PROGRAM } from '../../src/benchmark/extraction.mjs'
import { benchmarkFor, declaresPageField, extractionPolicyFor, pageSurfaceForDomain, registerBenchmark, registeredBenchmarks, registeredStarters, resetRegistry, starterById, DEFAULT_EXTRACTION_POLICY } from '../../src/benchmark/registry.mjs'
import { readFile } from 'node:fs/promises'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy, validateStudy } from '../../src/benchmark/study.mjs'
import { newExperimentDraft, genericStarter } from '../../src/benchmark/starters.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import '../../src/benchmark/plugins.mjs'

const sqlSources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))

// A study in a domain no core module knows about. Everything here is ordinary
// study fields; nothing in src/benchmark/ mentions SQL.
function sqlStudy() {
  const draft = newExperimentDraft(genericStarter(), { initializePopulation: true })
  draft.id = 'sql-bench-study'; draft.name = 'SQL Bench'; draft.domain = 'sql-bench'
  draft.catalog = [
    { id: 'ask', version: '1', kind: 'atom', role: 'node', text: 'Write one SQL query that answers: {{question}}', parameters: { question: 'how many rows are in orders?' }, semantics: { kind: 'sql-ask', question: '{{question}}' } },
  ]
  draft.tasks = [
    { id: 'count-orders', root: { use: 'ask' }, input: null, expected: 'SELECT COUNT(*) FROM orders;', split: 'development' },
    { id: 'count-users', root: { use: 'ask', params: { question: 'how many rows are in users?' } }, input: null, expected: 'SELECT COUNT(*) FROM users;', split: 'held-out' },
  ]
  draft.conditions = [{ ...draft.conditions[0], adapter: { kind: 'replay', responses: {
    'count-orders': 'SELECT COUNT(*) FROM orders;', 'count-users': 'SELECT COUNT(*) FROM users;' } } }]
  return draft
}

async function withRegistryAsync(register) {
  restoreShipped()
  try { return await register() } finally { restoreShipped() }
}

// A benchmark ToolsEnabled does not ship: SQL answers, lenient about prose, and
// it takes the LAST fenced block rather than demanding the reply be one block.
const SQL_POLICY = declareExtractionPolicy({
  mode: 'fenced', language: 'sql', label: 'SQL', pick: 'last', prose: 'allow',
  note: 'Third-party benchmark: explain first, then give the final query.'
})

// The registry is process-wide, so a test that registers must put back exactly
// what it found. Capturing the shipped set once, at load, keeps each test
// independent of the order the others ran in.
const SHIPPED = registeredBenchmarks()
function restoreShipped() {
  resetRegistry()
  for (const entry of SHIPPED) registerBenchmark(entry)
}
function withRegistry(register) {
  restoreShipped()
  try { return register() } finally { restoreShipped() }
}

test('a third party registers a benchmark the core has never heard of, and the core routes to it', () => {
  const before = registeredBenchmarks().map(entry => entry.id)
  assert.ok(before.includes('lean-bench'), 'the reference plugin registers through the same door')
  withRegistry(() => {
    registerBenchmark({
      id: 'sql-bench', label: 'SQL Bench', matches: spec => spec?.domain === 'sql-bench', extraction: SQL_POLICY
    })
    const spec = { domain: 'sql-bench', name: 'a study ToolsEnabled did not write' }
    assert.equal(benchmarkFor(spec).id, 'sql-bench')
    assert.equal(extractionPolicyFor(spec).language, 'sql')
    // The shipped benchmark is untouched by the new arrival.
    assert.equal(benchmarkFor({ domain: 'lean' }).id, 'lean-bench')
  })
})

test('the registered policy actually governs extraction, so two benchmarks read the same reply differently', () => {
  const reply = 'First attempt:\n\n```sql\nSELECT 1;\n```\n\nBetter:\n\n```sql\nSELECT 2;\n```\n'
  // The third party asked for the last block and tolerates prose: it gets one.
  assert.equal(extractSource(reply, SQL_POLICY), 'SELECT 2;')
  // Lean Bench froze pick:'only' and prose:'refuse', so the same reply refuses.
  const lean = extractionPolicyFor({ domain: 'lean' })
  assert.equal(lean.pick, 'only')
  assert.throws(() => extractSource(reply, lean), error =>
    sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
})

test('pick and prose are honoured as declared, not as the codebase happens to behave', () => {
  const two = '```text\nalpha\n```\n\n```text\nbetavalue\n```'
  const base = { mode: 'fenced', language: 'text', prose: 'allow' }
  assert.equal(extractSource(two, declareExtractionPolicy({ ...base, pick: 'last' })), 'betavalue')
  assert.equal(extractSource(two, declareExtractionPolicy({ ...base, pick: 'largest' })), 'betavalue')
  const reversed = '```text\nbetavalue\n```\n\n```text\nalpha\n```'
  assert.equal(extractSource(reversed, declareExtractionPolicy({ ...base, pick: 'last' })), 'alpha')
  assert.equal(extractSource(reversed, declareExtractionPolicy({ ...base, pick: 'largest' })), 'betavalue')
  // prose:'refuse' rejects the very reply prose:'allow' accepts.
  const prosey = 'Here:\n```text\nalpha\n```'
  assert.equal(extractSource(prosey, declareExtractionPolicy({ ...base, pick: 'last' })), 'alpha')
  assert.throws(() => extractSource(prosey, declareExtractionPolicy({ ...base, pick: 'last', prose: 'refuse' })),
    error => sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
})

test('an envelope benchmark reads its declared field, and a raw one refuses a fence', () => {
  const envelope = declareExtractionPolicy({ mode: 'envelope', language: 'sql', label: 'SQL', field: 'query' })
  assert.equal(extractSource('{"query":"SELECT 1;","notes":"ignored"}', envelope), 'SELECT 1;')
  assert.throws(() => extractSource('{"notes":"no query here"}', envelope),
    error => sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
  const raw = declareExtractionPolicy({ mode: 'raw', language: 'text', label: 'text' })
  assert.equal(extractSource('just the answer', raw), 'just the answer')
  assert.throws(() => extractSource('```text\nfenced\n```', raw),
    error => sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
})

test('the taxonomy separates a wrong-shaped reply from no reply at all, for any benchmark', () => {
  const policy = declareExtractionPolicy({ mode: 'fenced', language: 'sql', label: 'SQL', pick: 'only' })
  let empty = null
  try { extractSource('', policy) } catch (error) { empty = error }
  assert.equal(sourceFailureClassification(empty), SOURCE_NO_PROGRAM)
  let shaped = null
  try { extractSource('prose\n```sql\nSELECT 1;\n```', policy) } catch (error) { shaped = error }
  assert.equal(sourceFailureClassification(shaped), SOURCE_FORMAT_VIOLATION)
})

test('the registry refuses the mistakes that would make a run unattributable', () => {
  withRegistry(() => {
    registerBenchmark({ id: 'sql-bench', matches: () => false, extraction: SQL_POLICY })
    assert.throws(() => registerBenchmark({ id: 'sql-bench', matches: () => false }), /already registered/)
    assert.throws(() => registerBenchmark({ id: 'second-fallback', matches: () => false, fallback: true }), /already holds it/)
    assert.throws(() => registerBenchmark({ id: 'no-matcher' }), /matches\(spec\)/)
    assert.throws(() => registerBenchmark({ id: 'bad-policy', matches: () => false, extraction: { version: 99 } }), /extraction policy version/)
  })
})

test('a declared policy is frozen, so a vertical cannot be edited into a different rule after freezing', () => {
  assert.throws(() => { SQL_POLICY.pick = 'only' }, TypeError)
  assert.equal(SQL_POLICY.pick, 'last')
})

// A policy has to survive being written down, because "declared and versioned"
// is worth nothing if the declaration cannot be recorded next to the result it
// produced. The record form is what a project would freeze: plain JSON, carrying
// the version, with the one field that cannot be serialized dropped by name.
test('a policy has a serializable record form that keeps its version and drops its function', () => {
  const record = extractionPolicyRecord(SQL_POLICY)
  assert.equal(record.version, EXTRACTION_POLICY_VERSION)
  assert.equal(record.pick, 'last')
  assert.equal(record.prose, 'allow')
  assert.equal(record.language, 'sql')
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record, 'the record must round-trip through JSON unchanged')
  const custom = declareExtractionPolicy({ mode: 'custom', language: 'text', label: 'text', extract: text => text, note: 'identity' })
  const customRecord = extractionPolicyRecord(custom)
  assert.equal('extract' in customRecord, false, 'a function cannot be frozen into a project')
  assert.equal(customRecord.note, 'identity', 'so the note is what identifies a custom policy')
  assert.deepEqual(JSON.parse(JSON.stringify(customRecord)), customRecord)
})

test('the core default names no vertical and no language of its own', () => {
  assert.equal(DEFAULT_EXTRACTION_POLICY.mode, 'raw')
  assert.equal(extractSource('the whole reply', DEFAULT_EXTRACTION_POLICY), 'the whole reply')
})

// The whole point of the seam: a benchmark ToolsEnabled did not write goes from
// registration to a completed run without a core module being edited. It also
// checks the line the owner drew -- such a study MAY RUN, and does NOT carry
// ToolsEnabled's scientific-validity admission.
test('a third-party benchmark registers, freezes, runs and is graded, with no core module edited', async () => {
  await withRegistryAsync(async () => {
    registerBenchmark({ id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench', extraction: SQL_POLICY })
    const project = await freezeStudy(await bindRuntimeSources(sqlStudy(), sqlSources))
    assert.equal(project.spec.domain, 'sql-bench')
    // It is admitted to run, under a profile that names what it is.
    assert.equal(project.readiness.profile.id, 'third-party-declared-endpoint')
    assert.match(project.readiness.profile.scope, /no ToolsEnabled scientific-validity admission is claimed/)
    assert.notEqual(project.readiness.profile.id, 'generic-interpreted-answer')
    assert.deepEqual(project.readiness.scientificBlockers ?? [], [])
    const result = await runStudy(project, { now: () => 1700000000000 })
    assert.equal(result.summary.completed, project.schedule.length)
    assert.ok(result.summary.completed > 0)
  })
})

test('a third-party study is graded by its own extraction policy, not Lean Bench\'s', () => {
  const reply = 'Reasoning first.\n\n```sql\nSELECT COUNT(*) FROM orders;\n```'
  assert.equal(extractSource(reply, SQL_POLICY), 'SELECT COUNT(*) FROM orders;')
  assert.throws(() => extractSource(reply, extractionPolicyFor({ domain: 'lean-bench' })),
    error => sourceFailureClassification(error) === SOURCE_FORMAT_VIOLATION)
})

/* THE PAGE LAYER. Everything above proves a third party can add a benchmark
   through code. These prove it is VISIBLE: the Research page's Starter list was
   four hardcoded <option> elements in a template string, two of them Lean Bench,
   and it is the only control on that page where a benchmark is chosen. A
   registered benchmark that cannot appear there is a capability nobody can see. */
test('a registered benchmark appears in the page starter list without editing the page', () => {
  withRegistry(() => {
    const before = registeredStarters().map(starter => starter.id)
    assert.deepEqual(before, ['lean-bench', 'lean-operational'], 'the reference plugin supplies its own starters')
    registerBenchmark({
      id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench',
      extraction: SQL_POLICY,
      starters: [{ id: 'sql-basic', label: 'SQL Bench: single-table queries', create: () => sqlStudy() }],
    })
    const listed = registeredStarters()
    const mine = listed.find(starter => starter.id === 'sql-basic')
    assert.ok(mine, 'a third-party starter is offered')
    assert.equal(mine.label, 'SQL Bench: single-table queries')
    assert.equal(mine.benchmarkLabel, 'SQL Bench', 'the page can say whose starter it is')
    assert.equal(starterById('sql-basic').benchmarkId, 'sql-bench')
    // Lean's entries are unchanged by the new arrival.
    assert.deepEqual(listed.filter(s => s.benchmarkId === 'lean-bench').map(s => s.id), ['lean-bench', 'lean-operational'])
  })
})

test('a starter is a thunk: listing them builds nothing', () => {
  withRegistry(() => {
    let built = 0
    registerBenchmark({
      id: 'counting-bench', label: 'Counting', domains: ['counting'], matches: () => false,
      starters: [{ id: 'counted', label: 'Counted starter', create: () => { built += 1; return sqlStudy() } }],
    })
    registeredStarters(); registeredStarters(); starterById('counted')
    assert.equal(built, 0, 'listing or looking up a starter must never build a draft')
    starterById('counted').create()
    assert.equal(built, 1, 'and choosing one builds it exactly once')
  })
})

test('the registry refuses a starter that would break the page list', () => {
  withRegistry(() => {
    const base = { id: 'bad-bench', matches: () => false }
    assert.throws(() => registerBenchmark({ ...base, starters: {} }), /starters as an array/)
    assert.throws(() => registerBenchmark({ ...base, starters: [{ label: 'x', create: () => ({}) }] }), /starter without an id/)
    assert.throws(() => registerBenchmark({ ...base, starters: [{ id: 'x', create: () => ({}) }] }), /label a person will read/)
    assert.throws(() => registerBenchmark({ ...base, starters: [{ id: 'x', label: 'X' }] }), /create\(\) so the draft is built when chosen/)
  })
})

// ---------------------------------------------------------------------------
// WHICH GRADING CONTRACTS EXIST IS A REGISTRATION TOO.
//
// study.mjs carried ['exact','json','module','lean-python','judge-audit',
// 'resource-action-plan'] as a literal, with one vertical's contract inside it,
// and bound that contract to that vertical's domain with a second literal. A
// third party declaring its own contract was refused at freeze before any of
// its code ran. Like the domain allowlist, this was data rather than an import,
// so no import inventory could see it.
const SQL_CONTRACT = { value: 'sql-compare', title: 'SQL comparison', label: 'Normalised SQL comparison', help: 'Compares the returned query after normalising whitespace and case.' }

test('a third party declares its own grading contract, and the core admits it in that benchmark own studies', async () => {
  await withRegistryAsync(async () => {
    registerBenchmark({ id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench', extraction: SQL_POLICY, gradingKinds: [SQL_CONTRACT] })
    const study = sqlStudy()
    study.protocol = { ...study.protocol, grading: { kind: 'sql-compare' } }
    const project = await freezeStudy(await bindRuntimeSources(study, sqlSources))
    assert.equal(project.spec.protocol.grading.kind, 'sql-compare')
    // It runs, and it runs under the profile that records the run without
    // claiming ToolsEnabled qualified the grader that declared contract brought.
    assert.equal(project.readiness.profile.id, 'third-party-declared-endpoint')
    assert.match(project.readiness.profile.scope, /no ToolsEnabled scientific-validity admission is claimed/)
    // And it runs through the grader seam every benchmark uses: runStudy takes
    // the grader as a callback, so a declared contract needs no core dispatch.
    const graded = []
    const result = await runStudy(project, { now: () => 1700000000000,
      grade: (_project, task, output) => { graded.push(task.id); return { passed: output.trim() === task.expected.trim(), score: 1 } } })
    assert.equal(result.summary.completed, project.schedule.length)
    assert.ok(graded.length > 0, 'the declared contract reached the benchmark own grader')
  })
})

test('a grading contract belongs to the benchmark that declared it, and the refusal names both', () => {
  withRegistry(() => {
    registerBenchmark({ id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench', extraction: SQL_POLICY, gradingKinds: [SQL_CONTRACT] })
    const generic = genericStarter()
    generic.protocol = { ...generic.protocol, grading: { kind: 'sql-compare' } }
    assert.throws(() => validateStudy(generic), /SQL comparison grading requires a SQL Bench specification/)
    // The same rule, unchanged, for the benchmark this tree ships.
    const alsoGeneric = genericStarter()
    alsoGeneric.protocol = { ...alsoGeneric.protocol, grading: { kind: 'lean-python' } }
    assert.throws(() => validateStudy(alsoGeneric), /LEAN Python grading requires a Lean Bench specification/)
    // A contract nobody registered is still refused.
    const invented = genericStarter()
    invented.protocol = { ...invented.protocol, grading: { kind: 'sql-compare-2' } }
    assert.throws(() => validateStudy(invented), /Choose a supported built-in or custom grading contract/)
  })
})

test('a contract preconditions belong to whoever implemented it, and still refuse what they used to', () => {
  const lean = leanStarter()
  lean.protocol = { ...lean.protocol, timeoutMs: 150000, grading: { kind: 'lean-python' } }
  lean.environment = { ...lean.environment, leanImage: 'quantconnect/lean:latest' }
  assert.throws(() => validateStudy(lean), /Pin the LEAN Docker image by SHA-256 digest/)
  lean.environment = { ...lean.environment, leanImage: 'quantconnect/lean@sha256:' + 'a'.repeat(64) }
  validateStudy(lean)
  lean.protocol = { ...lean.protocol, timeoutMs: 1000 }
  assert.throws(() => validateStudy(lean), /attempt budget greater than one second/)
})

test('the registry refuses the mistakes that would make a grading contract unattributable', () => {
  withRegistry(() => {
    const base = { label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench' }
    assert.throws(() => registerBenchmark({ ...base, id: 'a', gradingKinds: [{ value: 'exact', title: 'Exact', label: 'Exact' }] }), /cannot redeclare the core grading contract/)
    assert.throws(() => registerBenchmark({ ...base, id: 'b', gradingKinds: [{ value: 'x', label: 'X' }] }), /needs the title a refusal can name it by/)
    assert.throws(() => registerBenchmark({ ...base, id: 'c', gradingKinds: [{ value: 'x', title: 'X' }] }), /needs the label a person will read/)
    assert.throws(() => registerBenchmark({ ...base, id: 'd', gradingKinds: [{ value: 'x', title: 'X', label: 'X', assertReady: 'soon' }] }), /assertReady\(spec\) as a function/)
    registerBenchmark({ ...base, id: 'first', gradingKinds: [SQL_CONTRACT] })
    assert.throws(() => registerBenchmark({ ...base, id: 'second', domains: ['other'], gradingKinds: [SQL_CONTRACT] }), /Two benchmarks cannot own one contract/)
  })
})

test('a page surface is declared, and a benchmark that declares none gets none', () => {
  withRegistry(() => {
    registerBenchmark({ id: 'sql-bench', label: 'SQL Bench', domains: ['sql-bench'], matches: spec => spec?.domain === 'sql-bench',
      page: { fields: ['combinations'], taskTrace: () => { throw new Error('a page thunk must not run at registration') } } })
    assert.equal(declaresPageField('sql-bench', 'combinations'), true)
    assert.equal(declaresPageField('sql-bench', 'trace-details'), false)
    // A study with no benchmark gets the empty surface, which is what makes the
    // page generic by default rather than shaped like whoever registered first.
    assert.deepEqual(pageSurfaceForDomain('generic').fields, [])
    assert.equal(declaresPageField('generic', 'combinations'), false)
    // Registration did not call the thunk: it would have thrown.
    assert.equal(typeof pageSurfaceForDomain('sql-bench').taskTrace, 'function')
    assert.throws(() => registerBenchmark({ id: 'bad-page', label: 'Bad', matches: () => false, page: { fields: [{}] } }), /page\.fields as an array/)
    assert.throws(() => registerBenchmark({ id: 'bad-trace', label: 'Bad', matches: () => false, page: { taskTrace: 'later' } }), /page\.taskTrace\(spec, task, compiled\) as a function/)
  })
})
