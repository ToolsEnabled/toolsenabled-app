/* "IT'S ON." The owner, 2026-09-15 22:03:39Z, answering an agent that had just
 * told them computer control was off: "its on. either another agent is using it
 * maybe, or it could be broken in this running instance."
 *
 * Both were right. Grants are held in memory and keyed by sessionId, so
 * requireGrant answers "does THIS session hold a grant?" and reports the answer
 * as "is the permission enabled?". An agent whose grant was replaced by a later
 * Settings/Page 2 choice, or whose session id changed, is told to ask the person
 * to switch on something already switched on. That cost a durable owner ask and
 * a round trip.
 *
 * The module already draws this kind of distinction: a changed role or
 * permission level fails SCREEN_ACCESS_CHANGED with an accurate sentence. These
 * tests hold the remaining case to the same standard. No grant semantics change:
 * exclusivity is deliberate and stays. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createScreenControlHost } = require('../../shell/screen-control-host.cjs')

function fixture() {
  const owner = { isDestroyed: () => false }
  const sessions = new Map(['a', 'b'].map(id => [id, { owner, ownerKind: 'window', agentId: id, state: 'running' }]))
  const role = { enabled: true, roleId: 'worker', revision: 1, functions: null }
  const host = createScreenControlHost({
    sessions, readBinding: () => role, permissionLevel: () => 'unrestricted',
    adapter: { supported: () => true, geometry: () => ({ displays: [] }), validate: input => ({ ...input }),
      execute: async () => ({ status: 'completed', cleanupConfirmed: true }) },
    indicator: { ready: async () => {}, show() {}, hide() {}, release() {} },
    audit: async () => {},
  })
  const principal = id => ({ kind: 'agent-session', sessionId: id, agentId: id, roleId: role.roleId, expectedRoleRevision: role.revision })
  return { host, owner, sessions, principal }
}

test('with nothing granted at all, "screen access is off" is the truth and stays', async () => {
  const f = fixture()
  const status = f.host.status(f.principal('a'))
  assert.equal(status.enabled, false)
  assert.equal(status.reason, 'SCREEN_ACCESS_OFF')
  assert.match(status.nextAction, /enable Computer control/i,
    'when nothing is granted, telling the person to enable it is correct advice')
  assert.throws(() => f.host.control(f.principal('a'), { action: 'click', x: 1, y: 1 }), { code: 'SCREEN_ACCESS_OFF' })
})

/* THE CASE THE OWNER HIT. Another session of the same owner holds a grant, so
 * the permission is plainly on -- this session simply is not the one it was
 * given to. */
test('when control is granted to another session, the refusal must not claim it is off', async () => {
  const f = fixture()
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  assert.equal(f.host.status(f.principal('a')).enabled, true, 'both sessions start granted')
  f.host.revoke(f.owner, { sessionIds: ['a'] })

  assert.equal(f.host.status(f.principal('b')).enabled, true, 'the other session still holds its grant, so control is on')
  const status = f.host.status(f.principal('a'))
  assert.equal(status.enabled, false, 'this session genuinely cannot act')
  assert.equal(status.reason, 'SCREEN_ACCESS_NOT_THIS_SESSION',
    'the cause is "granted elsewhere", not "off", and the code must say which')
  assert.doesNotMatch(status.nextAction, /enable Computer control/i,
    'it must never tell the person to switch on something already on -- that is the round trip this fixes')
  assert.match(status.nextAction, /Page 2|different session|granted/i,
    'it must say what would actually help: grant THIS agent')
  assert.throws(() => f.host.control(f.principal('a'), { action: 'click', x: 1, y: 1 }),
    { code: 'SCREEN_ACCESS_NOT_THIS_SESSION' })
})

test('once the last grant is gone, the honest answer returns to off', async () => {
  const f = fixture()
  await f.host.grant(f.owner, { sessionIds: ['a', 'b'] })
  f.host.revoke(f.owner, { sessionIds: ['a', 'b'] })
  const status = f.host.status(f.principal('a'))
  assert.equal(status.reason, 'SCREEN_ACCESS_OFF')
  assert.match(status.nextAction, /enable Computer control/i)
})

/* A grant belonging to a DIFFERENT owner is not evidence that this owner's
 * control is on, so it must not soften this owner's refusal. */
test('another owner holding a grant does not make this owner look granted', async () => {
  const f = fixture()
  const stranger = { isDestroyed: () => false }
  f.sessions.set('c', { owner: stranger, ownerKind: 'window', agentId: 'c', state: 'running' })
  await f.host.grant(stranger, { sessionIds: ['c'] })
  const status = f.host.status(f.principal('a'))
  assert.equal(status.reason, 'SCREEN_ACCESS_OFF',
    'this owner has granted nothing, so off is still the truthful answer')
})

/* Exclusivity is deliberate and must survive the change. */
test('granting one session still revokes the others, unchanged', async () => {
  const f = fixture()
  await f.host.grant(f.owner, { sessionIds: ['a'] })
  await f.host.grant(f.owner, { sessionIds: ['b'], mode: 'selected' })
  assert.equal(f.host.status(f.principal('b')).enabled, true)
  assert.equal(f.host.status(f.principal('a')).enabled, false, 'the replaced grant is still revoked')
  assert.equal(f.host.status(f.principal('a')).reason, 'SCREEN_ACCESS_NOT_THIS_SESSION',
    'and now it says so accurately instead of blaming the switch')
})
