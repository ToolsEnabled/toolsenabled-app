/* CHOOSING WHICH OF YOUR COMPUTERS YOU ARE DRIVING, FROM INSIDE THE PRODUCT.
 *
 * THE RULING (owner, 2026-08-23, on two screenshots): "rather than selecting
 * what computer they drive here (1) it should be added here (2) to page2 and
 * either machine should be driveable once connected." (1) was the account
 * page's per-computer rows; (2) was the computers page's tab bar.
 *
 * THE TWO AXES THIS SUITE EXISTS TO KEEP APART. The computers page has had a
 * tab bar since long before this feature, and its tabs are the computers listed
 * inside the fleet record of ONE machine — pressing one re-mounts a graph and
 * reaches nothing new. The new chips are whole MACHINES on the account, each
 * behind its own connection, and pressing one changes where every reading on
 * every screen comes from. Same bar, same shape, different kind of thing. Every
 * case below says which axis it is about.
 *
 * WHAT IS TESTED HERE AND WHAT IS PINNED. src/machine-tabs.js holds every
 * decision and no document, so the decisions are CALLED WITH VALUES: which
 * computers are listed, which is marked, what a press does, what a refusal
 * says, and which groups the bar draws. src/views/computers.js is a DOM module
 * the size of a small program, so the handful of things it must do with those
 * answers are pinned against its source — the same split
 * tools/test/computers-account-door.test.mjs uses on the same file.
 *
 * THE HOST BRIDGE IS STUBBED, and the stubs answer in the shapes
 * `website/public/host-bridge.js` really returns. That file is another
 * repository's and is not edited by this lane; the shapes were read off it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MACHINE_TAB_NEVER_FINISHED,
  MACHINE_TAB_NOT_ASKED,
  MACHINE_TAB_NOT_CHECKED,
  MACHINE_TAB_NOT_CHOSEN,
  MACHINE_TAB_NOT_PUT_BACK,
  MACHINE_TAB_NO_BRIDGE,
  MACHINE_TAB_PARTNER_REMOVED,
  MACHINE_TAB_STILL_FINISHING,
  driveMachineTab,
  machineTabRows,
  machineTabStaysOn,
  machineTabTrouble,
  machineTabsBar,
  machineTabsBridge,
  readMachineTabs,
} from '../../src/machine-tabs.js'
import { IDENTIFIER_RE } from '../../src/refusal-copy.js'

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

/* ---------------------------------------------------------------
   The account, in the shapes host-bridge really answers with.
   --------------------------------------------------------------- */

/** A two-way connection: two computers joined to each other, either drivable. */
const DESK_AND_LAPTOP = {
  relayPairId: 'pair-1',
  connectedAtMs: 1,
  solo: false,
  connected: true,
  machines: [
    { pairId: 'device-desk', name: 'My Windows computer', collection: 'collected', chosen: false },
    { pairId: 'device-laptop', name: 'Studio Mac', collection: 'collected', chosen: false },
  ],
}

/** One computer on its own, which is a connection too. */
const RIG = {
  relayPairId: 'pair-2',
  connectedAtMs: 2,
  solo: true,
  connected: true,
  machines: [{ pairId: 'device-rig', name: 'Relay Rig', collection: 'collected', chosen: false }],
}

const listing = (...pairs) => ({ ok: true, chosen: null, machines: pairs })

/**
 * A stand-in for `window`, holding a stand-in for the site's account bridge.
 * Hand-rolled rather than a DOM library, the way this repo's other suites do
 * it: what is under test is four method calls wide.
 */
function scopeWith(bridge) {
  return { mcAccount: bridge }
}

/** The bridge, plus a written record of every call made to it. */
function stubBridge({
  machines = async () => listing(DESK_AND_LAPTOP, RIG),
  machineInUse,
  checkMachine,
  chooseMachine,
  forgetMachine,
} = {}) {
  const calls = { chose: [], checked: [], forgot: 0 }
  const bridge = {
    machines,
    chooseMachine: async (input) => {
      calls.chose.push(input)
      return chooseMachine ? chooseMachine(input) : { ok: true, ...input }
    },
  }
  if (machineInUse) bridge.machineInUse = machineInUse
  if (checkMachine) {
    bridge.checkMachine = async (relayPairId, devicePairId) => {
      calls.checked.push({ relayPairId, devicePairId })
      return checkMachine(relayPairId, devicePairId)
    }
  }
  bridge.forgetMachine = async () => {
    calls.forgot += 1
    return forgetMachine ? forgetMachine() : { ok: true }
  }
  return { bridge, calls }
}

