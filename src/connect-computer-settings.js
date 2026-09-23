/* THE SETTINGS SECTION THAT SHOWS A PERSON THEIR CODE.
 *
 * "as a user I dont even see how after signing up that I now connect my
 * computer." They signed up on the website; its account page asks them for a
 * code; nothing in this application had ever shown them one. This section is
 * that missing half. src/device-claim-flow.js holds the rules and the states;
 * this holds the words, the markup, the calls and the ONE timer.
 *
 * WHY IT IS A SECTION CONTROLLER AND NOT A ROW IN THE SETTINGS CATALOGUE. Every
 * row in that catalogue is a preference this window stores under `mc.set.<id>`.
 * There is no preference here. There is a ceremony with eight states, a code
 * that expires, and a wait that has to keep running while the person walks to
 * another device -- none of which a row of that shape can express. The chat box
 * and Research sections are here for the same reason.
 *
 * THE BRIDGE MAY NOT EXIST, AND THAT IS AN ORDINARY CASE RATHER THAN AN ERROR.
 * `window.mcShell.deviceClaim` is built by another lane; this file is written
 * against the agreed shape and FEATURE-DETECTS every verb before calling it,
 * the way src/mission-bridge.js checks `typeof ask !== 'function'` before every
 * one of its own. A window without it -- a plain browser, or a build cut before
 * the other half landed -- gets an honest sentence saying so, never a button
 * that does nothing.
 *
 * THE POLL TOKEN NEVER COMES NEAR THIS FILE. begin() keeps it in the installed
 * application's own memory and poll() takes no argument; nothing here has a
 * variable for it. A secret only the application needs must not be handed to a
 * web page, and the way to guarantee that is to have no place to put it.
 *
 * ONE TIMER, AND IT DIES WITH THE SCREEN. Everything that ticks in this section
 * is a single one-second interval, started and stopped from clockShouldRun() so
 * "which states tick" is written down once. destroy() clears it and latches
 * `torn`, because a request already in flight resolves AFTER teardown and would
 * otherwise walk straight back into startClock() and leave an interval running
 * on a screen that no longer exists. This product has paid for that shape
 * before, which is why the latch is checked at the top of every continuation
 * rather than only in destroy().
 *
 * THE ONE EXCEPTION IS NOT THIS FILE'S. "Disconnect this computer" is a
 * two-press control, and the arm between the presses has a timer of its own --
 * in src/arm-press.js, shared with the ledger's and the research queue's x,
 * cleared by the second press and self-checking on a control a repaint has
 * already replaced. Nothing here schedules it and nothing here clears it.
 */

import { FLEET_PROFILE_RESOLUTION } from './fleet-profile.js'
import { toggleStateSentence } from './settings-presentation.js'
import { currentDataSource } from './data-source.js'
import { matchesSettingQuery } from './product-settings-layout.js'
import { armOnce } from './arm-press.js'
import { guidanceMarkup } from './guided-step.js'
import {
  ACCOUNT_PAGE_HOST,
  CONNECT_SECTION,
  CONNECT_SETTING_ID,
  DISCONNECT_ACTION_LABEL,
  DISCONNECT_ARMED_HINT,
  MAX_DEVICE_NAME,
  WEB_DRIVE_CONTROL_LABEL,
  WEB_DRIVE_ON,
  WEB_DRIVE_PREF_KEY,
  clockShouldRun,
  canBeginConnection,
  defaultDeviceName,
  initialState,
  nameToClaim,
  pollDue,
  reduce,
  remainingText,
  repaintNeeded,
} from './device-claim-flow.js'
/* THE STYLESHEET IS IMPORTED BY THE PAGE, NOT BY THIS MODULE, and that is
   the same arrangement chatbox-settings.js and fleet-profile-settings.js
   already have with src/views/settings.js. It is not tidiness: a module that
   imports CSS cannot be loaded by `node --test`, and the states worth testing
   here are the failure ones -- a refusal mid-wait, a code that ran out, a
   teardown while a request is on the wire. Those are exactly the branches a
   driven browser reaches least often, so they have to be reachable from a
   plain node process. */

export { CONNECT_SECTION, CONNECT_SETTING_COUNT, CONNECT_SETTING_ID } from './device-claim-flow.js'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* ONE SECOND, AND IT IS NOT THE POLLING CADENCE. The countdown has to move
   every second to be worth showing at all; the service's `intervalSeconds` is
   how often to ASK, and pollDue() decides that against this clock. Arming a
   second interval at the service's cadence would mean two timers to clear and a
   stale cadence whenever the service changed its mind mid-wait. */
const CLOCK_MS = 1000

/* How long "Copied" stands before the button goes back to offering. Two
   seconds is long enough to be read and short enough that the button is not
   still congratulating somebody about a code they have since replaced. It is
   cleared on the same one-second tick, so the real span is two to three
   seconds and nothing new ticks to shorten it. */
const COPY_ACK_MS = 2000

/* The browser this window is running in, asked once per controller. It is the
   weakest of the two guesses at a name for this computer and is only reached
   when the person has not already labelled their system. */
function currentPlatform() {
  const nav = globalThis.navigator
  return String(nav?.userAgentData?.platform || nav?.platform || '')
}

/* FEATURE DETECTION, PER VERB, EVERY TIME. Not `Boolean(mcShell.deviceClaim)`:
   the website defines `window.mcShell` too (src/data-source.js says so at
   length), so the object existing proves nothing about which verbs are on it. A
   half-built bridge with begin() and no poll() must read as absent rather than
   strand somebody on a code nothing will ever confirm. */
function deviceClaimBridge(shell = globalThis.window?.mcShell) {
  const claim = shell?.deviceClaim
  if (!claim || typeof claim !== 'object') return null
  for (const verb of ['status', 'begin', 'poll', 'cancel']) {
    if (typeof claim[verb] !== 'function') return null
  }
  return claim
}

/* THE FIFTH VERB IS OPTIONAL, AND THAT IS A DECISION. `disconnect` arrived
   after the four above had shipped, so a page built against a shell without
   it must still connect -- a bridge that reads as absent for want of a verb
   the ceremony never calls would strand every older installation on the
   "needs the app" screen. So the four are required, this one is asked for
   separately, and the control that calls it is drawn only when it answers. */
function bridgeCanDisconnect(bridge) {
  return Boolean(bridge) && typeof bridge.disconnect === 'function'
}

const DISCONNECT_CHECK_FAILED = 'CONNECT_DISCONNECT_CHECK_FAILED'
const DATA_SOURCE_CHECK_FAILED = 'CONNECT_DATA_SOURCE_CHECK_FAILED'

export { bridgeCanDisconnect, deviceClaimBridge }

/* WHAT THE STRIP AT THE TOP OF THE SECTION SAYS, one line per state, so the
   answer to "where am I in this" is in the same place every time. `tone` is the
   colour of its left rule, from the same three the System section uses. */
