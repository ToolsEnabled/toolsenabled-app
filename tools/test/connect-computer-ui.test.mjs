/* THE SCREEN THAT SHOWS A PERSON THEIR CODE, HELD STILL.
 *
 * "as a user I dont even see how after signing up that I now connect my
 * computer." The account page on the website asks for a code; nothing in this
 * application had ever shown one. src/device-claim-flow.js is the state machine
 * behind the screen that now does, and src/connect-computer-settings.js draws
 * it.
 *
 * WHY THE FAILURE STATES GET MOST OF THIS FILE. Three of the eight states are
 * failures -- a refusal mid-wait, a code that ran out, a claim the screen cannot
 * show -- and those are the branches a driven browser reaches least often and a
 * person hits first. Each one has to leave somebody somewhere they can act, so
 * each one is walked here rather than trusted.
 *
 * THE TIMER TESTS ARE OBSERVED, NOT PINNED. The controller takes its clock and
 * its scheduler as arguments, so these tests hand it fakes and READ BACK
 * whether an interval was armed and whether it was released -- including the
 * case that actually bites, a request still on the wire when the screen is torn
 * down. The source pin at the bottom is a second lock on the same rule, not the
 * evidence for it.
 *
 * Run: node --test tools/test/connect-computer-ui.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { groupOfSection } from '../../src/settings-presentation.js'
import {
  ACCOUNT_PAGE_HOST,
  CONNECT_SECTION,
  CONNECT_SETTING_ID,
  DISCONNECT_ACTION_LABEL,
  DISCONNECT_ARMED_HINT,
  WEB_DRIVE_CONTROL_LABEL,
  clockShouldRun,
  defaultDeviceName,
  initialState,
  nameToClaim,
  pollDue,
  pollSeconds,
  reduce,
  remainingText,
  repaintNeeded,
} from '../../src/device-claim-flow.js'
import {
  bridgeCanDisconnect,
  createConnectComputerSettings,
  deviceClaimBridge,
} from '../../src/connect-computer-settings.js'
import { IDENTIFIER_RE } from '../../src/refusal-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8')

const NOW = 1_770_000_000_000
const CODE = 'TC-4KQ2-9WFA'

/* Every sentence this product puts in front of somebody has to survive the same
   two rules the refusal module states: no identifier on the glass, and never an
   empty message where a failure happened. Asserted on every sentence this flow
   can produce rather than on a sampled one. */
