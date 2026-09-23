import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityLine } from '../../src/fleet-tree-copy.js'

import {
  completionSettlesOpenTurn,
  createActionBuffer,
  sessionActivityEvent,
  sessionEndedEvent,
  sessionEventText,
  sessionEventTurnId,
  sessionFiledRule,
  sessionMessageBoundary,
  sessionRuleFilingCall,
  sessionThinkingText,
  sessionTurnFailureText,
  sessionTurnStatus,
  sessionTurnSucceeded,
  sessionTurnCancelled,
  nodeStatusForTurn,
  sessionUsageEvent,
} from '../../src/agent-session-events.js'

const packet = (event, sessionId = 'session-a') => ({ sessionId, event })

test('ACP end_turn finishes the tree while refusal, limits, cancellation and unknown outcomes do not', () => {
  const done = packet({ type: 'turn_completed', turnId: 'acp-turn-1', status: 'end_turn', text: 'Answer' })
  assert.equal(sessionTurnStatus(done, 'session-a'), 'end_turn', 'preserve the provider outcome')
  assert.equal(sessionTurnSucceeded(sessionTurnStatus(done, 'session-a')), true)
  assert.equal(sessionTurnFailureText(done, 'session-a'), null, 'do not duplicate an answer as failure text')
  assert.equal(completionSettlesOpenTurn(done, 'session-a', 'acp-turn-1'), true)
  assert.equal(completionSettlesOpenTurn(done, 'session-a', 'acp-turn-2'), false)
  for (const status of ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests', 'unknown', '', null]) {
    assert.equal(sessionTurnSucceeded(status), false, String(status))
  }
})

test('live transcript readers accept the caller wire shape and keep sessions and turns separate', () => {
  const delta = packet({ type: 'assistant_text_delta', turnId: 'turn-a', text: 'Hello' })
  const seam = packet({ type: 'tool_call', turnId: 'turn-a', payload: { command: 'pwd' } })
  const completion = packet({ type: 'turn_completed', turnId: 'turn-a', status: 'success' })

  assert.equal(sessionEventText(delta, 'session-a'), 'Hello', 'a matching assistant delta must reach its transcript')
  assert.equal(sessionEventTurnId(delta, 'session-a'), 'turn-a', 'the caller must be able to keep the delta with its named turn')
  assert.equal(sessionMessageBoundary(seam, 'session-a'), true, 'a real tool call must mark the seam between assistant messages')
  assert.equal(sessionTurnStatus(completion, 'session-a'), 'success', 'the engine completion status must survive unchanged')
  assert.equal(completionSettlesOpenTurn(completion, 'session-a', 'turn-a'), true, 'a completion may settle the open turn it names')
  assert.equal(completionSettlesOpenTurn(completion, 'session-a', 'turn-b'), false, "one turn's completion must not take another turn's words")
  assert.equal(sessionEventText(delta, 'session-b'), null, "one session's words must not appear in another session")
})

test('a thinking event is read by sessionThinkingText and never by sessionEventText, in either direction', () => {
  // The one guarantee this pair exists to keep: whichever reader a caller
  // asks, an event can answer at most one of them. Confusing the two is
  // exactly the defect claude-cli-adapter.js's `thinking` type exists to
  // prevent -- reasoning read back as the words the agent said to the person.
  const thinking = packet({ type: 'thinking', turnId: 'turn-a', text: 'Weighing two approaches.' })
  const textDelta = packet({ type: 'assistant_text_delta', turnId: 'turn-a', text: 'Here is the answer.' })

  assert.equal(sessionThinkingText(thinking, 'session-a'), 'Weighing two approaches.', 'a matching thinking event must reach the thinking reader')
  assert.equal(sessionEventText(thinking, 'session-a'), null, 'a thinking event must never be read as the assistant\'s own words')
  assert.equal(sessionThinkingText(textDelta, 'session-a'), null, 'an assistant text delta must never be read as thinking')
  assert.equal(sessionEventText(textDelta, 'session-a'), 'Here is the answer.', 'the answer reader must still read its own event unchanged')
  assert.equal(sessionThinkingText(thinking, 'session-b'), null, "one session's thinking must not appear in another session")
  assert.equal(sessionThinkingText(packet({ type: 'thinking', text: 7 }), 'session-a'), null, 'non-text must not be presented as thinking')
  assert.equal(sessionThinkingText(null, 'session-a'), null, 'an unreadable packet must not be mistaken for thinking')
  assert.equal(sessionThinkingText(packet(null), 'session-a'), null, 'a packet with no event must not be mistaken for thinking')
})

test('packets that cannot be identified as completions remain unknown', () => {
  const unreadable = [null, {}, packet(null), packet({ type: 'usage', status: 'completed' })]
  for (const value of unreadable) {
    assert.equal(sessionTurnStatus(value, 'session-a'), null, 'a packet that cannot be identified as a completion must remain unknown')
  }
  assert.equal(sessionEventText(packet({ type: 'assistant_text_delta', text: 7 }), 'session-a'), null, 'non-text must not be presented as assistant words')
  assert.equal(sessionEventTurnId(packet({ type: 'usage', turnId: '' }), 'session-a'), null, 'a missing turn identity must remain unknown')
  assert.equal(sessionTurnSucceeded('new-provider-status'), false, 'an unmeasured provider status must not be called success')
})

