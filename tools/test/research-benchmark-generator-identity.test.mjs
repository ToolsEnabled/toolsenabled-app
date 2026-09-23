// HT-1: the frozen project, and every report rendered from it, must name the
// generator that froze it. The stamp is recorded at freeze time and preserved
// on re-freeze, so a project frozen by one release still verifies under a later
// one, and the page and the exported CLI keep rendering identical bytes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, verifyProject, GENERATOR, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { resourceTemplateFixture } from './fixtures/research-benchmark-resource-template.mjs'

const REVIEWER = 'GENERATOR IDENTITY FIXTURE MARKER ONLY'
const sources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
// report.md escapes markdown punctuation and report.html escapes markup, so a
// search for a frozen value must undo that escaping rather than pin its spelling.
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[match]))
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]

async function generic({ edit = () => {} } = {}) {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  edit(spec)
  spec = await bindRuntimeSources(spec, await sources())
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}

test('the generator constant is the shipped application version, so it cannot drift', async () => {
  const shipped = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(GENERATOR.name, 'ToolsEnabled')
  assert.equal(GENERATOR.version, shipped.version, 'study.mjs GENERATOR.version must equal the package.json version')
})

test('freezing records the generator inside the frozen project, and the digest covers it', async () => {
  const project = await generic()
  assert.deepEqual(project.spec.generator, { name: 'ToolsEnabled', version: GENERATOR.version })
  const other = structuredClone(project.spec)
  other.generator = { name: 'ToolsEnabled', version: '0.0.1-fixture' }
  const refrozen = await freezeStudy(other)
  assert.notEqual(refrozen.sha256, project.sha256, 'the recorded generator is inside the frozen project digest')
})

test('a project frozen by another release still verifies, because the recorded stamp is preserved', async () => {
  const project = await generic()
  const older = structuredClone(project.spec)
  older.generator = { name: 'ToolsEnabled', version: '0.0.1-fixture' }
  const refrozen = await freezeStudy(older)
  assert.deepEqual(refrozen.spec.generator, { name: 'ToolsEnabled', version: '0.0.1-fixture' },
    're-freezing must preserve a recorded generator, never overwrite it with the running release')
  await verifyProject(refrozen)
})

test('the report names the generator and no longer disclaims generator identity', async () => {
  const project = await generic()
  const files = await researchReportFiles(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    assert.ok(text.includes('Generated with ToolsEnabled ' + GENERATOR.version),
      'front matter names the generator that froze the project')
    assert.ok(!text.includes('do not by themselves identify the generator'),
      'the integrity paragraph no longer disclaims generator identity')
  }
  // The front matter is where a reader looks for identity, so the row is asserted
  // on its own rather than left to the paragraph above.
  const escaped = GENERATOR.version.replace(/[.]/g, '\\.')
  assert.match(unescapeMarkdown(files['report.md']),
    new RegExp('\\|\\s*Generated with\\s*\\|\\s*ToolsEnabled ' + escaped + '\\s*\\|'),
    'front matter carries a Generated with row, beside the other identity rows')
  assert.ok(unescapeHtml(files['report.html']).includes('Generated with'),
    'the HTML rendering carries the same row')
})

// A resource-template study is checked by its own field allow-list before the project
// exists. That list has to know about the stamp compileStudy now writes, or freezing a
// whole study kind throws instead of producing a project.
test('a resource-template study freezes and carries the generator stamp', async () => {
  const spec = await resourceTemplateFixture()
  const project = await freezeStudy(await bindRuntimeSources(spec, await sources()))
  assert.equal(project.spec.generator.name, GENERATOR.name)
  assert.equal(project.spec.generator.version, GENERATOR.version)
})
