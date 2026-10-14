import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
const { createNodeTranscriptStore } = createRequire(import.meta.url)('../../shell/node-transcript-store.cjs')
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { PERSON_STOP_NOTE, MANAGER_STOP_NOTE } from '../../src/stop-node-session.js'
import { createFleetTreeStore, nodeDisplayName } from '../../src/fleet-trees.js'
import { createTranscriptStore, TRANSCRIPT_LIMITS } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { manualAccountHandoff, savedAccountResumeRefused, savedSessionEffort, saveStoppedSessionEffort, isModelHandoff, MODEL_HANDOFF_OPENING } from '../../src/manual-account-continuation.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

function memoryStorage() {
  const cells = new Map()
  return {
    fail: false,
    read(key) { return cells.has(key) ? structuredClone(cells.get(key)) : null },
    write(key, value) { if (this.fail) return false; cells.set(key, structuredClone(value)); return true },
  }
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(t, overrides = {}) {
  let serial = 0
  const treeStorage = memoryStorage()
  const transcriptStorage = memoryStorage()
  const handoffStorage = memoryStorage()
  const handoffStore = createRecoveryHandoffStore({ computerId: 'local', storage: handoffStorage, bridge: overrides.handoffBridge })
  const treeStore = createFleetTreeStore({ computerId: 'local', storage: treeStorage,
    ...(overrides.treeNow ? { now: overrides.treeNow } : {}),
    makeId: kind => `${kind}-${++serial}` })
  const add = args => { const result = treeStore.addNode(args); assert.equal(result.ok, true); return result.node }
  const manager = add({ role: 'controller', message: 'Manage the work' })
  const node = add({ parentId: manager.id, role: 'worker', message: 'Finish the task', tier: 'claude-sonnet' })
  const child = add({ parentId: node.id, role: 'reviewer', message: 'Review the task' })
  assert.equal(treeStore.attachSession(node.id, 'old-session').ok, true)
  treeStore.setNodeStatus(node.id, 'turn-failed')
  const transcriptStore = { ...createTranscriptStore({ computerId: 'local', storage: transcriptStorage }) }
  const originalLines = [{ who: 'you', text: 'Finish the task', at: 1 },
    { who: 'agent', text: 'The first step is complete.', at: 2 }]
  assert.equal(transcriptStore.save(node.id, { lines: originalLines, threadId: 'old-thread', account: 'old-account', provider: 'claude' }), true)
  transcriptStore.readLatest = async id => ({ ...transcriptStore.get(id), recoveryDirectory: '/fixture/retained-conversation' })
  const calls = { close: [], start: [], send: [], sendAutomatic: [], address: [], outbox: [], notices: [], cleanup: [] }
  const closeEntered = deferred(), startEntered = deferred()
  const eventListeners = new Set()
  const bridge = {
    async ledger() { return { ok: true, records: [], chain: { checked: false, ok: null } } },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    async close(args) { calls.close.push(args); closeEntered.resolve(); return overrides.close ? overrides.close(args) : { sessionId: args.sessionId, closed: true } },
    async start(args) { calls.start.push(args); startEntered.resolve(); return overrides.start ? overrides.start(args) : { ok: true, sessionId: 'new-session', threadId: 'new-thread', account: args.treeAccount || 'new-account' } },
    async send(args) { calls.send.push(args); return overrides.send ? overrides.send(args) : { ok: true } },
    async sendAutomatic(args) {
      calls.sendAutomatic.push(args)
      /* Keep the historical aggregate for the existing recovery assertions;
         the separate log proves the automatic path was used. */
      calls.send.push(args)
      if (overrides.sendAutomatic) return overrides.sendAutomatic(args)
      const result = overrides.send ? await overrides.send(args) : { ok: true }
      // Match the tracked public automatic-send bridge, including its nested
      // provider result; the ordinary person-send reply is a different shape.
      return { ok: true, result, deliveryDisposition: 'accepted' }
    },
    async updateTreeAddress(args) { calls.address.push(args); return overrides.updateTreeAddress ? overrides.updateTreeAddress(args) : { ok: true } },
  }
  if (overrides.continuations) bridge.continuations = overrides.continuations
  if (overrides.sessionActivity) bridge.sessionActivity = overrides.sessionActivity
  const sessionNodeIds = new Map([['old-session', node.id]])
  const defaultOrgBridge = {
    read: async () => ({
      ok: true,
      org: { revision: 1, agents: [{ id: node.id, role: node.role, roleSelection: node.role, provider: 'claude', enabled: true }] },
      roles: [{ id: 'controller', revision: 1, capabilities: { orgRoot: true } },
        { id: 'worker', revision: 1 }, { id: 'reviewer', revision: 1 }],
    }),
    ensureSeat: async request => ({
      ok: true,
      org: { revision: 2, agents: [{ id: request.id, role: request.role, roleSelection: request.roleSelection || '', provider: request.provider || 'claude', enabled: true }] },
    }),
  }
  const coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds,
    orgBridge: defaultOrgBridge,
    tiers: LAUNCH_TIERS,
    ...overrides.retryOptions,
    onCleanupRequired: (store, nodeId, sessionId) => {
      calls.cleanup.push({ nodeId, sessionId })
      store.attachSession(nodeId, sessionId)
      store.setNodeStatus(nodeId, 'failed', { note: 'Cleanup required' })
    },
    canStart: Object.hasOwn(overrides, 'canStart') ? overrides.canStart : () => true,
    canContinue: Object.hasOwn(overrides, 'canContinue') ? overrides.canContinue : () => true,
    ...(overrides.isReplacing ? { isReplacing: overrides.isReplacing } : {}),
    moveOutbox: (...args) => calls.outbox.push(args) })
  coordinator.register('local', { treeStore, transcriptStore, handoffStore })
  coordinator.subscribe(value => calls.notices.push(value))
  t.after(() => coordinator.destroy())
  const packet = { sessionId: 'old-session', event: { type: 'account_recovery_needed', recoveryId: 'ticket-1', handoff: manualAccountHandoff(treeStore.getNode(node.id), { ...transcriptStore.get(node.id), recoveryDirectory: '/fixture/retained-conversation' }, null) } }
  return { closeEntered: closeEntered.promise, startEntered: startEntered.promise, coordinator, bridge, packet, calls, treeStore, transcriptStore, treeStorage, transcriptStorage,
    emit: packet => { for (const listener of eventListeners) listener(packet) },
    handoffStore, handoffStorage, sessionNodeIds, manager, node, child, originalLines, add, orgBridge: defaultOrgBridge }
}



test('redirected handoff refusal waits for persistence and visibly pauses without closing the predecessor or writing settings', async t => {
  const gate = deferred()
  const requests = []
  const f = fixture(t, { handoffBridge: {
    save: request => { requests.push(request); return gate.promise },
    get: async () => ({ ok: true, record: null }),
  } })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].record.handoff, f.packet.event.handoff)
  assert.equal(f.handoffStore.get(f.node.id), null, 'redirected handoff cannot refill settings')
  assert.equal(f.calls.close.length, 0, 'pending persistence cannot close the predecessor')
  gate.resolve({ ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } })
  assert.equal(await flight, false)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.match(f.calls.notices.at(-1).error, /Could not save the full recovery handoff/)
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
})

test('manual continuation visibly refuses an unreadable recovery checkpoint without closing or starting', async t => {
  const f = fixture(t, { handoffBridge: {
    save: async () => ({ ok: true }),
    get: async () => ({ ok: false, error: { code: 'RECOVERY_MIGRATION_CONFLICT',
      message: 'Saved recovery checkpoints conflict. Both copies were preserved.' } }),
  } })
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.match(f.calls.notices.at(-1).error, /checkpoints conflict.*copies were preserved/)
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
})



/* MEASURED, Worker 36 and Controller 2026-09-06: activeStore(computerId) could
 * answer a store superseded by a later register() call for the same computer,
 * for as long as the recovery that first captured it stayed in flight -- the
 * one case openTreeStore's own resolution chain (src/views/computers.js)
 * relies on activeStore to get right, because a destroyed-and-reopened view
 * is exactly when it consults this source. Drives the actual sequence with
 * values: a recovery starts and is held mid-flight, the computer is
 * re-registered with a genuinely different treeStore while that recovery is
 * still running, and both the store activeStore hands out AND the paused
 * recovery's own completion are checked -- not the internal field name that
 * happens to hold the fix. */
test('re-registering a computer mid-recovery replaces the store activeStore hands out, and the paused recovery still completes', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.start.length, 1, 'the recovery is in flight, waiting on bridge.start')
  assert.equal(f.coordinator.activeStore('local'), f.treeStore,
    'before any re-registration, activeStore answers the store the recovery began with')

  let serial = 0
  const freshTreeStore = createFleetTreeStore({ computerId: 'local', storage: memoryStorage(),
    makeId: kind => `fresh-${kind}-${++serial}` })
  f.coordinator.register('local', { treeStore: freshTreeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })

  assert.equal(f.coordinator.activeStore('local'), freshTreeStore,
    'a re-registration during an in-flight recovery must replace the superseded store, not keep handing out the one the recovery began with')
  assert.notEqual(f.coordinator.activeStore('local'), f.treeStore)

  gate.resolve({ ok: true, sessionId: 'new-session', threadId: 'new-thread', account: 'new-account' })
  const result = await flight
  assert.equal(result, true, 'the recovery must still complete across the re-registration, not merely stop returning a stale store')
  assert.equal(f.calls.send.length, 1, 'the replacement session still receives its handoff')
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session',
    'the in-flight recovery keeps writing through its OWN original context, unaffected by the re-registration')

  assert.equal(f.coordinator.activeStore('local'), null,
    'once the recovery settles, activeStore no longer claims one is in flight')
})

test('missing, denied, malformed and unreadable start consent never closes or starts an agent', async t => {
  for (const canStart of [undefined, null, () => false, () => 'true', () => Promise.resolve(true), () => { throw new Error('unreadable consent') }]) {
    const f = fixture(t, { canStart })
    await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
    assert.deepEqual(f.calls.close, [])
    assert.deepEqual(f.calls.start, [])
    assert.deepEqual(f.calls.send, [])
    assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
  }
})

test('saved actual effort outranks initial node effort and stopped selection preserves conversation metadata', t => {
  const f = fixture(t)
  f.treeStore.setNodeLaunchPreferences(f.node.id, { effort: 'ultra' })
  const prior = { ...f.transcriptStore.get(f.node.id), effort: 'medium' }
  assert.equal(f.transcriptStore.save(f.node.id, prior), true)
  assert.equal(savedSessionEffort({ savedEffort: f.transcriptStore.get(f.node.id).effort,
    nodeEffort: f.treeStore.getNode(f.node.id).effort, tierEffort: 'high' }), 'medium')
  assert.equal(saveStoppedSessionEffort({ nodeId: f.node.id, effort: 'low',
    transcriptStore: f.transcriptStore, treeStore: f.treeStore }), true)
  const after = f.transcriptStore.get(f.node.id)
  assert.equal(after.effort, 'low')
  for (const key of ['lines', 'threadId', 'provider', 'account']) assert.deepEqual(after[key], prior[key])
  assert.equal(savedSessionEffort({ savedEffort: after.effort, nodeEffort: 'ultra' }), 'low')
  f.transcriptStorage.fail = true
  assert.equal(saveStoppedSessionEffort({ nodeId: f.node.id, effort: 'high',
    transcriptStore: f.transcriptStore, treeStore: f.treeStore }), false)
  assert.equal(f.transcriptStore.get(f.node.id).effort, 'low')
})

test('manual continuation of a stopped node uses another account with chosen model and no native resume', async t => {
  const f = fixture(t)
  f.sessionNodeIds.delete('old-session')
  const before = f.treeStore.getNode(f.node.id)
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id,
    startOptions: { treeAccount: 'new-account', tier: 'claude-opus', effort: 'medium', profileId: 'profile-1', roleBinding: { agentId: 'identity-1' },
      resumeThreadId: 'must-not-travel', resumeAccount: 'must-not-travel', accountRecovery: { recoveryId: 'must-not-travel' } } }), true)
  assert.equal(f.calls.close.length, 0, 'a stopped session is not closed again')
  const request = f.calls.start[0]
  assert.equal(request.treeAccount, 'new-account')
  assert.equal(request.tier, 'claude-opus')
  assert.equal(request.effort, 'medium')
  assert.equal(request.profileId, 'profile-1')
  assert.deepEqual(request.roleBinding, { agentId: 'identity-1' })
  for (const key of ['resumeThreadId', 'resumeAccount', 'accountRecovery']) assert.equal(key in request, false)
  const after = f.treeStore.getNode(f.node.id)
  for (const key of ['id', 'parentId', 'treeId', 'role', 'nameOrdinal']) assert.equal(after[key], before[key])
  assert.equal(f.treeStore.getNode(f.child.id).parentId, f.node.id)
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines.slice(0, 2), f.originalLines)
  assert.equal(f.transcriptStore.get(f.node.id).effort, 'medium')
  assert.ok(f.calls.send[0].text.includes('The first step is complete.'))
  assert.deepEqual(f.calls.outbox, [['old-session', 'new-session']])
})

