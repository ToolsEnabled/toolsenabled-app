import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { actionMotion, createBlobParts, updateBlobParts, updateBaseCharacter, createActionRest, updateActionRest } from '../../src/home-circle-motion.js'
import { followedRow, actionForLive, actionLabel, sampleAction } from '../../src/home-circle-action.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { mountHomeCircleFluid } from '../../src/home-circle-fluid.js'

const fluid = readFileSync(new URL('../../src/home-circle-fluid.js', import.meta.url), 'utf8')
const home = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const methods = ['smooth', 'noise', 'neutral', 'pushX', 'ringPulse', 'turn', 'turnDrive', 'split', 'splitDrive', 'burst', 'arcPoint', 'originalFluid', 'squashDrive', 'agentDrive', 'direct', 'formReach', 'bodyReach', 'bodyShape', 'gather', 'seatDrive', 'updateSeatReadings', 'stormDrive', 'materialDrive', 'blowupAllowed', 'startEpisode', 'blowup', 'dropExtras', 'stepDrops'].map(name => declaredFunctionSource(fluid, name)).join('\n')
const forms = readFileSync(new URL('../../src/home-circle-forms.js', import.meta.url), 'utf8')

/* GLSL read as arithmetic. Only the calls actually used by the statements this
   file evaluates are implemented; anything else REFUSES BY NAME, because a
   silent skip here would report a ban as checked while checking nothing. */
const GLSL_CALLS = {
  exp: Math.exp, sqrt: Math.sqrt, log: Math.log, pow: Math.pow, abs: Math.abs,
  min: Math.min, max: Math.max,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
  mix: (a, b, t) => a + (b - a) * t,
  smoothstep: (e0, e1, v) => { const t = Math.min(Math.max((v - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t) },
}

function glslScalar (expression, names) {
  // vec components are read as their own names: uGloss.x arrives as uGloss_x,
  // so a swizzle cannot be mistaken for an identifier this test was not given.
  expression = expression.replace(/\b([A-Za-z_]\w*)\.([xyzw]+)\b/g, '$1_$2')
  const unknown = [...new Set(expression.match(/[A-Za-z_]\w*/g) || [])]
    .filter(id => !names.includes(id) && !(id in GLSL_CALLS))
  assert.deepEqual(unknown, [],
    `this test evaluates "${expression.trim()}" as arithmetic and was not given ${unknown.join(', ')}`)
  // eslint-disable-next-line no-new-func
  const body = new Function(...names, ...Object.keys(GLSL_CALLS), `return (${expression})`)
  return (...args) => {
    /* Arity is checked rather than trusted, because the failure it prevents is
       silent and looks like something else entirely: the GLSL calls are passed
       as trailing parameters, so a caller one argument short shifts every one
       of them into the wrong slot and the expression fails with "mix is not a
       function" -- a message about the helper, pointing nowhere near the call
       that was wrong. It cost a debugging round here. */
    assert.equal(args.length, names.length,
      `this evaluator was declared over ${names.join(', ')} and was called with ${args.length} value(s)`)
    return body(...args, ...Object.values(GLSL_CALLS))
  }
}

/* TUNE is read out of the renderer rather than restated, the same way mount()
   reads it, so a constant this test asserts about cannot drift away from the
   one the product ships. */
function readTune () {
  const at = fluid.indexOf('  var TUNE = {')
  assert.ok(at >= 0, 'home-circle-fluid.js declares TUNE')
  const source = fluid.slice(at, fluid.indexOf(`
  };`, at) + 5)
  const c = vm.createContext({})
  vm.runInContext(source + ' var out = TUNE;', c)
  return c.out
}

function mount(action, extrasOn) {
  let seed = 12345
  const math = Object.create(Math)
  math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32)
  const c = vm.createContext({
    actionMotion, createBlobParts, updateBlobParts, updateBaseCharacter, updateActionRest: (...args) => updateActionRest(...args, math.random), Math: math, seed: 9, clock: 0, WALL: .36, TOP: .32, extrasOn, extras: { personality: true, blowup: false }, episode: null,
    ring: { dataset: { agentAction: action, agentName: 'Agent', agentEvent: '0' } },
    agent: { action: '', since: -9, name: '', event: '', kick: -9, kicks: 0, motion: null, previous: null, formTime: 0, character: new Float32Array([0, 0, 1, 0]), parts: createBlobParts(), rest: createActionRest(math.random) },
    seat: { x: .5, y: .7, vx: .08, vy: .02, speed: .08, tx: 1, ty: 0, moving: 0, face: .2, heading: .2, steerAt: 0, pace: .05, goal: null },
    persona: {}, voice: { state: 'idle', handback: -99 }, palette: {}, storm: { level: 0 }, material: { mass: 1 }, drive: {},
    visual: { setAttribute() {} }, T: {}, dead: false, played: 0, sinceEpisode: 0, nextEpisode: 60, level: 4, LADDER: [{}, {}, {}, {}, { sim: 64 }],
    voiceOff() {}, hideVoice() {}, personalityCalls: 0,
    /* The character pieces (stepDrops, called from updateSeatReadings): three
       droplet slots and their upload buffer, exactly as the renderer declares them. */
    drops: [0, 1, 2].map(() => ({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, size: 0 })), dropData: new Float32Array(12), dropAt: 0, dropsShed: 0,
    personality() { assert.equal(c.agent.displayAction, 'idle'); c.personalityCalls++ },
  })
  const config = ['TUNE', 'BLOWUP', 'MATERIAL', 'drive'].map(name => {
    const at = fluid.indexOf('  var ' + name + ' = {')
    assert.ok(at >= 0)
    return fluid.slice(at, fluid.indexOf('\n  };', at) + 5)
  }).join('\n')
  /* RIM is read out of the renderer rather than restated here, so the rim
     tests cannot drift away from the contact radius the product actually
     uses. Restating it is what let the old gap assert itself as correct. */
  const rimLine = fluid.match(/^ {2}var RIM = .+$/m)
  assert.ok(rimLine, 'home-circle-fluid.js declares RIM')
  vm.runInContext(config + '\n' + rimLine[0] + '\n' + methods, c)
  return { c, step(dt = 1 / 30) { c.clock += dt; c.direct(dt); c.stormDrive(dt); c.materialDrive(dt); c.seatDrive(dt) } }
}

/* T259 ITEM (2): NO ACTION MOVES THE BODY ABOUT, IT ONLY CHANGES ITS SHAPE.
   The owner's standing dislike, in their words: "dont animate it just by
   moving it around make it transform". It is a STANDING property, not a
   one-off edit -- the recovered original walked seat.goal round a small circle
   and had to be left out on purpose -- so it is asserted here for EVERY action
   state rather than for the one that happened to reintroduce it.
   `thinking draws the body in on a slow beat and never walks it around` pins
   this for thinking alone; this is the same claim over the whole set. */
test('no action state steers the body: every action changes its shape, not where it is', () => {
  const ACTIONS = ['idle', 'thinking', 'reading', 'writing', 'running', 'waiting']
  const paths = {}
  for (const action of ACTIONS) {
    const f = mount(action, true)
    const path = []
    for (let step = 0; step < 300; step++) {
      f.step()
      assert.equal(f.c.seat.goal, null, `${action} must not steer the body to a goal (step ${step})`)
      path.push([f.c.seat.x, f.c.seat.y])
    }
    paths[action] = path
    // No step may jump the body: it travels by its own momentum or not at all.
    let worst = 0
    for (let i = 1; i < path.length; i++) worst = Math.max(worst, Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]))
    assert.ok(worst < .02, `${action} never teleports the body, worst single step ${worst.toFixed(4)}`)
  }

  /* AND THE PATH IS NOT THE ACTION'S TO CHOOSE. Actions do differ in one
     legitimate way -- a bigger body meets the rim sooner, so `size` changes
     where it bounces -- and thinking (1.24), writing (1) and running (1.05)
     diverge from idle by up to 0.26 for exactly that reason. That is the body
     being a different SIZE, not being steered. So the claim is made where size
     is held equal: idle, reading and waiting are all BASE_CHARACTER, and from
     the same seed they must trace the SAME path to the last bit. If any of
     them ever acquired a travel path of its own this is where it shows. */
  const sameSize = ACTIONS.filter(a => actionMotion(a, 1).size === actionMotion('idle', 1).size)
  assert.ok(sameSize.length >= 3, `several actions share the base body size, got ${sameSize}`)
  for (const action of sameSize) {
    assert.deepEqual(paths[action], paths.idle,
      `${action} is the same body at the same size as idle, so it takes the same path`)
  }

  /* THE DETECTOR ITSELF, PROVEN. A goal check that could never see a goal
     would read exactly like one that passes -- so hand it a body that IS being
     steered and confirm it objects. The product-side mechanism lives in
     src/home-circle-fluid.js, which this lane does not write, so the guard is
     proven against an injected goal rather than against a mutated renderer. */
  const probe = mount('idle', true)
  probe.step()
  probe.c.seat.goal = { x: .2, y: .2 }
  assert.throws(() => assert.equal(probe.c.seat.goal, null),
    'the goal check objects when the body really is being steered')
})

test('the same base character lingers as eyes and as one body, with continuous gentle morphs', () => {
  for (const fps of [20, 30, 60]) {
    const pose = new Float32Array(4)
    let eyes = 0, body = 0, morph = 0, previous = 0, blinks = 0
    for (let frame = 0; frame < fps * 26.4; frame++) {
      updateBaseCharacter(pose, frame / fps)
      assert.ok(Array.from(pose).every(Number.isFinite))
      assert.ok(Math.abs(pose[0] - previous) < .06, 'no sudden shape switch')
      assert.ok(pose[2] > .97 && pose[2] < 1.03, 'breathing remains subtle')
      /* THE FACE DOES NOT ROTATE AT ALL, and this used to read `< .09`, which
         is why the defect shipped: the pose it was guarding peaked at 0.073,
         so the assertion passed green on every run while the eye pair visibly
         swivelled to the side and the owner reported it twice. A bound that
         admits the reported defect is not a guard. Exact zero is the
         behaviour, because no state may produce a side-turned pose. */
      assert.equal(pose[3], 0, 'the eye pair never rotates, in any state')
      if (pose[0] < .02) eyes++
      else if (pose[0] > .98) { body++; assert.equal(pose[1], 0) }
      else morph++
      if (pose[1] > .4) blinks++ // PROMPT C: the blink closes part way now, so this counts a real closure rather than a full one; how far it goes is bounded by its own test below
      previous = pose[0]
    }
    /* THIS FLOOR IS LOAD-BEARING. It says the pair AND the single blob each
       get real time on screen, which is the character the owner asked for:
       "a transforming between two eyes and a single almost cuddly blob".
       I briefly replaced this with an upper bound on the joined half, having
       misread "still popping up sometimes" as a complaint about the pair
       reappearing. That reading was wrong and this assertion is what should
       have stopped me -- it is guarding a requested feature, not an
       implementation detail. Restored verbatim. If a future change makes this
       fail, the change is wrong, not the bound. */
    assert.ok(eyes / fps > 8 && body / fps > 5 && morph / fps > 4, 'neither identity is only a brief flash')
    assert.ok(blinks > 0, 'the eyes occasionally blink')
  }
})

test('idle drifts and rebounds comfortably over a long run at every supported frame cadence', () => {
  for (const fps of [20, 30, 60]) {
    const f = mount('idle', false), samples = []
    let bounces = 0, previousBounce = -1
    for (let i = 0; i < fps * 60; i++) {
      const before = { x: f.c.seat.x, y: f.c.seat.y }
      f.step(1 / fps)
      const s = f.c.seat
      assert.ok(Math.hypot(s.x - before.x, s.y - before.y) < .006, 'motion has no target jumps')
      if (i > fps * 2) assert.ok(Math.hypot(s.vx, s.vy) < .066, 'no sudden dash')
      assert.equal(s.goal, null)
      assert.equal(s.trampoline || null, null)
      assert.ok(Math.hypot(s.x - .5, s.y - .5) <= s.wallRadius + 1e-6)
      if (s.bounced > previousBounce) { bounces++; previousBounce = s.bounced }
      samples.push({ x: s.x, y: s.y })
    }
    assert.ok(bounces >= 3, 'the character rebounds rather than settling against the wall')
    for (const axis of ['x', 'y']) assert.ok(Math.max(...samples.map(s => s[axis])) - Math.min(...samples.map(s => s[axis])) > .1)
  }
})

