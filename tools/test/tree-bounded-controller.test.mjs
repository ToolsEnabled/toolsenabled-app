import assert from 'node:assert/strict'
import test from 'node:test'
import { createTreeWorkController, verifiedTreeWork, verifiedTreeWorkStatus } from '../../src/tree-bounded-work.js'

const hash = 'a'.repeat(64)
const plan = { computerId: 'computer', treeId: 'saved-tree', parentNodeId: 'manager', parentSessionId: 'parent-session', tier: 'astra', capMs: 60_000, brief: 'Owner brief', members: ['astra'], iterations: 3, intervalMs: 60_000 }
function accepted(request, index = 1) {
  const sessionId = `session-${index}`, nodeId = `node-${index}`
  return { ok: true, sessionId, nodeId, record: { sequence: index, eventHash: hash }, boundedWork: {
    action: 'tree.dispatch', computerId: request.computerId, treeId: request.treeId,
    parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
    sessionId, nodeId, agentId: nodeId, capMs: request.capMs, startedAt: 1000, deadlineAt: 1000 + request.capMs,
  } }
}
function fixture(kind = 'launch', overrides = {}) {
  const starts = [], closes = [], statuses = new Map(), timers = []
  const controller = createTreeWorkController({ kind,
    start: async request => { starts.push(request); const result = accepted(request, starts.length); statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record }); return result },
    readStatus: async sid => statuses.get(sid),
    close: async sid => { closes.push(sid); statuses.set(sid, { ...statuses.get(sid), state: 'closed', endRecord: { sequence: 100, eventHash: hash } }); return { ok: true } },
    isBusy: () => false,
    setTimer: callback => { const record = { callback, cancelled: false }; timers.push(record); return record },
    clearTimer: record => { record.cancelled = true },
    ...overrides,
  })
  const tick = async () => { const timer = timers.find(record => !record.cancelled && !record.ran); assert.ok(timer); timer.ran = true; await timer.callback(); for (let i = 0; i < 10; i++) await Promise.resolve() }
  return { controller, starts, closes, statuses, timers, tick }
}

test('native receipts bind the selected parent, saved tree, child identity, cap and signed record', () => {
  const result = accepted(plan)
  assert.equal(verifiedTreeWork(result, plan), true)
  for (const key of ['parentNodeId', 'parentSessionId', 'computerId', 'treeId']) assert.equal(verifiedTreeWork({ ...result, boundedWork: { ...result.boundedWork, [key]: 'wrong' } }, plan), false, key)
  assert.equal(verifiedTreeWork({ ...result, boundedWork: { ...result.boundedWork, agentId: 'astra' } }, plan), false, 'lane identities are not child identities')
  assert.equal(verifiedTreeWork({ ...result, record: { sequence: 1, eventHash: 'unsigned' } }, plan), false)
  assert.equal(verifiedTreeWork({ ...result, boundedWork: { ...result.boundedWork, capMs: plan.capMs + 1 } }, plan), false)
  assert.equal(verifiedTreeWork({ ...result, boundedWork: { ...result.boundedWork, capMs: 5000, deadlineAt: 6000 } }, plan), true, 'a bounded parent may shorten its child cap')
})

test('closing requires the exact retained scope and a signed end record', () => {
  const result = accepted(plan)
  const status = { ok: true, ...result.boundedWork, state: 'closed', record: result.record, endRecord: { sequence: 3, eventHash: hash } }
  assert.equal(verifiedTreeWorkStatus(status, result.boundedWork, { closed: true }), true)
  assert.equal(verifiedTreeWorkStatus({ ...status, endRecord: null }, result.boundedWork, { closed: true }), false)
  assert.equal(verifiedTreeWorkStatus({ ...status, sessionId: 'replacement' }, result.boundedWork, { closed: true }), false)
})

