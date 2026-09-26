/* The home hero's crescent, computed instead of approximated.
   ============================================================

   The design is unchanged, and this file is the reason it can stay unchanged:
   what the page draws today is a *sum of Gaussian-blurred arcs*, and that is a
   mathematical object with a closed form. Rather than hand three stroked paths
   to `feGaussianBlur` and accept whatever Chromium's three-pass box blur
   returns, this evaluates the same object exactly, per pixel.

   Why that is worth doing — each of these is measured in the shipped render at
   size 520, not hypothetical:

     * The core arc is blurred at sigma 2.08, which is to say barely, so its two
       ends are visible blunt tips where a round linecap stops. Light does not
       end. Here that cap is replaced by a roll-off centred on the cap's own
       half-intensity point, so the core still reaches half brightness exactly
       where it always did and only the slope changes.
     * The three blur radii step 5.5x then 2.27x, leaving a shoulder in the
       falloff just outside the core. A closed form has no ladder.
     * The haze's filter region cleared its own blur by 0.85px (bbox width
       128.70, region edge -79.13, light wanting -78.28), and every term scales
       with `size`, so it is that tight at every size. There is no filter here,
       so there is no region to clear.
     * Stacked 8-bit translucent layers band. This dithers before quantising.

   Nothing here knows about the DOM, canvases or colour. It returns intensity,
   0..1; the per-theme hue table in home.css keeps doing the colour, untouched,
   which is what keeps its measured contrast ratios true.
*/

/** Abramowitz & Stegun 7.1.26. |error| < 1.5e-7 — a quarter of a bit at 8-bit
 *  output, well under what the dither below moves anyway. */
export function erf(x) {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const poly = t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))))
  return sign * (1 - poly * Math.exp(-ax * ax))
}

/** Standard normal CDF. */
export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/**
 * Exponentially scaled modified Bessel function of the first kind, exp(-x)*I0(x),
 * for x >= 0. A&S 9.8.1 / 9.8.2.
 *
 * The scaled form is not a micro-optimisation, it is the only numerically sane
 * way to do this: the ring integral below wants exp(-(rho^2+r^2)/2sigma^2)*I0(rho*r/sigma^2),
 * and at the working values those factors are ~2e-38 and ~2e37. Multiplying
 * them as written throws away most of the mantissa; regrouped as
 * exp(-(rho-r)^2/2sigma^2) * [exp(-x)I0(x)] both factors are O(1).
 */
export function besselI0Scaled(x) {
  const ax = Math.abs(x)
  if (ax < 3.75) {
    const t = ax / 3.75
    const y = t * t
    const i0 = 1 + y * (3.5156229 +
      y * (3.0899424 +
      y * (1.2067492 +
      y * (0.2659732 +
      y * (0.0360768 +
      y * 0.0045813)))))
    return i0 * Math.exp(-ax)
  }
  const t = 3.75 / ax
  const poly = 0.39894228 +
    t * (0.01328592 +
    t * (0.00225319 +
    t * (-0.00157565 +
    t * (0.00916281 +
    t * (-0.02057706 +
    t * (0.02635537 +
    t * (-0.01647633 +
    t * 0.00392377)))))))
  return poly / Math.sqrt(ax)
}

/** Perlin's smootherstep — C2 continuous where the classic smoothstep is only
 *  C1. On a gradient this wide the second derivative shows as a faint crease at
 *  the plateau edge, so the extra term earns its keep. */
export function smootherstep(t) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * The radial profile of a straight band of half-width `hw` blurred by `sigma`:
 * a rect convolved with a Gaussian, in closed form.
 *
 * Kept because it is the flat-curvature limit of `ringProfile` below and makes
 * a sharp test of it — but NOT used to render. It is the approximation the
 * obvious implementation reaches for, and it is wrong here in a way worth
 * spelling out: it assumes the band is straight. It also must not be confused
 * with the even more tempting one-edge form `Phi(-sd/sigma)`, which only counts
 * the near edge and is valid when hw >> sigma. For the haze hw is 17.68 against
 * sigma 26, so the far edge contributes a third of the peak; that shortcut
 * would have rendered the haze half again too bright.
 */
