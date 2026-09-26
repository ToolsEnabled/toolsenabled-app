/* WHAT DRIVING THE CONNECT SCREEN AS A PERSON BROKE, AND WHAT NOW HOLDS IT.
 *
 * tools/test/connect-computer-ui.test.mjs holds the ceremony: eight states, one
 * clock, the failures that must leave somebody somewhere they can act. This
 * file holds the repairs that came out of driving that screen with a real mouse
 * in a real window, on the real account service, as somebody who has just
 * signed up on the website and has no idea what any of this is. Every test
 * below names the thing that was seen on glass, because a regression here would
 * be silent -- each one of these was a screen that looked perfectly fine.
 *
 * Run: node --test tools/test/connect-computer-repairs.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONNECT_SECTION,
  DISCONNECT_ACTION_LABEL,
  MAX_DEVICE_NAME,
  initialState,
  nameToClaim,
  reduce,
} from '../../src/device-claim-flow.js'
import {
  createConnectComputerSettings,
  forgetRememberedClaim,
} from '../../src/connect-computer-settings.js'
import { IDENTIFIER_RE } from '../../src/refusal-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8')

const NOW = 1_770_000_000_000
const TEN_MINUTES = 600_000
const CODE = 'TC-4KQ2-9WFA'

/* The same rig the ceremony suite uses: the clock and the scheduler are handed
   in, so nothing here sleeps and nothing here leaves a timer behind. */
function harness({ bridge = null, startAt = NOW } = {}) {
  let clock = startAt
  const timers = []
  const controller = createConnectComputerSettings({
    now: () => clock,
    schedule: (fn, ms) => {
      const handle = { fn, ms, cleared: false }
      timers.push(handle)
      return handle
    },
    cancelTimer: handle => { handle.cleared = true },
    resolveBridge: () => bridge,
  })
  return { controller, timers, live: () => timers.filter(t => !t.cleared), advance(ms) { clock += ms } }
}

function workingBridge(overrides = {}) {
  return {
    status: async () => ({ ok: true, connected: false }),
    begin: async () => ({ ok: true, code: CODE, expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5 }),
    poll: async () => ({ ok: true, state: 'none' }),
    cancel: async () => ({ ok: true }),
    /* The shape the current shell has; the ceremony suite covers the older
       one that lacks it. */
    disconnect: async () => ({ ok: true, wasConnected: true }),
    ...overrides,
  }
}

/* The smallest stand-in that lets bind() deliver a press to the controller.
   There is no rendering machinery here because this test only asks whether a
   control that says it is busy can start work. */
function pressRoot() {
  const listeners = new Map()
  return {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: () => {},
    contains: () => true,
    querySelector: () => null,
    listeners,
  }
}