test('one Launch press retains its real child and repeated presses cannot duplicate it', async () => {
  const f = fixture()
  await f.controller.run(plan)
  await f.controller.run(plan)
  assert.equal(f.starts.length, 1)
  assert.equal(f.controller.getState().rows[0].sessionId, 'session-1')
  await f.controller.stop()
  assert.deepEqual(f.closes, ['session-1'])
  assert.equal(f.controller.getState().phase, 'stopped')
})

test('team members report to the actual saved lead even when they use the same provider tier', async () => {
  const f = fixture('team')
  await f.controller.run({ ...plan, members: ['astra', 'astra'] })
  assert.equal(f.starts.length, 3)
  assert.equal(f.starts[0].parentNodeId, 'manager')
  for (const member of f.starts.slice(1)) {
    assert.equal(member.parentNodeId, 'node-1')
    assert.equal(member.parentSessionId, 'session-1')
    assert.equal(member.brief, plan.brief)
  }
  await f.controller.stop()
  assert.deepEqual(f.closes, ['session-3', 'session-2', 'session-1'])
})

test('a refused member remains visible after the host closes the already-started lead', async () => {
  let ended, unsubscriptions = 0
  const refusal = 'The member admission was refused. Its saved circle was not started.'
  const f = fixture('team', {
    subscribeEnded: listener => { ended = listener; return () => { unsubscriptions++ } },
    start: async request => {
      f.starts.push(request)
      if (f.starts.length === 2) return { ok: false, nodeId: 'node-2', sessionId: null, message: refusal }
      const result = accepted(request, f.starts.length)
      f.statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record })
      return result
    },
  })
  await f.controller.run({ ...plan, members: ['astra', 'astra'] })
  assert.deepEqual(f.starts.map(request => request.label), ['Lead', 'Member 1'], 'The refusal must prevent a third start')
  const before = f.controller.getState()
  assert.equal(before.phase, 'refused')
  assert.equal(before.message, refusal)
  assert.equal(before.stoppable, true, 'The live Lead must remain reachable by Stop')
  assert.deepEqual(before.rows.map(row => row.sessionId), ['session-1'])

  f.statuses.set('session-1', { ...f.statuses.get('session-1'), state: 'closed', reason: 'cap-reached', endRecord: { sequence: 45, eventHash: hash } })
  ended('session-1')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const after = f.controller.getState()
  assert.equal(after.rows.length, 1)
  assert.equal(after.rows[0].phase, 'closed')
  assert.deepEqual({ ...after.rows[0], phase: before.rows[0].phase, detail: before.rows[0].detail }, before.rows[0],
    'Passive cleanup must retain the exact Lead receipt and identity')
  assert.equal(after.phase, 'refused', 'Closing started work does not complete the refused Team')
  assert.equal(after.message, refusal, 'The member failure must survive the later closing notification')
  assert.equal(after.busy, false)
  assert.equal(after.stoppable, false, 'Signed closure must retire Stop without erasing the refusal')
  assert.equal(unsubscriptions, 1)
  assert.deepEqual(f.closes, [], 'The notification must not initiate another close')
  assert.equal(f.starts.length, 2, 'No replacement or retry is automatic')
  let remounted
  const detach = f.controller.subscribe(state => { remounted = state })
  assert.equal(remounted.message, refusal, 'A remounted panel must recover the same failure')
  detach()

  await f.controller.run(plan)
  assert.equal(f.starts.length, 4, 'The person can explicitly start a new Team after cleanup')
  assert.equal(f.controller.getState().phase, 'active')
  assert.notEqual(f.controller.getState().message, refusal)
  await f.controller.stop()
  assert.deepEqual(f.closes, ['session-4', 'session-3'])
  assert.equal(f.controller.getState().phase, 'stopped')
})

