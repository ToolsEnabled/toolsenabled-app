import test from 'node:test'
import assert from 'node:assert/strict'
import { homeFixture, until, settle } from './helpers/home-additions-world.mjs'
import { createHomeComposerDraftStore } from '../../src/home-chat-composer-draft.js'

// The DOM stand-in matches one simple selector per step, so find the active pane first.
const form = view => [...view.el.querySelectorAll('.home-chat-pane')]
  .find(pane => pane.dataset.active === 'true')?.querySelector('.agent-compose') || null
function fields(panel) {
  return Object.fromEntries([...panel.querySelectorAll('[data-compose-field]')].map(node => [node.dataset.composeField, node.value]))
}
async function newDraft(f, text) {
  const view = await f.open()
  view.el.querySelector('[data-chat-new]').click()
  const panel = await until(() => form(view), 'actual shared New chat form must mount')
  const message = panel.querySelector('[data-compose-field="message"]')
  message.value = text; message.dispatch('input')
  for (const key of ['role', 'tier', 'effort']) {
    const control = panel.querySelector(`[data-compose-field="${key}"]`)
    const choices = [...control.options].filter(option => option.value && !option.disabled)
    if (choices.length) { control.value = choices.at(-1).value; control.dispatch('change') }
  }
  message.setSelectionRange(2, 7)
  return { view, panel, message, before: fields(panel),
    id: panel.closest('.home-chat-pane').dataset.paneId }
}
async function reopened(f, view) {
  await f.open(view)
  return until(() => form(view), 'retained New chat form must remount')
}

test('Escape in a Home New chat brief returns to overview and preserves fields, selection and window identity', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'An unsent Escape handoff')
  let value = first.message.value
  const reads = []
  Object.defineProperty(first.message, 'value', { configurable: true,
    get() { reads.push(this.isConnected); return value }, set(next) { value = next } })
  first.message.dispatch('keydown', { key: 'Escape' })
  assert.ok(reads.length > 0, 'disposal captures the live message control')
  assert.ok(reads.every(connected => connected), 'capture occurs before controls are removed')
  await settle(8)
  assert.equal(first.view.el.querySelector('[data-chat-takeover]').hidden, true)
  const panel = await reopened(f, first.view)
  assert.deepEqual(fields(panel), first.before)
  assert.equal(panel.closest('.home-chat-pane').dataset.paneId, first.id)
  const message = panel.querySelector('[data-compose-field="message"]')
  assert.equal(message.selectionStart, 2)
  assert.equal(message.selectionEnd, 7)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('Home route destruction restores an independently typed New chat and chosen windows without an Escape first', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'A separate route handoff, never escaped')
  const layout = first.view.el.querySelector('[data-chat-layout]')
  layout.value = 'four'; layout.dispatch('change')
  const windowIds = [...first.view.el.querySelectorAll('.home-chat-pane')].map(node => node.dataset.paneId)
  await f.close(first.view)
  const view = await f.mount()
  const panel = await reopened(f, view)
  assert.deepEqual(fields(panel), first.before)
  assert.equal(view.el.querySelector('[data-chat-layout]').value, 'four')
  assert.deepEqual([...view.el.querySelectorAll('.home-chat-pane')].map(node => node.dataset.paneId), windowIds)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('deliberate Not now consumes the New chat draft across route return and a subsequent new window', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'This draft is explicitly cancelled')
  first.panel.querySelector('[data-compose-action="cancel"]').click()
  await settle(8)
  assert.equal(first.view.el.querySelector('[data-chat-takeover]').hidden, false)
  assert.equal(form(first.view), null)
  await f.close(first.view)
  const view = await f.open()
  view.el.querySelector('[data-chat-new]').click()
  const panel = await until(() => form(view), 'another new form mounts after cancellation')
  assert.equal(panel.querySelector('[data-compose-field="message"]').value, '')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('consumed and composing Escape events do not close or cancel the Home draft', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'Keep this while a nested control owns Escape')
  first.message.dispatch('keydown', { key: 'Escape', defaultPrevented: true })
  first.message.dispatch('keydown', { key: 'Escape', isComposing: true })
  first.message.dispatch('keydown', { key: 'Escape', keyCode: 229 })
  first.panel.querySelector('[data-compose-field="role"]').dispatch('keydown', { key: 'Escape' })
  await settle(8)
  assert.equal(first.view.el.querySelector('[data-chat-takeover]').hidden, false)
  assert.deepEqual(fields(form(first.view)), first.before)
})