function statusLine(state, { viaRelay = false, disconnectable = false } = {}) {
  const phase = state.phase
  if (phase === 'disconnecting') return {
    tone: '', title: 'Disconnecting this computer',
    detail: 'Stopping the remote connection and checking that its local processes have finished. The result has not been confirmed yet.',
  }
  if (state.disconnect && ['disconnect-review', 'idle'].includes(phase)) {
    const facts = state.disconnect
    if (facts.credentialObservedAbsent) return {
      tone: '', title: 'No connection credential was found',
      detail: canBeginConnection(state)
        ? 'The connection processes have finished and the remote connection stopped. Connecting again requires a new code; remote access stays blocked until that new connection is completed.'
        : 'The credential is absent, but the remaining disconnect checks are not complete. Check connection status before connecting again.',
    }
    if (facts.credentialCleared === true && facts.mutationOutcome !== 'UNCERTAIN') return {
      tone: '', title: state.disconnected === 'nothing' ? 'There was no connection credential to remove' : 'This computer no longer holds its account connection',
      detail: 'It is still listed on your account page until you remove it there. Check connection status before asking for a new code.',
    }
    return {
      tone: 'is-warn', title: facts.remoteStopped === true ? 'Remote connection stopped; disconnect needs attention' : 'Disconnect is not confirmed',
      detail: facts.credentialPresent
        ? 'The current status read found a connection credential. Check the facts below before choosing to finish disconnecting.'
        : 'This screen cannot confirm whether the connection credential was removed. Check connection status before taking another action.',
    }
  }
  if (phase === 'checking') {
    return viaRelay
      ? { tone: '', title: 'Checking the computer you are driving', detail: 'Asking the installed application what the computer you are driving is already joined to.' }
      : { tone: '', title: 'Checking this computer', detail: 'Asking the installed application what this computer is already joined to.' }
  }
  if (phase === 'absent' && viaRelay) {
    /* THE BROWSER THAT IS DRIVING THE COMPUTER IS NOT A STRANGER AT A DESK.
       Over the relay this section has no claim handle, so it lands in `absent`
       -- and then told a person who had signed in at toolsenabled.ai and was
       reading this very computer through it to "sign in at toolsenabled.ai
       instead". Measured on the live site on 2026-08-22. The fact is the
       channel: the computer is on the account, or the page could not have
       arrived. What is NOT here is the switch below, which is set on the
       computer on purpose, and that is the one thing worth saying. */
    return {
      tone: '',
      title: 'The computer you are driving is on your account',
      detail: `That is how this browser is reading it. Whether a browser may drive it is decided on the computer you are driving: on that computer, open ToolsEnabled, go to Settings, open “${CONNECT_SECTION}” and set “${WEB_DRIVE_CONTROL_LABEL}”.`,
    }
  }
  if (phase === 'absent') {
    return {
      tone: 'is-warn',
      title: 'This window cannot ask for a code',
      detail: `Open the installed ToolsEnabled application and come back to this screen. In a browser tab, sign in at ${ACCOUNT_PAGE_HOST} instead.`,
    }
  }
  if (phase === 'connected') {
    /* THE SECOND SENTENCE HAS TO STOP REFERRING TO A NAME THAT IS NOT THERE.
       connectedReply() in shell/device-claim.cjs copies `name` by name and
       coerces a non-string to '', so a nameless connected machine is a real
       shape -- and "lists it under that name" was then a sentence about
       nothing, above a body that draws nothing either. Where to undo it is the
       part that must survive both spellings, because there is no control in
       this window that removes a computer from an account and the account page
       is genuinely the only place. */
    /* THE GREEN CAME OFF, AND IT HAD TO.
     *
     * "My Windows computer is on your account" was drawn in the good tone from
     * a DPAPI vault read on this machine and nothing else. It said exactly that
     * -- word for word, still green -- when the computer had been offline for
     * an hour, when the relay leg had never started, and when somebody had
     * removed the computer from the account page on a different machine. A
     * claim that cannot turn off is not a status, it is a decoration.
     *
     * WHAT IS ACTUALLY KNOWN is what the sentence now says: this computer holds
     * a credential for an account, and it has been asked nothing since. The
     * account page is the only thing that can say whether the account still
     * lists it, so the sentence sends people there rather than reassuring them
     * here. The service does compute `collected` / `waiting` / `never-collected`
     * and nothing in this window asks for it yet; when a verb exists to ask, the
     * good tone belongs on that answer and on no other. */
    const name = state.device?.name?.trim()
    const when = Number.isFinite(Number(state.claimedAtMs))
      ? new Date(Number(state.claimedAtMs)).toLocaleDateString()
      : ''
    const joined = when
      ? `This computer was joined to an account on ${when}.`
      : 'This computer holds a credential for an account.'
    /* THE ONE MOMENT THE GOOD TONE IS EARNED: the account service confirmed the
       collection to this window, seconds ago, on the poll that ended the wait.
       Every other route into this phase is a vault read, and a vault read
       cannot know. */
    if (state.serviceConfirmed) {
      return {
        tone: 'is-good',
        title: name ? `${name} is now on your account` : 'This computer is now on your account',
        detail: `Your account page confirmed it just now. To take it off again, sign in at ${ACCOUNT_PAGE_HOST} and open your account page.`,
      }
    }
    /* THE LAST SENTENCE SAYS WHAT TAKING IT OFF DOES NOT DO. A computer
       removed on the account page comes back to this screen still reading
       "joined" -- and the next code it asks for is refused. Where the
       disconnect control is drawn, the sentence points at it; where it is
       not (a shell without the verb), it says what used to be the whole
       truth, that nothing here clears it. Saying so is cheaper than letting
       somebody discover it. */
    const holds = disconnectable
      ? `Taking it off there does not change what this computer holds; to clear that, use “${DISCONNECT_ACTION_LABEL}” below.`
      : 'Taking it off there does not change what this computer holds, so this screen will keep saying it is joined.'
    return {
      tone: '',
      title: name ? `This computer is joined as ${name}` : 'This computer is joined to an account',
      detail: `${joined} That is read from this computer's own record, and it is the only thing this screen can check. Sign in at ${ACCOUNT_PAGE_HOST} and open your account page to see whether it is still listed there, or to take it off. ${holds}`,
    }
  }
  if (phase === 'unknown') {
    /* THE REFUSAL IS THE DETAIL, so nothing is lost by not drawing it as an
       alarm. It says what the read hit; the title says what that means for the
       person, which is "we do not know", and never "you are not connected". */
    return {
      tone: '',
      title: 'This screen could not check whether this computer is joined',
      detail: state.refusal
        ? `${state.refusal} You can still ask for a code below; if this computer is already on your account, the account page is where to see it.`
        : 'The installed application did not answer. You can still ask for a code below.',
    }
  }
  if (phase === 'starting') return { tone: '', title: 'Asking for a code', detail: 'The installed application is opening a code for this computer.' }
  if (phase === 'waiting') {
    /* "LEAVE IT OPEN OR COME BACK TO IT" IS WHAT THIS USED TO SAY, and it read
       as permission to close the window. It is not. The half of this ceremony
       that collects the credential is held in the installed application's own
       memory (shell/device-claim.cjs keeps the poll token in a variable and
       nowhere else), so quitting ToolsEnabled ends the claim from this side
       whatever the account page has been told. DRIVEN: quit with a code on
       screen, start again on the same profile, and the screen is back to
       "This computer is not on an account yet" with no mention of the code
       somebody is at that moment typing into their browser. Until that token
       outlives the process, the honest thing is to say so here. */
    return {
      tone: 'is-warn',
      title: 'Waiting for you to enter the code',
      detail: `Enter it on your account page at ${ACCOUNT_PAGE_HOST}. Leave ToolsEnabled running until this screen says the computer is joined; closing it means asking for a new code. Moving to another screen in this window is fine.`,
    }
  }
  if (phase === 'orphaned') {
    return {
      tone: 'is-warn',
      title: 'A code was already asked for',
      detail: 'One is still open for this computer, and this screen cannot show it a second time. Ask for a new one below.',
    }
  }
  if (phase === 'ended') return { tone: 'is-warn', title: endedTitle(state), detail: endedDetail(state) }
  /* IDLE AFTER A DISCONNECT SAYS WHAT JUST HAPPENED, once. "Not on an account
     yet" is a sentence for a computer that was never joined; a computer that
     was joined a second ago and is not now is owed the two facts a person
     will otherwise learn the hard way -- it is still on the account page, and
     joining again is a new code. The engine answers a second press, or a
     computer that held nothing, as wasConnected:false, and that is not a
     success to announce. */
  if (state.disconnected === 'cleared') {
    return {
      tone: '',
      title: 'This computer no longer holds its account connection',
      detail: 'It is still listed on your account page until you remove it there; joining again gives a new code.',
    }
  }
  if (state.disconnected === 'nothing') {
    return {
      tone: '',
      title: 'This computer was not connected',
      detail: 'Nothing to clear. Choose a name below and ask for a code.',
    }
  }
  return {
    tone: '',
    title: 'This computer is not on an account yet',
    detail: 'Nothing has been sent anywhere. Choose a name below and ask for a code.',
  }
}

/* THE ROW'S OWN SENTENCE MOVES WITH THE STATE, and it had to.
 *
 * SEEN ON GLASS: with the computer already on the account and no button drawn,
 * the row still read "Nothing is sent until you press the button" -- a sentence
 * about a control that was not there, sitting under a line saying the job was
 * already done. A description that outlives what it describes is the same
 * defect as a switch that does nothing; it just fails quietly. */
function rowDetail(state, { viaRelay = false, disconnectable = false } = {}) {
  if (state.disconnect && ['disconnecting', 'disconnect-review', 'idle'].includes(state.phase)) {
    return 'A status check only reads the connection state. Finishing a disconnect is a separate action that requires confirmation.'
  }
  if (state.phase === 'absent' && viaRelay) {
    return 'Nothing is sent from this browser. The computer you are driving is already joined; the switch that lets a browser drive it lives on that computer, not in this browser.'
  }
  if (state.phase === 'connected') {
    /* "Removing it is done on your account page in a browser" came off: it
       was the only answer while nothing here could clear the credential, and
       it is still where the computer's ROW is removed -- but the row's own
       sentence now names the two things the row actually offers. A shell
       without the verb draws no control, so it keeps the older sentence. */
    return disconnectable
      ? 'This computer is already joined. Set below whether a signed-in browser may drive it, or disconnect it from here.'
      : 'This computer is already joined. The one thing to set here is whether a signed-in browser may drive it, below. Removing it is done on your account page in a browser.'
  }
  if (state.phase === 'waiting' || state.phase === 'orphaned') {
    return 'Type the code into your browser, on your account page. Your password never passes through this window.'
  }
  /* THE SAME DEFECT AGAIN, ONE STATE ALONG. `checking` and `absent` draw no
     button at all -- bodyMarkup() returns nothing for either -- and both were
     still describing "the button" and what pressing it would send. MEASURED on
     a first run: the section stands in `checking` for about two and a half
     seconds with no control on it, under a sentence about a control. Two and a
     half seconds is long enough to read a sentence and start looking for the
     thing it names. */
  if (state.phase === 'checking') {
    return 'Nothing has been sent anywhere. This screen is asking the installed application what it already knows, and the button appears when it answers.'
  }
  if (state.phase === 'absent') {
    return 'Nothing can be sent from this window, because it has no way to reach the installed application.'
  }
  /* THE ROW STOPPED PROMISING "NOTHING IS SENT UNTIL YOU PRESS THE BUTTON"
     WHILE THE REQUEST WAS ALREADY ON THE WIRE. rowDetail had branches for five
     phases and none for `starting`, so the one moment the sentence is flatly
     untrue is the moment it was printed -- under a button reading "Asking...". */
  if (state.phase === 'starting') {
    return 'The request is on its way. Nothing about your account is sent from this screen except the name above.'
  }
  return 'Nothing is sent until you press the button. The code is shown here and typed on your account page, so your password never passes through this window.'
}

/* Four different things happened and they are four different sentences. All
   four end in the same offer, which is the button directly under them. */
function endedDetail(state) {
  if (state.endedBecause === 'gone') return 'It was either entered already or it ran out of time.'
  if (state.endedBecause === 'not-tracked') return 'The installed application is no longer holding a code for this computer.'
  /* THE SECOND HALF OF THIS WAS A GUESS DRESSED AS A FACT, and it is the one
     case that leaves somebody with a permanently broken row on their account
     page. cancel() drops the poll token in the installed application and
     NOTHING ELSE -- shell/device-claim.cjs says so in its own comment: there is
     no cancel endpoint, and the claim goes on existing on the service until it
     expires. So a person who had already typed the code into their browser
     before pressing Stop had very much joined something to their account, and
     this screen sent them away reassured that they had not. What it can honestly
     say is what THIS computer will now do, and what to look for if the other
     half already happened. */
  if (state.endedBecause === 'stopped') return 'This computer has given the code up and will not finish that connection. If you had already entered it on your account page, the computer it added there cannot finish either. Remove it on that page, then ask for a new code here.'
  return 'It ran out of time before it was entered.'
}

