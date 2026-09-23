/* The instrument, checked against pictures whose right answer is known by
 * construction.
 *
 * WHY THIS FILE EXISTS. The gates in this lane judge a picture. If the
 * measurement is wrong, a wrong picture scores well and the gate is worse than
 * nothing -- which is exactly the failure that opened T360. So every measure is
 * first pointed at a synthetic body built to have a property, and required to
 * report that property. These tests never load the app, never open a browser
 * and never read src/, so they cannot pin the shader's spelling and they run
 * the same on Linux and Windows.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as M from './home-circle-picture-measure.mjs'

/* ------------------------------------------------------------- synthetic */

/* A disc of constant colour and constant alpha, composited over a flat ground
   exactly the way the browser composites the canvas: out = a*c + (1-a)*ground. */
function disc ({ size = 128, radius = 40, rgb = [220, 40, 90], alpha = 1, ground = [0, 0, 0], softness = 0, colourAt = null, alphaAt = null } = {}) {
  const data = new Uint8ClampedArray(size * size * 4)
  const c = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      let a
      if (softness > 0) a = alpha * Math.max(0, Math.min(1, (radius - r) / softness + 0.5))
      else a = r <= radius ? alpha : 0
      const colour = colourAt ? colourAt(Math.min(1, r / radius)) : rgb
      if (alphaAt) a = alphaAt(Math.min(1, r / radius))
      const i = (y * size + x) * 4
      for (let k = 0; k < 3; k++) data[i + k] = Math.round(a * colour[k] + (1 - a) * ground[k])
      data[i + 3] = 255
    }
  }
  return { data, width: size, height: size }
}

/* ---------------------------------------------------------------- colour */

test('hueGap takes the short way round the circle', () => {
  assert.equal(M.hueGap(10, 20), 10)
  assert.equal(M.hueGap(350, 10), 20)      // not 340
  assert.equal(M.hueGap(10, 350), -20)
  assert.equal(Math.abs(M.hueGap(0, 180)), 180)
})

test('meanHue averages round the wrap instead of through the opposite colour', () => {
  // 359 and 1 average to 0, NOT to 180.
  const mean = M.meanHue([359, 1])
  assert.ok(Math.abs(M.hueGap(mean, 0)) < 0.001, `got ${mean}`)
})

test('oklch reports a saturated red as chromatic and a grey as achromatic', () => {
  assert.ok(M.oklchFromSrgb(220, 40, 90).C > 0.15)
  assert.ok(M.oklchFromSrgb(128, 128, 128).C < 0.001)
})

/* ------------------------------------------------------------- threshold */

test('otsuThreshold splits a two-humped histogram between the humps', () => {
  const values = []
  for (let i = 0; i < 1000; i++) values.push(10 + (i % 5))   // low hump, 10..14
  for (let i = 0; i < 1000; i++) values.push(200 + (i % 5))  // high hump, 200..204
  const t = M.otsuThreshold(values)
  // The behaviour that matters is the SPLIT: everything in the low hump must
  // fall on or below the threshold and everything in the high hump above it.
  // The exact integer is an implementation detail and is not pinned here.
  assert.ok(t >= 14 && t < 200, `threshold ${t} does not separate 10..14 from 200..204`)
})

test('bodyMaskAuto finds a disc without being told how bright it is', () => {
  // Same shape at two very different brightnesses; the mask must find both.
  for (const rgb of [[220, 40, 90], [60, 15, 25]]) {
    const px = disc({ size: 128, radius: 40, rgb, ground: [0, 0, 0] })
    const { mask, covered } = M.bodyMaskAuto(px, [0, 0, 0])
    const expected = Math.PI * 40 * 40
    assert.ok(Math.abs(covered - expected) / expected < 0.06,
      `rgb ${rgb}: covered ${covered}, disc area ${Math.round(expected)}`)
    assert.equal(mask.length, 128 * 128)
  }
})

/* --------------------------------------------------- M1 transmission */

