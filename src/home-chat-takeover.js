/* THE HOME PAGE'S FULL-PAGE CHAT, and the list of what it can be pointed at.
 *
 * Owner, verbatim: "I want that coordinator chat window to be expandable to
 * the WHOLE page this time so an even bigger view; i want it to replicate the
 * page 2 chat surface when you open it up; and i want you to be able to switch
 * to any agent by a drop down list; but ONLY 1 view at a time" -- and then
 * "also trees so you can see specific trees or computers or everything. So;
 * most surfaces specified as options but not every subtree needs to be
 * included just the main trees".
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 * 1. ONE VIEW AT A TIME, enforced by construction rather than by care. The
 *    surface is mounted into a single host, and every subject change disposes
 *    the previous mount BEFORE the next one is built. There is no code path
 *    that can leave two mounted, which is the only way "only 1 view" survives
 *    the next person to edit this. Split screen was floated ("maybe a split
 *    screen but thats it for now") and is deliberately NOT built: a second
 *    pane would need a second disposal contract, and the owner named page 2 as
 *    the multi-agent view.
 *
 * 2. REPLICATE MEANS REUSE, NOT COPY. For an agent, this mounts the SAME
 *    mountAgentSessionSurface that page 2 and the agent page mount -- not a
 *    second transcript renderer that will drift from it. For every other
 *    subject the host page passes in its own transcript painter, so the home
 *    view keeps one renderer for its thread rather than growing a second.
 *    If this file ever starts drawing turns itself, that rule has been broken.
 *
 * 3. MAIN TREES ONLY. A fleet tree store holds trees and, inside them, nodes.
 *    The nodes are the subtrees the owner excluded, so the roster lists
 *    `snapshot().trees` and never `snapshot().nodes`. Stated here because the
 *    two collections are one keystroke apart.
 *
 * The subject roster and the scope test are pure functions, exported and
 * tested without a DOM: they are where the rules above are actually decided.
 */

import { mountAgentSessionSurface } from './agent-session.js'
import { buildChat, CHAT_COMPOSER_INPUT_SELECTOR } from './components.js'
import { createComposerDraftStore } from './home-chat-composer-draft.js'
import { ROLES } from './vocab.js'
import { readerRemedy } from './refusal-copy.js'
import { cloudCommandAction } from './cloud-command-actions.js'
import { PALETTE_PANEL } from './fleet-tree-copy.js'
import { LOOP_BOUNDS } from './agent-loops.js'

/* Every sentence a person can read here. Kept in one object for the same
   reason the rest of this app does it: a gate scans these, and a sentence
   written inline at its use site is the one that escapes review. */
export const TAKEOVER_COPY = Object.freeze({
  expandLabel: 'Full view',
  collapseLabel: 'Back to overview',
  title: 'Chat & activity',
  subtitle: 'Conversations and run history, in one place.',
  closeHint: 'Return to the overview · Esc',
  recentRuns: count => `${count} recent ${count === 1 ? 'run' : 'runs'}`,
  workingRuns: count => `${count} working now`,
  recordHint: 'Started is a recorded event. Working now is live activity.',
  collapseDetails: 'Collapse details',
  conversation: count => `Conversation details · ${count} ${count === 1 ? 'entry' : 'entries'}`,
  pickerLabel: 'View',
  everything: 'Everything',
  coordinator: ROLES.coordinator.label,
  /* Said on a LIVE fleet, where the box cannot be spoken to. It names what
     is true today and where the working chats are, rather than promising a
     coordinator conversation the product does not have. */
  coordinatorNotLive: 'The coordinator cannot be messaged yet. Open a computer to talk to an agent there.',
  computerGroup: 'Computers',
  treeGroup: 'Trees',
  agentGroup: 'Agents',
  noSubjects: 'Set up a computer to choose what this shows.',
})

export const SUBJECT_KINDS = Object.freeze(['everything', 'coordinator', 'computer', 'tree', 'agent'])

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** Keyboard stops in the full-page dialog. A closed details descendant can
 * retain client rects in Chromium but cannot receive focus. Its own summary
 * remains a stop; every other descendant must stay out of the wrap order. */
