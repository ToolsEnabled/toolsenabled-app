/* 1.0.49 video box: the saved video choice per agent (shell/agent-video-sources.cjs)
 * and its removal by "Delete agent nodes when the app exits".
 *
 * Owner, 2026-09-26: a video pick IS REMEMBERED across restarts with a one-click
 * re-pick. What is remembered is the window's title and program name, bound to
 * the node identity; a window id never is (ids do not survive a restart and X11
 * reuses them). Real files in a private temporary directory; no Electron.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAgentVideoSources, cleanTitle, FILE_NAME, MAX_RECORDS } = require('../../shell/agent-video-sources.cjs')
const { createNodePrivacyCleanup, PENDING_KEY } = require('../../shell/node-privacy-cleanup.cjs')
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')

function directoryFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-video-sources-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const choice = (nodeId, title = 'ROS · agent') => ({ treeId: 'tree-1', nodeId, nodeCreatedAt: '2026-09-26T10:00:00.000Z', title, app: '' })
const identityOf = nodeId => ({ treeId: 'tree-1', nodeId, nodeCreatedAt: '2026-09-26T10:00:00.000Z' })
const temporaries = directory => fs.readdirSync(directory).filter(name => name.startsWith(FILE_NAME + '.'))

test('a saved choice is private, whole and bound to its node; it never holds a window id', { skip: process.platform === 'win32' }, t => {
  const directory = directoryFor(t)
  let clock = Date.parse('2026-09-26T10:05:00.000Z')
  const store = createAgentVideoSources({ directory, now: () => new Date(clock) })
  const saved = store.remember(choice('node-a'))
  assert.deepEqual(saved, { ...choice('node-a'), savedAt: '2026-09-26T10:05:00.000Z' })
  const stat = fs.lstatSync(store.file)
  assert.equal(store.file, path.join(directory, 'agent-video-sources.json'))
  assert.equal(stat.isFile(), true)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(stat.nlink, 1)
  const text = fs.readFileSync(store.file, 'utf8')
  assert.deepEqual(JSON.parse(text), { version: 1, sources: [{ ...choice('node-a'), savedAt: '2026-09-26T10:05:00.000Z' }] })
  assert.equal(/window:\d/.test(text), false)
  assert.deepEqual(temporaries(directory), [], 'the atomic write leaves no half-written copy')
  // A second choice for the same agent replaces the first.
  clock += 1000
  store.remember(choice('node-a', 'Terminal'))
  assert.deepEqual(createAgentVideoSources({ directory }).list(identityOf).map(record => record.title), ['Terminal'])
})

test(`at most ${MAX_RECORDS} choices are kept, and the oldest makes room`, t => {
  const directory = directoryFor(t)
  let clock = Date.parse('2026-09-26T10:00:00.000Z')
  const store = createAgentVideoSources({ directory, now: () => new Date(clock += 1000) })
  for (let index = 0; index <= MAX_RECORDS; index++) store.remember(choice('node-' + index))
  const kept = store.list(identityOf).map(record => record.nodeId)
  assert.equal(kept.length, MAX_RECORDS)
  assert.equal(kept.includes('node-0'), false)
  assert.equal(kept.includes('node-' + MAX_RECORDS), true)
  assert.ok(fs.statSync(store.file).size <= 64 * 1024)
})

test('a choice whose agent is gone or was re-created is dropped when read, and the file forgets it', t => {
  const directory = directoryFor(t)
  const store = createAgentVideoSources({ directory })
  for (const nodeId of ['kept', 'removed', 'recreated']) store.remember(choice(nodeId))
  const current = nodeId => nodeId === 'kept' ? identityOf(nodeId)
    : nodeId === 'recreated' ? { ...identityOf(nodeId), nodeCreatedAt: '2026-09-26T11:00:00.000Z' } : null
  assert.deepEqual(store.list(current).map(record => record.nodeId), ['kept'])
  const onDisk = JSON.parse(fs.readFileSync(store.file, 'utf8')).sources.map(record => record.nodeId)
  assert.deepEqual(onDisk, ['kept'])
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('removed'), false)
})

test('a symbolic link, a second hard link, a shared mode or an oversized file is never read, followed or rewritten', { skip: process.platform === 'win32' }, t => {
  const directory = directoryFor(t)
  const outside = directoryFor(t)
  const target = path.join(outside, 'target.json')
  const valid = JSON.stringify({ version: 1, sources: [{ ...choice('node-a'), savedAt: '2026-09-26T10:00:00.000Z' }] }) + '\n'
  const cases = {
    'symbolic link': file => { fs.writeFileSync(target, valid, { mode: 0o600 }); fs.symlinkSync(target, file) },
    'second hard link': file => { fs.writeFileSync(target, valid, { mode: 0o600 }); fs.linkSync(target, file) },
    'shared mode': file => { fs.writeFileSync(file, valid); fs.chmodSync(file, 0o644) },
    oversized: file => { fs.writeFileSync(file, ' '.repeat(64 * 1024 + 1), { mode: 0o600 }) },
    damaged: file => { fs.writeFileSync(file, '{"version":1,"sources":[{"nodeId":"x"}]}', { mode: 0o600 }) },
  }
  for (const [name, make] of Object.entries(cases)) {
    const store = createAgentVideoSources({ directory })
    make(store.file)
    assert.throws(() => store.list(identityOf), { code: 'VIDEO_SAVED_UNREADABLE' }, name)
    assert.throws(() => store.remember(choice('node-b')), { code: 'VIDEO_SAVED_UNREADABLE' }, name)
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, 'utf8'), valid, `${name}: the other file is untouched`)
    // "Turn off all video" is the way out, and it removes only this name.
    store.clear()
    assert.equal(fs.existsSync(store.file), false, name)
    if (name !== 'shared mode' && name !== 'oversized' && name !== 'damaged') assert.equal(fs.readFileSync(target, 'utf8'), valid, `${name}: clear never follows`)
    fs.rmSync(target, { force: true })
    assert.deepEqual(temporaries(directory), [], name)
  }
})

test('turning one agent off removes its title, even from a file that cannot be read', t => {
  const directory = directoryFor(t)
  const store = createAgentVideoSources({ directory })
  store.remember(choice('node-a', 'Private mail'))
  store.remember(choice('node-b', 'Terminal'))
  store.forget('node-a')
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('Private mail'), false)
  assert.deepEqual(store.list(identityOf).map(record => record.nodeId), ['node-b'])
  store.forget('node-b')
  assert.equal(fs.existsSync(store.file), false, 'the last choice takes the file with it')
  fs.writeFileSync(store.file, '{ not json Private mail', { mode: 0o600 })
  store.forget('node-a')
  assert.equal(fs.existsSync(store.file), false)
})

/* REVIEW F2: a hard kill between writing the half-written copy and renaming
   it leaves agent-video-sources.json.<uuid>.tmp behind, holding every saved
   title. Only Turn off all video and the privacy cleanup removed it. */
