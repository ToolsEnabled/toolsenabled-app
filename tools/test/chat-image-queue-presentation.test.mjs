import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
test.after(() => dom.restore())
const row = (envelopeId, state = 'not-sent') => ({
  envelopeId, state, retryable: true, text: 'A saved request with <literal> text and **literal** marks.',
  imageReceipts: [{ id: 'image-' + envelopeId, imageCount: 2, slot: 0, manifestHash: 'fixture-digest' }],
})
function mount(entries, fields = {}) {
  const calls = []
  let publish
  const view = { state: 'ready', entries, generation: 'generation-one', ...fields }
  const imageOutbox = {
    subscribe(fn) { publish = fn; fn(view); return () => {} },
    async refresh() { calls.push({ operation: 'read' }) },
    async retry(envelopeId, snapshot) { calls.push({ operation: 'retry', envelopeId, snapshot }); return { state: 'accepted' } },
    async cancel(envelopeId, snapshot) { calls.push({ operation: 'cancel', envelopeId, snapshot }); return { ok: true } },
  }
  const chat = buildChat({ seed: 0, imageOutbox, onSend: () => assert.fail('Rendering must never send') })
  dom.document.body.appendChild(chat)
  chat.importDraft({ text: 'A separate draft', attachments: [] })
  return { chat, calls, view, publish, dispose() { chat.dispose(); chat.remove() } }
}

test('saved images keep exact identities and literal text with a confirmed unsent status', () => {
  const entries = [row('first'), row('second')]
  const original = structuredClone(entries)
  const f = mount(entries)
  try {
    const rows = f.chat.querySelectorAll('.chat-image-queue-row')
    assert.deepEqual(rows.map(item => item.dataset.envelopeId), ['first', 'second'])
    for (const item of rows) {
      assert.ok(item.textContent.includes(entries[0].text))
      assert.match(item.textContent, /2 images/)
      assert.match(item.textContent, /Saved · not sent/)
      assert.equal(item.querySelector('literal'), null)
      assert.equal(item.querySelector('strong'), null)
    }
    assert.deepEqual(entries, original)
    assert.deepEqual(f.calls, [])
  } finally { f.dispose() }
})

test('retained terminal image row shows a thumbnail receipt and explicit retry/remove doors', async () => {
  const entry = {
    ...row('retained'),
    thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    failure: { code: 'IMAGE_OUTBOX_DESTINATION_STALE', retryable: false },
  }
  const f = mount([entry])
  try {
    const item = f.chat.querySelector('.chat-image-queue-row')
    assert.match(item.textContent, /Saved · not sent/)
    assert.match(item.textContent, /Send again to retry, or Remove/)
    const thumbnail = item.querySelector('.chat-image-queue-thumbnail')
    assert.ok(thumbnail)
    assert.equal(thumbnail.src, entry.thumbnail)
    const retry = item.querySelector('.chat-image-queue-retry')
    assert.ok(retry)
    assert.equal(retry.textContent, 'Send again')
    retry.click()
    await Promise.resolve()
    assert.equal(f.calls[0].operation, 'retry')
    assert.equal(f.calls[0].envelopeId, 'retained')
    assert.equal(f.calls[0].snapshot, f.view)
    const remove = item.querySelector('.chat-image-queue-cancel')
    assert.ok(remove)
    assert.equal(remove.textContent, 'Remove')
    remove.click()
    await Promise.resolve()
    assert.equal(f.calls[1].operation, 'cancel')
    assert.equal(f.calls[1].envelopeId, 'retained')
  } finally { f.dispose() }
})

for (const state of ['unknown', 'dispatching', 'unrecognized']) test('uncertain ' + state + ' is visibly held without a send or cancel door', async () => {
  const f = mount([row('held', state)])
  try {
    const item = f.chat.querySelector('.chat-image-queue-row')
    assert.ok(item)
    assert.doesNotMatch(item.textContent, /Queued|Waiting to send/)
    assert.match(item.textContent, /unconfirmed|Checking|unavailable/i)
    assert.equal(item.querySelector('button'), null)
    f.chat.querySelector('.chat-image-queue-refresh').click()
    await Promise.resolve()
    assert.deepEqual(f.calls, [{ operation: 'read' }])
    assert.equal(f.chat.exportDraft().text, 'A separate draft')
  } finally { f.dispose() }
})

