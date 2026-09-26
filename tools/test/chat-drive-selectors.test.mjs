/* THE COMPOSER'S OWN SELECTORS, EXPORTED (B-pool-6 API decision doc §3).
 *
 * B-pool-6's research found four independent phrasings across nine
 * end-to-end drivers for the SAME composer <input>, plus two approval
 * buttons findable only by their CSS class. src/components.js now exports
 * CHAT_COMPOSER_INPUT_SELECTOR and CHAT_APPROVAL_SELECTOR so a driver
 * composes its own scoping prefix around a constant instead of retyping
 * the suffix -- the same discipline that made the session's C4 vocabulary
 * defect (a test hardcoding "Deny"/"Approve once" instead of importing
 * approvalDecisionWord) catchable at all.
 *
 * These tests drive the exported addresses through mounted production controls.
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { document, restore } = installDomStandIn(globalThis)
const roots = []
after(() => {
  for (const root of roots) root.dispose()
  restore()
})

const { NO_SENDER_WIRED } = await import('../../src/chat-copy.js')
const { buildChat, CHAT_COMPOSER_INPUT_SELECTOR, CHAT_APPROVAL_SELECTOR } = await import('../../src/components.js')

const mountChat = options => {
  const root = buildChat(options)
  roots.push(root)
  document.body.appendChild(root)
  return root
}

test('a real query by the exported CHAT_COMPOSER_INPUT_SELECTOR finds the real composer input', () => {
  const root = mountChat({ title: '·', seed: 0, composerReason: NO_SENDER_WIRED, onSend: () => null })
  const search = root.querySelector('input')
  assert.ok(search, 'the mounted chat is missing its earlier search-input decoy')
  assert.equal(search.getAttribute('type'), 'search', 'the earlier input is no longer the search-input decoy')
  const found = root.querySelector(CHAT_COMPOSER_INPUT_SELECTOR)
  assert.ok(found, 'the exported selector found nothing on a real mounted panel')
  assert.notEqual(found, search, 'the exported selector returned the earlier search-input decoy')
  found.value = 'Edit these words'
  assert.equal(found.value, 'Edit these words', 'the composer selected by a driver is editable')
  const ancestor = found.closest('.chat-input')
  assert.ok(ancestor, 'the selected input has no ancestor matching the exported selector ancestor step')
  assert.equal(root.contains(ancestor), true, 'the matching composer ancestor escaped the mounted chat root')
})

test('a real query by the exported CHAT_APPROVAL_SELECTOR drives distinct approval decisions', async () => {
  const decisions = []
  const root = mountChat({ title: '·', seed: 0, composerReason: NO_SENDER_WIRED, onApprovalDecision: (id, decision) => { decisions.push([id, decision]); return null } })
  root.showApproval({ id: 'sel-accept', summary: '·', decisions: ['accept', 'decline'] })
  const accept = root.querySelector(CHAT_APPROVAL_SELECTOR.accept)
  assert.ok(accept, 'CHAT_APPROVAL_SELECTOR.accept found nothing on a real approval row')
  assert.equal(accept.tagName, 'BUTTON', 'CHAT_APPROVAL_SELECTOR.accept found something other than a button')
  accept.dispatch('click')
  await Promise.resolve()

  root.showApproval({ id: 'sel-decline', summary: '·', decisions: ['accept', 'decline'] })
  const decline = root.querySelectorAll(CHAT_APPROVAL_SELECTOR.decline).at(-1)
  assert.ok(decline, 'CHAT_APPROVAL_SELECTOR.decline found nothing on a real approval row')
  assert.equal(decline.tagName, 'BUTTON', 'CHAT_APPROVAL_SELECTOR.decline found something other than a button')
  decline.dispatch('click')
  await Promise.resolve()
  assert.deepEqual(decisions, [['sel-accept', 'accept'], ['sel-decline', 'decline']])
})

// These exercise the exported address, not a particular selector spelling.
test('the exported composer selector drives a real send from the mounted composer', async () => {
  const sent = []
  const root = mountChat({ title: 'Selector proof', onSend: text => { sent.push(text) } })
  const input = root.querySelector(CHAT_COMPOSER_INPUT_SELECTOR)
  input.value = 'Words selected by the shared driver'
  input.dispatch('keydown', { key: 'Enter' })
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  assert.deepEqual(sent, ['Words selected by the shared driver'])
  assert.equal(input.value, '')
})
test('approval selector exports cannot be mutated into the opposite action', () => {
  assert.equal(Object.isFrozen(CHAT_APPROVAL_SELECTOR), true)
  assert.notEqual(CHAT_APPROVAL_SELECTOR.accept, CHAT_APPROVAL_SELECTOR.decline)
  assert.throws(() => { CHAT_APPROVAL_SELECTOR.accept = CHAT_APPROVAL_SELECTOR.decline }, TypeError)
})
