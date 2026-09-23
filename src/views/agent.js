// Agent page — the agents on this computer as a roster of cards, then the
// session control, then Chat | Controls side by side.
//
// REDONE, not tuned. The previous version drew this page's agents as a
// physics-simulated bubble graph with separately-solved floating context boxes.
// See the header of src/agent-roster.js for the full account of why that was
// replaced rather than adjusted; the short version is that it positioned text
// absolutely, so every overlap had to be discovered and repaired at runtime, and
// after five rounds of increasingly clever solvers it still printed `16:27:58`
// across `COORDINATOR'S HELPER` and still withheld 2 of 5 boxes at 1280px.
// Cards in a grid cannot overlap, so there is nothing left to solve.

import { rimRole, roleAppearance } from '../vocab.js'
import { NO_SENDER_WIRED } from '../chat-copy.js'
import { controlState, el, uptimeRing, buildChat } from '../components.js'
import { PALETTE_PANEL, pasteRefusalSentence } from '../fleet-tree-copy.js'
/* THE ONE AXIS THIS PAGE VARIES ON. The per-view live flag and the separate
   simulated render it selected are gone (owner's ruling: "all simulated pages
   ARE the UI pages, just mock data"). What remains is where the data comes
   from — 'local', 'relay', or 'mock' — and this page renders the same way for
   all three; only the projection's SOURCE and the badge differ. */
import { resolveDataSource, sourceIsBadged, DATA_SOURCE_EVENT, currentDataSource } from '../data-source.js'
/* The example fleet, in exactly the agents-projection `data` shape the live
   readers consume — see its header for why it is a copy and not an import. */
import { sampleAgentsData } from '../sample-fleet.js'
import { createTerminateController } from '../mission-bridge.js'
import { mountAgentWriteSurface } from '../write-surfaces.js'
import { mountAgentSessionSurface, sessionActionChatRow } from '../agent-session.js'
/* THE CONSENT GATE THIS PAGE DID NOT HAVE. See startOrContinue below. */
import { isWriteEnabled } from '../write-flags.js'
import { START_CONTROL_FLAG, startControlOffReason } from '../setup-profile.js'
import { mountCloudTaskSurface } from '../cloud-tasks.js'
/* The files an agent left behind, and a report you can read here. The panel
   builds its own elements and imports no styles, so its stylesheet is imported
   by this view -- the arrangement src/agent-compose-panel.js already uses. */
import { mountAgentFilesPanel } from '../agent-files-panel.js'
import { liveSessionFor, onLiveSession } from '../agent-session-registry.js'
/* THE CONVERSATION THIS AGENT HAS ALREADY HAD. See savedConversation below. */
import { readSessionRoles } from '../session-roles.js'
import { fleetTreesStorageKey } from '../fleet-trees.js'
import {
  CONFIRMED_CONTROLS,
  SESSION_CONTROL_IDS,
  sessionControlAvailability,
  sessionControlFace,
} from '../agent-session-controls.js'
import { fetchAgents } from '../live-status.js'
import { readOrg } from '../org-controls.js'
import { declaredAgentsData, THIS_COMPUTER_ID, THIS_COMPUTER_LABEL } from '../declared-fleet.js'
import { buildAgentRoster } from '../agent-roster.js'
/* The sentences the three steering controls answer with, looked up rather than
   printed raw. See the note above `sessionResult` for what this replaced. */
import { refusalCode, unavailableReason } from '../agent-availability-copy.js'
/* Every sentence in this file that answers a refusal -- the bridge terminate
   control, the two session-steering controls beside it, and the chat's own
   start refusal -- was reaching the glass unwrapped: none of them called
   readerRemedy, so a browser driving this computer over the relay was told
   "close ToolsEnabled and open it again" about a machine it is not sitting
   at. See src/refusal-copy.js's UNAVAILABLE_TEXT-RAW block for the twins this
   reads, and tools/desk-phrase-remote-twin.mjs, which is what found this. */
import { readerRemedy } from '../refusal-copy.js'
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })
const readerMachine = (deskSentence, relaySentence, viaRelay = currentDataSource() === 'relay') => (
  viaRelay ? relaySentence : deskSentence
)
/* The readers that decide what a live session is allowed to put on screen, and
   from which session. The composer below uses the SAME pair the Controls panel
   uses rather than reading the packet itself -- see the note on the listener. */
import { createActionBuffer, sessionActivityEvent, createSessionTextReader, sessionFiledRule, sessionRuleFilingCall, sessionTurnFailureText, sessionTurnStatus } from '../agent-session-events.js'
/* The one row the chat shows when an agent files a standing rule -- the same
   words the tree chat draws, built from the engine's own tool result. */
import { filedRuleChatRow } from '../filed-rule-copy.js'
import { attachResizeHandle } from '../resize-handle.js'
import { textZoom } from '../text-size.js'
import '../agent.css'
import '../agent-files-panel.css'

/* Normalize the one runtime source shared by the roster and the controls ring.
   A terminal control target without its exact stop epoch fails closed; a finite
   stoppedAt is the only value allowed to freeze elapsed time. */
export function liveAgentRuntimeSource(agent, observedAt = Date.now()) {
  const bornAt = Number.isFinite(agent?.bornAt) ? agent.bornAt : null
  if (bornAt === null) return null
  const stoppedAt = Number.isFinite(agent?.stoppedAt) ? agent.stoppedAt : null
  const terminalWithoutStop = (agent?.controlTarget?.status === 'finished'
    || agent?.controlTarget?.status === 'failed') && stoppedAt === null
  if (terminalWithoutStop) return null
  return {
    bornAt,
    stoppedAt,
    elapsedMs: Math.max(0, (stoppedAt ?? observedAt) - bornAt),
    running: stoppedAt === null,
  }
}

/* THE CHAT COLUMN'S DRAG FLOOR, READ FROM THE ONE RULE THAT ENFORCES IT.
 *
 * agent.css's .agentv-panels-wrap > .agentv-panels declares
 * --agentv-chat-floor: 520px, the same number its own
 * minmax(--agentv-chat-floor, 1.15fr) already refuses to shrink the column
 * below. Before this, the resize handle carried its own, unrelated `min:
 * 280` -- so a manual drag could claim a width the grid was never going to
 * honour, silently clamped 240px higher than what the handle reported.
 * Reading the number from computedStyle rather than repeating it here means
 * changing the CSS rule is the only place that number needs to change.
 *
 * Takes a CSSStyleDeclaration-shaped object (anything with
 * getPropertyValue(name)) rather than an element, so this is callable with
 * getComputedStyle(el) in the browser and with a plain {getPropertyValue}
 * stub in a test that has no DOM to mount agentView in at all.
 *
 * Falls back to the literal 520 only if the property cannot be read (an
 * empty string, an unparsated unit, or a style object that doesn't carry
 * this custom property at all -- an older cached stylesheet, for instance).
 * That fallback repeats the CSS rule's own default rather than the old bug's
 * 280, so an unreadable property fails toward the floor holding, not toward
 * it silently reopening. */
export function agentvChatFloorPx(computedStyle) {
  const raw = computedStyle && typeof computedStyle.getPropertyValue === 'function'
    ? computedStyle.getPropertyValue('--agentv-chat-floor')
    : ''
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 520
}

/* Runtime telemetry is optional, and its decorative ring must be optional too.
   Keep a missing or malformed mount from aborting the rest of the agent view,
   especially the live controls that own the Terminate action. */
export function appendAgentRingNode(parent, child) {
  try {
    if (!parent || !child || typeof parent.appendChild !== 'function') return false
    parent.appendChild(child)
    return true
  } catch {
    return false
  }
}

/* The agent projection deliberately separates declared topology from observed
   sessions.  Session ids are opaque and the contract gives us no safe bridge
   from one to a declared agent, so this adapter never turns one into a
   per-agent runtime, chat, task count, or zero. The palette/label lookup below
   is `rimRole` from src/vocab.js -- ROLES now covers every declared org role
   directly, so this no longer needs its own translation to a legacy bucket
   (removed: it aliased 'controller' to 'coordinator' and
   'coordinator-assistant' to 'helper', which would now disagree with every
   other consumer reading the same role directly). `declaredRole` remains the
   stored identity and no structural or workflow decision is made from this
   visual alias. */

function relationshipLabel(relationship, id, declaredById) {
  const outgoing = relationship.from === id
  const otherId = outgoing ? relationship.to : relationship.from
  const other = declaredById.get(otherId)
  if (!other) return null
  const name = other.displayName
  const labels = {
    manages: outgoing ? `manages ${name}` : `managed by ${name}`,
    reviews: outgoing ? `reviews ${name}` : `reviewed by ${name}`,
    delegates_to: outgoing ? `delegates to ${name}` : `delegated by ${name}`,
    escalates_to: outgoing ? `escalates to ${name}` : `escalated by ${name}`,
  }
  return labels[relationship.type] || null
}

