#!/usr/bin/env node
/* THE PICTURE GATE for the home circle's body (T360 material half).
 *
 * WHY IT EXISTS. Every arithmetic assertion in this lane was green while the
 * owner looked at the running app and said "right now it looks super bad and
 * nothing like the image". Nothing measured the PICTURE. This driver paints the
 * body in a real browser on a real GPU and judges what it sees, with the pure
 * measures in tools/test/home-circle-picture-measure.mjs, each first proved on
 * a synthetic picture whose right answer is known.
 *
 * WHAT IT DOES NOT DO. It never reads src/. It cannot pin the shader's spelling,
 * because it never sees the shader's text -- it only sees pixels. A better
 * implementation of the same look passes unchanged; that property is the point.
 *
 * USAGE
 *   node tools/test/fixtures/run-home-circle-jelly-material.mjs
 * Env
 *   HOME_CIRCLE_ORIGIN   origin serving this tree (default http://127.0.0.1:4623)
 *   HOME_CIRCLE_THEMES   comma list of dark themes to judge (default black,cobalt,ember)
 *   HOME_CIRCLE_OUT      receipt directory (default private/browser-proof-receipts/run-home-circle-jelly-material)
 *   HOME_CIRCLE_PAIRS    ground-chop pairs for the transmission measure (default 16)
 *   HOME_CIRCLE_REFERENCE path of the owner's reference image for the contact sheet
 *   HOME_CIRCLE_CHANNEL  browser channel to try first (else msedge, chrome, chromium)
 *   HOME_CIRCLE_MUTATIONS JSON list of in-flight source mutations (mutation checks only)
 *
 * Exit 0 every gate passed - 1 a gate is red - 2 a gate could not be measured (a refusal is never a pass).
 * A REFUSAL ("could not look") is recorded separately from a FAILURE ("looked,
 * and it is wrong"). They are different answers and this driver never merges
 * them: a missing GPU is not evidence the body is beautiful.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as H from '../home-circle-gate-harness.mjs'
import * as M from '../home-circle-picture-measure.mjs'
import { THRESHOLDS, GROUND_A, GROUND_B } from '../home-circle-jelly-thresholds.mjs'

const HERE = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(HERE), '..', '..', '..')
const THEMES = (process.env.HOME_CIRCLE_THEMES || 'black,cobalt,ember').split(',').map(s => s.trim()).filter(Boolean)
const PAIRS = Number(process.env.HOME_CIRCLE_PAIRS || 16)
const OUT = process.env.HOME_CIRCLE_OUT || path.join(REPO, 'private', 'browser-proof-receipts', 'run-home-circle-jelly-material')
const REFERENCE = process.env.HOME_CIRCLE_REFERENCE || path.join(REPO, '.lane-scratch', 'w4', 'f', 'reference-and-ours.png')

/* HOLD THE BODY WHERE IT CAN BE JUDGED. M1 -- the gate for the owner's actual
   complaint, an opaque body -- refused on every theme for three builds running:
   12 to 14 of 16 capture pairs sat under the caption veil, because the body
   wanders on its own seat and the measure took whatever frame it landed on.
   The renderer exposes a seat hold under the same test hook as the determinism
   seed (homeCircleFluidTest.seat = [x, y] in face uv; unset, nothing changes).
   Measured 2026-09-18 with .lane-scratch/gate/seat-probe.mjs, 6 samples a seat:
     unheld          dq 2.11 1.93 1.73 1.56 1.46 1.38, centroid drift 143x100 px
     [0.5, 0.80]     dq 2.34 2.33 2.32 2.32 2.32 2.32, centroid drift 0.0x1.6 px
     [0.5, 0.18]     dq 1.40 1.24 1.24 1.23 1.23 1.24  -- inside the veil
   So the body is parked at [0.5, 0.80], 2.32 half-widths clear of the quiet box
   and effectively motionless, and the pairs are judged there. This pins WHERE
   the body is measured; it does not touch what the material looks like. Set
   HOME_CIRCLE_SEAT=off to measure the wandering body instead. */
const SEAT = process.env.HOME_CIRCLE_SEAT === 'off' ? null
  : (process.env.HOME_CIRCLE_SEAT || '0.5,0.80').split(',').map(Number)
