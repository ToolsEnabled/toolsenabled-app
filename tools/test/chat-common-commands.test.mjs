import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const { PALETTE_PANEL } = await import('../../src/fleet-tree-copy.js')

function mount({ queue = null } = {}) {
  let changed = () => {}
  let minutes = 20
  let loopOpens = 0
  const sent = []
  const rows = () => [
    { id: 'goal', icon: 'goal', group: 'Common functions', label: '/goal', enabled: true,
      run: ctx => ctx.compose('/goal ', PALETTE_PANEL.goalHint) },
    { id: 'loop', icon: 'loop', group: 'Common functions', label: '/loop', minutes, enabled: true,
      run: ctx => { loopOpens += 1; ctx.close() } },
  ]
  const chat = buildChat({ title: 'Builder', seed: 0, onSend: text => sent.push(text), queue,
    status: { busy: () => false, subscribe: listener => { changed = listener; return () => {} } },
    actions: rows, commonActions: rows })
  document.body.appendChild(chat)
  return { chat, sent, input: chat.querySelector('.chat-input input'), loopOpens: () => loopOpens,
    setMinutes: value => { minutes = value; changed() } }
}

test('the goal shortcut preserves the draft and does not send or duplicate a command', async () => {
  const { chat, input, sent } = mount()
  try {
    input.value = 'polish the icons'
    chat.querySelector('[data-common-command="goal"]').click()
    await Promise.resolve()
    assert.equal(input.value, '/goal polish the icons')
    assert.equal(document.activeElement, input)
    chat.querySelector('[data-common-command="goal"]').click()
    await Promise.resolve()
    assert.equal(input.value, '/goal polish the icons')
    assert.deepEqual(sent, [])
  } finally { chat.dispose(); chat.remove() }
})

test('loop shortcuts use the palette handler and update minutes without losing focus', async () => {
  const { chat, setMinutes, loopOpens, sent } = mount()
  try {
    const button = chat.querySelector('[data-common-command="loop"]')
    button.focus()
    setMinutes(7)
    assert.equal(chat.querySelector('[data-common-command="loop"]'), button)
    assert.equal(document.activeElement, button)
    assert.equal(button.querySelector('.common-command-minutes').textContent, '7')
    assert.match(button.getAttribute('aria-label'), /7 min/)
    button.click()
    await Promise.resolve()
    assert.equal(loopOpens(), 1)
    assert.deepEqual(sent, [])
  } finally { chat.dispose(); chat.remove() }
})

test('composing a goal cannot rewrite a recalled waiting message into a command', async () => {
  const edits = []
  const { chat, input } = mount({ queue: {
    list: () => [{ id: 'queued-1', text: 'already waiting' }],
    replace: (...args) => { edits.push(args); return { ok: true } },
  } })
  try {
    input.dispatch('keydown', { key: 'ArrowUp' })
    chat.querySelector('[data-common-command="goal"]').click()
    await Promise.resolve()
    assert.equal(input.value, 'already waiting')
    assert.deepEqual(edits, [])
    assert.equal(chat.querySelector('.chat-actions-out').textContent, PALETTE_PANEL.goalQueueEdit)
  } finally { chat.dispose(); chat.remove() }
})
