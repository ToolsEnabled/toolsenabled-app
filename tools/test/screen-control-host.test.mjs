import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
const require = createRequire(import.meta.url)
const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')
const { createScreenControlAdapter } = require('../../shell/screen-control-adapter.cjs')

function fixture(overrides = {}) {
  const owner = { isDestroyed: () => false }, other = { isDestroyed: () => false }
  const sessions = new Map(['a', 'b'].map(id => [id, { owner, ownerKind: 'window', agentId: id, state: 'running' }]))
  const role = { enabled: true, roleId: 'worker', revision: 1, functions: null }
  const events = [], performed = []
  const host = createScreenControlHost({ sessions, readBinding: () => role, permissionLevel: () => 'unrestricted',
    adapter: { supported: () => true, geometry: () => ({ displays: [] }), validate: input => ({ ...input }),
      execute: async input => { performed.push(input); return { status: 'completed', cleanupConfirmed: true } } },
    indicator: { ready: async () => {}, show() {}, hide() {}, release() {} }, audit: async event => events.push(event), ...overrides })
  const principal = id => ({ kind: 'agent-session', sessionId: id, agentId: id, roleId: role.roleId, expectedRoleRevision: role.revision })
  return { host, owner, other, sessions, role, events, performed, principal }
}
test('grants bind live sessions; agent arguments cannot enable, change owner or retain an old role', async () => {
  const f = fixture()
  assert.equal(f.host.status(f.principal('a')).enabled, false)
  assert.throws(() => f.host.control(f.principal('a'), { action: 'click' }), { code: 'SCREEN_ACCESS_OFF' })
  await assert.rejects(f.host.grant(f.other, { sessionIds: ['a'] }), { code: 'SCREEN_AGENT_UNAVAILABLE' })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  assert.equal(f.host.status(f.principal('a')).enabled, true)
  assert.equal(f.host.state(f.other).grants.length, 0)
  f.host.revoke(f.other, { sessionIds: ['a'] })
  assert.equal(f.host.state(f.owner).grants.length, 2)
  const old = f.principal('a'); f.role.revision++
  assert.throws(() => f.host.control(old, { action: 'click' }), { code: 'SCREEN_ACCESS_CHANGED' })
  assert.equal(f.host.state(f.owner).grants.length, 1)
  f.host.close(f.owner)
  assert.equal(f.host.state(f.owner).grants.length, 0)
})
test('screen actions serialize within the controlling turn and revocation prevents queued input', async () => {
  let release, started
  const began = new Promise(resolve => { started = resolve })
  const performed = []
  const f = fixture({ adapter: { supported: () => true, geometry: () => ({}), validate: input => input,
    execute: async (input, signal) => { performed.push(input.action); started(); await new Promise(resolve => { release = resolve }); assert.equal(signal.aborted, true); return { status: 'completed', cleanupConfirmed: true } } } })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  const first = f.host.control(f.principal('a'), { action: 'move' })
  assert.throws(() => f.host.control(f.principal('b'), { action: 'click' }), { code: 'SCREEN_BUSY' })
  const second = f.host.control(f.principal('a'), { action: 'click' })
  await began
  f.host.revokeAll(f.owner); release()
  await assert.rejects(first, { code: 'SCREEN_ACTION_INTERRUPTED' })
  await assert.rejects(second, { code: 'SCREEN_ACCESS_OFF' })
  assert.deepEqual(performed, ['move'])
})
test('stop wins over an in-flight grant and audit failure cannot enable control', async () => {
  let release
  const f = fixture({ audit: () => new Promise(resolve => { release = resolve }) })
  const pending = f.host.grant(f.owner, { sessionIds: ['a'] })
  await Promise.resolve()
  f.host.revokeAll(f.owner); release()
  await assert.rejects(pending, { code: 'SCREEN_ACCESS_CHANGED' })
  assert.equal(f.host.state(f.owner).grants.length, 0)
  const broken = fixture({ audit: async () => { throw new Error('disk unavailable') } })
  await assert.rejects(broken.host.grant(broken.owner, { sessionIds: ['a'] }), /disk unavailable/)
  assert.equal(broken.host.state(broken.owner).grants.length, 0)
})

