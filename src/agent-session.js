import { createImageConversation } from './image-conversation.js'
import { createImageOwnerClient } from './image-owner-client.js'
/* Start an agent from inside the interface, watch it work, and stop it.
 *
 * This is the in-app session path: the shell's agent host drives a real CLI
 * child process and streams its output back over one IPC channel. It is the
 * only path that can show output while a turn is running -- the audited
 * dispatch form next to it hands work to the action bridge and returns a
 * launch id, which is a receipt, not a view of the work.
 *
 * Every element here is existing write-surface markup. This module adds no
 * styling and introduces no visual vocabulary of its own.
 */
import { arrayBufferToBase64, buildChat, controlState, createChatDiffOpenHandler, el, pastedImageFromClipboard } from './components.js'
import { createCompareFilesDoor } from './diff-editor.js'
import { createConfirmedFileChangeBuffer } from './session-change-patches.js'
import { messageAriaLabel, messagePlaceholder } from './chat-copy.js'
import { mentionRefusalSentence } from './fleet-tree-copy.js'

/* THE ONE ATTRIBUTE IN THIS FILE THAT INTERPOLATES A REASON.
 *
 * Measured 2026-08-24: of the 23 `title="${...}"` sites in src/, twenty-two
 * escape and this file's was the only one that did not -- because this file had
 * no escaper at all. `why` is BRIDGE_ABSENT, a fixed product constant, so
 * nothing was exploitable; but `controlState` is a shared helper and the day a
 * caller passes a reason carrying a quote, an unescaped site closes the
 * attribute early. Defence in depth costs one line here.
 *
 * DELIBERATELY A LOCAL COPY, matching the seventeen others in src/ rather than
 * inventing an eighteenth shape. That duplication is real and is recorded for
 * the post-cut refactor -- an escaping function copied seventeen times is one
 * copy away from being wrong somewhere, and this file was the proof. Collapsing
 * them is a refactor, and refactors wait for the clean cut. */
const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
import { refusalCode, unavailableReason } from './agent-availability-copy.js'
import { confinementNote, CONFINEMENT_SUBJECT_HERE, CONFINEMENT_SUBJECT_REMOTE } from './agent-confinement-copy.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
import { isWriteEnabled, setWriteEnabled, WRITE_FLAGS_EVENT } from './write-flags.js'
import { completionSettlesOpenTurn, createActionBuffer, sessionActivityEvent, sessionEndedEvent, createSessionTextReader, sessionEventTurnId, sessionPersonTurn, sessionTurnCancelled, sessionTurnFailureText, sessionTurnStatus, sessionTurnSucceeded } from './agent-session-events.js'
import { answerWithinBound, createPendingApprovals } from './approval-answer.js'
import { createLiveSessionPublisher } from './agent-session-registry.js'
import { START_CONTROL_ON, startControlOffBecause } from './setup-profile.js'
/* What turning this on would grant and what it would risk, from the one place
   those statements live (owner, R1529). */
import { withheldMarkup } from './guided-step.js'
/* The same words the tree's own chat rows use for what an agent DID, so a
   command run from this surface and a command run from the tree read as the
   same fact rather than two different renderings of one event. */
import { actionRowWords, activityLine, APPROVAL_PANEL, approvalAnswerSentence, approvalDecisionIsReject, TURN_FAILED, turnCompletionWords } from './fleet-tree-copy.js'
/* T294: THE SAME QUEUE A TREE AGENT HAS, FOR EVERY OTHER LIVE SURFACE.
   src/session-outbox.js is keyed by SESSION id and knows nothing about trees,
   so the + tab, the agent page and the home chat takeover can hold the
   person's words in the one store views/computers.js already uses for a tree
   node rather than in a second implementation that would drift from it. */
import {
  SESSION_OUTBOX_EVENT,
  cancel as outboxCancel,
  confirmDelivered as outboxConfirmDelivered,
  clearSession as outboxClearSession,
  enqueue as outboxEnqueue,
  holdForSend as outboxHoldForSend,
  list as outboxList,
  moveSession as outboxMoveSession,
  promoteFront as outboxPromoteFront,
  replace as outboxReplace,
  requeueFront as outboxRequeueFront,
  takeNext as outboxTakeNext,
} from './session-outbox.js'
import { QUEUE_PANEL, movedFrontSentence } from './fleet-tree-copy.js'

/* unavailableReason() answers in desk words -- "close ToolsEnabled and open it
   again" -- and every call below used to fold that answer straight into
   `unavailable · ${...}` or `refused · ${...}` with no translation for a
   browser reading this page over the relay. Wrapped here, on the raw
   fragment, BEFORE it is folded into either prefix: readerRemedy's twins are
   keyed to that fragment, not to the prefixed line, so wrapping the composed
   string would never match. See src/refusal-copy.js's UNAVAILABLE_TEXT-RAW
   block for the twins this reads.
   NAMED readerSafeReason RATHER THAN unavailableReason ITSELF so a reader
   scanning call sites can tell "this code has been through the desk/remote
   translation" from "this code has not" without opening this file -- and so
   tools/test/refusal-copy.test.mjs's own code-interpolation scan, which
   allow-lists lines calling unavailableReason()/refusalRemedy()/
   refusalSentence() directly, has a name of its own to allow-list too. */
const readerSafeReason = code => readerRemedy(unavailableReason(code), { viaRelay: currentDataSource() === 'relay' })

/* WHAT THIS CONTROL SAYS ABOUT THE SESSION IT IS ABOUT TO START.
 *
 * It used to say one frozen sentence, and two of its three clauses went false
 * underneath it:
 *
 *   "Runs with your full local access. No permission tier limits a running
 *    session. Every start is recorded on this device before it runs."
 *
 * That was true when it was written -- the tier gated who could REQUEST a spawn
 * and which tools the remote surface listed, and confined nothing that ran. Tier
 * confinement then landed (capability/src/lib/agent-session-confinement.js,
 * bound by startSession() in shell/agent-host.cjs, which passes the resolved
 * `threadOptions` straight to the engine's thread/start), and nothing recomputed
 * the sentence. MEASURED per tier on this tree, with a real machine record at
 * each level so the tier was the only variable:
 *
 *   guided        sandbox read-only           isolated assistant home
 *   standard      sandbox workspace-write     isolated assistant home
 *   unrestricted  sandbox danger-full-access  isolated installation-owned assistant home
 *
 * and a machine with NO record fails closed to `guided`. So on a fresh install --
 * the normal first experience -- this control promised full local access and no
 * tier limit over a session whose sandbox refuses every write.
 *
 * WHY IT IS NOW COMPUTED AND NOT REWRITTEN. Replacing one frozen sentence with a
 * better frozen sentence would repeat the defect on a longer fuse: the claim is
 * a property of THIS INSTALL's recorded level, and the level is changeable from
 * Settings after first run. So the sentences come from mc-agent:confinement,
 * which reads the same resolver the spawn uses -- one source, so the screen
 * cannot describe a confinement the start would not apply.
 *
 * THE ONE CLAUSE THAT SURVIVES IS THE THIRD, unedited and for the same reason it
 * was true before: mc-agent:start calls recordSpawnIntent() before
 * getAgentHost().startSession(), and mc-agent:availability refuses on the
 * recorder before it even asks about the engine. See RECORD_CLAUSE in
 * src/agent-confinement-copy.js for why its wording is deliberately not stronger.
 *
 * NOTHING HERE IS ALLOWED TO SOUND SAFER THAN THE MEASUREMENT. At `unrestricted`
 * the rendered copy is blunter than the sentence it replaces: "Nothing narrows
 * it: it can read, change and delete any file on this computer and run any
 * program, without asking." A product understating its own blast radius is the
 * defect; a product overstating its safety is the same defect pointed at someone
 * who will get hurt by it. */
const CONFINEMENT_PENDING = 'Checking what a session here would be allowed to do…'

/* WHAT THIS SAID, AND WHY IT CHANGED. "the desktop shell is required; this
   surface is inert in a browser" -- three words from inside the program in one
   short line. "Desktop shell" is the installed application, "surface" is this
   panel, and "inert" is what a person is being told about a control they can
   see. None of the three names anything the reader owns, and the line offered
   nothing to do. This one says which of the two things they are looking at, and
   where the controls have to be used without telling a browser reader to open
   an application on the machine in front of them. */
const BRIDGE_ABSENT = 'this page is open in a browser, not in the installed ToolsEnabled application. Nothing here can start an agent. Agent controls must be used in the installed app on the computer you want to drive'

/* WHY THIS CHAT CANNOT BE TYPED INTO, said once, in this file's own voice --
 * the same shape as BRIDGE_ABSENT and CONFINEMENT_PENDING above: a named
 * constant instead of a string buried in a template, so the plain-language
 * gate (tools/check-plain-language.mjs, which scans every visible string in
 * this file) reads one sentence rather than one per call site.
 *
 * NO EXISTING COPY MODULE HAS THIS SENTENCE. agent-availability-copy.js and
 * agent-confinement-copy.js answer "why can't this session start"; fleet-tree-
 * copy.js's CHAT_NOT_RUNNING and home-chat-takeover.js's TAKEOVER_COPY both
 * answer "why can't this session be REACHED at all" -- a different fact from
 * this one, where the session is live and reachable and this box specifically
 * is not the door to it. Reusing either would misdescribe a running session as
 * an absent one. This file owns no copy module of its own to add an export to,
 * and the ones above are outside this file's writ, so the sentence is defined
 * here, exactly where BRIDGE_ABSENT already is. */
const SESSION_TRANSCRIPT_COMPOSER_REASON = 'This is the running record of the session above. Type your message in the box above it, not here.'

/* One per mounted session surface, so the status row's id stays unique while a
   rebuilt agent page and its predecessor are both briefly in the document. */
let sessionSurfaces = 0

/* "NOT YET" IS NOT "NO", AND THEY WANT DIFFERENT BEHAVIOUR.
 *
 * T289. A start held by the resource guard sat six minutes across eight manual
 * attempts with no progress and no retry (Worker 82, page 2; reproduced on my
 * own window). The guard is right -- these codes are the computer saying it
 * cannot take another assistant yet, and starting anyway is how the machine
 * dies -- but the surface painted "not yet" as "refused" and then did nothing,
 * so a person creating their first agent watched six minutes of silence.
 *
 * THE LIST IS DELIBERATE AND SHORT. Waiting on a code that will never clear --
 * an unknown provider, a tier this computer cannot seat -- puts a schedule in
 * front of a permanent answer, which is worse than the answer. Only codes that
 * mean "ask again shortly" are here. AGENT_RESOURCE_UNKNOWN and the two
 * ..._UNKNOWN codes are deliberately absent: "I could not measure" is not a
 * promise that measuring later will succeed. */
const HELD_START_CODES = new Set([
  'AGENT_RESOURCE_PRESSURE',
  'AGENT_RESOURCE_WARMING',
  'AGENT_RESOURCE_STARTS_BUSY',
  'AGENT_RESOURCE_PACING',
  'AGENT_RESOURCE_CONTROLLER_HOLD',
])
/* Spaced, not hammered, and bounded. Six attempts over about two and a half
   minutes: long enough for an ordinary burst of load to pass, short enough
   that a person is given a plain answer and their words back rather than an
   indefinite spinner. Stop stays live throughout. */
const HELD_START_WAITS_MS = Object.freeze([4000, 8000, 15000, 30000, 45000, 60000])
const heldStartTotalMinutes = () => Math.round(HELD_START_WAITS_MS.reduce((sum, ms) => sum + ms, 0) / 60000)

function actionState(node, kind, text) {
  node.dataset.state = kind
  node.textContent = text
}

/* THE SAME BATCHING LESSON AS agent-session-transcript.js's
 * createTranscriptAppender, ADAPTED FOR buildChat'S openStream.
 *
 * createTranscriptAppender exists because `node.textContent += text` once per
 * delta is O(n^2) in the transcript's length -- 1051 ms of blocked main thread
 * measured at 20,000 deltas, against 1.1 ms batched (see that module's header
 * for the full numbers). It cannot be reused here: it APPENDS text nodes to a
 * raw DOM node, and openStream's push() REPLACES a bubble's whole text with
 * whatever it is given, on the documented contract that the CALLER owns
 * accumulation (components.js, openStream's own comment). Calling push() once
 * per delta -- tens of thousands of times a turn, the engine's own emission
 * rate -- would reprocess the whole growing string that many times, which is
 * the identical O(n^2) shape in a new place.
 *
 * So deltas are summed into one growing string here, exactly the way
 * createTranscriptAppender sums characters into a text node, and handed to the
 * caller's push in the same rhythm: at most once per animation frame, however
 * many deltas arrived in between. The per-call cost inside openStream (it still
 * reformats the whole current string on every call) is components.js's own,
 * not this file's to fix -- this relay's job is only to stop calling it once
 * per token. */
export function createStreamRelay({ push, scheduleFrame, cancelFrame }) {
  if (typeof push !== 'function') throw new TypeError('createStreamRelay requires push')
  if (typeof scheduleFrame !== 'function') throw new TypeError('createStreamRelay requires scheduleFrame')
  if (typeof cancelFrame !== 'function') throw new TypeError('createStreamRelay requires cancelFrame')

  let text = ''
  let frame = 0
  let disposed = false

  function flush() {
    frame = 0
    if (disposed) return
    push(text)
  }

  return {
    /* Buffer one delta. Cheap by construction: a string concatenation and, at
       most, one frame request -- no call into the caller's push happens here. */
    append(delta) {
      if (disposed || typeof delta !== 'string' || delta.length === 0) return
      text += delta
      if (!frame) frame = scheduleFrame(flush)
    },
    /* Push whatever has accumulated right now, and cancel any frame already
       scheduled to do the same thing a moment later. Used when a turn ends, so
       the closed bubble is never missing that turn's last words. */
    flushNow() {
      if (frame) { cancelFrame(frame); frame = 0 }
      if (!disposed) push(text)
    },
    /* A new session starts an empty transcript. A frame already scheduled from
       the previous session would otherwise push its tail into the new one. */
    reset() {
      if (frame) { cancelFrame(frame); frame = 0 }
      text = ''
    },
    /* A scheduled frame outlives the surface it would write into. */
    dispose() {
      disposed = true
      if (frame) { cancelFrame(frame); frame = 0 }
    },
    get text() { return text },
    get frameScheduled() { return frame !== 0 },
  }
}

/* ONE BUFFERED ACTIVITY ROW, IN THE SHAPE addAction() PAINTS: `{ id, tool,
 * detail, state, stateKey, body, at, startedAt?, endedAt?, durationMs? }`.
 * The tool/detail/state WORDS come from
 * actionRowWords (src/fleet-tree-copy.js), the same reader src/views/
 * computers.js's actionChatRow() uses for the tree's own chat rows, so a
 * command narrated here and one narrated there read as the same fact in the
 * same words. */
export function sessionActionChatRow(row) {
  const words = actionRowWords(row)
  const chatRow = {
    id: `action:${row.id}`,
    kind: row.kind,
    tool: words.tool,
    detail: words.detail,
    state: words.state,
    stateKey: row.state,
    body: [row.detail, row.output].filter(Boolean).join('\n\n'),
    ...(row.kind === 'thinking' ? { truncated: row.truncated === true } : {}),
    at: row.at,
  }
  if (Object.hasOwn(row, 'startedAt') && Number.isFinite(row.startedAt)) chatRow.startedAt = row.startedAt
  if (Object.hasOwn(row, 'endedAt') && Number.isFinite(row.endedAt)) chatRow.endedAt = row.endedAt
  if (Object.hasOwn(row, 'durationMs') && Number.isFinite(row.durationMs) && row.durationMs >= 0) chatRow.durationMs = row.durationMs
  return chatRow
}

/* WHAT THE STANDALONE CHAT CARD SAYS THE AGENT IS ASKING. The tree rail uses
   the same sentences; they live in APPROVAL_PANEL so the two surfaces cannot
   describe one request two different ways. */
export function sessionApprovalSummary(approval) {
  const command = typeof approval?.details?.command === 'string' ? approval.details.command.slice(0, 160) : ''
  if (approval?.approvalKind === 'commandExecution' && command) return APPROVAL_PANEL.command(command)
  if (approval?.approvalKind === 'fileChange') return APPROVAL_PANEL.file
  if (approval?.approvalKind === 'tool_permission') {
    const tool = approval.details?.toolCall
    const title = typeof tool?.title === 'string' ? tool.title.slice(0, 160) : ''
    if (title) {
      const inputs = tool.rawInput?.tool_input ?? tool.rawInput
      let detail = ''
      try { if (inputs != null) detail = JSON.stringify(inputs).slice(0, 500) } catch { /* Keep the actual tool title. */ }
      return `${APPROVAL_PANEL.tool(title)}${detail ? `\n${APPROVAL_PANEL.toolInputs(detail)}` : ''}`
    }
  }
  return APPROVAL_PANEL.generic
}

