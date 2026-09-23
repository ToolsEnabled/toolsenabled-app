/* Optional Home vignette. All choreography, timing, material and preferences
 * live here; the ordinary blob never borrows these weights or random draws.
 * No timer/RAF: only visible, eligible renderer time advances the schedule. */
export const BLOB_MOMENTS_KEY = 'mc.set.home_blob_moments'
export const BLOB_MOMENTS_EVENT = 'mc:blob-moments-changed'
export function blobMomentsEnabled() {
  try { return localStorage.getItem(BLOB_MOMENTS_KEY) !== 'off' } catch { return true }
}
export function setBlobMomentsEnabled(enabled) {
  localStorage.setItem(BLOB_MOMENTS_KEY, enabled ? 'on' : 'off')
  window.dispatchEvent(new CustomEvent(BLOB_MOMENTS_EVENT))
  return Boolean(enabled)
}

// Same material as the accepted base. Only the vignette shape and motion change.
export const MOMENT_MATERIAL = Object.freeze({
  maxAlpha: .86, curve: 1.42, relief: 8, quietFloor: .4, sheen: 1, soften: 0,
})
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x))
const ease = (a, b, t) => { const x = clamp((t - a) / (b - a)); return x * x * x * (10 + x * (-15 + 6 * x)) }
const mix = (a, b, t) => a + (b - a) * t
const bounded = (x, y, radius = .275) => {
  const r = Math.hypot(x - .5, y - .53), k = r > radius ? radius / r : 1
  return { x: .5 + (x - .5) * k, y: .53 + (y - .53) * k }
}
function freshSeed() {
  try { return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] } catch { return Date.now() >>> 0 }
}
// A glance has a short ease into a fixation, then a longer quiet hold. The
// softer body follow is integrated separately, so this is never a rigid swivel.
function gazeAt(t) {
  const keys = [[0,0,0],[2.3,0,0],[2.55,-.93,.31],[2.72,-.86,.27],[3.22,-.86,.27],
    [3.52,.96,.2],[3.7,.9,.16],[4.3,.9,.16],[4.59,-.78,.4],[4.76,-.7,.35],[5.34,-.7,.35],
    [5.61,.8,.28],[5.8,.72,.24],[6.42,.72,.24],[6.83,0,.05]]
  return gazeThrough(keys, t)
}
function gazeThrough(keys, t) {
  for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) {
    const a = keys[i - 1], b = keys[i], w = ease(a[0], b[0], t)
    return { x: mix(a[1], b[1], w), y: mix(a[2], b[2], w) }
  }
  return { x: 0, y: .05 }
}
function secondGlance(t, direction) {
  const gaze = gazeThrough([[0,0,.04],[.7,0,.04],[1.02,-.72,.24],[1.18,-.65,.2],[1.62,-.65,.2],
    [1.98,.79,.1],[2.14,.71,.08],[2.52,.71,.08],[3.35,0,.05]], t)
  return { x: gaze.x * direction, y: gaze.y }
}