function assertHumanSentence(sentence, what) {
  assert.equal(typeof sentence, 'string', `${what} is not a sentence`)
  assert.ok(sentence.trim().length > 0, `${what} is empty`)
  for (const word of sentence.split(/[\s.,;:()"']+/)) {
    assert.equal(IDENTIFIER_RE.test(word), false, `${what} shows the identifier ${word}`)
  }
}

/* ---------- the numbers this flow is handed rather than chooses ---------- */

test('the asking cadence is the service’s number, clamped only where it is not a number', () => {
  assert.equal(pollSeconds(3), 3, 'the service asked for 3 seconds and got 3')
  assert.equal(pollSeconds(2.4), 2, 'a fractional cadence rounds rather than being replaced')
  assert.equal(pollSeconds(0), 1, '0 seconds is a request storm, not a cadence')
  assert.equal(pollSeconds(-9), 1)
  assert.equal(pollSeconds(99999), 300, 'a wait longer than the code lives is not a cadence either')
  assert.equal(pollSeconds(undefined), 5, 'a service that said nothing gets the slow fallback')
  assert.equal(pollSeconds('nonsense'), 5)
})

test('the default name prefers the label this person already chose', () => {
  assert.equal(defaultDeviceName({ profileLabel: 'Studio tower', platform: 'Win32' }), 'Studio tower')
  assert.equal(defaultDeviceName({ profileLabel: '   ', platform: 'Win32' }), 'My Windows computer')
  assert.equal(defaultDeviceName({ platform: 'MacIntel' }), 'My Mac')
  assert.equal(defaultDeviceName({ platform: 'Linux x86_64' }), 'My Linux computer')
  assert.equal(defaultDeviceName({}), 'My computer', 'a computer nobody could identify still gets a name')
  assert.equal(defaultDeviceName({ profileLabel: 'x'.repeat(200) }).length, 48,
    'the cap applies to the guess so the box stays readable')
})

test('clearing the box does not file a nameless computer against somebody’s account', () => {
  const state = { ...initialState({ platform: 'Win32' }), name: '   ' }
  assert.equal(nameToClaim(state), 'My Windows computer')
  assert.equal(nameToClaim({ ...state, name: '  Front desk  ' }), 'Front desk',
    'what a person typed is trimmed, never replaced')
})

/* ---------- the countdown ---------- */

test('the time left is honest, including when nobody said what it was', () => {
  assert.equal(remainingText(NOW + 272_000, NOW), 'Stops working in 4:32.')
  assert.equal(remainingText(NOW + 9_000, NOW), 'Stops working in 0:09.',
    'a code with seconds left says seconds, not "less than a minute"')
  const unknown = remainingText(undefined, NOW)
  assert.match(unknown, /was not told/, `an absent expiry is stated, not painted as 0:00 (${unknown})`)
  const spent = remainingText(NOW - 1, NOW)
  assert.match(spent, /Ask for a new one/, `a spent code offers the next move (${spent})`)
})

/* ---------- idle -> waiting -> connected ---------- */

function afterBegin({ intervalSeconds = 5, expiresAtMs = NOW + 300_000 } = {}) {
  let state = initialState({ name: 'Front desk', platform: 'Win32' })
  state = reduce(state, { type: 'status', result: { ok: true, connected: false } })
  assert.equal(state.phase, 'idle')
  state = reduce(state, { type: 'begin-requested' })
  assert.equal(state.phase, 'starting')
  return reduce(state, {
    type: 'begin-result',
    nowMs: NOW,
    result: { ok: true, code: CODE, expiresAtMs, intervalSeconds },
  })
}

test('idle to waiting: the code is held, and the next ask is the service’s interval away', () => {
  const state = afterBegin({ intervalSeconds: 7 })
  assert.equal(state.phase, 'waiting')
  assert.equal(state.code, CODE)
  assert.equal(state.intervalSeconds, 7)
  assert.equal(state.nextPollAtMs, NOW + 7000, 'the wait is paced by the service, not by this window')
  assert.equal(pollDue(state, NOW + 6999), false)
  assert.equal(pollDue(state, NOW + 7000), true)
  assert.equal(clockShouldRun(state), true)
})

test('waiting to connected: the computer is named as the account will show it', () => {
  const waiting = afterBegin()
  const state = reduce(waiting, {
    type: 'poll-result',
    nowMs: NOW + 5000,
    result: { ok: true, state: 'connected', device: { name: 'Front desk', deviceId: 'd-1', pairId: 'p-1' } },
  })
  assert.equal(state.phase, 'connected')
  assert.equal(state.device.name, 'Front desk')
  assert.equal(state.code, null, 'a collected code is not left on the screen')
  assert.equal(state.nextPollAtMs, null)
  assert.equal(clockShouldRun(state), false, 'the clock stops the moment the wait is over')
})

test('a pending answer re-reads the cadence, so a service that slows down is obeyed', () => {
  const waiting = afterBegin({ intervalSeconds: 2 })
  const state = reduce(waiting, {
    type: 'poll-result',
    nowMs: NOW + 2000,
    result: { ok: true, state: 'pending', intervalSeconds: 30 },
  })
  assert.equal(state.phase, 'waiting')
  assert.equal(state.intervalSeconds, 30)
  assert.equal(state.nextPollAtMs, NOW + 32_000)
})

/* ---------- the three ways a wait ends badly ---------- */

test('an expired or collected code says so and offers another, never a dead end', () => {
  const waiting = afterBegin()
  const state = reduce(waiting, {
    type: 'poll-result',
    nowMs: NOW + 5000,
    result: { ok: false, code: 'DEVICE_CLAIM_GONE', reason: 'That code is no longer open.' },
  })
  assert.equal(state.phase, 'ended')
  assert.equal(state.endedBecause, 'gone')
  assert.equal(state.code, null)
  assert.equal(state.nextPollAtMs, null, 'nothing keeps asking about a code that is gone')
  assertHumanSentence(state.refusal, 'the expired-code sentence')
  assert.match(state.refusal, /Ask for a new code/, state.refusal)
  assert.equal(state.refusalCode, 'DEVICE_CLAIM_GONE',
    'the identifier is carried for support, in a field, not in the sentence')
})

test('the local clock may end a wait, because the deadline came from the service', () => {
  const waiting = afterBegin({ expiresAtMs: NOW + 10_000 })
  assert.equal(reduce(waiting, { type: 'tick', nowMs: NOW + 9_999 }), waiting,
    'a tick before the deadline changes nothing at all')
  const state = reduce(waiting, { type: 'tick', nowMs: NOW + 10_000 })
  assert.equal(state.phase, 'ended')
  assert.equal(state.endedBecause, 'ran-out')
  assert.equal(clockShouldRun(state), false)
})

test('a wait the application is no longer holding ends as a wait, not as a failure', () => {
  const waiting = afterBegin()
  const state = reduce(waiting, { type: 'poll-result', nowMs: NOW, result: { ok: true, state: 'none' } })
  assert.equal(state.phase, 'ended')
  assert.equal(state.endedBecause, 'not-tracked')
  assert.equal(state.refusal, '', 'nothing refused, so nothing is reported as a refusal')
})

/* ---------- refusals are shown, and the ones that are survivable do not end the wait ---------- */

test('a refusal mid-wait keeps the code on screen and schedules the next ask', () => {
  const waiting = afterBegin({ intervalSeconds: 4 })
  const state = reduce(waiting, {
    type: 'poll-result',
    nowMs: NOW + 4000,
    result: { ok: false, code: 'BRIDGE_ROUTE_UNKNOWN', reason: 'The audited dependency refused the action.' },
  })
  assert.equal(state.phase, 'waiting', 'one unanswered ask is not evidence the code is dead')
  assert.equal(state.code, CODE)
  assert.equal(state.nextPollAtMs, NOW + 8000, 'the wait keeps its cadence through a refusal')
  assertHumanSentence(state.refusal, 'the mid-wait refusal')
})

test('a refused begin returns the button and says why, rather than doing nothing visible', () => {
  let state = reduce(initialState({}), { type: 'begin-requested' })
  state = reduce(state, {
    type: 'begin-result',
    nowMs: NOW,
    result: { ok: false, code: 'ACCOUNT_SIGN_IN_REQUIRED', reason: 'No account is signed in on this computer.' },
  })
  assert.equal(state.phase, 'idle', 'the control a person just pressed is still there to press again')
  assertHumanSentence(state.refusal, 'the refused-begin sentence')
  assert.match(state.refusal, /No account is signed in/, state.refusal)
})

test('an answer that says yes and carries no code is not painted as a code', () => {
  let state = reduce(initialState({}), { type: 'begin-requested' })
  state = reduce(state, { type: 'begin-result', nowMs: NOW, result: { ok: true, code: 'hello' } })
  assert.equal(state.phase, 'idle')
  assert.equal(state.code, null)
  assertHumanSentence(state.refusal, 'the codeless-answer sentence')
})

test('a status this window could not read is not reported as "not connected"', () => {
  /* AND `idle` IS A REPORT OF "NOT CONNECTED", which is what this test used to
     accept. `idle` draws "This computer is not on an account yet -- nothing has
     been sent anywhere", so a momentary BUSY or TIMEOUT on the mount-time read
     told a fully joined customer their computer was not on an account: the
     product denying, in its own voice, the one thing they had paid to make
     true. An unread answer has its own phase now, and it draws the same
     controls idle does, because trying is still this person's move. */
  const state = reduce(initialState({}), {
    type: 'status',
    result: { ok: false, code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE', reason: 'The audited connection is not answering yet.' },
  })
  assert.equal(state.phase, 'unknown', 'an unread answer was rounded to a verdict')
  assertHumanSentence(state.refusal, 'the unreadable-status sentence')
  /* AND IT IS NOT SHOUTED. Nobody pressed anything; this is the mount-time
     read. The status line carries the sentence, and the alert slot stays
     empty -- see refusalMarkup() in src/connect-computer-settings.js. */
  assert.equal(state.refusalPressed, false, 'a refusal nobody caused was marked as one they did')
})

test('every refusal shape produces a whole sentence, including the empty ones', () => {
  for (const result of [undefined, null, {}, { ok: false }, { ok: false, reason: '' }, { ok: false, reason: 'DEVICE_CLAIM_GONE' }]) {
    const state = reduce(initialState({}), { type: 'begin-result', nowMs: NOW, result })
    assertHumanSentence(state.refusal, `a refusal built from ${JSON.stringify(result)}`)
  }
})

/* ---------- the states that are neither idle nor waiting ---------- */

test('a claim this screen cannot show the code for offers a fresh one', () => {
  const state = reduce(initialState({}), { type: 'adopted-pending', nowMs: NOW, intervalSeconds: 6 })
  assert.equal(state.phase, 'orphaned')
  assert.equal(state.code, null, 'poll() answers pending without the code; the screen does not invent one')
  assert.equal(clockShouldRun(state), true, 'it is still a wait, so it still ticks')
  const restarted = reduce(state, { type: 'restart' })
  assert.equal(restarted.phase, 'idle')
  assert.equal(clockShouldRun(restarted), false)
})

test('a pending answer moves the state but draws nothing, so a selection survives it', () => {
  /* MEASURED IN A BROWSER before this rule existed: the section was rebuilt
     every two seconds on the service's own cadence, and the rebuild replaced
     the code field -- so somebody part-way through selecting their code lost
     the selection, silently, over and over. The code stayed on the screen,
     which is what makes it the kind of defect nobody reports. */
  const waiting = afterBegin({ intervalSeconds: 2 })
  const later = reduce(waiting, { type: 'poll-result', nowMs: NOW + 2000, result: { ok: true, state: 'pending', intervalSeconds: 2 } })
  assert.notEqual(later, waiting, 'the schedule really did move')
  assert.equal(repaintNeeded(waiting, later), false, 'and nothing a person sees moved with it')

  const typed = reduce(waiting, { type: 'name-changed', name: 'Other' })
  assert.equal(repaintNeeded(waiting, typed), false, 'nor does rewriting the box somebody is typing in')

  for (const change of [
    reduce(waiting, { type: 'poll-result', nowMs: NOW, result: { ok: true, state: 'connected', device: { name: 'Front desk' } } }),
    reduce(waiting, { type: 'poll-result', nowMs: NOW, result: { ok: false, code: 'DEVICE_CLAIM_GONE', reason: 'gone.' } }),
    reduce(waiting, { type: 'poll-result', nowMs: NOW, result: { ok: false, code: 'BRIDGE_ROUTE_UNKNOWN', reason: 'The audited dependency refused the action.' } }),
    reduce(waiting, { type: 'tick', nowMs: NOW + 999_999 }),
  ]) {
    assert.equal(repaintNeeded(waiting, change), true, `this change is on the glass and must repaint: ${change.phase}/${change.endedBecause}`)
  }
})

test('reduce returns the SAME object when nothing moved, which is what stops a repaint a second', () => {
  const waiting = afterBegin()
  assert.equal(reduce(waiting, { type: 'tick', nowMs: NOW + 1000 }), waiting)
  assert.equal(reduce(waiting, { type: 'nothing-of-the-sort' }), waiting)
  assert.equal(reduce(waiting, { type: 'name-changed', name: waiting.name }), waiting)
  assert.notEqual(reduce(waiting, { type: 'name-changed', name: 'Other' }), waiting)
})

/* ---------- the bridge may not be there at all ---------- */

test('a bridge missing any one verb reads as absent, not as half-usable', () => {
  const whole = { status() {}, begin() {}, poll() {}, cancel() {} }
  assert.equal(deviceClaimBridge({ deviceClaim: whole }), whole)
  assert.equal(deviceClaimBridge(undefined), null)
  assert.equal(deviceClaimBridge({}), null, 'a shell with no deviceClaim at all')
  assert.equal(deviceClaimBridge({ deviceClaim: {} }), null)
  for (const missing of ['status', 'begin', 'poll', 'cancel']) {
    const partial = { ...whole }
    delete partial[missing]
    assert.equal(deviceClaimBridge({ deviceClaim: partial }), null,
      `a bridge without ${missing}() would strand somebody mid-ceremony`)
  }
  /* THE FIFTH VERB IS OPTIONAL. `disconnect` shipped after the four, and a
     shell without it must still connect -- reading as absent would put every
     older installation on the "needs the app" screen for want of a verb the
     ceremony never calls. It is asked for separately, and only the control
     that calls it depends on the answer. */
  assert.equal(deviceClaimBridge({ deviceClaim: whole }), whole, 'a bridge without disconnect() still connects')
  assert.equal(bridgeCanDisconnect(whole), false)
  assert.equal(bridgeCanDisconnect({ ...whole, disconnect() {} }), true)
  assert.equal(bridgeCanDisconnect(null), false)
})

/* ---------- the controller, with its clock and its scheduler handed to it ---------- */

function harness({ bridge = null, startAt = NOW, viaRelay = false } = {}) {
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
    readingOverRelay: () => viaRelay,
  })
  return {
    controller,
    timers,
    live: () => timers.filter(timer => !timer.cleared),
    advance(ms) { clock += ms },
  }
}

function workingBridge(overrides = {}) {
  return {
    status: async () => ({ ok: true, connected: false }),
    begin: async () => ({ ok: true, code: CODE, expiresAtMs: NOW + 300_000, intervalSeconds: 5 }),
    /* 'none' is the ordinary answer for a computer with nothing in flight, and
       it has to be the default here: a fake that says 'pending' puts every test
       that only wanted a working bridge into the orphaned state on mount. */
    poll: async () => ({ ok: true, state: 'none' }),
    cancel: async () => ({ ok: true }),
    /* The shape the current shell has. Tests for an older shell delete it. */
    disconnect: async () => ({ ok: true, wasConnected: true }),
    ...overrides,
  }
}

/* A bridge that answers "joined" to the first question, which is how every
   visit to the joined screen begins. */
function joinedBridge(overrides = {}) {
  return workingBridge({
    status: async () => ({ ok: true, connected: true, name: 'Front desk', deviceId: 'd', pairId: 'p', claimedAtMs: NOW }),
    ...overrides,
  })
}

const stoppedConnection = { remoteAccessBlocked: true, remoteStopped: true, childQuiescent: true,
  restartSafety: 'recorded', disconnectPending: false }
function confirmedDisconnectBridge() {
  let present = true
  return joinedBridge({
    status: async () => present ? { ok: true, connected: true, name: 'Front desk' }
      : { ok: true, connected: false, ...stoppedConnection },
    disconnect: async () => {
      present = false
      return { ok: true, wasConnected: true, credentialCleared: true, mutationOutcome: 'REMOVED_SYNCED', ...stoppedConnection }
    },
  })
}

/* THE SMALLEST ROOT THAT LETS THE PRESS HANDLER RUN WITHOUT A DOM, the same
   shape tools/test/web-drive-consent.test.mjs uses. bind() attaches listeners
   to it; a press is delivered by calling the recorded click listener with an
   event whose target answers closest(). The hint slot is the one node the
   press handler writes to directly, so it is a real object here. */
function fakeRoot() {
  const listeners = new Map()
  let html = ''
  const hint = { textContent: '', hidden: true }
  const section = {
    querySelector: () => null,
    set outerHTML(value) { html = value },
    get outerHTML() { return html },
  }
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: () => {},
    contains: () => true,
    ownerDocument: { activeElement: null },
    querySelector: selector => {
      if (selector === '[data-connect-settings]') return section
      if (selector === '[data-connect-disconnect-hint]') return hint
      return null
    },
    listeners,
    hint,
    painted: () => html,
  }
}

