import { mountAgentSessionSurface } from './agent-session.js'
import { LAUNCH_TIERS, offeredEffort } from './orchestration-controls.js'
import { EFFORT_CHOICES, DEFAULT_TIER, MODEL_DEFAULT_EFFORT, PALETTE_PANEL, PROVIDER_WORDS, effortChoicesFor } from './fleet-tree-copy.js'
import { transcriptSeedText } from './session-transcript-store.js'
import { list as outboxList, moveSession as outboxMoveSession } from './session-outbox.js'
import { sessionTurnSucceeded } from './agent-session-events.js'

/* PROVIDER, THEN MODEL, AND THE WIRE STILL CARRIES ONE ROW (1.0.48, owner
   decision: every model a provider offers is selectable, chosen as
   provider first, then model). START_TIERS in shell/agent-host.cjs
   keys provider off the row, and startSession resolves `const sessionProvider =
   (startTier && startTier.provider) || …`, so a start carries a row id and
   nothing called "provider". The + pop-up's Provider menu (src/tree-workspace.js)
   is a filter over these rows, read off `row.provider`: it narrows the Model
   menu and is never stored or sent, so it cannot disagree with the row.

   EVERY ROW, treeOnly ONES INCLUDED (1.0.48). This list used to drop them, and
   the only reason it gave was the flag's name. In code `treeOnly` means one
   thing: the row has no engine dispatch row (DISPATCH_TIERS, engine actions.js
   TIERS, the agent.spawn enum). A + agent is not a dispatch. It starts through
   the same host start a tree agent does -- bridge.start with a row id, then
   resolveStartTier over START_TIERS, which carries every row and has no surface
   or treeOnly gate (nor has claimStandaloneReplacement). So the filter hid
   Gemini, Grok, GPT-6-Sol and GPT-6-Luna from the + agent while a tree agent
   ran them. The host's own rows still mark any row this computer cannot start,
   exactly as the start panel does.

   `fullLabel` is "<Model> · <Provider>", the chip's words: one word such as
   "Automatic" names nothing until it says whose. A row whose model word is its
   provider word ("Local") says it once. */
const SOLO_TIERS = Object.freeze(LAUNCH_TIERS.map(tier => {
  const providerLabel = PROVIDER_WORDS[tier.provider] || tier.provider
  return Object.freeze({
    id: tier.id, label: tier.label, provider: tier.provider, providerLabel,
    fullLabel: tier.label === providerLabel ? tier.label : `${tier.label} · ${providerLabel}`,
    effort: tier.effort ?? null,
  })
}))
const SOLO_TIER_IDS = new Set(SOLO_TIERS.map(tier => tier.id))
const SOLO_EFFORTS = Object.freeze(EFFORT_CHOICES.map(choice => choice.id))

/* THE EFFORT A ROW MEANS, and the fallback is not a number I picked. It is the
   default row of that model's own depth menu (effortChoicesFor, the one every
   surface reads): a row with its own depth (every Codex row) starts at it, and
   a row that states none (every Claude row) starts at "Model default" -- null
   here, so the start sends no effort and the model's served default applies.
   The compose panel gives a tree agent the same answer, parity rather than a
   second opinion. Until 1.0.48 both said `|| 'medium'`, which ran Sonnet 5 and
   Opus 5 one level below their served default of high (D4).

   Effort is NOT decorative for Claude: claude-cli-adapter.js validates it
   against low/medium/high/xhigh/max and passes `--effort <value>`. A person
   who picks one still gets exactly that.

   Reading the CURRENT select here instead is the defect found on
   screen: pick max on a Codex row, switch to Claude, and max was sent by
   someone who never chose it for Claude. */
const effortForTier = tierId => effortChoicesFor(tierId).find(choice => choice.isDefault)?.id || null
/* A picked depth, as the chosen row runs it: a depth that model does not offer
   falls back to the row's own default rather than reaching the launcher. */
const effortOnTier = (tierId, effort) => offeredEffort(tierId, effort) || effortForTier(tierId)

export const STANDALONE_SURFACE = 'standalone-agent'
/* Said in the conversation when the program is changed while a session is
   already open, because the running one keeps the row it started on. B30: the
   chooser says the same sentence (STANDALONE_TAB_CHOOSER_COPY.running is this
   with no label), so the two places cannot disagree; the old note also sent
   the person to open a new agent, which starts on whatever that pop-up picks. */
export const standaloneStartChangedSentence = label =>
  `The running session keeps its model. ${label || 'Your choice'} is used the next time this agent starts.`

/* Said on an Actions row that works on tree agents only, once this agent really is running. */
export const STANDALONE_TREE_ONLY_SENTENCE = 'This works on agents in a tree. Use Add to tree to get it.'

/* B23 (found by hand on 1.0.48 candidate 1). The Switch model row on a New agent tab opens the
   tab's own chooser, the one its model chip opens. A tab changes model the way the chip does: the
   choice is what it starts on next, and a running session keeps the model it started on. */
export const STANDALONE_MODEL_COPY = Object.freeze({
  hint: 'Opens the model menu. This agent starts on the model you choose.',
  runningHint: 'Opens the model menu. The running session keeps its model; your choice is used the next time this agent starts.',
  unavailable: 'Open a new agent with + to use another model.',
})

/* A TAB ADDED TO A TREE STAYS OPEN, but the tree owns the agent from then on (B21/B23 follow-up):
   the tab's own model choice is no longer what it starts on, and a child is started from the tree. */
export const STANDALONE_PLACED_COPY = Object.freeze({
  model: 'This agent is on a tree now. Select it on the tree to change its model.',
  child: 'This agent is on a tree now. Select it on the tree to start an agent under it.',
})

/* B4 (1.0.48, owner decision: reopen them). What a New agent tab says when it
   comes back after ToolsEnabled is closed and reopened, and what the page says
   when one cannot. Each failure says what happens next or what to do. */
