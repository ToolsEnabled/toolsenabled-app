import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* LANE W28, owner R9 (2026-09-04T16:08:49Z), verbatim: "the everything page
 * ... the text does not go even near the boarder of the screen we are
 * wasting a lot of width. In notice the same issues on page 2".
 *
 * This repository has no DOM in its node tests (see
 * tools/test/mobile-size-floor.test.mjs), so what follows does what that
 * file does: read the ACTUAL declared numbers out of the stylesheet at test
 * time -- never a copy pasted into this file -- and run the same min()
 * arithmetic the browser runs on them, then assert on the resulting
 * BEHAVIOUR (how wide the content column ends up, how wide the gutter ends
 * up) rather than on which literal pixel value produced it. A rewrite that
 * picks a different, better number for either cap still has to pass this;
 * only a rewrite that puts the waste back can fail it.
 *
 * The rendered ground truth this test's bounds are drawn from is
 * tools/page-width-measure.ps1, a headless-Chrome-over-CDP render of this
 * repo's own dev server (no jsdom/puppeteer/playwright is vendored here),
 * measured at the owner's own persisted window
 * (AppData/Roaming/ToolsEnabled-Live/shell-state.json: width 2559, height
 * 1048, maximized true) -- see t5-m6-REPORT-w28-page-width-fix.md for the
 * RED/GREEN transcript that script produced.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const homeCss = read('src/home.css')
const stylesCss = read('src/styles.css')

const VIEWPORT = 2560 // the owner's own persisted window (shell-state.json), rounded up from 2559

/* The computers cap is read through one function rather than three copies of a
   regular expression, because it is now two facts and not one: the number, and
   the fact that it is divided by the zoom. R1206: a bare pixel cap surrenders
   width at Small, where the window measures 1/0.9 more CSS px than at Medium
   but the cap does not grow with it, so the box paints 2120 * 0.9 = 1908 device
   px. Three copies of the pattern is three places for the `/ var(--zoom, 1)`
   half to be dropped from only two of them. */
function computersPageMaxDeclaration(css) {
  const scaled = /body\[data-route="computers"\] \{ --page-max: calc\((\d+)px \/ var\(--zoom, 1\)\); \}/.exec(css)
  if (scaled) return { px: Number(scaled[1]), zoomScaled: true }
  /* The pre-R1206 spelling is still PARSED, deliberately. A reader that only
     recognised the fixed form would report "no declaration" for the defective
     one, and the two tests at the end of this file would then compare a column
     of zeroes to itself and pass while page 2 was surrendering 212 device px at
     Small. The shape is asserted once, above; the behaviour is measured from
     whatever shape is really there. */
  const bare = /body\[data-route="computers"\] \{ --page-max: (\d+)px; \}/.exec(css)
  return bare ? { px: Number(bare[1]), zoomScaled: false } : null
}

const computersPageMax = css => computersPageMaxDeclaration(css)?.px ?? null

