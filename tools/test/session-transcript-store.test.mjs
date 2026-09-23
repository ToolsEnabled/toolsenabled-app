// The durable transcript store (src/session-transcript-store.js).
//
// The assertions worth reading twice:
//
//   1. A damaged RECORD is dropped alone; a damaged ENVELOPE reads as empty.
//      This store deliberately fails at the opposite grain from fleet-trees'
//      all-or-nothing parser, because one oversized conversation must not
//      erase the others — that asymmetry is documented in both headers and a
//      change to either side should have to look here first.
//   2. Every bound is enforced at save, not trusted at read: lines per node,
//      characters per line, records per computer, and the envelope's
//      serialized size — and the record being saved is never evicted to make
//      room for itself.
//   3. The seed text is oldest-first and drops OLDEST lines under its budget,
//      saying so — the newest words are where the work stands.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
const { createNodeTranscriptStore } = createRequire(import.meta.url)('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = createRequire(import.meta.url)('../../shell/node-transcript-capture.cjs')

async function diskStore(t, options = {}) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'node-transcripts-'))
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }))
  return { directory, store: createNodeTranscriptStore({ directory, ...options }) }
}

test('disk history retains 55 active nodes, full text, updates and older pages across reopen', async t => {
  const { directory, store } = await diskStore(t)
  for (let i = 0; i < 55; i += 1) {
    await store.append({ computerId: 'computer', nodeId: `node-${i}`, entries: [{ id: 'first', who: 'you', text: 'a'.repeat(900) }], metadata: { threadId: `thread-${i}`, provider: 'claude', account: 'work' } })
  }
  await store.append({ computerId: 'computer', nodeId: 'node-0', entries: Array.from({ length: 100 }, (_, i) => ({ id: `message-${i}`, who: 'agent', text: `message ${i}` })) })
  await store.append({ computerId: 'computer', nodeId: 'node-0', entries: [{ id: 'message-99', who: 'agent', text: 'updated without duplication' }] })
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  assert.equal((await reopened.list({ computerId: 'computer' })).records.length, 55)
  const latest = await reopened.read({ computerId: 'computer', nodeId: 'node-0', limit: 60 })
  assert.equal(latest.entries.length, 60)
  assert.equal(latest.count, 101)
  assert.equal(latest.entries.at(-1).text, 'updated without duplication')
  assert.equal(latest.metadata.threadId, 'thread-0')
  const oldest = await reopened.read({ computerId: 'computer', nodeId: 'node-0', before: latest.before, limit: 60 })
  assert.equal(oldest.entries.length, 41)
  assert.equal(oldest.entries[0].text.length, 900)
  assert.equal(oldest.before, null)
  const childRead = execFileSync(process.execPath, ['-e', `
    const { createNodeTranscriptStore } = require(process.argv[1]);
    const store = createNodeTranscriptStore({ directory: process.argv[2] });
    store.list({ computerId: 'computer' }).then(answer => process.stdout.write(String(answer.records.length)));
  `, path.resolve('shell/node-transcript-store.cjs'), directory], { windowsHide: true, encoding: 'utf8' })
  assert.equal(childRead, '55', 'a fresh process reads every active node from disk')
})

test('archive quota excludes active history and staged closure preserves active nodes until committed', async t => {
  const { store } = await diskStore(t, { settings: { archiveMaxBytes: 0 } })
  for (const nodeId of ['open', 'closed']) await store.append({ computerId: 'c', nodeId, entries: [{ id: 'one', who: 'you', text: nodeId }] })
  const receipt = await store.archive({ computerId: 'c', nodeId: 'closed', stageOnly: true })
  assert.equal((await store.read({ computerId: 'c', nodeId: 'closed' })).entries.length, 1)
  await store.commitArchive({ computerId: 'c', nodeId: 'closed', archiveId: receipt.archiveId })
  assert.equal((await store.read({ computerId: 'c', nodeId: 'open' })).entries[0].text, 'open')
  assert.equal((await store.list({ computerId: 'c' })).records.length, 1)
  await assert.rejects(store.append({ computerId: 'c', nodeId: 'closed', entries: [{ id: 'late', who: 'you', text: 'late' }] }), /closed/)
  const canceled = await store.archive({ computerId: 'c', nodeId: 'open', stageOnly: true })
  await store.cancelArchive({ computerId: 'c', nodeId: 'open', archiveId: canceled.archiveId })
  assert.equal((await store.read({ computerId: 'c', nodeId: 'open' })).entries[0].text, 'open')
})

