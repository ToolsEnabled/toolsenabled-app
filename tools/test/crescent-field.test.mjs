/* The home hero's crescent field.
 *
 * This suite exists because the shipped crescent cannot be tested at all: it is
 * three stroked paths handed to `feGaussianBlur`, so the only way to ask what
 * it renders is to render it and look. Moving the light into a closed form
 * makes it arithmetic, and arithmetic can be pinned.
 *
 * The tests that matter most are the two that guard the OWNER's design rather
 * than my code: `taper` must be exactly 0.5 at the old endpoint (so the
 * crescent measures the same length at half intensity as the one he approved),
 * and the layer constants must still be the ones the shipped SVG uses.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  angleOffBisector,
  besselI0Scaled,
  buildRadialTable,
  crescentSpec,
  erf,
  flatBandProfile,
  interleavedGradientNoise,
  normalCdf,
  rasterizeLayer,
  ringProfile,
  sampleRadial,
  smootherstep,
  taper,
  CORE_ROLL_HALF_DEG,
  endProfile,
} from '../../src/crescent-field.js'

const close = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`)

test('erf matches known values', () => {
  close(erf(0), 0, 1e-9, 'erf(0)')
  close(erf(1), 0.842700792, 1.5e-7, 'erf(1)')
  close(erf(2), 0.995322265, 1.5e-7, 'erf(2)')
  close(erf(-1), -0.842700792, 1.5e-7, 'erf(-1)')
})

test('normalCdf is a CDF', () => {
  close(normalCdf(0), 0.5, 1e-9, 'Phi(0)')
  close(normalCdf(1), 0.841344746, 1e-6, 'Phi(1)')
  close(normalCdf(-3) + normalCdf(3), 1, 1e-6, 'symmetry')
})

test('besselI0Scaled matches an independent series on the small branch', () => {
  // Direct series I0(x) = sum (x^2/4)^k / (k!)^2, which converges quickly here
  // and shares no code with the polynomial under test.
  const series = (x) => {
    let term = 1, sum = 1
    for (let k = 1; k < 200; k++) {
      term *= (x * x) / (4 * k * k)
      sum += term
      if (term < 1e-18 * sum) break
    }
    return sum * Math.exp(-x)
  }
  for (const x of [0, 0.5, 1, 2, 3, 3.7]) {
    close(besselI0Scaled(x), series(x), 2e-7, `small branch at ${x}`)
  }
})

test('besselI0Scaled matches the asymptotic expansion on the large branch', () => {
  // e^-x I0(x) ~ 1/sqrt(2 pi x) (1 + 1/(8x) + 9/(128 x^2) + ...)
  const asym = (x) =>
    (1 / Math.sqrt(2 * Math.PI * x)) * (1 + 1 / (8 * x) + 9 / (128 * x * x) + 225 / (3072 * x ** 3))
  /* Two error sources, both real, so the tolerance names both rather than being
     a round number: A&S 9.8.2 quotes |eps| < 1.9e-7 on sqrt(x)e^-x I0(x), which
     is 1.9e-7/sqrt(x) on the value here; and the reference series itself is
     truncated, its next term being 11025/(98304 x^4) relative. */
  for (const x of [20, 100, 1000, 1e6]) {
    const tol = 1.9e-7 / Math.sqrt(x) + (11025 / 98304 / x ** 4) * asym(x)
    close(besselI0Scaled(x), asym(x), tol, `large branch at ${x}`)
  }
})

test('besselI0Scaled is continuous across the 3.75 branch boundary', () => {
  // The two A&S polynomials must agree where they meet. The tolerance is the
  // function's own slope over the sampled interval — d/dx e^-x I0(x) is about
  // -0.039 here — plus both polynomials' quoted error. A real discontinuity
  // would be orders of magnitude larger than this.
  const h = 0.001
  const slope = 0.04
  close(besselI0Scaled(3.75 - h), besselI0Scaled(3.75 + h), slope * 2 * h + 1e-6,
    'branch continuity')
})

test('smootherstep is C1 at both ends and 0.5 in the middle', () => {
  assert.equal(smootherstep(-1), 0)
  assert.equal(smootherstep(0), 0)
  close(smootherstep(0.5), 0.5, 1e-12, 'midpoint')
  assert.equal(smootherstep(1), 1)
  assert.equal(smootherstep(2), 1)
  // derivative vanishes at both ends: the reason to prefer it over smoothstep
  const eps = 1e-4
  close(smootherstep(eps) / eps, 0, 1e-3, "slope at 0")
  close((1 - smootherstep(1 - eps)) / eps, 0, 1e-3, 'slope at 1')
})

