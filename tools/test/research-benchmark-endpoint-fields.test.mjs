// Labeled typed-endpoint fields: row/plan conversion, refusals that keep the
// draft, and the builder's Analysis panel wiring (mounted, synthetic account).
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { endpointRowsFromPlan, endpointsFromRows, endpointPathFromText, pathText, newEndpointRow, createEndpointFieldsEditor } from '../../src/research-endpoint-fields.js'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const plan = () => [
  { id: 'conflicts', kind: 'count', source: { path: ['grade', 'conflicts'] }, direction: 'lower-better', primary: false, unit: 'events', rationale: 'Observed conflicts.' },
  { id: 'throughput', kind: 'rate', source: { path: ['grade', 'completed'] }, exposure: { path: ['elapsedMs'], unit: 'ms' }, direction: 'higher-better', primary: false, unit: 'completions per ms', rationale: 'Completions over attempt time.' },
  { id: 'stall', kind: 'event-time', source: { path: ['grade', 'firstStallMs'] }, cap: 60000, direction: 'lower-better', primary: false, unit: 'ms', rationale: 'Time to first stall.' },
  { id: 'answers', kind: 'proportion', source: { path: ['response', 'outputBytes'] }, direction: 'higher-better', primary: false, unit: 'share', rationale: 'Placeholder proportion.' },
]

test('rows round-trip the contract, dotted paths keep numeric segments, and unfinished text refuses by row without coercion', () => {
  const rows = endpointRowsFromPlan(plan())
  assert.deepEqual(rows.map(row => [row.id, row.kind, row.source, row.exposurePath, row.exposureUnit, row.cap]), [['conflicts', 'count', 'grade.conflicts', '', 'ms', ''], ['throughput', 'rate', 'grade.completed', 'elapsedMs', 'ms', ''], ['stall', 'event-time', 'grade.firstStallMs', '', 'ms', '60000'], ['answers', 'proportion', 'response.outputBytes', '', 'ms', '']])
  assert.deepEqual(endpointsFromRows(rows), plan())
  assert.deepEqual(endpointPathFromText('reported.usage.0.tokens', 'x'), ['reported', 'usage', 0, 'tokens'])
  assert.throws(() => endpointPathFromText(' ', 'Endpoint 1 source'), /name the attempt-record path/)
  assert.throws(() => endpointPathFromText('grade..x', 'Endpoint 1 source'), /empty segment/)
  const stall = { ...rows[2], cap: '12e' }
  assert.throws(() => endpointsFromRows([stall]), /Endpoint 1 \(stall\): the censoring cap must be a whole number/)
  assert.throws(() => endpointsFromRows([{ ...rows[1], exposurePath: '' }]), /Endpoint 1 \(throughput\) exposure: name the attempt-record path/)
  assert.deepEqual(endpointsFromRows([]), [])
  assert.deepEqual(endpointRowsFromPlan(undefined), [])
  const fresh = newEndpointRow(); assert.equal(fresh.kind, 'binary'); assert.equal(fresh.source, 'passed')
})

