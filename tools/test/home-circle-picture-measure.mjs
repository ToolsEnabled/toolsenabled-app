/* PURE measurement of the home-circle body's PICTURE.
 *
 * WHY THIS FILE IS PURE AND SEPARATE. Every arithmetic assertion in this lane
 * was green while the owner rejected the picture on sight. The hole was that
 * nothing measured what a person sees. These functions take RGBA pixels and
 * return numbers about them, with no browser, no network and no dependency, so
 * they can be exercised against SYNTHETIC images whose right answer is known by
 * construction -- which is the only way to know the instrument works before
 * pointing it at the shader.
 *
 * Nothing here reads src/. A gate built on these functions cannot pin the
 * shader's spelling, because it never sees the shader's text.
 *
 * Pixels are {data: Uint8ClampedArray|Buffer (RGBA, 8-bit sRGB), width, height}.
 */

/* ---------------------------------------------------------------- colour */

export function srgbToLinear (v) {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/* Oklab. Used for hue and chroma because this lane's whole complaint is
   "raspberry turned into gravy" -- a perceptual judgement. HSV hue calls brown
   and orange the same colour (brown IS dark orange), so HSV hue alone cannot
   express the defect being gated. */
export function oklabFromSrgb (r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  }
}

export function oklchFromSrgb (r, g, b) {
  const lab = oklabFromSrgb(r, g, b)
  let h = Math.atan2(lab.b, lab.a) * 180 / Math.PI
  if (h < 0) h += 360
  return { L: lab.L, C: Math.hypot(lab.a, lab.b), h }
}

export function linearToSrgb (c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

/* The inverse of oklchFromSrgb. Lets a test build a body directly in the space
   the gates judge, so a synthetic case can be given an exact lightness, chroma
   and hue instead of being hand-tuned in RGB until it looks about right. */
export function srgbFromOklch (L, C, hDeg) {
  const h = hDeg * Math.PI / 180
  const a = C * Math.cos(h), b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  ]
}

export function hsv (r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  let h = 0
  if (d > 1e-9) {
    if (max === R) h = 60 * (((G - B) / d) % 6)
    else if (max === G) h = 60 * ((B - R) / d + 2)
    else h = 60 * ((R - G) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/* Smallest signed angle a to b, in degrees, in (-180, 180]. */
export function hueGap (a, b) {
  const d = ((b - a) % 360 + 540) % 360 - 180
  return d === -180 ? 180 : d
}

/* Circular mean of hues, optionally weighted. Averaging 359 and 1 arithmetically
   gives 180 -- the opposite colour -- so hue is never averaged linearly here. */
export function meanHue (hues, weights = null) {
  let x = 0, y = 0
  for (let i = 0; i < hues.length; i++) {
    const w = weights ? weights[i] : 1
    x += w * Math.cos(hues[i] * Math.PI / 180)
    y += w * Math.sin(hues[i] * Math.PI / 180)
  }
  if (Math.hypot(x, y) < 1e-12) return NaN
  const h = Math.atan2(y, x) * 180 / Math.PI
  return h < 0 ? h + 360 : h
}

/* ------------------------------------------------------------- geometry */

/* The body's silhouette: pixels that differ from the KNOWN ground they were
   composited over. The caller sets that ground, so this is a measurement and
   not a guess about what the backdrop was. */
export function bodyMask (px, backdrop, minDelta = 10) {
  const mask = new Uint8Array(px.width * px.height)
  const d = px.data
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const diff = (Math.abs(d[i] - backdrop[0]) + Math.abs(d[i + 1] - backdrop[1]) + Math.abs(d[i + 2] - backdrop[2])) / 3
    mask[p] = diff > minDelta ? 1 : 0
  }
  return mask
}

/* How far each pixel is from the ground it was composited over. */
export function inkField (px, backdrop) {
  const ink = new Float64Array(px.width * px.height)
  const d = px.data
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    ink[p] = (Math.abs(d[i] - backdrop[0]) + Math.abs(d[i + 1] - backdrop[1]) + Math.abs(d[i + 2] - backdrop[2])) / 3
  }
  return ink
}

/* Otsu's threshold: the split that maximises between-class variance.
 *
 * WHY NOT A CONSTANT. A fixed ink cutoff is a number tuned to today's render,
 * and today's render is the thing being rejected -- so it would have to be
 * retuned every time the body gets brighter, and "retune the instrument until
 * it agrees" is how this lane got green numbers over a bad picture. Otsu reads
 * the split out of the image's own histogram, so it follows a body that gets
 * brighter instead of having to be chased. */
export function otsuThreshold (values) {
  const bins = new Float64Array(256)
  let n = 0
  for (let i = 0; i < values.length; i++) {
    let v = Math.round(values[i])
    if (v < 0) v = 0; else if (v > 255) v = 255
    bins[v]++; n++
  }
  if (!n) return 0
  let total = 0
  for (let v = 0; v < 256; v++) total += v * bins[v]
  let sumB = 0, wB = 0, best = -1, threshold = 0
  for (let v = 0; v < 256; v++) {
    wB += bins[v]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += v * bins[v]
    const mB = sumB / wB, mF = (total - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; threshold = v }
  }
  return threshold
}

/* The body, found from the image's own histogram rather than a tuned constant. */
export function bodyMaskAuto (px, backdrop) {
  const ink = inkField(px, backdrop)
  const threshold = otsuThreshold(ink)
  const mask = new Uint8Array(ink.length)
  let covered = 0
  for (let p = 0; p < ink.length; p++) if (ink[p] > threshold) { mask[p] = 1; covered++ }
  return { mask, threshold, covered, ink }
}

/* Chamfer distance from every masked pixel to the nearest unmasked one. This is
   the thickness proxy: a blob is optically thickest where it is furthest from
   its own edge and thins to nothing at the silhouette. Two passes, 3-4 chamfer,
   which is exact enough for banding and needs no dependency. */
export function distanceInward (mask, width, height) {
  const INF = 1e9
  const dist = new Float64Array(width * height)
  for (let p = 0; p < dist.length; p++) dist[p] = mask[p] ? INF : 0
  const put = (p, v) => { if (v < dist[p]) dist[p] = v }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!mask[p]) continue
      if (x > 0) put(p, dist[p - 1] + 3)
      if (y > 0) put(p, dist[p - width] + 3)
      if (x > 0 && y > 0) put(p, dist[p - width - 1] + 4)
      if (x < width - 1 && y > 0) put(p, dist[p - width + 1] + 4)
      if (x === 0 || y === 0 || x === width - 1) put(p, 3) // the crop edge is an edge
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const p = y * width + x
      if (!mask[p]) continue
      if (x < width - 1) put(p, dist[p + 1] + 3)
      if (y < height - 1) put(p, dist[p + width] + 3)
      if (x < width - 1 && y < height - 1) put(p, dist[p + width + 1] + 4)
      if (x > 0 && y < height - 1) put(p, dist[p + width - 1] + 4)
      if (y === height - 1) put(p, 3)
    }
  }
  for (let p = 0; p < dist.length; p++) dist[p] = mask[p] ? dist[p] / 3 : 0
  return dist
}

