import { createNativeStopSurface } from './native-stop-surface.js'
// Shell: hash router with smooth view morphs (native View Transitions where
// the browser has them), settings drawer, central clock.

/* Bundled fonts — every face the font setting can apply ships in the build
   (no network font loading; the app works offline). Inter left with R1523:
   the owner declined it as the default, no remaining choice uses it, and an
   unimported font is dead bytes in the payload. JetBrains Mono serves both
   the data accents (--font-mono) and the all-mono interface choice. */
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/source-sans-3'
import { pageCanDraw } from './page-frames.js'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import './glow.css'
import './styles.css'
import './theme-refinements.css'
/* The shared visual foundation: the layer, edge, depth, radius, type, focus and
   motion tokens every page spends, and the primitives built on them. After the
   two theme sheets (it is the last writer of their tokens), before every view. */
import './foundation.css'
import './common-commands.css'
import { initializeRoleColors } from './role-colors.js'
import { startHandControls } from './hand-controls.js'
import './hand-controls.css'
/* The capabilities-and-risks disclosure (owner, R1529). Global rather than
   view-scoped because the quick-settings drawer draws it on every page, so the
   rules must exist before any view has been visited; and because the module
   that emits the markup is reached from a module `node --test` imports, which a
   stylesheet import inside it would break. */
import './guided-step.css'
/* THE PHONE CANVAS (owner, 2026-08-23). Loaded here with the rest of the app's
   sheets, and inert everywhere except a phone: every rule in it begins with the
   `[data-phone-canvas="on"]` attribute, which only src/phone-canvas.js writes
   and only on a device whose primary pointer is a finger. A desktop window at
   any width cannot reach one declaration in it. */
import './phone-canvas.css'
/* THE PHONE LEDGER'S AT-RULES (owner, 2026-08-27). phone-canvas.css admits no
   at-rule by its own test, so the sheet-rise keyframes and the reduced-motion
   guard ride here. Selector-inert everywhere the ledger's elements were never
   built — which is every desktop and the canonical phone surface alike. */
import './phone-ledger.css'

import { startRuntimeClock } from './runtime-clock.js'
import { takeViewMorph } from './components.js'
import { homeView } from './views/home.js'
import { computersView, initializeAutonomousContinuations } from './views/computers.js'
import { agentView } from './views/agent.js'
import { metricsView } from './views/metrics.js'
import { researchView } from './views/research.js'
import { commsView } from './views/comms.js'
import { COMMS_NAME } from './comms-copy.js'
import { ledgerView, MODE_KEY as LEDGER_MODE_KEY } from './views/ledger.js'
import { vaultView } from './views/vault.js'
import { checkoutView } from './views/checkout.js'
import { settingsView, applyStoredAppearance } from './views/settings.js'
/* The tools page is its own stop rather than a section of Settings, because the
   owner asked for it that way and because it is the only settings surface whose
   rows come from the machine rather than from a written catalogue: three
   hundred of them, arriving over a read that can fail. */
import { toolsView } from './views/tools.js'
import { renderQuickSettings } from './quick-settings.js'
import { TEXT_SIZE_KEY, applyTextSize } from './text-size.js'
import { bindAppearanceAccountChanges } from './appearance-persistence.js'
import { setupView } from './views/setup.js'
import { accountView } from './views/account.js'
import { subscribeView } from './views/subscribe.js'
import { parseRoute } from './route-parse.js'
import { DATA_SOURCE_EVENT, isExampleMode, currentDataSource } from './data-source.js'
import { FLEET, syncPhoneExampleNotice } from './fleet-profile.js'
import { mountAccessibilityControls } from './accessibility-controls.js'
import { resetPersistentVoice } from './voice-coordinator.js'
import './accessibility-controls.css'
import { WRITE_FLAGS_EVENT } from './write-flags.js'
import { resetCartChanges } from './purchase-cart-changes.js'
import { SETUP_RESOLUTION, firstRunPending, shouldOpenSetup } from './setup-state.js'
import { startPhoneCanvas, PHONE_CANVAS_COULD_NOT_TELL } from './phone-canvas.js'
/* The one place the create-and-start-node brief ceiling is a NUMBER; every
   other reader of it, including the check below, reads this constant instead
   of restating 12000 a second time. See FLEET_TREE_LIMITS in fleet-trees.js
   for why it moved from 4,000, and read that comment before ever changing
   this import to a literal again. */
import { FLEET_TREE_LIMITS } from './fleet-trees.js'
/* The ledger's stored choice is read ONCE, when the fleet view is built, so a
   choice made from the drawer changes nothing a person can see until something
   re-renders. That is this file's job — see the listener beside the checkout
   probe's, which exists for the same reason. */
import { PHONE_LEDGER_EVENT } from './phone-ledger.js'
import { mountSettingsRecoveryNotice } from './settings-recovery-notice.js'
import { lastExitNoticeSource } from './last-exit-notice.js'
import { startAttentionReports } from './notification-attention.js'
import {
  CHECKOUT_SURFACE_EVENT,
  checkoutSurfaceAvailable,
  checkoutSurfaceSettled,
  probeCheckoutSurface,
} from './checkout-visibility.js'

// loaded last so the shared-element morph rules win over the base sheets
import './morphs.css'
import './chat-content.css'
import './chat-session-changes.css'
import './chat-presentation.css'
import './chat-response.css'
import './chat-activity.css'
import './diff-editor.css'

import './app-navigation.css'
import './sidebar-pages.css'
import './first-use-guidance.css'
import './readability.css'
import { mountAppNavigation } from './app-navigation.js'
import { mountFirstUseGuidance } from './first-use-guidance.js'
import { keepSkipLinkOnPage } from './skip-link.js'
import { createHistoryEntries } from './history-entries.js'
const firstUseGuidance = mountFirstUseGuidance()
const appNavigation = mountAppNavigation()
window.addEventListener('beforeunload', () => appNavigation.destroy(), { once: true })

const stage = document.getElementById('stage')
const crumb = document.getElementById('crumb')   // removed from the markup; kept null-safe
const navEl = document.getElementById('tb-nav')
const accessibilityControls = mountAccessibilityControls({ available: () => !isExampleMode() && currentDataSource() !== 'mock' })
window.addEventListener('beforeunload', () => { resetPersistentVoice(); accessibilityControls.destroy(); firstUseGuidance.destroy() })

let current = null           // { el(wrapper), view, route }
const nativeStopSurface = createNativeStopSurface(typeof window === 'undefined' ? null : window.mcNativeStop)

/* ONE COORDINATOR COMMAND, DELIVERED TO THE VIEW THAT OWNS THE MAPS.
 *
 * Main has already resolved, ACL-checked, schema-checked and atomically claimed
 * the request file. This second validation keeps a compromised preload event
 * from smuggling paths or provider threads into the page. A clean start cannot
 * carry text; the separate send action may carry one bounded message. Commands
 * wait here while the Computers view mounts because only that view owns
 * RUN_SESSION_NODES and the saved tree attachment.
 *
 * WHAT THE CREATE ACTION WIDENED, SAID PLAINLY. This gate used to promise that
 * no "model choice" crossed it either, and create-and-start-node broke that
 * sentence rather than the rule behind it: it carries a `tier`, which IS a model
 * choice, and a `role`. Still true, and the reason the promise is worth keeping
 * in its narrowed form: no path and no provider thread id crosses, the brief is
 * bounded exactly like the send action's message, and neither new field is
 * trusted here -- the view re-checks `tier` against its own launch tiers and
 * `role` against the authoritative organisation snapshot before either reaches
 * the store. A stale comment in this file would be worse than none, because the
 * only thing it is for is telling a later reader what this gate really does.
 */
const pendingTreeNodeCommands = new Map()
/* THE COMMAND THIS RENDERER IS CARRYING OUT, BY NAME -- NOT A BOOLEAN.
 *
 * This was `false`/`true`, cleared only when the in-flight command's own
 * runTreeNodeCommand settled. A command that never settled in the view -- a
 * boot that stalls, a start whose transport never answers -- held it for the
 * life of the window. The broker (shell/tree-node-command-broker.cjs) gave up
 * on that command at its own deadline and sent the NEXT one; this queue put
 * it in pendingTreeNodeCommands and drainTreeNodeCommands returned at its
 * first line, so the next one expired at the deadline too, and so did every
 * command after it, five minutes each, until the window reloaded. One hung
 * start turned into an unbounded run of MC_TREE_COMMAND_COMPLETION_TIMEOUT.
 *
 * The broker holds one active slot and sends a new request only after it has
 * settled the previous one, so a NEW request arriving while this names a
 * command still in flight is proof the broker has already answered that
 * command. The listener at the foot of this block yields the latch to the
 * new request; the in-flight command's late result, if it ever comes, is
 * addressed to a slot the broker no longer holds and is not sent. Holding
 * the request id rather than a flag is what makes "still the same command"
 * a question this code can ask. */
let drainingTreeNodeCommand = null

/* A COMMAND CAN ARRIVE WHILE THE ROUTER IS STILL MOUNTING COMPUTERS.
 *
 * `drainTreeNodeCommands` correctly keeps the request in its map until this
 * view owns it, but used to return immediately after pointing the hash at that
 * view. Nothing called drain again after the route finished mounting, so the
 * request stayed retained and unanswered until the broker's much longer
 * deadline. That made a real request look intermittently unavailable: it
 * worked only when Computers happened to be mounted already.
 *
 * The wait is short, bounded, and tied to this exact request. We never replay
 * a start after the renderer has received it; this only re-drains a request
 * which has not reached the view at all. If the surface never becomes ready,
 * it gets a determinate refusal before the broker's ambiguous completion
 * timeout. */
