/* Main-process ownership for the renderer leg of a tree-node command.
 *
 * The file spool owns durability and one-time claiming.  This broker owns the
 * bounded in-process gap after a claim: one active command, a completion
 * timeout, reload-to-durable-failure behavior, and bounded result-write
 * retries.  A permanently unwritable result is reported and released; it can
 * never wedge later requests behind an immortal in-memory active slot.
 */

/* HOW LONG A CIRCLE IS GIVEN TO APPEAR, AND WHY IT IS THIS NUMBER.
 *
 * MEASURED 2026-09-03 from the owner's own ledger, every agent.spawn that
 * carried a duration (111 records):
 *
 *   SUCCEEDED           n=20   min 6.4s   median 17.0s   p90 41.8s   max 225.7s
 *   COMPLETION_TIMEOUT  n=9    min 45.3s  median 45.4s   max 47.8s
 *
 * The deadline was 45 seconds, which is INSIDE the distribution of the thing
 * it was guarding. One successful spawn in ten already finished within three
 * seconds of it, and a spawn that legitimately took three minutes was killed
 * at forty-five seconds. Every one of the nine timeouts sits in a dead heat
 * at the deadline itself -- the signature of a clock expiring, not of work
 * failing. The owner's words for the result: "something works for 15 minutes
 * and then fails. NOTHING is reliable." It was not intermittent; it was a
 * coin toss weighted by how busy the machine was.
 *
 * A start is genuinely expensive -- it plans confinement, probes an account,
 * spawns a provider child and waits for the first turn -- and it gets slower
 * exactly when the fleet is busiest, which is when spawning matters most.
 *
 * Five minutes clears the whole observed range with room above the slowest
 * success ever recorded here. It is still a bound: a command that hangs is
 * still released, still reported, and still cannot wedge the queue behind an
 * immortal slot. What it no longer does is manufacture a failure out of a
 * start that was going to succeed.
 *
 * AND IT MUST EXPIRE INSIDE THE CALLER'S OWN BUDGET, NOT OUTSIDE IT. main.cjs
 * waits TREE_SPAWN_DELIVERY_MS -- 330 s -- for the same errand, and this
 * deadline is 300 s, deliberately the shorter of the two. An earlier draft of
 * this paragraph said the opposite ("it must not be shorter than the caller's
 * own budget"), which the constant three lines below it has never obeyed; a
 * reader who believed it and raised this number would break the two things the
 * ordering buys:
 *
 *   THIS BROKER OWNS THE ONE ACTIVE SLOT. If the caller's timer won the race,
 *   the caller would be answered while the slot stayed occupied for the
 *   remaining thirty seconds, holding every queued command behind an errand
 *   nobody is waiting for any more. Giving up first is what releases it.
 *
 *   THE ONE THAT ANSWERS IS THE ONE THAT HAS TO EXPLAIN. Because this
 *   deadline is reached first, MC_TREE_COMMAND_COMPLETION_TIMEOUT is the
 *   sentence an assistant actually reads, so it is written in this file's own
 *   REFUSAL_SENTENCES below and says the circle may already be on screen --
 *   the one fact that stops a retry opening a second paid session. It went
 *   nine times to the ledger as a bare code first.
 *
 * The caller's extra thirty seconds are not slack, they are the OTHER case:
 * this deadline starts only once a command is ACTIVE, so a command queued
 * while the renderer is not ready is not on any clock here at all, and
 * TREE_SPAWN_DELIVERY_MS is the only thing that ever answers it. */
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([75, 250, 750])

/* HOW MANY REQUEST IDS THE "DO NOT QUEUE THIS TWICE" MEMORY MAY HOLD.
 *
 * `known` exists for one job: a request id that has already been queued in this
 * process is never queued again, so a spool wake that arrives twice cannot
 * start two circles. It answered that correctly and then kept every id forever
 * -- the Set was only ever added to, and dispose() cleared the queue and left
 * it standing. Every tree command this process ever saw stayed in memory for
 * the life of the app, which is the one main-process structure in this file
 * that grew with work done rather than with work outstanding.
 *
 * MEASURED 2026-09-03 (lane H): 36 bytes of id plus the Set's own slot, so a
 * fleet doing a spawn every few seconds costs kilobytes an hour, not megabytes.
 * That is why this is a bound and not a rewrite: the defect is that it had no
 * ceiling at all, and an unbounded structure in the process that must not die
 * is worth closing whatever its slope.
 *
 * THE CEILING IS INSERTION-ORDERED AND DROPS THE OLDEST, the same shape
 * shell/agent-notifications.cjs uses for its stop memory. Dropping the oldest
 * is safe in a way dropping the newest would not be: a duplicate wake for a
 * request arrives within the request's own lifetime -- the spool file is
 * claimed and answered in seconds -- so the ids that matter are always the
 * recent ones, and an id old enough to fall off this end names a command that
 * was settled long ago and whose spool file no longer exists to be re-read.
 * Ten thousand is far above any burst a person's fleet produces in a session
 * and still a fixed, provable ceiling. */
