import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { createCompareFilesDoor } from '../../src/diff-editor.js'
import { mountChatSessionChanges } from '../../src/chat-session-changes.js'
import { createChatDiffOpenHandler } from '../../src/components.js'

const { createDiffFiles } = createRequire(import.meta.url)('../../shell/diff-file.cjs')
const { bindSessionChangePaths } = createRequire(import.meta.url)('../../shell/session-change-paths.cjs')
const change = (file, extra = {}) => ({ path: file, status: 'M', added: 1, removed: 1, edits: 1, complete: false, patches: [], ...extra })
const reading = (file, text = file) => ({ ok: true, path: file, text, exists: true, bytes: Buffer.byteLength(text), modifiedMs: 1 })
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('read-only deleted session files explain reconstruction without offering an impossible restore', async t => {
  const file = '/registered/deleted.txt'
  const { document, door } = fixture(t, { readChange: () => ({ ...reading(file, ''), exists: false, readOnly: true }), save() { assert.fail('review does not grant a write') } })
  const editor = door.open(change(file, { complete: true, patches: [{ path: file, diff: '@@ -1 +0,0 @@\n-previous\n' }] }))
  await settle()
  assert.equal(editor.state.sides.original.text, 'previous\n')
  assert.equal(editor.state.sides.proposed.text, '')
  assert.match(editor.state.changeNote, /deleted.*reconstructed/i)
  assert.match(editor.state.changeNote, /editor.*restore|restore.*editor/i)
  assert.doesNotMatch(editor.state.changeNote, /Save the original version/)
  assert.doesNotMatch(document.body.querySelector('.diff-lede').textContent, /Edit either version and save/)
  for (const side of ['original', 'proposed']) {
    assert.equal(editor.state.sides[side].readOnly, true)
    const save = document.body.querySelectorAll('[data-diff-action="save"]').find(button => button.dataset.diffSide === side)
    assert.ok(save, `${side} has its own Save control`)
    assert.equal(save.disabled, true)
    await editor.commitSave(side)
  }
})

test('read-only unmeasured session files do not claim the current pane is editable', async t => {
  const file = '/registered/unmeasured.txt'
  const { door } = fixture(t, { readChange: () => ({ ...reading(file, 'current\n'), readOnly: true }) })
  const editor = door.open(change(file, { unmeasuredEdits: 1 }))
  await settle()
  assert.equal(editor.state.sides.proposed.text, 'current\n')
  assert.doesNotMatch(editor.state.changeNote, /current file is editable/)
  assert.match(editor.state.changeNote, /review only/i)
})

