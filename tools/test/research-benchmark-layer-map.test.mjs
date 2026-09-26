// The Research page's Compiled prompt preview shows which layer contributed
// which characters, using the venue report's own rows so the two cannot drift.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { deriveTaskExpected } from '../../src/benchmark/tasks.mjs'
import { strategyRef } from '../../src/benchmark/lean.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { layerMap, LAYER_MAP_COLUMNS, LAYER_MAP_PREVIEW_ROWS } from '../../src/research-layer-map.mjs'

const REVIEWER = 'LAYER MAP FIXTURE MARKER ONLY'
const REVIEWED_AT = '2026-09-10T00:00:00.000Z'

// A composition deep enough to exceed the 60-row preview cap, so the capped
// wording can be compared with the report's instead of only with itself.
// Sixteen strategy leaves under nested two-child templates.
function nested(depth) {
  return depth === 0 ? strategyRef()
    : { use: 'parallel', slots: { first: nested(depth - 1), second: nested(depth - 1) } }
}

async function frozenCanary({ depth = 0 } = {}) {
  const bytes = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  let spec = newExperimentDraft(leanStarter(), { purpose: 'recorded-diagnostic' })
  if (depth) {
    spec.tasks = [{ ...spec.tasks[0], root: { use: 'constitution-v1', slots: { strategy: nested(depth) } } }]
    spec.tasks[0].expected = await deriveTaskExpected(spec, spec.tasks[0])
    spec.conditions[0].adapter.responses['flat-canary'] = spec.tasks[0].expected
  }
  spec = await bindRuntimeSources(spec, bytes)
  spec = await bindLeanReview(spec, bytes)
  spec.catalog = await Promise.all(spec.catalog.map(bundle =>
    approveBundle(bundle, REVIEWER, REVIEWED_AT, { catalog: spec.catalog })))
  const project = await freezeStudy(spec)
  return { project, task: project.tasks[0] }
}

test('the layer map carries one row per source-map range, in the report’s columns', async () => {
  const { task } = await frozenCanary()
  const map = layerMap(task.id, task.compiled)
  assert.deepEqual(map.columns, LAYER_MAP_COLUMNS)
  assert.deepEqual(map.columns, ['Start', 'End', 'Node path', 'Bundle', 'Requirement'])
  assert.equal(map.id, 'source-map-' + task.id)
  assert.ok(task.compiled.sourceMap.length > 1, 'the starter prompt is composed from more than one layer')
  assert.equal(map.total, task.compiled.sourceMap.length)
  assert.equal(map.shown, map.rows.length)
  const first = task.compiled.sourceMap[0]
  assert.deepEqual(map.rows[0], [String(first.start), String(first.end), first.path,
    first.bundleId ?? 'runtime appendix', first.requirementId])
  // Every range is a span of the prompt the reader is looking at.
  for (const [index, row] of map.rows.entries()) {
    const range = task.compiled.sourceMap[index]
    assert.equal(task.compiled.text.slice(range.start, range.end).length, range.end - range.start)
    assert.equal(row[2], range.path)
  }
})

test('a runtime appendix range names itself instead of a bundle', async () => {
  const { task } = await frozenCanary()
  const appendix = task.compiled.sourceMap.find(range => range.bundleId === null)
  assert.ok(appendix, 'the Lean starter appends a runtime execution appendix')
  const map = layerMap(task.id, task.compiled)
  const row = map.rows[task.compiled.sourceMap.indexOf(appendix)]
  assert.equal(row[3], 'runtime appendix')
  assert.equal(row[2], 'runtime')
})