test('an OPAQUE body transmits nothing -- this is the failure the gate exists to catch', () => {
  const A = [8, 10, 14], B = [20, 150, 60]
  const over = ground => disc({ size: 128, radius: 40, rgb: [220, 40, 90], alpha: 1, ground })
  const a = over(A), b = over(B)
  const { mask } = M.bodyMaskAuto(a, A)
  const dist = M.distanceInward(mask, a.width, a.height)
  const t = M.transmission(a, b, A, B, mask, dist)
  assert.ok(t.fraction < 0.01, `opaque body reported transmission ${t.fraction}`)
})

test('a HALF-transparent body transmits about half the ground change', () => {
  const A = [8, 10, 14], B = [20, 150, 60]
  const over = ground => disc({ size: 128, radius: 40, rgb: [220, 40, 90], alpha: 0.5, ground })
  const a = over(A), b = over(B)
  const { mask } = M.bodyMaskAuto(a, A)
  const dist = M.distanceInward(mask, a.width, a.height)
  const t = M.transmission(a, b, A, B, mask, dist)
  assert.ok(Math.abs(t.fraction - 0.5) < 0.05, `expected about 0.5, got ${t.fraction}`)
})

test('transmission refuses two identical grounds rather than dividing by nothing', () => {
  const A = [8, 10, 14]
  const a = disc({ ground: A })
  const { mask } = M.bodyMaskAuto(a, A)
  const dist = M.distanceInward(mask, a.width, a.height)
  assert.throws(() => M.transmission(a, a, A, A, mask, dist), /same/i)
})

/* ------------------------------------------------------ M2 chroma dip */

test('chromaDip reports zero on a body whose chroma ramps monotonically', () => {
  // chroma rises steadily from rim to core: no dip anywhere.
  const px = disc({
    size: 160, radius: 60, ground: [0, 0, 0],
    colourAt: t => [200, Math.round(40 + 120 * t), Math.round(80 + 60 * t)]
  })
  const { mask } = M.bodyMaskAuto(px, [0, 0, 0])
  const dist = M.distanceInward(mask, px.width, px.height)
  const bands = M.thicknessBands(px, mask, dist, 8)
  assert.ok(M.chromaDip(bands).dip < 0.01, `monotone ramp dipped ${M.chromaDip(bands).dip}`)
})

test('chromaDip finds a mid-band collapse to grey -- the brown band', () => {
  // saturated at the rim and at the core, washed out in between.
  const px = disc({
    size: 160, radius: 60, ground: [0, 0, 0],
    colourAt: t => {
      const wash = 1 - Math.exp(-Math.pow((t - 0.5) / 0.18, 2) * 0.5) * 0.9 // 0.1 at t=0.5, 1 at the ends
      const grey = 130
      return [Math.round(grey + (230 - grey) * wash), Math.round(grey + (40 - grey) * wash), Math.round(grey + (95 - grey) * wash)]
    }
  })
  const { mask } = M.bodyMaskAuto(px, [0, 0, 0])
  const dist = M.distanceInward(mask, px.width, px.height)
  const bands = M.thicknessBands(px, mask, dist, 8)
  assert.ok(M.chromaDip(bands).dip > 0.02, `mid-band collapse scored only ${M.chromaDip(bands).dip}`)
})

/* -------------------------------------------------------- M3 hue swing */

test('hueSwing is near zero when the body holds one hue through its thickness', () => {
  const px = disc({ size: 160, radius: 60, ground: [0, 0, 0], colourAt: t => [Math.round(120 + 110 * t), Math.round(22 + 20 * t), Math.round(52 + 47 * t)] })
  const { mask } = M.bodyMaskAuto(px, [0, 0, 0])
  const dist = M.distanceInward(mask, px.width, px.height)
  const bands = M.thicknessBands(px, mask, dist, 8)
  assert.ok(M.hueSwing(bands).swing < 8, `same-hue ramp swung ${M.hueSwing(bands).swing} degrees`)
})

test('hueSwing catches raspberry rotating towards gravy across the thickness', () => {
  // rim raspberry, core brown/orange.
  const px = disc({
    size: 160, radius: 60, ground: [0, 0, 0],
    colourAt: t => [200, Math.round(40 + 90 * (1 - t)), Math.round(95 - 70 * (1 - t))]
  })
  const { mask } = M.bodyMaskAuto(px, [0, 0, 0])
  const dist = M.distanceInward(mask, px.width, px.height)
  const bands = M.thicknessBands(px, mask, dist, 8)
  assert.ok(M.hueSwing(bands).swing > 8, `hue rotation scored only ${M.hueSwing(bands).swing} degrees`)
})