export function flatBandProfile(d, hw, sigma) {
  return normalCdf((hw - d) / sigma) + normalCdf((hw + d) / sigma) - 1
}

/**
 * The radial profile of an annular band of radius `r` and half-width `hw`
 * blurred by a 2-D Gaussian of width `sigma`, evaluated at radius `rho`.
 *
 * Blurring a radially symmetric f is a Hankel convolution:
 *
 *   (f * G)(rho) = integral f(r') (r'/sigma^2) exp(-(rho^2+r'^2)/2sigma^2) I0(rho r'/sigma^2) dr'
 *
 * which for the band indicator is the integral below, regrouped for numerical
 * stability as noted on `besselI0Scaled`. This is the exact answer for a curved
 * band, and it matters: sigma/r is 0.107 for the haze, so the flat form is off
 * by a few percent and asymmetrically — brighter on the inside of the curve
 * than the outside, which is precisely the kind of error that reads as "the
 * glow sits wrong on the circle".
 *
 * Simpson's rule over the band; `steps` must be even.
 */
export function ringProfile(rho, r, hw, sigma, steps = 64) {
  const a = Math.max(0, r - hw)
  const b = r + hw
  const h = (b - a) / steps
  const inv2s2 = 1 / (2 * sigma * sigma)
  const invs2 = 1 / (sigma * sigma)
  const term = (rp) => {
    const dr = rho - rp
    return rp * invs2 * Math.exp(-dr * dr * inv2s2) * besselI0Scaled(rho * rp * invs2)
  }
  let sum = term(a) + term(b)
  for (let i = 1; i < steps; i++) {
    sum += term(a + i * h) * (i % 2 ? 4 : 2)
  }
  return (sum * h) / 3
}

/** Angle off the bisector, 0..pi. The crescent hugs the circle's left flank, so
 *  the bisector is -X. Shared by the taper and the reach so they cannot
 *  disagree about where an end is. */
export function angleOffBisector(qx, qy) {
  return Math.atan2(Math.abs(qy), -qx)
}

/* ONE layer's ending is changed, and it is the only one that needed to be.
 *
 * `endProfile` below reproduces a blurred round linecap for every layer. For
 * the haze (sigma 26) and the halo (sigma 11.4) that decay is genuinely soft —
 * 6.1 and 2.7 degrees of smear at this radius — and their ends were never the
 * problem, so they keep it exactly.
 *
 * The core's blur is sigma 2.08 against a 7.8px stroke, so its cap survives the
 * blur nearly intact: half a degree of smear. That is the blunt tip visible in
 * the reference at ten o'clock and seven o'clock — a bright stroke that stops
 * while everything around it is soft. It is replaced by a smootherstep spread
 * over +/-3.5 degrees, CENTRED on the point where the old cap crossed half
 * intensity, so the ending stays where it was and only its slope changes.
 *
 * Three windows were tried and measured before this one. Each is recorded
 * because each was wrong for a different, non-obvious reason:
 *   0.80-1.20 of the aperture, all layers: -3.3deg of length on white and tan,
 *     +1.5deg on black. It dimmed the HALO from 0.8 of its aperture outward,
 *     and the halo's 54deg end is what sets the composite's crossing at ~53deg.
 *   1.00-1.25, all layers: +5.1deg. Rolling the halo out to 67deg put light
 *     well past where its blurred cap used to die.
 *   Core only, rolling outward from the aperture: white and tan came right,
 *     black stayed +2.9deg long — because there `--cres-halo-o` doses the halo
 *     down and the core alone sets the length, so a roll that only adds light
 *     past the aperture necessarily lengthens it.
 * Centring the roll on the cap's half-intensity point is what satisfies all
 * three sheets at once.
 */
export const CORE_ROLL_HALF_DEG = 3.5

