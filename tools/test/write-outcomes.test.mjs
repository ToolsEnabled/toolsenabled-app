/* The answer to a write, held where a torn-down surface cannot lose it.
 *
 * WHAT THIS IS GUARDING. A sweep of every `if (destroyed)` site in src/ found
 * seven paths outside #/approvals with the shape src/approval-outcomes.js was
 * written for: a REAL write is sent, the view instance is retired while the
 * answer is in flight, and `if (destroyed) return` -- sitting above the line
 * that reads the result -- throws the answer away. The most expensive of them is
 * a Codex Cloud launch: real billable remote work that the product's own copy
 * says cannot be cancelled once accepted, whose task id is the only handle the
 * person has on it.
 *
 * This suite covers the store and, through the four DOM-free controllers, the
 * actual destroyed-mid-flight journey: send, tear the instance down before the
 * answer lands, build a fresh instance, and assert the answer is still there.
 * The absence cases are first-class, because this codebase's signature defect is
 * a missing field, an empty string or a falsy default being read as permission.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WRITE_OUTCOME_KEYS,
  clearUndeliveredWrite,
  recordUndeliveredWrite,
  resetUndeliveredWrites,
  restatedMessage,
  undeliveredWrite,
  undeliveredWriteCount,
  undeliveredWrites,
} from '../../src/write-outcomes.js'
import { createCloudTaskController } from '../../src/cloud-tasks-controller.js'
import { createLedgerArchiveController } from '../../src/mission-bridge.js'
import { createLoopController } from '../../src/agent-loops.js'
import { createTeamController } from '../../src/agent-teams.js'

const fresh = () => { resetUndeliveredWrites() }

/* ------------------------------ the store ------------------------------ */

test('an outcome is filed under its surface and read back', () => {
  fresh()
  const entry = recordUndeliveredWrite('cloud-launch', { tone: 'confirmed', message: 'queued · task t-1.' })
  assert.equal(entry.key, 'cloud-launch')
  assert.equal(entry.tone, 'confirmed')
  assert.equal(entry.message, 'queued · task t-1.')
  assert.equal(undeliveredWriteCount(), 1)
  assert.equal(undeliveredWrite('some-other-surface'), null,
    'a surface with no missed outcome must read as null, never as a truthy default')
})

test('ABSENCE: no usable key and no usable message are both refused, not filed under a blank', () => {
  fresh()
  assert.equal(recordUndeliveredWrite('', { tone: 'refused', message: 'x' }), null)
  assert.equal(recordUndeliveredWrite('   ', { tone: 'refused', message: 'x' }), null)
  assert.equal(recordUndeliveredWrite(null, { tone: 'refused', message: 'x' }), null)
  assert.equal(recordUndeliveredWrite('k', { tone: 'refused', message: '' }), null)
  assert.equal(recordUndeliveredWrite('k', { tone: 'refused', message: '   ' }), null)
  assert.equal(recordUndeliveredWrite('k', { tone: 'refused' }), null)
  assert.equal(recordUndeliveredWrite('k'), null)
  assert.equal(recordUndeliveredWrite('k', {}), null)
  assert.equal(undeliveredWriteCount(), 0,
    'an entry nothing can attribute and nothing can clear would sit on a screen forever')
})

test('ABSENCE: a missing or unrecognised tone reads as refused, never as confirmed', () => {
  fresh()
  assert.equal(recordUndeliveredWrite('k', { message: 'something happened' }).tone, 'refused')
  assert.equal(recordUndeliveredWrite('k2', { tone: '', message: 'm' }).tone, 'refused')
  assert.equal(recordUndeliveredWrite('k3', { tone: 'ok', message: 'm' }).tone, 'refused')
  assert.equal(recordUndeliveredWrite('k4', { tone: true, message: 'm' }).tone, 'refused')
  assert.equal(recordUndeliveredWrite('k5', { tone: 'confirmed', message: 'm' }).tone, 'confirmed',
    'a caller that DOES say it went well is still believed')
})

test('one entry per surface: the newer missed outcome replaces the older one', () => {
  fresh()
  recordUndeliveredWrite('k', { tone: 'refused', message: 'first' })
  recordUndeliveredWrite('k', { tone: 'confirmed', message: 'second' })
  assert.equal(undeliveredWriteCount(), 1)
  assert.equal(undeliveredWrite('k').message, 'second')
})