/* THE TITLE OF THE ENDING MOVES WITH IT TOO. "That code is no longer good" is
   the right line for three endings that happened TO somebody and the wrong one
   for the ending they chose, which needs no explaining and no alarm. */
function endedTitle(state) {
  return state.endedBecause === 'stopped' ? 'You stopped waiting' : 'That code is no longer good'
}

function statusMarkup(state, options) {
  const line = statusLine(state, options)
  return `<p class="fleet-profile-status ${esc(line.tone)}" data-connect-status aria-live="polite">
    <strong>${esc(line.title)}</strong>
    <span>${esc(line.detail)}</span>
  </p>`
}

/* EVERY REFUSAL IS ON THE GLASS AS ITS OWN SENTENCE, WHERE THE PRESS WAS, AND
 * OUT LOUD.
 *
 * It still never replaces the status line and never moves a control that was
 * already there: it is added, and it is added directly ABOVE the row of
 * buttons rather than below them, because below is off the bottom of the small
 * window a person actually uses. MEASURED at 1000x650 with the section idle:
 * the button's box ends at y=622 of a 652px viewport, so a sentence underneath
 * it would have been a refusal nobody could see without knowing to scroll.
 *
 * WHERE IT USED TO GO, AND WHY THAT WAS NOT ENOUGH. Under the status line at
 * the top of the section -- measured at 1446x906, y=417, for a button at y=630.
 * Two hundred pixels and two blocks of unrelated text above the place the
 * person was looking, on a screen where nothing else moved. It was visible and
 * it was not seen.
 *
 * role="alert" IS THE HALF THAT HAS NO PIXELS. The status line is aria-live and
 * this was not, so somebody working by ear pressed a button and heard nothing:
 * the same defect as an invisible refusal, for the people it is worst for.
 *
 * The identifier rides in an attribute a support conversation and a driver can
 * read and a person never will -- the rule src/refusal-copy.js sets for the
 * whole product. There is exactly ONE of these nodes in the section whatever
 * the state, so that attribute stays the one place to look. */
function refusalMarkup(state) {
  if (!state.refusal) return ''
  /* AND ONLY FOR A REFUSAL THAT FOLLOWED A PRESS. A red alert about a step the
     person never started -- "This computer is already in the middle of a
     connection step. Wait for that one to finish." -- was the first thing a
     brand-new customer met on this screen, four inches under "Nothing has been
     sent anywhere." Reproduced on three independent sterile profiles. A
     background read that was refused is explained by the status line above
     (see the `unknown` branch of statusLine); it is not an alarm, and it must
     not take role="alert". */
  if (state.refusalPressed === false) return ''
  const machineChannel = state.refusalCode ? ` data-refusal-code="${esc(state.refusalCode)}"` : ''
  return `<p class="connect-refusal" data-connect-refusal role="alert"${machineChannel}>${esc(state.refusal)}</p>`
}

/* SOMETHING TRUE THAT IS NOT AN ALARM. Drawn beside the refusal slot and
   styled apart from it: a note is news, a refusal is a wall, and a person who
   cannot tell them apart reads every one of them as a wall. Today there is one
   note -- a code that was already open has been given up -- and it is announced
   politely rather than with role="alert", because nothing has gone wrong. */
function noteMarkup(state) {
  if (!state.note) return ''
  return `<p class="connect-note" data-connect-note>${esc(state.note)}</p>`
}

/* The name box. `maxlength` is the whole of the repair described at
   MAX_DEVICE_NAME in src/device-claim-flow.js: the box stops where the
   installed application stops, so a name that is too long is a keystroke that
   does not appear rather than a refusal that arrives after a round trip. The
   limit is also written under the box, because a box that silently stops
   accepting characters is its own small mystery. */
/* AN EXAMPLE, NOT THE SAME WORDS THE BOX IS ALREADY FILLED WITH.
 *
 * The value and the placeholder used to be the identical string, so a box
 * carrying a real, submittable name read as an empty box wearing a hint --
 * and everybody left it alone. The owner's two computers both enrolled as "My
 * Windows computer", and the account page then drew two identical rows
 * distinguishable only by date, next to a destructive button. A placeholder
 * that shows only when the box is EMPTY, and shows something nobody would
 * mistake for the default, is what makes the filled box read as filled. */
const NAME_EXAMPLE = 'Office desktop'

function nameFieldMarkup(state, disabled) {
  const value = state.name || defaultDeviceName({ profileLabel: profileLabel(), platform: state.platform })
  return `<label class="connect-name">
    <span>Name for this computer</span>
    <input class="fleet-profile-input" data-connect-field="name" value="${esc(value)}"
      placeholder="${esc(NAME_EXAMPLE)}"
      maxlength="${MAX_DEVICE_NAME}"
      autocomplete="off" spellcheck="false" ${disabled ? 'disabled' : ''}/>
  </label>
  <small>This is the name your account page will show, up to ${MAX_DEVICE_NAME} characters. Change it now if you want to. Nothing in this window renames a computer once it is joined, so pick a name that tells this machine apart from your others.</small>`
}

/* THE THREE STEPS, SPELLED OUT, IN THE ORDER A PERSON DOES THEM. The website
   address is text and not a link on purpose: nothing else in this window opens
   an outside page, and a link that quietly does nothing when pressed is the
   exact defect this screen exists to stop repeating. Text can be read off the
   screen and typed into any browser, including one on another device, which is
   what most people will actually do. */
function stepsMarkup() {
  /* THERE ARE FOUR STEPS AND THE SCREEN USED TO NAME THREE. An account with a
     password is asked for a six-digit emailed code before it may add a
     computer (SECOND_FACTOR_REFUSED on the account service), and nobody was
     told -- while a ten-minute clock ran on this screen. It is written as a
     conditional because it genuinely is one: an account created with Google
     never sees it. */
  return `<ol class="connect-steps">
    <li>Sign in at <span class="connect-host">${esc(ACCOUNT_PAGE_HOST)}</span>.</li>
    <li>Open your account page.</li>
    <li>Enter the code above and confirm it.</li>
    <li>If your account has a password, the page emails you a six-digit code as well. Enter that too, and keep this screen open while you fetch it.</li>
  </ol>`
}

/* The code, big enough to read off the screen and select in one press.
 *
 * IT IS A READ-ONLY FIELD RATHER THAN A PARAGRAPH, and that is an
 * accessibility decision, not a styling one. A person on the keyboard alone can
 * tab to a field, press Ctrl+C and have the code; there is no keyboard way to
 * select the text of a paragraph. Read-only, so the caret has nothing to do and
 * selecting the whole value on focus costs nobody anything.
 */
function codeMarkup(state, nowMs) {
  return `<div class="connect-code-wrap">
    <div class="connect-code-row">
      <input class="connect-code" data-connect-code readonly value="${esc(state.code || '')}"
        aria-label="The code to enter on your account page" spellcheck="false" autocomplete="off"/>
      ${copyMarkup()}
    </div>
    <p class="connect-remaining" data-connect-remaining>${esc(remainingText(state.expiresAtMs, nowMs))}</p>
  </div>`
}

/* THE COPY BUTTON, WHICH IS ALSO THE ONLY SIGN THAT THE CODE CAN BE COPIED.
 *
 * DRIVEN, and both routes already worked: a triple-click then Ctrl+C put
 * exactly TC-JJW4-GPK4 on the clipboard, and so did one click then Ctrl+C,
 * because handleFocusIn() selects the whole value. Nothing on the screen said
 * so. The code is set 34px high with no box and a hairline under it, which is
 * how a heading looks, and nobody triple-clicks a heading. A person on the same
 * computer as their browser was left transcribing eight characters by eye from
 * an alphabet that has no I, O, 0 or 1 in it precisely because transcription is
 * expected to go wrong.
 *
 * The label is lifted out of the template for the reason buttonMarkup() gives:
 * the word "code" must never appear inside an interpolation on this screen. */
const COPY_LABEL = 'Copy'
const COPY_DONE_LABEL = 'Copied'
const COPY_MANUAL_LABEL = 'Press Ctrl+C'

function copyMarkup() {
  return `<button type="button" class="ctl-btn connect-copy" data-connect-action="copy"
    aria-label="Copy the code">${COPY_LABEL}</button>`
}

function buttonMarkup(state, { disabled = false } = {}) {
  if (state.phase === 'connected' || state.phase === 'absent' || state.phase === 'checking') return ''
  /* "Stop waiting" GIVES THE CODE UP, AND NOW SAYS SO BEFORE IT IS PRESSED.
     It reads like a control over this screen -- stop the counting, stop the
     asking -- and it is not: cancel() drops the claim in the installed
     application, and a person who pressed it hoping to pause found their code
     replaced by a name box. A destructive control has to name what it destroys
     while there is still something to lose. */
  if (state.phase === 'waiting') {
    return `<div class="fleet-profile-actions">
      <button type="button" class="ctl-btn" data-connect-action="cancel">Stop waiting</button>
    </div>
    <small>Stopping gives this code up. You can ask for another one afterwards.</small>`
  }
  if (state.phase === 'ended' || state.phase === 'orphaned') {
    return `<div class="fleet-profile-actions">
      <button type="button" class="ctl-btn armed" data-connect-action="restart">Get a new code</button>
    </div>`
  }
  /* The label is lifted out of the template rather than written inline, so the
     word "code" never appears inside an interpolation. tools/test/refusal-copy
     scans for exactly that shape, and it is right to: `${result.code}` in a
     button is how the last bare identifier in this product got on the glass. */
  /* BUSY IS SAID WITH aria-disabled AND NOT WITH disabled, and that is the
     other half of the focus repair in refresh().
     A `disabled` button cannot hold focus. So pressing "Get a code" by keyboard
     went: focus on the button, one repaint into `starting`, the button replaced
     by a disabled one, focus dropped to <body> -- and by the time the refusal
     arrived there was nothing left to put the keyboard back onto. MEASURED
     exactly that way: activeElement was BODY after a refused press, which is
     sixteen tabs from the button that refused.
     Nothing is loosened by the swap. Two guards already stop a second ask and
     neither is this attribute: begin() returns early while `inFlight`, and
     shell/device-claim.cjs answers DEVICE_CLAIM_BUSY to anything that gets past
     it. handleClick() checks it as well, so the press is ignored here too. */
  const busy = state.phase === 'starting'
  const label = busy ? 'Asking&hellip;' : 'Get a code'
  return `<div class="fleet-profile-actions">
    <button type="button" class="ctl-btn armed" data-connect-action="begin" ${busy || disabled ? 'aria-disabled="true"' : ''}>${label}</button>
  </div>`
}