export const STANDALONE_RESTORE_COPY = Object.freeze({
  /* The first line a reopened tab shows is put together per case by
     standaloneReopenedNote below: why it is back, and what a message does. */
  reopened: 'Reopened after ToolsEnabled restarted.',
  reopenedAfterReload: 'Reopened after the page reloaded.',
  stoppedOnReload: 'This agent was stopped when the page reloaded.',
  notRunning: 'This agent is not running.',
  continueConversation: 'Send a message to continue the conversation.',
  startAgent: 'Send a message to start this agent.',
  continueHere: 'Send a message to continue this conversation.',
  notSaved: 'This agent tab could not be saved, so it will not come back after a restart. Add it to a tree to keep it.',
  listUnreadable: 'Your agent tabs from last time could not be read, so they were not reopened. Use + to open a new agent.',
  conversationUnreadable: 'The earlier conversation could not be read. Send a message to start this agent without it.',
  seatRefused: 'This agent could not be set up again, so it cannot use computer control. Restart ToolsEnabled to try again.',
  programRetired: label => `The program this agent used is no longer offered. It will use ${label} unless you choose another.`,
  stillRunning: name => `${name} was not reopened because it is still running from before the reload. Restart ToolsEnabled to reopen it.`,
  closeNotSaved: name => `${name} could not be removed from your saved tabs, so it may come back after a restart. Close it again if it does.`,
  placedNotSaved: name => `${name} is in the tree now, but its tab could not be removed from your saved tabs. If the tab comes back after a restart, close it.`,
})

/* THE FIRST LINE OF A REOPENED TAB, TRUE FOR ITS CASE (B4 review). One fixed
   sentence said "after ToolsEnabled restarted ... continue the conversation"
   after a page reload, over a conversation that could not be read, and on a
   tab that never sent anything. `cause` is 'restart', 'reload', or 'stopped'
   (a reload that closed the session the old page left running). */
export function standaloneReopenedNote({ cause = 'restart', conversation = false, unreadable = false } = {}) {
  const copy = STANDALONE_RESTORE_COPY
  const why = cause === 'stopped' ? copy.stoppedOnReload : cause === 'reload' ? copy.reopenedAfterReload : copy.reopened
  // "Stopped" already says it is not running; a tab that never sent has nothing that stopped.
  const state = cause !== 'stopped' && (conversation || unreadable) ? copy.notRunning : ''
  // After an unreadable conversation the next note says what a message does.
  const next = unreadable ? '' : conversation ? copy.continueConversation : copy.startAgent
  return [why, state, next].filter(Boolean).join(' ')
}

/* THE ACTIONS MENU TELLS THE TRUTH ABOUT A STANDALONE AGENT (B8, found by hand on the installed
   1.0.46, 2026-09-25). The rows come from the tree's own builder, which reads the tree's session
   registry; a standalone tab is deliberately absent from it, so a running agent with three answered
   turns read "has not started yet", "nothing was asked", "not running", and Stop and Interrupt were
   off. The rows are corrected from the tab's own session:
   - Interrupt and Stop drive the tab's controller (the same pause/terminate the composer uses);
   - Copy what you asked / what it said read this conversation (the seat carries the words the tree's
     copy action reads);
   - a row that works on tree agents only says so, instead of claiming the agent never started.
   B4 (1.0.48): a tab reopened after a restart has a saved conversation and no session. The tree's
   Resume and Switch rows light up for any seat with a saved conversation and then fail, because both
   work on tree agents only; a standalone agent continues when the person sends it a message. Copy
   reads the saved words too (`savedLines`), leaving out the context ToolsEnabled added. */
export function correctStandaloneActionRows(rows, { snapshot = null, pause = null, terminate = null, seat = null, savedLines = null, continues = false, changeModel = null, placed = false } = {}) {
  const live = Boolean(snapshot?.sessionId)
  const working = live && snapshot.phase === 'working'
  const earlier = Array.isArray(savedLines) ? savedLines.filter(line => line?.promptSource !== 'toolsenabled') : []
  const lines = [...earlier, ...(Array.isArray(snapshot?.transcript) ? snapshot.transcript : [])]
  const asked = lines.find(line => line?.who === 'you' && typeof line.text === 'string' && line.text)?.text || ''
  const said = [...lines].reverse().find(line => line?.who === 'agent' && typeof line.text === 'string' && line.text)?.text || ''
  if (seat && typeof seat === 'object') { seat.message = asked; seat.reply = said }
  /* The popup shows whatever run() returns with String(), so returning the controller's result put
     "[object Object]" on the status line (c4 second review, real window). Say the sentence the tree's
     own rows say, and return nothing. */
  const drive = (call, { done, refused }) => async ctx => {
    const outcome = typeof call === 'function' ? await call() : { ok: false }
    if (!outcome || outcome.ok === false) ctx?.say?.(typeof outcome?.sentence === 'string' && outcome.sentence ? outcome.sentence : refused(outcome?.code))
    else ctx?.say?.(done)
  }
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (!row || typeof row !== 'object') return row
    if (row.id === 'interrupt') return { ...row, enabled: working, disabledHint: working ? null : PALETTE_PANEL.whyNotRunning, run: drive(pause, { done: PALETTE_PANEL.interruptDone,
      refused: code => code === 'AGENT_TURN_NONE' || !code ? PALETTE_PANEL.interruptMissed : PALETTE_PANEL.interruptFailed(code) }) }
    if (row.id === 'stop') return { ...row, enabled: live, disabledHint: live ? null : PALETTE_PANEL.whyNotRunning, run: drive(terminate, { done: PALETTE_PANEL.stopped, refused: code => PALETTE_PANEL.stopRefusal(code) }) }
    if (row.id === 'copy-brief') return { ...row, enabled: Boolean(asked), disabledHint: asked ? null : PALETTE_PANEL.whyNoBrief }
    if (row.id === 'copy-reply') return { ...row, enabled: Boolean(said), disabledHint: said ? null : PALETTE_PANEL.whyNoReply }
    /* "Send a message to continue" is the answer only while nothing runs (B4
       review). A running tab is already continuing; the tree's Resume would
       still light up for it (its seat has a saved conversation) and then fail,
       because resumeNodeSession refuses a seat no tree holds, so it stays off
       and says it is a tree action. Switch and continue is a tree action either way. */
    /* Idle, the hint is true only in two cases: the saved conversation is still owed to the next send
       (`continues`), or nothing was said yet. Otherwise it is simply a tree action. */
    if (row.id === 'resume') {
      const idleHint = continues ? STANDALONE_RESTORE_COPY.continueHere : !asked && !said ? STANDALONE_RESTORE_COPY.startAgent : STANDALONE_TREE_ONLY_SENTENCE
      return { ...row, enabled: false, disabledHint: live ? STANDALONE_TREE_ONLY_SENTENCE : idleHint }
    }
    if (row.id === 'switch-continue') return { ...row, enabled: false, disabledHint: STANDALONE_TREE_ONLY_SENTENCE }
    /* B21: "Start an agent under this one" opened the start panel for a new tree, because a tab is
       not on a tree and so has no "under this one". A child needs a tree: running or not, it says so. */
    if (row.id === 'child') return { ...row, enabled: false, disabledHint: placed ? STANDALONE_PLACED_COPY.child : STANDALONE_TREE_ONLY_SENTENCE }
    /* A tab on no tree has no one it reports to and no tree loop: both rows open controls of the
       tree's Details and loop panel, which a tab is not in. */
    if (!placed && (row.id === 'move' || row.id === 'loop')) return { ...row, enabled: false, disabledHint: STANDALONE_TREE_ONLY_SENTENCE }
    /* B23: the tree's model stage reads the tree's store and session registry, which a tab is not
       in, so every model row said "This agent changed". The row opens the tab's own chooser. Once
       the tab is on a tree, the tree's node decides what it starts on, so the tab's chooser is not
       offered. */
    if (row.id === 'model') {
      if (placed) return { ...row, enabled: false, disabledHint: STANDALONE_PLACED_COPY.model }
      if (typeof changeModel !== 'function') return { ...row, enabled: false, disabledHint: STANDALONE_MODEL_COPY.unavailable }
      return { ...row, enabled: true, disabledHint: null,
        hint: live ? STANDALONE_MODEL_COPY.runningHint : STANDALONE_MODEL_COPY.hint,
        run: ctx => { ctx?.close?.(); changeModel() } }
    }
    if (live && row.enabled === false && row.disabledHint === PALETTE_PANEL.whyNotStarted) return { ...row, disabledHint: STANDALONE_TREE_ONLY_SENTENCE }
    return row
  })
}