test('a half-written copy left by a hard kill is removed when the store opens and by every later save or turn-off', t => {
  const directory = directoryFor(t)
  const orphan = () => {
    const name = `${FILE_NAME}.${randomUUID()}.tmp`
    fs.writeFileSync(path.join(directory, name), JSON.stringify({ version: 1, sources: [{ ...choice('node-a', 'Private mail'), savedAt: '2026-09-26T10:00:00.000Z' }] }), { mode: 0o600 })
    return name
  }
  const kept = path.join(directory, 'other.json.tmp')
  fs.writeFileSync(kept, '{}')
  // A hard kill's copy is at least as old as the kill. One written a moment ago
  // may be the running app's save in flight (the next test), and opening the
  // store leaves that one alone.
  const leftover = path.join(directory, orphan())
  const hourAgo = new Date(Date.now() - 3_600_000)
  fs.utimesSync(leftover, hourAgo, hourAgo)
  const fresh = path.join(directory, orphan())
  const store = createAgentVideoSources({ directory })
  assert.deepEqual(temporaries(directory), [path.basename(fresh)], 'the next launch removes a hard kill\u2019s copy, never a save in flight')
  fs.rmSync(fresh)
  assert.equal(fs.existsSync(kept), true, 'only this store’s own copies are removed')
  orphan()
  store.remember(choice('node-b', 'Terminal'))
  assert.deepEqual(temporaries(directory), [], 'a save removes it')
  orphan()
  store.forget('node-a')
  assert.deepEqual(temporaries(directory), [], 'turning off an agent the file never held removes it')
  orphan()
  store.forget('node-b')
  assert.equal(fs.existsSync(store.file), false)
  assert.deepEqual(temporaries(directory), [], 'turning off the last choice removes it')
  // Tidying is best effort: a directory that cannot be read never fails a save.
  const blind = createAgentVideoSources({ directory, io: { ...fs, readdirSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } } })
  assert.equal(blind.remember(choice('node-c', 'Files')).title, 'Files')
})

