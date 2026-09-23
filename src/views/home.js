import { mountChatReading } from '../home-chat-reading.js'
import { createHomeComposerDraftStore } from '../home-chat-composer-draft.js'
import { createHomeAgentWorkspacePool } from '../home-agent-workspace.js'
import { mountHomeChatLayout } from '../home-chat-layout.js'
import { ROLES } from '../vocab.js'
import { ROSTER, ACTIVITY_FILTERS, ACTIVITY_LABELS, ACTIVITY_MARKS, activityContext, activityDisclosure, activityMatches, activityPreview, treePickGroups, treePickChoices, TREE_PICK, agentBoardLines, agentMonogram, AGENT_BOARD } from '../home-activity.js'
import { HOME_CIRCLE_STYLE_EVENT, currentHomeCircleStyle, HOME_CIRCLE_MOTION_EVENT, currentHomeCircleMotion } from '../home-circle-choice.js'
import { homeLedgerStatus, readHomeLedger, ledgerStatusHref } from '../home-ledger-status.js'
import { mountHomeStatusColors } from '../home-status-colors.js'
import { subscribeAutonomousContinuationStatus } from './computers.js'
import { sampleLedgerData } from '../sample-ledger.js'
import { exampleOwnerPrompts } from '../approvals-example.js'
// /home — the hero ring and, beside it, what is actually happening.
//
// WHAT CHANGED AND WHY, because the previous version of this file argued at
// length for a design that did not survive contact with an installed copy.
//
// It assumed the interesting thing on this screen is a FLEET: other computers,
// a coordinator running on one of them, and a health sweep across all of them.
// On the machine of someone who has just installed this product none of that
// exists, and the screen degraded into five separate notices about the absence
// of a thing that person never had -- a clock reading four dashes, "SOURCE
// UNAVAILABLE", "coordinator thread unavailable", and "No local agent fleet
// host detected on this machine" printed twice -- directly above a banner
// saying "ToolsEnabled already works on this one computer". Those last two
// cannot both be acted on. It was the product's first impression.
//
// The premise was wrong, not the implementation. There IS something real to
// show on one computer with nothing connected: the agents that have run on it.
// Starting an agent from inside ToolsEnabled works now, and every start is
// written to this app's own signed record before the process exists. So home
// reads that record, and a machine with no fleet gets its own history rather
// than a fleet-shaped hole.
//
// THE DIVISION OF LABOUR IN THIS FILE. src/local-activity.js decides WHAT the
// screen says -- one pure function, one flat list of sentences, walked
// exhaustively by tools/test/home-screen.test.mjs to prove the screen can never
// again contradict or repeat itself. This file only renders that decision and
// wires the sources that feed it. Copy does not live here; if a sentence needs
// changing, it changes there, where the test can see it.
//
// WHAT IS STILL SIMULATED, AND SAID SO. The labelled demonstration is still
// reachable from Settings and is the only thing on the screen that carries a
// badge. It never appears unless a person asked for it: an earlier version
// showed a header reading "SESSION - SAMPLE TRANSCRIPT" beside a badge reading
// "LIVE SOURCE" on a live screen, which is the same defect in miniature.
//
// ONE CARD, NOT TWO. The demonstration used to have a renderer of its own -- a
// written coordinator transcript with timed arrivals and a composer that faked
// replies -- beside the live list of runs. The owner, with both on screen: make
// the live one "the foundation, and try to add more context to it. And
// collapse the context and such as it goes like we do in chat." So there is one
// list of runs for every source; each row folds open to what was asked, the
// lines between, and what was said back; and the example feeds that same list
// with a record and conversations of its own (src/sample-activity.js) instead
// of a second screen.

import { el, uptimeRing, openMemory, ownDisclosure, buildChat } from '../components.js'
import { createCoordinatorFeed, createCoordinatorSender, toHistory } from '../home-coordinator-chat.js'
import { attachPersistentVoice } from '../voice-coordinator.js'
import { UPTIME_UNITS } from '../chat-copy.js'
import { onNextFrame } from '../page-frames.js'
import { textZoom } from '../text-size.js'
import { fetchStatus, fetchCoordinator } from '../live-status.js'
import { ownerPromptSnapshot } from '../mission-bridge.js'
/* WHEN AN IDLE SCREEN SHOULD ASK AGAIN, and how its polls stay out of phase
   with one another. Values, in their own module, so the cadence can be checked
   by calling it rather than by mounting this view and waiting. */
import {
  APPROVALS_POLL_MS,
  approvalsReadingChanged,
  nextApprovalsWaitMs,
  pollPhaseOffsetMs,
} from '../idle-cadence.js'
/* A decision the owner made on #/approvals whose answer arrived after he had
   already left that screen. The approvals design nominated this screen as its
   one signal channel ("the only signal that anything is waiting is a count on
   the home view's existing readouts"), so it is also the screen that has to
   carry the case where a decision he made did not land. */
import {
  APPROVAL_OUTCOME_EVENT,
  reconcileUndeliveredDecisions,
  undeliveredDecisionCount,
} from '../approval-outcomes.js'
import { isExampleMode, currentDataSource, resolveDataSource, announceDataSourceChange } from '../data-source.js'
/* THE FIRST SCREEN, AND UNTIL NOW THE ONLY ONE OF THE FOUR IN THE EMPTY-STATE
   RING WITH NO READ OF readerRemedy AT ALL. src/local-activity.js's
   ENGINE_REASON carries the same Codex install/sign-in instructions
   src/refusal-copy.js already knows how to re-read for a remote driver --
   "Run \"winget install OpenAI.Codex\" in Windows Terminal" among them -- and
   this view rendered `fact.text` straight to the DOM with no translation at
   all, on the page every install lands on first. */
import { readerRemedy } from '../refusal-copy.js'
import { isPlainVoice } from '../chat-markdown.js'
import { setChatMessageBody, addChatMessageCopy } from '../chat-message-body.js'
/* WHO SPOKE, and WHETHER THE TURN IS A WALL. renderChatVoice above settled
   which renderer a turn's body gets by taking its CLASS; these two settle what
   decides that class when the profile names no voice for the id, and when one
   turn is long enough to bury the conversation under it. Held in their own
   module for the reason src/home-chat-takeover.js is: they are the parts a
   test can hold without a DOM. */
import { turnFold, turnSpeaker } from '../home-turns.js'
import { isWriteEnabled } from '../write-flags.js'
import { bridgeStatus, postBridgeAction } from '../mission-bridge.js'
import { FLEET, isSampleFleet } from '../fleet-profile.js'
import {
  COPY,
  HOME_MODES,
  describeHome,
  describeRun,
  readAgentEngine,
  readLocalSessions,
  summariseRunWork,
} from '../local-activity.js'
/* One reading of "is anybody signed in", beside the rest of the availability
   vocabulary, so this screen and the setup review cannot drift apart on it. */
import { providerSignInReading } from '../agent-availability-copy.js'
/* THE CONVERSATIONS THIS COMPUTER ALREADY SAVED, read so a run can say which
   agent it was, what it was asked and what it said back. Nothing new is written
   and nothing new is recorded: the trees a person builds on the computers page
   are kept on this machine, keyed by session, and the signed run record carries
   the same key. This screen only joins the two.

   THIS USED TO BE A PRIVATE COPY INSIDE THIS FILE, and that is the whole reason
   it is an import now. src/session-roles.js was extracted from this view's own
   savedConversations() for the metrics page, nine hours after this screen
   shipped its own, and this screen was never switched over. Two byte-identical
   readers of one record is one widening away from a silent divergence, and the
   widening arrived: the owner asked this list to show what each agent SAID, the
   field was already on the node, and adding it to one reader would have left
   the other blind. There is one reader now and this is it. */
import { readSessionRoles } from '../session-roles.js'
/* WHAT EACH RUN ACTUALLY DID, from the per-turn record this app already keeps
   (shell/usage-record.cjs writes one signed line per turn). Read through the
   reader the metrics page already uses, for exactly the reason above: a second
   parser of that record here would be a second opinion about it. */
import { readLocalUsage } from '../local-metrics.js'
/* THE THREE READERS THE AGENT EVENT STREAM IS ALLOWED TO BE READ THROUGH. Every
   surface that listens to a live session uses this same set, and it is a set
   rather than one function because a turn's words, a turn's identity and a
   turn's ending are three separate facts and this row shows all three. */
import {
  createSessionTextReader,
  sessionEventTurnId,
  sessionTurnStatus,
  sessionActivityEvent,
  sessionEndedEvent,
  sessionTurnFailureText,
  completionSettlesOpenTurn,
} from '../agent-session-events.js'
/* THE EXAMPLE'S OWN RECORD, CONVERSATIONS AND TURN FIGURES, so the demonstration
   goes through every join a real machine does and this file holds no second
   renderer for it. Substitution, not suppression: the reasoning is at the top
   of src/sample-activity.js. */
import { sampleConversations, sampleSessionsRaw } from '../sample-activity.js'
import { sampleUsageRaw } from '../sample-usage.js'
import { sampleAgentTreeRecords, sampleAgentsData } from '../sample-fleet.js'
import { paintRoleColor } from '../role-colors.js'
/* The two controls on the settings page that decide what this box contains:
   which agents' context appears in it, and whether agent runs appear too, not
   at all, or on their own. The view reads them and re-reads them on the event,
   exactly as it does the live-source flags above. */
import {
  CHATBOX_FEED_EVENT,
  agentIdsFromTurns,
  filterTurns,
  readAgentSelection,
  readRunsMode,
} from '../chatbox-feed.js'
/* The full-page chat: its roster, its scope test and its one-mount rule live
   in their own module because those are the parts a test can hold without a
   DOM. This view supplies the DOM and its own painter; that module never
   draws a turn. See its header for the three rules it exists to keep. */
import {
  TAKEOVER_COPY,
  buildSubjectChoices,
  defaultSubjectId,
  subjectMatchesTurn,
  takeoverFocusStops,
  subjectMatchesRun,
  mountChatTakeover,
} from '../home-chat-takeover.js'
import { createFleetTreeStore, safeTreeStorage, nodeDisplayName, fleetTreesStorageKey, treeStatus, displayName as treeDisplayName, TREE_NODE_REMOVED_EVENT } from '../fleet-trees.js'
import { THIS_COMPUTER_ID, THIS_COMPUTER_LABEL } from '../declared-fleet.js'
import '../home.css'
import '../home-circle.css'
import '../home-blob-ring.css'
import '../home-roster-polish.css'
import { filterRosterGroups } from '../home-roster-filter.js'
import '../home-overview.css'
import { homeOverviewMarkup, homeClockMarkup, homeGlanceMarkup, glanceFigures } from '../home-overview.js'
import { homeCircleMarkup } from '../home-circle.js'
import { mountHomeCircleFluid } from '../home-circle-fluid.js'
import { mountHomeCircleFluid as mountClassicFluid } from '../home-circle-fluid-classic.js'
import { actionForLive, sampleAction, actionLabel, agentFilterFor, followedRowFor, TREE_TIPS_CHOICE, TREE_CHOICE_PREFIX, treeChoiceId } from '../home-circle-action.js'
import '../home-chat.css'
import '../home-chat-layout.css'

/* THE HERO RING'S DIAMETER, AS A FUNCTION OF THE WINDOW IT HAS TO FIT IN.
 *
 * The height term decides the ring on every desktop: min(520, max(380,
 * height - 300)).
 *
 * WHAT THE 380 FLOOR DID ON A PHONE. It is a floor on the DIAMETER and it
 * knows nothing about width, so below the 900px stack -- where .home is one
 * column inside padding: 0 clamp(20px, 4vw, 60px) -- it asked for a circle
 * wider than the screen at every phone size in the register: 380 into 280 at
 * 320x568, 500 into 320 at 360x800, 520 into 350 at 390x844, 520 into 390 at
 * 430x932. .view is overflow: hidden, so nothing scrolls to the missing part;
 * the left and right of the hero are simply cut off, on the screen this
 * product opens on. The width term is the gutter arithmetic that was missing.
 *
 * AND IN LANDSCAPE THE SAME FLOOR OVERRAN THE HEIGHT. At 844x390 the stage
 * gives .home height - 82 = 308px and the floor still asks for 380, so the
 * circle is clipped top and bottom instead. height - 120 is that 308 less a
 * little air; it can only bite below a 500px-tall window, which no desktop
 * window on this product is (its own stated floor is 1024x768), so every
 * desktop keeps the exact diameter it has today.
 *
 * THE WINDOW IS MEASURED IN THE RING'S OWN PIXELS, which is what `zoom` is
 * for. uptimeRing writes this number as a CSS px size inside the zoomed body,
 * while innerWidth and innerHeight are window pixels; the Text size setting
 * separates the two (src/text-size.js). Undivided, every budget above is
 * overspent by exactly that zoom -- at Large a ring that fits "width - 2
 * gutters" paints 12% wider than the window, and .view is overflow: hidden,
 * so the sides of the hero are cut off again, which is the failure the width
 * term was added to end. At Default the zoom is 1 and every number here is
 * unchanged.
 *
 * A PURE FUNCTION, EXPORTED, because a view factory over a live DOM cannot be
 * mounted in this repo's node tests but a function can be called with values;
 * see agentvChatFloorPx in src/views/agent.js for the same shape and
 * tools/test/mobile-size-floor.test.mjs for the values it is called with. */
export function homeRingSize(windowWidth, windowHeight, zoom = 1) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const width = windowWidth / scale
  const height = windowHeight / scale
  const gutter = Math.min(60, Math.max(20, width * 0.04))
  return Math.min(560, Math.max(380, height - 300), width - 2 * gutter, height - 120)
}

/* The fleet health snapshot changes when a sweep runs, which is minutes apart.
   It is only asked for at all when other computers have actually been
   connected -- an install with none used to run this poll forever against a
   file that always answered the same refusal. */
const HEALTH_POLL_MS = 45_000
/* THE COORDINATOR THREAD IS POLLED WHILE THE CONVERSATION IS ON SCREEN. Until
   2026-09-18 it was read once, when the panel switched to the conversation
   kind, so a reply that arrived later never reached the page and no
   responding state could ever appear (owner: the writing/reply indicator
   never shows). The shared surface's responding row is driven by the feed
   diffing successive snapshots (src/home-coordinator-chat.js), which needs
   snapshots to succeed one another. Four seconds: a growing answer reads as
   growing, and the projection is a local file. */
const THREAD_POLL_MS = 4_000
/* Decisions appear when an agent enqueues one, so this is a count and not a
   feed. Three cadences on purpose: the fast one once the queue is genuinely
   readable and MOVING, a doubling back-off while it is readable and provably
   still, and a slow heartbeat while it is not readable at all, so a screen
   opened before this app's own capability layer has finished starting still
   picks the queue up when it does -- without spending a request every twenty
   seconds in the ordinary case where there is no queue on this machine at all.
   The ladder itself, and the reason the back-off is on this ROW and never on
   the approvals screen, are in src/idle-cadence.js. */

/* HOW OFTEN THE SIGNED RECORDS MAY BE RE-READ, and this number is the whole of
 * how the live list keeps the promise the removed focus refresh broke.
 *
 * Reading either record means verifying a hash chain on the Electron main
 * process, which is also the process forwarding output for every live agent
 * session. The performance lane measured the cost of asking carelessly at ~0.9s
 * of whole-app stall on a ledger with ten thousand records, which is why the
 * refresh on window focus was removed rather than tuned: alt-tabbing back to
 * the window charged every running agent for the gesture.
 *
 * So nothing here polls and nothing here reads on focus. A read happens only
 * when the event stream has just said something that CHANGED a record -- a
 * session this list has never seen (a run was written), or a turn that ended (a
 * usage line was written) -- and then at most once in this window, trailing. A
 * turn ends on the order of tens of seconds, so in practice this floor is never
 * the thing doing the limiting; it is there so that an engine emitting a burst
 * of endings cannot turn into a burst of chain verifications.
 *
 * The words on the screen do NOT wait for it. What the agent is saying arrives
 * on the stream and is painted straight away, off no record at all. */
const LEDGER_REREAD_FLOOR_MS = 4_000
/* Words arrive faster than a person reads them. The live line is repainted on a
   trailing timer rather than per delta, so a fast turn is one repaint every
   tenth of a second instead of forty. Deliberately a timer and NOT a frame: a
   covered window is served no frames at all (src/page-frames.js), and this is a
   re-arming update rather than the one-shot settle that module's primitive is
   for. */
const LIVE_REPAINT_MS = 90
/* One tick per sample slot (src/sample-activity.js LIVE_SLOT_MS). Matched on
   purpose: faster repaints for nothing, slower and a new run sits unseen. */
const SAMPLE_HEARTBEAT_MS = 45_000

/* MACHINE FACTS ON A RELAY-SERVED HOME SCREEN. readerRemedy() translates the
   actionable desk remedies below, but most of home is status rather than a
   refusal. Those sentences still need an explicit subject: in a browser,
   "this computer" names the reader's computer even though these values came
   from the installed copy being driven. Keep this list literal and small on
   purpose. The conversations and chat-box choices read later in this file
   genuinely live in this browser's storage and must not be swept up by a
   mechanical this/that replacement. */
const RELAY_MACHINE_SENTENCE = Object.freeze(new Map([
  ['This computer', 'The computer you are driving'],
  ['Agents can run on this computer', 'Agents can run on the computer you are driving'],
  ['This computer is on your ToolsEnabled account', 'The computer you are driving is on your ToolsEnabled account'],
  ['This computer is not on your ToolsEnabled account yet', 'The computer you are driving is not on your ToolsEnabled account yet'],
  ['Connect this computer to your ToolsEnabled account', 'Connect the computer you are driving to your ToolsEnabled account'],
  ['Activity on this computer', 'Activity on the computer you are driving'],
  ['When you start an agent, every run shows up here. ToolsEnabled writes each one down on this computer before it starts.',
    'When you start an agent, every run shows up here. ToolsEnabled writes each one down on the computer you are driving before it starts.'],
  ['Written down on this computer as it happened. The record no longer checks out, so treat this list as a guide, not a receipt.',
    'Written down on the computer you are driving as it happened. The record no longer checks out, so treat this list as a guide, not a receipt.'],
]))

function readerSentence(sentence) {
  const text = String(sentence || '')
  if (currentDataSource() !== 'relay') return text
  const machineNamed = RELAY_MACHINE_SENTENCE.get(text)
    || text.replace(/^(\d+ agent runs?) on this computer$/, '$1 on the computer you are driving')
  return readerRemedy(machineNamed, { viaRelay: true })
}

/* The fleet's speaker dress (dot colour, label) for the coordinator thread.
   Profile data, because a fleet names its own agents. The profile's written
   sample transcript (`session`, `arrivals`, `replies`, `replyActs`) is no
   longer rendered by this file: the example shows the same run rows a real
   machine does, with its own conversations. */
const SPEAKERS = FLEET.speakers || {}
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* THE PERSON'S OWN VOICE IN THIS PROFILE'S CAST, found by the class rather than
   by a hard-coded id, because a profile names its own speakers and only the
   class says which of them is the person. `owner` is the fallback and it is the
   id the bundled cast uses, so a profile that supplies no owner voice at all
   still lands on the id src/chatbox-feed.js reserves in NOT_AGENTS -- which is
   what keeps a person's own line out of the agent filter. */
const OWNER_VOICE = Object.entries(SPEAKERS)
  .find(([, speaker]) => String(speaker?.cls || '').split(/\s+/).includes('is-owner'))?.[0] || 'owner'

// Agent prose uses the shared Markdown renderer. Voice classes identify the
// user's own words and activity across both transcript schemas; those stay
// literal, including asterisks, paths, and leading list markers.

/* THE DISCLOSURE MARK, one copy, worn by both folds on this screen: the run
   row and the long turn. It is the chat's own (styles.css .chat-action-mark),
   so a fold here reads as the fold a person already knows. */
const FOLD_MARK = `<span class="chat-action-mark" aria-hidden="true"><svg viewBox="0 0 8 8"><path d="M2.6 1.4 5.4 4 2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`

/* ONE TURN, ONE BUILDER, for both halves of this box.
 *
 * The coordinator thread and the lines inside a run row had a node builder
 * each, and they already had to agree -- the stylesheet dresses one `.turn`,
 * and renderChatVoice above is now asked the same question by both. This is
 * the last thing they were spelling twice.
 *
 * AND A LONG TURN FOLDS. The owner's instruction, with the two cards in front
 * of him: "collapse the context and such as it goes like we do in chat." The
 * run rows took that; the transcript beside them never did, so one agent reply
 * of a few hundred lines pushed the whole conversation off the glass and there
 * was no way to put it away. It ships OPEN -- nothing that was visible before
 * is hidden now -- and the fold exists so a reader can close a wall, not so
 * this screen can decide they did not want to read it.
 */
function turnNode({ cls, label, hue, text, fresh = false, surface = 'thread' }) {
  const dot = hue ? `<i class="turn-dot" style="background:${hue}"></i>` : ''
  const who = label ? `<span class="turn-who">${dot}${escText(label)}</span>` : ''
  const body = el('<div class="turn-text chat-message-body"></div>')
  setChatMessageBody(body, text, { plain: isPlainVoice(cls) })
  const fold = turnFold(text)
  const surfaceClass = surface === 'run' ? 'run-turn' : 'thread-turn'
  const node = el(`<div class="turn ${surfaceClass} ${cls}${fresh ? ' fresh' : ''}">${who}</div>`)
  if (!fold) {
    node.appendChild(body)
    if (!cls.split(/\s+/).includes('is-act')) addChatMessageCopy(node, body)
    return node
  }
  /* Native <details> carries the state, the keyboard and what a screen reader
     says; the press is owned (ownDisclosure) for the measured reason recorded
     in src/components.js, and scoped to the summary so that a press inside the
     turn's own text -- selecting a line, following a link -- is not a press on
     the fold. That scoping is also what keeps this fold and the run-row fold it
     sits inside from both answering one press. */
  const details = el(
    `<details class="turn-fold" open><summary class="turn-fold-head">${FOLD_MARK}`
    + `<span class="turn-fold-size">${escText(fold.label)}</span></summary></details>`,
  )
  details.appendChild(body)
  ownDisclosure(details, { within: details.querySelector('.turn-fold-head') })
  node.appendChild(details)
  if (!cls.split(/\s+/).includes('is-act')) addChatMessageCopy(node, body)
  return node
}