test('default shutdown retains history; explicit privacy clears only after node deletion succeeds', async t => {
  const { directory, store } = await diskStore(t)
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'one', who: 'you', text: 'keep' }] })
  assert.equal((await store.getSettings()).transcript.deleteNodesOnExit, false)
  await store.shutdown({ deleteNodes: () => { throw new Error('must not run') } })
  const failed = createNodeTranscriptStore({ directory, settings: { deleteNodesOnExit: true } })
  await assert.rejects(failed.shutdown({ deleteNodes: async () => { throw new Error('nodes refused') } }), /nodes refused/)
  const success = createNodeTranscriptStore({ directory, settings: { deleteNodesOnExit: true } })
  assert.equal((await success.read({ computerId: 'c', nodeId: 'n' })).entries.length, 1)
  let deletedNodes = false
  await success.shutdown({ deleteNodes: async () => { deletedNodes = true } })
  assert.equal(deletedNodes, true)
  assert.equal((await createNodeTranscriptStore({ directory }).list({ computerId: 'c' })).records.length, 0)
  await assert.rejects(success.append({ computerId: 'c', nodeId: 'n', entries: [] }), /closing/)
})

test('failed archive copy retains original history and failed entry replacement retains previous bytes', async t => {
  const { directory, store } = await diskStore(t)
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'one', who: 'you', text: 'original' }] })
  const failing = createNodeTranscriptStore({ directory, io: { ...fsPromises,
    cp: async () => { throw new Error('copy denied') },
    rename: async () => { throw new Error('replace denied') },
  } })
  await assert.rejects(failing.archive({ computerId: 'c', nodeId: 'n' }), /copy denied/)
  await assert.rejects(failing.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'one', who: 'you', text: 'replacement' }] }), /replace denied/)
  assert.equal((await store.read({ computerId: 'c', nodeId: 'n' })).entries[0].text, 'original')
})

test('renderer captures before viewport trimming and rollback removes only the failed message', async t => {
  const { store } = await diskStore(t)
  const errors = []
  const client = createNodeTranscriptClient({ computerId: 'c', bridge: store, onError: message => errors.push(message) })
  await client.ready
  const viewport = []
  for (let i = 0; i < 75; i += 1) {
    const entry = { id: `id-${i}`, who: 'you', text: `${i}:` + 'x'.repeat(1000) }
    await client.capture('n', entry)
    viewport.push(entry)
    if (viewport.length > 60) viewport.shift()
  }
  await client.save('n', { lines: viewport, threadId: 'thread', provider: 'claude', account: 'work' })
  assert.equal(client.get('n').lines.length, 60)
  assert.equal((await store.read({ computerId: 'c', nodeId: 'n' })).count, 75)
  await client.rollback('n', 'id-74')
  const page = await store.read({ computerId: 'c', nodeId: 'n' })
  assert.equal(page.count, 74)
  assert.equal(page.entries.at(-1).id, 'id-73')
  assert.equal(errors.length, 0)
  client.dispose()
})

test('main capture keeps live deltas without a renderer and drains its timer on shutdown', async t => {
  const { directory, store } = await diskStore(t)
  const timers = new Map()
  let timerId = 0
  const capture = createNodeTranscriptCapture({ store,
    schedule: callback => { timers.set(++timerId, callback); return timerId },
    cancel: id => timers.delete(id),
  })
  capture.bind({ sessionId: 'session', computerId: 'c', nodeId: 'n' })
  await capture.recordAcceptedTranscriptSend({ sessionId: 'session', text: 'user request', turnId: 'turn' })
  for (let i = 0; i < 80; i += 1) capture.packet({ sessionId: 'session', event: { type: 'assistant_text_delta', turnId: 'turn', text: 'long text '.repeat(50) } })
  // Provider's complete-text echo must not duplicate its delta stream.
  capture.packet({ sessionId: 'session', event: { type: 'assistant_text', turnId: 'turn', text: 'long text '.repeat(4000) } })
  await capture.flushNode({ computerId: 'c', nodeId: 'n' })
  const live = await store.read({ computerId: 'c', nodeId: 'n' })
  assert.equal(live.entries.length, 2)
  assert.equal(live.entries[1].text, 'long text '.repeat(4000))
  capture.packet({ sessionId: 'session', event: { type: 'assistant_text_delta', turnId: 'next', text: 'pending at shutdown' } })
  await capture.shutdown()
  assert.equal(timers.size, 0)
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  assert.equal((await reopened.read({ computerId: 'c', nodeId: 'n' })).entries.at(-1).text, 'pending at shutdown')
})

