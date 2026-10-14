'use strict'

/* THE PERMISSION LEVEL, RECORDED IN THE SIGNED LEDGER -- and the widest level
 * refused unless the risk was shown and confirmed.
 *
 * WHAT WAS MISSING. `mc-setup:choose-tier` wrote the machine record and the
 * generated assistant configuration (shell/setup-record.cjs recordTier) and
 * wrote NOTHING to any ledger. A person moving this computer to the level at
 * which an agent can read, change and delete any file on it left no signed
 * trace of having done so; the record said only which level it held now. For
 * every other act this window takes as somebody -- creating an account, signing
 * in, starting an agent, changing a setting -- shell/main.cjs already writes to
 * the canonical chain (shell/canonical-audit.cjs). This is the same recorder
 * asked to hold the one decision the Terms are most concerned with.
 *
 * THE OWNER'S RULING (X4, 2026-08-15) in four clauses, and where each lands:
 *   default OFF                -> src/setup-state.js DEFAULT_TIER; not this file
 *   the risk stated in words   -> src/unrestricted-consent.js; the words arrive
 *                                 here INSIDE the consent and are recorded
 *   recorded in the ledger     -> tierChoiceDetails() and auditedTierChoice()
 *   re-warned on re-enable     -> the gate in the renderer asks every time; this
 *                                 file requires the consent every time the level
 *                                 CHANGES to the widest one
 *
 * IT REFUSES, IN THE SHELL, WHAT THE SCREEN PROMISES. A renderer that forgot to
 * ask -- a future edit, a different screen, a stale bundle -- cannot widen this
 * computer to full access, because the write refuses without a confirmed
 * consent carrying the words. The invariant lives below the surface, where the
 * screen cannot mislay it. A machine that ALREADY holds the widest level may
 * re-record it without consent: re-recording is not enabling, and refusing it
 * would strand the walkthrough on a machine whose owner chose this on purpose.
 *
 * WHAT THE RECORD SAYS. Two rows per change, the shape auditedAccountAction in
 * shell/main.cjs uses and for its reason -- the intent is written BEFORE the
 * disk moves, so a change that could not be recorded is a change that did not
 * happen; the outcome is written after, and is written even when the write
 * refused. The details carry which level from which, whether the risk was
 * shown and confirmed, the SHA-256 of the words that were shown AND the words
 * themselves, so a later reader can prove WHICH sentences a person confirmed
 * rather than that "a warning" was displayed. No secret is anywhere near this:
 * a level, a principal digest, a paragraph of the product's own Terms.
 *
 * ABSENT IS NOT FAILED, exactly as accounts and launches draw it. A copy with
 * no capability payload has no ledger to be missing from and proceeds -- a
 * stated limit of such an install. A ledger that is PRESENT and refuses stops
 * the change, and the reason handed back says what happened and what to do.
 *
 * THIS FILE HOLDS NO ELECTRON. Every dependency -- the recorder, the finder,
 * the clock -- is passed in, so tools/test/tier-consent-shell.test.mjs drives
 * every branch without a window.
 */

const crypto = require('node:crypto')

const UNRESTRICTED_TIER = 'unrestricted'
const TIER_CHOICE_ACTION = 'setup.tier.choose'
const TIER_CHOICE_INTENT_ACTION = `${TIER_CHOICE_ACTION}.intent`
const MAX_RISK_TEXT_BYTES = 4000
const CONSENT_SOURCES = new Set(['setup', 'settings'])

const tierTarget = tier => `tier:${tier}`

