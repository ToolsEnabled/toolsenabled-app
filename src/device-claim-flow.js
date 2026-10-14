/* CONNECTING THIS COMPUTER TO THE ACCOUNT SOMEBODY JUST MADE, AS A STATE
 * MACHINE WITH NO DOM IN IT.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, in the person's own words: "as a user I dont
 * even see how after signing up that I now connect my computer". They signed up
 * on the website. The account page there asks them for a code. Nothing in this
 * application has ever shown them one. Every other half of the ceremony was
 * already built -- the account service opens and collects claims, the website
 * has the box to type into, the installed application ships the client that
 * talks to both -- and the missing piece was a screen that says the code out
 * loud.
 *
 * WHY THE RULES LIVE HERE AND NOT IN THE SECTION THAT DRAWS THEM. This flow has
 * eight states, three of which are failures, and each of the three has to leave
 * a person somewhere they can act. A branch that only exists inside a render
 * function is a branch only a driven browser can hold still, and the failure
 * states are exactly the ones a driver reaches least often. Everything below is
 * a pure function over a plain object, so `node --test` can walk idle, waiting
 * and ended without a window.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never calls the installed
 * application, never reads a clock and never starts a timer. It is handed
 * `nowMs` and a result and answers with the next state;
 * src/connect-computer-settings.js owns the calls, the one interval and the
 * teardown. Keeping the clock out is what makes the expiry rule testable at all
 * -- expiry is the one transition nobody can wait for in a unit test.
 */

import { refusalCodeOf, refusalSentence } from './refusal-copy.js'

/* The section name, exported rather than spelled twice, the same way
   CHATBOX_SECTION and RESEARCH_SECTION are. src/views/settings.js routes on the
   constant, so a rename here moves the page with it. */
export const CONNECT_SECTION = 'Connect this computer'

/* One setting, for the footer's count: whether this computer is joined to the
   account. The name box is that setting's value, not a second setting -- the
   same rule the chat box section's agent list is counted by. */
export const CONNECT_SETTING_COUNT = 1

/* THE ADDRESS OF THE ONE STEP THAT TURNS THIS INTO THE PRODUCT.
 *
 * `#/settings?setting=connect_computer` lands on this row, the way every other
 * landable row on that page is reached. Until this id existed nothing anywhere
 * could send a person here: requestedSetting() in src/views/settings.js resolves
 * the query against that page's own tables, this section's rows are not in
 * SETTINGS (they are the installed application's business, like the research
 * rows), and the row carried no data-setting-id at all -- so the best any link
 * could do was drop somebody at the top of Settings. The owner's report was
 * "as a user I dont even see how after signing up that I now connect my
 * computer".
 *
 * IT IS EXPORTED, NOT SPELLED TWICE. The row renders it as its data-setting-id
 * and the settings page resolves it; a link that names it is only correct while
 * those two agree, so they read the same constant. */
export const CONNECT_SETTING_ID = 'connect_computer'

/* THE WHOLE ADDRESS, WRITTEN ONCE, BECAUSE FOUR SCREENS NOW LINK TO IT.
 *
 * The id above was exported and had NO CALLER ANYWHERE -- three scouts walked
 * the product from a cold install and found the connect screen reachable only
 * by opening Settings for no reason. Home, the computers page, the guide and
 * the System row all point here now, and a link that names the route is only
 * correct while every one of them spells it the same way. So they do not spell
 * it: they read this. */
export const CONNECT_HREF = `#/settings?setting=${CONNECT_SETTING_ID}`

/* WHAT THE DOOR IS CALLED, wherever it is drawn. Same reason: four surfaces
   offering four differently-worded ways to one screen is how a person decides
   they are three different screens. */
export const CONNECT_ACTION_LABEL = 'Connect this computer to your account'

/* THE DOOR OUT, named once for the same reason. "Disconnect this computer"
 * stops remote access and requests removal of the fixed account credential.
 * The machine's own identity stays, and its row on the account page stays -- still
 * listed under "Your computers", still counted toward the limit -- until the
 * person removes it there. Joining again is a fresh claim with a new code.
 *
 * IT IS TWO PRESSES, like every control in this product that takes something
 * away (src/arm-press.js). The hint is what the first press shows: it says what
 * the second press clears, and what it deliberately does not, because a person
 * who reads "disconnect" as "remove from my account" would otherwise find the
 * computer still on their page and still counting. Every sentence in it is
 * short on purpose; it is read in the eight seconds the arm lasts. */
export const DISCONNECT_ACTION_LABEL = 'Disconnect this computer'
export const DISCONNECT_ARMED_HINT = 'Disconnect? Press again. This clears the connection this computer holds, so it can be joined again. It does not take the computer off your account: it stays listed under “Your computers” and still counts toward your limit. Remove it there too if you mean to.'