const pointedAt = (relayPairId, devicePairId) => async () => ({ ok: true, relayPairId, devicePairId })

/* ---------------------------------------------------------------
   1 · WHICH COMPUTERS ARE LISTED  (the account axis)
   --------------------------------------------------------------- */

test('the bar lists every computer connected to the account, under the account’s own name for it', async () => {
  const { bridge } = stubBridge({ machineInUse: pointedAt('pair-1', 'device-desk') })
  const answer = await readMachineTabs(scopeWith(bridge))

  assert.equal(answer.ok, true)
  assert.deepEqual(answer.rows.map(row => row.name), ['My Windows computer', 'Studio Mac', 'Relay Rig'],
    'a computer on the account is missing from the bar, or is being called something the account did not call it')
  assert.deepEqual(answer.rows.map(row => [row.relayPairId, row.devicePairId]), [
    ['pair-1', 'device-desk'],
    ['pair-1', 'device-laptop'],
    ['pair-2', 'device-rig'],
  ], 'a row carries ids that are not its own computer’s, so a press would drive the wrong machine')
})

test('BOTH halves of one connection are listed, which is the owner’s ruling in a sentence', () => {
  const rows = machineTabRows(listing(DESK_AND_LAPTOP))
  assert.equal(rows.length, 2,
    'only one computer of a two-way connection is offered — "If there\'s two we need to serve both in the interface and both need to be controllable"')
  assert.ok(rows.every(row => row.trouble === null), 'a connected computer is being refused before anybody presses it')
})

test('which computer is being driven is the BRIDGE’s answer, not this file’s arithmetic', async () => {
  /* The distinction is load-bearing: a person with one connected computer has
     CHOSEN nothing and is driving it all the same, because the transport
     resolves a single candidate on its own. Working the mark out from the
     stored choice would leave that person's only computer unmarked. */
  const { bridge } = stubBridge({
    machines: async () => listing(RIG),
    machineInUse: pointedAt('pair-2', 'device-rig'),
  })
  const answer = await readMachineTabs(scopeWith(bridge))
  assert.deepEqual(answer.rows.map(row => row.driving), [true],
    'the only computer on the account is drawn as though nobody were driving it')
})

test('exactly one chip is marked, and it is the half the bridge named — never its partner', async () => {
  const { bridge } = stubBridge({ machineInUse: pointedAt('pair-1', 'device-laptop') })
  const answer = await readMachineTabs(scopeWith(bridge))
  assert.deepEqual(answer.rows.map(row => `${row.name}:${row.driving}`), [
    'My Windows computer:false',
    'Studio Mac:true',
    'Relay Rig:false',
  ], 'the mark landed on the wrong half of a connection, which is a different computer')
})

test('a bridge that cannot say which computer is in use falls back to the account’s own flag', async () => {
  const chosenLaptop = {
    ...DESK_AND_LAPTOP,
    machines: [
      { ...DESK_AND_LAPTOP.machines[0], chosen: false },
      { ...DESK_AND_LAPTOP.machines[1], chosen: true },
    ],
  }
  const { bridge } = stubBridge({ machines: async () => listing(chosenLaptop) })
  const answer = await readMachineTabs(scopeWith(bridge))
  assert.deepEqual(answer.rows.map(row => row.driving), [false, true])
})

test('a half-answer marks nothing rather than marking a whole connection', () => {
  /* A connection named with no computer named inside it. Both ids have to
     agree, because the other half of the same connection is a different
     computer, and lighting both chips would say this browser is driving two. */
  const rows = machineTabRows(listing(DESK_AND_LAPTOP), { relayPairId: 'pair-1', devicePairId: null })
  assert.deepEqual(rows.map(row => row.driving), [false, false])
})

