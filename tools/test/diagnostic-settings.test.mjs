/* DIAGNOSTIC FILES beside the retention row (owner direction 2026-09-20,
 * T782/T783). The panel is driven by value through a recording bridge shaped
 * like shell/fleet-profile-preload.cjs mcSettings.diagnosticsInspect / Keep /
 * Export / Archive, whose answers are the Engine's own shapes
 * (engine src/lib/diagnostic-retention.js inspect/keep/exportFile/archiveFile):
 *   - the first page is read once, after render, and each file is listed with
 *     its kind, time, size and state;
 *   - Keep is a toggle sent as { id, keep }; Export and Archive send { id } and
 *     say what happened, including a cancelled export and a file still being
 *     written;
 *   - an incomplete page offers Show more, which continues the same cursor;
 *   - unreadable files are counted and said to stop automatic cleanup;
 *   - a busy, closing or absent store is said as such, never as an empty list;
 *   - every id and kind is escaped; a destroyed panel paints nothing late;
 *   - (T786 F2/F4/F5/F6) a row's archive flag is a preference, not a move; a
 *     listing and a per-file action never overlap; totals are the last
 *     maintenance pass's, an unfinished pass is not unreadability; a dropped
 *     count is this run's and points at no page (a listed suppressed row is
 *     not necessarily the writer that dropped).
 * The same panel over the actual Engine store and shell facade, in memory,
 * is diagnostic-files-real-service.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDiagnosticSettings, DIAGNOSTIC_REASONS, diagnosticReason } from '../../src/diagnostic-settings.js'

const settle = () => new Promise(resolve => setImmediate(resolve))

function host() {
  const handlers = new Map()
  const panel = { outerHTML: '' }
  return { handlers, panel, root: {
    addEventListener(type, fn) { handlers.set(type, fn) }, removeEventListener(type) { handlers.delete(type) },
    querySelector() { return panel },
  } }
}

/* A click on one control: the handler only needs closest() for the button and
   for the panel, the attributes it reads, and disabled. */
function press(fixture, attributes, { disabled = false } = {}) {
  const button = {
    disabled,
    hasAttribute: name => Object.hasOwn(attributes, name),
    getAttribute: name => Object.hasOwn(attributes, name) ? attributes[name] : null,
    closest: selector => (selector === '[data-diagnostic-files]' ? {} : button),
  }
  return fixture.handlers.get('click')({ target: { closest: () => button } })
}

const file = (id, extra = {}) => ({ id, kind: 'main-lag', pid: 4242, createdAt: Date.UTC(2026, 8, 20, 12, 0, 0), bytes: 2048, active: false, keep: false, archive: false, outputSuppressed: null, ...extra })
const page = (files, extra = {}) => ({ ok: true, reason: null, complete: true, scanComplete: true, unknownCount: 0, entriesThisPage: files.length, files, managedBytes: 4096, protectedBytes: 0, projectedBytes: extra.managedBytes ?? 4096, budgetMet: true, policy: {}, ...extra })

function bridge(answers = {}) {
  const calls = []
  const answer = (name, fallback) => async request => { calls.push({ name, request: request === undefined ? undefined : { ...request } }); return typeof answers[name] === 'function' ? answers[name](request) : (answers[name] ?? fallback) }
  return { calls,
    diagnosticsInspect: answer('diagnosticsInspect', page([])),
    diagnosticsKeep: answer('diagnosticsKeep', { ok: true }),
    diagnosticsExport: answer('diagnosticsExport', { ok: true, destination: '/tmp/out.jsonl', bytes: 1 }),
    diagnosticsArchive: answer('diagnosticsArchive', { ok: true, archivePath: '/tmp/archive/x' }) }
}