/* THE ONE SWITCH THAT LETS A BROWSER CHANGE THINGS HERE, named once.
 *
 * A machine only accepts changes from a signed-in browser if it has been told,
 * on the machine itself, that it may be driven from one. The reader is
 * shell/relay-supervisor.cjs webDriveMayWrite(): it reads the shell's own
 * durable-choice store (shell/renderer-prefs.cjs) at the key below and answers
 * true ONLY for the exact string 'on' -- five fail-closed early returns, none
 * of which this window can reach round. Until this constant existed there was
 * NO writer anywhere in src/: the refusal a browser met pointed at a control
 * that did not exist. The owner's ruling is that the question is asked on the
 * computer, at the moment it becomes meaningful, which is the moment the
 * connect section sees the claim land; src/connect-computer-settings.js draws
 * that question and the switch, and both spell the control with this label.
 *
 * ESM cannot import the CJS reader, so the key and the value are repeated here
 * and the parity is pinned by tools/test/relay-supervisor.test.mjs against the
 * CJS exports. The key is outside `mc.set.` on purpose: public/durable-storage.js
 * syncs `mc.set.*` to the account, and this choice must never leave the
 * machine it was made on -- it is what stops someone who has the password
 * from granting themselves the permission this switch withholds. */
export const WEB_DRIVE_CONTROL_LABEL = 'Let a signed-in browser drive this computer'
export const WEB_DRIVE_PREF_KEY = 'mc.relay.web-drive'
export const WEB_DRIVE_ON = 'on'

/* WHAT A PERSON IS TOLD TO TYPE INTO THEIR BROWSER, written once because a
 * wrong address here sends somebody to a page that cannot help them.
 *
 * It is the plain site, which is what is on the packaging and what they signed
 * up at. The account service's own origin is a separate name for the same box,
 * it belongs to the installed application, and it is never shown here.
 */
export const ACCOUNT_PAGE_HOST = 'toolsenabled.ai'

/* THE SHAPE A CODE HAS. Used only to decide whether what came back is showable
   at all: an answer that says ok and carries something else must not be painted
   40px high as though a person could type it anywhere. */
const CODE_SHAPE = /^TC-[A-Z0-9]{4}-[A-Z0-9]{4}$/

/* HOW OFTEN TO ASK IS THE SERVICE'S DECISION, NOT THIS FILE'S. Every wait uses
 * the `intervalSeconds` that came back with the code, and the number is re-read
 * from every answer in case the service changes its mind mid-wait.
 *
 * The clamp is not a second opinion about the cadence. It is the floor and
 * ceiling on a number this window did not compute: `0`, `-1`, `NaN` and
 * `undefined` all arrive as ordinary values, and each of them turns "ask again
 * in intervalSeconds" into either a storm of requests or a wait that never
 * ends. FALLBACK_SECONDS stands in only when the service said nothing at all,
 * and is deliberately slow rather than eager.
 */
const MIN_SECONDS = 1
const MAX_SECONDS = 300
const FALLBACK_SECONDS = 5

export function pollSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return FALLBACK_SECONDS
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(seconds)))
}

/* THE CAP APPLIES TO THE GUESS AND NEVER TO THE TYPING. A profile label is free
   text and somebody's is a paragraph; a forty-eight character default keeps the
   box readable without deciding for anyone what their computer may be called. */
const DEFAULT_NAME_MAX = 48

/* HOW LONG A NAME MAY BE, RESTATED HERE SO THE BOX CAN STOP AT IT.
 *
 * The authority is MAX_NAME_LENGTH in shell/device-claim.cjs and it stays the
 * authority -- this number never decides anything, it only lets the box refuse
 * a sixty-fifth keystroke instead of letting somebody fill it, press the
 * button, and be told by a round trip that the name they cannot see all of is
 * too long. SEEN ON GLASS: two hundred characters pasted in produced
 * DEVICE_CLAIM_NAME_INVALID as a sentence two hundred pixels above the button,
 * and forty party-popper emoji produced it too -- because that limit counts the
 * same units an <input maxlength> counts, so what looked like forty characters
 * was eighty. A box that stops is the only version of that a person can see
 * happening.
 *
 * IT IS A CEILING AND NEVER A PASS. The shell still checks; a name that gets
 * past this box because it was set some other way is still refused there. */
export const MAX_DEVICE_NAME = 64

/* The name this computer will carry on the account page. A label the person
   already chose for this system beats anything guessed from a browser they are
   not looking at, so it goes first. */
export function defaultDeviceName({ profileLabel = '', platform = '' } = {}) {
  const label = String(profileLabel || '').trim()
  if (label) return label.slice(0, DEFAULT_NAME_MAX)
  const kind = String(platform || '').toLowerCase()
  if (kind.includes('win')) return 'My Windows computer'
  if (kind.includes('mac') || kind.includes('darwin')) return 'My Mac'
  if (kind.includes('linux')) return 'My Linux computer'
  return 'My computer'
}

/* What actually goes up the wire. Somebody who clears the box has not asked for
   a nameless computer on their account -- they have cleared the box -- so the
   guess stands in rather than an empty name being filed against them.

   AND IT IS THE GUESS THE BOX WAS ACTUALLY FILLED WITH. This used to recompute
   from `platform` alone, while the box had been filled from the person's own
   profile label -- so clearing a box reading "Front desk" filed "My Windows
   computer" instead. `defaultName` is the value that was put in the box when
   the screen was built, carried on the state so the fallback and the box can
   never disagree about what the default was. */
