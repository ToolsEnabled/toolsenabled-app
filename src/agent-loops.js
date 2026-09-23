/* LOOPS — running one agent repeatedly, and the four bounds that make that safe.
 *
 * The owner asked for "loop and graph engineering". A loop is not a new engine
 * concept any more than a team was: it is the SAME `dispatch` action, sent again
 * on an interval, with every run after the first nested under the first. Nothing
 * here schedules anything the engine does not already understand, and nothing
 * here spawns a process by a route that page 2's single-lane button does not
 * already use.
 *
 * WHY THIS IS NOT BUILT ON THE WINDOWS TASK SCHEDULER SAGA.
 *
 * The obvious design — and the one recorded by the previous lane — was to
 * allowlist an agent-spawn action in SUPPORTED_SCHEDULED_ACTIONS
 * (capability/src/lib/scheduled-actions.js:3) and let the existing durable
 * scheduler drive it. That design does not work, and the reason is worth
 * recording so it is not re-derived a third time:
 *
 *   The scheduler fires TOOL-REGISTRY TOOL CALLS. `job-runner.js:69` binds
 *   `executeTool` and `job-runner.js:111` invokes the action as a tool, in a
 *   DETACHED process started by Windows Task Scheduler. It has no route to
 *   `startAgentLane` (capability/src/lib/mission-bridge/agent-lane-dispatch.js:388),
 *   which is where the run cap's process-tree kill, the fan-out cap, and the
 *   permission-tier confinement of the spawned child all actually live. Grep of
 *   capability/src/lib/providers/scheduler.js for the bridge returns nothing.
 *
 * So adding the allowlist entry would have produced a scheduled action that
 * spawns no agent — a control that looks real and does nothing, which is the
 * exact class of thing seven controls were removed from this page for being.
 *
 * The cost of that decision, stated plainly because the panel must not imply
 * otherwise: THIS LOOP RUNS WHILE THE WINDOW IS OPEN. It is not durable across
 * a restart. Durable unattended looping is a separate feature that needs the
 * scheduler to reach the bridge, and it is not built.
 *
 * THE FOUR BOUNDS.
 *
 * 1. THE SELECTED ATTEMPT BUDGET IS FINITE, AND A COLLISION SKIP DOES NOT
 *    CONSUME IT.
 *    `maxIterations` is 8, matching MAX_FAN_OUT at
 *    capability/src/lib/controller-launch-record.js:50. Run 1 is the anchor and
 *    runs 2..8 are its at-most-7 children, so a correct loop stays strictly
 *    inside the engine's cap and the engine's cap is a true backstop rather than
 *    the thing that stops the loop. Successful starts satisfy the selected run
 *    bound; a genuine refusal consumes one selected attempt and is reported
 *    honestly if that budget ends before the requested starts occur.
 *
 * 2. THE CHILDREN ARE NESTED, SO THE ENGINE'S CAP APPLIES AT ALL.
 *    MAX_FAN_OUT/MAX_DEPTH are enforced at controller-launch-record.js:781-787
 *    but ONLY when a launch names a `parentLaunchId`. Until the teams work, no
 *    UI had ever sent one, so every dispatch this product made was a depth-0
 *    orphan and the cap had never once applied. A loop that did not nest would
 *    re-create exactly that: an unbounded orphan every interval, forever.
 *
 *    Note the engine's own caveat at controller-launch-record.js:700-705 — the
 *    sibling count is a best-effort scan of the last 200 audit events and can
 *    UNDERCOUNT a parent whose children have scrolled out of the window. That is
 *    precisely why the attempt counter above is the primary bound and the engine
 *    cap is the backstop, and not the other way around.
 *
 * 3. OVERRUN IS DEFINED, AND IT IS SKIP — ENFORCED BY THE ENGINE, NOT BY A TIMER
 *    HERE. Every run of a loop uses the same tier, which resolves to one
 *    declared identity (TIER_AGENT_IDENTITY in ./agent-teams.js). The presence
 *    registry refuses a second live lane for an identity that already has one:
 *    AGENT_PRESENCE_ACTIVE at capability/src/lib/agent-presence.js:575, surfaced
 *    as BRIDGE_AGENT_LANE_COLLISION at
 *    capability/src/lib/mission-bridge/actions.js:472. So if run N is still
 *    going when run N+1 comes due, run N+1 is refused and the loop reports it as
 *    a SKIP. This is the same overrun rule the durable scheduler uses
 *    (SCHEDULER_RUN_OVERLAP), arrived at through the mechanism that was already
 *    there rather than a second one that could disagree with it.
 *
 * 4. EVERY RUN IS BOUNDED EVEN IF NOBODY IS WATCHING.
 *    Each run carries `cap.capMs`, and the cap now kills the lane's PROCESS TREE
 *    (`taskkill /PID <pid> /T /F`) at agent-lane-dispatch.js:275-306. Before
 *    2026-08-11 it was a bare `child.kill()` against the direct child, which
 *    orphaned everything the agent's CLI had started while the record said the
 *    lane had stopped. For a single dispatch that was a leak; for a loop it
 *    would have been a fork bomb, because the next run is admitted as soon as
 *    the previous one goes terminal.
 *
 * STOPPING. `stop()` always does the thing it can always do — no further run is
 * attempted, which is local state and cannot fail. It then tries to terminate
 * the run already in flight, which needs a live runId and PID from the agents
 * projection and therefore CAN fail. The two outcomes are reported separately
 * and neither is described in the other's words, because "stopped" meaning "no
 * more will start" and "stopped" meaning "the one running is dead" are different
 * promises and a person walking away is relying on whichever one they were told.
 *
 * tools/test/agent-loops.test.mjs parses the engine's own source for bounds 1-4
 * and fails if this file drifts from it.
 */