/* --------------------------------------------------------- the measures */

/* Bin the body by thickness and report colour per band. Band 0 is the thin rim,
   the last band is the thick core. */
export function thicknessBands (px, mask, dist, bandCount = 8, { exclude = null } = {}) {
  let peak = 0
  for (let p = 0; p < dist.length; p++) if (dist[p] > peak) peak = dist[p]
  if (!peak) return []
  const bands = Array.from({ length: bandCount }, () => ({ n: 0, L: 0, C: 0, hues: [], weights: [], v: 0, s: 0 }))
  const d = px.data
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p]) continue
    /* `exclude` (the specular catch, from specularPeaks) keeps colourless
       highlight pixels out of the colour means: on 2026-09-18 the band the
       white catch lies in read a 0.020 chroma "dip" with the hue steady at
       19-25 degrees -- a highlight, not the brown band this gate exists for. */
    if (exclude && exclude[p]) continue
    let k = Math.floor((dist[p] / peak) * bandCount)
    if (k >= bandCount) k = bandCount - 1
    if (k < 0) k = 0
    const band = bands[k]
    const lch = oklchFromSrgb(d[i], d[i + 1], d[i + 2])
    const t = hsv(d[i], d[i + 1], d[i + 2])
    band.n++; band.L += lch.L; band.C += lch.C; band.v += t.v; band.s += t.s
    band.hues.push(lch.h); band.weights.push(lch.C) // a grey pixel has no meaningful hue; weight by chroma
  }
  return bands.map((b, k) => ({
    band: k,
    thickness: (k + 0.5) / bandCount,
    pixels: b.n,
    L: b.n ? b.L / b.n : NaN,
    C: b.n ? b.C / b.n : NaN,
    hue: b.n ? meanHue(b.hues, b.weights) : NaN,
    value: b.n ? b.v / b.n : NaN,
    sat: b.n ? b.s / b.n : NaN
  })).filter(b => b.pixels > 0)
}

/* GATE M1 -- interior change under two grounds.
 * An opaque body composites identically over any ground and scores zero here.
 * The caller reports this against a CONTROL (two captures over the SAME ground)
 * so the animation's own frame-to-frame motion cannot be mistaken for
 * transmission. */