test('migration precedes concurrent capture and unknown metadata cannot erase saved resume identity', async t => {
  const { store } = await diskStore(t)
  const legacy = { get: () => ({ lines: [{ who: 'you', text: 'old excerpt', at: 1 }], threadId: 'kept-thread', account: 'work', provider: 'claude' }) }
  const client = createNodeTranscriptClient({ computerId: 'c', bridge: store, legacy, nodeIds: ['n'] })
  const first = client.capture('n', { id: 'new', who: 'agent', text: 'new message' })
  const saved = client.save('n', { lines: [{ id: 'new', who: 'agent', text: 'new message' }], threadId: null, provider: null, keepUnknown: true })
  await Promise.all([first, saved])
  const page = await store.read({ computerId: 'c', nodeId: 'n' })
  assert.deepEqual(page.entries.map(entry => entry.text), ['old excerpt', 'new message'])
  assert.equal(page.metadata.threadId, 'kept-thread')
  assert.equal(page.metadata.account, 'work')
})

test('first read and first append share one node index while hydration is pending', async t => {
  const { directory } = await diskStore(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let directoryReads = 0
  const store = createNodeTranscriptStore({ directory, io: { ...fsPromises, readdir: async target => {
    directoryReads += 1
    await gate
    return fsPromises.readdir(target)
  } } })
  const read = store.read({ computerId: 'c', nodeId: 'n' })
  const append = store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'first', who: 'you', text: 'preserved' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(directoryReads, 1, 'two callers constructed competing node indexes')
  release()
  await Promise.all([read, append])
  assert.equal((await store.read({ computerId: 'c', nodeId: 'n' })).entries[0].text, 'preserved')
})

test('canonical capture before migration cannot hide the older excerpt and migration retries do not duplicate it', async t => {
  const { store } = await diskStore(t)
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'new', who: 'agent', text: 'new capture' }], metadata: { threadId: 'new-thread', account: 'new-account' } })
  const legacy = { get: () => ({ lines: [{ who: 'you', text: 'old first', at: 1 }, { who: 'agent', text: 'old second', at: 2 }], threadId: 'old-thread', account: 'old-account' }) }
  for (let i = 0; i < 2; i += 1) {
    const client = createNodeTranscriptClient({ computerId: 'c', bridge: store, legacy, nodeIds: ['n'] })
    await client.ready
    assert.equal(client.get('n').threadId, 'new-thread')
    client.dispose()
  }
  const page = await store.read({ computerId: 'c', nodeId: 'n', limit: 2 })
  assert.deepEqual(page.entries.map(entry => entry.text), ['old second', 'new capture'])
  const first = await store.read({ computerId: 'c', nodeId: 'n', before: page.before, limit: 2 })
  assert.deepEqual(first.entries.map(entry => entry.text), ['old first'])
  assert.equal(page.count, 3)
  assert.equal(page.metadata.account, 'new-account')
})

test('a late append invalidates the archive receipt and active history is never deleted', async t => {
  const { store } = await diskStore(t)
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'first', who: 'you', text: 'before copy' }] })
  const receipt = await store.archive({ computerId: 'c', nodeId: 'n', stageOnly: true })
  await store.appendText({ computerId: 'c', nodeId: 'n', entryId: 'late', text: 'after copy' })
  await assert.rejects(store.commitArchive({ computerId: 'c', nodeId: 'n', archiveId: receipt.archiveId }), /changed after/)
  assert.deepEqual((await store.read({ computerId: 'c', nodeId: 'n' })).entries.map(entry => entry.text), ['before copy', 'after copy'])
  assert.equal((await store.list({ computerId: 'c' })).records.length, 1)
})

