#!/usr/bin/env node
/* THE MOTION GATE for the home circle's body (T365): determinism, bounce,
 * squash, state change, and "not a crossfade".
 *
 * WHY IT EXISTS. The owner: "it needs to be ... bouncy and squishy and changes
 * its state like liquid, mist, solid and bouncy, through the animations."
 * Nothing measured the motion. This driver samples the body EVERY FRAME the
 * renderer draws (tools/test/home-circle-gate-harness.mjs, SAMPLER_INIT) and
 * judges the series with the pure measures in home-circle-motion-measure.mjs,
 * each of which was first proved on synthetic motion whose answer is known.
 *
 * WHAT IT DOES NOT DO. It never reads src/. It sees pixels and the renderer's
 * own stats() and nothing else, so it cannot pin a spelling.
 *
 * STATES, read from the code rather than assumed: the renderer derives one
 * scalar (wisp) from the agent action's form and reads it as solid / liquid /
 * mist. idle is the base character (form 2, solid); tool work is the orbit
 * set (form 4, liquid band); thinking is the cloud (form 1, mist). "speaking"
 * and "listening" are voice modes, not agent actions, and are not driven here.
 *
 * USAGE  node tools/test/fixtures/run-home-circle-jelly-motion.mjs
 * Env    HOME_CIRCLE_ORIGIN (default http://127.0.0.1:4623)
 *        HOME_CIRCLE_THEME  (default black)
 *        HOME_CIRCLE_OUT    receipt directory
 *        HOME_CIRCLE_CHANNEL browser channel to try first (else msedge, chrome, chromium)
 * Exit 0 every gate passed - 1 a gate is red - 2 a gate could not be measured (a refusal is never a pass).
 * A REFUSAL (could not look) is recorded apart from a FAILURE (looked, wrong).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as H from '../home-circle-gate-harness.mjs'
import * as X from '../home-circle-motion-measure.mjs'
import * as M from '../home-circle-picture-measure.mjs'
import { MOTION } from '../home-circle-jelly-thresholds.mjs'

const HERE = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(HERE), '..', '..', '..')
const THEME = process.env.HOME_CIRCLE_THEME || 'black'
const OUT = process.env.HOME_CIRCLE_OUT || path.join(REPO, 'private', 'browser-proof-receipts', 'run-home-circle-jelly-motion')
const GROUND = [0, 0, 0]
/* The canvas covers the whole ring and the body lane draws the ring's brim
   in-canvas at ~0.88 of its radius; everything outside 0.8 is cropped before
   a silhouette is read. */
const CROP = 0.8
const SEED = Number(process.env.HOME_CIRCLE_SEED || 7)
const DT = 1 / 30
/* The five fleet attributes pinned on every page so the example fleet cannot
   start an agent-change episode under a measurement. */
const PIN = { key: 'gate', name: 'gate', event: '0' }
/* Init script as SOURCE TEXT: addInitScript serialises its argument as JSON,
   so a function passed inside `arg` arrives as undefined (measured: three runs
   refused with "Cannot set properties of undefined (setting 'frames')"). */
const PIN_INIT = H.PIN_INIT
/* The init-script pin is for the D1 pages ONLY, whose state never changes.
   On the main page it fought pinState's own observer -- each restoring its
   value on the other's mutation, an endless microtask loop that livelocked
   the page and stalled three runs at "state liquid: pinning". The main page
   pins after boot through pinState, which D1 does not need. */
const seededInit = (seed, state = null) => `window.homeCircleFluidTest = ${JSON.stringify({ seed, dt: DT })}; (${H.SAMPLER_INIT.toString()})();` + (state ? ` (${PIN_INIT.toString()})(${JSON.stringify(state)})` : '')
const STATES = {
  solid: { action: 'idle', tool: '', form: 2 },
  liquid: { action: 'running', tool: 'Edit', form: 4 },
  mist: { action: 'thinking', tool: '', form: 1 }
}
const TRANSITIONS = [['solid', 'liquid'], ['liquid', 'mist'], ['mist', 'solid']]

