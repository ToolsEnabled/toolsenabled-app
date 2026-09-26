import test from 'node:test'
import assert from 'node:assert/strict'

import { approvalDecisionIds, sessionActivityEvent } from '../../src/agent-session-events.js'
import { APPROVAL_PANEL, approvalCardChoices } from '../../src/fleet-tree-copy.js'
import { APPROVAL_ANSWER_TIMEOUT_MS, answerWithinBound, createPendingApprovals } from '../../src/approval-answer.js'

test('answering one of several tool permissions preserves every other pending request', () => {
  const pending = createPendingApprovals()
  pending.set('one', { approvalId: 'a', availableDecisions: ['allow-once'] })
  pending.set('one', { approvalId: 'b', availableDecisions: ['reject-once'] })
  pending.set('two', { approvalId: 'c' })
  assert.deepEqual(pending.all('one').map(row => row.approvalId), ['a', 'b'])
  assert.equal(pending.get('one').approvalId, 'a')
  pending.settle('one', 'a')
  assert.equal(pending.get('one').approvalId, 'b')
  assert.equal(pending.get('two').approvalId, 'c')
  assert.equal(pending.settle('one', 'a'), false)
  assert.equal(pending.get('one').approvalId, 'b', 'a repeated or late answer cannot erase another request')
  pending.delete('one')
  pending.set('one', { approvalId: 'new-turn' })
  assert.equal(pending.settle('one', 'b'), false)
  assert.equal(pending.get('one').approvalId, 'new-turn')
  assert.equal(pending.get('two').approvalId, 'c')
})

test('an ACP option id remains opaque even if it matches a structured Codex decision name', () => {
  const choices = approvalCardChoices(['applyNetworkPolicyAmendment'], { applyNetworkPolicyAmendment: 'reject_once' })
  assert.deepEqual(choices.decisions, ['applyNetworkPolicyAmendment'])
  assert.deepEqual(approvalCardChoices(['applyNetworkPolicyAmendment']).decisions, [])
})

/* AN APPROVAL NOBODY CAN ANSWER IS THE FAILURE THIS SUITE EXISTS FOR.
 *
 * The whole reply path was landed BEFORE any approval could fire, on the stated
 * ground that the day one fired with no way to answer it the turn would hang
 * forever (shell/agent-host.cjs answerApproval, shell/agent-notifications.cjs).
 * That promise did not hold: the reader kept only `typeof decision === 'string'`
 * entries of availableDecisions and NEITHER engine has ever emitted a string, so
 * every real request reached the card with an empty list and drew a headline
 * over an empty row of buttons.
 *
 * THE FIXTURES BELOW ARE THE ENGINES' OWN SHAPES, copied from the emitters, not
 * invented here. That is the point: the suites that were green over this defect
 * were green because their fixtures said `['accept', 'decline']`, a shape no
 * adapter produces. A fixture nobody emits cannot fail. */

/* src/lib/agent-engine/codex-adapter.js -- approvalChoices('commandExecution'),
   which maps COMMAND_DECISIONS through `value => Object.freeze({ value })`. */
const CODEX_COMMAND_CHOICES = [
  { value: 'accept' },
  { value: 'acceptForSession' },
  { value: 'acceptWithExecpolicyAmendment' },
  { value: 'applyNetworkPolicyAmendment' },
  { value: 'decline' },
  { value: 'cancel' },
]

/* approvalChoices('permissions') -- a RESPONSE SCHEMA, carrying no identifier
   any button could send. Its adapter answers it with a permissions+scope
   record, never with one word. */
const CODEX_PERMISSIONS_CHOICES = [
  { responseFields: ['permissions', 'scope', 'strictAutoReview'], scopes: ['turn', 'session'] },
]

/* src/lib/agent-engine/claude-adapter.js -- _handleAgentRequest() forwards the
   ACP option records themselves as availableDecisions. */
const CLAUDE_PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
]

function approvalPacket(availableDecisions, { kind = 'commandExecution', sessionId = 'session-approve' } = {}) {
  return {
    sessionId,
    event: {
      type: 'approval_request',
      approval: {
        approvalId: 'codex:applyPatchApproval:7',
        kind,
        availableDecisions,
        details: { command: 'printf hello' },
      },
    },
  }
}