test('a computer the account has no name for is not drawn as a computer', () => {
  /* The connection keeps its row after a machine is removed from the account,
     and the half comes back with a null name. Inventing one is barred; drawing
     a chip that can only ever answer with a sentence is a control that cannot
     succeed. The SURVIVING computer is still listed, and its own row is what
     says the connection is over. */
  const halfGone = {
    ...DESK_AND_LAPTOP,
    connected: false,
    machines: [
      { pairId: 'device-desk', name: 'My Windows computer', collection: 'collected', chosen: false },
      { pairId: 'device-laptop', name: null, collection: 'unread', chosen: false },
    ],
  }
  const rows = machineTabRows(listing(halfGone))
  assert.deepEqual(rows.map(row => row.name), ['My Windows computer'])
  assert.equal(rows[0].trouble, MACHINE_TAB_PARTNER_REMOVED,
    'the surviving computer is offered as though its connection still carried something')
})

test('a refusal, an absence, or a shape this does not know produces no computers at all', async () => {
  for (const nothing of [
    undefined,
    null,
    {},
    { ok: false, code: 'MC_MACHINES_NO_SESSION', reason: 'Nobody is signed in.' },
    { ok: true },
    { ok: true, machines: null },
    { ok: true, machines: [{ relayPairId: '', machines: [{ pairId: 'x', name: 'X' }] }] },
    { ok: true, machines: [{ relayPairId: 'p', machines: [{ pairId: '', name: 'X' }] }] },
  ]) {
    assert.deepEqual(machineTabRows(nothing), [],
      `machineTabRows(${JSON.stringify(nothing)}) turned a failure into a computer`)
  }
})

test('the two states the account calls trouble are named, and every other reading is left alone', () => {
  assert.equal(machineTabTrouble({ connected: true }, { collection: 'never-collected' }), MACHINE_TAB_NEVER_FINISHED)
  assert.equal(machineTabTrouble({ connected: true }, { collection: 'waiting' }), MACHINE_TAB_STILL_FINISHING)
  assert.equal(machineTabTrouble({ connected: true }, { collection: 'uncollected' }), MACHINE_TAB_STILL_FINISHING)
  assert.equal(machineTabTrouble({ connected: false }, { collection: 'collected' }), MACHINE_TAB_PARTNER_REMOVED)
  /* 'unread' is us failing to read the account's device list. That is a fact
     about us and never grounds for telling somebody their computer is broken,
     so the computer stays offered. Same for a word a later version invents. */
  for (const said of ['collected', 'unread', 'something-new', undefined]) {
    assert.equal(machineTabTrouble({ connected: true }, { collection: said }), null,
      `a computer was withdrawn from the bar over a collection reading of ${String(said)}`)
  }
})

/* ---------------------------------------------------------------
   2 · WHAT A PRESS DOES  (the account axis)
   --------------------------------------------------------------- */

test('pressing a computer chooses THAT computer, by its own two ids', async () => {
  const { bridge, calls } = stubBridge({
    machineInUse: pointedAt('pair-1', 'device-desk'),
    checkMachine: async () => ({ ok: true, answering: true }),
  })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows
  const laptop = rows.find(row => row.name === 'Studio Mac')

  const result = await driveMachineTab(scope, laptop, { previous: rows.find(row => row.driving) })

  assert.equal(result.ok, true, result.sentence)
  assert.deepEqual(calls.chose, [{ relayPairId: 'pair-1', devicePairId: 'device-laptop' }],
    'the press did not name the computer it was on, so the browser would drive whichever half the server picks')
  assert.deepEqual(calls.checked, [{ relayPairId: 'pair-1', devicePairId: 'device-laptop' }],
    'the page would have been re-read from a computer nobody had asked whether it was awake')
})

