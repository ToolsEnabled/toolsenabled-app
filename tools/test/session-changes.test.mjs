import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { previewFiles } from '../previews/chat-changes-fixture.mjs'
import { CHANGE_LIMITS, boundedChangePatches, createConfirmedFileChangeBuffer, patchCounts, reverseSessionPatches } from '../../src/session-change-patches.js'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
import { createSessionChangeStore } from '../../src/chat-session-changes.js'
const { createDiffFiles } = createRequire(import.meta.url)('../../shell/diff-file.cjs')
const { bindSessionChangePaths } = createRequire(import.meta.url)('../../shell/session-change-paths.cjs')
const activity = changes => sessionActivityEvent({ sessionId: 's', event: { type: 'tool_call', tool: 'fileChange', payload: { changes } } }, 's')

test('native structured file changes retain patches and measured counts', () => {
  for (const sample of previewFiles) {
    const event = activity([{ path: sample.path, kind: sample.kind, diff: sample.diff }])
    assert.equal(event.fileChanges.length, 1)
    assert.equal(event.fileChanges[0].path, sample.path)
    assert.deepEqual({ added: event.fileChanges[0].added, removed: event.fileChanges[0].removed }, patchCounts(sample.diff))
    assert.equal(reverseSessionPatches(sample.after, event.filePatches), sample.before)
  }
})

test('reversing a recorded patch refuses mismatched current contents and malformed hunks', () => {
  const sample = previewFiles[0]
  assert.equal(reverseSessionPatches('unrelated content\n', [sample]), null)
  assert.equal(patchCounts('@@ -1,3 +1,2 @@\n-before\n+after\n'), null)
  assert.equal(activity([{ path: 'x', kind: 'update', diff: 'assistant says +20 -10' }]).fileChanges, undefined)
})

test('multi-hunk patches preserve untouched lines and missing terminal newlines', () => {
  const diff = '@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-last\n\\ No newline at end of file\n+final\n\\ No newline at end of file\n'
  assert.equal(reverseSessionPatches('new\na\nb\nc\nfinal', [{ diff }]), 'old\na\nb\nc\nlast')
  assert.equal(reverseSessionPatches('', [{ diff: '@@ -1,2 +0,0 @@\n-one\n-two\n' }]), 'one\ntwo\n')
  assert.equal(reverseSessionPatches('one\ntwo\n', [{ diff: '@@ -0,0 +1,2 @@\n+one\n+two\n' }]), '')
})

