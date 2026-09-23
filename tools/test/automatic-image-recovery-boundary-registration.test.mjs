import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutomaticImageRecoveryHost } from '../../src/automatic-image-recovery-host.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ holdFirstActivity = false, holdFirstDispatch = false, heldDisposition = 'not-sent', busyInitially = true, queued = 1, holdActivityRead = 0, initialTurnId = 'turn-0' } = {}) {
  const owner = { version: 1, ownerId: 'synthetic-owner', currentEpoch: 'synthetic-epoch', kind: 'local' }
  const listeners = { owner: new Set(), event: new Set(), status: new Set() }
  const firstActivity = deferred()
  const activityStarted = deferred()
  const firstDispatch = deferred()
  const dispatchStarted = deferred()
  const dispatched = []
  let activityReads = 0
  let dispatchAttempts = 0
  let busy = busyInitially
  let node = { id: 'node', createdAt: 'synthetic-created', sessionId: 'predecessor', lastTurnId: initialTurnId, status: busy ? 'running' : 'finished' }
  let queue = {
    version: 1, generation: 'generation-0', destinationSessionId: 'predecessor', automaticSend: false,
    entries: [
      ...Array.from({ length: queued }, (_, index) => ({ envelopeId: 'pending-' + index, state: 'not-sent', text: 'retained words ' + index, imageReceipts: [{ imageCount: 1 }] })),
      { envelopeId: 'unknown', state: 'unknown', text: 'uncertain delivery', imageReceipts: [{ imageCount: 1 }] },
    ],
  }
  const unknown = structuredClone(queue.entries.at(-1))
  const subscribe = (kind, listener) => {
    listeners[kind].add(listener)
    return () => listeners[kind].delete(listener)
  }
  const bridge = {
    ownerContext: async () => owner,
    onOwnerContextChanged: listener => subscribe('owner', listener),
    onEvent: listener => subscribe('event', listener),
    sessionActivity: async () => {
      activityReads++
      if ((holdFirstActivity && activityReads === 1) || activityReads === holdActivityRead) {
        activityStarted.resolve()
        return firstActivity.promise
      }
      return { ok: true, busy }
    },
    imageQueue: async request => {
      assert.deepEqual(request.ownerContext, owner)
      if (request.operation === 'read') return { ok: true, operation: 'read', result: structuredClone(queue) }
      assert.equal(request.expectedGeneration, queue.generation)
      if (request.operation === 'transfer') {
        assert.equal(request.expectedDestinationSessionId, 'predecessor')
        assert.equal(request.destinationSessionId, 'successor')
        queue = { ...queue, generation: 'generation-transferred', destinationSessionId: 'successor' }
        return { ok: true, operation: 'transfer', result: structuredClone(queue) }
      }
      assert.equal(request.operation, 'dispatch')
      assert.equal(request.sessionId, 'successor')
      dispatchAttempts++
      if (holdFirstDispatch && dispatchAttempts === 1) {
        // Another turn started between readiness and dispatch. Its busy
        // refusal is in flight when the turn subsequently finishes.
        busy = true
        node = { ...node, status: 'running' }
        if (heldDisposition === 'accepted' || heldDisposition === 'unknown') {
          const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
          assert.equal(entry?.state, 'not-sent')
          entry.state = heldDisposition
          queue.generation = 'generation-held-dispatch'
          if (heldDisposition === 'accepted') dispatched.push(request.envelopeId)
        }
        dispatchStarted.resolve()
        await firstDispatch.promise
        if (heldDisposition === 'accepted') return { ok: true, operation: 'dispatch',
          deliveryDisposition: 'accepted', dispatchStarted: true, attemptId: 'held-attempt', result: structuredClone(queue) }
        if (heldDisposition === 'unknown') return { ok: false, operation: 'dispatch',
          deliveryDisposition: 'unknown', dispatchStarted: true, result: structuredClone(queue) }
        return { ok: false, operation: 'dispatch', deliveryDisposition: 'not-sent',
          dispatchStarted: false, retryable: heldDisposition !== 'terminal',
          code: heldDisposition === 'terminal' ? 'AGENT_SESSION_NOT_READY' : 'AGENT_TURN_ACTIVE', result: structuredClone(queue) }
      }
      assert.equal(busy, false, 'a busy successor must not receive a queued message')
      const entry = queue.entries.find(row => row.envelopeId === request.envelopeId)
      assert.equal(entry?.state, 'not-sent', 'accepted or unknown delivery must never replay')
      entry.state = 'accepted'
      dispatched.push(request.envelopeId)
      queue.generation = 'generation-dispatch-' + dispatched.length
      return {
        ok: true, operation: 'dispatch', deliveryDisposition: 'accepted', dispatchStarted: true,
        attemptId: 'attempt-' + dispatched.length, result: structuredClone(queue),
      }
    },
  }
  const treeStore = { getNode: () => node, subscribe: listener => subscribe('status', listener) }
  const host = createAutomaticImageRecoveryHost({ bridge, treeStore })
  return {
    host, firstActivity, activityStarted, firstDispatch, dispatchStarted, dispatched, listeners,
    dispatchAttempts: () => dispatchAttempts,
    activityReads: () => activityReads,
    async transfer() {
      const input = { nodeId: node.id, sourceSessionId: 'predecessor', expectedNodeCreatedAt: node.createdAt, operationId: '11111111-1111-4111-8111-111111111111' }
      const prepared = await host.prepare(input)
      assert.equal(prepared.ok, true)
      node = { ...node, sessionId: 'successor' }
      const destination = { ...input, destinationSessionId: 'successor', sourceBinding: prepared.sourceBinding, validatedSuccessor: true }
      const recovered = await host.recover(destination)
      assert.equal(recovered.transferred, true)
      return { ...destination, sourceBinding: recovered.sourceBinding }
    },
    startTurn() {
      busy = true
      node = { ...node, status: 'running' }
      for (const listener of [...listeners.status]) listener({ nodes: [node] })
    },
    finishTurn(turnId) {
      busy = false
      node = { ...node, lastTurnId: turnId, status: 'finished' }
      for (const listener of [...listeners.status]) listener({ nodes: [node] })
    },
    emitTurn(turnId) {
      busy = false
      for (const listener of [...listeners.event]) listener({ sessionId: 'successor', event: { type: 'turn_completed', turnId, status: 'completed' } })
    },
    invalidateOwner() { for (const listener of [...listeners.owner]) listener({ version: 1, invalidated: true }) },
    replaceSession() { node = { ...node, sessionId: 'replacement' } },
    assertUnknownRetained() { assert.deepEqual(queue.entries.find(row => row.envelopeId === 'unknown'), unknown) },
  }
}

