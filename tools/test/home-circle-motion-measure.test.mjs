/* The motion instrument, checked against series and frames whose right answer
 * is known by construction. No browser, no src/, no clock: a damped spring is
 * integrated here in a few lines, a crossfade is built as a literal lerp, and
 * each measure is required to tell them apart before it is ever pointed at the
 * renderer. If these fail, the motion gates are measuring their own noise.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as X from './home-circle-motion-measure.mjs'
import { MOTION } from './home-circle-jelly-thresholds.mjs'

const DT = 1000 / 60

/* Integrate a damped spring x'' = -w0^2 (x - rest) - 2 zeta w0 x' from x0 at
   rest velocity, fixed step, and return the series. Semi-implicit Euler. */
function spring ({ x0 = 1, rest = 0, hz = 5, zeta = 0.2, seconds = 1.5, dt = DT / 1000 } = {}) {
  const w0 = 2 * Math.PI * hz
  let x = x0, v = 0
  const out = []
  for (let t = 0; t < seconds; t += dt) {
    out.push(x)
    const a = -w0 * w0 * (x - rest) - 2 * zeta * w0 * v
    v += a * dt; x += v * dt
  }
  return out
}
const expEase = ({ x0 = 1, rest = 0, rate = 12, seconds = 1.5, dt = DT / 1000 } = {}) => {
  const out = []
  for (let t = 0; t < seconds; t += dt) out.push(rest + (x0 - rest) * Math.exp(-rate * t))
  return out
}

/* A soft disc frame: colour inside radius, ground outside, one-pixel ramp. */
function discFrame ({ size = 48, cx = 24, cy = 24, rx = 14, ry = 14, rgb = [220, 90, 120], ground = [10, 10, 12] } = {}) {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry)
      const a = Math.max(0, Math.min(1, (1 - d) * Math.min(rx, ry) + 0.5))
      const i = (y * size + x) * 4
      for (let k = 0; k < 3; k++) data[i + k] = Math.round(a * rgb[k] + (1 - a) * ground[k])
      data[i + 3] = 255
    }
  }
  return { data, width: size, height: size }
}
const lerpFrames = (A, B, t) => ({ width: A.width, height: A.height, data: A.data.map((v, i) => Math.round(v * (1 - t) + B.data[i] * t)) })

/* ------------------------------------------------------- overshoot */

test('restCrossings counts an underdamped spring crossing rest at least twice', () => {
  const s = spring({ hz: 5, zeta: 0.2 })
  const r = X.restCrossings(s, 0, { deadband: 0.01 })
  assert.ok(r.count >= MOTION.overshootCrossings.value, `spring crossed rest ${r.count} times`)
})

test('restCrossings reports ZERO for an exponential ease -- the lerp the gate must catch', () => {
  const r = X.restCrossings(expEase(), 0, { deadband: 0.01 })
  assert.equal(r.count, 0)
})

test('restCrossings ignores jitter inside the deadband', () => {
  const s = expEase().map((v, i) => v + (i % 2 ? 0.004 : -0.004))
  assert.equal(X.restCrossings(s, 0, { deadband: 0.01 }).count, 0)
})

/* ---------------------------------------------------- not a crossfade */

test('a literal crossfade of two endpoints fits as a linear blend with ~zero residual', () => {
  const A = discFrame({ rx: 14, ry: 14 }), B = discFrame({ rx: 20, ry: 10 })
  const mid = lerpFrames(A, B, 0.5)
  const r = X.linearBlendResidual(A, B, mid)
  assert.ok(r.residual < MOTION.blendResidualMin.value / 2, `crossfade residual ${r.residual}`)
})

test('a crossfade with a brightness ramp on top still fits (three-coefficient fit)', () => {
  const A = discFrame({ rx: 14, ry: 14 }), B = discFrame({ rx: 20, ry: 10 })
  const mid = lerpFrames(A, B, 0.5)
  mid.data = mid.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v * 1.1 + 6)))
  const r = X.linearBlendResidual(A, B, mid)
  assert.ok(r.residual < MOTION.blendResidualMin.value / 2, `re-exposed crossfade residual ${r.residual}`)
})

