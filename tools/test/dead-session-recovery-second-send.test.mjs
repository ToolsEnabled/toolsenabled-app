// Execute the actual closure-private recovery and resume functions with a
// deferred provider boundary. Source text pins missed the ordering bug where
// the 15-second fresh-attempt throttle rejected messages during an active resume.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { functionSource, realOutbox } from './fixtures/recovery-outbox.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fifoFixture(mode) {
  const outbox = realOutbox()
  const gate = deferred()
  let current = { id: 'fifo-node', sessionId: 'old-session', status: 'finished' }
  const wire = [], failures = [], admitted = [], resumes = []
  const sandbox = {
    LAUNCH_TIERS: [], slotAccountStartOptions,
    Date, treeStore: { getNode: () => current }, recoveringNodes: new Set(),
    nodeReplacementFlight: createSingleFlight(), recoveryCoordinator: () => null,
    retainStartingTreeStore: () => () => {}, destroyed: false,
    async resumeNodeSessionUnguarded(node, options) {
      resumes.push(options)
      await gate.promise
      outbox.moveSession(current.sessionId, 'new-session')
      current = { ...current, sessionId: 'new-session', status: mode === 'summary' ? 'running' : mode === 'seed-interrupted' ? 'interrupted' : 'finished' }
      return mode === 'engine' ? 'engine' : mode === 'ready' ? 'ready' : true
    },
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', startControlOffReason: () => 'disabled',
    START_REFUSAL: { sessionGone: 'gone' }, RECOVERED_SESSION: { reconnecting: 'reconnecting', bare: 'bare', summarised: 'summary' },
    QUEUE_PANEL: { cardQueued: 'queued', busyAttachment: 'keep the file' }, RESUME_PANEL: { underway: 'replacing' },
    transcriptStore: { has: () => true, get: () => null }, nodeSessionEnded: () => false,
    nodeBusy: node => node.status === 'running' || node.status === 'starting',
    outboxEnqueue: outbox.enqueue, outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel,
    drainOutboxMessage(sessionId, nodeId, entry) {
      wire.push(entry.text)
      outbox.confirmDelivered(sessionId, entry)
      current = { ...current, status: 'running' }
    },
    treeCardSend(node, text) { wire.push(text); current = { ...current, status: 'running' } },
  }
  const api = vm.runInNewContext(`(() => { ${functionSource('resumeNodeSession')}\n${functionSource('recoverDeadSessionSend')}; return { recoverDeadSessionSend } })()`, sandbox)
  const send = (text, attachments) => api.recoverDeadSessionSend(current, text, {
    reply() {}, fail: (sentence, details) => failures.push({ text, sentence, details }), accepted: () => admitted.push(text), attachments,
  })
  const waiting = sessionId => Array.from(outbox.list(sessionId), entry => entry.text)
  const complete = () => {
    current = { ...current, status: 'finished' }
    const next = outbox.takeNext(current.sessionId)
    if (next) sandbox.drainOutboxMessage(current.sessionId, current.id, next)
  }
  return { gate, send, waiting, wire, failures, admitted, resumes, complete, sandbox, outbox }
}

for (const mode of ['engine', 'ready', 'summary', 'seed-finished']) {
  test(`the real outbox preserves first then second through ${mode} recovery`, async () => {
    const f = fifoFixture(mode)
    const first = f.send('FIRST')
    await f.send('SECOND')
    assert.deepEqual(f.waiting('old-session'), ['FIRST', 'SECOND'], 'FIRST must reserve its FIFO position before awaiting the replacement')
    assert.deepEqual(f.wire, [], 'no user message may overtake the pending recovery')
    f.gate.resolve()
    await first
    if (mode === 'summary') {
      assert.deepEqual(f.wire, [], 'the seed still owns the active turn')
      f.complete()
    }
    assert.deepEqual(f.wire, ['FIRST'])
    assert.deepEqual(f.waiting('new-session'), ['SECOND'])
    f.complete()
    assert.deepEqual(f.wire, ['FIRST', 'SECOND'])
    assert.deepEqual(f.waiting('new-session'), [])
    assert.deepEqual(f.failures, [])
    assert.deepEqual([...f.admitted].sort(), ['FIRST', 'SECOND'])
    assert.equal(f.resumes.length, 1)
    assert.equal(f.resumes[0].deferSeed, true, 'queued intent must be the first fallback turn')
  })
}

