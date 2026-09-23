#!/usr/bin/env node
/* PRESENCE AND FRAME-TIME gate for the home circle (T360 / T365 precondition).
 *
 * WHY. Twice in one day the shipped picture and a lane's own instrumentation
 * disagreed: an optics module passed 8/8 in a rig while the shipped body
 * measured flat, and the body lane reported "the body isn't visible at all,
 * but the renderer says it is running with no error note". Manager then found
 * the ring interior COMPLETELY EMPTY in the "waiting" agent state, renderer
 * state "paused", steps 0. No gate caught "the character is absent in a real
 * agent state". This one does, from the REAL page, per theme, per state.
 *
 * P0  in every real agent state the renderer is stepping and a body is drawn
 *     (ink covers a stated fraction of the canvas, with a stated peak).
 * P1  frame time on the real page, idle and thinking: median and p95 drawn-
 *     frame interval, dropped-frame fraction, and the renderer's own work
 *     time. This is the BASELINE the owner's "keep lag in mind" is enforced
 *     against once 3D lands; the receipt keeps the numbers.
 *
 * Refusals (dead bundle, software WebGL, dead shader) are named by the harness
 * and are never verdicts. Every verdict line carries the shader's sha256.
 *
 * USAGE  node tools/test/fixtures/run-home-circle-jelly-presence.mjs
 * Env    HOME_CIRCLE_ORIGIN, HOME_CIRCLE_THEMES (default black,white,cobalt,ember),
 *        HOME_CIRCLE_OUT, HOME_CIRCLE_CHANNEL, HOME_CIRCLE_MUTATIONS
 * Exit 0 all green - 1 a gate is red - 2 nothing could be measured.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as H from '../home-circle-gate-harness.mjs'
import * as M from '../home-circle-picture-measure.mjs'
import { PRESENCE } from '../home-circle-jelly-thresholds.mjs'

const HERE = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(HERE), '..', '..', '..')
const THEMES = (process.env.HOME_CIRCLE_THEMES || 'black,white,cobalt,ember').split(',').map(s => s.trim()).filter(Boolean)
const OUT = process.env.HOME_CIRCLE_OUT || path.join(REPO, 'private', 'browser-proof-receipts', 'run-home-circle-jelly-presence')
const GROUND = [0, 0, 0]
/* The circle's own states, from src (data-agent-action values the renderer
   reads): idle, waiting, reading, thinking, writing, running. */
const STATES = [
  { action: 'idle', tool: '' }, { action: 'waiting', tool: '' }, { action: 'reading', tool: '' },
  { action: 'thinking', tool: '' }, { action: 'writing', tool: 'reply' }, { action: 'running', tool: 'Edit' }
]

