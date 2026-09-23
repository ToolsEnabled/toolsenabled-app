// A CHECK THAT CANNOT FAIL IS WORTHLESS, SO THIS IS WHERE IT IS MADE TO FAIL.
//
// tools/check-composed-output.mjs measures a whole panel in one state, because
// the two screens the owner called unreadable were defective in their
// COMPOSITION and every sentence in them was individually fine. The risk with a
// check like that is the opposite of the risk with a per-string one: it is easy
// to write rules that never fire, ship them, and have a green gate that is
// measuring nothing.
//
// So every rule is driven twice here -- once against a panel built to break it,
// once against the same panel repaired -- with the panels hand-written rather
// than taken from the product, so this suite still holds the rules after the
// product's words change. The product's own matrix is measured separately, at
// the bottom, and only for whether it can be BUILT: whether it is clean is the
// gate's job and duplicating that here would only make one failure look like
// two.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPOSED_RULES,
  findingsInPanel,
  identityOf,
  readsAsEmpty,
  readsAsFailure,
} from '../lib/composed-output-rules.mjs'
import { composedPanels } from '../lib/composed-panels.mjs'

const rulesOf = panel => findingsInPanel(panel).map(finding => finding.rule)

const REFUSAL = 'Nothing was sent. ToolsEnabled talks to a background service that starts with this window; close the whole app and open it again.'

test('every rule this gate declares has a panel that trips it', () => {
  const tripped = new Set()
  const panels = [
    {
      panel: 'x', state: 'duplicate',
      slots: [
        { name: 'first', tone: 'refused', text: `Accounts unavailable. ${REFUSAL}` },
        { name: 'second', tone: 'refused', text: `Environments unavailable. ${REFUSAL}` },
      ],
      list: { name: 'the list', itemCount: 1 },
    },
    {
      panel: 'x', state: 'both-stories',
      slots: [
        { name: 'paragraph', tone: 'note', text: 'This copy does not keep one, so there is nothing here to show.' },
        { name: 'counter', tone: 'note', text: 'could not be read' },
      ],
      list: { name: 'the list', itemCount: 1 },
    },
    {
      panel: 'x', state: 'absent-list',
      slots: [{ name: 'field', tone: 'note', text: 'Which request — its number, as shown in the list' }],
      list: { name: 'the register', itemCount: 0 },
    },
  ]
  for (const panel of panels) for (const rule of rulesOf(panel)) tripped.add(rule)
  for (const rule of COMPOSED_RULES) {
    assert.ok(tripped.has(rule), `no panel in this suite trips ${rule}, so nothing proves it can fire`)
  }
})

test('one refusal in two slots is caught; the same refusal in one slot is not', () => {
  const twice = {
    panel: 'codex-cloud', state: 'refused',
    slots: [
      { name: 'the task list line', tone: 'refused', text: `Accounts unavailable. ${REFUSAL}` },
      { name: 'the environments line', tone: 'refused', text: `Environments unavailable. ${REFUSAL}` },
    ],
    list: { name: 'the task list', itemCount: 0 },
  }
  assert.ok(rulesOf(twice).includes('same-sentence-twice'), 'the duplicated paragraph was not caught')

  const once = {
    ...twice,
    slots: [
      { name: 'the task list line', tone: 'refused', text: `Your Codex accounts could not be read. ${REFUSAL}` },
      { name: 'the environments line', tone: 'note', text: '' },
    ],
  }
  assert.deepEqual(rulesOf(once), [], `a single statement of one condition must be clean: ${JSON.stringify(findingsInPanel(once))}`)
})

test('a short sentence repeated in two slots is ordinary English, not a duplicate message', () => {
  const panel = {
    panel: 'x', state: 'idiom',
    slots: [
      { name: 'one', tone: 'note', text: 'Nothing was sent.' },
      { name: 'two', tone: 'note', text: 'Nothing was sent.' },
    ],
    list: null,
  }
  assert.deepEqual(rulesOf(panel), [], 'a five-word idiom is not a duplicated paragraph')
})

test('an empty state and a failure state at once is caught, in both shapes it ships in', () => {
  const twoSlots = {
    panel: 'r-ledger', state: 'half-repaired',
    slots: [
      { name: 'the paragraph', tone: 'note', text: 'This copy does not keep one, so there is nothing here to show.' },
      { name: 'the counter', tone: 'note', text: 'could not be read' },
    ],
    list: { name: 'the register', itemCount: 0 },
  }
  assert.ok(rulesOf(twoSlots).includes('two-stories'), 'two slots disagreeing was not caught')

  /* The shape the product actually shipped: one paragraph saying there is
     nothing, painted in the colour of a failure. */
  const oneSlot = {
    panel: 'r-ledger', state: 'painted-wrong',
    slots: [{ name: 'the paragraph', tone: 'refused', text: 'This copy does not keep one, so there is nothing here to show.' }],
    list: { name: 'the register', itemCount: 0 },
  }
  assert.ok(rulesOf(oneSlot).includes('two-stories'), 'an empty sentence painted as a failure was not caught')

  const repaired = {
    ...oneSlot,
    slots: [{ name: 'the paragraph', tone: 'note', text: 'This copy does not keep one, so there is nothing here to show.' }],
  }
  assert.deepEqual(rulesOf(repaired), [], 'an honest empty state must be clean')
})

