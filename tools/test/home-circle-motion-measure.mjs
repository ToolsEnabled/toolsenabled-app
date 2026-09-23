/* PURE measurement of the home-circle body's MOTION (T365).
 *
 * Every function here takes numbers a capture already produced -- a per-frame
 * series of silhouette measures, or small RGBA frames -- and returns a verdict
 * about them. Nothing reads src/, opens a browser or touches a clock, so each
 * measure is first proved on a synthetic series whose right answer is known by
 * construction (home-circle-motion-measure.test.mjs) before it is pointed at
 * the renderer. A gate built on these cannot pin the shader's spelling because
 * it never sees the shader.
 *
 * A "series" is an array of numbers sampled at a fixed interval dtMs. A "frame"
 * is {data: Uint8ClampedArray|Buffer|Float64Array (RGBA), width, height}.
 */

const mean = arr => arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : NaN
const variance = arr => { const m = mean(arr); return arr.length ? mean(arr.map(v => (v - m) * (v - m))) : NaN }

/* ------------------------------------------------------- M-1 overshoot */

/* Count the times a series crosses its REST value after it first leaves it.
 *
 * WHY "after it first leaves". A series that starts at rest and is nudged
 * away must come BACK through rest (crossing 1) and then go past it (crossing
 * 2) to be called bouncy. A critically damped or overdamped response returns
 * asymptotically and crosses never. A pure exponential ease -- what a lerp
 * gives -- crosses never. `deadband` is the noise band around rest inside
 * which nothing counts, so a jittering plateau cannot be mistaken for a bounce.
 * Returns the count and the sample indices, so a red can be read back to the
 * frames that caused it. */
export function restCrossings (series, rest, { deadband = 0, minExcursion = 0 } = {}) {
  const crossings = []
  let side = 0 // -1 below rest, +1 above, 0 inside the deadband
  let left = false
  let peak = 0
  for (let i = 0; i < series.length; i++) {
    const d = series[i] - rest
    if (Math.abs(d) > peak) peak = Math.abs(d)
    const s = d > deadband ? 1 : d < -deadband ? -1 : 0
    if (s === 0) continue
    if (side === 0) { side = s; if (!left && Math.abs(d) > minExcursion) left = true; continue }
    if (s !== side) {
      if (left) crossings.push(i)
      side = s
    }
  }
  return { count: crossings.length, at: crossings, peakExcursion: peak }
}

/* ---------------------------------------------- M-2 not a crossfade */

/* Fit the best LINEAR blend of two endpoint frames to a middle frame and
 * report what is left over.
 *
 * mid ~= a*A + b*B + c, least squares over every channel of every pixel, and
 * the residual is the RMS of what that fit cannot explain, normalised by the
 * RMS of (A - B) so it reads as "how much of the endpoints' own difference the
 * middle frame refuses to be". A genuine crossfade -- dissolve, opacity ramp,
 * any per-pixel lerp -- gives a residual near zero by construction. A body that
 * DEFORMS between the endpoints has edges and interior structure in the middle
 * frame that neither endpoint has, and the residual is large.
 *
 * Three coefficients (a, b and a flat offset c) rather than one alpha, on
 * purpose: a crossfade whose endpoints were also re-exposed or whose ground
 * shifted would still fit, so the gate cannot be dodged by a dissolve with a
 * brightness ramp on top. */