test('the first page is read after render and every file is listed with kind, time, size, state and its three controls', async () => {
  const fixture = host()
  const b = bridge({ diagnosticsInspect: page([file('d-1'), file('d-2', { kind: 'main-heap', keep: true, bytes: 3 * 1024 * 1024 }), file('d-3', { kind: 'exit-record', active: true }), file('d-4', { kind: 'native-decisions', archive: true, outputSuppressed: 'diagnostic-output-budget' })], { managedBytes: 5 * 1024 * 1024, protectedBytes: 3 * 1024 * 1024 }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root)
  assert.match(controller.markup(), /Reading diagnostic files…/, 'before the read, the panel says it is reading, not that there is nothing')
  controller.afterRender()
  controller.afterRender()
  await settle()
  assert.deepEqual(b.calls.map(call => call.name), ['diagnosticsInspect'], 'one read for two renders')
  assert.deepEqual(b.calls[0].request, { next: false })
  const html = controller.markup()
  assert.match(html, /Diagnostic files/)
  assert.match(html, /Nothing here deletes a file/)
  assert.match(html, /5\.00 MB of diagnostics counted by the last maintenance pass; 3\.00 MB of that is kept or still being written\./, 'the totals are the last pass\'s census, said as such')
  assert.match(html, /data-diagnostic-census[^>]*>4 files listed\.</, 'a complete scan lists its count without "so far"')
  assert.doesNotMatch(html, /data-diagnostic-target|data-diagnostic-dropped/, 'no policy and no dropped records: nothing invented about them')
  assert.match(html, /App stall record/)
  assert.match(html, /Memory record/)
  assert.match(html, /Exit record/)
  assert.match(html, /Native decision record/)
  assert.match(html, /2\.0 KB · Expires with the retention window/)
  assert.match(html, /3\.00 MB · Kept past the retention window/)
  assert.match(html, /Still being written/)
  assert.match(html, /Archives instead of expiring when the retention window reaches it · output was cut at the diagnostic budget/, 'archive is the Engine\'s preference for the file, not a move that happened')
  assert.doesNotMatch(html, /Archived/, 'nothing on the page calls an archive preference a completed move')
  assert.match(html, /data-diagnostic-keep="d-2" aria-pressed="true" >Kept</)
  assert.match(html, /data-diagnostic-keep="d-1" aria-pressed="false" >Keep</)
  assert.match(html, /data-diagnostic-export="d-3" disabled/, 'a file still being written cannot be exported')
  assert.match(html, /data-diagnostic-archive="d-3" disabled/, 'nor archived')
  assert.match(html, /data-diagnostic-keep="d-4" aria-pressed="false" >Keep</, 'a file that prefers archiving is still in the live folder: Keep stays valid')
  assert.match(html, /data-diagnostic-export="d-4" >Export…</, 'so does Export')
  assert.match(html, /data-diagnostic-archive="d-4" >Archive</, 'and an explicit Archive now')
  assert.doesNotMatch(html, /data-diagnostic-more/, 'a complete scan offers no more')
  assert.doesNotMatch(html, /data-diagnostic-unread/)
  assert.match(html, /data-diagnostic-refresh >Refresh/)
  controller.destroy()
})

test('Keep toggles through the bridge as { id, keep } and the row follows the answer, not the press', async () => {
  const fixture = host()
  const b = bridge({ diagnosticsInspect: page([file('d-1'), file('d-2', { keep: true })]), diagnosticsKeep: request => ({ ok: true, id: request.id, keep: request.keep }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root)
  controller.afterRender()
  await settle()
  await press(fixture, { 'data-diagnostic-keep': 'd-1' })
  await press(fixture, { 'data-diagnostic-keep': 'd-2' })
  assert.deepEqual(b.calls.slice(1).map(call => [call.name, call.request]), [['diagnosticsKeep', { id: 'd-1', keep: true }], ['diagnosticsKeep', { id: 'd-2', keep: false }]])
  assert.equal(controller.files.find(f => f.id === 'd-1').keep, true)
  assert.equal(controller.files.find(f => f.id === 'd-2').keep, false)
  assert.match(controller.markup(), /data-diagnostic-keep="d-1" aria-pressed="true" >Kept</)
  assert.match(controller.markup(), /data-diagnostic-keep="d-2" aria-pressed="false" >Keep</)

  const refused = bridge({ diagnosticsInspect: page([file('d-1')]), diagnosticsKeep: { ok: false, reason: 'diagnostic-busy' } })
  const g = host(), other = createDiagnosticSettings({ bridge: refused })
  other.bind(g.root); other.afterRender(); await settle()
  await press(g, { 'data-diagnostic-keep': 'd-1' })
  assert.equal(other.files[0].keep, false, 'a refused keep leaves the row as it was')
  assert.match(other.markup(), /Another diagnostic operation is still running\. Try again in a moment\./)
  await press(g, { 'data-diagnostic-keep': 'd-9' })
  assert.equal(refused.calls.filter(call => call.name === 'diagnosticsKeep').length, 1, 'an id that is not listed sends nothing')
  controller.destroy(); other.destroy()
})

test('Export sends { id } and reports the destination, a cancelled chooser, and a file still being written', async () => {
  const fixture = host()
  const b = bridge({ diagnosticsInspect: page([file('d-1'), file('d-2')]), diagnosticsExport: request => (request.id === 'd-1' ? { ok: true, id: 'd-1', destination: '/home/redacted-profile/exports/d-1.jsonl', bytes: 2048 } : { ok: false, reason: 'cancelled' }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  await press(fixture, { 'data-diagnostic-export': 'd-1' })
  assert.deepEqual(b.calls.at(-1), { name: 'diagnosticsExport', request: { id: 'd-1' } })
  assert.match(controller.markup(), /Exported to \/home\/person\/exports\/d-1\.jsonl\./)
  await press(fixture, { 'data-diagnostic-export': 'd-2' })
  assert.match(controller.markup(), /Export cancelled\. Nothing was copied\./)

  const active = bridge({ diagnosticsInspect: page([file('d-3', { active: true })]), diagnosticsExport: { ok: false, reason: 'diagnostic-active' } })
  const g = host(), other = createDiagnosticSettings({ bridge: active })
  other.bind(g.root); other.afterRender(); await settle()
  await press(g, { 'data-diagnostic-export': 'd-3' }, { disabled: true })
  assert.equal(active.calls.filter(call => call.name === 'diagnosticsExport').length, 0, 'a disabled control sends nothing')
  await press(g, { 'data-diagnostic-export': 'd-3' })
  assert.match(other.markup(), /still being written by a running process\. Export or archive it after it closes\./, 'and the Engine\'s own refusal is said when it arrives anyway')
  controller.destroy(); other.destroy()
})

test('Archive sends { id }; only the confirmed answer marks the row moved and retires its controls; a refusal is said', async () => {
  const fixture = host()
  const b = bridge({ diagnosticsInspect: page([file('d-1', { archive: true }), file('d-2')]), diagnosticsArchive: request => (request.id === 'd-1' ? { ok: true, id: 'd-1', archivePath: '/managed/archive/d-1/d-1' } : { ok: false, reason: 'diagnostic-busy' }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  assert.equal(controller.files.find(f => f.id === 'd-1').moved, undefined, 'the inspection never says a row moved')
  await press(fixture, { 'data-diagnostic-archive': 'd-1' })
  assert.deepEqual(b.calls.at(-1), { name: 'diagnosticsArchive', request: { id: 'd-1' } })
  assert.equal(controller.files.find(f => f.id === 'd-1').moved, true)
  assert.equal(controller.files.find(f => f.id === 'd-1').archive, true, 'the Engine\'s preference flag is left as it came')
  const html = controller.markup()
  assert.match(html, /Moved to the archive folder \(\/managed\/archive\/d-1\/d-1\)\./)
  assert.match(html, /data-diagnostic-file="d-1"[\s\S]*?· Moved to the archive folder</, 'the row says it moved')
  assert.match(html, /data-diagnostic-keep="d-1" aria-pressed="false" disabled/, 'a moved row is out of the live folder: no Keep')
  assert.match(html, /data-diagnostic-export="d-1" disabled/, 'no Export')
  assert.match(html, /data-diagnostic-archive="d-1" disabled/, 'and it cannot be archived twice')
  await press(fixture, { 'data-diagnostic-keep': 'd-1' })
  assert.equal(b.calls.filter(call => call.name === 'diagnosticsKeep').length, 0, 'a stale press on a moved row sends nothing')
  await press(fixture, { 'data-diagnostic-archive': 'd-2' })
  assert.equal(controller.files.find(f => f.id === 'd-2').moved, undefined, 'a refused move marks nothing')
  assert.match(controller.markup(), /Another diagnostic operation is still running/)
  assert.match(controller.markup(), /data-diagnostic-archive="d-2" >Archive</, 'and the row keeps its controls')
  controller.destroy()
})

/* T786 F4: a listing (Refresh, Show more) replaces the rows; an action's
   answer belongs to the row with that id. The two never overlap: while a
   Keep is pending the listing controls are held and a stale press is
   refused; while a listing is in flight the row controls are held and a
   stale press is refused; the answer is applied to the row current when it
   arrives. */
test('a pending Keep holds Refresh and Show more, a listing in flight holds the row controls, and the answer lands on the current row', async () => {
  const fixture = host()
  let releaseKeep
  const b = bridge({ diagnosticsInspect: page([file('d-1')], { scanComplete: false, complete: false }), diagnosticsKeep: () => new Promise(resolve => { releaseKeep = resolve }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  press(fixture, { 'data-diagnostic-keep': 'd-1' })
  assert.match(fixture.panel.outerHTML, /data-diagnostic-refresh disabled/, 'Refresh is held while the keep is pending')
  assert.match(fixture.panel.outerHTML, /data-diagnostic-more disabled/, 'so is Show more')
  await press(fixture, { 'data-diagnostic-refresh': '' })
  await press(fixture, { 'data-diagnostic-more': '' })
  assert.deepEqual(b.calls.map(call => call.name), ['diagnosticsInspect', 'diagnosticsKeep'], 'stale presses on the held listing controls read nothing')
  releaseKeep({ ok: true, id: 'd-1', keep: true })
  await settle()
  assert.equal(controller.files[0].keep, true, 'the answer is applied to the row that is current when it arrives')
  assert.match(fixture.panel.outerHTML, /data-diagnostic-keep="d-1" aria-pressed="true" >Kept</)
  assert.match(fixture.panel.outerHTML, /data-diagnostic-refresh >Refresh/, 'and the listing controls are released')

  let releaseInspect
  const late = bridge({ diagnosticsInspect: () => new Promise(resolve => { releaseInspect = resolve }), diagnosticsKeep: { ok: true, keep: true } })
  const g = host(), other = createDiagnosticSettings({ bridge: late })
  other.bind(g.root); other.afterRender()
  releaseInspect(page([file('d-1')])); await settle()
  press(g, { 'data-diagnostic-refresh': '' })
  assert.match(g.panel.outerHTML, /data-diagnostic-keep="d-1" aria-pressed="false" disabled/, 'row controls are held while the listing is in flight')
  assert.match(g.panel.outerHTML, /data-diagnostic-export="d-1" disabled/)
  await press(g, { 'data-diagnostic-keep': 'd-1' })
  assert.equal(late.calls.filter(call => call.name === 'diagnosticsKeep').length, 0, 'a stale Keep press during the listing sends nothing')
  releaseInspect(page([file('d-1', { keep: true })])); await settle()
  assert.equal(other.files[0].keep, true, 'the listing\'s own answer is what the row shows')
  assert.match(g.panel.outerHTML, /data-diagnostic-keep="d-1" aria-pressed="true" >Kept</, 'and the controls are released')
  controller.destroy(); other.destroy()
})

test('an incomplete page offers Show more, which continues the same cursor and appends; unreadable files are counted and stop cleanup', async () => {
  const fixture = host()
  let reads = 0
  const b = bridge({ diagnosticsInspect: request => {
    reads += 1
    if (!request.next) return page([file('d-1')], { scanComplete: false, complete: false })
    return page([file('d-2')], { ok: false, reason: 'diagnostic-candidate-unreadable', unknownCount: 2, complete: false, scanComplete: true, budgetMet: null, managedBytes: null })
  } })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  assert.match(controller.markup(), /data-diagnostic-more/)
  assert.match(controller.markup(), /The list so far is a page, not the whole folder\./)
  await press(fixture, { 'data-diagnostic-more': '' })
  assert.deepEqual(b.calls.map(call => call.request), [{ next: false }, { next: true }])
  assert.deepEqual(controller.files.map(f => f.id), ['d-1', 'd-2'], 'the second page is appended, not swapped in')
  const html = controller.markup()
  assert.doesNotMatch(html, /data-diagnostic-more/, 'the folder has been walked')
  assert.match(html, /data-diagnostic-unread[^>]*>2 files in the diagnostic folder could not be read\. Automatic cleanup is stopped until they can be; nothing was deleted\./)
  assert.match(html, /Some files in the diagnostic folder could not be read/, 'the page-level reason is the notice')
  assert.doesNotMatch(html, /data-diagnostic-storage/, 'no storage total is invented for a folder that could not be fully read when nothing known was reported either')
  assert.match(html, /data-diagnostic-census[^>]*>2 files listed, not counting the 2 that could not be read\.</)
  assert.doesNotMatch(html, /No closed diagnostic files are on this computer/, 'a partial census is never an empty inventory')
  await press(fixture, { 'data-diagnostic-refresh': '' })
  assert.equal(reads, 3)
  assert.deepEqual(controller.files.map(f => f.id), ['d-1'], 'Refresh starts over from the first page')
  controller.destroy()
})

test('a busy, closing, absent or unavailable store is said as such, never as an empty list', async () => {
  for (const [answer, expect] of [
    [{ ok: false, reason: 'diagnostic-busy', files: [] }, /Another diagnostic operation is still running/],
    [{ ok: false, reason: 'closed', files: [] }, /closing with the application/],
    [page([], { ok: true, reason: 'no-managed-diagnostics', managedBytes: 0 }), /No diagnostic files have been written yet\./],
    [{ ok: false, reason: 'diagnostic-root-unavailable', files: [] }, /diagnostic folder could not be read, so automatic cleanup is paused/],
    [{ ok: false, reason: 'DIAGNOSTICS_UNAVAILABLE', files: [] }, /unavailable on this copy/],
    [{ ok: false, reason: 'something-new', files: [] }, /something-new/],
    [() => undefined, /Diagnostic storage did not answer\./],
    [() => 'not an object', /Diagnostic storage did not answer\./],
  ]) {
    const fixture = host()
    const controller = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: answer }) })
    controller.bind(fixture.root); controller.afterRender(); await settle()
    assert.match(controller.markup(), expect, String(JSON.stringify(answer) ?? answer))
    if (answer?.reason !== 'no-managed-diagnostics') assert.doesNotMatch(controller.markup(), /No closed diagnostic files are on this computer right now/, String(JSON.stringify(answer) ?? answer))
    controller.destroy()
  }
  const thrown = host()
  const throwing = createDiagnosticSettings({ bridge: { diagnosticsInspect: async () => { throw new Error('bridge exploded') } } })
  throwing.bind(thrown.root); throwing.afterRender(); await settle()
  assert.match(throwing.markup(), /bridge exploded/)
  throwing.destroy()
  const missing = createDiagnosticSettings({ bridge: undefined })
  const m = host(); missing.bind(m.root); missing.afterRender(); await settle()
  // A window with no bridge at all (a browser copy) is still a sentence: where the files live (T1518).
  assert.match(missing.markup(), /Diagnostic files are kept and listed in the ToolsEnabled desktop app/, 'no bridge at all is still a sentence')
  missing.destroy()
})

test('ids and kinds are escaped, a destroyed panel paints nothing late, and search finds the panel by what it does', async () => {
  const fixture = host()
  let release
  const b = bridge({ diagnosticsInspect: page([file('<img src=x onerror=alert(1)>', { kind: '<b>kind</b>' })]), diagnosticsKeep: () => new Promise(resolve => { release = resolve }) })
  const controller = createDiagnosticSettings({ bridge: b })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  const html = controller.markup()
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;b&gt;kind&lt;\/b&gt;/)
  fixture.panel.outerHTML = 'painted'
  const pending = press(fixture, { 'data-diagnostic-keep': '<img src=x onerror=alert(1)>' })
  assert.match(fixture.panel.outerHTML, /data-diagnostic-keep="&lt;img src=x onerror=alert\(1\)&gt;" aria-pressed="false" disabled/, 'while the keep is in flight its control is held')
  controller.destroy()
  fixture.panel.outerHTML = 'after destroy'
  release({ ok: true, keep: true })
  await pending
  assert.equal(fixture.panel.outerHTML, 'after destroy', 'a late answer paints nothing on a destroyed panel')
  assert.equal(fixture.handlers.has('click'), false, 'and the listener is gone')
  assert.equal(controller.matches('diagnostic'), true)
  assert.equal(controller.matches('archive export keep'), true)
  assert.equal(controller.matches('stall memory'), true)
  assert.equal(controller.matches('firewall'), false)
  assert.equal(diagnosticReason('cancelled'), DIAGNOSTIC_REASONS.cancelled)
  assert.equal(diagnosticReason(undefined, 'fallback'), 'fallback')
})

/* M7'S FINAL INSPECTION CONTRACT, said as it is: complete (walked to the end,
   every managed file read) is the only state that means an empty folder;
   totals are null -- never zero -- while files cannot be read, and the known
   bytes are said to be partial; dropped records and the retention target are
   disclosed in the Engine's own terms; a keep-everything choice says it has
   no limit. */
test('an incomplete or unreadable scan is never called an empty inventory; null totals are not zero; known bytes are partial', async () => {
  const cases = [
    ['a first page of an incomplete scan with nothing readable yet', page([], { scanComplete: false, complete: false }), { empty: false, more: true }],
    ['an unreadable folder with no readable rows', page([], { ok: false, reason: 'diagnostic-candidate-unreadable', unknownCount: 3, complete: false, scanComplete: true, managedBytes: null, protectedBytes: null, budgetMet: null, knownManagedBytes: 0, knownProtectedBytes: 0 }), { empty: false, more: false }],
    ['a complete, fully read, empty folder', page([], { complete: true, scanComplete: true, managedBytes: 0, protectedBytes: 0 }), { empty: true, more: false }],
  ]
  for (const [why, answer, expect] of cases) {
    const fixture = host(), controller = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: answer }) })
    controller.bind(fixture.root); controller.afterRender(); await settle()
    const html = controller.markup()
    assert.equal(/No closed diagnostic files are on this computer right now/.test(html), expect.empty, why)
    assert.equal(/data-diagnostic-more/.test(html), expect.more, why + ': Show more follows scanComplete alone')
    assert.doesNotMatch(html, /0 bytes of diagnostics on this computer; /, why + ': a null total is not painted as zero')
    controller.destroy()
  }

  const partial = host()
  const p = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-1')], { ok: false, reason: 'diagnostic-candidate-unreadable', unknownCount: 1, complete: false, scanComplete: true,
    managedBytes: null, protectedBytes: null, projectedBytes: null, budgetMet: null, knownManagedBytes: 6 * 1024 * 1024, knownProtectedBytes: 2 * 1024 * 1024 }) }) })
  p.bind(partial.root); p.afterRender(); await settle()
  const html = p.markup()
  assert.match(html, /data-diagnostic-storage[^>]*>at least 6\.00 MB of diagnostics counted by the last maintenance pass; the total is unknown while some files cannot be read; at least 2\.00 MB of that is kept or still being written\./)
  assert.match(html, /data-diagnostic-census[^>]*>1 file listed, not counting the 1 that could not be read\./)
  assert.match(html, /data-diagnostic-unread/)
  assert.doesNotMatch(html, /above the retention target/, 'budgetMet null says nothing about the target')
  assert.doesNotMatch(html, /data-diagnostic-more/, 'the directory was walked to its end: nothing more to show, even though the census is partial')
  p.destroy()

  /* T786 F5: a maintenance pass that had not reached the end of the folder
     reports a known part, a null total and NO unknown files. That is an
     unfinished count, not unreadability, and is said so; the last pass's
     complete totals are said to be that pass's, beside what it left. */
  const unfinished = host()
  const u = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-1'), file('d-2')], { unknownCount: 0, complete: true, scanComplete: true,
    managedBytes: null, protectedBytes: null, projectedBytes: null, budgetMet: null, knownManagedBytes: 3 * 1024 * 1024, knownProtectedBytes: 0 }) }) })
  u.bind(unfinished.root); u.afterRender(); await settle()
  assert.match(u.markup(), /data-diagnostic-storage[^>]*>at least 3\.00 MB of diagnostics counted so far by the last maintenance pass; its total is not known yet\./)
  assert.doesNotMatch(u.markup(), /cannot be read|data-diagnostic-unread/, 'an unfinished pass is not called unreadable')
  assert.doesNotMatch(u.markup(), /No closed diagnostic files are on this computer/, 'and the two listed rows are not an empty folder')
  u.destroy()

  const acted = host()
  const a = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([], { managedBytes: 9 * 1024 * 1024, protectedBytes: 1024 * 1024, projectedBytes: 1024 * 1024, budgetMet: true }) }) })
  a.bind(acted.root); a.afterRender(); await settle()
  assert.match(a.markup(), /data-diagnostic-storage[^>]*>9\.00 MB of diagnostics counted by the last maintenance pass; 1\.00 MB of that is kept or still being written; about 1\.00 MB after that pass acted\./, 'a census taken before the pass acted is not called the folder now')
  assert.match(a.markup(), /No closed diagnostic files are on this computer right now\./, 'so it can stand beside an empty current list without contradiction')
  a.destroy()
})