const receipt = {
  driver: { file: 'tools/test/fixtures/run-home-circle-jelly-motion.mjs', sha256: createHash('sha256').update(fs.readFileSync(HERE)).digest('hex') },
  subject: ['src/home-circle-fluid.js', 'src/home-circle-motion.js', 'src/home-circle-forms.js'].map(f => H.fingerprint(REPO, f)),
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  origin: H.ORIGIN, theme: THEME, seed: SEED, dt: DT, thresholds: MOTION, states: STATES, browser: null,
  checks: [], errors: [], refusals: [], measurements: {}, artifacts: [], outsideRequests: 0
}
const check = (name, ok, detail) => {
  receipt.checks.push(name)
  if (!ok) receipt.errors.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`)
}
const refuse = (name, why) => { receipt.refusals.push(`${name}: ${why}`); console.log(`REFUSED  ${name}  -- ${why}`) }
const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); receipt.artifacts.push(name) }
const started = Date.now()
const progress = m => console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s ${m}`)
const mean = a => a.reduce((t, v) => t + v, 0) / a.length
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) }

fs.mkdirSync(OUT, { recursive: true })

/* WATCHDOG. A dev-server page reload under a capture (another lane saving a
   module the page imports) left one run waiting for 20 minutes with its
   browser alive and the receipt never written. A run that outlives its
   budget is a refusal with a name, and it lets go of its browser. */
const WATCHDOG_MS = Number(process.env.HOME_CIRCLE_WATCHDOG_MS || 360000)
setTimeout(() => {
  console.log(`REFUSED  watchdog  -- the run exceeded ${WATCHDOG_MS} ms; a page reload under the capture (a module saved by another lane) is the usual cause. Nothing was scored.`)
  try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...receipt, refusals: [...receipt.refusals, `watchdog: run exceeded ${WATCHDOG_MS} ms`], errors: [...receipt.errors, `watchdog: the run exceeded ${WATCHDOG_MS} ms and was not completed`], finishedAt: new Date().toISOString() }, null, 2)) } catch { /* nothing to write */ }
  process.exit(2)
}, WATCHDOG_MS).unref()

/* THE MATERIAL'S OWN DECLARED LIGHT STOP, read from the renderer rather than
   assumed: stats().stops.light is materialStop('thin') -- the illuminant through
   the absorber over the thinnest path, tonemapped and encoded to sRGB exactly
   like the pixels are. Its own comment in src/home-circle-fluid.js says it is
   there so "a probe that wants to bound the brightest pixel the material can
   draw has the right number to bound it against". That is this gate. */
const lightStopOf = page => page.evaluate(() => {
  const s = document.querySelector('.home-circle').homeCircleFluid.stats()
  return s.stops && s.stops.light ? s.stops.light : null
})

/* GATE M7, one frame: how much of the body sits above that stop, with the one
   wet catch excluded because a reflection is not the material. */
function overStopOfFrame (f, stop) {
  const cropped = M.cropToFace(f, GROUND, CROP)
  const body = M.bodyMaskHalfPeak(cropped, GROUND)
  if (!body.covered) return null
  const spec = M.specularPeaks(cropped, body.mask, cropped.width, cropped.height)
  return M.overStopWhite(cropped, body.mask, stop, { exclude: spec.catchMask, tolerance: MOTION.overStopTolerance.value })
}

