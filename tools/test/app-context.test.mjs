import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAppContextReader, createAppNavigator } = require('../../shell/app-context.cjs')

test('context is current, bounded, owner-window scoped metadata, not private UI contents', () => {
  let route = '#/computers?secret=never-return-this'
  const owner = { isDestroyed: () => false, getURL: () => 'http://127.0.0.1:4601/' + route }
  const sessions = new Map([
    ['s1', { agentId: 'custom-helper', ownerKind: 'window', owner, state: 'ready', turnsCompleted: 2, text: 'private transcript' }],
    ['s2', { agentId: 'other-window-helper', ownerKind: 'window', owner: {}, text: 'other transcript' }],
  ])
  const reader = createAppContextReader({ sessions, now: () => 'test-time',
    readOrg: () => ({ ok: true, org: { revision: 5,
      agents: [{ id: 'custom-helper', displayName: 'Helper', role: 'custom-role', provider: 'local', enabled: true }],
      relationships: [{ from: 'controller', to: 'custom-helper', type: 'manages' }] },
      roles: [{ id: 'custom-role', name: 'Helper', functions: ['app.context'], requiresDirectUserAuthorization: true }] }) })
  const principal = { sessionId: 's1', agentId: 'custom-helper' }
  const read = reader.read(principal)
  assert.equal(read.route, '/computers')
  assert.equal(read.orgRevision, 5)
  assert.equal(read.observationsOnly, true)
  assert.deepEqual(read.sessions.map(row => row.sessionId), ['s1'])
  assert.doesNotMatch(JSON.stringify(read), /secret|private transcript|other transcript/)
  route = '#/settings'
  assert.equal(reader.read(principal).route, '/settings')
  route = '#/unrecognized?private'
  assert.equal(reader.read(principal).route, null)
  assert.throws(() => reader.read({ ...principal, agentId: 'someone-else' }), { code: 'APP_CONTEXT_OWNER_REQUIRED' })
  sessions.get('s1').ended = true
  assert.throws(() => reader.read(principal), { code: 'APP_CONTEXT_OWNER_REQUIRED' })
})

test('context never invents a healthy organisation or a local owner for a relay session', () => {
  const session = { agentId: 'a', ownerKind: 'relay', owner: {} }
  const reader = createAppContextReader({ sessions: new Map([['s', session]]), readOrg: () => ({ ok: false }) })
  assert.throws(() => reader.read({ sessionId: 's', agentId: 'a' }), { code: 'APP_CONTEXT_OWNER_REQUIRED' })
  session.ownerKind = 'window'
  session.owner = { isDestroyed: () => false, getURL: () => 'http://127.0.0.1/#/' }
  assert.throws(() => reader.read({ sessionId: 's', agentId: 'a' }), { code: 'APP_CONTEXT_ORG_UNAVAILABLE' })
})

test('navigation preserves an actionable refusal outside a direct user turn and does not navigate', () => {
  const owner = { isDestroyed: () => false }
  const sessions = new Map([['s', { agentId: 'a', ownerKind: 'window', owner }]])
  let direct = false
  const calls = []
  const navigate = createAppNavigator({ sessions,
    isDirectUserTurn: sessionId => sessionId === 's' && direct,
    navigate: (window, route) => { calls.push({ window, route }); return { ok: true, route } },
  })
  const principal = { sessionId: 's', agentId: 'a' }
  assert.throws(() => navigate(principal, { route: '/settings' }), {
    code: 'ACCESSIBILITY_DIRECT_REQUEST_REQUIRED',
    message: 'Screen navigation requires a direct user request in this local window.',
  })
  assert.deepEqual(calls, [])
  direct = true
  assert.deepEqual(navigate(principal, { route: '/research' }), { ok: true, route: '/research' })
  assert.deepEqual(calls, [{ window: owner, route: '/research' }])
})

test('navigation refuses missing, ended, mismatched, relay and destroyed owner sessions', () => {
  const owner = { isDestroyed: () => false }
  const session = { agentId: 'a', ownerKind: 'window', owner }
  const sessions = new Map([['s', session]])
  let directChecks = 0
  let navigations = 0
  const navigate = createAppNavigator({ sessions,
    isDirectUserTurn: () => { directChecks++; return true },
    navigate: () => { navigations++ },
  })
  const principal = { sessionId: 's', agentId: 'a' }
  const refused = value => assert.throws(() => navigate(value, { route: '/settings' }), { code: 'APP_CONTEXT_OWNER_REQUIRED' })
  refused({ ...principal, sessionId: 'missing' })
  refused({ ...principal, agentId: 'other' })
  session.ended = true
  refused(principal)
  session.ended = false
  session.ownerKind = 'relay'
  refused(principal)
  session.ownerKind = 'window'
  owner.isDestroyed = () => true
  refused(principal)
  assert.equal(directChecks, 0)
  assert.equal(navigations, 0)
})