test('session totals aggregate edits, replace duplicate events, and retain immutable selections', () => {
  const store = createSessionChangeStore()
  const files = [{ path: 'a.js', status: 'M', added: 1, removed: 1 }]
  const first = [{ path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b\n' }]
  const second = [{ path: 'a.js', diff: '@@ -1 +1 @@\n-b\n+c\n' }]
  store.add({ id: 'first', files, patches: first })
  store.add({ id: 'first', files, patches: first })
  store.add({ id: 'second', files, patches: second })
  const selected = store.read().files[0]
  assert.equal(selected.added, 2)
  assert.equal(selected.removed, 2)
  assert.equal(selected.edits, 2)
  assert.equal(reverseSessionPatches('c\n', selected.patches), 'a\n')
  selected.patches[0].diff = 'mutated'
  assert.equal(reverseSessionPatches('c\n', store.read().files[0].patches), 'a\n')
})

test('file and event limits are bounded and explicitly reported', () => {
  const store = createSessionChangeStore()
  store.add({ id: 'many', files: Array.from({ length: 150 }, (_, index) => ({ path: `${index}.js`, status: 'A', added: 1, removed: 0 })) })
  assert.equal(store.read().files.length, CHANGE_LIMITS.files)
  assert.equal(store.read().limited, true)
  const events = createSessionChangeStore()
  for (let i = 0; i < 250; i++) events.add({ id: String(i), files: [{ path: 'one.js', status: 'M', added: 1, removed: 0 }] })
  assert.equal(events.read().files[0].edits, CHANGE_LIMITS.events)
  assert.equal(events.read().limited, true)
  assert.equal(events.read().files[0].complete, false)
})

test('a selected file retains all 200 edits rather than using the 100-file list limit', () => {
  const records = Array.from({ length: 200 }, (_, i) => ({ path: 'one.js', diff: `@@ -1 +1 @@\n-${i}\n+${i + 1}\n` }))
  const patches = boundedChangePatches(records, [{ path: 'one.js' }], CHANGE_LIMITS.events)
  assert.equal(patches.length, 200)
  assert.equal(reverseSessionPatches('200\n', patches), '0\n')
})

test('selected bound files support saving and deletion without guessing a relative path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-changes-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-changes-outside-'))
  try {
    fs.writeFileSync(path.join(root, 'one.txt'), 'current\n')
    fs.writeFileSync(path.join(outside, 'private.txt'), 'private\n')
    const files = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [root] })
    assert.equal(files.readChange('one.txt').code, 'MC_DIFF_PATH_UNBOUND')
    const selected = files.readChange(path.join(root, 'one.txt'))
    assert.equal(selected.text, 'current\n')
    assert.equal(files.write(selected.path, 'manually edited\n').ok, true)
    assert.equal(fs.readFileSync(selected.path, 'utf8'), 'manually edited\n')
    assert.equal(files.readChange(path.join(root, 'deleted.txt')).exists, false)
    assert.equal(files.readChange(path.join(root, 'deleted.txt')).text, '')
    assert.equal(files.readChange(path.join(outside, 'private.txt')).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(files.readChange(path.join(root, 'escape/private.txt')).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

const changePacket = (type, payload, { sessionId = 'session', turnId = 'turn', toolCallId = 'edit' } = {}) => ({
  sessionId, event: { type, tool: 'fileChange', turnId, toolCallId, payload },
})
const changePayload = { changes: [{ path: 'same.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }] }
const observe = (buffer, packet) => buffer.add(packet, sessionActivityEvent(packet, packet.sessionId))

test('session changes require a matching successful completion, never an attempted or failed edit', () => {
  for (const payload of [{ status: 'failed' }, { status: 'declined' }, { status: 'cancelled' }, {},
    { status: 'completed', success: false }, { status: 'completed', exitCode: 1 },
    { status: 'completed', error: 'disk full' }]) {
    const buffer = createConfirmedFileChangeBuffer()
    assert.equal(observe(buffer, changePacket('tool_call', changePayload)), null)
    assert.equal(observe(buffer, changePacket('tool_result', payload)), null)
    assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' })), null)
  }
  const buffer = createConfirmedFileChangeBuffer()
  const call = changePacket('tool_call', changePayload)
  assert.equal(observe(buffer, call), null)
  const confirmed = observe(buffer, changePacket('tool_result', { status: 'completed' }))
  assert.deepEqual(confirmed.fileChanges, [{ path: 'same.txt', status: 'M', added: 1, removed: 1 }])
  assert.equal(confirmed.filePatches[0].diff, changePayload.changes[0].diff)
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' })), null)
})

test('pending edits cannot cross session or turn identities, or outlive an unfinished turn', () => {
  const buffer = createConfirmedFileChangeBuffer()
  observe(buffer, changePacket('tool_call', changePayload))
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' }, { sessionId: 'other' })), null)
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' }, { turnId: 'other' })), null)
  observe(buffer, { sessionId: 'session', event: { type: 'turn_completed', turnId: 'turn' } })
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' })), null)
  observe(buffer, changePacket('tool_call', changePayload))
  observe(buffer, { sessionId: 'session', event: { type: 'session_ended' } })
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' })), null)
})

test('uncompleted calls cannot retain unlimited events or patch contents', () => {
  const buffer = createConfirmedFileChangeBuffer()
  for (let i = 0; i <= CHANGE_LIMITS.events; i++) {
    observe(buffer, changePacket('tool_call', changePayload, { toolCallId: String(i) }))
  }
  assert.equal(observe(buffer, changePacket('tool_result', { status: 'completed' }, { toolCallId: '0' })), null)
  assert.ok(observe(buffer, changePacket('tool_result', { status: 'completed' }, { toolCallId: String(CHANGE_LIMITS.events) })))
  buffer.clear()
  const diff = `@@ -1 +1 @@\n-${'a'.repeat(60000)}\n+${'b'.repeat(60000)}\n`
  for (let i = 0; i < 10; i++) {
    observe(buffer, changePacket('tool_call', { changes: [{ path: 'large.txt', kind: 'update', diff }] }, { toolCallId: String(i) }))
  }
  const first = observe(buffer, changePacket('tool_result', { status: 'completed' }, { toolCallId: '0' }))
  assert.equal(first.fileChanges.length, 1)
  assert.deepEqual(first.filePatches, [], 'old patch contents are dropped without inventing an original')
})

test('the selected session folder stays bound when another same-named file becomes the default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-change-roots-'))
  try {
    const first = path.join(root, 'first'), second = path.join(root, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    fs.writeFileSync(path.join(first, 'same.txt'), 'first\n')
    fs.writeFileSync(path.join(second, 'same.txt'), 'second\n')
    const packet = bindSessionChangePaths(changePacket('tool_call', changePayload), first, path)
    assert.equal(changePayload.changes[0].path, 'same.txt', 'the native packet was not mutated')
    const selected = sessionActivityEvent(packet, packet.sessionId).fileChanges[0]
    const files = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [second, first] })
    assert.equal(files.readChange(selected.path).text, 'first\n')
    assert.equal(files.readChange('same.txt').code, 'MC_DIFF_PATH_UNBOUND')
    assert.equal(files.write(selected.path, 'edited first\n').ok, true)
    assert.equal(fs.readFileSync(path.join(second, 'same.txt'), 'utf8'), 'second\n')
    const revoked = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [second] })
    assert.equal(revoked.readChange(selected.path).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('rename destinations are bound and a read failure is never reported as a deleted file', () => {
  const moved = changePacket('tool_call', { changes: [{ ...changePayload.changes[0], kind: { type: 'update', move_path: 'moved.txt' } }] })
  const bound = bindSessionChangePaths(moved, '/work', path.posix)
  assert.equal(sessionActivityEvent(bound, bound.sessionId).fileChanges[0].path, '/work/moved.txt')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-change-read-'))
  try {
    const file = path.join(root, 'same.txt')
    fs.writeFileSync(file, 'current\n')
    const failingFs = { ...fs, statSync: target => {
      if (target === file) { const error = new Error('permission refused'); error.code = 'EACCES'; throw error }
      return fs.statSync(target)
    } }
    const files = createDiffFiles({ fs: failingFs, path, randomUUID, workspaceRoots: () => [root] })
    assert.deepEqual(files.readChange(file), { ok: false, code: 'MC_DIFF_STAT_FAILED' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('empty files and pure renames remain listed with measured zero line changes', () => {
  for (const kind of [{ type: 'add' }, { type: 'delete' }, { type: 'update', move_path: 'renamed.txt' }]) {
    const buffer = createConfirmedFileChangeBuffer()
    const changes = [{ path: 'empty.txt', kind, diff: '' }]
    assert.equal(observe(buffer, changePacket('tool_call', { changes })), null)
    const confirmed = observe(buffer, changePacket('tool_result', { status: 'completed' }))
    assert.equal(confirmed.fileChanges.length, 1)
    assert.equal(confirmed.fileChanges[0].added, 0)
    assert.equal(confirmed.fileChanges[0].removed, 0)
    if (kind.move_path) assert.equal(confirmed.fileChanges[0].path, kind.move_path)
  }
})

const claudeCall = (tool, input, identity = {}) => ({ sessionId: 'claude-session', event: {
  type: 'tool_call', turnId: 'turn', toolCallId: 'write', tool, payload: input, ...identity,
} })
const claudeResult = (status = 'ok', identity = {}) => ({ sessionId: 'claude-session', event: {
  type: 'tool_result', turnId: 'turn', toolCallId: 'write', status,
  payload: [{ type: 'text', text: 'The tool completed.' }], ...identity,
} })

test('Claude Write and Edit retain successful bound targets with explicitly unavailable line counts', () => {
  for (const [tool, input] of [['Write', { content: 'replacement\n' }],
    ['Edit', { old_string: 'inside a line', new_string: '', replace_all: true }]]) {
    const buffer = createConfirmedFileChangeBuffer()
    const call = claudeCall(tool, { file_path: 'src/code.js', ...input })
    assert.equal(sessionActivityEvent(call, call.sessionId).fileChanges, undefined, 'unbound relative paths cannot become a recorded Claude target')
    const bound = bindSessionChangePaths(call, '/workspace', path.posix)
    assert.equal(call.event.payload.file_path, 'src/code.js')
    assert.equal(observe(buffer, bound), null)
    const confirmed = observe(buffer, claudeResult())
    assert.deepEqual(confirmed.fileChanges, [{ path: '/workspace/src/code.js', status: 'C', added: null, removed: null }])
    assert.deepEqual(confirmed.filePatches, [], 'substring inputs never become fabricated whole-file patches')
    assert.equal(observe(buffer, claudeResult()), null, 'duplicate outcomes do not count another edit')
  }
})

test('Claude changes cannot publish a failure, unrelated outcome, or mismatched tool', () => {
  for (const outcome of [claudeResult('error'), claudeResult('declined'), claudeResult(''),
    claudeResult('ok', { tool: 'Read' }), claudeResult('ok', { payload: { success: false } }),
    claudeResult('ok', { turnId: 'other' }), { ...claudeResult(), sessionId: 'other' }]) {
    const buffer = createConfirmedFileChangeBuffer()
    observe(buffer, claudeCall('Write', { file_path: '/workspace/code.js', content: 'new' }))
    assert.equal(observe(buffer, outcome), null)
  }
  assert.equal(observe(createConfirmedFileChangeBuffer(), claudeResult()), null)
  for (const input of [{ file_path: '/workspace/code.js' }, { file_path: '', content: 'new' },
    { file_path: '/workspace/\0code.js', content: 'new' }, { file_path: `/${'x'.repeat(4096)}`, content: 'new' }]) {
    const call = claudeCall('Write', input)
    assert.equal(sessionActivityEvent(call, call.sessionId).fileChanges, undefined)
  }
  const read = claudeCall('Read', { file_path: '/workspace/code.js', content: 'new' })
  assert.equal(sessionActivityEvent(read, read.sessionId).fileChanges, undefined)
})

test('pending Claude calls share the bounded lifetime and identity budget', () => {
  const buffer = createConfirmedFileChangeBuffer()
  for (let i = 0; i <= CHANGE_LIMITS.events; i++) {
    observe(buffer, claudeCall('Write', { file_path: '/workspace/code.js', content: 'new' }, { toolCallId: String(i) }))
  }
  assert.equal(observe(buffer, claudeResult('ok', { toolCallId: '0' })), null)
  assert.ok(observe(buffer, claudeResult('ok', { toolCallId: String(CHANGE_LIMITS.events) })))
  observe(buffer, { sessionId: 'claude-session', event: { type: 'turn_completed', turnId: 'turn' } })
  assert.equal(observe(buffer, claudeResult('ok', { toolCallId: '1' })), null)
})

test('a successful-looking nested status cannot override an explicit unsuccessful outcome', () => {
  for (const [outer, inner] of [['error', 'ok'], ['ok', 'failed'], ['declined', 'completed'],
    ['success', 'cancelled'], ['interrupted', 'success'], ['ok', 'in_progress'], [false, 'ok']]) {
    for (const provider of ['claude', 'codex']) {
      const buffer = createConfirmedFileChangeBuffer()
      const call = provider === 'claude'
        ? claudeCall('Write', { file_path: '/workspace/code.js', content: 'new' })
        : changePacket('tool_call', changePayload)
      observe(buffer, call)
      const result = provider === 'claude'
        ? claudeResult(outer, { payload: { status: inner } })
        : { ...changePacket('tool_result', { status: inner }), event: { ...changePacket('tool_result', { status: inner }).event, status: outer } }
      assert.equal(observe(buffer, result), null, `${provider}: ${String(outer)} conflicts with ${inner}`)
      const retry = provider === 'claude' ? claudeResult() : changePacket('tool_result', { status: 'completed' })
      assert.equal(observe(buffer, retry), null, 'a contradictory result consumes its pending attempt')
    }
  }
})

test('a Claude target keeps its session folder and the existing read/save fence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-change-roots-'))
  try {
    const first = path.join(root, 'first'), second = path.join(root, 'second')
    fs.mkdirSync(first); fs.mkdirSync(second)
    fs.writeFileSync(path.join(first, 'code.js'), 'first\n')
    fs.writeFileSync(path.join(second, 'code.js'), 'second\n')
    const call = bindSessionChangePaths(claudeCall('Write', { file_path: 'code.js', content: 'first\n' }), first, path)
    const buffer = createConfirmedFileChangeBuffer()
    observe(buffer, call)
    const selected = observe(buffer, claudeResult()).fileChanges[0]
    const files = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [second, first] })
    assert.equal(files.readChange(selected.path).text, 'first\n')
    assert.equal(files.write(selected.path, 'edited\n').ok, true)
    assert.equal(fs.readFileSync(path.join(second, 'code.js'), 'utf8'), 'second\n')
    const revoked = createDiffFiles({ fs, path, randomUUID, workspaceRoots: () => [second] })
    assert.equal(revoked.readChange(selected.path).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
    const escaped = bindSessionChangePaths(claudeCall('Write', { file_path: '../outside.js', content: 'x' }), first, path)
    assert.equal(files.readChange(escaped.event.payload.file_path).code, 'MC_DIFF_OUTSIDE_WORKSPACE')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('mixed measured and unknown edits preserve known counts and patches without inventing a complete original', () => {
  const store = createSessionChangeStore()
  const patch = { path: '/workspace/code.js', diff: '@@ -1 +1 @@\n-old\n+new\n' }
  store.add({ id: 'codex', files: [{ path: patch.path, status: 'M', added: 1, removed: 1 }], patches: [patch] })
  store.add({ id: 'claude', files: [{ path: patch.path, status: 'C', added: null, removed: null }] })
  const mixed = store.read().files[0]
  assert.equal(mixed.added, 1)
  assert.equal(mixed.removed, 1)
  assert.equal(mixed.edits, 2)
  assert.equal(mixed.unmeasuredEdits, 1)
  assert.equal(mixed.complete, false)
  assert.deepEqual(mixed.patches, [patch])
  store.add({ id: 'separate', files: [{ path: '/workspace/known.js', status: 'M', added: 0, removed: 0 }], patches: [] })
  assert.equal(store.read().files[1].unmeasuredEdits, undefined, 'unrelated measured files remain measured')
  store.add({ id: 'claude', files: [{ path: patch.path, status: 'M', added: 3, removed: 2 }], patches: [patch] })
  assert.equal(store.read().files[0].unmeasuredEdits, undefined, 'replacement metadata recalculates uncertainty')
  assert.equal(store.read().files[0].added, 4)
})