const TREE_NODE_COMMAND_SURFACE_WAIT_MS = 30_000
const TREE_NODE_COMMAND_SURFACE_POLL_MS = 120
let treeNodeCommandSurfaceWait = null
let treeNodeCommandSurfaceReacquiring = false
let treeNodeCommandSurfaceReacquireTimer = null
let treeNodeCommandSurfaceReacquireRequest = null
let treeNodeCommandSurfaceReacquireDeadline = 0

function markTreeNodeCommandSurfaceMounted() {
  treeNodeCommandSurfaceReacquiring = false
  if (treeNodeCommandSurfaceReacquireTimer !== null) clearTimeout(treeNodeCommandSurfaceReacquireTimer)
  treeNodeCommandSurfaceReacquireTimer = null
  treeNodeCommandSurfaceReacquireRequest = null
  treeNodeCommandSurfaceReacquireDeadline = 0
}

function boundTreeNodeCommandSurfaceReacquire(command, { preserveDeadline = false } = {}) {
  if (treeNodeCommandSurfaceReacquireTimer !== null) clearTimeout(treeNodeCommandSurfaceReacquireTimer)
  if (!preserveDeadline || treeNodeCommandSurfaceReacquireDeadline <= 0) {
    treeNodeCommandSurfaceReacquireDeadline = Date.now() + TREE_NODE_COMMAND_SURFACE_WAIT_MS
  }
  treeNodeCommandSurfaceReacquireRequest = command
  treeNodeCommandSurfaceReacquireTimer = setTimeout(() => {
    treeNodeCommandSurfaceReacquireTimer = null
    const active = treeNodeCommandSurfaceReacquireRequest
    if (!treeNodeCommandSurfaceReacquiring || !active || pendingTreeNodeCommands.get(active.requestId) !== active) return
    treeNodeCommandSurfaceReacquiring = false
    treeNodeCommandSurfaceReacquireRequest = null
    treeNodeCommandSurfaceReacquireDeadline = 0
    pendingTreeNodeCommands.delete(active.requestId)
    void (async () => {
      await completeTreeNodeCommand(active, {
        ok: false,
        code: 'MC_TREE_COMMAND_SURFACE_UNAVAILABLE',
        nodeId: active.nodeId,
        sessionId: null,
        threadId: null,
        reason: 'The Computers page did not remount in time, so this request was not started.',
      })
      void drainTreeNodeCommands()
    })()
  }, Math.max(0, treeNodeCommandSurfaceReacquireDeadline - Date.now()))
}

function clearTreeNodeCommandSurfaceWait(requestId = null) {
  const wait = treeNodeCommandSurfaceWait
  if (!wait || (requestId !== null && wait.requestId !== requestId)) return
  if (wait.handle !== undefined) clearTimeout(wait.handle)
  treeNodeCommandSurfaceWait = null
}

function waitForTreeNodeCommandSurface(command) {
  if (!command || pendingTreeNodeCommands.get(command.requestId) !== command) return
  let wait = treeNodeCommandSurfaceWait
  if (!wait || wait.requestId !== command.requestId) {
    clearTreeNodeCommandSurfaceWait()
    wait = { requestId: command.requestId, startedAt: Date.now(), handle: undefined }
    treeNodeCommandSurfaceWait = wait
  }
  if (wait.handle !== undefined) return

  const elapsed = Math.max(0, Date.now() - wait.startedAt)
  if (elapsed >= TREE_NODE_COMMAND_SURFACE_WAIT_MS) {
    treeNodeCommandSurfaceWait = null
    if (pendingTreeNodeCommands.get(command.requestId) !== command) return
    pendingTreeNodeCommands.delete(command.requestId)
    void (async () => {
      await completeTreeNodeCommand(command, {
        ok: false,
        code: 'MC_TREE_COMMAND_SURFACE_UNAVAILABLE',
        nodeId: command.nodeId,
        sessionId: null,
        threadId: null,
        reason: 'The Computers page did not become ready in time, so this request was not started.',
      })
      void drainTreeNodeCommands()
    })()
    return
  }

  wait.handle = setTimeout(() => {
    if (treeNodeCommandSurfaceWait !== wait) return
    wait.handle = undefined
    void drainTreeNodeCommands()
  }, Math.min(TREE_NODE_COMMAND_SURFACE_POLL_MS, TREE_NODE_COMMAND_SURFACE_WAIT_MS - elapsed))
}

/* A REFUSAL'S OWN WORDS, BOUNDED. A code is the wire fact and never changes;
   the reason is the sentence the view or a thrown error had at hand, carried
   only on a refusal, only as a string, and only up to a length no sentence
   needs. shell/main.cjs puts it in the answer an assistant reads; the file
   spool never stores it (shell/tree-node-command.cjs normalizeRendererResult
   admits and drops it). */
const MAX_TREE_NODE_COMMAND_REASON_CHARS = 600
function treeNodeCommandReason(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\0/g, '').trim()
  if (!text) return null
  return text.length > MAX_TREE_NODE_COMMAND_REASON_CHARS ? text.slice(0, MAX_TREE_NODE_COMMAND_REASON_CHARS) : text
}

function cleanTreeNodeCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowed = new Set([
    'protocol', 'schemaVersion', 'requestId', 'action', 'computerId', 'treeId',
    'nodeId', 'expectedSessionId', 'parentSessionId', 'message', 'createdAt', 'expiresAt', 'containsSecretMaterial',
    /* create-and-start-node only. */
    'role', 'tier', 'brief', 'effort', 'provider', 'model', 'delegationToken', 'reservedNodeId', 'choice',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) return null
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
  const fresh = value.action === 'fresh-start-existing-node'
  const send = value.action === 'send-to-bound-node'
  const create = value.action === 'create-and-start-node'
  /* THE TWO VERBS THIS GATE MISSED WHEN EVERY OTHER FILE LEARNED THEM.
     Commit "Agents can stop, restart and remove the circles below them"
     (2026-09-03) stopped hard-coding shell/main.cjs's dispatcher to one verb,
     taught src/views/computers.js both actions below, and gave both words in
     shell/tree-command-refusal-sentences.cjs -- but left this gate's action
     list at three. An assistant's stop or remove fell through every branch
     below to `return null`, so the onRequest listener further down never
     queued it and completeTreeNodeCommand was never called: the tool call sat
     for the broker's own five-minute completion timeout and came back reading
     "could not add that assistant to the tree" for a request that was never
     an add. */
  const stop = value.action === 'stop-node'
  const remove = value.action === 'remove-node'
  /* THE THIRD VERB THIS GATE MISSED, SAME CLASS AS THE TWO ABOVE.
     agent.resume dispatches 'resume-node' (app/capability/src/lib/agent-tree-spawn.js,
     TREE_ACTIONS.resume) and src/views/computers.js's runTreeNodeCommand has always
     fully implemented it (MC_TREE_COMMAND_RESUME_REFUSED, the START_CONTROL_FLAG
     check, transcriptStore.ready) -- but nobody added the verb to this gate's
     allow-list when it was wired up, so it fell through to `return null` exactly
     like stop-node and remove-node once did, and came back as
     MC_TREE_COMMAND_REQUEST_INVALID ("its action or one of its fields is not one
     this version accepts") for a request this version's OWN view already accepts.
     A resume carries the identical shape to stop/remove -- nodeId required, treeId
     and expectedSessionId optional, no message/role/tier/brief -- so it takes the
     same two carve-outs below (the non-create treeId branch, and the no-message
     check) rather than a shape of its own. */
  const resume = value.action === 'resume-node'
  const configure = ['set-node-model', 'set-node-effort', 'set-node-account', 'set-node-provider', 'set-node-role'].includes(value.action)
  if (configure && (typeof value.choice !== 'string' || !value.choice.trim() || value.choice.length > 200 || /[\u0000-\u001f\u007f]/.test(value.choice)
      || typeof value.parentSessionId !== 'string' || !id.test(value.parentSessionId))) return null
  if (!configure && value.choice !== undefined) return null
  const name = /^[a-z0-9][a-z0-9_-]{0,63}$/
  if (value.protocol !== 'toolsenabled.tree-node-command'
      || value.schemaVersion !== 1
      || (!fresh && !send && !create && !stop && !remove && !resume && !configure)
      || value.containsSecretMaterial !== false
      || typeof value.requestId !== 'string' || !/^tnc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
      || typeof value.computerId !== 'string' || !id.test(value.computerId)
      || (create
        ? (value.treeId !== null || value.nodeId !== null || value.expectedSessionId != null
          || typeof value.parentSessionId !== 'string' || !id.test(value.parentSessionId)
          /* A role is optional. An empty role is the explicit roleless choice
             from the Page 2 composer, and the downstream start path assigns
             only its bounded Worker identity for transport. Reject malformed
             non-empty names, but never turn an empty choice into a silent
             timeout. */
          || typeof value.role !== 'string' || (value.role !== '' && !name.test(value.role))
          || typeof value.tier !== 'string' || !name.test(value.tier)
          /* EFFORT, PROVIDER AND MODEL ARE OPTIONAL AND CHECKED FOR SHAPE ONLY
             (owner, 2026-09-19: "you NEED to be able to select effort level
             when you spawn agents"). Null is the ordinary case -- the asking
             assistant named none of them and the tier's own default decides.

             THE CLOSED VOCABULARIES ARE DELIBERATELY NOT REPEATED HERE. Which
             efforts exist belongs to shell/main.cjs AGENT_EFFORT_VALUES and to
             the engine's agent.spawn, which refuses an unknown one by name
             before a circle is ever drawn; which provider and model a tier
             runs belongs to src/orchestration-controls.js LAUNCH_TIERS, which
             executeCreateAndStartNode checks these against with the tier in
             hand. A fourth copy of either list in this gate could only drift
             out of agreement with the three that decide -- and a value refused
             HERE is refused by returning null, which is the silent five-minute
             timeout this function's own history records twice. Shape, not
             vocabulary, is what a transport gate can honestly own. */
          || !treeNodeCommandChoice(value.effort, 8)
          || !treeNodeCommandChoice(value.provider, 32)
          || !treeNodeCommandChoice(value.model, 128)
          || typeof value.brief !== 'string' || !value.brief.trim() || value.brief.includes('\0')
          || value.brief.length > FLEET_TREE_LIMITS.maxMessageChars)
        : (
          /* THE TREE IS OPTIONAL FOR A LIFECYCLE VERB, AS THE TOOL PROMISES.
             agent.stop / agent.restart / agent.remove require only nodeId;
             their treeId is "Optional tree the circle belongs to; the
             application resolves it when omitted" (engine tool-registry), and
             shell/main.cjs's dispatcher writes `treeId: request.treeId ||
             null`. This gate demanded a string for every non-create command,
             so a stop, restart or remove that named only the circle -- which
             is all a manager knows a circle by -- was dropped here without a
             word and the call sat for the broker's five-minute timeout. A
             send still binds to a tree, exactly as before.

             LOOSE, LIKE THE OTHER TWO OPTIONAL FIELDS ON THIS SAME COMMAND.
             expectedSessionId and parentSessionId, both checked a few lines
             below this one, read `!= null` -- a key that is missing entirely
             and one explicitly written as `null` are the same "not supplied"
             to either of them. This carve-out first read `=== null`, strict,
             so of the three optional identifiers on this command shape only
             treeId singled out one JavaScript spelling of "there is no tree"
             and refused the other. Every producer today happens to write an
             explicit `null` (dispatchTreeSpawn's `|| null`; the file-spool
             coordinator lists treeId as required and fails before this gate
             ever sees it), so the gap was invisible on any call this build
             makes -- until a caller builds the object with a spread or plain
             destructuring instead, which is how `undefined` reaches a plain
             object everywhere else in this codebase.

             A manager knows circles by nodeId (agent.spawn's answer,
             agent_comms.local_roster) and has no treeId to give, so this
             dropped every stop, restart and remove without one -- the command
             never reached pendingTreeNodeCommands, and the caller sat for the
             broker's five-minute completion timeout. It is the same silent
             `return null` the sibling notes on parentSessionId and message
             already describe for the other two defects this gate shipped
             with. */
          (value.treeId == null
            ? send
            : (typeof value.treeId !== 'string' || !id.test(value.treeId)))
          || typeof value.nodeId !== 'string' || !id.test(value.nodeId)
          || (value.expectedSessionId != null && (typeof value.expectedSessionId !== 'string' || !id.test(value.expectedSessionId)))
          /* Optional here exactly like expectedSessionId just above: the
             file-spool coordinator's fresh-start-existing-node never sets
             this, while stop and remove -- reachable only from the assistant
             dispatcher, which always does -- need the same shape fresh has or
             one call site would need to special-case the other two.
             executeRemoveNode reads it to find where the asking circle
             stands; a malformed value fails that lookup downstream rather
             than anything here. */
          || (value.parentSessionId != null && (typeof value.parentSessionId !== 'string' || !id.test(value.parentSessionId)))))) return null
  if ((fresh || stop || remove || resume || configure) && Object.prototype.hasOwnProperty.call(value, 'message')) return null
  /* A VALUE, NOT A KEY. shell/main.cjs's dispatchTreeSpawn builds one object
     literal for every action a session dispatches locally -- fresh, stop and
     remove included -- and it always writes role, tier and brief on that
     object, null when the verb has no use for them. hasOwnProperty said a key
     merely being THERE disqualified a non-create command, which is the same
     silent `return null` as the missing actions above for every lifecycle
     command that dispatcher builds this way, not only the two new ones. The
     create-only branch of the return statement below never reads these three
     fields back out for a non-create command, so a present-but-null one was
     always inert; only a REAL value is what this check exists to refuse. */
  if (!create && ['role', 'tier', 'brief', 'effort', 'provider', 'model'].some(key => value[key] != null)) return null
  const delegated = value.delegationToken !== undefined
  if (!delegated && value.reservedNodeId !== undefined && (!create || typeof value.reservedNodeId !== 'string' || !id.test(value.reservedNodeId))) return null
  if (delegated && (!(create || fresh || resume) || typeof value.delegationToken !== 'string'
      || !(create ? /^[a-f0-9-]{36}$/ : /^[a-f0-9-]{36}\.[1-9][0-9]{0,39}$/).test(value.delegationToken)
      || typeof value.reservedNodeId !== 'string' || !id.test(value.reservedNodeId)
      || (!create && (value.reservedNodeId !== value.nodeId || !value.expectedSessionId || !value.parentSessionId)))) return null
  if (create && Object.prototype.hasOwnProperty.call(value, 'message')) return null
  if (create && value.research !== undefined && (!value.research || typeof value.research !== 'object'
      || !['folder', 'clean-room'].includes(value.research.mode)
      || !['read-only', 'read-write'].includes(value.research.access)
      || typeof value.research.prompt !== 'string' || !value.research.prompt.trim()
      || (value.research.mode === 'folder' && typeof value.research.folder !== 'string')
      || (value.research.mode === 'clean-room' && value.research.folder !== undefined)
      || (value.research.files !== undefined && (!Array.isArray(value.research.files)
        || value.research.files.some(file => !file || typeof file.path !== 'string' || !file.path
          || typeof file.content !== 'string' || file.path.includes('\\0') || file.content.includes('\\0')))))) return null
  if (!create && value.research !== undefined) return null
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return null
  if (send && (!value.expectedSessionId || typeof value.message !== 'string'
      || !value.message.trim() || value.message.includes('\0')
      || new TextEncoder().encode(value.message).byteLength > 32 * 1024)) return null
  return Object.freeze({
    protocol: value.protocol,
    schemaVersion: value.schemaVersion,
    requestId: value.requestId,
    action: value.action,
    computerId: value.computerId,
    /* `|| null`, matching expectedSessionId and parentSessionId just below:
       an omitted treeId is now admitted above as `== null`, and an admitted
       `undefined` must not ride out to a caller that reads this frozen
       object's own field rather than re-deriving "was it supplied" itself
       (drainTreeNodeCommands stores this object verbatim in
       pendingTreeNodeCommands and hands it to runTreeNodeCommand unchanged). */
    treeId: value.treeId || null,
    nodeId: value.nodeId,
    expectedSessionId: value.expectedSessionId || null,
    /* Carried for every action, not only create: remove-node's own
       authorization (src/agent-removal-rule.js, "WHERE THE ASKER STANDS")
       resolves the asking circle from exactly this field, read off the
       session the application itself bound rather than anything else the
       request claims. */
    parentSessionId: value.parentSessionId || null,
    ...(send ? { message: value.message } : {}),
    ...(configure ? { choice: value.choice } : {}),
    /* `|| null` for the three optional choices, matching treeId and
       expectedSessionId above: an omitted key and an explicit null are the
       same "not chosen" to executeCreateAndStartNode, which reads this frozen
       object's own fields rather than re-deriving whether one was supplied.
       `research` rides along only when it was given (research delegation). */
    ...(create
      ? {
        role: value.role,
        tier: value.tier,
        brief: value.brief,
        effort: value.effort || null,
        provider: value.provider || null,
        model: value.model || null,
        ...(value.research !== undefined ? { research: value.research } : {}),
      }
      : {}),
    ...(create && value.reservedNodeId !== undefined ? { reservedNodeId: value.reservedNodeId } : {}),
    ...(delegated ? { delegationToken: value.delegationToken, reservedNodeId: value.reservedNodeId } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
    containsSecretMaterial: false,
  })
}

/* One of the asking assistant's three optional model choices, as a transport
   gate can see it: absent, explicitly null, or a bounded lower-case name. The
   model column carries `/` (LAUNCH_TIERS writes `claude/opus`, `local/auto`,
   `gemini/antigravity/...`) and `.` (`gpt-5.6-luna`), so those two are part of
   the shape rather than an exception to it.
 *
 * DELIBERATELY BELOW cleanTreeNodeCommand AND ABOVE completeTreeNodeCommand.
 * tools/test/tree-node-command-clean-gate.test.mjs runs the real gate by
 * slicing exactly that span out of this file and evaluating it -- src/main.js
 * cannot be imported under `node --test` -- so a helper the gate calls must
 * live inside the span or the suite that proves the gate works stops being
 * able to load it. Hoisting makes the position below its caller harmless. */
function treeNodeCommandChoice(value, maxLength) {
  if (value == null) return true
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[a-z0-9][a-z0-9._/-]*$/.test(value)
}

async function completeTreeNodeCommand(command, result) {
  const bridge = typeof window === 'undefined' ? null : window.mcTreeCommand
  if (!bridge || typeof bridge.complete !== 'function') return
  const normalized = result && typeof result === 'object'
    ? result
    : { ok: false, code: 'MC_TREE_COMMAND_RENDERER_FAILED', nodeId: command.nodeId, sessionId: null, threadId: null }
  try {
    await bridge.complete({
      requestId: command.requestId,
      ok: normalized.ok === true,
      code: normalized.ok === true ? null : (normalized.code || 'MC_TREE_COMMAND_RENDERER_FAILED'),
      /* THE CREATE ACTION IS THE ONE WHOSE NODE ID COMES BACK RATHER THAN IN.
         The other two name a circle that already exists, so echoing the request
         is right for them and would be a lie here: the id was minted by the
         store a moment ago and this is the only place the caller can learn it. */
      nodeId: command.action === 'create-and-start-node'
        ? (normalized.ok === true ? (normalized.nodeId || null) : null)
        : command.nodeId,
      sessionId: normalized.ok === true ? normalized.sessionId : null,
      threadId: normalized.ok === true ? (normalized.threadId || null) : null,
      ...(command.action === 'fresh-start-existing-node' && normalized.ok === true
          && normalized.firstTurnState === 'submitted'
        ? { firstTurnState: 'submitted' } : {}),
      ...(command.action === 'create-and-start-node' && normalized.ok === true
        ? { displayName: normalized.displayName || null }
        : {}),
      /* THE WORDS, WHEN THERE ARE ANY. See treeNodeCommandReason. */
      ...(normalized.ok !== true && treeNodeCommandReason(normalized.reason)
        ? { reason: treeNodeCommandReason(normalized.reason) }
        : {}),
    })
  } catch (error) {
    console.error('[tree-node-command] completion could not be recorded:', error?.message || String(error))
  }
}

/* A REQUEST THIS RENDERER CANNOT READ IS STILL A REQUEST SOMEBODY IS WAITING
   ON. cleanTreeNodeCommand answering null used to make the listener below
   simply return, and nothing then ever called bridge.complete: the assistant
   that asked sat on the broker's five-minute deadline and was told a sentence
   about a spawn that timed out. Both measured defects that hung this way (the
   brief-length ceiling, the two verbs missing from the gate) were found by
   the timeout, not by a refusal. The request id is right there on the raw
   value, and a request that cannot be read is a refusal that can be sent at
   once -- by that id, with the fact that it was unreadable as the reason. A
   value with no readable id cannot be answered at all and is left to the
   deadline, which is the only party that can still name it. */
const TREE_NODE_COMMAND_REQUEST_ID = /^tnc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function refuseUnreadableTreeNodeCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  if (typeof value.requestId !== 'string' || !TREE_NODE_COMMAND_REQUEST_ID.test(value.requestId)) return
  const nodeId = typeof value.nodeId === 'string' ? value.nodeId : null
  void completeTreeNodeCommand(
    { requestId: value.requestId, action: typeof value.action === 'string' ? value.action : null, nodeId },
    {
      ok: false,
      code: 'MC_TREE_COMMAND_REQUEST_INVALID',
      nodeId,
      sessionId: null,
      threadId: null,
      reason: 'The application could not read this request: its action or one of its fields is not one this version accepts.',
    },
  )
}