function updateTurnBody(node, text) {
  const body = node.querySelector('.chat-message-body')
  setChatMessageBody(body, text, { plain: isPlainVoice(node.className) })
  const fold = turnFold(text)
  let details = node.querySelector('.turn-fold')
  if (fold) {
    if (!details) {
      details = el(`<details class="turn-fold" open><summary class="turn-fold-head">${FOLD_MARK}<span class="turn-fold-size"></span></summary></details>`)
      node.insertBefore(details, body)
      details.appendChild(body)
      ownDisclosure(details, { within: details.querySelector('.turn-fold-head') })
    }
    details.querySelector('.turn-fold-size').textContent = fold.label
  } else if (details) details.replaceWith(body)
}


/* WHICH RUN ROWS A PERSON HAS OPENED, remembered across visits and reloads the
   same way the chat remembers its context block (src/components.js openMemory).
   Keyed by the run's own session id, so a choice survives the list being
   rebuilt and is never shared between two runs. */
const runOpen = openMemory('mc.home.run-open:')
const READING_WIDTH_KEY = 'mc.home.chat-width'
const AGENT_PICK_KEY = 'mc.home.agent-pick'
const runOpenKey = (run) => run.sessionId || `seq:${run.sequence}`

/* One per mounted home view, so the panel heading's id is unique even while the
   router briefly holds two of them. */
let panelInstances = 0

