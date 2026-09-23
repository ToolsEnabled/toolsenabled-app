/* THE MACHINE-SIDE ACCOUNT QUESTION, HELD STILL.
 *
 * Run: node --test tools/test/device-claim-reservation.test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { test } from 'node:test'

import deviceClaimModule from '../../shell/device-claim.cjs'
import { ownedSpawnFixture } from './device-claim-owned-fixture.mjs'
import {
  createConnectComputerSettings,
  forgetRememberedClaim,
} from '../../src/connect-computer-settings.js'

const { CODES, createDeviceClaim } = deviceClaimModule
const ROOT = path.join('R:', 'app', 'resources', 'capability')
const ENTRY = path.join(ROOT, 'tools', 'online-fra-claim-cli.js')
const STATE_ROOT = path.resolve('claim-test', 'state')
const TOKEN = 'poll-token-reservation-test'
const CODE = 'TC-4KQ2-9WFA'
const NOW = 1_770_000_000_000

function answer(value) {
  return child => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`))
    child.emit('exit', 0, null); child.emit('close', 0, null)
  }
}

function spawnScript(script) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    calls.push({ command, args, options })
    const step = script[calls.length - 1]
    if (step) queueMicrotask(() => step(child))
    return child
  }
  spawn.calls = calls
  return spawn
}

function shellClaim(script) {
  const spawn = spawnScript(script)
  const claim = createDeviceClaim({
    spawn,
    spawnOwned: ownedSpawnFixture(spawn),
    resolvePayloadRoot: () => ROOT,
    exists: candidate => candidate === ENTRY,
    execPath: path.join('R:', 'app', 'ToolsEnabled.exe'),
    env: {},
    stateRoot: STATE_ROOT,
    now: () => NOW,
  })
  return { claim, spawn }
}

const opened = Object.freeze({
  code: CODE,
  pollToken: TOKEN,
  expiresAtMs: NOW + 600_000,
  intervalSeconds: 5,
})

test('reserved exposes only the full account address and a reload poll cannot accept it', async () => {
  const email = 'owner+full-address@example.com'
  const rig = shellClaim([
    answer(opened),
    answer({ state: 'reserved', account: { email }, intervalSeconds: 5 }),
    /* A mutation that lets a reload poll through consumes this answer and makes
       the no-auto-accept assertion fail immediately rather than by timeout. */
    answer({ state: 'accepted' }),
  ])
  await rig.claim.begin({ name: 'Desk PC' })
  const reserved = await rig.claim.poll()
  assert.deepEqual(reserved, { ok: true, state: 'reserved', account: { email }, childQuiescent: true })
  assert.equal(JSON.stringify(reserved).includes(TOKEN), false)

  const calls = rig.spawn.calls.length
  assert.deepEqual(await rig.claim.poll(), reserved,
    'the mount-time poll gets the unanswered question, not implicit consent')
  assert.equal(rig.spawn.calls.length, calls, 'a cached unanswered question made a network decision')
})

test('literal accept is sent once, then an argument-free poll collects the parked grant', async () => {
  const rig = shellClaim([
    answer(opened),
    answer({ state: 'reserved', account: { email: 'owner@example.com' } }),
    answer({ state: 'accepted' }),
    answer({ state: 'connected', pairId: 'pair-1', deviceId: 'device-1', name: 'Desk PC' }),
  ])
  await rig.claim.begin({ name: 'Desk PC' })
  await rig.claim.poll()
  const accepted = await rig.claim.begin({ accept: true })
  assert.deepEqual(accepted, { ok: true, state: 'accepted', intervalSeconds: 1, childQuiescent: true })
  assert.deepEqual(rig.spawn.calls[2].args, [ENTRY, 'poll', '--token', TOKEN, '--accept', 'true'])
  assert.equal(rig.claim.enrolled(), false, 'acceptance alone was reported as enrolment')

  const connected = await rig.claim.poll()
  assert.equal(connected.state, 'connected')
  assert.deepEqual(rig.spawn.calls[3].args, [ENTRY, 'poll', '--token', TOKEN])
  assert.equal(rig.claim.enrolled(), true)
})

test('literal decline spends the reservation and later polls have nothing to collect', async () => {
  const rig = shellClaim([
    answer(opened),
    answer({ state: 'reserved', account: { email: 'other@example.com' } }),
    answer({ state: 'rejected' }),
  ])
  await rig.claim.begin({ name: 'Friend computer' })
  await rig.claim.poll()
  assert.deepEqual(await rig.claim.begin({ accept: false }), { ok: true, state: 'rejected', childQuiescent: true })
  assert.deepEqual(rig.spawn.calls[2].args, [ENTRY, 'poll', '--token', TOKEN, '--accept', 'false'])
  assert.deepEqual(await rig.claim.poll(), { ok: true, state: 'none', childQuiescent: true })
})

test('no malformed request or old CLI answer can become consent', async () => {
  const rig = shellClaim([
    answer(opened),
    answer({ state: 'reserved', account: { email: 'owner@example.com' } }),
    /* This is what the old CLI in this checkout would answer after silently
       ignoring --accept. It must not be presented as an accepted decision. */
    answer({ state: 'reserved', account: { email: 'owner@example.com' } }),
  ])
  assert.equal((await rig.claim.begin({ accept: true })).code, CODES.DECISION_INVALID)
  await rig.claim.begin({ name: 'Desk PC' })
  await rig.claim.poll()
  assert.equal((await rig.claim.begin({ accept: 'true' })).code, CODES.DECISION_INVALID)
  assert.equal((await rig.claim.begin({ accept: true })).code, CODES.UNREADABLE)
  assert.equal(rig.claim.enrolled(), false)
})