test('a fully started Team completes only after every exact retained session has signed closure', async () => {
  let ended
  const f = fixture('team', { subscribeEnded: listener => { ended = listener; return () => {} } })
  await f.controller.run(plan)
  const sessions = f.controller.getState().rows.map(row => row.sessionId)
  f.statuses.set('session-1', { ...f.statuses.get('session-1'), state: 'closed', endRecord: { sequence: 45, eventHash: hash } })
  ended('session-1')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(f.controller.getState().phase, 'active')
  assert.equal(f.controller.getState().stoppable, true)
  f.statuses.set('session-2', { ...f.statuses.get('session-2'), state: 'closed', endRecord: null })
  ended('session-2')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(f.controller.getState().phase, 'active', 'An unsigned closed label cannot finish the Team')
  f.statuses.set('session-2', { ...f.statuses.get('session-2'), endRecord: { sequence: 46, eventHash: hash } })
  ended('session-2')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const finished = f.controller.getState()
  assert.equal(finished.phase, 'completed')
  assert.equal(finished.busy, false)
  assert.equal(finished.stoppable, false)
  assert.deepEqual(finished.rows.map(row => row.sessionId), sessions)
  assert(finished.rows.every(row => row.phase === 'closed'))
  assert.deepEqual(f.closes, [])
})

test('parent shutdown cannot erase a refused Team before its retained Lead finishes cleanup', async () => {
  let ended
  const refusal = 'Member 1 was refused because its saved role is unavailable.'
  const f = fixture('team', {
    subscribeEnded: listener => { ended = listener; return () => {} },
    start: async request => {
      f.starts.push(request)
      if (f.starts.length === 2) return { ok: false, message: refusal }
      const result = accepted(request, f.starts.length)
      f.statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record })
      return result
    },
  })
  await f.controller.run({ ...plan, members: ['astra', 'astra'] })
  ended(plan.parentSessionId)
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const during = f.controller.getState()
  assert.equal(during.stoppable, true, 'Parent termination alone is not proof its Lead closed')

  f.statuses.set('session-1', { ...f.statuses.get('session-1'), state: 'closed', endRecord: { sequence: 45, eventHash: hash } })
  ended('session-1')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  const after = f.controller.getState()
  assert.deepEqual([during.phase, after.phase], ['refused', 'refused'], 'Parent and Lead cleanup must retain the refused Team outcome')
  assert.equal(during.message, refusal)
  assert.equal(after.message, refusal)
  assert.equal(after.stoppable, false)
  assert.equal(after.rows[0].phase, 'closed')
  assert.equal(f.starts.length, 2, 'Neither shutdown event may retry the refused member')
  assert.deepEqual(f.closes, [], 'Passive shutdown observations do not initiate another close')
})

test('a missing start receipt retains Stop and halts further team starts', async () => {
  let count = 0
  const f = fixture('team', { start: async request => { count++; return { ...accepted(request), record: null } } })
  await f.controller.run(plan)
  assert.equal(count, 1)
  assert.equal(f.controller.getState().rows[0].phase, 'unconfirmed')
  assert.equal(f.controller.getState().stoppable, true)
  assert.equal(f.controller.getState().phase, 'refused')
})

test('Stop during a pending start waits for its actual session and does not start a team member', async () => {
  let release, count = 0
  const result = accepted(plan)
  const f = fixture('team', { start: request => { count++; return new Promise(resolve => { release = () => resolve(result) }) } })
  const running = f.controller.run(plan)
  f.statuses.set(result.sessionId, { ok: true, ...result.boundedWork, record: result.record, state: 'ready' })
  const stopping = f.controller.stop()
  assert.equal(f.closes.length, 0)
  release()
  await Promise.all([running, stopping])
  assert.equal(count, 1)
  assert.deepEqual(f.closes, ['session-1'])
  assert.equal(f.controller.getState().phase, 'stopped')
})

test('a late close failure preserves the Stop control without pretending the child ended', async () => {
  const f = fixture('launch', { close: async () => { throw new Error('Cleanup is still pending.') } })
  await f.controller.run(plan)
  await f.controller.stop()
  assert.equal(f.controller.getState().phase, 'close-unconfirmed')
  assert.equal(f.controller.getState().stoppable, true)
  assert.match(f.controller.getState().rows[0].detail, /not confirmed/)
})

