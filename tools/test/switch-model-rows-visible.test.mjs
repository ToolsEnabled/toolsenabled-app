/* R1238 -- NO PROVIDER IS SILENTLY MISSING FROM THE SWITCH DIALOG.
 *
 * OWNER, verbatim: "why cant i choose to switch models between codex or claude
 * or local or grok or gemini mid session. this was built. why does the button
 * hide now".
 *
 * WHAT WAS WRONG, measured on the assembly at 5abdbf23. The chat surface was
 * already fine: the conversation's model chip carries a running thread onto
 * another provider through the T137 continuation path, and the T158 suites drive
 * a real claude->codex switch. The circle's "Switch and continue" dialog was the
 * odd one out -- src/switch-and-continue.js switchChoices() filtered with
 * `row.provider !== 'local' && !row.treeOnly`, and every grok and gemini tier in
 * LAUNCH_TIERS carries treeOnly:true. Three of the five providers the owner
 * named were not refused, they were ABSENT, which from the outside is what "the
 * button hides" looks like.
 *
 * THE TWO THINGS THIS SUITE EXISTS TO STOP.
 *
 * 1. A row going missing again. Absence is the defect; a refusal a person can
 *    read is not. So the assertions are about presence plus a reason, never
 *    about a row NOT being drawn.
 *
 * 2. A refusal that lies. The chat route really does support continuation onto
 *    grok and gemini, and the payload really does carry a local runner
 *    (local-node-process.js exports startLocalSession AND resumeLocalSession;
 *    shell/agent-host.cjs START_TIERS contains local). A sentence here claiming
 *    those are unavailable or unsupported would be false on this build -- an
 *    earlier draft of this very file said local "has no interactive runner",
 *    inherited from a comment that had outlived the runner it described. The
 *    reason must therefore describe what THIS DIALOG does not do, and point at
 *    the route that does.
 *
 * DISPATCH IS DELIBERATELY UNCHANGED. Without a catalog answer the pickable set
 * is exactly what it was before the patch, so this adds rows to look at and
 * nothing to dispatch. Only the shell's own startableTiers answer can widen it.
 *
 * WHAT THIS SUITE CANNOT SEE: whether the dialog is reachable on screen. The
 * Actions row that opens it is gated in src/views/computers.js, which this file
 * does not own and does not assert.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { switchChoices, mountSwitchAndContinueDialog } from '../../src/switch-and-continue.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { EFFORT_CHOICES } from '../../src/fleet-tree-copy.js'

const SESSION_TIER = 'claude-sonnet'
const rowsFor = (currentTier = SESSION_TIER, options = {}) =>
  switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier, ...options }).models

/* The set the dialog could route BEFORE this patch, PINNED AS LITERALS.
   It was written as LAUNCH_TIERS.filter(t => t.provider !== 'local' && !t.treeOnly),
   which re-derives the expectation from the same table the code reads -- so a
   new tier would move the expectation with it and this case would keep passing
   while the pickable set silently grew. Builder 7's review caught that. Naming
   the seven means a new tier fails here and somebody decides on purpose. */
const PREVIOUSLY_OFFERED = ['astra', 'luna', 'terra', 'sol', 'claude-fable', 'claude-sonnet', 'claude-opus']

test('every tier in the product table gets a row -- none is dropped', () => {
  assert.deepEqual(rowsFor().map(row => row.id), LAUNCH_TIERS.map(tier => tier.id),
    'the dialog must draw the launch table in full, in the order it was handed')
})

test('each of the five providers the owner named reaches the list', () => {
  const providers = new Set(rowsFor().map(row => row.provider))
  for (const named of ['codex', 'claude', 'local', 'grok', 'gemini']) {
    assert.ok(providers.has(named), `the owner asked for ${named} and no row carries that provider`)
  }
})

test('with no catalog answer the pickable set is exactly what it was, so nothing new can be dispatched', () => {
  const pickable = rowsFor().filter(row => row.available).map(row => row.id)
  assert.deepEqual(pickable, PREVIOUSLY_OFFERED,
    'showing a row must not have made it startable; only the shell may widen this')
})

/* THE GUARD AGAINST THE MISTAKE THIS FILE HAS NOW MADE TWICE.
   First draft: local "has no interactive runner", inherited from a comment that
   had outlived the runner. Second draft: every refused row pointed at the model
   chip -- true for grok and gemini, FALSE for local, because the chip's own
   startability test falls back to `provider !== 'local'` while
   startableTierAnswered is false, which is its initial value. Both drafts read
   fine and both told a person something untrue, so this case now checks each
   refusal against the route that is actually open to THAT row. */
