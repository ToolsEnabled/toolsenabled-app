/* LOOPS — proving the four bounds are real, and that a loop loops and stops.
 *
 * A loop is the one control on this page a person is meant to start and then
 * WALK AWAY from. Everything else here fails in front of someone. That is why
 * this suite spends most of its assertions on the bounds rather than the happy
 * path: an unbounded self-spawning agent loop is a footgun the customer cannot
 * un-fire, and every one of the four bounds is load-bearing.
 *
 *   1. ANTI-DRIFT. The bounds are restated in the renderer because the renderer
 *      cannot import the capability layer. So these tests PARSE the engine's own
 *      source and compare against it — never the copy against itself. A restated
 *      bound that goes stale is invisible: the panel keeps offering a loop the
 *      engine now refuses, or worse, keeps promising a bound the engine no
 *      longer enforces.
 *
 *   2. IT ACTUALLY LOOPS AND ACTUALLY STOPS. A single scheduled run is not a
 *      loop, and a stop that returns "stopped" is not a stop. Both are driven
 *      here through real elapsed intervals on injected timers and asserted by
 *      COUNTING THE DISPATCHES THAT REACHED THE WIRE, not by reading a phase.
 *
 *   3. THE CHILDREN ARE NESTED. This is the bound that makes the engine's
 *      fan-out cap apply at all. If run 2 went out without a parentLaunchId it
 *      would be a depth-0 orphan and the cap would silently not exist — which is
 *      what every dispatch in this product was until 2026-08-11.
 *
 *   4. LOOPING CANNOT WIDEN PERMISSION. The one that would matter most if it
 *      were wrong. A loop is N dispatches; if any could carry a permission-
 *      bearing field, a loop would be a way to obtain capability the installed
 *      tier denies. Asserted two ways: the engine's dispatch contract has no
 *      such field, and the controller adds none.
 *
 * WHAT THIS SUITE CANNOT SEE: whether the panel is rendered or reachable, and
 * whether a real child process is confined. Source and unit tests cannot see
 * reachability, and cannot see a spawned process. Those are proven separately by
 * tools/loop-packaged-proof.mjs (reachability, by clicking) and by the engine
 * suite tests/loop-guided-child-confinement.test.js (the spawned child's argv).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'

import {
  LOOP_BOUNDS,
  LOOP_OVERRUN,
  LOOP_RUN_CAP,
  clampLoopIntervalMs,
  clampLoopIterations,
  planLoop,
  verifiedLoopReceipt,
  createLoopController,
} from '../../src/agent-loops.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { TREE_BOUNDS } from '../../src/fleet-trees.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const engineRoot = canonicalRootForTests({ requireConfigured: true })
// Runtime citations follow the Engine selected for this source or packaged run.
const read = relative => readFileSync(relative.startsWith('capability/')
  ? path.join(engineRoot, relative.slice('capability/'.length))
  : path.join(ROOT, relative), 'utf8')

const ACTIONS = 'capability/src/lib/mission-bridge/actions.js'
const LAUNCH_RECORD = 'capability/src/lib/controller-launch-record.js'
const PRESENCE = 'capability/src/lib/agent-presence.js'
const LANE_DISPATCH = 'capability/src/lib/mission-bridge/agent-lane-dispatch.js'
const SCHEDULED_ACTIONS = 'capability/src/lib/scheduled-actions.js'

// These checks are required even when the selected Engine is not staged here.
const payloadTest = test

/* A dispatch receipt the controller will accept. Built by a helper so that a
   test which needs an INVALID one has to say which field it broke. */
let receiptSequence = 0
const goodReceipt = (tier, launchId) => ({
  action: 'dispatch',
  tier,
  launchId,
  agentId: 'luna',
  auditSequence: (receiptSequence += 1),
  auditEventHash: 'a'.repeat(64),
})

/* An injected timer the test drives by hand. `fire()` runs the pending callback,
   which is how a real elapsed interval is simulated without wall clock.
 *
 * A timer fires AT MOST ONCE, like a real setTimeout. The first version of this
 * helper re-fired the most recent timer every call, so `fire()` returned true
 * forever once a loop had finished — the callback was a no-op by then, so the
 * lie was invisible except as a non-terminating drain. A harness that reports
 * work it did not do can only ever manufacture false passes, so this returns
 * false the moment there is genuinely nothing left to fire. */
function manualTimers() {
  const pending = []
  return {
    setTimer(fn, ms) { pending.push({ fn, ms, fired: false, cleared: false }); return pending.length },
    clearTimer(handle) { if (pending[handle - 1]) pending[handle - 1].cleared = true },
    get depth() { return pending.length },
    lastMs() { return pending.length ? pending[pending.length - 1].ms : null },
    cleared(handle) { return Boolean(pending[handle - 1]?.cleared) },
    async fire() {
      const next = pending[pending.length - 1]
      if (!next || next.cleared || next.fired) return false
      next.fired = true
      await next.fn()
      return true
    },
  }
}