export function linearBlendResidual (A, B, mid, { mask = null } = {}) {
  if (A.width !== B.width || A.width !== mid.width || A.height !== B.height || A.height !== mid.height) {
    throw new Error('linearBlendResidual: frames differ in size')
  }
  const n = A.width * A.height
  // normal equations for [a b c]
  let saa = 0, sab = 0, sa = 0, sbb = 0, sb = 0, s1 = 0, sam = 0, sbm = 0, sm = 0
  for (let p = 0; p < n; p++) {
    if (mask && !mask[p]) continue
    for (let k = 0; k < 3; k++) {
      const i = p * 4 + k
      const a = A.data[i], b = B.data[i], m = mid.data[i]
      saa += a * a; sab += a * b; sa += a; sbb += b * b; sb += b; s1 += 1
      sam += a * m; sbm += b * m; sm += m
    }
  }
  if (!s1) return { residual: NaN, coefficients: null, samples: 0 }
  const M = [[saa, sab, sa], [sab, sbb, sb], [sa, sb, s1]]
  const rhs = [sam, sbm, sm]
  const coef = solve3(M, rhs)
  if (!coef) return { residual: NaN, coefficients: null, samples: s1 }
  const [a, b, c] = coef
  let res = 0, span = 0
  for (let p = 0; p < n; p++) {
    if (mask && !mask[p]) continue
    for (let k = 0; k < 3; k++) {
      const i = p * 4 + k
      const e = mid.data[i] - (a * A.data[i] + b * B.data[i] + c)
      res += e * e
      const d = A.data[i] - B.data[i]
      span += d * d
    }
  }
  return { residual: span > 0 ? Math.sqrt(res / s1) / Math.sqrt(span / s1) : NaN, rmsResidual: Math.sqrt(res / s1), rmsSpan: Math.sqrt(span / s1), coefficients: { a, b, c }, samples: s1 }
}

function solve3 (M, r) {
  const m = M.map(row => row.slice()), v = r.slice()
  for (let col = 0; col < 3; col++) {
    let piv = col
    for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[piv][col])) piv = row
    if (Math.abs(m[piv][col]) < 1e-12) return null
    ;[m[col], m[piv]] = [m[piv], m[col]]; [v[col], v[piv]] = [v[piv], v[col]]
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const f = m[row][col] / m[col][col]
      for (let k = col; k < 3; k++) m[row][k] -= f * m[col][k]
      v[row] -= f * v[col]
    }
  }
  return [v[0] / m[0][0], v[1] / m[1][1], v[2] / m[2][2]]
}

/* --------------------------------------------- M-3 squash, not scale */

/* Given per-frame silhouette widths and heights, report whether the two axes
 * move in OPPOSITION (a squash) rather than together (a scale) and whether the
 * area they enclose is held.
 *
 * opposition: Pearson correlation of frame-to-frame changes in width against
 * changes in height. A squash is strongly negative; a uniform scale is +1; a
 * static body is NaN (no motion at all, which is its own failure).
 * areaDrift: peak relative excursion of width*height from its mean, so a body
 * that squashes while losing or gaining volume is visible as a number. */
export function axisOpposition (widths, heights, { minMotion = 0 } = {}) {
  if (widths.length !== heights.length) throw new Error('axisOpposition: series differ in length')
  const dw = [], dh = []
  for (let i = 1; i < widths.length; i++) {
    const a = widths[i] - widths[i - 1], b = heights[i] - heights[i - 1]
    if (Math.abs(a) <= minMotion && Math.abs(b) <= minMotion) continue
    dw.push(a); dh.push(b)
  }
  const areas = widths.map((w, i) => w * heights[i])
  const areaMean = mean(areas)
  let areaDrift = 0
  for (const a of areas) areaDrift = Math.max(areaDrift, Math.abs(a - areaMean) / areaMean)
  if (dw.length < 3) return { correlation: NaN, areaDrift, moving: dw.length }
  const mw = mean(dw), mh = mean(dh)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < dw.length; i++) { const x = dw[i] - mw, y = dh[i] - mh; sxy += x * y; sxx += x * x; syy += y * y }
  const correlation = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN
  return { correlation, areaDrift, moving: dw.length }
}

/* ------------------------------------------- M-4 state separation */

/* Do three states separate on a measure? Each state contributes several
 * samples of the measure. Separation between two states is the gap between
 * their means in units of their pooled standard deviation (Cohen's d). The
 * measure separates the set when EVERY pair is at least `minD` apart.
 * Returned per pair, so a red names which two states collapsed together. */