test('home.css declares a numeric max-width for .home at the 1420px breakpoint', () => {
  const declared = /@media \(min-width: 1420px\) \{\s*\.home \{ max-width: (\d+)px;/.exec(homeCss)
  assert.ok(declared, '.home\'s wide-viewport max-width rule must still be a findable numeric declaration')
})

test('styles.css declares a numeric --page-max override for the computers route, scaled by the text size', () => {
  const declared = computersPageMaxDeclaration(stylesCss)
  assert.ok(declared, 'the computers route --page-max override must still be a findable numeric declaration')
  assert.equal(declared.zoomScaled, true,
    'mutation `drop the / var(--zoom, 1) from the computers --page-max` survived: expected the cap to be divided by the zoom, so the column is the same width on the glass at every text size')
})

test('at the owner\'s window, the Everything page (page 1) box reaches most of the screen', () => {
  const capPx = Number(/@media \(min-width: 1420px\) \{\s*\.home \{ max-width: (\d+)px;/.exec(homeCss)[1])
  // .home's own mechanism: a flat max-width, centred by margin-inline: auto.
  const contentWidth = Math.min(capPx, VIEWPORT)
  const gutterPerSide = (VIEWPORT - contentWidth) / 2
  assert.ok(contentWidth >= 1700,
    `the Everything page content box is only ${contentWidth}px wide at a ${VIEWPORT}px window -- the owner's complaint, still true`)
  assert.ok(gutterPerSide <= 450,
    `the Everything page wastes ${gutterPerSide}px of bare page on each side at a ${VIEWPORT}px window`)
})

test('at the owner\'s window, the Computers page (page 2) box reaches most of the screen', () => {
  const pageMaxPx = computersPageMax(stylesCss)
  const pageGutterPx = Number(/--page-gutter: (\d+)px;/.exec(stylesCss)[1])
  // The route's own mechanism, read verbatim from board.css/styles.css:
  // width: min(var(--page-max), calc(100% - 2 * var(--page-gutter)))
  const contentWidth = Math.min(pageMaxPx, VIEWPORT - 2 * pageGutterPx)
  const gutterPerSide = (VIEWPORT - contentWidth) / 2
  assert.ok(contentWidth >= 1900,
    `the Computers page content box is only ${contentWidth}px wide at a ${VIEWPORT}px window -- the owner's "same issue on page 2", still true`)
  assert.ok(gutterPerSide <= 350,
    `the Computers page wastes ${gutterPerSide}px of bare page on each side at a ${VIEWPORT}px window`)
})

/* LANE W53. The ledger route was left on the base --page-max while the other
   two were widened, so it wasted MORE of the window than page 1 ever did.
   Measured on the staged dev server at the owner's own 2560px window
   (tools/ledger-page-measure.ps1): .ledger-shell painted 1240px wide at x=656,
   1,320px of bare page, 51.6% of the screen. Same arithmetic as the two tests
   above, on the route's own mechanism -- .ledger-shell is
   `width: min(var(--page-max), 100%)`. */
test('at the owner\'s window, the Ledger page box reaches most of the screen', () => {
  const declared = /body\[data-route="ledger"\] \{ --page-max: (\d+)px; \}/.exec(stylesCss)
  assert.ok(declared, 'the ledger route has no --page-max override, so it falls back to the base width and wastes half the window')
  const contentWidth = Math.min(Number(declared[1]), VIEWPORT)
  const gutterPerSide = (VIEWPORT - contentWidth) / 2
  assert.ok(contentWidth >= 1900,
    `the Ledger page content box is only ${contentWidth}px wide at a ${VIEWPORT}px window -- the owner's "its just ugly", still true`)
  assert.ok(gutterPerSide <= 350,
    `the Ledger page wastes ${gutterPerSide}px of bare page on each side at a ${VIEWPORT}px window`)
})

test('a widened Ledger row still holds its request text to a reading measure', () => {
  /* Widening the shell hands the row's third track (`minmax(210px, 1fr)`) all
     the new room: measured 622px before, 1502px after. A 1502px line of prose
     is not more readable for being longer, so the TEXT stops at a measure while
     the TRACK keeps the width the metadata rails are positioned by. Asserted as
     a range in ch, the same unit the rest of this product measures prose in --
     not a pixel literal, and not the exact number, so a better measure still
     passes. */
  const ledgerCss = read('src/ledger.css')
  const titleBlock = /\.ledger-title \{[^}]*\}/.exec(ledgerCss)
  assert.ok(titleBlock, 'src/ledger.css no longer declares .ledger-title at all')
  const measure = /max-width:\s*(\d+)ch/.exec(titleBlock[0])
  assert.ok(measure, 'the ledger title has no reading measure, so at a wide window one request runs the full width of the row')
  const ch = Number(measure[1])
  assert.ok(ch >= 60 && ch <= 100,
    `a ${ch}ch measure is outside the range this product treats as readable prose (the .md-p rules use 70ch)`)
})

test('the Computers page column is still wider than the Everything page column, since only page 2\'s width is information', () => {
  // Cross-check the two caps do not accidentally collapse to the same
  // number: the RAIL is deliberately left at its 400px cap on page 2 (see
  // styles.css) and every extra pixel there goes to the canvas, which is a
  // reason page 2 legitimately wants more room than page 1's centred ring.
  const homeCapPx = Number(/@media \(min-width: 1420px\) \{\s*\.home \{ max-width: (\d+)px;/.exec(homeCss)[1])
  const pageMaxPx = computersPageMax(stylesCss)
  assert.ok(pageMaxPx > homeCapPx, 'the computers route no longer takes a wider column than the Everything page')
})

/* R1206, the 1.0.44 known issue: "Page 2 does not yet use the extra room at
   small text sizes: there is still noticeable empty space around the two boxes."

   Same technique as every test above -- read the sheet's own declared numbers
   and run the arithmetic the browser runs -- with one dimension added: the text
   size. Text size is `zoom` on <body>, so a window of W device px measures W/z
   CSS px, the route's `width: min(var(--page-max), calc(100% - 2 *
   var(--page-gutter)))` resolves in CSS px, and what a person SEES is that
   result painted back at z.

   The measure this asserts is not "how much space page 2 ought to use" -- the
   note is right that nobody stated one, and the 2120 cap is unchanged. It is
   the narrower thing that does have an answer: whatever that cap is, choosing a
   smaller text size must not shrink the box on the glass. */
const TEXT_SIZES = (await import('../../src/text-size.js')).TEXT_SIZES

function paintedComputersWidth(css, zoom) {
  const declared = computersPageMaxDeclaration(css)
  const capCssPx = declared.zoomScaled ? declared.px / zoom : declared.px
  const gutterPx = Number(/--page-gutter: (\d+)px;/.exec(css)[1])
  const availableCssPx = VIEWPORT / zoom - 2 * gutterPx
  return Math.min(capCssPx, availableCssPx) * zoom
}

test('page 2 keeps the same painted width at every text size, so a smaller size buys room instead of spending it', () => {
  const painted = TEXT_SIZES.map(zoom => [zoom, paintedComputersWidth(stylesCss, zoom)])
  const atMedium = painted.find(([zoom]) => zoom === 1)[1]
  for (const [zoom, width] of painted) {
    assert.ok(Math.abs(width - atMedium) < 1,
      `mutation \`make the computers --page-max a bare pixel literal again\` survived: expected the page-2 column to paint ${atMedium}px at every text size, but at zoom ${zoom} it paints ${width}px -- ${(atMedium - width) / 2}px of bare sheet added to each side by choosing a size that exists to fit MORE on screen`)
  }
})

test('the smallest text size is not the size that wastes the most of the window', () => {
  /* The defect stated as the reader met it. Before the fix this failed by
     212 device px at a 2560px window: the cap bound at 2120 CSS px while the
     window measured 2844 of them, so the box painted 1908. */
  const smallest = Math.min(...TEXT_SIZES)
  const wasteAtSmallest = VIEWPORT - paintedComputersWidth(stylesCss, smallest)
  const wasteAtMedium = VIEWPORT - paintedComputersWidth(stylesCss, 1)
  assert.ok(wasteAtSmallest <= wasteAtMedium,
    `mutation \`let the cap shrink with the zoom\` survived: at the smallest text size page 2 leaves ${wasteAtSmallest}px of bare sheet against ${wasteAtMedium}px at the default -- the empty space R1206 names`)
})
