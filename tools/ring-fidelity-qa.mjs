#!/usr/bin/env node
/* Measure the home hero's crescent, so "higher quality" is a number and
 * "exactly what it already is" is enforced rather than asserted.
 *
 * It captures the crescent at device scale 2 across every theme and load
 * state, then reduces each frame to a handful of shape invariants. The point is
 * not the pictures; it is that a rendering change has to prove it moved the
 * artefacts without moving the design.
 *
 *   node tools/ring-fidelity-qa.mjs --reference   # record the shipped render
 *   node tools/ring-fidelity-qa.mjs               # measure now, diff vs that
 *
 * Why deviation-from-background is the right signal: the crescent composites a
 * single hue over a flat sheet, so a pixel is alpha*loadCol + (1-alpha)*bg and
 * the difference vector from the background is exactly alpha*(loadCol - bg).
 * Its magnitude is therefore proportional to the composited alpha, whatever the
 * theme's hue happens to be — which is what lets one measurement compare a
 * green idle crescent on paper against a red peak one on near-black.
 */

import { spawn } from 'node:child_process'
import candidateScope from './lib/qa-candidate-scope.cjs'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareSterileProfile, sterileLaunchEnvironment, sterileProfileDirectories } from './lib/sterile-launch.cjs'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
// --release is an explicit unavailable scenario, never a source fallback.
candidateScope.refuseUnsupportedCandidate({ repoRoot: ROOT, driver: 'ring-fidelity', reason: 'the crescent fixture imports unbundled source modules that are absent from the candidate archive; a candidate Home capture adapter is still required' })
const ART = path.join(ROOT, 'artifacts', 'ring-fidelity')
/* Not 4600 (the dev script's own port, so a running dev server is not
   disturbed) and not 4610 either — something on this machine already answers
   there with a 401, which `--strictPort` turns into an instant vite exit and a
   confusing "server never answered". */
const PORT = 4733
const REFERENCE = process.argv.includes('--reference')
const OUT = path.join(ART, REFERENCE ? 'reference' : 'current')
const BASELINE = path.join(ROOT, 'tools', 'test', 'fixtures', 'crescent-reference-metrics.json')

if (REFERENCE && fs.existsSync(BASELINE) && !process.argv.includes('--force')) {
  console.error(
    'Refusing to re-record the baseline.\n\n' +
    `  ${path.relative(ROOT, BASELINE)}\n\n` +
    'holds the render this design is measured against. Re-recording it captures the\n' +
    'CURRENT renderer, which makes the drift check compare the code against itself,\n' +
    'and that always passes.\n\n' +
    'IT IS NOT LOST WHEN IT IS REPLACED, which is the only reason --force exists: the\n' +
    'file is tracked, so every render it has ever held is still in git. The original\n' +
    'feGaussianBlur measurement, taken before src/crescent-field.js existed, is at\n' +
    'a0c7ffb; the corona rewrite it was replaced for is 8344899.\n\n' +
    'Run without --reference to measure against it. Pass --force only if you\n' +
    'genuinely mean to adopt today\'s render as the new baseline.'
  )
  process.exit(2)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch { /* not up yet */ }
    await sleep(200)
  }
  throw new Error(`dev server never answered at ${url}`)
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
  })
}

/* ---------------------------------------------------------------- capture */

