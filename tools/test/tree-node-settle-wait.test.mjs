/* THE WAIT FOR A RECOVERING CIRCLE, AND WHAT IS CHECKED AGAIN AFTER IT.
 *
 * src/tree-node-settle-wait.js decides what a resume-node / send-to-bound-node
 * does when it lands while the account-recovery coordinator is moving the
 * circle. tree-node-command-recovery-wait.test.mjs drives the same rules
 * through the real Computers view; these cases pin each branch on its own,
 * with the collaborators the view hands the module, so a refusal that has to
 * hold (authority, identity, the session the caller named, the host's word) is
 * proved where it is decided.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NODE_SETTLE_BOUND_MS, NODE_SETTLE_POLL_MS, awaitNodeSettled, hostSessionAlive, settleNodeForCommand,
} from '../../src/tree-node-settle-wait.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pendingOr = promise => Promise.race([promise, sleep(60).then(() => 'PENDING')])

test('the bound and the poll floor are the ones the view documents', () => {
  assert.equal(NODE_SETTLE_BOUND_MS, 30_000)
  assert.equal(NODE_SETTLE_POLL_MS, 250)
})

test('no flight: answered at once, nothing subscribed and no timer armed', async t => {
  const armed = []
  const nativeInterval = globalThis.setInterval
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setInterval', (...args) => { armed.push('interval'); return nativeInterval(...args) })
  t.mock.method(globalThis, 'setTimeout', (...args) => { armed.push('timeout'); return nativeTimeout(...args) })
  let subscribed = 0
  const out = await awaitNodeSettled({ nodeId: 'n1', isSettling: () => false, subscribe: () => { subscribed += 1; return () => {} } })
  assert.deepEqual(out, { waited: false, settled: true, waitedMs: 0 })
  assert.equal(subscribed, 0)
  assert.deepEqual(armed, [])
})

test('the flight\'s own word about this circle ends the wait before any poll', { timeout: 5000 }, async () => {
  let busy = true
  let listener = null
  const waiting = awaitNodeSettled({ nodeId: 'n1', isSettling: () => busy, subscribe: fn => { listener = fn; return () => {} }, boundMs: 60_000, pollMs: 60_000 })
  assert.equal(await pendingOr(waiting), 'PENDING')
  busy = false
  listener({ nodeId: 'n1', recoverySettled: true })
  const out = await waiting
  assert.equal(out.waited, true)
  assert.equal(out.settled, true)
})

test('a word about another circle, or one while the flight still holds, settles nothing', { timeout: 5000 }, async () => {
  let busy = true
  let listener = null
  const waiting = awaitNodeSettled({ nodeId: 'n1', isSettling: () => busy, subscribe: fn => { listener = fn; return () => {} }, boundMs: 60_000, pollMs: 60_000 })
  listener({ nodeId: 'n2', recoverySettled: true })
  listener({ nodeId: 'n1' })
  listener(null)
  assert.equal(await pendingOr(waiting), 'PENDING')
  busy = false
  listener({ nodeId: 'n1' })
  assert.equal((await waiting).settled, true)
})

test('with no word at all the poll ends the wait soon after the flight does', { timeout: 5000 }, async () => {
  let busy = true
  const waiting = awaitNodeSettled({ nodeId: 'n1', isSettling: () => busy, subscribe: null, boundMs: 60_000, pollMs: 10 })
  await sleep(40)
  busy = false
  const out = await waiting
  assert.equal(out.settled, true)
  assert.ok(out.waitedMs < 2000)
})

test('a flight that ends between the first look and the subscription is not missed', { timeout: 5000 }, async () => {
  let busy = true
  const out = await awaitNodeSettled({ nodeId: 'n1', isSettling: () => busy, subscribe: () => { busy = false; return () => {} }, boundMs: 60_000, pollMs: 60_000 })
  assert.equal(out.settled, true)
})

test('a word delivered while the subscription is being made leaves neither the subscription nor a timer behind', { timeout: 5000 }, async t => {
  const armed = []
  const nativeInterval = globalThis.setInterval
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = nativeInterval(...args); armed.push(timer); return timer })
  t.mock.method(globalThis, 'setTimeout', (...args) => { const timer = nativeTimeout(...args); armed.push(timer); return timer })
  let busy = true
  let released = 0
  const out = await awaitNodeSettled({
    nodeId: 'n1', isSettling: () => busy, boundMs: 60_000, pollMs: 60_000,
    subscribe: listener => { busy = false; listener({ nodeId: 'n1', recoverySettled: true }); return () => { released += 1 } },
  })
  assert.equal(out.settled, true)
  assert.equal(released, 1)
  assert.deepEqual(armed, [], 'a timer was armed for a wait that had already ended')
})

test('the bound ends the wait unsettled and releases the subscription and both timers', { timeout: 5000 }, async () => {
  let looks = 0
  let released = 0
  const out = await awaitNodeSettled({
    nodeId: 'n1', isSettling: () => { looks += 1; return true },
    subscribe: () => () => { released += 1 }, boundMs: 80, pollMs: 10,
  })
  assert.equal(out.waited, true)
  assert.equal(out.settled, false)
  assert.equal(released, 1)
  const after = looks
  await sleep(60)
  assert.equal(looks, after, 'the poll kept looking after the wait was over')
})

test('a question that cannot be asked is not a reason to wait', async () => {
  const out = await awaitNodeSettled({ nodeId: 'n1', isSettling: () => { throw new Error('no coordinator') } })
  assert.equal(out.waited, false)
})

test('the host\'s word: only an explicit ok for a session that is not closing counts', async () => {
  const answer = value => ({ sessionActivity: async () => value })
  assert.equal(await hostSessionAlive(null, 's'), false)
  assert.equal(await hostSessionAlive({}, 's'), false)
  assert.equal(await hostSessionAlive(answer({ ok: true }), ''), false)
  assert.equal(await hostSessionAlive(answer(null), 's'), false)
  assert.equal(await hostSessionAlive(answer({ ok: false }), 's'), false)
  assert.equal(await hostSessionAlive(answer({ ok: true, closing: true }), 's'), false)
  assert.equal(await hostSessionAlive({ sessionActivity: async () => { throw new Error('offline') } }, 's'), false)
  assert.equal(await hostSessionAlive(answer({ ok: true, busy: false, closing: false }), 's'), true)
  assert.equal(await hostSessionAlive(answer({ ok: true, busy: true }), 's'), true)
  const asked = []
  await hostSessionAlive({ sessionActivity: async request => { asked.push(request); return { ok: true } } }, 'session-7')
  assert.deepEqual(asked, [{ sessionId: 'session-7' }])
})

/* The circle, its session map and the coordinator's word, as the view hands them. */
function world(overrides = {}) {
  const state = {
    settling: true,
    node: { id: 'n1', treeId: 't1', createdAt: 'c1', sessionId: 'old', status: 'running' },
    bound: new Map([['old', 'n1']]),
    threads: new Map([['new', 'thread-new']]),
    listeners: new Set(),
    aliveCalls: [], refusalCalls: [], reads: 0,
    alive: async () => true,
    caller: () => null,
    destroyed: false,
    ...overrides,
  }
  const original = { ...state.node }
  const args = (action, { command = {}, ...rest } = {}) => ({
    command: { action, expectedSessionId: null, ...command },
    node: original,
    isSettling: () => state.settling,
    subscribe: listener => { state.listeners.add(listener); return () => state.listeners.delete(listener) },
    boundMs: 2000, pollMs: 10,
    isDestroyed: () => state.destroyed,
    currentNode: () => { state.reads += 1; return state.node },
    callerRefusal: fresh => { state.refusalCalls.push(fresh); return state.caller(fresh) },
    sessionNodeIds: state.bound, sessionThreadIds: state.threads,
    sessionAlive: async id => { state.aliveCalls.push(id); return state.alive(id) },
    ...rest,
  })
  const successor = (status = 'running') => { state.node = { ...state.node, sessionId: 'new', status }; state.bound.set('new', 'n1') }
  const end = () => { state.settling = false; for (const listener of [...state.listeners]) listener({ nodeId: 'n1', recoverySettled: true }) }
  return { state, args, original, successor, end }
}