export function interiorChange (a, b, mask, dist, innerFraction = 0.45) {
  let peak = 0
  for (let p = 0; p < dist.length; p++) if (dist[p] > peak) peak = dist[p]
  const floor = peak * innerFraction
  let n = 0, total = 0
  const A = a.data, B = b.data
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p] || dist[p] < floor) continue
    total += (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3
    n++
  }
  return { meanDelta: n ? total / n : 0, pixels: n }
}

/* GATE M1, the number the gate is actually allowed to judge.
 *
 * THE TRAP THIS EXISTS TO AVOID, measured on the real body 2026-09-18. Reporting
 * the interior change against the same-ground CONTROL gives a ratio of 14x on a
 * body that is opaque: the ground moved by 91 units and the interior moved by
 * 0.101, while the control's own frame-to-frame noise was only 0.007. A gate
 * written as "changed must beat control" calls that a PASS. It is a transmission
 * of 0.1%.
 *
 * So the gate judges the FRACTION of the ground change that reaches the
 * interior, which is 1 - alpha and is a property of the body alone, and uses the
 * control only as a noise floor: the change must also be clear of the animation's
 * own movement, or the fraction is not attributable to the ground. */
export function transmission (withGroundA, withGroundB, groundA, groundB, mask, dist, innerFraction = 0.45) {
  const separation = (Math.abs(groundA[0] - groundB[0]) + Math.abs(groundA[1] - groundB[1]) + Math.abs(groundA[2] - groundB[2])) / 3
  if (separation < 1) throw new Error('transmission: the two grounds are the same; nothing could show through')
  const moved = interiorChange(withGroundA, withGroundB, mask, dist, innerFraction)
  return { fraction: moved.meanDelta / separation, meanDelta: moved.meanDelta, separation, pixels: moved.pixels }
}

/* GATE M5 -- the silhouette is a razor, and there is no halo outside it.
 * edgeWidth: how far the body takes to fall from mostly-there (80% of the
 * ray's peak ink) to mostly-gone (20%), measured along rays from the body's
 * centroid, as a fraction of body radius. haloEnergy: mean ink OUTSIDE that
 * 20% point, out to 1.5x the radius -- a soft skirt lives exactly there.
 *
 * WHY 20% AND NOT 10% FOR THE OUTER END, measured 2026-09-18 on the live body:
 * the render carries a faint glow of 10-20 ink units round a body whose peak
 * is ~120, i.e. 8-16% of peak. With the outer end at 10% the walk down the ray
 * ran out INTO that glow, so the glow was counted as edge width (0.63-0.85 of
 * the radius) and the halo annulus beyond it read the black ground (0.6-2.1)
 * and passed. Two measures, both attributing the same defect to the wrong
 * name. The 20% point stops at the body's own foot; whatever lies past it is
 * halo and is scored as halo. */