/* REVIEW F2 (1.0.49 merge review): a second launch builds this store at load,
   before it loses the single-instance lock -- and every tree-node command arrives
   as exactly such a launch. Its open used to delete every temporary copy,
   including the one the running app had written and not yet renamed, so the
   rename failed and the save emptied the file: the person's saved choices gone. */
test('a second launch opening the store while the running app saves loses nothing', t => {
  const directory = directoryFor(t)
  const first = createAgentVideoSources({ directory })
  first.remember(choice('node-a', 'ROS sim - Xephyr'))
  const racing = createAgentVideoSources({ directory, io: { ...fs, constants: fs.constants,
    renameSync: (from, to) => { createAgentVideoSources({ directory }); return fs.renameSync(from, to) } } })
  assert.equal(racing.remember(choice('node-b', 'Robot arm - rviz')).title, 'Robot arm - rviz')
  assert.deepEqual(first.list(identityOf).map(record => record.nodeId).sort(), ['node-a', 'node-b'])
  assert.deepEqual(temporaries(directory), [])
})

test('a save that fails leaves no earlier choice to come back', t => {
  const directory = directoryFor(t)
  const store = createAgentVideoSources({ directory })
  store.remember(choice('node-a', 'Private mail'))
  store.remember(choice('node-b', 'Terminal'))
  const failing = createAgentVideoSources({ directory, io: { ...fs, renameSync() { throw Object.assign(new Error('disk failed'), { code: 'EIO' }) } } })
  assert.throws(() => failing.forget('node-a'), { code: 'VIDEO_SAVED_WRITE_FAILED' })
  assert.deepEqual(store.list(identityOf), [], 'the turned-off choice did not survive the failed save')
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('Private mail'), false)
  assert.deepEqual(temporaries(directory), [])
  const error = (() => { try { failing.remember(choice('node-c')) } catch (caught) { return caught } })()
  assert.equal(error?.code, 'VIDEO_SAVED_WRITE_FAILED')
  assert.equal(/Private mail|Terminal|window:/.test(String(error?.message)), false, 'a refusal never carries a title')
})

test('nothing can be saved after the quit-time privacy cleanup or after Erase', t => {
  const directory = directoryFor(t)
  let erased = false
  const store = createAgentVideoSources({ directory, sealed: () => erased })
  store.remember(choice('node-a'))
  erased = true
  assert.throws(() => store.remember(choice('node-b')), { code: 'VIDEO_SAVED_CLOSED' })
  assert.deepEqual(store.list(nodeId => nodeId === 'none' ? identityOf(nodeId) : null), [])
  assert.equal(fs.existsSync(store.file), true, 'a sealed store does not rewrite the file while it is being erased')
  store.clear()
  assert.equal(fs.existsSync(store.file), false, 'removal is still allowed')

  const quitting = createAgentVideoSources({ directory: directoryFor(t) })
  quitting.remember(choice('node-a'))
  fs.writeFileSync(path.join(path.dirname(quitting.file), FILE_NAME + '.' + randomUUID() + '.tmp'), 'half written Private mail')
  assert.deepEqual(quitting.clearForPrivacy({ close: true }), { ok: true, cleared: true })
  assert.equal(quitting.confirmCleared(), true)
  assert.deepEqual(temporaries(path.dirname(quitting.file)), [], 'a half-written copy goes too')
  assert.throws(() => quitting.remember(choice('node-b')), { code: 'VIDEO_SAVED_CLOSED' })
  assert.equal(quitting.confirmCleared(), true)
})

test('a window title is kept as plain text: control characters become spaces and no surrogate pair is split', () => {
  assert.equal(cleanTitle('ROS\u0000\u001b[31m · agent\n'), 'ROS [31m · agent')
  const long = 'a'.repeat(299) + '😀'
  assert.equal(cleanTitle(long), 'a'.repeat(299))
  assert.equal(cleanTitle(undefined), '')
})