/* T1792: agent.resume on a slot whose account changed runs this continuation.
   The next assignment the resume carried is the last section of its handoff,
   the replacement's first turn, labelled with the calling circle's name. */
test('an account continuation started by agent.resume carries its next assignment in the first turn', async t => {
  const f = fixture(t)
  f.sessionNodeIds.delete('old-session')
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id,
    startOptions: { treeAccount: 'new-account' }, assignment: { text: 'Take T1768: fix the resume copy.', fromName: 'Controller 1' } }), true)
  assert.equal(f.calls.send.length, 1, 'one first turn, no second message')
  const text = f.calls.send[0].text
  const section = text.indexOf('New assignment sent with this resume, from "Controller 1":\n\nTake T1768: fix the resume copy.')
  assert.ok(section > 0, 'the assignment is in the first turn, labelled with the caller')
  assert.ok(section > text.indexOf('Preserve completed work and continue the remaining task.'), 'it follows the handoff closing')
  assert.ok(section > text.indexOf('The first step is complete.'), 'after the saved work it builds on')
  assert.match(text, /Do not stop at reporting that earlier work is complete; do this assignment now\./)
  assert.match(text, /not from the person/)
  assert.match(f.handoffStore.get(f.node.id).handoff, /Take T1768: fix the resume copy\./, 'the saved checkpoint is the handoff that was sent')
})

test('manual continuation saves a full checkpoint and keeps history when no replacement is eligible', async t => {
  const f = fixture(t, { start: () => ({ ok: false, reason: 'No eligible backup account' }) })
  f.sessionNodeIds.delete('old-session')
  const handoff = 'Completed work and remaining tasks. '.repeat(800)
  f.handoffStore.save(f.node.id, { sessionId: 'old-session', handoff })
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.ok(f.handoffStore.get(f.node.id).handoff.includes(handoff))
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines.slice(0, 2), f.originalLines)
  assert.equal(f.calls.send.length, 0)
})

test('manual continuation refuses busy nodes, duplicate clicks, and failed durable checkpoints', async t => {
  const f = fixture(t)
  f.treeStore.setNodeStatus(f.node.id, 'running')
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.start.length, 0)
  f.treeStore.setNodeStatus(f.node.id, 'turn-failed')
  f.handoffStorage.fail = true
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.close.length, 0)
  const gate = deferred()
  const g = fixture(t, { start: () => gate.promise })
  g.sessionNodeIds.delete('old-session')
  const first = g.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: g.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(await g.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: g.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  gate.resolve({ sessionId: 'new-session', account: 'new-account' })
  assert.equal(await first, true)
  assert.equal(g.calls.start.length, 1)
})

test('manual retries reuse the full saved handoff without nesting or losing its tail', async t => {
  const f = fixture(t, { start: () => ({ ok: false, reason: 'No eligible backup account' }) })
  f.sessionNodeIds.delete('old-session')
  assert.equal(f.handoffStore.save(f.node.id, { sessionId: 'old-session', handoff: 'Context '.repeat(5900) + 'FINAL CHECKPOINT' }), true)
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  const first = f.handoffStore.get(f.node.id).handoff
  assert.ok(first.includes('FINAL CHECKPOINT'))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
    assert.equal(f.handoffStore.get(f.node.id).handoff, first)
  }
  assert.equal(f.calls.send.length, 0)
})

test('manual handoff ignores another session checkpoint and classifies only saved-account refusals', () => {
  const handoff = manualAccountHandoff({ sessionId: 'current', message: 'Task' },
    { lines: [{ who: 'agent', text: 'Current progress' }] }, { sessionId: 'older', handoff: 'Obsolete progress' })
  assert.ok(handoff.includes('Current progress'))
  assert.equal(handoff.includes('Obsolete progress'), false)
  for (const code of ['AGENT_RESUME_ACCOUNT_UNAVAILABLE', 'AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT']) {
    assert.equal(savedAccountResumeRefused(code), true)
  }
  assert.equal(savedAccountResumeRefused('AGENT_SESSION_CLEANUP_FAILED'), false)
})

test('next-session model and effort preferences preserve the whole existing branch and reject refused storage', t => {
  const f = fixture(t)
  const before = f.treeStore.getNode(f.node.id)
  const saved = f.treeStore.setNodeLaunchPreferences(f.node.id, { tier: 'claude-opus', effort: 'medium' })
  assert.equal(saved.ok, true)
  const after = f.treeStore.getNode(f.node.id)
  for (const key of ['id', 'sessionId', 'parentId', 'treeId', 'role', 'nameOrdinal', 'message']) assert.equal(after[key], before[key])
  assert.equal(after.tier, 'claude-opus')
  assert.equal(after.effort, 'medium')
  assert.equal(f.treeStore.getNode(f.child.id).parentId, f.node.id)
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.node.id, { tier: 'bad\nmodel' }).ok, false)
  f.treeStorage.fail = true
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.node.id, { effort: 'high' }).snapshot.persistenceFailed, true)
})



test('successful recovery needs no DOM and keeps node, topology, old conversation, and one handoff', async t => {
  const f = fixture(t)
  const before = f.treeStore.getNode(f.node.id)
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  const after = f.treeStore.getNode(f.node.id)
  for (const key of ['id', 'treeId', 'parentId', 'role', 'message', 'tier', 'nameOrdinal']) assert.equal(after[key], before[key], key)
  assert.equal(after.sessionId, 'new-session')
  assert.equal(after.status, 'running')
  assert.equal(f.treeStore.getNode(f.child.id).parentId, f.node.id)
  assert.deepEqual(f.calls.close, [{ sessionId: 'old-session' }])
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].treeAccount, 'new-account')
  assert.equal(f.calls.start[0].replacesSessionId, 'old-session')
  assert.deepEqual(f.calls.outbox, [['old-session', 'new-session']])
  assert.equal(f.sessionNodeIds.has('old-session'), false)
  assert.equal(f.sessionNodeIds.get('new-session'), f.node.id)
  const saved = f.transcriptStore.get(f.node.id)
  assert.deepEqual(saved.lines.slice(0, 2), f.originalLines)
  const handoffs = saved.lines.filter(line => line.who === 'action' && line.tool === 'Recovery handoff')
  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].state, 'done', 'the acknowledged handoff save records its successful outcome')
  const reopened = createTranscriptStore({ computerId: 'local', storage: f.transcriptStorage }).get(f.node.id)
  assert.equal(reopened.lines.find(line => line.tool === 'Recovery handoff').state, 'done')
  assert.equal(saved.threadId, 'new-thread')
  assert.equal(saved.account, 'new-account')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.sendAutomatic.length, 1, 'replacement handoff uses the trusted automatic bridge')
  assert.equal(f.calls.send[0].sessionId, 'new-session')
  assert.ok(f.calls.send[0].text.includes(f.packet.event.handoff))
  // T377 item 8: the CONTEXT channel is intact (the replacement is sent the full
  // handoff, asserted just above, and it is durable in handoffStore, below), but
  // the DISPLAY is de-doubled. Before, the last transcript line was the whole
  // sent handoff rendered as a `who: 'you'` line -- the prior conversation shown
  // a second time. Now the recovery adds ONE compact continuation action line and
  // NO `you` line, so the chat does not repeat the conversation.
  assert.ok(f.handoffStore.get(f.node.id).handoff.includes(f.packet.event.handoff),
    'the full handoff is preserved in the durable handoff store')
  const tail = saved.lines.at(-1)
  assert.equal(tail.who, 'action')
  assert.equal(tail.tool, 'Recovery handoff')
  assert.match(tail.text, /Continued on another (account|model)/)
  assert.ok(!tail.text.includes(f.packet.event.handoff),
    'the continuation line is compact, not the inlined prior conversation')
  assert.ok(!saved.lines.some(line => line.who === 'you' && line.text.includes(f.packet.event.handoff)),
    'the sent handoff is not repeated in the transcript as a person message')
  assert.equal(f.coordinator.isRecovering(f.node.id), false)
})



test('refused handoff persistence leaves old session open and conversation intact', async t => {
  const f = fixture(t)
  f.transcriptStorage.fail = true
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.start, [])
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.match(f.calls.notices.at(-1).error, /save/i)
})

test('refused tree-state persistence does not close the old session', async t => {
  const f = fixture(t)
  f.treeStorage.fail = true
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.start, [])
  assert.match(f.calls.notices.at(-1).error, /latest tree changes could not be saved/)
  // T377 item 8: the handoff is preserved through a tree-state failure in the
  // durable handoff store (saved before the tree change), not by inlining the
  // whole prior conversation into the transcript. The transcript carries only
  // the compact continuation line.
  assert.equal(f.handoffStore.get(f.node.id).handoff, f.packet.event.handoff,
    'the full handoff survives a refused tree-state save, in the durable store')
  assert.ok(!f.transcriptStore.get(f.node.id).lines.some(line => line.text === f.packet.event.handoff),
    'the handoff is not inlined into the transcript')
})

test('no eligible replacement preserves conversation and reports recovery paused', async t => {
  const f = fixture(t, { start: () => ({ ok: false, reason: 'No eligible account' }) })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.send.length, 0)
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines.slice(0, 2), f.originalLines)
  assert.equal(f.transcriptStore.get(f.node.id).threadId, 'old-thread')
  assert.equal(f.treeStore.getNode(f.node.id).status, 'turn-failed')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /No eligible account/)
  assert.equal(f.coordinator.isRecovering(f.node.id), false)
})

test('changing the node session during spawn closes the orphan without replacing owner choice', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await f.startEntered
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.treeStore.attachSession(f.node.id, 'owner-session').ok, true)
  gate.resolve({ ok: true, sessionId: 'orphan-session' })
  await flight
  assert.deepEqual(f.calls.close, [{ sessionId: 'old-session' }, { sessionId: 'orphan-session' }])
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'owner-session')
  assert.equal(f.sessionNodeIds.has('orphan-session'), false)
  assert.equal(f.calls.send.length, 0)
})

test('moving the agent while spawn is pending sends its current manager and tree address', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const newManager = f.add({ role: 'planner', message: 'Manage a different tree' })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await f.startEntered
  assert.equal(f.treeStore.moveNode(f.node.id, newManager.id).ok, true)
  gate.resolve({ ok: true, sessionId: 'new-session', account: 'new-account' })
  await flight
  const node = f.treeStore.getNode(f.node.id)
  const managerName = nodeDisplayName(newManager, f.treeStore.listNodes(newManager.treeId))
  assert.equal(node.parentId, newManager.id)
  assert.equal(node.treeId, newManager.treeId)
  assert.equal(f.treeStore.getNode(f.child.id).treeId, newManager.treeId)
  assert.deepEqual(f.calls.address[0].requestKeys.treeAnchors, [newManager.id, f.node.id])
  assert.equal(f.calls.address[0].managerName, managerName)
  assert.ok(f.calls.send[0].text.includes(`your manager is "${managerName}"`))
})

test('conversation messages appended during replacement startup survive the final save', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await f.startEntered
  const saved = f.transcriptStore.get(f.node.id)
  const later = { who: 'you', text: 'Also preserve the latest owner correction.', at: 3 }
  assert.equal(f.transcriptStore.save(f.node.id, { ...saved, lines: [...saved.lines, later] }), true)
  gate.resolve({ ok: true, sessionId: 'new-session' })
  await flight
  assert.ok(f.transcriptStore.get(f.node.id).lines.some(line => line.text === later.text))
})

test('final transcript refusal exposes attached replacement but never sends an unrecorded handoff', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await f.startEntered
  f.transcriptStorage.fail = true
  gate.resolve({ ok: true, sessionId: 'new-session', threadId: 'new-thread', account: 'new-account' })
  await flight
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
  assert.equal(f.treeStore.getNode(f.node.id).status, 'turn-failed')
  assert.ok(f.calls.notices.some(notice => notice.started?.sessionId === 'new-session'))
  assert.match(f.calls.notices.at(-1).error, /save/)
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines.slice(0, 2), f.originalLines)
})

test('refused replacement reporting address prevents sending a misleading handoff', async t => {
  const f = fixture(t, { updateTreeAddress: () => ({ ok: false }) })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'turn-failed')
  assert.match(f.calls.notices.at(-1).error, /address/)
})

test('a long recovery handoff is durably saved in full before closing the old session', async t => {
  let f
  const handoff = 'The person chose to continue this same agent on another account in a fresh session.\n\n' + 'Complete progress and remaining tasks. '.repeat(1000)
  f = fixture(t, { close: args => {
    assert.equal(f.handoffStore.get(f.node.id).handoff, handoff)
    return { sessionId: args.sessionId, closed: true }
  } })
  assert.equal(f.handoffStore.save(f.node.id, { sessionId: 'old-session', kind: 'manual', handoff }), true)
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.send.length, 1)
  assert.ok(f.calls.send[0].text.startsWith(handoff))
  assert.equal(f.handoffStore.get(f.node.id).handoff, handoff)
})