/* Records every action that reached the wire, in order, with its full body. */
function recordingPost(responder) {
  const calls = []
  return {
    calls,
    dispatches: () => calls.filter(call => call.action === 'dispatch'),
    post: async (action, body) => {
      calls.push({ action, body })
      return responder(action, body, calls.length)
    },
  }
}

const runnablePlan = (overrides = {}) => planLoop({ tier: 'luna', iterations: 3, intervalMs: 60_000, ...overrides })

/* ---------------------------------------------------------------
   1 · anti-drift against the engine's own source
   --------------------------------------------------------------- */

payloadTest('the fan-out and depth bounds match the engine constants', () => {
  const source = read(LAUNCH_RECORD)
  const fanOut = /const MAX_FAN_OUT = (\d+);/.exec(source)
  const depth = /const MAX_DEPTH = (\d+);/.exec(source)
  assert.ok(fanOut, 'engine MAX_FAN_OUT not found — this test is checking air')
  assert.ok(depth, 'engine MAX_DEPTH not found — this test is checking air')
  assert.equal(LOOP_BOUNDS.maxFanOut, Number(fanOut[1]), 'MAX_FAN_OUT drifted from the engine')
  assert.equal(LOOP_BOUNDS.maxDepth, Number(depth[1]), 'MAX_DEPTH drifted from the engine')
})

test('a full loop stays strictly inside the cap the engine would refuse at', () => {
  /* The anchor is run 1 and its children are runs 2..N, so the engine sees
     N-1 siblings. Staying under MAX_FAN_OUT keeps LAUNCH_FANOUT_EXCEEDED a
     backstop that never fires in correct operation. */
  assert.ok(LOOP_BOUNDS.maxIterations - 1 < LOOP_BOUNDS.maxFanOut,
    `a full ${LOOP_BOUNDS.maxIterations}-run loop nests ${LOOP_BOUNDS.maxIterations - 1} children, which the engine cap of ${LOOP_BOUNDS.maxFanOut} must not refuse`)
})

