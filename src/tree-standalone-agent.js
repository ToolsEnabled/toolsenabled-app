import { mountAgentSessionSurface } from './agent-session.js'
import { LAUNCH_TIERS } from './orchestration-controls.js'
import { EFFORT_CHOICES, DEFAULT_TIER } from './fleet-tree-copy.js'

/* THE PROGRAM RIDES ON THE TIER, so this surface offers tiers and nothing
   called "provider". START_TIERS in shell/agent-host.cjs keys provider off the
   tier row, and startSession resolves `const sessionProvider = (startTier &&
   startTier.provider) || …`. A separate program menu would be a second answer
   to one question, and the two would disagree the first time the catalog moved.
   `treeOnly` rows are exactly what their name says and stay out of a solo list. */
const SOLO_TIERS = Object.freeze(LAUNCH_TIERS.filter(tier => !tier.treeOnly))
const SOLO_TIER_IDS = new Set(SOLO_TIERS.map(tier => tier.id))
const SOLO_EFFORTS = Object.freeze(EFFORT_CHOICES.map(choice => choice.id))

/* THE EFFORT A ROW MEANS, and the fallback is not a number I picked. Claude
   rows carry `effort: null` in LAUNCH_TIERS, and agent-compose-panel.js
   already answers that case for a tree agent with
   `LAUNCH_TIERS.find(...)?.effort || 'medium'`. A Claude tree agent sends
   medium, so a Claude solo agent sends medium -- parity, which is the whole
   point, rather than a second opinion.

   Effort is NOT decorative for Claude: measured at engine bafd25a5b,
   claude-cli-adapter.js validates it against low/medium/high/xhigh/max and
   passes `--effort <value>`. So these rows get a real default rather than a
   disabled control.

   Reading the CURRENT select here instead is the defect Worker 82 found on
   screen: pick max on a Codex row, switch to Claude, and max was sent by
   someone who never chose it for Claude. */
const effortForTier = tierId => SOLO_TIERS.find(tier => tier.id === tierId)?.effort || 'medium'

export const STANDALONE_SURFACE = 'standalone-agent'
/* Said in the conversation when the program is changed while a session is
   already open, because the running one keeps the row it started on. */
export const standaloneStartChangedSentence = label =>
  `This agent is already running on what it started with. ${label} will be used the next time an agent starts here; open a new agent to use it now.`

export const STANDALONE_UNCHOSEN_SENTENCE =
  'Choose a program and model for this agent before sending, so it starts on the one you meant.'

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
  return { tier, effort: effort ?? effortForTier(tier) }
}

export function standaloneStartChoices() {
  return {
    tiers: SOLO_TIERS.map(tier => ({ id: tier.id, label: tier.label, provider: tier.provider, effort: tier.effort })),
    efforts: EFFORT_CHOICES.map(choice => ({ id: choice.id, label: choice.label })),
  }
}

/* The tab owns its mounted session until close. Switching tabs only hides its
   host, so drafts and the native session stay together. It is deliberately
   absent from the tree store and the declared-agent controls registry. */
export function mountStandaloneAgent(host, { id, name = 'New agent', live = false, bridge = globalThis.mcAgent, onPlaced = null, start = null, seat = null, computerId = null, chatConfigFor = null, roleBindingFor = null, onChangeStart = null, transcript = null } = {}) {
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
     one starts. T300: a + agent's turns were written NOWHERE. Worker 82
     measured three replies from + agents landing in zero files under the state
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
  /* WHAT THE POP-UP CHOSE. The owner, 2026-09-17: "Give it a pop up menu to
     select what to spawn, and then give it the standard fucking chat
     interface... adding bullshit fuckass buttons where they dont belong."
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
  const startLabel = value => {
    if (!value) return ''
    const row = SOLO_TIERS.find(tier => tier.id === value.tier)
    const program = row?.label || value.tier
    return value.effort ? `${program} · ${value.effort}` : program
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
    if (effort !== null && !SOLO_EFFORTS.includes(effort)) {
      return { ok: false, code: 'AGENT_STANDALONE_EFFORT_UNKNOWN', sentence: STANDALONE_UNCHOSEN_SENTENCE }
    }
    chosen = { tier, effort: effort ?? effortForTier(tier) }
    announceChip()
    return { ok: true, ...chosen }
  }

  /* THE CHAT IS THE HOST'S, NOT THIS FILE'S. computersView builds the tree
     conversation's chat with treeChatConfigFor(node) and hands that builder
     down through the graph's standaloneAgent injection; this calls it with
     the seat. That is why the solo agent gets Copy, the queue controls, the
     Actions menu, chips, /goal and /loop -- the same builder serving the
     same shape, not ten options copied across one at a time, which is the
     path the owner rejected.

     A caller that supplies no builder still gets a conversation. Every
     existing caller does exactly that, and an empty tab would be a worse
     answer than a plain one. */
  const hostChat = typeof chatConfigFor === 'function' && seat ? chatConfigFor(seat) : null
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
  const seatBinding = () => {
    if (!seat || typeof roleBindingFor !== 'function') return {}
    let bound = null
    try { bound = roleBindingFor(seat) } catch { return {} }
    return bound?.ok === true && bound.binding?.agentId ? { roleBinding: bound.binding } : {}
  }
  /* THE CHIP SAYS WHAT THIS AGENT RUNS ON, AND IS THE DOOR TO CHANGING IT.
     Worker 82, page 2: nothing on the + chat named the program or the effort,
     so the only way to find out was to ask the agent -- the same complaint the
     pop-up was built for, one step later.
     The chip does not open a menu of its own. It asks the HOST, which already
     owns the pop-up the person used to open this tab; a second menu drawn here
     is exactly the control the inline selects were removed for. A caller that
     supplies no chooser still gets the chip, static, because knowing what it
     runs on is worth more than the ability to change it. */
  const chatChips = {
    tier: () => {
      const label = startLabel(startedWith || chosen)
      return label ? { label } : null
    },
    subscribe: listener => {
      if (typeof listener !== 'function') return () => {}
      chipListeners.add(listener)
      return () => chipListeners.delete(listener)
    },
    ...(typeof onChangeStart === 'function' ? {
      onOpenTier: () => {
        if (disposed) return
        const running = startedWith ? { ...startedWith } : null
        onChangeStart({ ...(running || chosen), running: Boolean(running) }, request => {
          const outcome = chooseStandaloneStart(request)
          if (outcome.ok !== true) return outcome
          /* A RUNNING SESSION IS NOT RE-PROGRAMMED BY THIS. Say when the
             change takes effect, in the conversation, rather than leaving the
             person to discover it from the next answer's tone. */
          if (running) surface.querySelector('[data-chat-panel]')?.addNote?.(standaloneStartChangedSentence(startLabel(chosen)))
          return outcome
        })
      },
    } : {}),
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
    getStartOptions: request => {
      if (binding) return binding.getStartOptions?.(request)
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
      return { surface: STANDALONE_SURFACE, tier: chosen.tier, ...(chosen.effort ? { effort: chosen.effort } : {}), ...seatBinding() }
    },
    onSessionChange: (state, event) => {
      if (binding) return binding.onSessionChange?.(state, event)
      // State publication exposes the attempted ID before bridge.start. Only
      // the awaited post-start/replacement callback may confirm this binding.
      if (event?.kind === 'open' || event?.kind === 'replaced') {
        return bindTranscript(state?.sessionId, event)
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
      if (!disposed) surface.querySelector('.chat-input input')?.focus({ preventScroll: true })
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