test('action animations rest for ten seconds while the original character floats and blinks, then follow the latest action', () => {
  for (const fps of [20, 30, 60]) {
    const f = mount('running', false), resting = []
    const due = f.c.agent.rest.nextAt
    assert.ok(due >= 50 && due <= 70)
    let entered = false, blinked = false, body = false, eyes = false
    for (let i = 0; i < fps * 85; i++) {
      f.step(1 / fps)
      if (f.c.agent.rest.active) {
        assert.equal(f.c.agent.motion.pattern, 'eyes')
        assert.equal(f.c.agent.animation, 'eyes')
        assert.equal(f.c.episode, null)
        assert.equal(f.c.drive.original, 0)
        assert.ok(Math.hypot(f.c.seat.vx, f.c.seat.vy) > .02, 'free floating never stops')
        resting.push({ time: f.c.clock, x: f.c.seat.x, y: f.c.seat.y })
        const pose = f.c.agent.character
        body ||= pose[0] > .98; eyes ||= pose[0] < .02
        if (!entered) {
          assert.equal(f.c.agent.action, 'running', 'the real action remains accurate')
          f.c.ring.dataset.agentAction = 'thinking'; f.c.ring.dataset.agentKey = 'latest-agent'
          entered = true
        } else assert.equal(f.c.agent.action, 'thinking')
      } else if (entered) {
        assert.equal(f.c.agent.motion.pattern, 'cloudy-thinking', 'the latest action resumes, not the one from ten seconds ago')
        assert.equal(f.c.agent.key, 'latest-agent')
        assert.equal(f.c.episode, null, 'agent switches during rest do not queue a stale transition')
        break
      }
    }
    assert.ok(Math.abs(resting.length / fps - 10) <= 1 / fps + 1e-9)
    /* PROMPT B: the blink is no longer claimed from inside this window.
       It is a point event roughly a third of a second long, and this window is
       ten seconds of a 13.2 s cycle, so whether it lands inside is a matter of
       what phase the rest happens to start at -- it passed before only because
       the blink sat at age 1.9 and these seeds happened to cover it. Moving it
       to 10.3 made that luck run out, which is the honest reading: the claim
       was phase luck either way.
       What IS true of any ten-second window is that the character morphs
       through both of its forms, and that is what stays here. The blink has
       its own exhaustive test below, which sweeps whole cycles at three frame
       rates and checks it closes fully and lands after the split. */
    assert.ok(body && eyes, 'the normal character still morphs through both its forms')
    void blinked
    assert.ok(Math.max(...resting.map(p => p.x)) - Math.min(...resting.map(p => p.x)) > .05)
    assert.ok(f.c.agent.rest.nextAt - resting[0].time >= 50 && f.c.agent.rest.nextAt - resting[0].time <= 70)
  }
})

test('rest timing varies around a minute and ordinary idle time is left alone', () => {
  const rest = createActionRest(() => 0)
  assert.equal(rest.nextAt, 50)
  assert.equal(updateActionRest(rest, 49.9, true, () => 1), false)
  assert.equal(updateActionRest(rest, 50, true, () => 1), true)
  assert.equal(rest.nextAt, 120)
  assert.equal(updateActionRest(rest, 59.9, true), true)
  assert.equal(updateActionRest(rest, 60, true), false)
  assert.equal(updateActionRest(rest, 120, false, () => .5), false)
  assert.equal(rest.nextAt, 180, 'idle does not leave a rest overdue for the next fresh action')
  assert.equal(updateActionRest(rest, 121, true), false)
  assert.equal(updateActionRest(rest, 180, true, () => .25), true)
  assert.equal(rest.until, 190)
})

/* Put the seat just outside the wall the renderer reports for this heading,
   rather than at a literal that was measured against one particular rim.
   Both rebound tests used to sit at x = .865; when the rim moved out to meet
   the frame, that literal was comfortably INSIDE the wall and the tests
   failed for describing an old geometry, not a broken one. */
function pressAgainstWall(f, seat) {
  f.step()
  const past = f.c.seat.wallRadius + .006
  Object.assign(f.c.seat, { x: .5 + past, y: .5, ...seat })
  return .5 + past
}

/* NO STATE CAN TURN THE EYE PAIR.
   The owner reported the side-turn THREE times, and twice after it had been
   declared removed, so "I deleted the term I found" is not an answer here.
   There are exactly two ways the pair can end up tilted on screen, and this
   covers both independently:
     1. a rotation inside the eye branch of the dye shader, and
     2. bodyLocal()'s anisotropic scale along an arbitrary axis, which tilts a
        horizontally spaced pair without any rotation term existing at all.
   The earlier removal attempts missed BOTH: patch 12 restored the slot-3 tilt
   to full strength at 01:22, and patches 14/15 at 01:30 deleted a DIFFERENT
   eye implementation (the form-5 'waiting-eyes'), which is why the owner still
   saw it at 02:09. See BUILDER-EYE-PATCH-HISTORY.md. */
/* PROMPT B: and it lands just after the pair finishes separating. The owner
   asked for "the first blink animation to happen soon after the split has
   completed" -- it sat at age 1.9, which is 5.3 s further round a 13.2 s cycle
   and read as an unrelated blink. */
test('exactly one blink per cycle, and it closes fully', () => {
  const pose = new Float32Array(4)
  const fps = 60, events = []
  let open = true
  for (let frame = 0; frame < fps * 13.2; frame++) {
    updateBaseCharacter(pose, frame / fps)
    if (pose[1] > .2 && open) { events.push({ age: frame / fps, peak: pose[1] }); open = false }
    if (pose[1] < .05) open = true
    if (events.length) events[events.length - 1].peak = Math.max(events[events.length - 1].peak, pose[1])
  }
  assert.equal(events.length, 1, `one blink per 13.2 s cycle, got ${events.length} at ages ${events.map(e => e.age.toFixed(1))}`)
  /* PROMPT C: this read `peak > .97`. It was guarding against the "weird
     blink" of squashed slits, but it guarded it by demanding a FULL closure,
     and the owner has since asked for the opposite -- "closese too much". The
     real guard is not how far it shuts, it is whether what is left can be
     drawn, and that is asserted against the coarsest grid above. */
  assert.ok(events[0].peak > .35, `the blink is a real closure, peak ${events[0].peak.toFixed(3)}`)

  /* PROMPT B -- AND IT LANDS JUST AFTER THE SPLIT. `together` reaches 0 when
     the second ease completes, which is where the pair has finished separating;
     the blink must follow shortly after that and not five seconds later. Both
     ends are bounded: too early and it is muted, because pose[1] is scaled by
     (1 - together) and the eyes have not finished arriving; too late and it is
     the unrelated blink the owner reported. */
  let splitDone = null
  for (let frame = 0; frame < fps * 13.2; frame++) {
    const age = frame / fps
    updateBaseCharacter(pose, age)
    if (splitDone === null && age > 5 && pose[0] < 1e-6) splitDone = age
  }
  assert.ok(splitDone !== null, 'the pair finishes separating within the cycle')
  const after = events[0].age - splitDone
  assert.ok(after > 0 && after < 1.5,
    `the blink follows the split by ${after.toFixed(2)}s (split at ${splitDone.toFixed(2)}, blink at ${events[0].age.toFixed(2)})`)
})

/* T259 ITEM (3): THE OCCASIONAL SUBTLE PAUSE-AND-SQUINT, AS ITS OWN GESTURE.
   It was built once AS the blink and came back as "the blink is weird and too
   long and closese too much", and was removed with it. The test above already
   said what the answer was -- "the squint is a separate, rarer gesture and the
   blink must not carry it" -- so this asserts the separation rather than the
   existence of some closure.
   NOTHING ABOVE IS RELAXED TO MAKE ROOM FOR IT. The blink counter triggers at
   pose[1] > .2 and the squint peaks at .17, so "exactly one blink per cycle"
   sees the squint at all and is unchanged; the depth is what separates them,
   not a widened window. Swept over ten cycles rather than one, because a
   gesture whose whole point is that it is RARE cannot be judged inside a
   single cycle. */