export function homeView() {
  /* The SOURCE decides what this screen shows, and it alone puts the badge on.
     `sample` is baked into this view's closures (which record the list reads,
     the write gate), so it is fixed at construction from what is known
     synchronously: the example toggle, or an already-resolved verdict. On a
     public page the first-ever mount may not know yet -- the relay probe is
     async -- so the resolution below runs once, and if the settled verdict
     disagrees with the construction guess it announces the change, which
     remounts this view through main.js's DATA_SOURCE_EVENT hook. One honest
     rebuild beats a screen whose closures disagree with its badge. */
  const sample = isExampleMode() || currentDataSource() === 'mock'
  void resolveDataSource().then((settled) => {
    if ((settled === 'mock') !== sample) announceDataSourceChange('first-resolution')
  }).catch(() => {})
  const fleetConfigured = !isSampleFleet()
  const writeReplyEnabled = !sample && isWriteEnabled('thread-reply')
  const composerTarget = FLEET.composerTarget || 'coordinator'

  /* THE PANEL'S OWN TITLE IS THE PANEL'S ACCESSIBLE NAME.
   *
   * The log is a tab stop (it scrolls, so a keyboard user has to be able to
   * reach it) and it is a live region, and it had no name at all: measured with
   * Tab on the packaged build, Chromium's accessibility tree gave it role "log"
   * and name "" -- Narrator announces that as the word "log" and nothing else,
   * on the one panel this screen is mostly made of.
   *
   * It is `aria-labelledby` pointing at the heading already above it, not a
   * hand-written aria-label, because that heading is REWRITTEN on every render
   * ("No agents have run here yet", "This box is set to show nothing", the
   * conversation's own title...). A second copy of that sentence in an
   * attribute would be the version that goes stale.
   *
   * The id is per-instance. The router can have two home views mounted at once
   * during a transition -- src/views/setup.js records that measurement -- and
   * two elements sharing one id makes the reference ambiguous exactly when a
   * screen reader is most likely to be reading it. */
  const panelTitleId = `home-panel-title-${panelInstances += 1}`
  const root = el(`
    <div class="home" data-mode="loading">
      ${homeOverviewMarkup()}
      <!-- THE RING COLUMN IS THE STAGE, and it holds the three things the
           owner asked for on 2026-09-18, in reading order and in DOM order --
           not in visual order with the DOM left behind, because this column is
           a tab path and a screen-reader path before it is a picture.

             1. the clock, ABOVE the circle (it was in the page header),
             2. the circle,
             3. the agents-working figures as a compact strip UNDER it
                (they were a full-width band across both columns).

           The ring itself is mounted into .home-ring-slot rather than appended
           to this wrapper, which is what keeps the strip below it: an
           appendChild on the wrapper would land the ring after the strip and
           the order would then be held up by a CSS order property, i.e. by
           nothing at all as far as Tab and Narrator are concerned. -->
      <div class="home-ring-wrap">
        ${homeClockMarkup()}
        <div class="home-ring-slot"></div>
        ${homeGlanceMarkup()}
      </div>
      <div class="home-feed-wrap" role="region" aria-labelledby="${panelTitleId}">
        <div class="home-feed">
          <div class="session-head">
            <div class="home-context-heading"><span class="home-context-label">Context</span><span data-panel-title id="${panelTitleId}"></span></div>
            <!-- TREES, AND THE AGENTS UNDER EACH (owner, 2026-09-19). "All
                 trees" is the whole view; a tree scopes the runs below to its
                 agents; an agent under a tree opens that agent's chat right
                 here, with no second press. The circle follows the same
                 choice. The entries are built by paintAgentPick from
                 home-activity.js treePickGroups. -->
            <select class="home-agent-pick" data-home-agent aria-label="${escText(TREE_PICK.label)}" hidden><option value="">${escText(TREE_PICK.allTrees)}</option></select>
            <!-- ONE AGENT, TWO WAYS TO SEE IT. Summary is its runs and context;
                 Chat inserts the product's own chat surface for it
                 (home-chat-takeover.js mountChatTakeover: the demonstration
                 chat on the example, the real agent surface on a fleet). -->
            <div class="home-agent-mode" data-home-mode role="group" aria-label="How to show this agent" hidden>
              <button type="button" data-home-mode-choice="summary" aria-pressed="true">Summary</button>
              <button type="button" data-home-mode-choice="chat" aria-pressed="false">Chat</button>
            </div>
            <span class="panel-badge" data-panel-badge hidden></span>
            <!-- THE DOOR TO THE FULL PAGE. A button, not a link: it changes
                 what this view shows and does not navigate, so a route would
                 be a second path to a thing that already has one. It carries
                 aria-expanded because the surface it opens is this panel
                 made larger, not a separate place. -->
            <button class="session-expand" type="button" data-chat-expand aria-expanded="false"></button>
          </div>
          <div class="activity-overview" data-activity-overview hidden>
            <div class="activity-counts"><span data-activity-count></span><span data-activity-working hidden></span><span class="activity-order">Newest first</span></div>
            <div class="activity-actions">
              <button type="button" data-activity-auto aria-pressed="true" title="Open new context as it arrives. Rows you close stay closed.">Auto-open context</button>
              <button type="button" data-activity-collapse>${escText(TAKEOVER_COPY.collapseDetails)}</button>
            </div>
            <div class="activity-filters" role="group" aria-label="Filter runs by status">
              ${ACTIVITY_FILTERS.map(filter => `<button type="button" data-activity-filter="${filter.id}" aria-pressed="${filter.id === 'all'}">${filter.label}<span data-filter-count>0</span></button>`).join('')}
            </div>
          </div>
          <p class="home-scope-empty home-removal-note" data-home-removal-note role="status" hidden></p>
          <div class="session-view">
            <!-- NOT A LIVE LOG (T1579). role="log" made the whole panel a polite
                 live region: every repaint of every row, plus the roster's
                 buttons, the search box and the filters inside it, was read
                 out, about 31,000 characters a minute on the example fleet.
                 It is a named, scrollable region; its rows are only rewritten
                 when their words change. -->
            <div class="session-log" tabindex="0" role="region" aria-labelledby="${panelTitleId}"></div>
          </div>
          <div class="home-agent-chat" data-home-chat hidden></div>
          <div class="session-foot" data-panel-foot hidden></div>
          <p class="home-scope-reply" data-scope-reply hidden>Open a run on its computer to continue the conversation.</p>
          <!-- NO SUBSCRIPTION DOOR HERE. Owner, 2026-08-26: "i dont want to
               advertise subscriptions in the app." This used to render a
               disabled "Subscriptions coming soon" control with its reason
               underneath -- honest about being shut, and still an advert for
               something nobody can buy, on the first screen of the product.
               The owner has also ruled that payments do not open during public
               beta, so this is not a temporary hold with a date behind it.
               The /subscribe view still exists and still refuses honestly for
               anyone who reaches it; what is gone is the SELLING of it here. -->
        </div>
      </div>
      <!-- THE FULL PAGE. Empty until it is opened, and it does not hold a
           COPY of the panel: the panel element itself is moved in here and
           moved back out. That is the whole reason this page still has one
           transcript renderer instead of two -- paintTurns, the composer and
           the scroll pin all keep working because they are the same nodes.
           The stage is where an agent's own surface mounts instead, which is
           the one subject this page does not draw itself. -->
      <div class="home-takeover" data-chat-takeover hidden role="dialog" aria-modal="true" aria-labelledby="${panelTitleId}-activity">
        <div class="home-takeover-bar">
          <div class="home-takeover-heading">
            <h1 id="${panelTitleId}-activity">${escText(TAKEOVER_COPY.title)}</h1>
            <p>${escText(TAKEOVER_COPY.subtitle)}</p>
            <span class="home-takeover-mode" data-chat-example hidden>Example data</span>
          </div>
          <button class="home-takeover-close" type="button" data-chat-collapse></button>
        </div>
        <div class="home-takeover-toolbar">
          <div class="home-takeover-views" role="group" aria-label="Main views">
            <button type="button" data-chat-view="coordinator" aria-pressed="true">Coordinator</button>
            <button type="button" data-chat-view="everything" aria-pressed="false">Everything</button>
          </div>
          <label class="home-takeover-pick">
            <span>Open</span>
            <select data-chat-subject aria-label="Open a conversation or activity window" title="Opens a window, or focuses it if already open"></select>
          </label>
          <div class="home-takeover-tools" role="group" aria-label="Workspace controls">
            <label class="home-chat-layout-choice"><span>Layout</span><select data-chat-layout aria-label="Chat panel layout"><option value="windows">Windows</option><option value="single">Single</option><option value="double">Double</option><option value="four">Four</option></select></label>
            <button type="button" data-chat-width aria-pressed="false">Narrow</button>
            <button type="button" data-chat-saved aria-expanded="false">Saved conversation</button>
            <button type="button" data-chat-new>New chat</button>
            <button type="button" data-chat-arrange title="Arrange open windows in a cascade">Arrange</button>
            <button type="button" data-chat-commands aria-haspopup="dialog" aria-expanded="false" title="Workspace commands (Ctrl+Shift+P / ⌘+Shift+P)">Commands</button>
            <button type="button" data-chat-find aria-expanded="false" title="Find in this view (Ctrl+F / ⌘F)">Find</button>
            <button type="button" data-chat-latest title="Go to the newest messages or runs">Latest ↓</button>
          </div>
        </div>
        <div class="home-takeover-search" data-chat-search hidden role="search" aria-label="Find in this view">
          <input type="search" data-chat-query aria-label="Find in this view" placeholder="Find a message or run" autocomplete="off" />
          <output data-chat-matches role="status" aria-live="polite"></output>
          <button type="button" data-chat-previous aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
          <button type="button" data-chat-next aria-label="Next match" title="Next match (Enter)">↓</button>
          <button type="button" data-chat-search-close aria-label="Close search" title="Close search (Esc)">×</button>
        </div>
        <div class="home-chat-pane-tabs" role="tablist" aria-label="Conversation panes" hidden></div>
        <div class="home-takeover-stage" data-chat-stage></div>
      </div>
    </div>
  `)

  const feed = root.querySelector('.home-feed')
  const logEl = root.querySelector('.session-log')
  /* THE BOX HAS TWO HALVES NOW, so the log has a slot for each rather than one
     body that every renderer wipes. The runs half and the conversation half are
     independently switchable, and they update at different rates: a rebuild of
     the whole log on every arriving message would fight the scroll pin and
     re-animate lines a person is in the middle of reading. */
  const noticeSlot = el('<div class="log-notices"></div>')
  const runsSlot = el('<div class="log-runs"></div>')
  /* No heading of the panel's own above the conversation any more: the shared
     surface (mountSharedThread) carries its head -- the coordinator's name and
     its search -- the same as every other chat in the app. The Home-specific
     .log-thread-head drew a second head 26 px above it (measured by the frame
     lane, 2026-09-18) and is gone from the markup, here and in the takeover. */
  const turnsSlot = el('<div class="log-turns"></div>')
  const threadBundle = el(`<details class="home-thread-context" open hidden><summary>${FOLD_MARK}<span>Coordinator conversation</span><span class="home-thread-preview"></span></summary></details>`)
  const threadPreview = threadBundle.querySelector('.home-thread-preview')
  let threadManual = false, threadOpen = false, threadRevision = null
  threadBundle.append(turnsSlot)

  /* THE CONVERSATION IS THE SHARED CHAT SURFACE NOW. Owner: "the chat in the
     chat view needs to be the same as every chat surface in the app." buildChat
     (src/components.js) is mounted into the turns slot and fed by
     src/home-coordinator-chat.js: the first snapshot as history, every later
     poll diffed into addOwnerMessage / openStream+push, a status source that
     drives the working row, and the audited thread-reply sender. The 2026-08-27
     reroute failed because a live coordinator had none of those three; this is
     the adapter, not the reroute. One surface per FRAME (scope + subject +
     notice); a frame change or a rewritten history remounts, a longer list
     never does. */
  let sharedChat = null, sharedFeed = null, sharedFrame = null
  /* WHETHER A COMPOSER EXISTS AT ALL is the decision's (describeHome ->
     view.composer: a FLEET with a coordinator context). The surface always
     has a box; without the decision's yes it is refused and says why. */
  let composerWanted = false
  /* Counts thread snapshots, so the feed can tell a new poll from a repaint. */
  let threadSnapshot = 0
  /* The thread speaks this profile's cast; the cast's classes say who is the
     person and what is a product line (see home-turns.js turnSpeaker). */
  const classifyTurn = turn => {
    const cls = String(turnSpeaker(turn?.who || turn?.sender, SPEAKERS)?.cls || '').split(/\s+/)
    return cls.includes('is-owner') ? 'you' : cls.includes('is-act') ? 'action' : 'agent'
  }
  /* The surface subscribes to its status source ONCE, while it is built, and
     the feed only exists after; so the listeners are held here and each feed
     is wired to them when it is made. */
  const sharedListeners = new Set()
  const sharedStatus = {
    busy: () => Boolean(sharedFeed && sharedFeed.status.busy()),
    step: () => (sharedFeed ? sharedFeed.status.step() : ''),
    subscribe: (fn) => { sharedListeners.add(fn); return () => sharedListeners.delete(fn) },
  }
  function disposeSharedThread() {
    sharedFeed?.dispose()
    if (sharedChat) { try { sharedChat.dispose?.() } catch { /* already gone */ } sharedChat.remove() }
    sharedChat = null; sharedFeed = null; sharedFrame = null
  }
  function mountSharedThread(frame, turns) {
    disposeSharedThread()
    turnsSlot.replaceChildren()
    const canSend = composerWanted && !sample && writeReplyEnabled
    const sender = canSend
      ? createCoordinatorSender({ post: postBridgeAction, feed: () => sharedFeed, copy: COPY })
      : null
    const chat = buildChat({
      title: composerTarget,
      roleKey: 'coordinator',
      tall: true,
      history: toHistory(turns, classifyTurn),
      onSend: sender ? (text, doors) => sender(text, doors) : null,
      /* No sender is a stated reason, never a box that swallows words: the
         example shows a recorded conversation, and a fleet with replies
         switched off says where the switch is. */
      composerReason: canSend ? null : (sample ? COPY.exampleReadOnly : !composerWanted ? COPY.noComposerHere : COPY.replyDisabled),
      status: sharedStatus,
    })
    sharedChat = chat
    sharedFeed = createCoordinatorFeed({ chat, initial: turns, classify: classifyTurn })
    sharedFeed.status.subscribe(() => { for (const fn of [...sharedListeners]) { try { fn() } catch { /* a listener never costs the feed */ } } })
    sharedFrame = frame
    turnsSlot.appendChild(chat)
    if (canSend) {
      void bridgeStatus().then(result => {
        if (destroyed || sharedChat !== chat) return
        if (!result.ok) chat.addNote?.(COPY.replyUnavailable)
      })
    }
  }
  ownDisclosure(threadBundle, { within: threadBundle.querySelector('summary'), onToggle: open => { threadManual = true; threadOpen = open } })
  const scopeEmpty = el('<p class="home-scope-empty" hidden></p>')
  const coordinatorEmpty = el('<div class="home-coordinator-empty" hidden><strong>No coordinator conversation on this computer</strong><p>You can follow your agents and read their replies in Everything.</p><button type="button" data-open-everything>View all activity</button></div>')
  /* AGENTS AT A GLANCE (owner, 2026-09-19: "the contents inside need to have
     more useful, easy, on demand info"): one line per agent in the panel's
     scope, above the runs and inside the same scroller, so it is the first
     thing on the glass and the run history sits under it. Painted by
     paintAgentBoard from the rows the list has already painted; the words
     come from home-activity.js (AGENT_BOARD, agentBoardLines). */
  /* A ROSTER (owner, 2026-09-19 late, after rows, folds and cards): one
     strip of numbers, then one table -- Agent, Status, What it is doing,
     Since, Chat -- with the trees as quiet group rows inside it, and ONE
     detail pane under the table for the row a person selects. No folds, no
     cards, no run tabs. Built from the same agentBoardLines data. */
  const boardSlot = el(`<section class="home-agents" data-home-agents aria-label="${escText(AGENT_BOARD.label)}" hidden>
    <div class="home-agents-strip"><span class="home-agents-summary" data-agents-summary></span><a class="home-agents-ledger" data-agents-ledger href="#/ledger" hidden></a></div>
    <div class="home-roster-tools">
      <input type="search" data-roster-search aria-label="Search agents and activity" placeholder="Search agents or activity…" autocomplete="off">
      <select data-roster-status aria-label="Filter agents by status"><option value="all">All statuses</option><option value="working">Working</option><option value="attention">Needs you</option><option value="finished">Finished</option><option value="idle">Idle</option></select>
    </div>
    <div class="home-roster-filter-note" data-roster-filter-note hidden><span data-roster-count role="status" aria-live="polite"></span><button type="button" data-roster-reset>Clear filters</button></div>
    <table class="home-roster home-roster-readable" data-agents-list>
      <thead><tr><th scope="col">Agent &amp; activity</th><th scope="col">${escText(ROSTER.actions)}</th></tr></thead>
      <tbody data-roster-body></tbody>
    </table>
    <div class="home-roster-detail" data-roster-detail hidden>
      <div class="home-roster-detail-head"><span class="home-roster-detail-name" data-detail-name></span><span class="home-roster-detail-state" data-detail-state></span><button type="button" class="home-roster-detail-close" data-detail-close aria-label="${escText(ROSTER.close)}">×</button></div>
      <dl class="home-roster-detail-rows">
        <div data-detail-row="task"><dt>${escText(ROSTER.task)}</dt><dd data-detail-task></dd></div>
        <div data-detail-row="asked"><dt>${escText(ROSTER.asked)}</dt><dd data-detail-asked></dd></div>
        <div data-detail-row="result"><dt>${escText(ROSTER.result)}</dt><dd data-detail-result></dd></div>
        <div data-detail-row="waiting"><dt>${escText(ROSTER.waiting)}</dt><dd data-detail-waiting></dd></div>
        <div data-detail-row="detail"><dt>${escText(ROSTER.now)}</dt><dd data-detail-now></dd></div>
        <div data-detail-row="history"><dt>${escText(ROSTER.earlier)}</dt><dd><ul data-detail-history></ul></dd></div>
      </dl>
      <div class="home-roster-detail-actions"><button type="button" class="home-roster-detail-chat" data-detail-chat>${escText(AGENT_BOARD.chat)}</button><button type="button" class="home-roster-detail-runs" data-detail-runs>${escText(AGENT_BOARD.runsButton)}</button></div>
    </div>
    <p class="home-agents-empty" data-agents-empty hidden>${escText(AGENT_BOARD.emptyTree)}</p>
  </section>`)
  logEl.append(noticeSlot, coordinatorEmpty, threadBundle, boardSlot, runsSlot, scopeEmpty)
  coordinatorEmpty.querySelector('button').addEventListener('click', () => takeoverSurface?.show('everything'))
  const panelTitle = root.querySelector('[data-panel-title]')
  const panelBadge = root.querySelector('[data-panel-badge]')
  const panelFoot = root.querySelector('[data-panel-foot]')
  const scopeReply = root.querySelector('[data-scope-reply]')
  const activityOverview = root.querySelector('[data-activity-overview]')
  const activityCount = root.querySelector('[data-activity-count]')
  const activityWorking = root.querySelector('[data-activity-working]')
  const collapseDetails = root.querySelector('[data-activity-collapse]')
  const autoContextButton = root.querySelector('[data-activity-auto]')
  const activityFilters = [...root.querySelectorAll('[data-activity-filter]')]
  let activityFilter = 'all'
  /* Is the current selection one lane, rather than a tree or All agents? Chat
     mode and the followed-lane mark are questions about a single agent, and a
     tree id is not an answer to one. */
  const oneLaneSelected = () => Boolean(agentFilter)
    && agentFilter !== TREE_TIPS_CHOICE && !agentFilter.startsWith(TREE_CHOICE_PREFIX)
  /* THE CHOICE RESOLVES TO ONE PREDICATE AND ONE TITLE, here, rather than being
     re-decided inside the paint. paintRunScope runs on every repaint and is
     exercised in a VM by tools/test/home-activity-filter-runtime.test.mjs; a
     paint that reaches for the tree records, two id prefixes and an id builder
     is a paint that cannot be called without all of them. */
  let keepForChoice = () => true
  let scopeTitle = ''
  function resolveChoice() {
    keepForChoice = agentFilterFor(agentFilter, treeRecords)
    if (agentFilter === TREE_TIPS_CHOICE) scopeTitle = COPY.treeTipsTitle
    else if (agentFilter.startsWith(TREE_CHOICE_PREFIX)) {
      scopeTitle = COPY.treeScopeTitle(treeRecords.find(tree => treeChoiceId(tree.id) === agentFilter)?.name)
    } else scopeTitle = ''
  }
  /* Which tree or agent the panel (and the circle) follows; '' is All trees.
     REMEMBERED the way the Summary/Chat choice below is remembered, so the
     panel comes back to the tree or agent a person was watching. A remembered
     id that names nothing on this screen is dropped by paintAgentPick once the
     list is populated, never before -- the rows arrive after the mount. */
  const agentPick = root.querySelector('[data-home-agent]')
  let agentFilter = ''
  try { agentFilter = String(localStorage.getItem(AGENT_PICK_KEY) || '') } catch {}
  const rememberAgentPick = () => { try { localStorage.setItem(AGENT_PICK_KEY, agentFilter) } catch {} }
  const modeGroup = root.querySelector('[data-home-mode]')
  const modeButtons = [...root.querySelectorAll('[data-home-mode-choice]')]
  const chatHost = root.querySelector('[data-home-chat]')
  /* THE PICKER MOVES WITH THE CHAT (owner, 2026-09-19 late: "the selection
     button for trees should change place on the page for example when a
     chat is opened"). While a chat is open the tree/agent picker leaves the
     header for a compact toolbar right above the chat, beside the chatted
     agent's name and a Back to list button; when the chat closes it goes
     back to its place in the header. The same <select> node is moved, so
     its value and its listeners stay. */
  const chatToolbar = el(`<div class="home-chat-toolbar" data-home-chat-toolbar hidden><span class="home-chat-toolbar-name" data-chat-toolbar-name></span><button type="button" class="home-chat-toolbar-back" data-chat-toolbar-back>Back to list</button></div>`)
  chatHost.parentNode.insertBefore(chatToolbar, chatHost)
  const chatToolbarName = chatToolbar.querySelector('[data-chat-toolbar-name]')
  const sessionHeadEl = root.querySelector('.session-head')
  /* BACK TO LIST RETURNS TO THE LIST THE CHAT WAS OPENED FROM: the tree the
     person was browsing, or All trees (T1570). */
  let listBeforeChat = ''
  const rememberListBeforeChat = next => {
    if (next === agentFilter) return
    listBeforeChat = agentFilter === TREE_TIPS_CHOICE || agentFilter.startsWith(TREE_CHOICE_PREFIX) ? agentFilter : ''
  }
  /* KEYBOARD FOCUS FOLLOWS THE CHAT (T1499). Chat hides the roster that held
     the pressed button and Back to list hides the chat that held that one, and
     a browser drops focus to the page when its element is hidden: after either
     press a keyboard user was nowhere and a screen reader was told nothing.
     Chat now puts focus on Back to list at the top of the opened chat; Back to
     list returns it to the Chat button of the row the person came from. */
  const chatBack = chatToolbar.querySelector('[data-chat-toolbar-back]')
  chatBack.addEventListener('click', () => {
    const was = agentFilter
    chooseAgent(listBeforeChat, 'summary')
    const row = agentLines.get(was)
    const home = row?.chat && !row.el.hidden && !row.el.closest?.('[hidden]') ? row.chat : agentPick
    home?.focus?.({ preventScroll: true })
  })
  function placePicker(inChat) {
    /* Owner, 2026-09-20: "all trees is still getting moved when chat pulls
       up" -- the picker stays in the header; the toolbar above the chat
       carries only the agent's name and Back to list. */
    if (agentPick.parentNode !== sessionHeadEl) sessionHeadEl.insertBefore(agentPick, modeGroup)
    chatToolbar.hidden = !inChat
  }
  const sessionView = root.querySelector('.session-view')
  /* Summary or Chat for the picked agent; a tree, or All trees, is always the summary. */
  let agentMode = 'summary'
  try { agentMode = localStorage.getItem('mc.home.agent-mode') === 'chat' ? 'chat' : 'summary' } catch {}
  const rememberAgentMode = () => { try { localStorage.setItem('mc.home.agent-mode', agentMode) } catch {} }
  agentPick.addEventListener('change', () => {
    if (takeoverSurface && agentPick.selectedOptions?.[0]?.dataset.kind === 'agent') {
      chooseAgent(agentPick.value, 'chat')
      agentPick.value = agentFilter
      return
    }
    const next = agentPick.value
    if (next && next !== TREE_TIPS_CHOICE && !next.startsWith(TREE_CHOICE_PREFIX)) rememberListBeforeChat(next)
    agentFilter = next
    rememberAgentPick()
    resolveChoice()
    /* PICKING AN AGENT FROM THE LIST OPENS ITS CHAT, right here, with no
       second press (owner: "select the agent to chat right there from the
       list immediately"). The Summary button beside it is the way back to
       that agent's runs. A tree is a scope, not a conversation, so choosing
       one leaves the mode alone and the panel shows its runs. */
    if (oneLaneSelected()) { agentMode = 'chat'; rememberAgentMode() }
    paintRunScope()
    logEl.scrollTop = 0
    readingControls?.changed()
  })
  for (const button of modeButtons) button.addEventListener('click', () => {
    agentMode = button.dataset.homeModeChoice
    rememberAgentMode()
    paintRunScope()
  })
  let autoContext = true
  try { autoContext = localStorage.getItem('mc.home.auto-context') !== 'off' } catch {}
  autoContextButton.setAttribute('aria-pressed', String(autoContext))
  autoContextButton.addEventListener('click', () => {
    autoContext = !autoContext
    autoContextButton.setAttribute('aria-pressed', String(autoContext))
    try { localStorage.setItem('mc.home.auto-context', autoContext ? 'on' : 'off') } catch {}
  })
  for (const button of activityFilters) button.addEventListener('click', () => {
    activityFilter = button.dataset.activityFilter
    for (const parts of runRows.values()) parts.keepUpdated = false
    paintRunScope()
    logEl.scrollTop = 0
    readingControls?.changed()
  })

  /* ------------------------------------------------------------------
     THE FULL PAGE.
     ------------------------------------------------------------------
     Opening it MOVES the panel rather than copying it, so everything the
     panel already does keeps working unchanged. The one subject this page
     cannot draw is an agent's own session, and that is mounted from the same
     module page 2 mounts -- see src/home-chat-takeover.js.

     `takeoverSubject` is read by paintTurns. It is null while the panel is in
     its ordinary place, which is the state every existing behaviour was
     written against: closed, this whole feature is not in the code path. */
  const takeoverEl = root.querySelector('[data-chat-takeover]')
  const takeoverStage = root.querySelector('[data-chat-stage]')
  const subjectPicker = root.querySelector('[data-chat-subject]')
  const expandButton = root.querySelector('[data-chat-expand]')
  const collapseButton = root.querySelector('[data-chat-collapse]')
  const feedWrap = root.querySelector('.home-feed-wrap')
  /* Reading width is shared by the workspace. Narrow centers a bounded
     measure; Wide fills each window. The control names the current mode. */
  const widthButton = root.querySelector('[data-chat-width]')
  let readingWidth = 'narrow'
  try { if (localStorage.getItem(READING_WIDTH_KEY) === 'wide') readingWidth = 'wide' } catch {}
  function paintReadingWidth() {
    takeoverEl.dataset.readingWidth = readingWidth
    widthButton.setAttribute('aria-pressed', String(readingWidth === 'wide'))
    widthButton.textContent = readingWidth === 'wide' ? 'Wide' : 'Narrow'
    widthButton.title = readingWidth === 'wide'
      ? 'Wide applies to all chats. Click for Narrow in every chat.'
      : 'Narrow applies to all chats. Click for Wide in every chat.'
  }
  paintReadingWidth()
  widthButton.addEventListener('click', () => {
    readingWidth = readingWidth === 'wide' ? 'narrow' : 'wide'
    // Written on press, so the stored value is always one this code recognises.
    try { localStorage.setItem(READING_WIDTH_KEY, readingWidth) } catch {}
    paintReadingWidth()
    takeoverSurface?.setReadingWidth(readingWidth)
  })
  /* ONE "SAVED CONVERSATION" FOR THE WHOLE FULL VIEW, in its header. The
     panes no longer carry a button each (computers.js mounts their browsers with
     toggle 'none'); this one opens the saved conversation of the focused pane,
     at the top of that pane, and says whose it is. */
  const savedButton = root.querySelector('[data-chat-saved]')
  const focusedSaved = () => takeoverSurface?.activeHost?.querySelector?.('[data-saved-conversation]') || null
  function paintSavedButton() {
    if (!savedButton) return
    const section = focusedSaved()
    const who = takeoverSurface?.subject?.label || takeoverSurface?.subject?.name || ''
    savedButton.hidden = !section
    savedButton.disabled = !section
    savedButton.setAttribute('aria-expanded', String(Boolean(section?.isSavedConversationOpen?.())))
    savedButton.title = section
      ? `Browse the saved conversation${who ? ` of ${who}` : ''} in the focused pane.`
      : 'The focused pane has no saved conversation to browse.'
  }
  savedButton?.addEventListener('click', () => {
    focusedSaved()?.toggleSavedConversation?.()
    paintSavedButton()
  })
  expandButton.textContent = TAKEOVER_COPY.expandLabel
  collapseButton.textContent = TAKEOVER_COPY.collapseLabel
  collapseButton.title = TAKEOVER_COPY.closeHint
  let takeoverSubject = null
  let takeoverSurface = null
  let readingControls = null
  let lastSubjectId = null
  let historyLimit = 20
  const takeoverDrafts = createHomeComposerDraftStore({ sample })
  let takeoverOpenToken = 0
  let takeoverLayoutState = {}
  let newChatDrafts = new Map()
  let workspaceHandoff = null
  let workspaceRestored = false
  const retainWorkspace = () => {
    // Explicitly closed windows have already been removed from layout state.
    // Keep drafts only for retained windows, including hidden/minimized ones.
    const subjects = new Set((takeoverLayoutState.windows || []).map(item => item.subjectId))
    for (const id of newChatDrafts.keys()) if (!subjects.has(id)) newChatDrafts.delete(id)
    workspaceHandoff?.write({ layout: takeoverLayoutState, newChats: newChatDrafts, lastSubjectId })
  }
  let agentWorkspacePool = null

  /* A tree store that will not open contributes NO ENTRY, never an empty one:
     the roster builder treats a missing entry as "could not open" and a
     present-but-empty array as "this computer really has no trees", and those
     two must not be told the same way. */
  function treesByComputer(alsoComputerIds = []) {
    const map = new Map()
    const storage = safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage)
    const computerIds = new Set([...(FLEET.machines || []).map(machine => machine.id), ...alsoComputerIds])
    for (const saved of conversations instanceof Map ? conversations.values() : []) computerIds.add(saved.computerId)
    for (const id of computerIds) {
      if (!id) continue
      try {
        /* Each tree carries the name Computers gives it (the store's
           treeLabel: its name, else its first brief, else "Tree N"), so an
           unnamed tree is never listed or titled by its internal id (T1537). */
        const store = createFleetTreeStore({ computerId: id, storage })
        map.set(id, (store.snapshot().trees || []).map(tree => ({ ...tree, label: store.treeLabel(tree.id) || '' })))
      } catch {
        /* Deliberately no entry. */
      }
    }
    return map
  }

  function treeFilterRecords() {
    /* The example fleet declares its own two trees over the roster it already
       has (src/sample-fleet.js sampleAgentTreeRecords), because its runs carry
       lane names rather than fleet-tree node ids and so resolve against nothing
       in the real store. Without them the two new options would be absent on
       the one screen this feature is most likely to be judged on. */
    if (sample) return sampleAgentTreeRecords()
    const storage = safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage)
    const records = []
    const computerIds = new Set((FLEET.machines || []).map(machine => machine.id))
    for (const saved of conversations instanceof Map ? conversations.values() : []) computerIds.add(saved.computerId)
    for (const id of computerIds) {
      if (!id) continue
      try {
        const store = createFleetTreeStore({ computerId: id, storage })
        const snapshot = store.snapshot()
        for (const tree of snapshot.trees || []) {
          const nodes = (snapshot.nodes || []).filter(node => node.treeId === tree.id)
          if (nodes.length === 0) continue
          const root = store.rootOf(tree.id)
          records.push({
            id: `${id}:${tree.id}`,
            name: treeDisplayName(tree) || tree.name || tree.id,
            active: treeStatus(tree) === 'running',
            tipKey: root ? root.id : null,
            memberKeys: nodes.map(node => node.id),
            /* For the picker: the store's own name for a member that has no
               run row yet, and which members the store says are live right
               now -- the starting/running pair tree-session-liveness calls busy. */
            memberNames: Object.fromEntries(nodes.map(node => [node.id, nodeDisplayName(node, snapshot.nodes || [], { roleLabel: role => ROLES[role]?.label || role })])),
            liveKeys: nodes.filter(node => ['starting', 'running'].includes(node.agent?.state)).map(node => node.id),
            memberRoles: Object.fromEntries(nodes.map(node => [node.id, node.agent?.declaredRole || node.agent?.role || ''])),
            /* What the tree itself saved about each member, for the board's rows
               when there is no run record (T1375): the status Computers draws,
               the ask, the latest answer and the status note. */
            memberSaved: Object.fromEntries(nodes.map(node => [node.id, {
              status: node.status, message: node.message || '', reply: node.reply || '', note: node.statusNote || '' }])),
          })
        }
      } catch { /* An unreadable store offers no trees; it does not empty the panel. */ }
    }
    return records
  }
  let treeRecords = []
  /* THE MONOGRAM'S COLOUR IS THE NODE'S COLOUR ON PAGE 2 (owner, 2026-09-20:
     'make those colors match more, maybe grab them from the tree itself'):
     the same painter the tree graph uses for a node's circle, keyed by the
     agent's role and its own id, so the same agent is the same mark on both
     pages and follows the Role library's saved colours. */
  let sampleRoles = null
  function roleOfAgent(key) {
    if (sample) {
      if (!sampleRoles) { sampleRoles = new Map(); try { for (const agent of sampleAgentsData().declared || []) sampleRoles.set(agent.id, agent.role || '') } catch { /* no roles: the painter falls back */ } }
      return sampleRoles.get(key) || ''
    }
    for (const tree of treeRecords) if (tree.memberRoles && tree.memberRoles[key]) return tree.memberRoles[key]
    return ''
  }

  /* The panel's home is feedWrap. Moving it back to exactly there is what
     makes collapse a true restore rather than an approximation of one. */
  const parkPanel = () => { if (feed.parentNode !== feedWrap) feedWrap.appendChild(feed) }

  /* Force the next paintTurns to redraw. It short-circuits on an unchanged
     signature, and a SCOPE change does not change the signature -- the turns
     are the same turns, filtered differently -- so without this the panel
     would keep showing the previous subject's selection. */
  function repaintScope() {
    turnsSignature = null
    if (renderedPanelKind) paintTurns(renderedPanelKind)
    if (currentHomeView) renderRuns(currentHomeView)
    paintRunScope()
  }

  function paintSubject(host, subject) {
    /* THE HOME PAGE'S OWN PAINTER, handed to the takeover so this view keeps
       one renderer. It does not draw a turn: it moves the REAL panel in and
       tells paintTurns which scope to filter to. */
    takeoverSubject = subject
    feed.dataset.scope = subject.kind
    threadBundle.open = subject.kind === 'coordinator' || threadOpen
    scopeReply.hidden = sample || subject.kind === 'coordinator'
    host.appendChild(feed)
    repaintScope()
    if (subject.kind !== 'coordinator' && historyLimit < 200) {
      historyLimit = 200
      void loadSessions()
    }
    return () => {
      takeoverSubject = null
      delete feed.dataset.scope
      scopeReply.hidden = true
      threadBundle.open = true
      parkPanel()
      repaintScope()
    }
  }

  let pickerSignature = null
  function fillPicker(choices, selectedId) {
    const selected = takeoverSurface?.subject
    if (selected?.id === selectedId && !choices.some(choice => choice.id === selectedId)) choices = [...choices, selected]
    const signature = JSON.stringify(choices.map(choice => [choice.id, choice.label, choice.group]))
    if (signature === pickerSignature) { subjectPicker.value = selectedId; return }
    pickerSignature = signature
    subjectPicker.replaceChildren()
    let group = null
    let holder = subjectPicker
    for (const choice of choices) {
      if (choice.group && choice.group !== group) {
        group = choice.group
        holder = document.createElement('optgroup')
        holder.label = group
        subjectPicker.appendChild(holder)
      } else if (!choice.group) {
        holder = subjectPicker
      }
      const option = document.createElement('option')
      option.value = choice.id
      option.textContent = choice.label
      if (choice.id === selectedId) option.selected = true
      holder.appendChild(option)
    }
  }

  function takeoverChoices() {
    const machines = (sample || fleetConfigured ? FLEET.machines || [] : []).map(machine => (
      !sample && machine.id === THIS_COMPUTER_ID && (!machine.name || machine.name === THIS_COMPUTER_ID)
        ? { ...machine, name: machine.label || THIS_COMPUTER_LABEL } : machine
    ))
    // The installed local computer exists before the person saves a first tree.
    // A remote source or example must not acquire a synthetic local destination.
    if (!sample && currentDataSource() === 'local' && !machines.some(machine => machine.id === THIS_COMPUTER_ID)) {
      machines.push({ id: THIS_COMPUTER_ID, name: THIS_COMPUTER_LABEL })
    }
    const savedMachineName = id => id === THIS_COMPUTER_ID ? THIS_COMPUTER_LABEL : id
    const known = new Set(machines.map(machine => machine.id))
    const savedMachines = []
    if (!sample) {
      // A draft agent has no run receipt yet. Its saved computer must still
      // appear in the picker so it can be opened and started from full view.
      try {
        const prefix = fleetTreesStorageKey('')
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (!key?.startsWith(prefix)) continue
          const id = key.slice(prefix.length)
          if (!id || known.has(id)) continue
          known.add(id)
          savedMachines.push({ id, name: savedMachineName(id) })
        }
      } catch { /* Preserve the machines the fleet and run records can name. */ }
    }
    for (const saved of !sample && conversations instanceof Map ? conversations.values() : []) {
      if (!saved.computerId || known.has(saved.computerId)) continue
      known.add(saved.computerId)
      savedMachines.push({ id: saved.computerId, name: savedMachineName(saved.computerId) })
    }
    const nodesByComputer = new Map()
    if (!sample) {
      const storage = safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage)
      for (const machine of [...machines, ...savedMachines]) {
        try {
          const nodes = createFleetTreeStore({ computerId: machine.id, storage }).snapshot().nodes
          nodesByComputer.set(machine.id, nodes.map(node => ({
            ...node, displayName: nodeDisplayName(node, nodes, { roleLabel: role => ROLES[role]?.label || role }),
          })))
        } catch { /* An unreadable store does not erase saved conversations. */ }
      }
    }
    return buildSubjectChoices({
      machines: [...machines, ...savedMachines],
      speakers: sample || fleetConfigured ? SPEAKERS : {},
      treesByComputer: treesByComputer([...machines, ...savedMachines].map(machine => machine.id)),
      conversations,
      nodesByComputer,
    })
  }
  function refreshTakeoverChoices() {
    if (!takeoverSurface) return
    const choices = takeoverChoices()
    takeoverSurface.updateChoices(choices)
    fillPicker(choices, takeoverSurface.subject?.id)
  }
  async function openTakeover() {
    if (takeoverSurface) return
    const token = ++takeoverOpenToken
    await takeoverDrafts.ready
    if (destroyed || token !== takeoverOpenToken || takeoverSurface) return
    if (!workspaceRestored) {
      workspaceHandoff = takeoverDrafts.forWorkspace({ source: currentDataSource() })
      const held = workspaceHandoff.read()
      if (held) {
        takeoverLayoutState = held.layout
        newChatDrafts = held.newChats
        lastSubjectId = held.lastSubjectId || lastSubjectId
      }
      workspaceRestored = true
    }
    const choices = takeoverChoices()
    const initialSubject = sample || currentHomeView?.panel.context ? defaultSubjectId(choices) : 'everything'
    /* Full view pressed while an agent's chat is open in the panel opens (or
       focuses) that conversation, which carries the words typed there
       (T1498). From the plain list it keeps the remembered window. */
    const panelSubjectId = panelChat ? panelChat.subjectId : null
    const startAt = panelSubjectId && choices.some(choice => choice.id === panelSubjectId) ? panelSubjectId
      : choices.some(choice => choice.id === lastSubjectId) ? lastSubjectId : initialSubject
    /* The panel's chat hands its unsent words to the store first, so the Full
       view window of the same conversation opens with them. While Full view is
       open the panel holds no chat of its own (paintPanelMode). */
    if (panelChat) { panelChat.mount.destroy(); panelChat = null; chatHost.replaceChildren() }
    fillPicker(choices, startAt)
    takeoverEl.hidden = false
    takeoverEl.querySelector('[data-chat-example]').hidden = !sample
    root.setAttribute('data-chat-open', 'true')
    expandButton.setAttribute('aria-expanded', 'true')
    agentWorkspacePool = createHomeAgentWorkspacePool()
    takeoverSurface = mountHomeChatLayout(takeoverStage, {
      surface: takeoverEl,
      state: takeoverLayoutState,
      readingWidth,
      onFind: () => takeoverEl.querySelector('[data-chat-find]').click(),
      onLatest: () => takeoverEl.querySelector('[data-chat-latest]').click(),
      choices,
      subjectId: startAt,
      /* The same fence every write surface on this page takes: an agent
         session is only mounted where this copy runs against a real fleet.
         On the example/demonstration copy it renders nothing, exactly as the
         agent page's own surface does. */
      live: !sample,
      renderTranscript: paintSubject,
      sampleChat: subject => sampleChatFor(subject.agentId),
      renderAgent: (host, subject) => {
        const onReady = controller => { takeoverSurface?.attachController(host, controller); paintSavedButton() }
        const onSubjectChange = created => {
          if (created?.id) takeoverSurface?.adoptSubject(host, { ...created, kind: 'agent', treeNode: true })
        }
        return subject.newChat
          ? agentWorkspacePool.newChat(host, subject.computerId, {
            onReady, onSubjectChange,
            onEscape: closeTakeover,
            onCancel: () => { takeoverSurface?.cancelNewChat(host); newChatDrafts.delete(subject.id) },
            draft: { read: () => newChatDrafts.get(subject.id), write: value => newChatDrafts.set(subject.id, value) },
          })
          : agentWorkspacePool.mount(host, subject, takeoverDrafts.forConversation(subject), { onReady, onSubjectChange })
      },
      onSubjectChange: subject => {
        if (subject) lastSubjectId = subject.id
        takeoverEl.dataset.subjectKind = subject?.kind || ''
        if (subject && ![...subjectPicker.querySelectorAll('option')].some(option => option.value === subject.id)) {
          const option = document.createElement('option')
          option.value = subject.id; option.textContent = subject.label
          subjectPicker.appendChild(option)
        }
        /* A New chat entry goes once its window is closed or has become the
           agent it set; choosing a leftover one did nothing (T1538). */
        const stillOpen = new Set(takeoverSurface?.extraSubjectIds || [])
        if (subject) stillOpen.add(subject.id)
        for (const option of [...subjectPicker.querySelectorAll('option')]) {
          if (option.value.startsWith('new:') && !stillOpen.has(option.value)) option.remove()
        }
        subjectPicker.value = subject?.id || ''
        for (const button of takeoverEl.querySelectorAll('[data-chat-view]')) button.setAttribute('aria-pressed', String(button.dataset.chatView === subject?.id))
        readingControls?.changed()
        paintSavedButton()
      },
      draftStore: takeoverDrafts,
    })
    readingControls = mountChatReading(takeoverEl, takeoverStage, { getStage: () => takeoverSurface?.activeHost || takeoverStage })
    takeoverEl.dataset.subjectKind = takeoverSurface.subject?.kind || choices.find(choice => choice.id === startAt)?.kind || 'coordinator'
    for (const button of takeoverEl.querySelectorAll('[data-chat-view]')) button.setAttribute('aria-pressed', String(button.dataset.chatView === startAt))
    subjectPicker.focus()
  }

  function closeTakeover() {
    takeoverOpenToken++
    if (!takeoverSurface) return
    readingControls?.destroy()
    readingControls = null
    takeoverSurface.destroy()
    retainWorkspace()
    takeoverSurface = null
    agentWorkspacePool?.destroy()
    agentWorkspacePool = null
    parkPanel()
    takeoverEl.hidden = true
    root.removeAttribute('data-chat-open')
    expandButton.setAttribute('aria-expanded', 'false')
    // The panel's chat comes back with what was typed in Full view.
    paintPanelMode()
    expandButton.focus()
  }

  expandButton.addEventListener('click', openTakeover)
  collapseButton.addEventListener('click', closeTakeover)
  subjectPicker.addEventListener('change', () => takeoverSurface?.show(subjectPicker.value))
  for (const button of takeoverEl.querySelectorAll('[data-chat-view]')) button.addEventListener('click', () => takeoverSurface?.show(button.dataset.chatView))
  const takeoverKeys = (event) => {
    if (!takeoverSurface || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    // Shared chat actions and file comparison own their portaled keyboard
    // controls. The Home focus loop must not pull focus out of those dialogs.
    if (!takeoverEl.contains(event.target) && event.target.closest?.('[role="dialog"], .chat-actions-pop, .drawer')) return
    if (takeoverSurface.keydown?.(event)) return
    if (readingControls?.keydown(event)) return
    if (event.key === 'Escape') { event.preventDefault(); closeTakeover(); return }
    if (event.key !== 'Tab') return
    // The full-page dialog owns keyboard focus, including when its subject
    // changes. Only visible controls count; closed transcript details do not.
    const controls = takeoverFocusStops(takeoverEl)
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (!first) return
    const outside = !takeoverEl.contains(document.activeElement)
    if (event.shiftKey && (document.activeElement === first || outside)) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || outside)) {
      event.preventDefault(); first.focus()
    }
  }
  window.addEventListener('keydown', takeoverKeys)

  /* ------------------------------------------------------------------
     The hero ring.
     ------------------------------------------------------------------ */
  /* Read once at construction, as it always was -- an orientation change
     remounts the view through the router rather than resizing this in place.
     The arithmetic is homeRingSize(), at the top of this file. */
  const ringSize = homeRingSize(window.innerWidth, window.innerHeight, textZoom())
  const ring = uptimeRing({ size: ringSize, epoch: Date.now(), caption: '', sub: '', crescent: true, corona: false })
  ring.el.dataset.load = 'unknown'
  root.dataset.ledgerStatus = 'unknown'
  const statusColors = mountHomeStatusColors(root)
  ring.el.dataset.circleMotion = currentHomeCircleMotion()
  ring.el.classList.add('home-circle')
  ring.el.appendChild(el(homeCircleMarkup()))
  /* The live Navier-Stokes fluid inside the ring (home-circle-fluid.js), page 1 only. Kill switch: drop data-fluid to
     turn it off, or a word of data-fluid-extras to drop that extra. It follows the circle's Motion and Glow settings. */
  ring.el.dataset.fluidExtras = 'personality blowup voice'
  // The stage lets the dial fit its column without resizing voice controls.
  const ringStage = el('<div class="home-ring-stage"></div>')
  ringStage.appendChild(ring.el)
  root.querySelector('.home-ring-slot').appendChild(ringStage)
  const voiceContact = attachPersistentVoice({ sample, ring: ring.el })
  root.querySelector('.home-ring-wrap').appendChild(voiceContact.el)
  let ringFluid = null
  function paintCircleStyle() {
    const style = currentHomeCircleStyle()
    ring.el.dataset.circleStyle = style
    ring.el.dataset.fluid = style === 'simple' ? 'off' : 'on'
    if (style === 'simple') {
      // Simple never mounts a simulation. Switching to it releases the
      // canvas, GPU context, animation loop and listeners immediately.
      ringFluid?.destroy()
      ringFluid = null
      ring.el.dataset.fluidState = 'off'
      ring.el.dataset.fluidReason = 'simple'
      delete ring.el.dataset.fluidLevel
    } else {
      /* Owner, 2026-09-19 late: "change it to classic dont argue ... change
         the animations at rest to classic too." The base -- its look and its
         movement at rest -- is the 09-15 renderer (home-circle-fluid-classic.js)
         for BOTH Blob and Classic. The current renderer takes the ring only
         while the agent is thinking or using a tool (the mist and the Bash
         rings the owner kept), and hands it back when that ends. */
      /* Owner, 2026-09-19 late: 'the color and style for the blob is really
         inconsistent, it changes back to the style we just had changed from'
         -- so Blob is the classic renderer for EVERY action; it acts out
         thinking, reading, writing and tools itself. Nothing swaps. */
      const wantClassic = style === 'classic' || style === 'standard'
      if (ringFluid && ringFluid.classic !== wantClassic) { ringFluid.destroy(); ringFluid = null }
      if (!ringFluid) {
        delete ring.el.dataset.fluidReason
        ringFluid = wantClassic ? mountClassicFluid(ring.el, { sample }) : mountHomeCircleFluid(ring.el, { sample })
        if (ringFluid) ringFluid.classic = wantClassic
      }
    }
  }
  /* The actions the current renderer still owns: the thinking mist and the
     tool rings. Everything else (idle, waiting, reading, writing, finished)
     rests on the classic base. */
  const ACTIVE_ACTIONS = new Set(['thinking', 'running'])
  paintCircleStyle()

  const captionEl = ring.el.querySelector('.uring-caption')
  const digitsEl = ring.el.querySelector('.uring-digits')
  const innerEl = ring.el.querySelector('.uring-inner')
  /* THE TIMER SITS ABOVE THE CIRCLE.
     Owner, 2026-09-15: "put the timer above actually in the header" -- it was
     moved out of the circle's face into .home-overview-head.
     Owner, 2026-09-18: put the timer BACK ABOVE THE CIRCLE. So the slot it is
     moved into is now the first child of the ring column instead of the middle
     track of the page header; the earlier instruction is kept here because
     "above" is the word both of them use and the difference between them is
     only which "above" -- above the page, or above the ring.

     What does NOT change either time: these are the same caption and digit
     nodes uptimeRing built, moved rather than copied, so the clock below goes
     on writing into them and nothing about the count changes. The circle's face
     stays left to the fluid and to the line naming the agent it follows. */
  const clockSlot = root.querySelector('[data-home-clock]')
  /* Owner, 2026-09-19 late: "swap the clock and the following" -- the line
     naming the agent the circle follows goes to the plate ABOVE the circle,
     and the clock goes back into the circle's face. Same nodes, moved. */
  innerEl.append(captionEl, digitsEl)
  clockSlot.hidden = false
  const agentLine = el('<div class="home-agent-line" data-agent-line hidden><b></b><span></span></div>')
  clockSlot.appendChild(agentLine)
  /* uptimeRing only emits `.uring-sub` when it is given text at construction,
     and this view has none until a source answers. Create it once here rather
     than passing placeholder text that would paint and then be replaced. */
  const subEl = el('<div class="uring-sub"></div>')
  /* Owner, 2026-09-19 late: "remove the useless agent runs line" -- the
     sentence is still computed (other readers use view.headline) but is not
     in the document. */

  const factsEl = el('<div class="home-facts"></div>')
  // Status details can grow with text zoom and connection errors. Keep them
  // below the dial so they never push its clock through the circular edge.
  ringStage.appendChild(factsEl)

  const UNITS = [['d', UPTIME_UNITS.days], ['h', UPTIME_UNITS.hours], ['m', UPTIME_UNITS.minutes], ['s', UPTIME_UNITS.seconds]]
  digitsEl.innerHTML = UNITS
    .map(([, label]) => `<span class="seg"><span class="n-stack"><span class="n cur">0</span></span><span class="u">${label}</span></span>`)
    .join('<span class="colon">:</span>')
  const stacks = [...digitsEl.querySelectorAll('.n-stack')]
  // While no whole day has passed the Days group is hidden (home-overview.css
  // reads this), so the three remaining groups can be set larger.
  digitsEl.dataset.days = '0'

  function setDigit(stack, value) {
    const last = stack.lastElementChild
    if (!last || last.textContent === value) return
    const outgoing = [...stack.children]
    const next = document.createElement('span')
    next.className = 'n next'
    next.textContent = value
    stack.appendChild(next)
    outgoing.forEach(n => { n.classList.remove('cur', 'next', 'in'); n.classList.add('out') })
    requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add('in')))
    const finish = () => {
      outgoing.forEach(n => n.remove())
      stack.querySelectorAll('.n.out').forEach(n => n.remove())
      next.classList.remove('next', 'in'); next.classList.add('cur')
    }
    const tid = setTimeout(finish, 420)
    next.addEventListener('transitionend', () => { clearTimeout(tid); finish() }, { once: true })
  }

  function elapsedParts(epoch) {
    let s = Math.max(0, Math.floor((Date.now() - epoch) / 1000))
    const d = Math.floor(s / 86400); s -= d * 86400
    const h = Math.floor(s / 3600); s -= h * 3600
    const m = Math.floor(s / 60); s -= m * 60
    const pad = (n) => String(n).padStart(2, '0')
    return [String(d), pad(h), pad(m), pad(s)]
  }

  /* ------------------------------------------------------------------
     Scroll pinning for the panel. The seeded history renders while the view is
     still DETACHED (the router mounts it after assembly), where scrollHeight is
     0 and any snap is a no-op — so the panel keeps the standard chat contract
     instead: pinned to the newest line through every resize and append,
     unpinned the moment the reader scrolls up, re-pinned on return.
     ------------------------------------------------------------------ */
  let destroyed = false
  let pinned = true
  logEl.addEventListener('scroll', () => {
    pinned = logEl.scrollTop >= logEl.scrollHeight - logEl.clientHeight - 24
  }, { passive: true })
  const pinToBottom = () => {
    if (takeoverSubject && takeoverSubject.kind !== 'coordinator') return
    if (!destroyed && pinned && logEl.scrollHeight) logEl.scrollTop = logEl.scrollHeight
  }
  const anchorRo = new ResizeObserver(pinToBottom)
  anchorRo.observe(logEl)
  /* SUBTREE, AND WITHOUT IT THIS OBSERVER COULD NEVER FIRE ONCE.
   *
   * `childList` alone reports changes to the observed element's OWN children,
   * and .session-log's own children are the four slots handed to it by
   * `logEl.append(noticeSlot, runsSlot, threadHead, turnsSlot)` -- which runs
   * at construction, BEFORE this call, and is the only statement in this file
   * that ever adds or removes a child of the log. Every other write goes one
   * level further down (`noticeSlot.appendChild`, `runsSlot.replaceChildren`,
   * `turnsSlot.replaceChildren`, `turnsSlot.appendChild`). So the
   * "pinned to the newest line through every append" contract stated above was
   * being kept, where it was kept at all, only by the pinAfterMount() call at
   * the end of renderContext -- and the paths that never reach that call (a
   * live agent's words landing in an open run row through paintLiveSoon, and
   * repaintScope() when the full page opens or changes subject) simply did not
   * scroll. One word, and the observer watches what actually grows.
   *
   * It costs nothing when a reader has scrolled up: pinToBottom returns on
   * `pinned` before it measures anything, and a burst of writes is one
   * callback -- the browser delivers records once per microtask checkpoint. */
  const anchorMo = new MutationObserver(pinToBottom)
  anchorMo.observe(logEl, { childList: true, subtree: true })
  /* ...and the webfont swap, the one growth path with NO mutation and NO box
     resize. `fonts.ready` may settle while the assembled view is detached, so
     its immediate measurement is still zero. Re-elect the pin after two painted
     frames, and repeat for any later font-loading generation. */
  let firstPinFrame = 0
  let settledPinFrame = 0
  const pinAfterMount = () => {
    /* ONE HANDLE SLOT, THREE CALLERS -- and on a frameless page that was a
       leak with a number. pinAfterMount runs immediately, again from
       fonts.ready, and again on every later loadingdone; each call overwrites
       these two slots, so destroy() below can only cancel the LAST pair and
       any earlier frame stays queued holding this whole view. On a page that
       never gets a frame nothing ever drains that queue: measured at +3
       pending frames per lap of the ring, the last site still accumulating
       after the other four were fixed. onNextFrame queues nothing on such a
       page -- it pins at once off a flushed layout -- and is the ordinary
       requestAnimationFrame, handles and all, when the page can draw. */
    firstPinFrame = onNextFrame(() => {
      settledPinFrame = onNextFrame(pinToBottom)
    })
  }
  const onFontsLoaded = () => pinAfterMount()
  document.fonts?.addEventListener?.('loadingdone', onFontsLoaded)
  document.fonts?.ready?.then(pinAfterMount)
  pinAfterMount()

  /* ------------------------------------------------------------------
     Everything this screen knows. One object, so describeHome() sees the whole
     picture at once and no part of the screen can answer from a source the rest
     cannot see — which is precisely how the contradictory pair got in.
     ------------------------------------------------------------------ */
  const state = {
    sample,
    fleetConfigured,
    fleetHealth: null,
    peer: null,
    /* `undefined` is the honest starting value: nobody has been asked yet, and
       it is NOT the same as having asked and been refused. Nothing renders
       until the first answers land (see `settle` below), so this state is never
       painted -- but it must still be truthful, because a source that never
       answers leaves it in place. */
    sessions: readLocalSessions(undefined),
    engine: readAgentEngine(undefined),
    /* Null until loadProviders() answers, and null means "not asked" rather than
       "nobody is signed in" -- so the first paint says exactly what it said
       before this screen learned to ask, instead of a verdict nothing measured. */
    providers: null,
    /* Null until loadAccount() answers, and null means "not asked". The row it
       feeds says so rather than guessing at either answer. */
    account: null,
    approvals: null,
    ledgerStatus: homeLedgerStatus(),
    /* What the person chose on the settings page, plus who is actually talking
       in whatever conversation this screen has. The decision needs both: the
       first says which agents may appear, the second is what it is filtering,
       and only their combination can tell "nobody is talking" apart from
       "everybody talking is switched off". */
    chatbox: {
      runsMode: readRunsMode(),
      selection: readAgentSelection(),
      agentsInSource: [],
    },
    nowMs: Date.now(),
  }

  /* The conversation, held rather than painted straight into the log, so that
     changing the agent selection re-filters what is already here instead of
     needing the source read again. */
  let contextTurns = []

  /* WHAT EACH SESSION'S TURNS COST, from the signed per-turn record, grouped by
     the key the run record is keyed on. Empty until the record answers, and an
     empty map simply renders the rows this screen rendered before it existed. */
  const usageBySession = new Map()
  /* WHAT THIS WINDOW IS WATCHING HAPPEN, per session: the turn the engine named,
     the words of it so far, and whether it is still going. Nothing in here is
     read off a record and nothing in here is written to one. It is this window's
     own observation of the stream, and it is gone when the view is. */
  const liveSessions = new Map()
  const sessionTextReader = createSessionTextReader()

  function noteContext(turns) {
    contextTurns = Array.isArray(turns) ? turns : []
    state.chatbox = { ...state.chatbox, agentsInSource: agentIdsFromTurns(contextTurns) }
  }

  function readChatboxSettings() {
    state.chatbox = {
      ...state.chatbox,
      runsMode: readRunsMode(),
      selection: readAgentSelection(),
    }
  }

  let clockEpoch = null
  let raf = 0
  let lastTickAt = 0
  let renderedPanelKind = null

  function stopClock() {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
  }
  /* The clock runs only when it has a real instant to count from. Four dashes
     under the word SECONDS is a broken clock, and a person reads it as one. */
  function startClock(epoch) {
    clockEpoch = epoch
    if (epoch == null) {
      stopClock()
      digitsEl.hidden = true
      return
    }
    digitsEl.hidden = false
    if (raf) return
    const loop = (ts) => {
      if (clockEpoch != null && ts - lastTickAt >= 250) {
        lastTickAt = ts
        const parts = elapsedParts(clockEpoch)
        digitsEl.dataset.days = parts[0]
        parts.forEach((v, i) => setDigit(stacks[i], v))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
  }

  const TONE_COLOR = { good: 'var(--s-good)', warn: 'var(--s-warn)', neutral: 'var(--ink-4)' }

  /* Nothing is painted until the two local reads have answered.
   *
   * Not a nicety: this screen's whole job is to say one true thing, and for the
   * first few hundred milliseconds of a launch it does not yet know which one
   * that is. Rendering an interim guess means flashing "the record could not be
   * read" at a person whose record is about to load perfectly -- which is the
   * same class of defect as the pair this rewrite exists to remove, just
   * shorter-lived. The ring holds its rim and the panel holds its frame; both
   * are already the screen's real furniture, so the wait reads as the page
   * arriving rather than as a spinner. */
  let awaitingFirstAnswers = 2
  function settle() {
    if (awaitingFirstAnswers > 0) awaitingFirstAnswers -= 1
    apply()
  }

  let currentHomeView = null
  let continuationStatus = null
  function apply() {
    if (destroyed || awaitingFirstAnswers > 0) return
    state.nowMs = Date.now()
    const view = describeHome(state)
    root.dataset.mode = view.mode
    /* Two layout signals, not decoration. A panel holding an empty state must
       shrink to it, or the card frames six hundred pixels of nothing and the
       calm empty state reads as a container that failed to fill. Likewise the
       ring gives its middle back to the headline when there are no digits in
       it. Both are stated here because only this function knows. */
    root.dataset.panel = view.panel.empty ? 'empty' : view.panel.kind
    root.dataset.clock = view.clock == null ? 'none' : 'running'

    captionEl.textContent = readerSentence(view.caption)
    subEl.textContent = readerSentence(view.headline)
    startClock(view.clock)

    const ledger = state.ledgerStatus
    root.dataset.ledgerStatus = ledger.status
    ring.el.dataset.ledgerStatus = ledger.status
    // Keep the underlying ring's existing tokens, now driven only by Ledger.
    ring.el.dataset.load = ({ clear: 'idle', attention: 'busy', blocked: 'peak', unknown: 'unknown' })[ledger.status]
    const ledgerFact = el('<a class="home-fact" data-home-ledger-status href="#/ledger"><i></i><span></span></a>')
    ledgerFact.setAttribute('href', ledgerStatusHref(ledger.status))
    ledgerFact.querySelector('i').style.background = 'var(--core-status-color)'
    ledgerFact.querySelector('span').textContent = ledger.label
    ledgerFact.title = ledger.title

    const recoveryFacts = []
    if (currentDataSource() === 'local' && continuationStatus?.blocked) {
      const fact = el('<div class="home-fact" data-home-continuation-status role="status"><i></i><span></span></div>')
      fact.querySelector('i').style.background = TONE_COLOR.warn
      fact.querySelector('span').textContent = continuationStatus.reason
      recoveryFacts.push(fact)
    }
    factsEl.replaceChildren(ledgerFact, ...recoveryFacts, ...view.facts.map(fact => {
      const node = el(fact.href
        ? `<a class="home-fact" href="${fact.href}"><i></i><span></span></a>`
        : `<div class="home-fact"><i></i><span></span></div>`)
      node.querySelector('i').style.background = TONE_COLOR[fact.tone] || TONE_COLOR.neutral
      node.querySelector('span').textContent = readerSentence(fact.text)
      return node
    }))

    panelTitle.textContent = readerSentence(view.panel.title)
    panelBadge.hidden = !view.panel.badge
    if (view.panel.badge) panelBadge.textContent = view.panel.badge
    panelFoot.hidden = !view.panel.footer
    if (view.panel.footer) panelFoot.textContent = readerSentence(view.panel.footer)

    /* The composer decision travels with every paint; a change of it is a
       change of frame for the shared surface (below), so the box remounts
       with or without its sender rather than lying about either. */
    composerWanted = Boolean(view.composer)
    renderPanel(view)
  }

  /* ------------------------------------------------------------------
     The panel body. Only re-rendered when the KIND changes; a runs list that
     rebuilt itself on every poll would fight the scroll pin and re-animate
     lines a person is reading.
     ------------------------------------------------------------------ */
  function renderPanel(view) {
    renderNotices(view)
    renderRuns(view)
    renderContext(view)
  }

  /* ---- the notices, which belong to the box rather than to either half ---- */
  let noticeSignature = null
  function renderNotices(view) {
    const notices = [view.panel.contextEmpty, view.panel.empty].filter(Boolean)
    const signature = notices.map(notice => notice.title).join('/')
    if (noticeSignature === signature) return
    noticeSignature = signature
    noticeSlot.replaceChildren()
    for (const notice of notices) {
      const action = notice.action ? { ...notice.action, label: readerSentence(notice.action.label) } : null
      showNotice(readerSentence(notice.title), readerSentence(notice.body), false, action)
    }
  }

  /* ---- the runs half ---- */
  /* WHAT THIS COMPUTER SAVED ABOUT EACH SESSION, keyed the way the run record
   * is keyed. This is the join behind "which agent, and what was it asked".
   *
   * READ, NEVER WRITTEN, AND NEVER REQUIRED. Every failure here -- no storage,
   * a key that will not parse, a record from a build with a different shape --
   * costs this list its two extra lines and nothing more; parseFleetTrees
   * refuses a record whole rather than repairing it, and an empty map simply
   * renders the rows this screen has always rendered. So a person whose trees
   * are damaged still sees their run history.
   *
   * THE PREFIX COMES FROM THE MODULE THAT OWNS THE KEY. fleetTreesStorageKey('')
   * is that module's own answer to "where do these live", so this file holds no
   * second copy of a storage key to go stale.
   *
   * `length`/`key(i)` AND NOT Object.keys, and this is the line that was
   * measured wrong first. In this application `localStorage` is not Storage:
   * public/durable-storage.js replaces the global with a durable shim over the
   * settings file, because the origin here carries a scanned port number and a
   * relaunch on a different port looked exactly like a factory reset. The shim
   * exposes the Storage METHODS and nothing else -- so `Object.keys(store)`
   * answers ["getItem","setItem","removeItem","clear","key","length"] and finds
   * no saved conversation ever. Every row silently lost its two extra lines,
   * and every unit test passed, because in a plain browser the global is left
   * alone and Object.keys is right there. Caught only by driving the packaged
   * build: tools/home-activity-substance-qa.mjs.
   *
   * Re-read on every repaint rather than cached: the computers page writes to
   * this same storage in another view of the same window, and a map captured at
   * mount would go stale the first time somebody started an agent. It is a
   * handful of small keys parsed at most once a repaint, and the repaint is
   * already gated by the signature above. */
  /* Re-read when a record changed and not on every repaint. The computers page
     writes these keys from another view of the same window, so a map captured
     once at mount would go stale the first time somebody started an agent --
     but that page is not on screen while this one is, so the moments it can
     change are exactly the moments this screen re-reads the ledger anyway.
     `transcripts: true` is what makes "what it said" reachable for a node whose
     own reply field is empty. */
  let conversations = null
  const runLocations = new Map()
  function readConversations() {
    /* The example's conversations are its own, built beside its own record,
       and a real person's saved trees never reach a badged screen. */
    conversations = sample
      ? sampleConversations(state.nowMs)
      : readSessionRoles(typeof window === 'undefined' ? null : window.localStorage, { transcripts: true })
    const trees = treesByComputer()
    runLocations.clear()
    for (const [sessionId, saved] of conversations instanceof Map ? conversations : []) {
      const machine = FLEET.machines?.find(machine => machine.id === saved.computerId)
      const tree = trees.get(saved.computerId)?.find(tree => tree.id === saved.treeId)
      const computerName = machine?.name || machine?.label || (!sample && !fleetConfigured ? 'This computer' : '')
      runLocations.set(sessionId, [computerName, tree?.name].filter(Boolean).join(' / '))
    }
    refreshTakeoverChoices()
  }

  /* ---- ONE RUN, AS A FLOW RATHER THAN AS A LINE IN A LOG ----
   *
   * THE REPORT THIS IS FOR, in the owner's words: "on page 1 this is supposed
   * to be a context flow of all the agents and such we want to see their
   * outputs cleanly." What was there was a row per run carrying a number, a
   * verb and a relative time, and it could not have carried an output however
   * long anybody waited: the join took the role and the brief off the node and
   * never read `reply`, which is the field that exists on the node for exactly
   * this purpose.
   *
   * SO EACH ROW NOW ANSWERS FOUR QUESTIONS, and every one of them is read off
   * something already written down:
   *
   *   what was asked   the brief the person typed into the node
   *                    (src/session-roles.js, the saved conversations)
   *   what it did      turns, model and tokens from the per-turn record
   *                    (shell/usage-record.cjs, read through readLocalUsage)
   *   what it said     the live stream while a turn is running, then the node's
   *                    own reply, then the last agent line in the saved
   *                    conversation
   *   what happened    the signed run record, exactly as before
   *
   * AND WHERE A PIECE GENUINELY IS NOT THERE THE ROW SAYS SO. A run started
   * from the agent page mints a session and writes it to the record and creates
   * no node at all, so it has no brief and no answer to join to -- that row says
   * that in one sentence rather than showing a gap that reads as a fault, and it
   * still shows what the turn record knows about it. Nothing here invents an ask
   * that was never recorded.
   *
   * THE ROW IS BUILT ONCE AND REPAINTED IN PLACE. Every line exists in the
   * markup and is hidden when there is nothing for it, so a word arriving from a
   * live agent is a textContent write on one span rather than a rebuild of the
   * list -- which would fight the scroll pin and re-animate rows a person is
   * reading.
   *
   * AND EACH ROW FOLDS, the way the chat's context block does. The owner's
   * words, with the two cards in front of him: "collapse the context and such
   * as it goes like we do in chat." The closed line is the run, its verdict,
   * one clipped line of what it was about, and when; the open body is the
   * question, the lines between, what it did, what it said back, and the door
   * to its real chat. A native <details> carries the state, the keyboard and
   * what a screen reader says; the press is owned (ownDisclosure) for the
   * measured reason recorded in src/components.js -- a press beside the
   * triangle lands on the details, not the summary, and would otherwise open
   * nothing. */
  function buildRunRow(run, index) {
    const row = el(`<li class="home-run"><details class="run-fold"><summary class="run-head">
      ${FOLD_MARK}
      <span class="run-identity"><button type="button" class="run-agent" hidden aria-pressed="false"></button><span class="run-what"></span><span class="run-location" hidden></span></span>
      <span class="run-overview"><span class="run-brief" hidden></span><span class="run-preview" hidden></span><span class="run-summary-work" hidden></span></span>
      <span class="run-status"><span class="run-state"><span class="run-state-mark" aria-hidden="true"></span><span class="run-state-label"></span></span><span class="run-action" hidden></span><span class="run-updated" hidden>New update</span><span class="run-result"></span><span class="run-live" hidden></span></span>
      <span class="run-when"></span>
    </summary><div class="run-body">
      <span class="run-asked" hidden></span>
      <span class="run-did" hidden></span><span class="run-current-work" hidden></span><span class="run-answer-label" hidden></span><div class="run-said" tabindex="0" role="region" aria-label="Agent reply" hidden></div><div class="run-answer-footer" hidden></div>
      <span class="run-why" hidden></span><span class="run-gap" hidden></span>
      <details class="run-transcript" hidden><summary>${FOLD_MARK}<span class="run-transcript-label"></span></summary><div class="run-turns" hidden></div></details>
      <a class="run-door home-next" hidden></a>
    </div></details></li>`)
    row.dataset.runSequence = String(run.sequence)
    const fold = row.querySelector('.run-fold')
    const head = row.querySelector('.run-head')
    /* OPEN BY DEFAULT ONLY FOR THE NEWEST. Runs arrive newest-first, so index 0
       is the one a person came to look at; the rest fold so the list is a list
       and not a wall. A remembered choice beats the default either way:
       'closed' on the newest stays closed, 'open' on an old one stays open. */
    const key = runOpenKey(run)
    const remembered = runOpen.recall(key)
    fold.open = remembered ? remembered === 'open' : index === 0
    const parts = {
      el: row,
      fold,
      key,
      /* Whether a person has ever said which way this row goes. While they have
         not, a run that starts working may open itself once (paintRunRow). */
      remembered: remembered !== null,
      revision: null,
      unread: false,
      autoOpened: !remembered && index === 0,
      turnsSignature: null,
      what: row.querySelector('.run-what'),
      result: row.querySelector('.run-result'),
      live: row.querySelector('.run-live'),
      action: row.querySelector('.run-action'),
      when: row.querySelector('.run-when'),
      agent: row.querySelector('.run-agent'),
      location: row.querySelector('.run-location'),
      brief: row.querySelector('.run-brief'),
      preview: row.querySelector('.run-preview'),
      statusMark: row.querySelector('.run-state-mark'),
      statusLabel: row.querySelector('.run-state-label'),
      updated: row.querySelector('.run-updated'),
      summaryWork: row.querySelector('.run-summary-work'),
      asked: row.querySelector('.run-asked'),
      transcript: row.querySelector('.run-transcript'),
      transcriptLabel: row.querySelector('.run-transcript-label'),
      turns: row.querySelector('.run-turns'),
      did: row.querySelector('.run-did'),
      currentWork: row.querySelector('.run-current-work'),
      said: row.querySelector('.run-said'),
      answerLabel: row.querySelector('.run-answer-label'),
      answerFooter: row.querySelector('.run-answer-footer'),
      why: row.querySelector('.run-why'),
      gap: row.querySelector('.run-gap'),
      door: row.querySelector('.run-door'),
    }
    /* FOLLOWING A LANE IS A PRESS ON ITS NAME. The agent picker above the list
       does the same thing, but a person reading a row should not have to carry
       the name up to a dropdown to see the rest of that lane's runs. The press
       is taken off the row's own disclosure: without stopPropagation the same
       click would also fold the row (ownDisclosure claims every press inside
       the head), and without preventDefault the summary's native toggle would
       fire underneath it. */
    parts.agent.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const key = parts.agentKey
      if (!key) return
      agentFilter = agentFilter === key ? '' : key
      rememberAgentPick()
      resolveChoice()
      agentPick.value = agentFilter
      paintRunScope()
      logEl.scrollTop = 0
      readingControls?.changed()
    })
    parts.door.addEventListener('click', event => {
      if (!takeoverSurface || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const saved = conversations?.get?.(run.sessionId)
      if (!saved?.computerId || !saved?.nodeId) return
      const id = `agent:${saved.computerId}:${saved.nodeId}`
      refreshTakeoverChoices()
      if (!takeoverChoices().some(subject => subject.id === id)) return
      event.preventDefault()
      takeoverSurface.show(id)
    })
    ownDisclosure(fold, {
      within: head,
      onToggle: (open) => {
        parts.remembered = true
        runOpen.remember(key, open)
        if (open) {
          parts.unread = false
          parts.updated.hidden = true
          delete row.dataset.updated
          paintRunScope()
        }
      },
    })
    ownDisclosure(parts.transcript, { within: parts.transcript.querySelector('summary') })
    addChatMessageCopy(row.querySelector('.run-body'), parts.said, parts.answerFooter)
    return parts
  }

  /* A line carries its value or it is not there. `hidden` rather than removal so
     the row keeps its shape across repaints and a live word lands on a span that
     already exists. */
  function setLine(node, value) {
    putText(node, value || '')
    if (node.hidden !== !value) node.hidden = !value
  }
  /* Rewrite a node's words only when they change: an identical rewrite still
     replaces the text node, which assistive technology and the layout both
     treat as new content, on every repaint of every row (T1579). */
  function putText(node, text) {
    const next = text == null ? '' : String(text)
    if (node.textContent !== next) node.textContent = next
  }

  /* One line of the saved conversation, through the same builder the
     coordinator thread uses so the two read in one register. No speaker dot:
     these are this computer's own roles, not the fleet's cast, and the agent's
     name comes off the RUN record rather than out of the line -- which is why
     the resolved label is overridden for the agent register and only there. */
  function runTurnNode(line, agentLabel) {
    const speaker = turnSpeaker(line.who, null)
    return turnNode({
      cls: speaker.cls,
      label: speaker.cls === 'is-agent' ? agentLabel : speaker.label,
      hue: '',
      text: line.text,
      surface: 'run',
    })
  }

  function paintRunRow(parts, run) {
    /* The run's own number, not a decorative index. It is the position in this
       computer's record, so it stays the same on every later visit and still
       means something after the list is truncated to its newest twenty. It also
       stops three runs started within a minute of each other from rendering as
       three identical rows reading "just now", which is honest and useless. */
    const live = run.sessionId ? liveSessions.get(run.sessionId) || null : null
    const work = run.sessionId ? summariseRunWork(usageBySession.get(run.sessionId)) : null
    const said = describeRun(run, conversations, state.nowMs, { work, live })
    const entry = conversations?.get?.(run.sessionId)
    const context = activityContext(run, entry, live, said)
    const disclosure = activityDisclosure({ previous: parts.revision, context, open: parts.fold.open, manual: parts.remembered, auto: autoContext, unread: parts.unread })
    parts.revision = disclosure.revision
    parts.unread = disclosure.unread
    parts.el.dataset.status = context.status.kind
    parts.statusMark.textContent = context.status.mark
    parts.statusLabel.textContent = context.status.label
    parts.statusLabel.title = context.status.label === ACTIVITY_LABELS.running ? 'Saved status; no live activity observed in this view yet.' : ''
    parts.updated.hidden = !parts.unread
    parts.el.toggleAttribute('data-updated', parts.unread)
    if (disclosure.changed && autoContext && !parts.remembered) {
      for (const other of runRows.values()) {
        if (other === parts || !other.autoOpened || other.remembered || ['working', 'attention'].includes(other.el.dataset.status)) continue
        if (other.el.contains(document.activeElement)) continue
        other.fold.open = false
        other.autoOpened = false
      }
    }
    if (!parts.fold.open && disclosure.open) {
      parts.autoOpened = true
      parts.fold.open = true
    }

    putText(parts.what, COPY.runLabel(said.sequence))
    /* Empty string for a run whose outcome was never recorded, and the
       data-attribute is set from the same value so the stylesheet cannot colour
       a row the copy declined to label. */
    putText(parts.result, said.resultWord)
    if (said.resultWord) parts.el.dataset.result = run.result
    else delete parts.el.dataset.result
    /* The one claim on this row that is not read back off a record: this window
       is watching that session's turn arrive, right now. It says what is
       happening and never how long it has been happening, because nothing
       writes down when a run ends. */
    setLine(parts.live, said.working ? COPY.runWorkingNow : '')
    parts.el.dataset.working = said.working ? 'true' : 'false'
    /* What it is doing right now, in the circle's words (home-circle-action.js),
       on the row's head so the list and the circle say the same thing. */
    const working = Boolean(said.working) || (sample && entry?.status === 'running')
    const doing = working ? (actionForLive(live) ? actionLabel(actionForLive(live), live.kind === 'text' ? 'reply' : live.tool || '')
      : sample ? (({ action, tool }) => actionLabel(action, tool))(sampleAction(run, Date.now(), SAMPLE_HEARTBEAT_MS)) : actionLabel('running')) : ''
    setLine(parts.action, doing)
    putText(parts.when, said.when)
    /* The exact instant on hover. The row itself stays relative, because a
       column of timestamps is a log and this is a list of what happened. */
    if (said.at) parts.when.title = said.at
    /* THE LANE IS THE FIRST THING ON THE ROW AND IT IS ALWAYS THERE WHEN THE
       RECORD KNOWS IT. It used to come only from the saved conversation, so a
       run whose conversation had not landed yet rendered as "Agent run 55" and
       nothing else -- the newest row, the one being looked at, was the one that
       could not say whose it was. run.agentId is the start record's own answer
       (src/local-activity.js). Where nothing recorded a lane the row still
       shows no name rather than inventing one, and its run number stands in as
       the identity. */
    parts.agentKey = run.agentId || said.agent || ''
    parts.computerId = entry?.computerId || run.computerId || null
    parts.agentName = entry?.displayName || said.agent || parts.agentKey
    setLine(parts.agent, parts.agentName)
    parts.agent.setAttribute('aria-pressed', String(Boolean(parts.agentKey) && agentFilter === parts.agentKey))
    parts.agent.title = parts.agentKey
      ? (agentFilter === parts.agentKey ? `Showing only ${parts.agentName}. Press to show every lane again.` : `Show only ${parts.agentName}`)
      : ''
    parts.el.dataset.lane = parts.agentKey
    /* For the circle: the example has no live stream, so its saved "running"
       head counts as working there and nowhere else. */
    parts.working = Boolean(said.working) || (sample && entry?.status === 'running')
    parts.liveRecord = live
    parts.runRecord = run
    parts.updatedAt = live?.updatedAt || run.atMs || 0
    setLine(parts.location, runLocations.get(run.sessionId))
    /* ONE ABSENCE, NOT A LIST OF THEM. A run with nothing recorded used to
       print both of its absences -- "No turns recorded." above "It has not
       answered yet." -- which spends two lines saying one thing, and printed
       the same line between a question and its answer on a row that had both.
       Work is reported when there is work; the absence of a turn count is said
       only when it is the only thing this row can say. */
    const workLine = said.did || (said.gap || context.answer ? '' : said.noWork)
    setLine(parts.summaryWork, workLine)
    /* AND NOT THE ABSENCE THIS ROW'S OWN STATUS LINE IS ALREADY REPORTING.
       Same rule as above, one step further out. A run still going carries
       "has not answered yet" as its absence, which is true -- and this row
       prints its state in words directly above, so the pair read as the panel
       saying one thing twice and cost a line on every live run in a list where
       three of them filled the panel. The reading is suppressed here, in the
       surface that draws the status, rather than in the record: a surface with
       no status line (the preview) still wants the sentence. The other three
       absences stay put, because nothing else on the row says any of them. */
    const statusSaysLive = said.working
      || context.status.label === ACTIVITY_LABELS.running
      || context.status.label === ACTIVITY_LABELS.starting
    const absence = statusSaysLive ? '' : said.gap
    // The brief and output preview keep a closed row useful. The body retains
    // the complete question and formatted answer.
    setLine(parts.brief, said.asked || said.why || absence)
    setLine(parts.asked, context.asked ? COPY.runAsked(context.asked) : '')
    /* THE LINES BETWEEN, rebuilt only when they changed. A cheap signature of
       the turns rather than a deep compare; the common repaint is a live word
       landing on .run-said, and that must not rebuild this block under a
       reader. */
    const turnsSignature = said.turns.map(line => `${line.who}:${line.text}`).join('\n')
    if (parts.turnsSignature !== turnsSignature) {
      parts.turnsSignature = turnsSignature
      parts.turns.replaceChildren(...said.turns.map(line => runTurnNode(line, COPY.turnAgent(said.agent))))
      parts.turns.hidden = said.turns.length === 0
      parts.transcript.hidden = said.turns.length === 0
      parts.transcriptLabel.textContent = TAKEOVER_COPY.conversation(said.turns.length)
    }
    setLine(parts.did, workLine)
    setLine(parts.currentWork, live?.activity || '')
    setLine(parts.answerLabel, context.answer ? COPY.runSaid('') : '')
    parts.answerFooter.hidden = !context.answer
    if (parts.answer !== context.answer) {
      parts.answer = context.answer
      setChatMessageBody(parts.said, context.answer)
      parts.said.hidden = !context.answer
    }
    setLine(parts.preview, activityPreview(context, parts.said.textContent))
    setLine(parts.why, context.detail)
    setLine(parts.gap, absence)
    /* THE DOOR TO THE RUN'S REAL CHAT, only where one exists: a run that has a
       node on the computers page, on a real machine. The example has no page
       to open, and a run started from elsewhere has no node to open to. */
    const hasDoor = !sample && Boolean(entry && entry.nodeId)
    parts.door.hidden = !hasDoor
    if (hasDoor) {
      parts.door.href = entry.computerId ? `${COPY.runDoor.href}/${encodeURIComponent(entry.computerId)}` : COPY.runDoor.href
      parts.door.textContent = COPY.runDoor.label
    }
  }

  let runsSignature = null
  /* The rows on the glass, by the run's own number, so a live word can find the
     one row it belongs to without walking the list. */
  const runRows = new Map()

  function paintRunScope() {
    /* The list and the predicate come first, so a remembered choice scopes
       the very first paint rather than the one after it. */
    paintAgentPick()
    coordinatorEmpty.hidden = !takeoverSubject || takeoverSubject.kind !== 'coordinator' || currentHomeView?.panel.context === true
    if (takeoverSubject) panelTitle.textContent = takeoverSubject.kind === 'everything' ? 'Recent activity' : takeoverSubject.label
    else if (scopeTitle) panelTitle.textContent = scopeTitle
    else if (agentFilter) panelTitle.textContent = agentNameFor(agentFilter)
    else if (currentHomeView) panelTitle.textContent = readerSentence(currentHomeView.panel.title)
    /* WHERE THE LIST CHANGES SUBJECT, said once instead of twenty-seven times.
     *
     * The panel is one run per line, newest first, and every line carries its
     * own relative time -- so a person reading down it gets "2 minutes ago",
     * "4 minutes ago", "52 minutes ago", "2 hours ago", "yesterday" with
     * nothing to tell them they have crossed from this morning into last week.
     * Measured on the running example at 1440x900: 27 rows, every one 44px
     * tall, every one the same shape, spanning "just now" to "2 days ago" with
     * no landmark anywhere in the column. That is what makes it read as a dump
     * rather than a record.
     *
     * The heading is set HERE rather than in renderRuns because the filters
     * hide rows (`parts.el.hidden` above), and a heading over a run that is
     * not on the glass is a heading over nothing. This runs after the row's
     * visibility is decided, in the same pass, so the label always lands on the
     * first run a person can actually see in that stretch of time.
     *
     * THE BOUNDARIES ARE THE ONES THE ROW'S OWN WORDS USE (local-activity.js
     * whenWords: minutes under an hour, hours under a day, then days), and the
     * labels are elapsed rather than calendar, so no heading can ever
     * contradict the line under it -- "in the last day" over "18 hours ago" is
     * true wherever midnight happens to fall. A run whose record never wrote
     * down when it started gets no heading and does not close the one above it:
     * a label is a claim, and there is nothing here to claim.
     *
     * The heading is DRAWN by home-context.css off this attribute rather than
     * built as its own <li>: renderRuns places rows by index into the same
     * list (`list.children[index]`), so a separator element living in that list
     * would have to be counted by every insertion, and the row order is the
     * one thing on this screen that must not drift. */
    let lastRunGroup = null
    const runGroupsSeen = new Set()
    for (const run of state.sessions.runs || []) {
      const parts = runRows.get(run.sequence)
      if (!parts) continue
      parts.inScope = subjectMatchesRun(takeoverSubject, run, conversations?.get?.(run.sessionId))
        && keepForChoice(parts)
      if (activityFilter === 'updated' && parts.unread) parts.keepUpdated = true
      parts.el.hidden = !parts.inScope || !activityMatches(activityFilter, parts.el.dataset.status, parts.unread || parts.keepUpdated)
      const age = parts.el.hidden || !Number.isFinite(run.atMs) || !Number.isFinite(state.nowMs)
        ? null
        : state.nowMs - run.atMs
      const group = age === null || age < 0 ? null
        : age < 3_600_000 ? 'In the last hour'
          : age < 86_400_000 ? 'In the last day'
            : age < 604_800_000 ? 'In the last week'
              : 'Older than a week'
      /* Once each, and only where the subject actually changes. The set is the
         guard against a record that is not in time order printing the same
         heading twice half a list apart. */
      const heading = group && group !== lastRunGroup && !runGroupsSeen.has(group) ? group : ''
      if (group) lastRunGroup = group
      if (heading) { runGroupsSeen.add(heading); parts.el.dataset.group = heading }
      else if (parts.el.dataset.group) delete parts.el.dataset.group
      /* Which lane is being followed is a state of the name, not of the
         dropdown alone, so it is refreshed here rather than only on repaint. */
      const followed = Boolean(parts.agentKey) && oneLaneSelected() && agentFilter === parts.agentKey
      parts.agent.setAttribute('aria-pressed', String(followed))
      if (parts.agentKey) parts.agent.title = followed ? `Showing only ${parts.agentName}. Press to show every lane again.` : `Show only ${parts.agentName}`
    }
    const scoped = [...runRows.values()].filter(parts => parts.inScope)
    const filtered = takeoverSubject ? takeoverSubject.kind !== 'coordinator' : runRows.size > 0
    scopeEmpty.hidden = !filtered || scoped.some(parts => !parts.el.hidden) || (activityFilter === 'all' && !threadBundle.hidden)
    scopeEmpty.textContent = scoped.length
      ? 'No runs match this status. Choose All runs to see the rest of this view.'
      : takeoverSubject?.kind === 'everything'
        ? 'No recorded runs yet.'
        : takeoverSubject
          ? 'No recorded runs in this view. Choose Everything to see all recent runs.'
          : 'No recorded runs for this choice. Choose All trees to see all recent runs.'
    paintActivityOverview()
    paintGlance()
    paintCircleAction()
    paintAgentBoard()
    paintPanelMode()
  }

  /* THE PICKED AGENT'S CHAT. Inserted, not built: mountChatTakeover is the same
     module the full view uses for an agent subject, given exactly one choice.
     On the example it is the demonstration chat; on a fleet it is the agent's
     real surface through the shared workspace pool (a tree node or a saved
     conversation) or the session surface for a named speaker. It comes down
     again whenever the panel shows All agents, Summary, or moves into Full
     view, which has its own. */
  let panelChat = null
  let panelWorkspacePool = null
  /* An agent's name for the panel heading: its run rows, else the tree
     store's own name for it (the picker's), else the conversation choice.
     An agent with no run record (auditing off, a fresh install, never run)
     used to be headed by its internal node id (T1515). */
  function agentNameFor(agentKey) {
    const fromRuns = [...runRows.values()].find(parts => parts.agentKey === agentKey)?.agentName
    if (fromRuns) return fromRuns
    for (const record of treeRecords) {
      const name = record.memberNames?.[agentKey]
      if (typeof name === 'string' && name) return name
    }
    const subject = takeoverChoices().find(choice => choice.kind === 'agent' && !choice.newChat && choice.agentId === agentKey)
    return subject?.name || subject?.label || agentKey
  }
  function subjectForAgent(agentKey) {
    const choices = takeoverChoices().filter(choice => choice.kind === 'agent' && !choice.newChat && choice.agentId === agentKey)
    const row = [...runRows.values()].find(parts => parts.agentKey === agentKey)
    return choices.find(choice => choice.computerId) || choices[0]
      || { id: `agent:${agentKey}`, kind: 'agent', agentId: agentKey, label: row?.agentName || agentKey, name: row?.agentName || '', role: row?.agentRole || '' }
  }
  /* THE EXAMPLE AGENT'S HISTORY AND STATUS for the panel's chat: what page 2
     takes from its tree store, this page takes from the agent's recorded runs
     (oldest first: 'you' asks, action rows and the agent's answers), so the
     chat opens on the same conversation the run list shows. */
  function sampleChatFor(agentKey) {
    const rows = [...runRows.values()].filter(parts => parts.agentKey === agentKey && parts.runRecord)
    rows.sort((a, b) => (a.runRecord.atMs || 0) - (b.runRecord.atMs || 0))
    const history = []
    for (const parts of rows) {
      let said = null
      try { said = describeRun(parts.runRecord, conversations, state.nowMs, { work: null, live: null }) } catch { said = null }
      /* describeRun keeps the ask (`asked`, raw) and the answer (`said`)
         apart from the middle `turns`; page 2's example history is you, then
         the conversation, then the agent. Action rows are the run list's. */
      const asked = typeof said?.asked === 'string' ? said.asked.trim() : ''
      if (asked) history.push({ who: 'you', text: asked, at: null })
      for (const line of Array.isArray(said?.turns) ? said.turns : []) {
        if (line && typeof line.text === 'string' && line.text.trim() && line.who !== 'action') history.push({ who: line.who === 'you' ? 'you' : 'agent', text: line.text, at: null })
      }
      const answer = typeof said?.said === 'string' ? said.said.trim() : (typeof parts.answer === 'string' ? parts.answer.trim() : '')
      if (answer) history.push({ who: 'agent', text: answer, at: null })
    }
    const latest = rows[rows.length - 1]
    const status = latest ? latest.el.dataset.status : ''
    const statusKey = latest?.working ? 'running' : status === 'finished' ? 'finished' : status === 'attention' ? 'failed' : ''
    return { history, statusKey }
  }
  function paintPanelMode() {
    /* Home's destroy() tears the panel down before the Full view, and the Full
       view's release repaints the scope; a panel chat mounted then got a new
       workspace pool that nothing would destroy, leaking a hidden Computers
       view each time (T1528). */
    if (destroyed) return
    const single = oneLaneSelected() && !takeoverSubject && !takeoverSurface
    modeGroup.hidden = !single
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.homeModeChoice === agentMode))
    feed.dataset.mode = single && agentMode === 'chat' ? 'chat' : 'summary'
    const subject = single && agentMode === 'chat' ? subjectForAgent(agentFilter) : null
    placePicker(Boolean(subject))
    if (subject) { modeGroup.hidden = true; const label = subject.label || ''; if (chatToolbarName.textContent !== label) chatToolbarName.textContent = label }
    if (!subject) {
      if (panelChat) { panelChat.mount.destroy(); panelChat = null; chatHost.replaceChildren() }
      chatHost.hidden = true
      sessionView.hidden = false
      return
    }
    if (panelChat?.subjectId === subject.id) return
    if (panelChat) { panelChat.mount.destroy(); chatHost.replaceChildren() }
    const mount = mountChatTakeover(chatHost, {
      choices: [subject], subjectId: subject.id, live: !sample, sampleChats: true, draftStore: takeoverDrafts,
      sampleChat: subj => sampleChatFor(subj.agentId),
      renderAgent: (host, subj, drafts) => {
        if (destroyed) return null
        panelWorkspacePool ||= createHomeAgentWorkspacePool()
        return panelWorkspacePool.mount(host, subj, drafts.forConversation ? drafts.forConversation(subj) : drafts, {})
      },
      renderTranscript: host => {
        const note = el('<p class="home-scope-empty">This agent has no conversation to open here yet. Its runs are under Summary.</p>')
        host.appendChild(note)
        return () => note.remove()
      },
    })
    panelChat = { mount, subjectId: subject.id }
    chatHost.hidden = false
    sessionView.hidden = true
  }

  /* THE DROPDOWN: All trees, then each tree with its agents grouped under it,
     then the agents in no tree (home-activity.js treePickGroups). A native
     <select> with <optgroup>s: the group's label is the tree's name, which is
     what a screen reader announces around each agent and what the arrow keys
     skip, and the first entry under it is the tree itself as a scope, carrying
     its counts. Rebuilt only when the entries change, so an open menu is never
     yanked shut by a repaint; the working counts are part of the signature, so
     a tree's entry does update when an agent under it starts or stops. */
  let agentPickSignature = ''
  function paintAgentPick() {
    treeRecords = treeFilterRecords()
    const groups = treePickGroups([...runRows.values()].filter(parts => parts.agentKey), treeRecords)
    const choices = treePickChoices(groups)
    resolveChoice()
    const signature = choices.map(choice => `${choice.kind}:${choice.id}=${choice.label}|${choice.heading || ''}`).join('|')
    if (signature !== agentPickSignature) {
      agentPickSignature = signature
      const option = choice => {
        const node = document.createElement('option')
        node.value = choice.id
        node.textContent = choice.label
        node.dataset.kind = choice.kind
        return node
      }
      agentPick.replaceChildren(...groups.map(group => {
        if (group.kind === 'all') return option(group)
        const set = document.createElement('optgroup')
        set.label = group.heading
        if (group.kind === 'tree') set.append(option(group))
        set.append(...group.agents.map(option))
        return set
      }))
      /* A remembered choice that names nothing here is dropped -- but only
         once the list has something in it. Before the rows land the list is
         "All trees" alone, and forgetting the choice then would forget the
         agent every time the page opened. */
      if (choices.length > 1 && !choices.some(choice => choice.id === agentFilter)) { agentFilter = ''; rememberAgentPick(); resolveChoice() }
      agentPick.value = agentFilter
    }
    agentPick.hidden = choices.length < 2 || (takeoverSubject && takeoverSubject.kind === 'coordinator')
  }

  /* ---- AGENTS AT A GLANCE ----
     One <details> per agent, kept by key across repaints so an open one
     stays open and a word arriving for a live agent is a textContent write on
     a span that already exists. Every word is read off the run rows already
     on the glass (paintRunRow), so this board cannot say something the list
     under it does not; home-activity.js agentBoardLines turns those rows
     into lines and is called with values by tools/test/home-agent-board.test.mjs. */
  const boardList = boardSlot.querySelector('[data-roster-body]')
  const boardSummary = boardSlot.querySelector('[data-agents-summary]')
  const boardLedger = boardSlot.querySelector('[data-agents-ledger]')
  const boardEmpty = boardSlot.querySelector('[data-agents-empty]')
  const rosterSearch = boardSlot.querySelector('[data-roster-search]')
  const rosterStatus = boardSlot.querySelector('[data-roster-status]')
  const rosterFilterNote = boardSlot.querySelector('[data-roster-filter-note]')
  const rosterCount = boardSlot.querySelector('[data-roster-count]')
  rosterSearch.addEventListener('input', () => paintAgentBoard())
  rosterStatus.addEventListener('change', () => paintAgentBoard())
  boardSlot.querySelector('[data-roster-reset]').addEventListener('click', () => {
    rosterSearch.value = ''; rosterStatus.value = 'all'; paintAgentBoard(); rosterSearch.focus()
  })
  const agentLines = new Map()
  const boardSections = new Map()
  let boardOrder = ''
  /* The two presses a line offers, and both are the picker's own moves: Chat
     is exactly choosing the agent in the dropdown; Show its runs is the same
     choice held in Summary, which is what pressing the name on a run row does. */
  function chooseAgent(key, mode) {
    if (takeoverSurface && mode === 'chat') {
      refreshTakeoverChoices()
      const subject = subjectForAgent(key)
      if (subject) takeoverSurface.openConversation(subject)
      return
    }
    if (mode === 'chat') rememberListBeforeChat(key)
    agentFilter = key
    rememberAgentPick()
    resolveChoice()
    agentMode = mode
    rememberAgentMode()
    agentPick.value = agentFilter
    paintRunScope()
    logEl.scrollTop = 0
    readingControls?.changed()
  }
  function buildRosterRow(key) {
    const node = el(`<tr class="home-roster-row"><td class="home-roster-content"><div class="home-roster-identity"><span class="home-roster-mono" aria-hidden="true"></span><span class="home-roster-name"></span><span class="home-roster-pill"><span class="home-roster-dot" aria-hidden="true"></span><span class="home-roster-word"></span></span></div><span class="home-roster-doing-text"></span><span class="home-roster-facts"></span></td><td class="home-roster-actions"><span class="home-roster-since"></span><button type="button" class="home-roster-chat">${escText(AGENT_BOARD.chat)}</button><button type="button" class="home-roster-details" aria-expanded="false">Details</button></td></tr>`)
    node.dataset.key = key
    const parts = {
      el: node, key,
      mono: node.querySelector('.home-roster-mono'), name: node.querySelector('.home-roster-name'),
      word: node.querySelector('.home-roster-word'), doing: node.querySelector('.home-roster-doing-text'),
      since: node.querySelector('.home-roster-since'), chat: node.querySelector('.home-roster-chat'),
      facts: node.querySelector('.home-roster-facts'),
      details: node.querySelector('.home-roster-details'),
    }
    parts.chat.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      chooseAgent(key, 'chat')
      // the chat opened in this panel: focus moves into it (T1499)
      if (!takeoverSurface && !chatToolbar.hidden) chatBack.focus?.({ preventScroll: true })
    })
    parts.details.addEventListener('click', event => { event.stopPropagation(); selectRosterRow(key) })
    /* Details has native keyboard semantics; Chat never toggles the pane. */
    node.addEventListener('click', () => selectRosterRow(key))
    return parts
  }
  /* A round monogram per agent (home-activity.js agentMonogram) and a hue
     that is stable for the name, so the same agent is the same mark. */
  const monogramOf = agentMonogram
  const hueOf = name => { let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h }
  let rosterSelected = ''
  let rosterLines = new Map()
  function selectRosterRow(key) {
    rosterSelected = rosterSelected === key ? '' : key
    paintRosterDetail()
  }
  const detailPane = boardSlot.querySelector('[data-roster-detail]')
  /* The pane sits in the table, right under the row it belongs to, so it is
     never off the bottom of a long roster. */
  const detailRow = el('<tr class="home-roster-detail-row"><td colspan="2"></td></tr>')
  detailRow.querySelector('td').appendChild(detailPane)
  const detailParts = {
    name: detailPane.querySelector('[data-detail-name]'), state: detailPane.querySelector('[data-detail-state]'),
    task: detailPane.querySelector('[data-detail-task]'), asked: detailPane.querySelector('[data-detail-asked]'),
    result: detailPane.querySelector('[data-detail-result]'), waiting: detailPane.querySelector('[data-detail-waiting]'),
    now: detailPane.querySelector('[data-detail-now]'), history: detailPane.querySelector('[data-detail-history]'),
    chat: detailPane.querySelector('[data-detail-chat]'), runs: detailPane.querySelector('[data-detail-runs]'),
    rows: Object.fromEntries([...detailPane.querySelectorAll('[data-detail-row]')].map(row => [row.dataset.detailRow, row])),
  }
  detailPane.querySelector('[data-detail-close]').addEventListener('click', () => { const button = agentLines.get(rosterSelected)?.details; rosterSelected = ''; paintRosterDetail(); button?.focus() })
  detailParts.chat.addEventListener('click', () => { if (rosterSelected) chooseAgent(rosterSelected, 'chat') })
  detailParts.runs.addEventListener('click', () => { if (rosterSelected) chooseAgent(rosterSelected, 'summary') })
  function paintRosterDetail() {
    const line = rosterSelected ? rosterLines.get(rosterSelected) : null
    for (const parts of agentLines.values()) {
      const selected = Boolean(line) && parts.key === rosterSelected
      parts.el.classList.toggle('is-selected', selected)
      parts.details.setAttribute('aria-expanded', String(selected))
    }
    detailPane.hidden = !line
    if (!line) { detailRow.remove(); return }
    const rowParts = agentLines.get(rosterSelected)
    if (rowParts && detailRow.previousElementSibling !== rowParts.el) rowParts.el.after(detailRow)
    detailPane.dataset.state = line.state
    writeText(detailParts.name, line.name)
    writeText(detailParts.state, line.word)
    const put = (row, node, value) => { const text = value || ''; detailParts.rows[row].hidden = !text; if (node.textContent !== text) node.textContent = text }
    put('task', detailParts.task, line.task)
    put('asked', detailParts.asked, line.asked)
    put('result', detailParts.result, line.result)
    put('waiting', detailParts.waiting, line.waiting)
    put('detail', detailParts.now, line.detail)
    const history = Array.isArray(line.history) ? line.history.filter(Boolean) : []
    detailParts.rows.history.hidden = history.length === 0
    const joined = history.join(' || ')
    if (detailParts.history.dataset.joined !== joined) {
      detailParts.history.dataset.joined = joined
      detailParts.history.replaceChildren(...history.map(text => { const item = document.createElement('li'); item.textContent = text; return item }))
    }
    detailParts.chat.title = AGENT_BOARD.chatWith(line.name)
    detailParts.runs.title = AGENT_BOARD.showRunsOf(line.name)
  }
  const writeText = (node, text) => { if (node.textContent !== text) node.textContent = text }
  function paintAgentBoard() {
    const rows = (state.sessions.runs || []).map(run => runRows.get(run.sequence)).filter(parts => parts?.agentKey && parts.inScope).map(parts => ({
      agentKey: parts.agentKey, agentName: parts.agentName, working: parts.working, status: parts.el.dataset.status,
      statusLabel: parts.statusLabel.textContent, doing: parts.action.hidden ? '' : parts.action.textContent,
      when: parts.when.textContent, atMs: parts.runRecord?.atMs, brief: parts.brief.hidden ? '' : parts.brief.textContent,
      tool: parts.liveRecord?.tool || '', events: parts.liveRecord?.events || 0,
      asked: parts.asked.hidden ? '' : parts.asked.textContent, answer: parts.answer || '',
      why: parts.why.hidden ? '' : parts.why.textContent, gap: parts.gap.hidden ? '' : parts.gap.textContent,
    }))
    const board = agentBoardLines(rows, treePickGroups(rows, treeRecords), { nowMs: state.nowMs, keep: keepForChoice, showAll: true })
    const filtered = filterRosterGroups(board.groups, { query: rosterSearch.value, status: rosterStatus.value })
    rosterFilterNote.hidden = !filtered.active
    writeText(rosterCount, `${filtered.count} of ${board.agents} agents`)
    const coordinator = Boolean(takeoverSubject && takeoverSubject.kind === 'coordinator')
    const treePicked = agentFilter.startsWith(TREE_CHOICE_PREFIX)
    const shown = !coordinator && (board.groups.length > 0 || treePicked)
    boardSlot.hidden = !shown
    boardEmpty.hidden = !(shown && filtered.groups.length === 0)
    writeText(boardEmpty, filtered.active ? 'No agents match these filters.' : AGENT_BOARD.emptyTree)
    /* The board is the list for a tree or all trees; the run list shows
       under one picked agent's card. The run tabs count runs, not agents. */
    runsSlot.hidden = shown && !oneLaneSelected()
    const tabs = root.querySelector('.activity-filters')
    if (tabs) tabs.hidden = shown && !oneLaneSelected()
    const overview = root.querySelector('[data-activity-overview]')
    if (overview) overview.hidden = shown && !oneLaneSelected() // the run counts row: an empty band with a rule while the board is the list
    if (!shown) return
    const nodes = []
    const seen = new Set()
    rosterLines = new Map()
    const rowNode = (line, loose) => {
      let parts = agentLines.get(line.key)
      if (!parts) { parts = buildRosterRow(line.key); agentLines.set(line.key, parts) }
      seen.add(line.key)
      rosterLines.set(line.key, line)
      if (parts.el.dataset.state !== line.state) parts.el.dataset.state = line.state
      writeText(parts.name, line.name)
      writeText(parts.mono, monogramOf(line.name))
      if (loose) { parts.mono.classList.add('is-loose'); parts.mono.style.removeProperty('--rc'); parts.mono.style.removeProperty('--role-ink') }
      else { parts.mono.classList.remove('is-loose'); paintRoleColor(parts.mono, roleOfAgent(line.key) || 'default', line.key) }
      const facts = ROSTER.facts(line)
      writeText(parts.facts, facts)
      parts.facts.title = facts
      parts.facts.hidden = !facts
      writeText(parts.word, line.word)
      writeText(parts.doing, line.task || '')
      parts.doing.title = line.task || ''
      writeText(parts.since, line.since || '')
      parts.chat.title = AGENT_BOARD.chatWith(line.name)
      parts.chat.setAttribute('aria-label', `Chat with ${line.name}`)
      parts.details.setAttribute('aria-label', `Details for ${line.name}`)
      return parts.el
    }
    const showHeads = board.groups.length > 1
    for (const group of filtered.groups) {
      let section = boardSections.get(group.key)
      if (!section) {
        const node = el('<tr class="home-roster-group"><th scope="rowgroup" colspan="2"><span class="home-roster-group-name"></span><span class="home-roster-group-count"></span></th></tr>')
        node.dataset.key = `group:${group.key}`
        section = { el: node, name: node.querySelector('.home-roster-group-name'), count: node.querySelector('.home-roster-group-count') }
        boardSections.set(group.key, section)
      }
      writeText(section.name, group.name)
      writeText(section.count, String(group.count))
      if (showHeads) nodes.push(section.el)
      for (const line of [...group.lines, ...group.rest]) nodes.push(rowNode(line, group.kind === 'loose'))
    }
    for (const key of [...agentLines.keys()]) if (!seen.has(key)) agentLines.delete(key)
    for (const key of [...boardSections.keys()]) if (!board.groups.some(group => group.key === key)) boardSections.delete(key)
    const order = nodes.map(node => node.dataset.key).join('|')
    if (order !== boardOrder) { boardOrder = order; boardList.replaceChildren(...nodes) }
    if (rosterSelected && !rosterLines.has(rosterSelected)) rosterSelected = ''
    paintRosterDetail()
    /* The strip as stats: each figure a size up, its word beside it. */
    const stripItems = AGENT_BOARD.strip(board.agents, board.working, board.attention).split(' · ')
    const stripKey = stripItems.join('|')
    if (boardSummary.dataset.key !== stripKey) {
      boardSummary.dataset.key = stripKey
      boardSummary.replaceChildren(...stripItems.map(item => {
        const [figure, ...words] = item.split(' ')
        const span = el('<span class="home-agents-stat"><b></b><span></span></span>')
        span.querySelector('b').textContent = figure
        span.querySelector('span').textContent = words.join(' ')
        return span
      }))
    }
    /* What the LEDGER is waiting on, fleet-wide, from the summary the page
       already keeps (home-ledger-status.js): shown only when something is. */
    const ledger = state.ledgerStatus
    const owed = Boolean(ledger) && (ledger.asks > 0 || ledger.blockers > 0)
    boardLedger.hidden = !owed
    if (owed) writeText(boardLedger, ledger.label)
  }

  /* Follow the first visible run in the panel's newest-first order. Map
     insertion order is different after a new run arrives, so use the same
     records that renderRuns uses to order the list. */
  function paintCircleAction() {
    const rows = (state.sessions.runs || []).map(run => runRows.get(run.sequence))
      .filter(parts => parts?.inScope && !parts.el.hidden && parts.agentKey)
    /* The circle follows the tree's MOST ACTIVE agent when a tree is chosen:
       one that is working, else one that needs the owner, else the newest. */
    const kept = rows.filter(parts => keepForChoice(parts))
    const row = kept.find(parts => parts.working) || kept.find(parts => parts.el.dataset.status === 'attention') || kept[0] || null
    let action = 'idle', tool = '', event = 0
    if (row) {
      const live = row.liveRecord
      const fromLive = actionForLive(live)
      if (fromLive) { action = fromLive; tool = live.kind === 'text' ? 'reply' : live.tool || ''; event = live.events || 0 }
      else if (row.working && sample) ({ action, tool, event } = sampleAction(row.runRecord, Date.now(), SAMPLE_HEARTBEAT_MS))
      else if (row.working) action = 'running'
      else if (row.el.dataset.status === 'attention') action = 'waiting'
    }
    const name = row ? row.agentName : ''
    const key = row ? row.agentKey : ''
    for (const parts of runRows.values()) parts.el.toggleAttribute('data-followed', parts === row)
    if (ring.el.dataset.agentAction !== action) { ring.el.dataset.agentAction = action; if (!destroyed) paintCircleStyle() }
    if (ring.el.dataset.agentTool !== tool) ring.el.dataset.agentTool = tool
    if (ring.el.dataset.agentName !== name) ring.el.dataset.agentName = name
    if (ring.el.dataset.agentKey !== key) ring.el.dataset.agentKey = key
    const eventValue = String(event)
    if (ring.el.dataset.agentEvent !== eventValue) ring.el.dataset.agentEvent = eventValue
    const label = actionLabel(action, tool) || (row ? row.el.dataset.status === 'finished' ? 'finished' : 'no current activity' : '')
    agentLine.hidden = !name || !label
    const [who, what] = agentLine.children
    if (who.textContent !== name) who.textContent = name
    if (what.textContent !== label) what.textContent = label
  }

  /* At a glance (home-overview.js): four figures from every run this view knows, not only the scoped ones. */
  const glance = root.querySelector('[data-home-glance]')
  const glanceValues = Object.fromEntries([...root.querySelectorAll('[data-glance]')].map(node => [node.dataset.glance, node]))
  function paintGlance() {
    const { figures, states, shown } = glanceFigures((state.sessions.runs || [])
      .map(run => runRows.get(run.sequence)).filter(Boolean).map(parts => ({
        agentKey: parts.agentKey, computerId: parts.computerId,
        atMs: parts.runRecord?.atMs,
        /* On the example the panel and the circle count the saved running
           head as work (parts.working), so the strip does too; it said
           'Working 0' beside '1 working' (T1481). A live computer keeps the
           rule that only an observed stream is work. */
        status: sample && parts.working ? 'working' : parts.el.dataset.status,
      })))
    for (const [key, value] of Object.entries(figures)) {
      const text = String(value)
      if (glanceValues[key] && glanceValues[key].textContent !== text) glanceValues[key].textContent = text
    }
    for (const [key, on] of Object.entries(states)) {
      const value = String(on)
      if (glance.dataset[key] !== value) glance.dataset[key] = value
    }
    glance.hidden = !shown
  }
  function paintActivityOverview() {
    activityOverview.hidden = runRows.size === 0
    const scoped = [...runRows.values()].filter(parts => parts.inScope !== false)
    const count = TAKEOVER_COPY.recentRuns(scoped.length)
    if (activityCount.textContent !== count) activityCount.textContent = count
    const working = scoped.filter(parts => parts.el.dataset.working === 'true').length
    const workingText = TAKEOVER_COPY.workingRuns(working)
    if (activityWorking.textContent !== workingText) activityWorking.textContent = workingText
    activityWorking.hidden = working === 0
    for (const button of activityFilters) {
      const filter = button.dataset.activityFilter
      button.setAttribute('aria-pressed', String(activityFilter === filter))
      const countEl = button.querySelector('[data-filter-count]')
      const value = String(scoped.filter(parts => activityMatches(filter, parts.el.dataset.status, parts.unread)).length)
      if (countEl.textContent !== value) countEl.textContent = value
      button.hidden = value === '0' && filter !== 'all' && activityFilter !== filter
    }
  }
  collapseDetails.addEventListener('click', () => {
    for (const parts of runRows.values()) {
      if (parts.el.hidden) continue
      parts.fold.open = false
      parts.transcript.open = false
      parts.remembered = true
      runOpen.remember(parts.key, false)
    }
  })

  function activityAnchor() {
    if (logEl.scrollTop < 8 || (takeoverSubject && takeoverSubject.kind === 'coordinator')) return null
    const top = logEl.getBoundingClientRect().top
    const row = [...runRows.values()].find(parts => !parts.el.hidden && parts.el.getBoundingClientRect().bottom > top)
    return row ? { el: row.el, offset: row.el.getBoundingClientRect().top - top } : null
  }
  function restoreActivityAnchor(anchor) {
    if (anchor?.el.isConnected && !anchor.el.hidden) {
      logEl.scrollTop += anchor.el.getBoundingClientRect().top - logEl.getBoundingClientRect().top - anchor.offset
    }
  }

  function renderRuns(view) {
    currentHomeView = view
    const listed = (takeoverSubject && takeoverSubject.kind !== 'coordinator') || (view.panel.runs && !view.panel.empty) ? state.sessions.runs : []
    const anchor = activityAnchor()
    const signature = `${view.panel.runs}|${listed.map(run => `${run.sequence}:${run.sessionId || ''}`).join(',')}`
    if (runsSignature !== signature) {
      const initial = runsSignature === null
      runsSignature = signature
      let list = runsSlot.querySelector('.home-runs')
      if (!list && listed.length) {
        list = el('<ol class="home-runs"></ol>')
        runsSlot.appendChild(list)
      }
      const kept = new Set(listed.map(run => run.sequence))
      for (const [sequence, parts] of runRows) {
        if (!kept.has(sequence)) { parts.el.remove(); runRows.delete(sequence) }
      }
      listed.forEach((run, index) => {
        let parts = runRows.get(run.sequence)
        if (parts && parts.key !== runOpenKey(run)) {
          parts.el.remove()
          runRows.delete(run.sequence)
          parts = null
        }
        if (!parts) {
          parts = buildRunRow(run, index)
          runRows.set(run.sequence, parts)
        }
        // Leave retained rows in place, including their focused controls and
        // independent transcript disclosures. Only insertions change order.
        if (list.children[index] !== parts.el) list.insertBefore(parts.el, list.children[index] || null)
      })
      if (!listed.length) list?.remove()
      if (initial && !view.panel.context) {
        pinned = false
        logEl.scrollTop = 0
      }
    }
    for (const run of listed) {
      const parts = runRows.get(run.sequence)
      if (parts) paintRunRow(parts, run)
    }
    paintRunScope()
    restoreActivityAnchor(anchor)
  }

  /* ---- THE DEMONSTRATION'S OWN HEARTBEAT ----
   *
   * Owner, 2026-08-26: "make it move ... just make it feel alive a bit."
   * src/sample-activity.js now emits a rolling head whose newest run is left
   * unresolved, so the example fleet gains a run and finishes one as the clock
   * advances -- but only if something re-reads it. This is that something.
   *
   * ONLY UNDER THE EXAMPLE, and the guard is the same `sample` question the
   * loader itself asks. On a real machine the record changes when the machine
   * does, and a timer re-reading it on a cadence would be inventing activity on
   * somebody's screen -- the opposite of what this whole file is careful about.
   *
   * The interval matches the sample's own slot length, so it lands about once
   * per new run rather than repainting for nothing. It goes through the normal
   * loader, so the example takes the same join and the same render as a real
   * record; nothing here paints anything itself. */
  let sampleTick = 0
  /* The example's working run walks the circle through its repertoire as the
     slot ages (home-circle-action.js sampleAction), so the circle is re-asked
     a few times a slot. Example only, for the same reason the heartbeat is. */
  let sampleActionTick = 0
  function startSampleHeartbeat() {
    if (sampleTick || !sample) return
    if (!sampleActionTick) sampleActionTick = setInterval(() => {
      if (destroyed || !sample) return
      /* The rows' "doing" words follow the same staged turn as the circle. */
      for (const run of state.sessions.runs || []) {
        const parts = runRows.get(run.sequence)
        if (parts?.working) setLine(parts.action, (({ action, tool }) => actionLabel(action, tool))(sampleAction(run, Date.now(), SAMPLE_HEARTBEAT_MS)))
      }
      paintCircleAction()
    }, 2500)
    /* Phase-offset for the same reason the health poll is, and it matters more
       here: this heartbeat and the health poll carry the SAME 45s period, so
       two of them born in one mount would share every single wake rather than
       one in nine. */
    scheduleSample(SAMPLE_HEARTBEAT_MS + pollPhaseOffsetMs('home:sample'))
  }
  function scheduleSample(waitMs) {
    /* Left non-zero for the whole life of the loop, so `if (sampleTick)` above
       still means "already running" and destroy() always has a handle to
       clear -- see the same note on scheduleHealth.
       Use the same resolved example choice as loadSessions. An unconfigured
       fleet can still read real local records; it must never enter this loop.
       A changed data-source choice takes effect in the next mounted view. */
    sampleTick = setTimeout(() => {
      if (destroyed) return
      scheduleSample(SAMPLE_HEARTBEAT_MS)
      if (!sample) return
      void loadSessions()
    }, waitMs)
  }

  /* ---- THE FLOW'S LIVE HALF ----
   *
   * One repaint of the rows a live session touched, on a trailing timer, so a
   * turn arriving forty words a second is a handful of repaints rather than
   * forty. Nothing is read off a record here. */
  let liveRepaintTimer = 0
  const dirtySessions = new Set()
  function paintLiveSoon(sessionId) {
    dirtySessions.add(sessionId)
    if (liveRepaintTimer) return
    liveRepaintTimer = setTimeout(() => {
      liveRepaintTimer = 0
      if (destroyed) return
      const anchor = activityAnchor()
      const touched = new Set(dirtySessions)
      dirtySessions.clear()
      for (const run of state.sessions.runs) {
        if (!run.sessionId || !touched.has(run.sessionId)) continue
        const parts = runRows.get(run.sequence)
        if (parts) paintRunRow(parts, run)
      }
      paintRunScope()
      restoreActivityAnchor(anchor)
    }, LIVE_REPAINT_MS)
  }

  /* ---- the conversation half ----
     `contextNotice` is what the SOURCE has to say for itself while it loads,
     fails, or turns out to be empty. Deliberately not part of the decision:
     those states depend on the moment rather than on what is true of the
     machine, which is why this copy has always lived in the view. */
  let contextNotice = null
  function renderContext(view) {
    const kind = view.panel.kind
    if (renderedPanelKind !== kind) {
      renderedPanelKind = kind
      turnsSignature = null
      contextNotice = null
      if (kind === 'conversation') {
        noteContext([])
        contextNotice = { ...COPY.conversationLoading, loading: true }
        void loadCoordinatorThread()
      } else {
        noteContext([])
      }
    }
    paintTurns(kind)
    pinAfterMount()
  }

  /* Repainted from the held conversation whenever the agent selection moves, so
     the setting takes effect on what is already on the screen rather than only
     on whatever arrives next. */
  let turnsSignature = null
  // Retain existing rows while this conversation updates. Include text in the
  // signature so a growing message still repaints when its ID stays the same.
  let paintedFrame = null
  const turnKey = turn => JSON.stringify([turn.id || null, turn.who || turn.sender, turn.text])
  let paintedTurns = [], paintedNodes = []

  function paintTurns(kind) {
    const selected = kind === 'none' ? [] : filterTurns(contextTurns, state.chatbox.selection)
    const shown = takeoverSubject ? selected.filter(turn => subjectMatchesTurn(takeoverSubject, turn)) : selected
    threadBundle.hidden = shown.length === 0 && !contextNotice
    const latest = shown.at(-1)
    threadPreview.textContent = latest ? `${shown.length} messages: ${latest.text.replace(/\s+/g, ' ').slice(0, 140)}` : ''
    const revision = JSON.stringify(contextTurns.map(turnKey))
    if (threadRevision !== null && revision !== threadRevision && shown.length && takeoverSubject && takeoverSubject.kind !== 'coordinator' && autoContext && !threadManual) {
      threadBundle.open = true
      threadOpen = true
    }
    threadRevision = revision
    const frame = [kind, takeoverSubject ? takeoverSubject.id : '', contextNotice ? contextNotice.title : '', composerWanted ? 'composer' : 'no-composer'].join()
    const keys = shown.map(turnKey)
    const signature = [frame, ...keys].join()
    /* An UNCHANGED snapshot is still news to the feed: a line that stopped
       growing is settled only when a poll leaves it as it was, and that is
       how the responding row goes away. So the feed hears every poll on the
       same frame, before the signature short-circuit below. */
    if (turnsSignature === signature) {
      if (sharedChat && sharedFrame === frame) sharedFeed.apply(shown, { snapshot: threadSnapshot })
      return
    }
    const wasAt = logEl.scrollTop
    for (const turn of shown) if (turn.fresh) delete turn.fresh
    if (!shown.length && kind !== 'none' && contextNotice) {
      /* Nothing to converse over yet: the source's own notice, not an empty
         chat pretending to be one. */
      disposeSharedThread()
      turnsSlot.replaceChildren(noticeNode(contextNotice.title, contextNotice.body, contextNotice.loading === true, null))
    } else if (kind === 'none') {
      disposeSharedThread()
      turnsSlot.replaceChildren()
    } else if (!sharedChat || sharedFrame !== frame) {
      mountSharedThread(frame, shown)
    } else {
      const fed = sharedFeed.apply(shown, { snapshot: threadSnapshot })
      if (!fed.ok) mountSharedThread(frame, shown)
    }
    turnsSignature = signature
    paintedFrame = frame
    paintedTurns = shown.map(turn => ({ ...turn }))
    if (threadBundle.open && !threadManual && takeoverSubject && takeoverSubject.kind !== 'coordinator') turnsSlot.scrollTop = turnsSlot.scrollHeight
    if (kind === 'none') { pinned = false; logEl.scrollTop = 0; return }
    if (!pinned) logEl.scrollTop = wasAt
  }

  function noticeNode(title, body, loading = false, action = null) {
    return el(
      `<div class="projection-state${loading ? ' is-loading' : ''}" role="status">`
      + `<strong>${escText(title)}</strong><span>${escText(body)}</span>`
      + (action ? `<a class="home-next" href="${escText(action.href)}">${escText(action.label)}</a>` : '')
      + '</div>',
    )
  }

  function showNotice(title, body, loading = false, action = null) {
    noticeSlot.appendChild(noticeNode(title, body, loading, action))
    pinned = true
  }

  /* THE COMPOSER IS THE SHARED SURFACE'S OWN (mountSharedThread, above). The
     feed's separate input row, its bridge-readiness sentence, its send() and
     the receiveTurn() echo lived here until 2026-09-18; the audited path is
     unchanged -- src/home-coordinator-chat.js createCoordinatorSender posts the
     same postBridgeAction('thread-reply') behind the same write flag -- and the
     echo is the surface's optimistic bubble confirmed by the receipt. */

  /* ------------------------------------------------------------------
     Sources.
     ------------------------------------------------------------------ */
  let threadTimer = 0
  function scheduleThread(waitMs) {
    clearTimeout(threadTimer)
    threadTimer = setTimeout(() => {
      if (destroyed) return
      if (renderedPanelKind === 'conversation') void loadCoordinatorThread({ poll: true })
      scheduleThread(THREAD_POLL_MS)
    }, waitMs)
  }
  async function loadCoordinatorThread({ poll = false } = {}) {
    const result = await fetchCoordinator()
    if (destroyed || renderedPanelKind !== 'conversation') return
    /* A poll that fails or comes back empty leaves what is on the screen
       alone: the first read already said what the source has to say for
       itself, and flashing "unreachable" over a conversation a person is
       reading, on one missed read, is worse than the stale line. */
    if (!poll) scheduleThread(THREAD_POLL_MS)
    if (poll && (!result.ok || !result.data.data.thread.ok || !result.data.data.thread.value.length)) return
    if (!result.ok) {
      contextNotice = COPY.conversationUnreachable
      apply()
      return
    }
    const thread = result.data.data.thread
    if (!thread.ok || !thread.value.length) {
      contextNotice = COPY.conversationEmpty
      apply()
      return
    }
    /* Held rather than painted: the agent selection is applied to it on the way
       to the screen, and re-applied whenever that selection moves, without this
       source being read again. */
    contextNotice = null
    noteContext(thread.value)
    threadSnapshot += 1
    if (!poll) pinned = true
    apply()
    if (!poll) pinAfterMount()
  }

  async function loadHealth() {
    const result = await fetchStatus()
    if (destroyed) return
    if (!result.ok) {
      state.fleetHealth = null
      state.peer = null
      apply()
      return
    }
    const { health, peerLink } = result.data
    state.fleetHealth = health?.available
      ? {
        available: true,
        atMs: health.observedAtMs,
        total: health.total,
        ok: health.counts.OK,
        down: health.counts.DOWN + health.counts.STOPPED,
        unknown: health.counts.UNKNOWN + health.counts.OTHER,
      }
      : null
    const out = peerLink?.outbound
    state.peer = out?.available
      ? { reachable: true, name: out.peerHost || 'your other computer', atMs: out.authenticatedAtMs }
      : null
    apply()
  }

  /* Both of these always report, including "there was nobody to ask" — a load
     that returns early without touching state would leave the first-paint gate
     closed forever, and the screen would never appear at all. */
  async function loadSessions(first = false) {
    /* Three cases, and conflating the last two would make this screen lie.
       No bridge at all is a plain browser: there is no computer here to report
       on. A bridge WITHOUT this channel is an installed copy older than the
       channel -- there is a computer, its record exists, and this copy cannot
       read it. Saying "you are in a browser" to someone sitting in front of the
       application would be the same class of untrue statement this rewrite
       exists to remove. */
    const bridge = globalThis.mcAgent
    let raw
    /* THE EXAMPLE READS ITS OWN RECORD AND NEVER THIS COMPUTER'S -- the same
       swap describeHome makes for the hero, made here for the list, so the two
       cannot disagree about what the example fleet has run. The bridge is not
       asked at all: a real record has no business near a badged screen, and
       the example has nothing to learn from it. */
    if (sample) raw = sampleSessionsRaw(Date.now())
    else if (!bridge) raw = undefined
    else if (typeof bridge.history !== 'function') raw = null
    else {
      try { raw = await bridge.history({ limit: historyLimit }) } catch { raw = null }
    }
    if (destroyed) return
    state.sessions = readLocalSessions(raw)
    /* Read beside the ledger and never inside a repaint. The two are one join,
       so reading them at different moments is how a row comes to show a run
       whose conversation this screen has not looked for yet. */
    readConversations()
    if (first) settle()
    else apply()
    /* Start only after the first record has been rendered. The heartbeat
       shares this view's resolved example choice and is idempotent, so local
       records never start a sample loop even without a fleet profile. */
    startSampleHeartbeat()
  }

  /* THE PER-TURN RECORD, WHICH IS WHERE "WHAT IT DID" COMES FROM.
   *
   * Deliberately NOT part of the first-paint gate. This screen's job is to say
   * one true thing quickly, and a row without its turn line is a row that is
   * merely shorter -- holding the whole screen back for it would trade a real
   * defect for a slower launch. It lands, the rows repaint, and a copy whose
   * shell is older than this record simply never gets the line.
   *
   * Grouped by session here rather than in the reader, because the reader is
   * shared with the metrics page and that page groups the same rows four other
   * ways. */
  async function loadUsage() {
    /* The example's turn figures come from its own usage record, through the
       same reader, the way src/views/metrics.js does it. */
    const read = await readLocalUsage({ agent: sample ? { usage: async () => sampleUsageRaw(Date.now()) } : globalThis.mcAgent })
    if (destroyed) return
    usageBySession.clear()
    if (read.readable === true) {
      for (const turn of read.turns) {
        if (!turn.sessionId) continue
        const rows = usageBySession.get(turn.sessionId)
        if (rows) rows.push(turn)
        else usageBySession.set(turn.sessionId, [turn])
      }
    }
    apply()
  }

  async function loadEngine() {
    const bridge = globalThis.mcAgent
    let raw
    if (!bridge || typeof bridge.availability !== 'function') raw = undefined
    else {
      try { raw = await bridge.availability() } catch (error) { raw = { ok: false, code: error?.code } }
    }
    if (destroyed) return
    state.engine = readAgentEngine(raw, isWriteEnabled('agent-session'))
    settle()
  }

  /* IS ANYBODY ACTUALLY SIGNED IN TO THE PROGRAM THAT RUNS AN AGENT.
   *
   * availability() above answers whether this INSTALLATION can start anything,
   * and shell/agent-host.cjs opens that on a Claude start being possible --
   * proved as the payload carrying the engine plus the `claude` program
   * resolving, never on a sign-in. Home was rendering that as a fact about the
   * computer, so a machine with nothing signed in to either provider showed a
   * green tick while the setup review one screen earlier said an agent could not
   * yet run and the press then refused for exactly that reason.
   *
   * NOTHING NEW IS PROBED. mcProviders.presence() is already on this preload and
   * src/setup-review-readiness.js already asks it one screen earlier; home is
   * the surface that never asked. The judgement lives in providerSignInReading()
   * beside the rest of the availability vocabulary, so there is one reading of
   * "signed in" rather than one per screen.
   *
   * A REFUSAL IS SILENCE, NOT A VERDICT. No bridge, a rejected call, a reply of
   * the wrong shape: all leave `known:false`, and describeHome then says exactly
   * what it said before anyone asked. Never a warning built out of a failed
   * request. */
  async function loadProviders() {
    const bridge = globalThis.mcProviders
    let raw = null
    if (bridge && typeof bridge.presence === 'function') {
      try { raw = await bridge.presence() } catch { raw = null }
    }
    if (destroyed) return
    state.providers = providerSignInReading(raw)
    /* apply(), NOT settle(), and the difference is a race rather than a taste.
       `awaitingFirstAnswers` is a countdown of the TWO sources the first paint
       waits for; a third caller decrementing it would let whichever two answered
       first release the paint, so a slow loadSessions would be painted around
       instead of waited for. apply() early-returns while the count is still
       above zero, leaving this reading in `state` for the paint that does
       happen, and repaints if the answer lands later. It also declines to become
       a third way for a hung IPC to leave this screen blank forever. */
    apply()
  }

  /* IS THIS COMPUTER ON THE PERSON'S TOOLSENABLED ACCOUNT.
   *
   * WHY HOME ASKS AT ALL. The owner's report is "as a user I dont even see how
   * after signing up that I now connect my computer", and the first screen's
   * one sentence about other computers used to be a fleet fact pointing at a
   * guide that says connecting is impossible. It is an account fact now, and an
   * account fact has to be READ or it is a guess -- the row would otherwise
   * tell a joined customer to go and join, on the screen they see most.
   *
   * ONE READ, AT MOUNT, AND NO TIMER. The answer changes only when somebody
   * walks through the connect ceremony, and that ceremony's own screen reports
   * itself. A poll here would spawn a child process per interval for a sentence
   * that changes twice in a machine's life.
   *
   * IT CANNOT COLLIDE WITH THE CONNECT SCREEN'S OWN READ. shell/device-claim.cjs
   * lets one child run at a time and refuses the second with DEVICE_CLAIM_BUSY;
   * status() now joins an in-flight read rather than being refused, which is the
   * repair that made this call safe to add at all.
   *
   * A REFUSAL IS SILENCE, exactly as loadProviders above: `known:false` renders
   * the invitation, never a verdict built out of a failed request. */
  async function loadAccount() {
    /* OVER THE RELAY THE ANSWER IS THE CHANNEL ITSELF. A browser reading this
       screen through the relay got every byte of it from a computer on the
       person's account; that is the only way the bytes could have arrived. So
       the row says so, rather than inviting them to connect the computer they
       are already being served by -- the contradiction measured on the live
       site on 2026-08-22, with the computers page saying "already on your
       account" in the rail while home said "connect this computer". The same
       reading the computers page uses (currentDataSource() === 'relay'). */
    if (currentDataSource() === 'relay') {
      state.account = { known: true, connected: true }
      apply()
      return
    }
    const claim = globalThis.mcShell?.deviceClaim
    if (!claim || typeof claim.status !== 'function') return
    let answer = null
    try { answer = await claim.status() } catch { answer = null }
    if (destroyed) return
    state.account = answer && answer.ok === true
      ? { known: true, connected: answer.connected === true }
      : { known: false, connected: false }
    /* apply(), not settle(), for the reason loadProviders states at length. */
    apply()
  }

  /* Self-pacing rather than a fixed interval, so a machine with no queue is not
     charged twenty seconds of request forever, and a machine whose capability
     layer is still starting still picks the queue up once it answers. */
  let approvalsTimer = 0
  let approvalsWaitMs = APPROVALS_POLL_MS
  let approvalsMoved = false
  /* A DECISION MADE IN THIS WINDOW IS NOT A STILL QUEUE. The outcome listener
     below changes what this row says without going near the bridge, so it also
     puts the ladder back on its bottom rung -- otherwise the person who just
     pressed something would be the one waiting eighty seconds to see what
     happened next.
     The flag is what covers a decision that lands WHILE a read is in flight:
     that read is about to compare two identical answers and would otherwise
     climb the ladder on the strength of a snapshot taken before the press. */
  function askForApprovalsSoon() {
    if (destroyed) return
    approvalsMoved = true
    approvalsWaitMs = APPROVALS_POLL_MS
    if (!approvalsTimer) return
    clearTimeout(approvalsTimer)
    approvalsTimer = setTimeout(() => { void loadApprovals() }, APPROVALS_POLL_MS)
  }
  async function loadApprovals() {
    // Share the existing backed-off owner-queue cadence. Never read Ledger
    // from animation frames, activity repaints or pointer interactions.
    const previousLedger = state.ledgerStatus
    const [raw, ledger] = sample
      ? [{ ok: true, prompts: exampleOwnerPrompts() }, { ok: true, records: sampleLedgerData().requests }]
      : await Promise.all([Promise.resolve().then(() => ownerPromptSnapshot()).catch(() => null), readHomeLedger()])
    if (destroyed) return
    // Cache the small summary. Streaming activity repaints must not scan
    // thousands of stored ledger records again.
    state.ledgerStatus = homeLedgerStatus({ ledger, prompts: raw })
    const readable = raw?.ok === true && Array.isArray(raw.prompts)
    /* Reconciled ONLY against a queue this call genuinely read. An unreadable
       snapshot prunes nothing and claims nothing: not knowing what is pending is
       not the same as knowing nothing is, and treating it as the latter would
       erase the record of a refused decision on the strength of a failed
       request. */
    const previous = state.approvals
    state.approvals = readable
      ? {
        readable: true,
        count: raw.prompts.length,
        undelivered: sample ? 0 : reconcileUndeliveredDecisions(raw.prompts.map(prompt => prompt.id)),
      }
      : { readable: false, count: 0, undelivered: 0 }
    apply()
    /* THE ANSWER, NOT THE CLOCK, DECIDES THE NEXT WAIT. A queue that has not
       moved is asked for less often; the first reading that differs in any way
       this row renders puts it straight back to the base. */
    const nextLedger = state.ledgerStatus
    const ledgerMoved = previousLedger.status !== nextLedger.status || previousLedger.asks !== nextLedger.asks
      || previousLedger.blockers !== nextLedger.blockers || previousLedger.complete !== nextLedger.complete
    const moved = approvalsMoved || approvalsReadingChanged(previous, state.approvals) || ledgerMoved
    approvalsMoved = false
    approvalsWaitMs = nextApprovalsWaitMs({ readable, changed: moved, waitMs: approvalsWaitMs })
    approvalsTimer = setTimeout(() => { void loadApprovals() }, approvalsWaitMs)
  }

  /* THERE IS STILL DELIBERATELY NO REFRESH ON WINDOW FOCUS, AND STILL NO POLL.
   *
     Reading the record means checking a signed chain, on the Electron main
     process, which is also what forwards output for every live agent session.
     Refreshing on focus therefore charged every running agent for the act of
     alt-tabbing back to the window -- measured by the performance lane at ~0.9s
     of whole-app stall on a ledger with ten thousand records. The cache in
     shell/spawn-record.cjs takes most of that cost away, but the honest fix is
     not to ask the question when there is no reason to.

     WHAT CHANGED, AND WHY IT DOES NOT BRING THAT COST BACK. The owner asked for
     a flow rather than a photograph, and the second half of the reasoning above
     turned out to be the part that was wrong: a run started on the computers
     page keeps running when a person walks back to this screen, so this view IS
     mounted while agents work, and the list simply never moved again.

     The repair is a SUBSCRIPTION, not a cadence. The window is already told
     every packet of every live session, and that stream carries the two things
     that change a record: a session nobody here has seen (a run was written
     down) and a turn that ended (a usage line was written down). So the records
     are read when one of those has just happened, at most once every four
     seconds, and at no other time. Alt-tabbing still costs nothing, an idle
     computer still costs nothing, and the words an agent is saying do not wait
     for a record at all -- they are painted off the stream. */

  /* The coalescing gate. Both reads are asked for by name so a burst of turn
     endings cannot turn into a burst of chain verifications, and so a new
     session does not drag the usage record along with it for no reason. */
  let ledgerTimer = 0
  let ledgerReadAt = 0
  let wantRuns = false
  let wantUsage = false
  function askForLedger({ runs = false, usage = false }) {
    wantRuns = wantRuns || runs
    wantUsage = wantUsage || usage
    if (ledgerTimer || (!wantRuns && !wantUsage)) return
    const wait = Math.max(0, LEDGER_REREAD_FLOOR_MS - (Date.now() - ledgerReadAt))
    ledgerTimer = setTimeout(() => {
      ledgerTimer = 0
      if (destroyed) return
      ledgerReadAt = Date.now()
      const runsWanted = wantRuns
      const usageWanted = wantUsage
      wantRuns = false
      wantUsage = false
      /* THE SAVED CONVERSATIONS MOVE WITH EITHER READ, and they did not, which
         cost a real run its brief on the glass. A run started from the tree
         writes its node a beat after the signed record has it, so the read that
         picks the RUN up is usually too early for the node -- and the only later
         read was the one that follows a turn ending, which used to fetch the
         turn record alone. The row therefore kept its answer and never gained
         the question. This is a walk of a handful of small keys on this
         computer, not a chain verification, so it costs nothing to do on both. */
      readConversations()
      if (runsWanted) void loadSessions()
      if (usageWanted) void loadUsage()
      if (!runsWanted && !usageWanted) apply()
    }, wait)
  }

  /* THE EAR ON THE SESSION STREAM. Read only through the shared readers, which
     is what stops this screen from having its own opinion about a packet shape
     it does not own. Every session is watched, not only ones this screen
     started, because this screen started none of them. */
  const onAgentPacket = (packet) => {
    if (destroyed) return
    const sessionId = packet && typeof packet.sessionId === 'string' ? packet.sessionId : ''
    if (!sessionId) return

    /* A session this list has never heard of means a run was written to the
       record after this screen last read it. That is the one thing that adds a
       row, so it is the one thing that asks for the run record again. */
    if (!state.sessions.runs.some(run => run.sessionId === sessionId)) askForLedger({ runs: true })

    const speech = sessionTextReader.read(packet, sessionId)
    const text = speech?.text || null
    const status = sessionTurnStatus(packet, sessionId)
    const activity = sessionActivityEvent(packet, sessionId)
    const ended = sessionEndedEvent(packet, sessionId)
    if (text === null && status === null && !activity && !ended) return

    const turnId = sessionEventTurnId(packet, sessionId)
    let live = liveSessions.get(sessionId)
    if (status !== null && live?.turnId && !completionSettlesOpenTurn(packet, sessionId, live.turnId)) return
    /* WHERE ONE TURN ENDS AND THE NEXT BEGINS, taken from the engine's own
       naming of the turn. Without it the previous turn's words survive into the
       next one and the row shows two answers run together -- the defect the
       tree page measured and fixed in its own transcript. */
    if (!live || (turnId && live.turnId && live.turnId !== turnId)) {
      live = { turnId: turnId || null, text: '', working: false }
      liveSessions.set(sessionId, live)
    }
    if (turnId && !live.turnId) live.turnId = turnId
    if (activity) {
      live.waiting = activity.kind === 'approval'
      live.working = !live.waiting
      live.status = null
      live.kind = activity.kind
      live.tool = activity.tool || ''
      if (activity.kind === 'call') live.events = (live.events || 0) + 1
      live.updatedAt = Date.now()
      live.activity = activity.kind === 'thinking' ? 'Thinking'
        : activity.kind === 'approval' ? 'Waiting for your approval'
          : `${activity.kind === 'call' ? 'Using' : 'Result from'} ${activity.tool || 'a tool'}${activity.command ? `: ${activity.command}` : ''}`
      live.detail = activity.kind === 'approval' ? activity.detail : ''
    }
    if (text !== null) {
      if (live.text && speech.breakBefore) live.text += '\n\n'
      live.text += text
      live.working = true
      live.status = null
      live.waiting = false
      live.activity = ''
      live.ended = false
      live.kind = 'text'
      live.updatedAt = Date.now()
    }
    if (status !== null) {
      /* The turn is over. The words STAY on the row -- they are what it said --
         and only the claim that it is still working is withdrawn. The figures
         for that turn have just been written down, so this is also the moment
         the usage record has something new in it. */
      live.working = false
      live.status = status
      live.waiting = false
      live.activity = ''
      live.kind = null
      live.updatedAt = Date.now()
      live.detail = sessionTurnFailureText(packet, sessionId) || ''
      askForLedger({ usage: true })
    }
    if (ended) {
      live.ended = true
      live.working = false
      live.waiting = false
      live.activity = ''
      askForLedger({ usage: true })
    }
    paintLiveSoon(sessionId)
  }
  const detachAgentEvents = typeof window !== 'undefined'
    && window.mcAgent && typeof window.mcAgent.onEvent === 'function'
    ? window.mcAgent.onEvent(onAgentPacket)
    : null

  /* The two settings are changed on another screen, and this one is left
     mounted behind it, so the box has to re-read them when they move rather
     than only at mount. Same mechanism the live-source flags use. */
  const onChatboxSettings = () => {
    if (destroyed) return
    readChatboxSettings()
    apply()
  }
  window.addEventListener(CHATBOX_FEED_EVENT, onChatboxSettings)

  // Settings can commit while Home is still mounted behind it. Switch only
  // its decoration; the clock, live facts and conversation keep their state.
  const onHomeCircleStyle = () => {
    if (!destroyed) paintCircleStyle()
  }
  window.addEventListener(HOME_CIRCLE_STYLE_EVENT, onHomeCircleStyle)
  const onHomeCircleMotion = () => {
    if (!destroyed) ring.el.dataset.circleMotion = currentHomeCircleMotion()
  }
  window.addEventListener(HOME_CIRCLE_MOTION_EVENT, onHomeCircleMotion)

  /* AN AGENT REMOVED FROM ITS OWN CHAT HERE. The removal runs in the hidden
     conversation view, which paints only its own status; Home kept showing and
     selecting the agent, and its window said "This conversation is no longer
     available" (T1554, T1562). Home now drops the agent from the picker, the
     list and Full view at once, goes back to the list, and says it was
     removed. */
  const removalNote = root.querySelector('[data-home-removal-note]')
  let removalNoteTimer = 0
  const onTreeNodeRemoved = event => {
    const { computerId = null, nodeId = null, sentence = '' } = event?.detail || {}
    if (destroyed || sample || typeof nodeId !== 'string' || !nodeId) return
    takeoverSurface?.closeAgent?.(computerId, nodeId)
    // Re-read the saved conversations too: a removed agent's session must not
    // keep it in the Open picker (readConversations refreshes Full view).
    readConversations()
    if (agentFilter === nodeId) chooseAgent(listBeforeChat, 'summary')
    else paintRunScope()
    if (sentence) {
      removalNote.textContent = sentence
      removalNote.hidden = false
      clearTimeout(removalNoteTimer)
      removalNoteTimer = setTimeout(() => { removalNote.hidden = true }, 12000)
    }
  }
  window.addEventListener(TREE_NODE_REMOVED_EVENT, onTreeNodeRemoved)

  /* The case this exists for: he pressed Submit on #/approvals, pressed the
     arrow, and landed HERE — and only then did the bridge refuse. Waiting out
     this screen's own 20s poll before saying so would leave him looking at a
     screen that knows his decision did not land and is not telling him.
     Clamped to the count this screen actually read, so it can never report
     more failures than there are requests waiting. */
  const onApprovalOutcome = () => {
    if (destroyed) return
    /* A decision has just been made in this window, so whatever the row
       currently knows, the queue behind it is about to move. That is the end
       of "the answer has not changed", so the poll goes back to its base wait
       here rather than at the next reading. */
    askForApprovalsSoon()
    if (!state.approvals?.readable || sample) return
    const undelivered = Math.min(undeliveredDecisionCount(), state.approvals.count)
    if (undelivered === state.approvals.undelivered) return
    state.approvals = { ...state.approvals, undelivered }
    apply()
  }
  window.addEventListener(APPROVAL_OUTCOME_EVENT, onApprovalOutcome)

  void loadEngine()
  void loadProviders()
  void loadAccount()
  void loadSessions(true)
  void loadUsage()
  void loadApprovals()
  /* OUT OF PHASE WITH THE APPROVALS POLL, ON PURPOSE. Both polls are started
     in this one synchronous block, so a fixed interval born here shares a wake
     with its neighbour every time their periods line up -- one longer stall
     rather than two short ones, on the frame a person is most likely to be
     watching. The offset is added once, to the first wait AFTER the immediate
     read below, so nothing anybody waits for at mount is delayed. */
  let healthTimer = 0
  function scheduleHealth(waitMs) {
    /* The handle is never cleared to zero inside the callback: destroy() has to
       be able to clear a live handle at every instant, and a re-arm that ran
       after teardown would leave a timer nothing owns. */
    healthTimer = setTimeout(() => {
      if (destroyed) return
      void loadHealth()
      scheduleHealth(HEALTH_POLL_MS)
    }, waitMs)
  }
  if (fleetConfigured) {
    void loadHealth()
    scheduleHealth(HEALTH_POLL_MS + pollPhaseOffsetMs('home:health'))
  }

  const detachContinuationStatus = subscribeAutonomousContinuationStatus(status => {
    if (destroyed) return
    continuationStatus = status
    apply()
  })

  return {
    el: root,
    destroy() {
      detachContinuationStatus()
      takeoverOpenToken++
      destroyed = true
      sessionTextReader.clear()
      ringFluid?.destroy()
      statusColors.destroy()
      voiceContact.destroy()
      stopClock()
      /* Every recurring read on this screen is now a self-rescheduling
         timeout rather than a fixed interval -- that is what lets each one
         carry its own phase and its own back-off -- so they are all cleared
         the same way. */
      clearTimeout(healthTimer)
      clearTimeout(threadTimer)
      clearTimeout(approvalsTimer)
      clearTimeout(ledgerTimer)
      clearTimeout(liveRepaintTimer)
      if (sampleTick) { clearTimeout(sampleTick); sampleTick = 0 }
      if (sampleActionTick) { clearInterval(sampleActionTick); sampleActionTick = 0 }
      if (panelChat) { panelChat.mount.destroy(); panelChat = null }
      disposeSharedThread()
      panelWorkspacePool?.destroy()
      panelWorkspacePool = null
      /* The stream outlives this view: the sessions it carries belong to the
         shell, not to the page. A listener left attached here would keep the
         whole view alive for as long as any agent kept talking. */
      detachAgentEvents?.()
      anchorRo.disconnect()
      anchorMo.disconnect()
      cancelAnimationFrame(firstPinFrame)
      cancelAnimationFrame(settledPinFrame)
      window.removeEventListener(CHATBOX_FEED_EVENT, onChatboxSettings)
      window.removeEventListener(HOME_CIRCLE_STYLE_EVENT, onHomeCircleStyle)
      window.removeEventListener(HOME_CIRCLE_MOTION_EVENT, onHomeCircleMotion)
      window.removeEventListener(TREE_NODE_REMOVED_EVENT, onTreeNodeRemoved)
      clearTimeout(removalNoteTimer)
      window.removeEventListener(APPROVAL_OUTCOME_EVENT, onApprovalOutcome)
      /* The full page holds a mounted surface and a window listener, and it
         is the panel's own element that is parked inside it. Tearing it down
         before the view goes leaves nothing mounted and nothing listening. */
      window.removeEventListener('keydown', takeoverKeys)
      readingControls?.destroy()
      readingControls = null
      takeoverSurface?.destroy()
      retainWorkspace()
      takeoverSurface = null
      agentWorkspacePool?.destroy()
      agentWorkspacePool = null
      document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded)
      /* THE CRESCENT, WHICH NOTHING HAD EVER TAKEN DOWN.
       *
       * uptimeRing() mounts the corona and hands its teardown back as
       * root.destroyCrescent (src/components.js). Grepped across this tree
       * before this line existed, that property was written in exactly one
       * place and READ in none -- so every visit to this page built a corona
       * that was never dismantled.
       *
       * WHAT ONE UNCLOSED MOUNT LEAVES BEHIND, read off a staged packaged
       * build by instrumenting the page from before its first line ran
       * (tools/dom-retention-probe.mjs): two MutationObservers still watching
       * documentElement and body -- neither of which is ever collected, so
       * neither are their closures -- a transitionstart and a transitionend
       * listener on the colour probe, a webglcontextlost listener on the
       * canvas, and a WebGL context nobody released. Holding any node of a
       * tree holds the whole tree, so those observers kept a 132-node detached
       * copy of this ring alive, one more on every lap of the ring.
       *
       * MEASURED BEFORE AND AFTER THIS LINE, same probe, three laps:
       *   before  88 -> 94 -> 100 listeners, 4 -> 6 retained detached trees,
       *           8 observers nobody had disconnected and climbing
       *   after   76 / 76 / 76 listeners, 2 / 2 / 2 trees, 5 observers, flat
       *
       * IT IS ONE CALL, and the reason it was missing is that nothing forced
       * it: a teardown handed back as a property on a DOM element is a
       * teardown a caller can forget. Nothing in the unit suites can catch it
       * coming back -- this file needs a real document and a real GL context to
       * be wrong in this way -- so the probe above is the instrument that
       * would, and it is why that file exists. */
      ring.el.destroyCrescent?.()
    },
  }
}
