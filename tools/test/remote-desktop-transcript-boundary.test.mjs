import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRemoteDesktopSessions } = require('../../shell/remote-desktop-sessions.cjs')

function fixture({ hostOwnsBoundary = false, outcome = 'accepted' } = {}) {
  const owner = {}, windowOwner = {}
  const state = { generation: 0, enrolled: true, owner, mayWrite: true,
    claim: { connected: true, deviceId: 'device', pairId: 'pair' } }
  const session = { owner: windowOwner, ownerKind: 'window', pairingOwner: owner,
    state: 'ready', treeNodeId: 'node-1', agentId: 'agent-1', desktopName: 'Worker' }
  const sessions = new Map([['desktop-1', session]])
  const sent = [], recorded = []
  const host = {
    sessionActivity: () => ({ busy: false }),
    sendTurn: async request => {
      sent.push(request)
      if (outcome === 'accepted') {
        if (hostOwnsBoundary) controller.acceptedPrompt({ ...request, turnId: 'turn-1' })
        return { ok: true, turnId: 'turn-1' }
      }
      if (outcome === 'rejected') return { ok: false, code: 'AGENT_SESSION_ENDED' }
      throw Object.assign(new Error('unknown delivery'), { code: 'MC_AGENT_UNKNOWN_SESSION' })
    },
  }
  if (hostOwnsBoundary) host.onAcceptedPrompt = () => {}
  const deps = {
    sessions,
    host: () => host,
    currentPrincipal: () => ({ kind: 'relay', owner: state.owner, mayWrite: state.mayWrite }),
    connectionTicket: () => state.generation,
    connectionContinues: ticket => state.enrolled && ticket === state.generation,
    deviceStatus: async () => ({ ...state.claim }),
    bindingFor: () => ({ computerId: 'computer', nodeId: 'node-1' }),
    readTranscript: async () => ({ entries: [], before: null }),
    recordSend: async value => { recorded.push(value) },
    emitRemote: () => {},
    emitWindow: () => {},
  }
  const controller = createRemoteDesktopSessions(deps)
  return { controller, sent, recorded, principal: () => ({ kind: 'relay', owner: state.owner, mayWrite: true }) }
}

test('host-owned acceptance boundary performs exactly one transcript write', async () => {
  const f = fixture({ hostOwnsBoundary: true })
  await f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, f.principal())
  assert.equal(f.sent.length, 1)
  assert.equal(f.recorded.length, 0, 'host acceptance callback owns the reserved write')
})

test('legacy hosts without an acceptance boundary retain their direct transcript write', async () => {
  const f = fixture()
  await f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, f.principal())
  assert.equal(f.sent.length, 1)
  assert.equal(f.recorded.length, 1)
  assert.deepEqual(f.recorded[0], { sessionId: 'desktop-1', text: 'hello', turnId: 'turn-1' })
})

for (const outcome of ['rejected', 'unknown']) {
  for (const hostOwnsBoundary of [false, true]) {
    test(`${outcome} delivery never records an accepted transcript (${hostOwnsBoundary ? 'host' : 'legacy'})`, async () => {
      const f = fixture({ hostOwnsBoundary, outcome })
      await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'hello' }))
      assert.equal(f.recorded.length, 0)
    })
  }
}
