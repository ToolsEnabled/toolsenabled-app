/* NOTIFICATIONS THAT ARE ACTUALLY DELIVERED, AND THE ONE CASE WHERE THEY MUST
 * NOT BE.
 *
 * WHAT WAS MEASURED BEFORE THIS LANE. `Notification` appeared ZERO times in
 * shell/ and src/. Nothing in this product had ever raised one: an agent could
 * finish an hour of work, or die on its second turn, and the only way to find
 * out was to go and look at the page it happened on. This is not a suite about
 * an unreliable feature; it is the first suite about a feature that exists.
 *
 * WHAT IT DRIVES RATHER THAN ASSERTS.
 *
 *   1  THE WHOLE STORAGE CHAIN, with no stand-in in the middle of it. The
 *      settings page writes `mc.set.<id>` through window.localStorage; in the
 *      product that store is public/durable-storage.js, which forwards to
 *      `mc-prefs:write`, which is shell/renderer-prefs.cjs. This file runs the
 *      REAL durable-storage.js in a vm over a bridge wired to a REAL
 *      renderer-prefs on a REAL temporary directory, writes the exact string
 *      the settings row writes, and then hands that same store to the notifier.
 *      Nothing between the switch and the notification is simulated except the
 *      IPC hop and the platform that draws the toast.
 *
 *   2  ALL FOUR COMBINATIONS OF FOCUS AND WHAT IS ON SCREEN, because the rule
 *      is a conjunction and a suite that drove only the true case would pass
 *      against a seam that suppressed on focus alone.
 *
 *   2b BOTH ENDINGS THIS PRODUCT HAS, and the overlap between them. The row
 *      "tell me when an agent stops with a problem" shipped, on the day it
 *      landed, wired to `turn_completed` alone -- so a child that died between
 *      prompts, was killed, or ran the machine out of memory while idle
 *      produced an audit line and complete silence. The second ending is driven
 *      here, and so is the case where one stop is seen through both doors and
 *      must still be one notification.
 *
 *   3  THE PLATFORM REFUSING. `Notification.isSupported()` false must be
 *      reported by name, not swallowed -- and it must be reported to the
 *      SETTINGS PAGE too, which is what disables the switches.
 *
 * WHAT IT PINS, and each pin is read out of the source so that deleting the
 * thing retires the claim in the same edit: the two settings rows and their
 * storage keys, the success-status allowlist against the renderer's own copy,
 * the name Windows knows this program by against the one its installer
 * registers, and every place shell/main.cjs, src/main.js and the preload have
 * to touch for any of this to run in the product at all.
 *
 * WHERE A PIN IS ALL THERE IS, AND WHY THERE ARE FEWER OF THOSE THAN THERE
 * WERE. A review of this lane mutated the expressions living inside the
 * Electron handlers -- the delivery answer, the bound on the reported session
 * id, the reading of focus -- and every suite stayed green, because a source
 * pin catches the DELETION of a line and nothing about what the line does.
 * Those decisions were moved into shell/agent-notifications.cjs, where section
 * 4d drives them with plain objects, and what is left pinned as text in
 * shell/main.cjs is genuinely Electron's: which frame sent a message, which
 * window object is current, and where a caller sits.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8')
const require = createRequire(import.meta.url)

const {
  MAX_REMEMBERED_STOPS,
  MISSING_TURN_STATUS,
  REASON,
  STOP_TRIGGER_ID,
  TRIGGERS,
  TURN_SUCCESS_STATUSES,
  attentionNow,
  createAgentNotifier,
  deliveryAnswerFor,
  triggerForEvent,
  triggerForSessionExit,
  watchedSessionFrom,
} = require('../../shell/agent-notifications.cjs')
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')

/* A recorder in the shape Electron's Notification is used in: the seam calls
   isSupported() and show({title, body}) and nothing else. `raised` is what a
   person would have seen. */
function platform({ supported = true, throws = false } = {}) {
  const raised = []
  return {
    raised,
    isSupported: () => supported,
    show: (options) => {
      if (throws) throw new Error('the notification service refused this one')
      raised.push(options)
    },
  }
}

/* THE REAL SETTINGS STORE, on a real temporary directory. Returned with its
   own cleanup so a failing assertion cannot leave a directory behind. */
function realStore(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mc-notify-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  return { directory, prefs: createRendererPrefs({ directory, fs, path, randomUUID }) }
}

/* THE PAGE'S HALF OF THE CHAIN: the shipped public/durable-storage.js, run for
   real, over a bridge that forwards to the renderer-prefs instance handed in.
   This is what makes `localStorage.setItem('mc.set.…', 'true')` in this file the
   same act writeStored() performs in src/views/settings.js. */
function pageStorage(prefs) {
  const window = {
    localStorage: { length: 0, key: () => null, getItem: () => null },
    mcPrefs: {
      available: true,
      values: { ...prefs.snapshot().values },
      drainRequired: false,
      drain: () => ({ ok: true, values: prefs.snapshot().values }),
      write: (key, value) => prefs.set(key, value),
      remove: key => prefs.remove(key),
      clear: () => prefs.clear(),
    },
  }
  vm.runInNewContext(read('public/durable-storage.js'), { window })
  return window.localStorage
}

/* ---------- 1. THE CHAIN, END TO END ---------- */

