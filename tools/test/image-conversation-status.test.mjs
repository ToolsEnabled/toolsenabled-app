import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageConversation } from '../../src/image-conversation.js'

function fixture(disposition = 'not-sent', delayed = false) {
  const ownerContext = Object.freeze({ version: 1, ownerId: 'owner', currentEpoch: 'epoch', kind: 'local' })
  let entry = { envelopeId: 'image', text: 'retained image', imageReceipts: [], state: 'not-sent' }
  let generation = 1, finishDispatch, enteredDispatch
  const entered = new Promise(resolve => { enteredDispatch = resolve })
  const gate = new Promise(resolve => { finishDispatch = resolve })
  const calls = [], events = []
  const snapshot = () => ({ version: 1, generation: `g${generation}`, destinationSessionId: 'session', entries: [structuredClone(entry)], automaticSend: false })
  const bridge = {
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: () => () => {},
    imageQueue: async request => {
      calls.push(request.operation)
      if (request.operation === 'binding') return { ok: true, result: { sessionId: 'session', conversationId: 'conversation', ownerContext } }
      if (request.operation === 'read') return { ok: true, operation: 'read', result: snapshot() }
      assert.equal(request.operation, 'dispatch')
      enteredDispatch()
      if (delayed) await gate
      return { ...request, ok: disposition === 'accepted', attemptId: 'attempt',
        deliveryDisposition: disposition, code: 'PROVIDER_REFUSED', retryable: false,
        providerReceipt: disposition === 'accepted' ? { turnId: 'delivered-turn' } : null,
        result: { ...snapshot(), entries: [{ ...entry, state: disposition, failure: { code: 'PROVIDER_REFUSED', retryable: false } }] } }
    },
  }
  const controller = createImageConversation({ bridge, sessionId: 'session', isCurrent: () => true,
    mayDrain: () => true, subscribeReady: () => () => {} })
  return { controller, calls, events, entered, finishDispatch,
    observe() { return controller.observeEnvelope({ envelopeId: 'image', conversationId: 'conversation', ownerContext }, state => events.push(state)) },
    save(state) { entry = { ...entry, state }; generation++ },
    dispose() { finishDispatch(); controller.dispose() },
  }
}

for (const local of ['not-sent', 'unknown']) for (const saved of ['accepted', 'cancelled']) {
  test(`refresh preserves durable ${saved} over cached ${local}, without sending again`, async () => {
    const f = fixture(local)
    try {
      await f.controller.refresh()
      f.observe()
      assert.equal((await f.controller.signalReady()).state, local)
      f.save(saved)
      const view = await f.controller.refresh()
      assert.equal(view.entries[0].state, saved)
      assert.equal(f.events.at(-1).state, saved, 'already mounted receipt updates on refresh')
      f.observe()
      assert.equal(f.events.at(-1).state, saved, 'reopened receipt uses authoritative row')
      await f.controller.signalReady()
      assert.equal(f.calls.filter(value => value === 'dispatch').length, 1)
      assert.equal((await f.controller.retry('image', view)).code, 'IMAGE_QUEUE_RETRY_UNAVAILABLE')
    } finally { f.dispose() }
  })
}

test('confirmed acceptance survives an unresolved durable row without a second dispatch', async () => {
  const f = fixture('accepted')
  try {
    await f.controller.refresh()
    await f.controller.signalReady()
    f.save('unknown')
    assert.equal((await f.controller.refresh()).entries[0].state, 'accepted')
    f.observe()
    assert.equal(f.events.at(-1).state, 'accepted')
    await f.controller.signalReady()
    assert.equal(f.calls.filter(value => value === 'dispatch').length, 1)
  } finally { f.dispose() }
})

test('late refusal cannot restore a row after refresh observes its durable removal', async () => {
  const f = fixture('not-sent', true)
  try {
    await f.controller.refresh()
    f.observe()
    const flight = f.controller.signalReady()
    await f.entered
    f.save('cancelled')
    await f.controller.refresh()
    f.finishDispatch()
    await flight
    assert.equal(f.events.at(-1).state, 'cancelled')
    assert.equal((await f.controller.refresh()).entries[0].state, 'cancelled')
  } finally { f.dispose() }
})