/* ------------------------------------------------------- M5 silhouette */

test('a razor edge measures a narrow silhouette and no halo', () => {
  const ground = [8, 10, 14]
  const px = disc({ size: 200, radius: 70, ground, softness: 1 })
  const { mask } = M.bodyMaskAuto(px, ground)
  const s = M.silhouetteProfile(px, mask, ground)
  assert.ok(s.rays > 100, `only ${s.rays} rays found an edge`)
  assert.ok(s.edgeWidth < 0.05, `razor edge measured ${s.edgeWidth} of the radius`)
  assert.ok(s.haloEnergy < 2, `razor edge reported halo ${s.haloEnergy}`)
})

/* THE REGRESSION THAT M5 AND T4b BOTH SHIPPED. A razor-edged body that also
   carries the bright wet catch M9 requires. The catch is the brightest thing on
   every ray through it, so a reference level taken from the ray's maximum puts
   the 80% level inside the catch and measures the whole body as "the edge".
   Measured live on shader c4384adb before the fix: black (no catch) 0.075 of
   the radius, cobalt and ember (one catch each) 0.860 and 0.871, same shader,
   same geometry, ink falling 124 -> 0 inside one sample on all three. The two
   gates were mutually unsatisfiable: M9 demands the catch, M5 broke on it. */
test('a razor edge is still a razor when the body carries a bright catch', () => {
  const ground = [8, 10, 14]
  const size = 200, radius = 70, c = size / 2
  const px = disc({ size, radius, ground, rgb: [120, 60, 90], softness: 1 })
  // a bright catch in the middle, twice the body's own level -- M9's requirement
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (r > 14) continue
      const i = (y * size + x) * 4
      for (let k = 0; k < 3; k++) px.data[i + k] = Math.min(255, px.data[i + k] * 2)
    }
  }
  const { mask } = M.bodyMaskAuto(px, ground)
  const s = M.silhouetteProfile(px, mask, ground)
  assert.ok(s.rays > 100, `only ${s.rays} rays found an edge`)
  assert.ok(s.edgeWidth < 0.05,
    `a razor edge under a bright catch measured ${s.edgeWidth.toFixed(3)} of the radius -- the catch became the reference level`)
})

test('a soft glow outside the outline measures as halo energy', () => {
  const ground = [8, 10, 14]
  // body plus an exponential skirt reaching well past the silhouette
  const px = disc({
    size: 200, radius: 70, ground, rgb: [190, 90, 60],
    alphaAt: t => t <= 1 ? 1 : 0
  })
  // paint a skirt by hand so the glow is unambiguously OUTSIDE the body
  const c = 100
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (r <= 70) continue
      const a = 0.55 * Math.exp(-(r - 70) / 14)
      const i = (y * 200 + x) * 4
      for (let k = 0; k < 3; k++) px.data[i + k] = Math.round(a * [190, 90, 60][k] + (1 - a) * ground[k])
    }
  }
  const { mask } = M.bodyMaskAuto(px, ground)
  const s = M.silhouetteProfile(px, mask, ground)
  assert.ok(s.haloEnergy > 4, `a visible glow outside the outline scored halo ${s.haloEnergy}`)
})

/* ------------------------------------------------- M6 rim versus core */

test('thicknessBands orders the rim first and the core last', () => {
  // bright thin rim, dark core -- a body lit through.
  const px = disc({
    size: 160, radius: 60, ground: [0, 0, 0],
    colourAt: t => [Math.round(60 + 190 * t), Math.round(20 + 60 * t), Math.round(35 + 90 * t)]
  })
  const { mask } = M.bodyMaskAuto(px, [0, 0, 0])
  const dist = M.distanceInward(mask, px.width, px.height)
  const bands = M.thicknessBands(px, mask, dist, 6)
  const rim = bands[0], core = bands[bands.length - 1]
  assert.ok(rim.thickness < core.thickness)
  // colourAt is keyed on r/radius, so the RIM is the bright end here
  assert.ok(rim.L > core.L, `rim L ${rim.L} should beat core L ${core.L}`)
})