/* The block under the status line, which is the part that changes with the
   state. Everything a given state needs and nothing it does not: no element is
   ever shipped carrying `hidden`, so the trap src/styles.css documents at
   .ctl-btn[hidden] has nothing to catch here. */
/* THE SWITCH, AND THE SENTENCE THAT SAYS WHAT IT IS SET TO.
 *
 * This is the only control in the product that writes `mc.relay.web-drive`,
 * the key shell/relay-supervisor.cjs reads per command to decide whether a
 * browser may change anything on this machine. It is drawn in the connected
 * branch only: a computer that is not on an account has no browser that could
 * drive it, and a switch for a situation that cannot arise is the half-setting
 * shell/product-settings.cjs exists to forbid.
 *
 * IT IS A `.toggle` AND DELIBERATELY NOT A `.settings-toggle`. src/views/
 * settings.js listens for `change` on `.settings-toggle input` and looks the
 * row up in the catalogue by its setting id; this row's id names a section
 * controller, not a catalogue entry, so that handler would reach
 * applyValue(undefined) and throw. Leaving the second class off is what keeps
 * the page's handler from ever seeing this input; handleChange() below is the
 * only listener it has.
 *
 * `webDrive` is the store's answer at paint time -- true, false, or null when
 * this window has no durable store to write to. Null draws the sentence and no
 * control: a switch whose press cannot be saved is a switch that lies. */
function webDriveMarkup(webDrive) {
  if (webDrive === null) {
    return `<div class="settings-copy">
      <div class="settings-name" id="connect-web-drive-label">${esc(WEB_DRIVE_CONTROL_LABEL)}</div>
      <div class="settings-desc" data-connect-web-drive-state>This window cannot save that choice, so driving from a browser stays off.</div>
    </div>`
  }
  const truth = toggleStateSentence({ value: webDrive, def: false, acts: true })
  return `<div class="settings-copy">
      <div class="settings-name" id="connect-web-drive-label">${esc(WEB_DRIVE_CONTROL_LABEL)}</div>
      <div class="settings-desc" data-connect-web-drive-state>${esc(truth)} On means anyone signed in to your account in a browser can start agents on this computer and change its organisation from there. Off means a browser can see what is here and change nothing. This is set here, on this computer, on purpose; a browser cannot turn it on.</div>
    </div>
    <label class="toggle"><input type="checkbox" data-connect-field="web-drive" aria-labelledby="connect-web-drive-label" ${webDrive ? 'checked' : ''}/><i></i></label>`
}

/* THE QUESTION, ASKED ONCE, AT THE MOMENT IT BECOMES MEANINGFUL.
 *
 * The owner's ruling: the prompt belongs at the moment the switch starts to
 * matter, which is the moment this computer lands on an account. That moment
 * is precisely located -- `serviceConfirmed` is true only in the controller
 * that saw the poll come back `connected` (src/device-claim-flow.js), and every
 * later visit to this screen is a vault read that sets it false. So "once" is
 * structural rather than recorded: no flag is written for "Not now", and a
 * machine that was already joined before this existed is never nagged. The
 * refusal sentence a browser meets walks everyone else to the switch.
 *
 * It is a `.connect-note`, not an alert: nothing has gone wrong. A window with
 * no store to save into gets no question either, because "turn it on below"
 * would point at a switch that is not drawn. */
/* THIS SENTENCE ASSERTED A STATE IT WAS HOLDING AND NOT READING.
 *
 * It said "It is off." unconditionally, checking `webDrive` only for null. The
 * value is right there in the argument.
 *
 * That mattered because the consent is meant to be cleared when a computer
 * disconnects. shell/main.cjs says so where it clears it -- "a later join may be
 * to a different one, and the question at that join says 'It is off' -- WHICH
 * MUST BE TRUE" -- and then ignores the removal's return value, catching only a
 * throw. rendererPrefs.remove() does not throw on a failed write; it answers
 * { ok: false }. So a disconnect whose preference write failed reported a clean
 * disconnect, left the consent ON, and the next join asked this question about
 * a permission that was already granted -- to a DIFFERENT account.
 *
 * Reading the value makes the sentence true whichever way the removal went,
 * which is a better guarantee than fixing only the removal path: this screen
 * stops depending on a write somewhere else having succeeded. */
function askMarkup(state, webDrive, asked) {
  if (state.phase !== 'connected' || !state.serviceConfirmed || asked) return ''
  if (webDrive === null) return ''
  return `<div class="connect-note" data-connect-web-drive-ask>
    ${webDrive === true
        ? `<p><strong>One thing to check, now that this computer is on your account.</strong> That permission is already on, carried over from before this computer joined. A browser signed in to your account can start agents here and change this computer&rsquo;s organisation. Turn it off below if you did not mean to allow that for this account.</p>`
      : `<p><strong>One question, now that this computer is on your account.</strong> May a browser that is signed in to your account start agents on this computer and change its organisation from there? It is off. Turn it on below if you want that, or leave it off; this is the only time it is asked.</p>`}
    <div class="fleet-profile-actions">
      <button type="button" class="ctl-btn" data-connect-action="web-drive-later">Not now</button>
    </div>
  </div>`
}

/* THE ACCOUNT-IDENTITY QUESTION USES THE SAME ONE-TIME QUESTION SHAPE AS THE
 * web-drive question above: a note directly under the status line, plain text,
 * then its actions. It is a separate moment, not a second protocol path.
 *
 * THE EMAIL IS WIRE TEXT. It is never put into a class, selector, URL or raw
 * template slot; esc() is the only route into markup. It is deliberately not
 * shortened. This is the identity the person must compare with their own. */
function reservationMarkup(reservation, { deciding = false, refusal = '' } = {}) {
  if (!reservation) return ''
  const unavailable = 'A decision is already being sent. Wait for this computer to answer.'
  const blocked = deciding ? ` disabled aria-disabled="true" title="${esc(unavailable)}"` : ''
  return `<div class="connect-note" data-connect-reservation>
    <p><strong>This account is asking to claim this computer.</strong></p>
    <p>Account: <span class="connect-host" data-connect-reservation-email>${esc(reservation.email)}</span></p>
    <p>Accept only if this is your account. Accepting adds this computer to that account. Declining adds nothing and spends this code.</p>
    ${refusal ? `<p class="connect-refusal" data-connect-decision-refusal role="alert">${esc(refusal)}</p>` : ''}
    <div class="fleet-profile-actions">
      <button type="button" class="ctl-btn" data-connect-action="accept-reservation"${blocked}>Accept this account</button>
      <button type="button" class="ctl-btn" data-connect-action="decline-reservation"${blocked}>Decline this account</button>
    </div>
    ${deciding ? `<small data-connect-decision-unavailable>${esc(unavailable)}</small>` : ''}
  </div>`
}

function reservationStatusMarkup({ collecting = false, declined = false } = {}) {
  if (declined) {
    return `<p class="fleet-profile-status" data-connect-status aria-live="polite">
      <strong>You declined the account</strong>
      <span>Nothing was added to an account, and that code is now spent.</span>
    </p>`
  }
  if (collecting) {
    return `<p class="fleet-profile-status" data-connect-status aria-live="polite">
      <strong>You accepted the account</strong>
      <span>This computer is collecting its connection. Leave ToolsEnabled running until it says the computer is joined.</span>
    </p>`
  }
  return `<p class="fleet-profile-status is-warn" data-connect-status aria-live="polite">
    <strong>Your decision is required on this computer</strong>
    <span>Check the full account address below. Nothing is added unless you explicitly accept it here.</span>
  </p>`
}

/* A save that did not happen is said where the switch is, as a wall and out
   loud: the switch has already sprung back to the store's truth by the time
   this is read, and a person who saw it move has to be told why it moved. */
function webDriveNoticeMarkup(notice) {
  if (!notice) return ''
  return `<p class="connect-refusal" data-connect-web-drive-notice role="alert">${esc(notice)}</p>`
}

/* THE DEFAULT READER AND WRITER GO THROUGH localStorage, AND THAT IS THE
 * WHOLE ROUTE. public/durable-storage.js replaces localStorage in the desktop
 * shell with a store whose every write goes over `mcPrefs.write` to
 * `mc-prefs:write` in shell/main.cjs and lands in shell/renderer-prefs.cjs --
 * the same record shell/relay-supervisor.cjs reads per command. No new IPC, no
 * registry row. The key is outside `mc.set.`, so durable-storage never mirrors
 * it to the account: the choice stays on the machine it was made on.
 *
 * GUARDED ON `window.mcPrefs.available === true`, which is the exact test
 * durable-storage.js makes before installing itself. Without it localStorage
 * is the browser's own, the relay would never see the write, and the switch
 * would claim to have granted something it had not. So a window without the
 * bridge reads null, and null draws no control. */
function defaultReadWebDrive() {
  if (globalThis.window?.mcPrefs?.available !== true) return null
  return globalThis.localStorage?.getItem?.(WEB_DRIVE_PREF_KEY) === WEB_DRIVE_ON
}

function defaultWriteWebDrive(on) {
  if (globalThis.window?.mcPrefs?.available !== true) throw new Error('no durable store in this window')
  if (on) globalThis.localStorage.setItem(WEB_DRIVE_PREF_KEY, WEB_DRIVE_ON)
  else globalThis.localStorage.removeItem(WEB_DRIVE_PREF_KEY)
}

const WEB_DRIVE_SAVE_FAILED = 'That choice could not be saved on this computer, so nothing changed. Try once more; if it still will not save, the settings file could not be written.'