test('the exact host exit packet is terminal even with code zero, while lookalikes stay inert', () => {
  const ended = packet({ type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } })
  assert.deepEqual(sessionEndedEvent(ended, 'session-a'), {
    reason: 'exited',
    exit: { code: 0, signal: null },
  })
  assert.deepEqual(sessionEndedEvent(packet({ type: 'session_ended', reason: 'cap-reached', exit: { code: null, signal: null } }), 'session-a'), {
    reason: 'cap-reached', exit: { code: null, signal: null },
  }, 'the host reports the cap only after it proves the owned scope closed')
  assert.deepEqual(sessionEndedEvent(packet({ type: 'session_ended', reason: 'parent-stopped', exit: { code: null, signal: null } }), 'session-a'), {
    reason: 'parent-stopped', exit: { code: null, signal: null },
  })
  assert.equal(sessionEndedEvent(ended, 'session-b'), null, 'one session must not terminalize another')
  assert.equal(sessionEndedEvent(packet({ type: 'session_ended', reason: 'exited', exit: { code: 2 ** 31, signal: null } }), 'session-a'), null,
    'an exit code outside the signed 32-bit contract must be ignored')
  assert.equal(sessionEndedEvent(packet({ type: 'session_ended', reason: 'exited', exit: { code: null, signal: 'bad signal' } }), 'session-a'), null,
    'a malformed signal must not terminalize the owner')
  assert.equal(sessionEndedEvent(packet({ type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null }, surprise: true }), 'session-a'), null,
    'an expanded packet must be reviewed before it changes terminal state')
})

test('failure copy is carried only for a failed completion and is normalized without pinning its wording', () => {
  const refusal = packet({ type: 'turn_completed', status: 'error', text: '  Provider refusal with reset details.  ' })
  const success = packet({ type: 'turn_completed', status: 'completed', text: 'duplicate answer' })

  const failure = sessionTurnFailureText(refusal, 'session-a')
  assert.match(failure, /refusal.*reset/i, 'the provider failure sentence must retain the actionable refusal and reset meaning')
  assert.equal(failure, failure.trim(), 'failure copy must not carry surrounding transport whitespace')
  assert.equal(sessionTurnFailureText(success, 'session-a'), null, 'successful result copy must not duplicate the streamed answer')
  assert.equal(sessionTurnFailureText(packet({ type: 'turn_completed', status: 'error', text: '   ' }), 'session-a'), null, 'blank failure copy must remain absent')
})

test('real tool events preserve actionable fields and distinguish refusal, failure, and no-result outcomes', () => {
  const call = sessionActivityEvent(packet({
    type: 'tool_call', toolCallId: 'call-1', tool: 'Bash', payload: { command: 'node --version' },
  }), 'session-a')
  const refused = sessionActivityEvent(packet({
    type: 'tool_result', toolCallId: 'call-1', tool: 'Bash', status: 'declined',
    payload: { exitCode: -1, output: 'provider wording may change' },
  }), 'session-a')
  assert.equal(call.detail, 'node --version', 'a caller must receive the command a person is deciding about')

  const refusalBuffer = createActionBuffer()
  refusalBuffer.add(call, { turnId: 'turn-a', at: 10 })
  refusalBuffer.add(refused, { turnId: 'turn-a', at: 11 })
  assert.equal(refusalBuffer.list()[0].state, 'refused', 'a policy refusal must not be described as a command failure')

  const missingResultBuffer = createActionBuffer()
  missingResultBuffer.add({ ...call, toolCallId: 'call-2' }, { turnId: 'turn-a', at: 12 })
  const settled = missingResultBuffer.settleUnfinished()
  assert.equal(settled[0].state, 'unknown', 'a call whose result could not be read must not become success or failure')
})

test('a thinking event becomes its own activity row, never assistant text', () => {
  /* Owner, 2026-09-03: "more event types are fine we should be showing the
     user when the model is thinking anyway." Both engines forward reasoning
     as this one contract type; this is the reader that turns it into
     something a screen can show. */
  const thinking = sessionActivityEvent(packet({ type: 'thinking', turnId: 'turn-a', text: 'weighing the options' }), 'session-a')
  assert.equal(thinking.kind, 'thinking')
  assert.equal(thinking.output, 'weighing the options', 'the model\'s reasoning must reach the row, not be dropped')
  assert.equal(thinking.toolCallId, '', 'a thinking block has no tool call to join to')
  assert.equal(sessionEventText(packet({ type: 'thinking', text: 'weighing the options' }), 'session-a'), null,
    'reasoning must never be readable as assistant speech')
  assert.equal(sessionMessageBoundary(packet({ type: 'thinking', turnId: 'turn-a' }), 'session-a'), false,
    'a thinking block is not a spoken-message boundary')

  const buffer = createActionBuffer()
  const filed = buffer.add(thinking, { turnId: 'turn-a', at: 5 })
  assert.equal(filed.change, 'added')
  assert.equal(filed.row.kind, 'thinking')
  assert.equal(filed.row.state, 'done', 'a thinking block arrives whole, so it is never left in a running state')

  assert.equal(sessionActivityEvent(packet({ type: 'thinking', text: 7 }), 'session-a').output, '',
    'non-string reasoning content must not reach the row as text')
})