function declaredAgentProjection(compId, agentId, data, viaRelay = false) {
  const declared = Array.isArray(data?.declared) ? data.declared : []
  const declaredById = new Map(declared.map(agent => [agent.id, agent]))
  const selected = declaredById.get(agentId)
  if (!selected) return null

  const relationships = (Array.isArray(data?.relationships) ? data.relationships : [])
    .filter(relationship => (relationship.from === agentId || relationship.to === agentId)
      && declaredById.has(relationship.from) && declaredById.has(relationship.to))
  const relatedIds = [...new Set(relationships.map(relationship => (
    relationship.from === agentId ? relationship.to : relationship.from
  )))]
  const labelsFor = (id) => relationships
    .map(relationship => relationshipLabel(relationship, id, declaredById))
    .filter(Boolean)

  const asGraphAgent = (declaredAgent, parentId = null) => {
    const labels = labelsFor(declaredAgent.id)
    const runtime = liveAgentRuntimeSource(declaredAgent)
    return {
      id: declaredAgent.id,
      name: declaredAgent.displayName,
      role: rimRole(declaredAgent.role),
      declaredRole: declaredAgent.role,
      parentId,
      state: declaredAgent.enabled ? 'active' : 'inactive',
      bornAt: runtime?.bornAt ?? null,
      stoppedAt: runtime?.stoppedAt ?? null,
      projectionUnavailableReason: readerMachine(
        'not part of this computer’s agent record',
        'not part of the agent record on the computer you are driving',
        viaRelay,
      ),
      model: declaredAgent.provider,
      pool: 'declared',
      ...(declaredAgent.id === agentId ? { controlTarget: declaredAgent.controlTarget } : {}),
      context: [
        labels.length ? `Relationship · ${labels.join('; ')}` : 'No recorded relationship',
        /* WHAT THE RECORD SAYS, IN WORDS. This was "On record · enabled · none"
           -- three fragments joined by middots, ending in a raw provider value
           that reads as a missing field rather than as the fact that no engine
           is named for this agent. Same rule as the fleet rail: a person is
           owed the meaning, not the row. */
        declaredAgent.provider && declaredAgent.provider !== 'none'
          ? `On record as ${declaredAgent.enabled ? 'enabled' : 'disabled'}, configured to use ${declaredAgent.provider}`
          : `On record as ${declaredAgent.enabled ? 'enabled' : 'disabled'}, with no engine named`,
      ],
    }
  }

  const agent = asGraphAgent(selected)
  const computer = {
    id: compId,
    /* The machine this copy runs on has a name a person recognises; a route
       segment is not it. Everything else keeps the id it arrived with.
     *
     * `· as recorded here` USED TO BE APPENDED, and it was the same sentence
     * twice. The breadcrumb read "This computer · as recorded here" while the
     * provenance line beside it — in the same 40px band — read "Read from the
     * team record saved on this computer." One fact, two wordings, side by side
     * (owner R1528). The provenance line is the one that keeps it: it is the
     * element that also carries the example-data notice, so it is where a reader
     * already looks to find out what they are looking at, and it says it in a
     * full sentence rather than in a suffix bolted to a machine's name. */
    name: compId === THIS_COMPUTER_ID ? THIS_COMPUTER_LABEL : compId,
    agents: [agent, ...relatedIds.map(id => asGraphAgent(declaredById.get(id), agent.id))],
  }
  return {
    computer,
    agent,
    relationshipCount: relationships.length,
    sessionState: data?.observedSessions?.ok ? 'unmapped' : 'unavailable',
  }
}

/* Bind the named page to the exact role snapshot it was rendered from. The
   renderer sends only identity and revisions; main re-reads the directions.
   The current organisation must still assign this role to this agent, so a
   stale projection cannot bind an old role using otherwise-current revisions. */
export function roleBindingForAgentProjection(orgRead, agentId, declaredRole) {
  if (!orgRead || orgRead.state !== 'ready'
    || typeof agentId !== 'string' || !agentId
    || typeof declaredRole !== 'string' || !declaredRole
    || !Number.isSafeInteger(orgRead.org?.revision) || orgRead.org.revision < 0) return null
  const current = declaredAgentsData(orgRead.org)?.declared?.find((entry) => entry?.id === agentId) || null
  if (!current || current.enabled !== true || current.role !== declaredRole) return null
  const role = Array.isArray(orgRead.roles)
    ? orgRead.roles.find((entry) => entry?.id === declaredRole) || null
    : null
  if (!role || !Number.isSafeInteger(role.revision) || role.revision < 0) return null
  return Object.freeze({
    agentId,
    id: role.id,
    expectedOrgRevision: orgRead.org.revision,
    expectedRoleRevision: role.revision,
  })
}

/* WHICH OF THOSE AGENTS SIT ON A SIGN-IN THAT HAS RUN OUT.
 *
 * THE DEFECT. The shell has answered this since 2026-09-03 -- the engine's
 * handoverReport(), built on every read of `mc-agent:session-accounts` -- and
 * the only caller dropped `report` and `reportReason` on the floor. So the work
 * was done on every page load and told to nobody, and the one screen that names
 * the accounts stayed the one screen that could not say which were spent.
 *
 * `moves` AND `held` ARE BOTH "ON A SPENT ACCOUNT" and are separated by where
 * the work could go next, not by whether it is a problem. Marking only `moves`
 * would leave the worst case -- every account at its limit, so nowhere to go --
 * as the one drawn as healthy.
 *
 * `unknown` IS NOT MARKED, deliberately. Those are the sessions whose account
 * nobody read; "the check has not run" is not "this account is fine" and it is
 * not "this account is spent" either, and the engine keeps them in a third list
 * precisely so a reader cannot fold them into one of the first two.
 *
 * THE ROW MUST STILL BE TALKING ABOUT THE ACCOUNT THE CARD SHOWS. The report is
 * built from the last allowance check and the live session list, and `from` is
 * the account it judged. If they disagree the mark is withheld rather than
 * pinned to whichever name arrived second.
 *
 * IT MOVES NOTHING. There is no call here and none reachable from here that
 * could close, restart or re-point a session; the report is a value, and this
 * turns it into words on cards. */
function markSpentAccounts(byAgent, report) {
  if (!report || report.ok !== true) return byAgent
  for (const list of [report.moves, report.held]) {
    if (!Array.isArray(list)) continue
    for (const row of list) {
      if (!row || typeof row.agentId !== 'string' || !row.agentId) continue
      const entry = byAgent.get(row.agentId)
      if (!entry || entry.account !== row.from) continue
      byAgent.set(row.agentId, {
        ...entry,
        spent: true,
        to: typeof row.to === 'string' && row.to ? row.to : null,
        why: typeof row.why === 'string' && row.why ? row.why : null,
      })
    }
  }
  return byAgent
}

/* Everything the page learns from one answer to mc-agent:session-accounts, and
 * the whole of it: which sign-in each agent is spending, which of those have
 * run out, and the reason when the second question could not be answered.
 *
 * SEPARATED FROM THE CALL so it can be proven with values. agentView() cannot
 * be mounted in a node test (it carries a stylesheet import and needs a live
 * document -- see tools/test/agent-chat-floor-drag-wiring.test.mjs), and the
 * reading is where the mistakes are, not the awaiting.
 *
 * `ok` IS CARRIED SEPARATELY FROM THE MAP because "no agent here is on a named
 * account" and "this computer could not be asked" are different answers, and
 * only the second is worth a sentence on the screen. */
export function agentAccountsFromAnswer(answer) {
  if (!answer || answer.ok !== true || !Array.isArray(answer.sessions)) {
    return { ok: false, byAgent: new Map(), reportReason: null }
  }
  const byAgent = new Map()
  for (const session of answer.sessions) {
    if (!session || typeof session.agentId !== 'string' || !session.agentId) continue
    if (typeof session.account !== 'string' || !session.account) continue
    byAgent.set(session.agentId, { account: session.account, provider: session.provider ?? null })
  }
  markSpentAccounts(byAgent, answer.report)
  return { ok: true, byAgent, reportReason: typeof answer.reportReason === 'string' ? answer.reportReason : null }
}

/* SEPARATED FROM THE CALL so it can be proven with values, the same reason
   agentvChatFloorPx and liveAgentRuntimeSource are separated above: agentView()
   is a factory over a live DOM and cannot be mounted in a suite, and the
   DECISION here is the whole of the repair.
   Rows are keyed by session, so the agent is found by its node id -- the id
   this page is opened on. A row with no saved lines is not an answer; keep
   looking, and answer null rather than an empty history, because buildChat
   draws its seeded demonstration conversation over an EMPTY one and a page
   showing invented lines is worse than a page showing none. */
export function savedConversationFor(agentId, roles) {
  if (typeof agentId !== 'string' || !agentId || !roles || typeof roles.values !== 'function') return null
  for (const row of roles.values()) {
    if (row?.nodeId !== agentId) continue
    const turns = Array.isArray(row.turns)
      ? row.turns.filter(line => line && typeof line.text === 'string' && line.text)
      : []
    if (turns.length) return turns
  }
  return null
}

/* THE CONVERSATION AS THIS BUILD ACTUALLY STORES IT.
 *
 * savedConversationFor below reads session-roles.js, which reads the LEGACY
 * localStorage transcript store. Measured on a running candidate: that key
 * (mc.fleet.transcripts.v1:<computerId>) does not exist at all, while the same
 * node had ten entries and forty-one revisions held by the main process. When
 * window.mcTranscripts is present, computers.js wraps the legacy store in a
 * node transcript client over that bridge and the bridge is where everything
 * goes -- so a reader that only knows localStorage answers "no conversation"
 * for every agent on this build, which is exactly the empty Agent page.
 *
 * THE COMPUTER IS FOUND, NOT ASKED FOR. This page is opened on an agent, not
 * on a computer, and list() already says which computer each stored
 * conversation belongs to. Taking it from there is one fact from one source
 * rather than a second answer threaded down from the router.
 *
 * Every failure is the same answer: null. A bridge that is absent, refuses, or
 * returns a shape this does not recognise must cost the page its history and
 * nothing else -- and must never answer [], because buildChat draws its seeded
 * demonstration conversation over an EMPTY history and invented bubbles beside
 * a real agent are worse than no bubbles at all. */
export async function storedConversationFor(agentId, bridge, computerIds = []) {
  if (typeof agentId !== 'string' || !agentId) return null
  if (typeof bridge?.read !== 'function') return null
  for (const computerId of computerIds) {
    if (typeof computerId !== 'string' || !computerId) continue
    let stored = null
    try { stored = await bridge.read({ computerId, nodeId: agentId }) } catch { continue }
    const entries = Array.isArray(stored?.entries) ? stored.entries : []
    const lines = entries.filter(entry => entry && typeof entry.text === 'string' && entry.text)
    if (lines.length) return lines
  }
  return null
}

/* WHICH COMPUTERS THIS BROWSER HAS RECORDS FOR, read off the storage keys
   themselves. The fleet-trees key is `<base>:<computerId>` and the module that
   owns the key wrote the prefix, so the rest of it is the computer -- the same
   derivation session-roles.js makes, for the same reason: this page is opened
   on an agent, not on a computer, and nothing hands it one. */
export function computerIdsWithRecords(storage) {
  if (!storage || typeof storage.key !== 'function' || typeof storage.length !== 'number') return []
  const prefix = fleetTreesStorageKey('')
  const found = []
  for (let index = 0; index < storage.length; index += 1) {
    let key = null
    try { key = storage.key(index) } catch { continue }
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue
    const computerId = key.slice(prefix.length)
    if (computerId && !found.includes(computerId)) found.push(computerId)
  }
  return found
}

