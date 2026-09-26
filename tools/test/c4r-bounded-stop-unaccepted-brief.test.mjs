/* c4 review (1.0.48 candidate 4): since B31 a Launch/Team/Loop start answers only
 * when the child's brief is accepted. Stop joins `flight` before closing, so a
 * provider that never accepts the brief (a stuck CLI, simulated in the real
 * window with SIGSTOP) held "Stop child work" at "Waiting for any start in
 * flight" until the provider was released. Stop must close the session the
 * start already opened. */
import assert from 'node:assert/strict'
import test from 'node:test'
const { createTreeWorkController } = await import('../../src/tree-bounded-work.js')

const basic = (action, target) => ({ action, target, ok: true, disposition: 'not-required', required: false,
  recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null })

test('c4r: Stop closes a child whose brief is not accepted yet, instead of waiting for the provider', async () => {
  const closes = []
  let endStart = null
  const statuses = new Map()
  const receipt = { action: 'tree.dispatch', computerId: 'c', treeId: 't', parentNodeId: 'p', parentSessionId: 'ps',
    sessionId: 's1', nodeId: 'n1', agentId: 'n1', startedAt: 1, deadlineAt: 60_001, capMs: 60_000 }
  const controller = createTreeWorkController({ kind: 'launch',
    start: request => new Promise(resolve => {
      request.onSessionOpen?.('s1') // the host opened the child; its brief now waits for the provider
      statuses.set('s1', { ok: true, ...receipt, state: 'ready', record: basic('controller.agent.launch', 's1'), endRecord: null })
      endStart = () => resolve({ ok: false, sessionId: 's1', boundedWork: receipt, record: basic('controller.agent.launch', 's1'),
        code: 'MC_AGENT_SESSION_ENDED', message: 'The session ended before its brief was accepted.' })
    }),
    readStatus: async sessionId => statuses.get(sessionId),
    close: async sessionId => {
      closes.push(sessionId)
      const status = statuses.get(sessionId)
      statuses.set(sessionId, { ...status, state: 'closed', endRecord: { ...status.record, action: 'agent_session_end', target: sessionId } })
      endStart?.() // closing the session ends the pending send, as the host does
      return { ok: true }
    },
    setTimer: () => null, clearTimer: () => {},
  })
  void controller.run({ computerId: 'c', treeId: 't', parentNodeId: 'p', parentSessionId: 'ps', tier: 'claude-haiku-4-5', capMs: 60_000, brief: 'x' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const stopped = await Promise.race([controller.stop().then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('still waiting'), 1500))])
  assert.equal(stopped, 'settled', 'Stop waited for a brief the provider never accepted')
  assert.ok(closes.includes('s1'), 'the opened child was closed')
  assert.equal(controller.getState().phase, 'stopped')
})

/* c4 second review, real window (g): for the ~4 s between Stop and the host's
   close confirmation the Launch box showed the FAILURE sentence ("Your agent
   started, and your message did not reach it... Try it once more...") with
   Stop enabled again, and the row said "It is open without a task; Stop closes
   it." That refusal is Stop's own close ending the brief's wait: once Stop is
   pressed nothing may read as a failed start, and Stop stays pressed. */
test('c4r2: while Stop closes an unaccepted child, the box never shows the start as failed', async () => {
  const statuses = new Map()
  let endStart = null
  let releaseClose = null
  const receipt = { action: 'tree.dispatch', computerId: 'c', treeId: 't', parentNodeId: 'p', parentSessionId: 'ps',
    sessionId: 's1', nodeId: 'n1', agentId: 'n1', startedAt: 1, deadlineAt: 60_001, capMs: 60_000 }
  const refusal = 'Your agent started, and your message did not reach it. Try it once more.'
  const controller = createTreeWorkController({ kind: 'launch',
    start: request => new Promise(resolve => {
      request.onSessionOpen?.('s1')
      statuses.set('s1', { ok: true, ...receipt, state: 'ready', record: basic('controller.agent.launch', 's1'), endRecord: null })
      endStart = () => resolve({ ok: false, sessionId: 's1', boundedWork: receipt, record: basic('controller.agent.launch', 's1'),
        code: 'MC_AGENT_SESSION_ENDED', sessionEnded: true, message: refusal })
    }),
    readStatus: async sessionId => statuses.get(sessionId),
    close: async sessionId => {
      const status = statuses.get(sessionId)
      endStart?.() // the pending brief is refused as soon as the close begins
      // The host's close confirmation takes a while (4.4 s in the real window).
      await new Promise(resolve => { releaseClose = resolve })
      statuses.set(sessionId, { ...status, state: 'closed', endRecord: { ...status.record, action: 'agent_session_end', target: sessionId } })
      return { ok: true }
    },
    setTimer: () => null, clearTimer: () => {},
  })
  const seen = []
  controller.subscribe(state => seen.push(state))
  void controller.run({ computerId: 'c', treeId: 't', parentNodeId: 'p', parentSessionId: 'ps', tier: 'claude-haiku-4-5', capMs: 60_000, brief: 'x' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const pressed = seen.length
  const stopping = controller.stop()
  await new Promise(resolve => setTimeout(resolve, 20))
  const during = controller.getState()
  releaseClose?.()
  await stopping
  const afterStop = seen.slice(pressed)
  assert.equal(afterStop.some(state => state.phase === 'refused'), false, 'the box read "refused" after the person pressed Stop')
  assert.equal(afterStop.some(state => state.message === refusal), false, 'the failure sentence was shown for Stop\'s own close')
  assert.equal(during.stoppable === false && during.phase === 'stopping', true, `Stop came back while it was still closing (${during.phase}, stoppable ${during.stoppable})`)
  assert.equal(during.rows.some(row => /open without a task|did not reach it/.test(row.detail)), false,
    `the row blamed the brief: ${during.rows.map(row => row.detail).join(' | ')}`)
  const final = controller.getState()
  assert.equal(final.phase === 'stopped', true)
  assert.equal(final.message, 'No further work will start. The host confirmed all started sessions closed.')
})