/* A button as src/arm-press.js and the press handler see it: a dataset, the
   two attributes the arm writes, and closest() answering for itself. */
function fakeButton(action) {
  const attributes = new Map()
  return {
    dataset: { connectAction: action },
    isConnected: true,
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => { attributes.set(name, value) },
    closest(selector) { return selector === '[data-connect-action]' ? this : null },
  }
}

test('a code in hand arms exactly one clock, and tearing the screen down releases it', async () => {
  const rig = harness({ bridge: workingBridge() })
  assert.equal(rig.timers.length, 0, 'nothing ticks before there is anything to wait for')

  await rig.controller.begin()
  assert.equal(rig.controller.getState().phase, 'waiting')
  assert.equal(rig.timers.length, 1, `one clock, not ${rig.timers.length}`)
  assert.equal(rig.timers[0].ms, 1000)
  assert.equal(rig.controller.isTicking(), true)

  rig.controller.destroy()
  assert.equal(rig.live().length, 0, 'a timer outliving its screen is the bug this asserts against')
  assert.equal(rig.controller.isTicking(), false)
})

test('a request still on the wire when the screen is torn down cannot arm a new clock', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const rig = harness({ bridge: workingBridge({ poll: () => pending }) })

  await rig.controller.begin()
  assert.equal(rig.timers.length, 1)

  const inFlight = rig.controller.pollOnce()
  rig.controller.destroy()
  assert.equal(rig.live().length, 0, 'destroy released the clock')

  release({ ok: true, state: 'pending', intervalSeconds: 5 })
  await inFlight
  assert.equal(rig.timers.length, 1, `a late answer armed ${rig.timers.length - 1} extra clock(s)`)
  assert.equal(rig.live().length, 0, 'and it did not resurrect the one that was released')
  assert.equal(rig.controller.isTicking(), false)
})

