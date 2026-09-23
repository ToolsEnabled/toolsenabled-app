import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createImageQueueDrain } from '../../src/image-queue-drain.js'
import { imageMessageStatusCopy, imageMessageActionFailureCopy, imageDeliveryNotice } from '../../src/chat-copy.js'

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
test.after(async () => { await new Promise(resolve => setImmediate(resolve)); dom.restore() })
const entry = fields => ({
  envelopeId: 'retained-image', state: 'not-sent', text: 'Can we do this for tasks too?',
  imageReceipts: [{ imageCount: 1 }], ...fields,
})
function mount(row, fields = {}, cancelResult = { ok: true }) {
  const calls = []
  const view = { state: 'ready', entries: [row], ...fields }
  const chat = buildChat({ seed: 0, onSend: () => assert.fail('Status presentation must not send'), imageOutbox: {
    subscribe(fn) { fn(view); return () => {} },
    async refresh() { calls.push('read') },
    async retry() { calls.push('retry'); return { state: 'not-sent' } },
    async cancel() { calls.push('cancel'); return cancelResult },
  } })
  dom.document.body.appendChild(chat)
  return { chat, calls,
    label: () => chat.querySelector('.chat-image-queue-state').textContent,
    detail: () => chat.querySelector('.chat-image-queue-row').textContent,
    dispose() { chat.dispose(); chat.remove() },
  }
}

test('the mounted image row explains actual busy retry exhaustion instead of promising an ongoing send', async () => {
  const ownerContext = { ownerId: 'owner', currentEpoch: 'epoch' }
  const row = entry()
  const snapshot = { version: 1, generation: 'generation', automaticSend: false,
    destinationSessionId: 'session', entries: [row] }
  const timers = []
  let sends = 0, readiness = 'same-busy-turn'
  const drain = createImageQueueDrain({ ownerContext,
    owner: { isCurrent: context => context === ownerContext },
    sessionId: 'session', conversationId: 'conversation', mayDrain: () => true,
    readinessRevision: () => readiness,
    scheduleRetry(callback) { timers.push(callback); return timers.length }, clearScheduledRetry() {},
    bridge: { async imageQueue(request) {
      if (request.operation === 'read') return { ok: true, operation: 'read', result: snapshot }
      sends++
      return { ...request, ownerContext, ok: false, code: 'AGENT_TURN_ACTIVE',
        deliveryDisposition: 'not-sent', dispatchStarted: false, retryable: true,
        retryAfterMs: 1000, result: snapshot }
    } },
  })
  try {
    const scheduled = await drain.drain()
    const waiting = mount({ ...row, ...scheduled })
    try {
      assert.equal(waiting.label(), 'Not sent · retry scheduled')
      assert.match(waiting.detail(), /agent was busy/i)
      assert.match(waiting.detail(), /has not received/)
      assert.deepEqual(waiting.calls, [])
    } finally { waiting.dispose() }
    for (let i = 0; i < 5; i++) await timers[i]()
    const exhausted = await drain.drain()
    assert.equal(exhausted.retryExhausted, true)
    assert.equal(exhausted.retryScheduled, false)
    assert.equal(sends, 6)
    assert.match(imageDeliveryNotice(exhausted), /Automatic retries are paused/)
    assert.doesNotMatch(imageDeliveryNotice(exhausted), /remain queued|AGENT_TURN_ACTIVE/)
    const paused = mount({ ...row, ...exhausted })
    try {
      assert.equal(paused.label(), 'Not sent · retries paused')
      assert.match(paused.detail(), /Automatic retries are paused/)
      assert.match(paused.detail(), /Send again/)
      assert.doesNotMatch(paused.detail(), /Waiting to send|retry scheduled|AGENT_TURN_ACTIVE/)
      assert.deepEqual(paused.calls, [])
    } finally { paused.dispose() }
    readiness = 'new-turn'
    const resumed = await drain.drain()
    assert.equal(resumed.retryScheduled, true)
    assert.equal(resumed.retryExhausted, false)
    const restarted = mount({ ...row, ...exhausted, ...resumed })
    try { assert.equal(restarted.label(), 'Not sent · retry scheduled') }
    finally { restarted.dispose() }
  } finally { drain.dispose() }
})