export function silhouetteProfile (px, mask, backdrop, rays = 180) {
  const width = px.width, height = px.height
  let cx = 0, cy = 0, n = 0
  for (let p = 0; p < mask.length; p++) if (mask[p]) { cx += p % width; cy += Math.floor(p / width); n++ }
  if (!n) return { radius: 0, edgeWidth: NaN, haloEnergy: NaN, rays: 0, pixels: 0 }
  cx /= n; cy /= n
  const d = px.data
  const ink = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null
    const i = (yi * width + xi) * 4
    return (Math.abs(d[i] - backdrop[0]) + Math.abs(d[i + 1] - backdrop[1]) + Math.abs(d[i + 2] - backdrop[2])) / 3
  }
  const maxR = Math.min(cx, cy, width - cx, height - cy) - 1
  const widths = [], halos = [], radii = []
  for (let k = 0; k < rays; k++) {
    const th = (k / rays) * Math.PI * 2, ux = Math.cos(th), uy = Math.sin(th)
    /* THE REFERENCE LEVEL IS THE BODY AT ITS RIM, NOT THE RAY'S BRIGHTEST PIXEL.
       This read `peak = max ink along the whole ray`, which is the same number
       only while the body is flat. Measured 2026-09-18 on shader c4384adb: on
       black the body is flat, peak 69 sits on the plateau and the edge measured
       0.075 of the radius -- a razor, correctly. On cobalt and ember the body
       carries the wet catch M9 REQUIRES, and that catch is the ray's maximum:
       peak 217 at the centre against a rim plateau of 124. Four fifths of 217
       is 174, a level reached nowhere but inside the catch, so the "80% to 20%
       fall" spanned the entire body and the gate reported edge width 0.86 and
       0.87 -- a soft edge, on a silhouette whose ink goes 124 -> 0 inside one
       sample. M5 and T4b were both red on it, and M5 was then in direct
       contradiction with M9: satisfying the catch gate broke the edge gate.
       The reference is now the brightest ink over the OUTER HALF of the masked
       radius along the ray. That is the body's own brightness where its edge
       actually is, it excludes a central catch by construction, and it is
       unchanged on a flat body -- so a real skirt still measures as one. */
    let rMask = 0
    for (let r = 0; r < maxR; r += 0.5) {
      const xi = Math.round(cx + ux * r), yi = Math.round(cy + uy * r)
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) break
      if (mask[yi * width + xi]) rMask = r
    }
    if (rMask < 2) continue
    let ref = 0
    for (let r = rMask * 0.5; r <= rMask; r += 0.5) { const v = ink(cx + ux * r, cy + uy * r); if (v !== null && v > ref) ref = v }
    if (ref < 12) continue
    const hi = ref * 0.8, lo = ref * 0.2
    let rHi = null, rLo = null
    for (let r = maxR; r > 0; r -= 0.5) {
      const v = ink(cx + ux * r, cy + uy * r)
      if (v === null) continue
      if (rLo === null && v >= lo) rLo = r
      if (rLo !== null && v >= hi) { rHi = r; break }
    }
    /* rLo === rHi is a PERFECT razor: the ink went from under a fifth of peak to
       over four fifths of it inside one sample. An earlier spelling required
       rLo > rHi and so discarded exactly the edges this gate is trying to
       reward -- a hard-edged disc lost half its rays and the gate reported it as
       unmeasurable. A zero-width edge is the best possible answer, not a
       missing one. */
    if (rHi === null || rLo === null || rLo < rHi) continue
    radii.push(rLo)
    widths.push(Math.max(0, rLo - rHi))
    let sum = 0, m = 0
    for (let r = rLo + 1; r < Math.min(rLo * 1.5, maxR); r += 0.5) {
      const v = ink(cx + ux * r, cy + uy * r)
      if (v !== null) { sum += v; m++ }
    }
    if (m) halos.push(sum / m)
  }
  if (!radii.length) return { radius: 0, edgeWidth: NaN, haloEnergy: NaN, rays: 0, pixels: n }
  const mean = arr => arr.reduce((t, v) => t + v, 0) / arr.length
  const radius = mean(radii)
  return {
    centroid: [cx, cy],
    radius,
    edgeWidth: mean(widths) / radius,
    haloEnergy: halos.length ? mean(halos) : 0,
    rays: radii.length,
    pixels: n
  }
}

/* GATE M2 -- chroma must not dip in the middle of the thickness sweep.
 * Returns the deepest dip relative to the straight line joining the bands
 * either side of it, so a monotone ramp scores 0 and a U scores positive. */
export function chromaDip (bands) {
  let worst = { dip: 0, band: null }
  for (let k = 1; k < bands.length - 1; k++) {
    const expected = (bands[k - 1].C + bands[k + 1].C) / 2
    const dip = expected - bands[k].C
    if (dip > worst.dip) worst = { dip, band: bands[k].band, expected, actual: bands[k].C }
  }
  return worst
}

/* GATE M3 -- hue stability across the whole sweep, against a reference hue. */
export function hueSwing (bands, referenceHue = null) {
  const usable = bands.filter(b => Number.isFinite(b.hue) && b.pixels > 0)
  if (!usable.length) return { swing: NaN, worst: null }
  const ref = referenceHue === null
    ? meanHue(usable.map(b => b.hue), usable.map(b => b.pixels))
    : referenceHue
  let worst = { gap: 0, band: null }
  for (const b of usable) {
    const gap = Math.abs(hueGap(ref, b.hue))
    if (gap > worst.gap) worst = { gap, band: b.band, hue: b.hue }
  }
  return { reference: ref, swing: worst.gap, worst }
}

/* ------------------------------------------------ the body, robustly */

/* The body as the region above HALF of its own peak ink -- the full-width-at-
 * half-maximum extent, which is how an object with a soft profile is given an
 * edge in optics and astronomy alike.
 *
 * WHY NOT OTSU ALONE, measured 2026-09-18 on the live render: the picture has
 * three classes, not two -- ground (~550k px at ink 0-10), a faint glow (~10k
 * px at 10-20) and the body (~15k px at 100-165). Two-class Otsu on a single
 * frame split at 54 and found the body; on a temporal mean of a WANDERING body
 * it split at 13 and returned the smeared glow as a 200 px "body" whose
 * "core" was dark. The gate then reported core L 0.24 and edge width 0.63 for
 * a salmon disc that is visibly L ~0.6 with a soft foot -- true numbers about
 * the wrong region. The peak is the 90th percentile of the ink among pixels
 * Otsu already calls non-ground, so a sub-pixel specular catch at 255 cannot
 * drag the half-maximum above the body it sits on. */
