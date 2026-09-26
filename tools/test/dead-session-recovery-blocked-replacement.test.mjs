// A refused second replacement and a dead replacement are different facts.
// Drive the real recovery, single-flight and outbox, with a deferred provider
// boundary. The previous source pins could not detect stale queue addresses.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { nodeIsBusy, sessionEndedWithApp } from '../../src/tree-session-liveness.js'
import { functionSource, realOutbox } from './fixtures/recovery-outbox.mjs'

function fixture({ currentSession = 'old', result = 'engine', ended = false } = {}) {
  const original = { id: 'node', sessionId: 'old', status: 'finished' }
  let current = { ...original, sessionId: currentSession }, release
  const gate = new Promise(resolve => { release = resolve })
  const outbox = realOutbox(), owned = new Set([currentSession]), starts = [], sent = [], failures = [], accepted = []
  const sandbox = {
    LAUNCH_TIERS: [], slotAccountStartOptions,
    Date, treeStore: { getNode: () => current }, destroyed: false,
    nodeReplacementFlight: createSingleFlight(), recoveryCoordinator: () => null,
    recoveringNodes: new Set(), retainStartingTreeStore: () => () => {},
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', startControlOffReason: () => 'disabled',
    START_REFUSAL: { sessionGone: 'gone' }, RECOVERED_SESSION: { reconnecting: 'reconnecting', bare: 'bare', summarised: 'summary' },
    QUEUE_PANEL: { cardQueued: 'queued', busyAttachment: 'keep the file' }, RESUME_PANEL: { underway: 'replacing' },
    transcriptStore: { has: () => true, get: () => null }, nodeSessionEnded: node => sessionEndedWithApp(node, owned),
    nodeBusy: node => nodeIsBusy(node, owned), outboxEnqueue: outbox.enqueue, outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel,
    async resumeNodeSessionUnguarded(node) {
      starts.push(node.id)
      await gate
      if (!result && !ended) return false
      owned.delete(current.sessionId)
      if (!ended) { outbox.moveSession(current.sessionId, 'new'); owned.add('new') }
      current = { ...current, sessionId: 'new', status: ended ? 'running' : 'finished' }
      return ended ? false : result
    },
    drainOutboxMessage(sessionId, nodeId, entry) { sent.push(entry.text); outbox.confirmDelivered(sessionId, entry); current.status = 'running' },
    treeCardSend() { assert.fail('text recovery must use the same FIFO') },
  }
  const api = vm.runInNewContext(`(() => { ${functionSource('resumeNodeSession')}\n${functionSource('recoverDeadSessionSend')}; return { resumeNodeSession, recoverDeadSessionSend } })()`, sandbox)
  return { api, outbox, starts, sent, failures, accepted, release, original, current: () => current,
    waiting: session => Array.from(outbox.list(session), entry => entry.text),
    recover: (text = 'FIRST', node = original) => api.recoverDeadSessionSend(node, text, {
      reply() {}, fail: sentence => failures.push(sentence), accepted: () => accepted.push(text),
    }),
  }
}

test('a recovery blocked by an actual pending manual Resume joins its FIFO without starting twice', async () => {
  const f = fixture()
  const manual = f.api.resumeNodeSession(f.current())
  await f.recover()
  assert.deepEqual(f.starts, ['node'])
  assert.deepEqual(f.accepted, ['FIRST'])
  assert.deepEqual(f.failures, [])
  assert.deepEqual(f.waiting('old'), ['FIRST'])
  assert.deepEqual(f.sent, [])
  f.release(); assert.equal(await manual, 'engine')
  assert.deepEqual(f.sent, ['FIRST'])
  assert.deepEqual(f.waiting('new'), [])
})

test('a late refusal of the old session queues under the newly published address even with a stale caller node', async () => {
  const f = fixture({ currentSession: 'published' })
  const manual = f.api.resumeNodeSession(f.current())
  await f.recover('LATE', f.original)
  assert.deepEqual(f.waiting('old'), [], 'the earlier migration already happened; this address cannot be serviced again')
  assert.deepEqual(f.waiting('published'), ['LATE'])
  assert.deepEqual(f.accepted, ['LATE'])
  assert.deepEqual(f.failures, [])
  assert.equal(f.starts.length, 1)
  f.release(); await manual
  assert.deepEqual(f.sent, ['LATE'])
})

test('a genuine failed start preserves the admitted text beside its saved conversation for a later retry', async () => {
  const f = fixture({ result: false })
  const recovery = f.recover()
  f.release(); await recovery
  assert.deepEqual(f.waiting('old'), ['FIRST'])
  assert.deepEqual(f.waiting('new'), [])
  assert.deepEqual(f.accepted, ['FIRST'])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.failures, [])
})

test('an already ended replacement refuses its triggering text without accepting or dropping other queued words', async () => {
  const f = fixture({ ended: true })
  assert.equal(f.outbox.enqueue('old', 'EARLIER').ok, true)
  const recovery = f.recover()
  f.release(); await recovery
  assert.deepEqual(f.accepted, [])
  assert.deepEqual(f.failures, ['gone'])
  assert.deepEqual(f.waiting('old'), ['EARLIER'])
  assert.deepEqual(f.sent, [])
})

test('a node with no queue address refuses before opening a replacement', async () => {
  const f = fixture({ currentSession: null })
  await f.recover()
  assert.equal(f.starts.length, 0)
  assert.equal(f.accepted.length, 0)
  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0], /no session/)
})

test('a full real outbox refuses recovery without dropping its older messages or opening a replacement', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) assert.equal(f.outbox.enqueue('old', `OLDER ${index}`).ok, true)
  await f.recover()
  assert.equal(f.starts.length, 0)
  assert.equal(f.accepted.length, 0)
  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0], /12 messages waiting/)
  assert.deepEqual(f.waiting('old'), Array.from({ length: 12 }, (_, index) => `OLDER ${index}`))
})