/* The frame scheduler is injectable ONLY so a test can drive the transcript
   flush deterministically instead of waiting on a real animation frame. The
   shipped call passes nothing and gets requestAnimationFrame, so production
   behaviour is unchanged. */
/* WHICH AGENT-PAGE DESTINATION EXISTS FOR THIS STATE.
 *
 * This is a decision rather than DOM inspection so the fail-closed route can
 * be exercised under plain node tests. The renderer consumes the same answer:
 * a demonstration page gets no session surface, an enabled live page gets the
 * Start form, and a disabled live page gets the explanation/remedy in its
 * place. `reason` is the heading that the switched-off destination renders,
 * so the executable state proves both halves of "unavailable and says why". */
const AGENT_SESSION_ENTRY = Object.freeze({
  hidden: Object.freeze({ kind: 'hidden', startEnabled: false, reason: '' }),
  controls: Object.freeze({ kind: 'controls', startEnabled: true, reason: '' }),
  switchedOff: Object.freeze({ kind: 'switched-off', startEnabled: false, reason: 'Running agents is switched off' }),
})

export function agentSessionEntryState({ live = false, writeEnabled = false } = {}) {
  if (live !== true) return AGENT_SESSION_ENTRY.hidden
  return writeEnabled === true ? AGENT_SESSION_ENTRY.controls : AGENT_SESSION_ENTRY.switchedOff
}

/* A PICTURE PASTED AT THE PROMPT, BEFORE THERE IS A SESSION TO SAVE IT
   AGAINST. Two plain sentences, kept here beside the only surface that says
   them. The second one exists because the alternative is a picture that
   disappears without a word, which is the outcome this product treats as a
   defect: the person cannot tell a build that cannot do it from one that is
   broken, and both look like a key that did nothing. */
const PASTE_HELD_NOTE = 'That picture is waiting. It will be sent with your first message.'
const PASTE_HELD_LOST = 'That picture could not be attached, so your message was sent without it.'
/* Respawn replays the words and not the picture -- see respawn() for why that
   is a decision rather than an oversight. Said only when the turn being
   replayed really carried one: a notice after every respawn would be noise,
   and noise is how a real notice stops being read. Without it, a wrong answer
   to the second attempt looks like the agent ignoring a picture it was in fact
   never given. */
const RESPAWN_WITHOUT_PICTURE = 'Respawn sent your words again without the pasted picture. Paste it again to include it.'

export function mountAgentSessionSurface(root, options = {}) {
  /* THE `live` FENCE IS ASKED FIRST AND ONCE, before either branch below, and
     it is the only question whose answer is "render nothing at all". Everything
     after it is about a real page. See the long note in mountSessionControls()
     for the measurement that put it there. */
  if (agentSessionEntryState({ live: options.live }).kind === 'hidden') return () => {}

  /* THE SWITCHED-OFF PATH IS A DESTINATION, NOT AN ABSENCE.
   *
   * This used to be `if (!isWriteEnabled('agent-session')) return () => {}`, and
   * that one line is the second half of the recommended-answer defect. The
   * setup walkthrough recommended the answer that leaves this flag off, so the
   * ordinary first-run install rendered NOTHING here -- no control, no reason,
   * nothing naming the setting that removed it. A person who took the product's
   * own advice arrived at an agent page with no way to start an agent and no
   * way to find out why. Absence is unfalsifiable to the person looking at it:
   * a missing Start and a broken build look exactly alike.
   *
   * So the off state renders, says which answer switched it off, and carries
   * the switch. Turning it on is an explicit act by the person on their own
   * machine -- the same act Settings offers, moved to the place where they
   * discover they want it -- and nothing starts as a result of it: it reveals
   * the Start control, which they then have to press.
   *
   * It is inside the `live` fence, so the demonstration page still renders no
   * session surface of any kind and the example-page write fence is unchanged. */
  let disposed = false
  let release = null
  let rendered = null
  const mount = () => {
    const entry = agentSessionEntryState({ live: true, writeEnabled: isWriteEnabled('agent-session') })
    rendered = entry.kind
    release = entry.kind === 'controls'
      ? mountSessionControls(root, options, remount)
      : mountSessionSwitchedOff(root, options, syncToWriteFlag, entry)
  }
  /* THE SWITCH CAN BE THROWN SOMEWHERE ELSE, AND THIS SURFACE HAS TO NOTICE.
   *
   * T292, measured on screen by Worker 85 and reproduced here by driving the
   * same sequence: open a + / New agent tab while "running agents" is off, turn
   * it on in SETTINGS, come back. The tab keeps the switched-off surface
   * forever -- no chat, no composer, only the enable control -- and returning
   * to the page does not help, because the tab is restored from memory rather
   * than rebuilt. The person's only way out was to close the tab and open a new
   * one.
   *
   * The remount machinery was already here; the only thing missing was hearing
   * about a change that did not come from this surface's own button.
   * setWriteEnabled announces every durable change on WRITE_FLAGS_EVENT, so
   * that is what is listened to. It fixes every caller of this mount at once --
   * the + tab, the agent page and the home chat takeover -- rather than one
   * surface at a time.
   *
   * ONE DIRECTION ONLY, DELIBERATELY. Off-to-on reveals the Start control,
   * which costs nothing and starts nothing. On-to-off is NOT rebuilt here:
   * doing so would take a conversation that is open, and possibly an agent that
   * is running, off the screen because of a switch thrown on another page. The
   * flag gates starting an agent, and a person who turns it off while one is
   * open keeps the surface they are using until it is closed. */
  const syncToWriteFlag = () => {
    if (disposed) return
    const wanted = isWriteEnabled('agent-session') ? 'controls' : 'switched-off'
    if (wanted === rendered || wanted !== 'controls') return
    remount()
  }
  const remount = () => {
    if (disposed) return
    release?.()
    release = null
    mount()
  }
  const onWriteFlags = event => {
    if (event?.detail?.action === 'agent-session') syncToWriteFlag()
  }
  mount()
  /* The in-tab button reaches the same door: setWriteEnabled dispatches before
     mountSessionSwitchedOff's own call returns, so the listener has already
     rebuilt and that call finds nothing left to do. One path, not two. */
  globalThis.window?.addEventListener?.(WRITE_FLAGS_EVENT, onWriteFlags)
  return () => {
    disposed = true
    globalThis.window?.removeEventListener?.(WRITE_FLAGS_EVENT, onWriteFlags)
    release?.()
    release = null
  }
}

/* WHAT THE PERSON IS LOOKING AT WHEN THERE IS NO START CONTROL.
 *
 * The same `.write-surface` markup as the real one, so it lands in the same
 * place in the page with the same vocabulary; no new visual language, and no
 * form, because there is nothing to submit. */
function mountSessionSwitchedOff(root, {
  bridge = globalThis.mcAgent,
} = {}, remount, entry = AGENT_SESSION_ENTRY.switchedOff) {
  const bridgeControl = sessionBridgeControl(bridge)
  const surface = el(`<section class="write-surface agent-session-surface" data-session-off aria-label="Agent session">
    <header><strong>Agent session</strong><span data-session-status role="status">Off</span></header>
    <div class="write-surface-grid">
      <div class="write-form">
        <span class="write-form-title">${esc(entry.reason)}</span>
        <output data-action-output role="status"></output>
        <button type="button" data-session-enable${bridgeControl.disabled ? ` disabled title="${esc(bridgeControl.why)}"` : ''}>${START_CONTROL_ON.label}</button>
        ${/* WHAT IT WOULD GIVE AND WHAT IT WOULD COST, beside the button that
              gives it (owner, R1529). This surface already said what is off and
              where the switch is; a person deciding whether to press it was
              still missing the other half, and a switch offered with only its
              benefit named is the kind of nudge this directive is against. The
              same statement is used on the settings page and in the setup
              review, from src/permission-guidance.js. */''}
        ${withheldMarkup('write_agent-session', {
          label: 'Running an agent session',
          reason: 'Turning it on starts nothing by itself. It puts the Start control here, and you decide what to run.',
        })}
      </div>
    </div>
  </section>`)
  const output = surface.querySelector('[data-action-output]')
  actionState(
    output,
    bridgeControl.disabled ? 'unavailable' : 'note',
    bridgeControl.disabled ? `unavailable · ${bridgeControl.why}` : switchedOffReason(),
  )
  /* ANCHOR WITH A FALLBACK, BECAUSE THE ANCHOR IS ONE PAGE'S FURNITURE.
     `.agent-strip` exists on the agent view and nowhere else; the home page's
     chat takeover hands this mount a bare stage div it has just emptied. The
     optional chain made that a SILENT no-op -- the surface was built, wired,
     and never inserted, which read as a blank sheet with no error anywhere.
     Append is the right fallback: on a host with no strip, the surface IS the
     content. */
  {
    const strip = root.querySelector('.agent-strip')
    if (strip) strip.insertAdjacentElement('afterend', surface)
    else root.appendChild(surface)
  }

  const enable = surface.querySelector('[data-session-enable]')
  const onEnable = async () => {
    enable.disabled = true
    let available
    try { available = await bridge.availability() }
    catch (error) { available = { ok: false, code: refusalCode(error) } }
    if (available?.ok !== true) {
      actionState(output, 'unavailable', `unavailable · ${readerSafeReason(available?.code)}`)
      enable.disabled = false
      return
    }
    setWriteEnabled('agent-session', true)
    /* Re-mounts into the real surface in place. The person pressed a switch and
       the control they were told about appears where the switch was, rather
       than after a navigation they have to work out for themselves. */
    remount()
  }
  if (bridgeControl.enabled) enable.addEventListener('click', onEnable)

  /* Nothing was published to the session registry and nothing needs clearing:
     an off surface owns no session. */
  return () => {
    enable.removeEventListener('click', onEnable)
    surface.remove()
  }
}

/* EXPORTED SO ITS RULE CAN BE TESTED WITH VALUES INSTEAD OF PINNED AS TEXT.
   The suite used to require six literal `typeof bridge.VERB === 'function'`
   spellings here, while demanding the OPTIONAL-CHAINED spelling of the same rule
   for views/guide.js a few lines earlier -- two contradictory pins of one
   invariant, both of which break the moment either file is written differently
   but correctly. The invariant is: every verb this surface will call is checked
   before the control is offered. That is testable by handing this function real
   bridge shapes, which is what tools/test/session-bridge-control.test.mjs does. */
export function sessionBridgeControl(bridge) {
  return controlState({
    enabled: Boolean(bridge
      && typeof bridge.availability === 'function'
      && typeof bridge.start === 'function'
      && typeof bridge.send === 'function'
      && typeof bridge.onEvent === 'function'
      && typeof bridge.close === 'function'
      && typeof bridge.interrupt === 'function'),
    why: BRIDGE_ABSENT,
  })
}

/* WHICH ANSWER SWITCHED IT OFF, NAMED IN THE PERSON'S OWN WORDS.
 *
 * Read from the recorded setup profile rather than asserted, because there are
 * two genuinely different ways to arrive here and telling them apart is the
 * whole value of the sentence: the walkthrough's autonomy answer, or the
 * Settings switch on a machine that never recorded a profile. Claiming setup
 * did it to someone who turned it off themselves an hour ago would be the
 * product misdescribing its own state, which is the failure this repair is
 * about. */
function switchedOffReason() {
  /* The first sentence is startControlOffBecause()'s, shared with the fleet
     page's start panel, which says the same thing about the same switch. */
  const because = startControlOffBecause()
  /* THREE SENTENCES, NOT ONE. This was a single thirty-word run-on carrying
     three separate facts: that nothing runs yet, that the switch starts nothing
     by itself, and where the switch is. One idea per sentence is the whole of
     the change; not a word of meaning was dropped.

     THEN ONE OF THE THREE WENT, on the owner's "open agent detail is a mess".
     "Nothing runs on this computer until you turn it on" is the first sentence
     said twice: `because` has already stated that the answer he recorded
     switches starting off. The Settings route stays HERE, unlike on the fleet
     page's panel, because this surface is also where somebody comes to turn the
     thing back off again and that lives in Settings. */
  return `${because} Turning it on starts nothing by itself, it just puts the Start control here and you decide what to run. The same switch is in Settings, under Things it may do for you.`
}

