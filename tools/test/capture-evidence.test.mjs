/* THE TEST THAT MAKES A HEADLESS CAPTURE WORTH BELIEVING.
 *
 * WHY THIS FILE EXISTS, AND WHY IT WAS WRITTEN BEFORE THE CODE IT TESTS.
 *
 * tools/preview-browser-drive.mjs creates its BrowserWindow with `show: true`
 * on purpose, and its own header records what happened when it did not: with
 * `show: false`, capturePage() returned the LAST PAINTED FRAME rather than the
 * current one, because a hidden window does not repaint. The harness wrote a
 * file called preview-1024-theme-tan.png showing the WHITE theme while the
 * assertion beside it correctly read rgb(242,229,188) off the DOM. Green
 * assertions, lying evidence.
 *
 * That measurement is why both website drivers are excluded from
 * tools/packaged-qa-suite.mjs -- and being excluded is why the purchase surface
 * has no pre-publication check at all. The way out is not to hide the window
 * and hope: it is to make a capture that WOULD have been a lie FAIL, loudly,
 * inside the driver, so that no unattended run can produce a green line beside
 * a false picture ever again.
 *
 * TWO INDEPENDENT LIES, AND NEITHER CATCHES THE OTHER.
 *
 *   BLANK  -- the frame has no content. A window that never painted, a
 *             compositor that handed back an empty buffer, a page that failed
 *             to load. Caught by measuring the frame's own content: how many
 *             distinct colours it holds, and what fraction of it differs from
 *             its most common colour.
 *
 *   STALE  -- the frame has plenty of content and is from the WRONG MOMENT.
 *             This is the defect actually measured above, and no amount of
 *             looking at a single frame can see it: the tan screenshot showing
 *             white is a perfectly good picture of the previous instant. Caught
 *             by planting a freshness probe -- a small swatch whose colour is
 *             derived from a per-capture nonce -- immediately before the shot
 *             and requiring the CAPTURED PIXELS to show that exact colour. A
 *             stale frame shows the previous nonce's colour, and is named.
 *
 * The two are asserted separately and BOTH are required, because the obvious
 * cheat -- a correct probe over an otherwise empty frame -- is a lie of the
 * first kind wearing the proof of the second. Test 2 below is that cheat.
 *
 * Everything here is synthetic bitmaps: no Electron, no window, no build. That
 * is deliberate, so this file can live in `npm test` beside everything else,
 * and so the blank case can be constructed EXACTLY rather than hoped for.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPTURE_COULD_NOT_TELL,
  EVIDENCE_THRESHOLDS,
  PROBE_EXCLUSION_PX,
  assessCapture,
  captureTruthfully,
  describeFrame,
  domAgreementScript,
  frameOf,
  pixelAt,
  probeColour,
  readProbePixel,
  withViewport,
} from '../lib/capture-evidence.mjs'

/* ---------------------------------------------------------------- *
 * frame builders. Electron's NativeImage.toBitmap() is BGRA, so these
 * are BGRA too -- a helper that quietly used RGBA would make every
 * colour assertion below pass against the wrong channel order.
 * ---------------------------------------------------------------- */

function blankFrame(width, height, [r, g, b] = [255, 255, 255], alpha = 255) {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    bitmap[i * 4] = b
    bitmap[i * 4 + 1] = g
    bitmap[i * 4 + 2] = r
    bitmap[i * 4 + 3] = alpha
  }
  return { bitmap, width, height, scale: 1 }
}

/** A frame with the kind of content a rendered page actually has: a background,
 *  bands of chrome, and many small differently-coloured regions standing in for
 *  text runs and controls. */
function pageLikeFrame(width, height) {
  const frame = blankFrame(width, height, [250, 250, 250])
  const paint = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < Math.min(y0 + h, height); y += 1) {
      for (let x = x0; x < Math.min(x0 + w, width); x += 1) {
        const i = ((y * width) + x) * 4
        frame.bitmap[i] = b
        frame.bitmap[i + 1] = g
        frame.bitmap[i + 2] = r
      }
    }
  }
  paint(0, 0, width, 64, [24, 28, 34])
  for (let row = 0; row < 24; row += 1) {
    for (let column = 0; column < 18; column += 1) {
      const tone = [(row * 9) % 256, (column * 13) % 256, ((row * column) + 40) % 256]
      paint(20 + (column * 60), 90 + (row * 34), 46, 18, tone)
    }
  }
  return frame
}

