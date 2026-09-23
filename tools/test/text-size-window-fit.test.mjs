/* LARGE TEXT MUST NOT PUSH THE PRODUCT OFF THE SCREEN.
 *
 * Owner, 2026-09-03: "text sizes for example large on my screen hides parts of
 * the window". Text size is `zoom` on <body> (src/text-size.js). A viewport
 * unit is NOT scaled by an ancestor zoom while the box painted from it IS, and
 * `body { overflow: hidden }` means a box painted past the window edge is not
 * scrolled to -- it is gone.
 *
 * MEASURED 2026-09-03 in the shipped Chromium (electron 43.3.0), offscreen
 * window with a 1280x900 content box, reading getBoundingClientRect():
 *
 *                                   zoom 1     zoom 1.12    zoom 0.9
 *   height: 100vh                   900.0      1008.0        810.0
 *   height: 100%                    900.0       900.0        900.0
 *   height: calc(100vh/var(--zoom)) 900.0       900.0        900.0
 *   fixed width: calc(100% - 56px)  28..1252   31..1249     82..1198
 *   fixed width: calc(100vw - 56px) 28..1252  -45..1325     89..1191
 *   abs max-height:min(70vh,620px)  620.0       694.4        558.0
 *   abs max-height:min(70vh/z,620)  620.0       630.0        558.0
 *   300px box: offsetHeight/rect    300/300     300/336      300/270
 *
 * Setting the zoom on <html> instead was measured on the same probe and
 * changes none of those numbers, so this is about the unit, not the element.
 *
 * WHAT THIS FILE PINS.
 *   1. The three spellings that hold: #stage sizes itself against its
 *      containing block, --zoom is declared at :root, and every length whose
 *      job is to bound something AGAINST THE WINDOW divides its viewport unit
 *      by --zoom. The last is a sweep, not a list of the rules that were fixed
 *      once, so the NEXT one written is caught rather than this one.
 *   2. Its escape hatch cannot rot: every allowed exception is named with a
 *      reason AND asserted to still exist. A stale entry fails.
 *   3. The behaviour of the module underneath -- called with values.
 *   4. One writer for the zoom, swept at source, so the drawer, the settings
 *      page and the boot read cannot drift apart again.
 *   5. Drag-to-resize converts the pointer into the units it writes.
 *
 * WHY A SOURCE SWEEP RATHER THAN A RENDERED PAGE: this suite has no DOM. The
 * numbers above came from a real window and are recorded here; what a node
 * test can hold is that the sheets keep saying the thing those numbers proved.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')

const rel = file => path.relative(REPO, file).replace(/\\/g, '/')

function walkFiles(dir, extension) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...walkFiles(full, extension))
    else if (entry.endsWith(extension)) found.push(full)
  }
  return found.sort()
}

/* Comments are stripped first, on purpose: several of these sheets EXPLAIN the
   defect in prose ("100% AND NOT 100vw..."), and a scanner that reads the
   explanation as the code would fail on the files that document the fix. */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/* Properties that decide how big a box is or where its edges land -- the only
   ones where a viewport unit can push something past the window. A fluid
   font-size, a padding or a gap in vw is a PROPORTION: it is supposed to grow
   with the text like every px on the page does, and is not this rule's
   business. */
const SIZE_PROPERTIES = new Set([
  'width', 'min-width', 'max-width',
  'height', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left',
  'inset', 'inset-block', 'inset-inline',
  'block-size', 'min-block-size', 'max-block-size',
  'inline-size', 'min-inline-size', 'max-inline-size',
  'grid-template-rows', 'grid-template-columns',
  'flex-basis',
])

const VIEWPORT_UNIT = /\d\s*(?:d|s|l)?(?:vh|vw|vmin|vmax|vb|vi)\b/