// The third reviewer-reproduced defect: a literal path segment containing a dot,
// or a digit-only string segment, must survive the dotted display losslessly.
test('literal source and exposure paths round-trip through the field text without being rewritten', () => {
  const literalPaths = [
    ['grade', 'a.b'], ['grade', '0'], ['grade', 0], ['reported', 'usage', 0, 'tokens'], ['a.b', '0'], ['grade', 'a.b', 3],
  ]
  for (const path of literalPaths) {
    const endpoints = [{ id: 'x', kind: 'binary', source: { path }, direction: 'higher-better', primary: false, unit: 'u', rationale: 'r' }]
    const rows = endpointRowsFromPlan(endpoints)
    assert.deepEqual(endpointPathFromText(rows[0].source, 'lbl'), path, 'source path ' + JSON.stringify(path) + ' round-trips through its field text ' + JSON.stringify(rows[0].source))
    assert.deepEqual(endpointsFromRows(rows)[0].source.path, path)
    // The same path also round-trips as a rate endpoint's exposure path.
    const rateEndpoints = [{ id: 'x', kind: 'rate', source: { path: ['passed'] }, exposure: { path, unit: 'ms' }, direction: 'higher-better', primary: false, unit: 'u', rationale: 'r' }]
    const rateRows = endpointRowsFromPlan(rateEndpoints)
    assert.deepEqual(endpointPathFromText(rateRows[0].exposurePath, 'lbl'), path, 'exposure path ' + JSON.stringify(path) + ' round-trips through its field text ' + JSON.stringify(rateRows[0].exposurePath))
    assert.deepEqual(endpointsFromRows(rateRows)[0].exposure.path, path)
  }
  // The dotted form is kept exactly when it already round-trips (no unnecessary JSON form).
  assert.equal(endpointRowsFromPlan([{ id: 'x', kind: 'binary', source: { path: ['grade', 'conflicts'] } }])[0].source, 'grade.conflicts')
  assert.equal(endpointRowsFromPlan([{ id: 'x', kind: 'binary', source: { path: ['reported', 'usage', 0, 'tokens'] } }])[0].source, 'reported.usage.0.tokens')
  // Typing the JSON array form directly is accepted, including malformed input refusing with the row named.
  assert.deepEqual(endpointPathFromText('["grade","a.b"]', 'Endpoint 3 source'), ['grade', 'a.b'])
  assert.deepEqual(endpointPathFromText('["grade",0]', 'Endpoint 3 source'), ['grade', 0])
  // The refusal reason's exact wording is not pinned; only that it refuses and names the row.
  assert.throws(() => endpointPathFromText('[]', 'Endpoint 3 source'), /Endpoint 3 source:/, 'an empty JSON array refuses')
  assert.throws(() => endpointPathFromText('["grade",""]', 'Endpoint 3 source'), /Endpoint 3 source:/, 'an empty string segment refuses')
  assert.throws(() => endpointPathFromText('["grade",-1]', 'Endpoint 3 source'), /Endpoint 3 source:/, 'a negative integer segment refuses')
  assert.throws(() => endpointPathFromText('["grade",1.5]', 'Endpoint 3 source'), /Endpoint 3 source:/, 'a non-integer number segment refuses')
  assert.throws(() => endpointPathFromText('[grade]', 'Endpoint 3 source'), /Endpoint 3 source:/, 'invalid JSON syntax refuses')
})

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const A = 'rp-' + 'a'.repeat(36)
function memoryAccount() {
  const values = new Map()
  return { values, async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
}
async function harness(t, account = memoryAccount()) {
  const installed = installDomStandIn(globalThis), views = []
  const downloads = []
  const mount = async () => { const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: (name, contents) => downloads.push({ name, contents }) }); views.push(view); document.body.append(view.el); await view.setContext(A, 'live'); await idle(view); return view }
  const idle = async view => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(view.el.querySelector('[data-bench-status]').textContent) }
  t.after(() => { for (const view of views) { view.destroy(); view.el.remove() } installed.restore() })
  return { account, downloads, mount, idle }
}
const field = (view, name) => view.el.querySelector('[data-bench-' + name + ']')
const ep = (view, name) => view.el.querySelector('[data-endpoint-fields-' + name + ']')
const ep2 = ep, type2 = (node, value) => { node.value = value; node.dispatch('input') }
const status = view => field(view, 'status').textContent
const type = (node, value) => { node.value = value; node.dispatch('input') }
async function importDraft(view, idle, spec) {
  const text = JSON.stringify({ spec }), node = field(view, 'import')
  node.files = [{ name: 'draft.json', size: Buffer.byteLength(text), text: async () => text }]; node.dispatch('change'); await idle(view)
  assert.match(status(view), /Draft imported/)
}