test('a command approval in the shape codex really emits reaches the card with choices to press', () => {
  const activity = sessionActivityEvent(approvalPacket(CODEX_COMMAND_CHOICES), 'session-approve')

  assert.equal(activity?.kind, 'approval')
  assert.equal(activity.approvalId, 'codex:applyPatchApproval:7')
  assert.deepEqual(activity.availableDecisions, [
    'accept', 'acceptForSession', 'acceptWithExecpolicyAmendment',
    'applyNetworkPolicyAmendment', 'decline', 'cancel',
  ], 'the decisions the engine offered must survive the reader — an empty list is a question nobody can answer')
})

test('a Claude permission request in the shape the ACP adapter emits reaches the card with choices to press', () => {
  const activity = sessionActivityEvent(
    approvalPacket(CLAUDE_PERMISSION_OPTIONS, { kind: 'tool_permission' }), 'session-approve')

  assert.deepEqual(activity?.availableDecisions, ['allow', 'allow_always', 'reject_once'],
    'the option ids are what the reply names; dropping them leaves the request unanswerable')
})

test('the reader still carries a bare-string vocabulary, so nothing that worked stopped working', () => {
  const activity = sessionActivityEvent(approvalPacket(['accept', 'decline']), 'session-approve')

  assert.deepEqual(activity?.availableDecisions, ['accept', 'decline'])
})

test('a request whose choices carry no identifier at all reports nothing pressable rather than inventing one', () => {
  const activity = sessionActivityEvent(
    approvalPacket(CODEX_PERMISSIONS_CHOICES, { kind: 'permissions' }), 'session-approve')

  assert.equal(activity?.kind, 'approval', 'the request itself is still real and still pending')
  assert.deepEqual(activity.availableDecisions, [],
    'a response schema is not a choice; turning one into a button would draw a press that cannot be sent')
})

test('the decision list stays bounded, deduplicated and free of junk entries', () => {
  assert.deepEqual(approvalDecisionIds(['accept', 'accept', { value: 'accept' }]), ['accept'],
    'the same decision offered twice must produce one button, not two')
  assert.deepEqual(approvalDecisionIds(['x'.repeat(513), { value: 'y'.repeat(513) }, 'decline']), ['decline'],
    'an over-long identifier is dropped, exactly as it was before')
  assert.deepEqual(approvalDecisionIds([null, 7, [], {}, { value: 4 }, { optionId: null }, 'cancel']), ['cancel'],
    'nothing that is not an identifier may become a button')
  assert.equal(approvalDecisionIds(Array.from({ length: 40 }, (_, index) => `d${index}`)).length, 32,
    'the list is capped at the same 32 the Claude adapter enforces on the wire')
  assert.deepEqual(approvalDecisionIds(undefined), [], 'an absent list is an empty list, never a throw')
})

test('the card offers exactly the decisions this build can send back, and nothing it cannot', () => {
  const activity = sessionActivityEvent(approvalPacket(CODEX_COMMAND_CHOICES), 'session-approve')
  const choices = approvalCardChoices(activity.availableDecisions)

  assert.deepEqual(choices.decisions, ['accept', 'acceptForSession', 'decline', 'cancel'],
    'the two structured decisions the codex adapter refuses by name must not be drawn as buttons')
  assert.equal(choices.note, '', 'a card with real choices needs no explanation in place of them')
})

test('a request with nothing pressable says so instead of standing empty', () => {
  const activity = sessionActivityEvent(
    approvalPacket(CODEX_PERMISSIONS_CHOICES, { kind: 'permissions' }), 'session-approve')
  const choices = approvalCardChoices(activity.availableDecisions)

  assert.deepEqual(choices.decisions, [])
  assert.equal(choices.note, APPROVAL_PANEL.unanswerable)
  assert.ok(choices.note.length > 0, 'an empty card over a stopped agent is the defect, not the fix')
})

