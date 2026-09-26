import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
async function setup(t) {
  const sent = [], closed = []
  let number = 0
  t.mock.method(engine, 'startCodexSession', async () => {
    const threadId = 'thread-' + (++number)
    const adapter = { transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
      sendTurn: async request => { sent.push(request); return { turnId: 'turn-' + sent.length } }, interrupt: async () => {}, answerApproval() {} }
    return { threadId, adapter, close() { closed.push(threadId) } }
  })
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: root, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }) })
  await host.startSession({ sessionId: 'source', tier: 'luna' })
  t.after(() => host.closeAll())
  return { host, sent, closed,
    claim: () => host.claimStandaloneReplacement({ sessionId: 'source', tier: 'luna', account: { mode: 'keep' } }),
    candidate: lease => host.startSession({ sessionId: 'candidate', cwd: root, tier: 'luna', standaloneReplacement: lease.startDescriptor }) }
}
test('standalone prepare holds source and candidate; commit sends no turn and carries history on real send', async t => {
  const f = await setup(t), lease = f.claim()
  await assert.rejects(f.host.sendTurn({ sessionId: 'source', text: 'held' }), { code: 'AGENT_TURN_ACTIVE' })
  await f.candidate(lease)
  await assert.rejects(f.host.sendTurn({ sessionId: 'candidate', text: 'held' }), { code: 'AGENT_TURN_ACTIVE' })
  assert.equal(f.sent.length, 0)
  const receipt = await lease.commit('candidate', { historyText: 'quoted retained history', historyLink: { nodeId: 'seat', computerId: 'computer' } })
  assert.equal(receipt.applied, true)
  assert.equal(receipt.sourceSessionId, 'source')
  assert.equal(receipt.sessionId, 'candidate')
  assert.deepEqual(f.closed, ['thread-1'])
  lease.release()
  await f.host.sendTurn({ sessionId: 'candidate', text: 'original owner message' })
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0].text, /original owner message/)
  assert.match(f.sent[0].text, /quoted retained history/)
})
test('cancel prepared candidate leaves source usable after cleanup and releases no successor', async t => {
  const f = await setup(t), lease = f.claim()
  await f.candidate(lease)
  lease.cancel()
  await f.host.closeSession({ sessionId: 'candidate' })
  lease.release()
  await f.host.sendTurn({ sessionId: 'source', text: 'retained' })
  assert.equal(f.sent.length, 1)
})
test('Stop before candidate admission invalidates the exact claim', async t => {
  const f = await setup(t), lease = f.claim()
  const stop = await f.host.interrupt({ sessionId: 'source' })
  assert.equal(stop.switchCancelled, true)
  await assert.rejects(Promise.resolve().then(() => f.candidate(lease)), { code: 'AGENT_SWITCH_STALE' })
  lease.release()
})
test('a forged replacement descriptor cannot bypass the host start path', async t => {
  const f = await setup(t)
  await assert.rejects(Promise.resolve().then(() => f.host.startSession({ sessionId: 'candidate', tier: 'luna', standaloneReplacement: {} })), { code: 'AGENT_SWITCH_STALE' })
  assert.equal(f.host.sessionActivity('source').closing, false)
})
test('replacement target mismatch and duplicate candidate refuse without retiring source', async t => {
  const f = await setup(t), lease = f.claim()
  await assert.rejects(Promise.resolve().then(() => f.host.startSession({ sessionId: 'wrong', cwd: root, tier: 'astra', standaloneReplacement: lease.startDescriptor })), { code: 'AGENT_SWITCH_STALE' })
  await f.candidate(lease)
  await assert.rejects(Promise.resolve().then(() => f.host.startSession({ sessionId: 'second', cwd: root, tier: 'luna', standaloneReplacement: lease.startDescriptor })), { code: 'AGENT_SWITCH_STALE' })
  lease.cancel()
  await f.host.closeSession({ sessionId: 'candidate' })
  lease.release()
  assert.equal(f.closed.includes('thread-1'), false)
})
test('exact account failure leaves original session intact', async t => {
  const f = await setup(t)
  const lease = f.host.claimStandaloneReplacement({ sessionId: 'source', tier: 'luna', account: { mode: 'exact', name: 'missing-account' } })
  await assert.rejects(f.candidate(lease), { code: 'AGENT_RESUME_ACCOUNT_UNAVAILABLE' })
  lease.release()
  await f.host.sendTurn({ sessionId: 'source', text: 'still usable' })
  assert.equal(f.sent.length, 1)
})
