import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createTreeLifecycleAuthority } = createRequire(import.meta.url)('../../shell/tree-lifecycle-authority.cjs')
const refused = fn => assert.throws(fn, { code: 'TREE_DELEGATION_REFUSED' })
// Production treeAnchorsFor returns node ancestry, without a tree sentinel.
// Before the fix, both actual root cases below failed TREE_DELEGATION_REFUSED
// at snapshot's length >= 2 condition, despite successful spawn/stop.
for (const action of ['resume-node', 'fresh-start-existing-node']) {
  for (const nested of [false, true]) {
    test(`${action}: actual ${nested ? 'Worker -> Worker2' : 'Controller -> Worker'} node-only ancestry`, () => {
      const f = fixture(action)
      const anchors = nested ? ['controller', 'parent'] : ['parent']
      f.parent.treeId = f.target.treeId = f.spec.treeId = anchors[0]
      f.parent.treeAnchors = anchors
      f.target.treeAnchors = f.submission.requestKeys.treeAnchors = [...anchors, 'child']
      const issued = f.issue()
      assert.equal(f.authority.assertBeforeClose(issued.token), true)
      assert.equal(f.redeem(issued.token).assertStart('standard'), true)
    })
  }
}
test('node-only ancestry still refuses empty roots, another tree, siblings and self replacement', () => {
  for (const mutate of [
    f => { f.parent.treeAnchors = [] },
    f => { f.target.treeId = 'other'; f.target.treeAnchors = ['other', 'child'] },
    f => { f.parent.treeId = 'controller'; f.parent.treeAnchors = ['controller', 'parent'];
      f.target.treeId = 'controller'; f.target.treeAnchors = ['controller', 'sibling', 'child'] },
    f => { f.target.nodeId = f.spec.nodeId = 'parent'; f.target.treeAnchors = ['parent'] },
  ]) {
    const f = fixture()
    f.parent.treeId = f.target.treeId = f.spec.treeId = 'parent'
    f.parent.treeAnchors = ['parent']; f.target.treeAnchors = ['parent', 'child']
    mutate(f); refused(f.issue)
  }
})
function fixture(action = 'resume-node') {
  let time = 0, serial = 0
  const scope = { origin: 'local', tier: 'confined', profile: 'workspace' }
  const f = {
    parent: { sessionId: 'parent-session', nodeId: 'parent', owner: 'owner', treeId: 'tree', cwd: '/workspace',
      treeAnchors: ['tree', 'parent'], workspaceRoots: ['/workspace'], permissionSession: scope },
    target: { sessionId: 'old-session', nodeId: 'child', owner: 'owner', treeId: 'tree', cwd: '/workspace',
      treeAnchors: ['tree', 'parent', 'middle', 'child'], workspaceRoots: ['/workspace'], permissionSession: scope,
      modelTier: 'claude-sonnet', roleId: 'worker', threadId: 'provider-thread' },
    spec: { action, nodeId: 'child', expectedSessionId: 'old-session', treeId: 'tree' },
    submission: { sessionId: 'new-session', cwd: '/workspace', tier: 'claude-sonnet', role: { id: 'worker' },
      requestKeys: { threadId: 'child', treeAnchors: ['tree', 'parent', 'middle', 'child'] },
      ...(action === 'resume-node' ? { resumeThreadId: 'provider-thread' } : {}) },
    advance(n) { time += n },
  }
  f.authority = createTreeLifecycleAuthority({ ttlMs: 100, now: () => { f.onClock?.(); return time },
    randomId: () => { f.onRandom?.(); return `token-${++serial}` },
    readParent: id => { assert.equal(id, 'parent-session'); f.onParent?.(); return f.parent },
    readNode: (id, owner) => { assert.equal(id, 'child'); assert.equal(owner, 'owner'); f.onNode?.(); return f.target } })
  f.issue = () => f.authority.issue('parent-session', 'owner', f.spec)
  f.redeem = token => f.authority.redeem(token, f.submission, 'owner')
  return f
}
for (const action of ['resume-node', 'fresh-start-existing-node']) {
  test(`${action}: grandchild exact authority survives stop, yields frozen one-use permit`, () => {
    const f = fixture(action), issued = f.issue()
    assert.ok(Object.isFrozen(issued.target.workspaceRoots))
    assert.ok(Object.isFrozen(issued.parent.permissionSession))
    assert.equal(f.authority.assertBeforeClose(issued.token), true)
    const permit = f.redeem(issued.token)
    assert.equal(permit.assertBeforeClose(), true)
    assert.equal(permit.assertStart('standard'), true)
    assert.equal(permit.assertStart('standard'), true)
    refused(() => f.redeem(issued.token))
    refused(() => f.authority.assertBeforeClose(issued.token))
    refused(() => permit.assertStart('full'))
    permit.cancel()
    refused(() => permit.assertBeforeClose())
    refused(() => permit.assertStart('standard'))
  })
}
const mutations = {
  'stopped parent': f => { f.parent = null },
  'unknown target': f => { f.target = null },
  'same-content admission replacement': f => { f.target = structuredClone(f.target) },
  'replaced target session': f => { f.target.sessionId = 'replacement' },
  'other owner': f => { f.target.owner = 'other' },
  'parent other owner': f => { f.parent.owner = 'other' },
  'parent Full': f => { f.parent.permissionSession = { origin: 'local', tier: 'full' } },
  'target Full': f => { f.target.permissionSession = { origin: 'local', tier: 'full' } },
  'parent Guided': f => { f.parent.permissionSession = { origin: 'local', tier: 'confined', profile: 'read-only' } },
  'remote target': f => { f.target.permissionSession = { ...f.target.permissionSession, origin: 'remote' } },
  'wider target roots': f => { f.target.workspaceRoots = ['/workspace', '/outside'] },
  'narrower target roots': f => { f.target.workspaceRoots = ['/workspace/sub'] },
  'wider parent roots': f => { f.parent.workspaceRoots = ['/'] },
  'both roots drift': f => { f.parent.workspaceRoots = f.target.workspaceRoots = ['/other'] },
  'cwd drift': f => { f.target.cwd = '/outside' },
  'model drift': f => { f.target.modelTier = 'codex' },
  'role drift': f => { f.target.roleId = 'controller' },
  'provider thread drift': f => { f.target.threadId = 'different-thread' },
  'reparent': f => { f.target.treeAnchors = ['tree', 'other', 'child'] },
  'sparse anchors': f => { delete f.target.treeAnchors[2]; f.target.treeAnchors.extra = 'middle' },
  'sparse roots': f => { f.target.workspaceRoots.length = 2; f.target.workspaceRoots.extra = '/outside' },
  'cyclic anchors': f => { f.target.treeAnchors = ['tree', 'parent', 'parent', 'child'] },
}
for (const [name, mutate] of Object.entries(mutations)) {
  test(`${name}: preclose, redemption and final root all refuse`, () => {
    for (const stage of ['preclose', 'redeem', 'start']) {
      const f = fixture(), { token } = f.issue()
      const permit = stage === 'start' ? f.redeem(token) : null
      mutate(f)
      refused(() => stage === 'preclose' ? f.authority.assertBeforeClose(token)
        : stage === 'redeem' ? f.redeem(token) : permit.assertStart('standard'))
    }
  })
}
for (const [name, mutate] of Object.entries({
  model: s => { s.tier = 'codex' }, role: s => { s.role.id = 'controller' },
  workspace: s => { s.cwd = '/outside' }, node: s => { s.requestKeys.threadId = 'other' },
  anchors: s => { s.requestKeys.treeAnchors = ['tree', 'parent', 'child'] },
  'native thread': s => { s.resumeThreadId = 'other' },
  'missing native thread': s => { delete s.resumeThreadId },
  'same session': s => { s.sessionId = 'old-session' },
  'sparse anchors': s => { delete s.requestKeys.treeAnchors[2] },
})) test(`forged submission ${name} burns token`, () => {
  const f = fixture(), { token } = f.issue(), saved = structuredClone(f.submission)
  mutate(f.submission)
  refused(() => f.redeem(token))
  f.submission = saved
  refused(() => f.redeem(token))
})
test('wrong owner burns token; unknown and forged tokens refuse', () => {
  const f = fixture(), { token } = f.issue()
  refused(() => f.authority.redeem(token, f.submission, 'other'))
  refused(() => f.redeem(token))
  refused(() => f.redeem('forged'))
})
test('restart refuses any resume field, including null', () => {
  for (const value of [null, '', 'provider-thread']) {
    const f = fixture('fresh-start-existing-node'), { token } = f.issue()
    f.submission.resumeThreadId = value
    refused(() => f.redeem(token))
  }
})
test('issue validates expected identity, strict descent, operation and resumable thread', () => {
  for (const mutate of [
    f => { delete f.spec.expectedSessionId }, f => { f.spec.expectedSessionId = 'wrong' },
    f => { f.spec.action = 'restart-node' }, f => { f.spec.treeId = 'other' },
    f => { f.target.threadId = null },
    f => { f.target.treeAnchors = ['tree', 'child'] },
    f => { f.target.nodeId = 'parent'; f.target.treeAnchors = ['tree', 'parent']; f.spec.nodeId = 'parent' },
  ]) { const f = fixture(); mutate(f); refused(f.issue) }
})
test('expiry at boundary refuses preclose, redemption and retained permit', () => {
  for (const stage of ['preclose', 'redeem', 'start']) {
    const f = fixture(), { token } = f.issue(), permit = stage === 'start' ? f.redeem(token) : null
    f.advance(100)
    refused(() => stage === 'preclose' ? f.authority.assertBeforeClose(token)
      : stage === 'redeem' ? f.redeem(token) : permit.assertStart('standard'))
  }
})
test('expiry and cancel during trusted callbacks refuse', () => {
  const f = fixture(), { token } = f.issue(), permit = f.redeem(token)
  f.onNode = () => permit.cancel()
  refused(() => permit.assertStart('standard'))
  const g = fixture(), grant = g.issue()
  g.onParent = () => g.advance(100)
  refused(() => g.redeem(grant.token))
})
test('reentrant read/clock callbacks cannot redeem twice or use nested preclose', () => {
  for (const hook of ['onParent', 'onNode', 'onClock']) {
    const f = fixture(), { token } = f.issue()
    f[hook] = () => { refused(() => f.redeem(token)); refused(() => f.authority.assertBeforeClose(token)) }
    const permit = f.redeem(token)
    assert.equal(permit.assertStart('standard'), true)
  }
})
test('throwing, asynchronous and malformed trusted readers refuse', () => {
  for (const kind of ['throws', 'promise', 'missing']) {
    const f = fixture()
    if (kind === 'throws') f.onParent = () => { throw new Error('reader unavailable') }
    else f.parent = kind === 'promise' ? Promise.resolve(f.parent) : {}
    refused(f.issue)
  }
})
test('expired pending grants and consumed grants cannot become valid on repeated entropy', () => {
  const f = fixture()
  let time = 0
  const authority = createTreeLifecycleAuthority({ readParent: () => f.parent, readNode: () => f.target,
    ttlMs: 100, now: () => time, randomId: () => 'same-entropy' })
  const issue = () => authority.issue('parent-session', 'owner', f.spec)
  const first = issue()
  authority.redeem(first.token, f.submission, 'owner').cancel()
  const second = issue()
  assert.notEqual(first.token, second.token)
  refused(() => authority.redeem(first.token, f.submission, 'owner'))
  time = 100
  const third = issue()
  refused(() => authority.assertBeforeClose(second.token))
  assert.equal(authority.assertBeforeClose(third.token), true)
})
test('clock regression, malformed clock and authority drift during randomness fail closed', () => {
  const f = fixture(), { token } = f.issue()
  f.advance(-1)
  refused(() => f.redeem(token))
  const g = fixture()
  g.advance(Number.NaN)
  refused(g.issue)
  const h = fixture()
  h.onRandom = () => { h.parent.cwd = '/changed'; refused(h.issue) }
  refused(h.issue)
})
test('mutation of returned snapshots cannot widen retained authority', () => {
  const f = fixture(), grant = f.issue()
  assert.throws(() => { grant.target.cwd = '/outside' }, TypeError)
  assert.throws(() => { grant.target.treeAnchors.push('other') }, TypeError)
  assert.throws(() => { grant.parent.permissionSession.tier = 'full' }, TypeError)
  assert.equal(f.redeem(grant.token).assertStart('standard'), true)
})
test('one target reservation excludes second lifecycle and ordinary owner start before and after redemption', () => {
  const f = fixture()
  assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
  const grant = f.issue()
  refused(f.issue)
  refused(() => f.authority.assertUnreserved('child', 'owner'))
  assert.equal(f.authority.assertUnreserved('other-node', 'owner'), true)
  assert.equal(f.authority.assertUnreserved('child', 'other-owner'), true)
  const permit = f.redeem(grant.token)
  refused(f.issue)
  refused(() => f.authority.assertUnreserved('child', 'owner'))
  permit.cancel()
  assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
  const next = f.issue()
  permit.cancel() // An old permit must never release the replacement lease.
  refused(() => f.authority.assertUnreserved('child', 'owner'))
  assert.equal(f.authority.assertBeforeClose(next.token), true)
})
test('explicit pending-token cancellation releases target and invalidates token', () => {
  const f = fixture(), grant = f.issue()
  f.authority.cancel('unknown')
  refused(f.issue)
  f.authority.cancel(grant.token)
  f.authority.cancel(grant.token)
  refused(() => f.redeem(grant.token))
  assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
  assert.ok(f.issue().token)
})
test('expiry sweeps redeemed and pending reservations; old permit cannot revive or cancel new lease', () => {
  for (const redeemed of [false, true]) {
    const f = fixture(), grant = f.issue(), permit = redeemed ? f.redeem(grant.token) : null
    f.advance(100)
    assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
    const next = f.issue()
    if (permit) { refused(() => permit.assertStart('standard')); permit.cancel() }
    f.authority.cancel(grant.token)
    refused(() => f.authority.assertUnreserved('child', 'owner'))
    assert.equal(f.authority.assertBeforeClose(next.token), true)
  }
})
test('failed redemption burns token and frees reservation with no stuck target', () => {
  const f = fixture(), grant = f.issue()
  f.submission.tier = 'wrong'
  refused(() => f.redeem(grant.token))
  assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
  assert.ok(f.issue().token)
})
test('pending cancel during preclose callback refuses and frees reservation', () => {
  const f = fixture(), grant = f.issue()
  f.onParent = () => f.authority.cancel(grant.token)
  refused(() => f.authority.assertBeforeClose(grant.token))
  assert.equal(f.authority.assertUnreserved('child', 'owner'), true)
})
