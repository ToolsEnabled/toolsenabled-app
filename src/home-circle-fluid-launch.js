/* LAUNCH: the Home circle as it was from 2026-09-11 to 09-15 (rule: like the
 * website's circle, with the same interior Navier-Stokes fluid animation and a spinning ring). This is
 * src/home-circle-fluid.js at an earlier commit (the site's fluid, ported in an earlier commit), kept byte-for-byte except for
 * the export name and the crest it follows (home-circle-launch.js's .launch-core-sweep). Only the Launch style
 * mounts it. The original header follows.
 */
/* THE HOME CIRCLE, COME ALIVE (app page 1, route #/).
 *
 * The same real-time fluid as the toolsenabled.ai homepage circle (website public/orbit-fluid.js, an earlier commit), ported to
 * the app's Home ring (src/home-circle.js inside uptimeRing): it paints inside the ring's face, beneath the readout and
 * the ring, and the ring's own light -- its status lip and the orbiting crest -- is its source.
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
 * Kill switch: home.js sets ring.dataset.fluid = 'on' and data-fluid-extras = 'personality blowup voice'. Diagnostics:
 * the ring element's homeCircleFluid.stats() and .play().
 */
import { voiceSignal } from './voice-signal.js'

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

export function mountLaunchFluid(ring, { sample = false } = {}) {
  var inert = { destroy: function () {} };
  /* Decoration never breaks Home: without the browser pieces it needs (or in a test's stand-in DOM) it stays out. */
  if (!ring || !ring.dataset || ring.dataset.fluid !== 'on' || typeof window === 'undefined' || !window.requestAnimationFrame
    || !window.getComputedStyle || !window.MutationObserver || !window.IntersectionObserver || !document.body) return inert;
  var visual = ring;
  var centre = ring.querySelector('.uring-inner');
  var sweep = ring.querySelector('.launch-core-sweep');
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
  var SMALL_START = 2;

  /* Motion and look, tuned by eye on screenshots of every theme at desktop
     and phone sizes. Units: the circle's box is 1 x 1, time in seconds. */
  var TUNE = {
    swirl: 0.045,        // tangential acceleration in the band along the wall
    push: 0.9,           // acceleration at a source's centre
    pushSharp: 70,       // source force falloff, 1 / (2 sigma^2)
    dye: 1.7,            // dye added per second at a source's centre
    dyeSharp: 160,       // source dye falloff
    lightShare: 0.45,    // most of any source's dye that is the lighter colour
    sourceRadius: 0.435, // distance of the sources from the centre
    sourceSpeed: 0.17,   // radians per second of each source's slow sweep
    curl: 3,             // vorticity confinement strength (low: calm, not busy)
    velocityDecay: 0.45, // per second
    dyeDecay: 0.5,       // per second: the light fades before it laps the ring
    pressureKeep: 0.8,   // warm start for the Jacobi iterations
    maxAlpha: 0.62,      // strongest the colour ever gets
    curve: 1.5,          // above 1, faint dye fades out sooner than thick dye
    quietFloor: 0,       // colour behind the words: none (the 10 px foot in tan is only ~4.9:1 on bare ground)
    darkGlow: 0.6,       // dark themes: alpha scale (below 1 adds light)
    pointer: 1.0         // fine-pointer stir strength
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
  var palette = { light: [0.58, 0.85, 0.73], deep: [0.15, 0.6, 0.39], fast: [0.58, 0.85, 0.73], slow: [0.15, 0.6, 0.39], dark: false,
    arc: { start: 130, light: 195, deep: 246, end: 332 }, intensity: 1 };
  var quiet = [0.3, 0.22];
  var pointer = null;
  var observer = null, resizer = null, settingsWatch = null, nearWatch = null;

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

  /* The ring's own light is the source. Its status colour (--core-status-color on .home-circle: teal idle, blue busy,
     coral peak, neutral --ink-3 while unknown) is the deep stop and a softened copy the light stop; on light sheets both
     are lifted to clear tints of the same hue. Strength follows the ring's own glow token times the Glow setting, so
     "unknown" stays faint and Glow 0 is off. */
  function readPalette() {
    paletteDirty = false;
    var styles = getComputedStyle(ring);
    var status = rgba(styles.getPropertyValue('--core-status-color').trim()) || [0.4, 0.45, 0.5, 1];
    if (status[3] < 0.5) status = [0.4, 0.45, 0.5, 1];
    var ground = rgba(getComputedStyle(document.body).backgroundColor) || [1, 1, 1, 1];
    if (ground[3] < 0.5) ground = rgba(getComputedStyle(root).getPropertyValue('--bg').trim() || '#fff') || [1, 1, 1, 1];
    palette.dark = luminance(ground) < 0.2;
    var deep = status.slice(0, 3), light = mixed(deep, [1, 1, 1], palette.dark ? 0.35 : 0.45);
    palette.deep = palette.dark ? deep : lifted(deep, 0.47, 0.45);
    palette.light = palette.dark ? light : lifted(light, 0.74, 0.4);
    palette.fast = ungilded(palette.light); palette.slow = ungilded(palette.deep);
    var trail = parseFloat(styles.getPropertyValue('--core-glow-trail'));
    if (!Number.isFinite(trail)) trail = palette.dark ? 0.75 : 0.5;
    palette.intensity = Math.max(0.12, Math.min(1.5, trail / (palette.dark ? 0.75 : 0.5))) * glowValue();
  }

  /* The crest orbits (home-circle.css: rotate −18° → 342° every --core-orbit-period) and the sources ride with it. Its
     phase is read from the running animation itself, so they stay in step; when the sweep is still it rests where the
     CSS leaves it. Angles are degrees clockwise from the top: the crest peak is at SVG angle −66.6° (start −182° plus
     156° × 0.74), i.e. 23.4° from the top before the rotation; its long tail trails it, its short head leads. */
  function crestArc() {
    var turn = -18;
    try {
      var list = sweep && sweep.getAnimations ? sweep.getAnimations() : [];
      if (list.length) {
        var a = list[0], timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
        var period = timing ? Number(timing.duration) : 16000, now = Number(a.currentTime) || 0;
        if (period > 0) turn = -18 + 360 * ((now % period) / period);
      }
    } catch (error) { /* keep the resting angle */ }
    var peak = 23.4 + turn, start = ((peak - 115) % 360 + 360) % 360, shift = start - (peak - 115);
    palette.arc = { start: start, light: peak - 45 + shift, deep: peak - 8 + shift, end: peak + 40 + shift };
  }

  function measureQuiet() {
    if (!centre) return;
    var r = (canvas || ring).getBoundingClientRect(), c = centre.getBoundingClientRect();
    if (!r.width || !c.width) return;
    quiet = [Math.min(0.46, c.width / r.width * 0.54), Math.min(0.46, c.height / r.height * 0.54)];
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
      'uniform float uDt; uniform float uKeep; uniform vec4 uEmit[3]; uniform vec3 uEmitAt[3]; uniform float uEmitSharp;',
      '#ifdef LIVE',
      'uniform vec4 uPulse[2]; uniform vec2 uTwist[2]; uniform vec4 uPulseDye; uniform vec4 uRingDye;',
      '#endif',
      'void main () {',
      '  vec2 back = vUv - uDt * SAMPLE(uVelocity, vUv, uVelocityTexel).xy;',
      '  vec2 dye = SAMPLE(uDye, back, uDyeTexel).xy * uKeep;',
      '  for (int i = 0; i < 3; i++) { vec2 d = vUv - uEmitAt[i].xy; dye += exp(-dot(d, d) * uEmitSharp) * uEmit[i].xy * uDt; }',
      '#ifdef LIVE',
      // Light shed by the two ring pulses (one tint each: x is the light stop, y the deep stop) and a ring of
      // light near the rim (voice listening); the flow then shears and carries it like any other dye.
      '  vec2 p = vUv - 0.5; float r = length(p), theta = atan(p.y, p.x);',
      '  float s0 = (r - uPulse[0].x) / uPulse[0].y, s1 = (r - uPulse[1].x) / uPulse[1].y, k = (r - uRingDye.x) / uRingDye.y;',
      '  dye += exp(-s0 * s0) * max(cos(uPulse[0].w * theta + uTwist[0].x * s0 + uTwist[0].y), 0.0) * uPulseDye.xy * uDt;',
      '  dye += exp(-s1 * s1) * max(cos(uPulse[1].w * theta + uTwist[1].x * s1 + uTwist[1].y), 0.0) * uPulseDye.zw * uDt;',
      '  dye += exp(-k * k) * uRingDye.zw * uDt;',
      '#endif',
      '  gl_FragColor = vec4(max(dye, 0.0), 0.0, 1.0);',
      '}'
    ],
    /* The picture: the ring\'s two colours by dye share, strength eased and
       kept out from behind the words (a rounded box fitted to the measured
       text block, clear across the whole block), faded at the wall,
       dithered against banding. */
    display: [
      'uniform sampler2D uDye; uniform vec2 uDyeTexel;',
      'uniform vec3 uLight; uniform vec3 uDeep; uniform float uMaxAlpha; uniform float uCurve; uniform float uGlow;',
      'uniform vec2 uQuiet; uniform float uQuietFloor;',
      '#ifdef LIVE',
      'uniform sampler2D uCurl; uniform vec2 uCurlTexel; uniform vec2 uVort; uniform vec3 uFast; uniform vec3 uSlow;',
      '#endif',
      'void main () {',
      '  vec2 dye = max(SAMPLE(uDye, vUv, uDyeTexel).xy, 0.0);',
      '  float amount = dye.x + dye.y;',
      '  vec3 colour = mix(uLight, uDeep, dye.y / (amount + 0.0001));',
      '  float a = uMaxAlpha * pow(1.0 - exp(-2.0 * amount), uCurve);',
      '  vec2 p = vUv - 0.5;',
      '  a *= 1.0 - smoothstep(0.47, 0.5, length(p));',
      '  vec2 q = abs(p / uQuiet); q *= q;',
      '  a *= mix(uQuietFloor, 1.0, smoothstep(1.02, 1.45, sqrt(sqrt(dot(q, q)))));',
      '#ifdef LIVE',
      // Rotation speed: |vorticity| from the solve's own curl field, deep stop when slow, light stop when
      // fast, laid over the dye under the same wall fade and the same clear box behind the words.
      // The extras keep even the corners of the text block clear: its lines stretch to the block's full width.
      '  float d = sqrt(sqrt(dot(q, q))), clear = smoothstep(1.06, 1.3, d);',
      '  a *= clear;',
      '  float mask = (1.0 - smoothstep(0.47, 0.5, length(p))) * mix(uQuietFloor, 1.0, smoothstep(1.02, 1.45, d)) * clear;',
      '  float w = 1.0 - exp(-abs(SAMPLE(uCurl, vUv, uCurlTexel).x) * uVort.y);',
      '  float va = uVort.x * uMaxAlpha * w * mask, total = va + a * (1.0 - va);',
      '  colour = (mix(uSlow, uFast, smoothstep(0.1, 0.85, w)) * va + colour * a * (1.0 - va)) / max(total, 0.0001);',
      '  a = total;',
      '#endif',
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
    var size = Math.max(64, Math.min(Math.round(width * ratio), LADDER[level].dye * 2));
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    measureQuiet();
  }

  /* ------------------------------------------------------------ forcing */

  function smooth(a, b, x) { var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  /* How lit the ring is at an angle (degrees clockwise from the top), and how
     much of that light is the lighter of its two colours. */
  function litAt(deg) {
    var arc = palette.arc, d = ((deg % 360) + 360) % 360;
    if (d < arc.start - 1) d += 360;
    return smooth(arc.start, arc.light, d) * (1 - smooth(arc.deep, arc.end, d));
  }
  function lightAt(deg) {
    var arc = palette.arc, d = ((deg % 360) + 360) % 360;
    if (d < arc.start - 1) d += 360;
    return 1 - smooth(arc.light, arc.deep, d);
  }

  var push = new Float32Array(12), emit = new Float32Array(12), emitAt = new Float32Array(9);

  function plan(time) {
    var arc = palette.arc;
    var mid = (arc.light + arc.deep) / 2, sweep = (arc.end - arc.start) * 0.28;
    for (var i = 0; i < 2; i++) {
      var phase = i * 2.6;
      var deg = mid + sweep * Math.sin(TUNE.sourceSpeed * time + phase) + 9 * Math.sin(0.061 * time + 1.3 * i);
      var theta = deg * Math.PI / 180, s = Math.sin(theta), c = Math.cos(theta);
      var x = 0.5 + TUNE.sourceRadius * s, y = 0.5 + TUNE.sourceRadius * c;
      var lit = litAt(deg) * (0.72 + 0.28 * Math.sin(0.43 * time + phase * 1.7));
      var along = TUNE.push * lit * drive.sources, inward = along * 0.45;
      push[i * 4] = x; push[i * 4 + 1] = y;
      push[i * 4 + 2] = c * along - s * inward;
      push[i * 4 + 3] = -s * along - c * inward;
      var share = TUNE.lightShare * lightAt(deg), amount = TUNE.dye * lit * drive.sources;
      emitAt[i * 3] = x; emitAt[i * 3 + 1] = y;
      emit[i * 4] = amount * share; emit[i * 4 + 1] = amount * (1 - share);
    }
    var k = 8, splash = extrasOn && persona.splash && clock - persona.splash.t < 0.6 ? persona.splash : null;
    if (splash) {
      var fade = 1 - (clock - splash.t) / 0.6;
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
    first: [10, 16], every: [30, 45], collapse: 6.5, relax: 2.2,
    L0: 0.26, cells: 3, strain: 0.28, sinkScale: 1.6, returnR: 0.43, returnW: 0.045,
    torque: 0.32, torqueR: 0.33, torqueW: 0.09, decay: 0.2,
    pulse: 0.2, pulseDye: 1.0, edge: 1.9, width: 0.16, curlGain: 0.12, shade: 0.65
  };
  var episode = null, played = 0, sinceEpisode = 0;
  var nextEpisode = BLOWUP.first[0] + Math.random() * (BLOWUP.first[1] - BLOWUP.first[0]);
  var persona = { eddy: 200, lazyUntil: 0, lazyNext: 45 + Math.random() * 40, splash: null, lean: null };
  var voice = { state: extras.voice ? 'idle' : 'off', level: 0, pitch: 0.5, flourish: null, handback: -99, spoke: -99,
    stream: null, context: null, analyser: null, wave: null, freq: null, recognizer: null, ui: null };

  var drive = {
    ambient: 1, swirl: 1, sources: 1, decay: 1, torque: 0, torqueR: 0.33, torqueW: 0.09,
    pulse: new Float32Array(8), twist: new Float32Array(4), pulseDye: new Float32Array(4),
    pushX: new Float32Array(12), pushXW: new Float32Array(6),
    sink: new Float32Array(4), ret: new Float32Array(2), ringDye: new Float32Array(4), vort: new Float32Array(2)
  };

  function noise(t, k) {
    return (Math.sin(t * 0.071 * k + seed) + 0.6 * Math.sin(t * 0.0439 * k + seed * 1.7) + 0.4 * Math.sin(t * 0.0263 * k + seed * 2.3)) / 2;
  }

  function neutral() {
    drive.ambient = drive.swirl = drive.sources = drive.decay = 1; drive.torque = 0; drive.torqueR = 0.33; drive.torqueW = 0.09;
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

  /* Personality: how the v1 forcing is driven, never an overlay. Slow, non-repeating modulation (three
     incommensurate sinusoids over minutes) shapes breathing, mood and a lazy rest; a small eddy wanders round the
     ring and pauses; a tap makes a splash (a counter-rotating eddy pair: a radial burst would be a pure gradient,
     which the projection removes); a fine pointer resting over the circle draws the fluid gently toward it. */
  function personality(dt) {
    var t = clock, breath = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / (8 + 1.2 * noise(t, 1))), mood = 0.9 + 0.2 * noise(t, 2);
    drive.swirl *= (0.8 + 0.45 * breath) * mood;
    drive.sources *= 0.85 + 0.3 * breath;
    if (!persona.lazyUntil && t > persona.lazyNext) persona.lazyUntil = t + 6 + 3 * Math.random();
    if (persona.lazyUntil) {
      var rest = smooth(persona.lazyUntil - 9, persona.lazyUntil - 7, t) * (1 - smooth(persona.lazyUntil - 1.5, persona.lazyUntil, t));
      drive.swirl *= 1 - 0.6 * rest; drive.sources *= 1 - 0.5 * rest; drive.decay *= 1 + 0.8 * rest;
      if (t > persona.lazyUntil) { persona.lazyUntil = 0; persona.lazyNext = t + 50 + 40 * Math.random(); }
    }
    persona.eddy = (persona.eddy + Math.max(0, noise(t, 3) + 0.25) * 22 * dt) % 360;
    var e = persona.eddy * Math.PI / 180;
    pushX(0, 0.5 + 0.39 * Math.sin(e), 0.5 + 0.39 * Math.cos(e), 0, 0, 900, 1.6 * (0.6 + 0.4 * breath));
    var s = persona.splash;
    if (s && t - s.t < 0.6) {
      var fade = 1 - (t - s.t) / 0.6, px = s.y - 0.5, py = 0.5 - s.x;
      var n = Math.sqrt(px * px + py * py) || 1;
      pushX(1, s.x + 0.025 * px / n, s.y + 0.025 * py / n, 0, 0, 2400, 9 * fade);
      pushX(2, s.x - 0.025 * px / n, s.y - 0.025 * py / n, 0, 0, 2400, -9 * fade);
    } else if (persona.lean && t - persona.lean.t < 1.2) {
      var lx = persona.lean.x - 0.5, ly = persona.lean.y - 0.5, lr = Math.sqrt(lx * lx + ly * ly) || 1;
      pushX(1, 0.5 + 0.6 * lx, 0.5 + 0.6 * ly, 0.12 * lx / lr, 0.12 * ly / lr, 30, 0);
    }
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
    if (extras.personality && voice.state !== 'on' && !episode) personality(dt);
    if (voice.state === 'on' || clock - voice.handback < 1.5) voiceDrive();
    if (extras.blowup && !episode && voice.state !== 'on') {
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
    /* The episode starts from rest, as the paper's flow does: u(·, 0) = 0. */
    if (live && episode && episode.rest) { clearPair(T.velocity); clearPair(T.pressure); episode.rest = false; }
    crestArc();
    plan(time);
    gl.disable(gl.BLEND);

    u = use(P.curl, T.curl);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    draw(T.curl);

    u = use(live ? P.forcesL : P.forces, T.velocity.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uCurl, bind(1, T.curl));
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uCurlStrength, TUNE.curl);
    gl.uniform1f(u.uSwirl, TUNE.swirl * drive.swirl);
    gl.uniform4fv(u.uPush, push);
    gl.uniform1f(u.uPushSharp, TUNE.pushSharp);
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
    gl.uniform1f(u.uKeep, 1 / (1 + TUNE.velocityDecay * drive.decay * dt));
    draw(T.velocity.write);
    T.velocity.swap();

    u = use(live ? P.dyeL : P.dye, T.dye.write);
    gl.uniform1i(u.uVelocity, bind(0, T.velocity.read));
    gl.uniform1i(u.uDye, bind(1, T.dye.read));
    gl.uniform2fv(u.uVelocityTexel, T.velocity.read.px);
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uKeep, 1 / (1 + TUNE.dyeDecay * dt));
    gl.uniform4fv(u.uEmit, emit);
    gl.uniform3fv(u.uEmitAt, emitAt);
    gl.uniform1f(u.uEmitSharp, TUNE.dyeSharp);
    if (live) {
      gl.uniform4fv(u.uPulse, drive.pulse); gl.uniform2fv(u.uTwist, drive.twist);
      gl.uniform4fv(u.uPulseDye, drive.pulseDye); gl.uniform4fv(u.uRingDye, drive.ringDye);
    }
    draw(T.dye.write);
    T.dye.swap();

    u = use(live ? P.displayL : P.display, null);
    gl.uniform1i(u.uDye, bind(0, T.dye.read));
    gl.uniform2fv(u.uDyeTexel, T.dye.read.px);
    gl.uniform3fv(u.uLight, palette.light);
    gl.uniform3fv(u.uDeep, palette.deep);
    gl.uniform1f(u.uMaxAlpha, Math.min(0.75, TUNE.maxAlpha * palette.intensity));
    gl.uniform1f(u.uCurve, TUNE.curve);
    gl.uniform1f(u.uGlow, palette.dark ? TUNE.darkGlow : 1);
    gl.uniform2fv(u.uQuiet, quiet);
    gl.uniform1f(u.uQuietFloor, TUNE.quietFloor);
    if (live) {
      gl.uniform1i(u.uCurl, bind(1, T.curl)); gl.uniform2fv(u.uCurlTexel, T.curl.px);
      gl.uniform2fv(u.uVort, drive.vort); gl.uniform3fv(u.uFast, palette.fast); gl.uniform3fv(u.uSlow, palette.slow);
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
    if (nearWatch) { nearWatch.disconnect(); nearWatch = null; }
    if (settingsWatch) { settingsWatch.disconnect(); settingsWatch = null; }
    if (motion) { if (motion.removeEventListener) motion.removeEventListener('change', recheck); else if (motion.removeListener) motion.removeListener(recheck); }
    try { delete ring.homeCircleFluid; } catch (error) { /* already gone */ }
  }

  try { setState('waiting'); schedule(); } catch (error) { stats.note = String(error && error.message || error).slice(0, 160); destroy(); }
  return { destroy: destroy };
}