function assertHumanSentence(sentence, what) {
  assert.equal(typeof sentence, 'string', `${what} is not a sentence`)
  assert.ok(sentence.trim().length > 0, `${what} is empty`)
  for (const word of sentence.split(/[\s.,;:()"']+/)) {
    assert.equal(IDENTIFIER_RE.test(word), false, `${what} shows the identifier ${word}`)
  }
}

/* The memory this file is largely about outlives a controller on purpose, which
   means it also outlives a test. Cleared before each one, so a pass here is
   never the previous test's leftovers. */
test.beforeEach(() => { forgetRememberedClaim() })

/* ---------- the code survives a person moving around their own window ---------- */

test('a code on screen survives leaving Settings and coming back', async () => {
  /* SEEN ON GLASS: code up, one click to another screen, one click back. The
     section said "This computer is not on an account yet -- nothing has been
     sent anywhere" for two seconds, then "A code was already asked for ... this
     screen cannot show it a second time". Two clicks inside one window and the
     code was gone with no way to see it again. */
  const first = harness({ bridge: workingBridge() })
  await first.controller.begin()
  assert.equal(first.controller.getState().phase, 'waiting')
  assert.equal(first.controller.getState().code, CODE)
  first.controller.destroy()
  assert.equal(first.live().length, 0, 'the screen that left took its clock with it')

  /* The settings page builds a NEW controller every visit. This is that. */
  const second = harness({ bridge: workingBridge({ poll: async () => ({ ok: true, state: 'pending', intervalSeconds: 5 }) }) })
  await second.controller.checkStatus()
  const state = second.controller.getState()
  assert.equal(state.phase, 'waiting', 'the person came back to the wait they left')
  assert.equal(state.code, CODE, 'and to the same code, which is the only one the account page will take')
  assert.equal(state.expiresAtMs, NOW + TEN_MINUTES, 'counting down from where it was, not from zero')
  assert.equal(second.controller.isTicking(), true, 'and the asking is running again')
  second.controller.destroy()
})

test('a code that ran out while the person was elsewhere is not put back on the glass', async () => {
  const first = harness({ bridge: workingBridge() })
  await first.controller.begin()
  first.controller.destroy()

  /* Back after the ten minutes are up. A remembered code is still a code that
     expired, and painting it would be this screen inventing a fact. */
  const second = harness({ bridge: workingBridge(), startAt: NOW + TEN_MINUTES + 1000 })
  await second.controller.checkStatus()
  assert.equal(second.controller.getState().phase, 'idle')
  assert.equal(second.controller.getState().code, null)
  assert.match(second.controller.markup(), /data-connect-action="begin"/,
    'and the way to get another one is on the screen')
  second.controller.destroy()
})

test('an ending forgets the code, so the next visit is not offered a dead one', async () => {
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.begin()
  await rig.controller.cancel()
  assert.equal(rig.controller.getState().phase, 'ended')
  rig.controller.destroy()

  const later = harness({ bridge: workingBridge() })
  await later.controller.checkStatus()
  assert.equal(later.controller.getState().phase, 'idle', 'a code given up is not a code to come back to')
  assert.equal(later.controller.getState().code, null)
  later.controller.destroy()
})

test('a remembered value that is not shaped like a code is refused like any other', () => {
  const base = initialState({})
  for (const code of ['', 'not a code', 'TC-1234', null, 42, 'TC-4KQ2-9WFA-9WFA']) {
    const state = reduce(base, { type: 'adopted-code', code, expiresAtMs: NOW + TEN_MINUTES, nowMs: NOW })
    assert.equal(state, base, `${JSON.stringify(code)} was painted as a code`)
  }
})

test('"not connected" during a wait is the answer a wait expects, not the end of one', () => {
  /* checkStatus() asks status() once per screen, and a screen that came back to
     a live code asks it with that code showing. "connected: false" is what the
     vault says right up until the moment the person finishes on the website. */
  const waiting = reduce(initialState({}), {
    type: 'adopted-code', code: CODE, expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5, nowMs: NOW,
  })
  assert.equal(waiting.phase, 'waiting')

  const after = reduce(waiting, { type: 'status', result: { ok: true, connected: false } })
  assert.equal(after.phase, 'waiting', 'the code was taken away by an answer that meant "not yet"')
  assert.equal(after.code, CODE)

  const refused = reduce(waiting, { type: 'status', result: { ok: false, code: 'DEVICE_CLAIM_TIMEOUT', reason: 'It took too long.' } })
  assert.equal(refused.phase, 'waiting', 'and one unreadable status is not evidence against a live code')
  assert.equal(refused.code, CODE)
  assertHumanSentence(refused.refusal, 'the status refusal shown mid-wait')
})

/* ---------- stopping the wait is an ending, and is said as one ---------- */

test('stopping the wait says so, instead of claiming nothing was ever sent', async () => {
  /* SEEN ON GLASS: "Stop waiting" landed back on the idle line, which reads
     "Nothing has been sent anywhere" -- said to somebody who had just been
     looking at the code it sent. */
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.begin()
  await rig.controller.cancel()
  const state = rig.controller.getState()
  assert.equal(state.phase, 'ended')
  assert.equal(state.endedBecause, 'stopped')
  assert.equal(state.code, null)
  const html = rig.controller.markup()
  assert.match(html, /You stopped waiting/, 'the screen says what happened')
  assert.equal(/Nothing has been sent anywhere/.test(html), false,
    'and does not deny having sent the code it had just shown')
  assert.match(html, /data-connect-action="restart"/, 'with the way on still on it')
  assert.equal(rig.live().length, 0, 'and nothing left ticking')
  rig.controller.destroy()
})

test('asking for a new code does not narrate the giving-up on the way', async () => {
  const seen = []
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.begin()
  await rig.controller.cancel()
  const before = rig.controller.getState().phase
  /* "Get a new code" is one press. Two calls happen behind it; only the second
     is a state a person should be shown a verdict about. */
  await rig.controller.cancel({ thenBegin: true })
  seen.push(before, rig.controller.getState().phase)
  assert.deepEqual(seen, ['ended', 'waiting'])
  assert.equal(rig.controller.getState().code, CODE)
  rig.controller.destroy()
})

test('the screens that offer a new code offer the name box with it', async () => {
  /* A code that ran out left one button on the screen and nothing else, so
     somebody who had meant to rename this computer first had to take a code
     they did not want, give it up, and start again. Both endings offer to ask
     for another, and the next ask reads this box, so the box belongs on both. */
  const ended = harness({ bridge: workingBridge() })
  await ended.controller.begin()
  await ended.controller.cancel()
  assert.equal(ended.controller.getState().phase, 'ended')
  const endedHtml = ended.controller.markup()
  assert.match(endedHtml, /data-connect-field="name"/, 'the ended screen can be renamed before the next ask')
  assert.match(endedHtml, /data-connect-action="restart"/)
  ended.controller.destroy()

  forgetRememberedClaim()
  const orphaned = harness({
    bridge: workingBridge({ poll: async () => ({ ok: true, state: 'pending', intervalSeconds: 5 }) }),
  })
  await orphaned.controller.checkStatus()
  assert.equal(orphaned.controller.getState().phase, 'orphaned')
  const orphanedHtml = orphaned.controller.markup()
  assert.match(orphanedHtml, /data-connect-field="name"/, 'and so can the screen that cannot show the open code')
  assert.match(orphanedHtml, /data-connect-action="restart"/)
  orphaned.controller.destroy()
})

/* ---------- the name box stops where the installed application stops ---------- */

test('the name box stops where the installed application stops', async () => {
  /* SEEN ON GLASS: two hundred characters pasted in, and forty party-popper
     emoji, both produced the same round-trip refusal about sixty-four
     characters -- for a name the person could not see the end of, and for one
     that looked like forty characters to them. */
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.checkStatus()
  const html = rig.controller.markup()
  assert.match(html, new RegExp(`maxlength="${MAX_DEVICE_NAME}"`),
    'the box takes as many characters as the application will accept, and no more')
  assert.match(html, new RegExp(`up to ${MAX_DEVICE_NAME} characters`),
    'and says so, because a box that silently stops is its own small mystery')
  rig.controller.destroy()
})

test('a name the application will not take is answered with the box, not the account page', () => {
  /* The shared table sends every DEVICE_CLAIM_ refusal to the account page "to
     see which computers are joined", which for a name that is too long is
     advice about somewhere else entirely. */
  const state = reduce(initialState({}), {
    type: 'begin-result',
    nowMs: NOW,
    result: {
      ok: false,
      code: 'DEVICE_CLAIM_NAME_INVALID',
      reason: 'That is not a name this computer can be listed under. Use up to 64 ordinary characters.',
    },
  })
  assert.equal(state.phase, 'idle')
  assertHumanSentence(state.refusal, 'the refused-name sentence')
  assert.match(state.refusal, /box above/, 'it points at the box that is on this screen')
  assert.equal(/which computers are joined/.test(state.refusal), false,
    'and not at a page that cannot fix a name')
  assert.equal(state.refusalCode, 'DEVICE_CLAIM_NAME_INVALID',
    'the identifier still rides along for a support conversation')
})

/* ---------- a refusal a person can see, hear, and act on where they pressed ---------- */

test('the refusal is drawn once, with the control that produced it, and out loud', async () => {
  const rig = harness({
    bridge: workingBridge({
      begin: async () => ({ ok: false, code: 'DEVICE_CLAIM_UNREACHABLE', reason: 'The account service did not answer.' }),
    }),
  })
  await rig.controller.begin()
  assert.equal(rig.controller.getState().phase, 'idle')
  const html = rig.controller.markup()
  const nodes = html.match(/data-connect-refusal/g) || []
  assert.equal(nodes.length, 1, `the refusal is drawn ${nodes.length} times`)
  assert.match(html, /role="alert"/, 'somebody working by ear pressed a button and heard nothing')
  assert.match(html, /data-refusal-code="DEVICE_CLAIM_UNREACHABLE"/)

  /* MEASURED at 1446x906: the sentence was at y=417 and the button at y=630,
     with two blocks of unrelated text between them. It belongs above the row of
     buttons -- above, because at 1000x650 the button's own box ends 30px from
     the bottom of the window and anything under it cannot be seen at all. */
  const refusalAt = html.indexOf('data-connect-refusal')
  const buttonAt = html.indexOf('data-connect-action="begin"')
  const fieldsAt = html.indexOf('fleet-profile-fields')
  assert.ok(fieldsAt >= 0 && fieldsAt < refusalAt, 'the refusal is inside the block the person is working in')
  assert.ok(refusalAt < buttonAt, 'and directly above the button, never below the fold under it')
  rig.controller.destroy()
})

test('every state that can carry a refusal draws it exactly once', async () => {
  /* The section now decides between two places for one node, so the failure
     this guards is the quiet one: a state whose body forgot to include it and
     whose top strip had already handed it over. Both of the remaining phases
     that can hold a refusal are walked, not sampled. */
  const midWait = harness({
    bridge: workingBridge({ poll: async () => ({ ok: false, code: 'DEVICE_CLAIM_UNREACHABLE', reason: 'The account service did not answer.' }) }),
  })
  await midWait.controller.begin()
  await midWait.controller.pollOnce()
  const waitingState = midWait.controller.getState()
  assert.equal(waitingState.phase, 'waiting', 'one unanswered ask does not end a wait')
  assert.equal(waitingState.code, CODE, 'and does not take the code off the screen')
  const waitingHtml = midWait.controller.markup()
  assert.equal((waitingHtml.match(/data-connect-refusal/g) || []).length, 1)
  assert.match(waitingHtml, /role="alert"/)
  midWait.controller.destroy()

  forgetRememberedClaim()
  const gone = harness({
    bridge: workingBridge({ poll: async () => ({ ok: false, code: 'DEVICE_CLAIM_GONE', reason: 'That code is no longer open.' }) }),
  })
  await gone.controller.begin()
  await gone.controller.pollOnce()
  assert.equal(gone.controller.getState().phase, 'ended')
  const endedHtml = gone.controller.markup()
  assert.equal((endedHtml.match(/data-connect-refusal/g) || []).length, 1)
  assert.match(endedHtml, /data-connect-action="restart"/, 'with the way out still under it')
  gone.controller.destroy()
})

test('the states that draw no body keep their refusal on the strip at the top', async () => {
  const rig = harness({ bridge: null })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'absent')
  const html = rig.controller.markup()
  assert.equal(/fleet-profile-fields/.test(html), false, 'there is no body to put anything in')
  rig.controller.destroy()
})

test('a section with no button does not describe one', () => {
  /* MEASURED on a first run: about two and a half seconds standing in
     `checking` with no control drawn, under "Nothing is sent until you press
     the button". A description that outlives what it describes is the same
     defect as a switch that does nothing. */
  const rig = harness({ bridge: workingBridge() })
  const html = rig.controller.markup()
  assert.equal(rig.controller.getState().phase, 'checking')
  assert.equal(/data-connect-action/.test(html), false, 'nothing to press yet')
  assert.equal(/press the button/.test(html), false, 'so nothing may say there is')
  assert.match(html, /the button appears when it answers/, 'it says what it is waiting for instead')
  rig.controller.destroy()
})

/* ---------- the code can be copied, and it looks like it ---------- */

test('the code has a control that copies it, which is also the only sign it can be copied', async () => {
  /* DRIVEN: triple-click then Ctrl+C already put exactly the code on the
     clipboard, and so did one click then Ctrl+C. Nothing on the screen said so,
     and 34px of type over a hairline is how a heading looks. */
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.begin()
  const html = rig.controller.markup()
  assert.match(html, /data-connect-action="copy"/)
  assert.match(html, /aria-label="Copy the code"/)
  assert.match(html, />Copy</, 'with a word on it a person reads rather than an icon they guess at')
  assert.match(html, /connect-code-row/, 'beside the code rather than under three other things')
  rig.controller.destroy()
})

test('the waiting screen names the computer the account page will list', async () => {
  /* Clearing the box does not file a nameless computer -- the guess stands in.
     That is right, and it is a surprise if the first somebody hears of it is
     the row on their account page. */
  const rig = harness({ bridge: workingBridge() })
  rig.controller.markup()
  const cleared = reduce(initialState({ name: 'My Windows computer', platform: 'Win32' }), { type: 'name-changed', name: '   ' })
  assert.equal(nameToClaim(cleared), 'My Windows computer')

  await rig.controller.begin()
  const html = rig.controller.markup()
  const claimedName = rig.controller.getState().claimedName
  assert.equal(typeof claimedName, 'string')
  assert.ok(claimedName.length > 0)
  assert.ok(html.includes(claimedName),
    'the waiting screen does not show the computer name that went up the wire')
  rig.controller.destroy()
})

test('the name a claim went up under survives the screen being rebuilt', async () => {
  /* CAUGHT ON GLASS at 1000x650, in the repair above: a claim opened as "Front
     desk", left and come back to, reported "It will be listed as My Windows
     computer" -- because the restored screen recomputed the name from a fresh
     box instead of reporting the decision that was actually made. */
  /* The decision is made once, where the claim is opened, over the box as it
     stood at that moment. */
  const typed = reduce(initialState({ platform: 'Win32' }), { type: 'name-changed', name: 'Front desk' })
  const opened = reduce(typed, {
    type: 'begin-result', nowMs: NOW,
    result: { ok: true, code: CODE, expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5 },
  })
  assert.equal(opened.claimedName, 'Front desk')

  /* And a rebuilt screen reports it rather than guessing again. A screen whose
     box has gone back to the default is exactly the case that was wrong. */
  const rebuilt = reduce(initialState({ platform: 'Win32' }), {
    type: 'adopted-code', code: CODE, claimedName: opened.claimedName,
    expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5, nowMs: NOW,
  })
  assert.equal(rebuilt.claimedName, 'Front desk')
  assert.notEqual(nameToClaim(rebuilt), 'Front desk',
    'the guess this screen would otherwise have shown is a different name, which is what made the defect visible')

  /* The controller is what carries it across the two, and without that carry
     the restored state's name would be absent rather than merely wrong. */
  const first = harness({ bridge: workingBridge() })
  await first.controller.begin()
  const claimed = first.controller.getState().claimedName
  assert.equal(typeof claimed, 'string')
  assert.ok(claimed.length > 0)
  first.controller.destroy()

  const second = harness({ bridge: workingBridge({ poll: async () => ({ ok: true, state: 'pending', intervalSeconds: 5 }) }) })
  await second.controller.checkStatus()
  assert.equal(second.controller.getState().phase, 'waiting')
  assert.equal(second.controller.getState().claimedName, claimed,
    'the remembered claim carries the name it went up under')
  second.controller.destroy()
})

test('a repaint puts the keyboard back on the control it was taken from', () => {
  /* MEASURED: sixteen tabs from the top of Settings to "Get a code". A refusal
     replaces the whole section, so pressing Space on that button and being
     refused left the focus on <body> -- sixteen tabs to do again, to reach a
     button whose own refusal says to change the box directly above it. Proven
     on glass in the driven pass; pinned here by source, the same second lock
     the ceremony suite puts on the timer rule, because the branch needs a real
     document and the rule needs to survive an edit that has none. */
  const source = read('src/connect-computer-settings.js')
  assert.match(source, /function focusedControl\(\)/,
    'the focused control is named as a selector that survives outerHTML')
  assert.match(source, /const wasFocused = focusedControl\(\)[\s\S]{0,600}?current\.outerHTML = markup/,
    'and it is read BEFORE the nodes are replaced, which is the only time it exists')
  assert.match(source, /hostRoot\.querySelector\(wasFocused\)\?\.focus\?\.\(\)/,
    'and put back after')
})

test('the busy button stays focusable, and stays refused', async () => {
  /* A `disabled` button cannot hold focus, so the repaint into `starting` was
     dropping the keyboard on the floor before the refusal even arrived --
     which is what made the restoration above look like it had not worked.
     Nothing is loosened: begin() still returns early while a request is on the
     wire, the shell still answers DEVICE_CLAIM_BUSY, and the press is ignored
     here as well. */
  let release
  const held = new Promise(resolve => { release = resolve })
  const rig = harness({ bridge: workingBridge({ begin: () => held }) })
  await rig.controller.checkStatus()
  const pressing = rig.controller.begin()
  const busy = rig.controller.markup()
  assert.equal(rig.controller.getState().phase, 'starting')
  assert.match(busy, /data-connect-action="begin" aria-disabled="true"/,
    'the busy button says so without leaving the tab order')
  assert.equal(/data-connect-action="begin"[^>]*\sdisabled/.test(busy), false,
    'a disabled button cannot keep the focus a person pressed it with')

  /* A second press while the first is in flight still does nothing. */
  await rig.controller.begin()
  release({ ok: true, code: CODE, expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5 })
  await pressing
  assert.equal(rig.controller.getState().code, CODE)
  rig.controller.destroy()

  let begins = 0
  let cancels = 0
  const guarded = harness({
    bridge: workingBridge({
      begin: async () => { begins += 1; return { ok: true, code: CODE, expiresAtMs: NOW + TEN_MINUTES, intervalSeconds: 5 } },
      cancel: async () => { cancels += 1; return { ok: true } },
    }),
  })
  await guarded.controller.checkStatus()
  const root = pressRoot()
  guarded.controller.bind(root)
  const busyButton = {
    dataset: { connectAction: 'begin' },
    getAttribute: name => (name === 'aria-disabled' ? 'true' : null),
    closest(selector) { return selector === '[data-connect-action]' ? this : null },
  }
  root.listeners.get('click')({ target: busyButton })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual({ begins, cancels }, { begins: 0, cancels: 0 },
    'an aria-disabled busy button started or cancelled a claim when pressed')
  guarded.controller.destroy()
})

test('a connected computer with no name still says where to take it off, and draws the way out', async () => {
  /* connectedReply() in shell/device-claim.cjs coerces a non-string name to '',
     so this is a real shape rather than a hypothetical. With no name the body
     used to draw nothing at all, which left "Your account page lists it under
     that name" as a sentence about nothing -- above no control, on the one
     screen whose whole job at that point is to say where the undo lives.
     There are two undos now and the screen names both: the ROW comes off on
     the account page, and what THIS computer holds comes off with the
     "Disconnect this computer" control, which the connect button is not. */
  const named = harness({ bridge: workingBridge({ status: async () => ({ ok: true, connected: true, name: 'Front desk', deviceId: 'd', pairId: 'p' }) }) })
  await named.controller.checkStatus()
  assert.equal(named.controller.getState().phase, 'connected')
  const namedHtml = named.controller.markup()
  assert.match(namedHtml, /This computer is joined as Front desk/)
  assert.match(namedHtml, /Sign in at toolsenabled\.ai and open your account page/)
  assert.equal(/data-connect-action="begin"/.test(namedHtml), false,
    'nothing to connect on a computer that is already joined')
  assert.match(namedHtml, /data-connect-action="disconnect"/, 'the one thing to press on a joined computer')
  assert.ok(namedHtml.includes(DISCONNECT_ACTION_LABEL))
  /* AND IT DOES NOT SAY THIS IN GREEN. A `status` answer is this machine
     reading its own vault; it says the same words whether the computer has been
     offline for an hour or was removed from the account on another machine. */
  assert.equal(/is-good/.test(namedHtml), false,
    'a vault read was painted as a proven, current connection')
  named.controller.destroy()

  forgetRememberedClaim()
  const nameless = harness({ bridge: workingBridge({ status: async () => ({ ok: true, connected: true, name: '', deviceId: 'd', pairId: 'p' }) }) })
  await nameless.controller.checkStatus()
  const html = nameless.controller.markup()
  assert.match(html, /This computer is joined to an account/)
  assert.match(html, /Sign in at toolsenabled\.ai and open your account page/,
    'and the one thing this screen has to say survives both spellings')
  assert.match(html, /data-connect-action="disconnect"/, 'a nameless joined computer still has its way out')
  nameless.controller.destroy()
})

/* ---------- a computer that already holds a credential is told the truth ---------- */

test('an already-connected refusal names the control that cures it, and lands where that control is', async () => {
  /* The shared DEVICE_CLAIM_ floor ends "a new code comes from this screen",
     and the shell's old sentence said "Remove it on the account page first".
     Neither cures this: removing the computer on the account page leaves what
     this machine holds untouched. What does cure it is "Disconnect this
     computer", which exists now and is drawn on the joined screen -- so the
     remedy names it, and the refusal lands on the joined screen rather than
     on idle, where the sentence would name a control that is not there. */
  const state = reduce(
    reduce(initialState({ name: 'Desk' }), { type: 'begin-requested' }),
    { type: 'begin-result', result: { ok: false, code: 'DEVICE_CLAIM_ALREADY_CONNECTED', reason: 'This computer already holds a connection to an account, so it cannot take a new code.' } },
  )
  assert.equal(state.phase, 'connected', 'the engine said this computer is joined; the screen must agree')
  assert.equal(state.serviceConfirmed, false, 'a refusal is a vault fact, never the good tone')
  assert.equal(state.device, null, 'a refusal names no device')
  assert.equal(state.refusalCode, 'DEVICE_CLAIM_ALREADY_CONNECTED')
  assert.equal(state.refusalPressed, true)
  assert.match(state.refusal, /does not clear what this computer holds/)
  assert.match(state.refusal, /Disconnect it in Settings/)
  assert.ok(state.refusal.includes(CONNECT_SECTION), 'the section the control lives in is not named')
  assert.match(state.refusal, /then take a new code/)
  assert.equal(/nothing in this window can clear it yet/.test(state.refusal), false,
    'the remedy still says this window cannot do what it now does')
  assert.equal(/a new code comes from this screen/.test(state.refusal), false,
    'the floor sentence promises the one thing this computer cannot do until it disconnects')
  assert.equal(/Remove it on the account page first/.test(state.refusal), false)
  assertHumanSentence(state.refusal, 'the already-connected refusal')

  /* And on the glass: the sentence, out loud, with the control under it. */
  const rig = harness({
    bridge: workingBridge({
      begin: async () => ({ ok: false, code: 'DEVICE_CLAIM_ALREADY_CONNECTED', reason: 'This computer already holds a connection to an account, so it cannot take a new code.' }),
    }),
  })
  await rig.controller.checkStatus()
  await rig.controller.begin()
  assert.equal(rig.controller.getState().phase, 'connected')
  const html = rig.controller.markup()
  assert.equal((html.match(/data-connect-refusal/g) || []).length, 1)
  assert.match(html, /role="alert"/)
  assert.match(html, /data-connect-action="disconnect"/, 'the control the sentence names is not under it')
  assert.ok(html.indexOf('data-connect-refusal') < html.indexOf('data-connect-action="disconnect"'),
    'the sentence is not directly above the control it names')
  assert.equal(/data-connect-action="begin"/.test(html), false, 'the button that was just refused is still offered')
  rig.controller.destroy()
})

/* ---------- the search box stops hiding this section from the people looking ---------- */

test('the search box finds this section by what a stuck person actually types', () => {
  const rig = harness({ bridge: workingBridge() })
  /* Every one of these was MEASURED returning "No settings match this search",
     with the words "Connect this computer" on the screen above the box. */
  for (const typed of [
    'connect computer',
    'connect my computer',
    'connect this computer to my account',
    'sign in',
    'computer name',
    'how do i connect',
    'add this computer to my account',
    'account code',
    'TC-',
    /* The switch lives here and nowhere else, so the words a person would
       type looking for it have to land here too. */
    'browser',
    'signed-in browser',
    'web drive',
    'remote',
    'let a signed-in browser drive this computer',
    /* The way out lives here too. */
    'disconnect',
    'disconnect this computer',
  ]) {
    assert.equal(rig.controller.matches(typed), true, `"${typed}" does not find this section`)
  }
  for (const unrelated of ['sankey gradient', 'reduce motion', 'ledger export']) {
    assert.equal(rig.controller.matches(unrelated), false, `"${unrelated}" should not drag this section in`)
  }
  rig.controller.destroy()
})