/**
 * 1 through the body of the arc, rolling to 0 past the aperture.
 *
 * `taperOut` of 1 (or less) means NO taper: the layer keeps the naturally
 * blurred round cap that `arcDistance` already gives it, which is what the
 * halo and haze want. Anything above 1 rolls off between the aperture and that
 * multiple of it.
 */
export function taper(angle, halfAp, taperOut = 1) {
  if (taperOut <= 1) return 1
  const outer = taperOut * halfAp
  if (angle <= halfAp) return 1
  if (angle >= outer) return 0
  return 1 - smootherstep((angle - halfAp) / (outer - halfAp))
}

/**
 * How a layer ends, as a factor on its radial profile.
 *
 * Two endings, and which one a layer gets is the single design decision in
 * this file:
 *
 *   NATURAL (taperOut <= 1) — the blurred round linecap the SVG already drew.
 *   The stroke's cap reaches `halfWidth` of arc length past the aperture and
 *   the blur spreads it over sigma, so the factor is the Gaussian CDF of the
 *   distance past that cap, normalised to 1 at the aperture so the body and
 *   the ending meet without a seam. This is what the haze and halo keep: their
 *   endings were never the defect and changing them moves the crescent's
 *   measured length.
 *
 *   ROLLED (layer.roll) — the cap is REPLACED, not multiplied, by a
 *   smootherstep. Multiplying would be pointless for the core: its own cap
 *   decays over half a degree, so it would kill the light long before any roll
 *   could soften it. The core is the one layer whose blur is too small to hide
 *   its cap, which is why it is the one layer that gets this.
 *
 *   The roll is CENTRED on the half-intensity point of the cap it replaces —
 *   `halfWidth` of arc length past the aperture, where the old blurred cap
 *   crossed 0.5 — so the core still reaches half brightness in exactly the same
 *   place and only the slope changes. That centring is not cosmetic: on the
 *   black sheet `--cres-halo-o` doses the halo down and the CORE is what sets
 *   the crescent's measured length, so a roll that merely extended outward from
 *   the aperture made the crescent 2.9deg longer there while leaving white and
 *   tan alone. Same ending, gentler slope, no drift.
 */
export function endProfile(angle, layer, r) {
  if (layer.roll) {
    const mid = layer.halfAp + layer.halfWidth / r
    const half = (CORE_ROLL_HALF_DEG * Math.PI) / 180
    if (angle <= mid - half) return 1
    if (angle >= mid + half) return 0
    return 1 - smootherstep((angle - (mid - half)) / (2 * half))
  }
  /* Arc length past the aperture, signed — negative inside it. Evaluating the
     cut for every angle rather than clamping to 1 inside is what makes this
     continuous AND right: a blurred cap starts dimming the stroke about a sigma
     BEFORE its end, and a version that held 1 until the aperture and only then
     began to decay measured 2.2deg too long. There is no normalising constant
     here for the same reason — forcing the factor to 1 at the aperture is
     exactly the error that produced that overshoot. */
  const s = r * (angle - layer.halfAp)
  return normalCdf((layer.halfWidth - s) / layer.sigma)
}

/**
 * The three layers, derived from the constants the shipped SVG uses so there is
 * one source of truth for the design:
 *
 *   stroke = max(7, size * 0.02)
 *   r      = (size - stroke*2 - 14) / 2
 *   off    = max(4, size * 0.022)
 *
 *   haze  118..242deg  width stroke*3.4   sigma size*0.05    (opacity 0.42 in CSS)
 *   halo  126..234deg  width stroke*1.9   sigma size*0.022   (opacity 0.78)
 *   core  139..221deg  width stroke*0.75  sigma size*0.004   (opacity 0.95)
 *
 * The opacities are NOT baked in here. They stay in home.css, per layer, where
 * `--cres-halo-o` doses the haze and halo on the black sheet but deliberately
 * leaves the core alone. Folding the layers together would collapse that
 * distinction and dim the black theme, so three layers stay three layers and
 * the CSS contract is preserved exactly.
 *
 * `r` and `off` are snapped to whole pixels here (242.6 -> 243, 11.44 -> 11).
 * The rim is a 2px stroke centred on that radius; on a fractional one it paints
 * as two partial-alpha rows instead of one line, which is why the shipped ring
 * reads soft rather than drawn.
 */