test('a loop closes its idle prior session before starting the next child under the original selected parent', async () => {
  const f = fixture('loop')
  await f.controller.run(plan)
  await f.tick()
  assert.equal(f.starts.length, 2)
  assert.deepEqual(f.closes, ['session-1'])
  assert.equal(f.starts[1].parentNodeId, 'manager')
  assert.equal(f.starts[1].parentSessionId, 'parent-session')
})

test('a loop skips a still-active turn and never overlaps a new child', async () => {
  let busy = true
  const f = fixture('loop', { isBusy: () => busy })
  await f.controller.run(plan)
  await f.tick()
  assert.equal(f.starts.length, 1)
  assert.equal(f.closes.length, 0)
  // A skip is not a run. Before the T48 correction (fc8a445b, "Count started
  // loop runs without spending the bound on busy skips") the skipped interval
  // consumed one of the selected iterations, so selecting three runs could
  // start two. This assertion used to read `attempts, 2`, pinning that
  // defect; the cut-1 tap recorded it as "expected 2 actual 1". The count
  // stays at the runs that really started, and the schedule keeps waiting.
  assert.equal(f.controller.getState().attempts, 1)
  assert.match(f.controller.getState().message, /skipped/)
  assert.equal(f.timers.filter(timer => !timer.ran && !timer.cancelled).length, 1)
  // Once the child is idle the next interval starts run 2 under the same
  // selected parent, and the skipped interval never counted against it.
  busy = false
  await f.tick()
  assert.equal(f.starts.length, 2)
  assert.deepEqual(f.closes, ['session-1'])
  assert.equal(f.controller.getState().attempts, 2)
  assert.equal(f.controller.getState().phase, 'running')
})

test('an unverifiable loop close stops further automatic starts', async () => {
  const f = fixture('loop', { close: async () => ({ ok: true }) })
  await f.controller.run(plan)
  await f.tick()
  assert.equal(f.starts.length, 1)
  assert.equal(f.controller.getState().phase, 'close-unconfirmed')
  assert.equal(f.timers.filter(timer => !timer.ran && !timer.cancelled).length, 0)
})

test('detaching a Page 2 subscriber keeps the schedule and a new subscriber recovers Stop', async () => {
  const f = fixture('loop')
  let firstPaints = 0
  const detach = f.controller.subscribe(() => { firstPaints++ })
  await f.controller.run(plan)
  detach()
  const prior = firstPaints
  await f.tick()
  assert.equal(f.starts.length, 2)
  assert.equal(firstPaints, prior)
  let recovered
  f.controller.subscribe(state => { recovered = state })
  assert.equal(recovered.stoppable, true)
  assert.equal(recovered.rows.at(-1).sessionId, 'session-2')
  await f.controller.stop()
  assert.equal(recovered.phase, 'stopped')
  assert.ok(f.timers.filter(timer => !timer.ran).every(timer => timer.cancelled))
})

test('a verified native cap completion updates subscribed controls without another Stop press', async () => {
  let ended
  const f = fixture('launch', { subscribeEnded: listener => { ended = listener; return () => {} } })
  await f.controller.run(plan)
  f.statuses.set('session-1', { ...f.statuses.get('session-1'), state: 'closed', endRecord: { sequence: 45, eventHash: hash } })
  ended('session-1')
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(f.controller.getState().phase, 'completed')
  assert.equal(f.controller.getState().stoppable, false)
  await f.controller.run(plan)
  assert.equal(f.starts.length, 2)
})

test('the selected parent ending cancels future loop starts immediately', async () => {
  let ended
  const f = fixture('loop', { subscribeEnded: listener => { ended = listener; return () => {} } })
  await f.controller.run(plan)
  ended(plan.parentSessionId)
  assert.ok(f.timers.every(timer => timer.cancelled))
  assert.equal(f.starts.length, 1)
  assert.match(f.controller.getState().message, /selected parent ended/)
})
