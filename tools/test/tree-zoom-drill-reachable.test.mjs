/* ZOOMING OUT MUST BE ABLE TO UN-ROOT YOU.
 *
 * THE OWNER'S REPORT: "sometimes when zooming out it doesnt unroot". Rooting on
 * zoom-IN is deliberate and stays — he confirmed it in the same breath: "thats
 * purposeful. We wanted that." What was broken is only the way back.
 *
 * WHAT WENT WRONG, AND IT IS PURE ARITHMETIC. Three numbers have to agree:
 *
 *   ZOOM_DRILL_AT      the zoom you cross going IN to root on a branch
 *   ZOOM_DRILL_OUT_AT  the zoom you cross going OUT to release it
 *   the REST zoom      what resetZoom() leaves you at right after a drill
 *
 * Both rules fire on a CROSSING, not on a level — `next <= OUT && previous >
 * OUT` — which is correct, and is what stops the boundary oscillating on every
 * wheel notch. But it means the rest zoom must sit ABOVE the out threshold, or
 * there is nothing left to cross.
 *
 * It did not. Rest was 1 and OUT was 1.28, so a freshly-drilled view was parked
 * BELOW the threshold. Zooming out walked 1 -> 0.9 -> 0.5 and crossed nothing;
 * the drill never released and the person zoomed out into empty canvas, still
 * rooted. The only escape was to zoom back IN past 1.28 and then out again,
 * which is exactly why it read as intermittent rather than simply broken.
 *
 * The comment that sat beside those constants asserted "1 sits between the
 * thresholds". It does not — 1 is below both. One false sentence held a wrong
 * number in place, which is why this suite checks the RELATIONSHIP and not the
 * values: any three numbers are fine as long as a person can get back.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GRAPH = path.join(HERE, '..', '..', 'src', 'tree-graph.js')
const SOURCE = readFileSync(GRAPH, 'utf8')

/* Comments stripped: this file's whole subject is written in prose right beside
   the constants, and a rule a comment can satisfy is not a rule. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

function constant(name) {
  const match = CODE.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?[0-9.]+)`))
  return match ? Number(match[1]) : null
}

/** What resetZoom() leaves the view at — read, never assumed. */
function restZoom() {
  const at = CODE.indexOf('resetZoom() {')
  if (at < 0) return null
  const body = CODE.slice(at, at + 200)
  const match = body.match(/this\.zoom\s*=\s*(-?[0-9.]+)/)
  return match ? Number(match[1]) : null
}

const DRILL_AT = constant('ZOOM_DRILL_AT')
const DRILL_OUT_AT = constant('ZOOM_DRILL_OUT_AT')
const ZOOM_MIN = constant('ZOOM_MIN')
const ZOOM_MAX = constant('ZOOM_MAX')
const REST = restZoom()

test('the guard can read all four numbers it is about', () => {
  /* If any of these is renamed this suite would pass vacuously, and a vacuous
     pass here means the way back out is unprotected again. */
  for (const [name, value] of [
    ['ZOOM_DRILL_AT', DRILL_AT], ['ZOOM_DRILL_OUT_AT', DRILL_OUT_AT],
    ['ZOOM_MIN', ZOOM_MIN], ['ZOOM_MAX', ZOOM_MAX], ['resetZoom rest value', REST],
  ]) {
    assert.equal(typeof value, 'number', `${name} could not be read — rewrite this guard with it`)
    assert.ok(Number.isFinite(value), `${name} is not a finite number`)
  }
})

test('zooming out from a freshly drilled branch can actually cross the release', () => {
  /* THE DEFECT, STATED AS A RULE. Rest must be strictly above the out
     threshold, or `previous > OUT` is false on the very first notch and stays
     false all the way down. */
  assert.ok(REST > DRILL_OUT_AT,
    `resetZoom leaves the view at ${REST}, which is not above the release threshold ${DRILL_OUT_AT}. `
    + 'Zooming out can never cross it, so a drilled branch can never be released by zooming out.')

  /* And there must be somewhere below it to actually get to. */
  assert.ok(DRILL_OUT_AT > ZOOM_MIN,
    `the release threshold ${DRILL_OUT_AT} is at or below the minimum zoom ${ZOOM_MIN}, so it cannot be crossed`)
})

test('the crossing is reachable by real wheel steps, not just in principle', () => {
  /* Walk the actual zoom curve the wheel uses, from rest downward, and assert a
     crossing occurs before the view bottoms out. This is what a person does. */
  const clamp = (v) => Math.min(Math.max(v, ZOOM_MIN), ZOOM_MAX)
  let zoom = REST
  let crossed = false
  for (let step = 0; step < 200 && !crossed; step += 1) {
    const previous = zoom
    /* One notch of zoom OUT, using the wheel handler's own curve:
       next = zoom * exp(-delta * 0.0022), and a scroll-down delta is positive. */
    zoom = clamp(zoom * Math.exp(-120 * 0.0022))
    if (zoom <= DRILL_OUT_AT && previous > DRILL_OUT_AT) crossed = true
    if (zoom === previous) break                      // bottomed out
  }
  assert.ok(crossed,
    'zooming out from the rest zoom never crosses the release threshold, so the drill never lets go')
})

test('rooting on zoom-in still happens, and the two rules cannot oscillate', () => {
  /* The owner confirmed the drill-in is wanted. Fixing the way out must not
     remove the way in, and the gap between the two must stay wide enough that
     one wheel notch cannot straddle both. */
  assert.ok(DRILL_AT > REST,
    `the drill-in threshold ${DRILL_AT} is not above the rest zoom ${REST}, so a drill would re-fire immediately`)
  assert.ok(DRILL_AT > DRILL_OUT_AT,
    'the two thresholds must be apart — a shared one oscillates on every notch that straddles it')

  const oneNotch = Math.exp(120 * 0.0022)
  assert.ok(DRILL_AT / DRILL_OUT_AT > oneNotch,
    `the hysteresis gap (${(DRILL_AT / DRILL_OUT_AT).toFixed(3)}x) is smaller than one wheel notch `
    + `(${oneNotch.toFixed(3)}x), so a single notch could cross both thresholds`)
})