test('thicknessBands returns nothing rather than lying when the mask is empty', () => {
  const px = disc({ size: 64, radius: 0, ground: [0, 0, 0] })
  const mask = new Uint8Array(64 * 64)
  const dist = M.distanceInward(mask, 64, 64)
  assert.deepEqual(M.thicknessBands(px, mask, dist, 6), [])
})

/* ------------------------------------------ body under a glow (3 classes) */

test('bodyMaskHalfPeak finds the body and not the glow round it -- the three-class picture', () => {
  // ground, a wide faint skirt, and a bright disc: the live render's histogram.
  const ground = [0, 0, 0]
  const px = disc({ size: 200, radius: 40, rgb: [220, 90, 90], ground })
  const c = 100
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (r <= 40) continue
      const a = 0.09 * Math.exp(-(r - 40) / 30) // 10-20 ink units, wide
      const i = (y * 200 + x) * 4
      for (let k = 0; k < 3; k++) px.data[i + k] = Math.round(a * 220 + (1 - a) * ground[k])
    }
  }
  const { covered, threshold } = M.bodyMaskHalfPeak(px, ground)
  const expected = Math.PI * 40 * 40
  assert.ok(Math.abs(covered - expected) / expected < 0.06, `covered ${covered}, disc area ${Math.round(expected)}, threshold ${threshold}`)
})

/* ------------------------------------------------- M9 specular structure */

function discWithCatch ({ catchRadius, sheen = false }) {
  const ground = [0, 0, 0]
  const px = disc({ size: 160, radius: 60, rgb: [200, 70, 90], ground })
  const c = 80
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 160; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (r > 60) continue
      const i = (y * 160 + x) * 4
      if (sheen) { // a broad, flat lift over the top half: matte plastic
        if (y < 80) { px.data[i] = 235; px.data[i + 1] = 150; px.data[i + 2] = 165 }
      } else if (Math.hypot(x - 62, y - 62) <= catchRadius) { px.data[i] = 255; px.data[i + 1] = 245; px.data[i + 2] = 245 }
    }
  }
  return px
}

test('specularStructure scores a pin-prick catch near zero and a real catch in the wet band', () => {
  const pin = discWithCatch({ catchRadius: 1.2 })
  const { mask } = M.bodyMaskHalfPeak(pin, [0, 0, 0])
  const s1 = M.specularStructure(pin, mask, 160, 160)
  assert.ok(s1.areaFraction < 0.01, `pin-prick area ${s1.areaFraction}`)
  const wet = discWithCatch({ catchRadius: 12 })
  const s2 = M.specularStructure(wet, M.bodyMaskHalfPeak(wet, [0, 0, 0]).mask, 160, 160)
  assert.ok(s2.areaFraction > 0.02 && s2.areaFraction < 0.15, `wet catch area ${s2.areaFraction}`)
  assert.equal(s2.pieces, 1)
})

test('specularStructure scores a broad matte sheen above the wet band', () => {
  const px = discWithCatch({ sheen: true })
  const s = M.specularStructure(px, M.bodyMaskHalfPeak(px, [0, 0, 0]).mask, 160, 160)
  assert.ok(s.areaFraction > 0.15, `sheen area ${s.areaFraction}`)
})

test('specularStructure counts two catches as two pieces -- two normals, two bodies', () => {
  const px = discWithCatch({ catchRadius: 8 })
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    if (Math.hypot(x - 100, y - 100) <= 8) { const i = (y * 160 + x) * 4; px.data[i] = 255; px.data[i + 1] = 245; px.data[i + 2] = 245 }
  }
  const s = M.specularStructure(px, M.bodyMaskHalfPeak(px, [0, 0, 0]).mask, 160, 160)
  assert.equal(s.pieces, 2)
})

/* ------------------------------------------------------ M10 one body */