export function stateSeparation (samplesByState, { minD = 2 } = {}) {
  const names = Object.keys(samplesByState)
  const stats = {}
  for (const n of names) {
    const s = samplesByState[n]
    stats[n] = { mean: mean(s), sd: Math.sqrt(variance(s)), n: s.length }
  }
  const pairs = []
  let ok = names.length >= 2
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = stats[names[i]], b = stats[names[j]]
      const pooled = Math.sqrt(((a.n - 1) * a.sd * a.sd + (b.n - 1) * b.sd * b.sd) / Math.max(1, a.n + b.n - 2))
      const d = pooled > 0 ? Math.abs(a.mean - b.mean) / pooled : (a.mean === b.mean ? 0 : Infinity)
      pairs.push({ a: names[i], b: names[j], d, gap: Math.abs(a.mean - b.mean), pooledSd: pooled })
      if (!(d >= minD)) ok = false
    }
  }
  return { ok, pairs, stats }
}

/* ------------------------------ M-4b absolute state anchors */

/* Cohen's d (M-4) says two states are SEPARABLE. It does not say they look
 * different: d is scale-free, so a pair whose means sit a thousandth apart
 * passes at d = 50 when the variance is smaller still, and a pair nobody could
 * confuse fails when both states are noisy. These anchors are the other half --
 * absolute gaps, each one a number a person can point at on screen, taken from
 * live measurement rather than synthetic controls.
 *
 * `states` is { solid: {coverage, edge, chroma}, mist: {coverage, edge, chroma} }
 * of per-state MEANS. `limits` is the MOTION threshold block. Returns one row
 * per anchor so a red names which look was lost, not just that one was. */
export function stateAnchors (states, limits) {
  const { solid, mist } = states
  const ratio = solid.coverage > 0 ? mist.coverage / solid.coverage : 0
  const rows = [
    {
      key: 'cloudCoverage',
      name: `the mist/cloud covers at least ${limits.cloudOverBodyCoverageMin.value}x what the solid body covers`,
      ok: ratio >= limits.cloudOverBodyCoverageMin.value,
      detail: `mist coverage ${solid.coverage ? mist.coverage.toFixed(3) : mist.coverage} over solid ${solid.coverage.toFixed(3)} = ${ratio.toFixed(2)}x (live reference 0.146/0.042 = 3.5x)`
    },
    {
      key: 'solidEdge',
      name: `the solid body has a defined rim: edge at or under ${limits.solidEdgeMaxFraction.value} of its radius`,
      ok: solid.edge <= limits.solidEdgeMaxFraction.value,
      detail: `solid edge ${solid.edge.toFixed(3)} of radius (max ${limits.solidEdgeMaxFraction.value}; the owner's reference gummy measures 0.061)`
    },
    {
      key: 'mistEdge',
      name: `mist is at least ${limits.mistOverSolidEdgeMin.value}x softer at the edge than the solid body`,
      ok: solid.edge > 0 && mist.edge / solid.edge >= limits.mistOverSolidEdgeMin.value,
      detail: `mist edge ${mist.edge.toFixed(3)} over solid ${solid.edge.toFixed(3)} = ${solid.edge > 0 ? (mist.edge / solid.edge).toFixed(2) : 'n/a'}x (need >= ${limits.mistOverSolidEdgeMin.value}x)`
    },
    {
      key: 'solidChroma',
      name: `the solid body keeps its dye: chroma at or above ${limits.solidChromaMin.value}`,
      ok: solid.chroma >= limits.solidChromaMin.value,
      detail: `solid chroma ${solid.chroma.toFixed(3)} (live reference 0.14-0.23)`
    },
    {
      key: 'mistChroma',
      name: `mist stays under ${limits.mistChromaMax.value} chroma, so the two cannot meet in the middle`,
      ok: mist.chroma <= limits.mistChromaMax.value,
      detail: `mist chroma ${mist.chroma.toFixed(3)} (live reference under 0.1)`
    }
  ]
  return { ok: rows.every(r => r.ok), rows, coverageRatio: ratio }
}

/* --------------------------------------------- M-5 interior lag */

