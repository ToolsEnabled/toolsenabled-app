import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createDraftImageCoordinator } = require('../../shell/draft-image-coordinator.cjs')
const files = ['../../shell/draft-image-coordinator.cjs', '../../shell/draft-image-authority.cjs', './draft-image-coordinator.test.mjs']
const hashes = () => Object.fromEntries(files.map(relative => {
  const file = fileURLToPath(new URL(relative, import.meta.url))
  return [relative, createHash('sha256').update(readFileSync(file)).digest('hex')]
}))
const before = hashes()
console.log('DEPENDENCIES_BEFORE ' + JSON.stringify(before))
test.after(() => {
  const after = hashes()
  console.log('DEPENDENCIES_AFTER ' + JSON.stringify(after))
  assert.deepEqual(after, before)
})

// Inert host records and exact saver-return strings only. No engine, provider,
// filesystem mutation, window creation, or process launch occurs in this suite.
function fixture(options = {}) {
  const window = { isDestroyed: () => state.closed }
  const principal = { kind: 'window', owner: window, mayWrite: true }
  const state = {
    closed: false, ownerId: 'owner-a', epoch: 'epoch-a', productPrincipal: 'principal-a',
    computerId: 'computer-a', sessions: new Map(), metadata: new Map(), bindings: new Map(),
    graph: { version: 1, computerId: 'computer-a', trees: [{ id: 'tree-a', createdAt: 'tree-created' }],
      nodes: [{ id: 'node-a', treeId: 'tree-a', parentId: null, role: '', createdAt: 'node-created', status: 'draft', sessionId: null }] },
    seat: { id: 'standalone-existing', nodeId: 'standalone-existing', role: 'worker', enabled: true },
    orgRevision: 1, bindCalls: [], beforeBind: null, afterBind: null,
  }
  const context = () => ({ ownerId: state.ownerId, epoch: state.epoch })
  const coordinator = createDraftImageCoordinator({
    readOwner: (p, supplied) => {
      if (p.owner !== window || supplied?.ownerId !== state.ownerId || supplied?.epoch !== state.epoch) throw new Error('stale owner')
      return { productOwnerId: state.ownerId, currentEpoch: state.epoch, principal: state.productPrincipal, window }
    },
    readComputerId: () => state.computerId,
    readSavedGraph: () => state.graph,
    readOrgSeat: nodeId => ({ seat: state.seat?.id === nodeId ? state.seat : null, revision: state.orgRevision }),
    readSession: id => state.sessions.get(id) || null,
    sessionMetadata: id => state.metadata.get(id) || null,
    transcriptBinding: id => state.bindings.get(id) || null,
    bindTranscript: request => {
      state.beforeBind?.(request)
      state.bindCalls.push(request)
      state.bindings.set(request.sessionId, { computerId: request.computerId, nodeId: request.nodeId })
      state.afterBind?.(request)
      return { ok: true }
    },
    randomUUID: () => 'fixture-namespace',
    ...options,
  })
  const register = (kind = 'standalone', extra = {}) => coordinator.register({
    kind, computerId: state.computerId, nodeId: kind === 'tree' ? 'node-a' : 'standalone-existing',
    ownerContext: context(), ...extra,
  }, principal)
  const request = (receipt, extra = {}) => ({ draftId: receipt.draftId, ownerContext: context(), ...extra })
  const save = (receipt, exactPath = 'exact-saver-result-a') => {
    const ticket = coordinator.capture(request(receipt), principal)
    coordinator.assert(ticket)
    return coordinator.addSaved(ticket, exactPath)
  }
  const installSession = (receipt, overrides = {}) => {
    const canonical = {}
    const record = { session: canonical, sessionId: receipt.sessionId, window, productPrincipal: state.productPrincipal,
      live: true, retired: false, switchPending: false, issued: new Set(), ...overrides }
    state.sessions.set(receipt.sessionId, record)
    state.metadata.set(receipt.sessionId, { threadId: 'actual-thread', provider: 'codex', account: null })
    return record
  }
  const start = (receipt, overrides = {}) => {
    const ticket = coordinator.authorizeStart(request(receipt, { sessionId: receipt.sessionId }), principal)
    const record = installSession(receipt, overrides)
    coordinator.bindStarted(ticket)
    return record
  }
  const adoption = (receipt, images) => request(receipt, {
    sessionId: receipt.sessionId, imageIds: images.map(image => image.imageId),
  })
  return { coordinator, state, principal, context, register, request, save, start, installSession, adoption }
}
const refuses = run => assert.throws(run, error => typeof error.code === 'string' && error.code.startsWith('IMAGE_'))

