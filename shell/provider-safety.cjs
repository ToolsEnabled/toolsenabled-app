'use strict'

function isProviderSafetyRefusal(event) {
  const failure = event?.payload?.failure
  const code = failure?.code || event?.code || event?.error?.code
  return code === 'misalignmentPolicyViolation' || code === 'misalignment_policy_violation'
    || failure?.category === 'safety-policy'
    // A turn the provider ended as a refusal: ACP's stopReason "refusal" and Claude's stop_reason "refusal".
    || (event?.type === 'turn_completed' && event?.status === 'refusal')
}

const SAFETY_BLOCK = Object.freeze({ code: 'PROVIDER_SAFETY_REFUSAL', reason: 'safety-policy' })

/* A PROVIDER THAT REFUSED THE MODEL this session asked for (1.0.50 review CM-2). The engine marks it with
   category 'model-refused' (Codex when its reason names the requested model, Claude on the CLI's measured
   sentence). Every automatic send would be refused the same way, so they are held like a safety refusal; unlike
   one, the hold ends when a turn on the session succeeds. A safety refusal is never a model refusal. */
function isProviderModelRefusal(event) {
  return event?.type === 'turn_completed' && event?.payload?.failure?.category === 'model-refused'
    && !isProviderSafetyRefusal(event)
}

const MODEL_REFUSAL_BLOCK = Object.freeze({ code: 'PROVIDER_MODEL_REFUSED', reason: 'model-refused' })
const REFUSAL_SENTENCE = 'The provider refused this request. Nothing more was sent to it automatically.'

/* The completion every surface reads for a refused turn: failed, with the safety category the page and the
   saved record recognise, and the provider's own words or, when it gave none, a plain sentence. */
function safetyRefusalEvent(event) {
  const failure = event?.payload?.failure
  const recognised = failure?.category === 'safety-policy' || Boolean(failure?.code)
  const said = typeof event?.text === 'string' && event.text.trim().length > 0
  return Object.freeze({ ...event, status: 'failed',
    ...(recognised ? {} : { payload: { ...(event?.payload || {}), failure: { category: 'safety-policy', code: SAFETY_BLOCK.code, summary: REFUSAL_SENTENCE } } }),
    ...(said || recognised ? {} : { text: REFUSAL_SENTENCE }) })
}

module.exports = { isProviderSafetyRefusal, isProviderModelRefusal, safetyRefusalEvent, SAFETY_BLOCK, MODEL_REFUSAL_BLOCK, REFUSAL_SENTENCE }