/* AND RUN IT ON THE DETERMINISM HOOK. D1 went green on 2026-09-18, so the
   material can now be measured on a body whose dynamics repeat instead of on
   whichever frame the run happened to land on. Measured the same evening with
   .lane-scratch/gate/w6-cycle-probe.mjs, 70 captures a run on black, seat held
   either way:
     unseeded       joined frames 14 of 70, their masks spanning 12503-135900
                    pixels (ratio 10.9 -- one run fell into a blowup episode,
                    which also dragged the body back under the caption veil at
                    dq 1.02); consecutive joined triples agreeing to a tenth
                    9 of 12
     seed+fixed dt  joined frames 19 of 70, masks 12617-13605 (ratio 1.078);
                    consecutive joined triples agreeing to a tenth 17 of 17
   HOME_CIRCLE_SEED=off measures the unseeded body instead. */
const SEED = process.env.HOME_CIRCLE_SEED === 'off' ? null : Number(process.env.HOME_CIRCLE_SEED || 4249)
const DT = process.env.HOME_CIRCLE_SEED === 'off' ? null : Number(process.env.HOME_CIRCLE_DT || 1 / 30)
const TEST_HOOK = {
  ...(SEAT && SEAT.length === 2 && SEAT.every(Number.isFinite) ? { seat: SEAT } : {}),
  ...(Number.isFinite(SEED) && Number.isFinite(DT) ? { seed: SEED, dt: DT } : {})
}
/* HOW MANY JOINED FRAMES M5 IS TAKEN OVER. See the M5 block below. */
const SPREAD_FRAMES = Number(process.env.HOME_CIRCLE_SPREAD_FRAMES || 7)
/* THE DECLARED BOUNDS ON THIS DRIVER'S OWN TIME, per theme. Three themes at
   160 s of pairs plus 70 s of spread frames plus the two merged captures fits
   inside the watchdog with room for a slow box; without them one theme could
   spend 16 triples x a 20 s join wait and starve every gate after it, which is
   what took the whole 720 s watchdog on 2026-09-19 and scored nothing. */
const PAIRS_BUDGET_MS = Number(process.env.HOME_CIRCLE_PAIRS_BUDGET_MS || 160000)
const JOIN_WAIT_MS = Number(process.env.HOME_CIRCLE_JOIN_WAIT_MS || 12000)
const SPREAD_BUDGET_MS = Number(process.env.HOME_CIRCLE_SPREAD_BUDGET_MS || 70000)
const SEAT_INIT = { fn: (arg) => { window.homeCircleFluidTest = Object.assign(window.homeCircleFluidTest || {}, arg) }, arg: TEST_HOOK }

const receipt = {
  driver: { file: 'tools/test/fixtures/run-home-circle-jelly-material.mjs', sha256: createHash('sha256').update(fs.readFileSync(HERE)).digest('hex') },
  subject: ['src/home-circle-fluid.js', 'src/home-circle-optics.js', 'src/home-circle-forms.js', 'src/home-circle.css'].map(f => H.fingerprint(REPO, f)),
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  origin: H.ORIGIN, thresholds: THRESHOLDS, grounds: { a: GROUND_A, b: GROUND_B }, pairs: PAIRS, seat: SEAT, seed: SEED, dt: DT, spreadFrames: SPREAD_FRAMES, browser: null, mutations: null,
  checks: [], errors: [], refusals: [], measurements: [], artifacts: [], outsideRequests: 0
}
const check = (name, ok, detail) => {
  receipt.checks.push(name)
  if (!ok) receipt.errors.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}
const refuse = (name, why) => { receipt.refusals.push(`${name}: ${why}`); console.log(`REFUSED  ${name}  -- ${why}`) }
const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); receipt.artifacts.push(name) }
const f3 = v => Number.isFinite(v) ? v.toFixed(3) : String(v)

fs.mkdirSync(OUT, { recursive: true })

/* WATCHDOG. A dev-server page reload under a capture (another lane saving a
   module the page imports) left one run waiting for 20 minutes with its
   browser alive and the receipt never written. A run that outlives its
   budget is a refusal with a name, and it lets go of its browser. */
const WATCHDOG_MS = Number(process.env.HOME_CIRCLE_WATCHDOG_MS || 720000)
setTimeout(() => {
  console.log(`REFUSED  watchdog  -- the run exceeded ${WATCHDOG_MS} ms; a page reload under the capture (a module saved by another lane) is the usual cause. Nothing was scored.`)
  try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...receipt, refusals: [...receipt.refusals, `watchdog: run exceeded ${WATCHDOG_MS} ms`], errors: [...receipt.errors, `watchdog: the run exceeded ${WATCHDOG_MS} ms and was not completed`], finishedAt: new Date().toISOString() }, null, 2)) } catch { /* nothing to write */ }
  process.exit(2)
}, WATCHDOG_MS).unref()