export function agentView(args) {
  const root = el('<div class="data-live-mode" data-live-mode="live"></div>')
  const showState = (title, reason = '', loading = false) => {
    const state = el(`<div class="projection-state ${loading ? 'is-loading' : 'projection-unavailable'}" role="status"><strong></strong><span></span></div>`)
    state.querySelector('strong').textContent = title
    state.querySelector('span').textContent = reason
    /* A DEAD END IS STILL A DEFECT.
       Every branch below this line is reached by a route that resolved — a deep
       link, a restored window, a bookmark — on a machine whose projection has
       nothing to show. Until now all three printed one grey sentence into an
       otherwise empty page: true, and terminal. The two chevrons in the topbar
       are the only other navigation this app has, and neither one names this
       page's way out, so a person who arrived here by link had to guess. The
       loading state gets no link, because it is about to become one of the
       others and a control that vanishes under the pointer is its own defect. */
    if (!loading) {
      state.appendChild(el('<a class="projection-state-out" href="#/computers">Back to computers</a>'))
    }
    root.replaceChildren(state)
  }
  showState('Opening this agent', readerMachine(
    'reading what this computer has on record…',
    'reading what the computer you are driving has on record…',
    !args.example && currentDataSource() === 'relay',
  ), true)
  let destroyed = false
  let current = null
  /* THE SAME SOURCE THE GRAPH WAS DRAWN FROM.
     /data/agents.json is a build-time file and ships `ok:false` on every
     customer install, so a drill-in opened from a declared computer resolved to
     "Agent projection unavailable" — a door drawn on a wall. When the generated
     projection has nothing, the organisation store answers instead, exactly as
     it does for the graph on the computers page. If it has nothing either, the
     generated file's own refusal is still what the person is shown: the
     fallback adds a source, it never invents an answer. */
  const agentsProjection = async () => {
    const [result, org] = await Promise.all([fetchAgents(), readOrg()])
    if (result.ok) return { result, org }
    const declared = org.state === 'ready' ? declaredAgentsData(org.org) : null
    return { result: declared ? { ok: true, data: { data: declared } } : result, org }
  }

  /* WHAT EACH SOURCE FEEDS THE ONE RENDER. The mock source goes through the
     SAME adapter the real record goes through — declaredAgentProjection — so
     the render cannot tell the example from a record and there is no second
     face for the two to disagree in. The example fleet is deterministic in
     nowMs, so 'mock' can never fail to load: an id that is not one of its
     seats resolves to the same honest "not on record here" state a real record
     answers with, never to an invented agent. */
  /* WHICH OF THE PERSON'S OWN SIGN-INS EACH RUNNING AGENT IS SPENDING.
   *
   * A read of a record the shell already holds; it starts nothing and moves
   * nothing. The join is by DECLARED AGENT, which the shell binds at start from
   * the resolved role binding -- never by deriving an agent from a session id,
   * which the projection contract above refuses and which this does not do
   * either.
   *
   * `ok` IS CARRIED SEPARATELY FROM THE MAP because "no agent here is on a
   * named account" and "this computer could not be asked" are different
   * answers, and only the second is worth a sentence on the screen.
   *
   * THE EXAMPLE PAGE READS NOTHING AND SAYS NOTHING. The example world's own
   * run record is not matched to seats by name (see sampleAgentsData), so no
   * seat in it can honestly be said to be on an account; an empty map is the
   * complete answer rather than a failure to look. */
  const readSessionAccounts = async (source) => {
    if (source === 'mock' || typeof window.mcAgent?.sessionAccounts !== 'function') {
      return { ok: source === 'mock', byAgent: new Map(), reportReason: null }
    }
    try {
      return agentAccountsFromAnswer(await window.mcAgent.sessionAccounts())
    } catch {
      return { ok: false, byAgent: new Map(), reportReason: null }
    }
  }

  const loadProjection = async (source) => {
    if (source === 'mock') {
      return { ok: true, reason: null, projection: declaredAgentProjection(args.compId, args.agentId, sampleAgentsData(Date.now())) }
    }
    const { result, org } = await agentsProjection()
    const projection = result.ok ? declaredAgentProjection(args.compId, args.agentId, result.data?.data, source === 'relay') : null
    return {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      projection: projection
        ? { ...projection, roleBinding: roleBindingForAgentProjection(org, args.agentId, projection.agent.declaredRole) }
        : null,
    }
  }

  /* RENDER PASSES ARE TOKENED, because two of them can be in flight at once:
     the load path awaits twice (the source verdict, then the record), and a
     DATA_SOURCE_EVENT can start a newer pass between the two. Only the newest
     pass may paint; a stale one finishing late must not overwrite a fresher
     world with an older one. */
  let renderPass = 0
  let shownSource = null
  const render = async () => {
    const pass = ++renderPass
    try {
      /* `args.example` is the route asking for the example copy of this page
         for the length of one visit — see the note in src/main.js parse(). It
         pins the source to 'mock' without touching the stored example toggle:
         a URL is the right lifetime for "show me one example page", and it
         feeds the very same mock path the resolver's own 'mock' verdict feeds,
         so the two can never drift apart. */
      const source = args.example ? 'mock' : await resolveDataSource()
      if (destroyed || pass !== renderPass) return
      /* THE SAME VERDICT IS LEFT ALONE, deliberately. DATA_SOURCE_EVENT says
         "the world may have changed", not what it changed to — and rebuilding
         this page is destructive: destroy() below closes any CLI session this
         page started. A desktop host announcing a sign-in still resolves
         'local', and tearing down a person's running session because an event
         fired about something else would be the repaint costing more than the
         fact it repaints. When the verdict genuinely flips (example toggled,
         relay signed in or out), the rebuild below is the point. */
      if (source === shownSource) return
      /* The badge follows the SOURCE, before any content does: mock is badged,
         real — local and relay alike — never is (sourceIsBadged, the one rule,
         defined once in data-source.js). */
      root.dataset.liveMode = sourceIsBadged(source) ? 'simulated' : 'live'
      /* A world flip closes the old world first. The outgoing page may own a
         running CLI session; its destroy() is what shuts that down, and it has
         to run before the loading state detaches its controls from the screen
         — a session with nothing on screen that can stop it is the exact
         defect destroy() documents. */
      if (current) {
        current.destroy()
        current = null
      }
      showState('Opening this agent', readerMachine(
        'reading what this computer has on record…',
        'reading what the computer you are driving has on record…',
        source === 'relay',
      ), true)
      /* Read together, because they paint together: a roster that drew and
         then grew an account row a moment later would move under the reader. */
      const [{ ok, reason, projection }, sessionAccounts] = await Promise.all([
        loadProjection(source),
        readSessionAccounts(source),
      ])
      if (destroyed || pass !== renderPass) return
      shownSource = source
      if (!projection) {
        showState(
          ok ? 'This agent is not on record here' : 'This agent’s record could not be read',
          ok ? readerMachine(
            `no agent on this computer’s record matches ${args.agentId}`,
            `no agent in the record on the computer you are driving matches ${args.agentId}`,
            source === 'relay',
          ) : reason,
        )
        return
      }
      current = buildAgentView(args, projection, source, sessionAccounts)
      root.replaceChildren(current.el)
    } catch (error) {
      if (destroyed || pass !== renderPass) return
      shownSource = null
      showState('This agent’s record could not be read', error?.message || String(error))
    }
  }
  void render()

  /* Re-resolve when a host announces the world changed — sign-in, sign-out,
     the example toggle. The event carries no verdict on purpose (see
     data-source.js), so the render re-asks rather than trusting a payload. */
  const onSourceChange = () => { void render() }
  window.addEventListener(DATA_SOURCE_EVENT, onSourceChange)

  return {
    el: root,
    destroy() {
      destroyed = true
      window.removeEventListener(DATA_SOURCE_EVENT, onSourceChange)
      current?.destroy()
    },
  }
}