test('a body that DEFORMS between the endpoints leaves a residual no blend explains', () => {
  const A = discFrame({ rx: 14, ry: 14 }), B = discFrame({ rx: 20, ry: 10 })
  // the real intermediate: an ellipse part way, with its own edge
  const mid = discFrame({ rx: 17, ry: 12 })
  const r = X.linearBlendResidual(A, B, mid)
  assert.ok(r.residual > MOTION.blendResidualMin.value, `deforming mid frame residual only ${r.residual}`)
})

test('linearBlendResidual refuses frames of different sizes', () => {
  assert.throws(() => X.linearBlendResidual(discFrame({ size: 48 }), discFrame({ size: 32 }), discFrame({ size: 48 })), /size/)
})

/* ---------------------------------------------------------- squash */

test('axisOpposition is strongly negative for a volume-preserving squash', () => {
  const w = [], h = []
  for (let t = 0; t < 2; t += 0.02) { const s = 1 + 0.2 * Math.sin(t * 7); w.push(30 * s); h.push(30 / s) }
  const r = X.axisOpposition(w, h)
  assert.ok(r.correlation < MOTION.axisCorrelationMax.value, `squash correlation ${r.correlation}`)
  assert.ok(r.areaDrift < MOTION.areaDriftMax.value, `squash area drift ${r.areaDrift}`)
})

test('axisOpposition is +1 for a uniform scale -- the fake the gate must catch', () => {
  const w = [], h = []
  for (let t = 0; t < 2; t += 0.02) { const s = 1 + 0.2 * Math.sin(t * 7); w.push(30 * s); h.push(30 * s) }
  const r = X.axisOpposition(w, h)
  assert.ok(r.correlation > 0.99, `scale correlation ${r.correlation}`)
  assert.ok(r.areaDrift > MOTION.areaDriftMax.value, `scale should not conserve area, drift ${r.areaDrift}`)
})

test('axisOpposition reports NaN, not a pass, for a body that never moves', () => {
  const r = X.axisOpposition(new Array(60).fill(30), new Array(60).fill(30))
  assert.ok(Number.isNaN(r.correlation))
})

/* ------------------------------------------------- state separation */

test('stateSeparation passes three well-separated states and names a collapsed pair', () => {
  const noise = i => (i % 3 - 1) * 0.02
  const good = {
    solid: Array.from({ length: 12 }, (_, i) => 0.10 + noise(i)),
    liquid: Array.from({ length: 12 }, (_, i) => 0.40 + noise(i)),
    mist: Array.from({ length: 12 }, (_, i) => 0.80 + noise(i))
  }
  assert.ok(X.stateSeparation(good, { minD: MOTION.stateSeparationD.value }).ok)
  const bad = { ...good, liquid: good.solid.map(v => v + 0.01) }
  const r = X.stateSeparation(bad, { minD: MOTION.stateSeparationD.value })
  assert.equal(r.ok, false)
  const collapsed = r.pairs.find(p => p.d < MOTION.stateSeparationD.value)
  assert.deepEqual([collapsed.a, collapsed.b].sort(), ['liquid', 'solid'])
})

/* --------------------------------------------- absolute state anchors */

/* The live measurements the anchors were calibrated from (presence proof,
   2026-09-18): thinking cloud coverage 0.146 against the idle body's 0.042;
   the solid body's edge 3-8 px at 2x where mist has none; solid chroma
   0.14-0.23, mist under 0.1. */
const LIVE = {
  solid: { coverage: 0.042, edge: 0.09, chroma: 0.18 },
  mist: { coverage: 0.146, edge: 1.0, chroma: 0.06 }
}
/* edge is a FRACTION OF BODY RADIUS, not pixels (silhouetteProfile returns
   mean(widths)/radius). The standard words this anchor as "3-8 px at 2x",
   which on a ~40 px radius is 0.075-0.2 of radius; 0.09 is a solid rim inside
   the material gate's 0.15 ceiling. Mist's edge is unmeasurable and the driver
   reports that as 1.0. Stating these in px was a unit error that could never
   pass -- caught by the live run, 2026-09-18. */

test('stateAnchors passes the live solid/mist measurements it was calibrated from', () => {
  const r = X.stateAnchors(LIVE, MOTION)
  assert.ok(r.ok, r.rows.filter(x => !x.ok).map(x => x.detail).join('; '))
  assert.ok(Math.abs(r.coverageRatio - 3.476) < 0.01, `live coverage ratio ${r.coverageRatio}`)
})