test('the switch a person presses is the byte the notifier reads, through the real store', (t) => {
  const { directory, prefs } = realStore(t)
  const storage = pageStorage(prefs)
  const shown = platform()
  const notifier = createAgentNotifier({
    notifications: shown,
    prefs,
    attention: () => ({ focused: false, sessionId: null }),
  })

  /* THE SHIPPED DEFAULT. src/views/settings.js declares `def: false` for both
     rows and writeStored() REMOVES a row's key when its value equals the
     default, so "off" on disk is the absence of a key. Nothing has been
     written here, which is the state of a fresh install. */
  const finished = { sessionId: 'session-1', event: { type: 'turn_completed', status: 'completed' } }
  assert.deepEqual(notifier.consider(finished), {
    delivered: false, reason: REASON.switchedOff, trigger: 'agent-finished',
  }, 'a fresh install notified somebody who had not asked to be notified')
  assert.equal(shown.raised.length, 0, 'the platform was asked to draw a notification nobody switched on')

  /* THE PRESS. This is exactly what the settings row does: the same key, the
     same string, through the same store the product ships. */
  storage.setItem('mc.set.notify_agent_finished', 'true')

  /* IT REACHED THE FILE, not just the page's own copy. Re-read from a second
     renderer-prefs over the same directory, so this is the bytes on disk. */
  const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(reopened.snapshot().values['mc.set.notify_agent_finished'], 'true',
    'the settings write did not reach the durable settings file')

  const delivered = notifier.consider(finished)
  assert.deepEqual(delivered, { delivered: true, reason: REASON.delivered, trigger: 'agent-finished' })
  assert.deepEqual(shown.raised, [{ title: TRIGGERS['agent-finished'].title, body: TRIGGERS['agent-finished'].body }],
    'the notification a person would have seen is not the one this trigger declares')

  /* AND TURNING IT OFF TAKES EFFECT ON THE NEXT EVENT, not the next launch --
     the seam re-reads the row every time rather than capturing it. */
  storage.removeItem('mc.set.notify_agent_finished')
  assert.equal(notifier.consider(finished).delivered, false, 'the row was captured at construction instead of read per event')
  assert.equal(shown.raised.length, 1, 'a switched-off row still reached the platform')
})

test('each row switches only its own trigger', (t) => {
  const { prefs } = realStore(t)
  const storage = pageStorage(prefs)
  const shown = platform()
  const notifier = createAgentNotifier({
    notifications: shown,
    prefs,
    attention: () => ({ focused: false, sessionId: null }),
  })
  const finished = { sessionId: 's', event: { type: 'turn_completed', status: 'success' } }
  const stopped = { sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }

  storage.setItem('mc.set.notify_agent_error', 'true')
  assert.equal(notifier.consider(finished).delivered, false, 'the stop row also switched on the finish notification')
  assert.equal(notifier.consider(stopped).delivered, true, 'the stop row did not switch on the stop notification')
  assert.deepEqual(shown.raised, [{ title: TRIGGERS['agent-error'].title, body: TRIGGERS['agent-error'].body }])
})

/* ---------- 2. THE HARD PART ---------- */

test('a notification is suppressed only when the window has focus AND that session is on screen', (t) => {
  /* THE RULE IS A CONJUNCTION, so all four corners are driven. A seam that
     suppressed on focus alone passes three of these and fails the second. */
  const cases = [
    { focused: true, onScreen: 'session-1', deliver: false, why: 'watching that very session, with the window in front' },
    { focused: true, onScreen: 'session-2', deliver: true, why: 'the window has focus but another agent is on screen' },
    { focused: false, onScreen: 'session-1', deliver: true, why: 'that agent is on screen behind another window' },
    { focused: false, onScreen: null, deliver: true, why: 'nothing of ours is on screen at all' },
  ]
  for (const shape of cases) {
    const { prefs } = realStore(t)
    pageStorage(prefs).setItem('mc.set.notify_agent_finished', 'true')
    const shown = platform()
    const notifier = createAgentNotifier({
      notifications: shown,
      prefs,
      attention: () => ({ focused: shape.focused, sessionId: shape.onScreen }),
    })
    const answer = notifier.consider({ sessionId: 'session-1', event: { type: 'turn_completed', status: 'completed' } })
    assert.equal(answer.delivered, shape.deliver, `wrong answer when ${shape.why}`)
    assert.equal(shown.raised.length, shape.deliver ? 1 : 0,
      `the platform was ${shape.deliver ? 'not asked' : 'asked'} to draw one when ${shape.why}`)
    if (!shape.deliver) assert.equal(answer.reason, REASON.alreadyWatching, 'the suppression was not reported as already-on-screen')
  }
})

test('who is paying attention is asked at the moment of the event, never at construction', (t) => {
  /* THE SAME RULE THE SETTINGS ROW KEEPS, and the header says so in the same
     words: it has to be true NOW. A notifier that read focus and the session on
     screen once would have been built at PRELOAD time in the product -- before
     any window had focus and before any page had reported anything -- and would
     then have answered "unfocused, nothing on screen" for the life of the
     application, which delivers every time. Suppression would be dead and every
     other test in this file would still pass. */
  const { prefs } = realStore(t)
  pageStorage(prefs).setItem('mc.set.notify_agent_finished', 'true')
  const shown = platform()
  let now = { focused: false, sessionId: null }
  let asked = 0
  const notifier = createAgentNotifier({
    notifications: shown, prefs, attention: () => { asked += 1; return now },
  })
  const finished = { sessionId: 'session-1', event: { type: 'turn_completed', status: 'completed' } }

  assert.equal(notifier.consider(finished).delivered, true, 'nobody was told while nothing was on screen')
  now = { focused: true, sessionId: 'session-1' }
  assert.equal(notifier.consider(finished).reason, REASON.alreadyWatching,
    'the person walked over to that agent and was interrupted about it anyway')
  now = { focused: false, sessionId: 'session-1' }
  assert.equal(notifier.consider(finished).delivered, true, 'the window lost focus and the seam kept the old answer')
  assert.equal(asked, 3, 'the attention probe was not asked once per decision')
  assert.equal(shown.raised.length, 2)
})

test('a report the page could not have meant buys no silence', (t) => {
  /* Every one of these is a way the "what is on screen" record can be wrong,
     and every one of them must DELIVER: a missing notification is the defect
     this whole feature exists to remove, so doubt resolves towards telling
     somebody. */
  const shapes = [
    ['the attention probe threw', () => { throw new Error('the window is going') }],
    ['it answered nothing at all', () => null],
    ['it answered a shape with no focus field', () => ({ sessionId: 'session-1' })],
    ['focus was a truthy non-boolean', () => ({ focused: 'yes', sessionId: 'session-1' })],
    ['the session on screen was the empty string and so was the event\'s', () => ({ focused: true, sessionId: '' })],
  ]
  for (const [why, attention] of shapes) {
    const { prefs } = realStore(t)
    pageStorage(prefs).setItem('mc.set.notify_agent_finished', 'true')
    const shown = platform()
    const notifier = createAgentNotifier({ notifications: shown, prefs, attention })
    const sessionId = why.includes('empty string') ? '' : 'session-1'
    assert.equal(notifier.consider({ sessionId, event: { type: 'turn_completed', status: 'completed' } }).delivered,
      true, `nobody was told when ${why}`)
    assert.equal(shown.raised.length, 1, `the platform was not asked to draw one when ${why}`)
  }
})

