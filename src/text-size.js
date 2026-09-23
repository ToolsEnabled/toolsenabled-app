'use strict'

/* THE TEXT SIZE, AND THE ONE NUMBER THE LAYOUT NEEDS TO KNOW ABOUT IT.
 *
 * "text sizes for example large on my screen hides parts of the window"
 * (owner, 2026-09-03). This module is the answer's first half; the second is
 * the `--zoom` contract written down at :root in src/styles.css.
 *
 * WHY ANYTHING IS HIDDEN AT ALL. Text size is `zoom` on <body> -- the app is
 * sized in px throughout, so zoom rescales the layout coherently. But a
 * viewport unit is NOT scaled by an ancestor zoom while the painted box IS,
 * and `body { overflow: hidden }` (src/styles.css) means anything painted
 * past the window edge is not scrolled to, it is GONE.
 *
 * MEASURED 2026-09-03 in the shipped Chromium (electron 43.3.0), window
 * content box 1280x900, an offscreen probe reading getBoundingClientRect():
 *
 *                                   zoom 1     zoom 1.12    zoom 0.9
 *   height: 100vh                   900.0      1008.0        810.0
 *   height: 100%                    900.0       900.0        900.0
 *   height: calc(100vh/var(--zoom)) 900.0       900.0        900.0
 *   fixed width: calc(100% - 56px)  28..1252   31..1249     82..1198
 *   fixed width: calc(100vw - 56px) 28..1252  -45..1325     89..1191
 *
 * So at Large a `100vh` pane hangs 108px below the window and its last row of
 * controls is unreachable; at Small it stops 90px short and leaves dead sheet.
 * Dividing the viewport unit by the zoom lands it on the window at every size,
 * which is why this module publishes the zoom to CSS as well as applying it.
 *
 * ZOOMING <html> INSTEAD FIXES NOTHING -- also measured, same probe: with the
 * zoom on the root element every number in the 1.12 column above is
 * unchanged. The viewport unit is the defect, not the element it is set on.
 *
 * THE THREE PLACES THAT SET THE SIZE ARE NOW ONE. The boot read in
 * src/main.js, the quick-settings drawer and the settings page each carried
 * their own copy of "write mc.text, set body.style.zoom, clear it at 1". A
 * fourth thing to write (--zoom) would have been a fourth place to forget it,
 * which is how the drawer and the page drift apart. Same reason
 * src/font-choice.js is the single register of the font choices.
 */

export const TEXT_SIZE_KEY = 'mc.text'

/** The sizes the product offers, smallest first. The settings page's `text_size`
 *  row and the drawer's segment are both built from these values; nothing else
 *  is accepted, at boot or at a press. */
export const TEXT_SIZES = Object.freeze([0.9, 1, 1.12])

export const DEFAULT_TEXT_SIZE = 1

/** The offered size this value names, or null if it names none.
 *
 *  NULL IS A REFUSAL AND IT SAYS WHY: a stored `mc.text` of "1.5", "" or
 *  "nonsense" is a value this product never offered -- from a hand-edited
 *  settings file, an older build, or a half-written key -- and applying it
 *  would zoom the window to a size no layout here was measured at. The caller
 *  keeps the default rather than the garbage. Absence and refusal land in the
 *  same place here on purpose: both mean "no chosen size", which IS the
 *  default, and neither is a state a person has to be told about. */
export function normalizeTextSize(value) {
  /* Number(), NOT parseFloat(): parseFloat('1.12abc') is 1.12, so a truncated
     or appended stored value would be accepted as if it were the real one.
     Nothing here needs the lenient reading -- the only legitimate inputs are
     the three strings this product writes -- and the strict one cannot be
     talked into a size by a prefix. */
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  return TEXT_SIZES.find(size => Math.abs(size - number) < 1e-9) ?? null
}

/** Apply an offered text size to a document, or refuse it.
 *
 *  Returns the size applied, or null when the value is not one this product
 *  offers (nothing is written in that case -- see normalizeTextSize).
 *
 *  DEFAULT WRITES NOTHING AT ALL. At 1 both the body's inline zoom and the
 *  root's --zoom are removed rather than set to "1", so an untouched user's
 *  document is byte-identical to one that never met this module, and the CSS
 *  falls back to the `--zoom: 1` declared at :root. */
export function applyTextSize(value, doc = globalThis.document) {
  const size = normalizeTextSize(value)
  if (size === null) return null
  const body = doc?.body
  const root = doc?.documentElement
  if (body?.style) body.style.zoom = size === DEFAULT_TEXT_SIZE ? '' : String(size)
  if (root?.style) {
    if (size === DEFAULT_TEXT_SIZE) root.style.removeProperty('--zoom')
    else root.style.setProperty('--zoom', String(size))
  }
  return size
}

/** The zoom currently applied to the document, as a number (1 when none is).
 *
 *  READ BACK FROM WHERE IT WAS WRITTEN, not from getComputedStyle: this
 *  application sets zoom in exactly one place (applyTextSize, on <body>), so
 *  the inline value IS the effective zoom, and reading it costs no style
 *  recalculation on a path that runs at every pointermove of a drag.
 *
 *  WHO NEEDS IT. Anything mixing pointer coordinates with CSS px. MEASURED on
 *  the same probe: a 300px-tall box under zoom 1.12 reports offsetHeight 300
 *  and getBoundingClientRect().height 336 -- offset/client sizes are in the
 *  zoomed element's own px, the rect and every pointer clientX/clientY are in
 *  the window's. Subtract one from the other and you are 12% wrong. */
export function textZoom(doc = globalThis.document) {
  const raw = doc?.body?.style?.zoom
  const number = Number.parseFloat(raw)
  return Number.isFinite(number) && number > 0 ? number : 1
}
