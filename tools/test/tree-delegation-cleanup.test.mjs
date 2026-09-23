import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupTreeDelegation } from '../../shell/tree-delegation-cleanup.cjs'

function fixture(overrides = {}) {
  const calls = []
  const owner = {}
  const session = { ownerKind: 'window', owner }
  const sessions = new Map([['child-session', session]])
  const receipt = { childSessionId: 'child-session', ownerKey: 'owner-key',
    permit: { cancel() { calls.push('cancel') } } }
  Object.defineProperty(session, 'treeDelegationStart', { value: receipt.permit })
  const dependencies = {
    readSession(id) { calls.push(['read', id]); return sessions.get(id) },
    ownerKey(principal) {
      calls.push(['owner', principal])
      return principal.owner === owner && principal.kind === 'window' ? 'owner-key' : 'wrong-owner'
    },
    async close(id, principal) { calls.push(['close', id, principal]); sessions.delete(id) },
    ...overrides,
  }
  return { calls, owner, session, sessions, receipt, dependencies }
}

test('failed delegation cancels first, closes the captured owner session, and verifies removal', async () => {
  const f = fixture()
  await cleanupTreeDelegation(f.receipt, f.dependencies)
  assert.equal(f.calls[0], 'cancel')
  assert.deepEqual(f.calls.filter(call => Array.isArray(call)).map(call => call[0]), ['read', 'owner', 'close', 'read'])
  const close = f.calls.find(call => call[0] === 'close')
  assert.equal(close[1], 'child-session')
  assert.equal(close[2].owner, f.owner)
  assert.equal(close[2].kind, 'window')
  assert.equal(close[2].mayWrite, true)
  assert.equal(f.sessions.size, 0)
})

test('unredeemed or already-gone children do not request a close', async () => {
  const f = fixture()
  f.receipt.childSessionId = null
  await cleanupTreeDelegation(f.receipt, f.dependencies)
  assert.deepEqual(f.calls, ['cancel'])
  f.calls.length = 0
  f.receipt.childSessionId = 'child-session'
  f.sessions.clear()
  await cleanupTreeDelegation(f.receipt, f.dependencies)
  assert.deepEqual(f.calls, ['cancel', ['read', 'child-session']])
})

test('a different owner cannot be closed using the failed delegation receipt', async () => {
  const f = fixture()
  f.sessions.set('child-session', { ownerKind: 'window', owner: {}, treeDelegationStart: f.receipt.permit })
  await assert.rejects(cleanupTreeDelegation(f.receipt, f.dependencies), { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  assert.equal(f.calls.some(call => call[0] === 'close'), false)
})

test('a same-owner replacement with a reused session id is not the original start attempt', async () => {
  const f = fixture()
  const replacement = { ownerKind: 'window', owner: f.owner, treeDelegationStart: {} }
  f.sessions.set('child-session', replacement)
  await assert.rejects(cleanupTreeDelegation(f.receipt, f.dependencies), { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  assert.equal(f.calls.some(call => call[0] === 'close'), false)
  assert.equal(f.sessions.get('child-session'), replacement)
})

test('cleanup awaits ordinary close and refuses an unchanged retained session', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const f = fixture({ close: () => held })
  let settled = false
  const cleanup = cleanupTreeDelegation(f.receipt, f.dependencies)
  cleanup.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  await assert.rejects(cleanup, { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  assert.equal(f.sessions.get('child-session'), f.session)
})

test('ordinary close failure propagates without reporting cleanup success', async () => {
  const failure = Object.assign(new Error('Synthetic retained process still alive'), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
  const f = fixture({ close: async () => { throw failure } })
  await assert.rejects(cleanupTreeDelegation(f.receipt, f.dependencies), error => error === failure)
  assert.equal(f.calls.filter(call => call[0] === 'read').length, 1)
  assert.equal(f.sessions.get('child-session'), f.session)
})

test('authority lookup failure does not fall back to closing an unverified owner', async () => {
  const failure = Object.assign(new Error('Synthetic owner unavailable'), { code: 'TREE_DELEGATION_REFUSED' })
  const f = fixture({ ownerKey() { throw failure } })
  await assert.rejects(cleanupTreeDelegation(f.receipt, f.dependencies), error => error === failure)
  assert.equal(f.calls.some(call => call[0] === 'close'), false)
})

test('a replacement appearing during awaited close is not closed a second time', async () => {
  const f = fixture()
  const replacement = { ownerKind: 'window', owner: f.owner }
  f.dependencies.close = async id => { f.calls.push(['close', id]); f.sessions.set(id, replacement) }
  await cleanupTreeDelegation(f.receipt, f.dependencies)
  assert.equal(f.calls.filter(call => call[0] === 'close').length, 1)
  assert.equal(f.sessions.get('child-session'), replacement)
})