function buildAgentView({ agentId, navigate }, projection, source, sessionAccounts = { ok: true, byAgent: new Map() }) {
  /* `live` IS THE SOURCE AXIS, NOT THE PROJECTION'S PRESENCE. Every render now
     arrives with a projection — the mock source builds one through the same
     adapter — so "is there a projection" stopped being a fact that separates
     anything. What still genuinely differs is whether the record is somebody's
     real machine ('local', 'relay') or the product's own example ('mock'), and
     that one bit drives everything downstream that used to key on the old
     simulated render: the badge, the write fences, and which rail this page
     shows. Real data is never badged; the example always is. */
  const live = !sourceIsBadged(source)
  const { computer, agent } = projection
  const role = roleAppearance(agent.declaredRole || agent.role)
  const sessionState = projection.sessionState
  /* The record's own words for both sources. The example used to print
     "Simulated / No declared state" here, which is no longer true of it: the
     mock is a declared record like any other, and the provenance banner above
     — not this tile — is what says whose record it is. */
  const declaredState = agent.state === 'active' ? 'Enabled' : 'Disabled'
  const declaredStateNote = 'Declared state'

  const root = el(`
    <div class="agentv" data-live-mode="${live ? 'live' : 'simulated'}">
      <div class="agentv-top">
        <div class="graph-crumb"></div>
        <div class="agent-provenance" role="status"></div>
      </div>
      <div class="agentv-roster glass"></div>
      <div class="agent-strip">
        <span class="as-name">${agent.name}</span>
        <span class="as-sep">·</span><span>${role.label}</span>
        <span class="as-sep">·</span><span>${agent.pool}</span>
        <span class="as-sep">·</span><span>${agent.model}</span>
      </div>
      <div class="agentv-panels-wrap">
        <div class="agentv-panels">
          <section class="apanel glass chat-panel"><div class="apanel-title">Chat</div></section>
          <div class="agentv-panels-resize" role="separator" aria-orientation="vertical" aria-label="Resize Chat and Controls" tabindex="0"></div>
          <section class="apanel glass ctl-panel">
            <div class="apanel-title">Controls</div>
            <div class="rail-scroll">
              <p class="ctl-absent">Nothing on this page can be tuned.</p>
              <p class="ctl-absent">These are example agents, and none of them is running.</p>
              <p class="ctl-absent">Your own agent's page lists what it is set to, read from this computer.</p>
              <div class="agent-ring-wrap"></div>
            </div>
            <div class="ctl-grid ctl-actions">
              <div class="ctl-btn ctl-declared-state" data-control="declared-state" aria-label="Declared state: ${declaredState}">
                <span class="ctl-label">${declaredState}</span><span class="ctl-note">${declaredStateNote}</span>
              </div>
              <!-- THESE TWO LABELS WERE LEFT BEHIND BY A REPAIR. They read
                   "Pause unavailable: no bridge action exists" -- a mechanism
                   name, and no longer true: both controls steer a session this
                   app owns, and src/agent-session-controls.js decides whether
                   they may. Both attributes are rewritten on the first paint by
                   renderSessionControl(), so what is here is what a screen
                   reader would meet in the instant before that, and it should
                   say the same thing. -->
              <button type="button" class="ctl-btn" data-control="pause" disabled aria-label="Pause. Checking whether there is anything running to stop.">
                <span class="ctl-label">Pause</span><span class="ctl-note">Checking…</span>
              </button>
              <button type="button" class="ctl-btn" data-control="respawn" disabled aria-label="Respawn. Checking whether a session is running for this agent.">
                <span class="ctl-label">Respawn</span><span class="ctl-note">Checking…</span>
              </button>
              <button type="button" class="ctl-btn danger" data-control="terminate" disabled>
                <span class="ctl-label">Terminate</span><span class="ctl-note">Checking…</span>
              </button>
            </div>
            <div class="ctl-result" data-phase="unavailable" role="status" aria-live="polite"></div>
          </section>
        </div>
      </div>
    </div>
  `)

  /* WHOSE DATA THIS IS, SAID IN NORMAL FLOW AND BEFORE ANYTHING ELSE.
   *
   * Everything on this page is an example whenever the source is 'mock', and
   * before this banner existed the page said so in exactly one place: a 48px
   * tile in the Controls action row reading "Simulated / No declared state",
   * four columns along and below the fold at two of the three shipping window
   * sizes. The only prominent notice was the app-wide `.fleet-profile-notice`,
   * which is `position: fixed; bottom right; z-index: 190` -- a toast that lands
   * on top of whatever is beneath it (on this page, the Controls panel and the
   * graph's own zoom readout), and which is keyed to the FLEET PROFILE being
   * unconfigured rather than to this view's data being fake, so it is both
   * overlapping and answering a different question.
   *
   * This banner is a normal-flow sibling above the roster. It cannot overlap
   * anything because it participates in layout, and it states this view's own
   * provenance rather than the profile's. The fixed toast is suppressed on this
   * route in agent.css, because two notices that disagree about what is real is
   * worse than either alone.
   *
   * KEYED TO THE SOURCE AXIS, which is the badge rule stated once in
   * data-source.js: mock is badged, real data — local and relay alike — never
   * is. data-kind is the machine-readable half the fence suite
   * (tools/example-page-write-fence-qa.mjs) reads, precisely so a copy pass on
   * the sentence cannot silently change which banner a page is wearing. */
  const provenance = root.querySelector('.agent-provenance')
  if (live) {
    provenance.dataset.kind = 'declared'
    provenance.textContent = readerMachine(
      'Read from the team record saved on this computer.',
      'Read from the team record saved on the computer you are driving.',
      source === 'relay',
    )
  } else {
    provenance.dataset.kind = 'example'
    provenance.textContent = 'Example data. These are not your agents — nothing here is running, and no control on this page reaches a real session.'
  }

  /* `live` IS PASSED, AND IT IS THE SAME `live` THE BANNER ABOVE IS COMPUTED
     FROM. Both surfaces below mount real controls -- one starts a CLI child
     process on this machine, the other dispatches an audited lane -- and both
     used to be mounted here with only `{ agentId }`, so the provenance this
     function had already worked out four lines earlier was dropped on the way
     in. That is how the page came to print "no control on this page reaches a
     real session" directly above an enabled Start that reached one.
     The Terminate control immediately below has taken `live` since it was
     written; these two were the outliers, not the precedent. */
  const destroyWriteSurface = mountAgentWriteSurface(root, { agentId, live })
  let pageImageComposer = null
  let agentSessionController = null
  const imageOutboxListeners = new Set()
  let unsubscribeImageOutbox = null
  const bindImageController = controller => {
    unsubscribeImageOutbox?.()
    unsubscribeImageOutbox = null
    agentSessionController = controller
    if (controller?.imageOutbox) {
      unsubscribeImageOutbox = controller.imageOutbox.subscribe(view => {
        for (const listener of imageOutboxListeners) listener(view)
      })
    } else {
      for (const listener of imageOutboxListeners) {
        listener({ state: 'held', code: 'AGENT_SESSION_NOT_READY', entries: [] })
      }
    }
  }
  let chatSessionId = null
  let chatReply = null
  let chatFail = null
  let chatTurnText = ''
  let chatThinkingActions = createActionBuffer()
  function paintChatThinking(packet) {
    const activity = sessionActivityEvent(packet, chatSessionId)
    if (activity?.kind !== 'thinking') return false
    const filed = chatThinkingActions.add(activity, { turnId: packet.event.turnId, at: Date.now() })
    if (filed.row) chat.addAction?.(sessionActionChatRow(filed.row))
    return true
  }
  function settleChatThinking() {
    for (const row of chatThinkingActions.settleUnfinished()) chat.addAction?.(sessionActionChatRow(row))
    chatThinkingActions = createActionBuffer()
  }
  const chatTextReader = createSessionTextReader()
  /* WHAT THIS AGENT HAS ALREADY SAID, so opening its page shows the
   * conversation instead of a blank sheet.
   *
   * The owner named resume; Worker 82 found this page empty for an agent with
   * a full conversation. mountAgentSessionSurface starts its transcript empty
   * and only ever fills it from live deltas, so the tree chat and the rail --
   * which keep a retained mount -- still hold every line while this page,
   * built fresh each visit, had nothing to draw until the next delta.
   *
   * NOT THROUGH THE LIVE-SESSION REGISTRY, and that is worth writing down
   * because it is the obvious route and it is closed on purpose:
   * agent-session-registry.js keeps only { pause, respawn, terminate } off a
   * published control and freezes it, so the owning surface's snapshot is not
   * reachable from there. Widening it to carry a transcript would widen the
   * one object three destructive controls read.
   *
   * session-roles.js is the reader the product already uses for this -- the
   * home activity list and the metrics join both go through it -- and it
   * resolves the saved conversation itself. A row's `turns` are already
   * buildChat's history shape. It never throws and never partially answers, so
   * a damaged or absent record costs this page its history and nothing else. */
  let resumedConversation = null
  try { resumedConversation = savedConversationFor(agentId, readSessionRoles(undefined, { transcripts: true })) } catch { resumedConversation = null }
  /* THE STORED CONVERSATION ARRIVES LATE, so the surface is mounted twice at
     most: once now, so the page is never blank while the main process is
     asked, and once more with the history if there is any. A remount is cheap
     and loses nothing HERE specifically -- this page carries no composer and
     no draft, and it does not own the session -- which is why the same trick
     would be wrong on the tree chat and is not done there.
     Guarded three ways: the page may already be gone, the read may answer
     nothing, and a second answer must not remount a third time. */
  let agentSessionMount = null
  let resumeApplied = false
  const mountSession = history => mountAgentSessionSurface(root, {
    /* `seed: 0` rides with it: buildChat's seeded demonstration conversation
       is drawn only over an EMPTY history, and a page that has real lines must
       never show invented ones beside them. */
    ...(history ? { hostChat: { history, seed: 0 } } : {}),
    agentId,
    live,
    roleBinding: projection.roleBinding || null,
    requireRoleBinding: true,
    onController: bindImageController,
    getImageComposer: () => pageImageComposer,
    onSessionOpen: (sessionId) => { chatSessionId = sessionId },
    onSessionEnd: ({ sessionId, code }) => {
      if (chatSessionId !== sessionId) return
      chatSessionId = null
      chatTurnText = ''
      settleChatThinking()
      chatTextReader.clear()
      const fail = chatFail
      chatReply = null
      chatFail = null
      if (typeof fail === 'function') {
        const error = Object.assign(new Error(code), { code })
        fail(startRefusal(error, 'That session ended before the agent answered.'))
      }
    },
  })
  agentSessionMount = mountSession(resumedConversation)
  const destroyAgentSession = () => { const release = agentSessionMount; agentSessionMount = null; release?.() }
  void (async () => {
    const stored = await storedConversationFor(agentId, globalThis.window?.mcTranscripts || null,
      computerIdsWithRecords(globalThis.window?.localStorage || null))
    if (!stored || resumeApplied || !agentSessionMount || !root.isConnected) return
    if (agentSessionController?.snapshot().sessionId) return
    resumeApplied = true
    agentSessionMount()
    agentSessionMount = mountSession(stored)
  })()
  /* Codex Cloud, beside the local session rather than on a page of its own: the
     two are the same act -- start an agent -- differing only in which computer
     runs it. It takes the same `live` fence as the two above, for the strongest
     version of their reason: a launch from here starts real, billable work on a
     remote service that cannot be cancelled. */
  const destroyCloudTasks = mountCloudTaskSurface(root, { live })
  /* THE FILES AN AGENT LEFT BEHIND. Gated on the SAME `live` as the three
     surfaces above, and for the strictest version of their reason: this panel
     hands a real file on this computer to a real program. A page that has just
     said "no control here reaches a real session" must not carry one that
     reaches the person's own documents.

     The bridge is read through `window` rather than as a bare name, the
     convention this codebase keeps: a bare bridge name is indistinguishable
     from a typo. A page with no bridge gets `null`, which the panel renders as
     every control drawn, disabled, and one sentence saying why. */
  const destroyFilesPanel = live
    ? (() => {
        const filesMount = el('<div class="agent-files-mount"></div>')
        root.querySelector('.agent-strip')?.insertAdjacentElement('afterend', filesMount)
        const panel = mountAgentFilesPanel({
          container: filesMount,
          bridge: (typeof window !== 'undefined' && window.mcFiles) || null,
        })
        return () => { panel.destroy(); filesMount.remove() }
      })()
    : () => {}
  const terminateButton = root.querySelector('[data-control="terminate"]')
  const terminateLabel = terminateButton.querySelector('.ctl-label')
  const terminateNote = terminateButton.querySelector('.ctl-note')
  const terminateResult = root.querySelector('.ctl-result')
  /* Declared above the bridge controller because the controller publishes its
     first state during construction, and that first publish already has to know
     whether this page's controls belong to a session. */
  let sessionBusy = null
  let confirmStep = null
  let sessionOwnsControls = false
  let sessionResult = ''
  let destroyedView = false
  const renderTerminateState = (state) => {
    /* ONE OWNER OF THIS BUTTON AT A TIME. While a session this app owns is
       mapped to this agent, the bridge controller's state is still real and
       still correct about the remote projection -- it simply must not paint. A
       late publish from an in-flight bridge request writing over the session
       controls is exactly how a screen comes to show one state and perform
       another. */
    if (sessionOwnsControls) return
    terminateButton.disabled = !state.enabled
    terminateButton.dataset.phase = state.phase
    terminateButton.classList.toggle('is-confirming', state.phase === 'confirm')
    terminateButton.classList.toggle('is-pending', state.phase === 'pending')
    terminateButton.classList.toggle('is-success', state.phase === 'success')
    terminateLabel.textContent = state.label
    terminateNote.textContent = state.note
    const message = readerSentence(state.message)
    terminateButton.setAttribute('aria-label', `${state.label}. ${message}`)
    terminateResult.dataset.phase = state.phase
    terminateResult.textContent = message
  }
  const terminateController = createTerminateController({
    live,
    selectedAgentId: agent.id,
    controlTarget: live ? agent.controlTarget : null,
    onState: renderTerminateState,
  })
  const onTerminateClick = () => {
    if (sessionOwnsControls) return
    void terminateController.click()
  }
  terminateButton.addEventListener('click', onTerminateClick)

  /* ---------- steering a session this app owns ----------
   *
   * THE DEFECT: Pause, Respawn and Terminate reported that no observed control
   * target was mapped to this declared agent WHILE A SESSION WAS RUNNING, six
   * inches above them on this same page. Starting and watching an agent worked;
   * steering one did not. For a product whose selling point is orchestrating
   * fleets, that is a core feature failing.
   *
   * THE TWO KINDS OF TARGET, which were never distinguished. `controlTarget` is
   * a REMOTE observed run carried by the mission-bridge projection -- an agent
   * id, a run id and a PID on some machine -- and it is null on every local
   * install, so the bridge terminate above correctly refused. The session this
   * app started is the other kind entirely: a child process this window owns,
   * reachable through mcAgent with no bridge in the path. Neither half was
   * wrong; nothing joined the second one to the agent whose page started it.
   *
   * ONE ARBITER, and it is here. When this app owns a session for this agent
   * the three controls steer THAT, because it is the thing on this page that
   * genuinely is running. Otherwise the bridge terminate keeps the Terminate
   * button and its own refusals, byte for byte as before. Both are never live
   * at once: two controllers writing one button is how a screen ends up showing
   * one state and performing another. */
  const controlButtons = {
    pause: root.querySelector('[data-control="pause"]'),
    respawn: root.querySelector('[data-control="respawn"]'),
    terminate: terminateButton,
  }
  const renderSessionControl = (id, state, step) => {
    const button = controlButtons[id]
    const face = sessionControlFace(id, state, { step })
    button.disabled = !state.enabled
    button.dataset.phase = face.phase
    button.classList.toggle('is-confirming', face.phase === 'confirm')
    button.classList.toggle('is-pending', face.phase === 'pending')
    button.classList.remove('is-success')
    button.querySelector('.ctl-label').textContent = face.label
    button.querySelector('.ctl-note').textContent = face.note
    button.setAttribute('aria-label', `${face.label}. ${readerSentence(face.message)}`)
    return face
  }

  /* WHICH CONTROLLER OWNS THE PANEL WHEN NEITHER HAS ANYTHING RUNNING.
   *
   * MEASURED on the packaged window, and it is the reason this is not simply
   * `availability.mapped`. With no session and no remote run, the bridge
   * controller owned the result line and the only sentence a person saw was
   * "Terminate unavailable: no observed control target is mapped to this
   * declared agent" -- true, internal, and useless: it names a concept the
   * product has never shown them and gives them nothing to do. On every local
   * install `controlTarget` is null, so that was the sentence on the shipped
   * screen.
   *
   * So the bridge keeps the panel only when it actually has a remote observed
   * run to talk about. Otherwise the session controls hold it and say the thing
   * a person can act on: start a session here, and these will steer it. Nothing
   * is taken away -- when a projection does carry a control target, every
   * bridge refusal is shown exactly as before. */
  const bridgeHasTarget = () => Boolean(live && agent.controlTarget && typeof agent.controlTarget === 'object' && !Array.isArray(agent.controlTarget))

  let resultSessionId = null
  const renderSessionControls = () => {
    const session = live ? liveSessionFor(agent.id) : null
    /* The outcome of the last action survives the session it was about -- "Ended
       the session" must not be wiped by the same repaint that observes the
       session ending -- but it must not outlive the NEXT one. */
    if (session && session.sessionId !== resultSessionId) {
      sessionResult = ''
      resultSessionId = null
    }
    const availability = sessionControlAvailability({ live, agentId: agent.id, session, busy: sessionBusy })
    const owns = availability.mapped || !bridgeHasTarget()
    /* HANDING THE TERMINATE BUTTON BACK is as important as taking it. A session
       that ends must return the button to the bridge controller's own state,
       not leave the last sentence this code wrote frozen on a control the
       bridge controller believes it owns. */
    if (sessionOwnsControls && !owns) {
      sessionOwnsControls = false
      confirmStep = null
      sessionResult = ''
      renderTerminateState(terminateController.getState())
    }
    if (!owns) {
      for (const id of ['pause', 'respawn']) renderSessionControl(id, availability[id], 'idle')
      /* The Terminate button and the result line stay with the bridge
         controller, which here has a real remote run to report on. One owner,
         so the two can never print disagreeing sentences. */
      return
    }
    sessionOwnsControls = true
    let message = readerSentence(availability.reason)
    for (const id of SESSION_CONTROL_IDS) {
      const step = sessionBusy === id ? 'pending' : (confirmStep === id ? 'confirm' : 'idle')
      const face = renderSessionControl(id, availability[id], step)
      if (step !== 'idle') message = readerSentence(face.message)
    }
    terminateResult.dataset.phase = sessionBusy ? 'pending' : 'ready'
    terminateResult.textContent = sessionResult || message
  }

  const runSessionControl = async (id) => {
    const session = live ? liveSessionFor(agent.id) : null
    const availability = sessionControlAvailability({ live, agentId: agent.id, session, busy: sessionBusy })
    if (!availability.mapped || !availability[id].enabled) return
    /* Confirm once for the two that destroy a running child. The first press
       posts nothing; that is the same contract the bridge terminate keeps, and
       it is checked against the availability again after the confirmation so a
       session that ended between the two presses cannot be acted on. */
    if (CONFIRMED_CONTROLS.includes(id) && confirmStep !== id) {
      confirmStep = id
      sessionResult = ''
      renderSessionControls()
      return
    }
    confirmStep = null
    sessionBusy = id
    sessionResult = ''
    renderSessionControls()
    let result
    try {
      result = await session.control[id]()
    } catch (error) {
      result = { ok: false, code: refusalCode(error) }
    }
    sessionBusy = null
    if (destroyedView) return
    /* WHAT A REFUSED PRESS SAYS, AND WHAT IT USED TO SAY.
     *
     * It used to say `${id} did not happen · ${result?.code}` -- the control's
     * internal id, then the bare machine code, and nothing else. On a screen
     * where a person has just pressed Terminate on a running agent, that is a
     * grep term where an answer belongs. tools/test/refusal-copy.test.mjs has
     * named this line as the last one of its kind in the product since B6
     * landed, and asserts that every code these three controls can answer with
     * already HAS a sentence in src/agent-availability-copy.js -- so the
     * sentences were written, sitting there, and this line never asked for one.
     *
     * Three parts now, in the order a person needs them: WHAT DID NOT HAPPEN,
     * in the control's own words rather than its id; WHY, looked up; and the
     * remedy, which unavailableReason() guarantees for a code nobody wrote an
     * entry for as well as for one that has one. The code is not shown; it is
     * still on `result.code` for a support conversation. */
    const outcome = {
      pause: 'Stopped the turn that was running. The session is still open.',
      respawn: 'Ended that session and started a new one for this agent, with the same prompt.',
      terminate: readerMachine(
        'Ended the session. The program it was running on this computer is closed.',
        'Ended the session. The program it was running on the computer you are driving is closed.',
        source === 'relay',
      ),
    }
    const notDone = {
      pause: 'The work was not stopped.',
      respawn: 'No new session was started.',
      terminate: 'The session was not ended.',
    }
    /* The table's sentences are written as fragments and a few of them already
       end in a full stop -- the unknown-code fallback appends a whole remedy
       sentence. Punctuating unconditionally produced "..", so it is repaired
       here rather than by rewording the table this file does not own. */
    const why = readerSentence(unavailableReason(result?.code || 'AGENT_SESSION_FAILED').trim())
    sessionResult = result?.ok
      ? outcome[id]
      : `${notDone[id]} Why: ${/[.!?…]$/.test(why) ? why : `${why}.`}`
    /* Read AFTER the action, not before it: respawn's answer is about the
       session that now exists, and terminate's is about no session at all. */
    resultSessionId = (live ? liveSessionFor(agent.id) : null)?.sessionId ?? null
    renderSessionControls()
  }

  const sessionClickHandlers = new Map()
  for (const id of SESSION_CONTROL_IDS) {
    const handler = () => {
      /* The bridge terminate keeps its own click while it owns the button. */
      if (id === 'terminate' && !sessionOwnsControls) return
      void runSessionControl(id)
    }
    sessionClickHandlers.set(id, handler)
    controlButtons[id].addEventListener('click', handler)
  }
  /* Both surfaces that make a claim about the session are repainted from the one
     event, so they cannot fall out of step with each other. The chat panel is
     built further down this function; the listener only ever fires after the
     mount has finished, and the synchronous first paint below is a direct call
     that does not touch it. */
  const unsubscribeSession = onLiveSession(() => {
    renderSessionControls()
    syncChatProvenance()
  })
  renderSessionControls()
  let runtimeRingMount = root.querySelector('.agent-ring-wrap')

  if (live) {
    root.classList.add('data-live-mode')
    root.dataset.liveMode = 'live'
    /* THE SAME FOUR FACTS, ONCE.
     *
     * Live, this strip printed `Controller · controller · none · enabled` three
     * lines under a roster card that had already printed the same agent's name,
     * the same role, and `On record · enabled · none` — the identical record,
     * twice, in two different word orders. The owner's word for the page was
     * "messy" (R1528) and this was the clearest instance of it.
     *
     * THE CARD IS THE SURFACE THAT SURVIVES, because it carries what the strip
     * cannot: the role dial, the runtime row, the activity line, and the
     * selection mark that says which agent the route opened. The strip carries
     * one thing the card does not, and it is not a fact — it is the ANCHOR the
     * three write surfaces below are inserted after (write-surfaces.js,
     * agent-session.js, cloud-tasks.js all mount `afterend` of it). So it stays
     * in the DOM, empty, and renders nothing.
     *
     * THE EXAMPLE PAGE KEEPS ITS STRIP, and that is not an oversight: on the
     * mock source the strip reads `name · role · pool · model`, and `pool` and
     * `model` appear nowhere on that page's cards. Duplication is what is being
     * removed, not the strip. */
    const strip = root.querySelector('.agent-strip')
    strip.replaceChildren()
    strip.hidden = true

    const rail = root.querySelector('.ctl-panel .rail-scroll')
    rail.replaceChildren()
    rail.appendChild(el('<div class="rail-sec">On record</div>'))
    const rows = [
      ['Recorded state', agent.state === 'active' ? 'enabled' : 'disabled'],
      ['Provider', agent.model],
      ['Relationships', `${projection.relationshipCount} recorded`],
      ['Running sessions', sessionState === 'unavailable' ? 'could not be read' : 'not matched by name'],
    ]
    for (const [label, value] of rows) {
      const row = el('<div class="ctl-row"><span class="cl"></span><span class="cv"></span></div>')
      row.querySelector('.cl').textContent = label
      row.querySelector('.cv').textContent = value
      if (label === 'Running sessions') {
        row.classList.add('projection-state')
        if (sessionState === 'unavailable') row.classList.add('projection-unavailable')
      }
      rail.appendChild(row)
    }
    runtimeRingMount = el('<div class="agent-ring-wrap"></div>')
    if (!appendAgentRingNode(rail, runtimeRingMount)) runtimeRingMount = null
  }

  /* ---------- the roster ----------
   *
   * The selected agent first, then the rest of this computer's agents. The
   * selected one leads rather than being highlighted in place because the reader
   * arrived here by naming it, and a page that opens on the thing you asked for
   * needs no legend explaining which card is yours. */
  const rosterMount = root.querySelector('.agentv-roster')
  const ordered = [
    agent,
    ...computer.agents.filter(candidate => candidate.id !== agent.id),
  ]
  const roster = buildAgentRoster({
    agents: ordered,
    example: !live,
    selectedId: agent.id,
    /* T302: the #/agent drill-in is retired -- route-parse.js no longer
       resolves this address, so navigating to another roster card would
       silently bounce to Home. No-op rather than a dead link. */
    onSelect: () => {},
    /* WHICH SIGN-IN EACH RUNNING AGENT IS SPENDING. A card with no entry draws
       no account row: most agents are not running, and a computer with one
       sign-in has no account question to answer. */
    accounts: sessionAccounts?.byAgent || null,
  })
  const rosterHead = el(`<div class="ar-head-row"><span class="ar-title">Agents on ${computer.name}</span><span class="ar-count"></span></div>`)
  rosterHead.querySelector('.ar-count').textContent = roster.count === 1 ? '1 agent' : `${roster.count} agents`
  /* THE ONE CAVEAT, SAID ONCE. "This computer could not be asked which accounts
     its agents are on" is a fact about the computer, not about any agent on it,
     so it belongs above the roster and not repeated on every card -- twenty
     copies of one sentence is not twenty times as honest. Said only when the
     read genuinely failed; a computer with nothing running says nothing. */
  /* STILL EXACTLY ONE LINE, and which one depends on how far the read got. A
     shell that could not be asked has no accounts to report on, so its sentence
     is the only one that can be true; a shell that answered but whose build
     could not work out what is spent says THAT, in the shell's own words rather
     than a second copy of them free to drift. And a computer with nothing
     running is told neither: there is nothing the caveat would be about. */
  const accountsNote = sessionAccounts && sessionAccounts.ok === false
    ? 'which account each agent is on could not be read'
    : (sessionAccounts?.reportReason && sessionAccounts.byAgent?.size ? sessionAccounts.reportReason : null)
  if (accountsNote) {
    const note = el(`<span class="ar-accounts-note"></span>`)
    note.textContent = accountsNote
    rosterHead.appendChild(note)
  }
  rosterMount.append(rosterHead, roster.el)

  const crumb = root.querySelector('.graph-crumb')
  const back = el(`<button>← ${computer.name}</button>`)
  back.addEventListener('click', () => navigate('#/computers'))
  crumb.appendChild(back)
  crumb.appendChild(el(`<span class="sep">/</span>`))
  crumb.appendChild(el(`<span><b style="color:var(--ink-2)">${agent.name}</b></span>`))

  /* THE COMPOSER IS THE START CONTROL.
   *
   * There was no way to start an agent from this page. The chat box answered
   * ITSELF with canned replies, and its own note admitted "typing in it still
   * reaches nothing" -- so the most obvious affordance on the page named after
   * agents both looked like the way to begin and was incapable of beginning.
   * The only control wired to mcAgent.start() was RESPAWN, which by definition
   * can only restart a session that already exists. First-start had no home.
   *
   * A separate "Start" button beside a dead composer would have left the dead
   * composer. So the composer becomes the control: the first message starts a
   * session and carries the prompt, and every later message continues it. That
   * is the model a person already expects from a chat box, which is exactly why
   * the fake one misled.
   *
   * Only on a REAL source with a real bridge. On the mock source onSend stays
   * null and the composer stays a local draft -- the example page exists to
   * show what the product looks like, and turning its chat box into failing
   * send attempts would trade one lie for another.
   */
  /* WHAT A PERSON READS WHEN THE START OR THE SEND DOES NOT HAPPEN.
   *
   * CORRECTED, and the correction is the whole reason these sentences reach
   * anybody. This read `result.code` off a RESOLVED value and treated a refusal
   * as a return. This channel does not answer that way: every refusal on
   * mc-agent:start and mc-agent:send is a REJECTED invoke (shell/main.cjs
   * throws through agentIpcError), so `.ok === false` was never once true and
   * every sentence below was unreachable. What a person actually got was
   * buildChat's catch printing `error.message` -- and shell/main.cjs makes the
   * message BE the code on purpose, so the screen showed a bare machine
   * identifier. That is exactly the defect B6 repaired and the one
   * tools/test/refusal-copy.test.mjs exists to hold shut; neither suite could
   * see it, because the interpolation was of an Error's message rather than of
   * anything shaped like a code.
   *
   * So the code is RECOVERED rather than read. `error.code` does not survive
   * Electron's rebuild of a rejected call in this window, and the message is
   * the only thing that crosses -- a candidate is therefore accepted only when
   * it already keys one of these tables, so no text from the host can reach the
   * screen as itself. src/agent-availability-copy.js's refusalCode() does this
   * for the shared table and is used for the rest of the recovery.
   *
   * THE PAGE'S OWN FOUR ARE TRIED FIRST, deliberately: the shared entry for a
   * missing engine is a fragment with no next step in it, and a composer whose
   * refusal ends on a dead end is what the plain-language ratchet is for. A
   * sentence that lands in the shared table later makes deleting the row here
   * the whole of the change. */
  const START_REFUSAL_TEXT = Object.freeze({
    AGENT_ENGINE_UNAVAILABLE: 'This copy of the app cannot start agents: the agent engine is not part of this build. Reinstalling from a full download is what fixes it.',
    MC_AGENT_SESSION_LIMIT: 'Too many agent sessions are open already. Close one on this page, or on another agent, and send again.',
    BRIDGE_ALL_SEATS_BUSY: 'Every seat for this kind of agent is already running something. Wait for one to finish, or stop one, then send again.',
    BRIDGE_CLAUDE_UNAVAILABLE: 'The assistant program this agent runs on is not installed on this computer. Setup walks through installing it.',
  })
  /* Upper case, digits and underscores only, which no Windows path can be. */
  const CODE_SHAPED_TOKEN = /[A-Z][A-Z0-9_]{2,63}/g
  const startCode = (error) => {
    if (typeof error?.code === 'string' && error.code.length > 0) return error.code
    const message = typeof error?.message === 'string' ? error.message : ''
    for (const candidate of message.match(CODE_SHAPED_TOKEN) || []) {
      if (Object.hasOwn(START_REFUSAL_TEXT, candidate)) return candidate
    }
    return refusalCode(error)
  }
  const startRefusal = (error, lead) => {
    const code = startCode(error)
    const own = Object.hasOwn(START_REFUSAL_TEXT, code) ? readerSentence(START_REFUSAL_TEXT[code]) : null
    if (own) return `${lead} ${own}`
    /* Composed the way the steering controls above compose theirs, including
       the full stop the fragments in that table do not all carry. Wrapped
       before composing, same as they are: readerRemedy's twins are keyed to
       the raw fragment, not to a sentence with `lead` already glued in front
       of it. */
    const why = readerSentence(unavailableReason(code).trim())
    return `${lead} Why: ${/[.!?…]$/.test(why) ? why : `${why}.`}`
  }

  /* WHERE ONE MESSAGE ENDS INSIDE A TURN. The owner read "Said back: ...now.I
     couldn't" off the home card, and this accumulator had the same seam: words
     only ever arrive as deltas and were joined bare, which is right for the
     tokens of one message and wrong when an engine says two whole messages in
     one turn (answer, tool, answer). The engine marks the seam
     (sessionMessageBoundary); it is remembered here and spent on the NEXT
     word, so a break is only written between two pieces of text and never at
     the end of a turn -- the same rule, in the same shape, as the home row
     (src/views/home.js onAgentPacket) and the tree's ear (computers.js). */
  /* THE WORDS AN AGENT IS FILING AS A RULE, keyed by the call that carries
     them. The engine's result says WHICH rule was filed and by whom; only the
     call carried the person's words, so the two are paired by toolCallId --
     the join src/views/computers.js makes per session. This page has one
     session, so one map, bounded the same way: the oldest leave first. */
  const ruleCalls = new Map()
  const RULE_CALLS_MAX = 16
  const rememberRuleCall = (call) => {
    if (!call || !call.toolCallId) return
    ruleCalls.set(call.toolCallId, call.words)
    while (ruleCalls.size > RULE_CALLS_MAX) ruleCalls.delete(ruleCalls.keys().next().value)
  }
  const takeRuleCall = (toolCallId) => {
    if (!toolCallId || !ruleCalls.has(toolCallId)) return ''
    const words = ruleCalls.get(toolCallId)
    ruleCalls.delete(toolCallId)
    return words
  }
  const agentBridge = live && typeof window !== 'undefined' ? window.mcAgent : null
  const bridgeReady = typeof agentSessionController?.send === 'function'
    && typeof agentBridge?.onEvent === 'function'
  const composerReason = !live
    ? NO_SENDER_WIRED
    : (!isWriteEnabled(START_CONTROL_FLAG)
        ? startControlOffReason()
        : (!projection.roleBinding
            ? 'This agent\'s saved role and directions could not be read. Reload the page, then try again.'
            : (bridgeReady ? null : 'This installed copy cannot start or reach an agent from this box. Update the app, then try again.')))
  const composerControl = controlState({ enabled: bridgeReady && !composerReason, why: composerReason })
  /* ONE LISTENER FOR THIS MOUNT, DETACHED ON DISPOSE, AND IT READS THE SHAPE
   * THIS PRODUCT ACTUALLY EMITS.
   *
   * CORRECTED. This read `packet.text` and `packet.delta.text`. A live packet
   * is `{ sessionId, event: { type: 'assistant_text_delta', text } }` and
   * neither of those fields exists on it, so the test was false for every
   * packet and NO reply ever reached the screen -- a composer that took a
   * person's message, started a real agent, and then showed them nothing back.
   * sessionEventText()/sessionTurnStatus() are the readers the Controls panel
   * beside this one already uses; a second reading of the same stream is how
   * one of the two comes to be wrong without anybody noticing.
   *
   * A TURN IS ONE MESSAGE, NOT ONE PER TOKEN. The engine emits one delta per
   * token (see the appender note in src/agent-session.js), and this chat's
   * `reply` appends a NEW bubble per call -- so forwarding deltas straight
   * through would have written tens of thousands of one-word messages into the
   * transcript. The turn's text is accumulated here and handed over once, when
   * the engine says the turn is done. */
  const detachAgentEvents = composerControl.enabled
    ? agentBridge.onEvent(packet => {
      if (!chatSessionId) return
      /* A RULE THE AGENT FILED, SHOWN AS ITS OWN ROW -- the same row the tree
         chat draws (src/views/computers.js, beside its usage branch), from
         the same two readers. The call is remembered for the person's words;
         the result -- and only a result that says filed:true with a ledger
         id -- draws the row. This page paints no other tool rows, so without
         this an agent that filed a rule from here did so unseen, against the
         registry row's promise that the chat shows what was filed and where.
         Read AHEAD of the reply gate below on purpose: a filing rides a
         tool_result, which is neither words nor a completion, and the row
         belongs on the screen whether or not a reply is still pending. `chat`
         is built further down; this listener cannot run before it exists,
         because chatSessionId is only ever set from that chat's own onSend. */
      const ruleCall = sessionRuleFilingCall(packet, chatSessionId)
      if (ruleCall) rememberRuleCall(ruleCall)
      const filedRule = sessionFiledRule(packet, chatSessionId)
      if (filedRule) chat.addAction?.(filedRuleChatRow({ ...filedRule, words: takeRuleCall(filedRule.toolCallId) }, { at: Date.now() }))
      if (!chatReply) return
      // Summary events contain accumulated snapshots. The shared action
      // buffer refines one item; concatenating snapshots duplicates its text.
      if (paintChatThinking(packet)) return
      const speech = chatTextReader.read(packet, chatSessionId)
      if (speech?.text) {
        if (chatTurnText && speech.breakBefore) chatTurnText += '\n\n'
        chatTurnText += speech.text
        return
      }
      if (!sessionTurnStatus(packet, chatSessionId)) return
      const spoken = chatTurnText.trim()
      const answer = chatReply
      chatTurnText = ''
      chatTextReader.clear()
      chatReply = null
      chatFail = null
      settleChatThinking()
      /* WHEN THE ENGINE SAID WHY, SAY WHAT IT SAID. A failed turn carries the
         provider's own sentence on the completion event -- "You're out of
         usage credits", "The Claude program stopped before finishing the turn"
         -- and sessionTurnFailureText is the reader written for exactly that.
         Until this line, agent.js never called it (computers.js was its only
         caller), so out-of-credits, crashed and timed-out all reached the
         person as the generic sentence below and looked identical. Spoken text
         still wins: if the agent actually said something, that is the answer. */
      const failureSaid = sessionTurnFailureText(packet, chatSessionId)
      /* A turn that ends having said nothing is a real outcome and it has to be
         readable as one; silence in a chat window reads as a product that hung. */
      answer(spoken || failureSaid || 'The turn ended without a written reply. Check any tool activity above before sending it again.')
    })
    : null

  /* `attachments` is what src/components.js hands every sender when something
     rides the send -- the pending attachment objects themselves, each carrying
     the path the main process saved. It was not destructured here, so a picture
     the person pasted got a chip in the composer and then went nowhere: the
     paste half worked and the send half dropped it, which reads to the person
     as a message that took their image when it did not. */
  const startOrContinue = async (text, { reply, fail, attachments, note }) => {
    /* THE CONSENT SWITCH, WHICH THIS BOX USED TO IGNORE ENTIRELY.
     *
     * This composer starts real CLI child processes. Its only gate was
     * `canStart = live && window.mcAgent` -- whether an application was behind
     * the page, never whether the person had allowed agent sessions. Every
     * other start door in the product asks: computers.js at three separate
     * sites and the agent page's OWN session surface at agent-session.js:122.
     * So on a default install the panel six inches above this box rendered
     * "Running agents is switched off" and the box beneath it started an agent.
     *
     * IT IS READ AT PRESS TIME, NOT AT MOUNT, and that is the whole reason it
     * is here rather than folded into canStart. The flag can be turned on from
     * Settings, or from the one-press control on the panel above, while this
     * page is open; a gate evaluated when the composer was built would leave
     * the box refusing until the person navigated away and back, and would
     * equally keep it live after they switched it off. Asking the question at
     * the moment of the press is one clear path and needs no listener.
     *
     * The sentence is the shared one, so this box and the panel above it cannot
     * describe the same switch two ways. */
    if (!isWriteEnabled(START_CONTROL_FLAG)) {
      fail(startControlOffReason())
      return
    }
    /* ONE TURN AT A TIME, because there is one sink for the answer. A second
       message sent while the first is still running would take the sink with
       it, and the running turn's words would then arrive with nowhere to go --
       the engine refuses the overlap anyway, so refusing it here is the same
       answer without throwing the first turn's output away. */
    if (chatReply) {
      fail('That agent is still working on the message before this one. Wait for its answer, or stop the turn in the Controls panel beside this one.')
      return
    }
    chatReply = reply
    chatFail = fail
    chatTurnText = ''
    chatTextReader.clear()
    settleChatThinking()
    /* The session surface owns start, send, close and steering. This composer
       contributes only the person's words and the reply sink; it never keeps a
       second private child beside the session the Controls panel can see. */
    try {
      const mapped = liveSessionFor(agent.id)
      if (mapped?.sessionId) chatSessionId = mapped.sessionId
      /* THE SAME MAPPING PAGE 2 ALREADY DOES, and deliberately the same shape:
         src/views/computers.js treeCardSend maps its attachments to `{ path }`
         and hands them to the boundary as `images`. Only the path travels --
         the bytes are already on disk, saved by the main process at paste time,
         and the rest of the composer's record is the composer's business. The
         field is omitted entirely when nothing rides the send. */
      const images = Array.isArray(attachments) ? attachments.map(item => ({ path: item.path })) : null
      const sent = await agentSessionController.send(text, images && images.length ? { images } : {})
      if (!sent || sent.ok !== true || typeof sent.sessionId !== 'string' || !sent.sessionId) {
        chatReply = null
        chatFail = null
        const error = sent?.code ? Object.assign(new Error(sent.code), { code: sent.code }) : null
        fail(startRefusal(error, chatSessionId ? 'That message did not reach the agent.' : 'The agent did not start.'))
        return
      }
      chatSessionId = sent.sessionId
      /* THE PICTURE'S OWN OUTCOME, SAID ON THIS PAGE TOO. The seam carries
         `pictureNotSent` from the host (see src/agent-session.js); without this
         the Agent page took the person's picture, sent their words alone, and
         showed nothing -- the same silence the composer's own paste wiring was
         added to end. A note, because the send is not a failure. */
      if (typeof sent.pictureNotSent?.sentence === 'string' && sent.pictureNotSent.sentence) {
        (note || fail)(sent.pictureNotSent.sentence)
      }
    } catch (error) {
      chatReply = null
      chatFail = null
      /* The session may well be open and only the turn refused, so the two
         states get their own sentence rather than one that covers both badly. */
      fail(startRefusal(error, chatSessionId ? 'That message did not reach the agent.' : 'The agent did not start.'))
    }
  }

  // chat panel
  const chat = buildChat({
    title: agent.name,
    subtitle: `${role.label} · direct line`,
    roleKey: agent.role,
    /* No fabricated transcript on ANY source. The example page used to open on
       six invented messages nobody sent; mock data means the example FLEET, not
       an invented conversation, and a transcript is the one thing the mock
       record honestly does not have. */
    seed: 0,
    tall: true,
    onReady: composer => { pageImageComposer = composer },
    onSend: composerControl.enabled ? startOrContinue : null,
    imageOutbox: composerControl.enabled ? {
      subscribe: listener => {
        imageOutboxListeners.add(listener)
        if (agentSessionController) void agentSessionController.imageOutbox.refresh()
        else listener({ state: 'held', code: 'AGENT_SESSION_NOT_READY', entries: [] })
        return () => imageOutboxListeners.delete(listener)
      },
      refresh: () => agentSessionController?.imageOutbox.refresh(),
      cancel: (id, view) => agentSessionController?.imageOutbox.cancel(id, view),
    } : null,
    onImageIntent: composerControl.enabled ? (draft, onState) => {
      if (!isWriteEnabled(START_CONTROL_FLAG)) return { ok: false, code: 'AGENT_SESSION_NOT_READY' }
      return agentSessionController?.submitImageIntent(draft, onState)
        ?? { ok: false, code: 'AGENT_SESSION_NOT_READY' }
    } : null,
    composerReason: composerControl.why || null,
    /* CTRL+V, IMAGE TO THE AGENT -- ON THIS PAGE TOO. This composer sends and
       starts sessions like Page 2's does, but it was the only live one that
       passed no paste adapter, and components.js attaches its paste listener
       ONLY when the callback exists. So an image pasted here did nothing at
       all: no attachment, no note, no refusal. Silence is the outcome this
       product treats as a defect everywhere else.
       Gated on the bridge really carrying the method, the same way Page 2
       gates its own, so a build without it shows no half-working control. The
       session is read FRESH at paste time (liveSessionFor), because the
       composer may have started one since this config was built; with none
       yet, the person is told, in the sentence that already exists for it,
       rather than having the refusal come back from the boundary. Error codes
       stop here and become sentences -- the composer never shows an
       identifier. */
    ...(typeof agentBridge?.pasteAttachment === 'function'
      ? { onPasteAttachment: async (data, mime) => {
        if (typeof agentSessionController !== 'undefined' && agentSessionController?.pasteImage) {
          try { return await agentSessionController.pasteImage(data, mime) }
          catch (error) { return { ok: false, sentence: pasteRefusalSentence(error) } }
        }
        /* `||`, not `??`: an empty string is not a session either, and it
           must take the same "not started yet" answer rather than being sent
           to the boundary to be refused there. */
        const openSession = liveSessionFor(agent.id)?.sessionId || chatSessionId || null
        if (!openSession) return { ok: false, sentence: PALETTE_PANEL.whyNotStarted }
        try {
          return await agentBridge.pasteAttachment({ sessionId: openSession, data, mime })
        } catch (error) {
          return { ok: false, sentence: pasteRefusalSentence(error) }
        }
      } }
      : {}),
    /* TWO PANELS ON ONE SCREEN MUST NOT DISAGREE ABOUT WHETHER A SESSION EXISTS.
       This said "no observed session is mapped to this agent" unconditionally,
       which was true while nothing could be mapped. The moment the Controls
       panel beside it began steering a mapped session, the same screen carried
       both sentences at once -- and a reader resolves that contradiction
       themselves, which is the defect however it resolves.
       The live composer now reaches the session owned by the Controls surface,
       so its context states that fact and changes when that shared session opens
       or closes. The example remains a demonstration and keeps its record-only
       context. */
    context: () => (live
      ? (liveSessionFor(agent.id)
        ? 'live conversation with the session shown in Controls'
        : 'send a message to start this agent with its saved role and directions')
      : agent.context),
  })
  const chatProvenance = chat.querySelector('.chat-head .s')
  const syncChatProvenance = () => {
    if (!live) return
    chatProvenance.textContent = liveSessionFor(agent.id)
      ? 'live conversation · the same session shown in Controls'
      : `ready to start this agent · ${sessionState === 'unavailable' ? 'other running sessions could not be read' : 'no session is open yet'}`
  }
  syncChatProvenance()
  const chatPanel = root.querySelector('.chat-panel')
  chatPanel.appendChild(chat)

  /* CHAT AND CONTROLS, RESIZABLE (build the handle once, reuse it -- see
     src/views/computers.js for the rail's own use of the same module).
     Undragged this changes nothing: .agentv-panels keeps its 1.15fr/1fr
     split. A drag sets Chat's width as a fixed px on .agentv-panels itself,
     which wins over the class rule; Controls keeps `1fr` so it still takes
     whatever the window has left.

     THE DRAG FLOOR READS agent.css's OWN --agentv-chat-floor RATHER THAN
     REPEATING "520" HERE. A manual drag used to carry an unrelated `min:
     280` -- the grid's minmax(520px, 1.15fr) refused to actually shrink the
     column below 520px regardless, so a drag toward 280 looked live (the
     handle tracked the pointer) while the rendered width silently clamped
     240px higher than what the handle claimed. One number, read where the
     rule that enforces it already lives, cannot drift out of step with it
     the way two independent literals eventually would. */
  const agentvPanels = root.querySelector('.agentv-panels')
  const agentvResizeHandle = root.querySelector('.agentv-panels-resize')
  const disposeAgentvResize = (agentvPanels && agentvResizeHandle)
    ? attachResizeHandle(agentvResizeHandle, {
      axis: 'x',
      min: agentvChatFloorPx(getComputedStyle(agentvPanels)),
      max: 1400,
      storageKey: 'mc.agentv-panels.chat-w',
      /* offsetWidth, not a bounding rect: `apply` writes CSS px and a rect is
         in window px, which the Text size zoom scales apart from them (see
         src/resize-handle.js). The floor above is CSS px as well -- read from
         --agentv-chat-floor -- so all three numbers finally mean one thing. */
      getSize: () => chatPanel.offsetWidth,
      apply: (px) => {
        if (window.matchMedia('(max-width: 1000px)').matches) return
        agentvPanels.style.gridTemplateColumns = `${Math.round(px)}px auto 1fr`
      },
    })
    : () => {}

  // Controls ring.
  let ring = null
  let ringUpdates = false
  /* ONE CLOCK RULE FOR BOTH SOURCES. This used to skip the normalizer when the
     page was the old simulated render, on the grounds that the simulator's
     agents were always running — and feeding the mock record through the same
     projection exposed why that shortcut cannot survive: the example fleet has
     a seat that never started (no bornAt — a raw-epoch ring would show decades)
     and a lane that ran and stopped (a ring that kept counting would be a lying
     clock on the page whose banner promises honesty). liveAgentRuntimeSource is
     the record's own arbiter — no epochs, no ring; a finite stop freezes it —
     and it reads the projection, which every source now supplies. */
  const agentRuntime = liveAgentRuntimeSource(agent)
  if (agentRuntime) {
    /* The threshold and the two ring sizes below are CSS px; innerHeight is
       window px, and the Text size zoom separates them (src/text-size.js). A
       Large window of 1000px has 893 CSS px of room, which is the short-window
       case this check exists to catch -- undivided it read 1000 and asked for
       the tall ring. Unchanged at Default. */
    const smallRing = window.innerHeight / textZoom() < 960
    const ringEpoch = agentRuntime.running
      ? agentRuntime.bornAt
      : Date.now() - agentRuntime.elapsedMs
    ring = uptimeRing({ size: smallRing ? 132 : 180, epoch: ringEpoch, colors: [role.glowColor, role.color], caption: 'Runtime', showDays: false })
    if (smallRing) ring.el.classList.add('ctl-ring-sm')
    if (appendAgentRingNode(runtimeRingMount, ring.el)) ringUpdates = agentRuntime.running
    else ring = null
  }

  const ctlScroll = root.querySelector('.ctl-panel .rail-scroll')
  const syncScrollEnd = () => {
    const atEnd = ctlScroll.scrollTop + ctlScroll.clientHeight >= ctlScroll.scrollHeight - 2
    ctlScroll.classList.toggle('at-end', atEnd)
  }
  ctlScroll.addEventListener('scroll', syncScrollEnd, { passive: true })
  const ctlResize = new ResizeObserver(() => syncScrollEnd())
  ctlResize.observe(ctlScroll)
  /* THE THREE SLIDERS THAT USED TO BE PAINTED HERE ARE GONE.
   *
   * `Context budget 124k`, `Wake interval 20m`, `Verbosity low`. They had NO
   * listener at all: the only line in this file that touched them was a
   * `rangeFill` call that painted the coloured track behind the thumb. Dragging
   * one moved the thumb, left the readout on its hardcoded value, stored
   * nothing, sent nothing, and reported no failure because nothing had been
   * attempted.
   *
   * REMOVED RATHER THAN WIRED, and the choice is not close. There is no setting,
   * no stored value and no bridge action anywhere in this product for a
   * per-agent context budget, wake interval or verbosity -- wiring them would
   * mean inventing three features, which is a larger act than this repair and
   * nobody's to take here. The page 2 lane reached the same conclusion about the
   * SAME THREE CONTROLS and removed them: see the note at the head of
   * src/views/computers.js, src/board.css section 13, and the assertion by name
   * in tools/test/orchestration-controls.test.mjs, which this lane extends to
   * cover this file so re-adding one is a deliberate act with a failing test
   * attached.
   *
   * The owner's rule for the class: "dont lie like we cant control temperature".
   * A control that moves and changes nothing is worse than a missing control,
   * because a missing control can be asked for and a moving one is believed --
   * and this one sat on the page whose banner promises that no control on it
   * reaches a real session.
   *
   * `rangeFill` went with them, and its import. It is still used by
   * src/views/settings.js and src/quick-settings.js, where the sliders are real. */

  /* One second, not one frame.
   *
   * The old view ran a requestAnimationFrame loop for the whole life of the page
   * because the chip solver had to re-place boxes every frame as the physics
   * settled. Nothing on this page moves per frame any more: the smallest unit
   * either readout shows is the second, so a one-second interval writes every
   * value that can have changed and no value that cannot. The roster's update()
   * compares before it writes, so a settled page performs no DOM mutation at all
   * between ticks -- and the ring keeps its own ~12Hz sweep only while it is
   * genuinely running. */
  const tick = setInterval(() => {
    roster.update()
    if (ring && ringUpdates) ring.update()
  }, 1000)

  return {
    el: root,
    destroy() {
      destroyedView = true
      chatTextReader.clear()
      clearInterval(tick)
      disposeAgentvResize()
      /* Detach exactly this mount's agent-event listener. Every visit would
         otherwise leave another one attached to the channel, and a later
         session's words would arrive in several detached transcripts at once. */
      if (detachAgentEvents) detachAgentEvents()
      chatReply = null
      chatFail = null
      terminateButton.removeEventListener('click', onTerminateClick)
      terminateController.destroy()
      unsubscribeSession()
      for (const [id, handler] of sessionClickHandlers) controlButtons[id].removeEventListener('click', handler)
      destroyWriteSurface()
      /* Closes any open session. Navigating away from the page must not leave
         a CLI child running with nothing on screen that can stop it. */
      destroyAgentSession()
      /* Stops the cloud surface from publishing into a detached DOM. It does
         NOT stop a launched cloud task, and cannot: the provider has no cancel.
         Leaving the page is not a stop, which is why nothing here claims it. */
      destroyCloudTasks()
      /* Closes any open reading pane and detaches the panel's key handler from
         the document. A trap left attached would swallow Escape on every page
         after this one. */
      destroyFilesPanel()
      ctlResize.disconnect()
    },
  }
}