test('standalone keeps its canonical seat and mints opaque fresh session and image receipts', () => {
  const f = fixture()
  // Standalone authority comes from the existing org seat, not a fabricated fleet record.
  f.state.graph = null
  const receipt = f.register()
  assert.equal(receipt.conversationId, f.state.seat.id)
  assert.deepEqual(Object.keys(receipt).sort(), ['computerId', 'conversationId', 'draftId', 'ownerContext', 'sessionId'])
  const image = f.save(receipt)
  assert.deepEqual(Object.keys(image).sort(), ['draftId', 'imageId'])
  const session = f.start(receipt)
  const result = f.coordinator.adopt(f.adoption(receipt, [image]), f.principal)
  assert.equal(result.automaticSend, false)
  assert.deepEqual([...session.issued], ['exact-saver-result-a'])
  assert.deepEqual(f.state.bindCalls, [{
    sessionId: receipt.sessionId, computerId: receipt.computerId, nodeId: receipt.conversationId, authoritative: true,
  }])
  assert.equal(JSON.stringify(result).includes('exact-saver-result'), false)
  assert.deepEqual(f.coordinator.resolveIssued(f.adoption(receipt, [image]), f.principal), ['exact-saver-result-a'])
})

test('tree draft uses saved node and immutable tree identity through ready adoption', () => {
  const f = fixture()
  const receipt = f.register('tree'), image = f.save(receipt)
  f.start(receipt)
  f.state.graph.nodes[0].status = 'running'
  f.state.graph.nodes[0].sessionId = receipt.sessionId
  assert.equal(f.coordinator.adopt(f.adoption(receipt, [image]), f.principal).conversationId, 'node-a')
})

test('renderer cannot nominate an existing session or register another computer', () => {
  const f = fixture()
  refuses(() => f.register('standalone', { expectedSessionId: 'renderer-selected' }))
  refuses(() => f.register('standalone', { computerId: 'another-computer' }))
  refuses(() => f.coordinator.register({ kind: 'standalone', computerId: f.state.computerId,
    nodeId: f.state.seat.id, ownerContext: f.context() }, { ...f.principal, kind: 'relay' }))
})

test('missing disabled and mismatched canonical standalone seats refuse', () => {
  for (const seat of [null, { id: 'standalone-existing', nodeId: 'standalone-existing', role: 'worker', enabled: false },
    { id: 'standalone-existing', nodeId: 'different-node', role: 'worker', enabled: true }]) {
    const f = fixture(); f.state.seat = seat
    refuses(() => f.register())
  }
})

test('tree registration refuses unsaved duplicate running or previously bound nodes', () => {
  const edits = [
    f => { f.state.graph = null },
    f => { f.state.graph.nodes.push({ ...f.state.graph.nodes[0] }) },
    f => { f.state.graph.nodes[0].status = 'running' },
    f => { f.state.graph.nodes[0].sessionId = 'prior-session' },
  ]
  for (const edit of edits) { const f = fixture(); edit(f); refuses(() => f.register('tree')) }
})

test('paste completion after owner change cannot be reauthenticated with a fresh context', async () => {
  const f = fixture(), receipt = f.register()
  const oldContext = f.context()
  const ticket = f.coordinator.capture(f.request(receipt), f.principal)
  let finish
  const saved = new Promise(resolve => { finish = resolve })
  f.state.epoch = 'epoch-b'
  finish('exact-late-save')
  const path = await saved
  refuses(() => f.coordinator.assert(ticket))
  refuses(() => f.coordinator.addSaved(ticket, path))
  refuses(() => f.coordinator.capture(f.request(receipt), f.principal))
  refuses(() => f.coordinator.capture({ draftId: receipt.draftId, ownerContext: oldContext }, f.principal))
})