test('a delivered later outcome clears the missed one; nothing else does', () => {
  fresh()
  recordUndeliveredWrite('k', { tone: 'refused', message: 'm' })
  assert.equal(clearUndeliveredWrite('nope'), false)
  assert.equal(clearUndeliveredWrite(''), false)
  assert.equal(undeliveredWriteCount(), 1, 'a clear naming no surface must prune nothing')
  assert.equal(clearUndeliveredWrite('k'), true)
  assert.equal(undeliveredWrite('k'), null)
})

test('entries are frozen copies, newest first, and a long message is bounded', () => {
  fresh()
  recordUndeliveredWrite('a', { tone: 'refused', message: 'older', atMs: 1000 })
  recordUndeliveredWrite('b', { tone: 'refused', message: 'newer', atMs: 2000 })
  const all = undeliveredWrites()
  assert.deepEqual(all.map(entry => entry.key), ['b', 'a'])
  assert.equal(Object.isFrozen(all[0]), true)
  all.pop()
  assert.equal(undeliveredWriteCount(), 2, 'the returned array must be a copy')
  const long = recordUndeliveredWrite('c', { tone: 'refused', message: 'x'.repeat(5000) })
  assert.equal(long.message.length, 600)
  assert.equal(long.message.endsWith('…'), true)
})

test('a non-finite timestamp falls back to now rather than storing NaN', () => {
  fresh()
  assert.equal(Number.isFinite(recordUndeliveredWrite('k', { tone: 'refused', message: 'm', atMs: NaN }).atMs), true)
  assert.equal(Number.isFinite(recordUndeliveredWrite('k2', { tone: 'refused', message: 'm', atMs: 'later' }).atMs), true)
})

test('restatedMessage labels the sentence as missed, and refuses to invent one', () => {
  fresh()
  const entry = recordUndeliveredWrite('k', { tone: 'refused', message: 'Not launched · BRIDGE_TIMEOUT.' })
  assert.equal(restatedMessage(entry), 'While you were on another screen: Not launched · BRIDGE_TIMEOUT.')
  assert.equal(restatedMessage(null), '')
  assert.equal(restatedMessage({}), '')
  assert.equal(restatedMessage({ message: '' }), '')
})

/* --------------------- the journeys, per controller --------------------- */

const READY = Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })
const flush = () => new Promise(resolve => setImmediate(resolve))
const NO_TIMERS = { setTimeout: () => 1, clearTimeout: () => {} }

function deferred() {
  let settle
  const promise = new Promise(resolve => { settle = resolve })
  return { promise, settle }
}

/* --- fixtures, matching the shapes each controller's own suite already uses --- */

const ENVIRONMENT = 'a'.repeat(32)

const ACCOUNTS_REPLY = {
  ok: true,
  receipt: {
    action: 'cloud-accounts',
    accounts: [{ name: 'first', role: 'work', canServe: true, usedPercent: 4 }],
    defaultAccount: 'first',
    environments: [{
      environmentId: ENVIRONMENT,
      label: 'Owner/repo',
      repository: 'Owner/repo',
      repositories: ['Owner/repo'],
      defaultBranch: 'main',
      visibility: 'private',
      launchable: true,
      reason: null,
      accounts: ['first'],
    }],
    environmentsComplete: true,
    environmentsReadAt: '2026-08-11T00:00:00.000Z',
  },
}