test('a refusal is true of the row it is attached to, and never calls the product incapable', () => {
  let chipPointed = 0, reportPointed = 0
  for (const row of rowsFor()) {
    if (row.available) {
      assert.equal(row.reason, '', `${row.id} is pickable, so it must not carry a refusal`)
      continue
    }
    assert.ok(row.reason && row.reason.trim(), `${row.id} is not pickable and must say why`)
    assert.doesNotMatch(row.reason, /unavailable|unsupported|not supported|no interactive runner/i,
      `${row.id}: this dialog not routing a tier is not the product lacking it`)
    if (row.provider === 'local') {
      reportPointed += 1
      assert.match(row.reason, /has not reported that it can start/,
        'local must not be sent to the model chip: the chip refuses it too until the shell answers')
      assert.doesNotMatch(row.reason, /model chip/,
        'pointing local at a route that also refuses it is the defect this case exists for')
    } else {
      chipPointed += 1
      assert.match(row.reason, /model chip in the conversation/,
        `${row.id} is continuable on the chip, so the refusal must name that route`)
    }
  }
  assert.ok(chipPointed > 0 && reportPointed > 0,
    'this fixture is only meaningful while both kinds of refusal are present')
})

test('the tier the circle already runs is never refused to it, whatever its provider', () => {
  for (const tier of LAUNCH_TIERS) {
    const own = rowsFor(tier.id).find(row => row.id === tier.id)
    assert.equal(own.current, true, `${tier.id} must be flagged as the current row`)
    assert.equal(own.available, true, `${tier.id} is what this circle runs, so it cannot be refused to it`)
    assert.equal(own.reason, '', `${tier.id} is the current row and must carry no refusal`)
  }
})

/* THE SHELL'S ANSWER IS THE AUTHORITY, AND ONLY THE SHELL'S. These ids stand in
   for bridge.startableTiers() resolving { ok: true, tiers: [...] }. */
test('a catalog answer decides the list, and widens it beyond the default set', () => {
  const grok = LAUNCH_TIERS.find(tier => tier.provider === 'grok')
  const answer = [SESSION_TIER, 'astra', grok.id]
  const rows = new Map(rowsFor(SESSION_TIER, { startable: answer }).map(row => [row.id, row]))
  assert.equal(rows.get(grok.id).available, true, 'a tier the shell reports startable is offered, tree-only or not')
  assert.equal(rows.get('astra').available, true)
  const dropped = LAUNCH_TIERS.find(tier => !answer.includes(tier.id) && tier.id !== SESSION_TIER)
  assert.equal(rows.get(dropped.id).available, false, 'a tier the shell left out is not offered')
  assert.match(rows.get(dropped.id).reason, /has not reported that it can start/,
    'and the reason reports the absence of a report, not an incapable product')
})

test('an empty catalog answer is authoritative, and an unanswered one gates nothing', () => {
  const empty = rowsFor(SESSION_TIER, { startable: [] })
  for (const row of empty) {
    if (row.current) continue
    assert.equal(row.available, false, `${row.id}: a valid empty list means nothing is startable`)
  }
  const unanswered = rowsFor(SESSION_TIER, { startable: ['astra'], answered: false })
  assert.deepEqual(unanswered.filter(row => row.available).map(row => row.id), PREVIOUSLY_OFFERED,
    'answered:false means nobody has asked, so the default set stands')
})

test('a tier the caller does not list is not added back', () => {
  const subset = LAUNCH_TIERS.filter(tier => tier.provider === 'claude')
  const offered = switchChoices({ accounts: [], tiers: subset, efforts: EFFORT_CHOICES, currentTier: SESSION_TIER }).models
  assert.deepEqual(offered.map(row => row.id), subset.map(tier => tier.id))
})

test('the mounted dialog disables a refused row, never checks it, and never answers with it', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const choices = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: SESSION_TIER })
    const host = dom.document.createElement('div')
    let chosen = null
    const dialog = mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: LAUNCH_TIERS,
      current: { account: 'a', provider: 'claude', tier: SESSION_TIER, effort: null },
      onChoose: value => { chosen = value } })
    assert.ok(dialog, 'the dialog mounts')

    const inputs = host.querySelectorAll('[data-switch-model]')
    assert.equal(inputs.length, LAUNCH_TIERS.length, 'every row reaches the markup, not just the pickable ones')

    const byValue = new Map(inputs.map(input => [input.value, input]))
    for (const row of choices.models) {
      const input = byValue.get(row.id)
      assert.ok(input, `${row.id} must be drawn`)
      assert.equal(input.getAttribute('data-unavailable') === 'true', !row.available,
        `${row.id}: the markup must agree with the row`)
      if (!row.available) assert.notEqual(input.checked, true, `${row.id} is refused and must never start checked`)
    }
    assert.equal(byValue.get(SESSION_TIER).getAttribute('data-unavailable'), null, 'the circle keeps its own row live')

    const blocked = choices.models.find(row => !row.available)
    assert.ok(blocked, 'this fixture is pointless unless some row is refused')
    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.ok(chosen, 'pressing Continue answers')
    assert.notEqual(chosen.tier, blocked.id, 'a refused tier is never the answer')
    assert.equal(chosen.tier, SESSION_TIER, 'with nothing else picked the circle keeps its own model')
  } finally {
    /* restore(), NOT uninstall?.(). installDomStandIn returns { document, restore }
       - there is no `uninstall`, so `dom.uninstall?.()` was optional-chaining its
       way past a method that does not exist and cleaning up nothing, in all four
       of this file's finally blocks. Every other suite in tools/test calls
       dom.restore(). W23 found it (T639 H1). Called directly rather than
       optionally, so the next contract mismatch throws instead of passing. */
    dom.restore()
  }
})