test('the builder mounts labeled endpoint fields that add, edit, refuse without losing the draft, apply, reapply, save and remount', async t => {
  const { downloads, mount, idle } = await harness(t)
  const view = await mount()
  await importDraft(view, idle, developmentStarter())
  assert.ok(ep(view, 'editor') && ep(view, 'add'), 'the editor and its Add control are mounted')
  assert.match(ep(view, 'count').textContent, /No typed endpoints are declared/)
  ep(view, 'add').click(); await idle(view)
  assert.ok(ep(view, 'row-fields'), 'a row form appears after Add')
  // Keystroke by keystroke through the builder: the focused input must survive every builder re-render.
  const idInput = ep(view, 'id')
  idInput.focus()
  for (const [index] of [...'bytes'].entries()) {
    idInput.value = 'bytes'.slice(0, index + 1); idInput.dispatch('input'); await idle(view)
    assert.ok(ep(view, 'id') === idInput, 'keystroke ' + (index + 1) + ' keeps the same input mounted')
    assert.ok(ep(view, 'id').isConnected, 'the identifier input stays attached after keystroke ' + (index + 1))
    assert.ok(document.activeElement === idInput, 'the identifier input keeps focus after keystroke ' + (index + 1))
    assert.equal(idInput.disabled, false, 'the identifier input stays enabled after keystroke ' + (index + 1))
  }
  assert.equal(ep(view, 'id').value, 'bytes')
  assert.equal(ep(view, 'row').querySelector('option').textContent, 'bytes', 'the roster label follows typing without a rebuild')
  // A mid-string edit (inserting a character before the end) must not replace the input either.
  idInput.value = 'byrtes'; idInput.dispatch('input'); await idle(view)
  assert.ok(ep(view, 'id') === idInput, 'a mid-string edit keeps the same input mounted')
  assert.equal(idInput.value, 'byrtes')
  assert.equal(ep(view, 'row').querySelector('option').textContent, 'byrtes', 'the roster label follows a mid-string edit')
  idInput.value = 'bytes'; idInput.dispatch('input'); await idle(view)
  // A Kind change legitimately re-renders: fields appear/disappear for the new kind.
  type(ep(view, 'kind'), 'count'); ep(view, 'kind').dispatch('input'); type(ep(view, 'source'), 'response.outputBytes'); type(ep(view, 'unit'), 'bytes'); type(ep(view, 'rationale'), 'Bytes returned.')
  assert.match(field(view, 'endpoint-fields-status').textContent, /Endpoint fields changed/)
  ep(view, 'add').click(); await idle(view)
  type(ep(view, 'id'), 'stall'); type(ep(view, 'kind'), 'event-time'); ep(view, 'kind').dispatch('input')
  assert.equal(ep(view, 'cap-field').hidden, false, 'the cap field is visible for an event-time endpoint'); assert.equal(ep(view, 'exposure').hidden, true)
  type(ep(view, 'source'), 'elapsedMs'); type(ep(view, 'cap'), '12e'); type(ep(view, 'unit'), 'ms'); type(ep(view, 'direction'), 'lower-better'); ep(view, 'direction').dispatch('input'); type(ep(view, 'rationale'), 'Time to stall.')
  const rowsBefore = field(view, 'endpoint-fields').value
  field(view, 'apply-analysis').click(); await idle(view)
  assert.match(status(view), /Endpoint 2 \(stall\): the censoring cap must be a whole number/)
  assert.equal(field(view, 'endpoint-fields').value, rowsBefore, 'a refusal keeps every field row, including the unfinished text')
  assert.equal(ep(view, 'cap').value, '12e', 'the unfinished cap text is still on screen')
  assert.equal(JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints, undefined, 'the applied plan is unchanged by the refusal')
  type(ep(view, 'cap'), '60000')
  field(view, 'apply-analysis').click(); await idle(view)
  assert.match(status(view), /Analysis plan applied with 2 typed endpoints/)
  const applied = JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints
  assert.deepEqual(applied.map(endpoint => [endpoint.id, endpoint.kind, endpoint.source.path, endpoint.cap ?? null]), [['bytes', 'count', ['response', 'outputBytes'], null], ['stall', 'event-time', ['elapsedMs'], 60000]])
  assert.match(field(view, 'endpoint-fields-status').textContent, /2 typed endpoints applied/)
  // Reapplying the plan from other fields keeps the declared endpoints.
  type(field(view, 'analysis-rationale'), 'Changed rationale only.')
  field(view, 'apply-analysis').click(); await idle(view)
  assert.deepEqual(JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints, applied)
  // Remove one, apply, and confirm the plan follows the fields.
  type(ep(view, 'row'), ep(view, 'row').querySelectorAll('option')[0].value); ep(view, 'row').dispatch('change')
  ep(view, 'remove').click(); await idle(view)
  field(view, 'apply-analysis').click(); await idle(view)
  assert.deepEqual(JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints.map(endpoint => endpoint.id), ['stall'])
  // Unapplied field text survives save and a fresh mount against the same account.
  ep(view, 'add').click(); await idle(view); type(ep(view, 'id'), 'draft-only'); type(ep(view, 'source'), 'passed')
  field(view, 'save').click(); await idle(view); assert.match(status(view), /Draft saved/)
  const again = await mount()
  const rows = JSON.parse(field(again, 'endpoint-fields').value)
  assert.deepEqual(rows.map(row => row.id), ['stall', 'draft-only'], 'the retained field draft, including the unapplied row, survives remount')
  assert.deepEqual(JSON.parse(field(again, 'spec-json').value).analysisPlan.endpoints.map(endpoint => endpoint.id), ['stall'], 'the applied plan holds only applied endpoints')
  assert.ok(ep(again, 'row-fields'), 'the labeled fields are mounted again')
  // Removing every endpoint omits the field entirely (older projects keep their plan shape).
  for (const _ of rows) { ep(again, 'remove').click(); await idle(again) }
  field(again, 'apply-analysis').click(); await idle(again)
  assert.equal(JSON.parse(field(again, 'spec-json').value).analysisPlan.endpoints, undefined)
  assert.match(status(again), /Analysis plan applied\. Freeze it/)
  assert.equal(downloads.length, 0)
})