export function takeoverFocusStops(surface) {
  return [...surface.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
    .filter(node => {
      if (node.disabled || node.tabIndex < 0 || !node.getClientRects().length) return false
      if (node.checkVisibility?.({ visibilityProperty: true }) === false) return false
      for (let parent = node.parentNode; parent && parent !== surface; parent = parent.parentNode) {
        if (parent.tagName !== 'DETAILS' || parent.open) continue
        const summary = [...parent.children].find(child => child.tagName === 'SUMMARY')
        if (!summary?.contains(node)) return false
      }
      return true
    })
}

/**
 * The list a person picks from, in the order the owner named it: everything,
 * the coordinator, computers, main trees, then agents.
 *
 * `treesByComputer` maps a computer id to that computer's tree records --
 * `createFleetTreeStore(...).snapshot().trees`, never `.nodes`. A caller that
 * cannot open a store for a computer passes nothing for it, and that
 * computer simply contributes no trees; an unopenable store is not an empty
 * one, so it must never be recorded as "this computer has no trees".
 */
export function buildSubjectChoices({ machines = [], speakers = {}, treesByComputer = null, nodesByComputer = null, conversations = null } = {}) {
  const choices = [
    { id: 'everything', kind: 'everything', label: TAKEOVER_COPY.everything },
    { id: 'coordinator', kind: 'coordinator', label: TAKEOVER_COPY.coordinator },
  ]

  const machineList = Array.isArray(machines) ? machines : []
  for (const machine of machineList) {
    const id = text(machine?.id)
    if (!id) continue
    choices.push({
      id: `computer:${id}`,
      kind: 'computer',
      label: text(machine?.name) || text(machine?.label) || id,
      group: TAKEOVER_COPY.computerGroup,
      computerId: id,
    })
  }

  const trees = treesByComputer instanceof Map ? treesByComputer : new Map()
  for (const machine of machineList) {
    const computerId = text(machine?.id)
    if (!computerId) continue
    const records = trees.get(computerId)
    if (!Array.isArray(records)) continue
    for (const tree of records) {
      const treeId = text(tree?.id)
      if (!treeId) continue
      choices.push({
        id: `tree:${computerId}:${treeId}`,
        kind: 'tree',
        label: text(tree?.name) || text(tree?.label) || treeId,
        group: TAKEOVER_COPY.treeGroup,
        computerId,
        treeId,
      })
    }
  }

  for (const [agentId, speaker] of Object.entries(speakers || {})) {
    const id = text(agentId)
    if (!id) continue
    if (/(?:^|\s)is-(?:owner|act)(?:\s|$)/.test(speaker?.cls || '')) continue
    choices.push({
      id: `agent:${id}`,
      kind: 'agent',
      label: text(speaker?.name) || text(speaker?.label) || id,
      group: TAKEOVER_COPY.agentGroup,
      agentId: id,
    })
  }

  const seen = new Set()
  for (const [computerId, nodes] of nodesByComputer instanceof Map ? nodesByComputer : []) {
    const machine = machineList.find(machine => machine.id === computerId)
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!text(node?.id)) continue
      const id = `agent:${computerId}:${node.id}`
      if (seen.has(id)) continue
      seen.add(id)
      choices.push({
        id, kind: 'agent', agentId: node.id, computerId,
        label: `${text(node.displayName) || text(node.name) || ROLES[node.role]?.label || node.role} · ${text(machine?.name) || text(machine?.label) || computerId}`,
        name: text(node.displayName) || text(node.name) || '', role: text(node.role) || '',
        group: TAKEOVER_COPY.agentGroup, treeNode: true,
      })
    }
  }
  for (const saved of conversations instanceof Map ? conversations.values() : []) {
    if (!text(saved?.nodeId) || !text(saved?.computerId)) continue
    const id = `agent:${saved.computerId}:${saved.nodeId}`
    if (seen.has(id)) continue
    seen.add(id)
    const machine = machineList.find(machine => machine.id === saved.computerId)
    choices.push({
      id, kind: 'agent', agentId: saved.nodeId, computerId: saved.computerId,
      label: `${text(saved.displayName) || text(saved.role) || saved.nodeId} · ${text(machine?.name) || text(machine?.label) || saved.computerId}`,
      name: text(saved.displayName) || '', role: text(saved.role) || '',
      group: 'Agents with saved conversations', savedConversation: true,
    })
  }
  return choices
}

