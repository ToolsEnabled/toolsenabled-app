import { createImageConversation } from '../image-conversation.js'
import { createProviderModeMenu } from '../provider-mode-menu.js'
import { createPermissionTierMenu } from '../permission-tier-menu.js'
import { stopNativePersonSession } from '../native-person-stop.js'
import { fmtRuntime } from '../runtime-clock.js'
import { THINKING_UNAVAILABLE_NOTICE } from '../../shell/thinking-transcript.mjs'
import { fleetOverviewSnapshot, overviewNodeState, OVERVIEW_STATES } from '../fleet-overview.js'
import { ROLES } from '../vocab.js'
import { paintRoleColor } from '../role-colors.js'
import { controlState, createChatDiffOpenHandler, el, setViewMorph, buildChat } from '../components.js'
import { treeChatDrafts } from '../tree-chat-drafts.js'
import { profileControls } from '../session-profile-controls.js'
import { setChatMessageBody, createChatMarkdownStream } from '../chat-message-body.js'
import { createCompareFilesDoor } from '../diff-editor.js'
import { boundedChangePatches, createConfirmedFileChangeBuffer } from '../session-change-patches.js'
import { railTitleRow } from '../rail-title.js'
import { StaticTreeGraph } from '../tree-graph.js'
import { TreeWindows } from '../tree-windows.js'
import { planNodeRemoval, runNodeRemoval, branchRemovalConfirmation } from '../tree-node-removal.js'
import { showTreeEditPicker } from '../tree-edit-picker.js'
import { mountAgentScreenVoiceControls } from '../agent-screen-voice-controls.js'
import { readCloudLane } from '../lane-marks.js'
import { adoptStandaloneIntoTree } from '../tree-standalone-adoption.js'
import '../agent-screen-voice-controls.css'
/* THE ONE AXIS THIS PAGE FORKS ON. live-flags.js's per-view second render is
   gone (owner: "all simulated pages ARE the UI pages, just mock data"); what
   remains is a data source — local, relay, or mock — and one render fed by
   whichever answered. resolveDataSource is async because a public page has to
   ask the host for a transport; DATA_SOURCE_EVENT is the host saying the world
   changed (sign-in, sign-out, the example toggle), on which this view
   re-resolves and remounts. */
import { resolveDataSource, currentDataSource, previewWithoutHost, exampleIsSignedOutDefault, exampleWasChosen, setExampleMode, hostFallbackSentence, hostFallbackCode, NO_MACHINE_CHOSEN, DATA_SOURCE_EVENT, HOST_FALLBACK_EVENT } from '../data-source.js'
/* The example fleet, in exactly the `{computers, graph}` shape mountProjection
   consumes — see src/sample-fleet.js for why it is copied literals rather than
   anything imported from the modules being deleted. When the source is mock,
   THIS is the whole record the page draws; no real store is read beside it. */
import { sampleFleetData } from '../sample-fleet.js'
import { createSampleTreeStore, SAMPLE_TREE_COMPUTER_ID, sampleSimulationSeed } from '../sample-trees.js'
import { createSampleFleetRun } from '../sample-simulation.js'
import { fetchFleet, fetchAgents } from '../live-status.js'
import {
  LAUNCH_TIERS, DISPATCH_TIERS, launchTier, tierArgvFragment, UNSUPPORTED_CONTROLS,
  CAP_BOUNDS, clampCapMs, capMinutes, sandboxLevel,
} from '../orchestration-controls.js'
import {
  TIER_SEAT_POOL, TEAM_BOUNDS, planTeam, createTeamController,
} from '../agent-teams.js'
import {
  LOOP_BOUNDS, LOOP_OVERRUN, LOOP_RUN_CAP, planLoop, createLoopController,
} from '../agent-loops.js'
import { planNodeChatbox, channelCaption, onChatboxSettingsChanged } from '../node-chatbox.js'
import { createSingleFlight } from '../single-flight.js'
import { createTreeWorkController } from '../tree-bounded-work.js'
import { createTreeLaunchQueue, isResourceHold } from '../tree-launch-queue.js'
/* The bound on how long a press on an approval may say nothing back. Both doors
   into the answer use it, so neither can go quiet on a person again. */
import { answerWithinBound, createPendingApprovals } from '../approval-answer.js'
import { executeFreshStartExistingNode } from '../fresh-start-existing-node.js'
import { createEngineModelCatalog } from '../engine-model-catalog.js'
import { createSavedSessionRefusals } from '../saved-session-refusals.js'
import { MANAGED_SLOT_ACTIONS, planManagedSlotChoice } from '../managed-slot-choice.js'
import { slotAccountStartOptions } from '../slot-account-choice.js'
import { createAccountRecoveryCoordinator } from '../account-recovery-coordinator.js'
import { createRecoveryHandoffStore } from '../recovery-handoff-store.js'
import { savedAccountResumeRefused, savedSessionEffort, saveStoppedSessionEffort, defaultRetryProviders, MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY, isAccountHandoff, isModelHandoff } from '../manual-account-continuation.js'
import { stopStillOwnsNode } from '../stop-node-session.js'
import { executeRestartExistingNodeCommand } from '../restart-existing-node-command.js'
import { executeFreshStartBriefSend } from '../fresh-start-brief-send.js'
import { executeSendToBoundNode } from '../send-to-bound-node.js'
import { executeCreateAndStartNode, PROVIDERS_WITH_A_THINKING_DEPTH } from '../create-and-start-node.js'
import { canRetryUnstartedNode, executeRetryUnstartedNode } from '../retry-unstarted-node.js'
import { editorAttachmentDrafts } from '../editor-attachment-drafts.js'
/* The owner's rule for who may remove a circle, and the other half of it: which
   typed lines count as the person prompting one. Both callable from a test. */
import { callerCircleRefusal, executeRemoveNode, notePersonSpokeTo } from '../agent-removal-rule.js'
import { resumableThread } from '../tree-resume-decision.js'
import { roleGraphPosture } from '../role-graph-posture.js'
/* COPY and readLocalSessions are borrowed rather than rewritten: the home
   screen already says these sentences, and a second wording for "some agents
   are hidden" would let page 1 and page 2 describe the same setting
   differently. src/local-activity.js is the shared owner of both. */
import { COPY, readLocalSessions } from '../local-activity.js'
/* THE EMPTY-STATE NOTICE AND ITS DOOR, borrowed for the same reason COPY above
   is. This page's empty state is the state EVERY fresh install opens on, and
   home, the comms board and Settings are all saying something about the same
   absent agent host at the same time. A second wording here would let four
   screens describe one condition four ways, and the person who reads two of
   them would have to work out whether they are the same problem.
   src/first-run-needs.js owns the sentences; src/guide.css styles this page's
   copy of them (`.computers .graph-empty .host-absent`). */
import { GUIDE_ACTION, hostAbsentMarkup } from '../first-run-needs.js'
/* The one address of the connect screen, read rather than spelled. This page is
   where a person goes first to add a computer, and it had no door at all. */
import { CONNECT_HREF } from '../device-claim-flow.js'
// Finished Controls-rail replies share the live chat renderer and typography.
function paintSaidReply(host, text) {
  if (!host) return
  setChatMessageBody(host, text)
}
/* The account page a browser is sent to when this tab has no computer chosen.
   RELATIVE, not absolute — this link renders only in a browser preview
   (previewWithoutHost), and a browser preview is served from SOME origin that
   also serves /account/: production, the release-candidate serve, a dev serve.
   The old absolute form (`https://` + ACCOUNT_PAGE_HOST) sent every non-
   production serve to production without a word — measured on the desktop
   press-through (2026-08-27): a press on the local 127.0.0.1 serve silently
   left it for toolsenabled.ai and a 401. The relative door keeps a person in
   the environment they are standing in, which on production is exactly the
   address the absolute form spelled. */
const ACCOUNT_PAGE_HREF = '/account/'
/* THE COMPUTERS ON THE ACCOUNT, AND THE PRESS THAT DRIVES ANOTHER ONE. Owner,
   2026-08-23: the choice belongs on this page, not back on the account page,
   and either computer can be driven. The module holds no DOM and re-derives
   none of the host bridge's rules -- see its header for why this axis and the
   `liveComputers` one below are kept apart. */
import { switchMachineTab, machineTabSwitchState, machineTabSwitchResultIsCurrent, subscribeMachineTabSwitch, machineTabsBar, readMachineTabs } from '../machine-tabs.js'
/* The phone canvas is a MODE, not a second page: on a phone it locks this page
   into the screen and moves the rail into a sheet, and everywhere else it
   returns null and this file behaves exactly as it did. */
import { mountPhoneCanvas } from '../phone-canvas.js'
import { mountPhoneLedger, buildSignInDoor, phoneLedgerNeedsSignIn } from '../phone-ledger.js'
/* THE LEDGER'S SIGN-IN GATE (routing law). loadAccountState() is the SAME
   account-state.js reader data-source.js's own signed-out/signed-in split
   already relies on for this exact window.mcAccount signal — see that
   module's onDesktop()/nobodyIsSignedIn() for why window.mcAccount is a real
   signal here, backed on a browser copy by toolsenabled-paid/website/public/
   host-bridge.js's own account service rather than being Electron-only. */
import { loadAccountState } from '../account-state.js'
/* No bare identifier reaches a person from this page's controls; the code is
   carried as `data-refusal-code` instead. See src/refusal-copy.js. */
import { markRefusalCode, readerRemedy, refusalCodeOf, refusalSentence } from '../refusal-copy.js'
/* The sentences for a refused agent START, which are a different table from the
   product-wide remedies above and stay that way — see the note at the head of
   src/refusal-copy.js for why the two do not import each other. UNAVAILABLE_TEXT
   is read only to ASK whether a code has a sentence there; the sentence itself
   always comes back through unavailableReason(). */
import { refusalAttribution, refusalCode, unavailableReason } from '../agent-availability-copy.js'
import { attachResizeHandle } from '../resize-handle.js'
import { latestNodeOutput } from '../node-card-context.js'
import { readableTextPrefix } from '../chat-readable-stream.js'
/* EVERY SENTENCE THIS FLOW SAYS ABOUT A START, written once, in one voice, by
   the lane that owns the words. Nothing in this file rewords a refusal: it hands
   the whole bridge result over and shows what comes back. */
import {
  CHAT_NOT_RUNNING,
  TREE_ENGINE,
  TREE_DEFAULT_STARTABLE_TIERS,
  startableProviderWords,
  tierProviderWord,
  MOVE_PANEL,
  PROFILE_PANEL,
  START_WORK_GROUP,
  PALETTE_PANEL,
  FLEET_DECLARED_NOTE,
  pasteRefusalSentence,
  mentionRefusalSentence,
  REMOVE_PANEL,
  QUEUE_PANEL,
  movedFrontSentence,
  SWITCH_PANEL,
  sendFailureIsUnconfirmed,
  sendRefusalSentence as queuedSendRefusalSentence,
  SAID_PANEL,
  NODE_STATUS_WORDS,
  TURN_FAILED,
  TURN_CANCELLED,
  turnCompletionWords,
  START_PANEL,
  START_REFUSAL,
  APPROVAL_PANEL, approvalCardChoices, approvalDecisionWord, approvalAnswerSentence, approvalDecisionIsReject,
  MODEL_PANEL,
  sessionModelChoices,
  REWIND_PANEL,
  RESUME_PANEL,
  RECOVERED_SESSION,
  ENDED_SESSION,
  SECOND_TREE,
  EFFORT_SWITCH,
  EFFORT_CHOICES,
  TIER_CHOICES,
  signedOutProviderIds,
  notInstalledProviderIds,
  startableTierAnswer,
  tierChoicesFor,
  actionRowWords,
  activityLine,
  foldedActionsLine,
  TRANSCRIPT_TRIMMED_NOTE, TRANSCRIPT_OLDER_NOTE, TRANSCRIPT_OLDER_DOOR,
  TREE_CONTEXT_LABEL, treeContextSummary, handoffContextLabel, handoffContextSummary,
  recordRailVerbElsewhere,
  refusalNeedsAssistantProgram, roleLabel, runningLine, startRefusalSentence, restartRefusalSentence, startingLine,
  startStallMs, startStalledLine,
  usageSentence,
} from '../fleet-tree-copy.js'
import { resumeNodeCommandResult } from '../resume-node-command-result.js'
import { hostSessionAlive, settleNodeForCommand } from '../tree-node-settle-wait.js'
import { mountTranscriptHistory } from '../node-transcript-history.js'
import { createNodeTranscriptClient } from '../node-transcript-client.js'
import { createTranscriptStore, TRANSCRIPT_LIMITS, transcriptSeedText } from '../session-transcript-store.js'
/* The owner's queue: messages written while the agent is busy, drained one
   per completed turn by this view's own listener. The store holds words; this
   file holds the wire. */
import {
  SESSION_OUTBOX_EVENT,
  cancel as outboxCancel,
  clearSession as outboxClearSession,
  confirmDelivered as outboxConfirmDelivered,
  enqueue as outboxEnqueue,
  holdForSend as outboxHoldForSend,
  list as outboxList,
  moveSession as outboxMoveSession,
  replace as outboxReplace,
  promoteFront as outboxPromoteFront,
  requeueFront as outboxRequeueFront,
  takeNext as outboxTakeNext,
} from '../session-outbox.js'
import { WRITE_OUTCOME_KEYS, recordUndeliveredWrite } from '../write-outcomes.js'
/* The readers that decide what a session event is allowed to put on a screen.
   Same set the agent page uses; a second reading of the same stream is how one
   surface comes to be wrong without anybody noticing. */
import { createActionBuffer, completionSettlesOpenTurn, sessionActivityEvent, sessionEndedEvent, createSessionTextReader, sessionEventTurnId, sessionFiledRule, sessionRuleFilingCall, sessionTurnFailureText, sessionTurnStatus, sessionTurnSucceeded, sessionTurnCancelled, nodeStatusForTurn, recoveredNodeTurnStatus, sessionUsageEvent, sessionPersonTurn } from '../agent-session-events.js'
import { desktopRefusalCode, desktopSessionFacts, desktopSessionName, desktopSessionsBridge, desktopSessionsOutsideTree, desktopStartedSessions, desktopTreeSignature, mountDesktopSessionChat, readDesktopSessionList } from '../desktop-sessions.js'
import { DESKTOP_SESSION_COPY, desktopSessionSentence } from '../desktop-session-copy.js'
/* The one line the chat shows when an agent filed one of the person's rules
   -- built from the engine's tool result, never from the agent's prose. */
import { filedRuleChatRow } from '../filed-rule-copy.js'
/* The one sentence the read-only example chat falls back to when planNodeChatbox
   named no reason of its own. See the module for why it is not inlined here. */
import { RAIL_CHAT_COPY } from '../rail-readonly-chat-copy.js'
import {
  goalConfirmationSentence,
  goalPendingSentence,
  goalRefusalSentence,
  goalTitleFromObjective,
  parseSlashCommand,
  queuedMessageEditRefusal,
  requestUsageSentence,
  requestConfirmationSentence,
  taskUsageSentence,
  taskConfirmationSentence,
  askUsageSentence,
  askConfirmationSentence,
} from '../slash-commands.js'
/* The frame-batched appender the Controls panel already streams through --
   measured there, reused here so the rail's "What it said" moves while the
   turn runs instead of sitting silent until the end. */
/* THE TREE A PERSON BUILDS, and the panel they build it in. Neither is this
   file's to own: src/fleet-trees.js holds the structure and its rules, and
   src/agent-compose-panel.js holds the form and its refusals. This view is the
   join between them and the agent bridge — a press goes in one end and a running
   session comes out the other. */
import { FLEET } from '../fleet-profile.js'
import { createFleetTreeStore, draftStartEffort, FLEET_TREE_LIMITS, markTreeStoreLive, NODE_REMOVE_REFUSALS, NODE_STATUSES, nodeDisplayName, safeTreeStorage, treeFolderMenuChoice, treeRecord, treeSlotUsage, TREE_NODE_REMOVED_EVENT } from '../fleet-trees.js'
import { orphanedNodeSeatSweepProposal, orphanedNodeSeatSweepReadiness } from '../orphaned-node-seat-sweep.js'
import { readTreeStyle, readTreeCards, readTreeContextSize } from '../tree-box-layout.js'
import { commonCommandIcon } from '../common-command-icons.js'
import { mergeFleetTreeProjection } from '../fleet-tree-projection.js'
import { createDesktopTreeViewStore, desktopTreeBridge, desktopTreeComputer, readDesktopTreeSnapshot } from '../desktop-tree-authority.js'
/* WHAT A NODE IS TOLD ABOUT ITS PLACE IN THE TREE. The tree holds the
   relationship; before this the session was never told it, and a child asked
   the person for "the manager's identifier" while its manager was drawn one
   circle above it (owner, 2026-08-18). See that file's header for why this
   rides in the message text rather than in an engine option. */
import { composeNodeBrief, nodeManagerContext, readTreeAddress } from '../tree-node-brief.js'
import { markRoleContext } from '../chat-role-context.js'
/* The scopes a circle's agents are under, derived in ONE place: this view puts
   them on every start as requestKeys, and the rail reads the same list back —
   see src/tree-standing-requests.js for why that derivation is shared. */
import { REQUEST_PANEL, standingRequestScopesFor, standingRequestsPanelFor } from '../tree-standing-requests.js'
import { mountAgentComposePanel } from '../agent-compose-panel.js'
/* The sentences about what a session started here would be allowed to do. The
   copy module already owned them and src/agent-session.js already rendered them
   under ITS Start button; this view is how they reach the OTHER one. */
import { startControlLine, CONFINEMENT_SUBJECT_REMOTE, CONFINEMENT_SUBJECT_HERE } from '../agent-confinement-copy.js'
import { WRITE_FLAGS_EVENT, isWriteEnabled, setWriteEnabled } from '../write-flags.js'
import { START_CONTROL_FLAG, START_CONTROL_ON, startControlOffBecause, startControlOffReason } from '../setup-profile.js'
/* The one rule for "is there still an agent behind this circle", shared by every
   surface on this page that used to answer it for itself. */
import { nodeIsBusy, sessionEndedWithApp, sessionIsLive, treeNodeClock } from '../tree-session-liveness.js'
import { reconnectRemoteSessions } from '../remote-session-reconnect.js'
import { acceptRemoteSequence, readRemoteSessionHistory, remoteHistoryReplay } from '../remote-session-history.js'
/* What a resumed session opens on — the kept excerpt when there is one, the
   engine's turns only for a thread this computer has no record of. Shared for
   the reason the rule above is: it was six lines here that nothing could drive,
   and they deleted a person's conversation. */
import { resumedTranscriptLines } from '../tree-resume-transcript.js'
import { createTurnInterrupts } from '../turn-interrupts.js'
import { cloudControlsBox } from '../cloud-tasks.js'
import { cloudCommandAction } from '../cloud-command-actions.js'
import { accountSwitcher } from '../account-switcher.js'
import { accountsBridge, loadAccounts, readAccountList } from '../account-switcher-state.js'
import { continuationRouteFor, mountSwitchAndContinueDialog, switchChoices } from '../switch-and-continue.js'
import { bridgeReachable, bridgeStatus, postBridgeAction, validAuditReceiptPair } from '../mission-bridge.js'
import { readResearchSnapshot } from '../research-projects.js'
import { withResearchTreeBinding } from '../research-tree-session.js'
import { createAssignmentStore } from '../research-assignments.js'
import { createAssignmentControl } from '../research-assignment-control.js'
/* The other source of computers, and on a customer machine the only one that
   can ever answer. See the header of src/declared-fleet.js for the measurement:
   the fleet projection is a BUILD-TIME file and ships `ok:false` forever. */
import { declaredAgentsData, declaredFleetData } from '../declared-fleet.js'
/* THE OTHER HALF OF declaredFleetData(), AND THE ONE THIS PAGE NEVER HANDED IT.
 *
 * src/declared-fleet.js takes `started` as its second argument and says in its
 * own header why: it is pure, the registry is a live singleton, and "the caller
 * holds the live half and hands it over". This page is that caller, and from
 * 6f0a34a until 2026-08-18 it called `declaredFleetData(org)` at BOTH sites with
 * no second argument at all -- so `started` was null on every call, `running`
 * was always empty, and the declared fallback drew a tree that could never have
 * a node in it no matter what the person did.
 *
 * WHAT THAT COST, and it is not the tree. Press Start on an agent's own page
 * (#/agent/<computer>/<agent>, which src/agent-session.js publishes the live
 * record from) and come back here: "Nothing has run on this computer yet", over
 * a session that is running. And because showProjectionControls() -- the only
 * builder of Dispatch, Team, Loop and Codex Cloud -- is reached by SELECTING A
 * NODE, a page that can never draw a node is a page on which those four
 * controls do not exist. The declared fallback is what every customer install
 * gets (public/data/fleet.json ships ok:false), so that was all of them. */
import { onLiveSession, readLiveSession } from '../agent-session-registry.js'
import { identityRoleForTreeNode } from '../tree-node-identity.js'
/* WHEN AN OPEN RAIL HAS GONE STALE, in a module the suite drives with values.
   See rebindRailToSession below for the defect it ends, and
   tools/test/tree-rail-rebind.test.mjs for the rule. */
import { railRebindDecision } from '../tree-rail-rebind.js'
/* The editing surface for the DECLARED organisation. It is a separate module
   for the reason given at the top of that file: it is the only part of this
   page that writes, and it is the only part that has to keep a role's wording
   and the role's enforcement side by side. */
import {
  ORG_ABSENT_REASON, REVISION_CONFLICT_ADVICE,
  buildRoleAssignBox, buildRoleLibraryBox, failureSentence, isRevisionConflict,
  orgBridge, orgNoticeMarkup, readOrg,
  restoreRoleLibrary, snapshotRoleLibrary,
} from '../org-controls.js'
import '../board.css'
import '../switch-and-continue.css'
import '../tree-graph.css'
import '../tree-workspace.css'
import '../fleet-overview.css'
/* The panel's own styles are imported HERE rather than by the module, because
   src/agent-compose-panel.js is proven under `node --test` and a stylesheet
   import inside it would make it unloadable there. Same arrangement as the two
   above. */
import '../agent-compose-panel.css'

/* COPY THAT NAMES THE MACHINE THE READER IS ACTUALLY LOOKING AT. The desktop
   application can keep saying "this computer"; over the relay those words name
   the phone or browser in the reader's hands, not the machine whose record and
   controls this view is showing. Keep both sentences together here so a relay
   rendering cannot silently inherit desk-only wording. */
const drivenComputerCopy = (localCopy, relayCopy) => (
  currentDataSource() === 'relay' ? relayCopy : localCopy
)

const ROLE_ASSIGN_UNAVAILABLE = Object.freeze({
  code: 'ORG_ASSIGN_ROLE_UNAVAILABLE',
  reason: 'This installed copy cannot save role changes. Update the app, then try again.',
})

/* WHAT USED TO BE HERE, AND WHY IT IS GONE.
 *
 * Three sliders — "Context budget", "Wake interval", "Autonomy" — and four
 * buttons — Pause, Resume, Respawn, Terminate. Every one of them was inert.
 * The sliders' entire click handler wrote a formatted string into the <span>
 * beside them; the buttons' entire click handler moved an `armed` CSS class
 * from one button to the next. Nothing was stored, nothing was sent, and the
 * page reported no failure because nothing had been attempted.
 *
 * The owner named this class of defect exactly: "dont lie like we cant control
 * temperature". A control that moves and reports success while changing
 * nothing is worse than a missing control, because a missing control can be
 * asked for and a lying one is believed.
 *
 * They are replaced by src/orchestration-controls.js, where every knob carries
 * the file:line that proves it reaches the child process, and the knobs that
 * do not exist are NAMED as not existing rather than quietly left out. */

const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))
function projectedComputer(computer, projection, roles = []) {
  const rolePosture = new Map(roles.map(role => [role.id, role.capabilities || null]))
  const byId = new Map(projection.nodes.map(node => {
    const bornAt = Number.isSafeInteger(node.bornAt) && node.bornAt >= 0 ? node.bornAt : null
    const stoppedAt = bornAt !== null && Number.isSafeInteger(node.stoppedAt) && node.stoppedAt >= bornAt
      ? node.stoppedAt
      : null
    return [node.id, {
      id: node.id,
      name: node.label,
      sessionId: typeof node.sessionId === 'string' && node.sessionId ? node.sessionId : null,
      cloudLane: readCloudLane(node.cloudLane),
      /* ROLES now covers every declared org role directly (src/vocab.js), so
         the role reaches the same appearance whether read from here or from
         declaredRole below -- no translation to a legacy bucket needed or
         wanted; see the ROLES comment in vocab.js for why keeping one would
         now disagree with every other consumer. */
      role: node.role,
      declaredRole: node.role,
      /* Structural behavior comes from the authoritative role definition, not
         from a special role id. This is a UI preflight only; the org store is
         still the authority that accepts or refuses the move. */
      orgRoot: rolePosture.get(node.role)?.orgRoot === true,
      provider: node.provider,
      model: node.provider,
      state: node.enabled ? 'enabled' : 'disabled',
      origin: node.origin === 'user' || node.origin === 'self' ? node.origin : null,
      bornAt,
      stoppedAt,
      tasksDone: Number.isSafeInteger(node.tasksDone) && node.tasksDone >= 0 ? node.tasksDone : null,
      failRate: Number.isFinite(node.failRate) && node.failRate >= 0 && node.failRate <= 100 ? node.failRate : null,
      context: [],
      projectionUnavailableReason: drivenComputerCopy(
        'not part of this computer’s fleet record',
        'not part of the fleet record for the computer you are driving',
      ),
    }]
  }))
  const edges = projection.edges.map(edge => ({ ...edge }))

  const wouldCycle = (child, parent) => {
    let current = parent
    const seen = new Set()
    while (current?.parentId && !seen.has(current.id)) {
      if (current.id === child.id) return true
      seen.add(current.id)
      current = byId.get(current.parentId)
    }
    return current?.id === child.id
  }
  const layoutEdges = [...edges].sort((left, right) =>
    (left.sourceKind === 'observed' ? 0 : 1) - (right.sourceKind === 'observed' ? 0 : 1))
  for (const edge of layoutEdges) {
    if (edge.type !== 'manages' && edge.type !== 'delegates_to') continue
    const parent = byId.get(edge.from)
    const child = byId.get(edge.to)
    if (!parent || !child || child.parentId || parent.id === child.id || wouldCycle(child, parent)) continue
    child.parentId = parent.id
  }

  const graphPosture = roleGraphPosture([...byId.values()], edges, {
    hasAuthoritativeRoles: rolePosture.size > 0,
  })
  for (const agent of byId.values()) {
    const posture = graphPosture.get(agent.id)
    agent.tierRank = posture.tierRank
    if (agent.tierRank === 2) agent.role = 'spawned'
    agent.cullable = posture.cullable
    const originRank = agent.origin === 'user' ? 0 : agent.origin === 'self' ? 2 : 1
    agent.cullRank = originRank * 2 + (agent.state === 'enabled' ? 0 : 1)
  }

  const agents = [...byId.values()]
  return {
    id: computer.id,
    name: computer.label,
    ip: `${computer.services.length} services`,
    note: computer.sourceKind,
    spawnedTotal: agents.length,
    agents,
    services: computer.services,
    graphEdges: edges,
    graphRevision: projection.revision,
    projection: true,
    /* THE FAST, LOCAL HALF OF A DRAG. It is not the authority — the
       organisation store behind window.mcOrg is, and computersView sends every
       accepted move there — but a drag needs an answer in the same frame as the
       pointer, and these are the guards that drive the .drop-ok highlight and
       the .refuse shake. The engine's own cycle check is the one that decides
       whether the move is KEPT; this one only decides what the cursor does. */
    reparentAgent(agentId, parentId) {
      const agent = byId.get(agentId)
      const parent = byId.get(parentId)
      if (!agent || !parent || agent === parent || agent.orgRoot) return false
      let current = parent
      const seen = new Set()
      while (current && !seen.has(current.id)) {
        if (current.id === agent.id) return false
        seen.add(current.id)
        current = current.parentId ? byId.get(current.parentId) : null
      }
      agent.parentId = parent.id
      /* The declared edge list moves with the node. Left alone, the edge that
         named the FORMER manager stays in graphEdges, and src/tree-graph.js
         draws every declared edge that is not already covered by a parent link
         — so the canvas kept asserting a management relationship the person had
         just dragged away from, as a second and softer line. */
      for (let index = edges.length - 1; index >= 0; index -= 1) {
        if (edges[index].to === agentId && HIERARCHY_EDGE_TYPES.has(edges[index].type)) edges.splice(index, 1)
      }
      edges.push({ from: parent.id, to: agentId, type: 'manages', sourceKind: 'declared' })
      return true
    },
  }
}

/* WHY THE SAVED ORGANISATION IS LAID OVER THE GENERATED FILE.
 *
 * public/data/fleet.json is produced by tools/gen-fleet.mjs from
 * config/agent-org.json — the SHIPPED baseline. A person's own edits live in an
 * overlay behind window.mcOrg, and the generator never sees them. Without this
 * merge a reparent could be written to disk correctly and still be absent from
 * the page on the next load, which a person cannot tell apart from not having
 * been written at all.
 *
 * IT APPLIES ONLY WHEN THERE IS SOMETHING TO APPLY. `source === 'baseline'`
 * means the store is serving the same shipped file the projection was generated
 * from, so there is nothing to overlay and the projection is returned untouched
 * — including when the overlay was DAMAGED, where the shipped default is
 * genuinely what the person is looking at and the rail says so.
 *
 * Within an agent the saved org is authoritative for hierarchy: it is the
 * owner-authored management graph, it is what this page's drag control writes,
 * and a page that edited one graph while drawing another would be editing
 * something invisible. Agents the saved org does not declare keep every edge
 * the projection gave them, observed ones included.
 */
const HIERARCHY_EDGE_TYPES = new Set(['manages', 'delegates_to'])

function mergeOrgIntoProjection(graph, org) {
  if (org?.source !== 'overlay' || !Array.isArray(org.agents) || !Array.isArray(org.relationships)) return graph
  const declared = new Map(org.agents.map(agent => [agent.id, agent]))
  const nodes = graph.nodes.map(node => {
    const agent = declared.get(node.id)
    return agent ? { ...node, role: agent.role, enabled: agent.enabled } : node
  })
  const present = new Set(nodes.map(node => node.id))
  const edges = graph.edges
    .filter(edge => !(HIERARCHY_EDGE_TYPES.has(edge.type) && declared.has(edge.to)))
    .concat(org.relationships
      .filter(relation => relation.type === 'manages' && present.has(relation.from) && present.has(relation.to))
      .map(relation => ({ from: relation.from, to: relation.to, type: 'manages', sourceKind: 'declared' })))
  return { ...graph, nodes, edges, revision: org.revision ?? graph.revision }
}

function projectionComputers(data, org = null, roles = []) {
  const graph = data?.graph
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(data?.computers)) return []
  const merged = mergeOrgIntoProjection(graph, org)
  return data.computers.map(computer => projectedComputer(computer, merged, roles))
}

/* Every live card used to read "role: manager / state: disabled" — the same two
   lines on every block, and the role is already the caption under the circle
   and the colour of the brace. The card now carries what the projection
   actually observed, and where the projection carries no activity it SAYS so
   once, in the dim register, instead of padding itself with declared facts.
   The missing thing is real: fleet.json has no per-agent transcript or
   activity feed, so there is nothing truthful to put on those lines today. */
function projectionMonitorContext(agent) {
  const origin = agent.origin === 'user' ? 'owner-started'
    : agent.origin === 'self' ? 'self-started'
      : null
  return {
    current: [agent.state, origin].filter(Boolean).join(' · ') || null,
    previous: null,
    chat: null,
    /* A projection carries no live session, so it has no working to show. */
    thinking: null,
    // Short, because it repeats on every card. The rail's DECLARED GRAPH block
    // already carries the full reason once, where a reason belongs.
    unavailable: 'no activity observed',
    tasks: agent.tasksDone,
    failRate: agent.failRate,
    model: agent.provider,
  }
}

/* monitorContextFor — the hash-seeded fake chat excerpt — and agentChartBox,
   the synthesised per-agent activity chart, stood here. Both existed only for
   the simulated second render, and both fabricated readings (a canned CHAT
   line picked by name-hash; a sine-wave "activity" series) that no source
   ever produced. With one render on one source axis, every card reads
   projectionMonitorContext(): what the record carries, and an honest
   "no activity observed" where it carries nothing. Their departure also took
   this file's whole echarts dependency with them. */

/* ---------------------------------------------------------------
   STARTING A REAL AGENT, WHICH IS THE ONE THING THIS PAGE COULD NOT DO.
   ---------------------------------------------------------------

 * WHAT THE OWNER ASKED FOR. The tree is empty until a person starts something.
 * The empty places in it are drawn, and pressing one is how the structure grows:
 * the panel on the right asks for a role and a message, and answering it starts
 * a real agent. Not a card that says an agent exists — an actual session, on
 * this computer, that a person can then talk to.
 *
 * THE ONE RULE THIS SECTION EXISTS TO KEEP. Nothing here runs on page load.
 * Every function below is reached from a press and from nothing else, which is
 * why the start lives in a function rather than in a promise chain that a mount
 * could fall into. The page's other live control (Dispatch, above) had this
 * property already; a tree that starts a session because somebody navigated to a
 * fleet page would be a far worse defect than the one this repairs.
 *
 * WHY IT IS TWO CALLS AND NOT ONE. `mcAgent.start()` opens a session and mints
 * its own name for it; `mcAgent.send()` carries the person's words into that
 * session. There is no single call that does both, and there should not be: the
 * two fail in genuinely different ways, and a person who is told "it did not
 * start" when in fact it started and their message did not arrive will go and
 * start a second one. So the two refusals are worded separately below, and the
 * session name is carried out of a failed send rather than thrown away.
 *
 * WHY A REFUSAL IS READ RATHER THAN INFERRED. The bridge answers `{ok:false,
 * code}` for a refusal it can describe, and it REJECTS for a refusal raised
 * before anything was spawned — so a start that never happened arrives here as
 * an ordinary value about half the time. Reading only exceptions would let a
 * draft node sit on the screen looking like a running agent, which is this
 * codebase's signature defect (absence read as consent) in its most expensive
 * costume: a person believing work is under way when nothing is.
 *
 * A successful start carries NO `ok:true`. It answers `{sessionId, threadId,
 * tier}` (shell/agent-host.cjs startSession), so the test below is `ok === false`
 * plus a session name that is really a non-empty string. A truthiness check on
 * `ok` would treat every successful start as a failure. */

/* WHERE THE WORDS COME FROM, AND WHY NONE OF THEM ARE WRITTEN HERE.
 *
 * src/fleet-tree-copy.js owns every sentence this flow says about a start: the
 * four curated refusals, the progress lines, the role labels. It composes the
 * rest through src/agent-availability-copy.js and src/refusal-copy.js, so an
 * engine code nobody has written a sentence for still arrives as English with an
 * action in it. This file therefore holds NO refusal table of its own. It had
 * one for about an hour; a second table is how one product ends up describing a
 * missing assistant program two ways on two screens.
 *
 * THE ONE SENTENCE THIS FILE STILL COMPOSES is the send failure, and only
 * because the shared module has no case for it: every sentence there opens with
 * "Nothing was started", which is exactly the fact that is FALSE when the
 * session opened and the message did not land. Composing it from the product's
 * own shared composer (refusalSentence) rather than writing a second table
 * keeps the vocabulary shared and the fact honest. */

/* WHAT AN EMPTY NODE SAYS WHERE THERE IS NO INSTALLED APP BEHIND THE PAGE.
 *
 * The example fleet, the browser preview and the website's screenshots all run
 * this same view with no agent bridge on `window`. Pressing an empty node there
 * has to explain itself, because the two dishonest options are both worse: a
 * press that silently does nothing reads as a broken product, and a press that
 * reports a refusal reads as a fault on a machine that has none.
 *
 * It names no mechanism and no address. What a person needs is the one fact
 * that this is not the installed application, and the one action that follows
 * from it. It lives here rather than in the shared copy module because it is not
 * a refusal from the engine — nothing was asked of anything. */
/* One desk sentence; the relay reading comes from REMOTE_TWIN in
   refusal-copy.js like every other desk phrase, so the scan and the coverage
   tests hold it shut from both ends. An inline second literal here was the
   2026-08-25 lesson: the scan flagged it because its wording sat outside the
   remote vocabulary, and an inline pair is a correspondence no table checks. */
const START_NEEDS_APP_TEXT = () => readerRemedy(
  'Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. Open ToolsEnabled on your computer to grow a real tree.',
  { viaRelay: currentDataSource() === 'relay' },
)

/* WHY THE EXAMPLE FLEET DOES NOT GROW TREES, and it is the same fence dd01899
   put on this page's Dispatch control.
   `isWriteEnabled` is a question about PERMISSION; this is a question about
   PROVENANCE, and they are not the same question. On the desktop with the
   example toggle on, a real agent bridge exists on `window`, so an empty node
   pressed on the example fleet would start a real session on this computer
   from a page whose own badge says nothing on it is real. The refusal
   therefore sits BEFORE any bridge check, and this sentence is what every
   mock-sourced start surface answers with.
   MODULE SCOPE because startAgentForNode below — itself module-scope, and
   exported for the research dispatcher — is one of those surfaces. The
   sentence names the switch's real home: Settings → What the screens show, the one
   "Show the example fleet" toggle that replaced the per-view flags. */
/* AND IT IS A FUNCTION NOW, BECAUSE THE SENTENCE DEPENDS ON WHY THIS SCREEN IS
   ON THE EXAMPLE. A person who turned the switch on is told which switch to
   turn off. A visitor in a browser, who never touched a switch and cannot
   reach that one, is told what this page is. See previewWithoutHost() in
   src/data-source.js for the measurement that produced this branch. */
const EXAMPLE_BOARD_TEXT = 'This is the example fleet, so nothing here can start a real agent. Turn off “Show the example fleet” in Settings, under What the screens show, to build a tree on your own computer.'
/* The signed-out default is a THIRD reason to be on the example, and it takes
   neither existing sentence. EXAMPLE_BOARD_TEXT sends them to a switch, which
   for somebody with no computer on the account leads nowhere; START_NEEDS_APP
   assumes the only thing missing is the application, when what is missing is a
   sign-in. */
const SIMULATION_BOARD_TEXT = 'This is the simulation, so nothing here starts a real agent. Sign in to see your own computers, or install ToolsEnabled to grow a real tree.'
const exampleBoardText = () => {
  if (exampleIsSignedOutDefault()) return SIMULATION_BOARD_TEXT
  return previewWithoutHost() ? START_NEEDS_APP_TEXT() : EXAMPLE_BOARD_TEXT
}

/* ONE SENTENCE FOR "THE EXAMPLE IS NOT YOURS TO REARRANGE", exported so a test
   can hold its value. Every surface that could restructure the example tree
   refuses with THIS string: the Edit button's disable (syncEditAvailability),
   and the Details tab's Reports-to Save (the moveSave handler). The drag is
   the third surface and it is locked by mountGraph's null onReparent instead —
   tree-graph.js refuses any drop with no callback.

   Before the Save gate existed, the drag and the Edit button refused while the
   rail's Reports-to picker happily re-parented the example tree and announced
   "Saved." — measured on the desktop and the phone press-throughs, 2026-08-27:
   the whole example hierarchy restructured, the "say hey" chip vanished from
   the switcher, and nothing short of a reload could put it back, on the same
   screen whose Edit button said nothing in it was yours to rearrange. */
export const EXAMPLE_REARRANGE_TEXT = 'This is the example fleet — nothing in it is yours to rearrange.'

/* THE WAY BACK TO YOUR OWN COMPUTER, said correctly for whichever visitor is
   reading it. Four places on this page used to name a switch; the browser
   preview reaches none of them. */
/* THREE STATES, NOT TWO — and the third one is the whole web journey.
 *
 * The two below are "you chose the example" and "you have no ToolsEnabled".
 * The one that was missing is the person who has ToolsEnabled, has it
 * connected, and whose machine simply did not answer this minute. Telling them
 * to install it is an instruction they cannot follow, about a problem they do
 * not have, and it was measured on the live site being said to exactly that
 * person a minute after /account/ told them their computer was "awake and
 * ready".
 *
 * Only the host bridge knows which of those it is, so when it has left a reason
 * that reason wins. When it has not, the install sentence is still the right
 * guess for a browser with no host — that is who reaches this page cold. */
const exampleExitSentence = () => {
  /* Asked first: this visitor chose nothing and has no host, so both of the
     branches below would mislead them in different directions. */
  if (exampleIsSignedOutDefault()) {
    return 'Nobody is signed in, so this is the simulation. Sign in to see your own computers, or install ToolsEnabled to grow a real tree.'
  }
  if (!previewWithoutHost()) {
    return 'Turn off “Show the example fleet” in Settings, under What the screens show, to see your own computer and its controls.'
  }
  return hostFallbackSentence()
    || 'This page is a preview of ToolsEnabled running in your browser. Install ToolsEnabled on your computer to see your own fleet and its controls.'
}

/* THE SENTENCE FOR THE ONE FAILURE THAT IS NOT A FAILED START.
 *
 * The lead states the fact only this file knows — the session opened, the words
 * did not arrive — and refusalSentence() supplies the diagnosis and the remedy
 * from the product's shared tables. It can never return a code and it can never
 * return an empty string, so this is always two whole sentences. */
const SEND_FAILED_LEAD = 'Your agent started, and your message did not reach it.'
function sendRefusalSentence(result) {
  return `${SEND_FAILED_LEAD} ${refusalSentence(result, { fallback: 'The message was not accepted by the session.' })}`
}

const TERMINAL_AGENT_SESSION_CODES = new Set(['MC_AGENT_SESSION_ENDED', 'MC_AGENT_UNKNOWN_SESSION'])

function endedAgentStartOutcome({ sessionId, threadId = null, roleIntroduction = null, code = 'MC_AGENT_SESSION_ENDED' }) {
  const refusal = { ok: false, code }
  return {
    ok: false,
    needsApp: false,
    /* This id really ran and belongs in the durable node record, but it must
       never be put back into the live-session map. */
    sessionId,
    threadId,
    roleIntroduction,
    sessionEnded: true,
    code,
    sentence: readerRemedy(sendRefusalSentence(refusal), { viaRelay: currentDataSource() === 'relay' }),
    needsAssistantProgram: false,
  }
}

/* START AN AGENT FOR ONE NODE OF THE TREE, and report what really happened.
 *
 * Answers one of four states, and the caller has to be able to tell them apart:
 *
 *   { ok: true, sessionId }        a session is open and the words were sent
 *   { ok: false, needsApp: true }  there is no installed app behind this page
 *   { ok: false, sessionId: null } nothing started; the node did not begin
 *   { ok: false, sessionId }       a session IS open and the words did not land
 *
 * The fourth is the one worth the length. Throwing the session name away because
 * the send was refused would leave a real agent running on the person's computer
 * with nothing on screen pointing at it, and the node would invite them to start
 * a second one. So the name comes back, the node keeps it, and the sentence says
 * plainly that the agent is running and the message is not.
 */
/* Exported for the research workbench's dispatcher: an experiment worker is
   started through THIS function — the same contract, the same refusal
   sentences, the same four outcome shapes — so a worker node on the tree is
   indistinguishable from one the compose panel started. */
/* `onSessionOpen` IS CALLED BETWEEN THE TWO CALLS, AND THAT POSITION IS THE
 * WHOLE REASON IT EXISTS.
 *
 * A caller learns the session's name from the value this function returns --
 * which is to say, after the message has been sent. Everything a surface needs
 * in order to RECEIVE that turn is keyed by that name: the fleet tree's event
 * listener drops any packet whose sessionId it has not been told about yet.
 *
 * That ordering held for as long as sending answered immediately. MEASURED
 * 2026-08-17 against both engines, it does not: the Claude CLI reports a turn
 * by streaming it, so its first words -- and, when the answer is short enough
 * to arrive in one read, its completion too -- reach the page before the send
 * is answered. Every one of those packets was dropped, and the node sat at
 * `running` with nothing in it and no error to show for it.
 *
 * So the session is handed over the moment it exists and BEFORE anything is
 * sent into it, when no event for it can possibly have been emitted yet. That
 * is true of every engine rather than of the fast one, which is the property
 * this had to have and did not.
 *
 * A callback that throws must not take the start with it: the session is real
 * by then, and losing it here would leave an agent running with nothing on
 * screen naming it -- the failure the four outcome shapes above exist to
 * prevent. */
/* IPC rejection strips error properties. Name the request before crossing it
   so a host that retains failed startup cleanup still has a reachable Stop
   target. A cleanup target is never an opened conversation. */
export function startOutcomeReleasesCustody(outcome, requestSessionId) {
  try {
    if (!requestSessionId || !outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || outcome.requestSessionId !== requestSessionId || outcome.custody !== 'none') return false
    return (outcome.admission === 'not-admitted' && outcome.cleanup === 'not-required')
      || (outcome.admission === 'unknown' && outcome.cleanup === 'confirmed')
  } catch { return false }
}

export function withRetainedStartIdentity(bridge, onCleanupRequired = () => {}, researchProjectId = null) {
  if (!bridge || typeof bridge.start !== 'function') return bridge
  const boundBridge = withResearchTreeBinding(bridge)
  return {
    ...boundBridge,
    async start(request) {
      const sessionId = request.sessionId || globalThis.crypto?.randomUUID?.()
      if (!sessionId) throw new Error('AGENT_SESSION_NO_ID')
      // Only these two host receipts release this invocation's custody.
      // Error codes, absent IPC properties and another request's receipt do not.
      const released = value => {
        const outcome = value?.startOutcome
        return outcome?.requestSessionId === sessionId && outcome.custody === 'none'
          && ((outcome.admission === 'not-admitted' && outcome.cleanup === 'not-required')
            || (outcome.admission === 'unknown' && outcome.cleanup === 'confirmed'))
      }
      const retain = value => onCleanupRequired({ sessionId,
        code: refusalCodeOf(value) || 'AGENT_SESSION_CLEANUP_FAILED' })
      let result
      try {
        result = await boundBridge.start({ ...request, ...(researchProjectId ? { researchProjectId } : {}), sessionId })
      } catch (error) {
        if (!released(error)) retain(error)
        throw error
      }
      if (result?.ok === false || typeof result?.sessionId !== 'string' || !result.sessionId) {
        if (!released(result)) retain(result)
      }
      return result
    },
  }
}

function savedResearchRestrictionRefusal(node) {
  if (!node?.researchRestriction) return null
  return { ok: false, code: 'AGENT_RESEARCH_RESTART_REFUSED', message: 'This restricted research session cannot be resumed or restarted without re-establishing its trusted research boundary.' }
}

function researchRestrictionLabel(restriction) {
  if (!restriction) return ''
  const mode = restriction.mode === 'clean-room' ? 'Clean room' : 'Selected folder'
  const access = restriction.access === 'read-write' ? 'Read and write' : 'Read only'
  const root = String(restriction.root || '').replaceAll('\\', '\\\\')
  const retained = restriction.mode === 'clean-room' ? ' Inputs and outputs stay in this folder after the agent stops.' : ''
  return `Restricted research · ${mode} · ${access} · Folder: ${root}. Restart/resume unavailable.${retained}`
}

export async function startAgentForNode({ text, historyHandoff = null, automatic = false, surface, tier, effort, treeAccount = null, profileId, researchProjectId = null, research = null, researchSetup, requestKeys = null, treeIdentity = null, roleBinding = null, replacesSessionId = null, delegationToken = null, boundedWork = null, editorForkReceipt = null, treeCommandRequestId = null, onSessionOpen, onSessionEnd, sessionIsOpen, onCleanupRequired, onFirstTurnFailure, beforeSessionOpen = null, startRequestSessionId = null }) {
  /* THE MOCK REFUSAL COMES BEFORE THE BRIDGE CHECKS, deliberately. On the
     desktop with the example toggle on, window.mcAgent EXISTS and works — so
     a bridge-presence test alone would let a mock-sourced press start a real
     session. Mock never writes; the sentence says which switch makes it real.
     `needsApp: false` because the app may genuinely be installed — the
     needsApp shape is reserved for the browser-preview absence it describes. */
  if (currentDataSource() === 'mock') {
    return {
      ok: false,
      needsApp: false,
      sessionId: null,
      code: null,
      sentence: exampleBoardText(),
      needsAssistantProgram: false,
    }
  }
  let cleanupSessionId = null
  const bridge = withRetainedStartIdentity(typeof window === 'undefined' ? null : window.mcAgent, retained => {
    cleanupSessionId = retained.sessionId
    if (typeof onCleanupRequired === 'function') onCleanupRequired(retained)
  })
  if (!bridge || typeof bridge.start !== 'function' || typeof (automatic ? bridge.sendAutomatic : bridge.send) !== 'function') {
    return {
      ok: false,
      needsApp: true,
      sessionId: null,
      code: null,
      sentence: START_NEEDS_APP_TEXT(),
      needsAssistantProgram: false,
    }
  }

  let started = null
  try {
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) {
      return { ok: false, needsApp: false, sessionId: null, code: 'MC_TREE_COMMAND_START_DISABLED',
        sentence: startControlOffReason(), needsAssistantProgram: false }
    }
    /* The tier rides only when the panel supplied one: agent.js's page start
       sends none and keeps its old shape, and parseAgentStart treats an absent
       tier as the engine's own default rather than a refusal. Two literal
       calls rather than one built object, because the fleet-trees suite
       measures every `.start({...})` in this file mechanically and a request
       assembled elsewhere is a call it cannot read. */
    /* Optional keys ride only when supplied; profileId is an ID the main
       process resolves against folders the person picked in the OS dialog --
       the renderer never handles a path. */
    const startRequest = {
      ...(startRequestSessionId ? { sessionId: startRequestSessionId } : {}),
      ...(treeAccount ? { treeAccount } : {}),
      ...(historyHandoff ? { historyHandoff } : {}),
      surface,
      ...(tier ? { tier } : {}),
      ...(effort ? { effort } : {}),
      ...(profileId ? { profileId } : {}),
      ...(!research && researchProjectId ? { researchProjectId } : {}),
      ...(research ? { research } : {}),
      ...(researchSetup !== undefined ? { researchSetup } : {}),
      /* Identity plus the exact org/role snapshot the person picked from. The
         renderer sends no directions here: main re-reads the authoritative
         role store and replaces this packet before the host sees it. */
      ...(roleBinding ? { roleBinding } : {}),
      /* The standing-request scope keys — tree node ids and the conversation's
         own id, never paths — so the session's first turn can carry the
         person's filed rules. See nodeRequestKeys() and shell/agent-host.cjs. */
      ...(requestKeys ? { requestKeys } : {}),
      /* The saved circle and manager names. Fresh starts also say these in the
         brief below; resumes do not send a brief, so the host needs the saved
         address on the start itself to avoid restoring a dead row's parent. */
        ...(treeIdentity ? { treeIdentity } : {}),
        ...(replacesSessionId ? { replacesSessionId } : {}),
      ...(delegationToken ? { delegationToken } : {}),
      ...(boundedWork ? { boundedWork } : {}),
      ...(editorForkReceipt ? { editorForkReceipt } : {}),
      ...(treeCommandRequestId ? { treeCommandRequestId } : {}),
    }
    started = await bridge.start(startRequest)
  } catch (error) {
    /* A REJECTION IS A REFUSAL WITH ITS CODE IN THE MESSAGE. Electron rebuilds a
       rejected call in this window from the error's name and message; own
       properties do not survive, so `error.code` is undefined for every refusal
       that crossed the boundary and shell/main.cjs makes the MESSAGE the code
       for exactly that reason. refusalCode() reads it back and only ever returns
       a code the shared tables already have a sentence for. */
    if (startRequestSessionId && !cleanupSessionId && !startOutcomeReleasesCustody(error?.startOutcome, startRequestSessionId)) {
      cleanupSessionId = startRequestSessionId
      onCleanupRequired?.({ sessionId: cleanupSessionId, code: 'AGENT_SESSION_CLEANUP_FAILED' })
    }
    const refusal = { ok: false, code: refusalCode(error) }
    return {
      ok: false,
      needsApp: false,
      sessionId: cleanupSessionId,
      ...(cleanupSessionId ? { cleanupPending: true } : {}),
      code: refusal.code,
      /* THE TIER RIDES WITH THE REFUSAL. AGENT_TIER_NO_LAUNCHER is raised for
         whichever provider this build has no launcher for, and only the press
         knows which one was asked for -- see tierNoLauncherSentence(). Every
         other code ignores it. */
      sentence: readerRemedy(startRefusalSentence(refusal, { tier }), { viaRelay: currentDataSource() === 'relay' }),
      needsAssistantProgram: refusalNeedsAssistantProgram(refusal),
    }
  }
  /* READ, not inferred. `started.ok === false` is the described refusal;
     a missing or empty session name is a reply that cannot be steered even if it
     claims success, and treating it as a start would produce a node pointing at
     a session nothing can send to. */
  if (!started || started.ok === false || typeof started.sessionId !== 'string' || started.sessionId.length === 0) {
    if (startRequestSessionId && !cleanupSessionId && !startOutcomeReleasesCustody(started?.startOutcome, startRequestSessionId)) {
      cleanupSessionId = startRequestSessionId
      onCleanupRequired?.({ sessionId: cleanupSessionId, code: 'AGENT_SESSION_CLEANUP_FAILED' })
    }
    return {
      ok: false,
      needsApp: false,
      sessionId: cleanupSessionId,
      ...(cleanupSessionId ? { cleanupPending: true } : {}),
      code: refusalCodeOf(started),
      sentence: readerRemedy(startRefusalSentence(started, { tier }), { viaRelay: currentDataSource() === 'relay' }),
      needsAssistantProgram: refusalNeedsAssistantProgram(started),
    }
  }

  const sessionId = started.sessionId
  const nativeWork = { ...(typeof started.effort === 'string' && started.effort ? { effort: started.effort } : {}), ...(boundedWork ? { boundedWork: started.boundedWork || null, record: started.record || null } : {}), ...(started.researchRestriction ? { researchRestriction: started.researchRestriction } : {}) }
  /* The engine names the thread it opened. Kept and handed to the caller so
     the durable transcript record can carry it — the name a TRUE engine-side
     resume would ask for, saved now so that future has no data gap. */
  const threadId = typeof started.threadId === 'string' && started.threadId.length > 0 ? started.threadId : null
  const account = typeof started.account === 'string' && started.account.length > 0 ? started.account : null
  const launchSettings = Object.prototype.hasOwnProperty.call(started, 'launchSettings') ? started.launchSettings : undefined
  const roleIntroduction = typeof started.roleIntroduction === 'string' && started.roleIntroduction.length > 0
    ? started.roleIntroduction
    : null
  /* The main process can observe and record a child exit before its start
     receipt crosses IPC. The terminal packet may therefore predate this
     view's session mapping. The explicit receipt bit is the only race-free
     proof available here; do not register or send through that dead id. */
  if (started.ended === true) {
    return { ...endedAgentStartOutcome({
      sessionId,
      threadId,
      roleIntroduction,
      code: started.endCode === 'MC_AGENT_SESSION_ENDED' ? started.endCode : 'MC_AGENT_SESSION_ENDED',
    }), ...nativeWork }
  }
  if (beforeSessionOpen) {
    let admitted = false
    try { admitted = await beforeSessionOpen({ sessionId, threadId, account }) === true } catch { /* no first send without positive admission */ }
    if (!admitted) return { ok: false, sessionId, threadId, cancelled: true,
      code: 'MC_TREE_COMMAND_SESSION_CHANGED', sentence: 'The selection changed before its opening task was sent.' }
  }
  const restrictedStart = Boolean(research || started.researchRestriction)
  if (typeof onSessionOpen === 'function') {
    try {
      const opened = await onSessionOpen({ sessionId, threadId, account, roleIntroduction, ...nativeWork,
        ...(launchSettings !== undefined ? { launchSettings } : {}),
        ...(started.resourceAdmission ? { resourceAdmission: started.resourceAdmission } : {}) })
      if (beforeSessionOpen && opened !== true) return { ok: false, sessionId, threadId, cancelled: true,
        code: 'MC_TREE_COMMAND_SESSION_CHANGED', sentence: 'The selection changed before its opening task was sent.' }
      if (restrictedStart && opened?.ok === false) {
        return { ok: false, needsApp: false, sessionId, threadId, account, roleIntroduction, ...nativeWork,
          code: opened.code || 'RESEARCH_RESTRICTION_NOT_SAVED',
          sentence: opened.sentence || 'The restricted research session could not be saved.',
          needsAssistantProgram: false }
      }
    } catch (error) {
      if (restrictedStart) {
        return { ok: false, needsApp: false, sessionId, threadId, account, roleIntroduction, ...nativeWork,
          code: error?.code || 'RESEARCH_RESTRICTION_NOT_SAVED',
          sentence: error?.message || 'The restricted research session could not be saved.',
          needsAssistantProgram: false }
      }
      if (beforeSessionOpen) {
        onCleanupRequired?.({ sessionId, code: 'AGENT_SESSION_CLEANUP_FAILED' })
        return { ok: false, sessionId, threadId, cleanupPending: true,
          code: 'AGENT_SESSION_CLEANUP_FAILED', sentence: 'The opening task was held because its session could not be attached.' }
      }
      /* Ordinary callback behavior remains best-effort. */
    }
  }
  async function sendFirstTurn() {
  let sent = null
  try {
    if (automatic) {
      // The trusted surface forces automatic origin and returns a tracked
      // disposition. Missing/unknown receipts must never become a person send.
      const delivery = await bridge.sendAutomatic({ sessionId, text })
      if (delivery?.ok !== true || delivery.deliveryDisposition !== 'accepted'
        || !delivery.result || typeof delivery.result !== 'object' || Array.isArray(delivery.result) || delivery.result.ok === false) {
        return { ok: false, sessionId, threadId, roleIntroduction, ...nativeWork,
          deliveryDisposition: delivery?.deliveryDisposition === 'accepted' ? 'accepted'
            : delivery?.deliveryDisposition === 'not-sent' && delivery?.ok === false ? 'not-sent' : 'unknown',
          code: delivery?.code || 'AGENT_AUTOMATIC_DELIVERY_UNCONFIRMED',
          sentence: 'The continuation could not be confirmed. Its session is retained; review the conversation before trying again.' }
      }
      sent = delivery.result
    } else sent = await bridge.send({ sessionId, text: research ? research.prompt : text })
  } catch (error) {
    if (automatic) return { ok: false, sessionId, threadId, roleIntroduction, ...nativeWork,
      deliveryDisposition: 'unknown', code: refusalCode(error) || 'AGENT_AUTOMATIC_DELIVERY_UNCONFIRMED',
      sentence: 'The continuation could not be confirmed. Its session is retained; review the conversation before trying again.' }
    const refusal = { ok: false, code: refusalCode(error) }
    if (TERMINAL_AGENT_SESSION_CODES.has(refusal.code)) {
      if (typeof onSessionEnd === 'function') {
        try { onSessionEnd({ sessionId, code: refusal.code }) } catch { /* the terminal result below remains authoritative */ }
      }
      return endedAgentStartOutcome({ sessionId, threadId, roleIntroduction, code: refusal.code })
    }
    return {
      ok: false,
      needsApp: false,
      sessionId,
      threadId,
      ...nativeWork,
      code: refusal.code,
      /* Re-read for a browser driving this computer, exactly as the two start
         paths above already are: a stored desk remedy tells a person at a phone
         to close an app they are not sitting at. */
      sentence: readerRemedy(sendRefusalSentence(refusal), { viaRelay: currentDataSource() === 'relay' }),
      needsAssistantProgram: false,
    }
  }
  if (sent && sent.ok === false) {
    const code = refusalCodeOf(sent)
    if (TERMINAL_AGENT_SESSION_CODES.has(code)) {
      if (typeof onSessionEnd === 'function') {
        try { onSessionEnd({ sessionId, code }) } catch { /* the terminal result below remains authoritative */ }
      }
      return endedAgentStartOutcome({ sessionId, threadId, roleIntroduction, code })
    }
    return {
      ok: false,
      needsApp: false,
      sessionId,
      threadId,
      ...nativeWork,
      code,
      sentence: readerRemedy(sendRefusalSentence(sent), { viaRelay: currentDataSource() === 'relay' }),
      needsAssistantProgram: false,
    }
  }
  if (typeof sessionIsOpen === 'function') {
    let stillOpen = false
    try { stillOpen = sessionIsOpen(sessionId) === true } catch { stillOpen = false }
    if (!stillOpen) {
      if (typeof onSessionEnd === 'function') {
        try { onSessionEnd({ sessionId, code: 'MC_AGENT_SESSION_ENDED' }) } catch { /* the terminal result below remains authoritative */ }
      }
      return endedAgentStartOutcome({ sessionId, threadId, roleIntroduction })
    }
  }
  return { ok: true, needsApp: false, sessionId, threadId, account, roleIntroduction, ...nativeWork,
    ...(launchSettings !== undefined ? { launchSettings } : {}), code: null, sentence: null, needsAssistantProgram: false }
  }
  if (delegationToken || boundedWork) {
    // A spawn acknowledges the retained root, not completion of its work.
    // Holding the tree broker through this turn deadlocks a child's own spawn.
    // onSessionOpen above already attached the actual session to its circle.
    void sendFirstTurn().then(outcome => {
      if (!outcome.ok && typeof onFirstTurnFailure === 'function') onFirstTurnFailure(outcome)
    }).catch(() => {
      if (typeof onFirstTurnFailure === 'function') {
        try { onFirstTurnFailure({ ok: false, sessionId, threadId,
          code: 'MC_TREE_COMMAND_START_FAILED', sentence: 'The assistant started, but its opening task could not be completed.' }) } catch {}
      }
    })
    return { ok: true, needsApp: false, sessionId, threadId, account, roleIntroduction, ...nativeWork,
      ...(launchSettings !== undefined ? { launchSettings } : {}),
      firstTurnState: 'submitted', code: null, sentence: null, needsAssistantProgram: false }
  }
  return sendFirstTurn()
}

/* THE SESSIONS THIS APP RUN REALLY OWNS.
 *
 * MODULE SCOPE IS THE WHOLE POINT: this map lives exactly as long as the
 * renderer does. A local child process dies with the application, so a session
 * id read back from storage at the next
 * launch names something that is not there any more, and a map rebuilt from
 * storage cannot tell the two apart.
 *
 * IT REPLACES A PER-VIEW MAP THAT WAS REFILLED FROM THE STORE, and that refill
 * is the defect. It was added for a real reason -- leaving the fleet page and
 * coming back orphaned every session this window still owned, so replies had
 * nowhere to land (measured 2026-08-13) -- but it fixed that by declaring every
 * SAVED session live, including the ones killed when the app last closed. What
 * a person then met, measured on the packaged build 2026-08-16: close the app
 * mid-turn, reopen the same profile, and the circle is blue with a ticking
 * clock over a process that does not exist, the chip says "starting" forever,
 * Stop stands over a corpse, Resume is refused BECAUSE it looks busy, and a
 * typed message answers "Queued -- sends by itself when this turn finishes"
 * into a queue no turn will ever drain.
 *
 * A map that outlives the VIEW but not the PROCESS answers both: a session this
 * run started stays routable across every navigation, and a session from a
 * previous run is absent, which is the truth. nodeBusy() is the reader that
 * matters -- see its note -- and the recovery it hands a stale node to
 * (MC_AGENT_UNKNOWN_SESSION -> recoverDeadSessionSend) was written for exactly
 * this state and has been unreachable since the refill landed.
 *
 * The website has a separate lifetime from its desktop host. After a browser
 * reload, reconnectSavedRemoteSessions verifies each saved session with that
 * host before restoring its routing edge. Storage alone never restores one. */
/* AND WHEN EACH OF THOSE SESSIONS WAS LAST HEARD FROM.
 *
 * Membership above is the right answer to "is this session from THIS run", and
 * the wrong answer to "is it still there". An id goes in at start and comes out
 * only when an end is confirmed; if the end never arrives -- the child was
 * killed, the host never wrote the outcome, the machine stalled -- the id stays
 * for the rest of the run and every screen that asks reads busy forever.
 *
 * MEASURED in agent-spawn-records.jsonl (tail 1500, records dated 2026-09-18
 * and 09-19): 456 lines, 185 agent_session_start, 185 agent_session_outcome,
 * 86 agent_session_end. Ninety-nine started sessions have no end record.
 *
 * THE STAMP LIVES ON THE MAP ITSELF, NOT AT ITS CALL SITES, and that placement
 * is load-bearing. Several suites (tree-start-persistence, tree-start-cleanup-
 * retention, session-recovery, resume-destroyed-session-leak) run functions
 * lifted out of this file inside their own scope, so a free helper called
 * beside each `sessionNodeIds.set(...)` is not defined when they run it --
 * measured as 28 failures in tree-start-persistence alone. Every one of those
 * call sites already holds this object, so teaching the object is the only
 * placement that reaches all of them and adds no new identifier to any.
 *
 * `touch` is separate from `set` because evidence and membership are different
 * facts: a packet from a session proves it is alive without changing who owns
 * it, and an attach proves ownership at an instant that also counts as alive. */
class RunSessionNodes extends Map {
  constructor(...args) {
    super(...args)
    this.seenAt = new Map()
  }

  /** Record evidence this session answered, without claiming ownership. */
  touch(sessionId) {
    if (typeof sessionId === 'string' && sessionId) this.seenAt.set(sessionId, Date.now())
    return this
  }

  set(sessionId, nodeId) {
    this.touch(sessionId)
    return super.set(sessionId, nodeId)
  }

  delete(sessionId) {
    this.seenAt.delete(sessionId)
    return super.delete(sessionId)
  }

  clear() {
    this.seenAt.clear()
    return super.clear()
  }
}

const RUN_SESSION_NODES = new RunSessionNodes()
/* WHAT THE HOST HAS ALREADY REFUSED. The saved-session sweep runs on every
   mount of this view and of the Home chat, for every saved circle whose
   session this run does not own. A session the host does not hold is refused
   every time it is asked, and every refusal is a handler stack in the host's
   log: MEASURED 2026-09-21 on the LIVE generation (app d46c18f49), 303 refused
   mc-agent:models reads in 27 minutes, one burst of ~76 per mount. Module
   state like RUN_SESSION_NODES, so a remount asks only about circles that
   changed; src/saved-session-refusals.js says what "changed" means. */
const SAVED_SESSION_REFUSALS = createSavedSessionRefusals()
/* HAS ANYONE ASKED THE HOST YET. Empty means "this run owns no session" only
   once the saved-session sweep above has actually run: before it, a reload has
   emptied RUN_SESSION_NODES while the host keeps those sessions working, and
   reconnectRemoteSessions refills it one awaited round trip at a time. A seat
   count drawn from the map in that gap frees seats that are still occupied, so
   seat counters ask this first and keep their old count until it is true. A
   display may be wrong for a moment and then heal; a seat handed out twice is
   written down. See createFleetTreeStore's `ownedSessions`. */
let runSessionSweepDone = false
const seatSessionEvidence = () => (runSessionSweepDone ? RUN_SESSION_NODES : null)
// Directory writes belong to the surviving sessions, including when a new
// Trees view opens while an earlier view is still awaiting acknowledgement.
const RUN_TREE_ADDRESS_SYNCS = new Map()
const RUN_NODE_REPLACEMENTS = createSingleFlight()
let accountRecoveryCoordinator = null
let RUN_RECOVERY_BRIDGE = null
let RUN_RECOVERY_BOUND_BRIDGE = null
/* This is a retained host binding, not a view binding. Both bootstrap and
   openTreeStore register the same coordinator context, while a bridge swap
   invalidates the old host instead of attaching recovery to a new view. */
function recoveryImageContext() {
  if (typeof window === 'undefined' || !window.mcAgent) return null
  const recoveryBridge = window.mcAgent
  const canContinue = () => currentDataSource() === 'local' && window.mcAgent === recoveryBridge
  const boundBridge = withResearchTreeBinding(recoveryBridge)
  if (RUN_RECOVERY_BRIDGE && RUN_RECOVERY_BRIDGE !== recoveryBridge) {
    return { available: false, unavailable: 'IMAGE_RECOVERY_BRIDGE_CHANGED', bridge: boundBridge, canContinue }
  }
  if (typeof recoveryBridge.imageQueue !== 'function') {
    /* Ordinary browser/remote bridges do not expose durable image custody. Keep
       account recovery available while publishing an explicit capability
       refusal; absence is never read as an empty retained queue. */
    return { available: false, unavailable: 'IMAGE_RECOVERY_IMAGE_QUEUE_UNAVAILABLE', bridge: boundBridge, canContinue }
  }
  if (!RUN_RECOVERY_BRIDGE) {
    RUN_RECOVERY_BRIDGE = recoveryBridge
    RUN_RECOVERY_BOUND_BRIDGE = boundBridge
  }
  return {
    available: true,
    bridge: RUN_RECOVERY_BOUND_BRIDGE,
    canContinue,
  }
}

/* THE VIEW'S FAILURE-FIRST CONSENT READ, lent to the module-level coordinator.
   keepTryingOnLimitIsOn is closure-private to computersView (and is executed
   by tools/test/resume-keeps-the-conversation.test.mjs in that shape), while
   the coordinator is a singleton built here; the view sets this on mount.
   Until it does, the answer is no. */
let RUN_KEEP_TRYING_CONSENT = async () => false
function recoveryCoordinator() {
  if (!accountRecoveryCoordinator && typeof window !== 'undefined' && window.mcAgent) {
    const imageContext = recoveryImageContext()
    accountRecoveryCoordinator = createAccountRecoveryCoordinator({
      // The live start-consent reader leads: recovery starts sessions only while starting is on.
      canStart: () => isWriteEnabled(START_CONTROL_FLAG),
      bridge: imageContext?.bridge || window.mcAgent, sessionNodeIds: RUN_SESSION_NODES, moveOutbox: outboxMoveSession,
      orgBridge: window.mcOrg, readAccounts: () => loadAccounts(window), tiers: LAUNCH_TIERS,
      outbox: { takeNext: outboxTakeNext, confirmDelivered: outboxConfirmDelivered, requeueFront: outboxRequeueFront },
      canContinue: imageContext?.canContinue || (() => currentDataSource() === 'local' && window.mcAgent === imageContext?.bridge),
      keepTryingOnLimit: () => RUN_KEEP_TRYING_CONSENT(),
      isReplacing: nodeId => RUN_NODE_REPLACEMENTS.busy(nodeId),
      onCleanupRequired: (store, nodeId, sessionId, context) => retainTreeSessionCleanup(store, nodeId, sessionId,
        { ...context, note: 'The incomplete replacement still needs cleanup. Use Stop on this agent.' }),
    })
  }
  return accountRecoveryCoordinator
}
// Opening Home also restores opted-in work. These are the same validated
// data stores Page 2 adopts; no saved session is declared live before the host
// resumes its exact provider thread and the transcript binding is confirmed.
let continuationBootstrap = null
export function initializeAutonomousContinuations() {
  if (typeof window === 'undefined' || typeof window.mcAgent?.continuations !== 'function' || continuationBootstrap) return
  let reading = false
  const register = async () => {
    if (reading || currentDataSource() !== 'local') return
    reading = true
    try {
      // Register the saved stores before the coordinator reads. Its single
      // catalogue reader owns failure status, retry backoff and resume gates.
      const coordinator = recoveryCoordinator()
      for (const computer of FLEET.machines || []) {
        const computerId = computer.id
        if (!computerId || coordinator.hasContext(computerId)) continue
        const storage = safeTreeStorage(window.localStorage)
        /* The SAME set the runtime view judges liveness by, so the store's seat
           count and the screen's "is this circle still alive" can never
           disagree — the disagreement between two such maps is the defect
           src/tree-session-liveness.js was written to end. */
        const treeStore = createTreeRuntimeView(
          createFleetTreeStore({ computerId, storage, ownedSessions: seatSessionEvidence }), RUN_SESSION_NODES)
        if (!treeStore.snapshot().nodes.length) continue
        const legacy = createTranscriptStore({ computerId, storage })
        coordinator.register(computerId, {
          treeStore,
          imageRecovery: recoveryImageContext(),
          transcriptStore: window.mcTranscripts ? createNodeTranscriptClient({ computerId, bridge: window.mcTranscripts,
            legacy, nodeIds: treeStore.snapshot().nodes.map(node => node.id) }) : legacy,
          handoffStore: createRecoveryHandoffStore({ computerId, storage, bridge: window.mcRecovery || null }),
        })
      }
      clearInterval(continuationBootstrap)
    } catch { /* A later bounded read retries unavailable saved state. */ }
    finally { reading = false }
  }
  continuationBootstrap = setInterval(() => { void register() }, 30000)
  continuationBootstrap.unref?.()
  void register()
}

// Home and Trees observe the same retained catalogue result. Subscription does
// not read or retry; the coordinator remains the only owner of those actions.
export function subscribeAutonomousContinuationStatus(listener) {
  if (typeof window === 'undefined' || typeof window.mcAgent?.continuations !== 'function'
    || currentDataSource() !== 'local') return () => {}
  return recoveryCoordinator().subscribe(result => {
    if (Object.hasOwn(result, 'continuationStatus')) listener(result.continuationStatus)
  })
}
const RUN_TREE_RUNTIME_STORES = new Map()
const RUN_STARTING_NODE_IDS = new Set()
const RUN_STARTING_TREE_STORES = new Map()
const RUN_NATIVE_WORK_CONTROLLERS = new Map()
const RUN_NATIVE_WORK_CLOSE_LISTENERS = new Set()
const TREE_RUNTIME_NOT_SAVED_TEXT = 'The latest session changes could not be saved. Keep this app window open to retain its conversation and session controls.'

/* A provider handoff belongs to the app, even when its initiating page closes.
   A reopened page shares its exact store until the outcome lands, so a late
   refusal updates the visible node rather than an abandoned store snapshot. */
function retainStartingTreeStore(store) {
  const computerId = store.snapshot().computerId
  const pending = RUN_STARTING_TREE_STORES.get(computerId) || { store, count: 0 }
  pending.count += 1
  RUN_STARTING_TREE_STORES.set(computerId, pending)
  return () => {
    pending.count -= 1
    if (pending.count === 0 && RUN_STARTING_TREE_STORES.get(computerId) === pending) RUN_STARTING_TREE_STORES.delete(computerId)
  }
}

/* A save refusal cannot undo a session the host already opened. Keep only those
   observed runtime facts beside the guarded store; edits still use its original
   freshness check. Every tree reader (including chat, Stop and completion) sees
   the same session. Retain this model across route changes, not across app
   restarts, and never promise that reloading can recover an unsaved binding. */
function createTreeRuntimeView(store, ownedSessions, cleanups = RUN_SESSION_CLEANUPS) {
  const computerId = store.snapshot().computerId
  const observations = new Map()
  const removedObservations = new Set()
  const listeners = new Set()
  const getNode = id => {
    const node = store.getNode(id)
    return node && observations.has(id) ? Object.freeze({ ...node, ...observations.get(id) }) : node
  }
  const snapshot = () => {
    const saved = store.snapshot()
    if (!observations.size) return saved
    const cleanupPending = [...observations].some(([nodeId, observed]) => cleanups.get(observed.sessionId) === nodeId)
    return Object.freeze({ ...saved, nodes: Object.freeze(saved.nodes.map(node => getNode(node.id))),
      persistenceFailed: true, persistenceProblem: [saved.persistenceProblem, cleanupPending
        ? 'The incomplete start still needs cleanup, but its tree changes could not be saved. Keep this app window open to retain Stop.'
        : TREE_RUNTIME_NOT_SAVED_TEXT].filter(Boolean).join(' ') })
  }
  let view
  const publish = () => { const current = snapshot(); for (const listener of listeners) listener(current) }
  function forgetObservation(nodeId) {
    observations.delete(nodeId)
    removedObservations.delete(nodeId)
    if (!observations.size && RUN_TREE_RUNTIME_STORES.get(computerId) === view) RUN_TREE_RUNTIME_STORES.delete(computerId)
  }
  store.subscribe(() => {
    // A different, ordinary edit can also save runtime facts already present
    // in memory after a quota failure. Clear only observations proven saved.
    if (!store.snapshot().persistenceFailed) {
      for (const [nodeId, observed] of observations) {
        const node = store.getNode(nodeId)
        if ((node && Object.entries(observed).every(([key, value]) => node[key] === value))
            || (!node && removedObservations.has(nodeId))) forgetObservation(nodeId)
      }
    }
    publish()
  })
  function retain(node) {
    observations.set(node.id, Object.freeze({ sessionId: node.sessionId, status: node.status,
      statusNote: node.statusNote, reply: node.reply,
      ...(Object.hasOwn(node, 'lastTurnId') ? { lastTurnId: node.lastTurnId } : {}) }))
    RUN_TREE_RUNTIME_STORES.set(computerId, view)
    publish()
  }
  const saved = outcome => outcome?.ok === true && outcome.snapshot?.persistenceFailed !== true
  function observedResult(outcome, nodeId) {
    return Object.freeze({ ...outcome, node: getNode(nodeId), snapshot: snapshot(), runtimeUpdated: true })
  }
  function saveObservation(nodeId) {
    const observed = observations.get(nodeId)
    let outcome
    // Retry only through the original store. A newer saved forest still refuses
    // every one of these writes; a recovered quota may save the retained facts.
    if (store.getNode(nodeId)?.sessionId !== observed.sessionId) {
      outcome = store.attachSession(nodeId, observed.sessionId)
      if (!saved(outcome)) return observedResult(outcome, nodeId)
    }
    if (store.getNode(nodeId)?.reply !== observed.reply) {
      outcome = store.setNodeReply(nodeId, observed.reply)
      if (!saved(outcome)) return observedResult(outcome, nodeId)
    }
    outcome = store.setNodeStatus(nodeId, observed.status, { note: observed.statusNote, turnId: observed.lastTurnId })
    if (!saved(outcome)) return observedResult(outcome, nodeId)
    forgetObservation(nodeId)
    publish()
    return observedResult(outcome, nodeId)
  }
  // Cleanup evidence is also a real runtime binding, but never adds a session
  // to the send/receive ownership map. Preserve its Stop target after a refused
  // save without turning a failed start into a running conversation.
  const hasRuntimeBinding = (sessionId, nodeId) => ownedSessions.get(sessionId) === nodeId || cleanups.get(sessionId) === nodeId
  const observedSession = node => node?.sessionId && (observations.has(node.id) || hasRuntimeBinding(node.sessionId, node.id))
  view = Object.freeze({
    ...store, getNode, snapshot,
    listNodes: treeId => Object.freeze(store.listNodes(treeId).map(node => getNode(node.id))),
    childrenOf: nodeId => Object.freeze(store.childrenOf(nodeId).map(node => getNode(node.id))),
    rootOf: treeId => { const node = store.rootOf(treeId); return node ? getNode(node.id) : null },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    removeNode(nodeId) {
      const before = getNode(nodeId)
      if (before && (cleanups.get(before.sessionId) === nodeId
          || (observations.has(nodeId) && nodeIsBusy(before, ownedSessions)))) {
        return Object.freeze({ ok: false, problems: Object.freeze([NODE_REMOVE_REFUSALS.running]), snapshot: snapshot() })
      }
      const stored = store.getNode(nodeId)
      if (before && observations.has(nodeId) && !['starting', 'running'].includes(before.status)
          && stored?.sessionId === before.sessionId && ['starting', 'running'].includes(stored.status)) {
        // Completion can arrive while the backing record is unreadable. The
        // visible runtime then knows it ended, while the guarded store still
        // says running. Save that observed completion through the same
        // freshness gate before asking the store to remove its idle record.
        const synchronized = saveObservation(nodeId)
        if (!saved(synchronized)) return Object.freeze({ ok: false,
          problems: Object.freeze(synchronized.problems?.length ? [...synchronized.problems]
            : [synchronized.snapshot?.persistenceProblem || TREE_RUNTIME_NOT_SAVED_TEXT]),
          snapshot: snapshot() })
      }
      const outcome = store.removeNode(nodeId)
      if (outcome?.ok === true && observations.has(nodeId) && before
          && (!ownedSessions.has(before.sessionId) || !['starting', 'running'].includes(before.status))) {
        // Absence alone is not a removal receipt. Only this guarded local
        // removal may retire a terminal/closed run, once the deletion is saved.
        removedObservations.add(nodeId)
        if (saved(outcome)) forgetObservation(nodeId)
        publish()
      }
      return outcome
    },
    attachSession(nodeId, sessionId) {
      const before = getNode(nodeId)
      const outcome = store.attachSession(nodeId, sessionId)
      if (saved(outcome) && before?.sessionId !== sessionId && observations.has(nodeId)
          && hasRuntimeBinding(sessionId, nodeId)) {
        // A proven replacement session must not be hidden by the old run's
        // retained binding after saving has recovered.
        forgetObservation(nodeId)
        publish()
      }
      if (before && !saved(outcome) && store.snapshot().persistenceFailed
          && hasRuntimeBinding(sessionId, nodeId)) {
        retain({ ...before, sessionId, status: before.status === 'draft' ? 'starting' : before.status,
          ...(before.sessionId !== sessionId ? { lastTurnId: null } : {}) })
        return observedResult(outcome, nodeId)
      }
      return outcome
    },
    setNodeStatus(nodeId, status, { note = '', turnId } = {}) {
      const before = getNode(nodeId)
      const cleanNote = typeof note === 'string' ? note.trim() : null
      const validTurn = turnId === undefined || turnId === null || (typeof turnId === 'string'
        && turnId.length > 0 && turnId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(turnId))
      const valid = observedSession(before) && NODE_STATUSES.includes(status) && status !== 'draft'
        && cleanNote !== null && cleanNote.length <= FLEET_TREE_LIMITS.maxNoteChars && validTurn
      const identity = turnId === undefined ? {} : { lastTurnId: turnId }
      if (observations.has(nodeId) && valid) {
        retain({ ...before, status, statusNote: cleanNote, ...identity })
        return saveObservation(nodeId)
      }
      const outcome = store.setNodeStatus(nodeId, status, { note, turnId })
      if (valid && !saved(outcome) && store.snapshot().persistenceFailed) {
        retain({ ...before, status, statusNote: cleanNote, ...identity })
        return observedResult(outcome, nodeId)
      }
      return outcome
    },
    setNodeReply(nodeId, reply) {
      const before = getNode(nodeId)
      if (observations.has(nodeId)) {
        retain({ ...before, reply: typeof reply === 'string' ? reply.slice(0, FLEET_TREE_LIMITS.maxReplyChars) : '' })
        return saveObservation(nodeId)
      }
      const outcome = store.setNodeReply(nodeId, reply)
      if (observedSession(before) && !saved(outcome) && store.snapshot().persistenceFailed) {
        retain({ ...before, reply: typeof reply === 'string' ? reply.slice(0, FLEET_TREE_LIMITS.maxReplyChars) : '' })
        return observedResult(outcome, nodeId)
      }
      return outcome
    },
  })
  return view
}

/* Kept across view navigation, never restored from disk or used for sends. */
const RUN_SESSION_CLEANUP_OBLIGATIONS = new Map()
const RUN_SESSION_CLEANUPS = new class extends Map {
  set(sessionId, nodeId) {
    RUN_SESSION_CLEANUP_OBLIGATIONS.set(sessionId, Object.freeze({ nodeId }))
    return super.set(sessionId, nodeId)
  }
  delete(sessionId) {
    RUN_SESSION_CLEANUP_OBLIGATIONS.delete(sessionId)
    return super.delete(sessionId)
  }
}()
// A successful close may precede an archive/save refusal. Keep its receipt for
// an unchanged record's retry; UNKNOWN_SESSION is never substituted for one.
const RUN_NODE_REMOVAL_CLOSE_RECEIPTS = new Map()

export function nodeCleanupPending(node, cleanups = RUN_SESSION_CLEANUPS) {
  return Boolean(node?.sessionId && cleanups.get(node.sessionId) === node.id)
}

export function retainTreeSessionCleanup(store, nodeId, sessionId, {
  cleanups = RUN_SESSION_CLEANUPS, ownedSessions = RUN_SESSION_NODES, note = '', expectedNodeCreatedAt, expectedNodeSessionId, detached = false,
} = {}) {
  if (cleanups.has(sessionId) && cleanups.get(sessionId) !== nodeId) return false
  const runtimeOwner = ownedSessions.get(sessionId)
  if (runtimeOwner && runtimeOwner !== nodeId) {
    cleanups.set(sessionId, runtimeOwner)
    return false
  }
  cleanups.set(sessionId, nodeId)
  if (detached) return false
  const current = store?.getNode(nodeId)
  const provenOrigin = expectedNodeCreatedAt !== undefined && expectedNodeSessionId !== undefined
  if (provenOrigin && (!current || current.createdAt !== expectedNodeCreatedAt
    || (current.sessionId !== expectedNodeSessionId && current.sessionId !== sessionId))) return false
  if (!current) return false
  store.attachSession(nodeId, sessionId)
  store.setNodeStatus(nodeId, 'failed', { note })
  return true
}

function startCleanupSentence() {
  return readerRemedy(startRefusalSentence({ ok: false, code: 'AGENT_SESSION_CLEANUP_FAILED' }), { viaRelay: currentDataSource() === 'relay' })
}
/* The profile id handed to a real start, held for exactly the same renderer
   lifetime as the session binding above. A later tree assignment cannot
   rewrite where an already-running session began. */
const sessionProfileIds = new Map()

/* THE COMPOSE PANEL THAT MUST SURVIVE ITS OWN SWITCH.
 *
 * MODULE SCOPE FOR ONE MEASURED REASON. src/write-flags.js announces every
 * change, and src/main.js re-renders the whole route when it hears one -- which
 * is right, because a flag flipped anywhere must reach every surface at once.
 * But the panel's own "Turn on running agents" IS such a change, so pressing it
 * destroyed the view the person was looking at, panel and all. Measured
 * 2026-08-18 on a staged build: the flag was written, the switch worked, and
 * the panel simply vanished -- Start "came back" on a page they were no longer
 * on. That is a restart in everything but name, and the owner asked for no
 * restart.
 *
 * So the press records WHICH slot was being composed, the rebuilt view reads it
 * once, and the panel reopens where it was. It holds a slot-press detail and
 * nothing else, it is cleared the moment it is used, and nothing writes it
 * except that one press -- a stale entry could otherwise open a panel over a
 * node on a later visit that nobody asked for. */
let composeToRestore = null

/* THE ROLE LIBRARY RIDES THAT SAME REMOUNT.
 *
 * Same teardown, different casualty: wording a person had typed into a role's
 * rule fields but not yet saved was rebuilt away with the view. Measured on
 * the packaged build 2026-08-20 (order-variation drive): the typed marker
 * survived opening and cancelling the start panel, and was destroyed the
 * moment "Turn on running agents" was pressed -- and the drawer's own live
 * toggle reaches the identical remount without the panel being involved at
 * all. Captured when a flags event announces the teardown (the announcement
 * is synchronous; the re-render is a microtask behind it), re-applied to
 * every Role library build until the person touches the restored library --
 * see mountOrgLibrary for why read-once was wrong here. It may outlive a
 * remount legitimately: a flip to the example board builds no library, and
 * the snapshot waits for the flip back instead of the wording dying with the
 * first flip.
 *
 * THIS LINE HAS ALREADY BEEN LOST ONCE. ed7a10a committed the USES of this
 * variable without the declaration, and the fleet board died at load with
 * "roleLibraryToRestore is not defined" -- zero nodes, no way to start an
 * agent; the coordinator restored it at 0bf3281. It is declared beside
 * composeToRestore because the two survive the same teardown, and a lane
 * staging one of them must take this line with them. */
let roleLibraryToRestore = null

/* WHERE A COMPUTER'S RECORD CAME FROM, in words rather than in the word the
   program uses. `computer.note` is `sourceKind`, which the fleet schema pins to
   exactly two values, so this is a lookup and not a guess -- and an unexpected
   third value falls through to a sentence that claims nothing. */
const RECORD_SOURCE = Object.freeze({
  declared: () => drivenComputerCopy(
    'Written down in this computer’s declared organisation.',
    'Written down in the declared organisation of the computer you are driving.',
  ),
  observed: () => drivenComputerCopy(
    'Seen running on this computer.',
    'Seen running on the computer you are driving.',
  ),
})

/* Optional receipt timing remains optional all the way to the chat. Keeping
   the validation beside the exported adapter prevents live, merged and restored
   action rows from acquiring different timing rules. */
function actionTimingFields(row) {
  const timing = {}
  if (row && Object.hasOwn(row, 'startedAt') && Number.isFinite(row.startedAt)) timing.startedAt = row.startedAt
  if (row && Object.hasOwn(row, 'endedAt') && Number.isFinite(row.endedAt)) timing.endedAt = row.endedAt
  if (row && Object.hasOwn(row, 'durationMs') && Number.isFinite(row.durationMs) && row.durationMs >= 0) timing.durationMs = row.durationMs
  return timing
}

export function actionChatRow(row) {
  const words = actionRowWords(row)
  return {
    id: `action:${row.id}`,
    kind: row.kind,
    tool: words.tool,
    detail: words.detail,
    state: words.state,
    stateKey: row.state,
    body: [row.detail, row.output].filter(Boolean).join('\n\n'),
    ...(row.kind === 'thinking' ? { truncated: row.truncated === true } : {}),
    at: row.at,
    ...actionTimingFields(row),
  }
}

// Diff history is separate from speech and action history. Retained patches
// are bounded to 1 MB per node and validated again when a chat restores them.
// They are not included in the prompt used to resume an agent.
const CHAT_DIFF_HISTORY_KEY_BASE = 'mc.fleet.chat-diffs.v1'
const chatDiffHistoryKey = computerId => `${CHAT_DIFF_HISTORY_KEY_BASE}:${computerId}`

function storedChatDiffEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.who !== 'diff') return null
  try {
    const stored = { who: 'diff', source: entry.source }
    if (Object.hasOwn(entry, 'id')) stored.id = entry.id
    if (Object.hasOwn(entry, 'at')) stored.at = entry.at
    stored.files = Array.isArray(entry.files)
      ? entry.files.slice(0, 100).map(file => (
        file && typeof file === 'object' && !Array.isArray(file)
          ? Object.fromEntries(Object.entries(file))
          : file
      ))
      : entry.files
    if (Object.hasOwn(entry, 'activeIndex')) stored.activeIndex = entry.activeIndex
    if (Array.isArray(entry.patches)) stored.patches = boundedChangePatches(entry.patches, stored.files || [])
    if (entry.limited === true || entry.files?.length > 100) stored.limited = true
    return stored
  } catch {
    return null
  }
}

function boundedStoredChatDiffEntries(entries) {
  const valid = entries.map(storedChatDiffEntry).filter(Boolean)
  const admitted = valid.slice(-60)
  if (valid.length > admitted.length && admitted[0]) admitted[0].limited = true
  let remaining = 1048576
  for (const entry of [...admitted].reverse()) {
    if (!Array.isArray(entry.patches)) continue
    entry.patches = entry.patches.filter(patch => {
      if (patch.diff.length > remaining) { entry.limited = true; return false }
      remaining -= patch.diff.length
      return true
    })
  }
  return admitted
}

function createChatDiffHistoryStore({ computerId, storage }) {
  const key = chatDiffHistoryKey(computerId)
  const readNodes = () => {
    const raw = storage.read(key)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1
        || !raw.nodes || typeof raw.nodes !== 'object' || Array.isArray(raw.nodes)) return Object.create(null)
    const nodes = Object.create(null)
    for (const [nodeId, entries] of Object.entries(raw.nodes)) {
      if (!Array.isArray(entries)) continue
      const admitted = boundedStoredChatDiffEntries(entries)
      if (admitted.length > 0) nodes[nodeId] = admitted
    }
    return nodes
  }
  return Object.freeze({
    get(nodeId) {
      if (typeof nodeId !== 'string' || !nodeId) return []
      return readNodes()[nodeId] || []
    },
    save(nodeId, entries) {
      if (typeof nodeId !== 'string' || !nodeId || !Array.isArray(entries)) return false
      const nodes = readNodes()
      const admitted = boundedStoredChatDiffEntries(entries)
      if (admitted.length > 0) nodes[nodeId] = admitted
      else delete nodes[nodeId]
      return storage.write(key, { v: 1, nodes }) === true
    },
    remove(nodeId) {
      if (typeof nodeId !== 'string' || !nodeId) return false
      const nodes = readNodes()
      delete nodes[nodeId]
      return storage.write(key, { v: 1, nodes }) === true
    },
  })
}

/* A SAVE MUST NOT LEAVE THE PERSON STARING AT AN EMPTY BRANCH.
 *
 * reprojectFromOrg carries the drill-in root across a save, because losing it
 * would make a correct save feel like a page reset. But a Reports-to move can
 * empty the very branch that is focused: move every child of the focused
 * controller onto another tree and restoring that root redraws ONE childless
 * circle while the rest of the forest stays hidden. Measured as owner bug
 * UI-1: after moving four children out of the focused tree the canvas showed
 * only that controller, with 22 nodes saved, and Every tree looked broken
 * because the root it cleared was put back by the next reprojection.
 *
 * Emptied is not the same as small. A person who drills into a leaf on purpose
 * must stay there, so this asks for a CHANGE -- the root had children and now
 * has none -- rather than for a child count. A root that has gone from the
 * record entirely is also not restored, which is what the old `nodes.has`
 * check covered and is kept here.
 */
export function drillRootAfterReprojection(rootId, before = [], after = []) {
  if (!rootId) return null
  if (!after.some(agent => agent?.id === rootId)) return null
  const children = agents => agents.filter(agent => agent?.parentId === rootId).length
  if (children(before) > 0 && children(after) === 0) return null
  return rootId
}

/**
 * THE ONE NAME A CIRCLE ANSWERS TO, on the canvas and in the messenger.
 *
 * THE DEFECT THIS EXISTS FOR (T138, measured 2026-09-16 03:47Z-05:05Z): four
 * circles started through `agent.spawn` were all registered as "Manager" and
 * sixteen as "Worker", so `agent_comms.local_roster` listed identical rows and
 * `agent_comms.send_local` answered TREE_RECIPIENT_AMBIGUOUS for the name and
 * TREE_RECIPIENT_UNKNOWN for the tree nodeId. No manager could address its own
 * workers and the Controller could not address its managers.
 *
 * THE CAUSE WAS A SECOND, WEAKER COPY OF THE NAMING RULE HERE. This function
 * used to answer `node.nameBase` -- the role's label WITHOUT the ordinal --
 * whenever the store had one, which is whenever the role library had resolved
 * by the time the circle was added. That short-circuit ran BEFORE
 * nodeDisplayName() and so discarded both halves of the rule the rest of the
 * product agrees on: the per-tree ordinal ("Manager 2") and the cross-tree id
 * suffix ("Manager (5ef0084f)"). It arrived with the native-desktop-tree
 * adapter beside the `node.name` branch below, which is the branch that
 * adapter actually needs -- desktopTreeComputer() puts a composed `name` on
 * every row it projects.
 *
 * So the rule lives in src/fleet-trees.js and NOTHING gets to paraphrase it.
 * nodeDisplayName() already treats `nameBase` as the base it composes from, so
 * no information is lost by asking it instead of answering ahead of it.
 *
 * Exported because the name a circle is REGISTERED under (nodeTreeIdentity ->
 * registerNode) is the name the messenger can address, so this is behaviour a
 * suite has to be able to call with values rather than read.
 *
 * @param node      a saved circle, or a row from the read-only desktop-tree view
 * @param peers     every circle on the surface the name will be shown on --
 *                  the whole snapshot, not one tree, or two trees' first
 *                  circles both read "Manager" again
 * @param roleLabel the role library's word for a role id
 */
export function circleName(node, peers = [], roleLabel = role => String(role || '')) {
  if (typeof node?.name === 'string' && node.name.trim()) return node.name.trim()
  return nodeDisplayName(node, Array.isArray(peers) ? peers : [], { roleLabel })
}

/**
 * WHICH CIRCLES NOW ANSWER TO A DIFFERENT NAME THAN THEY DID LAST TIME.
 *
 * WHY THIS HAS TO BE ASKED AT ALL. Half of the naming rule is stored and half
 * is not. A circle's nameBase and its per-tree ordinal are records in the store,
 * and the store reports when it changes them. The cross-tree half is computed:
 * nodeDisplayName() qualifies a label with the circle's own id only while
 * another circle ON THE SAME SURFACE computes the same label. So drawing a
 * SECOND tree renames the FIRST tree's top circle from "Controller" to
 * "Controller (00000002)" with nothing stored changing at all -- measured on a
 * real store, 2026-09-16 -- and a circle already registered in the message
 * directory under the old name keeps it while every circle briefed afterwards
 * is told the new one. The two never meet, and the message is refused.
 *
 * The composed names this returns are the only record that moves when a
 * computed name moves, so they are what the next comparison is made against.
 *
 * @param previous Map of circle id to the name it last answered to
 * @param nodes    every circle on the surface, the same pool the name is composed over
 * @param nameOf   how to name one circle
 * @returns { names, moved } -- the new record, and the ids whose name changed
 */
/**
 * EVERYTHING A COMPOSED NAME IS MADE OF, AND NOTHING ELSE.
 *
 * WHY THIS IS NOT PREMATURE. The rename watch runs on every accepted change to
 * the store, and composing one circle's name is itself a scan of the pool --
 * nodeDisplayName() has to look at every peer to know whether the label
 * collides -- so naming the whole pool is quadratic. Measured on this store:
 *
 *      50 circles ->  2.5 ms per accepted change
 *     200 circles ->  2.3 ms
 *     800 circles -> 14.7 ms
 *
 * and FLEET_TREE_LIMITS.maxNodes is 4096. A status change, a reply landing, a
 * run-clock tick -- none of which can rename anything -- would each have paid
 * that. So the scan is asked for only when its INPUTS have moved. A circle's
 * composed name is a function of exactly these fields; a status, a message, a
 * session id or a timestamp cannot change it, and if this list ever falls
 * behind the naming rule the symptom is a missed re-registration, so it is kept
 * next to the rule and exercised by the same suite.
 */
export function namingSignature(nodes) {
  const parts = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node.id !== 'string') continue
    parts.push(`${node.id}\0${node.treeId}\0${node.role}\0${node.nameBase ?? ''}\0${node.nameOrdinal ?? ''}`)
  }
  return parts.join('\x01')
}

export function renamedCircles(previous, nodes, nameOf) {
  const names = new Map()
  const moved = []
  const before = previous instanceof Map ? previous : new Map()
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node.id !== 'string') continue
    const name = nameOf(node)
    names.set(node.id, name)
    /* A circle this comparison has never seen is not a rename. Its name is
       recorded now and judged the next time round; treating a first sighting as
       a change would re-register every circle on the computer at every add. */
    if (before.has(node.id) && before.get(node.id) !== name) moved.push(node.id)
  }
  return { names, moved }
}

export function computersView({ initialComputer = null, navigate, chatNodeId = null, chatDraft = null, chatWorkspace = false }) {
  const chatOnly = chatWorkspace || Boolean(chatNodeId)
  // Compact chats and the Chat tab share one compare window for this view.
  const compareFiles = createCompareFilesDoor()
  const openChatDiff = createChatDiffOpenHandler(compareFiles)
  const confirmedFileChanges = createConfirmedFileChangeBuffer()
  /* WHERE THIS VIEW'S DATA COMES FROM: 'local' | 'relay' | 'mock', written by
     bootFromSource() and by the DATA_SOURCE_EVENT handler, and null only for
     the moment before the first resolution answers. Null is "not yet known" —
     never defaulted to a source (see currentDataSource's note) — and nothing
     mounts until it resolves, so every render-time read below sees a verdict.
     mockSource() is the one question the surfaces ask: mock never writes,
     mock never reads a real store, and mock is the only badged source. */
  let source = null
  const mockSource = () => source === 'mock'
  let liveComputers = []
  /* THE COMPUTERS ON THIS PERSON'S ACCOUNT — a DIFFERENT AXIS from
     `liveComputers` above, and the two must never be read for each other.
     `liveComputers` are entries in the fleet record of the ONE machine this
     page is reading; switching between them re-mounts a graph and reaches
     nothing new. These are whole machines, each behind its own tunnel, and
     pressing one changes where every reading on every screen comes from.
     Empty on the desktop and on the example, which is why both keep the bar
     they have always had. Read on mount and when the host says the world
     changed; nothing polls. */
  let machineChoices = []
  /* One press at a time. Changing computer closes a tunnel and opens another,
     and two of those racing would leave the page reading one machine while the
     bar claims the other. */
  let machineSwitchBusy = machineTabSwitchState(window).busy
  /* Always null until a mount picks one from liveComputers — there is no
     synchronous fleet to reach for any more; even the example fleet arrives
     through the same mountProjection path. */
  let computer = null
  let graph = null
  let canvas = null
  /* The cloud box's controller outlives its DOM node unless it is told
     otherwise: its bridge calls are in flight while a person clicks the next
     node in the tree, and a publish into a detached box is a listener leak per
     click. clearBoard() below destroys it with the rest of the rail. */
  let boardCloudBox = null
  /* THE GOAL BOX'S EAR ON THE GLOBAL STATUS BUS. goalControlsBox subscribes
     through registerNodeStatusListener, and notifyNodeStatusListeners() is
     GLOBAL -- it calls every listener of every node. Each box used to hand its
     own unsubscribe to `unsubs`, which is flushed only at view destroy, so
     every rail render left another box subscribed: a person clicking around
     their tree accumulated one live goal box per click, and every one of them
     asked the host for its own node's goal on every tick. Held here instead,
     so the NEXT box releases the previous one and `unsubs` carries this single
     release rather than one entry per render.
     Deliberately NOT released by clearBoard(). clearBoard() also runs on its
     own 200 ms after the rail returns to the overview (railDisposeTimer),
     while the board's DOM stays exactly where it was, and three routes re-show
     that same board without rebuilding it -- showStats()'s chat branch,
     focusDetailsControl() and openLoopFor(), which end in
     `else activateRail(controlsPage)`. Releasing there would hand the person
     back a Goal box that no longer refreshes and a "Clear goal" button that is
     still enabled and does nothing. */
  let boardGoalUnsub = null
  let boardGoalReleaseHeld = false
  function disposeBoardGoalBox() {
    boardGoalUnsub?.()
    boardGoalUnsub = null
  }
  let railDisposeTimer = 0
  /* THE ENGINE ROWS THE COMPOSE PANEL WILL SHOW. Starts as the module's own
     pessimistic default -- the three Codex tiers -- and is replaced once the
     shell answers. A press that lands before the answer therefore shows what
     every build could always start, never a row that promises more than this
     payload carries. */
  let startableTierChoices = TIER_CHOICES
  /* THE IDS BEHIND THOSE ROWS, kept because two surfaces need two different
     things out of one answer: the start menu needs the labelled rows, and the
     node panel's Engine row needs to name the PROVIDERS this copy can start.
     Deriving the second from the first is not possible -- tierChoicesFor()
     returns every tier, marking the ones that cannot start -- so the answer is
     held in the shape the shell gave it. */
  let startableTierIdList = TREE_DEFAULT_STARTABLE_TIERS
  /* WHETHER THAT LIST IS SOMETHING THE SHELL SAID, OR ONLY THE FALLBACK.
     The two are the same VALUE and they are not the same FACT: one means this
     payload carries four launchers, the other means nobody has answered. Only
     the first may print "cannot start from a tree yet" on a row. False until a
     probe has actually run out of attempts, so the ordinary pre-answer moment
     -- and every mock-sourced screen, which asks nothing -- reads exactly as it
     did before. See askStartableTiers(). */
  let tierAnswerMissing = false
  /* AND A THIRD STATE THE PAIR ABOVE CANNOT EXPRESS: has the shell spoken AT
     ALL yet? `tierAnswerMissing` is false both when the shell answered and
     before anything was asked, which is exactly right for the sentence it
     chooses -- but it is wrong for anything that REMOVES a row. Gating the
     model menu's continuation rows on the pre-answer value silently took
     "Continue on Opus · Claude" off the menu, because the pre-answer value is
     TREE_DEFAULT_STARTABLE_TIERS: the four Codex tiers. Measured as a real
     regression by tools/test/t158-cross-provider-model-switch.test.mjs while
     owner request R1238 was being built. So a subtractive reader asks THIS
     flag, which is true only where a reply was actually parsed. */
  let startableTierAnswered = false
  /* AND WHICH PROVIDERS THIS COMPUTER IS PROVABLY NOT SIGNED IN TO -- the second
     half of "can this row start", and the half startableTiers() structurally
     cannot see. Declared HERE, beside the other two, rather than beside the
     function that fills it: both writers of startableTierChoices are above it in
     this file, and a `let` sitting between them and their use is a temporal dead
     zone waiting for the next person who moves a call. See readProviderSignIn().
     Empty means nothing was learned, which draws exactly today's rows. */
  let signedOutProviders = []
  /* AND WHICH PROVIDERS THIS COMPUTER HAS NO PROGRAM FOR AT ALL. Kept apart
     from the list above because a machine with no Codex reports BOTH, and only
     the first of the two is worth acting on: `codex login` is a subcommand of
     the program that is missing. Same empty-means-nothing-learned rule. */
  let noProgramProviders = []
  let providerPresence = null
  /* ASK THE SHELL WHICH TIERS THIS COPY CAN REALLY START.
   *
   * THE DEFECT THIS CLOSES. This renderer used to decide startability from a
   * frozen list of provider names, so the menu said "cannot start from a tree
   * yet" on a build that could, and would have gone on saying it after the
   * engine shipped. The shell has always had the real answer:
   * mc-agent:startable-tiers runs the SAME resolveStartTier() the press runs, so
   * the menu and the button cannot disagree by construction.
   *
   * EVERY FAILURE PATH IS THE SAME PATH, and it is the pessimistic one. No
   * bridge (a plain browser during `npm run dev`), a rejected invoke, a reply
   * that is not the shape promised, or an answer that arrives after this view is
   * gone -- all leave the Codex-only default exactly as it is today. The one
   * thing this must never do is guess upward: a row that says "startable" over a
   * press that refuses is the half-start that is worse than an honest refusal.
   * startableTierAnswer() in src/fleet-tree-copy.js owns that judgement, including
   * the one case worth spelling out -- an EMPTY list is an answer and is
   * honoured, while a malformed one is not.
   *
   * It is fetched once per view rather than per node click: the payload cannot
   * change while the window is open, and a probe per click would be a request
   * per press for an answer that cannot have moved. */
  function startableTiersNow() {
    return readStartableTiers()
  }
  let destroyed = false
  let fetchVersion = 0
  let projectionReady = Promise.resolve()
  let resolveProjectionReady = null
  const unsubs = []
  /* CAPTURE BEFORE THE TEARDOWN, REGISTERED BEFORE ANYTHING THAT REBUILDS.
     A flags event is dispatched synchronously and src/main.js queues the
     route re-render a microtask behind it, so a listener here reads the Role
     library's open items and typed wording while they are still on the page.
     Registered FIRST in this view on purpose. DATA_SOURCE_EVENT is the other
     announcement that ends in this library being rebuilt (the example toggle
     remounts the whole page); this view's own remount on that event is a
     microtask behind the announcement too, so the capture still reads the
     library while it stands. */
  const captureRoleLibrary = () => {
    if (destroyed) return
    const snapshot = snapshotRoleLibrary(statsPage?.querySelector?.('.board-roles-box'))
    if (snapshot) roleLibraryToRestore = snapshot
  }
  window.addEventListener(WRITE_FLAGS_EVENT, captureRoleLibrary)
  window.addEventListener(DATA_SOURCE_EVENT, captureRoleLibrary)
  unsubs.push(() => {
    window.removeEventListener(WRITE_FLAGS_EVENT, captureRoleLibrary)
    window.removeEventListener(DATA_SOURCE_EVENT, captureRoleLibrary)
  })
  /* The runs half of the chatbox. Read once per view from the same spawn
     record the home screen reads, never per node click, and left as an empty
     list when this copy has no computer to ask — readLocalSessions() already
     distinguishes "no runs" from "could not read" from "nobody to ask", so
     this view does not get to invent a fourth answer. */
  let railRuns = []
  /* Whether a run record can be READ AT ALL, kept separate from whether it
     currently holds anything. `supported: false` means there was nobody to ask
     — a browser with no shell behind it — and that is not the same fact as an
     empty list. src/chatbox-feed.js's availability flags are about the source,
     so the source's existence is what has to be passed to them. */
  let railRunsSupported = false
  /* Research projects, for filing sessions. Read ONCE per mount; the refusal
     is kept so the filing control can render disabled WITH the sentence
     instead of as an empty select pretending no projects exist. */
  let researchService = null
  const researchAssignments = createAssignmentStore({ storage: typeof window === 'undefined' ? null : window.localStorage })
  let railChatUnsub = null
  let refreshRailMoveChoices = null

  const root = el(`
    <div class="computers">
      <!-- THE FIRST ROW OF THE PAGE, WHICH NOW HOLDS TWO THINGS.
           The tab strip is unchanged and keeps the whole left of the row. The
           accounts menu is the right-hand end of it, which is where the owner
           asked for it: "on page 2 right below settings and to the right". The
           quick-settings gear is the last thing in the page chrome directly
           above this row, so this is the one spot that is both immediately
           under settings and clear of the canvas.
           It is a SIBLING of the tab strip rather than a chip inside it: those
           chips each choose which computer the page reads from, and a control
           that does something else entirely must not look like one more of
           them. -->
      <div class="comp-topbar">
        <div class="tabs"></div>
        <div class="comp-accounts"></div>
      </div>
      <!-- WHAT THE LAST PRESS ON THE BAR DID, answered in the section the press
           was made in. The account page learned this the hard way: its choose
           refusals used to be written into a block a whole section higher, so
           the answer to a press could be off the screen. A press that cannot
           reach a computer says so here, an inch under the chip. -->
      <div class="machine-note" role="status" hidden></div>
      <div class="comp-body">
        <!-- ONE REAL BAR PER PANE (owner, iteration 6: "it should be one nice
             bar per split and it should have a scroll function. you have to
             place it nicely though"). The title, the tree switcher and the
             tool buttons used to be absolutely positioned siblings sharing one
             band over the canvas, and the strip legally painted across the
             title the moment enough trees existed. The bar is normal flow with
             three FIXED slots — name, trees, tools — so construction order
             stops deciding the visual order, and the trees slot alone scrolls
             sideways (hidden scrollbar, edge fades). -->
        <div class="graph-wrap glass">
          <!-- THE BAR, REBUILT (owner, 2026-08-18: "this bar is still super ugly
               ... start over on just this top bar"). Same three slots, because
               that part was never the complaint; what it lacked was RANK and
               GROUPING, and what it carried was a paragraph.

               RANK. Everything in it was one weight at one size, so the name of
               the computer competed with a zoom percentage. The name is now the
               only thing in the bar with title weight, in its own lead slot, and
               every control is one shared 28px chip.

               GROUPING. Three jobs, in the order they get used, separated by
               hairlines (drawn by the slots themselves, so no divider elements
               exist to fall out of place): WHAT you are looking at, HOW you are
               looking at it (zoom), and WHAT YOU CAN DO with it (edit, and the
               one control that leaves the page).

               AND THE PARAGRAPH IS GONE. "No research projects exist yet. Create
               one on the research page first." was mounted into the tool strip,
               so a sentence about a different page sat in the row of buttons for
               this one. Filing a scope under a project is a fleet-wide setting,
               so it is now a named section of the fleet rail beside Session
               profiles and Roles -- see mountResearchScopeControl. -->
          <div class="graph-bar">
            <div class="graph-bar-lead">
              <div class="graph-title"></div>
            </div>
            <div class="graph-tools">
              <!-- src/tree-graph.js inserts the zoom cluster as this slot's FIRST
                   child, which is why the buttons below live in their own group:
                   without it the zoom controls and the actions were one
                   undifferentiated run of chips. -->
              <button class="graph-open-btn" type="button" hidden>Fleet overview</button>
              <div class="graph-tool-set">
                <button class="graph-reset-btn" type="button" hidden>Reset positions</button>
                <button class="graph-edit-btn" type="button" title="Edit the role hierarchy">Edit</button>
                <button class="graph-roles-btn" type="button" data-open-role-workspace title="Edit role directions and functions" hidden disabled>Roles</button>
              </div>
              <!-- The Split button (owner defect 5's second, view-only pane) stood
                   here until 2026-08-16. Owner: "lets throw it away for now" -- his
                   read was that a page ends up with two views nobody keeps
                   straight. So the button, its pane and its saved preference are
                   gone; the page is single-pane, which is also the shape every
                   harness measured it in. The bar around it is the packaging
                   lane's, which is why this resolution keeps their structure and
                   his removal at once. -->
            </div>
            <div class="graph-edit-note">drag onto a parent or into empty space</div>
          </div>
          <div class="graph-canvas-slot">
            <div class="graph-crumb"></div>
            <!-- WHAT THE LAST ACTION ON THIS CANVAS DID, and there are two of them
                 now: a drag onto a new manager, and a start from an empty node.
                 A drag has no other place to report from: the rail is showing
                 whichever node was last clicked, which is not necessarily the one
                 being moved, and the canvas itself can only show the node's
                 position. A start needs this line for a different reason — the
                 panel that reported it closes on success, and the person is then
                 looking at the canvas. A refusal stays until the next attempt; a
                 save clears itself, because a persistent "saved" would be
                 indistinguishable from a stale one. -->
            <div class="org-status" data-state="idle" role="status" hidden></div>
          </div>
        </div>
        <div class="comp-body-resize" role="separator" aria-orientation="vertical" aria-label="Resize the rail" tabindex="0"></div>
        <aside class="rail glass">
          <button type="button" class="tree-rail-close" aria-label="Close side panel">×</button>
          <div class="rail-page stats-page is-active"></div>
          <div class="rail-page ctl-page board-page"></div>
          <!-- THE RIGHT-SIDE PANEL THE OWNER ASKED FOR, and it is a THIRD page
               rather than a takeover of one of the two above. Both of those are
               about something that already exists — the fleet, or one agent —
               and the person reading either of them may press an empty node
               without meaning to lose it. This page holds the compose panel
               while it is open and hands the rail back to whichever page was
               showing when the panel closes. It is empty until a press: nothing
               is built here on load, because nothing here is a thing to read. -->
          <div class="rail-page compose-page"></div>
        </aside>
      </div>
    </div>`)

  const tabsElement = root.querySelector('.tabs')
  if (chatOnly) root.classList.add('home-agent-workspace')
  /* THE PAGE'S HEADING (T1572). Every h1-h4 on Computers sat inside a closed
     dialog or hidden panel, and the page's title is a styled div, so a screen
     reader jumping by heading found nothing on the main workspace. One h1,
     visually hidden like the Ledger's, names the page and the computer on
     screen. Not when this page is a workspace inside Home, which has its own. */
  const pageHeading = chatOnly ? null : el('<h1 class="sr-only" data-computers-heading>Computers</h1>')
  if (pageHeading) root.prepend(pageHeading)
  const machineNoteElement = root.querySelector('.machine-note')

  /* THE ACCOUNTS MENU. Built once per mount and torn down with the page: it
     puts two listeners on the DOCUMENT (a press outside it, and Escape) and a
     menu that outlived its page would hold this whole view alive through those
     closures -- the retained-view shape src/page-frames.js documents at length.
     Its own destroy() is the only thing that removes them. */
  let accountsMenuEl = null
  const accountsSlot = root.querySelector('.comp-accounts')
  if (accountsSlot) {
    const accountsMenu = accountSwitcher()
    accountsMenuEl = accountsMenu
    accountsSlot.appendChild(accountsMenu)
    unsubs.push(() => accountsMenu.__accountSwitcher?.destroy())
  }
  const graphWrap = root.querySelector('.graph-wrap')
  const agentScreenVoice = mountAgentScreenVoiceControls({
    sample: mockSource(), getComputerId: () => computer?.id,
    onMarks: marks => graph?.setContactMarks(marks),
  })
  agentScreenVoice.el.classList.add('is-node-popover')
  agentScreenVoice.el.setAttribute('aria-label', 'Agent voice and screen controls')
  if (!chatOnly) root.append(agentScreenVoice.el)
  let contactOpener = null
  const closeAgentContact = () => {
    agentScreenVoice.el.open = false
    if (contactOpener?.isConnected) contactOpener.focus({ preventScroll: true })
  }
  const outsideAgentContact = event => {
    if (agentScreenVoice.el.open && !agentScreenVoice.el.contains(event.target) && !event.target.closest?.('.node-contact-icon')) agentScreenVoice.el.open = false
  }
  document.addEventListener('pointerdown', outsideAgentContact)
  unsubs.push(() => { document.removeEventListener('pointerdown', outsideAgentContact); agentScreenVoice.destroy() })
  const graphTitle = root.querySelector('.graph-title')
  const crumbElement = root.querySelector('.graph-crumb')
  const railElement = root.querySelector('.rail')
  /* The shared resize handle persists the preferred rail width. CSS supplies
     the default, caps the preference against available space, and owns the
     stacked layout. A saved wide rail must not clip the graph controls when
     the window narrows. */
  const compBodyElement = root.querySelector('.comp-body')
  const railResizeHandle = root.querySelector('.comp-body-resize')
  if (compBodyElement && railResizeHandle) {
    unsubs.push(attachResizeHandle(railResizeHandle, {
      axis: 'x',
      invert: true, // the handle sits LEFT of the rail: dragging left grows it
      min: 320,
      max: 900,
      storageKey: 'mc.comp-body.rail-w',
      /* offsetWidth, NOT getBoundingClientRect().width: the number handed back
         here is the one `apply` below writes as a CSS px length, and those two
         are the same space only in offset/client sizes. A rect is in window
         pixels, which the Text size zoom scales away from CSS pixels -- with
         the rect, grabbing this handle at Large snapped the rail 12% wider
         before the pointer moved at all, and the width that got stored was 12%
         wider again at the next launch. See src/resize-handle.js. */
      getSize: () => railElement.offsetWidth,
      /* CSS owns the stacked breakpoint and the available-width cap. Retain
         the preference even when opening a narrow window, so widening that
         window can restore it without another drag or page reload. */
      apply: (px) => {
        compBodyElement.style.setProperty('--comp-rail-width', `${Math.round(px)}px`)
      },
    }))
  }
  const statsPage = root.querySelector('.stats-page')
  root.querySelector('[data-open-role-workspace]').addEventListener('click', () => {
    const library = statsPage.querySelector('.board-roles-box')
    if (library?.openStudio) {
      activateRail(statsPage)
      const configuration = statsPage.querySelector('[data-fleet-details="configuration"]')
      if (configuration) configuration.open = true
      library.openStudio()
    }
  })
  const controlsPage = root.querySelector('.ctl-page')
  const composePage = root.querySelector('.compose-page')
  const editButton = root.querySelector('.graph-edit-btn')
  let treeEditPicker = null
  unsubs.push(() => treeEditPicker?.close())
  const resetButton = root.querySelector('.graph-reset-btn')
  const openButton = root.querySelector('.graph-open-btn')
  /* Which agent the named button would open. It follows the rail's selection so
     the two controls can never disagree about what "this agent" means, and it
     falls back to the first agent on the computer so the button is useful before
     anything has been clicked. Null means there is nobody to open, and the
     button is then ABSENT rather than disabled — see syncOpenButton. */
  let openTarget = null
  /* THE PHONE CANVAS, AND IT IS NULL ON EVERY DESKTOP.
     mountPhoneCanvas returns null unless the `data-phone-canvas` mode is on, so
     this and the one `?.` call inside activateRail are the whole of this file's
     phone work — and both are unreachable above the mode. It moves the rail and
     the graph's three named tool buttons into a sheet: the elements themselves,
     never a copy, so every number a phone shows is the number this page already
     computed. See src/phone-canvas.js. */
  const phoneCanvas = chatOnly ? null : mountPhoneCanvas({ root, isExample: mockSource })
  /* FAIL CLOSED, the same rule every account-state.js reader states for
     itself: until the async read below resolves at least once, nobody is
     signed in. See resolveLedgerAuth(). */
  let ledgerSignedIn = false
  const exploreDemo = () => {
    setExampleMode(true)
  }
  /* Mobile browsers default to expandable agent rows. The optional graph
     remains available through the saved ledger choice; desktop stays unchanged.
     Both surfaces read the same records and use this view's selection paths. */
  const phoneLedger = chatOnly ? null : mountPhoneLedger({
    root,
    computerFn: graphComputer,
    stateFn: () => source === 'relay' ? root.dataset.nativeTreeState || root.dataset.projectionState || 'loading' : null,
    statusWordFor: agent => (agent?.treeNode
      ? treeNodeStatusWord(agent.treeNode)
      : agent?.state === 'enabled' ? 'running'
        : agent?.state === 'disabled' ? 'disabled'
          : agent?.state === 'finished' || agent?.state === 'failed' ? agent.state
            : 'no signal'),
    onPressAgent: (agent) => {
      if (agent?.treeNode) {
        /* Same rule as the graph's onOpenControls: the selected tree agent is
           the target, and the (desktop-only) open button states why it cannot
           open rather than vanishing. On the phone the button is not drawn at
           all, so this only keeps the two paths one path. */
        setOpenTarget(agent)
        showTreeNodeControls(agent.treeNode)
        return
      }
      setOpenTarget(agent)
      showProjectionControls(agent)
    },
    onPressAdd: openComposeFor,
    extensionPointsFn: () => (treeStore ? treeStore.extensionPoints() : []),
    /* The sheet the ledger raises is the one the phone canvas already built,
       handed over so a row press can name it before it rises. Null on every
       desktop, exactly as the mount above is. */
    sheet: phoneCanvas,
    // Real records require the resolved account; demo access additionally
    // requires an explicit choice and this view's resolved mock source.
    signedInFn: () => ledgerSignedIn,
    sourceFn: () => source,
    exampleChosenFn: exampleWasChosen,
    onExploreDemo: exploreDemo,
  })
  // A saved graph preference changes presentation, not the account entrance.
  const graphSignInDoor = phoneCanvas && !phoneLedger ? buildSignInDoor(document, { onExploreDemo: exploreDemo }) : null
  if (graphSignInDoor) {
    root.classList.add('phone-graph-auth-required')
    root.append(graphSignInDoor)
  }

  /* The explanation shown in the central panel when there is no fleet to draw.
     It occupies the same slot the graph canvas does, so the two can never be on
     screen together. */
  let emptyPanel = null
  const orgStatusElement = root.querySelector('.org-status')
  if (chatOnly) root.insertBefore(orgStatusElement, root.querySelector('.comp-body'))
  let orgStatusTimer = 0
  let treePersistenceProblem = ''
  let orgStatusPrimary = null
  /* THE ONE ANSWER EVERY ORGANISATION CONTROL BRANCHES ON.
     Read once per projection load and held here, so the rail's role menu, the
     role library and the drag can never disagree about which revision they are
     editing or about whether there is a store behind them at all. It starts as
     'absent' because that is what a plain browser is, and a control offered
     before the read has answered would be a control with no backend. */
  let orgAvailability = { state: 'absent', code: 'ORG_BRIDGE_ABSENT', reason: ORG_ABSENT_REASON }
  let treeOrgMoveSync = Promise.resolve()
  const orgReady = () => orgAvailability.state === 'ready'
  const roleRecordFor = (id) => orgReady() && Array.isArray(orgAvailability.roles)
    ? orgAvailability.roles.find((role) => role?.id === id) || null
    : null
  /* Person-facing role data comes from the same authoritative reading the
     Role library draws. This is what lets custom roles keep their own names on
     the tree without teaching fleet-tree-copy.js a second role vocabulary. */
  const roleDisplayFor = (id) => {
    const role = roleRecordFor(id)
    return role ? { id: role.id, label: role.name || role.id } : id
  }
  const composeRoleChoices = () => orgReady() && Array.isArray(orgAvailability.roles)
    ? orgAvailability.roles.map((role) => ({ id: role.id, label: role.name || role.id, summary: role.summary || role.owns || '',
        orgRoot: role.capabilities?.orgRoot === true }))
    : undefined
  /* A role is optional. Once one is chosen, however, silently starting without
     its directions would make the picker decorative. Bind the two revisions
     that were displayed, or refuse locally before replacing an existing live
     session during Resume. Main re-checks both; this check is usability, not
     authority. */
  /* EVERY CIRCLE THAT STARTS IS A DECLARED ACTOR.
   *
   * A blank canvas role is still a real, deliberately roleless choice in the
   * UI. `identityRoleForTreeNode()` gives that choice the bounded Worker
   * identity behind the scenes, so the session can be signed as the parent of
   * a child. This is not a permission shortcut: the Role library and org store
   * still validate the role, exact seat, provider and revisions before main
   * binds the identity to the transport.
   *
   * The old path returned null here for a blank role (and after a stale write),
   * then launched an anonymous session. Such a session was guaranteed to be
   * refused by agent.spawn later. A circle is now left as a draft if its
   * identity cannot be created and confirmed at start. */

  /* THE ORGANISATION HAS EXACTLY ONE ROOT, AND A CIRCLE RUNNING THAT ROLE IS
   * THAT ONE.
   *
   * Measured on the owner's own tree, 2026-09-02: a Controller circle could
   * never bind an identity, so every agent.spawn it made was refused with
   * AGENT_SPAWN_IDENTITY_REQUIRED. The chain was: ensureSeatForNode asked for a
   * seat whose id is the NODE id; the Controller role carries the org-root
   * capability; and the store refused a second root, correctly, because the
   * shipped `controller` seat already is one. Nothing was broken -- the app was
   * asking the wrong question.
   *
   * The right question is: which seat IS this role's root, and bind to it. The
   * single-seat rule is what makes that unambiguous, so this refuses to guess
   * when it does not hold. */
  function rootSeatFor(role) {
    if (!role || role.capabilities?.orgRoot !== true) return null
    const agents = Array.isArray(orgAvailability.org?.agents) ? orgAvailability.org.agents : []
    const roots = agents.filter(agent => agent?.enabled === true && agent.role === role.id)
    return roots.length === 1 ? roots[0] : null
  }
  async function ensureSeatForNode(node, role, { retry = true, tierId = null } = {}) {
    if (!orgReady()) {
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_UNAVAILABLE',
        reason: 'The Role library could not be read, so this agent could not be given a declared identity. Reload this page, then try again.',
      }
    }
    if (typeof role !== 'string' || role.length === 0 || !roleRecordFor(role)) {
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_ROLE_UNKNOWN',
        reason: 'The role needed to give this agent a declared identity is no longer in the Role library. Reload this page, then try again.',
      }
    }
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_NODE_INVALID',
        reason: 'This circle has no saved identity, so it was not started. Reload this page, then try again.',
      }
    }
    const agents = Array.isArray(orgAvailability.org?.agents) ? orgAvailability.org.agents : []
    /* A root-role circle adopts the root seat rather than asking for another.
       The seat learns which provider it runs on, which is the one thing about
       it a start actually knows and the shipped declaration does not. */
    const rootSeat = rootSeatFor(roleRecordFor(role))
    const selectedRole = typeof node.role === 'string' ? node.role.trim() : ''
    /* WHICH TIER THIS SEAT IS BEING PREPARED FOR -- the one the start will
     * actually carry, which is not always the one the node still records.
     *
     * T158 (owner complaint T137, 2026-09-16): continueNodeOnAnotherModel asks
     * for a seat for a node whose `tier` is still the OLD model, and then
     * starts the replacement on the NEW one. shell/agent-host.cjs requires
     * `agentAuthority.provider === sessionProvider`, and that authority is the
     * SEAT's provider (shell/agent-org-record.cjs builds it from
     * `provider: agent.provider`), so the start was refused
     * AGENT_ROLE_BINDING_INVALID every time the two providers differed. Taking
     * the target tier here is what makes the seat describe the session that is
     * about to run rather than the one that just ended. */
    const tier = LAUNCH_TIERS.find(entry => entry.id === (typeof tierId === 'string' && tierId ? tierId : node.tier)) || null
    const provider = tier && ['codex', 'claude', 'gemini', 'grok', 'local'].includes(tier.provider) ? tier.provider : undefined
    /* AND THE PROVIDER IS PART OF "ALREADY SEATED". This shortcut asked only
       about id, role, enabled and the role choice, so a seat recorded against
       another provider answered "unchanged" and the call below never ran --
       which is why passing the target tier alone would not have been enough. */
    if (!rootSeat && agents.some(agent => agent?.id === node.id && agent.role === role && agent.enabled === true
      && (agent.roleSelection === '' ? '' : agent.role) === selectedRole
      && (!provider || agent.provider === provider))) {
      return { ok: true, unchanged: true, org: orgAvailability.org }
    }
    const org = typeof window === 'undefined' ? null : window.mcOrg
    if (!org || typeof org.ensureSeat !== 'function') {
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_UNAVAILABLE',
        reason: 'This installed copy cannot give a tree circle a declared identity. Update the app, then try again.',
      }
    }
    /* THE TRUE MANAGER, NOT A SILENT DEFAULT TO THE ROOT.
     *
     * A tree-spawned seat never named a manager at all, so agent-org-store.js's
     * own default (report to the organisation root when none is given) fired on
     * every one -- every node-id-shaped seat reads as `controller manages X`
     * regardless of where the circle actually sits, which is why the org reads
     * flat (see REPORT-org-vocabulary-leak-20260907.md). Naming the node's real
     * tree parent HERE, only when that parent already holds a seat of its own,
     * turns this into a real hierarchy for the ordinary case (a child starts
     * after its already-running parent) without changing anything for the one
     * case that still needs the default: a parent with no seat yet. */
    const parentSeat = !rootSeat && node.parentId
      && agents.some(agent => agent?.id === node.parentId && agent.enabled === true)
      ? node.parentId
      : undefined
    let result = null
    try {
      result = await org.ensureSeat({
        id: rootSeat ? rootSeat.id : node.id,
        role,
        ...(role === 'worker' ? { roleSelection: selectedRole } : {}),
        ...(provider ? { provider } : {}),
        /* ADOPTION IS WHAT MAKES A CHANGED PROVIDER STICK. capability/src/lib/
           agent-org-store.js only rewrites an existing seat's provider when
           `adoptProvider === true` (`providerChanged`); without it an existing
           seat returns `unchanged` holding the old provider, and the start is
           refused. Root seats already asked for adoption; a node seat now asks
           too, but only when a real tier named a provider -- with none, the
           store would default the seat to 'claude' and rewrite it wrongly. */
        ...(rootSeat || provider ? { adoptProvider: true } : {}),
        ...(rootSeat ? {} : { displayName: treeNodeName(node) }),
        ...(parentSeat ? { managerId: parentSeat } : {}),
        /* Additive only: `id` above is still the node id, which is what
           roleBindingForStart's lookup (agent.id === node.id) depends on at
           every call site. Recording the same value here as nodeId seeds the
           field agent-org-store.js now carries, without moving the id a seat
           is found by -- that would need roleBindingForStart rewritten
           everywhere it is called, which is a separate, larger change. */
        ...(rootSeat ? {} : { nodeId: node.id }),
        expectedRevision: orgAvailability.org?.revision,
      })
    } catch (error) {
      result = { ok: false, code: 'ORG_ENSURE_SEAT_THREW', reason: `The seat could not be sent to the organisation store: ${error?.message || error}` }
    }
    if (result?.ok) {
      orgAvailability = { ...orgAvailability, org: result.org }
      return result
    }
    /* A concurrent role/org edit is ordinary, not an excuse to start an
       anonymous session. Re-read once and retry against that exact revision;
       a second conflict is returned by name for the person to retry. */
    if (isRevisionConflict(result) && retry) {
      const refreshed = await refreshOrg()
      if (refreshed?.state === 'ready') return ensureSeatForNode(node, role, { retry: false, tierId })
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_UNAVAILABLE',
        reason: 'The organisation changed while this agent was starting and could not be read again. Reload this page, then try again.',
      }
    }
    return result && result.ok === false
      ? result
      : {
          ok: false,
          code: 'MC_TREE_IDENTITY_UNAVAILABLE',
          reason: 'This agent could not be given a declared identity, so it was not started. Reload this page, then try again.',
        }
  }

  /* THE COUNTERPART OF ensureSeatForNode, called once the node is already
   * gone from the tree store. A refusal is written to the org status line
   * and does nothing else -- the removal above already happened and is
   * never undone or delayed by what happens to the seat. Returns true only
   * when it wrote a sticky refusal, so the caller's own "removed" message
   * does not immediately erase it. */
  async function releaseSeatForNode(id) {
    if (!orgReady()) return false
    const org = typeof window === 'undefined' ? null : window.mcOrg
    if (!org || typeof org.releaseSeat !== 'function') return false
    let result = null
    try {
      result = await org.releaseSeat({ id, expectedRevision: orgAvailability.org?.revision })
    } catch (error) {
      result = { ok: false, code: 'ORG_RELEASE_SEAT_THREW', reason: `The seat could not be sent to the organisation store: ${error?.message || error}` }
    }
    if (result?.ok) {
      orgAvailability = { ...orgAvailability, org: result.org }
      return false
    }
    if (isRevisionConflict(result)) {
      await refreshOrg()
      return false
    }
    if (result && result.reason) {
      setOrgStatus(`The organisation seat for "${id}" could not be released: ${result.reason}`, 'refuse', { sticky: true })
      return true
    }
    return false
  }

  /* THE NODE- FORM SWEEP.
   *
   * ensureSeatForNode writes a seat id equal to the tree node's own id only
   * when the node's role is not the organisation root (rootSeatFor takes
   * that branch instead), and mintId('node', ...) in fleet-trees.js is the
   * only source of an id shaped `node-<counter>-<unique>` -- a shipped or
   * hand-declared seat never has one. releaseSeatForNode above only reaches
   * a seat whose OWN node was just removed through this page; it says
   * nothing about a seat left behind by a node that vanished some other way
   * (an earlier crash, an older build, a tree deleted from a different
   * surface). This sweep is the backstop: the first time this page has both
   * the declared org and this computer's own trees in hand, it releases
   * every node-shaped seat that no tree on this computer still names. */
  const NODE_SEAT_ID = /^node-\d+-/
  async function sweepOrphanedNodeSeats() {
    if (currentDataSource() === 'relay') return { ok: true, releasedIds: [] }
    if (!orgReady() || !treeStore) return { ok: true, releasedIds: [] }
    const org = typeof window === 'undefined' ? null : window.mcOrg
    if (!org || typeof org.releaseSeat !== 'function') return { ok: true, releasedIds: [] }

    const refuseSweep = result => {
      if (!result?.ok) {
        setOrgStatus(
          result.reason || 'Unused agent slots could not be released. Reopen Computers to read the organisation before trying again.',
          'refuse',
          { sticky: true, code: result.code || 'TREE_SEAT_SWEEP_REFUSED' },
        )
      }
      return result
    }
    const nodeSeats = Array.isArray(orgAvailability.org?.agents)
      ? orgAvailability.org.agents.filter(agent => NODE_SEAT_ID.test(agent?.id))
      : null
    const proposal = orphanedNodeSeatSweepProposal({
      store: treeStore,
      storeProblem: treeStoreProblem,
      candidateIds: nodeSeats?.map(agent => agent.id) ?? null,
      nodeSeatCount: nodeSeats?.length,
    })
    if (!proposal.ok) return refuseSweep(proposal)

    const releasedIds = []
    for (const orphanId of proposal.candidateIds) {
      const readiness = orphanedNodeSeatSweepReadiness({
        store: treeStore,
        storeProblem: treeStoreProblem,
      })
      if (!readiness.ok) return refuseSweep({ ...readiness, releasedIds })
      if (readiness.snapshot.nodes.some(node => node.id === orphanId)) continue

      const priorSeat = (orgAvailability.org?.agents || []).find(agent => agent?.id === orphanId) || null
      const audit = {
        seatId: orphanId,
        priorRoleId: typeof priorSeat?.role === 'string' ? priorSeat.role : null,
        priorManagerId: typeof priorSeat?.managerId === 'string' ? priorSeat.managerId : null,
        proposedReleasedSeatIds: [...releasedIds, orphanId],
      }
      let result = null
      try {
        result = await org.releaseSeat({
          id: orphanId,
          expectedRevision: orgAvailability.org?.revision,
          audit,
        })
      } catch {
        result = {
          ok: false,
          code: 'ORG_RELEASE_SEAT_THREW',
          reason: 'The organisation seat release was not completed.',
        }
      }
      if (result?.ok) {
        orgAvailability = { ...orgAvailability, org: result.org }
        releasedIds.push(orphanId)
      } else if (isRevisionConflict(result)) {
        await refreshOrg()
      } else {
        return refuseSweep({
          ok: false,
          code: result?.code || 'ORG_RELEASE_SEAT_FAILED',
          reason: result?.reason || 'The organisation seat could not be released.',
          releasedIds,
        })
      }
    }
    return { ok: true, releasedIds }
  }
  function roleBindingForStart(agentId, id, selectedRole = id) {
    if (!orgReady()) {
      return { ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', message: 'The Role library could not be read, so this agent could not be given a declared identity. Reload this page, then try again.' }
    }
    const role = roleRecordFor(id)
    if (!role) {
      return { ok: false, code: 'MC_TREE_IDENTITY_ROLE_UNKNOWN', message: 'That role is no longer in the Role library, so this agent could not be given a declared identity. Reload this page, then try again.' }
    }
    if (!Number.isSafeInteger(orgAvailability.org?.revision) || orgAvailability.org.revision < 0
      || !Number.isSafeInteger(role.revision) || role.revision < 0) {
      return { ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', message: 'This copy cannot bind this agent to its declared identity. Update the app, reload this page, then try again.' }
    }
    /* A tree node normally represents an ad-hoc conversation. Naming a role
       gives that conversation the role's directions, but cannot make it an
       organisation actor. Only the exact enabled agent already present in the
       same authoritative org snapshot, with this exact assignment, carries
       agentId into main's four-field binding and the capability transport. */
    const assignedAgent = (typeof agentId === 'string' && Array.isArray(orgAvailability.org?.agents)
      ? orgAvailability.org.agents.find((agent) => agent?.id === agentId
        && agent.enabled === true && agent.role === role.id) || null
      : null)
      /* ...or, for the one role an organisation has exactly one of, that one.
         See rootSeatFor: a Controller circle IS the organisation's root, and
         binding it to a seat named after its node id was asking for a second
         root the store is right to refuse. */
      || rootSeatFor(role)
    if (!assignedAgent || (assignedAgent.roleSelection === '') !== (typeof selectedRole === 'string' && !selectedRole.trim())) {
      return {
        ok: false,
        code: 'MC_TREE_IDENTITY_UNAVAILABLE',
        message: 'This agent could not be given a declared identity, so it was not started. Reload this page, then try again.',
      }
    }
    return {
      ok: true,
      role,
      binding: {
        agentId: assignedAgent.id,
        id: role.id,
        expectedOrgRevision: orgAvailability.org.revision,
        expectedRoleRevision: role.revision,
        // Empty is the saved role choice; Worker remains only the transport
        // identity. Do not give a blank circle Worker's role directions.
        ...(typeof selectedRole === 'string' && !selectedRole.trim() ? { selection: '' } : {}),
      },
    }
  }
  /* The last fleet payload, kept so the projection can be re-derived from the
     saved organisation without a second network read. Every org write goes
     through this: re-deriving is the same path a reload takes, so what the
     person sees after an edit cannot disagree with what they would see after
     restarting the app. */
  let lastFleetData = null
  /* WHY THE GRAPH ON SCREEN IS THE DECLARED ONE, when it is.
     Set to the fleet projection's own refusal sentence whenever the graph was
     built from the declared organisation instead, and printed in the rail. The
     customer is entitled to both facts at once: that these are the agents this
     copy declares, and that no fleet host reported them. Dropping the second one
     to make the page look healthier is how a screen starts lying. */
  let declaredOnlyReason = null

  /* THE SENTENCE AND THE IDENTIFIER TRAVEL TOGETHER, and until a driver checked,
     only half of that was true here.
   *
   * The rule src/refusal-copy.js sets has two halves: the code never appears in
   * words a person reads, AND it is still carried where a support conversation
   * can reach it. This line kept the first half and quietly dropped the second —
   * a refused start left a good sentence on screen and nothing on the page
   * anywhere naming which refusal it was. Measured on a packaged window from a
   * fresh profile: querySelectorAll('[data-refusal-code]') returned nothing at
   * all after a refused submit.
   *
   * It is marked HERE rather than at each call site so the attribute cannot
   * outlive the sentence it belongs to. Every path through this function sets or
   * clears it — including the seven-second fade, where a code left behind would
   * describe a message that is no longer on screen. */
  function setOrgStatus(text, state = 'info', { sticky = false, code = null } = {}) {
    clearTimeout(orgStatusTimer)
    orgStatusTimer = 0
    orgStatusPrimary = { text, state, code }
    renderOrgStatus()
    if (text && !sticky) {
      orgStatusTimer = setTimeout(() => {
        orgStatusPrimary = null
        orgStatusTimer = 0
        renderOrgStatus()
      }, 7000)
    }
  }
  function renderOrgStatus() {
    let { text = '', state = 'info', code = null } = orgStatusPrimary || {}
    // A later handler saying "Saved" must not erase an outstanding tree-save
    // refusal. Other failures still get their own words beside this warning.
    if (treePersistenceProblem) {
      text = !text || state === 'ok' ? treePersistenceProblem
        : text.endsWith(treePersistenceProblem) ? text : `${text} ${treePersistenceProblem}`
      state = 'refuse'
    }
    const continuationStatus = currentDataSource() === 'local' ? accountRecoveryCoordinator?.continuationStatus() : null
    if (continuationStatus?.blocked) {
      const reason = continuationStatus.reason
      text = !text || state === 'ok' ? reason : text.includes(reason) ? text : `${text} ${reason}`
      state = 'refuse'
      code ||= continuationStatus.code
    }
    orgStatusElement.textContent = text || ''
    orgStatusElement.dataset.state = text ? state : 'idle'
    orgStatusElement.hidden = !text
    markRefusalCode(orgStatusElement, code ? { code } : null)
  }

  const agentNameOf = (agentId) =>
    computer?.agents?.find(entry => entry.id === agentId)?.name || agentId || 'nobody'

  async function refreshOrg() {
    const next = await readOrg()
    if (destroyed) return next
    orgAvailability = next
    refreshTreeNames()
    syncEditAvailability()
    return next
  }

  function clearBoard() {
    refreshRailMoveChoices = null
    boardCloudBox?.__cloudController?.destroy()
    boardCloudBox = null
    /* The rail's chat re-plans on a window event. Every node click builds a new
       one, so the previous node's listener has to go with the previous panel or
       a session spent clicking around the tree leaves one attached per click. */
    railChatUnsub?.()
    railChatUnsub = null
  }

  function activateRail(page) {
    clearTimeout(railDisposeTimer)
    statsPage.classList.toggle('is-active', page === statsPage)
    controlsPage.classList.toggle('is-active', page === controlsPage)
    /* The compose panel is a page here like the other two, so exactly one of the
       three is ever on screen and none of them has to know about the others. */
    composePage.classList.toggle('is-active', page === composePage)
    /* On a phone the rail lives in a sheet, so "which rail page" and "is the
       sheet up" are the same question — a press on a bubble has to raise the
       answer as well as write it. phoneCanvas is null on every desktop, so this
       line does nothing there. */
    phoneCanvas?.onRailPage(page === statsPage ? 'stats' : page === controlsPage ? 'controls' : 'compose')
    if (page === statsPage) {
      railDisposeTimer = setTimeout(clearBoard, 200)
      /* RE-READ THE RECORD ON THE WAY BACK. The overview is painted once when
         the board mounts, and coming back to it from the compose panel does not
         re-render it -- so a person who started an agent and pressed Cancel was
         looking at the count as it stood BEFORE they started anything. Measured
         on the packaged build: two starts in the signed ledger, hero still
         reading 0, which is the owner's report exactly. Returning to this page
         is a gesture, not a poll, so this costs one read per visit. */
      void paintAgentsOnRecord()
      paintFleetOverview()
    }
  }

  function syncResetButton() {
    resetButton.hidden = !(graph?.editMode && graph.hasPositionOverrides())
  }

  function syncEditButton() {
    const editing = !!graph?.editMode
    editButton.textContent = editing ? 'Done' : 'Edit'
    editButton.classList.toggle('on', editing)
    editButton.setAttribute('aria-pressed', editing ? 'true' : 'false')
    graphWrap.classList.toggle('editing', editing)
    syncResetButton()
  }

  /* THE EDIT BUTTON IS A DOOR TO A WRITE.
     Editing the hierarchy means dragging a node onto a new manager, and that
     move is only a change if an organisation store accepts it. With no store
     behind this window — a plain browser, or a build whose payload carries no
     organisation modules — every drag would be undone the moment it was tried,
     so the button is disabled and carries the reason instead of opening a mode
     that can only disappoint.
     THE EXAMPLE FLEET IS DISABLED WITH ITS OWN SENTENCE, which reverses the
     old simulated render's rule ("its drag moves demonstration data around
     demonstration data"). Mock never writes, and a drag that rearranged the
     example would be an edit of nothing that LOOKS like an edit of something;
     tree-graph.js separately refuses any drop with no onReparent, so this
     disable and mountGraph's null onReparent are two locks on one door. */
  function syncEditAvailability() {
    const blocked = mockSource()
      ? EXAMPLE_REARRANGE_TEXT
      : !orgReady()
        ? failureSentence(orgAvailability, 'The declared organisation could not be read.')
        : null
    /* aria-disabled, NOT disabled. A `disabled` button swallows the press, and
       the whole explanation lived in `title` — which a finger never sees. The
       phone press-through (2026-08-27) measured exactly that: Edit refusing in
       silence on touch. aria-disabled keeps the press deliverable so the click
       handler can answer with the sentence in the page's own status line,
       while assistive tech still hears the control as unavailable. */
    if (blocked) {
      editButton.setAttribute('aria-disabled', 'true')
      editButton.title = `The hierarchy cannot be edited here. ${blocked}`
      editButton.setAttribute('aria-label', editButton.title)
      if (graph?.editMode) {
        graph.setEditMode(false)
        syncEditButton()
      }
    } else {
      editButton.removeAttribute('aria-disabled')
      editButton.title = 'Edit the role hierarchy'
      editButton.removeAttribute('aria-label')
    }
  }

  /* THE DRAG, AND WHAT MAKES IT A CHANGE RATHER THAN AN APPEARANCE.
   *
   * src/tree-graph.js asks this question synchronously and commits the visual
   * move on a truthy answer, so the local guards answer first — they are the
   * fast path and they are what drives the drop highlight and the refusal
   * shake. The store's answer arrives afterwards, and if it is a refusal the
   * projection is re-derived from what is actually saved, which puts the node
   * back where it was and leaves the store's own sentence on screen.
   *
   * A move that stays on the canvas after the store refused it is precisely the
   * defect this control existed to have: the page would be drawing an
   * organisation that nobody has. */
  function handleReparent(agentId, parentId) {
    /* A TREE NODE MOVES IN THE TREE STORE; a fleet agent moves in the declared
       organisation. Before this branch, dragging a node the person had
       CREATED hit the org projection's byId miss and shook with no sentence
       anywhere — an affordance that was visible on their own agents and
       silently did nothing. Mixed drags refuse with words for the same
       reason. The store's own refusals (caps, cycles, cross-tree) come back
       verbatim; the subscription repaints the tree on an accepted move. */
    const dragIsTree = Boolean(treeStore?.getNode(agentId))
    const dropIsTree = Boolean(treeStore?.getNode(parentId))
    if (dragIsTree || dropIsTree) {
      if (dragIsTree !== dropIsTree) {
        setOrgStatus(MOVE_PANEL.mixed, 'refuse', { sticky: true })
        return false
      }
      const moved = treeStore.moveNode(agentId, parentId)
      if (!moved.ok) {
        setOrgStatus(treeNodeName(treeStore.getNode(parentId)) + ': ' + (moved.problems[0] || MOVE_PANEL.notSaved), 'refuse', { sticky: true })
        return false
      }
      setOrgStatus(MOVE_PANEL.saved(treeNodeName(moved.node), treeNodeName(treeStore.getNode(parentId))), 'ok')
      /* Say the saved move first. An older bridge can refuse synchronously;
         its reconnect warning must be the last truth on the shared line, not
         immediately overwritten by this success sentence. */
      void syncSavedTreeMove(agentId)
      return true
    }
    if (!computer?.reparentAgent?.(agentId, parentId)) return false
    void persistReparent(agentId, parentId)
    return true
  }

  /* A manual move is already durable in the tree before either projection is
     updated. Keep organisation writes in order, including moves of stopped
     nodes; a refused projection write must never undo that accepted move. */
  async function syncSavedTreeMove(rootId, store = treeStore) {
    const node = store?.getNode(rootId)
    const parent = node?.parentId ? store?.getNode(node.parentId) : null
    const addressJob = syncTreeBranchAddresses(rootId, store)
    const orgJob = treeOrgMoveSync.catch(() => {}).then(async () => {
      const bridge = orgBridge()
      const available = orgAvailability
      const unstartedDraft = saved => saved?.status === 'draft' && saved?.sessionId == null
      if (!node || !parent) {
        return { ok: false, code: 'ORG_TREE_MOVE_UNAVAILABLE',
          reason: 'The saved manager could not be sent to the organisation store.' }
      }

      /* A draft without a session is not proof that the node was never seated:
         detachSession deliberately demotes a live node to draft without
         changing its declared organisation seat. Only a ready snapshot can
         prove that this move has no organisation projection. */
      const hasSnapshot = available.state === 'ready'
        && Array.isArray(available.org?.agents)
      if (!hasSnapshot) {
        /* There is no authoritative seat list to inspect. Preserve the
           accepted tree move without inventing a no-seat conclusion, and let a
           later authoritative refresh decide whether an org write is needed. */
        if (unstartedDraft(node)) {
          return {
            ok: true,
            organisation: 'deferred',
            reason: 'The tree move was saved; organisation sync is deferred until its authoritative snapshot is available.',
          }
        }
        return { ok: false, code: 'ORG_TREE_MOVE_UNAVAILABLE',
          reason: 'The saved manager could not be sent to the organisation store.' }
      }

      const agents = available.org.agents
      /* Keep zero matches separate from ambiguity. A zero-seat tree node is
         saved conversation state, not an organisation actor; ambiguity is a
         refusal because guessing could move the wrong declared agent. */
      const seatFor = (saved) => {
        const matches = agents.filter(agent => agent?.enabled === true
          && (agent.id === saved.id || agent.nodeId === saved.id))
        if (matches.length === 1) return { kind: 'seat', seat: matches[0] }
        if (matches.length > 1) return { kind: 'ambiguous' }
        const role = roleRecordFor(saved.role)
        const roots = role?.capabilities?.orgRoot === true
          ? agents.filter(agent => agent?.enabled === true && agent.role === role.id)
          : []
        if (roots.length === 1) return { kind: 'seat', seat: roots[0] }
        if (roots.length > 1) return { kind: 'ambiguous' }
        return { kind: 'none' }
      }
      const seat = seatFor(node)
      /* A moved circle with no direct/root seat has no declared organisation
         identity to move, but only after the ready snapshot established that
         fact. A draft with a retained seat continues through the refusal path. */
      if (seat.kind === 'none') return { ok: true, organisation: 'not-applicable' }
      const manager = seatFor(parent)
      if (seat.kind === 'ambiguous' || manager.kind !== 'seat') {
        const subject = seat.kind === 'ambiguous' ? 'The moved circle' : 'The saved manager'
        const reason = seat.kind === 'ambiguous' || manager.kind === 'ambiguous'
          ? `${subject} has more than one enabled declared seat, so there is no unambiguous declared seat.`
          : `${subject} has no declared seat.`
        return { ok: false, code: 'ORG_TREE_MOVE_IDENTITY_UNAVAILABLE', reason }
      }

      /* Resolve identities before checking the writer and revision. A ready
         snapshot can prove no seat, but an absent writer or invalid revision
         must not hide a known seated-node refusal. */
      if (!Number.isSafeInteger(available.org.revision)
          || typeof bridge?.reparent !== 'function') {
        return { ok: false, code: 'ORG_TREE_MOVE_UNAVAILABLE',
          reason: 'The saved manager could not be sent to the organisation store.' }
      }
      let result
      try {
        result = await bridge.reparent({
          agentId: seat.seat.id,
          parentId: manager.seat.id,
          expectedRevision: available.org.revision,
        })
      } catch {
        result = { ok: false, code: 'ORG_REPARENT_THREW',
          reason: 'The saved manager could not be sent to the organisation store.' }
      }
      if (result?.ok && result.org && Number.isSafeInteger(result.org.revision)) {
        // This view's queued moves need the revision returned by the preceding
        // write, even if the view was closed while that write was in flight.
        if (!Number.isSafeInteger(orgAvailability.org?.revision)
            || result.org.revision >= orgAvailability.org.revision) {
          orgAvailability = { ...orgAvailability, org: result.org }
        }
        return result
      }
      if (isRevisionConflict(result)) {
        await refreshOrg()
        return { ...result, ok: false, reason: REVISION_CONFLICT_ADVICE }
      }
      return result?.ok === false ? result : {
        ok: false, code: 'ORG_TREE_MOVE_UNCONFIRMED',
        reason: 'The organisation store did not confirm the saved manager.',
      }
    })
    treeOrgMoveSync = orgJob.then(() => {}, () => {})
    const [address, declared] = await Promise.allSettled([addressJob, orgJob])
    const organisation = declared.status === 'fulfilled' ? declared.value : {
      ok: false, code: 'ORG_TREE_MOVE_UNAVAILABLE',
      reason: 'The declared organisation could not be read after the move.',
    }
    const addressOk = address.status === 'fulfilled' && address.value?.ok === true
    if (!organisation?.ok && !destroyed) {
      /* The tree write already succeeded. Compose a remedy that says what
         is true for this flow: the saved move remains durable and the person
         should inspect the current organisation before trying again. Calling
         refusalSentence directly keeps the engine diagnosis and avoids brittle
         surgery on shared refusal copy. */
      const reason = refusalSentence(organisation, {
        fallback: 'The declared manager could not be updated.',
        remedy: 'The tree move is saved; review the current organisation before trying again.',
      })
      const addressReason = addressOk ? '' : ' The messaging address was not fully updated either.'
      setOrgStatus(`The tree move was saved, but the declared organisation was not updated. ${reason}${addressReason}`,
        'warn', { sticky: true, code: organisation?.code })
    }
    return { ok: addressOk && organisation?.ok === true, address, organisation }
  }

  async function persistReparent(agentId, parentId) {
    const bridge = orgBridge()
    if (!bridge || !orgReady()) {
      reprojectFromOrg()
      setOrgStatus(failureSentence(orgAvailability, 'The move could not be saved.'), 'refuse', { sticky: true })
      return
    }
    const version = fetchVersion
    setOrgStatus('Saving the new manager…', 'busy', { sticky: true })
    let result
    try {
      result = await bridge.reparent({
        agentId,
        parentId,
        /* A stale window is refused rather than allowed to overwrite whatever a
           second window saved in the meantime. */
        expectedRevision: orgAvailability.org.revision,
      })
    } catch (error) {
      result = { ok: false, code: 'ORG_REPARENT_THREW', reason: `The move could not be sent to the organisation store: ${error?.message || error}` }
    }
    if (destroyed || version !== fetchVersion) return
    if (result?.ok) {
      orgAvailability = { ...orgAvailability, org: result.org }
      setOrgStatus(`Saved. ${agentNameOf(agentId)} now reports to ${agentNameOf(parentId)}.`, 'ok')
      return
    }
    if (isRevisionConflict(result)) {
      await refreshOrg()
      if (destroyed || version !== fetchVersion) return
      reprojectFromOrg()
      setOrgStatus(REVISION_CONFLICT_ADVICE, 'refuse', { sticky: true })
      return
    }
    reprojectFromOrg()
    setOrgStatus(failureSentence(result, 'The move was not saved.'), 'refuse', { sticky: true })
  }

  /* HIDDEN ONLY WHEN THERE IS NOBODY AT ALL; STATED WHEN THE DOOR CANNOT OPEN.
     Hidden covers genuine absence — the projection is unavailable and there is
     no agent anywhere for a door to name (`Reset positions` treats absence the
     same way). But a SELECTED agent is not absence, and the old rule treated
     it as one: selecting a tree agent aimed this button at null, so the door
     vanished at the exact moment a person was looking at an agent (measured on
     the desktop press-through, 2026-08-27: 0-width button, no rail equivalent,
     the only way back was deselecting first). A control that silently removes
     itself is the defect this page's own refusal rule exists to end, so a tree
     agent now keeps the button on screen, marked unavailable, carrying the
     reason: a tree node has no drill-in page because #/agent reads the fleet
     record, and everything about the node is already in the rail beside the
     tree. aria-disabled rather than disabled so a press can still be answered
     in words — a hover title is nothing to a finger. */
  function syncOpenButton() {
    openButton.hidden = false
    openButton.removeAttribute('aria-disabled')
    openButton.textContent = 'Fleet overview'
    openButton.setAttribute('aria-label', 'Show fleet overview')
    openButton.title = 'Show the fleet overview in the side panel'
  }

  function setOpenTarget(agent) {
    openTarget = agent || null
    syncOpenButton()
  }

  /* THE DOOR MUST NOT DEPEND ON THE TREE, BECAUSE THE TREE IS EMPTY BY DESIGN.
   *
   * WHAT WAS MEASURED, on a staged packaged build with a fresh profile, at five
   * window sizes and from the keyboard:
   *   .graph-open-btn      1   (in the DOM)
   *   pressable            no  (hidden)
   *   .static-tree-node    0
   * and, from tools/a11y-keyboard-qa: "an agent can be opened from the keyboard
   * on the computers page -- no Open control was reachable by Tab".
   *
   * WHY. This button was aimed at `computer.agents[0]`, and since 5cc2f09 ("a
   * fleet tree you build, instead of one the app invented") those are the agents
   * this person has STARTED -- correctly empty until they start one. So the
   * button hid itself on every fresh install.
   *
   * AND THAT CLOSED A CIRCLE. #/agent/<computer>/<agent> is where a session is
   * started from a declared seat (src/agent-session.js publishes the live record
   * from there). This button is its only door inside the product. So: no started
   * agent, no door; no door, no way to reach the page that starts one. The page
   * itself was never broken -- src/views/agent.js resolves from
   * declaredAgentsData(), which answers for every declared seat whether or not
   * anything has run -- so the destination was live the whole time with nothing
   * pointing at it.
   *
   * THE TREE STAYS EMPTY. This changes no node, draws no circle and invents no
   * agent: the owner's rule ("the node tree should be empty unless a user has
   * started a session") is the reason the fallback reads DECLARED CAPACITY
   * rather than putting a seat on the canvas. Capacity is what this computer
   * COULD run, it is exactly what the drill-in page reads, and declared-fleet.js
   * keeps the two halves apart on purpose. Nothing is drawn; a door is named. */
  function firstDeclaredTarget() {
    /* Under mock the door aims at the example fleet's own first seat, derived
       from sample-fleet — NEVER from the declared organisation, which is real
       data a badged screen must not read. The drill-in behind it renders the
       same example world (src/views/agent.js resolves by the same source). */
    if (mockSource()) {
      const seat = sampleFleetData(Date.now()).graph.nodes[0]
      return seat ? { id: seat.id, name: seat.label || seat.id } : null
    }
    if (!orgReady()) return null
    const seat = declaredAgentsData(orgAvailability.org)?.declared?.[0]
    return seat ? { id: seat.id, name: seat.displayName || seat.id } : null
  }

  openButton.addEventListener('click', () => {
    graph?.workspace?.showTrees({ focus: false })
    if (graph && !graph._treeWide && statsPage.classList.contains('is-active')) {
      graph.setWide(true)
      return
    }
    graph?.setWide(false)
    showStats()
  })
  root.querySelector('.tree-rail-close').addEventListener('click', () => graph?.setWide(true))

  editButton.addEventListener('click', () => {
    /* The unavailable state answers the press in words — the title sentence,
       in the status line — because on touch the title is unreachable and a
       silent press is the defect the availability sync documents. */
    if (editButton.getAttribute('aria-disabled') === 'true') {
      setOrgStatus(editButton.title, 'refuse')
      return
    }
    if (!graph) return
    if (graph.editMode) {
      graph.setEditMode(false)
      syncEditButton()
      return
    }
    treeEditPicker?.close()
    const target = graph
    const trees = target.treeWindows?.getTrees() || (target._scopeModel().children.get(null) || [])
      .map(id => ({ rootId: id, name: target._agentFor(id)?.name || 'Tree', count: target._scopeModel().summary(id).total }))
    treeEditPicker = showTreeEditPicker({
      host: graphWrap, trees,
      selectedRootIds: target.treeWindows?.windows.flatMap(frame => frame.graph.windowRootIds || []) || trees.map(tree => tree.rootId),
      onCancel: () => { treeEditPicker = null },
      onConfirm: rootIds => {
        treeEditPicker = null
        if (destroyed || target !== graph || editButton.getAttribute('aria-disabled') === 'true') return
        graph.setEditMode(true, { rootIds })
        syncEditButton()
      },
    })
  })
  resetButton.addEventListener('click', () => {
    graph?.resetPositions()
    syncResetButton()
  })

  /* ESCAPE LEAVES THE AGENT RAIL, the way it leaves every other layer on this
     page. Measured on the desktop press-through (2026-08-27): Escape closed
     the drawer and the actions popover and did nothing at all to the rail —
     one key, three behaviours — leaving "‹ Back" as the rail's only exit.
     Capture, not bubble, and that is load-bearing: the drawer's own handler
     (src/main.js) and the popover's both mutate the DOM synchronously, so a
     bubble listener registered after them would look at a world they had
     already changed and close a second layer on the same press. In capture
     this runs FIRST and reads the layers as the key found them; every guard
     below is a layer whose own handler owns this press. */
  const onRailEscape = (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (agentScreenVoice.el.open) { event.preventDefault(); closeAgentContact(); return }
    if (treeEditPicker) return
    /* On a phone the rail lives inside the sheet, and the sheet's handler owns
       Escape — it closes the sheet and deliberately keeps the rail's page. */
    if (phoneCanvas || chatOnly) return
    if (!controlsPage.classList.contains('is-active')) return
    /* The modal drawer takes the key (main.js closes it on this same press). */
    if (document.querySelector('.drawer.open')) return
    /* The actions popover takes it (components.js closes and stops it). */
    if (document.querySelector('.chat-actions-pop')) return
    /* A text control's Escape means "leave this box" and its own handlers say
       how (the rail chat input blurs, the chat search closes). */
    const tag = event.target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    /* An open chat card is the topmost canvas layer; tree-graph closes it one
       step at a time. */
    if (graph && [...graph.nodes.values()].some(record => record.chatOpen)) return
    event.preventDefault()
    event.stopPropagation()
    const active = document.activeElement
    const focusWasInRail = railElement.contains(active) || !active || active === document.body
    const selected = graph?.selectedId ? graph.nodes.get(graph.selectedId) : null
    /* select(null) clears the ring as well as the id, so the canvas does not
       keep a "selected" bubble beside a rail showing the fleet overview. */
    graph?.select(null)
    showStats()
    /* The control that had focus just left the screen with the rail page; the
       deselected bubble is where the person's attention was, so focus lands
       there — the same hand-back the drawer gives its opener. */
    if (focusWasInRail) selected?.el?.focus?.()
  }
  document.addEventListener('keydown', onRailEscape, true)
  unsubs.push(() => document.removeEventListener('keydown', onRailEscape, true))

  /* THE BAR HOLDS TWO KINDS OF CHIP AND THEY ARE DIFFERENT KINDS OF THING.
   *
   * YOUR COMPUTERS, FIRST, and only when this browser is reading one of them
   * over the account. Each chip is a whole machine; pressing it changes which
   * machine the whole page is read from. This is the owner's ruling of
   * 2026-08-23 — the choice used to be made on the account page, which meant
   * leaving the product to change which computer you were using it on.
   *
   * THE COMPUTERS IN THE MOUNTED RECORD, AFTER THEM — the bar that has always
   * been here. Those are entries in one machine's own fleet record, and
   * pressing one re-mounts a graph. The example fleet's two computers arrive
   * through this same list as a real fleet's; the simulated render's "+" tab
   * (sim.addComputer) is gone with the render, because a control that mints a
   * pretend computer has no honest meaning on any source.
   *
   * THEY ARE ONLY BOTH DRAWN WHEN BOTH OFFER A CHOICE. Over the account, a
   * machine that reports no fleet host has exactly one record computer, and it
   * is the very machine already named by its own chip above — drawn twice, once
   * under the account's name for it and once as "This computer", which is two
   * chips for one machine and the wrong name on one of them. So the record
   * group is drawn beside the account group only when the record really holds
   * more than one. With no account computers — the desktop, and the example —
   * nothing above changes and this is the bar it has always been. */
  function renderTabs() {
    tabsElement.innerHTML = ''
    /* WHICH GROUPS ARE DRAWN IS NOT DECIDED HERE. It is a rule about two lists,
       it decides whether the desktop and the example keep the bar they have
       always had, and a rule that can only be checked by reading this function
       is a rule that can silently stop existing. src/machine-tabs.js states it
       and tools/test/machine-tabs.test.mjs calls it with values. */
    const bar = machineTabsBar(machineChoices, liveComputers.length)
    for (const choice of bar.machines) {
      const tab = el(`<button type="button" class="tab ${choice.driving ? 'active' : ''}" data-machine-tab></button>`)
      /* The account's name for it, set as text rather than built into markup:
         this is the one string in the bar that comes from outside the program. */
      tab.textContent = choice.name
      tab.disabled = machineSwitchBusy
      tab.addEventListener('click', () => driveMachine(choice))
      tabsElement.appendChild(tab)
    }
    if (bar.separator) tabsElement.appendChild(el('<span class="tab-sep" aria-hidden="true"></span>'))
    if (!bar.record) return
    for (const candidate of liveComputers) {
      const tab = el(`<button class="tab ${candidate === computer ? 'active' : ''}">${escapeMarkup(candidate.name)}<span class="ip">${escapeMarkup(candidate.ip)}</span></button>`)
      tab.addEventListener('click', () => switchComputer(candidate))
      tabsElement.appendChild(tab)
    }
  }

  function switchComputer(next) {
    if (!next || next === computer) return
    computer = next
    renderTabs()
    mountGraph()
    void agentScreenVoice.refresh()
    showStats()
  }

  /* The answer to the last press on the bar, in the section the press was made
     in. Empty string takes the line off the page rather than leaving a blank
     band where a sentence was. */
  function setMachineNote(text) {
    machineNoteElement.textContent = text || ''
    machineNoteElement.hidden = !text
  }

  /* DRIVE ANOTHER COMPUTER, WITHOUT LEAVING THE PAGE.
   *
   * The decisions all live in src/machine-tabs.js, which can be called with a
   * value and asserted on; this half is what a browser has to do that a
   * function cannot. The one rule worth restating here: NOTHING IS RE-READ
   * UNTIL THE OTHER MACHINE HAS ANSWERED. A press that cannot reach a computer
   * leaves the person on the one they were already driving, looking at the page
   * they were already reading, with a sentence saying what happened — never at
   * an empty screen belonging to a machine that is switched off. */
  async function driveMachine(choice) {
    if (destroyed || machineSwitchBusy) return
    /* Already on it. Re-choosing would close a live tunnel and open an
       identical one, which is a page that blinks for no reason. */
    if (choice.driving) return
    const previous = machineChoices.find(row => row.driving) || null
    const result = await switchMachineTab(window, choice, { previous })
    if (destroyed || result.cancelled || !machineTabSwitchResultIsCurrent(window, result)) return
    if (!result.ok) {
      setMachineNote(result.sentence)
      return
    }
    /* A VERIFIED SUCCESS CLEARS THE LINE. An older bridge can make the choice
       without exposing the liveness question; that is still a usable switch,
       but its "could not check" sentence stays visible rather than being
       rounded to the same empty status as a computer that answered.

       It is cleared HERE and by the example mount,
       and deliberately NOT by the list read below: choosing a computer makes the
       host announce a change, the read listens for that announcement, and a
       clear on that path would wipe a refusal a moment after the person read it.
       A sentence about a press therefore lasts until the next press or until the
       page changes worlds, which is as long as it is about anything. */
    setMachineNote(result.sentence)
    /* THE CHIP MOVES FIRST, and this is derived rather than assumed: the choice
       was made with these two ids and the account accepted them, so this tab is
       pointed at this computer. Waiting for the account to be asked again would
       leave the old chip lit over the new machine's page for as long as that
       request takes. The re-read below corrects everything else on the list —
       a computer removed from somewhere else, a connection taken apart — and it
       runs as part of the re-mount rather than as a second request.

       Matched on the two ids rather than on object identity: the list can be
       replaced under the await above by a re-read the host asked for, and an
       identity test would then light no chip at all. */
    machineChoices = machineChoices.map(row => Object.freeze({
      ...row,
      driving: row.relayPairId === choice.relayPairId && row.devicePairId === choice.devicePairId,
    }))
    renderTabs()
    mountRealSource()
  }

  /* READ ONCE PER MOUNT, AND WHEN THE HOST SAYS THE WORLD CHANGED. There is no
     timer here on purpose: a bar that re-asked the account on an interval would
     spend a request a second describing a list that changes when a person adds
     a computer, which is not something that happens while they watch.

     REAL, ACCOUNT-READ SOURCES ONLY. Under the example the bar must stay
     exactly what it is — real machine names in a badged box would make part of
     it true, which is the one thing the badge rules out — and on the desktop
     there is no account bridge to ask. */
/* WHERE THE BAR BELONGS, AND THE ONE PLACE THE EXAMPLE IS NOT A WALL.
   *
   * Over the relay, obviously. But there is a second state, and it is the one
   * the owner is in: signed in, two computers connected, neither one chosen.
   * The host will not guess between them, so it hands back no transport, so
   * this page resolves to the example -- and the bar that exists to let a
   * person pick a computer was the one thing not drawn on the only screen where
   * they needed it. The first choice had to be made on the account page, which
   * is exactly the second path we are removing.
   *
   * WHY THIS DOES NOT BREAK THE BADGE. "Nothing real rides into the badged
   * screen" is about READINGS: your org, your runs, your machine's sign-in
   * state, dressed as an example and therefore half true. A list of your own
   * computers' names is not a reading of anything -- it is the door out, and
   * the account page already shows you those names. A door is not data. Every
   * other real source stays cleared exactly as it was. */
  function machineChoicesBelongHere() {
    if (currentDataSource() === 'relay') return true
    return hostFallbackCode() === NO_MACHINE_CHOSEN
  }

  async function loadMachineChoices() {
    /* The shared transaction owns its sentence and disables all machine
       buttons. A replacement view can still read the bar while it is pending;
       this list read cannot clear or complete that transaction. */
    if (destroyed || !machineChoicesBelongHere()) {
      machineChoices = []
      return
    }
    const answer = await readMachineTabs(window)
    /* The source can flip while the account is answering; a list that arrives
       after the page has gone back to the example belongs to a world that is
       no longer on screen. */
    if (destroyed || !machineChoicesBelongHere()) return
    machineChoices = answer.ok ? answer.rows : []
    renderTabs()
  }

  function renderCrumb(rootId, chain = []) {
    crumbElement.innerHTML = ''
    if (!rootId) return
    const machine = el('<button type="button"></button>')
    machine.textContent = `← ${computer.name}`
    machine.addEventListener('click', () => graph?.clearRoot())
    crumbElement.appendChild(machine)
    chain.forEach((hop, index) => {
      crumbElement.appendChild(el('<span class="sep">/</span>'))
      if (index < chain.length - 1) {
        const button = el('<button type="button" class="crumb-hop"></button>')
        button.textContent = hop.name
        button.addEventListener('click', () => graph?.setRoot(hop.id))
        crumbElement.appendChild(button)
      } else {
        const current = el('<span><b></b></span>')
        current.querySelector('b').textContent = hop.name
        crumbElement.appendChild(current)
      }
    })
  }

  /* THE BADGE FOLLOWS THE SOURCE. Mock draws a visible "Example, not your
     data" marking beside the computer's name — the product's one phrasing for
     example data (src/approvals-example.js pins it; home, comms and the
     ledger all say these exact words) — and local AND relay draw nothing,
     because real data is never badged. It sits in the bar's lead slot, beside
     graphTitle, so it is on screen at every scroll position and cannot be
     mistaken for a fact about one node. It rides `.rail-sub` — the product's
     small mono register, already a stylesheet rule, which keeps rail-chrome's
     unstyled-class sweep honest — and the pill itself is drawn inline from
     the theme's own tokens because this pass touches no stylesheet; the vars
     keep it truthful in both themes. */
  function syncExampleBadge() {
    phoneCanvas?.syncSource()
    const lead = root.querySelector('.graph-bar-lead')
    if (!lead) return
    let badge = lead.querySelector('[data-example-badge]')
    if (!mockSource()) {
      badge?.remove()
      return
    }
    if (badge) return
    badge = el('<span class="rail-sub graph-example-badge" data-example-badge="true" style="font: 600 10.5px/1.7 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; margin: 0 0 0 10px; align-self: center; white-space: nowrap;">Example, not your data</span>')
    lead.appendChild(badge)
  }

  function clearMountedGraph() {
    graph?.destroy()
    graph = null
    canvas?.remove()
    canvas = null
    if (window.__mcGraph && window.__mcGraph._destroyed) window.__mcGraph = undefined
  }

  function clearEmptyPanel() {
    emptyPanel?.remove()
    emptyPanel = null
  }

  /* ==========================================================================
     THE TREES THIS COMPUTER HOLDS, AND THE PRESS THAT GROWS ONE.
     ==========================================================================

   * THE OWNER'S FLOW, END TO END, AND WHICH FILE OWNS EACH STEP:
   *
   *   an empty circle is drawn        src/tree-graph.js
   *   it is pressed                   src/tree-graph.js reports it, starts nothing
   *   the right-side panel opens      src/agent-compose-panel.js
   *   role and message are answered   src/agent-compose-panel.js
   *   a DRAFT agent joins the tree    src/fleet-trees.js
   *   a real session starts           window.mcAgent, via startAgentForNode above
   *   the session is attached to it   src/fleet-trees.js
   *
   * Everything between those steps is this file, and it is deliberately nothing
   * but joining: no structure rules, no form, no sentences. Each of those three
   * modules is proven on its own under `node --test`; a rule copied into this
   * view would be a second opinion that no test holds.
   *
   * NOTHING IN HERE RUNS ON MOUNT. The store is read when a computer is drawn,
   * because a tree that was built yesterday has to appear today — that is a
   * READ. The panel is built on a press, the draft is written on a submit, and
   * the bridge is called from that submit and from nowhere else.
   */

  /* One store per computer, because a tree belongs to the machine it runs on and
     the person switching tabs is switching machines. Rebuilt by mountGraph when
     the computer changes; the previous one is dropped with its subscription. */
  let treeStore = null
  /* Relay reads use the native computer's immutable forest when the host
     advertises it. This is intentionally separate from the browser tree store:
     an unavailable native snapshot never becomes localStorage or a session
     projection, and all write controls stay refused for this view. */
  let authoritativeTreeSnapshot = null
  let authoritativeTreeComputer = null
  /* Pending bridge calls survive route changes, not renderer reloads. A node joins
     this set only between the person's start press and the bridge's answer, so
     the batch preflight counts a seat even before the session id comes back. */
  const startingNodeIds = RUN_STARTING_NODE_IDS
  const startingTreeIds = new Set()
  const treeLaunchQueues = new Map()
  const nodeLaunchQueues = new Map()
  /* The durable transcript excerpts for this computer's nodes — opened and
     released in step with the tree store, but failing ALONE: a transcript
     store that cannot open leaves the trees standing and resume disabled. */
  let transcriptStore = null
  let diffHistoryStore = null
  let treeStoreUnsub = null
  let treePersistenceUnsub = null
  /* Registered while this view's store instance is live, so the research
     dispatcher's module-level listener never opens a second instance beside
     it — see markTreeStoreLive in src/fleet-trees.js. */
  let treeStoreLiveRelease = null
  let treeStoreId = null
  /* The composed name each circle last answered to, kept because the
     cross-tree half of the naming rule is computed and not stored -- see
     refreshTreeNames(), which compares against this to decide whether a
     running circle's registered address has fallen behind its canvas name. */
  let lastComposedNames = new Map()
  /* What the names were composed FROM, so the watch can tell an ordinary change
     from one that could have renamed somebody -- see namingSignature(). */
  let lastNamingSignature = null
  /* WHOSE ANSWER IS WHOSE. One event stream carries every open session, so the
     tree keeps its own map from session to node, written at the one place a
     session is born (submitCompose), and a per-session turn buffer -- the
     engine emits one delta per token, and a reply is one message, not one
     message per token (the agent page's CORRECTED note is the measured version
     of why). nodeReplies is what the rail renders under "What it said".

     The session map itself is RUN_SESSION_NODES, above: it belongs to the app
     run and not to this view instance, for the reason given there. */
  const sessionNodeIds = RUN_SESSION_NODES
  /* One directory write per running circle, in saved move order across view
     lifetimes. A destroyed view cannot restore an older parent after a new
     view has already synchronized the person's latest move. */
  const treeAddressSyncs = RUN_TREE_ADDRESS_SYNCS
  let profileCwds = new Map()
  const profileMapListeners = new Set()
  function replaceProfileCwds(answer) {
    let next = new Map()
    try {
      if (answer && answer.ok === true && Array.isArray(answer.profiles)) {
        for (const profile of answer.profiles) {
          if (!profile || typeof profile !== 'object'
              || typeof profile.id !== 'string' || !profile.id.trim()
              || typeof profile.cwd !== 'string' || !profile.cwd.trim()) continue
          next.set(profile.id, profile.cwd.trim())
        }
      }
    } catch {
      next = new Map()
    }
    profileCwds = next
    composeFolders = answer?.ok === true && Array.isArray(answer.profiles)
      ? answer.profiles.filter(profile => next.has(profile?.id)).map(profile => ({ id: profile.id, name: profile.name }))
      : []
    if (composePanel?.isOpen?.()) composePanel.updateFolders(composeFolders)
    for (const listener of profileMapListeners) {
      try { listener() } catch { /* one retired chat cannot block the others */ }
    }
  }
  const startProfileId = value => typeof value === 'string' && value.trim() ? value : null
  function rememberBoundSessionProfile(sessionId, nodeId, profileId, store = treeStore) {
    sessionProfileIds.delete(sessionId)
    if (sessionNodeIds.get(sessionId) !== nodeId
        || !store || store.getNode(nodeId)?.sessionId !== sessionId) return
    if (startProfileId(profileId)) sessionProfileIds.set(sessionId, profileId)
    // Edit MOVE can finish while the host is opening this session. At that
    // point there was no bound session for the move to update. Reconcile from
    // the captured store now, including when navigation released this view.
    void syncTreeBranchAddresses(nodeId, store)
  }
  const sessionTurnText = new Map()
  const sessionTextReader = createSessionTextReader()
  unsubs.push(() => sessionTextReader.clear())
  const standaloneSettledTurns = new Map()
  const nodeReplies = new Map()
  /* The latest narration line per node ("Running a command: …"), cleared when
     the turn completes -- the reply takes over from there. */
  const nodeActivity = new Map()
  /* nodeActivity is deliberately ephemeral: mounted working rows must clear
     when a turn stops. The compact card still owes the owner one durable line
     saying what tool ran most recently, so that evidence has its own cache and
     is cleared only when the conversation itself is cleared, rewound, or
     removed. */
  const nodeLastTool = new Map()
  /* THE MODEL'S OWN WORKING, KEPT APART FROM WHAT IT DID (R1205). The engine
     forwards thinking as its own event type and sessionActivityEvent already
     reads it (kind: 'thinking'), but nothing on page 2 ever showed it: the
     card's slots were current/tool/previous/chat/unavailable/tasks/failRate/
     model, and activityLine() flattened a thinking event to the bare word
     "Thinking." in the tool slot -- a line that spends a row to say nothing a
     person can act on. The reasoning TEXT rides here instead, so the tool slot
     keeps naming the last real action while this says what the agent is
     working through right now. Cleared exactly where nodeLastTool is. */
  const nodeThinking = new Map()
  /* EVERY SURFACE WAITING ON THIS TURN, not the last one to ask.
   *
   * This was one callback per session, set unconditionally by whichever
   * surface sent. Since 5f394a4 gave the compact card the whole shared config,
   * BOTH the card and the rail's Chat tab can send -- so a second send
   * overwrote the first surface's callback, and that surface's pending bubble
   * was never answered by anything. The person watched a message they had
   * really sent sit unanswered while the reply appeared somewhere else (owner,
   * 2026-08-18: "the messages in history disappear or combine into each
   * other").
   *
   * A set, drained once when the turn completes. A surface that closed in the
   * meantime simply is not in it; the reply still lands on the chip, the store
   * and the transcript, because those are the record and a card is a window. */
  const turnReplies = new Map()
  function awaitTurnReply(sessionId, reply) {
    if (!sessionId || typeof reply !== 'function') return
    const waiting = turnReplies.get(sessionId) || new Set()
    waiting.add(reply)
    turnReplies.set(sessionId, waiting)
  }
  function dropTurnReply(sessionId, reply) {
    const waiting = turnReplies.get(sessionId)
    if (!waiting) return
    waiting.delete(reply)
    if (waiting.size === 0) turnReplies.delete(sessionId)
  }
  /* Taken and cleared in one step, so a reply handler that sends again cannot
     be answered by the turn it is answering. */
  function deliverTurnReply(sessionId, said, turnId = null) {
    broadcastChatSpeech(sessionId, said, { turnId, complete: true })
    const waiting = turnReplies.get(sessionId)
    if (!waiting) return
    turnReplies.delete(sessionId)
    for (const reply of waiting) {
      try { reply(said, { sessionId }) } catch { /* one broken surface must not starve the rest */ }
    }
  }
  /* THE CONVERSATION, kept in this window's memory and said to be exactly
     that. The STORE keeps one reply per node (the durable part); these maps
     keep the back-and-forth so the card and the rail can show a real history
     instead of opening empty over a node that has plainly spoken. Bounded per
     session; entries carry the turnId the engine returned so a rewind can one
     day point at "the message where I said …". */
  const TRANSCRIPT_MAX_ENTRIES = 60
  const sessionTranscripts = new Map()
  /* Metadata cards are node chronology, but they are not speech. Keeping them
     beside rather than inside sessionTranscripts prevents a file-heavy turn
     from consuming the conversation store's bounded speech/action excerpt. */
  const nodeDiffHistories = new Map()
  /* WHAT THE AGENT DID, kept beside what it said and for the same reason: a
     chat opened halfway through a turn must already show the work taken so
     far, and a chat that was never open must show it afterwards. One bounded
     buffer per session -- the caps live in createActionBuffer, and both of
     them are the kind a person can see. */
  const sessionActions = new Map()
  /* EVERY CHAT MOUNTED OVER THIS SESSION. The product mounts two surfaces from
     one config (the rail's Chat tab and the compact card on the canvas), and an
     action that reached only one of them would be exactly the drift the shared
     config exists to prevent. Roots are added by the config's onReady and
     dropped again the moment they leave the document -- a chat that has been
     closed must never be written to, and holding one is how a retired view is
     retained. */
  const chatSurfaces = new Map()
  const chatSurfaceSessions = new WeakMap()
  const chatSpeech = new WeakMap()
  const chatSpeechMounts = new WeakMap()
  const chatSpeechPending = new Set()
  let chatSpeechFrame = 0
  // A split workspace shares this one event/outbox owner. Its mounted chats
  // are views of that owner, never independent Computers page instances.
  const workspaceChats = new Set()
  const workspaceComposePanels = new Set()
  const workspacePendingStatus = new Map()
  let workspaceControls = null
  function closeWorkspaceControls() {
    if (!workspaceControls) return
    const held = workspaceControls
    workspaceControls = null
    if (held.parent) held.parent.insertBefore(held.target, held.next?.parentNode === held.parent ? held.next : null)
    held.dialog.removeEventListener('keydown', held.onKeydown)
    held.dialog.remove()
    held.opener?.isConnected && held.opener.focus?.({ preventScroll: true })
  }
  function showWorkspaceControls() {
    if (destroyed || workspaceControls) return
    // Full tree conversations hide the rail. Present its existing controls
    // without leaving the conversation or replacing its composer and stream.
    if (!chatWorkspace && !root.querySelector('.tree-workspace.is-chat-view')) return
    const dialog = document.createElement('section')
    dialog.className = 'home-workspace-controls-overlay'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'Conversation controls')
    const panel = document.createElement('div')
    panel.className = 'home-workspace-controls-dialog'
    const close = document.createElement('button')
    close.className = 'ctl-btn home-workspace-controls-close'
    close.type = 'button'
    close.textContent = 'Close controls'
    close.addEventListener('click', closeWorkspaceControls)
    const target = chatWorkspace ? root : controlsPage
    const parent = target.parentNode, next = target.nextSibling, opener = document.activeElement
    let content = target
    if (!chatWorkspace) {
      content = el('<div class="computers home-agent-workspace"><div class="comp-body"><aside class="rail glass"></aside></div></div>')
      content.querySelector('.rail').appendChild(target)
    }
    panel.append(close, content)
    dialog.appendChild(panel)
    // Keep Computers-owned controls inside their owner: shared refreshers query
    // root for mounted start controls. Home moves that owner into its overlay.
    const overlayParent = chatWorkspace ? document.body : root
    overlayParent.appendChild(dialog)
    const onKeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeWorkspaceControls(); return }
      if (event.key !== 'Tab') return
      const stops = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(node => !node.disabled && node.checkVisibility())
      if (!stops.length) return
      if (event.shiftKey && document.activeElement === stops[0]) { event.preventDefault(); stops.at(-1).focus() }
      else if (!event.shiftKey && document.activeElement === stops.at(-1)) { event.preventDefault(); stops[0].focus() }
    }
    dialog.addEventListener('keydown', onKeydown)
    workspaceControls = { dialog, target, parent, next, opener, onKeydown }
    close.focus()
  }
  function disposeWorkspaceChat(surface, { keepSlot = false } = {}) {
    surface.draft?.write?.(surface.root?.exportDraft?.({ handoff: true }))
    if (surface.sessionId) chatSurfaces.get(surface.sessionId)?.delete(surface.root)
    surface.root?.dispose?.()
    surface.root?.remove()
    surface.root = null
    if (!keepSlot) {
      if (surface.statusTimer) clearTimeout(surface.statusTimer)
      workspaceChats.delete(surface)
    }
  }
  function paintWorkspaceChat(surface, force = false) {
    if (destroyed || !workspaceChats.has(surface)) return
    const node = treeStore?.getNode(surface.nodeId)
    if (!node) {
      disposeWorkspaceChat(surface, { keepSlot: true })
      surface.host.textContent = treeStoreProblem || 'This conversation is no longer available on the selected computer.'
      return
    }
    if (!force && surface.root && surface.sessionId === node.sessionId) return
    const hadFocus = Boolean(surface.root?.contains(document.activeElement))
    disposeWorkspaceChat(surface, { keepSlot: true })
    const config = treeChatConfigFor(node)
    if (!config) return
    surface.sessionId = node.sessionId
    const chat = buildChat({ ...config, tall: true,
      actions: () => (config.actions?.() || []).map(action => action.id === 'queue'
        ? { ...action, run: ctx => { ctx.close(); surface.root?.querySelector('.chat-input input')?.focus() } } : action),
      chips: { ...config.chips, onOpenModel: () => surface.root?.openActions?.('model'), onOpenEffort: () => surface.root?.openActions?.('effort') },
      ...(typeof config.onSend === 'function' ? { onSend: (text, handlers) => config.onSend(text, {
        ...handlers, originSurface: surface,
      }) } : {}),
    })
    surface.root = chat
    surface.host.replaceChildren(chat)
    surface.status = document.createElement('p')
    surface.status.className = 'home-workspace-status'
    surface.status.setAttribute('role', 'status')
    surface.status.hidden = true
    chat.querySelector('.chat-composer-dock')?.prepend(surface.status)
    /* A SET AGENT THAT HAS NEVER STARTED CAN BE STARTED FROM ITS OWN WINDOW.
       Its window said only that it is not running; Start was reachable only
       inside Commands (T1352). The same start() the Commands row runs, with
       the reason it cannot start yet in place of the button's use when it
       cannot. */
    if (node.status === 'draft' && typeof surface.start === 'function') {
      const bar = document.createElement('div')
      bar.className = 'home-workspace-start'
      const reason = workspaceStartReason(node.id)
      const line = document.createElement('p')
      line.textContent = reason || START_PANEL.draftWindowStart
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ctl-btn'
      button.dataset.workspaceStart = ''
      button.textContent = START_PANEL.submitStart
      button.disabled = Boolean(reason)
      button.addEventListener('click', () => { if (!button.disabled) { button.disabled = true; void surface.start() } })
      bar.append(line, button)
      chat.querySelector('.chat-composer-dock')?.prepend(bar)
    }
    surface.outcome = workspacePendingStatus.get(node.id) || surface.outcome
    workspacePendingStatus.delete(node.id)
    if (surface.outcome) paintWorkspaceStatus(surface)
    if (node.sessionId) registerChatSurface(node.sessionId, chat)
    chat.importDraft?.(surface.draft?.read?.())
    /* One "Saved conversation" button for the whole Full view, in its own header
       (src/views/home.js data-chat-saved), never one per pane. */
    mountTranscriptHistory({ host: surface.host, store: transcriptStore, nodeId: node.id, chat, toggle: 'none' })
    if (hadFocus) chat.querySelector('.chat-input input')?.focus({ preventScroll: true })
    surface.onReady?.(surface)
  }
  function refreshWorkspaceChats(nodeId = null, force = false) {
    for (const surface of workspaceChats) if (!nodeId || surface.nodeId === nodeId) paintWorkspaceChat(surface, force)
  }
  /* Reads the entry it is given rather than two fields of it (T332). The
     caller already passes the whole sentEntry; this used to destructure `at`
     and `turnStamp` and drop the rest, so a second surface open on the same
     session was repainted with the picture missing. That is the seventh of the
     eight repaint paths and the one nobody had looked at. */
  function broadcastWorkspaceOwnerMessage(sessionId, origin, text, { at, turnStamp, pictures } = {}) {
    for (const surface of workspaceChats) if (surface !== origin && surface.sessionId === sessionId && surface.root?.isConnected) surface.root.addOwnerMessage?.(text, { at, turnStamp, pictures })
  }
  function paintWorkspaceStatus(surface) {
    if (!surface.status) return
    surface.status.textContent = surface.outcome?.text || ''
    surface.status.dataset.state = surface.outcome?.state || 'info'
    surface.status.hidden = !surface.outcome?.text
  }
  function setWorkspaceStatus(nodeId, text, state = 'info') {
    for (const surface of workspaceChats) {
      if (surface.nodeId !== nodeId) continue
      if (surface.statusTimer) clearTimeout(surface.statusTimer)
      surface.outcome = { text, state }
      paintWorkspaceStatus(surface)
      surface.statusTimer = text && state !== 'refuse' ? setTimeout(() => {
        surface.statusTimer = 0
        surface.outcome = null
        paintWorkspaceStatus(surface)
      }, 7000) : 0
    }
  }
  function workspaceStartReason(nodeId) {
    const node = treeStore?.getNode(nodeId)
    if (!node) return 'This conversation is no longer available.'
    if (node.status !== 'draft') return 'This agent has already started. Use its conversation controls to resume or start over.'
    return nodeStartReason(node) || composeUnavailableReason() || composeStartUnavailableReason()
  }
  function mountWorkspaceChat(host, { nodeId, draft = null, onReady = null } = {}) {
    const surface = { host, nodeId, draft, onReady, sessionId: null, root: null,
      dispose() { disposeWorkspaceChat(surface) },
      openDetails() { const node = treeStore?.getNode(nodeId); if (!node) return; showWorkspaceControls(); showTreeNodeControls(node); controlsPage.querySelector('[data-rail-tab="details"]')?.click() },
      openActions(stage) { surface.root?.openActions?.(stage) },
      canStart() { return !workspaceStartReason(nodeId) },
      startUnavailableReason() { return workspaceStartReason(nodeId) },
      async start() {
        const reason = workspaceStartReason(nodeId)
        if (reason) { setWorkspaceStatus(nodeId, reason, 'refuse'); return { ok: false, message: reason } }
        setWorkspaceStatus(nodeId, 'Starting this agent…', 'busy')
        const result = await startDraftNode(treeStore.getNode(nodeId))
        setWorkspaceStatus(nodeId, result?.ok ? 'Conversation started.' : result?.message || result?.reason || 'This agent could not start. Open its controls and try again.', result?.ok ? 'ok' : 'refuse')
        return result
      },
    }
    workspaceChats.add(surface)
    paintWorkspaceChat(surface)
    return surface
  }
  const sessionTurnLog = new Map()
  /* What the engine says the session has used, latest reading per session —
     the usage events crossed the wire from day one and were dropped here. */
  const sessionUsage = new Map()
  /* The model the person chose for the NEXT message, per session. Rides on
     every send until cleared; the engine accepts it per turn, so the
     conversation continues — this is a real switch, not a respawn. */
  const sessionModelOverride = new Map()
  // A selection is pending until the current turn settles. It never interrupts.
  const pendingModelChoices = new Map()
  function cancelPendingModelChoice(nodeId) {
    const removed = pendingModelChoices.delete(nodeId)
    if (removed) notifyNodeStatusListeners()
    return removed
  }
  function pendingModelChoice(node) {
    const pending = pendingModelChoices.get(node?.id)
    if (!pending) return null
    if (!pending.isCurrent()) { cancelPendingModelChoice(node.id); return null }
    return pending
  }
  function queueModelChoice(node, tierId, out, apply, { drainAfter = false, label = null } = {}) {
    const store = treeStore
    const identity = { sessionId: node.sessionId, treeId: node.treeId, createdAt: node.createdAt }
    const pending = { tierId, label, applying: false, apply, drainAfter,
      isCurrent: () => !destroyed && treeStore === store
        && pendingModelChoices.get(node.id) === pending
        && Object.keys(identity).every(key => (pending.continuing && key === 'sessionId') || store?.getNode(node.id)?.[key] === identity[key]),
      beginContinuation: () => {
        if (!pending.isCurrent()) return () => false
        // Coordinator now owns session/revision checks across its successor attachment.
        // This token continues to fence the choice, node lifetime and placement.
        pending.continuing = true
        return pending.isCurrent
      } }
    pendingModelChoices.set(node.id, pending)
    if (out) out.textContent = `Pending: ${label || LAUNCH_TIERS.find(row => row.id === tierId)?.label || tierId}. The current turn will finish first.`
    notifyNodeStatusListeners()
    return true
  }
  const pendingModelDrainHolds = new Set()
  function pendingModelDrainBlocked(nodeId, sessionId, allowDrain = false) {
    const current = treeStore?.getNode(nodeId)
    if (destroyed || !current || current.sessionId !== sessionId || nodeBusy(current)) return true
    const provider = LAUNCH_TIERS.find(row => row.id === current.tier)?.provider
    const role = roleRecordFor(identityRoleForTreeNode(current.role))
    const seat = orgAvailability.org?.agents?.find(row => row.id === nodeId) || rootSeatFor(role)
    if (!allowDrain || !provider || !seat?.enabled || seat.provider !== provider) {
      pendingModelDrainHolds.add(sessionId)
      if (outboxList(sessionId).length) treeStore.setNodeStatus(nodeId, current.status, {
        note: 'Queued messages are held until the model change and this session’s delivery state can be reconciled.',
      })
      return true
    }
    pendingModelDrainHolds.delete(sessionId)
    return false
  }
  async function applyPendingModelChoice(nodeId, sessionId) {
    const node = treeStore?.getNode(nodeId)
    const pending = pendingModelChoice(node)
    if (!pending) return pendingModelDrainHolds.has(sessionId) ? pendingModelDrainBlocked(nodeId, sessionId) : false
    if (node.sessionId !== sessionId) return false
    if (pending.applying || nodeBusy(node)) return true
    pending.applying = true
    try {
      const applied = await pending.apply(node, pending.isCurrent, pending.beginContinuation)
      if (pending.isCurrent()) {
        if (applied !== true && nodeBusy(treeStore.getNode(nodeId))) {
          pending.applying = false
          return true
        }
        cancelPendingModelChoice(nodeId)
        if (applied === true && pending.drainAfter) return pendingModelDrainBlocked(nodeId, sessionId, true)
      }
    } catch (error) {
      if (pending.isCurrent()) {
        cancelPendingModelChoice(nodeId)
        setOrgStatus(error?.message || 'The pending model change could not be applied.', 'refuse', { sticky: true })
      }
    } finally {
      if (pendingModelChoices.get(nodeId) === pending && !pending.isCurrent()) cancelPendingModelChoice(nodeId)
      const latest = pendingModelChoice(treeStore?.getNode(nodeId))
      if (latest && latest !== pending && !nodeBusy(treeStore?.getNode(nodeId))) {
        return await applyPendingModelChoice(nodeId, sessionId)
      }
    }
    return pendingModelDrainBlocked(nodeId, sessionId)
  }
  const providerModeListeners = new Set()
  unsubs.push(() => {
    for (const entry of [...providerModeListeners]) entry.dispose()
    providerModeListeners.clear()
  })
  function publishProviderModeEvent(packet) {
    for (const entry of [...providerModeListeners]) {
      if (!entry.isCurrent()) { entry.dispose(); providerModeListeners.delete(entry); continue }
      entry.listener(packet)
    }
  }
  /* Images picked for the next card send, per session — issued paths only
     (the shell refuses anything the picker did not hand out). */
  const sessionPendingImages = new Map()
  /* What each session started with: the reasoning depth it was bound to at
     spawn (the effort switch shows this as "current"), and the thread name
     the engine reported (saved with the durable transcript so a real
     engine-side resume is possible one day without a data gap). */
  const sessionEfforts = new Map()
  const sessionThreadIds = new Map()
  /* The provider account that OWNS each live thread. Rotation may choose a
     different account for a new conversation; a resumed conversation must
     return to this one because provider thread storage is per account home. */
  const sessionAccountNames = new Map()

  /* THE TURN EACH SESSION'S OPEN BUBBLE AND ACCUMULATOR BELONG TO. Absent
     means nothing is in flight; an engine that does not name its turns leaves
     it absent forever and behaves exactly as it did before. */
  const sessionOpenTurns = new Map()

  /* THE LAST TURN THIS SESSION'S turn_completed ALREADY SETTLED.
   *
   * A turn whose first event is already its last (an empty completion) can
   * be painted terminal by the event-stream channel before bridge.send()'s
   * own acknowledgement crosses back over its separate IPC round trip. Left
   * unguarded, that acknowledgement's .then() marks the node running again,
   * unconditionally, over a terminal status this session's turn_completed
   * handler already wrote, with nothing left to clear it.
   *
   * Recorded by the turn_completed handler for the exact id it just settled;
   * read by treeCardSend to skip the optimistic 'running' write for that
   * same id only -- a different (newer) turn's own id was never recorded,
   * so its ordinary mark is untouched. */
  const sessionCompletedTurnIds = new Map()

  /* Both Stop doors share one per-turn request. Completion can cross the
     event bridge before the interrupt reply crosses IPC; it waits for that
     reply before deciding whether to report failure or drain queued work. */
  const turnInterrupts = createTurnInterrupts()

  /* THE QUESTION AN AGENT IS STILL WAITING ON. sessionId -> the approval
     activity, exactly as the event carried it. MEASURED on the shipped 1.0.20:
     a child called agent_comms.send_local, approval_request fired while the
     person was looking at the tree rather than at that node's rail, and the
     card render below was gated on the rail being open -- so the one event
     that could paint the Approve button passed unrendered, nothing re-read the
     request on a later rail open, and the session sat blocked until
     interrupted. "It stops and asks you" had stopped and asked nobody. The
     event is remembered here, rendered whenever that node's rail opens, and
     forgotten when it is answered or its turn ends. */
  const sessionPendingApprovals = createPendingApprovals()
  const confirmedRefusals = new Map()
  /* THE WORDS AN AGENT IS FILING AS A RULE, per session, keyed by the call
     that carries them. The engine's result says WHICH rule was filed and by
     whom; only the call carried the person's words, so the two are paired
     here by toolCallId -- the same join the action rows use -- and the row
     the chat shows quotes the remark that became a rule. Bounded: a session
     cannot hold more than a handful of filings in flight, and the oldest
     leave first. */
  const sessionRuleCalls = new Map()
  const RULE_CALLS_MAX = 16
  function rememberRuleCall(sessionId, call) {
    if (!call || !call.toolCallId) return
    let held = sessionRuleCalls.get(sessionId)
    if (!held) { held = new Map(); sessionRuleCalls.set(sessionId, held) }
    held.set(call.toolCallId, call.words)
    while (held.size > RULE_CALLS_MAX) held.delete(held.keys().next().value)
  }
  function takeRuleCall(sessionId, toolCallId) {
    const held = sessionRuleCalls.get(sessionId)
    if (!held || !toolCallId || !held.has(toolCallId)) return ''
    const words = held.get(toolCallId)
    held.delete(toolCallId)
    return words
  }

  /* Retire only runtime routing for a session the host proved dead. Durable
     transcript, node/session evidence, diffs, and queued messages stay: Resume
     moves those to the next real process. Safe to call more than once so an
     event racing a send refusal cannot revive or double-retire anything. */
  function retireTreeSessionRuntime(sessionId) {
    sessionTextReader.clear(sessionId)
    standaloneSettledTurns.delete(sessionId)
    const nodeId = sessionNodeIds.get(sessionId) || null
    sessionTurnText.delete(sessionId)
    sessionOpenTurns.delete(sessionId)
    sessionCompletedTurnIds.delete(sessionId)
    // A retired session has no turn left to reconcile.
    nativeReconcileSessions.delete(sessionId)
    sessionActions.get(sessionId)?.resetMetrics()
    sessionActions.delete(sessionId)
    sessionRuleCalls.delete(sessionId)
    sessionPendingImages.delete(sessionId)
    confirmedRefusals.delete(sessionId)
    clearSessionApprovals(sessionId)
    sessionUsage.delete(sessionId)
    sessionModelOverride.delete(sessionId)
    turnInterrupts.forget(sessionId)
    turnReplies.delete(sessionId)
    if (nodeId && treeStore?.getNode(nodeId)?.sessionId === sessionId) nodeActivity.delete(nodeId)
    sessionNodeIds.delete(sessionId)
    remoteAppliedSequences.delete(sessionId)
    sessionProfileIds.delete(sessionId)
    sessionEfforts.delete(sessionId)
    sessionThreadIds.delete(sessionId)
    sessionAccountNames.delete(sessionId)
    notifyNodeStatusListeners()
    return nodeId
  }

  /* A confirmed close can precede the provider's last completion packet.
     Keep the partial reply already observed, settle its visible stream, then
     retire routing so that late packets cannot revive the stopped session. */
  function settleStoppedSession(sessionId) {
    const nodeId = sessionNodeIds.get(sessionId)
    if (!nodeId) return
    const node = treeStore?.getNode(nodeId)
    const wasBusy = node?.status === 'starting' || node?.status === 'running'
    if (wasBusy) {
      let turnId = sessionOpenTurns.get(sessionId) || null
      if (!turnId) {
        /* A send can be accepted before its first text/tool event. The last
           unanswered owner line carries that receipt's real turn id. Require
           this session's acceptance log too: restored history and a previous
           completed reply cannot name the turn being stopped. */
        const lastSpeech = (sessionTranscripts.get(sessionId) || []).findLast(entry => entry.who === 'you' || entry.who === 'agent')
        if (lastSpeech?.who === 'you' && typeof lastSpeech.turnStamp === 'string' && lastSpeech.turnStamp
            && (sessionTurnLog.get(sessionId) || []).some(turn => turn.turnId === lastSpeech.turnStamp)) {
          turnId = lastSpeech.turnStamp
        }
      }
      const said = turnCompletionWords({ spoken: sessionTurnText.get(sessionId) || '', userStopped: true })
      recordTurnActions(sessionId)
      transcriptAppend(sessionId, { who: 'agent', text: said, at: Date.now(), turnStamp: turnId })
      nodeReplies.set(nodeId, said)
      treeStore?.setNodeReply(nodeId, said)
      /* A confirmed busy close still has an outcome when no turn id arrived.
         Begin its stream explicitly so a previous closed bubble cannot absorb
         it. The missing badge stays missing; retirement below makes this
         close once-only, including late provider completions. */
      if (!turnId) broadcastChatSpeech(sessionId, '', { complete: false })
      deliverTurnReply(sessionId, said, turnId)
      if (railChat?.sessionId === sessionId && railChat.stream) {
        railChat.stream.close(said)
        railChat.stream = null
      }
    }
    // Retirement settles every pending approval and its visible card once.
    retireTreeSessionRuntime(sessionId)
    // Manual close has no host session_ended packet. Retained bounded panels
    // still re-read their exact signed closing receipts before retiring Stop.
    for (const listener of RUN_NATIVE_WORK_CLOSE_LISTENERS) listener(sessionId)
  }

  /* A turn that was never formally completed still SAID something, and those
     words are the record. Called when a delta arrives naming a different turn
     than the one still open: the previous answer is filed, its bubble is
     ended, and every surface waiting on it is answered -- then the accumulator
     is cleared so the new turn starts from nothing. */
  function settleTurnBoundary(sessionId, turnId) {
    if (!turnId) return
    const open = sessionOpenTurns.get(sessionId)
    sessionOpenTurns.set(sessionId, turnId)
    /* A TURN ID THIS VIEW HAS NOT SEEN IS A TURN BEGINNING, WHOEVER STARTED IT.
       The composer and the outbox mark a node running before their own send,
       but the tree courier starts turns from the shell (agent-host.cjs
       pumpTreeSessionOnce -> sendTurn, origin 'agent') and nothing here ever
       marked those. MEASURED 2026-09-04 on the Live tier: two managers ran
       merges, judge builds and spawns for ten minutes while their circles read
       "finished", and the owner read the whole tree as idle. The engine names
       every turn on its first event, so this is the one seam every turn
       crosses; it is marked here, before the early return below, because the
       FIRST turn of a session arrives with nothing open. */
    if (open !== turnId) markTurnRunning(sessionId)
    if (!open || open === turnId) return
    /* Live counters belong only to the turn being left. The new active turn is
       already installed above, and the old truth is cleared before listeners
       are allowed to read it again. */
    sessionActions.get(sessionId)?.clearMetrics(open)
    const spoken = (sessionTurnText.get(sessionId) || '').trim()
    sessionTurnText.delete(sessionId)
    /* The work before the words, because that is the order it happened in. */
    recordTurnActions(sessionId)
    if (spoken) {
      const nodeId = sessionNodeIds.get(sessionId)
      if (nodeId) nodeReplies.set(nodeId, spoken)
      /* `open` IS THE TURN THAT JUST ENDED -- the id this function was called
         to settle, captured above before this turn's slot took the next one. */
      transcriptAppend(sessionId, { who: 'agent', text: spoken, at: Date.now(), turnStamp: open })
      deliverTurnReply(sessionId, spoken, open)
    }
    if (railChat && railChat.sessionId === sessionId && railChat.stream) {
      railChat.stream.close(spoken || null)
      railChat.stream = null
    }
    notifyNodeStatusListeners()
  }

  /* THE NODE IS BUSY BECAUSE THE ENGINE SAYS SO. Only a node that is not
     already busy is touched: a person-sent turn marked itself before the send
     and may carry a note this must not erase, and a 'starting' node is on its
     brief turn, which its completion settles. The store refuses 'running' for a
     node with no session, and that refusal is left to stand -- a session this
     listener heard from is attached (sessionNodeIds), so the refusal would be
     the evidence of a routing defect, not something to paper over. Repaint in
     place, never a rail rebuild: see repaintRailStatus. */
  function markTurnRunning(sessionId) {
    if (!treeStore) return
    const nodeId = sessionNodeIds.get(sessionId)
    const node = nodeId ? treeStore.getNode(nodeId) : null
    if (!node || node.status === 'starting' || node.status === 'running') return
    const marked = treeStore.setNodeStatus(nodeId, 'running', { note: '' })
    if (!marked || (marked.ok === false && marked.runtimeUpdated !== true)) return
    refreshTree()
    if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
      repaintRailStatus({ ...currentRailTreeNode, status: 'running' })
    }
  }

  /* Put the node's durable metadata cards back among the ordinary chronology
     without changing the order of the ordinary rows. Every stored entry keeps
     its own finite receipt time from the real event; an invalid/missing time
     goes last and is never replaced with this window's clock. */
  function diffHistoryForNode(nodeId) {
    if (!nodeId) return []
    if (!nodeDiffHistories.has(nodeId)) {
      nodeDiffHistories.set(nodeId, diffHistoryStore ? diffHistoryStore.get(nodeId) : [])
    }
    return nodeDiffHistories.get(nodeId) || []
  }

  function restoreDiffHistory(nodeId, history) {
    const restored = diffHistoryForNode(nodeId)
    const merged = Array.isArray(history) ? history.slice() : []
    for (const entry of restored) {
      const identity = typeof entry.id === 'string' && entry.id.trim() ? entry.id : ''
      const existing = identity
        ? merged.findIndex(held => held && held.who === 'diff' && held.id === identity)
        : -1
      if (existing >= 0) {
        merged[existing] = entry
        continue
      }
      const at = Number.isFinite(entry.at) ? entry.at : null
      const before = at === null
        ? -1
        : merged.findIndex(held => held && Number.isFinite(held.at) && held.at > at)
      if (before >= 0) merged.splice(before, 0, entry)
      else merged.push(entry)
    }
    return merged
  }

  function transcriptAppend(sessionId, entry, { persist = true } = {}) {
    if (!sessionId) return
    /* WINDOW MEMORY AND THE DURABLE RECORD ARE ONE HISTORY, AND UNTIL NOW THEY
     * WERE TWO.
     *
     * THE DEFECT, measured 2026-08-18. treeChatConfigFor reads the record only
     * `if (!history.length)` and deliberately never seeds this map -- reading
     * is reading. But nothing seeded it on the WRITE side either, so the FIRST
     * line appended for a session this window had not held became the whole of
     * `history`, and a five-line saved record was shadowed for the life of the
     * view. That is the owner's screenshot: a panel showing one YOU bubble over
     * a conversation that really happened.
     *
     * So the seed happens HERE, once, before the first append -- which is
     * exactly the moment the map stops being empty and starts standing in for
     * the record. `has`, not `get().length`: a session deliberately set to an
     * empty history (a plain start) has already been decided about, and
     * re-seeding it would resurrect a conversation somebody chose to leave. */
    if (!sessionTranscripts.has(sessionId)) {
      const seedNodeId = sessionNodeIds.get(sessionId)
      const saved = seedNodeId && transcriptStore ? transcriptStore.get(seedNodeId) : null
      sessionTranscripts.set(sessionId, saved && Array.isArray(saved.lines) ? saved.lines.slice() : [])
    }
    const held = sessionTranscripts.get(sessionId) || []
    // A confirmed Halt can file its partial reply before the provider sends
    // completion. Refine that one row in place when its final event arrives.
    const settled = standaloneSettledTurns.get(sessionId)
    let replacing = entry.who === 'agent' && settled && (entry.turnStamp || null) === settled.turnId
      ? held.findIndex(line => line.id === settled.id) : -1
    if (replacing >= 0) { entry.id = settled.id; standaloneSettledTurns.delete(sessionId) }
    entry.id ||= ((entry.who === 'agent' || entry.who === 'you') && entry.turnStamp ? `${entry.who}:${sessionId}:${entry.turnStamp}` : globalThis.crypto.randomUUID())
    if (replacing < 0 && (entry.who === 'agent' || entry.who === 'action')) replacing = held.findIndex(line => line.id === entry.id)
    const captureNodeId = sessionNodeIds.get(sessionId)
    if (captureNodeId && transcriptStore?.bind) void transcriptStore.bind(sessionId, captureNodeId)
    if (captureNodeId && transcriptStore?.capture) void transcriptStore.capture(captureNodeId, entry)
    if (replacing >= 0) held[replacing] = entry
    else held.push(entry)
    if (held.length > TRANSCRIPT_MAX_ENTRIES) held.splice(0, held.length - TRANSCRIPT_MAX_ENTRIES)
    sessionTranscripts.set(sessionId, held)
    /* A batch of appends persists ONCE, at its end. Writing the whole record to
       storage per line was fine at one line per turn and is not fine now that a
       turn can also file the dozen things the agent did. */
    if (persist) persistTranscript(sessionId)
  }

  /* ---- WHAT THE AGENT DID: BUFFER, SURFACES, RECORD ----
   *
   * THE DEFECT (owner, item 1). The engine narrates every turn -- tool_call,
   * tool_result, approval_request, each with the command or the path, the exit
   * code, and the name that pairs a result with its call -- and every one of
   * those packets already reached this view. The activity branch below turned
   * them into ONE overwritten status line and a chip, and deleted that on
   * completion. Nothing reached the chat, the record, or any list. A turn that
   * spent five minutes running commands put zero rows in front of a person.
   *
   * These three functions are the missing half, and they are deliberately the
   * same shape the words already have: buffer it, tell both open surfaces, and
   * record it with the conversation. */
  function actionBufferFor(sessionId) {
    let buffer = sessionActions.get(sessionId)
    if (!buffer) {
      buffer = createActionBuffer()
      sessionActions.set(sessionId, buffer)
    }
    return buffer
  }

  function sameMetricSnapshot(left, right) {
    return ['tools', 'files', 'added', 'removed'].every(key => left?.[key] === right?.[key])
  }

  function resetSessionMetrics(sessionId) {
    RUN_NODE_REMOVAL_CLOSE_RECEIPTS.delete(sessionId)
    if (!sessionId) return
    sessionActions.get(sessionId)?.resetMetrics()
    sessionOpenTurns.delete(sessionId)
    sessionCompletedTurnIds.delete(sessionId)
    /* A reset is itself observable provider state. Do not rely on a later graph
       repaint: removal can be refused after its session was closed, and a view
       can own mounted chats before graph geometry exists. */
    notifyNodeStatusListeners()
  }

  function unregisterChatSurface(root) {
    const sessionId = chatSurfaceSessions.get(root)
    const held = chatSurfaces.get(sessionId)
    held?.delete(root)
    if (held?.size === 0) chatSurfaces.delete(sessionId)
    chatSurfaceSessions.delete(root)
    chatSpeechMounts.delete(root)
    chatSpeech.get(root)?.stream.close(null)
    chatSpeech.delete(root)
  }
  function registerChatSurface(sessionId, root) {
    if (!root) return
    const previous = chatSurfaceSessions.get(root)
    if (previous === sessionId) return
    if (previous) unregisterChatSurface(root)
    if (!sessionId) return
    chatSurfaceSessions.set(root, sessionId)
    const held = chatSurfaces.get(sessionId) || new Set()
    held.add(root)
    chatSurfaces.set(sessionId, held)
    const pending = sessionPendingApprovals.get(sessionId)
    if (pending) pushInlineApproval(sessionId, pending)
    // onReady runs before openStream exists and before the caller inserts the
    // chat. Keep events from that short gap in this same stream owner: history
    // was already painted, so a completion here must not be silently dropped.
    const mounting = { events: [] }
    chatSpeechMounts.set(root, mounting)
    if (sessionTurnText.has(sessionId)) mounting.events.push({
      text: sessionTurnText.get(sessionId), turnId: sessionOpenTurns.get(sessionId) || null, complete: false,
      entryId: standaloneSettledTurns.get(sessionId)?.id || null,
    })
    queueMicrotask(() => {
      if (chatSpeechMounts.get(root) !== mounting) return
      chatSpeechMounts.delete(root)
      if (destroyed || !root.isConnected) { unregisterChatSurface(root); return }
      for (const event of mounting.events) {
        broadcastChatSpeech(sessionId, event.text, { ...event, onlyRoot: root })
      }
    })
  }
  function broadcastChatSpeech(sessionId, text, { turnId = null, complete = false, onlyRoot = null, entryId = null, provisional = false } = {}) {
    const settled = standaloneSettledTurns.get(sessionId)
    if (settled && (!turnId || settled.turnId === turnId)) {
      entryId ||= settled.id
      // Halt filed this partial already, but did not fabricate a terminal
      // provider event. Keep the row refinable until that event really lands.
      provisional = complete
    }
    if (!entryId && turnId && nativeReconcileSessions.has(sessionId)) entryId = `agent:${sessionId}:${turnId}`
    const surfaces = chatSurfaces.get(sessionId)
    if (!surfaces) return
    for (const chat of onlyRoot ? [onlyRoot] : [...surfaces]) {
      if (chat === railChat?.root) continue
      const mounting = chatSpeechMounts.get(chat)
      if (mounting) {
        const event = { text, turnId, complete, entryId, provisional }, previous = mounting.events.at(-1)
        // Deltas already contain the accumulated text; only turn boundaries
        // and completions need distinct entries during this one microtask.
        if (previous && previous.turnId === turnId && (!previous.complete || previous.provisional)) {
          event.entryId ||= previous.entryId
          mounting.events[mounting.events.length - 1] = event
        }
        else mounting.events.push(event)
        continue
      }
      if (!chat.isConnected) { unregisterChatSurface(chat); continue }
      if (typeof chat.openStream !== 'function') continue
      let held = chatSpeech.get(chat)
      if (!held || (turnId && held.turnId !== turnId) || (!turnId && held.complete && !complete)) {
        held?.stream.close(null)
        held = { turnId, complete: false, stream: chat.openStream({ at: Date.now(), turnStamp: turnId, ...(entryId ? { entryId } : {}) }) }
        chatSpeech.set(chat, held)
      }
      if (complete) {
        held.stream.close(text, { provisional })
        held.complete = !provisional
      } else held.stream.push(text)
    }
    if (!surfaces.size) chatSurfaces.delete(sessionId)
  }
  function scheduleChatSpeech(sessionId) {
    chatSpeechPending.add(sessionId)
    if (chatSpeechFrame) return
    chatSpeechFrame = requestAnimationFrame(() => {
      chatSpeechFrame = 0
      const sessions = [...chatSpeechPending]
      chatSpeechPending.clear()
      if (destroyed) return
      for (const id of sessions) {
        if (sessionTurnText.has(id)) broadcastChatSpeech(id, sessionTurnText.get(id), { turnId: sessionOpenTurns.get(id) || null })
      }
    })
  }

  /* TELL EVERY CHAT THAT IS STILL ON SCREEN, and forget the ones that are not.
     `isConnected` is the test rather than a close callback: a card collapses,
     a rail rebuilds and a view is destroyed by three different mechanisms, and
     a set that only ever grows would hold a detached chat -- and the whole tree
     behind it -- for the life of the page. */
  function broadcastAction(sessionId, chatRow) {
    const held = chatSurfaces.get(sessionId)
    if (!held) return
    for (const root of [...held]) {
      if (!root.isConnected && !chatSpeechMounts.has(root)) { held.delete(root); continue }
      try { root.addAction?.(chatRow) } catch { /* one broken surface must not starve the rest */ }
    }
    if (held.size === 0) chatSurfaces.delete(sessionId)
  }

  /* QUEUED OWNER WORDS REACH EVERY OPEN VIEW AT THE ACCEPTANCE EDGE.
     A waiting message has no chat bubble yet. Once bridge.send accepts it,
     both the compact card and the rail gain the same line, and a detached
     surface is retired by the same liveness rule used for action rows. */
  function broadcastOwnerMessage(sessionId, text, { at, turnStamp = null } = {}) {
    const held = chatSurfaces.get(sessionId)
    if (!held) return
    for (const root of [...held]) {
      if (!root.isConnected && !chatSpeechMounts.has(root)) { held.delete(root); continue }
      try { root.addOwnerMessage?.(text, { at, turnStamp }) } catch { /* one broken surface must not starve the rest */ }
    }
    if (held.size === 0) chatSurfaces.delete(sessionId)
  }

  /* A MESSAGE SENT TO THIS WINDOW'S SESSION FROM A SIGNED-IN BROWSER.
     The computer accepted it as the person's turn and says so with a
     person_turn event (via 'remote') before the turn's first reply packet, so
     appending here keeps the message above its answer. It is the person's own
     line on every mounted chat, exactly once: a line already carrying the same
     turn id, such as this window's own send, is not painted again. The shell
     records the same words in the saved transcript, so a reload agrees. */
  function acceptRemotePersonTurn(sessionId, packet) {
    const person = sessionPersonTurn(packet, sessionId)
    if (!person || person.via !== 'remote') return
    const { text, turnId, at } = person
    const nodeId = sessionNodeIds.get(sessionId)
    if (!nodeId || (treeStore && !treeStore.getNode(nodeId))) return
    if (turnId) {
      const lineId = `you:${sessionId}:${turnId}`
      const lines = sessionTranscripts.get(sessionId) || transcriptStore?.get?.(nodeId)?.lines || []
      if (lines.some(line => line && line.who === 'you' && (line.id === lineId || line.turnStamp === turnId))) return
      /* Settle any turn still open before this one begins, so its reply is
         filed above this message rather than below it. */
      settleTurnBoundary(sessionId, turnId)
    }
    const when = Number.isSafeInteger(at) ? at : Date.now()
    transcriptAppend(sessionId, { who: 'you', text, at: when, ...(turnId ? { turnStamp: turnId } : {}) })
    broadcastOwnerMessage(sessionId, text, { at: when, turnStamp: turnId })
    turnLogAppend(sessionId, turnId, text)
    if (treeStore) {
      treeStore.setNodeStatus(nodeId, 'running', { note: '' })
      refreshTree()
    }
    if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
      repaintRailStatus({ ...currentRailTreeNode, status: 'running' })
    }
  }

  /* ONE REAL FILE-CHANGE EVENT, TWO TRANSPORTS. Mounted chats receive the live
     batch; the node chronology receives the history discriminator. Both carry
     the very same normalized activity.fileChanges array and neither parses the
     ordinary action detail. A textual id replaces in place; an absent one is a
     new event every time. */
  function recordFileChanges(sessionId, activity, at) {
    if (!activity || !Array.isArray(activity.fileChanges) || activity.fileChanges.length === 0) return
    const surfaces = chatSurfaces.get(sessionId)
    if (surfaces) {
      for (const root of [...surfaces]) {
        if (!root.isConnected && !chatSpeechMounts.has(root)) { surfaces.delete(root); continue }
        try {
          root.addDiff?.({
            source: 'session-file-change',
            id: activity.changeId || activity.toolCallId,
            at,
            files: activity.fileChanges,
            patches: activity.filePatches,
            limited: activity.fileChangesLimited,
            activeIndex: 0,
          })
        } catch { /* one broken surface must not starve the record or its twin */ }
      }
      if (surfaces.size === 0) chatSurfaces.delete(sessionId)
    }

    const entry = {
      who: 'diff',
      source: 'session-file-change',
      id: activity.changeId || activity.toolCallId,
      at,
      files: activity.fileChanges,
      patches: activity.filePatches,
      limited: activity.fileChangesLimited,
      activeIndex: 0,
    }
    const nodeId = sessionNodeIds.get(sessionId)
    if (!nodeId) return
    const history = diffHistoryForNode(nodeId)
    const identity = typeof entry.id === 'string' && entry.id.trim() ? entry.id : ''
    const existing = identity
      ? history.findIndex(held => held && held.who === 'diff' && held.id === identity)
      : -1
    if (existing >= 0) history[existing] = entry
    else history.push(entry)
    if (history.length > TRANSCRIPT_MAX_ENTRIES) {
      history.splice(0, history.length - TRANSCRIPT_MAX_ENTRIES)
      if (history[0]) history[0].limited = true
    }
    const retained = boundedStoredChatDiffEntries(history)
    nodeDiffHistories.set(nodeId, retained)
    diffHistoryStore?.save(nodeId, retained)
  }

  /* THE RECORD, WRITTEN ONCE PER TURN RATHER THAN ONCE PER EVENT. A busy turn
     emits thousands of tool events and each one used to be a whole-record write
     away from the durable store; the newest handful are filed when the turn
     ends, which is the same moment the agent's words are filed. Rows already
     written are marked, so a second turn never re-files the first turn's work
     out of order. */
  function recordTurnActions(sessionId) {
    const buffer = sessionActions.get(sessionId)
    if (!buffer) return
    /* THE BOOKS ARE CLOSED BEFORE THEY ARE FILED, and the order is the whole
       point: the record below takes `row.state` verbatim, so a row settled
       after filing would read correctly on screen and wrongly for ever in the
       saved conversation. Every surface already showing the row is told too --
       otherwise the chat a person is looking at keeps the word "running" until
       something unrelated happens to repaint it. See settleUnfinished() in
       src/agent-session-events.js for why the settled outcome is `unknown`
       rather than the convenient "finished". */
    for (const settled of buffer.settleUnfinished()) broadcastAction(sessionId, actionChatRow(settled))
    const fresh = buffer.list().filter(row => !row.recorded)
    if (fresh.length === 0) return
    for (const row of fresh) row.recorded = true
    for (const row of fresh.slice(-TRANSCRIPT_LIMITS.maxActionLines)) {
      /* THE TOOL'S NAME IN ITS OWN SLOT, not folded into the text. Joined into
         one string, a restored row painted with an EMPTY tool chip and the
         whole sentence in the detail -- the same row, two different looks,
         which is the defect items 2 and 4 describe reappearing on the
         restore path. Measured on a staged build before this line changed:
         live rows read Command / "npm test", restored rows read "" /
         "Command npm test". */
      persistActionRow(sessionId, row)
    }
    persistTranscript(sessionId)
  }

  function persistActionRow(sessionId, row) {
    const chatRow = actionChatRow(row)
    // The late approval acknowledgment refines this same entry on disk.
    row.transcriptId ||= globalThis.crypto.randomUUID()
    transcriptAppend(sessionId, { id: row.transcriptId, who: 'action',
      text: chatRow.detail || chatRow.tool, tool: chatRow.tool, at: chatRow.at,
      kind: row.kind, state: row.state, ...actionTimingFields(chatRow),
      ...(row.kind === 'thinking' ? { body: chatRow.body, truncated: chatRow.truncated === true } : {}),
    }, { persist: false })
    row.recorded = true
  }

  /* One action line as the record kept it, back in the shape a chat draws. */
  /* A REPLAYED ROW FROM A SESSION THAT IS GONE IS NOT STILL RUNNING (T1495).
     A turn that ended without a completion -- the app quit, crashed, or the
     computer powered off -- leaves its last call saved as 'working' and its
     approval as 'waiting', because only a live turn-end settles them (see
     settleUnfinished in src/agent-session-events.js). Replayed under "this
     session is no longer open", those rows spun and asked "waiting for you"
     forever, with nothing able to answer. When the session is not open the
     replay says what is known: no result came back, and the approval is no
     longer waiting. A live session's rows are drawn as saved. */
  function savedActionRow(entry, index, { settled = false } = {}) {
    if (settled && (entry.state === 'working' || entry.state === 'waiting')) {
      entry = { ...entry, state: entry.state === 'working' ? 'unknown' : 'closed' }
    }
    const thinking = entry.kind === 'thinking' || (!entry.kind && entry.tool === 'Thinking')
    const summary = thinking && typeof entry.body === 'string' ? entry.body : ''
    return {
      who: 'action',
      id: entry.id || `saved:${index}:${entry.at || 0}`,
      kind: thinking ? 'thinking' : entry.kind,
      tool: typeof entry.tool === 'string' ? entry.tool : '',
      detail: thinking ? (summary ? '' : THINKING_UNAVAILABLE_NOTICE) : (typeof entry.text === 'string' ? entry.text : ''),
      state: thinking && !summary ? '' : actionRowWords(entry).state,
      stateKey: typeof entry.state === 'string' ? entry.state : '',
      body: summary,
      ...(thinking ? { truncated: entry.truncated === true } : {}),
      at: entry.at,
      ...actionTimingFields(entry),
    }
  }

  /* THE CONVERSATION AND THE WORK, IN ONE LIST, IN THE ORDER THEY HAPPENED.
   *
   * A chat opened mid-turn has to show both halves: the record's own lines
   * (what was said, and the actions of turns that have finished) and the
   * actions of the turn still running, which have not been filed yet.
   *
   * THEY ARE NOT SORTED, AND THAT IS THE POINT. The record's order IS the
   * order things happened -- it was appended one line at a time -- and a sort
   * would need a timestamp on every line, which the brief-and-latest-reply
   * fallback does not have. What is still in flight is by definition the
   * newest, so it goes on the end. The two halves cannot double up either:
   * a buffered row is marked the moment it is filed, and only unfiled rows
   * are added here. */
  /* THE TREE'S OWN WORDS, NAMED AS SUCH BEFORE THEY ARE DRAWN. The address
     block is recorded `who: 'you'` because that is the side it was sent from
     (see onSessionOpen), and both chat surfaces therefore painted it as a
     second dark YOU bubble — three hundred pixels of plumbing wearing the
     person's colour, the loudest thing in the conversation (measured on a
     staged packaged build, 2026-08-20). It is recognised here by the same
     contract line shell/agent-host.cjs reads the address back out of —
     readTreeAddress, exported for exactly this kind of caller — never by
     guessing at prose. The record is untouched; only the drawing changes. */
  /* `openKey` is the SESSION, so a person who opens this aside has it open for
     the conversation they are reading and not for every conversation they ever
     open. `summary` is the closed line, in words rather than in characters,
     because a fold whose label is plumbing is one nobody presses. Both ride on
     the entry: src/components.js draws this and stays copy-free. */
  function markTreeContext(history, sessionId) {
    return (Array.isArray(history) ? history : []).flatMap(entry => {
      if (!entry || entry.who !== 'you' || typeof entry.text !== 'string') return [entry]
      /* A continuation on another account starts from the product's handoff, sent
         from the person's side: one folded line, the whole text one press away. */
      if (isAccountHandoff(entry.text)) {
        return [{ ...entry, who: 'context', label: handoffContextLabel({ model: isModelHandoff(entry.text) }), summary: handoffContextSummary(entry.text),
          openKey: `${typeof sessionId === 'string' ? sessionId : ''}:handoff` }]
      }
      if (entry.promptKind === 'role') return [markRoleContext(entry, sessionId)]
      if (entry.promptSource === 'toolsenabled' && entry.promptKind !== 'role' && entry.promptKind !== 'tree') {
        const names = { requests: 'Standing rules', tools: 'Available tools', capabilities: 'Tools for this request' }
        return [{ ...entry, who: 'context', label: 'Added by ToolsEnabled',
          summary: names[entry.promptKind] || 'Session context', openKey: `${sessionId || ''}:${entry.promptKind}` }]
      }
      const address = readTreeAddress(entry.text)
      if (!address && entry.promptKind !== 'tree') return [markRoleContext(entry, sessionId)]
      // Older canonical records contain the accepted compound brief in one
      // row. Preserve the owner's prefix outside the folded tree context.
      // Only the product's address + following tree introduction is split;
      // merely quoting a tree address in an ordinary message stays visible.
      const match = [...entry.text.matchAll(/^Tree address: you are "[^"\n]{1,120}"[^\n]*\r?\nYou are .+ on this computer's agent tree\./gm)].at(-1)
      if (!match && entry.promptKind !== 'tree') return [markRoleContext(entry, sessionId)]
      const start = match?.index || 0
      const person = entry.text.slice(0, start).trimEnd()
      const context = entry.text.slice(start)
      return [
        ...(person ? [{ ...entry, text: person }] : []),
        { ...entry, ...(person && entry.id ? { id: `${entry.id}:tree-context` } : {}), text: context,
          who: 'context', label: TREE_CONTEXT_LABEL, summary: treeContextSummary(context),
          openKey: typeof sessionId === 'string' ? sessionId : '' },
      ]
    })
  }

  function mergeActionsIntoHistory(history, sessionId, { settled = false } = {}) {
    const buffer = sessionActions.get(sessionId)
    const held = buffer ? buffer.list() : []
    /* WHILE THIS WINDOW IS OPEN, THE RICHER COPY WINS. The saved record keeps
       the command and not the output it printed -- it is an excerpt, and an
       archive of every command's output is not what belongs in a person's
       settings file. But the buffer still holds that output for as long as the
       window lives, so a row reopened five minutes later can still be opened
       onto what the command said. Joined on the moment the row was opened,
       which is what the record carries. */
    const byId = new Map(held.filter(row => row.transcriptId).map(row => [row.transcriptId, row]))
    const byMoment = new Map(held.map(row => [row.at, row]))
    const drawn = (Array.isArray(history) ? history : []).map((entry, index) => {
      if (!entry || entry.who !== 'action') return entry
      const richer = entry.id ? byId.get(entry.id) : byMoment.get(entry.at)
      return richer ? { who: 'action', ...actionChatRow(richer) } : savedActionRow(entry, index, { settled })
    })
    const savedIds = new Set((Array.isArray(history) ? history : []).map(entry => entry?.id).filter(Boolean))
    const pending = held.filter(row => !row.recorded && !(row.transcriptId && savedIds.has(row.transcriptId)))
    if (pending.length === 0) return drawn
    return [...drawn, ...pending.map(row => ({ who: 'action', ...actionChatRow(row) }))]
  }

  /* THE DURABLE HALF. Every append lands the bounded excerpt on disk under
     the NODE, because the node is what survives the window and the session
     both — it is the thing on screen a person presses Resume on. A missing
     store (open failed, browser-only window) degrades to exactly the old
     behaviour: window-memory transcripts, resume disabled. */
  function persistTranscript(sessionId, { transcripts = transcriptStore, trees = treeStore } = {}) {
    if (!transcripts) return
    const nodeId = sessionNodeIds.get(sessionId)
    if (!nodeId) return
    const lines = sessionTranscripts.get(sessionId) || []
    if (transcripts.bind) void transcripts.bind(sessionId, nodeId)
    if (lines.length === 0) return
    /* A SAVE MUST NOT NULL WHAT IT DOES NOT KNOW.
     *
     * transcriptStore.save REPLACES a node's record whole -- it has never
     * merged. All three fields below are read from WINDOW memory, and a window
     * that never opened this session holds none of them, so a save from such a
     * window wrote null over the engine thread name that makes a real Resume
     * possible and over the reasoning depth the node was started at. A window
     * that DOES know still wins, because it is the live fact; where it does
     * not, `keepUnknown` leaves the record's own answer standing.
     *
     * THE MERGE MOVED INTO THE STORE, and the reason is what an append costs.
     * This used to be a transcriptStore.get() here followed by a save(), and
     * BOTH parse and re-clean every conversation stored for the computer -- so
     * every appended turn paid for the whole envelope twice. MEASURED
     * 2026-09-03 over a full store (23 conversations), 200 appends: 1.822 ms
     * per turn as a get()+save() pair, 0.930 ms with the merge inside the one
     * save. It is also one read rather than two, so the pair can no longer
     * disagree when another window writes between them. */
    /* The provider that wrote the thread rides with it, read off the node's
       tier while the session runs -- the only moment the two are the same
       fact -- and kept from the record whenever this window cannot tell. */
    const liveNode = trees ? trees.getNode(nodeId) : null
    const liveProvider = liveNode ? (LAUNCH_TIERS.find(tier => tier.id === liveNode.tier)?.provider || null) : null
    transcripts.save(nodeId, {
      lines,
      threadId: sessionThreadIds.get(sessionId) || null,
      effort: sessionEfforts.get(sessionId) || null,
      provider: sessionThreadIds.get(sessionId) ? liveProvider : null,
      /* `has`, not truthiness: null is the known single-account answer for a
         newly opened thread and must clear an older thread's account rather
         than accidentally pairing the two. So a window that never saw this
         session open passes `undefined` -- not null -- and keepUnknown below
         leaves the record's own account standing. That is the one distinction
         keepUnknown cannot read off a null, and the store's own doc comment on
         `account` says the same thing from its side. */
      account: sessionAccountNames.has(sessionId) ? (sessionAccountNames.get(sessionId) ?? null) : undefined,
      keepUnknown: true,
    })
  }

  const tierEffortOf = tierId => LAUNCH_TIERS.find(tier => tier.id === tierId)?.effort || null

  /* WHAT THIS ENGINE REALLY OFFERS, asked once per session in this window.
     model/list is the provider's own catalog: every model, the reasoning
     efforts it supports, each with the provider's description, and its
     default. Read lazily from any running session — there is nothing to ask
     before one exists — and left empty when the engine cannot answer, in
     which case the menus fall back to the built-in names. */
  const engineModelCatalog = createEngineModelCatalog()
  function readEngineCatalog(sessionId) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    void engineModelCatalog.read(sessionId, bridge)
  }
  /* Everything a start needs in order to tell the agent where it stands. Built
     from the store, so the name in the brief is the name on the circle.
   *
   * THE PARENT'S NAME IS READ, NOT RECOMPUTED, and getting that wrong is a
   * measured defect rather than a precaution. composeParentFor() hands over a
   * PROJECTION -- `{ id, name }` -- and its `name` has already been through
   * treeNodeName. Passing that projection back into treeNodeName finds no
   * `role` on it, so roleLabel falls through to its generic word: the brief
   * told a child under a circle drawn "Manager" that its manager was "Agent",
   * and the running agent dutifully repeated it (measured 2026-08-18 on a
   * staged build with a real Codex session: "My manager is Agent"). The node
   * itself IS a store record and keeps the computed name. */
  function briefContextFor(node, parent, store = treeStore) {
    return {
      selfName: treeNodeName(node),
      parentName: parent ? (parent.name || null) : null,
      /* THE AGENTS THAT ALREADY REPORT TO THIS ONE, so it is told at spawn
         instead of finding out when one of them messages it. The owner reported
         the symptom: agents "take a little while to realize they have subagents
         or coordinators".
         treeNodeName, NOT node.name, for the reason the block above this
         function records at length: a bare `name` loses `role`, and a child
         under a circle drawn "Manager" was told its manager was "Agent".
         Children carry the same hazard in the other direction.
         Empty is the ordinary case for a node started on its own -- this only
         has anything to say once a tree is drawn first and started after, which
         is what makes it worth having. */
      childNames: store
        ? store.childrenOf(node.id).map(child => treeNodeName(child))
        : [],
    }
  }

  /* Only the exact running model's provider-reported efforts. Another model
     or provider cannot establish support for this one. */
  function engineEffortsFor(node) {
    const tier = LAUNCH_TIERS.find(tier => tier.id === node?.tier)
    const wanted = sessionModelOverride.get(node?.sessionId) || tier?.model || null
    return engineModelCatalog.efforts(node?.sessionId, tier?.provider, wanted)
  }

  /* LIVENESS, NOT JUST STATUS. parseFleetTrees loads a saved 'running' node
     back as 'starting', so after an app restart every mid-turn node reads
     busy FOREVER over a dead session — the stop button would stand over a
     corpse and every send would silently queue into a queue nothing will
     ever drain. sessionNodeIds holds exactly the sessions THIS RUN started
     or reattached (RUN_SESSION_NODES), so status AND membership is the honest
     busy test; a restart-stale node reads idle, its send goes out, the engine
     refuses with MC_AGENT_UNKNOWN_SESSION, and the recovery below takes over.

     EVERY READER OF "IS THIS NODE BUSY" GOES THROUGH HERE. The status field
     alone was still being read in five other places -- the chip's word, the
     rail's waiting line, the graph's clock, the resume verb and the runtime
     face -- and each one of them told the restart-stale story its own way. */
  /* The three readers, bound to THIS run's session map. The rules themselves
     live in src/tree-session-liveness.js, where the suite drives them for
     real -- see the note at the top of that file for the six surfaces that
     each used to answer this question their own way. */
  /* THE EXAMPLE'S RUNS ARE ITS OWN. On the example the working tree is played
     by src/sample-simulation.js, and the sessions it is running are the ones
     this page shows as live -- its own set, never sessionNodeIds, which the
     commands, the recovery coordinator and every bridge call trust. Declared
     here, above every reader, so no render can reach it before it exists. */
  let sampleRun = null
  let sampleRunStore = null
  /* The rest of the example simulation's page state (see THE EXAMPLE, AT
     WORK beside openSampleTreeStore), declared here for the same reason. */
  const SAMPLE_TICK_MS = 200
  const SAMPLE_CHAT_SUBTITLE = 'Example agent · simulated run'
  const SAMPLE_SAFE_ACTIONS = new Set(['copy-brief', 'copy-reply'])
  let sampleRunTimer = 0
  let sampleChipFrame = 0
  const sampleChips = new Set()
  const sampleChats = new Map()
  const sampleChatsShown = new WeakSet()
  const sampleChatsBorn = new WeakMap()
  const sampleSessionText = new Map()
  let sampleSaid = { box: null, pushed: '' }
  const ownedSessions = () => (sampleRun && treeStore && treeStore === sampleRunStore ? sampleRun.liveSessions : sessionNodeIds)
  /* The expiring half of liveness, read off whichever collection is in play.
     A sample run keeps no stamps -- its sessions emit no packets -- and gets
     `null`, which is the rule's own "no evidence means live" branch rather
     than a special case for samples. A collection that predates this class
     (a plain Map handed in by a fixture) has no `seenAt` either, and is
     answered the same way. */
  const sessionEvidence = () => {
    const owned = ownedSessions()
    return owned && owned.seenAt instanceof Map ? { seenAt: owned.seenAt } : null
  }
  const nodeSessionLive = node => sessionIsLive(node, ownedSessions(), sessionEvidence())
  const nodeBusy = node => nodeIsBusy(node, ownedSessions(), sessionEvidence())
  const nodeSessionEnded = node => sessionEndedWithApp(node, ownedSessions(), sessionEvidence())

  function applyRecoveredNodeStatus(store, node, status, turnId) {
    const outcome = recoveredNodeTurnStatus(node, status, turnId)
    const sameTurn = typeof turnId === 'string' && turnId.length > 0 && node.lastTurnId === turnId
    const note = outcome === 'interrupted' ? 'Stopped by you.'
      : outcome === 'cancelled' ? (sameTurn && node.status === 'cancelled' ? node.statusNote : TURN_CANCELLED.note) : ''
    store.setNodeStatus(node.id, outcome, { note, turnId: turnId || null })
  }

  const reconnectingStores = new WeakSet()
  /* A SWEEP THAT REALLY RAN IS THE ONLY THING THAT SETTLES THE SEAT EVIDENCE.
     Reached only by a reconnect that got as far as claiming the store, so the
     early returns -- wrong surface, no bridge, a sweep already in flight --
     leave RUN_SESSION_NODES withheld from the seat counters instead of
     declaring an unasked host's children dead. Settled on failure too: a sweep
     whose every probe was refused IS the app restart whose seats T407 frees. */
  function finishedSavedSessionSweep(store) {
    reconnectingStores.delete(store)
    runSessionSweepDone = true
    /* T211: A MOVE MADE BEFORE THE SWEEP LANDED NEVER REACHED THE DIRECTORY.
       syncTreeBranchAddresses can only correct a session THIS RUN OWNS, and
       until the sweep fills that map a reloaded page owns none of them. So a
       drag onto a new manager in that window saved the canvas, found no session
       to tell, and returned `{ ok: true, updated: 0 }` -- no directory write and
       no warning, because "nothing to update" and "nothing needed updating" are
       the same answer there. The row kept the manager it had registered with at
       spawn for the rest of that session's life, which is the person's two
       organisations: the one drawn and the one messages follow.
       The sessions are known now, so the saved tree is re-asserted over the
       whole forest from each root, exactly as a rename does. updateTreeAddress
       coalesces an address that has not moved, so a forest that did not move
       costs a comparison per live circle and no directory write. */
    for (const node of store.snapshot().nodes) {
      if (!node.parentId) void syncTreeBranchAddresses(node.id, store)
    }
    /* AND THE SCREEN HAS TO BE TOLD, or the seat this just freed stays
       withdrawn on the canvas. MEASURED on a private candidate 2026-09-19: a
       parent whose four children died with the previous app run drew with its
       "Add an agent under Manager" slot at `display: none`, and it only came
       back after navigating away and returning. extensionPoints() had already
       run against evidence that had not arrived yet; the sweep's own repaint
       is onReconnect, which fires PER RESTORED SESSION and therefore never
       fires at all in the one case that frees seats -- an app restart, where
       every probe is refused. refreshTree() is the choke point every other
       status mutation already publishes through. */
    if (!destroyed && treeStore === store) refreshTree()
  }
  const remotePendingPackets = new Map()
  /* The same probe window, for a native session. Its events carry no sequence,
     so arrival order is all there is: these are applied once the routing edge
     is restored, and a turn already durable on disk is dropped there. */
  const nativePendingPackets = new Map()
  // A reconnected native session may have emitted words before this view
  // existed. Its capture owns the full answer; reconcile each named terminal
  // turn from disk before settling its stable row or releasing queued work.
  const nativeReconcileSessions = new Set()
  const remoteAppliedSequences = new Map()
  let replayingRemoteHistory = false
  let handleAgentEvent = null
  async function reconnectSavedRemoteSessions() {
    if (authoritativeTreeSnapshot) return
    const store = treeStore
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (source !== 'relay' || !store || typeof bridge?.models !== 'function'
        || typeof window.mcRemoteEvents?.read !== 'function'
        || reconnectingStores.has(store)) return
    reconnectingStores.add(store)
    try {
      await reconnectRemoteSessions({
        nodes: store.snapshot().nodes, bindings: sessionNodeIds,
        readSession: request => bridge.models(request),
        refusals: SAVED_SESSION_REFUSALS,
        readHistory: id => readRemoteSessionHistory(request => window.mcRemoteEvents.read(request), id),
        onProbe: id => remotePendingPackets.set(id, { rows: [], bytes: 0, overflow: false }),
        onProbeEnd: id => remotePendingPackets.delete(id),
        getNode: id => store.getNode(id),
        isCurrent: () => !destroyed && source === 'relay' && treeStore === store,
        onReconnect: (node, answer, history) => {
          engineModelCatalog.record(node.sessionId, answer)
          const pending = remotePendingPackets.get(node.sessionId)
          const events = [...history.events, ...(pending?.rows || []).filter(row => row.seq > history.seq)]
          remoteAppliedSequences.set(node.sessionId, Math.max(history.seq, ...events.map(row => row.seq)))
          const saved = transcriptStore?.get(node.id)?.lines || []
          const recovery = remoteHistoryReplay(events, saved)
          if (recovery.migratedLines) {
            sessionTranscripts.set(node.sessionId, recovery.migratedLines)
            persistTranscript(node.sessionId)
          }
          replayingRemoteHistory = true
          try {
            for (const packet of recovery.packets) handleAgentEvent?.(packet)
          } finally { replayingRemoteHistory = false }
          if (history.dropped || pending?.overflow) {
            setOrgStatus('Some activity happened while this browser was away and is no longer available. The conversation still shows the replies that could be recovered.', 'warn')
          }
          if (recovery.ended) retireTreeSessionRuntime(node.sessionId)
          else if (recovery.status) {
            applyRecoveredNodeStatus(store, node, recovery.status, recovery.latestTurnId)
          }
          refreshTree()
          // A read landing while someone types must not rebuild their chat.
          for (const chat of chatSurfacesFor(node.sessionId)) {
            const subtitle = chat.querySelector('.chat-head .s')
            if (subtitle) subtitle.textContent = recovery.ended ? ENDED_SESSION.subtitle : 'your agent · live session'
          }
          if (currentRailTreeNode?.id === node.id) repaintRailStatus(store.getNode(node.id))
          // Historical completions must never drain one queued message each.
          // Only a successful final completion can release the next turn.
          // Reloading must not resume queued work after a stop or failed turn.
          if (!recovery.ended && sessionTurnSucceeded(recovery.status)) {
            const next = outboxTakeNext(node.sessionId)
            if (next) void drainOutboxMessage(node.sessionId, node.id, next)
          }
        },
      })
    } catch {
      if (!destroyed && treeStore === store) setOrgStatus('The live conversation could not be reconnected. Reopen this page to retry.', 'warn')
    } finally { finishedSavedSessionSweep(store) }
  }

  /* A RENDERER RELOAD IS NOT AN APP RESTART.
   *
   * RUN_SESSION_NODES belongs to the module, so a reload of Page 2 empties it
   * while the host process it was routing to keeps working. handleAgentEvent
   * then discarded every event for this window's own live session, the node
   * kept the status it was saved with, and the reply that arrived after the
   * reload reached nothing. MEASURED by the owner on the native build: a
   * session working at 10:21 was still drawn as "starting" with the previous
   * turn's answer at 10:30, while its reply sat durable on disk.
   *
   * A saved id still proves nothing. The host is asked, per session, through
   * the same session-scoped models read the relay path verifies ownership
   * with, and then for that session's activity -- both refuse an id this
   * window does not own, one that has ended, and one from a previous run of
   * the app, which is what keeps a genuine restart refused. */
  async function reconnectSavedNativeSessions() {
    const store = treeStore
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (source !== 'local' || !store || typeof bridge?.models !== 'function'
        || typeof bridge?.sessionActivity !== 'function'
        || reconnectingStores.has(store)) return
    reconnectingStores.add(store)
    try {
      await reconnectRemoteSessions({
        nodes: store.snapshot().nodes, bindings: sessionNodeIds,
        readSession: request => bridge.models(request),
        refusals: SAVED_SESSION_REFUSALS,
        readHistory: async id => {
          const first = await bridge.sessionActivity({ sessionId: id })
          if (!first || first.ok !== true) throw new Error('Session activity unavailable')
          if (first.closing === true) throw new Error('Session is closing')
          /* A turn that finished while this page was away left its words on
             disk and no event to replay. get() is the hydration-time cache and
             predates exactly that write, so this waits for the store and reads
             the node's own record again. */
          const node = store.snapshot().nodes.find(entry => entry.sessionId === id)
          let lines = []
          if (node && typeof transcriptStore?.readLatest === 'function') {
            const client = transcriptStore
            try {
              await client.ready
              const record = await client.readLatest(node.id)
              // Identity re-checked after both awaits: another view, store or
              // session must not be handed this answer.
              if (!destroyed && treeStore === store && transcriptStore === client
                  && store.getNode(node.id)?.sessionId === id) lines = record?.lines || []
            } catch { /* The activity answer below still stands on its own. */ }
          }
          /* Asked again after the disk read, because a turn can end while that
             read is in flight and the status must not be the older answer. */
          const activity = await bridge.sessionActivity({ sessionId: id })
          if (!activity || activity.ok !== true) throw new Error('Session activity unavailable')
          if (activity.closing === true) throw new Error('Session is closing')
          return { activity, lines }
        },
        onProbe: id => nativePendingPackets.set(id, { rows: [], bytes: 0, overflow: false }),
        onProbeEnd: id => nativePendingPackets.delete(id),
        getNode: id => store.getNode(id),
        isCurrent: () => !destroyed && source === 'local' && treeStore === store,
        onReconnect: (node, answer, recovered) => {
          engineModelCatalog.record(node.sessionId, answer)
          const pending = nativePendingPackets.get(node.sessionId)
          nativePendingPackets.delete(node.sessionId)
          const saved = recovered.lines
          /* THE SAVED STAMPS ARE NOT A LIST OF FINISHED TURNS HERE. Native
             capture flushes a turn's words as they stream, so a turn still
             running already has a stamped row on disk; skipping its packets on
             that basis would drop the rest of that answer. Nothing is skipped,
             and what those packets continue is primed here instead. */
          nativeReconcileSessions.add(node.sessionId)
          const recovery = remoteHistoryReplay((pending?.rows || []).map((packet, index) => ({ seq: index + 1, packet })), [])
          replayingRemoteHistory = true
          try {
            for (const packet of recovery.packets) {
              // A terminal packet predating a busy host snapshot belongs to
              // older work. It cannot settle or release the current turn.
              if (recovered.activity.busy === true && sessionTurnStatus(packet, node.sessionId)) continue
              void handleAgentEvent?.(packet, { nativeReplayIdle: recovered.activity.busy !== true })
            }
          } finally { replayingRemoteHistory = false }
          if (pending?.overflow) {
            setOrgStatus('Some activity happened while this page was reloading and is no longer available. The conversation still shows the replies that could be recovered.', 'warn')
          }
          /* THE CARD'S OWN LINE, from the record rather than from an event
             that no longer exists: a turn that finished while the page was
             away left its answer on disk and nothing to replay. Same move the
             saved-continuation path makes. Never over a session still
             speaking, whose partial belongs to its own live stream. */
          if (recovered.activity.busy !== true) {
            const lastSaid = [...saved].reverse().find(line => line?.who === 'agent' && line.text)?.text
            if (lastSaid && lastSaid !== node.reply) {
              store.setNodeReply(node.id, lastSaid)
              nodeReplies.set(node.id, lastSaid)
            }
          }
          if (recovery.ended) retireTreeSessionRuntime(node.sessionId)
          else if (recovered.activity.busy === true) store.setNodeStatus(node.id, 'running')
          else if (recovery.status) {
            applyRecoveredNodeStatus(store, node, recovery.status, recovery.latestTurnId)
          } else if (recovered.activity.busy !== true && recovered.activity.lastTurnStatus) {
            /* The turn ended while the page was away and no event of it
               survived. The host kept the provider's own word for how it
               ended, so this is read and never inferred: saved speech alone
               proves nothing, and an idle session whose host recorded no
               outcome keeps the status it was saved with. */
            applyRecoveredNodeStatus(store, node, recovered.activity.lastTurnStatus, recovered.activity.lastTurnId)
          }
          refreshTree()
          for (const chat of chatSurfacesFor(node.sessionId)) {
            const subtitle = chat.querySelector('.chat-head .s')
            if (subtitle) subtitle.textContent = recovery.ended ? ENDED_SESSION.subtitle : 'your agent · live session'
          }
          // The same hydration door the first mount uses: it replaces a saved
          // history fallback only, and never a rail that is already streaming.
          if (transcriptStore) refreshHydratedRailChat(transcriptStore)
          if (currentRailTreeNode?.id === node.id) repaintRailStatus(store.getNode(node.id))
        },
      })
    } catch {
      if (!destroyed && treeStore === store) setOrgStatus('The live conversation could not be reconnected. Reopen this page to retry.', 'warn')
    } finally { finishedSavedSessionSweep(store) }
  }

  // Read before closing any bubble or releasing queued work. A delayed read
  // belongs only to the captured node/session/turn; a new send, newer event,
  // replacement, view change or child exit invalidates it.
  async function recoveredTurnText(sessionId, nodeId, turnId, fallback) {
    const client = transcriptStore
    const store = treeStore
    const openTurn = sessionOpenTurns.get(sessionId)
    const completedTurn = sessionCompletedTurnIds.get(sessionId)
    const lastSend = sessionTurnLog.get(sessionId)?.at(-1)
    const current = () => !destroyed && treeStore === store && transcriptStore === client
      && sessionNodeIds.get(sessionId) === nodeId && store?.getNode(nodeId)?.sessionId === sessionId
      && sessionOpenTurns.get(sessionId) === openTurn
      && sessionCompletedTurnIds.get(sessionId) === completedTurn
      && sessionTurnLog.get(sessionId)?.at(-1) === lastSend
    let canonical = null
    if (turnId && typeof client?.readLatest === 'function') {
      try {
        const record = await client.readLatest(nodeId)
        canonical = (record?.lines || []).findLast(line => line?.who === 'agent' && line.turnStamp === turnId)?.text || null
      } catch { /* Retain the words this window actually observed. */ }
    }
    return current() ? (canonical || fallback) : null
  }

  /* One door for both surfaces: the website reconnects through the relay, the
     app through its own host, and each refuses what it cannot verify. */
  function reconnectSavedSessions() {
    return source === 'relay' ? reconnectSavedRemoteSessions() : reconnectSavedNativeSessions()
  }

  /* The chat composer's ear on a node's status. Notified from refreshTree(),
     the choke point every status mutation already flows through — no second
     event stream to drift from the first. */
  const nodeStatusListeners = new Map()
  function registerNodeStatusListener(nodeId, listener) {
    const held = nodeStatusListeners.get(nodeId) || new Set()
    held.add(listener)
    nodeStatusListeners.set(nodeId, held)
    return () => {
      const set = nodeStatusListeners.get(nodeId)
      if (!set) return
      set.delete(listener)
      if (set.size === 0) nodeStatusListeners.delete(nodeId)
    }
  }
  function notifyNodeStatusListeners() {
    refreshSlotUsage()
    for (const held of nodeStatusListeners.values()) {
      for (const listener of held) {
        try { listener() } catch { /* a dead listener must not break the tree */ }
      }
    }
  }

  function turnLogAppend(sessionId, turnId, yourText) {
    if (!sessionId || typeof turnId !== 'string' || !turnId) return
    const held = sessionTurnLog.get(sessionId) || []
    held.push({ turnId, yourText: String(yourText || '').slice(0, 200), at: Date.now() })
    if (held.length > TRANSCRIPT_MAX_ENTRIES) held.splice(0, held.length - TRANSCRIPT_MAX_ENTRIES)
    sessionTurnLog.set(sessionId, held)
  }
  let currentRailTreeNode = null
  /* The one live streaming surface: the open rail's "What it said" box, when
     the shown node's session is mid-turn. Torn down on every rail rebuild --
     the box it writes into dies with the innerHTML swap. */
  let railSaid = null
  const scheduleFrame = cb => requestAnimationFrame(cb)
  const cancelFrame = id => cancelAnimationFrame(id)
  function disposeRailSaid() {
    if (!railSaid) return
    railSaid.appender.dispose()
    railSaid = null
  }

  /* THE RAIL'S CHAT TAB — one mounted chat at a time, tracked so the delta
     stream and the turn completion know where to speak. Disposed before any
     controlsPage rebuild: the rule is never innerHTML='' OVER a mounted chat,
     and disposing first is how a rebuild honours it. */
  let railChat = null
  function disposeRailChat() {
    removeAccountRetrySection()
    disposeDesktopChat()
    if (!railChat) return
    if (chatNodeId) chatDraft?.write(railChat.root?.exportDraft?.())
    railChat.releaseDraft?.()
    railChat.stream?.close()
    railChat.root?.dispose?.()
    railChat = null
  }

  /* THE COMPUTER'S OWN CONVERSATIONS, ON A BROWSER THAT DRIVES IT.
   *
   * Only where the website provides window.mcDesktopSessions and this page reads
   * over the relay. Everywhere else desktopBridge() is null and every function
   * below returns without touching the page, so the desktop app is unchanged.
   *
   * desktopEpoch is the fence. Every data-source announcement bumps it, even
   * when the source stays the relay, because the announcement is also how a
   * different computer, a sign-out or an idle close arrives. A bump clears the
   * list, closes an open desktop chat and forgets every draft; any answer that
   * started under an older epoch is dropped. Between fences a draft is kept in
   * memory by session id, never in browser storage. */
  let desktopEpoch = 0
  /* Each list read makes the computer check its own connection, which is not
     free, so reads are at least DESKTOP_LIST_INTERVAL_MS apart. A request
     inside that window is folded into one read at its end, and nothing is read
     while the page is hidden. */
  const DESKTOP_LIST_INTERVAL_MS = 30000
  let desktopListAt = -Infinity
  let desktopListTimer = null
  /* The epoch the last list read ran under. A fence starts a new epoch, and the
     first request under it reads at once, so a changed connection does not
     leave the conversations missing for the whole interval. */
  let desktopListEpoch = -1
  let desktopList = null
  let desktopListRefusal = null
  let desktopChat = null
  let desktopChatNativeTarget = null
  const desktopDrafts = new Map()
  const DESKTOP_TREE_INTERVAL_MS = 15000
  let desktopTreeTimer = null
  let desktopTreeFlight = null
  let desktopTreeReadAt = -Infinity
  let desktopTreeStopRefresh = false

  function setDesktopTreeState(state) {
    root.dataset.nativeTreeState = state
    phoneLedger?.refresh()
  }

  /* Native saves do not necessarily emit agent events (a draft or empty tree
     has no session). Poll the read-only authority while visible as well as
     reacting to events and focus. These GETs are background work in the host
     bridge, so they cannot renew an unattended account/connection lease. */
  function requestAuthoritativeDesktopTree() {
    if (destroyed || source !== 'relay' || !desktopTreeBridge()
        || resolveProjectionReady || desktopTreeFlight || document.visibilityState === 'hidden') return
    const wait = desktopTreeStopRefresh ? 0 : desktopTreeReadAt + DESKTOP_TREE_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      clearTimeout(desktopTreeTimer)
      desktopTreeTimer = null
      desktopTreeStopRefresh = false
      void refreshAuthoritativeDesktopTree()
      return
    }
    if (desktopTreeTimer) return
    desktopTreeTimer = setTimeout(() => {
      desktopTreeTimer = null
      requestAuthoritativeDesktopTree()
    }, wait)
  }

  async function refreshAuthoritativeDesktopTree() {
    const flight = { version: fetchVersion, epoch: desktopEpoch }
    desktopTreeFlight = flight
    desktopTreeReadAt = Date.now()
    setDesktopTreeState(authoritativeTreeSnapshot ? 'refreshing' : 'loading')
    try {
      const answer = await readAuthoritativeDesktopTree()
      if (destroyed || desktopTreeFlight !== flight || flight.version !== fetchVersion
          || flight.epoch !== desktopEpoch || source !== 'relay') return
      if (!answer.snapshot) {
        if (authoritativeTreeSnapshot) {
          setDesktopTreeState('stale')
          setOrgStatus('The computer’s saved trees could not be refreshed. Showing the last verified snapshot.', 'warn')
        } else {
          showProjectionUnavailable('the computer’s saved trees could not be read')
        }
        return
      }
      if (!authoritativeTreeSnapshot) {
        mountProjection({ authoritativeDesktopTree: answer.snapshot }, { declaredReason: null })
      } else {
        /* Replace the immutable view atomically. Reconcile the existing graph
           and ledger so selection, scroll and the live conversation survive. */
        authoritativeTreeSnapshot = answer.snapshot
        authoritativeTreeComputer = desktopTreeComputer(answer.snapshot, drivenComputerCopy('This computer', 'The computer you are driving'))
        lastFleetData = { authoritativeDesktopTree: answer.snapshot }
        liveComputers = [authoritativeTreeComputer]
        computer = authoritativeTreeComputer
        treeStore = createDesktopTreeViewStore(answer.snapshot)
        treeStoreId = computer.id
        retireChangedDesktopTreeConversation()
        const stoppedTarget = desktopChat?.stopCompleted ? desktopChatNativeTarget : null
        if (stoppedTarget && answer.snapshot.nodes.some(node => node.id === stoppedTarget.nodeId
            && node.sessionId === stoppedTarget.sessionId && node.status === 'finished')) {
          // The receipt confirms closure; this separate read supplies saved UI.
          disposeDesktopChat()
          showAuthoritativeTreeNodeControls(stoppedTarget.nodeId, { activate: false })
        }
        if (controlsPage.querySelector('[data-native-tree-details]')) {
          const selectedId = currentRailTreeNode?.id
          if (answer.snapshot.nodes.some(node => node.id === selectedId)) {
            showAuthoritativeTreeNodeControls(selectedId, { activate: phoneCanvas?.isOpen() ?? true })
          }
          else {
            currentRailTreeNode = null
            controlsPage.replaceChildren()
            showStats()
          }
        }
        refreshTree()
        renderTabs()
      }
      setDesktopTreeState('available')
      requestDesktopSessions()
    } finally {
      if (desktopTreeFlight === flight) {
        desktopTreeFlight = null
        // Count from completion as a paged snapshot may itself take seconds.
        desktopTreeReadAt = desktopTreeStopRefresh ? -Infinity : Date.now()
        requestAuthoritativeDesktopTree()
      }
    }
  }

  /* THE FENCE IS TWO ACTS, AND ONLY ONE OF THEM COSTS THE PERSON ANYTHING.
   *
   * Holding is protective and free: stop the timers, drop the in-flight reads,
   * move the epoch so an answer prepared for the previous world cannot land on
   * this one. Releasing is destructive: it closes the open conversation, throws
   * away the draft in it and takes the drawn projection off the screen.
   *
   * They used to be one function called on EVERY data-source announcement,
   * before the announcement had been resolved into a verdict. A host
   * re-announce on a signed-in instance -- a token refresh, an account
   * re-check -- resolves to the source it already had, so the page kept its
   * verdict and the person still lost the conversation they were reading and
   * the message they had half-typed (T296, owner-reported 2026-09-17).
   *
   * Holding stays unconditional because it is what makes a stale answer
   * harmless. Releasing now waits for the verdict; see onDataSourceChange for
   * the two things that have to be compared before it may run. */
  function holdAuthoritativeDesktopTree() {
    clearTimeout(desktopTreeTimer)
    desktopTreeTimer = null
    desktopTreeFlight = null
    desktopTreeReadAt = -Infinity
    desktopTreeStopRefresh = false
    fetchVersion += 1
  }

  function releaseAuthoritativeDesktopTree() {
    phoneLedger?.resetSource()
    phoneCanvas?.setSubject(null)
    phoneCanvas?.close()
    if (source === 'relay' && desktopTreeBridge()) showProjectionUnavailable('', true)
  }

  function desktopBridge() {
    return source === 'relay' ? desktopSessionsBridge() : null
  }
  async function readAuthoritativeDesktopTree() {
    if (source !== 'relay') return { snapshot: null, available: false }
    const bridge = desktopTreeBridge()
    if (!bridge) return { snapshot: null, available: false }
    try {
      return { snapshot: await readDesktopTreeSnapshot(bridge), available: true }
    } catch (error) {
      /* A complete native snapshot is intentionally larger than the ordinary
         bridge response cap. Some bridge adapters surface that cap as a
         rejected first read and require the consumer to begin the lossless
         transfer at page 0. Keep this recovery at the consumer boundary so a
         transport-specific error shape cannot turn a valid tree into an empty
         fleet. Subsequent pages remain hash-fenced by readDesktopTreeSnapshot.
       */
      const code = error?.code || error?.error?.code || error?.message
      if (typeof code === 'string' && code.includes('AGENT_FACADE_RESPONSE_TOO_LARGE')) {
        try {
          const paged = { read: request => bridge.read(request || { page: 0 }) }
          return { snapshot: await readDesktopTreeSnapshot(paged), available: true }
        } catch (pagedError) {
          return { snapshot: null, available: true, error: pagedError }
        }
      }
      return { snapshot: null, available: true, error }
    }
  }
  function desktopRowFor(sessionId) {
    if (!sessionId || !desktopList || !desktopBridge()) return null
    return desktopList.rows.find(row => row.sessionId === sessionId) || null
  }
  function disposeDesktopChat() {
    if (!desktopChat) return
    const draft = desktopChat.exportDraft()
    if (draft && typeof draft.text === 'string' && draft.text.trim()) desktopDrafts.set(desktopChat.sessionId, draft)
    else desktopDrafts.delete(desktopChat.sessionId)
    desktopChat.dispose()
    desktopChat = null
    desktopChatNativeTarget = null
  }
  function nativeConversationMatches(nodeId, sessionId) {
    if (!nodeId) return true
    return source === 'relay'
      && authoritativeTreeSnapshot?.nodes.some(node => node.id === nodeId && node.sessionId === sessionId)
      && desktopRowFor(sessionId)?.nodeId === nodeId
  }
  function retireChangedDesktopTreeConversation() {
    const target = desktopChatNativeTarget
    if (!desktopChat || !target || nativeConversationMatches(target.nodeId, target.sessionId)) return
    if (desktopChat.stopRequestRetained && source === 'relay'
      && authoritativeTreeSnapshot?.nodes.some(node => node.id === target.nodeId && node.sessionId === target.sessionId)) return
    const host = desktopChat.host
    disposeDesktopChat()
    desktopDrafts.delete(target.sessionId)
    if (host?.isConnected) {
      const notice = document.createElement('p')
      notice.className = 'rail-prose'
      notice.textContent = 'This saved node no longer matches an available conversation. Select the current agent again.'
      host.replaceChildren(notice)
    }
  }
  function mountDesktopChat(host, row, { title, subtitle = '', roleKey = 'default', nativeNodeId = null } = {}) {
    disposeDesktopChat()
    const bridge = desktopBridge()
    if (!bridge || !host) return false
    const epoch = desktopEpoch
    /* Its own subscription, released with the chat; the tree's dispatcher keeps its own. */
    const agentEvents = window.mcAgent
    const draft = desktopDrafts.get(row.sessionId) || null
    desktopDrafts.delete(row.sessionId)
    host.dataset.chatChannel = 'desktop'
    let mounted = null
    mounted = mountDesktopSessionChat({
      host,
      row,
      mayWrite: desktopList?.mayWrite === true,
      bridge,
      subscribe: typeof agentEvents?.onEvent === 'function' ? listener => agentEvents.onEvent(listener) : null,
      buildChat,
      title,
      subtitle,
      roleKey,
      tall: true,
      draft,
      isCurrent: () => !destroyed && epoch === desktopEpoch && desktopChat === mounted
        && (nativeConversationMatches(nativeNodeId, row.sessionId)
          || (mounted?.stopRequestRetained && source === 'relay' && nativeNodeId
            && authoritativeTreeSnapshot?.nodes.some(node => node.id === nativeNodeId && node.sessionId === row.sessionId))),
      onEnded: () => { requestDesktopSessions() },
      onStopped: () => {
        // A completed native operation warrants an immediate authoritative read.
        // An existing snapshot flight still owns its turn; its finally retries.
        desktopListAt = -Infinity
        desktopTreeStopRefresh = true
        requestDesktopSessions()
        requestAuthoritativeDesktopTree()
      },
    })
    desktopChat = mounted
    desktopChatNativeTarget = nativeNodeId ? { nodeId: nativeNodeId, sessionId: row.sessionId } : null
    return true
  }
  function drawnDesktopSessionIds() {
    return new Set((computer?.agents || []).map(agent => agent.sessionId || agent.treeNode?.sessionId).filter(Boolean))
  }
  function requestDesktopSessions() {
    if (!desktopBridge() || destroyed) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const wait = desktopListEpoch !== desktopEpoch ? 0 : desktopListAt + DESKTOP_LIST_INTERVAL_MS - Date.now()
    if (wait <= 0) { void refreshDesktopSessions(); return }
    if (desktopListTimer) return
    desktopListTimer = setTimeout(() => { desktopListTimer = null; requestDesktopSessions() }, wait)
  }
  async function refreshDesktopSessions() {
    const bridge = desktopBridge()
    if (!bridge || destroyed) return
    desktopListAt = Date.now()
    desktopListEpoch = desktopEpoch
    const epoch = desktopEpoch
    let answer = null
    let code = null
    try { answer = await bridge.list() } catch (error) { code = desktopRefusalCode(error, 'BRIDGE_UNREACHABLE') }
    if (destroyed || epoch !== desktopEpoch || desktopBridge() !== bridge) return
    const next = code ? null : readDesktopSessionList(answer)
    const drawnBefore = desktopTreeSignature(desktopList)
    desktopList = next
    desktopListRefusal = next ? null : (code || desktopRefusalCode(answer, 'MC_AGENT_CONNECTION_CLOSED'))
    retireChangedDesktopTreeConversation()
    if (desktopTreeSignature(next) !== drawnBefore) requestAuthoritativeDesktopTree()
    if (desktopTreeSignature(next) !== drawnBefore && lastFleetData && declaredOnlyReason && orgReady() && !mockSource()) reprojectFromOrg()
    paintDesktopSessions()
  }
  /* The protective half. Moving the epoch is what makes every answer already
     in flight harmless, so it is unconditional and runs the moment the
     announcement arrives. It draws nothing away: the list a person is looking
     at stays on the screen until a newer one replaces it or the release below
     takes it. */
  function holdDesktopSessions() {
    desktopEpoch += 1
    clearTimeout(desktopListTimer)
    desktopListTimer = null
  }
  /* The destructive half: the open conversation, its draft, and the drawn
     list. Runs only once the announcement has been resolved and something a
     draft depends on has really changed. */
  function releaseDesktopSessions() {
    const drawnBefore = desktopTreeSignature(desktopList)
    desktopList = null
    desktopListRefusal = null
    if (desktopChat) {
      const host = desktopChat.host
      disposeDesktopChat()
      if (host?.isConnected) {
        const closed = document.createElement('p')
        closed.className = 'rail-prose is-dim'
        closed.setAttribute('role', 'status')
        closed.textContent = DESKTOP_SESSION_COPY.closedByChange
        host.replaceChildren(closed)
      }
    }
    /* A draft belongs to the connection it was typed under. After the fence
       the same session id may name a conversation on another computer or
       under another account, so no draft survives it. */
    desktopDrafts.clear()
    if (drawnBefore && lastFleetData && declaredOnlyReason && orgReady() && !mockSource()) reprojectFromOrg()
    paintDesktopSessions()
  }
  /* The rows no node on the canvas carries: no declared agent, an agent this
     page already draws for another session, or a fleet record that draws its
     own nodes. Each opens the same live chat in the rail. A list refusal other
     than a lost connection, which the page already names, is said here. */
  function paintDesktopSessions() {
    const slot = statsPage.querySelector('[data-desktop-sessions]')
    if (!slot) return
    const rows = desktopBridge() && desktopList ? desktopSessionsOutsideTree(desktopList, drawnDesktopSessionIds()) : []
    const refusal = desktopBridge() && desktopListRefusal && desktopListRefusal !== 'BRIDGE_UNREACHABLE' && desktopListRefusal !== 'BRIDGE_TIMEOUT'
      ? desktopListRefusal : null
    slot.replaceChildren()
    slot.hidden = rows.length === 0 && !refusal && !desktopList?.truncated
    if (slot.hidden) return
    const heading = document.createElement('div')
    heading.className = 'rail-sec'
    heading.textContent = DESKTOP_SESSION_COPY.othersTitle
    slot.appendChild(heading)
    if (refusal) {
      const said = document.createElement('p')
      said.className = 'rail-prose'
      said.setAttribute('data-refusal-code', refusal)
      said.textContent = desktopSessionSentence(refusal)
      slot.appendChild(said)
      return
    }
    if (rows.length) {
      const help = document.createElement('p')
      help.className = 'rail-prose is-dim'
      help.textContent = DESKTOP_SESSION_COPY.othersHelp
      slot.appendChild(help)
      const list = document.createElement('ul')
      list.className = 'fleet-overview-trees'
      list.setAttribute('data-desktop-session-list', '')
      for (const row of rows) {
        const item = document.createElement('li')
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'ctl-btn'
        open.setAttribute('data-desktop-session-open', '')
        const name = document.createElement('b')
        name.textContent = desktopSessionName(row)
        const facts = document.createElement('span')
        facts.textContent = desktopSessionFacts(row)
        open.append(name, facts)
        open.addEventListener('click', () => showDesktopSessionControls(row))
        item.appendChild(open)
        list.appendChild(item)
      }
      slot.appendChild(list)
    }
    if (desktopList?.truncated) {
      const more = document.createElement('p')
      more.className = 'rail-prose is-dim'
      more.textContent = DESKTOP_SESSION_COPY.truncated
      slot.appendChild(more)
    }
  }
  function showDesktopSessionControls(row, { nativeNodeId = null } = {}) {
    disposeRailSaid()
    disposeRailChat()
    clearBoard()
    currentRailTreeNode = null
    controlsPage.innerHTML = `
      ${railTitleRow({ back: { aria: DESKTOP_SESSION_COPY.backAria }, title: DESKTOP_SESSION_COPY.railTitle })}
      <div class="rail-scroll" data-live-mode="live" data-desktop-session-rail>
        <div class="agent-head board-head"><span class="role-dot"></span><div><div class="an">${escapeMarkup(desktopSessionName(row))}</div><div class="ar">${escapeMarkup(desktopSessionFacts(row))}</div></div></div>
        <div class="board-box board-chat-box"></div>
      </div>`
    mountDesktopChat(controlsPage.querySelector('.board-chat-box'), row, { title: desktopSessionName(row), subtitle: desktopSessionFacts(row), nativeNodeId })
    controlsPage.querySelector('.rail-back').addEventListener('click', () => { showStats(); requestDesktopSessions() })
    activateRail(controlsPage)
  }

  /* A remote saved node is data, not a locally owned launch record. Only an
     exact node/session match from the current connection's inventory can open
     the existing desktop conversation controller. Everything else stays a
     read-only view of the native record, including its saved reply. */
  function showAuthoritativeTreeNodeControls(nodeId, { activate = true } = {}) {
    const node = authoritativeTreeSnapshot?.nodes.find(candidate => candidate.id === nodeId)
    if (source !== 'relay' || !node) return
    const row = desktopRowFor(node.sessionId)
    if (activate && row && row.nodeId === node.id) {
      showDesktopSessionControls(row, { nativeNodeId: node.id })
      return
    }
    disposeRailSaid()
    disposeRailChat()
    clearBoard()
    currentRailTreeNode = node
    const tree = authoritativeTreeSnapshot.trees.find(candidate => candidate.id === node.treeId)
    const reason = row?.nodeId === node.id ? 'A conversation is available. Check its availability to open it.'
      : row ? 'The current conversation does not match this saved node.'
      : node.sessionId ? 'No current conversation is available for this saved node.'
        : 'This saved node has no active conversation.'
    controlsPage.innerHTML = `
      ${railTitleRow({ back: { aria: 'Back to the fleet overview' }, title: 'Saved agent on your computer' })}
      <div class="rail-scroll" data-native-tree-details>
        <div class="agent-head board-head"><div><div class="an">${escapeMarkup(node.name || node.role || 'Agent')}</div><div class="ar">${escapeMarkup(tree?.name || node.treeId)}</div></div></div>
        <p class="rail-prose" role="status">${escapeMarkup(reason)} These saved details are read-only.</p>
        <div class="rail-sec">Saved status</div><p class="rail-prose">${escapeMarkup(node.status)}</p>
        ${typeof node.statusNote === 'string' && node.statusNote ? `<p class="rail-prose" data-native-status-note>${escapeMarkup(node.statusNote)}</p>` : ''}
        <div class="rail-sec">Saved prompt</div><p class="rail-prose rail-said">${escapeMarkup(typeof node.message === 'string' ? node.message : '')}</p>
        <div class="rail-sec">Saved reply</div><p class="rail-prose rail-said">${escapeMarkup(typeof node.reply === 'string' ? node.reply : '')}</p>
        <button type="button" class="ctl-btn" data-native-conversation-check>Check conversation availability</button>
      </div>`
    const epoch = desktopEpoch
    controlsPage.querySelector('[data-native-conversation-check]').addEventListener('click', async () => {
      await refreshDesktopSessions()
      if (destroyed || epoch !== desktopEpoch || source !== 'relay'
          || currentRailTreeNode?.id !== nodeId || !controlsPage.querySelector('[data-native-tree-details]')) return
      const current = authoritativeTreeSnapshot?.nodes.find(candidate => candidate.id === nodeId)
      if (current?.sessionId === node.sessionId) showAuthoritativeTreeNodeControls(nodeId)
    })
    controlsPage.querySelector('.rail-back').addEventListener('click', showStats)
    if (activate) activateRail(controlsPage)
  }

  function refreshHydratedRailChat(client) {
    const mine = railChat
    const store = treeStore
    if (destroyed || !mine || transcriptStore !== client) return
    // The first mount can precede the asynchronous disk read. Refresh that
    // exact rail when the cache is ready, without interrupting its composer
    // or letting a delayed blur rebuild a different node or replacement view.
    deferRailRebuildWhileTyping(() => {
      const current = store?.getNode(mine.nodeId)
      if (destroyed || railChat !== mine || treeStore !== store || transcriptStore !== client
          || currentRailTreeNode?.id !== mine.nodeId || !current || current.sessionId !== mine.sessionId
          || !mine.root?.isConnected || !controlsPage.classList.contains('is-active')) return
      // Live updates already own this rail. Hydration only replaces the
      // saved-history fallback; it must not tear down an in-flight stream.
      if (mine.stream || sessionTranscripts.get(mine.sessionId)?.length || !client.get(mine.nodeId)?.lines?.length) return
      showTreeNodeControls(current)
    })
  }

  function treeChatHeaderMetaFor(nodeId) {
    return {
      read() {
        const current = treeStore?.getNode(nodeId)
        if (!current) return {}
        const snapshot = {}
        const sessionId = typeof current.sessionId === 'string' && current.sessionId ? current.sessionId : null
        const profileId = sessionId ? sessionProfileIds.get(sessionId) : null
        const cwd = profileId ? profileCwds.get(profileId) : null
        if (sessionId
            && sessionNodeIds.get(sessionId) === current.id
            && startProfileId(profileId)
            && typeof cwd === 'string' && cwd.trim()) {
          snapshot.path = { source: 'profile-cwd', value: cwd }
        }
        const key = current.status
        if (Object.hasOwn(NODE_STATUS_WORDS, key)
            && (key !== 'running' || nodeSessionLive(current))
            && (key !== 'starting' || startingNodeIds.has(current.id))) {
          snapshot.status = { source: 'session-node-status', key }
        }
        return snapshot
      },
      subscribe(listener) {
        const removeStatusListener = registerNodeStatusListener(nodeId, listener)
        profileMapListeners.add(listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          try { removeStatusListener() } finally { profileMapListeners.delete(listener) }
        }
      },
    }
  }

  function nodeStartReason(node) {
    if (!node) return ''
    const pendingResume = nodeLaunchQueues.get(node.id)?.resume === true
    if (node.sessionId && !pendingResume) return ''
    const queue = nodeLaunchQueues.get(node.id)?.queue || treeLaunchQueues.get(node.treeId)
    const state = queue?.nodeState(node.id)
    if (startingNodeIds.has(node.id)) return 'Starting this agent. Waiting for its session to connect.'
    if (state?.phase === 'waiting') return `${state.reason || 'Waiting for resource admission.'} This agent is queued and will retry automatically. Use Pause queue or Cancel queued in the agent panel or Fleet overview.`
    if (state?.phase === 'paused') return pendingResume
      ? 'Resume is paused. The saved conversation and queued messages are kept. Use Resume queue or Cancel queued in the agent panel or Fleet overview.'
      : 'This agent’s start queue is paused. Its brief is kept on this page. Use Resume queue or Cancel queued in the agent panel or Fleet overview.'
    if (state?.phase === 'cancelled') return 'This queued start was cancelled. The unstarted agent and its brief remain set on the tree.'
    if (state?.phase === 'preparing') return 'Preparing this tree’s agent identities. This agent’s brief is kept on this page.'
    if (state?.phase === 'admitting') return 'Checking this agent’s identity and resource admission before starting its session.'
    if (state?.phase === 'queued') return 'This agent is queued. It will start when its turn and resource admission allow.'
    return ''
  }

  function refreshLaunchStatus() {
    notifyNodeStatusListeners()
    const current = currentRailTreeNode && treeStore?.getNode(currentRailTreeNode.id)
    if (current) repaintRailStatus(current)
  }

  /* ONE chat config for a tree node, serving the compact card AND the rail's
     Chat tab. The conversation shown is this window's transcript when it has
     one; else the durable pair the store kept (the ask and the last reply),
     so a chat over a node that has plainly spoken never opens empty.
     Renderer memory only; the store stays the record. */
  const imageConversations = new Map()
  unsubs.push(() => { for (const entry of imageConversations.values()) entry.dispose(); imageConversations.clear() })
  function imageConversationFor(nodeId) {
    const live = treeStore?.getNode(nodeId)
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!live?.sessionId || typeof bridge?.imageQueue !== 'function') {
      return null
    }
    const store = treeStore, sessionId = live.sessionId
    let conversation = imageConversations.get(sessionId)
    if (!conversation) {
      const isCurrent = () => !destroyed && treeStore === store
        && store.getNode(nodeId)?.sessionId === sessionId && window.mcAgent === bridge
      conversation = createImageConversation({ bridge, sessionId, isCurrent,
        mayDrain: () => {
          const node = store.getNode(nodeId)
          return isCurrent() && !nodeBusy(node) && !nodeSessionEnded(node) && node.status !== 'interrupted'
            && !pendingModelChoice(node) && !pendingModelDrainHolds.has(sessionId)
            && !nodeCleanupPending(node) && !nodeReplacementFlight.busy(nodeId)
        },
        subscribeReady: listener => registerNodeStatusListener(nodeId, listener),
        readinessRevision: () => {
          const currentNode = store.getNode(nodeId)
          const nodeSession = typeof currentNode?.sessionId === 'string' && currentNode.sessionId
            ? currentNode.sessionId : sessionId
          const turn = typeof currentNode?.lastTurnId === 'string' && currentNode.lastTurnId
            ? currentNode.lastTurnId : 'none'
          const status = typeof currentNode?.status === 'string' && currentNode.status
            ? currentNode.status : 'unknown'
          return `${nodeSession}:${turn}:${status}:${nodeBusy(currentNode) ? 'busy' : 'idle'}`
        },
        interrupt: () => bridge.interrupt({ sessionId }),
      })
      imageConversations.set(sessionId, conversation)
    }
    return conversation
  }
  const submittedImageRecoveries = new Map()
  unsubs.push(() => { for (const recovery of submittedImageRecoveries.values()) { recovery.unsubscribe?.(); recovery.deliveryUnsubscribe?.() } submittedImageRecoveries.clear() })
  function continueSubmittedImages(nodeId) {
    const recovery = submittedImageRecoveries.get(nodeId)
    if (!recovery || recovery.flight) return recovery?.flight || Promise.resolve(false)
    recovery.flight = (async () => {
      const live = treeStore?.getNode(nodeId)
      if (destroyed || treeStore !== recovery.store || !live?.sessionId || live.sessionId === recovery.sourceSessionId
        || live.sessionId !== recovery.authorizedSessionId
        || nodeSessionEnded(live) || nodeBusy(live) || nodeCleanupPending(live) || nodeReplacementFlight.busy(nodeId)) return false
      const successorId = live.sessionId
      const next = imageConversationFor(nodeId)
      if (!next) return false
      next.hold()
      const view = await next.refresh()
      if (treeStore !== recovery.store || treeStore?.getNode(nodeId)?.sessionId !== successorId
        || !next.isCurrentOwner(recovery.ownerContext)) return false
      const authority = view?.authority
      if (!authority || authority.conversationId !== recovery.conversationId
        || authority.ownerId !== recovery.ownerContext.ownerId || authority.currentEpoch !== recovery.ownerContext.currentEpoch
        || view.state !== 'ready' || !view.entries.some(row => row.envelopeId === recovery.envelopeId)) return false
      if (view.destinationSessionId !== successorId) {
        // A conflict never refreshes generation and retries an old mutation.
        if (recovery.transferAttempted) return false
        recovery.transferAttempted = true
        const transferred = await next.transferDestination({ destinationSessionId: successorId, view, operationId: recovery.transferOperationId })
        if (!transferred?.ok || !transferred.reconciled || transferred.detached) return false
      }
      if (treeStore?.getNode(nodeId)?.sessionId !== successorId || !next.isCurrentOwner(recovery.ownerContext)) return false
      recovery.successor = next
      const deliveryUnsubscribe = next.observeEnvelope({ envelopeId: recovery.envelopeId,
        conversationId: recovery.conversationId, ownerContext: recovery.ownerContext },
        recovery.onState, recovery.result.isCurrent)
      if (!deliveryUnsubscribe) return false
      recovery.deliveryUnsubscribe?.()
      recovery.deliveryUnsubscribe = deliveryUnsubscribe
      recovery.sourceConversation.detachEnvelopeListener(recovery.envelopeId, recovery.onState)
      recovery.unsubscribe?.()
      next.releaseHold()
      // The original Send authorized this known-not-sent intent. Read/hydration
      // alone did not; this recovery continuation carries that authorization.
      await next.signalReady()
      return true
    })().finally(() => { recovery.flight = null })
    return recovery.flight
  }
  async function sendImageIntent(nodeId, draft, onState) {
    const store = treeStore, source = store?.getNode(nodeId), sessionId = source?.sessionId
    const conversation = imageConversationFor(nodeId)
    if (!conversation) return { ok: false, code: 'IMAGE_QUEUE_BRIDGE_UNAVAILABLE' }
    const existing = submittedImageRecoveries.get(nodeId)
    if (existing && existing.operationId === draft.operationId) return existing.result
    const admitted = await conversation.submit({ ...draft, model: sessionModelOverride.get(sessionId) || null }, onState)
    if (!admitted.ok || admitted.detached || treeStore !== store) return admitted
    const live = store.getNode(nodeId)
    if (!live || live.sessionId !== sessionId || !nodeSessionEnded(live)) return admitted
    if (existing && !existing.successor) return { ...admitted, state: 'held', code: 'IMAGE_QUEUE_RECOVERY_PENDING' }
    conversation.hold()
    const recovery = { store, sourceSessionId: sessionId, ownerContext: admitted.ownerContext,
      conversationId: admitted.conversationId, envelopeId: admitted.entry.envelopeId, operationId: draft.operationId,
      transferOperationId: crypto.randomUUID(), transferAttempted: false, flight: null, successor: null,
      sourceConversation: conversation, onState: typeof onState === 'function' ? onState : () => {}, authorizedSessionId: sessionId }
    recovery.result = { ...admitted, state: 'held', code: 'IMAGE_QUEUE_RECOVERY_PENDING',
      isCurrent: () => !destroyed && treeStore === store && store.getNode(nodeId)?.sessionId === recovery.authorizedSessionId
        && (recovery.successor || conversation).isAdmissionOwnerCurrent(recovery.ownerContext) }
    submittedImageRecoveries.set(nodeId, recovery)
    recovery.unsubscribe = registerNodeStatusListener(nodeId, () => { void continueSubmittedImages(nodeId) })
    let refusal = null
    let resumed = false
    try { resumed = await resumeNodeSession(live, { deliverQueued: false, deferSeed: true, onRefused: value => { refusal = value } }) }
    catch (error) {
      recovery.result.code = error?.code || 'IMAGE_QUEUE_RECOVERY_UNCONFIRMED'
      return recovery.result
    }
    if (!resumed) {
      recovery.result.code = refusal?.code || 'IMAGE_QUEUE_RECOVERY_PENDING'
      return recovery.result
    }
    // The accepted resume authorizes this exact successor even while it is busy.
    // Durable admission can finish in the composer before dispatch becomes ready.
    recovery.authorizedSessionId = store.getNode(nodeId)?.sessionId
    await continueSubmittedImages(nodeId)
    return recovery.result
  }

  const ACCOUNT_RETRY_DRAFT_REASON = 'Start this agent first. The retry policy becomes available after this agent starts.'
  function accountRetryChipState(nodeId) {
    const node = treeStore?.getNode(nodeId)
    const coordinator = recoveryCoordinator()
    const policy = coordinator?.retryPolicy(nodeId)
    const recovering = coordinator?.isRecovering(nodeId) === true
    const writable = currentDataSource() === 'local' && isWriteEnabled(START_CONTROL_FLAG) && !recovering
    const value = policy?.enabled ? (policy.waitForReset === true ? 'wait' : 'keep') : 'off'
    const unstartedDraft = Boolean(node?.status === 'draft' && !node.sessionId)
    return {
      value,
      status: unstartedDraft ? ACCOUNT_RETRY_DRAFT_REASON : (coordinator?.retryStatus(nodeId, { compact: true }) || ''),
      disabled: unstartedDraft || !writable,
      showAction: value !== 'off',
      actionDisabled: unstartedDraft || !writable || policy?.state === 'working',
    }
  }
  async function applyAccountRetryChip(nodeId, value, output = null) {
    if (!['off', 'keep', 'wait'].includes(value)) return false
    const node = treeStore?.getNode(nodeId)
    const coordinator = recoveryCoordinator()
    if (!node || !coordinator) return false
    if (node.status === 'draft' && !node.sessionId) {
      if (output) output.textContent = ACCOUNT_RETRY_DRAFT_REASON
      return false
    }
    if (currentDataSource() !== 'local' || !isWriteEnabled(START_CONTROL_FLAG) || coordinator.isRecovering(nodeId)) {
      if (output) output.textContent = currentDataSource() !== 'local' ? MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY : startControlOffReason()
      return false
    }
    try {
      const policy = coordinator.retryPolicy(nodeId)
      if (value === 'off') await coordinator.cancelAccountRetries(nodeId)
      else if (policy?.enabled) await coordinator.setWaitForResets(nodeId, value === 'wait')
      else await continueNodeOnAnotherAccount(node, output, {
        waitForReset: value === 'wait',
        allowedProviders: policy?.allowedProviders || null,
      })
      notifyNodeStatusListeners()
      return true
    } catch (error) {
      if (output) output.textContent = error.message || String(error)
      return false
    }
  }
  async function tryAccountRetryNow(nodeId, output = null) {
    const node = treeStore?.getNode(nodeId)
    const coordinator = recoveryCoordinator()
    if (!node || !coordinator) return false
    if (node.status === 'draft' && !node.sessionId) {
      if (output) output.textContent = ACCOUNT_RETRY_DRAFT_REASON
      return false
    }
    const policy = coordinator.retryPolicy(nodeId)
    if (!policy?.enabled) return false
    try {
      await continueNodeOnAnotherAccount(node, output, {
        waitForReset: policy.waitForReset === true,
        allowedProviders: policy.allowedProviders || null,
      })
      notifyNodeStatusListeners()
      return true
    } catch (error) {
      if (output) output.textContent = error.message || String(error)
      return false
    }
  }

  function treeChatConfigFor(node) {
    if (!node) return null
    /* The example's working tree, and any example node holding an example
       session, gets the example's own chat: the same component and the same
       history, with no sender, picker or queue door (exampleChatConfigFor). */
    if (mockSource() && (node.sessionId || sampleRun?.owns(node.id))) return exampleChatConfigFor(node)
    let chatRoot = null
    const headerMeta = treeChatHeaderMetaFor(node.id)
    const chatChips = {
      // Machine preferences do not prove the running session's sandbox.
      tier: () => ({ label: 'Permission settings' }),
      /* T158 (chat-lifecycle, Controller correction 2026-09-17, Worker 82's
       * on-screen walk): this used to answer null -- hiding the chip
       * entirely, the same `hidden` paintChips() sets the effort chip
       * without gating on a chosen value at all -- until a same-provider
       * override already existed. A person can never click a chip that is
       * never there, so the only door onto a running agent's model was the
       * Actions overflow row, which Worker 82 could not find on screen. The
       * chip must be there whenever there is a session to switch, showing
       * the model that IS running (override, or the tier it started on)
       * so a click always has something to open. */
      model: () => {
        const live = treeStore ? treeStore.getNode(node.id) || node : node
        const tier = LAUNCH_TIERS.find(row => row.id === live.tier) || null
        const requested = sessionModelOverride.get(live.sessionId) || null
        const wanted = requested || tier?.model || null
        if (!wanted) return { label: 'Choose model' }
        const choice = sessionModelChoices(live.tier).find(c => c.model === wanted)
        const label = choice ? choice.label : wanted
        const pending = pendingModelChoice(live)
        const appliedLabel = !live.sessionId || requested ? 'Next: ' + label : label
        return { label: pending
          ? appliedLabel + ' · Pending: ' + (pending.label || LAUNCH_TIERS.find(row => row.id === pending.tierId)?.label || pending.tierId)
          : appliedLabel }
      },
      onOpenModel: chat => chat?.openActions?.('model'),
      onOpenMode: chat => chat?.openActions?.('provider-mode'),
      onOpenEffort: chat => chat?.openActions?.('effort'),
      accountRetry: () => accountRetryChipState(node.id),
      onAccountRetryChange: (value, chat) => applyAccountRetryChip(node.id, value, chat?.querySelector('[data-chat-chip="account-retry-status"]')),
      onAccountRetryNow: chat => tryAccountRetryNow(node.id, chat?.querySelector('[data-chat-chip="account-retry-status"]')),
      // Keep the draft and attachments mounted while changing machine preferences.
      onOpenTier: () => { if (!destroyed) chatRoot?.openActions?.('permission-settings') },
      onCycleTier: null,
      subscribe: listener => registerNodeStatusListener(node.id, listener),
    }
    /* A NODE WITH NO SESSION STILL HAS A CONVERSATION, and it used to open
     * nothing. See CHAT_NOT_RUNNING's note in src/fleet-tree-copy.js for the
     * owner report this closes: a refused start leaves the node `failed` with
     * a null session id, so on a build that cannot start the picked engine
     * EVERY node is one of these and both chat surfaces were dead.
     *
     * What opens is the real record and nothing invented: the brief the person
     * typed, the reply if one was ever kept, the actions that still apply, and
     * a disabled message box carrying the node's OWN refusal sentence. No
     * onSend, deliberately -- there is nothing to send to, and composerReason
     * makes buildChat refuse `send` before its seeded simulator can be
     * reached, so this chat cannot answer itself. */
    if (!node.sessionId) {
      const history = transcriptStore?.get(node.id)?.lines?.slice() || []
      if (!history.length && node.message) history.push({ who: 'you', text: node.message, at: null })
      const kept = nodeReplies.get(node.id) || node.reply
      if (kept) history.push({ who: 'agent', text: kept, at: null })
      const reason = typeof node.statusNote === 'string' ? node.statusNote.trim() : ''
      return {
        title: treeNodeName(node),
        subtitle: mockSource() ? 'Example agent · not running' : CHAT_NOT_RUNNING.subtitle,
        headerMeta,
        chips: chatChips,
        onReady: root => { chatRoot = root },
        roleKey: node.role,
        accentId: node.id,
        history: restoreDiffHistory(node.id, history),
        onOpenDiff: selection => openChatDiff({ ...selection,
          sessionId: (treeStore?.getNode(node.id) || node).sessionId || null }),
        /* NEVER THE SIMULATOR, ON EITHER SURFACE. buildChat's `seed` defaults
           to 3, and its rule is `history.length ? [] : CHAT.slice(start, seed)`
           -- so a chat opened over an EMPTY history renders three canned
           bubbles from the demonstration fixture. The compact card pinned
           `seed: 0` in 5f394a4; the rail's Chat tab spreads this config and
           pinned nothing, so it fabricated a conversation for any node whose
           transcript was empty and then dropped it on the next rebuild. That
           is half of "messages in history disappear" (owner, 2026-08-18). It
           belongs on the config rather than on either mount, because a rule
           kept in two places is a rule that drifts again. */
        seed: 0,
        composerReason: nodeStartReason(node) || (reason ? CHAT_NOT_RUNNING.refused(reason) : CHAT_NOT_RUNNING.neverStarted),
        status: {
          busy: () => false,
          subscribe: listener => registerNodeStatusListener(node.id, listener),
          composerReason: () => {
            const current = treeStore?.getNode(node.id) || node
            const note = typeof current.statusNote === 'string' ? current.statusNote.trim() : ''
            return nodeStartReason(current) || (note ? CHAT_NOT_RUNNING.refused(note) : CHAT_NOT_RUNNING.neverStarted)
          },
        },
        actions: () => chatActionRowsFor(node),
        commonActions: () => commonChatActionsFor(node),
        actionsNote: PALETTE_PANEL.footer,
      }
    }
    let history = sessionTranscripts.get(node.sessionId) || []
    /* THE RECORD IS READ BACK, AND UNTIL NOW IT NEVER WAS.
     *
     * MEASURED ON A STAGED PACKAGED BUILD, 2026-08-18, three separate runs. A
     * node with two real Codex turns holds five lines in the durable store --
     * the brief, the tree context, "391", the second question, "81". Close the
     * app, open it again, press the circle: BOTH surfaces drew two bubbles, the
     * FIRST question above the SECOND answer. The conversation a person comes
     * back to was not the conversation they had, and it did not merely lose
     * lines -- it paired a question with an answer to a different question. On
     * a research machine that is a fabricated result, not a rendering glitch.
     *
     * THE CAUSE WAS ONE MAP. `sessionTranscripts` is window memory, keyed by
     * session id, and a new window has none. So `history` was empty for every
     * node on every restart and the `!history.length` fallback below fired --
     * that fallback composes `node.message` (the brief) with `node.reply` (the
     * LATEST reply), which is the pairing that was observed. The fallback is
     * right for what it was written for, a node whose conversation was never
     * recorded; it was standing in for a record that exists.
     *
     * IT IS THE SAME READ THE RESUME PATH ALREADY MAKES -- resumeNodeSession()
     * takes `transcriptStore.get(node.id).lines` and seeds the map with it, so
     * the store was already trusted for the harder job of feeding an agent its
     * own past. Reading it to SHOW a person that past is the smaller claim.
     *
     * THE MAP IS NOT SEEDED FROM HERE, deliberately. transcriptAppend() writes
     * whatever the map holds back to the store, so seeding it under a session id
     * this window never opened would put the read back on the write path, and
     * one appended line could then rewrite the record. Reading is reading. */
    if (!history.length) {
      const saved = transcriptStore ? transcriptStore.get(node.id) : null
      const savedLines = saved && Array.isArray(saved.lines) ? saved.lines : []
      if (savedLines.length) history = savedLines
    }
    if (!history.length) {
      history = []
      if (node.message) history.push({ who: 'you', text: node.message, at: null })
      const kept = nodeReplies.get(node.id) || node.reply
      if (kept) history.push({ who: 'agent', text: kept, at: null })
    }
    /* A RECORD THAT LOST LINES SAYS SO, in the conversation, where the gap is.
       A shortened excerpt shown as if it were the whole conversation is the
       kind of quiet loss this whole area is being cured of. */
    const savedRecord = transcriptStore ? transcriptStore.get(node.id) : null
    if (savedRecord && savedRecord.trimmed > 0 && history.length) {
      history = [{ who: 'note', text: TRANSCRIPT_TRIMMED_NOTE, at: null }, ...history]
    } else if (savedRecord && typeof savedRecord.before === 'string' && savedRecord.before && history.length) {
      /* A disk-backed record reports `before` (a cursor to its older pages),
         never `trimmed`, so the line above never fired for it (T1404). The
         older messages are kept, not lost, so the line says where they are,
         and it stays in view while Search hides everything it did not look at. */
      history = [{ who: 'note', text: TRANSCRIPT_OLDER_NOTE, at: null, keepInSearch: true }, ...history]
    }
    history = restoreDiffHistory(node.id, history)
    const pickerBridge = typeof window === 'undefined' ? null : window.mcAgent
    const pickAttachment = typeof pickerBridge?.pickAttachment === 'function'
      ? pickerBridge.pickAttachment.bind(pickerBridge)
      : null
    const pickMention = typeof pickerBridge?.pickMention === 'function'
      ? pickerBridge.pickMention.bind(pickerBridge)
      : null
    const pasteAttachment = typeof pickerBridge?.pasteAttachment === 'function'
      ? pickerBridge.pasteAttachment.bind(pickerBridge)
      : null
    /* THE QUEUE DOOR'S OWN sessionId, READ FRESH -- same reason status.busy()
       below re-fetches the node rather than trusting the one this closure was
       built with. A tree node this rail was opened for BEFORE the real engine
       handed back a session id closes over `node.sessionId` as whatever it
       was at that moment -- null, on a node opened the instant after Start,
       before the async handshake lands. queue.add() already dodges this by
       routing every door through queueForSession(node, …), which re-fetches
       internally; list/cancel/replace/sendNow/subscribe read node.sessionId
       directly and did not.
       MEASURED 2026-09-03, driving a REAL just-started session (tools/
       queue-strip-controls-qa.mjs): a message queued busy (add(), via
       queueForSession's fresh fetch) enqueues under the CORRECT session id
       and the composer clears with no "sent" bubble and no refusal note --
       success, by every visible sign. The strip then reads
       {hidden:true, rows:[]}: paintQueueStrip's queue.list() looked up the
       STALE (null) id and found an empty queue that was never the one the
       message actually went into. A message that queued correctly becomes
       permanently invisible to Send-now and Unqueue on that same panel,
       because cancel()/sendNow() would have queried the same wrong id. */
    const liveSessionId = () => (treeStore ? treeStore.getNode(node.id) || node : node).sessionId
    return {
      title: treeNodeName(node),
      /* A SESSION ID IS NOT A LIVE SESSION. This header said "live session"
         over a node whose engine child was killed when the app last closed,
         which is the sentence a person believed while typing into it. */
      subtitle: mockSource() ? 'Example agent · not running' : nodeSessionLive(node) ? 'your agent · live session' : ENDED_SESSION.subtitle,
      headerMeta,
      roleKey: node.role,
      accentId: node.id,
      /* THE WORK, MERGED INTO THE WORDS. A chat opened halfway through a turn
         has to show the commands already run, or a person watching a five-
         minute turn sees an empty log and concludes the product is hung -- the
         exact reading the owner reported. */
      history: mergeActionsIntoHistory(markTreeContext(history, node.sessionId), node.sessionId,
        { settled: !mockSource() && !nodeSessionLive(node) }),
      onOpenDiff: selection => openChatDiff({ ...selection, sessionId: liveSessionId() || null }),
      /* BOTH SURFACES REGISTER THEMSELVES THROUGH THE SHARED CONFIG. The rail's
         Chat tab and the compact card each spread this object, so neither can
         be the one that forgot to. */
      onReady: root => { chatRoot = root; registerChatSurface(liveSessionId(), root) },
      /* See the note on the other return: seed 0 on the CONFIG, so neither
         surface can fall through to the demonstration excerpt. */
      seed: 0,
      imageOutbox: imageConversationFor(node.id),
      onImageIntent: (draft, onState) => sendImageIntent(node.id, draft, onState),
      onSend: (text, handlers) => treeCardSend(treeStore ? treeStore.getNode(node.id) || node : node, text, {
        ...handlers,
        reply: (said, delivery) => {
          if (delivery?.sessionId && chatRoot?.isConnected && chatRoot !== railChat?.root) return
          handlers.reply(said)
        },
      }),
      ...(pickAttachment ? { onAttach: async () => {
        const picked = await pickAttachment({ sessionId: liveSessionId() }).catch(() => null)
        return picked
      } } : {}),
      ...(pickMention ? { onMention: async () => {
        try { return await pickMention({ sessionId: liveSessionId() }) }
        catch (error) { return { ok: false, sentence: mentionRefusalSentence(error) } }
      } } : {}),
      /* CTRL+V, IMAGE TO THE AGENT (owner R10). components.js reads the
         person's own paste event and hands this the bytes (base64) and
         mime; this is the only place a code-to-sentence mapping happens for
         it, the same split onSend's fail()/queued() already keep -- the
         composer stays free of IPC error codes and only ever shows a
         resolved sentence. */
      ...(pasteAttachment ? { onPasteAttachment: async (data, mime) => {
        try {
          /* holdKey: WHICH CONVERSATION, not which session. The rail shows
             saved conversations, and after a restart `node.sessionId` is an id
             minted in a previous run that main cannot know -- measured
             2026-09-07: the boundary refused before writing anything and the
             person was told only "That pasted image could not be attached".
             Naming the node lets the file be saved and held with the
             conversation; it is bound to a session at send time, where
             ownership is checked exactly as before. */
          return await pasteAttachment({ sessionId: liveSessionId(), ...(node.id ? { holdKey: node.id } : {}), data, mime })
        } catch (error) {
          return {
            ok: false,
            sentence: pasteRefusalSentence(error),
          }
        }
      } } : {}),
      /* The composer's four live powers (iteration 6): the busy feed for the
         send↔stop morph, the queue face over this session's outbox (the
         SESSION_OUTBOX_EVENT import finally has its subscriber), the popup's
         rows, and the stop verb. All closures — the component stays
         fleet-agnostic, and agent.js/comms.js pass none of these. */
      status: {
        busy: () => nodeBusy(treeStore ? treeStore.getNode(node.id) || node : node),
        subtitle: () => mockSource() ? 'Example agent · not running'
          : nodeSessionLive(treeStore?.getNode(node.id) || node) ? 'your agent · live session' : ENDED_SESSION.subtitle,
        subscribe: listener => {
          const unsubscribe = registerNodeStatusListener(node.id, () => {
            if (chatRoot?.isConnected && chatSurfaceSessions.get(chatRoot) !== liveSessionId()) registerChatSurface(liveSessionId(), chatRoot)
            listener()
          })
          return () => { unsubscribe(); if (chatRoot) unregisterChatSurface(chatRoot) }
        },
        /* THE REAL CURRENT STEP, NEVER A SYNTHESISED ONE. nodeActivity is the
           same map treeContextFeed() and repaintRailStatus() already read for
           "what it is doing right now" -- one map, three readers, so this
           panel's working row cannot say something the rest of the page does
           not also believe. See the activity branch of the session event
           listener below (where nodeActivity is set) for the companion half:
           it now tells this status's subscribers on every line, not only at
           turn start and end, which is what let the row go stale for the
           length of a whole turn before this fix. */
        step: () => nodeActivity.get(node.id) || '',
        metrics: () => {
          /* Resume and Start over can move this node onto a new session while
             the same chat config is mounted. Read both identities fresh, then
             ask only the real buffer for that exact active turn. */
          const current = treeStore ? treeStore.getNode(node.id) || node : node
          const sessionId = typeof current.sessionId === 'string' && current.sessionId ? current.sessionId : null
          const turnId = sessionId ? sessionOpenTurns.get(sessionId) : null
          const buffer = sessionId ? sessionActions.get(sessionId) : null
          return turnId && buffer ? buffer.metrics(turnId) : {}
        },
      },
      queue: {
        list: () => outboxList(liveSessionId()).map(entry => ({
          id: entry.id,
          text: entry.text,
          ...(entry.deliveryUnconfirmed ? { deliveryUnconfirmed: true } : {}),
          /* The store's own name for why a row is still waiting (a Send now
             whose stop never reported idle inside the release budget). The
             strip paints it; without it here the row would go quietly back
             to "Send now" and the person would read a wait as a no-op. */
          ...(typeof entry.heldReason === 'string' && entry.heldReason ? { heldReason: entry.heldReason } : {}),
        })),
        hold: request => {
          if (request.text) {
            notePersonSpokeTo(treeStore, node, request.text)
            // Commands use the console parser immediately, never a durable
            // queue that the completion listener sends straight to the model.
            const slash = parseSlashCommand(request.text)
            if (slash && (slash.kind !== 'cloud' || slash.sentence)) return { ok: true, direct: true }
          }
          return outboxHoldForSend(liveSessionId(), request)
        },
        /* The console vocabulary works here too: /interrupt typed while the
           agent is busy is EXACTLY when it matters, and this add is the one
           path a busy composer send takes — parsed before anything queues,
           same rule as treeCardSend's own first line. */
        add: text => {
          /* The busy composer is the person typing at a circle that is
             working, which is most of what typing at a tree circle IS. Same
             door and same reason as treeCardSend's first line. */
          notePersonSpokeTo(treeStore, node, text)
          const slash = parseSlashCommand(text)
          if (slash?.kind === 'cloud' && slash.sentence) return { ok: false, sentence: slash.sentence }
          if (slash && slash.kind !== 'cloud') {
            if (slash.kind === 'help' || slash.kind === 'unknown') return { ok: false, sentence: slash.sentence }
            if (slash.kind === 'loop') {
              if (slash.sentence) return { ok: false, sentence: slash.sentence }
              return openLoopFor(treeStore?.getNode(node.id) || node, slash.minutes)
            }
            if (slash.kind === 'goal') {
              /* This is the busy composer's synchronous contract, so the write
                 settles on the existing live status line. It is intercepted
                 before the session outbox exactly like the card path below:
                 `/goal` is a command to this console, never a message that
                 waits in the queue to be said to the model.

                 A BUSY CIRCLE IS THE NORMAL PLACE TO SET A GOAL, not an edge
                 case -- the person watches a turn run, decides they want the
                 whole job done, and types it. The host records the goal
                 straight away and starts the first self-started turn at the
                 next boundary, so this path does not refuse for busyness. */
              if (slash.sentence) return { ok: false, sentence: slash.sentence }
              setOrgStatus(goalPendingSentence(), 'busy', { sticky: true })
              void runGoalFor(node, slash)
                .then(result => {
                  const state = result.ok ? 'ok' : 'refuse'
                  setOrgStatus(result.sentence, state)
                  setWorkspaceStatus(node.id, result.sentence, state)
                })
              return { ok: true }
            }
            if (slash.kind === 'request') {
              /* A rule typed while the agent is BUSY is exactly when it
                 matters, and it must never queue as a message to the model.
                 This contract is synchronous, so the filing runs async and
                 the one-sentence answer lands on the page status line — the
                 same surface the other busy-path commands report through. */
              if (!slash.rest) return { ok: false, sentence: requestUsageSentence(slash.scope) }
              void fileStandingRequestFor(treeStore ? treeStore.getNode(node.id) || node : node, slash)
                .then(result => {
                  const state = result.ok ? 'ok' : 'refuse'
                  setOrgStatus(result.sentence, state)
                  setWorkspaceStatus(node.id, result.sentence, state)
                })
              return { ok: true }
            }
            if (slash.kind === 'task' || slash.kind === 'ask') {
              /* Built the same way as /Request, just above: never queued as a
                 message to the model, filed async, answered on the status
                 line. */
              if (!slash.rest) return { ok: false, sentence: ledgerCommandUsageSentence(slash.kind, slash.scope) }
              void fileStandingRequestFor(treeStore ? treeStore.getNode(node.id) || node : node, slash)
                .then(result => {
                  const state = result.ok ? 'ok' : 'refuse'
                  setOrgStatus(result.sentence, state)
                  setWorkspaceStatus(node.id, result.sentence, state)
                })
              return { ok: true }
            }
            if (slash.action === 'queue') {
              if (!slash.rest) return { ok: false, sentence: QUEUE_PANEL.emptyQueueCommand }
              return queueForSession(node, slash.rest)
            }
            const sink = chatWorkspace ? statusSink(node) : { textContent: '' }
            void runPaletteAction(slash.action, treeStore ? treeStore.getNode(node.id) || node : node, sink)
            return { ok: true }
          }
          return queueForSession(node, text)
        },
        cancel: id => outboxCancel(liveSessionId(), id),
        /* THE UP-ARROW WALK'S WRITE (owner: "let userrs press up from the chat
           to get to their qued messages and edit them"). It rewrites ONE
           waiting message in place -- same position, same id -- because
           cancel+add would send a corrected FIRST message LAST, and because
           the walk anchors on the id across repaints.

           THE PARSE STAYS. `add` above parses slash commands before anything
           reaches the outbox, and treeCardSend does the same on the idle path,
           so `/goal`, `/Request…` and `/interrupt` are never delivered to the
           model as text. A queued message is drained straight to the model
           when the turn ends, so a replace that skipped the parse would be a
           third door around it. Rewriting a waiting message into a command is
           refused by name and the message keeps the words it had; the person
           still has Unqueue and an empty box, which is the path that parses. */
        replace: (id, text) => {
          const refusal = queuedMessageEditRefusal(text)
          if (refusal) return { ok: false, sentence: refusal }
          return outboxReplace(liveSessionId(), id, text)
        },
        /* "SEND NOW" ON A WAITING ROW, ANSWERED HONESTLY. The engine refuses
           an overlapping send by design (AGENT_TURN_ACTIVE), so while a turn
           runs there is no "into it" to send into and the only meaning "first"
           can carry is the head of the queue. The composer reaches this door
           only while busy -- idle, its own delivery path still sends the words
           for real -- and it reads the SAME session id list()/cancel() above
           read, so a row the strip is showing is a row this can move. */
        sendNow: id => {
          if (outboxList(liveSessionId()).find(entry => entry.id === id)?.deliveryUnconfirmed) return { ok: false, sentence: QUEUE_PANEL.blockedUnconfirmed }
          if (!outboxPromoteFront(liveSessionId(), id)) return { ok: false, sentence: QUEUE_PANEL.moveGone }
          /* Which sentence is true depends on whether a turn is actually
             running, and the door above turns out to be reachable when one is
             not -- see movedFrontIdle. nodeBusy() is the same authority the
             send path reads (on the live store node when there is one), so
             the answer the person gets matches the state the drain is in. */
          return { ok: true, sentence: movedFrontSentence({ turnRunning: nodeBusy(treeStore ? treeStore.getNode(node.id) || node : node) === true }) }
        },
        subscribe: listener => {
          const heard = event => {
            if (event?.detail?.sessionId === liveSessionId()) listener()
          }
          window.addEventListener(SESSION_OUTBOX_EVENT, heard)
          return () => window.removeEventListener(SESSION_OUTBOX_EVENT, heard)
        },
      },
      actions: () => chatActionRowsFor(node),
      commonActions: () => commonChatActionsFor(node),
      actionsNote: PALETTE_PANEL.footer,
      /* SEND NOW's host reservation on the tree conversation (T785), placed
         before the palette interrupt below and released when the words do not
         go. Capture the exact bridge and live session owner at reserve so a
         session rebind cannot redirect release to a replacement. The
         composer's Send now (components.js) is the only caller, and it reserves
         only for a held Send now, never a generic Halt. */
      onReserveHold: async () => {
        const bridge = typeof window === 'undefined' ? null : window.mcAgent
        const liveSessionId = (treeStore ? treeStore.getNode(node.id) || node : node).sessionId
        const heldBridge = bridge
        const heldSessionId = liveSessionId
        if (!heldSessionId || typeof heldBridge?.reserveSendNow !== 'function') return null
        try {
          const reserved = await heldBridge.reserveSendNow({ sessionId: heldSessionId })
          return reserved?.ok ? { bridge: heldBridge, sessionId: heldSessionId, token: reserved.token } : null
        } catch { return null }
      },
      onReleaseHold: hold => {
        /* Release the captured owner, best effort, catching the promise's
           rejection so a rejected release is never an unhandled rejection. */
        if (!hold || typeof hold.bridge?.releaseSendNow !== 'function' || hold.token == null) return
        try { Promise.resolve(hold.bridge.releaseSendNow({ sessionId: hold.sessionId, token: hold.token })).catch(() => {}) }
        catch { /* the host self-clears when the words land */ }
      },
      onStop: () => {
        const sink = { textContent: '' }
        return runPaletteAction('interrupt', treeStore ? treeStore.getNode(node.id) || node : node, sink)
          .then(result => ({
            ok: result?.ok !== false,
            settled: result?.settled === true,
            sentence: sink.textContent || PALETTE_PANEL.interruptDone,
          }))
      },
      /* THE INLINE APPROVAL STRIP'S DECIDE HANDLER (B1's contract, SendMessage
         2026-08-28): buildChat calls this with the id it was shown and one of
         accept/decline, and awaits the sentence back for its own closing note.
         Routed through the SAME settleApproval every other door uses, so this
         panel answering never disagrees with the rail card or another panel
         on the same session -- see settleApproval and the two adapter
         functions above chatActionRowsFor's approval card. sessionId is read
         fresh, not closed over, for the same reason status.busy() re-fetches
         the node: a decision can land after a rewind or resume moved this
         node onto a different session. */
      onApprovalDecision: (id, decision) => {
        const liveSessionId = (treeStore ? treeStore.getNode(node.id) || node : node).sessionId
        /* THROW ON FAILURE, NEVER RESOLVE. B1's contract: a resolved truthy
           string is read as SUCCESS -- posted as a note, buttons stay as they
           are, nothing re-enables. Only a throw/reject re-enables both buttons
           and shows the retry hint. settleApproval's {ok:false} case used to
           flow straight into `result.sentence` here, which is truthy, so a
           failed engine answer would have looked like a success note and left
           the buttons stuck disabled with no way to try again. */
        return settleApproval(liveSessionId, id, decision).then(result => {
          if (!result.ok) throw new Error(result.sentence)
          return result.sentence
        })
      },
      /* THE COMPOSER CHIPS' REAL STATE (B1's locked contract, SendMessage
       * 2026-08-28, superseding the earlier draft this replaces).
       *
       * "mode = the three real tiers" is the CONFINEMENT axis (guided/
       * standard/unrestricted), confirmed with B1 -- not LAUNCH_TIERS, which
       * has seven entries and is a per-node bundle fixed at start, not a
       * mode. currentConfinementLevel (declared beside composeConfinementLine,
       * above) is the same async bridge.confinement() read this file already
       * caches for the compose panel's safety paragraph; the AGENT chip reads
       * the bare id off that cache rather than opening a second channel to
       * the same fact. Never shown as the raw id (the plain-language gate's
       * own QUOTED_TIER_KEY rule says why): CHIP_TIER_LABEL below is a
       * Title-cased word, not TIER_CHOICES[].label, which is a full
       * onboarding sentence too long for a chip.
       *
       * tier/model are FUNCTIONS, read fresh on every repaint, matching
       * status.busy()/step() -- the first draft snapshotted them once at
       * config-build time, which could not reflect a model change without a
       * remount (B1 caught this before it landed).
       *
       * MODEL and EFFORT map onto sessionModelOverride and sessionEfforts,
       * the same two maps runPaletteAction's model/effort popup stages
       * already read and write -- resolved to the SAME labels those rows
       * show (sessionModelChoices(), EFFORT_CHOICES), never a second naming.
       * onOpenModel/onOpenEffort open the named stage in the chat that
       * supplied the chip. Rebuilding the rail here used to discard its
       * draft and attachments, and switched away from floating cards. QUEUE and HALT
       * need nothing new -- B1's message says they read the existing queue/
       * onStop configs above. */
      chips: chatChips,
    }
  }
  /* The chip repaints once per frame, never per token — the same batching the
     transcript appender measured its way to. One pending id is enough: one
     turn streams at a time, and a second node's event simply takes the slot. */
  let chipRefreshFrame = 0
  /* The one pending "reveal the active tree chip" frame (see mountGraph); a
     remount replaces it rather than stacking a second. */
  let chipRefreshNodeId = null
  // Paint the latest accumulated reply once per frame. The shared renderer
  // patches changed content; close() always carries the final complete text.
  let railStreamFrame = 0
  let railStreamSessionId = null
  function scheduleRailStream(sessionId) {
    railStreamSessionId = sessionId
    if (railStreamFrame) return
    railStreamFrame = requestAnimationFrame(() => {
      railStreamFrame = 0
      const id = railStreamSessionId
      railStreamSessionId = null
      if (destroyed || !id) return
      if (railChat && railChat.sessionId === id && railChat.stream) {
        railChat.stream.push(sessionTurnText.get(id) || '')
      }
    })
  }
  function scheduleChipRefresh(nodeId) {
    chipRefreshNodeId = nodeId
    if (chipRefreshFrame) return
    chipRefreshFrame = requestAnimationFrame(() => {
      chipRefreshFrame = 0
      const id = chipRefreshNodeId
      chipRefreshNodeId = null
      if (!destroyed && graph && typeof graph.refreshChip === 'function') {
        graph.refreshChip(id)
      }
    })
  }
  /* Why the store might not exist at all: it needs an id for the computer, and a
     browser preview with no fleet has no computer to name. That is a real state
     and it must not be an exception on the way to first paint. The sentence goes
     to the panel, so a press still answers. */
  let treeStoreProblem = ''
  let composePanel = null
  /* Which rail page the person was reading when they pressed an empty node, so
     closing the panel puts back what they had rather than resetting the rail. */
  let railBeforeCompose = null

  /* EXAMPLE_BOARD_TEXT — the mock start refusal — moved to module scope (see
     its note beside START_NEEDS_APP_TEXT): startAgentForNode itself now
     refuses mock-sourced starts before any bridge check, so the sentence had
     to live where that module-scope function can reach it. The empty slots
     are DRAWN on the example fleet — the dashed start slot is part of the
     product — and every press of one answers with that sentence instead. */

  // Save health is independent of the latest action's outcome and its timer.
  function reportTreePersistence(saved) {
    const previous = treePersistenceProblem
    treePersistenceProblem = saved?.persistenceFailed
      ? saved.persistenceProblem || 'The latest tree changes could not be saved. Keep this page open to preserve those changes.' : ''
    if (treePersistenceProblem || previous) renderOrgStatus()
  }

  function releaseTreeStore() {
    stopSampleRun()
    treePersistenceUnsub?.()
    treePersistenceUnsub = null
    reportTreePersistence(null)
    treeStoreUnsub?.()
    treeStoreUnsub = null
    treeStoreLiveRelease?.()
    treeStoreLiveRelease = null
    treeStore = null
    transcriptStore?.dispose?.()
    transcriptStore = null
    diffHistoryStore = null
    nodeDiffHistories.clear()
    treeStoreId = null
  }

  /* Open the store for the computer on screen, or make sure there is none.
     THE EXAMPLE FLEET KEEPS NO TREES AT ALL: an example fleet is not yours to
     save trees onto — a tree persisted under `sample-computer-1` would be a
     real record of yours filed inside a fleet that is nobody's, and would
     resurface there for as long as the toggle stayed on. Every tree-save
     surface refuses under mock with the example sentence (the compose panel
     via composeUnavailableReason, the drag via syncEditAvailability and
     mountGraph's null onReparent, the Reports-to Save via its own
     EXAMPLE_REARRANGE_TEXT gate — the third door, found announcing "Saved."
     on the example by both press-throughs, 2026-08-27). */
  function syncTreeStore() {
    if (!computer) {
      releaseTreeStore()
      return null
    }
    /* THE EXAMPLE GETS TREES, BECAUSE THE TREES ARE THE PAGE.
     *
     * This read `if (mockSource() || !computer) releaseTreeStore()`, which
     * pointed the example at the projection face -- the surface a machine with
     * no fleet host falls back to -- and took the tree face away with the
     * store. Everything a person works in went with it: the tree chip row (it
     * deletes itself when listTrees() is empty), every path to
     * showTreeNodeControls (no node is a tree node without a store), and with
     * it treeChatConfigFor, where the actions palette and the attachment and
     * mention pickers are wired. The owner found it the only way it could be
     * found -- by looking: "where are my agent actions and such and the file
     * upload?" They were never removed. They were unreachable.
     *
     * So the example opens a store of its own. It is the REAL store (same
     * createFleetTreeStore, same validation, same refusals) over a memory
     * backing that writes nothing down, seeded with the example's trees. His
     * tree code runs over it unmodified, which is the point: there is no
     * example rail to maintain, because there is no second rail. */
    if (mockSource()) return openSampleTreeStore()
    const opened = openTreeStore(computer.id)
    if (opened && !authoritativeTreeSnapshot) installPendingEditorCopy(opened, computer.id)
    return opened
  }

  function installPendingEditorCopy(store, computerId) {
    const imported = editorAttachmentDrafts.install(store, { computerId,
      local: currentDataSource() === 'local', tiers: LAUNCH_TIERS })
    if (imported) queueMicrotask(() => {
      if (destroyed || treeStoreId !== computerId) return
      if (imported.ok) {
        refreshTree()
        setOpenTarget(treeAgentRecord(imported.node))
        setOrgStatus(`Editor copy prepared. Choose the session profile for ${imported.node.pendingEditorFork.workspace}, review its message, then press Start.`, 'ok', { sticky: true })
      } else setOrgStatus(imported.reason, 'refuse', { sticky: true, code: imported.code })
    })
  }

  /* The example's store, built once per mount, never persisted. Mirrors
     openTreeStore for the parts that are about THIS page, and deliberately
     omits the parts that are about a person's machine: markTreeStoreLive
     (nothing here is live), the transcript store (an example has no saved
     conversations to reload), and the localStorage seam. */
  function openSampleTreeStore() {
    if (treeStore && treeStoreId === SAMPLE_TREE_COMPUTER_ID) return treeStore
    releaseTreeStore()
    treeStoreProblem = ''
    try {
      treeStore = createSampleTreeStore({ simulation: true })
      treeStoreId = SAMPLE_TREE_COMPUTER_ID
      transcriptStore?.dispose?.()
      transcriptStore = null
      diffHistoryStore = null
    } catch {
      treeStore = null
      treeStoreId = null
      treeStoreProblem = 'The example trees could not be built on this page.'
    }
    if (treeStore) startSampleRun(treeStore)
    return treeStore
  }

  /* THE EXAMPLE, AT WORK (owner, 2026-09-11: "have the example fleet simulate
   * its different states in a seemingly very acive environment").
   *
   * src/sample-simulation.js plays the working tree: it changes the example
   * store through the store's own API and hands back what each agent is doing.
   * This is the page's half, and it only ever writes where the page's own
   * drawing code already reads -- the activity, tool and thinking maps the
   * chips and the rail read, the words-so-far map the chip's chat line reads,
   * and the chats this page mounted for those agents (through the chat's own
   * public doors: openStream, addAction, addThinking, addNote,
   * addOwnerMessage). It never touches sessionNodeIds, the outbox, the
   * transcript store or the agent bridge, so nothing it does can reach a real
   * agent, and nothing about it survives the page.
   *
   * It stops itself the moment the page stops showing that store: a destroyed
   * view, a switch to the person's own fleet, or a new example store. */
  function startSampleRun(store) {
    stopSampleRun()
    if (destroyed) return
    const seeded = sampleSimulationSeed(store)
    if (!seeded) return
    try { sampleRun = createSampleFleetRun({ store, seeded }) } catch { sampleRun = null; return }
    sampleRunStore = store
    /* The page joins the round already under way, in one step: the first
       paint shows the tree at work rather than eleven drafts. */
    sampleRun.advance(Date.now())
    for (const node of store.snapshot().nodes) syncSampleNode(node.id)
    sampleRunTimer = setInterval(sampleTick, SAMPLE_TICK_MS)
  }

  function stopSampleRun() {
    if (sampleRunTimer) clearInterval(sampleRunTimer)
    sampleRunTimer = 0
    if (sampleChipFrame) cancelAnimationFrame(sampleChipFrame)
    sampleChipFrame = 0
    sampleChips.clear()
    sampleRun = null
    sampleRunStore = null
    sampleChats.clear()
    for (const sessionId of sampleSessionText.values()) sessionTurnText.delete(sessionId)
    sampleSessionText.clear()
  }

  /* One agent's picture into the maps the chip and the rail read. */
  function syncSampleNode(nodeId) {
    const view = sampleRun?.viewOf(nodeId)
    if (!view) return
    const busy = view.sessionId !== null
    if (busy && view.tool) nodeActivity.set(nodeId, view.tool)
    else nodeActivity.delete(nodeId)
    if (view.tool) nodeLastTool.set(nodeId, view.tool)
    if (view.thinking) nodeThinking.set(nodeId, view.thinking)
    const previous = sampleSessionText.get(nodeId)
    if (previous && previous !== view.sessionId) sessionTurnText.delete(previous)
    if (view.sessionId && typeof view.streaming === 'string' && view.streaming) {
      sessionTurnText.set(view.sessionId, view.streaming)
      sampleSessionText.set(nodeId, view.sessionId)
    } else {
      if (view.sessionId) sessionTurnText.delete(view.sessionId)
      sampleSessionText.delete(nodeId)
    }
  }

  function sampleTick() {
    if (destroyed || !sampleRun || treeStore !== sampleRunStore || !mockSource()) { stopSampleRun(); return }
    const events = sampleRun.advance(Date.now())
    if (!events.length) return
    let repaint = false
    const touched = new Set()
    for (const event of events) {
      if (event.kind === 'round') {
        for (const node of treeStore.snapshot().nodes) {
          if (!sampleRun.owns(node.id)) continue
          nodeLastTool.delete(node.id)
          nodeThinking.delete(node.id)
          touched.add(node.id)
        }
        repaint = true
        continue
      }
      touched.add(event.nodeId)
      if (event.kind === 'status') repaint = true
      drawSampleEvent(event)
      drawSampleSaid(event)
    }
    for (const nodeId of touched) syncSampleNode(nodeId)
    if (repaint) refreshTree()
    else {
      /* One frame repaints every chip that changed, as the page's own
         per-node refresh would one at a time. */
      for (const nodeId of touched) sampleChips.add(nodeId)
      if (!sampleChipFrame) sampleChipFrame = requestAnimationFrame(() => {
        sampleChipFrame = 0
        const ids = [...sampleChips]
        sampleChips.clear()
        if (destroyed || !graph || typeof graph.refreshChip !== 'function') return
        for (const nodeId of ids) graph.refreshChip(nodeId)
      })
      notifyNodeStatusListeners()
    }
    const railNode = currentRailTreeNode && touched.has(currentRailTreeNode.id) ? treeStore.getNode(currentRailTreeNode.id) : null
    if (railNode) repaintRailStatus(railNode)
  }

  /* Into every chat this page mounted for the agent, through the chat's own
     doors -- the same ones a real session's events use. */
  function drawSampleEvent(event) {
    const roots = sampleChats.get(event.nodeId)
    if (!roots) return
    for (const root of [...roots]) {
      /* A chat that has left the page -- or was built and never placed --
         is forgotten, so remounts over a long session hold nothing. */
      if (!root.isConnected && (sampleChatsShown.has(root) || Date.now() - (sampleChatsBorn.get(root) || 0) > 2000)) { roots.delete(root); continue }
      if (root.isConnected) sampleChatsShown.add(root)
      if (event.kind === 'owner') root.addOwnerMessage?.(event.text, { at: event.at })
      else if (event.kind === 'turn-close' && event.text) {
        /* THE REPLY LANDS WHOLE. A stream left open through the turn draws the
           composer's "Writing a reply" row between the example sentence and the
           box it explains, late enough to push the box out of a phone sheet
           that had already revealed it (providers-qa Page 2: initialComposer).
           The words stream on the chip, the ledger and the rail's latest-answer
           box; the chat takes them once, through the same door, opened and
           closed in one step. */
        const stream = root.openStream?.({ at: Date.now() })
        stream?.push(event.text)
        stream?.close(event.text)
      } else if (event.kind === 'row') root.addAction?.(event.row)
      else if (event.kind === 'thinking') root.addThinking?.(event.text, { at: event.at })
      else if (event.kind === 'note') root.addNote?.(event.text, { at: event.at })
    }
  }

  /* The rail's "latest answer" box, for the agent the rail is showing: the
     same appender and the same settle a real turn uses (see the turn
     completion in the session listener). The kept reply itself is the
     store's (setNodeReply), which is what the chip and the chat read. */
  function drawSampleSaid(event) {
    if (!railSaid || railSaid.nodeId !== event.nodeId) return
    /* A box built since the last event was seeded with the words so far. */
    if (railSaid !== sampleSaid.box) sampleSaid = { box: railSaid, pushed: sessionTurnText.get(treeStore?.getNode(event.nodeId)?.sessionId) || '' }
    if (event.kind === 'turn-open') sampleSaid.pushed = ''
    else if (event.kind === 'words' && event.text.startsWith(sampleSaid.pushed) && event.text.length > sampleSaid.pushed.length) {
      if (railSaid.waitingLine) { railSaid.waitingLine.remove(); railSaid.waitingLine = null }
      railSaid.appender.push(event.text.slice(sampleSaid.pushed.length))
      sampleSaid.pushed = event.text
    } else if (event.kind === 'turn-close' && event.text) {
      const said = event.text
      railSaid.appender.flushNow()
      paintSaidReply(railSaid.host, said)
      disposeRailSaid()
      sampleSaid = { box: null, pushed: '' }
    }
  }

  function registerSampleChat(nodeId, root) {
    if (!root || !sampleRun) return
    const held = sampleChats.get(nodeId) || new Set()
    held.add(root)
    sampleChats.set(nodeId, held)
    sampleChatsBorn.set(root, Date.now())
  }

  /* The example's rows: the product's real palette, every door that would act
     on an agent shown and switched off with the example sentence, so a person
     can see what the product offers without any of it reaching anything. */
  function exampleOnlyRows(rows) {
    return rows.map(row => (SAMPLE_SAFE_ACTIONS.has(row.id) ? row : { ...row, enabled: false, disabledHint: exampleBoardText() }))
  }

  function exampleChatConfigFor(node) {
    const kept = sampleRun?.owns(node.id) ? sampleRun.historyOf(node.id) : null
    const history = kept?.length ? kept : [
      ...(node.message ? [{ who: 'you', text: node.message, at: null }] : []),
      ...(node.reply ? [{ who: 'agent', text: node.reply, at: null }] : []),
    ]
    const current = () => treeStore?.getNode(node.id) || node
    return {
      title: treeNodeName(node),
      subtitle: SAMPLE_CHAT_SUBTITLE,
      headerMeta: treeChatHeaderMetaFor(node.id),
      roleKey: node.role,
      accentId: node.id,
      history,
      seed: 0,
      composerReason: exampleBoardText(),
      onReady: root => registerSampleChat(node.id, root),
      /* NOT BUSY, ON PURPOSE. The composer here only ever carries the example
         sentence; a working row under it would stand between that sentence and
         the box it explains, and on a landscape phone push the sentence out of
         the sheet (providers-qa Page 2: refusalReadable). What the agent is
         doing is already in the streamed reply, its rows, the rail's status
         line and the chip. */
      status: {
        busy: () => false,
        subtitle: () => SAMPLE_CHAT_SUBTITLE,
        subscribe: listener => registerNodeStatusListener(node.id, listener),
        composerReason: () => exampleBoardText(),
      },
      actions: () => exampleOnlyRows(chatActionRowsFor(current())),
      commonActions: () => exampleOnlyRows(commonChatActionsFor(current())),
      actionsNote: PALETTE_PANEL.footer,
    }
  }

  /* Open the saved trees for one computer.
   *
   * createFleetTreeStore THROWS for bad wiring on purpose — see its header: a
   * missing storage seam or an id that is not an id is a defect in the code, not
   * something a person did. Caught here all the same, because the alternative is
   * a fleet page that renders nothing at all on a machine whose id this view was
   * handed by a fleet record it did not write. A caught throw leaves the trees
   * unavailable and says so at the one moment it matters, which is a press. */
  /* THE NAME A CIRCLE IS REGISTERED UNDER HAS TO FOLLOW THE NAME IT IS SHOWN
     UNDER, AND ONE OF THEM CAN MOVE WITHOUT THE STORE CHANGING.

     refreshNodeNames() reports changes to the STORED records -- a circle's
     nameBase and its per-tree ordinal. The cross-tree half of the rule is not
     stored: nodeDisplayName() qualifies a label with the circle's own id only
     while another circle on the same surface computes the same label. So
     drawing a SECOND tree renames the first tree's top circle from
     "Controller" to "Controller (00000002)" with nothing stored changing and
     refreshNodeNames() reporting zero -- measured on this store, 2026-09-16 --
     and a circle already registered under the old name kept it, while every
     circle briefed afterwards was told the new one. The two would not meet.

     So the syncs are driven by the names THIS function last saw, which is the
     only record that moves when a computed name moves. updateTreeAddress()
     already coalesces an unchanged address, so a branch that has not really
     moved costs a comparison and no directory write. */
  function refreshTreeNames(syncExisting = false) {
    if (!treeStore || authoritativeTreeSnapshot) return
    const names = orgReady() ? treeStore.refreshNodeNames() : null
    const nodes = treeStore.snapshot().nodes
    const composed = renamedCircles(lastComposedNames, nodes, treeNodeName)
    lastComposedNames = composed.names
    if (!syncExisting && !(names?.changed > 0) && composed.moved.length === 0) return
    // Naming a legacy circle also changes its children's manager address.
    // Only sessions owned by this app run pass syncTreeBranchAddresses.
    for (const node of nodes) {
      if (!node.parentId) void syncTreeBranchAddresses(node.id)
    }
  }

  /* THE COMPUTED HALF, WATCHED ON EVERY ACCEPTED CHANGE.
     Deliberately does NOT call refreshNodeNames(): that one REPAIRS stored
     records and is a write, and running a write from inside the store's own
     publish is how a repair loop starts. This only reads the names, and asks
     for a re-registration when one of them has moved under a circle that is
     already registered. */
  function syncRenamedCircles(snapshot) {
    if (!treeStore || authoritativeTreeSnapshot) return
    const nodes = snapshot?.nodes || treeStore.snapshot().nodes
    /* Nothing a name is made of has moved, so no name can have moved, and the
       quadratic scan below is skipped -- see namingSignature(). This is the
       ordinary case: a status, a reply, a run-clock tick. */
    const signature = namingSignature(nodes)
    if (signature === lastNamingSignature) return
    lastNamingSignature = signature
    const composed = renamedCircles(lastComposedNames, nodes, treeNodeName)
    lastComposedNames = composed.names
    if (composed.moved.length === 0) return
    for (const node of nodes) {
      if (!node.parentId) void syncTreeBranchAddresses(node.id)
    }
  }

  function openTreeStore(computerId) {
    if (treeStore && treeStoreId === computerId) {
      refreshTreeNames()
      return treeStore
    }
    releaseTreeStore()
    treeStoreProblem = ''
    if (!computerId) {
      treeStoreProblem = drivenComputerCopy(
        'This page is not showing a computer yet, so there is nowhere to start an agent. Wait for your computers to load, then press again.',
        'This page is not showing a computer to drive yet, so there is nowhere to start an agent. Wait for the computers on your account to load, then press again.',
      )
      return null
    }
    try {
      if (authoritativeTreeSnapshot && authoritativeTreeComputer?.id === computerId) {
        treeStore = createDesktopTreeViewStore(authoritativeTreeSnapshot)
        treeStoreId = computerId
        treeStoreProblem = ''
        return treeStore
      }
      treeStore = recoveryCoordinator()?.activeStore(computerId) || RUN_STARTING_TREE_STORES.get(computerId)?.store || RUN_TREE_RUNTIME_STORES.get(computerId) || recoveryCoordinator()?.sessionStore(computerId) || createTreeRuntimeView(createFleetTreeStore({
        computerId,
        storage: safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage),
        roleLabel: role => orgReady() ? roleLabel(roleDisplayFor(role)) : null,
        /* Same set as the runtime view below, for the reason given at the other
           createFleetTreeStore call: a seat count and a liveness answer drawn
           from two different maps is how a corpse keeps its seat. Read through
           seatSessionEvidence, which withholds the map until the saved-session
           sweep has asked the host, so a reload cannot free a live child's seat. */
        ownedSessions: seatSessionEvidence,
      }), sessionNodeIds)
      treePersistenceUnsub = treeStore.subscribe(snapshot => {
        reportTreePersistence(snapshot)
        dropLinksOfFormerHeads(snapshot)
        /* WATCHED AT THE STORE, NOT AT EACH PRESS. A computed rename can be
           caused by ANY accepted change that adds a circle or a tree, and this
           page has more than one door to that: the compose panel, an editor
           copy (src/editor-attachment-drafts.js install(), which adds with no
           parent and so starts a tree), and adopting a standalone agent as a
           new root (src/tree-standalone-placement.js placeStandaloneAgent with
           parentId null). Hooking the doors one at a time is how the next door
           gets missed -- a reviewer found two I had already missed. Every
           accepted mutation publishes here (accept() -> commit() -> publish()
           in src/fleet-trees.js), so this is the one place that cannot be
           walked around. */
        syncRenamedCircles(snapshot)
        refreshSlotUsage()
        refreshRailMoveChoices?.()
      })
      reportTreePersistence(treeStore.snapshot())
      treeHeadIds = treeHeadIdsOf(treeStore.snapshot())
      treeStoreId = computerId
      treeStoreLiveRelease = markTreeStoreLive(computerId)
      /* WHICH TREE IS ON SCREEN, SAID BY THE THING THAT OPENED IT.
       *
       * The shell needs this to address an assistant's request to add a circle
       * at the tree a person is actually looking at. It was first taken from
       * the address bar, and that was wrong twice over: this view resolves its
       * own computer when the address names none, and the app's own link to
       * this page is a bare #/computers. Measured on the owner's own tree,
       * 2026-09-03: one circle was drawn while the address carried an id, and
       * every spawn after a normal relaunch refused MC_TREE_SPAWN_TREE_NOT_OPEN
       * on a page that was plainly open.
       *
       * Announced here, where the store is opened, it is true whenever a tree
       * is on screen and it names the tree the person can see. Nothing waits on
       * the answer: a shell without the channel simply never hears it, and a
       * spawn is then refused for want of an open tree rather than sent to the
       * wrong one. */
      if (typeof window !== 'undefined' && typeof window.mcTreeCommand?.announce === 'function') {
        void Promise.resolve(window.mcTreeCommand.announce(computerId)).catch(() => {})
      }
      /* Its own try: a transcript store that cannot open costs resume, not
         the trees. */
      try {
        transcriptStore = createTranscriptStore({
          computerId,
          storage: safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage),
          /* A SAVE THAT LOSES ANYTHING SAYS SO. The store used to delete a
             whole node's conversation to fit another node's save and return
             true; it now gives up the oldest LINES instead, but "quieter" is
             not "silent" -- on a research machine a lost transcript is lost
             work, and a person is owed the sentence at the moment it happens.
             The record itself also carries the count, so the chat that opens
             it repeats the admission where the gap is. */
          onLoss: () => setOrgStatus(TRANSCRIPT_TRIMMED_NOTE, 'warn'),
        })
        if (typeof window !== 'undefined' && window.mcTranscripts) {
          const legacy = transcriptStore
          const client = createNodeTranscriptClient({ computerId, bridge: window.mcTranscripts, legacy, nodeIds: treeStore.snapshot().nodes.map(node => node.id),
            onError: message => setOrgStatus(message, 'warn', { sticky: true }),
            onReady: () => refreshHydratedRailChat(client),
          })
          transcriptStore = client
          void transcriptStore.migrate(treeStore.snapshot().nodes.map(node => node.id)).catch(error => setOrgStatus(error.message, 'warn', { sticky: true }))
        }
      } catch { transcriptStore = null }
      try {
        diffHistoryStore = createChatDiffHistoryStore({
          computerId,
          storage: safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage),
        })
      } catch { diffHistoryStore = null }
      /* THE REPLIES COME BACK; THE SESSIONS DO NOT.
         A saved reply is a fact about a node and is worth re-reading. A saved
         session id is a fact about a PROCESS, and re-registering one here is
         how a session killed at the last shutdown came back as live -- see the
         note on RUN_SESSION_NODES. Sessions this run owns are already in that
         map and need nothing from storage; sessions it does not own are gone,
         and saying so is the point. */
      for (const node of treeStore.snapshot().nodes) {
        if (node.reply) nodeReplies.set(node.id, node.reply)
      }
      // A route reopen may have adopted legacy names while sessions from
      // this run remain alive. Their directory must agree with the canvas.
      refreshTreeNames(true)
      if (currentDataSource() !== 'mock' && transcriptStore) {
        // Keep only the data stores across navigation. No retired view callback
        // or canvas is retained by automatic recovery.
        recoveryCoordinator()?.register(computerId, { treeStore, imageRecovery: recoveryImageContext(), sessionModelOverrides: sessionModelOverride,
          /* `bridge` routes the handoff to its own file instead of the single
             settings record, whose 1 MiB ceiling these records had reached. Absent
             in a plain browser, where the store falls back to localStorage exactly
             as before. */
          handoffStore: createRecoveryHandoffStore({ computerId, storage: safeTreeStorage(window.localStorage), bridge: window.mcRecovery || null,
            onWriteResult: (nodeId, answer) => window.mcPrefsNotice?.reportRecoveryWrite?.(nodeId, answer) }),
          transcriptStore: window.mcTranscripts
            ? createNodeTranscriptClient({ computerId, bridge: window.mcTranscripts,
              legacy: createTranscriptStore({ computerId, storage: safeTreeStorage(window.localStorage) }),
              nodeIds: treeStore.snapshot().nodes.map(node => node.id) })
            : createTranscriptStore({ computerId, storage: safeTreeStorage(window.localStorage) }) })
      }
    } catch {
      treeStore = null
      transcriptStore?.dispose?.()
      transcriptStore = null
      diffHistoryStore = null
      treeStoreId = null
      treeStoreProblem = drivenComputerCopy(
        'The saved trees could not be opened. They have not been replaced. Editing and starting agents are unavailable until those trees can be read. Reopen the Trees page to retry.',
        'The trees saved in this browser could not be opened. They have not been replaced. Editing and starting agents on the computer you are driving are unavailable until those trees can be read. Reopen the Trees page to retry.',
      )
    }
    return treeStore
  }

  /* A NAME FOR A NODE THAT NOBODY NAMED.
     A person types a role and a job, never a name, so the first line of the job
     is what the circle is called — it is the one string on the record that tells
     two agents apart at a glance. A message that is all whitespace or missing
     falls back to the role's own label rather than to an id. */
  /* A NODE'S NAME IS AN IDENTITY, NOT ITS HOMEWORK. This used to return the
     start brief's first line, so the Details head shouted "Reply with exactly
     the word OMEGA…" as if it were somebody's name (owner walkthrough,
     iteration 5). The name is now the role plus a per-tree ordinal when
     siblings share the role — "Coordinator", "Worker 2" — mirroring the
     ordinal shape treeLabel() already uses for trees. The brief keeps its own
     box and its own helper below; the two never trade places again.
     THE RULE ITSELF LIVES IN src/fleet-trees.js (nodeDisplayName), because
     the Ledger page's filing box names the same nodes from the same saved
     record and the two must agree on every name. */
  function treeNodeName(node) {
    const peers = treeStore ? treeStore.snapshot().nodes : []
    return circleName(node, peers, role => roleLabel(roleDisplayFor(role)))
  }

  /* The brief's first line, for the small row under the name and nowhere
     larger. Kept short the way the old name was, because it is a caption. */
  function treeNodeBrief(node) {
    const firstLine = String(node.message || '').split('\n').map(line => line.trim()).find(Boolean) || ''
    return firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine
  }

  /* WHAT A TREE NODE LOOKS LIKE TO THE GRAPH.
   *
   * src/tree-graph.js draws agents, and this is a tree node wearing exactly the
   * shape it draws — id, name, role key, parent — with two fields that decide
   * how honest the circle is:
   *
   * `bornAt` IS SET ONLY WHILE A SESSION IS REALLY OPEN. The graph binds a live
   * clock to any node that has one, so a draft or a failed start with a bornAt
   * would tick away on the canvas exactly like a working agent. That is the one
   * outcome this whole lane exists to prevent, so the field is derived from the
   * session and never from the fact that a row exists.
   *
   * `state` DECIDES THE WORD IN THE CIRCLE WHERE THE CLOCK WOULD BE, and the
   * graph's vocabulary for it is the fleet's: 'disabled' means switched off in
   * the fleet record, 'enabled' means declared and live, and anything else
   * renders as "no signal". A draft is none of the first two — calling it
   * disabled would tell a person their brand new agent had been switched off,
   * which is a different and wrong story — so it is deliberately outside that
   * vocabulary and lands on the neutral word, which is also the true one:
   * nothing is coming from it, because nothing is running.
   */
  function treeAgentRecord(node) {
    /* nodeBusy, not the saved status: 'enabled' is the graph's word for a live
       agent, and painting it over a session that ended at the last shutdown is
       how a dead node kept its blue circle. */
    const running = nodeBusy(node)
    /* A node that HELD a session keeps its clock. Measured 2026-08-13: bornAt
       was granted only while running, and stoppedAt was hardcoded null -- so
       the moment a real turn completed, the agent that had just run, replied
       and finished rendered "no signal / no runtime", indistinguishable from
       one that never existed. A session-bearing node now always carries its
       start time, and a terminal one carries its stop time (updatedAt is
       written on the same beat as the terminal status), so the circle shows
       the run's real duration instead of denying the run happened. */
    /* AND THE CLOCK STOPS WHEN THE SESSION DOES, however it ended. A terminal
       status alone left one gap and a person fell straight into it: a node
       saved mid-turn loads back as 'starting', which is neither finished nor
       failed, so it was granted a start time and no stop time -- a clock
       ticking on the canvas over a process killed when the app last closed
       (measured 2026-08-16, 0:00:33 climbing to 0:04:12 on a reopened
       profile). treeNodeClock owns that rule now. */
    const clock = treeNodeClock(node, ownedSessions(), sessionEvidence())
    const terminal = clock.terminal
    return {
      id: node.id,
      name: treeNodeName(node),
      sessionId: node.sessionId || null,
      cloudLane: readCloudLane(node.cloudLane),
      role: node.role || 'default',
      declaredRole: node.role || 'default',
      parentId: node.parentId || null,
      /* The graph's state vocabulary is its own (enabled/disabled/finished/
         failed); 'turn-failed' translates to its 'failed' colour here, while
         the chip word — the words a person reads — comes from
         treeNodeStatusWord via the context feed and stays distinct. */
      state: running ? 'enabled' : terminal ? (node.status === 'turn-failed' ? 'failed' : node.status === 'interrupted' ? 'finished' : node.status) : clock.endedWithApp ? ENDED_SESSION.word : 'not started',
      /* THE GRAPH'S `bornAt` IS AN EPOCH, NOT A BIRTHDAY, and every use of it
         in src/tree-graph.js proves it: a finiteness gate, `fmtRuntime(bornAt,
         stoppedAt)`, and `bindRuntime(el, () => bornAt)`. Nothing renders it
         as an instant. A tree node runs in more than one interval, so the
         instant that makes those digits equal the time it actually ran is
         shifted back by the runs that already ended -- treeNodeClock computes
         it and calls it what it is. The fleet projection above has no such
         field and keeps handing its own bornAt, which for a fleet record is
         both. */
      bornAt: clock.runtimeEpoch,
      stoppedAt: clock.stoppedAt,
      tasksDone: null,
      failRate: null,
      provider: null,
      model: null,
      context: [],
      /* null ON PURPOSE, and the single line behind owner defect 1a. This used
         to be `node.parentId ? 2 : 0`, and depthFor short-circuits on an
         explicit tierRank -- so child, grandchild and great-grandchild all
         shared rank 2, every root shared rank 0, a four-level tree drew as two
         rows, and a same-row parent/child turned its connector into a straight
         diagonal. With null, the layout walks parentId chains and gives the
         tree its true depth. Drill-in always looked right because
         _layoutAgents strips tierRank when drilled -- that was the tell. The
         FLEET projection's tierRank (a different data model, computers.js
         fleet records) is legitimate and untouched. */
      tierRank: null,
      cullable: Boolean(node.parentId),
      cullRank: 0,
      /* The graph puts this in the circle's tooltip when there is no clock. It
         is the node's own status note — the refusal sentence, for a start that
         did not happen — so hovering a stalled circle answers the question the
         canvas raised. */
      projectionUnavailableReason: node.statusNote || 'this agent has not been started yet',
      /* The record the chip and the rail read back. Carried rather than looked
         up so that the two can never disagree about which node they describe. */
      treeNode: node,
      treeActivity: overviewNodeState(node, ownedSessions(), { example: mockSource(), evidence: sessionEvidence(), startingNodeIds }),
      researchProjectId: treeStore?.getTree(node.treeId)?.researchProjectId || null,
      researchProjectName: treeStore?.getTree(node.treeId)?.researchProjectName || '',
    }
  }

  const treeAgents = () => (treeStore ? treeStore.snapshot().nodes.map(treeAgentRecord) : [])

  /* The computer handed to the graph: the record's own agents plus the ones
     this person started. One code path for every source — under mock the tree
     store is released (syncTreeStore), so treeAgents() is empty and the
     untouched example computer is what draws. A COPY is only made when there
     is something to add; nothing downstream depends on identity any more
     (tree-graph.js no longer subscribes to sim events), but a fresh object
     for nothing is still a reconcile for nothing. */
  function graphComputer() {
    if (typeof authoritativeTreeComputer !== 'undefined' && authoritativeTreeComputer) return authoritativeTreeComputer
    const grown = treeAgents()
    return mergeFleetTreeProjection(computer, grown)
  }

  /* THE CHIP BESIDE A NODE THIS PERSON STARTED.
     The fleet's own feed describes a fleet record and has nothing true to say
     about a node this page created a second ago, so a tree node answers for
     itself: what it is doing now, and — when it did not start — why not. The
     status word comes first because the chip clips at about 322px, and the
     sentence in full is in the panel and on the tooltip. */
  /* One vocabulary for what a node is doing, read by the chip on the canvas and
     by the rail behind it. Two sets of words for one field is how a screen ends
     up saying "running" in one place and "starting" in another about the same
     circle. */
  function treeNodeStatusWord(node) {
    if (authoritativeTreeSnapshot) {
      const activity = authoritativeTreeSnapshot.sessions.find(row => row.sessionId === node?.sessionId
        && (row.nodeId == null || row.nodeId === node.id))
      return activity?.busy === true ? 'running' : activity?.busy === false ? 'idle' : 'Activity not reported'
    }
    /* A SAVED 'running' IS NOT A RUNNING AGENT — nodeSessionEnded first, so a
       record orphaned by shutdown says so. The words themselves live in
       NODE_STATUS_WORDS (src/fleet-tree-copy.js), one entry per status the
       store accepts, because an if-chain here is where a failed TURN came to
       read "did not start": the store gained a status the chain had no word
       for, and the fallthrough lied. A shared table cannot fall through — the
       suite checks every NODE_STATUSES entry has its word. */
    if (nodeSessionEnded(node)) return ENDED_SESSION.word
    return NODE_STATUS_WORDS[node.status] || NODE_STATUS_WORDS.draft
  }

  function treeContextFeed(agent) {
    const node = agent.treeNode
    /* One code path: the projection carries whatever the source carried, mock
       data included, and projectionMonitorContext reads only what is on it.
       The hash-seeded fake excerpt (monitorContextFor) died with the second
       render — a fabricated chat line has no honest home on any source. */
    if (!node) return projectionMonitorContext(agent)
    /* THE CONTEXT WINDOW, not a telemetry card. The owner's words for the old
       shape: "I dont see anything just nonsense" — and he was right by
       construction: chat was hardcoded null, statusNote is cleared on success,
       so every successful run printed "nothing has run for this agent yet"
       under "telemetry unavailable". A tree node KNOWS its context: what was
       asked (message), what it is doing right now (nodeActivity), what it is
       saying as it says it (sessionTurnText tail), and what it said
       (node.reply, persisted). That is what the chip shows. The unavailable
       sentence remains only as the last resort for a node with no message and
       no session — a shape addNode cannot produce. */
    const streaming = node.sessionId ? sessionTurnText.get(node.sessionId) : null
    const reply = nodeReplies.get(node.id) || node.reply || null
    const asked = String(node.message || '').split('\n').map(line => line.trim()).find(Boolean) || null
    return {
      current: treeNodeStatusWord(node),
      tool: nodeLastTool.get(node.id) || null,
      thinking: latestNodeOutput(nodeThinking.get(node.id)) || null,
      previous: (node.statusNote && readerRemedy(node.statusNote, { viaRelay: currentDataSource() === 'relay' })) || (asked ? `asked: ${asked}` : null),
      chat: readableTextPrefix(streaming) || reply,
      unavailable: 'nothing has run for this agent yet',
      tasks: null,
      failRate: null,
      model: null,
    }
  }

  /* Redraw from the model as it now stands. refresh() is the graph's own word
     for it and it keeps the zoom, the pan and the drilled-in root — every one of
     which the person set deliberately, and none of which a new agent is a reason
     to discard. The computer object is replaced first because the graph reads
     its agent list on every reconcile. */
  function refreshTree() {
    refreshWorkspaceChats()
    if (chatWorkspace) { notifyNodeStatusListeners(); return }
    if (chatNodeId) {
      notifyNodeStatusListeners()
      const node = treeStore?.getNode(chatNodeId)
      if (!node) showStats()
      else {
        rebindRailToSession(chatNodeId)
        repaintRailStatus(node)
      }
      return
    }
    if (!graph) return
    graph.computer = graphComputer()
    graph.refresh()
    /* The ledger reads the same computer the graph was just handed; null on
       every desktop and on the canonical phone surface. */
    phoneLedger?.refresh()
    /* Every status mutation flows through here; the chat composers listening
       for their node's busy state hear it here and only here. */
    notifyNodeStatusListeners()
    refreshTreeSwitch()
    paintFleetOverview()
  }

  async function startSetTree(treeId) {
    const store = treeStore
    if (!store || startingTreeIds.has(treeId)) return
    const drafts = store.listNodes(treeId).filter(node => node.status === 'draft' && !startDraftFlight.busy(node.id))
      .sort((a, b) => Number(roleRecordFor(b.role)?.capabilities?.orgRoot === true) - Number(roleRecordFor(a.role)?.capabilities?.orgRoot === true))
    if (drafts.length === 0) return
    const unavailable = composeUnavailableReason() || composeStartUnavailableReason()
    if (unavailable) {
      setOrgStatus(unavailable, 'refuse', { sticky: true })
      return
    }
    startingTreeIds.add(treeId)
    const queue = createTreeLaunchQueue({ nodes: drafts,
      prepare: async node => {
        if (destroyed || !store.getNode(node.id)) return { ok: false, notStarted: true }
        return ensureSeatForNode(node, identityRoleForTreeNode(node.role))
      },
      start: node => startDraftNode(node, { queueManaged: true }),
      onChange: state => {
        if (destroyed) return
        refreshTreeStartControls()
        refreshLaunchStatus()
        const progress = state.preparing ? `Preparing identities: ${state.prepared} of ${state.total}.`
          : `${state.started} started · ${state.pending} waiting · ${state.active} in progress.`
        setOrgStatus(`${progress} ${state.cancelled ? 'Queue cancelled; unstarted agents stay set.' : state.paused ? 'Queue paused; agents already starting will finish.' : state.reason || ''}`.trim(), 'busy', { sticky: true })
      },
    })
    treeLaunchQueues.set(treeId, queue)
    refreshLaunchStatus()
    refreshTreeSwitch()
    let report
    try {
      report = await queue.done
    } finally {
      startingTreeIds.delete(treeId)
      treeLaunchQueues.delete(treeId)
      if (!destroyed) refreshLaunchStatus()
      if (!destroyed) refreshTreeSwitch()
    }
    if (destroyed) return
    const results = report.results
    for (const result of results) if (result.abandoned === true) markLaunchAbandoned(result, { status: false })
    const started = results.filter(result => result.ok).length
    const refused = results.find(result => !result.ok)
    if (report.cancelled) setOrgStatus(`${started} started. Queue cancelled; ${report.pending} unstarted agents stay set.`, 'ok', { sticky: true })
    else if (refused) setOrgStatus(`${started} of ${drafts.length} agents started. ${refused.message || refused.reason || START_REFUSAL.noReasonGiven}`, 'refuse', { sticky: true })
    else setOrgStatus(`${started} ${started === 1 ? 'agent' : 'agents'} started.`, 'ok')
  }

  function launchQueuesForTree(treeId) {
    return [treeLaunchQueues.get(treeId), ...[...nodeLaunchQueues.values()]
      .filter(entry => entry.treeId === treeId).map(entry => entry.queue)].filter(Boolean)
  }

  function refreshTreeStartControls(slot = null) {
    if (!slot) {
      for (const host of root.querySelectorAll('[data-tree-start-controls]')) refreshTreeStartControls(host)
      return
    }
    const focusedAction = slot.contains(document.activeElement) ? document.activeElement?.dataset.queueAction : null
    slot.querySelector('.graph-tree-starts')?.remove()
    if (!treeStore) return
    const queueOnly = slot.hasAttribute('data-tree-queue-only')
    const ready = treeStore.listTrees().filter(tree => tree.id === slot.dataset.treeStartControls).map(tree => ({
      tree,
      drafts: queueOnly ? [] : treeStore.listNodes(tree.id).filter(node => node.status === 'draft'),
    })).filter(entry => entry.drafts.length > 0 || launchQueuesForTree(entry.tree.id).length > 0)
    if (ready.length === 0) return
    const group = document.createElement('div')
    group.className = 'graph-tree-starts'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', queueOnly ? 'Queued starts in this tree' : 'Trees with set agents')
    const unavailable = composeUnavailableReason() || composeStartUnavailableReason()
    for (const { tree } of ready) {
      if (!queueOnly) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'graph-tree-start'
        button.textContent = ready.length === 1 ? 'Start tree' : `Start ${treeStore.treeLabel(tree.id)}`
        /* aria-disabled for a STATED unavailability, disabled only for the
           momentary in-flight batch. A `disabled` button with the whole reason
           in `title` is silent on touch (phone press-through, 2026-08-27); left
           pressable, the click lands in startSetTree, whose first gate puts this
           same sentence in the status line — the press is answered in words on
           every input, and there is still exactly one refusal path. */
        if (unavailable) {
          button.setAttribute('aria-disabled', 'true')
          button.title = unavailable
        }
        button.disabled = startingTreeIds.has(tree.id) || !treeStore.listNodes(tree.id).some(node => node.status === 'draft' && !startDraftFlight.busy(node.id))
        button.addEventListener('click', () => { void startSetTree(tree.id) })
        group.appendChild(button)
      }
      const queues = launchQueuesForTree(tree.id)
      if (queues.length) {
        const paused = queues.every(queue => queue.snapshot().paused)
        for (const action of ['pause', 'cancel']) {
          const control = document.createElement('button')
          control.type = 'button'
          control.className = 'graph-tree-start'
          control.dataset.queueAction = action
          control.textContent = action === 'cancel' ? 'Cancel queued' : paused ? 'Resume queue' : 'Pause queue'
          control.setAttribute('aria-label', `${control.textContent} — ${treeStore.treeLabel(tree.id)}`)
          control.addEventListener('click', () => {
            for (const queue of queues) {
              if (action === 'cancel') queue.cancel()
              else if (paused) queue.resume()
              else queue.pause()
            }
          })
          group.appendChild(control)
        }
      }
    }
    slot.prepend(group)
    if (focusedAction) group.querySelector(`[data-queue-action="${focusedAction}"]`)?.focus({ preventScroll: true })
  }

  /* The second view-only pane stood here until 2026-08-16. Owner: "lets throw
     it away for now". The packaging lane's branch predates that directive, so
     its copy of the pane's enable and disable helpers arrived in this merge
     and is dropped here deliberately; notifyNodeStatusListeners() above is
     theirs and stays, because the chat composers depend on it. */

  /* THE TREE SWITCHER (owner defect 5: "buttons to navigate between them").
     One button per tree, named by treeLabel — the first words the person typed
     into it — plus Every tree to zoom back out. Rendered only when there are
     two or more trees: a switcher over one tree is chrome with no decision in
     it. Rebuilt from listTrees() on every store change, so a tree created,
     detached or emptied updates the row without anyone remembering to. */
  /* Filing a whole scope under a research project: the selected tree files
     each of its sessions; "Every tree" writes the live assign-all rule that
     also covers sessions started later. One shared control (the same factory
     the rail and the research page use), mounted once the projects are read. */
  /* IT LIVES ON THE RAIL NOW, NOT IN THE TOOL STRIP. Mounted into
     `.graph-tools`, this control put "No research projects exist yet. Create one
     on the research page first." between Edit and the zoom buttons -- a sentence
     about a different page, in the row of controls for this one, and the owner's
     first complaint about the bar. Filing is a setting about the whole fleet, so
     it sits beside Session profiles and Roles, which are the other two.

     NOT MOUNTED UNTIL THE SERVICE HAS ANSWERED. `researchService` is null while
     the read is in flight, and an empty project list means "there are none" --
     mounting early would print that sentence about a service nobody has asked
     yet. The slot holds a waiting line until then and this replaces it. */
  function mountResearchScopeControl() {
    /* Real sources only: filing writes an assignment against your research
       projects, and mock neither writes nor shows them. The slot under mock
       carries its own sentence instead (see renderLiveStats). */
    const slot = root.querySelector('[data-research-scope-slot]')
    if (!slot || slot.querySelector('[data-assign-control]') || mockSource() || !researchService) return
    slot.innerHTML = ''
    if (researchService.ok && researchAssignments.snapshot().unboundLegacy) {
      const notice = document.createElement('p')
      notice.className = 'research-authorization'
      notice.textContent = 'Older assignment changes have no saved computer identity. They remain saved and will not be retried on this computer.'
      slot.appendChild(notice)
    }
    slot.appendChild(createAssignmentControl({
      projects: researchService?.ok ? researchService.projects : [],
      unavailableReason: researchService && !researchService.ok ? researchService.reason : null,
      label: 'File this scope under',
      onAssign: async projectId => {
        const currentTreeId = graph?.rootId ? graph.ancestryOf(graph.rootId)
          .map(item => treeStore?.getNode(item.id)?.treeId).find(Boolean) ?? null : null
        // A display group is not a saved node. Resolve its real ancestry;
        // a group spanning several trees must never become an assign-all rule.
        if (graph?.rootId && currentTreeId === null) {
          return { ok: false, sentence: 'Choose a saved tree before filing this scope.' }
        }
        if (currentTreeId === null) {
          const result = await researchAssignments.assign(projectId, 'all')
          if (result.ok && !result.sentence) {
            result.sentence = drivenComputerCopy(
              'Every session on this computer is filed there, including ones started later.',
              'Every session on the computer you are driving is filed there, including ones started later.',
            )
          }
          return result
        }
        const sessions = (treeStore?.listNodes(currentTreeId) || []).filter(node => node.sessionId)
        if (sessions.length === 0) {
          return { ok: false, sentence: 'This tree has no attached sessions to file yet.' }
        }
        let filed = 0
        let pending = false
        for (const node of sessions) {
          const result = await researchAssignments.assign(projectId, 'observed', node.sessionId)
          if (result.ok) { filed += 1; pending = pending || result.pending === true }
        }
        return {
          ok: true,
          sentence: `${filed} session${filed === 1 ? '' : 's'} filed.${pending ? ' The research service has not heard some of them yet.' : ''}`,
        }
      },
    }))
  }

  /* Read once per view, from the boot path's real branch — never at
     construction (the source is not resolved yet) and never under mock (the
     projects list is your data; a badged screen does not read it). The guard
     makes a mock→real source flip read it on arrival without a second read
     when the view booted real. */
  function readResearchOnce() {
    if (mockSource() || researchService) return
    researchAssignments.readServiceSnapshot(readResearchSnapshot).then(result => {
      const readVersion = result.assignmentReadVersion
      if (destroyed || mockSource()) return
      if (result.assignmentReadFailure) result = { ok: false, reason: result.assignmentReadFailure }
      researchService = result
      if (result.ok) {
        const adopted = researchAssignments.adoptServiceRows(result.assignments, { readVersion, assignmentDestination: result.assignmentDestination })
        if (adopted.ok) researchAssignments.flushPending()
        else researchService = { ok: false, reason: adopted.sentence }
      }
      mountResearchScopeControl()
      const projectOptions = composeResearchOptions()
      if (composePanel?.isOpen?.()) composePanel.open(projectOptions)
      for (const panel of workspaceComposePanels) if (panel.isOpen()) panel.open(projectOptions)
    })
  }

  function composeResearchOptions() {
    return {
      researchProjects: researchService?.ok ? researchService.projects.filter(project => project.status !== 'archived') : [],
      researchUnavailableReason: mockSource() ? 'Research projects are available with your own data.'
        : researchService?.ok ? '' : researchService?.reason || 'Reading research projects…',
    }
  }

  function refreshTreeSwitch() {
    paintFleetOverview()
  }

  /* ---------- the press, the panel, and the start ---------- */

  function closeComposePanel(expectedPanel = composePanel) {
    /* Start can finish after the person has selected a chat or opened another
       compose panel. Only retire the panel that initiated that Start, and only
       restore its previous rail if the person is still looking at it. */
    if (composePanel !== expectedPanel) return
    const restoreRail = composePage.classList.contains('is-active') ? railBeforeCompose : null
    composePanel?.destroy()
    composePanel = null
    composePage.innerHTML = ''
    if (restoreRail) activateRail(restoreRail)
    railBeforeCompose = null
  }

  /* WHICH PARENT THE NEW AGENT REALLY HANGS UNDER.
   *
   * A child slot can be pressed under two very different circles: one this
   * person started, which the tree store knows, and one that came from the
   * fleet record or the declared organisation, which it does not. The store can
   * only hang a node under its own, so a press under a fleet agent begins a NEW
   * tree — and `null` is how the panel is told that, which makes it say so in
   * its own words before anything is typed. Handing over the pressed agent's id
   * would produce a panel promising a place in the tree that the store would
   * then refuse, after the person had written their brief. */
  function composeParentFor(detail) {
    if (!treeStore || !detail || detail.kind !== 'child') return null
    const node = treeStore.getNode(detail.parentId)
    if (!node) return null
    return { id: node.id, name: treeNodeName(node),
      researchProjectName: treeStore.getTree(node.treeId)?.researchProjectName || treeStore.getTree(node.treeId)?.researchProjectId || '' }
  }

  /* The three facts this owes a person, in the order they need them: what is
     off, that turning it on starts nothing by itself, and where the switch is.
     The first sentence is shared with the agent page's switched-off surface,
     which is the other place this same flag is explained. */
  /* SHORT ON PURPOSE, AND THE COMMENT IS SHORT FOR A REASON TOO: the gate that
     guards this sentence (start-control-flag-gates-the-tree.test.mjs) reads a
     700-character window from this function, so a long note here pushes the
     code out of its own test. The rest of the reasoning is in the commit.

     Four sentences became three (owner, on this panel: "messy"). What went was
     the JOURNEY -- "Settings -> Write -> Run an agent session" -- spelled out in
     prose directly above a button that does it in one press. Settings is still
     named, because a refusal that names nowhere to change a thing is a dead end
     and that gate is right. */
  /* THE ONE-PRESS WAY OUT, offered only for the one reason a press can undo.
   *
   * Owner's rule, and it is the reason this is a control and not a default:
   * his recorded answer stays off until HE presses. So nothing here writes
   * anything -- composeUnavailableAction only DESCRIBES a press, and the write
   * happens inside `run`, which is the click handler and nowhere else.
   *
   * It answers null for every other absence. A browser with no application
   * behind it and a saved forest that would not open are both real reasons the
   * panel is switched off, and neither is a thing this button could change; a
   * control that cannot work is worse than the sentence alone.
   *
   * THE SAME WRITE THE SETTINGS CONTROL MAKES, not a second one:
   * setWriteEnabled is the single writer of these rows (src/write-flags.js),
   * which is what makes the two surfaces incapable of disagreeing. */
  const nativeTreeReadOnlyReason = 'The computer’s saved trees are read-only here. Add or change agents on that computer.'

  function composeUnavailableAction(detail) {
    /* Mock answers null FIRST: the example refusal's remedy is the Data & Sim
       toggle, and that is a navigation, not a press this panel may perform.
       The old one-press "turn the example off" flipped a per-view live flag —
       a mechanism that no longer exists. */
    if (mockSource() || treeStoreProblem || authoritativeTreeSnapshot) return null
    if (isWriteEnabled(START_CONTROL_FLAG)) return null
    return {
      label: START_CONTROL_ON.label,
      run: () => {
        /* RECORDED BEFORE THE WRITE, because the write is what destroys this
           view. See composeToRestore: the announcement is synchronous, the
           re-render is a microtask behind it, and by the time this function
           returns there may be no panel left to answer. */
        composeToRestore = detail || null
        setWriteEnabled(START_CONTROL_FLAG, true)
        /* READ BACK, never assumed. The flag store can refuse -- a browser with
           storage switched off keeps the old answer -- and reporting a switch
           that did not move would reopen the panel with a live Start control
           over a computer that still refuses every start. */
        if (!isWriteEnabled(START_CONTROL_FLAG)) { composeToRestore = null; return false }
        /* AND BOTH QUESTIONS ARE ASKED AGAIN, not just this half of Start's
           availability. Turning on the flag can reveal a missing application;
           handing that reason back keeps Start disabled while Set stays usable. */
        return composeUnavailableReason() || composeStartUnavailableReason() || true
      },
    }
  }

  /* WHY THE PANEL IS NEVER WITHHELD.
     A press is a question, and every press gets an answer in the place the
     person is looking. A mock board or unreadable saved forest opens the panel
     with its fields switched off; the reason is printed in it.
     src/agent-compose-panel.js keeps Cancel alive for exactly this. A missing
     launcher disables Start alone, so
     Set stays usable. Silently ignoring the press would leave a
     person pressing a circle that does nothing, which is the state this whole
     feature was built to end. */
  function composeUnavailableReason() {
    if (authoritativeTreeSnapshot) return nativeTreeReadOnlyReason
    if (mockSource()) return exampleBoardText()
    if (treeStoreProblem) return treeStoreProblem
    return ''
  }

  /* A START-SPECIFIC ABSENCE DOES NOT MAKE THE FORM UNAVAILABLE. Set still
     records an honest draft, while Start stays present and says why it cannot
     launch on this computer. */
  function composeStartUnavailableReason() {
    /* THE SWITCH THAT DECIDES WHETHER THIS PRODUCT MAY START AN AGENT, asked
       on the surface that actually starts them.
     *
     * Setup's own words for the cautious answer are "nothing here will start an
     * agent", and it turns this flag off to make that true. It was true of the
     * agent page, which asks -- and only of the agent page. THIS page never
     * asked: the dashed circle opened its panel, "Start this agent" went all
     * the way to the engine, and what came back was an ENGINE refusal about
     * Codex, on a computer whose owner had been promised nothing here would
     * start anything. Measured on the packaged build 2026-08-16 on a fresh
     * profile that answered "Nothing yet -- let me look around first".
     *
     * A promise the product makes in setup is checked where the promise can be
     * broken. The panel still opens and still says why -- see the note above on
     * why the panel is never withheld -- and the sentence names the switch, so
     * a person who wants it can find it. */
    if (!isWriteEnabled(START_CONTROL_FLAG)) return startControlOffReason()
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!bridge || typeof bridge.start !== 'function') return START_NEEDS_APP_TEXT()
    /* THE LIMITS ARE NOT RE-ASKED HERE. src/fleet-trees.js refuses a tree past
       its own cap in its own words, and those words come back from addNode on
       submit. Asking the same question early would put a second wording of one
       rule on the screen, and the two would drift the first time only one was
       edited. */
    return ''
  }

  /* ASK THE SHELL WHICH ENGINES START, ONCE PER MOUNT.
   *
   * The renderer used to answer this itself, from a frozen ['codex'] in
   * src/fleet-tree-copy.js. The shell's tier gate now opens on the payload
   * genuinely carrying an engine -- a require() that must export a start
   * function -- so a build WITH the Claude engine would start a Claude tier
   * while the menu went on saying it could not. A menu that contradicts the
   * button is worse than either answer alone.
   *
   * Read once at mount rather than per press: the answer is a property of the
   * installed payload, which cannot change while this page is open, and a round
   * trip on every press of an empty node would be paid for nothing. Every
   * failure -- no bridge, no channel, a rejected call, an unparseable reply --
   * leaves the pessimistic default in place, because none of them learned
   * anything about what this copy can start.
   */
  /* THE FOLDER A TREE STARTS IN, ASKED WHERE THE PERSON STARTS THE TREE.
   *
   * Owner, 2026-08-16: "when a user starts a tree they should select a folder,
   * they can have a default folder, where the agents spawn"; and again on
   * 2026-08-19, having gone looking for it: "what happened to sessions and
   * choosing a folder for each tree and such?"
   *
   * NOTHING NEW IS BUILT HERE. The named folders already exist in the main
   * process (mcAgent.profiles(), created through the OS dialog by the fleet
   * rail's own panel), a tree already carries one (`setTreeProfile`), and every
   * start already sends it (`profileId`, below). The only thing missing was the
   * QUESTION at the moment a tree is created. The profile panel and composer
   * share each reading, including the fresh reading after a folder is added
   * or removed. The main-process profile store remains the authority.
   *
   * A REFUSAL IS AN EMPTY LIST, NEVER A THROWN ERROR. With no bridge, or a
   * bridge that will not answer, the panel draws its "no folders set up yet"
   * sentence and a start still works -- in the product's own workspace, exactly
   * as it did before folders existed. */
  let composeFolders = []
  let composeFoldersReadVersion = 0
  async function readComposeFolders() {
    const version = ++composeFoldersReadVersion
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    let answer = null
    if (bridge && typeof bridge.profiles === 'function') {
      try { answer = await bridge.profiles() } catch { answer = null }
    }
    if (destroyed || version !== composeFoldersReadVersion || mockSource()
        || bridge !== (typeof window === 'undefined' ? null : window.mcAgent)) return
    replaceProfileCwds(answer)
    return answer ?? null
  }

  /* WHERE A START THAT NAMES NO FOLDER REALLY RUNS, ASKED OF THE PROCESS THAT
   * DECIDES IT.
   *
   * shell/main.cjs resolves a start with no profileId through
   * chosenWorkspaceCwd(): the folder the person answered the setup question
   * with, and <userData>\workspace only on a machine where nobody was ever
   * asked. The panel above was still telling everyone the second answer.
   * Measured on the packaged build, two runs, same panel sentence:
   *
   *   finished setup, took the suggested folder   signed record cwd = that folder
   *   skipped setup, nobody was ever asked        signed record cwd = null
   *
   * `chosen` IS THE GATE, and it is the same gate the shell uses -- setup picks
   * a default folder silently before the question is shown, so the mere presence
   * of a root proves nothing about whether anyone answered. Anything less than a
   * clean, available, chosen reading leaves this empty, which is exactly the
   * sentence this panel drew before the setup folder was honoured.
   *
   * Read ONCE per mount, like readStartableTiers():
   * it is a property of this computer, not of the press. */
  let composeDefaultFolder = ''
  async function readComposeDefaultFolder() {
    const bridge = typeof window === 'undefined' ? null : window.mcSetup
    if (!bridge || typeof bridge.workspaceState !== 'function') return
    let answer = null
    try { answer = await bridge.workspaceState() } catch { answer = null }
    if (destroyed) return
    const roots = answer && answer.ok === true && answer.available === true && answer.chosen === true
      && Array.isArray(answer.roots) ? answer.roots : []
    const first = roots.find(entry => typeof entry === 'string' && entry.trim() !== '')
    composeDefaultFolder = first ? first.trim() : ''
    const defaultOption = controlsPage.querySelector('[data-tree-default-profile]')
    if (defaultOption) defaultOption.textContent = treeDefaultFolderLabel()
    if (composePanel?.isOpen?.()) {
      composePanel.open({ defaultFolder: composeDefaultFolder })
    }
  }

  function treeDefaultFolderLabel() {
    return composeDefaultFolder ? PROFILE_PANEL.setupWorkspace(composeDefaultFolder) : PROFILE_PANEL.productWorkspace
  }

  /* Remembered posture, not a setting -- the same rule src/settings-presentation.js
     states for its own open-groups memory: it "grants nothing, gates nothing, and
     the settings footer does not count it". This decides which row a menu OPENS
     on; the person overrides it in the same gesture, and a folder they have since
     removed simply stops matching a row. */
  const LAST_FOLDER_KEY = 'mc.compose.last-folder'
  const lastComposeFolder = () => {
    try { return localStorage.getItem(LAST_FOLDER_KEY) || null } catch { return null }
  }
  const rememberComposeFolder = profileId => {
    try {
      if (profileId) localStorage.setItem(LAST_FOLDER_KEY, profileId)
      else localStorage.removeItem(LAST_FOLDER_KEY)
    } catch { /* session-only is still a real change */ }
  }

  /* THE SECOND REASON A ROW CANNOT START, WHICH THE MENU WAS PROMISING TO SAY.
   *
   * The panel's own help reads "Luna is a good default. Each row says so if this
   * copy cannot start it." That is a GUARANTEE, and a person who reads it stops
   * looking -- which is why it is worse than no warning at all.
   *
   * startableTiers() answers only "does this payload carry a launcher": the
   * shell's resolveStartTier() returns the row for any codex tier
   * unconditionally, so it structurally cannot see a missing sign-in. Measured
   * on the packaged build from a cold install, one machine, one moment: presence
   * said codex signedIn "no", startableTiers listed luna/terra/sol, the rows said
   * nothing, and the press refused with "This session needs a Codex sign-in".
   * Re-reading the probe after the press -- a completed round trip -- changed
   * nothing, and flipping presence to "yes" drew byte-identical rows.
   *
   * NOTHING NEW IS PROBED HERE. mcProviders.presence() already ships, is already
   * on this preload, and src/setup-review-readiness.js already asks it this exact
   * question one screen earlier. The only thing missing was this panel asking.
   * Only a PROVEN negative is used, and signedOutProviderIds() owns that
   * judgement -- see shell/provider-cli-presence.cjs, where only Codex treats a
   * missing sign-in file as proof, "because this shell already refuses a start on
   * exactly that basis".
   *
   * READ AT MOUNT AND AGAIN ON EVERY PANEL OPEN, which is a correction to what
   * stood here. This said "read once per mount ... a person who signs in and
   * comes back gets a fresh answer because the view is rebuilt", and that is
   * true only of a person who NAVIGATES AWAY and returns. The refusal this whole
   * warning exists to pre-empt ends "then come back to this screen", and the
   * literal reading of that -- stay on the board, run the command, press the
   * node again -- rebuilds no view.
   *
   * MEASURED ON THE PACKAGED BUILD, one moment, both sides read together: with
   * the sign-in restored while the board stayed open, presence answered codex
   * signedIn:'yes' and the reopened menu still drew "nobody is signed in to
   * Codex on this computer". A stale warning is a FALSE sentence, and it is the
   * more expensive direction of the two: it tells someone who has just done the
   * work that it did not take.
   *
   * IT IS CHEAP ENOUGH TO ASK AGAIN, which is why this is the fix rather than a
   * cache invalidation. shell/provider-cli-presence.cjs spawns no child and
   * reads no byte of any credential -- it is a handful of fs.statSync calls --
   * and it deliberately caches nothing, "a person who signs in and comes back to
   * this screen must see the new answer, and a cache is how they would not".
   * `signedOutProviders` is declared with startableTierIdList, above. */
  function repaintTierRows() {
    startableTierChoices = tierChoicesFor(startableTierIdList, signedOutProviders, noProgramProviders,
      'this computer', { answered: !tierAnswerMissing })
    /* A panel already on screen is re-opened over the same node so its menu
       carries the answer, rather than leaving the person reading rows that were
       drawn before the shell replied. */
    if (composePanel?.isOpen?.()) {
      composePanel.open({ tiers: startableTierChoices })
    }
    refreshTreeEngineFace()
  }

  /* ASKED AGAIN RATHER THAN BELIEVED ONCE.
   *
   * THE DEFECT THIS CLOSES, reported by the owner on his own machine: "why cant
   * i launch claude or gemini or grok or like. why only codex wtf." Every
   * launcher was in the payload, every CLI was installed and every account was
   * signed in. What had happened is one throw: the shell's
   * mc-agent:startable-tiers handler failed twice during a restart with
   * OWNER_HOST_CREDENTIAL_HYGIENE_FAILED, this function swallowed it, and the
   * fallback it fell back to IS the four Codex tiers -- so the tree offered
   * Codex, marked the seven Claude/Gemini/Grok rows "cannot start from a tree
   * yet", and never asked again.
   *
   * ONE FAILURE IS NOT AN ANSWER, and that is the whole change. The call is a
   * local IPC round trip to a handler that builds the agent host; the states it
   * fails in (an authority still coming up, a store briefly locked) are the
   * states it recovers from on its own within a moment. So a failed read waits
   * and asks again before it is believed, and only a read that has run out of
   * attempts sets tierAnswerMissing.
   *
   * THE BACKOFF IS SHORT ON PURPOSE. Someone is looking at a menu; this must
   * settle inside the time it takes them to read it, not inside the time it
   * takes a network to. Two waits, 250ms and 1s, then it stops -- the panel is
   * re-asked whenever the board, the chat or a new workspace chat mounts, so
   * the person's next navigation is another attempt at no cost here.
   *
   * ONE IN FLIGHT AT A TIME. Three call sites fire this on the same mount; the
   * retries would otherwise multiply into overlapping ladders all writing the
   * same two variables. A caller arriving mid-ladder joins the one that is
   * already running.
   *
   * IT STILL NEVER GUESSES UPWARD. Every exhausted path lands on the same
   * pessimistic list it always did; the only thing that changed is that the
   * rows now say which of the two facts that list represents. */
  const TIER_PROBE_BACKOFF_MS = Object.freeze([250, 1000])
  let tierProbe = null

  function readStartableTiers() {
    if (tierProbe) return tierProbe
    tierProbe = (async () => {
      const bridge = typeof window === 'undefined' ? null : window.mcAgent
      /* No bridge at all is not a failure to report: it is `npm run dev` in a
         plain browser, where the fallback is the honest and complete answer. */
      if (!bridge || typeof bridge.startableTiers !== 'function') return { answered: false, tiers: [] }
      let latestAnswer = { answered: false, tiers: [] }
      for (let attempt = 0; ; attempt += 1) {
        let reply = null
        try { reply = await bridge.startableTiers() } catch { reply = null }
        if (destroyed) return
        const answer = startableTierAnswer(reply)
        latestAnswer = answer
        startableTierAnswered = answer.answered
        if (answer.answered) {
          startableTierIdList = answer.tiers
          tierAnswerMissing = false
          /* The one place a reply was actually parsed, so the one place this
             may become true. */
          startableTierAnswered = true
          break
        }
        const wait = TIER_PROBE_BACKOFF_MS[attempt]
        if (wait === undefined) {
          startableTierIdList = answer.tiers
          tierAnswerMissing = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, wait))
        if (destroyed) return
      }
      /* THROUGH THE SHARED RECOMPUTE, never `tierChoicesFor(ids)` directly:
         readProviderSignIn() writes the same rows, and computing them here
         without its reading would silently erase the warning it had already
         put on them. */
      repaintTierRows()
      return latestAnswer
    })()
    const settle = () => { tierProbe = null }
    tierProbe.then(settle, settle)
    return tierProbe
  }

  async function readProviderSignIn() {
    const bridge = typeof window === 'undefined' ? null : window.mcProviders
    if (!bridge || typeof bridge.presence !== 'function') {
      providerPresence = null
      refreshTreeEngineFace()
      return
    }
    let reply
    try { reply = await bridge.presence() } catch { reply = null }
    if (destroyed) return
    providerPresence = reply?.ok === true && Array.isArray(reply.providers) ? reply.providers : null
    signedOutProviders = signedOutProviderIds(reply)
    noProgramProviders = notInstalledProviderIds(reply)
    repaintTierRows()
  }

  /* WHAT A SESSION STARTED FROM THIS PANEL WOULD BE ALLOWED TO DO.
   *
   * THE DEFECT THIS CLOSES, measured end to end on a scratch install at the
   * RECOMMENDED permission level: a person walked the whole walkthrough, pressed
   * an empty node here, wrote "create a file in this folder", and the operating
   * system refused the write. The only thing on screen about it was the agent's
   * own prose. src/agent-confinement-copy.js has owned the honest sentence for
   * that state since it was written, and src/agent-session.js renders it under
   * the agent page's Start button -- but this panel is the Start button a
   * first-time person actually reaches, and it said nothing at all.
   *
   * READ ONCE PER MOUNT, exactly like readStartableTiers() and
   * readComposeFolders() above, and for the same reason: the recorded permission
   * level is a property of this computer, not of the press.
   *
   * A BRIDGE THAT CANNOT ANSWER IS STILL ANSWERED. startControlLine() collapses
   * an absent or unreadable reading to "this page cannot tell", never to
   * something reassuring -- so the one case this must not produce is the one it
   * structurally cannot. It is the SAME channel and the SAME function the agent
   * page uses, so the two Start controls cannot describe one computer two ways.
   */
  let composeConfinementLine = ''
  /* THE COMPOSER CHIPS' AGENT CHIP READS THIS. composeConfinementLine (above)
     is a whole formatted SAFETY PARAGRAPH, not a bare id -- no use for a
     three-word chip. currentConfinementLevel is the raw level this same read
     already carries in `reading.level`, cached the same way, for a reader
     that needs the id rather than the sentence. See treeChatConfigFor's
     chips.tier. */
  let currentConfinementLevel = null
  async function readComposeConfinement() {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!bridge || typeof bridge.confinement !== 'function') return
    let reading = null
    try { reading = await bridge.confinement() } catch { reading = null }
    if (destroyed) return
    currentConfinementLevel = reading?.ok === true && sandboxLevel(reading.tier) ? reading.tier : null
    notifyNodeStatusListeners()
    /* The safety paragraph names the machine it is about. Over the relay that
       machine is somewhere else, and this is the one paragraph where getting
       the referent wrong could get somebody's files deleted on a computer they
       thought they were only looking at. */
    composeConfinementLine = startControlLine(reading, {
      subject: currentDataSource() === 'relay' ? CONFINEMENT_SUBJECT_REMOTE : CONFINEMENT_SUBJECT_HERE,
    })
    if (composePanel?.isOpen?.()) {
      composePanel.open({ confinementLine: composeConfinementLine })
    }
  }

  function openComposeFor(detail) {
    showWorkspaceControls()
    graph?.setWide?.(false)
    if (destroyed || !computer) return
    /* ASKED AGAIN HERE, because the sign-in is the one input that changes while
       this view stays mounted -- see readProviderSignIn(). It settles after the
       panel is built and repaints the menu over the same node, exactly as the
       tier list and the confinement line already do. Not under mock: no
       bridge call from a mock-sourced press, and the panel it would repaint
       is disabled with the example sentence anyway. */
    if (!mockSource()) void readProviderSignIn()
    syncTreeStore()
    const parent = composeParentFor(detail)
    /* A parent with no free child slot is refused BEFORE a brief is typed,
       in the store's own words, rather than after Set (T1377). */
    const childSlot = parent ? treeStore?.childSlot?.(parent.id) : null
    const unavailable = composeUnavailableReason() || (childSlot && !childSlot.canAdd ? childSlot.reason : '')
    const startUnavailable = composeStartUnavailableReason()

    if (!composePanel) {
      railBeforeCompose = controlsPage.classList.contains('is-active') ? controlsPage : statsPage
    }
    composePanel?.destroy()
    composePage.innerHTML = ''
    const submission = { active: () => composePanel === submission.panel }
    composePanel = mountAgentComposePanel({
      container: composePage,
      parent,
      ...composeResearchOptions(),
      /* Every shipped and custom role from the authoritative mcOrg.read()
         snapshot. The panel's internal five-role list is only a fallback for
         an unavailable read, and roleBindingForStart refuses to launch a
         chosen fallback without saved directions. */
      roles: composeRoleChoices(),
      unavailableReason: unavailable,
      startUnavailableReason: startUnavailable,
      /* AND THE WAY OUT OF IT, when this page owns one. See
         composeUnavailableAction(): it is offered for the switched-off flag and
         for nothing else, and it writes only when pressed. */
      unavailableAction: composeUnavailableAction(detail),
      /* WHICH ENGINES THIS COPY CAN REALLY START, asked of the shell rather
         than assumed by the renderer. See startableTiersNow() below. */
      tiers: startableTierChoices,
      /* THE FOLDERS, FROM THE ONE STORE THAT HOLDS THEM. Same list the fleet
         rail's profile panel reads and the tree rail's "Works in" menu is
         built from -- refreshed by readComposeFolders(), never a
         second register of folders kept beside the first. */
      folders: composeFolders,
      folderSelectedId: lastComposeFolder(),
      /* AND WHERE "NAME NO FOLDER" ACTUALLY LANDS ON THIS COMPUTER — see
         readComposeDefaultFolder(). Asked of the shell for the same reason the
         engine rows and the confinement line are: only the main process knows,
         and the renderer must not guess. */
      defaultFolder: composeDefaultFolder,
      /* WHAT THE SESSION THIS BUTTON STARTS MAY DO -- see
         readComposeConfinement(). Empty until that read answers, and empty
         renders nothing rather than something comfortable. */
      confinementLine: composeConfinementLine,
      onSubmit: draft => submitCompose(draft, detail, false, submission),
      onCancel: () => closeComposePanel(),
    })
    submission.panel = composePanel
    if (!composePanel) return
    activateRail(composePage)
    /* Focus lands INSIDE the panel either way, or the panel's root-level
       Escape handler is deaf: measured on the packaged build 2026-08-20
       (order-drive), a mouse-opened panel kept focus on the page behind it and
       Escape -- the panel's own documented cancel -- did nothing until a field
       was clicked. A key press still puts the caret in the first field, where
       that person is going next; a pointer press focuses the panel's ROOT
       instead, so no caret jumps into a field out from under the mouse (the
       harm the old keyboard-only condition guarded against). */
    if (detail?.via === 'keyboard') composePanel.focus()
    else composePanel.focusRoot()
  }

  /* ONE SUBMIT, FOUR OUTCOMES, AND THE MODEL TELLS THE TRUTH IN ALL OF THEM.
   *
   *   the draft is refused      nothing is created; the panel says why
   *   the start is refused      the node stays, marked as failed, with the
   *                             reason on it. It is NOT deleted: a person who
   *                             just described a job should not have to type it
   *                             again to find out what went wrong.
   *   the send is refused       a session IS open. It is attached first, so the
   *                             node points at the real thing, and only then
   *                             marked failed with a sentence that says the
   *                             agent is running and the message is not.
   *   everything worked         the session is attached, the node is running,
   *                             and the panel closes itself.
   *
   * IT RETURNS THE PANEL'S OWN REFUSAL SHAPE rather than throwing. A thrown
   * error would be replaced by the panel's fixed sentence — correctly, since an
   * Error's words are written for whoever holds the repository — and the person
   * would lose the specific reason their start did not happen.
   */
  async function submitCompose(draft, detail, workspace, submission) {
    /* Belt and braces: the panel opened disabled with this same sentence, and
       startAgentForNode refuses mock too — but a submit is the press that
       counts, and under mock the null store's fallback below would otherwise
       claim the app is missing, which on a desktop with the example on is
       simply false. */
    if (mockSource()) return { ok: false, message: exampleBoardText() }
    if (authoritativeTreeSnapshot) return { ok: false, message: nativeTreeReadOnlyReason }
    const store = treeStore
    if (!store) return { ok: false, message: treeStoreProblem || START_NEEDS_APP_TEXT() }
    const parent = composeParentFor(detail)
    /* THE LABEL IS THE ACTION, THE ONLY DECIDER (owner: "ITS SUPPOSED TO HAVE
       SET OR START AS OPTIONS"). This used to ask treeHasStarted() what the
       person's press MEANT -- context deciding an intent nobody stated, which
       is the exact defect the two-button panel exists to close: on a fresh
       tree treeHasStarted() is false by construction, so a person who pressed
       the button now LABELLED Start would have context-decided into Set, the
       button they did not press. draft.mode is 'set' or 'start' -- which
       button src/agent-compose-panel.js's attemptSubmit() actually ran --
       and it is read alone, never alongside treeHasStarted(), so the tree's
       state can no longer overrule what the person chose. */
    const willStart = draft.mode === 'start'
    if (willStart && !isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, message: startControlOffReason() }
    const retrying = Boolean(submission.nodeId)
    const retainedNode = () => {
      const current = store.getNode(submission.nodeId)
      return !destroyed && treeStore === store && submission.store === store && submission.active()
        && current?.treeId === submission.treeId && current?.parentId === submission.parentId ? current : null
    }
    const unavailable = () => ({ ok: false, message: 'This agent is already saved. Open its controls to continue; no new agent was created.' })
    const identityProblem = current => {
      if (!retrying) return null
      const seat = rootSeatFor(roleRecordFor(identityRoleForTreeNode(current.role)))
        || orgAvailability.org?.agents?.find(agent => agent.id === current.id)
      const provider = LAUNCH_TIERS.find(tier => tier.id === draft.tier)?.provider
      if (seat && (seat.role !== identityRoleForTreeNode(draft.role) || (provider && seat.provider !== provider))) {
        return { ok: false, message: 'The original agent remains saved with its role and provider. Keep those choices to retry, or cancel this form and create a new agent. Your typed task is still here.' }
      }
      return null
    }
    const finishDraft = async node => {
      const current = retainedNode()
      const retryState = unstartedTreeNodeRetryState(current)
      if (!current || current.status !== 'draft' || current.sessionId || retryState.hasSavedConversation
        || retryState.cleanupPending || retryState.busy) return unavailable()
      const identityRefusal = identityProblem(current)
      if (identityRefusal) return identityRefusal
      if (willStart && !isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, message: startControlOffReason() }
      const saved = result => result?.ok === true && !result.snapshot?.persistenceFailed
      const refusal = result => ({ ok: false, message: result?.problems?.[0] || result?.snapshot?.persistenceProblem || 'This task could not be saved, so no agent was started.' })
      if (current.role !== draft.role || current.message !== draft.message) {
        const updated = store.updateNode(node.id, { role: draft.role, message: draft.message })
        if (!saved(updated)) return refusal(updated)
      }
      if (current.tier !== (draft.tier || '') || current.effort !== (draft.effort || '')) {
        const updated = store.setNodeLaunchPreferences(node.id, { tier: draft.tier || '', effort: draft.effort || '' })
        if (!saved(updated)) return refusal(updated)
      }
      // Only the root form owns the tree's folder, including clearing an old
      // choice after a refused start. A child's retry never repoints its tree.
      if (!submission.parentId) {
        const researchProject = draft.workspaceKind === 'research'
          ? researchService?.ok && researchService.projects.find(project => project.projectId === draft.researchProjectId && project.status !== 'archived')
          : null
        if (draft.workspaceKind === 'research' && !researchProject) return { ok: false, message: 'Choose an available research project before starting this tree.' }
        const changedProject = store.setTreeResearchProject(node.treeId, researchProject?.projectId || null, researchProject?.name || '')
        if (!saved(changedProject)) return refusal(changedProject)
        const nextProfile = researchProject ? null : draft.profileId || null
        // A brand-new tree already has the null profile. Avoid a needless
        // persistence write in that case; a retry of an existing node still
        // persists an explicit clear so the removal is durable.
        if (!researchProject && (nextProfile !== null || retrying)) {
          const updated = store.setTreeProfile(node.treeId, nextProfile)
          if (!saved(updated)) return refusal(updated)
        }
        if (!researchProject) rememberComposeFolder(nextProfile)
      }
      refreshTree()
      if (!willStart) {
        setOrgStatus('Agent set. Start the tree when you are ready.', 'ok')
        if (!workspace) closeComposePanel(submission.panel)
        return { ok: true }
      }
      return startDraftNode(store.getNode(node.id), { effort: draft.effort, closePanel: !workspace })
    }
    const answer = async work => {
      const outcome = await work
      return workspace && submission.nodeId ? { ...outcome, node: store.getNode(submission.nodeId) } : outcome
    }
    // A form owns one created identity until it closes. A failed Start leaves
    // that identity visible; pressing either button again edits it, never a
    // second node. The existing retry gate protects attached conversations,
    // cleanup, authority changes and concurrent starts before resetting failed.
    if (retrying) {
      const current = retainedNode()
      if (!current) return unavailable()
      const identityRefusal = identityProblem(current)
      if (identityRefusal) return identityRefusal
      return answer(current.status === 'failed'
        ? retryUnstartedTreeNode(current, { start: finishDraft, requireStartControl: willStart, isCurrent: () => Boolean(retainedNode()) })
        : finishDraft(current))
    }
    const addDraft = fields => store.addNode(fields)
    /* ASKED AGAIN HERE, AND THIS IS THE ONE THAT COUNTS. The panel's disabled
       fields are what a person sees; this is what actually stops a START. A Set
       creates only the persisted draft and is allowed to stop there. The flag
       can be turned off while this panel stands open, so the real launch gate
       remains before addNode whenever this press would launch immediately. */
    const added = addDraft({
      parentId: parent ? parent.id : null,
      role: draft.role,
      message: draft.message,
      /* Recorded so "start this conversation over" can honestly reuse the
         tier the person chose, however much later the restart happens. */
      tier: draft.tier || '',
      /* Set closes this panel, so the node is the only place the person's
         exact effort choice can survive until the tree-level Start. */
      effort: draft.effort || '',
    })
    /* The store's own sentence, verbatim. It knows what it refused and why —
       a message too long, a branch too deep, a computer already holding as many
       trees as it keeps — and rewording any of that here would be this file
       having a second opinion about a rule it does not own. */
    if (!added.ok) return { ok: false, message: added.problems[0] || START_REFUSAL.noReasonGiven }

    const node = added.node
    Object.assign(submission, { store, nodeId: node.id, treeId: node.treeId, parentId: node.parentId })
    if (added.snapshot?.persistenceFailed) return answer({ ok: false, message: added.snapshot.persistenceProblem || 'This task could not be saved, so no agent was started.' })
    /* A NEW CIRCLE CAN RENAME AN OLD ONE, and this add may start a SECOND TREE
       (`parentId: parent ? parent.id : null`). The re-registration that answers
       that is not asked for here: it rides the store's own publish, in
       openTreeStore's subscriber, because this is not the only door that can
       add a root. See syncRenamedCircles(). */
    /* The draft is on the canvas BEFORE the bridge is called. A start takes
       seconds, and a person who pressed a circle and sees nothing appear will
       press it again — which is how two agents get started for one job. */
    return answer(finishDraft(node))
  }

  async function mountWorkspaceNewChat(host, { onSubjectCreated = null, onCancel = null, onEscape = null, draft: keptDraft = null, active = () => true } = {}) {
    if (!mockSource()) await Promise.all([readStartableTiers(), readProviderSignIn(), readComposeFolders(), readComposeDefaultFolder(), readComposeConfinement()])
    if (destroyed || !active()) return null
    let disposed = false, created = false
    const submission = { active: () => !disposed && active() }
    const panel = mountAgentComposePanel({
      container: host, parent: null, roles: composeRoleChoices(),
      ...composeResearchOptions(),
      unavailableReason: composeUnavailableReason(), startUnavailableReason: composeStartUnavailableReason(),
      unavailableAction: composeUnavailableAction(null), tiers: startableTierChoices,
      folders: composeFolders, folderSelectedId: lastComposeFolder(), defaultFolder: composeDefaultFolder,
      confinementLine: composeConfinementLine,
      onSubmit: async draft => {
        const result = await submitCompose(draft, null, true, submission)
        if (!disposed && !destroyed && result.node) {
          created = true
          if (!result.ok) workspacePendingStatus.set(result.node.id, {
            text: result.message || result.reason || result.sentence || 'This agent could not start. Open its controls and try again.', state: 'refuse',
          })
          keptDraft?.write?.(null)
          onSubjectCreated?.({ id: `agent:${computer.id}:${result.node.id}`, kind: 'agent', treeNode: true,
            agentId: result.node.id, computerId: computer.id, label: treeNodeName(result.node) })
        }
        return result
      },
      onCancel: () => onCancel?.(),
      onEscape: typeof onEscape === 'function' ? () => { if (!disposed && !destroyed && active()) onEscape() } : null,
    })
    if (!panel) return null
    const saved = keptDraft?.read?.()
    if (saved && typeof saved === 'object') {
      for (const [field, key] of [['role', 'role'], ['tier', 'tier'], ['effort', 'effort'], ['profile', 'profileId'], ['workspace-kind', 'workspaceKind'], ['research-project', 'researchProjectId'], ['message', 'message']]) {
        const control = host.querySelector(`[data-compose-field="${field}"]`)
        if (!control || typeof saved[key] !== 'string') continue
        if (control.tagName === 'SELECT' && ![...control.options].some(option => option.value === saved[key])) continue
        control.value = saved[key]
        control.dispatchEvent(new Event(field === 'message' ? 'input' : 'change', { bubbles: true }))
      }
      const message = host.querySelector('[data-compose-field="message"]')
      if (Number.isInteger(saved.start) && Number.isInteger(saved.end)) message?.setSelectionRange?.(saved.start, saved.end)
    }
    const originalDestroy = panel.destroy.bind(panel)
    panel.destroy = () => {
      if (disposed) return
      if (!created) {
        const message = host.querySelector('[data-compose-field="message"]')
        keptDraft?.write?.({ ...panel.draft(), message: message?.value || '', start: message?.selectionStart ?? 0, end: message?.selectionEnd ?? 0 })
      }
      disposed = true
      workspaceComposePanels.delete(panel)
      originalDestroy()
    }
    workspaceComposePanels.add(panel)
    return { root: panel.element(), dispose: () => panel.destroy(), focus: () => panel.focus() }
  }

  /* ONE LAUNCH PATH FOR BOTH BUTTONS. Compose calls this immediately once a
     tree has begun; the bar calls it for drafts that were set beforehand. */

  /* AN ASSISTANT ON THIS TREE HANDS WORK TO A NEW CIRCLE BESIDE IT.
   *
   * The order and every refusal live in src/create-and-start-node.js, which is
   * driven by tools/test/create-and-start-node.test.mjs. This supplies the real
   * stores, and one thing that cannot be supplied from a test: startDraftNode,
   * the SAME function the person's own Start button calls. That is what keeps a
   * circle an assistant asked for and a circle the person made from drifting
   * apart -- one seat, one role binding, one model, one tree-address line.
   *
   * One create at a time per parent circle. The broker holds a single active
   * command anyway, and the engine refuses a second concurrent spawn from one
   * circle by name, so this is the third place the same rule is true rather
   * than the only one. */
  const createFlightsByParent = new Set()
  async function createAndStartNode(command) {
    const parentNodeId = sessionNodeIds.get(command.parentSessionId) || null
    if (parentNodeId && createFlightsByParent.has(parentNodeId)) {
      return { ok: false, code: 'MC_TREE_SPAWN_ALREADY_RUNNING', nodeId: parentNodeId, sessionId: null, threadId: null }
    }
    if (parentNodeId) createFlightsByParent.add(parentNodeId)
    try {
      return await executeCreateAndStartNode({
        command,
        treeStore,
        sessionNodeIds,
        sessionThreadIds,
        roleRecordFor,
        launchTiers: LAUNCH_TIERS,
        startDraftNode,
        treeNodeName,
        refreshTree,
        /* The store's own sentence, on the line the person already reads for
           everything else this view refuses. */
        noteStoreRefusal: sentence => setOrgStatus(sentence, 'warn'),
      })
    } finally {
      if (parentNodeId) createFlightsByParent.delete(parentNodeId)
    }
  }
  /* ONE START PER DRAFT NODE AT A TIME, for the same reason resume and clean
   * replacement now share nodeReplacementFlight below (see
   * freshStartExistingNode's "ONE REPLACEMENT PER NODE AT A TIME").
   * startingNodeIds, just above createAndStartNode, is one of the three
   * hand-rolled guards single-flight.js's own header names as what
   * createSingleFlight replaced ("each a Set with an add before the first
   * await and a delete in a finally") -- but its add sits AFTER the first
   * await below, not before it, and nothing in this function ever called
   * startingNodeIds.has(node.id) to refuse a second entry. It is read
   * elsewhere only for display (a stale 'starting' status left by a previous
   * app run; an "active agent" count), never as a guard, so it stayed a Set
   * that recorded a start in progress without ever being asked whether one
   * already was.
   *
   * The only gate against running twice for the same node,
   * `liveNode.status !== 'draft'`, is read once at entry and not written
   * back to 'starting' until AFTER `await ensureSeatForNode` -- a real
   * seat-provisioning round trip with its own revision-conflict retry (see
   * ensureSeatForNode below). Reachable three ways with nothing else in
   * common: a fast double press of Start on one draft node's own panel;
   * startSetTree's bulk "Start Set" racing an individual Start on one of the
   * very drafts it just gathered (startSetTree guards itself against a
   * second startSetTree for the same TREE with startingTreeIds -- checked
   * and added to synchronously, before any await, exactly the pattern this
   * function lacked -- which says nothing about one node inside the tree
   * also being started by hand); and an assistant's create-and-start-node
   * handing its brand-new draft node to this same function while the
   * person, watching refreshTree() paint that circle immediately, presses
   * Start on it themselves before the assistant's own call reaches its
   * first await's continuation. Two bridge.start calls for one draft node
   * is the identical failure resumeFlight's historical comment already
   * named as the reason createSingleFlight exists: the later one wins the
   * node, the earlier keeps running -- and spending -- with nothing on
   * screen able to reach it again. */
  const startDraftFlight = createSingleFlight()
  async function startDraftNode(node, options = {}) {
    const outcome = await startDraftFlight.run(
      node && node.id != null ? node.id : null,
      () => options.queueManaged === true ? startDraftNodeUnguarded(node, options) : startDraftNodeQueued(node, options),
    )
    if (!destroyed) refreshTreeStartControls()
    if (!outcome.ran) {
      return { ok: false, code: 'MC_TREE_COMMAND_ALREADY_RUNNING', message: 'This agent is already starting. Wait for it to finish, then try again.' }
    }
    return outcome.value
  }
  async function startDraftNodeQueued(node, options) {
    if (!node?.id) return { ok: false, notStarted: true, message: 'This agent is no longer set.' }
    // Retain the initiating panel once. A retry must never close a different
    // draft the person opened while this one waited for resource headroom.
    const startPanel = options.closePanel ? composePanel : null
    const expired = () => options.treeCommand && !(Date.parse(options.treeCommand.expiresAt) > Date.now())
    let queue
    queue = createTreeLaunchQueue({ nodes: [node], concurrency: 1,
      start: pending => {
        if (expired()) {
          queue.cancel()
          return { ok: false, notStarted: true, code: 'MC_TREE_COMMAND_COMPLETION_TIMEOUT' }
        }
        return startDraftNodeUnguarded(pending, { ...options, startPanel,
          isCancelled: () => queue.snapshot().cancelled || expired() })
      },
      onChange: state => {
        if (destroyed) return
        refreshTreeStartControls()
        refreshLaunchStatus()
        if (!state.finished && (state.waiting || state.paused || state.cancelled)) {
          // The words are already saved on the drawn node. Retire only its
          // compose panel, exposing the queue's real Pause/Cancel controls.
          // Selecting its circle or another rail does not cancel the request.
          if (startPanel) closeComposePanel(startPanel)
          setOrgStatus(state.cancelled ? 'Queued start cancelled; an agent already starting may finish.'
            : state.paused ? 'Start queue paused. The unstarted agent stays set.'
            : `${state.reason} This agent is queued; use Pause queue or Cancel queued above the tree.`, 'busy', { sticky: true })
        }
      },
    })
    nodeLaunchQueues.set(node.id, { treeId: node.treeId, queue })
    refreshLaunchStatus()
    refreshTreeStartControls()
    try {
      const report = await queue.done
      // An in-flight start can finish after Cancel. Preserve its real receipt;
      // cancellation must never claim that an existing session did not start.
      if (report.results.length) {
        if (report.results[0].abandoned === true) markLaunchAbandoned(report.results[0])
        return report.results[0]
      }
      const message = 'Start cancelled. The unstarted agent and its brief remain set on the tree.'
      if (!destroyed) setOrgStatus(message, 'ok', { sticky: true })
      return { ok: false, notStarted: true, message }
    } finally {
      nodeLaunchQueues.delete(node.id)
      if (!destroyed) refreshLaunchStatus()
      if (!destroyed) refreshTreeStartControls()
    }
  }
  async function startDraftNodeUnguarded(node, { effort = null, closePanel = false, startPanel = closePanel ? composePanel : null, isCancelled = () => false, delegationToken = null, boundedWork = null, research = null, ownedStore = null, treeCommand = null } = {}) {
    const panelForStart = startPanel
    if (mockSource()) return { ok: false, message: exampleBoardText() }
    // A bounded controller retains the exact app-owned store across routes.
    // Ordinary page starts still require this view and its current store; the
    // host independently rechecks bounded parent, role, folder and time cap.
    const backgroundStart = Boolean(boundedWork && ownedStore)
    const store = backgroundStart ? ownedStore : treeStore
    if (!store) return { ok: false, message: treeStoreProblem || START_NEEDS_APP_TEXT() }
    if (!isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, message: startControlOffReason() }
    const liveNode = store.getNode(node?.id)
    if (!liveNode || liveNode.status !== 'draft') return { ok: false, message: 'Only an agent that has not started can be started here.' }
    node = liveNode
    const editorCopy = node.pendingEditorFork ? editorAttachmentDrafts.forNode(node, treeStoreId) : { ok: true, receipt: null }
    if (!editorCopy.ok) return { ...editorCopy, message: editorCopy.reason }
    const accountStart = slotAccountStartOptions(node, LAUNCH_TIERS.find(row => row.id === node.tier)?.provider)
    if (!accountStart.ok) return { ...accountStart, notStarted: true, message: accountStart.reason }
    const draft = {
      role: node.role,
      message: node.message,
      tier: node.tier,
      effort: draftStartEffort(node, { override: effort, tierDefault: tierEffortOf(node.tier) }),
    }
    /* The chosen canvas role remains optional. Its declared identity is not:
       a blank role uses the bounded Worker identity, and a selected role uses
       itself. Both paths must finish the seat write and exact binding before a
       session is even requested. */
    const identityRole = identityRoleForTreeNode(draft.role)
    const seatOutcome = await ensureSeatForNode(node, identityRole)
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) return { ok: false, code: 'MC_TREE_COMMAND_START_DISABLED', message: startControlOffReason(), reason: startControlOffReason() }
    const boundRole = roleBindingForStart(node.id, identityRole, draft.role)
    if (!seatOutcome?.ok || !boundRole.ok || !boundRole.binding?.agentId) {
      const identityReason = seatOutcome?.ok === false && seatOutcome.reason
        ? seatOutcome.reason
        : boundRole.message || 'This agent could not be given a declared identity, so it was not started. Reload this page, then try again.'
      const identityCode = seatOutcome?.code || boundRole.code || 'MC_TREE_IDENTITY_UNAVAILABLE'
      setOrgStatus(identityReason, 'refuse', { sticky: true, code: identityCode })
      return { ok: false, message: identityReason, code: identityCode }
    }
    /* `treeStore !== store` FIRST, BECAUSE NEITHER OF THE OTHER TWO CAN SEE IT.
     *
     * `destroyed` catches this view being torn down; the status re-read catches
     * the draft being started or removed underneath. Both interrogate `store` --
     * the reference captured before the awaits above -- so neither can notice
     * that the still-LIVE view has replaced it. `switchComputer` (a bare tab
     * click) and the example-fleet toggle both reassign `treeStore` for this
     * same computer without setting `destroyed`, and while these awaits are
     * outstanding RUN_STARTING_TREE_STORES is still empty -- this caller retains
     * AFTER its awaits, not before -- so openTreeStore's chain finds nothing to
     * reuse and mints a SECOND store over the same storage. createFleetTreeStore
     * reads storage once at construction, so the two fork from that moment.
     * Finishing against the captured reference then writes this node's status
     * and its session onto a store nothing on screen is drawn from: a real
     * session, open and spending, on a circle that still shows `draft` with no
     * Stop, and the person's next tree edit refused as a stale write.
     * resumeNodeSessionUnguarded already makes exactly this re-check.
     * Driven by tools/test/tree-start-route-outcome.test.mjs. */
    if ((!backgroundStart && (destroyed || treeStore !== store)) || isCancelled() || store.getNode(node.id)?.status !== 'draft') return { ok: false, notStarted: true }
    if (currentDataSource() === 'local' && typeof window.mcResources?.status === 'function') {
      let admission
      try {
        const provider = LAUNCH_TIERS.find(entry => entry.id === (node.tier || TREE_DEFAULT_STARTABLE_TIERS[0]))?.provider
        if (!provider) {
          const code = 'AGENT_TIER_UNKNOWN'
          const message = 'The saved model choice is no longer available. Choose a model in this agent’s controls, then start it again.'
          setOrgStatus(message, 'refuse', { sticky: true, code })
          return { ok: false, notStarted: true, code, message }
        }
        admission = (await window.mcResources.status({ provider, roleBinding: boundRole.binding }))?.admission
      } catch { admission = { ok: false, code: 'AGENT_RESOURCE_UNKNOWN', reason: 'The resource monitor is not ready. Waiting for a fresh reading.' } }
      if (!admission?.ok) {
        const code = admission?.code || 'AGENT_RESOURCE_UNKNOWN'
        const message = admission?.reason || 'The resource monitor could not answer.'
        setOrgStatus(message, isResourceHold(code) ? 'busy' : 'refuse', { sticky: true, code })
        // `measured` is what lets the queue say memory, CPU or a loop stall
        // when it gives up, instead of the code's one sentence.
        return { ok: false, retryable: isResourceHold(code), code, message, retryAfterMs: admission?.retryAfterMs,
          ...(admission?.measured && typeof admission.measured === 'object' ? { measured: admission.measured } : {}) }
      }
    }
    // The same re-check after the resource await: the swap can land during
    // either await, and this is the last gate before the first write.
    if ((!backgroundStart && (destroyed || treeStore !== store)) || isCancelled() || store.getNode(node.id)?.status !== 'draft') return { ok: false, notStarted: true }
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) return { ok: false, code: 'MC_TREE_COMMAND_START_DISABLED', message: startControlOffReason() }
    const parentNode = node.parentId ? store.getNode(node.parentId) : null
    const parent = parentNode ? { id: parentNode.id, name: treeNodeName(parentNode) } : null
    const prepared = store.setNodeStatus(node.id, 'starting', { note: '' })
    if (prepared?.ok !== true || prepared.snapshot?.persistenceFailed) {
      // A quota failure may accept the in-memory status while refusing its save.
      // No provider was requested, so leave this draft retryable, not busy.
      if (prepared?.ok === true && !store.getNode(node.id)?.sessionId) store.setNodeStatus(node.id, 'draft', { note: '' })
      const problem = prepared?.snapshot?.persistenceProblem || prepared?.problems?.[0] || 'The starting state could not be saved.'
      const message = `This agent was not started. ${problem}`
      setOrgStatus(message, 'refuse', { sticky: true, code: 'MC_TREE_START_NOT_SAVED' })
      refreshTree()
      return { ok: false, notStarted: true, code: 'MC_TREE_START_NOT_SAVED', message }
    }
    startingNodeIds.add(node.id)
    refreshTree()
    /* The one line on this page that survives the panel closing, in the same
       place and the same three states the drag already reports in: busy while it
       is in flight, green when it ran, and a refusal that STAYS until the next
       attempt. A start crosses a background service and another program, so the
       wait is real and a canvas that said nothing during it is where somebody
       presses a second circle for the same job. */
    setOrgStatus(startingLine(roleDisplayFor(draft.role)), 'busy', { sticky: true })

    /* THE NODE IS BOUND TO ITS SESSION BEFORE ITS MESSAGE IS SENT, and every
       line of this block used to sit after the send. See the note on
       startAgentForNode's `onSessionOpen`: a turn whose first words arrive
       before the send is answered found no binding here and was dropped whole,
       so the node stayed at `running` for as long as anyone waited. Nothing
       here is optimistic -- the session is open and named by the time this
       runs; only the message is still on its way. */
    let attachProblem = null
    /* WHERE THIS AGENT STANDS IN THE TREE, SENT WITH THE JOB.
     *
     * Owner, 2026-08-18: "This one is not realizing and not able to contact its
     * manager." The tree drew Default under Manager and the session was told
     * neither fact, so the agent asked the person for "the manager's
     * identifier". The names here are treeNodeName's, which is to say the words
     * on the circles -- an agent that answers "Manager: ..." is naming what the
     * person can see, never an internal id. */
    const briefContext = research ? null : briefContextFor(node, parent, store)
    /* Restricted children receive only their explicit research prompt; the
       trusted treeIdentity registers the node without parent/project context. */
    const startText = research ? research.prompt : composeNodeBrief({ message: draft.message, ...briefContext })
    const capturedProfileId = startProfileId(node.treeId ? store.treeProfile(node.treeId) : null)
    const startTranscripts = transcriptStore
    const releaseStartingStore = retainStartingTreeStore(store)
    const startInFlight = startAgentForNode({
      text: startText,
      ...accountStart.options,
      surface: 'fleet-tree',
      tier: draft.tier,
      effort: draft.effort,
      /* The tree's assigned session profile rides with every start in it --
         per-tree onboarding, which is the whole point of profiles. Null means
         the product's own workspace, exactly as before profiles existed. */
      profileId: node.treeId ? store.treeProfile(node.treeId) : null,
      researchProjectId: store.getTree(node.treeId)?.researchProjectId || null,
      requestKeys: nodeRequestKeys(node, store),
      treeIdentity: nodeTreeIdentity(node, store),
      delegationToken,
      boundedWork,
      ...(research ? { research } : {}),
      editorForkReceipt: editorCopy.receipt,
      treeCommandRequestId: treeCommand?.requestId || null,
      roleBinding: boundRole.binding,
      sessionIsOpen: sessionId => sessionNodeIds.has(sessionId),
      onSessionEnd: ({ sessionId }) => { retireTreeSessionRuntime(sessionId) },
      onFirstTurnFailure: outcome => {
        const current = store.getNode(node.id)
        if (!current || current.sessionId !== outcome.sessionId) return
        store.setNodeStatus(node.id, 'failed', { note: statusNote(outcome.sentence) })
        if (!destroyed) {
          refreshTree()
          setOrgStatus(outcome.sentence, 'refuse', { sticky: true, code: outcome.code })
        }
      },
      onCleanupRequired: ({ sessionId }) => { retainTreeSessionCleanup(store, node.id, sessionId, { note: statusNote(startCleanupSentence()) }) },
      onSessionOpen: ({ sessionId, threadId, account, roleIntroduction, researchRestriction, resourceAdmission }) => {
        if (editorCopy.receipt) editorAttachmentDrafts.forget(node.id, treeStoreId)
        sessionNodeIds.set(sessionId, node.id)
        sessionEfforts.set(sessionId, draft.effort || tierEffortOf(draft.tier))
        if (threadId) sessionThreadIds.set(sessionId, threadId)
        sessionAccountNames.set(sessionId, account || null)
        if (researchRestriction && typeof store.setNodeResearchRestriction === 'function') {
          store.setNodeResearchRestriction(node.id, researchRestriction)
        }
        /* THE FIRST THING SAID IS RECORDED LIKE EVERY OTHER THING SAID, and
         * until now it was the one turn that was not.
         *
         * Owner, 2026-08-18: "Sometimes the messages in history disappear."
         * transcriptAppend was called from three places -- a typed message, a
         * drained queued message, and a completed turn -- and the compose
         * panel's brief was none of them. It survived on screen only through
         * treeChatConfigFor's `!history.length` fallback, and the FIRST reply
         * ended that: one appended agent line made the transcript non-empty,
         * the fallback stopped firing, and the person's own opening question
         * vanished from the conversation for good. The durable excerpt was
         * written from the same lines, so a resumed agent was handed a
         * conversation with no brief in it either.
         *
         * TWO ENTRIES, NOT ONE. The person's words stand alone in the first,
         * exactly as typed. What the product added about the tree is the
         * second, visible and separate -- this page does not send an agent
         * something it will not show. `who: 'you'` for both, which is the same
         * slot the resume marker already uses: it is the side of the
         * conversation these words were sent from, not a claim about who typed
         * them. Ordered before any reply can arrive, because this runs before
         * the send. */
        if (draft.message) transcriptAppend(sessionId, { who: 'you', text: draft.message, at: Date.now() }, { persist: false })
        transcriptAppend(sessionId, { who: 'you', text: nodeManagerContext(briefContext), at: Date.now() }, { persist: false })
        if (roleIntroduction) transcriptAppend(sessionId, { who: 'you', text: roleIntroduction, at: Date.now() }, { persist: false })
        if (resourceAdmission?.bootstrapController === true) transcriptAppend(sessionId, {
          who: 'action', tool: 'Resource policy', state: 'done', at: Date.now(),
          text: 'Controller bootstrap: mechanical admission was used for the first authorised organisation-root controller so it can supply resource advice.',
        }, { persist: false })
        /* The page may have closed while the host opened the session. Save
           its opening lines once to the captured stores, which still belong
           to this handoff after the view releases its own references. */
        persistTranscript(sessionId, { transcripts: startTranscripts, trees: store })
        /* First running session of the window: ask the engine what it offers,
           so every depth menu after this is the provider's list rather than
           ours. */
        readEngineCatalog(sessionId)
        const attached = store.attachSession(node.id, sessionId)
        if (!attached.ok || attached.snapshot?.persistenceFailed) {
          attachProblem = attached.problems[0] || null
        }
        rememberBoundSessionProfile(sessionId, node.id, capturedProfileId, store)
        store.setNodeStatus(node.id, 'running', { note: '' })
        if (!destroyed) refreshTree()
        /* THE RAIL A PERSON ALREADY HAS OPEN ON THIS NODE IS BOUND TO THE
           SESSION-LESS PANEL THAT WAS BUILT BEFORE THIS LANDED. Rebind it, on
           the node's record as it stands AFTER the two writes above, so the
           remounted panel carries the live session, its composer, and its
           registered chat surface. See rebindRailToSession. */
        if (!destroyed) rebindRailToSession(node.id)
      },
    })
    /* THE LINE ABOVE PROMISES A FEW SECONDS, SO SOMETHING HAS TO NOTICE WHEN IT
       IS NOT. The start settles on its own eventually -- at the transport's
       five-minute ceiling -- and until it does, the busy line keeps saying a
       few seconds. Disarmed in a `finally` so a start that THROWS cannot leave
       a timer behind to overwrite its own refusal a minute later. */
    const driving = currentDataSource() === 'relay'
    const stallTimer = setTimeout(() => {
      if (!destroyed) setOrgStatus(startStalledLine({ driving }), 'busy', { sticky: true })
    }, startStallMs({ driving }))
    let result
    try {
      result = await startInFlight
    } finally {
      clearTimeout(stallTimer)
      startingNodeIds.delete(node.id)
      releaseStartingStore()
    }

    if (!result.ok) {
      if (!result.sessionId && isResourceHold(result.code)) {
        store.setNodeStatus(node.id, 'draft', { note: destroyed ? statusNote(result.sentence) : '' })
        if (!destroyed) {
          refreshTree()
          setOrgStatus(result.sentence, 'busy', { sticky: true, code: result.code })
        }
        return { ok: false, retryable: true, code: result.code, message: result.sentence }
      }
      if (result.sessionEnded === true && result.sessionId) {
        /* The process did start, and the main process also proved it ended.
           Preserve that run's id without putting it in the live map or calling
           it a start failure. A stored starting/running node with no runtime
           mapping is the tree's existing, shared "stopped session" state. */
        store.attachSession(node.id, result.sessionId)
        retireTreeSessionRuntime(result.sessionId)
        const endedNode = store.getNode(node.id)
        if (endedNode && (endedNode.status === 'starting' || endedNode.status === 'running')) {
          store.setNodeStatus(node.id, endedNode.status, { note: statusNote(ENDED_SESSION.note) })
        }
        if (!destroyed) refreshTree()
        /* A session that is over is still a session, and the rail open on this
           node was built before there was one: it is showing "never started"
           over a run that happened. See rebindRailToSession. */
        if (!destroyed) {
          rebindRailToSession(node.id)
          setOrgStatus(result.sentence, 'refuse', { sticky: true, code: result.code })
        }
        return { ...(boundedWork ? result : {}), ok: false, message: result.sentence }
      }
      /* THE SESSION COMES FIRST WHEN THERE IS ONE. A send that was refused after
         a start that worked leaves a real agent running on this computer;
         attaching it before the node is marked failed means the tree points at
         the thing that exists, instead of leaving it running with nothing on
         screen naming it. */
      if (result.sessionId) store.attachSession(node.id, result.sessionId)
      store.setNodeStatus(node.id, 'failed', { note: statusNote(result.sentence) })
      if (!destroyed) refreshTree()
      /* The refusal came AFTER a real agent started, so this node now carries a
         session the open rail knows nothing about -- the same stale panel, over
         a running process this time. See rebindRailToSession. */
      if (!destroyed) rebindRailToSession(node.id)
      /* The identifier goes on the status line beside the sentence, never into
         it. `result.code` is null for the no-application branch, where there is
         no refusal to name because nothing was asked of anything. */
      if (!destroyed) setOrgStatus(result.sentence, 'refuse', { sticky: true, code: result.code })
      /* THE SECOND LINE OF ONE ANSWER, and only for the refusal it belongs to.
         A person whose computer has no assistant program is being sent to a
         terminal, and the shared copy keeps the "if you already have Node" route
         apart so a surface can offer it quietly. This panel shows one block of
         words, so quietly means after the sentence rather than beside it. */
      const panelSentence = result.needsAssistantProgram
        ? `${result.sentence} ${START_REFUSAL.assistantProgramNote}`
        : result.sentence
      return { ...(boundedWork ? result : {}), ok: false, message: panelSentence }
    }

    if (destroyed) return { ...result, ok: result.ok === true, sessionId: result.sessionId || null,
      threadId: result.threadId || null, persistenceFailed: store.snapshot().persistenceFailed,
      message: result.sentence || (store.snapshot().persistenceFailed ? TREE_RUNTIME_NOT_SAVED_TEXT : '') }

    if (store.snapshot().persistenceFailed) {
      // The real session remains on the runtime view, including its chat and
      // Stop actions. Report successful start and unsuccessful save separately.
      const message = TREE_RUNTIME_NOT_SAVED_TEXT
      refreshTree()
      reportTreePersistence(store.snapshot())
      setOrgStatus(runningLine(roleDisplayFor(draft.role)), 'ok')
      if (closePanel) closeComposePanel(panelForStart)
      return { ...result, ok: true, sessionId: result.sessionId, threadId: result.threadId || null, persistenceFailed: true, message }
    }
    if (attachProblem !== null) {
      const message = `${attachProblem} The session started, but its tree binding is unavailable. Keep this app window open.`
      setOrgStatus(message, 'refuse', { sticky: true })
      return { ok: false, sessionId: result.sessionId, message }
    }
    setOrgStatus(runningLine(roleDisplayFor(draft.role)), 'ok')
    /* THE PANEL CLOSES ITSELF ON A SUCCESS, AND THE RAIL HAS TO COME BACK WITH
       IT. The panel removes its own root and stops there — correctly, since it
       does not know what was on this rail before it. Without this the person
       would be left looking at the empty page the panel had been sitting in,
       which reads as the rail having broken at the exact moment their agent
       started. */
    if (closePanel) closeComposePanel(panelForStart)
    return { ...result, ok: true }
  }

  /* The note the tree keeps beside a node is bounded by the store, and a refusal
     sentence can be longer than that bound. Trimmed at a sentence end where
     there is one, so the note is a whole thought rather than a cut-off clause;
     the sentence in full is in the panel, which is where the person is reading.
     A note the store would refuse is worse than a shortened one: the refusal
     would leave the node with no explanation at all. */
  /* T395. THE QUEUE GAVE UP, AND THE CIRCLE SAYS SO. The draft stays set --
     nothing started, so nothing is "failed" -- but its note now carries the
     abandoned outcome, which is what the rail and the chat composer read for
     a node with no session (CHAT_NOT_RUNNING.refused). Before this, a node
     the queue had stopped retrying looked exactly like one nobody had ever
     tried to start. */
  function markLaunchAbandoned(result, { status = true } = {}) {
    const store = treeStore
    if (!store || !result?.nodeId) return
    const node = store.getNode(result.nodeId)
    if (!node || node.status !== 'draft' || node.sessionId) return
    store.setNodeStatus(result.nodeId, 'draft', { note: statusNote(result.message) })
    if (destroyed) return
    refreshTree()
    if (status) setOrgStatus(result.message, 'refuse', { sticky: true, code: result.code })
  }
  function statusNote(sentence) {
    const max = FLEET_TREE_LIMITS.maxNoteChars
    const text = String(sentence || '').trim()
    if (text.length <= max) return text
    const cut = text.slice(0, max)
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    return lastStop > 40 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, max - 1).trimEnd()}…`
  }

  async function changeDirectTreeLink(request) {
    if (mockSource()) return { ok: false, reason: 'Direct links can be created in your own trees. This page is showing example data.' }
    if (!treeStore?.getNode(request.from) || !treeStore?.getNode(request.to)) {
      return { ok: false, reason: 'Choose two saved agents on this computer.' }
    }
    const bridge = window.mcAgent
    if (typeof bridge?.setTreeLink !== 'function') return { ok: false, reason: 'This app needs an engine with direct tree links.' }
    return bridge.setTreeLink(request)
  }

  /* A DIRECT LINK BELONGS TO A TREE'S HEAD, SO IT GOES WHEN THE HEAD DOES
     (T1420, T1424). Removing a linked head, or moving it under another tree,
     left its link in the engine: the canvas draws only head-to-head links, so
     the leftover could never be seen or removed. Watched at the store like
     syncRenamedCircles: when a node that was a head on this computer is gone
     or is no longer a head, every link naming it is disconnected. Only this
     store's own former heads are touched, so links of trees on another
     computer are never pruned from here. */
  let treeHeadIds = new Set()
  const treeHeadIdsOf = snapshot => new Set((snapshot?.nodes || []).filter(node => node && node.parentId == null).map(node => node.id))
  function dropLinksOfFormerHeads(snapshot) {
    const heads = treeHeadIdsOf(snapshot)
    const former = [...treeHeadIds].filter(id => !heads.has(id))
    treeHeadIds = heads
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!former.length || mockSource() || typeof bridge?.treeLinks !== 'function' || typeof bridge?.setTreeLink !== 'function') return
    const targetGraph = graph
    void (async () => {
      let links = []
      try {
        const result = await bridge.treeLinks()
        links = result?.ok && Array.isArray(result.links) ? result.links : []
      } catch { return }
      const stale = links.filter(link => former.includes(link?.from) || former.includes(link?.to))
      let removed = 0
      for (const link of stale) {
        try {
          const result = await bridge.setTreeLink({ from: link.from, to: link.to, connected: false })
          if (result?.ok) removed += 1
        } catch { /* reported below by what is still drawn */ }
      }
      if (!removed || destroyed) return
      if (targetGraph) await readDirectTreeLinks(targetGraph)
      const words = removed === 1 ? 'Its direct tree link was removed too.' : `Its ${removed} direct tree links were removed too.`
      const prior = orgStatusPrimary
      if (!prior?.text) setOrgStatus(words, 'ok')
      else if (prior.state === 'ok') setOrgStatus(`${prior.text} ${words}`, 'ok')
    })()
  }

  async function readDirectTreeLinks(targetGraph) {
    if (mockSource() || typeof window.mcAgent?.treeLinks !== 'function') return
    try {
      const result = await window.mcAgent.treeLinks()
      if (!destroyed && graph === targetGraph && result?.ok) targetGraph.setCommunicationLinks(result.links)
    } catch { /* Link creation reports the engine's concrete refusal on press. */ }
  }

  async function placeStandaloneAgent({ record, parentId, computerId }) {
    if (destroyed || mockSource() || !treeStore || computer?.id !== computerId) {
      return { ok: false, sentence: 'Open your live computer to add this agent to a tree.' }
    }
    if (!record?.standalone || record.treeNodeId || !record.session?.beginPlacement) {
      return { ok: false, sentence: 'Choose an agent tab that is still outside the tree.' }
    }
    const store = treeStore, transcripts = transcriptStore, targetGraph = graph
    const releaseStore = retainStartingTreeStore(store)
    const addressFor = node => ({ ...nodeTreeIdentity(node, store),
      treeKey: treeAnchorsFor(node, store)[0], requestKeys: nodeRequestKeys(node, store) })
    const repaint = () => { if (!destroyed && treeStore === store) refreshTree() }
    try {
      return await adoptStandaloneIntoTree({
        store, session: record.session, parentId, bridge: window.mcAgent, identityFor: addressFor,
        async withReservation(node, work) {
          startingNodeIds.add(node.id)
          try {
            const result = await RUN_NODE_REPLACEMENTS.run(node.id, work)
            return result.ran ? result.value : { ok: false, sentence: 'This agent is already changing. Try again when it has finished.' }
          } finally { startingNodeIds.delete(node.id); repaint() }
        },
        bindSession(node, host, initial) {
          let currentSession = null
          const bind = (snapshot, result = null) => {
            const id = snapshot.sessionId
            if (!id) return
            currentSession = id
            sessionNodeIds.set(id, node.id)
            store.attachSession(node.id, id)
            if (result?.threadId || snapshot.threadId) sessionThreadIds.set(id, result?.threadId || snapshot.threadId)
            sessionAccountNames.set(id, result?.account ?? snapshot.account ?? null)
            if (result?.effort) sessionEfforts.set(id, result.effort)
            const state = snapshot.phase === 'working' ? 'running'
              : nodeStatusForTurn(snapshot.lastTurnStatus, { userStopped: snapshot.lastTurnStatus === 'interrupted' })
            store.setNodeStatus(node.id, state, { note: snapshot.phase !== 'working' && sessionTurnCancelled(snapshot.lastTurnStatus) ? TURN_CANCELLED.note : '' })
            // Finish importing adoption history before rebinding a rail that
            // was opened while this node still had no session.
            queueMicrotask(() => {
              if (!destroyed && graph === targetGraph && treeStore === store && store.getNode(node.id)?.sessionId === id) {
                rebindRailToSession(node.id)
              }
            })
          }
          if (initial.sessionId) bind(initial, host)
          const historySession = initial.sessionId || host?.sessionId
          if (historySession) {
            sessionTranscripts.set(historySession, (initial.transcript || []).map(line => ({ ...line })))
            if (initial.currentText) sessionTurnText.set(initial.sessionId, initial.currentText)
            if (initial.turnId) sessionOpenTurns.set(initial.sessionId, initial.turnId)
            if (initial.prompt) store.markPromptedByPerson(node.id)
            const lastReply = (initial.transcript || []).findLast(line => line.who === 'agent')?.text
            if (lastReply) { store.setNodeReply(node.id, lastReply); nodeReplies.set(node.id, lastReply) }
            if (initial.sessionId) persistTranscript(initial.sessionId, { transcripts, trees: store })
            else transcripts?.save(node.id, { lines: sessionTranscripts.get(historySession), threadId: host?.threadId || initial.threadId || null, account: host?.account ?? initial.account ?? null, keepUnknown: true })
            void syncTreeBranchAddresses(node.id, store)
          }
          if (!initial.sessionId && host) {
            // A provider exit during the IPC round trip is history, not a
            // reason to label an acknowledged but ended session as running.
            store.setNodeStatus(node.id, 'interrupted', { note: 'This session ended while the agent was joining the tree.' })
          }
          repaint()
          return {
            getStartOptions: () => {
              const fresh = store.getNode(node.id)
              if (!fresh) throw new Error('The agent is no longer on this tree.')
              if (fresh.sessionId && sessionNodeIds.has(fresh.sessionId)) throw new Error('Open the current tree conversation to use this running agent.')
              return { surface: 'fleet-tree', treeIdentity: nodeTreeIdentity(fresh, store), requestKeys: nodeRequestKeys(fresh, store) }
            },
            onSessionChange(snapshot, event = {}) {
              if (event.kind === 'open') bind(snapshot)
              if (event.kind === 'send' && snapshot.sessionId) {
                const previous = standaloneSettledTurns.get(snapshot.sessionId)
                if (previous && !previous.turnId) { sessionTurnText.delete(snapshot.sessionId); standaloneSettledTurns.delete(snapshot.sessionId) }
                bind(snapshot)
                store.setNodeStatus(node.id, 'running', { note: '' })
                store.markPromptedByPerson(node.id)
                if (event.text) transcriptAppend(snapshot.sessionId, { who: 'you', text: event.text, at: event.at || Date.now() }, { persist: false })
                persistTranscript(snapshot.sessionId, { transcripts, trees: store })
              }
              if (event.kind === 'state' && snapshot.phase === 'open' && snapshot.sessionId === currentSession) {
                const fresh = store.getNode(node.id)
                if (fresh && ['starting', 'running'].includes(fresh.status)) {
                  const id = snapshot.sessionId
                  const spoken = (sessionTurnText.get(id) || '').trim()
                  recordTurnActions(id)
                  if (spoken) {
                    const row = { who: 'agent', text: spoken, at: Date.now(), turnStamp: sessionOpenTurns.get(id) || null }
                    transcriptAppend(id, row, { persist: false })
                    standaloneSettledTurns.set(id, { turnId: row.turnStamp, id: row.id })
                    store.setNodeReply(node.id, spoken)
                    nodeReplies.set(node.id, spoken)
                    persistTranscript(id, { transcripts, trees: store })
                  }
                  deliverTurnReply(id, spoken || null)
                  const outcome = nodeStatusForTurn(snapshot.lastTurnStatus, { userStopped: snapshot.lastTurnStatus === 'interrupted' })
                  store.setNodeStatus(node.id, outcome, { note: sessionTurnCancelled(snapshot.lastTurnStatus) ? TURN_CANCELLED.note : '' })
                }
              }
              if (event.kind === 'closed' && currentSession && (!event.sessionId || event.sessionId === currentSession)) {
                if (sessionNodeIds.get(currentSession) === node.id) sessionNodeIds.delete(currentSession)
                const fresh = store.getNode(node.id)
                if (fresh?.sessionId === currentSession) store.setNodeStatus(node.id, 'interrupted', { note: '' })
                currentSession = null
              }
              repaint()
            },
          }
        },
        reveal(node) {
          if (destroyed || graph !== targetGraph || treeStore !== store) return
          refreshTree()
          const frame = targetGraph.treeWindows?.windows[0]
          const root = treeAnchorsFor(store.getNode(node.id), store)[0]
          if (frame && root && !frame.graph.windowRootIds.includes(root)) {
            targetGraph.treeWindows.choose(frame, [...frame.graph.windowRootIds, root])
          }
          targetGraph.workspace?.showTrees({ focus: false })
        },
      })
    } finally { releaseStore() }
  }

  function mountGraph() {
    clearMountedGraph()
    clearEmptyPanel()
    closeComposePanel()
    if (!computer) {
      releaseTreeStore()
      return
    }
    syncTreeStore()
    graphTitle.textContent = computer.name
    if (pageHeading) pageHeading.textContent = `Computers: ${computer.name}`
    if (chatOnly) {
      // Full Home chat uses this same session owner and rail. No second
      // canvas or independent send/queue/approval implementation is mounted.
      treeStoreUnsub?.()
      treeStoreUnsub = treeStore?.subscribe(() => { if (!destroyed) refreshTree() }) || null
      // Home chat owns the same saved remote sessions as the canvas view.
      void reconnectSavedSessions()
      if (!mockSource()) {
        void readStartableTiers()
        void readProviderSignIn()
        void readComposeFolders()
        void readComposeDefaultFolder()
        void readComposeConfinement()
      }
      return
    }
    syncExampleBadge()
    canvas = el('<div class="computer-tree-canvas"></div>')
    /* First child of the canvas slot, under the absolute overlays (crumb,
       hint, status) that follow it in the DOM — the same stacking the old
       insertBefore(title) arrangement produced. The slot, not the wrap: the
       bar above is normal flow, and the graph's zoom host (the canvas's
       parent) must be the area the tree actually owns. */
    graphWrap.querySelector('.graph-canvas-slot').prepend(canvas)
    const draftComputerId = treeStoreId || computer.id
    graph = new StaticTreeGraph(canvas, {
      nodeStyle: readTreeStyle(),
      circleCards: readTreeCards(),
      cardSize: readTreeContextSize(),
      standaloneAgent: { live: !mockSource(), bridge: window.mcAgent,
        computerId: draftComputerId,
        persistenceKey: JSON.stringify([currentDataSource(), draftComputerId]),
        /* THE DURABLE RECORD, HANDED DOWN RATHER THAN REBUILT. The same client
           this view already uses for tree nodes, so a + agent's conversation is
           written by the one store and read back by the one reader. Read
           lazily: the client is created after the graph is mounted, and a
           window with no transcript bridge legitimately has none -- the seat
           then keeps exactly the behaviour it had, window memory only. */
        transcript: {
          bind: (sessionId, seatId) => transcriptStore?.bind?.(sessionId, seatId),
          release: sessionId => transcriptStore?.release?.(sessionId),
        },
        /* THE SOLO AGENT GETS A REAL SEAT AND THIS PAGE'S OWN CHAT.

           T286/T88, the owner: "its the same agent system" and "THE CHAT
           SURFACE FUCKING REUSE IT". A standalone agent used to be absent
           from the declared-agent registry by design, which is why the App
           permissions roster showed it as a raw session id with "The agent
           role is unavailable" and computer control could never be granted:
           screen-control-host.cjs refuses SCREEN_ROLE_UNAVAILABLE when
           readBinding(agentId) finds no enabled role in the org record.

           ensureSeatForNode() is the same call a tree node makes, and it
           needs only id, parentId, role and tier. The seat is declared with
           the shipped identity role -- identityRoleForTreeNode('') is
           'worker', the non-single-seat role for a general task -- and the
           tier the pop-up chose. It is NOT added to the tree store, so the
           pop-up's promise that this agent will not appear on the tree stays
           true; adoption later transfers this same seat, as that design
           intended. */
        /* THE SAME ROWS THE TREE START PANEL SHOWS (T1370): startable here AND
           installed, each unusable row saying why. The New agent chooser asks
           for them when it opens and again once the shell has answered. */
        tierChoices: () => (startableTierAnswered && !mockSource() ? startableTierChoices : null),
        refreshTierChoices: async () => {
          if (mockSource()) return null
          await Promise.all([readStartableTiers(), readProviderSignIn()])
          return startableTierAnswered ? startableTierChoices : null
        },
        async declareSeat({ id, name, tier }) {
          const role = identityRoleForTreeNode('')
          const seat = { id, name, role, tier, parentId: null, sessionId: null, message: '', reply: '', statusNote: '' }
          const result = await ensureSeatForNode(seat, role, { tierId: tier })
          return result?.ok === false ? result : seat
        },
        /* AND ITS RELEASE (T1365). A tab closed before it was ever sent or
           placed leaves no conversation and no tree node behind, so the seat
           it declared goes with it; otherwise every opened-and-closed tab
           left an enabled "Agent 1" worker seat counting toward the
           organisation's bound. A sent or placed agent keeps its seat. */
        releaseSeat: ({ id }) => releaseSeatForNode(id),
        /* THE SEAT'S IDENTITY, MINTED AT THE SEND. Declaring the seat above is
           what puts this agent in the org record; this is what tells the host
           which agent the session belongs to, and it is the same call and the
           same arguments a tree node's start makes. `seat.role` is passed as
           the selected role because that is exactly what ensureSeatForNode
           read from the same object -- roleBindingForStart refuses when the
           blankness of the two disagrees, so deriving both from one field is
           what keeps them in step.

           A function, not a value: the binding pins the org and role revisions
           and the host checks them at the start, so a solo tab left open while
           somebody edits a role must re-mint rather than send a stale one. */
        roleBindingFor: seat => roleBindingForStart(seat.id, seat.role, seat.role),
        /* The tree conversation's own builder, handed down as a closure. No
           extraction of this view, and no second implementation to drift:
           treeChatConfigFor() reads only id, message, reply, role, sessionId
           and statusNote, and every one of its treeStore.getNode() calls is
           written `|| node`, so it serves a seat the store has never seen. */
        chatConfigFor: seat => treeChatConfigFor(seat) },
      onPlaceStandalone: placeStandaloneAgent,
      onMountChatDraft: (nodeId, chat) => treeChatDrafts.mount(draftComputerId, nodeId, chat, { scope: 'tree' }),
      onMountChatControls: (nodeId, chat) => {
        const node = treeStore?.getNode(nodeId)
        if (!node) return
        // Full conversation mode hides the rail. Mount the same queue controls
        // in this chat so Pause/Cancel remain beside the waiting conversation.
        const slot = el(`<div data-tree-start-controls="${escapeMarkup(node.treeId || '')}" data-tree-queue-only></div>`)
        chat.prepend(slot)
        refreshTreeStartControls(slot)
      },
      tabbedWorkspace: true,
      onLinkChange: changeDirectTreeLink,
      // Select the toolbar target immediately while chat waits for the gesture.
      onSelect: setOpenTarget,
      computer: graphComputer(),
      screenChips: true,
      contextFeed: treeContextFeed,
      onContact: async agent => {
        contactOpener = document.activeElement
        await agentScreenVoice.selectAgent(agent)
        if (!destroyed && agentScreenVoice.el.open) agentScreenVoice.el.querySelector('summary')?.focus({ preventScroll: true })
      },
      /* Every source's projection carries its own edge list — the example
         fleet's included — so the graph always draws the record's edges. */
      edges: computer.graphEdges,
      /* A reparent is an org WRITE, so the callback exists only where a real
         source has a ready org store behind it. Everywhere else it is null,
         and tree-graph.js refuses a drop with no onReparent — the drag never
         silently pretends. (Edit mode is separately disabled with the reason
         by syncEditAvailability, so this null is the second lock.) */
      onReparent: !mockSource() && !authoritativeTreeSnapshot && orgReady() ? handleReparent : null,
      /* Tree roles are free text and never imply structure. Fleet nodes carry
         orgRoot from the authoritative Role library projection; the graph does
         not infer it from a special name. The store makes the final decision. */
      canDrag: agent => !authoritativeTreeSnapshot && (Boolean(agent.treeNode) || agent.orgRoot !== true),
      canReparent: (nodeId, parentId) => {
        const sourceNode = treeStore?.getNode(nodeId)
        const targetNode = treeStore?.getNode(parentId)
        if (!sourceNode && !targetNode) return true
        return !!sourceNode && !!targetNode && treeStore.movePoints(nodeId).some(point => point.parentId === parentId)
      },
      /* Refusals speak in the page's own status line, in the copy module's
         sentences. */
      onDropRefused: (rule, detail) => {
        /* THE THIRD DOOR SPEAKS THE SAME SENTENCE. 'noApplier' is the graph
           saying there is no callback to apply this drop at all — which on
           the example board is deliberate (mountGraph nulls onReparent under
           mock) and was, until this line, the one refusal with no words: the
           bubble wiggled and nothing was said. It answers with exactly what
           the Edit button and the Reports-to Save answer with, so the board's
           three rearranging doors cannot state three different policies. */
        if (rule === 'noApplier') {
          setOrgStatus(
            mockSource()
              ? EXAMPLE_REARRANGE_TEXT
              : failureSentence(orgAvailability, 'The declared organisation could not be read.'),
            'refuse',
          )
          return
        }
        if (rule === 'unavailableParent') {
          setOrgStatus(`${detail.target} is not an available parent for ${detail.name}. Pick another parent.`, 'refuse')
          return
        }
        const sentence = typeof MOVE_PANEL[rule] === 'function'
          ? MOVE_PANEL[rule](detail.name, detail.parent ?? detail.target)
          : null
        if (sentence) setOrgStatus(sentence, 'warn')
      },
      /* The new-tree slot's drop: this branch becomes its own tree. Tree
         nodes only — the declared fleet has exactly one organisation, and
         detaching a fleet agent into "another organisation" is not a thing
         this product does. */
      onDetachToNewTree: (agentId) => {
        if (!treeStore?.getNode(agentId)) {
          setOrgStatus(MOVE_PANEL.mixed, 'refuse', { sticky: true })
          return false
        }
        const out = treeStore.detachToNewTree(agentId)
        if (!out.ok) {
          setOrgStatus(out.problems[0] || MOVE_PANEL.notSaved, 'refuse', { sticky: true })
          return false
        }
        /* `unchanged` means the store understood the gesture and had nothing
           to do -- the node was already the sole root of its own tree. Saying
           "is now its own tree" there told a person a move had happened. */
        setOrgStatus(
          out.unchanged ? SECOND_TREE.alreadyOwnTree(treeNodeName(out.node)) : SECOND_TREE.detached(treeNodeName(out.node)),
          'ok',
        )
        void syncTreeBranchAddresses(agentId)
        return true
      },
      /* The compact card: real config or nothing. A node without a session has
         nothing to talk to, so its chip keeps routing to the rail. ONE config
         builder serves both this card and the rail's Chat tab — two copies of
         the attach/mention/send wiring is how the two surfaces drift. */
      treeChat: agent => authoritativeTreeSnapshot ? null : treeChatConfigFor(agent.treeNode),
      /* Saved tree nodes have their own controls. Both kinds of agent become
         the target for Full chat view when selected. */
      onOpenControls: (agent) => {
        if (authoritativeTreeSnapshot) {
          setOpenTarget(agent)
          showTreeNodeControls(agent.treeNode)
          return
        }
        if (agent?.treeNode) {
          setOpenTarget(agent)
          showTreeNodeControls(agent.treeNode)
          return
        }
        setOpenTarget(agent)
        /* ONE RAIL FOR A RECORD AGENT, WHATEVER THE SOURCE. A look-alike built
           from the tree rail's primitives lived here for one commit and was the
           wrong answer twice over: it maintained a second rail, and it still
           could not carry the actions palette or the pickers, because those come
           from treeChatConfigFor and a record agent has no tree node to
           configure from. The example's own agents ARE tree nodes now (see
           syncTreeStore), so they take the branch above and get his real rail;
           what reaches here is a seat from the fleet record, which is what the
           projection rail was written to describe. */
        showProjectionControls(agent)
      },
      onRootChange: (next, trail) => { renderCrumb(next, trail); refreshTreeSwitch(); railFollowsCanvas(next); paintFleetOverview() },
      onOverridesChange: syncResetButton,
      /* THE OFFER IS DRAWN ON EVERY SOURCE. The dashed start slot is part of
         the product — the example page IS the product page — and a press of
         one under mock answers with the example sentence through
         composeUnavailableReason, the same way every disabled start surface
         answers. The old rule hid the slots from the example render entirely;
         hiding a control silently is the thing this codebase does not do. */
      emptySlots: true,
      /* Capture the store's complete offer set once per graph reconcile.
         Token-only preview refreshes reuse it; structural refresh/settings
         reload captures fresh bounds. No render snapshot authorizes a write:
         compose/add/move still pass through the store's current admission. */
      extensionPoints: () => treeStore ? treeStore.extensionPoints() : null,
      /* THE PRESS. src/tree-graph.js starts nothing and decides nothing; it
         reports which circle was pressed and hands over. Everything that happens
         next is above. */
      onEmptyPress: openComposeFor,
    })
    if (graph.workspace) {
      const primary = graph
      primary.treeWindows = new TreeWindows(primary, {
        getTrees: () => {
          const saved = new Map((treeStore ? treeStore.listTrees() : []).map(tree => {
            const rootNode = treeStore.rootOf(tree.id)
            return [rootNode?.id, { rootId: rootNode?.id, name: treeStore.treeLabel(tree.id), rootName: rootNode ? treeNodeName(rootNode) : '',
              description: rootNode?.message || '', count: treeStore.listNodes(tree.id).length }]
          }))
          // A real computer always has a local tree store, even when its
          // running agents arrived through the desktop-session relay. Choose
          // from the graph's merged roots; an empty store must not hide those
          // observed conversations from every canvas.
          return primary.computer.agents.filter(agent => !agent.parentId).map(agent => saved.get(agent.id)
            || { rootId: agent.id, name: agent.name, rootName: agent.name,
              description: agent.treeNode?.message || '', count: primary._scopeModel().summary(agent.id).total })
        },
      })
      primary.setWide(true)
      void agentScreenVoice.refresh()
    }
    graph.updateDensity()
    void readDirectTreeLinks(graph)
    /* Asked as the board comes up, so the answer is usually in hand before the
       first empty node is pressed. REAL SOURCES ONLY: every one of these is a
       bridge read about THIS computer — its engines, its sign-ins, its
       folders, its permission level — and a mock-sourced page issues no
       bridge call. On the desktop with the example toggle on those bridges
       exist and would answer, and their answers would put this machine's
       facts inside a screen badged as an example; the compose panel under
       mock is disabled with the example sentence, so it needs none of them. */
    if (!mockSource()) {
      void readStartableTiers()
      void readProviderSignIn()
      void readComposeFolders()
      void readComposeDefaultFolder()
      void readComposeConfinement()
    }
    /* THE PANEL THE PERSON WAS IN, REOPENED AFTER THE SWITCH THEY PRESSED IN IT
       tore this view down. Read once and cleared, so an ordinary visit never
       inherits it. See composeToRestore for the measurement. */
    if (composeToRestore) {
      const resume = composeToRestore
      composeToRestore = null
      queueMicrotask(() => { if (!destroyed) openComposeFor(resume) })
    }
    window.__mcGraph = graph
    renderCrumb(null)
    syncEditButton()
    syncEditAvailability()
    /* One subscription per mount, and the previous one goes first: openTreeStore
       hands back the SAME store when the computer has not changed, so a mount
       that only re-subscribed would leave one listener per remount attached to a
       store that outlives them all. */
    treeStoreUnsub?.()
    treeStoreUnsub = treeStore ? treeStore.subscribe(() => { if (!destroyed) refreshTree() }) : null
    void reconnectSavedSessions()
    /* The ledger's first rows for THIS computer; store changes flow through
       refreshTree above. Null everywhere the mode is off. */
    phoneLedger?.refresh()
    /* A split-pane preference saved before 2026-08-16 is simply not
       read any more: the split pane is gone (owner: "lets throw it away for
       now"), and a key nobody reads is a key that cannot bring it back. */
    /* Aim the button before anything is clicked, so it is a way IN rather than a
       reward for having already found the way in. */
    setOpenTarget(computer.agents?.[0] || firstDeclaredTarget())
    /* The switcher builds AT MOUNT, not on the first store write. Every other
       caller of refreshTreeSwitch is a change handler (store events, root
       drills, compose flows), so a quietly-loaded page with five saved trees
       showed an empty trees slot until something changed — found driving the
       installed iteration-6 build, where the bar stood bare over a forest. */
    refreshTreeSwitch()
  }

  /**
   * REDRAW THE PAGE FROM WHAT IS ACTUALLY SAVED.
   *
   * Used after every organisation write, successful or refused. It re-derives
   * the projection from the cached fleet payload and the current saved org, so
   * a refused move goes back where it came from and an accepted one is drawn
   * the same way a fresh launch would draw it. Rebuilding rather than patching
   * is the point: a patch is a second renderer, and the second one is the one
   * that ends up showing something the store does not hold.
   *
   * The drill-in root, the edit mode and the selected node are carried across,
   * because none of those are facts about the organisation and losing them
   * would make a correct save feel like a page reset.
   */
  function reprojectFromOrg({ keepAgentId = null } = {}) {
    if (authoritativeTreeSnapshot) return
    /* Real sources only: this re-derives from the saved ORGANISATION, and the
       example fleet has no org behind it — under mock lastFleetData is the
       sample record and must never be re-projected through a real store. */
    if (!lastFleetData || mockSource()) return
    const rootId = graph?.rootId || null
    /* The branch as it stood BEFORE the reprojection, so the restore below can
       tell "this branch was emptied by the save" from "this branch was always
       a leaf". Copied, because mountProjection replaces `computer`. */
    const agentsBefore = [...(computer?.agents || [])]
    const editing = !!graph?.editMode
    const editingRootIds = graph?._editRootIds ? [...graph._editRootIds] : null
    const computerId = computer?.id || null
    /* If the rail was showing an agent, it goes back to showing that agent. A
       refused drag already surprises the person by moving a node back; sending
       the rail to the fleet summary at the same moment would make a refusal
       look like a navigation. */
    const selected = keepAgentId
      || (controlsPage.classList.contains('is-active') ? graph?.selectedId : null)
      || null
    /* A DECLARED GRAPH IS RE-DERIVED FROM THE ORGANISATION, NOT FROM THE COPY
       THAT WAS DRAWN. `lastFleetData` is a projection of the record as it stood
       when the page loaded; re-projecting it after a save would redraw the old
       node set with the new relationships laid over it, which is a second
       renderer of the same fact and the one that drifts. */
    const source = declaredOnlyReason && orgReady()
      ? (declaredFleetData(orgAvailability.org, desktopStartedSessions(readLiveSession(), desktopList)) || lastFleetData)
      : lastFleetData
    mountProjection(source, { preferComputerId: computerId })
    const restoredRoot = drillRootAfterReprojection(rootId, agentsBefore, computer?.agents || [])
    if (restoredRoot && graph?.nodes.has(restoredRoot)) graph.setRoot(restoredRoot)
    if (editing && editButton.getAttribute('aria-disabled') !== 'true') {
      graph?.setEditMode(true, { rootIds: editingRootIds })
      syncEditButton()
    }
    const agent = selected ? computer?.agents?.find(entry => entry.id === selected) : null
    if (!agent) return
    setOpenTarget(agent)
    graph?.select(agent.id)
    showProjectionControls(agent)
  }

  /* One stats rail for every source. The simulated body that stood here —
     stat-hero over sim.spawnedTotal, the CPU/GPU/Network/Disk load bars, the
     rotating task chips — was the second render's own furniture, all of it
     fed by generated numbers no record ever held. The live rail below reads
     only the projection, which under mock is the example record, so the same
     rail is honest on all three sources. */
  function renderStats() {
    if (!computer) return
    renderLiveStats()
  }

  // Refresh only the overview's observed tree state. Folder inputs, role
  // editors and disclosure choices survive session events and tree changes.
  function paintFleetOverview() {
    const summary = statsPage.querySelector('[data-fleet-summary]')
    if (!summary) return
    const snapshot = fleetOverviewSnapshot(treeStore, ownedSessions(), { example: mockSource(), evidence: sessionEvidence(), startingNodeIds })
    const counts = snapshot ? { ...snapshot, treeCount: snapshot.trees.length } : null
    for (const element of summary.querySelectorAll('[data-fleet-count]')) {
      const key = element.dataset.fleetCount
      element.textContent = counts ? String(key === 'trees' ? counts.treeCount : counts[key]) : '—'
    }
    summary.querySelector('[data-fleet-working]').dataset.active = String(Boolean(snapshot?.working))
    summary.querySelector('[data-fleet-review]').dataset.review = String(Boolean(snapshot?.review))
    const note = summary.querySelector('[data-fleet-state-note]')
    note.textContent = !snapshot ? 'Saved trees are unavailable. Their agent counts could not be read.'
      : !snapshot.agents ? 'Start a tree from an empty spot on the canvas, then choose a role and folder.'
      : [snapshot.draft ? `${snapshot.draft} not started` : '',
          snapshot.finished ? `${snapshot.finished} ${snapshot.finished === 1 ? 'turn' : 'turns'} finished` : '',
          snapshot.unconfirmed ? `${snapshot.unconfirmed} with unconfirmed status` : '',
          snapshot.review ? 'Open a tree below to review failed or interrupted agents.' : '',
        ].filter(Boolean).join(' · ') || 'Working agents are responding or starting a turn.'
    const currentTreeId = graph?.rootId ? graph.ancestryOf(graph.rootId)
      .map(item => treeStore?.getNode(item.id)?.treeId).find(Boolean) ?? null : null
    const all = statsPage.querySelector('[data-fleet-show-all]')
    if (all) all.setAttribute('aria-pressed', String(!graph?.rootId))
    const list = statsPage.querySelector('[data-fleet-tree-list]')
    if (!list) return
    const markup = !snapshot ? '<li class="rail-prose is-dim">Reopen Computers to read the saved tree list again.</li>'
      : !snapshot.trees.length ? '<li class="rail-prose is-dim">Your trees will appear here as you create them.</li>'
      : snapshot.trees.map(tree => `<li><button class="fleet-overview-tree" type="button" data-fleet-open-tree="${escapeMarkup(tree.id)}" aria-current="${tree.id === currentTreeId}"${tree.rootId ? '' : ' disabled'}>
          <span class="fleet-overview-tree-name">${escapeMarkup(tree.name)}</span>
          <span class="fleet-overview-tree-size">${tree.agents} ${tree.agents === 1 ? 'agent' : 'agents'}</span>
          <span class="fleet-overview-tree-states">${OVERVIEW_STATES.filter(state => tree[state.key]).map(state => `<span class="fleet-overview-state" data-state="${state.key}">${tree[state.key]} ${state.key === 'review' && tree.review === 1 ? 'needs review' : state.key === 'finished' && tree.finished > 1 ? 'turns finished' : state.label}</span>`).join('') || 'No agents yet'}</span>
        </button><div data-tree-start-controls="${escapeMarkup(tree.id)}"></div></li>`).join('')
    if (list._fleetMarkup !== markup) {
      const focusedTree = list.contains(document.activeElement) ? document.activeElement?.dataset.fleetOpenTree : null
      list.innerHTML = markup
      list._fleetMarkup = markup
      if (focusedTree) [...list.querySelectorAll('[data-fleet-open-tree]')].find(button => button.dataset.fleetOpenTree === focusedTree)?.focus({ preventScroll: true })
    }
    refreshTreeStartControls()
  }

  function renderLiveStats() {
    captureRoleLibrary()
    const services = computer.services || []
    const sourceSentence = RECORD_SOURCE[computer.note]?.() || drivenComputerCopy(
      'This computer did not say where its record came from.',
      'The computer you are driving did not say where its record came from.',
    )
    statsPage.innerHTML = `
      ${railTitleRow({ title: 'Fleet overview' })}
      <div class="rail-scroll fleet-overview" data-live-mode="${mockSource() ? 'simulated' : 'live'}" data-projection-state="available">
        <section data-fleet-summary aria-label="Tree activity on this computer">
          <div class="fleet-overview-context"><strong>${escapeMarkup(computer.name || thisComputerHeading())}</strong><span>${mockSource() ? 'Example trees' : 'All trees on this computer'}</span></div>
          <dl class="fleet-overview-metrics">
            <div class="fleet-overview-metric"><dt>Trees</dt><dd data-fleet-count="trees">—</dd></div>
            <div class="fleet-overview-metric"><dt>Agents in trees</dt><dd data-fleet-count="agents">—</dd></div>
            <div class="fleet-overview-metric" data-fleet-working><dt>Working</dt><dd data-fleet-count="working">—</dd></div>
            <div class="fleet-overview-metric" data-fleet-review><dt>Needs review</dt><dd data-fleet-count="review">—</dd></div>
          </dl>
          <p class="rail-prose is-dim" data-fleet-state-note></p>
          ${mockSource() ? '<p class="rail-prose is-dim">Example data. Your computer’s activity is not shown.</p>' : ''}
          ${declaredOnlyReason ? `<div class="rail-note projection-unavailable" data-projection-state="declared">
            <b class="rail-note-h">${escapeMarkup(FLEET_DECLARED_NOTE.title)}</b>
            <span class="rail-note-b">${escapeMarkup(declaredOnlyReason)} ${escapeMarkup(FLEET_DECLARED_NOTE.body)}</span>
            <a class="rail-note-a host-absent-action" href="${escapeMarkup(GUIDE_ACTION.href)}">${escapeMarkup(GUIDE_ACTION.label)}</a>
          </div>` : ''}
        </section>
        ${desktopBridge() ? '<section class="fleet-overview-section" data-desktop-sessions hidden></section>' : ''}
        <section class="fleet-overview-section" aria-label="Agent folders">
          <div class="rail-sec">${escapeMarkup(PROFILE_PANEL.overviewTitle)}</div>
          <div class="board-profile-slot" data-profile-slot></div>
        </section>
        <section class="fleet-overview-section" aria-label="Trees on this computer">
          <div class="fleet-overview-heading"><div class="rail-sec">Your trees</div><button class="ctl-btn" type="button" data-fleet-show-all aria-pressed="true">Every tree</button></div>
          <ul class="fleet-overview-trees" data-fleet-tree-list></ul>
        </section>
        <details class="fleet-overview-details" data-fleet-details="research">
          <summary>Research filing</summary>
          <div class="fleet-overview-detail-body">
            <p class="rail-prose is-dim">Choose a project for the selected tree’s sessions. With Every tree selected, filing applies to all sessions on ${currentDataSource() === 'relay' ? 'the computer you are driving' : 'this computer'}.</p>
            <div class="rail-research-slot" data-research-scope-slot><p class="rail-prose is-dim">${mockSource() ? 'Switch to your own fleet to file sessions under a research project.' : 'Reading your research projects.'}</p></div>
          </div>
        </details>
        <details class="fleet-overview-details" data-fleet-details="configuration">
          <summary>Organisation &amp; roles</summary>
          <div class="fleet-overview-detail-body">
            <div class="rail-sec">Organisation</div>
            ${mockSource() ? '<p class="rail-prose is-dim">The example uses its own roles. Your organisation and role library are not loaded.</p>' : orgSourceMarkup()}
            ${mockSource() ? '' : '<div class="rail-sec">Roles</div><div class="board-org-slot"></div>'}
          </div>
        </details>
        <details class="fleet-overview-details" data-fleet-details="record">
          <summary>Computer record &amp; services</summary>
          <div class="fleet-overview-detail-body">
            <div class="stat-hero"><span class="v" id="agent-count" data-record-state="reading">—</span><span class="l">Agents on record</span></div>
            <p class="rail-prose is-dim" data-agent-record-note>Reading the history of agent starts.</p>
            <div class="rail-sec">${escapeMarkup(thisComputerHeading())}</div>
            <dl class="rail-facts">
              <div class="rail-fact"><dt>Agents described</dt><dd>${computer.spawnedTotal}</dd></div>
              <div class="rail-fact"><dt>Recorded relationships</dt><dd>${computer.graphEdges.length}</dd></div>
              <div class="rail-fact"><dt>Graph revision</dt><dd>${computer.graphRevision ?? 'not recorded'}</dd></div>
            </dl>
            <p class="rail-prose is-dim">${escapeMarkup(sourceSentence)} These saved fleet details do not measure current activity or computer load.</p>
            <div class="rail-sec">Services</div>
            ${services.length ? `<ul class="fleet-overview-services">${services.map(service => `<li data-service-id="${escapeMarkup(service.id)}"><b>${escapeMarkup(service.name)}</b><span>${escapeMarkup([service.state, service.detail].filter(Boolean).join(' · ').replace(/\s--\s/g, ', '))}</span></li>`).join('')}</ul>` : '<p class="rail-prose is-dim">No services are listed in this computer’s record.</p>'}
          </div>
        </details>
        <details class="fleet-overview-details" data-fleet-details="account">
          <summary>Account connection</summary>
          <div class="fleet-overview-detail-body">${accountDoorMarkup()}</div>
        </details>
      </div>`
    mountOrgLibrary(statsPage.querySelector('.board-org-slot'))
    paintDesktopSessions()
    void mountProfilePanel(statsPage.querySelector('[data-profile-slot]'))
    mountResearchScopeControl()
    void paintAgentsOnRecord()
    paintFleetOverview()
    statsPage.querySelector('[data-fleet-tree-list]')?.addEventListener('click', event => {
      const button = event.target.closest('[data-fleet-open-tree]')
      const treeRoot = button && treeStore?.rootOf(button.dataset.fleetOpenTree)
      if (treeRoot) graph?.setRoot(treeRoot.id)
    })
    statsPage.querySelector('[data-fleet-show-all]')?.addEventListener('click', () => {
      if (graph?.treeWindows) graph.treeWindows.showPicker()
      else graph?.clearRoot()
    })
    if (graph?.treeWindows) statsPage.querySelector('[data-fleet-show-all]').textContent = 'Choose trees'
    // Existing organisation warnings remain discoverable on first view.
    if (statsPage.querySelector('[data-fleet-details="configuration"] .org-notice')) {
      statsPage.querySelector('[data-fleet-details="configuration"]').open = true
    }
  }

  /* THE DOOR THIS PAGE DID NOT HAVE, ON THE PAGE PEOPLE COME TO FIRST FOR THIS.
   *
   * "as a user I dont even see how after signing up that I now connect my
   * computer." Somebody looking for how to add a computer opens the page called
   * Computers. Measured on a cold install: the only add-shaped control anywhere
   * on it was "Empty spot. Press to start an agent here." Nothing named the
   * account, the website, or the connect screen -- which exists, works end to
   * end, and until this pass had no caller anywhere in src/.
   *
   * THE PREVIEW GETS A DIFFERENT SENTENCE AND NO LINK, because a browser has
   * no installed application to open a claim with and a button that cannot work
   * is the defect this whole pass is about. */
  /* "THIS COMPUTER" IS THE WRONG WORDS FOR THE ONE PERSON WHO MOST NEEDS THEM
     RIGHT. Driving from a browser, the computer these facts describe is
     somewhere else -- the account page is explicit that this "never talks to
     the computer you are sitting at" -- and calling it "this computer" invites
     exactly the mistake that sentence exists to prevent. */
  function thisComputerHeading() {
    return currentDataSource() === 'relay' ? 'The computer you are driving' : 'This computer'
  }

  function accountDoorMarkup() {
    if (previewWithoutHost()) {
      /* THE SAME LESSON AS exampleExitSentence() ABOVE, WHICH THIS BRANCH NEVER
       * LEARNED. "Putting a computer on your account is done from the installed
       * application" is the right sentence for somebody who reached this page
       * cold, and the wrong one for somebody who is SIGNED IN WITH COMPUTERS
       * ALREADY CONNECTED -- they are being told to go and do a thing they did
       * days ago, about a problem they do not have.
       *
       * MEASURED on the live site on 2026-08-23, at 390x844: an account with two
       * connected computers, opened on a phone the morning after. The tab
       * remembers the chosen computer in sessionStorage and a new browser has
       * none, so the page fell back to the example fleet -- correctly, and
       * badged -- and then this door told the person to install the
       * application. The host bridge knew better the whole time: it had already
       * published "This account has more than one computer connected and none of
       * them is chosen."
       *
       * So the bridge's own reason wins when it left one, exactly as it does for
       * the example-exit sentence twenty lines up, and the way back is a link to
       * the account page rather than an instruction to go and install
       * something. */
      const fallback = hostFallbackSentence()
      if (fallback) {
        return `<div class="rail-sec">Your ToolsEnabled account</div>
        <p class="rail-prose is-dim">${escapeMarkup(fallback)}</p>
        <a class="rail-note-a host-absent-action" href="${escapeMarkup(ACCOUNT_PAGE_HREF)}">Choose a computer on your account page</a>`
      }
      return `<div class="rail-sec">Your ToolsEnabled account</div>
        <p class="rail-prose is-dim">Putting a computer on your account is done from the installed application, on the computer you want to add. This page is a preview of it running in your browser.</p>`
    }
    /* AND THE THIRD READER IS THE ONE THIS WHOLE FEATURE IS FOR.
     *
     * Over the relay, everything on this screen was read FROM a computer on the
     * person's account -- that is the only way it could have got here. Offering
     * them "Connect this computer" is offering to do the thing they have
     * already done, and the sentence beneath it describes typing a code into a
     * browser while they are sitting in that browser reading it.
     *
     * Measured on the live site on 2026-08-22, the first time a browser
     * successfully drove a machine: this door was still speaking to somebody at
     * a desk. Same defect as telling a person with ToolsEnabled installed to
     * install ToolsEnabled -- text written for one reader, drawn for another. */
    if (currentDataSource() === 'relay') {
      return `<div class="rail-sec">Your ToolsEnabled account</div>
        <p class="rail-prose is-dim">This computer is already on your account — that is how this browser is reading it. Everything on this page came from it, not from the computer you are sitting at.</p>`
    }
    return `<div class="rail-sec">Your ToolsEnabled account</div>
      <p class="rail-prose is-dim">If you signed up at toolsenabled.ai, this is how this computer gets onto that account. The connect screen gives you a short code. You type it into your account page in a browser.</p>
      <a class="rail-note-a host-absent-action" href="${escapeMarkup(CONNECT_HREF)}">Connect this computer</a>`
  }

  /* "AGENTS ON RECORD" NOW COUNTS THE RECORD, WHICH IT DID NOT BEFORE.
   *
   * WHAT WAS MEASURED. Three nodes on the canvas, an agent that really ran, and
   * this hero reading 0. It was printing `computer.spawnedTotal`, which is
   * `agents.length` off the FLEET PROJECTION -- a build-time file that ships
   * `ok:false` and describes nothing on a customer machine, which is the whole
   * argument in the header of src/declared-fleet.js. So the number was not
   * wrong about the record; it was never about the record at all. On the
   * packaged build with two starts in the signed ledger it still said 0.
   *
   * WHERE THE TRUE NUMBER LIVES. The app writes every start into its own
   * hash-chained agent-spawn-records.jsonl before it starts anything
   * (shell/spawn-record.cjs, called by mc-agent:start), and reads it back
   * through mcAgent.history(). src/views/home.js already counts exactly this,
   * through readLocalSessions() -- the same function is used here rather than a
   * second reading of the same file, so the two screens cannot disagree about
   * how many agents this computer has run.
   *
   * AN UNREADABLE RECORD IS NOT ZERO, and that distinction is the reason this
   * is asynchronous rather than a swapped expression. Zero is a claim: it says
   * nothing has ever run here. A record that could not be opened is the absence
   * of a claim, and painting it as 0 would be the same lie this repair is for,
   * wearing the other sign. So the hero starts as an em dash, and every branch
   * below either produces a number it can defend or says in words why there is
   * none.
   *
   * THE PROJECTION'S OWN COUNT IS NOT DELETED. It moved to the line beneath,
   * under a label that says what it actually is -- what the fleet record
   * DESCRIBES, rather than what has run. */
  async function paintAgentsOnRecord() {
    const hero = statsPage.querySelector('#agent-count')
    const note = statsPage.querySelector('[data-agent-record-note]')
    if (!hero || !note) return

    /* THE EXAMPLE ANSWERS FROM ITS OWN RECORD. mcAgent.history() reads this
       computer's signed run ledger — real data — and on the desktop with the
       example on that bridge exists and would answer; its count inside a
       badged rail would make one number on the example true, which is the
       mixing the badge forbids. The example's number is its own seat count,
       and the note says which record it came from rather than claiming the
       signed ledger. */
    if (mockSource()) {
      hero.textContent = String(computer?.spawnedTotal ?? 0)
      hero.dataset.recordState = 'example'
      note.textContent = 'Historical starts in the example fleet record. Agents currently shown in the trees are counted above.'
      return
    }

    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    let raw
    if (!bridge || typeof bridge.history !== 'function') raw = undefined
    else {
      /* 200 is the recorder's own ceiling. The count itself comes from the
         whole-chain tally rather than from these rows, but when that tally is
         missing the rows are what is left to count, and a bigger page makes
         that fallback less of an understatement. */
      try { raw = await bridge.history({ limit: 200 }) } catch { raw = null }
    }
    if (destroyed || !hero.isConnected) return

    const sessions = readLocalSessions(raw)
    if (!sessions.supported) {
      hero.textContent = '—'
      hero.dataset.recordState = 'unsupported'
      note.textContent = 'Open the installed app on this computer to read its agent history.'
      return
    }
    /* AUDITING OFF IS NOT A BROKEN RECORD (owner direction 2026-09-20, T782 /
       BUG08): the person's own setting, the Basic default, said as such and
       pointed at where it is turned on. A record that really would not open
       keeps the sentence below it. */
    if (sessions.disabled) {
      hero.textContent = '—'
      hero.dataset.recordState = 'off'
      note.textContent = 'Activity auditing is off, so no count is kept. Saved history is preserved; turn on Signed activity audit under Advanced settings to record new runs.'
      return
    }
    if (!sessions.readable) {
      hero.textContent = '—'
      hero.dataset.recordState = 'unreadable'
      note.textContent = 'Agent history could not be read, so the count is unavailable.'
      return
    }
    /* `started` is null exactly when the recorder returned no whole-chain
       tally, and `total` is only a start count when that tally is present --
       without it the ledger's line count includes the outcome records too and
       would report roughly twice as many agents as ever ran. */
    const tallied = sessions.started !== null
    const count = tallied ? sessions.total : sessions.runs.length
    hero.textContent = String(count)
    hero.dataset.recordState = tallied ? 'counted' : 'partial'
    const verified = sessions.verified === true
      ? 'The record checks out as unbroken.'
      : (sessions.verified === false
        ? 'The record does not check out as unbroken, so treat this count as a floor.'
        : 'This copy did not say whether the record checks out.')
    note.textContent = tallied
      ? `${drivenComputerCopy(
        'From this computer’s own signed record of every agent it has started.',
        'From the signed record of every agent started by the computer you are driving.',
      )} ${verified}`
      : `Counted from the most recent runs this copy could read, so it may be short. ${verified}`
  }

  /* SESSION PROFILES, MANAGED WHERE THE FLEET IS DESCRIBED. A profile is a
     name plus a folder the person picked in the OS dialog -- the renderer
     never types or shows a path it invented; the main process owns the store
     and the picker. Assigning a profile to a tree happens on the tree's own
     Actions tab; this box creates and removes the profiles themselves. */
  async function mountProfilePanel(slot) {
    if (!slot) return
    /* Mock: the surface stays, with a sentence in it, and no bridge call.
       Profiles are names of YOUR folders (the main process resolves them from
       OS-dialog picks) — a badged rail listing them would be your data inside
       the example, and creating or removing one is a write. */
    if (mockSource()) {
      slot.innerHTML = '<p class="rail-prose is-dim">In your own fleet, save a folder here and assign it from an agent’s controls. Folders are unavailable in the example.</p>'
      return
    }
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const answer = await readComposeFolders()
    if (answer === undefined) return // A later read or source now owns the view.
    if (!bridge || typeof bridge.profiles !== 'function') {
      slot.innerHTML = `<p class="rail-prose is-dim">${escapeMarkup(PROFILE_PANEL.needsApp)}</p>`
      return
    }
    const profiles = answer && answer.ok === true && Array.isArray(answer.profiles) ? answer.profiles : []
    /* Listing profiles does not prove that this version of the bridge can
       change them. Keep the verb verdict beside the controls it governs: an
       older installed copy used to render both buttons enabled, then either
       throw before the add refusal was painted or silently redraw after a
       remove that never ran. This is the same enabled + reason contract used
       by paletteRow() below and by the organisation controls. */
    const readProfilesReason = answer && answer.ok
      ? ''
      : 'The installed app could not read session profiles, so they cannot be changed here.'
    const { add: createState, remove: removeState } = profileControls(bridge, { readProblem: readProfilesReason })
    slot.innerHTML = `
      <div class="board-box board-ctl-box">
        <p class="rail-prose is-dim">${escapeMarkup(PROFILE_PANEL.help)}</p>
        <ul class="rail-prose profile-list" data-profile-list>
          ${profiles.map(profile => `<li><b>${escapeMarkup(profile.name)}</b> · <span class="profile-folder">${escapeMarkup(profile.cwd)}</span> <button class="ctl-btn profile-remove" type="button" data-profile-remove="${escapeMarkup(profile.id)}"${removeState.enabled ? '' : ' disabled'}${removeState.why ? ` title="${escapeMarkup(removeState.why)}" aria-label="${escapeMarkup(`${PROFILE_PANEL.remove}. ${removeState.why}`)}"` : ''}>${escapeMarkup(PROFILE_PANEL.remove)}</button>${removeState.enabled ? '' : ` <span class="rail-sub">${escapeMarkup(removeState.why)}</span>`}</li>`).join('')
            || `<li>${escapeMarkup(PROFILE_PANEL.none)}</li>`}
        </ul>
        <div class="ctl-row">
          <input class="ctl-select" type="text" data-profile-name placeholder="${escapeMarkup(PROFILE_PANEL.namePlaceholder)}" aria-label="${escapeMarkup(createState.why || PROFILE_PANEL.namePlaceholder)}"${createState.enabled ? '' : ' disabled'}>
          <button class="ctl-btn" type="button" data-profile-add${createState.enabled ? '' : ' disabled'}${createState.why ? ` title="${escapeMarkup(createState.why)}" aria-label="${escapeMarkup(`${PROFILE_PANEL.add}. ${createState.why}`)}"` : ''}>${escapeMarkup(PROFILE_PANEL.add)}</button>
        </div>
        <output class="rail-prose" role="status" data-profile-out>${escapeMarkup(createState.why || '')}</output>
      </div>`
    const out = slot.querySelector('[data-profile-out]')
    slot.querySelector('[data-profile-add]')?.addEventListener('click', async () => {
      const name = slot.querySelector('[data-profile-name]')?.value?.trim()
      if (!name) { out.textContent = PROFILE_PANEL.nameFirst; return }
      const made = await bridge.profileCreate({ name }).catch(error => ({ ok: false, code: refusalCode(error) }))
      if (!made || made.ok !== true) { out.textContent = PROFILE_PANEL.refused; return }
      if (!made.profile) { out.textContent = PROFILE_PANEL.cancelled; return }
      void mountProfilePanel(slot)
    })
    for (const button of slot.querySelectorAll('[data-profile-remove]')) {
      button.addEventListener('click', async () => {
        const removed = await bridge.profileRemove({ profileId: button.dataset.profileRemove }).catch(() => null)
        if (!removed || removed.ok !== true) {
          out.textContent = 'That profile could not be removed. Try again.'
          return
        }
        void mountProfilePanel(slot)
      })
    }
  }

  /* WHAT THE PERSON IS LOOKING AT, BEFORE THEY EDIT IT.
     Three facts change what an edit MEANS and none of them is visible unless
     something says it: that their saved organisation could not be loaded and
     this is the shipped default (`damaged`), that the shipped default moved
     under their edits (`baselineDrift`), and that there is no store here at all.
     orgNoticeMarkup carries the first two verbatim from the engine; the third is
     added here because a rail that offers no editing owes a reason. */
  function orgSourceMarkup() {
    if (!orgReady()) {
      return `<div class="org-notice" data-notice="off">${escapeMarkup(failureSentence(orgAvailability, 'The declared organisation could not be read.'))}</div>`
    }
    const source = orgAvailability.org.source === 'overlay'
      ? 'This is the organisation you saved.'
      : drivenComputerCopy(
        'This is the organisation the app ships with. Nothing has been changed on this computer yet.',
        'This is the organisation the app ships with. Nothing has been changed yet on the computer you are driving.',
      )
    return `${orgNoticeMarkup(orgAvailability.org)}
      <p class="rail-prose is-dim">${escapeMarkup(source)}</p>
      <dl class="rail-facts">
        <div class="rail-fact"><dt>Revision</dt><dd>${escapeMarkup(String(orgAvailability.org.revision))}</dd></div>
      </dl>`
  }

  /* The role library is HIDDEN, not disabled, when there is no bridge at all.
     A whole panel of dead fields is noise in a browser that was never going to
     have an organisation store; the one-line reason above it has already been
     said. A bridge that answered with a FAILURE is different — that copy owes an
     explanation — so the panel is built and renders itself disabled. */
  function mountOrgLibrary(slot) {
    const launcher = root.querySelector('[data-open-role-workspace]')
    if (launcher) {
      launcher.hidden = mockSource() || orgAvailability.state === 'absent'
      launcher.disabled = orgAvailability.state !== 'ready'
    }
    if (!slot) return
    if (orgAvailability.state === 'absent') {
      slot.remove()
      return
    }
    const box = buildRoleLibraryBox({
      availability: orgAvailability,
      scopeKey: `${currentDataSource()}:${computer?.id || ''}`,
      onCreate: (definition) => callRoleBridge('createRole', definition, 'The role was not created.'),
      onEdit: (edit) => callRoleBridge('editRole', edit, 'The role wording was not saved.'),
      onReset: (target) => callRoleBridge('resetRole', target, 'The shipped wording was not restored.'),
    })
    slot.replaceWith(box)
    /* THE PERSON'S OPEN EDITORS AND UNSAVED WORDING, BACK WHERE THEY WERE.
       NOT read-once, deliberately, and this is where it differs from
       composeToRestore above: the live mount can build this box more than once
       while it settles (measured 2026-08-20, two builds 8ms apart on the
       drawer's live-flip -- a read-once restore was consumed by the first
       build and wiped by the second). So the snapshot is re-applied to every
       build until the person touches the restored library; their first input
       or press makes the page the truth, and a later rebuild must not drag it
       back to the snapshot. Each flags capture above overwrites the snapshot
       wholesale, so it can never be older than the last remount. */
    if (roleLibraryToRestore && restoreRoleLibrary(box, roleLibraryToRestore) > 0) {
      const settle = () => { roleLibraryToRestore = null }
      box.addEventListener('input', settle, { once: true, capture: true })
      box.addEventListener('click', settle, { once: true, capture: true })
    }
  }

  /* One door to the three role-vocabulary calls. Each returns {ok, roles} and
     nothing else changes, so the cached role list is replaced and the graph is
     left alone — a role's WORDING is not a fact the canvas draws. */
  async function callRoleBridge(method, request, fallback) {
    const bridge = orgBridge()
    if (!bridge || typeof bridge[method] !== 'function') {
      return { ok: false, code: 'ORG_BRIDGE_ABSENT', reason: ORG_ABSENT_REASON }
    }
    let result
    try {
      result = await bridge[method](request)
    } catch (error) {
      result = { ok: false, code: 'ORG_ROLE_CALL_THREW', reason: `${fallback} ${error?.message || error}` }
    }
    if (result?.ok && Array.isArray(result.roles) && orgReady()) {
      orgAvailability = { ...orgAvailability, roles: result.roles }
    }
    return result
  }

  function showStats() {
    if (chatWorkspace) { refreshWorkspaceChats(); return }
    if (chatNodeId) {
      const node = computer?.id === initialComputer ? treeStore?.getNode(chatNodeId) : null
      if (node) {
        if (currentRailTreeNode?.id !== node.id || !railChat) showTreeNodeControls(node)
        else activateRail(controlsPage)
      } else {
        disposeRailChat()
        statsPage.innerHTML = '<p class="home-scope-empty">This agent is no longer available on the selected computer. Choose another conversation from View.</p>'
        activateRail(statsPage)
      }
      return
    }
    /* Restore the overview’s initial chat target when leaving node controls. */
    if (!openTarget || openTarget.treeNode) setOpenTarget(computer?.agents?.[0] || firstDeclaredTarget())
    renderStats()
    activateRail(statsPage)
  }

  /* The three lifecycle buttons this page cannot perform, rendered as disabled
     with the reason on each one. They are kept rather than deleted because the
     owner asked for the buttons, and because a person who remembers a Pause
     button and now finds nothing will assume the page is broken. Saying "there
     is no bridge action for this" is the honest version of showing a button
     that quietly rearranges a CSS class. This is the same posture the agent
     drill-in already ships (src/views/agent.js).

     TWO OF THE THREE REASONS HAD GONE FALSE, which is worse than a disabled
     button with no reason at all -- it is a claim about the product that a
     person can act on. Resume's said "nothing can be paused, so nothing can be
     resumed", making resume a consequence of pause; it is its own verb
     (RESUME_PANEL) and it really runs, on an agent in the tree. Respawn's
     named a "supervisor sweep from a persisted checkpoint" that occurs nowhere
     else in this repository. Both now say the true thing -- this rail holds a
     RECORD, with no node, no saved conversation and no session for either verb
     to act on -- and name the row that does perform it, taking the wording
     from that row rather than restating it. Pause is unchanged: it is the one
     of the three that genuinely does not exist anywhere in this build. */
  const DEAD_ACTIONS = Object.freeze([
    Object.freeze({ id: 'pause', label: 'Pause', why: 'Pause unavailable: the audited bridge has no pause action, and a running lane cannot be suspended.' }),
    Object.freeze({ id: 'resume', label: 'Resume', why: recordRailVerbElsewhere(RESUME_PANEL.action) }),
    Object.freeze({ id: 'respawn', label: 'Respawn', why: recordRailVerbElsewhere(PALETTE_PANEL.clear) }),
  ])

  function deadActionButtons() {
    return DEAD_ACTIONS.map(action => `<button class="ctl-btn" type="button" disabled data-a="${action.id}" title="${escapeMarkup(action.why)}" aria-label="${escapeMarkup(action.why)}">${escapeMarkup(action.label)}</button>`).join('')
  }

  /* One bridge preparation per view, not one per node click. bridgeStatus()
     parses every root's queue and writes durable audit receipts (~12s measured,
     see src/write-surfaces.js), so calling it from a click handler that fires
     every time somebody selects a node would turn a cheap gesture into a
     repeated expensive one. */
  /* A SUCCESS IS WORTH REMEMBERING. A FAILURE IS NOT, AND REMEMBERING IT WAS A
     TRAP. The memo above is right about the cost and wrong about its scope: it
     cached whatever came back, so the FIRST press deciding "the bridge is
     unreachable" made that the answer for the entire life of this view. A
     person who read the refusal, fixed the cause and pressed again got the same
     stale sentence -- all three start controls saying "checking the audited
     connection..." while checking nothing -- and the only way out was leaving
     the page and coming back, which nothing tells them to do.

     Clearing on failure keeps the expensive call from running per click (a
     success is still remembered) and keeps concurrent presses sharing one
     in-flight attempt (they all await this same promise), while letting the
     next press after a settled failure actually try again. */
  let bridgePrep = null
  function prepareBridgeOnce() {
    if (!bridgePrep) {
      bridgePrep = (async () => {
        const reach = await bridgeReachable()
        if (!reach.ok) return reach
        return bridgeStatus()
      })()
        .catch(error => ({ ok: false, reason: error?.message || 'action bridge unreachable' }))
        .then((result) => {
          if (!result || result.ok !== true) bridgePrep = null
          return result
        })
    }
    return bridgePrep
  }

  const launchKey = () => `mc.page2.launch.${computer?.id || 'unknown'}`
  function readLaunchSettings() {
    let stored = null
    try { stored = JSON.parse(localStorage.getItem(launchKey()) || 'null') } catch { stored = null }
    const tierId = launchTier(stored?.tier) ? stored.tier : LAUNCH_TIERS[0].id
    return { tier: tierId, capMs: clampCapMs(stored?.capMs ?? CAP_BOUNDS.defaultMs) }
  }
  function writeLaunchSettings(next) {
    try { localStorage.setItem(launchKey(), JSON.stringify(next)) } catch { /* session-only is still a real change */ }
  }

  /**
   * The control panel that replaced "Tuning".
   *
   * Every row here is either a knob that provably reaches the child process, or
   * a knob that does not exist and says so. There is deliberately no third
   * category. The argv line is not decoration: it is the actual fragment
   * capability/src/lib/mission-bridge/actions.js builds for the selected tier,
   * so a person can read what their choice does instead of trusting a label.
   */
  /* What stands where the launch, team, loop and cloud boxes stand on a
   * real-source board.
   *
   * It is a statement, not a control: no button, nothing focusable, nothing
   * that could be re-enabled by deleting an attribute. It exists because an
   * empty gap is its own kind of dishonesty -- somebody who used this page
   * yesterday and finds Dispatch missing today should be told why and where
   * the working one is, rather than left to wonder whether the product broke.
   * mountStartWorkControls mounts it inside the Start-work group whenever the
   * source is mock, so the group itself stays visible and named -- the
   * example page IS the product page, and its start-work surface states its
   * own inertness instead of vanishing. */
  function exampleControlsAbsentBox() {
    return el(`
      <div class="board-box board-ctl-box board-ctl-absent">
        <div class="board-box-h"><span class="bh-t">No launch controls on this board</span></div>
        <div class="board-cap">this is the example fleet, and nothing here starts anything.</div>
        <p class="board-absent-copy">Launch, team, loop and cloud controls are left out of the example on purpose: nothing on an example screen may start a real agent. They appear on the board that reads this computer.</p>
        <p class="board-absent-copy">${exampleExitSentence()}</p>
      </div>`)
  }

  /* THE FENCE, and it is the same one dd01899 put on the example AGENT page.
   *
   * WHAT WAS WRONG. This box, and the team and loop boxes below it, were built
   * for the SIMULATED board as readily as for the live one, gated on nothing but
   * `isWriteEnabled('dispatch')`. So the example copy of page 2 -- the one whose
   * own banner says nothing on it is real, sitting under an app-wide notice
   * saying these screens show example data -- mounted a Dispatch button wired
   * through postBridgeAction() to a real bridge. The write flag is a question
   * about PERMISSION; it was standing in for a question about PROVENANCE, and
   * the two are not the same question.
   *
   * `live` DEFAULTS TO FALSE so a caller that never considered the question
   * cannot accidentally answer yes, and the test is `!== true` rather than a
   * truthy check so a stray string cannot pass. The refusal returns null and the
   * caller renders a stated absence: on this page the controls are GONE from the
   * example board, not greyed out, because a disabled Dispatch button still
   * describes a capability this board does not have.
   *
   * IT IS BELT AND BRACES ON PURPOSE. mountStartWorkControls below mounts the
   * stated-absence box instead of these four whenever the source is mock, so
   * this branch should be unreachable; it is here because "unreachable" is a
   * property of today's callers and this file is edited by several lanes. */
  async function startBoundedChild(request, store, bridge) {
    if (window.mcAgent !== bridge) return { ok: false, message: 'The connection to this computer changed. No further work was started.' }
    const refreshed = await readOrg()
    if (refreshed?.state !== 'ready') return { ok: false, message: 'The Role library could not be read. This child was not started.' }
    orgAvailability = refreshed
    const parent = store?.getNode(request.parentNodeId)
    if (mockSource() || !store || store.snapshot().computerId !== request.computerId
      || !parent || parent.treeId !== request.treeId || parent.sessionId !== request.parentSessionId
      || sessionNodeIds.get(request.parentSessionId) !== parent.id) {
      return { ok: false, message: 'The selected parent is no longer open on this tree. Open or resume that agent before handing it work.' }
    }
    if (!isWriteEnabled('dispatch') || !isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, message: 'Starting agents and handing out work must both be enabled in Settings.' }
    if (typeof window.mcAgent?.workStatus !== 'function') return { ok: false, message: 'This installed copy cannot verify bounded tree work. Update the app before starting it.' }
    if (!roleRecordFor('worker') || roleRecordFor('worker').capabilities?.orgRoot === true) return { ok: false, message: 'The Worker role is unavailable. Restore it in the Role library before starting this work.' }
    const added = store.addNode({ parentId: parent.id, role: 'worker', tier: request.tier,
      effort: PROVIDERS_WITH_A_THINKING_DEPTH.has(launchTier(request.tier)?.provider) ? (request.effort || tierEffortOf(request.tier) || '') : '', message: request.brief })
    if (!added.ok || added.snapshot?.persistenceFailed) return { ok: false, message: added.problems?.[0] || 'The child could not be saved, so it was not started.' }
    refreshTree()
    const result = await startDraftNode(added.node, { queueManaged: true, ownedStore: store,
      effort: PROVIDERS_WITH_A_THINKING_DEPTH.has(launchTier(request.tier)?.provider) ? request.effort : null,
      boundedWork: { computerId: request.computerId, treeId: request.treeId,
        parentNodeId: parent.id, parentSessionId: request.parentSessionId, capMs: request.capMs } })
    const retained = store.getNode(added.node.id)
    return { ...result, nodeId: added.node.id, sessionId: result.sessionId || retained?.sessionId || null }
  }

  function subscribeBoundedSessionEnded(bridge, listener) {
    const unsubscribe = bridge.onEvent(packet => {
      if (sessionEndedEvent(packet, packet?.sessionId)) listener(packet.sessionId)
    })
    RUN_NATIVE_WORK_CLOSE_LISTENERS.add(listener)
    return () => {
      RUN_NATIVE_WORK_CLOSE_LISTENERS.delete(listener)
      unsubscribe()
    }
  }

  function nativeBoundedWorkBox(agent, kind) {
    const titles = { launch: 'Launch controls', team: 'Team', loop: 'Loop' }
    const key = `${treeStore.snapshot().computerId}:${agent.id}:${kind}`
    let controller = RUN_NATIVE_WORK_CONTROLLERS.get(key)
    if (!controller) {
      const ownedStore = treeStore
      const bridge = window.mcAgent
      controller = createTreeWorkController({ kind, start: request => startBoundedChild(request, ownedStore, bridge),
        readStatus: sessionId => bridge.workStatus({ sessionId }),
        subscribeEnded: listener => subscribeBoundedSessionEnded(bridge, listener),
        close: async sessionId => {
          const result = await bridge.close({ sessionId })
          const status = await bridge.workStatus({ sessionId })
          if (status?.ok === true && status.sessionId === sessionId && status.state === 'closed') {
            if (!destroyed) { settleStoppedSession(sessionId); refreshTree() }
            else sessionNodeIds.delete(sessionId)
          }
          return result
        },
        isBusy: sessionId => {
          const node = ownedStore.getNode(sessionNodeIds.get(sessionId))
          return !node || nodeBusy(node)
        },
      })
      RUN_NATIVE_WORK_CONTROLLERS.set(key, controller)
    }
    const settings = readLaunchSettings()
    const field = name => `data-${kind === 'launch' ? 'launch' : kind}="${name}"`
    const nativeTiers = LAUNCH_TIERS.filter(tier => ['codex', 'claude'].includes(tier.provider))
    const tiers = nativeTiers.map(tier => `<option value="${escapeMarkup(tier.id)}"${tier.id === settings.tier ? ' selected' : ''}>${escapeMarkup(tier.label)} · ${escapeMarkup(tier.provider)}</option>`).join('')
    const box = el(`<div class="board-box board-ctl-box board-${kind}-box" data-native-work="${kind}">
      <div class="board-box-h"><span class="bh-t">${titles[kind]}</span></div>
      <div class="board-cap">${kind === 'team' ? 'start a lead under this agent and members under that lead' : 'start saved child work under this agent'}</div>
      <label class="ctl-field"><span class="cl">${kind === 'team' ? 'Lead' : 'Agent'}</span><select class="ctl-select" ${field(kind === 'team' ? 'lead' : 'tier')} aria-label="${kind === 'team' ? 'Team lead tier' : kind === 'loop' ? 'Looped agent tier' : 'Launch tier'}">${tiers}</select></label>
      <label class="ctl-field"><span class="cl">Thinking depth</span><select class="ctl-select" data-work-effort aria-label="Child effort"><option value="">Provider default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
      ${kind === 'team' ? `<div class="ctl-field ctl-team-members"><span class="cl">Members</span><div class="team-member-grid">${nativeTiers.map(tier => `<label class="team-member"><input type="checkbox" data-team-member="${escapeMarkup(tier.id)}"/><span>${escapeMarkup(tier.label)}</span></label>`).join('')}</div></div><div class="rail-sub">Each member gets its own saved Worker identity and the lead’s remaining time cap.</div>` : ''}
      ${kind === 'loop' ? `<label class="ctl-field"><span class="cl">Runs</span><select class="ctl-select" data-loop="runs" aria-label="How many runs">${Array.from({ length: 7 }, (_, i) => `<option value="${i + 2}">${i + 2}</option>`).join('')}</select></label><label class="ctl-field"><span class="cl">Every</span><select class="ctl-select" data-loop="every" aria-label="Minutes between runs">${[1, 5, 10, 20, 30, 60, 120, 240].map(value => `<option value="${value}"${value === (loopIntervals.get(agent.id) || 20) ? ' selected' : ''}>${value} min</option>`).join('')}</select></label>` : ''}
      <label class="ctl-field"><span class="cl">Brief</span><textarea class="ctl-select" data-work-brief aria-label="${titles[kind]} brief" maxlength="${FLEET_TREE_LIMITS.maxMessageChars}" rows="3"></textarea></label>
      <label class="ctl-field"><span class="cl">Time cap</span><input class="ctl-num" type="number" ${field('cap')} min="${capMinutes(CAP_BOUNDS.minMs)}" max="${capMinutes(CAP_BOUNDS.maxMs)}" step="1" value="${capMinutes(settings.capMs)}" aria-label="${titles[kind]} time cap in minutes"/><span class="cv">min</span></label>
      <div class="rail-sub">The host closes this work and its child sessions at the cap. A parent’s remaining cap can shorten it. Replies appear on the saved circles.</div>
      ${kind === 'launch' ? '<div class="ctl-field"><span class="cl">Sandbox</span><span class="cv" data-launch="sandbox">Reading the computer’s permissions…</span></div><div class="rail-sub" data-launch="sandbox-note"></div>' : ''}
      ${kind === 'loop' ? '<div class="rail-sub">A due run is skipped while the previous reply is active. A finished session is confirmed closed before the next starts. The schedule continues across pages while this app window is open. Return here to stop it; closing the app ends the schedule.</div>' : ''}
      <div class="ctl-dispatch"><button class="ctl-btn" type="button" ${field(kind === 'launch' ? 'dispatch' : 'go')}>${kind === 'launch' ? `Hand work to ${escapeMarkup(agent.name)}` : kind === 'team' ? 'Start the team' : 'Start loop'}</button><button class="ctl-btn danger" type="button" ${field('stop')} disabled>${kind === 'loop' ? 'Stop loop' : kind === 'team' ? 'Stop team' : 'Stop child work'}</button><output class="ctl-out" ${field('out')} role="status"></output></div>
      <div class="team-roster" data-work-roster></div>
    </div>`)
    const go = box.querySelector(`[${field(kind === 'launch' ? 'dispatch' : 'go')}]`)
    const stop = box.querySelector(`[${field('stop')}]`)
    const out = box.querySelector(`[${field('out')}]`)
    const brief = box.querySelector('[data-work-brief]')
    const tier = box.querySelector(`[${field(kind === 'team' ? 'lead' : 'tier')}]`)
    const cap = box.querySelector(`[${field('cap')}]`)
    const roster = box.querySelector('[data-work-roster]')
    const priorPlan = controller.getPlan()
    if (priorPlan) {
      tier.value = priorPlan.tier
      cap.value = String(capMinutes(priorPlan.capMs))
      brief.value = priorPlan.brief
      box.querySelector('[data-work-effort]').value = priorPlan.effort || ''
      for (const input of box.querySelectorAll('[data-team-member]')) input.checked = priorPlan.members.includes(input.getAttribute('data-team-member'))
      if (kind === 'loop') {
        box.querySelector('[data-loop="runs"]').value = String(priorPlan.iterations)
        const every = box.querySelector('[data-loop="every"]')
        const minutes = String(priorPlan.intervalMs / 60_000)
        if (![...every.querySelectorAll('option')].some(option => option.value === minutes)) every.appendChild(el(`<option value="${escapeMarkup(minutes)}">${escapeMarkup(minutes)} min</option>`))
        every.value = minutes
      }
    }
    const paint = state => {
      const parent = treeStore?.getNode(agent.id)
      const liveParent = parent?.sessionId && sessionNodeIds.get(parent.sessionId) === parent.id
      const available = !mockSource() && isWriteEnabled('dispatch') && isWriteEnabled(START_CONTROL_FLAG) && typeof window.mcAgent?.workStatus === 'function'
      const members = [...box.querySelectorAll('[data-team-member]')].filter(input => input.checked)
      box.querySelector('[data-work-effort]').disabled = ![tier.value, ...members.map(input => input.getAttribute('data-team-member'))].some(value => PROVIDERS_WITH_A_THINKING_DEPTH.has(launchTier(value)?.provider))
      go.disabled = state.busy || state.stoppable || !available || !liveParent || !brief.value.trim() || (kind === 'team' && members.length === 0)
      stop.disabled = !state.stoppable || state.phase === 'stopping'
      out.textContent = state.message || (!available ? 'Starting agents, handing out work, and an app with bounded tree support are required.' : !liveParent ? 'Start or resume this agent before handing it work.' : 'Write a brief for the child work.')
      roster.replaceChildren(...state.rows.map(row => el(`<div class="team-row" data-phase="${escapeMarkup(row.phase)}" data-work-node="${escapeMarkup(row.nodeId || '')}" data-work-session="${escapeMarkup(row.sessionId)}"><b>${escapeMarkup(row.label)} · ${escapeMarkup(row.tier)}</b><span>${escapeMarkup(row.detail)}</span>${row.receipt ? `<span>Closes by ${escapeMarkup(new Date(row.receipt.deadlineAt).toLocaleTimeString())}</span>` : ''}</div>`)))
    }
    if (kind === 'launch') void Promise.resolve(window.mcAgent?.confinement?.()).then(raw => {
      if (!box.isConnected) return
      const level = raw?.ok === true ? sandboxLevel(raw.tier) : null
      box.querySelector('[data-launch="sandbox"]').textContent = level ? `${raw.tier} · ${level.codex}` : 'not resolved'
      box.querySelector('[data-launch="sandbox-note"]').textContent = level?.summary || 'This copy could not read the computer’s permission level.'
    }).catch(() => {})
    const unsubscribe = controller.subscribe(paint)
    unsubs.push(unsubscribe)
    for (const selector of ['input', 'select', 'textarea']) for (const control of box.querySelectorAll(selector)) {
      control.addEventListener('input', () => paint(controller.getState()))
      control.addEventListener('change', () => paint(controller.getState()))
    }
    cap.addEventListener('change', () => { cap.value = String(capMinutes(clampCapMs(Number(cap.value) * 60_000))) })
    if (kind === 'loop') box.querySelector('[data-loop="every"]').addEventListener('change', () => {
      loopIntervals.set(agent.id, Number(box.querySelector('[data-loop="every"]').value))
      notifyNodeStatusListeners()
    })
    go.addEventListener('click', async () => {
      paint(controller.getState())
      if (go.disabled) return
      const parent = treeStore?.getNode(agent.id)
      if (!parent) return
      const capMs = clampCapMs(Number(cap.value) * 60_000)
      writeLaunchSettings({ tier: tier.value, capMs })
      await controller.run({ computerId: treeStore.snapshot().computerId, treeId: parent.treeId,
        parentNodeId: parent.id, parentSessionId: parent.sessionId, tier: tier.value,
        effort: box.querySelector('[data-work-effort]').value || null, capMs, brief: brief.value.trim(),
        members: [...box.querySelectorAll('[data-team-member]')].filter(input => input.checked).map(input => input.getAttribute('data-team-member')),
        ...(kind === 'loop' ? { iterations: Number(box.querySelector('[data-loop="runs"]').value), intervalMs: Number(box.querySelector('[data-loop="every"]').value) * 60_000 } : {}) })
    })
    stop.addEventListener('click', () => { void controller.stop() })
    return box
  }

  function launchControlsBox(agent, { live = false } = {}) {
    if (live !== true) return null
    if (treeStore?.getNode(agent.id)) return nativeBoundedWorkBox(agent, 'launch')
    const settings = readLaunchSettings()
    const dispatchEnabled = isWriteEnabled('dispatch')
    const box = el(`
      <div class="board-box board-ctl-box">
        <div class="board-box-h"><span class="bh-t">Launch controls</span></div>
        <div class="board-cap">what a lane started under this agent would run with</div>
        <label class="ctl-field"><span class="cl">Engine &amp; effort</span>
          <select class="ctl-select" data-launch="tier" aria-label="Launch tier">
            ${DISPATCH_TIERS.map(tier => `<option value="${escapeMarkup(tier.id)}"${tier.id === settings.tier ? ' selected' : ''}>${escapeMarkup(tier.label)} · ${escapeMarkup(tier.provider)}${tier.effort ? ` · ${escapeMarkup(tier.effort)}` : ''}</option>`).join('')}
          </select>
        </label>
        <div class="ctl-argv" data-launch="argv"></div>
        <label class="ctl-field"><span class="cl">Time cap</span>
          <input class="ctl-num" type="number" data-launch="cap" min="${capMinutes(CAP_BOUNDS.minMs)}" max="${capMinutes(CAP_BOUNDS.maxMs)}" step="1" value="${capMinutes(settings.capMs)}" aria-label="Run time cap in minutes"/>
          <span class="cv">min</span>
        </label>
        <div class="rail-sub" data-launch="cap-note">The lane's process tree is killed when this elapses.</div>
        <div class="ctl-field"><span class="cl">Sandbox</span><span class="cv" data-launch="sandbox">${drivenComputerCopy(
          "reading this computer's permission level…",
          'reading the permission level of the computer you are driving…',
        )}</span></div>
        <div class="rail-sub" data-launch="sandbox-note"></div>
        <div class="ctl-unsupported">
          <div class="cl">Not controllable, and why</div>
          ${UNSUPPORTED_CONTROLS.map(item => `<div class="ctl-unsupported-row"><b>${escapeMarkup(item.label)}</b><span>${escapeMarkup(item.reason)}</span><code>${escapeMarkup(item.evidence)}</code></div>`).join('')}
        </div>
        <div class="ctl-dispatch">
          <button class="ctl-btn" type="button" data-launch="dispatch"${dispatchEnabled ? '' : ' disabled'} title="${dispatchEnabled ? 'Start a recorded work lane nested under this agent' : 'Handing out work is switched off. Turn on “Hand out work to agents” in Settings to use it.'}">Hand work to ${escapeMarkup(agent.name)}</button>
          <output class="ctl-out" data-launch="out" role="status">${dispatchEnabled ? '' : 'switched off in Settings'}</output>
        </div>
      </div>`)

    const tierSelect = box.querySelector('[data-launch="tier"]')
    const capInput = box.querySelector('[data-launch="cap"]')
    const argvLine = box.querySelector('[data-launch="argv"]')
    const output = box.querySelector('[data-launch="out"]')

    const paintArgv = () => {
      const fragment = tierArgvFragment(tierSelect.value) || []
      argvLine.textContent = fragment.join(' ')
    }
    const persist = () => {
      writeLaunchSettings({ tier: tierSelect.value, capMs: clampCapMs(Number(capInput.value) * 60_000) })
    }
    tierSelect.addEventListener('change', () => { paintArgv(); persist() })
    capInput.addEventListener('change', () => {
      capInput.value = String(capMinutes(clampCapMs(Number(capInput.value) * 60_000)))
      persist()
    })
    paintArgv()

    /* The sandbox is REPORTED, not chosen. Dispatch derives it from the
       machine's recorded install permission level and has no field for an
       explicit one, so a dropdown here would be a control the call cannot
       carry. What it can honestly do is tell the person which level they are
       on and what that level refuses. */
    void (async () => {
      const raw = await window.mcAgent?.confinement?.().catch(() => null)
      if (!box.isConnected) return
      const level = raw?.ok === true ? sandboxLevel(raw.tier) : null
      const target = box.querySelector('[data-launch="sandbox"]')
      const note = box.querySelector('[data-launch="sandbox-note"]')
      if (!level) {
        target.textContent = 'not resolved'
        note.textContent = drivenComputerCopy(
          'This copy could not read the computer’s permission level, so the sandbox a lane would run under is unknown.',
          'This copy could not read the permission level of the computer you are driving, so the sandbox a lane would run under there is unknown.',
        )
        return
      }
      target.textContent = `${raw.tier} · ${level.codex}`
      note.textContent = level.summary
    })()

    const dispatchButton = box.querySelector('[data-launch="dispatch"]')
    if (dispatchEnabled) {
      dispatchButton.addEventListener('click', async () => {
        dispatchButton.disabled = true
        output.textContent = 'checking the audited connection…'
        const status = await prepareBridgeOnce()
        if (!box.isConnected) return
        const rootId = Array.isArray(status?.roots) ? status.roots[0] : null
        if (!status?.ok || !rootId) {
          output.textContent = `unavailable · ${status?.reason || drivenComputerCopy(
            'no workspace folder is recorded for this computer',
            'no workspace folder is recorded for the computer you are driving',
          )}`
          dispatchButton.disabled = false
          return
        }
        output.textContent = 'dispatching…'
        const result = await postBridgeAction('dispatch', {
          rootId,
          tier: tierSelect.value,
          objectiveRef: `page2-${String(agent.id).replace(/[^a-z0-9_-]/gi, '-').slice(0, 60)}`,
          brief: `Lane requested from the fleet page, nested under ${agent.name}.`,
          cap: { kind: 'turns', value: 8, capMs: clampCapMs(Number(capInput.value) * 60_000) },
        })
        if (!box.isConnected) return
        dispatchButton.disabled = false
        /* The identifier goes on the node, not into the sentence — see
           src/refusal-copy.js. It is resolved once so the remedy lookup and the
           machine channel cannot disagree about which refusal this was. */
        const refusal = result.ok ? null : { code: refusalCodeOf(result) || 'BRIDGE_REFUSED', reason: result.reason }
        output.textContent = result.ok
          ? `started · ${result.receipt.launchId}`
          : `refused · ${refusalSentence(refusal, { fallback: 'The dispatch was refused with no receipt.' })}`
        markRefusalCode(output, refusal)
      })
    }
    return box
  }

  /**
   * TEAMS — one brief, several agents, nested under a lead.
   *
   * Every control here is backed by the same audited dispatch call the single
   * lane button uses. There is deliberately no new engine concept: a team is a
   * lead dispatch plus one nested dispatch per member, which is why the
   * engine's own fan-out cap (LAUNCH_FANOUT_EXCEEDED) finally applies to it.
   *
   * The two things this panel must not imply, and says out loud instead:
   *   - Six tiers are only FOUR concurrent agents. All three Claude tiers are
   *     the declared agent `claude`, and the presence registry allows one live
   *     lane per identity. A picker that let you tick Opus and Sonnet together
   *     would 409 on the second one every time.
   *   - "Started" is not "answered". Dispatch returns when the child process is
   *     running; the result is never returned to the caller. A panel that said
   *     "collecting results" would be describing a channel that does not exist.
   *
   * No animation is used anywhere in here: page 2 asserts that nothing inside
   * .computers is animating once settled.
   */
  /* Same fence, same reason; see launchControlsBox(). */
  function teamControlsBox(agent, { live = false } = {}) {
    if (live !== true) return null
    if (treeStore?.getNode(agent.id)) return nativeBoundedWorkBox(agent, 'team')
    const dispatchEnabled = isWriteEnabled('dispatch')
    const box = el(`
      <div class="board-box board-team-box">
        <div class="board-box-h"><span class="bh-t">Team</span></div>
        <div class="board-cap">send one brief to several agents, nested under a lead</div>
        <label class="ctl-field"><span class="cl">Lead</span>
          <select class="ctl-select" data-team="lead" aria-label="Team lead tier">
            ${DISPATCH_TIERS.map(tier => `<option value="${escapeMarkup(tier.id)}">${escapeMarkup(tier.label)} · ${escapeMarkup(tier.provider)}</option>`).join('')}
          </select>
        </label>
        <div class="ctl-field ctl-team-members"><span class="cl">Members</span>
          <div class="team-member-grid" data-team="members">
            ${DISPATCH_TIERS.map(tier => `
              <label class="team-member"><input type="checkbox" data-team-member="${escapeMarkup(tier.id)}"/>
                <span>${escapeMarkup(tier.label)}</span>
                <code>${escapeMarkup((TIER_SEAT_POOL[tier.id] || []).length === 1 ? '1 seat' : `${(TIER_SEAT_POOL[tier.id] || []).length} seats`)}</code>
              </label>`).join('')}
          </div>
        </div>
        <div class="rail-sub" data-team="identity-note">${drivenComputerCopy(
          `Every agent needs its own seat. Some agents share a set of seats, so at most ${TEAM_BOUNDS.maxConcurrent} can run at the same time on this computer.`,
          `Every agent needs its own seat. Some agents share a set of seats, so at most ${TEAM_BOUNDS.maxConcurrent} can run at the same time on the computer you are driving.`,
        )}</div>
        <div class="rail-sub" data-team="plan" role="status"></div>
        <div class="ctl-dispatch">
          <button class="ctl-btn" type="button" data-team="go"${dispatchEnabled ? '' : ' disabled'} title="${dispatchEnabled ? 'Start the lead first, then nest each member under its launch' : 'Handing out work is switched off. Turn on “Hand out work to agents” in Settings to use it.'}">Start the team</button>
          <output class="ctl-out" data-team="out" role="status">${dispatchEnabled ? '' : 'switched off in Settings'}</output>
        </div>
        <div class="team-roster" data-team="roster"></div>
        <div class="rail-sub" data-team="honesty">Started means the process is running, not that it has answered. A dispatch returns a launch receipt, never a result.</div>
      </div>`)

    const leadSelect = box.querySelector('[data-team="lead"]')
    const planLine = box.querySelector('[data-team="plan"]')
    const goButton = box.querySelector('[data-team="go"]')
    const output = box.querySelector('[data-team="out"]')
    const roster = box.querySelector('[data-team="roster"]')
    let controller = null

    const selectedMembers = () => [...box.querySelectorAll('[data-team-member]')]
      .filter(input => input.checked)
      .map(input => input.getAttribute('data-team-member'))

    const currentPlan = () => planTeam({ lead: leadSelect.value, members: selectedMembers() })

    /* The plan is recomputed on every change and the button follows it, so an
       undispatchable team is refused BEFORE anything is started rather than
       part-way through. */
    const paintPlan = () => {
      const plan = currentPlan()
      planLine.textContent = plan.dispatchable
        ? `Ready: ${plan.lead} leads ${plan.members.length} member${plan.members.length === 1 ? '' : 's'}; ${plan.size} lanes total.`
        : plan.problems.join(' ')
      goButton.disabled = !dispatchEnabled || !plan.dispatchable
      if (!dispatchEnabled) goButton.title = 'Handing out work is switched off. Turn on “Hand out work to agents” in Settings to use it.'
      else if (!plan.dispatchable) goButton.title = plan.problems.join(' ')
      else goButton.title = 'Start the lead first, then nest each member under its launch'
      return plan
    }

    const paintRoster = state => {
      const rows = [state.lead ? { ...state.lead, lead: true } : null, ...state.members].filter(Boolean)
      roster.replaceChildren(...rows.map(row => el(`
        <div class="team-row" data-phase="${escapeMarkup(row.phase)}">
          <b>${escapeMarkup(row.tier)}${row.lead ? ' · lead' : ''}</b>
          <code>${escapeMarkup(row.identity || '?')}</code>
          <span>${escapeMarkup(row.detail)}</span>
        </div>`)))
    }

    leadSelect.addEventListener('change', paintPlan)
    for (const input of box.querySelectorAll('[data-team-member]')) {
      input.addEventListener('change', paintPlan)
    }
    paintPlan()

    if (dispatchEnabled) {
      goButton.addEventListener('click', async () => {
        const plan = paintPlan()
        if (!plan.dispatchable) return
        goButton.disabled = true
        output.textContent = 'checking the audited connection…'
        const status = await prepareBridgeOnce()
        if (!box.isConnected) return
        const rootId = Array.isArray(status?.roots) ? status.roots[0] : null
        if (!status?.ok || !rootId) {
          output.textContent = `unavailable · ${status?.reason || drivenComputerCopy(
            'no workspace folder is recorded for this computer',
            'no workspace folder is recorded for the computer you are driving',
          )}`
          goButton.disabled = false
          return
        }
        const settings = readLaunchSettings()
        controller?.destroy()
        controller = createTeamController({
          plan,
          dispatchBody: {
            rootId,
            objectiveRef: `page2-team-${String(agent.id).replace(/[^a-z0-9_-]/gi, '-').slice(0, 50)}`,
            brief: `Team requested from the fleet page, led under ${agent.name}.`,
            cap: { kind: 'turns', value: 8, capMs: clampCapMs(settings.capMs) },
          },
          postAction: postBridgeAction,
          onState: state => {
            if (!box.isConnected) return
            output.textContent = state.message
            paintRoster(state)
          },
        })
        await controller.run()
        if (!box.isConnected) return
        goButton.disabled = false
        paintPlan()
      })
    }

    return box
  }

  /**
   * LOOPS — running one agent again and again, with the stop beside the start.
   *
   * The one control on this page a person is meant to start and then WALK AWAY
   * from, which is why the panel spends most of its space on bounds rather than
   * on options. Three sentences are always on screen, not behind a tooltip,
   * because each one is a promise somebody is relying on while not watching:
   * what happens on overrun, what bounds a single run, and the fact that this
   * loop lives only as long as the window does.
   *
   * THE STOP IS RENDERED BESIDE THE START AND IS NEVER HIDDEN. It is disabled
   * when no loop is running and enabled the moment one is, driven by the
   * controller's own `stoppable` flag rather than by this view's opinion of what
   * phase it is in. A stop control that is only reachable from somewhere else,
   * or that appears once a loop is already going, is a stop a panicking person
   * cannot find.
   *
   * `observeLiveTarget` re-reads the agents projection at stop time rather than
   * caching a target at start time: the run in flight when someone presses stop
   * is usually not the run that was in flight when they pressed start, and
   * terminating a stale pid is refused by the engine anyway
   * (BRIDGE_TERMINATE_STALE_PID).
   */
  /* Same fence, same reason; see launchControlsBox(). */
  const loopIntervals = new Map()

  function loopControlsBox(agent, { live = false } = {}) {
    if (live !== true) return null
    if (treeStore?.getNode(agent.id)) return nativeBoundedWorkBox(agent, 'loop')
    const dispatchEnabled = isWriteEnabled('dispatch')
    const runOptions = []
    for (let runs = 2; runs <= LOOP_BOUNDS.maxIterations; runs += 1) runOptions.push(runs)
    const minutes = loopIntervals.get(agent.id) || LOOP_BOUNDS.defaultIntervalMs / 60_000
    const intervalOptions = [...new Set([1, 5, 10, 20, 30, 60, 120, 240, minutes])].sort((a, b) => a - b)

    const box = el(`
      <div class="board-box board-loop-box">
        <div class="board-box-h"><span data-loop-icon>${commonCommandIcon('loop', minutes)}</span><span class="bh-t">Loop</span></div>
        <div class="board-cap">run one agent again and again, bounded and stoppable</div>
        <label class="ctl-field"><span class="cl">Agent</span>
          <select class="ctl-select" data-loop="tier" aria-label="Looped agent tier">
            ${DISPATCH_TIERS.map(tier => `<option value="${escapeMarkup(tier.id)}">${escapeMarkup(tier.label)} · ${escapeMarkup(tier.provider)}</option>`).join('')}
          </select>
        </label>
        <label class="ctl-field"><span class="cl">Runs</span>
          <select class="ctl-select" data-loop="runs" aria-label="How many runs">
            ${runOptions.map(runs => `<option value="${runs}"${runs === LOOP_BOUNDS.maxIterations ? ' selected' : ''}>${runs}</option>`).join('')}
          </select>
        </label>
        <label class="ctl-field"><span class="cl">Every</span>
          <select class="ctl-select" data-loop="every" aria-label="Minutes between runs">
            ${intervalOptions.map(value => `<option value="${value}"${value === minutes ? ' selected' : ''}>${value} min</option>`).join('')}
          </select>
        </label>
        <div class="rail-sub" data-loop="bounds">Every run after the first is nested under the first, so the engine's own cap of ${LOOP_BOUNDS.maxFanOut} applies. ${escapeMarkup(LOOP_OVERRUN.sentence)} ${escapeMarkup(LOOP_RUN_CAP.sentence)}</div>
        <div class="rail-sub" data-loop="plan" role="status"></div>
        <div class="ctl-dispatch">
          <button class="ctl-btn" type="button" data-loop="go"${dispatchEnabled ? '' : ' disabled'}>Start loop</button>
          <button class="ctl-btn danger" type="button" data-loop="stop" disabled title="No loop is running.">Stop loop</button>
          <output class="ctl-out" data-loop="out" role="status">${dispatchEnabled ? '' : 'dispatch is off in Settings'}</output>
        </div>
        <div class="team-roster" data-loop="roster"></div>
        <div class="rail-sub" data-loop="honesty">This loop runs while this window is open. It is not durable across a restart, and closing the window ends the schedule — though any run already going is still bounded by its own cap.</div>
      </div>`)

    const tierSelect = box.querySelector('[data-loop="tier"]')
    const runsSelect = box.querySelector('[data-loop="runs"]')
    const everySelect = box.querySelector('[data-loop="every"]')
    const planLine = box.querySelector('[data-loop="plan"]')
    const goButton = box.querySelector('[data-loop="go"]')
    const stopButton = box.querySelector('[data-loop="stop"]')
    const output = box.querySelector('[data-loop="out"]')
    const roster = box.querySelector('[data-loop="roster"]')
    let controller = null

    const currentPlan = () => planLoop({
      tier: tierSelect.value,
      iterations: Number(runsSelect.value),
      intervalMs: Number(everySelect.value) * 60_000,
    })

    const paintPlan = () => {
      const plan = currentPlan()
      const minutes = Math.round(plan.intervalMs / 60_000)
      loopIntervals.set(agent.id, minutes)
      box.querySelector('[data-loop-icon]').innerHTML = commonCommandIcon('loop', minutes)
      notifyNodeStatusListeners()
      planLine.textContent = plan.runnable
        ? `Ready: ${plan.tier} runs up to ${plan.iterations} times, one every ${Math.round(plan.intervalMs / 60_000)} minutes.`
        : plan.problems.join(' ')
      goButton.disabled = !dispatchEnabled || !plan.runnable
      goButton.title = !dispatchEnabled
        ? 'Handing out work is switched off. Turn on “Hand out work to agents” in Settings to use it.'
        : (plan.runnable ? 'Start the loop. The first run starts immediately.' : plan.problems.join(' '))
      return plan
    }

    const paintRuns = state => {
      roster.replaceChildren(...state.runs.map(run => el(`
        <div class="team-row" data-phase="${escapeMarkup(run.phase)}">
          <b>run ${run.index}</b>
          <code>${escapeMarkup(run.phase)}</code>
          <span>${escapeMarkup(run.detail)}</span>
        </div>`)))
    }

    /* Read the agents projection fresh, and hand back only an exactly-shaped
       running target. Anything else is reported by the controller as "nothing
       observed in flight" rather than guessed at. */
    const observeLiveTarget = async identity => {
      const result = await fetchAgents()
      if (!result?.ok) return null
      const rows = Array.isArray(result.data?.data) ? result.data.data : []
      const match = rows.find(row => row?.id === identity && row?.controlTarget)
      return match ? match.controlTarget : null
    }

    for (const control of [tierSelect, runsSelect, everySelect]) control.addEventListener('change', paintPlan)
    paintPlan()

    if (dispatchEnabled) {
      goButton.addEventListener('click', async () => {
        const plan = paintPlan()
        if (!plan.runnable) return
        goButton.disabled = true
        output.textContent = 'checking the audited connection…'
        const status = await prepareBridgeOnce()
        if (!box.isConnected) return
        const rootId = Array.isArray(status?.roots) ? status.roots[0] : null
        if (!status?.ok || !rootId) {
          output.textContent = `unavailable · ${status?.reason || drivenComputerCopy(
            'no workspace folder is recorded for this computer',
            'no workspace folder is recorded for the computer you are driving',
          )}`
          goButton.disabled = false
          return
        }
        const settings = readLaunchSettings()
        controller?.destroy()
        controller = createLoopController({
          plan,
          dispatchBody: {
            rootId,
            objectiveRef: `page2-loop-${String(agent.id).replace(/[^a-z0-9_-]/gi, '-').slice(0, 50)}`,
            brief: `Loop requested from the fleet page, under ${agent.name}.`,
            cap: { kind: 'turns', value: 8, capMs: clampCapMs(settings.capMs) },
          },
          postAction: postBridgeAction,
          observeLiveTarget,
          onState: state => {
            if (!box.isConnected) return
            output.textContent = state.message
            /* The stop follows the controller, not this handler's idea of what
               is happening: it is live exactly while a loop is. */
            stopButton.disabled = !state.stoppable
            stopButton.title = state.stoppable ? 'Stop the loop and terminate the run in flight.' : 'No loop is running.'
            paintRuns(state)
          },
        })
        await controller.start()
        if (!box.isConnected) return
        goButton.disabled = false
        paintPlan()
      })

      stopButton.addEventListener('click', async () => {
        if (!controller) return
        stopButton.disabled = true
        await controller.stop()
        if (!box.isConnected) return
        goButton.disabled = false
        paintPlan()
      })
    }

    return box
  }

  /**
   * THE STANDING GOAL, SHOWN RATHER THAN ONLY SPOKEN.
   *
   * `/goal` (runGoalFor(), below) already sets, reads and clears
   * `session.goal` end to end through shell/agent-host.cjs's
   * setGoal/readGoal/clearGoal -- REPORT-B5-SUB2-loop-goal.md confirmed the
   * whole path works. What that report found missing was not the mechanism,
   * it was a place to SEE it: unlike Loop, whose data-loop="plan" and
   * data-loop="out" never go quiet, a goal set five turns ago is legible
   * only by scrolling the transcript for the sentence that announced it.
   *
   * THIS BOX WRITES NOTHING OF ITS OWN. Clear sends the exact
   * `{ operation: 'clear' }` runGoalFor already sends, and the status line is
   * the SAME sentence /goal's own reply carries -- sessionGoal's
   * goalCurrentSentence, returned by host.readGoal -- never a second copy of
   * that wording composed here. shell/ is CJS and src/ is ESM and share no
   * module, so a renderer that invented its own goal sentences would be free
   * to drift from the six the host already speaks (see runGoalFor's own note
   * on this, below).
   *
   * REFRESHED THROUGH THE SAME BUS EVERY OTHER RAIL STATUS ALREADY USES --
   * registerNodeStatusListener/notifyNodeStatusListeners, the choke point
   * refreshTree() and every turn boundary already flow through -- not a
   * second poll loop that could disagree with the first. Mounted always
   * visible, never behind the Start-work disclosure: a control a person must
   * expand a closed group to see is not a glance, it is the search this box
   * exists to end.
   */
  function goalControlsBox(agent) {
    const goalBridge = typeof window === 'undefined' ? null : window.mcAgent
    const box = el(`
      <div class="board-box board-goal-box">
        <div class="board-box-h"><span data-goal-icon>${commonCommandIcon('goal')}</span><span class="bh-t">Goal</span></div>
        <div class="board-cap">the standing objective this agent works toward on its own</div>
        <div class="rail-sub" data-goal="objective"></div>
        <output class="ctl-out" data-goal="out" role="status"></output>
        <button class="ctl-btn danger" type="button" data-goal="clear" disabled>Clear goal</button>
      </div>`)
    const objectiveLine = box.querySelector('[data-goal="objective"]')
    const output = box.querySelector('[data-goal="out"]')
    const clearButton = box.querySelector('[data-goal="clear"]')

    const store = treeStore
    const savedNode = Boolean(store?.getNode(agent.id))
    const liveSessionId = () => (store?.getNode(agent.id) || (savedNode ? null : agent))?.sessionId || null
    let disposed = false
    let revision = 0
    let accepted = null
    let clearing = null
    /* The shared status bus ticks for every node in the tree. A session the
       host does not hold stays unheld until THIS node changes, so its refusal
       is remembered against the node's session and status and not re-asked on
       each tick: every refused read is a logged handler error in the host. */
    let refused = null
    const nodeStamp = sessionId => `${sessionId}\n${(store?.getNode(agent.id) || agent)?.status || ''}`
    const active = () => !disposed && treeStore === store
      && (typeof window === 'undefined' ? null : window.mcAgent) === goalBridge
    const current = request => active() && request.revision === revision
      && liveSessionId() === request.sessionId
    const valid = (result, sessionId) => result?.sessionId === sessionId
      && typeof result.sentence === 'string' && result.sentence.length > 0
      && (result.goal === null || (result.goal && typeof result.goal.objective === 'string'))
    const paint = (sentence = accepted?.sentence || '') => {
      const goal = accepted?.goal
      objectiveLine.textContent = goal ? goalTitleFromObjective(goal.objective)
        : accepted ? 'No goal set.' : 'Goal status has not been confirmed.'
      output.textContent = sentence
      clearButton.disabled = !goal || clearing?.sessionId === liveSessionId()
    }
    const unconfirmed = operation => {
      const action = operation === 'clear' ? 'the goal was cleared' : 'the current goal'
      paint(`This screen could not confirm ${action}. ${accepted?.goal
        ? 'The last confirmed goal is shown; read it again or retry Clear.'
        : 'Type /goal to read its current state.'}`)
    }

    const refresh = async () => {
      if (!active()) return
      const sessionId = liveSessionId()
      if (accepted?.sessionId !== sessionId) accepted = null
      // The clear response supersedes every read admitted before the click.
      // Status events during that write must not re-enable its button.
      if (clearing?.sessionId === sessionId) return
      const request = { sessionId, revision: ++revision }
      if (!goalBridge || typeof goalBridge.goal !== 'function') { paint(START_NEEDS_APP_TEXT()); return }
      if (!sessionId) { refused = null; paint(goalRefusalSentence('noSession')); return }
      const stamp = nodeStamp(sessionId)
      if (refused === stamp) { paint(goalRefusalSentence('noSession')); return }
      try {
        const result = await goalBridge.goal({ sessionId, operation: 'get' })
        if (!current(request)) return
        if (!valid(result, sessionId)) { unconfirmed('get'); return }
        refused = null
        accepted = result
        paint()
      } catch (error) {
        if (!current(request)) return
        const code = refusalCode(error)
        /* THE HOST'S OWN ENDED-SESSION CODE IS MC_AGENT_SESSION_ENDED --
           ENDED_SESSION_REFUSAL in shell/agent-command-surface.cjs, raised by
           ownedAgentSession before the goal operation is read, for a session
           the host still RETAINS so Stop keeps working. Comparing only
           against the relay's AGENT_SESSION_ENDED left that refusal falling
           through to "could not confirm", unmemoized, and therefore re-asked
           on every tick of the shared status bus -- the same storm the
           unknown-session case was stopped from making.
           TERMINAL_AGENT_SESSION_CODES is the set the rest of this file
           already treats as "this session is over"; the relay's own spelling
           stays beside it because it is not in that host-side set. */
        if (TERMINAL_AGENT_SESSION_CODES.has(code) || code === 'AGENT_SESSION_ENDED') {
          accepted = null
          refused = stamp
          paint(goalRefusalSentence('noSession'))
        } else unconfirmed('get')
      }
    }

    clearButton.addEventListener('click', async () => {
      const sessionId = liveSessionId()
      if (!active() || !sessionId || accepted?.sessionId !== sessionId || !accepted.goal
        || clearing?.sessionId === sessionId || typeof goalBridge?.goal !== 'function') return
      const request = { sessionId, revision: ++revision }
      clearing = request
      paint('Clearing goal…')
      try {
        const result = await goalBridge.goal({ sessionId, operation: 'clear' })
        if (!current(request)) return
        clearing = null
        if (!valid(result, sessionId) || result.goal !== null) { unconfirmed('clear'); return }
        accepted = result
        paint()
        notifyNodeStatusListeners()
      } catch {
        if (!current(request)) return
        clearing = null
        unconfirmed('clear')
      } finally {
        if (clearing === request) clearing = null
      }
    })

    const unsubscribe = registerNodeStatusListener(agent.id, () => { void refresh() })
    /* DISPOSE, THEN BUILD -- the rule railChat states, applied to a
       subscription rather than to a mounted component, and applied HERE rather
       than in clearBoard() because a new box replacing the old one is the one
       moment the previous box is certainly gone from the screen.
       `unsubs` carries ONE entry -- this release, not this box -- so the view
       lifetime still ends the last subscription without collecting a closure
       per render. */
    disposeBoardGoalBox()
    boardGoalUnsub = () => { disposed = true; revision++; unsubscribe() }
    if (!boardGoalReleaseHeld) {
      boardGoalReleaseHeld = true
      unsubs.push(disposeBoardGoalBox)
    }
    void refresh()
    return box
  }

  /**
   * The chatbox the owner asked for, in the rail, for the clicked node.
   *
   * What appears is decided by src/node-chatbox.js, which in turn defers to the
   * person's own chat settings (which agents, and whether runs appear) rather
   * than inventing a second filter that could disagree with the settings page.
   */
  /* `host` and `tall` exist for the example rail: it mounts this same chat
     into the tree rail's chat-tab host, full height, so the example and a
     person's own tree present a conversation through one presentation. The
     projection rail keeps its boxed default. */
  function mountRailChat(agent, role, { host: chatHost = null, tall = false } = {}) {
    const host = chatHost || controlsPage.querySelector('.board-chat-box')
    if (!host) return
    /* A node drawn for a conversation the computer listed opens that
       conversation, live. desktopRowFor() is null off the relay and wherever
       the website does not provide the list, so every other case is unchanged. */
    const desktopRow = desktopRowFor(agent?.sessionId)
    if (desktopRow) {
      railChatUnsub?.()
      railChatUnsub = null
      mountDesktopChat(host, desktopRow, { title: desktopRow.name || agent.name, subtitle: desktopSessionFacts(desktopRow), roleKey: agent.role })
      return
    }
    /* The chat this box built last time. render() runs again whenever the
       person changes a chatbox setting, and the wipe below used to drop a
       mounted buildChat on the floor -- its observers, frames and timers stay
       alive on a detached root. Same rule as railChat: dispose, then wipe. */
    let mounted = null
    const render = () => {
      if (!host.isConnected) return
      /* `live` is the source axis now: real sources plan the live channel,
         mock plans the demonstration one. The `{kind:'simulated', canSend}`
         channel vocabulary inside planNodeChatbox is deliberately untouched —
         node-chatbox and orchestration-controls pin it — so under mock the
         example seat still gets the seeded demonstration chat, badged by the
         page it sits on. railRuns is empty under mock (loadRailRuns is a
         real-source read), so no real run ever lands in this box. */
      const plan = planNodeChatbox({
        agent,
        live: !mockSource(),
        sessionAvailable: false,
        sessionAgentId: null,
        turns: mockSource() ? [{ who: agent.id }] : [],
        runs: railRuns,
        runsSupported: railRunsSupported,
      })
      mounted?.dispose?.()
      mounted = null
      host.innerHTML = ''
      host.dataset.chatChannel = plan.channel.kind
      if (plan.channel.kind === 'simulated' && plan.showContext) {
        mounted = buildChat({
          title: agent.name,
          subtitle: channelCaption(plan.channel, role.label),
          roleKey: agent.role,
          seed: 6,
          tall,
          /* The ONE surface where the composer answering itself is the product:
             a labelled demonstration conversation on the example fleet. Every
             other caller either wires a real sender or gets the switched-off
             composer -- buildChat refuses the canned path without this flag. */
          sampleConversation: true,
        })
        host.appendChild(mounted)
      } else {
        /* THE FORK IS GONE. This used to hand-roll its own <div class="chat
           chat-readonly"> markup -- a second chat frame, built and kept in
           step with buildChat's real one by hand: its own header, its own
           empty log, its own disabled-composer sentence. Same component now,
           same INVARIANT every other call site in this file honours (exactly
           one of onSend / sampleConversation:true / composerReason): a
           channel that cannot send says why, through the one composer-
           disabled path the whole product already uses, rather than a second
           frame nothing else drives. `seed: 0` for the same reason the no-
           session tree config pins it -- an EMPTY history must never fall
           through to buildChat's three canned demonstration bubbles. */
        mounted = buildChat({
          title: agent.name,
          subtitle: channelCaption(plan.channel, role.label),
          roleKey: agent.role,
          tall,
          seed: 0,
          composerReason: plan.composerReason || plan.contextHiddenReason || RAIL_CHAT_COPY.noChannel,
        })
        host.appendChild(mounted)
      }
      const log = host.querySelector('.chat-log')
      if (plan.showRuns && plan.runs.length && log) {
        const runs = el(`<div class="chat-runs"><div class="chat-runs-h">${drivenComputerCopy(
          'Runs on this computer',
          'Runs on the computer you are driving',
        )}</div></div>`)
        for (const run of plan.runs.slice(-6)) {
          runs.appendChild(el(`<div class="chat-run"><b>#${escapeMarkup(String(run.sequence))}</b><span>${escapeMarkup(new Date(run.atMs).toLocaleString())}</span></div>`))
        }
        log.appendChild(runs)
      }
      /* "Everyone here is switched off" is not "nobody is talking", and the
         box must not draw one as the other. The wording and the way out are
         the home screen's own, so both screens describe this one setting
         identically.

         GATED ON showContext. `filteredToNothing` is a fact about the
         SELECTION and stays true when the conversation half is switched off
         entirely — so in "show only runs" this appended a complaint about the
         context filter to a box that was deliberately not showing context, and
         swallowed the runs-only sentence in the branch below. */
      if (plan.contextFilteredToNothing && log) {
        const chosen = COPY.chatboxNoAgentsChosen
        log.appendChild(el(`<div class="chat-empty"><b>${escapeMarkup(chosen.title)}</b><span>${escapeMarkup(chosen.body)}</span><a href="${escapeMarkup(chosen.action.href)}">${escapeMarkup(chosen.action.label)}</a></div>`))
      } else if (plan.emptyReason && !plan.turns.length && !plan.runs.length && log && !log.childElementCount) {
        log.appendChild(el(`<div class="chat-empty"><span>${escapeMarkup(plan.emptyReason)}</span></div>`))
      }
      /* contextHiddenAgents, not hiddenAgents. With the conversation half
         switched off, nobody is being "kept out by your own choice" — the
         whole half is gone, and saying otherwise blames the wrong setting.
         The name now says which of the two questions it answers, so this is a
         field choice rather than a condition someone has to remember to add. */
      if (plan.contextHiddenAgents > 0) {
        host.appendChild(el(`<div class="chat-hidden-note">${escapeMarkup(COPY.chatboxAgentsHeld(plan.contextHiddenAgents))}</div>`))
      }
    }
    host.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape' && event.target.closest?.('.chat-input')) {
        event.stopPropagation()
        event.target.blur()
      }
    })
    render()
    railChatUnsub?.()
    railChatUnsub = onChatboxSettingsChanged(render)
  }

  /* THE RAIL FOR AN AGENT THIS PERSON STARTED FROM THE TREE.
   *
   * WHY IT IS NOT showProjectionControls. That panel describes a FLEET RECORD:
   * it prints a provider, an origin, an internal id, and it mounts the Dispatch,
   * team, loop and cloud controls onto the agent it is given. Every one of those
   * is wrong here — a node this page started an hour ago has no fleet record, no
   * provider on file, and no business offering to dispatch a lane nested under
   * itself — and printing its id would put a key in front of a person, which the
   * tree model's own contract forbids.
   *
   * So this says the things that are true and stops: what it is, what it is
   * doing, why it is not doing it when that is the case, what was asked of it,
   * and what it runs on. The reason sentence is the store's own `statusNote`,
   * which is where the refusal from a failed start was written, so this rail and
   * the panel that reported it cannot drift apart.
   */
  /* WHAT IT RUNS ON. This used to be a statement instead of a menu, because the
   * channel had no tier parameter and a select here would have been the
   * temperature slider again (f1ce3ec) -- a control that moves and changes
   * nothing. The channel now carries `tier` end to end (parseAgentStart ->
   * startSession -> resolveStartTier), and the CHOICE lives where the start
   * lives: the compose panel's model menu, whose value rides in the draft and
   * onto mcAgent.start(). This rail keeps only the fact. Nothing in this box is
   * focusable.
   *
   * AND THE FACT IS NOW ASKED FOR, NOT DECLARED. What stood here was
   * `TREE_ENGINE_LABEL = 'Codex'` and a note reading "Agents you start from
   * this tree run on Codex. You pick the model in the start panel; the Claude
   * choices are listed there and say so when they cannot start yet." Both
   * halves were true when Codex was the only engine in the payload and both
   * are false today, which is what the owner reported. Measured on a staged
   * packaged build with real presses (the post-cut-truth lane, 2026-08-17):
   * the shell answers luna, terra, sol, claude-fable, claude-sonnet,
   * claude-opus; the menu renders "Sonnet · Claude" with NO marker on it; and
   * a Claude agent started from a tree really answered, on a profile carrying
   * a Claude sign-in and no Codex credential at all.
   *
   * So the words come from `startableTierIdList` -- what mc-agent:startable-tiers
   * answered, which is the same resolveStartTier() a press runs -- and a node
   * that already ran says what IT ran on, from the tier recorded on it. Neither
   * can name a provider the shell did not list, and no edit here is needed when
   * the payload changes. The sentences live in src/fleet-tree-copy.js so a
   * guard can walk them; the fourth copy of this same false claim was found
   * only because it was somewhere a test could reach. */
  function treeEngineFace(node) {
    const ran = node?.tier ? tierProviderWord(node.tier) : null
    if (node?.sessionId) {
      return { label: ran || TREE_ENGINE.unrecorded, note: ran ? TREE_ENGINE.ran(ran) : '' }
    }
    /* The fallback's provider words are Codex's, and printing them here on a
       silence is the same false claim the rows used to make -- worse, because
       this row reads as a settled fact about the payload rather than a marker
       on a menu item. */
    if (tierAnswerMissing) return { label: TREE_ENGINE.unknown, note: TREE_ENGINE.unknownNote }
    const installedTiers = startableTierIdList.filter(id => {
      const provider = launchTier(id)?.provider
      return provider === 'local' || providerPresence?.some(row => row?.id === provider && row.installed === 'yes')
    })
    const words = startableProviderWords(installedTiers)
    const presenceUnknown = startableTierIdList.some(id => {
      const provider = launchTier(id)?.provider
      return provider && provider !== 'local' && !providerPresence?.some(row => row?.id === provider && ['yes', 'no'].includes(row.installed))
    })
    if (words.length === 0) return presenceUnknown
      ? { label: TREE_ENGINE.unknown, note: 'Provider installation could not be confirmed on this computer.' }
      : { label: TREE_ENGINE.none, note: TREE_ENGINE.noneNote }
    return { label: words.join(' · '), note: TREE_ENGINE.note(words) }
  }

  function refreshTreeEngineFace() {
    if (!currentRailTreeNode) return
    const label = controlsPage.querySelector('[data-tree-engine-label]')
    const note = controlsPage.querySelector('[data-tree-engine-note]')
    if (!label || !note) return
    const face = treeEngineFace(currentRailTreeNode)
    label.textContent = face.label
    note.textContent = face.note
    note.hidden = !face.note
  }

  function slotUsageSentence(node) {
    const usage = treeSlotUsage(treeStore?.snapshot(), node?.id)
    if (!usage) return ''
    const children = usage.childIds.map(id => treeStore.getNode(id))
    const busy = children.filter(child => nodeBusy(child)).length
    const idle = children.filter(child => sessionNodeIds.has(child.sessionId) && !nodeBusy(child)).length
    const draft = children.filter(child => child.status === 'draft' && !sessionNodeIds.has(child.sessionId)).length
    const stopped = children.length - busy - idle - draft
    const cap = usage.limit == null ? 'limit not reported' : 'of ' + usage.limit
    return 'Direct child slots: ' + usage.total + ' ' + cap + '. '
      + busy + ' busy · ' + idle + ' idle · ' + stopped + ' stopped · ' + draft + ' not started. '
      + (usage.canAdd
        ? (usage.total === 0 ? 'Add an agent under it with ↳+.' : 'Reuse a child’s context or restart its existing slot before adding another.')
        : usage.reason)
  }
  function refreshSlotUsage() {
    const out = controlsPage?.querySelector('[data-direct-slot-usage]')
    if (out && currentRailTreeNode && treeStore) out.textContent = slotUsageSentence(treeStore.getNode(currentRailTreeNode.id))
  }

  function showTreeNodeControls(node) {
    if (authoritativeTreeSnapshot) {
      showAuthoritativeTreeNodeControls(node?.id)
      return
    }
    const draft = railChat?.nodeId === node.id ? railChat.root?.exportDraft?.() : null
    disposeRailSaid()
    clearBoard()
    currentRailTreeNode = node
    const role = ROLES[node.role] || ROLES.default
    const engineFace = treeEngineFace(node)
    const researchTree = treeStore?.getTree(node.treeId)
    const researchProjectId = researchTree?.researchProjectId || null
    paintRoleColor(controlsPage, node.role, node.id)
    disposeRailChat()
    controlsPage.innerHTML = `
      ${railTitleRow({ back: { aria: 'Back to the fleet overview' }, title: mockSource() ? 'Example agent' : 'Agent in your tree' })}
      <!-- THE VSCODE-SHAPED RAIL, round two (owner, iteration 6: "Actions
           again just shouldnt be its own page it should be a button on the
           chat"). Two PERSISTENT bodies toggled by [hidden] — many selectors
           query controlsPage, and swapping innerHTML per tab would orphan the
           mounted chat and strand every live updater; hidden bodies keep both
           working. The verbs live in the chat composer's actions popup; what
           remains here is the conversation and the agent's facts, with its
           setup (folder, place in the tree) at the bottom of Details. -->
      <div class="seg rail-tabs" data-rail-tabs role="group" aria-label="Agent panels">
        <button type="button" class="on" data-rail-tab="chat">Chat</button>
        <button type="button" data-rail-tab="details">Details</button>
      </div>
      <div data-tree-start-controls="${escapeMarkup(node.treeId || '')}" data-tree-queue-only></div>
      <!-- ONE HOST, EVERY STATE. This used to be a chat host for a node with a
           session and a paragraph of prose for one without -- and the prose
           said "Press its circle on the canvas to start it", which is the
           gesture that opens THIS PANEL and starts nothing. A node with no
           session now mounts the same chat, read-only, carrying its own
           refusal where the message box would be (treeChatConfigFor). -->
      <div class="rail-tab-body rail-chat-body" data-rail-body="chat">
        <div class="rail-chat-host" data-rail-chat-host></div>
        <!-- Keep trying accounts and Wait for resets live in the Accounts menu:
             accountRetrySection(). -->
      </div>
      <div class="rail-tab-body rail-scroll" data-rail-body="details" hidden>
        <!-- The head names the agent and its ROLE — never its brief. The brief
             is the person's own sentence: it belongs in prose below, once, and
             it was being printed twice (here in letterspaced capitals, and
             again in its own box) which is most of what "unreadable mess"
             meant. -->
        <div class="agent-head board-head"><span class="role-dot"></span><div><div class="an">${escapeMarkup(treeNodeName(node))}</div><div class="ar">${escapeMarkup(roleLabel(node.role))}</div>${node.researchRestriction ? `<div class="ar" data-research-restriction>${escapeMarkup(researchRestrictionLabel(node.researchRestriction))}</div>` : ''}</div></div>
        <p class="rail-prose" role="status" data-direct-slot-usage>${escapeMarkup(slotUsageSentence(node))}</p>
        <!-- THE FOLDER IS THE FIRST THING UNDER THE NAME, and it used to be a
             four-step scavenger hunt: press Details, scroll past three boxes,
             read "Setup" as the place folders live, then read "Works in" as
             meaning a folder. It was the fifth of nine panels
             (tools/rail-inventory-drive.mjs). Owner, 2026-08-19: "what happened
             to sessions and choosing a folder for each tree and such?"

             EVERY DATA HOOK KEEPS ITS EXACT NAME -- data-tree-profile,
             data-tree-profile-out, data-tree-profile-restart-row,
             data-tree-profile-restart. The handlers below query controlsPage,
             not this box, so they moved without a single rewrite. That is what
             makes this placement change safe rather than a rebuild. -->
        ${researchProjectId ? `<div class="board-box board-ctl-box" data-tree-research>
          <div class="board-box-h"><span class="tree-research-badge" aria-hidden="true">R</span><span class="bh-t">Research project</span></div>
          <div class="rail-prose">${escapeMarkup(researchTree.researchProjectName || researchProjectId)}</div>
        </div>` : ''}
        <div class="board-box board-ctl-box" data-tree-folder${researchProjectId ? ' hidden' : ''}>
          <div class="board-box-h"><span class="bh-t">${escapeMarkup(PROFILE_PANEL.nodeTitle)}</span></div>
          <div class="rail-prose is-dim">${escapeMarkup(PROFILE_PANEL.treeHelp)}</div>
          <div class="ctl-row">
            <select class="ctl-select" data-tree-profile aria-label="${escapeMarkup(PROFILE_PANEL.title)}"></select>
          </div>
          <output class="rail-prose" role="status" data-tree-profile-out></output>
          <div class="ctl-row" data-tree-profile-restart-row hidden>
            <button class="ctl-btn" type="button" data-tree-profile-restart>${escapeMarkup(PROFILE_PANEL.switchGo)}</button>
          </div>
        </div>
        <!-- TWO BOXES, NOT FOUR (iteration 7). Each of the old four carried an
             uppercase header over one word — "finished", "DELTA" — so the tab
             was mostly chrome shouting at its own contents. What it is doing
             now holds the whole run (status, note, narration, usage); the
             conversation holds the brief and the latest answer, which are the
             two halves of one exchange. -->
        <div class="board-box board-ctl-box">
          <div class="board-box-h"><span class="bh-t">What it is doing</span></div>
          <div class="rail-prose" data-tree-status>${escapeMarkup(treeNodeStatusWord(node))}</div>
          <div class="rail-prose is-dim" data-tree-status-note${nodeStartReason(node) || node.statusNote ? '' : ' hidden'}>${escapeMarkup(nodeStartReason(node) || node.statusNote || '')}</div>
          <div class="rail-prose is-dim" data-tree-activity${nodeActivity.get(node.id) ? '' : ' hidden'}>${escapeMarkup(nodeActivity.get(node.id) || '')}</div>
          ${node.sessionId ? `
          <div class="rail-prose is-dim" data-tree-usage${sessionUsage.has(node.sessionId) ? '' : ' hidden'}>${escapeMarkup(sessionUsage.has(node.sessionId) ? usageSentence(sessionUsage.get(node.sessionId)) : '')}</div>` : ''}
        </div>
        <div class="board-box board-ctl-box">
          <div class="board-box-h"><span class="bh-t">The conversation</span></div>
          <!-- The brief is written ONCE at start (no setNodeMessage exists);
               the answer below is overwritten every turn. The sub-labels say
               which is which without a second heading rank. -->
          <div class="rail-sec">What you asked for</div>
          <div class="rail-prose">${escapeMarkup(node.message || '')}</div>
          ${node.sessionId ? `
          <div class="rail-sec">${escapeMarkup(SAID_PANEL.title)}</div>
          <div class="rail-prose rail-said" data-tree-said></div>` : ''}
        </div>
        ${node.sessionId ? `
        <div class="board-box board-ctl-box" data-research-file-box>
          <div class="board-box-h"><span class="bh-t">Research project</span></div>
          <div class="rail-prose is-dim" data-research-filed-line>Reading where this session is filed.</div>
          <div data-research-file-mount></div>
        </div>` : ''}
        <!-- SETUP: what describes the node rather than the conversation. The
             FOLDER used to live here too and now stands on its own above -- see
             the comment on [data-tree-folder]. What is left is the engine this
             agent runs on and where it sits in the tree. -->
        <div class="board-box board-ctl-box" data-tree-move>
          <div class="board-box-h"><span class="bh-t">Setup</span></div>
          <div class="ctl-row"><span class="cl">Engine</span><span class="cv" data-tree-engine-label>${escapeMarkup(engineFace.label)}</span></div>
          <p class="board-absent-copy" data-tree-engine-note${engineFace.note ? '' : ' hidden'}>${escapeMarkup(engineFace.note)}</p>
          <div class="rail-sec">${escapeMarkup(MOVE_PANEL.title)}</div>
          <div class="rail-prose is-dim">${escapeMarkup(MOVE_PANEL.help)}</div>
          <div class="ctl-row" data-tree-move-row hidden>
            <select class="ctl-select" data-tree-move-select aria-label="${escapeMarkup(MOVE_PANEL.title)}"></select>
            <button class="ctl-btn" type="button" data-tree-move-save>${escapeMarkup(MOVE_PANEL.save)}</button>
          </div>
          <output class="rail-prose" role="status" data-tree-move-out></output>
        </div>
        <!-- THE RULES THESE AGENTS ARE ALREADY BEING TOLD, read back. The
             /Request family has been able to WRITE per-tree instructions for
             a while and every start carries them, but nothing could read them
             back: a person filed a rule, got a confirmation, and then had no
             way to see what this circle carries while every agent in it was
             being told at boot. Mounted after the start-work controls
             because it describes what these agents are, not what to do next.
             See mountStandingRequests(). -->
        <div class="board-box board-ctl-box" data-requests-slot>
          <div class="board-box-h"><span class="bh-t">${escapeMarkup(REQUEST_PANEL.title)}</span></div>
          <div data-requests-body><p class="rail-prose is-dim">${escapeMarkup(REQUEST_PANEL.reading)}</p></div>
        </div>
        <!-- Launch, Team, Loop and Codex Cloud. See mountStartWorkControls():
             this is the rail a person actually reaches for an agent they
             started on this computer, and until 2026-08-18 those four controls
             were built only on a rail nothing could open. -->
        <div class="board-start-work-slot"></div>
      </div>`
    if (chatNodeId) controlsPage.querySelector('[data-rail-body="details"]').prepend(agentScreenVoice.el)
    controlsPage.querySelector('.rail-back').addEventListener('click', showStats)
    mountAccountRetryControls(node)
    mountStartWorkControls(
      { id: node.id, name: treeNodeName(node) },
      controlsPage.querySelector('.board-start-work-slot'),
    )
    void mountStandingRequests(node, controlsPage.querySelector('[data-requests-slot]'))
    /* Filing this session under a research project. The projects list was read
       once at mount; a refusal renders as its sentence, never as an empty
       select. The session reference is the OBSERVED id — the one identity a
       tree node always has once a session is attached. */
    const fileMount = controlsPage.querySelector('[data-research-file-mount]')
    if (fileMount && node.sessionId) {
      const filedLine = controlsPage.querySelector('[data-research-filed-line]')
      const projects = researchService?.ok ? researchService.projects : []
      const projectName = id => projects.find(project => project.projectId === id)?.name || id
      const renderFiledLine = () => {
        const filed = researchAssignments.projectsOfSession('observed', node.sessionId)
        if (filedLine) {
          filedLine.textContent = filed.length === 0
            ? 'Not filed under a research project.'
            : `Filed under: ${filed.map(projectName).join(', ')}.`
        }
      }
      renderFiledLine()
      fileMount.appendChild(createAssignmentControl({
        projects,
        unavailableReason: researchService && !researchService.ok ? researchService.reason : (researchService ? null : 'the projects have not been read yet'),
        currentProjectIds: researchAssignments.projectsOfSession('observed', node.sessionId),
        onAssign: async projectId => {
          const result = await researchAssignments.assign(projectId, 'observed', node.sessionId)
          renderFiledLine()
          return result
        },
      }))
    }
    /* The tabs toggle [hidden] on persistent bodies — see the markup       comment for why nothing is ever re-rendered on a tab press. */
    const railTabs = controlsPage.querySelector('[data-rail-tabs]')
    railTabs?.addEventListener('click', (event) => {
      const pressed = event.target.closest('[data-rail-tab]')
      if (!pressed) return
      for (const button of railTabs.querySelectorAll('[data-rail-tab]')) {
        button.classList.toggle('on', button === pressed)
      }
      for (const body of controlsPage.querySelectorAll('[data-rail-body]')) {
        body.hidden = body.dataset.railBody !== pressed.dataset.railTab
      }
      if (pressed.dataset.railTab === 'details') refreshStandingRequests()
    })
    /* The Chat tab's mount: the same config the compact card uses, tall, over
       the FULL transcript (D9's mechanism — the rail no longer pairs the
       first ask with the latest reply; the whole conversation is here). The
       send wraps the shared handlers so a turn that STREAMED into an open
       bubble closes that bubble instead of printing the reply twice. */
    const chatHost = controlsPage.querySelector('[data-rail-chat-host]')
    if (chatHost) {
      const config = treeChatConfigFor(node)
      if (config) {
        /* The send wrapper exists only for a config that CAN send: a node with
           no session carries composerReason instead, and wrapping an absent
           onSend would put a function where buildChat reads "this chat can
           reach the agent". */
        /* THE CHAT THIS WRAPPER BELONGS TO, CAPTURED, NOT LOOKED UP.
         *
         * The wrapper used to read the live `railChat` variable, and that
         * variable is reassigned every time the rail is rebuilt onto another
         * node. A reply arriving after a rebuild therefore closed a DIFFERENT
         * node's bubble with this node's words, and this node's own handler was
         * never called -- one message merged into another conversation and one
         * vanished (owner, 2026-08-18). The object is built first and compared
         * by identity, so a stale wrapper answers its own chat or nothing. */
        const mine = { sessionId: node.sessionId, nodeId: node.id, root: null, stream: null }
        const chat = buildChat({
          ...config,
          tall: true,
          ...(typeof config.onSend === 'function' ? {
            onSend: (text, handlers) => config.onSend(text, {
              /* FORWARD WHAT WE DID NOT COME HERE TO CHANGE. This wrapper
                 exists to steer `reply` into the rail's own stream, and it
                 used to rebuild the handlers object from scratch -- which
                 silently dropped `attachments` the moment the composer began
                 carrying them, because a picked file no longer goes anywhere
                 else on its way to the send. Spreading first means a handler
                 added upstream arrives here without this line being edited
                 again. */
              ...handlers,
              reply: (said) => {
                if (railChat === mine && mine.stream) {
                  mine.stream.close(said)
                  mine.stream = null
                } else {
                  handlers.reply(said)
                }
              },
              fail: handlers.fail,
            }),
          } : {}),
        })
        mine.root = chat
        mine.releaseDraft = treeChatDrafts.mount(treeStoreId, node.id, chat)
        chatHost.appendChild(chat)
        if (chatNodeId) chat.importDraft?.(chatDraft?.read())
        railChat = mine
        // The rail owns its stream separately from broadcastChatSpeech. Seed
        // that stream now: registration deliberately skips the rail, and a
        // turn doing tools may not send another word for several minutes.
        const liveText = sessionTurnText.get(mine.sessionId)
        const liveTurn = sessionOpenTurns.get(mine.sessionId) || null
        if (liveText || liveTurn) {
          const entryId = standaloneSettledTurns.get(mine.sessionId)?.id
            || (nativeReconcileSessions.has(mine.sessionId) && liveTurn
              ? `agent:${mine.sessionId}:${liveTurn}` : null)
          mine.stream = chat.openStream({ at: Date.now(), turnStamp: liveTurn, entryId })
          if (liveText) mine.stream.push(liveText)
        }
        if (draft) chat.importDraft?.(draft)
        const savedConversation = mountTranscriptHistory({ host: chatHost, store: transcriptStore, nodeId: node.id, chat })
        /* The line that says older messages are kept elsewhere carries the
           door to them (T1404). */
        const olderNote = chat.querySelector('.chat-log [data-chat-keep-in-search]')
        if (olderNote && savedConversation?.toggleSavedConversation) {
          const door = document.createElement('button')
          door.type = 'button'
          door.className = 'chat-older-door'
          door.textContent = TRANSCRIPT_OLDER_DOOR
          door.addEventListener('click', () => {
            if (!savedConversation.isSavedConversationOpen?.()) savedConversation.toggleSavedConversation()
          })
          olderNote.appendChild(door)
        }
      }
    }
    /* THE KEYBOARD HALF OF "quickly connect nodes and change hierarchies".
       Edit-mode drag exists and stays; this menu is the accessible, refusable
       path. It is built from movePoints(), so it can only offer moves the
       store will accept — and the snapshot is RE-READ when Save is pressed,
       because a menu built at open time can go stale while it stands. */
    /* The tree's profile select: options are the main process's own list,
       plus the product workspace as the stated default. A change writes the
       TREE (setTreeProfile) and speaks; it applies to agents started after,
       which the help line says out loud. */
    const profileSelect = controlsPage.querySelector('[data-tree-profile]')
    const profileOut = controlsPage.querySelector('[data-tree-profile-out]')
    if (profileSelect && treeStore && node.treeId && !researchProjectId) {
      /* The example lists no folders of yours: they are this computer's, and
         the example is nobody's. */
      const bridgeForProfiles = typeof window === 'undefined' || mockSource() ? null : window.mcAgent
      const current = treeStore.treeProfile(node.treeId)
      const baseOption = document.createElement('option')
      baseOption.value = ''
      baseOption.setAttribute('data-tree-default-profile', '')
      baseOption.textContent = treeDefaultFolderLabel()
      profileSelect.appendChild(baseOption)
      if (bridgeForProfiles && typeof bridgeForProfiles.profiles === 'function') {
        void bridgeForProfiles.profiles().then(answer => {
          replaceProfileCwds(answer)
          if (!answer || answer.ok !== true || !Array.isArray(answer.profiles)) return
          for (const profile of answer.profiles) {
            const option = document.createElement('option')
            option.value = profile.id
            option.textContent = profile.name
            if (profile.id === current) option.selected = true
            profileSelect.appendChild(option)
          }
          /* AND IF THE FOLDER IT IS SET TO IS NOT ONE OF THEM, SAY SO RATHER
             THAN SHOWING THE DEFAULT. With no option matching, nothing was
             marked selected and the first row stood -- the product's own
             workspace -- so the menu reported a folder the record does not
             hold and a start would not use. The row carries the tree's real
             value so leaving it alone changes nothing, and the line says what
             it means. See treeFolderMenuChoice() for why the rule is a
             function. */
          const menuChoice = treeFolderMenuChoice({ current, folders: answer.profiles })
          if (menuChoice.missing) {
            const gone = document.createElement('option')
            gone.value = menuChoice.selectedId
            gone.setAttribute('data-tree-missing-profile', '')
            gone.textContent = PROFILE_PANEL.missingFolderOption
            gone.selected = true
            profileSelect.appendChild(gone)
            if (profileOut) profileOut.textContent = PROFILE_PANEL.missingFolder
          }
        }).catch(() => { replaceProfileCwds(null) })
      }
      profileSelect.addEventListener('change', () => {
        const chosen = profileSelect.value || null
        const saved = treeStore.setTreeProfile(node.treeId, chosen)
        if (!saved.ok) { profileOut.textContent = saved.problems[0] || PROFILE_PANEL.refused; return }
        const label = profileSelect.selectedOptions[0]?.textContent || ''
        /* WHERE THIS CHOICE ACTUALLY LANDS, named once so the refusal below and
           the assignment beneath it cannot drift apart. */
        const landing = chosen ? label : composeDefaultFolder
        /* A WRITE THE DISK REFUSED IS NOT AN ASSIGNMENT, and this menu is the
           one folder path that had no way to find out. The compose panel's
           new-tree write is covered downstream -- startDraftNode() reads
           snapshot().persistenceFailed and says TREE_NOT_SAVED_TEXT -- but a
           person changing the folder of a tree that ALREADY EXISTS never
           reaches that code, so a refused save was reported here as success and
           the next launch put every agent in the tree back in the old folder.
           The store hands the answer back on the object it already returns;
           nothing new had to be plumbed. */
        if (saved.snapshot?.persistenceFailed) {
          profileOut.textContent = landing ? PROFILE_PANEL.notSaved(landing) : PROFILE_PANEL.notSavedCleared
          return
        }
        profileOut.textContent = landing ? PROFILE_PANEL.assigned(landing) : PROFILE_PANEL.cleared
        /* The assignment touched the TREE; this node's live session still
           runs where it started. Moving it now is a warned restart the
           person presses, never a side effect of picking from a menu.
           NOT REACHED FROM THE BRANCH ABOVE, which returns: spending a person's
           tokens to restart an agent into a folder the next launch will not
           remember is the expensive way to arrive at the same wrong place. */
        const restartRow = controlsPage.querySelector('[data-tree-profile-restart-row]')
        if (restartRow && node.sessionId) {
          profileOut.textContent += ` ${PROFILE_PANEL.switchOffer}`
          restartRow.hidden = false
        }
      })
      controlsPage.querySelector('[data-tree-profile-restart]')?.addEventListener('click', () => {
        /* A restart is a real start; an example agent never gets one. */
        if (mockSource()) { profileOut.textContent = exampleBoardText(); return }
        void resumeNodeSession(treeStore ? treeStore.getNode(node.id) || node : node, { out: profileOut })
      })
    }
    const moveRow = controlsPage.querySelector('[data-tree-move-row]')
    const moveSelect = controlsPage.querySelector('[data-tree-move-select]')
    const moveSave = controlsPage.querySelector('[data-tree-move-save]')
    const moveOut = controlsPage.querySelector('[data-tree-move-out]')
    if (moveRow && moveSelect && moveSave && moveOut && treeStore) {
      let menuSignature = null
      refreshRailMoveChoices = () => {
        const points = treeStore.movePoints(node.id)
        const parents = points.map(point => treeStore.getNode(point.parentId)).filter(Boolean)
        /* EVERY CHOICE SAYS WHICH TREE IT IS IN (T1467). Names already carry
           an id suffix when another tree has the same role, so a duplicate-name
           test never fired and a person chose between "Controller (d3f68efd)"
           and "Controller (9bbcabf8)". Like the Add to tree picker, a parent in
           another tree names that tree; one in this circle's own tree says so. */
        const ownTreeId = treeStore.getNode(node.id)?.treeId ?? node.treeId
        const choices = parents.map(parent => {
          const name = treeNodeName(parent)
          const where = parent.treeId === ownTreeId ? 'this tree' : treeStore.treeLabel(parent.treeId)
          return { id: parent.id, label: `${name} — ${where}` }
        })
        const signature = JSON.stringify(choices)
        if (signature === menuSignature) return
        menuSignature = signature
        const previous = moveSelect.value
        const retained = choices.some(choice => choice.id === previous)
        // Keep the select itself mounted: keyboard focus and a still-legal
        // unsaved choice belong to the person, even when other agents move.
        moveSelect.replaceChildren()
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = MOVE_PANEL.prompt
        moveSelect.appendChild(placeholder)
        for (const choice of choices) {
          const option = document.createElement('option')
          option.value = choice.id
          option.textContent = choice.label
          moveSelect.appendChild(option)
        }
        moveSelect.value = retained ? previous : ''
        moveRow.removeAttribute('hidden')
        if (previous && !retained) {
          moveOut.textContent = 'That parent is no longer available for this agent. Pick another parent.'
        } else if (!choices.length) {
          moveOut.textContent = MOVE_PANEL.empty
        } else if (moveOut.textContent === MOVE_PANEL.empty) {
          moveOut.textContent = ''
        }
      }
      refreshRailMoveChoices()
      moveSave.addEventListener('click', () => {
        /* THE SAME TRUTH THE DRAG READS, asked before anything else. Under
           mock, mountGraph nulls onReparent so a drag can never restructure
           the example — and this Save is the same write through a different
           door, so it refuses with the same sentence the Edit button states.
           Asked before the pick-a-parent check on purpose: telling a person
           to pick a parent first, on a tree that is not theirs to rearrange,
           is an invitation to an action that can only refuse. */
        if (mockSource()) {
          moveOut.textContent = EXAMPLE_REARRANGE_TEXT
          return
        }
        const parentId = moveSelect.value
        if (!parentId) {
          moveOut.textContent = MOVE_PANEL.needChoice
          return
        }
        const stillLegal = treeStore.movePoints(node.id).some(point => point.parentId === parentId)
        const moved = stillLegal
          ? treeStore.moveNode(node.id, parentId)
          : { ok: false, problems: [MOVE_PANEL.staleChoice] }
        if (!moved.ok) {
          moveOut.textContent = moved.problems[0] || MOVE_PANEL.notSaved
          return
        }
        /* The rail is rebuilt around the moved node so every box tells the
           new truth; the saved sentence lands in the fresh rail's output. */
        const parentName = treeNodeName(treeStore.getNode(parentId))
        showTreeNodeControls(treeStore.getNode(node.id))
        controlsPage.querySelector('[data-rail-tab="details"]')?.click()
        const freshOut = controlsPage.querySelector('[data-tree-move-out]')
        if (freshOut) {
          freshOut.textContent = MOVE_PANEL.saved(treeNodeName(moved.node), parentName)
          freshOut.setAttribute('tabindex', '-1')
          freshOut.focus?.({ preventScroll: true })
          freshOut.scrollIntoView?.({ block: 'nearest' })
        }
        void syncSavedTreeMove(node.id)
      })
    }
    /* THE SAID BOX IS FILLED HERE, NOT IN THE TEMPLATE, because it has three
       truthful states and two of them are alive: a finished reply (rendered
       once), a mid-turn stream (the appender, seeded with everything the turn
       has said so far -- a person opening the rail late must not miss the
       first half of the answer), and the waiting line for a session that has
       not spoken yet. */
    const saidHost = controlsPage.querySelector('[data-tree-said]')
    if (saidHost) {
      const reply = nodeReplies.get(node.id)
      /* nodeBusy, not the saved status: a stale node opened a stream appender
         and sat under "no answer yet" for a turn that ended at the last
         shutdown. */
      const live = nodeBusy(node)
      if (reply) {
        paintSaidReply(saidHost, reply)
      } else if (live) {
        const waitingLine = document.createElement('span')
        waitingLine.className = 'projection-unavailable'
        waitingLine.textContent = SAID_PANEL.waiting
        saidHost.appendChild(waitingLine)
        const appender = createChatMarkdownStream({
          node: saidHost,
          scheduleFrame,
          cancelFrame,
        })
        railSaid = { nodeId: node.id, appender, waitingLine, host: saidHost }
        const spokenSoFar = sessionTurnText.get(node.sessionId) || ''
        if (spokenSoFar) {
          waitingLine.remove()
          railSaid.waitingLine = null
          appender.push(spokenSoFar)
        }
      } else if (nodeSessionEnded(node)) {
        /* "No answer yet" is a promise that one is coming. For a node whose
           session died with the app there is no turn left to wait for, so this
           says what happened and what to do instead. Through paintSaidReply
           like every other branch above -- ENDED_SESSION.said is plain
           English with nothing markdown-shaped in it today, but it is also
           the exact tail turnCompletionWords concatenates onto a REAL spoken
           reply elsewhere (see `said` in the completion handlers below), so
           one path for all of it is one fewer state to keep consistent, not
           a second rendering rule to maintain. */
        paintSaidReply(saidHost, ENDED_SESSION.said)
      } else {
        /* Plain textContent, deliberately not paintSaidReply: SAID_PANEL.waiting
           is a placeholder for a turn that has not happened yet, never an
           agent's own words, so there is nothing here for a block renderer
           to find. */
        saidHost.textContent = SAID_PANEL.waiting
      }
    }
    /* THE QUESTION THAT ARRIVED WHILE THIS RAIL WAS CLOSED. Without this the
       Approve button existed only for a person already looking at the node the
       moment approval_request fired -- see sessionPendingApprovals. */
    const pendingApproval = sessionPendingApprovals.get(node.sessionId)
    if (pendingApproval) renderApprovalCard(node.sessionId, pendingApproval)
    refreshTreeStartControls()
    activateRail(controlsPage)
  }

  /* A STATUS LANDING REPAINTS THE WORDS THAT CHANGED, NEVER THE WHOLE RAIL.
   *
   * THE DEFECT, measured twice on a live drive, 2026-08-18: a settling
   * session's status re-called showTreeNodeControls, and that is an innerHTML
   * rebuild -- it disposes the mounted chat, and buildChat's dispose closes an
   * open actions popup. A person typing in the popup's filter lost the menu
   * and their word mid-keystroke every time a turn ended or a queued message
   * drained. The palette driver reopens and counts; a person just loses it.
   *
   * WHAT THOSE CALLERS ACTUALLY NEEDED, read from the rebuild they reached
   * for. The re-calls predate iteration 6 (3887c93): the rail then rendered
   * status and queue as static markup, so a rebuild was the only repaint.
   * Today the composer's send-stop face and the queue strip subscribe through
   * the chat config -- notifyNodeStatusListeners and SESSION_OUTBOX_EVENT --
   * the canvas chip repaints through scheduleChipRefresh, and the popup's rows
   * are rebuilt from the store at every open. What does NOT repaint itself is
   * the static half of the Details tab: the status word, its note, the
   * activity line, and the settled reply in the said box. So this updates
   * exactly those hosts, in place, and the chat -- popup, filter text, cursor
   * and all -- is never torn down by a status. */
  function repaintRailStatus(node) {
    currentRailTreeNode = node
    const statusHost = controlsPage.querySelector('[data-tree-status]')
    if (statusHost) statusHost.textContent = treeNodeStatusWord(node)
    const noteHost = controlsPage.querySelector('[data-tree-status-note]')
    if (noteHost) {
      const reason = nodeStartReason(node) || node.statusNote || ''
      noteHost.textContent = reason
      noteHost.hidden = !reason
    }
    const activityHost = controlsPage.querySelector('[data-tree-activity]')
    if (activityHost) {
      const line = nodeActivity.get(node.id) || ''
      activityHost.textContent = line
      activityHost.hidden = !line
    }
    /* The said box is repainted only when it is settled: a live railSaid is
       mid-write into this host and owns it until the completion flushes it. */
    if (!railSaid) {
      const saidHost = controlsPage.querySelector('[data-tree-said]')
      const reply = nodeReplies.get(node.id)
      if (saidHost && reply) paintSaidReply(saidHost, reply)
    }
  }

  /* A SESSION LANDING ON THE NODE THE RAIL IS ALREADY SHOWING REBINDS IT.
   *
   * THE DEFECT, traced 2026-09-04 while answering "one agent sometimes cannot
   * spawn another". Press a circle, then open its rail while the asynchronous
   * start is still completing. showTreeNodeControls builds the whole panel
   * from the node as it stands at that instant -- sessionId null -- so
   * treeChatConfigFor takes its session-less branch: a READ-ONLY chat carrying
   * composerReason, with no onSend and no onReady, therefore no
   * registerChatSurface; and the mount records `railChat.sessionId = null`.
   *
   * When the start lands, startDraftNode's onSessionOpen attaches the real
   * session, marks the node running and refreshes the canvas -- and nothing
   * remounted that rail. The panel in front of the person stayed bound to a
   * session that does not exist. The agent's reply arrives, is appended to the
   * transcript and persisted, and every door on its way to the open chat
   * misses it: `railChat.sessionId === sessionId` is false at the delta stream
   * and at the turn completion, chatSurfaces holds nothing under the new id,
   * and the composer is still the disabled one -- so the person cannot send
   * the follow-up that asks the agent to spawn a worker without leaving the
   * node and coming back.
   *
   * WHO CALLS THIS, stated so the claim is checkable rather than flattering,
   * and pinned by tools/test/tree-rail-rebind.test.mjs, which walks forward
   * from every attachSession in this file and refuses to let control reach a
   * return without passing one of these: startDraftNode's onSessionOpen, its
   * ended-session branch and its refused-after-start branch; the resume that
   * returns false before the tail below can run; and runTreeNodeCommand's
   * restart, where the attach happens inside src/fresh-start-existing-node.js
   * and this view answers for it. The first round of this fix claimed "every
   * place a start attaches a session" while pinning only the three inside
   * startDraftNode; the two it missed are the last two in that list.
   *
   * THE ONE LANDING SITE THAT IS DELIBERATELY NOT ROUTED THROUGH HERE is the
   * SUCCESSFUL resume's tail (see the end of resumeNodeSessionUnguarded). It
   * rebuilds for a different reason -- it has just replaced the conversation
   * the panel is showing (resumedTranscriptLines) -- and it must still rebuild
   * in the one case this decision refuses, a resume that adopts the very
   * session id the rail is already mounted on.
   *
   * THE REBUILD IS BOUNDED, and that bound is the other half of the rule. A
   * remount disposes the mounted chat, and buildChat's dispose closes an open
   * actions popup with the person's filter text in it -- the 2026-08-18 defect
   * repaintRailStatus was extracted to end. So railRebindDecision refuses a
   * rail that is already mounted on this session, a rail showing another node,
   * a rail that is not on screen, and a node the store no longer holds. */
  function rebindRailToSession(nodeId) {
    refreshWorkspaceChats(nodeId)
    if (!treeStore) return false
    /* THE STORE'S RECORD, NEVER THE CALLER'S. The node object a start closed
       over is the stale one -- it is the record with no session in it that
       built the dead panel in the first place. */
    const fresh = treeStore.getNode(nodeId)
    const decision = railRebindDecision({
      railActive: controlsPage.classList.contains('is-active'),
      railNodeId: currentRailTreeNode ? currentRailTreeNode.id : null,
      /* What the MOUNTED CHAT was built for, which is the only honest record
         of what the panel in front of the person can reach. */
      railSessionId: railChat ? railChat.sessionId : null,
      node: fresh,
    })
    if (!decision.rebind) return false
    /* AND IT WAITS IF THE PERSON IS TYPING. Every one of this function's
       callers lands asynchronously -- a start that resolved, a start that was
       refused after it began, a session that ended, a restart's
       fresh-start-existing-node -- so a person looking at this same circle can
       be mid-word in its composer or its actions filter when the landing
       fires. showTreeNodeControls below is an innerHTML rebuild: it disposes
       the mounted chat and closes an open actions popup, taking the field and
       the half-typed words with it. The owner reported it as the surface
       itself going away: "sometimes i am typing and then my typing surface
       disappears or gets clicked out of".
       deferRailRebuildWhileTyping already answered this for the successful
       resume's tail, the ONE landing that was routed through it; the other
       five reached showTreeNodeControls directly. Routing the rebuild here
       rather than at each call site covers all of them at once and keeps the
       forward walk in tools/test/tree-rail-rebind.test.mjs intact, since every
       landing still reaches rebindRailToSession() before any return.
       THE DECISION IS RE-READ WHEN THE DEFERRED REBUILD ACTUALLY RUNS, not
       carried over from the moment it was deferred. A blur can be seconds
       later, and by then the rail may have been pointed at another circle, the
       node may be gone from the store, or the rail may already be mounted on
       the session this rebuild was going to bind -- and rebuilding on a stale
       yes is the same innerHTML swap arriving late, which is the defect
       wearing a different hat. */
    deferRailRebuildWhileTyping(() => {
      if (destroyed || !treeStore) return
      const later = treeStore.getNode(nodeId)
      const decisionNow = railRebindDecision({
        railActive: controlsPage.classList.contains('is-active'),
        railNodeId: currentRailTreeNode ? currentRailTreeNode.id : null,
        railSessionId: railChat ? railChat.sessionId : null,
        node: later,
      })
      if (!decisionNow.rebind) return
      showTreeNodeControls(later)
    })
    return true
  }

  /* THE RAIL FOLLOWS THE CANVAS ACROSS A TREE SWITCH.
   *
   * THE DEFECT, measured on a live drive, 2026-08-18: switch trees and the
   * rail keeps showing the PREVIOUS tree's chat until another circle is
   * pressed. onRootChange repainted the crumb and the switcher and never
   * consulted what the rail was showing, so the two halves of the page told
   * two different stories about which tree the person was in.
   *
   * WHICH TREE IS ON THE CANVAS: the graph's root is a node id, and that
   * node's own record names its tree. A null root is "Every tree" -- every
   * tree is on the canvas, so whatever the rail shows is still there and it
   * stays. A re-root INSIDE the rail's own tree (a drill, a crumb press)
   * keeps the rail too. Only when the rooted node belongs to a different
   * tree -- or to no tree this store knows, which is what a fleet agent's
   * subtree answers -- does the rail return to the overview, the conservative
   * reading: the node it was showing cannot be on that canvas, and pressing
   * its circle again reopens it whole.
   *
   * NOTHING HERE TOUCHES THE CONVERSATION. The chat stays mounted under the
   * now-hidden page exactly as an ordinary Back press leaves it; transcripts,
   * the turn accumulator and the open stream belong to the session layer and
   * are neither read nor written on this path. tools/chat-history-drive.mjs
   * scenarios E and F hold that shut, and
   * tools/test/rail-follows-canvas.test.mjs refuses any such reference in
   * this function's body. */
  function railFollowsCanvas(rootId) {
    if (!rootId || !currentRailTreeNode || !treeStore) return
    if (!controlsPage.classList.contains('is-active')) return
    const canvasTree = graph?.ancestryOf(rootId).map(item => treeStore.getNode(item.id)?.treeId).find(Boolean) ?? null
    const shown = treeStore.getNode(currentRailTreeNode.id)
    const shownTree = shown?.treeId ?? currentRailTreeNode.treeId ?? null
    if (canvasTree !== null && shownTree !== null && canvasTree === shownTree) return
    showStats()
  }

  /* THE REWIND, AS A NAMED FUNCTION. Its rail select retired with the
     Actions tab (iteration 6); the chat popup's rewind stage is the caller
     now. The body is the old handler's, unchanged: engine rewind first,
     then every screen follows the shortened memory. */
  async function performRewind(node, turnId, out) {
    if (!turnId || !node.sessionId) return false
    if (nodeBusy(node)) { if (out) out.textContent = REWIND_PANEL.busy; return false }
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!bridge || typeof bridge.rewind !== 'function') return false
    let done = null
    let refusal = null
    try { done = await bridge.rewind({ sessionId: node.sessionId, turnId }) } catch (error) { refusal = error; done = null }
    if (!done || done.turnId !== turnId) {
      /* THE REASON RIDES TO THE PERSON. This catch used to drop the error, so a
         Claude session -- whose engine cannot fork and therefore can never
         rewind (CLAUDE_CLI_FORK_UNSUPPORTED) -- drew "Try once more", forever.
         A permanent refusal says what is true and names the door that works. */
      const words = /CLAUDE_CLI_FORK_UNSUPPORTED/.test(String(refusal?.message || '')) ? REWIND_PANEL.cannotFork : REWIND_PANEL.failed
      if (out) out.textContent = words
      return false
    }
    /* THE SESSION KEEPS ITS THREAD ID CURRENT, THE SAME MAP EVERY OTHER PATH
       DOES. shell/agent-host.cjs rewindSession() forks the engine's thread at
       the picked turn and moves the session onto the fork -- "only its
       threadId moves" -- and hands the new id back as `done.threadId`. Until
       here nothing ever recorded it: persistTranscript() below reads
       sessionThreadIds to decide what to save, so the durable record kept
       naming the PRE-rewind thread. A person who later pressed Resume (in
       this window or the next one) had the engine `--resume` that old
       thread -- which still holds every turn Rewind had just erased -- and
       got their forgotten memory back in silence, directly contradicting the
       "I remember ... and nothing after it" line this same function shows
       them below. Set BEFORE persistTranscript, which is the only reader. */
    sessionThreadIds.set(node.sessionId, done.threadId)
    /* The agent's memory now ends at that turn; every screen follows it.
       The transcript restarts from one truthful line, the kept turn log
       truncates to the turns that still exist, and the stored reply goes
       — it may postdate the point the person just erased. */
    const log = sessionTurnLog.get(node.sessionId) || []
    const keptIndex = log.findIndex(entry => entry.turnId === turnId)
    sessionTurnLog.set(node.sessionId, keptIndex >= 0 ? log.slice(0, keptIndex + 1) : [])
    const kept = keptIndex >= 0 ? log[keptIndex] : null
    sessionTranscripts.set(node.sessionId, [{
      who: 'agent',
      text: kept ? `Rewound. I remember everything up to “${kept.yourText.slice(0, 80)}” and nothing after it.` : REWIND_PANEL.done,
      at: Date.now(),
    }])
    /* The durable excerpt follows the erasure — a resume must not replay
       words the person just made the agent forget. */
    persistTranscript(node.sessionId)
    resetSessionMetrics(node.sessionId)
    nodeReplies.delete(node.id)
    nodeActivity.delete(node.id)
    nodeLastTool.delete(node.id)
    nodeThinking.delete(node.id)
    if (treeStore) {
      treeStore.setNodeReply(node.id, '')
      treeStore.setNodeStatus(node.id, 'finished', { note: statusNote(REWIND_PANEL.done) })
      refreshTree()
    }
    // Rewind keeps the session ID but replaces its history. The shelf's usual
    // session rebind cannot detect that change; refresh it from the accepted
    // fork while its draft/attachments remain owned by the same conversation.
    graph?.refreshConversation?.(node.id)
    if (out) out.textContent = REWIND_PANEL.done
    refreshWorkspaceChats(node.id, true)
    showTreeNodeControls(treeStore ? treeStore.getNode(node.id) || node : node)
    return true
  }

  /* An outcome reporter that survives the popup. The restart verbs (depth,
     resume, start over) rebuild the rail, which disposes the chat and its
     popup mid-flight — so their sentences land on the canvas status line,
     the reporter that outlives every rail rebuild. */
  function statusSink(node = null) {
    return {
      get textContent() { return '' },
      set textContent(value) {
        const sentence = String(value || '')
        if (!sentence) return
        const state = sentence === RESUME_PANEL.done || sentence === PALETTE_PANEL.cleared ? 'ok' : 'refuse'
        setOrgStatus(sentence, state, { sticky: state === 'refuse' })
        if (node) setWorkspaceStatus(node.id, sentence, state)
      },
    }
  }

  /* Focus one of the Details tab's setup controls from anywhere. */
  function focusDetailsControl(node, selector) {
    showWorkspaceControls()
    const current = treeStore ? treeStore.getNode(node.id) || node : node
    if (!railChat?.root || currentRailTreeNode?.id !== current.id
      || currentRailTreeNode?.sessionId !== current.sessionId) showTreeNodeControls(current)
    else activateRail(controlsPage)
    controlsPage.querySelector('[data-rail-tab="details"]')?.click()
    controlsPage.querySelector(selector)?.focus?.()
  }

  function openLoopFor(node, minutes = null) {
    if (mockSource()) return { ok: false, sentence: PALETTE_PANEL.loopExample }
    showWorkspaceControls()
    if (currentRailTreeNode?.id !== node.id || !controlsPage.querySelector('.board-loop-box')) {
      showTreeNodeControls(treeStore?.getNode(node.id) || node)
    }
    activateRail(controlsPage)
    controlsPage.querySelector('[data-rail-tab="details"]')?.click()
    const toggle = controlsPage.querySelector('[data-start-work-toggle]')
    if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
    const box = controlsPage.querySelector('.board-loop-box')
    const interval = box?.querySelector('[data-loop="every"]')
    if (!interval) return { ok: false, sentence: PALETTE_PANEL.loopUnavailable }
    if (minutes !== null) {
      if (![...interval.options].some(option => Number(option.value) === minutes)) {
        const option = document.createElement('option')
        option.value = String(minutes)
        option.textContent = `${minutes} min`
        interval.appendChild(option)
      }
      interval.value = String(minutes)
      interval.dispatchEvent(new Event('change', { bubbles: true }))
    }
    box.scrollIntoView({ block: 'nearest' })
    interval.focus({ preventScroll: true })
    return { ok: true, sentence: PALETTE_PANEL.loopOpened }
  }

  function commonChatActionsFor(node) {
    const current = treeStore?.getNode(node.id) || node
    /* THE CLOUD SWARM IS A CODEX CLOUD FEATURE, so the action only belongs on an
       agent that can actually run one. /cloud launches a Codex Cloud swarm
       (shell/cloud-command.mjs) through the cloud.task_* tools; a Claude, local, or
       other-provider agent has no codex cloud swarm to run, so offering it there is
       a dead affordance (owner: the swarm action "should only be present for when
       cloud codex is used"). Gate on this node's provider exactly the way effort and
       the model rows already do -- launchTier(tier).provider === 'codex' -- and HIDE
       the row rather than show a permanently disabled one. Goal and loop stay common
       to every agent. */
    const codexCloudCapable = launchTier(current.tier)?.provider === 'codex'
    return [
      ...(codexCloudCapable ? [cloudCommandAction({ enabled: Boolean(current.sessionId) && !nodeCleanupPending(current) && !mockSource(),
        disabledHint: PALETTE_PANEL.whyNotStarted })] : []),
      { id: 'goal', group: PALETTE_PANEL.groupCommon, label: PALETTE_PANEL.goal,
        icon: 'goal', hint: PALETTE_PANEL.goalHint,
        enabled: Boolean(current.sessionId) && !nodeCleanupPending(current), disabledHint: PALETTE_PANEL.whyNotStarted,
        run: ctx => ctx.compose('/goal ', PALETTE_PANEL.goalHint) },
      /* A loop hands work to a running session, like /goal: an agent that has
         never started has none, and its loop setup could only say "press Start
         loop" beside a Start loop that cannot be pressed (T1351). */
      { id: 'loop', group: PALETTE_PANEL.groupCommon, label: PALETTE_PANEL.loop,
        icon: 'loop', minutes: loopIntervals.get(current.id) || LOOP_BOUNDS.defaultIntervalMs / 60_000,
        hint: PALETTE_PANEL.loopHint, enabled: !mockSource() && Boolean(current.sessionId) && !nodeCleanupPending(current),
        disabledHint: mockSource() ? PALETTE_PANEL.loopExample : PALETTE_PANEL.whyNotStarted,
        run: ctx => { ctx.close(); const result = openLoopFor(treeStore?.getNode(node.id) || node); setOrgStatus(result.sentence, result.ok ? 'ok' : 'refuse') } },
    ]
  }

  /* THE CHAT'S ACTION ROWS — the palette model, re-homed (owner, iteration
     6: "Actions again just shouldnt be its own page it should be a button
     on the chat"). Same honest rules as the page it replaces: every row is
     something this build really performs on this node today, enabled states
     derive from the node. Composer actions use their originating chat;
     lifecycle verbs still use runPaletteAction. Depth, model and rewind are two-stage picks inside the popup
     (ctx.show); the warned-restart contract for depth is unchanged — the
     token-cost sentence stands between the pick and the restart. */
  function unstartedTreeNodeRetryState(current) {
    return {
      hasSavedConversation: Boolean(transcriptStore?.has(current?.id)),
      cleanupPending: current ? nodeCleanupPending(current) : true,
      busy: current ? startingNodeIds.has(current.id) || startDraftFlight.busy(current.id)
        || nodeReplacementFlight.busy(current.id) || recoveryCoordinator()?.isRecovering(current.id) : true,
    }
  }
  async function retryUnstartedTreeNode(node, { start = startDraftNode, requireStartControl = true, isCurrent = () => true } = {}) {
    const store = treeStore
    const eligible = current => canRetryUnstartedNode(current, unstartedTreeNodeRetryState(current))
    const result = await executeRetryUnstartedNode({ nodeId: node.id, treeStore: store,
      isEligible: eligible,
      canStart: () => !destroyed && treeStore === store && isCurrent() && !mockSource() && (!requireStartControl || isWriteEnabled(START_CONTROL_FLAG)),
      refreshAuthority: async () => (await refreshOrg())?.state === 'ready',
      startDraftNode: start,
    })
    if (!destroyed) {
      refreshTree()
      if (!result?.ok) setOrgStatus(result?.message || 'This agent could not retry its start.', 'refuse', { sticky: true, code: result?.code })
    }
    return result
  }

  const detachedCleanupFlights = new Set()
  async function cleanEarlierSession(node, sessionId, out) {
    const store = treeStore
    const current = store?.getNode(node.id)
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (destroyed || !current || current.createdAt !== node.createdAt
      || current.sessionId === sessionId || RUN_SESSION_CLEANUPS.get(sessionId) !== node.id
      || (sessionNodeIds.has(sessionId) && sessionNodeIds.get(sessionId) !== node.id)
      || detachedCleanupFlights.has(sessionId) || typeof bridge?.close !== 'function') {
      out.textContent = 'This earlier session cleanup is no longer available here.'
      return false
    }
    const obligation = RUN_SESSION_CLEANUP_OBLIGATIONS.get(sessionId)
    const createdAt = current.createdAt
    detachedCleanupFlights.add(sessionId)
    try {
      let closed = null
      try { closed = await bridge.close({ sessionId }) } catch { /* unknown retains obligation */ }
      if (closed?.closed !== true || closed?.ok === false || closed?.sessionId !== sessionId) {
        out.textContent = 'The earlier session cleanup is not confirmed. Its cleanup action remains available.'
        return false
      }
      const sameObligation = RUN_SESSION_CLEANUP_OBLIGATIONS.get(sessionId) === obligation
      const latest = store.getNode(node.id)
      const sameIncarnation = latest?.createdAt === createdAt
      // Confirmation settles the captured obligation even after the node moves.
      // A re-registered obligation or recreated node keeps its own runtime state.
      if (sameObligation && RUN_SESSION_CLEANUPS.get(sessionId) === node.id) RUN_SESSION_CLEANUPS.delete(sessionId)
      if (sameObligation && sameIncarnation && sessionNodeIds.get(sessionId) === node.id
        && latest.sessionId !== sessionId) retireTreeSessionRuntime(sessionId)
      if (!destroyed && treeStore === store && sameIncarnation) {
        notifyNodeStatusListeners()
        out.textContent = 'The earlier session cleanup is confirmed.'
      }
      return true
    } finally { detachedCleanupFlights.delete(sessionId) }
  }

  function chatActionRowsFor(node) {
    const paletteRow = ({ enabled, disabledHint = null, ...row }) => {
      const state = controlState({ enabled: Boolean(enabled), why: disabledHint })
      return { ...row, enabled: state.enabled, disabledHint: state.why }
    }
    const fresh = () => (treeStore ? treeStore.getNode(node.id) || node : node)
    /* The ↳+ button hides when this agent has no free child slot; the menu row
       that opens the same start panel follows the same admission (T1377). */
    const childSlot = treeStore?.childSlot?.(node.id) || null
    const current = fresh()
    const running = nodeBusy(current)
    const liveSession = nodeSessionLive(current)
    const cleanupPending = nodeCleanupPending(current)
    const reply = nodeReplies.get(current.id) || current.reply || ''
    const sinkFor = ctx => ({
      get textContent() { return '' },
      set textContent(value) { ctx.say(String(value || '')) },
    })
    const currentEffort = () => savedSessionEffort({ sessionEffort: sessionEfforts.get(fresh().sessionId),
      savedEffort: transcriptStore?.get(node.id)?.effort, nodeEffort: fresh().effort, tierEffort: tierEffortOf(fresh().tier) })
    /* THE DEPTHS ARE THE PROVIDER'S, AND SO ARE THEIR WORDS (owner: "there
       are STANDARD per provider effort names. Use those"). The engine's
       model/list reports what THIS model really supports, each with the
       provider's own description — ultra's is "Maximum reasoning with
       automatic task delegation", which is a different agent, not a bigger
       number. The hand-written table is the fallback for an engine too old
       to answer, and it now carries the provider's names too. */
    const effortRows = () => {
      const catalog = engineEffortsFor(fresh())
      const choices = catalog.length > 0 ? catalog : EFFORT_CHOICES.map(choice => ({ id: choice.id, description: choice.description }))
      return choices.map(choice => ({
        id: `effort-${choice.id}`,
        label: choice.id,
        hint: choice.id === currentEffort() ? `${choice.description || ''} · running at this now`.trim() : (choice.description || null),
        current: choice.id === currentEffort(),
        enabled: true,
        run: async ctx => {
          if (nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id)) { ctx.say('This agent is already starting a replacement session.'); return }
          if (choice.id === currentEffort()) { ctx.say(EFFORT_SWITCH.keep); return }
          const live = fresh()
          const bridgeNow = typeof window === 'undefined' ? null : window.mcAgent
          if (!sessionNodeIds.has(live.sessionId)) {
            const saved = saveStoppedSessionEffort({ nodeId: live.id, effort: choice.id, transcriptStore, treeStore })
            ctx.say(saved
              ? `The next session will use ${choice.id} effort.` : 'The next session settings could not be saved.')
            notifyNodeStatusListeners()
            return
          }
          /* THE ENGINE'S OWN KNOB FIRST: a running thread changes depth in
             place — nothing restarts, nothing is re-sent, nothing is
             charged. The restart below is the fallback for a build whose
             engine cannot do it, and only THERE does the token warning
             belong. */
          if (live.sessionId && nodeBusy(live) === false && bridgeNow && typeof bridgeNow.setEffort === 'function') {
            try {
              const changed = await bridgeNow.setEffort({ sessionId: live.sessionId, effort: choice.id })
              if (changed && changed.effort) {
                sessionEfforts.set(live.sessionId, changed.effort)
                /* THE EFFORT CHIP HEARS THIS THROUGH THE SAME LISTENER THE
                   composer's busy/step already use -- see chips.subscribe in
                   treeChatConfigFor. */
                notifyNodeStatusListeners()
                ctx.say(EFFORT_SWITCH.changed(changed.effort))
                return
              }
            } catch { /* falls through to the honest restart below */ }
          }
          ctx.show([{
            id: 'effort-go',
            label: EFFORT_SWITCH.go,
            hint: EFFORT_SWITCH.warn,
            enabled: true,
            run: goCtx => {
              goCtx.close()
              void resumeNodeSession(fresh(), { effort: choice.id, out: statusSink(node) })
            },
          }], { title: choice.id })
        },
      }))
    }
    const openPermissionSettings = ctx => {
      const store = treeStore
      const bridge = typeof window === 'undefined' ? null : window.mcSetup
      const isCurrent = () => !destroyed && treeStore === store && Boolean(store?.getNode(node.id))
        && (typeof window === 'undefined' ? null : window.mcSetup) === bridge
      const blockingReason = () => mockSource() || currentDataSource() !== 'local'
        ? 'Permission settings can be changed only on this computer’s local view.' : ''
      return createPermissionTierMenu({ bridge, isCurrent, blockingReason }).open(ctx)
    }
    const openProviderModes = ctx => {
      const store = treeStore
      const sessionId = fresh().sessionId || null
      const bridge = typeof window === 'undefined' ? null : window.mcAgent
      const isCurrent = () => !destroyed && treeStore === store
        && Boolean(store?.getNode(node.id)) && (store.getNode(node.id).sessionId || null) === sessionId
        && (typeof window === 'undefined' ? null : window.mcAgent) === bridge
      const blockingReason = () => {
        const live = store?.getNode(node.id)
        if (!isCurrent()) return 'This session changed. Reopen provider modes.'
        if (mockSource() || currentDataSource() !== 'local') return 'Provider modes require a local live session.'
        if (nodeCleanupPending(live)) return startCleanupSentence()
        if (nodeBusy(live) || startingNodeIds.has(live.id) || startDraftFlight.busy(live.id)
          || nodeReplacementFlight.busy(live.id) || recoveryCoordinator()?.isRecovering(live.id)) {
          return 'Wait for the current turn, start or recovery before changing provider mode.'
        }
        return ''
      }
      let menu
      const subscribe = listener => {
        const entry = { listener, isCurrent, dispose: () => menu.dispose() }
        providerModeListeners.add(entry)
        return () => providerModeListeners.delete(entry)
      }
      menu = createProviderModeMenu({ sessionId, bridge, isCurrent, blockingReason, subscribe })
      return menu.open(ctx)
    }
    const modelRows = () => {
      if (!sessionNodeIds.has(fresh().sessionId)) {
        const capturedStore = treeStore
        const capturedNode = fresh()
        const capturedSessionId = capturedNode.sessionId || null
        const preferenceBlocked = () => {
          const live = capturedStore?.getNode(capturedNode.id)
          if (destroyed || treeStore !== capturedStore || !live
              || (live.sessionId || null) !== capturedSessionId || sessionNodeIds.has(live.sessionId)) {
            return 'This agent changed. Reopen the model menu for its current session.'
          }
          if (nodeCleanupPending(live)) return startCleanupSentence()
          if (startingNodeIds.has(live.id) || startDraftFlight.busy(live.id)
              || nodeReplacementFlight.busy(live.id) || recoveryCoordinator()?.isRecovering(live.id)) {
            return 'This agent is already starting or recovering. Wait for that operation to finish.'
          }
          return ''
        }
        // A restored agent edits its next-session preference here. Keep every
        // provider visible and recheck launch availability when a row is pressed.
        const rowLabel = tier => `${tier.label} · ${tierProviderWord(tier.id)}`
        const unavailable = tier => {
          if (tier.id === fresh().tier) return ''
          const startable = startableTierAnswered && Array.isArray(startableTierIdList)
            ? startableTierIdList.includes(tier.id) : tier.provider !== 'local'
          if (!startable) return `This copy has not reported that it can start ${rowLabel(tier)}, so it cannot be saved as the next model.`
          /* The start panel's own rule: a program this computer reports as not
             installed is not a model a draft can be set to start on (T1530). */
          return Array.isArray(noProgramProviders) && noProgramProviders.includes(tier.provider)
            ? `${tierProviderWord(tier.id)} is not installed on this computer, so ${rowLabel(tier)} cannot be saved as the next model.`
            : ''
        }
        return LAUNCH_TIERS.map(tier => ({
          id: `next-model-${tier.id}`, label: rowLabel(tier),
          hint: 'Use this model when this agent starts its next session.',
          current: fresh().tier === tier.id,
          enabled: !preferenceBlocked() && !unavailable(tier),
          disabledHint: preferenceBlocked() || unavailable(tier),
          run: ctx => {
            const blocked = preferenceBlocked() || unavailable(tier)
            if (blocked) { ctx.say(blocked); return }
            const saved = treeStore.setNodeLaunchPreferences(node.id, { tier: tier.id })
            ctx.say(saved?.ok && !saved.snapshot?.persistenceFailed
              ? `The next session will use ${rowLabel(tier)}.` : 'The next session settings could not be saved.')
            notifyNodeStatusListeners()
          },
        }))
      }
      const override = sessionModelOverride.get(fresh().sessionId) || ''
      const keepRow = {
        id: 'model-keep',
        label: MODEL_PANEL.keep,
        hint: MODEL_PANEL.currentDefault,
        current: !override,
        enabled: true,
        run: ctx => {
          cancelPendingModelChoice(node.id)
          sessionModelOverride.delete(fresh().sessionId)
          /* THE MODEL CHIP HEARS THIS THROUGH THE SAME LISTENER THE COMPOSER'S
             busy/step already use -- see chips.subscribe in treeChatConfigFor. */
          notifyNodeStatusListeners()
          ctx.say(MODEL_PANEL.currentDefault)
        },
      }
      /* THE ROWS ARE ASKED FOR, NOT BUILT HERE. What stood here was a label
         hardcoding `Claude — cannot start here yet` and `enabled:
         tier.provider === 'codex'`. The label was false about this product
         (the shell's startableTiers() names all three Claude tiers on a
         payload carrying the engine) and it answered a question these rows do
         not ask — they set a per-turn override, they start nothing. The rule
         and its words now live in src/fleet-tree-copy.js sessionModelChoices(),
         where the suite drives them, and it gates on THIS conversation's
         provider rather than on a provider's name. */
      /* OWNER REQUEST T137 (2026-09-16 02:58Z): "switch models still doesnt
         work. and it should work for even different providers because we can
         just hand the context to the next agent." A row the running thread
         cannot take in place -- every Claude model, every other provider -- is
         no longer a refusal: it continues this conversation in a fresh session
         on that tier, from the same handoff "Continue on another account"
         sends, and the agent keeps its name, place, reports and saved
         conversation. The gates are the account continuation's: local data,
         not mid-turn, no cleanup owed, no replacement in flight, starting on. */
      const modelBridge = typeof window === 'undefined' ? null : window.mcAgent
      const continueBlocked = currentDataSource() !== 'local' ? MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY
        : nodeCleanupPending(fresh()) ? startCleanupSentence()
            : typeof modelBridge?.start !== 'function' ? START_NEEDS_APP_TEXT()
              : !isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason()
                : (nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id))
                  ? 'This agent is already starting a replacement session.' : ''
      /* THE SHELL'S OWN ANSWER, HANDED TO THE ROWS (owner request R1238).
         sessionModelChoices() used to decide which tiers could be continued to
         from a provider name it held itself, and the last of those names --
         `tier.provider !== 'local'` -- kept the local node out of this menu on
         a payload that ships its runner. It now takes the same reading the
         tree's own tier rows already use, from the same two variables
         startableTierChoices is built from, so this menu and the + New agent
         menu cannot disagree about what this copy can start. `answered` rides
         with it because "the shell said no" and "the shell never spoke" are
         different facts and only the first is a claim about the build. */
      const pending = pendingModelChoice(fresh())
      const cancelRows = pending ? [{
        id: 'model-cancel-pending', label: 'Cancel pending model change',
        hint: 'Keep the current model and all waiting messages.', enabled: true,
        run: ctx => { cancelPendingModelChoice(node.id); ctx.say('The pending model change was cancelled.') },
      }] : []
      return [keepRow, ...cancelRows, ...sessionModelChoices(fresh().tier, { startable: startableTierIdList, answered: startableTierAnswered }).map(choice => choice.continuation ? {
        id: `continue-model-${choice.id}`,
        label: MODEL_PANEL.continueOn(choice.label),
        hint: choice.continuationHint,
        current: false,
        enabled: !continueBlocked,
        disabledHint: continueBlocked,
        run: async ctx => {
          if (nodeBusy(fresh()) || pendingModelChoice(fresh())?.applying) {
            const sink = { textContent: '' }
            queueModelChoice(fresh(), choice.id, sink, (live, isCurrent, beginContinuation) =>
              continueNodeOnAnotherModel(live, choice.id, statusSink(live), { isCurrent, beginContinuation }))
            ctx.say(sink.textContent)
          } else { ctx.close(); await continueNodeOnAnotherModel(fresh(), choice.id, statusSink(node)) }
        },
      } : {
        id: `model-${choice.model}`,
        label: choice.label,
        hint: null,
        current: override === choice.model,
        enabled: choice.enabled,
        disabledHint: choice.disabledHint,
        run: ctx => {
          if (nodeBusy(fresh()) || pendingModelChoice(fresh())?.applying) {
            const sink = { textContent: '' }
            queueModelChoice(fresh(), choice.id, sink, (live, isCurrent) => {
              if (!isCurrent()) return false
              sessionModelOverride.set(live.sessionId, choice.model)
              notifyNodeStatusListeners()
              return true
            }, { drainAfter: true })
            ctx.say(sink.textContent)
          } else {
            cancelPendingModelChoice(node.id)
            sessionModelOverride.set(fresh().sessionId, choice.model)
            notifyNodeStatusListeners()
            ctx.say(MODEL_PANEL.next(choice.model))
          }
        },
      })]
    }
    const rewindRows = () => (sessionTurnLog.get(fresh().sessionId) || []).map(entry => ({
      id: `rewind-${entry.turnId}`,
      label: entry.yourText.slice(0, 80),
      hint: null,
      enabled: true,
      run: ctx => {
        ctx.show([{
          id: 'rewind-go',
          label: REWIND_PANEL.button,
          hint: REWIND_PANEL.help,
          enabled: true,
          run: goCtx => {
            goCtx.close()
            void performRewind(fresh(), entry.turnId, statusSink(node))
          },
        }], { title: `“${entry.yourText.slice(0, 60)}”` })
      },
    }))
    /* THE REMOVE CONFIRM — the same sub-stage device as rewind's picker: one
       Remove row plus the popup's own Back, with the sentence naming what
       goes (and that the signed run records stay) carried on the row where a
       hint is read and spoken. The popup is closed BEFORE the removal runs,
       because the removal disposes the chat under it. */
    const removeRows = () => {
      const store = treeStore, selected = fresh()
      const plan = planNodeRemoval(store, selected.id, { blocked: nodeRemovalBlock })
      return [{
        id: 'remove-go',
        label: plan.count > 1 ? `Remove ${plan.count} agents` : REMOVE_PANEL.go,
        hint: plan.count > 1 ? branchRemovalConfirmation(treeNodeName(selected), plan.count) : REMOVE_PANEL.confirm(treeNodeName(selected)),
        enabled: plan.ok && !nodeBranchRemovalFlight.busy(selected.id),
        disabledHint: nodeBranchRemovalFlight.busy(selected.id) ? 'This branch is already being removed.' : plan.problems[0] || '',
        run: goCtx => {
          goCtx.close()
          void performNodeBranchRemoval(plan, store, treeNodeName(selected))
        },
      }]
    }
    /* THE TABLE, GROUPED, EVERY ROW SAYING WHY WHEN IT CANNOT BE PRESSED.
     *
     * The owner's report on this menu: "more like vscode, much more intuitive
     * preferably". Three things were wrong with the list itself, and each is
     * a field on the row now.
     *
     * `group`: eleven rows of mixed severity in source order put "Stop this
     * agent" directly beside "Copy what it said". Three headings, and the one
     * that ends or forgets something is last, on its own.
     *
     * `disabledHint`: a switched-off row rendered its ordinary hint (or
     * nothing) and would not say why it could not be pressed. Every row that
     * can be disabled now carries the sentence for its own state; the popup
     * shows it in place of the hint and speaks it on Enter.
     *
     * THREE DOORS THAT WERE MISSING. Attach an image, mention a file and queue
     * a message are all things this build genuinely does -- their runners were
     * already in runPaletteAction, reachable from the slash commands and the
     * composer's own buttons -- and the menu simply never built the rows. They
     * are rows now. Nothing here adds a power; it adds the way to reach one.
     *
     * A picker needs the installed application, so attach and mention are
     * enabled only where the bridge really offers one, and say so where it does
     * not, rather than sitting enabled over a call that returns nothing. */
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const canAttach = typeof bridge?.pickAttachment === 'function'
    const canMention = typeof bridge?.pickMention === 'function'
    const canInterrupt = typeof bridge?.interrupt === 'function'
    const canStop = typeof bridge?.close === 'function'
    const canRewind = typeof bridge?.rewind === 'function'
    const canStartSession = typeof bridge?.start === 'function'
    const canSetEffort = typeof bridge?.setEffort === 'function'
    const started = Boolean(current.sessionId) && !cleanupPending
    const actionBridgeWhy = START_NEEDS_APP_TEXT()
    const turnsSoFar = (sessionTurnLog.get(current.sessionId) || []).length
    /* Measured 2026-08-18: after a restart the Rewind row said "You have not
       sent it a message yet." beside a panel showing four sent messages.
       turnsSoFar is window memory and resets with the window; the durable
       transcript does not. So the row consults the record before calling the
       conversation empty: rewind still reaches only turns sent since this
       window opened (performRewind needs the live session's turn log), but the
       REASON tells the truth about the saved messages. */
    const savedConversation = transcriptStore ? transcriptStore.get(node.id) : null
    const sentEarlier = Boolean(savedConversation && Array.isArray(savedConversation.lines)
      && savedConversation.lines.some(line => line && line.who === 'you'))
    // The person's removal preview covers the complete branch. Running or
    // starting descendants block it before any leaf is touched.
    const removalPreview = planNodeRemoval(treeStore, current.id, { blocked: nodeRemovalBlock })
    const conversation = PALETTE_PANEL.groupConversation
    const agent = PALETTE_PANEL.groupAgent
    const danger = PALETTE_PANEL.groupDanger
    return [
      ...commonChatActionsFor(node),
      { id: 'queue', group: conversation, label: PALETTE_PANEL.queueFocus, hint: PALETTE_PANEL.queueFocusHint, enabled: started, disabledHint: PALETTE_PANEL.whyNotStarted, run: ctx => { ctx.close(); ctx.composer.focus() } },
      { id: 'attach', group: conversation, label: PALETTE_PANEL.attach, hint: PALETTE_PANEL.attachHint, enabled: started && canAttach, disabledHint: !started ? PALETTE_PANEL.whyNotStarted : PALETTE_PANEL.whyNoPicker, run: async ctx => { ctx.say(await ctx.composer.attach() ? PALETTE_PANEL.attachPicked : PALETTE_PANEL.attachCancelled) } },
      { id: 'mention', group: conversation, label: PALETTE_PANEL.mention, hint: PALETTE_PANEL.mentionHint, enabled: started && canMention, disabledHint: !started ? PALETTE_PANEL.whyNotStarted : PALETTE_PANEL.whyNoPicker, run: async ctx => { if (await ctx.composer.mention()) ctx.close(); else ctx.say(PALETTE_PANEL.mentionCancelled) } },
      { id: 'effort', group: conversation, label: EFFORT_SWITCH.title, hint: EFFORT_SWITCH.help, enabled: started && (canSetEffort || (canStartSession && isWriteEnabled(START_CONTROL_FLAG))), disabledHint: !started ? PALETTE_PANEL.whyNotStarted : (!canSetEffort && !isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason() : actionBridgeWhy), run: ctx => ctx.show(effortRows, { title: EFFORT_SWITCH.title }) },
      { id: 'permission-settings', group: conversation, label: 'Permission settings', hint: 'Read and change saved permissions for future starts and resumes on this computer.', enabled: true, run: openPermissionSettings },
      { id: 'provider-mode', group: conversation, label: 'Provider mode', hint: 'Read and change modes advertised by this provider session.', enabled: true, run: openProviderModes },
      { id: 'model', group: conversation, label: PALETTE_PANEL.switchModel, hint: PALETTE_PANEL.switchModelHint, enabled: true, disabledHint: null, run: ctx => ctx.show(modelRows, { title: MODEL_PANEL.title }) },
      { id: 'rewind', group: conversation, label: PALETTE_PANEL.rewind, hint: PALETTE_PANEL.rewindHint, enabled: started && turnsSoFar > 0 && canRewind, disabledHint: !started ? PALETTE_PANEL.whyNotStarted : (!canRewind ? actionBridgeWhy : (sentEarlier ? PALETTE_PANEL.whyOnlySavedTurns : PALETTE_PANEL.whyNoTurns)), run: ctx => ctx.show(rewindRows(), { title: REWIND_PANEL.title }) },
      { id: 'copy-brief', group: conversation, label: PALETTE_PANEL.copyBrief, hint: '', enabled: Boolean(current.message), disabledHint: PALETTE_PANEL.whyNoBrief, run: ctx => runPaletteAction('copy-brief', fresh(), sinkFor(ctx)) },
      { id: 'copy-reply', group: conversation, label: PALETTE_PANEL.copyReply, hint: '', enabled: Boolean(reply), disabledHint: PALETTE_PANEL.whyNoReply, run: ctx => runPaletteAction('copy-reply', fresh(), sinkFor(ctx)) },
      ...(current.status === 'failed' && !current.sessionId ? [{ id: 'retry-start', group: agent,
        label: 'Retry starting this agent', hint: 'Keep its saved task, role, model and place in the tree.',
        enabled: canRetryUnstartedNode(current, { hasSavedConversation: Boolean(savedConversation), cleanupPending,
          busy: running || startingNodeIds.has(current.id) || startDraftFlight.busy(current.id) || nodeReplacementFlight.busy(current.id) || recoveryCoordinator()?.isRecovering(current.id) })
          && canStartSession && !mockSource() && isWriteEnabled(START_CONTROL_FLAG),
        disabledHint: cleanupPending ? startCleanupSentence() : savedConversation ? 'Use Resume with a fresh agent for the saved conversation.'
          : !isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason() : !canStartSession ? actionBridgeWhy
            : mockSource() ? exampleBoardText() : 'This agent is already starting or recovering. Wait for that operation to finish.',
        run: async ctx => { ctx.close(); await retryUnstartedTreeNode(fresh()) },
      }] : []),
      ...(recoveryCoordinator()?.canRetry(current.id) ? [{ id: 'retry-account-recovery', group: agent,
        label: 'Retry on another account', hint: 'Continue from the saved recovery handoff.',
        enabled: !running && isWriteEnabled(START_CONTROL_FLAG),
        disabledHint: running ? RESUME_PANEL.busy : startControlOffReason(),
        run: async ctx => { ctx.close(); await recoveryCoordinator().retry(current.id) },
      }] : []),
      ...(savedConversation?.account ? [{ id: 'continue-another-account', group: agent,
        label: 'Continue on another account',
        hint: 'Start a fresh session from the saved handoff. Keep this agent, its reports, conversation, and queued messages.',
        enabled: currentDataSource() === 'local' && !running && !cleanupPending && !nodeReplacementFlight.busy(current.id)
          && !recoveryCoordinator()?.isRecovering(current.id) && canStartSession && isWriteEnabled(START_CONTROL_FLAG),
        disabledHint: currentDataSource() !== 'local' ? MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY : running ? 'Wait for this agent to finish its turn.' : startControlOffReason(),
        run: async ctx => { ctx.close(); await continueNodeOnAnotherAccount(fresh(), statusSink(node)) },
      }] : []),
      /* SWITCH AND CONTINUE (owner T381): the one dialog for account, model and
         depth, reachable here at any time and opened by the app when the saved
         account is refused. Same gates as Resume: a saved conversation, no
         turn in flight, starts allowed. */
      /* PRESENT EVEN WHEN IT CANNOT ACT (owner request R1238, 2026-09-19: "why
         does the button hide now it needs to work"). This row was spread in
         behind `savedConversation`, so on a circle with nothing saved yet it was
         not refused -- it was ABSENT. An absent control reads as a product that
         does not have the feature, which is exactly what the owner read off it.
         Every ordinary row in this palette is present and carries a
         `disabledHint` saying why; this one now follows that rule, and borrows
         Resume's existing sentence for the state the two share rather than
         inventing a second wording for one fact.

         WHAT IT MAY DO IS UNCHANGED. The saved-conversation requirement moved
         out of the spread and into `enabled`, so the gates are the same set they
         always were; only the visibility of the refusal changed. */
      { id: 'switch-continue', group: agent, label: SWITCH_PANEL.action, hint: SWITCH_PANEL.hint,
        enabled: Boolean(savedConversation) && currentDataSource() === 'local' && !cleanupPending
          && (Boolean(pendingModelChoice(current)) || (!nodeReplacementFlight.busy(current.id) && !recoveryCoordinator()?.isRecovering(current.id)))
          && canStartSession && isWriteEnabled(START_CONTROL_FLAG),
        disabledHint: !savedConversation ? PALETTE_PANEL.whyNoSaved : currentDataSource() !== 'local' ? MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY : cleanupPending ? startCleanupSentence() : !isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason() : actionBridgeWhy,
        run: async ctx => { ctx.close(); await offerSwitchAndContinue(fresh(), { refusedAccount: null }) },
      },
      { id: 'child', group: agent, label: PALETTE_PANEL.child, hint: PALETTE_PANEL.childHint, enabled: childSlot ? childSlot.canAdd : true,
        ...(childSlot && !childSlot.canAdd ? { disabledHint: childSlot.reason } : {}),
        run: ctx => { ctx.close(); openComposeFor({ kind: 'child', parentId: node.id }) } },
      { id: 'move', group: agent, label: PALETTE_PANEL.moveFocus, hint: PALETTE_PANEL.moveFocusHint, enabled: true, run: ctx => { ctx.close(); focusDetailsControl(node, '[data-tree-move-select]') } },
      /* Enabled exactly when it can act: a saved conversation exists and no
         session is mid-turn over it. A running agent is resumed by talking
         to it, not by restarting it out from under itself. */
      { id: 'resume', group: agent, label: RESUME_PANEL.action, hint: RESUME_PANEL.hint, enabled: !running && !cleanupPending && Boolean(transcriptStore && transcriptStore.has(node.id)) && canStartSession && isWriteEnabled(START_CONTROL_FLAG), disabledHint: cleanupPending ? startCleanupSentence() : (running ? RESUME_PANEL.busy : (!transcriptStore || !transcriptStore.has(node.id) ? PALETTE_PANEL.whyNoSaved : (!isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason() : actionBridgeWhy))), run: ctx => { ctx.close(); void resumeNodeSession(fresh(), { out: statusSink(node) }) } },
      // The shared Stop runner returns a structured result. The popup's result
      // is the sentence already written through ctx.say, not that object.
      { id: 'interrupt', group: danger, label: PALETTE_PANEL.interrupt, hint: PALETTE_PANEL.interruptHint, enabled: running && canInterrupt, disabledHint: !running ? PALETTE_PANEL.whyNotRunning : actionBridgeWhy, run: async ctx => { await runPaletteAction('interrupt', fresh(), sinkFor(ctx)) } },
      ...[...RUN_SESSION_CLEANUPS].filter(([sessionId, nodeId]) => nodeId === current.id && sessionId !== current.sessionId)
        .map(([sessionId], index) => ({ id: 'cleanup-earlier-' + sessionId, group: danger,
          label: 'Clean up earlier session' + (index ? ' ' + (index + 1) : ''),
          hint: 'Closes only the earlier incomplete replacement. Keeps the current session and queued messages.',
          enabled: canStop && !detachedCleanupFlights.has(sessionId), disabledHint: actionBridgeWhy,
          run: ctx => cleanEarlierSession(current, sessionId, sinkFor(ctx)) })),
      { id: 'stop', group: danger, label: PALETTE_PANEL.stop, hint: PALETTE_PANEL.stopHint, enabled: (liveSession || cleanupPending || recoveryCoordinator()?.retryPolicy(current.id)?.enabled) && canStop, disabledHint: !liveSession && !cleanupPending ? PALETTE_PANEL.whyNotRunning : actionBridgeWhy, run: ctx => runPaletteAction('stop', fresh(), sinkFor(ctx)) },
      { id: 'clear', group: danger, label: PALETTE_PANEL.clear, hint: PALETTE_PANEL.clearHint, enabled: started && canStartSession && canStop && isWriteEnabled(START_CONTROL_FLAG), disabledHint: !started ? PALETTE_PANEL.whyNotStarted : (!isWriteEnabled(START_CONTROL_FLAG) ? startControlOffReason() : actionBridgeWhy), run: ctx => { ctx.close(); void runPaletteAction('clear', fresh(), statusSink(node)) } },
      { id: 'remove', group: danger, label: REMOVE_PANEL.action, hint: removalPreview.count > 1 ? `Removes this agent and ${removalPreview.count - 1} ${removalPreview.count - 1 === 1 ? 'agent' : 'agents'} below it after one confirmation.` : REMOVE_PANEL.hint, enabled: removalPreview.ok && !nodeBranchRemovalFlight.busy(current.id), disabledHint: nodeBranchRemovalFlight.busy(current.id) ? 'This branch is already being removed.' : removalPreview.problems[0] || '', run: ctx => ctx.show(removeRows(), { title: REMOVE_PANEL.action }) },
    ].map(paletteRow)
  }

  /* RESUME, AND EVERY SWITCH THAT IS HONESTLY A RESTART (iteration 5 W7 and
     W10's mid-session half). One flow serves three presses — Resume on a dead
     session, "restart at this depth", "restart in the new folder" — because
     they are the same true mechanism: close whatever is left, start a fresh
     session with the CURRENT tier, depth, and tree profile, and make its
     first message the saved conversation so the new agent picks up where the
     old one stood. The words a person saved are never deleted here; a resume
     that fails leaves the excerpt exactly as it was.

     A node that never spoke resumes as a bare restart (clear-shaped, brief
     NOT re-sent) — there is nothing to read, and re-running the original ask
     uninvited could redo real work. */
  /* THE COORDINATOR'S CLEAN REPLACEMENT IS NOT RESUME.
   *
   * An app-userData command reaches this function only after main validated and
   * claimed its bounded request. It deliberately does not call the resume
   * function below: no provider thread id and no saved transcript may enter the
   * new agent. The old active excerpt/diff/outbox are removed, the saved node's
   * tier, effort, profile and standing-request keys are retained, and the new
   * session is attached to RUN_SESSION_NODES before any later caller can send a
   * sanitized first turn through the ordinary send API.
   *
   * ONE REPLACEMENT PER NODE AT A TIME, WHICHEVER VERB ASKED -- NOT RESUME,
   * BUT THE SAME LOCK AS RESUME. Different verb, same resource: this function
   * and resumeNodeSession below are both "start a session for a node that
   * already has one" -- both await ensureSeatForNode before touching the old
   * session, and both go on to call bridge.start and bind a fresh sessionId
   * onto this node. They used to hold two independent createSingleFlight()
   * locks, one per verb, each keyed by node.id and each guarding its own verb
   * against a second press of ITSELF, neither aware of the other's key. So a
   * Resume press (a person's own, or the automatic dead-session recovery
   * inside treeCardSend) and a "Start over" press (a person's own, or an
   * assistant's agent.restart through fresh-start-existing-node) on the SAME
   * node could both slip past their own lock and run at once: nodeBusy(), the
   * only thing gating either row, reads the node's STATUS, which stays
   * 'finished'/'failed' for the whole window between either press and its new
   * session opening, and says nothing about a lock already held under the
   * other verb. Both bridge.start calls would land, both write node.sessionId
   * / sessionNodeIds / the tree store's attached session for the same node,
   * and the later one wins while the earlier keeps running -- and spending --
   * with nothing on screen able to reach it again: exactly the failure
   * createSingleFlight's own module comment names for a second Resume press,
   * reachable again through the other verb instead of a doubled press of one.
   * One lock, shared by both functions and keyed by node id, is what actually
   * closes both doors with the same rule.
   *
   * STOP IS DELIBERATELY NOT IN THIS SLOT: see src/stop-node-session.js, which
   * closes stop-racing-a-replacement by re-reading the node before its last
   * write instead of serialising a verb that has no second half to protect. */
  const nodeReplacementFlight = RUN_NODE_REPLACEMENTS
  /* `afterBind` runs INSIDE the slot, on a replacement that succeeded: an
     assistant's agent.restart sends the node's saved brief to the circle it
     just rebound, and nothing may replace that session between the bind and
     the boot turn. The person's own "Start over" passes no callback, so it
     stays a genuinely empty new conversation. */
  async function freshStartExistingNode(node, { afterBind = null, delegationToken = null } = {}) {
    const restrictionRefusal = savedResearchRestrictionRefusal(node)
    if (restrictionRefusal) return restrictionRefusal
    if (recoveryCoordinator()?.isRecovering(node?.id)) {
      return { ok: false, code: 'MC_TREE_COMMAND_ALREADY_RUNNING', nodeId: node?.id, sessionId: null, threadId: null }
    }
    const replacementStore = treeStore
    const outcome = await nodeReplacementFlight.run(
      node && node.id != null ? node.id : null,
      async () => {
        // THIS RETAIN MUST STAY AHEAD OF THE CALLEE'S AWAIT: it is what makes
        // freshStartExistingNodeUnguarded's own `const store = treeStore`
        // capture safe, because openTreeStore's chain then re-adopts this exact
        // object instead of minting a second one for the same computer.
        const release = replacementStore ? retainStartingTreeStore(replacementStore) : () => {}
        try {
          const restarted = await freshStartExistingNodeUnguarded(node, { delegationToken })
          return restarted?.ok && typeof afterBind === 'function'
            ? await afterBind(restarted)
            : restarted
        } finally { release() }
      },
    )
    if (!outcome.ran) {
      return { ok: false, code: 'MC_TREE_COMMAND_ALREADY_RUNNING', nodeId: node?.id || null, sessionId: null, threadId: null }
    }
    const result = outcome.value
    /* THE SECOND HALF OF THE REPLACEMENT: THE ADDRESS, NEVER THE OLD ASK.
     *
     * executeFreshStartExistingNode deliberately sends nothing -- see its own
     * header. A bound session told nothing registers under a name and is then
     * unaddressable forever: no "Tree address:" line ever reaches
     * registerTreeSession, and a fresh restart mints a new thread, so
     * adoptTreeAddressFromThread's findByThreadId matches nothing either. This
     * sends the tree address from nodeManagerContext through the ordinary
     * send API, only after the bind above already succeeded -- and nothing
     * else. It deliberately does NOT resend node.message: see
     * fresh-start-brief-send.js's header and
     * tools/test/session-console-history.test.mjs's own words for why a
     * restart of a node that already ran once must not repeat what it already
     * asked for. A send failure here does not undo a successful bind: the
     * circle is real and reachable either way, only its address may be
     * missing, and that is reported back on the result (`briefSendCode`)
     * rather than hidden. */
    if (result.ok && result.sessionId && !delegationToken) {
      const bridge = typeof window === 'undefined' ? null : window.mcAgent
      const parentNode = node.parentId ? treeStore.getNode(node.parentId) : null
      const parent = parentNode ? { id: parentNode.id, name: treeNodeName(parentNode) } : null
      const sendResult = await executeFreshStartBriefSend({
        node,
        sessionId: result.sessionId,
        ...briefContextFor(node, parent),
        bridge: withResearchTreeBinding(bridge),
        sessionNodeIds,
        sessionThreadIds,
        appendTranscript: transcriptAppend,
        appendTurnLog: turnLogAppend,
        treeStore,
        refreshTree,
        refusalCodeFromError: refusalCode,
        refusalCodeFromResult: refusalCodeOf,
      })
      if (!sendResult.ok) return { ...result, briefSendCode: sendResult.code }
    }
    return result
  }

  async function freshStartExistingNodeUnguarded(node, { delegationToken = null } = {}) {
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) return { ok: false, code: 'MC_TREE_COMMAND_START_DISABLED', nodeId: node?.id || null, sessionId: null, threadId: null, reason: startControlOffReason() }
    if (nodeCleanupPending(node)) {
      return { ok: false, code: 'AGENT_SESSION_CLEANUP_FAILED', nodeId: node.id, sessionId: node.sessionId, threadId: null, reason: startCleanupSentence() }
    }
    // Safe across this function's own await ONLY because the caller
    // (freshStartExistingNode) already retained this store before invoking us --
    // unlike startDraftNodeUnguarded, which retains after its awaits and must
    // therefore re-check `treeStore !== store` itself. Move that retain and this
    // capture becomes the same defect, with nothing here that looks wrong.
    const store = treeStore
    let cleanupSessionId = null
    const bridge = withRetainedStartIdentity(typeof window === 'undefined' ? null : window.mcAgent, ({ sessionId }) => {
      cleanupSessionId = sessionId
      retainTreeSessionCleanup(store, node.id, sessionId, { note: statusNote(startCleanupSentence()) })
    }, store.getTree(node.treeId)?.researchProjectId || null)
    const keptProfile = startProfileId(treeStore && node.treeId ? treeStore.treeProfile(node.treeId) : null)
    /* A replacement keeps the circle's declared identity. Resolve it before
       the old session is closed: if the existing seat can no longer be bound,
       the reachable agent stays reachable and the restart refuses loudly. */
    const identityRole = identityRoleForTreeNode(node?.role)
    const seatOutcome = await ensureSeatForNode(node, identityRole)
    const boundRole = roleBindingForStart(node.id, identityRole, node.role)
    if (!seatOutcome?.ok || !boundRole.ok || !boundRole.binding?.agentId) {
      const identityReason = seatOutcome?.ok === false && seatOutcome.reason
        ? seatOutcome.reason
        : boundRole.message || 'This agent could not be given a declared identity, so it was not restarted. Reload this page, then try again.'
      setOrgStatus(identityReason, 'refuse', { sticky: true, code: seatOutcome?.code || boundRole.code || 'MC_TREE_IDENTITY_UNAVAILABLE' })
      /* THE SAME SENTENCE THE LINE ABOVE JUST PUT ON SCREEN, carried to the
         caller too. src/main.js completeTreeNodeCommand and
         shell/tree-command-refusal-sentences.cjs both read a bounded `reason`
         off ANY tree-node-command refusal -- executeFreshStartExistingNode's
         own refusals already carry one (see that file's header comment) -- but
         this identity gate sits in front of that function and built its result
         by hand, and the hand-rolled object dropped the sentence it had just
         computed. An assistant's agent.restart read only
         "MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE" with no explanation, even
         though startDraftNode's identical gate already carries this same
         sentence as its own `message`. */
      return { ok: false, code: 'MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE', nodeId: node.id, sessionId: null, threadId: null, reason: identityReason }
    }
    const accountStart = slotAccountStartOptions(node, LAUNCH_TIERS.find(row => row.id === node.tier)?.provider)
    if (!accountStart.ok) return { ...accountStart, nodeId: node.id, sessionId: node.sessionId || null }
    if (delegationToken && accountStart.options.treeAccount) return { ok: false, code: 'TREE_CONFIGURATION_REFUSED',
      reason: 'This inherited permission path cannot change the slot account.', nodeId: node.id, sessionId: node.sessionId || null }
    const accountBridge = accountStart.options.treeAccount ? { ...bridge, start: request => bridge.start({ ...request, ...accountStart.options }) } : bridge
    const result = await executeFreshStartExistingNode({
      node,
      bridge: accountBridge,
      sourceIsReal: currentDataSource() !== 'mock',
      canStart: () => isWriteEnabled(START_CONTROL_FLAG),
      sessionState: {
        nodeIds: sessionNodeIds,
        transcripts: sessionTranscripts,
        turnLog: sessionTurnLog,
        usage: sessionUsage,
        modelOverride: sessionModelOverride,
        pendingImages: sessionPendingImages,
        profileIds: sessionProfileIds,
        efforts: sessionEfforts,
        threadIds: sessionThreadIds,
        accountNames: sessionAccountNames,
      },
      nodeState: {
        diffHistories: nodeDiffHistories,
        replies: nodeReplies,
        activity: nodeActivity,
        lastTool: nodeLastTool,
      },
      transcriptStore,
      diffHistoryStore,
      treeStore,
      clearOutbox: outboxClearSession,
      resetSessionMetrics,
      notifySessionMappingsChanged: notifyNodeStatusListeners,
      refreshTree,
      tierEffort: tierEffortOf(node?.tier),
      profileId: keptProfile,
      requestKeys: nodeRequestKeys(node),
      treeIdentity: nodeTreeIdentity(node),
      roleBinding: boundRole.binding,
      rememberBoundSessionProfile: (sessionId, nodeId, profileId) => rememberBoundSessionProfile(sessionId, nodeId, profileId, store),
      delegationToken,
      failedNote: result => statusNote(restartRefusalSentence(result, { tier: node?.tier })),
      clearedNote: statusNote(PALETTE_PANEL.cleared),
      refusalCodeFromError: refusalCode,
      refusalCodeFromResult: refusalCodeOf,
    })
    return cleanupSessionId ? { ...result, sessionId: cleanupSessionId, cleanupPending: true } : result
  }

  /* Dead-session recovery admits its triggering text before starting and
     releases the oldest queued message itself. Other Resume callers drain
     only after this shared replacement flight has fully settled. */
  /* ONE RESUME PER NODE AT A TIME, for the same reason startDraftNode keeps
     startingNodeIds and the dead-session recovery keeps recoveringNodes.
     A resume is a real child process, and the only thing gating its palette
     row is nodeBusy() -- which reads the node's STATUS, and the status stays
     'finished'/'failed' for the whole resume, right up until the new session
     opens. So the row stayed enabled through the entire window: press Resume,
     reopen the palette, press it again, and two bridge.start calls ran. Both
     sessions registered in sessionNodeIds and both wrote to the same node; the
     later one won node.sessionId, and the loser kept running -- and spending
     -- with Stop and Interrupt both addressing the winner, so nothing on
     screen could reach it. It ended when the app did.
     The guard wraps rather than reindents: the body below is unchanged, and
     the slot is held by src/single-flight.js so releasing it is structural
     rather than a finally somebody has to remember.
     THE SAME SLOT CLEAN REPLACEMENT HOLDS, not a second one of its own -- see
     "ONE REPLACEMENT PER NODE AT A TIME" on nodeReplacementFlight's own
     declaration above. This used to be its own createSingleFlight() instance
     (`resumeFlight`), which stopped a doubled Resume press but had never
     heard of freshStartExistingNode's lock: the two functions guard the
     identical resource (a session-start for this node), and closing a race
     between one verb and itself does not close the race between the two
     verbs, so a restart racing this resume was left completely unguarded. */
  /* THE RESUME LANDS AFTER TWO REAL AWAITS -- bridge.close, then bridge.start
     over a live child process -- long enough that a person still looking at
     this same node can be mid-word in its composer, its actions filter, or a
     still-open compose panel when the tail below fires (measured: Manager's
     call-path note on this lane, resumeNodeSession tail "fires AFTER an
     await, so a person may be typing by then"). Rebuilding the rail there
     (showTreeNodeControls) is the same defect rail-status-repaint.test.mjs
     guards for the status landings: an innerHTML swap disposes the mounted
     chat and any open popup out from under the keystroke.
     UNLIKE a status landing, this one cannot just repaint in place -- the
     resumed node carries a NEW sessionId, and repaintRailStatus only updates
     the status hosts of the chat that is already mounted; it has no way to
     rebind the composer to a different session's config. So the choice here
     is not "repaint instead", it is "wait": hold the rebuild until the field
     blurs, then run it once, exactly as it would have run right away. */
  function deferRailRebuildWhileTyping(run) {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const typing = Boolean(active) && typeof active.closest === 'function' && (
      (active.tagName === 'INPUT' && Boolean(active.closest('.chat-input')) && Boolean(active.closest('[data-rail-chat-host]'))) ||
      (Boolean(active.matches?.('.chat-actions-filter')) && Boolean(active.closest('[data-rail-chat-host]'))) ||
      Boolean(active.matches?.('[data-compose-field]'))
    )
    if (!typing) { run(); return }
    const onBlur = () => {
      active.removeEventListener('blur', onBlur)
      run()
    }
    active.addEventListener('blur', onBlur)
  }

  /* KEEP TRYING LIVES UNDER THE ACCOUNTS BUTTON. The controls are the same per-agent
     controls with the same hooks; they moved from under the rail's chat into the Accounts menu, as
     the first section of its settings column, named for the agent they act on.
     Built fresh for each agent the rail opens (so no listener outlives its agent)
     and removed whenever the rail lets that agent go (disposeRailChat). */
  function accountRetryHost() {
    return accountsMenuEl?.querySelector('[data-account-retry-controls]') || null
  }
  function removeAccountRetrySection() {
    accountRetryHost()?.remove()
  }
  function accountRetrySection(node) {
    removeAccountRetrySection()
    const sidebar = accountsMenuEl?.querySelector('.acct-sidebar')
    if (!sidebar) return null
    const section = el(`
      <section class="acct-section acct-keep-trying account-retry-controls" data-account-retry-controls aria-label="Keep trying accounts for ${escapeMarkup(treeNodeName(node))}">
        <h4 class="acct-section-title">Keep trying · ${escapeMarkup(treeNodeName(node))}</h4>
        <div class="ctl-row"><button class="acct-btn" type="button" data-keep-trying-accounts>Keep trying accounts</button>
          <button class="acct-btn" type="button" data-cancel-account-retries hidden>Cancel retries</button></div>
        <label class="acct-toggle"><span>Wait for resets and auto retry</span><input type="checkbox" data-wait-account-resets></label>
        <details><summary class="acct-help">Allowed providers for retries</summary>
          <div class="ctl-row">${[['codex', 'Codex'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok']].map(([id, label]) => `<label><input type="checkbox" data-retry-provider value="${id}"${defaultRetryProviders(LAUNCH_TIERS.find(row => row.id === node.tier)?.provider).includes(id) ? ' checked' : ''}> ${label}</label>`).join('')}</div>
        </details>
        <output class="acct-help" role="status" data-account-retry-status></output>
        <p class="acct-help acct-help-quiet">Uses your registered signed-in accounts and other providers, with this role and the saved conversation. Other agents still follow saved action permissions.</p>
      </section>`)
    sidebar.prepend(section)
    return section
  }

  function paintAccountRetryControls(nodeId) {
    if (currentRailTreeNode?.id !== nodeId) return
    const node = treeStore?.getNode(nodeId)
    const host = accountRetryHost()
    if (!node || !host) return
    const policy = recoveryCoordinator()?.retryPolicy(nodeId)
    const tier = LAUNCH_TIERS.find(row => row.id === node.tier)
    const out = host.querySelector('[data-account-retry-status]')
    const actualAccount = policy?.sessionId === node.sessionId ? policy.actualAccount : transcriptStore?.get(node.id)?.account
    const current = tier ? `Current: ${tier.label} · ${tier.provider}${actualAccount ? ` · ${actualAccount}` : ''}. ` : ''
    const preferred = policy?.preferredTier && policy.preferredTier !== policy.actualTier
      ? ` Preferred model: ${LAUNCH_TIERS.find(row => row.id === policy.preferredTier)?.label || policy.preferredTier}.` : ''
    out.textContent = current + (recoveryCoordinator()?.retryStatus(nodeId) || '') + preferred
    const button = host.querySelector('[data-keep-trying-accounts]')
    button.disabled = currentDataSource() !== 'local' || !isWriteEnabled(START_CONTROL_FLAG) || recoveryCoordinator()?.isRecovering(nodeId)
    button.textContent = policy?.enabled ? (policy.state === 'working' ? 'Keep trying accounts is on' : 'Try accounts now') : 'Keep trying accounts'
    host.querySelector('[data-cancel-account-retries]').hidden = !policy?.enabled
    host.querySelector('[data-wait-account-resets]').checked = policy?.waitForReset === true
    for (const input of host.querySelectorAll('[data-retry-provider]')) {
      if (policy) input.checked = policy.allowedProviders.includes(input.value)
      input.disabled = recoveryCoordinator()?.isRecovering(nodeId) === true
    }
  }
  function mountAccountRetryControls(node) {
    const host = accountRetrySection(node)
    if (!host) return
    const out = host.querySelector('[data-account-retry-status]')
    const wait = host.querySelector('[data-wait-account-resets]')
    const allowedProviders = () => [...host.querySelectorAll('[data-retry-provider]:checked')].map(input => input.value)
    for (const input of host.querySelectorAll('[data-retry-provider]')) input.addEventListener('change', async () => {
      if (!recoveryCoordinator()?.retryPolicy(node.id)?.enabled) return
      try { await recoveryCoordinator().setAllowedProviders(node.id, allowedProviders()); paintAccountRetryControls(node.id) }
      catch (error) { out.textContent = error.message || String(error) }
    })
    const run = async () => {
      try {
        await continueNodeOnAnotherAccount(treeStore?.getNode(node.id) || node, out, { waitForReset: wait.checked, allowedProviders: allowedProviders() })
        paintAccountRetryControls(node.id)
      } catch (error) { out.textContent = error.message || String(error) }
    }
    host.querySelector('[data-keep-trying-accounts]').addEventListener('click', () => { void run() })
    host.querySelector('[data-cancel-account-retries]').addEventListener('click', async () => {
      try { await recoveryCoordinator().cancelAccountRetries(node.id); paintAccountRetryControls(node.id) }
      catch (error) { out.textContent = error.message || String(error) }
    })
    wait.addEventListener('change', async () => {
      try {
        if (recoveryCoordinator()?.retryPolicy(node.id)?.enabled) await recoveryCoordinator().setWaitForResets(node.id, wait.checked)
        else if (wait.checked) await run()
        paintAccountRetryControls(node.id)
      } catch (error) { out.textContent = error.message || String(error) }
    })
    paintAccountRetryControls(node.id)
  }

  /* IS KEEP-TRYING ON -- AND "I COULD NOT FIND OUT" IS NOT YES.
   *
   * THE FAILURE PATHS ARE WRITTEN FIRST BECAUSE THEY ARE THE POINT. This answer
   * decides whether this program moves somebody's conversation to another account
   * without asking. Every way of failing to learn the answer -- no bridge, a
   * bridge that throws, an answer that is not an object -- returns false, so a
   * broken or unreadable settings read leaves the person exactly where the
   * refusal left them, with the sentence and the choice. Nothing here treats
   * "cannot tell" as permission.
   *
   * WHY NOT loadAccounts(), WHICH IS RIGHT THERE. It cannot express failure: a
   * throwing bridge and a successful empty answer both come back as
   * readAccountList(null), whose policy reads autoRecoverOnLimit true. Using it
   * would turn every broken read into consent -- the precise mistake this guard
   * exists to prevent. So the bridge is read directly and its failures are mine
   * to classify.
   *
   * ABSENT IS STILL ON, THOUGH, and that is not a contradiction. A read that
   * SUCCEEDS and reports no decision means nobody has turned keep-trying off,
   * and keep-trying is on by default and persistent. "Nobody decided" is a fact
   * the shell told us; "I could not ask" is the absence of a fact. The two rules
   * sit on opposite sides of ONE line: did we get an answer.
   *
   * DO NOT FLATTEN THEM INTO "BE CAUTIOUS EVERYWHERE". Reading this cold, the
   * tidy-looking move is to treat a missing decision as cautiously as a missing
   * answer -- and that would switch keep-trying OFF for everybody who has never
   * opened the accounts policy, which is nearly everybody, because on-by-default
   * is precisely what "nobody decided" means here. The caution belongs on the
   * failure of the READ, never on the content of a successful one. */
  RUN_KEEP_TRYING_CONSENT = () => keepTryingOnLimitIsOn()
  async function keepTryingOnLimitIsOn() {
    const bridge = accountsBridge()
    if (!bridge || typeof bridge.accounts !== 'function') return false
    let answered = null
    try { answered = await bridge.accounts() } catch { return false }
    if (!answered || typeof answered !== 'object' || Array.isArray(answered)) return false
    const listed = readAccountList(answered)
    /* `available` FIRST, AND MY OWN TEST IS WHY. readAccountList answers
       NO_POLICY for anything that is not a real list -- no ok:true, no accounts
       array -- and NO_POLICY reads autoRecoverOnLimit TRUE, because a menu drawn
       before the shell answers must not show recovery as off when it is on. That
       default is right for drawing a checkbox and catastrophic as consent: a
       bridge answering `{}` would have moved the person's conversation. So the
       answer must be a list that actually read, and only then is the policy
       consulted. An explicit false is a decision and is obeyed. */
    if (!listed || listed.available !== true) return false
    return listed.policy?.autoRecoverOnLimit === true
  }

  async function continueNodeOnAnotherAccount(node, out = null, retryChoice = null, { effort: chosenEffort = null, treeAccount = null, isCurrent = () => true, beginContinuation = null } = {}) {
    const choiceRevision = retryChoice ? recoveryCoordinator()?.retryChoiceRevision(node?.id) : null
    if (currentDataSource() !== 'local') {
      if (out) out.textContent = MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY
      return false
    }
    const store = treeStore
    const computerId = treeStoreId
    if (!isCurrent() || !store || !node || (!retryChoice && !node.sessionId) || !isWriteEnabled(START_CONTROL_FLAG)) return false
    if (nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id)) return false
    const identityRole = identityRoleForTreeNode(node.role)
    const seat = await ensureSeatForNode(node, identityRole)
    if (!isCurrent() || destroyed || treeStore !== store || store.getNode(node.id)?.sessionId !== node.sessionId) return false
    if (currentDataSource() !== 'local') {
      if (out) out.textContent = MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY
      return false
    }
    const boundRole = roleBindingForStart(node.id, identityRole, node.role)
    if (!seat?.ok || !boundRole.ok || !boundRole.binding?.agentId) {
      if (out) out.textContent = seat?.reason || boundRole.message || 'This agent could not be given its saved identity.'
      return false
    }
    const current = store.getNode(node.id)
    const profileId = startProfileId(store.treeProfile(current.treeId))
    /* The person's pick from the switch dialog first (see continueNodeWithChoice),
       then the depth the record remembers. */
    const continueRequest = { computerId, nodeId: current.id, isCurrent: beginContinuation ? beginContinuation() : isCurrent,
      startOptions: { tier: current.tier, effort: chosenEffort || savedSessionEffort({ savedEffort: transcriptStore?.get(current.id)?.effort,
        nodeEffort: current.effort, tierEffort: tierEffortOf(current.tier) }),
        ...(profileId ? { profileId } : {}),
        ...(treeAccount ? { treeAccount } : {}),
        ...(store.getTree(current.treeId)?.researchProjectId ? { researchProjectId: store.getTree(current.treeId).researchProjectId } : {}),
        roleBinding: boundRole.binding } }
    return retryChoice ? recoveryCoordinator().keepTryingAccounts({ ...continueRequest, ...retryChoice, choiceRevision })
      : recoveryCoordinator().continueOnAnotherAccount(continueRequest)
  }

  /* OWNER REQUEST T137 (2026-09-16 02:58Z): "switch models still doesnt work.
     and it should work for even different providers because we can just hand
     the context to the next agent." The Claude CLI binds --model at spawn and
     no thread crosses providers, so the switch is a continuation: the same
     path as continueNodeOnAnotherAccount, on the chosen tier, on whichever
     account the ordinary start picks (the current one is not excluded), with
     the new tier recorded on the node so the card, the chip and the next
     Resume read the model that is actually running. Refused mid-turn: a turn
     in flight is not interrupted to switch under it. */
  async function continueNodeOnAnotherModel(node, tierId, out = null, { effort: chosenEffort = null, treeAccount = null, isCurrent = () => true, beginContinuation = null } = {}) {
    if (currentDataSource() !== 'local') {
      if (out) out.textContent = MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY
      return false
    }
    const store = treeStore
    const computerId = treeStoreId
    const tier = LAUNCH_TIERS.find(row => row.id === tierId) || null
    if (!isCurrent() || !store || !node?.sessionId || !tier || !isWriteEnabled(START_CONTROL_FLAG)) return false
    const savedProvider = transcriptStore?.get(node.id)?.provider
    if (tier.id === node.tier && (!savedProvider || savedProvider === tier.provider)) return false
    if (nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id)) return false
    if (nodeBusy(node)) {
      if (out) out.textContent = MODEL_PANEL.continueBusy
      return false
    }
    const identityRole = identityRoleForTreeNode(node.role)
    /* THE TARGET TIER, NOT THE NODE'S CURRENT ONE. See ensureSeatForNode: the
       seat's provider is the authority the host compares against the session's,
       and this start carries `tier.id`, so this is the tier the seat must
       describe. */
    const seat = await ensureSeatForNode(node, identityRole, { tierId: tier.id })
    if (!isCurrent() || destroyed || treeStore !== store || store.getNode(node.id)?.sessionId !== node.sessionId) return false
    // A turn may have started during that await; the coordinator refuses it
    // too, but the person is told here rather than left with a silent no-op.
    if (nodeBusy(store.getNode(node.id))) {
      if (out) out.textContent = MODEL_PANEL.continueBusy
      return false
    }
    const boundRole = roleBindingForStart(node.id, identityRole, node.role)
    if (!seat?.ok || !boundRole.ok || !boundRole.binding?.agentId) {
      if (out) out.textContent = seat?.reason || boundRole.message || 'This agent could not be given its saved identity.'
      return false
    }
    const current = store.getNode(node.id)
    const from = LAUNCH_TIERS.find(row => row.id === current.tier) || null
    const profileId = startProfileId(store.treeProfile(current.treeId))
    /* The saved effort travels only within a provider: a Codex effort is not a
       Claude effort, so a provider change takes the new tier's own default. */
    const effort = chosenEffort || (from && from.provider === tier.provider
      ? savedSessionEffort({ savedEffort: transcriptStore?.get(current.id)?.effort, nodeEffort: current.effort, tierEffort: tierEffortOf(tier.id) })
      : tierEffortOf(tier.id))
    return recoveryCoordinator().continueOnAnotherModel({ computerId, nodeId: current.id, isCurrent: beginContinuation ? beginContinuation() : isCurrent,
      startOptions: { tier: tier.id, ...(effort ? { effort } : {}), ...(treeAccount ? { treeAccount } : {}), ...(profileId ? { profileId } : {}), roleBinding: boundRole.binding } })
  }

  /* SWITCH AND CONTINUE (owner T381): the one choice, landed on the mechanism
     it names. continuationRouteFor (src/switch-and-continue.js) decides the
     route by value: the same account on the same provider is a RESUME of the
     saved thread at the chosen model and depth -- nothing re-sent, nothing
     charged; another account or provider is a HANDOFF, because a native thread
     belongs to the home that made it (shell/agent-host.cjs refuses a start
     that names both a thread and continueFromAccount). A chosen account rides
     this tree's native start as an exact per-request selector; it never changes
     the computer preference or another circle's start. */
  async function continueNodeWithChoice(node, choice, out = null, isCurrent = () => true, fromPending = false, beginContinuation = null) {
    if (!isCurrent() || !node || !choice) return false
    if (currentDataSource() !== 'local') {
      if (out) out.textContent = MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY
      return false
    }
    if (!isWriteEnabled(START_CONTROL_FLAG)) {
      if (out) out.textContent = startControlOffReason()
      return false
    }
    const current = treeStore?.getNode(node.id) || node
    const saved = transcriptStore?.get(current.id) || null
    const route = continuationRouteFor({ savedAccount: saved?.account || null, savedProvider: saved?.provider || LAUNCH_TIERS.find(row => row.id === current.tier)?.provider || null,
      currentTier: current.tier || null, tiers: LAUNCH_TIERS, choice })
    const effort = typeof choice.effort === 'string' && choice.effort ? choice.effort : null
    if (out) out.textContent = SWITCH_PANEL.continuing
    if (route.route === 'resume') {
      // Admission receives the requested tier directly. The saved/current model
      // changes only when Resume has an accepted successor to publish.
      const resumed = await resumeNodeSession(treeStore?.getNode(current.id) || current, {
        ...(effort ? { effort } : {}), out, requestedTier: route.tier,
        ...(route.account ? { accountChoice: { provider: route.provider, name: route.account } } : {}),
        ...(fromPending ? { isCancelled: () => !isCurrent(), beginContinuation, cleanupCancelledStart: true } : {}),
      })
      if (isCurrent() && !resumed && out) out.textContent = SWITCH_PANEL.failed
      return resumed?.stale === true ? resumed : Boolean(resumed)
    }
    // The selected account rides this replacement only. The account page's
    // global switch would redirect unrelated starts during this await.
    const treeAccount = route.account || null
    const continued = route.changesModel || route.changesProvider
      ? await continueNodeOnAnotherModel(treeStore?.getNode(current.id) || current, route.tier, out, { effort, treeAccount, isCurrent, beginContinuation })
      : await continueNodeOnAnotherAccount(treeStore?.getNode(current.id) || current, out, null, { effort, treeAccount, isCurrent, beginContinuation })
    if (isCurrent() && continued !== true && out && (!out.textContent || out.textContent === SWITCH_PANEL.continuing)) out.textContent = SWITCH_PANEL.failed
    return continued === true
  }

  const managedSlotChoices = new Map()
  async function configureManagedSlot(command, node) {
    const store = treeStore
    const previousSessionId = node.sessionId || null
    const token = {}
    managedSlotChoices.set(node.id, token)
    const isCurrent = () => !destroyed && treeStore === store
      && managedSlotChoices.get(node.id) === token
      && store.getNode(node.id)?.createdAt === node.createdAt
      && store.getNode(node.id)?.treeId === node.treeId
      && !callerCircleRefusal({ command, node: store.getNode(node.id), treeStore: store, sessionNodeIds })
    const initialCurrent = () => isCurrent() && (store.getNode(node.id)?.sessionId || null) === previousSessionId
    const refuse = (reason, code = 'TREE_CONFIGURATION_REFUSED') => ({
      ok: false, status: 'refused', code, reason, nodeId: node.id,
      sessionId: store.getNode(node.id)?.sessionId || null,
    })
    if (command.expectedSessionId !== undefined && (command.expectedSessionId || null) !== previousSessionId) {
      return refuse('This slot changed session. Read its current identity before changing it.')
    }
    if (currentDataSource() !== 'local' || !isWriteEnabled(START_CONTROL_FLAG)) {
      return refuse(currentDataSource() !== 'local' ? MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY : startControlOffReason())
    }
    if (nodeCleanupPending(node) || nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id)) {
      return refuse('This slot has an unresolved start or cleanup. Resolve it before changing its configuration.')
    }
    const field = MANAGED_SLOT_ACTIONS[command.action]
    const [catalog, listed] = await Promise.all([
      ['model', 'provider'].includes(field) ? readStartableTiers() : Promise.resolve(null),
      field === 'account' ? loadAccounts(window) : Promise.resolve(null),
      field === 'effort' ? engineModelCatalog.read(node.sessionId, window.mcAgent) : Promise.resolve(null),
    ])
    if (!initialCurrent()) return refuse('The slot or its managing session changed while its choices loaded.')
    const current = store.getNode(node.id)
    const saved = transcriptStore?.get(current.id)
    const tierId = current.tier || TREE_DEFAULT_STARTABLE_TIERS[0]
    const provider = LAUNCH_TIERS.find(row => row.id === tierId)?.provider
    const active = sessionNodeIds.has(current.sessionId)
    const effort = savedSessionEffort({ sessionEffort: sessionEfforts.get(current.sessionId),
      savedEffort: saved?.effort, nodeEffort: current.effort, tierEffort: tierEffortOf(tierId) })
    const reportedEfforts = engineEffortsFor(current)
    // A stopped slot has no session catalog. The existing launch menu owns
    // these Codex/Claude choices; other providers must report their own.
    const efforts = reportedEfforts.length > 0 ? reportedEfforts
      : !active && ['codex', 'claude'].includes(provider) ? EFFORT_CHOICES : []
    const plan = planManagedSlotChoice({
      action: command.action, value: command.choice, tiers: LAUNCH_TIERS,
      current: { tier: tierId, provider, effort,
        account: active ? sessionAccountNames.get(current.sessionId) || saved?.account || null
          : current.accountChoice?.name || saved?.account || null,
        role: current.roleBindingPending?.sessionId === current.sessionId ? current.roleBindingPending.role : current.role || '' },
      roles: orgAvailability.roles || [], accounts: listed?.accounts || [], efforts,
      startable: catalog?.tiers, answered: catalog?.answered === true,
      accountAnswered: listed?.available === true && listed?.damaged !== true, effortAnswered: efforts.length > 0,
    })
    if (!plan.ok) return refuse(plan.reason, plan.code)
    const appliedConfiguration = () => {
      const live = store.getNode(node.id)
      if (!live?.sessionId || !sessionNodeIds.has(live.sessionId)) return null
      const recorded = transcriptStore?.get(node.id)
      const declared = LAUNCH_TIERS.find(row => row.id === live.tier)
      return {
        tier: live.tier, provider: recorded?.provider || declared?.provider || null,
        account: sessionAccountNames.has(live.sessionId)
          ? sessionAccountNames.get(live.sessionId) ?? null : recorded?.account ?? null,
        effort: savedSessionEffort({ sessionEffort: sessionEfforts.get(live.sessionId),
          savedEffort: recorded?.effort, nodeEffort: live.effort, tierEffort: declared?.effort }),
        role: live.roleBindingPending?.sessionId === live.sessionId ? live.roleBindingPending.role : live.role || '',
      }
    }
    const response = (status, extra = {}) => ({ ok: true, status, nodeId: node.id,
      sessionId: store.getNode(node.id)?.sessionId || null, field: plan.field,
      requested: plan.choice, applied: status === 'applied' ? appliedConfiguration() : active ? plan.previous : null, ...extra })
    if (!plan.changed) return active ? response('applied', { unchanged: true })
      : response('pending', { unchanged: true, pending: { when: 'next-start', ...plan.choice } })
    const out = statusSink(current)
    const label = plan.field === 'account' ? 'account ' + plan.choice.account
      : plan.field === 'role' ? 'role ' + plan.choice.role
      : plan.field === 'effort' ? 'effort ' + plan.choice.effort
      : LAUNCH_TIERS.find(row => row.id === plan.choice.tier)?.label || plan.choice.tier

    const savePreferences = () => store.setNodeLaunchPreferences(node.id, {
      tier: plan.choice.tier, effort: plan.choice.effort || '',
      ...(plan.field === 'account' ? { accountChoice: { name: plan.choice.account, provider: plan.choice.provider } }
        : plan.field === 'provider' ? { accountChoice: null } : {}),
    })
    const saveRole = async currency => {
      const bridge = orgBridge()
      if (typeof bridge?.assignRole !== 'function') return refuse(ROLE_ASSIGN_UNAVAILABLE.reason || 'Role assignment is unavailable. Open a complete ToolsEnabled build to choose a role.')
      if (!currency()) return refuse('This role choice was cancelled before assignment.')
      const originalSeat = orgAvailability.org?.agents?.find(row => row.id === node.id)
      if (!originalSeat?.enabled) return refuse('The managed slot is not enabled in the current organisation.')
      let assigned
      try {
        assigned = await bridge.assignRole({ agentId: node.id, role: plan.choice.role,
          expectedRevision: orgAvailability.org?.revision })
      } catch { return refuse('The role assignment could not be confirmed. Read the Role library before retrying.') }
      if (assigned?.ok !== true) return refuse(assigned?.reason || 'The role assignment was refused. Read the Role library before trying again.', assigned?.code)
      if (!currency()) {
        // A cancellation can cross the assignment reply. Restore only our own
        // revision; an intervening owner edit must never be overwritten.
        let restored = null
        try {
          restored = await bridge.assignRole({ agentId: node.id, role: originalSeat.role,
            expectedRevision: assigned.org.revision })
          if (restored?.ok && originalSeat.roleSelection === '') {
            restored = await bridge.ensureSeat({ id: node.id, role: originalSeat.role, roleSelection: '',
              provider: originalSeat.provider, nodeId: originalSeat.nodeId || node.id,
              expectedRevision: restored.org.revision })
          }
        } catch { /* The named retained-assignment refusal below is authoritative. */ }
        if (restored?.ok && !destroyed && treeStore === store) orgAvailability = { ...orgAvailability, org: restored.org }
        return refuse(restored?.ok ? 'The role choice was cancelled; its previous assignment was restored.'
          : 'The role assignment completed before cancellation, and a later organisation change prevented restoration. Read the current role before retrying.')
      }
      // This is the same authoritative assignment as the user's Role control.
      // It configures the next binding; it does not rewrite a running prompt.
      if (destroyed || treeStore !== store || store.getNode(node.id)?.createdAt !== node.createdAt) {
        return response('pending', { pending: { when: 'next-session', role: plan.choice.role }, projectionUnavailable: true })
      }
      orgAvailability = { ...orgAvailability, org: assigned.org }
      const changed = store.setNodeRole(node.id, plan.choice.role, active
        ? { pendingSessionId: current.sessionId, appliedRole: plan.previous.role } : {})
      if (changed?.ok !== true) return refuse(changed?.problems?.[0] || 'The assigned role could not be saved on this slot.')
      notifyNodeStatusListeners()
      if (out) out.textContent = 'Role saved. The next session will use ' + plan.choice.role + '.'
      return response('pending', { pending: { when: 'next-session', role: plan.choice.role } })
    }
    const apply = async (live, currency, beginContinuation) => {
      if (!isCurrent() || !currency()) return false
      if (plan.field === 'role') {
        const answer = await saveRole(() => isCurrent() && currency())
        if (!answer.ok && out) out.textContent = answer.reason
        return answer.ok === true
      }
      const succeeded = await continueNodeWithChoice(live, plan.choice, out, () => isCurrent() && currency(), true, beginContinuation)
      if (succeeded === true && isCurrent() && (plan.field === 'account' || plan.field === 'provider')) {
        const changed = savePreferences()
        if (changed?.ok !== true) {
          if (out) out.textContent = changed?.problems?.[0] || 'The running account changed, but its next-start preference could not be saved.'
          return false
        }
      }
      return succeeded
    }
    if (nodeBusy(current) || pendingModelChoice(current)) {
      queueModelChoice(current, plan.choice.tier, out, apply, { label })
      return response('pending', { pending: { when: 'turn-boundary', ...plan.choice } })
    }
    if (plan.field === 'role') return saveRole(initialCurrent)
    if (!active) {
      const changed = savePreferences()
      if (changed?.ok !== true) return refuse(changed?.problems?.[0] || 'This slot configuration could not be saved.')
      notifyNodeStatusListeners()
      return response('pending', { pending: { when: 'next-start', ...plan.choice } })
    }
    const succeeded = await apply(current, initialCurrent, () => isCurrent)
    if (succeeded !== true) return refuse(out?.textContent || 'The configuration could not be applied; retained work was not replayed.')
    if (!isCurrent()) return refuse('The configuration completed after this slot changed. Read its current applied values.')
    return response('applied')
  }

  /* THE DIALOG ON THE CIRCLE. Opened by the app when a saved account cannot
     continue (the resume refusals savedAccountResumeRefused names, from the
     Resume press, a queued send, or the reopen poll) and from Actions at any
     time. One at a time per circle; a second refusal while it is open is not
     a second dialog. */
  const switchDialogs = new Map()
  async function offerSwitchAndContinue(node, { sentence = '', refusedAccount = null } = {}) {
    if (destroyed || !node || typeof document === 'undefined' || mockSource()) return null
    const current = treeStore?.getNode(node.id) || node
    if (switchDialogs.has(current.id)) return switchDialogs.get(current.id)
    const saved = transcriptStore?.get(current.id) || null
    const store = treeStore
    /* THE TARGET, FROZEN AT OPEN (owner T775: "show the chat next to the menu
       so the user knows what agent is being restarted"). The dialog is for
       exactly this circle and this session. Both ids are copied out of the
       record now, so nothing that later mutates the node can move the choice
       onto another target; targetCurrent() re-reads the store every time the
       answer matters -- after the awaits, on Continue, and on every status
       notification -- and a target that moved on makes the dialog stale
       instead of silently starting something else. */
    const target = Object.freeze({ nodeId: current.id, sessionId: current.sessionId ?? null })
    const targetCurrent = () => {
      if (destroyed || treeStore !== store) return null
      const live = store?.getNode(target.nodeId) || null
      return live && (live.sessionId ?? null) === target.sessionId ? live : null
    }
    const [listed, catalog] = await Promise.all([loadAccounts(window), readStartableTiers()])
    if (!targetCurrent()) return null
    if (switchDialogs.has(target.nodeId)) return switchDialogs.get(target.nodeId)
    if (catalog?.answered !== true) {
      setOrgStatus('The available models could not be confirmed. Try opening the model chooser again.', 'refuse', { sticky: true })
      return null
    }
    const account = refusedAccount || saved?.account || null
    const provider = saved?.provider || LAUNCH_TIERS.find(row => row.id === current.tier)?.provider || null
    const effort = savedSessionEffort({ sessionEffort: current.sessionId ? sessionEfforts.get(current.sessionId) : null,
      savedEffort: saved?.effort, nodeEffort: current.effort, tierEffort: tierEffortOf(current.tier) })
    const choices = switchChoices({ accounts: listed?.accounts || [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES,
      refusedAccount: account, currentTier: current.tier || null, currentEffort: effort || null,
      startable: catalog.tiers, answered: catalog.answered })
    const host = document.body
    /* Who the dialog is for, in the words the tree already uses for the circle
       (treeNodeName), with the role, model and account it runs on; its saved
       conversation is drawn beside the menu from the same transcript store the
       chat reads, bound to the frozen node id. */
    const targetDetail = [roleLabel(roleDisplayFor(current.role)),
      LAUNCH_TIERS.find(row => row.id === current.tier)?.label || current.tier || '',
      account ? `account ${account}` : ''].filter(Boolean).join(' · ')
    let unsubscribe = () => {}
    const settle = () => { unsubscribe(); unsubscribe = () => {}; switchDialogs.delete(target.nodeId) }
    const dialog = mountSwitchAndContinueDialog({ document, host, refusalSentence: sentence, choices, tiers: LAUNCH_TIERS,
      current: { account, provider, tier: current.tier || null, effort: effort || null },
      target: { name: treeNodeName(current), detail: targetDetail },
      conversation: transcriptStore ? { store: transcriptStore, nodeId: target.nodeId } : null,
      onChoose: choice => {
        settle()
        const live = targetCurrent()
        if (!live) { setOrgStatus(SWITCH_PANEL.targetChanged, 'refuse', { sticky: true }); return }
        if (nodeBusy(live) || pendingModelChoice(live)) {
          queueModelChoice(live, choice.tier, statusSink(live), (next, isCurrent, beginContinuation) =>
            continueNodeWithChoice(next, choice, statusSink(next), isCurrent, true, beginContinuation), {
              label: [LAUNCH_TIERS.find(row => row.id === choice.tier)?.label || choice.tier,
                choice.account ? `account ${choice.account}` : '', choice.effort || ''].filter(Boolean).join(' · '),
            })
        } else void continueNodeWithChoice(live, choice, statusSink(live))
      },
      onCancel: settle,
      /* Every way the dialog leaves -- Continue, Not now, Escape, a caller's
         close(), the owner's dispose() -- releases the slot and the listener
         once, through the dialog's own single exit. */
      onClose: settle,
    })
    if (!dialog) return null
    switchDialogs.set(target.nodeId, dialog)
    /* A Resume that succeeded elsewhere, a restart or a removal while the
       dialog is open: the status choke point reports it, the dialog says so and
       refuses Continue. THE VIEW ITSELF GOING AWAY is the other thing that
       choke point reports (destroy() notifies after `destroyed` is set, and a
       replaced store means another computer's page): then the body-level modal
       must not stay over the next view, so it is disposed outright.
       THE LISTENER STAYS FOR AS LONG AS THE DIALOG DOES (M11 review of T775,
       finding F3). A stale dialog is still a body-level modal, and the view
       can still go away underneath it; releasing the listener on the first
       stale notice left exactly that modal over the next view, with nothing
       left to dispose it. So going stale releases nothing: the listener keeps
       listening, markStale() is a no-op once the sentence is up, and the one
       release is settle(), reached through the dialog's own close -- Continue,
       Not now, Escape, dispose() -- whichever comes first. */
    unsubscribe = registerNodeStatusListener(target.nodeId, () => {
      if (destroyed || treeStore !== store) { dialog.dispose(); return }
      if (targetCurrent()) return
      dialog.markStale(SWITCH_PANEL.targetChanged)
    })
    return dialog
  }

  async function resumeNodeSession(node, options = {}) {
    const provider = LAUNCH_TIERS.find(row => row.id === (options.requestedTier || node?.tier))?.provider
    const accountStart = slotAccountStartOptions(options.accountChoice === undefined ? node : { ...node, accountChoice: options.accountChoice }, provider)
    if (!accountStart.ok) { if (options.out) options.out.textContent = accountStart.reason; return false }
    const savedChoice = transcriptStore?.get(node?.id)
    if (node?.sessionId && !nodeBusy(node) && savedChoice?.provider && savedChoice.provider !== provider) {
      return continueNodeOnAnotherModel(node, options.requestedTier || node.tier, options.out, {
        effort: options.effort, treeAccount: accountStart.options.treeAccount || null,
        isCurrent: () => options.isCancelled?.() !== true, beginContinuation: options.beginContinuation || null,
      })
    }
    if (node?.sessionId && !nodeBusy(node) && accountStart.options.treeAccount && savedChoice?.account !== accountStart.options.treeAccount) {
      return continueNodeOnAnotherAccount(node, options.out, null, {
        effort: options.effort, treeAccount: accountStart.options.treeAccount,
        isCurrent: () => options.isCancelled?.() !== true, beginContinuation: options.beginContinuation || null,
      })
    }
    if (recoveryCoordinator()?.isRecovering(node?.id)) {
      if (options.out) options.out.textContent = 'This agent is already continuing on another account.'
      return false
    }
    const replacementStore = treeStore
    const outcome = await nodeReplacementFlight.run(
      node && node.id != null ? node.id : null,
      async () => {
        // A reopened page must share this exact store while the provider is
        // starting, or its edits make the returning attachment a stale write.
        const release = replacementStore ? retainStartingTreeStore(replacementStore) : () => {}
        try {
          let refusal = null
          const resumed = await resumeNodeSessionUnguarded(node, { ...options, onRefused: value => { refusal = value } })
          if (resumed || options.machineInitiated || options.delegationToken || destroyed || treeStore !== replacementStore || refusal?.retryable !== true
              || refusal.sessionId || !isResourceHold(refusal.code) || !refusal.resumeTarget?.threadId) {
            if (refusal) options.onRefused?.(refusal)
            return resumed
          }
          return await resumeNodeSessionQueued(node, options, replacementStore, refusal)
        }
        finally { release() }
      },
    )
    if (!outcome.ran) {
      if (options.out) options.out.textContent = RESUME_PANEL.underway
      return false
    }
    const result = typeof outcome.value?.continueAfterResume === 'function'
      ? await outcome.value.continueAfterResume() : outcome.value
    if (result && result?.stale !== true && options.deliverQueued !== false && !destroyed && treeStore === replacementStore) {
      const fresh = replacementStore?.getNode(node.id)
      if (fresh?.sessionId && fresh.status !== 'interrupted' && !nodeBusy(fresh) && !nodeSessionEnded(fresh)) {
        const nextQueued = outboxTakeNext(fresh.sessionId)
        if (nextQueued) void drainOutboxMessage(fresh.sessionId, fresh.id, nextQueued)
      }
    }
    return result
  }
  async function resumeNodeSessionQueued(node, options, store, firstRefusal) {
    const target = firstRefusal.resumeTarget
    const identity = { sessionId: node.sessionId, treeId: node.treeId, tier: node.tier, role: node.role }
    let initial = firstRefusal, queue
    const cancelled = () => options.isCancelled?.() === true || queue.snapshot().cancelled || destroyed || treeStore !== store
    queue = createTreeLaunchQueue({ nodes: [node], concurrency: 1,
      start: async pending => {
        // Account for the completed first attempt through the queue's normal
        // backoff. Never make an immediate second provider admission request.
        if (initial) { const held = initial; initial = null; return { ok: false, ...held } }
        if (cancelled()) return { ok: false, notStarted: true }
        const current = store.getNode(pending.id)
        if (!current || Object.keys(identity).some(key => current[key] !== identity[key])) {
          return { ok: false, code: 'MC_TREE_COMMAND_SESSION_CHANGED', message: 'This agent changed while Resume waited. Review its saved conversation before trying again.' }
        }
        let refusal = null
        const resumed = await resumeNodeSessionUnguarded(current, { ...options, expectedResume: { ...target, nodeIdentity: identity },
          isCancelled: cancelled, onRefused: value => { refusal = value } })
        if (resumed) return { ok: true, resumeResult: resumed, sessionId: resumed?.stale === true ? resumed.sessionId : store.getNode(node.id)?.sessionId || null }
        return refusal ? { ok: false, ...refusal } : { ok: false, notStarted: cancelled() }
      },
      onChange: state => {
        if (destroyed || treeStore !== store) return
        refreshTreeStartControls()
        refreshLaunchStatus()
        if (!state.finished && (state.waiting || state.paused || state.cancelled)) {
          const message = state.cancelled ? 'Queued Resume cancelled; a session already opening may still finish.'
            : state.paused ? 'Resume paused. The saved conversation and queued messages are kept.'
            : `${state.reason} Resume is queued; use Pause queue or Cancel queued in the agent panel or Fleet overview.`
          if (options.out) options.out.textContent = message
          setOrgStatus(message, 'busy', { sticky: true })
        }
      },
    })
    nodeLaunchQueues.set(node.id, { treeId: node.treeId, queue, resume: true })
    refreshTreeStartControls()
    refreshLaunchStatus()
    try {
      const report = await queue.done
      const result = report.results[0]
      // Cancel and navigation cannot erase a session already admitted by the
      // native host. Its normal Resume tail still owns and binds the receipt.
      if (result?.ok) return result.resumeResult
      const message = result?.message || (report.cancelled
        ? 'Queued Resume cancelled. The saved conversation and queued messages are kept.'
        : RESUME_PANEL.failed)
      if (!destroyed && treeStore === store) {
        if (options.out) options.out.textContent = message
        setOrgStatus(message, report.cancelled ? 'ok' : 'refuse', { sticky: true, code: result?.code || null })
      }
      options.onRefused?.({ code: result?.code || null, message, retryable: false,
        sessionId: result?.sessionId || null, ...(report.cancelled && !result?.sessionId ? { notStarted: true, cancelled: true } : {}) })
      return false
    } finally {
      if (nodeLaunchQueues.get(node.id)?.queue === queue) nodeLaunchQueues.delete(node.id)
      if (!destroyed && treeStore === store) { refreshLaunchStatus(); refreshTreeStartControls() }
    }
  }
  async function resumeNodeSessionUnguarded(node, { effort = null, out = null, deliverQueued = true, deferSeed = false, delegationToken = null, machineInitiated = false, onRefused = null, expectedResume = null, isCancelled = () => false, cleanupCancelledStart = false, requestedTier = null, accountChoice = undefined, beginContinuation = null } = {}) {
    if (requestedTier) node = { ...node, tier: requestedTier }
    if (accountChoice !== undefined) node = { ...node, accountChoice }
    const accountStart = slotAccountStartOptions(node, LAUNCH_TIERS.find(row => row.id === node?.tier)?.provider)
    if (!accountStart.ok) { if (out) out.textContent = accountStart.reason; return false }
    // A route change releases the view's store slots, not a real session that
    // is already opening. Keep its exact destinations across the handoff.
    const store = treeStore
    const resumedTranscripts = transcriptStore
    const origin = { createdAt: node.createdAt, sessionId: node.sessionId }
    let expectedSessionId = origin.sessionId
    let transitionCurrency = null
    const resumeCurrencyCurrent = () => store?.getNode(node.id)?.createdAt === origin.createdAt
      && (!cleanupCancelledStart || (!destroyed && treeStore === store))
      && (transitionCurrency ? transitionCurrency() === true : !isCancelled())
    const resumeChoiceCurrent = () => resumeCurrencyCurrent()
      && store?.getNode(node.id)?.sessionId === expectedSessionId
    const beginResumeContinuation = () => {
      if (!resumeChoiceCurrent()) return () => false
      transitionCurrency = beginContinuation ? beginContinuation() : () => !isCancelled()
      return resumeCurrencyCurrent
    }
    const restrictionRefusal = savedResearchRestrictionRefusal(node)
    if (restrictionRefusal) {
      if (out) out.textContent = restrictionRefusal.message
      return restrictionRefusal
    }
    let bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!store || !store.getNode(node?.id) || !bridge || typeof bridge.start !== 'function') {
      if (out) out.textContent = START_NEEDS_APP_TEXT()
      return false
    }
    /* A resume IS a start -- bridge.start, a real child process -- so the same
       switch decides it. Gating only the compose panel would leave "nothing
       here will start an agent" true of the dashed circle and false of every
       node already on the canvas. */
    if (!isWriteEnabled(START_CONTROL_FLAG)) {
      if (out) out.textContent = startControlOffReason()
      return false
    }
    if (nodeCleanupPending(node)) {
      if (out) out.textContent = startCleanupSentence()
      return false
    }
    // The canonical transcript loads asynchronously after a route opens. An
    // empty cache must not turn a native resume into an unrelated new session.
    try { if (resumedTranscripts?.ready) await resumedTranscripts.ready }
    catch (error) {
      if (out) out.textContent = 'The conversation could not be opened. Reopen the Trees page, then try Resume again.'
      return false
    }
    if (destroyed || treeStore !== store || isCancelled()) return false
    // Refuse a known provider mismatch before closing or replacing the saved session.
    let saved
    try {
      saved = resumedTranscripts?.readLatest
        ? await resumedTranscripts.readLatest(node.id)
        : resumedTranscripts?.get(node.id) || null
    } catch {
      if (out) out.textContent = 'The current conversation could not be read, so the agent was not restarted. Reopen the Trees page and try again.'
      return false
    }
    if (destroyed || treeStore !== store || isCancelled()) return false
    const resumeDecision = resumableThread({
      savedThreadId: saved && typeof saved.threadId === 'string' ? saved.threadId : null,
      savedProvider: saved && typeof saved.provider === 'string' ? saved.provider : null,
      provider: LAUNCH_TIERS.find(tier => tier.id === node.tier)?.provider || null,
    })
    if (resumeDecision.reason === 'provider-changed') {
      if (out) out.textContent = resumeDecision.message
      return false
    }
    const savedThreadId = resumeDecision.threadId
    const resumeTarget = { threadId: savedThreadId, account: saved?.account || null,
      provider: saved?.provider || null, profileId: startProfileId(node.treeId ? store.treeProfile(node.treeId) : null) }
    const queuedResumeChanged = () => {
      if (!expectedResume) return false
      const current = store.getNode(node.id)
      const latest = resumedTranscripts?.get(node.id)
      const matches = current && Object.entries(expectedResume.nodeIdentity).every(([key, value]) => current[key] === value)
        && (latest?.threadId || null) === expectedResume.threadId
        && (latest?.account || null) === expectedResume.account
        && (latest?.provider || null) === expectedResume.provider
        && startProfileId(current.treeId ? store.treeProfile(current.treeId) : null) === expectedResume.profileId
      if (matches) return false
      const message = 'The saved conversation or account changed while Resume waited. Review it before trying again.'
      if (out) out.textContent = message
      onRefused?.({ code: 'MC_TREE_COMMAND_SESSION_CHANGED', message, retryable: false, sessionId: null })
      return true
    }
    if (queuedResumeChanged()) return false
    let cleanupFailure = null
    const onCleanupRequired = ({ sessionId, code }) => {
      const attached = retainTreeSessionCleanup(store, node.id, sessionId, { detached: !resumeChoiceCurrent(), expectedNodeCreatedAt: origin.createdAt, expectedNodeSessionId: origin.sessionId, note: statusNote(startCleanupSentence()) })
      if (attached) expectedSessionId = sessionId
      cleanupFailure = { ok: false, sessionId, cleanupPending: true, code, sentence: startCleanupSentence() }
    }
    bridge = withRetainedStartIdentity(bridge, onCleanupRequired, store.getTree(node.treeId)?.researchProjectId || null)
    // A late admitted successor belongs to its opening request, never to a
    // node which has since taken the same identifier. Retain before any await.
    const closeCancelledResumeSession = async sessionId => {
      const ownsCleanup = () => RUN_SESSION_CLEANUPS.get(sessionId) === node.id
        && (!sessionNodeIds.has(sessionId) || sessionNodeIds.get(sessionId) === node.id)
      const current = store.getNode(node.id)
      if ((RUN_SESSION_CLEANUPS.has(sessionId) && RUN_SESSION_CLEANUPS.get(sessionId) !== node.id)
        || (sessionNodeIds.has(sessionId) && sessionNodeIds.get(sessionId) !== node.id)
        || (current?.sessionId === sessionId && current.createdAt !== origin.createdAt)) return false
      retainTreeSessionCleanup(store, node.id, sessionId, { detached: true, note: statusNote(startCleanupSentence()) })
      const obligation = RUN_SESSION_CLEANUP_OBLIGATIONS.get(sessionId)
      if (!obligation || obligation.nodeId !== node.id || !ownsCleanup()) return false
      let closed = null
      try { closed = await bridge.close({ sessionId }) } catch { /* retain the exact obligation */ }
      const latest = store.getNode(node.id)
      if (closed?.closed === true && closed.ok !== false && closed.sessionId === sessionId
        && RUN_SESSION_CLEANUP_OBLIGATIONS.get(sessionId) === obligation && ownsCleanup()
        && !(latest?.sessionId === sessionId && latest.createdAt !== origin.createdAt)) {
        RUN_SESSION_CLEANUPS.delete(sessionId)
        if (sessionNodeIds.get(sessionId) === node.id && latest?.sessionId !== sessionId) retireTreeSessionRuntime(sessionId)
      }
      if (!destroyed && treeStore === store) notifyNodeStatusListeners()
      return false
    }
    /* Resolve this BEFORE closing the old session. A stale role snapshot is a
       refused replacement, not a reason to destroy the still-reachable agent
       and only then discover the new one cannot be bound. */
    const identityRole = identityRoleForTreeNode(node?.role)
    const seatOutcome = await ensureSeatForNode(node, identityRole)
    if (destroyed || treeStore !== store || isCancelled()) return false
    if (queuedResumeChanged()) return false
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) {
      if (out) out.textContent = startControlOffReason()
      return false
    }
    const boundRole = roleBindingForStart(node.id, identityRole, node.role)
    if (!seatOutcome?.ok || !boundRole.ok || !boundRole.binding?.agentId) {
      const identityReason = seatOutcome?.ok === false && seatOutcome.reason
        ? seatOutcome.reason
        : boundRole.message || 'This agent could not be given a declared identity, so it was not restarted. Reload this page, then try again.'
      if (out) out.textContent = identityReason
      setOrgStatus(identityReason, 'refuse', { sticky: true, code: seatOutcome?.code || boundRole.code || 'MC_TREE_IDENTITY_UNAVAILABLE' })
      return false
    }
    const oldSessionId = node.sessionId || null
    const profileId = expectedResume ? expectedResume.profileId : startProfileId(node.treeId ? store.treeProfile(node.treeId) : null)
    const savedLines = saved && Array.isArray(saved.lines) ? saved.lines : []
    const seedLines = savedLines
    /* The depth to resume at: the person's pick first, then whatever the
       session runs at now, then the depth the RECORD remembers (the live map
       is empty after an app restart — the record is why a hand-picked depth
       survives one), then the tier's own default. */
    const chosenEffort = effort || expectedResume?.effort || savedSessionEffort({ sessionEffort: oldSessionId ? sessionEfforts.get(oldSessionId) : null,
      savedEffort: saved?.effort, nodeEffort: node.effort, tierEffort: tierEffortOf(node.tier) })
    resumeTarget.effort = chosenEffort
    /* The host receives the predecessor id with the resume request and owns
       the close boundary. It keeps the running predecessor alive until the
       saved account has been admitted, so AGENT_RESUME_ACCOUNT_LIMIT cannot
       strand a conversation. Renderer maps are retired only after the new
       session is real; an admission refusal therefore leaves this state
       untouched and retryable. */
    if (destroyed || treeStore !== store || isCancelled()) return false
    if (queuedResumeChanged()) return false
    let result
    let seededSessionId = null
    let engineResumed = null
    /* THE REAL THING FIRST: codex keeps the conversation on disk, so the
       agent can continue ITS OWN memory instead of being handed a summary.
       No seed message, nothing re-sent, nothing charged. The excerpt path
       below stays exactly as it was, for a thread codex no longer has (it
       was pruned, the app moved machines, or the engine is older than the
       resume wiring) — and for a node that never got a thread id at all. */
    if (isWriteEnabled(START_CONTROL_FLAG) !== true) {
      if (out) out.textContent = startControlOffReason()
      return false
    }
    if (savedThreadId) {
      /* THE SAVED TREE, READ FRESH, FOR A CALL THAT SENDS NO BRIEF.
       *
       * A native resume restores the conversation itself -- no first turn, no
       * "Tree address: ..." line -- so shell/agent-host.cjs has nothing to
       * parse and would otherwise fall back to whatever managerName the
       * tree-node-directory row for the OLD session last carried. That row
       * predates any reparent done while this node was stopped: handleReparent
       * -> treeStore.moveNode() only ever writes the saved tree here, never
       * that directory. Reading node.parentId now, exactly as briefContextFor()
       * does for a fresh start, and sending it as resumeManagerName is what
       * lets the host prefer the truth over the stale row. null is sent on
       * purpose for a node the saved tree now puts at the top of its tree. */
      const parentNode = node.parentId ? store.getNode(node.parentId) : null
      const currentManagerName = parentNode ? (treeNodeName(parentNode) || null) : null
      let started = null, nativeRefusal = null
      try {
        started = await bridge.start({
          surface: 'fleet-tree',
          resumeThreadId: savedThreadId,
          ...accountStart.options,
          ...(delegationToken ? { delegationToken } : {}),
          resumeManagerName: currentManagerName,
          ...(saved && saved.account ? { resumeAccount: saved.account } : {}),
          ...(node.tier ? { tier: node.tier } : {}),
          ...(chosenEffort ? { effort: chosenEffort } : {}),
          ...(profileId ? { profileId } : {}),
          ...(oldSessionId ? { replacesSessionId: oldSessionId } : {}),
          ...(boundRole.binding ? { roleBinding: boundRole.binding } : {}),
          /* A RESUME CARRIES THE KEYS TOO — the standing-request block rides
             the resumed session's first turn, because a restart is exactly
             when a thread rule must be re-asserted. */
          requestKeys: nodeRequestKeys(node),
          treeIdentity: nodeTreeIdentity(node),
        })
      } catch (error) {
        nativeRefusal = error
      }
      if (started?.ok === false) nativeRefusal = started
      if (nativeRefusal) {
        const code = refusalCodeOf(nativeRefusal) || refusalCode(nativeRefusal)
        // The F1 wrapper has already retained every outcome except the two
        // exact request-bound released receipts. Preserve its fallback gate.
        if (cleanupFailure) result = cleanupFailure
        else if (machineInitiated || expectedResume || delegationToken || savedAccountResumeRefused(code) || isResourceHold(code)) {
          result = { ok: false,
            sessionId: typeof nativeRefusal.sessionId === 'string' && nativeRefusal.sessionId ? nativeRefusal.sessionId : null,
            threadId: savedThreadId, account: saved.account, code,
            sentence: readerRemedy(startRefusalSentence({ ok: false, code }), { viaRelay: currentDataSource() === 'relay' }) }
        }
        // Machine lifecycle calls return the refusal to their requester. An
        // absent delegation token does not make that request a person's click.
        const mayContinue = () => !machineInitiated && !cleanupFailure && !expectedResume && !delegationToken && resumeChoiceCurrent()
        if (mayContinue() && code === 'AGENT_RESUME_ACCOUNT_LIMIT'
          && refusalAttribution(nativeRefusal) === 'provider'
          && await keepTryingOnLimitIsOn() && mayContinue()) {
          // The coordinator may acquire this node only after the current
          // Resume lock has settled. Keep the exact choice currency across it.
          return { continueAfterResume: async () => {
            if (!mayContinue()) return false
            const continued = await continueNodeOnAnotherAccount(node, out, null, {
              isCurrent: resumeChoiceCurrent, beginContinuation: beginResumeContinuation,
            })
            if (!continued && mayContinue()) {
              if (out) out.textContent = result?.sentence || RESUME_PANEL.failed
              void offerSwitchAndContinue(node, { sentence: result?.sentence || '', refusedAccount: saved?.account || null })
            }
            return continued === true
          } }
        }
        if (mayContinue() && savedAccountResumeRefused(code)) {
          void offerSwitchAndContinue(node, { sentence: result?.sentence || '', refusedAccount: saved?.account || null })
        }
      }
      if (cleanupFailure) result = cleanupFailure
      if (started && started.ok !== false && typeof started.sessionId === 'string' && started.sessionId) {
        const resumedThreadId = started.threadId || savedThreadId
        const resumedAccount = typeof started.account === 'string' && started.account ? started.account : null
        const resumedRoleIntroduction = typeof started.roleIntroduction === 'string' ? started.roleIntroduction : null
        engineResumed = started.resumed || { turns: [], turnCount: 0 }
        result = started.ended === true
          ? endedAgentStartOutcome({
              sessionId: started.sessionId,
              threadId: resumedThreadId,
              roleIntroduction: resumedRoleIntroduction,
              code: started.endCode === 'MC_AGENT_SESSION_ENDED' ? started.endCode : 'MC_AGENT_SESSION_ENDED',
            })
          : {
              ok: true,
              sessionId: started.sessionId,
              threadId: resumedThreadId,
              account: resumedAccount,
              effort: typeof started.effort === 'string' && started.effort ? started.effort : null,
              roleIntroduction: resumedRoleIntroduction,
              sentence: null,
            }
        if (typeof started.effort === 'string' && started.effort) sessionEfforts.set(started.sessionId, started.effort)
      }
    }
    if (result?.ok === true && result.sessionId && cleanupCancelledStart && !resumeChoiceCurrent()) {
      await closeCancelledResumeSession(result.sessionId)
      return false
    }
    // Machine/delegated resumes and resource-queue retries cannot replace a
    // missing native thread with an ordinary transcript-seeded agent.
    if ((machineInitiated || delegationToken || expectedResume) && !result) {
      result = { ok: false, sessionId: null, threadId: savedThreadId,
        code: delegationToken ? 'TREE_DELEGATION_REFUSED' : 'MC_TREE_COMMAND_RESUME_REFUSED',
        sentence: delegationToken ? 'This conversation could not be resumed with its original tree authority. Review the circle before trying again.'
          : 'This saved conversation could not be resumed. Review it before trying again.' }
    }
    // A failed native resume may have awaited the provider. Only a new
    // fallback request is gated here; an opened session still must be owned.
    if (!result && (destroyed || treeStore !== store || !resumeChoiceCurrent())) return false
    if (!result && isWriteEnabled(START_CONTROL_FLAG) !== true) {
      if (out) out.textContent = startControlOffReason()
      return false
    }
    if (result) {
      /* nothing further: the engine restored the conversation itself */
    } else if (seedLines.length > 0 && !deferSeed) {
      const fallbackRequestId = globalThis.crypto?.randomUUID?.()
      if (!fallbackRequestId) return false
      result = await startAgentForNode({
        startRequestSessionId: fallbackRequestId,
        ...accountStart.options,
        beforeSessionOpen: ({ sessionId }) => resumeChoiceCurrent() || closeCancelledResumeSession(sessionId),
        text: 'Continue unfinished work from the saved conversation using the current task records. Do not restart completed work. If complete or waiting, report that briefly.',
        historyHandoff: transcriptSeedText(seedLines, { recoveryDirectory: saved?.recoveryDirectory, earlierMessages: Boolean(saved?.before) }),
        automatic: true,
        surface: 'fleet-tree',
        tier: node.tier,
        effort: chosenEffort,
        profileId,
        researchProjectId: store.getTree(node.treeId)?.researchProjectId || null,
        requestKeys: nodeRequestKeys(node),
        treeIdentity: nodeTreeIdentity(node),
        roleBinding: boundRole.binding,
        replacesSessionId: oldSessionId,
        onCleanupRequired,
        sessionIsOpen: sessionId => sessionNodeIds.has(sessionId),
        onSessionEnd: ({ sessionId }) => { retireTreeSessionRuntime(sessionId) },
        /* Bound before the seed is sent, for the reason startAgentForNode's
           note gives: a turn that starts answering before the send is answered
           would otherwise arrive for a session this page has never heard of.
           The block below sets the same key again, which costs nothing. */
        onSessionOpen: ({ sessionId, account }) => {
          if (!resumeChoiceCurrent()) {
            retainTreeSessionCleanup(store, node.id, sessionId, { detached: true, note: statusNote(startCleanupSentence()) })
            return false
          }
          const currency = beginResumeContinuation()
          if (!currency()) {
            retainTreeSessionCleanup(store, node.id, sessionId, { detached: true, note: statusNote(startCleanupSentence()) })
            return false
          }
          sessionNodeIds.set(sessionId, node.id)
          sessionAccountNames.set(sessionId, account || null)
          // Move the earlier words before publishing the new address. A send
          // after attachSession otherwise reaches the destination queue first.
          if (oldSessionId) outboxMoveSession(oldSessionId, sessionId)
          store.attachSession(node.id, sessionId)
          expectedSessionId = sessionId
          seededSessionId = sessionId
          store.setNodeStatus(node.id, 'running', { note: '' })
          rememberBoundSessionProfile(sessionId, node.id, profileId, store)
          if (!destroyed && treeStore === store) {
            refreshTree()
            rebindRailToSession(node.id)
          }
          return true
        },
      })
    } else {
      let started = null
      try {
        started = await bridge.start({
          ...accountStart.options,
          surface: 'fleet-tree',
          ...(deferSeed && seedLines.length > 0 ? { historyHandoff: transcriptSeedText(seedLines, {
            recoveryDirectory: saved?.recoveryDirectory, earlierMessages: Boolean(saved?.before),
          }) } : {}),
          ...(node.tier ? { tier: node.tier } : {}),
          ...(chosenEffort ? { effort: chosenEffort } : {}),
          ...(profileId ? { profileId } : {}),
          ...(oldSessionId ? { replacesSessionId: oldSessionId } : {}),
          ...(boundRole.binding ? { roleBinding: boundRole.binding } : {}),
          requestKeys: nodeRequestKeys(node),
          treeIdentity: nodeTreeIdentity(node),
        })
      } catch (error) { started = { ok: false, code: refusalCode(error) } }
      result = cleanupFailure || (started && started.ok !== false && typeof started.sessionId === 'string' && started.sessionId
        ? (started.ended === true
          ? endedAgentStartOutcome({
              sessionId: started.sessionId,
              threadId: typeof started.threadId === 'string' && started.threadId ? started.threadId : null,
              roleIntroduction: typeof started.roleIntroduction === 'string' ? started.roleIntroduction : null,
              code: started.endCode === 'MC_AGENT_SESSION_ENDED' ? started.endCode : 'MC_AGENT_SESSION_ENDED',
            })
          : {
              ok: true,
              sessionId: started.sessionId,
              threadId: typeof started.threadId === 'string' && started.threadId ? started.threadId : null,
              account: typeof started.account === 'string' && started.account ? started.account : null,
              effort: typeof started.effort === 'string' && started.effort ? started.effort : null,
              roleIntroduction: typeof started.roleIntroduction === 'string' ? started.roleIntroduction : null,
              sentence: null,
            })
        : { ok: false, sessionId: null, threadId: null, code: refusalCodeOf(started),
            sentence: readerRemedy(startRefusalSentence(started, { tier: node.tier }), { viaRelay: currentDataSource() === 'relay' }) })
    }
    if (!result.ok || !result.sessionId) {
      // Refusal cannot revive a cancelled choice or overwrite its newer status.
      // Exact old cleanup custody was retained independently before publication.
      if (!resumeChoiceCurrent()) return false
      const resourceHold = !result.sessionId && isResourceHold(result.code)
      if (store) {
        if (result.sessionEnded === true && result.sessionId) {
          store.attachSession(node.id, result.sessionId)
          retireTreeSessionRuntime(result.sessionId)
          const endedNode = store.getNode(node.id)
          if (endedNode && (endedNode.status === 'starting' || endedNode.status === 'running')) {
            store.setNodeStatus(node.id, endedNode.status, { note: statusNote(ENDED_SESSION.note) })
          }
        } else if (!resourceHold) {
          store.setNodeStatus(node.id, 'failed', { note: statusNote(result.sentence || RESUME_PANEL.failed) })
        }
        if (!destroyed && treeStore === store) refreshTree()
      }
      if (out && !destroyed) out.textContent = result.sentence || RESUME_PANEL.failed
      // No replacement session or turn failed. Keep the stopped outcome and
      // show the attempted Resume's refusal separately across the rail remount.
      if (resourceHold && !destroyed && treeStore === store) {
        setOrgStatus(result.sentence || RESUME_PANEL.failed, 'refuse', { sticky: true, code: result.code })
      }
      if (typeof onRefused === 'function') onRefused({ code: result.code || null,
        message: result.sentence || RESUME_PANEL.failed, retryable: resourceHold, sessionId: result.sessionId || null,
        ...(resourceHold && savedThreadId ? { resumeTarget } : {}) })
      /* THE RAIL IS RECONCILED ON THE WAY OUT OF THIS BRANCH, not only on the
         way out of the successful one. The tail below remounts unconditionally
         and this return is above it, so a resume whose session the engine
         reports ENDED attached that session -- "a session that is over is
         still a session" -- and then left the open rail on the panel it was
         built with, which is startDraftNode's defect in the sibling path.
         AFTER the sentence above, deliberately: a remount replaces the panel
         `out` lives in, so writing to it afterwards would put the refusal on a
         detached element, which is the order the success tail already uses. */
      if (!destroyed && treeStore === store) rebindRailToSession(node.id)
      return false
    }
    /* RECORDED BEFORE THE POST-HANDOFF `destroyed` CHECK, DELIBERATELY -- this used to be
       `if (destroyed) return false` at the top of this function, ABOVE the
       `!result.ok` check, so it ran before anything below it had a chance to.
       The session is real by this point: bridge.start answered with a live
       sessionId. A resume is slow by design (a real child process plus
       account resolution -- see agent-session.js's own note on start), so a
       person pressing Resume and then clicking to another page before it
       answered hit exactly this: the resume succeeded, and the old check
       discarded it before sessionNodeIds.set or treeStore.attachSession ever
       ran. The session then kept running -- a real process, spending on the
       person's own account -- with nothing on any node pointing at it, so
       nothing on screen could reach it again; only quitting the whole app
       ended it. Only the screen-touching tail below still checks `destroyed`,
       the same split startAgentForNode's onSessionOpen already uses (see its
       own comment: "closing a page is not a reason to stop it"). */
    if (seededSessionId === result.sessionId && !resumeChoiceCurrent()) {
      // The opening send was accepted. Keep that fact and its exact custody,
      // but never let an obsolete completion publish or drain a newer choice.
      if (sessionNodeIds.get(result.sessionId) === node.id
        && store.getNode(node.id)?.sessionId !== result.sessionId) {
        retainTreeSessionCleanup(store, node.id, result.sessionId, { detached: true, note: statusNote(startCleanupSentence()) })
      }
      return { ok: true, deliveryDisposition: 'accepted', sessionId: result.sessionId, stale: true }
    }
    // Deferred history bypasses startAgentForNode's pre-open hook. Preserve
    // its choice/cancellation boundary before publishing this idle successor.
    if (deferSeed && !engineResumed && (!resumeChoiceCurrent() || !beginResumeContinuation()())) {
      await closeCancelledResumeSession(result.sessionId)
      return false
    }
    const appliedEffort = typeof result.effort === 'string' && result.effort ? result.effort : chosenEffort
    if (requestedTier) store.setNodeLaunchPreferences(node.id, { tier: requestedTier, ...(appliedEffort ? { effort: appliedEffort } : {}) })
    sessionNodeIds.set(result.sessionId, node.id)
    /* The messages that were waiting for the old session are waiting for this
       one: same node, same conversation, same person still expecting them to
       go. Drained by the turn-completed listener like any other queued
       message -- or after the replacement flight settles, when the agent
       came back idle and there is no turn for them to wait behind. */
    if (oldSessionId) {
      outboxMoveSession(oldSessionId, result.sessionId)
      sessionTranscripts.delete(oldSessionId)
      sessionTurnLog.delete(oldSessionId)
      sessionUsage.delete(oldSessionId)
      sessionModelOverride.delete(oldSessionId)
      sessionPendingImages.delete(oldSessionId)
      resetSessionMetrics(oldSessionId)
      sessionNodeIds.delete(oldSessionId)
      sessionProfileIds.delete(oldSessionId)
      sessionEfforts.delete(oldSessionId)
      sessionThreadIds.delete(oldSessionId)
      sessionAccountNames.delete(oldSessionId)
      notifyNodeStatusListeners()
    }
    if (appliedEffort) sessionEfforts.set(result.sessionId, appliedEffort)
    if (result.threadId) sessionThreadIds.set(result.sessionId, result.threadId)
    sessionAccountNames.set(result.sessionId, result.account || null)
    /* THE CONVERSATION ON SCREEN IS THE ONE THE PERSON WAS ALREADY READING.
       A real resume changed nothing about the past -- that is what makes it
       free -- so nothing about the past changes here either. This used to
       rebuild the whole conversation from the engine's turns, believing them
       "longer and truer than the excerpt we kept"; measured, they are a
       speech-only projection that carries no tool actions and returns the
       product's two opening `you` lines as the one user message that went out.
       Rebuilding from them DELETED the person's opening request and every row
       showing what the agent did, and persistTranscript below then wrote that
       over the only durable copy. See src/tree-resume-transcript.js, which the
       suite drives; this file cannot be imported by a test process. */
    const resumedLines = resumedTranscriptLines({
      engineResumed,
      savedLines,
      marker: RESUME_PANEL.marker,
    })
    sessionTranscripts.set(result.sessionId, result.roleIntroduction
      ? [...resumedLines, { who: 'you', text: result.roleIntroduction, at: Date.now() }]
      : resumedLines)
    nodeActivity.delete(node.id)
    if (store) {
      store.attachSession(node.id, result.sessionId)
      rememberBoundSessionProfile(result.sessionId, node.id, profileId, store)
      /* An engine-resumed agent is idle. A seeded one may already have
         completed or been halted before its send acknowledgement arrived. */
      const settledSeed = store.getNode(node.id)
      const seedSettled = !engineResumed && !deferSeed && seedLines.length > 0 && ['finished', 'turn-failed', 'interrupted', 'cancelled'].includes(settledSeed?.status)
      const status = engineResumed || deferSeed ? 'finished' : (seedLines.length > 0
        ? (seedSettled ? settledSeed.status : 'running') : 'finished')
      store.setNodeStatus(node.id, status, { note: seedSettled ? settledSeed.statusNote : statusNote(engineResumed ? RESUME_PANEL.continued : RESUME_PANEL.done) })
      if (!destroyed && treeStore === store) refreshTree()
    }
    persistTranscript(result.sessionId, { transcripts: resumedTranscripts, trees: store })
    // The wrapper releases an idle queue after the replacement flight. This
    // also covers a seed turn which finished before its send acknowledgement.
    /* The caller needs to know which resume happened to report the summary
       cost and to preserve attachments that cannot enter the text outbox. */
    if (destroyed || treeStore !== store) return engineResumed ? 'engine' : deferSeed ? 'ready' : true
    if (out) out.textContent = engineResumed ? RESUME_PANEL.continued : RESUME_PANEL.done
    graph?.refreshConversation?.(node.id)
    deferRailRebuildWhileTyping(() => {
      if (controlsPage.classList.contains('is-active') && currentRailTreeNode && currentRailTreeNode.id === node.id) {
        showTreeNodeControls(treeStore ? treeStore.getNode(node.id) || node : node)
      }
    })
    return engineResumed ? 'engine' : deferSeed ? 'ready' : true
  }

  async function runPaletteAction(id, node, out) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const workspace = chatWorkspace ? [...workspaceChats].find(surface => surface.nodeId === node.id) : null
    if (id === 'child') {
      openComposeFor({ kind: 'child', parentId: node.id })
      return
    }
    /* The four navigational verbs, retargeted for the popup era (iteration
       6): model and rewind open the chat's actions popup straight at their
       stage; queue focuses the composer (the composer IS the queue while
       the agent works); move focuses the Details tab's Reports-to menu. */
    if (id === 'queue') {
      if (workspace) { workspace.root?.querySelector('.chat-input input')?.focus(); return }
      showTreeNodeControls(node)
      controlsPage.querySelector('[data-rail-chat-host] .chat-input input')?.focus?.()
      return
    }
    if (id === 'move') {
      focusDetailsControl(node, '[data-tree-move-select]')
      return
    }
    if (id === 'switch-model' || id === 'rewind') {
      if (workspace) { workspace.openActions(id === 'rewind' ? 'rewind' : 'model'); return }
      showTreeNodeControls(node)
      railChat?.root?.openActions?.(id === 'rewind' ? 'rewind' : 'model')
      return
    }
    if (id === 'attach') {
      if (!bridge || typeof bridge.pickAttachment !== 'function' || !node.sessionId) { out.textContent = START_NEEDS_APP_TEXT(); return }
      let picked = null
      try { picked = await bridge.pickAttachment({ sessionId: node.sessionId }) } catch { picked = null }
      if (!picked || !picked.path) { out.textContent = PALETTE_PANEL.attachCancelled; return }
      const held = sessionPendingImages.get(node.sessionId) || []
      held.push({ path: picked.path })
      sessionPendingImages.set(node.sessionId, held.slice(0, 8))
      out.textContent = PALETTE_PANEL.attachPicked
      return
    }
    if (id === 'clear') {
      const result = await freshStartExistingNode(node)
      out.textContent = result?.ok ? PALETTE_PANEL.cleared
        : readerRemedy(restartRefusalSentence(result, { tier: node?.tier }), { viaRelay: currentDataSource() === 'relay' })
      markRefusalCode(out, result)
      if (result?.ok && controlsPage.classList.contains('is-active') && currentRailTreeNode && currentRailTreeNode.id === node.id) {
        showTreeNodeControls(treeStore ? treeStore.getNode(node.id) || node : node)
      }
      return
    }
    if (id === 'resume') {
      /* nodeBusy, not the saved status. "It is busy, wait" over a session that
         died with the last shutdown is the refusal that left a person with no
         way out of this node at all: Resume refused for being busy, Stop
         standing over a corpse. */
      if (nodeBusy(node)) { out.textContent = RESUME_PANEL.busy; return }
      if (!transcriptStore || !transcriptStore.has(node.id)) { out.textContent = RESUME_PANEL.nothing; return }
      await resumeNodeSession(node, { out })
      return
    }
    if (id === 'mention') {
      if (!bridge || typeof bridge.pickMention !== 'function' || !node.sessionId) { out.textContent = START_NEEDS_APP_TEXT(); return }
      let picked = null
      try { picked = await bridge.pickMention({ sessionId: node.sessionId }) }
      catch (error) { out.textContent = mentionRefusalSentence(error); return }
      if (!picked || picked.ok !== true) { out.textContent = PALETTE_PANEL.mentionFailed; return }
      /* ITS OWN SENTENCE. This branch used to reuse the attach branch's cancel
         line, "Nothing was attached.", which is true of a different action. A
         person who had just pressed Mention and closed the picker read a
         sentence about Attach. */
      if (!picked || !picked.path) { out.textContent = PALETTE_PANEL.mentionCancelled; return }
      if (!workspace) showTreeNodeControls(node)
      /* Into the chat composer — the queue box retired with the Actions
         tab; the composer is where a mention's path belongs now. */
      const input = workspace?.root?.querySelector('.chat-input input') || controlsPage.querySelector('[data-rail-chat-host] .chat-input input')
      if (input) {
        input.value = input.value ? `${input.value} ${picked.path}` : `Read ${picked.path} and use it for what I ask next.`
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
      }
      out.textContent = PALETTE_PANEL.mentionWritten
      return
    }
    if (id === 'copy-brief' || id === 'copy-reply') {
      const text = id === 'copy-brief' ? (node.message || '') : (nodeReplies.get(node.id) || node.reply || '')
      if (!text) { out.textContent = PALETTE_PANEL.nothingToCopy; return }
      try {
        await navigator.clipboard.writeText(text)
        out.textContent = PALETTE_PANEL.copied
      } catch {
        out.textContent = PALETTE_PANEL.clipboardRefused
      }
      return
    }
    if (id === 'interrupt') {
      cancelPendingModelChoice(node.id)
      if (!bridge || typeof bridge.interrupt !== 'function' || !node.sessionId) { out.textContent = START_NEEDS_APP_TEXT(); return { ok: false } }
      const interruptedApprovals = sessionPendingApprovals.all(node.sessionId)
      try {
        await turnInterrupts.request(node.sessionId, sessionOpenTurns.get(node.sessionId),
          () => bridge.interrupt({ sessionId: node.sessionId }))
        clearSessionApprovals(node.sessionId, interruptedApprovals)
        out.textContent = PALETTE_PANEL.interruptDone
        return { ok: true }
      } catch (error) {
        /* ONLY "no running turn" IS A MISS. MEASURED 2026-09-03 on the owner's
           running instance: a session the engine had already fail-closed
           (CODEX_PROTOCOL_INVALID) rejected Halt with a hard error, and this
           catch reported it as "Nothing was interrupted; the turn may already
           be over" -- a reassuring no-op for a dead session, which is why a
           broken engine presented as "none of the controls work". A miss is
           AGENT_TURN_NONE; everything else is named with its bounded code so
           the owner can tell a dead session from an idle one. */
        const code = refusalCode(error)
        out.textContent = code === 'AGENT_TURN_NONE' || code === null
          ? PALETTE_PANEL.interruptMissed
          : PALETTE_PANEL.interruptFailed(code)
        if (code === 'AGENT_TURN_NONE' && treeStore && stopStillOwnsNode(node.sessionId, treeStore.getNode(node.id))) {
          clearSessionApprovals(node.sessionId, interruptedApprovals)
          // The host proved this session idle even if its completion packet
          // was missed. Do not leave the next explicit send parked as busy.
          treeStore.setNodeStatus(node.id, 'finished', { note: '' })
          refreshTree()
          notifyNodeStatusListeners()
        }
        return { ok: code === 'AGENT_TURN_NONE', settled: code === 'AGENT_TURN_NONE' }
      }
    }
    if (id === 'stop') {
      cancelPendingModelChoice(node.id)
      const retryWasEnabled = recoveryCoordinator()?.retryPolicy(node.id)?.enabled === true
      try {
        if (await recoveryCoordinator()?.stopContinuation(node.id)) {
          out.textContent = 'Stopping the saved continuation…'
          return
        }
      } catch { out.textContent = PALETTE_PANEL.stopFailed; return }
      if (retryWasEnabled && !sessionNodeIds.has(node.sessionId) && !RUN_SESSION_CLEANUPS.has(node.sessionId)) {
        treeStore?.setNodeStatus(node.id, 'finished', { note: 'Stopped by you.' })
        paintAccountRetryControls(node.id); out.textContent = 'Automatic retries stopped.'; return
      }
      if (!bridge || typeof bridge.close !== 'function' || !node.sessionId) { out.textContent = START_NEEDS_APP_TEXT(); return }
      const result = await closePersonNode(node, request => bridge.close(request))
      if (!result.closed) { out.textContent = PALETTE_PANEL.stopFailed; return }
      out.textContent = result.dropped > 0
        ? `${PALETTE_PANEL.stopped} ${result.dropped} queued message${result.dropped === 1 ? ' was' : 's were'} dropped.`
        : PALETTE_PANEL.stopped
    }
  }

  function closePersonNode(node, close, hosted = false) {
    cancelPendingModelChoice(node.id)
    const store = treeStore
    const ownsNode = () => {
      const latest = store?.getNode(node.id)
      return stopStillOwnsNode(node.sessionId, latest) && (!hosted ||
        (latest.treeId === node.treeId && latest.parentId === node.parentId && latest.createdAt === node.createdAt))
    }
    return stopNativePersonSession(node, {
      close, current: () => !destroyed && treeStore === store,
      forgetCleanup: sessionId => RUN_SESSION_CLEANUPS.delete(sessionId),
      clearOutbox: outboxClearSession, settle: settleStoppedSession,
      retire: retireTreeSessionRuntime, resetMetrics: resetSessionMetrics, ownsNode,
      saveStopped: () => {
        const result = store.setNodeStatus(node.id, 'finished', { note: 'Stopped by you.' })
        RUN_NODE_REMOVAL_CLOSE_RECEIPTS.set(node.sessionId, JSON.stringify(store.getNode(node.id)))
        refreshTree()
        return result
      },
      recorded: () => ownsNode() && store.getNode(node.id)?.status === 'finished'
        && store.getNode(node.id)?.statusNote === 'Stopped by you.' && !store.snapshot()?.persistenceFailed,
    })
  }

  function hostedStopNode(target) {
    if (destroyed || currentDataSource() !== 'local' || !treeStore || treeStoreId !== 'this-computer') return null
    const node = treeStore.getNode(target?.nodeId)
    if (!node || target?.version !== 1 || node.treeId !== target.treeId || node.sessionId !== target.sessionId
        || !sessionNodeIds.has(node.sessionId) || startingNodeIds.has(node.id)
        || startDraftFlight.busy(node.id) || nodeReplacementFlight.busy(node.id)
        || recoveryCoordinator()?.isRecovering(node.id) || recoveryCoordinator()?.isContinuing(node.id)
        || recoveryCoordinator()?.retryPolicy(node.id)?.enabled === true) return null
    return node
  }

  const nodeBranchRemovalFlight = createSingleFlight()

  function nodeRemovalBlock(node) {
    if (!node) return 'That agent is no longer in this tree.'
    if (nodeCleanupPending(node)) return `${treeNodeName(node)}: ${startCleanupSentence()}`
    if (startDraftFlight.busy(node.id) || nodeReplacementFlight.busy(node.id) || recoveryCoordinator()?.isRecovering(node.id)) {
      return `Wait for ${treeNodeName(node)} to finish starting or restarting.`
    }
    return nodeBusy(node) ? `Stop ${treeNodeName(node)} first.` : null
  }

  async function performNodeBranchRemoval(plan, store, name) {
    const outcome = await nodeBranchRemovalFlight.run(plan.rootId, () => performConfirmedBranchRemoval(plan, store, name))
    if (!outcome.ran) {
      setOrgStatus('This branch is already being removed.', 'refuse')
      return false
    }
    return outcome.value
  }

  async function performConfirmedBranchRemoval(plan, store, name) {
    const isCurrent = () => !destroyed && treeStore === store
    const warnings = []
    let failureOptions = null
    const result = await runNodeRemoval(plan, {
      store, isCurrent, blocked: nodeRemovalBlock,
      remove: async (node, branchGuard) => {
        const messages = []
        const ok = await performNodeRemoval(node, {
          branchGuard, quiet: plan.count > 1,
          onStatus: (message, tone, options) => {
            messages.push({ message, tone })
            if (tone === 'warn') warnings.push(message)
            if (tone === 'refuse') failureOptions = options
          },
        })
        return { ok, problems: ok ? [] : [messages.at(-1)?.message || REMOVE_PANEL.notRemoved] }
      },
    })
    if (!isCurrent()) return false
    if (!result.ok) {
      const progress = result.removed.length ? `Removed ${result.removed.length} of ${plan.count} agents. The remaining agents were kept. ` : ''
      setOrgStatus(progress + (result.problems[0] || REMOVE_PANEL.notRemoved), 'refuse', { ...failureOptions, sticky: true })
    } else if (plan.count > 1) {
      const done = `Removed ${name} and its branch (${result.removed.length} agents). The signed run records are kept.`
      setOrgStatus(warnings.length ? `${done} ${warnings.join(' ')}` : done, warnings.length ? 'warn' : 'ok', { sticky: warnings.length > 0 })
    }
    return result.ok
  }

  /* THE REMOVAL — the missing leg of the tree verbs (owner finding, verbatim:
   * "there was also no way to remove an old node you wanted to delete").
   *
   * WHAT GOES AND WHAT STAYS IS A FIXED CONTRACT, the one the confirm stage
   * just read out. Goes: the node's record in the tree store (its tree too,
   * when it was the last agent in it), the durable conversation for the node
   * — through session-transcript-store's OWN remove(), never a hand on its
   * key — and this window's node- and session-keyed caches, so no ghost
   * reply can resurface on a later node. Stays: the signed run records. They
   * are the permanent record of what ran on this machine and nothing on this
   * path reaches them.
   *
   * THE STORE IS THE GATE, NOT THIS FUNCTION. removeNode() refuses a live
   * agent and a parent with agents under it, in the same exported sentences
   * the palette row shows — so the re-check here on a race (a queued message
   * put the agent back to work while the confirm stage sat open) speaks the
   * store's words, and any store refusal is reported as it came. The only
   * session this function closes is the removed node's own reachable one; a
   * record orphaned by shutdown is let go through detachSession, the store's
   * documented verb for exactly that state. */
  async function performNodeRemoval(node, { branchGuard = null, onStatus = null, quiet = false } = {}) {
    const reportRemoval = (message, tone, options) => {
      onStatus?.(message, tone, options)
      setOrgStatus(message, tone, options)
    }
    if (!treeStore) return false
    const live = treeStore.getNode(node.id)
    if (!live) return false
    if (branchGuard && !branchGuard()) {
      reportRemoval('This branch changed after the removal preview. Review it and confirm again.', 'refuse', { sticky: true })
      return false
    }
    if (nodeCleanupPending(live)) {
      reportRemoval(startCleanupSentence(), 'refuse', { sticky: true, code: 'AGENT_SESSION_CLEANUP_FAILED' })
      return false
    }
    if (nodeBusy(live) || startDraftFlight.busy(live.id) || nodeReplacementFlight.busy(live.id)) {
      reportRemoval(NODE_REMOVE_REFUSALS.running, 'refuse', { sticky: true })
      return false
    }
    if (treeStore.childrenOf(live.id).length) {
      reportRemoval(NODE_REMOVE_REFUSALS.children(treeStore.childrenOf(live.id).length), 'refuse', { sticky: true })
      return false
    }
    const name = treeNodeName(live)
    const sessionId = live.sessionId || null
    const original = JSON.stringify(live)
    if (RUN_NODE_REMOVAL_CLOSE_RECEIPTS.has(sessionId) && RUN_NODE_REMOVAL_CLOSE_RECEIPTS.get(sessionId) !== original) {
      RUN_NODE_REMOVAL_CLOSE_RECEIPTS.delete(sessionId)
    }
    const stillOwnsRemoval = () => treeStore && !destroyed
      && (!branchGuard || branchGuard())
      && JSON.stringify(treeStore.getNode(live.id)) === original
      && !startDraftFlight.busy(live.id)
      && !nodeReplacementFlight.busy(live.id)
      && !nodeBusy(treeStore.getNode(live.id))
      && !nodeCleanupPending(treeStore.getNode(live.id))
      && !treeStore.childrenOf(live.id).length
    const staleRemoval = () => {
      RUN_NODE_REMOVAL_CLOSE_RECEIPTS.delete(sessionId)
      reportRemoval('The node was kept because it changed while removal was pending. Review it before trying again.', 'refuse', { sticky: true })
      return false
    }
    if (sessionId) {
      if (nodeSessionLive(live) && RUN_NODE_REMOVAL_CLOSE_RECEIPTS.get(sessionId) !== original) {
        const bridge = typeof window === 'undefined' ? null : window.mcAgent
        try {
          if (!bridge || typeof bridge.close !== 'function') throw new Error('AGENT_SESSION_CLEANUP_FAILED')
          const receipt = await bridge.close({ sessionId })
          if (receipt?.closed !== true || receipt?.ok === false
            || (receipt.sessionId !== undefined && receipt.sessionId !== sessionId)) throw new Error('AGENT_SESSION_CLEANUP_FAILED')
          RUN_NODE_REMOVAL_CLOSE_RECEIPTS.set(sessionId, original)
        } catch (error) {
          // An ended/unknown session error is not proof that owned resources
          // and authority were cleaned up. Keep the exact Stop retry target.
          if (stillOwnsRemoval()) RUN_SESSION_CLEANUPS.set(sessionId, live.id)
          reportRemoval(startCleanupSentence(), 'refuse', { sticky: true, code: refusalCode(error) || 'AGENT_SESSION_CLEANUP_FAILED' })
          return false
        }
        if (!stillOwnsRemoval()) return staleRemoval()
      }
    }
    let transcriptArchive = null
    if (transcriptStore?.archive) {
      try { transcriptArchive = await transcriptStore.archive(live.id) }
      catch (error) { reportRemoval('The node was kept because its conversation could not be archived: ' + error.message, 'refuse', { sticky: true }); return false }
    }
    if (!stillOwnsRemoval()) {
      if (transcriptArchive?.archiveId) {
        try { await transcriptStore.cancelArchive(live.id, transcriptArchive.archiveId) } catch { /* Keep the conversation and graph; never commit this stale archive. */ }
      }
      return staleRemoval()
    }
    if (live.status === 'starting' || live.status === 'running') treeStore.detachSession(live.id)
    const result = treeStore.removeNode(live.id)
    if (!result.ok) {
      if (transcriptArchive?.archiveId) void transcriptStore.cancelArchive(live.id, transcriptArchive.archiveId)
      reportRemoval(result.problems[0] || REMOVE_PANEL.notRemoved, 'refuse', { sticky: true })
      return false
    }
    treeChatDrafts.forget(treeStoreId, live.id)
    /* The seat this node held, if any, goes with it. A refusal here (for
       example a stale revision) is reported in the org status line below and
       never reverses a removal that already succeeded. */
    if (transcriptStore?.commitArchive) {
      try { await transcriptStore.commitArchive(live.id, transcriptArchive?.archiveId) }
      catch (error) { reportRemoval('The node closed. Check the archive folder listed in Settings → Data & Privacy. Conversation cleanup failed: ' + error.message, 'warn', { sticky: true }) }
    }
    const seatReleaseRefused = await releaseSeatForNode(live.id)
    if (seatReleaseRefused) onStatus?.(`The organisation seat for "${live.id}" could not be released.`, 'warn')
    /* The durable conversation leaves through the store's own door. */
    if (!transcriptStore?.archive) transcriptStore?.remove(live.id)
    diffHistoryStore?.remove(live.id)
    nodeDiffHistories.delete(live.id)
    /* This window's caches — node-keyed, then everything keyed by the session
       the node held, so nothing can deliver into a record that is gone. */
    nodeReplies.delete(live.id)
    nodeActivity.delete(live.id)
    nodeLastTool.delete(live.id)
    if (sessionId) {
      RUN_NODE_REMOVAL_CLOSE_RECEIPTS.delete(sessionId)
      resetSessionMetrics(sessionId)
      outboxClearSession(sessionId)
      sessionTranscripts.delete(sessionId)
      sessionTurnLog.delete(sessionId)
      sessionTurnText.delete(sessionId)
      sessionUsage.delete(sessionId)
      sessionModelOverride.delete(sessionId)
      sessionPendingImages.delete(sessionId)
      clearSessionApprovals(sessionId)
      turnInterrupts.forget(sessionId)
      sessionNodeIds.delete(sessionId)
      sessionProfileIds.delete(sessionId)
      sessionEfforts.delete(sessionId)
      sessionThreadIds.delete(sessionId)
      sessionAccountNames.delete(sessionId)
      sessionActions.delete(sessionId)
      chatSurfaces.delete(sessionId)
      turnReplies.delete(sessionId)
    }
    /* The canvas repaints without the node. A drill rooted AT it re-roots on
       its parent — the removed node is always a leaf here — or zooms out when
       it stood alone. */
    if (graph && graph.rootId === live.id) {
      if (live.parentId) graph.setRoot?.(live.parentId)
      else graph.clearRoot?.()
    }
    refreshTree()
    /* The rail: railFollowsCanvas's conservative answer, for the same reason —
       the node it was showing cannot be on any canvas now, so back to the
       overview. */
    if (currentRailTreeNode && currentRailTreeNode.id === live.id && controlsPage.classList.contains('is-active')) {
      showStats()
    }
    /* A sticky seat-release refusal just above is more informative than the
       ordinary "removed" line and must not be erased by it -- the node is
       gone from the canvas either way, which is the removal's own proof. */
    if (!seatReleaseRefused && !quiet) reportRemoval(REMOVE_PANEL.done(name), 'ok')
    try {
      window.dispatchEvent(new CustomEvent(TREE_NODE_REMOVED_EVENT, { detail: {
        computerId: treeStoreId, nodeId: live.id, sentence: REMOVE_PANEL.done(name),
      } }))
    } catch { /* a page with no listener loses nothing */ }
    return true
  }

  /* THE RAIL FOR A SELECTED EXAMPLE AGENT, in the tree rail's own shape.
   *
   * WHAT THE OWNER SAW, verified against his screenshots: with the second
   * render gone, a selected example agent was routed through
   * showProjectionControls — 'Recorded agent', 'What is on record' facts
   * first, Pause/Resume/Respawn and 'Open full view' underneath — which is
   * the OLD demonstration rail he had already rejected, now wearing the
   * projection rail's clothes. The surface his installed app actually shows
   * for a selected agent is showTreeNodeControls: 'Agent in your tree',
   * Chat/Details tabs, the conversation first, an honest composer.
   *
   * So the example presents its agents through THAT family. An example seat
   * is not a tree-store node, so showTreeNodeControls itself cannot be
   * reused — every live updater in it reads the store — but the rail is built
   * from its exact primitives: railTitleRow, the `.seg.rail-tabs` pair, the
   * `.rail-chat-body > .rail-chat-host` chat column (mountRailChat, tall,
   * the same seeded sample conversation the old rail showed — the one place
   * a composer answering itself is the product), and the Details tab's
   * `.agent-head` + `.board-box` stack. The record facts the projection rail
   * led with (id, provider, state, origin, runtime, tasks, and what the
   * record does not carry) are all still here, demoted to the Details tab
   * exactly as his live tree rail demotes a node's setup. Nothing honest is
   * lost; nothing is front and centre that is not the conversation.
   *
   * NO Pause/Resume/Respawn, NO 'Open full view': the tree rail has neither
   * (its verbs live in the chat composer's actions popup, and an example seat
   * has no verbs — nothing real can be done to it). The bar's own 'Open agent
   * detail' button still aims at the selected seat, as on every source. The
   * Start-work group rides in Details as on the tree rail, and under mock it
   * carries the stated-absence box (mountStartWorkControls' mock branch), so
   * the dd01899 fence — a demonstration screen must not dispatch a real agent
   * — still holds structurally.
   *
   * showProjectionControls is untouched: it is the rail for REAL declared
   * seats on local and relay, and it is reached from nowhere under mock. */

  /**
   * THE FOUR ANSWERS TO "HOW DOES WORK GET STARTED FROM THIS COMPUTER",
   * MOUNTED ON EVERY RAIL THAT IS ENTITLED TO THEM.
   *
   * WHAT WAS MEASURED, 2026-08-18, on a staged packaged build with a sterile
   * profile, driving with real input:
   *
   *   fleet page, nothing started        .static-tree-node 0, one empty slot
   *   press the slot, pick a role,       a node appears (status "did not start"
   *     write a brief, press Start       -- the engine is signed out) and its
   *                                      rail carries What it is doing / The
   *                                      conversation / Setup and NOTHING ELSE
   *   agent page, press Start            session opens; navigate to the fleet
   *                                      page and the surface's own teardown
   *                                      has closed it again, by design
   *
   * So the projection rail -- the ONLY builder of Launch, Team, Loop and Codex
   * Cloud -- was reached by selecting a node that is drawn only for a LIVE
   * session on a declared seat, and a live session cannot outlive the page that
   * owns it (src/agent-session.js's teardown calls publishLiveSession(null), and
   * src/agent-session-registry.js explains why it must). Those four controls
   * were therefore unreachable on every install, in every state, for anyone.
   * Four packaged drivers had been reporting it from four directions:
   * team-panel ("clicking an agent opens the rail board: absent"), loop, the
   * live half of example-page-write-fence, and refusal-copy's three
   * "UNMEASURED -- the control could not be reached".
   *
   * THE RAIL A PERSON ACTUALLY REACHES IS THE TREE NODE'S. That is the node the
   * fleet page's own start path creates, and it exists only on real sources by
   * construction -- the example fleet keeps no tree store (syncTreeStore), so
   * no tree node can appear there. The example-fence still holds and is now
   * decided HERE: when the source is mock, this function mounts the
   * stated-absence box instead of the four live controls, so a mock rail can
   * name the controls without ever building one.
   *
   * `live: true` is stated HERE and nowhere else, for the reason it was stated
   * on the projection rail: only a rail reading this computer may build a
   * control that reaches the audited bridge. One builder for both rails, so the
   * entitlement rule has one place to be right and the two rails cannot drift
   * into offering different controls for the same computer.
   */
  /* Remembered posture, not a setting. src/settings-presentation.js already
     ruled on this shape for its own open-groups memory: it "grants nothing,
     gates nothing, and the settings footer does not count it". Whether a person
     left a disclosure open is a scroll position, not a permission. */
  const START_WORK_OPEN_KEY = 'mc.rail.start-work-open'
  const startWorkWasOpen = () => {
    try { return localStorage.getItem(START_WORK_OPEN_KEY) === 'open' } catch { return false }
  }
  const rememberStartWork = open => {
    try { localStorage.setItem(START_WORK_OPEN_KEY, open ? 'open' : 'closed') } catch { /* session-only is still a real change */ }
  }

  function mountStartWorkControls(agent, slot) {
    if (!slot) return
    /* ONE GROUP, FOUR PANELS, NOTHING REMOVED. See START_WORK_GROUP in
       src/fleet-tree-copy.js for what was measured and why these four belong
       together. The button is a real button with aria-expanded and a chevron,
       and it names all four panels on its own line -- a disclosure a person
       cannot identify is worse than the scroll it saved. */
    const open = startWorkWasOpen()
    const bodyId = `start-work-${Math.random().toString(36).slice(2, 9)}`
    const group = el(`
      <div class="board-box board-ctl-box rail-group" data-start-work-group>
        <button class="rail-group-toggle" type="button" data-start-work-toggle aria-expanded="${open ? 'true' : 'false'}" aria-controls="${bodyId}">
          <span class="rail-group-chev" aria-hidden="true">⌄</span>
          <span class="rail-group-name">
            <span class="bh-t">${escapeMarkup(START_WORK_GROUP.title)}</span>
            <span class="board-cap">${escapeMarkup(START_WORK_GROUP.contents)}</span>
          </span>
        </button>
        <div class="rail-group-body" id="${bodyId}" data-start-work-body${open ? '' : ' hidden'}></div>
      </div>`)
    slot.replaceWith(group)
    const body = group.querySelector('[data-start-work-body]')
    const toggle = group.querySelector('[data-start-work-toggle]')
    toggle.setAttribute('aria-label', open ? START_WORK_GROUP.collapseLabel : START_WORK_GROUP.expandLabel)

    /* MOCK GETS THE GROUP AND A STATEMENT, NEVER THE CONTROLS. All four boxes
       reach real machinery -- Dispatch, Team and Loop post through the audited
       bridge, and the cloud box calls the cloud task bridge -- and on the
       desktop with the example on those bridges exist and would work. So the
       Start-work group stays on the mock rail, visible and named (nothing is
       hidden silently), and its body is the stated absence with the way to the
       real board -- the same sentence family every mock start surface answers
       with. The dd01899 fence, restated for the one render. */
    if (mockSource()) {
      body.appendChild(exampleControlsAbsentBox())
    } else {
      /* THE FOUR ARE BUILT AND MOUNTED EITHER WAY, open or closed. Building
         them lazily on first press would mean the live updaters that query
         these boxes find nothing until somebody presses, and a control that
         exists only after a gesture is the defect this rail already has a
         comment about. `hidden` is a paint decision; the boxes are real from
         the moment the rail is. */
      body.appendChild(launchControlsBox(agent, { live: true }))
      body.appendChild(teamControlsBox(agent, { live: true }))
      body.appendChild(loopControlsBox(agent, { live: true }))
      /* Codex Cloud sits with Launch, Team and Loop because it is the fourth
         answer to the same question -- how does work get started from this
         computer -- and the first one whose answer is "somewhere else". */
      boardCloudBox = cloudControlsBox()
      body.appendChild(boardCloudBox)
    }

    /* ALWAYS VISIBLE, NEVER BEHIND THIS DISCLOSURE. Everything above answers
       "how does work get started"; this answers a different question this
       group's own toggle must not gate: "is a goal already running on this
       agent, right now". Skipped under mock for the same reason the four
       start-work boxes are -- it calls window.mcAgent.goal, the real bridge
       a demonstration screen must never reach (dd01899). */
    if (!mockSource()) group.before(goalControlsBox(agent))

    toggle.addEventListener('click', () => {
      const nowOpen = toggle.getAttribute('aria-expanded') !== 'true'
      toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false')
      toggle.setAttribute('aria-label', nowOpen ? START_WORK_GROUP.collapseLabel : START_WORK_GROUP.expandLabel)
      body.hidden = !nowOpen
      rememberStartWork(nowOpen)
    })
  }

  function showProjectionControls(agent) {
    /* A node drawn for a conversation the computer listed is that conversation:
       it opens the conversation rail, not the fleet-record rail, whose Pause,
       Respawn and full-chat controls belong to a record and not to a session
       this browser may only read and send to. Null off the relay. */
    const desktopRow = desktopRowFor(agent?.sessionId)
    if (desktopRow) {
      setOpenTarget(agent)
      showDesktopSessionControls(desktopRow)
      return
    }
    clearBoard()
    const role = ROLES[agent.role] || ROLES.default
    paintRoleColor(controlsPage, agent.declaredRole || agent.role, agent.id)
    const runtime = Number.isFinite(agent.bornAt)
      ? fmtRuntime(agent.bornAt, Number.isFinite(agent.stoppedAt) ? agent.stoppedAt : Date.now())
      : null
    const taskSummary = Number.isFinite(agent.tasksDone)
      ? `${agent.tasksDone} tasks${Number.isFinite(agent.failRate) ? ` · ${agent.failRate}% fail` : ''}`
      : null
    /* `chat` and `tuning` have left this list. They were correct while the rail
       had neither; now the rail has a chatbox that states its own channel, and
       a control box whose knobs are real. Leaving them here would have the
       panel report two things missing while they sit above it. */
    const missing = [runtime === null ? 'runtime' : null, taskSummary === null ? 'task history' : null, 'activity'].filter(Boolean)
    /* DISPOSE BEFORE THE WIPE. The rule is stated where railChat is declared
       -- never innerHTML over a mounted chat -- and only showTreeNodeControls
       obeyed it. After any of the other three rebuilds, railChat survived
       pointing at a DETACHED root whose sessionId still matched, so the event
       listener kept opening streams and pushing every delta into a chat log
       that was no longer in the document: the answer was recorded and never
       seen (owner, 2026-08-18, "the messages in history disappear"). It also
       leaked that chat's observers, frames and timers. */
    disposeRailSaid()
    disposeRailChat()
    controlsPage.innerHTML = `
      ${railTitleRow({ back: { aria: 'Back to the fleet overview' }, title: 'Recorded agent' })}
      <div class="rail-scroll" data-live-mode="${mockSource() ? 'simulated' : 'live'}" data-projection-state="available">
        <div class="agent-head board-head"><span class="role-dot"></span><div><div class="an">${escapeMarkup(agent.name)}</div><div class="ar">${escapeMarkup(agent.declaredRole)}</div></div></div>
        <div class="board-box board-chat-box"></div>
        <div class="board-box board-ctl-box projection-state">
          <div class="board-box-h"><span class="bh-t">What is on record</span></div>
          <div class="rail-sub">ID · ${escapeMarkup(agent.id)}</div>
          <div class="rail-sub">Provider · ${escapeMarkup(agent.provider)}</div>
          <div class="rail-sub">State · ${escapeMarkup(agent.state)}</div>
          <div class="rail-sub">Origin · ${escapeMarkup(agent.origin || 'unresolved')}</div>
          ${runtime === null ? '' : `<div class="rail-sub">Runtime · ${escapeMarkup(runtime)}</div>`}
          ${taskSummary === null ? '' : `<div class="rail-sub">${escapeMarkup(taskSummary)}</div>`}
          <div class="projection-unavailable">${escapeMarkup(missing.join(', '))} unavailable · ${escapeMarkup(agent.projectionUnavailableReason)}</div>
        </div>
        <div class="board-role-slot"></div>
        <div class="board-launch-slot"></div>
      </div>
      <div class="board-actions">
        <div class="ctl-grid">${deadActionButtons()}</div>
        <button class="ctl-btn" data-a="open">Full chat view</button>
      </div>`
    mountRailChat(agent, role)
    mountRoleControl(agent, controlsPage.querySelector('.board-role-slot'))
    mountStartWorkControls(agent, controlsPage.querySelector('.board-launch-slot'))
    controlsPage.querySelector('.rail-back').addEventListener('click', showStats)
    controlsPage.querySelector('[data-a="open"]').addEventListener('click', () => graph?.openFullChat(agent.id))
    activateRail(controlsPage)
  }

  /**
   * THE ROLE OF THE SELECTED AGENT.
   *
   * Absence and an incomplete bridge are both stated outcomes. The box stays in
   * place, disabled with the organisation bridge's reason, rather than making a
   * missing control indistinguishable from a rendering defect. This function
   * owns what happens after a successful write, which is a full re-derivation —
   * a role decides a node's colour, its radius and its tier on the canvas, so it
   * is not a label the rail can repaint.
   */
  function mountRoleControl(agent, slot) {
    if (!slot) return
    const bridgeAtRender = orgBridge()
    const roleAvailability = orgAvailability.state === 'ready' && typeof bridgeAtRender?.assignRole !== 'function'
      ? { state: 'failed', ...ROLE_ASSIGN_UNAVAILABLE }
      : orgAvailability
    slot.replaceWith(buildRoleAssignBox({
      agent,
      availability: roleAvailability,
      onAssign: async (roleId) => {
        const bridge = orgBridge()
        if (!bridge || typeof bridge.assignRole !== 'function') {
          return { ok: false, ...ROLE_ASSIGN_UNAVAILABLE }
        }
        const version = fetchVersion
        let result
        try {
          result = await bridge.assignRole({
            agentId: agent.id,
            role: roleId,
            expectedRevision: orgAvailability.org?.revision,
          })
        } catch (error) {
          result = { ok: false, code: 'ORG_ASSIGN_ROLE_THREW', reason: `The role could not be sent to the organisation store: ${error?.message || error}` }
        }
        if (destroyed || version !== fetchVersion) return result
        if (result?.ok) {
          orgAvailability = { ...orgAvailability, org: result.org }
          setOrgStatus(`Saved. ${agent.name} is now ${roleId}.`, 'ok')
          reprojectFromOrg({ keepAgentId: agent.id })
          return result
        }
        if (isRevisionConflict(result)) {
          await refreshOrg()
          if (destroyed || version !== fetchVersion) return result
          reprojectFromOrg({ keepAgentId: agent.id })
          setOrgStatus(REVISION_CONFLICT_ADVICE, 'refuse', { sticky: true })
        }
        return result
      },
    }))
  }

  function loadRailRuns() {
    void (async () => {
      const raw = await globalThis.mcAgent?.history?.({}).catch(() => null)
      if (destroyed) return
      const local = readLocalSessions(raw ?? undefined)
      railRuns = local.runs
      railRunsSupported = local.supported
    })()
  }

  /* mountSimulation stood here: the second render's own mount, wired to
     src/sim.js's generated computers and its stats/tasks/spawn event stream.
     It went with the render. The example is mounted by mountMockFleet below,
     through the SAME mountProjection every real source uses, fed the
     deterministic sample record instead of a live one. */

  /* THE EMPTY STATE IS THE SHIPPING STATE.
   *
   * `public/data/fleet.json` ships as `{"ok": false, "data": null}` with the
   * reason "No local agent fleet host detected on this machine." — so this
   * branch, not the graph, is what every fresh install renders on this page.
   * It used to put one grey sentence into the RAIL and leave the whole central
   * panel blank. Every word of that sentence was true and it was still a dead
   * end: it named a failure without saying what the page is for, what would
   * fill it, or that a drill-in exists at all behind it.
   *
   * So the reason stays, verbatim and unsoftened — a fresh customer is entitled
   * to know their machine has no fleet host — and it now arrives inside an
   * explanation, in the central panel where the person is already looking.
   *
   * T302: the action this used to offer — "See an example agent", into the
   * #/agent drill-in's /example route — is gone along with that route
   * (route-parse.js no longer resolves it; the owner's complaint was the
   * drill-in surfacing with no sensible way in). emptyStateExample() below is
   * now a no-op left in place rather than inlined away, so this comment's
   * history stays attached to the one call site if the empty state ever
   * grows a real action again.
   */
  /* T302: THE #/agent DRILL-IN'S ONLY DOOR, CLOSED. This used to link to the
     example copy of the #/agent page (`#/agent/<comp>/<agent>/example`) --
     the one place in the product that could reach it. The owner's complaint
     was the page itself turning up with no sensible way in; route-parse.js no
     longer resolves that hash to anything, so this action would have led
     nowhere. Removed rather than pointed at a dead route. */
  function emptyStateExample() { return '' }

  /* A REAL-SOURCE STATE ONLY: the example record always mounts (sample-fleet
     cannot be empty or unreadable), so this is reached exclusively on local
     and relay, and its dataset stays 'live'. */
  function showProjectionUnavailable(reason, loading = false) {
    clearMountedGraph()
    clearBoard()
    /* There is no computer on this screen any more, so there is nothing for an
       open compose panel to start an agent ON. Leaving it would offer a form
       whose submit could only refuse. */
    closeComposePanel()
    releaseTreeStore()
    liveComputers = []
    computer = null
    authoritativeTreeSnapshot = null
    authoritativeTreeComputer = null
    declaredOnlyReason = null
    setOpenTarget(null)
    root.dataset.liveMode = 'live'
    root.dataset.projectionState = loading ? 'loading' : 'unavailable'
    if (source === 'relay') setDesktopTreeState(loading ? 'loading' : 'unavailable')
    if (chatOnly) {
      if (loading) {
        statsPage.innerHTML = '<p class="home-scope-empty" role="status">Opening conversation…</p>'
        activateRail(statsPage)
      } else {
        // A saved conversation belongs to its recorded computer even when
        // that computer cannot currently report fleet status. The session
        // controls still apply their usual availability and write gates.
        computer = { id: initialComputer, name: 'Saved computer', agents: [], services: [] }
        mountGraph()
        showStats()
        setOrgStatus('Fleet status is unavailable. See the saved conversation below.', 'warn', { sticky: true })
      }
      return
    }
    /* The badge follows the source, and this is a real-source state — but a
       mock→real flip lands here first (loadProjection's loading face), so the
       marking a mock mount left in the bar has to come off with it. */
    syncExampleBadge()
    /* THE WAY OFF A MACHINE THAT CANNOT BE READ IS THE BAR, so the bar is
       REDRAWN here rather than wiped. This branch is where a person lands when
       the computer they are driving stops answering, and emptying the one row
       of controls that could point them at their other computer would be the
       dead end this whole page keeps closing. `liveComputers` is empty by the
       line above, so with no account computers this draws nothing at all —
       which is exactly what the wipe it replaces did. */
    renderTabs()
    graphTitle.textContent = ''
    if (pageHeading) pageHeading.textContent = 'Computers'
    crumbElement.innerHTML = ''
    /* THE ROLE LIBRARY OUTLIVES THE FLEET.
       This is the state a fresh install actually opens in — public/data/fleet.json
       ships with ok:false — and roles are not a fact about a running fleet: they
       are the vocabulary an organisation is written in, and they can be prepared
       before any computer reports. Leaving the panel out here would have put the
       only way to reach it behind a host most copies do not have. */
    statsPage.innerHTML = `
      ${railTitleRow({ title: 'Runtime Statistics' })}
      <div class="projection-unavailable" data-live-mode="live" data-projection-state="${loading ? 'loading' : 'unavailable'}">${loading ? 'Reading your fleet…' : `The live fleet data could not be read · ${escapeMarkup(reason)}`}</div>
      ${loading ? '' : `<div class="rail-scroll rail-org-only">${orgSourceMarkup()}<div class="board-org-slot"></div></div>`}`
    /* DISPOSE BEFORE THE WIPE. The rule is stated where railChat is declared
       -- never innerHTML over a mounted chat -- and only showTreeNodeControls
       obeyed it. After any of the other three rebuilds, railChat survived
       pointing at a DETACHED root whose sessionId still matched, so the event
       listener kept opening streams and pushing every delta into a chat log
       that was no longer in the document: the answer was recorded and never
       seen (owner, 2026-08-18, "the messages in history disappear"). It also
       leaked that chat's observers, frames and timers. */
    disposeRailSaid()
    disposeRailChat()
    controlsPage.innerHTML = ''
    activateRail(statsPage)
    if (!loading) mountOrgLibrary(statsPage.querySelector('.board-org-slot'))

    clearEmptyPanel()
    if (loading) return
    /* The words are src/first-run-needs.js's, not this file's — see the import.
       `reasonClass` keeps `.graph-empty-reason`, which tools/agent-route-reachability.mjs
       reads: dropping the class would not fail that probe, it would make the
       probe quietly record an empty string, which is worse. The reason itself
       is still the projection's own sentence, verbatim. */
    emptyPanel = el(`
      <div class="graph-empty" data-projection-state="unavailable">
        ${hostAbsentMarkup(`The live fleet data could not be read · ${reason}`, { reasonClass: 'graph-empty-reason' })}
        ${emptyStateExample()}
      </div>`)
    /* THE SLOT, NOT THE WRAP — and this line THREW for as long as the graph bar
       has existed.
     *
     * What stood here was `graphWrap.insertBefore(emptyPanel, graphTitle)`, and
     * `.graph-title` has not been a child of `.graph-wrap` since the title, the
     * tree switcher and the tool buttons were gathered into `.graph-bar` (see
     * the markup above). It is a GRANDCHILD, so the browser answered
     * `NotFoundError: Failed to execute 'insertBefore' on 'Node': The node
     * before which the new node is to be inserted is not a child of this node.`
     *
     * MEASURED, 2026-08-18, on a staged packaged build: the throw is raised
     * inside loadProjection()'s `.then`, which sends it to the `.catch` beside
     * it, which calls this same function again, which throws again — an
     * unhandled rejection and NOT ONE WORD PAINTED. This is the branch a fresh
     * customer install reaches every time (public/data/fleet.json ships
     * `ok:false`), so the person whose fleet could not be read was shown a blank
     * area where the sentence explaining that was supposed to be, plus the
     * example that tells them what the page is for.
     *
     * The canvas slot is where the CANVAS goes (mountProjection, above), which
     * is exactly what the declaration of `emptyPanel` promises: "It occupies the
     * same slot the graph canvas does, so the two can never be on screen
     * together." Same slot, same prepend, one rule. */
    graphWrap.querySelector('.graph-canvas-slot').prepend(emptyPanel)
  }

  function mountProjection(data, { preferComputerId = null, declaredReason = declaredOnlyReason } = {}) {
    lastFleetData = data
    authoritativeTreeSnapshot = data?.authoritativeDesktopTree || null
    authoritativeTreeComputer = authoritativeTreeSnapshot ? desktopTreeComputer(authoritativeTreeSnapshot, drivenComputerCopy('This computer', 'The computer you are driving')) : null
    declaredOnlyReason = declaredReason
    /* THE SAVED ORGANISATION IS LAID OVER REAL SOURCES ONLY. Under mock the
       merge input is null even when orgAvailability still holds a reading (a
       real mount earlier in this view's life may have read it): your saved
       roles and hierarchy drawn over the example fleet would be real data in
       a badged box — the mixing the badge promises does not happen.
       mountMockFleet also resets the availability itself, so this null is the
       second lock on the same door. */
    const next = authoritativeTreeComputer
      ? [authoritativeTreeComputer]
      : projectionComputers(
        data,
        !mockSource() && orgReady() ? orgAvailability.org : null,
        !mockSource() && orgReady() ? orgAvailability.roles : [],
      )
    if (chatOnly && initialComputer && !next.some(candidate => candidate.id === initialComputer)) {
      showProjectionUnavailable('The selected computer is not in the current fleet.')
      return
    }
    if (!next.length) {
      showProjectionUnavailable('the fleet record lists no usable computers or relationships')
      return
    }
    clearMountedGraph()
    liveComputers = next
    /* `dataset.liveMode` is DOM vocabulary now, derived from the source axis:
       src/board.css keys on 'simulated' to hold the app-wide example toast
       off a page that is already carrying its own badge, and packaged drives
       read the attribute. The VALUE names what the person sees (an example
       face or their fleet), not which render runs — there is one render. */
    root.dataset.liveMode = mockSource() ? 'simulated' : 'live'
    root.dataset.projectionState = declaredOnlyReason ? 'declared' : 'available'
    if (authoritativeTreeSnapshot) setDesktopTreeState('available')
    computer = next.find(candidate => candidate.id === preferComputerId)
      || next.find(candidate => candidate.id === initialComputer)
      || next[0]
    renderTabs()
    mountGraph()
    void agentScreenVoice.refresh()
    showStats()
  }

  /* A native saved workspace is complete on its own. Only the legacy/local
     projection needs both fleet and organisation before it can be mounted. */
  function finishProjectionLoad() {
    const finish = resolveProjectionReady
    resolveProjectionReady = null
    finish?.()
  }

  function loadProjection() {
    const version = ++fetchVersion
    desktopTreeReadAt = Date.now()
    /* Commands can arrive as soon as the route mounts. Share the existing
       load's completion with them; opening the route is not proof that its
       computer and tree store have loaded. Overlapping loads keep this same
       promise, and only the newest projection may release it. */
    if (!resolveProjectionReady) {
      projectionReady = new Promise(resolve => { resolveProjectionReady = resolve })
    }
    showProjectionUnavailable('', true)
    /* STALENESS IS THE VERSION COUNTER'S JOB. Every remount bumps
       fetchVersion — this function's own ++, and mountMockFleet's — so a
       fetch that was in flight when the source flipped fails the version
       check and never paints. The extra currentDataSource() clause is belt
       and braces for the one thing the counter cannot promise: a FUTURE
       caller that mounts the example without bumping. A live fetch must
       never apply over a mock mount, whoever mounted it. */
    const nativeAuthority = source === 'relay' && Boolean(desktopTreeBridge())
    // Legacy reads can be slow or unavailable on a remote computer. They
    // cannot hold back its complete immutable snapshot or its refusal state.
    const projection = nativeAuthority
      ? readAuthoritativeDesktopTree().then(authority => [null, null, authority])
      : Promise.all([fetchFleet(), readOrg(), readAuthoritativeDesktopTree()])
    projection.then(([result, org, authority]) => {
      if (destroyed || version !== fetchVersion || currentDataSource() === 'mock') return
      if (!nativeAuthority) orgAvailability = org
      /* Once the relay exposes the native authority, a refusal is terminal for
         this render. Falling back to declared seats or open-session rows would
         put the exact tree-parity bug back on screen. Older hosts without the
         seam retain the historical projection until they are upgraded. */
      if (nativeAuthority && !authority.snapshot) {
        showProjectionUnavailable('the computer’s saved trees could not be read')
        return
      }
      if (source === 'relay' && authority.snapshot) {
        mountProjection({ authoritativeDesktopTree: authority.snapshot }, { declaredReason: null })
        void sweepOrphanedNodeSeats()
        syncEditAvailability()
        requestDesktopSessions()
        return
      }
      /* THE FLEET PROJECTION IS NOT THE ONLY SOURCE OF COMPUTERS, and on a
         customer machine it is the one that can never answer. When it has
         nothing, the organisation this copy declares is drawn instead — the
         same record this page's own drag and role menu write to — so the
         machine in front of the person appears on their own fleet page and the
         drill-in behind it is a real one. The refusal sentence travels with it
         and is printed in the rail; nothing is hidden by drawing something.
         The empty state below is still reached, and is still right, when there
         is no organisation to draw: a plain browser, or a store that refused. */
      if (result.ok) mountProjection(result.data.data, { declaredReason: null })
      else {
        const declared = orgReady() ? declaredFleetData(orgAvailability.org, desktopStartedSessions(readLiveSession(), desktopList)) : null
        if (declared) mountProjection(declared, { declaredReason: result.reason })
        else showProjectionUnavailable(result.reason)
      }
      /* Both the declared org and this computer's own trees (mountProjection
         above ends in mountGraph, which syncs treeStore to `computer`) are in
         hand for the first time this load. See sweepOrphanedNodeSeats' own
         header for why this is a backstop and not the only place a seat is
         released. */
      void sweepOrphanedNodeSeats()
      syncEditAvailability()
      requestDesktopSessions()
    }).catch(error => {
      /* Same two guards as the .then above, for the same reasons. */
      if (destroyed || version !== fetchVersion || currentDataSource() === 'mock') return
      showProjectionUnavailable(`the fleet record could not be fetched: ${error?.message || error}`)
    }).finally(() => {
      if (version === fetchVersion) {
        finishProjectionLoad()
        desktopTreeReadAt = Date.now()
        requestAuthoritativeDesktopTree()
      }
    })
    return projectionReady
  }

  /* THE EXAMPLE MOUNT — the mock arm of the one fork. Same mountProjection,
     same rails, same graph as every real source; only the record differs. */
  function mountMockFleet() {
    /* The bump is this mount's stale-async fence: a real fetch still in
       flight (the example was switched on mid-load) fails loadProjection's
       version check and never paints over the example. */
    fetchVersion += 1
    finishProjectionLoad()
    /* NOTHING REAL RIDES INTO THE BADGED SCREEN. A real mount earlier in this
       view's life may have filled these from this computer's own stores —
       the saved organisation, the signed run ledger, the shell's sign-in and
       tier readings. Each is dropped back to its nothing-learned default
       before the example mounts, because an example-badged box holding your
       real org, your real runs or your machine's sign-in warnings would make
       part of it true — the exact mixing the badge rules out. Real sources
       re-read all of them on the way back in. */
    orgAvailability = { state: 'absent', code: 'ORG_BRIDGE_ABSENT', reason: ORG_ABSENT_REASON }
    /* The names of your real computers do not ride into the badged screen as a
       READING -- but when the only reason this screen is the example is that
       nobody has said which computer to drive, the bar is the way out and it
       stays. See machineChoicesBelongHere(). In every other example state it
       clears, along with the sentence from the last press on it, and the bar is
       the record's own tabs, which is what it has always been. */
    if (!machineChoicesBelongHere()) {
      machineChoices = []
      setMachineNote('')
    }
    railRuns = []
    railRunsSupported = false
    startableTierChoices = TIER_CHOICES
    startableTierIdList = TREE_DEFAULT_STARTABLE_TIERS
    /* A badged example issues no bridge call, so it has no failure to report.
       Carrying a real screen's failure into it would put this machine's bad
       moment inside a screen that is not about this machine. */
    tierAnswerMissing = false
    /* And an example screen has heard nothing from a shell either, so the
       subtractive flag goes back to "nobody spoke" with the list. */
    startableTierAnswered = false
    signedOutProviders = []
    noProgramProviders = []
    providerPresence = null
    /* The compose panel's machine-read inputs too: your folder names, where a
       default start lands, and this computer's permission sentence would all
       ride into the (disabled) example panel otherwise. */
    composeFolders = []
    composeDefaultFolder = ''
    composeConfinementLine = ''
    /* ONE COMPUTER, NO DECLARED SEATS: THE TREES ARE THE PAGE.
     *
     * This mounted the whole example fleet -- two machines and nine declared
     * seats -- onto the same canvas as the example's trees. That is not the
     * shape of a person's page. A single-machine person has one computer with
     * no fleet host reporting, so their canvas is THEIR TREES and nothing else;
     * nine seats drawn beside them put two different kinds of thing on one
     * canvas and made the example busier than the product it demonstrates.
     *
     * So the example mounts what a person actually has: the computer and its
     * services, an EMPTY declared graph, and the trees the example store
     * supplies through treeAgents(). The fleet record is still described
     * honestly by the rail, which reads the same record -- it simply stops
     * being drawn as a second population on the tree canvas. */
    const example = sampleFleetData(Date.now())
    mountProjection({
      computers: example.computers.slice(0, 1),
      graph: { nodes: [], edges: [], revision: example.graph?.revision ?? null },
    }, { declaredReason: null })
  }

  /* WHERE THE PAGE'S DATA COMES FROM — the one fork, taken per resolution.
     The owner's ruling collapsed the two renders: "all simulated pages ARE
     the UI pages, just mock data." So the fork here chooses a RECORD, never
     a render: mock mounts the example record, local and relay read the real
     one. Resolution is async (a public page has to ask the host for a
     transport), which is why the boot is a function and not a statement. */
  /* The real arm: the projection load plus the real-source-only reads. The
     reads fire from here rather than at construction because the source was
     not known at construction — and never under mock, where a bridge call
     from a badged screen is the thing that must not happen. All three
     tolerate re-runs (a mock→real flip lands here again through the event
     below). */
  /* `readMachineChoices` is false only for the one caller that has already
     awaited the list this run -- the data-source handler, which needs the
     answer BEFORE it can decide whether a draft may be thrown away. Asking the
     account twice for one announcement would spend a second request to learn
     what it just said. Every other caller leaves it true. */
  function mountRealSource({ readMachineChoices = true } = {}) {
    loadProjection()
    void startableTiersNow()
    loadRailRuns()
    readResearchOnce()
    /* The account's own computers, for the bar. It refuses itself on every
       source but the relay, so the desktop arm of this function costs one
       synchronous check and draws nothing new. */
    if (readMachineChoices) void loadMachineChoices()
  }

  /* WHICH COMPUTER THIS TAB DRIVES, as one comparable value. The pair of ids
     is the identity `driveMachine` itself matches on; an empty string means
     none is driven, which is every state the desktop app is ever in (the bar
     refuses itself off the relay -- see machineChoicesBelongHere). */
  function drivingComputerKey() {
    const row = machineChoices.find(entry => entry.driving) || null
    return row ? JSON.stringify([row.relayPairId, row.devicePairId]) : ''
  }

  /* A SWITCH THIS PAGE CANNOT NAME IS STILL A SWITCH. Returned when the host
     says a machine was chosen but the announcement does not carry the two ids
     that say which. The bar is a SECOND read and it can be empty, stale or
     refused, so comparing the drawn list alone would answer "nothing changed"
     for a tab that has just been pointed at another computer. Fencing
     needlessly costs a blink; not fencing carries a half-typed message onto
     somebody else's machine, so the unprovable case fences. */
  const DRIVING_UNKNOWN = Symbol('driving-computer-unknown')

  /* What the announcement ITSELF says about the driving computer, or undefined
     when it is not about one. src/machine-tabs.js is the producer: choosing a
     computer announces 'machine-chosen' carrying relayPairId and devicePairId,
     and letting one go announces 'machine-forgotten' carrying nulls. */
  function announcedDrivingKey(detail) {
    const why = detail?.why
    if (why !== 'machine-chosen' && why !== 'machine-forgotten') return undefined
    if (why === 'machine-forgotten') return ''
    const relay = typeof detail.relayPairId === 'string' && detail.relayPairId ? detail.relayPairId : null
    const device = typeof detail.devicePairId === 'string' && detail.devicePairId ? detail.devicePairId : null
    return relay && device ? JSON.stringify([relay, device]) : DRIVING_UNKNOWN
  }

  // Recheck account and demo state on every data-source event, even when
  // choosing or leaving the example does not change the mock source verdict.
  async function resolveLedgerAuth() {
    if (!phoneCanvas) return
    const epoch = desktopEpoch
    const state = await loadAccountState()
    if (destroyed || epoch !== desktopEpoch) return
    ledgerSignedIn = state.signedIn === true
    if (graphSignInDoor) {
      const needsSignIn = phoneLedgerNeedsSignIn({ signedIn: ledgerSignedIn, source, exampleChosen: exampleWasChosen() })
      root.classList.toggle('phone-graph-auth-required', needsSignIn)
      graphSignInDoor.hidden = !needsSignIn
    }
    phoneLedger?.refresh()
  }

  async function bootFromSource() {
    source = await resolveDataSource()
    if (destroyed) return
    if (source === 'mock') mountMockFleet()
    else mountRealSource()
    void resolveLedgerAuth()
  }

  /* The host says the world changed — sign-in, sign-out, the example toggle
     — and this view re-resolves rather than trusting the cached verdict
     (`reask` because a transport may have just appeared or died). A verdict
     that did not change remounts nothing: the event deliberately carries no
     payload, and reacting to the announcement alone would rebuild the page
     under the person for nothing. */
  /* THE ONE THING A VERDICT THAT DID NOT CHANGE STILL CHANGES is which of your
     computers this browser is pointed at. The host announces that on this same
     event — it is how it says a machine was chosen or unchosen — and the
     verdict either side of it is 'relay' both times, so the early return above
     is right about the PAGE and wrong about the BAR. Without this line a choice
     made anywhere else leaves the bar lighting the computer you left. It is a
     list read, not a re-mount: nothing under the person is rebuilt. */
  /* WHICH ANNOUNCEMENTS MAY WAIT, AND WHY THIS IS A DENY-LIST.
   *
   * Every reason but one keeps the fence it has always had: destructive, and
   * synchronous with the announcement. That is not caution for its own sake --
   * tools/test/desktop-tree-live-refresh.test.mjs pins it by name ("an account
   * fence drops the old forest SYNCHRONOUSLY"), because one account's tree must
   * not stay drawn for even the length of an await once the account has gone.
   *
   * 'host' is the bare re-announce: announceDataSourceChange() with nothing
   * said, the default in src/data-source.js. It is the one that carries no
   * claim that anything changed, and the one the owner reported in T296 -- a
   * token refresh or account re-check on a signed-in instance, closing the
   * conversation and wiping the draft for nothing. Only that one waits.
   *
   * A DENY-LIST BECAUSE THIS REPO DOES NOT OWN THE VOCABULARY. The website
   * dispatches reasons that appear nowhere in this source except its tests --
   * 'account-session-changed', 'sign-out-started', 'session-ended'. An
   * allow-list would silently stop fencing for the next one somebody adds
   * there, and the failure would be an account seeing another account's tree.
   * An unrecognised reason therefore fences, exactly as today. */
  const DEFERRABLE_ANNOUNCEMENTS = new Set(['host'])

  const onDataSourceChange = event => {
    /* A gap in the event stream is the same connection with some events lost:
       the open conversation keeps its draft and reads its transcript again.
       Every other announcement may be a different computer or account. */
    const why = event?.detail?.why
    const gap = why === 'agent-events-gap'
    if (gap) desktopChat?.resync?.()
    else {
      holdDesktopSessions()
      holdAuthoritativeDesktopTree()
    }
    /* The bare re-announce is the only one allowed to wait for a verdict. */
    const deferrable = !gap && DEFERRABLE_ANNOUNCEMENTS.has(why)
    if (!gap && !deferrable) {
      releaseDesktopSessions()
      releaseAuthoritativeDesktopTree()
    }
    const epoch = desktopEpoch
    /* WHO WE WERE DRIVING, AND WHO WAS SIGNED IN, when the announcement
       arrived. Read before anything is re-asked, because the reads below are
       what move them. Only the deferred path compares them. */
    const drivenBefore = drivingComputerKey()
    const signedInBefore = ledgerSignedIn
    /* What the announcement says about the driving computer, which outranks
       the bar -- the bar is a second read and it can be empty or refused. */
    const drivenAnnounced = announcedDrivingKey(event?.detail)
    void (async () => {
      const next = await resolveDataSource({ reask: true })
      if (destroyed || epoch !== desktopEpoch) return
      /* Sign-in/sign-out fires this SAME event and can leave the data-source
         verdict unchanged (still 'relay', say) while flipping who is signed
         in — the two axes are independent, so this is asked every time,
         not only on the branch below that changed. Awaited on the deferred
         path alone, where its answer is one of the things being compared. */
      if (deferrable) await resolveLedgerAuth(); else void resolveLedgerAuth()
      if (destroyed || epoch !== desktopEpoch) return
      if (deferrable) {
        /* THE BAR IS READ BEFORE THE DESTRUCTIVE HALF IS DECIDED, and awaited
           rather than fired off, because it is the only thing that knows which
           computer this tab now drives. It costs nothing on the desktop app,
           where loadMachineChoices refuses itself before its first await. */
        await loadMachineChoices()
        if (destroyed || epoch !== desktopEpoch) return
        /* THREE AXES, NOT ONE. A verdict that did not move is the common case
           and must cost nothing. A computer switch arrives with the verdict
           'relay' on BOTH sides, which is exactly when a draft belongs to a
           connection that is gone. And who is signed in moves independently of
           both. Any one of them is a real change; none of them moving is the
           re-announce T296 is about. An unnamed switch (DRIVING_UNKNOWN)
           counts as a change rather than being rounded down to "no". */
        const drivingChanged = drivenAnnounced === undefined
          ? drivingComputerKey() !== drivenBefore
          : drivenAnnounced === DRIVING_UNKNOWN || drivenAnnounced !== drivenBefore
        if (next !== source || drivingChanged || ledgerSignedIn !== signedInBefore) {
          releaseDesktopSessions()
          releaseAuthoritativeDesktopTree()
        }
      }
      if (next === source) {
        if (next === 'relay' && desktopTreeBridge() && !gap) loadProjection()
        else requestAuthoritativeDesktopTree()
        if (!deferrable) void loadMachineChoices()
        void reconnectSavedSessions()
        requestDesktopSessions()
        return
      }
      source = next
      if (source === 'mock') mountMockFleet()
      else mountRealSource({ readMachineChoices: !deferrable })
    })()
  }
  window.addEventListener(DATA_SOURCE_EVENT, onDataSourceChange)
  unsubs.push(() => window.removeEventListener(DATA_SOURCE_EVENT, onDataSourceChange))

  /* The computer's list is read again when this page comes back into view, not
     on a timer: the website marks these reads as background work so an
     unattended page does not hold the connection open. */
  if ((desktopSessionsBridge() || desktopTreeBridge()) && typeof document !== 'undefined') {
    const onDesktopSessionsVisible = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(desktopTreeTimer)
        desktopTreeTimer = null
        return
      }
      requestDesktopSessions()
      requestAuthoritativeDesktopTree()
    }
    document.addEventListener('visibilitychange', onDesktopSessionsVisible)
    window.addEventListener('focus', onDesktopSessionsVisible)
    unsubs.push(() => document.removeEventListener('visibilitychange', onDesktopSessionsVisible))
    unsubs.push(() => window.removeEventListener('focus', onDesktopSessionsVisible))
  }
  unsubs.push(() => { clearTimeout(desktopListTimer); desktopListTimer = null })
  unsubs.push(() => { clearTimeout(desktopTreeTimer); desktopTreeTimer = null; desktopTreeFlight = null })

  /* A late host explanation changes copy, not the example's identity. Rebuilding
     the fleet here erased the agent selected by the first phone tap: opening
     its rail triggers the host read whose reply used to replace the graph.
     Keep the selected node, chat, scroll and focus while refreshing the reason. */
  const onHostFallbackChange = () => {
    if (destroyed || source !== 'mock') return
    renderStats()
    for (const copy of root.querySelectorAll('.board-absent-copy')) copy.textContent = exampleExitSentence()
  }
  window.addEventListener(HOST_FALLBACK_EVENT, onHostFallbackChange)
  unsubs.push(() => window.removeEventListener(HOST_FALLBACK_EVENT, onHostFallbackChange))

  /* A SESSION THAT STARTS WHILE THIS PAGE IS OPEN IS DRAWN WITHOUT A RELOAD.
   *
   * Reading readLiveSession() at the two projection sites is enough for the
   * ordinary journey -- start on the agent page, navigate back, loadProjection()
   * reads the record fresh. It is NOT enough for a session that begins or ends
   * while the fleet page is on screen, and that case is real: the rail's own
   * chat and the compose panel both live here, and the agent page can be open in
   * a second window against the same renderer registry.
   *
   * IT REDRAWS ON THE SET, NOT ON THE PHASE. The registry publishes on every
   * transition (starting -> open -> working -> stopping), and reprojecting on
   * each of those would rebuild the canvas four times for one start -- the node
   * reshuffle src/declared-fleet.js keeps declared order to avoid, done to the
   * whole graph. The only thing that changes what is DRAWN is which agent has a
   * session, so that is what is compared. */
  let lastStartedAgentId = readLiveSession()?.agentId ?? null
  unsubs.push(onLiveSession(record => {
    const agentId = record?.agentId ?? null
    if (agentId === lastStartedAgentId) return
    lastStartedAgentId = agentId
    /* Real sources only: the registry describes real sessions, and the
       declared re-projection it triggers reads the real org — neither may
       touch a mock mount. */
    if (destroyed || mockSource() || !declaredOnlyReason || !orgReady()) return
    reprojectFromOrg()
  }))

  /* THE COMPACT CARD'S SEND. Busy agent: the words join the queue and the
     card says so — the same one-turn-at-a-time truth the engine enforces.
     Idle agent: the words go now, the node returns to running, and the
     card's reply slot waits for the turn to complete. Either way nothing is
     fabricated: the card only ever shows what was sent and what came back. */
  /* The approval card: mounted into the controls page only while a request is
     pending, torn down by its own answer. The details a person needs are the
     request's own (the command it wants to run); the buttons are exactly the
     decisions the request named, in words. */
  /* THE ONE WORDING FOR "WHAT IS IT ASKING", read by the rail card and the
     inline strip alike, so the two doors cannot describe the same question
     two different ways. */
  function approvalSummary(approval) {
    const command = typeof approval.details?.command === 'string' ? approval.details.command.slice(0, 160) : ''
    if (approval.approvalKind === 'commandExecution' && command) return APPROVAL_PANEL.command(command)
    if (approval.approvalKind === 'fileChange') return APPROVAL_PANEL.file
    if (approval.approvalKind === 'tool_permission') {
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

  /* THE INLINE DOOR'S ADAPTER, WIRED TO B1'S LANDED CONTRACT (SendMessage,
   * 2026-08-28): buildChat's mounted root carries `showApproval({id, summary,
   * badges})` and `resolveApproval(id)`, imperative, mirroring addAction /
   * openStream rather than a config-with-subscribe shape. Feature-detected
   * anyway (`typeof root.showApproval === 'function'`) so a chat surface from
   * before this lands, or a test double that mounts a bare node, is simply
   * skipped rather than thrown against.
   *
   * TWO DOORS, ONE STATE. This is the panel's half. The rail's own door is
   * renderApprovalCard() below; both read the SAME sessionPendingApprovals
   * entry, and settleApproval() (also below) clears both UIs no matter which
   * door was pressed -- an inline decide never leaves the rail card standing
   * over an already-answered question, and an Allow/Refuse press on the rail
   * card never leaves a registered panel still asking. */
  function chatSurfacesFor(sessionId) {
    const held = chatSurfaces.get(sessionId)
    if (!held) return []
    return [...held].filter(root => root.isConnected)
  }
  function pushInlineApproval(sessionId, approval) {
    for (const root of chatSurfacesFor(sessionId)) {
      if (typeof root.showApproval !== 'function') continue
      for (const pending of sessionPendingApprovals.all(sessionId)) {
        try { root.showApproval({ id: pending.approvalId, summary: approvalSummary(pending), badges: [],
          decisions: pending.availableDecisions, decisionKinds: pending.decisionKinds,
          answering: sessionPendingApprovals.answering(sessionId, pending.approvalId) }) }
        catch { /* one broken surface must not starve the rest, or the rail's own door */ }
      }
    }
  }
  function clearInlineApproval(sessionId, approvalId) {
    if (!approvalId) return
    for (const root of chatSurfacesFor(sessionId)) {
      if (typeof root.resolveApproval !== 'function') continue
      try { root.resolveApproval(approvalId) } catch { /* likewise */ }
    }
  }

  function clearSessionApprovals(sessionId, approvals = sessionPendingApprovals.all(sessionId)) {
    for (const approval of approvals) {
      if (sessionPendingApprovals.settle(sessionId, approval.approvalId, approval)) clearInlineApproval(sessionId, approval.approvalId)
    }
    if (currentRailTreeNode && currentRailTreeNode.id === sessionNodeIds.get(sessionId)) {
      const next = sessionPendingApprovals.get(sessionId)
      if (next) renderApprovalCard(sessionId, next)
      else controlsPage.querySelector('[data-tree-approval]')?.remove()
    }
  }

  /* THE CLEANUP HALF, SHARED BY BOTH DOORS, once EITHER has already gotten a
     real answer back from the engine. Forgets the pending question (so a
     later rail open cannot offer an Approve button for a decision already
     made), removes the rail card if one is mounted FOR THIS SESSION, resolves
     the question on every chat surface registered for this session, and
     speaks the one answered sentence either door uses. Both doors call
     settleApproval, which holds one answer across repaints and panels.
     THE RAIL CARD IS A SINGLETON: [data-tree-approval] holds whichever one
     node's rail is open right now, not the session being settled here. B3's
     own "two doors, one state" design means those can differ -- a compact
     card answering session A's question while the rail sits open on session
     B, which has its own unrelated pending approval; the same gap reopens
     without a fleet view at all, since this runs after `await
     bridge.answerApproval(...)` returns, and the person is free to switch the
     rail to a different, also-pending node while that network round trip is
     still in flight. Unguarded, settling A tore B's still-live Approve/Refuse
     card off the screen it never touched -- not answered, just silently
     gone, recoverable only by leaving the node and reopening it, because
     sessionPendingApprovals still remembers B's own entry untouched. Matches
     the identical guard already used for this same element at the two
     turn-ending cleanups below (search sessionNodeIds.get). */
  function finishApprovalSettle(sessionId, approvalId, sentence = APPROVAL_PANEL.answered) {
    sessionPendingApprovals.settle(sessionId, approvalId)
    if (currentRailTreeNode && currentRailTreeNode.id === sessionNodeIds.get(sessionId)) {
      const next = sessionPendingApprovals.get(sessionId)
      if (next) renderApprovalCard(sessionId, next)
      else controlsPage.querySelector('[data-tree-approval]')?.remove()
    }
    clearInlineApproval(sessionId, approvalId)
    setOrgStatus(sentence, 'ok')
  }

  function applyAnsweredApprovalRow(sessionId, approvalId, decision, decisionKinds, turnId) {
    const buffer = sessionActions.get(sessionId)
    if (!buffer) return
    const state = approvalDecisionIsReject(decision, decisionKinds) ? 'refused' : 'done'
    const row = buffer.answerApproval(approvalId, state, { turnId })
    if (!row) return
    broadcastAction(sessionId, actionChatRow(row))
    persistActionRow(sessionId, row)
    persistTranscript(sessionId)
  }

  /* THE INLINE PANEL'S OWN DOOR INTO THE SAME ANSWER, for buildChat's
     onApprovalDecision (B1's contract). Returns the {ok, sentence} pair that
     contract wants back -- a resolved sentence to post as the panel's own
     closing note, and whether the engine actually took the decision so the
     panel can show its own failure line. */
  async function settleApproval(sessionId, approvalId, decision) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const pending = sessionPendingApprovals.all(sessionId).find(entry => entry.approvalId === approvalId) || null
    const answer = sessionPendingApprovals.beginAnswer(sessionId, approvalId)
    if (!answer) return { ok: false, sentence: APPROVAL_PANEL.failed }
    pushInlineApproval(sessionId)
    if (currentRailTreeNode && currentRailTreeNode.id === sessionNodeIds.get(sessionId)) {
      renderApprovalCard(sessionId, sessionPendingApprovals.get(sessionId))
    }
    /* BOUNDED, because ipcRenderer.invoke is not: a press the main process
       never answers used to hang here forever and say nothing at all. The
       elapsed bound decides nothing -- it only reports that the answer did not
       land, which is the same sentence a refusal gets. */
    const { answered } = await answerWithinBound(
      () => bridge?.answerApproval?.({ sessionId, approvalId, decision }))
    // The request may have ended while IPC was in flight. Even an identical
    // provider id in a later turn has its own answer ownership.
    const stillPending = sessionPendingApprovals.endAnswer(sessionId, approvalId, answer)
    if (!answered) {
      if (stillPending) {
        pushInlineApproval(sessionId)
        if (currentRailTreeNode && currentRailTreeNode.id === sessionNodeIds.get(sessionId)) {
          const current = sessionPendingApprovals.get(sessionId)
          renderApprovalCard(sessionId, current)
          const out = current?.approvalId === approvalId && controlsPage.querySelector('[data-approval-out]')
          if (out) out.textContent = APPROVAL_PANEL.failed
        }
      }
      return { ok: false, sentence: stillPending ? APPROVAL_PANEL.failed : APPROVAL_PANEL.ended }
    }
    const sentence = approvalAnswerSentence(decision, pending?.decisionKinds)
    const turnId = pending?.turnId || null
    if (turnId && approvalDecisionIsReject(decision, pending?.decisionKinds)) {
      if (sessionOpenTurns.get(sessionId) === turnId) confirmedRefusals.set(sessionId, { approvalId, turnId })
      // Completion can precede the answer's IPC acknowledgment. Refine only
      // that named completed turn, never the next turn using this session.
      const node = treeStore?.getNode(sessionNodeIds.get(sessionId))
      if (node?.status === 'cancelled' && node.lastTurnId === turnId) {
        treeStore.setNodeStatus(node.id, 'cancelled', { note: TURN_CANCELLED.refused, turnId })
        refreshTree()
      }
    }
    if (stillPending || turnId) applyAnsweredApprovalRow(sessionId, approvalId, decision, pending?.decisionKinds, turnId)
    if (stillPending) finishApprovalSettle(sessionId, approvalId, sentence)
    return { ok: true, sentence }
  }

  function renderApprovalCard(sessionId, approval) {
    if (!approval) return
    const activityHost = controlsPage.querySelector('[data-tree-activity]')
    if (!activityHost) return
    let card = controlsPage.querySelector('[data-tree-approval]')
    if (!card) {
      card = document.createElement('div')
      card.setAttribute('data-tree-approval', '')
      card.className = 'board-box board-ctl-box'
      activityHost.after(card)
    }
    const line = approvalSummary(approval)
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    /* WHAT CAN ACTUALLY BE PRESSED, and the sentence for when that is nothing.
       A card headed "It is asking permission" over an empty row of buttons is
       the exact shape of a question nobody can answer, and until this it was
       what every real request drew -- see approvalDecisionIds() in
       src/agent-session-events.js for how the offered list reached here empty. */
    const choices = approvalCardChoices(approval.availableDecisions, approval.decisionKinds)
    const approvalControl = controlState({
      enabled: typeof bridge?.answerApproval === 'function',
      why: APPROVAL_PANEL.failed,
    })
    const answering = sessionPendingApprovals.answering(sessionId, approval.approvalId)
    const waiting = sessionPendingApprovals.all(sessionId).length
    const blockedWhy = choices.note || (approvalControl.disabled ? approvalControl.why : '')
    card.innerHTML = `
      <div class="board-box-h"><span class="bh-t">${escapeMarkup(APPROVAL_PANEL.title)}</span></div>
      ${waiting > 1 ? `<div class="rail-sub">${escapeMarkup(APPROVAL_PANEL.waiting(waiting))}</div>` : ''}
      <div class="rail-sub">${escapeMarkup(line)}</div>
      <div class="ctl-row" data-approval-choices>
        ${choices.decisions.map(decision => `<button class="ctl-btn" type="button" data-approval-decision="${escapeMarkup(decision)}"${approvalControl.disabled || answering ? ' disabled' : ''}${approvalControl.disabled ? ` title="${escapeMarkup(approvalControl.why)}"` : ''}>${escapeMarkup(approvalDecisionWord(decision, approval.decisionKinds))}</button>`).join('')}
      </div>
      <output class="rail-sub" role="status" data-approval-out>${escapeMarkup(blockedWhy)}</output>`
    if (approvalControl.disabled || choices.decisions.length === 0) return
    card.querySelector('[data-approval-choices]').addEventListener('click', async event => {
      const decision = event.target?.dataset?.approvalDecision
      if (!decision || event.target.disabled || !card.isConnected || !card.contains(event.target)) return
      await settleApproval(sessionId, approval.approvalId, decision)
    })
  }

  /* ---- STANDING REQUESTS FROM THE CHAT BOX (the /Request family) ----
   *
   * THE PRODUCT FILES THE PERSON'S WORDS; the agent needs no tool for it and
   * is never sent the command — both dispatch seams route kind:'request'
   * before anything queues or sends, so "/RequestThread ..." can never reach
   * a model as a message. The engine's r-ledger module holds the owner's
   * design (four hand-editable markdown ledgers); the host appends and
   * answers the minted id for the one-sentence confirmation.
   *
   * SCOPE KEYS ARE IDS THIS VIEW ALREADY HOLDS, never invented: a session
   * rule files under the RUNNING session's id, a tree or thread rule under
   * this node's id (the anchor). The same ids ride every start as
   * requestKeys, so filing and boot carriage cannot disagree about what a
   * scope is called — and because a node's id survives an app restart while
   * a session's does not, a thread rule outlives the restart (the proof this
   * feature is judged by) while a session rule honestly dies with its
   * session. */
  function treeAnchorsFor(node, store = treeStore) {
    const chain = []
    const seen = new Set()
    let current = node
    while (current && current.id && !seen.has(current.id)) {
      seen.add(current.id)
      chain.unshift(current.id)
      current = current.parentId && store ? store.getNode(current.parentId) : null
    }
    /* Bounded like the host's parse. An absurd depth keeps the NEAREST
       anchors: a rule anchored close binds tighter than one anchored far. */
    return chain.slice(-16)
  }

  function nodeRequestKeys(node, store = treeStore) {
    return { treeAnchors: treeAnchorsFor(node, store), threadId: node.id }
  }

  /* THE SAVED ADDRESS, independent of which sessions happen to be running.
     A child's manager is its stored parentId and its tree key is the top saved
     node in that chain. This is used by starts, resumes and live moves so all
     three doors tell the host the same organisation Page 2 draws. */
  function nodeTreeIdentity(node, store = treeStore) {
    if (!node) return null
    const parent = node.parentId && store ? store.getNode(node.parentId) : null
    return {
      selfName: treeNodeName(node),
      managerName: parent ? treeNodeName(parent) : null,
    }
  }

  function treeBranchNodeIds(rootId, store = treeStore) {
    if (!store || !rootId) return []
    const ids = []
    const pending = [rootId]
    const seen = new Set()
    while (pending.length) {
      const id = pending.shift()
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (!store.getNode(id)) continue
      ids.push(id)
      for (const child of store.childrenOf(id)) pending.push(child.id)
    }
    return ids
  }

  /* A MOVE CHANGES THE ROUTING DIRECTORY AS WELL AS THE CANVAS. Each session
     is serialized so rapid successive drags land in the same order they were
     saved. The values are captured after the store accepts the move; leaving
     the page cannot cancel a directory correction for a session that remains
     alive after the view goes away. */
  async function syncTreeBranchAddresses(rootId, store = treeStore) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const updates = []
    for (const nodeId of treeBranchNodeIds(rootId, store)) {
      const node = store?.getNode(nodeId)
      const sessionId = node?.sessionId || null
      if (!sessionId || sessionNodeIds.get(sessionId) !== nodeId) continue
      const identity = nodeTreeIdentity(node, store)
      const treeKey = treeAnchorsFor(node, store)[0] || node.id
      updates.push({ nodeId, sessionId, treeKey, requestKeys: nodeRequestKeys(node, store), ...identity })
    }
    if (updates.length === 0) return { ok: true, updated: 0 }
    if (!bridge || typeof bridge.updateTreeAddress !== 'function') {
      setOrgStatus(MOVE_PANEL.addressNotUpdated(updates.length), 'warn', { sticky: true })
      return { ok: false, updated: 0 }
    }

    const jobs = updates.map((update) => {
      const before = treeAddressSyncs.get(update.sessionId) || Promise.resolve()
      const running = before.catch(() => {}).then(() => {
        /* A restart that completed while this update waited owns a different
           session mapping. Never write the old session's address over it. */
        if (sessionNodeIds.get(update.sessionId) !== update.nodeId) return { ok: true, skipped: true }
        return bridge.updateTreeAddress({
          sessionId: update.sessionId,
          selfName: update.selfName,
          managerName: update.managerName,
          treeKey: update.treeKey,
          requestKeys: update.requestKeys,
        })
      })
      const tracked = running.finally(() => {
        if (treeAddressSyncs.get(update.sessionId) === tracked) treeAddressSyncs.delete(update.sessionId)
      })
      treeAddressSyncs.set(update.sessionId, tracked)
      return tracked
    })
    const results = await Promise.allSettled(jobs)
    const failed = results.filter(result => result.status === 'rejected' || result.value?.ok === false).length
    if (failed > 0) setOrgStatus(MOVE_PANEL.addressNotUpdated(failed), 'warn', { sticky: true })
    return { ok: failed === 0, updated: updates.length - failed }
  }

  /* THE RULES THIS CIRCLE'S AGENTS CARRY, SHOWN WHERE THEY APPLY.
   *
   * The scopes come from src/tree-standing-requests.js, which derives them
   * from the SAME anchors nodeRequestKeys() puts on every start — so what a
   * person is shown here and what an agent is told at boot cannot disagree.
   * That is the whole reason the derivation is a shared module with a test
   * rather than a second expression written next to the panel.
   *
   * THE PERSON'S HAND, FROM HERE (O7 improvements, owner 2026-08-22: "its a
   * hand edit tool. for the user to go in on the toolsenabled ledger and
   * hand edit or delete them"). Each entry carries Edit and a two-press
   * Delete; the markup and the presses live in src/tree-standing-requests.js
   * (createStandingRequestsPanel), where node --test can drive them, and
   * this function only reads the ledgers and hands the panel its body. The
   * bridge's requestEdit / requestRemove reach the engine's PERSON-ONLY
   * rewrite through the main process; no agent has a path to them.
   *
   * A REFUSAL IS NOT AN EMPTY LIST. A copy that could not read its ledgers
   * says so in its own sentence; painting that as "no rules" would be the
   * absence-as-zero lie this page has already fixed twice (see
   * paintAgentsOnRecord). */
  const standingRequestReadVersions = new WeakMap()
  function refreshStandingRequests() {
    const node = currentRailTreeNode && treeStore?.getNode(currentRailTreeNode.id)
    if (node) void mountStandingRequests(node, controlsPage.querySelector('[data-requests-slot]'), { preserveEditing: true })
  }

  async function mountStandingRequests(node, slot, { preserveEditing = false } = {}) {
    if (!slot || destroyed) return
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const source = currentDataSource()
    const scopes = standingRequestScopesFor(node, { anchors: treeAnchorsFor(node) })
    /* The BOX and its heading are already on the page (see the markup): only
       the body below them is written here, so the panel never flashes in as a
       new box under the person's eye, and no class this function invents has
       to be styled into looking like its siblings. */
    const body = slot.querySelector('[data-requests-body]')
    if (!body) return
    const reading = {}
    standingRequestReadVersions.set(body, reading)
    if (!bridge || typeof bridge.requests !== 'function') {
      body.innerHTML = `<p class="rail-prose is-dim">${escapeMarkup(REQUEST_PANEL.unavailable)}</p>`
      return
    }
    const readings = await Promise.all(scopes.map(async ({ scope, key }) => {
      const answer = await bridge.requests({ scope, ...(key ? { key } : {}) }).catch(() => null)
      return { scope, key, answer }
    }))
    if (destroyed || !slot.isConnected || slot.querySelector('[data-requests-body]') !== body
        || standingRequestReadVersions.get(body) !== reading
        || window.mcAgent !== bridge || currentDataSource() !== source) return
    const refused = readings.some(({ answer }) => !answer || answer.ok !== true)
    const groups = readings
      .filter(({ answer }) => answer && answer.ok === true && answer.entries.length > 0)
      /* One heading per SCOPE, not per anchor: two tree anchors both read as
         "This tree" to a person, and printing that phrase twice would look
         like a repeat rather than like two ledgers. Each entry keeps the KEY
         of the ledger it was read from, because an edit or a delete has to
         name that ledger and the heading no longer says which anchor. */
      .reduce((into, { scope, key, answer }) => {
        const entries = answer.entries.map(entry => ({ ...entry, key }))
        const found = into.find(group => group.scope === scope)
        if (found) found.entries.push(...entries)
        else into.push({ scope, entries })
        return into
      }, [])
    /* The refusal rides WITH whatever was read rather than replacing it: some
       ledgers answering and one refusing is a real state, and hiding the rules
       that did arrive would be worse than saying both things. The panel is
       bound to this body ONCE (a re-read never stacks a second listener), and
       a successful edit or delete re-reads through this same function. */
    standingRequestsPanelFor(body, { bridge, escape: escapeMarkup })
      .show({ groups, refused, preserveEditing, reread: () => mountStandingRequests(node, slot) })
  }

  const REQUEST_FILE_FAILED = 'That rule was not filed. Try it once more; if it keeps happening, the ledger file could not be written.'
  const REQUEST_CHAT_OFF = 'Filing rules from a chat is off: Settings › Rules & approvals › "Who adds standing rules" is set to Ledger page only. Add it on the Ledger page, or change that setting.'

  /* THE /TASK AND /ASK FAMILIES FILE THROUGH THE SAME SEAM AS /REQUEST — same
     bridge call, same scope handling, same refusal sentences — with a `kind`
     letter riding the payload so the store knows which subset ('T' or 'A')
     to file into. Omitting kind for a plain request keeps that call's shape
     byte-for-byte what it was before these two families existed. */
  const LEDGER_KIND_LETTER = Object.freeze({ task: 'T', ask: 'A' })
  const LEDGER_KIND_SENTENCES = Object.freeze({
    request: { usage: requestUsageSentence, confirmation: requestConfirmationSentence },
    task: { usage: taskUsageSentence, confirmation: taskConfirmationSentence },
    ask: { usage: askUsageSentence, confirmation: askConfirmationSentence },
  })

  function ledgerCommandUsageSentence(kind, scope) {
    return (LEDGER_KIND_SENTENCES[kind] || LEDGER_KIND_SENTENCES.request).usage(scope)
  }

  async function fileStandingRequestFor(node, slash) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    const source = currentDataSource()
    if (!bridge || typeof bridge.request !== 'function') {
      return { ok: false, sentence: START_NEEDS_APP_TEXT() }
    }
    if (slash.scope === 'session' && !node.sessionId) {
      return { ok: false, sentence: 'This circle has no running session yet, so a session rule has nowhere to apply. Start the agent first, or use /RequestTree to cover this circle and everything under it.' }
    }
    const key = slash.scope === 'global' ? null
      : slash.scope === 'session' ? node.sessionId
        : node.id
    /* THE LABEL IS THE NAME THE PERSON SEES HERE, sent with the key so the
       Ledger page can show "Coordinator" beside the rule instead of a node
       id. A global rule has no one to name. */
    const label = slash.scope === 'global' ? null
      : slash.scope === 'session' ? `${treeNodeName(node)} · session`
        : treeNodeName(node)
    const kindLetter = LEDGER_KIND_LETTER[slash.kind]
    let filed = null
    try {
      /* `via: 'chat'` names the door: a typed command is the one filing the
         person's "Who adds standing rules" choice can close ("Ledger page
         only"), and the host refuses it by name so this box can say why. */
      filed = await bridge.request({ scope: slash.scope, ...(key ? { key } : {}), words: slash.rest, ...(label ? { label: label.slice(0, 120) } : {}), ...(kindLetter ? { kind: kindLetter } : {}), via: 'chat' })
    } catch (error) {
      const code = refusalCode(error)
      if (code === 'AGENT_REQUEST_UNAVAILABLE') {
        return { ok: false, sentence: 'This build cannot file standing requests yet — update ToolsEnabled and try again.' }
      }
      if (code === 'AGENT_REQUEST_CHAT_OFF') {
        return { ok: false, sentence: REQUEST_CHAT_OFF }
      }
      if (code === 'AGENT_REQUEST_WORDS_TOO_LONG') {
        return { ok: false, sentence: 'That rule is too long to file — shorten it and try again.' }
      }
      if (code === 'AGENT_REQUEST_WORDS_HEADING') {
        return { ok: false, sentence: 'A line starting with "## " would read as a new ledger entry — reword the rule and try again.' }
      }
      return { ok: false, sentence: REQUEST_FILE_FAILED }
    }
    if (!filed || filed.ok !== true || typeof filed.id !== 'string' || filed.id.length === 0) {
      return { ok: false, sentence: REQUEST_FILE_FAILED }
    }
    // Refresh only while this exact bridge/source still owns the filing.
    if (slash.kind === 'request' && !destroyed && window.mcAgent === bridge && currentDataSource() === source) {
      refreshStandingRequests()
    }
    return { ok: true, sentence: (LEDGER_KIND_SENTENCES[slash.kind] || LEDGER_KIND_SENTENCES.request).confirmation(slash.scope, filed.id) }
  }

  const GOAL_HASH_RE = /^[a-f0-9]{64}$/
  const GOAL_PHASE_RE = /^Q[1-9]\d{0,2}$/

  /* A success sentence is permitted only for the exact durable receipt the
     engine's queue-open action returns. A timeout, malformed response, or
     missing operation receipt is deliberately "unconfirmed": the write may have
     landed, so the UI must not claim nothing happened or invite a duplicate. */
  function verifiedGoalQueueReceipt(result, expectedHash, rootId) {
    const receipt = result?.receipt
    if (result?.ok !== true
      || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.action !== 'queue-open'
      || !GOAL_PHASE_RE.test(String(receipt.phaseId || ''))
      || receipt.previousHash !== expectedHash
      || !GOAL_HASH_RE.test(String(receipt.nextHash || ''))
      || typeof receipt.queuePath !== 'string' || !receipt.queuePath
      || !validAuditReceiptPair(receipt.intentAudit, receipt.audit, 'build.queue.open', rootId, receipt.phaseId)) return null
    return receipt
  }

  /* `/goal` opens one durable build-queue item and nothing else. This does not
     use prepareBridgeOnce(): queue writes are CAS-bound, so every attempt must
     read a fresh status snapshot and use the first declared root plus that
     root's ready hash. The explicit R id is copied twice into the writer's
     authority citation; no recent request, node, session, or objective text is
     searched for an inferred id. */
  async function recordGoalFor(slash) {
    if (!isWriteEnabled('queue')) {
      return { ok: false, sentence: goalRefusalSentence('disabled') }
    }

    let status = null
    try { status = await bridgeStatus() } catch { status = null }
    const rootId = status?.ok === true && Array.isArray(status.roots) ? status.roots[0] : null
    const queues = status?.queues
    const queue = typeof rootId === 'string' && rootId
      && queues && typeof queues === 'object' && !Array.isArray(queues) && Object.hasOwn(queues, rootId)
      ? queues[rootId]
      : null
    const expectedHash = queue?.ok === true && GOAL_HASH_RE.test(String(queue.hash || ''))
      ? queue.hash
      : null
    if (!rootId || !expectedHash) {
      return { ok: false, sentence: goalRefusalSentence('unavailable') }
    }

    let result = null
    try {
      result = await postBridgeAction('queue', {
        rootId,
        expectedHash,
        operation: 'open',
        title: goalTitleFromObjective(slash.objective),
        authority: `${slash.directiveId} (directiveId: ${slash.directiveId})`,
        brief: slash.objective,
      })
    } catch { result = null }
    const receipt = verifiedGoalQueueReceipt(result, expectedHash, rootId)
    return receipt
      ? { ok: true, sentence: goalConfirmationSentence(receipt.phaseId, slash.directiveId) }
      : { ok: false, sentence: goalRefusalSentence('unconfirmed') }
  }

  /* `/goal` ON THE RUNNING AGENT -- the half T61 says was missing.
   *
   * ONE controller for BOTH composers (the full conversation and the right
   * rail) and for the palette entry, because acceptance point 1 asks for the
   * same behaviour on all three and three copies of it would be three chances
   * to differ. It takes the node, resolves that node's LIVE session through
   * the same treeStore lookup every other session verb here uses, and returns
   * one sentence for the caller to paint on whichever surface it owns.
   *
   * THE SENTENCES COME BACK FROM THE HOST. shell/session-goal.cjs owns them
   * (see readGoal there): the host is what knows the goal's state, and the
   * conversation already shows those same words when the goal changes on its
   * own, so writing a second set here would let the status line and the
   * transcript disagree about what just happened.
   *
   * A `/goal R1234 <objective>` still records its build-queue item. That is a
   * SECOND, independent write, reported separately below: the queue failing
   * does not mean the goal failed, and a person told "nothing was recorded"
   * while their agent works toward the goal would be misinformed in the most
   * expensive direction. */
  async function runGoalFor(node, slash) {
    const live = treeStore ? treeStore.getNode(node.id) || node : node
    const sessionId = live?.sessionId
    const goalBridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!goalBridge || typeof goalBridge.goal !== 'function') {
      return { ok: false, sentence: START_NEEDS_APP_TEXT() }
    }
    if (!sessionId) return { ok: false, sentence: goalRefusalSentence('noSession') }

    const operation = slash.operation === 'show' ? 'get' : slash.operation
    let result = null
    try {
      result = await goalBridge.goal({
        sessionId,
        operation,
        ...(operation === 'set' ? { objective: slash.objective } : {}),
      })
    } catch (error) {
      /* A session the host no longer knows -- or still holds but has ended --
         is the "not running" case a person can act on, and it is named as
         that rather than as a raw code or as "could not confirm". The ended
         half arrives as MC_AGENT_SESSION_ENDED from ownedAgentSession, which
         is why the test is this file's own TERMINAL_AGENT_SESSION_CODES and
         not the two spellings this line used to carry. */
      const code = refusalCode(error)
      if (TERMINAL_AGENT_SESSION_CODES.has(code) || code === 'AGENT_SESSION_ENDED') {
        return { ok: false, sentence: goalRefusalSentence('noSession') }
      }
      return { ok: false, sentence: goalRefusalSentence('goalUnconfirmed') }
    }
    if (!result || typeof result.sentence !== 'string' || !result.sentence) {
      return { ok: false, sentence: goalRefusalSentence('goalUnconfirmed') }
    }

    /* The queue half, only when the person typed an R id, and only on a set.
       Its sentence is appended rather than replacing the goal's: both things
       were asked for, so both are answered. */
    if (operation === 'set' && slash.directiveId) {
      const queued = await recordGoalFor(slash)
      return { ok: true, sentence: `${result.sentence} ${queued.sentence}` }
    }
    return { ok: true, sentence: result.sentence }
  }

  function treeCardSend(node, text, { reply, fail, queued, note, attachments, pictures, accepted, keepQueued, originSurface = null, recoveryAttempted = false }) {
    /* BEFORE THE ROUTING, NOT AFTER IT. The fact the owner's removal rule
       reads -- "AGENTS that a user prompts even if created by another agent
       can remain" -- was recorded at the live send below, the one route a
       typed line takes only when the circle happens to be idle. A busy
       circle's queue, /queue and the dead-session recovery all carried the
       person's words past it, so a circle they had typed at while it worked
       stayed removable by the assistant above it. See notePersonSpokeTo. */
    notePersonSpokeTo(treeStore, node, text)
    /* Slash commands are the console's own vocabulary, parsed BEFORE anything
       is sent or queued — /interrupt while busy is exactly when it matters. */
    const slash = parseSlashCommand(text)
    if (slash?.kind === 'cloud' && slash.sentence) { fail(slash.sentence); return }
    if (slash && slash.kind !== 'cloud') {
      if (slash.kind === 'help' || slash.kind === 'unknown') { reply(slash.sentence); return }
      if (slash.kind === 'loop') {
        if (slash.sentence) { fail(slash.sentence); return }
        const result = openLoopFor(node, slash.minutes)
        fail(result.sentence)
        return
      }
      if (slash.kind === 'goal') {
        /* Like /Request, both outcomes are product notes rather than agent
           speech. This branch is above every outbox and model-send path: the
           command itself never becomes a session message.

           WHAT THE AGENT ACTUALLY RECEIVES is the objective, sent by the host
           as an ordinary turn (agent-host.cjs setGoal), so the words do reach
           the model -- they just reach it as a turn the host composed with the
           current rules block attached, rather than as this line of text. */
        if (slash.sentence) { fail(slash.sentence); return }
        fail(goalPendingSentence())
        /* The set/clear a person just typed is exactly what the rail's own
           Goal box reads next -- notify the same bus its subscribe() call
           already uses so it repaints without waiting for a turn boundary. */
        void runGoalFor(node, slash).then(result => { fail(result.sentence); notifyNodeStatusListeners() })
        return
      }
      if (slash.kind === 'request') {
        /* Both outcomes paint through `fail`, and that is a choice about
           HONESTY, not an error path: `fail` renders the product's own note
           kind, and a filing confirmation is not the agent speaking any more
           than a refusal is — the same reasoning src/components.js gives for
           keeping refusals out of the agent's bubble. */
        if (!slash.rest) { fail(requestUsageSentence(slash.scope)); return }
        void fileStandingRequestFor(node, slash).then(result => fail(result.sentence))
        return
      }
      if (slash.kind === 'task' || slash.kind === 'ask') {
        /* Built the same way as /Request, just above: both outcomes paint
           through `fail` as the product's own note, not the agent's. */
        if (!slash.rest) { fail(ledgerCommandUsageSentence(slash.kind, slash.scope)); return }
        void fileStandingRequestFor(node, slash).then(result => fail(result.sentence))
        return
      }
      if (slash.action === 'queue') {
        if (!slash.rest) { fail(QUEUE_PANEL.emptyQueueCommand); return }
        /* THE ONE ENQUEUE DOOR (queueForSession, above drainOutboxMessage).
           This branch used to call outboxEnqueue bare and answer "sends by
           itself when this turn finishes" whether or not a turn was running --
           at an idle agent that parked the words where nothing drains. */
        const queued = queueForSession(node, slash.rest)
        if (!queued.ok) { fail(queued.sentence); return }
        /* The STORE's sentence, because only it knows whether these words are
           saved on this computer, kept only until the window closes, or
           something in between. QUEUE_PANEL.cardQueued is the fallback that
           claims nothing about saving. See src/session-outbox.js persistence(). */
        reply(queued.sentence || QUEUE_PANEL.cardQueued)
        return
      }
      const sink = { textContent: '' }
      void runPaletteAction(slash.action, node, sink).then(() => {
        reply(sink.textContent || PALETTE_PANEL.done)
      })
      return
    }
    /* nodeBusy, not raw status: a restart-stale node (saved 'running' loads
       as 'starting' forever, over a session this run never owned) must FALL
       THROUGH to the send, meet MC_AGENT_UNKNOWN_SESSION, and recover below
       — the old status-only test parked its messages in a queue that no
       turn-completion would ever drain. */
    if (nodeBusy(node) || pendingModelChoice(node)?.applying) {
      const queued = outboxEnqueue(node.sessionId, text)
      if (!queued.ok) { fail(queued.sentence); return }
      accepted?.()
      reply(queued.sentence || QUEUE_PANEL.cardQueued)
      return
    }
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!bridge || typeof bridge.send !== 'function') { fail(START_NEEDS_APP_TEXT()); return }
    awaitTurnReply(node.sessionId, reply)
    /* THE STAMP ARRIVES AFTER THE WORDS DO, DELIBERATELY. bridge.send() is the
       one place a turn id is minted, and it has not resolved yet -- appending
       this line AFTER the send would hold a person's own words off the screen
       for a network round trip to save a badge. So it files with none, honestly
       (components.js: "no supplied stamp means no badge"), and the same object
       -- still the one sessionTranscripts holds, transcriptAppend pushes it by
       reference -- takes the real id the moment .then() below actually has it. */
    /* THE PICTURE IS PART OF THE ENTRY (T332). The owner: "the images
       disappear from chat right after sending". The only copy used to be one
       optimistic DOM node in the composer, so every repaint that redraws from
       this entry -- a reopen, a remount, the mirror into a second open surface
       on the same session -- drew the message with its picture gone. This
       object is the one sessionTranscripts holds by reference, so putting them
       here is what makes all of those paths agree. Present only when a picture
       really rides the turn, the same rule the fields around it keep. */
    const sentEntry = { who: 'you', text, at: Date.now(), ...(pictures?.length ? { pictures } : {}) }
    transcriptAppend(node.sessionId, sentEntry)
    const override = sessionModelOverride.get(node.sessionId)
    const pendingImages = Array.isArray(attachments)
      ? attachments.map(item => ({ path: item.path }))
      : sessionPendingImages.get(node.sessionId)
    sessionPendingImages.delete(node.sessionId)
    withResearchTreeBinding(bridge).send({
      sessionId: node.sessionId,
      text,
      /* The same conversation key the paste used. It is what lets an image
         pasted before this conversation was running be bound to the session
         that is running now; without it a held image would be refused as a
         path this session never issued. */
      ...(node.id ? { holdKey: node.id } : {}),
      ...(override ? { model: override } : {}),
      ...(pendingImages && pendingImages.length ? { images: pendingImages } : {}),
    }).then(sent => {
      accepted?.(sent)
      if (destroyed) return
      /* THE PICTURE DID NOT GO, AND THIS IS WHERE THE PERSON FINDS OUT.
       *
       * shell/agent-host.cjs sendTurn answers a turn whose picture its provider
       * cannot carry with `pictureNotSent` -- the provider, the file names and
       * one plain sentence -- and shell/node-transcript-capture.cjs writes that
       * sentence into the durable record as its own row. Nothing in this
       * renderer read it, on any surface (searched twice, 2026-09-16: zero
       * occurrences of pictureNotSent outside shell/ and tools/test/). So the
       * chip vanished from the composer, the words went, the agent answered
       * without the picture, and the one sentence written for the person to
       * read existed only on disk. That is the defect T18 exists to end,
       * reproduced one layer above where it was first found.
       *
       * It paints as a NOTE, not as the agent speaking: the product is saying
       * this, and the send is not a failure -- their message did go. */
      if (typeof sent?.pictureNotSent?.sentence === 'string' && sent.pictureNotSent.sentence) {
        note?.(sent.pictureNotSent.sentence)
      }
      turnLogAppend(node.sessionId, sent && sent.turnId, text)
      if (sent && typeof sent.turnId === 'string' && sent.turnId) sentEntry.turnStamp = sent.turnId
      if (originSurface) broadcastWorkspaceOwnerMessage(node.sessionId, originSurface, text, sentEntry)
      /* The acknowledgement can arrive after its own turn already ended,
         over its own separate IPC round trip. Marking the node running here
         would then be the last write, overwriting a terminal status this
         session's turn_completed handler already painted. See
         sessionCompletedTurnIds. */
      const alreadySettled = sent && typeof sent.turnId === 'string' && sent.turnId
        && sessionCompletedTurnIds.get(node.sessionId) === sent.turnId
      if (treeStore && !alreadySettled) {
        treeStore.setNodeStatus(node.id, 'running', { note: '' })
        refreshTree()
      }
    }, error => {
      dropTurnReply(node.sessionId, reply)
      const code = refusalCode(error)
      // The host retains ended sessions for Stop, so both a missing session
      // and a retained dead one require the same automatic replacement.
      if (['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED', 'AGENT_SESSION_UNKNOWN', 'AGENT_SESSION_ENDED'].includes(code)) {
        // Remove the refused optimistic line before any recovery guard or
        // transcript seed, so the replacement receives these words once.
        stripPhantomYouLine(node, node.sessionId, text)
        if (recoveryAttempted) {
          fail(queuedSendRefusalSentence(code), { code, unconfirmed: false, restoreDraft: true })
          return
        }
        void recoverDeadSessionSend(node, text, { reply, fail, queued, note, attachments, accepted, keepQueued })
        return
      }
      /* THE RENDERER'S IDLE ANSWER CAN LOSE TO THE HOST'S ACTIVE TURN.
         nodeBusy() is a local snapshot; sendTurn() is the authority. Before
         this branch, that ordinary boundary race surfaced as "Nothing was
         started ... already working on a turn" and dropped the person's
         words unless they typed them again. The host already reserves the
         next boundary for a refused person send. Put the words into the same
         durable outbox every intentionally busy send uses, and let its normal
         completion listener deliver them.

         Attachments remain in the composer instead: this outbox carries text
         only, so pretending the file queued with it would silently lose it. */
      if (code === 'AGENT_TURN_ACTIVE') {
        stripPhantomYouLine(node, node.sessionId, text)
        if (Array.isArray(attachments) && attachments.length) {
          fail(QUEUE_PANEL.busyAttachment, { retract: true })
          return
        }
        const waiting = queueForSession(node, text)
        if (!waiting.ok) { fail(waiting.sentence, { unconfirmed: false }); return }
        const announce = typeof queued === 'function' ? queued : fail
        announce(QUEUE_PANEL.turnBecameBusy)
        return
      }
      fail(queuedSendRefusalSentence(code), { code, unconfirmed: sendFailureIsUnconfirmed(code), restoreDraft: true })
    })
  }

  /* TAKE BACK THE LINE THE SEND PUT THERE, from both copies -- the window
     transcript and the durable record. Called once per refused send, from the
     rejection branch above. */
  function stripPhantomYouLine(node, deadSessionId, text) {
    const held = sessionTranscripts.get(deadSessionId) || []
    const last = held[held.length - 1]
    if (last && last.who === 'you' && last.text === text) {
      held.pop()
      sessionTranscripts.set(deadSessionId, held)
    }
    const durable = transcriptStore ? transcriptStore.get(node.id) : null
    if (!durable || !Array.isArray(durable.lines)) return
    const tail = durable.lines[durable.lines.length - 1]
    /* THE SAME LINE, NOT MERELY A LINE THIS ONE STARTS WITH.
     *
     * This compared the stored tail against a PREFIX of the newly typed text,
     * and the durable store is the only reason a prefix was ever involved: it
     * truncates a line at maxLineChars, so the words that were saved can
     * legitimately be the first 600 characters of what was typed. But
     * `text.slice(0, tail.text.length)` matches ANY shorter earlier line that
     * happens to start the same way -- type "ok" after a turn that began
     * "okay, next" and the branch below deleted the node's whole saved
     * conversation. So the prefix is admitted only where it is explained: a
     * tail of exactly the cap, over text longer than the cap. */
    const wasTruncated = tail
      && tail.text.length === TRANSCRIPT_LIMITS.maxLineChars
      && text.length > TRANSCRIPT_LIMITS.maxLineChars
      && tail.text === text.slice(0, TRANSCRIPT_LIMITS.maxLineChars)
    if (!tail || tail.who !== 'you' || !(tail.text === text || wasTruncated)) return
    if (transcriptStore?.rollback && tail.id) {
      void transcriptStore.rollback(node.id, tail.id)
      return
    }
    const trimmed = durable.lines.slice(0, -1)
    if (trimmed.length > 0) {
      transcriptStore.save(node.id, {
        lines: trimmed,
        threadId: durable.threadId,
        effort: durable.effort,
        provider: durable.provider,
        account: durable.account,
      })
    } else {
      transcriptStore.remove(node.id)
    }
  }

  /* THE RECOVERY: reached exactly once per dead session per send, from the
     rejection branch above. Order matters — the phantom you-line the failed
     send already appended is stripped from the window transcript AND the
     durable record BEFORE the resume reads it, or the words would ride
     twice: once inside the seed the fresh agent reads, once as the queued
     message. The replacement opens idle and carries history as context on
     the first queued message, through the normal queue drain. */
  const recoveringNodes = new Set()
  async function recoverDeadSessionSend(node, text, { reply, fail, queued, note, attachments, accepted, keepQueued }) {
    const refuseDraft = (sentence, details = {}) => fail(sentence, { ...details, unconfirmed: false, restoreDraft: true })
    // The composer separates product queue notices from an agent's answer.
    // Its queued callback also removes the optimistic sent-message bubble.
    const queuedNotice = sentence => (typeof queued === 'function' ? queued : reply)(sentence)
    // Each user send gets one replacement attempt. The direct attachment
    // retry carries recoveryAttempted; queued delivery never recurses here.
    /* The recovery brings the agent back by STARTING one, so a computer where
       that is switched off is told which switch it was -- not "the session is
       gone", which is true and useless here. */
    if (!isWriteEnabled(START_CONTROL_FLAG)) { refuseDraft(startControlOffReason()); return }
    const carriesImages = Array.isArray(attachments) && attachments.length > 0
    // The host explicitly rejected the old session, so this particular Send
    // now was not accepted. Return its exact held row to the queue before any
    // Resume wait. Ordinary typed messages still create distinct entries.
    const queueNode = treeStore ? treeStore.getNode(node.id) || node : node
    let heldPending = null
    if (!carriesImages && typeof keepQueued === 'function') {
      const entryId = keepQueued()
      const entry = entryId ? outboxList(queueNode.sessionId).find(row => row.id === entryId) : null
      if (!entry) {
        fail(QUEUE_PANEL.moveGone, { unconfirmed: false, retract: true })
        return
      }
      heldPending = { ok: true, entry }
    }
    if (recoveringNodes.has(node.id)) {
      if (carriesImages) { refuseDraft(QUEUE_PANEL.busyAttachment); return }
      /* A second send joins behind the triggering text at the node's current
         address, and the replacement carries both forward in that order.

         NOT GATED ON sessionNodeIds.has(freshNow.sessionId) -- that used to
         be exactly the defect this comment says the branch exists to
         prevent. resumeNodeSessionUnguarded deletes oldSessionId from
         sessionNodeIds near its own top, well before bridge.start ever
         answers, and only sets the NEW id into sessionNodeIds partway
         through settling a successful resume -- treeStore.attachSession,
         which is what moves node.sessionId (and so `freshNow.sessionId`)
         onto that new id, runs later still. So for most of a resume's whole
         duration `freshNow.sessionId` named an id that was, at that exact
         instant, a key of NEITHER the old nor the new entry in
         sessionNodeIds -- and a second typed message landing anywhere in
         that span read this gate as "no address to queue against" and fell
         straight to fail(START_REFUSAL.sessionGone), losing words the
         person had just typed while watching "Reconnecting…" on screen.
         recoveringNodes.has(node.id), already checked to reach this branch,
         is the fact that actually matters: resumeNodeSession single-flights
         every resume per node (nodeReplacementFlight), so it names the ONE
         resume this queues against, and that resume carries this entry
         forward on success (outboxMoveSession) or leaves it standing on
         oldSessionId, exactly where a retry expects to find it, on failure
         -- never a session id nothing will ever service again. */
      const freshNow = treeStore ? treeStore.getNode(node.id) || node : node
      if (freshNow.sessionId) {
        const queued = heldPending || outboxEnqueue(freshNow.sessionId, text)
        if (queued.ok) { accepted?.(); queuedNotice(queued.sentence || QUEUE_PANEL.cardQueued); return }
        refuseDraft(queued.sentence)
        return
      }
      refuseDraft(START_REFUSAL.sessionGone)
      return
    }
    // Admit the triggering text before the first await. Later sends can then
    // join the real FIFO without overtaking it during a native resume/fallback.
    // Images remain in the composer until the direct send can accept them;
    // this outbox stores text and cannot claim to have queued an attachment.
    const pending = carriesImages ? null : heldPending || outboxEnqueue(queueNode.sessionId, text)
    if (pending && !pending.ok) { refuseDraft(pending.sentence); return }
    recoveringNodes.add(node.id)
    try {
      // The send already removed its optimistic line. Stripping again here
      // could remove an earlier, legitimate message with identical text.
      const seeded = Boolean(transcriptStore && transcriptStore.has(node.id))
      const reconnecting = seeded ? RECOVERED_SESSION.reconnecting : RECOVERED_SESSION.bare
      note?.(reconnecting, { retract: Boolean(pending) })
      let resumeRefusal = null
      const ok = await resumeNodeSession(node, { deliverQueued: false, deferSeed: true, onRefused: result => { resumeRefusal = result } })
      if (ok?.stale === true) {
        // Accepted opening work belongs to its recorded session, not the new node address.
        // The owner's unsent row stays where the validated attachment moved it.
        if (pending) {
          accepted?.()
          queuedNotice(QUEUE_PANEL.waitingForResume)
        } else refuseDraft(QUEUE_PANEL.busyAttachment)
        return
      }
      if (!ok) {
        /* `ok` IS FALSE FOR THREE DIFFERENT FACTS, AND ONLY TWO OF THEM LEAVE
           SOMETHING TO QUEUE AGAINST. resumeNodeSession collapses them itself:
           `{ran: false}` from nodeReplacementFlight -- ANOTHER replacement (a
           person's own Resume/Restart press, or a second recovery for this
           same node) already holds this node's single-flight slot -- a
           genuine `bridge.start()` failure -- and a resume the engine
           answered by saying the session is OVER -- all three come back as
           the bare boolean `false` here. Telling the person their words are
           gone in the FIRST case was the defect: the other operation is a
           live, addressable resume in progress, and resumeNodeSessionUnguarded's
           own comment on the SECOND case already promises "a resume that
           fails leaves it exactly where it was, beside the conversation it
           belongs to" -- node.sessionId is untouched by a failed attempt
           precisely so a later retry finds the queue waiting under it. Both
           of those are the same answer this function already gives its OWN
           second sender, just above: retain the entry already admitted
           against the session the store named, carried forward on success.
           THE THIRD CASE IS NOT THE SAME. resumeNodeSessionUnguarded's own
           ended branch attaches the new, already-retired session id to the
           node and deliberately PRESERVES a 'starting'/'running' status
           before returning false -- so `freshAfterFailure.sessionId` reads
           truthy exactly as it does for the other two, but nothing is coming
           back for it: nothing reachable from here will ever drain it, retry
           it, or tell the person otherwise. That dead session id was never
           added to sessionNodeIds (only a SUCCESSFUL resume does that), so
           nodeSessionEnded -- this file's own named answer to "the record
           says busy and there is nothing behind it", already used at three
           other call sites (treeNodeStatusWord, the rail's "said" panel, the
           remove-row guard) -- reads this case correctly where a bare
           sessionId check cannot. Speak the honest dead end there too. */
        const freshAfterFailure = treeStore ? treeStore.getNode(node.id) || node : node
        if (heldPending) {
          // The original row already belongs to the queue, not to this chat's
          // now-released transport hold. A closed chat or a newer draft cannot
          // recover words deleted here. Keep the exact row unless the person
          // Unqueued it, and follow an ended replacement's saved address.
          const id = heldPending.entry.id
          const atOriginal = outboxList(queueNode.sessionId).some(entry => entry.id === id)
          const atCurrent = freshAfterFailure.sessionId && outboxList(freshAfterFailure.sessionId).some(entry => entry.id === id)
          if (!atOriginal && !atCurrent) {
            fail(QUEUE_PANEL.moveGone, { unconfirmed: false, retract: true })
            return
          }
          if (atOriginal && freshAfterFailure.sessionId && freshAfterFailure.sessionId !== queueNode.sessionId) {
            outboxMoveSession(queueNode.sessionId, freshAfterFailure.sessionId)
          }
          accepted?.()
          const waiting = nodeReplacementFlight.busy(node.id) ? '' : QUEUE_PANEL.waitingForResume
          queuedNotice([QUEUE_PANEL.cardQueued, waiting].filter(Boolean).join(' '))
          if (resumeRefusal?.message) fail(resumeRefusal.message, { code: resumeRefusal.code, unconfirmed: false })
          return
        }
        if (freshAfterFailure.sessionId && !nodeSessionEnded(freshAfterFailure)) {
          if (pending) {
            accepted?.()
            const waiting = nodeReplacementFlight.busy(node.id) ? '' : QUEUE_PANEL.waitingForResume
            queuedNotice([pending.sentence || QUEUE_PANEL.cardQueued, waiting].filter(Boolean).join(' '))
            if (resumeRefusal?.message) fail(resumeRefusal.message, { code: resumeRefusal.code, unconfirmed: false })
            return
          }
        }
        if (pending?.entry) {
          outboxCancel(queueNode.sessionId, pending.entry.id)
          if (freshAfterFailure.sessionId !== queueNode.sessionId) outboxCancel(freshAfterFailure.sessionId, pending.entry.id)
        }
        refuseDraft(resumeRefusal?.message || START_REFUSAL.sessionGone, { code: resumeRefusal?.code })
        return
      }
      if (ok !== 'engine' && seeded) note?.(ok === 'ready'
        ? 'A fresh agent will receive your message together with the saved conversation.'
        : RECOVERED_SESSION.summarised)
      const fresh = treeStore ? treeStore.getNode(node.id) || node : node
      if (!fresh.sessionId) { refuseDraft(START_REFUSAL.sessionGone); return }
      if (pending) {
        accepted?.()
        // Settle the queue admission only after the replacement has settled.
        // Send now may then promote its entry before the normal FIFO drain.
        queued?.('')
      } else if (ok === 'engine' || ok === 'ready' || !seeded) {
        // Native resume and deferred-history fallback both open idle. Send
        // the original attachments with this message, allowing one retry.
        treeCardSend(fresh, text, {
          reply, queued, note, attachments, accepted, recoveryAttempted: true,
          fail: (sentence, details) => fail(sentence || START_REFUSAL.sessionGone, details),
        })
        return
      } else {
        refuseDraft(QUEUE_PANEL.busyAttachment)
      }
      if (fresh.status !== 'interrupted' && !nodeBusy(fresh) && !nodeSessionEnded(fresh)) {
        const nextQueued = outboxTakeNext(fresh.sessionId)
        if (nextQueued) void drainOutboxMessage(fresh.sessionId, fresh.id, nextQueued)
      }
    } finally {
      recoveringNodes.delete(node.id)
    }
  }

  /* QUEUE ONE MESSAGE, AND NEVER PARK IT WHERE NOTHING DRAINS.
   *
   * drainOutboxMessage's own note below has always named two callers -- the
   * turn-completed listener "and from the queue strip when a person queues at
   * an idle session" -- and the second one did not exist. Every enqueue door
   * called outboxEnqueue bare, so "/queue finish the refactor" typed at an
   * IDLE agent answered "Queued -- sends by itself when this turn finishes"
   * and then waited for a completion event that only a running turn can emit.
   * Nothing was running. The words sat in the strip until the window closed.
   * That is the exact failure this file's own notes keep re-finding: "a queue
   * no turn will ever drain".
   *
   * So the one enqueue door asks nodeBusy -- the single reader of "is this
   * node busy" this file already routes every other such question through --
   * and when there is no turn to wait behind it takes the queue's oldest
   * message straight back out and puts it on the same wire the turn-completed
   * drain uses. A refusal there returns it to the FRONT, unchanged. The
   * sentence says which of the two happened, and says "went now" only about
   * the message that really went. */
  function queueForSession(node, text) {
    const live = treeStore ? treeStore.getNode(node.id) || node : node
    const queued = outboxEnqueue(live.sessionId, text)
    if (!queued.ok) return queued
    if (nodeBusy(live) || pendingModelChoice(live)) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
    if (nodeReplacementFlight.busy(live.id)) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
    /* nodeBusy(live) is false for TWO different facts: a genuinely idle node
       (drain now, correct) and a node whose status still reads
       'starting'/'running' while sessionIsLive is false -- nodeSessionEnded(live)
       true -- the same resumeNodeSessionUnguarded ended-branch shape aeaad75
       gated recoverDeadSessionSend's !ok branch on. Without this check, an
       eager drainOutboxMessage() fires bridge.send() at a session id nothing
       answers to, replying an optimistic "Queued" before that send is even
       attempted, self-correcting only a round trip later. Leave it queued,
       same as the busy branch above, instead of draining into nothing. */
    /* T124. THE DOOR THAT BURNT THE THIRTY TURNS.
     *
     * MEASURED (T124 ledger entry): Manager (5323eb2d) returned "You've
     * reached your Fable limit. Switch to another model, or manage usage
     * credits" on more than thirty consecutive turns from 21:47Z to 23:38Z,
     * each ending "Turn did not finish", WHILE MESSAGES KEPT BEING DELIVERED
     * TO IT. This branch is how they kept being delivered: a limit refusal
     * leaves the node 'turn-failed', 'turn-failed' is not busy, the session is
     * not ended -- so every one of the three gates above says "go", the queue
     * is drained straight onto the wire, and the provider refuses it for the
     * same reason it refused the last one. The loop is not a retry loop;
     * nothing was retrying. It is this door, answering honestly, thirty times.
     *
     * The fourth gate is the account-limit fence. It behaves exactly like the
     * busy and session-ended gates beside it -- the words stay QUEUED, in
     * order, and go out when the block clears -- so nothing the person typed
     * is lost, and the agent stops paying for an answer nobody can get. The
     * coordinator sets and clears it (account-recovery-coordinator.js
     * externalBlock) after it has tried another model and another account. */
    if (recoveryCoordinator()?.externalBlock?.(live.id)?.blocked === true) {
      return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
    }
    if (nodeSessionEnded(live)) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
    const entry = outboxTakeNext(live.sessionId)
    if (!entry) return { ok: true, entry: queued.entry, sentence: QUEUE_PANEL.cardQueued }
    void drainOutboxMessage(live.sessionId, live.id, entry)
    return {
      ok: true,
      entry: queued.entry,
      sentence: entry.id === queued.entry.id ? QUEUE_PANEL.cardQueuedIdle : QUEUE_PANEL.cardQueued,
    }
  }

  /* ONE QUEUED MESSAGE GOES OUT, THROUGH THE SAME WIRE A TYPED ONE USES.
     Called from the turn-completed branch below (the engine's only "I am
     free" signal) and from the queue strip when a person queues at an idle
     session. A refusal puts the words back at the FRONT and says so; a view
     that died before the outcome files it with the undelivered-writes store
     rather than swallowing it. */
  async function drainOutboxMessage(sessionId, nodeId, entry) {
    const bridge = typeof window === 'undefined' ? null : window.mcAgent
    if (!bridge || typeof bridge.send !== 'function') {
      // heldReason travels with the words for the same reason the refusal branch
      // below sets it: a queued message that came back needs to be able to say
      // WHY, and this is the only moment that fact exists.
      outboxRequeueFront(sessionId, { ...entry, heldReason: 'SESSION_OUTBOX_NO_BRIDGE' })
      return
    }
    // The queue settlement belongs to this send even after a replacement.
    // Its visible result belongs only to the node/session captured at dispatch.
    const drainStore = treeStore
    const drainNode = drainStore?.getNode(nodeId)
    const drainCreatedAt = drainNode?.createdAt
    const drainOwner = sessionNodeIds.get(sessionId)
    const mayPublish = () => !destroyed && treeStore === drainStore
      && window.mcAgent === bridge && drainOwner === nodeId
      && sessionNodeIds.get(sessionId) === nodeId
      && Boolean(drainNode && drainStore?.getNode(nodeId)?.createdAt === drainCreatedAt
        && drainStore.getNode(nodeId)?.sessionId === sessionId)
    let drained = null
    const drainOverride = sessionModelOverride.get(sessionId)
    try {
      drained = await withResearchTreeBinding(bridge).send({
        sessionId,
        text: entry.text,
        ...(drainOverride ? { model: drainOverride } : {}),
      })
    } catch (error) {
      /* THE REFUSAL CODE IS KNOWN EXACTLY HERE AND NOWHERE ELSE, so this is
         where it has to be written down. It used to be spent on the org status
         line below and then dropped, which left the entry sitting in the queue
         with no record of why it came back -- the strip could say "waiting" and
         nothing more, and a surface that wants to draw a bounded "waiting for
         capacity" state had nothing to bind to. It rides on the entry and
         reaches every surface through the SESSION_OUTBOX_EVENT detail. */
      const code = refusalCode(error)
      const unconfirmed = sendFailureIsUnconfirmed(code)
      outboxRequeueFront(sessionId, {
        ...entry,
        ...(unconfirmed ? { deliveryUnconfirmed: true } : {}),
        ...(code ? { heldReason: code } : {}),
      })
      // Retain the exact queue outcome above, but do not publish a detached
      // send's refusal into a replacement node, bridge or view.
      if (!mayPublish()) return
      setOrgStatus(unconfirmed ? queuedSendRefusalSentence(code) : QUEUE_PANEL.notSent, 'refuse', { sticky: true, code })
      /* In place, never a rebuild: the person may be typing in the actions
         popup's filter, and the queue strip already repaints itself through
         SESSION_OUTBOX_EVENT. See repaintRailStatus. */
      if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
        repaintRailStatus(currentRailTreeNode)
      }
      return
    }
    /* THE OTHER WAY A TAKEN ENTRY SETTLES: bridge.send() resolved, so this
       message reached the wire and will never come back to the queue through
       requeueFront(). The seat outboxTakeNext() held for it in the cap is
       released here, before either return below, so a session that just
       drained its queue by one is honestly one seat freer for the next
       enqueue -- not still short one for a delivery that already succeeded.
       The entry goes with the session id because it is what names WHICH
       delivery settled: a Stop or a resume that landed while this send was on
       the wire answers for the deliveries outstanding at that moment, and
       without the entry the store can only guess which one this is. */
    outboxConfirmDelivered(sessionId, entry)
    // Acceptance settles only this envelope. It cannot repaint another
    // incarnation of the node or mark a newer session as running.
    if (!mayPublish()) return
    /* THE STAMP IS THE ENGINE'S OWN TURN ID, EVIDENCE ALREADY IN HAND. bridge.send
       resolved a moment ago with `drained`, so unlike the interactive send below
       (whose turn id is not minted until after the words are already on screen),
       a queued message can carry its real stamp from the very first paint. */
    const acceptedAt = Date.now()
    const acceptedTurnStamp = drained && typeof drained.turnId === 'string' && drained.turnId ? drained.turnId : null
    transcriptAppend(sessionId, { who: 'you', text: entry.text, at: acceptedAt, turnStamp: acceptedTurnStamp })
    broadcastOwnerMessage(sessionId, entry.text, { at: acceptedAt, turnStamp: acceptedTurnStamp })
    turnLogAppend(sessionId, drained && drained.turnId, entry.text)
    if (treeStore) {
      treeStore.setNodeStatus(nodeId, 'running', { note: '' })
      refreshTree()
    }
    setOrgStatus(QUEUE_PANEL.sentNext, 'ok')
    if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
      repaintRailStatus({ ...currentRailTreeNode, status: 'running' })
    }
  }

  /* THE TREE'S OWN EAR ON THE SESSION STREAM. Without this, a tree-started
     agent answered into a void: computers.js subscribed to nothing, the rail
     stayed on "starting", and the person concluded agents do not respond --
     measured 2026-08-13 on the installed 1.0.7 while a live codex app-server
     child ran the session. Reads only through sessionEventText/sessionTurnStatus
     (the same pair the agent page uses), touches only sessions this tree
     started (sessionNodeIds), and detaches with the view via unsubs. */
  if (typeof window !== 'undefined' && window.mcAgent && typeof window.mcAgent.onEvent === 'function') {
    unsubs.push(recoveryCoordinator().subscribe(result => {
      if (destroyed) return
      if (Object.hasOwn(result, 'continuationStatus')) {
        renderOrgStatus()
        return
      }
      if (!treeStore?.getNode(result.nodeId)) return
      publishProviderModeEvent(null)
      if (result.started) {
        const { started, lines } = result
        sessionTranscripts.set(started.sessionId, lines)
        if (result.partialText) sessionTurnText.set(started.sessionId, result.partialText)
        if (started.threadId) sessionThreadIds.set(started.sessionId, started.threadId)
        if (started.effort) sessionEfforts.set(started.sessionId, started.effort)
        sessionAccountNames.set(started.sessionId, started.account ?? null)
        notifyNodeStatusListeners()
        rebindRailToSession(result.nodeId)
      }
      if (Object.hasOwn(result, 'retryPolicy')) notifyNodeStatusListeners()
      refreshTree()
      paintAccountRetryControls(result.nodeId)
      /* THE REOPEN POLL'S REFUSAL, OFFERED AS A CHOICE. The coordinator brings
         saved agents back on its own; when the saved account cannot continue
         and the automatic move did not take, it says so here (switchOffer)
         and the dialog on the circle offers account, model and depth. */
      if (result.switchOffer && currentDataSource() === 'local') {
        const node = treeStore.getNode(result.switchOffer.nodeId)
        if (node) void offerSwitchAndContinue(node, { sentence: result.switchOffer.sentence || '', refusedAccount: result.switchOffer.account || null })
      }
    }, { observes: nodeId => !destroyed && Boolean(treeStore?.getNode(nodeId)) }))
    handleAgentEvent = async (packet, { nativeReplayIdle = false } = {}) => {
      // Preserve replay provenance if an interrupt acknowledgement yields.
      const isHistoricalReplay = replayingRemoteHistory
      if (destroyed) return
      const sessionId = packet && typeof packet.sessionId === 'string' ? packet.sessionId : ''
      if (!sessionId || !sessionNodeIds.has(sessionId)) return
      const eventStore = treeStore
      const eventNodeId = sessionNodeIds.get(sessionId)
      const eventNode = eventStore?.getNode(eventNodeId)
      const eventCurrent = () => !destroyed && treeStore === eventStore
        && sessionNodeIds.get(sessionId) === eventNodeId
        && eventStore?.getNode(eventNodeId)?.createdAt === eventNode?.createdAt
        && eventStore?.getNode(eventNodeId)?.sessionId === sessionId
      // A retained routing edge proves custody only. Detached session events may
      // not publish into the current node or release either session's outbox.
      if (!eventCurrent()) return
      if (packet.event?.type === 'person_turn') {
        acceptRemotePersonTurn(sessionId, packet)
        return
      }
      confirmedFileChanges.add(packet, null)
      const ended = sessionEndedEvent(packet, sessionId)
      if (ended) {
        /* THE CHILD'S OWN EXIT IS A SESSION END, NOT A TURN COMPLETION.
         *
         * The host has always forwarded this packet through the same onEvent
         * stream as deltas and completions. This listener used to ask only the
         * turn readers below, so none of them recognised it: the live-session
         * map kept the dead id, the node stayed blue and ticking, queued work
         * waited for a completion that could never arrive, and every control
         * remained pointed at a process the host had already reaped.
         *
         * Retire the routing edge first-class here. Preserve any words and tool
         * actions that really arrived, settle every visible busy surface once,
         * and deliberately DO NOT drain the outbox. Those messages belong to
         * the node and move to its next real session on Resume. The durable node
         * keeps its session id as evidence of the run; absence from
         * RUN_SESSION_NODES is the existing liveness fact used after an app
         * restart too. */
        const nodeId = sessionNodeIds.get(sessionId)
        const node = treeStore ? treeStore.getNode(nodeId) : null
        const wasBusy = Boolean(node && (node.status === 'starting' || node.status === 'running'))
        const spoken = (sessionTurnText.get(sessionId) || '').trim()
        const said = spoken ? `${spoken}\n\n${ENDED_SESSION.said}` : ENDED_SESSION.said
        const openTurnId = sessionOpenTurns.get(sessionId) || null

        recordTurnActions(sessionId)
        if (wasBusy) {
          transcriptAppend(sessionId, { who: 'agent', text: said, at: Date.now(), turnStamp: openTurnId })
          nodeReplies.set(nodeId, said)
          deliverTurnReply(sessionId, said, openTurnId)
          if (treeStore) {
            treeStore.setNodeReply(nodeId, said)
            /* Keep the stored live status and session id: once the runtime map
               entry is removed below, the shared liveness reader renders this
               as stopped. Re-writing the same status records the actual stop
               time and the cause without pretending a turn completed. */
            treeStore.setNodeStatus(nodeId, node.status, { note: statusNote(ENDED_SESSION.note) })
          }
        } else {
          /* An idle session may exit after its last completed turn. Preserve
             that finished reply/status; only its now-dead routing is retired. */
          if (turnReplies.has(sessionId)) deliverTurnReply(sessionId, ENDED_SESSION.said)
        }

        const approvalId = sessionPendingApprovals.get(sessionId)?.approvalId || null
        clearSessionApprovals(sessionId)
        clearInlineApproval(sessionId, approvalId)
        if (currentRailTreeNode && currentRailTreeNode.id === nodeId) {
          controlsPage.querySelector('[data-tree-approval]')?.remove()
        }
        if (railSaid && railSaid.nodeId === nodeId) {
          railSaid.appender.flushNow()
          /* The appended text is still raw at this point -- see
             paintSaidReply's own header for why. This is the moment the turn
             actually settles, so the box gets its one real repaint: the same
             final `said` text, now run through the same safe renderer. */
          paintSaidReply(railSaid.host, said)
          disposeRailSaid()
        }
        if (railChat && railChat.sessionId === sessionId && railChat.stream) {
          railChat.stream.close(said)
          railChat.stream = null
        }

        retireTreeSessionRuntime(sessionId)
        refreshTree()
        if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
          repaintRailStatus(treeStore?.getNode(nodeId) || currentRailTreeNode)
        }
        return
      }
      const speech = sessionTextReader.read(packet, sessionId)
      const text = speech?.text
      if (text) {
        /* WHERE ONE TURN ENDS AND THE NEXT BEGINS, taken from the engine's own
           naming of the turn rather than inferred from a completion packet
           that may never come. Without this the accumulator and the open
           bubble both survived a turn that ended any other way, and the next
           turn's first word was appended to the last turn's answer inside the
           same bubble -- the owner's "combine into each other". */
        settleTurnBoundary(sessionId, sessionEventTurnId(packet, sessionId))
        /* The paragraph break between two messages of one turn, if one is
           owed, before the new words. The open rail streams the same break. */
        if (speech.breakBefore && sessionTurnText.get(sessionId)) {
          sessionTurnText.set(sessionId, sessionTurnText.get(sessionId) + '\n\n')
          if (railSaid && railSaid.nodeId === sessionNodeIds.get(sessionId)) railSaid.appender.push('\n\n')
        }
        sessionTurnText.set(sessionId, (sessionTurnText.get(sessionId) || '') + text)
        scheduleChatSpeech(sessionId)
        /* The open rail streams the same delta it buffers. The waiting line
           leaves on the first word -- "no answer yet" beside an answer is the
           kind of stale sentence this page is being cured of. */
        if (railSaid && railSaid.nodeId === sessionNodeIds.get(sessionId)) {
          if (railSaid.waitingLine) {
            railSaid.waitingLine.remove()
            railSaid.waitingLine = null
          }
          railSaid.appender.push(text)
        }
        /* The rail's Chat tab streams the SAME turn: one live bubble, opened
           on the first delta, repainted with the accumulated text (push
           replaces, so a missed frame can never double words), closed by the
           turn completion through the wrapped reply handler. */
        if (railChat && railChat.sessionId === sessionId) {
          /* THE STAMP THIS BUBBLE OPENS WITH IS THE TURN settleTurnBoundary JUST
             NAMED, above -- the engine's own turnId, or null when it named none.
             openStream takes the stamp only at open, not at close, so this is the
             one chance to hand it the evidence; a turn the engine never named
             opens unstamped rather than inventing one to fill the badge. */
          if (!railChat.stream) railChat.stream = railChat.root.openStream?.({ at: Date.now(), turnStamp: sessionOpenTurns.get(sessionId) || null,
            ...(nativeReconcileSessions.has(sessionId) && sessionOpenTurns.get(sessionId) ? { entryId: `agent:${sessionId}:${sessionOpenTurns.get(sessionId)}` } : {}) }) ?? null
          scheduleRailStream(sessionId)
        }
        scheduleChipRefresh(sessionNodeIds.get(sessionId))
        return
      }
      const used = sessionUsageEvent(packet, sessionId)
      if (used) {
        sessionUsage.set(sessionId, used.usage)
        if (currentRailTreeNode && currentRailTreeNode.id === sessionNodeIds.get(sessionId)) {
          const usageHost = controlsPage.querySelector('[data-tree-usage]')
          if (usageHost) {
            usageHost.textContent = usageSentence(used.usage)
            usageHost.removeAttribute('hidden')
          }
        }
        return
      }
      /* A RULE THE AGENT FILED, SHOWN AS ITS OWN ROW. The call is remembered
         for its words; the result -- and only a result that says filed:true
         with a ledger id -- draws the row, and refreshes the rules panel if
         this circle's rail is open, so the new entry appears where the
         person will look for it. The ordinary action row for the tool call
         still paints below; this row is the sentence a person reads. */
      const receivedAt = Date.now()
      const ruleCall = sessionRuleFilingCall(packet, sessionId)
      if (ruleCall) rememberRuleCall(sessionId, ruleCall)
      const filedRule = sessionFiledRule(packet, sessionId)
      if (filedRule) {
        const words = takeRuleCall(sessionId, filedRule.toolCallId)
        broadcastAction(sessionId, filedRuleChatRow({ ...filedRule, words }, { at: receivedAt }))
        refreshStandingRequests()
      }
      const activity = sessionActivityEvent(packet, sessionId)
      if (activity) {
        const nodeId = sessionNodeIds.get(sessionId)
        if (activity.kind === 'approval' && activity.approvalId) {
          /* REMEMBERED FIRST, whoever is looking -- see sessionPendingApprovals.
             The render below is the same-moment case; the rail-open path reads
             the map for everyone who arrives later. */
          sessionPendingApprovals.set(sessionId, {
            ...activity,
            turnId: sessionEventTurnId(packet, sessionId) || sessionOpenTurns.get(sessionId) || null,
          })
          /* EVENT-DRIVEN: the card exists only while a request is pending.
             Buttons offer exactly the decisions the request itself named. */
          if (currentRailTreeNode && currentRailTreeNode.id === nodeId) {
            renderApprovalCard(sessionId, sessionPendingApprovals.get(sessionId))
          }
          /* THE OTHER DOOR, same moment: any chat panel already registered for
             this session (the rail's Chat tab, a compact card) is told too. */
          pushInlineApproval(sessionId, activity)
        }
        /* THE ACTION GOES INTO THE CONVERSATION, and everything this branch
           already did still happens below. The one-line Details string, the
           canvas chip and the approval card were never wrong -- they were
           simply all there was, and each one is overwritten by the next event.
           A row in the chat log is the part that STAYS.
           The turn is named so a busy turn's rows fold under their own count
           rather than under the whole session's. */
        /* A turn may begin with a tool before it says a word. Adopt the engine's
           turn identity here too, so that first real call is not filed into a
           nameless session total. */
        settleTurnBoundary(sessionId, sessionEventTurnId(packet, sessionId))
        const openTurn = sessionOpenTurns.get(sessionId) || null
        const buffer = actionBufferFor(sessionId)
        const metricsBefore = buffer.metrics(openTurn)
        const filed = buffer.add(activity, { turnId: openTurn, at: receivedAt })
        const metricsChanged = !sameMetricSnapshot(metricsBefore, buffer.metrics(openTurn))
        if (filed.row) {
          broadcastAction(sessionId, actionChatRow(filed.row))
        } else if (filed.change === 'folded') {
          /* THE CAP SAYS SO OUT LOUD. One row, repainted with its own count,
             rather than two hundred rows and a silence about the rest. */
          broadcastAction(sessionId, {
            id: `action:more:${openTurn || 'turn'}`,
            tool: '',
            detail: foldedActionsLine(filed.folded),
            state: '',
            stateKey: '',
            body: '',
            at: receivedAt,
          })
        }
        const confirmedChanges = confirmedFileChanges.add(packet, activity)
        if (confirmedChanges) recordFileChanges(sessionId, confirmedChanges, receivedAt)
        const line = activityLine(activity)
        if (!line) {
          if (metricsChanged) notifyNodeStatusListeners()
          return
        }
        const stepChanged = nodeActivity.get(nodeId) !== line
        nodeActivity.set(nodeId, line)
        /* THINKING IS NOT AN ACTION. activityLine() renders it "Thinking.",
           which is the right words for the composer's working row but would
           overwrite the last real tool the card is still reporting. Route the
           reasoning to its own slot and leave `tool` naming the last thing
           that actually ran. */
        if (activity.kind === 'thinking') {
          nodeThinking.set(nodeId, activity.status === 'inProgress' ? readableTextPrefix(activity.output) : activity.output)
        } else nodeLastTool.set(nodeId, line)
        /* THE COMPOSER'S WORKING ROW HEARS THIS TOO. Every other nodeActivity
           mutation sits right before a refreshTree() (rewind, resume, clear,
           the turn-completion branch below), and refreshTree() is where
           notifyNodeStatusListeners() lives -- so those already reached a
           mounted chat's status.subscribe(). This branch fires many times a
           second while a turn runs and deliberately never called refreshTree
           (it would redraw the whole graph on every tool event); the cost of
           that restraint was that THIS mutation never told anyone, and a
           chat's working row went stale for the length of a turn. Calling the
           listener notifier alone -- not the heavier refreshTree -- gets the
           live text without paying for a graph redraw per tool call. */
        if (metricsChanged || stepChanged) notifyNodeStatusListeners()
        if (currentRailTreeNode && currentRailTreeNode.id === nodeId) {
          const activityHost = controlsPage.querySelector('[data-tree-activity]')
          if (activityHost) {
            activityHost.textContent = line
            activityHost.removeAttribute('hidden')
          }
        }
        scheduleChipRefresh(nodeId)
        return
      }
      const status = sessionTurnStatus(packet, sessionId)
      if (!status) return
      const interruptPending = turnInterrupts.pending(sessionId, sessionEventTurnId(packet, sessionId))
      if (interruptPending) {
        await interruptPending
        if (!eventCurrent()) return
      }
      const nodeId = sessionNodeIds.get(sessionId)
      /* WHOSE WORDS THIS COMPLETION MAY TAKE, ASKED BEFORE IT TAKES THEM.
       *
       * THE DEFECT (owner: "combine into each other"). This branch read the
       * status, which does not carry a turn id, and filed whatever was in the
       * accumulator as this completion's answer. Order two turns
       *     delta(turn-a) -> delta(turn-b) -> completed(turn-a)
       * and turn B's partial words were recorded as turn A's answer -- on the
       * node, in the durable record, and in every surface waiting on A -- and
       * B's accumulator was emptied under it, so B then answered with the
       * fragment it had left. settleTurnBoundary guards the opposite order
       * only.
       *
       * A completion for a turn that is no longer the open one therefore ends
       * HERE. Its own words were already filed when the next turn's first
       * delta arrived (settleTurnBoundary does exactly that, closes its bubble
       * and answers everything waiting), so there is nothing of A's left to
       * record and nothing of B's this may touch -- not the accumulator, not
       * the open-turn mark, not the node's status, and not the queue, which
       * drains on the engine saying it is free and it is not free.
       *
       * completionSettlesOpenTurn answers TRUE whenever it cannot tell -- a
       * nameless completion, or nothing else in flight -- so an engine that
       * does not name its turns behaves exactly as it did before. */
      if (!completionSettlesOpenTurn(packet, sessionId, sessionOpenTurns.get(sessionId))) return
      let spoken = (sessionTurnText.get(sessionId) || '').trim()
      if (nativeReconcileSessions.has(sessionId)) {
        const recovered = await recoveredTurnText(sessionId, nodeId,
          sessionEventTurnId(packet, sessionId) || sessionOpenTurns.get(sessionId), spoken)
        if (recovered === null || !eventCurrent()) return
        spoken = recovered.trim()
      }
      /* THE ENGINE'S OWN SENTENCE, WHEN THE TURN FAILED. Measured on the
         2026-08-18 walkthrough: a failed Fable turn ended is_error:true with
         "You're out of usage credits · resets Aug 25, 12am" as its result —
         the only human sentence the turn produced — and this branch printed
         "finished without any words back" because the completion event did not
         carry it. The engine now puts a failed result's sentence on the
         completion's `text` field (engine claude-cli-adapter.js), the shell
         forwards packets verbatim, and this is the read. Success completions
         carry no text by design, so this cannot double-print an answer. */
      const succeeded = sessionTurnSucceeded(status)
      const cancelled = sessionTurnCancelled(status)
      const engineSentence = sessionTurnFailureText(packet, sessionId)
      const completingTurnIdEarly = sessionEventTurnId(packet, sessionId) || sessionOpenTurns.get(sessionId)
      const userStopped = turnInterrupts.consume(sessionId, completingTurnIdEarly)
        || (isHistoricalReplay && recoveredNodeTurnStatus(treeStore?.getNode(nodeId), status, completingTurnIdEarly) === 'interrupted')
      const heldRefusal = confirmedRefusals.get(sessionId)
      const refused = Boolean(heldRefusal && completingTurnIdEarly && heldRefusal.turnId === completingTurnIdEarly)
      if (refused) confirmedRefusals.delete(sessionId)
      const outcome = nodeStatusForTurn(status, { userStopped })
      const said = turnCompletionWords({ succeeded, spoken, engineSentence, userStopped, cancelled, refused })
      sessionTurnText.delete(sessionId)
      /* A turn interrupted before its first text/tool event never opened a
         stream, but its completion still names the turn. Keep that identity:
         passing null made the compact chat close the previous already-closed
         bubble and silently lose this outcome. A nameless completion retains
         the known open turn, captured before the delete below. */
      const completingTurnId = sessionEventTurnId(packet, sessionId) || sessionOpenTurns.get(sessionId)
      /* Named here, before the optimistic 'running' write in treeCardSend can
         race it: a send acknowledgement for THIS turn id that resolves after
         this point reads the turn as already over and leaves the status this
         handler is about to write alone. See sessionCompletedTurnIds above. */
      if (completingTurnId) sessionCompletedTurnIds.set(sessionId, completingTurnId)
      /* Nothing is in flight for this session any more, so the next delta
         opens a fresh bubble rather than reopening this one. */
      sessionActions.get(sessionId)?.clearMetrics(completingTurnId)
      sessionOpenTurns.delete(sessionId)
      nodeActivity.delete(nodeId)
      /* A dead turn's approval is not a pending question: answered or not, the
         work it guarded is over. Forgotten here, and any painted card goes with
         it, so an interrupted agent cannot leave a ghost Approve button behind
         on the rail OR on any registered chat panel's own inline strip. */
      const endedApprovalId = sessionPendingApprovals.get(sessionId)?.approvalId || null
      clearSessionApprovals(sessionId)
      if (currentRailTreeNode && currentRailTreeNode.id === nodeId) {
        controlsPage.querySelector('[data-tree-approval]')?.remove()
      }
      clearInlineApproval(sessionId, endedApprovalId)
      if (railSaid && railSaid.nodeId === nodeId) {
        railSaid.appender.flushNow()
        /* Same repaint as the child-exit completion path above: the box was
           mid-stream in raw text; this is where the turn actually settles. */
        paintSaidReply(railSaid.host, said)
        disposeRailSaid()
      }
      /* A turn that ends having said nothing is a real outcome and must read
         as one; silence in this box would read as the product hanging. `said`
         is turnCompletionWords' answer: the streamed words, the engine's
         failure sentence, or the honest empty-turn line — never silence. */
      nodeReplies.set(nodeId, said)
      recordTurnActions(sessionId)
      transcriptAppend(sessionId, { who: 'agent', text: said, at: Date.now(), turnStamp: completingTurnId || null })
      deliverTurnReply(sessionId, said, completingTurnId || null)
      /* A rail-chat stream still open here means the rail was not one of the
         surfaces waiting on this turn (or the turn arrived with no claimant at
         all). The bubble still has to end. After, not before, the delivery
         above: when the rail IS waiting, its wrapped reply closes the stream
         itself, and closing twice would print the reply twice. */
      if (railChat && railChat.sessionId === sessionId && railChat.stream) {
        railChat.stream.close(said)
        railChat.stream = null
      }
      /* 'turn-failed', NEVER 'failed': 'failed' is the start-failure status
         and its chip word is "did not start" — writing it here un-said a start
         the signed spawn record shows (measured 2026-08-18). The note carries
         the engine's sentence so the rail and tooltip explain the failure.
         And a not-successful completion the PERSON asked for — the recorded
         interrupt, consumed here per turn — is 'interrupted', "stopped by
         you": calling a deliberate stop a failure was measured 2026-08-19
         beside a transcript honestly saying "Interrupted." */
      const outcomeNote = outcome === 'interrupted' ? statusNote('Stopped by you.')
        : cancelled ? statusNote(refused ? TURN_CANCELLED.refused : TURN_CANCELLED.note)
        : outcome === 'finished' ? ''
        : statusNote(engineSentence ? TURN_FAILED.reply(engineSentence) : TURN_FAILED.word)
      if (treeStore) {
        /* The reply outlives this view: the store keeps it on the node, and the
           in-memory map above becomes a cache in front of it. */
        treeStore.setNodeReply(nodeId, said)
        treeStore.setNodeStatus(nodeId, outcome, {
          note: outcomeNote,
          turnId: completingTurnId || null,
        })
        refreshTree()
      }
      // Notify after the terminal status is written, even without a graph.
      // Send now waiters must observe the completed turn as actually idle.
      notifyNodeStatusListeners()
      /* In place, never a rebuild -- the person may be mid-word in the actions
         popup's filter when this lands. See repaintRailStatus. */
      if (currentRailTreeNode && currentRailTreeNode.id === nodeId && controlsPage.classList.contains('is-active')) {
        // The selected snapshot can still carry the previous resume note.
        // Paint the same terminal explanation just written to the store.
        repaintRailStatus({ ...currentRailTreeNode, status: outcome, statusNote: outcomeNote })
      }
      /* The queue drains here because this is the engine's only "I am free"
         signal. Exactly one message — the next turn's completion drains the
         next.

         BUT NOT ON A HALT THE PERSON ASKED FOR. A turn somebody stopped
         completes exactly like a turn that ended on its own, so this drain
         fired on it too: press Halt with anything waiting, and the turn stops
         and the agent starts talking again in the same tick, on a message its
         owner had not released. The person pressed the one control whose
         whole meaning is "stop" and the product answered by starting the next
         turn -- which reads, correctly, as Halt not working.

         `userStopped` above is that fact, already in hand: it is set only
         once the ENGINE accepted the interrupt, and it is what makes this
         completion read 'interrupted' / "Stopped by you." rather than
         'turn-failed'. The same fact gates the drain.

         A GATE, NEVER A DROP. The words stay in the store and stay drawn in
         the strip -- Send now on a row really sends at an idle session, the
         box still works, and the next completion drains one as it always
         did. Only the send that rode the halt is gone. Throwing the queue
         away is a different act with its own door (the Stop row's close,
         which calls outboxClearSession and says how many it dropped), and
         this branch must not quietly become a second one of those. */
      if (userStopped || cancelled) cancelPendingModelChoice(nodeId)
      if (!userStopped && !cancelled && !isHistoricalReplay
          && await applyPendingModelChoice(nodeId, sessionId)) return
      if (!eventCurrent()) return
      if (!userStopped && (!isHistoricalReplay || (nativeReplayIdle && succeeded)) && !nodeReplacementFlight.busy(nodeId)) {
        const queuedNext = outboxTakeNext(sessionId)
        if (queuedNext) void drainOutboxMessage(sessionId, nodeId, queuedNext)
      }
    }
    unsubs.push(window.mcAgent.onEvent((packet, metadata) => {
      /* Every packet is evidence that session is still there, and this is the
         one place all of them pass through. Stamped before the buffering
         branches below, because a packet held for a reconnect is still proof
         the session spoke. Optional call because a fixture may hand in a
         plain Map rather than the class above. */
      publishProviderModeEvent(packet)
      sessionNodeIds.touch?.(packet?.sessionId)
      if (source === 'relay' && packet?.sessionId) requestAuthoritativeDesktopTree()
      const nativePending = nativePendingPackets.get(packet?.sessionId)
      if (nativePending) {
        const bytes = JSON.stringify(packet).length * 2
        if (nativePending.rows.length < 2048 && nativePending.bytes + bytes <= 8 * 1024 * 1024) {
          nativePending.rows.push(packet)
          nativePending.bytes += bytes
        } else nativePending.overflow = true
        return
      }
      const pending = remotePendingPackets.get(packet?.sessionId)
      if (pending) {
        if (Number.isSafeInteger(metadata?.sequence)) {
          const bytes = JSON.stringify(packet).length * 2
          if (pending.rows.length < 2048 && pending.bytes + bytes <= 8 * 1024 * 1024) {
            pending.rows.push({ seq: metadata.sequence, packet })
            pending.bytes += bytes
          } else pending.overflow = true
        }
        return
      }
      if (sessionNodeIds.has(packet?.sessionId)
          && !acceptRemoteSequence(remoteAppliedSequences, packet.sessionId, metadata?.sequence)) return
      return handleAgentEvent(packet)
    }))
  }

  /* THE BOOT. Deliberately NOT awaited: the view returns its root now and the
     mount lands when the source resolves. startableTiersNow (fired from the
     real arm) keeps its old property too — the tree draws whether or not the
     shell ever answers, and every late settle checks `destroyed` first. */
  unsubs.push(subscribeMachineTabSwitch(window, state => {
    if (destroyed) return
    machineSwitchBusy = state.busy
    setMachineNote(state.sentence)
    for (const tab of tabsElement.querySelectorAll('[data-machine-tab]')) tab.disabled = state.busy
  }))
  const bootPromise = bootFromSource()

  return {
    el: root,
    nativeStop: {
      ready: bootPromise.then(() => projectionReady).then(() => {
        return !destroyed && currentDataSource() === 'local' && treeStoreId === 'this-computer'
      }),
      async run(target, close) {
        const node = hostedStopNode(target)
        if (!node) return { outcome: 'not-sent', closed: false }
        return closePersonNode(node, () => {
          if (hostedStopNode(target) !== node) throw new Error('Native Stop target changed')
          return close()
        }, true)
      },
    },
    chatWorkspace: chatWorkspace ? {
      ready: bootPromise.then(() => projectionReady).then(() => { if (destroyed) throw new Error('This conversation workspace was closed.') }),
      mount: mountWorkspaceChat,
      newChat: mountWorkspaceNewChat,
    } : null,
    async runTreeNodeCommand(command) {
      await bootPromise
      /* BOUNDED, so a fleet read that never answers cannot hold this command
       * open for ever. `projectionReady`'s own contract is untouched -- only
       * the newest projection may release it, see finishProjectionLoad --
       * this only stops WAITING on it after 30s and lets the gates below
       * decide, exactly as they already do for a page that never had a
       * computer: `!treeStore || treeStoreId !== command.computerId` answers
       * MC_TREE_COMMAND_COMPUTER_NOT_FOUND either way, so a load that never
       * finishes gets the SAME code, from the SAME gate, as a computer that
       * was never there -- never a hang. MEASURED (Worker 14, 2026-09-07,
       * ported from app 4d3cfab9's own suite): unmodified, `await
       * projectionReady` alone left this exact scenario cancelled by the test
       * runner rather than answered at all --
       * tools/test/tree-node-command-projection-bound.test.mjs's first case.
       * Inlined rather than a named helper: tools/test/tree-command-
       * projection-ready.test.mjs extracts this method's source text into an
       * isolated sandbox that declares its own local `projectionReady` and
       * nothing else this file defines. */
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 30_000)
        projectionReady.then(() => { clearTimeout(timer); resolve() })
      })
      if (destroyed) return { ok: false, code: 'MC_TREE_COMMAND_VIEW_DESTROYED', retryable: true,
        retryAfterMs: 0, nodeId: command?.nodeId || null, sessionId: null, threadId: null }
      /* THE LIFECYCLE VERBS AN ASSISTANT MAY ASK FOR ON A CIRCLE UNDER IT.
         Owner, 2026-09-03: "THE AGENTS NEED TO BE ABLE TO DELETE AND START
         AND RESTART AGENTS UNDER THEM AND BE ABLE TO MESSAGE EACH". Start
         and message already had a route; stop, restart and remove did not,
         even though this view performs all three for the person's own press.
         Each maps onto the SAME function that press calls -- not a second
         implementation -- so an assistant and a person cannot drift apart
         about what stopping or removing a circle means. */
      if (!command || !['fresh-start-existing-node', 'send-to-bound-node', 'create-and-start-node',
        'stop-node', 'remove-node', 'resume-node', ...Object.keys(MANAGED_SLOT_ACTIONS)].includes(command.action)) {
        return { ok: false, code: 'MC_TREE_COMMAND_ACTION_REFUSED', nodeId: command?.nodeId || null, sessionId: null, threadId: null }
      }
      if (currentDataSource() === 'mock') {
        return { ok: false, code: 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED', nodeId: command.nodeId || null, sessionId: null, threadId: null }
      }
      if (!treeStore || treeStoreId !== command.computerId) {
        return { ok: false, code: 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND', nodeId: command.nodeId, sessionId: null, threadId: null }
      }
      /* RE-RESOLVED, NOT SNAPSHOTTED, AND NOT LEFT TO CRASH. SHARED by every
       * verb below whose own operation spans an await this view's destroy()
       * can land inside.
       *
       * destroy() (navigation, a route change, the page closing) can null the
       * closure's `treeStore` at any point during a slow bridge.start() await
       * without cancelling the operation already in flight (destroy()'s own
       * comment: "A start already sent is NOT cancelled by any of this...
       * What stops here is this view's interest in the answer."). Reading the
       * closure's `treeStore` fresh after such an await, unguarded, threw
       * "Cannot read properties of null (reading 'getNode')"
       * (MC_TREE_COMMAND_RENDERER_FAILED) for fresh-start-existing-node,
       * MEASURED by Controller 2026-09-06T19:46:40Z, and was verified to sit
       * identically, still unguarded, in resume-node -- MEASURED by Worker 35
       * and Controller 2026-09-06T22:45Z-23:xxZ, before either had been
       * observed to crash resume in practice.
       *
       * A SNAPSHOT TAKEN BEFORE THE AWAIT WAS CONSIDERED AND REJECTED. It
       * answers "is treeStore null" but not "is treeStore CURRENT" -- a store
       * captured before the await is exactly as stale as the live binding if
       * the page reopened onto a genuinely different store for this computer
       * while the operation was in flight; a write through a stale object is
       * a silent fork, quieter than a crash and worse. Re-running a read-only
       * lookup HERE, at call time, is what "current" means: the live closure
       * variable when it still matches this computer, or a retained copy of
       * the SAME object when it does not, and NEVER a value carried across
       * an await. This deliberately omits createTreeRuntimeView's
       * create-a-fresh-store fallback: a reconciliation callback finishing
       * someone else's operation must find the tree that was already there,
       * never mint an empty one as a side effect.
       *
       * recoveryCoordinator().activeStore IS DELIBERATELY NOT IN THIS CHAIN,
       * unlike openTreeStore's own resolution order. VERIFIED, Controller and
       * Worker 36, 2026-09-06T20:55Z, in account-recovery-coordinator.js:
       * `activeStore` reads an entry captured ONCE by the first overlapping
       * recover() for a computerId and never reassigned by a later one -- so
       * while any recovery for this computer is in flight, activeStore can
       * answer a store from BEFORE this view's own destroy()-and-reopen,
       * exactly the situation that sends this lookup looking for a fallback
       * in the first place.
       *
       * RUN_STARTING_TREE_STORES'S OWN GUARANTEE DIFFERS BY CALLER, and this
       * is why the same lookup is reused rather than special-cased per verb
       * rather than reasoned about once and assumed everywhere. For
       * fresh-start-existing-node, `retainStartingTreeStore`'s release() runs
       * only in freshStartExistingNode's own `finally`, which wraps
       * `afterBind` -- so restartAfterBind's own call to this lookup always
       * runs BEFORE that release, and the entry is guaranteed present. For
       * resume-node, resumeNodeSession's retain/release cycle is entirely
       * INTERNAL to resumeNodeSession itself (release() fires in the
       * `finally` inside nodeReplacementFlight's own callback, before
       * resumeNodeSession returns) -- so by the time the resume-node branch
       * below calls this lookup, ITS OWN retain has already been released,
       * and RUN_STARTING_TREE_STORES only still helps if some OTHER
       * overlapping start for the same computer happens to hold it. This
       * lookup is still correct and still never crashes either way: a miss
       * falls through to RUN_TREE_RUNTIME_STORES (reassigned on every
       * retain(), never captured once and left stale) and then a named
       * refusal -- resume-node's fallback chain is simply weaker in practice
       * than restart's, not incorrect.
       *
       * PRESENT IS NOT THE SAME AS RIGHT, AND ONLY PRESENCE IS GUARANTEED BY
       * CONSTRUCTION. An earlier revision of this block claimed the entry was
       * "guaranteed to be the store this specific restart began with". That was
       * false and the claim has been withdrawn: `retainStartingTreeStore` keys
       * on `store.snapshot().computerId` and does
       * `RUN_STARTING_TREE_STORES.get(computerId) || { store, count: 0 }`, so an
       * existing entry's `.store` is NEVER reassigned by a later overlapping
       * retain for the same computer. Two nodes on one computer retaining
       * different store objects leaves the FIRST object answering for both, and
       * this lookup would hand the second operation a store it never began with
       * -- the silent fork named above, not a crash.
       *
       * That is closed today by the retainers, not by this Map. All three
       * (startDraftNodeUnguarded, freshStartExistingNode, resumeNodeSession)
       * now pass the treeStore that is live at the moment they retain: the two
       * replacement verbs read it synchronously at press time, and
       * startDraftNodeUnguarded -- which alone captures across two awaits --
       * re-checks `treeStore !== store` before it retains (see its own note).
       * Since openTreeStore's chain consults this Map before minting anything,
       * a reopened page then adopts that same object and the values agree.
       *
       * SO THE INVARIANT A FOURTH CALLER MUST KEEP is: never hand
       * `retainStartingTreeStore` a store reference carried across an await
       * without re-checking it against the live `treeStore` first. Nothing in
       * the Map enforces that, and breaking it reintroduces the fork silently,
       * without touching this file's comment or any line that looks wrong. */
      const resolveLiveTreeStore = () => (treeStore && treeStoreId === command.computerId)
        ? treeStore
        : (RUN_STARTING_TREE_STORES.get(command.computerId)?.store
          || RUN_TREE_RUNTIME_STORES.get(command.computerId)
          || null)
      /* BEFORE THE LOOKUPS BELOW, because a create names no node: it is asking
         for one to be made. The two gates it does share with a send are the
         ones about this copy rather than about a node -- a demonstration tree
         must not start real sessions, and a build with starting switched off
         must not start them either. */
      if (command.action === 'create-and-start-node') {
        if (currentDataSource() === 'mock') {
          return { ok: false, code: 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED', nodeId: null, sessionId: null, threadId: null }
        }
        if (!isWriteEnabled(START_CONTROL_FLAG)) {
          return { ok: false, code: 'MC_TREE_COMMAND_START_DISABLED', nodeId: null, sessionId: null, threadId: null }
        }
        return createAndStartNode(command)
      }
      /* A circle is found by its id; the tree is checked only when the
         command named one. The lifecycle tools promise "the application
         resolves it when omitted", and a manager knows a circle by nodeId
         alone. Node ids are unique across every tree the store holds. */
      let node = treeStore.getNode(command.nodeId)
      if (!node || (command.treeId && node.treeId !== command.treeId)) {
        return { ok: false, code: 'MC_TREE_COMMAND_NODE_NOT_FOUND', nodeId: command.nodeId, sessionId: null, threadId: null }
      }
      if (command.expectedSessionId && node.sessionId !== command.expectedSessionId) {
        return { ok: false, code: 'MC_TREE_COMMAND_SESSION_CHANGED', nodeId: command.nodeId, sessionId: null, threadId: null,
          reason: 'This circle has a different session now. Read its current session before trying again.' }
      }
      /* WHERE THE ASKER STANDS, for a stop or a restart. The owner's sentence
         is "start and restart agents UNDER them", and the removal rule below
         already reads the asker's place from the session the application
         bound. Stop and restart read nothing of the kind when they shipped:
         an assistant could name any circle on the tree -- a sibling, its own
         manager, the person's root -- and the view closed or wiped it. A
         command that names no session is the person's own errand (the
         file-spool coordinator's restart) and is not gated. The rule and its
         refusals live in src/agent-removal-rule.js so a test can call them. */
      if (command.action === 'stop-node' || command.action === 'fresh-start-existing-node' || command.action === 'resume-node') {
        const stands = callerCircleRefusal({ command, node, treeStore, sessionNodeIds })
        if (stands) return stands
      }
      if (Object.hasOwn(MANAGED_SLOT_ACTIONS, command.action)) {
        const stands = callerCircleRefusal({ command, node, treeStore, sessionNodeIds })
        if (stands) return stands
        return configureManagedSlot(command, node)
      }
      /* A recovery moving this circle is waited out, not answered half-way: resume-node and
         send-to-bound-node act on the current session, which is in flux while the coordinator
         replaces it. The wait is bounded, follows every check above, and hands each of them the
         circle as it is afterwards. It never starts a session (src/tree-node-settle-wait.js). */
      if (command.action === 'resume-node' || command.action === 'send-to-bound-node') {
        const settled = await settleNodeForCommand({
          command,
          node,
          isSettling: nodeId => recoveryCoordinator()?.isRecovering(nodeId) === true,
          subscribe: listener => recoveryCoordinator()?.subscribeRecoverySettled?.(listener) ?? null,
          isDestroyed: () => destroyed,
          currentNode: () => resolveLiveTreeStore()?.getNode(node.id) || null,
          callerRefusal: fresh => command.action === 'resume-node'
            ? callerCircleRefusal({ command, node: fresh, treeStore: resolveLiveTreeStore(), sessionNodeIds }) : null,
          sessionNodeIds,
          sessionThreadIds,
          sessionAlive: sessionId => hostSessionAlive(typeof window === 'undefined' ? null : window.mcAgent, sessionId),
        })
        if (settled.answer) return settled.answer
        node = settled.node
      }
      if (command.action === 'resume-node') {
        if (nodeBusy(node) || nodeReplacementFlight.busy(node.id) || nodeCleanupPending(node)) {
          return { ok: false, code: 'MC_TREE_COMMAND_RESUME_REFUSED', nodeId: node.id, sessionId: node.sessionId || null, threadId: null }
        }
        if (!isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, code: 'MC_TREE_COMMAND_START_DISABLED', nodeId: node.id, sessionId: null, threadId: null }
        try { await transcriptStore?.ready } catch (error) { return { ok: false, code: 'MC_TREE_COMMAND_RESUME_REFUSED', nodeId: node.id, sessionId: null, threadId: null, reason: error.message } }
        const previousSessionId = node.sessionId
        let resumeRefusal = null
        const resumeOutcome = await resumeNodeSession(node, { machineInitiated: true,
          delegationToken: command.delegationToken || null, onRefused: value => { resumeRefusal = value } })
        if (resumeOutcome?.stale === true) return { ...resumeOutcome, nodeId: node.id }
        rebindRailToSession(node.id)
        /* resolveLiveTreeStore, not the bare closure `treeStore`: this line
           runs after resumeNodeSession's own await (bridge.start, exactly as
           slow as a restart's), and destroy() can have released `treeStore`
           in the meantime -- MEASURED, Worker 35 and Controller
           2026-09-06T22:45Z-23:xxZ, the same defect class as
           fresh-start-existing-node's, found here unguarded before it had
           been observed to crash resume in practice. Unlike that branch,
           resumeNodeSession's own retain of RUN_STARTING_TREE_STORES has
           already released by the time this line runs (see the hoisted
           comment), so a miss here falls through faster to RUN_TREE_RUNTIME_STORES
           or a named refusal -- still never a crash, just a weaker retained-
           store guarantee than restart's. */
        const liveTreeStore = resolveLiveTreeStore()
        if (!liveTreeStore) {
          return { ok: false, code: 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND', nodeId: node.id, sessionId: node.sessionId || null, threadId: null }
        }
        const resumed = liveTreeStore.getNode(node.id)
        const answer = resumeNodeCommandResult({ nodeId: node.id, previousSessionId, node: resumed, sessionNodeIds, sessionThreadIds })
        return !answer.ok && resumeRefusal
          ? { ...answer, code: resumeRefusal.code || answer.code, reason: resumeRefusal.message }
          : answer
      }
      /* RESTART. fresh-start-existing-node is the restart primitive and was
         already reachable by the broker; it simply had no tool.

         THE RAIL IS RECONCILED HERE FOR THE SAME REASON THE PALETTE'S OWN
         "Clear" ROW RECONCILES IT, and it was the half that had no caller.
         executeFreshStartExistingNode closes the old session, DETACHES the
         node and attaches the replacement -- inside another module, so the
         session lands where nothing in this file's attach sites can see it.
         The person's press remounts the rail afterwards; an assistant's
         restart returned the module's answer straight through, leaving a rail
         open on this circle with a composer aimed at a session that was closed
         a moment ago (or, when the replacement refused, at no session at all).
         The rule refuses the rebuild when the panel already agrees with the
         node, so a rail on another circle and a closed rail cost nothing. */
      /* An assistant-driven restart also keeps the node's saved brief. The
         person's Clear action above still calls freshStartExistingNode without
         this afterBind step, so it remains a genuinely empty new conversation.
         The callback runs inside the same single-flight as replacement: nobody
         can replace the newly bound session between binding it and sending its
         one source-derived boot turn. */
      if (command.action === 'fresh-start-existing-node') {
        /* resolveLiveTreeStore is hoisted above (shared with resume-node);
           for THIS caller its RUN_STARTING_TREE_STORES fallback is
           guaranteed non-empty for the whole call -- see the hoisted
           comment's own note on why that guarantee differs by caller. */
        /* Named before the call, not inlined into it: the rail invariant
           (tools/test/tree-rail-rebind.test.mjs) walks from the call to the
           first return and must find the reconciliation, and the callback's
           own early return is not this branch's exit. */
        const restartAfterBind = restarted => {
          const liveTreeStore = resolveLiveTreeStore()
          if (!liveTreeStore) {
            return { ok: false, code: 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND', nodeId: node.id, sessionId: restarted.sessionId, threadId: restarted.threadId }
          }
          const rebound = liveTreeStore.getNode(node.id)
          if (!rebound) {
            return { ok: false, code: 'MC_TREE_COMMAND_NODE_NOT_FOUND', nodeId: node.id, sessionId: restarted.sessionId, threadId: restarted.threadId }
          }
          const parentNode = rebound?.parentId ? liveTreeStore.getNode(rebound.parentId) : null
          const parent = parentNode ? { id: parentNode.id, name: treeNodeName(parentNode) } : null
          return executeRestartExistingNodeCommand({
            node: rebound,
            restarted,
            bridge: typeof window === 'undefined' ? null : window.mcAgent,
            sessionNodeIds,
            briefContext: briefContextFor(rebound, parent),
            appendTranscript: transcriptAppend,
            treeStore: liveTreeStore,
            refreshTree,
            failedNote: statusNote(PALETTE_PANEL.restartBriefFailed),
            refusalCodeFromError: refusalCode,
            refusalCodeFromResult: refusalCodeOf,
            acknowledgeRoot: Boolean(command.delegationToken),
          })
        }
        const replaced = await freshStartExistingNode(node, { afterBind: restartAfterBind, delegationToken: command.delegationToken || null })
        rebindRailToSession(node.id)
        return replaced
      }

      /* STOP. The same close the person's own Stop row performs, including
         the queued-message drop and the status note, so a circle stopped by
         its manager and one stopped by hand end in the same state. */
      if (command.action === 'stop-node') {
        if (currentDataSource() === 'mock') {
          return { ok: false, code: 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED', nodeId: node.id, sessionId: null, threadId: null }
        }
        const bridge = typeof window === 'undefined' ? null : window.mcAgent
        if (!bridge || typeof bridge.close !== 'function' || !node.sessionId) {
          return { ok: false, code: 'MC_TREE_COMMAND_STOP_UNAVAILABLE', nodeId: node.id, sessionId: node.sessionId || null, threadId: null }
        }
        try {
          const closed = await bridge.close({ sessionId: node.sessionId })
          if (closed?.ok === false || closed?.closed === false) throw new Error('AGENT_SESSION_CLEANUP_FAILED')
        }
        catch (error) {
          /* The engine's own sentence rides beside the code -- see
             src/main.js treeNodeCommandReason. A close refused for a dead
             session and one refused by a broken engine read the same code
             and are not the same thing. */
          if (TERMINAL_AGENT_SESSION_CODES.has(refusalCode(error))) {
            return { ok: false, code: 'MC_TREE_COMMAND_SESSION_ENDED', nodeId: node.id, sessionId: node.sessionId, threadId: null,
              reason: 'This circle\'s session has already ended. Resume or restart the circle to open a new session.' }
          }
          return { ok: false, code: 'MC_TREE_COMMAND_STOP_FAILED', nodeId: node.id, sessionId: node.sessionId, threadId: null, reason: error?.message || String(error) }
        }
        RUN_SESSION_CLEANUPS.delete(node.sessionId)
        outboxClearSession(node.sessionId)
        settleStoppedSession(node.sessionId)
        resetSessionMetrics(node.sessionId)
        /* See src/stop-node-session.js: a fresh-start or resume that replaced
           this node's session while the close above was in flight already
           moved node.sessionId on. Re-read fresh, right before the write the
           race actually lands on -- node.sessionId itself is the parameter's
           own frozen field and is safe to read again here; it is treeStore's
           own live copy, read fresh through getNode, that may no longer
           agree with it. */
        const liveTreeStore = resolveLiveTreeStore()
        if (!liveTreeStore) {
          /* The close receipt is authoritative even when this view disappeared
             while it was in flight. Do not turn a completed Stop into a
             retryable "nothing was done" answer: a second Stop would be a
             duplicate operation against an already-closed session. */
          return { ok: true, code: null, closed: true, projectionUnavailable: true,
            nodeId: node.id, sessionId: node.sessionId, threadId: null }
        }
        if (stopStillOwnsNode(node.sessionId, liveTreeStore.getNode(node.id))) {
          liveTreeStore.setNodeStatus(node.id, 'finished', { note: 'Stopped by the assistant above it.' })
          refreshTree()
        }
        return { ok: true, code: null, nodeId: node.id, sessionId: node.sessionId, threadId: null }
      }

      /* REMOVE, and the owner's own rule about who may be removed.

         Verbatim, 2026-09-03: "agents that were spawned by agents AND who the
         user hasnt prompted - THEY can be removed by parent agents. AGENTS
         that a user prompts even if created by another agent can remain".

         So two facts decide it, and neither is the caller's to claim: whether
         a person ever sent this circle a turn, and whether it was made by an
         assistant. Both are read from the node the store holds. A circle the
         person has spoken to is refused in a sentence naming that reason --
         it is not a failure, it is the rule working.

         performNodeRemoval() is the person's own removal, so the store stays
         the gate for everything else: a live agent, or a parent with agents
         under it, is refused in the store's own words. */
      if (command.action === 'remove-node') {
        if (currentDataSource() === 'mock') {
          return { ok: false, code: 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED', nodeId: node.id, sessionId: null, threadId: null }
        }
        /* The rule itself is in src/agent-removal-rule.js, not here, so it can
           be called with values from a test. The inline version this replaces
           had no reachable caller outside a mounted view, and its suite ended
           up asserting a truth table rewritten in the test file -- an
           assertion that cannot go red when the rule breaks. */
        return executeRemoveNode({
          command,
          node,
          treeStore,
          sessionNodeIds,
          removeCircle: performNodeRemoval,
        })
      }
      if (currentDataSource() === 'mock') {
        return { ok: false, code: 'MC_TREE_COMMAND_REAL_SOURCE_REQUIRED', nodeId: node.id, sessionId: null, threadId: null }
      }
      if (!isWriteEnabled(START_CONTROL_FLAG)) {
        return { ok: false, code: 'MC_TREE_COMMAND_SEND_DISABLED', nodeId: node.id, sessionId: null, threadId: null }
      }
      return executeSendToBoundNode({
        command,
        node,
        bridge: typeof window === 'undefined' ? null : window.mcAgent,
        sessionNodeIds,
        sessionThreadIds,
        appendTranscript: transcriptAppend,
        appendTurnLog: turnLogAppend,
        treeStore,
        refreshTree,
        refusalCodeFromError: refusalCode,
        refusalCodeFromResult: refusalCodeOf,
      })
    },
    destroy() {
      captureRoleLibrary()
      closeWorkspaceControls()
      for (const surface of [...workspaceChats]) surface.dispose()
      for (const panel of [...workspaceComposePanels]) panel.destroy()
      transcriptStore?.dispose?.()
      destroyed = true
      finishProjectionLoad()
      for (const queue of treeLaunchQueues.values()) queue.cancel()
      treeLaunchQueues.clear()
      for (const { queue } of nodeLaunchQueues.values()) queue.cancel()
      nodeLaunchQueues.clear()
      for (const buffer of sessionActions.values()) buffer.resetMetrics()
      sessionOpenTurns.clear()
      sessionCompletedTurnIds.clear()
      notifyNodeStatusListeners()
      compareFiles.close()
      fetchVersion += 1
      clearTimeout(railDisposeTimer)
      clearTimeout(orgStatusTimer)
      if (chipRefreshFrame) cancelAnimationFrame(chipRefreshFrame)
      disposeRailSaid()
      disposeRailChat()
      clearBoard()
      clearMountedGraph()
      /* The action buffers and the chats they were broadcast to. Holding a
         detached chat root holds its whole log, and this view with it. */
      sessionActions.clear()
      chatSurfaces.clear()
      if (chatSpeechFrame) cancelAnimationFrame(chatSpeechFrame)
      chatSpeechPending.clear()
      turnInterrupts.clear()
      /* The panel holds a submit that can still be in flight, and the store
         holds a listener that would paint into a rail this view no longer owns.
         A start already sent is NOT cancelled by any of this — it is a real
         session on this computer, and closing a page is not a reason to stop it.
         What stops here is this view's interest in the answer. */
      closeComposePanel()
      releaseTreeStore()
      /* The sheet's Escape key listener is on the document, so it outlives this
         element unless it is taken off by hand. Null on a desktop. */
      phoneCanvas?.destroy()
      /* The ledger's runtime bindings are in the shared clock registry; its
         destroy releases them. Null everywhere the mode is off. */
      phoneLedger?.destroy()
      unsubs.forEach(unsubscribe => unsubscribe())
    },
  }
}

export function rangeFill(input) {
  const set = () => {
    const percent = ((input.value - input.min) / (input.max - input.min)) * 100
    input.style.setProperty('--fill', `${percent}%`)
  }
  input.addEventListener('input', set)
  set()
}