/* ---------- 3. REFUSING BY NAME ---------- */

test('a computer that cannot show notifications is answered by name, not with silence', (t) => {
  const { prefs } = realStore(t)
  pageStorage(prefs).setItem('mc.set.notify_agent_finished', 'true')
  const shown = platform({ supported: false })
  const notifier = createAgentNotifier({
    notifications: shown, prefs, attention: () => ({ focused: false, sessionId: null }),
  })

  assert.equal(notifier.supported(), false, 'the seam claimed a platform that says no can show notifications')
  const answer = notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'completed' } })
  assert.deepEqual(answer, { delivered: false, reason: REASON.unsupported, trigger: 'agent-finished' },
    'an unsupported platform was reported as something other than unsupported')
  assert.equal(shown.raised.length, 0)
})

test('a platform that throws on show is reported, and an agent keeps working', (t) => {
  const { prefs } = realStore(t)
  pageStorage(prefs).setItem('mc.set.notify_agent_finished', 'true')
  const shown = platform({ throws: true })
  const notifier = createAgentNotifier({
    notifications: shown, prefs, attention: () => ({ focused: false, sessionId: null }),
  })
  const answer = notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'completed' } })
  assert.deepEqual(answer, { delivered: false, reason: REASON.showFailed, trigger: 'agent-finished' },
    'a notification that could not be raised was not reported as one')
})

test('a settings store that cannot be read answers off, and never on', (t) => {
  const shown = platform()
  const notifier = createAgentNotifier({
    notifications: shown,
    prefs: { snapshot: () => { throw new Error('the settings file could not be read') } },
    attention: () => ({ focused: false, sessionId: null }),
  })
  assert.equal(notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'completed' } }).reason,
    REASON.switchedOff, 'an unreadable settings file became an interruption')
  assert.equal(shown.raised.length, 0)
})

/* ---------- 4. WHICH EVENTS ARE TRIGGERS AT ALL ---------- */

test('the trigger an event asks for is the engine status word, read through the shared allowlist', () => {
  assert.equal(triggerForEvent({ type: 'turn_completed', status: 'completed' }).id, 'agent-finished', 'codex')
  assert.equal(triggerForEvent({ type: 'turn_completed', status: 'success' }).id, 'agent-finished', 'the Claude CLI')
  /* The host's own synthetic ending for a child that died mid-turn --
     shell/agent-host.cjs emits exactly this. */
  assert.equal(triggerForEvent({ type: 'turn_completed', status: 'failed' }).id, 'agent-error')
  assert.equal(triggerForEvent({ type: 'turn_completed', status: 'interrupted' }).id, 'agent-error',
    'an unrecognised ending was read as a success')
  assert.equal(triggerForEvent({ type: 'turn_completed' }).id, 'agent-finished',
    'a completion with no status word was not read the way the renderer reads it')

  for (const event of [null, undefined, {}, 'turn_completed', { type: 'assistant_text' },
    { type: 'tool_call' }, { type: 'usage' }, { type: 'approval_request' }]) {
    assert.equal(triggerForEvent(event), null, `${JSON.stringify(event)} was treated as a notifying event`)
  }
})

test('nothing but a declared trigger can reach the platform', (t) => {
  const { prefs } = realStore(t)
  const storage = pageStorage(prefs)
  storage.setItem('mc.set.notify_agent_finished', 'true')
  storage.setItem('mc.set.notify_agent_error', 'true')
  const shown = platform()
  const notifier = createAgentNotifier({
    notifications: shown, prefs, attention: () => ({ focused: false, sessionId: null }),
  })
  /* 'agent-approval' is in this list on purpose and is the one to read twice:
     the seam deliberately has no approval trigger, because nothing on this
     build raises an approval (approvalPolicy is `never` at every level -- see
     answerApproval() in shell/agent-host.cjs). A switch for it would move,
     save and never produce a notification. If one is ever added it must arrive
     WITH its event, and this line goes red on the day somebody adds only half. */
  for (const trigger of ['agent-approval', 'anything', '', null, undefined, {}, { id: 42 }, ['agent-finished']]) {
    assert.equal(notifier.deliver({ trigger }).reason, REASON.notATrigger, `${JSON.stringify(trigger)} was accepted as a trigger`)
  }
  assert.equal(shown.raised.length, 0, 'an undeclared trigger reached the platform')

  /* A CALLER MAY NAME A TRIGGER AND MAY NOT BE ONE. A forged record carrying a
     storage key nothing writes -- and so one nobody could ever switch off --
     is resolved back to the declared trigger by its id, so the switch that
     governs it and the words a person reads are the table's, never the
     caller's. */
  const forged = { id: 'agent-error', key: 'mc.set.nobody-can-turn-this-off', title: 'Buy something', body: 'Press here.' }
  assert.equal(notifier.deliver({ trigger: forged }).delivered, true)
  assert.deepEqual(shown.raised, [{ title: TRIGGERS['agent-error'].title, body: TRIGGERS['agent-error'].body }],
    'a caller-supplied record decided what the notification said')
})

/* ---------- 4b. THE SECOND ENDING ----------
 *
 * The one this feature did not have. shell/main.cjs calls the child's own exit
 * "the second genuine ending" eleven lines below where the first caller sits,
 * and nothing on that path notified. Everything below drives the real seam
 * through the real settings store, exactly as section 1 does. */

/* One switched-on notifier over a real store, so the tests below say what they
   are about rather than repeating four lines of setup. */
function notifierFor(t, { rows = ['mc.set.notify_agent_error'], attention = () => ({ focused: false, sessionId: null }) } = {}) {
  const { prefs } = realStore(t)
  const storage = pageStorage(prefs)
  for (const row of rows) storage.setItem(row, 'true')
  const shown = platform()
  return { shown, storage, notifier: createAgentNotifier({ notifications: shown, prefs, attention }) }
}