test('an interrupted seed keeps both recovery messages queued after the replacement settles', async () => {
  const f = fifoFixture('seed-interrupted')
  const first = f.send('FIRST')
  await f.send('SECOND')
  f.gate.resolve(); await first
  assert.deepEqual(f.waiting('new-session'), ['FIRST', 'SECOND'])
  assert.deepEqual(f.wire, [])
  assert.deepEqual(f.failures, [])
  assert.deepEqual([...f.admitted].sort(), ['FIRST', 'SECOND'])
})

test('a second recovery send with an attachment stays in the composer instead of entering a text-only outbox', async () => {
  const f = fifoFixture('engine')
  const first = f.send('FIRST')
  await f.send('SECOND IMAGE', [{ path: 'owned-image' }])
  assert.deepEqual(f.waiting('old-session'), ['FIRST'])
  assert.deepEqual(f.failures.map(row => [row.text, row.sentence, row.details.restoreDraft]), [['SECOND IMAGE', 'keep the file', true]])
  assert.deepEqual(f.admitted, [])
  f.gate.resolve(); await first
  assert.deepEqual(f.wire, ['FIRST'])
  assert.deepEqual(f.admitted, ['FIRST'])
})

for (const recoveryMode of ['engine', 'ready']) test(`${recoveryMode} recovery forwards the original attachments intact before draining later text`, async () => {
  const f = fifoFixture(recoveryMode), attachments = [{ path: 'owned-image' }], received = []
  f.sandbox.treeCardSend = (node, text, options) => {
    assert.equal(options.recoveryAttempted, true)
    received.push(options.attachments)
    f.wire.push(text)
    options.accepted()
  }
  const first = f.send('FIRST IMAGE', attachments)
  await f.send('SECOND')
  f.gate.resolve(); await first
  assert.equal(received.length, 1)
  assert.equal(received[0], attachments)
  assert.deepEqual(f.wire, ['FIRST IMAGE'])
  assert.deepEqual(f.waiting('new-session'), ['SECOND'])
  f.complete()
  assert.deepEqual(f.wire, ['FIRST IMAGE', 'SECOND'])
  assert.deepEqual(f.failures, [])
  assert.deepEqual([...f.admitted].sort(), ['FIRST IMAGE', 'SECOND'])
})

for (const mode of ['summary', 'seed-finished']) {
  test(`${mode} recovery retains an unsendable attachment and still services later accepted text`, async () => {
    const f = fifoFixture(mode)
    const first = f.send('FIRST IMAGE', [{ path: 'owned-image' }])
    await f.send('SECOND')
    f.gate.resolve(); await first
    assert.deepEqual(f.failures.map(row => [row.text, row.sentence, row.details.restoreDraft]), [['FIRST IMAGE', 'keep the file', true]])
    assert.deepEqual(f.admitted, ['SECOND'])
    if (mode === 'summary') { assert.deepEqual(f.wire, []); f.complete() }
    assert.deepEqual(f.wire, ['SECOND'])
    assert.deepEqual(f.waiting('new-session'), [])
  })
}
function recoveryFixture({ startAllowed = true } = {}) {
  const pending = deferred()
  const outbox = realOutbox()
  let clock = 30000
  let current = { id: 'node', sessionId: 'retired-session', status: 'finished' }
  const resumes = [], enqueued = [], delivered = [], replies = [], failures = []
  let accepted = 0, retained = 0
  const sandbox = {
    LAUNCH_TIERS: [], slotAccountStartOptions,
    Date: { now: () => clock },
    treeStore: { getNode: () => current }, destroyed: false,
    recoveringNodes: new Set(),
    // The stale ownership map must not decide whether text can join the ONE
    // replacement already holding this node's single-flight slot.
    sessionNodeIds: { has() { assert.fail('Recovery queried retired session ownership') } },
    nodeReplacementFlight: createSingleFlight(), recoveryCoordinator: () => null,
    retainStartingTreeStore() { retained++; return () => { retained-- } },
    resumeNodeSessionUnguarded(node, options) { resumes.push({ node, options }); return pending.promise },
    isWriteEnabled: () => startAllowed, START_CONTROL_FLAG: 'start', startControlOffReason: () => 'start disabled',
    START_REFUSAL: { sessionGone: 'session gone' }, RESUME_PANEL: { underway: 'already replacing' },
    RECOVERED_SESSION: { reconnecting: 'reconnecting', bare: 'starting', summarised: 'summary resumed' },
    QUEUE_PANEL: { cardQueued: 'queued' }, transcriptStore: { has: () => true, get: () => null },
    outboxEnqueue(sessionId, text) { enqueued.push({ sessionId, text }); return outbox.enqueue(sessionId, text) },
    outboxTakeNext: outbox.takeNext, outboxCancel: outbox.cancel,
    drainOutboxMessage(sessionId, nodeId, entry) { delivered.push({ sessionId, text: entry.text }); outbox.confirmDelivered(sessionId, entry) },
    nodeBusy: node => node.status === 'running' || node.status === 'starting',
    nodeSessionEnded: () => false,
    treeCardSend(node, text) { delivered.push({ sessionId: node.sessionId, text }) },
  }
  const api = vm.runInNewContext(`(() => {${functionSource('resumeNodeSession')}\n${functionSource('recoverDeadSessionSend')}\nreturn { resumeNodeSession, recoverDeadSessionSend } })()`, sandbox)
  const send = text => api.recoverDeadSessionSend(current, text, {
    reply: value => replies.push({ text, value }), fail: value => failures.push({ text, value }),
    accepted: () => { accepted++ },
  })
  return { api, sandbox, pending, resumes, enqueued, delivered, replies, failures, send,
    get node() { return current }, setNode: node => {
      if (node.sessionId !== current.sessionId) outbox.moveSession(current.sessionId, node.sessionId)
      current = node
    }, setClock: value => { clock = value },
    get accepted() { return accepted }, get retained() { return retained } }
}