test('revoke invalidation and closed window refuse outstanding paste tickets without touching issued paths', () => {
  for (const change of ['revoke', 'invalidate', 'close']) {
    const f = fixture(), receipt = f.register(), image = f.save(receipt)
    const session = f.start(receipt)
    f.coordinator.adopt(f.adoption(receipt, [image]), f.principal)
    if (change === 'revoke') f.coordinator.revoke(receipt.draftId)
    if (change === 'invalidate') f.coordinator.invalidateAll()
    if (change === 'close') f.state.closed = true
    refuses(() => f.coordinator.resolveIssued(f.adoption(receipt, [image]), f.principal))
    assert.deepEqual([...session.issued], ['exact-saver-result-a'])
  }
  const f = fixture(), receipt = f.register()
  const ticket = f.coordinator.capture(f.request(receipt), f.principal)
  f.coordinator.invalidateAll()
  refuses(() => f.coordinator.addSaved(ticket, 'late-exact-path'))
})

test('incarnation invalidation permits bounded fresh records but never reuses a minted session id', () => {
  const f = fixture({ maxDrafts: 1 })
  const first = f.register()
  refuses(() => f.register())
  f.coordinator.invalidateAll()
  const second = f.register()
  assert.notEqual(second.sessionId, first.sessionId)
  assert.notEqual(second.draftId, first.draftId)
  refuses(() => f.coordinator.capture(f.request(first), f.principal))
  f.coordinator.revoke(second.draftId)
  const third = f.register()
  assert.notEqual(third.sessionId, second.sessionId)
})

test('a guessed ready session without private start association cannot adopt', () => {
  const f = fixture(), receipt = f.register(), image = f.save(receipt)
  const session = f.installSession(receipt)
  refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
  refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal))
  assert.equal(session.issued.size, 0)
  assert.equal(f.state.bindCalls.length, 0)
})

test('start tickets are one-use and bind only the expected ready owner session', () => {
  const f = fixture(), receipt = f.register()
  refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: 'other' }), f.principal))
  const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal))
  f.installSession(receipt, { live: false })
  refuses(() => f.coordinator.bindStarted(ticket))
  f.state.sessions.get(receipt.sessionId).live = true
  f.coordinator.bindStarted(ticket)
  refuses(() => f.coordinator.bindStarted(ticket))
  refuses(() => f.coordinator.bindStarted({}))
})

test('retired replacement foreign owner and switch-pending session objects cannot acquire paths', () => {
  for (const edit of [
    row => { row.retired = true },
    row => { row.session = {} },
    row => { row.issued = new Set() },
    row => { row.window = {} },
    row => { row.productPrincipal = 'different-owner' },
    row => { row.switchPending = true },
  ]) {
    const f = fixture(), receipt = f.register(), image = f.save(receipt), row = f.start(receipt)
    const issued = row.issued
    edit(row)
    refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
    assert.equal(issued.size, 0)
    assert.equal(f.state.bindCalls.length, 0)
  }
})

test('missing account or unsupported provider refuses; explicit host default account is supported', () => {
  for (const metadata of [
    { threadId: 'actual-thread', provider: 'codex' },
    { threadId: 'actual-thread', provider: 'codex', account: '' },
    { threadId: 'actual-thread', provider: 'unresolved', account: null },
  ]) {
    const f = fixture(), receipt = f.register(), image = f.save(receipt), session = f.start(receipt)
    f.state.metadata.set(receipt.sessionId, metadata)
    refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
    assert.equal(session.issued.size, 0)
  }
})

test('conflicting transcript is never repointed and renderer-only mapping cannot grant association', () => {
  const f = fixture(), receipt = f.register(), image = f.save(receipt), session = f.start(receipt)
  const other = { computerId: 'other-computer', nodeId: 'other-node' }
  f.state.bindings.set(receipt.sessionId, other)
  refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
  assert.equal(f.state.bindings.get(receipt.sessionId), other)
  assert.equal(f.state.bindCalls.length, 0)
  assert.equal(session.issued.size, 0)
})