for (const action of ['click']) {
  test(`Stop during the completion audit preserves the completed ${action} and reports access off`, { timeout: 5000 }, async () => {
    let entered, finish
    const started = new Promise(resolve => { entered = resolve })
    const auditGate = new Promise(resolve => { finish = resolve })
    const image = Buffer.from('completed-screenshot')
    const completed = { status: 'completed', action, cleanupConfirmed: true }
    if (action === 'screenshot') Object.defineProperty(completed, '__mcpImage', { value: image })
    const imageDescriptor = Object.getOwnPropertyDescriptor(completed, '__mcpImage')
    let calls = 0
    const events = []
    const f = fixture({
      adapter: { supported: () => true, geometry: () => ({}), validate: input => input,
        execute: async () => { calls++; return completed } },
      audit: async event => {
        events.push(event)
        if (event.event === 'screen-action-result' && event.status === 'completed') { entered(); await auditGate }
      },
    })
    try {
      await f.host.grant(f.owner, { sessionIds: ['a'] })
      const pending = f.host.control(f.principal('a'), { action })
      await started
      assert.equal(f.host.state(f.owner).holderSessionId, 'a')
      f.host.revokeAll(f.owner)
      assert.equal(f.host.state(f.owner).holderSessionId, null)
      assert.deepEqual(f.host.state(f.owner).grants, [])
      finish()
      const result = await pending
      assert.equal(result, completed)
      assert.equal(result.status, 'completed')
      assert.equal(result.action, action)
      assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__mcpImage'), imageDescriptor)
      assert.equal(result.control.ownsControl, false)
      assert.equal(result.control.enabled, false)
      assert.equal(result.control.state, 'off')
      assert.equal(result.control.reason, 'SCREEN_ACCESS_OFF')
      assert.match(result.control.nextAction, /Ask the person to enable Computer control/)
      assert.doesNotMatch(result.control.nextAction, /repeat|retry|release when finished/)
      assert.equal(calls, 1)
      assert.deepEqual(events.filter(event => event.event === 'screen-action-result').map(event => event.status), ['completed'])
      assert.throws(() => f.host.control(f.principal('a'), { action: 'click' }), { code: 'SCREEN_ACCESS_OFF' })
      assert.equal(calls, 1)
    } finally { finish(); f.host.close(f.owner) }
  })
}

