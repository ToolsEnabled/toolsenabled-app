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

const { createDiffFiles, diffAnswer } = createRequire(import.meta.url)('../../shell/diff-file.cjs')
const { createSessionDiffAccess } = createRequire(import.meta.url)('../../shell/session-diff-access.cjs')
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
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') {
      t.diagnostic(`Retained Compare fixture: ${owned}`)
      return
    }
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

for (const [platform, adapter, cwd] of [['Windows', path.win32, '\x43:\\workspace'], ['Linux', path.posix, '/workspace']]) {
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

// The real door selects split-first itself. These cases do not supply a create
// override or set controller state to select a view. Disk operations stay in
// Maps; the real file reader and registered-session authority still run.
function splitFirstFiles({ rootsAvailable = true, wrongOwner = false } = {}) {
  const workspace = path.resolve('t1890-workspace')
  const registered = path.resolve('t1890-registered')
  const outside = path.resolve('t1890-outside')
  const target = path.join(registered, 'changed.txt')
  const directories = new Set([workspace, registered, outside])
  const contents = new Map([workspace, registered, outside].map(root => [path.join(root, 'changed.txt'), 'after\n']))
  const descriptors = new Map(), reads = [], writes = []
  let descriptor = 0, fault = null, profileRoot = registered
  const error = code => Object.assign(new Error('fixture-internal-details: fixture-private-path'), { code })
  const disk = {
    realpathSync(candidate) {
      if (directories.has(candidate) || contents.has(candidate)) return candidate
      throw error('ENOENT')
    },
    statSync(candidate) {
      if (directories.has(candidate)) return { isDirectory: () => true, isFile: () => false }
      if (fault && ['EACCES', 'EIO', 'ENOENT'].includes(fault)) throw error(fault)
      if (!contents.has(candidate)) throw error('ENOENT')
      return { isDirectory: () => false,
        isFile: () => { if (fault === 'unexpected') throw error('FIXTURE_FAULT'); return true },
        size: Buffer.byteLength(contents.get(candidate)), mtimeMs: 1 }
    },
    readFileSync(candidate) {
      reads.push(candidate)
      if (fault === 'read') throw error('EIO')
      if (!contents.has(candidate)) throw error('ENOENT')
      return Buffer.from(contents.get(candidate))
    },
    openSync(candidate, mode) {
      assert.equal(mode, 'wx')
      if (contents.has(candidate)) throw error('EEXIST')
      contents.set(candidate, '')
      descriptors.set(++descriptor, candidate)
      return descriptor
    },
    writeFileSync(fd, text) { contents.set(descriptors.get(fd), text) },
    fsyncSync(fd) { assert.ok(descriptors.has(fd)) },
    closeSync(fd) { descriptors.delete(fd) },
    renameSync(from, to) {
      assert.ok(contents.has(from))
      contents.set(to, contents.get(from)); contents.delete(from)
      writes.push(to)
    },
    unlinkSync(candidate) { if (!contents.delete(candidate)) throw error('ENOENT') },
  }
  const files = createDiffFiles({ fs: disk, path, workspaceRoots: () => rootsAvailable ? [workspace] : [] })
  const owner = { isDestroyed: () => false }
  const sessionId = 't1890-session'
  const session = { started: true, owner: wrongOwner ? { isDestroyed: () => false } : owner,
    ownerKind: 'window', profileId: 't1890-profile', cwd: registered }
  const access = createSessionDiffAccess({ fs: disk, path, sessions: new Map([[sessionId, session]]),
    readDefault: file => files.readChange(file), stampDefault: file => files.stamp(file),
    writeDefault: (file, text) => files.write(file, text), readPreferences: () => ({ ok: true, values: {} }),
    resolveProfile: () => profileRoot, assertPath: value => value,
    captureCeiling: roots => roots.map(canonical => ({ canonical })),
    intersectCeiling: (_ceiling, roots) => roots,
  })
  const calls = []
  const bridge = {
    readChange(file, options) {
      calls.push(['readChange', file, options?.sessionId])
      const result = access.read(owner, { path: file, ...options })
      // Even a future transport that attaches raw failure details must not
      // cause the renderer to expose them. Successful content is untouched.
      return result.ok ? result : { ...result, message: 'fixture-internal-details',
        path: 'fixture-private-path', text: 'fixture-private-content' }
    },
    stamp(file, options) {
      calls.push(['stamp', file, options?.sessionId])
      return access.stamp(owner, { path: file, ...options })
    },
    save(file, text, options) {
      calls.push(['save', file, options?.sessionId])
      return diffAnswer('MC_DIFF_WRITE_FAILED', () => access.write(owner, { path: file, text, ...options }))
    },
  }
  return { target, outside: path.join(outside, 'changed.txt'), sessionId, bridge, contents, reads, writes, calls,
    fail: cause => { fault = cause },
    revoke: () => access.ended(sessionId, session, 'revoked'),
    rebind: () => { profileRoot = outside },
  }
}

function visibleControl(document, selector) {
  const node = document.body.querySelector(selector)
  assert.ok(node, `missing ${selector}`)
  assert.ok(node.closest('[hidden]') === null, `${selector} is hidden with its parent`)
  assert.ok(node.closest('[aria-hidden="true"]') === null, `${selector} is hidden from assistive technology`)
  return node
}

function visibleReadRefusal(document, code, words) {
  const refusal = visibleControl(document, '.diff-refusal')
  assert.equal(refusal.getAttribute('role'), 'alert')
  assert.equal(refusal.getAttribute('data-refusal-code'), code)
  assert.ok(refusal.closest('[data-diff-edit-body]') === null, 'the diagnostic must survive switching views')
  assert.match(refusal.textContent, words)
  assert.doesNotMatch(document.body.textContent, /fixture-internal-details|fixture-private-|MC_DIFF_/)
  return refusal
}

const splitReadFailures = [
  ['no workspace', { rootsAvailable: false }, null, 'MC_DIFF_NO_WORKSPACE', /could not find the folder/i],
  ['outside registered workspace', {}, null, 'MC_DIFF_OUTSIDE_WORKSPACE', /outside the folder/i],
  ['stat failure', {}, 'EACCES', 'MC_DIFF_STAT_FAILED', /details could not be checked/i],
  ['read failure', {}, 'read', 'MC_DIFF_READ_FAILED', /file could not be read/i],
  ['unexpected reader failure', {}, 'unexpected', 'MC_DIFF_HANDLER_FAILED', /unexpected error/i],
  ['another session owner', { wrongOwner: true }, null, 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE', /session folder.*not currently available/i],
]

for (const [cause, options, fault, code, words] of splitReadFailures) {
  test(`T1890 split-first door visibly distinguishes ${cause} through the real session reader`, async t => {
    const native = splitFirstFiles(options)
    native.fail(fault)
    const { document, door } = fixture(t, native.bridge)
    const target = cause === 'outside registered workspace' ? native.outside : native.target
    const editor = door.open(change(target, { sessionId: native.sessionId }))
    await settle()
    visibleControl(document, '[data-diff-split]')
    assert.equal(document.body.querySelector('[data-diff-edit-body]').hidden, true)
    visibleReadRefusal(document, code, words)
    visibleControl(document, '[data-diff-view="edit"]').click()
    assert.equal(document.body.querySelector('[data-diff-edit-body]').hidden, false)
    visibleReadRefusal(document, code, words)
    for (const side of ['original', 'proposed']) {
      assert.equal(document.body.querySelector(`[data-diff-pane="${side}"]`).value, '')
      assert.equal(document.body.querySelectorAll('[data-diff-action="save"]').find(node => node.dataset.diffSide === side).disabled, true)
      await editor.commitSave(side)
    }
    assert.deepEqual(native.calls, [['readChange', target, native.sessionId]])
    assert.equal(native.writes.length, 0)
    assert.equal(native.contents.get(native.target), 'after\n')
    if (cause === 'another session owner' || cause === 'outside registered workspace') assert.equal(native.reads.length, 0)
  })
}

test('T1890 split-first rejected read stays visible and cannot retain the previous file contents', async t => {
  const native = splitFirstFiles()
  const { document, door } = fixture(t, native.bridge)
  door.open(change(native.target, { sessionId: native.sessionId }))
  await settle()
  assert.equal(document.body.querySelector('[data-diff-pane="proposed"]').value, 'after\n')
  native.bridge.readChange = async () => { throw Error('fixture-internal-details') }
  door.open(change(path.join(path.dirname(native.target), 'unavailable.txt'), { sessionId: native.sessionId }))
  await settle()
  visibleControl(document, '[data-diff-split]')
  visibleReadRefusal(document, 'MC_DIFF_HANDLER_FAILED', /unexpected error/i)
  visibleControl(document, '[data-diff-view="edit"]').click()
  for (const side of ['original', 'proposed']) assert.equal(document.body.querySelector(`[data-diff-pane="${side}"]`).value, '')
  assert.equal(native.writes.length, 0)
})

async function editThroughSplitDoor(t, native) {
  const mounted = fixture(t, native.bridge)
  mounted.door.open(change(native.target, { sessionId: native.sessionId, complete: true,
    patches: [{ path: native.target, diff: '@@ -1 +1 @@\n-before\n+after\n' }] }))
  await settle()
  visibleControl(mounted.document, '[data-diff-split]')
  visibleControl(mounted.document, '[data-diff-view="edit"]').click()
  const box = visibleControl(mounted.document, '[data-diff-pane="proposed"]')
  box.value = 'retained manual edit\n'
  box.dispatchEvent({ type: 'input' })
  visibleControl(mounted.document, '[data-diff-view="split"]').click()
  assert.match(visibleControl(mounted.document, '[data-diff-split]').textContent, /retained manual edit/)
  visibleControl(mounted.document, '[data-diff-view="edit"]').click()
  assert.equal(visibleControl(mounted.document, '[data-diff-pane="proposed"]').value, 'retained manual edit\n')
  return mounted
}

async function askToSave(document) {
  const save = document.body.querySelectorAll('[data-diff-action="save"]').find(node => node.dataset.diffSide === 'proposed')
  assert.ok(save)
  assert.equal(save.closest('[hidden]'), null)
  assert.equal(save.disabled, false)
  save.click()
  await settle()
  const confirm = visibleControl(document, '[data-diff-action="confirm-save"]')
  assert.equal(confirm.disabled, false)
  assert.match(visibleControl(document, '.diff-warning').textContent, /could not be read/i)
  return confirm
}

for (const cause of ['EACCES', 'EIO', 'unexpected', 'rejected bridge', 'ENOENT']) {
  test(`T1890 split-first Edit retains manual save after stamp ${cause}`, async t => {
    const native = splitFirstFiles()
    const { document } = await editThroughSplitDoor(t, native)
    if (cause === 'rejected bridge') native.bridge.stamp = async () => { throw Error('fixture-internal-details') }
    else native.fail(cause)
    await askToSave(document)
    if (cause === 'ENOENT') assert.equal(document.body.querySelector('.diff-refusal'), null, 'known absence remains a warning, not a stat failure')
    else visibleReadRefusal(document, cause === 'unexpected' || cause === 'rejected bridge' ? 'MC_DIFF_HANDLER_FAILED' : 'MC_DIFF_STAT_FAILED',
      cause === 'unexpected' || cause === 'rejected bridge' ? /unexpected error/i : /details could not be checked/i)
    const split = visibleControl(document, '[data-diff-view="split"]')
    assert.equal(split.disabled, true, 'a view switch must not hide the pending save question')
    split.click()
    visibleControl(document, '[data-diff-action="confirm-save"]')
    visibleControl(document, '[data-diff-action="cancel-save"]').click()
    assert.equal(visibleControl(document, '[data-diff-pane="proposed"]').value, 'retained manual edit\n')
    assert.equal(native.contents.get(native.target), 'after\n')
    const confirm = await askToSave(document)
    confirm.click()
    await settle()
    assert.equal(native.contents.get(native.target), 'retained manual edit\n')
    assert.deepEqual(native.writes, [native.target], 'one deliberate confirmation writes exactly once')
    assert.deepEqual(native.calls.filter(([verb]) => verb === 'save'), [['save', native.target, native.sessionId]])
    assert.equal(document.body.querySelector('.diff-refusal'), null)
    assert.equal(visibleControl(document, '[data-diff-pane="proposed"]').value, 'retained manual edit\n')
  })
}

for (const loss of ['revoke', 'rebind']) {
  test(`T1890 split-first manual confirmation preserves edits when registered authority changes by ${loss}`, async t => {
    const native = splitFirstFiles()
    const { document } = await editThroughSplitDoor(t, native)
    native.fail('EACCES')
    const confirm = await askToSave(document)
    native[loss]()
    confirm.click()
    await settle()
    visibleReadRefusal(document, 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE', /session folder.*not currently available/i)
    assert.equal(native.writes.length, 0)
    assert.equal(native.contents.get(native.target), 'after\n')
    assert.equal(visibleControl(document, '[data-diff-pane="proposed"]').value, 'retained manual edit\n')
  })
}