/* Per-frame measures of one live frame. */
function measureFrame (f) {
  const s = X.silhouetteOfFrame(f, GROUND, 24, { cropRadius: CROP })
  const auto = M.bodyMaskHalfPeak(f, GROUND)
  // soft fraction: ink pixels (above 8) that sit below the body's half-peak,
  // i.e. how much of what is drawn is faint skirt rather than body.
  let faint = 0, inked = 0
  for (let p = 0; p < auto.ink.length; p++) { if (auto.ink[p] > 8) { inked++; if (auto.ink[p] <= auto.threshold) faint++ } }
  /* Two INDEPENDENT live measures for the state gate (recalibrated on live
     captures, 2026-09-18): how much of the face the drawn material covers
     (thinking cloud 0.146 of the face vs idle body 0.042 in the presence
     proof) and how colourful it is (solid chroma 0.14-0.23 vs mist under
     0.1). Size and colour cannot both be moved by one knob. */
  let chroma = 0, chromaN = 0
  for (let p = 0, i = 0; p < auto.mask.length; p++, i += 4) if (auto.mask[p]) { chroma += M.oklchFromSrgb(f.data[i], f.data[i + 1], f.data[i + 2]).C; chromaN++ }
  /* Coverage is the HALF-PEAK body over the face (the same number the presence
     proof reads: cloud 0.146, idle body 0.042); ink-above-8 counted dither and
     the skin drift and read 0.25 +/- 0.21 for a still body. Edge width is the
     silhouette's 80->20 % fall as a fraction of its radius: a solid has a
     3-8 px edge at 2x, a mist has none. */
  const cropped = M.cropToFace(f, GROUND, CROP)
  const body = M.bodyMaskHalfPeak(cropped, GROUND)
  const sil = M.silhouetteProfile(cropped, body.mask, GROUND, 90)
  return { t: f.t, width: s.width, height: s.height, area: s.area, interior: s.interiorInk, soft: inked ? faint / inked : 0, coverage: body.covered / (f.width * f.height), edge: Number.isFinite(sil.edgeWidth) ? sil.edgeWidth : 1, chroma: chromaN ? chroma / chromaN : 0, mask: s.mask, inkMean: inked ? Array.from(auto.ink).reduce((t, v) => t + v, 0) / inked : 0 }
}
/* Churn: mean absolute change between successive live frames inside the union
   of their ink, over the mean ink -- how much the drawn material moves. */
function churn (a, b) {
  let total = 0, n = 0
  for (let p = 0; p < a.mask.length; p++) {
    if (!a.mask[p] && !b.mask[p]) continue
    const i = p * 4
    total += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
    n++
  }
  return n ? total / n : 0
}
function withMask (frames) { return frames.map(f => ({ ...f, mask: X.silhouetteOfFrame(f, GROUND, 24, { cropRadius: CROP }).mask })) }

async function record (page, ms, size = 128) {
  await H.armSampler(page, { size, max: 1200 })
  await page.waitForTimeout(ms)
  const out = await H.drainSampler(page)
  if (out.error) throw new Error(`sampler: ${out.error}`)
  const live = H.liveFrames(out.frames, GROUND)
  if (live.length < 10) throw new Error(`sampler saw only ${live.length} drawn frames in ${ms} ms`)
  return live
}

let opened = null
try {
  opened = await H.openHome({ theme: THEME, init: seededInit(SEED), where: 'motion/open', log: m => console.log(m) })
  receipt.browser = opened.channel
} catch (error) { refuse('open', error.message) }

