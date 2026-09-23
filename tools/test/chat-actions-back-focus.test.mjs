import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const deferredFocus = () => new Promise(resolve => setTimeout(resolve, 10))

// The complete maintained popup consumer runs here. The DOM fixture supplies
// pointer focus and focusout, which its simplified event model does not emit;
// no native/browser execution is claimed by this regression.
async function fixture(t, nested = false) {
  let ran = 0
  const leaf = { id: 'leaf', label: 'Confirm removal', run: () => { ran += 1 } }
  const rows = [{ id: 'remove', label: 'Remove this agent', run: ctx => ctx.show(
    nested ? [{ id: 'nested', label: 'Another stage', run: child => child.show([leaf]) }] : [leaf],
    { title: 'Remove this agent' },
  ) }]
  const chat = buildChat({ title: 'Staged Observer', actions: () => rows })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  chat.openActions()
  chat.querySelector('.chat-actions-row').dispatch('click')
  await settle()
  if (nested) {
    chat.querySelectorAll('.chat-actions-row')[1].dispatch('click')
    await settle()
  }
  const popup = chat.querySelector('.chat-actions-pop')
  assert.ok(popup)
  assert.equal(chat.querySelector('.chat-actions-filter').hidden, true)
  assert.ok(document.activeElement === chat.querySelector('.chat-actions-list'), 'The submenu list must initially hold focus')
  return { chat, popup, ran: () => ran }
}

test('pointer Back returns focus to the top Actions filter before the deferred focus check', async t => {
  const f = await fixture(t)
  const back = f.chat.querySelector('.chat-actions-back')
  back.focus()
  // A pointer press focuses Back; rebuilding removes it. A pending focusout
  // must find the new filter, not a removed button or document.body.
  f.popup.dispatch('focusout')
  back.dispatch('click')
  await settle()
  assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-filter'), 'Back must return focus to the still-open Actions filter')
  await deferredFocus()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === f.popup, 'The same Actions popup must remain mounted')
  assert.equal(f.chat.querySelector('[data-chat-actions]').getAttribute('aria-expanded'), 'true')
  assert.equal(f.ran(), 0, 'Back must not confirm removal')
})

test('keyboard Back keeps the top Actions filter focused without running the staged action', async t => {
  const f = await fixture(t)
  const list = f.chat.querySelector('.chat-actions-list')
  list.dispatch('keydown', { key: 'Home' })
  list.dispatch('keydown', { key: 'Enter' })
  await settle()
  assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-filter'), 'Keyboard Back must focus the filter')
  assert.equal(f.ran(), 0)
})

test('pointer Back from a nested Actions stage keeps the parent list and its Back choice', async t => {
  const f = await fixture(t, true)
  const back = f.chat.querySelector('.chat-actions-back')
  back.focus()
  f.popup.dispatch('focusout')
  back.dispatch('click')
  await deferredFocus()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === f.popup, 'The same Actions popup must remain mounted')
  assert.equal(f.chat.querySelector('.chat-actions-filter').hidden, true)
  assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-list'), 'The parent submenu list must retain focus')
  assert.ok(f.chat.querySelector('.chat-actions-back'))
  assert.equal(f.ran(), 0)
})

test('leaving Actions for another real control still closes it and preserves that destination', async t => {
  const f = await fixture(t)
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  t.after(() => elsewhere.remove())
  elsewhere.focus()
  f.popup.dispatch('focusout')
  await deferredFocus()
  assert.ok(f.chat.querySelector('.chat-actions-pop') === null, 'Leaving Actions must close its popup')
  assert.equal(f.chat.querySelector('[data-chat-actions]').getAttribute('aria-expanded'), 'false')
  assert.ok(document.activeElement === elsewhere, 'Closing Actions must retain the new focus destination')
  assert.equal(f.ran(), 0)
})
