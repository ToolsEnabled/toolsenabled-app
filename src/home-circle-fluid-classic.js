/* CLASSIC: the Home circle fluid exactly as it was at 71c3ab72 (2026-09-15
   23:37, "the look the owner approved"), with the contour lines of the
   22:50 build. Kept as its own module so the owner can switch to it from
   quick settings (Home circle: Classic) and compare it live against the
   current renderer. Bash reuses the accepted Blob's original orbit motion. */
/* THE HOME CIRCLE, COME ALIVE (app page 1, route #/).
 *
 * The same real-time fluid as the toolsenabled.ai homepage circle (website public/orbit-fluid.js, e7512f0), ported to
 * the app's Home ring (src/home-circle.js inside uptimeRing): it paints inside the ring's face, beneath the readout and
 * the ring, and the ring's own light -- its status lip -- is its source. The ring itself is still. The water is a blob
 * at a seat that wanders and bounces round the face (seatDrive), breathing, with gestures of its own every few seconds
 * (personality); what the followed agent is doing (agentDrive), a hop to another agent, the person's pointer or click
 * shape those gestures, and the sharper ones turn it into fluid and storm mist (stormDrive) before it gathers again.
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
 *     theme and status colours come from the ring's --core-status-color (teal / blue / coral, never gold);
 *   - it pauses when Home is off screen, the window is hidden, or the window is not focused, and it always starts at the
 *     site's small-screen rung (the app runs agents, so its budget is never looser than the site's);
 *   - voice has no microphone of its own: the Home voice widget (voice-coordinator.js) owns the microphone through the
 *     shell's permission gate (shell/voice-permissions.cjs); this reads only the widget's state (ring.dataset.voice),
 *     its on-screen level and the words it recognized (voice-signal.js).
 *   - it acts out what the followed agent is doing: home.js keeps data-agent-action (thinking, reading, writing,
 *     running, waiting, idle; src/home-circle-action.js) and data-agent-name on the ring, and agentDrive below turns
 *     each into a way of driving the same forcing, with a small splash on the lit arc when the circle hops to
 *     another agent.
 * Kill switch: home.js sets ring.dataset.fluid = 'on' and data-fluid-extras = 'personality blowup voice'. Diagnostics:
 * the ring element's homeCircleFluid.stats() and .play().
 */
import { voiceSignal } from './voice-signal.js'
import { actionMotion, createBlobParts, updateBlobParts } from './home-circle-motion.js'
import { createPlayfulMoment, blobMomentsEnabled, BLOB_MOMENTS_KEY, BLOB_MOMENTS_EVENT, MOMENT_MATERIAL, PLAYFUL_MOMENT_GLSL } from './home-circle-playful-moment.js'

