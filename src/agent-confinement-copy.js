/* What the Start control says about the session it is about to start.
 *
 * WHY THIS MODULE EXISTS, AND WHAT IT REPLACES.
 *
 * Until now src/agent-session.js carried one frozen sentence:
 *
 *   "Runs with your full local access. No permission tier limits a running
 *    session. Every start is recorded on this device before it runs."
 *
 * Two of those three clauses are now FALSE, and they were measured false rather
 * than argued false. capability/src/lib/agent-session-confinement.js resolves a
 * recorded level into `threadOptions: {sandbox, approvalPolicy}`, and
 * wt-capability/shell/agent-host.cjs startSession() passes exactly that object to
 * the engine's thread/start. Measured on this tree, 2026-08-11:
 *
 *   guided       -> sandbox read-only          (isolated assistant home)
 *   standard     -> sandbox workspace-write    (isolated assistant home)
 *   unrestricted -> sandbox danger-full-access (isolated installation-owned assistant home)
 *
 * and a machine with NO record fails closed to `guided`. So on a fresh install --
 * the normal first experience -- the screen promised full local access and no
 * tier limit over a session that cannot write a single file. The one clause that
 * survives is the third: mc-agent:start calls recordSpawnIntent() before
 * getAgentHost().startSession(), and mc-agent:availability refuses on the
 * recorder before it even asks about the engine.
 *
 * WHY THE NUMBER IS NOT A CONSTANT IN THIS FILE.
 *
 * The obvious way to "state what this level permits" is to write the tool counts
 * down. That is how the sentence above went false in the first place: a true
 * measurement, frozen into source, outliving the thing it measured. Measured
 * three ways on one machine on one night:
 *
 *   this checkout's payload        guided 109   standard 256   total 265
 *   release/win-unpacked payload   guided 116   standard 296   total 305
 *
 * One number, two answers, because the count is a property of the INSTALLED
 * payload and not of the product. A build that stages one more server moves it
 * again. So no count is written here: the caller passes what the main process
 * measured from the real registry at the moment of asking, and a reading that
 * carries no count simply does not get that sentence. A missing true number is a
 * smaller defect than a present false one.
 *
 * PURE ON PURPOSE. No DOM, no stylesheet, no bridge. src/agent-session.js reaches
 * the DOM through components.js, whose module graph starts the demonstration
 * simulator's timers on import and never lets a plain-node test process exit --
 * so a suite that wanted to assert this copy would be reduced to asserting on
 * source TEXT, which passes just as well when the table is right and the lookup
 * is wrong. This module is importable by `node --test` and the suite asserts the
 * SENTENCES a reading produces.
 */

import { TIER_CHOICES } from './setup-state.js'

/* The level's own words, taken from the question that asked them rather than
   rewritten here. tools/mcsetup.js and src/views/setup.js already put these
   exact sentences in front of the person choosing; a second vocabulary on this
   screen would make one decision look like two. */
const TIER_DETAIL = Object.freeze(Object.fromEntries(
  TIER_CHOICES.map(choice => [choice.tier, choice.detail]),
))

/* The Start reading names the requested sandbox policy, before a running
 * provider has reported what it actually applied. File-write restrictions do
 * not imply a read boundary. Describe the request and keep stricter runtime,
 * tool and role policies possible; no provider/platform proof is inferred. */
export const SANDBOX_EFFECT = Object.freeze({
  'read-only': 'The requested policy allows reading files without changing them. Files outside the working folders may still be readable. Check the running session’s reported permissions.',
  'workspace-write': 'This requests writes in the working folders and any temporary folders the program allows. Writes elsewhere are outside that policy. Outside reads may still be possible. Check the running session’s reported permissions; it can be more restrictive.',
  'danger-full-access': 'Nothing narrows it: it can read, change and delete any file on this computer and run any program, without asking.',
})

/* WHAT EACH LEVEL SAYS ABOUT CREDENTIALS, keyed by the tier name.
 *
 * THE FIRST OUTSIDE USER'S CASE, and the reason this table exists. Their
 * agents "weren't able to use credential manager or vault" -- on the
 * recommended (Guided) level, where the credential requester is withheld BY
 * DESIGN: the read-only tool surface carries system.doctor and the presence
 * checks, and system.credential_request starts at Standard. That is the
 * legal/consent architecture working; what failed was VISIBILITY. Nothing on
 * any screen said so, so a deliberate limit read as a breakage, to the person
 * and to their agent alike. The agent's own copy of this sentence now rides
 * the standard tool note (engine src/lib/agent-tool-summary.js); this is the
 * person's copy, at the moment of pressing Start.
 *
 * MEASURED, not assumed: real stdio sessions against the staged payload
 * (tools/agent-tools-matrix-qa.mjs, 2026-08-19) advertise no
 * system.credential_request at guided (111 tools) and do advertise it at
 * standard and above, where the driven flow queues the guarded owner form and
 * the entered value never reaches the agent. */