test('a computer the account already said cannot be driven is refused before anything is called', async () => {
  const stalled = {
    ...RIG,
    machines: [{ pairId: 'device-rig', name: 'Relay Rig', collection: 'never-collected', chosen: false }],
  }
  const { bridge, calls } = stubBridge({ machines: async () => listing(stalled) })
  const scope = scopeWith(bridge)
  const row = (await readMachineTabs(scope)).rows[0]

  const result = await driveMachineTab(scope, row, { previous: null })
  assert.equal(result.ok, false)
  assert.equal(result.sentence, MACHINE_TAB_NEVER_FINISHED)
  assert.deepEqual(calls.chose, [],
    'the press spent a connection and eight seconds to come back with "your computer did not answer" about a computer that is sitting there switched on')
})

test('a refused choice is forwarded in the bridge’s own words, and nothing on the page moves', async () => {
  const { bridge, calls } = stubBridge({
    machineInUse: pointedAt('pair-2', 'device-rig'),
    chooseMachine: async () => ({
      ok: false,
      code: 'MC_MACHINE_CHOICE_UNSTORABLE',
      reason: 'This browser will not let the page remember anything, so the choice cannot be kept even for this tab.',
    }),
    checkMachine: async () => ({ ok: true, answering: true }),
  })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows

  const result = await driveMachineTab(scope, rows[0], { previous: rows.find(row => row.driving) })
  assert.equal(result.ok, false, 'a refused choice was reported as a successful one')
  assert.match(result.sentence, /will not let the page remember anything/,
    'the bridge’s own sentence was paraphrased away, so the page explains the wrong problem')
  assert.deepEqual(calls.checked, [], 'a computer nobody managed to choose was asked whether it is awake')
})

test('a desk-only bridge remedy tells the browser reader to act on the driven computer', async () => {
  const deskRemedy = 'Nothing was sent. The permission this window holds is no longer being accepted; close ToolsEnabled and open it again to get a fresh one.'
  const { bridge } = stubBridge({
    chooseMachine: async () => ({ ok: false, reason: deskRemedy }),
  })

  const result = await driveMachineTab(scopeWith(bridge), {
    relayPairId: 'pair-1',
    devicePairId: 'device-laptop',
  })

  assert.equal(result.ok, false)
  assert.match(result.sentence, /that computer’s window/,
    'the bridge fact named the browser window instead of the driven computer’s window')
  assert.match(result.sentence, /On that computer, close ToolsEnabled/,
    'the browser reader was told to restart ToolsEnabled on the machine in front of them')
  assert.notEqual(result.sentence, deskRemedy,
    'the call site omitted its relay context, so the desk-only remedy passed through byte for byte')
})

test('a computer that does not answer leaves the person on the one they were driving, and says both halves', async () => {
  const { bridge, calls } = stubBridge({
    machineInUse: pointedAt('pair-1', 'device-desk'),
    checkMachine: async () => ({
      ok: false,
      code: 'MC_MACHINE_SILENT',
      reason: 'That computer did not answer. ToolsEnabled has to be open on it before this browser can reach it.',
    }),
  })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows
  const previous = rows.find(row => row.driving)

  const result = await driveMachineTab(scope, rows.find(row => row.name === 'Relay Rig'), { previous })

  assert.equal(result.ok, false, 'the page was about to re-read itself from a computer that never answered')
  assert.match(result.sentence, /did not answer/, 'the reason the machine could not be reached is gone')
  assert.match(result.sentence, /still driving My Windows computer/,
    'the sentence does not say where the person is now, which is the one thing they need')
  assert.deepEqual(calls.chose, [
    { relayPairId: 'pair-2', devicePairId: 'device-rig' },
    { relayPairId: 'pair-1', devicePairId: 'device-desk' },
  ], 'the choice was left pointing at the silent computer, so every screen after this would be read from it')
})

test('with nobody to go back to, the silent computer is unchosen rather than left in place', async () => {
  const { bridge, calls } = stubBridge({
    machines: async () => listing(RIG),
    checkMachine: async () => ({ ok: false, code: 'MC_MACHINE_SILENT', reason: 'That computer did not answer.' }),
  })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows

  const result = await driveMachineTab(scope, rows[0], { previous: null })
  assert.equal(result.ok, false)
  assert.equal(calls.forgot, 1, 'a computer that could not be reached stayed chosen')
  assert.equal(result.sentence, `That computer did not answer. ${machineTabStaysOn(null)}`)
})