const LAUNCH_REQUEST = { environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' }

/* The two-step arm-then-confirm, driven to the point where the launch is in
   flight and nothing has answered yet. */
async function armedCloudController(launchReply) {
  const controller = createCloudTaskController({
    postAction: async (action) => {
      if (action === 'cloud-accounts') return ACCOUNTS_REPLY
      if (action === 'cloud-launch') return launchReply
      return { ok: true, receipt: { action: 'cloud-tasks', tasks: [], account: 'first' } }
    },
    availability: READY,
    timers: NO_TIMERS,
  })
  await controller.loadAccounts()
  controller.arm(LAUNCH_REQUEST)
  assert.equal(controller.isArmed(), true, 'fixture must actually arm, or the journey is not exercised')
  return controller
}

/* THE ENGINE'S RECEIPT SHAPE (capability/src/lib/mission-bridge/actions.js
   normalizedLedgerArchiveResult): candidates carry a target and a structured
   reason, a confirm carries the one target it applied. The fixture this file
   used to hold (candidates {id, reasonCode, reason}, movedIds/movedCount) was
   a shape the engine never produced. */
const ARCHIVE_PLAN = 'a'.repeat(64)
const ARCHIVE_TARGET = { targetKind: 'request', requestId: 'R54' }
const ARCHIVE_CANDIDATES = [
  { targetKind: 'request', requestId: 'R54', reason: { code: 'completed', detail: 'status done and every declared gate is met:true', supersedingRequestIds: [] } },
]

function archiveReceipt(dryRun, overrides = {}) {
  return {
    ok: true,
    receipt: {
      action: 'ledger-archive',
      actor: 'coordinator-sol',
      at: '2026-08-07T12:00:00.000Z',
      planSha256: ARCHIVE_PLAN,
      candidates: ARCHIVE_CANDIDATES,
      restorables: dryRun ? [] : [ARCHIVE_TARGET],
      inconsistencies: [],
      activeCount: 474,
      archiveCount: dryRun ? 0 : 1,
      dryRun,
      appliedTarget: dryRun ? null : ARCHIVE_TARGET,
      changedCount: dryRun ? 0 : 1,
      ...(dryRun ? {} : { intentAudit: { sequence: 40, eventHash: 'b'.repeat(64) } }),
      audit: { sequence: dryRun ? 39 : 41, eventHash: 'c'.repeat(64) },
      ...overrides,
    },
  }
}

const dispatchReceipt = (tier, launchId) => ({
  ok: true,
  receipt: { action: 'dispatch', tier, launchId, agentId: 'x', auditSequence: 1, auditEventHash: 'a'.repeat(64) },
})

test('CLOUD LAUNCH: a task id that arrives after the panel closes survives to the next panel', async () => {
  fresh()
  const gate = deferred()
  const controller = await armedCloudController(gate.promise)
  const confirming = controller.confirm()
  controller.destroy()                    // the arrow is pressed, mid-flight
  gate.settle({ ok: true, receipt: { launched: true, taskId: 'task-9', state: 'SUBMITTED', account: { name: 'primary' } } })
  await confirming

  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.CLOUD_LAUNCH)
  assert.ok(missed, 'the launch receipt must not be lost with the panel')
  assert.match(missed.message, /task-9/)
  assert.equal(missed.tone, 'confirmed')

  const next = createCloudTaskController({ postAction: async () => ({ ok: false }), availability: READY })
  assert.match(next.getState().launchMessage, /^While you were on another screen: /)
  assert.match(next.getState().launchMessage, /task-9/)
  assert.equal(next.getState().launchTone, 'confirmed')
})

test('CLOUD LAUNCH: the UNKNOWN "a task may or may not exist" warning survives too', async () => {
  fresh()
  const gate = deferred()
  const controller = await armedCloudController(gate.promise)
  const confirming = controller.confirm()
  controller.destroy()
  gate.settle({ ok: true, receipt: { launched: false, state: 'UNKNOWN', message: 'The CLI did not answer.' } })
  await confirming

  const next = createCloudTaskController({ postAction: async () => ({ ok: false }), availability: READY })
  assert.match(next.getState().launchMessage, /may or may not have been created/,
    'dropping this is how one press becomes two real cloud tasks')
  assert.equal(next.getState().launchTone, 'refused')
})

test('CLOUD LAUNCH: a refusal that arrives after the panel closes survives too', async () => {
  fresh()
  const gate = deferred()
  const controller = await armedCloudController(gate.promise)
  const confirming = controller.confirm()
  controller.destroy()
  gate.settle({ ok: false, code: 'BRIDGE_TIMEOUT', reason: 'the launch request timed out' })
  await confirming
  /* [B6] was `/Not launched · BRIDGE_TIMEOUT/`. What is filed for the next
     mount must be the sentence a person will read there, not a grep term --
     this is the restatement surface, so the identifier would have been shown to
     them twice. */
  const filed = undeliveredWrite(WRITE_OUTCOME_KEYS.CLOUD_LAUNCH).message
  assert.match(filed, /^Not launched · /)
  assert.doesNotMatch(filed, /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/, `a bare identifier was filed for restatement: ${filed}`)
  assert.match(filed, /the launch request timed out/, 'the engine’s own sentence must survive verbatim')
  assert.match(filed, /Refresh the task list/, 'a launch refusal must say to look before pressing again')
})