export const CREDENTIAL_CLAUSE = Object.freeze({
  guided: 'It can see what is already set up, but it cannot ask you for credentials or store any — asking starts at the Standard level.',
  standard: 'It can ask you to add a credential through a guarded form. What you type goes into this computer\'s encrypted store and is never shown to the assistant.',
  unrestricted: 'It can ask you to add a credential through a guarded form. What you type goes into this computer\'s encrypted store and is never shown to the assistant.',
})

/* The clause that is still true, and the only one carried over unedited.
   Precision matters here and the wording is deliberately not stronger: this is
   the app's own signed, hash-chained local ledger, and the signing key lives on
   the same machine as the ledger -- tamper-evident against edits, not proof
   against this OS user. "Recorded on this device" is exactly that claim and not
   one word more. */
export const RECORD_CLAUSE = 'Every start is recorded on this device before it runs.'

/* Said when the level could not be read rather than chosen. The product's own
   fail-closed direction is `guided`, so this is not a warning about degraded
   safety -- it is the opposite, and saying it plainly stops a person concluding
   their unrestricted choice is in force when it is not. */
export const FAIL_CLOSED_CLAUSE = 'No level is recorded on this computer yet, so a session runs at the most restrictive one.'

/* Shown when the shell is not there to ask (a browser, vite preview). It states
   an absence rather than assuming either answer -- the same rule
   mcAgent.availability() and mcSetup.bootstrap already follow. */
export const UNKNOWN_CONFINEMENT = 'This page cannot tell what a session here would be allowed to do, so it is not going to guess.'

const TIER_NAME = Object.freeze({
  guided: 'Guided',
  standard: 'Standard',
  unrestricted: 'Unrestricted',
})

/** The tools sentence, or null when no count was measured.
 *
 *  `allowed === null` is the deliberate shape for `unrestricted`: the level
 *  narrows nothing, so there is no allowlist to count and `total` is the whole
 *  surface. Reporting "305 of 305" would be arithmetically true and would still
 *  misdescribe the mechanism, which is that no narrowing is applied at all. */
export function toolsSentence({ allowed = null, total = null } = {}) {
  const wholeNumber = value => Number.isInteger(value) && value >= 0
  if (!wholeNumber(total) || total === 0) return null
  if (allowed === null) return `It is offered all ${total} of this copy's tools.`
  if (!wholeNumber(allowed) || allowed > total) return null
  return `It is offered ${allowed} of this copy's ${total} tools.`
}

/**
 * Every sentence the Start control should show, for one confinement reading.
 *
 * Returns `{ level, effect, tools, record, note, sentences }`. `sentences` is the
 * ordered list actually rendered, so a caller cannot show a different set than
 * the one this module decided on, and a test can assert the whole screenful.
 *
 * NEVER THROWS AND NEVER INVENTS. An unreadable or absent reading collapses to
 * the unknown state above rather than to the cheerful one. The old sentence was
 * the cheerful default written down, and it survived a tier system landing
 * underneath it precisely because nothing recomputed it.
 */
/* The default is the desktop's answer, so every existing caller is unchanged.
   A browser driving a machine over the relay passes the other one. */
export const CONFINEMENT_SUBJECT_HERE = 'This computer'
export const CONFINEMENT_SUBJECT_REMOTE = 'The computer you are driving'

/* Share the tier contract with Setup; only the machine being described changes.
 * Duplicated remote sentences previously retained a false read boundary after
 * the desktop words were corrected. */
const REMOTE_TIER_DETAIL = Object.freeze(Object.fromEntries(
  TIER_CHOICES.map(choice => [choice.tier, choice.detail.replaceAll('this computer', 'the computer you are driving')]),
))

const REMOTE_CREDENTIAL_CLAUSE = Object.freeze({
  guided: CREDENTIAL_CLAUSE.guided,
  standard: 'It can ask you to add a credential through a guarded form. What you type goes into the encrypted store on the computer you are driving and is never shown to the assistant.',
  unrestricted: 'It can ask you to add a credential through a guarded form. What you type goes into the encrypted store on the computer you are driving and is never shown to the assistant.',
})

const REMOTE_RECORD_CLAUSE = 'Every start is recorded on the computer you are driving before it runs.'
const REMOTE_FAIL_CLOSED_CLAUSE = 'No level is recorded on the computer you are driving yet, so a session runs at the most restrictive one.'
const REMOTE_UNKNOWN_CONFINEMENT = 'This page cannot tell what a session on the computer you are driving would be allowed to do, so it is not going to guess.'