test('New chat route handoff never restores the previous account generation', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'Only account A may see this draft')
  await f.close(first.view)
  f.changeAccount('b'.repeat(32))
  const view = await f.open()
  assert.equal(form(view), null)
  assert.equal(view.el.querySelectorAll('.home-chat-pane').length, 1)
})

test('local New chat route state is not restored onto a different data source', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'Only the local source owns these fields')
  await f.close(first.view)
  await f.changeSource('mock')
  const view = await f.open()
  assert.equal(form(view), null)
  assert.equal(view.el.querySelector('[data-chat-new]').disabled, true)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('a newer Home workspace claim refuses a late write from the previous mount', async () => {
  const account = { current: async () => ({ signedIn: true, account: { id: 'fixture-account' }, session: { issuedAtMs: 1 } }) }
  const first = createHomeComposerDraftStore({ account })
  await first.ready
  const older = first.forWorkspace({ source: 'local' })
  older.read()
  older.write({ layout: { layout: 'double' }, newChats: new Map([['new:2', { message: 'current' }]]) })
  const second = createHomeComposerDraftStore({ account })
  await second.ready
  const newer = second.forWorkspace({ source: 'local' })
  assert.equal(newer.read().newChats.get('new:2').message, 'current')
  newer.write({ layout: { layout: 'four' }, newChats: new Map([['new:2', { message: 'newer' }]]) })
  older.write({ layout: {}, newChats: new Map([['new:2', { message: 'stale' }]]) })
  const third = createHomeComposerDraftStore({ account })
  await third.ready
  assert.equal(third.forWorkspace({ source: 'local' }).read().newChats.get('new:2').message, 'newer')
})


test('deliberately closing a New chat window does not resurrect its draft when pane identities are reused', async t => {
  const f = await homeFixture(t)
  const first = await newDraft(f, 'Discard this with the window close button')
  const pane = first.panel.closest('.home-chat-pane')
  const close = [...pane.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Close window')
  assert.ok(close, 'actual pane close action exists')
  close.click()
  first.view.el.querySelector('[data-chat-collapse]').click()
  await f.open(first.view)
  first.view.el.querySelector('[data-chat-new]').click()
  const panel = await until(() => form(first.view), 'new form after deliberate window close')
  assert.equal(panel.querySelector('[data-compose-field="message"]').value, '')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

// T1538: after Not now (or Set) the Open picker kept a 'New chat' entry that
// opened nothing when chosen.
test('after Not now or Set, the Open picker offers no leftover New chat entry', async t => {
  const f = await homeFixture(t)
  const newChatOptions = view => [...view.el.querySelectorAll('[data-chat-subject] option')].filter(option => option.value.startsWith('new:'))
  const first = await newDraft(f, 'Cancelled with Not now')
  assert.equal(newChatOptions(first.view).length, 1, 'the open New chat window is offered')
  first.panel.querySelector('[data-compose-action="cancel"]').click()
  await settle(8)
  assert.deepEqual(newChatOptions(first.view).map(option => option.value), [], 'Not now leaves no New chat entry')
  first.view.el.querySelector('[data-chat-new]').click()
  const panel = await until(() => form(first.view), 'another New chat form mounts')
  const message = panel.querySelector('[data-compose-field="message"]')
  message.value = 'Set as a draft agent'; message.dispatch('input')
  panel.querySelector('[data-compose-action="set"]').click()
  await until(() => !form(first.view), 'Set turns the window into the agent')
  await settle(8)
  assert.deepEqual(newChatOptions(first.view).map(option => option.value), [], 'Set leaves no New chat entry')
  const picker = first.view.el.querySelector('[data-chat-subject]')
  assert.ok([...picker.querySelectorAll('option')].some(option => option.value === picker.value), 'the picker shows the window in front')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})