test('a refused full-handoff save cannot be replaced by a successful transcript excerpt save', async t => {
  const f = fixture(t)
  f.handoffStorage.fail = true
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.match(f.calls.notices.at(-1).error, /save/i)
})





test('a throwing view observer cannot interrupt recovery or other observers', async t => {
  const f = fixture(t)
  let observed = false
  f.coordinator.subscribe(() => { throw new Error('Detached view failed') })
  f.coordinator.subscribe(() => { observed = true })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(observed, true)
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'running')
})

test('moving during address acknowledgment refreshes the address before sending the brief', async t => {
  let f
  let moved = false
  let newManager
  f = fixture(t, { updateTreeAddress: () => {
    if (!moved) {
      moved = true
      assert.equal(f.treeStore.moveNode(f.node.id, newManager.id).ok, true)
    }
    return { ok: true }
  } })
  newManager = f.add({ role: 'planner', message: 'New reporting line' })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.address.length, 2)
  assert.deepEqual(f.calls.address.at(-1).requestKeys.treeAnchors, [newManager.id, f.node.id])
  const name = nodeDisplayName(newManager, f.treeStore.listNodes(newManager.treeId))
  assert.ok(f.calls.send[0].text.includes(`your manager is "${name}"`))
})



test('offroute recovered replies are saved and completion settles the node', async t => {
  const f = fixture(t)
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  f.emit({ sessionId: 'new-session', event: { type: 'assistant_text_delta', text: 'Step two ' } })
  f.emit({ sessionId: 'new-session', event: { type: 'assistant_text_delta', text: 'is complete.' } })
  f.emit({ sessionId: 'new-session', event: { type: 'turn_completed', status: 'completed' } })
  assert.equal(f.transcriptStore.get(f.node.id).lines.at(-1).text, 'Step two is complete.')
  assert.equal(f.treeStore.getNode(f.node.id).reply, 'Step two is complete.')
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
})

test('mounted transcript observer remains the single writer of recovered replies', async t => {
  const f = fixture(t)
  f.coordinator.subscribe(() => {}, { observes: nodeId => nodeId === f.node.id })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  const saved = f.transcriptStore.get(f.node.id)
  f.emit({ sessionId: 'new-session', event: { type: 'assistant_text_delta', text: 'Mounted reply.' } })
  f.transcriptStore.save(f.node.id, { ...saved, lines: [...saved.lines, { who: 'agent', text: 'Mounted reply.', at: 9 }] })
  f.emit({ sessionId: 'new-session', event: { type: 'turn_completed', status: 'completed' } })
  assert.equal(f.transcriptStore.get(f.node.id).lines.filter(line => line.text === 'Mounted reply.').length, 1)
})

test('offroute cancellation keeps its own outcome and turn identity without starting more work', async t => {
  const f = fixture(t)
  f.treeStore.setNodeStatus(f.node.id, 'running')
  f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'cancelled', turnId: 'offroute-cancelled' } })
  const node = f.treeStore.getNode(f.node.id)
  assert.equal(node.status, 'cancelled')
  assert.equal(node.lastTurnId, 'offroute-cancelled')
  assert.equal(node.statusNote, 'This turn ended without finishing.')
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.send.length, 0)
})

test('the exact active store is available across navigation until recovery finishes', async t => {
  const gate = deferred()
  const f = fixture(t, { start: () => gate.promise })
  const flight = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await Promise.resolve()
  assert.equal(f.coordinator.activeStore('local'), f.treeStore)
  f.coordinator.register('local', { treeStore: f.coordinator.activeStore('local'),
    transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  gate.resolve({ sessionId: 'new-session', account: 'new-account' })
  await flight
  assert.equal(f.coordinator.activeStore('local'), null)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
})

test('a reopened observer receives the partial backup reply accumulated offroute', async t => {
  const f = fixture(t)
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  f.emit({ sessionId: 'new-session', event: { type: 'assistant_text_delta', text: 'Work in progress' } })
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  assert.equal(f.calls.notices.at(-1).partialText, 'Work in progress')
  assert.equal(f.calls.notices.at(-1).started.sessionId, 'new-session')
})

test('disabled starts and an explicit replacement prevent automatic provider launch', async t => {
  for (const overrides of [{ canStart: () => false }, { isReplacing: () => true }]) {
    const f = fixture(t, overrides)
    await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
    assert.equal(f.calls.close.length, 0)
    assert.equal(f.calls.start.length, 0)
  }
})

test('a replacement without a thread id does not inherit the previous provider thread', async t => {
  const f = fixture(t, { start: () => ({ sessionId: 'new-session', account: 'new-account' }) })
  await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.transcriptStore.get(f.node.id).threadId, null)
})





test('canonical recovery refreshes current disk history and waits for durable save before closing', async t => {
  const f = fixture(t)
  const gate = deferred()
  let current = f.transcriptStore.get(f.node.id)
  let saves = 0
  const latest = { ...current, recoveryDirectory: '/fixture/canonical-history', threadId: 'canonical-thread', effort: 'high',
    lines: [...current.lines, { who: 'agent', text: 'New canonical progress after navigation.', at: 3 }] }
  const transcripts = {
    get: () => current,
    async readLatest() { current = latest; return current },
    async save(_id, record) { if (++saves === 1) await gate.promise; current = record; return true },
  }
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: transcripts, handoffStore: f.handoffStore })
  const pending = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  gate.resolve()
  assert.equal(await pending, true)
  assert.ok(current.lines.some(line => line.text === 'New canonical progress after navigation.'))
  assert.equal(current.effort, 'high')
})

test('a rejected canonical save keeps the predecessor and refuses automatic continuation', async t => {
  const f = fixture(t)
  const transcripts = { get: () => f.transcriptStore.get(f.node.id), readLatest: () => f.transcriptStore.readLatest(f.node.id), async save() { throw new Error('Disk refused the handoff') } }
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: transcripts, handoffStore: f.handoffStore })
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.match(f.calls.notices.at(-1).error, /Disk refused/)
})

test('a refused asynchronous recovery checkpoint publishes an error before closing the predecessor', async t => {
  const f = fixture(t)
  f.handoffStore.saveRecord = async () => false
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
  assert.match(f.calls.notices.at(-1).error, /Could not save the full recovery handoff/)
})

test('manual continuation refuses an unreadable external checkpoint instead of replacing it with an excerpt', async t => {
  const f = fixture(t)
  f.handoffStore.readRecord = async () => { throw new Error('Checkpoint unreadable') }
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), false)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines)
  assert.match(f.calls.notices.at(-1).error, /Checkpoint unreadable/)
})

test('asynchronous checkpoint durability completes before the predecessor is closed', async t => {
  const f = fixture(t)
  const gate = deferred()
  f.handoffStore.saveRecord = () => gate.promise
  const recovery = f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } })
  assert.equal(f.calls.close.length, 0)
  gate.resolve(true)
  assert.equal(await recovery, true)
  assert.equal(f.calls.close.length, 1)
})

function savedContinuation(f, hook = async () => undefined) {
  const record = { key: 'a'.repeat(64), revision: 7, descriptor: { sessionId: 'old-session', resumeThreadId: 'old-thread',
    resumeThreadProvider: 'claude', requestKeys: { threadId: f.node.id, treeAnchors: [f.manager.id, f.node.id] } } }
  f.sessionNodeIds.delete('old-session')
  const calls = []
  f.bridge.continuations = async request => {
    calls.push(request)
    const answer = await hook(request)
    if (answer !== undefined) return answer
    if (request.action === 'read') return { enabled: true, records: [record] }
    if (request.action === 'resume') return { sessionId: 'old-session', threadId: 'old-thread', resumed: { turns: [{ status: 'completed' }] },
      continuation: { key: record.key, revision: 11, status: 'ready' } }
    return { ok: true, closed: request.action === 'discard' }
  }
  return { calls, record }
}

test('Autonomous+ restores an existing saved circle and transcript before confirming the durable attachment', async t => {
  const f = fixture(t)
  const c = savedContinuation(f, request => {
    if (request.action === 'attached') {
      assert.deepEqual(f.transcriptStore.get(f.node.id).lines, f.originalLines, 'native resume retains original model conversation excerpt')
      assert.equal(f.sessionNodeIds.get('old-session'), f.node.id)
      assert.equal(request.revision, 11)
    }
  })
  await f.coordinator.pollContinuations()
  assert.deepEqual(c.calls.map(row => row.action), ['read', 'resume', 'attached'])
  assert.equal(c.calls[1].requestKeys.threadId, f.node.id)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /Autonomous\+ restored/)
  assert.equal(f.calls.start.length, 0, 'all restoration goes through the trusted continuation admission, not a second loose start')
  assert.equal(f.calls.send.length, 0, 'host scheduler supplies the next ledger turn after attachment')
})

test('Autonomous+ recreates a released node seat before native resume and uses the same start admission fields', async t => {
  let f
  const events = []
  const seatRequests = []
  const orgBridge = {
    read: async () => {
      events.push('org.read')
      return {
        ok: true,
        org: { revision: 7, agents: [{ id: 'controller-seat', role: 'controller', enabled: true }] },
        roles: [{ id: 'controller', revision: 1, capabilities: { orgRoot: true } }, { id: 'worker', revision: 2 }],
      }
    },
    ensureSeat: async request => {
      events.push('org.ensure')
      seatRequests.push(request)
      return { ok: true, org: { revision: 8, agents: [{ id: request.id, role: request.role, provider: request.provider, enabled: true }] } }
    },
  }
  f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f, request => { events.push('continuation.' + request.action) })
  await f.coordinator.pollContinuations()
  assert.equal(seatRequests.length, 1)
  assert.equal(seatRequests[0].id, f.node.id)
  assert.equal(seatRequests[0].role, 'worker')
  assert.equal(seatRequests[0].provider, 'claude')
  assert.equal(seatRequests[0].managerId, undefined, 'the fixture manager is not the declared controller-seat')
  assert.deepEqual(events, ['continuation.read', 'org.read', 'org.ensure', 'continuation.resume', 'continuation.attached'])
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 1)
})

test('Autonomous+ reuses an existing node seat without creating a second one', async t => {
  let f
  let ensures = 0
  const orgBridge = {
    read: async () => ({
      ok: true,
      org: { revision: 3, agents: [{ id: f.node.id, role: 'worker', roleSelection: 'worker', provider: 'claude', enabled: true }] },
      roles: [{ id: 'worker', revision: 2 }],
    }),
    ensureSeat: async () => { ensures += 1; return { ok: true, org: { revision: 4, agents: [] } } },
  }
  f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f)
  await f.coordinator.pollContinuations()
  assert.equal(ensures, 0)
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 1)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
})

test('Autonomous+ does not touch a node whose session the host still holds', async t => {
  let f
  let reads = 0
  let ensures = 0
  const orgBridge = {
    read: async () => { reads += 1; return { ok: true, org: { revision: 1, agents: [] }, roles: [{ id: 'worker', revision: 1 }] } },
    ensureSeat: async () => { ensures += 1; return { ok: true, org: { revision: 2, agents: [] } } },
  }
  f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f)
  f.sessionNodeIds.set('old-session', f.node.id)
  await f.coordinator.pollContinuations()
  assert.ok(c.calls.every(row => row.action === 'read'))
  assert.equal(reads, 0)
  assert.equal(ensures, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
})

test('Autonomous+ refuses visibly and never resumes when the node seat cannot be ensured', async t => {
  let f
  const orgBridge = {
    read: async () => ({ ok: true, org: { revision: 3, agents: [] }, roles: [{ id: 'worker', revision: 1 }] }),
    ensureSeat: async () => ({ ok: false, code: 'ORG_ENSURE_SEAT_REFUSED', reason: 'The saved node seat could not be restored.' }),
  }
  f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f)
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  await f.coordinator.pollContinuations()
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0)
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /saved node seat could not be restored/i)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
})

test('Autonomous+ remembers a terminal seat refusal until its session or record revision changes', async t => {
  let f
  let reads = 0
  let ensures = 0
  const orgBridge = {
    read: async () => {
      reads += 1
      return { ok: true, org: { revision: 3, agents: [] }, roles: [{ id: 'worker', revision: 1 }] }
    },
    ensureSeat: async () => {
      ensures += 1
      return { ok: false, code: 'ORG_ENSURE_SEAT_REFUSED', reason: 'The saved node seat could not be restored.' }
    },
  }
  f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f)
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  for (let sweep = 0; sweep < 3; sweep += 1) await f.coordinator.pollContinuations()
  assert.equal(reads, 1, 'a terminal refusal reads the organisation once')
  assert.equal(ensures, 1, 'a terminal refusal asks for the seat once')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0, 'a refused seat never reaches native resume')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /saved node seat could not be restored/i)
  c.record.revision += 1
  await f.coordinator.pollContinuations()
  assert.equal(reads, 2, 'a changed continuation revision asks again')
  assert.equal(ensures, 2, 'a changed continuation revision retries the seat')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0)
  assert.equal(f.treeStore.attachSession(f.node.id, 'new-session').ok, true)
  c.record.descriptor.sessionId = 'new-session'
  await f.coordinator.pollContinuations()
  assert.equal(reads, 3, 'a changed node session asks again')
  assert.equal(ensures, 3, 'a changed node session retries the seat')
  await f.coordinator.pollContinuations()
  assert.equal(reads, 3, 'the new terminal stamp suppresses the next sweep')
  assert.equal(ensures, 3, 'the new terminal stamp suppresses the next seat request')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0)
})