test('a loop never takes a tree seat: its runs are engine launches, one live at a time, not tree children', async () => {
  /* The owner, 2026-09-11: "loops and grids dont even need to be tied together
     or to any of this". The tree seats four live children under one parent; a
     loop nests up to seven runs under its first. That is only safe if a loop
     never touches the tree store, so this proves it three ways. */

  // 1. The loop module names no tree store and writes no tree node. Its import
  //    GRAPH does reach src/fleet-trees.js, through shared copy modules
  //    (components.js -> fleet-tree-copy.js), so this reads the module's own
  //    source: what matters is that nothing in it asks the tree for a seat.
  const loops = read('src/agent-loops.js')
  assert.match(loops, /export function createLoopController\(/, 'the loop controller moved — this test is checking air')
  assert.doesNotMatch(loops, /from '\.\/fleet-trees\.js'/, 'the loop module now imports the tree store')
  assert.doesNotMatch(loops, /createFleetTreeStore|treeStore|\.addNode\(|\.setNodeStatus\(|\.attachSession\(/,
    'the loop module now writes tree nodes')

  // 2. The view hands the loop controller no tree store, and its Go handler writes no tree node.
  const view = read('src/views/computers.js')
  const call = view.indexOf('controller = createLoopController({')
  assert.ok(call > 0, 'the view no longer builds a loop controller where this test looks')
  const handlerStart = view.lastIndexOf("goButton.addEventListener('click'", call)
  const handlerEnd = view.indexOf("stopButton.addEventListener('click'", call)
  assert.ok(handlerStart > 0 && handlerEnd > call, 'the loop Go handler was not found — this test is checking air')
  const handler = view.slice(handlerStart, handlerEnd)
  assert.match(handler, /postAction: postBridgeAction/, 'the loop no longer dispatches through the engine bridge')
  assert.doesNotMatch(handler, /treeStore|\.addNode\(|\.setNodeStatus\(|\.attachSession\(/, 'the loop Go handler touches the tree store')

  // 3. A full loop nests more runs under its first than a tree seats, and nothing refuses them.
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_ANCHOR') }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: LOOP_BOUNDS.maxIterations }),
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } },
    postAction: wire.post,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  await controller.start()
  let guard = 0
  while (await timers.fire()) { guard += 1; if (guard > 40) break }
  const bodies = wire.dispatches().map(entry => entry.body)
  assert.equal(bodies.length, LOOP_BOUNDS.maxIterations, 'a full loop did not dispatch every run')
  const nested = bodies.slice(1).filter(body => body.parentLaunchId === 'launch_ANCHOR').length
  assert.equal(nested, LOOP_BOUNDS.maxIterations - 1, 'every run after the first nests under the first')
  assert.ok(nested > TREE_BOUNDS.maxChildren, 'the fixture must nest more runs than a tree seats, or it measures nothing')
  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(state.started, LOOP_BOUNDS.maxIterations)
  /* One live at a time: a run is dispatched only when the timer fires, after
     the previous dispatch has returned; an overlap is the engine's
     BRIDGE_AGENT_LANE_COLLISION and is a SKIP (see the overrun tests above). */
  assert.equal(guard, LOOP_BOUNDS.maxIterations - 1, 'each run after the first waited for its own interval')
})

payloadTest('the engine still enforces the fan-out cap only when a parent is named', () => {
  /* If this ever stops being true the nesting bound becomes decoration, and the
     comment in agent-loops.js explaining why nesting matters becomes false. */
  const source = read(LAUNCH_RECORD)
  const guard = /if \(request\.parentLaunchId\) \{([\s\S]{0,900}?)\n  \}/.exec(source)
  assert.ok(guard, 'the engine parentLaunchId guard was not found — this test is checking air')
  assert.match(guard[1], /siblings >= MAX_FAN_OUT/, 'the fan-out cap is no longer inside the parent guard')
  assert.match(guard[1], /depth > MAX_DEPTH/, 'the depth cap is no longer inside the parent guard')
})

payloadTest('the overrun refusal this loop calls a skip is the code the engine really sends', () => {
  const presence = read(PRESENCE)
  assert.match(presence, /AGENT_PRESENCE_ACTIVE/, 'the presence registry no longer refuses a second live lane')
  const actions = read(ACTIONS)
  const mapping = /if \(code === 'AGENT_PRESENCE_ACTIVE'\) \{([\s\S]{0,400}?)\}/.exec(actions)
  assert.ok(mapping, 'the engine no longer maps AGENT_PRESENCE_ACTIVE — this test is checking air')
  assert.ok(mapping[1].includes(LOOP_OVERRUN.code),
    `the loop treats ${LOOP_OVERRUN.code} as its overrun signal, but the engine maps the collision to something else`)
})

payloadTest('the run cap named in the loop copy really does kill the process tree', () => {
  /* Bound 4. The sentence shipped on this page for weeks while the behaviour was
     a bare child.kill(). Windows now retains a Job Object, which survives a dead
     intermediate process and cannot be redirected by PID reuse. */
  const source = read(LANE_DISPATCH)
  assert.match(source, /require\('\.\.\/windows-job-control\.js'\)/,
    'the Windows lane launcher no longer owns the Job Object helper')
  const killer = /function killLaneTree\(([\s\S]*?)\n\}/.exec(source)
  assert.ok(killer, 'killLaneTree not found — this test is checking air')
  assert.match(killer[1], /child\.terminateJob\(\)/,
    'the cap no longer terminates the retained Windows Job Object')
  assert.match(killer[1], /child\s*&&\s*child\.kill\(\)/,
    'the non-Windows/failure fallback no longer terminates the direct child')
  assert.match(source, /const launch = timers\.spawnInJobImpl \|\| windowsJob\.spawnInJob;/,
    'the Windows launch path no longer selects the retained Job Object helper')
  assert.match(source, /platform === 'win32'\s*\?\s*launch\(/,
    'Windows lanes no longer launch through the retained Job Object helper')
  /* And it must be wired to the cap timer, not merely defined. */
  assert.match(source, /timeoutState\.timedOut = true;\s*\n\s*killTree\(child, timers\);/,
    'the cap timer no longer calls the tree kill')
})

payloadTest('the loop cites addresses a reader can actually follow', () => {
  /* THIS USED TO CHECK A LINE NUMBER, and that is what kept breaking it.
     The citations point into `capability/`, which is GENERATED from the engine
     tree, so any insertion above the cited code moved the line and reddened this
     test at nothing real -- 273 -> 272 -> 273 in one day by the constant's own
     record, then 580 -> 577. src/agent-loops.js now cites a SYMBOL, and this
     locates it.

     The property being guarded is unchanged and is the one that matters: a
     citation a reader cannot follow is worse than none. What changed is that the
     address is now something that survives an edit above it. */
  for (const { label, citation, } of [
    { label: 'overrun', citation: LOOP_OVERRUN.evidence },
    { label: 'run cap', citation: LOOP_RUN_CAP.evidence },
  ]) {
    assert.equal(typeof citation?.file, 'string', `the ${label} citation names no file`)
    assert.equal(typeof citation?.symbol, 'string', `the ${label} citation names no symbol`)
    const source = read(citation.file)
    const at = source.indexOf(citation.symbol)
    assert.ok(at >= 0,
      `the ${label} citation names "${citation.symbol}" in ${citation.file}, and it is not there -- a reader who follows it finds nothing`)
    /* ONCE, not merely present. Two occurrences means the citation does not
       identify a place, and a reader following it has to guess which. */
    assert.equal(source.indexOf(citation.symbol, at + 1), -1,
      `the ${label} citation's symbol "${citation.symbol}" appears more than once in ${citation.file}, so it no longer names one place`)
  }
})

payloadTest('the scheduler saga still cannot spawn an agent, which is why this loop is not built on it', () => {
  /* The design note in agent-loops.js rests on this. If an agent-spawn action is
     ever allowlisted, that note is wrong and the loop should be rebuilt on the
     durable scheduler — so this test is the tripwire for that. */
  const source = read(SCHEDULED_ACTIONS)
  const list = /SUPPORTED_SCHEDULED_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)
  assert.ok(list, 'SUPPORTED_SCHEDULED_ACTIONS not found — this test is checking air')
  // SENTINEL CHANGED 2026-08-23: this was telegram.send, which left
  // SUPPORTED_SCHEDULED_ACTIONS with the Telegram connector. gmail.send is the
  // surviving outward-effect action in that list, so the canary still proves the
  // regex found the real allowlist rather than an empty match.
  assert.match(list[1], /gmail\.send/, 'the allowlist is not the list this test thinks it is')
  assert.equal(/dispatch|agent\.(loop|spawn|start)/.test(list[1]), false,
    'an agent-spawn action is now schedulable — rebuild the loop on the durable scheduler and delete this test')
})

/* ---------------------------------------------------------------
   2 · the plan refuses what it cannot honour
   --------------------------------------------------------------- */

test('a runnable plan names its tier, identity and overrun rule', () => {
  const plan = runnablePlan()
  assert.equal(plan.runnable, true, plan.problems.join(' '))
  assert.equal(plan.tier, 'luna')
  assert.equal(plan.identity, 'luna')
  assert.equal(plan.iterations, 3)
  assert.equal(plan.overrun.behaviour, 'skip')
  assert.deepEqual(plan.problems, [])
})

test('a loop longer than the engine admits is refused, naming the limit in words', () => {
  /* THIS USED TO ASSERT THE CODE, AND THE CODE IS THE ONE THING THAT MUST NOT
   * BE HERE.
   *
   * The message read "...at most 8 runs under one parent (LAUNCH_FANOUT_EXCEEDED),
   * and this loop nests every run under its first", and this test required that
   * bracket to be there. It is a refusal a person is being STOPPED from
   * reaching -- the whole purpose of the sentence is that they never see it --
   * so naming it bought them nothing and cost them a line they cannot read.
   * src/refusal-copy.js has the sentence for that code for the case where the
   * engine really does raise it.
   *
   * What has to be true is unchanged and is what is asserted now: the refusal
   * names the LIMIT, says the rest would be refused, and is a sentence rather
   * than an identifier. The bound is read from LOOP_BOUNDS rather than typed, so
   * a change to the cap cannot leave this test passing on a stale number. */
  const plan = planLoop({ tier: 'luna', iterations: 99 })
  assert.equal(plan.runnable, false)
  assert.equal(plan.problems.length > 0, true, 'a refusal with no reason is not a refusal')
  const said = plan.problems.join(' ')
  assert.match(said, new RegExp(`\\b${LOOP_BOUNDS.maxFanOut}\\b`), 'the refusal does not name the limit it is refusing against')
  assert.match(said, /refused/, 'the refusal does not say what happens to the runs past the limit')
  assert.equal(said.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g), null,
    `a machine code reached a sentence a person reads: ${said}`)
  assert.equal(plan.iterations, LOOP_BOUNDS.maxIterations, 'the clamped value must still be inside the bound')
})

test('a one-run loop is refused as an ordinary dispatch', () => {
  const plan = planLoop({ tier: 'luna', iterations: 1 })
  assert.equal(plan.runnable, false)
  assert.match(plan.problems.join(' '), /ordinary dispatch/)
})

test('an unknown tier is refused and a known one is not', () => {
  /* Positive first: without it, the negative below would pass on a planner that
     refused everything. */
  assert.equal(planLoop({ tier: LAUNCH_TIERS[0].id, iterations: 2 }).runnable, true)
  const plan = planLoop({ tier: 'not-a-tier', iterations: 2 })
  assert.equal(plan.runnable, false)
  assert.match(plan.problems.join(' '), /not one of/)
})

test('absent is not zero for the interval and the run count', () => {
  for (const absent of [null, undefined, '']) {
    assert.equal(clampLoopIntervalMs(absent), LOOP_BOUNDS.defaultIntervalMs, `${String(absent)} must mean "not chosen", not the floor`)
    assert.equal(clampLoopIterations(absent), LOOP_BOUNDS.maxIterations)
  }
  assert.equal(clampLoopIntervalMs(1), LOOP_BOUNDS.minIntervalMs, 'a chosen too-small value clamps to the floor')
  assert.equal(clampLoopIntervalMs(9e99), LOOP_BOUNDS.maxIntervalMs)
  assert.equal(clampLoopIterations(500), LOOP_BOUNDS.maxIterations)
})

test('the plan states the worst case in the units that matter', () => {
  const plan = runnablePlan()
  assert.equal(Number.isSafeInteger(plan.maxRunMs), true)
  assert.ok(plan.maxRunMs > 0, 'a worst case of zero would be a promise the loop cannot keep')
})

/* ---------------------------------------------------------------
   3 · it actually loops, and it actually stops
   --------------------------------------------------------------- */

test('a loop LOOPS: three runs reach the wire across two elapsed intervals', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, `launch_${wire.calls.length}`) }))
  const controller = createLoopController({
    plan: runnablePlan(),
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } },
    postAction: wire.post,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  await controller.start()
  assert.equal(wire.dispatches().length, 1, 'starting a loop must dispatch immediately, not only after one interval')

  assert.equal(await timers.fire(), true, 'the loop must have armed a timer for the second run')
  assert.equal(wire.dispatches().length, 2, 'one elapsed interval must produce a second run — a single run is not a loop')

  assert.equal(await timers.fire(), true)
  assert.equal(wire.dispatches().length, 3, 'the loop must reach its third run')

  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(state.started, 3)
  assert.equal(state.attempts, 3)
  assert.equal(timers.lastMs(), 60_000, 'the loop must wait the configured interval, not a different one')
})