test('a failure to put the person back is said out loud rather than reported as a return', async () => {
  let presses = 0
  const { bridge } = stubBridge({
    machineInUse: pointedAt('pair-1', 'device-desk'),
    chooseMachine: async () => {
      presses += 1
      return presses === 1 ? { ok: true } : { ok: false, reason: 'The connected computers could not be read right now.' }
    },
    checkMachine: async () => ({ ok: false, reason: 'That computer did not answer.' }),
  })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows

  const result = await driveMachineTab(scope, rows.find(row => row.name === 'Relay Rig'), {
    previous: rows.find(row => row.driving),
  })
  assert.equal(result.ok, false)
  assert.equal(result.sentence, `That computer did not answer. ${MACHINE_TAB_NOT_PUT_BACK}`)
})

test('a host that cannot ask whether a computer is awake does not lose the press', async () => {
  /* checkMachine is a question, not a permission. A bridge without it is an
     older or a smaller one, and refusing the press there would take away a
     control that works; the page's own read then finds out, exactly as it did
     before any of this existed. */
  const { bridge, calls } = stubBridge({ machineInUse: pointedAt('pair-1', 'device-desk') })
  const scope = scopeWith(bridge)
  const rows = (await readMachineTabs(scope)).rows

  const result = await driveMachineTab(scope, rows.find(row => row.name === 'Relay Rig'), {
    previous: rows.find(row => row.driving),
  })
  assert.equal(result.ok, true, result.sentence)
  assert.equal(result.verified, false, 'an absent liveness verb was reported as a verified answer')
  assert.equal(result.sentence, MACHINE_TAB_NOT_CHECKED, 'the unknown liveness state was silently cleared')
  assert.equal(calls.chose.length, 1, 'the choice was made and then undone by a check that does not exist here')
})

test('a press with no bridge behind it says so and names the way to do it anyway', async () => {
  const result = await driveMachineTab({}, { relayPairId: 'p', devicePairId: 'd' })
  assert.equal(result.ok, false)
  assert.equal(result.sentence, MACHINE_TAB_NO_BRIDGE)
})

/* ---------------------------------------------------------------
   3 · WHAT THE BAR DRAWS  —  and the two cases that must not change
   --------------------------------------------------------------- */

test('THE DESKTOP AND THE SIGNED-OUT EXAMPLE: with no account computers the bar is the record’s tabs, exactly as before', () => {
  for (const recordCount of [0, 1, 2, 9]) {
    const bar = machineTabsBar([], recordCount)
    assert.deepEqual(bar.machines, [], `an account chip appeared on a page with no account, at ${recordCount} record computers`)
    assert.equal(bar.separator, false, 'a divider appeared in a bar with one kind of chip in it')
    assert.equal(bar.record, true,
      `the record’s own tabs stopped being drawn at ${recordCount} record computers, which is the bar the desktop and the example have always had`)
  }
  /* And the same for a list this cannot read at all: absence is the desktop
     answer, not an error state with a different bar. */
  for (const nothing of [undefined, null, 'rows']) {
    assert.equal(machineTabsBar(nothing, 1).record, true)
    assert.deepEqual(machineTabsBar(nothing, 1).machines, [])
  }
})

test('THE DESKTOP has no account bridge to ask, and nothing is asked of it', async () => {
  /* The installed application's preload exposes mcAccount too — sign-in lives
     on it — and it has never carried the website's connection questions. A
     partial bridge is not a bridge, the rule src/account-state.js states. */
  const desktopish = { current: async () => ({}), signIn: async () => ({}), getSetting: async () => ({}) }
  assert.equal(machineTabsBridge(scopeWith(desktopish)), null)
  assert.equal(machineTabsBridge({}), null)
  assert.equal(machineTabsBridge(scopeWith({ machines: async () => listing(RIG) })), null,
    'a host that can list computers but cannot be told which to drive would draw a bar of controls that refuse')
  assert.deepEqual((await readMachineTabs(scopeWith(desktopish))).rows, [])
  assert.deepEqual((await readMachineTabs({})).rows, [])
})