function sizeDeclarationsWithViewportUnits(css) {
  const found = []
  const declaration = /(?:^|[;{}])\s*([-a-z]+)\s*:\s*([^;{}]+)/g
  let match
  while ((match = declaration.exec(css)) !== null) {
    const [, property, value] = match
    if (!SIZE_PROPERTIES.has(property)) continue
    if (!VIEWPORT_UNIT.test(value)) continue
    found.push({ property, value: value.trim().replace(/\s+/g, ' ') })
  }
  return found
}

/* THE EXCEPTIONS, each with the reason it is one. Keyed by sheet and property;
   the `value` is matched as a substring so a reformat does not fail the build
   but a genuine change of the length does. Every entry is asserted to still
   match something below -- an exception nobody needs any more is a lie about
   the code, so it fails here rather than sitting in the file. */
const ALLOWED = [
  {
    file: 'src/styles.css', property: 'grid-template-columns', value: 'clamp(400px, 36.1vw, 600px)',
    why: 'the computers rail is a SHARE of the page, not a bound against the window: it is meant to grow with the text like the px columns beside it, and its own floor and ceiling are px that do exactly that.',
  },
  {
    file: 'src/diff-editor.css', property: 'height', value: '38vh',
    why: 'the pre-custom-property fallback of a two-declaration pair: an engine that cannot read var(--zoom) cannot read the --phone-canvas-h in the line below it either, so dividing here would drop the height instead of correcting it. The declaration that every shipped engine uses does divide.',
  },
]

const sheets = walkFiles(SRC, '.css')
const sheetSources = new Map(sheets.map(sheet => [rel(sheet), stripComments(readFileSync(sheet, 'utf8'))]))