export function nameToClaim(state) {
  const typed = String(state?.name || '').trim()
  const filled = String(state?.defaultName || '').trim()
  return typed || filled || defaultDeviceName({ platform: state?.platform })
}

/* HOW LONG IS LEFT, SAID AS A WHOLE SENTENCE, INCLUDING WHEN THE ANSWER IS
 * "NOBODY TOLD US".
 *
 * A countdown quietly showing 0:00 forever because `expiresAtMs` was missing is
 * this codebase's signature defect wearing a clock face: absence painted as a
 * value. So the unknown case says it is unknown, and the person still has a way
 * to ask for a fresh code.
 *
 * Minutes and seconds rather than "about four minutes": the person is copying a
 * code into another device, and the difference between 4:40 and 0:40 is the
 * difference between finishing and starting again.
 */
export function remainingText(expiresAtMs, nowMs) {
  const ends = Number(expiresAtMs)
  if (!Number.isFinite(ends)) return 'This window was not told when this code stops working.'
  const left = ends - Number(nowMs || 0)
  if (!(left > 0)) return 'This code has run out. Ask for a new one below.'
  const seconds = Math.floor(left / 1000)
  const minutes = Math.floor(seconds / 60)
  return `Stops working in ${minutes}:${String(seconds % 60).padStart(2, '0')}.`
}

/* ---------- the states ----------
 *
 * checking   asking the installed application what it already knows
 * absent     this window has no way to ask at all
 * unknown    the ask was refused, so whether this computer is joined is UNREAD
 * idle       nothing in flight; the name box and the button are what is shown
 * starting   a code has been asked for and has not come back
 * waiting    a code is on screen and this window is asking for the confirmation
 * orphaned   a claim is in flight whose code this screen cannot show
 * connected  this computer reports holding an account credential
 * disconnecting  a requested disconnect has not yet returned its outcome
 * disconnect-review  separate credential and process facts need inspection
 * ended      the code is no longer good for anything -- see `endedBecause`
 *
 * `refusal` IS NOT A STATE, IT IS A FIELD ON EVERY STATE, and that is the point
 * of it. A control that does nothing visible when pressed is the defect this
 * week is spent on, so a refusal never replaces the screen a person was looking
 * at -- it is added to it, as a whole sentence, with the controls still where
 * they were.
 */
export const CLAIM_PHASES = Object.freeze([
  'checking', 'absent', 'unknown', 'idle', 'starting', 'waiting', 'orphaned', 'connected', 'ended',
  'disconnecting', 'disconnect-review',
])

/* Why a code stopped being usable. Each is a different sentence to a person and
   the same offer -- ask for another -- so they share a phase and differ here,
   rather than multiplying states nobody can tell apart on screen.

   `stopped` IS THE ONE THE PERSON DID ON PURPOSE, and it is here because the
   alternative was a lie. Pressing "Stop waiting" used to land back on `idle`,
   whose line reads "Nothing has been sent anywhere" -- said to somebody who had
   just been shown a code that was very much sent somewhere. An ending a person
   chose is still an ending, and it belongs with the other three. */
export const ENDED_REASONS = Object.freeze(['gone', 'ran-out', 'not-tracked', 'stopped'])

export function initialState({ name = '', platform = '' } = {}) {
  return Object.freeze({
    phase: 'checking',
    name,
    /* The guess as it was made, kept apart from the box's live value so a
       cleared box falls back to what it was filled with. See nameToClaim. */
    defaultName: name,
    platform,
    code: null,
    expiresAtMs: null,
    intervalSeconds: null,
    nextPollAtMs: null,
    device: null,
    claimedName: null,
    claimedAtMs: null,
    endedBecause: null,
    refusal: '',
    refusalCode: null,
    /* WHETHER THE PERSON CAUSED THIS REFUSAL, and it is the difference between
     * a message and an accusation.
     *
     * THE DEFECT: on a sterile profile the section drew a red alert reading
     * "This computer is already in the middle of a connection step. Wait for
     * that one to finish." four inches under "Nothing has been sent anywhere."
     * -- before the person had touched anything. Three scouts reproduced it
     * independently; it is the first thing a new customer sees on the most
     * important screen in the product. The cause is a background read being
     * refused (see the shell's one-child-at-a-time rule), and a background
     * read's refusal is not news a person can act on.
     *
     * So a refusal that FOLLOWED A PRESS is still drawn exactly where it was,
     * out loud, with role="alert". A refusal nobody asked for is carried on the
     * state -- for the search index and for the status line that explains it --
     * and never painted as an alarm. */
    refusalPressed: false,
    /* SOMETHING TRUE THAT IS NOT A REFUSAL. One sentence, and today it has one
       use: saying that a code which was already open has been given up. */
    note: '',
    /* WHETHER THE ACCOUNT SERVICE ITSELF SAID SO, IN THIS SESSION, RATHER THAN
     * A FILE ON THIS DISK SAYING SO.
     *
     * `connected` is reached two ways and they are not the same fact. A poll
     * that came back `connected` is the service confirming the collection as it
     * happened -- proof, seconds old. A `status` read is this machine reading
     * its own vault, which says the same words whether the computer has been
     * offline for an hour or removed from the account on another machine an
     * hour ago. Only the first earns the good tone; the second gets a sentence
     * that says where it came from. */
    serviceConfirmed: false,
    /* A removal receipt and a later absence observation are different outcomes.
       This summary is cleared when a new code is requested; the separate facts
       retain the blocked fence until the native lifecycle confirms that claim. */
    disconnected: null,
    disconnect: null,
  })
}