test('a turn finishing during the initial busy read is recovered after listener registration', async t => {
  const f = fixture({ holdFirstActivity: true })
  t.after(() => f.host.dispose())
  const input = await f.transfer()
  const draining = f.host.drain(input)
  await f.activityStarted.promise
  assert.equal(f.listeners.status.size, 0, 'the initial readiness read precedes subscription')
  f.finishTurn('turn-1')
  f.firstActivity.resolve({ ok: true, busy: true })
  assert.equal((await draining).retryable, true)
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'], 'the only completed turn must not be lost before subscription')
  assert.equal(f.host.pending(), 0)
  f.assertUnknownRetained()
})

test('registration does not dispatch while the successor remains busy or poll indefinitely', async t => {
  const f = fixture()
  t.after(() => f.host.dispose())
  assert.equal((await f.host.drain(await f.transfer())).retryable, true)
  await settle()
  assert.deepEqual(f.dispatched, [])
  const reads = f.activityReads()
  await settle()
  assert.equal(f.activityReads(), reads, 'registration reconciliation must not schedule repeated polling')
  f.finishTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.assertUnknownRetained()
})

test('a completed turn overtaking a busy dispatch refusal is recovered after registration', async t => {
  const f = fixture({ busyInitially: false, holdFirstDispatch: true })
  t.after(() => f.host.dispose())
  const draining = f.host.drain(await f.transfer())
  await f.dispatchStarted.promise
  assert.equal(f.listeners.status.size, 0)
  f.finishTurn('turn-1')
  f.firstDispatch.resolve()
  assert.equal((await draining).retryable, true)
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'], 'a definite busy refusal must not strand the message after the turn has finished')
  assert.equal(f.dispatchAttempts(), 2)
  assert.equal(f.host.pending(), 0)
  f.assertUnknownRetained()
})

test('registration cannot send a second queued message on an unchanged completed turn', async t => {
  const f = fixture({ busyInitially: false, queued: 2 })
  t.after(() => f.host.dispose())
  const result = await f.host.drain(await f.transfer())
  assert.equal(result.dispatched, true)
  assert.equal(result.remaining, 1)
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  assert.equal(f.host.pending(), 1)
  f.finishTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  assert.equal(f.host.pending(), 0)
  f.assertUnknownRetained()
})

