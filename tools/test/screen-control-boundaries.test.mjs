import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')
const { createScreenControlAdapter } = require('../../shell/screen-control-adapter.cjs')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(t, { audit = async () => {}, adapter, now, indicator, emit } = {}) {
  const owner = { isDestroyed: () => false }, other = { isDestroyed: () => false }
  const sessions = new Map(['a', 'b'].map(id => [id, { owner, ownerKind: 'window', agentId: id, state: 'running' }]))
  const role = { enabled: true, roleId: 'worker', revision: 1, functions: ['screen.control', 'screen.status'] }
  const policy = { level: 'unrestricted' }, effects = []
  const host = createScreenControlHost({ sessions, readBinding: () => role,
    permissionLevel: () => policy.level, audit, ...(now ? { now } : {}), ...(emit ? { emit } : {}),
    adapter: adapter || { supported: () => true, geometry: () => ({ displays: [] }), validate: input => ({ ...input }),
      execute: async input => { effects.push(input.action); return { status: 'completed', cleanupConfirmed: true } } },
    indicator: { release() {}, ...(indicator || { ready: async () => {}, show() {}, hide() {} }) } })
  t.after(() => host.close(owner))
  const principal = id => Object.freeze({ kind: 'agent-session', sessionId: id, agentId: id,
    roleId: role.roleId, expectedRoleRevision: role.revision })
  return { host, owner, other, sessions, role, policy, effects, principal }
}

test('screen acquire refuses mismatched principal identity without a native effect', async t => {
  for (const change of [{ kind: 'owner' }, { sessionId: 'missing' }, { agentId: 'other' },
    { roleId: 'other' }, { expectedRoleRevision: 2 }]) {
    const f = fixture(t)
    await f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a'] })
    assert.throws(() => f.host.control({ ...f.principal('a'), ...change }, { action: 'acquire' }))
    assert.equal(f.host.state(f.owner).holderSessionId, null)
    assert.deepEqual(f.effects, [])
  }
})

for (const action of ['acquire', 'release']) test(`Stop during ${action} audit refuses old ownership changes`, async t => {
  const entered = deferred(), resume = deferred()
  const f = fixture(t, { audit: async event => {
    if (event.event === `screen-control-${action}`) { entered.resolve(); await resume.promise }
  } })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  if (action === 'release') await f.host.control(f.principal('a'), { action: 'acquire' })
  const pending = f.host.control(f.principal('a'), { action })
  await entered.promise
  f.host.revokeAll(f.owner); resume.resolve()
  await assert.rejects(pending, { code: 'SCREEN_ACCESS_OFF' })
  assert.equal(f.host.state(f.owner).holderSessionId, null)
  assert.deepEqual(f.effects, [])
})

test('live session, owner, role and permission are refreshed at actual input admission', async t => {
  for (const change of ['ended', 'owner', 'agent', 'role', 'permission']) {
    const entered = deferred(), resume = deferred()
    const f = fixture(t, { audit: async event => {
      if (event.event === 'screen-action-intent') { entered.resolve(); await resume.promise }
    } })
    await f.host.grant(f.owner, { sessionIds: ['a'] })
    const pending = f.host.control(f.principal('a'), { action: 'click' })
    await entered.promise
    if (change === 'ended') f.sessions.get('a').ended = true
    if (change === 'owner') f.sessions.get('a').owner = f.other
    if (change === 'agent') f.sessions.get('a').agentId = 'replacement'
    if (change === 'role') f.role.revision += 1
    if (change === 'permission') f.policy.level = 'confined'
    resume.resolve()
    await assert.rejects(pending)
    assert.deepEqual(f.effects, [], `${change} must refuse before reaching the input adapter`)
  }
})

