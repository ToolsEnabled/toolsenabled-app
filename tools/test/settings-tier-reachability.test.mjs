import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/* A FIXED CEILING ON A CLIPPING CONTAINER MAKES CONTROLS UNREACHABLE.
 *
 * `.settings-tier` sets `overflow: hidden` so its open/close transition has
 * something to animate. That is fine while the tier is closed. It stops being
 * fine the moment the OPEN state also carries a fixed `max-height`: content
 * past the ceiling is rendered, laid out, and clipped inside a box that does
 * not scroll, so nothing a person does with a mouse or a scroll wheel reaches
 * it.
 *
 * That is what happened at 2600px. Measured in a real browser, the Settings
 * rail lost System, Your data, Agents & actions and Appearance & reading at
 * 844x390, and Research lost More axes and Result columns at EVERY width. No
 * existing test saw any of it, because a script can dispatch a click to an
 * element it cannot see.
 *
 * Comments are stripped before matching so that describing the old value in
 * prose -- as the stylesheet now does -- cannot fail this. */
const css = readFileSync(new URL('../../src/settings.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

test('an open settings tier has no fixed-height clipping ceiling', () => {
  const openTier = /\.settings-tier\.is-open\s*\{([^}]*)\}/.exec(css)
  assert.ok(openTier, 'the open settings tier must be styled')
  assert.match(openTier[1], /max-height\s*:\s*none\s*;/)
  assert.doesNotMatch(
    openTier[1],
    /max-height\s*:\s*\d+(?:\.\d+)?(?:px|rem|em|vh|vmin|vmax)\s*;/,
    'a content-independent ceiling can make controls unreachable below its clip',
  )
})