test('the squint is a separate gesture: rarer, shallower and slower than the blink, and it holds', () => {
  const pose = new Float32Array(4)
  const fps = 60, CYCLE = 13.2, CYCLES = 10
  /* Every closure in the sweep, classified by DEPTH and nothing else. A run of
     frames with the eye off-open is one event; its peak says which gesture it
     was. Reading it this way means a squint that ever grew into a full closure
     is counted as a blink and fails the counts below -- it cannot hide. */
  const events = []
  let run = null
  for (let frame = 0; frame < fps * CYCLE * CYCLES; frame++) {
    const t = frame / fps
    updateBaseCharacter(pose, t)
    if (pose[1] > .02) {
      if (!run) { run = { start: t, peak: 0, held: 0 }; events.push(run) }
      run.peak = Math.max(run.peak, pose[1])
      run.end = t
    } else if (run) { run = null }
  }
  for (const e of events) e.length = e.end - e.start
  const blinks = events.filter(e => e.peak > .35)
  const squints = events.filter(e => e.peak <= .2)
  assert.equal(blinks.length + squints.length, events.length,
    `every closure is either a blink or a squint, got peaks ${events.map(e => e.peak.toFixed(2))}`)

  // ONE full closure per cycle, still, and stated here in its own right.
  assert.equal(blinks.length, CYCLES, `one full closure per cycle over ${CYCLES} cycles, got ${blinks.length}`)

  // RARER. It is a gesture the owner asked to be occasional.
  assert.ok(squints.length > 0, 'the squint happens at all')
  assert.ok(squints.length * 2 <= blinks.length,
    `the squint is rarer than the blink: ${squints.length} squints against ${blinks.length} blinks`)

  // SHALLOWER, with a bound a full closure cannot satisfy. .35 is the floor the
  // blink is asserted against above, so these two bounds cannot both be met.
  const deepest = Math.max(...squints.map(e => e.peak))
  assert.ok(deepest < .2, `the squint is partial, deepest ${deepest.toFixed(3)}`)
  assert.ok(deepest > .08, `and still a real narrowing rather than nothing, deepest ${deepest.toFixed(3)}`)

  /* SLOWER, AND IT PAUSES. This is the one term that separates a squint from a
     blink in kind rather than degree: a blink is quick and has no hold in it.
     Asserted as a real hold -- the eye stays within a tenth of its deepest
     point for a stretch -- not merely as a longer total. */
  const blinkLength = Math.max(...blinks.map(e => e.length))
  for (const e of squints) {
    assert.ok(e.length > blinkLength * 2,
      `the squint is a slow gesture, ${e.length.toFixed(2)}s against the blink's ${blinkLength.toFixed(2)}s`)
    let held = 0
    for (let frame = 0; frame < fps * e.length; frame++) {
      updateBaseCharacter(pose, e.start + frame / fps)
      if (pose[1] > e.peak * .9) held += 1 / fps
    }
    assert.ok(held > .3, `the squint HOLDS near its deepest point for ${held.toFixed(2)}s, which is the pause`)
  }

  /* IT HAS TO FINISH BEFORE THE PAIR STARTS CLOSING, WITH ROOM TO SPARE.
     `together` begins rising at age 3.2, and pose[1] is scaled by (1 - together),
     so a squint whose tail ran past that would be SILENTLY SWALLOWED rather
     than fail: the peak-and-hold checks above sit at age 1.98-2.50 and would
     not notice a clipped tail at all. Asserting the whole gesture is back to
     open before 3.2, with margin, is what makes a later lengthening of close,
     hold or open fail here instead of quietly disappearing into the morph. */
  for (const e of squints) {
    const endAge = e.end % 13.2
    assert.ok(endAge < 3.2 - .1,
      `the squint is over before the pair starts closing at 3.2: it ends at age ${endAge.toFixed(2)}`)
    // And the eyes really are apart for the whole of it, not just at its middle.
    for (let frame = 0; frame <= fps * e.length; frame++) {
      updateBaseCharacter(pose, e.start + frame / fps)
      assert.ok(pose[0] < .01, `the squint happens with the eyes apart, together ${pose[0].toFixed(3)}`)
    }
  }

  /* AND IT HAS TO BE DRAWABLE, which is what killed the first attempt: at 14%
     of the open height the eye is about two dye texels tall and breaks up
     instead of narrowing. Read off the shader and the ladder rather than
     restated, the same way the blink's floor is. A shallower closure is
     strictly easier here, so this should pass by a wide margin -- and if it
     ever does not, the squint got deep enough to be the thing that failed. */
  const openHeight = Number(forms.match(/float height = mix\(([\d.]+),/)[1])
  const squash = Number(forms.match(/\* \(1\.0 - ([\d.]+) \* uCharacter\.y\)/)[1])
  const coarsest = Math.min(...JSON.parse(fluid.match(/var LADDER = (\[[\s\S]*?\]);/)[1]
    .replace(/(\w+):/g, '"$1":')).map(rung => rung.dye))
  const texels = openHeight * (1 - squash * deepest) * coarsest
  assert.ok(texels > 3.5, `the squinting eye is still ${texels.toFixed(1)} texels on the ${coarsest} grid`)
})

/* PROMPT C -- IT IS A BLINK, AND A BLINK HAS TO BE DRAWABLE.
   This event was briefly built as a squint: 1.15 s, closing all the way, with
   a 0.55 s pause. That came back as "the blink is weird and too long and
   closese too much". It is the blink; the squint is a separate, rarer gesture
   and the blink must not carry it.
   Two things are asserted and they pull against each other, which is the whole
   difficulty. It has to be QUICK and SHALLOW, because that is what a blink is.
   And it has to RESOLVE, because a partial closure is exactly what failed
   before -- at 14% of the open height the eye is about two dye texels tall,
   under what the grid can draw, and it came back as squashed slits. The floor
   below is what makes a partial closure safe now, and it is checked against
   the COARSEST rung the ladder can reach, because that is where it breaks. */
test('the blink is quick, shallow, and still tall enough to draw', () => {
  const pose = new Float32Array(4)
  // Read the eye geometry out of the shader rather than restating it, so this
  // cannot drift away from what the product actually draws.
  const open = Number(forms.match(/float height = mix\(([\d.]+),/)[1])
  const squash = Number(forms.match(/\* \(1\.0 - ([\d.]+) \* uCharacter\.y\)/)[1])
  const coarsest = Math.min(...JSON.parse(fluid.match(/var LADDER = (\[[\s\S]*?\]);/)[1]
    .replace(/(\w+):/g, '"$1":')).map(rung => rung.dye))

  for (const fps of [20, 30, 60]) {
    /* THE BLINK'S OWN FRAMES, NOT EVERY FRAME THE EYE IS OFF-OPEN.
       This summed all closure across the cycle, which was the same thing while
       the blink was the only gesture there was. It is not any more: T259 item
       (3)'s squint is a second, deeper-held closure, and totalling both read as
       a 1.50 s blink and failed here. Splitting the cycle into runs and taking
       the one that reaches blink depth is STRICTER than what it replaced --
       `peak` and `worst` were cycle-wide before, so a second gesture could have
       supplied either of them and this would not have noticed. */
    const runs = []
    let run = null, previous = 0
    for (let frame = 0; frame < fps * 13.2; frame++) {
      updateBaseCharacter(pose, frame / fps)
      const now = pose[1]
      if (now > .02) {
        if (!run) { run = { frames: 0, peak: 0, worst: Math.abs(now - previous) }; runs.push(run) }
        run.frames++
        run.peak = Math.max(run.peak, now)
        run.worst = Math.max(run.worst, Math.abs(now - previous))
      } else if (run) { run.worst = Math.max(run.worst, Math.abs(now - previous)); run = null }
      previous = now
    }
    const deep = runs.filter(r => r.peak > .35)
    assert.equal(deep.length, 1, `${fps}fps: exactly one closure in the cycle reaches blink depth, got ${runs.map(r => r.peak.toFixed(2))}`)
    const { frames, peak, worst } = deep[0]
    assert.ok(frames / fps < .6, `${fps}fps: a blink is quick, this one runs ${(frames / fps).toFixed(2)}s`)
    assert.ok(peak > .35 && peak < .8, `${fps}fps: it closes part way, not all the way and not a twitch, peak ${peak.toFixed(2)}`)
    assert.ok(worst < .32, `${fps}fps: it never moves more than a third of its closure between frames, worst ${worst.toFixed(3)}`)
    // What is left of the eye at its deepest, in texels of the coarsest grid.
    const texels = open * (1 - squash * peak) * coarsest
    assert.ok(texels > 3.5,
      `${fps}fps: the narrowed eye is still ${texels.toFixed(1)} texels on the ${coarsest} grid, so it narrows instead of breaking up`)
  }
})

/* The lid spread is the other half of that, and it is what makes a partial
   closure resolve at all. A lid that closes is a lid that spreads. */
test('the closing eye widens as it flattens, and not at all when it is open', () => {
  const code = forms.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const face = code.slice(code.indexOf('if (kind < 2.5)'), code.indexOf('if (kind < 3.5)'))
  assert.ok(face.length > 200, 'found the eye branch of fluidForm')
  assert.match(face, /width \*= 1\.0 \+ [\d.]+ \* uCharacter\.y/,
    'the width grows with closure, so a narrowing eye stays a lens rather than a sliver')
  const widen = Number(face.match(/width \*= 1\.0 \+ ([\d.]+) \* uCharacter\.y/)[1])
  assert.ok(widen > .2 && widen < 1, `the spread is real but not a bulge, got ${widen}`)
  assert.equal(1 + widen * 0, 1, 'and it is exactly neutral at zero closure')
})

test('no state can turn the eye pair', () => {
  /* Path 1, structural. Comments are stripped first: the point is what the
     shader DOES, and the prose in this file necessarily names the term that
     was removed. Matching prose made this fail on its own explanation. */
  const code = forms.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const eyeBranch = code.slice(code.indexOf('if (kind < 2.5)'), code.indexOf('if (kind < 3.5)'))
  assert.ok(eyeBranch.length > 100, 'found the eye branch of FLUID_FORMS')
  assert.ok(!/\b(cos|sin)\s*\(\s*uCharacter/.test(eyeBranch),
    'the eye branch does not rotate the pair by any character slot')
  assert.ok(!/uCharacter\.w/.test(code), 'no shader code reads the retired tilt slot')

  // Path 1, behavioural: the pose never carries a rotation to hand it.
  const pose = new Float32Array(4)
  for (let frame = 0; frame < 60 * 60; frame++) {
    updateBaseCharacter(pose, frame / 60)
    assert.equal(pose[3], 0)
  }

  /* Path 2, behavioural, and the window is EVERY FRAME THE PAIR CONTRIBUTES.
     bodyLocal() scales the face anisotropically along an arbitrary axis, so a
     compression off 1 tilts the pair's principal axis with no rotation term
     anywhere -- the structural assertions above would stay green through it.
     It is safe only while compression is EXACTLY 1, which is the identity for
     any axis.
     Every animation in this product is a body deformation, so every one of
     them is a candidate to drive compression off 1. Each is therefore swept
     here in BOTH directions -- leaving the pair and returning to it -- because
     the pair is on screen or part-way on screen for most of the frame budget
     (measured live: eyes open 46%, morphing 21%), and "the settled form only"
     is precisely the coverage gap that let an earlier version of this test
     pass a mutation it was written to catch. */
  const ANIMATIONS = [
    { action: 'thinking', tool: '', form: 1 },
    { action: 'running', tool: '', form: 4 },
    { action: 'writing', tool: 'reply', form: 3 },
    { action: 'writing', tool: 'Edit', form: 4 },
  ]
  for (const animation of ANIMATIONS) {
    const f = mount('idle', true)
    f.c.personality = () => {} // the stub asserts idle; we deliberately leave idle
    const seen = { settled: 0, leaving: 0, entering: 0 }
    let worst = null
    for (let i = 0; i < 520; i++) {
      f.step()
      // A wall squash and a fast diagonal heading are what set a non-zero axis
      // and a non-1 compression for every non-face form. Keep them live across
      // both transitions so the guard is under load, not tested at rest.
      if (i % 90 === 40) f.c.seat.squash = { t: f.c.clock, x: .8, y: .5, nx: Math.SQRT1_2, ny: Math.SQRT1_2, hit: .3, span: .6, depth: .08 }
      if (i === 60) Object.assign(f.c.seat, { speed: .32, face: Math.PI / 3 })
      if (i === 150) { f.c.ring.dataset.agentAction = animation.action; f.c.ring.dataset.agentTool = animation.tool }
      if (i === 340) { f.c.ring.dataset.agentAction = 'idle'; f.c.ring.dataset.agentTool = '' }
      /* The shrinking-core episode is the largest deformation the circle has,
         and it is the one that plays over an IDLE circle -- i.e. over the eye
         pair. It runs here so the guard covers it too. */
      if (i === 430) f.c.episode = { t: 0, phase: 'collapse', tau: .5, reason: 'auto' }
      if (i > 430 && f.c.episode) f.c.episode.t += 1 / 30
      const shape = f.c.bodyShape(), drive = f.c.drive
      if (!shape.faceForm) continue
      if (shape.compression !== 1 && !worst) worst = { i, compression: shape.compression, axis: shape.axis }
      assert.equal(shape.compression, 1,
        `${animation.action}/${animation.tool || 'none'}: the pair contributes at step ${i}, so the body scale must be exactly 1, got ${shape.compression} on axis ${shape.axis}`)
      if (drive.formFrom === 2 && drive.form !== 2 && drive.formMix < 1) seen.leaving++
      else if (drive.form === 2 && drive.formFrom !== 2 && drive.formMix < 1) seen.entering++
      else seen.settled++
    }
    assert.equal(worst, null)
    // A guard nothing reached proves nothing. Every window must have occurred.
    const where = `${animation.action}/${animation.tool || 'none'} (form ${animation.form})`
    assert.ok(seen.settled > 80, `${where}: settled pair measured, got ${seen.settled} frames`)
    assert.ok(seen.leaving > 0, `${where}: pair measured while morphing AWAY, got ${seen.leaving} frames`)
    assert.ok(seen.entering > 0, `${where}: pair measured while morphing BACK, got ${seen.entering} frames`)
  }
})

/* THE TWO KINDS OF LIGHT, AND WHY THIS TEST HAS TO HOLD BOTH SIDES AT ONCE.
   The owner rejected lighting FOUR times ("stop adding effects though like
   lighting layers and shit i dont like it"), and separately asked for an
   animation back BECAUSE of its lighting ("one where the blob turned really
   whispy and spun and it had some lighting effects when it did it").
   Those are two different things and a fix that only remembers one of them
   swings to the wrong extreme:
     WANTED  the curl-lit storm colour. |vorticity| from the solve picks the
             slow stop when the water barely turns and the fast stop when it
             spins hard, so the light IS the motion and vanishes with it.
     BANNED  uSheen's specular highlight and uRelief's directional normal
             shading -- a glossy coat sitting on the whole bubble whether or
             not anything is moving.
   Both halves are asserted here so neither can be "fixed" by losing the other. */
test('the storm is lit by its own motion, and no gloss layer returns', () => {
  const code = fluid.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  /* THE SLICE IS ANCHORED ON THE BLOCK, NOT ON ONE DECLARATION LINE.
     This read code.indexOf('uniform vec3 uLight; uniform vec3 uDeep'), which is
     a declaration ORDER, not a structure. Measured 2026-09-18 on shader
     c4384adb: 'uniform vec3 uFast; uniform vec3 uSlow;' sits at index 38800 and
     that anchor at 38835 -- the storm stops are declared one line ABOVE the
     slice, so the uFast assertion went red over a uniform the shader still has,
     and swapping two adjacent declaration lines would have turned it green with
     nothing else changed. The array named display: [ is what this test means. */
  const display = code.slice(code.indexOf('display: ['), code.indexOf('function compile'))
  assert.ok(display.length > 400, 'found the display shader')

  // WANTED: the curl field must reach the colour, not merely the density.
  assert.match(display, /uFast/, 'the fast storm stop reaches the display shader')
  assert.match(display, /uSlow/, 'the slow storm stop reaches the display shader')

  /* WHAT THIS TEST CAN NO LONGER BIND TO, SAID OUT LOUD.
     Everything below this point works by lifting named statements out of the
     shader and running them as arithmetic -- that is what makes it a behaviour
     check rather than a spelling pin, and it is the only thing here enforcing
     the owner's four rejections of a gloss coat ("stop adding effects though
     like lighting layers and shit", "i still see the gloss/white on a lot of
     animations which i dont like").
     If the shader stops containing those statements the arithmetic silently
     stops running and the bans enforce NOTHING. Measured on c4384adb, that is
     what happened: the colour law moved to an absorption model and the surface,
     bevel, colour and uRelief bindings went away together, while this test died
     earlier on a stale uniform pin and never reported it. The quickest route to
     green was to restore the old spelling -- a green test with its real check
     dead, sitting directly over the defect it exists to forbid.
     So the bindings are inventoried FIRST and their absence is the failure, by
     name. This is a RED and not a skip: coverage that cannot bind is not
     coverage, and a ban nobody is enforcing is worth reporting as loudly as a
     breach. */
  const BINDINGS = [
    ['vorticity chooses the storm colour between the slow and fast stops', /mix\(\s*uSlow\s*,\s*uFast\s*,[^)]*curlInk/],
    ['the body surface statement, float surface = ...;', /float surface = ([^;]+);/],
    ['the bevel statement, float bevel = ...;', /float bevel = ([^;]+);/],
    ['the relief uniform uRelief', /uRelief/],
    ['the body colour statement, vec3 colour = ...;', /vec3 colour = ([^;]+);/],
    ['the emitted pixel, gl_FragColor = vec4(...);', /gl_FragColor = vec4\((.+)\);/]
  ]
  const unbound = BINDINGS.filter(([, re]) => !re.test(display)).map(([what]) => what)
  assert.equal(unbound.length, 0,
    'this shader no longer contains the statements this test evaluates, so the gloss-coat bans below are ' +
    `enforcing nothing. Unbound: ${unbound.join('; ')}. Do NOT repair this by restoring the old spelling -- ` +
    're-state the bans against whatever the current colour law is, or measure them on pixels (the material ' +
    'proof M9 "one wet catch, not a sheen" and M6a "the rim does not out-shine the core" already cover the ' +
    'WANTED half on the real framebuffer).')

  /* PROMPT A: THE THIRD LIGHT, AND THE LINE THIS TEST USED TO GET WRONG.
     This block read `assert.ok(!/uRelief/.test(display))` -- it banned the
     directional shading alongside the specular, because all three lights were
     deleted together and the test was written from that deletion rather than
     from what the owner rejected. The owner's four reports are about a GLOSS
     COAT: "stop adding effects though like lighting layers and shit", "i still
     see the gloss/white on a lot of animations which i dont like". They have
     since asked for the other thing back, by name: "kinda solid like at one
     point we had it with a little bit of white shading".
     So the ban is now stated as what it always meant, and is strictly
     narrower in one direction and strictly stronger in the other: the
     specular and the white lift it rode on are banned by structure, and the
     relief is REQUIRED, so deleting it again fails here. */
  assert.ok(!/uSheen/.test(display), 'no sheen uniform returns to the display shader') // PROMPT A
  /* PROMPT F -- THESE TWO LINES USED TO BAN THE SPECULAR BY ITS SPELLING, and
     the owner has since supplied a reference photograph that has one. They
     read
       assert.ok(!/pow\(\s*max\(\s*dot\(\s*n\s*,\s*h/.test(display), 'no specular highlight term returns')
       assert.ok(!/h\s*=\s*normalize\(\s*l\s*\+/.test(display), 'no half-vector is built, so no specular can be')
     and the shipped catch does not match either regex -- it builds `hv` and
     calls smoothstep rather than pow. Left alone they would have gone green
     over the exact thing they were written to forbid, which is worse than
     going red: a ban that a rename walks through is not a ban. They are
     replaced by the distinction the owner's four rejections are actually
     about, which is not specular-or-not at all.
     A LAYER is composited over the finished body and does not know what is
     underneath it; it would look identical over any shape. A SURFACE is the
     material's own boundary: it is computed from the body's geometry, it
     moves and breaks with the shape, and where there is no body there is
     nothing to reflect. That last clause is the one that can be evaluated
     here, so it is -- the rest is measured in the browser by
     tools/home-circle-form-qa.mjs, which follows the catch's centroid against
     the body's and against the canvas. */
  const surfaceLaw = display.match(/float surface = ([^;]+);/)
  const bevelLaw = display.match(/float bevel = ([^;]+);/)
  assert.ok(surfaceLaw && bevelLaw, 'the display shader builds the body surface in named statements')
  const gloss = readTune().gloss
  const bevelOf = glslScalar(bevelLaw[1], ['n_z', 'uGloss_z'])
  const surfaceOf = glslScalar(surfaceLaw[1],
    ['uGloss_x', 'uGloss_y', 'uGloss_z', 'uGloss_w', 'depth', 'mist', 'bevel', 'dot', 'n', 'hv', 'n_z'])
  const surface = (facing, nz, depth, mist) => surfaceOf(gloss[0], gloss[1], gloss[2], gloss[3],
    depth, mist, bevelOf(nz, gloss[2]), () => facing, null, null, nz)
  /* WHERE THERE IS NO BODY THERE IS NO CATCH. depth is the crisp silhouette
     reading, 0 outside the outline, so this is the "delete the shape and the
     highlight goes with it" self-test as arithmetic. */
  for (const facing of [0, 0.5, 0.898, 0.95, 1])
    for (const nz of [0, 0.5, 1]) {
      assert.equal(surface(facing, nz, 0, 0), 0, 'with no body under it there is no catch')
      assert.equal(surface(facing, nz, 1, 1), 0, 'and a whispy cloud has no boundary to reflect from')
    }
  /* AND IT DOES NOT WASH THE BODY. A flat interior faces the eye, so its
     normal is (0,0,1) and dot(n, hv) is 0.898 for the light this shader uses.
     A catch that is non-zero there is a coat over the whole body rather than
     a reflection off part of it, which is the thing that has been rejected
     four times. */
  assert.equal(surface(0.898, 1, 1, 0), 0, 'the flat interior of the body carries no catch at all, so the catch is not a coat over it')
  assert.ok(surface(1, 1, 1, 0) > 0.05, `the surface turned straight into the light does catch it, ${surface(1, 1, 1, 0).toFixed(3)}`)
  let falls = 0
  for (let i = 1; i <= 20; i++) {
    const lo = surface(0.898 + (i - 1) * (1 - 0.898) / 20, 1, 1, 0)
    const hi = surface(0.898 + i * (1 - 0.898) / 20, 1, 1, 0)
    if (hi < lo - 1e-12) falls++
  }
  assert.equal(falls, 0, 'and it only ever grows as the surface turns further into the light')

  // WANTED: the dye's own slope, lit from one direction, shading the material.
  assert.match(display, /uRelief/, 'the relief uniform reaches the display shader') // PROMPT A
  assert.match(display, /normalize\(vec3\(\(hL - hR\) \* uRelief/, "the surface normal is the dye field's own slope") // PROMPT A
  assert.match(display, /max\(dot\(n, l\), 0\.0\)/, 'and it is lit from one direction') // PROMPT A
  /* The distinction that cost this lane four rounds: the shading may only ever
     REMOVE light from the body's own colour. A gloss layer is an ADDITIVE
     white term, which is how uSheen worked (`+ uSheen * (0.9 * sheen +
     lines)`). Nothing here may lift a pixel.
     PROMPT E -- THIS IS EVALUATED NOW, NOT SPELLED. The line here was
     `assert.match(display, /\* shade/, 'the shading multiplies the material')`,
     which read the ban off the `*` in the implementation that was current when
     it was written: the tilt multiplied the finished colour, so a multiply was
     the ban. The tilt is now extra optical depth inside the absorption
     exponent, which obeys the same ban strictly harder -- exp() of a larger
     non-negative total is <= exp() of a smaller one -- and the pin went red
     against it. A pin that fails against a BETTER implementation is a pin
     whose quickest repair is to put the weaker implementation back, so it is
     replaced by the claim it was standing in for, run over values:
       1. no value the colour law can produce is above the material's own
          light stop, at any thickness, tilt or palette;
       2. turning away from the light never ADDS to any channel;
       3. and the SAME thickness that drives the colour drives the relief --
          the fully turned-away flank loses several times as much of its light
          through the mass as it does through the thin skin, which is what
          makes shading a property of the material rather than a fixed range
          applied to every part of it alike.
     The law is lifted out of the shader and run as arithmetic per channel,
     which is sound because every operation in that statement is component-
     wise. glslScalar REFUSES BY NAME on any identifier or call it was not
     given rather than skipping, because a colour statement it cannot read is
     a ban it cannot check. */
  const colourLaw = display.match(/vec3 colour = ([^;]+);/)
  assert.ok(colourLaw, 'the display shader assigns the body colour in one statement')
  const colour = glslScalar(colourLaw[1], ['uLight', 'uAbsorb', 'optical', 'away', 'depth', 'uReliefDepth', 'uAbsorb2', 'uDyeTwo', 'mid'])
  const TUNE = readTune()
  const reliefDepth = TUNE.reliefDepth, dyeTwo = TUNE.dyeTwo
  assert.ok(reliefDepth >= 0, `the extra path through the material is non-negative, got ${reliefDepth}`)
  assert.ok(dyeTwo >= 0, `the second dye's concentration is non-negative, got ${dyeTwo}`)
  /* PROMPT F -- THE SECOND DYE LEAVES BOTH LEDGER STOPS EXACTLY WHERE THEY
     ARE, which is the whole reason it is allowed to turn the hue at all: the
     ledger owns the colour, chroma() exists to stop this renderer sliding a
     status colour off its hue, and a dye that changed the endpoints would be
     the renderer picking a colour of its own. The guarantee is not a property
     of the colour statement alone -- it is a property of the concentration
     envelope, so the envelope is lifted out and evaluated too. */
  const midDecl = display.match(/float mid = ([^;]+);/)
  const midThen = display.match(/'\s*mid = ([^;]+);/)
  assert.ok(midDecl && midThen, "the second dye's concentration is built in two statements")
  const midStart = glslScalar(midDecl[1], ['optical']), midEnd = glslScalar(midThen[1], ['mid'])
  const midOf = o => midEnd(midStart(o))
  assert.equal(midOf(0), 0, 'there is none of the second dye at zero thickness, so the light stop is exactly the light stop')
  assert.equal(midOf(1), 0, 'and none of it at full thickness, so the deep stop is exactly the deep stop')
  assert.ok(midOf(0.5) > 0.9, `the second dye is present through the middle of the depth, ${midOf(0.5).toFixed(3)} of its peak halfway`)
  /* Swept rather than pinned to today's palette: uAbsorb is whatever
     -log(deep / light) gives, floored at 0 and capped at 6 where it is
     derived, and uLight is a colour channel. */
  let lift = 0, gain = -Infinity, turn = 0
  for (const light of [0.08, 0.35, 0.72, 1])
    for (const absorb of [0, 0.05, 0.4, 1.35, 3, 6])
      for (const absorb2 of [0, 0.4, 1.35, 6])
        for (const optical of [0, 0.05, 0.3, 1, 2, 3])
          for (const deep of [0, 0.5, 1]) {
            const mid = midOf(optical)
            const flat = colour(light, absorb, optical, 0, deep, reliefDepth, absorb2, dyeTwo, mid)
            const oneDye = colour(light, absorb, optical, 0, deep, reliefDepth, absorb2, 0, mid)
            turn = Math.max(turn, oneDye - flat)
            for (const away of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
              const shaded = colour(light, absorb, optical, away, deep, reliefDepth, absorb2, dyeTwo, mid)
              lift = Math.max(lift, shaded / light)
              gain = Math.max(gain, shaded - flat)
            }
            if (optical === 1) {
              // the deep stop, reached with the second dye present in the law
              // and absent from this thickness by construction
              assert.ok(Math.abs(flat - colour(light, absorb, 1, 0, deep, reliefDepth, 0, 0, 0)) < 1e-12,
                'at full thickness the second dye contributes nothing, whatever its coefficient')
            }
          }
  assert.ok(turn >= -1e-12, `the second dye can only ever REMOVE light too, got ${turn.toExponential(2)}`) // PROMPT F
  assert.ok(lift <= 1 + 1e-12, `no pixel of the body is brighter than the material's own light stop, got ${lift.toFixed(4)} of it`) // PROMPT E

  /* AND THE SAME THING ABOUT THE PIXEL THAT IS ACTUALLY DRAWN.
     Everything above is a statement about `colour`, and `colour` is not what
     reaches the screen: the shader emits colour * a + surface, premultiplied.
     A guarantee stated about an intermediate that something is added to
     afterwards is worth LESS than no guarantee, because it reads as covered --
     the no-lift bound could hold perfectly while the emitted pixel lifted, and
     nothing here would have known. So the output statement is lifted out and
     evaluated too, and the claim is made where it counts.
     The catch is allowed to add light -- that is what a reflection is, and its
     extent and placement are bounded on the real framebuffer by
     tools/home-circle-form-qa.mjs (share under 12%, centroid closer to the
     body than to the canvas). What is asserted here is the other half, which
     that driver cannot see: that the catch is the ONLY thing that can lift,
     so wherever there is no catch the drawn pixel is exactly the material. */
  const emitted = display.match(/gl_FragColor = vec4\((.+)\);/)
  assert.ok(emitted, 'the display shader emits its pixel in one statement')
  const split = argument => {
    let depth = 0
    for (let i = 0; i < argument.length; i++) {
      if (argument[i] === '(') depth++
      else if (argument[i] === ')') depth--
      else if (argument[i] === ',' && depth === 0) return [argument.slice(0, i), argument.slice(i + 1)]
    }
    assert.fail(`the emitted pixel is not a colour and an alpha: ${argument}`)
  }
  const [rgbLaw, alphaLaw] = split(emitted[1])
  const rgbOf = glslScalar(rgbLaw, ['colour', 'a', 'surface'])
  const alphaOf = glslScalar(alphaLaw, ['a', 'surface'])
  // Premultiplied, so what a person sees is the colour divided back out.
  const drawn = (c, a, s) => rgbOf(c, a, s) / alphaOf(a, s)
  let drawnLift = 0, unlit = 0
  for (const c of [0.05, 0.3, 0.62, 1]) {
    for (const a of [0.08, 0.4, 0.75, 1]) {
      // WHERE THERE IS NO CATCH the drawn pixel is the material, exactly.
      unlit = Math.max(unlit, Math.abs(drawn(c, a, 0) - c))
      // WHERE THERE IS ONE it may be brighter, and only upward.
      for (const s of [0, 0.02, 0.15, 0.5]) drawnLift = Math.min(drawnLift, drawn(c, a, s) - c)
    }
  }
  assert.ok(unlit < 1e-12,
    `with no catch over it the DRAWN pixel is the material and nothing else, off by ${unlit.toExponential(2)}`)
  assert.ok(drawnLift >= -1e-12,
    `and a catch can only ever add light, never remove it, got ${drawnLift.toExponential(2)}`)
  /* The flat interior carries no catch -- asserted above as surface(0.898, 1,
     1, 0) === 0 -- so chaining the two says the thing the owner's four
     rejections are about: over the body's own flat face, the pixel drawn is
     the material's colour and there is no coat on it. */
  assert.equal(surface(0.898, 1, 1, 0), 0, 'the flat interior still carries no catch')
  assert.ok(Math.abs(drawn(0.62, 0.75, surface(0.898, 1, 1, 0)) - 0.62) < 1e-12,
    'so over the flat interior the drawn pixel is exactly the material colour')
  assert.ok(gain <= 1e-12, `turning away from the light can only ever REMOVE it, got +${gain.toExponential(2)} on a channel`) // PROMPT E
  const lost = optical => {
    const mid = midOf(optical)
    return 1 - colour(1, 1.35, optical, 1, 0, reliefDepth, 0, dyeTwo, mid) / colour(1, 1.35, optical, 0, 0, reliefDepth, 0, dyeTwo, mid)
  }
  const throughMass = lost(1.5), throughSkin = lost(0.15)
  assert.ok(throughMass > throughSkin * 2, // PROMPT E
    'the thickness that drives the colour drives the relief: the fully turned-away flank loses '
    + `${(throughMass * 100).toFixed(0)}% of its light through the mass and ${(throughSkin * 100).toFixed(0)}% through the thin skin`)
  assert.ok(!/\+\s*u?[A-Za-z]*[Ss]heen/.test(display), 'nothing is added to the colour on top of the material') // PROMPT A
  assert.ok(!/colour\s*\+=/.test(display), 'and no term is ever added into the colour') // PROMPT A
  assert.ok(!/lines/.test(display), 'the refraction lines that rode with the sheen stay deleted') // PROMPT A

  // And the storm stops stay de-gilded, so a curl-lit amber cannot read as
  // gold sheen. Behavioural: ungilded moves a gilded hue and leaves others.
  const c = vm.createContext({ Math })
  vm.runInContext(['hue', 'mixed', 'ungilded'].map(name => declaredFunctionSource(fluid, name)).join('\n'), c)
  const amber = c.ungilded([0.95, 0.75, 0.2])
  assert.notDeepEqual(amber, [0.95, 0.75, 0.2], 'a gilded amber is pulled off the gold band')
  const teal = [0.1, 0.62, 0.68]
  assert.deepEqual(c.ungilded(teal), teal, 'a hue outside the gold band is left exactly alone')

  /* readPalette must actually APPLY it, which is a separate claim from
     ungilded working. Driven with an AMBER status on purpose: the ledger
     "attention" colour is yellow, so a gilded curl-lit storm is a state the
     product really reaches, and every colour in the older palette test is
     outside the gold band, where ungilded is the identity and this cannot
     be observed. */
  const ring = {}, body = {}, root = {}, status = [0.95, 0.75, 0.2, 1]
  const p = vm.createContext({
    ring, root, document: { body }, palette: {}, paletteDirty: true,
    rgba: value => value === 'status' ? status : [0.09, 0.11, 0.13, 1],
    glowValue: () => 1,
    getComputedStyle: el => ({ backgroundColor: 'bg', getPropertyValue: key => el === ring && key === '--core-status-color' ? 'status' : '.75' }),
  })
  // PROMPT F: lifted and TUNE join the harness, because readPalette derives
  // the second dye's coefficient by turning the deep stop's hue.
  p.TUNE = readTune()
  vm.runInContext(['hue', 'mixed', 'ungilded', 'lifted', 'luminance', 'chroma', 'readPalette'].map(name => declaredFunctionSource(fluid, name)).join('\n'), p)
  p.readPalette()
  assert.notDeepEqual(Array.from(p.palette.fast), Array.from(p.palette.light),
    'readPalette de-gilds the fast storm stop rather than reusing the light stop')
  assert.notDeepEqual(Array.from(p.palette.slow), Array.from(p.palette.deep),
    'readPalette de-gilds the slow storm stop rather than reusing the deep stop')
})

/* THE SHRINKING-CORE EPISODE PLAYS ON ITS OWN, AND REPEATS.
   Recovered from 21506c72. The deleted test alongside it read "thinking
   automatically runs the original shrinking core, torque and ring pulses,
   then recovers and repeats", and the owner asked for exactly that shape:
   "navier stokes could be really good for the thinking one, like it can get
   really slow... then pulse again".
   Losing it left NO error and no failing test -- just `sinceEpisode` assigned
   and never incremented and `nextEpisode` assigned and never read. Two dead
   variables were the entire automatic cycle, which is why a net diff reads as
   harmless. This asserts the cycle, not the spelling. */
test('the shrinking-core episode plays over an idle circle and schedules the next one', () => {
  const f = mount('idle', true)
  f.c.extras.blowup = true // mount() leaves it off; this episode is a blowup extra
  f.c.nextEpisode = 1.2
  const seen = { collapse: 0, relax: 0, pulses: 0, lit: 0 }
  let plays = 0, firstNext = null
  for (let i = 0; i < 1200; i++) {
    f.step()
    const ep = f.c.episode
    if (ep) {
      if (ep.phase === 'collapse') seen.collapse++
      if (ep.phase === 'relax') seen.relax++
      if (f.c.drive.pulse.some((amp, n) => n % 4 === 2 && amp > 0)) seen.pulses++
      if (f.c.drive.vort[0] > 0) seen.lit++
    }
    if (f.c.played > plays) { plays = f.c.played; if (firstNext === null && plays === 1) firstNext = f.c.nextEpisode }
  }
  assert.ok(plays >= 1, `the episode starts on its own over an idle circle, played ${plays}`)
  assert.ok(seen.collapse > 0, 'the core actually collapses')
  assert.ok(seen.relax > 0, 'and recovers, rather than ending on the collapse')
  assert.ok(seen.pulses > 0, 'the original ring pulses reach the solver -- the owner\'s "pulse again"')
  assert.ok(seen.lit > 0, 'the episode lights its own vorticity')
  // "repeats": finishing one must arm the next, or it plays once per page load.
  assert.ok(f.c.nextEpisode >= 120 && f.c.nextEpisode <= 240,
    `finishing an episode arms the next one from BLOWUP.every, got ${f.c.nextEpisode}`)
})

/* THINKING DRAWS IN ON ITSELF, AND DOES NOT WALK AROUND WHILE IT DOES.
   Recovered from 21506c72: "the blob draws in on itself and holds (the sink
   term, a twentieth of the blowup's strain), rocking gently as it does;
   nothing travels". The owner's steer for this animation is "it can get
   really slow... then pulse again", so the draw-in is the slow half and the
   episode's ring pulses (see the episode test) are the pulse.
   The second assertion is the DELIBERATE NON-RECOVERY and it matters as much
   as the first. The original also walked seat.goal around a small circle
   ("circling on the spot"). That is motion by moving the body, which the
   owner ruled out: "dont animate it just by moving it around make it
   transform and act and be change". It is left out on purpose -- this pins
   that, so nobody restores it later believing it was missed. */
test('thinking draws the body in on a slow beat and never walks it around', () => {
  const f = mount('thinking', true)
  const strain = [], settled = []
  for (let i = 0; i < 400; i++) {
    f.step()
    strain.push(f.c.drive.sink[0])
    /* Measure the beat only AFTER the action ease has finished -- step 60 is
       2 s, well past the 0.8 s ramp. The ramp-in alone spans 0 to full, so a
       flat draw-in with NO beat at all still looked like it was breathing,
       which is how a mutation that removed the beat first passed this test.
       Gated on elapsed steps rather than on drive.formMix, because formMix
       does not stay pinned at 1 for this action and that made the window far
       narrower than it looked. */
    if (i >= 60) settled.push(f.c.drive.sink[0])
    assert.equal(f.c.seat.goal, null, `thinking must not steer the body to a goal (step ${i})`)
  }
  const live = strain.filter(v => v > 0)
  assert.ok(live.length > 300, `the draw-in runs while thinking, got ${live.length} of 400 frames`)
  assert.ok(settled.length > 300, `measured the settled action, got ${settled.length} frames`)
  const top = Math.max(...settled), low = Math.min(...settled)
  assert.ok(top > 0, 'the sink term actually reaches the solver')
  assert.ok(top - low > top * 0.3,
    `the draw-in breathes on its beat rather than holding flat, span ${(top - low).toFixed(5)} of ${top.toFixed(5)}`)
  // A twentieth of the blowup's strain: present, but nothing like an episode.
  assert.ok(top < 0.1, `the draw-in stays gentle beside the episode's collapse, got ${top.toFixed(4)}`)
})

test('an idle rebound yields softly without adding collision energy', () => {
  const f = mount('idle', false)
  pressAgainstWall(f, { vx: .05, vy: 0, speed: .05, face: 0, heading: 0, steerAt: 100 })
  f.step()
  assert.ok(f.c.seat.vx < 0)
  assert.ok(Math.hypot(f.c.seat.vx, f.c.seat.vy) < .05)
  assert.ok(f.c.seat.squash.span >= .6 && f.c.seat.squash.depth < .2)
})

test('the normal face reaches the round rim in every direction without the old inset oval or collision forces', () => {
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
    const f = mount('idle', false)
    for (let i = 0; i < 40; i++) f.step()
    const nx = Math.cos(angle), ny = Math.sin(angle)
    f.c.agent.formTime = .8
    updateBaseCharacter(f.c.agent.character, .8)
    /* Read the contact radius out of the renderer instead of spelling it
       here. This line used to say `.478 - reach`, which pinned the very
       constant that produced the owner's "the edge seems to be pretty far
       from the circle edge": the test reproduced the gap and then asserted
       the body reflected inside it, so it stayed green while the defect was
       on screen. */
    const reach = f.c.bodyReach(nx, ny), radius = f.c.RIM - reach
    assert.ok(radius > .33, 'the body can approach the visible circular rim')
    /* FLUSH, and this is the owner's complaint stated as a number. The inside
       of the frame is UV 0.5 (see RIM in home-circle-fluid.js). bodyReach
       measures to 1.35 sigma; the edge a person sees is about 1.0 sigma, so
       the visible edge sits at radius + reach / 1.35. It must land on the
       frame, not short of it. */
    const visibleEdge = radius + reach / 1.35
    assert.ok(visibleEdge > .49 && visibleEdge < .52,
      `the body's visible edge sits flush to the frame at UV 0.5, got ${visibleEdge.toFixed(4)} at angle ${angle.toFixed(2)}`)
    Object.assign(f.c.seat, { x: .5 + nx * radius, y: .5 + ny * radius, vx: nx * .05, vy: ny * .05,
      face: angle, heading: angle, speed: .05, steerAt: 100, rebound: null, squash: null })
    f.step()
    assert.ok(f.c.seat.vx * nx + f.c.seat.vy * ny < 0, 'outward momentum reflects at this edge')
    assert.ok(Math.hypot(f.c.seat.x - .5, f.c.seat.y - .5) > .33)
    assert.ok(Math.hypot(f.c.seat.x - .5, f.c.seat.y - .5) <= f.c.seat.wallRadius + 1e-6)
    f.step()
    assert.ok(Array.from(f.c.drive.pushX).every((value, index) => index % 4 < 2 || value === 0), 'a normal face collision adds no shearing jets')
  }
})

test('waiting keeps the same eyes, blink, body morph and drift as idle', () => {
  const idle = mount('idle', false), waiting = mount('waiting', false)
  for (let i = 0; i < 600; i++) {
    idle.step(); waiting.step()
    assert.deepEqual(Array.from(waiting.c.agent.character), Array.from(idle.c.agent.character))
    assert.equal(waiting.c.drive.form, idle.c.drive.form)
    assert.equal(waiting.c.seat.x, idle.c.seat.x)
    assert.equal(waiting.c.seat.y, idle.c.seat.y)
  }
})

test('hover and a friendly tap do not turn idle drift into pointer pursuit or a flight', () => {
  const free = mount('idle', true), greeted = mount('idle', true)
  for (const f of [free, greeted]) {
    Object.assign(f.c, { pointer: null, performance: { now: () => 0 }, mood: {}, moodDrive() {}, uvOf: () => ({ x: .6, y: .7 }) })
    vm.runInContext(['personality', 'tap'].map(name => declaredFunctionSource(fluid, name)).join('\n'), f.c)
    for (let i = 0; i < 35; i++) f.step()
  }
  greeted.c.pointer = { x: .2, y: .7, t: 0 }
  greeted.c.tap({})
  let blinked = false
  for (let i = 0; i < 90; i++) {
    free.step(); greeted.step()
    assert.equal(greeted.c.seat.x, free.c.seat.x)
    assert.equal(greeted.c.seat.y, free.c.seat.y)
    assert.equal(greeted.c.seat.goal, null)
    assert.equal(greeted.c.persona.splash || null, null)
    blinked ||= greeted.c.agent.character[1] > .7
  }
  assert.equal(blinked, true)
  assert.equal(greeted.c.episode, null)
})

test('real fluid forms and inertial movement survive the performance fallback', () => {
  for (const action of ['idle', 'thinking', 'reading', 'writing', 'running', 'waiting']) {
    const rich = mount(action, true), lean = mount(action, false)
    for (let frame = 0; frame < 300; frame++) {
      rich.step(); lean.step()
      assert.equal(rich.c.seat.x, lean.c.seat.x, `${action} x at frame ${frame}`)
      assert.equal(rich.c.seat.y, lean.c.seat.y, `${action} y at frame ${frame}`)
      assert.equal(rich.c.drive.form, lean.c.drive.form)
      assert.equal(rich.c.drive.spin, lean.c.drive.spin)
      assert.equal(rich.c.drive.flow, lean.c.drive.flow)
      assert.equal(rich.c.drive.original, lean.c.drive.original)
      assert.ok(Math.hypot(rich.c.seat.x - .5, rich.c.seat.y - .5) <= rich.c.seat.wallRadius + 1e-6)
    }
    assert.ok(rich.c.agent.motion.pattern)
  }
})

test('thinking runs the original cloudy shear-and-turn without starting the agent-change transition', () => {
  const f = mount('thinking', false), frames = []
  // Long enough to reach the reset: the swirl runs thirty seconds.
  for (let i = 0; i < 950; i++) {
    f.step()
    frames.push({ phase: f.c.agent.motion.phase, torque: f.c.drive.torque, original: f.c.drive.original, storm: f.c.storm.level })
    assert.equal(f.c.episode, null)
  }
  assert.ok(frames.some(x => x.original > .99 && x.torque > .4 && x.storm > .8), 'original force routines run automatically without optional extras')
  // Swirls for ten seconds, then resets and holds for about half a second.
  assert.ok(frames.some(x => x.phase === 'pause' && x.original < .1), 'it rests between swirls')
  /* THE SWIRL IS THE LONG PART, and these three probes are the owner's fourth
     report stated as behaviour: it was ten seconds and was reported as too
     short. The hold either side of the reset is unchanged at about half a
     second, because that half second is not what was reported. */
  assert.equal(actionMotion('thinking', 29.9).phase, 'swirl')
  assert.equal(actionMotion('thinking', 30.2).phase, 'pause')
  assert.equal(actionMotion('thinking', 30.6).phase, 'swirl', 'and starts again')
  assert.equal(actionMotion('thinking', 18).phase, 'swirl', 'eighteen seconds in it is still swirling')
  /* AND IT PULSES WHILE IT SWIRLS, which is the other half of the same ask:
     "it can get really slow... then pulse again". A swirl with one kick at the
     top has no `again` in it however long it runs, so the beat is asserted as
     behaviour: the cloud must draw in and push out several times inside one
     swirl, and the mark the renderer fires its burst on must change with it. */
  const beats = new Set(), surges = []
  for (let t = 0; t < 30; t += .25) {
    const m = actionMotion('thinking', t)
    beats.add(m.beat); surges.push(m.surge)
  }
  assert.ok(beats.size >= 4, `the swirl pulses several times before it resets, got ${beats.size} beats`)
  assert.ok(Math.max(...surges) > .95 && Math.min(...surges) < .1, 'each beat runs from a full push to a full settle')
  assert.equal(f.c.played, 0)
  for (const [action, tool] of [['writing', 'Edit'], ['running', 'Bash']]) assert.equal(actionMotion(action, 0, tool).pattern, 'chat-orbit')
  assert.equal(actionMotion('reading', 0, 'Read').pattern, 'eyes', 'reading just floats and blinks')
  assert.equal(actionMotion('writing', 0, 'reply').pattern, 'dots')
  assert.equal(actionMotion('idle').pattern, 'eyes')
  assert.equal(actionMotion('waiting'), actionMotion('idle'), 'waiting uses the identical original character, not a second eye design')
})


/* THE FIVE DOTS, AND WHY THIS TEST NO LONGER COUNTS PIECES.
   This test used to assert `frames.some(x => x.bodies === 5)` -- "all five
   pieces are present while it runs". That sentence is the defect the owner
   reported three separate times: a core with four satellites orbiting it
   reads as five spinning dots, and no amount of re-spacing changes that. The
   assertion was therefore holding the rejected design in place, and the
   quickest route back to green from any real fix was to reinstate it.
   What replaces it asserts the shape the owner asked for instead: the chat
   window's orbit set (.chat-orbit-outer / -inner / -core, and the dasharrays
   in src/chat-presentation.css and src/chat-activity.css) made of the body's
   own water. Two BANDS lying on two circles around the body, turning against
   each other, drawn out of a core that keeps the rest. A band has a radius
   and a thickness and no position on its circle, so no arrangement of
   satellites can satisfy this. The owner's original cadence -- four seconds
   of rotation, then half a second of rest, the two rings against each other,
   breathing in and out -- is still asserted, because none of that was what
   was reported. */
test('tool use is the chat orbit set in water: two counter-turning bands and no ring of dots', () => {
  const f = mount('running', false), frames = []
  for (let i = 0; i < 305; i++) {
    f.step()
    const parts = f.c.agent.parts, pose = Array.from(parts.pose)
    frames.push({ phase: f.c.agent.motion.phase, pose, ring: Array.from(parts.ring), turn: Array.from(parts.turn),
      target: Array.from(parts.target),
      ringSpin: Array.from(parts.ringSpin), spin: Array.from(parts.spin), spread: f.c.agent.motion.spread,
      // Anything off the body's centre that still has two radii of its own
      // would be a satellite. There must never be one.
      satellites: pose.filter((_, j) => j % 4 === 2 && pose[j] > .008 && Math.hypot(pose[j - 2], pose[j - 1]) > .02).length })
    assert.equal(f.c.drive.spin, 0)
    assert.equal(f.c.drive.original, 0)
  }
  assert.ok(frames.every(x => x.satellites === 0), 'no orbiting piece is ever placed off the body centre')
  const open = frames.filter(x => x.turn[3] > .95)
  assert.ok(open.length > 200, `the bands open and stay open, got ${open.length} of ${frames.length}`)
  // Two bands, at the 16:10 radii the chat window draws, each with a real
  // thickness. A zero-thickness band would be a stroke, not material.
  assert.ok(open.every(x => x.ring[0] > x.ring[1] * 1.5 && x.ring[1] > 0), 'an outer and an inner band, not one ring')
  assert.ok(open.every(x => x.ring[2] > .002 && x.ring[3] > .002), 'both bands are material with a thickness')
  for (const x of open) assert.ok(Math.abs(x.ring[1] / x.ring[0] - 10 / 16) < 1e-5, "the two radii keep the chat set's 16:10")
  // The owner: "it could rotate while the blobs go in / out while the center
  // blob spins the opposite way and then pause for a half a second".
  const orbiting = frames.filter(x => x.phase === 'orbit')
  assert.ok(orbiting.some(x => x.ringSpin[0] > 0 && x.ringSpin[1] < 0), 'the two bands turn against each other')
  assert.ok(orbiting.some(x => x.spin[0] < 0), 'and the core turns against the outer band')
  /* THE BREATH, AND WHY IT IS NOT MEASURED AS A RADIAL SWING ANY MORE.
     It was: max(spread) - min(spread) > .03. That passed only while the ring
     moved more than five of its own sigmas across its own track, which is
     exactly what washed the whole set out on the running page -- the ring
     smeared over the band it was supposed to be lying on. The owner's "the
     blobs go in / out" is still here and is still asserted, but as the thing
     it now is: water moving OUT of the core into the rings and back, with the
     rings thickening as it arrives. That is a stronger claim than the old one,
     because it has to conserve the body while it does it (see the conservation
     test), and a ring that merely slid in and out would fail it. */
  const spreads = orbiting.map(x => x.spread)
  assert.ok(Math.max(...spreads) - Math.min(...spreads) > .01, 'the bands still move on their track')
  const fat = orbiting.reduce((a, b) => a.ring[2] > b.ring[2] ? a : b)
  const thin = orbiting.reduce((a, b) => a.ring[2] < b.ring[2] ? a : b)
  assert.ok(fat.ring[2] > thin.ring[2] * 1.15, 'the bands thicken and thin as they breathe')
  assert.ok(fat.pose[2] < thin.pose[2], 'and the core gives up the water the bands gain, in counter-phase')
  /* IT MOVES WATER, IT DOES NOT MAKE IT -- asserted here frame by frame.
     This line used to read "the wider the band, the thinner it is", which was
     true only while the radius was the one thing moving. The breath now moves
     the SHARE as well, so a wider band is also a fuller one and that sentence
     is simply false. What it was standing in for is the invariant underneath
     it, and that is what is checked instead: whatever the breath is doing, the
     two bands hold exactly the material the core gave up, at every frame. */
  const trackLine = readFileSync(new URL('../../src/home-circle-motion.js', import.meta.url), 'utf8').match(/^const TRACK = (\.\d+)$/m)
  assert.ok(trackLine, 'home-circle-motion.js declares TRACK')
  const HELD = duty => Number(trackLine[1]) + (1 - Number(trackLine[1])) * duty
  const holds = x => HELD(8 / 25) * 2 * x.ring[0] * x.ring[2] * Math.sqrt(Math.PI)
    + HELD(12 / 31.4) * 2 * x.ring[1] * x.ring[3] * Math.sqrt(Math.PI)
  for (const x of orbiting) {
    assert.ok(Math.abs(x.target[2] * x.target[3] + holds(x) - .074 ** 2) < 1e-8,
      `the core plus the bands is always the same body: ${x.target[2] * x.target[3] + holds(x)}`)
  }
  assert.ok(Math.max(...orbiting.map(holds)) > Math.min(...orbiting.map(holds)) * 1.1,
    'and the share the bands hold really does move over a breath')
  const paused = frames.filter(x => x.phase === 'pause')
  assert.ok(paused.length > 0 && paused.every(x => x.ringSpin.every(v => Math.abs(v) < 1e-9)), 'the rotation stops dead in the pause')
  // 4 s of turn, then exactly half a second of rest, then round again.
  assert.equal(actionMotion('running', 3.99).phase, 'orbit')
  assert.equal(actionMotion('running', 4.01).phase, 'pause')
  assert.equal(actionMotion('running', 4.49).phase, 'pause')
  assert.equal(actionMotion('running', 4.51).phase, 'orbit')
  // Angles are unwrapped, so the ring does not jump back at the loop join.
  const a = actionMotion('running', 4.0).orbit, b = actionMotion('running', 4.6).orbit
  assert.ok(b >= a, 'the orbit angle stays continuous across the pause')
  f.c.ring.dataset.agentAction = 'writing'
  for (let i = 0; i < 40; i++) f.step()
  assert.equal(f.c.drive.partsMix, 0)
  assert.equal(f.c.drive.form, 3)
  assert.equal(f.c.episode, null)
})

/* The dye shader is the other half of the same answer: the loop that drew the
   five satellites has to be gone from the tool form, not merely fed zeroes. */
test('the tool form in the dye shader is bands, with no five-satellite loop left to feed', () => {
  // Comments quote the loop that was removed, by name, so they are stripped
  // before the code is read -- otherwise this test fails on its own history.
  const code = forms.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const body = code.slice(code.indexOf('if (kind < 4.5)'), code.indexOf('vec2 fluidInk'))
  assert.ok(body.length > 200, 'found the tool branch of fluidForm')
  assert.ok(!/for\s*\(/.test(body), 'the tool form has no loop over pieces at all')
  assert.ok(!/uParts\[[1-4]\]/.test(body), 'and reaches no piece slot but the core it was drawn out of')
  assert.match(body, /orbitBand\(/, 'it is built from bands')
  assert.ok(!/for\s*\(\s*int\s+i\s*=\s*0;\s*i\s*<\s*5;/.test(code),
    'no five-piece loop survives anywhere in the form shader')
  // The arc counts and duty cycles are the chat window's dasharrays, so the
  // two surfaces cannot drift apart silently.
  const chat = readFileSync(new URL('../../src/chat-presentation.css', import.meta.url), 'utf8')
  const activity = readFileSync(new URL('../../src/chat-activity.css', import.meta.url), 'utf8')
  assert.match(activity, /\.chat-orbit-outer\s*\{[^}]*stroke-dasharray:\s*8 17/, 'the working outer ring is still 8 17')
  assert.match(chat, /\.chat-orbit-inner\s*\{[^}]*stroke-dasharray:\s*12 19\.4/, 'the inner ring is still 12 19.4')
  assert.match(body, /8\.0 \/ 25\.0/, 'the outer duty is 8 of the 25-unit dash period')
  assert.match(body, /12\.0 \/ 31\.4/, 'the inner duty is 12 of the 31.4-unit dash period')
})

test('stable agent identity starts Navier-Stokes once, survives changing activity, and returns to the incoming action', () => {
  const f = mount('thinking', false)
  f.c.ring.dataset.agentKey = 'one'; f.step()
  assert.equal(f.c.episode, null, 'initial mount is not an agent switch')
  f.c.ring.dataset.agentKey = 'two'; f.step()
  const transition = f.c.episode
  assert.equal(transition.reason, 'agent-change', 'even equal display names identify distinct agents')
  f.c.ring.dataset.agentAction = 'running'; f.step()
  assert.equal(f.c.episode, transition, 'stream activity does not cancel the transition')
  f.c.ring.dataset.agentName = 'Renamed'; f.c.ring.dataset.agentEvent = 'next'; f.step()
  assert.equal(f.c.episode, transition, 'renames and repeated events do not restart the transition')
  const frames = []
  for (let i = 0; i < 285; i++) {
    f.step()
    frames.push({ episode: f.c.episode && { ...f.c.episode }, strain: f.c.drive.sink[0], pulse: [f.c.drive.pulse[2], f.c.drive.pulse[6]] })
  }
  assert.ok(frames.some(x => x.episode?.tau > .8) && frames.some(x => x.episode?.tau < .1))
  assert.ok(frames.some(x => x.pulse.some(amp => amp > 0)), 'the original ring pulses reach the solver')
  assert.ok(frames.some(x => x.episode?.phase === 'relax'))
  assert.equal(f.c.episode, null)
  assert.equal(f.c.agent.animation, 'chat-orbit')
  assert.equal(f.c.played, 1)
  f.c.ring.dataset.agentKey = 'three'; f.step()
  f.c.ring.dataset.agentKey = 'four'; f.step()
  assert.equal(f.c.agent.key, 'four')
  assert.equal(f.c.played, 3, 'rapid choices follow the latest agent without a stale queue')
})


test('dropping optional extras preserves the character and its phase; idle personality remains reachable', () => {
  const f = mount('running', true)
  for (let i = 0; i < 70; i++) f.step()
  const parts = f.c.agent.parts, pose = Array.from(parts.pose), since = f.c.agent.since
  f.c.dropExtras('test'); f.step()
  assert.equal(f.c.agent.parts, parts, 'buffers are reused without per-frame piece allocation')
  assert.equal(f.c.agent.since, since)
  pose.forEach((value, i) => assert.ok(Math.abs(value - parts.pose[i]) < .03, 'no reset jump'))
  const idle = mount('idle', true); idle.step()
  assert.equal(idle.c.personalityCalls, 1)
})

test('the tool form conserves the body it is drawn out of, at every frame rate', () => {
  /* The old five-piece split conserved area as a sum of discs. The bands
     conserve the same body, but a band lying on a circle holds
     duty * 2 * radius * sigma * sqrt(pi) rather than radius squared, so the
     invariant is restated in the geometry that is actually drawn -- not
     dropped, because "splitting does not manufacture extra material" is the
     property that stops the tool form growing every time it breathes. */
  /* TRACK is read out of the renderer rather than restated here. A band now
     carries the continuous .chat-orbit-track everywhere and the bright dash on
     top of it, so the material it holds follows its ANGULAR AVERAGE, not the
     dash duty -- and a test that restated that constant could drift away from
     the one the product actually draws. */
  const motionSource = readFileSync(new URL('../../src/home-circle-motion.js', import.meta.url), 'utf8')
  const trackLine = motionSource.match(/^const TRACK = (\.\d+)$/m)
  assert.ok(trackLine, 'home-circle-motion.js declares TRACK')
  const TRACK = Number(trackLine[1])
  const held = duty => TRACK + (1 - TRACK) * duty
  const OUTER_DUTY = held(8 / 25), INNER_DUTY = held(12 / 31.4), BODY = .074 ** 2
  const band = (duty, radius, sigma) => duty * 2 * radius * sigma * Math.sqrt(Math.PI)
  for (const fps of [20, 30, 60]) {
    const parts = createBlobParts(), pose = parts.pose, velocity = parts.velocity, ring = parts.ring
    let sawOpen = false
    for (let frame = 0; frame < fps * 20; frame++) {
      const t = frame / fps, motion = actionMotion('running', t)
      updateBlobParts(parts, motion, t, 1 / fps)
      assert.equal(parts.pose, pose); assert.equal(parts.velocity, velocity); assert.equal(parts.ring, ring)
      assert.ok(Array.from(pose).every(Number.isFinite) && Array.from(ring).every(Number.isFinite))
      // Nothing is ever placed off the body's centre: there are no pieces.
      for (let i = 0; i < 5; i++) assert.ok(Math.hypot(parts.target[i * 4], parts.target[i * 4 + 1]) < 1e-9)
      const core = parts.target[2] * parts.target[3]
      const total = core + band(OUTER_DUTY, ring[0], ring[2]) + band(INNER_DUTY, ring[1], ring[3])
      assert.ok(Math.abs(total - BODY) < 1e-8,
        `the split moves the body's water, it does not make more: ${total} vs ${BODY} at ${fps}fps frame ${frame}`)
      if (parts.turn[3] > .95) { sawOpen = true; assert.ok(ring[0] > .1 && ring[2] > .002) }
      // The core springs, so it must stay bounded at any cadence.
      assert.ok(pose[2] < .09 && pose[3] < .09)
    }
    assert.ok(sawOpen, `the bands opened at ${fps}fps`)
  }
  // And the thinking gather still conserves its own three pieces.
  const parts = createBlobParts()
  for (let frame = 0; frame < 300; frame++) {
    const t = frame / 30, motion = actionMotion('thinking', t)
    updateBlobParts(parts, motion, t, 1 / 30)
    let area = 0
    for (let i = 0; i < 5; i++) area += parts.target[i * 4 + 2] * parts.target[i * 4 + 3]
    const radius = .074 * (1 - .32 * motion.gather)
    assert.ok(Math.abs(area - radius * radius) < 1e-8, 'the thinking gather conserves its material too')
    assert.equal(parts.target[16], 0, 'and never reaches a fifth piece')
    assert.equal(parts.target[18], 0)
  }
})


/* ITEMS 2 AND 3 OF THE SAME REPORT, AND THEY ARE ONE MECHANISM.
   The owner asked for two things that a single scalar answers: the body
   should normally have substance and a defined edge and only go whispy
   sometimes, and its weight should shift ACROSS the morph -- heavy water
   draining continuously to mist -- rather than switching between two
   presets. material.mass is that scalar. It is spent in the solve first
   (dye retention, drag, cohesion, curl) and only then on how wide the edge
   is allowed to be, which is why this test reads the drive and the solver
   inputs rather than an opacity. */
/* The two weight properties as pure checks over a per-frame series, so the
   mutation tests below can hand them a series built to break each one. */
export function assertWeightContinuous(seen, { maxStep = .2 } = {}) {
  let worst = 0
  for (let i = 1; i < seen.length; i++) worst = Math.max(worst, Math.abs(seen[i] - seen[i - 1]))
  assert.ok(worst <= maxStep, `weight never teleports between frames, worst step ${worst} (max ${maxStep})`)
  assert.ok(seen.some(m => m >= .25 && m < .5) && seen.some(m => m >= .5 && m < .75),
    'it passes through both quarters of the middle of its range rather than skipping over them')
}
/* Time to half, from the frame the movement BEGINS. */
export function halfTimeFrom(series, { start, end }) {
  const travel = end - start
  const onset = series.findIndex(m => Math.abs(m - start) > Math.abs(travel) * .02)
  if (onset < 0) return { onset: -1, half: -1, frames: Infinity }
  const half = series.findIndex((m, i) => i >= onset && Math.abs(m - start) >= Math.abs(travel) * .5)
  return { onset, half, frames: half < 0 ? Infinity : half - onset }
}
export function assertDrainQuickerThanGather(drain, gather) {
  const d = halfTimeFrom(drain, { start: drain[0], end: Math.min(...drain) })
  const g = halfTimeFrom(gather, { start: gather[0], end: gather.at(-1) })
  assert.ok(d.frames < g.frames,
    `letting go of weight is quicker than taking it back, on equal starts: drain ${d.frames} frames from its onset to half, gather ${g.frames}`)
}

test('the continuity check rejects a weight that teleports, and accepts one that drains fast but smoothly', () => {
  /* A switch: heavy water one frame, mist the next. */
  const stepped = [...Array(30).fill(1), ...Array(30).fill(0)]
  assert.throws(() => assertWeightContinuous(stepped), /teleports/)
  /* Skipping the middle (the step cap lifted so the visit check is the one
     deciding): under the cap a hop from above 0.5 always lands in the lower
     quarter, so the two checks are one property seen from two sides. */
  const skipping = [1, .9, .8, .78, .76, .2, .1, 0, 0, 0]
  assert.throws(() => assertWeightContinuous(skipping, { maxStep: 1 }), /middle of its range/)
  /* The fastest constant the body lane names, 0.35 s at 30 fps: exponential
     drain, per-frame step 0.095 at most, every quarter visited. */
  const fast = []; let m = 1
  for (let i = 0; i < 90; i++) { fast.push(m); m -= m * (1 / 30) / .35 }
  assertWeightContinuous(fast)
})

test('the equal-start comparison rejects a gather that is quicker than the drain, whatever ramp precedes the drain', () => {
  const decay = (tau, n, from, to) => { const out = []; let m = from; for (let i = 0; i < n; i++) { out.push(m); m += (to - m) * (1 / 30) / tau } return out }
  /* A 0.4 s ramp before the drain begins must not count against the drain. */
  const drain = [...Array(12).fill(1), ...decay(.35, 90, 1, 0)]
  assertDrainQuickerThanGather(drain, decay(.45, 90, 0, 1))
  assert.throws(() => assertDrainQuickerThanGather(drain, decay(.2, 90, 0, 1)), /quicker than taking it back/)
})

test('the body carries weight that drains and gathers continuously, never in a step', () => {
  const f = mount('thinking', false), seen = []
  for (let i = 0; i < 900; i++) { f.step(); seen.push(f.c.material.mass) }
  assert.ok(seen[0] > .9, 'it starts as heavy water')
  assert.ok(Math.min(...seen) < .1, 'and drains to mist while it thinks')
  /* CONTINUOUS, not SLOW. This used to demand the drain spend more than 25
     frames between 0.25 and 0.75 and a per-frame step under 0.04 -- two speed
     pins dressed as a smoothness check, which together forced a drain
     constant of at least 0.76 s and held the character sluggish on every
     state change (body lane, 2026-09-18: the fastest the suite allowed was
     body visible 1.62 s after a switch). The property that matters is that
     the weight never TELEPORTS: no single frame moves it by more than a fifth
     of its range (a switch moves it by the whole range; the fastest constant
     the lane names, 0.35 s, moves it 0.095 per frame at 30 fps), and the
     middle of the range is VISITED on the way -- both quarters of it -- rather
     than lingered in. */
  assertWeightContinuous(seen)

  // It lets weight go faster than it takes it back, which is what reads as
  // mass rather than a crossfade. Both halves are measured ON EQUAL STARTS:
  // the drain is timed from the frame it actually begins (the thinking swirl
  // ramps for 0.4 s before the water lets go, and that ramp is not draining),
  // the gather from the frame it begins at zero.
  const idle = mount('idle', false)
  idle.c.material.mass = 0
  const gathering = []
  for (let i = 0; i < 300; i++) { idle.step(); gathering.push(idle.c.material.mass) }
  assert.ok(gathering.at(-1) > .75, 'an idle body settles back to heavy water')
  assertDrainQuickerThanGather(seen, gathering)

  // Every form declares its own weight and the renderer blends it like any
  // other material property, so the morph carries it.
  assert.ok(actionMotion('idle').wisp < actionMotion('writing').wisp, 'the settled character is the heaviest thing it becomes')
  assert.ok(actionMotion('thinking', 6).wisp > .9, 'the thinking swirl is all but mist')
  assert.ok(actionMotion('running', 4).wisp > actionMotion('idle').wisp, 'bands of water weigh less than one body')
  assert.ok(actionMotion('running', 4).wisp < .6, 'but the tool form is still water, not fog')
})

test('the edge is narrow when the body has substance and opens only as it drains', () => {
  /* The display law, read out of the renderer. The old shader had ONE band,
     `smoothstep(0.08, 0.65, amount)`: 0.57 of the body's own ink wide, at
     every moment, which is the "too soft all the time" the owner reported.
     It is now two declared ends interpolated on the drained scalar. */
  const code = fluid.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  /* Anchored on the display: [ array, not on a declaration ORDER -- see the
     storm test above, where that anchor put uFast one line outside the slice. */
  const display = code.slice(code.indexOf('display: ['), code.indexOf('function compile'))
  assert.ok(!/smoothstep\(\s*0\.08\s*,\s*0\.65/.test(display), 'the one fixed soft ramp is gone from the shader')
  assert.match(display, /smoothstep\(\s*uEdge\.x\s*-\s*uEdge\.y\s*,\s*uEdge\.x\s*\+\s*uEdge\.y/, 'the edge is a declared band')

  const f = mount('idle', false)
  const edgeFor = mass => {
    const wisp = 1 - mass
    return { at: f.c.TUNE.edge - (f.c.TUNE.edge - f.c.TUNE.edgeWispy) * wisp,
      band: f.c.TUNE.edgeBand + (f.c.TUNE.edgeBandWispy - f.c.TUNE.edgeBand) * wisp,
      curve: 1 + (f.c.TUNE.curve - 1) * wisp }
  }
  const heavy = edgeFor(1), thin = edgeFor(0), half = edgeFor(.5)
  assert.ok(heavy.band * 2 < .2, `a body with substance ends over a narrow band of its own ink, got ${heavy.band * 2}`)
  assert.ok(thin.band > heavy.band * 3, 'and the whispy end is much softer')
  assert.ok(half.band > heavy.band && half.band < thin.band, 'every value in between is reachable')
  assert.equal(heavy.curve, 1, 'a settled body is opaque inside its edge')
  assert.ok(thin.curve > 1.4, 'a whispy one keeps the old falloff')
  /* The legacy band, restated so a silent return to it is visible here.
     PROMPT A: this read `thin.at + thin.band >= .5` against a value that
     computes to exactly 0.5, so it was decided by the last bit of a float --
     it passed on `0.4 - 0.32` and failed on `0.507 - 0.427`, which is the same
     number twice. Stated as the property instead: the whispy end is at least
     as soft as the fixed ramp it replaced, and opens no later. */
  const LEGACY_LOW = .08, LEGACY_HIGH = .65
  assert.ok(thin.band * 2 >= LEGACY_HIGH - LEGACY_LOW - 1e-9,
    `the whispy end is at least as soft as the old fixed ${LEGACY_LOW}..${LEGACY_HIGH} ramp, got a band of ${thin.band * 2}`)
  assert.ok(thin.at - thin.band <= LEGACY_LOW + 1e-9, 'and begins no later than that ramp did')
})

/* Hue as an angle, rounded, so "the ledger owns the colour" is checkable
   without pinning any particular arithmetic for getting there. */
function hueOf([r, g, b]) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo
  if (d < 1e-9) return -1
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4
  return Math.round(h * 60 * 100) / 100
}

/* A CIRCLE THAT IS RUNNING HAS TO BECOME VISIBLE, and this is the regression
   the owner reported twice: an empty ring with a perfectly healthy renderer
   behind it. `.home-circle-fluid` is opacity 0 until reveal() adds `.is-live`,
   and reveal() was reachable only from the `!verdict.slow` branch of judge().
   A machine judged slow on every window therefore never revealed the circle --
   and worse, `!shown` forced a degrade each time, so it walked down the ladder
   and called fail() without ever having shown anything.
   This drives judge() with nothing but slow verdicts and asserts the circle is
   revealed anyway, and that degrading still happens. */
test('a circle judged slow on every window is still revealed, and still degrades', () => {
  const source = ['judge', 'degrade', 'reveal'].map(name => declaredFunctionSource(fluid, name)).join('\n')
  for (const severity of [{ slow: true, severe: false }, { slow: true, severe: true }]) {
    const revealed = [], failed = [], allocated = []
    const c = vm.createContext({
      warm: 0, intervals: [], works: [], probes: [], WINDOW: 2, strikes: 0, WARMUP: 0, lastStep: 0,
      shown: false, extrasOn: false, level: 4, LADDER: [{}, {}, {}, {}, {}, {}, {}],
      stats: { changes: [], level: 4 }, clock: 0, moment: {},
      canvas: { classList: { add(name) { revealed.push(name) } } },
      visual: { setAttribute() {} },
      performance: { now: () => 0 },
      Math,
      fluidWindowVerdict: () => ({ medianMs: 99, workMs: 99, fullMs: 99, ...severity }),
      allocate: () => allocated.push(true),
      fail: reason => failed.push(reason),
      dropExtras: () => {},
      burst: () => {},
    })
    vm.runInContext(source, c)
    // Two completed windows' worth of slow frames, and nothing else.
    for (let i = 0; i < 4; i++) c.judge(99, 99, 8, 99)
    assert.ok(revealed.includes('is-live'),
      `a slow but running circle is still shown to the person (severe: ${severity.severe})`)
    assert.ok(allocated.length > 0 || failed.length > 0,
      'and slowness still moves it down the ladder rather than being ignored')
  }
})

test('fluid palettes keep the status hue without white lifting in either theme', () => {
  for (const background of [[.96, .97, .98, 1], [.09, .11, .13, 1]]) {
    for (const status of [[.05, .52, .72, 1], [.36, .82, .64, 1], [.71, .35, .36, 1]]) {
      const ring = {}, body = {}, root = {}
      const c = vm.createContext({
        ring, root, document: { body }, palette: {}, paletteDirty: true,
        rgba: value => value === 'status' ? status : background,
        glowValue: () => 1,
        getComputedStyle: el => ({ backgroundColor: 'background', getPropertyValue: key => el === ring && key === '--core-status-color' ? 'status' : '.75' }),
      })
      /* ungilded and its helpers are pulled in because readPalette calls it to
         de-gild the storm stops. It went callerless when the curl-lit storm
         colour was removed, so this harness had stopped needing it.
         PROMPT F: lifted and TUNE join them, because readPalette derives the
         second dye's coefficient by turning the deep stop's hue. */
      c.TUNE = readTune()
      vm.runInContext(['hue', 'mixed', 'ungilded', 'lifted', 'luminance', 'chroma', 'readPalette'].map(name => declaredFunctionSource(fluid, name)).join('\n'), c)
      c.readPalette()
      /* WHAT "WITHOUT WHITE LIFTING" ACTUALLY MEANS, and this block used to
         state it as something much narrower. It asserted every stop was a
         SCALAR MULTIPLE of the status colour -- `channel * factor`, factor at
         most 1 -- which is one particular way to avoid washing out, not the
         property itself. It therefore also forbade separating the two stops in
         chroma, and separating them in chroma is what stops a darkened colour
         going muddy. The body rendered as one flat value partly because of it.
         The property is: the hue does not move, and the colour does not lose
         saturation. Enriching is allowed; washing toward white is not. That is
         strictly harder to satisfy than the old rule in the direction that
         matters, because a scalar multiple of a colour DOES lose perceived
         chroma as it darkens and this does not let it. */
      const sat = ([r, g, b]) => {
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b)
        return hi <= 0 ? 0 : (hi - lo) / hi
      }
      for (const key of ['light', 'deep', 'fast', 'slow']) {
        const colour = Array.from(c.palette[key])
        assert.ok(colour.every(channel => channel >= 0 && channel <= 1 + 1e-9), `${key} stays in range`)
        assert.ok(sat(colour) >= sat(status.slice(0, 3)) - 1e-6,
          `${key} does not wash out toward white: saturation ${sat(colour)} against ${sat(status.slice(0, 3))}`)
        assert.equal(hueOf(colour), hueOf(status.slice(0, 3)), `${key} keeps the ledger's hue`)
      }
      const light = Array.from(c.palette.light), deep = Array.from(c.palette.deep)
      const lum = ([r, g, b]) => .2126 * r + .7152 * g + .0722 * b
      assert.ok(lum(deep) < lum(light) * .75, 'the two stops are far enough apart to read as a gradient across the body')
    }
  }
})

test('a collision reflects momentum and creates a squash without teleporting to an action target', () => {
  const f = mount('writing', true)
  const placed = pressAgainstWall(f, { vx: .2, vy: 0, speed: .2, face: 0, heading: 0, steerAt: 100 })
  f.step()
  assert.ok(f.c.seat.vx < 0, 'the wall reflects the outward velocity')
  assert.ok(f.c.seat.squash, 'the rebound compresses the same fluid form')
  assert.ok(Math.abs(f.c.seat.x - placed) < .02, 'no prescribed-path jump')
  assert.equal(f.c.agent.motion.pattern, 'dots')
})

test('an action change clears gestures and restarts its phase; repeated tool events preserve the pattern', () => {
  const f = mount('reading', true)
  for (let i = 0; i < 30; i++) f.step()
  const staleGesture = { span: 20 }
  f.c.persona.split = staleGesture; f.c.seat.goal = { x: .2, y: .2 }; f.c.episode = { phase: 'collapse' }
  f.c.ring.dataset.agentAction = 'thinking'
  f.step()
  assert.equal(f.c.agent.motion.pattern, 'cloudy-thinking')
  assert.notEqual(f.c.persona.split, staleGesture)
  assert.equal(f.c.seat.goal, null)
  assert.equal(f.c.episode, null)
  const since = f.c.agent.since
  f.c.ring.dataset.agentEvent = '1'
  f.step()
  assert.equal(f.c.agent.since, since)
  assert.equal(f.c.agent.motion.pattern, 'cloudy-thinking')
  f.c.ring.dataset.agentAction = 'writing'; f.c.ring.dataset.agentTool = 'Edit'; f.step()
  assert.equal(f.c.agent.motion.pattern, 'chat-orbit')
  f.c.ring.dataset.agentTool = 'reply'; f.step()
  assert.equal(f.c.agent.motion.pattern, 'dots')
  assert.equal(f.c.agent.previous.form, 4)
  assert.equal(f.c.drive.formMix, 0, 'the new form begins with a blend, not a hard switch')
})

test('the real Home painter follows displayed record order after insertions and filters', () => {
  const row = (name, status = 'finished') => ({ agentKey: name, agentName: name, inScope: true, el: { hidden: false, dataset: { status }, toggleAttribute(key, value) { this[key] = value } } })
  const older = row('older'), newest = row('newest'), middle = row('middle', 'attention')
  const c = vm.createContext({
    state: { sessions: { runs: [{ sequence: 3 }, { sequence: 2 }, { sequence: 1 }] } },
    runRows: new Map([[1, older], [2, middle], [3, newest]]), agentFilter: '', sample: false,
    /* The circle follows the first row the CHOICE keeps, and the choice is
       resolved to one predicate before the paint runs (views/home.js
       resolveChoice). With no selection that predicate keeps everything, which
       is what these order assertions are about. */
    keepForChoice: () => true,
    followedRow, actionForLive, actionLabel, sampleAction,
    ring: { el: { dataset: {} } }, agentLine: { children: [{ textContent: '' }, { textContent: '' }] },
  })
  vm.runInContext(declaredFunctionSource(home, 'paintCircleAction'), c)
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, 'newest', 'map insertion order must not choose the oldest row')
  assert.equal(c.ring.el.dataset.agentKey, 'newest')
  assert.equal(c.agentLine.hidden, false, 'a finished run still identifies the followed agent')
  newest.liveRecord = { kind: 'text', working: true, tool: 'Edit' }
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentTool, 'reply', 'a prior tool name must not make a text reply look like tool use')
  assert.equal(c.agentLine.children[1].textContent, 'writing its reply')
  newest.el.hidden = true
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, 'middle', 'the top remaining visible record is followed')
  assert.equal(c.ring.el.dataset.agentAction, 'waiting')
  middle.el.hidden = true; older.el.hidden = true
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, '')
  assert.equal(c.ring.el.dataset.agentKey, '')
})

/* T259 ITEM (5) -- SIMPLE NEVER MOUNTS A SIMULATION, AND NOTHING CHECKED IT.
   The Simple scheme is the earlier cheap renderer: a still SVG rim and three
   static crescents, no canvas and no solve. src/views/home.js carries that
   claim as a comment -- "Simple never mounts a simulation. Switching to it
   releases the canvas, GPU context, animation loop and listeners immediately"
   -- and the whole low-CPU case rests on it, but the only thing enforcing it
   was mountHomeCircleFluid's own first line. Measured on the real page, the
   claim is currently true: warm paper, 30-second windows, Standard spends
   3107-3666 ms of renderer CPU with a live WebGL context and 900 solve steps,
   Simple spends 2258-2519 ms with no canvas at all, and script time falls from
   944-1380 ms to 162-274 ms. Nothing stops a later edit from mounting anyway.

   WHY THIS IS NOT A UNIT TEST OF THE OBVIOUS KIND, and the trap is worth
   naming because this lane keeps finding guards whose precondition is never
   true. mountHomeCircleFluid refuses a ring that is not switched on, but it
   ALSO refuses when there is no window, no rAF, no MutationObserver and so on
   -- and under `node --test` none of those exist. So a test that simply calls
   it in bare node and finds nothing mounted proves nothing at all: it would
   pass just as happily with the data-fluid check deleted. The browser pieces
   are therefore supplied, so that the ONLY thing separating the two cases is
   the switch, and the ON case is required to get past it. */
test('Simple never mounts a simulation, and Standard does get past the switch', () => {
  const saved = { window: globalThis.window, document: globalThis.document }
  /* The smallest stand-in that satisfies every precondition EXCEPT the switch.
     Nothing here has to work -- the ON case is proved by the mount reaching
     into the ring, which is the first thing it does after the guard. */
  const reached = Symbol('the mount reached the ring')
  globalThis.window = {
    requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe () {} disconnect () {} },
    IntersectionObserver: class { observe () {} disconnect () {} },
  }
  globalThis.document = { body: { classList: { contains: () => false } }, documentElement: {} }
  const ringFor = fluidFlag => ({
    dataset: { fluid: fluidFlag },
    querySelector () { throw reached },
  })
  try {
    // OFF: the Simple scheme's ring. Nothing is touched and an inert handle
    // comes back, which home.js can still call destroy() on.
    let off = null
    assert.doesNotThrow(() => { off = mountHomeCircleFluid(ringFor('off')) },
      'the fluid refuses a ring that is not switched on without touching it')
    assert.equal(typeof off.destroy, 'function', 'and it still answers destroy(), so the caller needs no special case')
    assert.doesNotThrow(() => mountHomeCircleFluid(ringFor(undefined)),
      'and a ring with no switch at all is refused the same way')

    /* ON: the same stand-in with the same everything, one attribute different,
       must get PAST the guard. Without this half the test above passes against
       a renderer that refuses every ring, including Standard's. */
    let got = null
    try { mountHomeCircleFluid(ringFor('on')) } catch (error) { got = error }
    assert.ok(got === reached,
      `with the switch on, the mount reaches the ring; got ${String(got && got.message || got)}`)
  } finally {
    globalThis.window = saved.window
    globalThis.document = saved.document
  }
})