test('the clock stops on its own when the wait ends, without waiting for teardown', async () => {
  const rig = harness({
    bridge: workingBridge({
      poll: async () => ({ ok: true, state: 'connected', device: { name: 'Front desk', deviceId: 'd', pairId: 'p' } }),
    }),
  })
  await rig.controller.begin()
  assert.equal(rig.controller.isTicking(), true)
  await rig.controller.pollOnce()
  assert.equal(rig.controller.getState().phase, 'connected')
  assert.equal(rig.controller.isTicking(), false, 'a finished ceremony leaves nothing running')
  assert.equal(rig.live().length, 0)
  rig.controller.destroy()
})

test('a bridge that throws is a sentence on the screen, never a silent press', async () => {
  const rig = harness({ bridge: workingBridge({ begin: async () => { throw new Error('DEVICE_CLAIM_GONE') } }) })
  await rig.controller.begin()
  const state = rig.controller.getState()
  assert.equal(state.phase, 'idle')
  assertHumanSentence(state.refusal, 'the thrown-error sentence')
  assert.ok(rig.controller.markup().includes('data-connect-refusal'), 'and it is in the markup')
  rig.controller.destroy()
})

test('no bridge at all draws the absent state and starts nothing', async () => {
  const rig = harness({ bridge: null })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'absent')
  assert.equal(rig.timers.length, 0)
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="absent"/)
  assert.equal(/data-connect-action="begin"/.test(html), false,
    'a window that cannot ask must not draw the button that asks')
  assert.match(html, /installed ToolsEnabled application/)
  rig.controller.destroy()
})

/* MEASURED ON THE LIVE SITE, 2026-08-22: a browser that had signed in at
   toolsenabled.ai and was driving this computer over the relay opened this
   section and was told "This window cannot ask for a code ... sign in at
   toolsenabled.ai instead". The page has no claim handle over the relay, so the
   phase is honestly `absent` -- but the reader is not a stranger at a desk, and
   the computer is plainly on the account, or the bytes could not have arrived.
   The section must say that, name where the web-drive switch actually lives,
   and still draw no button. */
