import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// OPENING A SUB-STAGE MUST NOT CLOSE THE ACTIONS POPUP.
//
// Measured 2026-09-16 on the cut-2 tip (app 85dc71a8) through the real window
// over CDP, mouse and keyboard alike: pressing "Switch model" or "How hard it
// thinks" closed the Actions popup instead of opening its choices. The cause is
// in renderPopStage: a sub-stage hides the filter and clears the rows, so the
// focused element (the filter after a typed Enter, the pressed row after a
// click) leaves the document's focus, onPopFocusOut runs a tick later, finds
// nothing of the popup focused, and closes it. The list survives the
// re-render and is focusable, so it must take focus before the filter hides
// or the rows go. chat-actions-back-focus.test.mjs pins the way back; this
// file pins the way in, from both the filter and a pressed row.

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const deferredFocus = () => new Promise(resolve => setTimeout(resolve, 10))

function fixture(t) {
  let ran = 0
  const leaf = { id: 'leaf', label: 'Opus · Claude', run: () => { ran += 1 } }
  const rows = [
    { id: 'queue', label: 'Queue a message', run: () => {} },
    { id: 'model', label: 'Switch model', hint: 'The change holds until you change it back.', run: ctx => ctx.show(() => [leaf], { title: 'What it runs on' }) },
  ]
  const chat = buildChat({ title: 'Staged Observer', actions: () => rows })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  chat.openActions()
  const popup = chat.querySelector('.chat-actions-pop')
  assert.ok(popup, 'the Actions popup opens')
  return { chat, popup, ran: () => ran }
}

test('a row pressed by pointer opens its sub-stage and the popup stays open with the list focused', async t => {
  const f = fixture(t)
  const row = f.chat.querySelectorAll('.chat-actions-row')[1]
  assert.match(row.textContent, /Switch model/)
  // A pointer press focuses the row; the sub-stage render removes that row.
  row.focus()
  f.popup.dispatch('focusout')
  row.dispatch('click')
  await settle()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === f.popup, 'the same popup is still mounted after the press')
  await deferredFocus()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === f.popup, 'the popup survives the deferred focus check')
  assert.equal(f.chat.querySelector('.chat-actions-filter').hidden, true, 'a sub-stage hides the filter')
  assert.equal(f.chat.querySelector('.chat-actions-title').textContent, 'What it runs on')
  assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-list'), 'the list holds focus inside the popup')
  assert.ok([...f.chat.querySelectorAll('.chat-actions-row')].some(r => /Opus · Claude/.test(r.textContent)), 'the sub-stage rows are drawn')
  assert.equal(f.chat.querySelector('[data-chat-actions]').getAttribute('aria-expanded'), 'true')
  assert.equal(f.ran(), 0, 'opening the stage runs nothing')
})

test('Enter on a filtered row opens its sub-stage and the popup stays open with the list focused', async t => {
  const f = fixture(t)
  const filter = f.chat.querySelector('.chat-actions-filter')
  filter.focus()
  filter.value = 'Switch'
  filter.dispatch('input')
  await settle()
  const rows = [...f.chat.querySelectorAll('.chat-actions-row')]
  assert.equal(rows.length, 1, 'the filter narrows the list to the one row')
  // Hiding the focused filter is what the browser turns into a focusout.
  f.popup.dispatch('focusout')
  f.popup.dispatch('keydown', { key: 'Enter' })
  await settle()
  await deferredFocus()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === f.popup, 'the popup survives opening a sub-stage from the filter')
  assert.equal(f.chat.querySelector('.chat-actions-title').textContent, 'What it runs on')
  assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-list'), 'the list holds focus inside the popup')
  assert.equal(f.ran(), 0)
})