/** The subject a takeover opens on, and the one it falls back to. */
export function defaultSubjectId(choices = []) {
  const list = Array.isArray(choices) ? choices : []
  const coordinator = list.find((choice) => choice?.kind === 'coordinator')
  return text(coordinator?.id) || text(list[0]?.id) || 'everything'
}

/**
 * Does this turn belong in this subject's view?
 *
 * `everything` and `coordinator` are the two whole-thread scopes and take
 * every turn -- the coordinator thread IS the home thread, so narrowing it
 * here would hide turns the unexpanded panel shows, and the expanded view
 * must never show LESS than the panel it grew out of.
 */
export function subjectMatchesTurn(subject, turn) {
  if (!subject || typeof subject !== 'object') return true
  if (subject.kind === 'everything' || subject.kind === 'coordinator') return true
  if (!turn || typeof turn !== 'object') return false
  if (subject.kind === 'agent') return [turn.agentId, turn.speaker, turn.sender, turn.who].some(id => text(id) === subject.agentId)
  if (subject.kind === 'computer') return text(turn.computerId) === subject.computerId
  if (subject.kind === 'tree') return text(turn.treeId) === subject.treeId && (!subject.computerId || text(turn.computerId) === subject.computerId)
  return false
}

/** Scope run history by saved identity, never by a matching display label. */
export function subjectMatchesRun(subject, run, saved) {
  if (!subject || subject.kind === 'everything' || subject.kind === 'coordinator') return true
  if (subject.kind === 'agent') {
    return (!subject.computerId || saved?.computerId === subject.computerId)
      && [saved?.nodeId, saved?.agentId, run?.agentId].includes(subject.agentId)
  }
  return subjectMatchesTurn(subject, {
    computerId: saved?.computerId || run?.computerId,
    treeId: saved?.treeId || run?.treeId,
  })
}

/**
 * Mount the full-page surface into `host`.
 *
 * `renderTranscript(host, subject)` is the caller's own painter for every
 * non-agent subject and MUST return a disposer; the agent subject is mounted
 * from agent-session.js here so this page and page 2 cannot drift apart.
 *
 * Returns a disposer that leaves nothing mounted.
 */
/* WHAT THE COORDINATOR CHAT IS HANDED, as a pure decision a test can call.
 *
 * Extracted because the mount could not be tested honestly: this file has no
 * DOM, so a test could only observe THAT buildChat was reached, not WHAT it
 * was given -- and a mutation removing the live composerReason left such a
 * test green. A property nothing can fail on is not covered. */
/* THE HOME COORDINATOR'S CHIPS ROW (components.js:551's `${chips ? ...}`
 * gate) -- opened here so it can exist at all ("the home composer
 * structurally can't grow chips today" was true until this line), but
 * every accessor beyond the always-present SEND chip stays absent on
 * purpose, not by oversight. Mirrors treeChatConfigFor's shape
 * (src/views/computers.js) field for field; what differs is that every
 * field here has nothing real to read, because coordinatorChatConfig is
 * a PURE function of {live, label} with no session, no tier, no model
 * override and no outbox anywhere in scope -- and this file's own header
 * already establishes why: LIVE disables the whole composer (composerReason,
 * "there is no live coordinator sender anywhere in the product"); the
 * SIMULATION is a scripted, sessionless demonstration (sampleConversation).
 * Neither has a queue to drain, a turn to stop, or a tier/model to name.
 * SEND alone renders meaningfully -- it reuses buildChat's own send() and
 * already-computed cannotSend state, the same as the existing icon button,
 * never a second implementation. AGENT/EFFORT/model/HALT/QUEUE render
 * nothing rather than a dead control. A caller that threads real
 * confinement/session state through this function later could populate
 * tier/model honestly; inventing one now would be exactly the fabricated-
 * fact defect the chips contract forbids. */