test('rollback invalidates a staged archive across store reopen', async t => {
  const { directory, store } = await diskStore(t)
  const node = { computerId: 'c', nodeId: 'rollback-before-reopen' }
  await store.append({ ...node, entries: [
    { id: 'kept', who: 'you', text: 'Keep this line.' },
    { id: 'removed', who: 'you', text: 'The failed send was rolled back.' },
  ] })
  const receipt = await store.archive({ ...node, stageOnly: true })
  await store.rollback({ ...node, entryId: 'removed' })
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  await assert.rejects(reopened.commitArchive({ ...node, archiveId: receipt.archiveId }), /changed after/)
  const retained = await reopened.read(node)
  assert.deepEqual(retained.entries.map(entry => entry.id), ['kept'])
  assert.notEqual(retained.metadata.closed, true)
  await reopened.shutdown()
})

test('an archive prepared after rollback remains valid across store reopen', async t => {
  const { directory, store } = await diskStore(t)
  const node = { computerId: 'c', nodeId: 'rollback-before-archive' }
  await store.append({ ...node, entries: [
    { id: 'kept', who: 'agent', text: 'Keep this answer.' },
    { id: 'removed', who: 'you', text: 'Remove this failed send.' },
  ] })
  await store.rollback({ ...node, entryId: 'removed' })
  const receipt = await store.archive({ ...node, stageOnly: true })
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  assert.equal((await reopened.commitArchive({ ...node, archiveId: receipt.archiveId })).ok, true)
  assert.equal((await reopened.read(node)).metadata.closed, true)
  const archivedFolder = path.join(directory, 'transcript-graveyard', receipt.archiveId.replace('transcript-pending-', 'transcript-'))
  const entries = await Promise.all((await fsPromises.readdir(archivedFolder))
    .filter(name => name !== 'node.json' && name.endsWith('.json'))
    .map(async name => JSON.parse(await fsPromises.readFile(path.join(archivedFolder, name), 'utf8'))))
  assert.deepEqual(entries.map(entry => entry.id), ['kept'])
  await reopened.shutdown()
})

test('rollback preserves transcript bytes when its durable revision cannot be saved', async t => {
  const { directory, store } = await diskStore(t)
  const node = { computerId: 'c', nodeId: 'rollback-revision-refused' }
  await store.append({ ...node, entries: [{ id: 'kept', who: 'you', text: 'Still here.' }] })
  await store.shutdown()
  const failing = createNodeTranscriptStore({ directory, io: { ...fsPromises,
    rename: async (source, destination) => {
      if (path.basename(destination) === 'node.json') throw new Error('revision replacement denied')
      return fsPromises.rename(source, destination)
    },
  } })
  await assert.rejects(failing.rollback({ ...node, entryId: 'kept' }), /revision replacement denied/)
  assert.equal((await failing.read(node)).entries[0].text, 'Still here.')
  await failing.shutdown()
})

import {
  TRANSCRIPT_LIMITS,
  createTranscriptStore,
  parseTranscriptRow,
  transcriptSeedText,
  transcriptStorageKey,
} from '../../src/session-transcript-store.js'

const COMPUTER = 'c1'

/* The same face safeTreeStorage presents: read hands back a parsed value,
   write takes one. Deep-copied both ways so a test cannot pass by mutating
   the store's own memory. */
function fakeSeam() {
  const held = new Map()
  return {
    read: key => (held.has(key) ? JSON.parse(JSON.stringify(held.get(key))) : null),
    write: (key, value) => { held.set(key, JSON.parse(JSON.stringify(value))); return true },
    held,
  }
}

const line = (who, text, at = 1000) => ({ who, text, at })

test('action outcomes survive legacy reopen and migration into native history', async t => {
  const seam = fakeSeam()
  const legacy = createTranscriptStore({ computerId: 'c', storage: seam })
  const states = ['working', 'done', 'undone', 'waiting', 'refused', 'unknown', 'closed']
  const entries = states.map((state, index) => ({
    who: 'action', tool: 'Command', text: `Fixture action ${index}`, state, at: index + 1,
  }))
  entries.push({ who: 'action', tool: 'Command', text: 'Unrecognized outcome', state: 'future-status', at: 7 })
  assert.equal(legacy.save('n', { lines: entries }), true)
  const reopened = createTranscriptStore({ computerId: 'c', storage: seam })
  const expected = [...states, 'unknown']
  assert.deepEqual(reopened.get('n').lines.map(entry => entry.state), expected,
    'a saved refusal or missing result must not reopen as a successful action')

  const { directory, store } = await diskStore(t)
  const client = createNodeTranscriptClient({ computerId: 'c', bridge: store, legacy: reopened, nodeIds: ['n'] })
  await client.ready
  await store.shutdown()
  const native = createNodeTranscriptStore({ directory })
  assert.deepEqual((await native.read({ computerId: 'c', nodeId: 'n' })).entries.map(entry => entry.state), expected,
    'migration must preserve each recorded outcome in durable native history')
  await native.shutdown()
})