const exitOf = sessionId => ({ sessionId, exit: { code: 1, signal: null } })

test('an engine child that dies with no turn running is a stop, and the person is told', (t) => {
  const { shown, notifier } = notifierFor(t)

  /* A session that has done nothing but finish turns, and whose child then
     goes away. Before this ending was wired, this produced NOTHING. */
  notifier.consider({ sessionId: 'session-1', event: { type: 'turn_completed', status: 'completed' } })
  assert.equal(shown.raised.length, 0, 'the finish row is off, so nothing should have been raised yet')

  const answer = notifier.considerSessionEnd(exitOf('session-1'))
  assert.deepEqual(answer, { delivered: true, reason: REASON.delivered, trigger: 'agent-error' },
    'a child that died between prompts produced no notification')
  assert.deepEqual(shown.raised, [{ title: TRIGGERS['agent-error'].title, body: TRIGGERS['agent-error'].body }],
    'the second ending said something other than what the stop trigger declares')
})

test('one stop seen through both endings is one notification, in either order', (t) => {
  /* THE OVERLAP IS REAL AND IT IS THE HOST'S OWN DOING. A child that dies while
     a turn is running makes shell/agent-host.cjs emit a synthetic
     `turn_completed{status:'failed'}` so the surface is not left waiting, and
     observeEngineExit() reports the same death a moment later. Two doors, one
     stop. */
  const first = notifierFor(t)
  assert.equal(first.notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).delivered, true)
  const second = first.notifier.considerSessionEnd(exitOf('s'))
  assert.deepEqual(second, { delivered: false, reason: REASON.alreadyReported, trigger: 'agent-error' },
    'the child\'s exit told the person a second time about a stop they had already been told about')
  assert.equal(first.shown.raised.length, 1, 'one stop raised two notifications')

  /* The two can arrive the other way round -- the exit is watched on the
     child and the turn rejection comes off a promise chain -- so neither
     ordering may double. */
  const other = notifierFor(t)
  assert.equal(other.notifier.considerSessionEnd(exitOf('s')).delivered, true)
  assert.equal(other.notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).reason,
    REASON.alreadyReported, 'the turn ending told the person again after the exit had')
  assert.equal(other.shown.raised.length, 1, 'one stop raised two notifications when the exit came first')
})

test('an agent that answered since is stopped again for the first time', (t) => {
  /* THE MEMORY HAS TO CLEAR, or a session that failed a turn once -- out of
     credits, say -- and then went on working would never be able to report
     its real death. A SUCCESSFUL turn is the evidence that it is running. */
  const { shown, notifier } = notifierFor(t, { rows: ['mc.set.notify_agent_error', 'mc.set.notify_agent_finished'] })

  assert.equal(notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).delivered, true)
  assert.equal(notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'completed' } }).delivered, true,
    'the agent answered again and nobody was told')
  assert.equal(notifier.considerSessionEnd(exitOf('s')).delivered, true,
    'an agent that had worked since its last stop died silently')
  assert.deepEqual(shown.raised.map(entry => entry.title),
    [TRIGGERS['agent-error'].title, TRIGGERS['agent-finished'].title, TRIGGERS['agent-error'].title])
})

test('a stop nobody heard does not silence the ending behind it', (t) => {
  /* THE DIFFERENCE BETWEEN "ONE STOP, ONE NOTIFICATION" AND "ONE STOP, ONE
     DECISION", and it is a hole rather than a detail. Each case below is a
     first ending that reached NOBODY. If the seam remembered the decision
     rather than the delivery, the second ending -- the one that could have been
     heard -- would answer "already reported" and the person would get nothing
     at all for a stop they had asked to hear about. */

  /* 1. The row was off when the turn failed, and on by the time the child's
        exit arrived. A person switching it on must not inherit a silence. */
  const late = notifierFor(t, { rows: [] })
  assert.equal(late.notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).reason,
    REASON.switchedOff)
  late.storage.setItem('mc.set.notify_agent_error', 'true')
  assert.equal(late.notifier.considerSessionEnd(exitOf('s')).delivered, true,
    'a stop decided while the row was off silenced the ending that came after it')

  /* 2. They were watching that agent when the turn failed and had walked away
        by the time its child died. */
  let attention = { focused: true, sessionId: 's' }
  const walked = notifierFor(t, { attention: () => attention })
  assert.equal(walked.notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).reason,
    REASON.alreadyWatching)
  attention = { focused: false, sessionId: null }
  assert.equal(walked.notifier.considerSessionEnd(exitOf('s')).delivered, true,
    'a stop suppressed because somebody was watching silenced the ending they had walked away from')

  /* 3. The platform refused the first one. A refusal is not a delivery. */
  const { prefs } = realStore(t)
  pageStorage(prefs).setItem('mc.set.notify_agent_error', 'true')
  let refusing = true
  const raised = []
  const notifier = createAgentNotifier({
    notifications: {
      isSupported: () => true,
      show: (options) => { if (refusing) throw new Error('the notification service refused this one'); raised.push(options) },
    },
    prefs,
    attention: () => ({ focused: false, sessionId: null }),
  })
  assert.equal(notifier.consider({ sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }).reason, REASON.showFailed)
  refusing = false
  assert.equal(notifier.considerSessionEnd(exitOf('s')).delivered, true,
    'a notification the platform refused counted as having told somebody')
  assert.equal(raised.length, 1)
})

