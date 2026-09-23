'use strict'

/* WHAT A PERSON IS TOLD WHEN A SESSION COULD NOT BE RECORDED.
 *
 * shell/main.cjs's recordSpawnIntent refuses a start whose canonical audit
 * record could not be written. That refusal is deliberate and is not what this
 * module changes -- see the comment above the gate there ("there is a ledger,
 * it declined to record, and starting anyway is exactly the silent gap being
 * fixed").
 *
 * WHAT IT CHANGES IS THE SENTENCE. shell/canonical-audit.cjs answers a refusal
 * as `{ ok: false, code, reason }` -- its own JSDoc says so -- and the gate
 * printed only `code`. So an owner whose agents stopped read
 *
 *     The agent session was not started because it could not be recorded: AUDIT_UNAVAILABLE
 *
 * and nothing else, for every distinct cause: a busy ledger, a poisoned anchor,
 * a full disk, a disabled setting. src/lib/audit.js's own note on
 * unavailableRefusal is about exactly this loss -- "all 55 AUDIT_UNAVAILABLE
 * refusals in capability/logs/actions.jsonl recorded exactly one string ... with
 * no reason field anywhere in the record" -- and it composes the classification
 * INTO its message so a caller that carries the message carries the diagnosis.
 * This gate dropped that message on the floor. Measured again 2026-09-07:
 * two session starts refused at 05:53:08Z and 05:54:31Z with the bare code, and
 * the ledger accepted other writes 23 seconds either side of both.
 *
 * It lives in its own file because shell/main.cjs cannot be required by a test
 * -- it needs Electron, and all 34 suites that touch it read it as TEXT. A
 * sentence nothing can call with values is a sentence nothing can test.
 */

/* The code to print when the refusal carried none. Kept as the audit contract's
   own name rather than a local invention, so a reader grepping for it lands in
   src/lib/audit.js. */
const FALLBACK_AUDIT_CODE = 'AUDIT_UNAVAILABLE'
const FALLBACK_RECORD_CODE = 'SPAWN_RECORD_UNAVAILABLE'

const HEAD = 'The agent session was not started because it could not be recorded: '

/**
 * Compose the refusal a stopped start is reported with.
 *
 * @param {{code?: unknown, reason?: unknown, message?: unknown}} refusal
 *        The `{ ok:false, code, reason }` shape shell/canonical-audit.cjs
 *        returns, or a thrown Error (whose `message` carries the same words).
 * @param {string} fallbackCode Code to use when the refusal named none.
 * @returns {string}
 */
function sessionStartRefusalSentence(refusal, fallbackCode = FALLBACK_AUDIT_CODE) {
  const code = typeof refusal?.code === 'string' && refusal.code ? refusal.code : fallbackCode
  /* `reason` is the refusal object's field; `message` is the same words when the
     record path threw instead of returning. Only a real string travels: a reason
     that is an object or absent leaves the sentence exactly as it has always
     read, which is what keeps this from adding "undefined" to a line an owner
     sees at the worst moment. */
  const carried = typeof refusal?.reason === 'string' && refusal.reason.trim()
    ? refusal.reason.trim()
    : (typeof refusal?.message === 'string' && refusal.message.trim() ? refusal.message.trim() : '')
  return carried ? `${HEAD}${code}. ${carried}` : HEAD + code
}

module.exports = { sessionStartRefusalSentence, FALLBACK_AUDIT_CODE, FALLBACK_RECORD_CODE }