/* The lag, in samples, at which the interior series best follows the boundary
 * series: argmax over non-negative lags of the normalised cross-correlation of
 * the two detrended series. Reported in milliseconds given dtMs. A lag of 0
 * means the interior moves in lockstep with the edge (a rigid scale, not a
 * jelly); a lag past `maxLagMs` is not searched, so a spurious match a whole
 * cycle later cannot masquerade as a short lag. */
export function interiorLag (boundary, interior, dtMs, { maxLagMs = 250, noiseFloor = 0 } = {}) {
  if (boundary.length !== interior.length) throw new Error('interiorLag: series differ in length')
  const n = boundary.length
  /* NOISE FLOOR. A correlation is only meaningful if both series actually
     MOVE. The body is one analytic field, so its interior ink barely varies:
     what changes frame to frame is 1 LSB of triangular dither and a slow skin
     drift, uncorrelated with the outline BY CONSTRUCTION (body lane,
     2026-09-18). Cross-correlating that produces a confident-looking number
     out of nothing -- argmax over ~15 lags of a noise sequence lands near
     r = 0.3-0.6 with a lag that is whatever the dither happened to do. So a
     series whose robust peak-to-peak sits at or under the floor is declared
     UNDECIDABLE rather than scored. Floor is in the series' own units (ink
     LSB for an interior-ink series). The alternative the standard allows --
     masking to lightness above the body median before reading interiorInk --
     is a change to silhouetteOfFrame and would narrow WHERE we look; this
     narrows WHETHER we answer, which is the half that stops a fabricated
     number reaching a gate. */
  const span = s => { const v = [...s].sort((a, b) => a - b); const at = q => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))]; return at(0.95) - at(0.05) }
  const amplitude = { boundary: span(boundary), interior: span(interior) }
  if (noiseFloor > 0 && (amplitude.interior <= noiseFloor || amplitude.boundary <= noiseFloor)) {
    return {
      lagMs: NaN,
      correlation: NaN,
      curve: [],
      undecidable: true,
      amplitude,
      noiseFloor,
      reason: `series does not move above the noise floor: boundary p5-p95 ${amplitude.boundary.toFixed(2)}, interior ${amplitude.interior.toFixed(2)}, floor ${noiseFloor}`
    }
  }
  const mb = mean(boundary), mi = mean(interior)
  const b = boundary.map(v => v - mb), i = interior.map(v => v - mi)
  const maxLag = Math.min(n - 3, Math.floor(maxLagMs / dtMs))
  let best = { lag: 0, r: -Infinity }
  const curve = []
  for (let lag = 0; lag <= maxLag; lag++) {
    let sxy = 0, sxx = 0, syy = 0
    for (let k = 0; k + lag < n; k++) { const x = b[k], y = i[k + lag]; sxy += x * y; sxx += x * x; syy += y * y }
    const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN
    curve.push(r)
    if (r > best.r) best = { lag, r }
  }
  return { lagMs: best.lag * dtMs, correlation: best.r, curve, undecidable: false, amplitude, noiseFloor }
}

/* -------------------------------------- M-6 transition duration */

/* How long a series takes to travel from its starting plateau to its final
 * plateau. Departure is the first sample further than `band` of the total
 * travel from the start; arrival is the first sample after which the series
 * stays within `band` of the end value for the rest of the record. Both ends
 * are read from the record itself, so an overshooting arrival counts as still
 * travelling until it has actually settled. */