export function bodyMaskHalfPeak (px, backdrop) {
  const ink = inkField(px, backdrop)
  const coarse = otsuThreshold(ink)
  const above = []
  for (let p = 0; p < ink.length; p++) if (ink[p] > coarse) above.push(ink[p])
  if (!above.length) return { mask: new Uint8Array(ink.length), threshold: Infinity, covered: 0, ink, peak: 0, coarse }
  above.sort((a, b) => a - b)
  const peak = above[Math.min(above.length - 1, Math.floor(above.length * 0.9))]
  const threshold = Math.max(coarse, peak / 2)
  const mask = new Uint8Array(ink.length)
  let covered = 0
  for (let p = 0; p < ink.length; p++) if (ink[p] > threshold) { mask[p] = 1; covered++ }
  return { mask, threshold, covered, ink, peak, coarse }
}

/* Two-threshold (three-class) Otsu over 256 bins: the split of a set of
 * values into low / middle / high maximising between-class variance. Used to
 * pick the specular catch out of the body's own lightness without a tuned
 * constant: the catch is the top class. */
export function otsuTwoThresholds (values) {
  const bins = new Float64Array(256)
  let n = 0
  for (let i = 0; i < values.length; i++) {
    let v = Math.round(values[i]); if (v < 0) v = 0; else if (v > 255) v = 255
    bins[v]++; n++
  }
  if (!n) return [0, 0]
  const P = new Float64Array(257), S = new Float64Array(257)
  for (let v = 0; v < 256; v++) { P[v + 1] = P[v] + bins[v]; S[v + 1] = S[v] + v * bins[v] }
  const cls = (a, b) => { const w = P[b] - P[a]; if (w <= 0) return 0; const m = (S[b] - S[a]) / w; return w * m * m }
  let best = -1, t1 = 0, t2 = 0
  for (let i = 1; i < 255; i++) {
    for (let j = i + 1; j < 256; j++) {
      const score = cls(0, i) + cls(i, j) + cls(j, 256)
      if (score > best) { best = score; t1 = i - 1; t2 = j - 1 }
    }
  }
  return [t1, t2]
}

/* Connected components (4-neighbour) of a mask; returns sizes, largest first. */
export function components (mask, width, height) {
  const seen = new Uint8Array(mask.length)
  const sizes = []
  const stack = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let size = 0
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const p = stack.pop(); size++
      const x = p % width, y = (p - x) / width
      const tryPush = q => { if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q) } }
      if (x > 0) tryPush(p - 1)
      if (x < width - 1) tryPush(p + 1)
      if (y > 0) tryPush(p - width)
      if (y < height - 1) tryPush(p + width)
    }
    sizes.push(size)
  }
  return sizes.sort((a, b) => b - a)
}

/* GATE M9 -- specular structure. Within the body, split Oklab L into three
 * classes; the top class is the catch. Report its area as a fraction of the
 * body and how many separate pieces it is in. A sub-pixel dot scores near 0;
 * a matte sheen over the whole body scores near 1/3 (the top class of a flat
 * histogram); a real wet catch sits between. Two pieces means two normals
 * means two bodies (STANDARD-HAPPY-AND-MERGE Part A). Pieces under
 * `minPiece` pixels are not counted, so dither cannot manufacture catches. */
export function specularStructure (px, mask, width, height, { minPiece = 6 } = {}) {
  const L = []
  const where = []
  const d = px.data
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p]) continue
    L.push(oklabFromSrgb(d[i], d[i + 1], d[i + 2]).L * 255)
    where.push(p)
  }
  if (L.length < 32) return { areaFraction: NaN, pieces: 0, thresholdL: NaN }
  const [, t2] = otsuTwoThresholds(L)
  const catchMask = new Uint8Array(mask.length)
  let area = 0
  for (let k = 0; k < L.length; k++) if (L[k] > t2) { catchMask[where[k]] = 1; area++ }
  const pieces = components(catchMask, width, height).filter(s => s >= minPiece)
  return { areaFraction: area / L.length, pieces: pieces.length, pieceSizes: pieces.slice(0, 6), thresholdL: t2 / 255 }
}

/* GATE M10 -- one body. The mask's largest connected piece as a fraction of
 * all mask pixels (1 = one body), and the mask's SOLIDITY: its area over the
 * area of its convex hull (1 = no concavity at all; a peanut with a waist
 * scores lower, and lower the deeper the cleft). */