test('nothing stored reads as empty and undamaged', () => {
  assert.deepEqual(parseTranscriptRow(null), { nodes: {}, damaged: false })
  assert.deepEqual(parseTranscriptRow(undefined), { nodes: {}, damaged: false })
})

test('a damaged envelope degrades to empty and says so', () => {
  for (const raw of ['text', 42, [], { v: 2, nodes: {} }, { nodes: {} }]) {
    const parsed = parseTranscriptRow(raw)
    assert.deepEqual(parsed.nodes, {}, `nodes must be empty for ${JSON.stringify(raw)}`)
    assert.equal(parsed.damaged, true, `damaged must be said for ${JSON.stringify(raw)}`)
  }
})

test('a damaged record is dropped alone — the other conversations survive', () => {
  const parsed = parseTranscriptRow({
    v: 1,
    nodes: {
      good: { savedAt: 5, threadId: 't-1', lines: [line('you', 'hello')] },
      noLines: { savedAt: 5, threadId: null, lines: [] },
      badShape: 'not a record',
      badWho: { savedAt: 5, threadId: null, lines: [{ who: 'narrator', text: 'x', at: 1 }] },
    },
  })
  assert.equal(parsed.damaged, false)
  assert.deepEqual(Object.keys(parsed.nodes), ['good'])
  assert.equal(parsed.nodes.good.threadId, 't-1')
})

test('bad wiring throws; a person cannot cause either argument', () => {
  assert.throws(() => createTranscriptStore({ computerId: '', storage: fakeSeam() }), TypeError)
  assert.throws(() => createTranscriptStore({ computerId: COMPUTER, storage: { read() {} } }), TypeError)
})

test('save and read back: lines, threadId, and effort survive the trip', () => {
  const seam = fakeSeam()
  const store = createTranscriptStore({ computerId: COMPUTER, storage: seam })
  assert.equal(store.save('n1', { lines: [line('you', 'do the thing'), line('agent', 'done')], threadId: 'thr-9', effort: 'xhigh' }), true)
  const read = store.get('n1')
  assert.equal(read.threadId, 'thr-9')
  assert.equal(read.effort, 'xhigh')
  assert.deepEqual(read.lines.map(entry => entry.text), ['do the thing', 'done'])
  assert.equal(store.has('n1'), true)
  assert.equal(store.has('n2'), false)
  /* The record landed under this computer's own key. */
  assert.ok(seam.held.has(transcriptStorageKey(COMPUTER)))
})

test('action outcomes survive persistence without refused or unknown becoming done', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  const actions = ['refused', 'unknown', 'closed', 'undone', 'waiting', 'working', 'done']
    .map((state, index) => ({
      who: 'action',
      kind: 'result',
      tool: 'Command',
      text: `step ${index}`,
      state,
      at: index + 1,
    }))
  assert.equal(store.save('actions', { lines: actions }), true)
  assert.deepEqual(store.get('actions').lines.map(entry => entry.state), actions.map(entry => entry.state),
    'the transcript store must retain every live action outcome across its cleaning boundary')
})

test('an unknown depth reads as none recorded, never as a value to re-send', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  store.save('n1', { lines: [line('you', 'hi')], effort: 'ultra' })
  assert.equal(store.get('n1').effort, null)
})

test('line bounds land at save: newest lines kept, long text cut', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  const many = Array.from({ length: TRANSCRIPT_LIMITS.maxLines + 10 }, (_, i) => line('you', `m${i}`))
  store.save('n1', { lines: many })
  const read = store.get('n1')
  assert.equal(read.lines.length, TRANSCRIPT_LIMITS.maxLines)
  assert.equal(read.lines[read.lines.length - 1].text, `m${TRANSCRIPT_LIMITS.maxLines + 9}`)
  store.save('n2', { lines: [line('agent', 'x'.repeat(TRANSCRIPT_LIMITS.maxLineChars + 50))] })
  assert.equal(store.get('n2').lines[0].text.length, TRANSCRIPT_LIMITS.maxLineChars)
})

