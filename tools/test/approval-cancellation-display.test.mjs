import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVAL_PANEL,
  TURN_CANCELLED,
  TURN_FAILED,
  actionRowWords,
  approvalAnswerSentence,
  turnCompletionWords,
} from '../../src/fleet-tree-copy.js'
import { createActionBuffer, nodeStatusForTurn, recoveredNodeTurnStatus, sessionTurnSucceeded } from '../../src/agent-session-events.js'
import { nodeIsBusy, treeNodeClock } from '../../src/tree-session-liveness.js'
import { overviewNodeState } from '../../src/fleet-overview.js'

test('a refused native cancellation is not labeled a failed turn or a continuing success', () => {
  assert.equal(sessionTurnSucceeded('cancelled'), false)
  assert.equal(nodeStatusForTurn('cancelled'), 'cancelled')
  assert.notEqual(nodeStatusForTurn('cancelled'), 'turn-failed')
  const words = turnCompletionWords({ succeeded: false, cancelled: true, refused: true })
  assert.equal(words, TURN_CANCELLED.refused)
  assert.doesNotMatch(words, /failed/)
})

test('a cancelled node is terminal and needs review without counting as success', () => {
  const node = { status: 'cancelled', sessionId: 'cancelled-session', updatedAt: '2026-09-13T10:00:00.000Z' }
  const owned = new Set([node.sessionId])
  assert.equal(nodeIsBusy(node, owned), false)
  assert.equal(treeNodeClock(node, owned).terminal, true)
  assert.equal(overviewNodeState(node, owned), 'review')
  assert.equal(nodeStatusForTurn('completed', { userStopped: true }), 'finished', 'a completed turn wins a racing Stop')
  assert.equal(nodeStatusForTurn('cancelled', { userStopped: true }), 'interrupted')
})

test('the approval sentence stays true whether the provider continues or stops', () => {
  assert.equal(APPROVAL_PANEL.answered, 'Your choice was sent.')
  assert.doesNotMatch(APPROVAL_PANEL.answered, /continues/)
  assert.equal(approvalAnswerSentence('reject-once', { 'reject-once': 'reject_once' }), APPROVAL_PANEL.refused)
  assert.equal(approvalAnswerSentence('allow-once', { 'allow-once': 'allow_once' }), APPROVAL_PANEL.answered)
  assert.equal(actionRowWords({ kind: 'approval', state: 'closed' }).state, 'no longer waiting')
  assert.equal(actionRowWords({ kind: 'approval', state: 'waiting' }).state, 'waiting for you')
  assert.equal(actionRowWords({ kind: 'approval', state: 'refused' }).state, 'refused')
})

test('reload preserves a confirmed Stop only for the same native completed turn', () => {
  const saved = { status: 'interrupted', lastTurnId: 'turn-stopped' }
  assert.equal(recoveredNodeTurnStatus(saved, 'cancelled', 'turn-stopped'), 'interrupted')
  assert.equal(recoveredNodeTurnStatus(saved, 'cancelled', 'turn-next'), 'cancelled')
  assert.equal(recoveredNodeTurnStatus(saved, 'cancelled', null), 'cancelled')
  assert.equal(recoveredNodeTurnStatus(saved, 'completed', 'turn-stopped'), 'finished')
})

test('a late approval answer cannot settle a reused provider ID in another turn', () => {
  const buffer = createActionBuffer()
  const first = buffer.add({ kind: 'approval', approvalId: 'reused', text: 'First permission' }, { turnId: 'first', at: 1 }).row
  buffer.settleUnfinished()
  const next = buffer.add({ kind: 'approval', approvalId: 'reused', text: 'Next permission' }, { turnId: 'next', at: 2 }).row
  buffer.answerApproval('reused', 'refused', { turnId: 'first' })
  assert.equal(first.state, 'refused')
  assert.equal(next.state, 'waiting')
  buffer.answerApproval('reused', 'done', { turnId: 'next' })
  assert.equal(next.state, 'done')
})
