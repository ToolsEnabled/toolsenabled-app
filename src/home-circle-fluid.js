/* THE HOME CIRCLE, COME ALIVE (app page 1, route #/).
 *
 * The same real-time fluid as the toolsenabled.ai homepage circle (website public/orbit-fluid.js, e7512f0), ported to
 * the app's Home ring (src/home-circle.js inside uptimeRing): it paints inside the ring's face, beneath the readout and
 * the ring, using the ring's status colour as its material. The ring itself is still. The water is a blob
 * that coasts and rebounds inside the face. Each followed action changes the fluid's form and forcing (agentDrive):
 * thinking plays the original cloudy shear-and-turn; tool work stretches, splits and folds the body;
 * writing separates into four dots. Changing the followed agent runs the original shrinking-core transition. These transformations
 * remain available even when the performance ladder disables decorative extras.
 *
 * Technique: J. Stam, "Stable Fluids", SIGGRAPH 1999 (semi-Lagrangian advection, pressure projection), as mapped to
 * the GPU by M. Harris, "Fast Fluid Dynamics Simulation on the GPU", GPU Gems ch. 38, 2004; vorticity confinement after
 * R. Fedkiw, J. Stam, H. W. Jensen, SIGGRAPH 2001. The blowup episode is after OpenAI, "Finite Time Blowup for
 * Navier–Stokes" (2026), §2 and Figs. 1–2 (see BLOWUP below for exactly what it is and is not). Written from the
 * papers; no code copied. Every extra is a term of the same equation, ∂t u + (u·∇)u = −∇p + ν∆u + f with ∇·u = s.
 *
 * What the app adds to the site's contract:
 *   - the circle's own settings decide: Motion "Still" never runs it, "System" follows the OS reduced-motion preference,
 *     the app's Reduce motion always stops it, "Animate" opts in; Glow intensity scales it and Glow 0 turns it off;
 *     theme and ledger status colours come from the ring's --core-status-color;
 *   - it pauses when Home is off screen, the window is hidden, or the window is not focused, and it always starts at the
 *     smaller 64-cell pressure grid (the app also runs agents);
 *   - voice has no microphone of its own: the Home voice widget (voice-coordinator.js) owns the microphone through the
 *     shell's permission gate (shell/voice-permissions.cjs); this reads only the widget's state (ring.dataset.voice),
 *     its on-screen level and the words it recognized (voice-signal.js).
 *   - it acts out what the followed agent is doing: home.js keeps data-agent-action (thinking, reading, writing,
 *     running, waiting, idle; src/home-circle-action.js) and data-agent-name on the ring, and agentDrive below turns
 *     each into a distinct pattern from home-circle-motion.js, using the same fluid passes.
 * Kill switch: home.js sets ring.dataset.fluid = 'on' and data-fluid-extras = 'personality blowup voice'. Diagnostics:
 * the ring element's homeCircleFluid.stats() and .play().
 */
import { voiceSignal } from './voice-signal.js'
import { actionMotion, createBlobParts, updateBlobParts, updateBaseCharacter, createActionRest, updateActionRest } from './home-circle-motion.js'
import { FLUID_FORMS } from './home-circle-forms.js'
import { OPTICS_PRELUDE, OPTICS_THICKNESS, OPTICS_REFRACTION, OPTICS_ENVIRONMENT, OPTICS_FRESNEL, OPTICS_CAUSTIC, OPTICS_SKIN, OPTICS_SHADE, uploadOptics, opticsDefaults } from './home-circle-optics.js'

function medianOf(list) {
  var s = list.slice().sort(function (a, b) { return a - b; });
  return s[s.length >> 1];
}

/* ONE JUDGEMENT WINDOW, AND WHOSE SLOWNESS IT IS.
 *
 * `intervals` are the times between steps, `works` the script time of each
 * step, `probes` the time of a step measured through a GPU sync (script time
 * plus the GPU finishing that step's passes), and `budget` the rung's ms per
 * step. A step interval is set by everything on the page: the main thread,
 * the compositor, the GPU and the browser's frame pacing. Measured on LIVE, the
 * extras and then a rung went while steps came every 50 ms and each cost
 * 0.2-0.3 ms: the circle was slowed by the page starting up around it, and
 * stepping down could not help. So a slow cadence counts against the circle
 * only when its own measured cost is a real share of the budget. Expensive
 * script time always counts, and a slow GPU shows up in the probes, so both
 * safeguards stay. Without a probe the cadence decides, as before. */
export function fluidWindowVerdict({ intervals, works, probes, budget }) {
  var m = medianOf(intervals), w = medianOf(works);
  var full = probes && probes.length ? Math.min.apply(null, probes) : null;
  var ours = full === null || full > budget * 0.5;
  return {
    medianMs: m,
    workMs: w,
    fullMs: full,
    slow: w > budget * 0.6 || (ours && m > budget * 1.35),
    severe: w > budget * 1.2 || (ours && m > budget * 2.5)
  };
}