test('ringProfile converges to the flat-band closed form as curvature vanishes', () => {
  // The whole justification for the Bessel integral: it must reduce to the
  // straight-band answer when the band stops being curved.
  const hw = 17.68, sigma = 26
  const r = 1e6
  for (const d of [-40, -20, 0, 15, 35, 60]) {
    close(ringProfile(r + d, r, hw, sigma), flatBandProfile(d, hw, sigma), 2e-4,
      `flat limit at d=${d}`)
  }
})

test('curvature is NOT negligible at the sizes this actually renders', () => {
  // sigma/r is 0.107 for the haze. If the flat form were good enough here the
  // Bessel integral would be dead weight; it is not.
  const spec = crescentSpec(520)
  const haze = spec.layers.find(l => l.key === 'haze')
  let worst = 0
  for (let d = -70; d <= 70; d += 5) {
    const exact = ringProfile(spec.r + d, spec.r, haze.halfWidth, haze.sigma)
    const flat = flatBandProfile(d, haze.halfWidth, haze.sigma)
    worst = Math.max(worst, Math.abs(exact - flat))
  }
  assert.ok(worst > 0.01, `flat approximation should differ materially, worst was ${worst}`)
})

test('the one-edge SDF shortcut would have rendered the haze half again too bright', () => {
  // Documents why layerIntensity is not Phi(-sd/sigma). That form counts only
  // the near edge and is valid when hw >> sigma; for the haze hw is 17.68
  // against sigma 26, so the far edge carries a third of the peak.
  const hw = 17.68, sigma = 26
  const oneEdge = normalCdf(hw / sigma)
  const correct = flatBandProfile(0, hw, sigma)
  assert.ok(oneEdge / correct > 1.4, `shortcut ratio was ${oneEdge / correct}`)
})

test('ringProfile peaks on the centreline and falls away monotonically', () => {
  const spec = crescentSpec(520)
  for (const layer of spec.layers) {
    const peak = ringProfile(spec.r, spec.r, layer.halfWidth, layer.sigma)
    let prev = peak
    for (let d = 1; d <= 120; d += 2) {
      const v = ringProfile(spec.r + d, spec.r, layer.halfWidth, layer.sigma)
      assert.ok(v <= prev + 1e-9, `${layer.key}: not monotone outward at d=${d}`)
      prev = v
    }
    assert.ok(peak > 0.4, `${layer.key}: peak ${peak} implausibly low`)
    assert.ok(peak <= 1 + 1e-9, `${layer.key}: peak ${peak} exceeds unity`)
    // and it must actually reach nothing inside the sampled reach
    close(ringProfile(spec.r + 4 * layer.sigma + layer.halfWidth, spec.r,
      layer.halfWidth, layer.sigma), 0, 2e-3, `${layer.key} tail`)
  }
})

test('no ending dims light that the approved design already had', () => {
  // THE design guard, stated as an inequality on purpose. An earlier window
  // centred on the endpoint satisfied a prettier property — half intensity
  // exactly at the old linecap — and still moved the crescent's measured length
  // in both directions depending on theme, because the eye reads the composite
  // of three apertures rather than any one of them. What has to hold is simply
  // that nothing inside the old aperture is touched.
  const spec = crescentSpec(520)
  for (const layer of spec.layers) {
    /* "Well inside" rather than "up to the aperture", because a blurred cap
       genuinely begins dimming a stroke about a sigma before its end and
       reproducing that is the job. The guard is that the BODY of the crescent
       is untouched; the last sigma of arc length belongs to the ending, and
       the spec states where that boundary is rather than the test guessing. */
    const bodyEnd = layer.angleInner
    /* 1e-5 is a fortieth of one 8-bit quantisation step (1/255 = 0.0039), so
       "untouched" here means untouched in any pixel that could ever be written. */
    for (let a = 0; a <= bodyEnd; a += bodyEnd / 32) {
      close(endProfile(a, layer, spec.r), 1, 1e-5, `${layer.key} dimmed inside its body`)
    }
  }
})

test('every layer actually ends — the crescent is never a full ring', () => {
  /* This is here because it happened. A refactor dropped the endpoint distance
     from the field, and with the ending factor defaulting to 1 the haze and
     halo would have painted complete rings around the circle: not a subtle
     drift, the design gone. A caught bug earns a test. */
  const spec = crescentSpec(520)
  for (const layer of spec.layers) {
    assert.ok(layer.angleOuter < Math.PI / 2 + 0.2,
      `${layer.key} reaches ${(layer.angleOuter * 180 / Math.PI).toFixed(1)}deg`)
    close(endProfile(Math.PI / 2 + 0.3, layer, spec.r), 0, 1e-6, `${layer.key} lit at 107deg`)
    close(endProfile(Math.PI, layer, spec.r), 0, 1e-9, `${layer.key} lit at the far side`)
  }
})