/* "DISCONNECT THIS COMPUTER", drawn on the joined screen and nowhere else.
 *
 * TWO PRESSES. The first arms the control (src/arm-press.js: `data-armed`,
 * `aria-pressed`) and fills the hint under it with what the second press will
 * and will not do; a lone press disarms itself after eight seconds and the
 * hint goes with it. The hint is the ONE element this section ships carrying
 * `hidden`, and it is safe to: `.connect-note` sets no `display` of its own,
 * so the user agent's `[hidden] { display: none }` is not overridden (the trap
 * tools/test/hidden-display-honesty.test.mjs exists for). It is filled and
 * shown by the press handler rather than by a repaint, because arming is a
 * fact about this control for the next eight seconds, not about the claim.
 *
 * NEVER DRAWN FOR A BROWSER READING THROUGH THE RELAY (the joined phase is not
 * reachable there, and the rule is stated anyway), and never for a shell whose
 * bridge lacks the verb: a control that cannot be carried out is the defect
 * this whole screen exists to stop repeating. */
function disconnectMarkup({ finishing = false, disabled = false } = {}) {
  return `<div class="fleet-profile-actions">
      <button type="button" class="ctl-btn" data-connect-action="disconnect" aria-pressed="false"${disabled ? ' disabled' : ''}>${finishing ? 'Finish disconnect' : DISCONNECT_ACTION_LABEL}</button>
    </div>
    <p class="connect-note" data-connect-disconnect-hint hidden></p>`
}

function disconnectFactsMarkup(state) {
  const facts = state.disconnect
  const cause = facts.localCause === 'SECRET_BACKEND_LOCKED'
    ? 'Unlock your normal desktop keyring, then check connection status.'
    : facts.localCause === 'SECRET_BACKEND_UNAVAILABLE'
      ? 'The desktop keyring service is unavailable. Check that it is running in your desktop session, then check connection status.'
      : ['SECRET_BACKEND_KEY_MISSING', 'SECRET_BACKEND_KEY_INVALID', 'SECRET_VAULT_UNREADABLE', 'SECRET_VAULT_PATH_UNSAFE'].includes(facts.localCause)
        || state.refusalCode === 'DEVICE_CLAIM_CONNECTION_STATE_UNREADABLE'
        ? 'The saved connection store could not be read safely. Preserve existing app data and use supported recovery.'
        : ['DEVICE_CLAIM_CONSENT_CLEAR_FAILED', 'DEVICE_CLAIM_CONNECTION_STATE_WRITE_FAILED'].includes(state.refusalCode)
          ? 'ToolsEnabled could not save its connection settings. Check that its existing app data can be saved before connecting again.' : ''
  return `<div data-connect-disconnect-facts>
    <p class="connect-note">${facts.remoteStopped === true ? 'Remote network connection: stopped.' : 'Remote network connection: stop not confirmed.'}</p>
    <p class="connect-note">${facts.remoteAccessBlocked === true ? 'New remote access: blocked in this app.' : 'New remote access: block not confirmed.'}</p>
    <p class="connect-note">${facts.childQuiescent === true ? 'Local connection processes: finished.' : 'Local connection processes: completion not confirmed.'}</p>
    <p class="connect-note">${facts.restartSafety === 'recorded' ? 'The block on remote access was saved.' : 'The block on remote access could not be confirmed as saved. Keep ToolsEnabled running while checking its connection status.'}</p>
    ${facts.mutationOutcome === 'UNCERTAIN' ? '<p class="connect-note">The earlier credential removal has an uncertain outcome. A status read reports current contents; it does not confirm how that earlier write finished.</p>' : ''}
    ${facts.mutationOutcome === 'NOT_ATTEMPTED' ? '<p class="connect-note">The credential removal step did not write a change.</p>' : ''}
    ${cause ? `<p class="connect-note">${cause}</p>` : ''}
  </div>`
}

function bodyMarkup(state, nowMs, webDrive, { disconnectable = false, busy = false } = {}) {
  const phase = state.phase
  if (phase === 'absent' || phase === 'checking') return ''
  if (state.disconnect && ['disconnecting', 'disconnect-review', 'idle'].includes(phase)) {
    const facts = state.disconnect
    const finishing = phase === 'disconnect-review' && (facts.disconnectPending !== false
      || facts.restartSafety !== 'recorded' || facts.remoteStopped !== true || facts.childQuiescent !== true
      || (facts.credentialCleared !== true && facts.credentialObservedAbsent !== true))
    return `<div class="fleet-profile-fields">
      ${refusalMarkup(state)}
      ${disconnectFactsMarkup(state)}
      <div class="fleet-profile-actions"><button type="button" class="ctl-btn" data-connect-action="check-status"${busy || phase === 'disconnecting' ? ' disabled' : ''}>Check connection status</button></div>
      ${finishing && disconnectable ? disconnectMarkup({ finishing: true, disabled: busy }) : ''}
      ${canBeginConnection(state) ? `${nameFieldMarkup(state, busy)}${buttonMarkup(state, { disabled: busy })}` : ''}
    </div>`
  }
  if (phase === 'connected') {
    /* A NAMELESS CONNECTED MACHINE USED TO DRAW NO BODY AT ALL. It still
       draws no name line, but the switch below belongs to every joined
       computer whatever its record calls it, so the early return is gone. */
    const device = state.device
    const known = device?.name
      ? `<p class="connect-known">This computer's own record has it joined as <span class="connect-host">${esc(device.name)}</span>.</p>`
      : ''
    /* The refusal sits with the control that produced it -- a disconnect that
       refused, or a code refused because this computer is already joined --
       directly above the button, by the same measurement every other body
       follows. */
    return `<div class="fleet-profile-fields">
      ${known}
      ${webDriveMarkup(webDrive)}
      ${refusalMarkup(state)}
      ${disconnectable ? disconnectMarkup() : ''}
    </div>`
  }
  if (phase === 'waiting') {
    /* THE NAME THAT ACTUALLY WENT UP, SAID BACK. The box is gone by now, and
       nameToClaim() may not have used what was in it: somebody who cleared it
       had the guess filed on their behalf, which is the right call and a
       surprise if the first they hear of it is the row on their account page.
       `claimedName` is that decision as it was made, carried on the state --
       recomputing it here was wrong and was CAUGHT ON GLASS at 1000x650: a
       claim opened as "Front desk", left and returned to, reported "My Windows
       computer", because the rebuilt screen had a fresh box with a fresh guess
       in it. The fallback is for a claim opened before that field existed. */
    return `<div class="fleet-profile-fields">
      ${codeMarkup(state, nowMs)}
      <p class="connect-known">It will be listed as <span class="connect-host">${esc(state.claimedName || nameToClaim(state))}</span>.</p>
      ${stepsMarkup()}
      ${noteMarkup(state)}
      ${refusalMarkup(state)}
      ${buttonMarkup(state)}
    </div>`
  }
  /* ENDED AND ORPHANED KEEP THE NAME BOX, and that was a gap rather than a
     decision: a code that ran out left a screen with one button on it, so
     somebody who had meant to rename this computer before joining it had to get
     a code they did not want, stop waiting for it, and start again. The next
     code is asked for with whatever is in this box, so the box belongs on every
     screen that offers to ask for one. */
  if (phase === 'ended' || phase === 'orphaned') {
    return `<div class="fleet-profile-fields">
      ${nameFieldMarkup(state, false)}
      ${noteMarkup(state)}
      ${refusalMarkup(state)}
      ${buttonMarkup(state)}
    </div>`
  }
  return `<div class="fleet-profile-fields">
    ${nameFieldMarkup(state, phase === 'starting')}
    ${noteMarkup(state)}
    ${refusalMarkup(state)}
    ${buttonMarkup(state)}
  </div>`
}

/* The refusal is drawn once. Inside the body it sits with the button that
   produced it; the two states that draw no body keep it under the status
   line, where it is still the only other thing on the section. The joined
   screen has a body, and a control in it, since "Disconnect this computer". */
function refusalHasABody(state) {
  return state.phase !== 'absent' && state.phase !== 'checking'
}

function profileLabel() {
  const label = FLEET_PROFILE_RESOLUTION?.rawProfile?.label
  return typeof label === 'string' ? label : ''
}

/* THE ONE THING THAT OUTLIVES A CONTROLLER, AND WHY IT HAS TO.
 *
 * src/views/settings.js builds a controller in its factory and destroys it with
 * the view, so leaving Settings and returning is a NEW controller starting from
 * `checking` with no memory. DRIVEN, with a real code up: away to another
 * screen, straight back, and the section read "This computer is not on an
 * account yet -- nothing has been sent anywhere" for two seconds, then "A code
 * was already asked for; this screen cannot show it a second time." Two clicks
 * inside one window cost the person their code and told them it could not be
 * shown again.
 *
 * WHAT IS KEPT IS WHAT WAS ALREADY ON THE GLASS: the code and its deadline. The
 * poll token is not here, is not reachable from here, and has no field to be
 * put in -- the guarantee the header makes about this whole file. It lives for
 * as long as the window does, which is the same lifetime the installed
 * application gives the claim itself, so the two cannot disagree by outliving
 * each other.
 *
 * IT IS A MEMORY AND NEVER AN AUTHORITY. Restoring it puts the code back on
 * screen; whether the claim is still good is still settled by the next poll,
 * which ends the wait honestly if the answer is `gone` or `none`. */
let rememberedClaim = null

function rememberClaim(state) {
  if (state.phase === 'waiting' && state.code) {
    rememberedClaim = {
      code: state.code,
      claimedName: state.claimedName,
      expiresAtMs: state.expiresAtMs,
      intervalSeconds: state.intervalSeconds,
    }
    return
  }
  /* Anything that is not a live wait means there is nothing to come back to.
     `starting` is the one in-between, and it is left alone so that a second
     screen built mid-request does not lose a claim that is about to exist. */
  if (state.phase !== 'starting') rememberedClaim = null
}