async function drainTreeNodeCommands() {
  if (drainingTreeNodeCommand !== null || pendingTreeNodeCommands.size === 0) return
  if (treeNodeCommandSurfaceReacquiring) return
  const command = pendingTreeNodeCommands.values().next().value
  if (firstRunPending(SETUP_RESOLUTION)) {
    pendingTreeNodeCommands.delete(command.requestId)
    clearTreeNodeCommandSurfaceWait(command.requestId)
    await completeTreeNodeCommand(command, {
      ok: false,
      code: 'MC_TREE_COMMAND_SETUP_REQUIRED',
      nodeId: command.nodeId,
      sessionId: null,
      threadId: null,
    })
    void drainTreeNodeCommands()
    return
  }
  const target = `#/computers/${command.computerId}`
  if (current?.route?.name !== 'computers' || current.route.comp !== command.computerId) {
    if (location.hash !== target) location.hash = target
    else queueMicrotask(render)
    waitForTreeNodeCommandSurface(command)
    return
  }
  if (!current.view || typeof current.view.runTreeNodeCommand !== 'function') {
    waitForTreeNodeCommandSurface(command)
    return
  }

  clearTreeNodeCommandSurfaceWait(command.requestId)
  pendingTreeNodeCommands.delete(command.requestId)
  drainingTreeNodeCommand = command.requestId
  let result
  try {
    result = await current.view.runTreeNodeCommand(command)
  } catch (error) {
    /* THE ERROR'S OWN SENTENCE TRAVELS. `catch {}` here made every thrown
       error the bare code, and the assistant read "could not add that
       assistant to the tree (MC_TREE_COMMAND_RENDERER_FAILED)" -- the failure
       named twice and explained never. */
    result = {
      ok: false,
      code: 'MC_TREE_COMMAND_RENDERER_FAILED',
      nodeId: command.nodeId,
      sessionId: null,
      threadId: null,
      reason: error?.message || String(error),
    }
  }
  /* STILL OURS? The listener below hands the latch to a newer request when
     the broker has demonstrably moved on (see drainingTreeNodeCommand). A
     result for a command the broker has already answered has no slot to land
     in -- complete() would refuse it as a mismatch -- so it is not sent. */
  const abandoned = drainingTreeNodeCommand !== command.requestId
  if (!abandoned) {
    drainingTreeNodeCommand = null
    /* A view can be retired after the route is already Computers (for
       example, navigation destroys the old view while this command is being
       delivered). The command has not reached the product entry path in that
       case: keep the exact request object pending and reacquire the visible
       view. A completed operation never returns this code; Stop's confirmed
       close receipt is authoritative even when its projection disappears. */
    if (result?.ok === false && result.code === 'MC_TREE_COMMAND_VIEW_DESTROYED') {
      pendingTreeNodeCommands.set(command.requestId, command)
      treeNodeCommandSurfaceReacquiring = true
      boundTreeNodeCommandSurfaceReacquire(command)
      render()
    } else {
      await completeTreeNodeCommand(command, result)
    }
  }
  void drainTreeNodeCommands()
}

if (typeof window !== 'undefined' && window.mcTreeCommand && typeof window.mcTreeCommand.onRequest === 'function') {
  window.mcTreeCommand.onRequest(value => {
    const command = cleanTreeNodeCommand(value)
    if (!command) {
      refuseUnreadableTreeNodeCommand(value)
      return
    }
    if (pendingTreeNodeCommands.has(command.requestId) || drainingTreeNodeCommand === command.requestId) return
    /* The broker owns one active slot. A newer request while a retired view is
       awaiting remount proves the older request was already superseded at the
       broker, even though its renderer promise never reached completion. Do
       not execute that abandoned request after the new view mounts. */
    if (treeNodeCommandSurfaceReacquiring && pendingTreeNodeCommands.size > 0) {
      const abandoned = pendingTreeNodeCommands.values().next().value
      if (abandoned && abandoned.requestId !== command.requestId) {
        pendingTreeNodeCommands.delete(abandoned.requestId)
        boundTreeNodeCommandSurfaceReacquire(command, { preserveDeadline: true })
      }
    }
    /* THE BROKER SENDS ONE COMMAND AT A TIME, so a new one arriving while
       another is still in flight here means the broker has already settled
       that one -- at its deadline, or on a reload -- and nothing is waiting
       on its result any more. The latch yields; see drainingTreeNodeCommand. */
    if (drainingTreeNodeCommand !== null) {
      console.warn(`[tree-node-command] ${drainingTreeNodeCommand} never settled in the view; the broker has moved on to ${command.requestId}`)
      drainingTreeNodeCommand = null
    }
    pendingTreeNodeCommands.set(command.requestId, command)
    void drainTreeNodeCommands()
  })
}
// The arrows traverse this ring one stop at a time. Owner decisions live in
// Ledger; Checkout follows it when this copy has a purchase list.
// Settings is the last stop before the ring closes (owner, R1520: "a second
// way to access it by just going through the pages to the settings page") —
// so the page is one Back press from home, and walking forward reaches it
// after the money stretch. Before this it was reachable ONLY through the
// drawer's "all settings" link: a screen with exactly one door, and that door
// inside a popover.
const RING = ['home', 'computers', 'metrics', 'research', 'comms', 'ledger', 'vault', 'checkout', 'settings']

/* STOPS THAT ONLY EXIST ON SOME COPIES.
 *
 * Checkout shows a purchase list the person running this copy supplied; there
 * is no such thing as a stock one. It shipped as an unconditional ring stop
 * carrying the builder's own internal list, on every install, one click back
 * from home -- see src/checkout-visibility.js for the measurement and for why
 * the bytes, not just the door, had to go.
 *
 * A predicate is the mechanism rather than an `if (checkout)` here because the
 * next conditional surface must not have to re-derive the fail-closed rule: a
 * stop is on the ring only when its predicate says TRUE. Anything else --
 * false, undefined, an exception, not measured yet -- leaves it off. */
const CONDITIONAL_STOPS = Object.freeze({
  checkout: checkoutSurfaceAvailable,
})

function stopIsOffered(name) {
  const predicate = CONDITIONAL_STOPS[name]
  if (!predicate) return true
  try { return predicate() === true } catch { return false }
}

/** The ring as it exists on THIS copy, in ring order. */
function ringOrder() {
  return RING.filter(stopIsOffered)
}

function parse() {
  const route = parseRoute(location.hash || '#/')
  if (route.name !== 'ledger') return route
  /* THE ONE STOP WITH A SIDE EFFECT, and it stays here rather than in the pure
     table because it writes. `?tab=` is an ENTRY choice: a link may say which
     of the four lists to open, and that choice is consumed once. parse() also
     serves drawer reads and data refreshes, and re-applying the tab on those
     would drag a person back off a list they chose afterwards. */
  if (route.tab) {
    try { localStorage.setItem(LEDGER_MODE_KEY, route.tab) } catch {}
    try { history.replaceState(history.state, '', `#/ledger${route.rest ? `?${route.rest}` : ''}`) } catch {}
  }
  return { name: 'ledger' }
}