test('context preserves bounded provider turn statuses without inferring session health', () => {
  const fixture = movedTreeFixture()
  const session = fixture.sessions.get('child-session')
  for (const status of ['completed', 'success', 'failed', 'error', 'interrupted', 'turn_failed', 'A'.repeat(64)]) {
    session.lastTurnStatus = status
    const row = fixture.reader.read(fixture.principal).sessions[0]
    assert.equal(row.lastTurnStatus, status)
    assert.equal(row.state, 'ready', 'provider outcome must not rewrite session liveness')
  }
})

test('context omits provider diagnostics and malformed turn statuses from metadata', () => {
  const fixture = movedTreeFixture()
  const session = fixture.sessions.get('child-session')
  const diagnostic = 'failed: private provider diagnostic /private/account-data'
  for (const status of [diagnostic, 'failed\\nprivate provider diagnostic', 'A'.repeat(65),
    { detail: diagnostic }, [diagnostic], 7, true, '', null, undefined]) {
    session.lastTurnStatus = status
    const context = fixture.reader.read(fixture.principal)
    assert.equal(context.sessions[0].lastTurnStatus, null, 'unavailable bounded status stays unknown')
    assert.doesNotMatch(JSON.stringify(context), /private provider diagnostic|account-data/)
  }
})

function movedTreeFixture() {
  const owner = { isDestroyed: () => false, getURL: () => 'http://127.0.0.1/#/computers' }
  const sessions = new Map([['child-session', { agentId: 'child', ownerKind: 'window', owner, state: 'ready' }]])
  let ancestry = ['root', 'old-parent', 'child']
  const reads = []
  const reader = createAppContextReader({ sessions,
    readOrg: () => ({ ok: true, org: { revision: 1,
      agents: [{ id: 'child', displayName: 'Child', role: 'builder', enabled: true }],
      relationships: [{ from: 'old-parent', to: 'child', type: 'manages' }] }, roles: [] }),
    readTree: sessionId => {
      reads.push(sessionId)
      return { sessionId, nodeId: 'child', treeId: 'root', treeAnchors: [...ancestry],
        cwd: 'private-workspace', permissionSession: 'private-permission', threadId: 'private-thread' }
    },
  })
  return { reader, sessions, reads, owner, move: next => { ancestry = next },
    principal: { sessionId: 'child-session', agentId: 'child' } }
}

test('context follows host ancestry after a manual move without mistaking the declared org for messaging topology', () => {
  const fixture = movedTreeFixture()
  const before = fixture.reader.read(fixture.principal)
  assert.equal(before.relationshipSource, 'declared-organisation')
  assert.equal(before.sessions[0].tree.parentNodeId, 'old-parent')
  fixture.move(['root', 'new-parent', 'child'])
  const after = fixture.reader.read(fixture.principal)
  assert.deepEqual(after.sessions[0].tree, {
    source: 'host-session-ancestry', nodeId: 'child', treeId: 'root',
    parentNodeId: 'new-parent', treeAnchors: ['root', 'new-parent', 'child'],
  })
  assert.deepEqual(after.relationships, [{ from: 'old-parent', to: 'child', type: 'manages' }])
  assert.equal(after.sessions[0].sessionId, 'child-session')
  assert.doesNotMatch(JSON.stringify(after), /private-workspace|private-permission|private-thread/)
  assert.match(after.limitations, /local_roster/)
})

test('context exposes no invented parent when host ancestry is unavailable or invalid', () => {
  const fixture = movedTreeFixture()
  for (const anchors of [[], ['other-root', 'child'], ['root', 'wrong-child'], ['root', 'child', 'root', 'child']]) {
    fixture.move(anchors)
    assert.equal(fixture.reader.read(fixture.principal).sessions[0].tree, null)
  }
  const reader = createAppContextReader({ sessions: fixture.sessions,
    readOrg: () => ({ ok: true, org: { agents: [], relationships: [] }, roles: [] }),
    readTree: () => { throw Object.assign(new Error('not registered'), { code: 'AGENT_TREE_PARENT_UNAVAILABLE' }) },
  })
  assert.equal(reader.read(fixture.principal).sessions[0].tree, null)
})

test('tree context reads only live same-window sessions and rejects a different session identity', () => {
  const fixture = movedTreeFixture()
  fixture.sessions.set('ended', { agentId: 'ended', ownerKind: 'window', owner: fixture.owner, ended: true })
  fixture.sessions.set('other-window', { agentId: 'other', ownerKind: 'window', owner: {} })
  const result = fixture.reader.read(fixture.principal)
  assert.deepEqual(fixture.reads, ['child-session'])
  assert.equal(result.sessions.find(row => row.sessionId === 'ended').tree, null)
  assert.equal(result.sessions.some(row => row.sessionId === 'other-window'), false)
  const reader = createAppContextReader({ sessions: fixture.sessions,
    readOrg: () => ({ ok: true, org: { agents: [], relationships: [] }, roles: [] }),
    readTree: () => ({ sessionId: 'different', nodeId: 'child', treeId: 'root', treeAnchors: ['root', 'child'] }),
  })
  assert.equal(reader.read(fixture.principal).sessions[0].tree, null)
})