function failure(code, reason) {
  return { ok: false, code, reason }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The consent as the renderer sent it, reduced to the five fields this file
 * records. Anything else is dropped; a malformed shape is `null`, which every
 * caller treats as "no consent was given".
 */
function normalizeConsent(value) {
  if (!isPlainObject(value)) return null
  const riskText = typeof value.riskText === 'string' ? value.riskText : ''
  if (riskText.length === 0 || Buffer.byteLength(riskText, 'utf8') > MAX_RISK_TEXT_BYTES) return null
  return Object.freeze({
    riskShown: value.riskShown === true,
    confirmed: value.confirmed === true,
    riskText,
    shownAtMs: Number.isSafeInteger(value.shownAtMs) ? value.shownAtMs : null,
    via: CONSENT_SOURCES.has(value.via) ? value.via : null,
  })
}

/** Is a confirmed consent required to record this move? */
function requiresConsent({ tier, previousTier }) {
  return tier === UNRESTRICTED_TIER && previousTier !== UNRESTRICTED_TIER
}

/** Which moves the signed ledger holds: every move INTO the widest level and
 * every move OUT of it (and its re-records), so the record reads as the full
 * enable/disable chain of the one level the Terms are about.
 *
 * A confined level moving to a confined level is deliberately NOT here, and
 * the reason is measured rather than aesthetic: the very first Continue on a
 * fresh install is exactly that move, it lands while the capability layer is
 * still writing its own first-boot records into the same fresh ledger, and
 * the admission contention between the two writers held the walkthrough's
 * save past ten seconds (tools/setup-walkthrough-qa.mjs, reproduced 2026-08-18
 * on a staged packaged build; a four-second settle made the same build pass).
 * The ruling this file implements requires the record for the FULL-ACCESS
 * choice; taxing the recommended path's first save with it bought no record
 * anybody asked for at the cost of the first minute of the product. */
function recordsOnLedger({ tier, previousTier }) {
  return tier === UNRESTRICTED_TIER || previousTier === UNRESTRICTED_TIER
}

/**
 * Admit or refuse a tier choice BEFORE anything is written or recorded.
 * @returns {{ok:true, consent:object|null}|{ok:false, code:string, reason:string}}
 */
function checkTierChoice({ tier, previousTier = null, consent = null }) {
  const normalized = normalizeConsent(consent)
  if (!requiresConsent({ tier, previousTier })) return { ok: true, consent: normalized }
  if (!normalized || normalized.riskShown !== true || normalized.confirmed !== true) {
    return failure(
      'SETUP_UNRESTRICTED_UNCONFIRMED',
      'Full access was not turned on. This level is only recorded after the risk has been shown and you have confirmed it. Choose it again and answer the question that appears.',
    )
  }
  return { ok: true, consent: normalized }
}

function riskTextSha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * The details written on both rows. Same fields on the intent and the outcome
 * so a reader of either row knows what was chosen and on what showing.
 */
function tierChoiceDetails({ tier, previousTier = null, consent = null, principal = null, via = null }) {
  const normalized = normalizeConsent(consent)
  return {
    surface: 'app.ipc',
    principal: typeof principal === 'string' && principal.length > 0 ? principal : null,
    from: typeof previousTier === 'string' ? previousTier : null,
    to: tier,
    riskShown: normalized ? normalized.riskShown : false,
    riskConfirmed: normalized ? normalized.confirmed : false,
    riskTextSha256: normalized ? riskTextSha256(normalized.riskText) : null,
    riskText: normalized ? normalized.riskText : null,
    riskShownAtMs: normalized ? normalized.shownAtMs : null,
    via: normalized && normalized.via ? normalized.via : (CONSENT_SOURCES.has(via) ? via : null),
  }
}

/**
 * Record the intent, run the write, record the outcome.
 *
 * @param {object} input
 * @param {string} input.tier            the level requested
 * @param {string|null} input.previousTier the level the machine holds now
 * @param {object|null} input.consent    what the renderer sent
 * @param {string} input.principal       read in the main process, never from the page
 * @param {(action:string,target:string,details:object)=>Promise<{ok:boolean,sequence?:number,code?:string}>} input.record
 * @param {()=>object} input.run          the write; returns recordTier's result
 * @returns {Promise<object>} recordTier's result with `recorded` attached, or a refusal
 *
 * ASYNCHRONOUS BECAUSE THE RECORDER IS. shell/canonical-audit.cjs moved the
 * canonical write off the Electron main thread, where its anchor read and
 * anchor write were each a synchronous powershell.exe. `await` here changes
 * nothing about the order this file is built on -- intent, then the write, then
 * the outcome -- and it passes a plain value straight through, so a caller that
 * hands in a synchronous recorder (every test in tools/test does) behaves
 * exactly as it did.
 */
async function auditedTierChoice({ tier, previousTier = null, consent = null, principal = null, record, run }) {
  const admitted = checkTierChoice({ tier, previousTier, consent })
  if (!admitted.ok) return admitted

  /* A confined level moving to a confined level: the pre-existing write, at
     its pre-existing cost, with no ledger anywhere near it. See
     recordsOnLedger for the measured reason. */
  if (!recordsOnLedger({ tier, previousTier })) {
    try {
      return run()
    } catch (error) {
      return failure(typeof error?.code === 'string' ? error.code : 'SETUP_TIER_WRITE_FAILED', 'The permission level could not be saved on this computer.')
    }
  }

  const target = tierTarget(tier)
  const details = tierChoiceDetails({ tier, previousTier, consent: admitted.consent, principal })

  let intent
  try {
    intent = await record(TIER_CHOICE_INTENT_ACTION, target, details)
  } catch (error) {
    intent = failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'the recorder threw')
  }
  if (!isPlainObject(intent)) {
    intent = failure('AUDIT_UNAVAILABLE', 'the recorder returned no receipt')
  }
  const ledgerAbsent = !intent.ok && intent.code === 'AUDIT_PAYLOAD_ABSENT'
  /* THE FAIL-CLOSED GATE POINTS IN EXACTLY ONE DIRECTION: INTO full access.
     Enabling the widest level without a signed record would be the gap the
     ruling closes, so that refuses. A move OUT of the widest level (or a
     re-record of it) proceeds even when the ledger refuses -- a person must
     never be trapped AT full access by a sick ledger -- and the missing
     record is reported rather than pretended. */
  if (!intent.ok && !ledgerAbsent && requiresConsent({ tier, previousTier })) {
    return failure(
      'SETUP_AUDIT_UNAVAILABLE',
      'The permission level was not changed. The change could not be recorded in the signed ledger, and this product does not change a permission it cannot record. This computer stays at the level it had. Try again in a moment; if it keeps happening, restart the application.',
    )
  }

  let result
  try {
    result = run()
  } catch (error) {
    result = failure(typeof error?.code === 'string' ? error.code : 'SETUP_TIER_WRITE_FAILED', 'The permission level could not be saved on this computer.')
  }
  const outcome = Boolean(result && result.ok === true)

  let recorded
  if (ledgerAbsent) {
    recorded = { ok: false, code: 'AUDIT_PAYLOAD_ABSENT' }
  } else if (!intent.ok) {
    /* A leave/re-record whose intent the ledger refused: the move happened
       and the record did not, and the answer says exactly that. */
    recorded = { ok: false, code: intent.code }
  } else {
    try {
      const receipt = await record(TIER_CHOICE_ACTION, target, {
        ...details,
        outcome: outcome ? 'ok' : 'refused',
        code: outcome ? null : (typeof result?.code === 'string' ? result.code : 'UNKNOWN'),
        intentSequence: intent.ok ? intent.sequence : null,
      })
      recorded = receipt && receipt.ok === true
        ? (receipt.disposition === 'not-required'
          ? receipt
          : { ok: true, sequence: receipt.sequence, intentSequence: intent.sequence })
        : { ok: false, code: typeof receipt?.code === 'string' ? receipt.code : 'AUDIT_UNAVAILABLE' }
    } catch (error) {
      recorded = { ok: false, code: typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE' }
    }
  }
  const auditPair = recorded?.disposition === 'not-required' ? { intentAudit: intent } : {}
  return outcome ? { ...result, recorded, ...auditPair } : { ...(result || failure('SETUP_TIER_WRITE_FAILED', 'The permission level could not be saved on this computer.')), recorded, ...auditPair }
}

/**
 * What the ledger says about the widest level: is a CONFIRMED choice of it on
 * record, and when was the newest one made. Rows whose outcome was refused, or
 * whose risk was not confirmed, do not count -- so a legacy machine that
 * reached the widest level before this record existed reads `recorded:false`,
 * never as consent nobody gave.
 *
 * @param {object} input
 * @param {(selector:{action:string,target:string,limit:number})=>Array} input.findEvents
 */
function readConsentState({ findEvents, limit = 200 } = {}) {
  if (typeof findEvents !== 'function') {
    return failure('AUDIT_PAYLOAD_ABSENT', 'This copy carries no ledger reader, so whether the risk was confirmed cannot be read.')
  }
  let events
  try {
    events = findEvents({ action: TIER_CHOICE_ACTION, target: tierTarget(UNRESTRICTED_TIER), limit })
  } catch (error) {
    return failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'The signed record could not be read.')
  }
  return consentStateFromEvents(events)
}