/* Screens that are not stops on the ring, and where each arrow goes from them.
   `agent` is a drill-in; `setup` is the first-run question; `account` is the
   sign-in surface, reached from the walkthrough and from Settings rather than
   by walking the ring. All three were single `route.name === 'agent'` ternaries
   below -- this is the same rule with more entries, not a new behaviour. */
const RING_EXIT = {
  agent: { back: 'computers', next: 'metrics' },
  setup: { back: 'home', next: 'home' },
  account: { back: 'home', next: 'home' },
  /* The coming-soon subscription surface is not a stop on the product tour.
     Both arrows return home so a visitor who typed its route can get out. */
  subscribe: { back: 'home', next: 'home' },
  /* Both arrows return to Settings rather than to home. Every door into this
     page is on Settings or in the drawer's link to it, so Settings is where a
     person came from and where the rest of their answers are. */
  tools: { back: 'settings', next: 'settings' },
}

/* A hash naming a stop this copy does not offer is not an error and must not be
 * a screen. It resolves to home, and the address bar is only rewritten once the
 * probe has SETTLED -- before that, "not offered" only means "not measured yet",
 * and rewriting on it would throw away the address of a surface this copy is
 * about to turn out to have. */
function resolve(route) {
  return stopIsOffered(route.name) ? route : { name: 'home', redirectedFrom: route.name }
}

function makeView(route) {
  const navigate = (hash) => { location.hash = hash }
  switch (route.name) {
    case 'computers': return computersView({ initialComputer: route.comp, navigate })
    case 'agent': return agentView({ compId: route.comp, agentId: route.agent, example: route.example, navigate })
    case 'metrics': return metricsView()
    case 'research': return researchView()
    case 'comms': return commsView()
    case 'ledger': return ledgerView()
    case 'vault': return vaultView()
    case 'checkout': return checkoutView({ navigate })
    /* `navigate` is how the settings rail changes category: each one is its own
       address (`?category=`), so pressing one in the rail is a route change
       like any other rather than a scroll inside a long page. */
    case 'settings': return settingsView({ query: route.query, navigate, accessibilityControls })
    case 'tools': return toolsView()
    case 'setup': return setupView({ navigate })
    case 'account': return accountView({ navigate })
    case 'subscribe': return subscribeView({ query: route.query })
    default: return homeView()
  }
}

function crumbFor(route) {
  const base = `<b>fleet</b> · local`
  switch (route.name) {
    case 'computers': return `${base} / computers`
    case 'agent': return `${base} / agent / <b>${route.agent}</b>`
    case 'metrics': return `${base} / metrics`
    case 'research': return `${base} / research`
    case 'comms': return `${base} / comms`
    case 'ledger': return `${base} / ledger`
    case 'vault': return `${base} / vault`
    case 'checkout': return `${base} / checkout`
    case 'settings': return `${base} / settings`
    case 'tools': return `${base} / settings / tools`
    case 'setup': return `${base} / setup`
    case 'account': return `${base} / account`
    case 'subscribe': return `${base} / subscriptions / coming soon`
    default: return `${base} / home`
  }
}

const VIEW_MORPH_MS = 500

/* The plain route change is a crossfade, which is exactly what the native
   View Transitions API does better than we can: the browser snapshots the
   outgoing stage, so nothing has to keep two live views (two graph canvases,
   two rAF loops) on screen at once. It is a progressive enhancement —
   feature-detected, with the existing class-driven .enter/.exit crossfade
   as the fallback on browsers without it. */
const supportsViewTransition = typeof document.startViewTransition === 'function'
const motionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null
/* The ::view-transition pseudo-elements live on the document root, outside
   any selector body.reduce-motion can reach, so the runtime toggle has to be
   honoured here in JS rather than in the sheet. */
const motionReduced = () =>
  document.body.classList.contains('reduce-motion') || !!motionQuery?.matches

/* THE FIRST-RUN GATE.
 *
 * The permission level is the one thing docs/design/INSTALLER-EXPERIENCE.md 2.1
 * says has to be decided before anything else, and this app had no screen that
 * asked it -- so an installed copy ran with no level recorded and nothing ever
 * said so. When the shell can record one and none exists, the first launch
 * opens on the question.
 *
 * It fails OPEN, deliberately. `firstRunPending` is false whenever the app
 * cannot write a level at all (a browser, a build with no capability payload,
 * a machine record that exists but cannot be parsed). Gating on a screen whose
 * only button is guaranteed to fail would turn a missing payload into an app
 * nobody can get past, which is a worse product than one that carries on and
 * says so in Settings.
 *
 * The body class is what hides the navigation chrome, and it is recomputed on
 * every render rather than set once: the moment a level is recorded the arrows
 * come back, and revisiting this screen later to CHANGE a level is not a trap.
 */
function syncFirstRunChrome() {
  document.body.classList.toggle('first-run', firstRunPending(SETUP_RESOLUTION))
}

/* Which history entry the app is on, so a refused leave can put Back and
   Forward back exactly as they were (src/history-entries.js, T1412). */
const historyEntries = createHistoryEntries()

function render() {
  // the hashchange caused by walking back from a refused move: nothing moved
  if (historyEntries.isUndoEcho(location.hash)) return
  const route = resolve(parse())
  if (route.redirectedFrom && checkoutSurfaceSettled()) {
    // the hashchange this fires re-enters render() with the home route
    location.hash = '#/'
    return
  }

  syncFirstRunChrome()
  if (shouldOpenSetup(SETUP_RESOLUTION, route.name)) {
    // the hashchange this fires re-enters render() with the setup route
    location.hash = '#/setup'
    return
  }

  if (current?.view?.beforeLeave) {
    const decision = current.view.beforeLeave(route)
    if (decision === false) {
      historyEntries.refuse(current.hash || '#/settings')
      return
    }
    if (decision === 'updated') {
      current.route = route
      current.hash = location.hash
      historyEntries.settle()
      return
    }
  }
  historyEntries.settle()

  // a view can hand us a shared element to morph through (e.g. the agent
  // bubble behind "Open full view"); it only ever affects motion, never a route
  const morph = takeViewMorph()
  const zoom = !!(morph && current && morph.kind === 'zoom' && performance.now() - morph.at < 900) && pageCanAnimate()

  // The zoom morph needs both views genuinely on screen (the outgoing one
  // scales into the node the incoming one fades up through), so it keeps the
  // class path; so does the first paint, which has nothing to fade from.
  if (supportsViewTransition && current && !zoom && !motionReduced() && pageCanAnimate()) {
    const vt = document.startViewTransition(() => swapView(route, morph, zoom, true))
    // Navigating again mid-transition SKIPS the running one, which rejects
    // all three promises. Verified in headless Chromium: leaving `ready`
    // unhandled threw "AbortError: Transition was skipped" at the page on
    // every fast double navigation. The route swap itself still completes.
    vt.ready?.catch(() => {})
    vt.finished?.catch(() => {})
    vt.updateCallbackDone?.catch(() => {})
    return
  }
  swapView(route, morph, zoom, false)
}

/**
 * CAN THIS PAGE ACTUALLY DRAW A FRAME RIGHT NOW?
 *
 * A window whose page reports visibilityState 'hidden' gets NO rendering
 * frames from Chromium. Measured on this machine, 2026-08-18, and the honest
 * summary is that it VARIES: two windows of the same build, spawned by the
 * same command minutes apart, reported 'visible' and 'hidden' respectively.
 * The variable is occlusion -- copies of this product open at the same default
 * bounds and cover each other, and a covered page is a page without frames --
 * not any spawn flag, which an earlier version of this comment wrongly named
 * as the cause. (Minimising is what the retention harness ASKS for and then
 * verifies through the page; it was not isolated as an independent cause.)
 * Every piece of motion this router
 * schedules is then a promise the browser can never keep, and worse than
 * useless: work parked on "the next frame" is parked forever, and what it
 * references is retained forever. Heap snapshots of the packaged build
 * (tools/performance-budget-qa.mjs --snapshot, read by
 * tools/heap-snapshot-retainers.mjs) caught both forms of that debt, one
 * whole dead view per navigation, +15,607 DOM nodes and +145 listeners per
 * lap of the ring:
 *
 *   - the `exit` class starts a CSS transition, and a removed element's
 *     transition is only cancelled by a rendering lifecycle update; with no
 *     frames the chain DocumentTimeline -> HeapHashTable<Member<Animation>>
 *     -> CSSTransition -> dead wrapper -> entire dead view persists. Trying
 *     to undo it later was measured and does not work: explicit
 *     Animation.cancel() at retirement freed lap 1 and neither lap after it,
 *     so the transition must not be STARTED rather than cancelled;
 *   - the double-rAF that lifts `enter` is the same shape as seven view-level
 *     sites the pending-frame census DID name and measure
 *     (src/page-frames.js): a queued callback holds its closure, the closure
 *     holds the view. This particular callback was gated with the rest of the
 *     motion before that census existed, so it is guarded for a proven
 *     pattern rather than as a separately measured holder.
 *
 * So the rule is decided ONCE, here, at the moment of navigation: a page that
 * cannot draw does not animate. No transition classes, no rAF choreography,
 * no view-transition — the swap happens at its resting state immediately, and
 * the 420ms retirement grace (which Setup's async handlers genuinely need —
 * see the inert comment below) is kept identical in both worlds, because it
 * is a LIFETIME contract, not a motion.
 *
 * Read per navigation rather than cached: the same window is covered and
 * uncovered all day, and each swap answers for the state it actually runs in.
 */
/* THE RULE ITSELF LIVES IN src/page-frames.js, so the router and the view
   code that schedules frames cannot drift apart about what "this page can
   draw" means. The local name is kept because this file reads better with it. */
const pageCanAnimate = pageCanDraw