export function unionShape (mask, width, height) {
  const sizes = components(mask, width, height)
  const total = sizes.reduce((t, v) => t + v, 0)
  if (!total) return { largestFraction: 0, pieces: 0, solidity: NaN }
  const pts = []
  for (let y = 0; y < height; y++) {
    let first = -1, last = -1
    for (let x = 0; x < width; x++) if (mask[y * width + x]) { if (first < 0) first = x; last = x }
    if (first >= 0) { pts.push([first, y]); pts.push([last + 1, y]); pts.push([first, y + 1]); pts.push([last + 1, y + 1]) }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p) }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p) }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  let hullArea = 0
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; hullArea += a[0] * b[1] - b[0] * a[1] }
  hullArea = Math.abs(hullArea) / 2
  return { largestFraction: sizes[0] / total, pieces: sizes.filter(s => s >= 16).length, solidity: hullArea ? total / hullArea : NaN }
}

/* GATE M6 (corrected form) -- luminance rises toward the rim. Returns the
 * rim-minus-core lightness step and the worst rim-ward DROP between adjacent
 * bands (0 for a monotone ramp), so the two halves of the claim read as two
 * numbers. Bands are ordered rim first. */
export function radialLuminance (bands) {
  if (bands.length < 2) return { step: NaN, worstDrop: NaN }
  const rim = bands[0], core = bands[bands.length - 1]
  let worstDrop = 0
  for (let k = bands.length - 1; k > 0; k--) {
    const drop = bands[k].L - bands[k - 1].L
    if (drop > worstDrop) worstDrop = drop
  }
  return { step: rim.L - core.L, worstDrop, rimL: rim.L, coreL: core.L }
}

/* Translate a frame by an integer pixel offset, filling with `fill`. Used to
 * REGISTER two captures of a wandering body before differencing them: the
 * seat drifts a few pixels between captures, and an unregistered difference
 * of a moved body is a picture of the move, not of the ground showing
 * through. Measured 2026-09-18: unregistered same-ground pairs 120 ms apart
 * differed by 0.13-0.16 of full scale inside the body -- more than the
 * two-ground signal -- and the gate could not be judged at all. */
export function translateFrame (px, dx, dy, fill = [0, 0, 0]) {
  const { width, height } = px
  const out = new Uint8ClampedArray(px.data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - dx, sy = y - dy
      const o = (y * width + x) * 4
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) { out[o] = fill[0]; out[o + 1] = fill[1]; out[o + 2] = fill[2]; out[o + 3] = 255; continue }
      const i = (sy * width + sx) * 4
      out[o] = px.data[i]; out[o + 1] = px.data[i + 1]; out[o + 2] = px.data[i + 2]; out[o + 3] = px.data[i + 3]
    }
  }
  return { data: out, width, height }
}

/* Centroid of a mask, or null. */
export function maskCentroid (mask, width) {
  let cx = 0, cy = 0, n = 0
  for (let p = 0; p < mask.length; p++) if (mask[p]) { cx += p % width; cy += Math.floor(p / width); n++ }
  return n ? [cx / n, cy / n] : null
}

/* Paint everything outside `fraction` of the canvas radius with the ground.
 * MEASURED 2026-09-18: the canvas grew to cover the whole ring (576 px, from
 * 384), and the body lane draws the ring's BRIM in-canvas as a torus of the
 * body's own material at about 0.88 of the canvas radius. A half-peak mask
 * of such a frame takes the brim as body, and every band, silhouette and
 * catch number is then about the brim. The face is inside 0.86; 0.8 leaves a
 * margin. This is a copy; the capture is not touched. */
export function cropToFace (px, ground, fraction = 0.8) {
  const { width, height } = px
  const out = new Uint8ClampedArray(px.data.length)
  out.set(px.data)
  const cx = width / 2, cy = height / 2, r = Math.min(width, height) / 2 * fraction
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) continue
      const i = (y * width + x) * 4
      out[i] = ground[0]; out[i + 1] = ground[1]; out[i + 2] = ground[2]; out[i + 3] = 255
    }
  }
  return { data: out, width, height }
}

/* How far a body centroid sits from the caption's quiet box, in units of the
 * box's half-size (the renderer's own dq: the veil is full strength inside
 * 0.85 and gone past 1.3). `quietBox` is stats().quietBox: { half:[x,y],
 * at:[x,y] } in canvas units where y runs UP; the mask is in pixels with y
 * running down. */
export function veilDistance (mask, width, height, quietBox) {
  const c = maskCentroid(mask, width)
  if (!c || !quietBox || !quietBox.half || !quietBox.at) return NaN
  const px = c[0] / width - 0.5, py = 0.5 - c[1] / height
  return Math.hypot((px - quietBox.at[0]) / quietBox.half[0], (py - quietBox.at[1]) / quietBox.half[1])
}