const MAX_KNOWN_REQUEST_IDS = 10_000

function failureResult(envelope, code) {
  return Object.freeze({
    requestId: envelope.request.requestId,
    ok: false,
    code,
    nodeId: envelope.request.nodeId,
    sessionId: null,
    threadId: null,
  })
}

/* A CODE IS NOT A REASON, AND THE CALLER WAITING ON THIS ONE IS AN ASSISTANT.
 *
 * A reload refusal reached the caller as the code alone: shell/main.cjs turned
 * it into "The application could not add that assistant to the tree
 * (<the code>)", which names the failure twice and explains it never. The
 * caller then has exactly one decision to make -- ask again, or do not -- and
 * nothing to make it with.
 *
 * A LOST ANSWER is the refusal that costs real money to guess at, in EITHER
 * direction, and this broker can lose one two ways: the window reloads under
 * an accepted request, or the renderer simply never reports back before the
 * timeout. Both are below. rendererReloaded does not replay the command,
 * because the start may already have succeeded: bridge.start is an IPC call
 * into this process (shell/fleet-profile-preload.cjs invokes 'mc-agent:start'),
 * so a session it created outlives the window that asked for it. A caller that
 * assumes failure and repeats the request can therefore pay for a second
 * session; a caller that assumes success and never looks leaves the errand
 * undone. Not replaying is right, and it is only right if the caller is told
 * enough to decide -- so the sentence says what happened, what was NOT done
 * about it, and what to look at before asking again.
 *
 * WHAT IT MUST NOT SAY is that nothing started. That is not known here and
 * cannot be, and it is the one sentence that would turn this refusal into a
 * second paid session.
 *
 * THE DEADLINE IS THE SAME REFUSAL AND WAS STILL SAYING THE FORBIDDEN
 * SENTENCE. The paragraph above was written for the reload and stopped there,
 * but MC_TREE_COMMAND_COMPLETION_TIMEOUT is raised on a slot that has ALREADY
 * been handed to the renderer -- the timer is armed before the sendToRenderer
 * await, and any failure of that send clears it and answers
 * MC_TREE_COMMAND_RENDERER_UNAVAILABLE instead -- so when this deadline
 * expires the start is in flight and its outcome is exactly as unknown as
 * after a reload. It fell through to the caller's errand wording, which is
 * "The application could not add that assistant to the tree
 * (MC_TREE_COMMAND_COMPLETION_TIMEOUT)": the one sentence three paragraphs up
 * says must never be said, because it reads as "nothing started". Nine such
 * records stand in capability/logs/actions.jsonl against agent.spawn.
 *
 * MC_TREE_COMMAND_RENDERER_UNAVAILABLE is the opposite case and gets the
 * opposite sentence. Nothing was sent -- sendToRenderer threw before the
 * renderer saw anything -- so it is the ONE broker refusal that may say the
 * work did not start, and the only one with a move for the person to make.
 *
 * A code with no entry gets no sentence rather than a vague one: the caller
 * keeps its own wording for those, and a guess dressed as an explanation is
 * the defect this file is repairing, not a smaller version of it. */
const REFUSAL_SENTENCES = Object.freeze({
  MC_TREE_COMMAND_RENDERER_RELOADED: 'The application window reloaded before this request was answered, so the answer was lost. '
    + 'The request was not repeated, because the work may already have been done and repeating it could start a second paid session. '
    + 'Look at the tree, then send this request again if nothing changed.',
  /* THE SAME REFUSAL, ARRIVING THE OTHER WAY, AND THE ONE THE FLEET ACTUALLY
     HITS. The action ledger holds nine agent.spawn failures reading only "The
     application could not add that assistant to the tree
     (MC_TREE_COMMAND_COMPLETION_TIMEOUT)" -- more than the reload above, and
     the most recent of the two -- eight of them inside forty-three minutes.
     The timer that raises it is armed in `pump` only AFTER the request has
     been handed to the renderer, and firing it does not replay: settleActive
     publishes the failure and moves on. So the facts are exactly the reload's
     facts -- the request was delivered, the answer never came back, nothing
     was undone and nothing was repeated -- and the caller has the same money
     at stake in guessing. It gets the same three things: what happened, what
     the application did NOT do about it, and what to look at before asking
     again. It must not say the start failed; that is not known here. */
  MC_TREE_COMMAND_COMPLETION_TIMEOUT: 'The application was given this request but did not report back in time, so the answer was lost. '
    + 'The request was not repeated, because the work may already have been done and repeating it could start a second paid session. '
    + 'Look at the tree, then send this request again if nothing changed.',
  MC_TREE_COMMAND_RENDERER_UNAVAILABLE: 'The application window was not there to receive this request, so nothing was started. '
    + 'Open the Computers page for this computer on screen, then send this request again.',
})