function paintProbe(frame, nonce, cssSize = 24) {
  const [r, g, b] = probeColour(nonce)
  const side = Math.round(cssSize * frame.scale)
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const i = ((y * frame.width) + x) * 4
      frame.bitmap[i] = b
      frame.bitmap[i + 1] = g
      frame.bitmap[i + 2] = r
      frame.bitmap[i + 3] = 255
    }
  }
  return frame
}

const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

/* ================================================================ *
 * 1-4. THE BLANK CASES. Every one of these must FAIL.
 * ================================================================ */

test('1. a deliberately blank frame is refused, and named blank', () => {
  const verdict = assessCapture(blankFrame(640, 480), { nonce: 7 })
  assert.equal(verdict.truthful, false, 'a blank capture must never be accepted as evidence')
  assert.equal(verdict.verdict, 'blank')
  assert.match(verdict.why, /blank|no content|uniform/i)
})

test('2. a blank frame carrying the CORRECT freshness probe is STILL refused', () => {
  /* The obvious cheat, and the reason the two checks are separate. A driver
     that planted its probe and looked only at the probe would call an empty
     window truthful evidence -- fresh, and of nothing. */
  const frame = paintProbe(blankFrame(640, 480), 7)
  const verdict = assessCapture(frame, { nonce: 7 })
  assert.equal(verdict.probe.fresh, true, 'the probe itself is correct here; that is the point of the test')
  assert.equal(verdict.truthful, false, 'a fresh picture of nothing is still not evidence')
  assert.equal(verdict.verdict, 'blank')
})

test('3. all-black and fully transparent frames are refused too', () => {
  for (const frame of [blankFrame(640, 480, [0, 0, 0]), blankFrame(640, 480, [0, 0, 0], 0)]) {
    const verdict = assessCapture(frame, { nonce: 3 })
    assert.equal(verdict.truthful, false)
    assert.equal(verdict.verdict, 'blank')
  }
})

test('4. a near-blank frame -- one small painted region -- is refused', () => {
  const frame = blankFrame(640, 480)
  for (let y = 0; y < 20; y += 1) {
    for (let x = 0; x < 20; x += 1) {
      const i = ((y * 640) + x + 200) * 4
      frame.bitmap[i] = 10
      frame.bitmap[i + 1] = 20
      frame.bitmap[i + 2] = 30
    }
  }
  const verdict = assessCapture(frame, { nonce: 4 })
  assert.equal(verdict.truthful, false, '400 painted pixels in 307200 is not a rendered page')
  assert.equal(verdict.verdict, 'blank')
})

test('5. a frame with no pixels at all is refused, never passed by default', () => {
  const verdict = assessCapture({ bitmap: Buffer.alloc(0), width: 0, height: 0, scale: 1 }, { nonce: 5 })
  assert.equal(verdict.truthful, false)
  assert.equal(verdict.verdict, 'empty')
  assert.match(verdict.why, /no pixels|empty|0/i)
})

/* ================================================================ *
 * 6-7. THE STALE CASE -- rich content, wrong moment.
 * ================================================================ */

test('6. a full, plausible frame carrying the PREVIOUS capture\'s probe is refused as stale', () => {
  const frame = paintProbe(pageLikeFrame(800, 600), 11)
  const verdict = assessCapture(frame, { nonce: 12 })
  assert.equal(verdict.truthful, false,
    'this is the preview-1024-theme-tan.png defect exactly: a good picture of the wrong instant')
  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.probe.fresh, false)
  assert.match(verdict.why, /stale|probe|previous/i)
})

test('7. a frame whose probe is missing entirely is refused, not excused', () => {
  const verdict = assessCapture(pageLikeFrame(800, 600), { nonce: 12 })
  assert.equal(verdict.truthful, false)
  assert.equal(verdict.verdict, 'stale')
})

/* ================================================================ *
 * 8. THE REAL PATH. This is the only shape that may pass.
 * ================================================================ */

test('8. a page-like frame with the current probe is accepted as evidence', () => {
  const frame = paintProbe(pageLikeFrame(800, 600), 12)
  const verdict = assessCapture(frame, { nonce: 12 })
  assert.equal(verdict.truthful, true, verdict.why)
  assert.equal(verdict.verdict, 'evidence')
  assert.ok(verdict.stats.distinctColours >= EVIDENCE_THRESHOLDS.minDistinctColours)
  assert.ok(verdict.stats.informativeShare >= EVIDENCE_THRESHOLDS.minInformativeShare)
})

test('9. and the acceptance is not a rubber stamp: flatten the same frame and it fails', () => {
  /* A mutation of the ACCEPTED input, so test 8 cannot be green because the
     assessor says yes to everything. */
  const good = paintProbe(pageLikeFrame(800, 600), 13)
  assert.equal(assessCapture(good, { nonce: 13 }).truthful, true)
  const flattened = paintProbe(blankFrame(800, 600, [250, 250, 250]), 13)
  assert.equal(assessCapture(flattened, { nonce: 13 }).truthful, false)
})