async function readConsentStateAsync({ findEvents, limit = 200 } = {}) {
  if (typeof findEvents !== 'function') return readConsentState({ findEvents, limit })
  try {
    const events = await findEvents({ action: TIER_CHOICE_ACTION, target: tierTarget(UNRESTRICTED_TIER), limit })
    return consentStateFromEvents(events)
  } catch (error) {
    return failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'The signed record could not be read.')
  }
}

function consentStateFromEvents(events) {
  if (!Array.isArray(events)) return failure('AUDIT_UNAVAILABLE', 'The signed record could not be read.')
  const confirmed = events
    .filter(entry => entry && entry.event && entry.event.details
      && entry.event.details.outcome === 'ok' && entry.event.details.riskConfirmed === true)
    .sort((left, right) => (right.sequence || 0) - (left.sequence || 0))
  if (confirmed.length === 0) return { ok: true, recorded: false, sequence: null, atMs: null, via: null }
  const newest = confirmed[0]
  const atMs = Number.isSafeInteger(newest.occurredAtMs)
    ? newest.occurredAtMs
    : (Number.isFinite(Date.parse(newest.event.timestamp)) ? Date.parse(newest.event.timestamp) : null)
  return {
    ok: true,
    recorded: true,
    sequence: Number.isSafeInteger(newest.sequence) ? newest.sequence : null,
    atMs,
    via: newest.event.details.via || null,
  }
}

module.exports = {
  TIER_CHOICE_ACTION,
  TIER_CHOICE_INTENT_ACTION,
  UNRESTRICTED_TIER,
  auditedTierChoice,
  checkTierChoice,
  normalizeConsent,
  readConsentState,
  readConsentStateAsync,
  recordsOnLedger,
  requiresConsent,
  riskTextSha256,
  tierChoiceDetails,
  tierTarget,
}