export function crescentSpec(size) {
  const stroke = Math.max(7, size * 0.02)
  const r = Math.round((size - stroke * 2 - 14) / 2)
  const off = Math.round(Math.max(4, size * 0.022))
  const deg = (d) => (d * Math.PI) / 180

  const layers = [
    { key: 'haze', halfAp: deg(62), halfWidth: (stroke * 3.4) / 2, sigma: size * 0.05, roll: false },
    { key: 'halo', halfAp: deg(54), halfWidth: (stroke * 1.9) / 2, sigma: size * 0.022, roll: false },
    { key: 'core', halfAp: deg(41), halfWidth: (stroke * 0.75) / 2, sigma: size * 0.004, roll: true },
  ]
  /* Where each layer's light actually stops, angularly. A rolled layer ends
     where its roll ends; a naturally capped one where its cap has decayed
     through three sigma of arc length. Both are needed by the raster's cheap
     rejection test. */
  for (const l of layers) {
    l.angleOuter = l.roll
      ? l.halfAp + l.halfWidth / r + (CORE_ROLL_HALF_DEG * Math.PI) / 180
      : l.halfAp + (l.halfWidth + 3 * l.sigma) / r
    /* Where the ending starts biting, so the raster can hold intensity at 1 up
       to here without an atan2. */
    l.angleInner = l.roll
      ? l.halfAp + l.halfWidth / r - (CORE_ROLL_HALF_DEG * Math.PI) / 180
      : l.halfAp - (l.halfWidth + 3 * l.sigma) / r
  }
  /* Each layer's own reach, as well as the shared one. The box has to hold the
     haze, but the core dies within 253px of the centre and skipping the rest of
     the box for it is most of why this renders in tens of milliseconds rather
     than hundreds. */
  for (const l of layers) l.reach = r + l.halfWidth + 3 * l.sigma

  const reach = Math.ceil(Math.max(...layers.map(l => l.reach)))

  /* One box shared by all three layers, in `.uring` coordinates, so the masks
     stack under a single position rule instead of three. */
  const centreX = size / 2 - off
  const centreY = size / 2
  const box = { left: Math.floor(centreX - reach), top: Math.floor(centreY - reach), width: 0, height: 0 }
  box.width = Math.ceil(centreX + reach) - box.left
  box.height = Math.ceil(centreY + reach) - box.top

  return { size, stroke, r, off, centreX, centreY, reach, box, layers }
}

/**
 * A layer's radial profile, sampled onto a table so the raster is a lookup
 * rather than a Bessel quadrature per pixel.
 *
 * The profile depends only on rho, so one table serves every pixel; `step` of a
 * quarter CSS pixel is far finer than the profile's own curvature, and the
 * lookup interpolates linearly between entries.
 */
export function buildRadialTable(spec, layer, step = 0.25) {
  const max = spec.reach + 2
  const n = Math.ceil(max / step) + 2
  const table = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    table[i] = ringProfile(i * step, spec.r, layer.halfWidth, layer.sigma)
  }
  return { table, step, max }
}

/** Linear interpolation into a radial table. */
export function sampleRadial(radial, rho) {
  if (rho >= radial.max) return 0
  const t = rho / radial.step
  const i = t | 0
  const f = t - i
  const a = radial.table[i]
  const b = radial.table[i + 1] ?? 0
  return a + (b - a) * f
}

/** Interleaved Gradient Noise (Jimenez). One quantisation step, centred, so the
 *  mean is preserved — the standard fix for banding in a smooth ramp, and the
 *  thing stacked translucent layers could never be made to stop doing. */
export function interleavedGradientNoise(px, py) {
  return (52.9829189 * ((0.06711056 * px + 0.00583715 * py) % 1)) % 1
}

