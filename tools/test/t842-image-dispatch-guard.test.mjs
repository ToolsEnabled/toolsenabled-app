import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageQueueDrain } from '../../src/image-queue-drain.js'
import { createImageConversation } from '../../src/image-conversation.js'

const ownerContext = { version: 1, ownerId: 'owner', currentEpoch: 'epoch', kind: 'local' }
const entry = (fields = {}) => ({
  envelopeId: 'envelope',
  text: 'retained words',
  imageReceipts: [{ version: 1, id: 'image', slot: 0, manifestHash: 'a'.repeat(64), imageCount: 1 }],
  state: 'not-sent',
  ...fields,
})
const clone = value => structuredClone(value)
const identity = request => ({
  operation: 'dispatch',
  operationId: request.operationId,
  conversationId: request.conversationId,
  sessionId: request.sessionId,
  envelopeId: request.envelopeId,
  ownerContext,
})

function drainFixture({ entries = [entry()], dispatch, scheduleRetry = null, readinessRevision = () => null } = {}) {
  let snapshot = { version: 1, generation: 'generation-one', destinationSessionId: 'session', entries, automaticSend: false }
  const calls = []
  let current = ownerContext
  const owner = { isCurrent: value => value === current, invalidate: () => { current = null } }
  const timers = []
  const bridge = { imageQueue: async request => {
    calls.push(clone(request))
    if (request.operation === 'read') return { ok: true, operation: 'read', result: clone(snapshot) }
    const response = await dispatch(request, snapshot, next => { snapshot = clone(next) })
    return response
  } }
  const drain = createImageQueueDrain({
    bridge, owner, ownerContext, conversationId: 'conversation', sessionId: 'session',
    mayDrain: () => true, scheduleRetry: scheduleRetry || ((fn, delay) => {
      const timer = { fn, delay, cancelled: false }
      timers.push(timer)
      return timer
    }), clearScheduledRetry: timer => { if (timer) timer.cancelled = true },
    readinessRevision,
  })
  return { drain, calls, timers, snapshot: () => snapshot }
}

test('busy preflight is one validated no-dispatch refusal with bounded backoff and one later retry', async () => {
  let attempts = 0
  const fixture = drainFixture({
    dispatch: async request => {
      attempts += 1
      if (attempts === 1) {
        return {
          ok: true, ...identity(request), deliveryDisposition: 'not-sent', dispatchStarted: false,
          code: 'AGENT_TURN_ACTIVE', retryable: true, retryAfterMs: 1000,
          result: { version: 1, generation: 'generation-one', destinationSessionId: 'session',
            entries: [entry()], automaticSend: false },
        }
      }
      return {
        ok: true, ...identity(request), deliveryDisposition: 'accepted', dispatchStarted: true,
        attemptId: 'attempt-one', result: { version: 1, generation: 'generation-two',
          destinationSessionId: 'session', entries: [entry({ state: 'accepted' })], automaticSend: false },
      }
    },
  })
  const first = await fixture.drain.drain()
  assert.equal(first.state, 'not-sent')
  assert.equal(first.dispatchStarted, false)
  assert.equal(first.retryable, true)
  assert.equal(first.attemptId, undefined)
  assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 1)
  assert.equal((await fixture.drain.drain()).state, 'not-sent')
  assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 1)
  assert.equal(fixture.timers.length, 1)
  assert.ok(fixture.timers[0].delay >= 1000 && fixture.timers[0].delay <= 8000)
  await fixture.timers[0].fn()
  assert.equal(fixture.calls.filter(request => request.operation === 'dispatch').length, 2)
  assert.equal((await fixture.drain.drain()).state, 'accepted')
})