function next(state, patch) {
  return Object.freeze({ ...state, ...patch })
}

/* A refusal always becomes a whole sentence with something to do in it.
   src/refusal-copy.js is the one place in this product that guarantees that,
   and this flow has no business owning a second copy of the rule. The code is
   carried beside the sentence for the attribute the section writes, never for
   the glass. */
function refusalOf(result, remedy = '', { pressed = true } = {}) {
  return {
    refusal: refusalSentence(result, {
      fallback: 'The installed application did not answer this window.',
      remedy,
    }),
    refusalCode: refusalCodeOf(result),
    refusalPressed: pressed,
  }
}

/* The one remedy this flow knows better than the shared table does: a code that
   has expired or already been collected is cured by asking for another, which
   is a button on this very screen, and never by restarting anything. */
const RESTART_REMEDY = 'Ask for a new code below, then enter that one on the account page.'

/* The second one, for the same reason. A name the installed application will
 * not list this computer under is cured by changing the name -- in the box that
 * is on this screen, directly above the button that was just pressed.
 *
 * SEEN ON GLASS: the shared table's DEVICE_CLAIM_ family remedy sent that
 * person to their account page "to see which computers are joined", which for a
 * name that is too long is advice about somewhere else entirely. It is the
 * right floor for the family and the wrong sentence for this one, which is
 * exactly the case refusalSentence()'s `remedy` override exists for. */
const NAME_REMEDY = 'Change the name in the box above, then press the button again.'
const NAME_REFUSAL_CODE = 'DEVICE_CLAIM_NAME_INVALID'

/* The third one, and it exists because the floor sentence was untrue for it.
 * The shared DEVICE_CLAIM_ floor ends "a new code comes from this screen", and
 * for a computer that already holds a credential that is the one thing that
 * cannot happen until the credential is cleared. The shell's old sentence said
 * "Remove it on the account page first", which sent people to do a thing that
 * does not cure this -- removing the computer on the account page leaves what
 * this machine holds untouched, so the next press refuses the same way.
 *
 * THE CURE EXISTS NOW. The engine's `disconnect` verb clears the credential
 * (capability/tools/online-fra-claim-cli.js), and this section draws it as
 * "Disconnect this computer" on the joined screen. This remedy used to end
 * "nothing in this window can clear it yet"; it now names the control. And
 * because the control is drawn only on the joined screen, an already-connected
 * refusal LANDS on that screen (see begin-result below) rather than on idle,
 * so the sentence never names a control that is not under it. */
const ALREADY_CONNECTED_REMEDY = `If that is your account, it is already joined and there is nothing more to do here. Removing it on the account page does not clear what this computer holds. Disconnect it in Settings, under ${CONNECT_SECTION}, and then take a new code.`
const ALREADY_CONNECTED_CODE = 'DEVICE_CLAIM_ALREADY_CONNECTED'

const DISCONNECT_CAUSES = new Set([
  'SECRET_ACCESS_DENIED', 'SECRET_BACKEND_IDENTITY_INVALID', 'SECRET_BACKEND_KEY_INVALID',
  'SECRET_BACKEND_KEY_MISSING', 'SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_UNAVAILABLE',
  'SECRET_BACKEND_UNSAFE', 'SECRET_HELPER_PROTOCOL_INVALID', 'SECRET_HELPER_UNAVAILABLE',
  'SECRET_INPUT_INVALID', 'SECRET_MONOTONIC_CONFLICT', 'SECRET_NOT_CONFIGURED',
  'SECRET_PAYMENT_CARD_REVIEW_REQUIRED', 'SECRET_VAULT_FORMAT_UNSUPPORTED',
  'SECRET_VAULT_LOCK_TIMEOUT', 'SECRET_VAULT_PATH_UNSAFE', 'SECRET_VAULT_UNREADABLE',
  'SECRET_VAULT_WRITE_FAILED', 'SECRET_VAULT_WRITE_UNCERTAIN',
])
const MUTATION_OUTCOMES = new Set(['NOT_ATTEMPTED', 'REMOVED_SYNCED', 'UNCERTAIN'])
const booleanFact = value => typeof value === 'boolean' ? value : null

