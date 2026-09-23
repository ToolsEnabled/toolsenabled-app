// Schema 3 added four modules to the exported runtime. Adding files to that
// runtime is a schema event, because runner.mjs refuses to run a study that did
// not pin the complete runtime for its version -- an exported project may not
// run against modules it never pinned, or it is not reproducible.
//
// This suite is the promise that bump makes: a project frozen under schema 2
// still freezes to the same identity and still runs, against the 45-file
// inventory it was frozen with, on a build that ships 50. And the guard that
// makes the promise worth having is still a guard: a study that does not pin its
// own version's runtime completely is still refused.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  LEGACY_RUNTIME_FILES, RUNTIME_FILES, V2_RUNTIME_FILES, STUDY_VERSION, SUPPORTED_SCHEMA_VERSIONS,
  bindRuntimeSources, freezeStudy, modernSchema, runtimeFilesFor, runtimeFilesForVersion,
} from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { endpointStudy, FIXED_NOW, RECORDED_SCHEMA_VERSION } from './fixtures/research-benchmark-endpoints.mjs'

const baseline = JSON.parse(await readFile(new URL('./fixtures/research-benchmark-endpoints-baseline.json', import.meta.url), 'utf8'))
const liveSources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))

test('each schema version owns an inventory, and a later one never reaches back', () => {
  assert.equal(STUDY_VERSION, 3)
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3])
  assert.equal(LEGACY_RUNTIME_FILES.length, 43)
  assert.equal(V2_RUNTIME_FILES.length, 45)
  assert.equal(RUNTIME_FILES.length, 50)
  assert.deepEqual(runtimeFilesForVersion(1), LEGACY_RUNTIME_FILES)
  assert.deepEqual(runtimeFilesForVersion(2), V2_RUNTIME_FILES)
  assert.deepEqual(runtimeFilesForVersion(3), RUNTIME_FILES)
  // Each inventory extends the one before it; a version never drops a file.
  assert.deepEqual(V2_RUNTIME_FILES.slice(0, 43), LEGACY_RUNTIME_FILES)
  assert.deepEqual(RUNTIME_FILES.slice(0, 45), V2_RUNTIME_FILES)
  // The four seam modules are schema 3 only.
  for (const file of ['extraction.mjs', 'registry.mjs', 'plugins.mjs', 'lean-plugin.mjs', 'study-schema.mjs']) {
    assert.ok(RUNTIME_FILES.includes(file), file + ' ships in schema 3')
    assert.ok(!V2_RUNTIME_FILES.includes(file), file + ' must not appear in the frozen schema-2 inventory')
  }
})

test('modernSchema means "2 or later", not "exactly the current one"', () => {
  assert.equal(modernSchema({ schemaVersion: 1 }), false)
  assert.equal(modernSchema({ schemaVersion: 2 }), true)
  assert.equal(modernSchema({ schemaVersion: 3 }), true)
  assert.equal(modernSchema({ spec: { schemaVersion: 2 } }), true)
  assert.equal(modernSchema(undefined), false)
  assert.equal(modernSchema({}), false)
})

test('a new draft is the current schema, so new studies get the current runtime', async () => {
  const draft = newExperimentDraft(genericStarter(), { initializePopulation: true })
  assert.equal(draft.schemaVersion, STUDY_VERSION)
  const bound = await bindRuntimeSources(draft, liveSources)
  assert.equal(Object.keys(bound.runtimeSources).length, RUNTIME_FILES.length)
})

// The fixture pins the digests recorded at its base commit, so this is a real
// schema-2 project: frozen before the seam modules existed, against a build that
// now ships five more files than it knows about.
test('a schema-2 project frozen before schema 3 still freezes to its recorded identity', async () => {
  const spec = endpointStudy(baseline.runtimeSources)
  assert.equal(spec.schemaVersion, RECORDED_SCHEMA_VERSION)
  assert.equal(Object.keys(spec.runtimeSources).length, V2_RUNTIME_FILES.length)
  const project = await freezeStudy(spec)
  assert.equal(project.version, 2)
  assert.equal(project.sha256, baseline.projectSha256, 'the schema-2 identity must not move when the build gains runtime modules')
  assert.deepEqual(project.runtimeFiles, V2_RUNTIME_FILES, 'it pins its own version inventory, not the build\'s')
  assert.deepEqual(runtimeFilesFor(project), V2_RUNTIME_FILES)
})

test('a schema-2 project frozen before schema 3 still RUNS, on a build that ships 50 files', async () => {
  const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
  const result = await runStudy(project, { now: () => FIXED_NOW })
  assert.ok(result.summary.completed > 0, 'the schema-2 study must actually complete trials')
  assert.equal(result.events.filter(event => event.type === 'finished').length, result.summary.completed)
})

test('a schema-3 project binds, freezes and runs against the current inventory', async () => {
  const project = await freezeStudy(await bindRuntimeSources(endpointStudy(null), liveSources))
  assert.equal(project.version, STUDY_VERSION)
  assert.deepEqual(project.runtimeFiles, RUNTIME_FILES)
  const result = await runStudy(project, { now: () => FIXED_NOW })
  assert.ok(result.summary.completed > 0)
})

// The point of the per-version inventory is to keep the guard, not to soften it.
// These mutate the SPEC and then freeze, so the project is internally consistent
// and the runtime-pin guard is what has to catch it. (Mutating a frozen project
// instead is caught earlier, by the project digest -- also a refusal, but a
// different one, and it would hide whether this guard still works.)
test('a study that does not pin its own version completely is still refused', async () => {
  const spec = endpointStudy(baseline.runtimeSources)
  delete spec.runtimeSources['report.mjs']
  const project = await freezeStudy(spec)
  await assert.rejects(() => runStudy(project, { now: () => FIXED_NOW }),
    error => /Pin the complete schema-2 runtime \(45 files\) for version 2 execution\./.test(error.message),
    'dropping a schema-2 file from a schema-2 study must still refuse, and must name that version')
})

test('a schema-2 study cannot pin a file from a later schema it does not run', async () => {
  const spec = endpointStudy(baseline.runtimeSources)
  spec.runtimeSources['extraction.mjs'] = 'a'.repeat(64)
  const project = await freezeStudy(spec)
  await assert.rejects(() => runStudy(project, { now: () => FIXED_NOW }),
    error => /complete-runtime-pins-required/.test(error.message),
    'an extra pin outside the inventory this study runs must refuse, not be ignored')
})

test('a frozen project that is edited after freezing is refused before any of this', async () => {
  const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
  const tampered = structuredClone(project)
  tampered.runtimeFiles = [...RUNTIME_FILES]
  await assert.rejects(() => runStudy(tampered, { now: () => FIXED_NOW }),
    error => /The frozen project changed/.test(error.message))
})