/* THE FACE, NOT THE RING. Every capture is cropped to 0.8 of the canvas radius
   before anything is measured: the canvas covers the whole ring now and the
   body lane draws the ring's brim in-canvas out of the body's own material,
   which a half-peak mask would otherwise take for the body. */
const FACE = 0.8
const face = (frame, ground) => ({ ...M.cropToFace(frame, ground, FACE), png: frame.png })

/* THE CAPTION VEIL. The renderer dims the body behind the centre caption by
   design (uQuietFloor over stats().quietBox, ramping out to 1.3 half-widths),
   and hiding the caption with visibility does not lift it -- the box is
   measured from the caption's rect, which visibility:hidden keeps. Found by
   the body lane 2026-09-18: a receipt with peak ink 63 and every band at
   ~0.55x the lightness it measured on the same pixels. So a frame is only
   judged when the body's centroid sits clear of the veil (dq >= 1.3, the
   renderer's own threshold), and otherwise the driver waits for the body to
   wander out or refuses by name. */
const VEIL_CLEAR = 1.3
const quietBoxOf = page => page.evaluate(() => { const s = document.querySelector('.home-circle').homeCircleFluid.stats(); return s.quietBox || null })

/* The body's own measures from ONE frame over ground A. */
function measureBody (frame, ground) {
  const auto = M.bodyMaskHalfPeak(frame, ground)
  if (!auto.covered) return null
  const dist = M.distanceInward(auto.mask, frame.width, frame.height)
  /* The catch by PEAKS (ruled 2026-09-18): a lightness class swallowed a bright
     body. Its mask is then kept out of the colour bands, so a colourless
     highlight is never read as a chroma dip. */
  const spec = M.specularPeaks(frame, auto.mask, frame.width, frame.height)
  const bands = M.thicknessBands(frame, auto.mask, dist, 8, { exclude: spec.catchMask })
  return { auto, dist, bands, sil: M.silhouetteProfile(frame, auto.mask, ground), spec, union: M.unionShape(auto.mask, frame.width, frame.height) }
}

/* Transmission from PAIRS of captures taken back to back over the two grounds,
   against a control of pairs over the SAME ground. The body wanders, so each
   later capture is REGISTERED to the first by the shift of its own body
   centroid before differencing (M.translateFrame); each pair is judged on the
   first capture's mask, then the fractions are averaged. */
function register (to, from, groundTo, groundFrom) {
  const a = M.bodyMaskHalfPeak(to, groundTo), b = M.bodyMaskHalfPeak(from, groundFrom)
  const ca = M.maskCentroid(a.mask, to.width), cb = M.maskCentroid(b.mask, from.width)
  if (!ca || !cb) return null
  return { frame: M.translateFrame(from, Math.round(ca[0] - cb[0]), Math.round(ca[1] - cb[1]), groundFrom), shift: [ca[0] - cb[0], ca[1] - cb[1]], auto: a }
}
/* Is the base character JOINED right now -- one blob, the merged half of its
   13.2 s cycle -- and at what step? */
const joinedNow = page => page.evaluate(() => {
  const s = document.querySelector('.home-circle').homeCircleFluid.stats()
  return { together: s.agent && s.agent.character ? s.agent.character[0] : null, steps: s.steps }
})
/* Wait for the joined plateau to be under way. Returns null if it never comes,
   which the caller reports by name rather than capturing anyway. */
