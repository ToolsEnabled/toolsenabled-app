/* THE INLINE APPROVAL STRIP (design/chat/picked-card.png). root.showApproval
 * and root.resolveApproval, matching the exact shape B1 and B3 locked over
 * messages 2026-08-28: id/summary/badges in, a Map keyed by String(id) so a
 * caller polling a live source can call showApproval again for the same id
 * and repaint in place rather than duplicate a row.
 *
 * THE DECISION WORDS ARE NOT REINVENTED HERE. The picked design mock's own
 * button labels ("Deny" / "Approve once") are placeholder text with no
 * backing vocabulary anywhere in this codebase -- the real, shipped,
 * tested words are approvalDecisionWord('accept'|'decline') from
 * src/fleet-tree-copy.js ("Allow once" / "Refuse"), the SAME words
 * views/computers.js already uses for this exact decision elsewhere in the
 * product. A second vocabulary next to that one would be the defect "one
 * path per thing" exists to prevent -- this file pins that the literal
 * strings from the picked mock never appear in components.js.
 *
 * ONLY REJECT RE-ENABLES THE BUTTONS. onApprovalDecision resolving (even to
 * a falsy value) is treated as a settled decision and leaves the row as-is,
 * waiting on the caller's own root.resolveApproval(id); only a thrown error
 * or a rejected promise re-enables both buttons for a retry. This is the
 * exact bug B3 caught in their own onApprovalDecision implementation before
 * landing it (a `.then()` that always resolved, even on a failed engine
 * answer, would have left the buttons disabled forever with no way back) --
 * the fix lives on B3's side, but this test pins that OUR half of the
 * contract only ever re-enables on the reject path, so that fix stays
 * meaningful.
 *
 * MOST OF THIS FILE IS SOURCE PINS, deliberately: buildChat needs a DOM to
 * run, and node --test has none by default. The dispatched-click tests near
 * the end of this file are the exception -- they use the same small DOM
 * stand-in tools/test/chat-message-identity.test.mjs already established
 * (the committed DOM stand-in used to mount buildChat and fire real
 * listeners), to close the gap a
 * harness catalog named: a source pin proves the button's own click
 * handler calls decide(); it does not prove a real click on the real
 * element reaches onApprovalDecision with the right arguments, or that the
 * two outcome paths actually toggle `disabled` on the real DOM nodes. That
 * needs a dispatched event on a real element, which is what those tests do.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))
const approval = chat.slice(chat.indexOf('const approvalRows = new Map()'), chat.indexOf('/* ---- THE ACTIONS POPUP'))

/* ---------------------------------------------------------------
   Install the committed DOM stand-in before importing product modules that
   read browser globals. DOM_STAND_IN_MODULE is solely a module-under-test
   hook used by the scratch-copy mutation proof.
   --------------------------------------------------------------- */
const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { document, restore } = installDomStandIn(globalThis)
after(() => restore())

const { buildChat } = await import('../../src/components.js')
const { approvalDecisionWord: approvalDecisionWordLive } = await import('../../src/fleet-tree-copy.js')
const { APPROVAL_STRIP_LABEL, APPROVAL_RETRY_HINT } = await import('../../src/chat-copy.js')
/* Every pending microtask this file's promise chains (decide()'s
   Promise.resolve().then().then().catch()) could possibly need, flushed
   with one macrotask tick -- robust regardless of how many .then()s are
   actually in the chain, rather than counting them by hand. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/* Approval ids, decision keys, call captures, promises, flush, and behavior assertions remain scenario-local. */

test('onApprovalDecision defaults to null, so no existing caller is required to pass it', () => {
  const signature = chat.slice(0, chat.indexOf('{\n') + 1)
  assert.match(signature, /onApprovalDecision = null/, 'onApprovalDecision lost its null default -- an existing caller that never wires approvals would now have to')
})