/* MUTATION, one anchor at a time: each degradation must turn exactly its own
   anchor red and leave the other three green, so a red names the look that was
   lost rather than just reporting that something is wrong. */
for (const [key, mutate, why] of [
  ['cloudCoverage', s => ({ ...s, mist: { ...s.mist, coverage: s.solid.coverage * 1.2 } }),
    'a "cloud" that barely covers more than the body'],
  ['solidEdge', s => ({ ...s, solid: { ...s.solid, edge: 0.36 } }),
    'a body whose rim has opened into the whispy halo the owner rejected (the live 2026-09-18 value)'],
  ['mistEdge', s => ({ ...s, mist: { ...s.mist, edge: s.solid.edge * 1.2 } }),
    'mist that is barely softer than the body, so the two states read alike'],
  ['solidChroma', s => ({ ...s, solid: { ...s.solid, chroma: 0.11 } }),
    'a body that has lost its dye'],
  ['mistChroma', s => ({ ...s, mist: { ...s.mist, chroma: 0.13 } }),
    'mist that has crept up into the solid body\'s chroma band']
]) {
  test(`stateAnchors turns ${key} red for ${why}, and nothing else`, () => {
    const r = X.stateAnchors(mutate(LIVE), MOTION)
    assert.ok(!r.ok, 'the anchor set must refuse it')
    const red = r.rows.filter(x => !x.ok).map(x => x.key)
    assert.deepEqual(red, [key], `expected only ${key} red, got ${red.join(',') || 'none'}`)
  })
}

test('stateAnchors is not satisfiable by Cohen\'s d alone: a separable pair that looks identical is red', () => {
  /* The exact hole T4 leaves open. Two states 0.001 apart in coverage with
     almost no variance separate at an enormous d, and a person would see one
     picture. The anchors refuse it; stateSeparation does not. */
  const tight = {
    solid: { coverage: 0.042, edge: 5.0, chroma: 0.18 },
    mist: { coverage: 0.043, edge: 0.0, chroma: 0.06 }
  }
  assert.ok(!X.stateAnchors(tight, MOTION).ok, 'the anchors refuse a gap nobody could see')
  const sep = X.stateSeparation(
    { solid: Array.from({ length: 12 }, (_, i) => 0.042 + (i % 3 - 1) * 1e-5), mist: Array.from({ length: 12 }, (_, i) => 0.043 + (i % 3 - 1) * 1e-5) },
    { minD: MOTION.stateSeparationD.value })
  assert.ok(sep.ok, 'control: Cohen\'s d passes that same pair, which is why the anchors exist')
  assert.ok(sep.pairs[0].d > 50, `control: d is ${sep.pairs[0].d.toFixed(0)} on a gap of 0.001`)
})

/* ------------------------------------------------------- interior lag */

test('interiorLag recovers a known delay between edge and interior', () => {
  const edge = [], inner = []
  const delay = 4 // samples = 66.7 ms at 60 Hz
  for (let k = 0; k < 120; k++) {
    edge.push(Math.sin(k * 0.3) + 0.3 * Math.sin(k * 0.11))
    const j = k - delay
    inner.push(j >= 0 ? Math.sin(j * 0.3) + 0.3 * Math.sin(j * 0.11) : 0)
  }
  const r = X.interiorLag(edge, inner, DT)
  assert.ok(Math.abs(r.lagMs - delay * DT) < DT / 2, `recovered lag ${r.lagMs} ms, planted ${delay * DT}`)
  /* No band is asserted any more. interiorLagLoMs/HiMs (40-80 ms) were
     retired 2026-09-18: they described the fluid substrate's dye layer, and
     the body is one analytic field with no interior that can lag its own
     outline. The measure is kept because it still RECOVERS a real delay, which
     is what makes it worth reporting and what would make it a gate again if a
     body with a genuine inner layer ever ships. The elastic memory the band
     was reaching for is gated directly by T1 (overshootCrossings). */
  assert.ok(!r.undecidable, 'a series that genuinely moves is decidable')
  assert.ok(r.amplitude.interior > MOTION.interiorNoiseFloorLsb.value, 'and this one moves well above the noise floor')
})