function mountSessionControls(root, {
  agentId,
  /* Whatever the HOST's own chat builder produced for this seat. Spread into
     buildChat first, so this surface's own session wiring -- onSend, onStop,
     the approval and diff handlers -- still wins: a host config that carried
     its own onSend would otherwise silently take over the send path and the
     session would never start. */
  hostChat = null,
  /* THE CHIPS THE SURFACE ITSELF OWNS. A solo agent's program and effort are
     its own facts -- chosen in its pop-up, not held by any tree -- so they
     cannot come through hostChat: treeChatConfigFor early-returns a
     no-session configuration for any node whose sessionId is null, which a
     seat always is, and that branch carries no chips at all. */
  chatChips = null,
  bridge = globalThis.mcAgent,
  roleBinding = null,
  requireRoleBinding = false,
  onController = null,
  onSessionOpen = null,
  onSessionEnd = null,
  onSessionChange = null,
  getStartOptions = null,
  getImageComposer = null,
  retainSessionOnDispose = () => false,
  retainChatOnDetach = false,
  chatComposer = false,
  chatTitle = 'Agent',
  publishSession = true,
  scheduleFrame = (fn) => globalThis.requestAnimationFrame(fn),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
} = {}, remount = () => {}) {
  const publishLiveSession = createLiveSessionPublisher()
  // One compare window belongs to the session surface, including Respawn.
  const compareFiles = createCompareFilesDoor()
  const openChatDiff = createChatDiffOpenHandler(compareFiles)
  /* THE CAPTURE READER IS THE SAME FENCED DOOR THE COMPARE WINDOW SAVES
     THROUGH -- shell/diff-file.cjs decides what may be read, not this file. A
     window built before the bridge existed still gets it, because the bridge is
     read per call rather than held from mount. */
  const confirmedFileChanges = createConfirmedFileChangeBuffer({
    captureOriginal: path => {
      const bridge = globalThis.mcDiff
      if (typeof bridge?.readChange !== 'function') return Promise.resolve(null)
      return bridge.readChange(path, sessionId ? { sessionId } : undefined)
    },
  })
  /* THE PAGE MUST SAY IT IS SHOWING REAL DATA BEFORE A REAL CONTROL APPEARS ON IT.
   *
   * This is the surface that starts an actual CLI child process on the user's
   * actual machine. Until this check existed it asked exactly one question --
   * "is the agent-session write flag on?" -- and mounted a working Start
   * whenever the answer was yes, with no idea whether the page around it was
   * the live drill-in or the demonstration copy.
   *
   * MEASURED on the packaged build (release/win-unpacked, tier unrestricted),
   * at #/agent/c1/terra-01 with the view in simulated mode: the page rendered
   * its own banner reading "Example data. These are not your agents -- nothing
   * here is running, and no control on this page reaches a real session", and
   * in the same viewport this surface rendered an ENABLED Start over the note
   * "This computer is set to Unrestricted. Nothing narrows it: it can read,
   * change and delete any file on this computer and run any program, without
   * asking." Pressing it took mcAgent.history().total from 0 to 1 and the
   * status from "agent engine ready" to "running - session open". A real
   * spawn, recorded on the device, from a page that told the person nothing on
   * it was real.
   *
   * `live` DEFAULTS TO FALSE, and that direction is the whole point. This
   * project's recurring defect is absence read as consent -- a missing field or
   * a falsy check turning "nothing specified" into "allowed". A caller that
   * says nothing about its provenance is a caller that has not established the
   * page is real, so it gets no real control. The one caller that can prove it
   * (src/views/agent.js, which only has a projection when the fetch returned
   * one) passes `live` explicitly.
   *
   * `agentId` IS NOW READ, and the sentence that used to end this note --
   * "this surface never read `agentId` at all, so the session it started was
   * never the agent whose page it sat on" -- described the second defect this
   * file was carrying. An anonymous session is a session nothing can be mapped
   * to, which is why Pause, Respawn and Terminate could only ever refuse. The
   * association is recorded at the one moment it is certain: a person pressing
   * Start on a named agent's page. See src/agent-session-registry.js. */
  /* THE STATUS ROW IS THE START BUTTON'S OWN DESCRIPTION, not merely a sentence
   * near it.
   *
   * The row already carries every reason this control can be refused --
   * "unavailable · Codex is installed on this computer but nobody is signed in
   * to it...", the bridge-absent line, the confinement refusals -- and the
   * comment below is right that a disabled control with a reason beats an
   * enabled one with a warning beside it. But the association was VISUAL only.
   * Measured with Tab on the packaged build from a sterile profile: a disabled
   * button is not in the tab order at all, so a keyboard-only person walks the
   * whole agent page (17 stops) and never meets Start, and a screen reader that
   * does reach it in scan mode was told "Start, button, dimmed" with the reason
   * an unrelated sentence somewhere above.
   *
   * aria-describedby ties the two together, so the reason is read out AS PART OF
   * the control, in every mode, without a second copy of the sentence existing.
   * The id is per-mount: the agent page can be rebuilt while an old copy is
   * still on screen, and two elements sharing one id is an ambiguous reference
   * exactly when it matters. */
  const statusId = `agent-session-status-${sessionSurfaces += 1}`
  const surface = el(`<section class="write-surface agent-session-surface" aria-label="Agent session">
    <header><strong>Agent session</strong><span data-session-status id="${statusId}" role="status">checking…</span></header>
    <div class="write-surface-grid">
      <form class="write-form" data-session-form>
        <span class="write-form-title">Start an agent</span>
        <label class="write-wide">Prompt<textarea name="text" maxlength="16000" rows="2" required></textarea></label>
        <!-- THE WORD ON THE BUTTON IS NOT THE NAME OF THE ACTION.
             Measured by tools/a11y-keyboard-qa on the packaged build: the
             accessible name Chromium handed the platform was exactly "Start" --
             five characters that name no object. A screen-reader user landing
             here in scan mode is told "Start, button" and has to go looking for
             what it starts; a person reading the visible layout has the form
             title "Start an agent" six pixels above it and never notices the
             gap. aria-label supplies the object the visible word borrows from
             its surroundings, and it is the SAME object -- an agent session
             from the prompt in this form -- so nothing is announced that the
             screen does not also show. The visible word stays "Start", because
             a button that reads "Start an agent session using the prompt above"
             on the glass would not fit the control it labels. -->
        <button type="submit" data-session-start aria-label="Start an agent session using the prompt above" aria-describedby="${statusId}" disabled>Start</button>
        <button type="button" data-session-stop aria-label="Stop the agent session started here" aria-describedby="${statusId}" disabled>Stop</button>
        <!-- THE SIGN-IN PRECONDITION IS NOT RESTATED HERE, and that is a
             decision rather than an omission. This lane built a second notice
             for it, and while it was being built a peer lane repaired the
             probe itself: engineAvailability() now runs
             confinedSessionIsSignedOut() and answers
             {ok:false, AGENT_CONFINEMENT_SIGNED_OUT}, which DISABLES Start and
             renders the remedy through unavailableReason() in the status row
             above. That is strictly the better fix -- a disabled control with a
             reason beats an enabled one with a warning beside it -- so the
             second notice was removed rather than shipped alongside it. Two
             elements saying one thing is how a screen starts contradicting
             itself the first time only one of them is updated. -->
        <output data-action-output role="status"></output>
      </form>
    </div>
  </section>`)

  const status = surface.querySelector('[data-session-status]')
  const form = surface.querySelector('[data-session-form]')
  const startButton = surface.querySelector('[data-session-start]')
  const stopButton = surface.querySelector('[data-session-stop]')
  const output = surface.querySelector('[data-action-output]')
  const prompt = form.elements.text
  if (chatComposer) {
    surface.setAttribute('data-chat-composer', '')
    surface.querySelector('header strong').textContent = chatTitle
    form.hidden = true
    form.insertAdjacentElement('beforebegin', output)
  }

  /* The picture the person pasted before pressing Start. Held as bytes,
     because there is nothing to save it against yet: the boundary requires a
     live owned session (agent:paste-attachment -> ownedAgentSession). It is
     saved and spent by the first start below, and never survives it. */
  let heldPasteImage = null
  /* Whether the turn now in flight carried a picture, so a respawn can say
     that its replay does not. Set at the one place a turn is issued. */
  let lastTurnCarriedPicture = false
  let destroyed = false
  /* The pending wait between held start attempts, so tearing the surface down
     cancels it instead of letting a closed panel start an agent minutes later. */
  let heldStartTimer = null
  let heldStartRelease = null
  /* CLEARING THE TIMER IS NOT ENOUGH. The wait is awaited, so a cancelled
     timer with no resolver left the send's promise pending forever and the
     caller never learned the surface had gone -- node:test caught it as
     "Promise resolution is still pending but the event loop has already
     resolved", which is the shape of a leak in the product too. Cancelling
     RELEASES the wait with a false, and the caller treats that as "stopped". */
  const cancelHeldStart = () => {
    if (heldStartTimer) { clearTimeout(heldStartTimer); heldStartTimer = null }
    if (heldStartRelease) { const release = heldStartRelease; heldStartRelease = null; release(false) }
  }
  let sessionId = null
  /* WHERE THE PERSON'S WAITING WORDS LIVE BEFORE THERE IS A SESSION TO HANG
     THEM ON (T294). A solo agent's first send is what starts it, so a second
     message typed during that start has no session id to be filed under yet.
     It is filed under this surface's own id instead and MOVED onto the real
     session the moment one exists -- src/session-outbox.js moveSession is the
     same call views/computers.js makes when a session is replaced -- so the
     order is kept and nothing is written twice. */
  const localQueueKey = 'agent-session-local-' + statusId
  let queueKeyMoved = false
  const queueKey = () => endedRecovery?.queueSessionId || sessionId || localQueueKey
  let lastDiffSessionId = null
  let unsubscribe = null
  let starting = false
  let stopping = false
  let ready = false
  /* Is a TURN running, as distinct from a session being open. */
  let working = false
  let lastPrompt = ''
  let control = null
  let terminalCode = null
  let activeTurnId = null
  let activeStep = ''
  let placementLocked = false, sending = false, steering = 0
  let threadId = null, account = null, replyAt = null, lastTurnStatus = null
  let transcript = []
  // Tool events do not declare the executing worker's filesystem platform.
  let actionBuffer = createActionBuffer()
  const chatStatusListeners = new Set()
  const pendingPastes = new Map()
  let pasteSequence = 0

  const notifyChatStatus = () => {
    for (const listener of [...chatStatusListeners]) {
      try { listener() } catch { /* one retired panel must not starve another */ }
    }
  }

  const sameMetricSnapshot = (left, right) => (
    ['tools', 'files', 'added', 'removed'].every(key => left?.[key] === right?.[key])
  )

  const adoptTurn = (turnId) => {
    if (typeof turnId !== 'string' || turnId.length === 0 || turnId === activeTurnId) return false
    if (activeTurnId) actionBuffer.clearMetrics(activeTurnId)
    activeTurnId = turnId
    activeStep = ''
    notifyChatStatus()
    return true
  }

  const resetLiveMetrics = () => {
    actionBuffer.resetMetrics()
    activeTurnId = null
    activeStep = ''
    notifyChatStatus()
  }

  const sessionChatStatus = {
    // Pending startup requires queueing, but is not an interruptible turn.
    busy: () => working,
    queueRequired: () => starting,
    step: () => activeStep,
    metrics: () => (activeTurnId ? actionBuffer.metrics(activeTurnId) : {}),
    readinessRevision: () => {
      const turn = typeof activeTurnId === 'string' && activeTurnId ? activeTurnId : 'none'
      const status = typeof lastTurnStatus === 'string' && lastTurnStatus ? lastTurnStatus : 'none'
      return `${sessionId || 'none'}:${turn}:${working ? 'active' : 'idle'}:${status}`
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      chatStatusListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        chatStatusListeners.delete(listener)
      }
    },
  }

  /* THE RAW <pre> IS GONE. What used to be a bare, unstyled dump of the
   * transcript is now the same Dense chat panel every other agent surface
   * uses -- mounted here, fed by the SAME live packets, through openStream
   * (what the agent SAYS) and addAction (what it DOES).
   *
   * By default, composerReason gates the transcript. The real composer for
   * that surface is the Prompt textarea and Start button above, already wired
   * to startSession(); this panel is a second window onto the SAME session,
   * not a second way to talk to it. buildChat enforces that a caller passes
   * exactly one of the three, and refuses to let a composerReason-gated chat
   * ever reach its own seeded simulator (components.js, buildChat's own
   * header comment). Standalone tabs explicitly choose chatComposer instead:
   * their composer calls the same session controller and never the simulator.
   *
   * REBUILT, NOT CLEARED, ON EVERY NEW SESSION -- and this is not decorative.
   * Respawn's own confirmation, the sentence a person reads and accepts before
   * it fires, says in these words: "The current transcript and everything it
   * remembers are lost" (src/agent-session-controls.js, sessionControlFace's
   * `respawn`). The raw <pre> made that literally true by wiping its
   * textContent on every startSession() call (appender.reset(), the code this
   * replaces). buildChat has no public "clear the log" call -- reaching past
   * openStream/addAction into its internal `.chat-log` node would be exactly
   * the private-DOM dependency this task was told not to take on B1's
   * in-progress file. So the panel itself is disposed and replaced with a
   * fresh, empty one at the same moment the old <pre> used to go blank: the
   * confirmed claim stays true of the new component the same way it was true
   * of the old markup. */
  let chat = null
  let pendingComposerStart = null
  const pendingApprovals = createPendingApprovals()
  const setApproval = (card) => {
    if (!chat || !card?.id) return
    chat.showApproval(card)
  }
  const clearApproval = (id) => {
    if (!chat || !id) return
    chat.resolveApproval(id)
  }
  const paintApprovals = (sessionKey = sessionId) => {
    if (!sessionKey || sessionKey !== sessionId || !working) return
    for (const pending of pendingApprovals.all(sessionKey)) {
      if (pending.turnId && pending.turnId !== activeTurnId) continue
      setApproval({
        id: pending.approvalId,
        summary: sessionApprovalSummary(pending),
        badges: [],
        decisions: pending.availableDecisions,
        decisionKinds: pending.decisionKinds,
        answering: pendingApprovals.answering(sessionKey, pending.approvalId),
      })
    }
  }
  const paintAnsweredAction = (row) => {
    if (!row) return
    const chatRow = { who: 'action', ...sessionActionChatRow(row) }
    const previous = transcript.findIndex(entry => entry.who === 'action' && entry.id === chatRow.id)
    if (previous < 0) transcript.push(chatRow)
    else transcript[previous] = chatRow
    chat?.addAction?.(chatRow)
  }
  const retireApprovals = (sessionKey = sessionId, { keepAnswering = false } = {}) => {
    if (!sessionKey) return
    const pending = pendingApprovals.all(sessionKey)
    const answeringIds = new Set(
      pending
        .filter(entry => pendingApprovals.answering(sessionKey, entry.approvalId))
        .map(entry => entry.approvalId)
        .filter(Boolean),
    )
    for (const approval of pending) {
      clearApproval(approval.approvalId)
      if (keepAnswering && answeringIds.has(approval.approvalId)) continue
      pendingApprovals.settle(sessionKey, approval.approvalId, approval)
    }
    if (!keepAnswering) pendingApprovals.delete(sessionKey)
    const settled = actionBuffer.settleUnfinished()
    for (const row of settled) paintAnsweredAction(row)
  }
  const offerApproval = (activity, packet) => {
    if (!sessionId || activity?.kind !== 'approval' || !activity.approvalId) return
    pendingApprovals.set(sessionId, {
      ...activity,
      sessionId,
      turnId: sessionEventTurnId(packet, sessionId) || activeTurnId || null,
    })
    paintApprovals()
  }
  const answerSessionApproval = async (approvalId, decision) => {
    const boundSessionId = sessionId
    const boundTurnId = activeTurnId
    const pending = boundSessionId
      ? pendingApprovals.all(boundSessionId).find(entry => entry.approvalId === approvalId) || null
      : null
    if (!working || !pending || pending.sessionId !== boundSessionId || pending.approvalId !== approvalId) {
      throw new Error(APPROVAL_PANEL.failed)
    }
    if (pending.turnId && boundTurnId && pending.turnId !== boundTurnId) {
      throw new Error(APPROVAL_PANEL.failed)
    }
    const answer = pendingApprovals.beginAnswer(boundSessionId, approvalId)
    if (!answer) {
      if (pendingApprovals.answering(boundSessionId, approvalId)) return
      throw new Error(APPROVAL_PANEL.failed)
    }
    paintApprovals(boundSessionId)
    const { answered } = await answerWithinBound(
      () => bridge?.answerApproval?.({ sessionId: boundSessionId, approvalId, decision }))
    const stillPending = pendingApprovals.endAnswer(boundSessionId, approvalId, answer)
    if (destroyed) throw new Error(APPROVAL_PANEL.failed)
    if (sessionId !== boundSessionId) return
    if (!answered) {
      const live = stillPending && sessionId === boundSessionId && working
        && (!pending.turnId || pending.turnId === activeTurnId)
      if (live) paintApprovals(boundSessionId)
      else if (stillPending) {
        pendingApprovals.settle(boundSessionId, approvalId, pending)
        clearApproval(approvalId)
        const keepWaitingIds = new Set(
          pendingApprovals.all(boundSessionId).map(entry => entry.approvalId).filter(Boolean),
        )
        for (const row of actionBuffer.settleUnfinished({ keepWaitingIds })) paintAnsweredAction(row)
      }
      throw new Error(live ? APPROVAL_PANEL.failed : APPROVAL_PANEL.ended)
    }
    const sentence = approvalAnswerSentence(decision, pending.decisionKinds)
    const state = approvalDecisionIsReject(decision, pending.decisionKinds) ? 'refused' : 'done'
    const row = actionBuffer.answerApproval(approvalId, state, { turnId: pending.turnId })
    if (row) paintAnsweredAction(row)
    if (stillPending) {
      pendingApprovals.settle(boundSessionId, approvalId)
      clearApproval(approvalId)
    }
    return sentence
  }

  /* THE HOST'S CHAT, MINUS THE ONE FIELD THE HOST CANNOT ANSWER FOR US.
     `composerReason` is buildChat's way of saying "there is no composer here
     and this is why". A tree node's conversation supplies it whenever the node
     is not running, which is right for a tree node -- it is started from the
     canvas, and its conversation is a place to read what it said. It is wrong
     for any surface that OWNS a composer: a solo agent has no Start control
     anywhere, and its first send is what starts it. Measured on a built
     candidate at 9c090ce9: with a real seat the + chat finally received the
     tree's configuration and its composer went dead, input and Send both
     disabled, under that node's sentence.
     So the rule is: whoever owns the composer owns whether it can be used.
     Everything else the host sends through is served unchanged. */
  const chatFromHost = () => {
    if (!hostChat) return {}
    if (!chatComposer) return { ...hostChat }
    const { composerReason: hostComposerReason, ...rest } = hostChat
    return rest
  }
  /* THE QUEUE, FOR EVERY LIVE SURFACE THAT IS NOT A TREE NODE (T294).
   *
   * Worker 85, on screen: Halt and Send now DO render on the + chat while it is
   * busy, but Send next, Unqueue and the strip never appear, and a second
   * message sent while the first was running was not queued at all -- it was
   * lost. `queue` is a buildChat option, and both the surfaces that could have
   * supplied it supplied none: treeChatConfigFor early-returns a no-session
   * configuration for any node whose sessionId is null, which a seat always is,
   * and that branch carries no queue.
   *
   * IT IS THE SAME STORE, NOT A SECOND ONE. src/session-outbox.js is keyed by
   * session id and knows nothing about trees; views/computers.js is one caller
   * of it, not its owner. So the words a person types at a + agent wait in the
   * same place, in the same order, with the same persistence, as the words they
   * type at a tree circle. The owner's standard for this surface was "its the
   * same agent system".
   *
   * WHOSE QUEUE WINS. A host that already supplies one keeps it: the tree's
   * queue carries tree behaviour this surface has no business reimplementing
   * (/goal, /loop, the node's own status, the account-limit fence), and its
   * drain lives with the node. This one is offered only where there is none.
   */
  const queueEntries = () => {
    try { return outboxList(queueKey()) || [] } catch { return [] }
  }
  const ownQueue = {
    list: () => queueEntries().map(entry => ({
      id: entry.id,
      text: entry.text,
      ...(entry.deliveryUnconfirmed ? { deliveryUnconfirmed: true } : {}),
      /* The store's name for why this row is still waiting -- a Send now
         whose stop never reported idle inside the composer's release budget.
         A row rebuilt by hand only carries the fields named here, so leaving
         this one out did not merely lose a label: the row went quietly back
         to reading "Send now", which is the silent hold the named reason
         exists to remove. views/computers.js carries the same field for the
         same reason; the strip paints only reasons the copy table knows. */
      ...(typeof entry.heldReason === 'string' && entry.heldReason ? { heldReason: entry.heldReason } : {}),
    })),
    add: text => {
      const result = outboxEnqueue(queueKey(), text)
      void Promise.resolve().then(() => drainQueue())
      return result
    },
    cancel: id => outboxCancel(queueKey(), id),
    replace: (id, text) => outboxReplace(queueKey(), id, text),
    hold: request => outboxHoldForSend(queueKey(), request),
    /* "Send now" while a turn runs cannot mean "into this turn" -- the engine
       refuses an overlapping send by design -- so the only honest meaning is
       the head of the queue, said out loud. Same answer the tree gives. */
    sendNow: id => {
      if (queueEntries().find(entry => entry.id === id)?.deliveryUnconfirmed) {
        return { ok: false, sentence: QUEUE_PANEL.blockedUnconfirmed }
      }
      if (!outboxPromoteFront(queueKey(), id)) return { ok: false, sentence: QUEUE_PANEL.moveGone }
      return { ok: true, sentence: movedFrontSentence({ turnRunning: working === true }) }
    },
    subscribe: listener => {
      const heard = event => { if (event?.detail?.sessionId === queueKey()) listener() }
      globalThis.window?.addEventListener?.(SESSION_OUTBOX_EVENT, heard)
      return () => globalThis.window?.removeEventListener?.(SESSION_OUTBOX_EVENT, heard)
    },
  }
  /* ONE WAITING MESSAGE GOES OUT, THROUGH THE SAME WIRE A TYPED ONE USES.
     Called from the turn-completed branch, which is the engine's only "I am
     free" signal. A refusal puts the words back at the FRONT rather than
     dropping them: the person wrote them and the order is theirs. */
  let draining = false
  const drainQueue = async () => {
    if (draining || destroyed || working || starting || stopping || sending || !ready || !sessionId
      || placementLocked || steering || imagePreparing || switchPending() || endedRecovery
      || (sessionOwnerContext && !imageOwner.isCurrent(sessionOwnerContext))) return
    const entry = outboxTakeNext(sessionId)
    if (!entry) return
    draining = true
    const target = sessionId
    try {
      const result = await control?.send(entry.text)
      if (result?.ok === true) outboxConfirmDelivered(target, entry)
      else {
        const notSent = ['AGENT_SESSION_NOT_READY', 'AGENT_TURN_ACTIVE', 'AGENT_SESSION_NO_PROMPT'].includes(result?.code)
          || result?.deliveryDisposition === 'not-sent'
        outboxRequeueFront(target, notSent ? entry : { ...entry, deliveryUnconfirmed: true })
      }
    } catch { outboxRequeueFront(target, { ...entry, deliveryUnconfirmed: true }) }
    finally { draining = false }
  }

  let sessionSwitch = null
  const switchPending = () => Boolean(sessionSwitch && !sessionSwitch.finished)
  const imageOwner = createImageOwnerClient({ bridge })
  let sessionOwnerContext = null
  let endedRecovery = null
  let imagePreparing = false
  const imageRowListeners = new Set()
  let imageRowsUnsubscribe = null
  let imageConversation = null
  let imageSessionId = null
  const releaseImageConversation = () => {
    imageRowsUnsubscribe?.()
    imageRowsUnsubscribe = null
    imageConversation?.dispose()
    imageConversation = null
    imageSessionId = null
  }
  const currentImageConversation = () => {
    if (imageSessionId !== sessionId) releaseImageConversation()
    if (!sessionId || destroyed || typeof bridge?.imageQueue !== 'function') return null
    if (!imageConversation) {
      const id = sessionId
      imageSessionId = id
      imageConversation = createImageConversation({
        bridge, sessionId: id, ownerClient: imageOwner,
        isCurrent: () => !destroyed && sessionId === id,
        mayDrain: () => !destroyed && sessionId === id && ready
          && !working && !starting && !stopping && !placementLocked && !steering && !imagePreparing && !switchPending() && !endedRecovery,
        subscribeReady: listener => sessionChatStatus.subscribe(listener),
        readinessRevision: () => sessionChatStatus.readinessRevision(),
        interrupt: () => control.pause(),
      })
      imageRowsUnsubscribe = imageConversation.subscribe(view => {
        for (const listener of imageRowListeners) listener(view)
      })
    }
    return imageConversation
  }
  const finishEndedRecovery = async (recovering, id) => {
    if (!recovering) return
    const conversation = currentImageConversation()
    const current = () => !destroyed && sessionId === id && endedRecovery === recovering
      && recovering.successorSessionId === id && imageOwner.isCurrent(recovering.ownerContext)
    try {
      if (!conversation || !current()) throw new Error('Recovery queue unavailable')
      conversation.hold()
      const view = await conversation.refresh()
      if (!current() || view?.state !== 'ready') throw new Error('Recovery queue read unconfirmed')
      if (view.destinationSessionId !== null && view.destinationSessionId !== id) {
        if (view.destinationSessionId !== recovering.imageSourceSessionId) throw new Error('Recovery queue destination changed')
        const transferred = await conversation.transferDestination({
          destinationSessionId: id, view, operationId: crypto.randomUUID(),
        })
        if (!current() || transferred?.ok !== true || transferred.reconciled !== true
          || transferred.currentSnapshot?.destinationSessionId !== id) throw new Error('Recovery queue transfer unconfirmed')
      }
      if (!current()) throw new Error('Recovery changed')
      endedRecovery = null
      conversation.releaseHold()
    } catch {
      // This successor is already admitted and bound. Keep it and its held
      // queues available for an explicit retry; never start a second provider.
      throw Object.assign(new Error('Recovery queue transfer unconfirmed'),
        { code: 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED', recoveryTransferPending: true })
    }
  }
  const imageOutbox = {
    subscribe(listener) {
      imageRowListeners.add(listener)
      const conversation = currentImageConversation()
      if (conversation) void conversation.refresh()
      else listener({ state: 'held', code: 'AGENT_SESSION_NOT_READY', entries: [] })
      return () => imageRowListeners.delete(listener)
    },
    refresh: () => currentImageConversation()?.refresh(),
    cancel: (id, view) => currentImageConversation()?.cancel(id, view)
      ?? Promise.resolve({ ok: false, code: 'AGENT_SESSION_NOT_READY' }),
  }
  const submitImageIntent = async (draft, onState) => {
    if (destroyed || placementLocked || imagePreparing || switchPending() || !isWriteEnabled('agent-session')) {
      return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
    }
    const capturedDraft = structuredClone(draft)
    imagePreparing = true
    let preparedForDrain = false
    try {
      const prepared = await imageOwner.prepareImages(async ({ isCurrent }) => {
        const assertCurrent = () => {
          if (destroyed || !isCurrent()) throw Object.assign(new Error('Image owner changed'), { code: 'IMAGE_OWNER_CHANGED' })
        }
        assertCurrent()
        if (!sessionId) {
          const hostDraft = capturedDraft.hostDraft
          const imageStartIdentity = hostDraft ? Object.freeze({ sessionId: hostDraft.sessionId,
            draftId: hostDraft.draftId, ownerContext: hostDraft.ownerContext }) : null
          const opened = await startSession(capturedDraft.text, { openOnly: true, assertImageCurrent: assertCurrent,
            imageStartIdentity })
          assertCurrent()
          if (!opened.ok) throw Object.assign(new Error('Session unavailable'), { code: opened.code })
        }
        const id = sessionId
        if (endedRecovery) await finishEndedRecovery(endedRecovery, id)
        assertCurrent()
        const images = []
        for (const image of capturedDraft.images || []) {
          assertCurrent()
          if (sessionId !== id) throw Object.assign(new Error('Session changed'), { code: 'IMAGE_CONVERSATION_CHANGED' })
          const pending = pendingPastes.get(image.path)
          if (!pending) { images.push({ path: image.path }); continue }
          const saved = pending.saved?.sessionId === id ? pending.saved
            : await bridge.pasteAttachment({ sessionId: id, data: pending.data, mime: pending.mime })
          assertCurrent()
          if (sessionId !== id) throw Object.assign(new Error('Session changed'), { code: 'IMAGE_CONVERSATION_CHANGED' })
          if (saved?.ok !== true || typeof saved.path !== 'string' || !saved.path) {
            throw Object.assign(new Error('Picture was not saved'), { code: saved?.code || 'IMAGE_PREPARATION_UNCONFIRMED' })
          }
          pending.saved = { ...saved, sessionId: id }
          images.push({ path: saved.path })
        }
        return { ...capturedDraft, images }
      })
      if (!prepared.ok || !prepared.isCurrent()) return prepared
      const conversation = currentImageConversation()
      if (!conversation) return { ok: false, code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' }
      const result = await conversation.submit(prepared.value, onState)
      if (result.ok && !result.detached && prepared.isCurrent()) {
        preparedForDrain = true
        // Keep paste-token resolution until disposal: a newer draft can still
        // refer to the same token while this earlier admission settles.
      }
      return result
    } finally {
      imagePreparing = false
      if (!destroyed && preparedForDrain) void imageConversation?.signalReady()
      if (!destroyed) notifyChatStatus()
    }
  }

  const pasteImage = async (data, mime) => {
    if (destroyed || switchPending()) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
    if (sessionId && !starting) return bridge.pasteAttachment({ sessionId, data, mime })
    // This token never crosses the host boundary. Resolve it only after a
    // real session starts under the owner captured for the submitted draft.
    const path = `pending-paste:${statusId}/Pasted image ${++pasteSequence}.png`
    pendingPastes.set(path, { data, mime })
    return { ok: true, path }
  }

  const mountChat = () => {
    const previous = chat
    chat = buildChat({
      ...chatFromHost(),
      ...(chatChips ? { chips: chatChips } : {}),
      /* Spread AFTER the host's configuration so a host that has its own queue
         keeps it, and only a surface with none is given this one. */
      ...(chatComposer && !hostChat?.queue ? { queue: ownQueue } : {}),
      title: chatComposer ? chatTitle : 'Session transcript',
      tall: true,
      seed: 0,
      retainOnDetach: retainChatOnDetach,
      ...(chatComposer ? {
        /* THE PERSON'S OWN COMPOSER CONTROLS. T286: these were passed by the
           tree conversation and by nothing else, so the + surface, the agent
           page and the home chat takeover -- every caller of this mount --
           had no attach and no mention. The owner's words were "its the same
           agent system", and this is the seam where it stopped being.

           EACH IS SPREAD ON THE CAPABILITY, not passed unconditionally. A
           bridge without pickAttachment draws no attach button at all, which
           is the rule views/computers.js already follows: a control that
           cannot do anything is worse than no control, because a person
           spends a click and their attention learning it is dead.

           Both are scoped by the LIVE sessionId read at call time, never by a
           tree: pickAttachment and pickMention take a session and nothing
           else, so there is no tree identity involved and a solo seat is as
           entitled to them as a placed one. */
        /* NEITHER OF THESE MAY SWALLOW WHAT HAPPENED. Measured on screen at
           0e50eabb: both buttons were enabled, both bridge methods were
           functions, and pressing either did nothing at all -- no picker, no
           sentence, no change. Two of my own lines caused that. `.catch(() =>
           null)` on attach turned every refusal into silence, and the early
           `if (!sessionId) return null` on both did the same before a session
           existed, which is how mention LOST the refusal sentence it used to
           give. A control that answers nothing is worse than one that refuses:
           the person cannot tell a broken button from a busy one.

           So: no early null, and a refusal comes back in the shape the chat
           can say out loud. views/computers.js does exactly this for a tree
           conversation and has all along. */
        ...(typeof bridge?.pickAttachment === 'function' ? {
          onAttach: async () => {
            try { return await bridge.pickAttachment({ sessionId }) }
            catch (error) { return { ok: false, sentence: mentionRefusalSentence(error) } }
          },
        } : {}),
        ...(typeof bridge?.pickMention === 'function' ? {
          onMention: async () => {
            try { return await bridge.pickMention({ sessionId }) }
            catch (error) { return { ok: false, sentence: mentionRefusalSentence(error) } }
          },
        } : {}),
        imageOutbox,
        onImageIntent: submitImageIntent,
        onSend: async (text, { attachments = [], pictures = null, accepted, fail, note }) => {
          const pastedImages = attachments.filter(item => pendingPastes.has(item.path)).map(item => pendingPastes.get(item.path))
          const images = attachments.filter(item => !pendingPastes.has(item.path)).map(item => ({ path: item.path }))
          const startDraft = !sessionId ? { text, attachments: attachments.slice(), start: text.length, end: text.length } : null
          if (startDraft) pendingComposerStart = startDraft
          let result
          try { result = await control?.send(text, { images, pastedImages, pictures }) }
          finally { if (pendingComposerStart === startDraft) pendingComposerStart = null }
          // A captured positive host receipt settles the original row even
          // when this view was disposed while the send was in flight.
          if (result?.deliveryDisposition === 'accepted') {
            accepted?.(result)
            if (destroyed) return
            for (const item of attachments) pendingPastes.delete(item.path)
            /* The words went and the picture did not. Said here, in the
               conversation, because a sentence written only into the durable
               record is a sentence the person never reads. A note, not a
               refusal: the send succeeded. */
            if (typeof result.pictureNotSent?.sentence === 'string' && result.pictureNotSent.sentence) {
              (note || fail)(result.pictureNotSent.sentence)
            }
            return
          }
          const notSent = result?.deliveryDisposition === 'not-sent'
            || (result?.ok === false && result.deliveryDisposition == null
              && ['AGENT_SESSION_NOT_READY', 'AGENT_TURN_ACTIVE', 'AGENT_SESSION_NO_PROMPT',
                'IMAGE_OWNER_CHANGED', 'AGENT_SWITCH_PENDING'].includes(result.code))
          const code = result?.code || 'AGENT_SEND_UNKNOWN'
          fail(readerSafeReason(code), { retract: notSent, unconfirmed: !notSent, code })
          if (destroyed) return
          const draft = chat.exportDraft()
          if (notSent && draft && !draft.text) chat.importDraft({ ...draft, text })
        },
        ...(typeof bridge?.pasteAttachment === 'function' ? {
          onPasteAttachment: pasteImage,
        } : {}),
      } : { composerReason: SESSION_TRANSCRIPT_COMPOSER_REASON }),
      onOpenDiff: selection => openChatDiff({ ...selection, sessionId: sessionId || lastDiffSessionId }),
      status: sessionChatStatus,
      /* SEND NOW's host reservation, placed before the interrupt and released
         when the words do not go (T785). Scoped to the LIVE sessionId and
         gated on the bridge exposing the ops, the same shape onAttach/onMention
         follow: a bridge without them wires no behaviour, and the composer's
         Send now simply reserves nothing. reserve returns the host's stamp as
         an opaque token; release compare-and-clears it, so it can never wipe a
         later waiter's reservation. */
      ...(typeof bridge?.reserveSendNow === 'function' ? {
        onReserveHold: async () => {
          /* Capture the EXACT owner -- bridge and session id -- at reserve, so
             the release goes to it even after the session is rebound/replaced.
             Reading sessionId fresh at release would send a hold reserved on A
             to a replacement B, leaking A's reservation. */
          const heldBridge = bridge
          const heldSessionId = sessionId
          if (!heldSessionId || typeof heldBridge?.reserveSendNow !== 'function') return null
          try {
            const reserved = await heldBridge.reserveSendNow({ sessionId: heldSessionId })
            return reserved?.ok ? { bridge: heldBridge, sessionId: heldSessionId, token: reserved.token } : null
          } catch { return null }
        },
      } : {}),
      ...(typeof bridge?.releaseSendNow === 'function' ? {
        onReleaseHold: hold => {
          /* Release the captured owner, best effort, catching the promise's
             rejection so a rejected release is never an unhandled rejection. */
          if (!hold || typeof hold.bridge?.releaseSendNow !== 'function' || hold.token == null) return
          try { Promise.resolve(hold.bridge.releaseSendNow({ sessionId: hold.sessionId, token: hold.token })).catch(() => {}) }
          catch { /* the host self-clears when the words land */ }
        },
      } : {}),
      onStop: async () => {
        const outcome = await control?.pause?.()
        return chatComposer && outcome ? { ...outcome, ...(outcome.ok ? {} : { sentence: readerSafeReason(outcome.code) }) } : undefined
      },
      onApprovalDecision: (id, decision) => answerSessionApproval(id, decision),
    })
    if (previous) {
      previous.replaceWith(chat)
      previous.dispose?.()
    } else {
      form.insertAdjacentElement('afterend', chat)
    }
    paintApprovals()
  }
  mountChat()

  actionState(output, 'note', CONFINEMENT_PENDING)
  /* ANCHOR WITH A FALLBACK, BECAUSE THE ANCHOR IS ONE PAGE'S FURNITURE.
     `.agent-strip` exists on the agent view and nowhere else; the home page's
     chat takeover hands this mount a bare stage div it has just emptied. The
     optional chain made that a SILENT no-op -- the surface was built, wired,
     and never inserted, which read as a blank sheet with no error anywhere.
     Append is the right fallback: on a host with no strip, the surface IS the
     content. */
  {
    const strip = root.querySelector('.agent-strip')
    if (strip) strip.insertAdjacentElement('afterend', surface)
    else root.appendChild(surface)
  }

  /* The confinement reading, asked for once per mount and rendered as sentences
     by the pure copy module. `catch` collapses to the unknown reading rather than
     to a cheerful default: a bridge that cannot answer is exactly the case where
     guessing "full local access" would be the original defect all over again. */
  let confinementText = ''
  const renderConfinement = (reading) => {
    /* NAMES THE MACHINE THE READING IS ABOUT, WHICH IS NOT ALWAYS THIS ONE.
       This asked for the note with no subject, so it defaulted to "This
       computer" -- and the reading it describes came over the relay from the
       machine being driven. So a person reading in a browser somewhere else was
       told that THEIR laptop "can read, change and delete any file on this
       computer and run any program, without asking", on the page that carries
       the Start button. It is a safety disclosure, and it named the wrong
       computer.
       The remote twin already existed and was applied to the sibling call in
       views/computers.js and to no other; this is that same line. */
    const note = confinementNote(reading, {
      subject: currentDataSource() === 'relay' ? CONFINEMENT_SUBJECT_REMOTE : CONFINEMENT_SUBJECT_HERE,
    })
    confinementText = note.sentences.join(' ')
    /* 'note', not 'unavailable'. The shared write-surface stylesheet paints
       [data-state="unavailable"] in --s-serious, which rendered this accurate
       description of a perfectly healthy install in alarm red on all three
       themes -- caught by looking at the screenshots, not by any assertion,
       because every word of it was correct. Nothing here is a fault: the
       refusal, when there is one, is the status row above. */
    actionState(output, 'note', confinementText)
  }

  /* Transcript deltas are batched per animation frame and pushed into the
     panel's current message bubble as one growing string. This used to be
     `transcript.textContent += text` once per delta, which is quadratic in
     the transcript's length -- 20,000 deltas measured at 1051 ms of blocked
     main thread, against 1.1 ms batched. The engine emits one delta PER
     TOKEN, so that path ran tens of thousands of times per turn and got worse
     the longer a session lived. Nothing is dropped or capped; see
     createStreamRelay above for the full reasoning and numbers, carried over
     from src/agent-session-transcript.js's createTranscriptAppender. */
  let turnStream = null
  const sessionTextReader = createSessionTextReader()
  const relay = createStreamRelay({
    push: text => { if (turnStream) turnStream.push(text) },
    scheduleFrame,
    cancelFrame,
  })
  const setStarted = (open) => {
    startButton.disabled = placementLocked || open || destroyed || !ready
    prompt.disabled = placementLocked || open
    stopButton.disabled = placementLocked || !open
  }

  const snapshot = () => ({
    sessionId, replacement: sessionSwitch ? { operationId: sessionSwitch.operationId, pending: !sessionSwitch.finished } : null,
    phase: destroyed ? 'closed' : stopping ? 'stopping' : starting ? 'starting'
      : sessionId ? working ? 'working' : 'open' : lastPrompt || terminalCode ? 'closed' : 'draft',
    prompt: lastPrompt || chat?.exportDraft?.()?.text || '', sentPrompt: lastPrompt, threadId, account, turnId: activeTurnId, lastTurnStatus,
    transcript: structuredClone(transcript), currentText: turnStream ? relay.text : '',
  })
  const announce = (kind, detail = {}, required = false) => {
    if (typeof onSessionChange !== 'function') return
    try {
      const pending = onSessionChange(snapshot(), { kind, ...detail })
      return required ? pending : Promise.resolve(pending).catch(() => {})
    } catch (error) { if (required) throw error }
  }
  const finishReply = (text = relay.text) => {
    if (turnStream && text) transcript.push({ who: 'agent', text, at: replyAt, ...(activeTurnId ? { turnStamp: activeTurnId } : {}) })
  }
  const placementRefusal = () => ({ ok: false, code: 'AGENT_SESSION_NOT_READY', sentence: 'Finish placing this agent before using its session controls.' })

  /* EVERY CHANGE OF STATE IS ANNOUNCED, from one place.
     The Controls panel decides what it may do from this record, so a transition
     that forgot to publish would leave a live control pointed at a session that
     had ended. Publishing from a single helper called on every transition is
     what makes "the control is enabled" and "the session is open" the same
     fact rather than two facts that agree most of the time. */
  const publish = () => {
    if (chatComposer) notifyChatStatus()
    if (!destroyed) announce('state')
    if (!publishSession) return
    if (destroyed || !sessionId) {
      publishLiveSession(null)
      return
    }
    publishLiveSession({
      agentId,
      sessionId,
      phase: stopping ? 'stopping' : (starting ? 'starting' : (working ? 'working' : 'open')),
      control,
    })
  }

  /* A visible Stop is confirmed, not best-effort. The main process also closes
     every session owned by a destroyed WebContents, but that teardown guarantee
     does not make a rejected press successful while this surface is still here.
     The id is cleared only after close answers; callers can therefore keep the
     controls honest and show the refusal when it does not. */
  const closeSession = async () => {
    const id = sessionId
    if (!id) return { ok: true }
    stopping = true
    publish()
    /* THE INTERRUPT IS ASKED FOR ONLY WHEN THERE IS A TURN TO INTERRUPT.
     *
     * It used to be unconditional with the rejection swallowed, on the reasoning
     * that "no active turn is the common, expected case". The swallow works --
     * nothing user-visible went wrong -- but the rejection is not silent one
     * level up: Electron prints `Error occurred in handler for
     * 'mc-agent:interrupt': AgentHostError: Session <id> has no active turn`
     * with a full stack, and it did so on EVERY press of Stop, Respawn and
     * Terminate over an idle session. MEASURED on the real window
     * (tools/steering-controls-e2e.cjs): one such stack per respawn, on the
     * completely correct path. A product that logs an error while doing exactly
     * what was asked teaches whoever reads that log to ignore it, which is how
     * the next real fault goes unnoticed.
     *
     * ASKING FIRST IS NOT A WEAKER TEARDOWN. `working` false and a turn still
     * running would skip a graceful interrupt, and close() below still ends the
     * child either way -- so the failure mode of a wrong reading is a less
     * polite stop, never a surviving process. The opposite default, interrupting
     * something that is not there, buys nothing at all. */
    const hadTurn = working
    if (hadTurn) {
      lastTurnStatus = 'interrupted'
      try { await bridge.interrupt({ sessionId: id }) } catch { /* the turn may finish between the read and the call */ }
    }
    try { await bridge.close({ sessionId: id }) } catch (error) {
      /* The child can report its own exit while close is crossing IPC. The
         terminal event has already retired this id and painted the truthful
         ended state in that case; treating the ensuing UNKNOWN_SESSION as a
         failed close would re-enable controls for a process that is gone. */
      if (sessionId !== id) {
        stopping = false
        publish()
        return terminalCode
          ? { ok: true, ended: true, code: terminalCode }
          : { ok: true }
      }
      stopping = false
      publish()
      return { ok: false, code: refusalCode(error) }
    }
    /* A terminal packet can also settle before a successful close reply. Its
       event handler owns the visible terminal state; do not overwrite it with
       the requested-close sentence below. */
    if (sessionId !== id) {
      stopping = false
      publish()
      return terminalCode
        ? { ok: true, ended: true, code: terminalCode }
        : { ok: true }
    }
    retireApprovals(id)
    sessionTextReader.clear(id)
    sessionId = null
    releaseImageConversation()
    working = false
    stopping = false
    /* A session can end while a turn is still open -- an interrupt the host
       never confirmed with its own turn_completed (see the comment above).
       Left alone, that bubble would carry a busy indicator forever after the
       session it belonged to is gone. Closing it here, whichever way the
       session ended, is the same safety net the transcript's word-count and
       uncapped buffer already carry. */
    relay.flushNow()
    finishReply()
    if (turnStream) { turnStream.close(relay.text); turnStream = null }
    resetLiveMetrics()
    publish()
    announce('closed', { sessionId: id })
    return { ok: true }
  }

  const bridgeControl = sessionBridgeControl(bridge)
  if (bridgeControl.disabled) {
    actionState(status, 'unavailable', `unavailable · ${BRIDGE_ABSENT}`)
    /* No shell means no way to ask what a session would be confined to, so the
       copy states that absence instead of leaving the pending sentence up
       forever -- or, worse, falling back to the claim this repair removed. */
    renderConfinement(null)
    return () => { resetLiveMetrics(); destroyed = true; cancelHeldStart(); compareFiles.close(); chat.dispose?.(); surface.remove() }
  }

  /* Asked separately from availability, and allowed to fail separately. A copy
     of the product whose confinement cannot be read must still be able to say
     why Start is disabled, and an install that is perfectly startable must still
     describe itself even if this read fails. Coupling them would let either
     failure blank the other's answer. */
  void (async () => {
    let reading = null
    try {
      reading = typeof bridge.confinement === 'function' ? await bridge.confinement() : null
    } catch { reading = null }
    if (!destroyed) renderConfinement(reading)
  })()

  void (async () => {
    let available
    try { available = await bridge.availability() }
    catch (error) { available = { ok: false, code: refusalCode(error) } }
    if (destroyed) return
    if (available?.ok !== true) {
      actionState(status, 'unavailable', `unavailable · ${readerSafeReason(available?.code)}`)
      return
    }
    if (requireRoleBinding && !roleBinding) {
      actionState(status, 'unavailable', `unavailable - ${readerSafeReason('MC_AGENT_ROLE_UNAVAILABLE')}`)
      return
    }
    ready = true
    actionState(status, 'ready', 'agent engine ready')
    startButton.disabled = false
  })()

  /* A MESSAGE SENT TO THIS SESSION FROM A SIGNED-IN BROWSER. The computer
     accepted it as the person's turn and announces it before the turn's first
     reply packet, so the line lands above its answer. It is painted once: a
     transcript line already carrying the same turn id is not painted again.
     The reply streams into a bubble opened here, as a send from this page does. */
  const acceptRemotePersonTurn = ({ text, turnId, at }) => {
    if (turnId && transcript.some(entry => entry.who === 'you' && entry.turnStamp === turnId)) return
    if (turnStream) {
      relay.flushNow()
      finishReply()
      turnStream.close(relay.text)
      turnStream = null
    }
    const when = Number.isSafeInteger(at) ? at : Date.now()
    transcript.push({ who: 'you', text, at: when, ...(turnId ? { turnStamp: turnId } : {}) })
    chat.addOwnerMessage(text, { at: when, turnStamp: turnId })
    lastTurnStatus = null
    working = true
    activeStep = ''
    if (chatComposer) relay.reset()
    replyAt = Date.now()
    turnStream = chat.openStream({ at: replyAt, turnStamp: turnId })
    adoptTurn(turnId)
    publish()
    actionState(status, 'ready', 'running - session open')
  }

  unsubscribe = bridge.onEvent((packet) => {
    if (destroyed || !sessionId) return
    const personTurn = sessionPersonTurn(packet, sessionId)
    if (personTurn) {
      if (personTurn.via === 'remote') acceptRemotePersonTurn(personTurn)
      return
    }
    if (packet?.sessionId === sessionId) confirmedFileChanges.add(packet, null)
    const ended = sessionEndedEvent(packet, sessionId)
    if (ended && switchPending() && sessionSwitch.sourceId === sessionId) {
      sessionSwitch.sourceEnded = ended
      return
    }
    if (ended) {
      const endedSessionId = sessionId
      endedRecovery = { sourceSessionId: endedSessionId, ownerContext: sessionOwnerContext,
        queueSessionId: endedRecovery?.queueSessionId || endedSessionId,
        imageSourceSessionId: endedRecovery?.imageSourceSessionId || endedSessionId }
      /* The one session owner retires every live edge before notifying the
         page. A duplicate terminal packet then sees no session id and is a
         no-op. Exit code zero is still terminal, never inferred as success. */
      retireApprovals(endedSessionId)
      sessionTextReader.clear(endedSessionId)
      releaseImageConversation()
      sessionId = null
      terminalCode = 'MC_AGENT_SESSION_ENDED'
      starting = false
      stopping = false
      working = false
      relay.flushNow()
      finishReply()
      if (turnStream) { turnStream.close(relay.text); turnStream = null }
      resetLiveMetrics()
      setStarted(false)
      publish()
      actionState(status, 'refused', `ended - ${readerSafeReason(terminalCode)}`)
      if (typeof onSessionEnd === 'function') {
        try { onSessionEnd({ sessionId: endedSessionId, code: terminalCode, ended }) } catch { /* terminal ownership is already settled */ }
      }
      announce('closed', { sessionId: endedSessionId })
      return
    }
    const turnStatus = sessionTurnStatus(packet, sessionId)
    /* A late completion cannot take the active turn back from a newer turn.
       The tree surface uses the same public event-reader guard. Nameless
       completions retain the established fallback and settle normally. */
    if (turnStatus && !completionSettlesOpenTurn(packet, sessionId, activeTurnId)) return
    /* Tool calls can precede the first word. The packet's own turn identity is
       therefore adopted for every live delta/event shape, never inferred from
       prose. A completion is validated above and never reopens an older turn. */
    if (!turnStatus) adoptTurn(sessionEventTurnId(packet, sessionId))
    const speech = sessionTextReader.read(packet, sessionId)
    if (speech?.text) {
      if (speech.breakBefore && relay.text) relay.append('\n\n')
      relay.append(speech.text)
      return
    }
    const activity = sessionActivityEvent(packet, sessionId)
    if (activity) {
      const confirmedChanges = confirmedFileChanges.add(packet, activity)
      const receivedAt = Date.now()
      const before = actionBuffer.metrics(activeTurnId)
      const filed = actionBuffer.add(activity, { turnId: activeTurnId, at: receivedAt })
      const metricsChanged = !sameMetricSnapshot(before, actionBuffer.metrics(activeTurnId))
      if (filed.row) {
        const row = { who: 'action', ...sessionActionChatRow(filed.row) }
        const previous = transcript.findIndex(entry => entry.who === 'action' && entry.id === row.id)
        if (previous < 0) transcript.push(row)
        else transcript[previous] = row
        chat.addAction(row)
      }
      if (activity.kind === 'approval') offerApproval(activity, packet)
      if (confirmedChanges) {
        lastDiffSessionId = sessionId
        const publishDiff = originals => {
          if (destroyed) return
          const diff = {
            source: 'session-file-change',
            id: confirmedChanges.changeId,
            at: receivedAt,
            files: confirmedChanges.fileChanges,
            patches: confirmedChanges.filePatches,
            edits: confirmedChanges.fileEdits,
            originals,
            limited: confirmedChanges.fileChangesLimited,
            activeIndex: 0,
          }
          /* Keyed by the change's own id, so the settled republication below
             replaces this entry rather than adding a second card for it. */
          const previous = transcript.findIndex(entry => entry.who === 'diff' && entry.id === diff.id)
          if (previous < 0) transcript.push({ who: 'diff', ...diff })
          else transcript[previous] = { who: 'diff', ...diff }
          chat.addDiff(diff)
        }
        /* SHOWN AT ONCE, THEN CORRECTED WHEN THE READ LANDS. The card must not
           wait on a disk read -- an edit the person can see reported is an edit
           they can see reported now -- but the original must not be lost merely
           because the read had not finished when the result arrived. Both
           publications carry the same id, so this is one card either way. */
        publishDiff(confirmedChanges.fileOriginals)
        if (confirmedChanges.originalsReady) {
          void confirmedChanges.originalsReady
            .then(settled => {
              if ((settled?.length ?? 0) > (confirmedChanges.fileOriginals?.length ?? 0)) publishDiff(settled)
            })
            .catch(() => { /* a capture that failed leaves the reconstruction routes exactly as they were */ })
        }
      }
      const step = activityLine(activity)
      const stepChanged = step !== activeStep
      if (stepChanged) activeStep = step
      if (metricsChanged || stepChanged) notifyChatStatus()
      return
    }
    if (turnStatus) {
      /* Flush before the status flips, so "turn completed" is never shown
         beside a transcript that is still missing that turn's last frame of
         output, and close the bubble so its busy indicator clears with it. */
      retireApprovals(sessionId, { keepAnswering: true })
      relay.flushNow()
      const engineSentence = turnStatus === 'interrupted' || sessionTurnCancelled(turnStatus)
        ? null : sessionTurnFailureText(packet, sessionId)
      // Use the tree's completion vocabulary here too. A provider refusal can
      // be the turn's only output; keep it in both the closed bubble and the
      // saved transcript without dropping any assistant words already sent.
      const replyText = engineSentence
        ? turnCompletionWords({ succeeded: false, spoken: relay.text, engineSentence })
        : relay.text
      finishReply(replyText)
      if (turnStream) { turnStream.close(replyText); turnStream = null }
      if (activeTurnId) actionBuffer.clearMetrics(activeTurnId)
      activeTurnId = null
      activeStep = ''
      working = false
      lastTurnStatus = turnStatus
      notifyChatStatus()
      publish()
      /* The turn is over, so the next waiting message goes. Deliberately AFTER
         notifyChatStatus and publish: the strip repaints against a session that
         is idle, and the send that follows makes it busy again, in that order.
         A surface whose host owns the queue drains through the host instead. */
      if (chatComposer && !hostChat?.queue) void drainQueue()
      actionState(status, sessionTurnSucceeded(turnStatus) ? 'confirmed' : 'refused',
        engineSentence ? TURN_FAILED.reply(engineSentence) : `turn ${turnStatus} · session still open`)
    }
  })

  /* ONE START PATH, used by the form and by Respawn.
     Respawn is "this work again, in a new process". If it built its own start
     call the two would drift, and the half that drifted would be the one nobody
     watches -- so there is one, and Respawn passes the same text back into it. */
  /* `images` is the pasted-attachment path list, in the shape the boundary
     already takes from Page 2 (src/views/computers.js treeCardSend). It is
     optional and defaulted, because Respawn and the Start form below call this
     with the words alone -- see respawn() for why a replayed prompt carries no
     picture. */
  const savePastedImages = async (id, pastedImages) => {
    const savedImages = []
    for (const image of Array.isArray(pastedImages) ? pastedImages : []) {
      if (destroyed || sessionId !== id) throw Object.assign(new Error('AGENT_SESSION_VIEW_CLOSED'), { code: 'AGENT_SESSION_VIEW_CLOSED' })
      const saved = await bridge.pasteAttachment({ sessionId: id, data: image.data, mime: image.mime })
      if (destroyed || sessionId !== id) throw Object.assign(new Error('AGENT_SESSION_VIEW_CLOSED'), { code: 'AGENT_SESSION_VIEW_CLOSED' })
      if (saved?.ok !== true || typeof saved.path !== 'string' || !saved.path) {
        const error = new Error('MC_AGENT_PASTE_UNAVAILABLE')
        error.code = saved?.code || 'MC_AGENT_PASTE_UNAVAILABLE'
        throw error
      }
      savedImages.push({ path: saved.path })
    }
    return savedImages
  }

  const startSession = async (text, { images = null, pastedImages = null, pictures = null, heldAttempt = 0, openOnly = false, assertImageCurrent = null, recoveryStartOptions = undefined, recoveryStartOwner = undefined, imageStartIdentity = null } = {}) => {
    if (placementLocked || switchPending()) return placementRefusal()
    /* A HELD RETRY IS THE SAME START, STILL IN FLIGHT, so it passes the guard
       that keeps two starts apart: `starting` is deliberately still true and
       the session it just tried was closed on the way out. */
    const retryingHeld = heldAttempt > 0
    if ((starting && !retryingHeld) || sessionId || !ready || destroyed) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
    if (typeof text !== 'string' || (!openOnly && text.trim() === '')) return { ok: false, code: 'AGENT_SESSION_NO_PROMPT' }

    const recovering = endedRecovery
    let deliveryDisposition = 'not-sent'
    terminalCode = null
    threadId = null; account = null; lastTurnStatus = null
    starting = true
    sending = true
    setStarted(true)
    /* A fresh session, a fresh panel -- see mountChat() above for why this is
       a rebuild rather than a clear, and agent-session-controls.js for the
       confirmed claim ("the current transcript... are lost") it keeps true.
       A HELD RETRY REBUILDS NOTHING. The panel already belongs to this start,
       and tearing it down between attempts would wipe the very sentences that
       tell the person what the wait is -- which is the whole repair. */
    if (!retryingHeld) {
      resetLiveMetrics()
      actionBuffer = createActionBuffer()
      if (!chatComposer) { mountChat(); transcript = [] }
      relay.reset()
    }
    turnStream = null
    actionState(status, 'pending', retryingHeld ? `starting… attempt ${heldAttempt + 1}` : 'starting…')
    /* The same measured sentences, kept on screen while the session starts.
       They describe what this start is about to do, so removing them at the
       moment it happens would be exactly backwards. */
    actionState(output, 'note', confinementText)

    let id = imageStartIdentity?.sessionId ?? (globalThis.crypto?.randomUUID?.() || '')
    if (!id) {
      starting = false
      sending = false
      setStarted(false)
      /* The table already has the sentence for this, with the remedy on it --
         "close ToolsEnabled and open it again". Printing a shorter, remedy-less
         version of a sentence that exists is how two copies of one message come
         to disagree. */
      actionState(status, 'refused', `refused · ${readerSafeReason('AGENT_SESSION_NO_ID')}`)
      return { ok: false, code: 'AGENT_SESSION_NO_ID', deliveryDisposition }
    }

    let retainedStartOptions = recoveryStartOptions
    let retainedStartOwner = recoveryStartOwner
    const assertStartOwner = () => {
      if (destroyed || stopping) throw Object.assign(new Error('Session view closed'), { code: 'AGENT_SESSION_VIEW_CLOSED' })
      assertImageCurrent?.()
      if (retainedStartOwner && !imageOwner.isCurrent(retainedStartOwner)) {
        throw Object.assign(new Error('Session owner changed'), { code: 'IMAGE_OWNER_CHANGED' })
      }
    }
    try {
      if (retainedStartOwner === undefined) {
        retainedStartOwner = imageOwner.capture()
        if (!retainedStartOwner) {
          await imageOwner.start()
          retainedStartOwner = imageOwner.capture()
        }
      }
      assertStartOwner()
      if (recovering) {
        if (endedRecovery !== recovering || !recovering.ownerContext
          || recovering.ownerContext !== retainedStartOwner || typeof bridge.imageQueue !== 'function') {
          throw Object.assign(new Error('Ended recovery authority unavailable'), { code: 'RECOVERY_OWNER_CHANGED' })
        }
        const registered = await bridge.imageQueue({ operation: 'ended-register',
          sourceSessionId: recovering.sourceSessionId, conversationId: agentId, ownerContext: retainedStartOwner })
        assertStartOwner()
        const receipt = registered?.result
        if (endedRecovery !== recovering || registered?.ok !== true
          || typeof receipt?.recoveryId !== 'string' || !receipt.recoveryId
          || typeof receipt.sessionId !== 'string' || !receipt.sessionId
          || receipt.sourceSessionId !== recovering.sourceSessionId || receipt.conversationId !== agentId
          || ['version', 'ownerId', 'currentEpoch', 'kind'].some(key => receipt.ownerContext?.[key] !== retainedStartOwner[key])) {
          throw Object.assign(new Error('Ended recovery reservation unavailable'), { code: registered?.code || 'RECOVERY_DESTINATION_REFUSED' })
        }
        imageStartIdentity = receipt
        id = receipt.sessionId
      }
      if (imageStartIdentity && (typeof imageStartIdentity.sessionId !== 'string' || !imageStartIdentity.sessionId
        || !(typeof imageStartIdentity.draftId === 'string' && imageStartIdentity.draftId
          || typeof imageStartIdentity.recoveryId === 'string' && imageStartIdentity.recoveryId)
        || !retainedStartOwner || ['version', 'ownerId', 'currentEpoch', 'kind'].some(key =>
          imageStartIdentity.ownerContext?.[key] !== retainedStartOwner[key]))) {
        throw Object.assign(new Error('Image start identity changed'), { code: 'IMAGE_OWNER_CHANGED' })
      }
      sessionOwnerContext = retainedStartOwner
      sessionId = id
      /* THE WORDS TYPED BEFORE THIS SESSION EXISTED ARE THIS SESSION'S NOW.
         Moved rather than re-enqueued so their order and their ids survive --
         the queue strip anchors on an id across repaints, and a re-enqueue
         would renumber every waiting row under the person's hand. */
      // Keep old and newly queued work under one identity. Transfer before
      // native admission so a capacity refusal cannot consume the recovery grant.
      // If start later refuses, the retained queue key still addresses every row.
      if (recovering) {
        outboxMoveSession(recovering.queueSessionId, id, { preserveAll: true })
        recovering.queueSessionId = id
      } else {
        try { outboxMoveSession(localQueueKey, id) } catch { /* preserve ordinary start queue behavior */ }
      }
      queueKeyMoved = true
      publish()
      if (retainedStartOptions === undefined) {
        const choice = typeof getStartOptions === 'function' ? await getStartOptions({ sessionId: id, prompt: text }) : null
        retainedStartOptions = choice == null ? null : structuredClone(choice)
      }
      const startOptions = retainedStartOptions
      assertStartOwner()
      const started = await bridge.start({
        ...(startOptions || {}),
        sessionId: id,
        ...(imageStartIdentity ? {
          ...(imageStartIdentity.recoveryId ? { recoveryId: imageStartIdentity.recoveryId } : { draftId: imageStartIdentity.draftId }),
          ownerContext: imageStartIdentity.ownerContext,
        } : {}),
        ...(roleBinding ? { roleBinding } : {}),
      })
      assertStartOwner()
      if (started?.ok === false) throw Object.assign(new Error('Session start refused'), { code: started.code || 'AGENT_SESSION_FAILED' })
      if (recovering && (started?.sessionId !== id || started.recovery?.sessionId !== id
        || started.recovery?.recoveryId !== imageStartIdentity.recoveryId
        || started.recovery?.sourceSessionId !== recovering.sourceSessionId)) {
        throw Object.assign(new Error('Recovery binding was not confirmed'), { code: 'RECOVERY_DESTINATION_REFUSED' })
      }
      threadId = typeof started?.threadId === 'string' ? started.threadId : null
      account = typeof started?.account === 'string' ? started.account : null
      if (destroyed) { await closeSession(); return { ok: false, code: 'AGENT_SESSION_VIEW_CLOSED', sessionId: id, deliveryDisposition } }
      /* A STOP THAT LANDED DURING THE START IS NOT SOMETHING TO PAINT OVER.
         Stop is enabled for this whole await (setStarted(true) runs before
         it), and starting is slow by design -- account resolution plus a child
         process. Only `destroyed` was checked here, so a person who pressed
         Stop mid-start watched the panel answer "running · session open", open
         a busy bubble, and then say "refused" -- over the "stopped · session
         closed" their Stop had correctly just painted. Told it was running,
         then told it refused, for the one thing that actually worked.
         `sessionId !== id` is the reliable reading because closeSession() nulls
         it on success, so it means this start's session is no longer the
         panel's, whoever ended it. */
      if (stopping || sessionId !== id) return {
        ok: false,
        code: terminalCode || 'AGENT_SESSION_STOPPED_WHILE_STARTING',
        sessionId: id, deliveryDisposition,
      }
      lastPrompt = text
      const bindingContext = Object.freeze({ ownerContext: retainedStartOwner,
        isCurrent: () => Boolean(retainedStartOwner) && imageOwner.isCurrent(retainedStartOwner)
          && !destroyed && sessionId === id && !stopping })
      const opened = await announce('open', { sessionId: id, bindingContext }, true)
      assertStartOwner()
      // No send has been attempted while start/binding is pending. Preserve
      // that certainty so the composer restores this draft instead of showing
      // an unconfirmed delivery and removing its editable text.
      if (destroyed || sessionId !== id || stopping) return {
        ok: false, code: terminalCode || 'AGENT_SESSION_VIEW_CLOSED', sessionId: id, deliveryDisposition,
      }
      if (opened?.ok === false) {
        throw Object.assign(new Error('Session binding was not confirmed'), {
          code: typeof opened.code === 'string' ? opened.code : 'AGENT_SESSION_BINDING_UNCONFIRMED',
        })
      }
      if (recovering) {
        recovering.successorSessionId = id
        await finishEndedRecovery(recovering, id)
        assertStartOwner()
      }
      if (typeof onSessionOpen === 'function') {
        try { onSessionOpen(id) } catch { /* a view callback cannot strand the confirmed session */ }
      }
      starting = false
      if (openOnly) {
        working = false
        currentImageConversation()
        publish()
        actionState(status, 'ready', 'running · session open')
        return { ok: true, sessionId: id }
      }
      currentImageConversation()
      working = true
      notifyChatStatus()
      /* Opened here, before the turn's own words can arrive, so the panel
         shows a working bubble the instant a person presses Start rather than
         only once the first delta lands. */
      replyAt = Date.now()
      turnStream = chat.openStream({ at: replyAt })
      publish()
      actionState(status, 'ready', 'running · session open')
      /* THE HELD PICTURE IS SPENT HERE, and only here: this is the first
         moment a session exists to save it against. Spent means spent -- it is
         cleared before the await, so a second start cannot re-send it and a
         failure cannot leave it to surprise a later turn.

         A picture that cannot be saved does NOT take the person's words down
         with it: the message still goes, and they are told the picture did not
         (PASTE_HELD_LOST). Losing the sentence they typed to save a failed
         attachment would be the worse of the two. */
      let turnImages = Array.isArray(images) && images.length ? [...images] : []
      if (pastedImages?.length) turnImages.push(...await savePastedImages(id, pastedImages))
      if (heldPasteImage) {
        const held = heldPasteImage
        heldPasteImage = null
        let saved = null
        try { saved = await bridge.pasteAttachment({ sessionId: id, data: held.data, mime: held.mime }) }
        catch { saved = null }
        if (saved && saved.ok === true && typeof saved.path === 'string' && saved.path) {
          turnImages.push({ path: saved.path })
        } else if (!destroyed) {
          actionState(output, 'note', PASTE_HELD_LOST)
        }
      }
      /* PRESENT ONLY WHEN SOMETHING REALLY RIDES THIS TURN, the same rule
         src/components.js keeps for `attachments` and computers.js keeps for
         `images`: an empty list would make every layer below reason about a
         picture that is not there. */
      lastTurnCarriedPicture = turnImages.length > 0
      /* THE PICTURE RIDES THE ENTRY, NOT JUST THE FIRST PAINT (T332). The
         owner: "the images disappear from chat right after sending". They
         disappeared because the only copy was one optimistic DOM node, and
         every repaint -- a reopen, a remount, the mirror into a second open
         surface -- redraws from this entry. Same rule as the fields around it:
         present only when a picture really rides this turn. */
      const owner = { who: 'you', text, at: replyAt, ...(pictures?.length ? { pictures } : {}) }
      transcript.push(owner)
      await announce('send', { sessionId: id, text, at: owner.at }, true)
      assertStartOwner()
      if (sessionId !== id) throw Object.assign(new Error('Session ended before send'), { code: 'MC_AGENT_SESSION_ENDED' })
      deliveryDisposition = 'unknown'
      const sent = await bridge.send({ sessionId: id, text, ...(turnImages.length ? { images: turnImages } : {}) })
      deliveryDisposition = sent?.deliveryDisposition || (sent?.ok === false ? 'unknown' : 'accepted')
      if (sent?.ok === false) throw Object.assign(new Error('Message delivery refused'), { code: sent.code || 'AGENT_SESSION_FAILED' })
      if (destroyed) return { ok: false, code: 'AGENT_SESSION_VIEW_CLOSED', sessionId: id, deliveryDisposition }
      /* send() accepting the turn and the child remaining alive are separate
         facts. A terminal event may run before this awaited receipt resumes;
         never repaint that dead session as a successful start. */
      if (sessionId !== id) return {
        ok: false,
        code: terminalCode || 'MC_AGENT_SESSION_ENDED',
        sessionId: id, deliveryDisposition,
      }
      if (working && sessionId === id) adoptTurn(sent?.turnId)
      if (sent?.turnId) owner.turnStamp = sent.turnId
      announce('state')
      /* A PICTURE THAT DID NOT GO TRAVELS WITH THE RECEIPT. The host answers
         `pictureNotSent` -- provider, file names, one plain sentence -- when the
         provider cannot carry the picture; this seam dropped it, so the Agent
         page had no way to say anything and the person read an answer that
         ignored their picture. Present only when there is something to say. */
      return { ok: true, sessionId: id, deliveryDisposition, turnId: sent?.turnId || null,
        ...(sent?.pictureNotSent ? { pictureNotSent: sent.pictureNotSent } : {}) }
    } catch (error) {
      /* An error message from the host can name a path. Report its code and a
         fixed sentence; never the message.

         READ THROUGH refusalCode() RATHER THAN OFF THE PROPERTY, because the
         property is gone by the time it gets here: Electron does not carry own
         properties across an IPC rejection, so this line used to resolve to
         AGENT_SESSION_FAILED for every refusal without exception -- which is
         the bare string a customer was shown. refusalCode() prefers
         `error.code` when it exists and otherwise recovers it from the message,
         accepting only values that are already keys of the copy table, so no
         text from the host can reach the DOM by that route. */
      const code = refusalCode(error)
      lastTurnStatus = 'failed'
      working = false
      /* Read BEFORE the cleanup below, which nulls sessionId on success -- read
         after, this could never be true and the refusal would never print.
         When it is false a concurrent stop already ended this start's session
         and painted its own truthful status, and the failure being caught here
         is that stop's consequence rather than news: bridge.send refusing a
         session that is closing is the expected shape, not a fault to report
         over the person's own successful Stop. */
      const stillOurs = sessionId === id
      const cleanup = sessionId && !error?.recoveryTransferPending ? await closeSession() : null
      /* A refused start can leave no host record to close. Once the host has
         confirmed that absence, retire the attempted id so the next composer
         send starts again. Any other cleanup refusal keeps its Stop target. */
      if (sessionId === id && cleanup?.code === 'MC_AGENT_UNKNOWN_SESSION') {
        sessionId = null
        resetLiveMetrics()
        announce('closed', { sessionId: id })
      }
      /* A HELD START WAITS AND ASKS AGAIN, IN THE OPEN. The person keeps their
         optimistic bubble because the message really is still going; the
         status says waiting rather than refused; and each attempt is named so
         the wait has a visible end. Stop still works -- it ends the surface,
         which is what cancels this. */
      if (!recovering && deliveryDisposition === 'not-sent' && !destroyed && stillOurs && HELD_START_CODES.has(code) && heldAttempt < HELD_START_WAITS_MS.length) {
        const waitMs = HELD_START_WAITS_MS[heldAttempt]
        const attempt = heldAttempt + 1
        actionState(status, 'pending', `waiting · ${readerSafeReason(code)}`)
        chat?.addNote?.(`${readerSafeReason(code)}. Trying again in ${Math.round(waitMs / 1000)} seconds — attempt ${attempt} of ${HELD_START_WAITS_MS.length}.`)
        const resumed = await new Promise(resolve => {
          heldStartRelease = resolve
          heldStartTimer = setTimeout(() => { heldStartRelease = null; heldStartTimer = null; resolve(true) }, waitMs)
        })
        if (!resumed || destroyed || stopping) return { ok: false, code, sessionId: id }
        /* The attempted session is closed; release its id so the guard above
           lets the next attempt through and a fresh one is minted. */
        sessionId = null
        assertStartOwner()
        return await startSession(text, { images, pastedImages, pictures, heldAttempt: attempt,
          openOnly, assertImageCurrent, recoveryStartOptions: retainedStartOptions,
          recoveryStartOwner: retainedStartOwner, imageStartIdentity })
      }
      if (!recovering && deliveryDisposition === 'not-sent' && !destroyed && stillOurs && HELD_START_CODES.has(code)) {
        /* The bound is reached. Say it plainly, and give the words back rather
           than leaving somebody to wonder whether they were sent. */
        chat?.addNote?.(`This computer is still too busy to start an agent, after ${HELD_START_WAITS_MS.length} tries over about ${heldStartTotalMinutes()} minutes. Your message was not sent — send it again when the computer is quieter.`)
      }
      if (!destroyed && stillOurs) actionState(status, 'refused', `refused · ${readerSafeReason(code)}`)
      return { ok: false, code: (!stillOurs && terminalCode) || code, sessionId: id, deliveryDisposition }
    } finally {
      starting = false
      sending = false
      if (!destroyed) setStarted(Boolean(sessionId))
      publish()
    }
  }

  /* Continue the SAME owned session. The Agent-page composer reaches this
     through the controller below, so it cannot create a second private session
     beside the one this surface publishes to the steering controls. */
  /* THE HOST IS ASKED BEFORE A LOCAL FLAG REFUSES A SEND.
   *
   * `working` is THIS WINDOW'S BELIEF, set on send and cleared by a terminal
   * packet. A packet that never arrives -- or that arrives while nothing is
   * listening -- leaves it true on a session the host finished long ago, and
   * every later send was then refused right here, with AGENT_TURN_ACTIVE,
   * without the host ever being asked.
   *
   * That is worse than an error, because nothing downstream treats it as one:
   * views/computers.js turns AGENT_TURN_ACTIVE into a durable outbox entry on
   * purpose ("the renderer's idle answer can lose to the host's active turn"),
   * and that outbox is drained by a turn COMPLETION. Words queued behind a
   * turn that is not running therefore wait for an event that can never come.
   * The identical failure is already named for the explicit /queue door in
   * fleet-tree-copy.js QUEUE_PANEL.cardQueuedIdle -- "Nothing was running to
   * wait behind, so it went now" -- and this is the same rule for the send path.
   *
   * sessionActivity() is the host's own answer. Its `busy` is computed from the
   * SAME five session terms as `turnActive` in shell/agent-host.cjs
   * (activeTurnId, sendPromise, turnAnnounce, rewindPending, interruptRequested),
   * so this reads one truth rather than inventing a second.
   *
   * UNKNOWN REFUSES. A bridge that cannot answer, an answer that is not ok, or
   * a closing session all keep the refusal this replaces: sending into a turn
   * that really is running is the worse of the two failures, so only an
   * explicit `busy === false` is allowed to clear the flag. */
  const hostTurnIsIdle = async (id) => {
    if (typeof bridge?.sessionActivity !== 'function') return false
    let activity = null
    try { activity = await bridge.sessionActivity({ sessionId: id }) } catch { return false }
    if (!activity || activity.ok !== true) return false
    if (activity.closing === true) return false
    return activity.busy === false
  }

  /* THE SELF-HEAL, IN ONE PLACE. Reached whenever the host says this session
     is idle while this window still believes a turn is open: drop the flag,
     close the bubble the missing completion left open, and repaint. One
     function rather than a second inline copy, so the send path and any later
     host-status reader cannot drift into two ideas of "idle again".
     `lastTurnStatus` is deliberately NOT set: the previous turn's real outcome
     is exactly what this window does not know, and inventing one would put a
     word on screen that no packet ever said. */
  const clearStaleTurn = () => {
    working = false
    activeTurnId = null
    activeStep = ''
    if (chatComposer) {
      relay.flushNow()
      finishReply()
    }
    if (turnStream) { turnStream.close(relay.text); turnStream = null }
    publish()
  }

  const continueSession = async (text, { images = null, pastedImages = null, pictures = null } = {}) => {
    if (placementLocked) return placementRefusal()
    if (!sessionId || starting || stopping || destroyed || !ready) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
    if (sessionOwnerContext && !imageOwner.isCurrent(sessionOwnerContext)) return { ok: false, code: 'IMAGE_OWNER_CHANGED' }
    if (working) {
      /* Asked live, not from the flag alone. The id is pinned across the await
         and re-checked after it, the way every other awaited boundary in this
         file does, so an answer about the previous session can never clear the
         state of a new one. */
      const priorId = sessionId
      const idle = await hostTurnIsIdle(priorId)
      if (destroyed || sessionId !== priorId) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
      if (!idle) return { ok: false, code: 'AGENT_TURN_ACTIVE' }
      clearStaleTurn()
    }
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, code: 'AGENT_SESSION_NO_PROMPT' }
    retireApprovals(sessionId)
    const id = sessionId
    let deliveryDisposition = 'not-sent'
    sending = true
    lastPrompt = text
    lastTurnStatus = null
    working = true
    activeTurnId = null
    activeStep = ''
    if (chatComposer) relay.reset()
    replyAt = Date.now()
    turnStream = chat.openStream({ at: replyAt })
    if (chatComposer) notifyChatStatus()
    publish()
    actionState(status, 'ready', 'running - session open')
    try {
      if (endedRecovery) await finishEndedRecovery(endedRecovery, id)
      /* Same rule as the start above: the field exists only when a picture
         really rides this turn. */
      const turnImages = Array.isArray(images) ? [...images] : []
      if (pastedImages?.length) turnImages.push(...await savePastedImages(id, pastedImages))
      /* Same rule as the start path above; see its note. */
      const owner = { who: 'you', text, at: replyAt, ...(pictures?.length ? { pictures } : {}) }
      transcript.push(owner)
      await announce('send', { sessionId: id, text, at: owner.at }, true)
      deliveryDisposition = 'unknown'
      const sent = await bridge.send({ sessionId: id, text, ...(turnImages.length ? { images: turnImages } : {}) })
      deliveryDisposition = sent?.deliveryDisposition || (sent?.ok === false ? 'unknown' : 'accepted')
      if (sent?.ok === false) throw Object.assign(new Error('Message delivery refused'), { code: sent.code || 'AGENT_SESSION_FAILED' })
      if (destroyed) return { ok: false, code: 'AGENT_SESSION_VIEW_CLOSED', sessionId: id, deliveryDisposition }
      if (sessionId !== id) return {
        ok: false,
        code: terminalCode || 'MC_AGENT_SESSION_ENDED',
        sessionId: id, deliveryDisposition,
      }
      if (working && sessionId === id) adoptTurn(sent?.turnId)
      if (sent?.turnId) owner.turnStamp = sent.turnId
      announce('state')
      /* A PICTURE THAT DID NOT GO TRAVELS WITH THE RECEIPT. The host answers
         `pictureNotSent` -- provider, file names, one plain sentence -- when the
         provider cannot carry the picture; this seam dropped it, so the Agent
         page had no way to say anything and the person read an answer that
         ignored their picture. Present only when there is something to say. */
      return { ok: true, sessionId: id, deliveryDisposition, turnId: sent?.turnId || null,
        ...(sent?.pictureNotSent ? { pictureNotSent: sent.pictureNotSent } : {}) }
    } catch (error) {
      const code = sessionId !== id && terminalCode ? terminalCode : refusalCode(error)
      if (sessionId === id) {
        lastTurnStatus = 'failed'
        working = false
        relay.flushNow()
        finishReply()
        if (turnStream) { turnStream.close(relay.text); turnStream = null }
        publish()
        if (!destroyed) actionState(status, 'refused', `refused - ${readerSafeReason(code)}`)
      }
      return { ok: false, code, sessionId: id, deliveryDisposition }
    } finally { sending = false }
  }

  /* CTRL+V AT THE PROMPT. This surface is the whole of the home page's live
     chat -- its transcript panel is composerReason-gated and has no composer
     of its own -- so without this a person on that page could paste a picture
     and have absolutely nothing happen. It cannot save at paste time the way
     the composer does: there is no session yet, which is the entire situation.
     So the bytes wait here and the first start spends them.

     Offered only when this build can really save a paste, so no half-working
     control appears; without it the event is left alone and the browser's own
     paste into the box is untouched. */
  if (typeof bridge?.pasteAttachment === 'function') {
    prompt.addEventListener('paste', async (event) => {
      if (destroyed) return
      const pasted = pastedImageFromClipboard(event.clipboardData)
      if (!pasted) return
      /* A picture has no useful text form in this box, so claiming the event
         loses nothing an ordinary paste would have kept. */
      event.preventDefault()
      if (!pasted.file) return
      let data
      try { data = arrayBufferToBase64(await pasted.file.arrayBuffer()) } catch { data = null }
      if (destroyed) return
      if (!data) { actionState(output, 'note', PASTE_HELD_LOST); return }
      heldPasteImage = { data, mime: pasted.mime }
      actionState(output, 'note', PASTE_HELD_NOTE)
    })
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void startSession(String(prompt.value || '').trim())
  })

  const stopSession = async () => {
    if (switchPending()) return { ok: false, code: 'AGENT_SWITCH_PENDING' }
    if (placementLocked) return placementRefusal()
    if (!sessionId) return { ok: false, code: 'AGENT_SESSION_UNKNOWN' }
    stopButton.disabled = true
    actionState(status, 'pending', 'stopping…')
    /* THE PENDING INDICATOR MUST NOT OUTLIVE THE ATTEMPT THAT SET IT.
       Stop is disabled and the status reads "stopping" from the two lines
       above until this settles, and the click handler below runs this as
       `void stopSession()` -- so a rejection here is observed by nobody and
       the panel keeps a disabled Stop over a permanent "stopping".

       HONEST STATUS OF THIS GUARD: no reachable throw is known today.
       closeSession() wraps both bridge calls and returns {ok, code} on every
       branch, and publish() cannot throw either -- agent-session-registry.js
       calls each subscriber in its own try ("one bad subscriber is not
       everyone's problem") and wraps its DOM dispatch. An earlier draft of
       this comment claimed a throwing subscriber as the trigger; that was
       measured false and is corrected here rather than left as a plausible
       story. What remains unguarded is closeSession()'s tail --
       resetLiveMetrics(), relay.flushNow() and turnStream.close() all run
       after the close has already succeeded and outside any try.

       So this catch is cheap insurance on a control whose failure mode has no
       recovery for the person, not a fix for a reproduced fault. It is worth
       having because the cost of being wrong is asymmetric: a caught throw
       costs one refusal sentence, an uncaught one costs the only Stop the
       person has. The close itself is real and is not undone here; only the
       controls are handed back. */
    let closed
    try {
      closed = await closeSession()
    } catch (error) {
      if (destroyed) return { ok: false, code: refusalCode(error) }
      setStarted(true)
      actionState(status, 'refused', `refused - ${readerSafeReason(refusalCode(error))}`)
      return { ok: false, code: refusalCode(error) }
    }
    if (destroyed) return closed
    if (!closed.ok) {
      setStarted(true)
      actionState(status, 'refused', `refused · ${readerSafeReason(closed.code)}`)
      return closed
    }
    /* The OS-exit event already set the terminal copy and disabled the live
       controls. A close racing that event is successful as teardown, but it
       must not erase the reason this session ended. */
    if (closed.ended) {
      setStarted(false)
      return closed
    }
    setStarted(false)
    actionState(status, ready ? 'ready' : 'unavailable', 'stopped · session closed')
    return closed
  }
  stopButton.addEventListener('click', () => { void stopSession() })

  /* THE THREE STEERING ACTIONS, owned here because the session is owned here.
     Each returns {ok, code} rather than throwing: the Controls panel renders a
     refusal, and a rejected promise crossing a module boundary is how a control
     ends up reporting success for something that did not happen. */
  const imageComposer = () => typeof getImageComposer === 'function' ? getImageComposer() : chatComposer ? chat : null
  const preserveSwitchDraft = async (record, current) => {
    const composer = imageComposer()
    if (!record.draftCapture && !composer?.exportDraft?.()?.attachments?.length) return { ok: true }
    if (!composer?.captureDraft || !composer?.attachRetainedDraft) {
      return { ok: false, code: 'IMAGE_QUEUE_DRAFT_PREPARATION_UNAVAILABLE', retained: true }
    }
    if (!record.draftCapture) {
      const capture = composer.captureDraft()
      if (!capture) return { ok: false, code: 'IMAGE_QUEUE_DRAFT_CHANGED', retained: true }
      // Renderer-only paste tokens have no source-issued custody capability.
      if (capture.attachments.some(image => pendingPastes.has(image.path))) {
        return { ok: false, code: 'IMAGE_QUEUE_DRAFT_PREPARATION_UNAVAILABLE', retained: true }
      }
      record.draftCapture = capture
      record.draftComposer = composer
      record.draftOperationId = crypto.randomUUID()
    }
    if (record.draftComposer !== composer) {
      return { ok: false, code: 'IMAGE_QUEUE_DRAFT_CHANGED', retained: true }
    }
    if (!record.retainedDraft) {
      const capture = record.draftCapture
      const retained = await record.conversation.prepareRetainedImages({
        operationId: record.draftOperationId, draftId: capture.draftId,
        revision: capture.revision, text: capture.text, images: capture.attachments,
        ...(capture.retainedDraft ? { retainedDraft: capture.retainedDraft } : {}),
      })
      if (!current()) {
        composer.invalidateDraftAuthority?.('IMAGE_OWNER_CHANGED')
        return { ok: false, code: 'IMAGE_OWNER_CHANGED', retained: true, detached: true }
      }
      if (!retained?.ok || retained.detached || !retained.retainedDraft) {
        return { ok: false, code: retained?.code || 'IMAGE_QUEUE_DRAFT_PREPARATION_UNAVAILABLE', retained: true }
      }
      record.retainedDraft = retained.retainedDraft
    }
    return composer.attachRetainedDraft(record.draftCapture, record.retainedDraft)
      ? { ok: true } : { ok: false, code: 'IMAGE_QUEUE_DRAFT_CHANGED', retained: true }
  }
  const switchDraftCurrent = record => !record.draftCapture
    ? !imageComposer()?.exportDraft?.()?.attachments?.length
    : record.draftComposer === imageComposer()
      && record.draftComposer.attachRetainedDraft(record.draftCapture, record.retainedDraft)

  const confirmReplacementBinding = async record => {
    const receipt = record.adoptedReceipt
    const current = () => !destroyed && sessionSwitch === record
      && sessionId === receipt.sessionId && imageOwner.isCurrent(record.ownerContext)
    let result
    try {
      result = await announce('replaced', {
        sourceSessionId: record.sourceId, sessionId: receipt.sessionId, receipt,
        bindingContext: Object.freeze({ ownerContext: record.ownerContext, isCurrent: current }),
      }, true)
    } catch (error) {
      return { ...receipt, ok: false, code: error?.code || 'AGENT_SWITCH_BINDING_UNCONFIRMED', reconcile: true }
    }
    if (!current()) return { ...receipt, ok: false, code: 'IMAGE_OWNER_CHANGED', reconcile: true, detached: true }
    if (result?.ok === false) return { ...receipt, ok: false, code: result.code || 'AGENT_SWITCH_BINDING_UNCONFIRMED', reconcile: true }
    record.finished = true
    record.outcome = { ...receipt, operationId: record.operationId, ok: true }
    try { onSessionOpen?.(receipt.sessionId) } catch { record.outcome.publicationError = 'AGENT_SWITCH_PUBLICATION_FAILED' }
    publish()
    actionState(status, 'ready', 'The session changed. Queued images can continue.')
    return record.outcome
  }

  // Keep the source controller and its captured owner alive until both the
  // host replacement receipt and durable destination reconciliation agree.
  const switchSession = async request => {
    const operation = request?.operation
    const operationId = request?.operationId
    if (!['prepare', 'commit', 'cancel', 'status'].includes(operation)
      || typeof operationId !== 'string' || !operationId) {
      return { ok: false, code: 'AGENT_SWITCH_INVALID' }
    }
    if (destroyed || typeof bridge?.switchSession !== 'function') return { ok: false, code: 'AGENT_SWITCH_UNAVAILABLE' }
    let record = sessionSwitch
    if (operation === 'prepare' && (!record || record.finished && record.operationId !== operationId)) {
      if (!sessionId || starting || stopping || sending || steering || imagePreparing || placementLocked) {
        return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
      }
      const conversation = currentImageConversation()
      if (!conversation) return { ok: false, code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' }
      conversation.hold()
      const sourceId = sessionId
      const ownerContext = imageOwner.capture()
      if (!ownerContext) { conversation.releaseHold(); return { ok: false, code: 'IMAGE_OWNER_UNAVAILABLE' } }
      record = { sourceId, operationId, conversation, ownerContext, candidateId: null,
        transferOperationId: crypto.randomUUID(), transferView: null, finished: false,
        request: { operation: 'prepare', sessionId: sourceId, operationId, tier: request.tier,
          ...(Object.hasOwn(request, 'effort') ? { effort: request.effort } : {}),
          ...(Object.hasOwn(request, 'account') ? { account: structuredClone(request.account) } : {}) } }
      sessionSwitch = record
      actionState(status, 'pending', 'The session change is pending. Images remain held.')
    }
    if (!record || record.operationId !== operationId) return { ok: false, code: 'AGENT_SWITCH_UNKNOWN' }
    if (record.finished) return imageOwner.isCurrent(record.ownerContext)
      ? record.outcome : { ok: false, code: 'IMAGE_OWNER_CHANGED', detached: true }
    if (record.flight) return { ok: false, code: 'AGENT_SWITCH_BUSY', operationId }
    const current = () => !destroyed && sessionId === (record.adoptedReceipt?.sessionId || record.sourceId)
      && sessionSwitch === record && imageOwner.isCurrent(record.ownerContext)
    if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', operationId, reconcile: true }
    record.flight = true
    steering++
    try {
      if (record.adoptedReceipt) return await confirmReplacementBinding(record)
      if (operation === 'prepare' || operation === 'commit') {
        const preserved = await preserveSwitchDraft(record, current)
        if (!preserved.ok) return { ...preserved, operationId }
      }
      if (operation === 'prepare') {
        if (request.tier !== record.request.tier
          || JSON.stringify(request.account) !== JSON.stringify(record.request.account)
          || request.effort !== record.request.effort) return { ok: false, code: 'AGENT_SWITCH_CONFLICT', operationId }
        const view = await record.conversation.refresh()
        if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', operationId, reconcile: true }
        if (view?.state !== 'ready' || !view.authority) return { ok: false, code: view?.code || 'IMAGE_QUEUE_NOT_READY', operationId }
      }
      if (operation === 'commit') {
        const latest = await record.conversation.refresh()
        if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', operationId, reconcile: true }
        const validView = view => view?.state === 'ready' && !view.code && Array.isArray(view.entries)
          && view.authority?.ownerId === record.ownerContext.ownerId
          && view.authority?.currentEpoch === record.ownerContext.currentEpoch
          && view.authority?.sessionId === record.sourceId
          && typeof view.authority?.conversationId === 'string' && view.authority.conversationId.length > 0
          && (view.generation === null || (typeof view.generation === 'string' && view.generation.length > 0))
          && view.authority.generation === view.generation
          && (view.destinationSessionId === null || view.destinationSessionId === record.sourceId)
        if (!validView(latest) || (record.transferView && !validView(record.transferView))) {
          return { ok: false, code: 'IMAGE_QUEUE_NOT_READY', operationId, reconcile: true }
        }
        if (record.transferView && (record.transferView.authority.conversationId !== latest.authority.conversationId
          || record.transferView.generation !== latest.generation
          || record.transferView.destinationSessionId !== latest.destinationSessionId)) {
          return { ok: false, code: 'IMAGE_QUEUE_TRANSFER_STALE', operationId, reconcile: true }
        }
        // A failed read never becomes a latch. Once captured, the generation
        // stays immutable even if a later retry observes a newer queue.
        if (!record.transferView) record.transferView = structuredClone(latest)
      }
      if ((operation === 'prepare' || operation === 'commit') && !switchDraftCurrent(record)) {
        return { ok: false, code: 'IMAGE_QUEUE_DRAFT_CHANGED', operationId, retained: true }
      }
      let result = await bridge.switchSession(operation === 'prepare' ? record.request
        : { operation, operationId, sessionId: record.sourceId })
      if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', operationId, reconcile: true }
      if (result?.operationId !== operationId) return { ok: false, code: 'AGENT_SWITCH_RECEIPT_INVALID', operationId, reconcile: true }
      if (operation === 'prepare') {
        if (result.phase !== 'prepared' || result.applied !== false || result.sourceSessionId !== record.sourceId
          || typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId === record.sourceId) {
          return { ok: false, code: result.code || 'AGENT_SWITCH_RECEIPT_INVALID', operationId, reconcile: true }
        }
        record.candidateId = result.sessionId
        actionState(status, 'pending', 'The replacement is ready. Images remain held until the change is confirmed.')
        return { ...result, ok: true }
      }
      const receipt = result.receipt || result
      if (receipt.applied === true) {
        if (receipt.sourceSessionId !== record.sourceId || receipt.sessionId !== record.candidateId
          || receipt.attachmentsTransferred !== true || !Number.isSafeInteger(receipt.attachmentCount)
          || receipt.attachmentCount < 0 || typeof receipt.provider !== 'string'
          || typeof receipt.tier !== 'string' || !Object.hasOwn(receipt, 'effort')
          || !Object.hasOwn(receipt, 'revision') || !receipt.historyLink) {
          return { ok: false, code: 'AGENT_SWITCH_RECEIPT_INVALID', operationId, reconcile: true }
        }
        // Capture the current source view once per immutable transfer intent.
        // A retry must not silently refresh the CAS and become a new mutation.
        if (!record.transferView) return { ok: false, code: 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED', operationId, reconcile: true }
        if (!current()) return { ok: false, code: 'IMAGE_OWNER_CHANGED', operationId, reconcile: true }
        const transferred = await record.conversation.transferDestination({
          destinationSessionId: receipt.sessionId, view: record.transferView,
          operationId: record.transferOperationId,
        })
        if (!current() || transferred?.ok !== true || transferred.reconciled !== true || transferred.detached
          || transferred.currentSnapshot?.destinationSessionId !== receipt.sessionId
          || transferred.currentSnapshot?.writeBlocked
          || typeof transferred.currentSnapshot?.generation !== 'string') {
          return { ok: false, code: transferred?.code || 'IMAGE_QUEUE_TRANSFER_UNCONFIRMED', operationId, reconcile: true }
        }
        releaseImageConversation()
        sessionId = receipt.sessionId
        threadId = receipt.threadId ?? null
        account = receipt.account ?? null
        working = false
        terminalCode = null
        try { outboxMoveSession(record.sourceId, sessionId) } catch { /* The durable image destination is already verified. */ }
        record.adoptedReceipt = { ...receipt, operationId }
        currentImageConversation()
        return await confirmReplacementBinding(record)
      }
      if (result.applied === false && result.phase === 'cancelled'
        && result.sourceDisposition === 'retained' && !record.sourceEnded) {
        record.finished = true
        record.outcome = { ...result, ok: true }
        record.conversation.releaseHold()
        actionState(status, 'ready', 'The session change was cancelled. The original session remains open.')
        return record.outcome
      }
      return { ...result, ok: false, code: result.code || 'AGENT_SWITCH_PENDING', reconcile: true }
    } catch (error) {
      return { ok: false, code: error?.code || 'AGENT_SWITCH_UNCONFIRMED', operationId, reconcile: true }
    } finally {
      steering--
      record.flight = false
      if (!destroyed && !record.finished) actionState(status, 'pending', 'The session change is not complete. Images remain held.')
      if (record.finished && !destroyed) {
        notifyChatStatus()
        void imageConversation?.signalReady()
      }
    }
  }

  control = Object.freeze({
    snapshot,
    switchSession,
    submitImageIntent,
    pasteImage,
    imageOutbox,
    exportDraft: () => {
      const draft = chat?.exportDraft?.() ?? null
      // The composer clears on Send before native startup and transcript binding
      // finish. Preserve those unsent words if the tab closes during that wait.
      // Once startup finishes, delivery can be uncertain and is never a draft.
      if (starting && pendingComposerStart && draft && !draft.text && !draft.attachments?.length) {
        return { ...pendingComposerStart, attachments: pendingComposerStart.attachments.slice() }
      }
      return draft
    },
    setTitle(value) {
      if (destroyed || typeof value !== 'string' || !value.trim()) return
      chatTitle = value.trim()
      const title = chat?.querySelector('.chat-head .t')
      if (title) title.textContent = chatTitle
      if (chatComposer) {
        const input = chat?.querySelector('.chat-input input')
        input?.setAttribute('placeholder', messagePlaceholder(chatTitle))
        input?.setAttribute('aria-label', messageAriaLabel(chatTitle))
      }
    },
    beginPlacement() {
      if (destroyed || placementLocked || starting || stopping || sending || steering || imagePreparing || switchPending()) return { ok: false, sentence: 'Wait for the current session operation to finish before placing this agent.' }
      placementLocked = true; surface.inert = true; setStarted(Boolean(sessionId))
      return { ok: true, snapshot: snapshot() }
    },
    cancelPlacement() { placementLocked = false; surface.inert = false; if (!destroyed) setStarted(Boolean(sessionId)) },
    /* Stops the running TURN. The session stays open, so the transcript, the
       Stop control and the record all stay exactly where they were. */
    async pause() {
      if (switchPending()) return { ok: false, code: 'AGENT_SWITCH_PENDING' }
      if (placementLocked) return placementRefusal()
      if (!sessionId) return terminalCode
        ? { ok: false, code: terminalCode }
        : { ok: false, code: 'AGENT_TURN_NONE' }
      if (!working) return { ok: false, code: 'AGENT_TURN_NONE' }
      const id = sessionId
      steering++
      try {
        await bridge.interrupt({ sessionId: id })
      } catch (error) {
        const code = refusalCode(error)
        if (!destroyed) actionState(status, 'refused', `refused · ${readerSafeReason(code)}`)
        return { ok: false, code }
      } finally { steering-- }
      if (destroyed || sessionId !== id) return { ok: true }
      /* Set here rather than waited for. The host may or may not emit a turn
         status for an interrupted turn, and a control whose effect is only
         visible if an optional event arrives is a control that intermittently
         appears to do nothing. The event handler sets the same flag the same
         way if it does arrive. */
      working = false
      lastTurnStatus = 'interrupted'
      retireApprovals(id, { keepAnswering: true })
      if (chatComposer) {
        relay.flushNow()
        finishReply()
        if (turnStream) { turnStream.close(relay.text); turnStream = null }
      }
      resetLiveMetrics()
      publish()
      actionState(status, 'ready', 'stopped · turn interrupted · session still open')
      return { ok: true }
    },
    async terminate() {
      if (switchPending()) return { ok: false, code: 'AGENT_SWITCH_PENDING' }
      if (placementLocked) return placementRefusal()
      if (!sessionId) return terminalCode
        ? { ok: false, code: terminalCode }
        : { ok: false, code: 'AGENT_SESSION_UNKNOWN' }
      return stopSession()
    },
    /* Close, then start the same work again in a new child process. The two
       halves are reported separately: a respawn whose close succeeded and whose
       start failed has ENDED the session, and saying "respawned" over that
       would be the product describing a state it is not in. */
    async respawn() {
      if (switchPending()) return { ok: false, code: 'AGENT_SWITCH_PENDING' }
      if (placementLocked) return placementRefusal()
      steering++
      try {
      if (!sessionId) return terminalCode
        ? { ok: false, code: terminalCode }
        : { ok: false, code: 'AGENT_SESSION_UNKNOWN' }
      /* THE WORDS, NOT THE PICTURE. `lastPrompt` is text, and this call passes
         no images on purpose: respawn is "this work again, in a new process",
         and re-uploading a picture the person attached to one turn into a
         child process they never attached it to is a decision, not a default.
         tools/test/agent-page-paste-send.test.mjs holds this. */
      const text = lastPrompt
      const carriedPicture = lastTurnCarriedPicture
      const stopped = await stopSession()
      if (!stopped.ok) return stopped
      if (destroyed) return { ok: false, code: 'AGENT_SESSION_VIEW_CLOSED' }
      if (!text) return { ok: false, code: 'AGENT_SESSION_NO_PROMPT' }
      if (chatComposer) {
        mountChat()
        transcript = []
        chat.addOwnerMessage(text)
      }
      const restarted = await startSession(text)
      /* Said AFTER the replay, and only when the turn being replayed really
         carried a picture. The words went again; the picture did not, and a
         person who is not told that reads the second answer as the agent
         ignoring an image it was never given. */
      if (carriedPicture && !destroyed) actionState(output, 'note', RESPAWN_WITHOUT_PICTURE)
      return restarted
      } finally { steering-- }
    },
    /* The composer's own send. `options` carries what rides the turn beside
       the words -- today `images`, the paths of pictures the person pasted --
       and it is forwarded WHOLE to whichever half runs, so the first message
       of a session and every later one behave the same way. Respawn above
       deliberately does not use this door. */
    async send(text, options = {}) {
      if (imagePreparing || switchPending()) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
      return sessionId ? continueSession(text, options) : startSession(text, options)
    },
  })
  const removeQueueReady = sessionChatStatus.subscribe(() => { void drainQueue() })
  if (typeof onController === 'function') {
    try { onController(control) } catch { /* the mounted surface remains the lifecycle owner */ }
  }

  return () => {
    retireApprovals(sessionId)
    resetLiveMetrics()
    destroyed = true
    removeQueueReady()
    releaseImageConversation()
    imageOwner.dispose()
    cancelHeldStart()
    /* A LOCAL QUEUE NOBODY WILL EVER DRAIN IS RUBBISH, NOT A RECORD. If this
       surface never started a session, its pre-session key names words that no
       session will ever be able to send; the outbox persists, so leaving it
       would accumulate under a key nothing can reach. A key that WAS moved
       belongs to a real session now and is left exactly alone. */
    if (!queueKeyMoved) {
      try { outboxClearSession(localQueueKey) } catch { /* nothing was ever written under it */ }
    }
    /* A scheduled frame outlives the element it would write into, so it is
       cancelled here rather than left to fire against a detached surface. */
    relay.dispose()
    sessionTextReader.clear()
    if (unsubscribe) unsubscribe()
    if (!retainSessionOnDispose() && !switchPending()) void closeSession()
    /* The record goes with the surface. A stale record would leave the Controls
       panel offering Terminate for a session whose owner has navigated away --
       and closeSession() above is asynchronous, so waiting for it to publish
       would leave a window in which exactly that is true. */
    if (publishSession) publishLiveSession(null)
    pendingPastes.clear()
    if (typeof onController === 'function') {
      try { onController(null) } catch { /* disposal continues */ }
    }
    compareFiles.close()
    /* buildChat wires a ResizeObserver, a MutationObserver and a document.fonts
       listener per mount; nothing else in this file releases them, so a
       rebuilt agent page and its predecessor would both keep listening
       without this. */
    chat.dispose?.()
    surface.remove()
  }
}