test('a new completion arriving during a deferred busy refusal is not lost', async t => {
  const f = fixture({ holdFirstDispatch: true })
  t.after(() => f.host.dispose())
  assert.equal((await f.host.drain(await f.transfer())).retryable, true)
  await settle()
  f.emitTurn('turn-1')
  await f.dispatchStarted.promise
  f.emitTurn('turn-2')
  assert.equal(f.dispatchAttempts(), 1, 'boundary requests must stay serialized')
  f.firstDispatch.resolve()
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'], 'a later completion must retry a definite busy refusal')
  assert.equal(f.dispatchAttempts(), 2)
  f.assertUnknownRetained()
})

test('a new completion overtaking an accepted reply advances the next retained envelope', async t => {
  const f = fixture({ holdFirstDispatch: true, heldDisposition: 'accepted', queued: 2 })
  t.after(() => f.host.dispose())
  assert.equal((await f.host.drain(await f.transfer())).retryable, true)
  await settle()
  f.emitTurn('turn-1')
  await f.dispatchStarted.promise
  f.emitTurn('turn-2')
  assert.equal(f.dispatchAttempts(), 1)
  f.firstDispatch.resolve()
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  assert.equal(f.dispatchAttempts(), 2)
  f.assertUnknownRetained()
})

test('event and node-status reports of one completed turn authorize only one envelope', async t => {
  const f = fixture({ queued: 2 })
  t.after(() => f.host.dispose())
  assert.equal((await f.host.drain(await f.transfer())).retryable, true)
  await settle()
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.finishTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'], 'the status echo is not another completed turn')
  f.emitTurn('turn-2')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.assertUnknownRetained()
})

test('duplicate completion notifications during a request cannot advance another envelope', async t => {
  const f = fixture({ holdFirstDispatch: true, heldDisposition: 'accepted', queued: 2 })
  t.after(() => f.host.dispose())
  assert.equal((await f.host.drain(await f.transfer())).retryable, true)
  await settle()
  f.emitTurn('turn-1')
  await f.dispatchStarted.promise
  f.emitTurn('turn-1')
  f.firstDispatch.resolve()
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  assert.equal(f.dispatchAttempts(), 1)
  f.assertUnknownRetained()
})

for (const terminal of ['unknown', 'disposed', 'terminal', 'owner-invalidated', 'session-replaced']) {
  test(`a queued completion cannot continue after ${terminal} delivery lifetime`, async t => {
    const f = fixture({ holdFirstDispatch: true, heldDisposition: ['unknown', 'terminal'].includes(terminal) ? terminal : 'not-sent', queued: 2 })
    t.after(() => f.host.dispose())
    assert.equal((await f.host.drain(await f.transfer())).retryable, true)
    await settle()
    f.emitTurn('turn-1')
    await f.dispatchStarted.promise
    f.emitTurn('turn-2')
    if (terminal === 'disposed') f.host.dispose()
    if (terminal === 'owner-invalidated') f.invalidateOwner()
    if (terminal === 'session-replaced') f.replaceSession()
    f.firstDispatch.resolve()
    await settle()
    assert.equal(f.dispatchAttempts(), 1)
    assert.deepEqual(f.dispatched, [])
    assert.equal(f.host.pending(), 0)
    f.assertUnknownRetained()
  })
}