test('a loop STOPS: after stop, an elapsed interval produces no further run', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => (action === 'dispatch'
    ? { ok: true, receipt: goodReceipt(body.tier, 'launch_anchor') }
    : { ok: false, code: 'NOTHING_TO_STOP' }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }),
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } },
    postAction: wire.post,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  await controller.start()
  assert.equal(wire.dispatches().length, 1)
  /* Positive control: the loop is genuinely still going, so the assertion after
     the stop is measuring the stop and not an already-finished loop. */
  assert.equal(controller.getState().phase, 'running')
  assert.equal(controller.getState().stoppable, true, 'a running loop must offer a stop')

  await controller.stop()
  assert.equal(controller.getState().phase, 'stopped')

  const fired = await timers.fire()
  assert.equal(fired, false, 'the pending interval must have been cleared by the stop')
  assert.equal(wire.dispatches().length, 1, 'no run may start after a stop')
})

test('stop is offered exactly while a loop is running and never otherwise', () => {
  const timers = manualTimers()
  const controller = createLoopController({
    plan: runnablePlan(),
    dispatchBody: {},
    postAction: async () => ({ ok: false, code: 'X' }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  assert.equal(controller.getState().stoppable, false, 'an idle loop must not offer a stop')
})

/* ---------------------------------------------------------------
   4 · the children are nested
   --------------------------------------------------------------- */

test('run 1 is the anchor and every later run nests under its launch id', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_ANCHOR') }))
  const controller = createLoopController({
    plan: runnablePlan(),
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } },
    postAction: wire.post,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  await controller.start()
  await timers.fire()
  await timers.fire()

  const bodies = wire.dispatches().map(call => call.body)
  assert.equal(bodies.length, 3)
  /* Positive: runs 2 and 3 carry the anchor. Stated before the negative about
     run 1, so the negative is measuring an omission rather than passing on an
     empty list. */
  assert.equal(bodies[1].parentLaunchId, 'launch_ANCHOR', 'run 2 must nest under run 1 or the engine cap does not apply')
  assert.equal(bodies[2].parentLaunchId, 'launch_ANCHOR', 'run 3 must nest under run 1')
  assert.equal(Object.hasOwn(bodies[0], 'parentLaunchId'), false,
    'run 1 is the anchor and must not name a parent; the engine rejects unknown parents')
})

test('the nested body is otherwise identical to the anchor body', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const dispatchBody = { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } }
  const controller = createLoopController({
    plan: runnablePlan(), dispatchBody, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start()
  await timers.fire()

  const [first, second] = wire.dispatches().map(call => call.body)
  const { parentLaunchId, ...secondRest } = second
  assert.equal(parentLaunchId, 'launch_A')
  assert.deepEqual(secondRest, first,
    'nesting must be the ONLY difference between a loop run and the run before it')
})

/* ---------------------------------------------------------------
   5 · overrun is a skip, and the loop still terminates
   --------------------------------------------------------------- */

test('a collision is reported as a skip, not as a failure', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => (index === 1
    ? { ok: true, receipt: goodReceipt(body.tier, 'launch_A') }
    : { ok: false, code: 'BRIDGE_AGENT_LANE_COLLISION', reason: 'live presence' }))
  const controller = createLoopController({
    plan: runnablePlan(), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })

  await controller.start()
  await timers.fire()

  const state = controller.getState()
  const second = state.runs.find(run => run.index === 2)
  assert.equal(second.phase, 'skipped', 'an overrun must be a skip')
  assert.equal(state.skipped, 1)
  /* Negative, after the positive above: it must not be counted as a refusal, or
     a person would shorten their cap to make the errors stop. */
  assert.equal(second.phase === 'refused', false)
  assert.match(second.detail, /still going/)
})