test('read over the relay, the absent state says the computer is on the account and where the switch lives', async () => {
  const rig = harness({ bridge: null, viaRelay: true })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'absent')
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="absent"/)
  assert.equal(/data-connect-action=/.test(html), false, 'no control of any kind over the relay')
  assert.match(html, /The computer you are driving is on your account/)
  assert.doesNotMatch(html, /fleet-profile-status is-warn/, 'the relay reading is a fact, not a warning')
  assert.doesNotMatch(html, /sign in at toolsenabled\.ai instead/, 'the signed-in reader must not be told to sign in')
  assert.doesNotMatch(html, /cannot ask for a code/)
  assert.ok(html.includes(WEB_DRIVE_CONTROL_LABEL), 'the switch is named so the reader knows what to look for on the computer')
  assert.match(html, /Connect this computer/, 'the section on the computer is named')
  assert.equal(/settings-toggle|data-connect-field="web-drive"/.test(html), false, 'the switch itself is never drawn in a browser')
  /* A throwing reader is an ordinary reader: the old sentence, not a crash. */
  const broken = createConnectComputerSettings({ resolveBridge: () => null, readingOverRelay: () => { throw new Error('no source') } })
  await broken.checkStatus()
  assert.match(broken.markup(), /installed ToolsEnabled application/)
  broken.destroy()
  rig.controller.destroy()
})

/* ---------- what the section actually puts on the glass ---------- */

test('the section says what it is for before it asks for anything', () => {
  const rig = harness({ bridge: workingBridge() })
  const html = rig.controller.markup()
  const note = html.indexOf('signed up on the website')
  const firstControl = html.search(/data-connect-(action|field)=/)
  assert.ok(note > -1, 'the plain sentence is on the section')
  assert.ok(firstControl === -1 || note < firstControl, 'and it comes before the first control')
  assert.match(html, new RegExp(CONNECT_SECTION))
  rig.controller.destroy()
})

test('the idle state offers an editable name and one button', async () => {
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.checkStatus()
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="idle"/)
  assert.match(html, /data-connect-field="name"/)
  assert.equal(/data-connect-field="name"[^>]*disabled/.test(html), false, 'the name is editable before the press')
  assert.match(html, /data-connect-action="begin"/)
  rig.controller.destroy()
})

test('the waiting state shows the code, the three steps, the address and the time left', async () => {
  const rig = harness({ bridge: workingBridge() })
  await rig.controller.begin()
  const html = rig.controller.markup()
  assert.match(html, new RegExp(`value="${CODE}"`), 'the code is on the screen')
  assert.match(html, /class="connect-code"/, 'and it is the element the stylesheet sizes large')
  assert.match(html, /readonly/, 'selectable by keyboard and mouse, editable by neither')
  assert.match(html, /Sign in at/)
  assert.match(html, new RegExp(ACCOUNT_PAGE_HOST.replace('.', '\\.')))
  assert.match(html, /Open your account page/)
  assert.match(html, /Enter the code above/)
  assert.match(html, /Stops working in \d+:\d\d\./, 'the time left is shown, and it is a real number')
  assert.match(html, /data-connect-action="cancel"/, 'and a way to stop waiting')
  rig.controller.destroy()
})

test('an already-connected computer shows the state instead of the connect button, and the way out', async () => {
  const rig = harness({ bridge: joinedBridge() })
  await rig.controller.checkStatus()
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="connected"/)
  assert.match(html, /This computer is joined as Front desk/)
  assert.equal(/data-connect-action="begin"/.test(html), false, 'no button to do what is already done')
  assert.match(html, new RegExp(`sign in at ${ACCOUNT_PAGE_HOST.replace('.', '\\.')} and open your account page`, 'i'),
    'taking the ROW off the account is named, and it is not a screen in this application')
  /* SEEN ON GLASS before this was fixed: with no button drawn anywhere on the
     row, it still read "Nothing is sent until you press the button" -- a
     sentence about a control that was not there. */
  assert.equal(/press the button/.test(html), false,
    'the row still describes a control that is not on the screen')
  assert.match(html, /already joined/)
  /* THE TWO CONTROLS A JOINED COMPUTER HAS: the web-drive switch, which the
     refusal a browser meets names and which must therefore be here, and
     "Disconnect this computer", which clears what this machine holds. */
  assert.match(html, new RegExp(WEB_DRIVE_CONTROL_LABEL), 'the switch the refusal sentence names is not drawn')
  assert.match(html, /whether a signed-in browser may drive it/)
  assert.match(html, /data-connect-action="disconnect"/, 'the way out of the joined state is not drawn')
  assert.ok(html.includes(DISCONNECT_ACTION_LABEL), 'the control is not labelled as what it does')
  assert.match(html, /data-connect-action="disconnect" aria-pressed="false"/, 'the control is drawn armed, or without its pressed state')
  assert.match(html, /data-connect-disconnect-hint hidden/, 'the hint slot the first press fills is missing')
  assert.match(html, /or disconnect it from here/, 'the row does not name the control it carries')
  assert.equal(/Removing it is done on your account page in a browser/.test(html), false,
    'the row still says the account page is the only way out')
  assert.match(html, /Taking it off there does not change what this computer holds/,
    'removing it on the account page does not clear the credential, and the screen must say so')
  assert.ok(html.includes(`use \u201c${DISCONNECT_ACTION_LABEL}\u201d below`), 'and the sentence points at the control that does')
  assert.equal(/nothing in this window can clear it/.test(html), false, 'the screen still says it cannot do what it now does')
  rig.controller.destroy()
})

/* ---------- "Disconnect this computer" ---------- */

test('the first press arms the control and writes nothing; the second calls disconnect once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const rig = harness({ bridge: joinedBridge({ disconnect: async () => { calls.push('disconnect'); return { ok: true, wasConnected: true } } }) })
  const root = fakeRoot()
  rig.controller.bind(root)
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'connected')
  const button = fakeButton('disconnect')
  const press = () => root.listeners.get('click')({ target: button })

  press()
  assert.deepEqual(calls, [], 'a single press must not disconnect anything')
  assert.equal(button.dataset.armed, 'true', 'the first press did not arm the control')
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.equal(root.hint.hidden, false, 'the hint under the control is not shown')
  assert.equal(root.hint.textContent, DISCONNECT_ARMED_HINT)
  assertHumanSentence(root.hint.textContent, 'the armed hint')
  assert.match(root.hint.textContent, /Press again/)
  assert.match(root.hint.textContent, /does not take the computer off your account/)
  assert.match(root.hint.textContent, /still counts toward your limit/)
  assert.equal(rig.controller.getState().phase, 'connected', 'arming moved the state')

  press()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['disconnect'], 'the second press did not call disconnect exactly once')
  assert.equal(button.dataset.armed, undefined, 'the control stayed armed after acting')
  assert.equal(root.hint.hidden, true, 'the hint outlived the arm')
  assert.equal(rig.controller.getState().phase, 'disconnect-review', 'an unqualified legacy receipt must not confirm cleanup')
  rig.controller.destroy()
})