async function waitJoined (page, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const j = await joinedNow(page)
    if (j.together === null) throw new Error('stats().agent.character is not exposed')
    if (j.together > 0.995) return j
    await page.waitForTimeout(120)
  }
  return null
}
async function transmissionPairs (page, where) {
  const signal = [], control = [], shifts = []
  let skipped = 0, veiled = 0, unjoined = 0, straddled = 0
  const stepsAt = []
  let firstA = null, firstB = null
  const budget = Date.now() + PAIRS_BUDGET_MS
  let attempted = 0
  for (let k = 0; k < PAIRS; k++) {
    if (Date.now() > budget) break
    attempted++
    /* SCHEDULE THE TRIPLE ON THE JOINED PLATEAU. Measured 2026-09-18 on shader
       4c72be57 with the seat already held: the caption veil was fully cleared
       (0 of 16 pairs veiled on every theme, dq 2.32) and M1 still refused,
       because 16 of 16 triples on black were discarded by the shape-agreement
       filter -- the character's eyes join and part on a 13.2 s cycle and a
       triple taken blind straddles the change, comparing two different SHAPES.
       The parted half is TWO bodies whose combined mask swings 7102-9981
       pixels between captures (ratio 1.4); the joined half holds 12617-13605
       (ratio 1.078) and every consecutive joined triple agreed to a tenth.
       So the triple is taken inside the plateau and the plateau is confirmed
       still current AFTER it. This does not weaken the agreement filter -- that
       still runs, independently, on the masks themselves -- it stops handing it
       captures that were never comparable. */
    const before = await waitJoined(page, JOIN_WAIT_MS)
    if (!before) { unjoined++; continue }
    await H.setGround(page, GROUND_A); await page.waitForTimeout(90)
    const a = face(await H.grabCanvas(page, `${where}/A${k}`), GROUND_A)
    const quietBox = await quietBoxOf(page)
    await H.setGround(page, GROUND_B); await page.waitForTimeout(90)
    const b = face(await H.grabCanvas(page, `${where}/B${k}`), GROUND_B)
    await H.setGround(page, GROUND_A); await page.waitForTimeout(90)
    const a2 = face(await H.grabCanvas(page, `${where}/A${k}-again`), GROUND_A)
    if (a.width !== b.width || a.width !== a2.width) throw new Error(`${where}: crop changed size mid-run`)
    /* The plateau must still be current: a triple that began joined and ended
       parted photographed the change itself. */
    const after = await joinedNow(page)
    if (!(after.together > 0.995)) { straddled++; continue }
    stepsAt.push([before.steps, after.steps])
    const dq = M.veilDistance(M.bodyMaskHalfPeak(a, GROUND_A).mask, a.width, a.height, quietBox)
    if (!(dq >= VEIL_CLEAR)) { veiled++; continue }
    /* Over ground B the mask is found against B, so the same body is masked on
       either ground; the registered B frame is then compared over A's mask. */
    const rb = register(a, b, GROUND_A, GROUND_B), ra = register(a, a2, GROUND_A, GROUND_A)
    if (!rb || !ra || !rb.auto.covered) continue
    /* MEASURED 2026-09-18: the character's eyes join and part on a 13.2 s
       cycle, and a pair whose three captures straddle that change compared two
       different SHAPES -- one run read 0.21 transmission for a body two other
       runs put at 0.02-0.03. A pair is only kept when the shape did not change
       across it, so registration is a shift and not a morph.

       THE SHAPE IS COMPARED ON THE TWO SAME-GROUND CAPTURES ONLY (fixed
       2026-09-19). This read all three masks, and the middle one is found
       against the WHITE ground while the other two are found against black --
       so it was comparing a shape change against a GROUND change, which is the
       one thing M1 exists to detect. Measured with
       .lane-scratch/gate/w6-triple-probe.mjs on black, seat held, seed and
       fixed step, triples scheduled inside the joined plateau: the white-ground
       half-peak mask runs a systematic 0.89x of the black-ground masks (rows
       11295/12945, 11601/13463, 11506/13301, 11101/12908) while the two
       black-ground masks of the SAME triple agree to 1.001-1.043. The filter as
       written kept 0 of 8 triples; comparing the two same-ground masks kept 6
       of 8. It is not weakened by this: the two it still rejects are the two
       that should be rejected -- a blowup episode (masks 138472/107272, ratio
       1.291) and a triple taken as the character was still joining (together
       0.61, ratio 1.243). The white capture cannot slip a different shape past
       it either, because the triple is scheduled inside the joined plateau and
       the plateau is confirmed still current after it. */
    const areas = [rb.auto.covered, M.bodyMaskHalfPeak(a2, GROUND_A).covered]
    if (Math.max(...areas) > Math.min(...areas) * 1.1) { skipped++; continue }
    const dist = M.distanceInward(rb.auto.mask, a.width, a.height)
    signal.push(M.transmission(a, rb.frame, GROUND_A, GROUND_B, rb.auto.mask, dist).fraction)
    control.push(M.interiorChange(a, ra.frame, rb.auto.mask, dist, 0.45).meanDelta / 255)
    shifts.push(Math.hypot(...rb.shift))
    if (!firstA) { firstA = a; firstB = b }
  }
  const mean = arr => arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : NaN
  return { fraction: mean(signal), control: mean(control), pairs: signal.length, attempted, skipped, veiled, unjoined, straddled, stepsAt, meanShiftPx: mean(shifts), pngA: firstA && firstA.png, pngB: firstB && firstB.png, frameA: firstA }
}

/* Wait for the base character to be fully JOINED (pose[0] == together ~ 1),
   which is the merged single-blob half of its 13.2 s cycle, and capture. */