async function capture() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  /* The one shared launch environment (tools/lib/sterile-launch.cjs). It
     deletes ELECTRON_RUN_AS_NODE -- set, Electron silently becomes headless
     Node: it exits 0, opens no window, and writes no frames; the seat notes
     record it costing a debugging cycle already -- and points every home into a
     scratch profile, which this capture does not need but every Electron launch
     from tools/ is held to. */
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ring-fidelity-homes-')),
  )))

  /* vite's JS entry under this node, not `npx`: since Node 22 spawning a .cmd
     shim without `shell: true` fails outright with EINVAL, and turning the
     shell on to work around that would put the argument list through cmd's
     quoting rules for no benefit. */
  const vite = spawn(process.execPath,
    [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--port', String(PORT), '--strictPort',
      /* Bound explicitly: vite's default `localhost` resolves to ::1 on this
         machine, so a 127.0.0.1 fetch never connects and the wait times out
         while the server is in fact up and serving. */
      '--host', '127.0.0.1'],
    { cwd: ROOT, env, stdio: 'ignore', detached: false })

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/tools/ring-fixture.html`)
    /* By environment, not argv — see the note in ring-capture-main.cjs. */
    await run(require('electron'), [path.join(ROOT, 'tools', 'ring-capture-main.cjs')], {
      cwd: ROOT,
      env: { ...env, RING_URL: `http://127.0.0.1:${PORT}`, RING_OUT: OUT, RING_SCALE: '2' },
    })
  } finally {
    vite.kill()
  }
}

/* --------------------------------------------------------------- analysis */

function loadFrame(dir, entry) {
  const buf = fs.readFileSync(path.join(dir, `${entry.name}.bgra`))
  return { ...entry, buf }
}

/** Median background, sampled from a corner the crescent cannot reach. */
function backgroundOf(frame) {
  const { buf, width, scale } = frame
  const xs = [], ys = []
  for (let i = 0; i < 24; i++) { xs.push(Math.round((900 + i) * scale)); ys.push(Math.round((30 + i) * scale)) }
  const r = [], g = [], b = []
  for (const y of ys) for (const x of xs) {
    const o = (y * width + x) * 4
    b.push(buf[o]); g.push(buf[o + 1]); r.push(buf[o + 2])
  }
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1]
  return { r: med(r), g: med(g), b: med(b) }
}

/** Deviation from background at a CSS-space point, bilinearly sampled. */
function deviationAt(frame, bg, cssX, cssY) {
  const { buf, width, height, scale } = frame
  const fx = cssX * scale - 0.5, fy = cssY * scale - 0.5
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) return 0
  const tx = fx - x0, ty = fy - y0
  let acc = 0
  for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)],
                             [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const o = ((y0 + dy) * width + (x0 + dx)) * 4
    const db = buf[o] - bg.b, dg = buf[o + 1] - bg.g, dr = buf[o + 2] - bg.r
    acc += w * Math.sqrt(dr * dr + dg * dg + db * db)
  }
  return acc
}

/** Mean deviation on the arc at a given angle off the bisector and radius. */
function sampleArc(frame, bg, rho, angleRad) {
  const g = frame.geom
  const x = g.arcCx - rho * Math.cos(angleRad)
  const y = g.arcCy + rho * Math.sin(angleRad)
  return deviationAt(frame, bg, x, y)
}

