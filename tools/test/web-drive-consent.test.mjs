/* THE SWITCH THAT LETS A BROWSER DRIVE THIS COMPUTER, AND THE ONE QUESTION.
 *
 * Findings 2026-08-22: shell/relay-supervisor.cjs reads `mc.relay.web-drive`
 * per command and answers true only for the exact string 'on' -- and nothing
 * in src/ wrote that key. The refusal a browser met pointed at a control that
 * did not exist. The owner's ruling is that the question is asked on the
 * computer, at the moment it becomes meaningful: the moment the connect
 * section sees the claim land. src/connect-computer-settings.js now draws the
 * question and the switch; this file holds both still.
 *
 * WHAT IS ASSERTED IS THE STORE, NOT THE PIXELS. The controller takes its
 * reader and writer as arguments, so every test hands it a recording store and
 * reads back exactly what was written -- including that NOTHING is written by
 * constructing, checking, beginning, polling or painting, and that "Not now"
 * writes nothing either. The only write is the one a person makes with the
 * switch, and it is exactly [key, 'on'] or a removal.
 *
 * Run: node --test tools/test/web-drive-consent.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONNECT_SECTION,
  WEB_DRIVE_CONTROL_LABEL,
  WEB_DRIVE_ON,
  WEB_DRIVE_PREF_KEY,
} from '../../src/device-claim-flow.js'
import {
  createConnectComputerSettings,
  forgetRememberedClaim,
} from '../../src/connect-computer-settings.js'
import { IDENTIFIER_RE } from '../../src/refusal-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8')

const NOW = 1_770_000_000_000
const CODE = 'TC-4KQ2-9WFA'

function assertHumanSentence(sentence, what) {
  assert.equal(typeof sentence, 'string', `${what} is not a sentence`)
  assert.ok(sentence.trim().length > 0, `${what} is empty`)
  for (const word of sentence.split(/[\s.,;:()"'“”]+/)) {
    assert.equal(IDENTIFIER_RE.test(word), false, `${what} shows the identifier ${word}`)
  }
}

/* A localStorage-shaped store that writes down every call made to it. */
function recordingStore(initial = {}) {
  const values = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { writes.push(['set', key, value]); values.set(key, value) },
    removeItem: key => { writes.push(['remove', key]); values.delete(key) },
  }
}

/* The reader and writer the product's defaults are, over the recording store
   instead of localStorage: get compared to 'on'; set 'on' or remove. */
function storeAccess(store) {
  if (store === null) return { readWebDrive: () => null, writeWebDrive: () => { throw new Error('no store') } }
  return {
    readWebDrive: () => store.getItem(WEB_DRIVE_PREF_KEY) === WEB_DRIVE_ON,
    writeWebDrive: on => (on ? store.setItem(WEB_DRIVE_PREF_KEY, WEB_DRIVE_ON) : store.removeItem(WEB_DRIVE_PREF_KEY)),
  }
}

/* THE SMALLEST ROOT THAT LETS refresh() AND THE HANDLERS RUN WITHOUT A DOM.
   bind() attaches listeners to it; a press is delivered by calling the
   recorded listener with an event whose target answers closest(). refresh()
   asks the root for the section node and writes its outerHTML, which is
   captured here so a test can read the repainted screen. */
function fakeRoot() {
  const listeners = new Map()
  const removed = []
  let html = ''
  const section = {
    querySelector: () => null,
    set outerHTML(value) { html = value },
    get outerHTML() { return html },
  }
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => removed.push([type, fn]),
    contains: () => true,
    ownerDocument: { activeElement: null },
    querySelector: selector => (selector === '[data-connect-settings]' ? section : null),
    listeners,
    removed,
    painted: () => html,
  }
}

function target(dataset, extra = {}) {
  return {
    dataset,
    ...extra,
    closest(selector) {
      if (selector === '[data-connect-action]' && dataset.connectAction) return this
      if (selector === '[data-connect-field="web-drive"]' && dataset.connectField === 'web-drive') return this
      return null
    },
  }
}

function harness({ bridge = null, store, startAt = NOW } = {}) {
  forgetRememberedClaim()
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
    ...storeAccess(store),
  })
  return { controller, timers, advance(ms) { clock += ms } }
}

