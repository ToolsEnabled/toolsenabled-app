/* THE MOMENT OF CHOOSING FULL ACCESS: the words, and the gate that shows them.
 *
 * The owner's ruling (X4, 2026-08-15) on the one configuration in which this
 * product lets an AI agent reach the whole computer -- the `unrestricted`
 * permission level -- is four clauses, and this module is where they live:
 *
 *   DEFAULT OFF.        The walkthrough preselects the narrowest level
 *                       (src/setup-state.js DEFAULT_TIER) and nothing here is
 *                       reachable without an explicit press on the widest one.
 *   THE MOMENT.         When a person picks the widest level -- in Setup and in
 *                       Settings alike -- the risk is stated IN THE TERMS' OWN
 *                       WORDS, on the screen, at that moment, and they are asked
 *                       to confirm. Declining leaves the previous level in place.
 *   RECORDED.           The confirmed choice, and the words that were on the
 *                       glass when it was made, go to the signed audit ledger.
 *                       The record is written by the shell (shell/tier-consent.cjs
 *                       and the mc-setup:choose-tier channel); this module hands
 *                       it the words.
 *   RE-WARNED.          Moving down and back up asks again. A confirmation on
 *                       record does not silence the gate: `createRiskGate` never
 *                       reads one.
 *
 * WHY THE WORDS ARE HERE AND NOT IN THE TWO SCREENS THAT SHOW THEM. The Terms
 * (§2, "This software can be given complete, unsandboxed control of your
 * computer") are written to be true either way; the product's promise is that
 * the choice is made explicit "in words that name the actual risk -- not as a
 * checkbox buried in a document". Two screens each holding their own copy of
 * that paragraph is two chances for one of them to drift into a softer sentence
 * that no longer matches the document a person agreed to. One copy, imported
 * twice, and a test that holds it against the phrases the Terms use.
 *
 * THE SENTENCES ARE THE TERMS' SENTENCES, SPLIT WHERE THEY HAD TO BE. The
 * plain-language gate (tools/check-plain-language.mjs) allows twenty-five words
 * to a sentence, and two of §2's run longer than that. Every clause is kept and
 * every phrase is verbatim; what changed is where the full stops fall. The
 * legal draft is at legal/drafts/FREE-TIER-TERMS-LAUNCH.md §2, and
 * tools/test/unrestricted-consent.test.mjs asserts each named phrase is present
 * here, unchanged.
 *
 * THIS MODULE HOLDS NO DOM. It exports strings, one small state machine and one
 * markup function that returns a string, so the decision -- ask, confirm,
 * decline, ask again -- is exercised for real by the suite rather than read
 * off the source. src/views/setup.js and src/setup-profile-settings.js do the
 * clicking; this decides what a click means.
 */

export const UNRESTRICTED_TIER = 'unrestricted'

/* THE WORDS. */

export const UNRESTRICTED_RISK_LEAD = 'This level gives an AI agent complete, unsandboxed control of your computer'

export const UNRESTRICTED_RISK_STATEMENTS = Object.freeze([
  'ToolsEnabled can let an AI agent read, change, and delete any file on your computer, and run any program on it, without asking you first.',
  'This is a real, currently-shipping mode of operation, not a hypothetical. If you choose it, you are knowingly accepting that risk.',
  'A mistake made by an agent running in this mode is not limited to any one folder and is not automatically reversible.',
  'Safer levels exist and are the recommended default. They confine an agent to a folder you pick, enforced by the operating system rather than by an on-screen promise.',
])

export const UNRESTRICTED_RISK_QUESTION = 'Do you want to give an AI agent full access to this computer?'
export const UNRESTRICTED_CONFIRM_LABEL = 'Yes, give it full access'
export const UNRESTRICTED_DECLINE_LABEL = 'No, keep the safer level'

/* THE EXACT TEXT THAT IS RECORDED. The lead, every statement and the question,
   in the order they are shown, joined by single spaces. The shell hashes this
   and stores both the hash and the text, so a later reader can prove which
   words a person confirmed -- not merely that "a warning" was shown. */
export const UNRESTRICTED_RISK_TEXT = [UNRESTRICTED_RISK_LEAD, ...UNRESTRICTED_RISK_STATEMENTS, UNRESTRICTED_RISK_QUESTION].join(' ')

/** Is this the level the gate exists for? */
export function requiresRiskConsent(tier) {
  return tier === UNRESTRICTED_TIER
}

/**
 * The consent object the shell requires before it will record the widest
 * level. Built here, in one place, so both screens send the same shape and a
 * screen cannot send a confirmation without the words attached to it.
 */