test('Autonomous+ retries a throwing seat read only after the continuation backoff', async t => {
  let at = 1000
  let reads = 0
  let ensures = 0
  const orgBridge = {
    read: async () => {
      reads += 1
      throw new Error('organisation transport unavailable')
    },
    ensureSeat: async () => {
      ensures += 1
      return { ok: true }
    },
  }
  const f = fixture(t, { retryOptions: { orgBridge, now: () => at } })
  const c = savedContinuation(f)
  await f.coordinator.pollContinuations()
  assert.equal(reads, 1)
  assert.equal(ensures, 0)
  at += 29999
  await f.coordinator.pollContinuations()
  assert.equal(reads, 1, 'a transport failure is not retried on the next five-second tick')
  at += 1
  await f.coordinator.pollContinuations()
  assert.equal(reads, 2, 'the read is retried after the injected backoff')
  assert.equal(ensures, 0)
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0)
})

test('Autonomous+ keeps a remembered seat refusal while the tree store cannot be listed, and lists nothing when nothing is remembered', async t => {
  let ensures = 0
  let refuse = false
  const orgBridge = {
    read: async () => ({ ok: true, org: { revision: 3, agents: [] }, roles: [{ id: 'worker', revision: 1 }] }),
    ensureSeat: async request => {
      ensures += 1
      return refuse
        ? { ok: false, code: 'ORG_ENSURE_SEAT_REFUSED', reason: 'The saved node seat could not be restored.' }
        : { ok: true, org: { revision: 4, agents: [{ id: request.id, role: request.role, enabled: true }] } }
    },
  }
  const f = fixture(t, { retryOptions: { orgBridge } })
  // The same real store behind a listing that can be made to fail; every other door is the store's own.
  let listings = 0, unreadable = false
  const store = Object.fromEntries(Object.keys(f.treeStore).map(key => [key, f.treeStore[key]]))
  store.snapshot = () => { listings += 1; if (unreadable) throw new Error('unreadable'); return f.treeStore.snapshot() }
  f.coordinator.register('local', { treeStore: store, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  // Registering lists the tree once to hydrate retry policies; let that settle before counting sweeps.
  for (let turn = 0; turn < 3; turn += 1) await new Promise(resolve => setImmediate(resolve))
  f.bridge.continuations = async () => ({ enabled: true, records: [] })
  const listedBeforeSweep = listings
  await f.coordinator.pollContinuations()
  assert.equal(listings, listedBeforeSweep, 'a sweep with nothing remembered does not list the tree')
  refuse = true
  const c = savedContinuation(f)
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  await f.coordinator.pollContinuations()
  assert.equal(ensures, 1)
  unreadable = true
  await f.coordinator.pollContinuations()
  unreadable = false
  await f.coordinator.pollContinuations()
  assert.equal(ensures, 1, 'a listing that failed once is not proof the circle went away, so the refusal is still remembered')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0)
})

test('Autonomous+ does not resume when the node session changes during seat admission', async t => {
  const entered = deferred()
  const release = deferred()
  let ensures = 0
  const orgBridge = {
    read: async () => ({ ok: true, org: { revision: 5, agents: [] }, roles: [{ id: 'worker', revision: 1 }] }),
    ensureSeat: async () => {
      ensures += 1
      entered.resolve()
      await release.promise
      return { ok: true, org: { revision: 6, agents: [] } }
    },
  }
  const f = fixture(t, { retryOptions: { orgBridge } })
  const c = savedContinuation(f)
  const pending = f.coordinator.pollContinuations()
  await entered.promise
  assert.equal(f.treeStore.attachSession(f.node.id, 'new-session').ok, true)
  release.resolve()
  await pending
  assert.equal(ensures, 1)
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 0, 'a changed session cannot be resumed')
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
})

test('Stop during a saved-thread start persists its fence and discards that exact pending attachment', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred()
  const c = savedContinuation(f, async request => {
    if (request.action === 'resume') { entered.resolve(); await gate.promise }
  })
  const pending = f.coordinator.pollContinuations(); await entered.promise
  assert.equal(await f.coordinator.stopContinuation(f.node.id), true)
  gate.resolve(); await pending
  assert.deepEqual(c.calls.map(row => row.action), ['read', 'resume', 'stop', 'discard'])
  assert.equal(c.calls.at(-1).revision, 11)
  assert.equal(f.treeStore.getNode(f.node.id).statusNote, 'Stopped by you.')
  assert.equal(f.sessionNodeIds.has('old-session'), false)
  assert.equal(f.calls.notices.some(row => row.started), false)
});

test('a Stop while transcript persistence is pending cannot be overwritten by a late recovery', async t => {
  const f = fixture(t), gate = deferred(), saving = deferred()
  const c = savedContinuation(f)
  const save = f.transcriptStore.save
  f.coordinator.register('local', { treeStore: f.treeStore, handoffStore: f.handoffStore,
    transcriptStore: { ...f.transcriptStore, save: async (...args) => { saving.resolve(); await gate.promise; return save(...args) } } })
  await saving.promise
  await f.coordinator.stopContinuation(f.node.id); gate.resolve()
  for (let i = 0; i < 20 && f.coordinator.isRecovering(f.node.id); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(c.calls.some(row => row.action === 'attached'), false)
  assert.equal(f.treeStore.getNode(f.node.id).statusNote, 'Stopped by you.')
  assert.equal(f.calls.notices.some(row => row.started), false)
});

test('saved continuation refuses nonlocal starts and durably stops a mismatched conversation', async t => {
  let local = false
  const f = fixture(t, { canContinue: () => local })
  const c = savedContinuation(f)
  await f.coordinator.pollContinuations(); assert.equal(c.calls.length, 0)
  local = true
  f.transcriptStore.save(f.node.id, { ...f.transcriptStore.get(f.node.id), threadId: 'a-different-thread' })
  await f.coordinator.pollContinuations()
  assert.deepEqual(c.calls.map(row => row.action), ['read', 'stop'])
  assert.equal(f.calls.start.length, 0)
});

test('Home bootstrap opens existing saved trees and restores opted-in work without mounting Page 2', async t => {
  const f = fixture(t), c = savedContinuation(f)
  f.coordinator.destroy()
  const coordinator = createAccountRecoveryCoordinator({ bridge: f.bridge, sessionNodeIds: f.sessionNodeIds,
    orgBridge: f.orgBridge, tiers: LAUNCH_TIERS, canStart: () => true, canContinue: () => true })
  t.after(() => coordinator.destroy())
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const start = source.indexOf('let continuationBootstrap = null'), end = source.indexOf('const RUN_TREE_RUNTIME_STORES', start)
  assert.ok(start > 0 && end > start)
  /* `seatSessionEvidence` is the seam the seat counters read (T407 review). It is
     declared beside RUN_SESSION_NODES, ABOVE this slice, so it has to be supplied
     here. Home runs no saved-session sweep of its own, so the faithful answer is
     null -- no evidence yet, and therefore the old seat count. */
  let imageContextReads = 0
  const recoveryImageContext = () => {
    imageContextReads += 1
    // This bridge deliberately has no imageQueue capability. Match the real
    // retained image-context helper's explicit unavailable branch.
    return { available: false, unavailable: 'IMAGE_RECOVERY_IMAGE_QUEUE_UNAVAILABLE',
      bridge: f.bridge, canContinue: () => true }
  }
  const [initialize, cleanup] = new Function('window', 'FLEET', 'currentDataSource', 'recoveryCoordinator', 'safeTreeStorage',
    'createTreeRuntimeView', 'createFleetTreeStore', 'RUN_SESSION_NODES', 'seatSessionEvidence', 'createTranscriptStore', 'createNodeTranscriptClient', 'createRecoveryHandoffStore', 'recoveryImageContext',
    source.slice(start, end).replaceAll('export function ', 'function ') + '\nreturn [initializeAutonomousContinuations, () => clearInterval(continuationBootstrap)]')(
    { mcAgent: f.bridge, localStorage: {} }, { machines: [{ id: 'local' }] }, () => 'local', () => coordinator,
    () => f.treeStorage, store => store, createFleetTreeStore, f.sessionNodeIds, () => null, () => f.transcriptStore,
    () => { throw new Error('This fixture has no native transcript bridge') }, () => f.handoffStore, recoveryImageContext)
  t.after(cleanup)
  initialize()
  for (let i = 0; i < 30 && !c.calls.some(row => row.action === 'attached'); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(imageContextReads, 1, 'bootstrap registers the retained image capability context')
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 1)
  assert.equal(f.sessionNodeIds.get('old-session'), f.node.id)
  assert.equal(coordinator.sessionStore('local').getNode(f.node.id).status, 'finished')
  assert.match(readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8'), /\ninitializeAutonomousContinuations\(\)/)
});

test('Stop fences the renderer immediately while its durable acknowledgement is still pending', async t => {
  const f = fixture(t), opening = deferred(), opened = deferred(), stopping = deferred(), stopSeen = deferred()
  const c = savedContinuation(f, async request => {
    if (request.action === 'resume') { opened.resolve(); await opening.promise }
    if (request.action === 'stop') { stopSeen.resolve(); await stopping.promise }
  })
  const recovery = f.coordinator.pollContinuations(); await opened.promise
  const stop = f.coordinator.stopContinuation(f.node.id); await stopSeen.promise
  opening.resolve(); await recovery
  assert.equal(c.calls.some(row => row.action === 'attached'), false)
  assert.equal(f.calls.notices.some(row => row.started), false)
  stopping.resolve(); await stop
  assert.equal(f.treeStore.getNode(f.node.id).statusNote, 'Stopped by you.')
});

test('an observed off-page provider exit retires runtime mapping and permits exact saved recovery', async t => {
  const f = fixture(t), c = savedContinuation(f)
  f.sessionNodeIds.set('old-session', f.node.id)
  f.emit({ sessionId: 'old-session', event: { type: 'session_ended', reason: 'exited', exit: { code: 1, signal: null } } })
  assert.equal(f.sessionNodeIds.has('old-session'), false)
  await f.coordinator.pollContinuations()
  assert.equal(c.calls.filter(row => row.action === 'resume').length, 1)
  assert.equal(f.sessionNodeIds.get('old-session'), f.node.id)
});

const retryTiers = [
  { id: 'claude-sonnet', provider: 'claude', label: 'Sonnet' },
  { id: 'claude-fable', provider: 'claude', label: 'Fable' },
  { id: 'astra', provider: 'codex', label: 'GPT-6-Astra', effort: 'max' },
]
function persistentOptions({ accounts = [{ name: 'old-account', provider: 'claude', signedIn: true }], now } = {}) {
  return { tiers: retryTiers, ...(now ? { now } : {}), readAccounts: async () => ({ available: true, accounts }),
    orgBridge: {
      read: async () => ({ ok: true, org: { revision: 2, agents: [{ id: 'worker-seat', role: 'worker', enabled: true }] }, roles: [{ id: 'worker', revision: 3 }] }),
      ensureSeat: async request => {
        const workerSeatAdoption = request.id === 'worker-seat' && request.role === 'worker' && request.adoptProvider === true
        const nodeOwnSeat = typeof request.nodeId === 'string' && request.id === request.nodeId && request.role === 'worker'
        assert.ok(workerSeatAdoption || nodeOwnSeat, 'unexpected organisation seat request in persistent retry')
        return { ok: true, org: { revision: 4 } }
      },
    } }
}

const settle = () => new Promise(resolve => setImmediate(resolve))





/* REVIEW P6. The opted-in retry carried the wanted depth to any Codex or
   Claude row without asking the model: a retry saved at ultra on GPT-5.6-Luna
   (1.0.47 offered every Codex word on every Codex model) sent
   model_reasoning_effort=ultra to a model with no ultra. It is held to each
   row now, from the real table; the person's own choice is still remembered. */


/* FOLLOW-UP V4, verify round 2. The page opts an agent into retries with the
   depth the person picked in the dialog, or else the node's saved depth or its
   model's default -- and every one was recorded as the person's own
   preferredEffort, the one depth a retry carries to another provider. A depth
   the page filled in is marked `effortChosen: false` now: it starts the agent
   on its own provider and is not carried to Claude. */






// Review R5 (2026-09-10): the failed quota turn is itself open work, so it is
// retried without a ledger task; ordinary prose still triggers nothing.


/* T17. THE LIMIT THAT ARRIVES AS PROSE, WITH NO CODE AT ALL.
 *
 * The measured failure: the owner's agent died on an account usage limit with
 * persistent continuation on, and nothing was recorded, held or retried. The
 * provider sent no structured code -- only the sentence "You've hit your
 * session limit · resets 1:30am (America/Los_Angeles)" -- and that sentence
 * never reached this surface either, because agent-host's turnFailureSentence()
 * refuses any sentence containing a slash so a path can never reach the person,
 * and an IANA timezone contains one.
 *
 * So this surface was handed an empty code and an empty text, and
 * retryFailureKind() classified it as nothing. Widening that regex would not
 * have helped: the sentence contains none of `quota`, `usage limit` or
 * `rate limit`. The shell's limitReason() reads the words as well as the code
 * and now carries its verdict as `failureReason`; this asserts that the verdict
 * is what drives the retry, by sending the event shape actually observed.
 */
























// OWNER REQUEST T137 (2026-09-16 02:58Z): "switch models still doesnt work. and
// it should work for even different providers because we can just hand the
// context to the next agent." The model switch a thread cannot make in place is
// the account continuation on another tier: start the chosen tier on whichever
// account the ordinary start picks, record the tier on the node and the
// provider on the transcript, send the model handoff.
//
// T158 CHANGED ONE ASSERTION IN THIS CASE, AND ONLY ONE. It used to require
// `f.calls.close` to equal [{ sessionId: 'old-session' }] -- "the live
// predecessor is closed plainly". That pinned the ORDER that lost a live
// conversation: measured 2026-09-16 on the promoted build, a cross-provider
// press closed the Claude session and the replacement start was then refused
// AGENT_ROLE_BINDING_INVALID, leaving the person with neither session and only
// the generic last-turn-failed word. The predecessor is now closed by
// shell/agent-host.cjs instead, AFTER its account, admission and authority
// checks pass and immediately before provider dispatch -- the boundary that
// file already owns and already explains ("closing it in the renderer before
// start made AGENT_RESUME_ACCOUNT_LIMIT irreversible"). Everything else this
// case asserts is unchanged and still passes.
test('a model continuation leaves the predecessor for the host to close, starts the chosen tier on the picked account, records tier and provider, and sends the model handoff', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS } })
  // 'finished' is a live session between turns (src/tree-session-liveness.js:
  // 'starting' and 'running' are the busy statuses); old-session is still owned.
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  const before = f.treeStore.getNode(f.node.id)
  assert.equal(before.tier, 'claude-sonnet')
  assert.equal(await f.coordinator.continueOnAnotherModel({ computerId: 'local', nodeId: f.node.id,
    startOptions: { tier: 'luna', treeAccount: 'picked-account', effort: 'medium', profileId: 'profile-1', roleBinding: { agentId: 'identity-1' },
      resumeThreadId: 'must-not-travel', accountRecovery: { recoveryId: 'must-not-travel' } } }), true)
  assert.deepEqual(f.calls.close, [],
    'the renderer must not close a session the person is still talking to before the replacement is known to be startable')
  const request = f.calls.start[0]
  assert.equal(request.tier, 'luna')
  assert.equal(request.effort, 'medium')
  assert.equal(request.profileId, 'profile-1')
  assert.deepEqual(request.roleBinding, { agentId: 'identity-1' })
  assert.equal(request.replacesSessionId, 'old-session')
  for (const key of ['continueFromAccount', 'accountRecovery', 'accountRetry', 'resumeThreadId']) {
    assert.equal(key in request, false, `${key} must not travel: no account is excluded, the ordinary start picks one for the new tier`)
  }
  const after = f.treeStore.getNode(f.node.id)
  assert.equal(after.tier, 'luna', 'the node records the tier that is actually running')
  assert.equal(after.effort, 'medium')
  assert.equal(after.sessionId, 'new-session')
  assert.equal(after.status, 'running')
  for (const key of ['id', 'parentId', 'treeId', 'role', 'message', 'nameOrdinal']) assert.equal(after[key], before[key], key)
  assert.equal(f.treeStore.getNode(f.child.id).parentId, f.node.id, 'the reports still report to it')
  const saved = f.transcriptStore.get(f.node.id)
  assert.equal(saved.provider, 'codex', 'the transcript records the new provider so the next resume uses it')
  assert.deepEqual(saved.lines.slice(0, 2), f.originalLines, 'the old conversation is kept')
  assert.equal(f.calls.send.length, 1)
  const sent = f.calls.send[0]
  assert.equal(sent.sessionId, 'new-session')
  assert.ok(sent.text.includes(MODEL_HANDOFF_OPENING), 'the new session is told this is a model continuation')
  assert.equal(isModelHandoff(sent.text), true, 'the fold recognises it as a model handoff')
  assert.match(sent.text, /Previous model: Sonnet \(latest\) \(claude\)\. New model: GPT-5\.6-Luna \(codex\)\./)
  assert.ok(sent.text.includes('The first step is complete.'), 'the conversation so far travels with it')
  assert.deepEqual(f.calls.outbox, [['old-session', 'new-session']])
  assert.equal(f.sessionNodeIds.get('new-session'), f.node.id)
  assert.equal(f.sessionNodeIds.has('old-session'), false)
})