function inspectWindowBounds(sources) {
  const offences = []
  const usedExceptions = new Set()
  for (const [file, css] of sources) {
    for (const { property, value } of sizeDeclarationsWithViewportUnits(css)) {
      /* `var(--zoom` and not the whole `var(--zoom, 1)`: the fallback is
         required of a new rule but is not what this gate is about, and pinning
         the exact characters is how a gate starts failing better code. */
      if (/var\(--zoom\b/.test(value)) continue
      const exception = ALLOWED.findIndex(entry =>
        entry.file === file && entry.property === property && value.includes(entry.value))
      if (exception >= 0) { usedExceptions.add(exception); continue }
      offences.push(`${file}  ${property}: ${value}`)
    }
  }
  return { offences, usedExceptions }
}

test('every window-bounding length in the sheets survives the Text size zoom', () => {
  const { offences, usedExceptions } = inspectWindowBounds(sheetSources)
  assert.deepEqual(offences, [],
    'a viewport unit in a size property is 12% bigger than it says at Large and 10% smaller at Small, and the overflow: hidden on the body means the surplus is not scrolled to but lost. Divide it by var(--zoom, 1) (see :root in src/styles.css), use a percentage where the containing block is already the window, or add it to ALLOWED here with the reason it is a proportion rather than a bound')
  assert.deepEqual([...usedExceptions].sort((a, b) => a - b), ALLOWED.map((_, index) => index),
    'every entry in ALLOWED must still match a real declaration -- a stale exception is a note about code that no longer exists')
})

// Current Home and Page 2 divide their window bounds by the text zoom.
// Historical 6a79 native evidence allowed six older viewport declarations;
// none remains in this source. Reintroducing any of them must now fail.
test('the six obsolete Home and Page 2 lengths receive no historical exception', () => {
  for (const [file, selector, property, value] of [
    ['src/home-chat.css', '.home-takeover .run-said', 'max-height', 'min(45vh, 420px)'],
    ['src/home-chat.css', '.home-takeover .home-feed .log-turns', 'max-height', 'min(45vh, 420px)'],
    ['src/tree-graph.css', '.tree-conversations', 'height', 'min(420px, 46dvh)'],
    ['src/tree-graph.css', '.tree-conversations', 'height', '52dvh'],
    ['src/tree-graph.css', '.tree-conversations', 'min-height', 'min(300px, 70dvh)'],
    ['src/tree-graph.css', '.tree-conversations', 'height', 'min(var(--conversation-height, 420px), 60dvh)'],
  ]) {
    const copy = new Map(sheetSources)
    copy.set(file, copy.get(file) + `\n${selector} { ${property}: ${value}; }\n`)
    assert.ok(inspectWindowBounds(copy).offences.includes(`${file}  ${property}: ${value}`))
  }
})

test('the sweep rejects the six original Role Studio window-clipping lengths', () => {
  const copy = new Map(sheetSources), file = 'src/role-studio.css'
  let restored = 0
  copy.set(file, copy.get(file).replace(/(100(?:vw|dvh))\s*\/\s*var\(--zoom,\s*1\)/g, (_, unit) => { restored++; return unit }))
  assert.equal(restored, 6, 'the negative control must restore all six repaired Role lengths')
  assert.equal(inspectWindowBounds(copy).offences.filter(line => line.startsWith(file + '  ')).length, 6)
})

test('--zoom is declared once, at :root, so a sheet can always divide by it', () => {
  const styles = readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  assert.match(stripComments(styles), /--zoom:\s*1\s*;/,
    'src/styles.css must declare --zoom: 1 at :root: without a declared default every calc() that divides by it is invalid at computed-value time, which takes the whole declaration with it')
})

test('the stage is sized by its containing block, never by a viewport unit', () => {
  const css = stripComments(readFileSync(path.join(SRC, 'styles.css'), 'utf8'))
  const rule = css.match(/#stage\s*\{([^}]*)\}/)
  assert.ok(rule, 'src/styles.css must still carry a #stage rule')
  assert.match(rule[1], /height:\s*100%/,
    'the stage is the whole application below the topbar and html/body are height:100%, so a percentage lands on the window at every text size')
  assert.doesNotMatch(rule[1], VIEWPORT_UNIT,
    'measured at 1280x900: height:100vh painted a 1008px stage at Large, so the bottom 108px of every page -- composer included -- sat under the window edge with nothing to scroll')
})

/* ==================================================================
   THE MODULE, called with values.
   ================================================================== */

const textSize = await import(new URL('../../src/text-size.js', import.meta.url))

function documentStandIn() {
  const declarations = new Map()
  const style = {
    zoom: '',
    setProperty: (name, value) => declarations.set(name, value),
    removeProperty: name => declarations.delete(name),
    getPropertyValue: name => declarations.get(name) ?? '',
  }
  return { body: { style: { zoom: '' } }, documentElement: { style }, declarations }
}

test('applying an offered size writes the zoom and the number the layout divides by', () => {
  for (const [given, zoom] of [[1.12, '1.12'], ['1.12', '1.12'], [0.9, '0.9'], ['0.9', '0.9']]) {
    const doc = documentStandIn()
    assert.equal(textSize.applyTextSize(given, doc), Number(zoom))
    assert.equal(doc.body.style.zoom, zoom, 'the body carries the zoom the person chose')
    assert.equal(doc.declarations.get('--zoom'), zoom,
      'and the sheets are told the same number, or every window-bounding length still divides by 1 and overflows')
    assert.equal(textSize.textZoom(doc), Number(zoom), 'and it can be read back')
  }
})

test('the default writes nothing at all, so an untouched document is untouched', () => {
  const doc = documentStandIn()
  textSize.applyTextSize(1.12, doc)
  assert.equal(textSize.applyTextSize('1', doc), 1)
  assert.equal(doc.body.style.zoom, '', 'zoom is cleared, not set to "1"')
  assert.equal(doc.declarations.has('--zoom'), false,
    '--zoom is removed, not set to "1": the :root declaration is the default')
  assert.equal(textSize.textZoom(doc), 1)
})

test('a size this product never offered is refused, and nothing is written', () => {
  for (const refused of ['1.5', 2, '', 'large', null, undefined, NaN, '1.12abc/**/', Infinity]) {
    assert.equal(textSize.normalizeTextSize(refused), null, `${String(refused)} is not an offered size`)
    const doc = documentStandIn()
    doc.body.style.zoom = '1.12'
    assert.equal(textSize.applyTextSize(refused, doc), null)
    assert.equal(doc.body.style.zoom, '1.12', 'a refused value must not disturb the size already applied')
    assert.equal(doc.declarations.has('--zoom'), false)
  }
  assert.deepEqual([...textSize.TEXT_SIZES], [0.9, 1, 1.12],
    'the offered sizes are the settings page row and the drawer segment; adding one here is how both learn it')
})

test('textZoom answers 1 for a document with no zoom, and never 0', () => {
  assert.equal(textSize.textZoom(documentStandIn()), 1)
  assert.equal(textSize.textZoom(undefined), 1, 'no document is not an excuse to divide by NaN')
  const broken = documentStandIn()
  broken.body.style.zoom = '0'
  assert.equal(textSize.textZoom(broken), 1, 'zero would make every divide-by-zoom infinite')
})

test('only src/text-size.js sets the body zoom', () => {
  /* One writer, swept at source, for the same reason src/phone-ledger.js has
     one: the boot read, the drawer and the settings page each used to carry
     their own copy of "set body.style.zoom", and the layout now needs a second
     thing written at the same instant. A file that READS the zoom is not a
     writer and is not counted. */
  const assignsZoom = /\bstyle\s*\.\s*zoom\s*=/
  const writers = walkFiles(SRC, '.js')
    .filter(file => assignsZoom.test(stripComments(readFileSync(file, 'utf8'))))
    .map(rel)
  assert.deepEqual(writers, ['src/text-size.js'],
    'src/text-size.js must be the one writer of the body zoom, so --zoom can never be left behind by a caller that only set the zoom')
})

/* ==================================================================
   DRAG-TO-RESIZE: the pointer is in window pixels, the style is not.
   ================================================================== */

const { attachResizeHandle } = await import(new URL('../../src/resize-handle.js', import.meta.url))

function handleStandIn(zoom) {
  const listeners = new Map()
  return {
    ownerDocument: { body: { style: { zoom: zoom === 1 ? '' : String(zoom) } } },
    classList: { add() {}, remove() {} },
    setPointerCapture() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    fire: (type, event) => listeners.get(type)?.(event),
  }
}

function dragBy(zoom, windowPx, options = {}) {
  const handle = handleStandIn(zoom)
  let size = 400
  attachResizeHandle(handle, {
    axis: 'x',
    getSize: () => size,
    apply: px => { size = px },
    ...options,
  })
  handle.fire('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} })
  handle.fire('pointermove', { pointerId: 1, clientX: windowPx, clientY: 0 })
  return size
}

test('a drag moves the edge with the pointer at every text size', () => {
  /* The pointer's clientX is in WINDOW pixels; apply() writes CSS pixels, which
     the zoom paints 1.12x larger. MEASURED (electron 43.3.0): a 300px box under
     zoom 1.12 reports offsetHeight 300 and a 336px rect. So 112 window px of
     travel is 100 CSS px of size -- undivided, the edge ran 12% ahead of the
     finger holding it. */
  assert.equal(dragBy(1, 112), 512, 'at Default the pointer and the style are the same unit')
  assert.equal(Math.round(dragBy(1.12, 112)), 500, '112 window px at Large is 100 CSS px')
  assert.equal(Math.round(dragBy(0.9, 90)), 500, '90 window px at Small is 100 CSS px')
})

test('the clamp and the stored number stay in the units the caller writes', () => {
  /* min/max are the caller's CSS px (the computers rail says 320..900). If the
     pointer delta arrived unconverted, Large would hit the ceiling 12% early
     and the width restored at the next launch would be a different rail. */
  assert.equal(dragBy(1.12, 1000, { max: 600 }), 600, 'the ceiling is a CSS px ceiling')
  assert.equal(dragBy(1.12, -1000, { min: 330 }), 330, 'and so is the floor')
})