test('unionShape: a disc is solid and one piece; a peanut with a waist is not', () => {
  const one = disc({ size: 160, radius: 50, ground: [0, 0, 0] })
  const a = M.unionShape(M.bodyMaskHalfPeak(one, [0, 0, 0]).mask, 160, 160)
  assert.equal(a.pieces, 1)
  assert.ok(a.solidity > 0.97, `disc solidity ${a.solidity}`)
  // two overlapping lobes: the composite the owner rejected
  const two = { data: new Uint8ClampedArray(160 * 160 * 4), width: 160, height: 160 }
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    const i = (y * 160 + x) * 4
    const inside = Math.hypot(x - 55, y - 80) <= 30 || Math.hypot(x - 105, y - 80) <= 30
    two.data[i] = inside ? 220 : 0; two.data[i + 1] = inside ? 80 : 0; two.data[i + 2] = inside ? 100 : 0; two.data[i + 3] = 255
  }
  const b = M.unionShape(M.bodyMaskHalfPeak(two, [0, 0, 0]).mask, 160, 160)
  assert.equal(b.pieces, 1)
  assert.ok(b.solidity < 0.95, `peanut solidity ${b.solidity} should show the waist`)
})

/* -------------------------------------------- M6 luminance toward the rim */

test('radialLuminance reports a positive step and no drop for a body lit through at the rim', () => {
  const px = disc({ size: 160, radius: 60, ground: [0, 0, 0], colourAt: t => [Math.round(120 + 120 * t), Math.round(40 + 60 * t), Math.round(60 + 80 * t)] })
  const { mask } = M.bodyMaskHalfPeak(px, [0, 0, 0])
  const dist = M.distanceInward(mask, 160, 160)
  const bands = M.thicknessBands(px, mask, dist, 8)
  const r = M.radialLuminance(bands)
  assert.ok(r.step > 0.05, `step ${r.step}`)
  assert.ok(r.worstDrop < 0.01, `drop ${r.worstDrop}`)
})

test('radialLuminance reports a ~zero step for a flat disc -- the sticker', () => {
  const px = disc({ size: 160, radius: 60, ground: [0, 0, 0], rgb: [230, 120, 130] })
  const { mask } = M.bodyMaskHalfPeak(px, [0, 0, 0])
  const dist = M.distanceInward(mask, 160, 160)
  const bands = M.thicknessBands(px, mask, dist, 8)
  assert.ok(Math.abs(M.radialLuminance(bands).step) < 0.02)
})

/* ------------------------------------------- M9 by peaks (ruled 2026-09-18) */

test('specularPeaks reads ONE catch on a bright body, where a lightness class read most of the body', () => {
  // a bright pink body with one real highlight: the cobalt case
  const px = disc({ size: 160, radius: 60, rgb: [250, 150, 190], ground: [0, 0, 0] })
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    if (Math.hypot(x - 62, y - 62) <= 9) { const i = (y * 160 + x) * 4; px.data[i] = 255; px.data[i + 1] = 250; px.data[i + 2] = 252 }
  }
  const { mask } = M.bodyMaskHalfPeak(px, [0, 0, 0])
  const s = M.specularPeaks(px, mask, 160, 160)
  assert.equal(s.peaks, 1, `peaks ${s.peaks}`)
  assert.ok(s.areaFraction > 0.01 && s.areaFraction < 0.15, `catch area ${s.areaFraction}`)
})

test('specularPeaks counts two catches as two, and a flat body as none', () => {
  const two = disc({ size: 160, radius: 60, rgb: [200, 70, 90], ground: [0, 0, 0] })
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    if (Math.hypot(x - 62, y - 62) <= 8 || Math.hypot(x - 100, y - 100) <= 8) { const i = (y * 160 + x) * 4; two.data[i] = 255; two.data[i + 1] = 245; two.data[i + 2] = 245 }
  }
  assert.equal(M.specularPeaks(two, M.bodyMaskHalfPeak(two, [0, 0, 0]).mask, 160, 160).peaks, 2)
  const flat = disc({ size: 160, radius: 60, rgb: [230, 120, 130], ground: [0, 0, 0] })
  assert.equal(M.specularPeaks(flat, M.bodyMaskHalfPeak(flat, [0, 0, 0]).mask, 160, 160).peaks, 0)
})