const subject = H.fingerprint(REPO, 'src/home-circle-fluid.js')
const TAG = `[fluid ${subject.sha256 ? subject.sha256.slice(0, 8) : 'unread'}]`
const receipt = {
  driver: { file: 'tools/test/fixtures/run-home-circle-jelly-presence.mjs', sha256: createHash('sha256').update(fs.readFileSync(HERE)).digest('hex') },
  subject: [subject, H.fingerprint(REPO, 'src/home-circle-motion.js'), H.fingerprint(REPO, 'src/views/home.js')],
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  origin: H.ORIGIN, thresholds: PRESENCE, browser: null, mutations: null,
  checks: [], errors: [], refusals: [], measurements: [], artifacts: [], outsideRequests: 0
}
const check = (name, ok, detail) => {
  receipt.checks.push(name)
  if (!ok) receipt.errors.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${TAG} ${name}${detail ? `  -- ${detail}` : ''}`)
}
const refuse = (name, why) => { receipt.refusals.push(`${name}: ${why}`); console.log(`REFUSED  ${TAG} ${name}  -- ${why}`) }
const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); receipt.artifacts.push(name) }
fs.mkdirSync(OUT, { recursive: true })

/* WATCHDOG. A dev-server page reload under a capture (another lane saving a
   module the page imports) left one run waiting for 20 minutes with its
   browser alive and the receipt never written. A run that outlives its
   budget is a refusal with a name, and it lets go of its browser. */
const STARTED = Date.now()
const WATCHDOG_MS = Number(process.env.HOME_CIRCLE_WATCHDOG_MS || 2400000)
setTimeout(() => {
  console.log(`REFUSED  watchdog  -- the run exceeded ${WATCHDOG_MS} ms; a page reload under the capture (a module saved by another lane) is the usual cause. Nothing was scored.`)
  try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ...receipt, refusals: [...receipt.refusals, `watchdog: run exceeded ${WATCHDOG_MS} ms`], errors: [...receipt.errors, `watchdog: the run exceeded ${WATCHDOG_MS} ms and was not completed`], finishedAt: new Date().toISOString() }, null, 2)) } catch { /* nothing to write */ }
  process.exit(2)
}, WATCHDOG_MS).unref()

const sorted = a => a.slice().sort((x, y) => x - y)
const pct = (a, q) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN }

async function stepping (page, ms = 1000) {
  const a = await page.evaluate(() => { const s = document.querySelector('.home-circle').homeCircleFluid.stats(); return { steps: s.steps, state: s.state, reason: s.reason, note: s.note, fps: s.fps, medianMs: s.medianMs, workMs: s.workMs } })
  await page.waitForTimeout(ms)
  const b = await page.evaluate(() => { const s = document.querySelector('.home-circle').homeCircleFluid.stats(); return { steps: s.steps, state: s.state, reason: s.reason, note: s.note, fps: s.fps, medianMs: s.medianMs, workMs: s.workMs } })
  return { ...b, stepsPerSecond: (b.steps - a.steps) * 1000 / ms }
}

let opened = null
try {
  opened = await H.openHome({ theme: THEMES[0], init: { fn: H.SAMPLER_INIT }, where: 'presence/open', log: m => console.log(m) })
  receipt.browser = opened.channel
} catch (error) { refuse('open', error.message) }

if (opened) {
  const { browser } = opened
  for (const theme of THEMES) {
    console.log(`  ${((Date.now() - STARTED) / 1000).toFixed(1)}s theme ${theme}`)
    let page = null
    try {
      page = theme === THEMES[0] ? opened.page : await H.openPage(browser, { theme, init: { fn: H.SAMPLER_INIT }, where: `${theme}/open` })
      if (page.mutations) receipt.mutations = page.mutations
      await H.setGround(page, GROUND)
      const canvas = await page.evaluate(() => { const c = document.querySelector('.home-circle-fluid'); const r = c && c.getBoundingClientRect(); return c ? { width: c.width, height: c.height, cssWidth: r.width, cssHeight: r.height, live: c.classList.contains('is-live'), opacity: getComputedStyle(c).opacity } : null })
      check(`${theme}/P0 canvas present and sized`, !!canvas && canvas.width > 0 && canvas.height > 0 && canvas.cssWidth > 0, JSON.stringify(canvas))
      for (const st of STATES) {
        await H.pinState(page, st)
        await page.waitForTimeout(2500)
        const run = await stepping(page, 1000)
        await H.armSampler(page, { size: 128, max: 200 })
        await page.waitForTimeout(700)
        const out = await H.drainSampler(page)
        const live = H.liveFrames(out.frames, GROUND)
        let best = { coverage: 0, peak: 0 }
        for (const f of live) {
          const auto = M.bodyMaskHalfPeak(f, GROUND)
          const coverage = auto.covered / (f.width * f.height)
          if (coverage > best.coverage) best = { coverage, peak: auto.peak }
        }
        receipt.measurements.push({ theme, state: st.action, tool: st.tool, renderer: run, drawnFrames: live.length, coverage: best.coverage, peak: best.peak })
        check(`${theme}/P0 body present in agent state "${st.action}"`,
          run.state === 'running' && run.stepsPerSecond >= PRESENCE.minStepsPerSecond.value && live.length > 0 && best.coverage >= PRESENCE.minCoverage.value && best.peak >= PRESENCE.minPeakInk.value,
          `renderer ${run.state}${run.reason ? '/' + run.reason : ''}${run.note ? ' note=' + run.note : ''} at ${run.stepsPerSecond.toFixed(0)} steps/s (need >= ${PRESENCE.minStepsPerSecond.value}); ${live.length} drawn frames in 700 ms; body covers ${(best.coverage * 100).toFixed(2)}% of the canvas (need >= ${(PRESENCE.minCoverage.value * 100).toFixed(1)}%) at peak ink ${best.peak.toFixed(0)} (need >= ${PRESENCE.minPeakInk.value})`)
        if (live.length) save(`${theme}-${st.action}.png`, await H.composeStrip(page, [live[live.length - 1]], { scale: 2, labels: [`${theme} ${st.action}`] }))
      }
      /* P2 the body is distinguishable from the THEME's own ground. Manager,
         2026-09-18: "on BLACK the body now draws but is invisible, two faint
         smudges, while the same build on white draws a clear glossy dome." The
         presence gate above reads the raw canvas and cannot see that; this one
         reads the COMPOSITED element on the theme ground (the override is
         lifted for it), takes the ground as the median of the corners, and
         requires the body's mean Oklab distance from it to reach a floor. */
      await page.evaluate(() => { const t = document.getElementById('jelly-gate-ground'); if (t) t.remove() })
      for (const st of [STATES[0], STATES[3]]) {
        await H.pinState(page, st)
        await page.waitForTimeout(2500)
        const shot = await H.grabCanvas(page, `${theme}/P2/${st.action}`)
        const W = shot.width, Hh = shot.height, d = shot.data
        const corners = []
        const k = Math.max(4, Math.round(Math.min(W, Hh) * 0.04))
        for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) for (const [px, py] of [[x, y], [W - 1 - x, y], [x, Hh - 1 - y], [W - 1 - x, Hh - 1 - y]]) corners.push((py * W + px) * 4)
        const med = ch => { const v = corners.map(i => d[i + ch]).sort((a, b) => a - b); return v[v.length >> 1] }
        const ground = [med(0), med(1), med(2)]
        const auto = M.bodyMaskHalfPeak(shot, ground)
        const g = M.oklabFromSrgb(...ground)
        let dist = 0, n = 0
        for (let p = 0, i = 0; p < auto.mask.length; p++, i += 4) {
          if (!auto.mask[p]) continue
          const c = M.oklabFromSrgb(d[i], d[i + 1], d[i + 2])
          dist += Math.hypot(c.L - g.L, c.a - g.a, c.b - g.b); n++
        }
        const contrast = n ? dist / n : 0
        receipt.measurements.push({ theme, state: st.action, groundContrast: { ground, bodyPixels: n, coverage: n / (W * Hh), meanOklabDistance: contrast } })
        check(`${theme}/P2 body distinguishable from the theme ground in "${st.action}"`,
          n > 0 && contrast >= PRESENCE.minGroundContrast.value,
          `ground rgb(${ground.join(',')}), body ${n} px (${(n / (W * Hh) * 100).toFixed(2)}% of the canvas), mean Oklab distance from ground ${contrast.toFixed(3)} (need >= ${PRESENCE.minGroundContrast.value})`)
        save(`${theme}-${st.action}-composited.png`, shot.png)
      }
      await H.setGround(page, GROUND)
      /* P3 NEVER FOCUSED, REPEATED, JUDGED ON THE READBACK. Manager's captures on
         7d993069 (14:49): an empty disc, state "paused", steps 0, on a page
         navigated and captured without focus -- the app open behind another
         window, which is how the owner first saw an empty circle. Every other
         capture path focuses the page; this one never does. A SCREENSHOT
         CANNOT OBSERVE THE FROZEN BOOT FRAME: taking it brings the tab forward,
         which resumes the loop and advances the state before the capture lands
         (body lane, 2026-09-18). So the judgement is the framebuffer readback
         taken INSIDE the draw (the sampler, armed from the first draw so the
         boot burst is in it), and the verdict is the last draw's pixels. It is
         a race (173 steps on one build, 0 on the next), so it runs
         PRESENCE.unfocusedRuns times and fails on ANY occurrence. Two shapes:
           rigorous  Chromium's focus emulation off through CDP and a cover page
                     in front (a headless page reports hasFocus() true otherwise);
           plain     open, never raised, no CDP, wait, read back -- the careless
                     shape that found four defects the rigorous one passed. */
      if (theme === THEMES[0]) {
        const REASONS = ['hidden', 'no-focus', 'no-frame', 'off-screen', 'idle']
        /* THE RIGOROUS SHAPE PINS EVERY AGENT STATE BEFORE BOOT, one load per
           state (body lane, 2026-09-18): the empty boot frame was the THINKING
           form -- its dissolve into dye ran during the burst and dye needs
           frames -- and it appeared 2 times in 6 only because the fleet
           happened to be thinking at boot. Pinned, the flake is a gate. */
        for (const shape of ['rigorous', 'plain']) {
          const loads = shape === 'rigorous' ? STATES.map(st => ({ ...st, key: 'gate', name: 'gate', event: '0' })) : Array.from({ length: PRESENCE.plainRuns.value }, () => null)
          const runs = loads.length
          const occurrences = []
          const seen = []
          for (let run = 0; run < runs; run++) {
            const pinned = loads[run]
            console.log(`  ${((Date.now() - STARTED) / 1000).toFixed(1)}s ${theme}/P3 ${shape} load ${run + 1} of ${runs}${pinned ? ' pinned "' + pinned.action + '"' : ''}`)
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
            try {
              await ctx.routeWebSocket(u => u.host === new URL(H.ORIGIN).host && u.searchParams.has('token'), sock => sock.close())
              await ctx.addInitScript((t) => { localStorage.setItem('mc.theme', t); localStorage.removeItem('mc.set.home_circle_style'); localStorage.setItem('mc.set.home_circle_motion', 'animate') }, theme)
              await ctx.addInitScript(`(${H.SAMPLER_INIT.toString()})({ armed: true, mode: 'pixels', size: 128, max: 600 })` + (pinned ? `; (${H.PIN_INIT.toString()})(${JSON.stringify(pinned)})` : ''))
              const p = await ctx.newPage()
              await p.goto(`${H.ORIGIN}/#/`, { waitUntil: 'load', timeout: 120000 })
              await p.waitForSelector('.home-circle', { timeout: 30000 })
              if (shape === 'rigorous') {
                let cdp = null
                try { cdp = await ctx.newCDPSession(p) } catch { cdp = null }
                if (!cdp) throw Object.assign(new Error(`${theme}/P3: no CDP session on this browser; the never-focused condition needs Chromium's focus emulation switched off`), { refusal: 'no-cdp' })
                await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
                const cover = await ctx.newPage()
                await cover.goto('about:blank')
                await cover.bringToFront()
              }
              await p.waitForTimeout(PRESENCE.unfocusedWaitMs.value)
              /* Read the renderer and the sampler WITHOUT a screenshot: evaluate
                 does not raise the page. */
              const st = await p.evaluate(() => { const r = document.querySelector('.home-circle'); const s = r && r.homeCircleFluid ? r.homeCircleFluid.stats() : null; return { state: s && s.state, reason: s && s.reason, steps: s && s.steps, focus: document.hasFocus(), hidden: document.hidden } })
              const out = await H.drainSampler(p)
              const last = out.frames.length ? out.frames[out.frames.length - 1] : null
              const auto = last ? M.bodyMaskHalfPeak(M.cropToFace(last, GROUND, 0.8), GROUND) : null
              const coverage = last ? auto.covered / (last.width * last.height) : 0
              const peak = last ? auto.peak : 0
              const present = Boolean(last) && coverage >= PRESENCE.minCoverage.value && peak >= PRESENCE.minPeakInk.value
              /* The pause names its cause (hidden, no-focus, no-frame, off-screen,
                 idle) -- read only when the loop is NOT running: the body lane's
                 own note says reason can read "no-frame" on a running loop. */
              const why = st.state !== 'running' && REASONS.includes(st.reason) ? st.reason : (st.state !== 'running' ? `unnamed (${st.reason || 'empty'})` : null)
              const row = { theme, shape, unfocusedRun: run, pinnedState: pinned ? pinned.action : null, renderer: st, draws: out.frames.length, lastDrawStep: last ? last.steps : null, coverage, peak, present, pausedWhy: why }
              receipt.measurements.push(row); seen.push(row)
              if (!present) { occurrences.push(row); if (last) save(`${theme}-${shape}-empty-${run}.png`, await H.composeStrip(p, [last], { scale: 2, labels: [`${shape} run ${run} step ${last.steps}`] })) }
            } finally { await ctx.close().catch(() => {}) }
          }
          check(`${theme}/P3 body drawn on a page that was never focused (${shape}), ${runs} fresh loads${shape === 'rigorous' ? ', one per agent state pinned before boot' : ''}, judged on the framebuffer readback`, occurrences.length === 0,
            occurrences.length ? `NO BODY in the last draw on ${occurrences.length} of ${runs}: ` + occurrences.map(o => `run ${o.unfocusedRun}${o.pinnedState ? ' (' + o.pinnedState + ' pinned before boot)' : ''} state ${o.renderer.state}${o.pausedWhy ? ' because ' + o.pausedWhy : ''} steps ${o.renderer.steps} draws ${o.draws} last-draw step ${o.lastDrawStep} coverage ${(o.coverage * 100).toFixed(2)}% peak ${o.peak.toFixed(0)}`).join('; ')
              : `all ${runs} loads drew a body${shape === 'rigorous' ? ' (' + STATES.map(st => st.action).join(', ') + ' each pinned before boot)' : ''}; renderer ${seen.map(m => `${m.renderer.state}${m.pausedWhy ? '(' + m.pausedWhy + ')' : ''}@${m.renderer.steps}`).join('/')}, last draw at step ${seen.map(m => m.lastDrawStep).join('/')}, coverage ${seen.map(m => (m.coverage * 100).toFixed(1) + '%').join('/')}, hasFocus ${seen.map(m => m.renderer.focus).join('/')}`)
        }
      }

      /* P1 frame time, idle and thinking, 4 s each. */
      for (const st of [STATES[0], STATES[3]]) {
        await H.pinState(page, st)
        await page.waitForTimeout(2000)
        const run = await stepping(page, 500)
        /* TIMING MODE: one timestamp per display draw, NO readback in the
           loop. The first P1 sampled the framebuffer every frame and reported
           p95 52-77 ms; the body lane measured the same page at 16.7 ms median,
           16.8 ms p95, with a Still control showing the same distribution -- a
           per-draw readback costs more than this renderer does, so it was
           measuring the instrument. */
        await H.armSampler(page, { max: 1200, mode: 'timing' })
        await page.waitForTimeout(4000)
        const out = await H.drainSampler(page)
        const live = out.frames
        const dts = []
        for (let i = 1; i < live.length; i++) dts.push(live[i].t - live[i - 1].t)
        const budget = 1000 / (run.fps || 60)
        const median = pct(dts, 0.5), p95 = pct(dts, 0.95)
        const dropped = dts.filter(d => d > 2 * median).length / Math.max(1, dts.length)
        receipt.measurements.push({ theme, state: st.action, frameTime: { ladderFps: run.fps, budgetMs: budget, drawn: live.length, medianMs: median, p95Ms: p95, droppedFraction: dropped, rendererMedianMs: run.medianMs, rendererWorkMs: run.workMs } })
        check(`${theme}/P1 frame time in "${st.action}" holds the ladder budget`,
          Number.isFinite(p95) && p95 <= PRESENCE.p95OverBudget.value * budget && dropped <= PRESENCE.droppedMax.value,
          `${live.length} display draws in 4 s (timing only, no readback); interval median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (budget ${budget.toFixed(1)} ms at the ${run.fps} fps rung, p95 must be <= ${PRESENCE.p95OverBudget.value}x); dropped ${(dropped * 100).toFixed(1)}% (max ${(PRESENCE.droppedMax.value * 100).toFixed(0)}%); renderer work ${run.workMs} ms, median ${run.medianMs} ms`)
      }
    } catch (error) {
      refuse(`${theme}`, `${error.refusal ? error.refusal.toUpperCase() + ': ' : ''}${error.message}`)
    } finally { if (page) { receipt.outsideRequests += page.outsideRequests || 0; if (page !== opened.page) await page.gateContext.close().catch(() => {}) } }
  }
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