const COORDINATOR_CHAT_CHIPS = Object.freeze({})

export function coordinatorChatConfig({ live = false, label = '' } = {}) {
  const base = { title: text(label) || ROLES.coordinator.label, roleKey: 'coordinator', tall: true, chips: COORDINATOR_CHAT_CHIPS }
  /* LIVE: the box is refused and says why. There is no live coordinator sender
     anywhere in the product, and composerReason is also what stops buildChat's
     seeded simulator answering on a real copy. seed 0 with an empty history,
     or it renders canned demonstration bubbles as if they were a conversation.
     SIMULATION: the one sanctioned self-answering path, which is the whole
     point of a labelled demonstration. */
  return live
    ? { ...base, seed: 0, history: [], composerReason: TAKEOVER_COPY.coordinatorNotLive }
    : { ...base, sampleConversation: true }
}

/* THE EXAMPLE AGENT'S CHAT IS THE ONE PAGE 2 DRAWS. Owner, 2026-09-19: "the
   chat surface still is not the same as the rest of the software" -- the
   Home panel used to give an example-fleet agent a coordinator-styled,
   self-answering buildChat of its own. This is src/views/computers.js
   exampleChatConfigFor, field for field: the example subtitle, the header
   meta with the node's status word, the role, the recorded history, seed 0
   and the example's own composer reason (the box is switched off and says
   why), so the two surfaces cannot differ. The composer's common rows
   (Cloud swarm, /goal, /loop) are page 2's commonChatActionsFor as the
   example shows them: the same rows, the same loop interval (the default,
   since an example node has no loop of its own), every one switched off with
   the example sentence -- exampleOnlyRows keeps only the copy rows enabled,
   and this chat has none. Owner, 2026-09-19: "ok well they need to have
   those." A live tree agent in this panel is page 2's own controller and
   carries its rows itself. */
export function exampleCommonRows(reason) {
  const why = typeof reason === 'function' ? reason() : reason
  const minutes = LOOP_BOUNDS.defaultIntervalMs / 60_000
  return [
    { ...cloudCommandAction({ enabled: false, disabledHint: why }) },
    { id: 'goal', group: PALETTE_PANEL.groupCommon, label: PALETTE_PANEL.goal, icon: 'goal', hint: PALETTE_PANEL.goalHint,
      enabled: false, disabledHint: why, run: ctx => ctx.compose('/goal ', PALETTE_PANEL.goalHint) },
    { id: 'loop', group: PALETTE_PANEL.groupCommon, label: PALETTE_PANEL.loop, icon: 'loop', minutes,
      hint: PALETTE_PANEL.loopHint, enabled: false, disabledHint: why, run: ctx => ctx.close() },
  ]
}
export const SAMPLE_CHAT_SUBTITLE = 'Example agent · simulated run'
const START_NEEDS_APP_SENTENCE = 'Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. Open ToolsEnabled on your computer to grow a real tree.'
export function exampleAgentChatConfig(subject = {}, { history = [], statusKey = '' } = {}) {
  const roleKey = text(subject.role) && ROLES[subject.role] ? subject.role : (ROLES.worker ? 'worker' : Object.keys(ROLES)[0])
  const name = text(subject.name) || text(subject.label).split(' · ')[0] || ROLES[roleKey]?.label || roleKey
  const reason = () => readerRemedy(START_NEEDS_APP_SENTENCE, { viaRelay: false })
  const key = text(statusKey)
  return {
    title: name,
    subtitle: SAMPLE_CHAT_SUBTITLE,
    headerMeta: { read: () => (key ? { status: { source: 'session-node-status', key } } : {}), subscribe: () => () => {} },
    roleKey,
    accentId: text(subject.agentId) || name,
    history: Array.isArray(history) ? history : [],
    seed: 0,
    composerReason: reason(),
    status: { busy: () => false, subtitle: () => SAMPLE_CHAT_SUBTITLE, subscribe: () => () => {}, composerReason: reason },
    actions: () => exampleCommonRows(reason),
    commonActions: () => exampleCommonRows(reason),
    actionsNote: PALETTE_PANEL.footer,
  }
}