import { LAUNCH_TIERS, CAP_BOUNDS } from './orchestration-controls.js'
import { TIER_AGENT_IDENTITY } from './agent-teams.js'
import { validOperationAuditReceipt } from './mission-bridge.js'
/* [B6] A refused run used to be reported as `${code}: ${reason}`. The code now
   travels on the run record and the row reads as a sentence. */
import { refusalSentence } from './refusal-copy.js'
import {
  WRITE_OUTCOME_KEYS,
  clearUndeliveredWrite,
  recordUndeliveredWrite,
  restatedMessage,
  undeliveredWrite,
} from './write-outcomes.js'

/* Mirrors capability/src/lib/controller-launch-record.js:50-51.
   `maxIterations` is deliberately EQUAL to maxFanOut rather than maxFanOut + 1
   (which the anchor-plus-children arithmetic would permit): staying one under
   the engine's refusal keeps that refusal a backstop that never fires in
   correct operation, so if it ever does fire it means this file is wrong. */
export const LOOP_BOUNDS = Object.freeze({
  maxIterations: 8,
  maxFanOut: 8,
  maxDepth: 3,
  minIntervalMs: 60_000,
  maxIntervalMs: 4 * 60 * 60_000,
  defaultIntervalMs: 20 * 60_000,
})

/** What happens when a run is still going as the next one comes due. */
export const LOOP_OVERRUN = Object.freeze({
  behaviour: 'skip',
  code: 'BRIDGE_AGENT_LANE_COLLISION',
  sentence: 'If a run is still going when the next one is due, the next one is skipped, not queued and not run alongside. The engine refuses it: one declared identity may only have one live lane.',
  evidence: Object.freeze({ file: 'capability/src/lib/agent-presence.js', symbol: 'AGENT_PRESENCE_ACTIVE' }),
})

/** The run cap, restated here only to name the bound and its address.
 *
 * CITED BY SYMBOL, NOT BY LINE, and the note this replaces explains why.
 *
 * These addresses point into `capability/`, which is GENERATED by
 * `npm run pack:capability` from the engine tree, so a line number moves
 * whenever anything is inserted above the thing it names. The previous note
 * recorded it drifting twice in one day -- 273 -> 272 -> 273 -- each time
 * turning the build red at the citation test rather than at anything real. It
 * drifted again (580 -> 577) and reddened the suite again.
 *
 * That note also named the proper fix and queued it as too disruptive to do
 * mid-build: "cite the SYMBOL and have the test locate it -- an address that
 * survives an insertion above it -- which changes this constant's shape and the
 * test together." That is what is done here. The test now finds the symbol and
 * fails if it is ABSENT, which is the property worth guarding: a citation a
 * reader cannot follow is worse than none, and a line number is not a citation,
 * it is a guess about a file's current shape.
 *
 * `evidence` is developer provenance and is not rendered anywhere -- the only
 * `.evidence` a person reads belongs to UNSUPPORTED_CONTROLS in
 * views/computers.js -- so changing its shape moves no copy. */