test('idle expiry cannot revoke an active management turn and starts after its completion', async t => {
  let clock = 0
  const entered = deferred(), resume = deferred()
  const f = fixture(t, { now: () => clock, audit: async event => {
    if (event.event === 'screen-control-acquire') { entered.resolve(); await resume.promise }
  } })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  const pending = f.host.control(f.principal('a'), { action: 'acquire' })
  await entered.promise; clock = 120000
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  assert.throws(() => f.host.control(f.principal('b'), { action: 'acquire' }), { code: 'SCREEN_BUSY' })
  resume.resolve(); await pending
  clock = 179999
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  clock = 180000
  assert.equal(f.host.status(f.principal('b')).state, 'ready')
  assert.equal(f.host.state(f.owner).grants.length, 2)
  assert.deepEqual(f.effects, [])
})

function captureAdapter(effects, capture = async value => value) {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }
  const thumbnail = { isEmpty: () => false, toPNG: () => Buffer.from('disposable screen fixture'), getSize: () => ({ width: 10, height: 10 }) }
  return createScreenControlAdapter({ platform: 'linux', environment: { DISPLAY: ':fixture', XDG_SESSION_TYPE: 'x11' },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
    desktopCapturer: { getSources: async () => { effects.push('capture-fixture'); return capture([{ display_id: '1', thumbnail }]) } },
    spawnProcess: () => { throw new Error('No native input may launch in this fixture.') } })
}

test('Stop during the completed-result audit withholds the captured image and ownership claim', async t => {
  const entered = deferred(), resume = deferred(), effects = []
  const f = fixture(t, { adapter: captureAdapter(effects), audit: async event => {
    if (event.event === 'screen-action-result' && event.status === 'completed') { entered.resolve(); await resume.promise }
  } })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  const pending = f.host.control(f.principal('a'), { action: 'screenshot' })
  await entered.promise
  f.host.revokeAll(f.owner); resume.resolve()
  await assert.rejects(pending, { code: 'SCREEN_ACTION_INTERRUPTED' })
  assert.deepEqual(effects, ['capture-fixture'])
  assert.equal(f.host.state(f.owner).holderSessionId, null)
})

test('a permission downgrade during capture refuses result disclosure at completion', async t => {
  const entered = deferred(), resume = deferred(), effects = []
  const f = fixture(t, { adapter: captureAdapter(effects, async value => { entered.resolve(); await resume.promise; return value }) })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  const pending = f.host.control(f.principal('a'), { action: 'screenshot' })
  await entered.promise
  f.policy.level = 'confined'; resume.resolve()
  await assert.rejects(pending, { code: 'SCREEN_ACCESS_CHANGED' })
  assert.deepEqual(effects, ['capture-fixture'])
  assert.equal(f.host.state(f.owner).grants.length, 0)
})

test('an in-flight grant refuses a replacement session with the same ID and role tuple', async t => {
  const entered = deferred(), resume = deferred()
  const f = fixture(t, { audit: async event => {
    if (event.event === 'screen-access-granted') { entered.resolve(); await resume.promise }
  } })
  const pending = f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a'] })
  await entered.promise
  f.sessions.set('a', { ...f.sessions.get('a') })
  resume.resolve()
  await assert.rejects(pending, { code: 'SCREEN_ACCESS_CHANGED' })
  assert.equal(f.host.state(f.owner).grants.length, 0)
  assert.deepEqual(f.effects, [])
})

test('ordinary state updates retain the same granted session instance', async t => {
  const f = fixture(t)
  await f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a'] })
  const session = f.sessions.get('a')
  session.state = 'busy'; session.turnsCompleted = 1
  await f.host.control(f.principal('a'), { action: 'acquire' })
  session.state = 'ready'
  await f.host.control(f.principal('a'), { action: 'click' })
  assert.equal(f.host.status(f.principal('a')).ownsControl, true)
  assert.deepEqual(f.effects, ['click'])
})