/* GATE M9 (ruled 2026-09-18) -- the catch by PEAKS, not by a lightness class.
 * The three-class Otsu detector's top class swallowed a bright pink body (68 %
 * of it read as "catch" in two pieces on cobalt): a class of a lightness
 * histogram scales with body brightness, so it was measuring brightness. This
 * one blurs Oklab L over the body (box, `blur` px), keeps the local maxima
 * that win a non-maximum suppression over `radius` px and stand at least
 * `prominence` above the body's median L, and grows each surviving peak into
 * the connected region within `skirt` of its own height, so the catch has an
 * AREA that is the highlight's and not the body's. The body lane reads one
 * catch on both the cobalt eyes and the merged body with this method. */
export function specularPeaks (px, mask, width, height, { blur = 3, radius = 14, prominence = 0.10, skirt = 0.05 } = {}) {
  const L = new Float64Array(width * height)
  const d = px.data
  const inBody = []
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) if (mask[p]) { L[p] = oklabFromSrgb(d[i], d[i + 1], d[i + 2]).L; inBody.push(L[p]) }
  if (inBody.length < 32) return { peaks: 0, areaFraction: NaN, medianL: NaN, catchMask: new Uint8Array(mask.length) }
  inBody.sort((a, b) => a - b)
  const medianL = inBody[inBody.length >> 1]
  // box blur over the body only (outside pixels do not pull the edge down)
  const B = new Float64Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!mask[p]) continue
      let sum = 0, n = 0
      for (let dy = -blur; dy <= blur; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue
        for (let dx = -blur; dx <= blur; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue
          const q = yy * width + xx
          if (mask[q]) { sum += L[q]; n++ }
        }
      }
      B[p] = n ? sum / n : 0
    }
  }
  // non-maximum suppression
  const peaks = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!mask[p] || B[p] < medianL + prominence) continue
      let top = true
      for (let dy = -radius; dy <= radius && top; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue
          if (dx * dx + dy * dy > radius * radius) continue
          const q = yy * width + xx
          if (mask[q] && (B[q] > B[p] || (B[q] === B[p] && q < p))) { top = false; break }
        }
      }
      if (top) peaks.push({ p, x, y, L: B[p] })
    }
  }
  // grow each peak into its own skirt: connected pixels within `skirt` of the peak height
  const catchMask = new Uint8Array(mask.length)
  let area = 0
  for (const peak of peaks) {
    const floor = peak.L - skirt
    const stack = [peak.p]
    catchMask[peak.p] = 1; area++
    while (stack.length) {
      const p = stack.pop()
      const x = p % width, y = (p - x) / width
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const q = yy * width + xx
        if (!mask[q] || catchMask[q] || B[q] < floor) continue
        catchMask[q] = 1; area++; stack.push(q)
      }
    }
  }
  let bodyPixels = 0
  for (let p = 0; p < mask.length; p++) if (mask[p]) bodyPixels++
  return { peaks: peaks.length, peakList: peaks.map(pk => ({ x: pk.x, y: pk.y, L: pk.L })), areaFraction: area / bodyPixels, medianL, catchMask }
}

/* GATE M7 -- OVER-STOP WHITE: the material may only ever REMOVE light from its
 * own declared light stop.
 *
 * WHY IT EXISTS. The owner has rejected additive white four times ("stop adding
 * effects though like lighting layers and shit", "i still see the gloss/white on
 * a lot of animations which i dont like"). The only thing that ever enforced it
 * was arithmetic lifted out of the shader BY NAME in
 * home-circle-motion-runtime.test.mjs, and on 2026-09-18 that arithmetic stopped
 * binding when the colour law moved to an absorption model -- the bans went on
 * reporting nothing while the liquid gained mix(1.0, 1.25, ...) and the mist a
 * flat 1.3x over uJellyIllum (REPORT-JELLY-GATE-20260918.md section 0aa.5:
 * "nothing measures it now"). A spelling pin cannot be re-pinned: it fails
 * against a better implementation and the quickest way green is to reinstate the
 * defect. This measures the claim on the FRAMEBUFFER instead, so any colour law
 * that keeps the promise passes and any that breaks it reds.
 *
 * THE CLAIM, exactly. Absorption only ever subtracts, so no pixel the MATERIAL
 * draws may sit above the material's own light stop -- stats().stops.light, the
 * thin end after exposure and the tonemap, encoded to sRGB like the pixels.
 * The one wet CATCH is a reflection, not the material, and is allowed above it;
 * it is excluded by mask (pass specularPeaks().catchMask as `exclude`), which is
 * also why a body that answers by turning its whole self into one giant catch
 * cannot hide here -- M9 bounds the catch's area at 15 % of the body.
 *
 * WHAT IT RETURNS. `worst` is the largest per-channel multiple of the stop over
 * the kept pixels, `p995` the same at the 99.5th percentile so one hot sample
 * cannot carry a verdict, and `overFraction` how much of the body sits above the
 * stop at all. Judge p995/overFraction; `worst` is the number to quote.
 * `tolerance` is a measurement allowance, not a grant: 8-bit quantisation and
 * the premultiplied readback both round, and 2/255 of a mid-grey stop is ~1 %.
 *
 * `dilate` grows the excluded catch by a few pixels, because specularPeaks
 * grows its skirt on a BLURRED lightness and the blur pulls the catch's own
 * outermost ring below the skirt floor -- measured on the synthetic hard-edged
 * catch in this file's tests: the catch itself was excluded, its rim was not,
 * and that rim carried a p995 of 2.04 that belonged to the reflection. The
 * reflection's edge belongs to the reflection. It cannot hide a body that is
 * over its stop: it only ever grows around catch pixels, and M9 already bounds
 * the whole catch at 15 % of the body.
 */