// The two defects the reviewer reproduced: keystroke-by-keystroke typing in the
// identifier field, and row keys after a real reload restores a draft.
test('typing an identifier keystroke by keystroke keeps the same input in place, and restored keys never collide with new rows', async t => {
  const installed = installDomStandIn(globalThis)
  const changes = []
  const editor = createEndpointFieldsEditor({ onChange: rows => changes.push(rows) })
  t.after(() => { editor.destroy(); installed.restore() })
  document.body.append(editor.el)
  const ep = name => editor.el.querySelector('[data-endpoint-fields-' + name + ']')
  ep('add').click()
  const idInput = ep('id'); assert.ok(idInput)
  for (const [index, char] of [...'throughput'].entries()) { idInput.value = 'throughput'.slice(0, index + 1); idInput.dispatch('input'); assert.ok(ep('id') === idInput, 'keystroke ' + (index + 1) + ' still targets the same input') }
  assert.equal(ep('id').value, 'throughput'); assert.equal(editor.getRows()[0].id, 'throughput')
  assert.equal(ep('row').querySelector('option').textContent, 'throughput', 'the roster label follows the typed identifier without a rebuild')
  assert.equal(changes.at(-1)[0].id, 'throughput')
  // A draft restored after a reload carries its old keys; a new row must get a fresh one.
  const restored = createEndpointFieldsEditor({ onChange: () => {} })
  t.after(() => restored.destroy()); document.body.append(restored.el)
  restored.setRows([{ ...newEndpointRow(), key: 'endpoint-1', id: 'first' }, { ...newEndpointRow(), key: 'endpoint-2', id: 'second' }])
  const rp = name => restored.el.querySelector('[data-endpoint-fields-' + name + ']')
  rp('add').click()
  const keys = restored.getRows().map(row => row.key)
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3, 'no duplicate key: ' + keys.join(','))
  rp('remove').click()
  assert.deepEqual(restored.getRows().map(row => row.id), ['first', 'second'], 'Remove deletes only the added row')
})