test('a later explicit allowed set supersedes an older grant waiting for audit', async () => {
  let releaseOlder
  const f = fixture({ audit: async event => {
    if (event.event === 'screen-access-granted' && event.sessionIds[0] === 'a') {
      await new Promise(resolve => { releaseOlder = resolve })
    }
  } })
  const older = f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a'] })
    .then(value => ({ value }), error => ({ code: error.code }))
  await Promise.resolve()
  assert.equal(typeof releaseOlder, 'function')
  const newer = await f.host.grant(f.owner, { mode: 'selected', sessionIds: ['b'] })
  assert.deepEqual(newer.grants.map(grant => grant.sessionId), ['b'])
  releaseOlder()
  const olderResult = await older
  assert.deepEqual(f.host.state(f.owner).grants.map(grant => grant.sessionId), ['b'],
    'the old surface must not replace the newer allowed set after its audit finishes')
  assert.deepEqual(olderResult, { code: 'SCREEN_ACCESS_CHANGED' })
  /* 'b' holds the newer allowed set, so control is plainly ON and 'a' simply is
     not who it was granted to. This used to answer SCREEN_ACCESS_OFF, which told
     the person to enable a permission already enabled -- the round trip behind
     the owner's "its on" of 2026-09-15. The supersession under test is
     unchanged; only the sentence 'a' is given is. */
  assert.throws(() => f.host.control(f.principal('a'), { action: 'click' }), { code: 'SCREEN_ACCESS_NOT_THIS_SESSION' })
  await f.host.control(f.principal('b'), { action: 'click' })
  f.host.revokeAll(f.owner)
})
test('concurrent legacy additive grants remain additive', async () => {
  let releaseOlder
  const f = fixture({ audit: async event => {
    if (event.event === 'screen-access-granted' && event.sessionIds[0] === 'a') {
      await new Promise(resolve => { releaseOlder = resolve })
    }
  } })
  const older = f.host.grant(f.owner, { sessionIds: ['a'] })
  await Promise.resolve()
  await f.host.grant(f.owner, { sessionIds: ['b'] })
  releaseOlder()
  await older
  assert.deepEqual(f.host.state(f.owner).grants.map(grant => grant.sessionId).sort(), ['a', 'b'])
  f.host.revokeAll(f.owner)
})
test('an explicit grant in another window does not supersede this window intent', async () => {
  let releaseOlder
  const f = fixture({ audit: async event => {
    if (event.event === 'screen-access-granted' && event.sessionIds[0] === 'a') {
      await new Promise(resolve => { releaseOlder = resolve })
    }
  } })
  f.sessions.set('c', { owner: f.other, ownerKind: 'window', agentId: 'c', state: 'running' })
  const older = f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a'] })
  await Promise.resolve()
  await f.host.grant(f.other, { mode: 'selected', sessionIds: ['c'] })
  releaseOlder()
  await older
  assert.deepEqual(f.host.state(f.owner).grants.map(grant => grant.sessionId), ['a'])
  assert.deepEqual(f.host.state(f.other).grants.map(grant => grant.sessionId), ['c'])
  f.host.revokeAll()
})
test('coordinate validation accounts for negative monitors and Windows DPI', () => {
  const screen = { getAllDisplays: () => [{ id: 1, bounds: { x: -1000, y: 0, width: 1000, height: 800 }, scaleFactor: 2 }],
    dipToScreenPoint: ({ x, y }) => ({ x: x * 2, y: y * 2 }) }
  const adapter = createScreenControlAdapter({ screen, platform: 'win32' })
  assert.deepEqual(adapter.validate({ action: 'move', x: -100, y: 30 }), { action: 'move', x: -200, y: 60 })
  for (const value of [NaN, Infinity, -1001, 0]) assert.throws(() => adapter.validate({ action: 'click', x: value, y: 30 }), { code: 'SCREEN_COORDINATES_INVALID' })
  assert.throws(() => adapter.validate({ action: 'type', text: 'ok', command: 'ignored' }), { code: 'SCREEN_ACTION_INVALID' })
  assert.equal(createScreenControlAdapter({ screen, platform: 'linux', environment: { DISPLAY: ':99', XDG_SESSION_TYPE: 'wayland' } }).supported(), false)
  assert.equal(createScreenControlAdapter({ screen, platform: 'linux', environment: { DISPLAY: ':99', XDG_SESSION_TYPE: 'x11' } }).supported(), true)
})

test('an unavailable visible indicator revokes every grant and prevents input', async () => {
  let broken = false
  const f = fixture({ indicator: { ready: async () => {}, show() { if (broken) throw new Error('indicator closed') }, hide() {}, release() {} } })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  broken = true
  await assert.rejects(f.host.control(f.principal('a'), { action: 'move' }), /indicator closed/)
  assert.equal(f.host.state(f.owner).grants.length, 0)
  assert.equal(f.host.state(f.owner).activeAgentId, null)
  assert.equal(f.performed.length, 0)
})

test('coordinates are revalidated after queued work and audit admission', async () => {
  let valid = true
  const performed = []
  const f = fixture({ adapter: { supported: () => true, validate(input) { if (!valid) throw new Error('monitor removed'); return input },
    execute: async input => performed.push(input) },
    audit: async event => { if (event.event === 'screen-action-intent') valid = false } })
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await assert.rejects(f.host.control(f.principal('a'), { action: 'move' }), /monitor removed/)
  assert.equal(performed.length, 0)
})