test('every decision the engine could offer alone is either pressable or explained — never silently nothing', () => {
  /* The whole vocabulary, one at a time. Each single-choice request must end
     with either a button or a sentence; a card with neither is the state a
     person cannot get out of. */
  const everyDecision = [
    ...CODEX_COMMAND_CHOICES,
    ...CLAUDE_PERMISSION_OPTIONS,
    ...CODEX_PERMISSIONS_CHOICES,
    { value: 'accept' },
  ]
  for (const decision of everyDecision) {
    const activity = sessionActivityEvent(approvalPacket([decision]), 'session-approve')
    const choices = approvalCardChoices(activity.availableDecisions)
    assert.ok(choices.decisions.length > 0 || choices.note.length > 0,
      `a request offering ${JSON.stringify(decision)} left the card with no button and no reason`)
  }
})

/* ------------------------------------------------------------ the timeout path */

test('an answer that never comes back is reported, not waited on forever', async () => {
  let armedFor = null
  const never = new Promise(() => {})
  const result = await answerWithinBound(never, {
    timeoutMs: 1234,
    setTimer: (fire, ms) => { armedFor = ms; fire(); return 'handle' },
    clearTimer: () => {},
  })

  assert.equal(result.timedOut, true, 'a press the main process never answers must not hang the door')
  assert.equal(result.answered, null, 'an elapsed bound settles nothing — it only reports')
  assert.equal(armedFor, 1234, 'the bound must be the one the caller asked for')
})

test('the real clock reaches the same answer, with no injected timer at all', async () => {
  const result = await answerWithinBound(new Promise(() => {}), { timeoutMs: 5 })

  assert.deepEqual({ ...result }, { answered: null, timedOut: true })
})

test('an answer that lands is returned unchanged and leaves no timer behind', async () => {
  const cleared = []
  const answer = { sessionId: 'session-approve', approvalId: 'codex:applyPatchApproval:7', decision: 'accept' }
  const result = await answerWithinBound(() => Promise.resolve(answer), {
    timeoutMs: 60_000,
    setTimer: () => 'timer-handle',
    clearTimer: handle => cleared.push(handle),
  })

  assert.equal(result.answered, answer, 'the engine\'s own answer must reach the caller unchanged')
  assert.equal(result.timedOut, false)
  assert.deepEqual(cleared, ['timer-handle'], 'an answered press must not leave a timer running behind a closed card')
})

test('a refused, absent or throwing door is an answer that did not land, never a timeout and never a throw', async () => {
  const explicit = await answerWithinBound(() => ({ ok: false, error: { message: 'Answer refused' } }))
  assert.deepEqual({ ...explicit }, { answered: null, timedOut: false })
  const rejected = await answerWithinBound(() => Promise.reject(new Error('AGENT_SESSION_UNKNOWN')))
  assert.deepEqual({ ...rejected }, { answered: null, timedOut: false })

  const absent = await answerWithinBound(() => undefined)
  assert.deepEqual({ ...absent }, { answered: null, timedOut: false })

  const threw = await answerWithinBound(() => { throw new TypeError('bridge is not a function') })
  assert.deepEqual({ ...threw }, { answered: null, timedOut: false },
    'a door that throws before it returns a promise must not throw past the card')
})

test('reusing an approval ID in a later turn cannot inherit an earlier answer in flight', () => {
  const pending = createPendingApprovals()
  const first = { approvalId: 'reused', turnId: 'first' }
  pending.set('session', first)
  const answering = pending.beginAnswer('session', 'reused')
  const next = { approvalId: 'reused', turnId: 'next' }
  pending.set('session', next)
  assert.equal(pending.endAnswer('session', 'reused', answering), false)
  assert.equal(pending.get('session'), next)
  assert.equal(pending.answering('session', 'reused'), false)
  assert.equal(pending.settle('session', 'reused', first), false)
  assert.equal(pending.get('session'), next)
})

test('the shipped bound is a real, finite number of milliseconds', () => {
  assert.ok(Number.isSafeInteger(APPROVAL_ANSWER_TIMEOUT_MS) && APPROVAL_ANSWER_TIMEOUT_MS > 0,
    'an unbounded or absent default would put the silent-press defect straight back')
})
