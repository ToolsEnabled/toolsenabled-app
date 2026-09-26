/* B26: SWITCH AND CONTINUE SAYS WHY IT OPENED, AND ONLY THAT.
 *
 * Found by hand on candidate 2: Actions > Switch and continue on a Controller
 * that had not failed opened with "This agent could not continue on its
 * account. Choose how to carry on below." That sentence was written for the
 * dialog the app opens by itself when a saved account is refused; opened by
 * hand it tells the person something false about their agent.
 *
 * The dialog is now told why it opened. Only an account failure (a refused
 * Resume, a queued send the account refused, the reopen poll's switchOffer)
 * gets the failure sentence; a person's own choice from Actions gets a plain
 * one; a caller that says nothing never claims a failure it was not told of.
 * These cases drive the real dialog through the DOM stand-in, run the view's
 * offerSwitchAndContinue in a vm context, and read every call site in the view.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { switchChoices, mountSwitchAndContinueDialog, SWITCH_OPEN_REASON } from '../../src/switch-and-continue.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { EFFORT_CHOICES, SWITCH_PANEL } from '../../src/fleet-tree-copy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const SESSION_TIER = LAUNCH_TIERS.find(tier => tier.provider === 'claude')?.id || LAUNCH_TIERS[0].id
const FAILURE = /could not continue on its account/i

const choicesFor = () => switchChoices({ accounts: [{ name: 'other', provider: 'claude', signedIn: true }], tiers: LAUNCH_TIERS,
  efforts: EFFORT_CHOICES, currentTier: SESSION_TIER })

function mount(dom, extra = {}) {
  return mountSwitchAndContinueDialog({ document: dom.document, host: dom.document.body, choices: choicesFor(), tiers: LAUNCH_TIERS,
    current: { account: 'a', provider: 'claude', tier: SESSION_TIER, effort: null }, ...extra })
}
const lead = dialog => dialog.root.querySelector('.switch-lead')?.textContent || ''

test('the two reasons are named, and the copy has a sentence for each', () => {
  assert.deepEqual({ ...SWITCH_OPEN_REASON }, { byHand: 'by-hand', accountRefused: 'account-refused' })
  assert.match(SWITCH_PANEL.opened, FAILURE, 'the failure sentence is kept for the failure route')
  assert.equal(typeof SWITCH_PANEL.openedByHand, 'string')
  assert.ok(SWITCH_PANEL.openedByHand.length > 0)
  assert.doesNotMatch(SWITCH_PANEL.openedByHand, /could not|failed|refused|limit/i, 'the by-hand sentence claims no failure')
})

test('opened by hand, the dialog does not say the agent could not continue', () => {
  const dom = installDomStandIn(globalThis)
  try {
    const dialog = mount(dom, { reason: SWITCH_OPEN_REASON.byHand })
    assert.ok(dialog, 'the dialog mounts')
    assert.doesNotMatch(dialog.root.textContent, FAILURE, 'THE DEFECT: a dialog the person opened says their agent failed')
    assert.equal(lead(dialog), SWITCH_PANEL.openedByHand)
    assert.equal(dialog.root.querySelector('[data-switch-why]'), null, 'no refusal line on a dialog nothing refused')
    dialog.close()
  } finally { dom.restore() }
})

test('opened by an account failure, the dialog says so and shows the refusal', () => {
  const dom = installDomStandIn(globalThis)
  try {
    const dialog = mount(dom, { reason: SWITCH_OPEN_REASON.accountRefused, refusalSentence: 'This account reached its limit.' })
    assert.equal(lead(dialog), SWITCH_PANEL.opened)
    assert.equal(dialog.root.querySelector('[data-switch-why]').textContent, 'This account reached its limit.')
    dialog.close()
  } finally { dom.restore() }
})

test('a caller that gives no reason gets the plain sentence, never an invented failure', () => {
  const dom = installDomStandIn(globalThis)
  try {
    for (const reason of [undefined, '', 'something-else']) {
      const dialog = mount(dom, reason === undefined ? {} : { reason })
      assert.equal(lead(dialog), SWITCH_PANEL.openedByHand, `reason ${JSON.stringify(reason)}`)
      dialog.close()
    }
  } finally { dom.restore() }
})

test('an older copy object without the by-hand sentence still reads', () => {
  const dom = installDomStandIn(globalThis)
  try {
    const { openedByHand, ...older } = SWITCH_PANEL
    assert.ok(openedByHand)
    const dialog = mount(dom, { copy: older, reason: SWITCH_OPEN_REASON.byHand })
    assert.equal(lead(dialog), SWITCH_PANEL.openedByHand)
    assert.doesNotMatch(dialog.root.textContent, /undefined/)
    dialog.close()
  } finally { dom.restore() }
})

/* THE VIEW PASSES ITS REASON THROUGH. offerSwitchAndContinue is run in a vm
   context with a recording mount, the way switch-and-continue-target-chat
   drives it. */