// A real page reload creates a fresh module instance, so the in-memory key
// counter restarts at 0 while restored rows keep the keys a prior instance
// minted (including a row saved as a pending draft before endpoints were
// applied). Reproduce that with an actual fresh module realm, not a shared one.
test('a fresh module realm restoring a saved draft keeps distinct row identities after Add, independent edits and Remove', async t => {
  const installed = installDomStandIn(globalThis)
  t.after(() => installed.restore())
  const fresh = await import('../../src/research-endpoint-fields.js?realm=' + Date.now() + '-' + Math.random())
  const editor = fresh.createEndpointFieldsEditor({ onChange: () => {} })
  t.after(() => editor.destroy())
  document.body.append(editor.el)
  const ep = name => editor.el.querySelector('[data-endpoint-fields-' + name + ']')
  // Plain parsed-JSON shape, exactly as a restored draft arrives: it must not call this
  // realm's newEndpointRow/nextKey, or the test would advance the very counter it means to test.
  const restoredRow = (key, id, source) => ({ key, id, kind: 'binary', source, exposurePath: '', exposureUnit: 'ms', cap: '', unit: '', direction: 'higher-better', primary: false, rationale: '' })
  editor.setRows([restoredRow('endpoint-1', 'first', 'grade.conflicts'), restoredRow('endpoint-2', 'second', 'elapsedMs')])
  ep('add').click()
  const keys = editor.getRows().map(row => row.key)
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3, 'no duplicate key after Add on a fresh realm: ' + keys.join(','))
  const newKey = keys[2]
  assert.notEqual(newKey, 'endpoint-1'); assert.notEqual(newKey, 'endpoint-2')
  assert.equal(ep('row').value, newKey, 'the new row is selected')
  // Editing the newly selected row must not disturb the restored rows.
  ep('id').value = 'third'; ep('id').dispatch('input')
  assert.deepEqual(editor.getRows().map(row => [row.key, row.id, row.source]), [
    ['endpoint-1', 'first', 'grade.conflicts'], ['endpoint-2', 'second', 'elapsedMs'], [newKey, 'third', 'passed'],
  ], 'editing the new row leaves the restored rows unchanged')
  // Selecting each restored row shows its own values, not the other row's or the new row's.
  ep('row').value = 'endpoint-1'; ep('row').dispatch('change')
  assert.equal(ep('id').value, 'first'); assert.equal(ep('source').value, 'grade.conflicts')
  ep('row').value = 'endpoint-2'; ep('row').dispatch('change')
  assert.equal(ep('id').value, 'second'); assert.equal(ep('source').value, 'elapsedMs')
  // Remove deletes only the selected row, leaving the other two untouched.
  ep('remove').click()
  assert.deepEqual(editor.getRows().map(row => row.key), ['endpoint-1', newKey], 'Remove deletes only the selected restored row')
})

// The third reviewer-reproduced defect, exercised through the mounted builder:
// literal paths must not be rewritten across import, the Analysis panel fields,
// reapply, the advanced specification JSON editor, and save/remount.
test('the builder shows and reapplies literal source and exposure paths without rewriting them, including through the advanced specification JSON editor', async t => {
  const { mount, idle } = await harness(t)
  const view = await mount()
  const draft = developmentStarter()
  draft.analysisPlan.endpoints = [
    { id: 'literal-dot', kind: 'count', source: { path: ['grade', 'a.b'] }, direction: 'higher-better', primary: false, unit: 'events', rationale: 'A source segment containing a literal dot.' },
    { id: 'digit-string', kind: 'rate', source: { path: ['grade', '0'] }, exposure: { path: ['reported', 'a.b'], unit: 'ms' }, direction: 'higher-better', primary: false, unit: 'per ms', rationale: 'A digit-only string segment and a dotted exposure path.' },
  ]
  await importDraft(view, idle, draft)
  const rowsAfterImport = JSON.parse(field(view, 'endpoint-fields').value)
  assert.deepEqual(rowsAfterImport.map(row => row.source), ['["grade","a.b"]', '["grade","0"]'], 'the Analysis panel fields show the literal JSON form, not a rewritten dotted one')
  assert.equal(rowsAfterImport[1].exposurePath, '["reported","a.b"]')
  field(view, 'apply-analysis').click(); await idle(view)
  assert.match(status(view), /Analysis plan applied with 2 typed endpoints/)
  let applied = JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints
  assert.deepEqual(applied.map(endpoint => endpoint.source.path), [['grade', 'a.b'], ['grade', '0']], 'reapplying from the fields keeps the exact original segments and types')
  assert.deepEqual(applied[1].exposure.path, ['reported', 'a.b'])
  // Through the advanced specification JSON editor: apply a full spec containing a nested numeric index directly.
  const specObj = JSON.parse(field(view, 'spec-json').value)
  specObj.analysisPlan.endpoints.push({ id: 'nested-index', kind: 'binary', source: { path: ['reported', 'usage', 0, 'tokens'] }, direction: 'higher-better', primary: false, unit: 'tokens', rationale: 'A nested numeric index.' })
  type(field(view, 'spec-json'), JSON.stringify(specObj))
  field(view, 'apply-spec').click(); await idle(view)
  assert.match(status(view), /Full specification applied/)
  const rowsAfterSpecApply = JSON.parse(field(view, 'endpoint-fields').value)
  assert.equal(rowsAfterSpecApply.length, 3)
  assert.equal(rowsAfterSpecApply[2].source, 'reported.usage.0.tokens', 'a path that round-trips through the dotted form keeps the dotted display')
  field(view, 'apply-analysis').click(); await idle(view)
  applied = JSON.parse(field(view, 'spec-json').value).analysisPlan.endpoints
  assert.deepEqual(applied.map(endpoint => endpoint.source.path), [['grade', 'a.b'], ['grade', '0'], ['reported', 'usage', 0, 'tokens']], 'reapplying after the advanced JSON edit keeps every literal path')
  // Save and remount retain the literal representation.
  field(view, 'save').click(); await idle(view)
  const again = await mount()
  const remounted = JSON.parse(field(again, 'spec-json').value).analysisPlan.endpoints
  assert.deepEqual(remounted.map(endpoint => endpoint.source.path), [['grade', 'a.b'], ['grade', '0'], ['reported', 'usage', 0, 'tokens']], 'the literal paths survive save and a fresh mount')
})