test('CLOUD LAUNCH: an outcome the person DID see is not restated on the next panel', async () => {
  fresh()
  const controller = await armedCloudController({
    ok: true,
    receipt: { launched: true, taskId: 'task-1', state: 'SUBMITTED' },
  })
  await controller.confirm()
  assert.equal(undeliveredWriteCount(), 0, 'the person was on the screen; there is nothing to carry')
  const next = createCloudTaskController({ postAction: async () => ({ ok: false }), availability: READY })
  assert.equal(next.getState().launchMessage, '')
  assert.equal(next.getState().launchTone, 'note')
})

test('LEDGER ARCHIVE: a real move whose answer lands after the view closes is restated, not lost', async () => {
  fresh()
  const gate = deferred()
  const controller = createLedgerArchiveController({
    postAction: async (_action, body) => (body.dryRun ? archiveReceipt(true) : gate.promise),
  })
  await controller.click()                                       // dry run
  assert.equal(controller.getState().phase, 'confirm')
  const moving = controller.click()                              // the REAL move
  controller.destroy()
  gate.settle(archiveReceipt(false))
  await moving

  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE)
  assert.ok(missed, 'a disposition was appended to the durable overlay; that must not vanish')
  assert.match(missed.message, /^Archived R54\./)
  assert.equal(missed.tone, 'confirmed')

  const next = createLedgerArchiveController({ postAction: async () => ({ ok: false }) })
  assert.match(next.getState().message, /^While you were on another screen: Archived R54\./)
  assert.equal(next.getState().note, 'Result you did not see')
})

test('LEDGER ARCHIVE: a dry-run preview that lands after the view closes files nothing', async () => {
  fresh()
  const gate = deferred()
  const controller = createLedgerArchiveController({ postAction: async () => gate.promise })
  const previewing = controller.click()
  controller.destroy()
  gate.settle(archiveReceipt(true))
  await previewing
  assert.equal(undeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE), null,
    'a dry run moved nothing, so there is no outcome to carry')
})

test('LEDGER ARCHIVE: a move whose receipt did not match the preview is restated as NOT confirmed', async () => {
  fresh()
  const gate = deferred()
  const controller = createLedgerArchiveController({
    postAction: async (_action, body) => (body.dryRun ? archiveReceipt(true) : gate.promise),
  })
  await controller.click()
  const moving = controller.click()
  controller.destroy()
  /* The applied target is the thing held against the confirm -- not the plan
     hash, which changes with every append to the overlay. */
  gate.settle(archiveReceipt(false, { appliedTarget: { targetKind: 'request', requestId: 'R999' } }))
  await moving
  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.LEDGER_ARCHIVE)
  assert.match(missed.message, /Preview again before any retry/)
  assert.equal(missed.tone, 'refused')
})

test('LOOP STOP: "was NOT confirmed stopped" survives the panel closing mid-terminate', async () => {
  fresh()
  const gate = deferred()
  const controller = createLoopController({
    plan: { runnable: true, tier: 'luna', iterations: 2, intervalMs: 600_000, identity: 'luna', overrun: { sentence: 'bounded.' } },
    postAction: async (action) => (action === 'terminate' ? gate.promise : { ok: false }),
    observeLiveTarget: async () => ({ runId: 'run-1', agentId: 'luna', pid: 4242, status: 'running' }),
    createIdempotencyKey: () => 'key-1',
    setTimer: () => 1,
    clearTimer: () => {},
  })
  const stopping = controller.stop()
  await flush()
  controller.destroy()
  gate.settle({ ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: 'no answer' })
  await stopping

  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.LOOP_STOP)
  assert.ok(missed, 'a terminate was sent at a real PID; its answer must not vanish')
  assert.match(missed.message, /was NOT confirmed stopped/)
  assert.equal(missed.tone, 'refused')
})