/* THE SAME RULE FOR EVERY SHEET-DECLARED TRANSITION, not only the router's.
 *
 * Gating the router's own motion (above) removed its wrappers from the leak
 * and the next heap snapshot promptly named a different holder: the settings
 * page's .seg-ind indicator, whose width/transform transition is created
 * while the view is BUILT — the page sets inline styles, product code forces
 * a style flush, and a hidden page then owns one more CSSTransition it can
 * never run, finish, or cancel. Both were tried with explicit
 * Animation.cancel() at retirement, and both times the cancelled transition
 * stayed registered on the DocumentTimeline anyway: unregistering is itself
 * frame work. There are ~50 transition declarations across the sheets, and
 * every one of them is this bug on a page that cannot draw.
 *
 * So while the page is frameless, stylesheet transitions are switched off at
 * the root (body.frameless, styles.css) and nothing is created — there is
 * nothing to see them with anyway. The moment the window is uncovered the
 * class lifts and every FUTURE change animates exactly as designed: this is
 * a guard on when motion may start, never a removal of it. */
const syncFramelessMotion = () => document.body.classList.toggle('frameless', !pageCanAnimate())
document.addEventListener('visibilitychange', syncFramelessMotion)
/* From the first line, not the first change of state: a window spawned hidden
   (a real spawn mode — measured) builds its every view frameless. */
syncFramelessMotion()

/**
 * Take a retired view out of the page completely — including the browser's
 * own account of it. destroy() honours the view's contract; cancelling the
 * subtree's animations lets the DocumentTimeline drop anything a VISIBLE
 * window was still transitioning when the element left mid-motion (hidden
 * windows never start one — see pageCanAnimate); the forced layout read lets
 * the layout tree release the retired wrapper (an attached ancestor's
 * InlineItems kept referencing the removed wrapper's layout objects in the
 * same snapshots) without waiting for a frame that may never come. It runs
 * in the exit timer, off the interaction path.
 */
function retireView(el, view) {
  view.destroy?.()
  if (typeof el.getAnimations === 'function') {
    for (const animation of el.getAnimations({ subtree: true })) animation.cancel()
  }
  el.remove()
  void stage.offsetWidth
}

/**
 * Mount the view for `route` and retire the previous one.
 * `snapshotted` = the browser is already crossfading a captured frame for us,
 * so the swap itself must be instant and unanimated.
 */
function swapView(route, morph, zoom, snapshotted) {
  nativeStopSurface?.clear()
  const old = current
  const view = makeView(route)
  const wrap = document.createElement('div')
  wrap.className = 'view enter'
  wrap.appendChild(view.el)
  stage.appendChild(wrap)

  if (snapshotted || !pageCanAnimate()) {
    // the pseudo-elements carry the motion; the real DOM must already be at
    // its resting state when the browser captures the "new" frame. A hidden
    // page takes the same branch for the opposite reason: there will BE no
    // frame, so a double-rAF parked here would hold this wrapper (and the
    // whole view under it) in the callback registry until the window is next
    // uncovered — measured as part of the retention this file's retireView
    // comment documents.
    wrap.classList.remove('enter')
  } else if (zoom) {
    // incoming view fades up through the outgoing one — both are present for
    // the whole move, so the page never blanks to the backdrop
    wrap.classList.remove('enter')
    wrap.classList.add('mc-zoom-enter')
    setTimeout(() => wrap.classList.remove('mc-zoom-enter'), VIEW_MORPH_MS + 80)
  } else {
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.remove('enter')))
  }

  if (old) {
    /* The outgoing view stays on screen for the exit transition, so until it is
       removed it is still clickable. A person who presses a control on a view
       that is 420ms from being destroyed drives an instance whose async
       handlers come back to `destroyed === true` — which is how Finish in
       src/views/setup.js came to silently do nothing at all. It is leaving, so
       it takes no more input. */
    old.el.inert = true
    if (snapshotted) {
      retireView(old.el, old.view)
    } else if (zoom) {
      const r = old.el.getBoundingClientRect()
      const ox = Math.max(0, Math.min(r.width, morph.x - r.left))
      const oy = Math.max(0, Math.min(r.height, morph.y - r.top))
      old.el.style.transformOrigin = `${ox}px ${oy}px`   // the node's own position
      old.el.classList.add('mc-zoom-exit')
      setTimeout(() => retireView(old.el, old.view), VIEW_MORPH_MS + 40)
    } else {
      /* The class is the animation, so only a page that can draw gets it: on
         a hidden page it would start a CSS transition no frame will ever run
         or cancel, and the DocumentTimeline would hold this wrapper — view
         and all — until the window is next uncovered. The retirement TIMER is
         identical either way; only the motion is conditional. */
      if (pageCanAnimate()) old.el.classList.add('exit')
      setTimeout(() => retireView(old.el, old.view), 420)
    }
  }
  current = { el: wrap, view, route, hash: location.hash }
  markTreeNodeCommandSurfaceMounted()
  nativeStopSurface?.mount(view.nativeStop)
  /* WHICH TREE IS ON SCREEN is announced by the Computers view itself, where
     the tree store is opened -- not from here. This router knows the address,
     and the address is not the answer: the view resolves its own computer when
     the address names none, which is what a bare #/computers link produces. */
  /* A coordinator request may have navigated here while this view was being
     built. The view method awaits its own async boot, so draining now is safe
     and is the first moment its private tree/session maps exist. */
  void drainTreeNodeCommands()

  if (crumb) crumb.innerHTML = crumbFor(route)
  // Route stamp on <body>. It was added to gate the aurora drift to Home;
  // the aurora is gone and no sheet reads it today, but it stays as the
  // one hook a per-route rule can hang off without touching the router.
  document.body.dataset.route = route.name
  const activeName = { agent: 'computers', tools: 'settings' }[route.name] || route.name
  navEl?.querySelectorAll('a').forEach(a => {
    const active = a.dataset.route === activeName
    a.classList.toggle('active', active)
    if (active) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })

  const order = ringOrder()
  const idx = order.indexOf(activeName)
  const back = document.getElementById('nav-back')
  const next = document.getElementById('nav-next')
  /* The ring is closed: home <- computers <- metrics <- research <- comms <- ledger <- home. The
     ends used to dead-end (back dark on home, forward dark on comms), which
     made the two arrows read as a linear pager with nothing past its covers.
     The owner asked for a loop — back and forth exist on every page — so
     neither arrow ever disables and the maths below is modular. */
  back.toggleAttribute('disabled', false)
  next.toggleAttribute('disabled', false)

  /* The arrows complement the direct page links: each quietly names the
     adjacent stop once a person reaches for it, without adding a second row
     of always-visible labels. */
  const label = (n) => (n === 'comms' ? COMMS_NAME : n)
  const ringAt = (i) => order[(i + order.length) % order.length]
  back.dataset.dest = RING_EXIT[route.name] ? RING_EXIT[route.name].back : label(ringAt(idx - 1))
  next.dataset.dest = RING_EXIT[route.name] ? RING_EXIT[route.name].next : label(ringAt(idx + 1))

  /* The arrow's destination also has to reach a screen reader, which the CSS
     ::after caption never could: it is generated content, and the static
     aria-label ("Back"/"Next") outranked it in the accessible name anyway.
     Both labels are written from the same data-dest the caption reads. */
  const backName = back.dataset.dest ? `Back to ${back.dataset.dest}` : 'Back'
  const nextName = next.dataset.dest ? `Forward to ${next.dataset.dest}` : 'Forward'
  // title and aria-label are written from the same string so the tooltip can
  // never disagree with the accessible name (WCAG 2.5.3); the visible ::after
  // caption is just the destination word, which both of them contain.
  back.setAttribute('aria-label', backName); back.setAttribute('title', backName)
  next.setAttribute('aria-label', nextName); next.setAttribute('title', nextName)
  const routeName = route.name === 'agent' ? `agent ${route.agent}` : label(route.name)
  document.title = `${routeName} · ToolsEnabled`
  /* A hash-route swap changes almost the entire screen without performing a
     document navigation. Keep focus where the person put it (the Back/Forward
     controls remain useful for repeated navigation), but announce the new
     screen through the shell's persistent live region. Moving focus on every
     data-driven re-render would be considerably worse: agent/message updates
     also call this function and must not steal a keyboard user's caret. */
  const routeStatus = document.getElementById('route-status')
  if (routeStatus) routeStatus.textContent = `${routeName} screen loaded`
  firstUseGuidance.visit(route.name, view.el)
}