export const STANDALONE_UNCHOSEN_SENTENCE =
  'Choose a provider and model for this agent before sending, so it starts on the one you meant.'

/* Exported so the picker, the refusal and the test all read one list. */
export function defaultStandaloneStart() {
  const row = SOLO_TIERS.find(tier => tier.id === DEFAULT_TIER) || SOLO_TIERS[0]
  return row ? { tier: row.id, effort: effortForTier(row.id) } : null
}

/* The pop-up's answer, validated. An unknown tier or effort is refused by
   name rather than stored, so a stale menu cannot put a row on the wire the
   host would only reject later, in front of a person. */
export function standaloneStartFrom(choice) {
  const tier = typeof choice?.tier === 'string' && SOLO_TIER_IDS.has(choice.tier) ? choice.tier : null
  if (!tier) return defaultStandaloneStart()
  const effort = typeof choice?.effort === 'string' && SOLO_EFFORTS.includes(choice.effort) ? choice.effort : null
  return { tier, effort: effortOnTier(tier, effort) }
}

/* Each row carries the depths ITS model takes ('' is "Model default"), so the
   answer says what the pop-up offers per model rather than one list for all. */
export function standaloneStartChoices() {
  return {
    tiers: SOLO_TIERS.map(tier => ({ ...tier,
      efforts: effortChoicesFor(tier.id).map(choice => ({ id: choice.id, label: choice.label, isDefault: choice.isDefault })) })),
    efforts: EFFORT_CHOICES.map(choice => ({ id: choice.id, label: choice.label })),
  }
}

/* The tab owns its mounted session until close. Switching tabs only hides its
   host, so drafts and the native session stay together. It is deliberately
   absent from the tree store and the declared-agent controls registry. */