function uiHarness(bridge) {
  const timers = []
  const controller = createConnectComputerSettings({
    now: () => NOW,
    resolveBridge: () => bridge,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    cancelTimer: timer => { timer.cleared = true },
    readWebDrive: () => false,
  })
  return { controller, liveTimers: () => timers.filter(timer => !timer.cleared) }
}

function uiBridge({ email, decision, collected } = {}) {
  const decisions = []
  let polls = 0
  return {
    decisions,
    status: async () => ({ ok: true, connected: false, childQuiescent: true }),
    begin: async request => {
      if (Object.hasOwn(request, 'accept')) {
        decisions.push(request.accept)
        return decision(request.accept)
      }
      return opened
    },
    poll: async () => {
      polls += 1
      return polls === 1
        ? { ok: true, state: 'reserved', account: { email }, childQuiescent: true }
        : collected
    },
    cancel: async () => ({ ok: true, dropped: false, childQuiescent: true }),
  }
}

test.beforeEach(() => { forgetRememberedClaim() })

test('the question shows the full escaped address, has two unselected choices, and stops polling', async () => {
  const hostile = '<img src=x onerror=claim()>very.long+owner@example.com&"'
  const bridge = uiBridge({
    email: hostile,
    decision: () => ({ ok: true, state: 'accepted' }),
    collected: { ok: true, state: 'connected', device: { name: 'Desk', deviceId: 'd', pairId: 'p' } },
  })
  const rig = uiHarness(bridge)
  await rig.controller.begin()
  await rig.controller.pollOnce()
  assert.equal(rig.controller.isTicking(), false, 'the unanswered question kept polling on a timer')
  const html = rig.controller.markup()
  assert.match(html, /data-connect-phase="reserved"/)
  assert.ok(html.includes('&lt;img src=x onerror=claim()&gt;very.long+owner@example.com&amp;&quot;'))
  assert.equal(html.includes('<img src=x'), false, 'the wire email became markup')
  assert.match(html, /data-connect-action="accept-reservation"/)
  assert.match(html, /data-connect-action="decline-reservation"/)
  assert.equal(/checked|selected|autofocus/.test(html), false, 'one answer was pre-selected')
  assert.deepEqual(bridge.decisions, [], 'rendering the question made a decision')
  rig.controller.destroy()
})

test('leaving the settings view and returning restores the question without choosing', async () => {
  const email = 'owner@example.com'
  const firstBridge = uiBridge({
    email,
    decision: () => ({ ok: true, state: 'accepted' }),
    collected: { ok: true, state: 'none', childQuiescent: true },
  })
  const first = uiHarness(firstBridge)
  await first.controller.begin()
  await first.controller.pollOnce()
  assert.match(first.controller.markup(), /data-connect-phase="reserved"/)
  first.controller.destroy()

  const secondBridge = uiBridge({
    email,
    decision: () => ({ ok: true, state: 'accepted' }),
    collected: { ok: true, state: 'none', childQuiescent: true },
  })
  const second = uiHarness(secondBridge)
  await second.controller.checkStatus()
  await second.controller.pollOnce()
  const html = second.controller.markup()
  assert.match(html, /data-connect-phase="reserved"/)
  assert.match(html, /owner@example\.com/)
  assert.deepEqual(firstBridge.decisions, [])
  assert.deepEqual(secondBridge.decisions, [], 'rebuilding the view accepted the reservation')
  second.controller.destroy()
})

test('accept explicitly sends true and continues through the later collection poll', async () => {
  const bridge = uiBridge({
    email: 'owner@example.com',
    decision: accept => ({ ok: true, state: accept ? 'accepted' : 'rejected' }),
    collected: { ok: true, state: 'connected', device: { name: 'Desk', deviceId: 'd', pairId: 'p' } },
  })
  const rig = uiHarness(bridge)
  await rig.controller.begin()
  await rig.controller.pollOnce()
  await rig.controller.decideReservation(true)
  assert.deepEqual(bridge.decisions, [true])
  assert.equal(rig.controller.getState().phase, 'connected')
  assert.match(rig.controller.markup(), /is now on your account/)
  rig.controller.destroy()
})

test('decline explicitly sends false and says nothing was added and the code is spent', async () => {
  const bridge = uiBridge({
    email: 'not-mine@example.com',
    decision: accept => ({ ok: true, state: accept ? 'accepted' : 'rejected' }),
    collected: { ok: true, state: 'none', childQuiescent: true },
  })
  const rig = uiHarness(bridge)
  await rig.controller.begin()
  await rig.controller.pollOnce()
  await rig.controller.decideReservation(false)
  assert.deepEqual(bridge.decisions, [false])
  const html = rig.controller.markup()
  assert.match(html, /Nothing was added to an account, and that code is now spent\./)
  assert.match(html, /data-connect-action="restart"/, 'the spent code has a one-click fresh start')
  assert.equal(rig.controller.isTicking(), false)
  rig.controller.destroy()
})

test('while a decision is on the wire both controls are greyed out and carry the reason', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const bridge = uiBridge({
    email: 'owner@example.com',
    decision: () => held,
    collected: { ok: true, state: 'connected', device: { name: 'Desk', deviceId: 'd', pairId: 'p' } },
  })
  const rig = uiHarness(bridge)
  await rig.controller.begin()
  await rig.controller.pollOnce()
  const deciding = rig.controller.decideReservation(true)
  const html = rig.controller.markup()
  assert.equal((html.match(/disabled aria-disabled="true"/g) || []).length, 2)
  assert.match(html, /A decision is already being sent\. Wait for this computer to answer\./)
  release({ ok: true, state: 'accepted' })
  await deciding
  rig.controller.destroy()
})