// Display-only refinement. False restores the approved softer body exactly;
// motion, simulation resolution, status colors and the rim are independent.
const BLOB_BODY_FINISH = true

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
  /* Decoration never breaks Home: without the browser pieces it needs (or in a test's stand-in DOM) it stays out. */
  if (!ring || !ring.dataset || ring.dataset.fluid !== 'on' || typeof window === 'undefined' || !window.requestAnimationFrame
    || !window.getComputedStyle || !window.MutationObserver || !window.IntersectionObserver || !document.body) return inert;
  var visual = ring;
  var centre = ring.querySelector('.uring-inner');
  var root = document.documentElement;
  void sample;

  /* The quality ladder (the site's). The app always starts at rung 2 (grid 96, dye 192), the site's small-screen
     start, and only ever steps down; past the last rung the canvas is removed. */
  var LADDER = [
    { sim: 128, dye: 256, iterations: 20, fps: 30 },
    { sim: 128, dye: 192, iterations: 20, fps: 30 },
    { sim: 96, dye: 192, iterations: 20, fps: 30 },
    { sim: 96, dye: 128, iterations: 20, fps: 30 },
    { sim: 64, dye: 128, iterations: 20, fps: 30 },
    { sim: 64, dye: 128, iterations: 12, fps: 30 },
    { sim: 64, dye: 128, iterations: 12, fps: 20 }
  ];
  /* Rung 4 (sim 64, dye 128, 20 iterations, 30 fps): the water look wants smooth, large shapes, not fine smoke, and
     starting here is roughly half the GPU work of the site's rung 2 (owner, 2026-09-15: "reduce lag a lot"). */
  var SMALL_START = 4;

  /* Motion and look, tuned by eye on screenshots of every theme at desktop
     and phone sizes. Units: the circle's box is 1 x 1, time in seconds.
     Weight (owner, 2026-09-15: "give the fluid personality and a little more weight ... try not just to spin it all
     the time"): the ambient circulation is halved, the fluid is more viscous so motion settles, and the plumes are
     bigger, denser and roll inward from the sources rather than streaking round the wall. */
  var TUNE = {
    swirl: 0,            // tangential acceleration in the band along the wall: none at rest (the storm adds some)
    push: 0.62,          // acceleration at the seat, pointing inward: the blob's cohesion -- a little more, so the body holds
    pushSharp: 70,       // source force falloff, 1 / (2 sigma^2)
    inward: 0.75,        // share of a source's push that points at the centre
    dye: 1.7,            // dye added per second at the seat -- owner, 2026-09-20: 'a little more solid in its base state'
    dyeSharp: 70,        // source dye falloff: one body, laid down a little loosely
    lightShare: 0.45,    // most of any source's dye that is the lighter colour
    sourceRadius: 0.4,   // distance of the sources from the centre: inside the wall, so the water roams the face
    sourceSpeed: 0.17,   // radians per second of each source's slow sweep
    curl: 1.5,           // vorticity confinement at rest (the storm raises it, see uCurlStrength)
    velocityDecay: 1.3,  // per second at rest: a blob holds still (the storm thins it to a third)
    dyeDecay: 0.45,      // per second: the blob keeps its size instead of filling the face
    pressureKeep: 0.8,   // warm start for the Jacobi iterations
    maxAlpha: BLOB_BODY_FINISH ? 0.86 : 0.8, // modestly more body without becoming opaque
    curve: BLOB_BODY_FINISH ? 1.5 : 1.6,     // keep translucent depth inside the clearer contour
    quietFloor: 0.4,     // colour behind the words: dimmed to 40%, not cleared (owner, 2026-09-15: the blob may pass under the text, "dim the parts directly behind the text")
    darkGlow: 0.8,       // dark themes: alpha scale (below 1 adds light) -- .6 read faint (owner: 'i have to like strain my eyes to see it')
    pointer: 1.0         // fine-pointer stir strength
  };

  // The saved base is fixed. Every animation owns its solver and material weights;
  // editing an action never changes the base or another action's defaults.
  var STATE_WEIGHTS = Object.freeze({
    base: Object.freeze({ push: TUNE.push, pushSharp: TUNE.pushSharp, dye: TUNE.dye, dyeSharp: TUNE.dyeSharp,
      velocityDecay: TUNE.velocityDecay, dyeDecay: TUNE.dyeDecay, curl: TUNE.curl,
      maxAlpha: TUNE.maxAlpha, curve: TUNE.curve - 0.08, relief: 8, quietFloor: TUNE.quietFloor, sheen: 1, soften: 0 }),
    writing: Object.freeze({ push: 0.62, pushSharp: 70, dye: 1.7, dyeSharp: 70,
      velocityDecay: 3.38, dyeDecay: 0.45, curl: 1.5, maxAlpha: 0.86, curve: 1.32, relief: 4.6, quietFloor: 0.54, sheen: 0.12, soften: 0.34 }),
    thinking: Object.freeze({ push: 0.6, pushSharp: 70, dye: 1.9, dyeSharp: 70,
      velocityDecay: 1.6, dyeDecay: 0.45, curl: 1.5, maxAlpha: 0.7, curve: 1.6, relief: 4.75, quietFloor: 0.4, sheen: 0.6, soften: 0.3 }),
    running: Object.freeze({ push: 0.62, pushSharp: 70, dye: 1.7, dyeSharp: 70,
      velocityDecay: 1.3, dyeDecay: 0.45, curl: 1.5, maxAlpha: 0.86, curve: 1.35, relief: 6.5, quietFloor: 0.56, sheen: 0.6, soften: 0.3 })
  });
  var ANIMATION_PACE = Object.freeze({ writingWave: 1.32, writingTravel: 0.015, orbitSpin: 0.64 });
  var bodyWeights = Object.assign({}, STATE_WEIGHTS.base);
  function blendStateWeights() {
    var w = bodyFinish.writing, t = bodyFinish.thinking, r = orbit[1];
    var total = w + t + r, divisor = Math.max(1, total), base = Math.max(0, 1 - total);
    Object.keys(bodyWeights).forEach(function (key) {
      bodyWeights[key] = STATE_WEIGHTS.base[key] * base +
        (STATE_WEIGHTS.writing[key] * w + STATE_WEIGHTS.thinking[key] * t + STATE_WEIGHTS.running[key] * r) / divisor;
    });
  }

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
  var palette = { light: [0.58, 0.85, 0.73], deep: [0.15, 0.6, 0.39], fast: [0.58, 0.85, 0.73], slow: [0.15, 0.6, 0.39], dark: false,
    arc: { start: 130, light: 195, deep: 246, end: 332 }, intensity: 1 };
  var quiet = [0.3, 0.22], quietAt = [0, 0];
  var pointer = null;
  var observer = null, resizer = null, settingsWatch = null, nearWatch = null;
  var playfulMoment = createPlayfulMoment(), momentsEnabled = blobMomentsEnabled();
  var momentPose = playfulMoment.step(0, { enabled: false });
  function syncMoments(event) {
    if (!event || !event.key || event.key === BLOB_MOMENTS_KEY) momentsEnabled = blobMomentsEnabled();
  }
  window.addEventListener(BLOB_MOMENTS_EVENT, syncMoments);
  window.addEventListener('storage', syncMoments);

  /* ------------------------------------------------------------ diagnostics */

  function setState(state, reason) {
    stats.state = state;
    if (reason) stats.reason = reason;
    visual.setAttribute('data-fluid-state', state);
    if (reason) visual.setAttribute('data-fluid-reason', reason);
  }

  try {
    ring.homeCircleFluid = Object.freeze({
      play: function () { return startEpisode('api'); },
      playMoment: function () {
        if (!running || !T || !momentsEnabled || !extrasOn || !extras.personality || episode || voice.state === 'on' || blocked()) return false;
        return playfulMoment.preview(seat);
      },
      stats: function () {
        var q = LADDER[level] || {};
        return JSON.parse(JSON.stringify({
          state: stats.state, reason: stats.reason, level: stats.level, webgl: stats.webgl,
          sim: q.sim, dye: q.dye, iterations: q.iterations, fps: q.fps,
          canvas: canvas ? [canvas.width, canvas.height] : null,
          raf: stats.raf, steps: stats.steps, medianMs: stats.medianMs, workMs: stats.workMs, fullMs: stats.fullMs,
          changes: stats.changes, note: stats.note, intensity: Math.round(palette.intensity * 100) / 100,
          extras: { on: extrasOn, personality: extras.personality, blowup: extras.blowup, voice: extras.voice },
          episode: episode ? { phase: episode.phase || 'rest', tau: episode.tau, reason: episode.reason } : null, played: played,
          moment: Object.assign({ enabled: momentsEnabled }, playfulMoment.stats()),
          agent: { action: agent.action, name: agent.name, event: agent.event, kicks: agent.kicks,
            orbit: agent.action === 'running' && bashMotion ? { phase: bashMotion.phase, elapsed: clock - agent.since, radii: Array.from(bashParts.ring), turns: Array.from(bashParts.turn, (value, i) => i < 2 ? value * ANIMATION_PACE.orbitSpin : value), speed: ANIMATION_PACE.orbitSpin } : null,
            thinking: agent.action === 'thinking' && thinkingMotion ? { source: '97e1364e', elapsed: clock - agent.since, phase: thinkingMotion.phase, beat: thinkingMotion.beat, surge: thinkingMotion.surge, original: thinkingMotion.original } : null },
          mood: { name: mood.name }, storm: Math.round(storm.level * 100) / 100, seat: { deg: Math.round(seat.deg), radius: Math.round(seat.radius * 100) / 100, x: Math.round(seat.x * 100) / 100, y: Math.round(seat.y * 100) / 100, pace: Math.round(seat.pace * 1000) / 1000 },
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
    // glow 0 no longer stops the water: the slider is the ring's, not the body's
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
  function lifted(c, lightness, saturation) {
    var max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
    var l = (max + min) / 2, d = max - min;
    var s = d < 0.0001 ? 0 : d / (1 - Math.abs(2 * l - 1));
    var h = hue(c);
    if (h < 0) return [lightness, lightness, lightness];
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

  /* The status hue belongs to the ring. Pigment and reflected light are balanced
     for each sheet; the body keeps its own visibility independently of Glow. */
  function readPalette() {
    paletteDirty = false;
    var styles = getComputedStyle(ring);
    var status = rgba(styles.getPropertyValue('--core-status-color').trim()) || [0.4, 0.45, 0.5, 1];
    if (status[3] < 0.5) status = [0.4, 0.45, 0.5, 1];
    var ground = rgba(getComputedStyle(document.body).backgroundColor) || [1, 1, 1, 1];
    if (ground[3] < 0.5) ground = rgba(getComputedStyle(root).getPropertyValue('--bg').trim() || '#fff') || [1, 1, 1, 1];
    palette.dark = luminance(ground) < 0.2;
    // Preserve the saved base palette exactly. Theme refinements belong to actions.
    var deep = status.slice(0, 3), light = mixed(deep, [1, 1, 1], palette.dark ? 0.35 : 0.45);
    palette.deep = palette.dark ? deep : lifted(deep, 0.30, 0.78);
    palette.light = palette.dark ? light : lifted(light, 0.50, 0.68);
    palette.fast = ungilded(palette.light); palette.slow = ungilded(palette.deep);
    var theme = root.dataset.theme || 'black';
    var finish = ({ white: [0.49, 0.27, 0.62, 0.42], tan: [0.46, 0.25, 0.58, 0.38],
      black: [0.70, 0.38, 0.52, 0.52], ember: [0.68, 0.36, 0.55, 0.46], cobalt: [0.70, 0.39, 0.58, 0.50] })[theme] || [0.58, 0.31, 0.56, 0.45];
    palette.actionDeep = lifted(status, finish[1], finish[2]);
    palette.actionLight = lifted(status, finish[0], finish[2]);
    palette.actionShine = mixed(palette.actionLight, theme === 'tan' || theme === 'ember' ? [1, 0.96, 0.9] : [0.94, 0.98, 1], finish[3]);
    palette.actionFast = ungilded(palette.actionLight); palette.actionSlow = ungilded(palette.actionDeep);
    // Thin orbit bands need a little more reflected light on dark sheets.
    palette.orbitLight = mixed(palette.actionLight, palette.actionShine, palette.dark ? 0.18 : 0);
    palette.orbitDeep = mixed(palette.actionDeep, palette.actionLight, palette.dark ? 0.14 : 0);
    var trail = parseFloat(styles.getPropertyValue('--core-glow-trail'));
    if (!Number.isFinite(trail)) trail = palette.dark ? 0.75 : 0.5;
    /* THE BODY DOES NOT FOLLOW THE GLOW SLIDER (owner, 2026-09-19: "the blob
       ... actually disappears totally when glow is turned down ... The blob
       should be there always"). The slider drives the ring's halo through
       --glow in CSS; the water keeps its own strength, the trail dose alone,
       never under 1. */
    palette.intensity = Math.max(palette.dark ? 1 : 1.2, Math.min(1.5, trail / (palette.dark ? 0.75 : 0.5)));
  }

  /* THE SEAT (owner, 2026-09-15: "a blob character that turns into fluid", "bounce around and such with a
     personality, not just sit there in the center"). The blob lives at its seat, a point on the face with a velocity.
     It wanders with a slowly changing heading, a finite turning rate, and filtered speed.
     It banks before the wall and carries its momentum through action changes. Its pace follows
     the mood and action, with independent fluid gestures during Thinking. The ring's lit arc is centred on
     the seat so the light and the water agree. Angles are degrees clockwise from the top. */
  var WALL = 0.36;
  var seat = { x: 0.5, y: 0.5 + 0.3, vx: 0, vy: 0, heading: Math.random() * Math.PI * 2, face: null, speed: 0, steerAt: 0, goal: null, pace: 0.05,
    deg: 0, radius: 0.3, moving: 0, bounced: -9 };
  function moveSeat(deg, radius) {
    var a = deg * Math.PI / 180, r = Math.min(WALL - 0.02, radius || seat.radius);
    seat.goal = { x: 0.5 + r * Math.sin(a), y: 0.5 + r * Math.cos(a) };
  }
  function seatDrive(dt) {
    var t = clock, target = seat.heading, speed = seat.pace;
    var active = smooth(agent.since, agent.since + ACTION_EASE, t);
    var writing = bodyFinish.writing;
    var running = agent.action === 'running' ? active : 0;
    // Make room for the orbit by steering inward, without relocating its centre.
    var wall = WALL - 0.13 * running - 0.10 * writing;
    var floating = /^(idle|reading|waiting)$/.test(agent.action);
    if (seat.goal) {
      var gx = seat.goal.x - seat.x, gy = seat.goal.y - seat.y, gd = Math.sqrt(gx * gx + gy * gy);
      if (gd < 0.012) seat.goal = null;
      else { target = Math.atan2(gy, gx); speed = Math.min(0.24, gd * 1.8); }
    } else if (t > seat.steerAt) {
      seat.heading += (Math.random() - 0.5) * 0.42;
      seat.steerAt = t + 5 + Math.random() * 5;
      target = seat.heading;
    }
    if (!seat.goal) { seat.heading += noise(t, 7) * 0.18 * dt; target = seat.heading; }
    var px = seat.x - 0.5, py = seat.y - 0.5, r = Math.sqrt(px * px + py * py);
    if (r > wall - 0.11) {
      var nx = px / r, ny = py / r, edge = smooth(wall - 0.11, wall, r);
      var radial = Math.cos(target) * nx + Math.sin(target) * ny;
      if (radial > -0.35) {
        // Bank along the inside of the rim, then drift away from it.
        var tangent = Math.cos(target) * -ny + Math.sin(target) * nx >= 0 ? 1 : -1;
        var boundary = Math.atan2(tangent * nx - 0.7 * ny, -tangent * ny - 0.7 * nx);
        var bend = Math.atan2(Math.sin(boundary - target), Math.cos(boundary - target));
        target += bend * edge;
      }
      speed *= 1 - 0.35 * edge;
    }
    if (seat.face === null) seat.face = target;
    var angle = Math.atan2(Math.sin(target - seat.face), Math.cos(target - seat.face));
    var turnRate = (floating ? 0.42 : 0.65) + 1.5 * smooth(wall - 0.10, wall, r);
    seat.face += Math.max(-turnRate * dt, Math.min(turnRate * dt, angle));
    seat.speed += (speed - seat.speed) * (1 - Math.exp(-1.4 * dt));
    var wantX = Math.cos(seat.face) * seat.speed, wantY = Math.sin(seat.face) * seat.speed;
    // Brake the travel before the rim, without changing the fluid's weight.
    if (r > wall - 0.12) {
      var cushion = smooth(wall - 0.12, wall, r);
      var outward = Math.max(0, (wantX * px + wantY * py) / r);
      var inward = outward * cushion + 0.075 * cushion * cushion;
      wantX -= px / r * inward; wantY -= py / r * inward;
    }
    // A soft spring is a guard during shape changes, not a moving position clamp.
    if (r > wall) { wantX -= px / r * (r - wall) * 1.4; wantY -= py / r * (r - wall) * 1.4; }
    var response = floating ? 1.1 : 1.7;
    var k = 1 - Math.exp(-dt * response);
    var dvx = (wantX - seat.vx) * k, dvy = (wantY - seat.vy) * k;
    var change = Math.sqrt(dvx * dvx + dvy * dvy), limit = (floating ? 0.13 : 0.2) * dt;
    if (change > limit) { dvx *= limit / change; dvy *= limit / change; }
    seat.vx += dvx; seat.vy += dvy;
    seat.x += seat.vx * dt; seat.y += seat.vy * dt;
    /* The fixed outer wall is a final guard; ordinary travel turns before it. */
    px = seat.x - 0.5; py = seat.y - 0.5; r = Math.sqrt(px * px + py * py);
    if (r > WALL) {
      var nx = px / r, ny = py / r, dot = seat.vx * nx + seat.vy * ny;
      if (dot > 0) { seat.vx -= 1.8 * dot * nx; seat.vy -= 1.8 * dot * ny; seat.heading = seat.face = Math.atan2(seat.vy, seat.vx); seat.speed = Math.hypot(seat.vx, seat.vy); seat.bounced = t; seat.hit = seat.speed; }
      seat.x = 0.5 + nx * (WALL - 0.002); seat.y = 0.5 + ny * (WALL - 0.002); r = WALL - 0.002;
      seat.goal = null;
    }
    var v = Math.sqrt(seat.vx * seat.vx + seat.vy * seat.vy);
    seat.moving = Math.min(1, v / 0.14);
    seat.deg = ((Math.atan2(seat.x - 0.5, seat.y - 0.5) * 180 / Math.PI) % 360 + 360) % 360; seat.radius = r;
    var peak = seat.deg, start = ((peak - 115) % 360 + 360) % 360, shift = start - (peak - 115);
    palette.arc = { start: start, light: peak - 45 + shift, deep: peak - 8 + shift, end: peak + 40 + shift };
  }

  function measureQuiet() {
    if (!centre) return;
    var r = (canvas || ring).getBoundingClientRect(), c = centre.getBoundingClientRect();
    if (!r.width || !c.width) return;
    /* The clock block is wide and short; a box cut to it left a flat edge
       across the water. Taller and softer, so the dim behind the words is a
       gradient the body sinks into, not a line it stops at. */
    /* Owner: 'the blur box on the clock is still oversized' -- the box is the
       clock block itself, a touch of margin, no more. */
    quiet = [Math.min(0.46, c.width / r.width * 0.36), Math.min(0.46, c.height / r.height * 0.6)];
    quietAt = [
      (c.left + c.width / 2 - (r.left + r.width / 2)) / r.width,
      -(c.top + c.height / 2 - (r.top + r.height / 2)) / r.height
    ];
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
      '#ifdef LIVE',
      'uniform vec4 uEpi; uniform vec4 uPulse[2]; uniform vec2 uTwist[2]; uniform vec4 uPushX[3]; uniform vec2 uPushXW[3];',
      '#endif',
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
      '#ifdef LIVE',
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
      '#endif',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy + force * uDt;',
      '  gl_FragColor = vec4(velocity * (1.0 - solid(vUv)), 0.0, 1.0);',
      '}'
    ],
    /* The wall mirrors the normal velocity, so nothing crosses it. */
    divergence: [
      'uniform sampler2D uVelocity;',
      '#ifdef LIVE',
      'uniform vec4 uSink; uniform vec2 uReturn;',
      '#endif',
      'void main () {',
      '  vec2 C = texture2D(uVelocity, vUv).xy;',
      '  float L = mix(texture2D(uVelocity, vL).x, -C.x, solid(vL));',
      '  float R = mix(texture2D(uVelocity, vR).x, -C.x, solid(vR));',
      '  float T = mix(texture2D(uVelocity, vT).y, -C.y, solid(vT));',
      '  float B = mix(texture2D(uVelocity, vB).y, -C.y, solid(vB));',
      '  float div = 0.5 * (R - L + T - B);',
      '#ifdef LIVE',
      // Prescribed mid-plane divergence s (blowup episode): the projection then solves ∇²p = ∇·u* − s, so
      // ∇·u = s. s = −α e^(−r²/δs²) is the core's in-plane convergence (the paper's axial outflow seen at
      // z ≈ 0, ∂r ur + ur/r = −∂z uz); + C e^(−k²) is where fluid returns to the plane near the rim, sized so
      // ∫s = 0 as the closed circle requires. In grid units: subtract h·s.
      '  vec2 p = vUv - 0.5; float r = length(p), k = (r - uReturn.x) / uReturn.y;',
      '  div += uSink.w * (uSink.x * exp(-r * r / (uSink.y * uSink.y)) - uSink.z * exp(-k * k));',
      '#endif',
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
      'uniform float uDt; uniform float uKeep; uniform vec4 uEmit[4]; uniform vec3 uEmitAt[4]; uniform float uEmitSharp;',
      '#ifdef LIVE',
      'uniform vec4 uPulse[2]; uniform vec2 uTwist[2]; uniform vec4 uPulseDye; uniform vec4 uRingDye; uniform vec2 uRingAt;',
      '#endif',
      'void main () {',
      '  vec2 back = vUv - uDt * SAMPLE(uVelocity, vUv, uVelocityTexel).xy;',
      '  vec2 dye = SAMPLE(uDye, back, uDyeTexel).xy * uKeep;',
      '  for (int i = 0; i < 4; i++) { vec2 d = vUv - uEmitAt[i].xy; dye += exp(-dot(d, d) * uEmitSharp) * uEmit[i].xy * uDt; }',
      '#ifdef LIVE',
      // Light shed by the two ring pulses (one tint each: x is the light stop, y the deep stop) and a ring of
      // light near the rim (voice listening); the flow then shears and carries it like any other dye.
      '  vec2 p = vUv - 0.5; float r = length(p), theta = atan(p.y, p.x);',
      '  float s0 = (r - uPulse[0].x) / uPulse[0].y, s1 = (r - uPulse[1].x) / uPulse[1].y, k = (length(vUv - uRingAt) - uRingDye.x) / uRingDye.y;',
      '  dye += exp(-s0 * s0) * max(cos(uPulse[0].w * theta + uTwist[0].x * s0 + uTwist[0].y), 0.0) * uPulseDye.xy * uDt;',
      '  dye += exp(-s1 * s1) * max(cos(uPulse[1].w * theta + uTwist[1].x * s1 + uTwist[1].y), 0.0) * uPulseDye.zw * uDt;',
      '  dye += exp(-k * k) * uRingDye.zw * uDt;',
      '#endif',
      '  gl_FragColor = vec4(max(dye, 0.0), 0.0, 1.0);',
      '}'
    ],
    /* THE PICTURE (owner, 2026-09-15: "keep the math but I don't like the look of the Navier-Stokes", "too smoky",
       "from heavy water to storm mist for an action"). The same dye field is read two ways and blended by uStorm:
       WATER  the dye is a depth field. Its slope is a surface normal, lit from above left with a tight sheen and faint
              refraction lines where the depth crosses a level, darker where it is deep: a body of coloured water
              under glass, not smoke. This is the resting look.
       MIST   the same field read thin and wide, streaked along the flow (two taps back along the velocity) and lit by
              its own spin (the vorticity shading), the storm. Actions, spin-ups and blowup episodes raise uStorm;
              it settles back into water when they pass.
       Both keep the wall fade, the clear box behind the words and the dither. */
    display: [
      'uniform sampler2D uDye; uniform vec2 uDyeTexel;',
      'uniform vec3 uLight; uniform vec3 uDeep; uniform float uMaxAlpha; uniform float uCurve; uniform float uGlow;',
      'uniform vec2 uQuiet; uniform vec2 uQuietAt; uniform float uQuietFloor;',
      'uniform float uStorm; uniform vec3 uSheen; uniform float uRelief; uniform vec2 uFinish;',
      'uniform vec2 uSurface; // per-state sheen strength and diffuse softness',
      'uniform vec4 uOrbit; uniform vec2 uOrbitAt; // x phase 0..1, y strength, z reach, w width; the seat',
      'uniform vec4 uInk[13]; // continuous brush spine: position, width, pigment',
      'uniform vec2 uWriting; // continuous formation and unwrapped stroke phase',
      'uniform vec4 uBashRings; uniform vec4 uBashTurn; uniform vec4 uBashCore;',
      PLAYFUL_MOMENT_GLSL,
      '#ifdef LIVE',
      'uniform sampler2D uCurl; uniform vec2 uCurlTexel; uniform vec2 uVort; uniform vec3 uFast; uniform vec3 uSlow;',
      'uniform sampler2D uVelocity; uniform vec2 uVelocityTexel;',
      '#endif',
      // A blob has an edge: at rest the depth rises steeply past a threshold, so the water is a body with an outline;
      // as the storm rises the edge dissolves into the soft fluid law.
      'float writingDepth(float a) { return smoothstep(0.12, 1.35, a); }',
      BLOB_BODY_FINISH
        ? 'float depthOf (vec2 d) { float a = d.x + d.y; float body = mix(smoothstep(0.11 + 0.04 * uFinish.x, 0.58 - 0.04 * uFinish.x, a), 1.0 - exp(-1.6 * a), clamp(uStorm, 0.0, 1.0)); body = mix(body, writingDepth(a), clamp(uWriting.x, 0.0, 1.0)); return body; }'
        : 'float depthOf (vec2 d) { float a = d.x + d.y; float body = mix(smoothstep(0.08, 0.65, a), 1.0 - exp(-1.6 * a), clamp(uStorm, 0.0, 1.0)); body = mix(body, writingDepth(a), clamp(uWriting.x, 0.0, 1.0)); return body; }',
      /* Restore the accepted Blob orbit (52a9841b), before the later ring
         replacements. The original motion module supplies the breathing
         core, conserved band thickness, unwrapped turns and half-second rest.
         This is fluidForm's original tool field, in the seated body's space. */
      'float orbitBand (vec2 q, float r, float radius, float sigma, float turn, float count, float duty, float track) {',
      '  float s = (r - radius) / max(sigma, 0.0008);',
      '  float along = fract((atan(q.y, q.x) - turn) * count / 6.2831853);',
      '  float soft = min(0.24, duty * 0.5);',
      '  float arc = smoothstep(0.0, soft, along) * (1.0 - smoothstep(duty - soft, duty, along));',
      '  return exp(-s * s) * (track + (1.0 - track) * arc);',
      '}',
      'float orbitField (vec2 uv) {',
      '  if (uOrbit.y < 0.001) return 0.0;',
      '  vec2 p = (uv - uOrbitAt) / max(uOrbit.z, 0.01); float r = length(p), open = uBashTurn.w;',
      '  float c = cos(uBashTurn.z), s = sin(uBashTurn.z);',
      '  vec2 d = p - uBashCore.xy;',
      '  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / max(uBashCore.zw * 1.08, vec2(0.003));',
      '  float amount = exp(-dot(q, q));',
      '  if (open > 0.002 && r > 0.0005) {',
      '    amount += open * orbitBand(p, r, uBashRings.x, uBashRings.z * 1.12, uBashTurn.x, 4.0, 8.0 / 25.0, 0.5);',
      '    amount += open * 0.82 * orbitBand(p, r, uBashRings.y, uBashRings.w * 1.12, uBashTurn.y, 2.0, 12.0 / 31.4, 0.5);',
      '  }',
      '  return amount;',
      '}',
      // A single calligraphic stroke. Its leading drop pulls a tapered ribbon;
      // the sampled spine is continuous through the turn, without a phase reset.
      'float writingField(vec2 uv) {',
      '  if (uWriting.x < 0.001) return 0.0;',
      '  float opened = smoothstep(0.04, 0.94, uWriting.x);',
      '  vec2 p = (uv - uOrbitAt) / mix(0.32, 1.0, opened);',
      '  float ink = 0.0;',
      // Only the narrow stroke fits this bound. The wider forming/returning
      // body must still be evaluated outside it, or its edge becomes a box.
      '  if (abs(p.x) <= 0.23 && abs(p.y) <= 0.16) {',
      '   for (int i = 0; i < 12; i++) {',
      '    vec4 a = uInk[i], b = uInk[i + 1];',
      '    vec2 line = b.xy - a.xy;',
      '    float along = clamp(dot(p - a.xy, line) / max(dot(line, line), 0.000001), 0.0, 1.0);',
      '    vec2 q = (p - mix(a.xy, b.xy, along)) / mix(a.z, b.z, along);',
      '    ink = max(ink, exp(-dot(q, q)) * mix(a.w, b.w, along));',
      '   }',
      '  }',
      '  vec2 body = (uv - uOrbitAt) / 0.074;',
      '  return mix(exp(-dot(body, body)), ink, opened);',
      '}',
      'vec2 bodyDye(vec2 uv) {',
      // Gather the outgoing shape into the seated body; unfold the current
      // action on return. The zero-weight path is exactly the accepted base.
      '  vec2 sourceUv = uv;',
      '  if (uMoment.x > 0.0) sourceUv = uOrbitAt + (uv - uOrbitAt) / mix(1.0, 0.3, uMoment.x);',
      '  vec2 body = mix(max(SAMPLE(uDye, sourceUv, uDyeTexel).xy, 0.0), vec2(0.45, 0.55) * orbitField(sourceUv) * 4.0, clamp(uOrbit.y, 0.0, 1.0));',
      '  body = mix(body, vec2(0.48, 0.52) * writingField(sourceUv) * 2.3, clamp(uWriting.x, 0.0, 1.0));',
      '  if (uMoment.x > 0.0) body = mix(body, vec2(0.45, 0.55) * momentField(uv), uMoment.x);',
      '  return body;',
      '}',
      'void main () {',
      '  vec2 p = vUv - 0.5;',
      '  vec2 dye = bodyDye(vUv);',
      '  float amount = dye.x + dye.y, depth = depthOf(dye);',
      '  vec2 tx = vec2(uDyeTexel.x, 0.0), ty = vec2(0.0, uDyeTexel.y);',
      '  float hL = depthOf(bodyDye(vUv - tx)), hR = depthOf(bodyDye(vUv + tx));',
      '  float hB = depthOf(bodyDye(vUv - ty)), hT = depthOf(bodyDye(vUv + ty));',
      '  vec3 n = normalize(vec3((hL - hR) * uRelief, (hB - hT) * uRelief, 1.0));',
      '  vec3 l = normalize(vec3(-0.45, 0.65, 0.62)), h = normalize(l + vec3(0.0, 0.0, 1.0));',
      '  float finish = clamp(uFinish.x + 0.4 * uOrbit.y, 0.0, 1.0);',
      '  float ambient = mix(mix(0.72, 0.55, finish), 0.78, uSurface.y);',
      '  float shade = ambient + (1.0 - ambient) * max(dot(n, l), 0.0);',
      '  float sheen = pow(max(dot(n, h), 0.0), mix(mix(56.0, 34.0, finish), 24.0, uWriting.x)) * depth;',
      '  float lines = smoothstep(0.86, 1.0, 0.5 + 0.5 * sin(amount * 7.0)) * 0.15 * depth * (1.0 - clamp(uWriting.x, 0.0, 1.0)) * (1.0 - uMoment.x * (1.0 - uMomentBody.w));',
      '  vec3 colour = mix(uLight, uDeep, dye.y / (amount + 0.0001));',
      '  vec3 water = colour * shade * mix(1.0, 0.8, depth) + uSheen * uSurface.x * (mix(mix(1.3, 1.65, finish), 1.15, uWriting.x) * sheen + lines);',
      '  float aWater = uMaxAlpha * pow(depth, uCurve);',
      '  vec3 mistColour = mix(uLight, colour, 0.6);',
      // Thinking alone gets deeper pigment in the gathering folds of its cloud.
      '  vec3 cloudDepth = mix(uLight, uDeep, 0.18 + 0.5 * smoothstep(0.2, 3.0, amount));',
      '  mistColour = mix(mistColour, cloudDepth, 0.35 * uFinish.y);',
      '  float aMist = uMaxAlpha * 0.5 * pow(1.0 - exp(-0.9 * amount), 0.8);',
      '  float storm = clamp(uStorm, 0.0, 1.0);',
      '#ifdef LIVE',
      '  vec2 vel = SAMPLE(uVelocity, vUv, uVelocityTexel).xy;',
      '  vec2 s1 = max(SAMPLE(uDye, vUv - vel * 0.03, uDyeTexel).xy, 0.0), s2 = max(SAMPLE(uDye, vUv - vel * 0.06, uDyeTexel).xy, 0.0);',
      '  float streak = 1.0 - exp(-0.9 * (amount + s1.x + s1.y + s2.x + s2.y) / 3.0);',
      '  aMist = uMaxAlpha * 0.5 * pow(streak, 0.85);',
      '  float w = 1.0 - exp(-abs(SAMPLE(uCurl, vUv, uCurlTexel).x) * uVort.y);',
      '  mistColour = mix(mistColour, uFast, smoothstep(0.1, 0.85, w) * 0.5);',
      '#endif',
      '  aMist *= mix(1.0, smoothstep(0.025, 0.2, amount), uFinish.x);',
      '  colour = mix(water, mistColour, storm);',
      '  float a = mix(aWater, aMist, storm);',
      '  a *= 1.0 - smoothstep(0.47, 0.5, length(p));',
      '  vec2 q = abs((p - uQuietAt) / uQuiet); q *= q;',
      '  a *= mix(uQuietFloor, 1.0, smoothstep(0.95, 1.45, sqrt(sqrt(dot(q, q)))));',
      '#ifdef LIVE',
      '  float d = sqrt(sqrt(dot(q, q))), clear = mix(uQuietFloor, 1.0, smoothstep(1.0, 1.4, d));',
      '  a *= clear;',
      // The storm's own light: |vorticity| from the solve's curl field, deep stop when slow, light stop when fast,
      // as much as the storm allows (a little even at rest, so a spin-up is seen coming).
      '  float mask = (1.0 - smoothstep(0.47, 0.5, length(p))) * mix(uQuietFloor, 1.0, smoothstep(0.95, 1.45, d)) * clear;',
      '  float bodyMask = mix(1.0, smoothstep(0.015, 0.16, amount), clamp(uFinish.x + 0.85 * uFinish.y, 0.0, 1.0));',
      '  float va = uVort.x * uMaxAlpha * w * mask * max(storm, 0.35) * bodyMask, total = va + a * (1.0 - va);',
      '  colour = (mix(uSlow, uFast, smoothstep(0.1, 0.85, w)) * va + colour * a * (1.0 - va)) / max(total, 0.0001);',
      '  a = total;',
      '#endif',
      '  vec2 orbitUv = vUv;',
      '  if (uMoment.x > 0.0) orbitUv = uOrbitAt + (vUv - uOrbitAt) / mix(1.0, 0.3, uMoment.x);',
      '  a *= mix(1.0, 0.5 + 0.5 * smoothstep(0.45, 0.95, orbitField(orbitUv)), uOrbit.y);', // the original continuous track stays visible beneath brighter moving material
      '  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;',
      '  a = clamp(a + grain / 255.0, 0.0, 1.0);',
      '  gl_FragColor = vec4(colour * a, a * uGlow);',
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
    // The recovered orbit has fine material bands. Resolve them at the face's
    // screen size without increasing the simulation grid or its tick rate.
    var size = Math.max(64, Math.min(Math.round(width * ratio), LADDER[level].dye * (/^(running|writing)$/.test(agent.action) ? 4 : 2)));
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    measureQuiet();
  }

  /* ------------------------------------------------------------ forcing */

  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  var push = new Float32Array(12), emit = new Float32Array(16), emitAt = new Float32Array(12);
  var writingInk = new Float32Array(13 * 4);
  function inkStroke(time) {
    // Analytic position and tangent have no resets. The tail follows the actual
    // previous path, so a turn folds the ink instead of dragging a rigid shape.
    for (var i = 0; i < 13; i++) {
      var trail = i / 12, phase = time * ANIMATION_PACE.writingWave - trail * 2.05;
      writingInk[i * 4] = 0.142 * Math.sin(phase);
      writingInk[i * 4 + 1] = 0.052 * Math.sin(2 * phase + 0.3) + 0.010 * Math.sin(3 * phase - 0.5);
      writingInk[i * 4 + 2] = 0.005 + 0.030 * Math.pow(1 - trail, 0.72);
      writingInk[i * 4 + 3] = (1 - smooth(0.65, 1, trail)) * (0.92 + 0.08 * Math.cos(phase));
    }
  }

  function plan(time, fluidStorm) {
    var t = clock, x = seat.x, y = seat.y, rr = Math.sqrt((x - 0.5) * (x - 0.5) + (y - 0.5) * (y - 0.5)) || 1;
    var sn = (x - 0.5) / rr, cs = (y - 0.5) / rr;
    /* THE BLOB'S COHESION: the seat pulls the water toward itself (an inward push; the projection keeps the flow
       divergence-free, so the water gathers and holds instead of streaming), and the storm loosens that grip. The
       second source slot is unused: one body of water. */
    var splitting = persona.split && t - persona.split.t < persona.split.span ? Math.sin(Math.PI * Math.min(1, (t - persona.split.t) / persona.split.span)) : 0;
    splitting *= 1 - momentPose.weight;
    var hold = bodyWeights.push * drive.sources * (1 - 0.6 * fluidStorm) * (1 + 1.5 * seat.moving) * (1 - 0.85 * splitting);
    push[0] = x; push[1] = y; push[2] = -sn * hold; push[3] = -cs * hold;
    var rb = reformBump() * (1 - momentPose.weight);
    var amount = bodyWeights.dye * drive.sources * (0.85 + 0.15 * Math.sin(0.43 * t)) * (1 - 0.6 * rb);
    if (rb > 0) { drive.decay *= 1 + 1.2 * rb; push[2] *= 1 - rb; push[3] *= 1 - rb; }
    emitAt[0] = x; emitAt[1] = y; emit[0] = amount * TUNE.lightShare; emit[1] = amount * (1 - TUNE.lightShare);
    /* TRAVEL: while the seat moves, the water is dragged after it -- a wide push from where the blob was toward where
       the seat is going (the second source slot, emitting nothing) -- so the blob moves as a body instead of fading
       here and growing there. The push falloff is widened for the same reason (uPushSharp, in step). */
    emit[4] = emit[5] = 0;
    if (seat.moving > 0.05) {
      var dn = Math.sqrt(seat.vx * seat.vx + seat.vy * seat.vy) || 1, drag = 0.7 * Math.min(1, seat.moving) * drive.sources;
      push[4] = x - seat.vx / dn * 0.06; push[5] = y - seat.vy / dn * 0.06; push[6] = seat.vx / dn * drag; push[7] = seat.vy / dn * drag;
    } else { push[4] = push[5] = -9; push[6] = push[7] = 0; }
    emitAt[3] = emitAt[4] = -9;
    var k = 8, splash = extrasOn && persona.splash && clock - persona.splash.t < 0.6 ? persona.splash : null;
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
    // Keep one seated reservoir underneath the stroke. It can gather back into
    // the blob on exit without leaving four detached sources behind.
    emitAt[9] = emitAt[10] = -9; emit[12] = emit[13] = 0;
    seat.writingW = bodyFinish.writing;
    if (seat.writingW > 0) {
      push[2] *= 1 - 0.6 * seat.writingW * (1 - momentPose.weight); push[3] *= 1 - 0.6 * seat.writingW * (1 - momentPose.weight);
      inkStroke(t);
    }
  }

  /* ------------------------------------------------------------ v2 extras: personality, blowup, voice */

  /* Kill switch: home.js names the extras the circle may use (ring.dataset.fluidExtras = 'personality blowup voice').
     Without a word the extra is off; without the attribute, or once the ladder drops its first rung, this is the plain
     fluid (base shader programs, base forcing); without data-fluid="on" nothing mounts at all. */
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
    first: [20, 40], every: [110, 170], collapse: 6.5, relax: 2.2,
    L0: 0.26, cells: 3, strain: 0.28, sinkScale: 1.6, returnR: 0.43, returnW: 0.045,
    torque: 0.32, torqueR: 0.33, torqueW: 0.09, decay: 0.2,
    pulse: 0.05, pulseDye: 0.2, edge: 1.9, width: 0.16, curlGain: 0.12, shade: 0.65
  };
  var episode = null, played = 0, sinceEpisode = 0;
  /* No unprompted episodes: motion needs a reason. A double-click or the voice word "blowup" starts one. */
  var nextEpisode = Infinity;
  var persona = { eddy: 200, eddyDir: -1, lazyUntil: 0, lazyNext: 45 + Math.random() * 40, splash: null, lean: null, flare: null,
    split: null, turn: null, burstNext: 0, fidgetAt: 0, fidget: null };
  var voice = { state: extras.voice ? 'idle' : 'off', level: 0, pitch: 0.5, flourish: null, handback: -99, spoke: -99,
    stream: null, context: null, analyser: null, wave: null, freq: null, recognizer: null, ui: null };

  var drive = {
    ambient: 1, swirl: 1, sources: 1, decay: 1, inkDecay: 1, curlScale: 1, torque: 0, torqueR: 0.33, torqueW: 0.09,
    pulse: new Float32Array(8), twist: new Float32Array(4), pulseDye: new Float32Array(4),
    pushX: new Float32Array(12), pushXW: new Float32Array(6),
    sink: new Float32Array(4), ret: new Float32Array(2), ringDye: new Float32Array(4), vort: new Float32Array(2)
  };

  function noise(t, k) {
    return (Math.sin(t * 0.071 * k + seed) + 0.6 * Math.sin(t * 0.0439 * k + seed * 1.7) + 0.4 * Math.sin(t * 0.0263 * k + seed * 2.3)) / 2;
  }

  function neutral() {
    drive.ambient = drive.swirl = drive.sources = drive.decay = 1; drive.torque = 0; drive.torqueR = 0.33; drive.torqueW = 0.09;
    drive.inkDecay = drive.curlScale = 1;
    drive.pulse.fill(0); drive.pulse[0] = drive.pulse[4] = -1; drive.pulse[1] = drive.pulse[5] = 0.05;
    drive.twist.fill(0); drive.pulseDye.fill(0); drive.pushX.fill(0); drive.pushXW.fill(0);
    for (var i = 0; i < 3; i++) { drive.pushX[i * 4] = drive.pushX[i * 4 + 1] = -9; drive.pushXW[i * 2] = 100; }
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

  /* PERSONALITY: how the forcing is driven, never an overlay, and never a new GPU pass: everything here is a few
     scalars per step feeding uniforms the solve already takes.
     THE CHARACTER IS A BLOB (owner, 2026-09-15). At rest it sits at its seat and breathes -- swelling and settling on
     a slow breath -- and that is all it does on its own, apart from a rare playful hop to another seat. It does not
     orbit, it does not spin up, and nothing pulses in rings. Everything else it does has a reason: what the followed
     agent is doing (agentDrive), a hop to another agent, the person's pointer resting near or a tap. When it moves it
     turns into fluid, and for the sharper reasons into storm mist (stormDrive); then it gathers itself again.
     MOODS colour the rest: how deep the breath, how much light, how often a playful hop. They change on their own
     every 25-70 s, never repeat back to back, and two are earned rather than drawn -- attentive while the followed
     agent is working, sleepy after two quiet minutes with nobody near. Every value is blended toward over a couple of
     seconds, so a mood arrives like weather, not a switch.
     MOMENTS are one-off gestures: a bloom of light when the circle wakes, a burst and a settle when the agent's turn
     finishes, a small fidget every few seconds while it waits on the person. */
  var MOODS = {
    calm:      { eddy: 0.6, light: 0.9,  burstEvery: [6, 12],  pace: 0.05 },
    curious:   { eddy: 1.2, light: 1.05, burstEvery: [4, 8],   pace: 0.09 },
    playful:   { eddy: 1.6, light: 1.15, burstEvery: [2, 5],   pace: 0.14 },
    sleepy:    { eddy: 0.3, light: 0.7,  burstEvery: [14, 26], pace: 0.025 },
    attentive: { eddy: 0.9, light: 1.1,  burstEvery: [4, 9],   pace: 0.08 }
  };
  var mood = { name: 'curious', since: 0, next: 30 + Math.random() * 30, blend: null, quietSince: 0, lastNear: -99 };
  var moment = { wake: -99, finished: -99 };
  /* A TURN: the water goes round -- right or left -- for a while, on a torque ring at the seat's radius, and the blob
     rides it. Used by the actions and, rarely, by a playful mood as a stretch. Never continuous. */
  function turn(dir, span, strength) { persona.turn = { t: clock, dir: dir, span: span || 2.4, strength: strength || 0.4 }; }
  function turnDrive(t, dt) {
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
    var names = busy ? (Math.random() < 0.6 ? ['attentive'] : ['curious', 'attentive'])
      : quiet ? ['sleepy', 'calm'] : ['calm', 'calm', 'curious', 'curious', 'playful'];
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
    var t = clock, m = moodDrive(dt);
    /* Breathing: the blob swells and settles on a slow breath; the mood sets its depth and the light. */
    var breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / (10 + 2 * noise(t, 1)));
    drive.sources *= (0.8 + 0.4 * breath * (0.6 + 0.4 * m.eddy)) * m.light;
    if (!persona.lazyUntil && t > persona.lazyNext) persona.lazyUntil = t + 6 + 3 * Math.random();
    if (persona.lazyUntil) {
      var rest = smooth(persona.lazyUntil - 9, persona.lazyUntil - 7, t) * (1 - smooth(persona.lazyUntil - 1.5, persona.lazyUntil, t));
      drive.sources *= 1 - 0.5 * rest; drive.decay *= 1 + 0.8 * rest;
      if (t > persona.lazyUntil) { persona.lazyUntil = 0; persona.lazyNext = t + 50 + 40 * Math.random(); }
    }
    /* Curiosity: a pointer resting near the circle draws the seat a little toward it, and the blob leans. */
    if (pointer && performance.now() - pointer.t < 1500) {
      mood.lastNear = t;
      var want = Math.atan2(pointer.x - 0.5, pointer.y - 0.5) * 180 / Math.PI, delta = ((want - seat.deg + 540) % 360) - 180;
      if (!seat.moving) moveSeat(seat.deg + Math.max(-25, Math.min(25, delta)) * 0.4);
    }
    /* The inner eddy exists only while the water is fluid: its spin is the storm's. */
    var e = persona.eddy * Math.PI / 180;
    persona.eddy = ((persona.eddy + persona.eddyDir * 8 * storm.level * dt) % 360 + 360) % 360;
    pushX(0, 0.5 + 0.3 * Math.sin(e), 0.5 + 0.3 * Math.cos(e), 0, 0, 900, -persona.eddyDir * 1.6 * storm.level);
    /* Ambient travel is continuous. Deliberate bursts and shears belong to actions. */
    var action = ring.dataset.agentAction || 'idle';
    seat.pace = (0.052 + 0.008 * noise(t, 4)) * (0.7 + 0.3 * m.pace / 0.09) * (action === 'waiting' ? 0.7 : 1);
    if (seat.bounced === t || (seat.bounced > t - dt && seat.bounced <= t)) {
      reform(0.8);
      if ((seat.hit || 0) > 0.12) split(0.6 + 4 * seat.hit, 1, 0);
    }
    splitDrive(t); turnDrive(t, dt);
    var fl = persona.flare && t - persona.flare.t < 0.9 ? persona.flare.strength * (1 - (t - persona.flare.t) / 0.9) : 0;
    drive.sources *= 1 + 1.1 * fl;
    /* Moments. */
    var wake = 1 - smooth(0, 2.6, t - moment.wake), done = 1 - smooth(0, 2.2, t - moment.finished);
    if (wake > 0) drive.sources *= 1 + 1.2 * wake;
    else if (done > 0) { drive.sources *= 1 + 0.5 * done; drive.decay *= 1 + 1.5 * done; }
    var sp = persona.splash;
    if (sp && t - sp.t < 0.6) {
      var fade = (1 - (t - sp.t) / 0.6) * (sp.strength || 9), px = sp.y - 0.5, py = 0.5 - sp.x;
      var n = Math.sqrt(px * px + py * py) || 1;
      pushX(1, sp.x + 0.025 * px / n, sp.y + 0.025 * py / n, 0, 0, 2400, fade);
      pushX(2, sp.x - 0.025 * px / n, sp.y - 0.025 * py / n, 0, 0, 2400, -fade);
    } else if (persona.lean && t - persona.lean.t < 1.2) {
      var lx = persona.lean.x - 0.5, ly = persona.lean.y - 0.5, lr = Math.sqrt(lx * lx + ly * ly) || 1;
      pushX(1, 0.5 + 0.6 * lx, 0.5 + 0.6 * ly, 0.12 * lx / lr, 0.12 * ly / lr, 30, 0);
    } else if ((ring.dataset.agentAction || '') === 'waiting') {
      /* Fidgets while waiting on the person: a small nudge from a random side every few seconds. */
      if (t > persona.fidgetAt) { var fa = Math.random() * Math.PI * 2; persona.fidget = { x: 0.5 + 0.3 * Math.sin(fa), y: 0.5 + 0.3 * Math.cos(fa), t: t, spin: Math.random() < 0.5 ? 3 : -3 }; persona.fidgetAt = t + 3 + Math.random() * 2.5; }
      var fg = persona.fidget;
      if (fg && t - fg.t < 0.5) pushX(1, fg.x, fg.y, 0, 0, 1600, fg.spin * (1 - (t - fg.t) / 0.5));
    }
  }

  /* Follow the agent attributes written by home.js, easing each change of manner.
     Thinking restores the accepted shear/turn/cloud cycle with its own material.
     Writing opens into four rounded fluid pieces with a slow traveling wave.
     Running uses the accepted counter-rotating orbit and half-second rest.
     Reading and waiting retain their quieter gestures; idle follows ambient drift. */
  var ACTION_EASE = 1.2;
  var agent = { action: 'idle', since: -9, name: '', event: '', kick: -9, kicks: 0 };
  /* RE-FORM (owner, 2026-09-20: 'avoid flash animation frames. instead
     deconstitute and reconstitute the character'): where a splash used to
     land in one frame, the body now lets its water go over a third of a
     second and lays it down again over the rest -- plan() scales the sources
     by the bump and step() raises the decay through the first half. */
  function reform(span) { persona.reform = { t: clock, span: span || 1.1 }; }
  function reformBump() {
    var r = persona.reform; if (!r) return 0;
    var u = (clock - r.t) / r.span; if (u >= 1) { persona.reform = null; return 0; }
    return u < 0.3 ? u / 0.3 : 1 - (u - 0.3) / 0.7;
  }
  function burst(strength, radius) {
    var at = arcPoint(radius || seat.radius);
    persona.splash = { x: at.x + (Math.random() - 0.5) * 0.06, y: at.y + (Math.random() - 0.5) * 0.06, t: clock, strength: strength };
    persona.flare = { t: clock, strength: strength / 9 };
  }
  /* SPLIT: a shear across the seat -- two wide pushes either side of the blob, driven opposite ways -- tears it into
     two bodies that drift apart while the hold is loosened, and the hold gathers them back into one when it ends.
     `turn` gives the pair a rotation too (both pushes the same way round the seat), so a split can also be a twirl,
     right or left. */
  function split(strength, span, turn) { persona.split = { t: clock, strength: strength, span: span || 1.4, turn: turn || 0 }; }
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
  function gather(alpha, reach) {
    var h = 1 / LADDER[level].sim, returnR = 0.43, returnW = 0.045;
    var inSink = Math.PI * reach * reach * (1 - Math.exp(-Math.pow(0.49 / reach, 2)));
    var inReturn = 2 * Math.PI * returnR * returnW * Math.sqrt(Math.PI);
    drive.sink[0] = alpha; drive.sink[1] = reach; drive.sink[2] = alpha * inSink / inReturn; drive.sink[3] = h;
    drive.ret[0] = returnR; drive.ret[1] = returnW;
  }
  /* Action material and gestures remain independent of the body's travel. */
  function agentDrive(dt) {
    var action = ring.dataset.agentAction || 'idle', name = ring.dataset.agentName || '', event = ring.dataset.agentEvent || '';
    var t = clock;
    /* TRANSPORT (owner, 2026-09-19: 'much smaller and localized and then have
       it like transport the blob and when it gets there it can do the reverse
       animation for it appearing'): on a journey the sources fall silent and
       the old body decays fast, so the water that reaches the goal is what
       the flow carried; on arrival a burst lays the body down again. */
    var gd = 0;
    if (seat.goal) { var ggx = seat.goal.x - seat.x, ggy = seat.goal.y - seat.y; gd = Math.sqrt(ggx * ggx + ggy * ggy); }
    var travelling = seat.goal && gd > 0.05 ? 1 : 0;
    seat.trav = (seat.trav || 0) + (travelling - (seat.trav || 0)) * (1 - Math.exp(-7 * dt));
    if (seat.trav > 0.02) { drive.sources *= 1 - 0.55 * seat.trav; drive.decay *= 1 + 0.8 * seat.trav; } // a journey thins the body, it does not empty it
    if (seat.wasTravelling && !travelling) reform(0.9);
    seat.wasTravelling = travelling;
    if (action !== agent.action) {
      if (/^(thinking|reading|writing|running)$/.test(agent.action) && action === 'idle') { moment.finished = t; reform(1.2); }
      agent.action = action; agent.since = t; agent.stormCycle = -1;
      persona.turn = persona.split = persona.splash = persona.flare = persona.reform = null;
      if (action === 'writing') seat.goal = null;
      sizeCanvas();
    }
    if (name !== agent.name) {
      if (agent.name && T) { moveSeat(seat.deg + 90 + Math.random() * 180, 0.14 + Math.random() * 0.22); reform(1.3); }
      agent.name = name; agent.event = event;
    }
    var w = smooth(agent.since, agent.since + ACTION_EASE, t);
    if (event !== agent.event) {
      agent.event = event;
      if (w > 0 && action === 'reading') {
        /* A look: the seat jumps to the next thing and the blob twirls on the spot as it goes, the other way each time. */
        moveSeat(seat.deg + (Math.random() < 0.7 ? 1 : -1) * (35 + Math.random() * 40), 0.12 + Math.random() * 0.26);
        agent.kick = t; agent.kicks++; persona.flare = { t: t, strength: 0.6 };
        agent.twirl = -(agent.twirl || 1); split(0.25, 1, agent.twirl);
      } else if (w > 0 && action === 'writing') { agent.kick = t; }
      else if (w > 0 && action === 'running' && T) {
        /* A kick: the blob is knocked apart and the water goes round, right or left, lit, then gathers. */
        agent.kick = t; agent.kicks++; // the rings carry the action
      }
    }
    if (action !== 'running') { orbit[1] *= Math.exp(-4 * dt); orbit[2] *= Math.exp(-3 * dt); }
    if (w <= 0 || action === 'idle') return;
    var beat, kick = 1 - smooth(0, 0.8, t - agent.kick);
    if (action === 'thinking') {
      // Accepted 97e1364e: 30-second cloud, 6.5-second surges, half-second reset.
      // Recover its source budget, draw-in, shear and alternating torque beats.
      thinkingMotion = { ...actionMotion('thinking', t - agent.since), light: 4.5 };
      var thought = thinkingMotion, surge = thought.surge, original = thought.original;
      seat.pace += (thought.pace - seat.pace) * w;
      drive.sources = 1 + (thought.light - 1) * w;
      drive.inkDecay = 1 + ((thought.decay + (1 - thought.decay) * original) * 0.62 - 1) * w;
      drive.decay = 1 + ((thought.drag + (1 - thought.drag) * original) - 1) * w;
      drive.curlScale = 1 + 0.45 * original * w;
      gather(0.055 * w * (0.25 + 0.75 * (1 - surge)), 0.3);
      drive.torque += 0.07 * w * Math.sin(t * 2 * Math.PI / 4.8);
      drive.torqueR = seat.radius; drive.torqueW = 0.12;
      if (thought.beat !== agent.stormCycle && original > 0) {
        agent.stormCycle = thought.beat;
        burst(9, seat.radius); agent.kick = t;
        split(1.2, 1.3, 0); turn(thought.beat % 2 ? -1 : 1, 1.8, 0.5);
      }
      if (original > 0) {
        splitDrive(t); turnDrive(t, dt);
        drive.vort[0] = Math.max(drive.vort[0], (0.12 + 0.3 * surge) * original);
        drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim;
      }
      drive.sources *= 1 + 0.12 * (1 - smooth(0, 0.35, t - agent.kick));
    } else if (action === 'reading') {
      drive.sources *= 1 + (0.1 + 0.6 * kick) * w;
    } else if (action === 'writing') {
      // A quiet reservoir supports the ink stroke without a second smoky trail.
      drive.swirl *= 1 - 0.9 * w; drive.torque *= 1 - 0.9 * w; drive.vort[0] *= 1 - w;
      // Form in place, carry the previous momentum, then coast quietly.
      seat.pace += (ANIMATION_PACE.writingTravel - seat.pace) * w;
      seat.goal = null;
    } else if (action === 'running') {
      drive.swirl *= 1 + 0.3 * w;
      drive.vort[0] = Math.max(drive.vort[0], 0.12 * w); drive.vort[1] = BLOWUP.curlGain * LADDER[level].sim;
      bashMotion = actionMotion('running', t - agent.since, 'Bash');
      updateBlobParts(bashParts, bashMotion, t - agent.since, dt);
      seat.pace += (bashMotion.pace - seat.pace) * w;
      orbit[0] = t - agent.since; orbit[1] = w; orbit[2] = bashMotion.size;
    } else if (action === 'waiting') {
      beat = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3);
      drive.torque *= 1 - w; // waiting no longer thins the body (it sat at half strength and read as gone)
      drive.ringDye[0] = 0.14; drive.ringDye[1] = 0.02; drive.ringDye[2] = 0.08 * w * beat; drive.ringDye[3] = 0.04 * w * beat;
    }
  }

  /* Storm blends heavy water toward mist. Thinking supplies its historical cloud
     envelope; writing and orbit keep their clear material independently. */
  var storm = { level: 0 };
  // Material changes settle independently of the fluid and action timing.
  var bodyFinish = { base: 1, thinking: 0, writing: 0 };
  var thinkingMotion = null;
  var orbit = [0, 0, 0.82, 0]; // seconds, strength, original body-local scale, unused
  var bashParts = createBlobParts(), bashMotion = null;
  function stormDrive(dt) {
    if (agent.action === 'thinking' && thinkingMotion && !episode && voice.state !== 'on') {
      storm.level += (thinkingMotion.storm - storm.level) * (1 - Math.exp(-5 * dt));
      return;
    }
    var t = clock, action = extrasOn ? (ring.dataset.agentAction || 'idle') : 'idle';
    var base = action === 'running' ? 0.12 : action === 'writing' ? 0.05 : action === 'reading' ? 0.2 : action === 'thinking' ? 0.1 : 0; // running: the body stays a body so its rings read
    var kick = extrasOn ? 1 - smooth(0, 0.8, t - agent.kick) : 0;
    var fl = persona.flare ? 1 - smooth(0, 0.9, t - persona.flare.t) : 0;
    var tn = persona.turn, turning = tn && t - tn.t < tn.span ? 1 : 0, sp = persona.split, splitting = sp && t - sp.t < sp.span ? 1 : 0;
    var target = Math.max(base, (action === 'running' ? 0.3 : action === 'writing' ? 0.15 : 0.6) * kick, 0.45 * fl, 0.5 * seat.moving, 0.7 * turning, 0.5 * splitting, episode ? (episode.phase === 'collapse' ? 1 : 0.5) : 0, voice.state === 'on' ? 0.5 : 0);
    target = Math.max(target, 0.03); // a trace of mist at rest, so the water is never a solid paint
    storm.level += (target - storm.level) * Math.min(1, dt / (target > storm.level ? 0.8 : 2.4));
  }

  function blowupAllowed() { return extrasOn && extras.blowup && !dead; }

  function startEpisode(reason) {
    if (!blowupAllowed() || episode || !T) return false;
    episode = { t: 0, reason: reason, rest: true };
    played++; sinceEpisode = 0;
    return true;
  }

  /* The episode's body force and prescribed divergence at the current step (see BLOWUP above). */
  function blowup(dt) {
    var b = BLOWUP, ep = episode, h = 1 / LADDER[level].sim;
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
        fam ? 0 : b.pulseDye * env, fam ? b.pulseDye * env : 0);
    }
    drive.vort[0] = b.shade * smooth(0, 0.8, ep.t) * (1 - back); drive.vort[1] = b.curlGain * LADDER[level].sim;
    if (ep.t >= b.collapse + b.relax) { episode = null; nextEpisode = BLOWUP.every[0] + Math.random() * (BLOWUP.every[1] - BLOWUP.every[0]); }
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
    extrasOn = false; episode = null;
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
    if (!extrasOn || !extras.personality) return;
    var at = uvOf(event);
    if (at) persona.splash = { x: at.x, y: at.y, t: clock };
  }

  function doubleTap(event) {
    if (!extrasOn || !uvOf(event) || !(window.matchMedia && window.matchMedia('(pointer: fine)').matches)) return;
    startEpisode('double-click');
  }

  function direct(dt) {
    neutral();
    if (!extrasOn) return;
    if (extras.personality && voice.state !== 'on' && !episode) {
      if ((ring.dataset.agentAction || 'idle') !== 'thinking') personality(dt);
      agentDrive(dt);
    }
    if (voice.state === 'on' || clock - voice.handback < 1.5) voiceDrive();
    if (extras.blowup && !episode && voice.state !== 'on' && !momentPose.active) {
      sinceEpisode += dt;
      if (sinceEpisode >= nextEpisode) startEpisode('auto');
    }
    if (episode) blowup(dt);
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
    var q = LADDER[level], u, live = extrasOn && !!P.forcesL;
    if (paletteDirty) readPalette();
    clock += dt;
    if (extrasOn && extras.voice) listen();
    direct(dt);
    var finishEase = 1 - Math.exp(-dt / 0.55), finishAction = agent.action;
    bodyFinish.base += ((/^(idle|reading|waiting|writing)$/.test(finishAction) ? 1 : 0) - bodyFinish.base) * finishEase;
    bodyFinish.thinking += ((finishAction === 'thinking' ? 1 : 0) - bodyFinish.thinking) * finishEase;
    bodyFinish.writing += ((finishAction === 'writing' ? 1 : 0) - bodyFinish.writing) * (1 - Math.exp(-dt / (finishAction === 'writing' ? 0.75 : 0.45)));
    blendStateWeights();
    stormDrive(dt);
    /* The episode starts from rest, as the paper's flow does: u(·, 0) = 0. */
    if (live && episode && episode.rest) { clearPair(T.velocity); clearPair(T.pressure); episode.rest = false; }
    momentPose = playfulMoment.step(dt, { seat: seat, enabled: momentsEnabled,
      eligible: extrasOn && extras.personality && voice.state !== 'on' && !episode });
    // During the vignette, grow the same fluid as base underneath its poses.
    // Action clocks keep advancing, but their forcing does not change its skin.
    if (momentPose.weight > 0) {
      var mw = momentPose.weight, keepAction = 1 - mw;
      Object.keys(bodyWeights).forEach(function (key) { bodyWeights[key] += (STATE_WEIGHTS.base[key] - bodyWeights[key]) * mw; });
      ['ambient', 'swirl', 'sources', 'decay', 'inkDecay', 'curlScale'].forEach(function (key) { drive[key] += (1 - drive[key]) * mw; });
      drive.torque *= keepAction; drive.vort[0] *= keepAction;
      drive.pulse[2] *= keepAction; drive.pulse[6] *= keepAction;
      drive.pulseDye.forEach(function (value, i) { drive.pulseDye[i] = value * keepAction; });
      drive.ringDye[2] *= keepAction; drive.ringDye[3] *= keepAction;
      drive.sink[0] *= keepAction; drive.sink[2] *= keepAction;
      for (var mi = 0; mi < 3; mi++) {
        drive.pushX[mi * 4 + 2] *= keepAction; drive.pushX[mi * 4 + 3] *= keepAction;
        drive.pushXW[mi * 2 + 1] *= keepAction;
      }
    }
    var fluidStorm = storm.level * (1 - momentPose.weight) + 0.03 * momentPose.weight;
    if (momentPose.ownsSeat) {
      seat.x = momentPose.x; seat.y = momentPose.y; seat.vx = momentPose.vx; seat.vy = momentPose.vy;
      seat.goal = null; seat.speed = Math.hypot(seat.vx, seat.vy); seat.steerAt = clock + 3;
      if (seat.speed > 0.001) seat.heading = seat.face = Math.atan2(seat.vy, seat.vx);
      seat.moving = Math.min(1, seat.speed / 0.14);
      seat.deg = ((Math.atan2(seat.x - 0.5, seat.y - 0.5) * 180 / Math.PI) % 360 + 360) % 360;
      seat.radius = Math.hypot(seat.x - 0.5, seat.y - 0.5);
      var momentStart = ((seat.deg - 115) % 360 + 360) % 360, momentShift = momentStart - (seat.deg - 115);
      palette.arc = { start: momentStart, light: seat.deg - 45 + momentShift, deep: seat.deg - 8 + momentShift, end: seat.deg + 40 + momentShift };
    } else {
      seatDrive(dt);
      if (momentPose.active) { momentPose.x = seat.x; momentPose.y = seat.y; }
    }
    plan(time, fluidStorm);
    gl.disable(gl.BLEND);

    u = use(P.curl, T.curl);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    draw(T.curl);

    u = use(live ? P.forcesL : P.forces, T.velocity.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uCurl, bind(1, T.curl));
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uCurlStrength, bodyWeights.curl * drive.curlScale * (1 + 1.2 * fluidStorm));
    gl.uniform1f(u.uSwirl, (TUNE.swirl + 0.03 * fluidStorm) * drive.swirl);
    gl.uniform4fv(u.uPush, push);
    gl.uniform1f(u.uPushSharp, bodyWeights.pushSharp * (1 - 0.7 * Math.min(1, seat.moving)));
    if (live) {
      gl.uniform4f(u.uEpi, drive.ambient, drive.torque, drive.torqueR, drive.torqueW);
      gl.uniform4fv(u.uPulse, drive.pulse); gl.uniform2fv(u.uTwist, drive.twist);
      gl.uniform4fv(u.uPushX, drive.pushX); gl.uniform2fv(u.uPushXW, drive.pushXW);
    }
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(live ? P.divergenceL : P.divergence, T.divergence);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    if (live) { gl.uniform4fv(u.uSink, drive.sink); gl.uniform2fv(u.uReturn, drive.ret); }
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
    gl.uniform1f(u.uKeep, 1 / (1 + bodyWeights.velocityDecay * (1 - 0.68 * fluidStorm) * drive.decay * dt));
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(live ? P.dyeL : P.dye, T.dye.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uDye, bind(1, T.dye.read));
    gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uKeep, 1 / (1 + bodyWeights.dyeDecay * drive.inkDecay * dt));
    gl.uniform4fv(u.uEmit, emit);
    gl.uniform3fv(u.uEmitAt, emitAt);
    gl.uniform1f(u.uEmitSharp, bodyWeights.dyeSharp);
    if (live) {
      gl.uniform4fv(u.uPulse, drive.pulse); gl.uniform2fv(u.uTwist, drive.twist);
      gl.uniform4fv(u.uPulseDye, drive.pulseDye); gl.uniform4fv(u.uRingDye, drive.ringDye); gl.uniform2f(u.uRingAt, seat.x, seat.y);
    }
    draw(T.dye.write);
    T.dye.swap();

    u = use(live ? P.displayL : P.display, null);
    gl.uniform1i(u.uDye, bind(0, T.dye.read));
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    var momentWeight = momentPose.weight, ordinary = 1 - momentWeight;
    function momentMaterial(key) { return bodyWeights[key] * ordinary + MOMENT_MATERIAL[key] * momentWeight; }
    gl.uniform4f(u.uMoment, momentWeight, momentPose.age, momentPose.neck, momentPose.collapse);
    gl.uniform2f(u.uMomentFlow, BLOWUP.edge, BLOWUP.width);
    gl.uniform4f(u.uMomentBody, momentPose.x, momentPose.y, momentPose.scale, momentPose.together);
    gl.uniform4f(u.uMomentGaze, momentPose.gazeX, momentPose.gazeY, momentPose.leanX, momentPose.leanY);
    gl.uniform2f(u.uMomentFace, momentPose.blink, momentPose.stretch);
    gl.uniform3f(u.uMomentPiece, momentPose.pieceX, momentPose.pieceY, momentPose.pieceRadius);
    gl.uniform2f(u.uMomentDrift, seat.vx, seat.vy);
    var actionColour = Math.min(1, bodyFinish.writing + bodyFinish.thinking + orbit[1]) * ordinary;
    gl.uniform3fv(u.uLight, mixed(mixed(palette.light, palette.actionLight, actionColour), palette.orbitLight, orbit[1] * ordinary));
    gl.uniform3fv(u.uDeep, mixed(mixed(palette.deep, palette.actionDeep, actionColour), palette.orbitDeep, orbit[1] * ordinary));
    gl.uniform1f(u.uMaxAlpha, Math.min(palette.dark ? 0.88 : 0.94, momentMaterial('maxAlpha') * palette.intensity));
    gl.uniform1f(u.uCurve, momentMaterial('curve'));
    gl.uniform2f(u.uFinish, bodyFinish.base * ordinary + momentWeight, bodyFinish.thinking * ordinary);
    gl.uniform1f(u.uGlow, palette.dark ? TUNE.darkGlow : 1);
    gl.uniform2fv(u.uQuiet, quiet);
    gl.uniform4f(u.uOrbit, orbit[0], orbit[1] * ordinary, orbit[2], orbit[3]); gl.uniform2f(u.uOrbitAt, seat.x, seat.y);
    gl.uniform4fv(u.uBashRings, bashParts.ring); gl.uniform4f(u.uBashTurn, bashParts.turn[0] * ANIMATION_PACE.orbitSpin, bashParts.turn[1] * ANIMATION_PACE.orbitSpin, bashParts.turn[2], bashParts.turn[3]); gl.uniform4fv(u.uBashCore, bashParts.pose.subarray(0, 4));
    gl.uniform4fv(u.uInk, writingInk);
    gl.uniform2f(u.uWriting, bodyFinish.writing * ordinary, clock * ANIMATION_PACE.writingWave);
    gl.uniform2fv(u.uQuietAt, quietAt);
    gl.uniform1f(u.uQuietFloor, momentMaterial('quietFloor'));
    var materialStorm = storm.level * (BLOB_BODY_FINISH ? 0.65 : 1) * (1 - 0.38 * bodyFinish.base);
    materialStorm += ((thinkingMotion ? thinkingMotion.storm : 0.06) - materialStorm) * bodyFinish.thinking;
    gl.uniform1f(u.uStorm, (materialStorm * (1 - orbit[1]) + 0.025 * orbit[1]) * (1 - 0.92 * (seat.writingW || 0)) * ordinary);
    gl.uniform3fv(u.uSheen, mixed(palette.dark ? palette.fast : palette.slow, palette.actionShine, actionColour));
    gl.uniform1f(u.uRelief, momentMaterial('relief'));
    gl.uniform2f(u.uSurface, momentMaterial('sheen'), momentMaterial('soften'));
    if (live) {
      gl.uniform1i(u.uCurl, bind(1, T.curl)); gl.uniform2fv(u.uCurlTexel, T.curl.px);
      gl.uniform2f(u.uVort, drive.vort[0] * (BLOB_BODY_FINISH ? 0.7 : 1) * (1 - 0.45 * bodyFinish.base + 0.1 * bodyFinish.thinking) * (1 - orbit[1]) * ordinary, drive.vort[1]);
      gl.uniform3fv(u.uFast, mixed(palette.fast, palette.actionFast, actionColour)); gl.uniform3fv(u.uSlow, mixed(palette.slow, palette.actionSlow, actionColour));
      gl.uniform1i(u.uVelocity, bind(2, T.velocity.read)); gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    }
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
      step(Math.min(interval, 50) / 1000, now / 1000);
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
    if (!verdict.slow) {
      strikes = 0;
      if (!shown) reveal();
      return;
    }
    strikes++;
    if (verdict.severe || strikes >= 2 || !shown) degrade(verdict.severe ? 2 : 1, m, w);
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

  function reveal() {
    shown = true;
    moment.wake = clock;
    burst(8, 0.32);
    if (canvas) canvas.classList.add('is-live');
  }

  function update() {
    /* Off screen, hidden, or not the focused window: no animation frames at all. */
    var want = !dead && gl && onScreen && !document.hidden && (!document.hasFocus || document.hasFocus());
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
      if (!dead) setState('paused');
    }
  }


  /* ------------------------------------------------------------ start, stop */

  function teardown() {
    running = false;
    if (momentPose.active) playfulMoment.reset();
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
        if (old.parentNode) old.parentNode.removeChild(old);
        try { if (lose) lose.loseContext(); } catch (error) { /* already gone */ }
      };
      if (shown && old.classList.contains('is-live')) {
        old.classList.remove('is-live');
        setTimeout(finish, 700);
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
    if (event.pointerType && event.pointerType !== 'mouse') return;
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
      if (extrasOn) {
        P.forcesL = program(vertex, FRAGMENTS.forces, '#define LIVE\n');
        P.divergenceL = program(vertex, FRAGMENTS.divergence, '#define LIVE\n');
        P.dyeL = program(vertex, FRAGMENTS.dye, '#define LIVE\n');
        P.displayL = program(vertex, FRAGMENTS.display, '#define LIVE\n');
      }
      var buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);

      level = SMALL_START;
      stats.level = level;
      visual.setAttribute('data-fluid-level', String(level));
      ring.insertBefore(canvas, ring.firstChild);
      allocate();
      readPalette();

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
        update();
      });
      observer.observe(visual);
      if (extrasOn) visual.addEventListener('click', tap);
      setState('paused');
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
    teardown();
    window.removeEventListener(BLOB_MOMENTS_EVENT, syncMoments);
    window.removeEventListener('storage', syncMoments);
    if (nearWatch) { nearWatch.disconnect(); nearWatch = null; }
    if (settingsWatch) { settingsWatch.disconnect(); settingsWatch = null; }
    if (motion) { if (motion.removeEventListener) motion.removeEventListener('change', recheck); else if (motion.removeListener) motion.removeListener(recheck); }
    try { delete ring.homeCircleFluid; } catch (error) { /* already gone */ }
  }

  try { setState('waiting'); schedule(); } catch (error) { stats.note = String(error && error.message || error).slice(0, 160); destroy(); }
  return { destroy: destroy };
}