/* THE TWO CASES THE ONE ABOVE ONLY SOUNDED LIKE IT COVERED.
   Its name says "never answers with it", but every assertion in it reads the
   INITIAL mounted state, which it has already checked two lines earlier. The
   readback was never driven. These drive it. */
test('a refused row that something else CHECKS is still not the answer', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const choices = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: SESSION_TIER })
    const host = dom.document.createElement('div')
    let chosen = null
    mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: LAUNCH_TIERS,
      current: { account: 'a', provider: 'claude', tier: SESSION_TIER, effort: null },
      onChoose: value => { chosen = value } })
    const inputs = host.querySelectorAll('[data-switch-model]')
    const byValue = new Map(inputs.map(input => [input.value, input]))
    const blocked = choices.models.find(row => !row.available)
    assert.ok(blocked, 'this fixture needs a refused row')

    /* A restore-shaped write: checked set directly, no change event, exactly
       what a form restore or a "remember the last pick" feature would do. */
    byValue.get(SESSION_TIER).checked = false
    byValue.get(blocked.id).checked = true

    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.ok(chosen, 'Continue still answers')
    assert.notEqual(chosen.tier, blocked.id,
      'the dialog handed back a tier it drew as unpickable; the read must consult disabled, not just checked')
    assert.equal(chosen.tier, SESSION_TIER, 'it falls back to the model the circle already runs')
  } finally {
    dom.restore()
  }
})

/* Controller, on the dialog contract: "visible refusal and no null-tier
   dispatch; do not leave the known input case to become a production bug." */
test('with nothing startable and no current model, Continue refuses visibly instead of answering with nothing', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    /* An authoritative EMPTY catalog and a circle with no tier: no row is
       pickable and there is no current model to fall back to. */
    const choices = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: null, startable: [] })
    assert.ok(!choices.models.some(row => row.available), 'the fixture requires every row refused')
    const host = dom.document.createElement('div')
    let chosen = null, cancelled = 0
    const dialog = mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: LAUNCH_TIERS,
      current: { account: 'a', provider: null, tier: null, effort: null },
      onChoose: value => { chosen = value }, onCancel: () => { cancelled += 1 } })
    assert.ok(dialog, 'the dialog still mounts')

    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.equal(chosen, null, 'Continue must not dispatch a null tier')
    assert.equal(cancelled, 0, 'refusing is not cancelling')
    const said = host.querySelector('[data-switch-cost]').textContent
    assert.match(said, /nothing to continue on/, `the refusal must be visible and say why: ${said}`)
    assert.match(said, /Nothing has changed/, 'and it must say the conversation is untouched')
    assert.doesNotMatch(said, /unavailable|unsupported/i, 'a missing report is not an incapable product')
  } finally {
    dom.restore()
  }
})

/* THE INTERSECTION OF THE OTHER TWO, and the one I had missed. Controller:
   "Test submission after a disabled row becomes checked, with and without a
   valid current/available alternative." The case above has a valid current tier
   to fall back to, so it cannot show what happens when there is none. Here a
   refused row is checked by a restore-shaped write AND there is nothing valid
   left to fall back to -- the two states that individually produce a correct
   answer, together. Returning the refused tier would be wrong; returning null
   would be wrong; refusing is the only truthful outcome. */
test('a checked refused row with NO valid alternative returns neither that tier nor null', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const choices = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: null, startable: [] })
    const host = dom.document.createElement('div')
    let chosen = null, cancelled = 0
    mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: LAUNCH_TIERS,
      current: { account: 'a', provider: null, tier: null, effort: null },
      onChoose: value => { chosen = value }, onCancel: () => { cancelled += 1 } })

    const refused = choices.models.find(row => !row.available)
    assert.ok(refused, 'the fixture needs a refused row')
    const input = host.querySelectorAll('[data-switch-model]').find(row => row.value === refused.id)
    assert.ok(input, 'the refused row must be drawn to be checkable')
    input.checked = true

    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.equal(chosen, null,
      'with a refused row checked and nothing valid to fall back to, Continue must answer with neither that tier nor null')
    assert.equal(cancelled, 0, 'refusing is not cancelling')
    assert.match(host.querySelector('[data-switch-cost]').textContent, /nothing to continue on/,
      'and it must still say why, rather than silently doing nothing')
  } finally {
    dom.restore()
  }
})