function workingBridge(overrides = {}) {
  return {
    status: async () => ({ ok: true, connected: false }),
    begin: async () => ({ ok: true, code: CODE, expiresAtMs: NOW + 300_000, intervalSeconds: 5 }),
    poll: async () => ({ ok: true, state: 'none' }),
    cancel: async () => ({ ok: true }),
    ...overrides,
  }
}

/* Drives a controller from idle to the moment the service confirms the claim,
   which is the one moment the question may be asked. */
async function landed(store) {
  const rig = harness({
    bridge: workingBridge({
      poll: async () => ({ ok: true, state: 'connected', device: { name: 'Front desk', deviceId: 'd', pairId: 'p' } }),
    }),
    store,
  })
  await rig.controller.checkStatus()
  await rig.controller.begin()
  await rig.controller.pollOnce()
  assert.equal(rig.controller.getState().phase, 'connected')
  assert.equal(rig.controller.getState().serviceConfirmed, true)
  return rig
}

function textOf(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

/* ---------- nothing is written by anything but the switch ---------- */

test('constructing, checking, beginning, polling and painting write nothing to the store', async () => {
  const store = recordingStore()
  const rig = await landed(store)
  rig.controller.markup()
  rig.controller.markup()
  rig.controller.markup()
  assert.deepEqual(store.writes, [], 'the ceremony must not touch the web-drive key on its own')
  rig.controller.destroy()
})

/* ---------- the question, once, at the moment the claim lands ---------- */

test('the claim landing asks the one question, with a way to say not now', async () => {
  const store = recordingStore()
  const rig = await landed(store)
  const html = rig.controller.markup()
  assert.match(html, /One question, now that this computer is on your account/)
  assert.match(html, /data-connect-action="web-drive-later"/, 'the "Not now" press is there')
  assert.match(html, /data-connect-field="web-drive"/, 'and the switch is there to turn on below')
  assert.match(html, /is-good/, 'the question rides the confirmed, green moment')
  /* It reads as news, not as a wall. */
  assert.equal(/data-connect-web-drive-ask[^>]*role="alert"/.test(html), false)
  assert.match(html, /class="connect-note" data-connect-web-drive-ask/)
  assert.deepEqual(store.writes, [])
  rig.controller.destroy()
})

test('"Not now" takes the question away, writes nothing, and leaves the switch', async () => {
  const store = recordingStore()
  const rig = await landed(store)
  const root = fakeRoot()
  rig.controller.bind(root)
  root.listeners.get('click')({ target: target({ connectAction: 'web-drive-later' }) })
  const html = root.painted()
  assert.ok(html.length > 0, 'the press repainted the section')
  assert.equal(/One question/.test(html), false, 'the question is gone')
  assert.equal(/web-drive-later/.test(html), false)
  assert.match(html, /data-connect-field="web-drive"/, 'the switch stays')
  assert.deepEqual(store.writes, [], '"Not now" is a dismissal, not a choice recorded anywhere')
  assert.equal(store.values.size, 0)
  /* And it stays gone on the next paint of this controller. */
  assert.equal(/One question/.test(rig.controller.markup()), false)
  rig.controller.destroy()
})

test('a controller that learned "connected" from the vault never asks, and has nothing to press', async () => {
  const store = recordingStore()
  const rig = harness({
    bridge: workingBridge({
      status: async () => ({ ok: true, connected: true, name: 'Front desk', deviceId: 'd', pairId: 'p', claimedAtMs: NOW }),
    }),
    store,
  })
  await rig.controller.checkStatus()
  assert.equal(rig.controller.getState().phase, 'connected')
  const html = rig.controller.markup()
  assert.equal(/One question/.test(html), false, 'a vault read cannot know this is the moment; it is not')
  assert.equal(/data-connect-action/.test(html), false, 'nothing to press on a computer that is already joined')
  assert.match(html, /data-connect-field="web-drive"/, 'but the switch is drawn, because the refusal sentence sends people here')
  assert.match(html, new RegExp(WEB_DRIVE_CONTROL_LABEL))
  assert.deepEqual(store.writes, [])
  rig.controller.destroy()
})

test('a nameless connected computer still gets the switch', async () => {
  const store = recordingStore()
  const rig = harness({
    bridge: workingBridge({ status: async () => ({ ok: true, connected: true, name: '', deviceId: 'd', pairId: 'p' }) }),
    store,
  })
  await rig.controller.checkStatus()
  const html = rig.controller.markup()
  assert.match(html, /data-connect-field="web-drive"/)
  assert.equal(/connect-known/.test(html), false, 'and no name line about a name that is not there')
  rig.controller.destroy()
})

/* ---------- the switch writes exactly one thing, and the screen reads it back ---------- */

test('turning it on writes exactly [key, "on"], and the screen says On from the store', async () => {
  const store = recordingStore()
  const rig = await landed(store)
  const root = fakeRoot()
  rig.controller.bind(root)
  root.listeners.get('change')({ target: target({ connectField: 'web-drive' }, { checked: true }) })
  assert.deepEqual(store.writes, [['set', WEB_DRIVE_PREF_KEY, 'on']])
  assert.equal(store.values.get(WEB_DRIVE_PREF_KEY), 'on')
  const html = root.painted()
  assert.match(html, /data-connect-field="web-drive"[^>]*checked/, 'the input reads checked from the store')
  const state = html.match(/data-connect-web-drive-state>([^<]+)</)[1]
  assert.ok(state.startsWith('On.'), state)
  assert.equal(/One question/.test(html), false, 'the choice answers the question')
  assert.equal(/data-connect-web-drive-notice/.test(html), false)
  rig.controller.destroy()
})

test('turning it off removes the key rather than writing a second spelling of off', async () => {
  const store = recordingStore({ [WEB_DRIVE_PREF_KEY]: 'on' })
  const rig = await landed(store)
  assert.match(rig.controller.markup(), /data-connect-field="web-drive"[^>]*checked/, 'it starts On because the store says so')
  const root = fakeRoot()
  rig.controller.bind(root)
  root.listeners.get('change')({ target: target({ connectField: 'web-drive' }, { checked: false }) })
  assert.deepEqual(store.writes, [['remove', WEB_DRIVE_PREF_KEY]])
  assert.equal(store.values.has(WEB_DRIVE_PREF_KEY), false)
  const html = root.painted()
  assert.equal(/data-connect-field="web-drive"[^>]*checked/.test(html), false)
  const state = html.match(/data-connect-web-drive-state>([^<]+)</)[1]
  assert.ok(state.startsWith('Off.'), state)
  rig.controller.destroy()
})

test('a writer that throws leaves the old truth on the switch and says so beside it', async () => {
  const store = recordingStore()
  forgetRememberedClaim()
  const failing = createConnectComputerSettings({
    now: () => NOW,
    schedule: () => ({}),
    cancelTimer: () => {},
    resolveBridge: () => workingBridge({
      poll: async () => ({ ok: true, state: 'connected', device: { name: 'Front desk', deviceId: 'd', pairId: 'p' } }),
    }),
    readWebDrive: () => store.getItem(WEB_DRIVE_PREF_KEY) === WEB_DRIVE_ON,
    writeWebDrive: () => { throw new Error('EACCES') },
  })
  await failing.checkStatus()
  await failing.begin()
  await failing.pollOnce()
  assert.equal(failing.getState().phase, 'connected')
  const root = fakeRoot()
  failing.bind(root)
  root.listeners.get('change')({ target: target({ connectField: 'web-drive' }, { checked: true }) })
  const html = root.painted()
  assert.deepEqual(store.writes, [])
  assert.equal(/data-connect-field="web-drive"[^>]*checked/.test(html), false, 'the switch shows the store, not the press')
  assert.match(html, /data-connect-web-drive-notice[^>]*role="alert"/)
  assert.match(html, /could not be saved on this computer, so nothing changed/)
  failing.destroy()
})

test('a window with no durable store draws the sentence and no switch', async () => {
  const rig = await landed(null)
  const html = rig.controller.markup()
  assert.equal(/data-connect-field="web-drive"/.test(html), false, 'a switch whose press cannot be saved is a switch that lies')
  assert.match(html, /This window cannot save that choice, so driving from a browser stays off/)
  assert.equal(/One question/.test(html), false, '"turn it on below" would point at nothing')
  rig.controller.destroy()
})

/* ---------- every sentence reads as English ---------- */

test('every sentence on the connected screen is a human sentence, in every state of the switch', async () => {
  for (const store of [recordingStore(), recordingStore({ [WEB_DRIVE_PREF_KEY]: 'on' }), null]) {
    const rig = await landed(store)
    const html = rig.controller.markup()
    for (const sentence of textOf(html).split(/(?<=[.?!])\s+/).filter(piece => piece.trim())) {
      assertHumanSentence(sentence, 'connected screen')
    }
    rig.controller.destroy()
  }
  assertHumanSentence(WEB_DRIVE_CONTROL_LABEL, 'the control label')
})

/* ---------- lifecycle behaviour and the remaining static constraints ---------- */

test('the section owns one repeating timer and drops every listener with the screen', async () => {
  const store = recordingStore()
  const rig = await landed(store)
  assert.equal(rig.timers.length, 1, 'landing the claim schedules one repeating clock')

  const root = fakeRoot()
  rig.controller.bind(root)
  const installed = new Map(root.listeners)
  rig.controller.destroy()

  assert.equal(rig.timers[0].cleared, true, 'destroy clears the clock it scheduled')
  assert.deepEqual(root.removed, [...installed], 'destroy removes every listener that bind installed')
})

test('the question is drawn above the row, where the small window can see it', async () => {
  const rig = await landed(recordingStore())
  const html = rig.controller.markup()
  const ask = html.indexOf('data-connect-web-drive-ask')
  const rows = html.indexOf('class="settings-section-rows"')
  assert.ok(ask >= 0 && rows >= 0 && ask < rows, 'the visible web-drive question must come before the settings rows')
  rig.controller.destroy()
})

test('the key is spelled in one ESM module only, and the switch is not a catalogue toggle', () => {
  const offenders = []
  const walk = dir => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(relative)
      else if (entry.name.endsWith('.js') && read(relative).includes("'mc.relay.web-drive'")) offenders.push(relative.replace(/\\/g, '/'))
    }
  }
  walk('src')
  assert.deepEqual(offenders, ['src/device-claim-flow.js'],
    'a second spelling of the key is a second thing that can drift from the reader')
  const section = read('src/connect-computer-settings.js')
  assert.equal(/data-connect-field="web-drive"[^>]*settings-toggle/.test(section), false)
  assert.equal(/settings-toggle[^>]*data-connect-field="web-drive"/.test(section), false)
  assert.match(section, /<label class="toggle"><input type="checkbox" data-connect-field="web-drive"/,
    'class `toggle` without `settings-toggle`, so src/views/settings.js never handles it')
})