async function grabMerged (page, where, ground = GROUND_A, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let veiledFrames = 0, joinedFrames = 0
  while (Date.now() < deadline) {
    const together = await page.evaluate(() => { const s = document.querySelector('.home-circle').homeCircleFluid.stats(); return s.agent && s.agent.character ? s.agent.character[0] : null })
    if (together === null) throw new Error(`${where}: stats().agent.character is not exposed`)
    if (together > 0.995) {
      joinedFrames++
      const shot = face(await H.grabCanvas(page, `${where}/merged`), ground)
      const quietBox = await quietBoxOf(page)
      const dq = M.veilDistance(M.bodyMaskHalfPeak(shot, ground).mask, shot.width, shot.height, quietBox)
      if (dq >= VEIL_CLEAR) return { ...shot, dq, quietBox }
      veiledFrames++
    }
    await page.waitForTimeout(150)
  }
  throw new Error(`${where}: no joined frame clear of the caption veil in ${timeoutMs} ms (${joinedFrames} joined frames seen, ${veiledFrames} under the veil at dq < ${VEIL_CLEAR}); the body did not leave the caption`)
}

const sheet = []
let opened = null
try {
  opened = await H.openHome({ theme: THEMES[0], where: 'material/open', init: SEAT_INIT, log: m => console.log(m) })
  receipt.browser = opened.channel
} catch (error) { refuse('open', error.message) }