export const LOOP_RUN_CAP = Object.freeze({
  sentence: "Each run stops at its own cap, and the cap kills that run's whole process tree.",
  evidence: Object.freeze({ file: 'capability/src/lib/mission-bridge/agent-lane-dispatch.js', symbol: 'function killLaneTree(' }),
})

/* Same absent-is-not-zero rule as clampCapMs in ./orchestration-controls.js:113.
   `Number(null)` and `Number('')` are both 0, which is finite, so clamping
   straight to the bounds would turn "nothing chosen" into "the shortest
   interval this product allows" — a one-minute loop nobody asked for. */
export function clampLoopIntervalMs(value) {
  if (value === null || value === undefined || value === '') return LOOP_BOUNDS.defaultIntervalMs
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return LOOP_BOUNDS.defaultIntervalMs
  return Math.min(LOOP_BOUNDS.maxIntervalMs, Math.max(LOOP_BOUNDS.minIntervalMs, Math.round(parsed)))
}

/** Same rule for the iteration count. */
export function clampLoopIterations(value) {
  if (value === null || value === undefined || value === '') return LOOP_BOUNDS.maxIterations
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return LOOP_BOUNDS.maxIterations
  return Math.min(LOOP_BOUNDS.maxIterations, Math.max(2, Math.round(parsed)))
}

const TIER_IDS = new Set(LAUNCH_TIERS.map(tier => tier.id))

/**
 * Validate a proposed loop and say exactly why it is or is not runnable.
 *
 * Returns the problems rather than a boolean for the same reason planTeam does:
 * a person who cannot start a loop deserves to be told which rule stopped them.
 */
export function planLoop({ tier = null, iterations = LOOP_BOUNDS.maxIterations, intervalMs = LOOP_BOUNDS.defaultIntervalMs } = {}) {
  const problems = []

  if (!tier) problems.push('A loop needs an agent tier to run.')
  else if (!TIER_IDS.has(tier)) problems.push(`"${tier}" is not one of the ${LAUNCH_TIERS.length} dispatchable tiers.`)

  const runs = clampLoopIterations(iterations)
  const every = clampLoopIntervalMs(intervalMs)

  if (Number(iterations) > LOOP_BOUNDS.maxIterations) {
    /* THE CODE CAME OUT OF THE SENTENCE. It read "(LAUNCH_FANOUT_EXCEEDED)",
       which is the refusal a person would get if they went ahead -- and this
       message exists precisely so they do not, so naming the code buys them
       nothing and costs them a line they cannot read. src/refusal-copy.js has
       the sentence for that code when it really is raised. */
    problems.push(`A loop runs at most ${LOOP_BOUNDS.maxIterations} times. This one nests every run under its first, and at most ${LOOP_BOUNDS.maxFanOut} can run under one parent before the rest are refused.`)
  }
  if (Number(iterations) === 1) {
    problems.push('A loop that runs once is an ordinary dispatch. Use the single-lane control instead.')
  }

  return Object.freeze({
    tier,
    identity: tier ? (TIER_AGENT_IDENTITY[tier] || null) : null,
    iterations: runs,
    intervalMs: every,
    /* The worst case a person is agreeing to, computed rather than asserted:
       every run taking its full cap, back to back. Stated because "8 runs every
       20 minutes" sounds bounded and "up to 2 hours 40 of agent time" is the
       same sentence in the units that matter. */
    maxRunMs: runs * CAP_BOUNDS.maxMs,
    overrun: LOOP_OVERRUN,
    runCap: LOOP_RUN_CAP,
    runnable: problems.length === 0,
    problems: Object.freeze(problems),
  })
}

/** The receipt shape a dispatch must return before a run may be called started. */
export function verifiedLoopReceipt(result, expectedTier) {
  const receipt = result?.receipt
  return result?.ok === true
    && receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && receipt.action === 'dispatch'
    && receipt.tier === expectedTier
    && typeof receipt.launchId === 'string' && receipt.launchId.length > 0
    && typeof receipt.agentId === 'string' && receipt.agentId.length > 0
    && validOperationAuditReceipt(receipt, 'controller.agent.launch', receipt.launchId)
}

/* `code` is the identifier a support conversation needs and a reader does not.
   It defaults to null, never '', so "there is no code" cannot be mistaken for
   "the code is blank" by anything that tests truthiness on it. */