test('the memory of ended sessions is bounded, and the bound is the stated trade', (t) => {
  /* A MAIN PROCESS RUNS FOR WEEKS. An unbounded record of every session that
     ever stopped is a leak with no ceiling, so the set forgets its oldest
     entries -- and this asserts exactly what that costs, rather than leaving
     the number to be believed. The two endings of one stop arrive milliseconds
     apart, so a session can only be forgotten between them if this many OTHER
     sessions stopped in the gap, which is not a shape this product has. */
  const { shown, notifier } = notifierFor(t)
  assert.equal(notifier.consider({ sessionId: 'oldest', event: { type: 'turn_completed', status: 'failed' } }).delivered, true)
  for (let index = 0; index < MAX_REMEMBERED_STOPS; index += 1) {
    assert.equal(notifier.consider({ sessionId: `filler-${index}`, event: { type: 'turn_completed', status: 'failed' } }).delivered, true)
  }
  /* The newest are still remembered: the set did not simply stop recording. */
  assert.equal(notifier.considerSessionEnd(exitOf(`filler-${MAX_REMEMBERED_STOPS - 1}`)).reason, REASON.alreadyReported,
    'the most recent stop was forgotten, so the memory is not holding its own bound')
  /* And the oldest has been let go, which is the cost being paid. */
  assert.equal(notifier.considerSessionEnd(exitOf('oldest')).delivered, true,
    'nothing is ever forgotten, so this record grows without limit for the life of the process')
  assert.equal(shown.raised.length, MAX_REMEMBERED_STOPS + 2)
})

test('the memory of a stop belongs to its own session', (t) => {
  const { shown, notifier } = notifierFor(t)
  assert.equal(notifier.consider({ sessionId: 'one', event: { type: 'turn_completed', status: 'failed' } }).delivered, true)
  assert.equal(notifier.considerSessionEnd(exitOf('two')).delivered, true,
    'one agent stopping silenced a different agent stopping')
  assert.equal(notifier.considerSessionEnd(exitOf('one')).reason, REASON.alreadyReported)
  assert.equal(shown.raised.length, 2, 'two agents stopped and the person heard about one of them')
})

test('an ending nobody can name is told rather than silenced', (t) => {
  /* A report with no usable session id cannot be remembered, so it cannot be
     de-duplicated either. The rule everywhere in this file is that doubt
     notifies: an extra notification is a nuisance and a missing one is the
     defect. Two nameless endings therefore raise two, on purpose. */
  const { shown, notifier } = notifierFor(t)
  for (const report of [{ sessionId: null }, { sessionId: '' }, { sessionId: 42 }, {}]) {
    assert.equal(notifier.considerSessionEnd(report).delivered, true,
      `a stop was swallowed for a report shaped ${JSON.stringify(report)}`)
  }
  assert.equal(shown.raised.length, 4)
  /* And a report that is not a report at all is not an ending. */
  for (const report of [null, undefined, 'session-1', 7]) {
    assert.equal(notifier.considerSessionEnd(report).reason, REASON.notATrigger,
      `${JSON.stringify(report)} was treated as a session ending`)
    assert.equal(triggerForSessionExit(report), null)
  }
  assert.equal(shown.raised.length, 4, 'something that was not an exit report reached the platform')
})

test('the second ending is governed by the stop row, and by the same suppression', (t) => {
  /* IT IS THE SAME ROW A PERSON PRESSED, not a third switch and not an
     un-switchable path. With only the FINISH row on, an exit says nothing. */
  const off = notifierFor(t, { rows: ['mc.set.notify_agent_finished'] })
  assert.deepEqual(off.notifier.considerSessionEnd(exitOf('s')),
    { delivered: false, reason: REASON.switchedOff, trigger: 'agent-error' },
    'the child\'s exit notified somebody who had only asked about finishes')
  assert.equal(off.shown.raised.length, 0)

  /* And it is suppressed on the same conjunction: this window in front, and
     that very agent on screen. */
  const watching = notifierFor(t, { attention: () => ({ focused: true, sessionId: 's' }) })
  assert.equal(watching.notifier.considerSessionEnd(exitOf('s')).reason, REASON.alreadyWatching,
    'the child\'s exit interrupted somebody who was watching that agent')
  assert.equal(watching.shown.raised.length, 0)

  const elsewhere = notifierFor(t, { attention: () => ({ focused: true, sessionId: 'another' }) })
  assert.equal(elsewhere.notifier.considerSessionEnd(exitOf('s')).delivered, true,
    'the child\'s exit was suppressed while a different agent was on screen')
})

test('the trigger a session ending asks for is the stop row, whatever it exited with', () => {
  /* The host reports an exit only for a child that went away WITHOUT being
     asked -- observeEngineExit() suppresses the one that follows a close -- so
     there is no exit code that means "this was fine". */
  for (const exit of [{ code: 0, signal: null }, { code: 137, signal: 'SIGKILL' }, { code: null, signal: null }]) {
    const trigger = triggerForSessionExit({ sessionId: 's', exit })
    assert.equal(trigger.id, STOP_TRIGGER_ID, `an exit of ${JSON.stringify(exit)} was not read as a stop`)
    assert.equal(trigger.settingId, 'notify_agent_error')
  }
})

/* ---------- 4c. THE ROW IS THE WORD "true" AND NOTHING ELSE ---------- */

test('only the exact word the settings page writes switches a row on', (t) => {
  /* WHY THE EXACT STRING MATTERS. writeStored() in src/views/settings.js
     REMOVES a row's key when its value returns to the default, so off is the
     absence of a key -- but an explicit 'false' is reachable through an older
     store, a hand-edited settings file, or a future default. A reader that
     asked only whether the key EXISTED would turn every one of those into an
     interruption, which is the one direction this feature must never fail in. */
  const { prefs } = realStore(t)
  const storage = pageStorage(prefs)
  const shown = platform()
  const notifier = createAgentNotifier({
    notifications: shown, prefs, attention: () => ({ focused: false, sessionId: null }),
  })
  const stopped = { sessionId: 's', event: { type: 'turn_completed', status: 'failed' } }

  for (const written of ['false', 'FALSE', 'True', '1', 'yes', 'on', '', ' true', 'true ']) {
    storage.setItem('mc.set.notify_agent_error', written)
    assert.equal(notifier.consider(stopped).reason, REASON.switchedOff,
      `a row holding ${JSON.stringify(written)} was read as switched on`)
  }
  assert.equal(shown.raised.length, 0, 'something other than the word true reached the platform')

  storage.setItem('mc.set.notify_agent_error', 'true')
  assert.equal(notifier.consider(stopped).delivered, true, 'the word the settings page writes did not switch the row on')
  assert.equal(shown.raised.length, 1)
})