test('LOOP STOP: a stop that sent no terminate at all files nothing', async () => {
  fresh()
  const controller = createLoopController({
    plan: { runnable: true, tier: 'luna', iterations: 2, intervalMs: 600_000, identity: 'luna', overrun: { sentence: 'bounded.' } },
    postAction: async () => ({ ok: false }),
    observeLiveTarget: async () => null,          // nothing in flight to kill
    createIdempotencyKey: () => 'key-1',
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await controller.stop()
  assert.equal(undeliveredWriteCount(), 0, 'nothing happened, so there is no outcome to carry')
})

test('TEAM DISPATCH: launch ids of lanes that are actually running survive the panel', async () => {
  fresh()
  const gate = deferred()
  let sends = 0
  const plan = { dispatchable: true, lead: 'sol', members: ['luna'] }
  const controller = createTeamController({
    plan,
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 4, capMs: 60_000 } },
    postAction: async (_action, body) => {
      sends += 1
      if (sends === 1) return dispatchReceipt(body.tier, 'launch_lead_aaaaaaaaaa')
      return gate.promise
    },
  })
  const running = controller.run()
  await flush()
  await flush()
  assert.equal(sends, 2, 'the member dispatch must be in flight before the panel closes')
  controller.destroy()
  gate.settle({ ok: false, code: 'BRIDGE_AGENT_LANE_COLLISION', reason: 'identity busy' })
  await running

  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.TEAM_DISPATCH)
  assert.ok(missed, 'the lead lane is running; the summary naming it must not be dropped')
  assert.match(missed.message, /launch_lead_aaaaaaaaaa/)
  assert.equal(missed.tone, 'refused')

  const next = createTeamController({ plan, postAction: async () => ({ ok: false }) })
  assert.match(next.getState().message, /^While you were on another screen: /)
  assert.match(next.getState().message, /launch_lead_aaaaaaaaaa/)
})

test('TEAM DISPATCH: closing the panel stops FURTHER dispatches but still reports what ran', async () => {
  fresh()
  const tiers = []
  const plan = { dispatchable: true, lead: 'sol', members: ['luna', 'terra'] }
  const gate = deferred()
  const controller = createTeamController({
    plan,
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: {} },
    postAction: async (_action, body) => {
      tiers.push(body.tier)
      if (tiers.length === 1) return dispatchReceipt(body.tier, 'launch_lead_bbbbbbbbbb')
      if (tiers.length === 2) return gate.promise
      return dispatchReceipt(body.tier, 'launch_never_cccccccccc')
    },
  })
  const running = controller.run()
  await flush()
  await flush()
  controller.destroy()
  gate.settle(dispatchReceipt('luna', 'launch_luna_dddddddddd'))
  await running

  assert.deepEqual(tiers, ['sol', 'luna'], 'terra must never be dispatched after the panel closed')
  const missed = undeliveredWrite(WRITE_OUTCOME_KEYS.TEAM_DISPATCH)
  assert.match(missed.message, /1 of 2 members started/)
  assert.match(missed.message, /never dispatched because this panel closed first/)
})

test('a fresh surface with nothing missed says its ordinary opening line', () => {
  fresh()
  const cloud = createCloudTaskController({ postAction: async () => ({ ok: false }), availability: READY })
  assert.equal(cloud.getState().launchMessage, '')
  const archive = createLedgerArchiveController({ postAction: async () => ({ ok: false }) })
  assert.match(archive.getState().message, /^Preview completed or fully superseded/)
  assert.equal(archive.getState().note, 'Owner-gated')
  const team = createTeamController({ plan: { dispatchable: true, lead: 'sol', members: ['luna'] }, postAction: async () => ({ ok: false }) })
  assert.match(team.getState().message, /^Dispatch sol as lead/)
  const loop = createLoopController({
    plan: { runnable: true, tier: 'luna', iterations: 2, intervalMs: 600_000, identity: 'luna', overrun: { sentence: 'bounded.' } },
    postAction: async () => ({ ok: false }),
  })
  assert.match(loop.getState().message, /^Run luna 2 times/)
})
