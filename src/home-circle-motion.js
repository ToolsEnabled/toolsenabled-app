// Actions change the character's material and pose. The body itself keeps
// its independent momentum; none of these states gives it a travel path.
const ease = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
/* HOW WHISPY EACH FORM IS, 0 = heavy water with a defined edge, 1 = mist.
   This is the one number the perceived density hangs off: the renderer lags
   it (see material/materialDrive in src/home-circle-fluid.js), then spends it
   in the SOLVER -- how fast the water lets go of its dye, how draggy it is,
   how hard the body holds itself together -- and only afterwards on how wide
   the edge is allowed to be. It is deliberately not a two-state flag: the
   owner's complaint was that density switched between two presets instead of
   moving with the morph. Every form declares its own, and a form whose shape
   changes over its cycle (thinking, tool use) declares a moving one. */
/* THE RESTING BODY IS DRAWN AT 3.6, AND 1.2 WAS NEVER FULL.
   `size` is the body's own scale: bodyLocal divides by it, so every length in
   the form -- the eye spacing, both sigmas, the droplets, the jiggle -- is in
   these units, and formReach/bodyReach in src/home-circle-fluid.js carry the
   wall along with it. Nothing else has to move.
   MEASURED, and the measurement is the reason. At 1.2 the resting pose's
   half-extent is (spacing + 1.18 * width) = 0.121 in face uv, which at the
   face's own scale (RIM 0.5301, FACE 224/260) is 155 device px of body inside
   a 579 px disc: the owner's "small lump wandering in an empty disc", and it
   read that way at 15 s and at 330 s alike because it is the geometry and not
   a leak. It was NOT a regression -- 22def14b's copy of this file diffs zero
   lines, and every constant in fluidForm's kind < 2.5 branch is byte for byte
   the same -- so there was nothing to put back and the number itself is what
   had to change.
   1.8, NOT 3.6 (owner, 2026-09-19, looking at 3.6: "why are the eyes/blob so
   gigantic"). 3.6 filled the disc -- each eye 85 x 165 CSS px in a 370 px
   circle and the merged disc half the face wide -- and the words sit inside
   the body rather than beside it. 1.8 is half again the 1.2 the owner
   accepted in 22def14b: a body you can see, not a body you are inside.
   The ceiling reasoning below is kept because it is still the ceiling:
   3.6 and not more: the wall is max(.18, RIM - bodyReach), so past about 3.2
   bodyReach has already pushed the wall onto its .18 floor and any further
   size is spent pushing the body THROUGH the frame. At 3.6 the visible edge
   (1.18 sigma) reaches .526 against a RIM of .5301 at the furthest the seat
   can sit, so the body fills the disc and still never crosses the casing.
   Only this form moved. Writing's four droplets already span 223 px, and
   thinking and the tool set already measure 577 and 528 px across -- they are
   full; the resting face was the one that was not. */
const BASE_CHARACTER = Object.freeze({ form: 2, pattern: 'eyes', size: 1.4, light: 2.4, storm: .06, decay: 6, spin: 0, pace: .047, tempo: 1, drag: 2.2, wisp: .08 })
const FORMS = Object.freeze({
  idle: BASE_CHARACTER,
  /* Owner, 2026-09-19 late: 'i dont like the writing one anymore' -- writing is the base body, like reading. */
  writing: BASE_CHARACTER,
  waiting: BASE_CHARACTER,
  // Reading is the whole character doing nothing else: float and blink.
  reading: BASE_CHARACTER,
})

/* THE CHAT WINDOW'S ORBIT SET, READ OFF THE STYLESHEETS RATHER THAN INVENTED.
   src/chat-presentation.css draws it in a 40-unit box centred on (20, 20):
     .chat-orbit-outer  circle r=16, stroke-width 1.6, chat-orbit-turn 2.8s
     .chat-orbit-inner  circle r=10, stroke-width 1.2, dasharray 12 19.4,
                        chat-orbit-turn 3.8s REVERSE
     .chat-orbit-core   the filled mark, chat-core-breathe 2.4s
   and src/chat-activity.css overrides the outer while a tool is working:
     [data-activity-phase="working"] .chat-orbit-outer
       { stroke-dasharray: 8 17; animation-duration: 2s; }
   A dasharray is an arc count and a duty cycle once you divide it into the
   circumference: the outer circle is 2*pi*16 = 100.5 long, so `8 17` is four
   arcs at 8/25 duty; the inner is 2*pi*10 = 62.8, so `12 19.4` is two arcs at
   12/31.4. Those four numbers are the shape, and they live in the shader as
   the same fractions (src/home-circle-forms.js, fluidForm kind 4). */