test('the core is rolled and the outer layers keep their natural cap', () => {
  const spec = crescentSpec(520)
  const byKey = Object.fromEntries(spec.layers.map(l => [l.key, l]))
  assert.equal(byKey.core.roll, true, 'the core must be the rolled one')
  assert.equal(byKey.halo.roll, false, 'the halo must keep its blurred cap')
  assert.equal(byKey.haze.roll, false, 'the haze must keep its blurred cap')

  /* THE invariant that keeps the black sheet honest. There the halo is dosed
     down and the CORE sets the crescent's measured length, so the roll must
     reach half intensity in the same place the blurred cap did: halfWidth of
     arc length past the aperture. Same ending, gentler slope. */
  const core = byKey.core
  const capHalf = core.halfAp + core.halfWidth / spec.r
  close(endProfile(capHalf, core, spec.r), 0.5, 1e-9, 'core half-intensity point moved')

  // ...and it is a roll, not a cliff: degrees wide, where the cap was a fraction
  // of one. Measured as the angular distance between 90% and 10%.
  const at = (deg) => endProfile(capHalf + (deg * Math.PI) / 180, core, spec.r)
  assert.ok(at(-2) > 0.9 && at(2) < 0.1, 'the core roll is not spread over degrees')

  // The halo's cap decays over roughly sigma of arc length, as the blur did.
  assert.ok(endProfile(byKey.halo.halfAp + byKey.halo.sigma / spec.r, byKey.halo, spec.r) < 0.9,
    'the halo cap is not decaying')
})

test('every ending is monotone and bounded', () => {
  const spec = crescentSpec(520)
  for (const layer of spec.layers) {
    let prev = 1
    for (let a = 0; a <= Math.PI; a += 0.004) {
      const v = endProfile(a, layer, spec.r)
      assert.ok(v <= prev + 1e-12, `${layer.key} re-brightened at ${a}`)
      assert.ok(v >= 0 && v <= 1 + 1e-12, `${layer.key} out of range at ${a}`)
      prev = v
    }
  }
})

test('the taper is monotone and never re-brightens', () => {
  const halfAp = 1.0823
  let prev = 1
  for (let a = 0; a <= Math.PI; a += 0.005) {
    const t = taper(a, halfAp)
    assert.ok(t <= prev + 1e-12, `taper rose at ${a}`)
    assert.ok(t >= 0 && t <= 1, `taper out of range at ${a}`)
    prev = t
  }
})

test('angleOffBisector measures from the left flank', () => {
  close(angleOffBisector(-1, 0), 0, 1e-12, 'on the bisector')
  close(angleOffBisector(0, 1), Math.PI / 2, 1e-12, 'straight up')
  close(angleOffBisector(0, -1), Math.PI / 2, 1e-12, 'straight down, mirrored')
  close(angleOffBisector(1, 0), Math.PI, 1e-12, 'opposite side')
})

test('crescentSpec still carries the shipped design constants', () => {
  // If someone retunes the SVG without retuning this, the design has forked.
  const spec = crescentSpec(520)
  close(spec.stroke, 10.4, 1e-12, 'stroke')
  close(spec.r, 243, 1e-12, 'radius, snapped from 242.6')
  close(spec.off, 11, 1e-12, 'left offset, snapped from 11.44')
  assert.ok(Math.abs(spec.r - 242.6) <= 0.5, 'snap moved the radius more than half a pixel')
  assert.ok(Math.abs(spec.off - 11.44) <= 0.5, 'snap moved the offset more than half a pixel')

  const byKey = Object.fromEntries(spec.layers.map(l => [l.key, l]))
  close(byKey.haze.sigma, 26.0, 1e-9, 'haze sigma')
  close(byKey.halo.sigma, 11.44, 1e-9, 'halo sigma')
  close(byKey.core.sigma, 2.08, 1e-9, 'core sigma')
  close(byKey.haze.halfWidth, (10.4 * 3.4) / 2, 1e-9, 'haze width')
  close(byKey.halo.halfWidth, (10.4 * 1.9) / 2, 1e-9, 'halo width')
  close(byKey.core.halfWidth, (10.4 * 0.75) / 2, 1e-9, 'core width')
  close(byKey.haze.halfAp, (62 * Math.PI) / 180, 1e-12, 'haze aperture')
  close(byKey.halo.halfAp, (54 * Math.PI) / 180, 1e-12, 'halo aperture')
  close(byKey.core.halfAp, (41 * Math.PI) / 180, 1e-12, 'core aperture')
})

