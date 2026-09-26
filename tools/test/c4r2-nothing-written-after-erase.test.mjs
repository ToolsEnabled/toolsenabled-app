/* c4 second review (1.0.48 candidate 4), security R1 / correctness N1: "nothing
 * is written after erase" held only on the agent-host side. The renderer's
 * transcript channels (mc-transcripts:append, rollback, retry, migrate,
 * archive, commitArchive, cancelArchive, configure, and release, which flushes)
 * never checked the erase, and mc-reset:erase never closed the conversation
 * store. The result page stays open after an erase, so a tree send there wrote
 * its "you" line through append, whose mkdir is recursive: the conversation
 * folder came back inside the folder the erase had just emptied. A write queued
 * before the erase was not ordered before the sweep either.
 *
 * Real node transcript store; main.cjs's own transcript IPC handlers run from
 * source with their real guard.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r2-nothing-written-after-erase.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const MAIN = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

function slice(start, end) {
  const first = MAIN.indexOf(start)
  const last = MAIN.indexOf(end, first + start.length)
  assert.ok(first >= 0 && last > first, `missing source interval: ${start} .. ${end}`)
  return MAIN.slice(first, last)
}

const line = (nodeId, id, text) => ({ computerId: 'this-computer', nodeId, entries: [{ id, who: 'you', text, at: 1 }] })

async function scratch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-c4r2-erase-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

/* main.cjs's transcript IPC channels, from `const transcriptRefusalCode` to the
   folder chooser, over the real store and a stand-in capture. */
function transcriptChannels(store, flags) {
  const handlers = new Map()
  const released = []
  const sandbox = {
    ...flags,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    trustedFleetProfileSender: () => true,
    prefsRefusal: what => ({ ok: false, error: { code: 'MC_PREFS_UNTRUSTED_SENDER', message: what } }),
    transcriptCapture: {
      bind: () => ({ ok: true }),
      release: async request => { released.push(request.sessionId); return { ok: true, released: true } },
      flushNode: async () => {},
    },
    nodeTranscripts: store,
    nodePrivacyCleanup: { heldCleanup: () => false },
    withConversationStorageState: answer => answer,
    retryConversationStorage: () => store.retry(),
  }
  vm.createContext(sandbox)
  vm.runInContext(slice('function prefsErasedRefusal(what) {', '\nlet actionPermissionProfileHost'), sandbox)
  vm.runInContext(slice('const transcriptRefusalCode = ', "ipcMain.handle('mc-transcripts:chooseArchiveDirectory'"), sandbox)
  const call = (name, request) => handlers.get('mc-transcripts:' + name)({ sender: {} }, request)
  return { sandbox, call, released }
}

test('c4r2 R1: once an erase has started, the renderer\'s transcript channels write nothing; reads still answer', async t => {
  const directory = await scratch(t)
  const store = createNodeTranscriptStore({ directory })
  const active = path.join(directory, 'node-transcripts', 'active')
  const channels = transcriptChannels(store, { localDataErased: false, agentRuntimeStoppedForReset: false })
  const before = await channels.call('append', line('kept', 'e1', 'Before the erase.'))
  assert.equal(before.ok, true, 'an ordinary append works')

  // mc-reset:erase sets agentRuntimeStoppedForReset synchronously at its start.
  channels.sandbox.agentRuntimeStoppedForReset = true
  const names = async () => (await fs.readdir(active).catch(() => [])).sort()
  const folders = await names()
  const writes = {
    append: line('late', 'e2', 'Typed on the result page.'),
    rollback: { computerId: 'this-computer', nodeId: 'kept', entryId: 'e1' },
    migrate: { computerId: 'this-computer', nodeId: 'late', entries: [{ id: 'e3', who: 'you', text: 'old', at: 1 }] },
    archive: { computerId: 'this-computer', nodeId: 'kept' },
    commitArchive: { computerId: 'this-computer', nodeId: 'kept' },
    cancelArchive: { computerId: 'this-computer', nodeId: 'kept' },
    configure: { deleteNodesOnExit: true },
    retry: {},
    release: { sessionId: 'session-late' },
  }
  for (const [operation, request] of Object.entries(writes)) {
    const answer = await channels.call(operation, request)
    assert.equal(answer?.ok === false, true, `${operation} was accepted after the erase started: ${JSON.stringify(answer)}`)
  }
  assert.deepEqual(channels.released, [], 'release flushed a session into storage after the erase started')
  assert.deepEqual(await names(), folders, 'a conversation folder appeared after the erase started')
  const kept = await store.read({ computerId: 'this-computer', nodeId: 'kept' })
  assert.equal(kept.ok, true)
  assert.equal(JSON.stringify(kept).includes('Before the erase.'), true, 'rollback removed a line after the erase started')
  for (const operation of ['read', 'list', 'getSettings']) {
    const answer = await channels.call(operation, { computerId: 'this-computer', nodeId: 'kept' })
    assert.equal(answer?.ok, true, `${operation} is a read and still answers`)
  }

  // After the sweep: a send on the still-open result page recreates nothing.
  await fs.rm(path.join(directory, 'node-transcripts'), { recursive: true, force: true })
  channels.sandbox.localDataErased = true
  const after = await channels.call('append', line('late', 'e4', 'After the sweep.'))
  assert.equal(after?.ok === false, true)
  assert.equal(existsSync(path.join(directory, 'node-transcripts')), false, 'the erased conversation folder came back')
})

