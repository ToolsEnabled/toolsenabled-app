import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* THE COMPUTERS RAIL'S DEFAULT SHARE -- LOWERED, WITHOUT EATING A SAVED DRAG.
 *
 * R1207 asks for a wider tree at rest. The width that changed is the DEFAULT
 * one, and only that: `.computers .comp-body`'s third grid track reads
 * `var(--comp-rail-width, <default>)`, and a var() fallback is consulted only
 * when the custom property is NOT set. src/views/computers.js sets that exact
 * property inline on that exact element whenever the person drags the rail
 * (attachResizeHandle, storageKey 'mc.comp-body.rail-w'), so a dragged width
 * keeps winning outright over whatever the default becomes.
 *
 * That is the property worth guarding. Lowering a default is cheap to redo;
 * silently discarding a width somebody chose is the defect this file exists
 * to catch, and it would be invisible -- the rail would simply come back
 * narrower one day and nobody would know which change did it.
 *
 * WHAT THIS FILE CANNOT DO. `.comp-body` is laid out by a real engine, and
 * `node --test` has no browser: nothing here measures a painted column. It
 * pins the cascade CONTRACT that makes the override work, the same way
 * tools/test/agent-chat-column-floor.test.mjs pins agent.css's grid floor
 * rather than rendering it. The painted check is the browser fixture
 * tools/test/fixtures/run-tree-zoom-responsive.mjs.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const css = read('src/tree-graph.css')
const computers = read('src/views/computers.js')

/* The one declaration under test, sliced out by its selector so a rule added
   elsewhere in a 1700-line sheet cannot accidentally satisfy these. */
function railTrack() {
  const start = css.indexOf('.computers .comp-body {')
  assert.ok(start >= 0, '.computers .comp-body rule not found in src/tree-graph.css')
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  const match = body.match(/grid-template-columns:([^;]+);/)
  assert.ok(match, '.computers .comp-body no longer declares grid-template-columns')
  return match[1].trim()
}

test('a saved rail width is read FIRST, with the default only as its fallback', () => {
  const track = railTrack()
  assert.match(track, /var\(\s*--comp-rail-width\s*,/,
    'the rail track no longer reads var(--comp-rail-width, ...) as its first argument. '
    + 'If the default stops being a FALLBACK, a width the person dragged is discarded every paint.')
  /* The default must live inside that var()'s fallback argument. A default
     sitting outside it would render regardless of the saved property. */
  const withoutFallback = track.replace(/var\(\s*--comp-rail-width\s*,[^)]*\)*/, 'SAVED')
  assert.ok(!/clamp\(/.test(withoutFallback),
    'a clamp() default sits OUTSIDE var(--comp-rail-width, ...) in the rail track. '
    + 'Only the fallback argument is skipped when the property is set, so a default outside it '
    + 'competes with the saved width instead of yielding to it.')
})

test('the writer sets the same property name the track reads', () => {
  assert.match(computers, /setProperty\('--comp-rail-width',/,
    'src/views/computers.js no longer writes --comp-rail-width. The stylesheet would then always '
    + 'fall back to the default and every drag would be forgotten.')
  assert.match(computers, /storageKey: 'mc\.comp-body\.rail-w'/,
    'the rail drag no longer persists under mc.comp-body.rail-w')
})

test('the default never asks for a rail narrower than the track can be', () => {
  const track = railTrack()
  const floor = track.match(/minmax\((\d+)px,/)
  const clampBottom = track.match(/clamp\((\d+)px,/)
  assert.ok(floor && clampBottom, 'the rail track no longer has both a minmax floor and a clamp bottom')
  assert.equal(Number(clampBottom[1]), Number(floor[1]),
    `the clamp bottom (${clampBottom[1]}px) and the track's own minimum (${floor[1]}px) disagree. `
    + 'Two numbers for one floor is how they drift apart; minmax silently wins and the stated default is a fiction.')
})

test('the canvas keeps the majority of the body at every window width', () => {
  const track = railTrack()
  const ceiling = track.match(/,\s*(\d+)%\s*\)/)
  assert.ok(ceiling, 'the rail track no longer caps the rail as a percentage of the body')
  assert.ok(Number(ceiling[1]) <= 40,
    `the rail may take ${ceiling[1]}% of the body. R1207 asks for a wider tree at rest; at more than 40% `
    + 'the canvas stops holding the clear majority and the rule is undone.')
})