export function createPlayfulMoment({ seed = freshSeed() } = {}) {
  let randomState = seed >>> 0
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296 }
  const interval = () => 240 + 120 * random()
  let remaining = interval(), state = null, count = 0
  const pose = { active: false, weight: 0, phase: 'waiting', age: 0, ownsSeat: false,
    x: .5, y: .5, vx: 0, vy: 0, scale: 1, together: 1, blink: 0,
    gazeX: 0, gazeY: 0, leanX: 0, leanY: 0, stretch: 0,
    pieceX: .5, pieceY: .5, pieceRadius: 0, neck: 0, collapse: 0 }
  function begin(seat) {
    if (state) return false
    const anchor = bounded(seat.x, seat.y, .24)
    // Give the escape a vertical lane. The first horizontal glances miss it;
    // the eventual upward/downward perk is what finds the little one.
    anchor.x = .5 + (anchor.x - .5) * .75
    const verticalChoice = random() < .5 ? -1 : 1
    const vertical = Math.abs(anchor.y - .53) < .025 ? verticalChoice : Math.sign(.53 - anchor.y)
    const angle = vertical * Math.PI / 2
    const reach = Math.sqrt(.31 * .31 - (anchor.x - .5) ** 2)
    const escape = { x: anchor.x, y: clamp(anchor.y + .30 * vertical, .53 - reach, .53 + reach) }
    const chaseDuration = 10 + 5 * random()
    state = { age: 0, x: seat.x, y: seat.y, vx: seat.vx || 0, vy: seat.vy || 0,
      anchor, escape, angle, chaseDuration, captureAt: 8.7 + chaseDuration,
      relookAt: (8.7 + chaseDuration + 3.1) * .5 + .25, relookSeat: null,
      direction: Math.sign(-(escape.y - .53) * (escape.x - anchor.x) + (escape.x - .5) * (escape.y - anchor.y)) || 1,
      phase: random() * Math.PI * 2,
      leanX: 0, leanY: 0, cancelAt: null, cancelWeight: 0, capture: null }
    count++
    return true
  }
  function finish() {
    state = null; remaining = interval()
    Object.assign(pose, { active: false, weight: 0, ownsSeat: false, phase: 'waiting', age: 0, pieceRadius: 0, neck: 0 })
  }
  function prey(s, t) {
    const x = s.escape.x - .5, y = s.escape.y - .53
    const angle = Math.atan2(y, x) + s.direction * (.93 * t - .465 * (1 - Math.exp(-2 * t)))
    const radius = mix(Math.hypot(x, y), .22 + .025 * Math.sin(t * .81 + s.phase) + .014 * Math.sin(t * 1.63), ease(0, 2, t))
    return { x: .5 + radius * Math.cos(angle), y: .53 + radius * Math.sin(angle) }
  }
  function follow(s, target, dt, chase) {
    const k = chase ? 10 : 8, damping = chase ? 5.8 : 5.7
    let ax = (target.x - s.x) * k - s.vx * damping, ay = (target.y - s.y) * k - s.vy * damping
    const a = Math.hypot(ax, ay), limit = chase ? .4 : .14
    if (a > limit) { ax *= limit / a; ay *= limit / a }
    s.vx += ax * dt; s.vy += ay * dt
    s.x += s.vx * dt; s.y += s.vy * dt
  }
  function step(dt, { seat, enabled = true, eligible = true } = {}) {
    dt = clamp(dt, 0, .05)
    if (!state) {
      if (enabled && eligible) remaining -= dt
      if (enabled && eligible && remaining <= 0) begin(seat)
      else return pose
    }
    const s = state
    s.age += dt
    const t = s.age
    if ((!enabled || !eligible) && s.cancelAt === null) { s.cancelAt = t; s.cancelWeight = pose.weight }
    if (s.cancelAt !== null) {
      pose.weight = s.cancelWeight * (1 - ease(s.cancelAt, s.cancelAt + .55, t))
      pose.ownsSeat = false; pose.phase = 'returning'; pose.age = t
      if (t >= s.cancelAt + .55) finish()
      return pose
    }
    const returning = s.captureAt + 2.2
    if (t >= returning + .9) { finish(); return pose }
    let gaze = gazeAt(t)
    let perk = ease(6.95, 7.24, t) * (1 - ease(7.7, 8.35, t))
    const dx = s.escape.x - s.x, dy = s.escape.y - s.y, distance = Math.hypot(dx, dy) || 1
    gaze = { x: mix(gaze.x, dx / distance, perk), y: mix(gaze.y, dy / distance, perk) }
    // Let the chase establish itself before a longer second check. Coasting,
    // eye formation, each fixation and the final perk all have their own beat.
    const glanceTime = t - s.relookAt
    const secondEyes = ease(0, .65, glanceTime) * (1 - ease(2.75, 3.35, glanceTime))
    const secondBrake = ease(-.7, 0, glanceTime) * (1 - ease(2.8, 3.6, glanceTime))
    if (secondEyes > 0) {
      const escaped = prey(s, Math.max(0, t - 8.7)), glance = secondGlance(glanceTime, s.direction)
      const gx = escaped.x - s.x, gy = escaped.y - s.y, gd = Math.hypot(gx, gy) || 1
      const found = ease(2.52, 2.88, glanceTime)
      gaze = { x: mix(gaze.x, mix(glance.x, gx / gd, found), secondEyes),
        y: mix(gaze.y, mix(glance.y, gy / gd, found), secondEyes) }
      perk = Math.max(perk, found * secondEyes)
    }
    const lag = 1 - Math.exp(-dt / .26)
    s.leanX += (gaze.x - s.leanX) * lag; s.leanY += (gaze.y - s.leanY) * lag
    let piece, radius = .0185, neck = 0, collapse = 0
    if (t < 8.7) {
      follow(s, { x: s.anchor.x + .008 * s.leanX, y: s.anchor.y + .005 * s.leanY }, dt, false)
      const split = ease(.38, 1.55, t)
      const attachment = { x: s.x + .055 * Math.cos(s.angle), y: s.y + .055 * Math.sin(s.angle) }
      const bend = .012 * Math.sin(Math.PI * split)
      piece = { x: mix(attachment.x, s.escape.x, split) - Math.sin(s.angle) * bend,
        y: mix(attachment.y, s.escape.y, split) + Math.cos(s.angle) * bend }
      radius *= ease(.3, .65, t)
      neck = ease(.3, .55, t) * (1 - ease(.65, 1.4, t))
    } else if (t < s.captureAt) {
      piece = prey(s, t - 8.7)
      // Aim just behind the morsel: inertia carries the body round the turn,
      // while the little one keeps enough of a lead to remain visibly separate.
      const gap = Math.hypot(piece.x - s.x, piece.y - s.y) || 1
      let target = { x: piece.x - (piece.x - s.x) / gap * .115,
        y: piece.y - (piece.y - s.y) / gap * .115 }
      if (glanceTime > -.72 && !s.relookSeat) s.relookSeat = bounded(s.x + s.vx * .33, s.y + s.vy * .33, .25)
      if (s.relookSeat && secondBrake > 0) target = {
        x: mix(target.x, s.relookSeat.x + .006 * s.leanX, secondBrake),
        y: mix(target.y, s.relookSeat.y + .004 * s.leanY, secondBrake),
      }
      follow(s, target, dt, true)
    } else {
      if (!s.capture) {
        s.capture = prey(s, s.chaseDuration)
        const length = Math.hypot(s.capture.x - s.x, s.capture.y - s.y) || 1
        s.captureDirection = { x: (s.capture.x - s.x) / length, y: (s.capture.y - s.y) / length }
      }
      // A final soft catch, followed by a little coast. Position and velocity
      // stay continuous; shrinking the fragment returns its mass to the body.
      follow(s, s.capture, dt, true)
      const brake = prey(s, s.chaseDuration + .25 * (1 - Math.exp(-4 * (t - s.captureAt))))
      const touch = ease(s.captureAt, s.captureAt + .5, t)
      // Curl visibly outside the surface, then feed inward along a curved neck.
      // Growth follows the incoming material instead of preceding the catch.
      collapse = ease(s.captureAt + .12, s.captureAt + 1.4, t)
      const absorbed = ease(s.captureAt + .72, s.captureAt + 1.5, t)
      const edge = .112 * (1 - absorbed)
      const curl = .018 * Math.sin(Math.PI * collapse) * (1 - absorbed)
      piece = { x: mix(brake.x, s.x + s.captureDirection.x * edge - s.captureDirection.y * curl, touch),
        y: mix(brake.y, s.y + s.captureDirection.y * edge + s.captureDirection.x * curl, touch) }
      radius *= 1 - ease(s.captureAt + 1.36, s.captureAt + 1.5, t)
      neck = ease(s.captureAt + .36, s.captureAt + .74, t) * (1 - ease(s.captureAt + 1.1, s.captureAt + 1.5, t)) * .58
    }
    Object.assign(pose, { active: true, age: t,
      weight: ease(0, .92, t) * (1 - ease(returning, returning + .9, t)),
      ownsSeat: t < returning, x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      phase: t < 1.55 ? 'breakaway' : t < 2.3 ? 'blink' : t < 6.95 ? 'looking' : t < 7.8 ? 'spotting' : t < 8.7 ? 'reforming' : t < s.captureAt ? (secondEyes > .01 ? 'looking-again' : 'chasing') : t < s.captureAt + 1.5 ? 'rejoining' : t < returning ? 'settling' : 'returning',
      scale: 1 - .065 * ease(.35, 1.5, t) * (1 - ease(s.captureAt + .72, s.captureAt + 1.5, t))
        + .012 * Math.sin(Math.PI * ease(s.captureAt + 1, s.captureAt + 2.2, t)),
      together: (1 - ease(.85, 1.7, t) * (1 - ease(7.8, 8.65, t))) * (1 - secondEyes),
      blink: .45 * ease(1.85, 1.97, t) * (1 - ease(2.01, 2.17, t))
        + .34 * ease(.72, .81, glanceTime) * (1 - ease(.86, 1.02, glanceTime)),
      gazeX: gaze.x, gazeY: gaze.y, leanX: s.leanX, leanY: s.leanY,
      stretch: .075 * Math.abs(s.leanX) + .12 * perk,
      pieceX: piece.x, pieceY: piece.y, pieceRadius: radius, neck, collapse })
    return pose
  }
  return { step, preview: begin, reset: finish,
    stats: () => ({ ...pose, enabledIn: Math.max(0, remaining), count, chaseDuration: state?.chaseDuration ?? null,
      relookAt: state?.relookAt ?? null, duration: state ? state.captureAt + 3.1 : null }) }
}