test('SIGNED OUT: the account refuses the list, and the bar is left as it was', async () => {
  const { bridge } = stubBridge({
    machines: async () => ({ ok: false, code: 'MC_MACHINES_NO_SESSION', reason: 'Nobody is signed in.' }),
  })
  const answer = await readMachineTabs(scopeWith(bridge))
  assert.equal(answer.ok, false)
  assert.deepEqual(answer.rows, [], 'a signed-out browser was given chips for computers it cannot reach')
  assert.equal(machineTabsBar(answer.rows, 1).record, true)
})

test('an account bridge that throws is the same answer as one that is not there', async () => {
  const answer = await readMachineTabs(scopeWith({
    machines: async () => { throw new Error('the account service could not be reached') },
    chooseMachine: async () => ({ ok: true }),
  }))
  assert.deepEqual(answer.rows, [])
})

test('with account computers, one record computer is not drawn a second time under a second name', () => {
  const rows = machineTabRows(listing(DESK_AND_LAPTOP))
  for (const recordCount of [0, 1]) {
    const bar = machineTabsBar(rows, recordCount)
    assert.equal(bar.machines.length, 2)
    assert.equal(bar.record, false,
      'the machine being driven is drawn twice — once under the account’s name for it and once as "This computer", while the person is somewhere else')
    assert.equal(bar.separator, false, 'a divider was drawn with nothing on the other side of it')
  }
})

test('a record that really holds several computers keeps its own tabs, with a hairline between the two kinds', () => {
  const bar = machineTabsBar(machineTabRows(listing(DESK_AND_LAPTOP)), 3)
  assert.equal(bar.record, true, 'a real fleet host’s computers vanished from the page when the account bar appeared')
  assert.equal(bar.separator, true, 'two kinds of chip run together with nothing between them')
})

/* ---------------------------------------------------------------
   4 · THE WORDS
   --------------------------------------------------------------- */

const EMBEDDED_IDENTIFIER = new RegExp(IDENTIFIER_RE.source.replace(/^\^/, '\\b').replace(/\$$/, '\\b'), 'g')
const ACTION = /\b(open|connect|remove|add|pick|press|reload|try|sign)\b/i

test('every sentence this bar can say is plain, and every one of them ends somewhere', () => {
  const sentences = {
    MACHINE_TAB_PARTNER_REMOVED,
    MACHINE_TAB_NEVER_FINISHED,
    MACHINE_TAB_STILL_FINISHING,
    MACHINE_TAB_NO_BRIDGE,
    MACHINE_TAB_NOT_CHOSEN,
    MACHINE_TAB_NOT_ASKED,
    MACHINE_TAB_NOT_PUT_BACK,
    STAYS_ON_NOBODY: machineTabStaysOn(null),
    STAYS_ON_PREVIOUS: machineTabStaysOn({ name: 'Relay Rig' }),
  }
  for (const [label, text] of Object.entries(sentences)) {
    assert.equal(typeof text, 'string')
    assert.ok(text.trim().length > 0, `${label} says nothing; absence is not a message`)
    assert.deepEqual(text.match(EMBEDDED_IDENTIFIER) || [], [],
      `${label} hands a person a machine code instead of a sentence`)
    assert.doesNotMatch(text, /unsafe/i, `${label} calls something unsafe`)
    for (const clause of text.split(/(?<=[.!?])\s+/)) {
      const words = clause.trim().split(/\s+/).filter(Boolean).length
      assert.ok(words <= 25, `${label} has a ${words}-word sentence: "${clause.trim()}"`)
    }
  }
  /* The three a person meets by pressing a chip that cannot work each have to
     name the control that makes it possible again. The one exception is the
     line that only reports where they are standing, which is not a failure. */
  for (const label of ['MACHINE_TAB_PARTNER_REMOVED', 'MACHINE_TAB_NEVER_FINISHED', 'MACHINE_TAB_STILL_FINISHING',
    'MACHINE_TAB_NO_BRIDGE', 'MACHINE_TAB_NOT_CHOSEN', 'MACHINE_TAB_NOT_ASKED', 'MACHINE_TAB_NOT_PUT_BACK',
    'STAYS_ON_NOBODY']) {
    assert.match(sentences[label], ACTION, `${label} reports a failure and names nothing the reader can do`)
  }
  /* The two account-page sentences name the page the other door is on, because
     that is where a removed or unfinished computer is put right. */
  for (const text of [MACHINE_TAB_PARTNER_REMOVED, MACHINE_TAB_NEVER_FINISHED]) {
    assert.match(text, /account page/, 'the remedy does not say which page it is on')
  }
})