function measure(frame) {
  const bg = backgroundOf(frame)
  const g = frame.geom

  /* Radial profile through the body of the crescent, averaged over a narrow
     angular window so a single dithered pixel cannot set the peak. */
  const radial = []
  for (let rho = 0; rho <= g.reach; rho += 0.5) {
    let sum = 0, n = 0
    for (let a = -6; a <= 6; a += 2) { sum += sampleArc(frame, bg, rho, (a * Math.PI) / 180); n++ }
    radial.push({ rho, v: sum / n })
  }
  const peak = radial.reduce((m, p) => p.v > m.v ? p : m, radial[0])

  /* Angular profile at the arc radius, averaged across the stroke. */
  const angular = []
  for (let deg = 0; deg <= 110; deg += 0.5) {
    let sum = 0, n = 0
    for (const dr of [-2, -1, 0, 1, 2]) { sum += sampleArc(frame, bg, g.r + dr, (deg * Math.PI) / 180); n++ }
    angular.push({ deg, v: sum / n })
  }
  const aPeak = angular.reduce((m, p) => p.v > m.v ? p : m, angular[0])

  const crossOut = (list, key, from, level) => {
    for (let i = from; i < list.length; i++) {
      if (list[i].v <= level) {
        const prev = list[i - 1]
        if (!prev) return list[i][key]
        const t = (prev.v - level) / (prev.v - list[i].v || 1)
        return prev[key] + t * (list[i][key] - prev[key])
      }
    }
    return null
  }
  const peakIdx = radial.indexOf(peak)
  const half = peak.v / 2
  const outer = crossOut(radial, 'rho', peakIdx, half)
  let inner = null
  for (let i = peakIdx; i >= 0; i--) {
    if (radial[i].v <= half) {
      const nxt = radial[i + 1]
      const t = (half - radial[i].v) / ((nxt ? nxt.v : half) - radial[i].v || 1)
      inner = radial[i].rho + t * ((nxt ? nxt.rho : radial[i].rho) - radial[i].rho)
      break
    }
  }

  /* Total light and where it sits: the drift guard. If a change moves the
     crescent rather than cleaning it up, the centroid is what says so. */
  let mass = 0, mRho = 0, mDeg = 0
  for (let deg = 0; deg <= 110; deg += 1) {
    for (let rho = Math.max(0, g.r - 90); rho <= g.r + 90; rho += 1) {
      const v = sampleArc(frame, bg, rho, (deg * Math.PI) / 180)
      mass += v; mRho += v * rho; mDeg += v * deg
    }
  }

  return {
    name: frame.name, theme: frame.theme, load: frame.load,
    background: bg,
    peakDeviation: +peak.v.toFixed(2),
    peakRadius: +peak.rho.toFixed(2),
    radialHalfInner: inner == null ? null : +inner.toFixed(2),
    radialHalfOuter: outer == null ? null : +outer.toFixed(2),
    radialHalfWidth: inner == null || outer == null ? null : +(outer - inner).toFixed(2),
    angularPeak: +aPeak.v.toFixed(2),
    angularHalfMaxDeg: (() => {
      const c = crossOut(angular, 'deg', angular.indexOf(aPeak), aPeak.v / 2)
      return c == null ? null : +c.toFixed(2)
    })(),
    /* The blunt tip, as a number: how fast the light dies at its end. A hard
       linecap falls from full to nothing across the blur width alone; a taper
       spreads that out. Measured as the degrees between 90% and 10% of peak. */
    endRollDeg: (() => {
      const i = angular.indexOf(aPeak)
      const hi = crossOut(angular, 'deg', i, aPeak.v * 0.9)
      const lo = crossOut(angular, 'deg', i, aPeak.v * 0.1)
      return hi == null || lo == null ? null : +(lo - hi).toFixed(2)
    })(),
    mass: +mass.toFixed(0),
    centroidRadius: mass ? +(mRho / mass).toFixed(2) : null,
    centroidDeg: mass ? +(mDeg / mass).toFixed(2) : null,
    radialProfile: radial.filter((_, i) => i % 4 === 0).map(p => +p.v.toFixed(2)),
    angularProfile: angular.filter((_, i) => i % 4 === 0).map(p => +p.v.toFixed(2)),
  }
}

function analyse(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  return manifest.frames.map(entry => measure(loadFrame(dir, entry)))
}

/* ------------------------------------------------------------------ report */

const FIELDS = [
  ['peakRadius', 1.5, 'px — where the brightest light sits'],
  ['radialHalfWidth', 4.0, 'px — how wide the light is at half brightness'],
  ['angularHalfMaxDeg', 2.0, 'deg — how long the crescent is at half brightness'],
  ['centroidRadius', 2.0, 'px — centre of mass, radially'],
  ['centroidDeg', 2.5, 'deg — centre of mass, angularly'],
]

