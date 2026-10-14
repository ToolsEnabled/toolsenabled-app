import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createTranscriptRecoveryJournal } = require('../../shell/transcript-recovery-journal.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const missing = () => Object.assign(new Error('No inert sidecar'), { code: 'ENOENT' })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { for (let i = 0; i < 200 && !predicate(); i++) await tick(); assert.ok(predicate(), 'expected inert boundary was reached') }

/* A TURN THE PROVIDER ACCEPTED IS NEVER ANSWERED AS "NOT SENT".
 *
 * sendTurn() holds its answer at the accepted-prompt boundary until the
 * accepted words are saved and their reservation is released. When that
 * boundary fails AFTER the provider accepted the turn, the host used to reject
 * the send with the storage code it was given -- MC_TRANSCRIPT_STORAGE_FAILED,
 * the same code a refused reservation raises BEFORE dispatch -- and it did so
 * before it recorded the accepted turn as active. So every caller read a
 * running turn as a message that never left: the composer said "this message
 * was not sent. Your draft is kept", the queue drain put the entry back to be
 * sent again at the next boundary, the tree courier re-offered the batch, Stop
 * answered AGENT_TURN_NONE for a turn still running, and the next send was
 * admitted beside it. These cases drive the real host, store, capture and
 * recovery journal; only the provider adapter and one journal call are
 * fixtures. */
async function fixture(t, { provider = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-accepted-unsaved-'))
  let sends = 0, accepted = 0
  const interrupts = []
  const journal = createTranscriptRecoveryJournal({ directory: path.join(directory, 'recovery'), capacityBytes: 2 * 1024 * 1024 })
  await journal.ready
  const notices = []
  const store = createNodeTranscriptStore({ directory, recoveryJournal: journal, onStorageError: error => notices.push(error),
    io: { ...fs, unlink: async () => { throw missing() } } })
  const capture = createNodeTranscriptCapture({ store })
  const binding = { sessionId: 'accepted-unsaved', computerId: 'inert-computer', nodeId: 'inert-node' }
  capture.bind(binding)
  t.mock.method(engine, 'startCodexSession', async options => ({
    threadId: 'thread-' + options.sessionId, close() {}, adapter: {
      sendTurn(request) { sends++; return provider ? provider(request, sends) : { turnId: 'turn-' + sends } },
      // As the engines do: an interrupted turn ends with its own completion.
      async interrupt(request) {
        interrupts.push(request)
        options.onEvent({ type: 'turn_completed', turnId: request.turnId, status: 'interrupted' })
        return {}
      },
      answerApproval() {},
    },
  }))
  const host = createAgentHost({ enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    assertTranscriptWritable: () => store.assertWritable(),
    reserveTranscriptTurn: request => store.reserveTurn({ ...request, ...binding }),
  })
  host.onAcceptedPrompt(request => { accepted++; return capture.recordAcceptedTranscriptSend(request) })
  await host.startSession({ sessionId: binding.sessionId })
  t.after(async () => { await store.retry().catch(() => {}); await capture.retry({ durable: true }).catch(() => {}); await host.closeAll(); await journal.close() })
  /* The one fault: the recovery journal cannot release the reservation that
     was taken for this send, so saving its acceptance does not complete. */
  function failRelease({ gate = null } = {}) {
    const real = journal.releaseReservation.bind(journal)
    let left = 1
    t.mock.method(journal, 'releaseReservation', async (...args) => {
      if (left > 0) {
        left--
        if (gate) await gate
        throw Object.assign(new Error('Synthetic reservation release failure'), { code: 'EIO' })
      }
      return real(...args)
    })
  }
  return { host, store, capture, journal, binding, notices, interrupts, failRelease,
    sends: () => sends, accepted: () => accepted,
    request: text => ({ sessionId: binding.sessionId, text, origin: 'person' }) }
}

test('an accepted turn whose save cannot complete is answered as accepted, never as a storage refusal before dispatch', async t => {
  const f = await fixture(t)
  f.failRelease()
  const result = await f.host.sendTurnTracked(f.request('Accepted, then its reservation could not be released.'))
  assert.equal(f.sends(), 1)
  assert.equal(f.accepted(), 1, 'the provider accepted the turn')
  assert.equal(result.ok, false, 'the send still reports that saving did not complete')
  assert.equal(result.code, 'MC_TRANSCRIPT_SENT_UNSAVED',
    'a pre-dispatch storage code here told every caller the message was not sent')
  assert.equal(result.deliveryDisposition, 'accepted', 'the provider acceptance was observed, so delivery is not unknown')
  assert.ok(f.notices.length >= 1, 'the storage failure itself is still reported through the storage notice')
})

test('the accepted turn stays active: Stop reaches it and a second message cannot start beside it', async t => {
  const f = await fixture(t)
  f.failRelease()
  await assert.rejects(f.host.sendTurn(f.request('First message, accepted but unsaved.')), { code: 'MC_TRANSCRIPT_SENT_UNSAVED' })
  // Retry saving succeeds; the storage refusal that blocked a second
  // reservation is gone, so only the host's own turn state can refuse now.
  await f.store.retry()
  await assert.rejects(f.host.sendTurn(f.request('Second message while the first still runs.')), { code: 'AGENT_TURN_ACTIVE' },
    'the first turn is still running, so the second message must wait instead of starting another turn')
  assert.equal(f.sends(), 1, 'nothing else reached the provider')
  const stopped = await f.host.interrupt({ sessionId: f.binding.sessionId })
  assert.equal(stopped.turnId, 'turn-1', 'Stop names the running turn')
  assert.deepEqual(f.interrupts.map(request => request.turnId), ['turn-1'], 'Stop reached the provider for the running turn')
})

test('a Stop pressed while the accepted turn is held at its save boundary still reaches that turn', async t => {
  const f = await fixture(t)
  const gate = Promise.withResolvers()
  f.failRelease({ gate: gate.promise })
  const sending = f.host.sendTurn(f.request('Stop pressed during the save boundary.')).then(() => null, error => error)
  await until(() => f.accepted() === 1)
  // Accepted, and its answer is held at the save boundary: Stop lands now.
  const stopping = f.host.interrupt({ sessionId: f.binding.sessionId })
  await tick()
  gate.resolve()
  const [error, stopped] = await Promise.all([sending, stopping])
  assert.equal(error?.code, 'MC_TRANSCRIPT_SENT_UNSAVED')
  assert.equal(stopped.turnId, 'turn-1')
  assert.deepEqual(f.interrupts.map(request => request.turnId), ['turn-1'])
})

test('a dispatched send with no acknowledgement keeps its delivery-unknown answer when reservation cleanup fails', async t => {
  const ack = Promise.withResolvers()
  const f = await fixture(t, { provider: () => ack.promise })
  const pending = f.host.sendTurnTracked(f.request('Dispatched, never acknowledged, then cleanup failed.'))
  await until(() => f.sends() === 1)
  f.failRelease()
  ack.reject(Object.assign(new Error('No acknowledgement after dispatch'), { code: 'EPIPE' }))
  const result = await pending
  assert.equal(f.accepted(), 0, 'the provider never acknowledged this turn')
  assert.equal(result.deliveryDisposition, 'unknown')
  assert.equal(result.code, 'EPIPE',
    'the cleanup failure replaced the send answer with MC_TRANSCRIPT_STORAGE_FAILED, which the window reads as "not sent"')
  assert.ok(f.notices.some(notice => /do not resend/i.test(notice.message || '')), 'the cleanup failure reaches the storage notice instead')
})