function callerFixture() {
  const source = fs.readFileSync(path.join(SRC, 'views/computers.js'), 'utf8')
  const mounted = []
  const node = { id: 'node-1', sessionId: 'session-1', tier: 'claude-sonnet', role: 'worker', effort: '' }
  const context = vm.createContext({
    destroyed: false, document: { body: {} }, window: {}, mockSource: () => false, treeStore: { getNode: id => (id === node.id ? node : null) },
    transcriptStore: { get: () => ({ account: 'a', provider: 'claude', effort: 'medium', lines: [] }) },
    switchDialogs: new Map(), loadAccounts: async () => ({ accounts: [] }), readStartableTiers: async () => ({ answered: true, tiers: ['claude-sonnet'] }),
    setOrgStatus: () => {}, LAUNCH_TIERS: [{ id: 'claude-sonnet', label: 'Claude Sonnet', provider: 'claude' }], EFFORT_CHOICES: [],
    savedSessionEffort: () => 'medium', sessionEfforts: new Map(), tierEffortOf: () => 'medium',
    switchChoices: () => ({ accounts: [], models: [], efforts: [] }), SWITCH_PANEL,
    mountSwitchAndContinueDialog: options => { mounted.push(options); return { options, dispose() { options.onClose?.() }, markStale() { return true } } },
    nodeBusy: () => false, pendingModelChoice: () => null, queueModelChoice: () => {}, continueNodeWithChoice: async () => true,
    statusSink: () => ({}), treeNodeName: n => n.id, roleLabel: role => role, roleDisplayFor: role => role,
    registerNodeStatusListener: () => () => {},
  })
  vm.runInContext(declaredFunctionSource(source, 'offerSwitchAndContinue'), context)
  return { mounted, context, node }
}

test('offerSwitchAndContinue hands the dialog the reason it was given', async () => {
  for (const reason of [SWITCH_OPEN_REASON.byHand, SWITCH_OPEN_REASON.accountRefused]) {
    const f = callerFixture()
    const dialog = await f.context.offerSwitchAndContinue(f.node, { reason, sentence: '', refusedAccount: null })
    assert.ok(dialog)
    assert.equal(f.mounted.length, 1)
    assert.equal(f.mounted[0].reason, reason)
    dialog.dispose()
  }
})

/* EVERY CALLER SAYS WHY. The Actions row is the person's own choice; the other
   three open on an account refusal (the Resume press after keep-trying gave
   up, the Resume press itself, and the recovery coordinator's switchOffer). */
test('every call site in the view passes its reason explicitly', () => {
  const source = fs.readFileSync(path.join(SRC, 'views/computers.js'), 'utf8')
  const calls = [...source.matchAll(/offerSwitchAndContinue\(([^\n]*)\)/g)]
    .filter(match => !/async function offerSwitchAndContinue\(/.test(source.slice(match.index - 15, match.index + 30)))
    .map(match => match[1])
  assert.equal(calls.length, 4, 'the view opens the dialog from four places: ' + JSON.stringify(calls))
  for (const args of calls) assert.match(args, /reason: SWITCH_OPEN_REASON\.(byHand|accountRefused)/, 'no reason given: ' + args)
  const byHand = calls.filter(args => /SWITCH_OPEN_REASON\.byHand/.test(args))
  assert.equal(byHand.length, 1, 'one by-hand route: Actions > Switch and continue')
  assert.match(byHand[0], /^fresh\(\), \{ reason: SWITCH_OPEN_REASON\.byHand, refusedAccount: null \}$/)
  for (const args of calls.filter(args => !byHand.includes(args))) {
    assert.match(args, /reason: SWITCH_OPEN_REASON\.accountRefused, sentence: /, 'a failure route carries its refusal sentence')
  }
  const palette = source.slice(source.indexOf("{ id: 'switch-continue', group: agent"), source.indexOf("{ id: 'child', group: agent"))
  assert.match(palette, /offerSwitchAndContinue\(fresh\(\), \{ reason: SWITCH_OPEN_REASON\.byHand/, 'the Actions row is the by-hand route')
  const offer = declaredFunctionSource(source, 'offerSwitchAndContinue')
  assert.match(offer, /\{ reason = '', sentence = '', refusedAccount = null \} = \{\}/, 'the opener takes the reason')
  assert.match(offer, /mountSwitchAndContinueDialog\(\{ document, host, reason, refusalSentence: sentence,/, 'and hands it to the dialog')
})