function runState(index, phase, detail, receipt = null, code = null) {
  return Object.freeze({ index, phase, detail, receipt, code })
}

/**
 * DOM-independent loop driver, modelled on createTeamController.
 *
 * Timers are injected so the packaged probe can drive real elapsed intervals
 * without waiting minutes of wall clock, and so a test can prove the loop
 * ACTUALLY LOOPED rather than that it would have.
 *
 * `observeLiveTarget` is an async function returning the live control target
 * ({ agentId, runId, pid, status }) for this loop's identity, or null. It is
 * injected rather than imported so that stop() has no hard dependency on the
 * agents projection being reachable — a stop that cannot observe still stops the
 * schedule, and says so.
 */
export function createLoopController({
  plan,
  dispatchBody,
  postAction,
  onState = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  observeLiveTarget = async () => null,
  createIdempotencyKey = () => globalThis.crypto?.randomUUID?.(),
} = {}) {
  let destroyed = false
  let timerHandle = null
  let anchorLaunchId = null
  let attempts = 0
  let workAttempts = 0
  const missedStop = undeliveredWrite(WRITE_OUTCOME_KEYS.LOOP_STOP)

  let state = Object.freeze({
    phase: plan?.runnable ? 'idle' : 'unavailable',
    enabled: Boolean(plan?.runnable),
    /* `stoppable` is separate from `enabled` because the stop control must be
       live exactly when a loop is, and dead when one is not — the panel binds
       the button to this and nothing else. */
    stoppable: false,
    attempts: 0,
    started: 0,
    skipped: 0,
    anchorLaunchId: null,
    runs: Object.freeze([]),
    stopReport: null,
    /* A STOP THIS PANEL ALREADY SENT AND NEVER GOT TO REPORT. `stop()` sends a
       terminate against a real PID; its receipt is the only thing that separates
       "the run is gone, with its process tree" from "it was NOT confirmed
       stopped". Both used to vanish together when the view was retired mid-call,
       and vanishing reads as the reassuring one. Filed in ./write-outcomes.js
       before the destroyed check, restated here on the next mount. */
    message: missedStop
      ? restatedMessage(missedStop)
      : (plan?.runnable
        ? `Run ${plan.tier} ${plan.iterations} times, every ${Math.round(plan.intervalMs / 60_000)} minutes. ${plan.overrun.sentence}`
        : (plan?.problems || ['No loop is configured.']).join(' ')),
  })

  const publish = next => {
    state = next
    if (!destroyed) onState(state)
  }
  publish(state)

  const patch = fields => publish(Object.freeze({ ...state, ...fields }))

  /* Every settled branch of a stop that ACTUALLY SENT A TERMINATE goes through
     here. It always updates this controller's state, paints only when a panel is
     listening, and when there is none it files the sentence where the next mount
     of this panel will restate it. The branches that send nothing (no run in
     flight, no idempotency key) do not come through here: nothing happened, so
     there is no outcome to carry. */
  const settleStop = (stopReport, tone, message) => {
    patch({ phase: 'stopped', enabled: true, stoppable: false, stopReport, message })
    if (destroyed) recordUndeliveredWrite(WRITE_OUTCOME_KEYS.LOOP_STOP, { tone, message })
    else clearUndeliveredWrite(WRITE_OUTCOME_KEYS.LOOP_STOP)
    return state
  }

  const appendRun = next => Object.freeze([...state.runs, next])
  const replaceRun = (index, next) => Object.freeze(
    state.runs.map(run => (run.index === index ? next : run)),
  )

  async function send(index, parentLaunchId) {
    let result
    try {
      result = await postAction('dispatch', {
        ...dispatchBody,
        tier: plan.tier,
        ...(parentLaunchId ? { parentLaunchId } : {}),
      })
    } catch (error) {
      result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'dispatch request failed' }
    }
    if (verifiedLoopReceipt(result, plan.tier)) return { ok: true, receipt: result.receipt }

    /* The overrun case is not a failure and must never be reported as one: the
       loop is working exactly as designed, and the previous run is still doing
       the work. Folding it into "refused" would teach a person to shorten their
       cap to make the errors stop, which is the opposite of correct. */
    if (result?.code === LOOP_OVERRUN.code) {
      return { ok: false, skipped: true, code: LOOP_OVERRUN.code, reason: 'The previous run was still going, so this one was skipped.' }
    }

    const shapedSuccess = result?.ok === true
    return {
      ok: false,
      skipped: false,
      code: shapedSuccess ? 'BRIDGE_DISPATCH_RECEIPT_INVALID' : (result?.code || 'BRIDGE_REQUEST_FAILED'),
      /* [B6] This used to carry its own remedy ("check the fleet before
         starting the loop again"), because nothing downstream supplied one.
         The table now does, in stronger words, and leaving both in printed the
         same instruction twice in one line. This is the DIAGNOSIS only. */
      reason: shapedSuccess
        ? 'The dispatch response was incomplete or named a different tier.'
        : (result?.reason || 'The dispatch was refused with no receipt.'),
    }
  }

  function finish(reason) {
    patch({
      phase: 'completed',
      enabled: true,
      stoppable: false,
      message: `${reason} ${state.started} run${state.started === 1 ? '' : 's'} started, ${state.skipped} skipped, out of ${state.attempts} attempt${state.attempts === 1 ? '' : 's'}. Nothing further will start.`,
    })
  }

  function finishIncomplete() {
    const refused = state.runs.filter(run => run.phase === 'refused').length
    finish(`The loop stopped. ${refused} start request${refused === 1 ? ' was' : 's were'} refused or could not be confirmed. Read the run details before deciding whether to start another loop. The requested ${plan.iterations} runs were not all confirmed as started.`)
  }

  async function attempt() {
    if (destroyed || state.phase !== 'running') return
    attempts += 1
    const index = attempts
    patch({ attempts, runs: appendRun(runState(index, 'pending', 'Dispatching.')) })

    const result = await send(index, anchorLaunchId)
    if (destroyed || state.phase !== 'running') return
    if (!result.skipped) workAttempts += 1

    if (result.ok) {
      if (anchorLaunchId === null) anchorLaunchId = result.receipt.launchId
      patch({
        started: state.started + 1,
        anchorLaunchId,
        runs: replaceRun(index, runState(index, 'started',
          index === 1
            ? `Run 1 running as launch ${result.receipt.launchId}. Every later run nests under it.`
            : `Run ${index} running as launch ${result.receipt.launchId}, nested under ${anchorLaunchId}.`,
          result.receipt)),
      })
    } else if (result.skipped) {
      patch({
        skipped: state.skipped + 1,
        runs: replaceRun(index, runState(index, 'skipped', result.reason)),
      })
    } else {
      patch({
        runs: replaceRun(index, runState(index, 'refused',
          /* The table's remedy is NOT overridden here, and that is deliberate:
             for BRIDGE_DISPATCH_RECEIPT_INVALID it says "this may already be
             running, do not start another", which is the one instruction a
             loop must not overwrite. The loop's own fact is added AFTER it, as
             a fact rather than a second instruction -- a reader who has just
             been told not to start another needs to know that this panel will,
             on its own, at the next interval. */
          `${refusalSentence(result, { fallback: 'The dispatch was refused with no receipt.' })} Run ${index} has no confirmed start. Runs already started are unaffected. The loop may try again at its next interval; press Stop to end the schedule.`,
          null, result.code || null)),
      })
    }

    /* The requested bound is successful child runs, not scheduler attempts.
       A collision is an explicit skip: consuming an iteration here could make
       a three-run loop finish after one child and two skipped dispatches. Keep
       the schedule alive until the requested number of children starts; Stop
       still clears the pending timer and prevents a late dispatch. */
    if (state.started >= plan.iterations) {
      finish('The loop reached its selected started-run count.')
      return
    }
    if (workAttempts >= plan.iterations) {
      finishIncomplete()
      return
    }
    patch({ message: `Runs started: ${state.started} of ${plan.iterations}. The latest dispatch was handled; next in ${Math.round(plan.intervalMs / 60_000)} minutes. Stop is available now.` })
    timerHandle = setTimer(() => { void attempt() }, plan.intervalMs)
  }

  return Object.freeze({
    getState() { return state },
    destroy() {
      destroyed = true
      if (timerHandle !== null) clearTimer(timerHandle)
      timerHandle = null
    },

    start() {
      if (destroyed || !state.enabled || state.phase === 'running') return Promise.resolve(state)
      attempts = 0
      workAttempts = 0
      anchorLaunchId = null
      patch({
        phase: 'running',
        enabled: false,
        stoppable: true,
        attempts: 0,
        started: 0,
        skipped: 0,
        anchorLaunchId: null,
        runs: Object.freeze([]),
        stopReport: null,
        message: `Loop running. Up to ${plan.iterations} runs of ${plan.tier}, every ${Math.round(plan.intervalMs / 60_000)} minutes. Stop is available now.`,
      })
      return attempt().then(() => state)
    },

    /**
     * Stop the loop. The schedule always stops. The run already in flight is
     * terminated if it can be observed, and if it cannot, that is said rather
     * than implied away.
     */
    async stop() {
      if (destroyed) return state
      if (timerHandle !== null) clearTimer(timerHandle)
      timerHandle = null

      const scheduleStopped = 'No further run will start.'
      patch({ phase: 'stopping', stoppable: false, message: `${scheduleStopped} Looking for a run still in flight.` })

      let target = null
      try { target = await observeLiveTarget(plan.identity) } catch { target = null }
      if (destroyed) return state

      const usable = target
        && typeof target.runId === 'string' && target.runId.length > 0
        && typeof target.agentId === 'string' && target.agentId.length > 0
        && Number.isSafeInteger(target.pid) && target.pid > 0
        && target.status === 'running'

      if (!usable) {
        /* Not a failure: most stops land between runs, when there is correctly
           nothing to kill. The cap sentence is repeated because it is the only
           bound left on anything that IS still going. */
        patch({
          phase: 'stopped',
          enabled: true,
          stoppable: false,
          stopReport: Object.freeze({ scheduleStopped: true, terminated: false, code: null }),
          message: `${scheduleStopped} No run was observed in flight to terminate. ${LOOP_RUN_CAP.sentence}`,
        })
        return state
      }

      let idempotencyKey = null
      try { idempotencyKey = createIdempotencyKey() } catch { idempotencyKey = null }
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        patch({
          phase: 'stopped',
          enabled: true,
          stoppable: false,
          stopReport: Object.freeze({ scheduleStopped: true, terminated: false, code: 'BRIDGE_IDEMPOTENCY_UNAVAILABLE' }),
          message: `${scheduleStopped} Run ${target.runId} could not be terminated: no idempotency key could be created, so no terminate was sent. ${LOOP_RUN_CAP.sentence}`,
        })
        return state
      }

      const body = Object.freeze({
        idempotencyKey,
        agentId: target.agentId,
        expectedRunId: target.runId,
        expectedPid: target.pid,
      })

      let result
      try { result = await postAction('terminate', body) }
      catch (error) { result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'terminate request failed' } }
      /* NO `if (destroyed) return` ABOVE THIS LINE. A terminate has been sent at
         a real PID. Whether this panel still exists decides where the answer is
         written, never whether there is an answer. */

      const receipt = result?.receipt
      const verified = result?.ok === true
        && receipt && typeof receipt === 'object'
        && receipt.action === 'terminate'
        && receipt.idempotencyKey === body.idempotencyKey
        && receipt.agentId === body.agentId
        && receipt.runId === body.expectedRunId
        && receipt.pid === body.expectedPid
        && receipt.verifiedGone === true

      if (verified) {
        return settleStop(
          Object.freeze({ scheduleStopped: true, terminated: true, code: null, pid: receipt.pid, runId: receipt.runId }),
          'confirmed',
          `${scheduleStopped} Run ${receipt.runId} is ${receipt.terminalStatus} and PID ${receipt.pid} is gone, with its process tree.`,
        )
      }

      const code = result?.ok === true ? 'BRIDGE_TERMINATE_RECEIPT_INVALID' : (result?.code || 'BRIDGE_REQUEST_FAILED')
      return settleStop(
        Object.freeze({ scheduleStopped: true, terminated: false, code }),
        'refused',
        /* [B6] `(${code})` used to sit in the middle of this sentence. The cap
           sentence is passed as the REMEDY rather than appended, because it is
           the answer to "so what do I do" here: a run this panel could not
           confirm stopped is still bounded by something that will stop it. */
        `${scheduleStopped} Run ${target.runId} was NOT confirmed stopped. ${refusalSentence({ code, reason: result?.reason }, {
          fallback: 'The stop request came back without a receipt this panel could verify.',
          remedy: `Look at the fleet page to see whether it is still running before pressing stop again. It is bounded either way: ${LOOP_RUN_CAP.sentence}`,
        })}`,
      )
    },
  })
}
