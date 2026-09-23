import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { cloudCommandAction } from '../../src/cloud-command-actions.js'
import { PALETTE_PANEL } from '../../src/fleet-tree-copy.js'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }

function fixture(t, { queue = null } = {}) {
  const sent = []
  const rows = () => [cloudCommandAction({ enabled: true })]
  const chat = buildChat({ title: 'Cloud coordinator', actions: rows, commonActions: rows, queue,
    onSend: text => sent.push(text), status: { busy: () => false } })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  return { chat, input: chat.querySelector('.chat-input input'), sent }
}

async function choose(chat, label) {
  chat.openActions()
  chat.querySelector('.chat-actions-row').click()
  await settle()
  const option = [...chat.querySelectorAll('.chat-actions-row')].find(row => row.textContent.startsWith(label))
  assert.ok(option, `missing cloud option ${label}`)
  option.click()
  await settle()
}

test('cloud dropdown selects limits in the originating draft without sending or opening setup', async t => {
  const { chat, input, sent } = fixture(t)
  input.value = 'fix the tree and check chat'
  await choose(chat, 'Up to 10 cloud workers')
  assert.equal(input.value, '/cloud --workers 10 -- fix the tree and check chat')
  assert.equal(document.activeElement, input)
  assert.equal(chat.querySelector('.chat-actions-pop'), null)
  await choose(chat, PALETTE_PANEL.cloudAuto)
  assert.equal(input.value, '/cloud fix the tree and check chat')
  assert.deepEqual(sent, [])
})

test('cloud dropdown cannot replace another queued message while recalling it', async t => {
  const edits = []
  const { chat, input, sent } = fixture(t, { queue: {
    list: () => [{ id: 'waiting', text: 'keep these words' }],
    replace: (...args) => { edits.push(args); return { ok: true } },
  } })
  input.dispatch('keydown', { key: 'ArrowUp' })
  await choose(chat, 'Up to 1 cloud worker')
  assert.equal(input.value, 'keep these words')
  assert.equal(chat.querySelector('.chat-actions-out').textContent, PALETTE_PANEL.cloudQueueEdit)
  assert.deepEqual(edits, [])
  assert.deepEqual(sent, [])
})
