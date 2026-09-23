import { captureAccountRecoveryHistory, accountRecoveryHistoryNotice } from './account-recovery-history.js'
import { resumedTranscriptLines } from './tree-resume-transcript.js'
import { nodeDisplayName } from './fleet-trees.js'
import { identityRoleForTreeNode } from './tree-node-identity.js'
import { composeNodeBrief } from './tree-node-brief.js'
import { createSessionTextReader, sessionTurnStatus, sessionTurnSucceeded, sessionTurnCancelled, sessionTurnFailureText, recoveredNodeTurnStatus,
  sessionEventTurnId, completionSettlesOpenTurn, sessionEndedEvent } from './agent-session-events.js'
import { TURN_CANCELLED } from './fleet-tree-copy.js'
import { refusalCode, refusalAttribution, UNAVAILABLE_TEXT } from './agent-availability-copy.js'
import { refusalCodeOf } from './refusal-copy.js'
import { manualAccountHandoff, manualModelHandoff, accountRetryCandidates, accountRetryStatus, defaultRetryProviders, savedAccountResumeRefused, MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY } from './manual-account-continuation.js'
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
export function createAccountRecoveryCoordinator({ bridge, sessionNodeIds, moveOutbox = () => {}, canStart = () => false, canContinue = () => false, isReplacing = () => false,
  onCleanupRequired = () => {}, outbox = null, orgBridge = null, readAccounts = null, tiers = [], now = Date.now,
  /* CONSENT TO MOVE A REFUSED CONVERSATION TO ANOTHER ACCOUNT, asked of the
     window rather than read here: `readAccounts` above cannot express a failed
     read (a throwing bridge and an empty list both come back as a policy that
     reads keep-trying TRUE), and a failed read is not consent. The window's
     keepTryingOnLimitIsOn is written failure-first; the default here answers
     no, and an answer that is not exactly true is no. */
  keepTryingOnLimit = async () => false } = {}) {
  async function keepTryingConsent() {
    try { return (await keepTryingOnLimit()) === true } catch { return false }
  }
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
  const retryable = new Map()
  const deferred = new Map()
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
  const retryPolicies = new Map()
  const retryFlights = new Map()
  const retryWrites = new Map()
  const retryChoiceRevisions = new Map()
  const hydratingNodes = new Set()
  const continuationSeatRefusals = new Map()
  const continuationSeatTransportBackoff = new Map()
  /* ONE SWITCH OFFER PER REFUSED SESSION, keyed by the session that was
     refused and the code that refused it.

     MEASURED on this lane's own tests: pollContinuations runs from register(),
     from a 5 s interval and from pollAccountRetries, and every sweep
     re-attempts the SAME unfinished continuation record and is refused again.
     Without this guard the offer was published on every sweep, so a person who
     pressed "Not now" had the dialog back within five seconds and could never
     put it away -- the dismissal was the one thing the dialog did not honour.
     The key is deliberately not the node alone: a genuinely new refusal (the
     session changed, or the reason did) is a new question and is asked again. */
  const switchOffersMade = new Map()
  const switchOfferKey = (sessionId, code) => JSON.stringify([sessionId, code])
  const persistedPolicy = policy => { const { handoff, ...value } = policy; return structuredClone(value) }
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
    if (flights.has(nodeId) || retryFlights.has(nodeId)) return
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
  function pauseCancelledTurn(policy) {
    Object.assign(policy, { state: 'paused', lastFailureCode: 'TURN_CANCELLED', failurePending: false,
      nextAttemptAt: null, autoResumeAt: null, reason: 'This turn ended. Send a new message to continue.' })
  }
  const retrySafetyRefusal = code => /IDENTITY|ROLE|PERMISSION|FORBIDDEN|DENIED|CLEANUP|CANCEL|STOP|INTERRUPT|CONSENT|PRINCIPAL|CONTROL|POLICY|AUTH|INVALID_THREAD/.test(String(code || ''))
  const interruptionCodes = new Set(['CLAUDE_CLI_TURN_TIMEOUT', 'CLAUDE_CLI_INITIALIZE_TIMEOUT', 'CLAUDE_CLI_EXITED',
    'AGY_CLI_TURN_TIMEOUT', 'AGY_CLI_EXITED',
    'CODEX_APP_SERVER_EXITED', 'CODEX_TRANSPORT_WRITE_FAILED', 'ACP_PROCESS_EXITED', 'ACP_TRANSPORT_WRITE_FAILED',
    'LOCAL_NODE_TURN_TIMEOUT', 'PROVIDER_PROCESS_EXITED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'])
  function retryFailureKind(code) {
    if (retrySafetyRefusal(code)) return null
    // A context-length failure needs a fresh session, not another account.
    if (/context.limit|context.length|prompt.too.long/i.test(String(code || ''))) return 'context'
    if (/quota|usage.limit|rate.limit|AGENT_RESUME_ACCOUNT_LIMIT/i.test(String(code || ''))) return 'limit'
    return interruptionCodes.has(code) ? 'interruption' : null
  }
  // Only node-level safety stops a sweep. A provider-scoped refusal skips that
  // provider for this sweep and keeps the reset times already observed.
  const nodeSafetyRefusal = code => /IDENTITY|MISMATCH|OWNERSHIP|PRINCIPAL|CLEANUP|CANCEL|STOP|INTERRUPT|ROLE|TREE_|CONSENT|CONTROL|SOURCE_INVALID|INVALID_THREAD|PERMISSION|FORBIDDEN|DENIED|AUTHORITY|ISOLATION/.test(String(code || ''))
  const providerScopedRefusal = code => /AUTH_REQUIRED|AUTH_FAILED|SHARED_AUTH|SIGN_?IN|SIGNED_OUT|LOGIN|NOT_INSTALLED|NOT_PROVISIONED|CLIENT_(?:UNSUPPORTED|UNAVAILABLE|INVALID|SHARED)|NO_LAUNCHER|MODEL|EFFORT|REQUIRES_APP_TOOLS|AMBIENT_TOOLS|BOUNDARY|PROJECT_REQUIRED|PLAN_REQUIRED|RETRY_UNAVAILABLE|PROVIDER_(?:SEAT|NOT_ALLOWED)|HANDOFF_UNAVAILABLE|STATUS_UNKNOWN/.test(String(code || ''))
  const pauseError = (message, kind, code = undefined) => Object.assign(new Error(message), { retryPause: kind, ...(code ? { code } : {}) })
  // A turn-level quota refusal holds that one account: 30 min, doubling, 6 h
  // cap. Providers whose allowance is unmeasured are also capped per account.
  const HOLD_BASE_MS = 30 * 60e3, HOLD_CAP_MS = 6 * 3600e3, UNMEASURED_PROVIDERS = new Set(['gemini', 'grok']), UNMEASURED_DISPATCH_CAP = 6
  const RETRY_PROVIDERS = ['codex', 'claude', 'gemini', 'grok']
  const AUTO_RESUME_LIMIT = 5, AUTO_RESUME_BASE_MS = 60e3, DIRECTION_BACKOFF_MAX_MS = 5 * 60e3
  const directionChecks = new Map()
  const retryWarnings = new Map()
  function heldAccounts(policy, provider, at = now()) {
    return Object.values(policy.holds && typeof policy.holds === 'object' ? policy.holds : {}).filter(row => row && row.provider === provider
      && typeof row.account === 'string' && (row.capped === true || Number.isFinite(row.until) && row.until > at)).map(row => row.account)
  }
  function syncExclusions(policy, at = now()) {
    policy.exclusions = Object.fromEntries(RETRY_PROVIDERS.map(provider => [provider, heldAccounts(policy, provider, at).slice(-32)]).filter(([, names]) => names.length))
  }
  function holdAccount(policy, provider, account, at = now()) {
    if (!RETRY_PROVIDERS.includes(provider) || typeof account !== 'string' || !account) return
    const holds = policy.holds && typeof policy.holds === 'object' ? policy.holds : (policy.holds = {})
    const key = `${provider}:${account}`
    // The host ticket and the turn event can report one refusal twice.
    if (Number.isFinite(holds[key]?.heldAt) && at - holds[key].heldAt < 60e3) return
    const failures = Math.min(1000, (Number(holds[key]?.failures) || 0) + 1)
    const capped = UNMEASURED_PROVIDERS.has(provider) && failures >= UNMEASURED_DISPATCH_CAP
    holds[key] = { provider, account, failures, heldAt: at, until: capped ? null : at + Math.min(HOLD_CAP_MS, HOLD_BASE_MS * 2 ** (failures - 1)), ...(capped ? { capped: true } : {}) }
    syncExclusions(policy, at)
  }
  function releaseHold(policy, provider, account) {
    if (policy.holds && typeof policy.holds === 'object' && provider && account) delete policy.holds[`${provider}:${account}`]
    syncExclusions(policy)
  }
  const deliveryHeld = policy => ['unknown', 'accepted'].includes(policy?.deliveryHold?.outcome)
  async function rememberRetryFailure(context, policy, code, kind) {
    const node = context.treeStore.getNode(policy.nodeId)
    if (!policy.enabled || deliveryHeld(policy) || !node || node.statusNote === 'Stopped by you.' && !policy.stopFenceAcknowledged) return
    policy.lastFailureCode = code
    policy.failurePending = true
    policy.failureKind = kind
    // During a flight the new session's account is not recorded yet; the
    // flight holds the account that actually refused when it returns.
    if (kind === 'limit' && !retryFlights.has(policy.nodeId)) holdAccount(policy, policy.actualProvider, policy.actualAccount)
    policy.state = 'waiting'; policy.nextAttemptAt = now(); policy.resetAt = null
    await saveRetryPolicy(context, policy)
  }
  function retryAttemptPending(nodeId) {
    const policy = retryPolicies.get(nodeId)
    return deliveryHeld(policy) || retryFlights.has(nodeId) || Boolean(policy?.enabled && (policy.state === 'starting'
      || policy.state === 'waiting' && Number.isFinite(policy.nextAttemptAt) && policy.nextAttemptAt <= now()))
  }

  /* T124. A SESSION AT A MODEL OR ACCOUNT LIMIT MUST STOP SPENDING TURNS.
   *
   * MEASURED (T124 ledger entry): Manager (5323eb2d) returned "You've reached
   * your Fable limit. Switch to another model, or manage usage credits" on more
   * than THIRTY CONSECUTIVE TURNS from 21:47Z to 23:38Z, each ending "Turn did
   * not finish", while messages kept being delivered to it. The same manager,
   * Builder 4, Builder 6 and Builder (4a1a39df) had died the same way at 20:25Z
   * on another account's monthly spend limit. Only the owner's manual
   * continuation on another account ever recovered a node, and the tree lost
   * its links every time.
   *
   * WHY THE EXISTING MACHINERY DID NOT CATCH IT. Everything this file knows
   * about limits lives inside `if (policy?.enabled)` in observePacket -- the
   * "Keep trying accounts" policy. A node with no policy, or with the setting
   * off, had its limit refusal classified as NOTHING AT ALL: no record, no
   * hold, no retry, no mark, and above all no reason for any sender to stop.
   * And senders do not stop on their own: src/views/computers.js
   * queueForSession drains the outbox IMMEDIATELY at a node that is not busy,
   * and a limit-failed turn leaves the node 'turn-failed', which is not busy.
   * So every delivered message became another burnt turn, which is exactly the
   * shape of the thirty-turn run above.
   *
   * WHAT A BLOCK IS, AND WHAT IT IS NOT. It is a fence on SPENDING TURNS, not
   * a stop on recovery: a scheduled retry, a reset wait and the person's own
   * manual continuation all still run, and each of them clears the block when
   * it works. It is the way OUT of the loop, so it must never gate them.
   *
   * ON THE WORD 'blocked-external'. The ledger asks for the node to be "marked
   * blocked-external on the tree". It is recorded here as a kind, and its
   * REASON is written to the node's status note where the manager and the
   * Controller actually read it -- deliberately NOT as a ninth NODE_STATUSES
   * value. fleet-trees.js refuses an unknown status (setNodeStatus), and
   * worse, its loader treats one persisted unknown status as a corrupt file
   * and returns EMPTY_FLEET_TREES -- every tree on the computer, gone -- so a
   * build that wrote 'blocked-external' and was then rolled back would erase
   * the trees it was written to protect. The person sees the reason either
   * way; nobody loses a tree. */
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
  const clampNote = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BLOCK_NOTE)

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
        const sent = await bridge.sendAutomatic({ sessionId: target.sessionId,
          text: `${name} is blocked outside this app and has stopped taking turns. ${reason} It needs another model or account, or the person, before it can continue.` })
        if (sent?.ok !== false) told.push(target.id)
      } catch (error) { publish({ nodeId: node.id, error: error.message || String(error) }) }
    }
    return told
  }

  function clearExternalBlock(nodeId) {
    /* The candidate models this limit episode already spent are forgotten
       here and nowhere else. A node that genuinely came back -- a landed turn,
       a retry that found an account, the person's own continuation -- is the
       one event that makes a tier which refused earlier worth asking again. */
    modelsTried.delete(nodeId)
    if (!externalBlocks.delete(nodeId)) return false
    publish({ nodeId, externalBlock: null })
    return true
  }

  async function blockExternally(context, nodeId, reason, modelSwitch = null, code = null) {
    if (externalBlocks.has(nodeId)) return externalBlocks.get(nodeId)
    const node = context.treeStore.getNode(nodeId)
    if (!node) return null
    /* `modelSwitch` is the derived answer to the question T137's bare Boolean
       cannot answer: which tiers this failover actually spent, and why the
       last one would not take the agent. The manager and the Controller read
       the reason; a person debugging this reads the pair. */
    const record = { blocked: true, kind: EXTERNAL_BLOCK_KIND, reason, since: now(), notified: [],
      /* The provider's identifier, carried and never rendered. `reason` is what
         a person reads; this is what a support conversation asks for. */
      code: typeof code === 'string' && code.trim() ? code.trim() : null,
      modelSwitch: Object.freeze({ attempted: Object.freeze([...(modelSwitch?.attempted || [])]),
        refusedBecause: modelSwitch?.refusal || null }) }
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

  /* T124. THE MODEL HALF OF THE FAILOVER, BUILT ON T137 AND NOT BESIDE IT.
   *
   * `continueOnAnotherModel` below (owner request T137) is the one model
   * switch in this file: end this session, start a fresh one on the chosen
   * tier, send it the handoff. The automatic failover calls exactly that
   * method with exactly its signature. It does not reimplement it, it does not
   * wrap it in an injectable seam, and it does not change it.
   *
   * IT ANSWERS A BARE BOOLEAN, AND A FAILOVER NEEDS MORE THAN THAT. `false`
   * means any of "no eligible tier", "already on that tier", "a turn is still
   * running", or "a recovery is already in flight" -- and those want opposite
   * responses. The first two say "try the next candidate"; the last two say
   * "stand back, something else is already moving this agent, and fencing it
   * now would be wrong". That distinction is derived HERE, at the call site,
   * by asking the same closure state the method's own guards ask. T137 is
   * landed and the Controller owns its signature.
   *
   * AND THE WALK MUST TERMINATE, NOT CYCLE. A failover that moves an agent
   * fable -> opus -> fable while each one refuses is T124 rebuilt one storey
   * up, which is why `modelsTried` records a candidate as spent BEFORE it is
   * attempted: neither a refusal nor a throw can offer the same tier twice,
   * `tiers` is finite, so the walk ends after at most one attempt per model.
   * The memory is forgotten only by clearExternalBlock, i.e. only when the
   * agent genuinely came back. */
  const modelsTried = new Map()

  function modelSwitchStandBack(node) {
    if (!node?.sessionId) return 'this agent has no live session to continue'
    // flights/isReplacing are two the method itself refuses on; retryFlights
    // is the account sweep, which is another recovery already in progress.
    if (flights.has(node.id) || retryFlights.has(node.id) || isReplacing(node.id)) return 'another recovery is already moving this agent'
    if (sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)) return 'a turn is still running on this agent'
    return null
  }

  /* An effort name belongs to a provider, so it travels only within one --
     the rule prepareRetryRole already applies below, applied here for the same
     reason. A tier that fixes its own effort wins. */
  function failoverEffort(from, to, wanted) {
    return from?.provider === to.provider || ['codex', 'claude'].includes(to.provider) && !to.client
      ? (wanted || to.effort || null) : (to.effort || null)
  }

  async function switchToAnotherModel(context, nodeId) {
    const attempted = []
    let spent = modelsTried.get(nodeId)
    if (!spent) {
      spent = new Set()
      modelsTried.set(nodeId, spent)
      // Bounded like `seen` and `externalBlocks`, oldest first.
      if (modelsTried.size > 256) modelsTried.delete(modelsTried.keys().next().value)
    }
    let refusal = 'no other model is offered on this computer'
    for (const candidate of tiers) {
      const node = context.treeStore.getNode(nodeId)
      const standBack = modelSwitchStandBack(node)
      // A node-level refusal is true of every candidate, not of this one, so
      // walking the rest would spend the same time to be refused identically.
      if (standBack) return { moved: false, attempted, refusal: standBack, halted: true }
      // The tier it is being refused ON is never a candidate to move it TO,
      // and continueOnAnotherModel refuses candidate.id === node.tier anyway.
      if (node.tier) spent.add(node.tier)
      if (!candidate?.id || spent.has(candidate.id)) continue
      spent.add(candidate.id)
      attempted.push(candidate.id)
      const policy = retryPolicies.get(nodeId)
      const from = tiers.find(row => row.id === node.tier) || null
      const effort = failoverEffort(from, candidate, policy?.preferredEffort || policy?.startOptions?.effort || node.effort || null)
      try {
        /* No roleBinding. Every AUTOMATIC start in this file goes without one
           -- recover()'s own account recovery passes only `accountRecovery`,
           and the retry sweep is the one exception because the person opted
           into it and prepareRetryRole re-confirms the seat with orgBridge
           first. An automatic failover has no confirmed seat to offer and must
           not invent one; the start picks the ordinary identity for the tier. */
        const moved = await coordinator.continueOnAnotherModel({ computerId: context.computerId, nodeId,
          startOptions: { tier: candidate.id, ...(effort ? { effort } : {}),
            ...(policy?.startOptions?.profileId ? { profileId: policy.startOptions.profileId } : {}) } })
        if (moved === true) return { moved: true, attempted, refusal: null, halted: false }
        refusal = `${candidate.label || candidate.id} could not take this agent`
      } catch (error) {
        refusal = error?.message || String(error)
        publish({ nodeId, error: refusal })
      }
    }
    return { moved: false, attempted, refusal, halted: false }
  }

  /* THE FAILOVER, IN THE ORDER THE LEDGER NAMES IT: another model (T137),
     then another account (the rotation/auto-retry sweep this file already
     owns), then -- and only then -- a block. */
  async function handleAccountLimit(context, nodeId, detail, code = null) {
    if (deliveryHeld(retryPolicies.get(nodeId)) || limitDecisions.has(nodeId) || externalBlocks.has(nodeId)) return
    limitDecisions.add(nodeId)
    try {
      const switched = await switchToAnotherModel(context, nodeId)
      if (switched.moved) { clearExternalBlock(nodeId); return }
      /* STAND BACK, DO NOT FENCE. A turn still running, or a recovery already
         in flight, is not "no candidate left": the thing in flight finishes
         and this decision runs again on the next refusal. Fencing here would
         stop a node that nothing is wrong with yet. */
      if (switched.halted) return
      const policy = retryPolicies.get(nodeId)
      // A live rotation owns the account half of the decision: its sweep is
      // already running or scheduled, and it blocks itself when it exhausts.
      if (policy?.enabled || retryFlights.has(nodeId) || flights.has(nodeId)) return
      const closing = switched.attempted.length
        ? `Another model was tried and ${switched.refusal}. This agent has stopped spending turns.`
        : `${switched.refusal[0].toUpperCase()}${switched.refusal.slice(1)}, and no other account is available, so this agent has stopped spending turns.`
      await blockExternally(context, nodeId, clampNote(`Blocked outside this app: ${detail} ${closing}`), switched, code)
    } finally { limitDecisions.delete(nodeId) }
  }
  function observePacket(packet) {
    const sessionId = packet?.sessionId
    const context = find(sessionId)
    if (!context) { retireRecoveredSession(sessionId); return }
    const node = context.node
    const policy = retryPolicies.get(node.id)
    const failure = packet?.event
    {
      const failedTurn = failure?.type === 'turn_completed' && ['failed', 'error'].includes(failure.status)
      const code = failedTurn ? String(failure.code || failure.error?.code || '')
        : failure?.type === 'session_ended' && failure.reason === 'exited' && !retrySafetyRefusal(policy?.lastFailureCode)
          ? 'PROVIDER_PROCESS_EXITED' : null
      /* ONE CLASSIFIER, NOT TWO. retryFailureKind() below reads a code, and a
         provider that reports an account limit as prose sends none -- so this
         surface used to classify the owner's real limit as nothing at all, and
         recorded no failure, took no hold and scheduled no retry.
         Widening the regex would not have fixed it either: the observed
         sentence, "You've hit your session limit · resets 1:30am
         (America/Los_Angeles)", contains none of `quota`, `usage limit` or
         `rate limit`. The shell already owns the one rule that reads the words
         as well as the code (account-session-recovery.cjs#limitReason) and now
         carries its verdict on the event, so this surface consumes that verdict
         rather than deriving a second, weaker opinion from an empty string.
         A safety refusal still wins: it is checked first, exactly as before. */
      const shellReason = failedTurn && !retrySafetyRefusal(code) ? String(failure.failureReason || '') : ''
      const kind = shellReason === 'account-limit' ? 'limit'
        : shellReason === 'context-limit' ? 'context'
          : retryFailureKind(code)
      /* A LIMIT WITH NO PROVIDER CODE STILL NEEDS A CODE ON THE RECORD.
         lastFailureCode is not only a label: the retry gate reads it as
         "is there a failure to retry" -- `if (!immediate && !policy.lastFailureCode)`
         sends the attempt to the ledger direction check instead of to another
         account. An empty string is falsy there, so recording the prose limit
         with no code would have moved the policy to waiting and then declined to
         act on it. This is the same canonical code this file already writes when
         a limit arrives without one (see the persistent-loop branch). */
      const failureCode = kind === 'limit' && !code ? 'ACCOUNT_LIMIT_REACHED' : code
      if (policy?.enabled && !deliveryHeld(policy)) {
        if (failure?.type === 'turn_completed' && sessionTurnCancelled(failure.status)) {
          pauseCancelledTurn(policy)
          void saveRetryPolicy(context, policy).catch(error => publish({ nodeId: node.id, error: error.message }))
        } else if (kind) void rememberRetryFailure(context, policy, failureCode, kind).then(() => pollAccountRetries())
          .catch(error => publish({ nodeId: node.id, error: error.message }))
        else if (failedTurn && retrySafetyRefusal(code)) {
          policy.lastFailureCode = code; policy.failurePending = false; policy.state = 'paused'; policy.nextAttemptAt = null
          policy.reason = 'This refusal needs review before another automatic attempt.'
          void saveRetryPolicy(context, policy).catch(error => publish({ nodeId: node.id, error: error.message }))
        }
      }
      /* T124. THE LIMIT DECISION IS NOT THE RETRY POLICY'S PRIVATE BUSINESS.
         Everything above is gated on an ENABLED "Keep trying accounts" policy,
         and the thirty-turn run the ledger measured had none -- so the limit
         was classified as nothing at all and no sender was ever given a reason
         to stop. A limit refusal now always reaches the failover, which tries
         another model, then another account, and blocks only when neither is
         available. `kind` is already null for every retrySafetyRefusal code
         (retryFailureKind checks it first, and the shell's verdict above is
         consulted only when the code is not a safety refusal), so a refusal
         that needs a person's review still cannot be laundered into a limit. */
      if (kind === 'limit') {
        void handleAccountLimit(context, node.id, limitReasonText(failure), failureCode)
          .catch(error => publish({ nodeId: node.id, error: error.message || String(error) }))
      }
    }
    for (const session of recoveredSessions.keys()) {
      if (!sessionNodeIds.has(session)) retireRecoveredSession(session)
    }
    // Every owned session needs an off-page observer, not only sessions this
    // coordinator replaced. The Computers listener is removed on navigation.
    let record = recoveredSessions.get(sessionId)
    if (!record) {
      const saved = context.transcriptStore.get(node.id)
      record = { nodeId: node.id, computerId: context.computerId, text: '',
        started: { sessionId, threadId: saved?.threadId, effort: saved?.effort, account: saved?.account } }
      recoveredSessions.set(sessionId, record)
    }
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
    if (policy?.enabled && sessionTurnSucceeded(status)) {
      const changed = policy.lastFailureCode != null || policy.recheckAttempt > 0 || heldAccounts(policy, policy.actualProvider).includes(policy.actualAccount)
      policy.recheckAttempt = 0; policy.lastFailureCode = null; policy.autoResumeCount = 0
      releaseHold(policy, policy.actualProvider, policy.actualAccount)
      if (changed) void saveRetryPolicy(context, policy).catch(error => publish({ nodeId: node.id, error: error.message }))
    }
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
      /* T124. A NODE FENCED ON AN EXTERNAL LIMIT KEEPS THE REASON FOR THE
         FENCE AS ITS NOTE, and this line is why it needs saying: it runs
         AFTER the limit was classified above, so a bare `reply` silently
         blanked the reason the failover had just written. `reply` is usually
         empty for exactly this failure -- the provider's limit sentence does
         not survive the shell's leak filter (see T17) -- which left the tree
         saying nothing at all about why this agent stopped taking turns. The
         block reason already carries the provider's sentence when one
         survived, so it is the better note of the two either way. */
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
    if (!outbox || !explicitlyAllowed(canStart) || !explicitlyAllowed(canContinue)) return
    if (queuedSends.has(sessionId)) { queuedCompletions.add(sessionId); return }
    const node = context.treeStore.getNode(context.node.id)
    if (node?.sessionId !== sessionId || sessionNodeIds.get(sessionId) !== node.id || node.status !== 'finished') return
    /* T124. A BLOCKED NODE IS NOT A FREE NODE. Releasing a queued message into
       a session whose provider is refusing on a limit spends a turn to earn
       the same refusal, which is the loop. The message stays queued, exactly
       as it does for a busy node, and goes out when the block clears. */
    if (externalBlocks.has(node.id)) return
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
      const sent = await bridge.send({ sessionId, text: entry.text, ...(model ? { model } : {}) })
      if (sent?.ok === false) throw new Error(sent.reason || sent.message || 'The queued message was refused.')
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
      outbox.requeueFront(sessionId, entry)
      const latest = context.treeStore.getNode(node.id)
      if (latest?.sessionId === sessionId && latest.status === 'running'
          && latest.runStartedAt === attempted.runStartedAt
          && recoveredSessions.get(sessionId)?.eventCount === eventCount) {
        context.treeStore.setNodeStatus(node.id, 'finished', { note: 'The queued message was not sent.' })
      }
      publish({ nodeId: node.id, error: error.message || String(error) })
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

  async function recover(packet, manual = null, retryContext = null) {
    const event = packet?.event
    if (event?.type !== 'account_recovery_needed' || typeof event.recoveryId !== 'string'
      || typeof event.handoff !== 'string' || !event.handoff.trim()) return
    const registered = manual ? contexts.get(manual.computerId) : null
    const manualNode = registered?.treeStore.getNode(manual?.nodeId)
    const context = manual ? (manualNode?.sessionId === packet.sessionId ? { ...registered, node: manualNode } : null) : retryContext || find(packet.sessionId)
    if (!context || seen.has(event.recoveryId)) return
    if (manual?.flight?.cleanupOwnership && context.node.createdAt !== manual.flight.cleanupOwnership.expectedNodeCreatedAt) return false
    const entryOwnership = manual?.cleanupOwnership
    if (entryOwnership && (context.node.createdAt !== entryOwnership.expectedNodeCreatedAt
      || context.node.sessionId !== entryOwnership.expectedNodeSessionId)) return false
    let cleanupOwnership = entryOwnership || Object.freeze({ expectedNodeCreatedAt: context.node.createdAt, expectedNodeSessionId: packet.sessionId })
    if (manual?.flight) {
      manual.flight.cleanupOwnership = cleanupOwnership
      manual.flight.cleanupContext = context
    }
    const recoveryRevision = retryChoiceRevisions.get(context.node.id) || 0
    // A person opted into the persistent loop. The old one-shot ticket must
    // not race it or silently drop its provider choices after eight moves.
    if (!manual && retryPolicies.get(context.node.id)?.enabled) {
      const policy = retryPolicies.get(context.node.id)
      policy.failurePending = true; policy.state = 'waiting'; policy.nextAttemptAt = now()
      policy.lastFailureCode = policy.lastFailureCode || 'ACCOUNT_LIMIT_REACHED'
      if (event.reason !== 'context-limit' && !retryFlights.has(context.node.id)) holdAccount(policy, policy.actualProvider, policy.actualAccount)
      await saveRetryPolicy(context, policy); void pollAccountRetries(); return
    }
    if (flights.has(context.node.id)) { deferred.set(context.node.id, packet); return }
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
    let initialStoppedChoice = Boolean(manual && !manual.retryAttempt && node.statusNote === 'Stopped by you.')
    const recoveryCurrent = () => !disposed
      && recoveryRevision === (retryChoiceRevisions.get(node.id) || 0)
      && treeStore.getNode(node.id)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
      && treeStore.getNode(node.id)?.sessionId === ownedSessionId
      && (initialStoppedChoice || treeStore.getNode(node.id)?.statusNote !== 'Stopped by you.')
      && !manual?.flight?.cancelled
      && (!manual?.originValid || manual.originValid())
    const assertRecoveryCurrent = () => {
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
      const note = 'Continuing from the saved handoff. Retained images were kept because they could not be sent yet.'
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
    retryable.delete(node.id)
    try {
      assertRecoveryCurrent()
      assertAutomaticSendAvailable()
      const saved = transcriptStore.readLatest ? await transcriptStore.readLatest(node.id) : transcriptStore.get(node.id)
      assertRecoveryCurrent()
      if (manual?.flight?.cancelled) throw new Error('Automatic retries were cancelled.')
      const history = !manual ? await captureAccountRecoveryHistory({ saved, bridge, nodeId: node.id,
        sessionId: packet.sessionId, requestKeys: address(treeStore, node).requestKeys }) : null
      assertRecoveryCurrent()
      const handoff = event.handoff.slice(0, 48000)
      /* Through the per-node file store when the shell offers it, the settings
         record when it does not — the same capability check `transcriptStore`
         uses two lines above, for the same reason. A handoff is up to 48,000
         characters and the settings record is bounded at 1 MiB, so this is the
         write that was refused first once the record filled. */
      const record = { handoff, sessionId: packet.sessionId, recoveryId: event.recoveryId,
        ...(history ? { conversation: history } : {}),
        ...(retryPolicies.has(node.id) ? { retryPolicy: persistedPolicy(retryPolicies.get(node.id)) } : {}),
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
      const continuationSummary = 'Continued on another '
        + (manual?.modelContinuation ? 'model' : 'account')
        + ' after the previous session reached a provider limit. The full handoff is kept with this conversation.'
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
      /* NOTHING IS TORN DOWN BEFORE THE REPLACEMENT IS KNOWN TO BE STARTABLE.
       *
       * T158 (owner complaint T137): a model continuation is the ONE path here
       * asked of a session that is alive and healthy -- an account recovery or
       * an account continuation is asked because the session already cannot
       * serve. Closing first therefore costs a person nothing in those cases
       * and costs them the whole conversation in this one: measured
       * 2026-09-16, a cross-provider switch retired the Claude session and the
       * replacement start was then refused, so the person was left with no
       * session, no new line in the conversation and only the generic
       * last-turn-failed word.
       *
       * shell/agent-host.cjs already owns the correct boundary and says why:
       * "Resume replacement is deliberately closed only after the owning
       * account, admission, and authority binding checks have passed, and
       * immediately before provider dispatch. A failed exact-account or
       * authority check must leave the running predecessor intact; closing it
       * in the renderer before start made AGENT_RESUME_ACCOUNT_LIMIT
       * irreversible." That block runs for any start naming
       * `replacesSessionId` without `accountRetry`, which is exactly this
       * start, and it requires the predecessor to still BE there. So handing
       * the close to the host is not a new ordering -- it is stopping this
       * path from pre-empting the one the product already has.
       *
       * The guarantee that follows is the one worth stating: a cross-provider
       * continuation either produces a live replacement carrying the handoff,
       * or leaves the original session alive. Never both dead. */
      hostClosesPredecessor = manual?.modelContinuation === true
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
        let closed, predecessorMappingRemoved = false
        try { closed = await bridge.close({ sessionId: packet.sessionId, ...(!manual ? { accountRecovery: { recoveryId: event.recoveryId } } : {}) }) }
        catch (error) {
          if (!manual?.retryAttempt || manual.policy.failureKind !== 'interruption' || refusalCode(error) !== 'MC_AGENT_UNKNOWN_SESSION') throw error
          predecessorMappingRemoved = true
          // This is not a cleanup receipt. The native start guard below must
          // finish any retained predecessor cleanup before account selection.
        }
        if (!manual && closed?.ok === false && closed.code === 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE') {
          // A newer turn or another recovery consumed the ticket. It owns the
          // live state; this losing attempt neither closes nor starts again.
          if (recoveryCurrent() && liveBefore) treeStore.setNodeStatus(node.id, liveBefore.status, { note: liveBefore.statusNote })
          publish({ nodeId: node.id, recoveryRefused: closed.code, reason: closed.reason })
          return false
        }
        if (closed && (closed.closed !== true || closed.ok === false
          || closed.sessionId !== packet.sessionId)) throw new Error('The old session could not be closed.')
        if (!closed && !predecessorMappingRemoved) throw new Error('The old session could not be closed.')
        if (closed?.closed === true) {
          closedSessions.add(packet.sessionId)
          // The close receipt remains authoritative if the chooser expired
          // during that await. Retire only this predecessor's own mapping.
          retireCleanupMapping(context, node.id, packet.sessionId, cleanupOwnership)
          if (recoveredSessions.get(packet.sessionId)?.nodeId === node.id) retireRecoveredSession(packet.sessionId)
        }
        if (manual?.retryAttempt) {
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
        if (manual?.retryAttempt) {
          if (manual.flight.cancelled) throw new Error('Automatic retries were cancelled.')
          manual.startOptions = await prepareRetryRole(context, manual.policy, manual.startOptions.tier)
          if (manual.flight.cancelled) throw new Error('Automatic retries were cancelled.')
          manual.flight.requestedSessionId = requestedSessionId
        }
        assertRecoveryCurrent()
        started = await bridge.start({ sessionId: requestedSessionId, surface: 'fleet-tree', ...(packet.sessionId ? { replacesSessionId: packet.sessionId } : {}),
          /* A model continuation (owner request T137) names no account to move
             away from: the ordinary start picks the account for the chosen
             tier, the current one included. */
          ...(manual ? { ...manual.startOptions, ...(manual.retryAttempt ? { accountRetry: manual.accountRetry } : manual.modelContinuation || !manual.account ? {} : { continueFromAccount: manual.account }) } : { accountRecovery: { recoveryId: event.recoveryId } }),
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
        const refusal = Object.assign(new Error(reason), { code: started?.code, accountRetry: started?.accountRetry })
        started = null
        throw refusal
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
        try { await closeRetrySession(context, node.id, started.sessionId, cleanupOwnership) }
        catch (error) {
          started.cleanupPending = true
          publish({ nodeId: node.id, error: error.message })
          throw error
        }
        throw new Error('Automatic retries were cancelled.')
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
      if (manual?.flight) manual.flight.cleanupOwnership = cleanupOwnership
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
      const text = composeNodeBrief({ message: history ? handoff + accountRecoveryHistoryNotice(history) : handoff, selfName: latestIdentity.treeIdentity.selfName,
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
        ...(manual?.retryAttempt || manual?.modelContinuation ? { provider: tiers.find(tier => tier.id === manual.startOptions.tier)?.provider } : {}), keepUnknown: false })
      const recorded = recording?.then ? await recording : recording
      assertRecoveryCurrent()
      publish({ nodeId: node.id, previousSessionId: packet.sessionId, started, lines: nextLines })
      if (!recorded) throw new Error('Could not save the replacement session and handoff.')
      if (manual?.retryAttempt || manual?.modelContinuation) {
        if (manual.flight?.cancelled) throw new Error('Automatic retries were cancelled.')
        /* The node's tier is what the card, the chip and the next Resume read;
           after a model continuation it must name the tier that is actually
           running, or the person is shown the model they just left. */
        assertRecoveryCurrent()
        const changed = treeStore.setNodeLaunchPreferences(node.id, { tier: manual.startOptions.tier, effort: manual.startOptions.effort })
        if (changed?.ok !== true || changed.snapshot?.persistenceFailed) throw new Error('The actual replacement model could not be saved.')
      }
      if (manual?.retryAttempt) {
        assertRecoveryCurrent()
        if (manual.flight.cancelled) throw new Error('Automatic retries were cancelled.')
      }
      assertRecoveryCurrent()
      treeStore.setNodeStatus(node.id, 'running', { note: 'Continuing from the saved handoff.' })
      publishedRecoveryStatus = { status: 'running', note: 'Continuing from the saved handoff.' }
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
      if (!recoveryCurrent()) return manual?.retryAttempt ? { ok: true, started } : true
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
        if (!recoveryCurrent()) return manual?.retryAttempt ? { ok: true, started } : true
        assertImageRecoveryAuthority()
        started = { ...started, threadId: sent.threadId }
        const record = recoveredSessions.get(started.sessionId)
        if (record) record.started = started
        publish({ nodeId: node.id, previousSessionId: packet.sessionId, started, lines: latest?.lines || nextLines })
      }
      publishImageRecoveryNotice()
      return manual?.retryAttempt ? { ok: true, started } : true
    } catch (error) {
      if (!recoveryCurrent()) {
        if (started?.sessionId && !handoffDispatched && !started.cleanupPending) {
          try { await closeRetrySession(context, node.id, started.sessionId, cleanupOwnership) }
          catch (cleanupError) { started.cleanupPending = true; publish({ nodeId: node.id, error: cleanupError.message }) }
        }
        const cancelledNode = treeStore.getNode(node.id)
        const currentRevision = retryChoiceRevisions.get(node.id) || 0
        const ownsPublishedStatus = publishedRecoveryStatus
          && cancelledNode?.status === publishedRecoveryStatus.status
          && cancelledNode?.statusNote === publishedRecoveryStatus.note
        if (!handoffDispatched && !started?.cleanupPending && cancelledNode?.createdAt === cleanupOwnership.expectedNodeCreatedAt
          && cancelledNode?.sessionId === ownedSessionId
          && ownsPublishedStatus && [recoveryRevision, recoveryRevision + 1].includes(currentRevision)) {
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
          return manual?.retryAttempt ? { ok: false, started, code: refusalCode(error), reason: error.message,
            deliveryOutcome: error.deliveryOutcome || (handoffAccepted ? 'accepted' : 'unknown') } : false
        }
        return manual?.retryAttempt ? { ok: false, started, code: 'RECOVERY_CANCELLED', reason: error.message } : false
      }
      if (!started && !manual) retryable.set(node.id, {
        packet, context, createdAt: node.createdAt, revision: recoveryRevision,
      })
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
        treeStore.setNodeStatus(node.id, 'turn-failed', { note: `Recovery paused: ${error?.message || String(error)} The conversation is saved.` })
      }
      const deliveryOutcome = handoffDispatched ? (error.deliveryOutcome || (handoffAccepted ? 'accepted' : 'unknown')) : null
      publish({ nodeId: node.id, error: error?.message || String(error), ...(deliveryOutcome ? { deliveryOutcome } : {}) })
      return manual?.retryAttempt ? { ok: false, started, code: refusalCode(error), reason: error?.message || String(error), accountRetry: error?.accountRetry,
        ...(deliveryOutcome ? { deliveryOutcome } : {}) } : false
    } finally {
      flights.delete(node.id)
      retained.count -= 1
      if (retained.count === 0) activeStores.delete(context.computerId)
      const next = deferred.get(node.id)
      deferred.delete(node.id)
      if (next) void recover(next)
      notifyRecoverySettled(node.id)
    }
  }
  const readHandoff = (context, nodeId) => context.handoffStore?.readRecord
    ? context.handoffStore.readRecord(nodeId) : context.handoffStore?.get(nodeId)
  const queuedSnapshots = new Map()
  function saveRetryPolicy(context, policy) {
    // Serialize the existing record. Stop mutates the same policy before it
    // queues its write, so a late completion cannot put enabled=true back.
    // Each write carries the snapshot taken when it was queued, and an
    // unchanged snapshot is not written again.
    const nodeId = policy.nodeId
    const snapshot = JSON.stringify(persistedPolicy(policy))
    if (queuedSnapshots.get(nodeId) === snapshot) return retryWrites.get(nodeId) || Promise.resolve()
    queuedSnapshots.set(nodeId, snapshot)
    const write = (retryWrites.get(nodeId) || Promise.resolve()).catch(() => {}).then(async () => {
      try {
        const record = await readHandoff(context, nodeId)
        const value = { ...record, handoff: record?.handoff || policy.handoff, retryPolicy: JSON.parse(snapshot) }
        const saved = context.handoffStore?.saveRecord
          ? await context.handoffStore.saveRecord(nodeId, value) : context.handoffStore?.save(nodeId, value)
        if (!saved) { policy.enabled = false; throw new Error('The automatic retry choice could not be saved. No further attempt was authorized.') }
        publish({ nodeId, retryPolicy: JSON.parse(snapshot) })
      } catch (error) {
        if (queuedSnapshots.get(nodeId) === snapshot) queuedSnapshots.delete(nodeId)
        throw error
      }
    })
    retryWrites.set(nodeId, write)
    return write
  }
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
  async function closeRetrySession(context, nodeId, sessionId, cleanupOwnership) {
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
  async function prepareRetryRole(context, policy, tierId) {
    const node = context.treeStore.getNode(policy.nodeId)
    const refuse = (message, code) => { throw Object.assign(new Error(message), { code }) }
    if (!node || node.role !== policy.nodeRole) refuse('The assigned role changed. Review the retry choice again.', 'AGENT_RETRY_ROLE_CHANGED')
    const tier = tiers.find(row => row.id === tierId)
    const binding = policy.startOptions?.roleBinding
    if (!policy.allowedProviders.includes(tier?.provider)) refuse('This provider is outside the saved retry choices.', 'AGENT_RETRY_PROVIDER_NOT_ALLOWED')
    if (!tier || !binding?.agentId || !orgBridge?.read || !orgBridge?.ensureSeat) refuse('The saved role identity cannot be confirmed.', 'AGENT_RETRY_ROLE_UNCONFIRMED')
    const snapshot = await orgBridge.read()
    const role = snapshot?.roles?.find(row => row.id === binding.id)
    const seat = snapshot?.org?.agents?.find(row => row.id === binding.agentId && row.enabled === true && row.role === binding.id)
    if (snapshot?.ok !== true || !role || !seat) refuse('The saved role identity is no longer assigned to this agent.', 'AGENT_RETRY_ROLE_UNCONFIRMED')
    const adopted = await orgBridge.ensureSeat({ id: seat.id, role: role.id, provider: tier.provider,
      adoptProvider: true, expectedRevision: snapshot.org.revision })
    if (adopted?.ok !== true) refuse(adopted?.reason || 'The existing role could not adopt the selected provider.', 'AGENT_RETRY_PROVIDER_SEAT_REFUSED')
    const preferred = tiers.find(row => row.id === policy.preferredTier)
    // Effort names belong to a provider. Codex and Claude share the depth
    // words, so max stays max across them. Antigravity fixes effort in the
    // model and Grok/Gemini offer less, so they use their verified tier value.
    // Native admission still verifies the requested value.
    const wanted = policy.preferredEffort || policy.startOptions?.effort || null
    const effort = preferred?.provider === tier.provider || ['codex', 'claude'].includes(tier.provider) && !tier.client
      ? (wanted || tier.effort || null)
      : (tier.effort || null)
    return { ...policy.startOptions, tier: tierId, effort,
      roleBinding: { ...binding, expectedOrgRevision: adopted.org.revision, expectedRoleRevision: role.revision } }
  }
  const retryableFailure = code => interruptionCodes.has(code) || /quota|usage.limit|rate.limit|context.limit|context.length|prompt.too.long|ACCOUNT_(?:UNAVAILABLE|EXHAUSTED|LIMIT)|ACP_(?:CLIENT_UNSUPPORTED|MODEL_REFUSED)/i.test(String(code || ''))
  async function runAccountRetry(context, policy, { immediate = false } = {}) {
    const nodeId = policy.nodeId
    if (!policy.enabled || deliveryHeld(policy) || retryFlights.has(nodeId) || flights.has(nodeId) || isReplacing(nodeId) || disposed) return false
    const flight = { cancelled: false, requestedSessionId: null }
    retryFlights.set(nodeId, flight)
    const allowed = () => {
      try { assertStartAllowed(true) } catch (error) { throw pauseError(error.message, 'safety') }
      if (flight.cancelled || !policy.enabled || disposed) throw pauseError('Automatic retries were cancelled.', 'safety')
      const node = context.treeStore.getNode(nodeId)
      if (!node || node.sessionId !== policy.sessionId || node.role !== policy.nodeRole) throw pauseError('This agent changed. Review its retry choice again.', 'safety')
      return node
    }
    try {
      let node = allowed()
      if (sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status) && !policy.failurePending) return false
      // A failed turn that has not completed since is itself open work. Only a
      // retry with no such failure asks the ledger for direction, with backoff.
      if (!immediate && !policy.lastFailureCode) {
        const direction = await bridge.continuations?.({ action: 'direction', sessionId: node.sessionId,
          requestKeys: address(context.treeStore, node).requestKeys })
        allowed()
        if (direction?.ok !== true || (direction.enabled === true && direction.actionable !== true)) {
          const delay = Math.min(DIRECTION_BACKOFF_MAX_MS, (directionChecks.get(nodeId)?.delay || 2500) * 2)
          directionChecks.set(nodeId, { delay, at: now() + delay })
          policy.state = 'no-direction'; policy.nextAttemptAt = null
          await saveRetryPolicy(context, policy); return false
        }
        directionChecks.delete(nodeId)
      }
      const result = await readAccounts?.()
      allowed()
      if (result?.available !== true && result?.ok !== true) throw pauseError('The registered account list could not be read.', 'transient')
      const accounts = (result.accounts || []).filter(row => row.signedIn !== false && row.signedIn !== 'no')
      const candidates = accountRetryCandidates(policy.preferredTier, tiers, accounts).filter(id => policy.allowedProviders.includes(tiers.find(row => row.id === id)?.provider))
      const timings = [], skipped = []
      // One bounded sweep of registered accounts. Eligibility and allowance
      // are always probed in main; these names only avoid failed repeats.
      let remaining = Math.min(128, accounts.length + candidates.length)
      const sweepAt = now()
      const initial = policy.sweepExclusions && typeof policy.sweepExclusions === 'object' ? policy.sweepExclusions : {}
      delete policy.sweepExclusions
      syncExclusions(policy, sweepAt)
      policy.state = 'starting'; policy.nextAttemptAt = null
      await saveRetryPolicy(context, policy)
      for (const tierId of candidates) {
        const tier = tiers.find(row => row.id === tierId)
        const held = heldAccounts(policy, tier.provider, sweepAt)
        const compatible = accounts.filter(row => row.provider === tier.provider && (row.client || null) === (tier.client || null))
        if (compatible.length && compatible.every(row => held.includes(row.name))) {
          // Every account for this client is on quota backoff: start nothing
          // and send no handoff until the earliest hold ends.
          const until = Math.min(...Object.values(policy.holds || {}).filter(row => row?.provider === tier.provider
            && compatible.some(account => account.name === row.account) && Number.isFinite(row.until)).map(row => row.until))
          if (Number.isFinite(until)) timings.push({ nextAttemptAt: new Date(until).toISOString(), resetAt: null, reason: 'account-backoff' })
          continue
        }
        const excluded = new Set([...(Array.isArray(initial[tier.provider]) ? initial[tier.provider] : []), ...held])
        while (remaining-- > 0) {
          node = allowed()
          const saved = context.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context.transcriptStore.get(nodeId)
          allowed()
          if (saved?.provider && saved.provider !== tier.provider && saved.threadId && !saved.recoveryDirectory) {
            skipped.push({ provider: tier.provider, code: 'AGENT_RETRY_HANDOFF_UNAVAILABLE' })
            policy.reason = 'The complete saved conversation is unavailable for a provider handoff. The original context was retained.'
            break
          }
          const prior = await readHandoff(context, nodeId)
          const handoff = manualAccountHandoff(node, saved, prior)
          allowed()
          policy.failurePending = false
          const outcome = await recover({ sessionId: node.sessionId, event: { type: 'account_recovery_needed',
            recoveryId: globalThis.crypto.randomUUID(), handoff } }, { computerId: context.computerId, nodeId,
            retryAttempt: true, flight, policy, startOptions: { ...policy.startOptions, tier: tierId },
            accountRetry: { excludeAccounts: [...excluded].slice(-32), recheckAttempt: policy.recheckAttempt } })
          flight.requestedSessionId = null
          const unresolvedDelivery = ['unknown', 'accepted'].includes(outcome?.deliveryOutcome)
          if (unresolvedDelivery) {
            const current = context.treeStore.getNode(nodeId)
            // Cancellation changes retry consent, not an already-dispatched
            // handoff's delivery fact. Keep that fact only on its own policy,
            // store, incarnation and attached session.
            if (retryPolicies.get(nodeId) !== policy
              || contexts.get(context.computerId)?.treeStore !== context.treeStore
              || !current || current.createdAt !== flight.cleanupOwnership?.expectedNodeCreatedAt
              || current.sessionId !== outcome.started?.sessionId
              || (sessionNodeIds.has(current.sessionId) && sessionNodeIds.get(current.sessionId) !== nodeId)) return false
            policy.deliveryHold = { sessionId: outcome.started.sessionId, outcome: outcome.deliveryOutcome }
            policy.failurePending = false
          }
          if (outcome?.started?.sessionId) {
            policy.sessionId = outcome.started.sessionId
            policy.actualTier = tierId; policy.actualProvider = tier.provider; policy.actualAccount = outcome.started.account || null
          }
          if (outcome?.ok) {
            policy.actualTier = tierId; policy.actualProvider = tier.provider; policy.actualAccount = outcome.started.account || null
            if (policy.failurePending && policy.actualAccount) holdAccount(policy, tier.provider, policy.actualAccount)
            policy.state = policy.failurePending ? 'waiting' : 'working'
            policy.nextAttemptAt = policy.failurePending ? now() : null
            policy.reason = null; policy.autoResumeCount = 0; policy.autoResumeAt = null
            // T124: an account accepted this node, so it is no longer blocked.
            if (!policy.failurePending) clearExternalBlock(nodeId)
            await saveRetryPolicy(context, policy)
            return true
          }
          if (flight.cancelled || !policy.enabled) {
            // Save the hold without changing enabled/state or reviving timers.
            if (unresolvedDelivery) await saveRetryPolicy(context, policy)
            // A cancel that landed after attach leaves this replacement here.
            if (outcome?.started?.sessionId && !outcome.started.cleanupPending && !closedSessions.has(outcome.started.sessionId)) {
              try { await closeRetrySession(context, nodeId, outcome.started.sessionId) } catch { /* retained as a visible Stop handle */ }
            }
            return false
          }
          if (unresolvedDelivery) {
            // A later process exit or quota packet cannot establish non-delivery.
            throw pauseError(outcome.deliveryOutcome === 'accepted'
              ? 'The handoff was accepted, but its result could not be saved. Check this conversation; it will not be sent again automatically.'
              : 'Handoff delivery could not be confirmed. Check this conversation before retrying; it will not be sent again automatically.', 'safety')
          }
          if (outcome?.started?.cleanupPending || outcome?.code === 'AGENT_SESSION_CLEANUP_FAILED') throw pauseError(outcome.reason || 'The replacement still needs cleanup.', 'safety')
          if (outcome?.started?.sessionId) await closeRetrySession(context, nodeId, outcome.started.sessionId)
          const account = outcome?.accountRetry?.account || outcome?.started?.account
          const code = String(outcome?.code || '')
          policy.lastCode = code.slice(0, 128)
          policy.reason = String(outcome?.reason || 'The account attempt was refused. Check the account\u2019s provider status, then try again.').slice(0, 600)
          if (policy.reason === policy.lastCode) policy.reason = outcome?.accountRetry?.retry?.reason === 'identity-action-required'
            ? 'An account identity could not be confirmed.' : 'No eligible account accepted this attempt. Review its provider status.'
          if (outcome?.accountRetry?.retry?.nextAttemptAt) timings.push(outcome.accountRetry.retry)
          if (account) excluded.add(account)
          if (account && retryFailureKind(code) === 'limit') holdAccount(policy, tier.provider, account)
          await saveRetryPolicy(context, policy)
          if (nodeSafetyRefusal(code) || outcome?.accountRetry?.retry?.reason === 'identity-action-required') throw pauseError(policy.reason, 'safety')
          if (providerScopedRefusal(code)) { skipped.push({ provider: tier.provider, code }); break }
          if (!retryableFailure(code) && !outcome?.accountRetry) throw pauseError(policy.reason, 'transient')
          // A provider-level refusal already walked all remaining eligible
          // accounts. Move to the next authorized provider, never sign in.
          if (!account) break
        }
      }
      allowed()
      const timing = timings.filter(row => Number.isFinite(Date.parse(row.nextAttemptAt)) && Date.parse(row.nextAttemptAt) > now())
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0]
      policy.recheckAttempt = Math.min(100000, policy.recheckAttempt + 1)
      policy.state = policy.waitForReset && timing ? 'waiting' : 'paused'
      policy.nextAttemptAt = policy.waitForReset && timing ? Date.parse(timing.nextAttemptAt) : null
      policy.resetAt = timing?.resetAt || null
      // Waiting was requested but nothing reported a time: re-check later, bounded.
      const count = Number(policy.autoResumeCount) || 0
      policy.autoResumeAt = policy.waitForReset && !timing && count < AUTO_RESUME_LIMIT ? now() + AUTO_RESUME_BASE_MS * 2 ** count : null
      if (skipped.length) policy.skippedProviders = [...new Set(skipped.map(row => row.provider))]
      else delete policy.skippedProviders
      if (!timing && !policy.reason) policy.reason = 'No eligible signed-in account is available.'
      await saveRetryPolicy(context, policy)
      /* T124. THE SWEEP IS OVER AND NOTHING TOOK THE NODE. A paused or
         reset-waiting policy stops AUTOMATIC RETRIES; on its own it has never
         stopped anything from delivering another message, and that is the
         half of the loop nobody was closing. Fence it here, whichever way the
         wait went: if a reset time is known the node is blocked until then,
         and spending turns in the meantime only earns the same refusal. A
         later successful attempt clears it above. */
      if (policy.failureKind === 'limit' || retryFailureKind(policy.lastFailureCode) === 'limit') {
        await blockExternally(context, nodeId,
          clampNote(`Blocked outside this app: ${policy.reason || 'no other model or account is available.'} This agent has stopped spending turns.`),
          null, policy.lastFailureCode)
      }
      return false
    } catch (error) {
      // Node-level safety waits for the person. A one-off error re-checks
      // itself a bounded number of times.
      const transient = error?.retryPause === 'transient' || (!error?.retryPause && !nodeSafetyRefusal(refusalCode(error)))
      const count = Number(policy.autoResumeCount) || 0
      policy.state = 'paused'; policy.nextAttemptAt = null; policy.reason = String(error.message || error).slice(0, 600)
      policy.autoResumeAt = transient && policy.enabled && count < AUTO_RESUME_LIMIT ? now() + AUTO_RESUME_BASE_MS * 2 ** count : null
      try { await saveRetryPolicy(context, policy) } catch (savingError) { policy.enabled = false; publish({ nodeId, error: savingError.message }) }
      publish({ nodeId, error: policy.reason })
      return false
    } finally { retryFlights.delete(nodeId); publish({ nodeId }); notifyRecoverySettled(nodeId) }
  }
  async function pollAccountRetries() {
    if (disposed) return
    for (const context of contexts.values()) for (const node of context.treeStore.snapshot().nodes) {
      const policy = retryPolicies.get(node.id)
      if (!policy?.enabled || deliveryHeld(policy) || retryFlights.has(node.id)) continue
      if (node.statusNote === 'Stopped by you.' && !policy.stopFenceAcknowledged) {
        policy.enabled = false; policy.state = 'cancelled'; policy.nextAttemptAt = null
        void saveRetryPolicy(context, policy).catch(error => publish({ nodeId: node.id, error: error.message }))
        continue
      }
      if (policy.state === 'working' && !sessionNodeIds.has(node.sessionId)) {
        // A healthy saved conversation keeps native continuity on reopening.
        // Account retry never turns an unobserved shutdown into a quota claim.
        await pollContinuations()
        continue
      }
      if (policy.state === 'no-direction') {
        const check = directionChecks.get(node.id)
        if (!check || check.at <= now()) void runAccountRetry(context, policy)
        continue
      }
      if (policy.state === 'paused' && Number.isFinite(policy.autoResumeAt) && policy.autoResumeAt <= now()) {
        policy.autoResumeCount = (Number(policy.autoResumeCount) || 0) + 1
        policy.autoResumeAt = null; policy.state = 'waiting'; policy.nextAttemptAt = now()
      }
      if (policy.state !== 'waiting' || !policy.nextAttemptAt || policy.nextAttemptAt > now()) continue
      // Holds are per account and expire on their own schedule; a recheck
      // never clears them.
      void runAccountRetry(context, policy)
    }
  }
  async function keepTryingAccounts({ computerId, nodeId, startOptions = {}, waitForReset = false, allowedProviders = null, choiceRevision = retryChoiceRevisions.get(nodeId) || 0 } = {}) {
    assertStartAllowed(true)
    const context = contexts.get(computerId)
    const node = context?.treeStore.getNode(nodeId)
    const providers = allowedProviders ?? defaultRetryProviders(tiers.find(row => row.id === (startOptions.tier || node?.tier))?.provider)
    if (!Array.isArray(providers) || !providers.length || providers.length > 4
      || providers.some(value => !RETRY_PROVIDERS.includes(value))) throw new Error('Choose at least one allowed provider for retries.')
    if (!node || retryFlights.has(nodeId) || flights.has(nodeId) || isReplacing(nodeId)) return false
    const preparation = { cancelled: false, requestedSessionId: null }
    const assertChoice = () => {
      assertStartAllowed(true)
      if (preparation.cancelled || choiceRevision !== (retryChoiceRevisions.get(nodeId) || 0)) throw new Error('Automatic retries were cancelled.')
    }
    assertChoice()
    retryFlights.set(nodeId, preparation)
    try {
      const saved = context.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context.transcriptStore.get(nodeId)
      const prior = await readHandoff(context, nodeId)
      assertChoice()
      if (context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      const existing = retryPolicies.get(nodeId)
      const stopped = node.statusNote === 'Stopped by you.'
      const policy = { v: 1, nodeId, nodeRole: node.role, enabled: true, waitForReset: waitForReset === true, allowedProviders: [...new Set(providers)],
        preferredTier: existing?.preferredTier || startOptions.tier || node.tier, preferredEffort: existing?.preferredEffort || startOptions.effort || node.effort || null,
        startOptions: Object.fromEntries(['tier', 'effort', 'profileId', 'roleBinding'].filter(key => startOptions[key] != null).map(key => [key, startOptions[key]])),
        sessionId: node.sessionId, state: 'working', exclusions: {}, holds: {}, recheckAttempt: 0, nextAttemptAt: null,
        actualTier: node.tier, actualProvider: saved?.provider || null, actualAccount: saved?.account || null,
        // An explicit opt-in on an agent the person stopped is recorded, not
        // undone; it still starts nothing until that agent is resumed.
        ...(stopped ? { stopFenceAcknowledged: true } : {}),
        handoff: manualAccountHandoff(node, saved, prior) }
      const busy = sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)
      if (!busy && node.status === 'turn-failed') {
        // The failed turn is open work; its account is skipped for the first sweep only.
        policy.lastFailureCode = 'TURN_FAILED'
        if (saved?.account && saved?.provider) policy.sweepExclusions = { [saved.provider]: [saved.account] }
      }
      const priorPolicy = prior?.retryPolicy?.nodeId === nodeId && prior.retryPolicy.sessionId === node.sessionId
        ? prior.retryPolicy : null
      const heldPolicy = deliveryHeld(existing) ? existing : deliveryHeld(priorPolicy) ? priorPolicy : null
      if (heldPolicy) {
        policy.deliveryHold = structuredClone(heldPolicy.deliveryHold)
        policy.state = 'paused'
        policy.reason = heldPolicy.reason || 'The earlier handoff needs delivery review before automatic recovery can continue.'
      }
      retryPolicies.set(nodeId, policy)
      retryWarnings.delete(nodeId)
      if (node.status === 'cancelled') pauseCancelledTurn(policy)
      await saveRetryPolicy(context, policy)
      assertChoice()
      if (deliveryHeld(policy)) return false
      if (busy || node.status === 'finished' || node.status === 'cancelled' || stopped) return true
      retryFlights.delete(nodeId)
      return runAccountRetry(context, policy, { immediate: true })
    } finally {
      if (retryFlights.get(nodeId) === preparation) retryFlights.delete(nodeId)
      notifyRecoverySettled(nodeId)
    }
  }
  function disableAccountRetries(nodeId) {
    retryChoiceRevisions.set(nodeId, (retryChoiceRevisions.get(nodeId) || 0) + 1)
    const policy = retryPolicies.get(nodeId)
    const flight = retryFlights.get(nodeId)
    if (flight) flight.cancelled = true
    if (policy) { policy.enabled = false; policy.nextAttemptAt = null; policy.state = 'cancelled'; policy.autoResumeAt = null }
    directionChecks.delete(nodeId)
    return { policy, flight, context: [...contexts.values()].find(row => row.treeStore.getNode(nodeId)) }
  }
  function persistCancelledChoice(nodeId, policy, context) {
    // Best effort and never awaited by Stop: a storage fault must not keep an
    // agent running. The in-memory policy is already off.
    if (!policy || !context) return
    void saveRetryPolicy(context, policy).then(() => { retryWarnings.delete(nodeId) }, () => {
      retryWarnings.set(nodeId, 'Retries are off for this session, but that choice could not be saved on this computer, so it may return after a restart. Check storage, then press Cancel retries again.')
      publish({ nodeId, error: retryWarnings.get(nodeId) })
    })
  }
  async function cancelAccountRetries(nodeId) {
    const { policy, flight, context } = disableAccountRetries(nodeId)
    if (!policy) return false
    try { if (flight?.requestedSessionId && context) await closeRetrySession(context, nodeId, flight.requestedSessionId) }
    finally { persistCancelledChoice(nodeId, policy, context) }
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
        if (hydratingNodes.has(id) || retryAttemptPending(id) || flights.has(id) || isReplacing(id) || sessionNodeIds.has(node.sessionId)) continue
        if (node.statusNote === 'Stopped by you.' || node.statusNote === 'Stop could not be confirmed. Use Stop again before resuming.') {
          await bridge.continuations({ action: 'stop', key: record.key })
          treeStore.setNodeStatus(id, 'finished', { note: 'Stopped by you.' })
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
        let started = null, retryQueued = false, refusalToContinue = null
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
            && current.statusNote !== 'Stopped by you.' && !attempt.stopped
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
          const policy = retryPolicies.get(id)
          if (policy?.enabled) { policy.sessionId = started.sessionId; await saveRetryPolicy(context, policy) }
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
            const policy = retryPolicies.get(id), kind = retryFailureKind(code)
            /* A RESUME THAT WAS REFUSED IS NOT A TURN THAT FAILED.
             *
             * OBSERVED on the owner's profile, 2026-09-21, first reopen after the
             * saved-continuation read started answering: thirteen resumes were
             * refused by the host before any session existed (eleven because the
             * saved seat had left the organisation) and this line rewrote ten
             * FINISHED conversations to 'turn-failed'. fleet-trees.js keeps
             * 'turn-failed' for a turn that ran and failed; no turn ran here, the
             * node still holds the session and transcript it was saved with, and
             * the host has already blocked the refused row or put it on its own
             * bounded retry.
             *
             * So a node that was saved settled keeps its status and gains only the
             * sentence. Two routes are left exactly as they were, because each
             * gives the person something to do from a failed circle: a refusal of
             * the SAVED ACCOUNT (the switch offer below) and a keep-trying policy
             * that is about to retry. A node saved mid-start or mid-turn has no
             * settled status to keep and is still marked. */
            const settled = ['finished', 'interrupted', 'cancelled'].includes(node.status)
            const keepsStatus = !started?.sessionId && settled && !savedAccountResumeRefused(code) && !(policy?.enabled && kind)
            const note = `Autonomous+ recovery paused: ${said}`
            // Said once: a later sweep that is refused the same way finds the
            // same status and the same sentence already on the circle.
            const current = treeStore.getNode(id)
            if (!(keepsStatus && current?.status === node.status && current.statusNote === note)) {
              treeStore.setNodeStatus(id, keepsStatus ? node.status : 'turn-failed', { note })
              publish({ nodeId: id, error: said })
            }
            if (policy?.enabled && kind && !attempt.cleanupRequired) {
              policy.sessionId = ownedSessionId
              await rememberRetryFailure(context, policy, code, kind)
              retryQueued = true
            }
            /* T367 / T381: THE REOPEN PATH DID NOT RESTART ON A REFUSAL.
             *
             * This is the path that brings every saved agent back when the app
             * is reopened, and until this lane an account the provider had
             * refused simply parked the circle at "recovery paused" -- the same
             * refusal the Resume press already continues from by itself (see
             * resumeNodeSessionUnguarded in src/views/computers.js) did nothing
             * here, because the only automatic route out of this catch was a
             * per-node keep-trying policy the person had to have opted into.
             *
             * The decision is deferred past `finally`, because
             * continueOnAnotherAccount refuses while this node's flight is
             * still held. The three conditions are the Resume press's own, and
             * each one can only say no: the PROVIDER refused it (an unattributed
             * limit is a maybe, and a maybe does not move somebody off their own
             * conversation); keep-trying is on, read failure-first by the
             * window; and this was not a cleanup failure or an opted-in retry,
             * which have their own routes. When the move cannot be made, the
             * window is told to OFFER the switch instead, so the person can
             * choose an account, a model and a depth on the circle. */
            if (!retryQueued && !attempt.cleanupRequired && savedAccountResumeRefused(code)) {
              const descriptor = record.descriptor || {}
              refusalToContinue = { code, attribution: refusalAttribution(error), account: saved.account || null,
                provider: saved.provider || descriptor.resumeThreadProvider || null, sentence: said,
                startOptions: Object.fromEntries(['tier', 'effort', 'profileId'].filter(key => descriptor[key] != null).map(key => [key, descriptor[key]])) }
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
          if (retryQueued) void pollAccountRetries()
        }
        if (refusalToContinue) {
          const offer = refusalToContinue
          refusalToContinue = null
          let moved = false
          if (offer.code === 'AGENT_RESUME_ACCOUNT_LIMIT' && offer.attribution === 'provider' && await keepTryingConsent()) {
            try { moved = await coordinator.continueOnAnotherAccount({ computerId: context.computerId, nodeId: id, startOptions: offer.startOptions }) === true }
            catch (error) { publish({ nodeId: id, error: error?.message || String(error) }) }
          }
          if (moved) switchOffersMade.delete(id)
          else if (treeStore.getNode(id)?.sessionId === ownedSessionId) {
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
  /* NAMED, NOT RETURNED ANONYMOUSLY, FOR EXACTLY ONE REASON (T124): the
     automatic limit failover above has to call this object's own
     continueOnAnotherModel -- the landed T137 switch -- rather than build a
     second one beside it. Nothing else about the returned surface changes. */
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
        continuationTimer = setInterval(() => { void pollAccountRetries(); void pollContinuations() }, 5000)
        continuationTimer.unref?.()
      }
      void Promise.all(context.treeStore.snapshot().nodes.map(async node => {
        if (retryPolicies.has(node.id)) return
        hydratingNodes.add(node.id)
        try {
          const record = await readHandoff(context, node.id)
          const policy = record?.retryPolicy
          if (policy?.v === 1 && policy.nodeId === node.id && policy.sessionId === node.sessionId
            && typeof policy.enabled === 'boolean' && typeof policy.startOptions?.roleBinding?.agentId === 'string'
            && Array.isArray(policy.allowedProviders) && policy.allowedProviders.length > 0 && policy.allowedProviders.length <= 4
            && policy.allowedProviders.every(value => ['codex', 'claude', 'gemini', 'grok'].includes(value))
            && policy.exclusions && typeof policy.exclusions === 'object' && !retryPolicies.has(node.id)) {
            // A sweep that was in flight when the app stopped is due again,
            // never left claiming an attempt that no longer exists.
            if (policy.enabled && policy.state === 'starting') { policy.state = 'waiting'; policy.nextAttemptAt = now() }
            retryPolicies.set(node.id, policy)
            publish({ nodeId: node.id, retryPolicy: persistedPolicy(policy) })
          }
        } catch (error) { publish({ nodeId: node.id, error: error.message }) }
        finally { hydratingNodes.delete(node.id) }
      })).then(() => { void pollAccountRetries(); void pollContinuations() })
      /* THE STORE A RECOVERY HOLDS MUST NOT OUTLIVE THE PAGE THAT OPENED IT.
       *
       * MEASURED, Worker 36 and Controller 2026-09-06: recover() (below) reads
       * `activeStores.get(computerId) || { store: treeStore, count: 0 }` once,
       * the FIRST time a recovery starts for this computer, and every
       * overlapping recover() after that only bumps `.count` -- none of them
       * ever reassigns `.store`. A view can be destroyed and reopened for the
       * SAME computer while that recovery is still running (activeStore's own
       * caller, openTreeStore, exists specifically to survive exactly that
       * teardown), and register() ran again here with a fresh treeStore and
       * said nothing to activeStores. So `activeStore(computerId)` kept
       * answering the superseded store for the rest of the recovery's
       * lifetime -- the same class of staleness src/views/computers.js's
       * resolveLiveTreeStore was written to stop trusting from this exact
       * function.
       *
       * REASSIGN IN PLACE, DO NOT REFUSE. A refusal (returning null while a
       * recovery is genuinely in flight) would be honest but pointless here:
       * this line always has a definitively current store to give --
       * `context.treeStore`, the same one just stored in `contexts` above --
       * so there is no currency this function "cannot establish". recover()
       * itself is unaffected: it destructured its own `treeStore` from
       * `context` back when IT started and keeps using that reference for
       * every write for the rest of its own run, exactly as before; only
       * what `activeStore()` hands to OTHER callers changes. */
      const retainedStore = activeStores.get(computerId)
      if (retainedStore) retainedStore.store = context.treeStore
      if (!unsubscribe && typeof bridge?.onEvent === 'function') unsubscribe = bridge.onEvent(packet => { observePacket(packet); void recover(packet) })
      for (const [sessionId, record] of recoveredSessions) {
        if (record.computerId !== computerId || !record.text) continue
        publish({ nodeId: record.nodeId, started: { ...record.started, sessionId },
          lines: context.transcriptStore.get(record.nodeId)?.lines || [], partialText: record.text })
      }
      // One bounded read on mounting, not a timer. Replays failures observed
      // before the renderer registered this computer.
      if (typeof bridge?.sessionAccounts === 'function') {
        void Promise.resolve(bridge.sessionAccounts()).then(answer => {
          for (const packet of answer?.recoveries || []) void recover(packet)
        }).catch(() => {})
      }
    },
    recover,
    pollContinuations,
    continuationStatus: () => continuationReadStatus ? { ...continuationReadStatus } : null,
    pollAccountRetries, keepTryingAccounts, cancelAccountRetries,
    retryChoiceRevision: nodeId => retryChoiceRevisions.get(nodeId) || 0,
    retryPolicy: nodeId => { const policy = retryPolicies.get(nodeId); return policy ? structuredClone(policy) : null },
    retryStatus: (nodeId, { compact = false } = {}) => {
      const node = [...contexts.values()].map(row => row.treeStore.getNode(nodeId)).find(Boolean)
      return accountRetryStatus(retryPolicies.get(nodeId), { compact, warning: retryWarnings.get(nodeId) || null, stopped: node?.statusNote === 'Stopped by you.',
        busy: Boolean(node && sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)) })
    },
    async setAllowedProviders(nodeId, providers) {
      const policy = retryPolicies.get(nodeId)
      const context = [...contexts.values()].find(row => row.treeStore.getNode(nodeId))
      if (!policy || !context || retryFlights.has(nodeId)) return false
      if (!Array.isArray(providers) || !providers.length || providers.length > 4
        || providers.some(value => !['codex', 'claude', 'gemini', 'grok'].includes(value))) throw new Error('Choose at least one allowed provider for retries.')
      policy.allowedProviders = [...new Set(providers)]
      await saveRetryPolicy(context, policy); return true
    },
    async setWaitForResets(nodeId, enabled) {
      const policy = retryPolicies.get(nodeId)
      const context = [...contexts.values()].find(row => row.treeStore.getNode(nodeId))
      if (!policy || !context) return false
      policy.waitForReset = enabled === true
      if (!policy.waitForReset && policy.state === 'waiting' && !policy.failurePending) { policy.state = 'paused'; policy.nextAttemptAt = null }
      if (policy.waitForReset && policy.state === 'paused' && !deliveryHeld(policy)) { policy.state = 'waiting'; policy.nextAttemptAt = now() }
      await saveRetryPolicy(context, policy); void pollAccountRetries(); return true
    },
    async stopContinuation(nodeId) {
      // Stop never waits on storage: retries are off in memory first, any
      // replacement this flight was starting is closed, and the saved choice
      // is written afterwards, best effort, with a visible warning on failure.
      const { policy, flight, context } = disableAccountRetries(nodeId)
      try { if (flight?.requestedSessionId && context) await closeRetrySession(context, nodeId, flight.requestedSessionId) }
      finally { persistCancelledChoice(nodeId, policy, context) }
      const attempt = continuationFlights.get(nodeId)
      if (!attempt) return false
      attempt.stopped = true
      await bridge.continuations({ action: 'stop', key: attempt.key })
      attempt.stopConfirmed = true
      if (attempt.finished) attempt.showStop()
      return true
    },
    async continueOnAnotherAccount({ computerId, nodeId, startOptions = {}, isCurrent } = {}) {
      const choiceRevision = retryChoiceRevisions.get(nodeId) || 0
      const context = contexts.get(computerId)
      const node = context?.treeStore.getNode(nodeId)
      const cleanupOwnership = Object.freeze({ expectedNodeCreatedAt: node?.createdAt, expectedNodeSessionId: node?.sessionId })
      // Keep the entry incarnation across reads and through recovery. Session
      // currency is checked separately so our own attachment remains valid.
      const originValid = () => !disposed && Boolean(node)
        && context.treeStore.getNode(nodeId)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
        && choiceRevision === (retryChoiceRevisions.get(nodeId) || 0) && currentChoice(isCurrent)
      if (!originValid()) return false
      let saved
      try { saved = context?.transcriptStore.readLatest ? await context.transcriptStore.readLatest(nodeId) : context?.transcriptStore.get(nodeId) }
      catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context?.treeStore.getNode(nodeId)?.sessionId !== node?.sessionId
        || !node?.sessionId || (!saved?.account && !startOptions.treeAccount) || flights.has(nodeId) || isReplacing(nodeId)) return false
      if (sessionNodeIds.has(node.sessionId) && ['starting', 'running'].includes(node.status)) return false
      const account = saved?.account || null
      const options = Object.fromEntries(['tier', 'effort', 'profileId', 'roleBinding', 'treeAccount'].filter(key => startOptions[key] != null).map(key => [key, startOptions[key]]))
      let priorHandoff
      try {
        priorHandoff = context.handoffStore?.readRecord
          ? await context.handoffStore.readRecord(nodeId)
          : context.handoffStore?.get(nodeId)
      } catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      const handoff = manualAccountHandoff(node, saved, priorHandoff)
      const moved = Boolean(await recover({ sessionId: node.sessionId, event: { type: 'account_recovery_needed',
        recoveryId: globalThis.crypto.randomUUID(), handoff } }, { computerId, nodeId, account, startOptions: options, originValid, cleanupOwnership })
      )
      /* T124: this is the move that recovered the node by hand every single
         time in the measured run. When it works, the block is over. */
      if (moved && originValid()) clearExternalBlock(nodeId)
      return moved
    },
    /* OWNER REQUEST T137 (2026-09-16): the model switch as a continuation. The
       Claude CLI binds --model at spawn and no thread crosses providers, so a
       model the running thread cannot take in place is reached the way another
       account is: end this session, start a fresh one on the chosen tier, send
       it the handoff. Unlike continueOnAnotherAccount this is asked of a LIVE
       session between turns (the renderer refuses it mid-turn); recover()
       closes the predecessor, starts the replacement on whichever account the
       ordinary start picks for that tier, records the new tier on the node and
       the new provider on the transcript, and sends the model handoff. */
    async continueOnAnotherModel({ computerId, nodeId, startOptions = {}, isCurrent } = {}) {
      const choiceRevision = retryChoiceRevisions.get(nodeId) || 0
      const context = contexts.get(computerId)
      const node = context?.treeStore.getNode(nodeId)
      const cleanupOwnership = Object.freeze({ expectedNodeCreatedAt: node?.createdAt, expectedNodeSessionId: node?.sessionId })
      // Keep the entry incarnation across reads and through recovery. Session
      // currency is checked separately so our own attachment remains valid.
      const originValid = () => !disposed && Boolean(node)
        && context.treeStore.getNode(nodeId)?.createdAt === cleanupOwnership.expectedNodeCreatedAt
        && choiceRevision === (retryChoiceRevisions.get(nodeId) || 0) && currentChoice(isCurrent)
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
      if (tier.id === node.tier && (!saved?.provider || saved.provider === tier.provider)) return false
      const options = Object.fromEntries(['tier', 'effort', 'profileId', 'roleBinding', 'treeAccount'].filter(key => startOptions[key] != null).map(key => [key, startOptions[key]]))
      let priorHandoff
      try { priorHandoff = await readHandoff(context, nodeId) }
      catch (error) { if (originValid()) publish({ nodeId, error: error.message || String(error) }); return false }
      if (!originValid() || context.treeStore.getNode(nodeId)?.sessionId !== node.sessionId) return false
      const configured = tiers.find(row => row.id === node.tier) || null
      const from = saved?.provider && saved.provider !== configured?.provider
        ? { label: saved.model || saved.provider, provider: saved.provider } : configured
      const name = row => row ? `${row.label} (${row.provider})` : 'unrecorded'
      const handoff = manualModelHandoff(node, saved, priorHandoff, { fromLabel: name(from), toLabel: name(tier) })
      return Boolean(await recover({ sessionId: node.sessionId, event: { type: 'account_recovery_needed',
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
       scheduled retries, reset waits and the person's manual continuation all
       still run, and each clears it when it works. */
    externalBlock: nodeId => { const record = externalBlocks.get(nodeId); return record ? { ...record } : null },
    subscribeRecoverySettled(listener) {
      if (typeof listener !== 'function') throw new TypeError('A recovery listener is required.')
      settledListeners.add(listener)
      return () => settledListeners.delete(listener)
    },
    isRecovering: nodeId => flights.has(nodeId) || retryFlights.has(nodeId),
    isContinuing: nodeId => continuationFlights.has(nodeId),
    canRetry: nodeId => retryable.has(nodeId) && !flights.has(nodeId),
    async retry(nodeId) {
      const held = retryable.get(nodeId)
      if (!held || flights.has(nodeId)) return false
      const { packet, context, createdAt, revision } = held
      const current = context.treeStore.getNode(nodeId)
      // A confirmed close retires the live-session lookup, not this saved
      // conversation. Retry uses its original store and immutable identity.
      // Never reintroduce a closed session into the runtime ownership map.
      if (contexts.get(context.computerId)?.treeStore !== context.treeStore
        || !current || current.createdAt !== createdAt || current.sessionId !== packet.sessionId
        || revision !== (retryChoiceRevisions.get(nodeId) || 0)
        || (sessionNodeIds.has(packet.sessionId) && sessionNodeIds.get(packet.sessionId) !== nodeId)) {
        publish({ nodeId, error: 'The saved recovery no longer belongs to this conversation. Review its current session before retrying.' })
        return false
      }
      seen.delete(packet.event.recoveryId)
      return await recover(packet, null, { ...context, node: current }) === true
    },
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
      for (const flight of retryFlights.values()) flight.cancelled = true
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
      modelsTried.clear()
    },
  }
  return coordinator
}