const ORBIT = Object.freeze({
  outer: .235, inner: .235 * 10 / 16, // the 16:10 radii of the two circles
  share: 1.6 / (1.6 + 1.2),           // how the material divides, by stroke weight
  turns: 4 / 2, turnsInner: -4 / 3.8, // 2s forward against 3.8s reverse, over the 4s active window
  breathe: 2.4,                       // chat-core-breathe
})
// A band of water lying on a circle holds duty * 2 * radius * sigma * sqrt(pi)
// of material in units where a disc of radius r holds r * r. Inverting it is
// how a band that breathes wider gets correspondingly thinner instead of
// manufacturing water.
const bandSigma = (area, duty, radius) => area / Math.max(1e-6, duty * 2 * radius * Math.sqrt(Math.PI))
/* TRACK is .chat-orbit-track, the continuous faint ring the SVG draws under
   the dashes. Without it the dashes read as separate marks scattered round the
   body, which is the direction the owner already rejected three times; with it
   they read as bright segments travelling along a ring. The band therefore
   carries `track` everywhere and `1` under a dash, so its angular average --
   and so the material it holds -- is TRACK + (1 - TRACK) * duty, not duty. */
const TRACK = .5
const OUTER_DUTY = 8 / 25, INNER_DUTY = 12 / 31.4
const held = duty => TRACK + (1 - TRACK) * duty
/* The thinking cycle: swirl, then reset and hold, then round again. `hold` is
   the owner's half second and is not the part that was reported as short.
   THE SWIRL HAS NOW BEEN ASKED TO GROW TWICE. It was 10 s, then 18 s, and the
   owner asked again -- so this round is not a nudge. `beat` is the other half
   of that ask: the owner's steer for this animation was "it can get really
   slow... then pulse again", and an 18 s swirl with a single kick at the top
   had no `again` in it. The cloud now gathers, slows and pulses on its own
   beat for as long as the think lasts. */
/* PROMPT B: where the blink sits in the 13.2 s base cycle. The pair finishes
   separating at 9.8; this is shortly after it. */
const BLINK_AT = 10.3
/* PROMPT C -- THIS EVENT IS THE BLINK, AND I HAD IT AS A SQUINT.
   The owner called it "the squint" once and I built it as one: 1.15 s long,
   closing all the way, with a 0.55 s pause. They have called the same event
   the blink throughout -- it is the one moved to just after the split -- and
   the result came back as "the blink is weird and too long and closese too
   much". A blink is quick and light. A squint is a slow narrowing with a
   pause, and it was asked for as an OCCASIONAL, subtle thing, not as something
   that fires every 13.2 s. Making the blink carry it was the mistake.

   So this is a blink again: 0.42 s against 1.15, and it closes PART WAY.

   Closing part way is what was tried long before this and came back as the
   "weird blink" -- squashed slits once every 13 s. That failed for a reason
   that is now fixed rather than for the reason it looked like: at 14% of the
   open height the eye is about two dye texels tall, under what the grid
   resolves, so it broke up instead of narrowing. `peak` here leaves the eye
   near half its height, which is six or seven texels even on the coarsest
   rung, and the lid spread in src/home-circle-forms.js widens it as it
   flattens. A partial closure is drawable now; it was not before.

   The shape is still close, hold, open with smoothstep ends, because that is
   what stopped it stepping. The excursion is smaller, so the same smoothness
   costs less time: the biggest per-frame move is lower than the old gaussian's
   even though the whole event is a quarter of the length.

   "Less dramatic" was asked for twice, so these are the lighter numbers: 0.32 s
   and it stops well under half closed. Going SHALLOWER is free here, which is
   worth knowing -- the texel floor below bites when the eye closes too FAR and
   the remaining slit falls under the grid, so a lighter blink is strictly
   easier to draw, not harder. There is a lower bound, but it is the point
   where the gesture stops reading as a blink at all, not a rendering one. */
