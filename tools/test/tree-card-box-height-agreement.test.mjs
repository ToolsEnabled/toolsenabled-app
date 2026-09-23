// Three CSS rules describe ONE card box, and they must not disagree about how
// tall it is before layout has painted --tree-preview-height.
//
// Measured 2026-09-09 at 6909208e: `.chip-preview`'s max-height fell back to
// 196px while the chip's own height and `.chip-preview`'s own height rule both
// fell back to 160px -- a 36px disagreement about the same box. Nothing had
// ever compared them, because each rule reads correctly on its own; the defect
// only exists between them. This is the same "two rules disagree, the wrong one
// gets read" shape the sheet already carries scar tissue for at the .cl-chat
// clamp (see the W16e note beside that rule).
//
// The fallback is not arbitrary either: it is what the card is before anyone
// has chosen a size, so it must be the DEFAULT size's height. Tying it to
// TREE_CONTEXT_SIZES means a future change to the default cannot leave the
// stylesheet quietly describing the old one.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_TREE_CONTEXT_SIZE, TREE_CONTEXT_SIZES } from '../../src/tree-context-cards.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const CSS = readFileSync(resolve(ROOT, 'src/tree-graph.css'), 'utf8')

const fallbacks = () => [...CSS.matchAll(/var\(--tree-preview-height, (\d+)px\)/g)].map(match => Number(match[1]))

test('every rule describing the card box falls back to the same height', () => {
  const found = fallbacks()
  assert.ok(found.length >= 2,
    'src/tree-graph.css no longer reads --tree-preview-height with a fallback; this guard has nothing left to compare')
  const distinct = [...new Set(found)]
  assert.equal(distinct.length, 1,
    `the rules describing one card box disagree about its default height: ${distinct.join('px, ')}px. `
    + 'Before layout paints --tree-preview-height they describe different boxes, and whichever rule the reader hits first wins.')
})

test('that shared fallback is the default card size, not a number of its own', () => {
  const found = fallbacks()
  assert.ok(found.length >= 2, 'no fallback left to check')
  const preset = TREE_CONTEXT_SIZES.find(row => row.value === DEFAULT_TREE_CONTEXT_SIZE)
  assert.ok(preset, `TREE_CONTEXT_SIZES no longer carries the default size ${DEFAULT_TREE_CONTEXT_SIZE}`)
  assert.equal(found[0], preset.height,
    `the stylesheet falls back to ${found[0]}px but the default card size ${DEFAULT_TREE_CONTEXT_SIZE} is ${preset.height}px tall. `
    + 'An unsized card must be the size a card is by default, or the first paint is a box nobody chose.')
})