test('a model continuation refuses the tier it is already on, an unknown tier, a node still starting or mid-turn, and a duplicate press', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS } })
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  const request = tier => ({ computerId: 'local', nodeId: f.node.id, startOptions: { tier, treeAccount: 'picked-account', roleBinding: { agentId: 'identity-1' } } })
  assert.equal(await f.coordinator.continueOnAnotherModel(request('claude-sonnet')), false, 'already on it')
  assert.equal(await f.coordinator.continueOnAnotherModel(request('not-a-tier')), false, 'unknown tier')
  f.treeStore.setNodeStatus(f.node.id, 'starting')
  assert.equal(await f.coordinator.continueOnAnotherModel(request('luna')), false, 'still starting')
  // The coordinator holds the mid-turn guard itself (review finding 1): a
  // caller that skips the view's check cannot close a turn out from under it.
  f.treeStore.setNodeStatus(f.node.id, 'running')
  assert.equal(await f.coordinator.continueOnAnotherModel(request('luna')), false, 'mid-turn')
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  const first = f.coordinator.continueOnAnotherModel(request('claude-opus'))
  assert.equal(await f.coordinator.continueOnAnotherModel(request('claude-opus')), false, 'a second press while the first is in flight')
  assert.equal(await first, true)
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].tier, 'claude-opus')
  assert.equal(f.treeStore.getNode(f.node.id).tier, 'claude-opus')
  assert.equal(f.transcriptStore.get(f.node.id).provider, 'claude')
})

/* ---- T367 / T381: THE REOPEN PATH RESTARTS ON A REFUSAL ----
 *
 * pollContinuations is the path that brings every saved agent back when the
 * app is reopened. Measured on this lane's base: a provider-attributed
 * AGENT_RESUME_ACCOUNT_LIMIT parked the circle at "Autonomous+ recovery paused:
 * ATTRIBUTED_TO_PROVIDER AGENT_RESUME_ACCOUNT_LIMIT" -- the wire token on the
 * circle -- with zero starts, because the only automatic route out of that
 * catch was a per-node keep-trying policy the person had to have opted into.
 * The Resume press already continued from the same refusal by itself; this
 * path did not. The three conditions are the press's own and each can only say
 * no: the provider refused it, keep-trying is on (asked of the window, failure
 * first), and nothing else already owns the retry. */
const providerRefusedResume = () => Object.assign(new Error('ATTRIBUTED_TO_PROVIDER AGENT_RESUME_ACCOUNT_LIMIT'), { code: 'AGENT_RESUME_ACCOUNT_LIMIT' })
function refusedContinuation(f, error) {
  const record = { key: 'r'.repeat(64), revision: 3, descriptor: { sessionId: 'old-session', resumeThreadId: 'old-thread', resumeThreadProvider: 'claude',
    resumeAccount: 'old-account', tier: 'claude-sonnet', effort: 'medium', requestKeys: { threadId: f.node.id, treeAnchors: [f.manager.id, f.node.id] } } }
  f.sessionNodeIds.delete('old-session')
  f.treeStore.setNodeStatus(f.node.id, 'finished')
  const calls = []
  f.bridge.continuations = async request => {
    calls.push(request.action)
    if (request.action === 'read') return { ok: true, enabled: true, records: [record] }
    if (request.action === 'resume') throw error()
    return { ok: true }
  }
  return { calls, record }
}
const twoAccounts = [{ name: 'old-account', provider: 'claude', signedIn: true }, { name: 'spare-account', provider: 'claude', signedIn: true }]



test('the same refusal with keep-trying off moves nothing and offers the switch instead, in the person\'s words', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => false } })
  refusedContinuation(f, providerRefusedResume)
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.deepEqual(f.calls.start, [])
  const offers = f.calls.notices.filter(row => row.switchOffer).map(row => row.switchOffer)
  assert.equal(offers.length, 1)
  assert.equal(offers[0].nodeId, f.node.id)
  assert.equal(offers[0].code, 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal(offers[0].attribution, 'provider')
  assert.equal(offers[0].account, 'old-account')
  assert.equal(offers[0].tier, 'claude-sonnet')
  assert.equal(offers[0].effort, 'medium')
  assert.doesNotMatch(offers[0].sentence, /ATTRIBUTED_TO_PROVIDER/)
  const node = f.treeStore.getNode(f.node.id)
  assert.equal(node.status, 'turn-failed')
  assert.doesNotMatch(node.statusNote, /ATTRIBUTED_TO_PROVIDER/, 'the paused note is the refusal sentence, not the wire token')
})

test('a consent read that throws is not consent: nothing is moved, the switch is offered', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => { throw new Error('settings unreadable') } } })
  refusedContinuation(f, providerRefusedResume)
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.deepEqual(f.calls.start, [])
  assert.equal(f.calls.notices.filter(row => row.switchOffer).length, 1)
})

test('a limit nobody attributed never moves the conversation on a guess, and is still offered as a choice', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => true } })
  refusedContinuation(f, () => Object.assign(new Error('AGENT_RESUME_ACCOUNT_LIMIT'), { code: 'AGENT_RESUME_ACCOUNT_LIMIT' }))
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.deepEqual(f.calls.start, [])
  const offers = f.calls.notices.filter(row => row.switchOffer)
  assert.equal(offers.length, 1)
  assert.equal(offers[0].switchOffer.attribution, null)
})

test('a signed-out saved account is not a limit: nothing is moved automatically, the switch is offered', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => true } })
  refusedContinuation(f, () => Object.assign(new Error('AGENT_RESUME_ACCOUNT_SIGNED_OUT'), { code: 'AGENT_RESUME_ACCOUNT_SIGNED_OUT' }))
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.deepEqual(f.calls.start, [])
  assert.equal(f.calls.notices.filter(row => row.switchOffer).length, 1)
  assert.equal(f.calls.notices.find(row => row.switchOffer).switchOffer.code, 'AGENT_RESUME_ACCOUNT_SIGNED_OUT')
})

/* THE DISMISSAL HAS TO STICK. pollContinuations is swept by register(), by a
   5 s interval and by pollAccountRetries, and each sweep re-attempts the same
   unfinished record and is refused again. These two say the offer is asked
   ONCE per refused session and still asked again when the refusal is genuinely
   new -- together they pin behaviour, not silence. */
test('three sweeps over one refused session offer the switch once, so "Not now" is not undone by the next sweep', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => false } })
  refusedContinuation(f, providerRefusedResume)
  for (let sweep = 0; sweep < 3; sweep += 1) { await f.coordinator.pollContinuations(); await settle(); await settle() }
  const offers = f.calls.notices.filter(row => row.switchOffer)
  assert.equal(offers.length, 1, 'one offer for one refused session, however many sweeps read the record')
  assert.equal(offers[0].switchOffer.code, 'AGENT_RESUME_ACCOUNT_LIMIT')
})

test('a refusal with a new reason on the same session is offered again: the guard silences repeats, not new questions', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => false } })
  refusedContinuation(f, providerRefusedResume)
  await f.coordinator.pollContinuations(); await settle(); await settle()
  assert.equal(f.calls.notices.filter(row => row.switchOffer).length, 1)
  refusedContinuation(f, () => Object.assign(new Error('AGENT_RESUME_ACCOUNT_SIGNED_OUT'), { code: 'AGENT_RESUME_ACCOUNT_SIGNED_OUT' }))
  await f.coordinator.pollContinuations(); await settle(); await settle()
  const offers = f.calls.notices.filter(row => row.switchOffer).map(row => row.switchOffer)
  assert.deepEqual(offers.map(row => row.code), ['AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'],
    'a different reason is a different question and is asked')
})

test('a refusal that is not about the saved account (the node changed) neither moves nor offers', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => true } })
  refusedContinuation(f, () => Object.assign(new Error('CONTINUATION_CHANGED'), { code: 'CONTINUATION_CHANGED' }))
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.deepEqual(f.calls.start, [])
  assert.equal(f.calls.notices.filter(row => row.switchOffer).length, 0)
})