const BLINK = { close: .12, hold: .04, open: .16, peak: .45 }
/* THE SQUINT, AS ITS OWN GESTURE. T259 item (3): "occasional subtle
   pause-and-squint". It was built ONCE, as the blink -- 1.15 s, closing all
   the way, every 13.2 s -- and came back as "the blink is weird and too long
   and closese too much". The comment above records the fix to the BLINK; the
   squint itself was removed with it and never rebuilt. The runtime suite has
   been saying so the whole time: "It is the blink; the squint is a separate,
   rarer gesture and the blink must not carry it."
   So it is separate here, and it differs from the blink in all three of the
   ways that made carrying it a mistake:
     RARER   once every SQUINT.every cycles, not every cycle.
     SHALLOWER  peak .17 against the blink's .45. That is about a sixth off the
             eye's height, which is what "subtle" buys; it is also the easiest
             case this renderer has to draw, because the texel floor that broke
             the old one bites when the eye closes too FAR, never too little.
     SLOWER, AND IT HOLDS. A blink is quick and light and has no pause in it.
             A squint is a slow narrowing that STAYS narrowed -- the "pause" in
             the owner's phrase -- and opens slowly again. That is why this is
             1.36 s against the blink's 0.32 and not the other way round: a
             squint shorter than a blink is just a blink.
   `at` 1.6 puts it early in the cycle, where `together` is 0 so the eyes are
   fully apart and it is visible at all, and nowhere near BLINK_AT at 10.3, so
   the two gestures can never run into one another.

   `first` IS 1 AND NOT 0 BECAUSE THE CYCLE-0 ONE IS THROWN AWAY. The clock
   restarts on every mount, and at t = 1.6 s the canvas is still at opacity 0 --
   measured, not assumed: a capture at that moment was refused by the render
   guard with is-live=false at steps=9. Firing first on cycle 1 puts the
   earliest squint anybody can see at 14.8 s instead of 54.4 s, with the same
   52.8 s spacing after it. For somebody who opens Home for half a minute that
   is the difference between an occasional gesture and one that never happens.

   The cadence is written as (cycle - first) % every so that `every: 1` still
   means EVERY cycle. Written as `cycle % every === first` it would have meant
   NEVER at every: 1, which would have made the cadence mutation pass for the
   wrong reason -- a guard that goes red because the gesture vanished is not
   the same guard as one that goes red because it got too common. */
const SQUINT = { every: 4, first: 1, at: 1.6, close: .38, hold: .52, open: .46, peak: .17 }
const THINK_SWIRL = 30, THINK_HOLD = .5, THINK_BEAT = 6.5
const THINK = Object.freeze({ swirl: THINK_SWIRL, hold: THINK_HOLD, beat: THINK_BEAT, period: THINK_SWIRL + THINK_HOLD })