// The accepted eye silhouette from 97e1364e, confined to this vignette. Gaze
// translates before the body follows; a subtle shear stretches the upper lid.
// The joined pose samples the base fluid; the eyes never swivel as a rigid face.
export const PLAYFUL_MOMENT_GLSL = `
uniform vec4 uMoment; // weight, time, neck, local collapse
uniform vec4 uMomentBody; // position, size, together
uniform vec4 uMomentGaze; // eye direction xy, body follow xy
uniform vec2 uMomentFace; // blink, stretch
uniform vec3 uMomentPiece; // position, radius
uniform vec2 uMomentDrift;
uniform vec2 uMomentFlow; // existing BLOWUP edge and width, in fragment space
// Display-scale counterpart of the existing collapse. A readable pair of
// winding folds carries the sqrt(tau) contraction; the former 8/13-fold detail
// becomes a faint secondary shear, since it cannot read at fragment size.
// This is local fluid choreography, not a separate simulation or a proof.
float momentFragment(vec2 q) {
  if (uMoment.w <= 0.0) return exp(-dot(q, q));
  float c = uMoment.w, opened = smoothstep(0.0, 0.22, c);
  float tau = mix(1.0, 0.055, c);
  float spread = (1.0 + 0.72 * sin(3.14159265 * c)) * sqrt(tau);
  vec2 p = q / max(spread, 0.15);
  float r = length(p), theta = atan(p.y, p.x + 0.00001);
  float turn = 7.0 * c + 1.6 * c * c;
  float phase = 2.0 * theta + 3.8 * r - turn;
  float coil = smoothstep(0.12, 0.86, 0.5 + 0.5 * cos(phase));
  float band = exp(-pow((r - uMomentFlow.x * 0.62) / (0.36 + uMomentFlow.y), 2.0));
  float core = exp(-r * r * 1.65) * (1.0 - 0.32 * opened);
  float shear = 1.0 + 0.06 * sin(8.0 * theta + 2.6 * r - turn) * sin(13.0 * theta - 2.6 * r + turn);
  float curled = core + 0.82 * band * coil * shear;
  float amount = mix(exp(-dot(q, q)), curled, opened);
  return amount * (1.0 - smoothstep(0.78, 1.0, c));
}
// Kept for saved renderer checkpoints that still use the former eye material.
float momentDepth(float amount) {
  return sqrt(clamp(1.0 + log(max(amount, 0.001) / 1.65) / 2.8, 0.0, 1.0)) * smoothstep(0.12, 0.28, amount);
}
float momentField(vec2 uv) {
  vec2 p = (uv - uMomentBody.xy) / uMomentBody.z;
  float together = uMomentBody.w, eyes = 1.0 - together;
  float speed = length(uMomentDrift), stretch = min(0.16, speed * 0.8) * together;
  vec2 forward = uMomentDrift / max(speed, 0.001), across = vec2(-forward.y, forward.x);
  p -= forward * dot(p, forward) * stretch / (1.0 + stretch);
  p += across * dot(p, across) * stretch * 0.45;
  p -= (uMomentGaze.xy * 0.0135 + uMomentGaze.zw * 0.005) * eyes;
  p.x -= max(p.y, 0.0) * uMomentGaze.z * 0.12 * eyes;
  float organic = 1.0 + together * (0.028 * sin(atan(p.y, p.x) * 3.0 + uMoment.y * 1.4) + 0.018 * cos(atan(p.y, p.x) * 2.0 - uMoment.y));
  p /= organic;
  float spacing = mix(0.066, 0.0, together);
  float width = mix(0.032, 0.071, together) * (1.0 + 0.55 * uMomentFace.x);
  float height = mix(0.064, 0.071, together) * (1.0 - 0.86 * uMomentFace.x) * (1.0 + uMomentFace.y * eyes);
  // Two continuous fields join through their own neck. Normalize their mass
  // during the merge so the middle pose does not inflate, snap, or crease.
  float overlap = exp(-4.0 * spacing * spacing / (width * width));
  float area = mix(2.0 * 0.032 * 0.064, 0.071 * 0.071, together);
  float mass = sqrt(area * (1.0 + overlap) / (2.0 * width * height));
  p /= mix(mass, 1.0, smoothstep(0.0, 0.08, uMomentFace.x));
  float gaze = uMomentGaze.x * eyes;
  vec2 left = vec2(p.x + spacing, p.y) / (vec2(width, height) * vec2(1.0 - 0.08 * gaze, 1.0 - 0.035 * gaze));
  vec2 right = vec2(p.x - spacing, p.y) / (vec2(width, height) * vec2(1.0 + 0.08 * gaze, 1.0 + 0.035 * gaze));
  float body = (exp(-dot(left, left)) + exp(-dot(right, right))) / (1.0 + overlap) * mix(1.0, 0.92, together);
  // The joined character is the actual base fluid, seated inside the existing
  // choreography. The analytic eye field only controls the look/blink poses.
  // Compensate for the fluid's short wake so the body follows the same seat.
  vec2 fluidAt = uMomentBody.xy + p * 2.2 - uMomentDrift * 0.3;
  vec2 fluid = max(SAMPLE(uDye, fluidAt, uDyeTexel).xy, 0.0);
  float fluidBody = max((fluid.x + fluid.y) / 1.65, body * 0.38);
  fluidBody *= 1.0 - smoothstep(0.105, 0.145, length(p));
  body = mix(body, fluidBody, smoothstep(0.1, 0.95, together));
  vec2 fragment = (uv - uMomentPiece.xy) / max(uMomentPiece.z, 0.0001);
  float small = momentFragment(fragment) * step(0.0001, uMomentPiece.z);
  vec2 axis = uMomentPiece.xy - uMomentBody.xy;
  float lengthOfAxis = max(length(axis), 0.001); axis /= lengthOfAxis;
  vec2 d = uv - uMomentBody.xy;
  float along = dot(d, axis) / lengthOfAxis;
  float curl = 0.018 * sin(3.14159265 * clamp(along, 0.0, 1.0)) * sin(3.14159265 * uMoment.w);
  float widthOfNeck = mix(0.014, 0.009, smoothstep(0.0, 0.22, uMoment.w));
  vec2 tube = vec2((along - 0.62) / 0.44, (dot(d, vec2(-axis.y, axis.x)) - curl) / widthOfNeck);
  return 1.65 * (body + small + uMoment.z * 0.5 * exp(-dot(tube, tube)));
}
`