test('an overrun does not consume the requested run count', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => (index === 2
    ? { ok: false, code: 'BRIDGE_AGENT_LANE_COLLISION', reason: 'live presence' }
    : { ok: true, receipt: goodReceipt(body.tier, `launch_${index}`) }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })

  await controller.start()
  await timers.fire()

  assert.equal(controller.getState().phase, 'running', 'a skipped attempt must leave the loop alive for the missing child')
  assert.equal(controller.getState().started, 1)
  assert.equal(controller.getState().skipped, 1)
  await timers.fire()
  assert.equal(controller.getState().phase, 'running')
  await timers.fire()
  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(state.attempts, 4)
  assert.equal(state.started, 3)
  assert.equal(state.skipped, 1)
  assert.match(state.message, /3 runs started/)
  assert.doesNotMatch(state.message, /finished its runs/)
})

test('a loop with repeated overruns remains stoppable and never dispatches after stop', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => (index === 1
    ? { ok: true, receipt: goodReceipt(body.tier, 'launch_A') }
    : { ok: false, code: 'BRIDGE_AGENT_LANE_COLLISION', reason: 'live presence' }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start()
  await timers.fire()
  assert.equal(controller.getState().phase, 'running')
  await controller.stop()
  const before = wire.dispatches().length
  assert.equal(await timers.fire(), false)
  assert.equal(wire.dispatches().length, before)
})