// A storage receipt, a current absence observation and stopped processes are
// different facts. A later read cannot upgrade an uncertain write receipt.
function disconnectFacts(result, previous = null, { status = false } = {}) {
  const outcome = MUTATION_OUTCOMES.has(result?.mutationOutcome) ? result.mutationOutcome
    : status ? previous?.mutationOutcome ?? null : 'UNCERTAIN'
  return Object.freeze({
    disconnectPending: booleanFact(result?.disconnectPending),
    remoteAccessBlocked: booleanFact(result?.remoteAccessBlocked),
    remoteStopped: booleanFact(result?.remoteStopped),
    childQuiescent: booleanFact(result?.childQuiescent),
    restartSafety: result?.restartSafety === 'recorded' ? 'recorded' : 'unknown',
    credentialCleared: result?.credentialCleared === true
      ? (outcome === 'REMOVED_SYNCED' || (outcome === 'NOT_ATTEMPTED' && result.wasConnected === false) ? true : null)
      : booleanFact(result?.credentialCleared),
    credentialObservedAbsent: status && result?.ok === true && result.connected === false,
    credentialPresent: status && result?.ok === true && result.connected === true,
    mutationOutcome: outcome,
    localCause: DISCONNECT_CAUSES.has(result?.localCause) ? result.localCause : null,
  })
}

export function canBeginConnection(state) {
  if (state?.phase === 'disconnecting') return false
  if (!state?.disconnect) return true
  return state.disconnect.credentialObservedAbsent === true
    && state.disconnect.childQuiescent === true && state.disconnect.remoteStopped === true
    && state.disconnect.remoteAccessBlocked === true
}

function disconnectProjection(state, result, { status = false, pressed = true } = {}) {
  const facts = disconnectFacts(result, state.disconnect, { status })
  const mayBegin = canBeginConnection({ phase: 'disconnect-review', disconnect: facts })
  const code = typeof result?.code === 'string' && /^DEVICE_CLAIM_[A-Z_]{1,64}$/.test(result.code)
    ? result.code : 'DEVICE_CLAIM_DISCONNECT_UNCERTAIN'
  const refusal = result?.ok === true ? '' : status
    ? 'This screen could not read connection status. Check it again when the installed application is available.'
    : 'The disconnect did not return a complete confirmation. Check connection status before taking another action.'
  return next(state, {
    phase: mayBegin ? 'idle' : 'disconnect-review', disconnect: facts,
    device: null, claimedAtMs: null, code: null, expiresAtMs: null, nextPollAtMs: null,
    endedBecause: null, serviceConfirmed: false, note: '',
    disconnected: facts.credentialCleared === true ? (result.wasConnected === false ? 'nothing' : 'cleared')
      : facts.credentialObservedAbsent ? 'absent' : null,
    refusal, refusalCode: refusal ? code : null, refusalPressed: refusal ? pressed : false,
  })
}

/* The two states where a claim is actually in flight. Written down once
   because three branches now have to leave one alone. */
function waiting(state) {
  return state?.phase === 'waiting' || state?.phase === 'orphaned'
}

function deviceOf(source) {
  if (!source || typeof source !== 'object') return null
  const name = typeof source.name === 'string' ? source.name : ''
  const deviceId = typeof source.deviceId === 'string' ? source.deviceId : ''
  const pairId = typeof source.pairId === 'string' ? source.pairId : ''
  if (!name && !deviceId && !pairId) return null
  return Object.freeze({ name, deviceId, pairId })
}

/**
 * The whole flow, as one pure function.
 *
 * RETURNS THE SAME OBJECT WHEN NOTHING CHANGED, and the section depends on it:
 * the clock ticks once a second while a code is up, and a fresh object every
 * tick would redraw the section under a person's pointer sixty times a minute.
 * An identity check is what lets the caller repaint only the countdown.
 */
