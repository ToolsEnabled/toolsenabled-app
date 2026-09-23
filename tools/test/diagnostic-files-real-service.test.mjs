/* THE DIAGNOSTIC FILES PANEL OVER THE ACTUAL SERVICE (T786 F2/F4/F5/F6).
 * No recording bridge here: the panel is driven through the shell's own
 * facade (shell/product-settings.cjs createProductDiagnostics, the object
 * behind mcSettings.diagnosticsInspect / Keep / Export / Archive) over the
 * Engine's own store (engine src/lib/diagnostic-retention.js) on the Engine's
 * in-memory test filesystem, so every answer shape, flag and total is the
 * producer's. Nothing touches the disk and nothing is deleted anywhere; the
 * Engine's own unlinks happen inside the in-memory filesystem.
 *   - a file opened under the Archive choice carries the Engine's archive
 *     preference while still in the live folder: it is listed as such, with
 *     Keep, Export and Archive all valid, and only this panel's confirmed
 *     Archive says it moved (the Engine then no longer lists it);
 *   - a Keep whose answer is still pending holds Refresh; the answer lands
 *     on the row current when it arrives; the next Refresh reads the Engine's
 *     own metadata and agrees;
 *   - the totals are the last maintenance pass's census, said as such, and
 *     stand beside an empty current list after that pass acted; a pass that
 *     had not reached the end of the folder is an unfinished count, not
 *     unreadability; a managed-looking file without metadata is;
 *   - a dropped count is this run's OPEN writers'; the aggregate points at no
 *     page, so an old closed suppressed file listed here does not make the
 *     current dropping writer read as "marked below" (T786 F6, M7's T789).
 * The Engine is resolved like every other integration fixture here
 * (tools/canonical-root.mjs, MC_CANONICAL_ROOT).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { createDiagnosticSettings } from '../../src/diagnostic-settings.js'
import { formatBytes as bytesWords } from '../../src/account-reset-copy.js'

const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests()
const retention = require(path.join(engineRoot, 'src/lib/diagnostic-retention.js'))
const { memoryFs } = require(path.join(engineRoot, 'tests/helpers/diagnostic-memory-fs.js'))
const { createProductDiagnostics } = require('../../shell/product-settings.cjs')

const settle = async (rounds = 6) => { for (let round = 0; round < rounds; round++) await new Promise(resolve => setImmediate(resolve)) }
const rx = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function host() {
  const handlers = new Map()
  const panel = { outerHTML: '' }
  return { handlers, panel, root: {
    addEventListener(type, fn) { handlers.set(type, fn) }, removeEventListener(type) { handlers.delete(type) },
    querySelector() { return panel },
  } }
}

function press(fixture, attributes, { disabled = false } = {}) {
  const button = {
    disabled,
    hasAttribute: name => Object.hasOwn(attributes, name),
    getAttribute: name => Object.hasOwn(attributes, name) ? attributes[name] : null,
    closest: selector => (selector === '[data-diagnostic-files]' ? {} : button),
  }
  return fixture.handlers.get('click')({ target: { closest: () => button } })
}

/* The actual store on the Engine's in-memory filesystem, behind the actual
   shell facade, offered to the panel under the four names the preload
   exposes. */
function service({ choice = retention.DEFAULT_CHOICE, limits } = {}) {
  const disk = memoryFs(), directory = path.resolve('synthetic-ui-diagnostics')
  let at = Date.UTC(2026, 8, 20, 12, 0, 0), number = 0
  const store = retention.createDiagnosticStore({ directory, fs: disk, pid: 4242, now: () => at,
    uuid: () => '00000000-0000-0000-0000-' + String(++number).padStart(12, '0'),
    readPolicy: () => retention.resolveDiagnosticPolicy(choice), isAlive: () => false, limits,
    schedule: () => ({ unref() {} }), cancel() {} })
  const facade = createProductDiagnostics({ engineRoot, retentionModule: retention, store, chooseExport: async () => ({ canceled: true }) })
  const inspects = []
  const bridge = {
    diagnosticsInspect: request => { inspects.push(request); return facade.inspect(request) },
    diagnosticsKeep: request => facade.keep(request),
    diagnosticsExport: request => facade.export(request),
    diagnosticsArchive: request => facade.archive(request),
  }
  return { disk, directory, store, facade, bridge, inspects,
    age(days) { at += days * 86400000 },
    closed(kind = 'main-lag', text = 'diagnostic fixture') {
      const writer = store.createWriter(kind)
      assert.equal(writer.append(text).written, true)
      const id = writer.state().id
      writer.close()
      return id
    },
    async maintain() {
      let result
      for (let pass = 0; pass < 100; pass++) { result = await store.maintenance(); if (result.scanComplete) return result }
      throw new Error('the synthetic census did not finish')
    },
    unlinked: () => disk.unlinks.filter(name => !name.endsWith('.lock')),
  }
}