/* ---------- 4d. THE THREE HOPS BETWEEN THE SEAM AND THE PERSON ----------
 *
 * A review of this lane mutated each of these and the whole suite stayed green,
 * because each was a couple of expressions living inside an Electron handler in
 * shell/main.cjs where the only available guard is a source pin -- and a source
 * pin catches the deletion of a line and nothing about what the line does. The
 * decisions now live in the seam and are driven here; shell/main.cjs keeps only
 * what is genuinely a fact about Electron, and the pins in section 6 assert it
 * still calls these with the arguments that make them true. */

test('the page is told a notification works only when this computer says so', () => {
  /* An untrusted frame is answered no WITHOUT the seam being asked, because a
     frame that is not ours has no business starting anything at all. */
  let asked = 0
  assert.deepEqual(deliveryAnswerFor(false, () => { asked += 1; return true }), { supported: false })
  assert.equal(asked, 0, 'a frame that is not our own main frame reached the notifier')
  for (const trusted of [undefined, null, 0, 1, 'true', {}]) {
    assert.deepEqual(deliveryAnswerFor(trusted, () => true), { supported: false },
      `${JSON.stringify(trusted)} was accepted as a trusted sender`)
  }

  assert.deepEqual(deliveryAnswerFor(true, () => true), { supported: true })
  assert.deepEqual(deliveryAnswerFor(true, () => false), { supported: false })
  /* NOT-ESTABLISHED IS NOT "IT WORKS". Anything that is not the word true --
     an older shell, a platform that throws, a refusal record -- draws the
     disabled switch, which is what the settings page does with false. */
  for (const answer of [() => 'true', () => 1, () => undefined, () => null, () => { throw new Error('the platform is gone') }]) {
    assert.deepEqual(deliveryAnswerFor(true, answer), { supported: false },
      'an answer that was not the word true was rendered as a working notification service')
  }
})

test('the report of what is on screen is bounded, and every wrong shape means nothing is', () => {
  /* NULL IS THE ANSWER THAT DELIVERS, so every malformed report has to resolve
     to it. A report that could buy silence by being wrong would be a way to
     switch this feature off from the page. */
  assert.equal(watchedSessionFrom({ sessionId: 'session-1' }, 128), 'session-1')
  for (const value of [null, undefined, 'session-1', 42, [], {}, { sessionId: null }, { sessionId: '' }, { sessionId: 7 }, { session: 'x' }]) {
    assert.equal(watchedSessionFrom(value, 128), null, `${JSON.stringify(value)} was accepted as a session on screen`)
  }

  /* THE BOUND IS REAL AND IT IS THE CALLER'S. Exactly at the bound is kept;
     one character past it is nothing on screen, which notifies. */
  assert.equal(watchedSessionFrom({ sessionId: 'x'.repeat(128) }, 128), 'x'.repeat(128))
  assert.equal(watchedSessionFrom({ sessionId: 'x'.repeat(129) }, 128), null, 'an unbounded session id was stored')
  assert.equal(watchedSessionFrom({ sessionId: 'x'.repeat(9000) }, 128), null)
  /* A caller that hands over no usable bound gets no stored session rather
     than an unbounded one. */
  for (const bound of [undefined, null, 0, -1, '128', 1.5, NaN]) {
    assert.equal(watchedSessionFrom({ sessionId: 'session-1' }, bound), null,
      `${JSON.stringify(bound)} was accepted as a length bound`)
  }
})

test('focus is read off the window at the moment of the event, and doubt is not focus', () => {
  const live = { isDestroyed: () => false, isFocused: () => true }
  assert.deepEqual(attentionNow(live, 'session-1'), { focused: true, sessionId: 'session-1' })

  /* THE SESSION ON SCREEN IS CARRIED THROUGH, not invented and not dropped. A
     reading that always answered null here would make the suppression dead
     while every test of the seam itself stayed green. */
  assert.equal(attentionNow(live, 'session-2').sessionId, 'session-2')
  for (const value of [null, undefined, '', 42, {}]) {
    assert.equal(attentionNow(live, value).sessionId, null, `${JSON.stringify(value)} was carried as a session on screen`)
  }

  /* EVERY WAY A WINDOW CAN FAIL TO BE IN FRONT ANSWERS FALSE, and false is
     what tells the person. */
  const shapes = [
    ['there is no window', null],
    ['the window is gone', { isDestroyed: () => true, isFocused: () => true }],
    ['the window is behind something', { isDestroyed: () => false, isFocused: () => false }],
    ['focus was a truthy non-boolean', { isDestroyed: () => false, isFocused: () => 'yes' }],
    ['destroyed answered a truthy non-boolean', { isDestroyed: () => 'no', isFocused: () => true }],
    ['the window threw', { isDestroyed: () => false, isFocused: () => { throw new Error('gone') } }],
    ['it is not a window at all', {}],
  ]
  for (const [why, window] of shapes) {
    assert.equal(attentionNow(window, 'session-1').focused, false, `focus was claimed when ${why}`)
  }
})

/* ---------- 5. THE PINS: THE TWO COPIES THAT MUST NOT DRIFT ---------- */

test('every trigger names a settings row this page really draws, under the key that row writes', () => {
  const settings = read('src/views/settings.js')
  const catalogue = settings.slice(
    settings.indexOf('export const SETTINGS = ['),
    settings.indexOf('\nconst byId = new Map'),
  )
  assert.ok(catalogue.length > 0, 'the settings catalogue is not where this test expects it')

  for (const trigger of Object.values(TRIGGERS)) {
    assert.equal(trigger.key, `mc.set.${trigger.settingId}`,
      `${trigger.id} is read under a key that is not storageKey() of its own row`)
    const row = new RegExp(`id: '${trigger.settingId}',[\\s\\S]{0,600}?\\n  \\}`).exec(catalogue)
    assert.ok(row, `${trigger.settingId} is not a row in the settings catalogue`)
    assert.match(row[0], /section: 'Notifications'/, `${trigger.settingId} is not in the Notifications section`)
    assert.match(row[0], /type: 'toggle'/, `${trigger.settingId} is not a switch`)
    /* THE DEFAULT MUST BE OFF. This product does not opt people into
       interruptions, and this is the line that would have to change for it to
       start doing so. */
    assert.match(row[0], /def: false/, `${trigger.settingId} does not ship switched off`)
  }
})