test('a genuine refusal is reported as a refusal and does not stop the loop', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => (index === 2
    ? { ok: false, code: 'BRIDGE_ROOT_UNKNOWN', reason: 'no such root' }
    : { ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const controller = createLoopController({
    plan: runnablePlan(), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })

  await controller.start()
  await timers.fire()
  assert.equal(controller.getState().runs.find(run => run.index === 2).phase, 'refused')
  assert.match(controller.getState().message, /Runs started: 1 of 3/)
  assert.doesNotMatch(controller.getState().message, /Run 2 of 3 handled/)
  await timers.fire()
  assert.equal(wire.dispatches().length, 3, 'one refused run must not abandon the remaining runs')
})

test('persistent non-collision refusals consume the selected budget without claiming the runs happened', async () => {
  const timers = manualTimers()
  const wire = recordingPost(() => ({ ok: false, code: 'BRIDGE_ROOT_UNKNOWN', reason: 'no such root' }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })

  await controller.start()
  for (let i = 0; i < 3; i += 1) await timers.fire()

  const state = controller.getState()
  assert.equal(state.phase, 'completed', 'persistent refusal must reach the finite automatic bound')
  assert.equal(state.attempts, 3)
  assert.equal(state.started, 0, 'a refusal must never be reported as a started run')
  assert.equal(state.runs.filter(run => run.phase === 'refused').length, state.attempts)
  assert.match(state.message, /3 start requests were refused or could not be confirmed/)
  assert.match(state.message, /The requested 3 runs were not all confirmed as started/)
  assert.match(state.message, /Read the run details before deciding whether to start another loop/)
  assert.match(state.message, new RegExp(`0 runs started, 0 skipped, out of ${state.attempts} attempts`))
  assert.equal(await timers.fire(), false, 'the bounded refusal must not leave another dispatch queued')
})

test('mixed starts and genuine refusals stop at the selected work budget with an honest shortfall', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => (index === 2
    ? { ok: false, code: 'BRIDGE_ROOT_UNKNOWN', reason: 'no such root' }
    : { ok: true, receipt: goodReceipt(body.tier, `launch_${index}`) }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })

  await controller.start()
  await timers.fire()
  await timers.fire()

  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(state.attempts, 3)
  assert.equal(state.started, 2)
  assert.equal(state.skipped, 0)
  assert.match(state.message, /1 start request was refused or could not be confirmed/)
  assert.match(state.message, /The requested 3 runs were not all confirmed as started/)
  assert.match(state.message, /Read the run details before deciding whether to start another loop/)
  assert.equal(await timers.fire(), false)
})