test('busy retry exhaustion re-arms only after the authenticated readiness revision changes', async () => {
  let revision = 'node-session:turn-1:active'
  let dispatches = 0
  const fixture = drainFixture({
    readinessRevision: () => revision,
    dispatch: async request => {
      dispatches += 1
      return { ok: true, ...identity(request), deliveryDisposition: 'not-sent', dispatchStarted: false,
        code: 'AGENT_TURN_ACTIVE', retryable: true, retryAfterMs: 1,
        result: { version: 1, generation: 'generation-one', destinationSessionId: 'session',
          entries: [entry()], automaticSend: false } }
    },
  })
  await fixture.drain.drain()
  for (let count = 0; count < 5; count += 1) await fixture.timers.at(-1).fn()
  assert.equal(fixture.drain.outcome('envelope').retryExhausted, true)
  const exhaustedDispatches = dispatches
  assert.equal((await fixture.drain.drain()).retryExhausted, true)
  assert.equal(dispatches, exhaustedDispatches)
  revision = 'node-session:turn-1:idle'
  const nextBoundary = await fixture.drain.drain()
  assert.equal(nextBoundary.state, 'not-sent')
  assert.equal(dispatches, exhaustedDispatches + 1)
})

test('idle readiness retries a durably recorded busy refusal without scheduling another delay', async () => {
  let revision = 'node-session:turn-1:active'
  let dispatches = 0
  const fixture = drainFixture({
    readinessRevision: () => revision,
    dispatch: async (request, snapshot, save) => {
      dispatches += 1
      const busy = dispatches === 1
      const result = { ...snapshot, generation: `generation-${dispatches + 1}`,
        entries: [entry(busy
          ? { failure: { code: 'AGENT_TURN_ACTIVE', retryable: true } }
          : { state: 'accepted' })] }
      save(result)
      return { ok: !busy, ...identity(request), attemptId: `attempt-${dispatches}`,
        deliveryDisposition: busy ? 'not-sent' : 'accepted',
        ...(busy ? { code: 'AGENT_TURN_ACTIVE', retryable: true } : {}), result }
    },
  })
  try {
    assert.equal((await fixture.drain.drain()).state, 'not-sent')
    assert.equal(fixture.timers.length, 1)
    assert.equal((await fixture.drain.drain()).state, 'not-sent')
    assert.equal(dispatches, 1, 'unchanged readiness cannot retry before the timer')
    revision = 'node-session:turn-1:idle'
    assert.equal((await fixture.drain.drain()).state, 'accepted')
    assert.equal(dispatches, 2)
    assert.equal(fixture.timers[0].cancelled, true)
    assert.equal(fixture.timers.length, 1, 'the idle signal replaces the pending delay')
    await fixture.drain.drain()
    assert.equal(dispatches, 2, 'accepted delivery cannot replay')
  } finally { fixture.drain.dispose() }
})