test('the retention target is an eventual closed-file target, a keep-everything choice has no limit, and dropped records are disclosed', async () => {
  const finite = host()
  const f = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-1', { outputSuppressed: 'diagnostic-output-budget' })], { budgetMet: false, managedBytes: 70 * 1024 * 1024, protectedBytes: 1024,
    policy: { cleanup: true, maxAgeDays: 7, maxBytes: 64 * 1024 * 1024 }, writers: [{ id: 'w-1', kind: 'main-lag', dropped: 12 }, { id: 'w-2', kind: 'main-heap', dropped: 0 }] }) }) })
  f.bind(finite.root); f.afterRender(); await settle()
  let html = f.markup()
  // T1336: the limit is named in the unit its choice uses ('7 days / 64 MiB'), not as decimal MB.
  assert.match(html, /data-diagnostic-target[^>]*>Closed files are removed when they reach 7 days or when storage exceeds 64 MiB\. That is an eventual target for closed files, not a hard limit\. Files still being written, kept files and unreadable files can hold the folder above it\./)
  assert.match(html, /above the retention target at that pass; files being written, kept files and unreadable files are never removed to meet it/)
  assert.match(html, /data-diagnostic-dropped[^>]*>12 diagnostic records were dropped in this application run after a writer reached its output budget; the work itself continued\. A file whose output was cut carries a mark where it appears in this list\./)
  assert.doesNotMatch(html, /marked below/, 'the aggregate names no page: a listed suppressed row is not necessarily the writer that dropped')
  assert.match(html, /output was cut at the diagnostic budget/, 'the suppressed file is marked')
  f.destroy()

  /* T786 F6 (M7's T789 correction): the dropped count is this run's writers';
     the file a drop was recorded on need not be on the page, and a listed
     suppressed row is not necessarily the writer that dropped. The aggregate
     points at no page in either shape. */
  const keep = host()
  const k = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-1')], { policy: { cleanup: false, maxAgeDays: null, maxBytes: null }, writers: [{ id: 'w-1', kind: 'main-lag', dropped: 1 }] }) }) })
  k.bind(keep.root); k.afterRender(); await settle()
  html = k.markup()
  assert.match(html, /data-diagnostic-target[^>]*>Your retention choice keeps every diagnostic file, with no storage limit\./)
  assert.match(html, /1 diagnostic record was dropped in this application run after a writer reached its output budget; the work itself continued\. A file whose output was cut carries a mark where it appears in this list\./)
  assert.doesNotMatch(html, /marked below/, 'no listed row carries the mark, so nothing below is promised')
  k.destroy()

  /* The confusing shape M7 named: an OLD suppressed row (d-old) is on this
     page, but the writer that just dropped (w-b) is a DIFFERENT file that is
     paged off. The old "marked below" wording let d-old stand in for w-b's
     file; the neutral wording claims nothing about a page. */
  const mixed = host()
  const m = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-old', { outputSuppressed: 'diagnostic-output-budget' })],
    { scanComplete: false, complete: false, writers: [{ id: 'w-b', kind: 'main-heap', dropped: 4 }] }) }) })
  m.bind(mixed.root); m.afterRender(); await settle()
  html = m.markup()
  assert.match(html, /4 diagnostic records were dropped in this application run after a writer reached its output budget; the work itself continued\. A file whose output was cut carries a mark where it appears in this list\./)
  assert.doesNotMatch(html, /marked below/, 'the old suppressed row d-old must not make the paged-off dropping writer w-b claim it is marked below')
  assert.match(html, /data-diagnostic-file="d-old"[\s\S]*output was cut at the diagnostic budget/, 'the old row still carries its own mark where it appears')
  m.destroy()

  const unknown = host()
  const u = createDiagnosticSettings({ bridge: bridge({ diagnosticsInspect: page([file('d-1')], { policy: { mode: 'blocked', cleanup: false, maxAgeDays: null, maxBytes: null, reason: 'The saved diagnostic retention choice is unreadable. Existing files are retained.' } }) }) })
  u.bind(unknown.root); u.afterRender(); await settle()
  assert.match(u.markup(), /The saved diagnostic retention choice is unreadable\. Existing files are retained\./)
  assert.doesNotMatch(u.markup(), /Your retention choice keeps every|when storage exceeds/, 'an unreadable choice is not an intentional keep-everything policy')
  u.destroy()
})

test('a browser copy with no diagnostic storage says where the files live and offers no Refresh', async () => {
  // T1518: 'Diagnostic storage did not answer.' twice, and a Refresh that could never work.
  const fixture = host()
  const controller = createDiagnosticSettings({ bridge: {} })
  controller.bind(fixture.root)
  controller.afterRender()
  await settle()
  const html = controller.markup()
  assert.match(html, /Diagnostic files are kept and listed in the ToolsEnabled desktop app/)
  assert.doesNotMatch(html, /did not answer/)
  assert.doesNotMatch(html, /data-diagnostic-refresh/, 'a Refresh that cannot read anything is offered')
  // An installed copy whose storage does not answer keeps its sentence.
  const quiet = createDiagnosticSettings({ bridge: { diagnosticsInspect: async () => null } })
  quiet.bind(host().root); quiet.afterRender(); await settle()
  assert.match(quiet.markup(), /did not answer/)
  controller.destroy(); quiet.destroy()
})