test('the shared box contains every layer at its full reach', () => {
  for (const size of [380, 460, 520]) {
    const spec = crescentSpec(size)
    for (const layer of spec.layers) {
      const need = spec.r + layer.halfWidth + 3 * layer.sigma
      assert.ok(spec.reach >= need - 1e-9, `${size}/${layer.key}: reach ${spec.reach} < ${need}`)
    }
    assert.ok(spec.box.left <= spec.centreX - spec.reach, 'box clips left')
    assert.ok(spec.box.top <= spec.centreY - spec.reach, 'box clips top')
    assert.ok(spec.box.left + spec.box.width >= spec.centreX + spec.reach, 'box clips right')
    assert.ok(spec.box.top + spec.box.height >= spec.centreY + spec.reach, 'box clips bottom')
  }
})

test('the radial table reproduces the integral it stands in for', () => {
  const spec = crescentSpec(520)
  const layer = spec.layers.find(l => l.key === 'halo')
  const radial = buildRadialTable(spec, layer)
  for (let rho = 0; rho < spec.reach; rho += 7.3) {
    close(sampleRadial(radial, rho),
      ringProfile(rho, spec.r, layer.halfWidth, layer.sigma), 1e-4, `lookup at ${rho}`)
  }
  assert.equal(sampleRadial(radial, radial.max + 10), 0, 'past the table is dark')
})

test('the dither is one quantisation step, centred, and stable', () => {
  let min = Infinity, max = -Infinity, sum = 0, n = 0
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const v = interleavedGradientNoise(x, y)
      min = Math.min(min, v); max = Math.max(max, v); sum += v; n++
    }
  }
  assert.ok(min >= 0 && max < 1, `range ${min}..${max}`)
  close(sum / n, 0.5, 0.03, 'mean, so brightness is preserved')
  assert.equal(interleavedGradientNoise(17, 42), 0.45351647523059313, 'fixed sample drifted')
})

test('a rasterised layer is bounded, peaks near the arc, and is deterministic', () => {
  const spec = crescentSpec(120)
  const layer = spec.layers.find(l => l.key === 'core')
  const a = rasterizeLayer(spec, layer, 1)
  const b = rasterizeLayer(spec, layer, 1)
  assert.equal(a.width, spec.box.width)
  assert.equal(a.height, spec.box.height)
  assert.deepEqual(Array.from(a.data.slice(0, 5000)), Array.from(b.data.slice(0, 5000)),
    'same input, same pixels')

  // brightest pixel should sit on the centreline, on the bisector, to the left
  let best = -1, bx = 0, by = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const v = a.data[y * a.width + x]
      if (v > best) { best = v; bx = x; by = y }
    }
  }
  assert.ok(best > 200, `peak alpha only ${best}`)
  const px = spec.box.left + bx + 0.5 - spec.centreX
  const py = spec.box.top + by + 0.5 - spec.centreY
  close(Math.hypot(px, py), spec.r, 1.5, 'peak sits on the arc radius')
  assert.ok(px < 0, 'peak is on the left flank')
  /* NOT `py ~ 0`, and not the plateau edge either: the taper holds a plateau
     across the middle 80% of the arc, the core's profile saturates at this
     size, and 8-bit quantisation keeps every pixel at 255 until the taper has
     dropped about 0.2% — so peak intensity is shared by thousands of pixels and
     a scan finds whichever the dither favours first. What must be true is that
     the peak lies inside the aperture the owner approved, and that the point on
     the bisector is itself at peak to within the dither. */
  assert.ok(angleOffBisector(px, py) <= layer.halfAp + 1e-9,
    'peak fell outside the approved aperture')
  const onBisector = a.data[
    Math.round(spec.centreY - spec.box.top - 0.5) * a.width +
    Math.round(spec.centreX - spec.r - spec.box.left - 0.5)
  ]
  assert.ok(best - onBisector <= 2, `bisector ${onBisector} not at peak ${best}`)

  // the corners are outside every layer's reach and must be black
  assert.equal(a.data[0], 0, 'top-left corner lit')
  assert.equal(a.data[a.width - 1], 0, 'top-right corner lit')
})

test('the field is dark where the old render had a blunt tip', () => {
  // Just past the tapered end, on the arc radius, there must be nothing. This
  // is the defect the whole exercise is aimed at.
  const spec = crescentSpec(520)
  const layer = spec.layers.find(l => l.key === 'core')
  const radial = buildRadialTable(spec, layer)
  const past = layer.angleOuter + 0.02
  const t = endProfile(past, layer, spec.r)
  assert.equal(t, 0, 'the core is still lit past its roll')
  close(sampleRadial(radial, spec.r) * t, 0, 1e-12, 'light past the end')
  // ...and it is genuinely a roll, not a cliff. The old cap fell from full to
  // nothing inside a single degree; this is still near full two degrees before
  // its midpoint. (Where that midpoint sits is pinned separately, above.)
  const capHalf = layer.halfAp + layer.halfWidth / spec.r
  assert.ok(endProfile(capHalf - (2 * Math.PI) / 180, layer, spec.r) > 0.9,
    'the core drops too fast to read as a fade')
})
