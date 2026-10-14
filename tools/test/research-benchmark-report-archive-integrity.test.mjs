// A report for a project this build cannot rebuild.
//
// researchReportFiles calls verifyProject, which recompiles the frozen project
// with the current compiler and demands byte equality. That is right for a
// project frozen here. It is impossible for one opened from an archive that some
// other build froze: any change to compiled readiness output re-identifies every
// earlier frozen project. The exported command-line runner never meets this,
// because it runs from inside the archive and IS the pinned runtime; a page
// never is.
//
// So the page needs a second, explicitly labelled mode: render from bytes proved
// intact against the archive's own manifest, and say so in the report rather
// than claim a verification that did not happen. This is not a relaxation. The
// project's recorded digest must still match its own contents, so an edited
// answer key is refused exactly as before; what is dropped is the rebuild, and
// the report states that it was dropped and why.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle, canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'

// Deliberately free of any phrase these tests assert on: the reviewer name is
// rendered into the report, and an earlier marker containing the words being
// searched for made a negative assertion fail and would have made the positive
// ones pass for the wrong reason.
const REVIEWER = 'RP1 REPORT FIXTURE MARKER ONLY'
const sources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))

async function frozenHere() {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindRuntimeSources(spec, await sources())
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}

// An archive frozen by a build whose readiness output differed: internally
// consistent, and not rebuildable here. This is efaa64a2's situation exactly.
// An archive frozen by a build whose readiness output differed: internally
// consistent, and not rebuildable here. This is efaa64a2's situation exactly.
// Its journal is rebound to it, because a real archive's evidence carries the
// project digest of the archive it came from.
async function frozenElsewhere(project, events, mutate = body => {
  // A blocker this build's readiness does not produce, so the rebuild here
  // differs exactly as B1's readiness fix makes efaa64a2 differ on this tree.
  body.readiness = { ...body.readiness, blockers: [{ code: 'fixture-recorded-elsewhere', path: 'protocol.grading.kind', message: 'Recorded by a build whose readiness output differed.' }] }
}) {
  const { sha256: _previous, ...body } = structuredClone(project)
  mutate(body)
  const foreign = { ...body, sha256: await sha256(canonical(body)) }
  return { project: foreign, events: structuredClone(events).map(event => ({ ...event, projectSha256: foreign.sha256 })) }
}

const INTEGRITY = { files: 71, runtimeDiffering: ['report.mjs', 'readiness.mjs'], rebuildDiffering: ['readiness.blockers.0', 'readiness.sha256', 'sha256'] }
// report.md escapes Markdown punctuation and report.html escapes markup, so a
// search for a field name like readiness.blockers.0 must undo that rather than
// pin its escaped spelling. Same approach as the venue-report tests.
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[match]))
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]

test('a project this build can rebuild is unaffected and still claims its own verification', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const files = await researchReportFiles(project, events)
  for (const text of both(files)) {
    assert.match(text, /Independently verified while producing this report/)
    assert.doesNotMatch(text, /Verified by archive integrity only/)
  }
})

test('without the archive-integrity mode, a project frozen elsewhere is still refused', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const elsewhere = await frozenElsewhere(project, events)
  await assert.rejects(() => researchReportFiles(elsewhere.project, elsewhere.events), /frozen project changed/i)
})

test('with the archive-integrity mode it renders, and says the rebuild did not happen', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const elsewhere = await frozenElsewhere(project, events)
  const files = await researchReportFiles(elsewhere.project, elsewhere.events, { archiveIntegrity: INTEGRITY })
  for (const text of both(files)) {
    assert.match(text, /Verified by archive integrity only/, 'the report says what it was verified by')
    assert.match(text, /readiness\.blockers/, 'the report names the fields that differ')
    assert.match(text, /rendered by this build|this build's generator/i, 'the report names the generator that rendered it')
  }
})

test('the archive-integrity report never claims a verification it did not perform', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const elsewhere = await frozenElsewhere(project, events)
  const files = await researchReportFiles(elsewhere.project, elsewhere.events, { archiveIntegrity: INTEGRITY })
  for (const text of both(files)) {
    assert.doesNotMatch(text, /Independently verified while producing this report: the frozen project against its own digest/)
  }
})

test('the archive-integrity mode still refuses a project whose digest does not match its own contents', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const edited = structuredClone(project)
  edited.tasks[0].expected = '999'
  await assert.rejects(() => researchReportFiles(edited, events, { archiveIntegrity: INTEGRITY }),
    /does not match its own contents/i, 'an edited answer key under an unchanged hash is refused')
})

test('the archive-integrity option is rejected unless it names what differed', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const elsewhere = await frozenElsewhere(project, events)
  await assert.rejects(() => researchReportFiles(elsewhere.project, elsewhere.events, { archiveIntegrity: {} }), /archive integrity/i, 'an empty claim is not a verification')
})

// The point of threading a signal rather than dropping the check: skipping the
// current-build admission must not loosen the binding that ties a journal to the
// project it came from. If it did, an archive could be rendered with somebody
// else's attempts.
test('the archive-integrity mode still refuses a journal not bound to this project', async () => {
  const project = await frozenHere(), { events } = await runStudy(project)
  const elsewhere = await frozenElsewhere(project, events, body => {
    body.readiness = { ...body.readiness, blockers: [{ code: 'fixture-recorded-elsewhere', path: 'protocol.grading.kind', message: 'Recorded by a build whose readiness output differed.' }], sha256: 'f'.repeat(64) }
  })
  await assert.rejects(() => researchReportFiles(elsewhere.project, elsewhere.events, { archiveIntegrity: INTEGRITY }),
    /different readiness contract or execution purpose/,
    'the journal-to-project binding is checked for an opened archive exactly as for any other caller')
})