export function mountHomeCircleFluid(ring, { sample = false } = {}) {
  var inert = { destroy: function () {} };
  /* DETERMINISM, for the motion gates and nothing else. A page that sets
     window.homeCircleFluidTest = { seed: <number>, dt: <seconds> } before Home
     mounts gets a seeded random (a 32-bit LCG) behind every Math.random this
     renderer draws, and a fixed step of dt seconds instead of the wall clock,
     so two runs of the same input produce the same frames. Unset, nothing
     here changes: Math is the real Math and the step is the frame interval. */
  var testHook = typeof window !== 'undefined' && window.homeCircleFluidTest && typeof window.homeCircleFluidTest === 'object' ? window.homeCircleFluidTest : null;
  var Math = (function (real, hook) {
    if (!hook || !Number.isFinite(hook.seed)) return real;
    var state = (hook.seed >>> 0) || 1;
    var seeded = Object.create(real);
    seeded.random = function () { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
    return seeded;
  })(globalThis.Math, testHook);
  var fixedDt = testHook && Number.isFinite(testHook.dt) && testHook.dt > 0 ? Math.min(0.05, testHook.dt) : 0;
  /* Decoration never breaks Home: without the browser pieces it needs (or in a test's stand-in DOM) it stays out. */
  if (!ring || !ring.dataset || ring.dataset.fluid !== 'on' || typeof window === 'undefined' || !window.requestAnimationFrame
    || !window.getComputedStyle || !window.MutationObserver || !window.IntersectionObserver || !document.body) return inert;
  var visual = ring;
  var centre = ring.querySelector('.uring-inner');
  var root = document.documentElement;
  void sample;

  /* The quality ladder starts with a 64-cell pressure grid and 192-cell dye
     grid. It only steps down; past the last rung the canvas is removed. */
  var LADDER = [
    { sim: 128, dye: 256, iterations: 20, fps: 30 },
    { sim: 128, dye: 192, iterations: 20, fps: 30 },
    { sim: 96, dye: 192, iterations: 20, fps: 30 },
    { sim: 96, dye: 128, iterations: 20, fps: 30 },
    { sim: 64, dye: 192, iterations: 20, fps: 30 },
    { sim: 64, dye: 128, iterations: 12, fps: 30 },
    { sim: 64, dye: 128, iterations: 12, fps: 20 }
  ];
  /* Keep the pressure grid small; the dye grid carries the character's
     detail. All gestures remain available on the lower performance rungs. */
  var SMALL_START = 4;

  /* Motion and look, tuned by eye on screenshots of every theme at desktop
     and phone sizes. Units: the circle's box is 1 x 1, time in seconds.
     Weight (owner, 2026-09-15: "give the fluid personality and a little more weight ... try not just to spin it all
     the time"): the ambient circulation is halved, the fluid is more viscous so motion settles, and the plumes are
     bigger, denser and roll inward from the sources rather than streaking round the wall. */
  var TUNE = {
    swirl: 0,            // tangential acceleration in the band along the wall: none at rest (the storm adds some)
    push: 0.6,           // acceleration at the seat, pointing inward: the blob's cohesion
    pushSharp: 70,       // source force falloff, 1 / (2 sigma^2)
    inward: 0.75,        // share of a source's push that points at the centre
    /* PROMPT A: a heavy liquid. `dye` read 1.5 with the comment "a body while
       it travels, but not a heavy one", and a heavy one is what the owner has
       now asked for, so the body lays down more of itself per second and the
       water is thicker to push around. Both are solver constants; neither
       touches the picture directly. */
    dye: 1.9,            // PROMPT A (was 1.5): dye added per second at the seat -- a body with some weight in it
    /* BLOB LOOK: 5.5 is 21506c72's value and it was set against a normal built
       from the saturated silhouette. Read off the body's own thickness instead
       the slope is gentler, and 5.5 there measured 6 percent of the body's
       brightness -- present in the data, invisible on a screen. */
    relief: 9,           // PROMPT A / BLOB LOOK (was 5.5)
    /* PROMPT E: how much FURTHER through the material the light is treated as
       travelling on the flank that faces away, as a multiple of the optical
       depth already there. It is a path-length gain, not a brightness: at 0
       the body is lit flat, and at 0.9 the fully-turned-away flank of the mass
       is carrying nearly twice the absorption of the flank facing the light.
       The thin skin has almost no depth to multiply, so it stays luminous. */
    reliefDepth: 0.9,    // PROMPT E: extra optical depth per unit of turning away
    edgeTexels: 1.4,     // PROMPT A: how many dye texels the silhouette may resolve over -- a clear boundary, still antialiased
    /* BLOB LOOK. thickLow is the ink where the body is its thinnest visible
       skin, thickSpan how much more ink takes it to full mass; together they
       turn the source's own gaussian into a dome to shade and to colour over.
       thickMix is how much of the colour that dome owns against the channel
       ratio, which on its own is a constant and cannot vary. */
    /* thickSpan sets where the dome tops out. Wide (1.9) puts most of the body
       on the thin side of it and the whole thing washes out pale -- looked at,
       not reasoned about. The mass wants to sit at the deep stop with the
       light stop reached only in the thin skin at the rim, so the span is
       narrow and the READ comes from how far apart the two stops are. */
    /* PROMPT D: thickFloor was 0.34 -- the thinnest skin still carried a third
       of the deep stop, so the rim read as the body FADING rather than as
       light coming through it. A jelly is luminous where it is thin, because
       that is where least of it is in the way. Dropping the floor puts the rim
       nearer the light stop while the alpha transmission above keeps it
       translucent, so it glows instead of washing out. It cannot go past the
       light stop -- the probe bounds every pixel against exactly that. */
    thickLow: 0.18, thickSpan: 0.9, thickMix: 0.85, thickFloor: 0.18,
    /* JELLY: this is now purely COVERAGE -- how much of the backdrop the
       thinnest skin blocks, against 1.0 through the mass. It no longer decides
       how bright the skin is (TUNE.glow does), so it is free to be genuinely
       see-through, which is what puts the ring behind the body back on screen.
       It was 0.64 and was still being lifted toward opaque on dark themes. */
    jelly: 0.30,         // JELLY (was 0.64): coverage of the thinnest skin
    density: 0.9,        // PROMPT E: optical depth per unit of ink -- how thick the liquid is to look through
    /* PROMPT F -- THE BODY'S OWN SURFACE, AND THE LINE IT HAS TO STAY THE
       RIGHT SIDE OF. The owner's reference is a photographed gummy cube: a
       hard white catch lying across the top face, a lighter catch along the
       rounded bevel, and a deep rich interior under both. Measured off that
       photograph rather than described: the catch peaks at 2.34x the body's
       own median brightness, 0.89% of the body sits within 5% of that peak
       (4.1% within 10%), and the peak is nearly colourless -- saturation 0.13
       against 0.83 through the body. Small, bright, white. A reflection, not
       a wash.
       WHY THIS IS NOT THE GLOSS LAYER THE OWNER HAS REJECTED FOUR TIMES.
       What is rejected is a LAYER: a pass composited over the finished body
       that does not know what shape is underneath it and would look identical
       over any of them. Both terms here are functions of `n`, the dye field's
       own slope, so the catch sits where the body's surface happens to face
       the light, and it moves, breaks and vanishes WITH the shape -- delete
       the body and there is nothing left to reflect. It is the same
       distinction the owner makes about motion on the same list, transform
       rather than sprite. tools/home-circle-form-qa.mjs measures it rather
       than taking it on trust: it follows the catch's centroid against the
       BODY's centroid and against the canvas centre, and a layer is the one
       that holds still against the canvas while the body travels.
       x strength of the catch, y where it BEGINS -- the value of dot(n, hv)
       at which the surface starts reflecting, z how sharply the bevel catch
       falls away from face-on, w the strength of that bevel catch.
       y is a threshold rather than an exponent, and that is not a detail. A
       pow() lobe has no zero: raising the exponent to keep the flat interior
       dark makes the catch a pinpoint (measured, exponent 46 put 0.09% of the
       body inside 5% of its peak against the reference's 0.89%, a tenth of
       the size), and lowering it to grow the catch lifts the WHOLE interior,
       which is a wash over the body -- the exact thing the owner rejects. A
       threshold separates the two: the flat interior sits at dot 0.898 and is
       strictly below y, so it contributes nothing at all, while y decides how
       much of the turning surface catches the light and the smoothstep gives
       that patch a soft edge rather than a rim. */
    gloss: [0.55, 0.93, 3, 0.11],
    /* A CATCH THAT REACHES WHITE HAS NO GRADIENT LEFT, and 8 bits is where it
       runs out, not the maths. The catch arrives as
       `body += (1 - body) * (1 - exp(-mirror))`, which approaches 1 and never
       passes it -- so in the maths it is always a smooth curve. On a LIGHT
       ground the body is already near 0.9 before the catch is added, so the
       last tenth is spent in a fraction of the catch's width, every pixel past
       that point quantises to the same 255, and what is left on screen is a
       flat patch with a hard boundary. On black there is headroom and the same
       catch reads as a gradient, which is exactly why this was four times as
       bad on white and ember as on cobalt. It is a ceiling, not a light.
       catchPeak is the largest `mirror` the hot core may produce, so the
       brightest pixel of the catch lands this far toward white from wherever
       the body already is. At 0.45 a body sitting at 0.90 reaches 0.936 and
       still has 5 quantisation steps of gradient across the catch. */
    catchPeak: 0.45,
    /* PROMPT F -- THE SECOND DYE. The reference is two dyes, not one: crimson
       through the upper body, green through the lower, and amber where they
       overlap and where the body is thin. Measured on the photograph, the hue
       of its saturated pixels runs 1 -> 24 -> 45 degrees. One absorber cannot
       do that however good its curve is, because one absorber moves the
       colour along ONE path out of the light stop.
       The ledger owns the hue and chroma() exists precisely to stop this
       renderer sliding a status colour off it, so the second dye is not a
       colour of its own: it is the ledger's OWN deep stop turned `dyeTurn`
       degrees at the same lightness and saturation, and it is present only
       THROUGH THE MIDDLE of the depth, zero at both ends. Thickness 0 is
       still exactly the light stop and thickness 1 is still exactly the deep
       stop, so every palette guarantee holds untouched; the hue swings only
       in between, which is where the reference's amber is. */
    /* Swept against the hue swing it actually produces, measured on the
       composited body: 0.85 gave 13-14 degrees, 1.8 gives 23-29, 2.6 gives
       33-58 but costs the dark themes their contrast (assertVisibleInk on
       cobalt 141 -> 74) and their saturation (0.73 -> 0.53), because a third
       dye's worth of absorption in the middle of the depth is light the body
       does not get back. The reference photograph spans 44 degrees. 1.8 is
       most of that swing for nothing measurable. */
    /* JELLY -- THE SECOND DYE IS OFF, AND IT IS THE FIRST OF THE TWO MEASURED
       ROOT CAUSES OF THE BODY THE OWNER REJECTED ON SIGHT.
       The paragraphs above are kept because the reasoning in them is sound
       about the reference PHOTOGRAPH; what they got wrong is the cost. The
       turned absorber holds green while it eats red and blue, so it does not
       merely add amber in the middle of the depth -- it ROTATES THE HUE of the
       whole mid-thickness band. Measured on the shipped body, black theme, the
       hue across the thickness sweep ran 22 -> 2 degrees and cobalt ran 301 ->
       342: a 12 to 46 degree swing against the +-8 the ledger's hue is owed,
       and on the warm themes the band it lands in is brown. A hue rotation is
       not a colour the ledger owns, and chroma() exists in this same file to
       stop exactly that.
       0 removes the term from the exponent arithmetically -- uAbsorb2 is still
       derived and still sent, and the law is unchanged -- so the second dye
       can be revived from one constant if the reference's amber is ever wanted
       back with a hue-preserving absorber behind it. */
    dyeTwo: 0,           // JELLY (was 1.8): the hue rotation that made the mid band brown
    dyeTurn: 34,         // PROMPT F: degrees the second dye's stop is turned off the ledger's own hue
    /* JELLY -- A REAL ILLUMINANT, WHICH IS THE CEILING THE BODY DID NOT HAVE.
       The colour law is `uLight * exp(-absorption)`, and exp() cannot exceed 1,
       so the brightest pixel the body could ever draw was the light stop
       itself -- a swatch, not a light. Everything in the material was then
       competing for room under a ceiling set by a colour picker. illum is how
       much light falls on the material, as a multiple of that stop, and it is
       what lets the thin skin be brighter than any stop while the mass stays
       deep. It is spent at the uniform (see stops.illum in stats()), so the
       ledger still owns the HUE and only the amount of light changes. */
    illum: 2.6,          // JELLY: the illuminant, as a multiple of the ledger's light stop
    /* JELLY -- SUBSURFACE SCATTER, the light that went in, bounced and came
       back out. x is how much of the illuminant the material returns, y how
       fast that builds with depth. The attenuation here is a SCALAR, not the
       per-channel absorber: scattered light has taken a randomised path and
       carries the material's own colour rather than a channel ratio, and a
       scalar is also what holds the hue exactly still across the whole
       thickness ramp -- which is the second half of the brown band's cure. */
    scatter: [0.12, 2.4, 0.18],
    /* JELLY -- BACKLIGHT / TRANSMISSION. The reference gummy is lit THROUGH:
       value near white where the body is thin, the ground visible behind it.
       x is how much illuminant arrives from behind, y the fraction of the
       optical depth that light travelled (shorter than the front path, so the
       thin skin keeps nearly all of it and the mass eats it). It is the term
       that makes the rim brighter than the core, which is the single thing a
       gummy has and a marble does not. */
    back: [0.85, 1.6],
    /* JELLY -- FRESNEL AT THE SILHOUETTE. x strength, y falloff. 1 - n.z is
       how far the body's OWN surface has turned away from the eye, so this is
       largest exactly where the body rolls over into its rim and is zero
       through the flat interior. Delete the body and there is nothing to
       reflect; it is the same test the specular catch already passes. */
    rim: [0.30, 4.0],
    /* JELLY -- THE INNER CAUSTIC. A dome is a lens: light entering the near
       flank converges inside the body and puts a bright patch on the FAR side
       of the curve, offset from the catch rather than under it. x strength,
       y the fraction of the optical depth it travelled, z how much of the
       height field's own curvature counts as converging. Built from the four
       neighbour heights the relief already samples -- no extra taps. */
    caustic: [0.55, 1.15, 26],
    /* JELLY -- FAINT SURFACE IRREGULARITY. A mathematically perfect specular
       is the most CG-plastic thing that can be drawn; a gummy's skin is
       slightly uneven. x is the amplitude added to the surface slope, y the
       spatial frequency. Sampled in BODY-LOCAL coordinates (uBodyAt), so the
       skin travels with the body and is not a screen-space veil over it. */
    skin: [0.10, 30],
    /* JELLY -- COVERAGE IS NOT BRIGHTNESS, AND CONFLATING THEM IS THE SECOND
       MEASURED ROOT CAUSE. The shader emitted `colour * a`, premultiplied, so
       a body that let anything through was a body that was dark: the bright
       thin rim was computed correctly and then multiplied away, and the only
       cure available was to push alpha toward opaque, which is what made the
       body a sticker the ring cannot be seen through.
       They are two different physical quantities. How much of the backdrop
       the material BLOCKS is Beer-Lambert in its own ink (cover). How much
       light it SENDS to the eye is the scatter, the transmission and the rim,
       and a thin skin sends a great deal while blocking very little. So they
       are two curves over the same thickness now.
       cover: x optical depth per unit ink for the coverage, y the most of the
       backdrop the body may ever block -- deliberately short of 1, because an
       opaque body scores zero on the interior-change measurement and because
       you are meant to see the ring through it.
       glow: x the overall radiance gain, y how much of it the thinnest skin
       still sends. */
    cover: [2.6, 0.86],
    glow: [1.0, 0.92],
    dyeSharp: 70,        // source dye falloff: one body, laid down a little loosely
    lightShare: 0.45,    // most of any source's dye that is the lighter colour
    sourceRadius: 0.4,   // distance of the sources from the centre: inside the wall, so the water roams the face
    sourceSpeed: 0.17,   // radians per second of each source's slow sweep
    curl: 2.2,           // vorticity confinement at rest (the storm raises it, see uCurlStrength) -- hybrid: a little more than 1.5, so the local water the body sits in keeps some swirl
    velocityDecay: 1.6,  // PROMPT A (was 1.3): per second at rest -- a thicker liquid settles sooner (the storm still thins it)
    dyeDecay: 0.45,      // per second: the blob keeps its size instead of filling the face
    pressureKeep: 0.8,   // warm start for the Jacobi iterations
    maxAlpha: 0.7,       // readable coloured ink, without additive/white lighting
    curve: 1.6,          // above 1, faint dye fades out sooner than thick dye -- the WHISPY end only; a body with substance uses 1
    /* WHERE THE BODY ENDS, in its own ink, and how wide it is allowed to end
       over. edge/edgeBand is the settled body: a narrow band, so it has a
       defined edge and substance behind it. edgeWispy/edgeBandWispy is the
       same law opened right out for the whispy forms, and it is where the old
       single hard-coded `smoothstep(0.08, 0.65, amount)` lives on. The
       renderer interpolates between the two on how far the water has drained
       (material.mass), so nothing switches. */
    /* PROMPT A: these are levels of the body's OWN INK, so they have to move
       with how much ink it lays down. Raising `dye` 1.5 -> 1.9 without them
       measured a resting edge of 0.213 instead of 0.136 -- the crossing point
       slid out into the shallower tail of the same profile, which is the
       opposite of the defined edge that was asked for in the same breath as
       the heavy liquid. Scaled by the same 1.267 so the edge sits at the same
       place on the density profile as before. */
    edge: 0.507, edgeBand: 0.095,   // PROMPT A (were 0.4 / 0.075, scaled with TUNE.dye)
    edgeWispy: 0.08, edgeBandWispy: 0.42,
    /* 0.4 left too much colour under the readout to read the words over, and
       the body is now genuinely translucent as well, so what sits behind the
       text arrives on top of whatever the body is already passing. Still
       dimmed and not cleared, which is what was asked for; the crowd floor at
       0.12 already goes lower than this, so 0.2 is inside the range this veil
       is known to work over. */
    quietFloor: 0.2,     // colour behind the words: dimmed to 20%, not cleared (owner, 2026-09-15: the blob may pass under the text, "dim the parts directly behind the text")
    pointer: 1.0,        // fine-pointer stir strength
    /* JELLY BODY (2026-09-18). The solid body is drawn from the forms' OWN
       analytic field (src/home-circle-forms.js, read again in the display
       shader) rather than from the advected dye. The dye is kept for what a
       fluid is good at: the liquid trail and the thinking mist. See the
       display shader for the law; these are its numbers. Units: sigma of the
       form's own gaussian for distances, canvas uv for lengths, linear light
       for radiance. */
    jelly: {
      /* OPAQUE (owner, 2026-09-19 late): "drop the jelly / translucent effect
         ... bring back" the solid shaded blob of a few days ago, with the hard
         white shading softened. 1 = that blob: one colour, lit by the one
         light, a soft white catch, no see-through. 0 = the translucent
         material. The animations underneath are untouched either way. */
      opaque: 0,
      /* CLASSIC (owner, 2026-09-19 late, after looking it up): the blob of
         09-16 (d76a0daa, before the Builder rewrite) -- "light blue with a
         hard white on it". Soft water colour between the status colour's
         light and deep stops by thickness, shaded 0.72 + 0.28 lambert, a
         hard white sheen pow 56, alpha 0.5 * thick^1.6. Same law as that
         file's display pass, on today's forms, droplets and motion. 1 = that
         look; 0 = the material below. */
      classic: 0,          // 0: the Blob look the owner prefers (the 09-18 material); 1 = the 09-15 shading ported onto the dye
      edge: 1.18,          // where the body ends, in sigma of its own field: a fatter body than the dye ever showed
      /* PROMPT (colour): 2.0 was a hemisphere, and a hemisphere carries most
         of its AREA at nearly full thickness -- measured on this palette, only
         6% of the body's area let any paper through, because 80% of it was as
         thick as the middle. The thin material was real but there was hardly
         any of it. 1.5 spreads the same ramp over the disc (thickness at half
         the radius: 0.95 -> 0.89, at 0.85 of it: 0.53 -> 0.36), which doubles
         the clear band without touching the silhouette, and the roll-off at
         the very edge is if anything faster. The reference sweet reads its
         ground through 22% of its own area; this lands near that. */
      fat: 1.5,            // superellipse exponent of the thickness profile: under 2 the thickness ramp spans the whole disc, so there is a wide band of genuinely THIN material to be clear through
      height: 0.075,       // dome height in canvas uv: how far the surface turns over at the rim
      wrap: 0.5,           // how much the flank facing away from the one light darkens (the reference gummy's far side is much darker than its lit side)
      chroma: [1.7, 2.0],  // how much further out along its own chroma the CORE stop is pushed, dark and light themes (hue cannot move)
      clear: [0.45, 0.7],  // how much of its chroma the THIN stop keeps on dark and light grounds: thin is nearly colourless, as the reference's clear lower edge is; on paper a little more, or the body dissolves into it
      pathFloor: 0.05,     // optical path the thinnest rim still has: almost none, so thin is almost the bare illuminant, i.e. clear
      pathGain: 1.35,      // optical path added across the full thickness
      sssOut: 0.5,         // how much of its own optical path the scattered light makes on the way back out: it is absorbed like everything else, which is what stops the burst piling up in the core
      sss: [0.85, 2.6],     // light returned from inside, in the thick-end colour: strength, and how fast it builds with thickness -- the burst
      sssLight: 0.8,       // the same on a light ground, stronger: the burst there is density of colour, not light
      rim: [2.2, 2.5],
      glow: [1.1, 0.8, 2.0, 0.7], // LIGHT THROUGH THE BODY: the key enters the lit flank, crosses the material and leaves the far rim, brightest where the body is thin -- the backlit orange edge of the reference. strength on dark and light grounds, the far-side power, how much thick material blocks it
      inner: 0.03,         // THE LIGHT SEEN A SECOND TIME, off the inside of the back surface: a glass marble shows its lamp twice, mirrored on top and again, inverted and coloured by the material, low on the far side. Strength of that inner image against the hot core     // the glassy edge line where the surface turns away from the eye on a dark ground: gain, power (it carries its own coverage, so it stays crisp where the body is clear)
      rimLight: [1.8, 3.5], // the same line on a light ground, where it is the deep colour and has to hold the silhouette against paper
      line: 0.35,          // how much of the deep colour the edge line carries on a dark ground (1 on a light one): a coloured edge, not a grey one
      /* THE OPTICS MODULE'S OWN NUMBERS, set here because this is where the
         body's material is tuned. Everything below is uploaded straight to a
         uniform of src/home-circle-optics.js in display(); none of it existed
         as a lever before, because the four chunks that read these uniforms
         were pasted into the shader and never called.
         rimBias 0 keeps opticsRim() exactly the pow() the body used to run;
         raising it lifts only the outermost band, where a finite-difference
         normal can never turn fully sideways. */
      rimBias: 0,
      /* WHAT SITS BEHIND THE BODY for refraction to displace. There is no
         backdrop texture here, so the module's procedural ground is used and
         it is built from the PAGE's own ground: a disc of radius groundDisc
         lifted groundLift toward white (a body over nothing has nothing to be
         transparent against -- STANDARD-OPTICS section 3), with groundStripes
         cycles of structure across it, because displacement is invisible over
         a flat field. It is only ever seen THROUGH the body; this file never
         draws it on the canvas. */
      /* groundLift was 0.10 and that was too much: measured on the motion
         gate, the extra achromatic light widened the visible thin skirt
         (solid coverage 0.140 -> 0.256 of the crop, edge 0.168 -> 0.204 of
         the radius against a 0.15 bound) and dropped the gate's mean body
         chroma from 0.126 to 0.060. Pale and soft-edged are both owner
         rejections. 0.03 keeps the disc structured enough for refraction to
         have something to displace without inventing light the page has not
         got; a genuinely bright backdrop is the frame lane's, not a number
         this file can fake. */
      groundDisc: 0.42, groundLift: 0.03, groundStripes: 42,
      /* REFRACTION: index of refraction (gelatin is about 1.4), displacement
         in uv per unit of travel, dispersion (how far apart R and B land), and
         the travel the thinnest rim still has -- a gummy has a fat edge, not a
         knife edge, and the rim is where the surface turns hardest. */
      ior: 1.42, displace: 0.08, dispersion: 0.06, rimTravel: 0.5,
      /* THE TWO CAUSTICS: strength of the one that lands on the ground behind
         the body (seen through it, never outside it -- the offset blob the
         owner rejected is not this), the fraction of the optical path that
         light takes, how far up-light the body is sampled, and the strength of
         the inner caustic where the body's own curvature converges the light. */
      caustic: [0.7, 2.5, 0.035, 18.0],
      warp: 0.14,          // how far the fluid's own velocity bends the body, in uv per uv/s -- HYBRID (owner): the classic base's fluid movement on the blob's look, so the body flows with its water instead of sliding as a solid
      trail: 0.0,          // the fluid trail is no longer thresholded into the solid; the liquid layer draws it (see the display shader)
      band: 3.0,           // how much fatter the tool bands are drawn than the area-conserving sigma the dye is fed
      /* COVERAGE IS SOLVED PER PIXEL PER THEME NOW, and these two numbers are
         the only part of it left to a person. The law and its derivation are
         in the display shader ("COVERAGE IS SOLVED, NOT PICKED"); the short
         version is that for a wanted colour over a known ground there is
         exactly one coverage that reaches it -- anything less is the owner's
         "pale", anything more is his "solid not like gelatin" -- and it is a
         different number on every theme.

         Owner, 2026-09-18, on the 0.97 mass: "the character looks solid not
         like gelatin"; and on the 0.78 that preceded it, that it looked pale.
         Both were true, and neither could be fixed by moving the same number
         again: over white paper this material's own core needs 99% coverage
         to be the deep red it is, and over black it needs 65%. Two hand-set
         numbers for five grounds is one number too few by three.

         THE FLOOR is not colour, it is silhouette: where the material really
         is clear (the outer band) the solve asks for almost no coverage, and
         a body that fades out over a wide skirt is the soft halo the owner
         rejected. 0.18 keeps a defined edge and still shows four fifths of
         the page through the rim.

         THE CEILING IS THE ONE DELIBERATE COMPROMISE IN THIS FILE. On paper
         the honest answer is 99%: a deep red over near-white simply has to
         cover it (so does the reference sweet -- no mint reads through its
         thick slab, measured, 44% of its area is opaque crimson). But
         "transparent" is the owner's most repeated word, so the core keeps a
         tenth of the page visible through even its thickest point. Measured
         cost of that tenth, over white: Oklab dE 0.013 at the core, against
         the 0.04 where two colours stop reading as the same. It buys the page
         showing through the whole body -- 12% of the area on white against 6%
         at the true minimum -- for an eighth of a just-noticeable difference.
         Below about 0.82 the cost turns steep (dE 0.032 and climbing) and the
         core starts to wash: that is the wall the last two attempts hit. */
      opacity: [0.18, 0.90],  // coverage: the floor the thinnest rim always carries, and the ceiling the thickest core may not pass
      opacityCurve: 1.04,     // margin over the solved coverage: 1.0 is exactly the minimum that carries the colour, and the extra 4% absorbs 8-bit rounding and the dither
      /* TRANSLUCENCY -- and the reason the coverage solve on its own could
         never deliver any. The solve picks the alpha that reproduces `want`
         over the known ground, and then forces the paint to
         (want - (1 - a) * ground) / a, so the composite is `want` EXACTLY, for
         every a, on every theme. It cancels the ground out by construction.
         Lowering the alpha does nothing at all, because the paint compensates
         for it in the same statement. That is why the body reads opaque on all
         five themes however the numbers here are moved, and it is the owner's
         first complaint.
         So the ground-cancelling paint is now what the body reaches only where
         it is THICK. seeThrough[0] is the optical depth the coverage is taken
         over -- it is Beer-Lambert in the body's own thickness, 0 at the
         silhouette and nearly 1 in the mass -- and it blends between two
         paints that are both correct and mean different things: the forced
         paint (the colour the material HAS, ground removed) in the mass, and
         the material's own colour laid on unforced at the rim, where most of
         what reaches the eye is the ground behind it.
         seeThrough[1] is how much of the solved coverage the thinnest skin
         keeps. Below the opacity floor it has no effect; above it, it is how
         hard the rim still holds the page down. */
      /* Looked at on black and white at every form. [2.6, 0.3] put the ground
         through the body properly and took the TOOL form with it: its orbit
         bands are thin material over their whole width, so nothing in them
         ever reached the thick end of the curve and on a dark ground the whole
         shape washed out to smoke. Translucency reads as light on paper and as
         absence on black, so the thin end has to keep more than a third of its
         coverage or the dark themes lose forms that are thin by design.
         [0] raised so the mass locks in sooner, [1] so the thin end still
         holds the page down about half. */
      seeThrough: [3.4, 0.55],
      /* CHARACTER PIECES (stepDrops). speed is how fast the body has to be
         going before it leaves any of itself behind, in canvas uv per second;
         every is the shortest gap between two of them, which is what keeps it
         "a few" rather than a stream; life is how long one lasts. behind is
         where it is shed, in body scales back along the travel; keep is the
         share of the body's speed it leaves with (under 1, so it falls
         behind); pull is how hard it is drawn home, and it is scaled by age,
         so the piece lags, hangs, and comes back; drag is the water it is
         moving through. size is its own sigma and weight is how much field it
         carries -- under the body's own 1, so it is a piece OF the body and
         reads thinner than the mass it came from. home is how close it has to
         get before it is let go, by which point the smooth minimum has already
         closed the union over it.
         speed is set against what the body actually does, measured on the
         running page rather than picked: an ordinary idle wander tops out at
         0.0600 canvas uv/s over 40 s, while a goal reaches 0.24 and a rebound
         0.30. At 0.085 the body at rest sheds nothing at all -- which is the
         point, these come off TRAVEL -- and any purposeful move sheds. It was
         briefly 0.12, which is above everything the body does short of a
         bounce, and the mechanism then never ran; and at 0.03, used once to
         watch it work, it shed 11 pieces in 40 s, which is a stream and not
         "a few". */
      drops: { speed: 0.085, every: 0.42, life: 0.85, behind: 0.055, keep: 0.55, pull: 26, drag: 2.2, size: 0.016, weight: 0.8, home: 0.045 },
      pass: 1.0,           // how much of the ground the body passes over its own round trip (1 = in and out, the physical answer; the shader's `sheet`)
      warm: 28,            // degrees the THIN end is turned toward amber, so thick -> thin runs crimson -> orange -> amber as in the reference
      /* EXPOSURE IS SOLVED TOO, against a declared lightness, and that is what
         makes this ONE material on five themes rather than five materials.
         The stops the frame declares are tokens (L .80 thin, .62/.42 thick);
         what a person actually sees is those stops carried through the
         absorber, a tonemap and an exposure, and the exposure was the thing
         nobody had a number for. Two hand-set gains (1.9 dark, 1.15 light)
         put the core at Oklab L 0.66-0.73 on the three dark themes and 0.54
         on the two light ones -- a bright salmon bead against a deep crimson,
         i.e. not the same material at all, which is exactly what the owner
         kept seeing. So the core's LIGHTNESS is declared here and readPalette
         solves the exposure each theme needs to land on it (bisection, 40
         steps, in readPalette). Solved values on the shipped palettes:
         white 0.265, tan 0.343, black 0.364, ember 0.472, cobalt 0.354.
         The reference gummy's thick slab measures Oklab L 0.494 (its darkest
         third, 0.417); 0.52/0.50 sits just above it, inside the 0.45-0.70 the
         brief asks of the core, and leaves the dark themes a body that is
         twice the lightness of their own ground. */
      coreL: [0.60, 0.50],   // the Oklab lightness the THICK CORE lands on, dark grounds and light grounds
      gain: [0.05, 8],     // the exposure the solve may spend to get there: bounds, not values (a flat or unreadable palette cannot run away with it)
      mist: [2.3, 1.35],   // the exposure the LIQUID TRAIL and the THINKING MIST keep, dark and light: they are drawn over the ground, not through it, so the solve above is not theirs (these are the two gains the body used to share)
      /* CROWDING: how much of the canvas the caption's box takes (half-extents
         product, from measureQuiet) at which the disc counts as crowded: 0 at
         a 500 px disc (about 0.05), 1 from 0.17 (a 250 px disc, where the
         caption is most of the face). Crowding shrinks the body, steers the
         seat out of the caption's band and lets the veil bite harder, so the
         agent name stays readable on a small disc without giving up the
         wandering on a large one. */
      crowd: { from: 0.05, to: 0.17, shrink: 0.4, steer: 0.8, floor: 0.12 },
      /* land / landAt: the SECOND kick, delivered when the material has
         finished gathering rather than when the action changed (see
         materialDrive). landAt is read against the display shader's own
         `solid` scalar, so 0.85 is "the body is really there now". land is
         a little stronger than the form-change kick (0.55) because an
         arrival from mist is the largest change the body makes.
         MEASURED, not picked. At landAt 0.85 the kick lands while the body
         is still drawing itself in and the ring is buried in that motion:
         on the motion gate the silhouette still read one crossing of rest.
         Read on the live page with the spring and the cropped silhouette
         sampled on the SAME frames
         (.lane-scratch/w4-shader/width-and-jig.mjs), the ring is real --
         width 89 -> 112 -> 97 -> 107 -> 102 -> 106 px against a rest of
         about 107 while jig ran +0.14 -> -0.09 -> +0.06 -- so the fix is
         to land it on a body that has stopped arriving, not to make the
         spring louder for its own sake.
         landAt is 0.8 and not higher for a reason that is arithmetic, not
         taste: `want` in materialDrive is (1 - wisp) * (0.9 + 0.1 * merge),
         so with the base character part-way through joining, the mass the
         body settles at runs 0.82 to 0.91 and the `solid` scalar built
         from it never reaches 0.93 on some frames. At landAt 0.93 the kick
         simply never fired and the gate read ZERO crossings, which is
         worse than the one it read before. Measured, both ways. */
      jiggle: { hz: 4.6, damping: 0.16, kick: 7.0, max: 0.3, land: 1.1, landAt: 0.8, landSlack: 0.06 } // the damped spring the shape rings down on after a bounce: a full-speed wall hit squashes ~24%, a change of form ~13% (kick / (2 pi hz)), ringing down over about 0.6 s
    }
  };

  var WARMUP = 10;       // steps ignored after start, resume or a change
  var WINDOW = 16;       // steps per judgement
  var PROBE_EVERY = 8;   // steps per GPU-synced cost probe within a window

  var stats = { state: 'waiting', reason: '', level: -1, webgl: 0, raf: 0, steps: 0,
    medianMs: 0, workMs: 0, fullMs: null, changes: [], note: '' };
  var gl = null, canvas = null, F = null, P = null, T = null;
  var level = SMALL_START, running = false, dead = false, shown = false, gone = false;
  var rafId = 0, lastStep = 0, warm = WARMUP, strikes = 0;
  var intervals = [], works = [], probes = [], probePixel = new Uint8Array(4);
  var onScreen = false, booted = false, paletteDirty = true;
  var palette = { light: [0.58, 0.85, 0.73], deep: [0.15, 0.6, 0.39], fast: [0.58, 0.85, 0.73], slow: [0.15, 0.6, 0.39], absorb: [1.35, 0.35, 0.63], absorb2: [1.35, 0.35, 0.63], dark: false, // PROMPT E/F: absorb seeded to match the default stops; the second dye seeds to the first, which is no hue shift until a palette is read
    arc: { start: 130, light: 195, deep: 246, end: 332 }, intensity: 1 };
  /* The box behind the words: half-extents, then where its middle sits relative to the ring's, both as fractions
     of the canvas. quietAt is in the shader's p units, so its y runs UP. */
  var quiet = [0.3, 0.22], quietAt = [0, 0], quietMeasured = false;
  /* JELLY BODY: the environment the surface mirrors and the skin it carries
     (src/home-circle-optics.js). A stretched softbox above and in front with a
     hot core inside it -- the wet streak -- and a dimmer fill opposite. */
  var optics = opticsDefaults();
  /* Both directions have x = 0 on purpose: opticsEnvironment stretches the
     REFLECTED direction sideways before comparing it with these, so a key with
     a sideways component can only be matched by a surface turned far to that
     side. Straight above and in front, the softbox is a horizontal streak
     across the top of the dome and the hot core sits inside it. */
  optics.uOpticsEnvKey = [0, 0.6, 0.8, 0.9];
  /* THE CATCH CANNOT BE SHARPER THAN THE SURFACE IT SITS ON, and at w = 0.93
     it was. w is where the hot core BEGINS, and opticsEnvironment ramps it
     over smoothstep(w, 1.0, dot): at 0.93 the whole catch was built inside
     0.07 of dot, while the body's own shading spends the entire remaining
     0.93 getting there. That is a boundary an order of magnitude tighter than
     anything else on the body -- measured by the owner as 2.1x sharper than
     the silhouette on black -- which is what makes it read as a decal stuck
     on rather than light on jelly. Opened to 0.72, so the catch is built over
     0.28 of dot and its own falloff is the same order as the dome's.
     0.72 opened it too far the other way -- looked at on black, the catch was
     a broad pale bloom over the whole top of the dome, which is a wash over
     the body and the thing that gets called a sheen. 0.82 is a patch rather
     than a band and still has two and a half times the original's falloff to
     fade over. */
  optics.uOpticsEnvCatch = [0, 0.62, 0.78, 0.82]; // the hard white catch of the 09-18 blob, as it was
  /* T259 item (2), "gloss and lighting layers over the bubble (said four
     times)": the broad softbox band and its fill are OFF. On a small round
     body a broad pale band across the dome reads as a sheen laid over it, the
     thing he keeps rejecting, and it is the one light term here that is not
     either the material or the single hard catch the reference has. What
     stays is the hot core (the wet catch) and the dim studio ambient. */
  /* 160 IS WHY THE PATCH WAS FLAT, AND FLAT IS HALF OF WHAT MAKES IT A DECAL.
     The catch reaches the screen through `body += (1 - body) * (1 - exp(-mirror))`
     with mirror = env * Fresnel. Face-on Fresnel here is ~0.028, so a hot core
     of 160 arrives as mirror ~4.4 and 1 - exp(-4.4) = 0.988: the catch is
     pinned at white over its whole middle, every value inside it rounds to the
     same white, and the only edge left is where it stops -- a flat white patch
     with a hard boundary, which is exactly what was rejected. The number that
     matters is the PEAK of mirror, not the radiance: at ~1.0 the catch lands
     around 0.63 of the way to white and still has a gradient all the way
     through it, so it reads as a bright reflection rather than a sticker.
     STRETCH. z compresses the reflected direction's x by this much before it
     is compared with the catch direction, so at 3.5 the catch's contours were
     set almost entirely by d.y: horizontal bands across a round body, which is
     the second half of the straight edge (the first is the horizon knee in
     opticsEnvironment). At 1.8 the catch is an oval lying along the dome. */
  /* The hot core's radiance is DERIVED from the peak it is allowed to reach
     rather than picked. The catch arrives on the body multiplied by the
     face-on Fresnel of this material (Schlick's f0 for its own index), so the
     radiance that lands exactly on TUNE.catchPeak is that peak divided by it.
     Written as a number it was 160, which is over thirty times what the
     ceiling allows, and all of the excess was spent flattening the catch
     against white. Derived, it cannot drift away from the ceiling again when
     the index is retuned. */
  var catchF0 = Math.pow((TUNE.jelly.ior - 1) / (TUNE.jelly.ior + 1), 2);
  optics.uOpticsEnvLevels = [0, TUNE.catchPeak / catchF0, 1.8, 0];
  optics.uOpticsSkin = [0.05, 9, 0];
  var pointer = null;
  var observer = null, resizer = null, settingsWatch = null, nearWatch = null;
  var retiringCanvases = new Set();

  /* ------------------------------------------------------------ diagnostics */

  /* The material's own colour at one end of its thickness, as the shader would
     draw it flat-on with no reflection: illuminant through the absorber over
     that end's path, one-scalar tonemap, sRGB. */
  function materialStop(end) {
    var j = palette.jelly;
    if (!j) return Array.from(palette.light);
    var path = TUNE.jelly.pathFloor + (end === 'core' ? TUNE.jelly.pathGain : 0);
    var lin = j.illum.map(function (v, i) { return v * Math.exp(-j.absorb[i] * path); });
    var over = Math.max(lin[0], lin[1], lin[2]);
    var tone = over < 0.8 ? over : 0.8 + 0.2 * (1 - Math.exp(-(over - 0.8) / 0.2));
    return lin.map(function (v) {
      var x = v * tone / Math.max(over, 1e-4);
      return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    });
  }
  function setState(state, reason) {
    stats.state = state;
    /* The reason describes why the loop is NOT running, so a running loop
       carries none: a boot-time `no-frame` must not outlive the first real
       frame, or a harness that refuses on the reason is misled. */
    if (state === 'running') reason = '';
    if (reason || state === 'running') stats.reason = reason;
    visual.setAttribute('data-fluid-state', state);
    if (reason) visual.setAttribute('data-fluid-reason', reason);
    else if (state === 'running') visual.removeAttribute('data-fluid-reason');
  }

  try {
    ring.homeCircleFluid = Object.freeze({
      play: function () { return startEpisode('api'); },
      stats: function () {
        var q = LADDER[level] || {};
        return JSON.parse(JSON.stringify({
          state: stats.state, reason: stats.reason, level: stats.level, webgl: stats.webgl,
          sim: q.sim, dye: q.dye, iterations: q.iterations, fps: q.fps,
          canvas: canvas ? [canvas.width, canvas.height] : null,
          deterministic: fixedDt ? { seed: testHook.seed, dt: fixedDt } : null,
          raf: stats.raf, steps: stats.steps, medianMs: stats.medianMs, workMs: stats.workMs, fullMs: stats.fullMs,
          changes: stats.changes, note: stats.note, intensity: Math.round(palette.intensity * 100) / 100,
          extras: { on: extrasOn, personality: extras.personality, blowup: extras.blowup, voice: extras.voice },
          episode: episode ? { phase: episode.phase || 'rest', elapsed: episode.t, tau: episode.tau, reason: episode.reason } : null, played: played,
          flow: { original: drive.original, torque: drive.torque, strain: drive.sink[0], pulses: [drive.pulse[2], drive.pulse[6]] },
          agent: { action: agent.action, name: agent.name, key: agent.key, event: agent.event, kicks: agent.kicks,
            motion: agent.motion, animation: agent.animation, character: Array.from(agent.character), actionRest: agent.rest.active, parts: Array.from(agent.parts.pose), angles: Array.from(agent.parts.angles),
            partSpin: Array.from(agent.parts.spin), ring: Array.from(agent.parts.ring), ringTurn: Array.from(agent.parts.turn),
            ringSpin: Array.from(agent.parts.ringSpin), elapsed: Math.round((clock - agent.since) * 1000) / 1000 },
          material: { mass: Math.round(material.mass * 1e4) / 1e4, wisp: Math.round(drive.wisp * 1e4) / 1e4 },
          // BLOB LOOK: the two stops the material is mixed between. A probe
          // can then bound the brightest pixel against the brightest colour
          // the material HAS, which is the exact claim absorption makes -- it
          // only ever removes light from the light stop -- and a specular
          // breaks. PROMPT E: the relief is inside that same exponent now, so
          // the claim covers the shading too.
          /* JELLY: `illum` is the value actually sent to uLight -- the light
             stop times the illuminant -- so a probe that wants to bound the
             brightest pixel the material can draw has the right number to
             bound it against. light/deep stay the ledger's two stops. */
          /* JELLY BODY: a probe that splits the body from its catch by "brighter
             than the brightest colour the material HAS" (tools/home-circle-form-qa.mjs
             reads stops.light for exactly that) needs the material's own ends,
             not the ledger's storm stops: the thin end after exposure and the
             tonemap, and the core end, both encoded to sRGB like the pixels.
             ledger keeps the two stops the mist is still coloured from. */
          stops: { light: materialStop('thin'), deep: materialStop('core'), illum: Array.from(palette.illum || palette.light),
            ledger: { light: Array.from(palette.light), deep: Array.from(palette.deep) } },
          mood: { name: mood.name }, storm: Math.round(storm.level * 100) / 100, seat: { deg: Math.round(seat.deg), radius: Math.round(seat.radius * 100) / 100, x: Math.round(seat.x * 1e4) / 1e4, y: Math.round(seat.y * 1e4) / 1e4, pace: Math.round(seat.pace * 1000) / 1000,
            face: Math.round(seat.face * 18000 / Math.PI) / 100, speed: Math.round(seat.speed * 1e4) / 1e4, vx: seat.vx, vy: seat.vy, bounceAge: clock - seat.bounced, wallRadius: seat.wallRadius,
            moving: Math.round(seat.moving * 100) / 100, clock: Math.round(clock * 1e3) / 1e3, jig: Math.round((seat.jig || 0) * 1e4) / 1e4 },
          /* CHARACTER PIECES: how many are out right now and how many have
             been shed since the mount. Reported because "a few, brief" is a
             claim about a rate, and a rate cannot be read off a screenshot --
             a still frame cannot tell one piece a second from a stream. */
          drops: { live: drops.filter(function (d) { return d.life > 0; }).length, shed: dropsShed },
          quietBox: { half: quiet, at: quietAt },
          gesture: { split: persona.split ? Math.round((clock - persona.split.t) * 10) / 10 : null, turn: persona.turn ? persona.turn.dir : null },
          voice: { state: voice.state, mode: voice.mode || 'off', heard: voice.heard || '', flourish: voice.flourish ? voice.flourish.name : '',
            level: Math.round(voice.level * 1000) / 1000 }
        }));
      }
    });
  } catch (error) { /* diagnostics are optional */ }

  /* ------------------------------------------------------------ gates */

  var motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function saveData() {
    var connection = navigator.connection;
    if (connection && connection.saveData) return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-data: reduce)').matches);
  }

  function glowValue() {
    var raw = parseFloat(getComputedStyle(root).getPropertyValue('--glow'));
    return Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1;
  }

  /* The circle's own settings decide first, exactly as home-circle.css treats its sweep: the app's Reduce motion always
     stops it; Motion "Still" never animates; "System" follows the OS; "Animate" is an explicit opt-in. Glow 0: nothing
     glows, so nothing runs. */
  function blocked() {
    var choice = ring.dataset.circleMotion || 'system';
    if (document.body && document.body.classList.contains('reduce-motion')) return 'reduced-motion';
    if (choice === 'still') return 'still';
    if (choice !== 'animate' && motion && motion.matches) return 'reduced-motion';
    if (glowValue() <= 0) return 'glow-off';
    if (saveData()) return 'save-data';
    if (!window.IntersectionObserver) return 'unsupported';
    return '';
  }

  /* ------------------------------------------------------------ colour */
  var probe2d = null;
  function rgba(css) {
    try {
      if (!probe2d) {
        var c = document.createElement('canvas');
        c.width = c.height = 1;
        probe2d = c.getContext('2d', { willReadFrequently: true });
      }
      probe2d.clearRect(0, 0, 1, 1);
      probe2d.fillStyle = '#000';
      probe2d.fillStyle = css;
      probe2d.fillRect(0, 0, 1, 1);
      var d = probe2d.getImageData(0, 0, 1, 1).data;
      /* getImageData answers un-premultiplied bytes. */
      return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
    } catch (error) { return null; }
  }

  function luminance(c) {
    var f = function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }

  function hue(c) {
    var max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]), d = max - min;
    if (d < 0.0001) return -1;
    var h = max === c[0] ? ((c[1] - c[2]) / d) % 6 : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
    return (h * 60 + 360) % 360;
  }

  function mixed(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* Same hue, set lightness, saturation at least `saturation`. On a light
     ground a dark translucent colour reads as a smudge, so the light themes
     lift both colours into light, clear tints of their own hue. */
  /* PROMPT F: `turn` rotates the hue and leaves everything else alone, which
     is what the second dye needs -- the ledger's own stop at its own lightness
     and saturation, moved along the wheel and nowhere else. */
  function lifted(c, lightness, saturation, turn) {
    var max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
    var l = (max + min) / 2, d = max - min;
    var s = d < 0.0001 ? 0 : d / (1 - Math.abs(2 * l - 1));
    var h = hue(c);
    if (h < 0) return [lightness, lightness, lightness];
    h = ((h + (turn || 0)) % 360 + 360) % 360;
    s = Math.max(s, saturation);
    var k = (1 - Math.abs(2 * lightness - 1)) * s, x = k * (1 - Math.abs((h / 60) % 2 - 1)), m = lightness - k / 2;
    var rgb = h < 60 ? [k, x, 0] : h < 120 ? [x, k, 0] : h < 180 ? [0, k, x] : h < 240 ? [0, x, k] : h < 300 ? [x, 0, k] : [k, 0, x];
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  }

  function ungilded(c) {
    var h = hue(c);
    if (h < 30 || h > 75) return c;
    var l = (Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 2;
    return mixed([l, l, l], c, 0.25);
  }

  /* The ring's ledger colour (clear, owner requests, blocked, or neutral
     while unknown) supplies saturated ink and a darker
     shade of the same hue. Strength follows its glow token and Glow setting, so
     "unknown" stays faint and Glow 0 is off. */
  /* Move a colour along its own chroma axis and its own lightness at once.
     `spread` opens the gap between the channels around their midpoint, which is
     what keeps a darkened colour rich instead of grey; `level` is the lightness
     it lands on. Both clamp, so a status colour that is already at an extreme
     cannot be pushed out of range. */
  function chroma(c, spread, level) {
    var hi = Math.max(c[0], c[1], c[2]), lo = Math.min(c[0], c[1], c[2]), mid = (hi + lo) / 2;
    /* NOTHING IS CLAMPED PER CHANNEL, and that is the whole care in this
       function. Clipping one channel and not the others slides a colour off
       its own hue and toward white, which is the one thing this renderer is
       not allowed to do. So both ends are handled by backing the WHOLE colour
       off instead: the spread is capped at the point where the darkest channel
       would reach 0, and the level is capped at the point where the brightest
       would reach 1. Hue survives both, because both are uniform in the terms
       the hue is made of. */
    if (mid > lo) spread = Math.min(spread, mid / (mid - lo));
    var out = c.map(function (channel) { return (channel - mid) * spread + mid; });
    var top = Math.max(out[0], out[1], out[2]) * level;
    var scale = top > 1 ? level / top : level;
    return out.map(function (channel) { return Math.max(0, Math.min(1, channel * scale)); });
  }

  function readPalette() {
    paletteDirty = false;
    var styles = getComputedStyle(ring);
    var status = rgba(styles.getPropertyValue('--core-status-color').trim()) || [0.4, 0.45, 0.5, 1];
    if (status[3] < 0.5) status = [0.4, 0.45, 0.5, 1];
    var ground = rgba(getComputedStyle(document.body).backgroundColor) || [1, 1, 1, 1];
    if (ground[3] < 0.5) ground = rgba(getComputedStyle(root).getPropertyValue('--bg').trim() || '#fff') || [1, 1, 1, 1];
    /* JELLY BODY: what is actually behind the body is the ring's own face
       (the ::before disc, src/home-circle.css), which the frame lane now
       lights on every theme. The body's exposure, the environment it mirrors
       and its shadow follow THAT ground, not the page's. A gradient is read
       at its first colour stop; a plain colour as itself; anything unreadable
       leaves the page ground in place. */
    try {
      var face = getComputedStyle(ring, '::before') || {};
      var image = String(face.backgroundImage || ''), stop = image.match(/(?:oklch|oklab|lab|lch|hsla?|rgba?|color)\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]{3,8}/i);
      var behind = rgba((stop && stop[0]) || face.backgroundColor || '');
      if (behind && behind[3] >= 0.5) ground = behind;
    } catch (error) { /* the page ground stands */ }
    palette.dark = luminance(ground) < 0.2;
    // Keep the ring's hue. Mixing with white and lowering output alpha
    // independently of RGB produced the milky/glossy wash on dark themes.
    /* BLOB LOOK -- WHY THE BODY READ MUDDY. `deep` was `channel * 0.72`, a flat
       multiply toward black. That keeps the RGB ratios identical, which sounds
       right and is exactly what makes it look wrong: perceived chroma falls
       with lightness, so a flat multiply of a mid-saturation colour lands on
       something greyer than it started. On the maroon the ledger uses for
       blocked, against the warm paper default, that is the muddy flat fill the
       owner reported.
       So the two stops are separated in CHROMA as well as lightness. Darkening
       pushes the channels further apart around their own midpoint, which holds
       the colour's identity as it goes down; lifting does the mirror of it.
       Both are derived from whatever --core-status-color is, so the ledger
       still owns the hue and every status and theme gets the same treatment. */
    var colour = status.slice(0, 3);
    palette.statusSRGB = colour.slice();
    /* PROMPT B -- THE BODY HAS TO READ AGAINST ITS OWN GROUND.
       The stops were derived from the status colour alone, so the blob painted
       the SAME mid-dark crimson whatever it was sitting on. Measured with
       assertVisibleInk, strongest difference from the backdrop: 133 on warm
       paper, and 16 on cobalt, 20 on black, 15 on ember -- dark on dark, and
       ember failed the visible-ink floor outright. It was not the jelly work:
       the same measurement with transmission turned off gives 10 to 23 on
       cobalt, so this predates PROMPT B and the guard simply surfaced it.
       palette.dark was already computed here and only spent on intensity. Now
       it lifts both stops, which is the same move as everywhere else in this
       function: chroma() holds the hue exactly and cannot lose saturation, so
       the ledger still owns the colour and it is only carried to a lightness
       that survives the ground it is on. */
    /* deep lifts LESS than light does. At 0.86 the two stops came within 77%
       of each other in luminance for a bright status, which is the flat body
       BLOB LOOK exists to prevent -- my own gradient assertion caught it. The
       visibility on a dark ground comes from the light stop; the deep stop's
       job is to stay far enough below it that the mass still reads. */
    palette.deep = chroma(colour, 1.45, palette.dark ? 0.70 : 0.52);
    /* PROMPT F -- THE LIGHT STOP WAS LIFTED TOO FAR ON A LIGHT GROUND, and
       the guard that asked for the lift is the one that says so now. It was
       1.05, which takes the stop to the top of its range: a near-white tint.
       Most of the body sits near the light stop, so on warm paper the body
       measured a median saturation of 0.083 -- a grey ghost, against 0.83
       through the owner's reference gummy -- and the thin skin faded INTO the
       paper instead of glowing through it, which is the "lit through, not lit
       on" the reference shows and this did not.
       The lift was measured when the body was one flat value, where lightness
       was the only difference from the ground it had. It has absorption depth
       now, so a saturated mid-tone differs from pale paper in chroma as well,
       and assertVisibleInk agrees: measured on the same probe, strongest
       difference from the backdrop went 80 (1.05) -> 134 (0.95) -> 147 (0.90)
       -> 144 (0.86) while median saturation went 0.083 -> 0.174 -> 0.301 ->
       0.303. 0.90 is the best of both and it is not a compromise against the
       original guard, it is a better score on it.
       Dark themes are untouched: on a dark ground the lift IS the visibility,
       and that is where the 1.5 was actually earned. */
    palette.light = chroma(colour, 1.18, palette.dark ? 1.5 : 0.90);
    /* The storm stops are de-gilded: a curl-lit yellow/amber ring reads as a
       gold sheen, which is the look the owner rejected. ungilded() pulls only
       that hue band toward its own lightness and leaves every other hue alone.
       Assigning light/deep straight across here is what left ungilded() with
       no callers at all. */
    palette.fast = ungilded(palette.light); palette.slow = ungilded(palette.deep);
    /* PROMPT E: the absorption coefficient that carries the light stop to the
       deep stop over one thickness, per channel. Solving exp(-k) = deep/light
       for k is just -log of the ratio. Both stops are the ledger's, so the
       material still cannot pick a hue of its own; this only decides the SHAPE
       of the journey between them. The floor keeps a channel that is already
       near zero from producing an infinite coefficient. */
    palette.absorb = palette.light.map(function (channel, i) {
      return Math.max(0, Math.min(6, -Math.log(Math.max(1e-3, palette.deep[i]) / Math.max(1e-3, channel))));
    });
    /* PROMPT F: the second dye's coefficient, derived exactly like the first
       and from the same stop, with only its hue turned. Same lightness and the
       deep stop's own saturation, so this dye cannot make the material
       brighter, paler or flatter -- only differently coloured on the way down.
       lifted() had no callers at all before this; it is the one function here
       that rebuilds a colour at a chosen hue. */
    var deepMax = Math.max(palette.deep[0], palette.deep[1], palette.deep[2]);
    var deepMin = Math.min(palette.deep[0], palette.deep[1], palette.deep[2]);
    var turned = lifted(palette.deep, (deepMax + deepMin) / 2, 0, TUNE.dyeTurn);
    palette.absorb2 = palette.light.map(function (channel, i) {
      return Math.max(0, Math.min(6, -Math.log(Math.max(1e-3, turned[i]) / Math.max(1e-3, channel))));
    });
    var trail = parseFloat(styles.getPropertyValue('--core-glow-trail'));
    if (!Number.isFinite(trail)) trail = palette.dark ? 0.75 : 0.5;
    palette.intensity = Math.max(0.12, Math.min(1.5, trail / (palette.dark ? 0.75 : 0.5))) * glowValue();
    /* JELLY -- THE ILLUMINANT. The colour law is uLight * exp(-absorption), so
       whatever is in uLight is the brightest thing the material can be. Sending
       the light STOP there gave the body a colour swatch for a ceiling, and
       that ceiling -- not the absorption, not the alpha, not the stops -- is
       why the core measured 0.06-0.13 luminance against 0.45-0.70.
       The illuminant is the stop times how much light is falling on it. The
       hue and the channel ratios are the ledger's, untouched: this multiplies
       all three channels by the same number, so chroma()'s guarantee survives
       it exactly, and the tonemap in the shader brings the result back into
       range with one scalar for the same reason. The absorber is still derived
       from the two UNSCALED stops above, so the shape of the journey from thin
       to thick is unchanged -- only the amount of light making it is. */
    palette.illum = palette.light.map(function (channel) { return channel * TUNE.illum; });
    /* JELLY BODY -- THE MATERIAL, IN LINEAR LIGHT. The frame declares the
       roles (src/home-circle.css: --jelly-illuminant, --jelly-body-deep,
       --jelly-body-core) as OKLCh moves on the accent's own hue. A token is
       used only when it still carries the ledger's hue -- a token off the hue
       is a broken token, and then the same roles are derived from the status
       colour with chroma(), which cannot leave the hue either. Everything is
       decoded to linear once here; the shader encodes once at the end. */
    var statusHue = hue(colour);
    var token = function (name) {
      var v = rgba(styles.getPropertyValue(name).trim());
      if (!v || v[3] < 0.5) return null;
      var h = hue(v), gap = h < 0 || statusHue < 0 ? 999 : Math.abs(((h - statusHue + 540) % 360) - 180);
      return gap <= 20 ? v.slice(0, 3) : null;
    };
    var lin = function (c) { return c.map(function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); };
    /* The two ENDS of the material are the frame's own stops: the thinnest rim
       lands exactly on --jelly-body-thin and the full thickness exactly on
       --jelly-body-deep (both linear). Beer-Lambert decides the curve between
       them, per channel, and the illuminant is whatever light it takes to land
       the rim on the thin stop after the rim's own path -- so the tokens own the
       colour and the physics owns only the journey. The gain is exposure: it
       lifts both ends together into the tonemap's shoulder. */
    /* HAPPY IS HIGH KEY AND SATURATED (STANDARD-HAPPY-AND-MERGE, B1/B2). The
       thick end is the CORE token (L .62), not the deep one (L .42): a body
       whose mass sits at L .42 on a near-black ground is low-key lighting,
       which is the vocabulary of drama, not of a sweet. Both ends are pushed
       out along their own chroma with chroma(), which cannot move the hue. */
    var richer = palette.dark ? TUNE.jelly.chroma[0] : TUNE.jelly.chroma[1];
    var thinS = chroma(token('--jelly-body-thin') || chroma(colour, 1.25, 0.95), palette.dark ? TUNE.jelly.clear[0] : TUNE.jelly.clear[1], 1);
    /* the thin end turned toward amber at its own lightness and saturation: the
       reference's crimson -> orange -> amber travel, which is hue travel INSIDE
       the body (STANDARD-HAPPY B3), not a change to the ledger's stops */
    var thinMax = Math.max(thinS[0], thinS[1], thinS[2]), thinMin = Math.min(thinS[0], thinS[1], thinS[2]);
    var thin = lin(lifted(thinS, (thinMax + thinMin) / 2, 0, TUNE.jelly.warm));
    /* On a bright ground the thick end is the DEEP stop (L .42), not the core
       (L .62): against paper the core stop is a pastel and the reference's
       thick top is deep crimson; on a dark ground the core stop stays, or the
       body sinks into the ground. */
    var core = lin(chroma(token(palette.dark ? '--jelly-body-core' : '--jelly-body-deep') || chroma(colour, 1.2, palette.dark ? 0.85 : 0.55), richer, 1));
    var gain = palette.dark ? TUNE.jelly.mist[0] : TUNE.jelly.mist[1];
    var absorb = thin.map(function (channel, i) { return Math.max(0, Math.min(8, -Math.log(Math.max(1e-3, core[i]) / Math.max(1e-3, channel)) / TUNE.jelly.pathGain)); });
    var illum = thin.map(function (channel, i) { return channel * Math.exp(absorb[i] * TUNE.jelly.pathFloor); });
    /* THE BODY'S OWN EXPOSURE, SOLVED AGAINST A DECLARED LIGHTNESS.
       Two hand-set gains drew the same material at Oklab L 0.54 on paper and
       L 0.66-0.73 on the dark sheets -- a deep crimson on one theme and a
       bright salmon bead on the next, which is the owner's "not the same
       material" in one number. The lightness of the thick core is declared
       instead (TUNE.jelly.coreL) and the exposure each theme needs to land on
       it is solved here, so the material is one material and only what shows
       through it changes.
       The forward model is the display shader's own body law read flat-on at
       full thickness -- transmission over the full path, the scatter burst,
       the page seen through the mass -- and it is monotonic in exposure, so
       forty halvings of the bracket are exact to 1e-11. Everything is inlined
       on purpose: readPalette is executed in a bare VM by the palette test,
       which declares only the colour helpers. */
    var groundLin = lin(ground.slice(0, 3));
    /* The lit disc the body is transparent AGAINST (see palette.jelly.envLit
       below). The forward model has to carry it, or the exposure is solved
       against a darker backdrop than the shader draws and the core lands over
       its declared lightness -- measured, that over-exposure ran the coverage
       solve into its own ceiling and flattened the body to a disc. */
    var litLin = groundLin.map(function (v) { return v + (1 - Math.min(1, v)) * TUNE.jelly.groundLift; });
    var wrapCore = (1 - TUNE.jelly.wrap) + TUNE.jelly.wrap * Math.pow(0.6171 * 0.5 + 0.5, 2); // dot(n, light) flat-on, half-Lambert, squared
    var burst = (palette.dark ? TUNE.jelly.sss[0] : TUNE.jelly.sssLight) * (1 - Math.exp(-TUNE.jelly.sss[1]));
    var deepT = absorb.map(function (a) { return Math.exp(-a * (TUNE.jelly.pathFloor + TUNE.jelly.pathGain)); });
    /* the scatter burst is absorbed on its way back out too (see `scatter`
       in the display shader), so the forward model has to carry that or the
       exposure is solved against a core brighter than the shader draws */
    var burstT = absorb.map(function (a) { return Math.exp(-a * (TUNE.jelly.pathFloor + TUNE.jelly.pathGain * TUNE.jelly.sssOut)); });
    var coreLight = function (expose) {
      var linOut = illum.map(function (v, i) {
        /* the backdrop crosses the material ONCE on its way to the eye, which
           is the shader's law since the refraction term landed; it used to be
           squared here and there, on the theory of a sheet behind the body */
        var lit = v * expose * deepT[i] * wrapCore + core[i] * expose * burst * wrapCore * burstT[i] + litLin[i] * deepT[i] * TUNE.jelly.pass;
        return lit * 0.9745; // 1 - Fresnel face-on for gelatin's index; the rim term is zero here
      });
      var over = Math.max(linOut[0], linOut[1], linOut[2]);
      var toned = over < 0.8 ? over : 0.8 + 0.2 * (1 - Math.exp(-(over - 0.8) / 0.2));
      var c = linOut.map(function (v) { return v * toned / Math.max(over, 1e-4); });
      /* Oklab lightness of a linear-sRGB colour */
      var cone = function (r, g, b) { return Math.cbrt(r * c[0] + g * c[1] + b * c[2]); };
      return 0.2104542553 * cone(0.4122214708, 0.5363325363, 0.0514459929)
        + 0.7936177850 * cone(0.2119034982, 0.6806995451, 0.1073969566)
        - 0.0040720468 * cone(0.0883024619, 0.2817188376, 0.6299787005);
    };
    var wantL = palette.dark ? TUNE.jelly.coreL[0] : TUNE.jelly.coreL[1];
    var lo = TUNE.jelly.gain[0], hi = TUNE.jelly.gain[1];
    for (var step = 0; step < 40; step++) {
      var half = (lo + hi) / 2;
      if (coreLight(half) < wantL) lo = half; else hi = half;
    }
    var expose = (lo + hi) / 2;
    palette.jelly = {
      illum: illum.map(function (v) { return v * gain; }),
      absorb: absorb,
      /* the colour the scattered light carries, relative to the illuminant: the CORE stop, so what builds with thickness is the saturated colour, the burst */
      tint: core.map(function (v, i) { return Math.min(2.0, v / Math.max(1e-3, illum[i])); }),
      fast: lin(palette.fast), slow: lin(palette.slow),
      core: core,
      /* the body's exposure RELATIVE to the illuminant the liquid and the mist
         are drawn with, because the shader multiplies the one it is sent */
      expose: expose / Math.max(gain, 1e-4),
      /* the ground the canvas is composited over, in sRGB: the space the
         browser blends a premultiplied canvas in, and so the space the
         coverage solve has to be done in */
      ground: ground.slice(0, 3)
    };
    /* THE ENVIRONMENT IS THE PAGE. Below the horizon the surface mirrors the
       theme's own ground, so a rim on paper reflects paper and a rim on a dark
       theme reflects dark -- without this the Fresnel edge drew a dark outline
       on the light themes. Above the horizon is a dim neutral studio; the
       softbox and its hot core sit inside it (see `optics`). */
    palette.jelly.envGround = groundLin;
    /* THE LIT DISC BEHIND THE BODY, for refraction to have something to bend.
       The page's own ground lifted toward white by the same fraction on every
       theme, so it is brighter than the ground it sits on whether that ground
       is black or paper (the environment's horizon is NOT usable for this: on
       paper it is darker than the ground, which would put a dark disc behind
       the body). Only ever seen through the body. */
    palette.jelly.envLit = litLin;
    palette.jelly.envHorizon = groundLin.map(function (v) { return v * 0.7 + (palette.dark ? 0.03 : 0.15); });
    palette.jelly.envSky = palette.dark ? [0.22, 0.24, 0.28] : [0.7, 0.7, 0.73];
  }

  /* THE SEAT (owner, 2026-09-15: "a blob character that turns into fluid", "bounce around and such with a
     personality, not just sit there in the center"). The blob lives at its seat, a point on the face with a velocity.
     It wanders: it holds a heading for a few seconds, then turns; it bounces off the wall (a reflection, a burst, and
     a split when it hits hard); it darts to a goal when it has one (a reading call, a hop). Its pace is the mood's
     and the action's: sleepy is a drift, playful is a romp, running is a charge. The ring's lit arc is centred on
     the seat so the light and the water agree. Angles are degrees clockwise from the top. */
  var WALL = 0.36;
  /* WHERE THE BODY'S OWN EDGE MEETS THE INSIDE OF THE FRAME, in canvas UV,
     where the visible face ends at 0.5.
     The canvas is already flush with the frame: .home-circle-fluid is
     86.154% of .home-circle, and 86.154% of the 520-unit finish viewBox is
     the 224-unit radius of .home-core-recess and of the inset ::before disc.
     So UV 0.5 IS the inside of the frame; nothing in CSS holds the water off.
     This number was .478, and that is the gap the owner reported as "the edge
     seems to be pretty far from the circle edge". bodyReach() measures the
     material out to 1.35 sigma -- a faint gaussian tail, well past the edge a
     person actually sees at about 1.0 sigma -- so a contact radius of .478
     seated the VISIBLE edge near .455, about 9% of the radius short of the
     frame, roughly 18 px of empty ring at a 1440-wide window.
     Carrying the same 0.35 sigma back (sigma is about .07 for every form
     here) puts the visible edge on the frame. The faint tail beyond it is
     clipped by the solve's own wall at uWall = 0.5 - one dye texel, which is
     what gives a soft body resting against the frame instead of a circle
     floating inside one. */
  /* JELLY BODY: the base character is drawn with its visible edge at 1.18
     sigma (TUNE.jelly.edge), so the contact radius backs off a little more
     than the 0.35 sigma above; measured against the flush test the same way,
     0.43 sigma seats the eyes' visible edge on the frame.
     This pad does not have to be re-derived now the base character is drawn at
     3.6 rather than 1.2 (src/home-circle-motion.js), and that is worth saying
     because it looks like it should. It is the gap between the 1.35 sigma
     bodyReach measures and the 1.18 sigma a person sees, and BOTH of those are
     scaled by bodyScale inside bodyReach -- so a larger body eats its own pad
     out of the wall rather than out of this constant. The one thing the size
     does change is which branch of max(.18, RIM - bodyReach) wins: past about
     3.2 the wall is on its floor, and the body is then held off the casing by
     the floor instead of by this number. */
  var RIM = 0.5 + 0.43 * 0.07;
  /* THE BRIM (owner: "fill the line with the same kind of 'fluid' as the blob.
     and make it classy"). The lip is an SVG stroke in src/home-circle.js
     (circle.home-core-lip, r 229 of the 520 viewBox) and a DOM stroke cannot be
     the body's material, so the canvas now covers the WHOLE ring and sits above
     the frame, and the lip is drawn in-canvas as a thin torus of the same
     material under the same light. Everything the body does stays in FACE
     units: the face (the recess, r 224) is FACE of the ring, and the display
     pass remaps canvas pixels to face uv. The pixel cap is unchanged, so the
     extra cost is the torus's own arithmetic. */
  var FACE = 224 / 260;
  /* THE INLAY. The casing (src/home-circle.js) cuts a groove at r227..231 of
     its 520 viewBox and this torus is what sits in it: r229 +/- 2 on every
     sheet, so the line fills the groove exactly and its edges land on the
     groove's walls. The light sheets used to draw it wider (2.7) for
     legibility; the dark walls either side of the groove do that job now. */
  var BRIM = { radius: 240 / 520, halfDark: 8.0 / 520, halfLight: 8.0 / 520, steep: 0.40 };
  /* The fastest the body is built to travel: a dart asks 0.24, a rebound 0.3. Nothing may leave it above this. */
  var TOP = 0.32;
  var seat = { x: 0.5, y: 0.5 + 0.3, vx: 0, vy: 0, heading: Math.random() * Math.PI * 2, steerAt: 0, goal: null, pace: 0.05,
    deg: 0, radius: 0.3, moving: 0, bounced: -9,
    /* heading is where it WANTS to go; face is where it is actually travelling, which turns toward heading at a
       limited rate (see seatDrive). speed is the filtered pace, tx/ty the smoothed travel direction the wake uses. */
    face: 0, speed: 0, tx: 0, ty: 0 };
  seat.face = seat.heading; seat.tx = Math.cos(seat.face); seat.ty = Math.sin(seat.face);
  /* A gesture that is meant to be sudden -- a bounce, a double-take, a flight -- turns the body outright; ordinary
     changes of mind are steered into. */
  function faceNow(a) { seat.heading = a; seat.face = a; }
  function moveSeat(deg, radius) {
    var a = deg * Math.PI / 180, r = Math.min(WALL - 0.02, radius || seat.radius);
    seat.goal = { x: 0.5 + r * Math.sin(a), y: 0.5 + r * Math.cos(a) };
  }
  function trampoline(heading) {
    seat.goal = null; faceNow(heading); seat.steerAt = clock + 3;
    seat.rebound = { until: clock + 2.5, speed: 0.3 };
    seat.trampoline = { bounces: 3, t: clock };
    persona.flare = { t: clock, strength: 0.5 };
  }
  // Extent toward the actual circular rim, in canvas coordinates. The
  // character can use the whole face; only its own material reserves room.
  function formReach(form, nx, ny) {
    if (form === 2) {
      // Mirrors the kind < 2.5 branch of FLUID_FORMS, which no longer rotates
      // the eye pair (see src/home-circle-forms.js). The reach estimate must
      // not rotate either, or the wall would sit for a pose the dye never takes.
      var joined = agent.character[0];
      // .039, not .046: the width's far end is the height's far end now, so
      // the settled pair is a circle (mix(0.032, 0.071, together) in
      // src/home-circle-forms.js). This mirror has to move with it or the wall
      // would reserve room for a pose the body no longer takes.
      return Math.abs(nx) * .066 * (1 - joined) + 1.35 * Math.hypot(nx * (.032 + .039 * joined), ny * (.064 + .007 * joined));
    }
    if (form === 3) return .1575 * Math.abs(nx) + .018 * Math.max(0, ny) + .0504;
    if (form === 4) {
      /* The tool form is a core plus two bands lying on circles around it
         (src/home-circle-forms.js, fluidForm kind 4). A band is the same reach
         in every direction, so this no longer walks a list of pieces -- the
         outer band's own 1.35-sigma tail is the whole answer whenever it is
         open, and the core answers for it before it opens. */
      var parts = agent.parts;
      var core = 1.35 * Math.hypot(parts.pose[2] * nx, parts.pose[3] * ny);
      var band = parts.turn[3] > .004 ? parts.ring[0] + 1.35 * parts.ring[2] + .015 : 0;
      return Math.max(core, band);
    }
    return .115;
  }
  /* THE SECOND WAY THE EYE PAIR COULD TURN, AND THE ONE THAT IS EASY TO MISS.
     bodyLocal() in src/home-circle-forms.js does not rotate, but it scales the
     face anisotropically along an arbitrary axis:
       normal * dot(p, normal) / uBody.w + tangent * dot(p, tangent) * uBody.w
     Applied to a horizontally spaced PAIR, a squash along a diagonal axis
     tilts the pair's principal axis -- it looks exactly like the eyes turning
     to the side, without any rotation term existing anywhere.
     It is safe only because compression is EXACTLY 1 whenever the eye form is
     on screen, which makes that expression the identity for any axis. That
     made it a one-character edit away from the reported defect while living
     inline in the render path where nothing could test it. It is a named
     function now so the guarantee is checkable: see the runtime test
     'no state can turn the eye pair'. */
  /* THE DRAW-IN. Recovered verbatim from 21506c72, where thinking was "the
     blob draws in on itself and holds (the sink term, a twentieth of the
     blowup's strain), rocking gently as it does; nothing travels".
     A gentle in-plane convergence at the centre, balanced by a thin return
     ring so the solve stays divergence-free -- the water gathers and holds
     rather than streaming away. This is the owner's "it can get really slow"
     before the ring pulses "pulse again". */
  function gather(alpha, reach) {
    var h = 1 / LADDER[level].sim, returnR = 0.43, returnW = 0.045;
    var inSink = Math.PI * reach * reach * (1 - Math.exp(-Math.pow(0.49 / reach, 2)));
    var inReturn = 2 * Math.PI * returnR * returnW * Math.sqrt(Math.PI);
    drive.sink[0] = alpha; drive.sink[1] = reach; drive.sink[2] = alpha * inSink / inReturn; drive.sink[3] = h;
    drive.ret[0] = returnR; drive.ret[1] = returnW;
  }
  function bodyShape() {
    var faceForm = drive.form === 2 || (drive.formFrom === 2 && drive.formMix < 1);
    var sq = seat.squash, compression = faceForm ? 1 : 1 + Math.min(.04, seat.speed * .2), axis = seat.face;
    if (!faceForm && sq && clock - sq.t < (sq.span || .6)) {
      compression = 1 - (sq.depth || .08) * Math.sin(Math.PI * Math.max(0, clock - sq.t) / (sq.span || .6));
      axis = Math.atan2(sq.ny, sq.nx);
    }
    /* JELLY BODY: the ring-down, as a squash across one canvas axis with the
       other axis giving the area back exactly. Axis-aligned, so it cannot turn
       the eye pair; compression above stays exactly 1 for the face form. */
    var j = seat.jig || 0, across = 1 + j, sx = (seat.jigAxis || -1) > 0 ? across : 1 / across;
    return { axis: axis, compression: compression, faceForm: faceForm, jiggle: [sx, 1 / sx] };
  }
  function bodyReach(nx, ny) {
    if (episode || !agent.motion) return .115;
    var to = formReach(drive.form, nx, ny), from = formReach(drive.formFrom, nx, ny);
    return (from * (1 - drive.formMix) + to * drive.formMix) * drive.bodyScale;
  }
  function seatDrive(dt) {
    var t = clock, want = seat.heading, speed = seat.pace, ease = 2.2;
    var floating = agent.motion?.form === 2 && voice.state !== 'on' && !episode;
    // Actions change the material and shape. The body keeps its momentum;
    // no action supplies an x/y target or drags it along a prescribed path.
    if (agent.motion && voice.state !== 'on' && !episode) speed = agent.motion.pace;
    if (floating) { speed *= 1 + .12 * noise(t, 15); ease = .85; }
    if (seat.goal) {
      var gx = seat.goal.x - seat.x, gy = seat.goal.y - seat.y, gd = Math.sqrt(gx * gx + gy * gy);
      if (gd < 0.02) { seat.goal = null; seat.heading = seat.face; }
      else {
        want = Math.atan2(gy, gx);
        /* ARRIVAL. It runs at the goal from a distance and eases over the last tenth of the face, so it comes to
           rest where it was going instead of having the goal taken away at full tilt. */
        speed = Math.max(speed, Math.min(0.24, 0.1 + gd * 0.5)) * (0.3 + 0.7 * smooth(0.02, 0.1, gd));
        ease = 3;
      }
    } else {
      if (seat.rebound && t < seat.rebound.until) { speed = Math.max(speed, seat.rebound.speed); }
      else if (t > seat.steerAt) {
        /* A decision: turn a little or a lot, and hold it for a while. */
        seat.heading += (Math.random() - 0.5) * (floating ? .45 : Math.random() < 0.3 ? Math.PI * 1.4 : Math.PI * 0.6);
        seat.steerAt = floating ? t + 5 + Math.random() * 5 : t + 1.2 + Math.random() * 3;
      }
      /* Between decisions the heading drifts on a slow noise, so a path is a curve, not a polyline. */
      seat.heading += noise(t, 7) * (floating ? .16 : .9) * dt;
      want = seat.heading;
    }
    /* STEERING, NOT PURSUIT. The body turns toward what it wants at a finite rate -- faster when it is moving fast,
       because a charge can corner harder than a drift -- so it banks into a goal on an arc. Aiming straight at the
       goal every frame, which is what this did before, is exactly the motion of something held by a cursor. */
    var turn = floating ? .24 : Math.min(6, 2.2 + 12 * speed);
    var by = ((want - seat.face + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    seat.face += Math.max(-turn * dt, Math.min(turn * dt, by));
    /* Speed is filtered, and asymmetrically: a kick or a bounce arrives in about a tenth of a second, a stop is a
       coast of about half. Easing is exponential so a 50 ms step and a 20 ms step settle at the same rate. */
    seat.speed += (speed - seat.speed) * (1 - Math.exp(-(floating ? 1.8 : speed > seat.speed ? 9 : 2.2) * dt));
    var k = 1 - Math.exp(-ease * dt);
    seat.vx += (Math.cos(seat.face) * seat.speed - seat.vx) * k; seat.vy += (Math.sin(seat.face) * seat.speed - seat.vy) * k;
    seat.x += seat.vx * dt; seat.y += seat.vy * dt;
    /* THE CAPTION'S BAND, on a crowded disc only: a soft spring pushes the seat
       out of the caption's box along its short axis (up or down, whichever
       side it is on), so the body keeps to the room above or below the words.
       Zero on a large disc; the caption box and the face scale are read with
       typeof because this function also runs extracted in the runtime suite. */
    var crowdNow = drive.crowd || 0;
    if (crowdNow > 0 && typeof quiet !== 'undefined' && typeof quietAt !== 'undefined') {
      var faceScale = typeof FACE !== 'undefined' ? FACE : 1;
      var qx = (seat.x - 0.5) - quietAt[0] / faceScale, qy = (seat.y - 0.5) - quietAt[1] / faceScale;
      var qhx = quiet[0] / faceScale, qhy = quiet[1] / faceScale;
      var dq = Math.sqrt((qx / qhx) * (qx / qhx) + (qy / qhy) * (qy / qhy));
      if (dq < 1.3) {
        var side = qy >= 0 ? 1 : -1;
        seat.vy += side * TUNE.jelly.crowd.steer * crowdNow * (1.3 - dq) * dt;
        if (seat.vy * side < 0) seat.vy *= 1 - Math.min(1, 6 * dt);
      }
    }
    /* THE WALL. The seat reflects and keeps a little more than its speed for a moment (a rebound), holds the new
       heading so it visibly travels away, and the water is squashed against the wall for a third of a second before
       the hold springs it back (see squashDrive). */
    // Bounce at the round frame, allowing for this shape's width toward it.
    // The readout already dims fluid behind its words; it is not a wall.
    var px = seat.x - .5, py = seat.y - .5, r = Math.hypot(px, py);
    var nx = r > 0 ? px / r : 1, ny = r > 0 ? py / r : 0;
    var wallRadius = Math.max(.18, RIM - bodyReach(nx, ny));
    seat.wallRadius = wallRadius;
    if (r > wallRadius) {
      var contactX = .5 + nx * RIM, contactY = .5 + ny * RIM;
      var dot = seat.vx * nx + seat.vy * ny;
      if (dot > 0) {
        seat.vx -= 2 * dot * nx; seat.vy -= 2 * dot * ny;
        if (floating) { seat.vx *= .96; seat.vy *= .96; }
        var hit = Math.sqrt(seat.vx * seat.vx + seat.vy * seat.vy);
        /* Out of the wall the body turns at once (a bounce IS sudden); the small scatter is what it steers into
           over the next moment, and the speed filter lets the rebound through immediately. */
        seat.face = Math.atan2(seat.vy, seat.vx);
        seat.heading = seat.face + (Math.random() - 0.5) * (floating ? .12 : .5);
        /* The rebound is let through the speed filter at once, but CLAMPED. Uncapped this latched whatever the
           body happened to be doing, and since the dash gesture multiplies velocity by three, a dash into a wall
           into another dash ratcheted the seat to ten times its design pace and the blob flew about. */
        seat.speed = floating ? Math.min(.065, hit) : Math.min(TOP, Math.max(seat.speed, hit));
        seat.steerAt = floating ? t + 4 + Math.random() * 3 : t + 1 + Math.random() * 1.5;
        seat.bounced = t; seat.hit = hit;
        seat.squash = { t: t, x: contactX, y: contactY, nx: nx, ny: ny, hit: hit, span: .6, depth: .08 };
        /* JELLY BODY: the bounce also rings the shape itself (see updateSeatReadings), squashed across the wall's dominant axis. */
        seat.jigV = (seat.jigV || 0) - TUNE.jelly.jiggle.kick * Math.min(1, hit / 0.12);
        seat.jigAxis = Math.abs(nx) >= Math.abs(ny) ? 1 : -1;
        seat.rebound = { until: t + 0.9, speed: floating ? Math.min(.065, hit) : Math.min(0.3, hit * 1.15) };
        /* On the trampoline each bounce keeps most of its speed and goes straight back out, three times, dying away. */
        var tr = seat.trampoline;
        if (tr && tr.bounces > 0) {
          tr.bounces--; seat.hit = Math.max(hit, 0.2);
          seat.face = Math.atan2(-ny, -nx); seat.heading = seat.face + (Math.random() - 0.5) * 0.35; seat.steerAt = t + 2.5;
          seat.rebound = { until: t + 2, speed: 0.3 * Math.pow(0.78, 3 - tr.bounces) };
          if (tr.bounces === 0) seat.trampoline = null;
        }
      }
      seat.x = .5 + nx * wallRadius * .999; seat.y = .5 + ny * wallRadius * .999;
      seat.goal = null;
    }
    /* A harness may hold the seat under the test hook (homeCircleFluidTest.seat
       = [x, y] in face uv), so the body can be judged clear of the caption. */
    if (typeof testHook !== 'undefined' && testHook && testHook.seat && testHook.seat.length === 2) {
      seat.x = testHook.seat[0]; seat.y = testHook.seat[1]; seat.vx = seat.vy = 0; seat.goal = null;
    }
    updateSeatReadings(dt);
  }
  function updateSeatReadings(dt) {
    /* JELLY BODY -- THE JIGGLE. Jelly bounces because it STORES deformation and
       gives it back, and a fluid advection has no such memory. This is that
       memory: one damped spring on the body's own shape, kicked by a bounce or
       a change of form and ringing down over several visible swings. It is
       stepped with the oscillator's exact solution, so a 20 ms step and a 50 ms
       step ring at the same rate and nothing can go unstable. bodyShape() spends
       it as an axis-aligned, area-preserving squash (uJiggle). */
    if (seat.jig === undefined) { seat.jig = 0; seat.jigV = 0; seat.jigAxis = -1; }
    var jg = TUNE.jelly.jiggle, w0 = 2 * Math.PI * jg.hz, zeta = jg.damping, wd = w0 * Math.sqrt(1 - zeta * zeta);
    var fade = Math.exp(-zeta * w0 * dt), cs = Math.cos(wd * dt), sn = Math.sin(wd * dt), x0 = seat.jig, v0 = seat.jigV;
    seat.jig = Math.max(-jg.max, Math.min(jg.max, fade * (x0 * cs + (v0 + zeta * w0 * x0) / wd * sn)));
    seat.jigV = fade * (v0 * cs - (w0 * w0 * x0 + zeta * w0 * v0) / wd * sn);
    var r = Math.sqrt((seat.x - 0.5) * (seat.x - 0.5) + (seat.y - 0.5) * (seat.y - 0.5));
    var v = Math.sqrt(seat.vx * seat.vx + seat.vy * seat.vy);
    /* moving sets how hard the water is held, how wide the push falls off and how strong the wake is. Filtered,
       because those three reading off a raw per-frame speed is what made the blob shudder while it travelled. */
    seat.moving += (Math.min(1, v / 0.14) - seat.moving) * (1 - Math.exp(-6 * dt));
    if (v > 1e-4) {
      var uk = 1 - Math.exp(-4 * dt);
      seat.tx += (seat.vx / v - seat.tx) * uk; seat.ty += (seat.vy / v - seat.ty) * uk;
    }
    seat.deg = ((Math.atan2(seat.x - 0.5, seat.y - 0.5) * 180 / Math.PI) % 360 + 360) % 360; seat.radius = r;
    var peak = seat.deg, start = ((peak - 115) % 360 + 360) % 360, shift = start - (peak - 115);
    palette.arc = { start: start, light: peak - 45 + shift, deep: peak - 8 + shift, end: peak + 40 + shift };
    stepDrops(dt, v);
  }

  /* ------------------------------------------------------------ the pieces */

  /* CHARACTER PIECES. A body of this material travelling fast does not hold
     all of itself together: a little of it is left behind, hangs for a moment
     as its own droplet, and is drawn back in. The owner asked for "trailing /
     recombining / animated blob pieces to make the blob more of a character".
     A few, and brief.
     THEY ARE NOT SPRITES AND THEY ARE NOT A PARTICLE SYSTEM. What is kept
     here is three positions and three radii; nothing is drawn from them. They
     are summed INTO THE BODY'S OWN FIELD in jellyDist, before the silhouette
     is thresholded, so a droplet is made of the same material as the body --
     the same absorber, the same translucency, the same one catch -- and where
     it comes near the body the two are a smooth minimum and genuinely join.
     A dragged sprite is exactly the thing that has already been rejected; the
     difference is that deleting the body deletes these with it, because they
     have no shape of their own to draw.
     Recombining is not scripted either. A droplet is pulled toward the body it
     came off, and the pull grows as it ages, so it falls back in and the union
     closes over it. Nothing decides when it merges; the field does. */
  var drops = [
    { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, size: 0 },
    { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, size: 0 },
    { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, size: 0 }
  ];
  var dropData = new Float32Array(12), dropAt = 0, dropsShed = 0;
  function stepDrops(dt, v) {
    var D = TUNE.jelly.drops;
    /* Shed only while genuinely travelling, and never faster than `every`, so
       this stays "a few, brief" rather than a stream. */
    /* Only a SOLID body sheds pieces. `solid` is not kept on drive -- the
       display pass derives it from drive.wisp each frame (1 - smooth(0.05,
       0.5, wisp)) -- so the same reading is taken here from wisp directly:
       below 0.3 the body is most of the way solid. Whispy and mist states
       have nothing to shed a piece OF. */
    if (v > D.speed && clock - dropAt > D.every && drive.wisp < 0.3) {
      var free = null;
      for (var i = 0; i < drops.length; i++) if (drops[i].life <= 0) { free = drops[i]; break; }
      if (free) {
        var ux = v > 1e-4 ? seat.vx / v : 0, uy = v > 1e-4 ? seat.vy / v : 0;
        var back = D.behind * drive.bodyScale;
        free.x = seat.x - ux * back; free.y = seat.y - uy * back;
        /* It leaves with less of the body's speed than the body has, which is
           why it falls behind at all. */
        free.vx = seat.vx * D.keep; free.vy = seat.vy * D.keep;
        free.age = 0; free.life = D.life; free.size = D.size * drive.bodyScale;
        dropAt = clock; dropsShed++;
      }
    }
    for (var k = 0; k < drops.length; k++) {
      var d = drops[k];
      if (d.life <= 0) continue;
      d.age += dt;
      /* The pull home, growing with age: it lags, hangs, then comes back. */
      var gx = seat.x - d.x, gy = seat.y - d.y;
      var pull = D.pull * Math.min(1, d.age / d.life);
      d.vx += gx * pull * dt; d.vy += gy * pull * dt;
      var damp = Math.exp(-D.drag * dt);
      d.vx *= damp; d.vy *= damp;
      d.x += d.vx * dt; d.y += d.vy * dt;
      /* It goes when it has run out of time, or when it is back inside the
         body it came off -- at which point the field has already closed over
         it, so nothing pops. */
      var home = Math.sqrt(gx * gx + gy * gy);
      if (d.age >= d.life || home < D.home * drive.bodyScale) d.life = 0;
    }
    for (var j = 0; j < drops.length; j++) {
      var p = drops[j], o = j * 4;
      /* Strength fades in over the first fifth of its life and out over the
         last two fifths, so a droplet neither appears nor vanishes: it is
         drawn out of the body and taken back into it. */
      var t = p.life > 0 ? p.age / p.life : 1;
      var fade = p.life > 0 ? Math.min(1, t / 0.2) * Math.min(1, (1 - t) / 0.4) : 0;
      dropData[o] = p.x; dropData[o + 1] = p.y;
      dropData[o + 2] = p.size; dropData[o + 3] = D.weight * fade;
    }
  }
  /* The squash: for 0.35 s after a hit the water is pressed flat against the wall (a push at the contact point
     along the wall's normal, inward, and a spread along its tangent), then let go. */
  function squashDrive(t) {
    var sq = seat.squash;
    var span = sq?.span || .35;
    if (!sq || t - sq.t > span) return;
    var k = Math.sin(Math.PI * (t - sq.t) / span) * Math.min(1, sq.hit / 0.12);
    var tx = -sq.ny, ty = sq.nx;
    pushX(1, sq.x + tx * 0.05, sq.y + ty * 0.05, (-sq.nx * 0.15 + tx * 0.2) * k, (-sq.ny * 0.15 + ty * 0.2) * k, 160, 0);
    pushX(2, sq.x - tx * 0.05, sq.y - ty * 0.05, (-sq.nx * 0.15 - tx * 0.2) * k, (-sq.ny * 0.15 - ty * 0.2) * k, 160, 0);
  }

  function measureQuiet() {
    if (!centre) return;
    /* under the determinism hook the box is measured once, at boot, and held:
       its later re-measures arrive on wall-clock ticks and resize events, and
       the crowd factor feeds the body's size from it */
    if (fixedDt && quietMeasured) return;
    var r = (canvas || ring).getBoundingClientRect(), c = centre.getBoundingClientRect();
    if (!r.width || !c.width) return;
    quiet = [Math.min(0.46, c.width / r.width * 0.54), Math.min(0.46, c.height / r.height * 0.54)];
    quietMeasured = true;
    quietAt = [
      (c.left + c.width / 2 - (r.left + r.width / 2)) / r.width,
      -(c.top + c.height / 2 - (r.top + r.height / 2)) / r.height
    ];
  }
  /* The words move and change shape without the canvas changing size -- a longer agent name, a caption that wraps,
     a different alignment inside the disc -- so the box is re-measured on a slow tick rather than only when the
     canvas is sized. */
  var quietAtMs = 0;
  function quietTick() {
    var now = performance.now();
    if (now - quietAtMs < 250) return;
    quietAtMs = now;
    measureQuiet();
  }

  /* ------------------------------------------------------------ shaders */

  var VERTEX = [
    'precision highp float;',
    'attribute vec2 aPosition;',
    'uniform vec2 uTexel;',
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'void main () {',
    '  vUv = aPosition * 0.5 + 0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0); vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y); vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPosition, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* Shared fragment prelude: the circular wall and optional manual bilinear
     filtering for WebGL1 devices whose half-float textures cannot filter. */
  var PRELUDE = [
    'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
    'uniform float uWall;',
    'float solid (vec2 p) { return step(uWall, length(p - 0.5)); }',
    '#ifdef MANUAL_FILTERING',
    'vec4 bilerp (sampler2D t, vec2 uv, vec2 px) {',
    '  vec2 st = uv / px - 0.5; vec2 i = floor(st); vec2 f = fract(st);',
    '  vec4 a = texture2D(t, (i + vec2(0.5, 0.5)) * px); vec4 b = texture2D(t, (i + vec2(1.5, 0.5)) * px);',
    '  vec4 c = texture2D(t, (i + vec2(0.5, 1.5)) * px); vec4 d = texture2D(t, (i + vec2(1.5, 1.5)) * px);',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
    '#define SAMPLE(t, uv, px) bilerp(t, uv, px)',
    '#else',
    '#define SAMPLE(t, uv, px) texture2D(t, uv)',
    '#endif'
  ].join('\n');

  var FRAGMENTS = {
    /* Copy or scale a field (pressure warm start, resampling on a step down). */
    scale: [
      'uniform sampler2D uSource; uniform float uValue;',
      'void main () { gl_FragColor = uValue * texture2D(uSource, vUv); }'
    ],
    curl: [
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;',
      '  float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;',
      '  gl_FragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);',
      '}'
    ],
    /* Vorticity confinement, the slow circulation along the wall, the sources
       on the lit arc and the pointer stir, all as accelerations. */
    forces: [
      'uniform sampler2D uVelocity; uniform sampler2D uCurl;',
      'uniform float uDt; uniform float uCurlStrength; uniform float uSwirl;',
      'uniform vec4 uPush[3]; uniform float uPushSharp;',
      'uniform vec2 uBodyAt; uniform vec4 uBodyFlow; uniform vec4 uFluidMotion;',
      'uniform vec4 uParts[5]; uniform vec2 uPartVelocity[5]; uniform vec2 uPartForce; uniform float uPartSpin[5];',
      'uniform vec4 uToolFlow; uniform vec2 uToolSpin;',
      'uniform vec4 uEpi; uniform vec4 uPulse[2]; uniform vec2 uTwist[2]; uniform vec4 uPushX[3]; uniform vec2 uPushXW[3];',
      'void main () {',
      '  float L = abs(texture2D(uCurl, vL).x); float R = abs(texture2D(uCurl, vR).x);',
      '  float T = abs(texture2D(uCurl, vT).x); float B = abs(texture2D(uCurl, vB).x);',
      '  float C = texture2D(uCurl, vUv).x;',
      '  vec2 n = vec2(T - B, R - L); n /= length(n) + 0.00001;',
      '  vec2 force = uCurlStrength * C * vec2(n.x, -n.y);',
      '  vec2 p = vUv - 0.5; float r = length(p);',
      '  float band = smoothstep(0.16, 0.38, r) * (1.0 - smoothstep(0.46, 0.5, r));',
      '  force += uSwirl * band * vec2(p.y, -p.x) / (r + 0.00001);',
      '  for (int i = 0; i < 3; i++) { vec2 d = vUv - uPush[i].xy; force += exp(-dot(d, d) * uPushSharp) * uPush[i].zw; }',
      // Extra body force f (see header): the ambient terms are scaled, an azimuthal torque ring (clockwise when
      // positive) spins the fluid up, two ring pulses are the curl of a stream function localized in radius
      // (divergence free, zero angular mean), and three small pushes/eddies carry the circle's personality.
      '  force *= uEpi.x;',
      '  vec2 er = p / (r + 0.00001), et = vec2(-er.y, er.x);',
      '  float ring = (r - uEpi.z) / uEpi.w;',
      '  force -= uEpi.y * exp(-ring * ring) * et;',
      '  float theta = atan(p.y, p.x);',
      '  for (int i = 0; i < 2; i++) {',
      '    float s = (r - uPulse[i].x) / uPulse[i].y, g = exp(-s * s) * uPulse[i].z;',
      '    float phase = uPulse[i].w * theta + uTwist[i].x * s + uTwist[i].y;',
      '    float fr = -g * uPulse[i].w * sin(phase) / (r + 0.02);',
      '    float ft = g * (2.0 * s / uPulse[i].y * cos(phase) + uTwist[i].x / uPulse[i].y * sin(phase));',
      '    force += fr * er + ft * et;',
      '  }',
      '  for (int i = 0; i < 3; i++) {',
      '    vec2 d = vUv - uPushX[i].xy; float g = exp(-dot(d, d) * uPushXW[i].x);',
      '    force += g * (uPushX[i].zw + uPushXW[i].y * vec2(-d.y, d.x));',
      '  }',
      // Transport the eyes/dots with their coasting body. Fluid episodes use
      // the original pressure, torque and pulse terms above, with no local spin.
      '  vec2 local = vUv - uBodyAt; float body = exp(-dot(local, local) * 34.0);',
      '  vec2 carried = texture2D(uVelocity, vUv).xy;',
      '  force += body * uBodyFlow.w * uFluidMotion.z * (uBodyFlow.xy - carried);',
      '  for (int i = 0; i < 5; i++) {',
      '    if (uParts[i].z > 0.003 && uPartForce.y > 0.0) {',
      '      vec2 d = local - uParts[i].xy * uPartForce.x;',
      '      float radius = max(0.012, max(uParts[i].z, uParts[i].w) * uPartForce.x);',
      '      float weight = exp(-dot(d, d) / (radius * radius * 2.0));',
      '      force += weight * uPartForce.y * 6.0 * (uBodyFlow.xy + uPartVelocity[i] * uPartForce.x + uPartSpin[i] * vec2(-d.y, d.x) - carried);',
      '    }',
      '  }',
      // The tool form's two bands turn the body's own water with them: an
      // annulus of solid-body rotation at each band's radius, the outer one
      // against the inner, relaxed toward rather than imposed. This is why the
      // bands shear and trail like water instead of sliding like a decal.
      '  if (uToolFlow.w > 0.0) {',
      '    float rr = length(local) / max(uPartForce.x, 0.001);',
      '    for (int i = 0; i < 2; i++) {',
      '      float radius = i == 0 ? uToolFlow.x : uToolFlow.y;',
      '      float spin = i == 0 ? uToolSpin.x : uToolSpin.y;',
      '      float s = (rr - radius) / max(uToolFlow.z, 0.002);',
      '      float weight = exp(-s * s) * uToolFlow.w;',
      '      force += weight * 6.0 * (uBodyFlow.xy + spin * vec2(-local.y, local.x) - carried);',
      '    }',
      '  }',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy + force * uDt;',
      '  gl_FragColor = vec4(velocity * (1.0 - solid(vUv)), 0.0, 1.0);',
      '}'
    ],
    /* The wall mirrors the normal velocity, so nothing crosses it. */
    divergence: [
      'uniform sampler2D uVelocity;',
      'uniform vec4 uSink; uniform vec2 uReturn; uniform vec2 uSinkAt;',
      'void main () {',
      '  vec2 C = texture2D(uVelocity, vUv).xy;',
      '  float L = mix(texture2D(uVelocity, vL).x, -C.x, solid(vL));',
      '  float R = mix(texture2D(uVelocity, vR).x, -C.x, solid(vR));',
      '  float T = mix(texture2D(uVelocity, vT).y, -C.y, solid(vT));',
      '  float B = mix(texture2D(uVelocity, vB).y, -C.y, solid(vB));',
      '  float div = 0.5 * (R - L + T - B);',
      // Prescribed mid-plane divergence s (blowup episode): the projection then solves ∇²p = ∇·u* − s, so
      // ∇·u = s. s = −α e^(−r²/δs²) is the core's in-plane convergence (the paper's axial outflow seen at
      // z ≈ 0, ∂r ur + ur/r = −∂z uz); + C e^(−k²) is where fluid returns to the plane near the rim, sized so
      // ∫s = 0 as the closed circle requires. In grid units: subtract h·s.
      '  vec2 p = vUv - uSinkAt; float r = length(p), k = (r - uReturn.x) / uReturn.y;',
      '  div += uSink.w * (uSink.x * exp(-r * r / (uSink.y * uSink.y)) - uSink.z * exp(-k * k));',
      '  gl_FragColor = vec4(div * (1.0 - solid(vUv)), 0.0, 0.0, 1.0);',
      '}'
    ],
    /* One Jacobi iteration; pressure beyond the wall equals the cell's own. */
    jacobi: [
      'uniform sampler2D uPressure; uniform sampler2D uDivergence;',
      'void main () {',
      '  float C = texture2D(uPressure, vUv).x;',
      '  float L = mix(texture2D(uPressure, vL).x, C, solid(vL));',
      '  float R = mix(texture2D(uPressure, vR).x, C, solid(vR));',
      '  float T = mix(texture2D(uPressure, vT).x, C, solid(vT));',
      '  float B = mix(texture2D(uPressure, vB).x, C, solid(vB));',
      '  gl_FragColor = vec4(0.25 * (L + R + T + B - texture2D(uDivergence, vUv).x), 0.0, 0.0, 1.0);',
      '}'
    ],
    gradient: [
      'uniform sampler2D uPressure; uniform sampler2D uVelocity;',
      'void main () {',
      '  float C = texture2D(uPressure, vUv).x;',
      '  float L = mix(texture2D(uPressure, vL).x, C, solid(vL));',
      '  float R = mix(texture2D(uPressure, vR).x, C, solid(vR));',
      '  float T = mix(texture2D(uPressure, vT).x, C, solid(vT));',
      '  float B = mix(texture2D(uPressure, vB).x, C, solid(vB));',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);',
      '  gl_FragColor = vec4(velocity * (1.0 - solid(vUv)), 0.0, 1.0);',
      '}'
    ],
    /* Semi-Lagrangian advection of the velocity field by itself. */
    advect: [
      'uniform sampler2D uVelocity; uniform vec2 uVelocityTexel; uniform float uDt; uniform float uKeep;',
      'void main () {',
      '  vec2 back = vUv - uDt * SAMPLE(uVelocity, vUv, uVelocityTexel).xy;',
      '  vec2 velocity = SAMPLE(uVelocity, back, uVelocityTexel).xy * uKeep;',
      '  gl_FragColor = vec4(velocity * (1.0 - solid(vUv)), 0.0, 1.0);',
      '}'
    ],
    /* Dye: advected by the velocity, faded, and fed by the sources.
       x carries the ring\'s light colour, y its deep colour. */
    dye: [
      'uniform sampler2D uVelocity; uniform sampler2D uDye; uniform vec2 uVelocityTexel; uniform vec2 uDyeTexel;',
      'uniform float uDt; uniform float uKeep; uniform vec4 uEmit[3]; uniform vec3 uEmitAt[3]; uniform float uEmitSharp;',
      FLUID_FORMS,
      'uniform vec4 uPulse[2]; uniform vec2 uTwist[2]; uniform vec4 uPulseDye; uniform vec4 uRingDye;',
      'void main () {',
      '  vec2 back = vUv - uDt * SAMPLE(uVelocity, vUv, uVelocityTexel).xy;',
      '  vec2 dye = SAMPLE(uDye, back, uDyeTexel).xy * uKeep;',
      '  float active = mix(step(0.5, uForm.x), step(0.5, uForm.y), uForm.z);',
      '  for (int i = 0; i < 3; i++) { vec2 d = vUv - uEmitAt[i].xy; dye += (1.0 - active) * exp(-dot(d, d) * uEmitSharp) * uEmit[i].xy * uDt; }',
      '  if (active > 0.0) {',
      '    vec2 local = bodyLocal(vUv);',
      '    if (uForm.z >= 1.0) dye += fluidInk(local, uForm.y, uForm.w, uEmit[0].xy) * uDt;',
      '    else dye += mix(fluidInk(local, uForm.x, uForm.w, uEmit[0].xy), fluidInk(local, uForm.y, uForm.w, uEmit[0].xy), uForm.z) * uDt;',
      '  }',
      // Light shed by the two ring pulses (one tint each: x is the light stop, y the deep stop) and a ring of
      // light near the rim (voice listening); the flow then shears and carries it like any other dye.
      '  vec2 p = vUv - 0.5; float r = length(p), theta = atan(p.y, p.x);',
      '  float s0 = (r - uPulse[0].x) / uPulse[0].y, s1 = (r - uPulse[1].x) / uPulse[1].y, k = (r - uRingDye.x) / uRingDye.y;',
      '  dye += exp(-s0 * s0) * max(cos(uPulse[0].w * theta + uTwist[0].x * s0 + uTwist[0].y), 0.0) * uPulseDye.xy * uDt;',
      '  dye += exp(-s1 * s1) * max(cos(uPulse[1].w * theta + uTwist[1].x * s1 + uTwist[1].y), 0.0) * uPulseDye.zw * uDt;',
      '  dye += exp(-k * k) * uRingDye.zw * uDt;',
      '  gl_FragColor = vec4(max(dye, 0.0), 0.0, 1.0);',
      '}'
    ],
    /* One translucent material, read the way light actually crosses it:
       absorbing per channel with distance (PROMPT E), shaded by the same
       thickness, and since PROMPT F carrying its own surface -- a white catch
       and a bevel catch, both built from the dye field's own slope.
       This paragraph used to end "No surface normals, white sheen, refraction
       lines or light layer", which was written when all three lights were
       deleted together and has been wrong twice since: the relief normal came
       back with PROMPT A and the catch with PROMPT F. What stays deleted is
       the LAYER -- uSheen's specular sprite and the refraction `lines` that
       rode on it, a coat composited over the bubble that would look the same
       over any shape. The catch is not that; it is the material's own
       boundary, and it moves and breaks with the body.
       Original fluid gestures also reveal the solve's curling filaments as
       material density, with the old thin-fluid opacity law. */
    display: [
      'uniform sampler2D uDye; uniform vec2 uDyeTexel;',
      'uniform sampler2D uCurl; uniform vec2 uCurlTexel; uniform vec2 uVort; uniform float uMist;',
      'uniform sampler2D uVelocity; uniform vec2 uVelocityTexel;',
      'uniform vec3 uFast; uniform vec3 uSlow; // the storm stops, linear',
      'uniform vec3 uLight; uniform vec3 uDeep; uniform float uMaxAlpha; uniform float uCurve;',
      'uniform vec2 uEdge;',
      'uniform vec2 uQuiet; uniform vec2 uQuietAt; uniform float uQuietFloor;',
      'uniform float uOpaque;',
      'uniform vec3 uClassicDeep; uniform vec3 uClassicLight; uniform vec4 uClassic; uniform float uClassicLift;',
      'uniform vec3 uClassicSheen; uniform vec3 uClassicFast; uniform vec3 uClassicSlow; uniform vec2 uClassicOn;',
      /* THE BODY IS THE FORMS' OWN FIELD, READ HERE DIRECTLY.
         Five rounds of the owner rejecting the same look ended on "when it
         merges as one single blob you can clearly see its made up of the two
         eye pieces" and "it still never got that yummy looking gelatin look".
         Both were the substrate. The dye the fluid advects is a lagged, blurred
         copy of the source, and a gaussian read as thickness is a lens that
         peaks in the middle and lies flat at the rim -- the opposite of a
         solid -- while two lagged lobes summed are a peanut with a crease and
         two normals, so two catches.
         So the SOLID body is no longer read off the dye. The same functions the
         dye pass injects from (fluidForm, formMorph, bodyLocal) are evaluated
         here per pixel: one scalar field, whose -log is already the smooth
         minimum of the pieces' squared distances (see formRangeOf), so the
         pieces are a union before anything is thresholded -- one silhouette,
         one thickness, one normal, one catch. The fluid keeps the two jobs it
         is good at: the LIQUID state shows the trail the dye leaves behind the
         body, and the MIST state is the dye and the curl, as before. */
      FLUID_FORMS,
      /* ALL EIGHT CHUNKS, IN THE MODULE'S OWN DEPENDENCY ORDER. Four were
         pasted here and four were not, and the two that mattered most were
         among the missing: without OPTICS_THICKNESS the live body measured
         L 0.445 at the rim rising to 0.503 at the core -- the rim DARKER than
         the core, the inverted profile the standard forbids -- while the
         module standalone gives +0.045 the right way round. And without
         OPTICS_REFRACTION there was no `refract(` call anywhere in this file,
         so backdrop displacement was exactly zero: colour laid over a
         background, which is the "sticker" the owner rejected, rather than a
         transparent solid. uploadOptics()/opticsDefaults() already carried all
         20 uniforms, so nothing else was needed.
         The hand-written `uniform vec4 uOpticsRefract` that used to sit here
         is GONE ON PURPOSE: OPTICS_REFRACTION declares it itself, and a second
         declaration is a compile error that would blank the character. */
      OPTICS_PRELUDE,
      OPTICS_THICKNESS,
      OPTICS_REFRACTION,
      OPTICS_ENVIRONMENT,
      OPTICS_FRESNEL,
      OPTICS_CAUSTIC,
      OPTICS_SKIN,
      OPTICS_SHADE,
      'uniform vec4 uJellyShape;  // edge distance in sigma, fatness, how much of its own path the scattered light makes on the way back out, light wrap',
      'uniform vec4 uJellyState;  // solid, liquid, mist weight, ink at the peak of the fluid body',
      'uniform vec3 uJellyIllum;  // the one illuminant, linear, with its gain',
      'uniform vec3 uJellyAbsorb; // per-channel absorption over one unit of path',
      'uniform vec4 uJellyPath;   // path floor, path gain, scatter strength, scatter build rate',
      'uniform vec3 uJellyTint;   // the colour the scattered light carries, relative to the illuminant',
      'uniform vec4 uJellyLine;   // the edge line colour on a light ground (linear core stop) and, in w, how much the ground is light',
      'uniform vec4 uJellyRim;    // rim gain, rim power, velocity warp, trail',
      'uniform vec4 uJellyCover;  // coverage floor, coverage ceiling, margin over the solved coverage, and the body\'s own exposure',
      'uniform vec4 uJellyGround; // the ground the canvas is composited over (sRGB, as the browser blends it) and how much of it the mass passes',
      'uniform vec2 uJellyClear;  // TRANSLUCENCY: optical depth the coverage is taken over, and the share of the solved coverage the thinnest skin keeps',
      'uniform vec2 uPixel; uniform float uTime;',
      'uniform float uFace;      // the face (recess) as a fraction of the canvas',
      'uniform vec4 uBrim;       // lip radius in canvas uv, half-width in canvas uv, strength, steepness of the torus normal',
      'uniform float uCanvasPx;  // one canvas pixel in canvas uv',
      'uniform vec4 uJellyGlow;  // light through the body: strength, far-side power, thick blocking, inner image strength',
      'const vec3 jellyLight = vec3(-0.4479, 0.6470, 0.6171); // the one light, from the upper left and in front',
      'float jellyInk (vec2 uv) { vec2 d = max(SAMPLE(uDye, uv, uDyeTexel).xy, 0.0); return d.x + d.y; }',
      /* DISTANCE TO THE BODY, in sigma of the form's own field. Each of the two
         forms is read as a distance (formRangeOf: -log of a sum of gaussians is
         the smooth minimum of the pieces' squared distances, so the pieces are
         a union before anything is thresholded), and a change of form is an
         interpolation of the two DISTANCES: the boundary moves continuously
         from one shape to the other as one surface. The dye pass keeps its own
         journey morph (formMorph); it is not evaluated here, because inlining it
         at five taps was more than the Direct3D shader compiler would finish.
         The analytic form shrinks as the body melts (gain) and is in union with
         the fluid's trail where the state is liquid (trail). A form of 0 -- the
         original fluid taking over -- is FORM_FAR everywhere, so the body draws
         in to nothing as the mix runs toward it. */
      /* THE FORM MIX IS TAKEN ON THE DISTANCES, AND THAT IS AN OWNER RULING,
         not a preference. It was briefly moved onto the FIELD -- one scalar,
         `mix(fa, fb) + drops`, one formRangeOf -- on the reading that a single
         thresholded scalar is a single surface and therefore never comes apart.
         It is a single surface, and that is exactly what was rejected: a field
         union makes EVERY transition one connected body, so writing's four
         separate droplets and thinking's four separate pieces were dragged into
         one blob on the way in and out of every state.
         The owner ruled on 2026-09-19 at 10:30Z local that the body is one
         piece ONLY when the two eyes merge, and that every other form and
         transition keeps its separate pieces exactly as they were at 22def14b.
         So this is 22def14b's law again: each form is read as a DISTANCE and
         the two distances are interpolated, which moves the boundary from one
         shape to the other as a surface while leaving each form's own pieces
         as its own pieces.
         The droplets survive the revert because they are folded into each
         form's OWN field, before that form's formRangeOf, rather than added to
         a merged scalar afterwards. A sum of gaussians is the smooth minimum of
         the pieces' distances, so a droplet near the body still joins it and a
         droplet away from it is still its own piece -- which is the whole of
         what the droplets were asked to do -- and a distance mix of two fields
         that each already contain the droplets carries them through a change of
         form without ever unioning the two forms together. */
      'uniform vec4 uDrops[3]; // CHARACTER PIECES: canvas uv centre, own sigma, field weight',
      /* The pieces, in the body's own field. Each is one gaussian summed with
         the form, and a sum of gaussians is the smooth minimum of their
         distances (formRangeOf), so a piece near the body is genuinely joined
         to it and a piece away from it is genuinely its own surface -- with no
         decision anywhere about which it is. They are in canvas uv rather than
         body-local on purpose: a piece has come OFF the body, so it must not
         inherit the body's jiggle, squash or breath. */
      'float jellyDrops (vec2 uv) {',
      '  float a = 0.0;',
      '  for (int i = 0; i < 3; i++) {',
      '    if (uDrops[i].w > 0.001) {',
      '      vec2 d = (uv - uDrops[i].xy) / max(uDrops[i].z, 0.001);',
      '      a += exp(-dot(d, d)) * uDrops[i].w;',
      '    }',
      '  }',
      '  return a;',
      '}',
      'float jellyDist (vec2 uv, float gain, float trail) {',
      '  vec2 local = bodyLocal(uv);',
      '  float tr = jellyInk(uv) * trail;',
      '  float drops = jellyDrops(uv) * gain;',
      '  float a = formRangeOf(max(fluidForm(local, uForm.x, uForm.w) * gain + drops, tr));',
      '  float b = formRangeOf(max(fluidForm(local, uForm.y, uForm.w) * gain + drops, tr));',
      '  return mix(a, b, clamp(uForm.z, 0.0, 1.0));',
      '}',
      /* THICKNESS. d is distance to the form's material in sigma; the body ends
         at uJellyShape.x. A superellipse profile is thick right up to a fast
         roll-off at the rim -- the rounded edge of a gummy, not a lens -- and
         because it is nearly flat over most of the interior, the saddle between
         two merging lobes carries almost full height: the neck fills in and the
         merged form has one surface. */
      /* ...and the profile itself is now OPTICS_THICKNESS's, not this file's.
         `bodyInk` is the normalised inside-ness the module's chunks expect: 0
         at the silhouette, 1 at the deepest point, from the same distance the
         coverage is solved from. uOpticsThick is uploaded as
         (0, 1, TUNE.jelly.fat), so opticsThickness(bodyInk(d)) evaluates
         exactly the superellipse this file used to evaluate for itself -- the
         profile did not move, but it now lives in ONE place, and every optical
         term (the slope, refraction, both caustics, transmission) reads the
         same thickness the colour does. That is what the chunk was for; before
         this it compiled and nothing called it. */
      'float bodyInk (float d) { return clamp(1.0 - d / uJellyShape.x, 0.0, 1.0); }',
      /* ONE TONEMAP, one scalar on all three channels (it holds the hue), with a
         knee at 0.8 and an exponential shoulder above it. */
      'float jellyTone (float x) { return x < 0.8 ? x : 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2)); }',
      'vec3 jellyTonemap (vec3 c) { float over = max(max(c.r, c.g), c.b); return c * (jellyTone(over) / max(over, 0.0001)); }',
      /* THE BRIM: the lip as a torus of the same material, returned
         premultiplied. rc is the canvas radius (offset by `sub` canvas pixels
         for supersampling); bd is 0 on the line's centre and 1 at its edge;
         bThick is the torus's own thickness profile and bn its normal (radial,
         turning over at both edges), so the same law -- transmission over its
         own path (never below half the mass's: a 2-3 px line has no room for a
         clear edge), scatter in the core colour, the environment mirrored with
         Fresnel and screened on, the glassy edge -- gives a thin jewel line with
         a catch where the tube faces the softbox. */
      'vec4 jellyBrim (vec2 cuv, float sub) {',
      '  float rc = length(cuv - 0.5) + sub * uCanvasPx;',
      '  float bd = abs(rc - uBrim.x) / max(uBrim.y, 0.0001);',
      '  float bpx = uCanvasPx / max(uBrim.y, 0.0001);',
      '  float brimCover = (1.0 - smoothstep(0.86, 1.0, bd)) * uBrim.z; // a slime ring: a soft but definite edge',
      '  if (brimCover <= 0.001) return vec4(0.0);',
      '  float bThick = sqrt(max(1.0 - min(bd, 1.0) * min(bd, 1.0), 0.0));',
      '  vec2 radial = (cuv - 0.5) / max(length(cuv - 0.5), 0.0001);',
      '  float sgn = rc > uBrim.x ? 1.0 : -1.0;',
      '  vec3 bn = normalize(vec3(radial * sgn * min(bd, 1.0) / max(bThick, 0.12) * uBrim.w, 1.0));',
      '  vec3 Tb = exp(-uJellyAbsorb * (uJellyPath.x + mix(0.55 + 0.45 * bThick, 0.72 + 0.28 * bThick, uJellyLine.w) * uJellyPath.y)); // on paper the line is the deep colour through the crest and thinner at its edges, so it turns like a tube and not a gasketout',
      /* THE INLAY IS LIT LIKE THE CASING IT SITS IN. The casing's facets are
         lit from the upper left (src/home-circle.js, #-bezel and #-chamfer run
         corner to corner from (100,20)), and jellyLight is the same direction;
         `around` is how much this point of the ring faces that light, 1 on
         the upper-left arc and 0 on the lower-right. Without it the torus was
         evenly lit all the way round -- a plastic tube laid on a metal ring
         that has a direction of light -- and its sheen was a uniform milkiness
         along the whole line. Now the inlay darkens where the ring turns away
         and carries ONE catch, on the lit quarter, where the casing's own wet
         arc is. */
      '  float around = 0.5 + 0.5 * dot(radial, normalize(jellyLight.xy));',
      '  float lb = dot(bn, jellyLight) * 0.5 + 0.5;',
      '  float wrapB = mix(1.0 - uJellyShape.w, 1.0, lb * lb) * mix(0.58, 1.0, around);',
      /* WHAT IS BEHIND THE TUBE IS THE CHANNEL FLOOR, NOT A LAMP. A translucent
         tube on a dark sheet is dark where it is thin, because what shows
         through thin material is the floor under it; its colour is the light
         scattered back from INSIDE (scatterB, the deep stop), brightest at the
         crest where it is thickest, and the crest carries the one specular the
         room puts on it (crestB). Read as the illuminant seen through the
         material, as it was, the tube was a uniform neon on black and a flat
         gasket on white: lit from behind everywhere, so no thick and no thin. */
      '  vec3 throughB = mix(uJellyGround.rgb, uJellyIllum, 0.42) * Tb * wrapB;',
      '  vec3 scatterB = uJellyIllum * uJellyTint * uJellyPath.z * (1.0 - exp(-bThick * uJellyPath.w)) * wrapB;',
      '  float Fb = opticsFresnel(bn);',
      '  vec3 halfB = normalize(normalize(uOpticsEnvKey.xyz) + vec3(0.0, 0.0, 1.0));',
      '  float sheenB = pow(max(dot(bn, halfB), 0.0), 10.0) * (0.06 + 0.62 * pow(around, 5.0)) * uBrim.z; // the crest of the torus, and only where it faces the light',
      '  float turnB = 1.0 - clamp(bn.z, 0.0, 1.0);',
      '  vec3 rimB = mix(uJellyIllum * Tb, uJellyLine.rgb, uJellyLine.w) * uJellyRim.x * pow(turnB, uJellyRim.y);',
      '  vec3 brim = jellyTonemap((throughB + scatterB) * (1.0 - Fb) + rimB);',
      '  brim = mix(brim, jellyTonemap(uJellyLine.rgb * uJellyIllum * (0.34 + 0.80 * lb * lb)), uOpaque); // the ring in the same solid colour, lit the same way',
      '  brim = mix(brim, opticsLinear(mix(uClassicDeep, uClassicLight, 0.35) * (0.80 + 0.20 * lb)), uClassic.x); // classic: the ring in the status colour, as the old lip was',
      '  brim += (1.0 - brim) * sheenB * (0.6 + 0.4 * Fb / 0.03); // a restrained sheen, a little stronger where the tube turns',
      '  float crestB = pow(clamp(bn.z, 0.0, 1.0), 36.0) * (0.30 + 0.70 * around); // the gloss line along the crest, all the way round, strongest facing the light',
      '  brim += (1.0 - brim) * crestB * mix(0.55, 0.32, uOpaque); // a gloss line along the crest, softer on the solid ring',
      '  float brimA = brimCover * 0.96;',
      '  return vec4(opticsEncode(brim) * brimA, brimA);',
      '}',
      'void main () {',
      '  vec2 uv = (vUv - 0.5) / uFace + 0.5; // face uv: the recess is FACE of the canvas',
      '  vec2 p = uv - 0.5;',
      '  float solid = uJellyState.x, liquid = uJellyState.y, mistW = uJellyState.z;',
      /* THE FLUID'S OWN READING: the mist, streaked along the flow and lit by
         its own curl (recovered from 90dd07e5, unchanged in law), and the ink
         the liquid trail is read from. */
      '  float ink = jellyInk(uv);',
      '  vec2 flow = SAMPLE(uVelocity, uv, uVelocityTexel).xy;',
      '  float curlInk = 1.0 - exp(-abs(SAMPLE(uCurl, uv, uCurlTexel).x) * uVort.y);',
      '  float amount = ink;',
      '  if (mistW > 0.001) {',
      '    amount = max(amount, mistW * uVort.x * curlInk);',
      '    float streak = (ink + jellyInk(uv - flow * 0.03) + jellyInk(uv - flow * 0.06)) / 3.0;',
      '    amount = mix(amount, max(amount, streak), mistW);',
      '  }',
      '  float mistA = uMaxAlpha * 0.8 * (1.0 - exp(-1.6 * amount)) * mistW;',
      /* THE LIQUID LAYER: the dye the solve carries (the tool bands, the trail
         behind a moving body), drawn as water with the soft declared band
         (uEdge) the body ended over before the substrate change, coloured by
         its own depth through the same material and lit a little by its curl.
         It sits UNDER the solid body and scales with the liquid state. */
      '  float liquidA = smoothstep(uEdge.x - uEdge.y, uEdge.x + uEdge.y, ink) * liquid * (1.0 - mistW) * mix(1.0, 1.35, uJellyLine.w);',
      '  float inkT = clamp(ink / max(uJellyState.w, 0.02), 0.0, 1.0);',
      /* CLASSIC, THE OLD WAY: the 09-16 pass had no forms; the body WAS the
         dye, read through depthOf (a steep rise past a threshold, so the
         water is a body with an outline), lit by a relief normal from the
         dye's own slope, with the hard white sheen where that relief faces
         the light. That relief is the "look and feel" the owner named: a
         soft, irregular water body, not a dome. Same law here on the live
         dye, normalised the way the liquid layer normalises it. */
      /* NOTHING IN THIS PASS MAY GO ABOVE THE MATERIAL'S OWN LIGHT STOP.
         uJellyIllum * exp(-uJellyAbsorb * pathFloor) IS the thin stop at the
         exposure the liquid and the mist keep, and this statement used to
         finish with `* mix(1.0, 1.25, ...)`, i.e. a quarter above it wherever
         the curl was strong. That is additive white laid on top of a declared
         colour -- the shape the owner has rejected four times -- and no gate
         measured it. The curl still reads exactly as far: the ratio between
         still and spinning water is unchanged at 1.25, the range has simply
         been hung BELOW the stop instead of above it. */
      '  vec3 liquidRGB = uJellyIllum * exp(-uJellyAbsorb * (uJellyPath.x + uJellyPath.y * mix(inkT, 0.45 + 0.55 * inkT, uJellyLine.w))) * mix(0.8, 1.0, smoothstep(0.1, 0.85, curlInk));',
      /* The mist is the same material read thin: still water carries the
         core end of the ramp, spinning water the thin end, under the same
         illuminant -- so the cloud is a bright cloud of the body's own colour
         and not the dark storm stop that turned it to mud. */
      /* Same stop, same rule: the leading 1.3 put the spinning end of the mist
         30% ABOVE the material's light stop. Removed, not softened. The mist's
         own range is untouched -- it comes from the path it is read over, not
         from that factor -- so still water still sits at the core end of the
         ramp and spinning water at the thin end, which is now exactly the stop
         and not past it. */
      '  vec3 mistRGB = uJellyIllum * exp(-uJellyAbsorb * mix(uJellyPath.x + uJellyPath.y * 0.3, uJellyPath.x, smoothstep(0.1, 0.85, curlInk)));',
      /* THE BODY. The field is read at the pixel and its four neighbours, so
         the silhouette is an analytic one-pixel edge (signed distance in
         pixels from the field's own gradient) and the normal is the thickness
         profile's own slope. The fluid's velocity bends the sampling point a
         little, so the solid still wobbles with the water it sits in. */
      '  float gain = 0.3 + 0.7 * solid;',
      '  float trail = uJellyRim.w * liquid / max(uJellyState.w, 0.02);',
      '  vec2 uvW = uv - flow * uJellyRim.z;',
      '  vec2 px = vec2(uPixel.x, 0.0), py = vec2(0.0, uPixel.y);',
      '  float d0 = jellyDist(uvW, gain, trail);',
      '  float dL = jellyDist(uvW - px, gain, trail), dR = jellyDist(uvW + px, gain, trail);',
      '  float dB = jellyDist(uvW - py, gain, trail), dT = jellyDist(uvW + py, gain, trail);',
      '  float R = uJellyShape.x;',
      '  float slopeD = length(vec2(dR - dL, dT - dB)) * 0.5 + 0.0001; // sigma per pixel',
      '  float cover = clamp((R - d0) / slopeD + 0.5, 0.0, 1.0); // one pixel of antialiasing at every size',
      '  float ink0 = bodyInk(d0);',
      '  float iL = bodyInk(dL), iR = bodyInk(dR), iB = bodyInk(dB), iT = bodyInk(dT);',
      '  float thick = opticsThickness(ink0);',
      '  float tL = opticsThickness(iL), tR = opticsThickness(iR), tB = opticsThickness(iB), tT = opticsThickness(iT);',
      /* The slope OF THAT PROFILE, from the module, so the surface the light
         reads is the surface the colour reads. uOpticsNormalGain is uploaded
         as TUNE.jelly.height, which is the number this line used to carry. */
      '  vec3 slope = opticsSlope(iL, iR, iB, iT, uPixel);',
      /* The curvature of the same profile: negative where the body converges
         the light that crosses it, which is what opticsInnerCaustic wants. */
      '  float lap = tL + tR + tB + tT - 4.0 * thick;',
      '  vec2 skin = opticsSkin(uv - uBody.xy, slope);',
      '  vec3 n = normalize(vec3(slope.xy + skin, 1.0));',
      /* THE LIGHT, in the order it takes. The illuminant comes through the
         body over its own thickness (Beer-Lambert, per channel: the thin rim
         is near the illuminant, the mass is the deep stop); light that
         scattered inside comes back out, growing with thickness, in the core
         colour; the surface mirrors the environment -- a stretched softbox with
         a hot core, which is the wet streak -- weighted by Fresnel; and the
         silhouette glows where the surface turns away from the eye. */
      /* Beer-Lambert over the module's own optical path: uOpticsPath is
         uploaded as (pathGain, pathFloor), so opticsPath(thick) is the
         pathFloor + thick * pathGain this line used to spell out. Both
         caustics measure their own path with the same function, which is
         why they can no longer drift from the body's transmission. */
      '  vec3 T = opticsTransmit(uJellyAbsorb, thick);',
      '  vec3 illum = uJellyIllum * uJellyCover.w; // the body is exposed on its own, so the liquid and the mist keep theirs',
      '  float lambert = dot(n, jellyLight) * 0.5 + 0.5; // half-Lambert; `half` itself is a reserved word in GLSL ES',
      '  float wrap = mix(1.0 - uJellyShape.w, 1.0, lambert * lambert);',
      /* THE LIGHT THAT SCATTERED INSIDE, AND THEN HAD TO GET OUT AGAIN. This
         term used to be (1 - exp(-thick * rate)) and nothing else, i.e. the
         deeper the material the more light came back, with no absorption on
         the way out. That is not a thing a dye does: light that turns round
         at depth crosses the material a second time and is eaten by the same
         absorber as everything else. Without that factor the burst grew
         without limit into the mass and made the CORE the brightest part of
         the body -- measured, L ran 0.550 at the rim to 0.662 at the core,
         which is STANDARD-OPTICS section 4 exactly inverted, and it is also
         why the chroma peak sat at the core instead of at intermediate
         thickness (section 5.1 as corrected). uJellyShape.z is how much of the
         path the scattered light makes on its way back out. The burst is not
         removed and is not turned down; it is absorbed, so it now peaks in
         the middle of the depth where a real sweet is most colourful. */
      '  vec3 scatter = illum * uJellyTint * uJellyPath.z * (1.0 - exp(-thick * uJellyPath.w)) * wrap * opticsTransmit(uJellyAbsorb, thick * uJellyShape.z);',
      /* THE GROUND, SEEN THROUGH THE BODY -- AND NOW DISPLACED, which is the
         whole difference between a transparent solid and a stain.
         opticsRefracted() refracts the eye ray at this body's own normal,
         carries it the body's own thickness and samples the ground where it
         lands, the three channels at three slightly different offsets. A
         flat-on normal lands on itself, so the middle is undisturbed and the
         rim -- where the surface turns hardest -- bends the ground furthest.
         Before this there was no `refract(` call in this file at all, so the
         displacement was exactly zero: STANDARD-OPTICS section 2's whole point.
         ONE PASS, NOT TWO. This term used to carry T twice ("light goes in,
         crosses, comes back out"), which is the law for light reflecting off a
         sheet BEHIND the body. What is actually behind this canvas is the page,
         and its light crosses the material once on its way to the eye, so the
         attenuation is T once. The old comment is wrong and is replaced rather
         than kept; the disagreement is reported.
         WHAT IS BEHIND IT. uOpticsBackdropOn stays 0, so opticsBackdrop() uses
         the module's own procedural ground, and this file uploads that ground
         from the page's own colour with the horizon lifting a disc inside it --
         structure, because a flat field shows no displacement however hard you
         bend it. A real backdrop texture is still the unlock (STANDARD-OPTICS
         section 3): over a near-black page there is very little behind the body
         for refraction to move, and that is the frame lane's dependency, not a
         missing term here. */
      '  vec2 tapOff = opticsCausticTap(uv) - uv;',
      /* The thickness up-light of here, i.e. the material the light crossed
         before it landed on the ground behind this pixel. First order off the
         field's own gradient: a sixth jellyDist tap is what the Direct3D
         shader compiler would not finish (REPORT-JELLY-BODY). */
      '  float thickTap = opticsThickness(bodyInk(d0 + dot(vec2(dR - dL, dT - dB) / (2.0 * uPixel), tapOff)));',
      '  float F = opticsFresnel(n);',
      '  vec3 mirror = opticsReflection(n) * F;',
      /* The caustic lands ON THE GROUND BEHIND THE BODY and is then seen
         THROUGH it, so it is added to the backdrop before the body absorbs it.
         coverHere is handed in as 0 on purpose: this term then exists only
         where the body is, and it cannot become the offset copy of the
         silhouette the owner rejected ("the shadow does not look like a shadow
         it looks like a second blob of like different material. we dont need
         shadowing"). Nothing is added outside the body by this file. */
      '  vec3 sheet = (opticsRefracted(uv, n, thick) + opticsCaustic(illum, uJellyAbsorb, thickTap, 0.0)) * T * uJellyGround.w;',
      /* THE MODULE'S ONE CALL SITE, for the terms it owns: the illuminant
         through the thickness, the mirrored environment, the glassy rim, and
         the light the lens converges inside the mass.
         - the key is handed in ALREADY WRAPPED, so the transmitted light keeps
           this body's dome shading instead of arriving flat-on;
         - coverage is handed in as 1, because this renderer solves its own
           coverage per theme further down and would otherwise apply it twice;
         - uOpticsMix.x is uploaded 0, because the host owns the backdrop term
           above -- it has to, to carry the ground caustic and uJellyGround.w.
         The mirrored environment is SUBTRACTED back out: opticsShade adds it
         linearly, and this renderer screens it on after its own tonemap so a
         hot white catch stays white instead of taking the body's hue. The
         expression subtracted is exactly the one opticsShade added. */
      /* WHAT SHOWS THROUGH THE BODY IS THE PAGE, NOT A LAMP. opticsShade's
         transmitted term is `illum * T`: the illuminant seen through the
         material, i.e. a body lit from BEHIND everywhere. On a dark sheet that
         made the thin flank a pale pink haze (white light through a little
         red) and the thick core no deeper than it -- frosted plastic, not
         candy. Behind this body is the page; what comes through thin material
         is the page's own tone, and the body's colour is the light scattered
         back from inside it (`scatter` below, the deep stop, thickest =
         brightest). Same law as the brim (jellyBrim), so the character and
         the tube are one material. The mix keeps a little of the room's
         light in the transmission so the flank never goes to nothing. */
      '  vec4 shaded = opticsShade(uv, ink0, n, 1.0, uJellyAbsorb, illum * wrap, lap);',
      /* opticsShade sends the rim in the transmitted colour. On paper the edge
         line has to be the deep colour or the silhouette does not hold against
         the page, so the difference between the two is added back at the same
         rim weight: mix(a, b, w) - a == (b - a) * w, and this is that and
         nothing more. uOpticsFresnel carries the gain and power this line used
         to spell as uJellyRim.x / uJellyRim.y. */
      '  float rimTerm = opticsRim(n, 1.0);',
      '  vec3 rim = (uJellyLine.rgb - illum * wrap * T) * uJellyLine.w * rimTerm;',
      /* LIGHT THROUGH THE BODY. A solid is lit on the side facing the light
         and dark on the other; a translucent body is lit on the far side TOO,
         by the light that entered the lit flank and crossed it, and that
         light leaves most where the material is thin -- the far rim glows in
         the body's own transmitted colour (the reference's bright orange
         lower edge). Derived from the normal and the thickness, so it cannot
         exist off the body and moves with the surface. */
      '  float far = pow(max(1.0 - lambert, 0.0), uJellyGlow.y); // max: pow of a rounding-negative is NaN and a NaN pixel drops out of the body',
      /* max(0.0, ...): uJellyGlow.z is 2.0, so past half thickness the blocking
         factor went NEGATIVE and this term started SUBTRACTING light from the
         core -- a negative radiance, which is not a thing light does. Clamped
         at zero: thick material blocks the far-side glow completely and stops
         there. Found while wiring the optics chunks; it is a defect of this
         line and not of anything the module does. */
      '  vec3 glow = illum * uJellyTint * uJellyGlow.x * far * max(0.0, 1.0 - thick * uJellyGlow.z);',
      /* THE INNER IMAGE. A clear body shows its light twice: once mirrored on
         the front surface (the catch above) and once off the INSIDE of the
         back surface, where the ray that entered turns round and comes out
         again -- inverted, low on the far side, and coloured by two passes
         through the material. A rubber ball has no second image; a marble or
         a gummy always does. The back surface at the matching point faces
         the other way, so its normal is the front one mirrored across the
         axis; the image is attenuated over the double path (T twice) and so
         goes white through thin material and the deep colour through thick. */
      '  vec3 nBack = vec3(-n.x, -n.y, n.z);',
      '  vec3 innerImage = opticsReflection(nBack) * T * T * uJellyGlow.w;',
      /* opticsShade already carries the illuminant through the thickness, the
         mirrored environment, the glassy rim and the inner caustic, each with
         its own weight; `- mirror` takes the environment back out so it can be
         screened on after the tonemap (see the call site above). What this
         file adds on top is what the module does not model: the light that
         scattered inside and came back out, the far-side glow and the second,
         inner image of the light. */
      '  vec3 radiance = shaded.rgb - mirror + rim + (scatter + sheet + glow + innerImage) * (1.0 - F);',
      /* THE SOLID BLOB: its own colour under the one light, darker where the
         surface turns away, one soft white catch. No transmission, no
         scatter, no refracted page. */
      '  float turnO = 1.0 - clamp(n.z, 0.0, 1.0);',
      '  vec3 opaqueRad = uJellyLine.rgb * uJellyIllum * (0.32 + 0.80 * lambert * lambert) * (1.0 - 0.28 * turnO);',
      '  vec3 halfO = normalize(normalize(uOpticsEnvKey.xyz) + vec3(0.0, 0.0, 1.0));',
      '  opaqueRad += vec3(1.0) * pow(max(dot(n, halfO), 0.0), 34.0) * 0.50 * max(uJellyIllum.g, 0.2);',
      '  radiance = mix(radiance, opaqueRad, uOpaque);',
      '  float rimLum = rimTerm;',
      /* No SHADOW term, and this is not one. There was a caustic (dark themes)
         and a shadow (light themes) here: the body's own field sampled at an
         offset, which is a displaced copy of the silhouette in different
         material maths, and the owner saw exactly that: "the shadow does not
         look like a shadow it looks like a second blob of like different
         material. we dont need shadowing." Deleted, not softened. `sheet` is
         the opposite of a shadow: it is the ground read THROUGH the body, at
         the body's own place, over the body's own thickness. */
      /* The reflection is the LIGHT's colour, not the body's, so it is added
         after the body's own tonemap as a screen: what the body leaves of the
         way to white, the reflection takes in proportion to its own strength.
         A hot core lands on white; the soft band lifts its patch a little. */
      '  vec3 body = jellyTonemap(radiance);',
      '  body += (1.0 - body) * (1.0 - exp(-mirror)) * (1.0 - uOpaque);',
      /* SLIME (owner, 2026-09-19: "more lighting effects ... like a slime
         ball"): a second, smaller catch from a fill light lower-right, and a
         wet sheen where the surface turns toward the key. */
      '  vec3 half2 = normalize(vec3(0.45, -0.35, 0.82));',
      '  float catch2 = 0.0; // the 09-18 blob has ONE catch',
      '  vec3 halfKey = normalize(normalize(uOpticsEnvKey.xyz) + vec3(0.0, 0.0, 1.0));',
      '  float sheenK = 0.0;',
      '  body += (1.0 - body) * (catch2 + sheenK) * mix(1.0, 0.45, uOpaque);',
      /* COVERAGE IS SOLVED, NOT PICKED -- and this is the whole answer to "it
         looks pale" and "it looks solid, not like gelatin" being the same
         complaint seen from two sides.

         The browser composites this canvas over the page: what a person sees
         is  seen = a * paint + (1 - a) * ground. Turn that round. For the
         colour `want` this material HAS at this thickness, the paint is forced,

             paint = (want - (1 - a) * ground) / a

         and that paint only exists (0..1 per channel) when

             a >= aMin = max over channels of |want - ground| / (want > ground ? 1 - ground : ground).

         Below aMin the ground is still in the pixel and the colour cannot get
         there: that IS "pale", and no amount of dye fixes it. Above aMin the
         extra coverage buys no colour at all and only hides the page: that is
         "solid, not gelatin". So for a wanted colour over a known ground there
         is one best coverage, aMin, and it is DIFFERENT ON EVERY THEME --
         measured on this palette, the thick core needs 99% over white paper
         and 65% over black. That is why one number could never serve five
         grounds, and why this is solved per pixel per theme instead.

         The floor keeps a defined silhouette where the material itself is
         clear; the ceiling is the one deliberate compromise (see TUNE). */
      '  vec3 want = opticsEncode(body);',
      /* The 09-16 pass wrote PREMULTIPLIED colour with the alpha scaled to 0.6
         on dark sheets, which is additive light: the body glows over a dark
         page. Straight alpha here, so the same picture is colour / 0.6 at
         alpha * 0.6 (uClassic.w and .y carry those per sheet). The old relief
         came from the dye's blotchy slope; today's normal carries the skin
         ripple, which gives the sheen the same broken, streaky edge. */
      /* THE BODY IS THE DYE (owner: "a non uniform body that moves like slime
         ... or some goo, it did this before"). The 09-16 pass never drew a
         form: the water WAS the dye, read through a steep depth ramp, its
         relief normal from the dye's own slope, the white sheen where that
         relief faces the light. The dye is still here (the liquid layer's
         source), swirled by the same solve, so the same reading gives the
         same blotchy, wobbling goo. The form silhouette is not used at all
         in this mode; the animations that move the seat are untouched. */
      '  float invW = uClassic.w / max(uJellyState.w, 0.02);',
      '  float aRaw = ink * invW, aC = clamp(aRaw, 0.0, 1.0); // the old amount ran well past 1 in the core; the contour lines count on that',
      '  float depthC = smoothstep(0.08, 0.65, aC);',
      '  float cL = smoothstep(0.08, 0.65, clamp(jellyInk(uv - px) * invW, 0.0, 1.0)), cR = smoothstep(0.08, 0.65, clamp(jellyInk(uv + px) * invW, 0.0, 1.0));',
      '  float cB = smoothstep(0.08, 0.65, clamp(jellyInk(uv - py) * invW, 0.0, 1.0)), cT = smoothstep(0.08, 0.65, clamp(jellyInk(uv + py) * invW, 0.0, 1.0));',
      '  vec3 nC = normalize(vec3((cL - cR) * 4.0, (cB - cT) * 4.0, 1.0)); // relief a little under the old 5.5: the dye is smoother now, so the top catches the light over a wider band',
      '  vec3 lC = normalize(vec3(-0.45, 0.65, 0.62)), hC = normalize(lC + vec3(0.0, 0.0, 1.0));',
      '  float shadeC = 0.72 + 0.28 * max(dot(nC, lC), 0.0);',
      '  float sheenC = pow(max(dot(nC, hC), 0.0), 56.0) * depthC;',
      '  float linesC = smoothstep(0.86, 1.0, 0.5 + 0.5 * sin(aRaw * 7.0)) * 0.15 * depthC; // the first sheen build (09-15 22:50): harder, closer contour lines that travel as the dye moves',
      '  vec3 sheenTint = mix(vec3(1.0), uClassicSheen, uClassicOn.y); // on dark sheets the old sheen was the fast stop, on light it was white',
      '  vec3 colourC = mix(uClassicLight, uClassicDeep, 0.45) * shadeC * mix(1.0, 0.8, depthC) + sheenTint * (0.9 * sheenC + linesC);',
      /* THE STORM'S OWN LIGHT, as that build had it at rest: |vorticity| from
         the solve's curl lights the water from the deep stop to the fast stop,
         a little even at rest (0.35), so the body glows where it spins and
         the shine travels with the water. This is the "shine that looks like
         it is moving". */
      '  float vaC = uVort.x * uClassic.y * curlInk * max(uJellyState.z, 0.35) * uClassicOn.x;',
      '  want = mix(want, clamp(colourC * uClassicLift, 0.0, 1.0), uClassic.x);',
      '  vec3 room = max(mix(uJellyGround.rgb, 1.0 - uJellyGround.rgb, step(uJellyGround.rgb, want)), 0.002);',
      '  vec3 need = abs(want - uJellyGround.rgb) / room;',
      /* ...AND THE SOLVE IS ONLY HALF OF IT. Everything above is the coverage
         that would reproduce `want` EXACTLY over the known ground -- and the
         paint that goes with it cancels the ground out, for every alpha, so
         the finished pixel is `want` whatever the alpha is. A body that always
         reproduces its own colour is an opaque body; nothing behind it can
         ever appear in it. That is the whole of "it reads opaque on every
         theme", and it is arithmetic, not a number that was set too high.
         What a translucent body actually does is BLOCK some of what is behind
         it and ADD its own light to the rest, and how much it blocks is
         Beer-Lambert in its own thickness -- almost nothing at the rim, nearly
         everything in the mass. `block` is that, and it is the same thickness
         the colour, the slope, the refraction and both caustics are read from,
         so the translucency lands exactly where the material is thin rather
         than on a silhouette-shaped mask. */
      '  float block = 1.0 - exp(-thick * uJellyClear.x);',
      '  float solved = clamp(max(max(need.r, need.g), need.b) * uJellyCover.z, uJellyCover.x, uJellyCover.y);',
      '  float matA = clamp(solved * mix(uJellyClear.y, 1.0, block), uJellyCover.x, uJellyCover.y);',
      '  matA = max(matA, clamp(rimLum, 0.0, 0.95)); // the glassy edge carries its own coverage',
      '  matA = mix(matA, 0.985, uOpaque); // the solid blob is solid',
      '  float bodyA = cover * matA * (1.0 - mistW);',
      '  float aC1 = uClassic.y * pow(depthC, uClassic.z) * (1.0 - mistW);',
      '  float totalC = vaC + aC1 * (1.0 - vaC);',
      '  vec3 vortC = mix(uClassicSlow, uClassicFast, smoothstep(0.1, 0.85, curlInk));',
      '  want = mix(want, (vortC * vaC + clamp(colourC * uClassicLift, 0.0, 1.0) * aC1 * (1.0 - vaC)) / max(totalC, 0.0001), uClassic.x * step(0.0001, totalC));',
      '  bodyA = mix(bodyA, totalC, uClassic.x); // the water is the body: no form silhouette',
      '  liquidA *= 1.0 - uClassic.x; // ...and no second reading of the same dye under it',
      /* THE PAINT IS THE MATERIAL'S OWN COLOUR, LAID ON UNFORCED -- and that
         is also where the last hard-edged patch went.
         This used to be (want - (1 - matA) * ground) / matA, the paint that
         cancels the ground so the composite lands on `want` exactly. Divide a
         bright colour by an alpha below 1 and it goes over 1, and the clamp
         that catches it PINS IT FLAT: every value above the ceiling rounds to
         the same number, per channel, so the bright middle of the catch
         becomes a plateau with a boundary at the clamp -- a flat patch with a
         hard edge that no amount of softening the light could remove, because
         it is made by the clamp and not by the light. That is the second
         decal (the hard-edged disc), and the red channel pinning before green
         and blue is why it had a colour of its own.
         Unforced there is nothing to divide and nothing to clamp: the value is
         a tonemapped colour, already inside 0..1 by construction, so the catch
         keeps a gradient all the way through and the material simply lets the
         browser put the real backdrop behind it --
             seen = matA * want + (1 - matA) * whatever is actually there
         which is the ring, the ground and the readout rather than the flat
         colour the solve had to assume. The solve is kept, as the coverage
         this colour needs against this ground at all; what is dropped is the
         forcing, which is the part that made the body opaque. */
      '  vec3 bodyS = want;',
      '  vec3 mistTone = jellyTonemap(mistRGB), liquidTone = jellyTonemap(liquidRGB);',
      /* The two veils: the body stays inside the ring, and it is dimmed behind
         the words (owner, 2026-09-15: "dim the parts directly behind the text"). */
      '  float veil = 1.0 - smoothstep(0.47, 0.5, length(p));',
      '  float dq = length((p - uQuietAt) / uQuiet);',
      /* JELLY BODY: the dimming reached 1.6 times the caption's box, which
         dimmed the body over most of the face (measured: a body centred at 0.3
         of the canvas height sat at 48% of its light). "Directly behind the
         text" is the box itself; the veil now clears by 1.3 times it. */
      '  veil *= mix(uQuietFloor, 1.0, smoothstep(0.85, 1.3, dq));',
      '  bodyA *= veil; mistA *= veil; liquidA *= veil;',
      /* Encode once, dither once, premultiply in sRGB -- which is the space
         the browser composites this canvas in. The mist goes over the body. */
      '  vec3 mistS = opticsEncode(mistTone), liquidS = opticsEncode(liquidTone);',
      '  float dither = (opticsHash(gl_FragCoord.xy + fract(uTime) * 71.0) - 0.5) / 255.0;',
      '  vec3 rgb = bodyS * bodyA + liquidS * liquidA * (1.0 - bodyA) + dither * bodyA;',
      '  float a = clamp(bodyA + liquidA * (1.0 - bodyA), 0.0, 1.0);',
      '  rgb = mistS * mistA + rgb * (1.0 - mistA);',
      '  a = mistA + a * (1.0 - mistA);',
      /* THE BRIM: the lip as a torus of the same material. rc is the canvas
         radius; bd is 0 on the line's centre and 1 at its edge; bThick is the
         torus's own thickness profile and bn its normal (radial, turning over
         at both edges), so the same law -- transmission over its own path,
         scatter in the core colour, the environment mirrored with Fresnel and
         screened on, the glassy edge -- gives a thin jewel line with a catch
         where the tube faces the softbox. Its coverage is its own, one canvas
         pixel of antialiasing, and it is drawn over the body and the mist. */
      '  vec4 brimPx = (jellyBrim(vUv, -0.5) + jellyBrim(vUv, 0.0) + jellyBrim(vUv, 0.5)) / 3.0; // three radial sub-samples: a 2-3 px line beads against the pixel grid otherwise',
      '  if (brimPx.a > 0.001) {',
      '    rgb = brimPx.rgb + rgb * (1.0 - brimPx.a);',
      '    a = brimPx.a + a * (1.0 - brimPx.a);',
      '  }',
      '  gl_FragColor = vec4(rgb, a);',
      '}'
    ]
  };

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error('shader: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function program(vertex, body, defines) {
    var header = 'precision ' + F.precision + ' float;\nprecision ' + F.precision + ' sampler2D;\n' +
      (F.linear ? '' : '#define MANUAL_FILTERING\n') + (defines || '');
    var fragmentSource = header + PRELUDE + '\n' + body.join('\n');
    var p = gl.createProgram();
    gl.attachShader(p, vertex);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    var u = {}, names = (VERTEX + fragmentSource).match(/uniform\s+\w+\s+\w+/g) || [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i].split(/\s+/)[2];
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p: p, u: u };
  }

  /* ------------------------------------------------------------ GPU setup */

  function renderable(internal, format, type) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok ? { internal: internal, format: format } : null;
  }

  /* Half-float render targets or nothing: WebGL2 with a colour-buffer float
     extension, else WebGL1 with OES_texture_half_float. */
  function formats(isWebGL2) {
    var high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    var out = { precision: high && high.precision > 0 ? 'highp' : 'mediump' };
    if (isWebGL2) {
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
      out.type = gl.HALF_FLOAT;
      out.linear = true;
      out.rgba = renderable(gl.RGBA16F, gl.RGBA, out.type);
      out.rg = renderable(gl.RG16F, gl.RG, out.type) || out.rgba;
      out.r = renderable(gl.R16F, gl.RED, out.type) || out.rg;
    } else {
      var half = gl.getExtension('OES_texture_half_float');
      if (!half) return null;
      gl.getExtension('EXT_color_buffer_half_float');
      out.type = half.HALF_FLOAT_OES;
      out.linear = !!gl.getExtension('OES_texture_half_float_linear');
      out.rgba = out.rg = out.r = renderable(gl.RGBA, gl.RGBA, out.type);
    }
    return out.rgba ? out : null;
  }

  function context(element) {
    var attributes = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true };
    element.addEventListener('webglcontextcreationerror', function (event) {
      stats.note = String(event.statusMessage || '').slice(0, 160);
    }, { once: true });
    var c = element.getContext('webgl2', attributes);
    if (c) return { gl: c, version: 2 };
    c = element.getContext('webgl', attributes) || element.getContext('experimental-webgl', attributes);
    return c ? { gl: c, version: 1 } : null;
  }

  /* failIfMajorPerformanceCaveat does not refuse every software renderer
     (Chromium's SwiftShader passes it), and software WebGL would spend a CPU
     core, and a phone's battery, on decoration. Read the renderer name the
     browser already offers; only the WebKit-style generic name asks for the
     debug extension, so Firefox is never asked for its deprecated one. */
  function software() {
    try {
      var name = String(gl.getParameter(gl.RENDERER) || '');
      if (/^webkit webgl$/i.test(name)) {
        var info = gl.getExtension('WEBGL_debug_renderer_info');
        if (info) name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || name);
      }
      return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
    } catch (error) { return false; }
  }

  function target(w, h, fmt) {
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    var filter = F.linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, F.type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex: tex, fbo: fbo, w: w, h: h, px: [1 / w, 1 / h] };
  }

  function pair(w, h, fmt) {
    var a = target(w, h, fmt), b = target(w, h, fmt);
    return { read: a, write: b, swap: function () { var t = this.read; this.read = this.write; this.write = t; } };
  }

  function release(t) {
    if (!t) return;
    if (t.read) { release(t.read); release(t.write); return; }
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  function bind(unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    return unit;
  }

  function use(prog, texelOf) {
    gl.useProgram(prog.p);
    if (prog.u.uTexel) gl.uniform2f(prog.u.uTexel, texelOf ? texelOf.px[0] : 0, texelOf ? texelOf.px[1] : 0);
    if (prog.u.uWall) gl.uniform1f(prog.u.uWall, 0.5 - (texelOf ? texelOf.px[0] : 0.004));
    return prog.u;
  }

  function draw(t) {
    if (t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* Allocate the fields for the current rung, carrying the picture across a
     step down so the circle does not blink. */
  function allocate() {
    var q = LADDER[level], old = T;
    T = {
      velocity: pair(q.sim, q.sim, F.rg),
      dye: pair(q.dye, q.dye, F.rg),
      pressure: pair(q.sim, q.sim, F.r),
      divergence: target(q.sim, q.sim, F.r),
      curl: target(q.sim, q.sim, F.r)
    };
    if (old) {
      var u = use(P.scale, T.velocity.read);
      gl.uniform1f(u.uValue, 1);
      gl.uniform1i(u.uSource, bind(0, old.velocity.read));
      draw(T.velocity.read);
      use(P.scale, T.dye.read);
      gl.uniform1i(u.uSource, bind(0, old.dye.read));
      draw(T.dye.read);
      release(old.velocity); release(old.dye); release(old.pressure); release(old.divergence); release(old.curl);
    }
    sizeCanvas();
  }

  function sizeCanvas() {
    if (!canvas) return;
    var width = canvas.clientWidth || ring.clientWidth;
    if (!width) return;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    /* three dye cells per pixel cap rather than two: the canvas is now the whole ring, and the brim is a 2-3 px line */
    var size = Math.max(64, Math.min(Math.round(width * ratio), LADDER[level].dye * 3));
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    measureQuiet();
  }

  /* ------------------------------------------------------------ forcing */

  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  var push = new Float32Array(12), emit = new Float32Array(12), emitAt = new Float32Array(9);

  function plan(time) {
    var t = clock, x = seat.x, y = seat.y, rr = Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5)) || 1;
    var sn = (x - 0.5) / rr, cs = (y - 0.5) / rr;
    /* THE BLOB'S COHESION: the seat pulls the water toward itself (an inward push; the projection keeps the flow
       divergence-free, so the water gathers and holds instead of streaming), and the storm loosens that grip. The
       second source slot is unused: one body of water. */
    var sp = persona.split, splitting = sp && t - sp.t < sp.span ? Math.sin(Math.PI * Math.min(1, (t - sp.t) / sp.span)) : 0;
    /* WEIGHT, IN THE SOURCES. Heavy water holds itself together hard and lays
       its ink down thick; as the body drains toward mist it stops gripping and
       stops being fed, so the field it already has is what thins out and blows
       away. Both are continuous in material.mass, so there is no frame where
       the body changes density in one step. */
    var heavy = material.mass;
    var hold = TUNE.push * drive.sources * (1 - 0.6 * storm.level) * (1 + 1.5 * seat.moving) * (0.45 + 0.55 * heavy);
    var amount = TUNE.dye * drive.sources * (agent.motion ? 1 : 0.85 + 0.15 * Math.sin(0.43 * t)) * (0.5 + 0.62 * heavy);
    drive.inkAmount = amount; // JELLY BODY: the display pass normalises the fluid trail against the ink the peak settles to
    if (drive.formActive > 0.99 && voice.state !== 'on' && !episode) {
      // Action material is injected in the dye pass around the coasting body.
      // Its local vortex carries the fluid; the idle pointer and wake cannot
      // drag or smear the writing droplets into an unrelated gesture.
      push.fill(0); emit.fill(0); emitAt.fill(-9);
      emitAt[0] = x; emitAt[1] = y;
      emit[0] = amount * TUNE.lightShare; emit[1] = amount * (1 - TUNE.lightShare);
      return;
    }
    if (splitting > 0 && sp.strength >= 0.5) {
      /* TWO BODIES: for the length of a real split the two source slots sit either side of the seat, across the
         heading, each laying down and holding half the water, so the blob visibly comes apart into two and, as the
         offset closes, runs back together. */
      var off = 0.11 * sp.strength * splitting, hx = Math.cos(sp.angle), hy = Math.sin(sp.angle);
      var ax = x + hx * off, ay = y + hy * off, bx = x - hx * off, by = y - hy * off;
      push[0] = ax; push[1] = ay; push[2] = -hx * hold * 0.5; push[3] = -hy * hold * 0.5;
      push[4] = bx; push[5] = by; push[6] = hx * hold * 0.5; push[7] = hy * hold * 0.5;
      emitAt[0] = ax; emitAt[1] = ay; emit[0] = amount * 0.5 * TUNE.lightShare; emit[1] = amount * 0.5 * (1 - TUNE.lightShare);
      emitAt[3] = bx; emitAt[4] = by; emit[4] = amount * 0.5 * TUNE.lightShare; emit[5] = amount * 0.5 * (1 - TUNE.lightShare);
    } else {
      push[0] = x; push[1] = y; push[2] = -sn * hold; push[3] = -cs * hold;
      emitAt[0] = x; emitAt[1] = y; emit[0] = amount * TUNE.lightShare; emit[1] = amount * (1 - TUNE.lightShare);
      /* TRAVEL: while the seat moves, the water is dragged after it -- a wide push from where the blob was toward where
         the seat is going (the second source slot, emitting nothing) -- so the blob moves as a body instead of fading
         here and growing there. The push falloff is widened for the same reason (uPushSharp, in step). */
      emit[4] = emit[5] = 0;
      var wake = smooth(0.04, 0.24, seat.moving);
      if (wake > 0.002) {
        /* The wake follows the SMOOTHED travel direction (seat.tx/ty) and fades in over a range rather than
           switching on at a threshold, so it neither pops nor whips round when the body corners. */
        var dn = Math.sqrt(seat.tx * seat.tx + seat.ty * seat.ty) || 1, ux = seat.tx / dn, uy = seat.ty / dn;
        var drag = 0.7 * wake * drive.sources;
        push[4] = x - ux * 0.06; push[5] = y - uy * 0.06; push[6] = ux * drag; push[7] = uy * drag;
      } else { push[4] = push[5] = -9; push[6] = push[7] = 0; }
      emitAt[3] = emitAt[4] = -9;
    }
    var k = 8, splash = persona.splash && clock - persona.splash.t < 0.6 ? persona.splash : null;
    if (splash) {
      var fade = (1 - (clock - splash.t) / 0.6) * (splash.strength || 9) / 9;
      push[k + 2] = push[k + 3] = 0; push[k] = push[k + 1] = -9;
      emitAt[6] = splash.x; emitAt[7] = splash.y; emit[k] = 2.2 * fade; emit[k + 1] = 1.2 * fade;
    } else if (pointer && pointer.fresh) {
      push[k] = pointer.x; push[k + 1] = pointer.y;
      push[k + 2] = pointer.dx * TUNE.pointer; push[k + 3] = pointer.dy * TUNE.pointer;
      emitAt[6] = pointer.x; emitAt[7] = pointer.y;
      var m = Math.min(1, Math.sqrt(pointer.dx * pointer.dx + pointer.dy * pointer.dy) * 0.6);
      emit[k] = 0.5 * m; emit[k + 1] = 0.3 * m;
      pointer.fresh = false;
    } else {
      push[k + 2] = push[k + 3] = 0; emit[k] = emit[k + 1] = 0; push[k] = push[k + 1] = emitAt[6] = emitAt[7] = -9;
    }
  }

  /* ------------------------------------------------------------ v2 extras: personality, blowup, voice */

  /* home.js names optional idle personality, explicit fluid flourishes and voice.
     The followed action's material transformations remain core on every rung.
     Without data-fluid="on" nothing mounts at all (including Simple mode). */
  var wanted = (visual.getAttribute('data-fluid-extras') || '').split(/\s+/);
  var extras = { personality: wanted.indexOf('personality') >= 0, blowup: wanted.indexOf('blowup') >= 0, voice: wanted.indexOf('voice') >= 0 };
  var extrasOn = extras.personality || extras.blowup || extras.voice;
  var clock = 0, seed = Math.random() * 1000;

  /* The blowup episode. Source: OpenAI, "Finite Time Blowup for Navier–Stokes" (2026), §2 and Figs. 1–2. This is a
     mid-plane (z ≈ 0) visualization of the paper's leading-order mechanism inside this same 2-D Navier–Stokes solve,
     not the proof and not an exact solution. From rest (u = 0) the only inputs are a smooth body force and a
     prescribed in-plane divergence: the core's axial outflow appears in the plane as convergence s < 0 with strain
     α = α0/τ (τ = 1 − t), a stretched, Burgers-type core (Burgers 1948) whose forcing scale shrinks as
     ℓr = L0·√τ (the paper's ℓr ≍ τ^½); a torque ring spins the fluid up and inward transport concentrates it;
     ring pulses (azimuthal wavenumber m, zero angular mean, two families of opposite orientation) are seeded on
     successively smaller radii and shorter times; the solve's own shear winds them finer. The paper's 3-D
     centrifugal/axial-shear amplification is represented by each pulse's envelope. The collapse stops while the
     core is still `cells` grid cells wide: a grid cannot represent a singularity, and this never pretends to. */
  var BLOWUP = {
    /* PROMPT B: the episode runs noticeably quicker. Measured on the running
       page before changing it, so the right thing got sped up: switching the
       followed agent starts THIS episode -- collapse then relax, 8.3 s wall --
       and `animation` below labels an episode 'navier-stokes', so the owner's
       two candidates are one code path and the agent switch is one instance of
       it. The THINKING swirl is not an episode: sampled 25 times across a
       think, episode was null every time, and the runtime suite asserts that
       independently. So this cannot shorten the 30 s swirl, which is the one
       thing it was not allowed to do. 6.5/2.2 -> 3.4/1.1, about half. */
    first: [60, 120], every: [120, 240], collapse: 3.4, relax: 1.1,
    L0: 0.26, cells: 3, strain: 0.28, sinkScale: 1.6, returnR: 0.43, returnW: 0.045,
    torque: 0.32, torqueR: 0.33, torqueW: 0.09, decay: 0.2,
    pulse: 0.05, pulseDye: 0.2, edge: 1.9, width: 0.16, curlGain: 0.12, shade: 0.65
  };
  var episode = null, played = 0, sinceEpisode = 0;
  /* A followed-agent change starts the original episode automatically.
     Explicit idle and voice interactions remain available as well. */
  var nextEpisode = 60 + Math.random() * 60;
  var persona = { eddy: 200, eddyDir: -1, lazyUntil: 0, lazyNext: 45 + Math.random() * 40, splash: null, lean: null, flare: null,
    split: null, turn: null, combo: null, flee: 0, burstNext: 0 };
  var voice = { state: extras.voice ? 'idle' : 'off', level: 0, pitch: 0.5, flourish: null, handback: -99, spoke: -99,
    stream: null, context: null, analyser: null, wave: null, freq: null, recognizer: null, ui: null };

  var drive = {
    ambient: 1, swirl: 1, sources: 1, decay: 1, bodyScale: 1, dyeDecay: 1, original: 0, wisp: 0.08, inkAmount: 1, crowd: 0,
    form: 0, formFrom: 0, formMix: 1, formActive: 0, spin: 0, torque: 0, torqueR: 0.33, torqueW: 0.09,
    pulse: new Float32Array(8), twist: new Float32Array(4), pulseDye: new Float32Array(4),
    pushX: new Float32Array(12), pushXW: new Float32Array(6),
    sinkAt: new Float32Array([.5, .5]), sink: new Float32Array(4), ret: new Float32Array(2), ringDye: new Float32Array(4), vort: new Float32Array(2)
  };

  function noise(t, k) {
    return (Math.sin(t * 0.071 * k + seed) + 0.6 * Math.sin(t * 0.0439 * k + seed * 1.7) + 0.4 * Math.sin(t * 0.0263 * k + seed * 2.3)) / 2;
  }

  function neutral() {
    drive.original = 0; drive.wisp = 0.08;
    drive.bodyScale = drive.dyeDecay = 1;
    drive.ambient = drive.swirl = drive.sources = drive.decay = 1; drive.torque = 0; drive.torqueR = 0.33; drive.torqueW = 0.09;
    drive.pulse.fill(0); drive.pulse[0] = drive.pulse[4] = -1; drive.pulse[1] = drive.pulse[5] = 0.05;
    drive.twist.fill(0); drive.pulseDye.fill(0); drive.pushX.fill(0); drive.pushXW.fill(0);
    for (var i = 0; i < 3; i++) { drive.pushX[i * 4] = drive.pushX[i * 4 + 1] = -9; drive.pushXW[i * 2] = 100; }
    drive.sinkAt[0] = drive.sinkAt[1] = .5;
    drive.sink.fill(0); drive.sink[1] = 0.1; drive.ret[0] = 0.43; drive.ret[1] = 0.05;
    drive.ringDye.fill(0); drive.ringDye[0] = -1; drive.ringDye[1] = 0.05; drive.vort.fill(0);
  }

  function pushX(slot, x, y, fx, fy, sharp, spin) {
    var o = slot * 4, w = slot * 2;
    drive.pushX[o] = x; drive.pushX[o + 1] = y; drive.pushX[o + 2] = fx; drive.pushX[o + 3] = fy;
    drive.pushXW[w] = sharp; drive.pushXW[w + 1] = spin;
  }

  function ringPulse(slot, radius, width, amp, m, twist, phase, light, deep) {
    var o = slot * 4;
    drive.pulse[o] = radius; drive.pulse[o + 1] = width; drive.pulse[o + 2] = amp; drive.pulse[o + 3] = m;
    drive.twist[slot * 2] = twist; drive.twist[slot * 2 + 1] = phase;
    drive.pulseDye[slot * 2] = light; drive.pulseDye[slot * 2 + 1] = deep;
  }

  /* The base character's expression is its eye/body morph and slow breath.
     Idle interaction adds only a small greeting. The original shear/turn and
     shrinking-core forces below belong to thinking and agent transitions. */
  var MOODS = {
    calm:      { eddy: 0.6, light: 0.9,  burstEvery: [6, 12],  pace: 0.03 },
    curious:   { eddy: 1.2, light: 1.05, burstEvery: [4, 8],   pace: 0.055 },
    playful:   { eddy: 1.6, light: 1.15, burstEvery: [2, 5],   pace: 0.085 },
    sleepy:    { eddy: 0.3, light: 0.7,  burstEvery: [14, 26], pace: 0.015 },
    attentive: { eddy: 0.9, light: 1.1,  burstEvery: [4, 9],   pace: 0.05 }
  };
  var mood = { name: 'curious', since: 0, next: 30 + Math.random() * 30, blend: null, quietSince: 0, lastNear: -99 };
  var moment = { wake: -99, finished: -99 };
  /* The cloudy thinking turn carries the fluid around its torque ring. */
  function turn(dir, span, strength) { persona.turn = { t: clock, dir: dir, span: span || 2.4, strength: strength || 0.4 }; }
  function turnDrive(t, dt = 1 / 30) {
    var tn = persona.turn;
    if (!tn || t - tn.t > tn.span) return 0;
    var k = smooth(0, 0.4, t - tn.t) * (1 - smooth(tn.span - 0.8, tn.span, t - tn.t));
    drive.torque += tn.dir * tn.strength * k; drive.torqueR = Math.max(0.22, seat.radius); drive.torqueW = 0.16;
    drive.vort[0] = Math.max(drive.vort[0], 0.45 * k); drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim;
    var tx = -(seat.y - 0.5), ty = seat.x - 0.5, tl = Math.sqrt(tx * tx + ty * ty) || 1;
    seat.vx += tn.dir * tx / tl * 0.12 * k * dt; seat.vy += tn.dir * ty / tl * 0.12 * k * dt;
    return k;
  }
  function pickMood(t) {
    var busy = /^(thinking|reading|writing|running)$/.test(ring.dataset.agentAction || '');
    var quiet = t - Math.max(mood.quietSince, mood.lastNear) > 120;
    var names = busy ? (Math.random() < 0.5 ? ['attentive'] : ['curious', 'attentive', 'playful'])
      : quiet ? ['sleepy', 'calm'] : ['calm', 'curious', 'curious', 'playful', 'playful'];
    var next = names[Math.floor(Math.random() * names.length)];
    if (next === mood.name && names.length > 1) next = names.find(function (name) { return name !== mood.name; }) || next;
    mood.name = next; mood.since = t; mood.next = t + 25 + Math.random() * 45;
  }
  function moodDrive(dt) {
    var t = clock, target = MOODS[mood.name], k = Math.min(1, dt / 2.2);
    if (!mood.blend) mood.blend = { eddy: target.eddy, light: target.light, burstEvery: target.burstEvery.slice(), pace: target.pace };
    if (t > mood.next) { pickMood(t); target = MOODS[mood.name]; }
    if (/^(thinking|reading|writing|running)$/.test(ring.dataset.agentAction || '')) mood.quietSince = t;
    var m = mood.blend;
    m.eddy += (target.eddy - m.eddy) * k; m.light += (target.light - m.light) * k; m.pace += (target.pace - m.pace) * k;
    m.burstEvery[0] += (target.burstEvery[0] - m.burstEvery[0]) * k; m.burstEvery[1] += (target.burstEvery[1] - m.burstEvery[1]) * k;
    return m;
  }
  function personality(dt) {
    // Idle is quiet company: the core eye/body morph supplies its expression.
    // Hovers leave its trajectory alone; a tap gets a small blink.
    moodDrive(dt);
    if (pointer && performance.now() - pointer.t < 1500) mood.lastNear = clock;
    var age = clock - (persona.greetAt ?? -99);
    if (age >= 0 && age < .3) {
      var blink = smooth(0, .08, age) * (1 - smooth(.12, .3, age));
      agent.character[1] = Math.max(agent.character[1], blink * (1 - agent.character[0]));
    }
  }

  // Actions have their own stable phase. Source size, light and position
  // remain available on every quality rung, independent of visual extras.
  var agent = { action: '', since: -9, name: '', key: '', lastKey: '', event: '', kick: -9, kicks: 0, motion: null, previous: null, formTime: 0,
    character: new Float32Array([0, 0, 1, 0]), parts: createBlobParts(), rest: createActionRest() };
  function burst(strength, radius) {
    var at = arcPoint(radius || seat.radius);
    persona.splash = { x: at.x + (Math.random() - 0.5) * 0.06, y: at.y + (Math.random() - 0.5) * 0.06, t: clock, strength: strength };
    persona.flare = { t: clock, strength: strength / 9 };
  }
  /* SPLIT: a shear across the seat -- two wide pushes either side of the blob, driven opposite ways -- tears it into
     two bodies that drift apart while the hold is loosened, and the hold gathers them back into one when it ends.
     `turn` gives the pair a rotation too (both pushes the same way round the seat), so a split can also be a twirl,
     right or left. */
  function split(strength, span, turn) {
    var heading = Math.atan2(seat.vy, seat.vx);
    persona.split = { t: clock, strength: strength, span: span || 1.4, turn: turn || 0, angle: heading + Math.PI / 2 };
  }
  function splitDrive(t) {
    var sp = persona.split;
    if (!sp || t - sp.t > sp.span) return 0;
    var k = Math.sin(Math.PI * Math.min(1, (t - sp.t) / sp.span)), a = seat.deg * Math.PI / 180;
    var cx = 0.5 + seat.radius * Math.sin(a), cy = 0.5 + seat.radius * Math.cos(a), px = Math.cos(a), py = -Math.sin(a);
    var f = 0.18 * sp.strength * k, tw = 2.4 * sp.turn * k;
    pushX(1, cx + 0.05 * px, cy + 0.05 * py, px * f - py * tw * 0.04, py * f + px * tw * 0.04, 140, tw);
    pushX(2, cx - 0.05 * px, cy - 0.05 * py, -px * f + py * tw * 0.04, -py * f - px * tw * 0.04, 140, tw);
    return k;
  }
  function arcPoint(radius) {
    var a = seat.deg * Math.PI / 180;
    return { x: 0.5 + radius * Math.sin(a), y: 0.5 + radius * Math.cos(a) };
  }
  function originalFluid(weight) {
    drive.original = weight;
    drive.formFrom = 0; drive.form = agent.motion?.form || 0;
    /* THE FORM MAY NOT LEAVE BEFORE THE MIST ARRIVES. The solid body is drawn
       from the form's own analytic field, and a form of 0 is FORM_FAR
       everywhere (src/home-circle-forms.js: `if (kind < 0.5) return 0.0`), so
       dissolving it is INSTANT -- one frame and the silhouette is gone. What
       replaces it is DYE, and the display only reads the dye once the water
       has actually thinned (mistW = smoothstep(0.45, 0.9, 1 - material.mass))
       and only after the solve has had frames to spread it. Driven from the
       raw weight, those are two different clocks and the gap between them is a
       window in which NOTHING IS DRAWN: measured on a page that boots on a
       thinking agent and is never focused, where the loop is granted a single
       frame after the boot burst -- formMix 0 with mass still 0.91, so no
       silhouette, no mist, an empty disc frozen on screen (a brim and a hole).
       So the dissolve rides the SAME scalar the mist arrives on and can never
       run ahead of it: the form goes only as far as the water has drained. */
    var gone = Math.min(weight, 1 - material.mass);
    drive.formMix = 1 - gone; drive.formActive = drive.form ? 1 - gone : 0;
    drive.partsMix *= 1 - gone; drive.flow = 0;
    drive.dyeDecay += (1 - drive.dyeDecay) * weight;
    /* NOT drive.sources, WHICH IS THE INK THE MIST IS MADE OF. This line read
       `drive.sources += (1 - drive.sources) * weight` and was the whole of the
       collapsed cloud. Every form declares how much ink it lays down
       (src/home-circle-motion.js `light`), and the thinking swirl declares 4.5
       -- four and a half times the resting body -- for the one reason that
       once the form has dissolved the ink is the ONLY thing left to draw. The
       ramp threw that away and handed the mist the neutral fluid's 1 at
       exactly the moment it became the whole character: measured live, the
       emitted dye was 0.95/s while thinking against 4.87/s while idle, five
       times less ink for the state that needs it most, and the cloud read as a
       grey haze. Measured with this line removed and nothing else changed
       (black, seat held at the centre, 18 s settled): the face above a fixed
       ink level went 7.8% -> 26.8% and the presence gate's own coverage went
       2.4% -> 6.5%, with the solid body unchanged.
       The forces ARE returned to the original fluid, which is what this
       function is for; the dye budget belongs to the form, because it is the
       form's remains. The blowup episode is unaffected: blowup() assigns
       drive.sources itself on the very next line of direct(). */
    drive.decay += (1 - drive.decay) * weight;
    // The original fluid IS the whispy form: as it takes over, the body's
    // weight goes with it.
    drive.wisp += (1 - drive.wisp) * weight;
  }
  function agentDrive(dt) {
    var action = ring.dataset.agentAction || 'idle', name = ring.dataset.agentName || '', event = ring.dataset.agentEvent || '';
    var key = ring.dataset.agentKey || name, switched = !!(key && agent.lastKey && key !== agent.lastKey);
    var resting = updateActionRest(agent.rest, clock, /^(thinking|reading|writing|running)$/.test(action) && voice.state !== 'on');
    var displayAction = resting ? 'idle' : action;
    var tool = ring.dataset.agentTool || '', wanted = actionMotion(displayAction, clock - agent.since, tool);
    if (action !== agent.action || key !== agent.key || displayAction !== agent.displayAction || wanted?.form !== agent.motion?.form) {
      agent.previous = agent.motion;
      agent.action = action; agent.name = name; agent.since = clock; agent.event = event;
      agent.kick = -9; agent.stormCycle = -1;
      persona.combo = persona.turn = persona.split = persona.splash = persona.flare = persona.lean = null;
      seat.trampoline = seat.rebound = seat.goal = seat.squash = null;
      /* JELLY BODY: a new form SETS with one overshoot -- a small upward kick the spring rings down from. */
      seat.jigV = (seat.jigV || 0) + TUNE.jelly.jiggle.kick * 0.55; seat.jigAxis = -1;
      // A stream can change from thinking to tools during the transition.
      // Keep that same transition; a new agent choice replaces it promptly.
      if (resting || switched || episode?.reason !== 'agent-change') episode = null;
      if (switched && !resting) startEpisode('agent-change');
    }
    agent.name = name; agent.key = key; agent.displayAction = displayAction;
    if (key) agent.lastKey = key;
    if (event !== agent.event) { agent.event = event; agent.kick = clock; agent.kicks++; }
    if (resting) agent.kick = -9;
    agent.motion = actionMotion(displayAction, clock - agent.since, tool);
    var blend = smooth(0, 0.8, clock - agent.since), from = agent.previous, to = agent.motion;
    drive.formFrom = from ? from.form : 0; drive.form = to ? to.form : 0; drive.formMix = blend;
    drive.formActive = (drive.formFrom ? 1 : 0) * (1 - blend) + (drive.form ? 1 : 0) * blend;
    drive.spin = (from ? from.spin : 0) * (1 - blend) + (to ? to.spin : 0) * blend;
    drive.bodyScale = (from ? from.size : 1) * (1 - blend) + (to ? to.size : 1) * blend;
    drive.sources = (from ? from.light : 1) * (1 - blend) + (to ? to.light : 1) * blend;
    drive.dyeDecay = (from ? from.decay : 1) * (1 - blend) + (to ? to.decay : 1) * blend;
    drive.flow = (from?.flow ?? 0) * (1 - blend) + (to?.flow ?? 0) * blend;
    drive.transport = (from?.transport ?? 2.5) * (1 - blend) + (to?.transport ?? 2.5) * blend;
    drive.wisp = (from?.wisp ?? 0.08) * (1 - blend) + (to?.wisp ?? 0.08) * blend;
    agent.formTime += dt * (to?.tempo ?? 1);
    updateBaseCharacter(agent.character, agent.formTime);
    updateBlobParts(agent.parts, to, clock - agent.since, dt);
    drive.partsMix = ((from?.form === 1 || from?.form === 4) ? 1 - blend : 0) + ((to?.form === 1 || to?.form === 4) ? blend : 0);
    if (!drive.partsMix && blend === 1) agent.parts.form = 0;
    if (voice.state === 'on') { drive.form = drive.formFrom = drive.formActive = drive.flow = drive.partsMix = 0; return; }
    if (episode) { originalFluid(1); return; }
    if (!to) return;
    drive.decay = to.drag || 1.3;
    if (to.form === 1) squashDrive(clock);
    if (to.form === 1) {
      /* The draw-in, on its own slow beat, under the storm above. Set before
         the cycle block so turnDrive's torque ring still wins while it runs.
         DELIBERATELY NOT RECOVERED with it: the original also walked
         `seat.goal` around a small circle ("circling on the spot"). That
         moves the body rather than transforming it, and the owner ruled it
         out -- "dont animate it just by moving it around make it transform
         and act and be change". The draw-in is the transformation; the
         circling was the translation. */
      /* THE DRAW-IN AND THE PULSE, and the pulse is the part that was missing.
         `surge` is the motion's own beat (see THINK in
         src/home-circle-motion.js): the cloud is pushed out at the top of a
         beat, then gathers and slows towards the end of it. The owner asked
         for exactly this shape -- "it can get really slow... then pulse
         again" -- and an eighteen-second swirl with one kick at the top had no
         `again` in it, which is why it read as short however long it ran.
         The draw-in rides the beat rather than a free-running sine, so the
         gathering and the pulse are the same rhythm instead of two.
         DELIBERATELY NOT RECOVERED with it: the original also walked
         `seat.goal` around a small circle ("circling on the spot"). That
         moves the body rather than transforming it, and the owner ruled it
         out -- "dont animate it just by moving it around make it transform
         and act and be change". The draw-in is the transformation; the
         circling was the translation. */
      var surge = to.surge ?? (0.5 + 0.5 * Math.sin(clock * 2 * Math.PI / 3.4));
      gather(0.055 * blend * (0.25 + 0.75 * (1 - surge)), 0.3);
      drive.torque += 0.07 * blend * Math.sin(clock * 2 * Math.PI / 4.8);
      drive.torqueR = seat.radius; drive.torqueW = 0.12;
      // Once per BEAT, not once per swirl: the original cloudy kick -- source
      // burst, opposed shear, then a torque ring -- is what pulses again.
      var mark = to.beat ?? to.cycle;
      if (mark !== agent.stormCycle) {
        agent.stormCycle = mark;
        burst(9, seat.radius); agent.kick = clock;
        split(1.2, 1.3, 0); turn(mark % 2 ? -1 : 1, 1.8, .5);
      }
      if (to.original > 0) {
        /* THE BOOT FRAME OF A THINKING AGENT. The swirl dissolves the form into
           the original fluid (formMix runs to 0), and the mist that replaces
           it needs frames to develop; inside the boot burst there are none, so
           the frozen frame held nothing but the brim (measured: 5316 px, the
           ring alone). During the burst the form is not dissolved, so the
           thinking shape is what is frozen; the swirl takes over when frames
           flow, exactly as before. */
        originalFluid(typeof booting !== 'undefined' && booting ? 0 : to.original);
        splitDrive(clock); turnDrive(clock, dt);
        // The curl light rises with the pulse, so the storm brightens as it
        // spins up and settles as it slows.
        drive.vort[0] = Math.max(drive.vort[0], (.12 + .3 * surge) * to.original);
        drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim;
      }
    }
    drive.sources *= 1 + .12 * (1 - smooth(0, .35, clock - agent.kick));
  }

  /* Fluid mobility: ordinary action shapes stay cohesive; optional physical
     flourishes can thin the material and raise vorticity. This changes the
     simulation only, never the matte display material. */
  var storm = { level: 0 };
  function stormDrive(dt) {
    if (agent.motion && agent.action !== 'idle' && voice.state !== 'on' && !episode) {
      storm.level += (agent.motion.storm - storm.level) * (1 - Math.exp(-5 * dt));
      return;
    }
    var t = clock, action = extrasOn ? (ring.dataset.agentAction || 'idle') : 'idle';
    var base = action === 'running' ? 0.45 : action === 'writing' ? 0.35 : action === 'reading' ? 0.2 : action === 'thinking' ? 0.1 : 0;
    var kick = extrasOn ? 1 - smooth(0, 0.8, t - agent.kick) : 0;
    var fl = persona.flare ? 1 - smooth(0, 0.9, t - persona.flare.t) : 0;
    var tn = persona.turn, turning = tn && t - tn.t < tn.span ? 1 : 0, sp = persona.split, splitting = sp && t - sp.t < sp.span ? 1 : 0;
    /* Ordinary wandering is not weather: only a dart (a fast seat) counts, so the water is a blob between gestures. */
    var v = Math.sqrt(seat.vx * seat.vx + seat.vy * seat.vy), dart = Math.max(0, Math.min(1, (v - 0.13) / 0.15));
    var target = Math.max(base, (action === 'running' ? 0.95 : 0.6) * kick, 0.3 * fl, 0.5 * dart, 0.7 * turning, 0.4 * splitting, episode ? (episode.phase === 'collapse' ? 1 : 0.5) : 0, voice.state === 'on' ? 0.5 : 0);
    target = Math.max(target, 0.12); // a trace of mist at rest, so the water is never a solid paint
    storm.level += (target - storm.level) * Math.min(1, dt / (target > storm.level ? 0.8 : 2.4));
  }

  /* HOW MUCH THE WATER WEIGHS, 1 = heavy water with a defined edge, 0 = mist.
     The owner's complaint was that the body reads at one of two densities and
     snaps between them. It does not any more: every form declares a `wisp`
     (src/home-circle-motion.js), agentDrive blends it across the morph exactly
     like the other material properties, the eye pair is lighter than the single
     body it closes into, and this filter then DRAINS toward it rather than
     jumping -- slower to gather weight back than to let it go, which is what
     reads as mass.
     What the number is spent on is the solve, not the paint: how long the
     water holds its dye, how draggy it is, how hard the body pulls itself
     together, how much it curls. Only the edge width and the thin-fluid
     crossover are display, and those follow the solve rather than standing in
     for it. */
  var material = { mass: 1, landed: true };
  var booting = false; // true only inside the boot burst: the material stays solid there
  var MATERIAL = {
    /* T365: "liquid to solid SETS with one overshoot", 350-600 ms per change.
       These were 1.35 and 2.1 s, written for water that had to be seen to
       drain; with the solid body analytic, a 2.1 s gather put the settle into
       solid at 2.6-2.9 s on the motion gate, which is sluggish on screen.
       Shorter both ways, and still slower to gather than to thin, which is
       what reads as mass and what the runtime suite holds. */
    /* 0.8/1.3 were the floors the runtime suite USED to impose: a 25-frame
       count through the middle of the drain's range, and a gather-to-half
       compared against the thinking drain WITH the swirl's 0.4 s ramp counted
       on one side only. Both were the old water substrate's numbers and both
       were replaced on 2026-09-18 -- the count became a continuity bound (the
       body must not teleport, at any speed) and the comparison now starts the
       two on equal terms. Verified by driving the exported checks with values,
       not by reading them: assertWeightContinuous accepts 0.35 and 0.80 and
       rejects a one-frame 1->0 teleport; assertDrainQuickerThanGather accepts
       0.35 behind the ramp against 0.45 and rejects a gather quicker than the
       drain. So these are now chosen for how the character READS, and the
       reason to keep them short is that the owner sees a state change every
       time an agent does anything: at 0.8/1.3 the body was back 1.62 s after
       the switch, which is sluggish. */
    /* THESE TWO ARE NOT FREE, AND THE REASON IS A CONFLICT BETWEEN TWO OF
       THIS LANE'S OWN CHECKS. Shortening them to 0.18 / 0.22 does land the
       motion gate's T6 inside the 350-600 ms this block declares (measured:
       mist->solid 935 ms -> 599 ms) -- and it turns the suite's
       `assertDrainQuickerThanGather` RED, because that check times the drain
       on a `thinking` mount whose target itself ramps for 0.8 s and the gather
       on an `idle` mount stepped straight to zero, so the drain is charged
       about 4 extra frames of ramp the gather never pays. With both constants
       short the gather wins on frames (drain 8, gather 4) and the check fails.
       The arithmetic of the squeeze: the continuity check forbids a step over
       a fifth of the range, so the drain cannot go below about 0.15 s; that
       still measures ~7 frames to half through the ramp; so the gather has to
       be slower than 0.34 s to stay behind it; and a 0.34 s gather cannot
       settle inside 600 ms. T6's band and that check cannot both be met while
       the drain is timed through a ramp the gather does not have.
       So these stay where the body lane set them, the gate keeps its honest
       red, and the bounce is fixed WITHOUT them -- see the arrival kick in
       materialDrive, which waits for the weight to stop changing rather than
       for the clock. Reported to the gate lane rather than settled here. */
    drain: 0.42,  // seconds for the body to let its weight go
    gather: 0.95  // and longer to take it back, which is what reads as mass; both were 1.35 and 2.1 originally, then 0.8 and 1.3
  };
  function materialDrive(dt) {
    var want = 1 - Math.max(0, Math.min(1, drive.wisp));
    // The joined single blob is the heaviest thing the character becomes; the
    // pair is the same water divided, so it carries a little less.
    if (drive.form === 2 || drive.formFrom === 2) want *= 0.9 + 0.1 * agent.character[0];
    if (episode) want = Math.min(want, 0.08);
    /* TRANSPORT (owner, 2026-09-19 late): the blob does not slide as a solid.
       Whenever the seat travels fast enough to be a journey (a dart, a chase,
       a bounce; not the idle drift), the body lets its weight go into the
       water, the water carries it, and on arrival the gather below brings
       it back -- the appearing animation in reverse. Same drain and gather
       the episodes already use; this just fires them for every journey. */
    if (seat.moving > 0.55) want = Math.min(want, 0.12 + 0.3 * (1 - seat.moving));
    if (voice.state === 'on') want = Math.min(want, 0.45);
    if (typeof booting !== 'undefined' && booting) want = 1;
    want = Math.max(0, Math.min(1, want));
    var tau = want < material.mass ? MATERIAL.drain : MATERIAL.gather;
    material.mass += (want - material.mass) * (1 - Math.exp(-Math.max(0, dt) / tau));
    /* THE BODY CANNOT BOUNCE BEFORE IT EXISTS, and that is why the motion gate
       reads one crossing of rest where two are needed. The spring is already
       here (seat.jig, updateSeatReadings) and it is already kicked on a change
       of form -- but that kick lands at the INSTANT the action changes, when
       the body is still the mist it is leaving. At 4.6 Hz and damping 0.16 the
       ring decays with a time constant of 0.22 s, and MATERIAL.gather takes
       0.70 s to bring the material back, so by the time there is a solid
       silhouette to measure the kick is down to about 4% of itself. The
       silhouette then only falls to its rest width and stops: one crossing.

       So the material kicks the spring AGAIN when it ARRIVES. A body that has
       just finished re-forming wobbles; that is the whole of "sets with one
       overshoot". `solid` here is the display shader's own state scalar read
       from the same mass, so the kick cannot fire while the body is still a
       cloud, and the latch clears only when the body has genuinely drained
       again (below half) so a body sitting at rest cannot be kicked twice. */
    var solidNow = 1 - smooth(0.05, 0.5, 1 - material.mass);
    var jg = TUNE.jelly.jiggle;
    /* WAIT FOR THE WEIGHT TO STOP CHANGING, not for a clock and not for a
       level alone. The gather is an asymptote (MATERIAL.gather), so a body
       that has crossed any fixed level of `solid` is still quietly growing
       underneath the ring -- measured, the silhouette rang 22 -> 19 -> 26 ->
       21 -> 24 px and then went on climbing to a rest of 27, so every swing
       sat BELOW the rest the gate reads from the tail and counted as ONE
       crossing where there were four. Firing when the weight is within
       `landSlack` of where it is going puts the ring on a body that has
       arrived, and it does that whatever the gather constant is, which is why
       the bounce no longer depends on timing this file should not be moving
       (see MATERIAL above). */
    if (!material.landed && solidNow >= jg.landAt && want - material.mass <= jg.landSlack) {
      material.landed = true;
      seat.jigV = (seat.jigV || 0) + jg.kick * jg.land; seat.jigAxis = -1;
    } else if (material.landed && solidNow < 0.5) material.landed = false;
  }

  function blowupAllowed() { return extrasOn && extras.blowup && !dead; }

  function startEpisode(reason) {
    if ((reason === 'agent-change' ? dead || voice.state === 'on' : !blowupAllowed()) || episode || !T) return false;
    episode = { t: 0, reason: reason, rest: true };
    played++; sinceEpisode = 0;
    return true;
  }

  /* The episode's body force and prescribed divergence at the current step (see BLOWUP above). */
  function blowup(dt) {
    var b = BLOWUP, ep = episode, h = 1 / LADDER[level].sim;
    /* An agent switch has to READ as a transition. Owner: "the navier stokes i
       dont really see it". The ambient episode stays subtle; the one that
       marks a change of agent gets a stronger dye pulse and a brighter curl. */
    var gain = ep.reason === 'agent-change' ? 2.1 : 1;
    ep.t += dt;
    var tauStop = Math.min(0.5, Math.pow(b.cells * h / b.L0, 2)), x = Math.min(ep.t / b.collapse, 1), tau = 1 - (1 - tauStop) * x;
    var on = smooth(0, 0.4, ep.t) * (1 - smooth(b.collapse, b.collapse + 0.3, ep.t));
    var back = smooth(b.collapse, b.collapse + b.relax, ep.t);
    ep.tau = tau; ep.phase = ep.t < b.collapse ? 'collapse' : 'relax';
    drive.ambient = 1 - smooth(0, 0.4, ep.t) + back;
    drive.sources = 0.4 + 0.6 * back;
    drive.decay = (b.decay + (TUNE.velocityDecay - b.decay) * back) / TUNE.velocityDecay;
    var core = b.L0 * Math.sqrt(tau), reach = b.sinkScale * core, alpha = b.strain / tau * on;
    var inSink = Math.PI * reach * reach * (1 - Math.exp(-Math.pow(0.49 / reach, 2)));
    var inReturn = 2 * Math.PI * b.returnR * b.returnW * Math.sqrt(Math.PI);
    drive.sink[0] = alpha; drive.sink[1] = reach; drive.sink[2] = alpha * inSink / inReturn; drive.sink[3] = h;
    drive.ret[0] = b.returnR; drive.ret[1] = b.returnW;
    drive.torque = b.torque * on * smooth(0, 0.25, x) * (1 - 0.6 * smooth(0.3, 0.7, x));
    drive.torqueR = b.torqueR; drive.torqueW = b.torqueW;
    var slot = 0;
    for (var k = 0, tk = 0.78; k < 12 && slot < 2 && tk * 0.35 > tauStop * 0.5; k++, tk *= 0.5) {
      if (tau > tk || tau < 0.35 * tk || on <= 0) continue;
      var u = (tk - tau) / (0.65 * tk), env = Math.pow(Math.sin(Math.PI * u), 2), scale = b.L0 * Math.sqrt(tk), fam = k % 2;
      var width = b.width * scale, amp = b.pulse * env * width / Math.sqrt(tk);
      ringPulse(slot++, b.edge * scale, width, amp, fam ? 13 : 8, fam ? -2.6 : 2.6, 1.3 / Math.sqrt(tk) * ep.t,
        fam ? 0 : b.pulseDye * env * gain, fam ? b.pulseDye * env * gain : 0);
    }
    drive.vort[0] = Math.min(1, b.shade * gain) * smooth(0, 0.8, ep.t) * (1 - back); drive.vort[1] = b.curlGain * LADDER[level].sim;
    /* Rescheduling the next one is what makes this "recover and repeat"
       rather than play once. Dropping it left nextEpisode assigned and never
       read again, and sinceEpisode assigned and never incremented -- two dead
       variables that were the whole automatic cycle. Recovered from 21506c72. */
    if (ep.t >= b.collapse + b.relax) {
      episode = null;
      nextEpisode = BLOWUP.every[0] + Math.random() * (BLOWUP.every[1] - BLOWUP.every[0]);
    }
  }

  /* Voice mode, driven by the Home voice widget. The widget owns the microphone (voice-coordinator.js; the shell admits
     media only to a session that widget started, shell/voice-permissions.cjs), so voice stays opt-in behind its Start
     voice, and its End voice releases the microphone. The circle opens nothing and records nothing: each step it reads
     the widget's state (ring.dataset.voice), its on-screen level and the words it recognized (voice-signal.js). Its own
     repertoire, all body forcing: connecting/listening gathers an attentive ring near the rim; the visitor speaking
     makes ripples that follow the level; the agent answering (state "speaking") breathes in a rhythm unlike ambient;
     muted dims the ring; each recognized command has a flourish; leaving voice hands back smoothly. */
  var FLOURISH = { spin: 2.4, calm: 3.2, faster: 3, hello: 1.8, stop: 2.2 };
  var heardSeq = voiceSignal.heardSeq;

  function listen() {
    var mode = ring.dataset.voice || 'off', was = voice.state;
    var active = mode === 'connecting' || mode === 'listening' || mode === 'muted' || mode === 'speaking';
    voice.mode = mode;
    if (active && was !== 'on') { voice.state = 'on'; voice.since = clock; voice.heard = ''; }
    else if (!active && was === 'on') { voice.state = 'idle'; voice.handback = clock; voice.flourish = null; }
    voice.level += ((active ? voiceSignal.level : 0) - voice.level) * 0.35;
    if (active && mode === 'listening' && voice.level > 0.06) voice.spoke = clock;
    if (voiceSignal.heardSeq !== heardSeq) { heardSeq = voiceSignal.heardSeq; if (active) command(voiceSignal.heard); }
  }

  function voiceDrive() {
    var t = clock, f = voice.flourish, on = voice.state === 'on';
    var w = on ? smooth(voice.since, voice.since + 1, t) : 1 - smooth(voice.handback, voice.handback + 1.5, t);
    if (w <= 0) return;
    var mode = voice.mode, muted = mode === 'muted', answering = on && mode === 'speaking';
    var hearing = on && mode === 'listening' && t - voice.spoke < 0.6, loud = Math.min(1, voice.level * 3);
    drive.ambient *= 1 - 0.7 * w; drive.sources *= 1 - 0.7 * w;
    var strength = (muted ? 0.4 : 1) * (hearing ? 0.5 : 1);
    drive.ringDye[0] = 0.445; drive.ringDye[1] = 0.02; drive.ringDye[2] = 0.35 * w * strength; drive.ringDye[3] = 0.15 * w * strength;
    drive.torque += 0.12 * w * (muted ? 0.5 : 1); drive.torqueR = 0.44; drive.torqueW = 0.03;
    if (answering) {
      var beat = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 1.1);
      drive.ringDye[2] = 0.14 * w * (0.4 + beat); drive.ringDye[3] = 0.36 * w * (0.4 + beat);
      drive.torque += 0.1 * w * (beat - 0.5);
      ringPulse(0, 0.4, 0.035, 0.008 * (0.5 + loud) * w * beat, 4, 0, -1.5 * t, 0, 0.8 * beat * w);
    } else if (hearing) {
      ringPulse(0, 0.41, 0.03, 0.016 * loud * w, 7, 2.2, 3 * t, 1.2 * loud, 0.2 * loud);
      drive.vort[0] = Math.max(drive.vort[0], 0.35 * loud * w); drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim;
    }
    if (!f) return;
    var age = t - f.t, span = FLOURISH[f.name] || 2, k = smooth(0, 0.3, age) * (1 - smooth(span - 0.6, span, age));
    if (age > span) { voice.flourish = null; return; }
    if (f.name === 'spin') { drive.torque += 0.55 * k; drive.torqueR = 0.3; drive.torqueW = 0.1; drive.vort[0] = Math.max(drive.vort[0], 0.6 * k); drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim; }
    else if (f.name === 'calm') { drive.decay *= 1 + 2.5 * k; drive.torque -= 0.08 * k; drive.sink[0] = 0.15 * k; drive.sink[1] = 0.2; drive.sink[2] = 0.15 * k * 0.7; drive.sink[3] = 1 / LADDER[level].sim; drive.ret[0] = 0.43; drive.ret[1] = 0.045; }
    else if (f.name === 'faster') { drive.swirl *= 1 + 1.6 * k; drive.ambient = Math.max(drive.ambient, k); drive.sources *= 1 + 0.5 * k; }
    else if (f.name === 'hello') {
      for (var i = 0; i < 2; i++) {
        var a = age - i * 0.55, e = a > 0 && a < 0.9 ? Math.pow(Math.sin(Math.PI * a / 0.9), 2) : 0;
        ringPulse(i, 0.36, 0.04, 0.02 * e, 3, 0, 2 * a, 1.1 * e, 0.4 * e);
      }
    } else if (f.name === 'stop') { drive.decay *= 1 + 5 * k; drive.ambient *= 1 - 0.8 * k; drive.torque *= 1 - k; }
  }

  function command(text) {
    var t = String(text || '').toLowerCase();
    var name = /blow ?up/.test(t) ? 'blowup' : /\bcalm\b/.test(t) ? 'calm' : /\bfaster\b/.test(t) ? 'faster'
      : /\bspin\b/.test(t) ? 'spin' : /\b(hello|hi|hey)\b/.test(t) ? 'hello' : /\bstop\b/.test(t) ? 'stop' : null;
    if (!name || voice.state !== 'on') return;
    voice.heard = name;
    if (name === 'blowup') startEpisode('voice');
    else voice.flourish = { name: name, t: clock };
  }

  /* The circle holds no microphone; "off" only ends its voice-mode look. */
  function voiceOff(why) {
    if (voice.state === 'on') voice.handback = clock;
    voice.state = extras.voice ? 'idle' : 'off'; voice.flourish = null; voice.released = why || 'off';
  }
  function hideVoice() {}

  function dropExtras(why) {
    if (!extrasOn) return;
    extrasOn = false;
    if (episode?.reason !== 'agent-change') episode = null;
    voiceOff('ladder');
    hideVoice();
    visual.setAttribute('data-fluid-extras-off', why);
  }

  function uvOf(event) {
    var r = (canvas || ring).getBoundingClientRect();
    if (!r.width) return null;
    var x = (event.clientX - r.left) / r.width, y = 1 - (event.clientY - r.top) / r.height;
    return (x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5) < 0.22 ? { x: x, y: y } : null;
  }

  function tap(event) {
    if (!extrasOn || !extras.personality || (ring.dataset.agentAction || 'idle') !== 'idle') return;
    var at = uvOf(event);
    if (!at) return;
    if (episode) return;
    // A soft squeeze and a blink acknowledge a tap without a startled flight.
    persona.greetAt = clock;
    seat.squash = { t: clock, x: seat.x, y: seat.y, nx: 0, ny: 1, hit: .04, span: .7, depth: .14 };
  }

  function doubleTap(event) {
    if (!extrasOn || (ring.dataset.agentAction || 'idle') !== 'idle' || !uvOf(event) || !(window.matchMedia && window.matchMedia('(pointer: fine)').matches)) return;
    startEpisode('double-click');
  }

  function direct(dt) {
    neutral();
    // Action identity is core behavior and survives the performance ladder.
    agentDrive(dt);
    if (extrasOn && extras.personality && (!agent.motion || agent.displayAction === 'idle') && voice.state !== 'on' && !episode) personality(dt);
    if (voice.state === 'on' || clock - voice.handback < 1.5) voiceDrive();
    /* THE ORIGINAL SHRINKING-CORE EPISODE, PLAYING ON ITS OWN AGAIN.
       Recovered from 21506c72, where the removed comment read "thinking plays
       the original shrinking-core episode", and the deleted test alongside it
       read "thinking automatically runs the original shrinking core, torque
       and ring pulses, then recovers and repeats". The owner asked for this:
       "navier stokes could be really good for the thinking one, like it can
       get really slow... then pulse again" -- the ring pulses ARE the "pulse
       again", and `animation` below already names this episode navier-stokes.
       On its own it only plays over an idle circle. It still plays on a
       double-click, on the voice word, and as the transition when the followed
       agent changes -- all of those have a reason behind them. */
    if (extras.blowup && !episode && voice.state !== 'on') {
      sinceEpisode += dt;
      if (sinceEpisode >= nextEpisode && (ring.dataset.agentAction || 'idle') === 'idle') startEpisode('auto');
    }
    if (episode) {
      originalFluid(1);
      blowup(dt);
      if (episode) {
        // The original relaxation feeds smoothly back into the new body.
        if (episode.phase === 'relax') originalFluid(1 - smooth(BLOWUP.collapse, BLOWUP.collapse + BLOWUP.relax, episode.t));
      }
    }
    var animation = episode ? 'navier-stokes' : agent.motion?.pattern || 'ambient';
    if (agent.animation !== animation) { agent.animation = animation; visual.setAttribute('data-action-motion', animation); }
  }


  /* ------------------------------------------------------------ one step */

  function clearPair(t) {
    for (var i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, (i ? t.write : t.read).fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  function step(dt, time) {
    var q = LADDER[level], u;
    if (paletteDirty) readPalette();
    clock += dt;
    if (extrasOn && extras.voice) listen();
    direct(dt);
    /* crowding: the caption's share of the canvas, from the box measureQuiet keeps */
    drive.crowd = Math.max(0, Math.min(1, (quiet[0] * quiet[1] - TUNE.jelly.crowd.from) / (TUNE.jelly.crowd.to - TUNE.jelly.crowd.from)));
    drive.bodyScale *= 1 - TUNE.jelly.crowd.shrink * drive.crowd;
    stormDrive(dt);
    materialDrive(dt);
    /* The episode starts from rest, as the paper's flow does: u(·, 0) = 0. */
    if (episode && episode.rest) { clearPair(T.velocity); clearPair(T.pressure); episode.rest = false; }
    seatDrive(dt);
    quietTick();
    plan(time);
    gl.disable(gl.BLEND);

    u = use(P.curl, T.curl);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    draw(T.curl);

    u = use(P.forces, T.velocity.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uCurl, bind(1, T.curl));
    gl.uniform1f(u.uDt, dt);
    // Mist curls; heavy water does not have the freedom to.
    gl.uniform1f(u.uCurlStrength, TUNE.curl * (1 + 2.2 * storm.level) * (1 + 0.45 * (1 - material.mass))); // owner: thinking 'could be more aggressive' -- the storm tightens its eddies harder
    gl.uniform1f(u.uSwirl, (TUNE.swirl + 0.03 * storm.level) * drive.swirl);
    gl.uniform4fv(u.uPush, push);
    gl.uniform1f(u.uPushSharp, TUNE.pushSharp * (1 - 0.7 * Math.min(1, seat.moving)));
    gl.uniform2f(u.uBodyAt, seat.x, seat.y);
    gl.uniform4f(u.uBodyFlow, seat.vx, seat.vy, drive.spin, drive.formActive);
    gl.uniform4f(u.uFluidMotion, agent.formTime, drive.flow, drive.transport, agent.motion?.release || 0);
    gl.uniform4fv(u.uParts, agent.parts.pose); gl.uniform2fv(u.uPartVelocity, agent.parts.velocity);
    gl.uniform1fv(u.uPartSpin, agent.parts.spin);
    gl.uniform2f(u.uPartForce, drive.bodyScale, drive.partsMix);
    {
      // The tool bands' own shear. Sigma is widened past the drawn band so the
      // water on both shoulders of it is turned too, rather than a hard sleeve.
      var ring = agent.parts.ring, ringOn = drive.form === 4 || drive.formFrom === 4 ? drive.partsMix * agent.parts.turn[3] : 0;
      gl.uniform4f(u.uToolFlow, ring[0], ring[1], Math.max(ring[2], ring[3]) * 2.4 + 0.012, ringOn);
      gl.uniform2fv(u.uToolSpin, agent.parts.ringSpin);
    }
    {
      gl.uniform4f(u.uEpi, drive.ambient, drive.torque, drive.torqueR, drive.torqueW);
      gl.uniform4fv(u.uPulse, drive.pulse); gl.uniform2fv(u.uTwist, drive.twist);
      gl.uniform4fv(u.uPushX, drive.pushX); gl.uniform2fv(u.uPushXW, drive.pushXW);
    }
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(P.divergence, T.divergence);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    { gl.uniform4fv(u.uSink, drive.sink); gl.uniform2fv(u.uReturn, drive.ret); gl.uniform2fv(u.uSinkAt, drive.sinkAt); }
    draw(T.divergence);

    u = use(P.scale, T.pressure.write);
    gl.uniform1i(u.uSource, bind(0, T.pressure.read));
    gl.uniform1f(u.uValue, TUNE.pressureKeep);
    draw(T.pressure.write);
    T.pressure.swap();

    u = use(P.jacobi, T.pressure.write);
    gl.uniform1i(u.uDivergence, bind(1, T.divergence));
    for (var i = 0; i < q.iterations; i++) {
      gl.uniform1i(u.uPressure, bind(0, T.pressure.read));
      draw(T.pressure.write);
      T.pressure.swap();
    }

    u = use(P.gradient, T.velocity.write);
    gl.uniform1i(u.uPressure, bind(0, T.pressure.read));
    gl.uniform1i(u.uVelocity, bind(1, T.velocity.read));
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(P.advect, T.velocity.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    gl.uniform1f(u.uDt, dt);
    /* Heavy water is draggy: it settles where it is put and resists being
       moved, which is most of what "mass" is on screen. Mist keeps whatever
       momentum it is given. */
    gl.uniform1f(u.uKeep, 1 / (1 + TUNE.velocityDecay * (1 - 0.68 * storm.level) * drive.decay * (0.6 + 0.75 * material.mass) * dt));
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(P.dye, T.dye.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uDye, bind(1, T.dye.read));
    gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    gl.uniform1f(u.uDt, dt);
    // Heavy water holds its colour; mist lets go of it, so the body genuinely
    // drains rather than being faded out by the display.
    /* PROMPT C: while the eye is closing, the water lets go of its old shape
       faster. The squint narrows the SOURCE, but the field it is drawn into
       holds the open eye's ink for about a third of a second, so what was on
       screen mid-squint was the old oval plus a thin new source -- lumpy, then
       a pointed wedge, never a shut eye. Scaled by the closure itself, so it
       is exactly 1 whenever the eyes are open and touches nothing else. */
    var lid = 1 + 1.3 * agent.character[1]; // PROMPT C
    /* THE MIST MUST NOT BE DRAINED BY THE BODY'S OWN DRAIN RULE. The term above
       speeds dye decay up as the body loses mass, which is right while the body
       is letting go -- but THINKING drains the mass to nothing and then asks a
       cloud to accumulate in its place, so the same term was decaying the cloud
       at 1.85x exactly while it was trying to build. Measured: thinking mist
       covered 0.019-0.024 of the face against a reference of 0.146, LESS than
       the resting body's 0.042, and a page booting mid-thinking drew nothing.
       Fading by (1 - drive.original) hands the rule off as the mist takes over:
       the body still drains when it loses mass, and once the swirl owns the
       field the cloud keeps its colour. */
    var drainBoost = 1.23 * (1 - material.mass) * (1 - drive.original);
    gl.uniform1f(u.uKeep, 1 / (1 + TUNE.dyeDecay * drive.dyeDecay * lid * (0.62 + drainBoost) * dt));
    gl.uniform4fv(u.uEmit, emit);
    gl.uniform3fv(u.uEmitAt, emitAt);
    gl.uniform1f(u.uEmitSharp, TUNE.dyeSharp / (drive.bodyScale * drive.bodyScale));
    var shape = bodyShape();
    gl.uniform4f(u.uBody, seat.x, seat.y, shape.axis, shape.compression);
    gl.uniform2fv(u.uJiggle, shape.jiggle); // JELLY BODY: the source jiggles with the body it is drawn as
    gl.uniform1f(u.uBodyScale, drive.bodyScale);
    gl.uniform4fv(u.uParts, agent.parts.pose);
    gl.uniform1fv(u.uPartAngles, agent.parts.angles);
    gl.uniform4fv(u.uCharacter, agent.character);
    gl.uniform4fv(u.uTool, agent.parts.ring);
    gl.uniform4fv(u.uToolTurn, agent.parts.turn);
    gl.uniform4f(u.uForm, drive.formFrom, drive.form, drive.formMix, agent.formTime);
    {
      gl.uniform4fv(u.uPulse, drive.pulse); gl.uniform2fv(u.uTwist, drive.twist);
      gl.uniform4fv(u.uPulseDye, drive.pulseDye); gl.uniform4fv(u.uRingDye, drive.ringDye);
    }
    draw(T.dye.write);
    T.dye.swap();

    u = use(P.display, null);
    gl.uniform1i(u.uDye, bind(0, T.dye.read));
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    gl.uniform1i(u.uCurl, bind(1, T.curl));
    gl.uniform2fv(u.uCurlTexel, T.curl.px);
    gl.uniform1i(u.uVelocity, bind(2, T.velocity.read));
    gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    gl.uniform2fv(u.uVort, drive.vort);
    /* One scalar, two ends of the same law: how far the body has drained
       toward mist. It used to be `storm.level * drive.original`, which is 0 or
       1 for all but a fraction of a second either side of a thinking swirl --
       the two presets the owner saw it switching between. */
    var wisp = 1 - material.mass;
    gl.uniform1f(u.uMist, wisp);
    gl.uniform3fv(u.uFast, palette.jelly.fast);
    gl.uniform3fv(u.uSlow, palette.jelly.slow);
    gl.uniform3fv(u.uLight, palette.illum || palette.light);
    gl.uniform3fv(u.uDeep, palette.deep);
    gl.uniform1f(u.uMaxAlpha, Math.min(TUNE.cover[1], TUNE.maxAlpha * (palette.dark ? 1.3 : 1)));
    gl.uniform2f(u.uEdge, TUNE.edge - (TUNE.edge - TUNE.edgeWispy) * wisp, TUNE.edgeBand + (TUNE.edgeBandWispy - TUNE.edgeBand) * wisp);
    gl.uniform1f(u.uCurve, 1 + (TUNE.curve - 1) * wisp);
    /* JELLY BODY: the display pass reads the forms itself, so it gets exactly
       the form uniforms the dye pass was given this step. */
    var J = TUNE.jelly;
    gl.uniform4f(u.uBody, seat.x, seat.y, shape.axis, shape.compression);
    gl.uniform2fv(u.uJiggle, shape.jiggle);
    gl.uniform1f(u.uBodyScale, drive.bodyScale);
    gl.uniform4fv(u.uParts, agent.parts.pose);
    gl.uniform1fv(u.uPartAngles, agent.parts.angles);
    gl.uniform4fv(u.uCharacter, agent.character);
    /* CHARACTER PIECES: the display pass only. The dye pass does not get them
       -- they are a reading of the SOLID body's field, and the dye is the
       liquid trail and the mist, which already carry their own wake. */
    gl.uniform4fv(u.uDrops, dropData);
    /* The tool bands: the dye pass gets the area-conserving sigma, and as
       water the solve smears it wide; drawn as a solid at that sigma they are
       hairlines, so the display pass draws them at TUNE.jelly.band times it. */
    var ring = agent.parts.ring, turnT = agent.parts.turn;
    gl.uniform4f(u.uTool, ring[0], ring[1], ring[2] * J.band, ring[3] * J.band);
    /* The tool bands are NOT drawn as solid: the display pass gets the bands
       closed (w = 0) so only the core is analytic, while the dye pass is still
       fed the open bands and the solve carries them as water, drawn by the
       liquid layer below with the soft band law the body had before. Owner:
       "the change to the body changed the way the rings look when they animate.
       we might need to change the blob's weight settings back, during that
       animation." */
    gl.uniform4f(u.uToolTurn, turnT[0], turnT[1], turnT[2], 0.0);
    gl.uniform4f(u.uForm, drive.formFrom, drive.form, drive.formMix, agent.formTime);
    /* THE THREE STATES ARE ONE SCALAR READ THREE WAYS. `wisp` is how far the
       material has drained (materialDrive): the base character sits near 0.09,
       writing at 0.2, tool use up to 0.34, thinking at 0.92 and above. Solid
       fades out over 0.05..0.5, liquid is the band between, mist takes over
       from 0.45. Every intermediate value is a real state of the same body:
       the analytic field shrinks as solid falls, the trail grows with liquid,
       and the mist is the dye itself. */
    var mistW = smooth(0.45, 0.9, wisp), solid = 1 - smooth(0.05, 0.5, wisp), liquid = smooth(0.2, 0.42, wisp) * (1 - smooth(0.5, 0.9, wisp));
    var decayRate = TUNE.dyeDecay * drive.dyeDecay * lid * (0.62 + 1.23 * (1 - material.mass));
    /* .z was the dome height; that now lives in uOpticsNormalGain, which is
       the one place the surface's turn is set. The slot carries the scattered
       light's own return path instead (see `scatter` in the display shader). */
    gl.uniform4f(u.uJellyShape, J.edge, J.fat, J.sssOut, J.wrap);
    gl.uniform4f(u.uJellyState, solid, liquid, mistW, Math.max(0.05, drive.inkAmount / Math.max(0.05, decayRate)));
    var glow = Math.min(1.35, palette.intensity);
    gl.uniform3f(u.uJellyIllum, palette.jelly.illum[0] * glow, palette.jelly.illum[1] * glow, palette.jelly.illum[2] * glow);
    gl.uniform3fv(u.uJellyAbsorb, palette.jelly.absorb);
    gl.uniform4f(u.uJellyPath, J.pathFloor, J.pathGain, palette.dark ? J.sss[0] : J.sssLight, J.sss[1]);
    gl.uniform3fv(u.uJellyTint, palette.jelly.tint);
    var rimJ = palette.dark ? J.rim : J.rimLight;
    gl.uniform4f(u.uJellyRim, rimJ[0], rimJ[1], J.warp * (0.5 + liquid), J.trail);
    /* The coverage floor and ceiling, the margin over the solved coverage, and
       the body's own exposure. Nothing here is per-theme any more: the theme
       enters through uJellyGround, which is what the solve is against. */
    gl.uniform4f(u.uJellyCover, J.opacity[0], J.opacity[1], J.opacityCurve, palette.jelly.expose);
    gl.uniform4f(u.uJellyGlow, palette.dark ? J.glow[0] : J.glow[1], J.glow[2], J.glow[3], J.inner);
    var gnd = palette.jelly.ground || [0, 0, 0];
    gl.uniform4f(u.uJellyGround, gnd[0], gnd[1], gnd[2], J.pass);
    gl.uniform2f(u.uJellyClear, J.seeThrough[0], J.seeThrough[1]);
    gl.uniform4f(u.uJellyLine, palette.jelly.core[0], palette.jelly.core[1], palette.jelly.core[2], palette.dark ? J.line : 1);
    gl.uniform2f(u.uPixel, 1 / canvas.width / FACE, 1 / canvas.height / FACE);
    gl.uniform1f(u.uTime, clock);
    gl.uniform1f(u.uFace, FACE);
    gl.uniform4f(u.uBrim, BRIM.radius, palette.dark ? BRIM.halfDark : BRIM.halfLight, 0, BRIM.steep); // z = 0: the in-canvas ring is off; the SVG rim is the one rim
    gl.uniform1f(u.uCanvasPx, 1 / canvas.width);
    optics.uOpticsSkin[2] = clock * 0.05;
    optics.uOpticsEnvGround = palette.jelly.envGround;
    optics.uOpticsEnvHorizon = palette.jelly.envHorizon;
    optics.uOpticsEnvSky = palette.jelly.envSky;
    /* THE FOUR CHUNKS THAT USED TO COMPILE AND DO NOTHING now own the terms
       they were written for, and these are the numbers that keep them the
       body's own. The first three are the same profile, path and dome height
       this file used to spell out inline, moved to the module's uniforms so
       there is ONE place each is set:
         uOpticsThick  (0, 1, fat)        -- the superellipse thickness profile
         uOpticsPath   (gain, floor)      -- the optical path over that profile
         uOpticsNormalGain                -- the dome height, i.e. how far the
                                             surface turns over at the rim
       uOpticsFresnel takes the rim gain and power the body used to read from
       uJellyRim (the brim still reads uJellyRim), plus a grazing bias so the
       outermost band stays mirror-like where a finite-difference normal can
       never turn fully sideways. */
    optics.uOpticsThick = [0, 1, J.fat];
    optics.uOpticsPath = [J.pathGain, J.pathFloor];
    optics.uOpticsNormalGain = [J.height];
    optics.uOpticsFresnel = [rimJ[0], rimJ[1], J.rimBias];
    /* One light for the whole body: the same direction the shader's jellyLight
       const carries, so the caustics converge where the transmission is lit. */
    optics.uOpticsLightDir = [-0.4479, 0.6470, 0.6171];
    /* WHAT IS BEHIND THE BODY, for refraction to displace. uOpticsBackdropOn
       stays 0 -- there is no backdrop texture in this renderer -- so the
       module's procedural ground is used, and it is the PAGE's own ground
       rather than the module's reference mint: the ledger owns the hue and a
       green disc behind the body would put green in it. The lit disc is that
       same ground lifted toward white (palette.jelly.envLit), and the stripe
       frequency is what gives it edges -- a flat field shows no
       displacement however hard the surface bends it. Over a near-black page
       there is still very little back there to move: that is
       STANDARD-OPTICS section 3, and it is the frame lane's dependency. */
    optics.uOpticsGround = palette.jelly.envGround;
    optics.uOpticsGroundLit = palette.jelly.envLit;
    optics.uOpticsGroundAt = [0.5, 0.5, J.groundDisc, J.groundStripes];
    optics.uOpticsRefract = [J.ior, J.displace, J.dispersion, J.rimTravel];
    optics.uOpticsCaustic = [J.caustic[0], J.caustic[1], J.caustic[2], J.caustic[3]];
    /* x = 0: the host owns the refracted-backdrop term (it has to, to carry
       the ground caustic and uJellyGround.w), so opticsShade must not add it a
       second time. y = 1: the body's own exposure and its dome shading are
       already in the illuminant handed to opticsShade. */
    optics.uOpticsMix = [0, 1];
    uploadOptics(gl, u, optics);
    /* the quiet box is measured against the canvas (the whole ring); the shader compares it in face units */
    gl.uniform2f(u.uQuiet, quiet[0] / FACE, quiet[1] / FACE);
    gl.uniform2f(u.uQuietAt, quietAt[0] / FACE, quietAt[1] / FACE);
    gl.uniform1f(u.uQuietFloor, TUNE.quietFloor + (TUNE.jelly.crowd.floor - TUNE.quietFloor) * drive.crowd);
    gl.uniform1f(u.uOpaque, TUNE.jelly.opaque);
    var cs = palette.statusSRGB || [0.4, 0.45, 0.5];
    var cmix = function (t) { return cs.map(function (v) { return v * (1 - t) + t; }); };
    var cDeep = palette.dark ? cs : cmix(0.15), cLight = cmix(palette.dark ? 0.35 : 0.55);
    gl.uniform3f(u.uClassicDeep, cDeep[0], cDeep[1], cDeep[2]);
    gl.uniform3f(u.uClassicLight, cLight[0], cLight[1], cLight[2]);
    gl.uniform4f(u.uClassic, TUNE.jelly.classic, palette.dark ? 0.5 * 0.6 : 0.5, 1.6, 12.0); // y alpha ceiling (the old 0.5, times the old 0.6 premultiplied scale on dark), z curve, w how much stronger the dye is read than the liquid layer reads it
    gl.uniform1f(u.uClassicLift, palette.dark ? 1.0 / 0.6 : 1.0); // the old premultiplied 0.6 on dark sheets, as straight alpha: colour / 0.6
    var cFast = cmix(palette.dark ? 0.35 : 0.55), cSlow = palette.dark ? cs : cmix(0.15); // the old fast/slow storm stops were the light and deep stops
    gl.uniform3f(u.uClassicSheen, cFast[0], cFast[1], cFast[2]);
    gl.uniform3f(u.uClassicFast, cFast[0], cFast[1], cFast[2]);
    gl.uniform3f(u.uClassicSlow, cSlow[0], cSlow[1], cSlow[2]);
    gl.uniform2f(u.uClassicOn, 1, palette.dark ? 1 : 0);
    draw(null);
  }

  /* ------------------------------------------------------------ the loop */

  function frame(now) {
    rafId = 0;
    if (!running) return;
    stats.raf++;
    rafId = requestAnimationFrame(frame);
    var budget = 1000 / LADDER[level].fps;
    if (lastStep && now - lastStep < budget - 4) return;
    var interval = lastStep ? now - lastStep : budget;
    lastStep = now;
    var started = performance.now();
    try {
      /* typeof, because the cadence suite runs this loop extracted from the
         module in a vm where the mount-scope hook does not exist */
      var dtFixed = typeof fixedDt !== 'undefined' ? fixedDt : 0;
      if (dtFixed) step(dtFixed, (stats.steps + 1) * dtFixed);
      else {
        /* A LATE FRAME CATCHES THE CLOCK UP. A background or covered tab is
           granted a frame every second or less, and one step per frame moves
           the character's clock by at most 50 ms, so the 1.35 s drain into the
           liquid form took minutes of wall time there (measured: 6 frames in
           20 s under a cover page). A gap longer than one budget is walked in
           budget-sized sub-steps, at most 30 of them, so the state the owner
           sees on return is the one the wall clock says it should be. The
           determinism hook keeps one fixed step per frame. */
        var gap = Math.min(interval, 30 * budget), sub = Math.max(1, Math.min(30, Math.round(gap / budget)));
        for (var k = 0; k < sub; k++) step(Math.min(gap / sub, 50) / 1000, (now - gap + gap * (k + 1) / sub) / 1000);
        if (sub > 1) stats.steps += sub - 1;
      }
    } catch (error) {
      stats.note = String(error && error.message || error).slice(0, 160);
      fail('error');
      return;
    }
    var work = performance.now() - started, full = null;
    /* A few steps per window wait for the GPU to finish, so their time is the
       circle's whole cost rather than only the script's. */
    if (!warm && intervals.length % PROBE_EVERY === PROBE_EVERY - 1) {
      try {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probePixel);
        full = performance.now() - started;
      } catch (error) { full = null; }
    }
    stats.steps++;
    /* JELLY BODY: the body is analytic and complete on its first drawn frame,
       so the canvas is revealed on that frame rather than after the first
       judged window (26 steps, which is 26 seconds in a throttled background
       tab and never in an unfocused one). judge() still reveals as a
       fallback. */
    if (!shown) reveal();
    /* Once the character has arrived, the focus rule is re-applied (it pauses
       on a frozen frame of the settled body); with focus this is a no-op. */
    if (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus() && settled()) update();
    judge(interval, work, budget, full);
  }

  /* Frame time is judged on the interval between steps and on the circle's
     own cost per step (fluidWindowVerdict says when the interval is the
     circle's fault). Two slow windows in a row, or one badly slow window, or
     any slow window before the canvas has been shown, cost a rung. */
  function judge(interval, work, budget, full) {
    if (warm > 0) { warm--; return; }
    intervals.push(interval);
    works.push(work);
    if (full !== null && full !== undefined) probes.push(full);
    if (intervals.length < WINDOW) return;
    var verdict = fluidWindowVerdict({ intervals: intervals, works: works, probes: probes, budget: budget });
    var m = verdict.medianMs, w = verdict.workMs;
    intervals.length = 0; works.length = 0; probes.length = 0;
    stats.medianMs = Math.round(m * 10) / 10;
    stats.workMs = Math.round(w * 100) / 100;
    stats.fullMs = verdict.fullMs === null ? null : Math.round(verdict.fullMs * 100) / 100;
    /* REVEAL: A CIRCLE THAT IS RUNNING HAS TO BECOME VISIBLE.
       reveal() used to be reachable only through the `!verdict.slow` branch
       below, so a machine that is judged slow on EVERY window never showed the
       circle at all -- and `.home-circle-fluid` sits at opacity 0 until
       reveal() adds `.is-live`. The renderer was then in the one state nothing
       could see: state running, steps climbing, the WebGL buffer holding a
       perfectly good body, and an empty ring on screen. Measured: with
       `.is-live` withheld, 0.00% of the face differs from its own backdrop
       while the same frame has 7.11% with it. The owner reported that empty
       circle twice.
       It was also terminal rather than merely invisible. `!shown` forces a
       degrade on every slow window, and degrade() calls fail() once the drop
       runs off the end of the ladder, so a slow page walked 4 -> 5 -> 6 -> off
       without ever having drawn anything a person could see.
       The ladder is the answer to a slow machine: it makes the circle cheaper.
       Going invisible is not. So the first completed window reveals whatever
       the verdict was, and slowness still degrades exactly as before. */
    if (!shown) reveal();
    if (!verdict.slow) {
      strikes = 0;
      return;
    }
    strikes++;
    if (verdict.severe || strikes >= 2) degrade(verdict.severe ? 2 : 1, m, w);
  }

  function degrade(drop, m, w) {
    if (extrasOn) {
      /* First rung: the v2 extras (personality, blowup episodes, voice) go before any detail does. */
      stats.changes.push({ atMs: Math.round(performance.now()), from: 'extras', to: 'plain-v1',
        medianMs: Math.round(m * 10) / 10, workMs: Math.round(w * 100) / 100, fullMs: stats.fullMs });
      dropExtras('slow');
      strikes = 0; warm = WARMUP; lastStep = 0;
      return;
    }
    var from = level, to = level + drop;
    stats.changes.push({ atMs: Math.round(performance.now()), from: from, to: to < LADDER.length ? to : 'css',
      medianMs: Math.round(m * 10) / 10, workMs: Math.round(w * 100) / 100, fullMs: stats.fullMs });
    strikes = 0;
    if (to >= LADDER.length) { fail('slow'); return; }
    level = to;
    stats.level = level;
    visual.setAttribute('data-fluid-level', String(level));
    allocate();
    warm = WARMUP;
    lastStep = 0;
  }

  /* THE FROZEN FRAME MUST BE A BODY, NOT THE START OF ONE. The canvas was
     revealed and then paused (without focus) on its very first step, and at
     that step the mount morph from nothing has barely begun -- the body drew
     as two faint smudges. The loop now keeps running without focus until the
     character has arrived: 1.5 s of its own clock, past the 0.8 s form blend
     and the first squash. */
  var SETTLE_SECONDS = 1.5;
  function settled() { return shown && clock >= SETTLE_SECONDS; }
  function reveal() {
    shown = true;
    /* the SVG lip gives way to the in-canvas brim while the fluid is live (teardown restores it) */
    /* The SVG ring stays: one rim in every state (owner, 2026-09-19). */
    moment.wake = clock;
    burst(8, 0.32);
    if (canvas) canvas.classList.add('is-live');
    /* The reveal was the only reason to keep running without focus: now that
       there is a body on screen, re-apply the focus rule (which pauses on a
       frozen frame of that body). */
  }

  /* Why the loop is not running. `observed` is false until the intersection
     observer has reported once; a covered or background tab may never get that
     callback, and until it does the honest answer is that no frame has been
     granted, not that the circle is off screen. */
  var observed = false;
  function pauseReason() {
    if (document.hidden) return 'hidden';
    if (document.hasFocus && !document.hasFocus()) return 'no-focus';
    if (!observed) return 'no-frame';
    return onScreen ? 'idle' : 'off-screen';
  }
  function update() {
    /* Off screen, hidden, or not the focused window: no animation frames at all. */
    /* JELLY BODY -- THE CHARACTER MUST EXIST BEFORE IT IS ALLOWED TO PAUSE.
       The loop paused without document focus, and the canvas is opacity 0
       until reveal(), so a window that opened without focus (or a capture
       taken from an unfocused page) showed an EMPTY disc in the very state
       the owner sees when an agent needs him: state paused, steps 0, nothing
       drawn. Until the body has been drawn once the loop runs regardless of
       focus; from then on the focus rule stands and the frozen frame is a
       body at rest, not an absence. */
    var want = !dead && gl && onScreen && !document.hidden && (!settled() || !document.hasFocus || document.hasFocus());
    if (want && !running) {
      running = true;
      lastStep = 0;
      warm = WARMUP;
      intervals.length = 0; works.length = 0; probes.length = 0;
      setState('running');
      rafId = requestAnimationFrame(frame);
    } else if (!want && running) {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      /* The pause names its cause, so a harness that waits on a form while the
         page is unfocused or hidden can refuse with it instead of timing out. */
      if (!dead) setState('paused', pauseReason());
    } else if (!want && !running && !dead && gl && stats.state === 'paused') {
      /* a loop that never started still says why it is not running */
      setState('paused', pauseReason());
    }
  }


  /* ------------------------------------------------------------ start, stop */

  function teardown(immediate) {
    try { ring.querySelectorAll('.home-core-lip, .home-core-halo').forEach(function (el) { el.style.opacity = ''; }); } catch (error) { /* no SVG lip here */ }
    // A Still transition may already be fading a retired canvas. Simple or
    // route teardown must release that context too, without waiting for it.
    if (immediate) retiringCanvases.forEach(function (finish) { finish(); });
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (observer) observer.disconnect();
    if (resizer) resizer.disconnect();
    observer = resizer = null;
    window.removeEventListener('resize', sizeCanvas);
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('blur', update);
    window.removeEventListener('focus', update);
    visual.removeEventListener('pointermove', stir);
    visual.removeEventListener('click', tap);
    visual.removeEventListener('dblclick', doubleTap);
    voiceOff('teardown'); hideVoice(); episode = null;
    var old = canvas, oldGl = gl;
    canvas = null; gl = null; T = null; P = null;
    if (old) {
      var lose = null;
      try { lose = oldGl && !oldGl.isContextLost() && oldGl.getExtension('WEBGL_lose_context'); } catch (error) { lose = null; }
      var finish = function () {
        clearTimeout(fadeTimer);
        retiringCanvases.delete(finish);
        if (old.parentNode) old.parentNode.removeChild(old);
        try { if (lose) lose.loseContext(); } catch (error) { /* already gone */ }
      };
      if (!immediate && shown && old.classList.contains('is-live')) {
        old.classList.remove('is-live');
        retiringCanvases.add(finish);
        var fadeTimer = setTimeout(finish, 700);
      } else finish();
    }
    shown = false;
  }

  function fail(reason) {
    if (dead) return;
    dead = true;
    teardown();
    setState('off', reason);
  }

  function stir(event) {
    if ((ring.dataset.agentAction || 'idle') !== 'idle' || (event.pointerType && event.pointerType !== 'mouse')) return;
    var r = (canvas || ring).getBoundingClientRect();
    if (!r.width) return;
    var x = (event.clientX - r.left) / r.width, y = 1 - (event.clientY - r.top) / r.height;
    var now = performance.now();
    if ((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5) < 0.22) persona.lean = { x: x, y: y, t: clock };
    if (pointer && now - pointer.t < 120) {
      var span = Math.max(8, now - pointer.t) / 1000;
      var inside = Math.pow(x - 0.5, 2) + Math.pow(y - 0.5, 2) < 0.2;
      var dx = (x - pointer.x) / span, dy = (y - pointer.y) / span, cap = 2.5;
      var speed = Math.sqrt(dx * dx + dy * dy);
      if (speed > cap) { dx *= cap / speed; dy *= cap / speed; }
      pointer = { x: x, y: y, dx: inside ? dx : 0, dy: inside ? dy : 0, t: now, fresh: inside };
    } else pointer = { x: x, y: y, dx: 0, dy: 0, t: now, fresh: false };
  }

  function boot() {
    if (booted || dead || gone) return;
    var reason = blocked();
    if (reason) { setState('off', reason); return; }
    booted = true;
    try {
      canvas = document.createElement('canvas');
      canvas.className = 'home-circle-fluid';
      canvas.setAttribute('aria-hidden', 'true');
      var made = context(canvas);
      if (made && made.version === 2) {
        gl = made.gl;
        F = formats(true);
        if (!F) {
          /* WebGL2 without float render targets: try WebGL1 on a fresh canvas. */
          var lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
          canvas = document.createElement('canvas');
          canvas.className = 'home-circle-fluid';
          canvas.setAttribute('aria-hidden', 'true');
          var gl1 = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
            stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
          made = gl1 ? { gl: gl1, version: 1 } : null;
        }
      }
      if (!made) { canvas = null; gl = null; fail('no-webgl'); return; }
      gl = made.gl;
      stats.webgl = made.version;
      if (software()) { fail('software-webgl'); return; }
      F = F && made.version === 2 ? F : formats(made.version === 2);
      if (!F) { fail('no-float-targets'); return; }
      /* Only the live canvas counts: a settings pause releases its old context on purpose. */
      canvas.addEventListener('webglcontextlost', function () { if (this === canvas) fail('context-lost'); });

      var vertex = compile(gl.VERTEX_SHADER, VERTEX);
      P = {};
      for (var name in FRAGMENTS) P[name] = program(vertex, FRAGMENTS[name]);
      var buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);

      level = SMALL_START;
      stats.level = level;
      visual.setAttribute('data-fluid-level', String(level));
      /* The whole ring, above the SVG frame and below the words (which are z 2 and later in the DOM). */
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.zIndex = '2';
      ring.insertBefore(canvas, ring.firstChild);
      allocate();
      readPalette();
      /* A SETTLED BODY EXISTS BEFORE THE FIRST ANIMATION FRAME. A hidden tab or
         an occluded window is never granted an animation frame (the browser's
         rule, not this one), so the loop below cannot draw there -- and the
         owner first met this circle as an empty disc in exactly that state.
         So the character's first 1.5 s are stepped here, synchronously, once:
         about 45 steps of script at under a millisecond each, and the frame
         they leave in the canvas is a settled body, revealed. When the page
         becomes visible the loop simply continues from it. */
      try {
        /* The burst holds the material SOLID: a thinking agent's form drains to
           mist inside 1.5 s, and 47 steps of mist over a dark ground is a dot,
           which is what a never-frontmost window opened on a thinking agent
           showed. So the frozen frame is the analytic solid body of whatever
           form is current; the drain begins when frames actually flow. */
        booting = true;
        var burstSteps = Math.ceil(SETTLE_SECONDS * 30) + 2;
        for (var b = 0; b < burstSteps; b++) step(1 / 30, (b + 1) / 30);
        booting = false;
        stats.steps += burstSteps;
        reveal();
      } catch (error) { booting = false; stats.note = 'settle: ' + String(error && error.message || error).slice(0, 140); }

      /* The readout too: a late font swap or text zoom resizes the words, not the ring. */
      if (window.ResizeObserver) { resizer = new ResizeObserver(sizeCanvas); resizer.observe(ring); if (centre) resizer.observe(centre); }
      window.addEventListener('resize', sizeCanvas);
      document.addEventListener('visibilitychange', update);
      window.addEventListener('blur', update);
      window.addEventListener('focus', update);
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        visual.addEventListener('pointermove', stir, { passive: true });
        visual.addEventListener('dblclick', doubleTap);
      }
      observer = new IntersectionObserver(function (entries) {
        onScreen = entries[entries.length - 1].isIntersecting;
        observed = true;
        update();
      });
      observer.observe(visual);
      if (extrasOn) visual.addEventListener('click', tap);
      setState('paused', pauseReason());
    } catch (error) {
      stats.note = String(error && error.message || error).slice(0, 160);
      fail('error');
    }
  }

  /* A settings change can stop the fluid (Still, Reduce motion, Glow 0) or let it start again; theme and status
     changes only recolour it. This watcher lives as long as the Home view, not the canvas. */
  function sleep(reason) {
    teardown();
    booted = false;
    setState('off', reason);
  }
  function recheck() {
    paletteDirty = true;
    if (gone || dead) return;
    var reason = blocked();
    if (reason && booted) sleep(reason);
    else if (reason && !booted) setState('off', reason);
    else if (!reason && !booted) { stats.reason = ''; visual.removeAttribute('data-fluid-reason'); schedule(); }
  }
  settingsWatch = new MutationObserver(recheck);
  settingsWatch.observe(ring, { attributes: true, attributeFilter: ['data-circle-motion', 'data-circle-style', 'data-load'] });
  var homeSurface = ring.closest('.home');
  if (homeSurface) settingsWatch.observe(homeSurface, { attributes: true, attributeFilter: ['style', 'data-ledger-status'] });
  settingsWatch.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  if (document.body) settingsWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (motion) { if (motion.addEventListener) motion.addEventListener('change', recheck); else if (motion.addListener) motion.addListener(recheck); }

  /* Decorative, so it waits: when the renderer is idle and once the circle is near the screen. */
  function schedule() {
    var reason = blocked();
    if (reason) { setState('off', reason); return; }
    var later = window.requestIdleCallback
      ? function (fn) { window.requestIdleCallback(fn, { timeout: 1200 }); }
      : function (fn) { setTimeout(fn, 200); };
    var near = function () {
      if (gone) return;
      if (!window.IntersectionObserver) { boot(); return; }
      if (nearWatch) nearWatch.disconnect();
      nearWatch = new IntersectionObserver(function (entries) {
        if (!entries[entries.length - 1].isIntersecting) return;
        nearWatch.disconnect(); nearWatch = null;
        later(boot);
      }, { rootMargin: '200px 0px' });
      nearWatch.observe(visual);
    };
    if (document.readyState === 'complete') later(near);
    else window.addEventListener('load', function () { later(near); }, { once: true });
  }

  function destroy() {
    if (gone) return;
    gone = true; dead = true;
    teardown(true);
    if (nearWatch) { nearWatch.disconnect(); nearWatch = null; }
    if (settingsWatch) { settingsWatch.disconnect(); settingsWatch = null; }
    if (motion) { if (motion.removeEventListener) motion.removeEventListener('change', recheck); else if (motion.removeListener) motion.removeListener(recheck); }
    try { delete ring.homeCircleFluid; } catch (error) { /* already gone */ }
  }

  try { setState('waiting'); schedule(); } catch (error) { stats.note = String(error && error.message || error).slice(0, 160); destroy(); }
  return { destroy: destroy };
}