test('post-binding owner and session identity changes refuse before any capability issue', () => {
  for (const change of [
    f => { f.state.epoch = 'epoch-b' },
    f => { f.state.sessions.get(f.receipt.sessionId).session = {} },
    f => { f.state.bindings.set(f.receipt.sessionId, { computerId: 'other', nodeId: 'other' }) },
  ]) {
    const f = fixture(), receipt = f.register(), image = f.save(receipt), session = f.start(receipt)
    f.receipt = receipt
    f.state.afterBind = () => change(f)
    refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
    assert.equal(session.issued.size, 0)
  }
})

test('exact path order is retained and unknown duplicate or cross-draft image handles refuse atomically', () => {
  const f = fixture(), receipt = f.register()
  const images = [f.save(receipt, 'saved-first'), f.save(receipt, 'saved-second')]
  const session = f.start(receipt)
  const other = f.register(), otherImage = f.save(other, 'saved-other')
  for (const ids of [[images[0].imageId, 'unknown'], [images[0].imageId, images[0].imageId], [otherImage.imageId]]) {
    refuses(() => f.coordinator.adopt(f.request(receipt, { sessionId: receipt.sessionId, imageIds: ids }), f.principal))
    assert.equal(session.issued.size, 0)
  }
  f.coordinator.adopt(f.adoption(receipt, [...images].reverse()), f.principal)
  assert.deepEqual([...session.issued], ['saved-second', 'saved-first'])
  assert.deepEqual(f.coordinator.resolveIssued(f.adoption(receipt, images), f.principal), ['saved-first', 'saved-second'])
  f.state.metadata.get(receipt.sessionId).account = 'changed-account'
  refuses(() => f.coordinator.resolveIssued(f.adoption(receipt, images), f.principal))
})

test('saved draft identity changes invalidate tickets and do not create replacement tree nodes', () => {
  const f = fixture(), receipt = f.register('tree')
  const ticket = f.coordinator.capture(f.request(receipt), f.principal)
  f.state.graph.nodes[0].createdAt = 'recreated'
  refuses(() => f.coordinator.addSaved(ticket, 'saved-old-incarnation'))
  assert.equal(f.state.graph.nodes.length, 1)
  assert.equal(f.state.graph.nodes[0].id, receipt.conversationId)
})

test('proven pre-dispatch refusal releases reservation for retry but retires the old private ticket', () => {
  const f = fixture(), receipt = f.register(), image = f.save(receipt)
  const first = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  // Trusted caller knows host.startSession was never invoked; candidateCreated
  // describes a native/provider candidate, not an outer surface allocation.
  const released = f.coordinator.releaseStart(first, { disposition: 'not-started', candidateCreated: false, dispatchStarted: false })
  assert.equal(released.sessionId, receipt.sessionId)
  assert.equal(released.draftId, receipt.draftId)
  const second = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  const session = f.installSession(receipt)
  refuses(() => f.coordinator.bindStarted(first))
  f.coordinator.bindStarted(second)
  f.coordinator.adopt(f.adoption(receipt, [image]), f.principal)
  assert.deepEqual([...session.issued], ['exact-saver-result-a'])
})

test('unknown timeout dispatched or existing candidate outcomes never release a start ticket', () => {
  for (const outcome of [
    { disposition: 'unknown', candidateCreated: false, dispatchStarted: false },
    { disposition: 'timeout', candidateCreated: false, dispatchStarted: false },
    { disposition: 'not-started', candidateCreated: true, dispatchStarted: false },
    { disposition: 'not-started', candidateCreated: false, dispatchStarted: true },
    { disposition: 'not-started' },
  ]) {
    const f = fixture(), receipt = f.register()
    const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
    refuses(() => f.coordinator.releaseStart(ticket, outcome))
    refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal))
  }
  const f = fixture(), receipt = f.register()
  const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  f.installSession(receipt, { live: false })
  refuses(() => f.coordinator.releaseStart(ticket, { disposition: 'not-started', candidateCreated: false, dispatchStarted: false }))
  f.state.sessions.delete(receipt.sessionId)
  f.state.epoch = 'epoch-b'
  refuses(() => f.coordinator.releaseStart(ticket, { disposition: 'not-started', candidateCreated: false, dispatchStarted: false }))
})