/* ================================================================ *
 * 10-13. The primitives the two checks stand on.
 * ================================================================ */

test('10. consecutive nonces get colours far enough apart that a stale probe cannot pass as fresh', () => {
  for (let nonce = 0; nonce < 200; nonce += 1) {
    const here = probeColour(nonce)
    const next = probeColour(nonce + 1)
    assert.ok(distance(here, next) > 60,
      `probe ${nonce} ${JSON.stringify(here)} and ${nonce + 1} ${JSON.stringify(next)} are too close to tell apart`)
    /* Never white, never black, never grey: those are the colours a blank or a
       half-painted frame produces on its own, and a probe that could be
       confused with the background is not a probe. */
    const [r, g, b] = here
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) > 40,
      `probe ${nonce} ${JSON.stringify(here)} is too close to grey to distinguish from an unpainted frame`)
  }
})

test('11. probe colours are deterministic -- the driver and the assessor must agree', () => {
  assert.deepEqual(probeColour(42), probeColour(42))
})

test('12. frameOf derives the real scale when the reported size is CSS pixels and the buffer is 2x', () => {
  /* Measured elsewhere in this repo (tools/ring-capture-main.cjs): an offscreen
     page reports devicePixelRatio 1 while its backing buffer is genuinely 2x,
     and getSize()'s units differ between the offscreen and windowed paths.
     Believing either cost a run where every sample landed at half its intended
     position. The buffer's own pixel count is the one statement true in both. */
  const image = {
    getSize: () => ({ width: 400, height: 300 }),
    toBitmap: () => Buffer.alloc(800 * 600 * 4),
  }
  const frame = frameOf(image)
  assert.equal(frame.scale, 2)
  assert.equal(frame.width, 800)
  assert.equal(frame.height, 600)
})

test('13. pixelAt reads CSS coordinates through that scale, in BGRA', () => {
  const frame = blankFrame(800, 600, [250, 250, 250])
  frame.scale = 2
  const i = ((10 * 800) + 20) * 4      // device pixel (20,10) == CSS (10,5)
  frame.bitmap[i] = 3                  // B
  frame.bitmap[i + 1] = 2              // G
  frame.bitmap[i + 2] = 1              // R
  assert.deepEqual(pixelAt(frame, 10, 5), [1, 2, 3])
})

test('14. describeFrame reports what it actually sampled, so a vacuous read cannot look like a rich one', () => {
  const stats = describeFrame(pageLikeFrame(800, 600))
  assert.ok(stats.sampled > 0)
  assert.ok(stats.distinctColours > 1)
  assert.ok(stats.modalShare > 0 && stats.modalShare <= 1)
})

test('15. the probe swatch is not counted as content -- a blank frame with a probe has ONE colour', () => {
  /* MEASURED, not supposed. A real offscreen capture of a deliberately blank
     page came back with SEVEN distinct colours -- the probe swatch and its
     antialiased edge -- against a floor of eight. A margin of one is not a
     floor, so the probe's corner is excluded from the content reading and the
     same capture now reads as the single colour it actually is. */
  const stats = describeFrame(paintProbe(blankFrame(640, 480), 21))
  assert.equal(stats.distinctColours, 1, 'the probe corner must not be counted as page content')
  assert.equal(stats.informativeShare, 0)
})

test('16. the probe is read without knowing the scale, because the scale is not knowable from the image', () => {
  /* Measured 2026-08-23: an offscreen capture of a 900x700 window arrived as
     1241x966 (a 137.5% display) while the page reported devicePixelRatio 1 and
     getSize() reported the DEVICE size -- so every scale derived from the image
     alone came out 1. The probe read has to hold anyway. */
  for (const scale of [1, 1.25, 1.375, 2, 3]) {
    const frame = blankFrame(Math.round(800 * scale), Math.round(600 * scale), [250, 250, 250])
    frame.scale = scale
    paintProbe(frame, 31)
    assert.deepEqual(readProbePixel(frame), probeColour(31), `probe unreadable at scale ${scale}`)
  }
})

test('17. and a stale frame is still caught at every one of those scales', () => {
  for (const scale of [1, 1.375, 2]) {
    const frame = pageLikeFrame(Math.round(800 * scale), Math.round(600 * scale))
    frame.scale = scale
    paintProbe(frame, 40)
    assert.equal(assessCapture(frame, { nonce: 41 }).verdict, 'stale', `stale frame passed at scale ${scale}`)
    assert.equal(assessCapture(frame, { nonce: 40 }).verdict, 'evidence', `fresh frame refused at scale ${scale}`)
  }
})