test('a refused new selection clears previous read-only pane contents and retains the requested filename', async t => {
  const file = '/registered/first.txt', denied = '/registered/unavailable.txt'
  const { document, door } = fixture(t, { readChange: target => target === file
    ? { ...reading(file, 'current\n'), readOnly: true }
    : { ok: false, code: 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE' } })
  const editor = door.open(change(file, { complete: true, patches: [{ path: file, diff: '@@ -1 +1 @@\n-before\n+current\n' }] }))
  await settle()
  assert.equal(editor.state.sides.original.readOnly, true)
  door.open(change(denied))
  await settle()
  assert.equal(editor.state.change.path, denied)
  assert.equal(document.body.querySelector('#diff-title').textContent, 'unavailable.txt')
  assert.equal(editor.state.refusal.code, 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE')
  for (const side of ['original', 'proposed']) {
    const pane = editor.state.sides[side]
    assert.equal(pane.path, null)
    assert.equal(pane.text, '')
    assert.equal(pane.savedText, '')
    assert.equal(Boolean(pane.readOnly), false)
    assert.equal(document.body.querySelector(`[data-diff-pane="${side}"]`).value, '')
  }
})

test('each default-workspace picker replaces only its pane and retires that pane read-only flag', async t => {
  const file = '/registered/first.txt'
  const { door } = fixture(t, { readChange: () => ({ ...reading(file, 'current\n'), readOnly: true }),
    pick: side => reading(`/workspace/${side}.txt`, `chosen ${side}\n`) })
  const editor = door.open(change(file, { complete: true, patches: [{ path: file, diff: '@@ -1 +1 @@\n-before\n+current\n' }] }))
  await settle()
  await editor.pick('original')
  assert.equal(editor.state.change, null)
  assert.equal(editor.state.sides.original.readOnly, false)
  assert.equal(editor.state.sides.original.path, '/workspace/original.txt')
  assert.equal(editor.state.sides.proposed.readOnly, true, 'choosing one file must not grant writes to the untouched session file')
  assert.equal(editor.state.sides.proposed.text, 'current\n')
  await editor.pick('proposed')
  for (const side of ['original', 'proposed']) {
    assert.equal(editor.state.sides[side].readOnly, false)
    assert.equal(editor.state.sides[side].path, `/workspace/${side}.txt`)
    assert.equal(editor.state.sides[side].text, `chosen ${side}\n`)
    assert.equal(Object.hasOwn(editor.state.sides[side], 'diskText'), false)
  }
})

function fixture(t, files) {
  const dom = installDomStandIn()
  const door = createCompareFilesDoor({ documentRef: dom.document, bridge: () => files, storage: () => null })
  t.after(() => { door.close(); dom.restore() })
  return { ...dom, door }
}

test('clicking a changed file loads that real file and its original into both panes without a picker', async t => {
  const scratch = fs.mkdtempSync(testScratchRoot('diff-file-selection-'))
  // Only this newly created, real directory is ever removed.
  const owned = fs.realpathSync.native(scratch)
  t.after(() => {
    assert.equal(fs.realpathSync.native(scratch), owned)
    assert.equal(path.dirname(owned), fs.realpathSync.native(path.dirname(scratch)))
    fs.rmSync(owned, { recursive: true })
  })
  const first = path.join(scratch, 'first.txt'), target = path.join(scratch, 'selected.txt')
  fs.writeFileSync(first, 'unrelated\n'); fs.writeFileSync(target, 'after\n')
  const native = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [scratch] })
  const requests = []
  const { document, door } = fixture(t, {
    readChange(file) { requests.push(file); return native.readChange(file) },
    pick() { assert.fail('a selected change must not require another file choice') },
  })
  const chat = document.createElement('div'); document.body.appendChild(chat)
  const drawer = mountChatSessionChanges(chat, { onOpenDiff: createChatDiffOpenHandler(door) })
  t.after(() => drawer.dispose())
  drawer.add({ files: [change(first), change(target)], patches: [{ path: target, diff: '@@ -1 +1 @@\n-before\n+after\n' }] })
  chat.querySelector('[data-changes-toggle]').click()
  chat.querySelectorAll('.session-change-file')[1].click()
  await settle()
  assert.deepEqual(requests, [target])
  assert.equal(document.body.querySelector('[data-diff-pane="proposed"]').value, 'after\n')
  assert.equal(document.body.querySelector('[data-diff-pane="original"]').value, 'before\n')
})

test('an empty existing compare window accepts the subsequently selected file', async t => {
  const requested = []
  const { door } = fixture(t, { readChange(file) { requested.push(file); return reading(file) } })
  const editor = door.open()
  assert.equal(door.open(change('/workspace/chosen.txt')), editor)
  await settle()
  assert.deepEqual(requested, ['/workspace/chosen.txt'])
  assert.equal(editor.state.sides.proposed.path, '/workspace/chosen.txt')
})

test('a new explicit file replaces a clean previous selection in the same window', async t => {
  const { document, door } = fixture(t, { readChange: file => reading(file) })
  const editor = door.open(change('/workspace/first.txt'))
  await settle()
  door.open(change('/workspace/second.txt'))
  await settle()
  assert.equal(document.body.querySelectorAll('.diff-dialog').length, 1)
  assert.equal(editor.state.change.path, '/workspace/second.txt')
  assert.equal(editor.state.sides.proposed.path, '/workspace/second.txt')
})

test('the latest requested file wins when earlier file reads resolve out of order', async t => {
  const pending = new Map()
  const { door } = fixture(t, { readChange: file => new Promise(resolve => pending.set(file, resolve)) })
  const editor = door.open(change('/workspace/slow.txt'))
  door.open(change('/workspace/latest.txt'))
  assert.deepEqual([...pending.keys()], ['/workspace/slow.txt', '/workspace/latest.txt'])
  pending.get('/workspace/latest.txt')(reading('/workspace/latest.txt', 'latest'))
  await settle()
  pending.get('/workspace/slow.txt')(reading('/workspace/slow.txt', 'stale'))
  await settle()
  assert.equal(editor.state.sides.proposed.text, 'latest')
  assert.equal(editor.state.change.path, '/workspace/latest.txt')
})

test('opening a change list chooses its first file only when no target was specified', async t => {
  const requested = []
  const { door } = fixture(t, { readChange(file) { requested.push(file); return reading(file) } })
  const files = [change('/workspace/first.txt'), change('/workspace/second.txt')]
  const editor = door.open({ files })
  await settle()
  assert.equal(editor.state.sides.proposed.path, files[0].path)
  door.open({ files, activeIndex: 1 })
  await settle()
  assert.equal(editor.state.sides.proposed.path, files[1].path)
  door.open({ path: '/workspace/explicit.txt', files })
  await settle()
  assert.deepEqual(requested, [files[0].path, files[1].path, '/workspace/explicit.txt'])
})

test('a list request with no valid current index opens its first changed file', async t => {
  const { door } = fixture(t, { readChange: file => reading(file) })
  const files = [change('/workspace/first.txt'), change('/workspace/second.txt')]
  const editor = door.open({ files, activeIndex: -1 })
  await settle()
  assert.equal(editor.state.sides.proposed.path, files[0].path)
})

test('a newer recorded edit to the same path reloads its current and original versions', async t => {
  let text = 'middle\n'
  const requests = []
  const { door } = fixture(t, { readChange(file) { requests.push(file); return reading(file, text) } })
  const file = '/workspace/changing.txt'
  const first = change(file, { complete: true, patches: [{ path: file, diff: '@@ -1 +1 @@\n-before\n+middle\n' }] })
  const editor = door.open(first)
  await settle()
  assert.equal(editor.state.sides.original.text, 'before\n')
  text = 'latest\n'
  door.open(change(file, { complete: true, patches: [{ path: file, diff: '@@ -1 +1 @@\n-middle\n+latest\n' }] }))
  await settle()
  assert.deepEqual(requests, [file, file], 'different patch text is a new selection even with identical path/counts')
  assert.equal(editor.state.sides.proposed.text, 'latest\n')
  assert.equal(editor.state.sides.original.text, 'middle\n')
})

test('reopening without a target and refreshing the same selection preserve manually chosen files', async t => {
  const requested = []
  const { door } = fixture(t, { readChange(file) { requested.push(file); return reading(file) }, pick: () => reading('/workspace/manual.txt', 'manual') })
  const selected = change('/workspace/selected.txt')
  const editor = door.open(selected)
  await settle()
  door.open(selected)
  await settle()
  assert.deepEqual(requested, [selected.path], 'same-selection refresh must not read or reset the panes')
  await editor.pick('proposed')
  door.open()
  assert.equal(editor.state.sides.proposed.path, '/workspace/manual.txt')
  assert.equal(editor.state.sides.proposed.text, 'manual')
})

test('dirty panes and a pending picker cannot be overwritten by an incoming change', async t => {
  let finishPick
  const requested = []
  const { door } = fixture(t, { readChange(file) { requested.push(file); return reading(file) },
    pick: () => new Promise(resolve => { finishPick = resolve }) })
  const editor = door.open(change('/workspace/first.txt'))
  await settle()
  editor.state.sides.proposed.text = 'unsaved edit'
  door.open(change('/workspace/second.txt'))
  await settle()
  assert.equal(editor.state.sides.proposed.text, 'unsaved edit')
  editor.state.sides.proposed.text = editor.state.sides.proposed.savedText
  const picking = editor.pick('original')
  door.open(change('/workspace/second.txt'))
  finishPick(reading('/workspace/manual.txt'))
  await picking
  assert.deepEqual(requested, ['/workspace/first.txt'])
  assert.equal(editor.state.sides.original.path, '/workspace/manual.txt')
})

test('closing a window invalidates its pending file result', async t => {
  let finish
  const { document, door } = fixture(t, { readChange: () => new Promise(resolve => { finish = resolve }) })
  door.open(change('/workspace/pending.txt'))
  door.close()
  finish(reading('/workspace/pending.txt'))
  await settle()
  assert.equal(document.body.querySelectorAll('.diff-dialog').length, 0)
  assert.equal(door.isOpen(), false)
})

for (const [platform, adapter, cwd] of [['Windows', path.win32, 'C:\\workspace'], ['Linux', path.posix, '/workspace']]) {
  test(`${platform} session-relative targets reach the reader with their exact bound path`, async t => {
    const packet = bindSessionChangePaths({ event: { type: 'tool_call', tool: 'fileChange', payload: { changes: [{ path: 'nested/selected.txt' }] } } }, cwd, adapter)
    const target = packet.event.payload.changes[0].path
    const requested = []
    const { door } = fixture(t, { readChange(file) { requested.push(file); return reading(file) } })
    const editor = door.open(change(target))
    await settle()
    assert.deepEqual(requested, [adapter.join(cwd, 'nested', 'selected.txt')])
    assert.equal(editor.state.sides.proposed.path, target)
  })
}

test('an unavailable exact target stays a refusal and never falls back to another file', async t => {
  const requested = []
  const { door } = fixture(t, { readChange(file) { requested.push(file); return { ok: false, code: 'MC_DIFF_PATH_UNBOUND' } } })
  const editor = door.open({ path: 'unbound.txt', files: [change('/workspace/other.txt')] })
  await settle()
  assert.deepEqual(requested, ['unbound.txt'])
  assert.equal(editor.state.refusal.code, 'MC_DIFF_PATH_UNBOUND')
  assert.equal(editor.state.sides.proposed.path, null)
})