if (opened) {
  const { browser } = opened
  let firstPage = opened.page
  for (const theme of THEMES) {
    let page = null
    try {
      page = theme === THEMES[0] ? firstPage : await H.openPage(browser, { theme, where: `${theme}/open`, init: SEAT_INIT })
      if (page.mutations) receipt.mutations = page.mutations
      await H.pinForm(page, { action: 'idle', tool: '', form: 2 })
      await page.waitForTimeout(2500)

      const tr = await transmissionPairs(page, theme)
      if (!tr.pairs) refuse(`${theme}/M1`, `no capture pair survived of the ${tr.attempted} triples attempted (of ${PAIRS} asked for, the rest cut by the ${PAIRS_BUDGET_MS} ms budget): ${tr.unjoined} never reached the joined plateau, ${tr.straddled} left it mid-triple, ${tr.skipped} were discarded by the shape-agreement filter, ${tr.veiled} sat under the caption veil (dq < ${VEIL_CLEAR})`)
      /* The material is judged on the JOINED half of the character's cycle --
         one blob, so the chamfer distance is a thickness and a single catch is
         the right answer. The pair half is two bodies by design and reports
         two catches correctly. */
      await H.setGround(page, GROUND_A)
      const merged = await grabMerged(page, theme)
      const body = measureBody(merged, GROUND_A)
      if (!body) { refuse(`${theme}/body`, 'no body found in the joined capture'); continue }
      const { bands, sil, spec, auto } = body
      /* M5 OVER N JOINED FRAMES, NOT ONE. Measured 2026-09-18 against ONE
         unchanged shader (c4384adb): black silhouette edge width read 0.135 on
         a clean run and 0.242 under a behaviourally identical respelling of the
         same arithmetic, and cobalt read 0.290 on one capture and 0.017 on
         another. The 0.15 bound sits INSIDE that spread, so a cut gated on one
         capture goes red or green by luck. The repair is more captures, not a
         wider bound: widening it to swallow 0.242 would also swallow the real
         softening this gate exists to catch (the soft-edge mutation scores
         0.655). The median is judged; the spread is REPORTED beside it, so a
         person can see how much the instrument moved under the verdict. */
      const edgeRuns = [], haloRuns = [], catchRuns = [], dipRuns = [], spreadSteps = []
      { let frames = 0
        const budget = Date.now() + SPREAD_BUDGET_MS
        while (frames < SPREAD_FRAMES && Date.now() < budget) {
          try {
            const extra = await grabMerged(page, `${theme}/spread${frames}`)
            const eb = measureBody(extra, GROUND_A)
            if (!eb) { frames++; edgeRuns.push(NaN); haloRuns.push(NaN); continue }
            edgeRuns.push(eb.sil.edgeWidth); haloRuns.push(eb.sil.haloEnergy)
            catchRuns.push(eb.spec.peaks); dipRuns.push(M.chromaDip(eb.bands).dip)
            spreadSteps.push((await joinedNow(page)).steps)
            frames++
          } catch (error) { refuse(`${theme}/M5-spread`, `only ${frames} of ${SPREAD_FRAMES} joined frames were taken: ${error.message}`); break }
        } }
      const edgeS = M.medianSpread(edgeRuns), haloS = M.medianSpread(haloRuns)
      receipt.measurements.push({ theme, kind: 'spread', frames: edgeRuns.length, steps: spreadSteps, edgeWidth: edgeS, halo: haloS,
        /* Not gated, reported: 0aa.4 names M9/M10 and M2 as carrying the same
           single-capture risk as M5, and these are the frames to say so from. */
        catchPeaks: catchRuns, chromaDip: M.medianSpread(dipRuns) })
      const union = { ...body.union, spec }
      /* THE SAME JOINED BODY OVER A LIGHT GROUND, for the ground-aware rim
         gate (ruled 2026-09-18): a CLEAR rim transmits whatever is behind it,
         so it goes bright on a light ground and dark on a dark one. Demanding
         a bright rim on black demands the body emit at its edge -- the halo
         the owner rejected. */
      let light = null
      try {
        await H.setGround(page, GROUND_B)
        const mergedLight = await grabMerged(page, `${theme}/light`, GROUND_B)
        const lb = measureBody(mergedLight, GROUND_B)
        if (lb) light = { bands: lb.bands, radial: M.radialLuminance(lb.bands) }
        save(`body-${theme}-merged-light.png`, mergedLight.png)
      } catch (error) { refuse(`${theme}/M6-light`, error.message) }
      await H.setGround(page, GROUND_A)
      if (bands.length < 4) { refuse(`${theme}/bands`, `only ${bands.length} thickness bands; body too small to judge`); continue }
      const rim = bands[0], core = bands[bands.length - 1]
      const dip = M.chromaDip(bands)
      const interior = bands.filter(b => b.thickness >= THRESHOLDS.hueInteriorFrom.value)
      const swing = M.hueSwing(interior)
      const radial = M.radialLuminance(bands)
      const chromaPeak = bands.reduce((best, b) => (b.C > best.C ? b : best), bands[0])

      save(`body-${theme}-merged.png`, merged.png)

      receipt.measurements.push({
        theme, coverage: auto.covered / auto.mask.length, threshold: auto.threshold, peakInk: auto.peak, radius: sil.radius, veilDistance: merged.dq, quietBox: merged.quietBox, faceCrop: FACE,
        transmission: tr.fraction, control: tr.control, pairs: tr.pairs, skipped: tr.skipped, veiled: tr.veiled, meanShiftPx: tr.meanShiftPx,
        chromaDip: dip.dip, chromaPeakBand: chromaPeak.band, hueSwingInterior: swing.swing, hueReference: swing.reference,
        coreL: core.L, coreC: core.C, rimL: rim.L, rimC: rim.C, rimStep: radial.step, rimWorstDrop: radial.worstDrop,
        edgeWidth: sil.edgeWidth, halo: sil.haloEnergy, specularArea: spec.areaFraction, specularPeaks: spec.peaks, chromaRise: core.C - rim.C, light, union: { ...union, spec: undefined }, bands
      })

      console.log(`\n--- ${theme} (body radius ${sil.radius.toFixed(0)}px, coverage ${(auto.covered / auto.mask.length * 100).toFixed(1)}%, half-peak threshold ${auto.threshold.toFixed(0)} of peak ${auto.peak.toFixed(0)}, veil distance ${merged.dq.toFixed(2)}, face crop ${FACE} R)`)
      /* Fewer than three kept pairs is one or two frames of a wandering body,
         not a measurement; say so instead of judging on it. */
      if (tr.pairs && tr.pairs < 3) refuse(`${theme}/M1`, `only ${tr.pairs} of the ${tr.attempted} triples attempted (of ${PAIRS} asked for) survived (${tr.unjoined} never joined, ${tr.straddled} left the plateau mid-triple, ${tr.skipped} discarded by the shape-agreement filter, ${tr.veiled} under the caption veil); transmission ${f3(tr.fraction)} reported, not judged`)
      else if (tr.pairs) check(`${theme}/M1 interior changes under two grounds`,
        tr.fraction >= THRESHOLDS.transmissionFloor.value && tr.fraction >= THRESHOLDS.transmissionOverControl.value * tr.control,
        `transmission ${f3(tr.fraction)} of the ground change (floor ${THRESHOLDS.transmissionFloor.value}), same-ground control ${f3(tr.control)}, ratio ${(tr.fraction / Math.max(tr.control, 1e-9)).toFixed(1)}x (need ${THRESHOLDS.transmissionOverControl.value}x), ${tr.pairs} pairs kept of ${tr.attempted} triples attempted (of ${PAIRS} asked for), taken at renderer steps ${tr.stepsAt.map(x => x[0]).join('/')} (every triple that held the joined plateau end to end, before the veil and shape filters), ${tr.unjoined} never joined, ${tr.straddled} left the plateau mid-triple, ${tr.skipped} discarded for a shape change, ${tr.veiled} under the caption veil, registered by ${tr.meanShiftPx.toFixed(1)} px`)
      check(`${theme}/M2 chroma does not dip across the thickness and does not peak at the rim`,
        dip.dip <= THRESHOLDS.chromaDipMax.value && chromaPeak.band !== 0,
        `deepest dip ${dip.dip.toFixed(4)} at band ${dip.band} (max ${THRESHOLDS.chromaDipMax.value}); chroma peaks at band ${chromaPeak.band} of ${bands.length - 1} (rim is band 0)`)
      check(`${theme}/M3 interior hue holds across the thickness`,
        swing.swing <= THRESHOLDS.hueSwingMax.value,
        `swing ${swing.swing.toFixed(1)} deg about ${swing.reference.toFixed(1)} over bands at thickness >= ${THRESHOLDS.hueInteriorFrom.value} (max ${THRESHOLDS.hueSwingMax.value}); full sweep ${bands.map(b => b.hue.toFixed(0)).join('/')}`)
      check(`${theme}/M4 core luminance in band`,
        core.L >= THRESHOLDS.coreLuminanceLo.value && core.L <= THRESHOLDS.coreLuminanceHi.value,
        `core Oklab L ${core.L.toFixed(3)} (band ${THRESHOLDS.coreLuminanceLo.value}-${THRESHOLDS.coreLuminanceHi.value})`)
      /* Fewer than three readable frames is not a median; say so rather than
         judging a bound that needs a spread on one or two captures. */
      if (edgeS.n < 3) refuse(`${theme}/M5`, `only ${edgeS.n} of ${SPREAD_FRAMES} joined frames were readable (${edgeS.dropped} unreadable, ${SPREAD_FRAMES - edgeRuns.length} never taken within the ${SPREAD_BUDGET_MS} ms budget); edge width ${f3(sil.edgeWidth)} on the single joined capture is reported, not judged`)
      else check(`${theme}/M5 silhouette is a razor with no halo`,
        edgeS.median <= THRESHOLDS.edgeWidthMax.value && haloS.median <= THRESHOLDS.haloMax.value,
        `edge width MEDIAN ${edgeS.median.toFixed(3)} of radius over ${edgeS.n} joined frames (max ${THRESHOLDS.edgeWidthMax.value}); spread ${edgeS.min.toFixed(3)}-${edgeS.max.toFixed(3)}, iqr ${edgeS.iqr.toFixed(3)}, mad ${edgeS.mad.toFixed(3)}; halo MEDIAN ${haloS.median.toFixed(2)}/255 outside the foot (max ${THRESHOLDS.haloMax.value}), spread ${haloS.min.toFixed(2)}-${haloS.max.toFixed(2)}; single-capture edge ${f3(sil.edgeWidth)} for comparison, ${sil.rays} rays`)
      /* M6, GROUND-AWARE. Dark ground: the clear rim carries less dye than the
         core, so chroma RISES rim-to-core and the rim is not brighter than the
         core (a brighter rim on black is emission, the rejected halo). Light
         ground: the rim transmits the light ground and luminance RISES to the
         rim. Both halves are asserted on the same joined body. */
      const chromaRise = core.C - rim.C
      check(`${theme}/M6a on a dark ground the clear rim carries less colour than the core and does not glow`,
        chromaRise >= THRESHOLDS.rimChromaRiseMin.value && radial.step <= THRESHOLDS.rimDarkGlowMax.value,
        `core C ${core.C.toFixed(3)} minus rim C ${rim.C.toFixed(3)} = ${chromaRise.toFixed(3)} (need >= ${THRESHOLDS.rimChromaRiseMin.value}); rim L minus core L ${radial.step.toFixed(3)} on black (must be <= ${THRESHOLDS.rimDarkGlowMax.value}, a bright rim on black is a halo); C sweep ${bands.map(b => b.C.toFixed(3)).join('/')}`)
      if (light) {
        check(`${theme}/M6b on a light ground luminance rises toward the thin rim`,
          light.radial.step >= THRESHOLDS.rimStepMin.value && light.radial.worstDrop <= THRESHOLDS.rimDropMax.value,
          `over white: rim L ${light.radial.rimL.toFixed(3)} minus core L ${light.radial.coreL.toFixed(3)} = ${light.radial.step.toFixed(3)} (need >= ${THRESHOLDS.rimStepMin.value}); worst rim-ward drop ${light.radial.worstDrop.toFixed(3)} (max ${THRESHOLDS.rimDropMax.value}); L sweep ${light.bands.map(b => b.L.toFixed(2)).join('/')}`)
      }
      check(`${theme}/M9 one wet catch with area, not a pin-prick or a sheen`,
        spec.peaks === 1 && spec.areaFraction >= THRESHOLDS.specularAreaLo.value && spec.areaFraction <= THRESHOLDS.specularAreaHi.value,
        `${spec.peaks} catch peak(s) by blurred-L non-maximum suppression over 14 px (need exactly 1); catch area ${(spec.areaFraction * 100).toFixed(2)}% of body within ${0.05} L of its peak (band ${THRESHOLDS.specularAreaLo.value * 100}-${THRESHOLDS.specularAreaHi.value * 100}%); body median L ${f3(spec.medianL)}`)
      check(`${theme}/M10 the joined character is one body with one catch`,
        union.pieces === 1 && union.solidity >= THRESHOLDS.solidityMin.value && union.spec.peaks === 1,
        `${union.pieces} body piece(s), solidity ${f3(union.solidity)} (need >= ${THRESHOLDS.solidityMin.value}), ${union.spec.peaks} catch peak(s)`)

      if (tr.pngA) { save(`body-${theme}-groundA.png`, tr.pngA); save(`body-${theme}-groundB.png`, tr.pngB) }
      const crop = Math.round(sil.radius * 2.6)
      const cx = Math.round(sil.centroid[0] - crop / 2), cy = Math.round(sil.centroid[1] - crop / 2)
      sheet.push({ png: await H.cropPng(page, merged.png, { x: Math.max(0, cx), y: Math.max(0, cy), width: crop, height: crop }), label: `ours ${theme} (joined)` })
    } catch (error) {
      refuse(`${theme}`, `could not look: ${error.message}`)
    } finally { if (page) { receipt.outsideRequests += page.outsideRequests || 0; if (page !== firstPage) await page.gateContext.close().catch(() => {}) } }
  }
  /* The contact sheet: the owner's reference at the same height as each theme's
     body, so a person judges them in one look. The reference is the left 235 px
     of the montage the owner was shown. */
  try {
    if (fs.existsSync(REFERENCE) && sheet.length) {
      const refPng = await H.cropPng(firstPage, fs.readFileSync(REFERENCE), { x: 0, y: 0, width: 235, height: 214 })
      save('contact-sheet.png', await H.composeSheet(firstPage, [{ png: refPng, label: 'owner reference' }, ...sheet], { height: 300 }))
    } else refuse('contact-sheet', `reference image not found at ${REFERENCE}`)
  } catch (error) { refuse('contact-sheet', error.message) }
  await browser.close().catch(() => {})
}