test('18. withViewport takes the scale from the page, which is the only source that is right', () => {
  const frame = { bitmap: Buffer.alloc(1241 * 966 * 4), width: 1241, height: 966, scale: 1 }
  const scaled = withViewport(frame, { innerWidth: 902, innerHeight: 702 })
  assert.ok(Math.abs(scaled.scale - 1.376) < 0.01, `scale came out ${scaled.scale}`)
  /* and a caller that has no viewport reading gets the frame back untouched
     rather than a confidently wrong number */
  assert.equal(withViewport(frame, {}).scale, 1)
})

test('19. the DOM-agreement point is looked for OUTSIDE the probe corner', () => {
  const script = domAgreementScript()
  assert.match(script, new RegExp(`let y = ${PROBE_EXCLUSION_PX}`),
    'the scan must start past the probe, or it would compare the page against the probe swatch')
  assert.match(script, /elementFromPoint/)
  assert.match(script, /innerWidth/, 'the point must come back with the viewport that scales it')
  assert.match(script, /onBody/,
    'a theme claim needs a point where the BODY paints; the caller must be told which kind it got')
})

test('20. a legitimately SPARSE page -- a refusal, a page failed closed -- is not called blank', () => {
  /* The false-failure this threshold has to survive. preview-browser-drive
     photographs the surface after its liveness mutation has replaced the whole
     simulation with a refusal, and subscribe-page-drive photographs the
     subscription page with its catalog gone and its controls removed. Both are
     mostly background with a few lines of text, and both are the product
     behaving CORRECTLY. A blankness floor tuned for a dense page would fail the
     run for them, which is how a gate gets switched off. */
  const frame = blankFrame(1024, 768, [252, 252, 252])
  let painted = 0
  for (let line = 0; line < 12; line += 1) {
    for (let x = 120; x < 640; x += 1) {
      for (let y = 200 + (line * 24); y < 214 + (line * 24); y += 1) {
        // a third of the glyph box is ink, at a dozen antialiased greys
        if ((x + y) % 3 !== 0) continue
        const i = ((y * 1024) + x) * 4
        const grey = 20 + ((x * y) % 12) * 4
        frame.bitmap[i] = grey
        frame.bitmap[i + 1] = grey
        frame.bitmap[i + 2] = grey
        painted += 1
      }
    }
  }
  const verdict = assessCapture(paintProbe(frame, 60), { nonce: 60 })
  assert.ok(painted / (1024 * 768) < 0.05, `this fixture must stay sparse; it painted ${painted} pixels`)
  assert.equal(verdict.truthful, true, verdict.why)
})

test('21. an unreadable NativeImage is could-not-tell, is not latched, and its probe is removed', async () => {
  const scripts = []
  const contents = {
    executeJavaScript: async script => {
      scripts.push(script)
      return 'rgb(1, 2, 3)'
    },
    capturePage: async () => ({
      getSize: () => ({ width: 640, height: 480 }),
      toBitmap: () => { const error = new Error('bitmap storage disappeared'); error.code = 'EMFILE'; throw error },
    }),
  }

  const result = await captureTruthfully(contents, { nonce: 70, attempts: 1, settleMs: 0 })

  assert.equal(result.verdict.truthful, false)
  assert.equal(result.verdict.verdict, 'unavailable')
  assert.equal(result.verdict.code, CAPTURE_COULD_NOT_TELL)
  assert.equal(result.verdict.causeCode, 'EMFILE')
  assert.match(result.verdict.why, /could not be read.*bitmap storage disappeared/i)
  assert.match(result.verdict.why, /could not tell.*NOT claiming.*absent or empty/i)
  assert.equal(result.image, null, 'an unreadable image must not be handed back as usable evidence')
  assert.equal(result.frame, null)
  assert.match(scripts.at(-1), /probe\.remove\(\)/, 'the failure path must still remove the page probe')

  /* CONTROL: the next call on the same contents succeeds. The transient answer
     must not be cached or latched for the helper's/process's lifetime. */
  contents.capturePage = async () => ({
    getSize: () => ({ width: 800, height: 600 }),
    toBitmap: () => paintProbe(pageLikeFrame(800, 600), 71).bitmap,
  })
  const recovered = await captureTruthfully(contents, { nonce: 71, attempts: 1, settleMs: 0 })
  assert.equal(recovered.verdict.verdict, 'evidence', recovered.verdict.why)
  assert.equal(recovered.verdict.truthful, true)
})
