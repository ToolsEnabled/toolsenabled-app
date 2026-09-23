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
 * Half source-pin, half real DOM: the source-pins prove the internal
 * composer ACTUALLY reads its own exported constant rather than a
 * coincidentally-identical duplicate literal; the real-DOM tests prove a
 * driver querying by the exported constant finds the real, live elements.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')

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

test('CHAT_COMPOSER_INPUT_SELECTOR and CHAT_APPROVAL_SELECTOR are exported with the shipped values', () => {
  assert.match(components, /export const CHAT_COMPOSER_INPUT_SELECTOR = '\.chat-input input'/,
    'the composer input selector export is gone or its value changed')
  assert.match(components, /export const CHAT_APPROVAL_SELECTOR = Object\.freeze\(\{/,
    'the approval selector export is gone, or is no longer frozen (a driver could accidentally mutate a shared constant)')
  assert.match(components, /accept: '\[data-chat-approval="accept"\]'/, 'the accept selector value changed')
  assert.match(components, /decline: '\[data-chat-approval="decline"\]'/, 'the decline selector value changed')
})

test('buildChat\'s own composer reads the exported constant, not a duplicate literal', () => {
  const chat = components.slice(components.indexOf('export function buildChat'))
  assert.match(chat, /const input = root\.querySelector\(CHAT_COMPOSER_INPUT_SELECTOR\) \|\| root\.querySelector\('input'\)/,
    'buildChat no longer reads its own exported CHAT_COMPOSER_INPUT_SELECTOR -- the export and the real composer could drift apart silently')
})


const mountChat = options => {
  const root = buildChat(options)
  roots.push(root)
  document.body.appendChild(root)
  return root
}

test('a real query by the exported CHAT_COMPOSER_INPUT_SELECTOR finds the real composer input', () => {
  const root = mountChat({ title: '·', seed: 0, composerReason: NO_SENDER_WIRED, onSend: () => null })
  const steps = CHAT_COMPOSER_INPUT_SELECTOR.trim().split(/\s+/)
  assert.equal(steps.length, 2, 'the exported composer selector must retain the supported two-step shape')
  const [ancestorStep, finalStep] = steps
  assert.equal(finalStep, 'input', 'the exported composer selector final step must identify an input')
  const search = root.querySelector('input')
  assert.ok(search, 'the mounted chat is missing its earlier search-input decoy')
  assert.equal(search.getAttribute('type'), 'search', 'the earlier input is no longer the search-input decoy')
  const found = root.querySelector(CHAT_COMPOSER_INPUT_SELECTOR)
  assert.ok(found, 'the exported selector found nothing on a real mounted panel')
  assert.notEqual(found, search, 'the exported selector returned the earlier search-input decoy')
  assert.equal(found.getAttribute('type'), 'text', 'the exported selector did not return the text composer input')
  const ancestor = found.closest(ancestorStep)
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