test('no flight: the circle comes back untouched and nothing else is asked', async () => {
  const w = world({ settling: false, caller: () => { throw new Error('asked') }, alive: async () => { throw new Error('asked') } })
  const out = await settleNodeForCommand(w.args('resume-node'))
  assert.equal(out.waited, false)
  assert.equal(out.node, w.original)
  assert.equal(w.state.reads, 0)
  assert.deepEqual(w.state.refusalCalls, [])
  assert.deepEqual(w.state.aliveCalls, [])
  assert.equal(w.state.listeners.size, 0)
})

test('resume: a successor the application owns for this circle and the host confirms answers ok, and starts nothing', { timeout: 5000 }, async () => {
  const w = world()
  const pending = settleNodeForCommand(w.args('resume-node'))
  assert.equal(await pendingOr(pending), 'PENDING')
  w.successor()
  w.end()
  const out = await pending
  assert.deepEqual(out.answer, { ok: true, code: null, nodeId: 'n1', sessionId: 'new', threadId: 'thread-new' })
  assert.deepEqual(w.state.aliveCalls, ['new'])
  assert.equal(w.state.listeners.size, 0, 'the wait left its subscription behind')
})

test('resume: a session this application does not own for this circle falls through to the ordinary gates, and the host is not asked', { timeout: 5000 }, async () => {
  for (const owner of [undefined, 'another-circle']) {
    const w = world()
    const pending = settleNodeForCommand(w.args('resume-node'))
    w.state.node = { ...w.state.node, sessionId: 'new', status: 'running' }
    if (owner) w.state.bound.set('new', owner)
    w.end()
    const out = await pending
    assert.equal(out.answer, undefined)
    assert.equal(out.node.sessionId, 'new')
    assert.equal(out.waited, true)
    assert.deepEqual(w.state.aliveCalls, [])
  }
})