// Reviewer finding (Worker 6, per Manager 3's scope-addition message; reviewer/REVIEW.md was not located in this worktree to cite directly): a segment containing
// whitespace, a quote or a bracket character must round-trip losslessly
// through the field text, never silently trimmed or refused. The dotted
// form is unsafe for these because the whole text is trimmed once before
// re-parsing, and a leading '[' collides with the JSON-array heuristic.
test('a path segment with whitespace, a quote or a bracket character round-trips losslessly instead of being trimmed or refused', () => {
  const hostileSegments = ['a ', ' a', 'a b', ' ', 'a[b]', 'a"b', '[a]']
  for (const segment of hostileSegments) {
    const path = ['grade', segment]
    const text = pathText(path)
    assert.deepEqual(endpointPathFromText(text, 'x'), path, 'segment ' + JSON.stringify(segment) + ' round-trips through ' + JSON.stringify(text))
    // As the first segment too, where a bracket would otherwise make the
    // whole dotted text start with '[' and be misread as a JSON array.
    const leading = [segment, 'grade']
    assert.deepEqual(endpointPathFromText(pathText(leading), 'x'), leading, 'leading segment ' + JSON.stringify(segment) + ' round-trips')
  }
  // Through the real conversion functions, for both a source and an exposure path.
  const withHostileSource = endpointRowsFromPlan([{ id: 'x', kind: 'binary', source: { path: ['grade', 'a '] } }])
  assert.deepEqual(endpointsFromRows(withHostileSource)[0].source.path, ['grade', 'a '])
  const withHostileExposure = endpointRowsFromPlan([{ id: 'x', kind: 'rate', source: { path: ['passed'] }, exposure: { path: ['grade', ' '], unit: 'ms' } }])
  assert.deepEqual(endpointsFromRows(withHostileExposure)[0].exposure.path, ['grade', ' '])
  // A genuinely plain segment (no whitespace/dot/quote/bracket, not digit-only) still displays dotted, unchanged.
  assert.equal(pathText(['grade', 'conflicts']), 'grade.conflicts')
})

