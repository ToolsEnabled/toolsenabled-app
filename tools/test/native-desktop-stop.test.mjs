import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const { createNativeDesktopStop, normalizeDesktopStopRequest } = require('../../shell/native-desktop-stop.cjs')
const deferred = () => { let resolve; const promise = new Promise(go => { resolve = go }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const errorCode = expected => error => error.code === expected
const requestId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`

function fixture(options = {}) {
  const context = { owner: {}, ticket: 1, epoch: 0, deviceId: 'device-a', pairId: 'pair-a' }
  const state = { ...context, mayWrite: true, ready: true, now: 0 }
  const session = { ownerKind: 'window', treeNodeId: 'node-a', state: 'ready' }
  const sessions = new Map([['session-a', session]])
  const tree = { computerId: 'this-computer', trees: [{ id: 'tree-a', createdAt: '2026-09-14T20:00:00Z' }], nodes: [
    { id: 'node-a', treeId: 'tree-a', parentId: null, createdAt: '2026-09-14T20:00:01Z', sessionId: 'session-a', reply: 'first\nsecond' },
  ] }
  const dispatched = []
  const assertContext = (read, write) => {
    if (['owner', 'ticket', 'epoch', 'deviceId', 'pairId'].some(key => read[key] !== state[key])) {
      throw Object.assign(new Error('private connection detail'), { code: 'MC_AGENT_CONNECTION_CLOSED' })
    }
    if (write && !state.mayWrite) throw Object.assign(new Error('private consent detail'), { code: 'MC_AGENT_PRINCIPAL_READ_ONLY' })
  }
  const deps = {
    assertContext,
    checkContext: async (read, write) => { if (options.check) await options.check(); assertContext(read, write) },
    readTree: () => tree,
    sessionFor: (id, _context, expected) => {
      const current = sessions.get(id)
      if (!current || (expected && expected !== current) || current.ownerKind !== 'window' || current.boundedWork || current.state !== 'ready') {
        throw Object.assign(new Error('private session detail'), { code: 'MC_AGENT_REMOTE_SESSION_REFUSED' })
      }
      return current
    },
    handler: {
      ready: () => state.ready,
      dispatch: request => {
        const finish = deferred()
        dispatched.push({ request, finish })
        return { completion: finish.promise }
      },
    },
  }
  const controller = createNativeDesktopStop(deps, { runtimeId: 'runtime-a', now: () => state.now,
    ...(options.maxOperations ? { maxOperations: options.maxOperations } : {}) })
  const target = () => controller.targetFor('session-a', context)
  const request = (id = 1) => ({ requestId: requestId(id), target: target() })
  return { controller, context, state, session, sessions, tree, deps, dispatched, target, request }
}

test('native binding is stable while streaming and changes for topology or session-instance replacement', () => {
  const f = fixture()
  const original = f.target()
  f.tree.nodes[0].reply += '\nthird'
  f.tree.nodes[0].updatedAt = 'later'
  f.session.busy = true
  assert.deepEqual(f.target(), original)
  f.tree.nodes[0].parentId = 'node-parent'
  assert.notEqual(f.target().revision, original.revision)
  f.tree.nodes[0].parentId = null
  f.sessions.set('session-a', { ...f.session })
  assert.notEqual(f.target().revision, original.revision, 'same session ID cannot stand for a replacement object')
})

test('strict request schema excludes arbitrary authority/actions and malformed target identifiers', () => {
  const f = fixture()
  const request = f.request()
  assert.deepEqual(normalizeDesktopStopRequest(request), request)
  for (const bad of [null, [], { ...request, accountId: 'other' }, { ...request, action: 'start' },
    { ...request, requestId: 'not-a-uuid' }, { ...request, target: { ...request.target, owner: 'window' } },
    { ...request, target: { ...request.target, nodeId: 'x'.repeat(129) } },
    { ...request, target: { ...request.target, revision: 'A'.repeat(64) } }]) {
    assert.throws(() => normalizeDesktopStopRequest(bad), errorCode('MC_AGENT_DESKTOP_STOP_INVALID'))
  }
})

for (const [label, change] of [
  ['not-ready native handler', f => { f.state.ready = false }],
  ['read-only grant', f => { f.state.mayWrite = false }],
  ['bounded work', f => { f.session.boundedWork = true }],
  ['browser-owned session', f => { f.session.ownerKind = 'relay' }],
  ['detached native node', f => { f.tree.nodes[0].sessionId = null }],
]) test(`${label} receives no Stop target`, () => {
  const f = fixture()
  change(f)
  assert.equal(f.target(), null)
})

test('one dispatch returns pending; same request reads its receipt after the session is gone', async () => {
  const f = fixture()
  const request = f.request()
  const pending = await f.controller.start(request, f.context)
  assert.equal(pending.state, 'pending')
  assert.equal(pending.closed, false)
  assert.equal(f.dispatched.length, 1)
  assert.deepEqual(await f.controller.start(request, f.context), pending)
  f.sessions.delete('session-a')
  f.dispatched[0].finish.resolve({ closed: true, savedState: 'recorded' })
  await tick()
  const done = await f.controller.start(request, f.context)
  assert.equal(done.state, 'completed')
  assert.equal(done.closed, true)
  assert.equal(done.savedState, 'recorded')
  assert.equal(f.dispatched.length, 1)
})

test('concurrent duplicate admission shares one dispatch; another body/press cannot repeat Stop', async () => {
  const gate = deferred()
  const f = fixture({ check: () => gate.promise })
  const request = f.request()
  const first = f.controller.start(request, f.context)
  const duplicate = f.controller.start(request, f.context)
  gate.resolve()
  const answers = await Promise.all([first, duplicate])
  assert.deepEqual(answers[0], answers[1])
  assert.equal(f.dispatched.length, 1)
  await assert.rejects(f.controller.start({ ...request, target: { ...request.target, revision: '0'.repeat(64) } }, f.context), errorCode('MC_AGENT_DESKTOP_STOP_REQUEST_REUSED'))
  await assert.rejects(f.controller.start(f.request(2), f.context), errorCode('MC_AGENT_DESKTOP_STOP_PENDING'))
})

for (const [label, change] of [
  ['account', f => { f.state.owner = {} }], ['pairing', f => { f.state.pairId = 'new-pair' }],
  ['write consent', f => { f.state.mayWrite = false }], ['connection', f => { f.state.ticket++ }],
  ['session object', f => { f.sessions.set('session-a', { ...f.session }) }],
  ['tree membership', f => { f.tree.nodes[0].treeId = 'other-tree' }],
  ['native readiness', f => { f.state.ready = false }],
]) test(`${label} change during admission prevents native dispatch`, async () => {
  const gate = deferred()
  const f = fixture({ check: () => gate.promise })
  const pending = f.controller.start(f.request(), f.context)
  change(f)
  gate.resolve()
  try {
    const result = await pending
    assert.equal(result.outcome, 'not-sent')
    assert.equal(result.state, 'refused')
  } catch (error) { assert.match(error.code, /^MC_AGENT_(CONNECTION_CLOSED|PRINCIPAL_READ_ONLY)$/) }
  assert.equal(f.dispatched.length, 0)
})

test('private final target check rejects a replacement after renderer delivery', async () => {
  const f = fixture()
  await f.controller.start(f.request(), f.context)
  const admitted = f.dispatched[0].request
  admitted.assertTarget()
  f.tree.nodes[0].parentId = 'new-parent'
  assert.throws(() => admitted.assertTarget(), errorCode('MC_AGENT_DESKTOP_STOP_STALE_TARGET'))
})

test('cleanup continues privately after revocation; old or foreign caller cannot read it', async () => {
  const f = fixture()
  const request = f.request()
  await f.controller.start(request, f.context)
  f.state.owner = {}
  f.dispatched[0].finish.resolve({ closed: true, savedState: 'recorded' })
  await tick()
  await assert.rejects(f.controller.status({ requestId: request.requestId }, f.context), errorCode('MC_AGENT_CONNECTION_CLOSED'))
  const newer = { ...f.context, owner: f.state.owner }
  await assert.rejects(f.controller.status({ requestId: request.requestId }, newer), errorCode('MC_AGENT_DESKTOP_STOP_RECEIPT_UNAVAILABLE'))
  await assert.rejects(f.controller.status({ requestId: requestId(99) }, newer), errorCode('MC_AGENT_DESKTOP_STOP_RECEIPT_UNAVAILABLE'))
})

for (const [result, expected] of [
  [{ closed: false }, { closed: false, savedState: 'pending', code: 'AGENT_STOP_PENDING' }],
  [{ closed: true, savedState: 'unconfirmed' }, { closed: true, savedState: 'unconfirmed', code: 'MC_AGENT_DESKTOP_STOP_SAVE_PENDING' }],
]) test(`uncertain ${expected.savedState} cleanup stays explicit and is not implicitly retried`, async () => {
  const f = fixture({ maxOperations: 1 })
  const request = f.request()
  await f.controller.start(request, f.context)
  f.dispatched[0].finish.resolve(result)
  await tick()
  f.state.now = 60 * 60 * 1000
  const receipt = await f.controller.status({ requestId: request.requestId }, f.context)
  assert.equal(receipt.state, 'needs-attention')
  for (const [key, value] of Object.entries(expected)) assert.equal(receipt[key], value)
  await assert.rejects(f.controller.start(f.request(2), f.context), errorCode('MC_AGENT_DESKTOP_STOP_CAPACITY'))
  assert.equal(f.dispatched.length, 1)
})

test('completed receipts expire at the fixed bound; polling does not extend it', async () => {
  const f = fixture({ maxOperations: 1 })
  const request = f.request()
  await f.controller.start(request, f.context)
  f.dispatched[0].finish.resolve({ closed: true, savedState: 'recorded' })
  await tick()
  f.state.now = 30 * 60 * 1000 - 1
  assert.equal((await f.controller.status({ requestId: request.requestId }, f.context)).state, 'completed')
  f.state.now++
  await assert.rejects(f.controller.status({ requestId: request.requestId }, f.context), errorCode('MC_AGENT_DESKTOP_STOP_RECEIPT_UNAVAILABLE'))
})

test('one listing projection reads the native saved snapshot once; admission always rereads', async () => {
  const f = fixture(), original = f.deps.readTree
  let reads = 0; f.deps.readTree = () => { reads++; return original() }
  assert.equal(f.controller.targetsFor(['session-a', 'other-a', 'other-b'], f.context).size, 1)
  assert.equal(reads, 1)
  const request = f.request(); const before = reads
  await f.controller.start(request, f.context)
  assert.ok(reads >= before + 2, 'initial and final admission re-read native identity')
})