function claimWorthRestoring(nowMs) {
  const claim = rememberedClaim
  if (!claim || !claim.code) return null
  const ends = Number(claim.expiresAtMs)
  if (Number.isFinite(ends) && nowMs >= ends) {
    rememberedClaim = null
    return null
  }
  return claim
}

/* For the tests, which must not inherit one run's memory into the next. */
export function forgetRememberedClaim() {
  rememberedClaim = null
}

export function createConnectComputerSettings({
  now = () => Date.now(),
  schedule = (fn, ms) => setInterval(fn, ms),
  cancelTimer = handle => clearInterval(handle),
  resolveBridge = () => deviceClaimBridge(),
  readWebDrive = defaultReadWebDrive,
  writeWebDrive = defaultWriteWebDrive,
  /* Whether this page is being read THROUGH the computer it describes (a
     browser driving it over the relay). Injected so the tests can say so
     without a data source; the product reads the resolved source. */
  readingOverRelay = () => currentDataSource() === 'relay',
} = {}) {
  let hostRoot = null
  function relayReading() {
    try { return { viaRelay: readingOverRelay() === true, refusalCode: null } } catch {
      return { viaRelay: false, refusalCode: DATA_SOURCE_CHECK_FAILED }
    }
  }
  /* THE CONTROL IS NEVER DRAWN FOR A BROWSER READER, and never without the
     verb behind it. Asked at paint time and again at press time, so a bridge
     that changed between the two is refused rather than thrown at. */
  function disconnectCapability(relay) {
    if (relay.refusalCode || relay.viaRelay) return { available: false, refusalCode: null }
    try {
      return { available: bridgeCanDisconnect(resolveBridge()), refusalCode: null }
    } catch {
      /* A busy or unreadable bridge is not an older bridge without disconnect.
         In particular, do not memoize this result: markup() asks again, so a
         transient EMFILE/EAGAIN/EIO/EBUSY (or an unshaped throw) cannot remove
         the control for the life of this Settings controller. */
      return { available: false, refusalCode: DISCONNECT_CHECK_FAILED }
    }
  }
  let clock = null
  let torn = false
  let asked = false
  let inFlight = false
  let checkingStatus = false
  let operationEpoch = 0
  let copiedAtMs = 0
  /* Whether the one-time question has been answered or dismissed on THIS
     controller. Never written anywhere: see askMarkup() for why once is
     structural. */
  let webDriveAsked = false
  let webDriveNotice = ''
  /* Reservation state belongs to this question surface, not to the older claim
     reducer: the shell remains the authority and repeats a cached reservation
     after this controller is rebuilt. No value here can accept it; only the
     explicit boolean sent by decideReservation() can. */
  let reservation = null
  let decisionInFlight = false
  let decisionRefusal = ''
  let collectingAccepted = false
  let declinedReservation = false

  /* THE STORE IS THE TRUTH, NEVER THE PRESS. The checkbox is redrawn from
     this after every change, so a write that failed shows the old value
     rather than the value somebody hoped for. A reader that throws reads as
     "cannot save", which draws no control. */
  function webDriveOn() {
    try {
      const value = readWebDrive()
      return value === null || value === undefined ? null : value === true
    } catch {
      return null
    }
  }
  let state = initialState({
    name: defaultDeviceName({ profileLabel: profileLabel(), platform: currentPlatform() }),
    platform: currentPlatform(),
  })

  function markup({ searchResult = false } = {}) {
    /* THE FIRST PAINT READS THE CLOCK THIS CONTROLLER WAS HANDED, not the wall
       clock. They are the same thing in the product and are deliberately not in
       a test, which is how this was caught: a markup() that asked Date.now()
       painted "run out" over a code with five minutes left. */
    const nowMs = now()
    /* Read once per paint so the question and the switch agree. */
    const webDrive = state.phase === 'connected' ? webDriveOn() : null
    /* Whether "Disconnect this computer" may be drawn: this window holds the
       verb, and it is not a browser reading through the relay. Decided once
       per paint so the status line, the row and the body agree. */
    const relay = relayReading()
    const disconnect = ['connected', 'disconnect-review'].includes(state.phase)
      ? disconnectCapability(relay)
      : { available: false, refusalCode: null }
    const disconnectable = disconnect.available
    /* THE QUESTION SITS DIRECTLY UNDER THE STATUS LINE AND ABOVE THE ROW.
       MEASURED at 1000x650: the row's box ends near y=620 of a 652px viewport,
       so anything under it is off the glass; the status line is the one thing
       a person is looking at when the claim lands, and the question goes right
       beneath it. */
    const shownPhase = declinedReservation
      ? 'declined'
      : (reservation ? 'reserved' : (collectingAccepted ? 'collecting' : state.phase))
    const claimStatus = (reservation || collectingAccepted || declinedReservation)
      ? reservationStatusMarkup({ collecting: collectingAccepted, declined: declinedReservation })
      : statusMarkup(state, { viaRelay: relay.viaRelay, disconnectable })
    return `<section class="settings-section connect-section" data-settings-section="${esc(CONNECT_SECTION)}" data-connect-settings data-connect-phase="${esc(shownPhase)}">
      ${searchResult ? `<div class="settings-prefix">${relay.viaRelay ? 'Connect the computer you are driving to your account' : 'Connect this computer to your account'}</div>` : ''}
      <h2 class="settings-section-title">${esc(CONNECT_SECTION)}</h2>
      <p class="settings-section-note" data-fra-testing-notice>FRA is only for testing purposes. It has not been independently tested yet.</p>
      <p class="settings-section-note host-absent-body">You signed up on the website, and its account page asks for a code. This is the screen that gives you one.</p>
      ${claimStatus}
      ${reservationMarkup(reservation, { deciding: decisionInFlight, refusal: decisionRefusal })}
      ${collectingAccepted && state.refusal ? `<p class="connect-refusal" data-connect-refusal role="alert">${esc(state.refusal)}</p>` : ''}
      ${askMarkup(state, webDrive, webDriveAsked)}
      ${state.disconnect && ['starting', 'waiting', 'orphaned'].includes(state.phase) ? '<p class="connect-note">Remote access remains blocked while this new connection is completed. Its Drive setting starts off.</p>' : ''}
          ${refusalHasABody(state) ? '' : refusalMarkup(state)}
          ${relay.refusalCode ? `<p class="connect-refusal" data-connect-source-check-refusal data-refusal-code="${relay.refusalCode}" role="alert">This screen could not check whether it is running on this computer or reading it through another one. That is not a claim that either location applies; try this screen again.</p>` : ''}
      <div class="settings-section-rows">
        <article class="settings-row fleet-profile-block" data-connect-row data-setting-id="${esc(CONNECT_SETTING_ID)}">
          <div class="settings-copy">
                <div class="settings-name">${relay.viaRelay ? 'Join the computer you are driving to your account' : 'Join this computer to your account'}</div>
                <div class="settings-desc">${esc(rowDetail(state, { viaRelay: relay.viaRelay, disconnectable }))}</div>
          </div>
          ${reservation || collectingAccepted ? '' : bodyMarkup(state, nowMs, webDrive, { disconnectable, busy: inFlight || checkingStatus })}
          ${state.phase === 'connected' ? webDriveNoticeMarkup(webDriveNotice) : ''}
          ${disconnect.refusalCode ? `<p class="connect-refusal" data-connect-disconnect-check-refusal data-refusal-code="${disconnect.refusalCode}" role="alert">This screen could not check whether the installed application can disconnect this computer. That is not a claim that disconnect is unavailable; try this screen again.</p>` : ''}
          <div class="settings-disclosure">${guidanceMarkup(CONNECT_SETTING_ID, { section: CONNECT_SECTION })}</div>
        </article>
      </div>
    </section>`
  }

  /* REDRAW ONLY ON WHAT A PERSON WOULD SEE CHANGE, which is a narrower rule
     than "the state moved" and had to be. Measured in a browser: a `pending`
     answer every two seconds moves nextPollAtMs, which moved the state, which
     rebuilt the section and took away the selection somebody had just made on
     their code. repaintNeeded() is that rule, written down where a test can
     hold it; the clock and the wire still get every change. */
  function apply(event) {
    const previous = state
    state = reduce(state, event)
    if (state === previous) return false
    if (['disconnecting', 'disconnect-review'].includes(state.phase)) {
      reservation = null; collectingAccepted = false; decisionInFlight = false; decisionRefusal = ''; declinedReservation = false
    }
    rememberClaim(state)
    syncClock()
    if (repaintNeeded(previous, state)) refresh()
    return true
  }

  /* WHICH CONTROL IN THIS SECTION HAS THE KEYBOARD, said as something that
     survives the node being replaced. A selector, not a node: refresh() writes
     outerHTML, so every node in here is a different object afterwards. */
  function focusedControl() {
    const active = hostRoot?.ownerDocument?.activeElement
    if (!active || !hostRoot.contains(active)) return null
    const action = active.dataset?.connectAction
    if (action) return `[data-connect-action="${action}"]`
    const field = active.dataset?.connectField
    if (field) return `[data-connect-field="${field}"]`
    if (active.hasAttribute?.('data-connect-code')) return '[data-connect-code]'
    return null
  }

  function refresh() {
    if (!hostRoot) return
    const current = hostRoot.querySelector('[data-connect-settings]')
    if (!current) return
    const searchResult = current.querySelector('.settings-prefix') !== null
    /* THE KEYBOARD GOES BACK WHERE IT WAS, because a repaint that drops it is a
       repaint that throws somebody out of the section. MEASURED: it is sixteen
       tabs from the top of Settings to "Get a code", and a refusal replaces the
       whole section -- so pressing Space on that button and being refused left
       the focus on <body> and the sixteen tabs to do again, to reach a button
       whose refusal says to change the box directly above it. Restored by
       SELECTOR rather than by node, since none of the old nodes exist after the
       line below. A control the new state does not draw is simply not there,
       and nothing is focused, which is the honest outcome. */
    /* AND SO DOES "THIS IS THE ROW YOU ASKED FOR", for the same reason and by
       the same means. src/views/settings.js marks a linked-to row `is-landed`
       once, after it renders the page; the line below then replaces this whole
       section and the mark goes with it. MEASURED on the driven build, arriving
       from the home screen at #/settings?setting=connect_computer: the row was
       marked, the first poll answer landed, and the accent was gone before a
       person could have read it -- on the one row in this product a link exists
       to reach. Captured by id and put back, exactly as the focus is, and the
       two reads are kept adjacent because both are only true for the instant
       before the swap. */
    const wasFocused = focusedControl()
    const wasLanded = current.querySelector('.settings-row.is-landed')?.dataset?.settingId || null
    /* The rebuilt copy button carries its resting label, so the acknowledgement
       cannot survive as a word on a button that no longer means it. */
    copiedAtMs = 0
    current.outerHTML = markup({ searchResult })
    if (wasLanded) hostRoot.querySelector(`[data-setting-id="${wasLanded}"]`)?.classList?.add('is-landed')
    if (!wasFocused) return
    hostRoot.querySelector(wasFocused)?.focus?.()
  }

  /* The countdown moves every second and NOTHING ELSE DOES, so it is written
     straight onto its own node instead of through a repaint. A person mid-way
     through selecting the code keeps their selection.
     The copy acknowledgement rides the same second, for the same reason and one
     more: this section is allowed exactly ONE timer (see the header), so a
     label that has to change back cannot have a timer of its own. `copiedAtMs`
     is deliberately not in the reduced state -- it is a fact about this screen,
     not about the claim, and putting it in the state would repaint the section
     under somebody who had just pressed Copy. */
  function paintRemaining() {
    if (!hostRoot || state.phase !== 'waiting') return
    const node = hostRoot.querySelector('[data-connect-remaining]')
    if (node) node.textContent = remainingText(state.expiresAtMs, now())
    if (copiedAtMs && now() - copiedAtMs >= COPY_ACK_MS) {
      copiedAtMs = 0
      paintCopyLabel(COPY_LABEL)
    }
  }

  function paintCopyLabel(label) {
    const node = hostRoot?.querySelector('[data-connect-action="copy"]')
    if (node) node.textContent = label
  }

  /* COPYING IS DONE BY THE SELECTION THE FIELD ALREADY OFFERS, not by asking
     for a clipboard permission this window has never asked for anything else.
     select() then the document's own copy command is the same two steps a
     person does by hand, which is why the fallback is honest: if the command
     refuses, the code is left SELECTED and the button says which two keys
     finish the job. Nothing is claimed to have been copied that was not. */
  function copyCode() {
    const field = hostRoot?.querySelector('[data-connect-code]')
    if (!field) return
    field.focus?.()
    field.select?.()
    let copied = false
    try {
      copied = globalThis.document?.execCommand?.('copy') === true
    } catch { copied = false }
    copiedAtMs = now()
    paintCopyLabel(copied ? COPY_DONE_LABEL : COPY_MANUAL_LABEL)
  }

  function syncClock() {
    if (clockShouldRun(state) && !torn) startClock()
    else stopClock()
  }

  function startClock() {
    if (clock !== null) return
    clock = schedule(onTick, CLOCK_MS)
  }

  function stopClock() {
    if (clock === null) return
    cancelTimer(clock)
    clock = null
  }

  function onTick() {
    if (torn) { stopClock(); return }
    const nowMs = now()
    apply({ type: 'tick', nowMs })
    paintRemaining()
    if (pollDue(state, nowMs)) void pollOnce()
  }

  /* Every call to the installed application goes through here, so a verb that
     is missing and a verb that threw land in the same place and produce the
     same shape -- a refusal object the flow turns into a whole sentence. A
     thrown error's message is passed as the reason and may itself be a code;
     refusalSentence() already refuses to print one of those as prose. */
  async function ask(verb, argument) {
    try {
      const bridge = resolveBridge()
      if (!bridge) {
        if (state.disconnect || verb === 'disconnect') return { ok: false, code: 'DEVICE_CLAIM_DISCONNECT_UNCERTAIN' }
        apply({ type: 'bridge-absent' })
        return null
      }
      const result = argument === undefined ? await bridge[verb]() : await bridge[verb](argument)
      return result && typeof result === 'object' ? result : { ok: false, reason: '' }
    } catch (error) {
      return { ok: false, code: typeof error?.code === 'string' ? error.code : undefined,
        reason: typeof error?.message === 'string' ? error.message : '' }
    }
  }

  function finishDecline() {
    reservation = null
    collectingAccepted = false
    decisionInFlight = false
    decisionRefusal = ''
    declinedReservation = true
    /* The existing stopped ending clears the shown and remembered code. Its
       status wording is replaced above with the stronger server-confirmed
       decline wording; its name box and one-button fresh start remain useful. */
    apply({ type: 'cancelled' })
    refresh()
  }

  function handlePollResult(result) {
    if (['disconnecting', 'disconnect-review'].includes(state.phase)) return
    if (result?.ok === true && result.state === 'reserved') {
      const email = result.account && typeof result.account.email === 'string'
        ? result.account.email
        : ''
      if (!email) {
        apply({ type: 'poll-result', result: { ok: false, reason: 'The installed application did not name the account asking to claim this computer.' }, nowMs: now() })
        return
      }
      /* Do not pass `reserved` to the older reducer: it would treat it as
         another timed pending answer. A reservation must stop the clock and
         remain a still, unanswered question until a button is pressed. */
      reservation = { email }
      collectingAccepted = false
      decisionInFlight = false
      stopClock()
      refresh()
      return
    }
    if (result?.ok === true && result.state === 'rejected') {
      finishDecline()
      return
    }
    if (result?.ok === true && result.state === 'connected') {
      reservation = null
      collectingAccepted = false
      decisionInFlight = false
      decisionRefusal = ''
      declinedReservation = false
    }
    apply({ type: 'poll-result', result, nowMs: now() })
  }

  // The automatic status check runs once per controller. An explicit read-only
  // recovery check can repeat it, without the initial orphan-claim poll and
  // without any begin, cancel or disconnect mutation.
  async function checkStatus({ readOnly = false } = {}) {
    if ((!readOnly && asked) || torn || checkingStatus || inFlight) return
    if (!readOnly) asked = true
    const epoch = operationEpoch
    checkingStatus = true
    if (readOnly) refresh()
    try {
      const bridge = resolveBridge()
      if (!bridge) {
        apply(state.disconnect ? { type: 'status', result: { ok: false }, pressed: readOnly } : { type: 'bridge-absent' })
        return
      }
      /* THE CODE GOES BACK BEFORE ANYTHING IS ASKED, because the asking takes
         time a person watches. Measured on a first run: `status` alone is about
         two and a half seconds of a section with no controls on it, and until
         this line existed the screen spent that time claiming nothing had been
         sent anywhere to somebody looking at the code it had just given them.
         The claim is restored, not asserted -- the wait it produces is confirmed
         or ended by the polls that follow, exactly as any other wait is. */
      const remembered = readOnly ? null : claimWorthRestoring(now())
      if (remembered) {
        apply({
          type: 'adopted-code',
          code: remembered.code,
          claimedName: remembered.claimedName,
          expiresAtMs: remembered.expiresAtMs,
          intervalSeconds: remembered.intervalSeconds,
          nowMs: now(),
        })
      }
      const result = await ask('status')
      if (torn || epoch !== operationEpoch || !result) return
      apply({ type: 'status', result, pressed: readOnly })
      if (readOnly || state.disconnect || state.phase !== 'idle') return
      /* NOT CONNECTED IS NOT THE SAME AS NOTHING IN FLIGHT. Somebody who asked
         for a code and walked to another screen comes back to a claim the
         application is still holding. One poll is the only way to find out, and
         it is the reason `orphaned` exists: poll() answers `pending` without the
         code, so the honest thing is to say a code is open and offer a fresh
         one. */
      const pending = await ask('poll')
      if (torn || epoch !== operationEpoch || !pending) return
      if (pending.ok === true && pending.state === 'reserved') {
        handlePollResult(pending)
      } else if (pending.ok === true && pending.state === 'pending') {
        apply({ type: 'adopted-pending', intervalSeconds: pending.intervalSeconds, nowMs: now() })
      }
    } catch {
      if (!torn && epoch === operationEpoch) apply({ type: 'status', result: { ok: false }, pressed: readOnly })
    } finally {
      checkingStatus = false
      if (!torn && (readOnly || state.disconnect)) refresh()
    }
  }

  async function begin() {
    if (torn || inFlight || checkingStatus || !canBeginConnection(state)) return
    inFlight = true
    apply({ type: 'begin-requested' })
    const result = await ask('begin', { name: nameToClaim(state) })
    inFlight = false
    if (torn || !result) return
    apply({ type: 'begin-result', result, nowMs: now() })
  }

  async function pollOnce() {
    if (torn || inFlight || (state.disconnect && !['starting', 'waiting', 'orphaned'].includes(state.phase))) return
    inFlight = true
    const result = await ask('poll')
    inFlight = false
    if (torn || !result) return
    handlePollResult(result)
  }

  /* THE LOCAL CONSENT PRESS. `accept` is never inferred: no default argument,
     no truthiness and no timer calls this function. The existing begin bridge
     carries the literal boolean because it is already the one guarded channel
     that accepts a request; poll remains argument-free and cannot be turned
     into consent by a reload.

     After accept, poll once without a decision to collect the parked grant.
     That second call is also the recovery path when the acceptance response
     was lost: granted collects, reserved redraws the question, and no branch
     sends `accept: true` a second time on its own. */
  async function decideReservation(accept) {
    if (torn || inFlight || decisionInFlight || !reservation || typeof accept !== 'boolean') return
    decisionInFlight = true
    decisionRefusal = ''
    refresh()
    inFlight = true
    const result = await ask('begin', { accept })
    inFlight = false
    if (torn || !result) return
    if (result.ok === true && result.state === 'rejected') {
      finishDecline()
      return
    }
    if (result.ok === true && result.state === 'accepted') {
      reservation = null
      collectingAccepted = true
      decisionInFlight = false
      refresh()
      await pollOnce()
      return
    }
    /* Once the request was attempted, its missing response is ambiguous. Poll
       without a decision exactly once: this either recovers a parked grant,
       confirms a decline through `rejected`, or puts the same reservation back
       with both controls available. */
    decisionRefusal = typeof result.reason === 'string' ? result.reason : 'This computer did not receive an answer to that choice.'
    await pollOnce()
  }

  /* Stopping the wait stops it in the application too, not only on the screen.
     A claim left open there is what produces the `orphaned` state next time,
     and a person who pressed "Stop waiting" has said they are done with it. */
  async function cancel({ thenBegin = false } = {}) {
    if (torn || inFlight || checkingStatus || (state.disconnect && !canBeginConnection(state))) return
    inFlight = true
    const given = await ask('cancel')
    inFlight = false
    if (torn) return
    if (!given || given.ok !== true) {
      apply({ type: 'cancel-refused', result: given })
      return
    }
    /* TWO ENDINGS, AND THE PERSON MEANT DIFFERENT THINGS BY THEM. "Stop
       waiting" is a stop and is reported as one -- `cancelled` lands on the
       ended screen that says so. "Get a new code" is not a stop at all; the
       giving-up is plumbing on the way to the next code, and announcing "You
       stopped waiting" for a fifth of a second before "Asking..." would be the
       screen narrating its own internals. `restart` is the event that clears
       without a verdict, which is what it was always for. */
    apply({ type: thenBegin ? 'restart' : 'cancelled' })
    if (!thenBegin) return
    /* A CLAIM THAT WAS ACTUALLY GIVEN UP IS SAID OUT LOUD, and only one that
       was. The application answers `dropped` because this window cannot see
       its poll token; from `idle` the honest answer is almost always false and
       nothing is printed. The case this exists for is the one that cost a
       scout a permanently uncollectable computer: a claim opened, the screen
       rebuilt or the answer still in flight, "Get a code" pressed again. */
    if (given && given.dropped === true) apply({ type: 'claim-dropped' })
    await begin()
  }

  // Only an explicit confirmed press reaches this mutation. A status read or
  // an uncertain prior result never schedules it again.
  async function disconnect() {
    if (torn || inFlight || !['connected', 'disconnect-review'].includes(state.phase)) return
    /* The capability is asked the same way markup() asks it. canDisconnect() was
       replaced by disconnectCapability(), which separates "this bridge has no
       disconnect" from "the bridge could not be read just now" -- and this call
       site was left behind, referring to a function that no longer exists. It
       throws the moment a second press reaches it. Asking through the same seam
       keeps the guard and the drawn control agreeing about the same reading. */
    if (!disconnectCapability(relayReading()).available) return
    inFlight = true
    operationEpoch += 1
    apply({ type: 'disconnect-requested' })
    const result = await ask('disconnect')
    inFlight = false
    if (torn || !result) return
    apply({ type: 'disconnect-result', result })
  }

  /* THE FIRST PRESS ARMS AND WRITES NOTHING. The hint under the control says
     what the second press clears and what it leaves alone, and goes away with
     the arm. A press while a request is already on the wire is ignored here,
     the same as the busy "Get a code" is. */
  function pressDisconnect(button) {
    if (torn || inFlight) return
    const hint = hostRoot?.querySelector?.('[data-connect-disconnect-hint]')
    const showHint = (on) => {
      if (!hint) return
      hint.textContent = on ? state.phase === 'disconnect-review'
        ? 'Finish disconnect? Press again. This asks the app to finish stopping its connection processes and remove any remaining connection credential. The computer stays listed on your account page.'
        : DISCONNECT_ARMED_HINT : ''
      hint.hidden = !on
    }
    if (!armOnce(button, { onDisarm: () => showHint(false) })) {
      showHint(true)
      return
    }
    showHint(false)
    void disconnect()
  }

  function handleClick(event) {
    const button = event.target.closest?.('[data-connect-action]')
    if (!button || !hostRoot?.contains(button)) return
    if (button.getAttribute?.('aria-disabled') === 'true') return
    const action = button.dataset.connectAction
    /* EVERY BEGIN GOES THROUGH CANCEL FIRST, and "Get a code" is no longer the
       exception. SEEN ON GLASS: one scout held TC-YHTR-MMZH and TC-ZBSR-KGNF
       live at the same moment, because pressing this button while a claim was
       already open in the installed application opens a second one and drops
       the first token on the floor -- and a code already typed into the browser
       then produces a computer on the account page that this machine can never
       finish connecting. The window where that happens is not exotic: the
       mount-time status answers before the mount-time poll does, so for about
       a second the screen shows an idle "Get a code" over a claim it has not
       yet heard about. */
    if (action === 'begin') void cancel({ thenBegin: true })
    else if (action === 'copy') copyCode()
    else if (action === 'cancel') void cancel()
    /* "Get a new code" is one press for the person and two calls here: the
       claim that is still open has to be given up before another can be asked
       for, or the application is holding two. */
    else if (action === 'restart') void cancel({ thenBegin: true })
    /* "Not now" writes NOTHING. The switch stays off because off is what the
       store already says; the question goes because this controller has now
       asked it, and no later controller can (askMarkup). */
    else if (action === 'web-drive-later') { webDriveAsked = true; refresh() }
    else if (action === 'accept-reservation') void decideReservation(true)
    else if (action === 'decline-reservation') void decideReservation(false)
    else if (action === 'disconnect') pressDisconnect(button)
    else if (action === 'check-status') void checkStatus({ readOnly: true })
  }

  /* THE SWITCH MOVES THE STORE, THEN THE SCREEN IS REDRAWN FROM THE STORE.
     Not from `checked`: the store is what the relay reads, so it is the only
     thing worth showing. A write that throws leaves the record as it was and
     says so beside the switch, which springs back on the repaint. */
  function handleChange(event) {
    const field = event.target.closest?.('[data-connect-field="web-drive"]')
    if (!field || !hostRoot?.contains(field)) return
    webDriveNotice = ''
    try {
      writeWebDrive(field.checked === true)
    } catch {
      webDriveNotice = WEB_DRIVE_SAVE_FAILED
    }
    webDriveAsked = true
    refresh()
  }

  /* The typed name is filed and draws nothing: repaintNeeded() leaves `name`
     out for exactly this call site. Rebuilding the section on every keystroke
     would replace the very box being typed into and throw the caret to the end
     of it; the name is only read when the button is pressed. */
  function handleInput(event) {
    const field = event.target.closest?.('[data-connect-field="name"]')
    if (!field || !hostRoot?.contains(field)) return
    apply({ type: 'name-changed', name: field.value })
  }

  /* Focus selects the whole code, so tab then Ctrl+C is the keyboard route and
     one click is the mouse route. It is read-only, so there is no caret
     position anybody could have wanted instead. */
  function handleFocusIn(event) {
    const code = event.target.closest?.('[data-connect-code]')
    if (!code || !hostRoot?.contains(code)) return
    code.select?.()
  }

  /* THE SEARCH BOX WAS HIDING THIS SECTION FROM THE PEOPLE LOOKING FOR IT.
   *
   * It was one substring test against one joined string, so a query had to be a
   * run of words in the order this file happened to write them. MEASURED, with
   * the section's own heading on the screen above the box:
   *
   *     "connect"                 found it
   *     "connect computer"        no settings match this search
   *     "connect my computer"     no settings match this search
   *     "connect this computer to my account"  no settings match this search
   *     "sign in"                 no settings match this search
   *     "computer name"           no settings match this search
   *
   * The middle one is this screen's exact title with one word added, and it is
   * also the sentence the person who paid for this work actually typed. Every
   * word present, in any order, is the rule that answers all six, and it is
   * still narrow: "sankey gradient" shares no word with any of this. */
  function matches(query) {
    const normalized = String(query || '').trim().toLowerCase()
    if (!normalized) return true
    /* Read once, the way markup() does: relayReading() replaced viaRelay(), and
       this call site was the one left speaking the old name. */
    const relay = relayReading()
    const haystack = [
      'how do i connect this computer to my account code sign up signed up sign in website pair pairing join link add computer device claim my',
      `${ACCOUNT_PAGE_HOST} account page enter the code name for this computer get a code tc- new computer already connected`,
      `browser web drive driven remote ${WEB_DRIVE_CONTROL_LABEL}`,
      `disconnect unlink leave forget clear connection ${DISCONNECT_ACTION_LABEL}`,
      statusLine(state, { viaRelay: relay.viaRelay }).title,
      statusLine(state, { viaRelay: relay.viaRelay }).detail,
      state.refusal,
    ].join(' ').toLowerCase()
    return matchesSettingQuery(normalized, haystack)
  }

  function bind(root) {
    hostRoot = root
    root.addEventListener('click', handleClick)
    root.addEventListener('input', handleInput)
    root.addEventListener('focusin', handleFocusIn)
    root.addEventListener('change', handleChange)
  }

  function afterRender(root = hostRoot) {
    hostRoot = root
    void checkStatus()
    paintRemaining()
  }

  function destroy() {
    /* The latch goes up BEFORE the timer is cleared, because a request already
       on the wire resolves after this returns and would otherwise walk back
       into syncClock() and start a fresh interval on a screen that is gone. */
    torn = true
    stopClock()
    if (hostRoot) {
      hostRoot.removeEventListener('click', handleClick)
      hostRoot.removeEventListener('input', handleInput)
      hostRoot.removeEventListener('focusin', handleFocusIn)
      hostRoot.removeEventListener('change', handleChange)
    }
    hostRoot = null
  }

  return Object.freeze({
    markup,
    matches,
    bind,
    afterRender,
    destroy,
    /* Named so a test can drive the ceremony without a window, and so the
       settings page never has to reach past markup() to move this section. */
    begin,
    cancel,
    disconnect,
    decideReservation,
    pollOnce,
    checkStatus,
    getState: () => state,
    isTicking: () => clock !== null,
  })
}