/* ---------------------------------------------------------------
   5 · WHAT THE VIEW DOES WITH THE ANSWERS  (pinned against its source)
   --------------------------------------------------------------- */

/* THIS TEST USED TO SAY "THE RELAY ONLY", AND THAT WAS ONE STATE TOO STRICT.
 *
 * It pinned loadMachineChoices to refuse anything that was not the relay, and
 * mountMockFleet to clear the bar unconditionally. Both were right about the
 * badge and wrong about one state: signed in, two computers connected, NEITHER
 * ONE CHOSEN. The host will not guess between them, so it hands back no
 * transport, so the page resolves to the example -- and the bar whose whole job
 * is choosing a computer was the one control missing from the only screen where
 * it was needed. The first choice had to be made on the account page, which is
 * the second path the owner asked us to remove.
 *
 * The badge is about READINGS -- your org, your runs, your machine's sign-in
 * state, drawn as an example and so half true. A list of your own computers'
 * names is not a reading; it is the door out, and the account page already
 * shows you those names. So the rule is now "the relay, or the one example
 * state that is a question", written once as machineChoicesBelongHere(), and
 * every other real source still clears exactly as it did. */
test('the bar is read on the relay, and in the one example state that is a question', () => {
  const load = VIEW.slice(VIEW.indexOf('async function loadMachineChoices'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('async function loadMachineChoices')))
  assert.ok(load.length > 0, 'loadMachineChoices is gone from the view')
  assert.match(load, /machineChoicesBelongHere\(\)/,
    'the loader decides for itself again instead of asking the one rule')
  assert.match(load, /machineChoices = \[\]/, 'a source the bar does not belong on keeps whatever the last one left in it')

  const rule = VIEW.slice(VIEW.indexOf('function machineChoicesBelongHere'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('function machineChoicesBelongHere')))
  assert.ok(rule.length > 0, 'machineChoicesBelongHere is gone from the view')
  assert.match(rule, /currentDataSource\(\) === 'relay'/, 'the relay is no longer a place the bar belongs')
  assert.match(rule, /NO_MACHINE_CHOSEN/,
    'the bar no longer appears when the only reason this is the example is that nobody has picked a computer')

  const example = VIEW.slice(VIEW.indexOf('function mountMockFleet'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('function mountMockFleet')))
  assert.ok(example.length > 0, 'mountMockFleet is gone from the view')
  assert.match(example, /if \(!machineChoicesBelongHere\(\)\)/,
    'the example mount clears the bar without asking whether this is the state where it is the way out')
  assert.match(example, /machineChoices = \[\]/,
    'an ordinary example mount no longer clears the account’s computers, so real machine names ride into the badged screen')
  assert.match(example, /setMachineNote\(''\)/,
    'a sentence about a real computer survives into the example')
})

test('only ONE code opens the bar on the example, and it is the one that means "ask them"', () => {
  const rule = VIEW.slice(VIEW.indexOf('function machineChoicesBelongHere'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('function machineChoicesBelongHere')))
  /* Every other reason the host gives for the example is a statement, not a
     question -- the machine is asleep, the tab was displaced, the relay is
     unreachable. Drawing a chooser over any of those would offer a control that
     cannot help. Only "nobody has said which one" is answerable from here. */
  /* The rule compares against the IMPORTED constant, not a literal, so this
     checks both ends: exactly one code is named here, and the constant it names
     really does carry the code the bridge publishes. Checking only the first
     would pass while the constant quietly meant something else. */
  const named = rule.match(/\b(NO_MACHINE_CHOSEN|MC_[A-Z_]+)\b/g) || []
  assert.equal(named.length, 1,
    `the rule names ${named.length} host codes, not one: ${named.join(', ')}`)
  assert.equal(named[0], 'NO_MACHINE_CHOSEN',
    'the bar opens on the example for a code other than the one that means "ask them"')
  const dataSource = readFileSync(new URL('../../src/data-source.js', import.meta.url), 'utf8')
  assert.match(dataSource, /export const NO_MACHINE_CHOSEN = 'MC_NO_MACHINE_CHOSEN'/,
    'the constant the rule trusts no longer carries the host code the bridge actually publishes')
})