test('a save of nothing is refused rather than recorded', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  assert.equal(store.save('n1', { lines: [] }), false)
  assert.equal(store.save('', { lines: [line('you', 'hi')] }), false)
  assert.equal(store.has('n1'), false)
})

test('the record cap holds and the newest save always survives it', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes + 4; i += 1) {
    assert.equal(store.save(`n${i}`, { lines: [line('you', `hello ${i}`)] }), true)
  }
  /* Count through the public face: has() re-reads the envelope every call. */
  let count = 0
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes + 4; i += 1) if (store.has(`n${i}`)) count += 1
  assert.equal(count, TRANSCRIPT_LIMITS.maxNodes)
  assert.equal(store.has(`n${TRANSCRIPT_LIMITS.maxNodes + 3}`), true, 'the newest save must never be the eviction')
})

test('the envelope size bound evicts others, never the record being saved', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  const fat = Array.from({ length: TRANSCRIPT_LIMITS.maxLines }, (_, i) =>
    line(i % 2 ? 'you' : 'agent', 'w'.repeat(TRANSCRIPT_LIMITS.maxLineChars)))
  for (let i = 0; i < 6; i += 1) assert.equal(store.save(`fat${i}`, { lines: fat }), true)
  assert.equal(store.has('fat5'), true, 'the last save must have survived its own eviction pass')
})

test('remove forgets one conversation and leaves the rest', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  store.save('n1', { lines: [line('you', 'a')] })
  store.save('n2', { lines: [line('you', 'b')] })
  assert.equal(store.remove('n1'), true)
  assert.equal(store.has('n1'), false)
  assert.equal(store.has('n2'), true)
  assert.equal(store.remove('n1'), true, 'removing what is absent is already the goal state')
})

test('the seed text is oldest-first inside a frame that names both voices', () => {
  const seed = transcriptSeedText([line('you', 'first ask'), line('agent', 'first answer'), line('you', 'second ask')])
  assert.ok(seed.startsWith('You are taking over from an earlier agent'))
  const askAt = seed.indexOf('The person said: first ask')
  const answerAt = seed.indexOf('The agent before you said: first answer')
  const secondAt = seed.indexOf('The person said: second ask')
  assert.ok(askAt > -1 && answerAt > askAt && secondAt > answerAt, 'lines must read in the order they were spoken')
  assert.ok(seed.includes('do not redo it'))
  assert.equal(transcriptSeedText([]), '')
})

test('a resume keeps a long report completion and latest owner correction intact', () => {
  const report = 'Working notes: ' + 'x'.repeat(1000) + '\nDONE: commit abc123 verified; await a new assignment.'
  const correction = 'Background: ' + 'y'.repeat(800) + '\nCorrection: stop the old lane; Research is the current assignment.'
  const seed = transcriptSeedText([line('agent', report), line('you', correction)])
  assert.ok(seed.includes(report), 'the display excerpt limit must not cut the canonical report')
  assert.ok(seed.includes(correction), 'owner corrections at the end of a message must survive')
  assert.doesNotMatch(seed, /Reply with a short note on where things stand\./)
})

test('resume preserves the assignment when refreshed product context exceeds the seed budget', () => {
  const assignment = 'Write /workspace/RESULT.txt containing EXACT_RESULT and read it back.'
  const additions = ['tree', 'requests', 'tasks', 'history', 'role', 'tools', 'capabilities'].map(promptKind => ({
    ...line('you', `${promptKind}: ${'current session context '.repeat(100)}`),
    promptKind, promptSource: 'toolsenabled',
  }))
  const seed = transcriptSeedText([line('you', assignment), ...additions,
    line('agent', 'I will write the exact content and verify it.')])
  assert.ok(seed.includes(assignment), 'injected context must not evict the assigned work')
  assert.ok(seed.includes('I will write the exact content and verify it.'))
  assert.doesNotMatch(seed, /current session context/)
  assert.doesNotMatch(seed, /Older messages were left out/)
  const literal = 'TOOLSENABLED ROLE DIRECTIONS: preserve these quoted words in my request.'
  assert.ok(transcriptSeedText([line('you', literal)]).includes(literal), 'unmarked person speech is never filtered by its wording')
})

