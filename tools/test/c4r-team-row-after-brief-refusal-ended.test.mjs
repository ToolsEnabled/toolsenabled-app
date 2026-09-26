/* c4 review, low item (1.0.48 candidate 4). B31 gave a Team row whose member
 * started but whose brief was refused its own sentence: "Its brief did not
 * reach it. It is open without a task; Stop closes it." In the real window the
 * same sentence stayed on a row whose session the refusal had ENDED (the send
 * answered MC_AGENT_SESSION_ENDED; startAgentForNode reports that as
 * `sessionEnded: true` with the session and its receipt). Nothing was open.
 * The row must say what happened to that session, and keep the open-session
 * sentence for a session that really is still open.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-team-row-after-brief-refusal-ended.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
const { createTreeWorkController } = await import('../../src/tree-bounded-work.js')

const basic = (action, target) => ({ action, target, ok: true, disposition: 'not-required', required: false,
  recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null })
const plan = { computerId: 'c', treeId: 't', parentNodeId: 'p', parentSessionId: 'ps', tier: 'claude-sonnet-5', capMs: 60_000,
  brief: 'Every member: reply TEAMOK.', members: ['claude-haiku-4-5'] }

function team(memberAnswer) {
  let n = 0
  const statuses = new Map()
  return createTreeWorkController({ kind: 'team',
    start: async request => {
      n += 1
      const sessionId = `s${n}`, nodeId = `n${n}`
      const receipt = { action: 'tree.dispatch', computerId: request.computerId, treeId: request.treeId,
        parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
        sessionId, nodeId, agentId: nodeId, startedAt: 1, deadlineAt: 60_001, capMs: 60_000 }
      const record = basic('controller.agent.launch', sessionId)
      statuses.set(sessionId, { ok: true, ...receipt, state: 'ready', record, endRecord: null })
      if (n === 1) return { ok: true, sessionId, nodeId, boundedWork: receipt, record }
      return { ok: false, sessionId, nodeId, boundedWork: receipt, record, ...memberAnswer }
    },
    readStatus: async sessionId => statuses.get(sessionId),
    close: async () => ({ ok: true }),
    setTimer: () => null, clearTimer: () => {},
  })
}

test('c4r: a member whose brief refusal ended its session is not called open', async () => {
  const controller = team({ sessionEnded: true, code: 'MC_AGENT_SESSION_ENDED',
    message: 'Your agent started, and your message did not reach it. Its session has ended.' })
  await controller.run(plan)
  const row = controller.getState().rows[1]
  assert.equal(row.phase === 'started', false)
  assert.equal(/brief did not reach it/.test(row.detail), true)
  assert.equal(/open without a task/.test(row.detail), false, `THE DEFECT: "${row.detail}" over a session that ended`)
  assert.equal(/ended/.test(row.detail), true, 'the row says the session ended')
})

test('c4r: a member whose brief was refused while its session stays open keeps the open-session sentence', async () => {
  const controller = team({ code: 'MC_TRANSCRIPT_ADMISSION_PENDING', message: 'Your agent started, and your message did not reach it.' })
  await controller.run(plan)
  const row = controller.getState().rows[1]
  assert.equal(/open without a task; Stop closes it/.test(row.detail), true)
})
