import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
function fixture({ hook = true, busy = false, queueEnabled = true } = {}) {
 let pending = true, stops = 0, sends = 0, additions = 0, promotions = 0
 const rows = [], listeners = new Set()
 const emit = () => { for (const fn of listeners) fn() }
 const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }
 const drain = () => { if (pending || busy) return; while (rows.length) { rows.shift(); sends++ } emit() }
 const queue = {
  list: () => rows.slice(), subscribe,
  add(text) { additions++; rows.push({ id: 'row-' + additions, text }); emit(); return { ok: true } },
  sendNow(id) { promotions++; const i = rows.findIndex(row => row.id === id); if (i >= 0) rows.unshift(...rows.splice(i, 1)); drain(); return { ok: true, sentence: 'Queued first.' } },
  cancel() { throw new Error('Pending intent must not be removed') },
  hold() { throw new Error('No active turn to interrupt') }
 }
 const status = { busy: () => busy, subscribe, ...(hook ? { queueRequired: () => pending } : {}) }
 const chat = buildChat({ seed: 0, chips: {}, status, ...(queueEnabled ? { queue } : {}),
  onStop: () => { stops++; return { ok: true } }, onSend: () => { sends++; return { ok: true } } })
 dom.document.body.appendChild(chat)
 return { chat, rows, counts: () => ({ stops, sends, additions, promotions }),
  ready() { pending = false; emit(); drain() } }
}
test('pending binding queues one original Send and drains once on readiness without Stop', () => {
 const f = fixture()
 try {
  const button = f.chat.querySelector('.chat-send')
  assert.equal(button.classList.contains('is-stop'), false)
  button.click()
  f.chat.querySelector('[data-chat-chip="halt"]').click()
  assert.equal(f.counts().stops, 0)
  f.chat.importDraft({ text: 'exact\n  ', attachments: [] })
  button.click()
  assert.deepEqual(f.rows.map(r => r.text), ['exact\n  '])
  assert.equal(f.chat.exportDraft().text, '')
  assert.equal(f.chat.querySelectorAll('.chat-queue-row').length, 1)
  assert.deepEqual(f.counts(), { stops: 0, sends: 0, additions: 1, promotions: 0 })
  f.ready(); f.ready()
  assert.equal(f.counts().sends, 1)
  assert.equal(f.rows.length, 0)
 } finally { f.chat.dispose() }
})
test('pending Send now and queued promotion never interrupt or bypass readiness', () => {
 const f = fixture()
 try {
  f.chat.importDraft({ text: 'one intent', attachments: [] })
  f.chat.querySelector('[data-chat-chip="sendnow"]').click()
  assert.equal(f.rows.length, 1)
  f.chat.querySelector('.chat-queue-now').click()
  assert.deepEqual(f.counts(), { stops: 0, sends: 0, additions: 1, promotions: 1 })
  f.ready()
  assert.deepEqual(f.counts(), { stops: 0, sends: 1, additions: 1, promotions: 1 })
 } finally { f.chat.dispose() }
})
test('pending caller without a queue preserves composer instead of sending', () => {
 const f = fixture({ queueEnabled: false })
 try {
  f.chat.importDraft({ text: 'keep me', attachments: [] })
  f.chat.querySelector('.chat-send').click()
  assert.equal(f.chat.exportDraft().text, 'keep me')
  assert.equal(f.counts().sends, 0)
 } finally { f.chat.dispose() }
})
test('absent queueRequired retains idle direct-send behavior', async () => {
 const f = fixture({ hook: false })
 try {
  f.chat.importDraft({ text: 'ordinary', attachments: [] })
  f.chat.querySelector('.chat-send').click()
  await new Promise(setImmediate)
  assert.equal(f.counts().sends, 1)
  assert.equal(f.counts().additions, 0)
 } finally { f.chat.dispose() }
})
test.after(() => dom.restore())