window.addEventListener('hashchange', render)
// The data source can change under an open view: the example toggle, a
// sign-in/out on the website, or a view's own first async resolution landing a
// different verdict than its construction guess. Rebuild the active surface so
// the whole page changes worlds at once, while the settings page keeps its
// inline controls in place and updates them locally.
window.addEventListener(DATA_SOURCE_EVENT, event => {
  syncPhoneExampleNotice()
  if (isExampleMode() || currentDataSource() === 'mock') {
    resetPersistentVoice()
    void window.mcAccessibility?.disable?.().catch(() => {})
  }
  void accessibilityControls.refresh?.()
  /* A different world's money list must not survive into this one.
     src/purchase-cart-changes.js remembers the cart's last reading and every
     sentence describing what moved since -- renderer memory that OUTLIVES any
     one view on purpose, so the change strip on #/approvals survives him
     walking the ring away from it and back (see that file's own header). The
     same design that lets it survive a view swap also let it survive a
     sign-out: the module shipped a resetCartChanges() doc-commented "used ...
     by a sign-out", and nothing ever called it, so the next account to sign
     in on this window inherited the previous one's remembered purchase
     changes. This is the one event every sign-in and sign-out already fires
     (see the comment above), so it is also the one place this can be cleared
     for every path at once rather than each view remembering to do it only
     when it happens to be the one on screen. Unconditional and synchronous,
     unlike the render() below, so the clear has already happened before any
     microtask-queued remount reads the record. */
  resetCartChanges()
  // Finish applies its example choice before showing any deferred policy
  // result. Replacing Setup here loses that result with its view instance.
  // Account/host changes still refresh it, and all shared effects above run.
  /* Computers owns incremental host and event-gap reconciliation. Rebuilding
     the route here for those announcements destroys its active surface, scroll,
     selection and stream attachments, then remounts the saved-session probes.
     Let the mounted view consume these non-destructive events; route changes and
     actual data-source transitions retain the full render below. */
  const why = event.detail?.why
  const nonDestructiveComputersEvent = current?.route?.name === 'computers'
    && (why === 'host' || why === 'agent-events-gap')
  if (current?.route?.name !== 'settings'
      && !(current?.route?.name === 'setup' && why === 'example-toggle')
      && !nonDestructiveComputersEvent) queueMicrotask(render)
})
window.addEventListener(WRITE_FLAGS_EVENT, () => {
  // Setup saves all seven flags during Finish. It owns the resulting review;
  // its own notifications must not retire it while those writes settle.
  if (current?.route?.name !== 'settings' && current?.route?.name !== 'setup') queueMicrotask(render)
})

const hashFor = (name) => (name === 'home' ? '#/' : `#/${name}`)
/* The arrows walk the ring THIS COPY HAS. Reading the destination off the same
   ringOrder() the labels are written from is what stops the two disagreeing --
   a chevron captioned "home" that lands on a stop the copy does not offer is
   how a hidden surface comes back through the only navigation the app has. */
const stepRing = (from, delta) => {
  const order = ringOrder()
  const idx = order.indexOf(from)
  if (idx === -1) return order[delta > 0 ? 0 : order.length - 1]
  return order[(idx + delta + order.length) % order.length]
}
document.getElementById('nav-back').addEventListener('click', () => {
  const route = resolve(parse())
  // the agent view is a drill-in, not a ring stop: back surfaces to its graph
  if (RING_EXIT[route.name]) { location.hash = hashFor(RING_EXIT[route.name].back); return }
  location.hash = hashFor(stepRing(route.name, -1))
})
document.getElementById('nav-next').addEventListener('click', () => {
  const route = resolve(parse())
  // ...and forward from the drill-in resumes the ring after its graph
  if (RING_EXIT[route.name]) { location.hash = hashFor(RING_EXIT[route.name].next); return }
  location.hash = hashFor(stepRing(route.name, 1))
})

/* ---------- settings drawer ---------- */
const drawer = document.getElementById('drawer')
const openSettingsBtn = document.getElementById('open-settings')

/* `inert` (not just aria-hidden) keeps the CLOSED drawer out of the tab
   order — without it Tab walked through four off-screen controls, one of
   them a 0x0 checkbox where Space silently toggled Reduce Motion.

   The guard is derived from the drawer's own state and applied to the
   drawer ROOT, and a MutationObserver re-applies it whenever the drawer's
   markup or its `inert` attribute changes — so adding, reordering or
   replacing controls inside the drawer (another lane's edit, a future
   setting) cannot quietly re-open that hole. Where `inert` is unsupported,
   the same state is enforced by parking every focusable descendant at
   tabindex="-1" and restoring whatever it had on the way back out. */
const supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]'
let drawerOpen = false

function enforceDrawerFocusGuard() {
  const closed = !drawerOpen
  if (supportsInert) {
    // compare first: an unconditional write would re-trigger the observer
    if (drawer.hasAttribute('inert') !== closed) drawer.toggleAttribute('inert', closed)
    return
  }
  for (const node of drawer.querySelectorAll(FOCUSABLE)) {
    if (closed) {
      if (node.dataset.mcTabindex === undefined) {
        node.dataset.mcTabindex = node.getAttribute('tabindex') ?? ''
        node.setAttribute('tabindex', '-1')
      }
    } else if (node.dataset.mcTabindex !== undefined) {
      const prev = node.dataset.mcTabindex
      if (prev === '') node.removeAttribute('tabindex')
      else node.setAttribute('tabindex', prev)
      delete node.dataset.mcTabindex
    }
  }
}

/* The OPEN drawer is the mirror image of the closed one: it covers the page,
   so everything behind it has to leave the tab order too. Without this, Tab
   from the gear walked 16 stops through the page before reaching the drawer,
   and two of those stops (#nav-next, fully; the "Sort by Runtime" header,
   58%) were underneath the open drawer — focus you cannot see, which is
   WCAG 2.2 SC 2.4.11. Same `inert` mechanism as the closed-drawer guard,
   pointed the other way; where inert is unsupported the browser simply keeps
   its old behaviour rather than us re-implementing a trap by hand. */
const behindDrawer = [
  document.querySelector('header.topbar'),
  document.getElementById('stage'),
  /* THE SKIP LINK REOPENED THE HOLE THIS GUARD CLOSES.
     It is a <body> child, so neither of the two nodes above contains it, and
     it paints at z-index 10000 against the drawer's 80. With the drawer open a
     keyboard user could therefore Tab to it, SEE it render over the modal,
     follow it, and land on a #stage that this very function had just made
     inert. Focus you cannot use, arrived at through a control drawn on top of
     a modal -- SC 2.4.11 again, reintroduced by the element added to fix a
     different accessibility gap.
     Listed here rather than given its own inert toggle so there stays exactly
     one place that decides what the open drawer hides. */
  document.querySelector('.skip-link'),
].filter(Boolean)
// Its press moves focus to #stage and leaves the address alone (T1421).
keepSkipLinkOnPage(document)
function enforcePageGuard() {
  if (!supportsInert) return
  for (const node of behindDrawer) {
    if (node.hasAttribute('inert') !== drawerOpen) node.toggleAttribute('inert', drawerOpen)
  }
}

const setDrawer = (open) => {
  drawerOpen = open
  drawer.classList.toggle('open', open)
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true')
  openSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  enforceDrawerFocusGuard()
  // order matters on the way OUT: the header has to stop being inert before
  // closeDrawer() can hand focus back to the gear inside it
  enforcePageGuard()
}
// childList/subtree + the inert attribute only: the fallback path writes
// tabindex, which is deliberately outside the filter so it cannot loop.
new MutationObserver(enforceDrawerFocusGuard).observe(drawer, {
  childList: true, subtree: true, attributes: true, attributeFilter: ['inert'],
})

const closeDrawer = () => {
  // an inert drawer cannot hold focus; hand it back to the control that
  // opened it instead of dropping the user at the top of the document. Focus
  // that has already fallen off the document (body/null — where Tab past the
  // drawer's last control leaves it) counts too, or the keyboard user is left
  // restarting the tab order from the top of the page.
  const a = document.activeElement
  const hadFocus = drawer.contains(a) || !a || a === document.body
  setDrawer(false)
  if (hadFocus) openSettingsBtn.focus()
}
const openDrawer = () => {
  // built fresh at every open, for the page that is on screen (owner R1520:
  // per-page settings, not the same simulation-flavoured list everywhere)
  const route = resolve(parse()).name
  /* "all settings ->" IS NOT DRAWN ON THE SETTINGS PAGE. Opened from #/settings
     it was a link to the page underneath it, which either does nothing visible
     or scrolls somebody to the top of the page they were already reading and
     shuts the panel they had just opened. A door out of a room you are standing
     in is not a door. */
  const allSettings = document.querySelector('.drawer-all')
  if (allSettings) allSettings.hidden = route === 'settings'
  renderQuickSettings(drawer.querySelector('.drawer-body'), route)
  setDrawer(true)
  // focus follows the surface that just covered the page — the close button
  // is the drawer's first stop, so Tab continues through the page group and
  // Theme/Glow/Reduce motion from there instead of the top of the page
  document.getElementById('close-settings').focus()
}
openSettingsBtn.addEventListener('click', openDrawer)
document.getElementById('close-settings').addEventListener('click', closeDrawer)
document.querySelector('.drawer-all').addEventListener('click', closeDrawer)
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return
  if (!drawerOpen) return
  if (e.key === 'Escape') { closeDrawer(); return }
  /* aria-modal="true" is a promise that focus stays inside, and `inert`
     alone only keeps it out of the PAGE — Tab past the last drawer control
     still walked off into the browser chrome and came back at the top of an
     inert document, i.e. nowhere. Wrap it. */
  if (e.key !== 'Tab') return
  const stops = [...drawer.querySelectorAll(FOCUSABLE)]
    .filter(n => !n.hasAttribute('disabled') && n.tabIndex !== -1 && n.offsetParent !== null)
  if (!stops.length) return
  const first = stops[0], last = stops[stops.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})
/* The drawer has no scrim, so with the page now inert behind it a click on
   the page would otherwise do nothing at all and read as a frozen app.
   Pointer-down outside dismisses instead. (The gear itself sits underneath
   the open drawer, so it is not a toggle — the drawer takes that hit.) */