test('a second message during an actual pending recovery queues before the fresh-attempt throttle', async () => {
  const f = recoveryFixture()
  const first = f.send('first message')
  assert.equal(f.resumes.length, 1)
  assert.equal(f.sandbox.recoveringNodes.has('node'), true)
  assert.equal(f.retained, 1)
  await f.send('second message')
  assert.deepEqual(f.failures, [], 'the pending recovery, not its recent timestamp, must decide this send')
  assert.deepEqual(f.enqueued, [{ sessionId: 'retired-session', text: 'first message' }, { sessionId: 'retired-session', text: 'second message' }])
  assert.equal(f.accepted, 1)
  assert.equal(f.resumes.length, 1, 'queuing must not start another replacement')
  f.setNode({ ...f.node, sessionId: 'fresh-session' })
  f.pending.resolve('engine')
  await first
  assert.deepEqual(f.delivered, [{ sessionId: 'fresh-session', text: 'first message' }])
  assert.equal(f.retained, 0)
  assert.equal(f.sandbox.recoveringNodes.size, 0)
})

test('a second message uses the latest stored session even when the replacement has changed its ID', async () => {
  const f = recoveryFixture()
  const first = f.send('first')
  f.setNode({ ...f.node, sessionId: 'freshly-assigned' })
  await f.send('second')
  assert.deepEqual(f.enqueued, [{ sessionId: 'retired-session', text: 'first' }, { sessionId: 'freshly-assigned', text: 'second' }])
  assert.deepEqual(f.failures, [])
  f.pending.resolve('engine'); await first
})

test('a new user message gets another automatic recovery immediately after a settled attempt', async () => {
  const f = recoveryFixture()
  const first = f.send('first')
  f.pending.resolve('engine'); await first
  await f.send('new attempt immediately')
  assert.deepEqual(f.failures, [])
  assert.equal(f.resumes.length, 2)
})

test('the real resume wrapper excludes a second replacement and releases retained storage on settlement', async () => {
  const f = recoveryFixture()
  const first = f.api.resumeNodeSession(f.node)
  assert.equal(await f.api.resumeNodeSession(f.node), false)
  assert.equal(f.resumes.length, 1)
  assert.equal(f.retained, 1)
  f.pending.resolve('engine')
  assert.equal(await first, 'engine')
  assert.equal(f.retained, 0)
  assert.equal(f.sandbox.nodeReplacementFlight.busy('node'), false)
})

test('disabled starts and a pending recovery with no named session still refuse without accepting text', async () => {
  const disabled = recoveryFixture({ startAllowed: false })
  await disabled.send('keep disabled')
  assert.deepEqual(disabled.failures, [{ text: 'keep disabled', value: 'start disabled' }])
  assert.equal(disabled.resumes.length, 0)
  const absent = recoveryFixture()
  absent.setNode({ id: 'node', sessionId: null })
  absent.sandbox.recoveringNodes.add('node')
  await absent.send('no target')
  assert.deepEqual(absent.failures, [{ text: 'no target', value: 'session gone' }])
  assert.equal(absent.accepted, 0)
})