export function transitionDuration (series, dtMs, { band = 0.05, settleFor = 3 } = {}) {
  const n = series.length
  if (n < 3) return { durationMs: NaN, departAt: null, settleAt: null }
  const start = series[0], end = series[n - 1], travel = Math.abs(end - start)
  if (travel === 0) return { durationMs: 0, departAt: null, settleAt: null, travel }
  const tol = band * travel
  let departAt = null
  for (let k = 0; k < n; k++) if (Math.abs(series[k] - start) > tol) { departAt = k; break }
  if (departAt === null) return { durationMs: 0, departAt: null, settleAt: null, travel }
  let settleAt = null
  /* A record whose last sample is trivially "within band of the end" must not
     count as settled there: the series has to hold the end for settleFor
     samples, so the search stops settleFor short of the record. */
  for (let k = departAt; k <= n - settleFor; k++) {
    let settled = true
    for (let j = k; j < Math.min(n, k + settleFor); j++) if (Math.abs(series[j] - end) > tol) { settled = false; break }
    if (settled) {
      // and it must stay settled to the end of the record
      let stays = true
      for (let j = k; j < n; j++) if (Math.abs(series[j] - end) > tol) { stays = false; break }
      if (stays) { settleAt = k; break }
    }
  }
  if (settleAt === null) return { durationMs: Infinity, departAt, settleAt: null, travel }
  return { durationMs: (settleAt - departAt) * dtMs, departAt, settleAt, travel }
}

/* --------------------------------------------- frame-level helpers */

/* Silhouette measures of ONE frame against a known ground: bounding width and
 * height of the ink mask, its area, centroid, and the mean ink of the interior
 * (pixels well inside the silhouette) so a lag between edge and interior can
 * be read off two series taken from the same frames. `threshold` is the ink
 * level (0-255 mean abs channel difference from ground) that counts as body. */
export function silhouetteOfFrame (frame, ground, threshold = 24, { innerFraction = 0.5, cropRadius = 1 } = {}) {
  const { width, height, data } = frame
  let minX = width, maxX = -1, minY = height, maxY = -1, area = 0, cx = 0, cy = 0
  const mask = new Uint8Array(width * height)
  /* cropRadius < 1 ignores everything outside that fraction of the canvas
     radius. MEASURED 2026-09-18 on fluid 7d993069: the canvas grew to cover
     the whole ring and the body lane draws the ring's BRIM in-canvas, a torus
     of the body's own material at ~0.88 of the canvas radius (not
     src/home-circle-backdrop.js, which is unwired and paints nothing). The
     ink bounding box became the brim, 114 px of 128 on every frame, peak
     excursion 0. The brim is not the body; it is cropped away before any
     silhouette is read. */
  const ccx = width / 2, ccy = height / 2, cr = Math.min(width, height) / 2 * cropRadius
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cropRadius < 1 && Math.hypot(x + 0.5 - ccx, y + 0.5 - ccy) > cr) continue
      const i = (y * width + x) * 4
      const ink = (Math.abs(data[i] - ground[0]) + Math.abs(data[i + 1] - ground[1]) + Math.abs(data[i + 2] - ground[2])) / 3
      if (ink > threshold) {
        mask[y * width + x] = 1
        area++; cx += x; cy += y
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
  }
  if (!area) return { width: 0, height: 0, area: 0, centroid: null, interiorInk: 0, mask }
  cx /= area; cy /= area
  const w = maxX - minX + 1, h = maxY - minY + 1
  const r = Math.min(w, h) / 2 * innerFraction
  let inner = 0, innerN = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue
      const i = (y * width + x) * 4
      inner += (Math.abs(data[i] - ground[0]) + Math.abs(data[i + 1] - ground[1]) + Math.abs(data[i + 2] - ground[2])) / 3
      innerN++
    }
  }
  return { width: w, height: h, area, centroid: [cx, cy], interiorInk: innerN ? inner / innerN : 0, mask }
}

/* Are two frames the same picture? Mean absolute channel difference and the
 * count of pixels differing by more than `tolerance`, for the determinism
 * gate: two runs from the same seed at the same fixed step must agree to the
 * last pixel, and this says by how much they do not. */
export function frameDifference (a, b, tolerance = 2) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, differing: Infinity, pixels: 0 }
  const n = a.width * a.height
  let total = 0, differing = 0
  for (let p = 0; p < n; p++) {
    const i = p * 4
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
    total += d
    if (d > tolerance) differing++
  }
  return { mean: total / n, differing, fraction: differing / n, pixels: n }
}