test('a shaped success with an unverifiable receipt is its own code, never a silent success', async () => {
  const timers = manualTimers()
  const wire = recordingPost(() => ({ ok: true, receipt: { action: 'dispatch', tier: 'luna', launchId: '' } }))
  const controller = createLoopController({
    plan: runnablePlan(), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start()
  const first = controller.getState().runs.find(run => run.index === 1)
  assert.equal(first.phase, 'refused')
  /* [B6] THIS ASSERTION USED TO BE `assert.match(first.detail, /BRIDGE_DISPATCH_RECEIPT_INVALID/)`
     -- it required the bare identifier to be in the text a person reads, which
     is the defect B6 was sent to remove. The identifier has not been dropped;
     it moved to the machine field, and the assertion moved with it. The
     REPLACEMENT is stronger than the original: it pins the code exactly rather
     than by substring, AND holds the copy rule the original could not see. */
  assert.equal(first.code, 'BRIDGE_DISPATCH_RECEIPT_INVALID', 'the refusal must still be identifiable')
  assert.doesNotMatch(first.detail, /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/, `a bare identifier reached the run row: ${first.detail}`)
  assert.match(first.detail, /may already be running/i, 'the row must say the lane may be running rather than inviting a retry')
  assert.equal(controller.getState().started, 0, 'an unverifiable receipt must not count as a started run')
})

test('an incomplete loop keeps uncertain starts uncertain in its final message', async () => {
  const timers = manualTimers()
  const wire = recordingPost(() => ({ ok: true, receipt: { action: 'dispatch', tier: 'luna', launchId: '' } }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start(); await timers.fire(); await timers.fire()
  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(state.started, 0)
  assert.equal(wire.dispatches().length, 3)
  assert.match(state.message, /could not be confirmed/)
  assert.doesNotMatch(state.message, /could not start|were not all started/)
  for (const run of state.runs) {
    assert.match(run.detail, /may already be running/i)
    assert.match(run.detail, /has no confirmed start/)
    assert.doesNotMatch(run.detail, /did not start|tries again at its next interval/)
  }
  assert.equal(await timers.fire(), false)
})

test('a shortfall after a busy skip reports every sent attempt without relabeling the budget', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body, index) => index === 2
    ? { ok: false, code: 'BRIDGE_AGENT_LANE_COLLISION', reason: 'previous run still active' }
    : index === 3 ? { ok: false, code: 'BRIDGE_ROOT_UNKNOWN', reason: 'no such root' }
      : { ok: true, receipt: goodReceipt(body.tier, `launch_${index}`) })
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start(); await timers.fire(); await timers.fire(); await timers.fire()
  const state = controller.getState()
  assert.equal(state.phase, 'completed')
  assert.equal(wire.dispatches().length, 4)
  assert.equal(state.started, 2)
  assert.match(state.message, /2 runs started, 1 skipped, out of 4 attempts/)
  assert.doesNotMatch(state.message, /after 3 start requests/)
  assert.equal(await timers.fire(), false)
})

test('verifiedLoopReceipt accepts a good receipt and rejects each broken field', () => {
  const good = goodReceipt('luna', 'launch_A')
  assert.equal(verifiedLoopReceipt({ ok: true, receipt: good }, 'luna'), true)
  assert.equal(verifiedLoopReceipt({ ok: true, receipt: good }, 'terra'), false, 'a receipt for another tier must not verify')
  assert.equal(verifiedLoopReceipt({ ok: false, receipt: good }, 'luna'), false)
  assert.equal(verifiedLoopReceipt({ ok: true, receipt: { ...good, launchId: '' } }, 'luna'), false)
  assert.equal(verifiedLoopReceipt({ ok: true, receipt: { ...good, auditEventHash: 'short' } }, 'luna'), false)
  assert.equal(verifiedLoopReceipt({ ok: true, receipt: { ...good, auditSequence: 0 } }, 'luna'), false)
})

/* ---------------------------------------------------------------
   6 · the stop tells the truth about what it did
   --------------------------------------------------------------- */

test('stop terminates the run in flight with the observed run id and pid', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => (action === 'dispatch'
    ? { ok: true, receipt: goodReceipt(body.tier, 'launch_A') }
    : {
      ok: true,
      receipt: {
        action: 'terminate',
        idempotencyKey: body.idempotencyKey,
        agentId: body.agentId,
        runId: body.expectedRunId,
        pid: body.expectedPid,
        verifiedGone: true,
        terminalStatus: 'failed',
      },
    }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    observeLiveTarget: async () => ({ agentId: 'luna', runId: 'run_7', pid: 4242, status: 'running' }),
    createIdempotencyKey: () => 'key-1',
  })

  await controller.start()
  await controller.stop()

  const terminate = wire.calls.find(call => call.action === 'terminate')
  assert.ok(terminate, 'stop must send a terminate when a run is observed in flight')
  assert.deepEqual(terminate.body, { idempotencyKey: 'key-1', agentId: 'luna', expectedRunId: 'run_7', expectedPid: 4242 })

  const state = controller.getState()
  assert.equal(state.stopReport.terminated, true)
  assert.equal(state.stopReport.scheduleStopped, true)
  assert.match(state.message, /PID 4242 is gone/)
})

test('stop with nothing in flight stops the schedule and does NOT claim a kill', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    observeLiveTarget: async () => null,
  })

  await controller.start()
  await controller.stop()

  const state = controller.getState()
  assert.equal(state.stopReport.scheduleStopped, true, 'the schedule always stops')
  /* Positive above, negative here: it must not say it terminated something. */
  assert.equal(state.stopReport.terminated, false)
  assert.equal(wire.calls.some(call => call.action === 'terminate'), false, 'no terminate may be sent with no target')
  assert.match(state.message, /No run was observed in flight/)
})

test('an unverified terminate is reported as NOT stopped, and still names the remaining bound', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => (action === 'dispatch'
    ? { ok: true, receipt: goodReceipt(body.tier, 'launch_A') }
    : { ok: false, code: 'BRIDGE_TERMINATE_STALE_PID', reason: 'pid moved on' }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    observeLiveTarget: async () => ({ agentId: 'luna', runId: 'run_7', pid: 4242, status: 'running' }),
    createIdempotencyKey: () => 'key-1',
  })

  await controller.start()
  await controller.stop()

  const state = controller.getState()
  assert.equal(state.stopReport.terminated, false, 'an unverified terminate must never read as a stop')
  assert.match(state.message, /NOT confirmed stopped/)
  /* [B6] was `assert.match(state.message, /BRIDGE_TERMINATE_STALE_PID/)`. The
     code is still reported, on stopReport where it belongs; what a person reads
     is the engine's sentence and the remaining bound. */
  assert.equal(state.stopReport.code, 'BRIDGE_TERMINATE_STALE_PID', 'the refusal must still be identifiable')
  assert.doesNotMatch(state.message, /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/, `a bare identifier reached the stop message: ${state.message}`)
  assert.match(state.message, /pid moved on/, 'the engine’s own sentence must survive verbatim')
  /* The schedule still stopped, which is the promise that CAN always be kept. */
  assert.equal(state.stopReport.scheduleStopped, true)
})