test('a full or terminally refused image cannot inherit an old waiting or scheduled label', () => {
  for (const fields of [
    { code: 'IMAGE_OUTBOX_FULL' },
    { failure: { code: 'IMAGE_OUTBOX_FULL', retryable: false } },
    { failure: { code: 'AGENT_IMAGE_UNSUPPORTED', retryable: false } },
  ]) {
    const f = mount(entry({ retryable: true, retryScheduled: true, ...fields }))
    try {
      assert.equal(f.label(), 'Saved · not sent')
      assert.match(f.detail(), /history is full|could not accept the image/)
      assert.match(f.detail(), /Send again to retry, or Remove/)
      assert.doesNotMatch(f.detail(), /Waiting to send|retry scheduled|IMAGE_OUTBOX_FULL/)
      assert.deepEqual(f.calls, [])
    } finally { f.dispose() }
  }
})

test('held, reconciling and unconfirmed rows never promise an automatic retry', () => {
  for (const [fields, view, label] of [
    [{}, { state: 'held', code: 'IMAGE_OUTBOX_DESTINATION_STALE' }, 'Saved · not sent'],
    [{ reconcile: true }, {}, 'Saved · not sent'],
    [{ state: 'unknown' }, {}, 'Delivery unconfirmed'],
  ]) {
    const f = mount(entry({ retryable: true, retryScheduled: true, ...fields }), view)
    try {
      assert.equal(f.label(), label)
      assert.match(f.detail(), /Refresh/)
      assert.doesNotMatch(f.detail(), /Waiting to send|retry scheduled|Another send attempt is scheduled/)
      if (fields.state === 'unknown') {
        assert.match(f.detail(), /cannot confirm whether the agent received/)
        assert.equal(f.chat.querySelector('.chat-image-queue-retry'), null)
      }
      assert.deepEqual(f.calls, [])
    } finally { f.dispose() }
  }
})

test('failed removal explains full history without claiming the message was delivered or removed', async () => {
  const f = mount(entry(), {}, { ok: false, code: 'IMAGE_OUTBOX_FULL' })
  try {
    f.chat.querySelector('.chat-image-queue-cancel').click()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(f.calls, ['cancel'])
    assert.match(f.chat.textContent, /saved message history is full/)
    assert.match(f.chat.textContent, /Removal was not confirmed/)
    assert.doesNotMatch(f.chat.textContent, /IMAGE_OUTBOX_FULL/)
  } finally { f.dispose() }
})

test('unknown failures keep an honest generic explanation and no invented delivery result', () => {
  const copy = imageMessageStatusCopy(entry({ failure: { code: 'UNRECOGNIZED_REFUSAL', retryable: false } }), { state: 'ready' })
  assert.equal(copy.label, 'Saved · not sent')
  assert.match(copy.detail, /Send again to retry/)
  const action = imageMessageActionFailureCopy({ code: 'UNRECOGNIZED_REFUSAL' }, 'retry')
  assert.match(action, /delivery was not confirmed/)
  assert.doesNotMatch(action, /UNRECOGNIZED_REFUSAL|was not sent|received it/)
})

test('the transcript listener copy reports removal and terminal refusal without implying a queued send', () => {
  assert.equal(imageDeliveryNotice({ state: 'cancelled' }), 'Image message removed from the queue.')
  const refused = imageDeliveryNotice(entry({ failure: { code: 'IMAGE_OUTBOX_FULL', retryable: false } }))
  assert.match(refused, /Saved · not sent/)
  assert.match(refused, /saved message history is full/)
  assert.match(refused, /Send again to retry/)
  assert.doesNotMatch(refused, /remain queued|IMAGE_OUTBOX_FULL/)
  const unknown = imageDeliveryNotice({ state: 'unknown' })
  assert.match(unknown, /cannot confirm whether the agent received/)
  assert.doesNotMatch(unknown, /not sent|accepted by the agent/)
})