test('showApproval keys rows by String(id) and repaints in place on a second call for the same id', () => {
  assert.match(approval, /const id = String\(approval\.id\)/, 'the id is no longer coerced to a string -- a numeric and a string id for the same approval would create two rows')
  assert.match(approval, /let row = approvalRows\.get\(id\)/, 'showApproval no longer looks up an existing row before deciding whether to build one')
  assert.match(approval, /if \(!row\) \{/, 'a second call with the same id would build a duplicate row instead of repainting the existing one')
})

test('the two buttons use approvalDecisionWord, never the picked mock\'s placeholder words', () => {
  assert.match(approval, /button\.textContent = approvalDecisionWord\(decision, approval\.decisionKinds\)/, 'the decline button no longer reads its label from approvalDecisionWord')
  assert.match(approval, /button\.textContent = approvalDecisionWord\(decision, approval\.decisionKinds\)/, 'the accept button no longer reads its label from approvalDecisionWord')
  assert.doesNotMatch(chat, /['"`]Deny['"`]/, 'the picked mock\'s placeholder word "Deny" leaked into components.js as a literal -- it must come from approvalDecisionWord, not be typed here')
  assert.doesNotMatch(chat, /Approve once/, 'the picked mock\'s placeholder phrase "Approve once" leaked into components.js as a literal -- it must come from approvalDecisionWord, not be typed here')
})

test('both buttons carry data-chat-approval, the same non-CSS-hook convention every other composer control uses', () => {
  assert.match(approval, /button\.setAttribute\('data-chat-approval', decision\)/,
    'the decline button lost its data-chat-approval hook -- a driver would have to select it by class again')
  assert.match(approval, /button\.setAttribute\('data-chat-approval', decision\)/,
    'the accept button lost its data-chat-approval hook -- a driver would have to select it by class again')
})

test('a press disables both buttons before onApprovalDecision is even called', () => {
  const decide = approval.slice(approval.indexOf('row.decide = (decision)'), approval.indexOf('row.summary.textContent'))
  const disableAt = decide.search(/for \(const button of row\.buttons\) button\.disabled = true/)
  const callAt = decide.indexOf('onApprovalDecision(id, decision)')
  assert.ok(disableAt !== -1, 'both buttons are no longer disabled together before the decision is dispatched')
  assert.ok(callAt !== -1 && disableAt < callAt, 'onApprovalDecision is called before the buttons disable -- a fast double-press could fire it twice')
})

test('decision is always the raw key, never the button\'s own label text', () => {
  assert.match(approval, /button\.addEventListener\('click',.*row\.decide\(decision\)/, 'the decline button no longer passes the literal key \'decline\'')
  assert.match(approval, /button\.addEventListener\('click',.*row\.decide\(decision\)/, 'the accept button no longer passes the literal key \'accept\'')
})

test('only reject re-enables the buttons; resolve never does, whatever it resolves to', () => {
  const decide = approval.slice(approval.indexOf('row.decide = (decision)'), approval.indexOf('row.summary.textContent'))
  const thenBlock = decide.slice(decide.indexOf('.then(said'), decide.indexOf('.catch('))
  assert.doesNotMatch(thenBlock, /disabled = false/, 'the resolve path re-enables the buttons -- only reject/throw may do that, or a failed-but-resolved decision would look retryable when it is actually just unsettled')
  const catchBlock = decide.slice(decide.indexOf('.catch('))
  assert.match(catchBlock, /for \(const button of row\.buttons\) button\.disabled = row\.externalAnswering/,
    'a rejected local press must still respect an answer pending through another surface')
  assert.match(catchBlock, /row\.deciding = false/, 'the reject path no longer clears the in-flight guard, so a retry press would silently no-op forever')
})

test('resolving to a truthy sentence posts a note; the row is never auto-removed', () => {
  const decide = approval.slice(approval.indexOf('row.decide = (decision)'), approval.indexOf('row.summary.textContent'))
  assert.match(decide, /\.then\(said => \{ if \(!disposed && said\) addMsg\('note', String\(said\)\) \}\)/,
    'a resolved sentence no longer posts as a transcript note')
  assert.doesNotMatch(decide, /approvalRows\.delete/, 'showApproval\'s own decide() must never remove the row itself -- only root.resolveApproval, called by the caller once the engine has actually settled, may do that')
})

test('resolveApproval removes the row and its map entry; a missing id is a no-op, never a throw', () => {
  const resolveFn = chat.slice(chat.indexOf(`Object.defineProperty(root, 'resolveApproval'`), chat.indexOf(`Object.defineProperty(root, 'resolveApproval'`) + 260)
  assert.match(resolveFn, /const row = approvalRows\.get\(String\(id\)\)/, 'resolveApproval no longer coerces id to match showApproval\'s own String(id) keying')
  assert.match(resolveFn, /if \(!row\) return/, 'resolveApproval no longer guards a missing id -- it would throw on row.wrap.remove() instead of no-op-ing')
  assert.match(resolveFn, /row\.wrap\.remove\(\)/, 'resolveApproval no longer removes the row\'s element from the log')
  assert.match(resolveFn, /approvalRows\.delete\(String\(id\)\)/, 'resolveApproval no longer clears the row from the map -- a later showApproval with the same id would repaint a detached element')
})

test('badges are optional and free-form -- no SMALL/WRITE taxonomy invented in this component', () => {
  assert.match(approval, /for \(const badge of Array\.isArray\(approval\.badges\) \? approval\.badges : \[\]\)/,
    'badges no longer defaults to an empty array for a caller that omits it')
  assert.doesNotMatch(chat, /['"`]SMALL['"`]/, 'the picked mock\'s illustrative "SMALL" badge text leaked into components.js as a literal -- badges must stay caller-supplied, never a taxonomy invented here')
  assert.doesNotMatch(chat, /['"`]WRITE['"`]/, 'the picked mock\'s illustrative "WRITE" badge text leaked into components.js as a literal -- badges must stay caller-supplied, never a taxonomy invented here')
})

test('the map is cleared on dispose, alongside the other per-chat collections', () => {
  /* The WHOLE dispose body, located by its own closing brace. A fixed character
     window silently stopped covering the later teardown lines as dispose grew:
     measured 2026-09-09 at app 6909208e, statusUnsub sat at offset 1385 but
     queueUnsub at 1467 and chipsUnsub at 1519, so a 1400 window reported
     "dispose leaks the queue subscription" while dispose unsubscribes on the
     very next line. A pin that silently stops measuring is worse than no pin. */
  const disposeAt = chat.indexOf('const dispose = ()')
  const dispose = chat.slice(disposeAt, chat.indexOf('\n  }', disposeAt) + 4)
  assert.match(dispose, /approvalRows\.clear\(\)/, 'dispose no longer clears the approval rows map')
})

/* ---------------------------------------------------------------
   DISPATCHED CLICKS ON THE REAL ELEMENTS, both buttons, both outcomes.
   Everything above proves the source is wired correctly; these four prove
   a real click on the real .chat-approval-accept / .chat-approval-decline
   element actually reaches onApprovalDecision with the right (id, decision)
   pair, and that the disabled state on the real DOM nodes follows the
   resolve/reject split this file has been pinning at the source level.
   --------------------------------------------------------------- */

test('a real click on .chat-approval-decline reaches onApprovalDecision(id, \'decline\'), and disables both buttons immediately', async () => {
  const calls = []
  const root = buildChat({
    title: '·', seed: 0, composerReason: null,
    onApprovalDecision: (id, decision) => { calls.push([id, decision]); return new Promise(() => {}) }, // never settles -- isolates the immediate-disable behaviour from the outcome
  })
  root.showApproval({ id: 'a1', summary: '·', decisions: ['decline', 'accept'], badges: ['·'] })
  const decline = root.querySelector('.chat-approval-decline')
  const accept = root.querySelector('.chat-approval-accept')
  assert.ok(decline && accept, 'showApproval did not render both buttons for a real click to land on')
  decline.dispatch('click')
  assert.equal(decline.disabled, true, 'a real click on Decline did not disable the Decline button')
  assert.equal(accept.disabled, true, 'a real click on Decline did not also disable the Accept button')
  await flush()
  assert.deepEqual(calls, [['a1', 'decline']], 'onApprovalDecision was not reached with the right (id, decision) pair from a real click on Decline')
  root.dispose()
})

test('a real click on .chat-approval-accept reaches onApprovalDecision(id, \'accept\')', async () => {
  const calls = []
  const root = buildChat({
    title: '·', seed: 0, composerReason: null,
    onApprovalDecision: (id, decision) => { calls.push([id, decision]); return new Promise(() => {}) },
  })
  root.showApproval({ id: 'a2', summary: '·', decisions: ['decline', 'accept'] })
  root.querySelector('.chat-approval-accept').dispatch('click')
  await flush()
  assert.deepEqual(calls, [['a2', 'accept']], 'onApprovalDecision was not reached with the right (id, decision) pair from a real click on Accept')
  root.dispose()
})

test('RESOLVE leaves both buttons disabled -- the row waits for the caller\'s own resolveApproval', async () => {
  const root = buildChat({
    title: '·', seed: 0, composerReason: null,
    onApprovalDecision: () => Promise.resolve('·'),
  })
  root.showApproval({ id: 'a3', summary: '·', decisions: ['decline', 'accept'] })
  const decline = root.querySelector('.chat-approval-decline')
  const accept = root.querySelector('.chat-approval-accept')
  accept.dispatch('click')
  await flush()
  assert.equal(accept.disabled, true, 'a resolved decision re-enabled Accept -- only reject/throw may do that')
  assert.equal(decline.disabled, true, 'a resolved decision re-enabled Decline -- only reject/throw may do that')
  const log = root.querySelector('.chat-log')
  const note = log.children.find(node => node.classList.contains('note'))
  assert.ok(note && note.textContent.includes('·'), 'the resolved sentence was not posted as a transcript note')
  /* Still there: showApproval's own decide() must never remove the row. */
  assert.ok(root.querySelector('.chat-approval-accept'), 'the row disappeared on its own -- only root.resolveApproval(id), called by the caller, may remove it')
  root.resolveApproval('a3')
  assert.equal(root.querySelector('.chat-approval-accept'), null, 'resolveApproval did not remove the row from the real DOM')
  root.dispose()
})

test('REJECT re-enables both buttons for a real retry press', async () => {
  let attempt = 0
  const root = buildChat({
    title: '·', seed: 0, composerReason: null,
    onApprovalDecision: () => { attempt += 1; return attempt === 1 ? Promise.reject(new Error('·')) : Promise.resolve('·') },
  })
  root.showApproval({ id: 'a4', summary: '·', decisions: ['decline', 'accept'] })
  const decline = root.querySelector('.chat-approval-decline')
  const accept = root.querySelector('.chat-approval-accept')
  accept.dispatch('click')
  await flush()
  assert.equal(accept.disabled, false, 'a rejected decision left Accept disabled -- a real person could never retry')
  assert.equal(decline.disabled, false, 'a rejected decision left Decline disabled -- a real person could never retry')
  const log = root.querySelector('.chat-log')
  assert.ok(log.children.some(node => node.classList.contains('note') && node.textContent.includes(APPROVAL_RETRY_HINT)),
    'the fixed retry note did not post after a rejected decision')
  /* The retry itself: a second real click, this time resolving. */
  accept.dispatch('click')
  await flush()
  assert.equal(accept.disabled, true, 'the retry press did not disable the buttons again')
  assert.equal(attempt, 2, 'the retry press did not reach onApprovalDecision a second time')
  root.dispose()
})

test('a real mount finds both buttons by data-chat-approval alone, without touching a class name', () => {
  const root = buildChat({ title: '·', seed: 0, composerReason: null, onApprovalDecision: () => Promise.resolve('·') })
  root.showApproval({ id: 'a5', summary: '·', decisions: ['decline', 'accept'] })
  assert.equal(root.querySelector('.chat-approval-label')?.textContent, APPROVAL_STRIP_LABEL,
    'the mounted strip did not use the component-owned approval label')
  assert.equal(root.querySelector('[data-chat-approval="decline"]')?.textContent, approvalDecisionWordLive('decline'),
    'a real query by data-chat-approval="decline" did not find the decline button with its real label')
  assert.equal(root.querySelector('[data-chat-approval="accept"]')?.textContent, approvalDecisionWordLive('accept'),
    'a real query by data-chat-approval="accept" did not find the accept button with its real label')
  root.dispose()
})
