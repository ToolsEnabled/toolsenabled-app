// research-benchmark-journal.mjs says of dispositionRows that they are "the same
// rows the exported report's dispositions table prints". Nothing held that claim:
// the page builds its rows in a page-only module and the report builds its table
// in report.mjs, and the two could part company without any test noticing.
//
// This holds it. One run, a project this tree can verify so the report can
// actually be generated for it, rendered both ways, and every row the page shows
// is required to appear in the report's own Markdown. report.mjs is a pinned
// runtime file, so the page module cannot import its renderer; agreement has to
// be asserted rather than shared.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { dispositionRows } from '../../src/research-benchmark-journal.mjs'

// Two conditions, one of which answers one task wrongly, so the run settles into
// more than one disposition and the comparison is not a single-row coincidence.
async function twoConditionRun() {
  const bytes = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic', initializePopulation: true })
  const recorded = spec.conditions[0]
  spec.conditions = [recorded, {
    id: 'mistaken', label: 'Known wrong answers',
    model: { provider: 'fixture', id: 'arithmetic-wrong-v1', settings: {} },
    adapter: { kind: 'replay', responses: { 'addition-a': '6', 'addition-b': '11' } },
  }]
  const project = await freezeStudy(await bindRuntimeSources(spec, bytes))
  const { events, summary } = await runStudy(project, { events: [] })
  return { project, events, summary }
}

test('every disposition row the page shows is a row the exported report prints', async () => {
  const { project, events, summary } = await twoConditionRun()
  const rows = dispositionRows(summary)
  assert.ok(rows.length > 1, 'this fixture must settle into more than one disposition row; it produced ' + rows.length)
  assert.ok(new Set(rows.map(row => row.disposition)).size > 1,
    'the rows must cover more than one disposition, not one repeated; got ' +
    JSON.stringify(rows.map(row => row.disposition)))

  const files = await researchReportFiles(project, events)
  // The report escapes Markdown punctuation in cells, so compare unescaped text.
  const markdown = files['report.md'].replace(/\\(.)/g, '$1')
  for (const row of rows) {
    assert.ok(markdown.includes(`| ${row.condition} | ${row.disposition} | ${row.trials} |`),
      'the report has no such row, so the page and the report have parted company: ' +
      JSON.stringify(row))
  }

  // Every trial is accounted for on both sides, so the page cannot quietly drop one.
  assert.equal(rows.reduce((total, row) => total + row.trials, 0), summary.scheduled)
})