test('standalone registration requires a canonical nonnegative safe org revision', () => {
  for (const revision of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const f = fixture()
    f.state.orgRevision = revision
    refuses(() => f.register())
  }
})

test('any canonical org revision change invalidates an existing grant even with unchanged seat fields', () => {
  const f = fixture(), receipt = f.register()
  const ticket = f.coordinator.capture(f.request(receipt), f.principal)
  f.state.orgRevision += 1
  refuses(() => f.coordinator.assert(ticket))
  refuses(() => f.coordinator.addSaved(ticket, 'late-path'))
  refuses(() => f.coordinator.capture(f.request(receipt), f.principal))
  refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal))
  const fresh = f.register()
  assert.notEqual(fresh.draftId, receipt.draftId)
  assert.notEqual(fresh.sessionId, receipt.sessionId)
  assert.equal(f.save(fresh).draftId, fresh.draftId)
})

test('external canonical seat remove and identical recreation cannot adopt old provenance', () => {
  const f = fixture(), receipt = f.register(), image = f.save(receipt), session = f.start(receipt)
  const sameFields = { ...f.state.seat }
  // No coordinator lifecycle hook runs between these two external store writes.
  f.state.seat = null
  f.state.orgRevision += 1
  f.state.seat = sameFields
  f.state.orgRevision += 1
  refuses(() => f.coordinator.adopt(f.adoption(receipt, [image]), f.principal))
  assert.equal(session.issued.size, 0)
  assert.equal(f.state.bindCalls.length, 0)
})

test('canonical computer identity changes invalidate saved tickets without translating the requested id', () => {
  const f = fixture(), receipt = f.register()
  const ticket = f.coordinator.capture(f.request(receipt), f.principal)
  f.state.computerId = 'different-canonical-computer'
  refuses(() => f.coordinator.assert(ticket))
  refuses(() => f.coordinator.addSaved(ticket, 'late-path'))
  refuses(() => f.register('standalone', { computerId: receipt.computerId }))
})

test('outer surface record removal after host invocation does not prove native nonlaunch', () => {
  const f = fixture(), receipt = f.register()
  const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  f.installSession(receipt, { live: false })
  // Simulate the outer surface catch deleting its record after host invocation.
  // Native outcome remains unknown. No provider is invoked by this fixture.
  f.state.sessions.delete(receipt.sessionId)
  const outcome = { disposition: 'unknown', candidateCreated: false, dispatchStarted: true }
  refuses(() => f.coordinator.releaseStart(ticket, outcome))
  refuses(() => f.coordinator.releaseStart(ticket, { code: 'GENERIC_START_FAILURE' }))
  refuses(() => f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal))
})

test('private pre-host assertion refuses epoch and org changes while start is pending', async () => {
  for (const change of [
    f => { f.state.epoch = 'epoch-b' },
    f => { f.state.orgRevision += 1 },
  ]) {
    const f = fixture(), receipt = f.register()
    const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
    f.installSession(receipt, { live: false })
    assert.equal(f.coordinator.assertStart(ticket), true)
    let resume
    const awaitingHost = new Promise(resolve => { resume = resolve })
    change(f)
    resume()
    await awaitingHost
    refuses(() => f.coordinator.assertStart(ticket))
  }
})

test('pre-host assertion requires a live private claim and never authorizes a retired ticket or ready successor', () => {
  const f = fixture(), receipt = f.register()
  refuses(() => f.coordinator.assertStart({}))
  const ticket = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  assert.equal(f.coordinator.assertStart(ticket), true)
  f.coordinator.releaseStart(ticket, { disposition: 'not-started', candidateCreated: false, dispatchStarted: false })
  refuses(() => f.coordinator.assertStart(ticket))
  const current = f.coordinator.authorizeStart(f.request(receipt, { sessionId: receipt.sessionId }), f.principal)
  f.installSession(receipt)
  refuses(() => f.coordinator.assertStart(current))
  f.coordinator.bindStarted(current)
  refuses(() => f.coordinator.assertStart(current))
})
