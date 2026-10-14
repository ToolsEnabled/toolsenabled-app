// A study field that study.mjs accepts must also be accepted by templates.mjs. There
// are two independent allow-lists: validateVersionTwoFields in study.mjs, and
// validateExperimentTemplate in templates.mjs for a resource-template study. A field
// added to one and not the other passes every generic test and then refuses at freeze
// for template studies only, with the unknown-field sentence. It has happened three
// times now: 'generator' (fixed in acd8aae4), 'pricing', and 'version' below.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindRuntimeSources, freezeStudy, verifyProject, normalizeStudyVersion, RUNTIME_FILES, STUDY_VERSION } from '../../src/benchmark/study.mjs'
import { resourceTemplateFixture } from './fixtures/research-benchmark-resource-template.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const frozen = async edit => {
  const spec = await resourceTemplateFixture()
  edit(spec)
  return freezeStudy(await bindRuntimeSources(spec, sources))
}

test("a resource-template study declaring a study version freezes, and verifies", async () => {
  // The page offers this field on every study, resource-template ones included:
  // src/research-benchmark.js:187 puts the Study version input in the shared toolbar
  // with no domain or template condition, and :1701-1704 writes spec.version from it.
  // So this is reachable from the builder, not a theoretical combination.
  const version = normalizeStudyVersion('1.0.44')
  assert.equal(version, '1.0.44')
  const project = await frozen(spec => { spec.version = version })
  assert.equal(project.spec.version, '1.0.44')
  await verifyProject(project)
})

test('the fields this build adds to a version-2 study are accepted by the template validator too', async () => {
  // normalizeStudyVersion pads to three parts, so '2.1' is stored as '2.1.0'.
  const version = normalizeStudyVersion('2.1')
  assert.equal(version, '2.1.0')
  const project = await frozen(spec => { spec.version = version })
  assert.equal(project.spec.version, version)
  assert.equal(project.spec.generator.name, 'ToolsEnabled')
  // The price table really does attach here, so this exercises 'pricing' through the
  // template validator rather than merely tolerating it. Measured: the fixture declares
  // an observation plan (fixtures/research-benchmark-resource-template.mjs:99) and no
  // cost estimate, which is exactly the condition the attach rule requires.
  assert.equal(project.spec.pricing.frozenAsOf, '2026-09-11')
  assert.equal(project.spec.pricing.models.length, 10)
  await verifyProject(project)
})

test('an unknown field is still refused, by the study validator before the template one', async () => {
  // Measured, not assumed: study.mjs validateVersionTwoFields runs first, so a field
  // neither list knows is refused with the "Version N study" sentence and templates.mjs
  // never sees it. Widening one list must not stop that. The sentence names the
  // study's own schema version, so this reads the version rather than pinning a
  // literal that the next schema bump would silently invalidate.
  await assert.rejects(frozen(spec => { spec.notAField = 'marker' }),
    new RegExp(`Version ${STUDY_VERSION} study contains unsupported fields: notAField\.`),
    'a genuinely unknown field is still refused')
})