test('status-first completion and a delayed older event never authorize another envelope', async t => {
  const f = fixture({ queued: 3 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await settle()
  f.finishTurn('turn-1')
  await settle()
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.emitTurn('turn-2')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.assertUnknownRetained()
})

test('a delayed registration status read cannot replay an older completed turn', async t => {
  const f = fixture({ busyInitially: false, queued: 3, holdActivityRead: 2 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await f.activityStarted.promise
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.firstActivity.resolve({ ok: true, busy: false })
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'], 'a stale readiness reply is not a fresh completion')
  f.assertUnknownRetained()
})


test('an older duplicate event cannot invalidate a newer idle status read', async t => {
  const f = fixture({ queued: 2 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await settle()
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.finishTurn('turn-2')
  f.emitTurn('turn-1')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.assertUnknownRetained()
})


test('several distinct completions during one dispatch coalesce to the latest boundary', async t => {
  const f = fixture({ holdFirstDispatch: true, heldDisposition: 'accepted', queued: 4 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await settle()
  f.emitTurn('turn-1')
  await f.dispatchStarted.promise
  f.emitTurn('turn-2')
  f.emitTurn('turn-3')
  f.emitTurn('turn-3')
  assert.equal(f.dispatchAttempts(), 1, 'native dispatch stays serialized')
  f.firstDispatch.resolve()
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'], 'only the latest pending boundary advances the queue')
  f.finishTurn('turn-3')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.emitTurn('turn-2')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'], 'a superseded completion is not fresh when its echo arrives late')
  f.emitTurn('turn-4')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1', 'pending-2'])
  f.assertUnknownRetained()
})


test('the initial drain boundary cannot replay after its registration read was superseded', async t => {
  const f = fixture({ busyInitially: false, queued: 3, holdActivityRead: 2 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await f.activityStarted.promise
  f.emitTurn('turn-1')
  await settle()
  f.firstActivity.resolve({ ok: true, busy: false })
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.emitTurn('turn-0')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'], 'the initial accepted boundary remains consumed')
  f.assertUnknownRetained()
})


for (const [label, turnId] of [['missing', null], ['empty', ''], ['overlong', 'x'.repeat(513)]]) {
  test(`a ${label} turn identity cannot make event and status echoes authorize two envelopes`, async t => {
    const f = fixture({ queued: 2, initialTurnId: null })
    t.after(() => f.host.dispose())
    await f.host.drain(await f.transfer())
    await settle()
    f.emitTurn(turnId)
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0'])
    f.finishTurn(null)
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0'], 'missing identity is not proof of another completed turn')
    f.emitTurn('next-identified-turn')
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
    f.assertUnknownRetained()
  })
}


for (const statusFirst of [false, true]) {
  test(`an anonymous completion and an identified status echo share one boundary: statusFirst=${statusFirst}`, async t => {
    const f = fixture({ queued: 2, initialTurnId: null })
    t.after(() => f.host.dispose())
    await f.host.drain(await f.transfer())
    await settle()
    if (statusFirst) f.finishTurn('turn-1')
    else f.emitTurn(null)
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0'])
    if (statusFirst) f.emitTurn(null)
    else f.finishTurn('turn-1')
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0'], 'adding the same completion identity must not dispatch again')
    f.emitTurn('turn-2')
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
    f.assertUnknownRetained()
  })
}


test('a real busy transition after an anonymous completion preserves the next status-only boundary', async t => {
  const f = fixture({ queued: 2, initialTurnId: null })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await settle()
  f.emitTurn(null)
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  // Publish the completed status before the next running status: the host
  // status subscription correctly ignores an unchanged 'running' snapshot.
  f.finishTurn(null)
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.startTurn()
  await settle()
  f.finishTurn('next-identified-turn')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.assertUnknownRetained()
})


test('a delayed status read cannot enqueue an older unconsumed completion after a newer event', async t => {
  const f = fixture({ queued: 3, holdActivityRead: 3 })
  t.after(() => f.host.dispose())
  await f.host.drain(await f.transfer())
  await settle()
  f.finishTurn('turn-1')
  await f.activityStarted.promise
  f.emitTurn('turn-2')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'])
  f.firstActivity.resolve({ ok: true, busy: false })
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0'], 'the older pending read was superseded by the fresh event')
  f.emitTurn('turn-3')
  await settle()
  assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
  f.assertUnknownRetained()
})

for (const statusBeforeReply of [false, true]) {
  test(`an identified idle status retries an anonymous not-sent refusal: statusBeforeReply=${statusBeforeReply}`, async t => {
    const f = fixture({ holdFirstDispatch: true, queued: 2, initialTurnId: null })
    t.after(() => f.host.dispose())
    await f.host.drain(await f.transfer())
    await settle()
    f.emitTurn(null)
    await f.dispatchStarted.promise
    if (statusBeforeReply) { f.finishTurn('turn-1'); await settle() }
    f.firstDispatch.resolve()
    await settle()
    if (!statusBeforeReply) { f.finishTurn('turn-1'); await settle() }
    assert.equal(f.dispatchAttempts(), 2, 'fresh identified idle retries the proven not-sent attempt')
    assert.deepEqual(f.dispatched, ['pending-0'])
    f.emitTurn('turn-1')
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0'], 'the retry acceptance cannot authorize another envelope')
    f.emitTurn('turn-2')
    await settle()
    assert.deepEqual(f.dispatched, ['pending-0', 'pending-1'])
    f.assertUnknownRetained()
  })
}