test('native cancellation waits for the input process and its release helper to exit', async () => {
  const children = []
  const adapter = createScreenControlAdapter({ platform: 'linux', environment: { DISPLAY: ':test' },
    spawnProcess: () => {
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.kill = () => { child.killed = true }
      children.push(child); return child
    } })
  const controller = new AbortController()
  let finished = false
  const pending = adapter.execute({ action: 'drag', x: 1, y: 2, toX: 3, toY: 4 }, controller.signal)
  const checked = assert.rejects(pending, { code: 'SCREEN_ACTION_INTERRUPTED' }).then(() => { finished = true })
  children[0].emit('spawn')
  controller.abort()
  await Promise.resolve()
  assert.equal(children[0].killed, true); assert.equal(children.length, 1); assert.equal(finished, false)
  children[0].emit('close', 1)
  assert.equal(children.length, 2)
  await Promise.resolve(); assert.equal(finished, false)
  children[1].stdout.write('{"ok":true}'); children[1].emit('close', 0)
  await checked
})

test('failed native input cleanup cancels queued input and revokes every allowed agent', async () => {
  const f = fixture({ adapter: { supported: () => true, validate: input => input,
    execute: async () => { throw Object.assign(new Error('release failed'), { code: 'SCREEN_INPUT_RELEASE_FAILED' }) } } })
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  const first = f.host.control(f.principal('a'), { action: 'drag' })
  const second = f.host.control(f.principal('a'), { action: 'click' })
  await assert.rejects(first, { code: 'SCREEN_INPUT_RELEASE_FAILED' })
  await assert.rejects(second, { code: 'SCREEN_ACCESS_OFF' })
  assert.equal(f.host.state(f.owner).grants.length, 0)
  assert.throws(() => f.host.control(f.principal('b'), { action: 'click' }), { code: 'SCREEN_ACCESS_OFF' })
})

test('one agent owns the full interaction until release, including pauses between calls', async () => {
  const f = fixture()
  await f.host.grant(f.owner, { mode: 'selected', sessionIds: ['a', 'b'], labels: { a: 'Researcher' } })
  assert.equal(f.host.status(f.principal('a')).state, 'ready')
  await f.host.control(f.principal('a'), { action: 'screenshot' })
  assert.equal(f.host.state(f.owner).holderLabel, 'Researcher')
  assert.equal(f.host.status(f.principal('a')).state, 'controlling')
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  assert.throws(() => f.host.control(f.principal('b'), { action: 'click' }), { code: 'SCREEN_BUSY' })
  assert.equal((await f.host.control(f.principal('b'), { action: 'release' })).released, false)
  await f.host.control(f.principal('a'), { action: 'type', text: 'Complete the same form' })
  await f.host.control(f.principal('a'), { action: 'release' })
  assert.equal(f.host.status(f.principal('b')).state, 'ready')
  await f.host.control(f.principal('b'), { action: 'screenshot' })
  assert.equal(f.host.status(f.principal('b')).ownsControl, true)
  assert.deepEqual(f.performed.map(value => value.action), ['screenshot', 'type', 'screenshot'])
  f.host.close(f.owner)
})

test('idle control expires without dropping eligibility and renews after each completed action', async () => {
  let clock = 0
  const f = fixture({ now: () => clock })
  await f.host.grant(f.owner, { mode: 'any-running' })
  await f.host.control(f.principal('a'), { action: 'acquire' })
  clock = 59000
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  await f.host.control(f.principal('a'), { action: 'screenshot' })
  clock = 61000
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  clock = 119001
  assert.equal(f.host.status(f.principal('b')).state, 'ready')
  assert.equal(f.host.state(f.owner).grants.length, 2)
  await f.host.control(f.principal('b'), { action: 'acquire' })
  assert.equal(f.host.state(f.owner).holderSessionId, 'b')
  f.host.close(f.owner)
})