test('thicknessBands leaves the catch out of the chroma mean when told to', () => {
  const px = disc({ size: 160, radius: 60, ground: [0, 0, 0], colourAt: t => [200, Math.round(40 + 120 * t), Math.round(80 + 60 * t)] })
  // a colourless highlight in the mid band
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    if (Math.hypot(x - 80, y - 52) <= 12) { const i = (y * 160 + x) * 4; px.data[i] = 255; px.data[i + 1] = 255; px.data[i + 2] = 255 }
  }
  const { mask } = M.bodyMaskHalfPeak(px, [0, 0, 0])
  const dist = M.distanceInward(mask, 160, 160)
  const withCatch = M.chromaDip(M.thicknessBands(px, mask, dist, 8)).dip
  const catchMask = M.specularPeaks(px, mask, 160, 160).catchMask
  const without = M.chromaDip(M.thicknessBands(px, mask, dist, 8, { exclude: catchMask })).dip
  assert.ok(withCatch > 0.005, `the highlight reads as a dip when counted: ${withCatch}`)
  assert.ok(without < withCatch / 3 && without < 0.003, `and not when excluded: ${without} (counted ${withCatch})`)
})

/* ------------------------------------------- M7 over-stop white (additive) */

/* The declared light stop these tests judge against: a mid-bright warm stop in
   sRGB 0..1, the shape stats().stops.light returns. */
const STOP = [200 / 255, 150 / 255, 120 / 255]

test('overStopWhite: a body drawn by absorption alone never exceeds its own light stop', () => {
  /* Beer-Lambert from the stop: every pixel is the stop times exp(-k*path), so
     every pixel is AT or BELOW the stop by construction. This is the material
     keeping its promise and it must score 1.0 and nothing over. */
  const px = disc({ radius: 40, ground: [0, 0, 0], colourAt: t => {
    const path = 0.1 + 1.6 * (1 - t)
    return [0, 1, 2].map(c => Math.round(STOP[c] * 255 * Math.exp(-0.9 * path)))
  } })
  const mask = M.bodyMaskHalfPeak(px, [0, 0, 0]).mask
  const out = M.overStopWhite(px, mask, STOP)
  assert.ok(out.kept > 1000, `the body was found (${out.kept} pixels)`)
  assert.ok(out.worst <= 1.0, `absorption cannot exceed the stop, worst multiple ${out.worst.toFixed(3)}`)
  assert.equal(out.overFraction, 0)
})

test('overStopWhite: the 1.25x liquid and 1.3x mist multipliers are caught, and named as multiples', () => {
  /* The exact shape the shader grew: the same absorbing body, multiplied above
     the stop. Both are the additive white the owner has rejected four times. */
  for (const [label, gain] of [['liquid 1.25x', 1.25], ['mist 1.3x', 1.3]]) {
    const px = disc({ radius: 40, ground: [0, 0, 0], colourAt: () => [0, 1, 2].map(c => Math.round(STOP[c] * 255 * gain)) })
    const mask = M.bodyMaskHalfPeak(px, [0, 0, 0]).mask
    const out = M.overStopWhite(px, mask, STOP)
    assert.ok(out.worst > 1.2, `${label}: worst multiple ${out.worst.toFixed(3)} must report the lift`)
    assert.ok(Math.abs(out.p995 - gain) < 0.02, `${label}: p995 ${out.p995.toFixed(3)} reads the multiplier itself`)
    assert.ok(out.overFraction > 0.9, `${label}: ${(out.overFraction * 100).toFixed(0)}% of the body sits over the stop`)
  }
})

