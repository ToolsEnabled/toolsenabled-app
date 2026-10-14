import { resumedTranscriptLines } from './tree-resume-transcript.js'
import { nodeDisplayName } from './fleet-trees.js'
import { identityRoleForTreeNode } from './tree-node-identity.js'
import { composeNodeBrief } from './tree-node-brief.js'
import { createSessionTextReader, sessionTurnStatus, sessionTurnSucceeded, sessionTurnCancelled, sessionTurnFailureText, recoveredNodeTurnStatus,
  sessionEventTurnId, completionSettlesOpenTurn, sessionEndedEvent, sessionSafetyRefusal } from './agent-session-events.js'
import { MODEL_PANEL, TURN_CANCELLED } from './fleet-tree-copy.js'
import { refusalCode, refusalAttribution, UNAVAILABLE_TEXT } from './agent-availability-copy.js'
import { refusalCodeOf } from './refusal-copy.js'
import { noteMeansStopped } from './stop-node-session.js'
import { manualAccountHandoff, manualModelHandoff, savedAccountResumeRefused, MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY } from './manual-account-continuation.js'
import { createAutomaticImageRecoveryHostRegistry } from './automatic-image-recovery-host-registry.js'

/* A refused image operation can be nonfatal to text recovery only when the
   authenticated host is still the prepared owner and the image-only outcome is
   proven. SOURCE_CHANGED is the one pre-dispatch reconciliation outcome that
   may use its retained receipt shortcut. Terminal delivery refusals must
   carry the authoritative not-sent/retained disposition; identity, authority
   and unknown outcomes remain fatal rather than becoming queue-only guesses. */
const IMAGE_RECOVERY_PROVEN_QUEUE_REFUSAL_CODES = new Set([
  'IMAGE_RECOVERY_SOURCE_CHANGED',
])
const IMAGE_RECOVERY_AUTHORITY_REFUSAL_CODES = new Set([
  'IMAGE_OWNER_UNAVAILABLE',
  'IMAGE_OWNER_CHANGED',
  'IMAGE_OWNER_CONTEXT_INVALID',
  'IMAGE_RECOVERY_HOST_UNAVAILABLE',
  'IMAGE_RECOVERY_HOST_FAILED',
  'IMAGE_RECOVERY_DISPOSED',
])
const IMAGE_RECOVERY_NON_QUEUE_REFUSAL_CODES = new Set([
  ...IMAGE_RECOVERY_AUTHORITY_REFUSAL_CODES,
  'IMAGE_RECOVERY_AUTHORITY_CHANGED',
  'IMAGE_RECOVERY_HOST_CHANGED',
  'IMAGE_CUSTODY_CANDIDATE_REFUSED',
  'IMAGE_RECOVERY_STALE',
  'IMAGE_RECOVERY_SOURCE_BINDING_REQUIRED',
  'IMAGE_RECOVERY_SOURCE_BINDING_CHANGED',
  'IMAGE_RECOVERY_SAME_SESSION',
  'IMAGE_RECOVERY_SUCCESSOR_UNVALIDATED',
  'IMAGE_RECOVERY_SOURCE_IDENTITY_CHANGED',
  'IMAGE_RECOVERY_DESTINATION_IDENTITY_CHANGED',
  'IMAGE_RECOVERY_DESTINATION_STALE',
  'IMAGE_RECOVERY_TRANSFER_RECONCILE_REQUIRED',
  'IMAGE_RECOVERY_TRANSFER_UNCONFIRMED',
  'IMAGE_RECOVERY_DISPATCH_IDENTITY_CHANGED',
  'IMAGE_RECOVERY_DISPATCH_UNCONFIRMED',
  'IMAGE_RECOVERY_BOUNDARY_UNAVAILABLE',
  'IMAGE_RECOVERY_RETRY_EXHAUSTED',
  'IMAGE_DELIVERY_UNKNOWN',
  'IMAGE_OUTBOX_CLEANUP_REQUIRED',
  'IMAGE_RECOVERY_OPERATION_INVALID',
  'IMAGE_RECOVERY_READ_UNCONFIRMED',
  'IMAGE_RECOVERY_REQUEST_INVALID',
  'IMAGE_RECOVERY_TERMINAL_REFUSAL',
])
const imageRecoveryNonQueueRefusalCode = code => {
  const value = String(code || '')
  return IMAGE_RECOVERY_NON_QUEUE_REFUSAL_CODES.has(value)
    || /(?:AUTH|OWNER|CUSTODY|CANDIDATE|CURRENT|IDENTITY|BINDING|STALE|DISPOSED|SESSION|NODE|CONVERSATION|UNKNOWN|CLEANUP|UNCONFIRMED|UNAVAILABLE)/.test(value)
}
const sameImageOwnerContext = (left, right) => Boolean(left && right)
  && left.version === right.version
  && left.ownerId === right.ownerId
  && left.currentEpoch === right.currentEpoch
  && left.kind === right.kind
const isProvenImageOnlyRefusal = (result, { allowPreDispatchSourceChanged = false } = {}) => {
  const code = result?.code
  if (result?.retained !== true || result?.replay === true || typeof code !== 'string' || !code) return false
  // Authority, ownership, custody-candidate, currentness and identity
  // failures are fail-closed before any terminal disposition is considered.
  if (imageRecoveryNonQueueRefusalCode(code)) return false
  // These codes have independently proven image-only custody semantics
  // only at the pre-dispatch transfer boundary. The option is false by
  // default, so drain must always prove the terminal not-sent tuple instead.
  if (allowPreDispatchSourceChanged && IMAGE_RECOVERY_PROVEN_QUEUE_REFUSAL_CODES.has(code)) return true
  return result?.deliveryDisposition === 'not-sent'
    && result?.retryable === false
    && typeof result?.envelopeId === 'string'
    && result.envelopeId.length > 0
}

// One event-driven coordinator per renderer. Contexts contain stores, never views
// or DOM nodes, so recovery continues when the person leaves Computers.
/* A RECOVERY THAT ENDED PAUSED IS NOT A READY SESSION. The successor may hold
   retained pictures it never received the handoff for; they wait for the person
   (Send again) or for the node to move on through a real turn, never for the
   next status notice in the tree. The node's own saved note is the durable fact,
   so a reload keeps the hold. */
const RECOVERY_PAUSED_PREFIX = 'Recovery paused: '
export function recoveryPausedNode(node) {
  return node?.status === 'turn-failed' && typeof node.statusNote === 'string'
    && node.statusNote.startsWith(RECOVERY_PAUSED_PREFIX)
}

