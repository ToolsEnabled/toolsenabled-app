/* NO CONTROL IN THIS PRODUCT LEADS TO A ROUTE THE ROUTER DOES NOT ACCEPT.
 *
 * THE GAP THIS CLOSES, recorded 2026-08-22: "'See the plans and prices' inside
 * /simulation/ 404s." That control no longer exists anywhere in the app -- the
 * owner ruled on 2026-08-26 "i dont want to advertise subscriptions in the
 * app", and every subscription door was removed from the account screens and
 * from the home panel. A phone drive of the current tree (chromium and webkit,
 * 390x844 and 320x568, every stop the router accepts) found eleven distinct
 * links in the whole application and every one of them resolves.
 *
 * So the finding is closed, and this file is what keeps it closed. It is worth
 * a gate rather than a note because of HOW that defect worked: a hash the
 * router does not name is not an error and does not fail loudly. src/main.js
 * resolve() sends it to home. A control that silently returns the reader to the
 * screen they started on looks, from the outside, exactly like a control that
 * did nothing -- which is why "See the plans and prices" survived long enough
 * to be written down as a phone finding rather than caught as a broken link.
 *
 * WHY THE ACCEPTED LIST IS DERIVED AND NOT TYPED. A hardcoded copy of the stops
 * is a second statement of the router's contract, and the day someone renames a
 * stop the copy is what goes stale -- the gate would then pass on a link that
 * 404s and fail on one that works. Both halves are read out of the router's own
 * stop table: the stop names, and the minimum number of segments a stop needs
 * (`#/agent` alone resolves to home; the drill-in needs three).
 *
 * THE TABLE IS READ FROM BOTH FILES THAT CAN HOLD IT, and that is deliberate.
 * It lived inside src/main.js's parse() and now lives in src/route-parse.js,
 * which main.js calls; reading only one of them made this gate report "parse()
 * no longer reads as a list of stops" on the day it moved, which is a gate
 * going dark rather than a gate finding something. The floor assertions below
 * are what keep the union honest: an empty or unrecognisable table still
 * fails, loudly, instead of accepting every link in the product.
 *
 * SCOPE, stated so it cannot be mistaken for more. This reads link TARGETS that
 * are written as literals -- an href, a navigate() call, an assignment to
 * location.hash. A target assembled at runtime from a variable is outside it,
 * and so is an in-page anchor (`#stage`). The drive named above is what covered
 * the rest; this gate covers the part a file can decide.
 */

import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')

/** Every .js and .html file the renderer is built from, plus the shell page. */
function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (/\.(js|html)$/.test(name)) out.push(full)
    }
  }
  walk(SRC)
  out.push(path.join(REPO, 'index.html'))
  return out
}

const ROUTER = [
  readFileSync(path.join(SRC, 'main.js'), 'utf8'),
  readFileSync(path.join(SRC, 'route-parse.js'), 'utf8'),
].join('\n')

/** The stop names parse() tests the first segment against. */
function acceptedStops() {
  return new Set([...ROUTER.matchAll(/parts\[0\]\s*===\s*'([a-z-]+)'/g)].map((m) => m[1]))
}

/** The stops parse() also requires extra segments for: `parts.length >= N`. */
function segmentFloors() {
  const floors = new Map()
  const pattern = /parts\[0\]\s*===\s*'([a-z-]+)'\s*&&\s*parts\.length\s*>=\s*(\d+)/g
  for (const m of ROUTER.matchAll(pattern)) floors.set(m[1], Number(m[2]))
  return floors
}

/* An href in markup, a navigate() call, an assignment to location.hash. The
   three ways this codebase sends a reader somewhere. */
const TARGET_PATTERNS = [
  /href\s*=\s*["'`]([^"'`]*)/g,
  /navigate\(\s*["'`]([^"'`]*)/g,
  /location\.hash\s*=\s*["'`]([^"'`]*)/g,
]

/** Every literal `#/...` target in the tree, with the file that writes it. */
function routeTargets() {
  const found = []
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of TARGET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const target = match[1]
        if (!target.startsWith('#/')) continue
        found.push({ target, file: path.relative(REPO, file) })
      }
    }
  }
  return found
}

/** `#/settings?setting=x` -> ['settings']; `#/agent/${a}/${b}` -> ['agent','${a}','${b}'] */
function segmentsOf(target) {
  return target.slice(2).split('?')[0].split('/').filter(Boolean)
}

/* A GATE THAT FINDS NOTHING PASSES EVERYTHING, so the scan states its own
   catch before either rule reads it. Both numbers are what the current tree
   holds with room underneath; they exist to fail if the patterns above ever
   stop matching, not to pin an exact count. */
test('the link scan actually reaches the product\'s links', () => {
  const targets = routeTargets()
  assert.ok(targets.length >= 10, `only ${targets.length} route targets found; the scan has stopped matching`)
  const stops = new Set(targets.map((entry) => segmentsOf(entry.target)[0] || ''))
  assert.ok(stops.size >= 6, `only ${stops.size} distinct stops linked to; the scan has stopped matching`)
  assert.ok(acceptedStops().size >= 10, 'parse() no longer reads as a list of stops; this gate cannot derive one')
})

test('every link in the app names a stop the router accepts', () => {
  const accepted = acceptedStops()
  const offences = []
  for (const { target, file } of routeTargets()) {
    const stop = segmentsOf(target)[0]
    /* `#/` is home, which parse() reaches by falling through rather than by
       naming, so it is accepted without being in the list. */
    if (stop === undefined) continue
    /* A stop assembled from a value is outside what a file can decide. */
    if (stop.startsWith('${')) continue
    if (accepted.has(stop)) continue
    offences.push(`${file}: ${target} -> parse() has no stop named "${stop}", so it resolves to home`)
  }
  assert.deepEqual(offences, [], offences.join('\n'))
})

test('a link to a stop that needs extra segments carries them', () => {
  const floors = segmentFloors()
  /* T302: `agent` was the one stop with a segment floor (`parts.length >= 3`),
     and it is retired -- route-parse.js no longer names it at all, so this
     mechanism currently has nothing to enforce. Zero is the honest, expected
     count today, not a sign the pattern stopped matching; if a future stop
     adds a segment floor, this loop below is already armed for it. */
  assert.equal(floors.size, 0, 'a stop now carries a segment floor; either add its case above or the mechanism silently stopped matching')
  const offences = []
  for (const { target, file } of routeTargets()) {
    const segments = segmentsOf(target)
    const floor = floors.get(segments[0])
    if (floor === undefined) continue
    if (segments.length >= floor) continue
    offences.push(`${file}: ${target} has ${segments.length} segments; parse() needs ${floor} or it resolves to home`)
  }
  assert.deepEqual(offences, [], offences.join('\n'))
})