test('the view re-reads the page only after the other machine has answered', () => {
  const drive = VIEW.slice(VIEW.indexOf('async function driveMachine('),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('async function driveMachine(')))
  assert.ok(drive.length > 0, 'driveMachine is gone from the view')
  const refused = drive.indexOf('if (!result.ok)')
  const remount = drive.indexOf('mountRealSource()')
  assert.ok(refused > 0 && remount > refused,
    'the page re-mounts before the refusal is looked at, so a press that could not reach a computer empties the screen anyway')
  assert.match(drive, /setMachineNote\(result\.sentence\)/, 'a refused press says nothing at all')
})

test('the bar survives a machine that stops answering, because it is the way off that machine', () => {
  const empty = VIEW.slice(VIEW.indexOf('function showProjectionUnavailable'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('function showProjectionUnavailable')))
  assert.ok(empty.length > 0, 'showProjectionUnavailable is gone from the view')
  assert.doesNotMatch(empty, /tabsElement\.innerHTML = ''/,
    'the one row of controls that could point somebody at their other computer is wiped on the screen they land on when the first one goes quiet')
  assert.match(empty, /renderTabs\(\)/)
})

test('nothing here polls: the list is read on mount and when the host says the world changed', () => {
  for (const call of [...VIEW.matchAll(/(?:setInterval|setTimeout|requestIdleCallback)\([\s\S]{0,160}/g)].map(m => m[0])) {
    assert.doesNotMatch(call, /loadMachineChoices|readMachineTabs|driveMachineTab/,
      'the bar refreshes itself on a timer, which spends a request describing a list that only changes when a person adds a computer')
  }
  assert.match(VIEW, /void loadMachineChoices\(\)/, 'the list is never read at all')
  /* The two moments it IS read: the mount, and the host saying the world
     changed. The second is the one that is easy to lose, because the verdict
     either side of "a machine was chosen" is the same word and the handler
     returns early on that. */
  const changed = VIEW.slice(VIEW.indexOf('const onDataSourceChange'),
    VIEW.indexOf('\n  }\n', VIEW.indexOf('const onDataSourceChange')))
  assert.match(changed, /loadMachineChoices\(\)/,
    'a computer chosen anywhere else leaves this bar lighting the computer the person left')
})

test('THE OTHER AXIS IS UNTOUCHED: record computers stay available by the bar’s two-list rule', () => {
  const accountRows = machineTabRows(listing(DESK_AND_LAPTOP))
  const cases = [
    {
      name: 'the desktop and signed-out example',
      accountRows: [],
      recordComputers: [{ id: 'desk' }, { id: 'laptop' }],
      record: true,
      separator: false,
    },
    {
      name: 'one record computer already named by an account chip',
      accountRows,
      recordComputers: [{ id: 'desk' }],
      record: false,
      separator: false,
    },
    {
      name: 'a real multi-computer record beside the account chips',
      accountRows,
      recordComputers: [{ id: 'desk' }, { id: 'laptop' }],
      record: true,
      separator: true,
    },
  ]

  for (const expected of cases) {
    const bar = machineTabsBar(expected.accountRows, expected.recordComputers.length)
    assert.equal(bar.record, expected.record,
      `${expected.name}: the record-computer choices have the wrong visibility`)
    assert.equal(bar.separator, expected.separator,
      `${expected.name}: the two independent kinds of choice are visually joined or divided incorrectly`)
    assert.deepEqual(bar.machines, expected.accountRows,
      `${expected.name}: deciding whether to show record computers changed the account-computer choices`)
  }
})