test('one sentence that says both at once is one story, not two', () => {
  const panel = {
    panel: 'x', state: 'joined',
    slots: [{ name: 'the paragraph', tone: 'refused', text: 'Your request list could not be read, so there is nothing here to show.' }],
    list: { name: 'the register', itemCount: 0 },
  }
  assert.deepEqual(rulesOf(panel), [], 'a single sentence naming a cause and its consequence is one story')
})

test('a field pointing at a list is caught when the list is empty or absent', () => {
  const field = text => ({
    panel: 'r-ledger', state: 'x',
    slots: [{ name: 'the field', tone: 'note', text }],
    list: { name: 'the register', itemCount: 0 },
  })
  for (const text of [
    'Which request — its number, as shown in the list',
    'Pick one from the list above.',
    'The environment chosen above is not one this copy may use.',
  ]) {
    assert.ok(rulesOf(field(text)).includes('points-at-an-absent-list'), `not caught: ${text}`)
  }
  const withRows = { ...field('Which request — its number, as shown in the list'), list: { name: 'the register', itemCount: 3 } }
  assert.deepEqual(rulesOf(withRows), [], 'a field may point at a list that is actually there')

  const withoutList = { ...field('Pick one from the list above.'), list: null }
  assert.ok(rulesOf(withoutList).includes('points-at-an-absent-list'), 'a field pointing at a list the panel does not show was not caught')

  const plain = field('The reference of the request you want to answer, for example R1152.')
  assert.deepEqual(rulesOf(plain), [], 'a field that says what it is must be clean')
})

test('an empty slot is not measured, so a blanked slot really is silence', () => {
  const panel = {
    panel: 'x', state: 'blanked',
    slots: [
      { name: 'the one that speaks', tone: 'refused', text: `Your Codex accounts could not be read. ${REFUSAL}` },
      { name: 'the one that does not', tone: 'refused', text: '   ' },
    ],
    list: { name: 'the task list', itemCount: 0 },
  }
  assert.deepEqual(rulesOf(panel), [], 'whitespace in a slot must not count as a second statement')
})

test('the two classifiers keep failure and emptiness apart', () => {
  assert.ok(readsAsFailure({ tone: 'refused', text: 'anything at all' }), 'a refused tone is a failure')
  assert.ok(readsAsFailure({ tone: 'note', text: 'Your list could not be read.' }), 'the words alone are enough')
  assert.ok(!readsAsFailure({ tone: 'note', text: 'One task, read as your work account.' }), 'a plain report is not a failure')
  assert.ok(readsAsEmpty({ tone: 'note', text: 'There is nothing here to show.' }), 'an empty answer is recognised')
  assert.ok(!readsAsEmpty({ tone: 'note', text: 'It could not be read, so there is nothing to show.' }), 'a cause plus its consequence is one story')
})

test('a finding’s identity is the panel, the state, the rule and the words', () => {
  const one = identityOf({ panel: 'a', state: 'b', rule: 'two-stories', excerpt: 'the  words   here' })
  const two = identityOf({ panel: 'a', state: 'b', rule: 'two-stories', excerpt: 'the words here' })
  assert.equal(one, two, 'reflowing a sentence must not mint a new identity')
})

test('the product’s own panels can be built, and every one of them says something', async () => {
  const panels = await composedPanels()
  assert.ok(panels.length >= 6, `only ${panels.length} panel states were built`)
  for (const panel of panels) {
    assert.ok(typeof panel.panel === 'string' && panel.panel, 'a panel with no name')
    assert.ok(typeof panel.state === 'string' && panel.state, `${panel.panel} has a state with no name`)
    assert.ok(typeof panel.why === 'string' && panel.why.length > 10, `${panel.panel}/${panel.state} does not say why it is in the matrix`)
    const spoken = panel.slots.filter(slot => String(slot.text || '').trim())
    assert.ok(spoken.length > 0, `${panel.panel}/${panel.state} puts no text on the screen at all`)
  }
  const names = new Set(panels.map(panel => `${panel.panel}/${panel.state}`))
  assert.equal(names.size, panels.length, 'two panel states share a name, so one of them cannot be reported')
})