async function mount(bridge) {
  const fixture = host(), controller = createDiagnosticSettings({ bridge })
  controller.bind(fixture.root); controller.afterRender(); await settle()
  return { fixture, controller }
}

test('F2: under the Archive choice a closed file carries the archive preference while still in the live folder, keeps its three controls, and is said to have moved only after this panel\'s confirmed Archive', async () => {
  const f = service({ choice: 'Archive diagnostics' })
  const id = f.closed('native-stream')
  const view = await f.facade.inspect({ next: false })
  assert.equal(view.files[0].archive, true, 'the Engine stamps the preference when the file is opened')
  assert.equal(view.files[0].active, false)
  assert.ok(f.disk.files.has(path.join(f.directory, id)), 'and the file is still in the live folder')

  const { fixture, controller } = await mount(f.bridge)
  let html = controller.markup()
  assert.match(html, /Native agent log output/)
  assert.match(html, new RegExp(`data-diagnostic-file="${rx(id)}"[\\s\\S]*?· Archives instead of expiring when the retention window reaches it<`))
  assert.doesNotMatch(html, /Archived|Moved to the archive folder/)
  assert.match(html, new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="false" >Keep<`), 'Keep is valid on such a row')
  assert.match(html, new RegExp(`data-diagnostic-export="${rx(id)}" >Export…<`), 'so is Export')
  assert.match(html, new RegExp(`data-diagnostic-archive="${rx(id)}" >Archive<`), 'and an explicit Archive')
  assert.match(html, /data-diagnostic-target[^>]*>Closed files are moved to the archive folder when they reach 7 days or when storage exceeds 64 MiB\./)

  press(fixture, { 'data-diagnostic-keep': id }); await settle()
  assert.equal((await f.facade.inspect({ next: false })).files[0].keep, true, 'Keep on such a row is a real metadata write the Engine reads back')
  assert.match(controller.markup(), new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="true" >Kept<`))
  assert.match(controller.markup(), /· Kept past the retention window</, 'a kept file is protected outright; its archive preference waits behind that')

  press(fixture, { 'data-diagnostic-archive': id }); await settle()
  html = controller.markup()
  assert.match(html, new RegExp(`Moved to the archive folder \\(${rx(path.join(f.directory, 'archive', id, id))}\\)\\.`), 'the notice names where the Engine put it')
  assert.match(html, new RegExp(`data-diagnostic-file="${rx(id)}"[\\s\\S]*?· Moved to the archive folder<`))
  assert.match(html, new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="true" disabled`))
  assert.match(html, new RegExp(`data-diagnostic-export="${rx(id)}" disabled`))
  assert.match(html, new RegExp(`data-diagnostic-archive="${rx(id)}" disabled`))
  assert.ok(f.disk.files.has(path.join(f.directory, 'archive', id, id)), 'the Engine moved the data')
  assert.ok(!f.disk.files.has(path.join(f.directory, id)), 'out of the live folder')

  press(fixture, { 'data-diagnostic-refresh': '' }); await settle()
  assert.equal(controller.files.length, 0, 'after Refresh the Engine no longer lists it')
  assert.match(controller.markup(), /No closed diagnostic files are on this computer right now\./)
  assert.deepEqual(f.unlinked(), [], 'nothing was deleted, even inside the in-memory filesystem')
  controller.destroy()
})

test('F4: a pending Keep holds Refresh; its answer lands on the current row; the next Refresh reads the Engine\'s metadata and agrees', async () => {
  const f = service()
  const id = f.closed('exit-record')
  let releaseKeep
  const bridge = { ...f.bridge, diagnosticsKeep: async request => { await new Promise(resolve => { releaseKeep = resolve }); return f.facade.keep(request) } }
  const { fixture, controller } = await mount(bridge)
  assert.equal(f.inspects.length, 1)
  assert.match(controller.markup(), new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="false" >Keep<`))

  press(fixture, { 'data-diagnostic-keep': id })
  assert.match(fixture.panel.outerHTML, /data-diagnostic-refresh disabled/, 'Refresh is held while the keep is pending')
  assert.match(fixture.panel.outerHTML, new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="false" disabled`), 'and the row is held')
  press(fixture, { 'data-diagnostic-refresh': '' }); await settle()
  assert.equal(f.inspects.length, 1, 'a stale Refresh press during the pending keep reads nothing')
  assert.equal((await f.facade.inspect({ next: false })).files[0].keep, false, 'the Engine has not been asked yet')

  releaseKeep(); await settle()
  assert.equal(controller.files.find(file => file.id === id).keep, true, 'the answer is applied to the row current when it arrives')
  assert.match(fixture.panel.outerHTML, new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="true" >Kept<`), 'and painted')
  assert.match(fixture.panel.outerHTML, /data-diagnostic-refresh >Refresh/, 'Refresh is released')

  press(fixture, { 'data-diagnostic-refresh': '' }); await settle()
  assert.equal(f.inspects.length, 2, 'the Refresh now reads through the bridge (the direct facade checks above are not the panel\'s)')
  assert.equal(controller.files.find(file => file.id === id).keep, true, 'the Engine\'s own metadata says the same')
  assert.match(fixture.panel.outerHTML, /· Kept past the retention window</)

  press(fixture, { 'data-diagnostic-keep': id }); await settle(); releaseKeep(); await settle()
  assert.equal((await f.facade.inspect({ next: false })).files[0].keep, false, 'an unkeep is a real release of the protection')
  assert.match(fixture.panel.outerHTML, new RegExp(`data-diagnostic-keep="${rx(id)}" aria-pressed="false" >Keep<`), 'and the row says so, not "Kept"')
  controller.destroy()
})