/* The sentence a waiting caller is handed for one refusal code, or null for a
   code this broker has no words for. */
function treeNodeCommandRefusalSentence(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_SENTENCES, code)
    ? REFUSAL_SENTENCES[code]
    : null
}

function createTreeNodeCommandBroker({
  loadAndClaim,
  publishResult,
  sendToRenderer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  onError = () => {},
  onTerminalPublicationFailure = () => {},
  maxKnownRequestIds = MAX_KNOWN_REQUEST_IDS,
} = {}) {
  if (typeof loadAndClaim !== 'function' || typeof publishResult !== 'function' || typeof sendToRenderer !== 'function') {
    throw new TypeError('Tree-node command broker requires loadAndClaim, publishResult, and sendToRenderer functions.')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Tree-node command timeout must be positive.')
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Tree-node command retry delays must be a non-negative array.')
  }
  if (!Number.isSafeInteger(maxKnownRequestIds) || maxKnownRequestIds < 1) {
    throw new TypeError('Tree-node command known-request ceiling must be a positive integer.')
  }

  const queue = []
  const known = new Set()
  let rendererReady = false
  let active = null
  let publishing = false
  let pumping = false
  let disposed = false

  async function publishWithRetry(envelope, result) {
    let lastError = null
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await wait(retryDelaysMs[attempt - 1])
      try {
        return { ok: true, value: await publishResult(envelope, result), attempts: attempt + 1 }
      } catch (error) {
        lastError = error
        try { onError(error, { phase: 'publish', requestId: envelope.request.requestId, attempt: attempt + 1 }) } catch {}
      }
    }
    try { onTerminalPublicationFailure(lastError, envelope, result) } catch {}
    return { ok: false, error: lastError, attempts: retryDelaysMs.length + 1 }
  }

  async function settleActive(expected, result) {
    if (!expected || active !== expected) {
      return { ok: false, code: 'MC_TREE_COMMAND_NO_ACTIVE_REQUEST' }
    }
    active = null
    clearTimer(expected.timeoutHandle)
    publishing = true
    const publication = await publishWithRetry(expected.envelope, result)
    publishing = false
    void pump()
    if (!publication.ok) return { ok: false, code: 'MC_TREE_COMMAND_RESULT_WRITE_FAILED' }
    return {
      ok: true,
      requestId: expected.envelope.request.requestId,
      result: result.ok === true ? 'completed' : 'refused',
      attempts: publication.attempts,
    }
  }

  async function pump() {
    if (pumping || publishing || disposed) return
    pumping = true
    try {
      while (rendererReady && !active && !publishing && queue.length > 0 && !disposed) {
        const requestId = queue.shift()
        let envelope
        try {
          envelope = await loadAndClaim(requestId)
        } catch (error) {
          try { onError(error, { phase: 'claim', requestId }) } catch {}
          continue
        }
        const suppliedExpiry = Date.parse(envelope.request.expiresAt)
        const expiresAt = Math.min(now() + timeoutMs, Number.isFinite(suppliedExpiry) ? suppliedExpiry : Infinity)
        const request = Object.freeze({ ...envelope.request, expiresAt: new Date(expiresAt).toISOString() })
        const slot = { envelope, request, expiresAt, nodeId: null, timeoutHandle: null }
        active = slot
        if (expiresAt <= now()) {
          await settleActive(slot, failureResult(envelope, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT'))
          continue
        }
        slot.timeoutHandle = setTimer(() => {
          void settleActive(slot, failureResult(envelope, 'MC_TREE_COMMAND_COMPLETION_TIMEOUT'))
        }, Math.max(0, expiresAt - now()))
        try {
          await sendToRenderer(request)
        } catch (error) {
          try { onError(error, { phase: 'dispatch', requestId }) } catch {}
          await settleActive(slot, failureResult(envelope, 'MC_TREE_COMMAND_RENDERER_UNAVAILABLE'))
        }
      }
    } finally {
      pumping = false
      if (rendererReady && !active && !publishing && queue.length > 0 && !disposed) queueMicrotask(() => { void pump() })
    }
  }

  function queueRequest(requestId) {
    if (disposed || typeof requestId !== 'string' || !requestId || known.has(requestId)) return false
    known.add(requestId)
    /* See MAX_KNOWN_REQUEST_IDS. Insertion-ordered, oldest first out. */
    while (known.size > maxKnownRequestIds) {
      const oldest = known.values().next()
      if (oldest.done) break
      known.delete(oldest.value)
    }
    queue.push(requestId)
    void pump()
    return true
  }

  function setRendererReady(value) {
    rendererReady = value === true
    if (rendererReady) void pump()
  }

  async function rendererReloaded(code = 'MC_TREE_COMMAND_RENDERER_RELOADED') {
    rendererReady = false
    const slot = active
    if (!slot) return { ok: true, result: 'idle' }
    /* Never replay an accepted command after reload: bridge.start may already
       have succeeded even if the renderer died before its completion IPC.
       Replaying could create a second paid session.  The immutable result says
       completion was lost and leaves recovery to an explicit new request --
       and REFUSAL_SENTENCES above is how the caller is told that, so the
       recovery is a decision it can make rather than a code it must guess at. */
    return settleActive(slot, failureResult(slot.envelope, code))
  }

  async function complete(result) {
    const slot = active
    if (!slot) return { ok: false, code: 'MC_TREE_COMMAND_NO_ACTIVE_REQUEST' }
    if (!result || result.requestId !== slot.envelope.request.requestId) {
      return { ok: false, code: 'MC_TREE_COMMAND_RESULT_MISMATCH' }
    }
    return settleActive(slot, result)
  }

  // Main owns this context. An opaque id from the renderer cannot extend a
  // settled command or bind a second circle to the same create request.
  function startContext(requestId) {
    const slot = active
    if (!slot || slot.request.requestId !== requestId) return null
    function assertCurrent() {
      if (disposed || active !== slot || now() >= slot.expiresAt) {
        const error = new Error('The tree start request expired before native dispatch.')
        error.code = 'MC_TREE_COMMAND_COMPLETION_TIMEOUT'
        throw error
      }
    }
    return Object.freeze({ request: slot.request, assertCurrent,
      bindNode(nodeId) {
        assertCurrent()
        if (!nodeId || (slot.nodeId && slot.nodeId !== nodeId)) {
          const error = new Error('This tree start request already names a different circle.')
          error.code = 'TREE_DELEGATION_REFUSED'
          throw error
        }
        slot.nodeId = nodeId
      },
    })
  }

  function state() {
    return Object.freeze({
      queued: queue.length,
      /* WHAT THE MEMORY IS HOLDING, so the main process's heap guard can say
         the size of this cache out loud rather than guess at it. See
         shell/heap-guard.cjs. */
      known: known.size,
      activeRequestId: active?.envelope?.request?.requestId || null,
      publishing,
      rendererReady,
      disposed,
    })
  }

  /* DROP THE DUPLICATE-WAKE MEMORY. Called only by the main process's heap
     guard when the heap is close to its limit: a forgotten id can at worst let
     one already-settled spool wake be re-read, and the spool's own claim step
     refuses a request whose file is gone. Keeping the app alive is worth more
     than that. */
  function forgetKnownRequests() {
    const dropped = known.size
    known.clear()
    for (const requestId of queue) known.add(requestId)
    if (active) known.add(active.envelope.request.requestId)
    return dropped - known.size
  }

  function dispose() {
    disposed = true
    rendererReady = false
    queue.length = 0
    known.clear()
    if (active) clearTimer(active.timeoutHandle)
    active = null
  }

  return Object.freeze({ complete, dispose, forgetKnownRequests, queueRequest, rendererReloaded, setRendererReady, startContext, state })
}

/* QUEUE A REQUEST, OR REFUSE IT -- ONE DECISION FOR EVERY DOOR A COMMAND CAN
 * ARRIVE THROUGH.
 *
 * queueRequest() above answers false, and never throws, for three reasons: a
 * disposed broker, a malformed id, or an id this process has already queued.
 * Answering false is the whole of what it does -- it writes nothing and tells
 * nobody. shell/main.cjs's LOCAL create path (dispatchTreeSpawn) learned that
 * once and checks the return value ("A QUEUE THAT SAID NO IS AN ANSWER, NOT A
 * WAIT"). The SAME broker has a second caller in the same file --
 * handleSecondInstance, reached from an entirely different OS process when a
 * coordinator's detached helper hands a spooled request to the already-running
 * instance through Electron's single-instance relay -- and until now that
 * caller called queueRequest and threw the boolean away:
 *
 *   if (!requestId) return null
 *   queueTreeNodeCommand(requestId)
 *   return { focus: false }
 *
 * The helper is spawned with stdio ignored (tools/launch-tree-node-command.mjs),
 * so nothing on that side ever sees a console line either. The request it
 * named just sat in the spool, unclaimed and unrefused, until its own
 * lifetimeMs timed it out -- to a coordinator polling for the result, that is
 * an unexplained hang, not an answer, the exact shape the LOCAL path's own fix
 * exists to prevent.
 *
 * BUT THE THREE REASONS queueRequest REFUSES ARE NOT INTERCHANGEABLE, and an
 * earlier version of this function treated them as one. A malformed id cannot
 * reach here at all -- both callers already guard it (handleSecondInstance:
 * "if (!requestId) return null"). That leaves two real cases, and only one of
 * them means nobody is coming:
 *
 *   DISPOSED. The app is shutting down. Nothing in this process will ever
 *   claim or answer this request again -- refusing is the only way it is
 *   answered at all, and nothing else can race the write.
 *
 *   ALREADY KNOWN. This exact process already accepted this id -- it is
 *   sitting in the queue, or active, or (if it settled fast) already
 *   completed on disk. tools/write-tree-node-command.mjs prints the launch
 *   switch for a coordinator to hand to the executable *separately* from
 *   writing the request, specifically so a coordinator can retry the launch
 *   without re-writing it -- so a second handleSecondInstance call for the
 *   SAME id, from a second OS-level launch of the same printed switch, is not
 *   a hypothetical. THE ORIGINAL ACCEPTANCE IS GOING TO ANSWER THIS REQUEST.
 *   Refusing here does not just duplicate that answer -- it can BEAT it.
 *   loadAndClaim's file-level claim (shell/main.cjs, shell/tree-node-command.cjs
 *   claimTreeNodeCommand) only happens once pump() actually dequeues the id,
 *   which does not happen until the renderer is ready; a request that is only
 *   *queued*, not yet claimed on disk, holds no claim file yet. A refusal
 *   written for the duplicate claims-and-completes that same disk slot FIRST,
 *   so when the real pump() later reaches the same id, loadAndClaim finds it
 *   already completed, throws, and pump's own catch swallows that silently
 *   and moves on (see pump: "catch (error) { onError(...); continue }") --
 *   the legitimate request is dropped without ever reaching sendToRenderer,
 *   and the coordinator is left holding a wrong "REQUEST_REFUSED" answer for
 *   a command that was still live. PROVEN in tools/test/tree-node-command.test.mjs,
 *   "a duplicate second-instance wake for an already-queued request must not
 *   steal its claim out from under it" -- built the way
 *   tools/test/tree-node-command.test.mjs's other whole-consumer tests are,
 *   against the real file-spool functions in shell/tree-node-command.cjs, not
 *   a stub. A request this process already has in hand needs no answer from
 *   here at all: silence is correct, the same way it always was for this one
 *   case, because something else in this same process is already going to
 *   answer it (or, if it already did, the coordinator's read of the existing
 *   result file already has what it needs).
 *
 * So only DISPOSED refuses. The code and the reason mirror dispatchTreeSpawn's
 * own wording: one generic refusal code, and the broker's live state
 * stringified beside it, because a caller deciding whether to ask again is
 * owed what the queue actually saw, not a guess. */
function queueRequestOrRefuse(broker, requestId, refuse) {
  const queued = broker.queueRequest(requestId)
  if (!queued && broker.state().disposed) {
    let state = 'unavailable'
    try { state = JSON.stringify(broker.state()) } catch { /* state() does not throw today; kept defensive like the caller this mirrors */ }
    refuse('MC_TREE_COMMAND_REQUEST_REFUSED', `The tree command queue did not accept this request. The queue was ${state} when it refused.`)
  }
  return queued
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_KNOWN_REQUEST_IDS,
  createTreeNodeCommandBroker,
  failureResult,
  queueRequestOrRefuse,
  treeNodeCommandRefusalSentence,
}