test('interiorLag refuses to score dither: under the noise floor it is undecidable, not confident', () => {
  /* THE FAILURE THIS PREVENTS. The body's interior ink varies by about 1 LSB
     of triangular dither, uncorrelated with the outline by construction.
     Cross-correlating that still returns an argmax, and the argmax looks like
     an answer: a lag with a correlation beside it. The proof reported 134 ms
     that way. Below the floor the measure must say it does not know. */
  const rand = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(7)
  const edge = Array.from({ length: 120 }, (_, k) => 40 + Math.sin(k * 0.3) * 6)
  const dither = Array.from({ length: 120 }, () => 128 + (rand() - 0.5) * 2) // ~1 LSB peak-to-peak

  /* Without the floor it produces a confident-looking number out of noise. */
  const unguarded = X.interiorLag(edge, dither, DT)
  assert.ok(!unguarded.undecidable, 'control: with no floor the old behaviour still scores it')
  assert.ok(Number.isFinite(unguarded.lagMs), `control: it returns a lag (${unguarded.lagMs.toFixed(0)} ms) off pure dither`)

  /* With the floor it refuses. */
  const guarded = X.interiorLag(edge, dither, DT, { noiseFloor: MOTION.interiorNoiseFloorLsb.value })
  assert.ok(guarded.undecidable, 'dither under the floor is undecidable')
  assert.ok(Number.isNaN(guarded.lagMs) && Number.isNaN(guarded.correlation), 'and carries no number a gate could read')
  assert.match(guarded.reason, /does not move above the noise floor/)

  /* And the floor does NOT swallow a real signal of the same small size plus
     genuine movement: 6 LSB of travel is decided, not refused. */
  const real = dither.map((v, k) => v + Math.sin((k - 4) * 0.3) * 3)
  assert.ok(!X.interiorLag(edge, real, DT, { noiseFloor: MOTION.interiorNoiseFloorLsb.value }).undecidable,
    'a series that actually travels stays decidable')
})

test('interiorLag reports zero for an interior that moves in lockstep -- a rigid scale', () => {
  const edge = Array.from({ length: 120 }, (_, k) => Math.sin(k * 0.3))
  const r = X.interiorLag(edge, edge.slice(), DT)
  assert.equal(r.lagMs, 0)
})

/* ------------------------------------------------ transition duration */

test('transitionDuration reads a 450 ms travel off a settled series', () => {
  const s = []
  for (let k = 0; k < 90; k++) { const t = k * DT; s.push(t < 100 ? 0 : t < 550 ? (t - 100) / 450 : 1) }
  const r = X.transitionDuration(s, DT)
  // departure and arrival are read at 5% bands, so a linear 450 ms ramp reads as 90% of it
  assert.ok(Math.abs(r.durationMs - 450 * 0.9) <= 2 * DT, `read ${r.durationMs} ms`)
  assert.ok(r.durationMs >= MOTION.transitionLoMs.value && r.durationMs <= MOTION.transitionHiMs.value)
})

test('transitionDuration counts an overshoot as still travelling until it settles', () => {
  const s = spring({ x0: 0, rest: 1, hz: 4, zeta: 0.25, seconds: 2 })
  const r = X.transitionDuration(s, DT)
  // a 4 Hz spring at zeta .25 rings for well over 100 ms after first reaching 1
  assert.ok(r.durationMs > 250, `spring settled in ${r.durationMs} ms`)
  assert.ok(Number.isFinite(r.durationMs))
})

test('transitionDuration is Infinity when the series never settles', () => {
  const s = Array.from({ length: 120 }, (_, k) => Math.sin(k * 0.4))
  assert.equal(X.transitionDuration(s, DT).durationMs, Infinity)
})

/* ---------------------------------------------------------- frames */

test('silhouetteOfFrame reads width, height and area off a known ellipse', () => {
  const f = discFrame({ rx: 16, ry: 10 })
  const s = X.silhouetteOfFrame(f, [10, 10, 12], 24)
  assert.ok(Math.abs(s.width - 32) <= 2 && Math.abs(s.height - 20) <= 2, `got ${s.width}x${s.height}`)
  assert.ok(Math.abs(s.area - Math.PI * 16 * 10) / (Math.PI * 160) < 0.08)
})

test('frameDifference is zero for identical frames and nonzero for a moved body', () => {
  const a = discFrame({ cx: 24 }), b = discFrame({ cx: 26 })
  assert.equal(X.frameDifference(a, a).differing, 0)
  assert.ok(X.frameDifference(a, b).differing > 0)
})