test('F5: totals are the last maintenance pass\'s census, said as such, beside what that pass left; an unfinished pass is not unreadability; a file without metadata is', async () => {
  const f = service()
  const first = f.closed('main-lag'), second = f.closed('main-heap')
  const pass = await f.maintain()
  assert.equal(pass.complete, true)
  const counted = pass.managedBytes
  assert.ok(counted > 0)
  const { fixture, controller } = await mount(f.bridge)
  let html = controller.markup()
  assert.match(html, new RegExp(`data-diagnostic-storage[^>]*>${rx(bytesWords(counted))} of diagnostics counted by the last maintenance pass\\.`), 'the census is the pass\'s, not this listing\'s')
  assert.match(html, /data-diagnostic-census[^>]*>2 files listed\./)

  f.age(8)
  const acted = await f.maintain()
  assert.deepEqual(acted.removed.sort(), [first, second].sort(), 'the finite pass removed both closed files (inside the in-memory filesystem)')
  assert.equal(acted.projectedBytes, 0)
  press(fixture, { 'data-diagnostic-refresh': '' }); await settle()
  html = controller.markup()
  assert.match(html, new RegExp(`data-diagnostic-storage[^>]*>${rx(bytesWords(acted.managedBytes))} of diagnostics counted by the last maintenance pass; about 0 bytes after that pass acted\\.`), 'a census taken before the pass acted is said to be that, beside what it left')
  assert.match(html, /No closed diagnostic files are on this computer right now\./, 'and it stands beside the empty current list without contradiction')
  assert.doesNotMatch(html, /cannot be read|data-diagnostic-unread/)
  controller.destroy()

  /* An unfinished pass: three closed files are six directory entries; a
     pass that reads two entries counts one file and stops with a known part,
     a null total and no unknown files. */
  const partial = service({ limits: { entriesPerPass: 2 } })
  partial.closed('main-lag'); partial.closed('main-lag'); partial.closed('main-lag')
  const unfinished = await partial.store.maintenance()
  assert.equal(unfinished.scanComplete, false)
  assert.equal(unfinished.unknownCount, 0)
  assert.equal(unfinished.managedBytes, null)
  assert.ok(unfinished.knownManagedBytes > 0)
  const p = await mount(partial.bridge)
  html = p.controller.markup()
  assert.match(html, new RegExp(`data-diagnostic-storage[^>]*>at least ${rx(bytesWords(unfinished.knownManagedBytes))} of diagnostics counted so far by the last maintenance pass; its total is not known yet\\.`))
  assert.doesNotMatch(html, /cannot be read|data-diagnostic-unread/, 'an unfinished pass is not called unreadable')
  assert.match(html, /data-diagnostic-more/, 'this listing is also paged by the same bound and says so')
  p.controller.destroy()

  /* A managed-looking data file without its metadata is unreadable: the
     Engine counts it, nulls the totals, and the panel says why. */
  const stray = service()
  stray.closed('main-lag')
  const good = await stray.maintain()
  assert.ok(good.managedBytes > 0)
  stray.disk.writeFileSync(path.join(stray.directory, 'diag-1-00000000-0000-0000-0000-00000000dead.jsonl'), 'no metadata')
  const s = await mount(stray.bridge)
  assert.equal(s.controller.page.unknownCount, 1)
  assert.equal(s.controller.page.managedBytes, null, 'the Engine nulls the total for this listing')
  html = s.controller.markup()
  assert.match(html, new RegExp(`data-diagnostic-storage[^>]*>at least ${rx(bytesWords(good.knownManagedBytes))} of diagnostics counted by the last maintenance pass; the total is unknown while some files cannot be read\\.`))
  assert.match(html, /data-diagnostic-unread[^>]*>1 file in the diagnostic folder could not be read\. Automatic cleanup is stopped until they can be; nothing was deleted\./)
  assert.match(html, /data-diagnostic-census[^>]*>1 file listed, not counting the 1 that could not be read\./)
  s.controller.destroy()
})