test('c4r2 R1: sealing the store for an erase lets a write already queued finish first, then refuses every later write', async t => {
  const directory = await scratch(t)
  let gate = null
  const writes = []
  const io = { ...fs, writeFile: async (...args) => { writes.push(args[0]); if (gate) await gate.promise; return fs.writeFile(...args) } }
  const store = createNodeTranscriptStore({ directory, io })
  assert.equal(typeof store.sealForErase, 'function', 'the store has no erase seal')
  gate = Promise.withResolvers()
  const queued = store.append(line('queued', 'q1', 'Queued before the erase.'))
  while (writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
  let sealed = false
  const sealing = store.sealForErase().then(() => { sealed = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sealed, false, 'the seal returned while a write was still running (the sweep could run under it)')
  gate.resolve(); gate = null
  const landed = await queued
  await sealing
  assert.equal(landed.ok, true, 'the write queued before the seal completed')
  const count = writes.length
  await assert.rejects(store.append(line('late', 'l1', 'Late.')), /closing/)
  await assert.rejects(store.rollback({ computerId: 'this-computer', nodeId: 'queued', entryId: 'q1' }), /closing/)
  await assert.rejects(store.configure({ deleteNodesOnExit: true }), /closing/)
  await assert.rejects(store.reserveTurn({ computerId: 'this-computer', nodeId: 'late', sessionId: 's', text: 'x' }), /closing/)
  assert.equal(writes.length, count, 'a write reached the disk after the seal')
  assert.equal(existsSync(path.join(directory, 'node-transcripts', 'active')), true)
})

/* The erase runs while an agent is mid-turn: the capture still holds its unsaved
   words (a thought in progress, flushed again as "unknown" when capture shuts
   down). With the store sealed, that later flush was refused, the capture
   recorded the refusal as unsaved words, and the quit after the erase stopped on
   "Conversation has not been saved" -- with Retry unable to help, because the
   store is closed for good. The words belong to the data the erase removes: the
   erase drops them, and nothing is written. */
test('c4r2 R1: an erase during a turn drops the capture\'s unsaved words, writes nothing, and the quit after it still goes', async t => {
  const directory = await scratch(t)
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  capture.bind({ sessionId: 's1', computerId: 'this-computer', nodeId: 'n1' })
  await capture.packet({ sessionId: 's1', event: { type: 'thinking', turnId: 't1', itemId: 'i1', status: 'inProgress', text: 'Working on it' } })
  await new Promise(resolve => setTimeout(resolve, 80)) // the capture's 50 ms flush
  const active = path.join(directory, 'node-transcripts', 'active')
  assert.equal(typeof capture.discardForErase, 'function', 'the capture has no erase step')
  // mc-reset:erase, after the agent host closed: the capture, then the store.
  capture.discardForErase()
  await store.sealForErase()
  await fs.rm(path.join(directory, 'node-transcripts'), { recursive: true, force: true }) // the sweep
  // The quit after the erase (closeAgentSessionsForQuit).
  capture.sealForShutdown()
  await assert.doesNotReject(capture.shutdown(), 'the quit after the erase was refused: the capture still owed words to a sealed store')
  const status = capture.getStorageStatus()
  assert.equal(status.unsaved === false && capture.hasPendingWrites() === false, true, `transcriptsCanQuit would refuse: ${JSON.stringify(status)}`)
  assert.equal(existsSync(active), false, 'something was written into conversation storage after the erase')
})