test('a terminate is never sent for a target that is not observably running', async () => {
  for (const target of [
    { agentId: 'luna', runId: 'run_7', pid: 4242, status: 'finished' },
    { agentId: 'luna', runId: 'run_7', pid: 0, status: 'running' },
    { agentId: 'luna', runId: '', pid: 4242, status: 'running' },
  ]) {
    const timers = manualTimers()
    const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
    const controller = createLoopController({
      plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      observeLiveTarget: async () => target,
    })
    await controller.start()
    await controller.stop()
    assert.equal(wire.calls.some(call => call.action === 'terminate'), false,
      `a terminate must not be sent for ${JSON.stringify(target)}`)
    assert.equal(controller.getState().stopReport.terminated, false)
  }
})

test('an observation that throws still stops the schedule', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    observeLiveTarget: async () => { throw new Error('projection unreachable') },
  })
  await controller.start()
  await controller.stop()
  assert.equal(controller.getState().phase, 'stopped')
  assert.equal(controller.getState().stopReport.scheduleStopped, true)
})

/* ---------------------------------------------------------------
   7 · looping cannot widen permission
   --------------------------------------------------------------- */

payloadTest('the engine dispatch contract has no permission-bearing field for a loop to set', () => {
  const source = read(ACTIONS)
  const contract = /exact\(input, \[([^\]]*)\], \[([^\]]*)\], 'dispatch'\)/.exec(source)
  assert.ok(contract, 'the engine dispatch contract was not found — this test is checking air')
  const allowed = contract[1].split(',').map(part => part.trim().replace(/'/g, ''))
  assert.ok(allowed.includes('parentLaunchId'), 'nesting is no longer accepted by the engine')
  assert.ok(allowed.includes('tier'), 'the contract is not the one this test thinks it is')
  for (const forbidden of ['permissionSession', 'sandbox', 'profile', 'tierOverride', 'confinement', 'allowedTools']) {
    assert.equal(allowed.includes(forbidden), false,
      `the dispatch contract now accepts "${forbidden}", which a loop could use to widen permission`)
  }
})

test('the controller sends only contract fields, and adds nothing of its own', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const controller = createLoopController({
    plan: runnablePlan(),
    dispatchBody: { rootId: 'r', objectiveRef: 'o', brief: 'b', cap: { kind: 'turns', value: 1, capMs: 60_000 } },
    postAction: wire.post, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start()
  await timers.fire()

  const allowed = new Set(['rootId', 'tier', 'objectiveRef', 'brief', 'cap', 'parentLaunchId'])
  for (const call of wire.dispatches()) {
    for (const key of Object.keys(call.body)) {
      assert.ok(allowed.has(key), `the loop sent "${key}", which is not in the engine dispatch contract`)
    }
  }
  assert.equal(wire.dispatches().length, 2, 'this check must have inspected real dispatches, not an empty list')
})

test('destroy clears the pending interval so a destroyed loop cannot fire again', async () => {
  const timers = manualTimers()
  const wire = recordingPost((action, body) => ({ ok: true, receipt: goodReceipt(body.tier, 'launch_A') }))
  const controller = createLoopController({
    plan: runnablePlan({ iterations: 8 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  })
  await controller.start()
  assert.equal(wire.dispatches().length, 1)
  controller.destroy()
  assert.equal(await timers.fire(), false, 'a destroyed loop must not have a live timer')
  assert.equal(wire.dispatches().length, 1)
})

const basicLoopAudit = target => ({ ok: true, disposition: 'not-required', required: false, recorded: false,
  durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null,
  action: 'controller.agent.launch', target })

test('Basic Loop uses each admitted launch once and keeps malformed audit receipts uncertain', async () => {
  const timers = manualTimers()
  const wire = recordingPost((_action, body) => {
    const launchId = `basic_${wire.calls.length}`
    return { ok: true, receipt: { action: 'dispatch', tier: body.tier, launchId, agentId: 'luna', audit: basicLoopAudit(launchId) } }
  })
  const controller = createLoopController({ plan: runnablePlan({ iterations: 3 }), dispatchBody: {}, postAction: wire.post,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer })
  await controller.start()
  assert.equal(controller.getState().runs[0].phase, 'started')
  await timers.fire()
  assert.equal(wire.calls.length, 2)
  assert.equal(wire.calls[1].body.parentLaunchId, 'basic_1')
  controller.destroy()
  await timers.fire()
  assert.equal(wire.calls.length, 2)
  const receipt = { action: 'dispatch', tier: 'luna', launchId: 'basic_1', agentId: 'luna', audit: basicLoopAudit('basic_1') }
  assert.equal(Boolean(verifiedLoopReceipt({ ok: true, receipt: { ...receipt, audit: { ...receipt.audit, target: 'wrong' } } }, 'luna')), false)
  assert.equal(Boolean(verifiedLoopReceipt({ ok: true, receipt: { ...receipt, agentId: '' } }, 'luna')), false)
  assert.equal(Boolean(verifiedLoopReceipt({ ok: true }, 'luna')), false)
})