test('the preview cap says how many ranges it is hiding', () => {
  const compiled = {
    promptSha256: 'a'.repeat(64), sourceMapUnit: 'UTF-16 code units',
    sourceMap: Array.from({ length: 5 }, (value, index) =>
      ({ start: index, end: index + 1, path: 'root/' + index, bundleId: 'b' + index, requirementId: 'r' + index })),
  }
  const capped = layerMap('t', compiled, { limit: 2 })
  assert.equal(capped.shown, 2)
  assert.equal(capped.total, 5)
  assert.equal(capped.more, 'Showing 2 of 5 ranges.')
  const whole = layerMap('t', compiled)
  assert.equal(whole.shown, 5)
  assert.equal(whole.more, '', 'nothing is hidden, so nothing is claimed to be')
  assert.equal(LAYER_MAP_PREVIEW_ROWS, 60)
})

test('the caption names the unit and the prompt hash, and declares an absent hash', () => {
  const ranges = [{ start: 0, end: 4, path: 'root', bundleId: 'b', requirementId: 'root#b' }]
  const named = layerMap('t', { promptSha256: 'b'.repeat(64), sourceMapUnit: 'UTF-16 code units', sourceMap: ranges })
  assert.equal(named.caption, 'Layer map for t, in UTF-16 code units. Prompt SHA-256 ' + 'b'.repeat(64) + '.')
  const absent = layerMap('t', { sourceMap: ranges })
  assert.equal(absent.unit, 'UTF-16 code units', 'the unit is stated rather than assumed silently')
  assert.match(absent.caption, /Prompt SHA-256 Not declared\./)
})

test('a compiled prompt without a source map is refused', () => {
  assert.throws(() => layerMap('t', { text: 'no map here' }), /source map/)
  assert.throws(() => layerMap('', { sourceMap: [] }), /task it describes/)
})

test('the capped preview and its "Showing N of M" line are the report’s own, not this module’s idea of them', async () => {
  const { project, task } = await frozenCanary({ depth: 4 })
  assert.ok(task.compiled.sourceMap.length > LAYER_MAP_PREVIEW_ROWS,
    'this fixture must exceed the preview cap; it has ' + task.compiled.sourceMap.length + ' ranges')
  const map = layerMap(task.id, task.compiled)
  assert.equal(map.shown, LAYER_MAP_PREVIEW_ROWS)
  assert.equal(map.total, task.compiled.sourceMap.length)
  const files = await researchReportFiles(project, [])
  const markdown = files['report.md'].replace(/\\(.)/g, '$1')
  // The report prints the same sentence and then names the retained file; the
  // page's line must be exactly its leading sentence, not a paraphrase.
  assert.ok(markdown.includes(map.more), 'the report does not carry the page’s capped line: ' + map.more)
  assert.ok(markdown.includes(map.caption), 'the report caption differs from the page caption')
  for (const row of map.rows) assert.ok(markdown.includes('| ' + row.join(' | ') + ' |'),
    'the report is missing a capped page row: ' + row.join(' | '))
  // The cap hides ranges rather than losing them: the retained file keeps all.
  const retained = JSON.parse(files['paper/source-maps/' + task.id + '.json'])
  assert.equal(retained.ranges.length, map.total)
})

test('the page’s layer map rows are the venue report’s own rows', async () => {
  const { project, task } = await frozenCanary()
  const files = await researchReportFiles(project, [])
  const retained = JSON.parse(files['paper/source-maps/' + task.id + '.json'])
  const map = layerMap(task.id, task.compiled)
  assert.equal(retained.unit, map.unit)
  assert.equal(retained.promptSha256, task.compiled.promptSha256)
  assert.equal(retained.ranges.length, map.total)
  // The report renders the same ranges as a table. Its Markdown escapes cell
  // punctuation, so compare the unescaped text: every row and the caption the
  // page shows must appear there, or the two renderers have drifted.
  const markdown = files['report.md'].replace(/\\(.)/g, '$1')
  assert.ok(markdown.includes(map.caption), 'the report caption differs from the page caption: ' + map.caption)
  assert.ok(markdown.includes('| ' + map.columns.join(' | ') + ' |'), 'the report columns differ from the page columns')
  for (const row of map.rows) assert.ok(markdown.includes('| ' + row.join(' | ') + ' |'),
    'the report is missing the page row: ' + row.join(' | '))
})