test('overStopWhite: the one wet catch is a reflection and is excluded, so M9 and M7 are not mutually unsatisfiable', () => {
  /* M9 REQUIRES a catch brighter than the body. If M7 counted it, satisfying
     one gate would break the other -- the trap M5 and M9 were already caught in
     on 2026-09-18. The catch goes in through `exclude` and the verdict is the
     MATERIAL's. */
  const size = 128, ground = [0, 0, 0]
  const px = disc({ size, radius: 40, ground, colourAt: () => [0, 1, 2].map(c => Math.round(STOP[c] * 255 * 0.75)) })
  /* paint a small blazing catch well over the stop */
  for (let y = 46; y < 58; y++) for (let x = 46; x < 58; x++) { const i = (y * size + x) * 4; px.data[i] = 255; px.data[i + 1] = 250; px.data[i + 2] = 245 }
  const mask = M.bodyMaskHalfPeak(px, ground).mask
  const spec = M.specularPeaks(px, mask, size, size)
  const counted = M.overStopWhite(px, mask, STOP)
  assert.ok(counted.worst > 1.2, `with the catch counted the body reads over the stop (${counted.worst.toFixed(3)})`)
  const excluded = M.overStopWhite(px, mask, STOP, { exclude: spec.catchMask })
  assert.ok(excluded.excluded > 0, `the catch mask actually excluded pixels (${excluded.excluded})`)
  /* MEASURED HERE, and it is why this gate judges the FRACTION and not the peak:
     specularPeaks grows its skirt on a BLURRED lightness within 0.05 L of the
     peak, which is M9's definition of the catch's CORE (calibrated against the
     owner's reference at 7.5 % of the body). On this 144-pixel hard-edged catch
     that core is 36 pixels; dilation carries it to 88; the remaining 56 pixels
     of the reflection are still 2.04x the stop. So `worst` and `p995` after
     exclusion belong to the catch's rim, not to the material, and a gate that
     judged them would be red on a body that is doing nothing wrong -- the same
     mutually-unsatisfiable trap M5 and M9 were caught in on 2026-09-18. What
     discriminates is HOW MUCH of the body sits over its stop: a catch's worth,
     or most of it. */
  assert.ok(excluded.overFraction < 0.05, `only a catch's worth of the body is over the stop (${(excluded.overFraction * 100).toFixed(1)}%)`)
  assert.ok(excluded.median <= 1.0, `the material's own middle is at or under its stop (median ${excluded.median.toFixed(3)})`)
})

test('overStopWhite: one hot pixel moves `worst` but not the verdict, and an empty mask refuses', () => {
  const size = 128, ground = [0, 0, 0]
  const px = disc({ size, radius: 40, ground, colourAt: () => [0, 1, 2].map(c => Math.round(STOP[c] * 255 * 0.8)) })
  const i = ((64 * size) + 64) * 4
  px.data[i] = 255; px.data[i + 1] = 255; px.data[i + 2] = 255
  const mask = M.bodyMaskHalfPeak(px, ground).mask
  const out = M.overStopWhite(px, mask, STOP)
  assert.ok(out.worst > 1.2, 'the single hot pixel is visible in `worst`')
  assert.ok(out.p995 <= 1.02, `p995 ${out.p995.toFixed(3)} is not carried by one pixel`)
  assert.ok(out.overFraction < 0.01, 'one pixel is not a body over its stop')
  const empty = M.overStopWhite(px, new Uint8Array(size * size), STOP)
  assert.equal(empty.kept, 0)
  assert.ok(Number.isNaN(empty.worst), 'no body is a refusal, not a zero')
})

/* --------------------------------------------- median and spread over N */

test('medianSpread: the median of N ignores the outlier a single capture would have been judged on', () => {
  /* The measured case: one unchanged shader read 0.135 clean and 0.242 under a
     behaviourally identical respelling. Judged on either single capture the
     verdict at 0.15 flips; judged on the median of the run it does not. */
  const run = [0.135, 0.128, 0.141, 0.242, 0.133, 0.137, 0.130]
  const s = M.medianSpread(run)
  assert.equal(s.median, 0.135)
  assert.equal(s.n, 7)
  assert.ok(s.max === 0.242 && s.min === 0.128, 'the spread still REPORTS the outlier rather than hiding it')
  assert.ok(s.mad < 0.01, `mad ${s.mad} is not moved by one frame`)
})

test('medianSpread: a genuinely soft edge is NOT rescued by the median -- the bound is not widened', () => {
  /* soft-edge mutation, 2026-09-18: antialias widened one pixel to ten and M5
     read 0.655. Every frame of such a body is soft, so the median is soft. */
  const run = [0.655, 0.612, 0.700, 0.648, 0.661]
  const s = M.medianSpread(run)
  assert.ok(s.median > 0.15, `median ${s.median} still fails the 0.15 bound`)
})

test('medianSpread: frames the measure could not read are dropped and COUNTED, never silently averaged', () => {
  const s = M.medianSpread([0.12, NaN, 0.14, NaN, 0.13])
  assert.equal(s.n, 3)
  assert.equal(s.dropped, 2)
  assert.equal(s.median, 0.13)
  const none = M.medianSpread([NaN, NaN])
  assert.equal(none.n, 0)
  assert.ok(Number.isNaN(none.median), 'nothing readable is a refusal, not a zero')
})