test('a held not-sent row explains the pause and retains its original receipt', () => {
  const entry = { ...row('paused'), retryable: false }
  const f = mount([entry], { state: 'held', code: 'IMAGE_OUTBOX_DESTINATION_STALE' })
  try {
    const item = f.chat.querySelector('.chat-image-queue-row')
    assert.match(item.textContent, /not sent/i)
    assert.match(f.chat.textContent, /paused|refresh/i)
    assert.equal(item.querySelector('button'), null)
    assert.deepEqual(f.view.entries[0], entry)
  } finally { f.dispose() }
})

test('cancel targets the displayed envelope and generation without changing another draft', async () => {
  const f = mount([row('selected'), row('other')])
  try {
    f.chat.querySelector('.chat-image-queue-cancel').click()
    await Promise.resolve()
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].envelopeId, 'selected')
    assert.equal(f.calls[0].snapshot, f.view)
    assert.equal(f.calls[0].snapshot.generation, 'generation-one')
    assert.equal(f.chat.exportDraft().text, 'A separate draft')
    assert.equal(f.view.entries[1].envelopeId, 'other')
  } finally { f.dispose() }
})

test('accepted and cancelled images never reappear as pending during refresh or remount', () => {
  const f = mount([row('sent', 'accepted'), row('cancelled', 'cancelled')])
  try {
    assert.equal(f.chat.querySelector('.chat-image-queue-strip').hidden, true)
    assert.equal(f.chat.querySelectorAll('.chat-image-queue-row').length, 0)
    f.publish({ ...f.view, entries: [row('new')] })
    assert.equal(f.chat.querySelector('.chat-image-queue-strip').hidden, false)
    f.publish(f.view)
    assert.equal(f.chat.querySelector('.chat-image-queue-strip').hidden, true)
    assert.deepEqual(f.calls, [])
  } finally { f.dispose() }
})

test('a chat with no session yet shows no image-message card, while a real held queue still does', () => {
  /* The exact view src/agent-session.js and src/views/agent.js publish before a
     session exists. Observed in a real window 2026-09-21: every new agent chat
     opened under "Image messages · Sending is paused" with nothing ever sent. */
  const none = mount([], { state: 'held', code: 'AGENT_SESSION_NOT_READY' })
  try {
    assert.equal(none.chat.querySelector('.chat-image-queue-strip').hidden, true)
    /* A row arriving under the same code is still shown and still explained. */
    none.publish({ ...none.view, entries: [row('kept')] })
    assert.equal(none.chat.querySelector('.chat-image-queue-strip').hidden, false)
    assert.match(none.chat.textContent, /paused|refresh/i)
  } finally { none.dispose() }
  /* Any other held code keeps its notice even with no rows: that pause is real. */
  const stale = mount([], { state: 'held', code: 'IMAGE_OUTBOX_DESTINATION_STALE' })
  try {
    assert.equal(stale.chat.querySelector('.chat-image-queue-strip').hidden, false)
    assert.match(stale.chat.textContent, /Sending is paused/)
  } finally { stale.dispose() }
})

test('an ended agent with nothing queued shows no image-message card, and a kept row still shows (T1371)', () => {
  /* The view a finished or stopped agent's chat publishes after the app restarts:
     the host no longer holds the session, so the outbox answers held with one of
     the two terminal session refusals. Measured on the rig 2026-09-22: both rails
     read "Image messages · Sending is paused" with no rows and a Refresh that
     changed nothing. */
  for (const code of ['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']) {
    const ended = mount([], { state: 'held', code })
    try {
      assert.equal(ended.chat.querySelector('.chat-image-queue-strip').hidden, true, code + ' with no rows drew the paused panel')
      ended.publish({ ...ended.view, entries: [row('kept')] })
      const strip = ended.chat.querySelector('.chat-image-queue-strip')
      assert.equal(strip.hidden, false, code + ' hid a saved image message')
      assert.match(strip.textContent, /Image messages · 1/)
      assert.match(strip.textContent, /Sending is paused/)
    } finally { ended.dispose() }
  }
})