receipt.finishedAt = new Date().toISOString()
let exitCode = 0
/* A REFUSAL IS NOT A PASS AT THE CUT. The receipt guard reads only errors and
   checks, so a run that measured some gates and could not measure others --
   or was ended by the watchdog after one green check -- would read as
   observed-pass (measured 2026-09-18: a watchdog-ended motion run with D1
   green and nothing else passed the cut view). Every refusal is therefore also
   an error in the receipt, and the exit code says partial. */
for (const r of receipt.refusals) receipt.errors.push(`not measured: ${r}`)
if (!receipt.checks.length) { console.log('\nNO GATE RAN. This is a refusal, not a pass.'); exitCode = 2 } else if (receipt.refusals.length) exitCode = 2; else if (receipt.errors.length) exitCode = 1
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(receipt, null, 2))
console.log(`\nchecks ${receipt.checks.length}  failures ${receipt.errors.length}  refusals ${receipt.refusals.length}${receipt.mutations ? '  MUTATED RUN: ' + receipt.mutations.map(m => m.why || m.find.slice(0, 40)).join('; ') : ''}`)
console.log(`receipt ${path.join(OUT, 'results.json')}`)
for (const s of receipt.subject) console.log(`subject ${s.file} sha256 ${s.sha256} mtime ${s.mtime}`)
for (const e of receipt.errors) console.log('  RED     ' + e)
for (const r of receipt.refusals) console.log('  REFUSED ' + r)
process.exit(exitCode)