// A shared, continuous pose for the two eyes and their single soft body.
// Both forms linger; the small breath keeps this from reading as a ticking
// status indicator. Reuse the caller's buffer.
//
// THE FACE NEVER ROTATES. Slot 3 used to carry a "gentle tilt",
// `.055 * sin(t * .53) + .025 * sin(t * .19)`, which the dye shader consumed
// as a rotation of the eye pair about its own centre. It peaked at 0.073 rad
// (4.2 degrees measured live, not estimated), and what it reads as on screen
// is the eyes swivelling to the side -- the owner reported it twice, the
// second time as "the eyes turn to the side and look creepy". The rotation is
// gone from the shader too (src/home-circle-forms.js), so a side-turned pose
// is not representable rather than merely zero-valued today. Slot 3 stays in
// the vec4 because the uniform is a vec4; it is held at zero deliberately.
export function updateBaseCharacter(pose, seconds) {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0, age = t % 13.2
  const cycle = Math.floor(t / 13.2)
  /* THE PAIR AND THE SINGLE BLOB ARE BOTH THE CHARACTER. DO NOT SHORTEN THIS.
     Eyes-to-blob-to-eyes on a 13.2 s cycle is the design the owner asked for
     in as many words: "i like the pair idea. like, a pair of eyes. it makes it
     personable, and then they can join together to make the single blob
     character or split up to make our other animations", and "the base
     character is supposed to be a transforming between two eyes and a single
     almost cuddly blob".
     I shortened the joined half of this cycle once, reading the owner's
     "still popping up sometimes" as a complaint about the pair reappearing.
     It is not. That phrase is about a separate eye STYLE that was introduced
     and twice reported as still present; the transformation itself is wanted.
     Shortening it deletes a requested feature. Reverted, and left here as a
     warning because this is now the third edit in this lane aimed at
     something the owner explicitly asked to keep. */
  /* Owner, 2026-09-19: no eyes -- one fun ball. The two lobes stay joined
     the whole cycle, so the form is always the one round body; the roam,
     jiggle and episodes underneath are untouched. */
  const together = 1
  /* ONE blink per cycle. A second term at age 11.5 capped at .85 never closed
     the eye -- height goes to 0.27 of base, leaving squashed slits once every
     13 s. That is the owner's "weird blink". Removed.
     PROMPT B: it now blinks just after the pair finishes separating, not five
     seconds later. `together` reaches 0 at age 9.8 -- the second ease above
     completes there -- and the blink sat at 1.9, which is 5.3 s further round
     a 13.2 s cycle and read as an unrelated blink rather than as the eyes
     opening and then blinking. BLINK_AT is half a second past the split so
     the two read as one gesture. It has to stay clear of 9.8 itself: the eyes
     are still arriving there, and `pose[1]` is scaled by (1 - together), so a
     blink placed any earlier would be muted by the pair still being joined. */
  // Begin early enough that the deepest point still lands on BLINK_AT.
  const since = age - (BLINK_AT - BLINK.close)
  pose[0] = together
  const blink = BLINK.peak * ease(0, BLINK.close, since)
    * (1 - ease(BLINK.close + BLINK.hold, BLINK.close + BLINK.hold + BLINK.open, since))
  /* The squint, on its own cadence. The two gestures are held apart in time by
     `at` and BLINK_AT, so this MAX never actually has to choose -- and that is
     exactly why it is a max and not a sum. A sum would let a squint that ever
     did drift into a blink add up into a closure deeper than either gesture
     asks for, which is the "closes too much" failure arriving by a new route.
     A max cannot go deeper than the deeper of the two, whatever the timing. */
  const squintSince = age - SQUINT.at
  const squint = cycle >= SQUINT.first && (cycle - SQUINT.first) % SQUINT.every === 0
    ? SQUINT.peak * ease(0, SQUINT.close, squintSince)
      * (1 - ease(SQUINT.close + SQUINT.hold, SQUINT.close + SQUINT.hold + SQUINT.open, squintSince))
    : 0
  pose[1] = (1 - together) * Math.max(blink, squint)
  pose[2] = 1 + .018 * Math.sin(t * 2 * Math.PI / 5.8) + .008 * Math.sin(t * 2 * Math.PI / 9.7)
  pose[3] = 0
}

// Occasionally give continuous action animation ten seconds of the normal
// floating character. This uses the renderer's clock, with no extra timer.
export function createActionRest(random = Math.random) {
  return { nextAt: 50 + 20 * random(), until: 0, active: false }
}
export function updateActionRest(rest, seconds, busy, random = Math.random) {
  if (rest.active && seconds < rest.until) return true
  rest.active = false
  if (seconds >= rest.nextAt) {
    rest.nextAt = seconds + 50 + 20 * random()
    if (busy) { rest.active = true; rest.until = seconds + 10 }
  }
  return rest.active
}