test('an oversized latest message preserves its ending and labels the omitted middle', () => {
  const seed = transcriptSeedText([line('agent', 'BEGIN REPORT ' + 'x'.repeat(12000) + ' END: completed; do not rerun.')])
  assert.ok(seed.includes('BEGIN REPORT'))
  assert.ok(seed.includes('END: completed; do not rerun.'))
  assert.match(seed, /middle.*omitted/i)
  assert.ok(seed.length < TRANSCRIPT_LIMITS.seedMaxChars + 600)
})

test('a short progress reply does not drop an oversized opening assignment', () => {
  const opening = 'Copy /workspace/INPUT.txt to /workspace/RESULT.txt and verify its exact bytes.\n'
    + 'Tree orientation. '.repeat(350) + '\nRespect the current assignment boundary.'
  const progress = 'I will copy the input and verify the output with a readback.'
  const seed = transcriptSeedText([line('you', opening), line('agent', progress)])
  assert.ok(opening.length > TRANSCRIPT_LIMITS.seedMaxChars)
  assert.ok(seed.includes('/workspace/INPUT.txt'))
  assert.ok(seed.includes('/workspace/RESULT.txt'))
  assert.ok(seed.includes('Respect the current assignment boundary.'))
  assert.ok(seed.includes(progress))
  assert.match(seed, /middle.*omitted/i)
  assert.match(seed, /Obtain the missing text from the person before acting/)
  assert.ok(seed.length < TRANSCRIPT_LIMITS.seedMaxChars + 600)
})

test('a bounded fallback identifies the actual saved files that recover every omitted assignment constraint', async t => {
  const { store } = await diskStore(t)
  const opening = 'Copy /workspace/INPUT.txt to /workspace/RESULT.txt.\n' + 'Context. '.repeat(250)
    + '\nOnly copy lines marked PUBLIC; preserve their exact bytes.\n' + 'More context. '.repeat(400) + '\nVerify the output.'
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'assignment', who: 'you', text: opening, recoveryFiles: ['/forged/source.json'] }] })
  await store.appendText({ computerId: 'c', nodeId: 'n', entryId: 'progress', text: 'I will copy the input and verify it.' })
  const client = createNodeTranscriptClient({ computerId: 'c', bridge: store })
  await client.ready
  const saved = await client.readLatest('n')
  const seed = transcriptSeedText(saved.lines, { recoveryDirectory: saved.recoveryDirectory })
  const assignmentFile = saved.lines[0].recoveryFiles[0]
  assert.equal(path.dirname(assignmentFile), saved.recoveryDirectory)
  assert.ok(seed.includes(JSON.stringify(assignmentFile)))
  assert.doesNotMatch(seed, /forged\/source/)
  assert.match(seed, /Read its complete saved text before continuing/)
  assert.equal(JSON.parse(await fsPromises.readFile(assignmentFile, 'utf8')).text, opening)
  const progressFiles = saved.lines[1].recoveryFiles
  assert.equal(progressFiles.length, 2, 'streamed speech identifies both the entry and its continuation')
  assert.equal(JSON.parse(await fsPromises.readFile(progressFiles[0], 'utf8')).text
    + await fsPromises.readFile(progressFiles[1], 'utf8'), saved.lines[1].text)
  const ordinaryRead = await store.read({ computerId: 'c', nodeId: 'n' })
  assert.equal(ordinaryRead.recoveryDirectory, undefined)
  assert.equal(ordinaryRead.entries[0].recoveryFiles, undefined, 'stored fields cannot forge recovery provenance')
})

test('a paged fallback names its own complete conversation when older messages are outside the viewport', () => {
  const seed = transcriptSeedText([line('agent', 'Waiting for the input file.')], { recoveryDirectory: '/profile/node-transcripts/active/this-node', earlierMessages: true })
  assert.match(seed, /Older messages were left out/)
  assert.match(seed, /\/profile\/node-transcripts\/active\/this-node/)
  assert.match(seed, /Recover omitted assignment details and constraints.*before acting/)
})

