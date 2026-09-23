import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const app = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(app, 'shell/main.cjs'))
const main = fs.readFileSync(path.join(app, 'shell/main.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(app, 'src/main.js'), 'utf8')
function slice(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `Production extraction boundaries: ${start}`)
  return source.slice(a, b)
}
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-lifecycle-main-'))
  const cwd = path.join(scratch, 'workspace')
  fs.mkdirSync(cwd)
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const sessions = new Map(), scopes = new Map(), timers = new Set(), closes = [], preferences = new Map(), profiles = new Map()
  const owner = { isDestroyed: () => false, once() {} }
  const principal = { kind: 'window', owner }
  let api
  const plan = { ok: true, tier: 'standard', failedClosed: false }
  const context = vm.createContext({ path, randomUUID, TextEncoder, AbortController, agentSessions: sessions,
    rendererPrefs: { snapshot: () => ({ values: Object.fromEntries(preferences) }) },
    sessionProfiles: { resolveCwd: id => profiles.get(id) }, chosenWorkspaceCwd: () => cwd, WORKSPACE_ROOT: cwd,
    readAgentConfinement: () => plan,
    resolveCapabilityRoot: () => path.resolve(process.env.MC_CANONICAL_ROOT || path.join(app, 'capability')), require,
    agentHost: { readTreeParent: id => { if (!scopes.has(id)) throw new Error('missing root'); return scopes.get(id) } },
    setTimeout(fn) { timers.add(fn); return fn }, clearTimeout(fn) { timers.delete(fn) },
    queueTreeNodeCommand: () => true, treeNodeCommandBroker: { state: () => ({}) },
    treeNodeCommandRefusalSentence: () => null, treeCommandRefusalSentence: () => 'Refused',
    getAgentCommandSurface: () => ({ run: async (_action, { sessionId }) => {
      api.rememberTreeAdmission(sessionId); closes.push(sessionId); sessions.delete(sessionId); scopes.delete(sessionId)
    } }),
  })
  const region = slice(main, 'const localTreeCommands = new Map()', 'let treeNodeCommandDispatchEnabled')
  const hooks = slice(main, '    redeemTreeDelegation(token, request, principal) {', '    recordSpawnOutcome,')
  const normalizer = slice(renderer, 'function cleanTreeNodeCommand(value)', 'async function completeTreeNodeCommand')
  api = vm.runInContext(`${region}\n${normalizer}\ntreeCommandComputerId = 'computer';
    ({rememberTreeAdmission,readTreeAdmission,beginTreeStart,readTreeParentAuthority,dispatchTreeSpawn,
      resolveLocalTreeCommand,localTreeCommands,treeOwnerKey,cleanTreeNodeCommand,treeCommandStartAdmission,
      hooks: {${hooks}}})`, context)
  const key = api.treeOwnerKey(principal)
  function add(id, nodeId, anchors, extra = {}) {
    sessions.set(id, { state: 'ready', ended: false, ownerKind: 'window', owner, treeNodeId: nodeId })
    scopes.set(id, { sessionId: id, nodeId, treeId: 'parent', treeAnchors: anchors, cwd,
      agentId: `agent-${nodeId}`, selfName: nodeId, modelTier: 'claude-sonnet', roleId: 'worker', threadId: `thread-${nodeId}`,
      workspaceRoots: [cwd], permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' }, ...extra })
  }
  add('parent-session', 'parent', ['parent'])
  add('old-session', 'child', ['parent', 'child'])
  api.rememberTreeAdmission('old-session')
  const original = api.readTreeAdmission('child', key)
  const request = () => ({ sessionId: 'new-session', cwd, tier: 'claude-sonnet', role: { id: 'worker' },
    requestKeys: { threadId: 'child', treeAnchors: ['parent', 'child'] }, resumeThreadId: 'thread-child' })
  function stop() { sessions.delete('old-session'); scopes.delete('old-session') }
  function dispatch(extra = {}) {
    const promise = api.dispatchTreeSpawn({ action: 'resume-node', parentSessionId: 'parent-session', nodeId: 'child', ...extra })
    promise.catch(() => {})
    const waiting = [...api.localTreeCommands.values()].at(-1)
    return { promise, waiting, command: waiting?.envelope.request }
  }
  function bindReplacement(command) {
    const start = request()
    start.delegationPermit = api.hooks.redeemTreeDelegation(command.delegationToken, start, principal)
    const attempt = api.beginTreeStart(start, principal)
    add('new-session', 'child', ['parent', 'child'])
    Object.assign(sessions.get('new-session'), { treeDelegationStart: start.delegationPermit, treeLifecycleTarget: attempt.lifecycleTarget })
    api.rememberTreeAdmission('new-session')
    attempt.done()
    return start
  }
  return { api, sessions, scopes, timers, closes, principal, key, cwd, scratch, original, request, stop, dispatch, bindReplacement, add, plan, preferences, profiles,
    useBroker(value) { context.treeNodeCommandBroker = value } }
}

async function commandAdmissionFixture(t, overrides = {}) {
  const f = fixture(t)
  let clock = 1000
  const requestId = 'tnc-11111111-1111-4111-8111-111111111111'
  const command = { requestId, action: 'create-and-start-node', computerId: 'computer',
    nodeId: null, treeId: null, parentSessionId: 'parent-session', role: 'worker', tier: 'claude-sonnet', ...overrides }
  const graph = { computerId: 'computer', trees: [{ id: 'saved-tree', profileId: null }], nodes: [
    { id: 'parent', parentId: null, treeId: 'saved-tree', sessionId: 'parent-session', status: 'running' },
    { id: 'child', parentId: 'parent', treeId: 'saved-tree', sessionId: null, status: 'starting', tier: 'claude-sonnet', role: 'worker' },
  ] }
  const save = () => f.preferences.set('mc.fleet.trees.v1:computer', JSON.stringify(graph))
  save()
  const broker = require('./tree-node-command-broker.cjs').createTreeNodeCommandBroker({
    now: () => clock, loadAndClaim: () => ({ request: command }), publishResult: async () => ({ ok: true }),
    sendToRenderer() {}, setTimer: () => 1, clearTimer() {},
  })
  f.useBroker(broker)
  broker.setRendererReady(true); broker.queueRequest(requestId)
  await new Promise(resolve => setImmediate(resolve))
  t.after(() => broker.dispose())
  const request = { ...f.request(), treeCommandRequestId: requestId }
  delete request.resumeThreadId
  return { f, broker, request, graph, save,
    expire() { clock += 300_000 },
    admit(value = request, principal = f.principal) { return f.api.treeCommandStartAdmission(value, principal) },
  }
}

test('tree command admission checks the actual deadline before dispatch but retains a dispatched attempt', async t => {
  const q = await commandAdmissionFixture(t)
  const pending = q.admit()
  q.expire()
  assert.throws(() => pending.assertCurrent(), { code: 'MC_TREE_COMMAND_COMPLETION_TIMEOUT' }, 'delayed timer callbacks cannot extend admission')
  assert.throws(() => pending.beginDispatch(), { code: 'MC_TREE_COMMAND_COMPLETION_TIMEOUT' })

  const ready = await commandAdmissionFixture(t)
  const dispatched = ready.admit()
  dispatched.beginDispatch()
  ready.expire(); ready.broker.dispose()
  assert.doesNotThrow(() => dispatched.assertCurrent(), 'an uncertain native attempt must keep its eventual receipt')
  assert.equal(dispatched.signal.aborted, false, 'command timeout does not terminate a dispatched start')
})

test('tree command admission rejects another action, owner, node, parent, tree, model, or profile', async t => {
  const wrongAction = await commandAdmissionFixture(t, { action: 'stop-node' })
  assert.throws(() => wrongAction.admit(), { code: 'TREE_DELEGATION_REFUSED' })
  const q = await commandAdmissionFixture(t)
  assert.throws(() => q.admit({ ...q.request, treeCommandRequestId: 'tnc-22222222-2222-4222-8222-222222222222' }), { code: 'TREE_DELEGATION_REFUSED' })
  assert.throws(() => q.admit(q.request, { kind: 'relay', owner: q.f.principal.owner }), { code: 'TREE_DELEGATION_REFUSED' })
  assert.throws(() => q.admit(q.request, { kind: 'window', owner: { isDestroyed: () => false } }), { code: 'TREE_DELEGATION_REFUSED' })
  for (const change of [
    request => { request.resumeThreadId = 'another-provider-thread' },
    request => { request.requestKeys = { ...request.requestKeys, threadId: 'other' } },
    request => { request.requestKeys = { ...request.requestKeys, treeAnchors: ['other', 'child'] } },
    request => { request.tier = 'luna' },
    request => { request.profileId = 'different' },
  ]) {
    const request = { ...q.request }; change(request)
    assert.throws(() => q.admit(request), { code: 'TREE_DELEGATION_REFUSED' })
  }
  const pending = q.admit()
  q.graph.nodes[1].parentId = 'other'; q.save()
  assert.throws(() => pending.beginDispatch(), { code: 'TREE_DELEGATION_REFUSED' })
  q.graph.nodes[1].parentId = 'parent'; q.graph.nodes[1].treeId = 'other-tree'; q.save()
  assert.throws(() => pending.beginDispatch(), { code: 'TREE_DELEGATION_REFUSED' })
  q.graph.nodes[1].treeId = 'saved-tree'; q.save(); q.f.sessions.delete('parent-session')
  assert.throws(() => pending.beginDispatch(), { code: 'TREE_DELEGATION_REFUSED' })
})

test('one broker create request cannot be reused for a second saved child', async t => {
  const q = await commandAdmissionFixture(t)
  q.admit()
  q.graph.nodes.push({ ...q.graph.nodes[1], id: 'other-child' }); q.save()
  assert.throws(() => q.admit({ ...q.request, requestKeys: { threadId: 'other-child', treeAnchors: ['parent', 'other-child'] } }), { code: 'TREE_DELEGATION_REFUSED' })
})

test('main bounded admission reads the durable selected graph, live parent and retained workspace inode', t => {
  const f = fixture(t)
  f.api.rememberTreeAdmission('parent-session')
  const graph = { computerId: 'computer', trees: [{ id: 'saved-tree', profileId: 'chosen-profile' }], nodes: [
    { id: 'parent', parentId: null, treeId: 'saved-tree', sessionId: 'parent-session' },
    { id: 'bounded-child', parentId: 'parent', treeId: 'saved-tree', sessionId: null, tier: 'claude-sonnet', role: 'worker' },
  ] }
  f.profiles.set('chosen-profile', f.cwd)
  f.preferences.set('mc.fleet.trees.v1:computer', JSON.stringify(graph))
  const request = { sessionId: 'bounded-session', agentId: 'bounded-child', cwd: f.cwd, tier: 'claude-sonnet', role: { id: 'worker' },
    requestKeys: { threadId: 'bounded-child', treeAnchors: ['parent', 'bounded-child'] }, treeIdentity: { selfName: 'Child', managerName: 'parent' },
    boundedWork: { computerId: 'computer', treeId: 'saved-tree', parentNodeId: 'parent', parentSessionId: 'parent-session', capMs: 60000 } }
  const permit = f.api.hooks.beginBoundedTreeStart(request, f.principal)
  permit.assertStart()
  assert.equal(permit.details.nodeId, 'bounded-child')
  assert.equal(permit.details.parentNodeId, 'parent')
  f.profiles.set('chosen-profile', path.join(f.scratch, 'other'))
  assert.throws(() => permit.assertStart(), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' })
  f.profiles.set('chosen-profile', f.cwd)
  fs.renameSync(f.cwd, f.cwd + '-original')
  fs.mkdirSync(f.cwd)
  assert.throws(() => permit.assertStart(), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' }, 'same-spelled replacement directory must not borrow the original admission')
})
const refused = fn => assert.throws(fn, { code: 'TREE_DELEGATION_REFUSED' })
test('later Full or unreadable current start policy refuses before closing the old root', async t => {
  const f = fixture(t), d = f.dispatch()
  f.plan.tier = 'unrestricted'
  refused(() => f.api.hooks.assertTreeLifecycleClose(d.command.delegationToken, 'old-session', f.principal))
  assert.equal(f.sessions.has('old-session'), true)
  assert.equal(f.closes.length, 0)
  for (const timer of [...f.timers]) timer()
  await assert.rejects(d.promise)
  const declined = f.dispatch()
  await assert.rejects(declined.promise, { code: 'TREE_DELEGATION_REFUSED' })
  assert.equal(f.api.localTreeCommands.size, 0)
})
test('actual main retains stopped immutable admission with live provider thread', t => {
  const f = fixture(t)
  assert.ok(Object.isFrozen(f.original.workspaceRoots))
  assert.equal(f.original.threadId, 'thread-child')
  f.stop()
  assert.equal(f.api.readTreeAdmission('child', f.key), f.original)
})
test('owner begin invalidates old authority immediately and excludes parallel actual starts', t => {
  const f = fixture(t); f.stop()
  const attempt = f.api.beginTreeStart(f.request(), f.principal)
  assert.equal(f.api.readTreeAdmission('child', f.key), null)
  refused(() => f.api.beginTreeStart(f.request(), f.principal))
  attempt.done()
  const next = f.api.beginTreeStart(f.request(), f.principal)
  attempt.done()
  refused(() => f.api.beginTreeStart(f.request(), f.principal))
  next.done()
})
test('actual dispatch fills expected session, normalizes issued token, verifies close and commits replacement receipt', async t => {
  const f = fixture(t), d = f.dispatch()
  assert.equal(d.command.expectedSessionId, 'old-session')
  assert.equal(f.api.cleanTreeNodeCommand(d.command)?.delegationToken, d.command.delegationToken)
  refused(() => f.api.beginTreeStart(f.request(), f.principal))
  f.api.hooks.assertTreeLifecycleClose(d.command.delegationToken, 'old-session', f.principal)
  refused(() => f.api.hooks.assertTreeLifecycleClose(d.command.delegationToken, 'different', f.principal))
  f.stop()
  f.bindReplacement(d.command)
  assert.equal(f.api.readTreeAdmission('child', f.key), f.original)
  f.api.resolveLocalTreeCommand(d.waiting.envelope, { ok: true, nodeId: 'child', sessionId: 'new-session', threadId: 'renderer-forgery' })
  const result = await d.promise
  assert.equal(result.threadId, 'thread-child')
  assert.equal(f.api.readTreeAdmission('child', f.key).sessionId, 'new-session')
})
test('different live Full root prevents borrowing old stopped Standard admission', t => {
  const f = fixture(t); f.stop()
  f.add('owner-full', 'child', ['parent', 'child'], { permissionSession: { origin: 'local', tier: 'full', profile: null } })
  assert.equal(f.api.readTreeAdmission('child', f.key), null)
})
test('parent cessation after issuance refuses close and root redemption', async t => {
  const f = fixture(t), d = f.dispatch()
  f.sessions.delete('parent-session')
  refused(() => f.api.hooks.assertTreeLifecycleClose(d.command.delegationToken, 'old-session', f.principal))
  refused(() => f.api.hooks.redeemTreeDelegation(d.command.delegationToken, f.request(), f.principal))
  for (const timer of [...f.timers]) timer()
  await assert.rejects(d.promise)
})
test('real directory inode replacement invalidates retained workspace ceiling', t => {
  const f = fixture(t); f.stop()
  fs.renameSync(f.cwd, path.join(f.scratch, 'original-workspace'))
  fs.mkdirSync(f.cwd)
  assert.throws(() => f.api.readTreeAdmission('child', f.key))
})
test('timeout removes waiter and cleans exact root without admitting failed replacement', async t => {
  const f = fixture(t); f.stop()
  const d = f.dispatch(); f.bindReplacement(d.command)
  for (const timer of [...f.timers]) timer()
  await assert.rejects(d.promise, { code: 'MC_TREE_SPAWN_NOT_DELIVERED' })
  assert.deepEqual(f.closes, ['new-session'])
  assert.equal(f.api.readTreeAdmission('child', f.key), f.original)
  assert.equal(f.api.localTreeCommands.size, 0)
})
test('explicit stale expectedSessionId refuses before any broker entry or close', async t => {
  const f = fixture(t), d = f.dispatch({ expectedSessionId: 'stale-session' })
  await assert.rejects(d.promise, { code: 'TREE_DELEGATION_REFUSED' })
  assert.equal(f.api.localTreeCommands.size, 0)
  assert.deepEqual(f.closes, [])
})
test('wrong final provider thread cleans replacement and preserves previous admission', async t => {
  const f = fixture(t); f.stop()
  const d = f.dispatch(); f.bindReplacement(d.command)
  f.scopes.get('new-session').threadId = 'wrong-provider-thread'
  f.api.resolveLocalTreeCommand(d.waiting.envelope, { ok: true, nodeId: 'child', sessionId: 'new-session' })
  await assert.rejects(d.promise, { code: 'TREE_DELEGATION_REFUSED' })
  assert.deepEqual(f.closes, ['new-session'])
  assert.equal(f.api.readTreeAdmission('child', f.key), f.original)
})
test('directory replacement after issue refuses preclose without touching old root', async t => {
  const f = fixture(t), d = f.dispatch()
  fs.renameSync(f.cwd, path.join(f.scratch, 'old-workspace'))
  fs.mkdirSync(f.cwd)
  refused(() => f.api.hooks.assertTreeLifecycleClose(d.command.delegationToken, 'old-session', f.principal))
  assert.ok(f.sessions.has('old-session'))
  for (const timer of [...f.timers]) timer()
  await assert.rejects(d.promise)
})
test('actual renderer completion forwards only successful restart submitted state', async () => {
  const completion = slice(renderer, 'async function completeTreeNodeCommand(command, result)', '\n/* A REQUEST THIS RENDERER')
  const packets = []
  const complete = vm.runInNewContext(`${completion}\ncompleteTreeNodeCommand`, {
    window: { mcTreeCommand: { complete: async packet => packets.push(packet) } },
    treeNodeCommandReason: () => null, console,
  })
  for (const action of ['fresh-start-existing-node', 'resume-node', 'create-and-start-node', 'stop-node']) {
    for (const ok of [true, false]) for (const state of ['submitted', 'completed', 'failed', null, { submitted: true }]) {
      await complete({ requestId: 'request', action, nodeId: 'child' },
        { ok, sessionId: 'session', firstTurnState: state })
      const packet = packets.at(-1)
      const allowed = action === 'fresh-start-existing-node' && ok && state === 'submitted'
      assert.equal(Object.hasOwn(packet, 'firstTurnState'), allowed)
      if (allowed) assert.equal(packet.firstTurnState, 'submitted')
    }
  }
})
test('actual main verified restart receipt preserves submitted but never arbitrary completion claims', async t => {
  for (const state of ['submitted', 'completed', 'failed', null, { submitted: true }]) {
    const f = fixture(t); f.stop()
    const d = f.dispatch({ action: 'fresh-start-existing-node' })
    const request = f.request()
    delete request.resumeThreadId
    request.delegationPermit = f.api.hooks.redeemTreeDelegation(d.command.delegationToken, request, f.principal)
    const attempt = f.api.beginTreeStart(request, f.principal)
    f.add('new-session', 'child', ['parent', 'child'])
    Object.assign(f.sessions.get('new-session'), { treeDelegationStart: request.delegationPermit,
      treeLifecycleTarget: attempt.lifecycleTarget })
    attempt.done()
    f.api.resolveLocalTreeCommand(d.waiting.envelope,
      { ok: true, nodeId: 'child', sessionId: 'new-session', firstTurnState: state })
    const receipt = await d.promise
    assert.equal(Object.hasOwn(receipt, 'firstTurnState'), state === 'submitted')
    if (state === 'submitted') assert.equal(receipt.firstTurnState, 'submitted')
  }
})
test('actual main omits submitted state from resume receipt', async t => {
  const f = fixture(t); f.stop()
  const d = f.dispatch(); f.bindReplacement(d.command)
  f.api.resolveLocalTreeCommand(d.waiting.envelope,
    { ok: true, nodeId: 'child', sessionId: 'new-session', firstTurnState: 'submitted' })
  assert.equal(Object.hasOwn(await d.promise, 'firstTurnState'), false)
})