test('F6: a real writer past its budget makes the aggregate; the sentence names no page whether or not that writer is listed', async () => {
  const f = service({ limits: { lineBytes: 64, segmentBytes: 128, writerBytes: 256, entriesPerPass: 2 } })
  const writer = f.store.createWriter('native-stream')
  for (let index = 0; index < 40; index++) writer.append('x'.repeat(50))
  const state = writer.state()
  assert.ok(state.dropped > 0, 'the actual writer hit its output budget')

  const { fixture, controller } = await mount(f.bridge)
  // The aggregate is this run's open writers'; the sentence points at no page,
  // on the first page and on every later one.
  const dropSentence = new RegExp(`data-diagnostic-dropped[^>]*>${state.dropped} diagnostic records were dropped in this application run after a writer reached its output budget; the work itself continued\\. A file whose output was cut carries a mark where it appears in this list\\.`)
  assert.match(controller.markup(), dropSentence)
  assert.doesNotMatch(controller.markup(), /marked below/, 'the aggregate never promises a page')
  while (controller.page?.scanComplete === false) {
    press(fixture, { 'data-diagnostic-more': '' }); await settle()
    assert.match(controller.markup(), dropSentence, 'the sentence is the same on every page')
    assert.doesNotMatch(controller.markup(), /marked below/)
  }
  // The Engine did record the suppression on a real segment; that row, where it
  // is listed, carries its own mark.
  assert.ok(controller.files.some(file => file.outputSuppressed), 'the suppressed segment is listed once the folder is walked')
  assert.match(controller.markup(), /output was cut at the diagnostic budget/)
  writer.close()
  controller.destroy()
})

test('F6 (M7 T789): an OLD closed suppressed file listed here does not make the CURRENT open dropping writer read as "marked below"', async () => {
  const f = service({ limits: { lineBytes: 64, segmentBytes: 128, writerBytes: 256 } })
  // OLD writer A: pushed past its budget, then CLOSED. Its file keeps the
  // suppression mark and A leaves status().writers.
  const a = f.store.createWriter('main-lag')
  while (a.state().dropped === 0) a.append('a'.repeat(50))
  a.close()
  // CURRENT writer B: still open and past its budget, so it is the only writer
  // in status().writers with dropped > 0 -- the aggregate is B's, not A's.
  const b = f.store.createWriter('main-heap')
  while (b.state().dropped === 0) b.append('b'.repeat(50))
  const bDropped = b.state().dropped

  const status = f.store.status()
  assert.ok(!status.writers.some(writer => writer.id === a.state().id), 'the closed old writer is out of status().writers')
  assert.equal(status.writers.filter(writer => writer.dropped > 0).reduce((sum, writer) => sum + writer.dropped, 0), bDropped, 'the aggregate is the open writer B only')

  const { controller } = await mount(f.bridge)
  const html = controller.markup()
  assert.ok(controller.files.some(file => file.outputSuppressed), 'the old closed suppressed file A is listed and carries its own mark')
  assert.match(html, new RegExp(`data-diagnostic-dropped[^>]*>${bDropped} diagnostic record${bDropped === 1 ? ' was' : 's were'} dropped in this application run after a writer reached its output budget; the work itself continued\\. A file whose output was cut carries a mark where it appears in this list\\.`))
  assert.doesNotMatch(html, /marked below/, 'the listed old suppressed file A must not make the current dropping writer B claim it is marked below')
  assert.match(html, /output was cut at the diagnostic budget/, 'A carries its own mark where it appears')
  b.close()
  controller.destroy()
})