/**
 * Rasterise one layer into an 8-bit alpha plane at `scale` device pixels per
 * CSS pixel.
 *
 * Sampling is at pixel centres with no supersampling, and none is needed: the
 * field is smooth everywhere by construction, so there are no edges to alias —
 * itself a property the stroked-and-blurred version never had.
 */
/* A shared single pass over all three layers looks like the obvious next
   optimisation — the layers share a box, a centre and every square root — and
   it was written, measured and thrown away: 67ms against 53ms at scale 2. The
   per-layer loops win because their inner loop holds monomorphic locals, where
   the shared version has to walk an array of layer objects per pixel. It was
   pixel-for-pixel identical (max difference 0), so this is a speed finding, not
   a correctness one. Do not re-derive it. */
export function rasterizeLayer(spec, layer, scale, radial = buildRadialTable(spec, layer)) {
  const w = Math.round(spec.box.width * scale)
  const h = Math.round(spec.box.height * scale)
  const out = new Uint8ClampedArray(w * h)

  const inner = layer.angleInner
  const outer = layer.angleOuter
  /* The ending needs an angle, and atan2 is the most expensive thing in this
     loop by a wide margin. It is only actually needed between the aperture and
     the layer's outer limit: with cos(angle) = -x/rho, "angle <= inner" is
     "-x >= cosInner*rho" and "angle >= outer" is "-x <= cosOuter*rho", both of
     which fall out of values already in hand. Every pixel in the body of the
     crescent — nearly all of the lit ones — skips the call entirely. Valid
     while both bounds stay inside a right angle, which they do here (the widest
     is 71.3deg), and guarded rather than assumed. */
  const wedgeOnly = outer < Math.PI / 2
  const cosInner = Math.cos(inner)
  const cosOuter = Math.cos(outer)
  const reach2 = layer.reach * layer.reach

  /* The field is mirror-symmetric about the bisector, so only half the rows are
     computed and the other half is reflected. The dither is NOT reflected — it
     is recomputed per pixel — because a mirrored noise field reads as a seam
     down the middle, which is the one artefact this is here to avoid. */
  const mirrorLast = Math.round(2 * scale * (spec.centreY - spec.box.top)) - 1
  const symmetric = mirrorLast === h - 1

  const rowsToDo = symmetric ? Math.ceil(h / 2) : h
  for (let py = 0; py < rowsToDo; py++) {
    const y = spec.box.top + (py + 0.5) / scale - spec.centreY
    const yy = y * y
    const mirrorPy = symmetric ? mirrorLast - py : -1
    for (let px = 0; px < w; px++) {
      const x = spec.box.left + (px + 0.5) / scale - spec.centreX
      const d2 = x * x + yy
      if (d2 > reach2) continue
      const nx = -x
      let t
      if (wedgeOnly) {
        const rho0 = Math.sqrt(d2)
        if (nx >= cosInner * rho0) t = 1
        else if (nx <= cosOuter * rho0) continue
        else t = endProfile(Math.atan2(Math.abs(y), nx), layer, spec.r)
        const v = sampleRadial(radial, rho0) * t
        out[py * w + px] = Math.round((v + (interleavedGradientNoise(px, py) - 0.5) / 255) * 255)
        if (mirrorPy > py) {
          out[mirrorPy * w + px] =
            Math.round((v + (interleavedGradientNoise(px, mirrorPy) - 0.5) / 255) * 255)
        }
        continue
      }
      t = endProfile(angleOffBisector(x, y), layer, spec.r)
      if (t <= 0) continue
      const v = sampleRadial(radial, Math.sqrt(d2)) * t
      out[py * w + px] = Math.round((v + (interleavedGradientNoise(px, py) - 0.5) / 255) * 255)
      if (mirrorPy > py) {
        out[mirrorPy * w + px] =
          Math.round((v + (interleavedGradientNoise(px, mirrorPy) - 0.5) / 255) * 255)
      }
    }
  }
  return { data: out, width: w, height: h }
}
