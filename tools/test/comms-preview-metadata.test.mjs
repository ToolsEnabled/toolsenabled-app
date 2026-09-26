import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setChatMessageBody, addChatMessageCopy } from '../../src/chat-message-body.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { rowModel, senderHues, shouldFold, messagePreview, toRecipient, NO_ANSWER_YET } from '../../src/comms-copy.js'

const installed = installDomStandIn(globalThis)
const { el, openMemory, ownDisclosure } = await import('../../src/components.js')
// Execute the production row/fold builders with the shared DOM parser. The
// whole page's unrelated text-node status/drag APIs are not a layout stand-in.
const source = readFileSync(new URL('../../src/views/comms.js', import.meta.url), 'utf8')
const formatSource = source.slice(source.indexOf('const pad2 ='), source.indexOf('const foldOpen ='))
const rowSource = source.slice(source.indexOf('function foldEl('), source.indexOf('/* Fill a surface'))
const rowEl = vm.runInNewContext(formatSource + '\n' + rowSource + '\nrowEl', {
  el, shouldFold, messagePreview, ownDisclosure, toRecipient, NO_ANSWER_YET, setChatMessageBody, addChatMessageCopy,
  foldOpen: openMemory('preview-metadata-test:'),
})
const messages = [
  { id: 'known', sender: 'Controller <&>', recipient: 'Review <recipient>', at: '2026-09-05T09:41:00.000Z', text: 'A complete short message.' },
  { id: 'missing', sender: 'Worker', text: 'Words without invented metadata.' },
  { id: 'folded', sender: 'Reviewer', recipient: 'Controller', at: '2026-09-05T09:42:00.000Z', text: 'Long retained message. '.repeat(180) },
]
const byId = new Map(messages.map(message => [message.id, message]))
const rows = messages.map(message => rowEl(rowModel(message, byId), 'cl', senderHues(messages)))

test.after(() => installed.restore())

test('the actual message preview preserves known sender, recipient, timestamp and body as separate readable metadata', () => {
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.querySelector('.cmsg-au').textContent, messages[0].sender)
  assert.equal(row.querySelector('.cmsg-to')?.textContent, '→ ' + messages[0].recipient)
  const stamp = row.querySelector('time')
  assert.ok(stamp && !stamp.hidden, 'a recorded timestamp is visible metadata')
  assert.equal(stamp.getAttribute('datetime'), messages[0].at)
  assert.ok(stamp.textContent.trim(), 'the known timestamp has a human-readable label')
  assert.equal(row.querySelector('.cmsg-text').textContent, messages[0].text)
  assert.equal(row.querySelector('recipient'), null, 'recipient markup-like characters remain text')
})

test('missing metadata remains absent instead of manufacturing a recipient or current time', () => {
  const row = rows[1]
  assert.equal(row.querySelector('.cmsg-to'), null)
  assert.ok(!row.querySelector('time') || row.querySelector('time').hidden)
  assert.equal(row.querySelector('.cmsg-text').textContent, messages[1].text)
})

test('preview metadata does not truncate or unfold a long message body', () => {
  const row = rows[2]
  const fold = row.querySelector('details')
  assert.ok(fold)
  assert.equal(fold.open, false)
  assert.equal(fold.querySelector('.cmsg-text').textContent, messages[2].text.trim())
  assert.equal(row.querySelector('.cmsg-to')?.textContent, '→ Controller')
})

test('inbox confirmation names its limit and unknown receipt state never claims success', () => {
  const available = rowModel({ id: 'a', deliveryState: 'available' })
  assert.equal(available.deliveryLabel, 'In inbox')
  assert.match(available.deliveryDetail, /does not confirm.*read or acted/)
  const incomplete = rowModel({ id: 'b', deliveryState: 'unconfirmed' })
  assert.equal(incomplete.deliveryLabel, 'Delivery unconfirmed')
  assert.equal(rowModel({ id: 'c', deliveryState: 'unexpected' }).deliveryLabel, '')
})

test('routine receipt details are optional while an unconfirmed delivery stays visible with the message', () => {
  const render = deliveryState => rowEl(rowModel({ id: deliveryState, sender: 'Builder', text: 'A short update.', deliveryState, senderMachine: 'Workstation' }), 'cmsg', new Map())
  const available = render('available')
  assert.equal(available.querySelector('.cmsg-foot'), null, 'a success badge does not clutter the conversation')
  const detail = available.querySelector('.cmsg-details'), button = available.querySelector('.cmsg-details-toggle')
  assert.equal(detail.hidden, true)
  button.click()
  assert.equal(detail.hidden, false)
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.match(detail.textContent, /Workstation/)
  assert.match(detail.textContent, /does not confirm.*read or acted/)
  const unconfirmed = render('unconfirmed')
  assert.match(unconfirmed.querySelector('.cmsg-foot').textContent, /Delivery unconfirmed/)
  assert.equal(unconfirmed.querySelector('.cmsg-details').hidden, true)
})