test('all-running mode excludes foreign, ended and unassigned sessions; selected mode replaces access', async () => {
  const f = fixture({ readBinding: id => ({ enabled: true, roleId: 'worker', revision: 1, functions: id === 'restricted' ? [] : null }) })
  f.sessions.set('foreign', { owner: f.other, ownerKind: 'window', agentId: 'foreign' })
  f.sessions.set('remote', { owner: f.owner, ownerKind: 'remote', agentId: 'remote' })
  f.sessions.set('ended', { owner: f.owner, ownerKind: 'window', agentId: 'ended', ended: true })
  f.sessions.set('restricted', { owner: f.owner, ownerKind: 'window', agentId: 'restricted' })
  await f.host.grant(f.owner, { mode: 'any-running' })
  assert.deepEqual(f.host.state(f.owner).grants.map(value => value.sessionId), ['a', 'b'])
  assert.equal(f.host.state(f.owner).agents.find(value => value.sessionId === 'restricted').eligible, false)
  await f.host.control(f.principal('a'), { action: 'screenshot' })
  await f.host.grant(f.owner, { mode: 'selected', sessionIds: ['b'] })
  assert.equal(f.host.status(f.principal('a')).enabled, false)
  assert.equal(f.host.state(f.owner).holderSessionId, null)
  assert.deepEqual(f.host.state(f.owner).grants.map(value => value.sessionId), ['b'])
  f.sessions.set('new', { owner: f.owner, ownerKind: 'window', agentId: 'new' })
  assert.equal(f.host.status(f.principal('new')).enabled, false, 'starting an agent never silently expands an earlier grant')
  f.host.close(f.owner)
})

test('release fences input submitted for the old turn and never reaches the native helper', async () => {
  const f = fixture()
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await f.host.control(f.principal('a'), { action: 'acquire' })
  const release = f.host.control(f.principal('a'), { action: 'release' })
  const stale = f.host.control(f.principal('a'), { action: 'click' })
  await release
  await assert.rejects(stale, { code: 'SCREEN_CONTROL_CHANGED' })
  assert.equal(f.performed.length, 0)
  f.host.close(f.owner)
})

test('invalid input cannot seize control and off status explains how to enable access', async () => {
  const f = fixture({ adapter: { supported: () => true, geometry: () => ({}), validate() { throw new Error('invalid point') } } })
  const off = f.host.status(f.principal('a'))
  assert.equal(off.reason, 'SCREEN_ACCESS_OFF'); assert.match(off.nextAction, /Settings/)
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  assert.throws(() => f.host.control(f.principal('a'), { action: 'move' }), /invalid point/)
  assert.throws(() => f.host.control(f.principal('a'), { action: 'acquire', x: 1 }), { code: 'SCREEN_ACTION_INVALID' })
  assert.equal(f.host.state(f.owner).holderSessionId, null)
  await f.host.control(f.principal('b'), { action: 'acquire' })
  f.host.close(f.owner)
})

test('idle timeout cannot hand control away while native input is still running', async () => {
  let clock = 0, finish, began
  const started = new Promise(resolve => { began = resolve })
  const f = fixture({ now: () => clock, adapter: { supported: () => true, geometry: () => ({}), validate: input => input,
    execute: async () => { began(); await new Promise(resolve => { finish = resolve }); return { status: 'completed', cleanupConfirmed: true } } } })
  await f.host.grant(f.owner, { mode: 'any-running' })
  const action = f.host.control(f.principal('a'), { action: 'type', text: 'ongoing' })
  await started; clock = 120000
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  assert.throws(() => f.host.control(f.principal('b'), { action: 'acquire' }), { code: 'SCREEN_BUSY' })
  finish(); await action
  assert.equal(f.host.status(f.principal('b')).state, 'busy')
  f.host.close(f.owner)
})
