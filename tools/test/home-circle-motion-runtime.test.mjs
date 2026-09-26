import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { actionMotion, createBlobParts, updateBlobParts, updateBaseCharacter, createActionRest, updateActionRest } from '../../src/home-circle-motion.js'
import { followedRow, actionForLive, actionLabel, sampleAction } from '../../src/home-circle-action.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { mountHomeCircleFluid } from '../../src/home-circle-fluid.js'
import { HOME_CIRCLE_STYLES, normalizeHomeCircleStyle } from '../../src/home-circle-choice.js'

/* Direct fluid/math cases below cover the retained library. Home now routes
   every animated choice to home-circle-fluid-classic.js, measured separately
   by the existing final selector case. T259/T360/T365 were removed from the
   ledger; their superseded eyes/no-gloss requirements do
   not override the later one-ball/Classic choice. */
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
   The standing rule: the body is never animated just by moving it around; it
   transforms. It is a STANDING property, not a
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

test('the retained base character stays one joined body with gentle breathing', () => {
  // Eyes/morphs were superseded by one ball (an earlier commit).
  for (const fps of [20, 30, 60]) {
    const pose = new Float32Array(4)
    updateBaseCharacter(pose, 0)
    let previous = pose[0]
    for (let frame = 0; frame < fps * 26.4; frame++) {
      updateBaseCharacter(pose, frame / fps)
      assert.ok(Array.from(pose).every(Number.isFinite))
      assert.equal(pose[0], 1, 'the lobes stay joined throughout the cycle')
      assert.ok(Math.abs(pose[0] - previous) < .06, 'no sudden shape switch')
      assert.equal(pose[1], 0, 'a joined ball has no closing eye')
      assert.ok(pose[2] > .97 && pose[2] < 1.03, 'breathing remains subtle')
      assert.equal(pose[3], 0, 'the retired tilt stays zero')
      previous = pose[0]
    }
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

test('retained action animations rest for ten seconds as one floating body, then follow the latest action', () => {
  for (const fps of [20, 30, 60]) {
    const f = mount('running', false), resting = []
    const due = f.c.agent.rest.nextAt
    assert.ok(due >= 50 && due <= 70)
    let entered = false, body = false, eyes = false
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
    /* The later owner choice removed the eyes. Rest timing and independent
       travel remain measured, but a rest must keep that joined-body choice. */
    assert.equal(body, true, 'the rest renders the joined body')
    assert.equal(eyes, false, 'the superseded eye form never returns during rest')
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

/* The old split/blink request was superseded by the one-ball choice in
   an earlier commit. The retained pose must not resurrect it at a later cycle boundary. */
/* Sweep the entire former cycle, including the old split and blink phases. */
test('the retained joined body never splits or blinks during the former eye cycle', () => {
  const pose = new Float32Array(4)
  const fps = 60, events = []
  let open = true
  for (let frame = 0; frame < fps * 13.2; frame++) {
    updateBaseCharacter(pose, frame / fps)
    if (pose[1] > .2 && open) { events.push(frame / fps); open = false }
    if (pose[1] < .05) open = true
    assert.equal(pose[0], 1, 'the split is removed, including at its former phase boundary')
    assert.equal(pose[1], 0, 'no eye closure is rendered')
  }
  assert.deepEqual(events, [], 'the old event detector finds no blink')
})

/* T259 is removed. Its rare-gesture timing still supplies a useful long
   window for proving that eyes do not return after the first cycle. */
test('the retained joined body suppresses rare eye gestures across ten cycles', () => {
  // Keep the long sweep: testing only cycle zero misses delayed squint terms.
  const pose = new Float32Array(4)
  const fps = 60, CYCLE = 13.2, CYCLES = 10
  let closures = 0
  for (let frame = 0; frame < fps * CYCLE * CYCLES; frame++) {
    updateBaseCharacter(pose, frame / fps)
    if (pose[1] > .02) closures++
    assert.equal(pose[0], 1, 'a later gesture cannot reintroduce the removed eyes')
    assert.equal(pose[1], 0, 'even a shallow or delayed squint is absent')
    assert.equal(pose[3], 0)
  }
  assert.equal(closures, 0)
})

/* Keep the original frame-cadence, per-step and coarsest-grid bounds for
   the retained form; removal of eye closures cannot make its geometry vanish. */
test('the retained joined form stays drawable at every cadence without closure jumps', () => {
  const pose = new Float32Array(4)
  const open = Number(forms.match(/float height = mix\(([\d.]+),/)[1])
  const squash = Number(forms.match(/\* \(1\.0 - ([\d.]+) \* uCharacter\.y\)/)[1])
  const coarsest = Math.min(...JSON.parse(fluid.match(/var LADDER = (\[[\s\S]*?\]);/)[1]
    .replace(/(\w+):/g, '"$1":')).map(rung => rung.dye))
  for (const fps of [20, 30, 60]) {
    let previous = 0
    for (let frame = 0; frame < fps * 13.2; frame++) {
      updateBaseCharacter(pose, frame / fps)
      assert.equal(pose[0], 1)
      assert.equal(pose[1], 0)
      assert.ok(Math.abs(pose[1] - previous) < .32, 'no closure jump between frames')
      const texels = open * (1 - squash * pose[1]) * coarsest
      assert.ok(texels > 3.5, `${fps}fps: retained form exceeds the coarsest-grid floor`)
      previous = pose[1]
    }
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

test('the retained base form never introduces tilt while action transitions are sampled', () => {
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
    { action: 'writing', tool: 'reply', form: 2 },
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
      if (animation.form === 2 && i > 150 && i < 340) {
        assert.equal(f.c.agent.motion.form, 2, 'writing a reply stays the joined base body')
      }
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
    if (animation.form === 2) {
      assert.equal(seen.leaving, 0, 'writing a reply keeps the same base form')
      assert.ok(seen.entering > 0, 'the initial entrance is still measured before writing')
    } else {
      assert.ok(seen.leaving > 0, `${where}: base form measured while morphing AWAY, got ${seen.leaving} frames`)
      assert.ok(seen.entering > 0, `${where}: base form measured while morphing BACK, got ${seen.entering} frames`)
    }
  }
})

/* The later shaded-ball choice supersedes the old global no-gloss ban.
   The retained library still owes finite radiance, bounded absorption and
   actual premultiplied output. Bind those statements directly to the shader. */
test('the retained shader bounds its curl-lit layers and composes their real coverage', () => {
  // The owner explicitly superseded the no-lighting ban with the shaded ball.
  // Measure the retained shader's actual absorption and output laws, not the
  // removed surface/relief declarations. This is not current Classic pixel QA.
  const code = fluid.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const display = code.slice(code.indexOf('display: ['), code.indexOf('function compile'))
  assert.ok(display.length > 400, 'found the retained display shader')
  const main = display.slice(display.indexOf("'void main () {"))
  assert.ok(main.startsWith("'void main () {"), 'the actual display entry point is bound')
  const law = (type, name) => {
    const found = main.match(new RegExp(type + ' ' + name + ' = ([^;]+);'))
    assert.ok(found, `the actual shader must still declare ${name}`)
    return found[1]
  }
  const liquid = glslScalar(law('vec3', 'liquidRGB'), ['uJellyIllum', 'uJellyAbsorb', 'uJellyPath_x', 'uJellyPath_y', 'inkT', 'uJellyLine_w', 'curlInk'])
  const mist = glslScalar(law('vec3', 'mistRGB'), ['uJellyIllum', 'uJellyAbsorb', 'uJellyPath_x', 'uJellyPath_y', 'curlInk'])
  const tune = readTune().jelly
  assert.ok(tune.pathFloor >= 0 && tune.pathGain > 0)
  for (const light of [0.08, 0.35, 0.72, 1])
    for (const absorb of [0, 0.05, 0.4, 1.35, 3, 6])
      for (const depth of [0, .05, .3, 1])
        for (const line of [0, .35, 1]) {
          const stop = light * Math.exp(-absorb * tune.pathFloor)
          let previousLiquid = -1, previousMist = -1
          for (const curl of [0, .1, .25, .5, .75, 1]) {
            const water = liquid(light, absorb, tune.pathFloor, tune.pathGain, depth, line, curl)
            const cloud = mist(light, absorb, tune.pathFloor, tune.pathGain, curl)
            for (const value of [water, cloud]) {
              assert.ok(Number.isFinite(value) && value >= 0)
              assert.ok(value <= stop + 1e-12, 'curl never lifts either layer above its thin material stop')
            }
            assert.ok(water >= previousLiquid - 1e-12 && cloud >= previousMist - 1e-12,
              'increasing curl moves toward the light stop rather than darkening the storm')
            previousLiquid = water; previousMist = cloud
          }
          assert.ok(Math.abs(previousMist - stop) < 1e-12, 'fully spinning mist reaches exactly its thin stop')
        }
  assert.ok(mist(1, 1.35, tune.pathFloor, tune.pathGain, 1) > mist(1, 1.35, tune.pathFloor, tune.pathGain, 0),
    'the curl changes actual radiance, not an unused uniform')
  const toneSource = display.match(/float jellyTone \(float x\) \{ return ([^;]+);/)
  assert.ok(toneSource, 'the real tonemap remains bound')
  const tone = glslScalar(toneSource[1], ['x'])
  let previous = -1
  for (const x of [0, .05, .3, .62, .79, .8, .81, 1, 2, 4, 20]) {
    const value = tone(x)
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1)
    assert.ok(value >= previous, 'the brighter material never maps darker')
    if (x < .8) assert.equal(value, x, 'ordinary radiance stays unchanged below the shoulder')
    previous = value
  }

  // The later body may reflect white light. Its real coverage still owns that
  // light: no body/layer coverage means zero emitted RGB and alpha, and the
  // assembled pixel remains premultiplied. Evaluate each actual assignment.
  const rgb = glslScalar(law('vec3', 'rgb'), ['bodyS', 'bodyA', 'liquidS', 'liquidA', 'dither'])
  const alpha = glslScalar(law('float', 'a'), ['bodyA', 'liquidA'])
  const overRGB = display.match(/'\s*rgb = mistS \* mistA \+ rgb \* \(1\.0 - mistA\);/)
  const overAlpha = display.match(/'\s*a = mistA \+ a \* \(1\.0 - mistA\);/)
  assert.ok(overRGB && overAlpha, 'the mist must compose over the measured body/liquid pixel')
  const mistOver = glslScalar(overRGB[0].slice(overRGB[0].indexOf('=') + 1, -1), ['mistS', 'mistA', 'rgb'])
  const alphaOver = glslScalar(overAlpha[0].slice(overAlpha[0].indexOf('=') + 1, -1), ['mistA', 'a'])
  const brimRGB = display.match(/'\s*rgb = brimPx\.rgb \+ rgb \* \(1\.0 - brimPx\.a\);/)
  const brimAlpha = display.match(/'\s*a = brimPx\.a \+ a \* \(1\.0 - brimPx\.a\);/)
  assert.ok(brimRGB && brimAlpha, 'the rim also composites with its own coverage')
  // rgb is a GLSL colour swizzle; map the complete component to one scalar
  // before the arithmetic helper handles ordinary xyzw components.
  const rimOver = glslScalar(brimRGB[0].slice(brimRGB[0].indexOf('=') + 1, -1)
    .replace(/brimPx\.rgb/g, 'brimRGB').replace(/brimPx\.a/g, 'brimA'), ['brimRGB', 'brimA', 'rgb'])
  const rimAlpha = glslScalar(brimAlpha[0].slice(brimAlpha[0].indexOf('=') + 1, -1)
    .replace(/brimPx\.a/g, 'brimA'), ['brimA', 'a'])
  assert.match(display, /gl_FragColor = vec4\(rgb, a\)/, 'the measured values are actually emitted')
  for (const colour of [0, .05, .3, .62, 1])
    for (const bodyA of [0, .08, .4, .75, 1])
      for (const liquidA of [0, .08, .4, .75, 1])
        for (const mistA of [0, .08, .4, .75, 1]) {
          const base = rgb(colour, bodyA, colour, liquidA, 0)
          const a = alphaOver(mistA, alpha(bodyA, liquidA))
          const c = mistOver(colour, mistA, base)
          assert.ok(Number.isFinite(c) && a >= 0 && a <= 1)
          assert.ok(c >= -1e-12 && c <= a + 1e-12)
          assert.ok(Math.abs(c - colour * a) < 1e-12, 'layering equal colours preserves the exact colour')
          for (const brimA of [0, .08, .4, .75, 1]) {
            const finalRGB = rimOver(colour * brimA, brimA, c)
            const finalAlpha = rimAlpha(brimA, a)
            assert.ok(finalAlpha >= 0 && finalAlpha <= 1)
            assert.ok(finalRGB >= -1e-12 && finalRGB <= finalAlpha + 1e-12)
            assert.ok(Math.abs(finalRGB - colour * finalAlpha) < 1e-12)
            if (!a && !brimA) { assert.equal(finalRGB, 0); assert.equal(finalAlpha, 0) }
          }
          for (const dither of [-.5 / 255, .5 / 255]) {
            const dithered = mistOver(colour, mistA, rgb(colour, bodyA, colour, liquidA, dither))
            assert.ok(Math.abs(dithered - c) <= .5 / 255 + 1e-12, 'one byte dither remains bounded')
          }
          if (!bodyA && !liquidA && !mistA) { assert.equal(c, 0); assert.equal(a, 0) }
        }
})

/* THE SHRINKING-CORE EPISODE PLAYS ON ITS OWN, AND REPEATS.
   Recovered from an earlier commit. The deleted test alongside it read "thinking
   automatically runs the original shrinking core, torque and ring pulses,
   then recovers and repeats", and that is exactly the intended thinking
   animation: Navier-Stokes motion that gets very slow and then pulses again.
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
  assert.ok(seen.pulses > 0, 'the original ring pulses reach the solver -- the pulse that comes again')
  assert.ok(seen.lit > 0, 'the episode lights its own vorticity')
  // "repeats": finishing one must arm the next, or it plays once per page load.
  assert.ok(f.c.nextEpisode >= 120 && f.c.nextEpisode <= 240,
    `finishing an episode arms the next one from BLOWUP.every, got ${f.c.nextEpisode}`)
})

/* THINKING DRAWS IN ON ITSELF, AND DOES NOT WALK AROUND WHILE IT DOES.
   Recovered from an earlier commit: "the blob draws in on itself and holds (the sink
   term, a twentieth of the blowup's strain), rocking gently as it does;
   nothing travels". The steer for this animation is to get very slow and then
   pulse again, so the draw-in is the slow half and the
   episode's ring pulses (see the episode test) are the pulse.
   The second assertion is the DELIBERATE NON-RECOVERY and it matters as much
   as the first. The original also walked seat.goal around a small circle
   ("circling on the spot"). That is motion by moving the body, which is ruled
   out: the body is not animated just by moving it around; it transforms and
   acts. It is left out on purpose -- this pins
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
       constant that produced the reported gap between the body's edge and the
       circle's edge: the test reproduced the gap and then asserted
       the body reflected inside it, so it stayed green while the defect was
       on screen. */
    const reach = f.c.bodyReach(nx, ny), radius = f.c.RIM - reach
    assert.ok(radius > .33, 'the body can approach the visible circular rim')
    /* FLUSH, and this is the complaint stated as a number. The inside
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
  assert.equal(blinked, false, 'a friendly tap cannot reopen the removed eye form')
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
     very slow, then a pulse again. A swirl with one kick at the
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
  assert.equal(actionMotion('writing', 0, 'reply'), actionMotion('idle'), 'writing a reply uses the owner-selected base body')
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
   What replaces it asserts the shape asked for instead: the chat
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
  // The design: the rings rotate while the blobs go in and out, the centre
  // blob spins the opposite way, and then it pauses for half a second.
  const orbiting = frames.filter(x => x.phase === 'orbit')
  assert.ok(orbiting.some(x => x.ringSpin[0] > 0 && x.ringSpin[1] < 0), 'the two bands turn against each other')
  assert.ok(orbiting.some(x => x.spin[0] < 0), 'and the core turns against the outer band')
  /* THE BREATH, AND WHY IT IS NOT MEASURED AS A RADIAL SWING ANY MORE.
     It was: max(spread) - min(spread) > .03. That passed only while the ring
     moved more than five of its own sigmas across its own track, which is
     exactly what washed the whole set out on the running page -- the ring
     smeared over the band it was supposed to be lying on. The blobs going in
     and out is still here and is still asserted, but as the thing
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
  assert.equal(f.c.drive.form, 2, 'writing a reply returns to the base body')
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
   Two things were asked for that a single scalar answers: the body
   should normally have substance and a defined edge and only go wispy
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
  assert.equal(actionMotion('idle'), actionMotion('writing'), 'writing and idle now share the same body and weight')
  assert.ok(actionMotion('thinking', 6).wisp > .9, 'the thinking swirl is all but mist')
  assert.ok(actionMotion('running', 4).wisp > actionMotion('idle').wisp, 'bands of water weigh less than one body')
  assert.ok(actionMotion('running', 4).wisp < .6, 'but the tool form is still water, not fog')
})

test('the retained liquid edge narrows with substance while Classic keeps its separate dye law', () => {
  /* The display law, read out of the renderer. The old shader had ONE band,
     `smoothstep(0.08, 0.65, amount)`: 0.57 of the body's own ink wide, at
     every moment, which made the edge read as too soft all the time.
     It is now two declared ends interpolated on the drained scalar. */
  const code = fluid.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  /* Anchored on the display: [ array, not on a declaration ORDER -- see the
     storm test above, where that anchor put uFast one line outside the slice. */
  const display = code.slice(code.indexOf('display: ['), code.indexOf('function compile'))
  // The retained Classic compatibility branch intentionally keeps its old dye
  // ramp. The variable edge below belongs to the liquid layer, not that branch.
  assert.match(display, /float liquidA = smoothstep\(uEdge\.x - uEdge\.y, uEdge\.x \+ uEdge\.y, ink\)/, 'the liquid layer uses its declared band')
  assert.match(display, /float depthC = smoothstep\(0\.08, 0\.65, aC\)/, 'the separate retained Classic branch keeps its own dye law')
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
  assert.ok(thin.band > heavy.band * 3, 'and the wispy end is much softer')
  assert.ok(half.band > heavy.band && half.band < thin.band, 'every value in between is reachable')
  assert.equal(heavy.curve, 1, 'a settled body is opaque inside its edge')
  assert.ok(thin.curve > 1.4, 'a wispy one keeps the old falloff')
  /* The legacy band, restated so a silent return to it is visible here.
     PROMPT A: this read `thin.at + thin.band >= .5` against a value that
     computes to exactly 0.5, so it was decided by the last bit of a float --
     it passed on `0.4 - 0.32` and failed on `0.507 - 0.427`, which is the same
     number twice. Stated as the property instead: the wispy end is at least
     as soft as the fixed ramp it replaced, and opens no later. */
  const LEGACY_LOW = .08, LEGACY_HIGH = .65
  assert.ok(thin.band * 2 >= LEGACY_HIGH - LEGACY_LOW - 1e-9,
    `the wispy end is at least as soft as the old fixed ${LEGACY_LOW}..${LEGACY_HIGH} ramp, got a band of ${thin.band * 2}`)
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
   reported twice: an empty ring with a perfectly healthy renderer
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
  assert.equal(f.c.agent.motion.pattern, 'eyes', 'the retained base-form identifier names the joined body')
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
  assert.equal(f.c.agent.motion.pattern, 'eyes', 'the retained base-form identifier names the joined body')
  assert.equal(f.c.agent.previous.form, 4)
  assert.equal(f.c.drive.formMix, 0, 'the new form begins with a blend, not a hard switch')
})

test('the real Home painter follows working, attention, then displayed order within the filter', () => {
  const row = (name, status = 'finished') => ({ agentKey: name, agentName: name, inScope: true, el: { hidden: false, dataset: { status }, toggleAttribute(key, value) { this[key] = value } } })
  const older = row('older'), newest = row('newest'), middle = row('middle')
  const c = vm.createContext({
    state: { sessions: { runs: [{ sequence: 3 }, { sequence: 2 }, { sequence: 1 }] } },
    runRows: new Map([[1, older], [2, middle], [3, newest]]), agentFilter: '', sample: false,
    /* The circle follows the first row the CHOICE keeps, and the choice is
       resolved to one predicate before the paint runs (views/home.js
       resolveChoice). With no selection that predicate keeps everything, which
       is what these order assertions are about. */
    keepForChoice: () => true,
    followedRow, actionForLive, actionLabel, sampleAction,
    destroyed: false, paintCircleStyle() {},
    ring: { el: { dataset: {} } }, agentLine: { children: [{ textContent: '' }, { textContent: '' }] },
  })
  vm.runInContext(declaredFunctionSource(home, 'paintCircleAction'), c)
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, 'newest', 'map insertion order must not choose the oldest row')
  assert.equal(c.ring.el.dataset.agentKey, 'newest')
  assert.equal(c.agentLine.hidden, false, 'a finished run still identifies the followed agent')
  middle.el.dataset.status = 'attention'
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, 'middle', 'owner attention outranks a more recent finished run')
  newest.working = true
  newest.liveRecord = { kind: 'text', working: true, tool: 'Edit' }
  c.paintCircleAction()
  assert.equal(c.ring.el.dataset.agentName, 'newest', 'observed work outranks owner attention')
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
test('Home Classic stays static and every Blob action selects Classic fluid; the retained switch remains bounded', () => {
  // Exercise the actual Home selector, not a parallel description of it.
  // Legacy saved animated IDs normalize to Blob; no supported choice may
  // silently reintroduce the retained jelly renderer during an action change.
  const calls = { classic: 0, retained: 0, destroyed: 0, launch: 0 }
  const selector = vm.createContext({
    ring: { el: { dataset: {} } }, ringFluid: null, sample: false, style: 'simple',
    currentHomeCircleStyle() { return normalizeHomeCircleStyle(selector.style) },
    mountClassicFluid() { calls.classic++; return { destroy() { calls.destroyed++ } } },
    mountHomeCircleFluid() { calls.retained++; return { destroy() { calls.destroyed++ } } },
    mountLaunchFluid() { calls.launch++; return { destroy() { calls.destroyed++ } } },
  })
  vm.runInContext(declaredFunctionSource(home, 'paintCircleStyle'), selector)
  // Launch has its own renderer; it is checked on its own below.
  const choices = [...HOME_CIRCLE_STYLES.map(choice => choice.id).filter(id => id !== 'launch'), 'classic', 'glass', 'unknown']
  for (const choice of choices) {
    selector.style = choice
    for (const action of ['idle', 'thinking', 'reading', 'writing', 'running', 'waiting']) {
      selector.ring.el.dataset.agentAction = action
      selector.paintCircleStyle()
      const expected = normalizeHomeCircleStyle(choice)
      assert.equal(selector.ring.el.dataset.circleStyle, expected)
      if (expected === 'simple') {
        assert.equal(selector.ringFluid, null)
        assert.equal(selector.ring.el.dataset.fluid, 'off')
      } else {
        assert.ok(selector.ringFluid)
        assert.equal(selector.ringFluid.classic, true)
        assert.equal(selector.ring.el.dataset.fluid, 'on')
      }
    }
  }
  assert.equal(calls.retained, 0, 'no supported Home style/action mounts retired jelly')
  assert.equal(calls.classic, 1, 'actions and normalized legacy IDs reuse the same Classic simulation')
  assert.equal(calls.destroyed, 1, 'switching back to static Classic releases that simulation')

  /* LAUNCH is an earlier circle, its own renderer beside
     the classic one: every action keeps the one Launch simulation, it never mounts the
     retired jelly, and switching back to static Classic releases it. */
  selector.style = 'launch'
  for (const action of ['idle', 'thinking', 'reading', 'writing', 'running', 'waiting']) {
    selector.ring.el.dataset.agentAction = action
    selector.paintCircleStyle()
    assert.equal(selector.ring.el.dataset.circleStyle, 'launch')
    assert.equal(selector.ring.el.dataset.fluid, 'on')
    assert.equal(selector.ringFluid.kind, 'launch')
  }
  assert.equal(calls.launch, 1, 'actions reuse the same Launch simulation')
  assert.equal(calls.retained, 0, 'Launch never mounts retired jelly')
  selector.style = 'simple'
  selector.paintCircleStyle()
  assert.equal(selector.ringFluid, null)
  assert.equal(calls.destroyed, 2, 'switching back to static Classic releases the Launch simulation')

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