export function reduce(state, event) {
  const type = event?.type
  const nowMs = Number(event?.nowMs)

  if (type === 'bridge-absent') {
    return state.phase === 'absent' ? state : next(state, { phase: 'absent' })
  }

  if (type === 'name-changed') {
    const name = String(event.name ?? '')
    return name === state.name ? state : next(state, { name })
  }

  if (type === 'status') {
    const result = event.result
    // An explicitly supplied but unmeasured fence flag is not the legacy case
    // where no lifecycle fields existed. It cannot grant a fresh connection.
    const invalidFence = ['disconnectPending', 'remoteAccessBlocked'].some(key => result
      && Object.hasOwn(result, key) && typeof result[key] !== 'boolean')
    if (state.disconnect || result?.disconnectPending === true || result?.remoteAccessBlocked === true || invalidFence) {
      // A newly requested code can remain in flight while the native fence is
      // blocked. A status read neither completes that claim nor resumes access.
      if (waiting(state) && result?.ok === true && result.connected === false && result.disconnectPending !== true) {
        return next(state, { disconnect: disconnectFacts(result, state.disconnect, { status: true }) })
      }
      return disconnectProjection(state, result, { status: true, pressed: event.pressed === true })
    }
    if (result?.ok !== true) {
      /* A status this window could not read is NOT "not connected". The button
         stays, because trying is still the person's move, and the sentence says
         why the screen could not answer the question first. */
      if (waiting(state)) return next(state, refusalOf(result, '', { pressed: false }))
      /* AND IT IS NOT `idle` EITHER, WHICH IS THE HALF THAT WAS WRONG.
       *
       * `idle` draws "This computer is not on an account yet -- nothing has
       * been sent anywhere." That is a VERDICT, and this branch is reached
       * precisely when no verdict was obtained. Measured: a momentary BUSY or
       * TIMEOUT on the mount-time read told a person whose computer was fully
       * joined to their account that it was not on one -- the product denying,
       * in its own voice, the one thing they had paid to make true. An
       * unreadable answer gets its own line now, and `unknown` draws the same
       * controls `idle` does, because trying is still the person's move. */
      return next(state, { phase: 'unknown', ...refusalOf(result, '', { pressed: false }) })
    }
    if (result.connected === true) {
      return next(state, {
        phase: 'connected',
        device: deviceOf(result),
        claimedAtMs: Number.isFinite(Number(result.claimedAtMs)) ? Number(result.claimedAtMs) : null,
        code: null,
        nextPollAtMs: null,
        endedBecause: null,
        refusal: '',
        refusalCode: null,
        refusalPressed: false,
        note: '',
        serviceConfirmed: false,
        disconnected: null,
      })
    }
    /* "NOT CONNECTED" IS WHAT A WAIT IS FOR, so it must not end one.
       status() is asked once per screen, and a screen that came back to a code
       still in flight (see `adopted-code`) asks it with that code already up.
       Answering "no account yet" by throwing the code away would take the one
       thing the person came back for, on the strength of an answer that says
       nothing except that they have not typed it in yet. */
    if (waiting(state)) return next(state, { device: null, claimedAtMs: null, refusal: '', refusalCode: null, refusalPressed: false })
    return next(state, { phase: 'idle', device: null, claimedAtMs: null, refusal: '', refusalCode: null, refusalPressed: false, disconnected: null })
  }

  /* A CODE THAT WAS ALREADY OPEN HAS BEEN GIVEN UP, AND THE PERSON IS TOLD.
   *
   * SEEN ON GLASS: "Get a code" pressed twice opened a SECOND live claim and
   * silently threw the first poll token away -- one scout held TC-YHTR-MMZH
   * and TC-ZBSR-KGNF at the same time. If the first code had already been
   * typed into the browser, the account page then listed a computer this
   * machine could never collect, permanently. Every begin is routed through
   * cancel-then-begin now, so only one claim can be open; this is the sentence
   * that stops that being silent. It survives into `waiting` deliberately --
   * it belongs beside the NEW code, which is the moment it matters. */
  if (type === 'claim-dropped') {
    return next(state, {
      note: 'A code was already open for the computer you are driving, so it has been given up. If you have already typed that one into your browser, use the new one below instead and remove the half-finished computer on your account page.',
    })
  }

  /* A stop that was not confirmed leaves the wait exactly where it was and
     puts the refusal beside the same control. In particular, a failed
     cancel-before-restart must not open a second claim over the first. */
  if (type === 'cancel-refused') {
    if (state.disconnect) return disconnectProjection(state, event.result)
    return next(state, refusalOf(event.result, 'Press Stop waiting again. If it keeps refusing, close ToolsEnabled on the computer you are driving and open it again there.'))
  }

  if (type === 'begin-requested') {
    if (!canBeginConnection(state)) return state
    return next(state, { phase: 'starting', endedBecause: null, refusal: '', refusalCode: null, refusalPressed: false, disconnected: null })
  }

  if (type === 'begin-result') {
    const result = event.result
    if (result?.ok !== true) {
      if (state.disconnect || result?.disconnectPending === true || result?.remoteAccessBlocked === true) {
        return disconnectProjection(state, result)
      }
      const refusedAs = refusalCodeOf(result)
      if (refusedAs === ALREADY_CONNECTED_CODE) {
        /* THE ENGINE JUST SAID THIS COMPUTER IS JOINED, and that is an answer
           about the vault as good as a status read's. Landing on idle drew a
           "Get a code" button under a sentence explaining why it refuses, and
           -- now that the cure is a control -- would have named a control that
           idle does not draw. The joined screen draws it, directly under this
           sentence. No name is known for the device from a refusal, so none is
           painted; the vault-read tone applies, never the confirmed one. */
        return next(state, {
          phase: 'connected',
          device: null,
          claimedAtMs: null,
          code: null,
          nextPollAtMs: null,
          endedBecause: null,
          note: '',
          serviceConfirmed: false,
          ...refusalOf(result, ALREADY_CONNECTED_REMEDY),
        })
      }
      const remedy = refusedAs === NAME_REFUSAL_CODE ? NAME_REMEDY : ''
      return next(state, { phase: 'idle', ...refusalOf(result, remedy) })
    }
    const code = typeof result.code === 'string' ? result.code.trim() : ''
    if (!CODE_SHAPE.test(code)) {
      /* An answer that said ok and carried no code has given this person
         nothing to type. Painting it would be this screen inventing a fact, so
         it says what happened and leaves the button where it was. */
      return next(state, {
        phase: 'idle',
        refusal: 'The installed application answered without a code to show. Ask for one again.',
        refusalCode: null,
        refusalPressed: false,
      })
    }
    const seconds = pollSeconds(result.intervalSeconds)
    return next(state, {
      phase: 'waiting',
      code,
      /* THE NAME AS IT WENT UP, NOT AS THE BOX READS LATER. nameToClaim() is
         called once, here, over the state that produced this claim -- so a
         screen rebuilt from the remembered code reports what the account page
         will actually show rather than recomputing a guess from a box that is
         no longer on the screen. SEEN ON GLASS at 1000x650: a claim opened as
         "Front desk", left and returned to, said "It will be listed as My
         Windows computer". */
      claimedName: nameToClaim(state),
      expiresAtMs: Number.isFinite(Number(result.expiresAtMs)) ? Number(result.expiresAtMs) : null,
      intervalSeconds: seconds,
      nextPollAtMs: Number.isFinite(nowMs) ? nowMs + seconds * 1000 : null,
      endedBecause: null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
    })
  }

  if (type === 'poll-result') {
    const result = event.result
    if (state.phase === 'disconnecting' || state.phase === 'disconnect-review') return state
    if (['DEVICE_CLAIM_INVALIDATED', 'DEVICE_CLAIM_DISCONNECT_PENDING', 'DEVICE_CLAIM_CONSENT_CLEAR_FAILED',
      'DEVICE_CLAIM_CONNECTION_STATE_UNREADABLE', 'DEVICE_CLAIM_CONNECTION_STATE_WRITE_FAILED'].includes(result?.code)) {
      return disconnectProjection(state, result)
    }
    if (result?.state === 'connected' && (result.remoteAccessBlocked === true || (state.disconnect && result.remoteAccessBlocked !== false))) {
      return disconnectProjection(state, result)
    }
    if (result?.ok !== true) {
      if (refusalCodeOf(result) === 'DEVICE_CLAIM_GONE') {
        return next(state, {
          phase: 'ended',
          endedBecause: 'gone',
          code: null,
          nextPollAtMs: null,
          ...refusalOf(result, RESTART_REMEDY),
        })
      }
      /* ANY OTHER REFUSAL MUST NOT END THE WAIT. The code on screen is still
         the code the account page is expecting, and one unanswered ask is not
         evidence against it. The sentence goes up and the next ask is still
         scheduled, so somebody mid-typing does not lose their code to a
         momentary refusal. */
      const seconds = state.intervalSeconds || FALLBACK_SECONDS
      return next(state, {
        nextPollAtMs: Number.isFinite(nowMs) ? nowMs + seconds * 1000 : state.nextPollAtMs,
        ...refusalOf(result),
      })
    }
    if (result.state === 'connected') {
      return next(state, {
        phase: 'connected',
        device: deviceOf(result.device),
        code: null,
        nextPollAtMs: null,
        endedBecause: null,
        refusal: '',
        refusalCode: null,
        refusalPressed: false,
        note: '',
        serviceConfirmed: true,
        disconnect: null,
      })
    }
    if (result.state === 'none') {
      /* Nothing is in flight where this window believed something was. It
         happens when the application was restarted under an open screen. It is
         not a failure and it is not a connection; it is a wait that is over. */
      return next(state, {
        phase: 'ended',
        endedBecause: 'not-tracked',
        code: null,
        nextPollAtMs: null,
        refusal: '',
        refusalCode: null,
        refusalPressed: false,
      })
    }
    const seconds = pollSeconds(result.intervalSeconds ?? state.intervalSeconds)
    return next(state, {
      intervalSeconds: seconds,
      nextPollAtMs: Number.isFinite(nowMs) ? nowMs + seconds * 1000 : null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
    })
  }

  /* THE CODE THIS WINDOW ALREADY SHOWED, PUT BACK.
   *
   * SEEN ON GLASS, and it is the worst thing this screen did: a person with a
   * code up who moved to another screen in the same window and came straight
   * back was shown "This computer is not on an account yet -- nothing has been
   * sent anywhere" for two seconds, and then "A code was already asked for; this
   * screen cannot show it a second time." Their code was gone, they were told it
   * could not be shown again, and the only way on was to start over -- for
   * clicking twice inside one window.
   *
   * The section rebuilds from nothing on every visit because the settings page
   * builds a new controller each time, so the memory has to outlive the
   * controller; src/connect-computer-settings.js keeps it and hands it here. It
   * is the CODE and its deadline -- the two things already on the glass -- and
   * never the poll token, which this half of the product has no name for.
   *
   * AN EXPIRED ONE IS NOT PUT BACK, and neither is anything that is not shaped
   * like a code: a remembered value is still a value this screen has to be
   * suspicious of, and painting a dead code would be worse than the state it
   * replaces. The wait it restores is confirmed the ordinary way -- the next
   * poll either says `pending`, or ends it as `gone` or `not-tracked`. */
  if (type === 'adopted-code') {
    const code = typeof event.code === 'string' ? event.code.trim() : ''
    if (!CODE_SHAPE.test(code)) return state
    const ends = Number(event.expiresAtMs)
    if (Number.isFinite(ends) && Number.isFinite(nowMs) && nowMs >= ends) return state
    const seconds = pollSeconds(event.intervalSeconds)
    return next(state, {
      phase: 'waiting',
      code,
      claimedName: typeof event.claimedName === 'string' && event.claimedName ? event.claimedName : null,
      expiresAtMs: Number.isFinite(ends) ? ends : null,
      intervalSeconds: seconds,
      nextPollAtMs: Number.isFinite(nowMs) ? nowMs + seconds * 1000 : null,
      endedBecause: null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
    })
  }

  if (type === 'adopted-pending') {
    /* A claim this window did not open is in flight -- somebody started one,
       walked to another screen and came back, and the code lives in the
       application's memory where this screen cannot reach it. The screen says
       exactly that and offers a fresh code; see `orphaned` above. */
    const seconds = pollSeconds(event.intervalSeconds)
    return next(state, {
      phase: 'orphaned',
      code: null,
      expiresAtMs: null,
      intervalSeconds: seconds,
      nextPollAtMs: Number.isFinite(nowMs) ? nowMs + seconds * 1000 : null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
    })
  }

  // The previous connected observation expires as soon as disconnect starts.
  // A missing reply cannot restore it or imply that the credential survived.
  if (type === 'disconnect-requested') {
    if (!['connected', 'disconnect-review'].includes(state.phase)) return state
    return next(disconnectProjection(state, null), { phase: 'disconnecting', refusal: '', refusalCode: null, refusalPressed: false })
  }
  if (type === 'disconnect-result') {
    if (!['connected', 'disconnecting', 'disconnect-review'].includes(state.phase)) return state
    return disconnectProjection(state, event.result)
  }

  if (type === 'tick') {
    if (state.phase !== 'waiting') return state
    if (!Number.isFinite(Number(state.expiresAtMs))) return state
    if (nowMs < Number(state.expiresAtMs)) return state
    /* THE LOCAL CLOCK IS ALLOWED TO END A WAIT because the deadline came from
       the service, not from here -- this is the service's own expiry arriving,
       not this window's opinion of one. A clock behind the service's simply
       keeps asking until the refusal says the same thing; one ahead of it
       offers a new code slightly early. Neither is a dead end, which is the
       property that matters. */
    return next(state, { phase: 'ended', endedBecause: 'ran-out', code: null, nextPollAtMs: null })
  }

  /* STOPPING THE WAIT IS AN ENDING, AND IS SAID AS ONE. It shares the phase
     with the three that were not the person's doing, because what happens next
     is the same in all four: the code is no good, and there is a button that
     gets another. What differs is the sentence, which is the only thing
     `endedBecause` has ever been for. */
  if (type === 'cancelled') {
    return next(state, {
      phase: 'ended',
      endedBecause: 'stopped',
      code: null,
      expiresAtMs: null,
      nextPollAtMs: null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
      note: '',
    })
  }

  if (type === 'restart') {
    return next(state, {
      phase: 'idle',
      code: null,
      expiresAtMs: null,
      nextPollAtMs: null,
      endedBecause: null,
      refusal: '',
      refusalCode: null,
      refusalPressed: false,
      note: '',
    })
  }

  return state
}