test('final indicator failure withholds the already captured image and ownership claim', async t => {
  let captured = false, finalIndicatorFailures = 0
  const effects = [], events = []
  const f = fixture(t, {
    adapter: captureAdapter(effects, async value => { captured = true; return value }),
    audit: async event => { events.push(event) },
    indicator: { ready: async () => {}, hide() {}, show(value) {
      if (captured && !value.action) {
        finalIndicatorFailures += 1
        throw new Error('The fixture indicator failed after capture completed.')
      }
    } },
  })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await assert.rejects(f.host.control(f.principal('a'), { action: 'screenshot' }), { code: 'SCREEN_ACTION_INTERRUPTED' })
  assert.equal(finalIndicatorFailures, 1)
  assert.ok(events.some(event => event.event === 'screen-action-result' && event.status === 'completed'))
  assert.deepEqual(effects, ['capture-fixture'])
  assert.equal(f.host.status(f.principal('a')).state, 'off')
})

test('revocation from final state publication withholds the completed result', async t => {
  let captured = false, revoked = false
  const effects = []
  const f = fixture(t, {
    adapter: captureAdapter(effects, async value => { captured = true; return value }),
    emit: (_owner, state) => {
      if (captured && !revoked && state.activeAgentId === null) {
        revoked = true
        f.host.revokeAll(f.owner)
      }
    },
  })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await assert.rejects(f.host.control(f.principal('a'), { action: 'screenshot' }), { code: 'SCREEN_ACTION_INTERRUPTED' })
  assert.equal(revoked, true)
  assert.deepEqual(effects, ['capture-fixture'])
  assert.equal(f.host.state(f.owner).holderSessionId, null)
})

test('final indicator revocation preserves the original rejected action error', async t => {
  const expected = Object.assign(new Error('Fixture capture failed.'), { code: 'FIXTURE_CAPTURE_FAILED' })
  let attempted = false
  const f = fixture(t, {
    adapter: captureAdapter([], async () => { attempted = true; throw expected }),
    indicator: { ready: async () => {}, hide() {}, show(value) {
      if (attempted && !value.action) throw new Error('Fixture cleanup indicator failed.')
    } },
  })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await assert.rejects(f.host.control(f.principal('a'), { action: 'screenshot' }), error => error === expected)
  assert.equal(f.host.status(f.principal('a')).state, 'off')
})

test('a queued release follows successful image admission and retains normal release semantics', async t => {
  const entered = deferred(), resume = deferred(), effects = [], order = []
  const f = fixture(t, {
    adapter: captureAdapter(effects, async value => { entered.resolve(); await resume.promise; return value }),
    audit: async event => { if (event.event === 'screen-control-release') order.push('release') },
  })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  const screenshot = f.host.control(f.principal('a'), { action: 'screenshot' }).then(result => {
    order.push('image')
    assert.ok(result.__mcpImage)
    assert.equal(result.control.ownsControl, true)
    return result
  })
  await entered.promise
  const release = f.host.control(f.principal('a'), { action: 'release' })
  resume.resolve()
  await screenshot
  const result = await release
  assert.equal(result.released, true)
  assert.equal(result.control.state, 'ready')
  assert.equal(result.control.ownsControl, false)
  assert.deepEqual(order, ['image', 'release'])
  assert.deepEqual(effects, ['capture-fixture'])
})

test('final publication revocation keeps completed input truthful and removes ownership', async t => {
  let completed = false, revoked = false, calls = 0
  const f = fixture(t, {
    adapter: { supported: () => true, geometry: () => ({}), validate: value => value,
      execute: async () => { calls++; completed = true; return { status: 'completed', action: 'click', cleanupConfirmed: true } } },
    emit: (_owner, state) => {
      if (completed && !revoked && state.activeAgentId === null) {
        revoked = true
        f.host.revokeAll(f.owner)
      }
    },
  })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  const result = await f.host.control(f.principal('a'), { action: 'click' })
  assert.equal(calls, 1)
  assert.equal(result.status, 'completed')
  assert.equal(result.control.ownsControl, false)
  assert.equal(result.control.state, 'off')
  assert.doesNotMatch(result.control.nextAction, /repeat|retry|release when finished/)
})