// Reviewer finding: setRows must not let a duplicate restored key survive --
// a draft persisted by a pre-fix build could hold two rows keyed identically.
test('setRows gives every row after a duplicate key a fresh distinct key, in a fresh module realm and through the mounted builder', async t => {
  {
    // A separate DOM stand-in installation, fully torn down before the mounted-builder
    // half installs its own: the two installations do not nest, and t.after hooks run
    // in registration order, so mixing them would tear the mounted builder's document
    // out from under its own cleanup.
    const installed = installDomStandIn(globalThis)
    const fresh = await import('../../src/research-endpoint-fields.js?realm=dup-' + Date.now() + '-' + Math.random())
    const editor = fresh.createEndpointFieldsEditor({ onChange: () => {} })
    document.body.append(editor.el)
    const duplicateRow = (id, source) => ({ key: 'endpoint-1', id, kind: 'binary', source, exposurePath: '', exposureUnit: 'ms', cap: '', unit: '', direction: 'higher-better', primary: false, rationale: '' })
    editor.setRows([duplicateRow('first', 'grade.conflicts'), duplicateRow('second', 'elapsedMs')])
    const rows = editor.getRows()
    assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.key)).size, 2, 'the duplicate key is not kept on both rows: ' + rows.map(row => row.key).join(','))
    assert.equal(rows[0].key, 'endpoint-1', 'the first holder of a key keeps it')
    assert.equal(rows[0].id, 'first'); assert.equal(rows[1].id, 'second')
    const ep = name => editor.el.querySelector('[data-endpoint-fields-' + name + ']')
    ep('row').value = rows[1].key; ep('row').dispatch('change'); ep('remove').click()
    assert.deepEqual(editor.getRows().map(row => [row.key, row.id]), [['endpoint-1', 'first']], 'Remove after dedup deletes exactly the targeted row, not both')
    editor.destroy(); installed.restore()
  }

  // Through the mounted builder: simulate a draft a pre-fix build persisted with a duplicate key.
  const { downloads, mount, idle } = await harness(t)
  const view = await mount()
  await importDraft(view, idle, developmentStarter())
  ep2(view, 'add').click(); await idle(view); type2(ep2(view, 'id'), 'first'); type2(ep2(view, 'source'), 'grade.conflicts')
  const corrupted = JSON.parse(field(view, 'endpoint-fields').value)
  corrupted.push({ ...corrupted[0], key: corrupted[0].key, id: 'second', source: 'elapsedMs' })
  field(view, 'endpoint-fields').value = JSON.stringify(corrupted); field(view, 'endpoint-fields').dispatch('input')
  field(view, 'save').click(); await idle(view); assert.match(status(view), /Draft saved/)
  const again = await mount()
  const optionValues = [...ep2(again, 'row').querySelectorAll('option')].map(option => option.value)
  assert.equal(optionValues.length, 2); assert.equal(new Set(optionValues).size, 2, 'a remounted duplicate-key draft is deduplicated: ' + optionValues.join(','))
  ep2(again, 'row').value = optionValues[1]; ep2(again, 'row').dispatch('change')
  const secondId = ep2(again, 'id').value
  ep2(again, 'remove').click(); await idle(again)
  const survivor = JSON.parse(field(again, 'endpoint-fields').value)
  assert.equal(survivor.length, 1, 'exactly one row survives Remove')
  assert.notEqual(survivor[0].id, secondId, 'the removed row is the one that was selected, not the other')
  assert.equal(downloads.length, 0)
})

// Reviewer finding: a restored key at or beyond Number.MAX_SAFE_INTEGER must
// not make nextKey loop forever (9007199254740992 + 1 === 9007199254740992
// in IEEE 754 double arithmetic, so an unguarded adopted counter can get
// stuck producing the same already-taken string on every iteration).
test('a restored key beyond the safe integer range does not hang key issuance, and every key stays distinct', () => {
  const installed = installDomStandIn(globalThis)
  const editor = createEndpointFieldsEditor({ onChange: () => {} })
  try {
    document.body.append(editor.el)
    editor.setRows([
      { key: 'endpoint-9007199254740993', id: 'huge', kind: 'binary', source: 'passed', exposurePath: '', exposureUnit: 'ms', cap: '', unit: '', direction: 'higher-better', primary: false, rationale: '' },
      { key: 'endpoint-abc', id: 'non-numeric', kind: 'binary', source: 'passed', exposurePath: '', exposureUnit: 'ms', cap: '', unit: '', direction: 'higher-better', primary: false, rationale: '' },
    ])
    const ep = name => editor.el.querySelector('[data-endpoint-fields-' + name + ']')
    ep('add').click()
    ep('add').click()
    const keys = editor.getRows().map(row => row.key)
    assert.equal(keys.length, 4)
    assert.equal(new Set(keys).size, 4, 'every key stays distinct after Add: ' + keys.join(','))
  } finally { editor.destroy(); installed.restore() }
})