/* A RESUME THAT WAS REFUSED IS NOT A TURN THAT FAILED.
 *
 * OBSERVED on the owner's profile, 2026-09-21: the first reopen whose saved
 * continuation read answered ran thirteen resumes, the host refused all
 * thirteen before any session existed, and ten FINISHED conversations were
 * rewritten to 'turn-failed'. The error below is the shape that reached the
 * window: Electron's invoke rejection, a sentence and no code. */
const hostRefusedBeforeStart = () => new Error("Error invoking remote method 'mc-agent:continuations': Error: That agent is no longer in the organisation. Reload the agent page, then retry the start.")
for (const saved of ['finished', 'interrupted', 'cancelled']) {
  test(`a reopen the host refuses before anything started leaves a ${saved} conversation ${saved} and says why`, async t => {
    const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => true } })
    const { calls } = refusedContinuation(f, hostRefusedBeforeStart)
    f.treeStore.setNodeStatus(f.node.id, saved)
    // Three sweeps: register(), the five-second interval and the retry poll all read the same record.
    for (let sweep = 0; sweep < 3; sweep += 1) { await f.coordinator.pollContinuations(); await settle(); await settle() }
    assert.ok(calls.filter(action => action === 'resume').length >= 1, 'the saved row was really offered and refused')
    assert.deepEqual(f.calls.start, [], 'nothing was started')
    const node = f.treeStore.getNode(f.node.id)
    assert.equal(node.status, saved, 'no turn ran, so the saved status stands')
    assert.equal(node.sessionId, 'old-session', 'the node keeps the session it was saved with')
    assert.match(node.statusNote, /^Autonomous\+ recovery paused: /, 'the person is still told')
    assert.equal(f.calls.notices.filter(row => row.nodeId === f.node.id && row.error).length, 1, 'said once, however many sweeps are refused the same way')
    assert.equal(f.calls.notices.filter(row => row.switchOffer).length, 0, 'not an account question')
  })
}

test('a node saved mid-start has no settled status to keep: a refused reopen still marks it', async t => {
  const f = fixture(t, { retryOptions: { tiers: LAUNCH_TIERS, readAccounts: async () => ({ available: true, accounts: twoAccounts }), keepTryingOnLimit: async () => true } })
  refusedContinuation(f, hostRefusedBeforeStart)
  f.treeStore.setNodeStatus(f.node.id, 'starting')
  await f.coordinator.pollContinuations()
  await settle(); await settle()
  assert.equal(f.treeStore.getNode(f.node.id).status, 'turn-failed')
})


// T731: a returned/thrown quota code alone is not proof that the handoff did
// not execute. Positive not-sent retry remains covered above.












test('catalogue read failure stays visible, backs off, and clears only after a readable catalogue', async t => {
  let at = 1000000
  const f = fixture(t, { retryOptions: { now: () => at } })
  await settle()
  const before = f.treeStore.snapshot()
  let answer = null, reads = 0, readGate = null
  f.bridge.continuations = async request => {
    assert.equal(request.action, 'read', 'unreadable catalogue must never authorize resume')
    reads++
    if (readGate) await readGate.promise
    if (!answer) throw new Error("Error invoking remote method 'mc-agent:continuations': Error: The task ledger history cannot be verified.")
    return answer
  }
  await f.coordinator.pollContinuations()
  const notices = () => f.calls.notices.filter(row => Object.hasOwn(row, 'continuationStatus'))
  assert.equal(notices().length, 1, 'the pre-row rejection must publish a catalogue-level status')
  const first = f.coordinator.continuationStatus()
  assert.equal(first.blocked, true)
  assert.match(first.reason, /history.*verif/i)
  assert.equal(notices()[0].nodeId, undefined, 'one unavailable catalogue is not an invented failure on every circle')
  const replay = []
  const unsubscribe = f.coordinator.subscribe(row => replay.push(row))
  assert.deepEqual(replay, [{ continuationStatus: first }], 'a newly opened view receives the retained blocker')
  unsubscribe()
  const delays = []
  for (let failure = 0; failure < 6; failure++) {
    const status = f.coordinator.continuationStatus()
    delays.push(status.nextAttemptAt - at)
    for (let tick = 1; tick < 6; tick++) await f.coordinator.pollContinuations()
    assert.equal(reads, failure + 1, 'repeated five-second poll triggers must not bypass the retry deadline')
    at = status.nextAttemptAt - 1
    await f.coordinator.pollContinuations()
    assert.equal(reads, failure + 1)
    at++
    await f.coordinator.pollContinuations()
    assert.equal(reads, failure + 2, 'a due retry still checks the real catalogue')
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000])
  assert.equal(f.coordinator.continuationStatus().blocked, true)
  answer = { ok: false, records: [] }
  at = f.coordinator.continuationStatus().nextAttemptAt
  await f.coordinator.pollContinuations()
  assert.equal(f.coordinator.continuationStatus().blocked, true, 'a resolved refusal is not a healthy read')
  answer = { enabled: true, records: [] }
  at = f.coordinator.continuationStatus().nextAttemptAt
  readGate = deferred()
  const retry = f.coordinator.pollContinuations()
  assert.equal(f.coordinator.continuationStatus().blocked, true, 'beginning a retry does not clear the unresolved failure')
  readGate.resolve()
  await retry
  readGate = null
  assert.equal(f.coordinator.continuationStatus(), null)
  assert.deepEqual(notices().at(-1), { continuationStatus: null })
  const afterClear = []
  f.coordinator.subscribe(row => afterClear.push(row))
  assert.deepEqual(afterClear, [], 'late subscribers do not receive an obsolete failure')
  answer = null
  await f.coordinator.pollContinuations()
  assert.equal(f.coordinator.continuationStatus().nextAttemptAt - at, 30000, 'a successful read resets the failure backoff')
  assert.deepEqual(f.treeStore.snapshot(), before, 'catalogue status never rewrites saved node status')
  assert.deepEqual(f.calls.start, [])
  assert.deepEqual(f.calls.send, [])
})

test('catalogue recovery uses the authentic readable record and existing attachment path', async t => {
  let at = 1000000, failing = true
  const f = fixture(t, { retryOptions: { now: () => at } })
  await settle()
  const c = savedContinuation(f, request => {
    if (request.action === 'read' && failing) throw new Error('The task ledger history cannot be verified.')
  })
  await f.coordinator.pollContinuations()
  assert.deepEqual(c.calls.map(row => row.action), ['read'])
  failing = false
  await f.coordinator.pollContinuations()
  assert.deepEqual(c.calls.map(row => row.action), ['read'], 'changing a local flag does not bypass the retry boundary')
  at = f.coordinator.continuationStatus().nextAttemptAt
  await f.coordinator.pollContinuations()
  assert.deepEqual(c.calls.map(row => row.action), ['read', 'read', 'resume', 'attached'])
  assert.equal(f.coordinator.continuationStatus(), null)
  assert.equal(f.sessionNodeIds.get('old-session'), f.node.id)
  assert.deepEqual(f.calls.start, [], 'history verification remains in the trusted continuation path')
})

for (const stale of ['destroyed', 'replaced context', 'nonlocal']) for (const outcome of ['rejected', 'readable']) {
  test(`late ${outcome} catalogue read cannot publish or start after ${stale}`, async t => {
    let local = true
    const f = fixture(t, { canContinue: () => local })
    await settle()
    const gate = deferred()
    const c = savedContinuation(f, async request => {
      assert.equal(request.action, 'read', 'an obsolete read cannot start or alter a saved continuation')
      await gate.promise
      if (outcome === 'rejected') throw new Error('The task ledger history cannot be verified.')
    })
    const pending = f.coordinator.pollContinuations()
    if (stale === 'destroyed') f.coordinator.destroy()
    else if (stale === 'replaced context') f.coordinator.register('local', {
      treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore,
    })
    else local = false
    await settle()
    const count = f.calls.notices.length
    gate.resolve()
    await pending
    assert.equal(f.calls.notices.length, count, 'an obsolete read must not label the current view blocked')
    assert.equal(f.coordinator.continuationStatus(), null)
    assert.deepEqual(c.calls.map(row => row.action), ['read'])
    assert.deepEqual(f.calls.start, [])
  })
}

test('a catalogue row whose session changes during transcript read cannot resume or publish for its predecessor', async t => {
  const f = fixture(t)
  await settle()
  const gate = deferred(), entered = deferred()
  const saved = f.transcriptStore.get(f.node.id)
  f.coordinator.register('local', { treeStore: f.treeStore, handoffStore: f.handoffStore,
    transcriptStore: { ...f.transcriptStore, readLatest: async () => { entered.resolve(); await gate.promise; return saved } } })
  await settle()
  const c = savedContinuation(f)
  const pending = f.coordinator.pollContinuations()
  await entered.promise
  f.treeStore.attachSession(f.node.id, 'current-replacement')
  const count = f.calls.notices.length
  gate.resolve()
  await pending
  assert.deepEqual(c.calls.map(row => row.action), ['read'], 'stale transcript completion cannot start the old session')
  assert.equal(f.calls.notices.length, count)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'current-replacement')
})

test('startup catalogue failure is shared by Home and Trees, survives reopen, and clears only after a current read', async t => {
  const { register } = await import('node:module')
  register('./helpers/css-stub-loader.mjs', import.meta.url)
  const { installWorld, fleetFetch, seedTreeNode, mountView, settle: settleView } = await import('./lib/tree-command-real-mount.mjs')
  let at = 2000000, failing = true, reads = 0, starts = 0, pendingRead = null
  t.mock.method(Date, 'now', () => at)
  const intervals = new Map(), nativeInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    const timer = nativeInterval(callback, ms, ...args)
    intervals.set(timer, { ms, tick: () => callback(...args) })
    return timer
  })
  t.mock.method(globalThis, 'clearInterval', timer => { intervals.delete(timer); nativeClearInterval(timer) })
  const nativeTimeout = globalThis.setTimeout
  let dismissPrimary = null
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = nativeTimeout(callback, ms, ...args)
    if (ms === 7000) dismissPrimary = () => { clearTimeout(timer); callback(...args) }
    return timer
  })
  let gate = fleetFetch()
  const world = await installWorld({ fetch: url => gate.fetch(url) }, { asyncFrames: true })
  let view, home
  const previousAgent = globalThis.mcAgent
  t.after(() => { home?.destroy(); view?.destroy(); globalThis.mcAgent = previousAgent; world.restore() })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.bridge.onEvent = () => () => {}
  world.bridge.start = async () => { starts++; return { ok: false } }
  world.bridge.history = async () => ({ ok: true, entries: [] })
  world.bridge.availability = async () => ({ ok: true, available: true })
  world.bridge.continuations = async request => {
    assert.equal(request.action, 'read')
    reads++
    if (pendingRead) await pendingRead.promise
    if (failing) throw new Error('The task ledger history cannot be verified.')
    return { enabled: true, records: [] }
  }
  globalThis.mcAgent = world.bridge
  const { initializeAutonomousContinuations, subscribeAutonomousContinuationStatus } = await import('../../src/views/computers.js')
  const { homeView } = await import('../../src/views/home.js')
  const { FLEET } = await import('../../src/fleet-profile.js')
  const computerId = FLEET.machines[0].id
  gate = fleetFetch({ computerId })
  seedTreeNode(world.storage, { computerId, nodeId: 'catalogue-node', sessionId: null, status: 'draft' })
  const { resolveDataSource } = await import('../../src/data-source.js')
  assert.equal(await resolveDataSource(), 'local', 'startup has resolved the local desktop transport')
  initializeAutonomousContinuations()
  await settleView(3)
  const statuses = []
  const detach = subscribeAutonomousContinuationStatus(status => statuses.push(status))
  t.after(detach)
  assert.equal(reads, 1, 'startup asks the coordinator before any view mounts')
  assert.equal(statuses.at(-1)?.blocked, true, 'startup failure must be retained before Home subscribes')
  assert.equal([...intervals.values()].filter(row => row.ms === 30000).length, 0, 'bootstrap does not keep an independent catalogue loop')
  const mountHome = async () => {
    home = homeView()
    document.body.append(home.el)
    await settleView(3)
    return home.el.querySelector('[data-home-continuation-status]')
  }
  let homeStatus = await mountHome()
  assert.match(homeStatus?.textContent || '', /recovery is blocked.*ledger history.*verified/i)
  const blocked = homeStatus.textContent
  home.destroy(); home = null

  view = await mountView(world, { computerId })
  let status = view.el.querySelector('.org-status')
  assert.equal(reads, 1)
  assert.equal(status.hidden, false)
  assert.equal(status.dataset.state, 'refuse')
  assert.equal(status.textContent, blocked)
  const edit = view.el.querySelector('.graph-edit-btn')
  assert.equal(edit.getAttribute('aria-disabled'), 'true', 'missing organisation bridge supplies an independent refusal')
  edit.click()
  assert.ok(status.textContent.includes(edit.title), 'catalogue warning preserves the existing action refusal')
  assert.ok(status.textContent.includes(blocked))
  assert.equal(typeof dismissPrimary, 'function')
  dismissPrimary()
  assert.equal(status.textContent, blocked, 'expiry of a transient message cannot dismiss the catalogue blocker')
  view.destroy(); view = null

  homeStatus = await mountHome()
  assert.equal(homeStatus.textContent, blocked)
  initializeAutonomousContinuations()
  assert.equal(reads, 1, 'Home reopen and duplicate initialization do not retry early')
  home.destroy(); home = null
  view = await mountView(world, { computerId })
  status = view.el.querySelector('.org-status')
  assert.equal(status.textContent, blocked)
  const nextEdit = view.el.querySelector('.graph-edit-btn')
  nextEdit.click()
  const independentError = nextEdit.title
  at += 30000
  for (const row of intervals.values()) if (row.ms === 5000) row.tick()
  await settleView(3)
  assert.equal(reads, 2)
  assert.equal(statuses.at(-1).nextAttemptAt - at, 60000, 'startup and Trees share the growing backoff')
  for (const offset of [30000, 59999]) {
    at = 2030000 + offset
    for (const row of intervals.values()) if (row.ms === 5000) row.tick()
    await settleView(1)
    assert.equal(reads, 2)
  }

  at = statuses.at(-1).nextAttemptAt
  failing = false
  pendingRead = deferred()
  for (const row of intervals.values()) if (row.ms === 5000) row.tick()
  await settleView(1)
  assert.equal(reads, 3)
  assert.equal(statuses.at(-1).blocked, true, 'starting a verified retry does not clear the blocker')
  homeStatus = await mountHome()
  assert.equal(homeStatus.textContent, blocked)
  const retiredHome = home.el
  home.destroy(); home = null
  const retiredText = retiredHome.textContent
  pendingRead.resolve()
  await settleView(3)
  pendingRead = null
  assert.equal(statuses.at(-1), null, 'only the authentic current read clears the shared blocker')
  assert.equal(status.textContent, independentError, 'read recovery clears only its own blocker')
  dismissPrimary()
  assert.equal(status.hidden, true)
  view.destroy(); view = null
  assert.equal(retiredHome.textContent, retiredText, 'a disposed Home view cannot publish a late read')
  assert.equal(await mountHome(), null, 'subscriber replay cannot resurrect cleared startup status')
  home.destroy(); home = null
  view = await mountView(world, { computerId })
  status = view.el.querySelector('.org-status')
  assert.doesNotMatch(status.textContent, /recovery is blocked/i)
  assert.equal(starts, 0)
})