export function createAccountRecoveryCoordinator({ bridge, sessionNodeIds, moveOutbox = () => {}, canStart = () => false, canContinue = () => false, isReplacing = () => false,
  onCleanupRequired = () => {}, outbox = null, orgBridge = null, tiers = [], now = Date.now } = {}) {
  /* The person's sentence for a refusal code the table names; the raw message
     for one it does not. Read beside refusalCode, never instead of it. */
  function refusalSentenceFor(code, error) {
    if (Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, code)) return UNAVAILABLE_TEXT[code]
    return error?.message || String(error)
  }
  const contexts = new Map()
  const flights = new Set()
  const continuationFlights = new Map()
  const seen = new Set()
  const listeners = new Set()
  const settledListeners = new Set()
  const activeStores = new Map()
  // Image custody is owned by this coordinator, never a Computers view.
  const imageRecoveryHosts = createAutomaticImageRecoveryHostRegistry()
  const closedSessions = new Set()
  const recoveredSessions = new Map()
  const sessionTextReader = createSessionTextReader()
  function retireRecoveredSession(sessionId) {
    sessionTextReader.clear(sessionId)
    recoveredSessions.delete(sessionId)
  }
  const queuedSends = new Set()
  const queuedCompletions = new Set()
  const continuationSeatRefusals = new Map()
  const continuationSeatTransportBackoff = new Map()
  /* ONE SWITCH OFFER PER REFUSED SESSION, keyed by the session that was
     refused and the code that refused it.

     MEASURED on this lane's own tests: pollContinuations runs from register(),
     and from a 5 s interval. Each read of unfinished work
     re-attempts the SAME unfinished continuation record and is refused again.
     Without this guard the offer was published on every sweep, so a person who
     pressed "Not now" had the dialog back within five seconds and could never
     put it away -- the dismissal was the one thing the dialog did not honour.
     The key is deliberately not the node alone: a genuinely new refusal (the
     session changed, or the reason did) is a new question and is asked again. */
  const switchOffersMade = new Map()
  const switchOfferKey = (sessionId, code) => JSON.stringify([sessionId, code])
  let disposed = false
  let unsubscribe = null, continuationTimer = null, continuationPolling = false
  let continuationContextRevision = 0, continuationReadFailures = 0, continuationReadStatus = null
  const CONTINUATION_READ_BACKOFF_MS = 30000, CONTINUATION_READ_BACKOFF_CAP_MS = 5 * 60000
  const continuationSeatStamp = (node, record) => ({
    sessionId: node?.sessionId || null,
    status: node?.status || null,
    key: record?.key || null,
    revision: record?.revision ?? null,
  })
  const sameContinuationSeatStamp = (stamp, node, record) => stamp
    && stamp.sessionId === (node?.sessionId || null)
    && stamp.status === (node?.status || null)
    && stamp.key === (record?.key || null)
    && stamp.revision === (record?.revision ?? null)
  function continuationSeatRetryBlocked(nodeId) {
    const retry = continuationSeatTransportBackoff.get(nodeId)
    return Boolean(retry && now() < retry.nextAttemptAt)
  }
  function rememberContinuationSeatTransportFailure(nodeId) {
    const previous = continuationSeatTransportBackoff.get(nodeId)
    const failures = Math.min(5, (previous?.failures || 0) + 1)
    continuationSeatTransportBackoff.set(nodeId, {
      failures,
      nextAttemptAt: now() + Math.min(CONTINUATION_READ_BACKOFF_CAP_MS,
        CONTINUATION_READ_BACKOFF_MS * 2 ** (failures - 1)),
    })
  }
  function forgetContinuationSeatMemoryForMissingNodes() {
    if (continuationSeatRefusals.size === 0 && continuationSeatTransportBackoff.size === 0) return
    const liveNodeIds = new Set()
    for (const context of contexts.values()) {
      // An unreadable store is not proof that a node went away: forget nothing this sweep.
      let nodes
      try { nodes = context.treeStore?.snapshot?.()?.nodes } catch { return }
      if (!Array.isArray(nodes)) return
      for (const node of nodes) if (node?.id) liveNodeIds.add(node.id)
    }
    for (const nodeId of continuationSeatRefusals.keys()) {
      if (!liveNodeIds.has(nodeId)) continuationSeatRefusals.delete(nodeId)
    }
    for (const nodeId of continuationSeatTransportBackoff.keys()) {
      if (!liveNodeIds.has(nodeId)) continuationSeatTransportBackoff.delete(nodeId)
    }
  }
  function notifyRecoverySettled(nodeId) {
    if (flights.has(nodeId)) return
    for (const listener of settledListeners) {
      try { listener({ nodeId, recoverySettled: true }) } catch { /* An observer cannot alter custody. */ }
    }
  }
  const publish = value => { for (const { listener } of listeners) { try { listener(value) } catch { /* a retired UI must not cancel recovery */ } } }
  function explicitlyAllowed(check) {
    try {
      const answer = check()
      if (typeof answer?.then === 'function') void Promise.resolve(answer).catch(() => {})
      return answer === true
    } catch { return false }
  }
  function assertStartAllowed(manual) {
    if (manual?.originValid && !manual.originValid()) throw new Error('This recovery choice changed before it could continue.')
    if (!explicitlyAllowed(canStart)) throw new Error('Starting agents is disabled on this computer.')
    if (manual && !explicitlyAllowed(canContinue)) throw new Error(MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY)
  }
  const sessionSafetyHeld = (nodeId, sessionId) =>
    (recoveredSessions.get(sessionId)?.nodeId === nodeId && recoveredSessions.get(sessionId)?.safetyRefused === true)
    || (sessionNodeIds.get(sessionId) === nodeId && sessionNodeIds.automaticTurnsHeld?.(sessionId) === true)
  const externalBlocks = new Map()
  const limitDecisions = new Set()
  const EXTERNAL_BLOCK_KIND = 'blocked-external'
  const MAX_BLOCK_NOTE = 240

  /* The provider's own sentence when one survived, and a plain one when it did
     not. Never a credential: only the event's person-facing text, the shell's
     verdict and the refusal code reach this. */
  /* NO IDENTIFIER REACHES THE PERSON. An earlier draft of this composed
     `The provider refused this turn (CODE)` when the provider sent a code and
     no prose, and tools/test/refusal-copy.test.mjs caught it by name: "no view
     or copy module interpolates a code into a string a person reads". That
     guard's fence is deliberately near-empty, so the fix is to stop printing
     the code, not to fence this file.
     refusalSentence() is not used here either, and that is a judgement rather
     than an oversight: its curated remedies for the limit codes are "Nothing
     was started" -- which is FALSE, a turn was just spent -- and, for an
     unrecognised code, "close ToolsEnabled and open it a second time", which
     is the advice the sibling test in that same suite exists to keep away from
     a person. Neither is true of an account limit, and both would blow the
     240-character note this composes into.
     The code still travels: blockExternally() records it on the block, where a
     support conversation and a driver can read it and a person does not --
     the same division markRefusalCode() makes in refusal-copy.js. */
  function limitReasonText(failure) {
    const spoken = [failure?.text, failure?.error?.message, failure?.reason]
      .find(value => typeof value === 'string' && value.trim())
    return spoken ? spoken.trim() : 'The provider reported an account or model limit for this turn.'
  }
  /* One clamp for every note this file writes to the tree, applied where the
     note is finally composed rather than in the middle of composing it. */
  const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim()
  const clampNote = text => oneLine(text).slice(0, MAX_BLOCK_NOTE)

  /* THE PROVIDER'S WORDS KEEP THEIR START AND THEIR END (follow-up V3). A
     provider's limit message ends with what a person most needs from it --
     "try again at Jun 8th, 2026 3:00 AM." -- so a message too long for its
     room loses its middle, at word boundaries where it has them, never its
     end. */
  function middleCut(text, room) {
    if (text.length <= room) return text
    if (room < 5) return ''
    const headRoom = Math.ceil((room - 3) / 2)
    const tailRoom = room - 3 - headRoom
    let head = text.slice(0, headRoom)
    let tail = text.slice(text.length - tailRoom)
    const headBreak = head.lastIndexOf(' ')
    if (headBreak > headRoom / 2) head = head.slice(0, headBreak)
    const tailBreak = tail.indexOf(' ')
    if (tailBreak >= 0 && tailBreak < tailRoom / 2) tail = tail.slice(tailBreak + 1)
    return `${head.trimEnd()} … ${tail.trimStart()}`
  }

  /* A BLOCK NOTE: the prefix, the provider's words, the closing, in 240
     characters. Whatever fits whole is kept whole. Otherwise the 1.0.47 rule
     holds -- the provider's words come first and the closing is what the
     limit cuts -- except for a closing that must survive (`keepClosing`, a
     pinned agent's next step, review P13), which is kept whole while the
     provider's words lose their middle. A provider message too long even on
     its own loses its middle too, so its retry time survives. */
  function blockNote(prefix, detail, closing, { keepClosing = false } = {}) {
    const words = oneLine(detail)
    const whole = oneLine(`${prefix}${words} ${closing}`)
    if (whole.length <= MAX_BLOCK_NOTE) return whole
    if (!keepClosing) {
      return prefix.length + words.length <= MAX_BLOCK_NOTE
        ? clampNote(whole)
        : `${prefix}${middleCut(words, MAX_BLOCK_NOTE - prefix.length)}`
    }
    const room = Math.max(0, MAX_BLOCK_NOTE - prefix.length - closing.length - 1)
    return clampNote(`${prefix}${middleCut(words, room)} ${closing}`)
  }

  /* The manager is the parent; the Controller is the root of this node's tree.
     One tree with no separate root yields one target, never a duplicate. */
  function escalationTargets(store, node) {
    const root = (store.listNodes(node.treeId) || []).find(row => row.parentId == null) || null
    const manager = node.parentId ? store.getNode(node.parentId) : null
    const out = []
    for (const target of [manager, root]) {
      if (target && target.id !== node.id && !out.some(row => row.id === target.id)) out.push(target)
    }
    return out
  }

  /* ONE NOTICE PER BLOCK EPISODE, NEVER ONE PER REFUSED DELIVERY. An
     escalation that repeats with every refusal is the same loop wearing a
     different hat, and it would spend the MANAGER's turns instead. */
  async function notifyEscalation(context, node, reason) {
    const told = []
    for (const target of escalationTargets(context.treeStore, node)) {
      if (!target.sessionId || !sessionNodeIds.has(target.sessionId)) continue
      const name = nodeDisplayName(node, context.treeStore.listNodes(node.treeId) || [])
      try {
        /* Escalation is an automatic notice, never a fresh person turn. The
           dedicated bridge is required; falling back to send() would reopen a
           paused/blocked Goal and misattribute recovery as owner intent. */
        if (typeof bridge.sendAutomatic !== 'function') {
          publish({ nodeId: node.id, error: 'AGENT_AUTOMATIC_SEND_UNAVAILABLE' })
          continue
        }
        /* ONLY THE PERSON MOVES IT TO ANOTHER ACCOUNT (1.0.50 review, accounts
           A). This notice used to end "It needs another model or account, or
           the person", which invited a manager to move its worker onto another
           of the person's accounts -- the automatic switching 1.0.50 removed.
           An agent's request to change another agent's account is refused
           (managed-slot-choice.js), and the notice now says why. */
        const sent = await bridge.sendAutomatic({ sessionId: target.sessionId,
          text: `${name} is blocked outside this app and has stopped taking turns. ${reason} It stays on its account. Only the person can choose another account for it.` })
        if (sent?.ok !== false) told.push(target.id)
      } catch (error) { publish({ nodeId: node.id, error: error.message || String(error) }) }
    }
    return told
  }

  function clearExternalBlock(nodeId) {
    if (!externalBlocks.delete(nodeId)) return false
    publish({ nodeId, externalBlock: null })
    return true
  }

  async function blockExternally(context, nodeId, reason, code = null) {
    if (externalBlocks.has(nodeId)) return externalBlocks.get(nodeId)
    const node = context.treeStore.getNode(nodeId)
    if (!node) return null
    const record = { blocked: true, kind: EXTERNAL_BLOCK_KIND, reason, since: now(), notified: [],
      /* The provider's identifier, carried and never rendered. `reason` is what
         a person reads; this is what a support conversation asks for. */
      code: typeof code === 'string' && code.trim() ? code.trim() : null }
    // Recorded BEFORE the notice goes out: the fence is what stops the loop,
    // and an escalation that hangs must not leave turns being spent meanwhile.
    externalBlocks.set(nodeId, record)
    // A renderer outlives many nodes and this map is only ever cleared by a
    // node recovering. Bounded like `seen` above, oldest first; the fence for
    // a node that has been blocked longer than 256 others is long stale.
    if (externalBlocks.size > 256) externalBlocks.delete(externalBlocks.keys().next().value)
    const marked = context.treeStore.setNodeStatus(nodeId, 'turn-failed', { note: clampNote(reason) })
    if (marked?.ok !== true) publish({ nodeId, error: 'The blocked reason could not be written to the tree.' })
    record.notified = await notifyEscalation(context, node, reason)
    publish({ nodeId, externalBlock: { ...record } })
    return record
  }

  async function handleAccountLimit(context, nodeId, detail, code = null) {
    if (limitDecisions.has(nodeId) || externalBlocks.has(nodeId) || flights.has(nodeId) || isReplacing(nodeId)) return
    limitDecisions.add(nodeId)
    try {
      await blockExternally(context, nodeId, blockNote('Usage limit reached: ', detail,
        'Wait for this account to reset, or use Switch and continue.', { keepClosing: true }), code)
    } finally { limitDecisions.delete(nodeId) }
  }
  function recoveredSessionRecord(context, sessionId) {
    let record = recoveredSessions.get(sessionId)
    if (!record) {
      const saved = context.transcriptStore.get(context.node.id)
      record = { nodeId: context.node.id, computerId: context.computerId, text: '',
        started: { sessionId, threadId: saved?.threadId, effort: saved?.effort, account: saved?.account } }
      recoveredSessions.set(sessionId, record)
    }
    return record
  }
  function hydrateSessionSafety(context, sessionId) {
    const record = recoveredSessionRecord(context, sessionId)
    if (record.safetyRead) return record.safetyRead
    const current = () => !disposed && recoveredSessions.get(sessionId) === record
      && contexts.get(context.computerId)?.treeStore === context.treeStore
      && sessionNodeIds.get(sessionId) === record.nodeId
      && context.treeStore.getNode(record.nodeId)?.sessionId === sessionId
    record.safetyRead = Promise.resolve().then(async () => {
      const checkpoint = context.handoffStore?.readRecord
        ? await context.handoffStore.readRecord(record.nodeId) : context.handoffStore?.get(record.nodeId)
      if (current() && checkpoint?.safetyHold?.nodeId === record.nodeId && checkpoint.safetyHold.sessionId === sessionId) record.safetyRefused = true
      if (typeof bridge.sessionActivity !== 'function') return { ok: true }
      return bridge.sessionActivity({ sessionId })
    }).then(activity => {
      if (!current()) return false
      if (activity?.ok !== true) throw new Error('The session safety state could not be read. Queued messages were retained.')
      if (activity.automaticTurnBlock?.code === 'PROVIDER_SAFETY_REFUSAL') {
        record.safetyRefused = true
      }
      return true
    }).catch(error => {
      if (current()) publish({ nodeId: record.nodeId, code: 'AGENT_SESSION_ACTIVITY_UNAVAILABLE', error: error.message || String(error) })
      return false
    }).then(known => {
      if (!known && recoveredSessions.get(sessionId) === record) record.safetyRead = null
      return known
    })
    return record.safetyRead
  }
  function observePacket(packet) {
    const sessionId = packet?.sessionId
    const context = find(sessionId)
    if (!context) { retireRecoveredSession(sessionId); return }
    const node = context.node
    const failure = packet?.event
    if (sessionSafetyRefusal(packet, sessionId) || /(?:PERMISSION|POLICY|AUTH|IDENTITY)/i.test(String(failure?.code || failure?.error?.code || ''))) {
      recoveredSessionRecord(context, sessionId).safetyRefused = true
      void Promise.resolve().then(async () => {
        const prior = await readHandoff(context, node.id)
        if (context.treeStore.getNode(node.id)?.sessionId !== sessionId) return
        const record = { ...prior, handoff: prior?.handoff || manualAccountHandoff(node, context.transcriptStore.get(node.id), prior),
          sessionId, safetyHold: { nodeId: node.id, sessionId } }
        const saved = context.handoffStore?.saveRecord ? await context.handoffStore.saveRecord(node.id, record) : context.handoffStore?.save(node.id, record)
        if (!saved) publish({ nodeId: node.id, error: 'The safety hold could not be saved. Review this conversation before resuming.' })
      }).catch(error => publish({ nodeId: node.id, error: error.message || String(error) }))
    }
    if (failure?.type === 'turn_completed' && ['failed', 'error'].includes(failure.status)
      && !sessionSafetyRefusal(packet, sessionId)) {
      const code = String(failure.code || failure.error?.code || '')
      if (!/(?:PERMISSION|POLICY|AUTH|IDENTITY)/i.test(code)
        && (failure.failureReason === 'account-limit' || /quota|usage.limit|rate.limit|ACCOUNT_LIMIT|ACCOUNT_EXHAUSTED/i.test(code))) {
        void handleAccountLimit(context, node.id, limitReasonText(failure), code || 'ACCOUNT_LIMIT_REACHED')
          .catch(error => publish({ nodeId: node.id, error: error.message }))
      }
    }
    for (const session of recoveredSessions.keys()) {
      if (!sessionNodeIds.has(session)) retireRecoveredSession(session)
    }
    // Every owned session needs an off-page observer, not only sessions this
    // coordinator replaced. The Computers listener is removed on navigation.
    const record = recoveredSessionRecord(context, sessionId)
    // A later explicit turn may succeed without releasing earlier queued work.
    if (sessionSafetyRefusal(packet, sessionId)) record.safetyRefused = true
    record.eventCount = (record.eventCount || 0) + 1
    const observed = [...listeners].some(({ observes }) => { try { return observes(record.nodeId) } catch { return false } })
    if (sessionEndedEvent(packet, sessionId)) {
      if (!observed) {
        if (['starting', 'running'].includes(node.status)) context.treeStore.setNodeStatus(node.id, 'turn-failed',
          { note: 'The agent session ended before this turn finished.' })
        sessionNodeIds.delete(sessionId)
      }
      retireRecoveredSession(sessionId)
      return
    }
    const turnId = sessionEventTurnId(packet, sessionId)
    const status = sessionTurnStatus(packet, sessionId)
    /* T124. A TURN THAT ACTUALLY LANDED IS THE PROOF THE BLOCK IS OVER. The
       allowance reset, the person continued the node somewhere else, or a
       retry found an account -- this surface does not need to know which. */
    if (sessionTurnSucceeded(status)) clearExternalBlock(node.id)
    if (turnId && record.completedTurnId === turnId) return
    if (!status && turnId && turnId !== record.turnId) {
      record.text = ''
      record.turnId = turnId
    }
    const speech = sessionTextReader.read(packet, sessionId)
    const delta = speech?.text
    if (delta) {
      if (turnId) record.turnId = turnId
      record.text = (record.text + (speech.breakBefore && record.text ? '\n\n' : '') + delta).slice(-48000)
    }
    if (!observed && !status && (delta || packet.event?.type === 'turn_started')
        && !['starting', 'running'].includes(node.status)) {
      context.treeStore.setNodeStatus(node.id, 'running', { note: '' })
    }
    if (!status) return
    if (!completionSettlesOpenTurn(packet, sessionId, record.turnId)) return
    if (!turnId && !record.text && !['starting', 'running'].includes(node.status)) return
    record.completedTurnId = turnId || null
    if (!observed) {
      const reply = record.text || sessionTurnFailureText(packet, sessionId) || ''
      const saved = context.transcriptStore.get(record.nodeId)
      saveTranscript(context, record.nodeId, { ...saved,
        lines: [...(saved?.lines || []), ...(reply ? [{ who: 'agent', text: reply, at: Date.now(),
          ...(turnId ? { id: `agent:${sessionId}:${turnId}`, turnStamp: turnId } : {}) }] : [])], keepUnknown: true })
      context.treeStore.setNodeReply(record.nodeId, reply)
      const outcome = recoveredNodeTurnStatus(node, status, turnId)

      const blockNote = externalBlocks.get(record.nodeId)?.reason || ''
      context.treeStore.setNodeStatus(record.nodeId, outcome,
        { note: outcome === 'finished' ? '' : outcome === 'interrupted' ? 'Stopped by you.'
          : outcome === 'cancelled' ? TURN_CANCELLED.note : (blockNote || reply), turnId: turnId || null })
    }
    record.text = ''
    record.turnId = null
    // An interrupted/failed turn never restarts unseen. Successful completions
    // release exactly one already queued owner message, as the visible page does.
    if (!observed && sessionTurnSucceeded(status)) void drainQueued(context, sessionId)
  }
  function saveTranscript(context, nodeId, record) {
    try {
      const saved = context.transcriptStore.save(nodeId, record)
      if (saved?.then) saved.catch(error => publish({ nodeId, error: error.message || String(error) }))
    } catch (error) { publish({ nodeId, error: error.message || String(error) }) }
  }
  async function drainQueued(context, sessionId) {
    if (!await hydrateSessionSafety(context, sessionId)) return
    if (disposed || contexts.get(context.computerId)?.treeStore !== context.treeStore) return
    if (!outbox || !explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)) return
    if (queuedSends.has(sessionId)) { queuedCompletions.add(sessionId); return }
    const node = context.treeStore.getNode(context.node.id)
    if (node?.sessionId !== sessionId || sessionNodeIds.get(sessionId) !== node.id || node.status !== 'finished') return
    /* T124. A BLOCKED NODE IS NOT A FREE NODE. Releasing a queued message into
       a session whose provider is refusing on a limit spends a turn to earn
       the same refusal, which is the loop. The message stays queued, exactly
       as it does for a busy node, and goes out when the block clears. */
    if (externalBlocks.has(node.id) || recoveredSessions.get(sessionId)?.safetyRefused) return
    if (typeof bridge.sendAutomatic !== 'function') {
      publish({ nodeId: node.id, code: 'AGENT_AUTOMATIC_SEND_UNAVAILABLE',
        error: 'Automatic sending is unavailable, so the queued message was kept. Open this agent and press Send to send it yourself.' })
      return
    }
    const entry = outbox.takeNext(sessionId)
    if (!entry) return
    queuedSends.add(sessionId)
    const at = Date.now()
    context.treeStore.setNodeStatus(node.id, 'running', { note: '' })
    const attempted = context.treeStore.getNode(node.id)
    const eventCount = recoveredSessions.get(sessionId)?.eventCount
    let delivered = false
    try {
      const model = context.sessionModelOverrides?.get(sessionId)
      if (recoveredSessions.get(sessionId)?.safetyRefused) {
        throw Object.assign(new Error('The provider safety refusal keeps queued messages on hold.'), {
          code: 'PROVIDER_SAFETY_REFUSAL', deliveryDisposition: 'not-sent',
        })
      }
      const delivery = await bridge.sendAutomatic({ sessionId, text: entry.text, ...(model ? { model } : {}) })
      if (delivery?.ok !== true || delivery.deliveryDisposition !== 'accepted'
        || !delivery.result || typeof delivery.result !== 'object' || Array.isArray(delivery.result) || delivery.result.ok === false) {
        throw Object.assign(new Error(delivery?.code === 'PROVIDER_SAFETY_REFUSAL'
          ? 'The provider safety refusal keeps queued messages on hold.'
          : delivery?.reason || delivery?.message || 'The queued message delivery could not be confirmed.'), {
          code: delivery?.code || 'AGENT_AUTOMATIC_DELIVERY_UNCONFIRMED',
          deliveryDisposition: delivery?.ok === false && delivery.deliveryDisposition === 'not-sent' ? 'not-sent' : 'unknown',
        })
      }
      const sent = delivery.result
      outbox.confirmDelivered(sessionId, entry)
      delivered = true
      if (context.treeStore.getNode(node.id)?.sessionId === sessionId) {
        const saved = context.transcriptStore.get(node.id)
        const turnStamp = typeof sent?.turnId === 'string' ? sent.turnId : null
        saveTranscript(context, node.id, { ...saved, keepUnknown: true,
          lines: [...(saved?.lines || []), { who: 'you', text: entry.text, at,
            ...(turnStamp ? { turnStamp, id: `you:${sessionId}:${turnStamp}` } : {}) }] })
      }
    } catch (error) {
      const held = recoveredSessions.get(sessionId)
      if (error?.code === 'PROVIDER_SAFETY_REFUSAL' && held) held.safetyRefused = true
      // Only a tracked non-delivery can be retried automatically. An uncertain
      // receipt retains the visible entry without risking duplicate dispatch.
      const unconfirmed = error?.deliveryDisposition !== 'not-sent'
      outbox.requeueFront(sessionId, unconfirmed ? { ...entry, deliveryUnconfirmed: true } : entry)
      const latest = context.treeStore.getNode(node.id)
      if (latest?.sessionId === sessionId && latest.status === 'running'
          && latest.runStartedAt === attempted.runStartedAt
          && recoveredSessions.get(sessionId)?.eventCount === eventCount) {
        context.treeStore.setNodeStatus(node.id, 'finished', { note: unconfirmed
          ? 'The queued message delivery could not be confirmed.' : 'The queued message was not sent.' })
      }
      publish({ nodeId: node.id, code: error?.code, error: error.message || String(error) })
    } finally {
      queuedSends.delete(sessionId)
      // A very short queued turn can complete before send() acknowledges it.
      // Its completion still releases the next entry exactly once.
      const completedDuringSend = queuedCompletions.delete(sessionId)
      if (delivered && completedDuringSend) void drainQueued(context, sessionId)
    }
  }
  const find = sessionId => {
    const nodeId = sessionNodeIds.get(sessionId)
    if (!nodeId) return null
    for (const context of contexts.values()) {
      const node = context.treeStore.getNode(nodeId)
      if (node?.sessionId === sessionId) return { ...context, node }
    }
    return null
  }
  function address(store, node) {
    const anchors = []
    const visited = new Set()
    let current = node
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      anchors.unshift(current.id)
      current = current.parentId ? store.getNode(current.parentId) : null
    }
    const name = item => nodeDisplayName(item, store.listNodes(item.treeId))
    const parent = node.parentId ? store.getNode(node.parentId) : null
    return {
      requestKeys: { threadId: node.id, treeAnchors: anchors.slice(-16) },
      treeIdentity: { selfName: name(node), managerName: parent ? name(parent) : null },
      childNames: store.childrenOf(node.id).map(name),
    }
  }

  /* Automatic reopen owns the same organisation admission door as Start. The
     saved continuation catalogue is not proof that a node still has its seat:
     an earlier sweep may have released it while the tree store was empty. Read
     the current organisation first, reuse an exact enabled seat when present,
     and otherwise ask the same id/role/provider/manager/nodeId shape Start uses.
     A refusal is thrown into pollContinuations' existing visible refusal path,
     before the trusted native resume request is made. */
  async function ensureSeatForSavedContinuation(context, node, record) {
    const refuse = (reason, code = 'MC_TREE_IDENTITY_UNAVAILABLE', seatFailureKind = 'terminal') => {
      throw Object.assign(new Error(reason), { code, seatFailureKind })
    }
    if (typeof orgBridge?.read !== 'function' || typeof orgBridge?.ensureSeat !== 'function') {
      refuse('This installed copy cannot give a tree circle a declared identity. Update the app, then try again.',
        'MC_TREE_IDENTITY_UNAVAILABLE', 'transport')
    }
    let snapshot
    try {
      snapshot = await orgBridge.read()
    } catch (error) {
      refuse('The organisation could not be read, so this agent was not resumed. Reload this page, then try again.',
        'MC_TREE_IDENTITY_UNAVAILABLE', 'transport')
    }
    if (snapshot?.ok !== true || !snapshot.org || !Array.isArray(snapshot.org.agents) || !Array.isArray(snapshot.roles)) {
      refuse('The organisation could not be read, so this agent was not resumed. Reload this page, then try again.',
        'MC_TREE_IDENTITY_UNAVAILABLE', 'transport')
    }
    const role = identityRoleForTreeNode(node?.role)
    const roleRecord = snapshot.roles.find(row => row?.id === role)
    if (!roleRecord) {
      refuse('The role needed to give this agent a declared identity is no longer in the Role library. Reload this page, then try again.', 'MC_TREE_IDENTITY_ROLE_UNKNOWN')
    }
    const agents = snapshot.org.agents
    const selectedRole = typeof node?.role === 'string' ? node.role.trim() : ''
    const tierId = record?.descriptor?.tier || node?.tier
    const tier = tiers.find(row => row.id === tierId)
    const provider = tier && ['codex', 'claude', 'gemini', 'grok', 'local'].includes(tier.provider) ? tier.provider : undefined
    const rootSeat = roleRecord.capabilities?.orgRoot === true
      ? agents.filter(agent => agent?.enabled === true && agent.role === role).length === 1
        ? agents.find(agent => agent?.enabled === true && agent.role === role) : null
      : null
    if (!rootSeat && agents.some(agent => agent?.id === node.id && agent.role === role && agent.enabled === true
      && (agent.roleSelection === '' ? '' : agent.role) === selectedRole
      && (!provider || agent.provider === provider))) {
      return { ok: true, unchanged: true, org: snapshot.org }
    }
    const parentSeat = !rootSeat && node.parentId
      && agents.some(agent => agent?.id === node.parentId && agent.enabled === true)
      ? node.parentId
      : undefined
    let result = null
    try {
      result = await orgBridge.ensureSeat({
        id: rootSeat ? rootSeat.id : node.id,
        role,
        ...(role === 'worker' ? { roleSelection: selectedRole } : {}),
        ...(provider ? { provider } : {}),
        ...(rootSeat || provider ? { adoptProvider: true } : {}),
        ...(rootSeat ? {} : { displayName: nodeDisplayName(node, context.treeStore.listNodes(node.treeId) || []) }),
        ...(parentSeat ? { managerId: parentSeat } : {}),
        ...(rootSeat ? {} : { nodeId: node.id }),
        expectedRevision: snapshot.org.revision,
      })
    } catch (error) {
      refuse('The organisation seat could not be confirmed, so this agent was not resumed. Reload this page, then try again.',
        'MC_TREE_IDENTITY_UNAVAILABLE', 'transport')
    }
    if (result?.ok === true) return result
    refuse(result?.reason || 'This agent could not be given a declared identity, so it was not resumed. Reload this page, then try again.',
      result?.code || 'MC_TREE_IDENTITY_UNAVAILABLE')
  }

  // A view-owned choice may expire without changing the durable node revision.
  // Missing guards preserve existing callers; malformed/throwing guards refuse.
  function currentChoice(isCurrent) {
    if (isCurrent === undefined) return true
    try { return typeof isCurrent === 'function' && isCurrent() === true }
    catch { return false }
  }

  function assertAutomaticSendAvailable() {
    if (typeof bridge.sendAutomatic !== 'function') {
      throw Object.assign(new Error('AGENT_AUTOMATIC_SEND_UNAVAILABLE'), { code: 'AGENT_AUTOMATIC_SEND_UNAVAILABLE' })
    }
  }

  async function continueManually(packet, manual) {
    const event = packet?.event
    if (event?.type !== 'manual_continuation' || typeof event.recoveryId !== 'string'
      || typeof event.handoff !== 'string' || !event.handoff.trim()) return
    const registered = manual ? contexts.get(manual.computerId) : null
    const manualNode = registered?.treeStore.getNode(manual?.nodeId)
    const context = manual ? (manualNode?.sessionId === packet.sessionId ? { ...registered, node: manualNode } : null) : null
    if (!context || seen.has(event.recoveryId)) return
    const entryOwnership = manual?.cleanupOwnership
    if (entryOwnership && (context.node.createdAt !== entryOwnership.expectedNodeCreatedAt
      || context.node.sessionId !== entryOwnership.expectedNodeSessionId)) return false
    let cleanupOwnership = entryOwnership || Object.freeze({ expectedNodeCreatedAt: context.node.createdAt, expectedNodeSessionId: packet.sessionId })
    if (flights.has(context.node.id)) return
    const { treeStore, transcriptStore, handoffStore, node } = context
    // An explicit replacement already owns this node. It wins over the offer;
    // the host ticket remains pending if that replacement later refuses.
    if (isReplacing(node.id)) return
    flights.add(node.id)
    const retained = activeStores.get(context.computerId) || { store: treeStore, count: 0 }
    retained.count += 1
    activeStores.set(context.computerId, retained)
    seen.add(event.recoveryId)
    // Tickets are bounded in the host; this only suppresses duplicate delivery.
    if (seen.size > 256) seen.delete(seen.values().next().value)
    let started = null
    let ownedSessionId = packet.sessionId
    let handoffDispatched = false
    let handoffAccepted = false
    let imagePrepared = null
    let imagePreparedHost = null
    let imageRecovered = null
    let imageRecoveryTransferred = false
    let imageRecoveryRefused = null
    let initialStoppedChoice = noteMeansStopped(node.statusNote)
    const recoveryCurrent = () => !disposed
      && treeStore.getNode(node.id)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
      && treeStore.getNode(node.id)?.sessionId === ownedSessionId
      && (initialStoppedChoice || !noteMeansStopped(treeStore.getNode(node.id)?.statusNote))
      && (!manual?.originValid || manual.originValid())

    const assertRecoveryCurrent = () => {
      if (sessionSafetyHeld(node.id, packet.sessionId)) throw Object.assign(new Error('This conversation is held for review. Continuing cannot resume it.'), { code: 'AGENT_CONTINUATION_HELD_FOR_REVIEW' })
      if (!recoveryCurrent()) throw Object.assign(new Error('This recovery was stopped or its conversation changed.'), { code: 'RECOVERY_CANCELLED' })
      assertStartAllowed(manual)
    }
    const imageAuthorityBinding = () => imageRecovered?.sourceBinding || imagePrepared?.sourceBinding || null
    const imageAuthorityCurrent = binding => {
      if (!imagePrepared?.sourceBinding || !imagePreparedHost || !binding) return false
      let host = null
      let snapshot = null
      try {
        host = imageRecoveryHosts.get(context.computerId)
        snapshot = host?.ownerSnapshot?.()
      } catch { return false }
      return Boolean(host === imagePreparedHost && snapshot?.status === 'ready'
        && sameImageOwnerContext(binding.ownerContext, imagePrepared.sourceBinding.ownerContext)
        && sameImageOwnerContext(snapshot.ownerContext, imagePrepared.sourceBinding.ownerContext))
    }
    const assertImageRecoveryAuthority = (binding = imageAuthorityBinding()) => {
      if (!imagePrepared || imageAuthorityCurrent(binding)) return
      throw Object.assign(new Error('The retained image recovery lost its owner authority.'), {
        code: 'IMAGE_RECOVERY_AUTHORITY_CHANGED',
        imageRecoveryRefused: true,
        imageRecoveryAuthorityRefused: true,
      })
    }
    const retainImageRecoveryRefusal = (result, fallbackCode, { allowPreDispatchSourceChanged = false } = {}) => {
      const code = result?.code || fallbackCode
      assertImageRecoveryAuthority(result?.sourceBinding || imagePrepared?.sourceBinding)
      if (!isProvenImageOnlyRefusal(result, { allowPreDispatchSourceChanged })) {
        throw Object.assign(new Error(result?.reason || 'The retained image recovery could not be confirmed.'), {
          code,
          imageRecoveryRefused: true,
          imageRecoveryAuthorityRefused: IMAGE_RECOVERY_AUTHORITY_REFUSAL_CODES.has(code),
        })
      }
      imageRecoveryRefused = code
      imageRecovered = null
      imageRecoveryTransferred = false
    }
    const publishImageRecoveryNotice = () => {
      if (!imageRecoveryRefused) return
      assertRecoveryCurrent()
      assertImageRecoveryAuthority()
      const note = ['Continuing from the saved handoff. Retained images were kept because they could not be sent yet.', accountClearedNote]
        .filter(Boolean).join(' ')
      const updated = treeStore.setNodeStatus(node.id, 'running', { note })
      if (updated?.ok !== true || updated.snapshot?.persistenceFailed) {
        throw new Error(updated?.snapshot?.persistenceProblem || 'The retained image warning could not be saved.')
      }
      publishedRecoveryStatus = { status: 'running', note }
      publish({ nodeId: node.id, imageRecoveryRefused })
    }
    // Set inside the try, read by the catch: what the node looked like while
    // it was still live, and whether this path left its session running.
    let liveBefore = null
    let hostClosesPredecessor = false
    let publishedRecoveryStatus = null
    /* Said on the continuation line when a move to another provider cleared
       the agent's saved account (follow-up V6); '' otherwise. */
    let accountClearedNote = ''
    try {
      assertRecoveryCurrent()
      const priorSafety = await readHandoff(context, node.id)
      if (priorSafety?.safetyHold?.nodeId === node.id && priorSafety.safetyHold.sessionId === packet.sessionId) {
        throw Object.assign(new Error('This conversation is held for review. Continuing cannot resume it.'), { code: 'AGENT_CONTINUATION_HELD_FOR_REVIEW' })
      }
      if (sessionNodeIds.has(packet.sessionId) && !await hydrateSessionSafety(context, packet.sessionId)) throw new Error('The session safety state could not be read. No continuation was started.')
      assertRecoveryCurrent()
      assertAutomaticSendAvailable()
      const saved = transcriptStore.readLatest ? await transcriptStore.readLatest(node.id) : transcriptStore.get(node.id)
      assertRecoveryCurrent()
      const handoff = event.handoff.slice(0, 48000)
      /* Through the per-node file store when the shell offers it, the settings
         record when it does not — the same capability check `transcriptStore`
         uses two lines above, for the same reason. A handoff is up to 48,000
         characters and the settings record is bounded at 1 MiB, so this is the
         write that was refused first once the record filled. */
      const record = { handoff, sessionId: packet.sessionId, recoveryId: event.recoveryId,
        ...(manual ? { kind: 'manual' } : {}) }
      const handoffSaved = handoffStore?.saveRecord
        ? await handoffStore.saveRecord(node.id, record)
        : handoffStore?.save(node.id, record)
      assertRecoveryCurrent()
      if (!handoffSaved) {
        throw new Error('Could not save the full recovery handoff.')
      }
      /* T377 item 8: the transcript gets ONE compact continuation line, not the
       * whole handoff inlined. The full handoff is already durable in
       * handoffStore (saved just above) and is still SENT to the replacement
       * (composeNodeBrief -> bridge.send, below), so the context channel is
       * untouched; what changes is that the chat no longer re-renders the prior
       * conversation as a giant action line on every recovery (17 today = the
       * repeats the owner saw). The `tool` label 'Recovery handoff' is kept -- it
       * survives the transcript store's cleanLine and is what the carry order,
       * the t158 gate and the chat's continuation rendering read; the full
       * handoff stays in handoffStore, keyed by this node, for anything that
       * needs it. */
      const continuationSummary = manual.sameAccountReset
        ? 'Continued on the same account after the reset time you chose.'
        : 'Continued on another ' + (manual?.modelContinuation ? 'model' : 'account')
          + ' by your choice. The full handoff is kept with this conversation.'
      const checkpointTranscript = transcriptStore.get(node.id) || saved
      const lines = [...(checkpointTranscript?.lines || []), { who: 'action', tool: 'Recovery handoff', state: 'done',
        text: continuationSummary, at: Date.now() }]
      // Save before closing. A storage refusal must never discard the only handoff.
      assertRecoveryCurrent()
      const saving = transcriptStore.save(node.id, { ...checkpointTranscript, lines, keepUnknown: true })
      if (!(saving?.then ? await saving : saving)) throw new Error('Could not save the conversation for recovery.')
      assertRecoveryCurrent()
      const before = treeStore.getNode(node.id)
      liveBefore = before ? { status: before.status, statusNote: before.statusNote || '' } : null
      const pending = treeStore.setNodeStatus(node.id, 'starting', { note: manual?.modelContinuation ? 'Continuing on another model…' : 'Continuing on another account…' })
      if (!pending?.ok || pending.snapshot?.persistenceFailed) {
        throw new Error(pending?.snapshot?.persistenceProblem || pending?.problems?.[0] || 'Could not save the recovery state.')
      }
      publishedRecoveryStatus = { status: 'starting', note: manual?.modelContinuation ? 'Continuing on another model…' : 'Continuing on another account…' }
      initialStoppedChoice = false

      hostClosesPredecessor = manual?.modelContinuation === true || manual?.sameAccountReset === true
      if (context.imageRecovery?.available === true) {
        assertRecoveryCurrent()
        // Capture the producer host before invoking prepare. prepare() crosses
        // an asynchronous owner/read boundary; reading the registry only after
        // await could capture a replacement host rather than the one that
        // created the returned source binding.
        imagePreparedHost = imageRecoveryHosts.get(context.computerId)
        if (!imagePreparedHost) {
          throw Object.assign(new Error('The retained image recovery host is unavailable.'), {
            code: 'IMAGE_RECOVERY_HOST_UNAVAILABLE', imageRecoveryRefused: true,
          })
        }
        imagePrepared = await imageRecoveryHosts.prepare(context.computerId, {
          nodeId: node.id,
          conversationId: node.id,
          sourceSessionId: packet.sessionId,
          expectedNodeCreatedAt: cleanupOwnership.expectedNodeCreatedAt,
          sourceIdentity: { sessionId: packet.sessionId, nodeId: node.id },
          isCurrent: recoveryCurrent,
        })
        assertRecoveryCurrent()
        if (imageRecoveryHosts.get(context.computerId) !== imagePreparedHost) {
          throw Object.assign(new Error('The retained image recovery host changed during preparation.'), {
            code: 'IMAGE_RECOVERY_HOST_CHANGED', imageRecoveryRefused: true,
            imageRecoveryAuthorityRefused: true,
          })
        }
        if (imagePrepared?.ok !== true) {
          throw Object.assign(new Error(imagePrepared?.reason || 'The retained image recovery could not be bound.'), {
            code: imagePrepared?.code || 'IMAGE_RECOVERY_REFUSED', imageRecoveryRefused: true,
          })
        }
        // Authority is tied to the exact registry host that produced the
        // prepare-time binding. A replacement host with the same owner tuple
        // is not the same custody authority.
        assertImageRecoveryAuthority(imagePrepared.sourceBinding)
      }
      if (!hostClosesPredecessor && !closedSessions.has(packet.sessionId) && (!manual || sessionNodeIds.has(packet.sessionId))) {
        assertRecoveryCurrent()
        const closed = await bridge.close({ sessionId: packet.sessionId })
        if (closed && (closed.closed !== true || closed.ok === false
          || closed.sessionId !== packet.sessionId)) throw new Error('The old session could not be closed.')
        if (!closed) throw new Error('The old session could not be closed.')
        if (closed?.closed === true) {
          closedSessions.add(packet.sessionId)
          // The close receipt remains authoritative if the chooser expired
          // during that await. Retire only this predecessor's own mapping.
          retireCleanupMapping(context, node.id, packet.sessionId, cleanupOwnership)
          if (recoveredSessions.get(packet.sessionId)?.nodeId === node.id) retireRecoveredSession(packet.sessionId)
        }
        if (closedSessions.size > 256) closedSessions.delete(closedSessions.values().next().value)
      }
      const current = treeStore.getNode(node.id)
      if (!current || current.sessionId !== packet.sessionId) throw new Error('This agent changed before recovery could start.')
      const identity = address(treeStore, current)
      const requestedSessionId = globalThis.crypto.randomUUID()
      const retainCleanup = () => {
        started = { sessionId: requestedSessionId, cleanupPending: true }
        retainCancelledCleanup(context, node.id, requestedSessionId, cleanupOwnership)
        if (closedSessions.has(packet.sessionId)) retireCleanupMapping(context, node.id, packet.sessionId, cleanupOwnership)
      }
      try {
        // Closing the predecessor can wait on its process. The earlier consent
        // observation cannot authorize a replacement after that wait.
        assertRecoveryCurrent()
        assertRecoveryCurrent()
        started = await bridge.start({ sessionId: requestedSessionId, surface: 'fleet-tree', ...(packet.sessionId ? { replacesSessionId: packet.sessionId } : {}),
          /* A model continuation (owner request T137) names no account to move
             away from: the ordinary start picks the account for the chosen
             tier, the current one included. */
          ...manual.startOptions,
          ...(treeStore.getTree?.(node.treeId)?.researchProjectId ? { researchProjectId: treeStore.getTree(node.treeId).researchProjectId } : {}),
          requestKeys: identity.requestKeys, treeIdentity: identity.treeIdentity })
      } catch (error) {
        if (refusalCode(error) === 'AGENT_SESSION_CLEANUP_FAILED') retainCleanup()
        throw error
      }
      if (started?.ok === false && refusalCodeOf(started) === 'AGENT_SESSION_CLEANUP_FAILED') {
        retainCleanup()
        throw new Error('The incomplete replacement still needs cleanup. Use Stop on this agent.')
      }
      if (!started?.sessionId || started.ok === false) {
        const reason = started?.reason || started?.message || 'No replacement account is available.'
        const refusal = Object.assign(new Error(reason), { code: started?.code })
        started = null
        throw refusal
      }
      if (manual.startOptions?.treeAccount && started.account !== manual.startOptions.treeAccount) {
        await closeReplacementSession(context, node.id, started.sessionId, cleanupOwnership)
        throw new Error('The continuation did not use the account you chose. It was stopped.')
      }
      if (manual.sameAccountReset && (started.account !== manual.account || started.threadId !== manual.startOptions.resumeThreadId || started.resumed !== true)) {
        await closeReplacementSession(context, node.id, started.sessionId, cleanupOwnership)
        throw new Error('The reset continuation did not preserve its saved account and thread. It was stopped.')
      }
      // A successful replacement receipt proves the host retired its predecessor.
      // Retain that fact even if this chooser expires before attachment.
      if (hostClosesPredecessor && packet.sessionId) {
        closedSessions.add(packet.sessionId)
        if (closedSessions.size > 256) closedSessions.delete(closedSessions.values().next().value)
      }
      if (closedSessions.has(packet.sessionId)) {
        retireCleanupMapping(context, node.id, packet.sessionId, cleanupOwnership)
        if (recoveredSessions.get(packet.sessionId)?.nodeId === node.id) retireRecoveredSession(packet.sessionId)
      }
      if (!recoveryCurrent()) {
        try { await closeReplacementSession(context, node.id, started.sessionId, cleanupOwnership) }
        catch (error) {
          started.cleanupPending = true
          publish({ nodeId: node.id, error: error.message })
          throw error
        }
        throw new Error('The continuation choice changed.')
      }
      if (manual?.startOptions?.effort && !started.effort) started = { ...started, effort: manual.startOptions.effort }
      const latest = treeStore.getNode(node.id)
      if (!latest || latest.sessionId !== packet.sessionId) {
        await bridge.close({ sessionId: started.sessionId })
        started = null
        throw new Error('This agent changed while recovery was starting.')
      }
      sessionNodeIds.set(started.sessionId, node.id)
      const attached = treeStore.attachSession(node.id, started.sessionId)
      if (!attached?.ok && !attached?.runtimeUpdated) {
        sessionNodeIds.delete(started.sessionId)
        await bridge.close({ sessionId: started.sessionId })
        started = null
        throw new Error('The replacement could not be attached to its agent.')
      }
      // Only this recovery's validated attachment may advance cleanup ownership.
      const attachedNode = treeStore.getNode(node.id)
      if (attachedNode?.createdAt !== cleanupOwnership.expectedNodeCreatedAt || attachedNode?.sessionId !== started.sessionId) {
        throw new Error('This agent changed while its replacement was attaching.')
      }
      ownedSessionId = started.sessionId
      cleanupOwnership = Object.freeze({ ...cleanupOwnership, expectedNodeSessionId: ownedSessionId })
      if (imagePrepared && context.imageRecovery?.available === true) {
        assertRecoveryCurrent()
        assertImageRecoveryAuthority(imagePrepared.sourceBinding)
        imageRecovered = await imageRecoveryHosts.recover(context.computerId, {
          nodeId: node.id,
          conversationId: node.id,
          sourceSessionId: packet.sessionId,
          destinationSessionId: started.sessionId,
          expectedNodeCreatedAt: cleanupOwnership.expectedNodeCreatedAt,
          sourceBinding: imagePrepared.sourceBinding,
          validatedSuccessor: true,
          isCurrent: recoveryCurrent,
        })
        assertRecoveryCurrent()
        if (imageRecovered?.ok !== true || imageRecovered?.reconcile === true) {
          retainImageRecoveryRefusal(imageRecovered, imageRecovered?.reconcile === true
            ? 'IMAGE_RECOVERY_TRANSFER_RECONCILE_REQUIRED' : 'IMAGE_RECOVERY_TRANSFER_REFUSED',
          { allowPreDispatchSourceChanged: true })
        } else {
          assertImageRecoveryAuthority(imageRecovered.sourceBinding)
          imageRecoveryTransferred = imageRecovered.transferred === true || imageRecovered.alreadyTransferred === true
        }
      }
      sessionNodeIds.delete(packet.sessionId)
      retireRecoveredSession(packet.sessionId)
      recoveredSessions.set(started.sessionId, { nodeId: node.id, computerId: context.computerId, started, text: '' })
      if (packet.sessionId) moveOutbox(packet.sessionId, started.sessionId)
      let latestIdentity = address(treeStore, treeStore.getNode(node.id))
      for (let attempt = 0; attempt < 3 && typeof bridge.updateTreeAddress === 'function'; attempt += 1) {
        assertRecoveryCurrent()
        assertImageRecoveryAuthority()
        const updated = await bridge.updateTreeAddress({ sessionId: started.sessionId,
          treeKey: latestIdentity.requestKeys.treeAnchors[0], ...latestIdentity.treeIdentity,
          requestKeys: latestIdentity.requestKeys })
        assertRecoveryCurrent()
        assertImageRecoveryAuthority()
        if (updated?.ok === false) throw new Error('The replacement reporting address could not be updated.')
        const currentNode = treeStore.getNode(node.id)
        if (currentNode?.sessionId !== started.sessionId) throw new Error('This agent changed before its handoff was sent.')
        const actual = address(treeStore, currentNode)
        if (JSON.stringify(actual) === JSON.stringify(latestIdentity)) break
        if (attempt === 2) throw new Error('The reporting relationship is still changing. Retry when the move finishes.')
        latestIdentity = actual
      }
      const text = composeNodeBrief({ message: handoff, selfName: latestIdentity.treeIdentity.selfName,
        parentName: latestIdentity.treeIdentity.managerName, childNames: latestIdentity.childNames })
      const currentTranscript = transcriptStore.get(node.id)
      /* T377 item 8: `text` (the composed handoff) is still SENT to the
       * replacement (bridge.send, below) and the handoff is durable in
       * handoffStore -- the context channel is intact. It is NOT appended to the
       * transcript as a `who: 'you'` line, because that rendered the whole prior
       * conversation a second time, as if the person had typed it. The compact
       * action line appended above is the single continuation line the chat
       * shows. The save still runs to record the replacement's threadId,
       * account and effort. */
      const nextLines = [...(currentTranscript?.lines || lines)]
      assertRecoveryCurrent()
      const recording = transcriptStore.save(node.id, { ...currentTranscript, lines: nextLines, threadId: started.threadId || null,
        effort: started.effort || currentTranscript?.effort || null, account: started.account ?? null,
        ...(manual.modelContinuation ? { provider: tiers.find(tier => tier.id === manual.startOptions.tier)?.provider } : {}), keepUnknown: false })
      const recorded = recording?.then ? await recording : recording
      assertRecoveryCurrent()
      publish({ nodeId: node.id, previousSessionId: packet.sessionId, started, lines: nextLines })
      if (!recorded) throw new Error('Could not save the replacement session and handoff.')
      if (manual.modelContinuation) {
        /* The node's tier is what the card, the chip and the next Resume read;
           after a model continuation it must name the tier that is actually
           running, or the person is shown the model they just left. */
        assertRecoveryCurrent()
        /* ANOTHER PROVIDER TAKES NOT THE OLD ACCOUNT (review P7, D5). Account
           names belong to one provider; a managed slot's saved account of the
           old provider survived a model continuation, and its next Resume was
           refused as TREE_ACCOUNT_CHOICE_UNAVAILABLE. Cleared here, as the
           next-model menu and set-node-provider already do. */
        const continuedProvider = tiers.find(tier => tier.id === manual.startOptions.tier)?.provider || null
        const savedAccountProvider = treeStore.getNode(node.id)?.accountChoice?.provider || null
        const clearsAccount = Boolean(savedAccountProvider && continuedProvider && savedAccountProvider !== continuedProvider)
        const changed = treeStore.setNodeLaunchPreferences(node.id, { tier: manual.startOptions.tier, effort: manual.startOptions.effort,
          model: manual.startOptions.model ?? null, nextModelChoice: null,
          ...(clearsAccount ? { accountChoice: null } : {}) })
        if (changed?.ok !== true || changed.snapshot?.persistenceFailed) throw new Error('The actual replacement model could not be saved.')
        /* AND IT IS SAID, NOT DONE IN SILENCE (follow-up V6): the next-model
           menu says the same sentence when a person makes the same move. */
        if (clearsAccount) accountClearedNote = MODEL_PANEL.accountCleared(continuedProvider)
      }
      assertRecoveryCurrent()
      const continuingNote = ['Continuing from the saved handoff.', accountClearedNote].filter(Boolean).join(' ')
      treeStore.setNodeStatus(node.id, 'running', { note: continuingNote })
      publishedRecoveryStatus = { status: 'running', note: continuingNote }
      assertRecoveryCurrent()
      assertAutomaticSendAvailable()
      // Transcript persistence above can await owner/host disposal. Re-check
      // the prepared custody authority at the publication boundary so a
      // changed owner cannot receive a handoff from stale recovery state.
      assertImageRecoveryAuthority()
      handoffDispatched = true
      let delivery
      const deliveryOutcome = value => value?.deliveryDisposition === 'not-sent' && value?.ok === false ? 'refused'
        : value?.deliveryDisposition === 'accepted' ? 'accepted' : 'unknown'
      try { delivery = await bridge.sendAutomatic({ sessionId: started.sessionId, text }) }
      catch (error) {
        // Transport failure or a code alone cannot prove that dispatch did not
        // happen. Only the trusted tracked disposition establishes non-delivery.
        throw Object.assign(new Error(error?.message || 'The handoff delivery could not be confirmed.'), {
          code: refusalCode(error), deliveryOutcome: deliveryOutcome(error),
        })
      }
      const outcome = deliveryOutcome(delivery)
      handoffAccepted = outcome === 'accepted'
      if (delivery?.ok !== true || outcome !== 'accepted' || !delivery.result
        || typeof delivery.result !== 'object' || Array.isArray(delivery.result) || delivery.result.ok === false) {
        throw Object.assign(new Error(delivery?.reason || delivery?.message || 'The handoff delivery could not be confirmed.'), {
          code: delivery?.code || delivery?.error?.code || 'AGENT_AUTOMATIC_DELIVERY_UNCONFIRMED', deliveryOutcome: outcome,
        })
      }
      const sent = delivery.result
      // A send already in flight retains its actual outcome, but cannot repaint
      // a conversation stopped or replaced while delivery was pending.
      if (!recoveryCurrent()) return true
      assertImageRecoveryAuthority()
      /* Custody was transferred before this point, but the lifetime watcher is
         deliberately installed only after the handoff itself is accepted.
         A refused handoff must never let a later idle signal dispatch images
         into a successor that did not receive the recovery/history text. */
      if (handoffAccepted && imageRecoveryTransferred && imageRecovered && context.imageRecovery?.available === true) {
        assertRecoveryCurrent()
        assertImageRecoveryAuthority(imageRecovered.sourceBinding)
        const imageDrain = await imageRecoveryHosts.drain(context.computerId, {
          nodeId: node.id,
          conversationId: node.id,
          sourceSessionId: packet.sessionId,
          destinationSessionId: started.sessionId,
          expectedNodeCreatedAt: cleanupOwnership.expectedNodeCreatedAt,
          sourceBinding: imageRecovered.sourceBinding,
          isCurrent: recoveryCurrent,
        })
        assertRecoveryCurrent()
        assertImageRecoveryAuthority(imageRecovered.sourceBinding)
        if (imageDrain?.ok === false && imageDrain?.retryable !== true) {
          retainImageRecoveryRefusal(imageDrain, 'IMAGE_RECOVERY_DRAIN_REFUSED')
        }
      }
      if (sent?.threadId) {
        const latest = transcriptStore.get(node.id)
        const savingThread = transcriptStore.save(node.id, { ...latest, threadId: sent.threadId, keepUnknown: true })
        if (savingThread?.then) await savingThread
        if (!recoveryCurrent()) return true
        assertImageRecoveryAuthority()
        started = { ...started, threadId: sent.threadId }
        const record = recoveredSessions.get(started.sessionId)
        if (record) record.started = started
        publish({ nodeId: node.id, previousSessionId: packet.sessionId, started, lines: latest?.lines || nextLines })
      }
      publishImageRecoveryNotice()
      return true
    } catch (error) {
      if (!recoveryCurrent()) {
        if (started?.sessionId && !handoffDispatched && !started.cleanupPending) {
          try { await closeReplacementSession(context, node.id, started.sessionId, cleanupOwnership) }
          catch (cleanupError) { started.cleanupPending = true; publish({ nodeId: node.id, error: cleanupError.message }) }
        }
        const cancelledNode = treeStore.getNode(node.id)
        const ownsPublishedStatus = publishedRecoveryStatus
          && cancelledNode?.status === publishedRecoveryStatus.status
          && cancelledNode?.statusNote === publishedRecoveryStatus.note
        if (!handoffDispatched && !started?.cleanupPending && cancelledNode?.createdAt === cleanupOwnership.expectedNodeCreatedAt
          && cancelledNode?.sessionId === ownedSessionId
          && ownsPublishedStatus) {
          if (!started && !closedSessions.has(packet.sessionId) && liveBefore) {
            treeStore.setNodeStatus(node.id, liveBefore.status, { note: liveBefore.statusNote })
          } else {
            treeStore.setNodeStatus(node.id, 'finished', { note: 'Recovery cancelled. The conversation is saved.' })
          }
        }
        // Once send was invoked, cancellation cannot establish non-delivery.
        // Keep an explicit refusal or transport error instead of relabelling it.
        if (handoffDispatched) {
          publish({ nodeId: node.id, error: error.message, deliveryOutcome: error.deliveryOutcome || (handoffAccepted ? 'accepted' : 'unknown') })
          return false
        }
        return false
      }
      const current = treeStore.getNode(node.id)
      /* THE SESSION IS STILL THERE, SO THE NODE MUST SAY SO. When this path
         never closed the predecessor and never started a replacement, nothing
         about the running session changed and the only thing that did was this
         attempt. Marking it turn-failed would report a dead conversation that
         is in fact alive, and 'the last turn failed' is the single sentence
         the person was shown while their session was actually still running
         (measured 2026-09-16). Hand the live state back and say what was
         refused instead. */
      const keptAlive = hostClosesPredecessor && !started && current?.sessionId === packet.sessionId
      if (keptAlive && liveBefore) {
        treeStore.setNodeStatus(node.id, liveBefore.status, {
          note: `The model was not changed: ${error?.message || String(error)} This session is still running and its conversation is unchanged.`,
        })
      } else if (current && !started?.cleanupPending && [packet.sessionId, started?.sessionId].includes(current.sessionId)) {
        treeStore.setNodeStatus(node.id, 'turn-failed', { note: `${RECOVERY_PAUSED_PREFIX}${error?.message || String(error)} The conversation is saved.` })
      }
      const deliveryOutcome = handoffDispatched ? (error.deliveryOutcome || (handoffAccepted ? 'accepted' : 'unknown')) : null
      publish({ nodeId: node.id, error: error?.message || String(error), ...(deliveryOutcome ? { deliveryOutcome } : {}) })
    } finally {
      flights.delete(node.id)
      retained.count -= 1
      if (retained.count === 0) activeStores.delete(context.computerId)
      notifyRecoverySettled(node.id)
    }
  }
  const readHandoff = (context, nodeId) => context.handoffStore?.readRecord
    ? context.handoffStore.readRecord(nodeId) : context.handoffStore?.get(nodeId)
  function retireCleanupMapping(context, nodeId, sessionId, cleanupOwnership) {
    const current = context.treeStore.getNode(nodeId)
    // A recreated node may have rebound even the same session identifier.
    if (cleanupOwnership && current?.sessionId === sessionId && current.createdAt !== cleanupOwnership.expectedNodeCreatedAt) return
    if (sessionNodeIds.get(sessionId) === nodeId) sessionNodeIds.delete(sessionId)
  }
  function retainCancelledCleanup(context, nodeId, sessionId, cleanupOwnership) {
    const owner = sessionNodeIds.get(sessionId)
    // A failed close grants no authority to reclaim a session another node
    // now tracks. Keep that existing custody and report the conflict below.
    if (owner && owner !== nodeId) return false
    sessionNodeIds.set(sessionId, nodeId)
    onCleanupRequired(context.treeStore, nodeId, sessionId, cleanupOwnership)
    return true
  }
  async function closeReplacementSession(context, nodeId, sessionId, cleanupOwnership) {
    // This immutable identity belongs to the originating flight, not whichever
    // session is visible when cleanup begins. Custody survives a stale choice;
    // the callback may mutate the node only while that identity still matches.
    // Stop and the flight can both reach one replacement; a second close of a
    // confirmed-closed session must not read the host's "unknown" as leaked custody.
    if (!sessionId || closedSessions.has(sessionId)) return
    const current = context.treeStore.getNode(nodeId)
    if ((sessionNodeIds.has(sessionId) && sessionNodeIds.get(sessionId) !== nodeId)
      || (cleanupOwnership && current?.sessionId === sessionId
        && current.createdAt !== cleanupOwnership.expectedNodeCreatedAt)) {
      throw Object.assign(new Error('The replacement belongs to a different agent now; its session was retained.'),
        { code: 'AGENT_SESSION_CLEANUP_FAILED' })
    }
    let closed
    try { closed = await bridge.close({ sessionId }) } catch { /* custody stays visible below */ }
    if (closed?.closed !== true || closed?.ok === false || closed?.sessionId !== sessionId) {
      const retainedHere = retainCancelledCleanup(context, nodeId, sessionId, cleanupOwnership)
      throw Object.assign(new Error(retainedHere
        ? 'The earlier replacement still needs cleanup. Use its cleanup action.'
        : 'The replacement cleanup could not be confirmed. Another agent now tracks this session; its ownership has been retained.'), { code: 'AGENT_SESSION_CLEANUP_FAILED' })
    }
    closedSessions.add(sessionId)
    retireCleanupMapping(context, nodeId, sessionId, cleanupOwnership)
  }
  const limitWaits = new Map()
  const limitWaitVersions = new Map()
  const advanceLimitWait = nodeId => {
    const version = (limitWaitVersions.get(nodeId) || 0) + 1
    limitWaitVersions.set(nodeId, version)
    return version
  }
  let limitWaitPolling = false
  const sameWaitSource = (context, wait) => {
    const node = context.treeStore.getNode(wait.nodeId)
    const saved = context.transcriptStore.get(wait.nodeId)
    return !disposed && node?.createdAt === wait.createdAt && node.sessionId === wait.sessionId
      && !noteMeansStopped(node.statusNote) && !['starting', 'running'].includes(node.status) && saved?.account === wait.account
      && saved?.threadId === wait.threadId && saved?.provider === wait.provider && node.tier === wait.tier
  }
  async function cancelSavedWait(context, nodeId, wait) {
    const latest = await readHandoff(context, nodeId)
    if (latest?.limitWait?.waitId !== wait.waitId) return
    const cleared = { ...latest, limitWait: null }
    const stored = context.handoffStore?.saveRecord ? await context.handoffStore.saveRecord(nodeId, cleared) : context.handoffStore?.save(nodeId, cleared)
    if (!stored) publish({ nodeId, error: 'The reset wait cancellation could not be saved. Stop this conversation before reloading.' })
  }
  async function pollLimitWaits() {
    if (disposed || limitWaitPolling) return
    limitWaitPolling = true
    try {
      for (const [nodeId, wait] of limitWaits) {
        if (now() < wait.resetAt || flights.has(nodeId) || isReplacing(nodeId)) continue
        const context = contexts.get(wait.computerId)
        if (!context) continue
        const prior = await readHandoff(context, nodeId)
        if (limitWaits.get(nodeId) !== wait) continue
        const node = context.treeStore.getNode(nodeId)
        const safe = sameWaitSource(context, wait) && explicitlyAllowed(canStart) && explicitlyAllowed(canContinue)
          && !(prior?.safetyHold?.nodeId === nodeId && prior.safetyHold.sessionId === wait.sessionId)
          && (!sessionNodeIds.has(wait.sessionId) || await hydrateSessionSafety({ ...context, node }, wait.sessionId))
          && !sessionSafetyHeld(nodeId, wait.sessionId)
        const consumed = { ...prior, limitWait: null }
        const stored = context.handoffStore?.saveRecord
          ? await context.handoffStore.saveRecord(nodeId, consumed) : context.handoffStore?.save(nodeId, consumed)
        if (!stored) { publish({ nodeId, error: 'The reset wait could not be saved. No continuation was started.' }); continue }
        limitWaits.delete(nodeId)
        if (!safe || !sameWaitSource(context, wait)) {
          publish({ nodeId, error: 'The reset wait was cancelled because this conversation changed or is held for review.' })
          continue
        }
        await ensureSeatForSavedContinuation(context, node, { descriptor: { tier: wait.tier, resumeThreadProvider: wait.provider } })
        if (!sameWaitSource(context, wait) || sessionSafetyHeld(nodeId, wait.sessionId)) continue
        const saved = context.transcriptStore.get(nodeId)
        // Attachment advances the session id inside the existing continuation flight.
        let safetyHeld = false
        const choiceCurrent = () => {
          safetyHeld ||= sessionSafetyHeld(nodeId, wait.sessionId)
            || sessionSafetyHeld(nodeId, context.treeStore.getNode(nodeId)?.sessionId)
          return !disposed && !safetyHeld && context.treeStore.getNode(nodeId)?.createdAt === wait.createdAt
            && !noteMeansStopped(context.treeStore.getNode(nodeId)?.statusNote)
        }
        const moved = await continueManually({ sessionId: wait.sessionId, event: { type: 'manual_continuation',
          recoveryId: globalThis.crypto.randomUUID(), handoff: manualAccountHandoff(node, saved, prior) } }, {
          computerId: wait.computerId, nodeId, account: wait.account, sameAccountReset: true,
          startOptions: { tier: wait.tier, treeAccount: wait.account, resumeThreadId: wait.threadId,
            resumeThreadProvider: wait.provider, resumeAccount: wait.account, ...(saved.effort ? { effort: saved.effort } : {}) },
          originValid: choiceCurrent,
          cleanupOwnership: { expectedNodeCreatedAt: wait.createdAt, expectedNodeSessionId: wait.sessionId }
        })
        if (moved) clearExternalBlock(nodeId)
      }
    } catch (error) { publish({ error: error.message || String(error) }) }
    finally { limitWaitPolling = false }
  }
  async function waitForSameAccountReset({ computerId, nodeId, resetAt, isCurrent } = {}) {
    const version = advanceLimitWait(nodeId)
    const chosen = () => limitWaitVersions.get(nodeId) === version && currentChoice(isCurrent)
    const context = contexts.get(computerId), node = context?.treeStore.getNode(nodeId)
    const saved = context?.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context?.transcriptStore.get(nodeId)
    const at = typeof resetAt === 'number' ? resetAt : Date.parse(resetAt)
    if (!node?.sessionId || !saved?.account || !saved.threadId || !saved.provider || !Number.isFinite(at) || at <= now()
      || !chosen() || noteMeansStopped(node.statusNote) || ['starting', 'running'].includes(node.status) || flights.has(nodeId) || isReplacing(nodeId)
      || !explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)) {
      publish({ nodeId, error: 'Choose a future reset time for this saved account. A stopped or held conversation cannot wait and continue.' })
      return false
    }
    if (!await hydrateSessionSafety({ ...context, node }, node.sessionId) || sessionSafetyHeld(nodeId, node.sessionId)) {
      publish({ nodeId, error: 'This conversation is held for review. Waiting cannot resume it.' }); return false
    }
    const wait = { waitId: globalThis.crypto.randomUUID(), computerId, nodeId, sessionId: node.sessionId, createdAt: node.createdAt,
      tier: node.tier, account: saved.account, provider: saved.provider, threadId: saved.threadId, resetAt: at }
    if (!sameWaitSource(context, wait) || !chosen()) return false
    const prior = await readHandoff(context, nodeId)
    const record = { ...prior, handoff: manualAccountHandoff(node, saved, prior), sessionId: node.sessionId, kind: 'manual', limitWait: wait }
    const stored = context.handoffStore?.saveRecord ? await context.handoffStore.saveRecord(nodeId, record) : context.handoffStore?.save(nodeId, record)
    if (!stored || !sameWaitSource(context, wait) || !chosen()) {
      if (stored) await cancelSavedWait(context, nodeId, wait)
      publish({ nodeId, error: 'The reset wait could not be saved for this conversation.' }); return false
    }
    const status = context.treeStore.setNodeStatus(nodeId, 'turn-failed', { note: 'Waiting for this account to reset at the time you chose. Stop cancels this wait.' })
    if (status?.ok === false) {
      await cancelSavedWait(context, nodeId, wait)
      publish({ nodeId, error: 'This conversation changed before its reset wait could start.' }); return false
    }
    limitWaits.set(nodeId, wait)
    publish({ nodeId, limitWait: { resetAt: at } })
    return true
  }

  async function pollContinuations() {
    if (disposed || continuationPolling || typeof bridge?.continuations !== 'function'
      || !explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)
      || continuationReadStatus && now() < continuationReadStatus.nextAttemptAt) return
    continuationPolling = true
    const revision = continuationContextRevision
    const readCurrent = () => !disposed && revision === continuationContextRevision
      && explicitlyAllowed(canStart) && explicitlyAllowed(canContinue)
    try {
      let answer
      try {
        answer = await bridge.continuations({ action: 'read' })
        if (!answer || answer.ok === false || !Array.isArray(answer.records)) {
          throw new Error('The saved continuation list could not be read.')
        }
      } catch (error) {
        if (!readCurrent()) return
        const historyUnverified = /ledger history cannot be verified/i.test(error?.message || '')
          || /LEDGER_(?:CHAIN|HISTORY)/.test(String(error?.code || ''))
        continuationReadFailures = Math.min(5, continuationReadFailures + 1)
        continuationReadStatus = {
          blocked: true,
          code: historyUnverified ? 'CONTINUATION_HISTORY_UNVERIFIED' : 'CONTINUATION_CATALOGUE_UNAVAILABLE',
          reason: historyUnverified
            ? 'Autonomous+ recovery is blocked because the task ledger history cannot be verified. Saved continuations will not restart until this check succeeds. Retrying automatically.'
            : 'Autonomous+ recovery is blocked because its saved continuation list could not be read. Saved continuations will not restart until this check succeeds. Retrying automatically.',
          nextAttemptAt: now() + Math.min(CONTINUATION_READ_BACKOFF_CAP_MS,
            CONTINUATION_READ_BACKOFF_MS * 2 ** (continuationReadFailures - 1)),
        }
        publish({ continuationStatus: { ...continuationReadStatus } })
        return
      }
      if (!readCurrent()) return
      continuationReadFailures = 0
      if (continuationReadStatus) {
        continuationReadStatus = null
        publish({ continuationStatus: null })
      }
      forgetContinuationSeatMemoryForMissingNodes()
      for (const record of answer.records) {
        if (!explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)) return
        const id = record.descriptor?.requestKeys?.threadId
        const context = [...contexts.values()].find(entry => entry.treeStore.getNode(id))
        if (!context) {
          continuationSeatRefusals.delete(id)
          continuationSeatTransportBackoff.delete(id)
          continue
        }
        const { treeStore, transcriptStore } = context
        const node = treeStore.getNode(id)
        if (!node) {
          continuationSeatRefusals.delete(id)
          continuationSeatTransportBackoff.delete(id)
          continue
        }
        const rememberedSeatRefusal = continuationSeatRefusals.get(id)
        if (rememberedSeatRefusal) {
          if (sameContinuationSeatStamp(rememberedSeatRefusal, node, record)) continue
          continuationSeatRefusals.delete(id)
        }
        if (continuationSeatRetryBlocked(id)) continue
        if (flights.has(id) || isReplacing(id) || sessionNodeIds.has(node.sessionId)) continue
        if (noteMeansStopped(node.statusNote) || node.statusNote === 'Stop could not be confirmed. Use Stop again before resuming.') {
          await bridge.continuations({ action: 'stop', key: record.key })
          /* The circle's own note is kept: restamping it would tell the person
             they stopped a circle its manager stopped. */
          treeStore.setNodeStatus(id, 'finished', { note: noteMeansStopped(node.statusNote) ? node.statusNote : 'Stopped by you.' })
          continue
        }
        const saved = transcriptStore.readLatest ? await transcriptStore.readLatest(id) : transcriptStore.get(id)
        const current = treeStore.getNode(id)
        if (!readCurrent() || contexts.get(context.computerId)?.treeStore !== treeStore
          || !current || current.createdAt !== node.createdAt || current.sessionId !== node.sessionId) continue
        if (!saved?.threadId || saved.threadId !== record.descriptor.resumeThreadId
          || node.sessionId !== record.descriptor.sessionId) {
          await bridge.continuations({ action: 'stop', key: record.key })
          continue
        }
        flights.add(id)
        const retained = activeStores.get(context.computerId) || { store: treeStore, count: 0 }
        retained.count += 1; activeStores.set(context.computerId, retained)
        let started = null, refusalToContinue = null
        const attempt = { key: record.key, stopped: false, stopConfirmed: false, finished: false }
        continuationFlights.set(id, attempt)
        attempt.showStop = () => {
          if (treeStore.getNode(id)?.sessionId !== ownedSessionId || attempt.cleanupRequired) return
          treeStore.setNodeStatus(id, attempt.stopConfirmed ? 'finished' : 'turn-failed', { note: attempt.stopConfirmed
            ? 'Stopped by you.' : 'Stop could not be confirmed. Use Stop again before resuming.' })
          publish({ nodeId: id })
        }
        let ownedSessionId = node.sessionId
        const ownsNode = () => {
          const current = treeStore.getNode(id)
          return !disposed && contexts.get(context.computerId)?.treeStore === treeStore
            && current && current.createdAt === node.createdAt && current.sessionId === ownedSessionId
            && !noteMeansStopped(current.statusNote) && !attempt.stopped
        }
        const discard = () => bridge.continuations({ action: 'discard', key: record.key,
          revision: started.continuation?.revision, sessionId: started.sessionId })
        try {
          if (!explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)) return
          /* A saved continuation is not admission proof. Recreate or confirm
             the node's organisation seat through the same bridge door Start
             uses before asking the host to resume its provider thread. */
          await ensureSeatForSavedContinuation(context, node, record)
          if (!ownsNode()) continue
          if (sessionNodeIds.has(treeStore.getNode(id)?.sessionId)) continue
          continuationSeatTransportBackoff.delete(id)
          const identity = address(treeStore, node)
          started = await bridge.continuations({ action: 'resume', key: record.key, revision: record.revision,
            requestKeys: identity.requestKeys, treeIdentity: identity.treeIdentity })
          if (!started?.sessionId || started.ok === false || started.ended) throw Object.assign(new Error('The saved continuation could not resume.'), { code: refusalCodeOf(started) })
          const current = treeStore.getNode(id)
          if (!ownsNode() || !explicitlyAllowed(canContinue)) {
            await discard(); started = null
            throw new Error('This node changed while its continuation was resuming.')
          }
          sessionNodeIds.set(started.sessionId, id)
          const attached = treeStore.attachSession(id, started.sessionId)
          if (!attached?.ok && !attached?.runtimeUpdated) throw new Error('The recovered session could not be attached to its circle.')
          ownedSessionId = started.sessionId
          const lines = resumedTranscriptLines({ savedLines: saved.lines || [], engineResumed: started.resumed, provider: record.descriptor.resumeThreadProvider })
          const recorded = await transcriptStore.save(id, { ...saved, lines, threadId: started.threadId,
            account: started.account ?? saved.account, effort: started.effort || saved.effort, keepUnknown: true })
          if (!recorded) throw new Error('The restored transcript could not be saved.')
          if (!ownsNode() || !explicitlyAllowed(canContinue)) throw new Error('This continuation was stopped or its node changed.')
          const accepted = await bridge.continuations({ action: 'attached', key: record.key,
            revision: started.continuation?.revision, sessionId: started.sessionId })
          if (accepted?.ok !== true || !ownsNode()) throw new Error('This continuation changed before its circle was ready.')
          recoveredSessions.set(started.sessionId, { nodeId: id, computerId: context.computerId, started, text: '' })
          treeStore.setNodeStatus(id, 'finished', { note: 'Autonomous+ restored this conversation. Checking unfinished work.' })
          publish({ nodeId: id, previousSessionId: node.sessionId, started, lines })
        } catch (error) {
          if (error?.seatFailureKind === 'transport') {
            rememberContinuationSeatTransportFailure(id)
          }
          if (started?.sessionId) {
            try { await discard() } catch (cleanupError) {
              if (!['CONTINUATION_CHANGED', 'MC_AGENT_UNKNOWN_SESSION'].includes(refusalCode(cleanupError))
                && treeStore.getNode(id)?.sessionId === ownedSessionId) {
                attempt.cleanupRequired = true
                onCleanupRequired(treeStore, id, started.sessionId)
              }
            }
            if (sessionNodeIds.get(started.sessionId) === id) sessionNodeIds.delete(started.sessionId)
          }
          if (ownsNode()) {
            const code = refusalCode(error)
            /* THE PERSON'S SENTENCE, NOT THE WIRE'S. A refusal crosses the window
               boundary as tokens ("ATTRIBUTED_TO_PROVIDER AGENT_RESUME_ACCOUNT_LIMIT",
               see shell/main.cjs rendererSafeAgentError), and this note used to
               print them verbatim on the circle. Measured on the base of this
               lane: note="Autonomous+ recovery paused: ATTRIBUTED_TO_PROVIDER
               AGENT_RESUME_ACCOUNT_LIMIT". The refusal table already owns the
               sentence for every code it names; the raw message is kept only
               for a failure it does not. */
            const said = refusalSentenceFor(code, error)

            const settled = ['finished', 'interrupted', 'cancelled'].includes(node.status)
            const keepsStatus = !started?.sessionId && settled && !savedAccountResumeRefused(code)
            const note = `Autonomous+ recovery paused: ${said}`
            // Said once: a later sweep that is refused the same way finds the
            // same status and the same sentence already on the circle.
            const current = treeStore.getNode(id)
            if (!(keepsStatus && current?.status === node.status && current.statusNote === note)) {
              treeStore.setNodeStatus(id, keepsStatus ? node.status : 'turn-failed', { note })
              publish({ nodeId: id, error: said })
            }
            if (!attempt.cleanupRequired && savedAccountResumeRefused(code)) {
              const descriptor = record.descriptor || {}
              refusalToContinue = { code, attribution: refusalAttribution(error), account: saved.account || null,
                provider: saved.provider || descriptor.resumeThreadProvider || null, sentence: said,
                startOptions: Object.fromEntries(['tier', 'model', 'effort', 'profileId'].filter(key => descriptor[key] != null).map(key => [key, descriptor[key]])) }
            }
          }
          if (error?.seatFailureKind === 'terminal') {
            const current = treeStore.getNode(id)
            if (current && current.createdAt === node.createdAt) {
              continuationSeatRefusals.set(id, continuationSeatStamp(current, record))
            }
            continuationSeatTransportBackoff.delete(id)
          }
        } finally {
          attempt.finished = true
          if (attempt.stopped) attempt.showStop()
          continuationFlights.delete(id)
          flights.delete(id); retained.count -= 1
          if (retained.count === 0) activeStores.delete(context.computerId)
        }
        if (refusalToContinue) {
          const offer = refusalToContinue
          refusalToContinue = null
          if (treeStore.getNode(id)?.sessionId === ownedSessionId) {
            const key = switchOfferKey(ownedSessionId, offer.code)
            if (switchOffersMade.get(id) !== key) {
              switchOffersMade.set(id, key)
              publish({ nodeId: id, switchOffer: { nodeId: id, code: offer.code, attribution: offer.attribution, account: offer.account,
                provider: offer.provider, sentence: offer.sentence, tier: offer.startOptions.tier || node.tier || null, effort: offer.startOptions.effort || null } })
            }
          }
        }
      }
    } catch { /* A later bounded poll reads the durable recovery state again. */ }
    finally { continuationPolling = false }
  }

  const coordinator = {
    register(computerId, context) {
      if (disposed) return
      continuationContextRevision++
      if (contexts.get(computerId)?.transcriptStore !== context.transcriptStore) contexts.get(computerId)?.transcriptStore.dispose?.()
      const registeredContext = { ...context, computerId }
      contexts.set(computerId, registeredContext)
      if (context.imageRecovery?.available === true) {
        const imageHost = imageRecoveryHosts.register(computerId, registeredContext)
        if (!imageHost) publish({ computerId, imageRecoveryRefused: 'IMAGE_RECOVERY_HOST_UNAVAILABLE' })
      } else {
        imageRecoveryHosts.dispose(computerId)
        if (context.imageRecovery?.unavailable) {
          publish({ computerId, imageRecoveryRefused: context.imageRecovery.unavailable })
        }
      }
      if (!continuationTimer) {
        continuationTimer = setInterval(() => { void pollContinuations(); void pollLimitWaits() }, 5000)
        continuationTimer.unref?.()
      }

      const retainedStore = activeStores.get(computerId)
      if (retainedStore) retainedStore.store = context.treeStore
      if (!unsubscribe && typeof bridge?.onEvent === 'function') unsubscribe = bridge.onEvent(packet => { observePacket(packet) })
      void pollContinuations()
      for (const node of context.treeStore.snapshot().nodes) {
        const version = limitWaitVersions.get(node.id) || 0
        void Promise.resolve().then(() => readHandoff(registeredContext, node.id)).then(record => {
          const wait = record?.limitWait
          if ((limitWaitVersions.get(node.id) || 0) === version && contexts.get(computerId) === registeredContext
            && wait?.computerId === computerId && wait.nodeId === node.id && Number.isFinite(wait.resetAt)
            && sameWaitSource(registeredContext, wait) && !limitWaits.has(node.id)) limitWaits.set(node.id, wait)
        }).catch(error => publish({ nodeId: node.id, error: error.message || String(error) }))
        if (node.sessionId && sessionNodeIds.get(node.sessionId) === node.id) {
          void hydrateSessionSafety({ ...registeredContext, node }, node.sessionId)
        }
      }
      for (const [sessionId, record] of recoveredSessions) {
        if (record.computerId !== computerId || !record.text) continue
        publish({ nodeId: record.nodeId, started: { ...record.started, sessionId },
          lines: context.transcriptStore.get(record.nodeId)?.lines || [], partialText: record.text })
      }
    },
    pollContinuations,
    pollLimitWaits,
    waitForSameAccountReset,
    continuationStatus: () => continuationReadStatus ? { ...continuationReadStatus } : null,
    async stopContinuation(nodeId) {
      advanceLimitWait(nodeId)
      const wait = limitWaits.get(nodeId)
      if (wait) {
        limitWaits.delete(nodeId)
        const context = contexts.get(wait.computerId)
        const prior = context && await readHandoff(context, nodeId)
        if (context) {
          const saved = context.handoffStore?.saveRecord ? await context.handoffStore.saveRecord(nodeId, { ...prior, limitWait: null }) : context.handoffStore?.save(nodeId, { ...prior, limitWait: null })
          if (!saved) publish({ nodeId, error: 'The reset wait cancellation could not be saved. Stop this conversation before reloading.' })
        }
      }
      const attempt = continuationFlights.get(nodeId)
      if (!attempt) return false
      attempt.stopped = true
      await bridge.continuations({ action: 'stop', key: attempt.key })
      attempt.stopConfirmed = true
      if (attempt.finished) attempt.showStop()
      return true
    },
    async continueOnAnotherAccount({ computerId, nodeId, startOptions = {}, isCurrent, assignment = null } = {}) {
      const context = contexts.get(computerId)
      const node = context?.treeStore.getNode(nodeId)
      const cleanupOwnership = Object.freeze({ expectedNodeCreatedAt: node?.createdAt, expectedNodeSessionId: node?.sessionId })
      // Keep the entry incarnation across reads and through recovery. Session
      // currency is checked separately so our own attachment remains valid.
      const originValid = () => !disposed && Boolean(node)
        && context.treeStore.getNode(nodeId)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
        && currentChoice(isCurrent)
      if (!originValid()) return false
      let saved
      try { saved = context?.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context?.transcriptStore.get(nodeId) }
      catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context?.treeStore.getNode(nodeId)?.sessionId !== node?.sessionId
        || !node?.sessionId || flights.has(nodeId) || isReplacing(nodeId)) return false
      if (sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)) return false
      if (typeof startOptions.treeAccount !== 'string' || !startOptions.treeAccount.trim()) {
        publish({ nodeId, error: 'Choose an account before continuing.', code: 'AGENT_ACCOUNT_CHOICE_REQUIRED' })
        return false
      }
      const account = saved?.account || null
      const options = Object.fromEntries(['tier', 'model', 'effort', 'profileId', 'roleBinding', 'treeAccount'].filter(key => startOptions[key] != null).map(key => [key, startOptions[key]]))
      let priorHandoff
      try {
        priorHandoff = context.handoffStore?.readRecord
          ? await context.handoffStore.readRecord(nodeId)
          : context.handoffStore?.get(nodeId)
      } catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      // T1792: an agent.resume that carried the next assignment hands it over
      // inside this continuation's first turn, the handoff itself.
      const handoff = manualAccountHandoff(node, saved, priorHandoff, { assignment })
      const moved = Boolean(await continueManually({ sessionId: node.sessionId, event: { type: 'manual_continuation',
        recoveryId: globalThis.crypto.randomUUID(), handoff } }, { computerId, nodeId, account, startOptions: options, originValid, cleanupOwnership })
      )
      /* T124: this is the move that recovered the node by hand every single
         time in the measured run. When it works, the block is over. */
      if (moved && originValid()) clearExternalBlock(nodeId)
      return moved
    },

    async continueOnAnotherModel({ computerId, nodeId, startOptions = {}, isCurrent, assignment = null } = {}) {
      const context = contexts.get(computerId)
      const node = context?.treeStore.getNode(nodeId)
      const cleanupOwnership = Object.freeze({ expectedNodeCreatedAt: node?.createdAt, expectedNodeSessionId: node?.sessionId })
      // Keep the entry incarnation across reads and through recovery. Session
      // currency is checked separately so our own attachment remains valid.
      const originValid = () => !disposed && Boolean(node)
        && context.treeStore.getNode(nodeId)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
        && currentChoice(isCurrent)
      if (!originValid()) return false
      const tier = tiers.find(row => row.id === startOptions.tier) || null
      if (!node?.sessionId || !tier || flights.has(nodeId) || isReplacing(nodeId)) return false
      /* THE SAME GUARD THE ACCOUNT CONTINUATION USES, held here and not only in
         the view: a session that is starting or mid-turn ('running' is the
         tree store's mid-turn status, src/tree-session-liveness.js) is never
         closed out from under its turn, whoever calls this. */
      if (sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)) return false
      let saved
      try { saved = context?.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context?.transcriptStore.get(nodeId) }
      catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      if (startOptions.model == null && tier.id === node.tier && (!saved?.provider || saved.provider === tier.provider)) return false
      // A transcript without a native thread ID intentionally has no provider
      // metadata. The node's admitted tier still identifies its provider; an
      // ordinary same-provider model change must not look like an account move.
      const sourceProvider = saved?.provider || tiers.find(row => row.id === node.tier)?.provider
      if (tier.provider !== sourceProvider && tier.provider !== 'local'
        && (typeof startOptions.treeAccount !== 'string' || !startOptions.treeAccount.trim())) {
        publish({ nodeId, code: 'AGENT_ACCOUNT_CHOICE_REQUIRED', error: 'Choose an account before continuing on another provider.' }); return false
      }
      const chosenAccount = startOptions.treeAccount || (tier.provider === sourceProvider ? saved?.account : null)
      const options = Object.fromEntries(['tier', 'model', 'effort', 'profileId', 'roleBinding', 'treeAccount'].filter(key => startOptions[key] != null).map(key => [key, startOptions[key]]))
      if (chosenAccount) options.treeAccount = chosenAccount
      let priorHandoff
      try { priorHandoff = await readHandoff(context, nodeId) }
      catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      const configured = tiers.find(row => row.id === node.tier) || null
      const from = saved?.provider && saved.provider !== configured?.provider
        ? { label: saved.model || saved.provider, provider: saved.provider } : configured
      const name = row => row ? `${row.label} (${row.provider})` : 'unrecorded'
      const handoff = manualModelHandoff(node, saved, priorHandoff, { fromLabel: name(from), toLabel: name(tier), assignment })
      return Boolean(await continueManually({ sessionId: node.sessionId, event: { type: 'manual_continuation',
        recoveryId: globalThis.crypto.randomUUID(), handoff } },
      { computerId, nodeId, account: saved?.account ?? null, startOptions: options, modelContinuation: true, originValid, cleanupOwnership }))
    },
    hasContext: computerId => contexts.has(computerId),
    activeStore: computerId => activeStores.get(computerId)?.store || null,
    // Reopening a page is not an application restart. Reuse the store that
    // owns these live sessions instead of closing its clocks through parsing.
    sessionStore(computerId) {
      const store = contexts.get(computerId)?.treeStore
      return store?.snapshot().nodes.some(node => sessionNodeIds.get(node.sessionId) === node.id) ? store : null
    },
    /* T124. THE ONE QUESTION A SENDER ASKS BEFORE IT SPENDS A TURN.
       Answers null when nothing is wrong, and `{ blocked: true, kind,
       reason, since, notified }` when this node's provider is refusing on a
       model or account limit with no candidate left. Every door that can
       start a turn must consult it -- the coordinator's own off-page drain
       does (drainQueued), and so does the queue door in
       src/views/computers.js (queueForSession). A refusal here is not a stop:
       requested reset waits and the person's manual continuation
       still run, and each clears it when it works. */
    externalBlock: nodeId => { const record = externalBlocks.get(nodeId); return record ? { ...record } : null },
    subscribeRecoverySettled(listener) {
      if (typeof listener !== 'function') throw new TypeError('A recovery listener is required.')
      settledListeners.add(listener)
      return () => settledListeners.delete(listener)
    },
    isRecovering: nodeId => flights.has(nodeId),
    isContinuing: nodeId => continuationFlights.has(nodeId),
    subscribe(listener, { observes = () => false } = {}) {
      if (disposed) return () => {}
      const entry = { listener, observes }
      listeners.add(entry)
      if (continuationReadStatus) {
        try { listener({ continuationStatus: { ...continuationReadStatus } }) } catch { /* a retired UI must not cancel recovery */ }
      }
      return () => listeners.delete(entry)
    },
    destroy() {
      disposed = true
      continuationContextRevision++
      continuationReadStatus = null
      continuationSeatRefusals.clear()
      continuationSeatTransportBackoff.clear()
      unsubscribe?.(); unsubscribe = null; listeners.clear(); settledListeners.clear()
      if (continuationTimer) clearInterval(continuationTimer)
      continuationTimer = null
      imageRecoveryHosts.destroy()
      for (const context of contexts.values()) context.transcriptStore.dispose?.()
      contexts.clear()
      recoveredSessions.clear()
      sessionTextReader.clear()
      switchOffersMade.clear()
      externalBlocks.clear()
      limitDecisions.clear()
      limitWaits.clear()
      limitWaitVersions.clear()
    },
  }
  return coordinator
}