function report(now, ref) {
  let drifted = 0
  console.log(`\ncrescent fidelity — ${now.length} frames at device scale 2\n`)
  if (!ref) {
    for (const m of now) {
      console.log(`  ${m.name.padEnd(15)} peak r=${m.peakRadius}  halfWidth=${m.radialHalfWidth}  ` +
        `span=${m.angularHalfMaxDeg}deg  endRoll=${m.endRollDeg}deg  mass=${m.mass}`)
    }
    console.log('\nrecorded as the reference.\n')
    return 0
  }
  const byName = Object.fromEntries(ref.map(m => [m.name, m]))
  for (const m of now) {
    const r = byName[m.name]
    if (!r) { console.log(`  ${m.name}: no reference frame`); continue }
    const bits = []
    for (const [field, tol, note] of FIELDS) {
      const a = r[field], b = m[field]
      if (a == null || b == null) { bits.push(`${field}=n/a`); continue }
      const d = b - a
      const bad = Math.abs(d) > tol
      if (bad) drifted++
      bits.push(`${field} ${a}->${b} (${d >= 0 ? '+' : ''}${d.toFixed(2)}${bad ? ' DRIFT' : ''})`)
    }
    console.log(`  ${m.name}`)
    for (const b of bits) console.log(`      ${b}`)
    console.log(`      endRoll ${r.endRollDeg}deg -> ${m.endRollDeg}deg   ` +
      `mass ${r.mass} -> ${m.mass} (${(((m.mass - r.mass) / r.mass) * 100).toFixed(1)}%)`)
  }
  console.log(`\n${drifted === 0 ? 'no drift' : `${drifted} measurement(s) outside tolerance`} ` +
    `across ${FIELDS.length} invariants x ${now.length} frames.\n`)
  return drifted
}

/* -------------------------------------------------------------------- main */

await capture()
const now = analyse(OUT)
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(now, null, 2))

/* The baseline lives in tools/test/fixtures, TRACKED, never in artifacts/ —
   artifacts/ is gitignored, and a baseline git cannot see is one that vanishes
   with the next clean checkout.
 *
 * WHAT IT RECORDS TODAY, and why it was re-recorded on 2026-08-18. It held the
 * feGaussianBlur render measured at a0c7ffb (2026-08-16 12:01), and 8344899
 * (2026-08-16 21:48, "Home corona: the colour-space bug, the dead glow slider,
 * and the crushed core") deliberately rewrote the renderer nine hours later:
 * the shader stopped gamma-decoding into an sRGB-encoded canvas, and the tone
 * knee went from 0.55 to 0.22 because it "crushed the core". That commit
 * re-measured contrast across all nine STATUS cells and quoted every number; it
 * did not re-record this file. So every run since reported 44 of 60 invariants
 * outside tolerance — a gate crying wolf about a change its own commit message
 * explains, which is the state in which gates get switched off.
 *
 * ONE FRAME'S DRIFT IS RECORDED HERE RATHER THAN VOUCHED FOR. The three hued
 * states narrowed, which is what a softened knee should do. The `unknown` state
 * did the opposite on ALL THREE themes — span 53deg -> 101.7deg over a
 * radialHalfWidth that collapsed to about 2.2px, so it is now a thin wide ring
 * where it was a thick short crescent. That is consistent with what 8344899
 * says that state is ("neutral --ink-4 and quieted to 0.28 gain"), and 8344899
 * measured no number for it. It is captured here so the NEXT change to it is
 * visible. Nobody has yet looked at that frame and said it is the design. */
/* `--reference` NOW WRITES THE FILE IT SAYS IT WROTE.
 *
 * MEASURED 2026-08-18: `--reference --force` printed "recorded as the
 * reference." and wrote metrics.json into artifacts/ only — never BASELINE,
 * which is the file the comparison twenty lines below reads. So the documented
 * way to re-record a baseline recorded nothing, the next plain run reported the
 * same 44 drifts, and the operator's own eyes told them the tool had done the
 * job. A guard that refuses to overwrite a file the flag cannot write either is
 * protecting nothing; the refusal above is real only now. */
if (REFERENCE) fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
const ref = !REFERENCE && fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  : null
const drifted = report(now, ref)
if (REFERENCE) console.log(`  written to ${path.relative(ROOT, BASELINE)}\n`)
process.exitCode = drifted > 0 ? 1 : 0