/**
 * Whether a state change is one a person would SEE.
 *
 * MEASURED ON GLASS, and it is why this function exists. Driving the waiting
 * state in a real browser: the section was rebuilt every two seconds, because
 * each `pending` answer moves `nextPollAtMs` and reduce() therefore returns a
 * new object. The rebuild replaced the code field -- so somebody part-way
 * through selecting their code to copy it lost the selection, silently, on the
 * service's cadence. The code was still on the screen, which is what makes it
 * the kind of defect nobody reports and everybody feels.
 *
 * So the section repaints on what is DRAWN and never on the bookkeeping. The
 * two fields deliberately left out are the ones that must not cause one:
 *
 *   nextPollAtMs / intervalSeconds  bookkeeping. Never on the glass.
 *   name                            it IS drawn, as the box's value -- but the
 *                                   box already holds what the person typed,
 *                                   and rewriting it under them is the same
 *                                   defect with a caret instead of a selection.
 */
export function repaintNeeded(previous, next) {
  if (previous === next) return false
  return previous.phase !== next.phase
    || previous.code !== next.code
    || previous.expiresAtMs !== next.expiresAtMs
    || previous.endedBecause !== next.endedBecause
    || previous.refusal !== next.refusal
    || previous.refusalCode !== next.refusalCode
    /* It decides whether the sentence is drawn at all, so a change to it is a
       change to the glass even when the sentence itself is the same. */
    || previous.refusalPressed !== next.refusalPressed
    || previous.note !== next.note
    || previous.serviceConfirmed !== next.serviceConfirmed
    /* The idle status line reads it, so it is on the glass. */
    || previous.disconnected !== next.disconnected
    || JSON.stringify(previous.disconnect) !== JSON.stringify(next.disconnect)
    || (previous.device?.name || '') !== (next.device?.name || '')
}

/** Whether the next ask is due. The section's one interval puts this question
 *  every second rather than arming a timer per cadence, so a service that
 *  changes `intervalSeconds` mid-wait is obeyed on the very next answer. */
export function pollDue(state, nowMs) {
  if (!clockShouldRun(state)) return false
  if (!Number.isFinite(Number(state.nextPollAtMs))) return false
  return Number(nowMs) >= Number(state.nextPollAtMs)
}

/** Whether the clock should be running at all. The section starts and stops its
 *  one interval from this answer, so "which states tick" is written down once
 *  and a state added later cannot quietly leave a timer running behind it. */
export function clockShouldRun(state) {
  return state?.phase === 'waiting' || state?.phase === 'orphaned'
}