test('manual successor reaches the complete native saved conversation beyond its viewport', async t => {
  const f = fixture(t)
  const root = await fs.mkdtemp(path.join(process.env.IMAGE_TEST_TEMP || os.tmpdir(), 't839-full-history-'))
  t.diagnostic('Retained synthetic transcript: ' + root)
  let archived = 0
  const io = { ...fs, async unlink(file) {
    // This fixture preserves absence semantics without deleting existing bytes.
    await fs.lstat(file)
    assert.ok(path.resolve(file).startsWith(root + path.sep))
    await fs.rename(file, path.join(root, 'retained-' + (++archived)))
  } }
  const native = createNodeTranscriptStore({ directory: root, io })
  const earliest = 'Synthetic earlier decision. ' + 'retained-context '.repeat(5000)
  await native.append({ computerId: 'local', nodeId: f.node.id,
    entries: Array.from({ length: 75 }, (_, n) => ({ id: 'history-' + n, who: n % 2 ? 'agent' : 'you',
      text: n === 0 ? earliest : 'Synthetic saved turn ' + n, at: n + 1 })),
    metadata: { provider: 'claude', account: 'old-account', threadId: 'old-thread' } })
  const client = createNodeTranscriptClient({ computerId: 'local', bridge: native })
  t.after(() => client.dispose())
  await client.ready
  const viewport = await client.readLatest(f.node.id)
  assert.equal(viewport.lines.length, 60)
  assert.ok(viewport.before)
  assert.ok(viewport.lines.every(row => row.text !== earliest))
  Object.assign(f.transcriptStore, client)
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'new-account' } }), true)
  const directory = viewport.recoveryDirectory
  assert.equal(directory, viewport.recoveryDirectory)
  assert.ok(f.calls.send[0].text.includes(directory))
  const names = (await fs.readdir(directory)).filter(name => /^\d{16}-[a-f0-9]{64}\.json$/.test(name)).sort()
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, names[0]), 'utf8')).text, earliest)
  const reopened = createNodeTranscriptStore({ directory: root, io })
  const complete = await reopened.read({ computerId: 'local', nodeId: f.node.id, limit: 100 })
  assert.ok(complete.entries.some(row => row.text === earliest), 'the successor can reopen actual complete native history')
  assert.equal(archived, 0, 'this append-only fixture requires no removal')
})





/* THE STOP FENCE HAS TO RECOGNISE A STOP, WHOEVER PRESSED IT.
 *
 * The person's Stop and a manager's agent.stop end a circle the same way and
 * write different notes on purpose (attribution). The fence read one of the
 * two sentences, so a circle its manager stopped was resumed by the very next
 * Autonomous+ sweep. Both notes are asserted here, in one pair, so the control
 * and the case can never drift apart. src/stop-node-session.js holds the
 * sentences; MANAGER_STOP_NOTE is the exact string the stop-node branch of
 * src/views/computers.js writes.
 */
test('a saved continuation is discarded for a stopped circle whether the person or its manager stopped it', async t => {
  for (const note of [PERSON_STOP_NOTE, MANAGER_STOP_NOTE]) {
    await t.test(note, async inner => {
      const f = fixture(inner)
      const c = savedContinuation(f)
      assert.equal(f.treeStore.setNodeStatus(f.node.id, 'finished', { note }).ok, true)
      await f.coordinator.pollContinuations()
      assert.deepEqual(c.calls.map(row => row.action), ['read', 'stop'], `a circle noted "${note}" is not resumed`)
      assert.equal(f.calls.notices.some(row => row.started), false)
      // The fence keeps the circle's own attribution rather than restamping
      // every stop as the person's.
      assert.equal(f.treeStore.getNode(f.node.id).statusNote, note)
      assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
    })
  }
})



for(const code of ['misalignment_policy_violation','misalignmentPolicyViolation'])test(`off-page old queue stays held after explicit successful turn: ${code}`, async t=>{
 const queue=[{text:'Synthetic old queued input',id:'synthetic-old'}]
 const outbox={takeNext:()=>queue.shift(),confirmDelivered(){},requeueFront:(_id,row)=>queue.unshift(row)}
 const f=fixture(t,{retryOptions:{outbox}})
 f.emit({sessionId:'old-session',event:{type:'turn_completed',status:'failed',code,failureReason:'safety-policy',retryable:false,turnId:'blocked-synthetic'}})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.calls.send.length,0);assert.equal(queue.length,1)
 await f.bridge.send({sessionId:'old-session',text:'Synthetic explicit new person input'})
 f.emit({sessionId:'old-session',event:{type:'turn_started',turnId:'explicit-synthetic'}})
 f.emit({sessionId:'old-session',event:{type:'turn_completed',status:'completed',turnId:'explicit-synthetic'}})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(f.calls.send.length,1,'only the explicit new input may be sent; old work stays held')
 assert.equal(queue.length,1)
})

function offPageQueue(t, options = {}) {
  const rows = [{ id: 'queued-synthetic', text: 'Synthetic queued input' }]
  const delivered = []
  const outbox = { takeNext() {
    options.beforeTake?.()
    const index = rows.findIndex(row => row.deliveryUnconfirmed !== true)
    if (index < 0) return null
    const [entry] = rows.splice(index, 1)
    options.onTake?.()
    return entry
  }, confirmDelivered: (_session, entry) => delivered.push(entry), requeueFront: (_session, entry) => rows.unshift(entry) }
  const f = fixture(t, { ...options, retryOptions: { outbox } })
  const complete = (turnId = 'synthetic-complete', sessionId = 'old-session') => f.emit({ sessionId,
    event: { type: 'turn_completed', status: 'completed', turnId } })
  return { ...f, rows, delivered, complete }
}
const offPageSettle = () => new Promise(resolve => setImmediate(resolve))

test('off-page safety custody retains payload-classified work across navigation and explicit success', async t => {
  const f = offPageQueue(t)
  const leave = f.coordinator.subscribe(() => {}, { observes: () => true })
  f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'completed', turnId: 'synthetic-block',
    payload: { failure: { category: 'safety-policy' } } } })
  leave()
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  await f.bridge.send({ sessionId: 'old-session', text: 'Synthetic explicit new input' })
  f.complete(); await offPageSettle()
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.sendAutomatic.length, 0)
  assert.equal(f.rows.length, 1); assert.equal(f.delivered.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
})

test('off-page safety custody ordinary success uses tracked automatic dispatch and preserves turn receipt', async t => {
  const f = offPageQueue(t, { sendAutomatic: async () => ({ ok: true, deliveryDisposition: 'accepted', result: { ok: true, turnId: 'synthetic-next' } }) })
  f.complete(); await offPageSettle()
  assert.equal(f.calls.sendAutomatic.length, 1); assert.equal(f.rows.length, 0); assert.equal(f.delivered.length, 1)
  assert.equal(f.calls.sendAutomatic[0].text, 'Synthetic queued input')
  assert.equal(f.transcriptStore.get(f.node.id).lines.at(-1).turnStamp, 'synthetic-next')
})

test('off-page safety custody foreign refusal cannot hold this session', async t => {
  const f = offPageQueue(t)
  f.emit({ sessionId: 'unowned-session', event: { type: 'turn_completed', code: 'misalignmentPolicyViolation', status: 'failed' } })
  f.complete(); await offPageSettle()
  assert.equal(f.calls.sendAutomatic.length, 1); assert.equal(f.delivered.length, 1)
})

test('off-page safety custody missing automatic bridge retains input and names refusal', async t => {
  const f = offPageQueue(t); delete f.bridge.sendAutomatic
  f.complete(); await offPageSettle()
  assert.equal(f.calls.send.length, 0); assert.equal(f.rows.length, 1)
  assert.ok(f.calls.notices.some(row => row.code === 'AGENT_AUTOMATIC_SEND_UNAVAILABLE'))
})

test('off-page safety custody refusal while taking entry stops dispatch and retains input', async t => {
  let f
  f = offPageQueue(t, { onTake: () => f.emit({ sessionId: 'old-session', event: {
    type: 'turn_completed', status: 'failed', code: 'misalignment_policy_violation', turnId: 'synthetic-late-block' } }) })
  f.complete(); await offPageSettle()
  assert.equal(f.calls.send.length, 0); assert.equal(f.rows.length, 1); assert.equal(f.delivered.length, 0)
})

test('off-page safety custody tracked host refusal during admission stays held after later success', async t => {
  const gate = deferred()
  const f = offPageQueue(t, { sendAutomatic: () => gate.promise })
  f.complete(); await offPageSettle(); assert.equal(f.calls.sendAutomatic.length, 1)
  gate.resolve({ ok: false, code: 'PROVIDER_SAFETY_REFUSAL', deliveryDisposition: 'not-sent' })
  await offPageSettle(); assert.equal(f.rows.length, 1); assert.equal(f.delivered.length, 0)
  f.complete('synthetic-later'); await offPageSettle()
  assert.equal(f.calls.sendAutomatic.length, 1); assert.equal(f.rows[0].text, 'Synthetic queued input')
})

for (const reply of [null, { ok: false, deliveryDisposition: 'unknown' },
  { ok: false, deliveryDisposition: 'accepted' },
  { ok: true, deliveryDisposition: 'accepted', result: { ok: false } }]) {
  test('off-page safety custody uncertain receipt retains input without replay: '+JSON.stringify(reply), async t => {
    const f = offPageQueue(t, { sendAutomatic: async () => reply })
    f.complete(); await offPageSettle()
    assert.equal(f.rows.length, 1); assert.equal(f.rows[0].deliveryUnconfirmed, true); assert.equal(f.delivered.length, 0)
    f.complete('synthetic-later'); await offPageSettle(); assert.equal(f.calls.sendAutomatic.length, 1)
  })
}

test('off-page safety custody proven ordinary non-delivery remains retryable', async t => {
  let attempt = 0
  const f = offPageQueue(t, { sendAutomatic: async () => ++attempt === 1
    ? { ok: false, code: 'AGENT_BUSY', deliveryDisposition: 'not-sent' }
    : { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } })
  f.complete(); await offPageSettle(); assert.equal(f.rows.length, 1); assert.notEqual(f.rows[0].deliveryUnconfirmed, true)
  f.complete('synthetic-later'); await offPageSettle(); assert.equal(f.delivered.length, 1); assert.equal(attempt, 2)
})