export function mountStandaloneAgent(host, { id, name = 'New agent', live = false, bridge = globalThis.mcAgent, onPlaced = null, start = null, seat = null, computerId = null, chatConfigFor = null, roleBindingFor = null, onChangeStart = null, transcript = null, restored = null, displayHistory = null, onStartChosen = null, onSessionOpened = null } = {}) {
  const surface = document.createElement('div')
  surface.className = 'tree-standalone-agent'
  host.appendChild(surface)
  if (!live) {
    const note = document.createElement('p')
    note.className = 'chat-nosend'
    note.textContent = 'Open your live computer to start an independent agent.'
    surface.appendChild(note)
  }
  let disposed = false, disposalRequested = false, controller = null, placementPending = false, binding = null, lastSnapshot = null, lastDraft = null
  /* WHICH SESSION THIS SEAT HAS CLAIMED IN THE DURABLE RECORD, and null until
     one starts. T300: a + agent's turns were written NOWHERE. A measurement
     found three replies from + agents landing in zero files under the state
     root while tree-agent replies resolved to node.json and .text files, so the
     conversation lived in renderer memory and died with the tab.
     The cause was one missing call, not a missing mechanism. The shell's
     capture (shell/node-transcript-capture.cjs) already records BOTH sides of
     every turn -- recordAcceptedTranscriptSend writes the person's row and
     packet() writes the agent's -- and both begin with the same line: if there
     is no binding for this session, return. A tree node gets its binding from
     the start's requestKeys.threadId; a seat has no tree node and no
     requestKeys, so nothing ever bound it and both halves silently returned.
     The seat id is the right key and is already durable: it is declared into
     the org record by openStandalone, which is what T300 asks to read back. */
  let transcriptBinding = { status: 'unbound', sessionId: null }
  let bindingRevision = 0
  const bindingRefusal = code => ({ ok: false, code })
  const invalidateBinding = () => {
    bindingRevision++
    transcriptBinding = { status: 'unbound', sessionId: null }
  }
  const bindTranscript = (sessionId, event) => {
    const context = event?.bindingContext
    const owner = context?.ownerContext
    const ownerValid = owner?.version === 1 && owner.invalidated !== true
      && typeof owner.ownerId === 'string' && owner.ownerId.length > 0
      && typeof owner.currentEpoch === 'string' && owner.currentEpoch.length > 0
      && (owner.kind === 'local' || owner.kind === 'account')
    if (!ownerValid || typeof context?.isCurrent !== 'function') {
      return Promise.resolve(bindingRefusal('AGENT_SESSION_BINDING_CONTEXT_UNAVAILABLE'))
    }
    // This context fences the initiating UI owner. It is not a host grant or
    // image-custody authority, and is never turned into a synthetic node.
    const ownerId = owner.ownerId, ownerEpoch = owner.currentEpoch, ownerKind = owner.kind
    const ownerCurrent = () => {
      try {
        return owner.ownerId === ownerId && owner.currentEpoch === ownerEpoch
          && owner.kind === ownerKind && context.isCurrent() === true
      } catch { return false }
    }
    const replacement = event.kind === 'replaced' ? event.receipt : null
    if (event.sessionId !== sessionId || (event.kind === 'replaced'
      && (replacement?.applied !== true || replacement.sessionId !== sessionId
        || typeof event.sourceSessionId !== 'string' || !event.sourceSessionId
        || event.sourceSessionId === sessionId || replacement.sourceSessionId !== event.sourceSessionId))) {
      return Promise.resolve(bindingRefusal('AGENT_SESSION_BINDING_STALE'))
    }
    if (!ownerCurrent()) return Promise.resolve(bindingRefusal('IMAGE_OWNER_CHANGED'))
    if (disposed || disposalRequested || placementPending || binding
      || typeof sessionId !== 'string' || !sessionId
      || controller?.snapshot?.().sessionId !== sessionId) {
      return Promise.resolve(bindingRefusal('AGENT_SESSION_BINDING_STALE'))
    }
    if (typeof transcript?.bind !== 'function') {
      return Promise.resolve(bindingRefusal('AGENT_SESSION_BINDING_UNAVAILABLE'))
    }
    const current = transcriptBinding
    if (current.sessionId === sessionId && current.ownerContext === owner && current.isCurrent?.()) {
      if (current.status === 'pending') return current.promise
      if (current.status === 'confirmed') return Promise.resolve(current.receipt)
    }
    const revision = ++bindingRevision
    const attempt = { status: 'pending', sessionId, ownerContext: owner, promise: null }
    transcriptBinding = attempt
    const isCurrent = () => ownerCurrent() && !disposed && !disposalRequested && !placementPending && !binding
      && revision === bindingRevision && transcriptBinding === attempt
      && controller?.snapshot?.().sessionId === sessionId
    attempt.isCurrent = isCurrent
    attempt.promise = Promise.resolve().then(async () => {
      if (!isCurrent()) {
        attempt.status = 'refused'
        return bindingRefusal('AGENT_SESSION_BINDING_STALE')
      }
      try {
        const receipt = await transcript.bind(sessionId, id)
        if (!ownerCurrent() || !isCurrent()) {
          attempt.status = 'refused'
          return bindingRefusal(ownerCurrent() ? 'AGENT_SESSION_BINDING_STALE' : 'IMAGE_OWNER_CHANGED')
        }
        if (receipt?.ok !== true) {
          attempt.status = 'refused'
          return bindingRefusal(receipt?.code || receipt?.error?.code || 'AGENT_SESSION_BINDING_UNCONFIRMED')
        }
        attempt.status = 'confirmed'
        attempt.receipt = receipt
        return receipt
      } catch (error) {
        attempt.status = 'refused'
        return bindingRefusal(error?.code || 'AGENT_SESSION_BINDING_UNCONFIRMED')
      }
    })
    return attempt.promise
  }
  /* THE DEFAULT IS VISIBLE, NOT SILENT. The surface opens on the same row the
     compose panel opens on, and shows it, so a person always knows what this
     agent will start as and can change it before the first send. That is the
     difference the owner was pointing at: not that a default exists, but that
     the old surface had one nobody could see or move. An UNKNOWN choice still
     refuses -- see getStartOptions -- because a menu that has gone stale must
     not put a row on the wire the host would reject later, in front of them. */
  /* WHAT THE POP-UP CHOSE. Design rule: + opens a pop-up menu
     that chooses what to spawn, then the standard chat interface, with no
     buttons added where they do not belong.
     The two selects this file used to draw on the conversation were those
     buttons. The choice is made once, in the pop-up on +, before this
     surface exists; from here the chat is the shared one and nothing is
     added to it. A caller that says nothing still gets the named default,
     so no surface can start on a program nobody chose. */
  let chosen = standaloneStartFrom(start)
  /* WHAT IS ACTUALLY RUNNING, which is not the same question as what was
     chosen. Once a session has started it is on the row it started with, and
     picking a different one changes what the NEXT start uses. The chip reads
     this when it is set, so it can never rename a session that is already
     running -- telling somebody their agent had changed model when it had not
     would be worse than not showing it at all. */
  let startedWith = null
  const chipListeners = new Set()
  const announceChip = () => { for (const listener of [...chipListeners]) { try { listener() } catch { /* one bad listener must not stop the rest */ } } }
  /* "<Model> · <Provider>", then the depth when one was chosen. */
  const startLabel = value => {
    if (!value) return ''
    const row = SOLO_TIERS.find(tier => tier.id === value.tier)
    const model = row?.fullLabel || row?.label || value.tier
    return value.effort ? `${model} · ${value.effort}` : model
  }
  const copyDraft = draft => draft ? { ...draft, attachments: draft.attachments?.slice() || [] } : null
  const exportDraft = () => controller ? controller.exportDraft?.() ?? null : copyDraft(lastDraft)
  const snapshot = () => controller?.snapshot?.() || lastSnapshot || {
    sessionId: null, phase: 'draft', prompt: '', sentPrompt: '', threadId: null, account: null, turnId: null, lastTurnStatus: null, transcript: [], currentText: '',
  }
  /* One validator for the select and for the adapter method. An unknown tier
     or effort is refused by name rather than stored, so a stale menu cannot
     put a row on the wire the host would only reject later, in front of a
     person. */
  const chooseStandaloneStart = ({ tier, effort = null } = {}) => {
    if (typeof tier !== 'string' || !SOLO_TIER_IDS.has(tier)) {
      return { ok: false, code: 'AGENT_STANDALONE_TIER_UNKNOWN', sentence: STANDALONE_UNCHOSEN_SENTENCE }
    }
    /* '' is "Model default", a choice rather than an unknown word. */
    if (effort !== null && effort !== '' && !SOLO_EFFORTS.includes(effort)) {
      return { ok: false, code: 'AGENT_STANDALONE_EFFORT_UNKNOWN', sentence: STANDALONE_UNCHOSEN_SENTENCE }
    }
    /* The same answer the pop-up's own start gets: a depth this model does not
       take falls to its default. Named through standaloneStartFrom so this
       body reads no helper the module keeps to itself. */
    chosen = standaloneStartFrom({ tier, effort })
    announceChip()
    // B4: the list of open tabs keeps what this tab will start on after a restart.
    if (typeof onStartChosen === 'function') { try { onStartChosen({ ...chosen }) } catch { /* the choice stands */ } }
    return { ok: true, ...chosen }
  }

  /* THE CHAT IS THE HOST'S, NOT THIS FILE'S. computersView builds the tree
     conversation's chat with treeChatConfigFor(node) and hands that builder
     down through the graph's standaloneAgent injection; this calls it with
     the seat. That is why the solo agent gets Copy, the queue controls, the
     Actions menu, chips, /goal and /loop -- the same builder serving the
     same shape, not ten options copied across one at a time, which is the
     rejected path.

     A caller that supplies no builder still gets a conversation. Every
     existing caller does exactly that, and an empty tab would be a worse
     answer than a plain one. */
  /* A TAB REOPENED AFTER A RESTART (B4) shows the conversation it had, from
     the seat's saved record, drawn by the host (displayHistory) so the context
     ToolsEnabled added is folded rather than shown as the person's words. The
     rest of the chat is still the host's builder whenever the seat came back.
     Its notes follow, saying it is not running and what came back
     differently. A conversation that could not be read is not shown. */
  const restoredLines = restored && !restored.unreadable && Array.isArray(restored.lines) ? restored.lines : []
  const restoredNotes = restored
    ? [standaloneReopenedNote({ cause: restored.cause, unreadable: Boolean(restored.unreadable),
      conversation: restoredLines.length > 0 || Boolean(restored.before) }),
    ...(Array.isArray(restored.notes) ? restored.notes : [])]
      .filter(text => typeof text === 'string' && text).map(text => ({ who: 'note', text, at: null }))
    : []
  const displayed = () => {
    if (!restored || restored.unreadable) return []
    try {
      if (typeof displayHistory === 'function') return displayHistory(id) || []
    } catch { return [] }
    return restoredLines.filter(line => (line?.who === 'you' || line?.who === 'agent') && line.promptSource !== 'toolsenabled')
  }
  let treeChat = typeof chatConfigFor === 'function' && seat ? chatConfigFor(seat) : null
  if (restored) {
    treeChat = { ...(treeChat || { seed: 0 }), history: [...displayed(), ...restoredNotes] }
  }
  // B8: the tree's Actions rows are corrected from this tab's own session (correctStandaloneActionRows).
  const correctRows = rows => correctStandaloneActionRows(rows || [], {
    snapshot: typeof controller?.snapshot === 'function' ? controller.snapshot() : null,
    pause: () => controller?.pause?.(), terminate: () => controller?.terminate?.(), seat, savedLines: restoredLines, continues: seedPending,
    // B23: Switch model opens the same chooser as the model chip (openStartChooser, below).
    changeModel: typeof onChangeStart === 'function' ? () => openStartChooser() : null,
    // Added to a tree, the tab stays open and the tree owns the agent (B21/B23 follow-up).
    placed: Boolean(binding) })
  const hostChat = treeChat && typeof treeChat.actions === 'function'
    ? { ...treeChat, actions: () => correctRows(treeChat.actions()),
      // The Loop shortcut beside the composer reads these rows, so it says what the menu says.
      ...(typeof treeChat.commonActions === 'function' ? { commonActions: () => correctRows(treeChat.commonActions()) } : {}) }
    : treeChat
  /* THE FIRST SEND AFTER A RESTART CONTINUES THE CONVERSATION (B4). The new
     session is started with the saved speech as its handoff -- the same seed
     a tree agent's deferred resume uses -- because nothing saved for a seat
     can resume the provider's own thread. It counts as delivered only once a
     turn of the seeded session has finished: a start or first send the host
     refuses closes that session, and the next start must carry it again. */
  let seedPending = Boolean(restored) && !restored.unreadable
    && (restoredLines.length > 0 || (Boolean(restored.before) && Boolean(restored.recoveryDirectory)))
  let seedSessionId = null
  /* DELIVERED MEANS THE HOST TOOK A TURN (B4 review). The session whose turn
     the host accepted -- its send answered with a turn id, which the state then
     carries -- is recorded here. A refused send publishes the session open with
     a failed turn and no turn id, including when the host has already
     forgotten the session, so that alone never counts as delivered. */
  let seedAcceptedBy = null
  /* THE WORDS WAITING AT QUIT GO TO THE NEXT SESSION (B4 step 11; owner
     default: the tree's rule). The outbox keeps a person's queued messages
     under the session they were written to, and a restart ends that session.
     A tree circle's Resume moves them to the session it opens
     (views/computers.js); a reopened tab moves them to the session its first
     send opens. They are not shown before that send and not sent before its
     first turn finishes: the move happens at `open`, before the turn is sent,
     and a queue drains only when a turn completes. Until a turn of the new
     session finishes they follow each new session, so a refused first send
     does not strand them under a closed one. They were written before
     anything queued since the restart, so they go first. */
  let carriedQueueFrom = restored && typeof restored.sessionId === 'string' && restored.sessionId ? restored.sessionId : null
  let carriedAcceptedBy = null
  const carryWaitingMessages = to => {
    if (!carriedQueueFrom || typeof to !== 'string' || !to || carriedQueueFrom === to) return
    const from = carriedQueueFrom
    carriedQueueFrom = to
    try {
      if (!outboxList(from).length) return
      // moveSession keeps what is already at the destination first; here the older words must lead.
      if (outboxList(to).length) outboxMoveSession(to, from)
      outboxMoveSession(from, to)
    } catch { /* the words stay where they were saved */ }
  }
  const seedFor = request => {
    if (!seedPending) return {}
    const seed = transcriptSeedText(restoredLines, { recoveryDirectory: restored.recoveryDirectory || null,
      earlierMessages: Boolean(restored.before), place: 'conversation' })
    // The host refuses an empty handoff, so there is no key at all without one.
    if (typeof seed !== 'string' || !seed) return {}
    seedSessionId = typeof request?.sessionId === 'string' ? request.sessionId : null
    return { historyHandoff: seed }
  }
  /* WHO THIS SESSION IS, ON THE WIRE. Declaring the seat puts this agent in
     the org record; it does not tell the host which agent a session belongs
     to. `treeIdentity` carries selfName and managerName only, so the single
     route by which an agentId reaches shell/main.cjs is the start's
     `roleBinding` -- and shell/screen-control-host.cjs refuses
     SCREEN_ROLE_UNAVAILABLE when readBinding(agentId) finds nothing. Without
     this the App permissions list shows a raw session id for a seat that was
     properly declared, and computer control cannot be granted to it.

     CALLED AT THE SEND, NOT AT MOUNT, which is why a function is passed
     rather than a value. The binding pins the org and role revisions and the
     host checks them against the record as it is when the start arrives; one
     minted when the tab opened is refused AGENT_ROLE_BINDING_INVALID as soon
     as anybody edits a role, and a solo tab can sit open for hours.

     A REFUSAL IS NOT FATAL. A page with no Role library cannot bind, and
     taking the whole conversation away over an identity the conversation does
     not need would cost more than it protects. The session then starts exactly
     as it did before this existed -- anonymous, never with an invented id. */
  const seatBinding = async () => {
    if (!seat || typeof roleBindingFor !== 'function') return {}
    let bound = null
    /* B4 step 9: the program this start runs on, so the page re-declares the seat for its
       provider before minting; the seat was declared for the program the tab opened on. */
    try { bound = await roleBindingFor(seat, { tier: chosen?.tier ?? null }) } catch { return {} }
    return bound?.ok === true && bound.binding?.agentId ? { roleBinding: bound.binding } : {}
  }
  /* THE CHIP SAYS WHAT THIS AGENT RUNS ON, AND IS THE DOOR TO CHANGING IT.
     Page 2: nothing on the + chat named the program or the effort,
     so the only way to find out was to ask the agent -- the same complaint the
     pop-up was built for, one step later.
     The chip does not open a menu of its own. It asks the HOST, which already
     owns the pop-up the person used to open this tab; a second menu drawn here
     is exactly the control the inline selects were removed for. A caller that
     supplies no chooser still gets the chip, static, because knowing what it
     runs on is worth more than the ability to change it. */
  /* The chip's door, and since B23 the Actions menu's Switch model row too: one chooser, the host's. */
  /* RUNNING MEANS A SESSION IS OPEN NOW (B23 follow-up). startedWith outlives
     Stop, and the tab then said "already running ... open a new agent" over a
     session that had ended, while the next send used the choice. */
  const runningStart = () => (startedWith && snapshot()?.sessionId ? { ...startedWith } : null)
  const sameStart = (a, b) => Boolean(a && b) && a.tier === b.tier && (a.effort || null) === (b.effort || null)
  /* A PICK FOR NEXT TIME NAMES WHAT CHANGES (c4 review). "Model default" is no
     word on the chip, so a depth-only pick -- Sonnet 5 · low running, Sonnet 5
     at Model default picked -- read "Next: Sonnet 5", naming no change at all. */
  const nextDepth = (pick, running) => pick.effort || (running?.effort ? MODEL_DEFAULT_EFFORT.label : '')
  const openStartChooser = () => {
    if (disposed || typeof onChangeStart !== 'function') return
    // On a tree the node decides what it starts on; a pick here would be ignored.
    if (binding) {
      surface.querySelector('[data-chat-panel]')?.addNote?.(STANDALONE_PLACED_COPY.model)
      return
    }
    const running = runningStart()
    /* B30: the chooser opens on what this agent starts on NEXT. Before any
       change that is the running model; after one, a re-opened chooser showed
       the running model as if the pick had not been kept. */
    onChangeStart({ ...(chosen || running), running: Boolean(running) }, request => {
      const outcome = chooseStandaloneStart(request)
      if (outcome.ok !== true) return outcome
      /* A RUNNING SESSION IS NOT RE-PROGRAMMED BY THIS. Say when the
         change takes effect, in the conversation, rather than leaving the
         person to discover it from the next answer's tone. */
      /* Re-picking exactly what runs changes nothing next time either: no note (c4 review). */
      if (running && !sameStart(chosen, running)) {
        const depth = nextDepth(chosen, running)
        const label = startLabel({ tier: chosen.tier, effort: null })
        surface.querySelector('[data-chat-panel]')?.addNote?.(standaloneStartChangedSentence(depth ? `${label} · ${depth}` : label))
      }
      return outcome
    })
  }
  const chatChips = {
    tier: () => {
      /* On a tree the node decides what starts next: it keeps the model its session ran on, so the
         tab's own pick is not it (round-3 verify). Off a tree, the running session, else the pick. */
      if (binding) {
        const label = startLabel(startedWith || chosen)
        return label ? { label } : null
      }
      /* B30: a model picked while a session runs is what starts next. The chip says
         "Next: <model>" so it neither renames the running session nor hides the pick.
         The model alone (no provider) keeps it inside the chip's width. */
      const running = runningStart()
      if (running && chosen && !sameStart(chosen, running)) {
        const row = SOLO_TIERS.find(tier => tier.id === chosen.tier)
        const depth = nextDepth(chosen, running)
        return { label: `Next: ${row?.label || chosen.tier}${depth ? ` · ${depth}` : ''}` }
      }
      const label = startLabel(running || chosen)
      return label ? { label } : null
    },
    subscribe: listener => {
      if (typeof listener !== 'function') return () => {}
      chipListeners.add(listener)
      return () => chipListeners.delete(listener)
    },
    ...(typeof onChangeStart === 'function' ? { onOpenTier: openStartChooser } : {}),
  }
  let placementRevision = 0
  const getImageDraftRegistrationContext = ({ ownerContext, isCurrent: ownerIsCurrent } = {}) => {
    const refuse = (code, held = false) => ({ ok: false, code, ...(held ? { held: true } : {}) })
    if (disposed || disposalRequested) return refuse('AGENT_SESSION_VIEW_CLOSED')
    if (placementPending) return refuse('AGENT_SESSION_NOT_READY', true)
    if (binding) return refuse('IMAGE_DRAFT_CONTEXT_CHANGED')
    if (!live || typeof computerId !== 'string' || !computerId.trim()
      || typeof id !== 'string' || !id || !seat || seat.id !== id || seat.ok === false) {
      return refuse('IMAGE_DRAFT_REGISTRATION_CONTEXT_UNAVAILABLE')
    }
    if (ownerContext?.version !== 1 || ownerContext.invalidated === true
      || typeof ownerContext.ownerId !== 'string' || !ownerContext.ownerId
      || typeof ownerContext.currentEpoch !== 'string' || !ownerContext.currentEpoch
      || !['local', 'account'].includes(ownerContext.kind) || typeof ownerIsCurrent !== 'function') {
      return refuse('IMAGE_OWNER_UNAVAILABLE')
    }
    const revision = placementRevision
    const capturedSeat = seat, nodeId = seat.id
    const ownerId = ownerContext.ownerId, ownerEpoch = ownerContext.currentEpoch, ownerKind = ownerContext.kind
    const isCurrent = () => {
      try {
        return !disposed && !disposalRequested && !placementPending && !binding
          && revision === placementRevision && seat === capturedSeat && seat.id === nodeId
          && seat.ok !== false && ownerContext.invalidated !== true
          && ownerContext.ownerId === ownerId && ownerContext.currentEpoch === ownerEpoch
          && ownerContext.kind === ownerKind && ownerIsCurrent() === true
      } catch { return false }
    }
    if (!isCurrent()) return refuse('IMAGE_OWNER_CHANGED')
    // Provenance for the host's independent registration checks. Never parse a
    // persistence key, translate a computer alias, or manufacture a tree node.
    return Object.freeze({ ok: true, kind: 'standalone', computerId, nodeId, isCurrent })
  }
  const release = mountAgentSessionSurface(surface, {
    getImageDraftRegistrationContext,
    hostChat,
    chatChips,
    agentId: id, live, bridge, chatComposer: true, chatTitle: name,
    publishSession: false,
    retainChatOnDetach: true,
    onController(value) {
      controller = value
      controller?.setTitle(name)
      if (controller && placementPending) controller.beginPlacement()
    },
    /* A PLACED AGENT'S TREE IDENTITY STILL WINS. Once this seat is adopted the
       tree owns what it starts as, exactly as before. Unplaced, this used to
       return undefined and the host then planned the session on its own
       default -- which is how a person who wanted Claude got Codex and could
       not tell. Now it carries what they picked, and refuses if they picked
       nothing rather than choosing for them. */
    getStartOptions: async request => {
      if (binding) {
        // A tab placed on a tree before it ever sent still owes its new session the saved conversation.
        const options = await binding.getStartOptions?.(request)
        return options && typeof options === 'object' && seedPending ? { ...options, ...seedFor(request) } : options
      }
      if (!chosen) {
        const refusal = new Error(STANDALONE_UNCHOSEN_SENTENCE)
        refusal.code = 'AGENT_STANDALONE_PROGRAM_UNCHOSEN'
        throw refusal
      }
      /* WHAT WENT ON THE WIRE IS WHAT THE CHIP WILL SAY FROM NOW ON. Recorded
         here rather than on the send, because this is the one place that knows
         the row the host was actually asked for. */
      startedWith = { ...chosen }
      announceChip()
      return { surface: STANDALONE_SURFACE, tier: chosen.tier, ...(chosen.effort ? { effort: chosen.effort } : {}), ...(await seatBinding()), ...seedFor(request) }
    },
    onSessionChange: (state, event) => {
      const kind = event?.kind
      const current = typeof state?.sessionId === 'string' && state.sessionId ? state.sessionId : null
      const opened = kind === 'open' || kind === 'replaced'
      // The host accepted a turn of this session (see seedAcceptedBy).
      const accepted = id => kind === 'state' && current === id && typeof state.turnId === 'string' && state.turnId.length > 0
      /* A turn of this session finished after the host accepted it. A turn the
         host reports as completed is accepted by definition, even when it
         finished before the send's own answer arrived. */
      const finished = (id, acceptedBy) => kind === 'state' && current === id && state.phase === 'open'
        && Boolean(state.lastTurnStatus) && (acceptedBy === id || sessionTurnSucceeded(state.lastTurnStatus))
      /* A HELD START ASKS AGAIN UNDER A NEW SESSION ID with the options it
         already had, so the seed rides the retry without getStartOptions being
         asked again. While the seed is owed it follows the session that opens. */
      if (seedPending && seedSessionId && opened && current) seedSessionId = current
      if (seedSessionId && accepted(seedSessionId)) seedAcceptedBy = seedSessionId
      if (seedSessionId && finished(seedSessionId, seedAcceptedBy)) {
        seedPending = false
        seedSessionId = null
        seedAcceptedBy = null
      }
      // The chip names the running session's model, and the next start's once it ends.
      if (opened || kind === 'closed') announceChip()
      if (carriedQueueFrom && opened) carryWaitingMessages(current)
      if (carriedQueueFrom && accepted(carriedQueueFrom)) carriedAcceptedBy = carriedQueueFrom
      // A finished turn of the session holding them: its own queue sends them from here.
      if (carriedQueueFrom && finished(carriedQueueFrom, carriedAcceptedBy)) {
        carriedQueueFrom = null
        carriedAcceptedBy = null
      }
      if (binding) return binding.onSessionChange?.(state, event)
      // State publication exposes the attempted ID before bridge.start. Only
      // the awaited post-start/replacement callback may confirm this binding.
      if (event?.kind === 'open' || event?.kind === 'replaced') {
        const bound = bindTranscript(state?.sessionId, event)
        /* B4: the list of open tabs keeps the session this tab confirmed, so a
           page reload can close it before the tab reopens over it. */
        if (typeof onSessionOpened === 'function') {
          const sessionId = state?.sessionId
          void bound.then(receipt => {
            if (receipt?.ok === true) { try { onSessionOpened({ sessionId }) } catch { /* the session stands */ } }
          }, () => {})
        }
        return bound
      }
      if (transcriptBinding.sessionId && state?.sessionId !== transcriptBinding.sessionId) invalidateBinding()
    },
    retainSessionOnDispose: () => !!binding?.nodeId,
  })
  const disposeNow = () => {
    if (disposed) return
    lastSnapshot = snapshot()
    lastDraft = copyDraft(exportDraft())
    disposed = true
    invalidateBinding()
    release()
    surface.remove()
  }
  return {
    startChoices: standaloneStartChoices,
    chosenStart: () => (chosen ? { ...chosen } : null),
    /* B4 step 10: the conversation this tab came back with, while no agent has
       it yet. Adding the tab to a tree then gives it to the new circle. Once a
       turn of the seeded session has finished an agent has it, and what was
       said since is under this tab's seat like any tab's speech before it is
       placed, so there is nothing more to hand over. The context ToolsEnabled
       added to a first turn stays behind: the circle adds its own when it
       starts, and a circle with no session would show it as the person's words. */
    restoredConversation: () => (seedPending
      ? restoredLines.filter(line => line?.promptSource !== 'toolsenabled').map(line => ({ ...line })) : []),
    // Where the tab's older pages start, so the circle gets the whole conversation, not only its newest page.
    restoredConversationBefore: () => (seedPending && typeof restored?.before === 'string' && restored.before ? restored.before : null),
    /* Kept so the pop-up, or a later re-open of it, can set the choice
       before the first send. There is no control on the chat to keep in
       step with it any more. */
    chooseStart(request) { return chooseStandaloneStart(request) },
    snapshot,
    exportDraft,
    /* THE HANDOVER, CALLED BEFORE THE TREE CLAIMS THE SESSION. The capture
       refuses to repoint a live binding, which is right -- a conversation must
       not change owner behind a reader's back. So the seat lets go first, and
       what was said here stays readable under this seat while everything after
       the move lands on the node. Answers even when nothing was bound, so the
       caller can tell that apart from a copy that cannot release. */
    async releaseTranscript(sessionId) {
      const current = transcriptBinding
      const target = typeof sessionId === 'string' && sessionId ? sessionId : current.sessionId
      if (!target || current.sessionId !== target) {
        return { ok: true, released: false, reason: 'TRANSCRIPT_BINDING_NOT_HELD' }
      }
      if (current.status === 'pending') {
        return { ok: false, released: false, code: 'AGENT_SESSION_BINDING_PENDING' }
      }
      if (current.status !== 'confirmed' || typeof transcript?.release !== 'function') {
        return { ok: false, released: false, code: 'AGENT_SESSION_BINDING_UNCONFIRMED' }
      }
      try {
        const receipt = await transcript.release(target)
        if (receipt?.ok !== true) return { ok: false, released: false, code: receipt?.code || 'AGENT_SESSION_RELEASE_UNCONFIRMED' }
        if (transcriptBinding === current) invalidateBinding()
        return receipt
      } catch (error) {
        return { ok: false, released: false, code: error?.code || 'AGENT_SESSION_RELEASE_UNCONFIRMED' }
      }
    },
    setTitle(value) {
      if (disposed || typeof value !== 'string' || !value.trim()) return
      name = value.trim()
      controller?.setTitle(name)
    },
    beginPlacement() {
      if (disposed || placementPending || binding) return { ok: false, sentence: 'This agent is already being placed or belongs to a tree.' }
      const result = controller?.beginPlacement?.() || { ok: true, snapshot: snapshot() }
      if (!result.ok) return result
      placementRevision++
      placementPending = true; surface.inert = true
      return result
    },
    cancelPlacement() {
      if (binding) return
      if (placementPending) placementRevision++
      placementPending = false; surface.inert = false; controller?.cancelPlacement?.()
      if (disposalRequested) disposeNow()
    },
    commitPlacement(value) {
      if ((disposed && !binding) || typeof value?.nodeId !== 'string' || !value.nodeId.trim()
        || (binding && binding.nodeId !== value.nodeId) || (!binding && !placementPending)) return null
      const firstPlacement = !binding
      placementRevision++
      invalidateBinding()
      binding = { ...binding, ...value }
      if (firstPlacement && typeof onPlaced === 'function') {
        try { onPlaced(binding.nodeId) } catch { /* the acknowledged tree keeps custody even if a view handoff fails */ }
      }
      // A host acknowledgment transfers custody immediately. Sending resumes
      // only after the tree's start identity and transcript hooks are attached.
      if (typeof binding.getStartOptions === 'function' && typeof binding.onSessionChange === 'function') {
        placementPending = false; surface.inert = false; controller?.cancelPlacement?.()
      }
      const state = snapshot()
      if (disposalRequested) disposeNow()
      return state
    },
    focus() {
      if (!disposed) surface.querySelector('.chat-input textarea')?.focus({ preventScroll: true })
    },
    dispose() {
      if (disposed) return
      disposalRequested = true
      // Do not close a native session while its adoption acknowledgment is in
      // flight. A refusal keeps it ours; a success gives its lifetime to the tree.
      if (!placementPending) disposeNow()
    },
  }
}