test('the refusal a browser meets names this section and this control', async () => {
  const { unavailableReason } = await import('../../src/agent-availability-copy.js')
  const said = unavailableReason('MC_AGENT_PRINCIPAL_READ_ONLY')
  assert.ok(said.includes(CONNECT_SECTION), said)
  assert.ok(said.includes(WEB_DRIVE_CONTROL_LABEL), said)
})

test('the join question does not say the permission is off while it is on', () => {
  /* THE QUESTION ASSERTED A STATE IT WAS HOLDING AND NOT READING.
   *
   * askMarkup(state, webDrive, asked) said "It is off." unconditionally,
   * checking `webDrive` only for null. The value is right there in the argument.
   *
   * That mattered because the consent is supposed to be cleared when a computer
   * disconnects. shell/main.cjs says so where it clears it -- "a later join may
   * be to a different one, and the question at that join says 'It is off' --
   * WHICH MUST BE TRUE" -- and then ignored the removal's return value, catching
   * only a throw. rendererPrefs.remove() does not throw on a failed write; it
   * answers { ok: false }. So a disconnect whose preference write failed reported
   * a clean disconnect, left the consent ON, and the next join asked this
   * question about a permission that was already granted -- to a DIFFERENT
   * account. A browser on that account could start agents on this computer.
   *
   * Asserted against the SOURCE because the markup is closure-private, and what
   * is being pinned is that the sentence branches on the value at all. */
  const source = read('src/connect-computer-settings.js')

  assert.match(source, /\$\{webDrive === true/,
    'the join question no longer branches on the real permission value, so it can assert "It is off" '
    + 'about a permission that is on')

  const ask = source.slice(source.indexOf('function askMarkup'), source.indexOf('function webDriveNoticeMarkup'))
  /* PINNED ON STRUCTURE, NOT WORDING. The first version of this checked for the
     literal phrase "that permission is on", and a copy-density rewrite two
     minutes later changed it to "That permission is already on" and turned this
     red at nothing. A guard that fails when the copy improves is the defect this
     repository keeps finding, and writing one while fixing one would be poor. */
  const ternary = ask.indexOf('webDrive === true')
  assert.ok(ternary > 0, 'the question no longer branches on the permission value at all')
  const elseAt = ask.indexOf('    : ', ternary)
  assert.ok(elseAt > ternary, 'the branch has no else, so one of the two cases is unwritten')
  const onBranch = ask.slice(ternary, elseAt)
  const offBranch = ask.slice(elseAt)
  
  assert.doesNotMatch(onBranch, /May a browser/,
    'the on-case reuses the asking sentence, so somebody is asked to grant a permission they already hold')
  assert.doesNotMatch(onBranch, /It is off\./,
    'the on-case still says the permission is off while it is on -- the whole defect')
  assert.match(onBranch, / is (already )?on[ ,.]/,
    'the on-case does not tell the person the permission is currently granted')
  assert.match(offBranch, /It is off\./,
    'the ordinary case lost its sentence; the fix must make the question true, not remove it')

  /* THE CALLER MUST ALSO STOP DISCARDING THE OUTCOME. Belt and braces on
     purpose: the screen reading the real value makes the sentence honest even
     when the removal failed, and this makes the failure itself visible rather
     than silent.

     THE OUTCOME MOVED FILES, IT DID NOT GO AWAY. It used to be assembled in
     shell/main.cjs. The disconnect path now runs through
     shell/remote-connection-lifecycle.cjs, which reads the removal at its
     clearChoice() and puts the SAME `webDriveConsentCleared` key on the answer
     it returns to the caller. Both halves are pinned below, because the split
     is what makes a one-file pin miss: main.cjs must still consult the result
     it hands over, and the lifecycle must still report it.

     What actually holds the guarantee is behavioural and lives next door, in
     tools/test/remote-connection-lifecycle.test.mjs, 'failed consent
     persistence and incomplete child evidence are separate failed outcomes':
     it drives disconnect() with clearConsent: () => false and asserts
     answer.ok === false together with answer.webDriveConsentCleared === false.
     A failed removal is therefore not merely visible, it refuses the
     disconnect outright -- stricter than annotating a successful one. These
     two assertions exist so that deleting that behaviour is loud here too. */
  const main = read('shell/main.cjs')
  /* Two assertions, both in the key-name form the lifecycle pin below uses,
     rather than one pin on the exact spelling. The previous single regex
     required \`rendererPrefs.remove(WEB_DRIVE_PREF_KEY)?.ok === true\` as one
     unbroken expression, so a behaviourally identical rewrite --
       const outcome = rendererPrefs.remove(WEB_DRIVE_PREF_KEY)
       return outcome?.ok === true
     -- went RED under a message that was FALSE for that code: it does consult
     the result. A pin that fails against a correct implementation teaches the
     next reader to delete the pin. These two hold the same structural fact
     without dictating how it is spelled.

     The result-consultation pin is SCOPED to clearConsent deliberately. A
     file-wide /\.ok === true/ was measured to be vacuous here: shell/main.cjs
     carries 8 occurrences (lines 183, 972, 2113, 3592, 3994, 6512, 6516 and the
     one that matters), so removing the one inside clearConsent still matched and
     the real defect stayed GREEN. The window is bounded so it cannot reach the
     next property. */
  assert.match(main, /WEB_DRIVE_PREF_KEY/,
    'shell/main.cjs no longer references the web-drive consent key at all, so nothing there can clear it')
  assert.match(main, /clearConsent:[\s\S]{0,220}?\.ok\b/,
    'shell/main.cjs clearConsent no longer consults the { ok } result of clearing the web-drive consent '
    + 'before handing it to the lifecycle, so a failed removal can be passed off as a success')
  const lifecycle = read('shell/remote-connection-lifecycle.cjs')
  assert.match(lifecycle, /webDriveConsentCleared/,
    'the disconnect answer no longer carries the result of clearing the web-drive consent, so a failed '
    + 'removal is reported as a clean disconnect')
  assert.doesNotMatch(main, /try \{ rendererPrefs\.remove\(WEB_DRIVE_PREF_KEY\) \} catch/,
    'the bare try/catch is back; rendererPrefs.remove answers { ok: false } rather than throwing, so a '
    + 'catch sees nothing')
})