test('off-page safety custody held input is not checked out on later completion', async t => {
  let taken = 0
  const f = offPageQueue(t, { beforeTake: () => { taken++ } })
  f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', code: 'misalignmentPolicyViolation', turnId: 'synthetic-blocked' } })
  f.complete(); await offPageSettle()
  assert.equal(taken, 0); assert.equal(f.rows.length, 1)
})

test('off-page safety custody lost transport reply is visibly retained without automatic replay', async t => {
  const f = offPageQueue(t, { sendAutomatic: async () => { throw new Error('Synthetic transport unavailable') } })
  f.complete(); await offPageSettle()
  assert.equal(f.rows[0].deliveryUnconfirmed, true); assert.equal(f.delivered.length, 0)
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /could not be confirmed/)
  f.complete('synthetic-later'); await offPageSettle(); assert.equal(f.calls.sendAutomatic.length, 1)
})

// T2084 uses the actual adapter shape: failure belongs in payload, with no
// top-level code. Every transport below is the in-memory fixture above.
const syntheticSafetyPacket = (code = 'misalignmentPolicyViolation', extra = {}) => ({
  sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', turnId: 'synthetic-safety-turn',
    payload: { failure: { provider: 'codex', source: 'turn', code, category: 'safety-policy', retryable: false,
      summary: 'Synthetic provider safety refusal.' } }, ...extra },
})
















// Independent review found that the no-policy ticket path retired its only
// safety record after close. Keep this separate from the persisted-policy case.





test('usage limits, failures and old automatic recovery offers never start or close another account', async t => {
  for (const savedMode of ['priority', 'rotate', 'most-remaining', 'least-remaining', 'dynamic', { futurePolicy: true }]) {
    const f = fixture(t, { retryOptions: { keepTryingOnLimit: () => true, readAccounts: async () => ({ accounts: [
      { name: 'old-account', provider: 'claude' }, { name: 'new-account', provider: 'codex' } ] }) } })
    f.handoffStorage.write('mc.agent-recovery.v1:local:' + encodeURIComponent(f.node.id), { v: 1, handoff: 'Synthetic saved handoff',
      sessionId: 'old-session', retryPolicy: { enabled: true, state: 'working', selectionMode: savedMode, excludeAccounts: ['old-account'] } })
    f.emit(f.packet)
    f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', failureReason: 'account-limit', turnId: 'synthetic-limit' } })
    await new Promise(resolve => setImmediate(resolve))
    f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', code: 'ECONNRESET', turnId: 'synthetic-failure' } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.start.length, 0)
    assert.equal(f.calls.close.length, 0)
    assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
    assert.match(f.treeStore.getNode(f.node.id).statusNote, /Wait for this account to reset.*Switch and continue/i)
    assert.equal(f.coordinator.externalBlock(f.node.id)?.blocked, true)
  }
})

test('manual account continuation names a missing choice and uses exactly the person’s chosen account', async t => {
  const f = fixture(t)
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id }), false)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.notices.at(-1).code, 'AGENT_ACCOUNT_CHOICE_REQUIRED')
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'chosen-account' } }), true)
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].treeAccount, 'chosen-account')
})

test('an old saved retry policy opens without acting and is dropped on the next manual checkpoint save', async t => {
  const f = fixture(t)
  f.handoffStorage.write('mc.agent-recovery.v1:local:' + encodeURIComponent(f.node.id), { v: 1, handoff: 'Synthetic old progress',
    sessionId: 'old-session', retryPolicy: { enabled: true, state: 'waiting', providers: ['claude', 'codex'] }, futurePolicy: { enabled: true } })
  assert.deepEqual(f.handoffStore.get(f.node.id), { v: 1, handoff: 'Synthetic old progress', sessionId: 'old-session' })
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'chosen-account' } }), true)
  const saved = f.handoffStorage.read('mc.agent-recovery.v1:local:' + encodeURIComponent(f.node.id))
  assert.deepEqual(Object.keys(saved).sort(), ['handoff', 'kind', 'recoveryId', 'sessionId', 'v'])
  assert.ok(f.calls.send[0].text.includes('Synthetic old progress'))
})

test('a safety hold saved inside an old policy survives reload without reviving the policy', async t => {
  const f = offPageQueue(t)
  f.handoffStorage.write('mc.agent-recovery.v1:local:' + encodeURIComponent(f.node.id), { v: 1, handoff: 'Synthetic retained context',
    sessionId: 'old-session', retryPolicy: { enabled: true, safetyHold: { nodeId: f.node.id, sessionId: 'old-session' } } })
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  f.complete(); await offPageSettle()
  assert.equal(f.calls.sendAutomatic.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.rows.length, 1)
  assert.deepEqual(f.handoffStore.get(f.node.id).safetyHold, { nodeId: f.node.id, sessionId: 'old-session' })
})


test('an explicit reset wait resumes only the saved account and native thread at the chosen time', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock }, start: args => ({ ok: true, sessionId: 'new-session', account: args.resumeAccount, threadId: args.resumeThreadId, resumed: true }) })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].treeAccount, 'old-account')
  assert.equal(f.calls.start[0].resumeAccount, 'old-account')
  assert.equal(f.calls.start[0].resumeThreadId, 'old-thread')
  assert.equal(f.calls.start[0].resumeThreadProvider, 'claude')
  /* The request must pass the real start parser: every key is one parseAgentStart (shell/main.cjs) accepts.
     The reset wait once sent resumeThreadAccount, which the parser refuses, after the wait was spent. */
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const allowed = main.match(/function parseAgentStart[\s\S]*?agentPayload\(value, \[([^\]]+)\]/)[1].match(/'([A-Za-z]+)'/g).map(k => k.slice(1, -1))
  for (const key of Object.keys(f.calls.start[0])) assert.ok(allowed.includes(key), `${key} is not accepted by parseAgentStart`)
  assert.equal(f.calls.start[0].tier, 'claude-sonnet')
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 1)
})

test('Stop cancels an explicit reset wait and preserves the saved account', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock } })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  await f.coordinator.stopContinuation(f.node.id)
  f.treeStore.setNodeStatus(f.node.id, 'finished', { note: PERSON_STOP_NOTE })
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.handoffStore.get(f.node.id).limitWait, null)
  assert.equal(f.transcriptStore.get(f.node.id).account, 'old-account')
})

test('a reset wait cannot bypass a safety refusal or follow a changed account', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock } })
  f.emit(syntheticSafetyPacket())
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), false)
  assert.equal(f.calls.start.length, 0)
  const changed = fixture(t, { retryOptions: { now: () => clock } })
  assert.equal(await changed.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: changed.node.id, resetAt: 2000 }), true)
  changed.transcriptStore.save(changed.node.id, { ...changed.transcriptStore.get(changed.node.id), account: 'different-account' })
  clock = 2000
  await changed.coordinator.pollLimitWaits()
  assert.equal(changed.calls.start.length, 0)
  assert.match(changed.calls.notices.at(-1).error, /cancelled/)
})

test('a reset continuation with a different receipt identity is closed and receives no handoff', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock }, start: () => ({ ok: true, sessionId: 'new-session', account: 'old-account', threadId: 'other-thread', resumed: true }) })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.sendAutomatic.length, 0)
  assert.ok(f.calls.close.some(row => row.sessionId === 'new-session'))
})


test('an explicitly saved reset wait survives renderer reload without choosing another account', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock }, start: args => ({ ok: true, sessionId: 'new-session', account: args.resumeAccount, threadId: args.resumeThreadId, resumed: true }) })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  f.coordinator.destroy()
  const sessions = new Map()
  const reopened = createAccountRecoveryCoordinator({ bridge: f.bridge, sessionNodeIds: sessions, orgBridge: f.orgBridge,
    canStart: () => true, canContinue: () => true, tiers: LAUNCH_TIERS, now: () => clock })
  t.after(() => reopened.destroy())
  reopened.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  await new Promise(resolve => setImmediate(resolve))
  await reopened.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
  clock = 2000
  await reopened.pollLimitWaits()
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].resumeAccount, 'old-account')
  assert.equal(f.calls.start[0].resumeThreadId, 'old-thread')
})

test('a reset wait cannot interrupt a newer running turn or bypass a permission hold', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock } })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  f.treeStore.setNodeStatus(f.node.id, 'running')
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.close.length, 0)
  const held = fixture(t, { retryOptions: { now: () => 1000 } })
  held.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', code: 'AGENT_PERMISSION_DENIED', failureReason: 'account-limit' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await held.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: held.node.id, resetAt: 2000 }), false)
  assert.equal(held.handoffStore.get(held.node.id).safetyHold.sessionId, 'old-session')
})

test('a reset wait cancelled during its durable save is discarded before reload', async t => {
  let clock = 1000, current = true
  const f = fixture(t, { retryOptions: { now: () => clock } })
  const save = f.handoffStore.save.bind(f.handoffStore)
  f.handoffStore.save = (id, record) => {
    const result = save(id, record)
    if (record.limitWait) current = false
    return result
  }
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000, isCurrent: () => current }), false)
  assert.equal(f.handoffStore.get(f.node.id).limitWait, null)
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  await new Promise(resolve => setImmediate(resolve))
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
})

test('a pending saved reset-wait read cannot restore the wait after Stop', async t => {
  let clock = 1000
  const f = fixture(t, { retryOptions: { now: () => clock } })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), true)
  const old = f.handoffStore.get(f.node.id), held = deferred()
  const store = { ...f.handoffStore, readRecord: () => held.promise }
  f.coordinator.register('local', { treeStore: f.treeStore, transcriptStore: f.transcriptStore, handoffStore: store })
  await new Promise(resolve => setImmediate(resolve))
  const stopping = f.coordinator.stopContinuation(f.node.id)
  held.resolve(old)
  await stopping
  await new Promise(resolve => setImmediate(resolve))
  clock = 2000
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
})

test('a reset wait refuses a failed tree status save without leaving a saved wait', async t => {
  const f = fixture(t, { retryOptions: { now: () => 1000 } })
  await new Promise(resolve => setImmediate(resolve))
  f.coordinator.register('local', { treeStore: { ...f.treeStore, setNodeStatus: () => ({ ok: false, reason: 'Synthetic tree save refusal' }) }, transcriptStore: f.transcriptStore, handoffStore: f.handoffStore })
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), false)
  assert.equal(f.handoffStore.get(f.node.id).limitWait, null)
  await f.coordinator.pollLimitWaits()
  assert.equal(f.calls.start.length, 0)
})

test('account and model continuation preserve provider safety and permission holds', async t => {
  for (const packet of [syntheticSafetyPacket(), { sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', code: 'AGENT_PERMISSION_DENIED' } }]) {
    const f = fixture(t)
    f.emit(packet)
    assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'picked-account' } }), false)
    assert.equal(await f.coordinator.continueOnAnotherModel({ computerId: 'local', nodeId: f.node.id, startOptions: { tier: 'luna', treeAccount: 'picked-account' } }), false)
    assert.equal(f.calls.start.length, 0)
    assert.equal(f.calls.close.length, 0)
    assert.equal(f.calls.send.length, 0)
    assert.match(f.calls.notices.at(-1).error, /held for review/)
  }
})

test('a model choice keeps its current account and changing provider requires a picked account', async t => {
  const f = fixture(t)
  assert.equal(await f.coordinator.continueOnAnotherModel({ computerId: 'local', nodeId: f.node.id, startOptions: { tier: 'luna' } }), false)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.notices.at(-1).code, 'AGENT_ACCOUNT_CHOICE_REQUIRED')
  assert.equal(await f.coordinator.continueOnAnotherModel({ computerId: 'local', nodeId: f.node.id, startOptions: { tier: 'claude-opus' } }), true)
  assert.equal(f.calls.start[0].treeAccount, 'old-account')
})

test('unreadable live safety state keeps manual continuation and reset waits from starting', async t => {
  const f = fixture(t, { sessionActivity: async () => ({ ok: false }), retryOptions: { now: () => 1000 } })
  assert.equal(await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'picked-account' } }), false)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.close.length, 0)
  assert.match(f.calls.notices.at(-1).error, /safety state could not be read/)
  assert.equal(await f.coordinator.waitForSameAccountReset({ computerId: 'local', nodeId: f.node.id, resetAt: 2000 }), false)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.close.length, 0)
})

test('a manual account or model continuation closes a different account receipt before sending context', async t => {
  for (const kind of ['account', 'model']) {
    const f = fixture(t, { start: () => ({ ok: true, sessionId: 'wrong-session', threadId: 'wrong-thread', account: 'unpicked-account' }) })
    const request = { computerId: 'local', nodeId: f.node.id, startOptions: { treeAccount: 'picked-account', tier: 'luna' } }
    const continued = kind === 'account' ? await f.coordinator.continueOnAnotherAccount(request) : await f.coordinator.continueOnAnotherModel(request)
    assert.equal(continued, false)
    assert.equal(f.calls.send.length, 0)
    assert.ok(f.calls.close.some(row => row.sessionId === 'wrong-session'))
    assert.match(f.calls.notices.at(-1).error, /account you chose/)
  }
})
