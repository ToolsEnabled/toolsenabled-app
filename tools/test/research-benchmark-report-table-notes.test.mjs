// Venue report item 7: every table a research report can render is introduced
// by one plain-language sentence, in report.html and in report.md.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import * as reportModule from '../../src/benchmark/report.mjs'
import { endpointStudy } from './fixtures/research-benchmark-endpoints.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const source = sources['report.mjs']
const REVIEWER = 'REPORT TABLE NOTE FIXTURE MARKER ONLY'
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[match])

async function leanCanary() {
  let spec = newExperimentDraft(leanStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}
async function endpointsProject() {
  const endpoint = (id, kind, path, extra = {}) => ({ id, kind, source: { path }, direction: 'higher-better', primary: false, unit: 'units', rationale: 'Synthetic ' + id + ' endpoint.', ...extra })
  const spec = endpointStudy(null, { endpoints: [endpoint('pass', 'binary', ['passed'], { primary: true }), endpoint('size', 'count', ['response', 'outputBytes'], { unit: 'bytes' })] })
  spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'depth' }, seed: 11, iterations: 200, confidence: 0.9 }
  return freezeStudy(await bindRuntimeSources(spec, sources))
}
// Every table id report.mjs can pass to a table renderer, read from its source:
// literal ids, and the literal prefix of ids completed at render time.
function tableIds() {
  const ids = []
  for (const match of source.matchAll(/(?:\baddTable|\b(?:head|mid|integ|check|cite|lim)\.table)\(\s*'([^']+)'(\s*\+)?/g)) ids.push({ id: match[1], dynamic: Boolean(match[2]) })
  return ids
}

test('item 7: every table id report.mjs can render has a plain-language note', () => {
  assert.equal(typeof reportModule.tableNote, 'function', 'report.mjs exports the note lookup it renders from')
  const ids = tableIds()
  assert.ok(ids.length >= 70, 'the source scan found the table renderers (' + ids.length + ')')
  const missing = ids.filter(({ id, dynamic }) => {
    const note = reportModule.tableNote(dynamic ? id + 'example-suffix' : id)
    return !(typeof note === 'string' && note.length >= 30 && /\.$/.test(note))
  }).map(({ id, dynamic }) => id + (dynamic ? '*' : ''))
  assert.deepEqual(missing, [], 'table ids without a plain-language sentence')
  assert.equal(reportModule.tableNote('no-such-table-id'), null, 'an unknown id is not given an invented note')
})

test('item 7: every table in a rendered report is introduced by its note in HTML and Markdown', async () => {
  for (const project of [await leanCanary(), await endpointsProject()]) {
    const files = await reportModule.researchReportFiles(project, (await runStudy(project)).events)
    const html = files['report.html'], markdown = unescapeMarkdown(files['report.md'])
    const tables = [...html.matchAll(/<div class="table-wrap"[^>]*>/g)], links = [...html.matchAll(/<p class="table-note"><a href="tables\/([^"]+)\.csv">/g)]
    assert.ok(tables.length >= 15 && links.length >= 8, 'the fixture renders many tables (' + tables.length + ' tables, ' + links.length + ' CSV links)')
    for (const match of tables) {
      const before = html.slice(Math.max(0, match.index - 600), match.index)
      assert.match(before, /<p class="table-intro">[^<]+<\/p>$/, 'table at ' + match.index + ' is introduced by its note')
    }
    for (const [, id] of links) {
      const note = reportModule.tableNote(id)
      assert.ok(note, 'a note exists for ' + id)
      assert.ok(unescapeHtml(html).includes('<p class="table-intro">' + note + '</p>'), 'HTML introduces ' + id)
      assert.ok(markdown.includes(note), 'Markdown introduces ' + id)
    }
  }
})