export function confinementNote(reading, { subject = CONFINEMENT_SUBJECT_HERE } = {}) {
  const remote = subject === CONFINEMENT_SUBJECT_REMOTE
  const unknown = remote ? REMOTE_UNKNOWN_CONFINEMENT : UNKNOWN_CONFINEMENT
  const record = remote ? REMOTE_RECORD_CLAUSE : RECORD_CLAUSE
  if (!reading || typeof reading !== 'object' || Array.isArray(reading) || reading.ok !== true) {
    return Object.freeze({
      level: null,
      effect: unknown,
      tools: null,
      record,
      note: null,
      sentences: Object.freeze([unknown, record]),
    })
  }

  const tier = typeof reading.tier === 'string' ? reading.tier : null
  const name = TIER_NAME[tier] || null
  const effect = SANDBOX_EFFECT[reading.sandbox] || null
  /* An unrecognised sandbox word is the one case that must not fall through to a
     reassuring sentence. It means this renderer is older than the confinement
     table it is reading, and the honest answer is that it does not know. */
  /* WHICH COMPUTER THIS PARAGRAPH IS ABOUT, and it is a safety disclosure, so
     the referent has to be right.
     Driving from a browser, everything below describes a machine somewhere
     else. "This computer is set to Unrestricted. Nothing narrows it: it can
     read, change and delete any file on this computer and run any program,
     without asking." -- read at a laptop, about a machine at home, that names
     the wrong computer in the one paragraph that must not.
     The lead names the subject and the sentences after it inherit that
     reading, so one word here fixes the whole passage. The default is
     unchanged, which is what the desktop and the preview both want. */
  const level = name ? `${subject} is set to ${name}.` : null
  const details = remote ? REMOTE_TIER_DETAIL : TIER_DETAIL
  const detail = tier && details[tier] ? details[tier] : null
  const tools = toolsSentence({
    allowed: reading.toolsAllowed === undefined ? null : reading.toolsAllowed,
    total: reading.toolsTotal === undefined ? null : reading.toolsTotal,
  })
  const note = reading.failedClosed === true
    ? (remote ? REMOTE_FAIL_CLOSED_CLAUSE : FAIL_CLOSED_CLAUSE)
    : null

  if (!level || !effect) {
    return Object.freeze({
      level: null,
      effect: unknown,
      tools: null,
      record,
      note,
      sentences: Object.freeze([unknown, ...(note ? [note] : []), record]),
    })
  }

  /* The tier explains the recorded choice; the effect explains its requested
     sandbox policy. Neither is a measurement of a running provider's access.
     Unrestricted keeps its existing direct disclosure without repeating it. */
  const credentialClauses = remote ? REMOTE_CREDENTIAL_CLAUSE : CREDENTIAL_CLAUSE
  const credentials = credentialClauses[tier] || null
  const sentences = tier === 'unrestricted'
    ? [level, effect, ...(credentials ? [credentials] : []), ...(note ? [note] : []), ...(tools ? [tools] : []), record]
    : [level, detail, effect, ...(credentials ? [credentials] : []), ...(note ? [note] : []), ...(tools ? [tools] : []), record]

  return Object.freeze({
    level,
    effect,
    tools,
    record,
    note,
    sentences: Object.freeze(sentences.filter(Boolean)),
  })
}

/** The one-line form, for the status row under the Start button. */
export function confinementLine(reading) {
  return confinementNote(reading).sentences.join(' ')
}

/* THE SHORT FORM, FOR THE OTHER START BUTTON.
 *
 * WHY A SECOND SHAPE RATHER THAN confinementLine(). There are two controls in
 * this product that start an agent, and only one of them was ever told what a
 * session may do. The agent page has a whole column to spend and renders every
 * sentence above. The fleet tree's compose panel is a narrow rail whose own
 * design notes record Start being pushed below the fold TWICE as an
 * owner-reported defect -- so a block the height of confinementLine() is not
 * something that surface can carry, and "carry all of it or none of it" is how
 * it ended up carrying none.
 *
 * WHAT IS KEPT IS THE HALF ABOUT THIS PERSON'S DISK: which level is in force,
 * what the operating system will do to a file, and -- when nothing was ever
 * recorded -- that the answer came from a fail-closed default rather than from
 * them. That is the part a person is about to find out the hard way. The tool
 * count, the credential rule and the recording clause are not dropped from the
 * product; they stay on the surface that has room for them.
 *
 * IT NEVER INVENTS. Everything here comes from confinementNote(), which
 * collapses an absent, unreadable or unfamiliar reading to UNKNOWN_CONFINEMENT
 * -- so the worst this can say is that it does not know, which is the one
 * honest answer when nothing could be read.
 */
export function startControlLine(reading, options = {}) {
  const note = confinementNote(reading, options)
  return [note.level, note.effect, note.note].filter(Boolean).join(' ')
}