test('a lone first press disarms itself after eight seconds and takes the hint with it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const rig = harness({ bridge: joinedBridge({ disconnect: async () => { calls.push('disconnect'); return { ok: true, wasConnected: true } } }) })
  const root = fakeRoot()
  rig.controller.bind(root)
  await rig.controller.checkStatus()
  const button = fakeButton('disconnect')
  root.listeners.get('click')({ target: button })
  assert.equal(root.hint.hidden, false)
  t.mock.timers.tick(7999)
  assert.equal(button.dataset.armed, 'true', 'disarmed inside the window, so a careful reader is ignored')
  assert.equal(root.hint.hidden, false)
  t.mock.timers.tick(1)
  assert.equal(button.dataset.armed, undefined, 'a lone press must disarm itself so the label never lies')
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  assert.equal(root.hint.hidden, true, 'the hint outlived the arm')
  assert.equal(root.hint.textContent, '')
  assert.deepEqual(calls, [], 'a lone press disconnected something')
  assert.equal(rig.controller.getState().phase, 'connected')
  /* After the disarm, the next press is a first press again. */
  root.listeners.get('click')({ target: button })
  assert.equal(button.dataset.armed, 'true')
  assert.deepEqual(calls, [])
  rig.controller.destroy()
})

test('confirmed removal is shown, and a read-only absence check restores the fresh-code control', async () => {
  const rig = harness({ bridge: confirmedDisconnectBridge() })
  await rig.controller.checkStatus()
  assert.ok(rig.controller.markup().includes(WEB_DRIVE_CONTROL_LABEL), 'the joined screen draws the web-drive setting')
  await rig.controller.disconnect()
  const state = rig.controller.getState()
  assert.equal(state.phase, 'disconnect-review')
  assert.equal(state.device, null)
  assert.equal(state.refusal, '')
  const removed = rig.controller.markup()
  assert.match(removed, /This computer no longer holds its account connection/)
  assert.match(removed, /It is still listed on your account page until you remove it there/)
  assert.doesNotMatch(removed, /data-connect-action="begin"/, 'current absence still needs a read-only check')
  assert.doesNotMatch(removed, /data-connect-action="disconnect"/, 'completed cleanup needs no further mutation')
  await rig.controller.checkStatus({ readOnly: true })
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="idle"/)
  assert.match(html, /No connection credential was found/)
  assert.match(html, /data-connect-action="begin"/, 'the connect button is back')
  assert.equal(/data-connect-action="disconnect"/.test(html), false, 'the control outlived the connection')
  assert.equal(html.includes(WEB_DRIVE_CONTROL_LABEL), false, 'the web-drive setting outlived the connection')
  assert.equal(/not on an account yet/.test(html), false, 'a computer that was joined a second ago is not "not yet"')
  rig.controller.destroy()
})

test('a disconnect of a computer that held nothing says so rather than claiming a success', async () => {
  const rig = harness({ bridge: joinedBridge({ disconnect: async () => ({ ok: true, wasConnected: false,
    credentialCleared: true, mutationOutcome: 'NOT_ATTEMPTED', ...stoppedConnection }) }) })
  await rig.controller.checkStatus()
  await rig.controller.disconnect()
  assert.equal(rig.controller.getState().phase, 'disconnect-review')
  const html = rig.controller.markup()
  assert.match(html, /There was no connection credential to remove/)
  assert.match(html, /removal step did not write a change/)
  assert.equal(/no longer holds its account connection/.test(html), false)
  assert.match(html, /data-connect-action="check-status"/)
  assert.doesNotMatch(html, /data-connect-action="begin"/)
  rig.controller.destroy()
})

test('asking for a code after a disconnect stops narrating the disconnect', async () => {
  const rig = harness({ bridge: confirmedDisconnectBridge() })
  await rig.controller.checkStatus()
  await rig.controller.disconnect()
  await rig.controller.checkStatus({ readOnly: true })
  await rig.controller.begin()
  assert.equal(rig.controller.getState().phase, 'waiting')
  assert.equal(rig.controller.getState().disconnected, null)
  rig.controller.destroy()
})

test('a refused disconnect is a sentence beside explicit recovery and does not claim the computer stayed joined', async () => {
  const rig = harness({
    bridge: joinedBridge({
      disconnect: async () => ({ ok: false, code: 'DEVICE_CLAIM_DISCONNECT_FAILED', reason: 'This computer could not clear its account connection. Nothing changed.' }),
    }),
  })
  await rig.controller.checkStatus()
  await rig.controller.disconnect()
  const state = rig.controller.getState()
  assert.equal(state.phase, 'disconnect-review', 'an uncertain credential outcome must expire the old joined claim')
  assert.equal(state.refusalCode, 'DEVICE_CLAIM_DISCONNECT_FAILED')
  assert.equal(state.refusalPressed, true, 'the person pressed this; it is an alert')
  assertHumanSentence(state.refusal, 'the disconnect refusal')
  assert.match(state.refusal, /did not return a complete confirmation/)
  assert.match(state.refusal, /Check connection status/)
  assert.doesNotMatch(state.refusal, /Nothing changed|Try once more|restart/i)
  const html = rig.controller.markup()
  assert.equal((html.match(/data-connect-refusal/g) || []).length, 1, 'drawn once')
  assert.match(html, /role="alert"/)
  assert.match(html, /data-refusal-code="DEVICE_CLAIM_DISCONNECT_FAILED"/)
  assert.equal(/DEVICE_CLAIM_DISCONNECT_FAILED/.test(html.replace(/<[^>]*>/g, ' ')), false, 'the code is on the glass')
  /* Where the press was: inside the body, directly above the control. */
  const fieldsAt = html.indexOf('fleet-profile-fields')
  const refusalAt = html.indexOf('data-connect-refusal')
  const buttonAt = html.indexOf('data-connect-action="disconnect"')
  assert.ok(fieldsAt >= 0 && fieldsAt < refusalAt && refusalAt < buttonAt, 'the refusal is not beside the control that produced it')
  assert.equal(html.includes(WEB_DRIVE_CONTROL_LABEL), false, 'the Drive control must not survive an uncertain disconnect')
  rig.controller.destroy()
})