test('terminal durable failure stays visible and is retried only by explicit retry', async () => {
  let dispatches = 0
  const fixture = drainFixture({
    entries: [entry({ failure: { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED', retryable: false } })],
    dispatch: async request => {
      dispatches += 1
      return { ok: true, ...identity(request), deliveryDisposition: 'accepted', dispatchStarted: true,
        attemptId: 'attempt-terminal-retry',
        result: { version: 1, generation: 'generation-two', destinationSessionId: 'session',
          entries: [entry({ state: 'accepted' })], automaticSend: false } }
    },
  })
  const first = await fixture.drain.drain()
  assert.equal(first.state, 'not-sent')
  assert.equal(first.retryable, false)
  assert.equal(first.code, 'IMAGE_CUSTODY_CANDIDATE_REFUSED')
  assert.equal(dispatches, 0)
  const second = await fixture.drain.drain()
  assert.equal(second.state, 'not-sent')
  assert.equal(dispatches, 0)
  const retried = await fixture.drain.retry('envelope')
  assert.equal(retried.state, 'accepted')
  assert.equal(dispatches, 1)
})

test('conversation publishes retained words, thumbnail receipt and terminal disposition after relaunch', async () => {
  let snapshot = { version: 1, generation: 'generation-one', destinationSessionId: 'session',
    entries: [entry({ failure: { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED', retryable: false } })], automaticSend: false }
  const calls = []
  const owner = {
    capture: () => ownerContext, isCurrent: value => value === ownerContext,
    start: async () => ownerContext, invalidate: () => {}, snapshot: () => ({ status: 'ready', ownerContext }),
    subscribe: () => () => {}, dispose: () => {},
  }
  const bridge = { imageQueue: async request => {
    calls.push(clone(request))
    if (request.operation === 'binding') return { ok: true, result: { sessionId: 'session', conversationId: 'conversation', ownerContext } }
    if (request.operation === 'read') return { ok: true, operation: 'read', result: clone(snapshot) }
    if (request.operation === 'preview') {
      return { ok: true, operation: 'preview', result: {
        version: 1, envelopeId: request.envelopeId,
        thumbnail: 'data:image/png;base64,' + 'A'.repeat(300000),
        imageCount: 1, automaticSend: false,
      } }
    }
    if (request.operation === 'dispatch') {
      snapshot = { ...snapshot, generation: 'generation-two', entries: [entry({ state: 'accepted' })] }
      return { ok: true, ...identity(request), deliveryDisposition: 'accepted', dispatchStarted: true,
        attemptId: 'attempt-relaunch', result: clone(snapshot) }
    }
    assert.fail('unexpected image operation ' + request.operation)
  } }
  const controller = createImageConversation({ bridge, ownerClient: owner, sessionId: 'session',
    isCurrent: () => true, mayDrain: () => true, subscribeReady: () => () => {} })
  const views = []
  const unsubscribe = controller.subscribe(view => views.push(view))
  try {
    const view = await controller.refresh()
    const row = view.entries[0]
    assert.equal(row.text, 'retained words')
    assert.equal(row.imageReceipts[0].imageCount, 1)
    assert.match(row.thumbnail, /^data:image\/png;base64,/) 
    assert.ok(row.thumbnail.length > 262144, 'native-size preview above the former 256 KiB bound is valid')
    assert.equal(row.previewState, 'available')
    assert.equal(row.imageCount, 1)
    assert.deepEqual(row.failure, { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED', retryable: false })
    assert.equal((await controller.signalReady()).state, 'not-sent')
    assert.equal(calls.filter(request => request.operation === 'dispatch').length, 0)
    const result = await controller.retry('envelope', view)
    assert.equal(result.state, 'accepted')
    assert.equal(calls.filter(request => request.operation === 'dispatch').length, 1)
    assert.ok(views.some(value => value.entries[0]?.text === 'retained words'
      && value.entries[0]?.imageReceipts?.[0]?.imageCount === 1))
  } finally {
    unsubscribe()
    controller.dispose()
  }
})

test('conversation observer retains a legacy row among 256 saved entries without automatic migration', async () => {
  const legacy = entry({ envelopeId: 'legacy-envelope', text: 'legacy retained words' })
  const acceptedRows = Array.from({ length: 255 }, (_, index) => entry({
    envelopeId: `accepted-${index}`, state: 'accepted', text: `accepted-${index}`,
  }))
  let snapshot = {
    version: 1,
    generation: 'generation-full-cap',
    destinationSessionId: 'node-session-predecessor',
    entries: [...acceptedRows, legacy],
    automaticSend: false,
  }
  const calls = []
  const owner = {
    capture: () => ownerContext, isCurrent: value => value === ownerContext,
    start: async () => ownerContext, invalidate: () => {}, snapshot: () => ({ status: 'ready', ownerContext }),
    subscribe: () => () => {}, dispose: () => {},
  }
  const bridge = { imageQueue: async request => {
    calls.push(clone(request))
    if (request.operation === 'binding') {
      return { ok: true, result: { sessionId: 'node-session-current', conversationId: 'conversation', ownerContext } }
    }
    if (request.operation === 'read') return { ok: true, operation: 'read', result: clone(snapshot) }
    if (request.operation === 'preview') {
      return { ok: true, operation: 'preview', result: {
        version: 1, envelopeId: request.envelopeId, thumbnail: 'data:image/jpeg;base64,AA==',
        imageCount: 1, automaticSend: false,
      } }
    }
    assert.fail('mounted legacy row unexpectedly requested ' + request.operation)
  } }
  const controller = createImageConversation({
    bridge, ownerClient: owner, sessionId: 'node-session-current',
    isCurrent: () => true, mayDrain: () => true, subscribeReady: () => () => {},
    readinessRevision: () => 'node-session-current:turn-7:idle',
  })
  const observed = []
  const unsubscribe = controller.subscribe(() => {})
  const stop = () => controller.dispose()
  try {
    const view = await controller.refresh()
    assert.equal(view.entries.length, 256)
    const row = view.entries.find(value => value.envelopeId === 'legacy-envelope')
    assert.ok(row)
    assert.equal(row.state, 'not-sent')
    assert.equal(row.failure, undefined)
    assert.equal(row.code, undefined)
    assert.equal(row.thumbnail, 'data:image/jpeg;base64,AA==')
    assert.equal(row.imageCount, 1)
    const removeObservation = controller.observeEnvelope({
      envelopeId: 'legacy-envelope', conversationId: 'conversation', ownerContext,
    }, state => observed.push(state))
    assert.equal(typeof removeObservation, 'function')
    assert.equal(observed.at(-1)?.state, 'not-sent')
    assert.equal(observed.at(-1)?.text, 'legacy retained words')
    const ready = await controller.signalReady()
    assert.equal(ready.code, 'IMAGE_OUTBOX_DESTINATION_STALE')
    assert.equal(calls.filter(request => request.operation === 'dispatch').length, 0)
    assert.equal(calls.filter(request => request.operation === 'transfer').length, 0)
    removeObservation()
  } finally {
    unsubscribe()
    stop()
  }
})

test('terminal preview failure is named, memoized, and cleared only by explicit retry', async () => {
  const snapshot = {
    version: 1, generation: 'generation-preview', destinationSessionId: 'session',
    entries: [entry({ failure: { code: 'IMAGE_CUSTODY_CANDIDATE_REFUSED', retryable: false } })],
    automaticSend: false,
  }
  let previewCalls = 0
  const owner = {
    capture: () => ownerContext, isCurrent: value => value === ownerContext,
    start: async () => ownerContext, invalidate: () => {}, snapshot: () => ({ status: 'ready', ownerContext }),
    subscribe: () => () => {}, dispose: () => {},
  }
  const bridge = { imageQueue: async request => {
    if (request.operation === 'binding') {
      return { ok: true, result: { sessionId: 'session', conversationId: 'conversation', ownerContext } }
    }
    if (request.operation === 'read') return { ok: true, operation: 'read', result: clone(snapshot) }
    if (request.operation === 'preview') {
      previewCalls += 1
      return { ok: true, operation: 'preview', result: {
        version: 1, envelopeId: previewCalls === 1 ? 'wrong-envelope' : 'envelope',
        thumbnail: 'data:image/webp;base64,AA==', imageCount: 1, automaticSend: false,
      } }
    }
    if (request.operation === 'dispatch') {
      return { ok: true, ...identity(request), deliveryDisposition: 'not-sent', dispatchStarted: false,
        code: 'AGENT_TURN_ACTIVE', retryable: true, retryAfterMs: 1000,
        result: clone(snapshot), automaticSend: false }
    }
    assert.fail('preview proof unexpectedly requested ' + request.operation)
  } }
  const controller = createImageConversation({
    bridge, ownerClient: owner, sessionId: 'session',
    isCurrent: () => true, mayDrain: () => true, subscribeReady: () => () => {},
    readinessRevision: () => 'session:turn-preview:idle',
  })
  try {
    const first = await controller.refresh()
    assert.equal(first.entries[0].thumbnail, undefined)
    assert.equal(first.entries[0].previewState, 'unavailable')
    assert.equal(first.entries[0].previewCode, 'IMAGE_PREVIEW_UNAVAILABLE')
    assert.equal(previewCalls, 1)
    const second = await controller.refresh()
    assert.equal(second.entries[0].thumbnail, undefined)
    assert.equal(second.entries[0].previewState, 'unavailable')
    assert.equal(previewCalls, 1, 'readiness refresh must not repeat a terminal preview refusal')
    const retried = await controller.retry('envelope', second)
    assert.equal(retried.state, 'not-sent')
    assert.equal(previewCalls, 2, 'explicit retry clears only this receipt preview cache')
    const recovered = await controller.refresh()
    assert.equal(recovered.entries[0].thumbnail, 'data:image/webp;base64,AA==')
    assert.equal(recovered.entries[0].previewState, 'available')
  } finally {
    controller.dispose()
  }
})
