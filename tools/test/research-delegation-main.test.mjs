import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(new URL('../../shell/main.cjs', import.meta.url))
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const first = main.indexOf('function resolveLocalTreeCommand(envelope, result) {')
const last = main.indexOf('\nlet treeNodeCommandDispatchEnabled', first)
assert.ok(first > 0 && last > first)

function fixture({ cleanupFails = false } = {}) {
  const owner = { isDestroyed: () => false }
  const parent = { sessionId: 'parent', nodeId: 'parent-node', owner: 'owner-key', cwd: '/parent',
    treeId: 'tree', treeAnchors: ['tree', 'parent-node'], permissionSession: { origin: 'local', tier: 'full' } }
  const access = Object.freeze({ version: 1, mode: 'clean-room', root: '/minted-room', access: 'read-only' })
  const sessions = new Map()
  const calls = []
  let queued, invalidated = false
  const permit = { researchAccess: access, assertStart() { if (invalidated) throw new Error('cancelled') },
    cancel() { invalidated = true; calls.push('cancel') } }
  const authority = { issue(sessionId, ownerKey, request) {
    assert.equal(sessionId, parent.sessionId); assert.equal(ownerKey, parent.owner)
    return { token: 'private-token', parent, access, research: request.research }
  }, finish(token, options) { calls.push({ finish: token, ...options }) } }
  const host = { readTreeParent(id) { return sessions.get(id)?.scope || null } }
  const localTreeCommands = new Map()
  const injected = {
    randomUUID, require, localTreeCommands, agentSessions: sessions, agentHost: host,
    treeCommandComputerId: 'computer', TREE_SPAWN_DELIVERY_MS: 10000,
    setTimeout, clearTimeout,
    treeOwnerKey: () => 'owner-key', readTreeParentAuthority: () => parent,
    getResearchDelegationAuthority: () => authority, researchNodeAdmissions: new Map(),
    treeNodeCommandBroker: { state: () => ({}) },
    treeSpawnError: (code, message) => Object.assign(new Error(message), { code }),
    treeNodeCommandRefusalSentence: () => null,
    treeCommandRefusalSentence: (action, code) => code,
    queueTreeNodeCommand(id) { queued = localTreeCommands.get(id); return true },
    getAgentCommandSurface: () => ({ run: async (action, request) => {
      assert.equal(action, 'agent:close'); calls.push({ close: request.sessionId })
      if (cleanupFails) throw new Error('close unconfirmed')
      sessions.delete(request.sessionId)
    } }),
  }
  const load = new Function(...Object.keys(injected), main.slice(first, last)
    + '; return {dispatchTreeSpawn,resolveLocalTreeCommand};')
  const api = load(...Object.values(injected))
  return { calls, sessions, localTreeCommands, permit, parent, access, ...api,
    receipt({ mismatched = false } = {}) {
      const entry = queued
      const command = entry.envelope.request
      const id = 'started-child'
      entry.delegation.permit = permit
      entry.delegation.childSessionId = id
      entry.delegation.childCwd = access.root
      sessions.set(id, { ownerKind: 'window', owner, treeDelegationStart: permit,
        scope: { nodeId: command.reservedNodeId, cwd: mismatched ? '/wrong' : access.root,
          researchAccess: access, modelTier: command.tier, roleId: command.role,
          treeId: parent.treeId, treeAnchors: [...parent.treeAnchors, command.reservedNodeId], threadId: 'native-thread' } })
      return { envelope: entry.envelope, result: { ok: true, nodeId: command.reservedNodeId, sessionId: id } }
    }
  }
}
const request = { parentSessionId: 'parent', role: 'worker', tier: 'luna',
  research: { mode: 'clean-room', access: 'read-only', prompt: 'Only explicit task', files: [] } }

test('actual main mismatch rejection reaches retained settle closure after waiter map removal', async () => {
  const flow = fixture()
  const spawn = flow.dispatchTreeSpawn(request)
  const rejected = assert.rejects(spawn, { code: 'RESEARCH_DELEGATION_REFUSED' })
  const { envelope, result } = flow.receipt({ mismatched: true })
  flow.resolveLocalTreeCommand(envelope, result)
  await rejected
  assert.equal(flow.localTreeCommands.size, 0)
  assert.equal(flow.sessions.size, 0)
  assert.deepEqual(flow.calls.filter(call => typeof call === 'object'), [
    { close: 'started-child' }, { finish: 'private-token', failed: true },
  ])
})

test('actual main accepted child preserves its room and returns the verified boundary', async () => {
  const flow = fixture()
  const spawn = flow.dispatchTreeSpawn(request)
  const { envelope, result } = flow.receipt()
  flow.resolveLocalTreeCommand(envelope, result)
  const answer = await spawn
  assert.equal(answer.researchAccess, flow.access)
  assert.equal(answer.threadId, 'native-thread')
  assert.equal(flow.sessions.size, 1)
  assert.deepEqual(flow.calls.filter(call => typeof call === 'object'), [{ finish: 'private-token', failed: false }])
  flow.sessions.clear() // fixture record only; this suite starts no provider process
})

test('unconfirmed provider cleanup preserves room and reports the cleanup failure', async () => {
  const flow = fixture({ cleanupFails: true })
  const spawn = flow.dispatchTreeSpawn(request)
  const rejected = assert.rejects(spawn, { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  const { envelope, result } = flow.receipt({ mismatched: true })
  flow.resolveLocalTreeCommand(envelope, result)
  await rejected
  assert.equal(flow.sessions.size, 1)
  assert.equal(flow.calls.some(call => call?.finish), false, 'room cannot be removed beneath an unconfirmed live child')
  flow.sessions.clear()
})
