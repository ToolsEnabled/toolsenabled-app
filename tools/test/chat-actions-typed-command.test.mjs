/* THE PALETTE IS ALSO THE COMMAND LINE (owner, 2026-09-15: "i want to be able to
 * manually add on the page as well as manually direct").
 *
 * MEASURED before this change: the slash key on an empty composer opened the
 * Actions palette and swallowed the slash (components.js onInputKeydown, since
 * 2026-08-27). Everything typed after it went into the palette's filter, which
 * only narrows a list that has no "Request" row -- so "/Request keep it short"
 * ended as "No action matches that", and the person's one keyboard route to
 * filing a rule from a chat was gone. The Ledger page's own box was the only
 * door left.
 *
 * Now the slash lands in the filter, a filter that starts with a slash is a
 * command line, its first row runs it exactly as if the box had sent it, and
 * the word after the slash still narrows the real rows underneath. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const { ACTIONS_TYPED_RUN, ACTIONS_TYPED_EMPTY, ACTIONS_NO_MATCH } = await import('../../src/chat-copy.js')

const rows = chat => [...chat.querySelectorAll('.chat-actions-row')].map(row => ({
  label: (row.children[0]?.textContent || '').trim(),
  disabled: row.disabled === true,
}))
const filterOf = chat => chat.querySelector('.chat-actions-filter')
const typeFilter = (chat, text) => { const filter = filterOf(chat); filter.value = text; filter.dispatch('input'); return filter }

function mount({ onSend = () => {}, actions = () => [{ id: 'interrupt', label: 'Interrupt', hint: 'Stop this turn', enabled: true, run() {} }] } = {}) {
  const chat = buildChat({ title: 'Lane', history: [{ who: 'agent', text: 'hello' }], seed: 0, actions, onSend })
  document.body.appendChild(chat)
  return chat
}

test('the slash key opens the palette with the slash already in the filter, so the person keeps typing their command', () => {
  const chat = mount()
  const input = chat.querySelector('.chat-input input')
  const event = input.dispatch('keydown', { key: '/' })
  assert.equal(event.defaultPrevented, true, 'the slash is the door, not a character in the box')
  assert.equal(input.value, '', 'the box stays empty')
  assert.equal(filterOf(chat).value, '/', 'the slash the person typed is in the filter')
  assert.deepEqual(rows(chat)[0], { label: ACTIONS_TYPED_EMPTY, disabled: true }, 'a bare slash offers the command list and cannot yet run')
})

test('a filter that starts with a slash offers Run <command> first, and Enter sends it as a typed line', async () => {
  const sent = []
  const chat = mount({ onSend: (text, handlers) => { sent.push(text); handlers?.reply?.('filed') } })
  chat.openActions()
  typeFilter(chat, '/Request keep it short')
  const offered = rows(chat)
  assert.equal(offered[0].label, ACTIONS_TYPED_RUN('/Request keep it short'))
  assert.equal(offered[0].disabled, false)
  assert.ok(!offered.some(row => row.label === ACTIONS_NO_MATCH), 'a command line is never "no match"')
  filterOf(chat).dispatch('keydown', { key: 'Enter' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(sent, ['/Request keep it short'], 'Enter sent the command line exactly as typed')
  assert.equal(chat.querySelector('.chat-actions-pop'), null, 'the palette closed once the command was sent')
})

test('the word after the slash still narrows the real rows, so /inter finds Interrupt under the typed row', () => {
  const chat = mount()
  chat.openActions()
  typeFilter(chat, '/inter')
  assert.deepEqual(rows(chat).map(row => row.label), [ACTIONS_TYPED_RUN('/inter'), 'Interrupt'])
  typeFilter(chat, 'inter')
  assert.deepEqual(rows(chat).map(row => row.label), ['Interrupt'], 'without a slash the filter is only a filter')
})