export function actionMotion(action, seconds = 0, tool = '') {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (action === 'thinking') {
    /* Swirl, reset, hold about half a second, swirl again, for as long as it
       is still thinking. THE SWIRL IS THE LONG PART. It ran for ten seconds
       and the owner reported that as too short; it is eighteen now, against
       the same half-second hold, so the reset stays a punctuation mark rather
       than a third of the animation. The hold and the loop are unchanged on
       purpose -- only the swirl was asked to grow. */
    const cycle = Math.floor(t / THINK.period), age = t % THINK.period
    const original = ease(0, .4, age) * (1 - ease(THINK.swirl - .4, THINK.swirl, age))
    /* The pulse. Each beat is a slow breath of the whole cloud: it draws in
       and quietens towards the end of one, then the next one pushes it back
       out. `beat` counts them so the renderer can fire the original burst,
       shear and torque ring once per beat instead of once per swirl, and
       `surge` is the same beat as a continuous 0..1 the draw-in rides. */
    const beat = Math.floor(age / THINK.beat), into = (age % THINK.beat) / THINK.beat
    const surge = Math.sin(into * Math.PI) ** .7
    return { form: 1, pattern: 'cloudy-thinking', size: 1.24, light: 6.0,
      storm: .06 + .94 * original, decay: 4.2, spin: 0, pace: .022, drag: 2.2,
      gather: .2 + .5 * (1 - surge), release: 0, original, cycle,
      beat: cycle * 1000 + beat, surge, wisp: .08 + .92 * original,
      phase: age < THINK.swirl ? 'swirl' : 'pause' }
  }
  if (action === 'running' || (action === 'writing' && tool && tool !== 'reply')) {
    /* TOOL WORK, in the chat window's own language: the orbit set from
       src/chat-presentation.css and src/chat-activity.css -- .chat-orbit-outer
       over .chat-orbit-inner over .chat-orbit-core -- drawn out of this body's
       own water as two counter-turning BANDS around a breathing core, centred
       on the body. See ORBIT above for where the numbers come from, and
       fluidForm kind 4 in src/home-circle-forms.js for what replaced the five
       orbiting dots. Four seconds of eased rotation, then half a second of
       rest, as the owner described. Unwrapped angles stay continuous across
       the pause. */
    const cycle = Math.floor(t / 4.5), age = t % 4.5, progress = ease(0, 4, age)
    const u = Math.min(1, age / 4), orbit = 2 * Math.PI * (cycle + progress)
    const orbitSpeed = age < 4 ? 2 * Math.PI * 6 * u * (1 - u) / 4 : 0
    const release = ease(0, .8, t)
    /* OWNER, 2026-09-18: the brim "looks completely retarded". Size 1.05 drew
       the tool bands at 105% of the face, so the outer band crossed the casing
       ring and the frame's own edge -- the animation escaping its frame, over
       the brim he had just asked to be made of the body's material. 0.82 keeps
       the whole set inside the face with the brim clear around it. */
    return { form: 4, pattern: 'chat-orbit', size: 0.82, light: 4.0,
      /* decay 9 was chosen for five orbiting dots, which had to stay crisp.
         A band is swept: each arc passes a given point for a third of every
         turn, so at that decay the annulus drained faster than the arc could
         fill it and the set read as a faint smudge around a solid core
         (measured: outer-band dye peaking near 0.43 and falling to 0.10
         between passes). Halving it lets each arc lay down water that is
         still there when the next one comes round, which is both legible and
         what water actually does. */
      storm: .06, decay: 4.5, spin: 0, pace: .04, drag: 2.0, release,
      /* THE BREATH. The owner asked for "the blobs go in / out", and with
         satellites that was a radial excursion. A band cannot do it that way:
         a 0.045 swing on a 0.235 radius moves the ring more than five of its
         own sigmas, so the ring smears across its own track and the whole set
         washes out -- measured on the running page at the top of each breath.
         So the breath is mostly a MATERIAL EXCHANGE instead. Water moves out
         of the core into the rings and back, the rings brighten and thicken as
         it arrives, and the radius moves only a little. That is still in and
         out, it conserves the body exactly, and the ring stays on its track. */
      orbit, orbitSpeed, breath: Math.sin(progress * Math.PI * 2) ** 2,
      wisp: .1 + .24 * release,
      turn: orbit * ORBIT.turns, turnInner: orbit * ORBIT.turnsInner,
      outerSpin: orbitSpeed * ORBIT.turns, innerSpin: orbitSpeed * ORBIT.turnsInner,
      spread: ORBIT.outer + .022 * Math.sin(progress * Math.PI * 2) ** 2,
      phase: age < 4 ? 'orbit' : 'pause' }
  }
  return FORMS[action] || null
}