test('usage and filed-rule readers accept measured caller shapes but reject lookalikes', () => {
  const usage = sessionUsageEvent(packet({
    type: 'usage', turnId: 'turn-a', usage: {
      total: { inputTokens: 12, outputTokens: 4, note: 'do not render me' },
      modelContextWindow: 200_000,
    },
  }), 'session-a')
  assert.deepEqual(usage, {
    turnId: 'turn-a',
    usage: { inputTokens: 12, outputTokens: 4, modelContextWindow: 200_000 },
  }, 'usage must expose finite counters, not arbitrary prose from the event')

  const filing = sessionRuleFilingCall(packet({
    type: 'tool_call', toolCallId: 'rule-call', payload: {
      tool: 'r_ledger.file', arguments: { words: 'Keep answers concise.', actor: 'hidden' },
    },
  }), 'session-a')
  assert.deepEqual(filing, { toolCallId: 'rule-call', words: 'Keep answers concise.' }, 'a filing call must carry only its join id and the words shown to the user')

  const filed = sessionFiledRule(packet({
    type: 'tool_result', toolCallId: 'rule-call', payload: {
      tool: 'r_ledger.file', result: { structuredContent: { filed: true, id: 'R42', scope: 'agent', key: 'style', appliesTo: 'this agent', filedBy: 'agent' } },
    },
  }), 'session-a')
  assert.equal(filed?.id, 'R42', 'a measured successful ledger result must report the filed rule id')
  assert.equal(sessionFiledRule(packet({
    type: 'tool_result', payload: { tool: 'other.write', result: { filed: true, id: 'R42' } },
  }), 'session-a'), null, 'a lookalike result from another tool must not claim that a rule was filed')
})


test('textless reasoning start updates the working line without inventing a completed action or tool count', () => {
  const event = packet({ type: 'thinking', turnId: 'turn-a', itemId: 'reason-a', text: '', status: 'inProgress' })
  const activity = sessionActivityEvent(event, 'session-a')
  assert.equal(activityLine(activity), 'Thinking.')
  assert.equal(sessionActivityEvent(event, 'other-session'), null)
  assert.equal(sessionTurnStatus(event, 'session-a'), null)
  assert.equal(sessionEventText(event, 'session-a'), null)
  const buffer = createActionBuffer()
  const before = buffer.metrics('turn-a')
  assert.deepEqual(buffer.add(activity, { turnId: 'turn-a', at: 100 }), { row: null, change: 'ignored' })
  assert.deepEqual(buffer.metrics('turn-a'), before)
})

test('a cancelled native completion is not a success and is not a failed turn', () => {
  assert.equal(sessionTurnSucceeded('cancelled'), false)
  assert.equal(sessionTurnCancelled('cancelled'), true)
  assert.equal(nodeStatusForTurn('cancelled'), 'cancelled')
  assert.equal(nodeStatusForTurn('cancelled', { userStopped: true }), 'interrupted')
  assert.equal(nodeStatusForTurn('error'), 'turn-failed')
  assert.equal(nodeStatusForTurn('end_turn'), 'finished')
})

test('an approval row stays waiting until a confirmed answer, then is not waiting after the turn ends', () => {
  const buffer = createActionBuffer()
  const activity = sessionActivityEvent(packet({
    type: 'approval_request',
    approval: {
      approvalId: 'acp:permission:turn:1',
      kind: 'tool_permission',
      availableDecisions: [{ optionId: 'reject-once', name: 'Refuse', kind: 'reject_once' }],
      details: { toolCall: { title: 'host.list_processes' } },
    },
  }), 'session-a')
  buffer.add(activity, { turnId: 'turn-2', at: 20 })
  assert.equal(buffer.list()[0].state, 'waiting')
  assert.equal(buffer.list()[0].approvalId, 'acp:permission:turn:1')
  const kept = buffer.settleUnfinished({ keepWaitingIds: new Set(['acp:permission:turn:1']) })
  assert.equal(kept.length, 0)
  assert.equal(buffer.list()[0].state, 'waiting')
  const answered = buffer.answerApproval('acp:permission:turn:1', 'refused')
  assert.equal(answered.state, 'refused')
  const closed = createActionBuffer()
  closed.add(activity, { turnId: 'turn-2', at: 21 })
  assert.equal(closed.settleUnfinished()[0].state, 'closed')
})
