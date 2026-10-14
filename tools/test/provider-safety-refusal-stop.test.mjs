import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const req = createRequire(import.meta.url)
const { isProviderSafetyRefusal, isProviderModelRefusal, safetyRefusalEvent, REFUSAL_SENTENCE } = req('../../shell/provider-safety.cjs')
const { sessionSafetyRefusal, sessionModelRefusal, sessionTurnStatus, sessionTurnFailureText } = await import('../../src/agent-session-events.js')

/* The host holds automatic follow-ups (queued messages, peer deliveries) after a provider's safety refusal
   (agent-host.cjs, session.safetyBlocked). A provider that ends the turn itself as a refusal -- ACP's
   stopReason "refusal", which the ACP adapter reports as the turn status, and Claude's stop_reason "refusal",
   which the Claude CLI adapter reports the same way -- is that refusal too, never an ordinary end of turn. */
test('a turn the provider ended as a refusal is a safety refusal', () => {
  assert.equal(isProviderSafetyRefusal({ type: 'turn_completed', status: 'refusal' }), true)
})

test('ordinary ends of a turn are not refusals', () => {
  for (const status of ['end_turn', 'max_tokens', 'cancelled', 'completed', 'success', 'error', 'interrupted', 'failed']) {
    assert.equal(isProviderSafetyRefusal({ type: 'turn_completed', status }), false, status)
  }
  assert.equal(isProviderSafetyRefusal({ type: 'assistant_text_delta', status: 'refusal' }), false)
})

test('the existing safety codes still count', () => {
  assert.equal(isProviderSafetyRefusal({ type: 'turn_completed', status: 'failed', payload: { failure: { code: 'misalignmentPolicyViolation' } } }), true)
  assert.equal(isProviderSafetyRefusal({ type: 'turn_completed', status: 'failed', payload: { failure: { category: 'safety-policy' } } }), true)
})

test('a refusal stop reaches the page as a safety refusal with a sentence', () => {
  const event = safetyRefusalEvent({ type: 'turn_completed', turnId: 't1', status: 'refusal' })
  const packet = { sessionId: 's', event }
  assert.equal(sessionSafetyRefusal(packet, 's'), true)
  assert.equal(sessionTurnStatus(packet, 's'), 'failed')
  assert.equal(sessionTurnFailureText(packet, 's'), REFUSAL_SENTENCE)
})

test('a refusal keeps the provider\'s own words and Codex safety codes unchanged', () => {
  const worded = safetyRefusalEvent({ type: 'turn_completed', status: 'refusal', text: 'I cannot help with that.' })
  assert.equal(sessionTurnFailureText({ sessionId: 's', event: worded }, 's'), 'I cannot help with that.')
  const codex = { type: 'turn_completed', status: 'failed', text: 'Blocked.', payload: { failure: { code: 'misalignmentPolicyViolation' } } }
  assert.deepEqual(safetyRefusalEvent(codex).payload, codex.payload)
  assert.equal(safetyRefusalEvent(codex).text, 'Blocked.')
})

test('the saved record of a refusal stop keeps a plain summary, not a generic failure', () => {
  const event = safetyRefusalEvent({ type: 'turn_completed', status: 'refusal', text: 'I cannot help with that.' })
  /* shell/node-transcript-capture.cjs reads payload.failure.summary for the durable record; without it a
     reopened chat showed "No safe failure detail was recorded". */
  assert.equal(event.payload.failure.summary, REFUSAL_SENTENCE)
  assert.match(REFUSAL_SENTENCE, /^[\x20-\x7E]+$/)
  assert.ok(REFUSAL_SENTENCE.length <= 260)
})

/* 1.0.50 review CM-2. A provider that refused the session's model (the engine's 'model-refused' failure) holds
   automatic sends too, but it is not a safety refusal: the turn keeps its own status and words, and the hold ends
   when a turn succeeds. A safety refusal is never read as a model refusal. */
test('a model refusal is its own hold, never a safety refusal', () => {
  const event = { type: 'turn_completed', status: 'failed', text: 'Codex refused this model: no access.',
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: 'Codex refused this model: no access.', category: 'model-refused' } } }
  assert.equal(isProviderModelRefusal(event), true)
  assert.equal(isProviderSafetyRefusal(event), false)
  assert.equal(sessionModelRefusal({ sessionId: 's', event }, 's'), true)
  assert.equal(sessionModelRefusal({ sessionId: 's', event }, 'other'), false)
  assert.equal(sessionSafetyRefusal({ sessionId: 's', event }, 's'), false)
  assert.equal(sessionTurnFailureText({ sessionId: 's', event }, 's'), 'Codex refused this model: no access.')
  const claude = { type: 'turn_completed', status: 'error', text: "There's an issue with the selected model (x).",
    payload: { failure: { provider: 'claude', source: 'turn', category: 'model-refused' } } }
  assert.equal(isProviderModelRefusal(claude), true)
  assert.equal(sessionTurnStatus({ sessionId: 's', event: claude }, 's'), 'error')
  for (const other of [
    { type: 'turn_completed', status: 'failed', payload: { failure: { category: 'safety-policy' } } },
    { type: 'turn_completed', status: 'refusal', payload: { failure: { category: 'model-refused' } } },
    { type: 'turn_completed', status: 'failed', payload: { failure: { code: 'other' } } },
    { type: 'assistant_text_delta', payload: { failure: { category: 'model-refused' } } },
  ]) {
    assert.equal(isProviderModelRefusal(other), false, JSON.stringify(other))
    assert.equal(sessionModelRefusal({ sessionId: 's', event: other }, 's'), false, JSON.stringify(other))
  }
})