test('the success words this seam trusts are the renderer\'s own list, not a second opinion', () => {
  assert.equal(triggerForEvent({ type: 'turn_completed', status: 'end_turn' }).id, 'agent-finished',
    'an ACP end_turn must notify completion rather than an error')
  const events = read('src/agent-session-events.js')
  const declared = /const TURN_SUCCESS_STATUSES = Object\.freeze\(\[([^\]]*)\]\)/.exec(events)
  assert.ok(declared, 'the renderer\'s success allowlist is not where this test expects it')
  const words = [...declared[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual([...TURN_SUCCESS_STATUSES], words,
    'the shell seam and the renderer disagree about which engine words mean the turn went well')

  /* And the default for a completion that carries no status word, which is the
     other half of the same reading. */
  assert.match(events, /event\.type !== 'turn_completed'\) return null\s*\n\s*return typeof event\.status === 'string' \? event\.status : 'completed'/,
    'the renderer no longer defaults a status-less completion to completed')
  assert.equal(MISSING_TURN_STATUS, 'completed', 'the seam defaults a status-less completion differently from the renderer')
})

/* ---------- 6. THE WIRING, WITHOUT WHICH NONE OF THE ABOVE RUNS ---------- */

test('the file every pin below reads as text is still a program', () => {
  /* EVERY ASSERTION IN THE NEXT TEST READS shell/main.cjs AS A STRING, because
     nothing outside Electron can require it. That makes a whole class of damage
     invisible to this suite: a comment closed in the wrong place leaves every
     pin matching and the application unable to start. It happened once while
     this lane was being written, and the five suites stayed green over a main
     process that would not parse. So the file is handed to node's own parser
     before anything reads it as prose. */
  for (const file of ['shell/main.cjs', 'shell/agent-notifications.cjs', 'shell/fleet-profile-preload.cjs']) {
    const parsed = spawnSync(process.execPath, ['--check', path.join(ROOT, ...file.split('/'))], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, `${file} is not valid JavaScript:\n${parsed.stderr}`)
  }
})