test('a thrown disconnect is a sentence too, never a silent press', async () => {
  const rig = harness({ bridge: joinedBridge({ disconnect: async () => { throw new Error('DEVICE_CLAIM_DISCONNECT_FAILED') } }) })
  await rig.controller.checkStatus()
  await rig.controller.disconnect()
  const state = rig.controller.getState()
  assert.equal(state.phase, 'disconnect-review')
  assertHumanSentence(state.refusal, 'the thrown disconnect sentence')
  rig.controller.destroy()
})

test('finishing an uncertain disconnect still requires two explicit presses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const rig = harness({ bridge: joinedBridge({ disconnect: async () => {
    calls.push('disconnect')
    return { ok: false, mutationOutcome: 'UNCERTAIN', ...stoppedConnection, disconnectPending: true }
  } }) })
  const root = fakeRoot(); rig.controller.bind(root)
  await rig.controller.checkStatus(); await rig.controller.disconnect()
  assert.deepEqual(calls, ['disconnect'])
  assert.match(rig.controller.markup(), /Finish disconnect/)
  const button = fakeButton('disconnect')
  root.listeners.get('click')({ target: button })
  assert.deepEqual(calls, ['disconnect'])
  assert.match(root.hint.textContent, /Finish disconnect\? Press again/)
  root.listeners.get('click')({ target: button })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['disconnect', 'disconnect'])
  assert.equal(rig.controller.getState().phase, 'disconnect-review')
  rig.controller.destroy()
})

test('an unresolved disconnect immediately removes joined controls and prevents duplicate actions', async () => {
  let finish
  const calls = []
  const rig = harness({ bridge: joinedBridge({ disconnect: () => {
    calls.push('disconnect'); return new Promise(resolve => { finish = resolve })
  } }) })
  await rig.controller.checkStatus()
  const pending = rig.controller.disconnect()
  assert.equal(rig.controller.getState().phase, 'disconnecting')
  const html = rig.controller.markup()
  assert.match(html, /Disconnecting this computer/)
  assert.match(html, /data-connect-action="check-status" disabled/)
  assert.doesNotMatch(html, /data-connect-field="web-drive"|data-connect-action="begin"/)
  await rig.controller.disconnect(); await rig.controller.begin(); await rig.controller.checkStatus({ readOnly: true })
  assert.deepEqual(calls, ['disconnect'])
  finish({ ok: false, mutationOutcome: 'UNCERTAIN' }); await pending
  assert.equal(rig.controller.getState().phase, 'disconnect-review')
  rig.controller.destroy()
})

test('a shell without the verb draws no control, says so honestly, and still connects', async () => {
  const older = joinedBridge()
  delete older.disconnect
  const rig = harness({ bridge: older })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'connected', 'an older shell read as absent')
  const html = rig.controller.markup()
  assert.equal(/data-connect-action="disconnect"/.test(html), false, 'a control that cannot be carried out was drawn')
  assert.equal(html.includes(DISCONNECT_ACTION_LABEL), false, 'the control is named where it is not drawn')
  assert.equal(/or disconnect it from here/.test(html), false, 'the row names a control that is not there')
  assert.match(html, /this screen will keep saying it is joined/, 'the older truth is what an older shell says')
  assert.match(html, new RegExp(WEB_DRIVE_CONTROL_LABEL), 'the switch is still drawn')
  /* A press delivered anyway -- a stale page, a driver -- calls nothing. */
  await rig.controller.disconnect()
  assert.equal(rig.controller.getState().phase, 'connected')
  rig.controller.destroy()

  /* And the same older shell still runs the whole ceremony. */
  const idle = workingBridge()
  delete idle.disconnect
  const connecting = harness({ bridge: idle })
  await connecting.controller.checkStatus()
  assert.equal(connecting.controller.getState().phase, 'idle')
  await connecting.controller.begin()
  assert.equal(connecting.controller.getState().phase, 'waiting')
  connecting.controller.destroy()
})

test('a browser reading through the relay is never offered the control', async () => {
  /* The joined phase is not reachable over the relay (there is no bridge
     there), and the rule is held anyway: a bridge that somehow answered
     "joined" to a relay reader still draws nothing that disconnects the
     machine the page is arriving through. */
  const rig = harness({ bridge: joinedBridge(), viaRelay: true })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'connected')
  const html = rig.controller.markup()
  assert.equal(/data-connect-action="disconnect"/.test(html), false, 'a browser was offered a way to disconnect the machine it is reading through')
  assert.equal(html.includes(DISCONNECT_ACTION_LABEL), false)
  await rig.controller.disconnect()
  assert.equal(rig.controller.getState().phase, 'connected', 'a relay reader disconnected the machine')
  rig.controller.destroy()

  const absent = harness({ bridge: null, viaRelay: true })
  await absent.controller.checkStatus()
  assert.equal(/data-connect-action=/.test(absent.controller.markup()), false)
  absent.controller.destroy()
})

test('the disconnect control is reachable by the words a person would type', () => {
  const rig = harness({ bridge: workingBridge() })
  for (const typed of ['disconnect', 'disconnect this computer', 'unlink', 'leave account', 'clear connection']) {
    assert.equal(rig.controller.matches(typed), true, `"${typed}" does not find this section`)
  }
  rig.controller.destroy()
})

test('an expired code is a screen with a way out of it', async () => {
  const rig = harness({
    bridge: workingBridge({
      poll: async () => ({ ok: false, code: 'DEVICE_CLAIM_GONE', reason: 'That code is no longer open.' }),
    }),
  })
  await rig.controller.begin()
  await rig.controller.pollOnce()
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="ended"/)
  assert.match(html, /data-connect-action="restart"/, 'a new code is one press away')
  assert.match(html, /data-refusal-code="DEVICE_CLAIM_GONE"/, 'the identifier rides in the attribute')
  const visible = html.replace(/<[^>]*>/g, ' ')
  assert.equal(/DEVICE_CLAIM_GONE/.test(visible), false, 'and never in what a person reads')
  rig.controller.destroy()
})