test('resume: an owned successor the host does not confirm is refused, retryably, and nothing is started over it', { timeout: 5000 }, async () => {
  const w = world({ alive: async () => false })
  const pending = settleNodeForCommand(w.args('resume-node'))
  w.successor()
  w.end()
  const { answer } = await pending
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
  assert.equal(answer.retryable, true)
  assert.match(answer.reason, /not confirmed/)
})

test('resume: an owned, confirmed successor that is not running or finished leaves the decision to the ordinary gates', { timeout: 5000 }, async () => {
  const w = world()
  const pending = settleNodeForCommand(w.args('resume-node'))
  w.successor('turn-failed')
  w.end()
  const out = await pending
  assert.equal(out.answer, undefined)
  assert.equal(out.node.status, 'turn-failed')
})

test('the session the caller named is checked again after the wait, for both commands, before anything else is asked', { timeout: 5000 }, async () => {
  for (const action of ['resume-node', 'send-to-bound-node']) {
    const w = world()
    const pending = settleNodeForCommand(w.args(action, { command: { expectedSessionId: 'old' } }))
    w.successor()
    w.end()
    const { answer } = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
    assert.deepEqual(w.state.refusalCalls, [])
    assert.deepEqual(w.state.aliveCalls, [])
  }
})

test('a circle that was removed, recreated or moved to another tree while it waited is not the one that was asked about', { timeout: 5000 }, async () => {
  for (const change of [() => null, node => ({ ...node, createdAt: 'c2' }), node => ({ ...node, treeId: 't2' }), node => ({ ...node, id: 'n2' })]) {
    const w = world()
    const pending = settleNodeForCommand(w.args('resume-node'))
    w.successor()
    w.state.node = change(w.state.node)
    w.end()
    const { answer } = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'MC_TREE_COMMAND_NODE_NOT_FOUND')
    assert.deepEqual(w.state.aliveCalls, [])
  }
})

test('resume: the asker is placed again after the wait, against the circle as it is then', { timeout: 5000 }, async () => {
  const w = world({ caller: () => ({ ok: false, code: 'MC_TREE_COMMAND_NOT_BELOW_CALLER', nodeId: 'n1', sessionId: null, threadId: null }) })
  const pending = settleNodeForCommand(w.args('resume-node', { command: { parentSessionId: 'lead' } }))
  w.successor()
  w.end()
  const { answer } = await pending
  assert.equal(answer.code, 'MC_TREE_COMMAND_NOT_BELOW_CALLER')
  assert.equal(w.state.refusalCalls.length, 1)
  assert.equal(w.state.refusalCalls[0].sessionId, 'new')
  assert.deepEqual(w.state.aliveCalls, [])
})

test('send: the executor gets the circle as it is now, and the module neither answers nor asks the host', { timeout: 5000 }, async () => {
  const w = world()
  const pending = settleNodeForCommand(w.args('send-to-bound-node'))
  w.successor()
  w.end()
  const out = await pending
  assert.equal(out.answer, undefined)
  assert.equal(out.node.sessionId, 'new')
  assert.deepEqual(w.state.aliveCalls, [])
})