test('the main process really raises these, on both endings a session has', () => {
  const main = read('shell/main.cjs')

  /* The platform. Nothing else in this tree constructs a Notification, which is
     the property that makes the seam the only door. */
  assert.match(main, /require\('electron'\)/)
  assert.match(main, /\bNotification,/, 'the main process no longer imports Electron\'s Notification')
  assert.match(main, /new Notification\(\{ title, body \}\)/, 'the main process no longer shows a notification')
  const constructions = [...main.matchAll(/new Notification\(/g)].length
  assert.equal(constructions, 1, 'a second place in the main process constructs a notification, outside the seam that reads the switch')

  assert.match(main, /require\('\.\/agent-notifications\.cjs'\)/, 'the main process no longer loads the seam')
  assert.match(main, /createAgentNotifier\(\{/, 'the main process no longer builds the seam')
  assert.match(main, /prefs: rendererPrefs,/, 'the seam is no longer handed the durable settings store')
  /* BOTH ARGUMENTS ARE NAMED, because the mutation that matters here is not
     deleting this line but passing `null` for the second half of it -- which
     kills the suppression and changes nothing a pin on the function name would
     see. attentionNow() itself is driven in section 4d. */
  assert.match(main, /attention: \(\) => attentionNow\(win, watchedSessionId\)/,
    'the notifier is no longer asked about the real window and the real on-screen session at the moment of the event')

  /* THE FIRST CALLER. Without this line the seam is a module with no caller,
     which is a feature that does not exist. It sits in host.onEvent, beside the
     usage record and the turn count -- the one place every session's events
     cross in the main process. */
  const fanOut = main.slice(main.indexOf('removeAgentEventListener = host.onEvent'), main.indexOf('host.onSessionExit'))
  assert.ok(fanOut.length > 0, 'the agent event fan-out is not where this test expects it')
  assert.match(fanOut, /noteAgentNotification\(packet\)/, 'the notification seam has no caller on the agent event stream')

  /* THE SECOND CALLER, AND THE WHOLE REASON THIS TEST WAS RENAMED. The child's
     own exit is the ending the row promised and did not cover: a process killed
     or dead between prompts reaches host.onSessionExit and nothing else. A
     source pin is all a suite outside Electron can offer for the wiring itself;
     what the wiring calls is driven end to end in section 4b. */
  const exitHandler = main.slice(main.indexOf('host.onSessionExit(('), main.indexOf('agentHost = host'))
  assert.ok(exitHandler.length > 0, 'the session-exit handler is not where this test expects it')
  assert.match(exitHandler, /noteAgentSessionEnded\(report\)/,
    'a child that died with no turn running raises nothing: the second ending has no caller')
  assert.match(exitHandler, /recordSessionEnd\(session, report\.sessionId, 'exited'\)[\s\S]*noteAgentSessionEnded/,
    'the ending is told to somebody before it is written down')
  assert.match(main, /considerSessionEnd\(report\)/, 'the second caller no longer reaches the seam')

  /* WHOSE SESSIONS THIS COMPUTER SPEAKS FOR. A relay-owned session was started
     from a signed-in browser somewhere else; both notifications tell the reader
     to open ToolsEnabled and read what the agent did, and this desk has no page
     for it. Both callers are gated on the same one-line decision. */
  assert.match(main, /function ownedByThisWindow\(session\) \{[\s\S]*?session\.ownerKind !== 'relay'/,
    'the desk no longer distinguishes its own sessions from a browser\'s')
  assert.match(fanOut, /if \(ownedByThisWindow\(session\)\) noteAgentNotification\(packet\)/,
    'a session started from another device raises a notification on this desk about a page it does not have')
  assert.match(exitHandler, /if \(ownedByThisWindow\(session\)\) noteAgentSessionEnded\(report\)/,
    'a relay-owned session\'s exit raises a notification on this desk')

  /* CLICKING THE TOAST HAS TO DO WHAT THE TOAST INVITES. Both bodies say to
     open ToolsEnabled; without a click handler the click is inert, which is a
     control that cannot succeed and says nothing about it. */
  assert.match(main, /revealOnClick\(new Notification\(\{ title, body \}\)\)\.show\(\)/,
    'the notification is shown without the click that opens the window being bound to it')
  const reveal = main.slice(main.indexOf('function revealOnClick'), main.indexOf('function noteAgentNotification'))
  assert.match(reveal, /notification\.on\('click'/, 'clicking the notification does nothing')
  assert.match(reveal, /win\.focus\(\)/, 'clicking the notification does not bring the window forward')
  assert.match(reveal, /if \(win\.isMinimized\(\)\) win\.restore\(\)/,
    'a toast raised while the app was minimised opens nothing a person can see')

  /* THE TWO CHANNELS, their sender checks, and the seam functions that decide
     what each one answers. The decisions are driven in section 4d; these pins
     say the handlers still route through them rather than deciding again. */
  assert.match(main, /ipcMain\.on\('mc-notify:delivery'/, 'the page can no longer ask whether this computer shows notifications')
  assert.match(main, /ipcMain\.handle\('mc-notify:watching'/, 'the page can no longer say what it is showing')
  const watching = main.slice(main.indexOf("ipcMain.handle('mc-notify:watching'"), main.indexOf("ipcMain.handle('mc-notify:watching'") + 400)
  assert.match(watching, /assertTrustedAgentSender\(event\)/,
    'the watching channel no longer checks the sender is this application\'s own main frame')
  assert.match(watching, /watchedSessionId = watchedSessionFrom\(value, MAX_SESSION_ID_LENGTH\)/,
    'the on-screen report is no longer read through the bounded reader')
  const delivery = main.slice(main.indexOf("ipcMain.on('mc-notify:delivery'"), main.indexOf("ipcMain.on('mc-notify:delivery'") + 400)
  assert.match(delivery, /deliveryAnswerFor\(trustedFleetProfileSender\(event\) === true, \(\) => getAgentNotifier\(\)\.supported\(\)\)/,
    'the delivery answer no longer comes from the sender check and the seam together')

  /* The record must not outlive the window that made it. */
  assert.match(main, /win = null[\s\S]{0,120}watchedSessionId = null/,
    'a closed window leaves its on-screen record behind')
})

test('this program tells Windows the name its own installer registered', () => {
  /* WHY THIS IS IN THE NOTIFICATION SUITE. On Windows a toast is raised against
     an application id, and the operating system shows it only when that id
     matches a registered Start Menu shortcut. The installer registers the
     shortcut under build.appId; nothing in this tree ever told the running
     process the same name, so show() would have succeeded and nothing would
     have appeared. That is the single fact that decides whether this feature
     works at all on the only platform it ships to.
     Two names for one program is the fault, so the two are compared rather
     than each being asserted to be some string. */
  const main = read('shell/main.cjs')
  const declared = /const WINDOWS_APPLICATION_ID = '([^']+)'/.exec(main)
  assert.ok(declared, 'the main process declares no application id for Windows notifications')
  const packaged = JSON.parse(read('package.json'))
  assert.equal(declared[1], packaged.build.appId,
    'the id this program calls itself is not the id its installer registers, so a Windows toast is raised against a name nothing knows')

  /* And it is actually set, before any window and any notification exists. */
  const start = main.slice(main.indexOf('  start: () => {'), main.indexOf('return createWindow()'))
  assert.ok(start.length > 0, 'the launch is not where this test expects it')
  assert.match(start, /app\.setAppUserModelId\(WINDOWS_APPLICATION_ID\)/,
    'the application id is declared and never told to the operating system')
})

test('the page really starts reporting what it is showing, in the product', () => {
  /* THE SUPPRESSION HAS TWO HALVES AND THIS IS THE HALF THAT IS A CALL SITE.
     src/notification-attention.js is driven by its own suite; if nothing in the
     product ever calls it, the main process never learns what is on screen and
     "already watching that agent" can never be true. Mounted in src/main.js
     rather than in a view, because it is a fact about the window. */
  const renderer = read('src/main.js')
  assert.match(renderer, /import \{ startAttentionReports \} from '\.\/notification-attention\.js'/,
    'the page no longer loads the reporter')
  assert.match(renderer, /^startAttentionReports\(\)$/m,
    'nothing in the product starts the reports, so the main process never learns what is on screen')
})

test('the preload exposes the two calls and no way for a page to notify by itself', () => {
  const preload = read('shell/fleet-profile-preload.cjs')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('mcNotify', Object\.freeze\(\{/, 'mcNotify is no longer exposed')
  assert.match(preload, /ipcRenderer\.sendSync\('mc-notify:delivery'\)/, 'the page no longer learns whether notifications work before it paints')
  /* NOT-ESTABLISHED MUST NEVER RENDER AS WORKING, and this is the one place in
     the whole chain where that reading cannot be driven by a test: a sandboxed
     preload cannot require a sibling file, so the expression cannot live in the
     seam beside deliveryAnswerFor(). It is pinned character for character
     instead, and a mutation to `supported: true` -- which would draw both
     switches live on a machine that shows no notifications -- is caught here. */
  assert.match(preload, /supported: Boolean\(notifyDelivery && notifyDelivery\.supported === true\),/,
    'the page believes something other than the word true when it asks whether notifications work')
  assert.match(preload, /let notifyDelivery = null\s*\n\s*try \{ notifyDelivery = ipcRenderer\.sendSync\('mc-notify:delivery'\) \} catch \{ notifyDelivery = null \}/,
    'a preload that could not reach the main process no longer answers "we could not tell"')
  assert.match(preload, /watching: request => ipcRenderer\.invoke\('mc-notify:watching', request\)/, 'the page can no longer report what it is showing')
  /* THE ONE THING THIS BRIDGE MUST NOT HAVE. A page that could raise its own
     notification could interrupt somebody whatever their settings say, which
     would put a second door beside the seam that reads the switch. So the
     exposed object's KEYS are counted, rather than the file scanned for words
     -- the file is full of the word "notify" and always will be. */
  const start = preload.indexOf("exposeInMainWorld('mcNotify'")
  const block = preload.slice(start, preload.indexOf('}))', start))
  const keys = [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1])
  assert.deepEqual(keys, ['supported', 'watching'],
    'the notifications bridge gained a call: it may ask and it may report, and it may not raise a notification')
})