document.addEventListener('pointerdown', (e) => {
  if (!drawerOpen || drawer.contains(e.target)) return
  /* closeDrawer() hands focus back to the gear, but the browser's DEFAULT
     action for this same pointerdown runs after us and moves focus to the
     clicked target (<body>, since the page is inert) — clobbering the
     restore and leaving keyboard users to re-Tab from the top. Cancelling
     the pointerdown suppresses that default focus pass; the page behind is
     inert, so the press had no other job this could break. */
  e.preventDefault()
  closeDrawer()
})
/* THE PAGE UNDER THE OPEN DRAWER CAN STILL CHANGE. The inert fence covers
   only this app's own chrome (the topbar and the stage), so the hash still
   moves while the drawer is open: the browser's own Back/Forward buttons,
   this router's redirects, and — on the website, which serves this same
   bundle under its own header — the site's nav links above the app. render()
   answers every one of those by swapping the view UNDERNEATH, and the drawer
   just stayed standing: a panel built per page, at open (R1520), describing
   a page that was gone, and holding the new page parked inert behind a
   dialog nobody opened there. MEASURED (drive-state-space, 2026-08-25): one
   gear press leaked an open drawer into every route the driver walked next,
   and 89 of its 90 findings were this cluster read back as "stranded"
   controls. Navigation closes the drawer — the same door the "all settings"
   link already leaves through. */
window.addEventListener('hashchange', () => { if (drawerOpen) closeDrawer() })
/* THE ONE PAGE SETTING THE DRAWER OFFERS, APPLIED WHERE IT CAN BE SEEN.
   src/views/computers.js asks phoneLedgerDecision once, while it builds, so a
   choice stored afterwards is inert until the view is built again. render()
   builds it again. The drawer closes first for the reason the control exists:
   it covers 320 of a 390px phone, so a person who flipped the tree between
   circles and rows would be looking at the panel instead of at the answer.
   Desktop windows never reach this — the phone-canvas mode gates the control
   out of the drawer entirely, so the event has no sender there. */
window.addEventListener(PHONE_LEDGER_EVENT, () => {
  if (drawerOpen) closeDrawer()
  render()
})
setDrawer(false)

/* ---------- stored appearance, re-applied before the first render ----------
   The controls themselves live in src/quick-settings.js now (built per page,
   at every drawer open) and on the settings page; what remains here is the
   boot half of each sticky setting.

   Theme is already on the page — the inline classic script in index.html
   applies it before first paint (same key, same guard), and the drawer reads
   document.documentElement.dataset.theme whenever it renders, so there is no
   second copy to sync here any more.

   Text size (the owner's user-facing scale control) is zoom on the body: the
   app is sized in px throughout (13px reading floor, 12.5 data tier), so
   zoom rescales layout coherently, fixed chrome included, and every chart
   re-fits itself because its host resizes and the existing ResizeObservers
   fire. Default is exactly 1 — an untouched user is byte-identical, and the
   QA suites (which assert px) run at default.

   THE APPLYING IS src/text-size.js's, NOT THIS FILE'S ANY MORE. Three places
   set this size (here, the drawer, the settings page) and each had its own
   copy of the same two lines; the layout now needs a third thing written at
   the same moment (the --zoom custom property every window-bounding length
   divides by — see :root in src/styles.css), and a third line to forget in
   three places is how the drawer and the page drift apart. The try/catch
   stays here because the STORAGE read is what throws. */
try {
  applyTextSize(localStorage.getItem(TEXT_SIZE_KEY))
} catch {}
/* Glow intensity and reduce motion, put back the way theme and text size are.
   They were the only two appearance choices with nowhere to be written down,
   so both were lost at every launch; see src/appearance-persistence.js. */
applyStoredAppearance()
bindAppearanceAccountChanges()
initializeRoleColors()
startHandControls()

/* ---------- the phone canvas, decided once, before the first view ----------
   Asked here rather than inside a view because the page BOX is what it locks,
   and because the answer has to be on the page before anything measures
   itself. On a desktop THAT ASKED FOR NOTHING this writes nothing at all — no
   attribute, no custom property, not even a resize listener — and returns
   false; see the decision function in src/phone-canvas.js for why a
   touchscreen laptop and a narrow desktop window are both desktops to it. The
   qualifier is load-bearing: a browser of any kind that follows the mobile
   page's /app/?ledger=1 link DOES get the mode, and phone-canvas.test.mjs
   pins that on a 1440x900 fine-pointer window. This comment used to state the
   unqualified claim, which the routing law's ledger door had already made
   false.

   AND IT MUST NOT BE ABLE TO STOP THE APP FROM BOOTING. This is a bare call at
   module top level, so anything it throws aborts the whole module and the
   product renders nothing at all. It can throw: readPhoneCanvasChoice() and
   readPhoneCanvasEnvironment() both raise PHONE_CANVAS_COULD_NOT_TELL when
   localStorage or matchMedia refuses — a designed, tested outcome (see that
   module's "a failed device query is could-not-tell, never absence and never
   latched"), reachable in private mode and in locked-down embedded browsers.
   Nothing anywhere in src/ caught it. The text-size read twelve lines above
   has had its try/catch since it was written, for the same storage, on the
   same page load.

   Could-not-tell means the phone dress does not engage, which lands on the
   desktop graph. This fallback keeps the app usable when device or storage
   queries are refused. Losing the phone dress is a degradation; losing the
   application is not. Anything that is NOT could-not-tell is a real defect
   rather than a refused query, so it is reported rather than swallowed
   silently — but it still must not take the boot down with it. */
try {
  startPhoneCanvas()
} catch (error) {
  if (error?.code !== PHONE_CANVAS_COULD_NOT_TELL) console.error(error)
}

/* ---------- central clock for every runtime readout ----------
   Handed the window's timer once. It schedules NOTHING until a readout is
   registered and unschedules the moment none is, so a screen with no runtime
   on it costs no wakes at all. This line used to be an unconditional
   setInterval at 500ms: measured 2026-09-03 at 120.00 ticks/min on every
   screen, against a registry that only src/tree-graph.js and
   src/phone-ledger.js ever write to. See src/runtime-clock.js. */
startRuntimeClock()

/* WHICH CONDITIONAL STOPS THIS COPY HAS, ASKED ONCE, AT THE START.
 *
 * The first paint does not wait for the answer -- a loopback read is instant in
 * the ordinary case and blocking the window on it would trade a real defect for
 * a worse one -- so the ring simply starts without its conditional stops and
 * gains them when the probe lands. That order is the safe one: the ring can only
 * GROW when the answer arrives, so a slow or failed probe hides a surface rather
 * than briefly showing one. */
/* NEVER OVER THE WALKTHROUGH. This listener exists so a settled probe can
 * repaint the surfaces that show checkout state -- the ring and its arrows.
 * The first-run walkthrough shows neither, and re-entering render() while it
 * holds the glass MOUNTS A SECOND COPY of it and retires the one the person
 * is walking 420ms later, mid-step.
 *
 * MEASURED, packaged build, fresh profile, 2026-08-19 (trace in the
 * setup-placeloss lane report): boot render redirects '' -> '#/setup' and
 * returns; the hashchange it fires is a QUEUED task; under machine load the
 * checkout probe settled inside that gap (94ms and 96ms in two traces), this
 * listener mounted setup copy #1, the queued hashchange then mounted copy #2,
 * and the person's whole walk happened on copy #1 -- torn down by the 420ms
 * retirement timer with the review on screen. The glass fell back to copy
 * #2, still sitting on question 1. Finish never existed. The same listener
 * firing later (the probe has a 4s timeout) re-mounts the walkthrough
 * mid-walk with whatever the stored profile lags to.
 *
 * The route is read from the hash, not from `current`: in the measured race
 * `current` is still null while the hash already names the walkthrough. */
window.addEventListener(CHECKOUT_SURFACE_EVENT, () => {
  if (resolve(parse()).name === 'setup') return
  render()
})
void probeCheckoutSurface()

render()
/* The drawer rebuilds at every open; this first build only means its body is
   never empty — a harness (or a stylesheet measure) that reaches for
   #theme-seg before ever pressing the gear still finds it. */
renderQuickSettings(drawer.querySelector('.drawer-body'), resolve(parse()).name)

/* IF THE SETTINGS FILE COULD NOT BE READ, SAY SO. Mounted after the first
   render and outside it, because it is a fact about this WINDOW rather than
   about the current route: it must not be torn down and rebuilt by every
   navigation, and it must not disappear when a view does. See
   src/settings-recovery-notice.js for why silence here is the defect.
   The same bar also says when the previous run left no shutdown record
   (src/last-exit-notice.js); with no shell there is no source and nothing
   mounts, as before. */
mountSettingsRecoveryNotice({ source: lastExitNoticeSource({ computerIds: (FLEET.machines || []).map(machine => machine?.id).filter(Boolean) }) })

/* TELL THE MAIN PROCESS WHAT THIS WINDOW IS SHOWING, so a notification does not
   arrive about the agent whose transcript is already in front of the person.
   Mounted here for the same reason the recovery notice above is: it is a fact
   about this WINDOW, not about a route, so it must survive every navigation
   rather than being rebuilt by one. It subscribes to the live-session record,
   which src/agent-session.js clears in its own teardown -- so leaving the agent
   page reports "nothing on screen" without this file knowing what a route is.
   src/notification-attention.js says why the report exists at all. */
startAttentionReports()
initializeAutonomousContinuations()

/* PROMPT B. THE HOTLOAD STALENESS INDICATOR, in the shell so it covers every
   route rather than one view -- both lanes are edited live and the owner moves
   between them.

   `import.meta.hot` is `undefined` in a build, so this branch is dead code
   there and the dynamic import below never enters the bundle. That is the whole
   of the never-in-a-packaged-build guarantee: not a flag somebody can set
   wrongly, a branch the builder removes. src/dev-hotload-status.js says what it
   measures and why none of it is a timer. */
if (import.meta.hot) {
  import('./dev-hotload-status.js')
    .then(module => module.startHotloadStatus(import.meta.hot))
    /* A dev instrument that breaks must not take the page with it: the page is
       the thing being watched. */
    .catch(error => console.error('hotload status unavailable:', error))
}