// Cached material pieces, each x/y and two radii. Their targets conserve the
// character's area while it splits. Damped springs move the material and
// carry it through the fluid, rather than cross-fading independent sprites.
export function createBlobParts() {
  return { pose: new Float32Array(20), target: new Float32Array(20), velocity: new Float32Array(10),
    angles: new Float32Array(5), spin: new Float32Array(5),
    /* The tool form is not made of pieces, so it does not use the piece slots
       above except for its core. ring is [outer radius, inner radius, outer
       sigma, inner sigma]; turn is [outer angle, inner angle, core stretch,
       how far the bands have opened]; ringSpin is the two bands' angular
       speeds, which the solver spends as shear. */
    ring: new Float32Array(4), turn: new Float32Array(4), ringSpin: new Float32Array(2), form: 0 }
}
export function updateBlobParts(parts, motion, seconds, dt) {
  if (!motion || (motion.form !== 1 && motion.form !== 4)) return
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const step = Math.max(0, Math.min(.05, dt)), release = motion.release
  parts.target.fill(0)
  parts.spin.fill(0)
  parts.ring.fill(0)
  parts.ringSpin.fill(0)
  parts.turn[0] = parts.turn[1] = parts.turn[3] = 0
  parts.turn[2] = 1
  if (motion.form === 4) {
    /* THE CHAT ORBIT SET AS WATER. There are no satellites here and there is
       no loop over five pieces: the material leaves the core as two BANDS
       lying on the two circles the chat window draws, and the bands are
       radially symmetric, so nothing in this form can read as a dot.
       Conservation is the same principle the old split used -- the core gives
       up exactly what the bands take, `fraction` of the body -- but a band's
       share buys sigma at its own radius, so a band that breathes wider gets
       thinner instead of growing. */
    const radius = .074, area = radius * radius
    // The breath moves material between the core and the rings; the total is
    // the same body at every instant.
    const fraction = .7 * (.82 + .18 * (motion.breath ?? 0))
    const coreRadius = radius * Math.sqrt(1 - fraction * release)
    // chat-core-breathe, area-preserving: the core stretches, it does not grow.
    const stretch = 1 + .16 * release * Math.sin(t * 2 * Math.PI / ORBIT.breathe)
    // The core turns against both bands, and carries that turn into the solve
    // through the same piece-force slot it always used.
    parts.angles[0] = -motion.orbit; parts.spin[0] = -motion.orbitSpeed
    parts.target[2] = coreRadius * stretch
    parts.target[3] = coreRadius / stretch
    const outerR = motion.spread, innerR = outerR * ORBIT.inner / ORBIT.outer
    parts.ring[0] = outerR
    parts.ring[1] = innerR
    parts.ring[2] = bandSigma(fraction * ORBIT.share * area * release, held(OUTER_DUTY), outerR)
    parts.ring[3] = bandSigma(fraction * (1 - ORBIT.share) * area * release, held(INNER_DUTY), innerR)
    parts.turn[0] = motion.turn; parts.turn[1] = motion.turnInner
    parts.turn[2] = -motion.orbit; parts.turn[3] = release
    parts.ringSpin[0] = motion.outerSpin; parts.ringSpin[1] = motion.innerSpin
  } else {
    const radius = .074 * (1 - .32 * motion.gather), fraction = .68
    const coreRadius = radius * Math.sqrt(1 - fraction * release), stretch = 1 + .22 * motion.gather
    parts.angles.fill(0)
    parts.target[2] = coreRadius * stretch
    parts.target[3] = coreRadius / stretch
    for (let i = 1; i < 4; i++) {
      const n = i - 1, offset = i * 4, angle = .3 + n * Math.PI * 2 / 3
      const bounce = Math.sin(t * 2.1 + n * 1.45), bitRadius = radius * Math.sqrt(fraction * release / 3)
      const squeeze = 1 + .18 * bounce * release
      parts.target[offset] = Math.cos(angle) * .17 * release
      parts.target[offset + 1] = Math.sin(angle) * .17 * release * .76 + .018 * bounce * release
      parts.target[offset + 2] = bitRadius / squeeze
      parts.target[offset + 3] = bitRadius * squeeze
    }
  }
  if (!parts.form) { parts.pose.set(parts.target); parts.velocity.fill(0) }
  parts.form = motion.form
  const damping = Math.exp(-11 * step), sizeEase = 1 - Math.exp(-14 * step)
  for (let i = 0; i < 5; i++) {
    for (let axis = 0; axis < 2; axis++) {
      const p = i * 4 + axis, v = i * 2 + axis
      parts.velocity[v] = (parts.velocity[v] + (parts.target[p] - parts.pose[p]) * 100 * step) * damping
      parts.pose[p] += parts.velocity[v] * step
      parts.pose[p + 2] += (parts.target[p + 2] - parts.pose[p + 2]) * sizeEase
    }
  }
}