if (opened) {
  const { browser, page } = opened
  /* A PAGE RELOAD UNDER THE RUN (another lane saving a module the page
     imports) throws the pinned state and the armed sampler away; two runs
     stalled at the next state for the full watchdog. Name it and stop. */
  let reloaded = false
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloaded = true })
  const guardReload = where => { if (reloaded) throw Object.assign(new Error(`${where}: the page reloaded under the run (a module saved by another lane); refusing to score a page whose pinned state and sampler were reset`), { refusal: 'page-reloaded' }) }
  try {
    await H.setGround(page, GROUND)

    /* ------------------------------------------------ D1 determinism */
    try {
      progress('D1: three seeded pages')
      /* The affordance (body lane, 2026-09-18): window.homeCircleFluidTest =
         { seed, dt } set before mount seeds every draw and fixes the step;
         stats().deterministic reports it. Three fresh pages: seed A, seed A
         again, seed B, all five fleet attributes pinned BEFORE boot. The frame
         at step N is read back from the framebuffer at the display draw
         itself (sampler), keyed on the step count, so it is attributable to
         frame N and never a cleared buffer.
         Same seed must agree to the pixel; a different seed must NOT, or the
         "agreement" is a frozen or blank canvas (a no-op affordance passed a
         two-run compare on blank captures once; the body check and the
         different-seed control close that). */
      const N = 90
      const shots = []
      let hook = null
      for (const [run, seed] of [['A1', SEED], ['A2', SEED], ['B', SEED + 4242]]) {
        const p = await H.openPage(browser, { theme: THEME, init: seededInit(seed, { ...STATES.solid, ...PIN }), where: `D1/${run}` })
        await H.setGround(p, GROUND)
        await H.pinState(p, { ...STATES.solid, ...PIN })
        hook = await p.evaluate(() => document.querySelector('.home-circle').homeCircleFluid.stats().deterministic)
        if (!hook) throw Object.assign(new Error(`D1/${run}: stats().deterministic is null -- the renderer did not read window.homeCircleFluidTest`), { d1: 'no-hook' })
        await H.armSampler(p, { size: 256, max: 2000 })
        await p.waitForFunction(n => document.querySelector('.home-circle').homeCircleFluid.stats().steps >= n + 2, N, { timeout: 60000 })
        const out = await H.drainSampler(p)
        const atN = out.frames.filter(f => f.steps === N)
        if (!atN.length) throw new Error(`D1/${run}: no sampled frame at step ${N} (steps seen ${out.frames.slice(0, 5).map(f => f.steps).join(',')}...)`)
        const shot = atN[atN.length - 1]
        const body = M.bodyMaskHalfPeak(shot, GROUND)
        if (!body.covered || body.peak < 24) throw new Error(`D1/${run}: the frame at step ${N} holds no body (peak ink ${body.peak.toFixed(0)}); refusing to compare blanks`)
        shot.png = await H.composeStrip(p, [shot], { scale: 1, labels: [`${run} step ${N} seed ${seed}`] })
        shots.push(shot)
        await p.gateContext.close()
      }
      const same = X.frameDifference(shots[0], shots[1], 2)
      const other = X.frameDifference(shots[0], shots[2], 2)
      receipt.measurements.determinism = { hook, step: N, sameSeed: same, otherSeed: other }
      check('D1 fixed-step, seeded, reproducible frames', same.differing <= MOTION.determinismMaxDiffering.value && other.differing > MOTION.determinismMaxDiffering.value,
        `hook ${JSON.stringify(hook)}; same seed: ${same.differing} of ${same.pixels} pixels differ at step ${N} (max ${MOTION.determinismMaxDiffering.value}); different seed: ${other.differing} differ (must be > ${MOTION.determinismMaxDiffering.value}, or the seed is not read)`)
      save('determinism-A1.png', shots[0].png); save('determinism-A2.png', shots[1].png); save('determinism-B.png', shots[2].png)
    } catch (error) {
      if (error.d1 === 'no-hook') check('D1 fixed-step, seeded, reproducible frames', false, error.message)
      else refuse('D1', error.message)
    }

    /* ------------------------------------------------ states */
    progress('states')
    const byState = {}
    for (const [name, st] of Object.entries(STATES)) {
      try {
        guardReload(`state/${name}`)
        progress(`state ${name}: pinning`)
        await H.pinForm(page, { ...st, ...PIN })
        /* SETTLE UNTIL THE STATE IS STABLE, not for a fixed 3 s: the previous
           state's mist takes about 2.5 s to drain on this build (the T6
           defect), and a fixed wait recorded the tail of the transition as
           the state -- a "solid" sample that was mist dissolving for its
           first half (coverage 0.078 +/- 0.100). Two consecutive half-second
           windows whose coverage agrees within a fifth is stable; 12 s is the
           most it waits, and a state still moving then is recorded as it is
           and says so. */
        progress(`state ${name}: settling`)
        let stableAfterMs = null
        { let previous = null; const t0 = Date.now()
          while (Date.now() - t0 < 12000) {
            await H.armSampler(page, { size: 128, max: 200 }); await page.waitForTimeout(500)
            const w = H.liveFrames((await H.drainSampler(page)).frames, GROUND)
            const cov = w.length ? mean(w.map(f => M.bodyMaskHalfPeak(M.cropToFace(f, GROUND, CROP), GROUND).covered)) : 0
            if (previous !== null && cov > 0 && Math.abs(cov - previous) <= previous * 0.2) { stableAfterMs = Date.now() - t0; break }
            previous = cov
          } }
        progress(`state ${name}: ${stableAfterMs === null ? 'NOT stable after 12 s, recording as it is' : 'stable after ' + stableAfterMs + ' ms'}, recording`)
        const live = withMask(await record(page, 3000))
        progress(`state ${name}: measuring ${live.length} frames`)
        const rows = live.map(measureFrame)
        const churns = []
        for (let i = 1; i < live.length; i++) churns.push(churn(live[i - 1], live[i]) / Math.max(1, rows[i].inkMean))
        /* ------------------------------------------------ M7 over-stop white
           The owner has rejected additive white four times. Until today the
           only thing enforcing it was arithmetic lifted out of the shader BY
           NAME in home-circle-motion-runtime.test.mjs, and that stopped binding
           when the colour law moved to an absorption model -- the bans reported
           nothing while the liquid gained mix(1.0, 1.25, ...) and the mist a
           flat 1.3x over uJellyIllum (REPORT-JELLY-GATE-20260918.md 0aa.5:
           "nothing measures it now"). This measures the claim on the
           FRAMEBUFFER, so any colour law that keeps it passes and a spelling
           can never be the fix. A MEDIAN over the recorded frames, for the same
           reason M5 is: one capture of this renderer is not a verdict. */
        const stop = await lightStopOf(page)
        let overStop = null
        if (!stop) refuse(`state/${name}/M7`, 'stats().stops.light is not exposed, so the material declares no light stop to bound the picture against; nothing was scored')
        else {
          const perFrame = live.map(f => overStopOfFrame(f, stop)).filter(Boolean)
          overStop = { stop, frames: perFrame.length, ofFrames: live.length,
            area: M.medianSpread(perFrame.map(o => o.overFraction)),
            worst: M.medianSpread(perFrame.map(o => o.worst)),
            p995: M.medianSpread(perFrame.map(o => o.p995)),
            middle: M.medianSpread(perFrame.map(o => o.median)) }
        }
        byState[name] = { soft: rows.map(r => r.soft), churn: churns, area: rows.map(r => r.area), coverage: rows.map(r => r.coverage), edge: rows.map(r => r.edge), chroma: rows.map(r => r.chroma), frames: live.length, stableAfterMs, overStop }
        receipt.measurements[`state-${name}`] = { frames: live.length, stableAfterMs, overStop, coverage: { mean: mean(byState[name].coverage), sd: sd(byState[name].coverage) }, edge: { mean: mean(byState[name].edge), sd: sd(byState[name].edge) }, chroma: { mean: mean(byState[name].chroma), sd: sd(byState[name].chroma) }, soft: { mean: mean(byState[name].soft), sd: sd(byState[name].soft) }, churn: { mean: mean(churns), sd: sd(churns) }, area: { mean: mean(byState[name].area) } }
        console.log(`state ${name}: ${live.length} frames, coverage ${mean(byState[name].coverage).toFixed(3)}±${sd(byState[name].coverage).toFixed(3)}, edge ${mean(byState[name].edge).toFixed(3)}±${sd(byState[name].edge).toFixed(3)}, chroma ${mean(byState[name].chroma).toFixed(3)}±${sd(byState[name].chroma).toFixed(3)}, churn ${mean(churns).toFixed(3)}`)
        const pick = live.filter((_, i) => i % Math.max(1, Math.floor(live.length / 8)) === 0).slice(0, 8)
        save(`state-${name}-strip.png`, await H.composeStrip(page, pick, { scale: 2, labels: pick.map(f => `${name} ${(f.t - live[0].t).toFixed(0)}ms`) }))
      } catch (error) { refuse(`state/${name}`, error.message) }
    }
    if (Object.keys(byState).length === 3) {
      const softSep = X.stateSeparation({ solid: byState.solid.coverage, liquid: byState.liquid.coverage, mist: byState.mist.coverage }, { minD: MOTION.stateSeparationD.value })
      const churnSep = X.stateSeparation({ solid: byState.solid.edge, liquid: byState.liquid.edge, mist: byState.mist.edge }, { minD: MOTION.stateSeparationD.value })
      receipt.measurements.separation = { coverage: softSep.pairs, edge: churnSep.pairs, chroma: X.stateSeparation({ solid: byState.solid.chroma, liquid: byState.liquid.chroma, mist: byState.mist.chroma }).pairs }
      /* Every pair must separate on at least one of the two measures, and each
         measure must separate at least one pair, so neither can be dead. */
      const pairOk = softSep.pairs.map((p, i) => ({ pair: `${p.a}/${p.b}`, ok: p.d >= MOTION.stateSeparationD.value || churnSep.pairs[i].d >= MOTION.stateSeparationD.value, soft: p.d, churn: churnSep.pairs[i].d }))
      const measuresUsed = [softSep.pairs.some(p => p.d >= MOTION.stateSeparationD.value), churnSep.pairs.some(p => p.d >= MOTION.stateSeparationD.value)]
      check('T4 solid, liquid and mist separate on two independent measures', pairOk.every(p => p.ok) && measuresUsed.every(Boolean),
        pairOk.map(p => `${p.pair}: coverage d ${p.soft.toFixed(1)}, edge d ${p.churn.toFixed(1)}`).join('; ') + ` (need d >= ${MOTION.stateSeparationD.value} on one of them per pair, both measures used)`)

      /* T4b ABSOLUTE ANCHORS. Cohen's d is scale-free: a pair whose means sit
         0.001 apart passes at d = 50 if the variance is smaller still, and a
         pair a person could not confuse fails if both states are noisy. T4
         alone therefore says "separable", not "different to look at". These
         four anchors are the live measurements from the presence proof
         (2026-09-18) and each is a number someone can point at on screen.
         Every one is checked against the state it was measured on, so a body
         that drifts out of the look while staying statistically separable is
         a RED here and a green on T4. */
      const perState = name => ({ coverage: mean(byState[name].coverage), edge: mean(byState[name].edge), chroma: mean(byState[name].chroma) })
      const anchors = X.stateAnchors({ solid: perState('solid'), mist: perState('mist') }, MOTION)
      receipt.measurements.stateAnchors = anchors
      check('T4b solid and mist are separated by the absolute amounts measured live, not only by Cohen\'s d',
        anchors.ok,
        anchors.rows.map(r => `${r.ok ? 'ok' : 'RED'} ${r.name}: ${r.detail}`).join('; '))
    }

    /* --------------------------------------- M7 over-stop white, per state */
    for (const name of Object.keys(STATES)) {
      const st = byState[name]
      if (!st) continue
      const o = st.overStop
      if (!o) continue
      if (o.area.n < 3) { refuse(`M7/${name}`, `only ${o.area.n} of ${o.ofFrames} recorded frames carried a body, so there is no median to judge; nothing scored`); continue }
      check(`M7 the ${name} state draws no light above the material's own declared stop`,
        o.area.median <= MOTION.overStopAreaMax.value,
        `${(o.area.median * 100).toFixed(1)}% of the body sits over the declared light stop rgb(${o.stop.map(v => (v * 255).toFixed(0)).join(',')}) with the wet catch excluded, median over ${o.area.n} frames (max ${(MOTION.overStopAreaMax.value * 100).toFixed(0)}%, the area M9 already allows the catch); spread ${(o.area.min * 100).toFixed(1)}-${(o.area.max * 100).toFixed(1)}%, mad ${(o.area.mad * 100).toFixed(1)}%; worst multiple of the stop ${o.worst.median.toFixed(2)}x, p995 ${o.p995.median.toFixed(2)}x, body middle ${o.middle.median.toFixed(2)}x`)
    }

    /* ------------------------------------------------ transitions */
    const stripFrames = [], stripLabels = []
    for (const [from, to] of TRANSITIONS) {
      const label = `${from}->${to}`
      try {
        guardReload(`transition/${label}`)
        await H.pinForm(page, { ...STATES[from], ...PIN })
        await page.waitForTimeout(3000)
        await H.armSampler(page, { size: 128, max: 1200 })
        await page.waitForTimeout(700)
        const switchedAt = await page.evaluate(() => performance.now())
        await H.pinState(page, { action: STATES[to].action, tool: STATES[to].tool, ...PIN })
        await page.waitForTimeout(3300)
        const out = await H.drainSampler(page)
        const live = withMask(H.liveFrames(out.frames, GROUND))
        if (live.length < 30) throw new Error(`only ${live.length} drawn frames`)
        const rows = live.map(measureFrame)
        const dts = []
        for (let i = 1; i < live.length; i++) dts.push(live[i].t - live[i - 1].t)
        dts.sort((a, b) => a - b)
        const dtMs = dts[dts.length >> 1]
        const pick = key => H.resample(rows, r => r[key], dtMs).series
        const width = pick('width'), height = pick('height'), area = pick('area'), interior = pick('interior')
        const t0 = rows[0].t
        const k0 = Math.max(1, Math.round((switchedAt - t0) / dtMs))
        const post = s => s.slice(k0)
        const tail = post(width).slice(-15)
        const rest = mean(tail), dead = Math.max(1, 2 * sd(tail))
        const over = X.restCrossings(post(width), rest, { deadband: dead, minExcursion: dead })
        const dur = X.transitionDuration(post(area), dtMs)
        const settleK = dur.settleAt === null ? post(area).length - 1 : dur.settleAt
        /* T3 ON THE ARRIVED BODY. Measured across the whole transition the
           axes tracked the mist fading (corr 0.13-0.59, area drift 3-5):
           that is the old form leaving, not the new one squashing. The
           squash is the spring ringing on the body that has ARRIVED, so the
           window opens where the area first comes within a quarter of its
           final value and runs to the end; changes under 1.5 px are dither
           and skin drift, not motion (body lane, 2026-09-18). */
        const finalArea = mean(post(area).slice(-10))
        let arrived = post(area).findIndex(a => Math.abs(a - finalArea) <= finalArea * 0.25)
        if (arrived < 0) arrived = 0
        const windowEnd = post(width).length
        const squash = X.axisOpposition(post(width).slice(arrived, windowEnd), post(height).slice(arrived, windowEnd), { minMotion: 1.5 })
        const lag = X.interiorLag(post(width).slice(arrived, windowEnd), post(interior).slice(arrived, windowEnd), dtMs, { noiseFloor: MOTION.interiorNoiseFloorLsb.value })
        // not-a-crossfade: endpoints are the last pre-switch frame and the last frame; middle is halfway through the travel
        const frameAt = k => live[Math.min(live.length - 1, Math.max(0, Math.round(k)))]
        const A = frameAt(k0 - 1), B = live[live.length - 1]
        const midK = k0 + (dur.departAt ?? 0) + Math.max(1, Math.round(((dur.settleAt ?? post(area).length - 1) - (dur.departAt ?? 0)) / 2))
        const mid = frameAt(midK)
        const union = new Uint8Array(A.mask.length)
        for (let p = 0; p < union.length; p++) union[p] = (A.mask[p] || B.mask[p] || mid.mask[p]) ? 1 : 0
        const blend = X.linearBlendResidual(A, B, mid, { mask: union })
        receipt.measurements[`transition-${label}`] = { frames: live.length, dtMs, switchIndex: k0, rest, deadband: dead, crossings: over, durationMs: dur.durationMs, departAt: dur.departAt, settleAt: dur.settleAt, squash, lagMs: lag.lagMs, lagCorrelation: lag.correlation, blendResidual: blend.residual, width: post(width), height: post(height), area: post(area) }
        console.log(`\n--- ${label}: ${live.length} drawn frames at ${dtMs.toFixed(1)} ms`)
        const intoSolid = to === 'solid'
        check(`T1 ${label} silhouette overshoots and crosses rest twice${intoSolid ? '' : ' (reported; gated on the transition into solid)'}`,
          intoSolid ? over.count >= MOTION.overshootCrossings.value : true,
          `${over.count} crossings of rest width ${rest.toFixed(1)}px (deadband ${dead.toFixed(1)}px), peak excursion ${over.peakExcursion.toFixed(1)}px (need ${MOTION.overshootCrossings.value})`)
        check(`T2 ${label} intermediate frame is not a linear blend of its endpoints`, blend.residual >= MOTION.blendResidualMin.value,
          `best-fit residual ${Number.isFinite(blend.residual) ? blend.residual.toFixed(3) : blend.residual} of endpoint difference (need >= ${MOTION.blendResidualMin.value}); fit a ${blend.coefficients ? blend.coefficients.a.toFixed(2) : '?'} b ${blend.coefficients ? blend.coefficients.b.toFixed(2) : '?'}`)
        check(`T3 ${label} axes move in opposition with area held${intoSolid ? '' : ' (reported; gated on the transition into solid)'}`,
          intoSolid ? (squash.correlation <= MOTION.axisCorrelationMax.value && squash.areaDrift <= MOTION.areaDriftMax.value) : true,
          `width/height change correlation ${Number.isFinite(squash.correlation) ? squash.correlation.toFixed(2) : squash.correlation} (need <= ${MOTION.axisCorrelationMax.value}), area drift ${squash.areaDrift.toFixed(3)} (max ${MOTION.areaDriftMax.value}), ${squash.moving} moving samples`)
        /* T5 IS REPORTED, NOT GATED. It was written for the fluid substrate;
           the body is one analytic field now and has no interior to lag its
           silhouette -- what moves inside it per frame is dither and a slow
           skin drift, uncorrelated by construction. The deformation memory the
           gate wanted is the spring on the shape, which T1 measures directly.
           A body with a real inner layer would make this a gate again. */
        check(`T5 ${label} interior lag (reported; an analytic body has no interior, the elastic memory is gated by T1)`, true,
          lag.undecidable
            ? `UNDECIDABLE: ${lag.reason}. Nothing is scored off dither.`
            : `lag ${lag.lagMs.toFixed(0)} ms at correlation ${Number.isFinite(lag.correlation) ? lag.correlation.toFixed(2) : lag.correlation}, interior p5-p95 ${lag.amplitude.interior.toFixed(2)} ink LSB over a floor of ${MOTION.interiorNoiseFloorLsb.value} (no band: retired, see thresholds)`)
        check(`T6 ${label} transition takes 350-600 ms`, dur.durationMs >= MOTION.transitionLoMs.value && dur.durationMs <= MOTION.transitionHiMs.value,
          `${Number.isFinite(dur.durationMs) ? dur.durationMs.toFixed(0) + ' ms' : 'never settled'} from departure at sample ${dur.departAt} to settle at ${dur.settleAt} (band ${MOTION.transitionLoMs.value}-${MOTION.transitionHiMs.value})`)
        const stripPick = []
        for (let k = 0; k < 10; k++) stripPick.push(frameAt(k0 - 2 + k * Math.max(1, Math.round(150 / dtMs))))
        stripFrames.push(...stripPick); stripLabels.push(...stripPick.map((f, i) => `${i === 0 ? label + ' ' : ''}${(f.t - switchedAt).toFixed(0)}ms`))
        save(`transition-${from}-${to}-strip.png`, await H.composeStrip(page, stripPick, { scale: 2, labels: stripPick.map(f => `${(f.t - switchedAt).toFixed(0)}ms`) }))
      } catch (error) { refuse(`transition/${label}`, error.message) }
    }
    if (stripFrames.length) save('motion-strip.png', await H.composeStrip(page, stripFrames, { scale: 1, labels: stripLabels }))
    receipt.outsideRequests = page.outsideRequests
  } catch (error) { refuse('run', error.message) } finally { await browser.close().catch(() => {}) }
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
console.log(`\nchecks ${receipt.checks.length}  failures ${receipt.errors.length}  refusals ${receipt.refusals.length}`)
console.log(`receipt ${path.join(OUT, 'results.json')}`)
for (const s of receipt.subject) console.log(`subject ${s.file} sha256 ${s.sha256} mtime ${s.mtime}`)
for (const e of receipt.errors) console.log('  RED     ' + e)
for (const r of receipt.refusals) console.log('  REFUSED ' + r)
process.exit(exitCode)