/* THE PRIVACY CLEANUP. "Delete agent nodes when the app exits" removes the
   saved video choices with the other node data, only after the organisation
   reset succeeded (the transcripts' rule), and its read-back holds the
   owner-gone barrier while one is still on disk. */
function privacyPrefs(t) {
  const directory = directoryFor(t)
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  prefs.set('mc.fleet.trees.v1:this-computer', 'forest')
  return { directory, prefs }
}

test('delete-on-exit keeps the video choices until the organisation reset succeeds, then removes them', async t => {
  const { directory, prefs } = privacyPrefs(t)
  const store = createAgentVideoSources({ directory })
  store.remember(choice('node-a', 'Private mail'))
  let failReset = true
  const org = { resetOrg: () => ({ ok: !failReset }) }
  const transcripts = { clearForPrivacy: async () => {} }
  assert.throws(() => createNodePrivacyCleanup({ prefs, org, transcripts, videoSources: store }).prepare(), /privacy cleanup/)
  assert.equal(fs.existsSync(store.file), true, 'kept while the organisation reset has not succeeded')
  failReset = false
  await createNodePrivacyCleanup({ prefs, org, transcripts, videoSources: store }).recover()
  assert.equal(fs.existsSync(store.file), false)
  assert.equal(store.confirmCleared(), true)
  assert.equal(prefs.snapshot().values[PENDING_KEY], undefined)
  // The launch that finished the cleanup keeps running, so it may save again.
  store.remember(choice('node-b'))
  assert.equal(fs.existsSync(store.file), true)
})

test('the quit removes the video choices after the organisation reset, and a late save is refused', t => {
  const { directory, prefs } = privacyPrefs(t)
  const store = createAgentVideoSources({ directory })
  store.remember(choice('node-a', 'Private mail'))
  const order = []
  const org = { resetOrg: () => { order.push('org-reset'); return { ok: true } } }
  const videoSources = {
    clearForPrivacy: options => { order.push('video-clear'); return store.clearForPrivacy(options) },
    confirmCleared: () => store.confirmCleared(),
  }
  createNodePrivacyCleanup({ prefs, org, transcripts: { clearForPrivacy: async () => {} }, videoSources }).prepare()
  assert.deepEqual(order, ['org-reset', 'video-clear'])
  assert.equal(fs.existsSync(store.file), false)
  assert.throws(() => store.remember(choice('node-b')), { code: 'VIDEO_SAVED_CLOSED' })
})

test('the owner-gone barrier stays while a video choice is still on disk', () => {
  const values = {}
  const prefs = {
    snapshot: () => ({ ok: true, values: { ...values } }),
    set: (key, value) => { values[key] = value; return { ok: true } },
    remove: key => { delete values[key]; return { ok: true } },
    prepareNodePrivacyCleanup: () => ({ ok: true }),
    confirmNodePrivacyCleanup: () => ({ ok: true, durable: true, sourceBytesAbsent: true }),
  }
  const receipt = (marker, phase) => ({ operationId: marker.operationId, mode: marker.mode, phase, durable: true,
    sourceNodeIds: [], taskSetDigest: 'a'.repeat(64), taskCount: 0 })
  let onDisk = true
  const finalized = []
  const cleanup = createNodePrivacyCleanup({
    prefs, org: { resetOrg: () => ({ ok: true }) }, transcripts: { clearForPrivacy: async () => {} },
    videoSources: { clearForPrivacy() {}, confirmCleared: () => !onDisk },
    ownerGone: marker => receipt(marker, 'committed'),
    finalizeOwnerGone: input => { finalized.push(input); return receipt(input, 'finalized') },
    makeOperationId: () => 'privacy-video-fixture',
  })
  cleanup.prepare()
  assert.throws(() => cleanup.complete(), /read back/)
  assert.equal(finalized.length, 0, 'the barrier is not released')
  assert.equal(typeof values[PENDING_KEY], 'string', 'the operation stays pending for the next launch')
  onDisk = false
  cleanup.complete()
  assert.equal(finalized.length, 1)
  assert.equal(values[PENDING_KEY], undefined)
})