export function riskConsent({ confirmed, shownAtMs = Date.now(), via = 'settings' } = {}) {
  return Object.freeze({
    riskShown: true,
    confirmed: confirmed === true,
    riskText: UNRESTRICTED_RISK_TEXT,
    shownAtMs: Number.isSafeInteger(shownAtMs) ? shownAtMs : Date.now(),
    via: via === 'setup' ? 'setup' : 'settings',
  })
}

/**
 * The gate. One per screen instance.
 *
 *   request(tier)  -> { ask: true, tier }  when the tier is the widest one; the
 *                     gate is now PENDING and the screen shows the words.
 *                  -> { ask: false, tier } for any other tier; nothing pending.
 *   confirm()      -> the consent object, and the gate is clear again.
 *   decline()      -> null, and the gate is clear again. The screen keeps
 *                     whatever level it had.
 *
 * IT HAS NO MEMORY OF PAST CONFIRMATIONS, ON PURPOSE. Every request for the
 * widest level asks, however many times it has been confirmed before, and
 * whatever the ledger says. That is clause four of the ruling as code rather
 * than as intent.
 */
export function createRiskGate({ via = 'settings', now = Date.now } = {}) {
  let pending = null
  let shownAtMs = null
  return Object.freeze({
    get pending() { return pending },
    request(tier) {
      if (!requiresRiskConsent(tier)) {
        pending = null
        shownAtMs = null
        return { ask: false, tier }
      }
      pending = tier
      shownAtMs = now()
      return { ask: true, tier }
    },
    confirm() {
      if (pending === null) return null
      const consent = riskConsent({ confirmed: true, shownAtMs, via })
      pending = null
      shownAtMs = null
      return consent
    },
    decline() {
      pending = null
      shownAtMs = null
      return null
    },
    clear() {
      pending = null
      shownAtMs = null
    },
  })
}

/* THE BLOCK. The app's existing "explains rather than controls" language
   (.fleet-profile-status, is-serious because this one is the real risk, not a
   stated limit), the words, the question, and two buttons. The two data
   attributes are the contract with the screens: whichever screen paints this
   listens for exactly these. */
const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

export function unrestrictedRiskMarkup({ id = 'unrestricted-risk', busy = false, declineLabel = UNRESTRICTED_DECLINE_LABEL } = {}) {
  const headingId = `${esc(id)}-lead`
  /* tabindex -1: the page moves the keyboard here when the question opens
     (T1414), so a screen reader reads the question before its two answers. */
  return `<div class="fleet-profile-status is-serious unrestricted-risk" data-unrestricted-risk role="group" aria-labelledby="${headingId}" tabindex="-1">
    <strong id="${headingId}">${esc(UNRESTRICTED_RISK_LEAD)}</strong>
    ${UNRESTRICTED_RISK_STATEMENTS.map(statement => `<span>${esc(statement)}</span>`).join('')}
    <span class="unrestricted-risk-question"><strong>${esc(UNRESTRICTED_RISK_QUESTION)}</strong></span>
    <div class="fleet-profile-actions unrestricted-risk-actions">
      <button type="button" class="ctl-btn" data-unrestricted-decline ${busy ? 'disabled' : ''}>${esc(declineLabel)}</button>
      <button type="button" class="ctl-btn unrestricted-risk-confirm" data-unrestricted-confirm ${busy ? 'disabled' : ''}>${esc(UNRESTRICTED_CONFIRM_LABEL)}</button>
    </div>
  </div>`
}

/* WHAT THE SETTINGS ROW SAYS ABOUT THE RECORD, when the recorded level is the
 * widest one. Three honest states and never a fourth:
 *
 *   the record could not be read      -> say that, and say nothing about consent
 *   a confirmation is on record       -> when, and that the words were shown
 *   no confirmation is on record      -> say so. A level chosen before this
 *                                        program asked, or from outside it, is
 *                                        NOT a confirmed one, and this line must
 *                                        never round it up.
 */
export function describeConsentRecord(state, { tier, now = Date.now(), locale = undefined } = {}) {
  if (!requiresRiskConsent(tier)) return null
  if (!state || state.ok !== true) {
    return 'Whether the risk was shown and confirmed for this level could not be read from this computer’s record.'
  }
  if (state.recorded === true) {
    const when = formatWhen(state.atMs, now, locale)
    return `Full access was confirmed${when ? ` ${when}` : ''}, after the risk was shown in these words. Choosing it again will ask again.`
  }
  return 'No confirmation of the risk is on record for this level on this computer. It was chosen before this program asked, or from outside it. Choosing it again here will ask.'
}

function formatWhen(atMs, now, locale) {
  if (!Number.isSafeInteger(atMs)) return ''
  const date = new Date(atMs)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return `on ${date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })}`
  } catch {
    return `on ${date.toISOString().slice(0, 10)}`
  }
}