test('the search box finds this section by the words somebody stuck would type', () => {
  const rig = harness({ bridge: workingBridge() })
  for (const term of ['connect', 'code', 'account', 'computer', 'sign up', 'pair']) {
    assert.equal(rig.controller.matches(term), true, `"${term}" does not find this section`)
  }
  assert.equal(rig.controller.matches('sankey gradient'), false, 'and it does not match everything')
  rig.controller.destroy()
})

/* ---------- source pins ---------- */

test('the poll timer is cleared on teardown, and the latch goes up before it', () => {
  /* The observed tests above prove the behaviour. This pins the SHAPE, because
     the failure mode is asynchronous: a request already on the wire resolving
     into startClock() after destroy() returns. Order matters -- clearing the
     interval without latching leaves the next continuation free to arm a new
     one -- so the order is asserted, not only the presence. */
  const source = read('src/connect-computer-settings.js')
  const destroy = source.slice(source.indexOf('function destroy()'))
  const body = destroy.slice(0, destroy.indexOf('\n  }'))
  assert.ok(body.includes('stopClock()'), 'destroy() no longer clears the interval')
  assert.ok(body.indexOf('torn = true') < body.indexOf('stopClock()'),
    'the latch must go up before the clock is released, or a late answer re-arms it')
  assert.ok(source.includes('cancelTimer(clock)'), 'stopClock() no longer releases the handle')
  assert.equal((source.match(/setInterval\(/g) || []).length, 1,
    'there is exactly one interval in this section, and it has one place it is released')
  assert.equal((source.match(/setTimeout\(/g) || []).length, 0,
    'a second kind of timer would need a second teardown nobody would remember')
  for (const continuation of source.match(/if \(torn[^)]*\) return/g) || []) {
    assert.ok(continuation.includes('torn'), continuation)
  }
  assert.ok((source.match(/if \(torn/g) || []).length >= 5,
    'every continuation that can outlive the screen checks the latch')
})

test('the settings page renders the section and tears it down with the rest', () => {
  const source = read('src/views/settings.js')
  assert.ok(source.includes("from '../connect-computer-settings.js'"), 'the page imports the section')
  assert.ok(source.includes('createConnectComputerSettings()'), 'and builds its controller')
  assert.ok(source.includes('connectController.bind(root)'),
    'an unbound controller renders live-looking controls that do nothing when pressed')
  assert.ok(source.includes('connectController.afterRender(root)'), 'and is told when the page repainted')
  const destroy = source.slice(source.indexOf('    destroy() {'))
  assert.ok(destroy.slice(0, destroy.indexOf('\n    }')).includes('connectController.destroy()'),
    'leaving Settings must stop the section’s clock')
})

test('the section is placed inside a group rather than left to fall off the end', () => {
  /* THIS USED TO PIN THE SHIM; IT NOW PINS THE OUTCOME THE SHIM EXISTED FOR.
   *
   * src/settings-presentation.js states the rule: a section in no group renders
   * after every group, which for a first-run step is the same as hiding it.
   * Until 2026-08-22 the shared table did not name this section and
   * src/views/settings.js hand-placed it, so this test asserted that the
   * hand-placement was present and self-cancelling. The table names it now, the
   * branch is deleted, and asserting on the branch would be asserting that the
   * workaround is still there.
   *
   * WHAT THE SHIM COST WHILE IT LIVED is what the last assertion here guards.
   * The section rendered in the right place, so nothing looked broken -- but
   * the group head prints `group.sections` while CLOSED, and that line is the
   * page's whole answer to "find something without opening anything". A section
   * outside the model is not in that array, so the closed 'Start here' line
   * read "Home screen · Setup · System" and never said the words the owner
   * used: "as a user I dont even see how after signing up that I now connect
   * my computer". */
  const group = groupOfSection(CONNECT_SECTION)
  assert.ok(group, `${CONNECT_SECTION} is in no group and would render below every group`)
  assert.equal(group.id, 'start', 'the connect step belongs to the first-visit group')
  assert.ok(group.sections.indexOf(CONNECT_SECTION) < group.sections.indexOf('Setup'),
    'a person who has just signed up meets connection setup before the record of what setup asked them')

  /* ONE PLACEMENT MECHANISM, NOT TWO. A second way to put a section on this
     page is how a page ends up with two ideas of where things go -- and if both
     fired at once the section would render twice. */
  const source = read('src/views/settings.js')
  for (const shim of ['CONNECT_HOME_GROUP', 'placedSections', 'connectIsPlacedByThisPage', 'homeGroupOf']) {
    assert.equal(new RegExp(`^(?!\s*[*/]).*\b${shim}\b`, 'm').test(source), false,
      `${shim} is still live code; the hand-placement was retired, so this is a second placement mechanism`)
  }

  /* And the closed group line -- the findability sentence -- really does name
     it, which is the half a reader feels. */
  assert.ok(group.sections.includes(CONNECT_SECTION),
    'the closed group head lists group.sections; a section missing from it cannot be found without opening the group')
})

test('a link can reach the step that connects this computer', () => {
  /* Until this id existed nothing in the product could send a person to the one
     screen that joins this computer to their account: the row is not in
     SETTINGS (it is the installed application's business, like the research
     rows), so requestedSetting() resolved nothing and the best any link could do
     was drop somebody at the top of Settings. Driven end to end by
     tools/test-account-harness drivers; pinned here so the id, the row's stamp
     and the page's resolver cannot drift apart. */
  assert.equal(typeof CONNECT_SETTING_ID, 'string')
  assert.ok(CONNECT_SETTING_ID.length > 0, 'the connect row needs a landable id')
  const rig = harness({ bridge: workingBridge() })
  assert.match(rig.controller.markup(), new RegExp(`data-setting-id="${CONNECT_SETTING_ID}"`),
    'the connect row does not expose the id a settings link lands on')
  rig.controller.destroy()
  const page = read('src/views/settings.js')
  assert.ok(page.includes('if (id === CONNECT_SETTING_ID) return { id, section: CONNECT_SECTION, depth: 1 }'),
    'requestedSetting must resolve the connect id, or a link that names it lands nowhere')
})