export function mountChatTakeover(host, {
  choices = [],
  subjectId = null,
  live = false,
  sampleChats = false,
  sampleChat = null,
  renderTranscript = null,
  renderAgent = null,
  onSubjectChange = null,
  draftStore = createComposerDraftStore(),
} = {}) {
  if (!host) return () => {}
  let list = Array.isArray(choices) ? choices : []
  let current = null
  let release = null
  /* THE HELD DRAFT, ACROSS EVERY REBUILD THIS MOUNT EVER DOES (owner's
     report, 2026-09-07: "occassionally really annoying UI redraws...erase
     my typing"). One store per takeover mount, keyed by subject id --
     see src/home-chat-composer-draft.js for why and for the rule it
     borrows from composer-queue-recall.js. `composerInput` is the
     currently-mounted coordinator composer's own input element, or null
     when the current subject has none (every subject but the coordinator
     today) -- read from it right before the next teardown, never polled. */
  const drafts = draftStore
  let composerInput = null
  let composerChat = null
  const holdDraft = () => {
    if (!current || !composerInput) return
    if (composerChat?.exportDraft && drafts.writeDraft) drafts.writeDraft(current.id, composerChat.exportDraft())
    else drafts.write(current.id, composerInput.value)
  }

  /* THE ONLY PLACE A SURFACE IS BUILT, and it disposes before it builds. Two
     mounted surfaces is the failure this whole file is shaped to prevent, so
     there is exactly one path to a mount and it starts by tearing down. */
  const show = (nextId) => {
    if (current?.id === nextId) return
    /* THE BOX WINS. Whatever is in the composer the instant the subject
       changes becomes that subject's held draft -- BEFORE release() or
       replaceChildren() can take the element away with it. */
    holdDraft()
    composerInput = null
    composerChat = null
    release?.()
    release = null
    host.replaceChildren()
    const subject = list.find((choice) => choice?.id === nextId) || null
    current = subject
    if (!subject) return
    /* THE COORDINATOR SUBJECT MOUNTS THE REAL CHAT SURFACE, because there is
       exactly one and this page was not using it. buildChat (components.js) is
       the finished composer -- role icon, bubbles, queue, actions, stop -- and
       until now it was mounted ONLY by page 3, so on page 1 neither the surface
       nor its icons could appear at all, which the owner saw and asked about in
       as many words. The takeover's DEFAULT subject is the coordinator, so this
       is the first thing a visitor meets.

       ON THE SIMULATION it opens in the surface's own labelled demonstration
       mode -- sampleConversation is the one sanctioned self-answering path, and
       a demonstration is this page's whole job for a signed-out visitor.
       ON A LIVE FLEET it stays on the caller's painter for now: a live
       coordinator composer needs the real sender closures that live in the
       board view's session machinery, and a composer that swallowed words here
       would be worse than the feed. That wiring is owed and stated, not faked
       -- buildChat itself would disable the box and say why if mounted
       senderless, and a disabled default subject is a dead front door. */
    /* CORRECTED 2026-08-27, AND THE PREMISE UNDER THE OLD BRANCH WAS MINE AND
       WRONG.
       This branch used to take BOTH worlds. Its comment argued that since no
       live coordinator sender exists, the honest live surface is buildChat with
       an empty history and a disabled box saying so.
       Measured, that is not what the product does. On a configured fleet
       describeHome already answers panel.kind "conversation" with context -- the
       collapsed panel on page one IS a working coordinator surface. So the
       expand replaced a real conversation with an empty, disabled one carrying
       "The coordinator cannot be messaged yet."
       The door added to answer the owner's "there is no chat on the first page"
       opened onto that exact complaint. Two independent verifiers reproduced it,
       the second by driving the whole home view in the repo's own Electron and
       pressing the real button.
       A LIVE coordinator now falls through to renderTranscript -- the caller's
       own painter, which is paintSubject in views/home.js and MOVES the real
       panel, its turns and its audited composer into the stage, exactly as the
       `everything` subject already did. The simulation keeps buildChat, where a
       self-answering demonstration is the point. */
    if ((subject.kind === 'coordinator' || (sampleChats && subject.kind === 'agent')) && !live) {
      /* BOTH WORLDS GET THE REAL SURFACE. What differs is whether its box can
         be spoken to, and that is stated rather than implied.

         ON THE SIMULATION: sampleConversation, the one sanctioned
         self-answering path, which exists for exactly this -- a labelled
         demonstration.

         ON A LIVE FLEET: composerReason, and the reason is not a placeholder.
         MEASURED: there is no live coordinator sender anywhere in the product
         -- no bridge verb, no comms path, nothing on any view. The coordinator
         chat has never been live. So this is not wiring waiting to be
         connected; it is a feature that does not exist, and the honest surface
         for that is the one this codebase already uses for a chat with nothing
         behind it: the real log and the real controls, with the message box
         disabled and carrying the reason.

         WHY NOT THE FEED, which is what it used to fall back to: the feed
         looks like a chat and is not one, so a person types into nothing and
         learns nothing. And composerReason makes buildChat refuse `send`
         BEFORE its seeded simulator can be reached, so a live copy can never
         answer itself -- the defect two lanes found independently.

         seed 0 and an empty history: buildChat renders canned demonstration
         bubbles over an empty history otherwise, which on a live fleet would
         be an invented conversation. */
      const chat = buildChat(subject.kind === 'agent' ? exampleAgentChatConfig(subject, typeof sampleChat === 'function' ? sampleChat(subject) || {} : {}) : coordinatorChatConfig({ live, label: subject.label }))
      host.appendChild(chat)
      /* RESTORE THE HELD DRAFT (see drafts, above): buildChat's own composer
         is fresh DOM every time this branch runs, so whatever this subject
         was holding is written back into the box before anyone sees it
         empty. read() answers '' when there was nothing held, which is a
         harmless no-op assignment. composerInput is kept so the NEXT show()
         can read it back out before this element is torn down. */
      composerInput = chat.querySelector(CHAT_COMPOSER_INPUT_SELECTOR)
      composerChat = chat
      if (chat.importDraft && drafts.readDraft) chat.importDraft(drafts.readDraft(subject.id))
      else if (composerInput) composerInput.value = drafts.read(subject.id)
      release = () => { chat.dispose?.(); chat.remove() }
      return
    }
    if (subject.kind === 'agent') {
      if (live && (subject.treeNode || subject.savedConversation) && typeof renderAgent === 'function') {
        release = renderAgent(host, subject, drafts) || null
        return
      }
      /* ON THE SIMULATION, AN AGENT SUBJECT PAINTS THE FEED, NEVER NOTHING.
         mountAgentSessionSurface's live fence answers "render nothing at all"
         when live is false -- right for a write surface, and measured wrong
         here: the takeover's DEFAULT subject is an agent, so a simulation
         visitor opened the full page onto two empty panels. The owner saw
         exactly that. The caller's own painter is the same one every non-agent
         subject uses; it filters the activity feed to the subject, which on
         the simulation shows the example fleet's transcript -- a demonstration
         instead of a blank. */
      if (live && !subject.savedConversation) {
        release = mountAgentSessionSurface(host, { agentId: subject.agentId, live }) || null
        return
      }
      release = typeof renderTranscript === 'function' ? renderTranscript(host, subject) || null : null
      return
    }
    release = typeof renderTranscript === 'function' ? renderTranscript(host, subject) || null : null
  }

  show(text(subjectId) || defaultSubjectId(list))

  return {
    updateChoices(nextChoices) {
      list = Array.isArray(nextChoices) ? nextChoices : []
      const retained = list.find(choice => choice.id === current?.id)
      if (retained) current = retained
      else {
        show(defaultSubjectId(list))
        if (typeof onSubjectChange === 'function') onSubjectChange(current)
      }
    },
    show: (nextId) => {
      show(nextId)
      if (typeof onSubjectChange === 'function') onSubjectChange(current)
    },
    get subject() { return current },
    destroy: () => {
      holdDraft()
      release?.()
      release = null
      current = null
      // The home view retains the store so closing full view keeps its draft.
      composerInput = null
      composerChat = null
      host.replaceChildren()
    },
  }
}