test('a page containing only actions and refreshed context still recovers older speech', () => {
  const page = [line('action', 'read file'), { ...line('you', 'Current tools'), promptSource: 'toolsenabled', promptKind: 'tools' }]
  const seed = transcriptSeedText(page, { recoveryDirectory: '/profile/node-transcripts/active/this-node', earlierMessages: true })
  assert.match(seed, /\/profile\/node-transcripts\/active\/this-node/)
  assert.match(seed, /Recover omitted assignment details and constraints.*before acting/)
  assert.doesNotMatch(seed, /The person said|The agent before you said/)
  assert.ok(seed.length < TRANSCRIPT_LIMITS.seedMaxChars)
  assert.equal(transcriptSeedText(page), '', 'no history or locator remains an empty conversation')
})

test('a seed over budget drops the OLDEST words and says so', () => {
  const lines = Array.from({ length: 30 }, (_, i) => line('you', `${i}:${'x'.repeat(500)}`))
  const seed = transcriptSeedText(lines)
  assert.ok(seed.length < TRANSCRIPT_LIMITS.seedMaxChars + 600, 'the frame may exceed the budget only by its fixed sentences')
  assert.ok(seed.includes('(Older messages were left out to fit.)'))
  assert.ok(seed.includes('The person said: 29:'), 'the newest line must survive')
  assert.ok(!seed.includes('The person said: 0:'), 'the oldest line must be the one dropped')
})

test('the provider that wrote the thread is kept, and an unknown one reads as null', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  store.save('node-a', { lines: [line('you', 'hi')], threadId: 't-1', effort: 'medium', provider: 'codex' })
  assert.equal(store.get('node-a').provider, 'codex')
  store.save('node-b', { lines: [line('you', 'hi')], threadId: 't-2', provider: 'openai' })
  assert.equal(store.get('node-b').provider, null, 'a provider this app does not run is not remembered as one it does')
  store.save('node-c', { lines: [line('you', 'hi')], threadId: 't-3' })
  assert.equal(store.get('node-c').provider, null)
})

test('the account that owns a provider thread is kept exactly and never truncated into another identity', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  store.save('node-a', {
    lines: [line('you', 'hi')],
    threadId: 'thread-owned',
    provider: 'claude',
    account: 'work-account',
  })
  assert.equal(store.get('node-a').account, 'work-account')

  store.save('node-long', {
    lines: [line('you', 'hi')],
    threadId: 'thread-long',
    provider: 'claude',
    account: 'x'.repeat(TRANSCRIPT_LIMITS.maxAccountNameChars + 1),
  })
  assert.equal(store.get('node-long').account, null,
    'an overlong identity was truncated and could select a different registered account')

  store.save('node-nul', {
    lines: [line('you', 'hi')],
    threadId: 'thread-nul',
    provider: 'claude',
    account: 'work\0account',
  })
  assert.equal(store.get('node-nul').account, null)
})


test('detached recovery reads fresh canonical history after another writer advances it', async t => {
  const { store } = await diskStore(t)
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'first', who: 'agent', text: 'Earlier', at: 1 }], metadata: { threadId: 'old-thread' } })
  const client = createNodeTranscriptClient({ computerId: 'c', bridge: store })
  await client.ready
  await store.append({ computerId: 'c', nodeId: 'n', entries: [{ id: 'second', who: 'agent', text: 'Current progress', at: 2 }], metadata: { threadId: 'current-thread' } })
  assert.equal(client.get('n').threadId, 'old-thread')
  const latest = await client.readLatest('n')
  assert.equal(latest.threadId, 'current-thread')
  assert.deepEqual(latest.lines.map(line => line.text), ['Earlier', 'Current progress'])
  assert.equal(await client.save('n', { ...latest, keepUnknown: true }), true)
})

test('turn stamps are bounded identities and never truncated into another turn', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  for (const turnStamp of ['turn-1', 'x'.repeat(512)]) {
    store.save('node', { lines: [{ ...line('agent', 'reply'), turnStamp }] })
    assert.equal(store.get('node').lines[0].turnStamp, turnStamp)
  }
  for (const turnStamp of ['x'.repeat(513), ' ', 'bad\nidentity', 4, null]) {
    store.save('node', { lines: [{ ...line('agent', 'reply'), turnStamp }] })
    assert.equal(store.get('node').lines[0].turnStamp, undefined)
  }
})