export function overStopWhite (px, mask, stopSrgb, { exclude = null, tolerance = 0.02, dilate = 2 } = {}) {
  if (exclude && dilate > 0) {
    const w = px.width, h = px.height
    let grown = exclude
    for (let pass = 0; pass < dilate; pass++) {
      const next = Uint8Array.from(grown)
      for (let p = 0; p < grown.length; p++) {
        if (!grown[p]) continue
        const x = p % w, y = (p - x) / w
        for (const step of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + step[0], yy = y + step[1]
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          next[yy * w + xx] = 1
        }
      }
      grown = next
    }
    exclude = grown
  }
  /* The stop arrives as sRGB 0..1 (materialStop() encodes it); the pixels are
     0..255 of the same encoding, so the comparison is per channel in the SAME
     space and no linearisation is owed. A channel at or below zero cannot be a
     denominator: it is skipped rather than made infinite. */
  const stop = [0, 1, 2].map(c => Math.max(1, (stopSrgb[c] || 0) * 255))
  const d = px.data
  const multiples = []
  let over = 0, kept = 0, excluded = 0
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    if (exclude && exclude[p]) { excluded++; continue }
    const i = p * 4
    const m = Math.max(d[i] / stop[0], d[i + 1] / stop[1], d[i + 2] / stop[2])
    multiples.push(m)
    kept++
    if (m > 1 + tolerance) over++
  }
  if (!kept) return { worst: NaN, p995: NaN, median: NaN, overFraction: NaN, kept: 0, excluded, stop255: stop }
  multiples.sort((a, b) => a - b)
  const at = q => multiples[Math.min(multiples.length - 1, Math.max(0, Math.round(q * (multiples.length - 1))))]
  return { worst: multiples[multiples.length - 1], p995: at(0.995), median: at(0.5), overFraction: over / kept, kept, excluded, stop255: stop }
}

/* The median and the spread of a list of measurements, for a gate that judges N
 * captures instead of whichever one it happened to land on.
 *
 * WHY. Measured 2026-09-18 against ONE unchanged shader, M5 silhouette edge
 * width read 0.135 on a clean run and 0.242 under a behaviourally identical
 * respelling, and cobalt read 0.290 on one capture and 0.017 on another -- the
 * 0.15 bound sits INSIDE the instrument's own spread, so a cut gated on one
 * capture goes red or green by luck. The repair is more captures, not a wider
 * bound: widening it to swallow 0.242 would also swallow real softening, which
 * is the defect the gate exists to catch.
 *
 * `mad` is the median absolute deviation, which one bad frame cannot move the
 * way a standard deviation can. Non-finite samples are dropped and COUNTED, so
 * a measure that failed on half its frames says so instead of quietly averaging
 * the half that worked. */
export function medianSpread (values) {
  const usable = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  const dropped = values.length - usable.length
  if (!usable.length) return { median: NaN, min: NaN, max: NaN, iqr: NaN, mad: NaN, n: 0, dropped }
  const at = q => usable[Math.min(usable.length - 1, Math.max(0, Math.round(q * (usable.length - 1))))]
  const median = usable.length % 2 ? usable[(usable.length - 1) / 2] : (usable[usable.length / 2 - 1] + usable[usable.length / 2]) / 2
  const deviations = usable.map(v => Math.abs(v - median)).sort((a, b) => a - b)
  const mad = deviations.length % 2 ? deviations[(deviations.length - 1) / 2] : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2
  return { median, min: usable[0], max: usable[usable.length - 1], iqr: at(0.75) - at(0.25), mad, n: usable.length, dropped }
}