test('a wait that outlives the bound is a retryable refusal in the command\'s own code, and reads nothing', { timeout: 5000 }, async () => {
  for (const [action, code] of [['resume-node', 'MC_TREE_COMMAND_RESUME_REFUSED'], ['send-to-bound-node', 'MC_TREE_COMMAND_SEND_FAILED']]) {
    const w = world()
    const { answer } = await settleNodeForCommand(w.args(action, { boundMs: 50 }))
    assert.equal(answer.ok, false)
    assert.equal(answer.code, code)
    assert.equal(answer.retryable, true)
    assert.equal(answer.retryAfterMs, 5000)
    assert.match(answer.reason, /still being moved/)
    assert.equal(w.state.reads, 0)
    assert.equal(w.state.listeners.size, 0)
  }
})

test('a view destroyed while the command waited is the retryable destroyed answer, and reads nothing', { timeout: 5000 }, async () => {
  const w = world()
  const pending = settleNodeForCommand(w.args('resume-node'))
  w.state.destroyed = true
  w.end()
  const { answer } = await pending
  assert.equal(answer.code, 'MC_TREE_COMMAND_VIEW_DESTROYED')
  assert.equal(answer.retryable, true)
  assert.equal(w.state.reads, 0)
})

test('authority lost during the awaited host confirmation is asked again, not carried from before it', { timeout: 5000 }, async () => {
  const w = world()
  w.state.alive = async () => {
    // The caller's own place on the tree can change while the host is being asked.
    w.state.caller = fresh => ({ ok: false, code: 'MC_TREE_COMMAND_NOT_BELOW_CALLER', nodeId: fresh.id, sessionId: null, threadId: null })
    return true
  }
  const pending = settleNodeForCommand(w.args('resume-node', { command: { parentSessionId: 'lead' } }))
  w.successor()
  w.end()
  const { answer } = await pending
  assert.equal(answer.ok, false, 'a caller that lost its place during the host confirmation still received a completed resume')
  assert.equal(answer.code, 'MC_TREE_COMMAND_NOT_BELOW_CALLER')
  assert.equal(w.state.refusalCalls.length, 2, 'authority must be asked again after the host confirms, not only once before it')
})

test('a view destroyed during the awaited host confirmation is the retryable destroyed answer, not a completed resume', { timeout: 5000 }, async () => {
  const w = world()
  w.state.alive = async () => { w.state.destroyed = true; return true }
  const pending = settleNodeForCommand(w.args('resume-node'))
  w.successor()
  w.end()
  const { answer } = await pending
  assert.equal(answer.code, 'MC_TREE_COMMAND_VIEW_DESTROYED')
  assert.equal(answer.retryable, true)
})

test('the circle claimed by a different owner during the awaited host confirmation is re-checked in full, not only for identity', { timeout: 5000 }, async () => {
  const w = world()
  w.state.caller = fresh => (fresh.sessionId === 'new' ? null : { ok: false, code: 'MC_TREE_COMMAND_NOT_BELOW_CALLER', nodeId: fresh.id, sessionId: null, threadId: null })
  w.state.alive = async () => {
    // A second recovery took the circle further while the host was being asked.
    w.state.node = { ...w.state.node, sessionId: 'newer', status: 'running' }
    w.state.bound.set('newer', w.state.node.id)
    return true
  }
  const pending = settleNodeForCommand(w.args('resume-node'))
  w.successor()
  w.end()
  const out = await pending
  assert.equal(out.answer && out.answer.code, 'MC_TREE_COMMAND_NOT_BELOW_CALLER',
    'the circle moved to a session the caller has no authority over, and the fallthrough never asked')
})

test('the host answers after an await: a circle that moved again in the meantime is judged as it is now', { timeout: 5000 }, async () => {
  const moved = world()
  moved.state.alive = async () => { moved.state.node = { ...moved.state.node, sessionId: 'newer' }; moved.state.bound.set('newer', 'n1'); return true }
  let pending = settleNodeForCommand(moved.args('resume-node'))
  moved.successor()
  moved.end()
  let out = await pending
  assert.equal(out.answer, undefined, 'answered with a successor that is no longer the circle\'s session')
  assert.equal(out.node.sessionId, 'newer')

  const replaced = world()
  replaced.state.alive = async () => { replaced.state.node = { ...replaced.state.node, createdAt: 'c2' }; return true }
  pending = settleNodeForCommand(replaced.args('resume-node'))
  replaced.successor()
  replaced.end()
  out = await pending
  assert.equal(out.answer.code, 'MC_TREE_COMMAND_NODE_NOT_FOUND')
})
