/* IS THIS SCREENSHOT EVIDENCE, OR IS IT A LIE?
 *
 * THE MEASUREMENT THIS FILE EXISTS FOR. tools/preview-browser-drive.mjs creates
 * its BrowserWindow with `show: true` on purpose. Its header records why: with
 * `show: false`, capturePage() returned the LAST PAINTED FRAME rather than the
 * current one, because a hidden window does not repaint. The harness wrote
 * preview-1024-theme-tan.png showing the WHITE theme while the assertion beside
 * it correctly read rgb(242,229,188) off the DOM. Green assertions, lying
 * evidence.
 *
 * That is why both website drivers -- including the ONLY behavioural check of
 * the purchase surface -- are held out of tools/packaged-qa-suite.mjs, which is
 * what `npm run release:cut` runs before a publication. Rule 4 of that suite
 * (no window, no console, no stolen focus) and those drivers' evidence are both
 * right, and until this file they could not both hold.
 *
 * THE RESOLUTION IS NOT TO HIDE THE WINDOW AND HOPE. It is to make a capture
 * that WOULD have been a lie fail, by name, inside the driver -- so that an
 * unattended run cannot produce a green line beside a false picture. Two
 * independent lies, and neither one catches the other:
 *
 *   BLANK. The frame has no content: a window that never painted, an empty
 *   compositor buffer, a page that did not load. Measured from the frame
 *   itself -- how many distinct colours it holds, and what fraction of it
 *   differs from its own most common colour.
 *
 *   STALE. The frame is full, plausible, and from the WRONG MOMENT. This is
 *   the defect actually measured above, and nothing about a single frame can
 *   reveal it: the tan screenshot showing white is a perfectly good picture of
 *   the previous instant. Caught by planting a FRESHNESS PROBE -- a small
 *   swatch whose colour is derived from a per-capture nonce -- immediately
 *   before the shot, and requiring the CAPTURED PIXELS to show that exact
 *   colour. A stale frame shows the previous nonce's colour and is named as
 *   stale rather than reported as a pass.
 *
 * BOTH are required, because the obvious cheat -- a correct probe over an
 * otherwise empty frame -- is the first lie wearing the second's proof.
 * tools/test/capture-evidence.test.mjs asserts that cheat fails, and was
 * written before this file existed.
 *
 * WHERE THE PROBE GOES, and why it is safe on these two pages. It is appended
 * to document.body as position:fixed, pointer-events:none, with NO TEXT, no
 * tabindex and a class no page rule matches -- so:
 *   - public/preview/honesty.js's MutationObserver watches the `.sim-surface`
 *     root, not the body, and its auditSurface() only walks inside that root,
 *     so the probe cannot trip the preview's own tamper refusal;
 *   - subscribe-page-drive's control census reads `#stage > .view`, its
 *     overflow reading is scrollWidth (a fixed element adds none), and its
 *     keyboard traversal only reaches focusable nodes;
 *   - elementFromPoint hit-tests see through pointer-events:none.
 * It is removed again as soon as the shot is taken, so every DOM reading after
 * a capture is taken on the page as the product ships it. The swatch stays in
 * the PNG on purpose: it is the visible statement that the frame was painted at
 * capture time.
 */

export const PROBE_ID = 'mc-capture-freshness-probe'
export const PROBE_CSS_SIZE = 24

/* THE TOP-LEFT CORNER, AND NOT ANY OTHER. Measured 2026-08-23 on this machine:
   a window whose page scrolls carries a CLASSIC 15px scrollbar down the right
   edge, so a probe anchored right:0 puts the frame's top-right device pixels on
   the scrollbar rather than on the probe -- and a page that overflows
   horizontally (which subscribe-page-drive exists to catch) would do the same
   to the bottom edge. Only the top-left corner is unreachable by either
   scrollbar. */

/* How much of that corner is NOT counted as page content. Measured: a 24 CSS px
   probe occupied device pixels 0..32 at this machine's 137.5% display scale, so
   the probe's own swatch is well inside 96 device pixels at any scale a desktop
   produces. Excluding it matters -- without it a genuinely blank capture came
   back with SEVEN distinct colours (the swatch and its antialiased edge) against
   a floor of eight, which is a margin nobody should be relying on. */
export const PROBE_EXCLUSION_PX = 96

/* Thresholds are exported so the tests assert against the same numbers the
   drivers use, and so a future loosening has to be written down here rather
   than tuned quietly inside one driver.

   minDistinctColours: a rendered page has hundreds -- antialiased text alone
   produces dozens. An unpainted frame has ONE. This is the primary signal.
   minInformativeShare: the fraction of sampled pixels that differ from the
   frame's own modal colour, and it is the SECONDARY guard -- against a frame
   that is empty except for one artefact. It is deliberately low, because these
   drivers photograph pages that are legitimately sparse: a preview whose
   surface has been replaced by a refusal, and a subscription page that has
   failed closed, are both mostly background with a few lines of text, and a
   floor tuned for a dense page would call them blank and fail a run for the
   product behaving correctly. The two are asked with OR: either one failing is
   a blank frame. */
export const EVIDENCE_THRESHOLDS = Object.freeze({
  minDistinctColours: 8,
  minInformativeShare: 0.001,
  informativeDelta: 12,
  probeTolerance: 24,
})

/* ------------------------------------------------------------------ *
 * the probe colour
 * ------------------------------------------------------------------ */

/**
 * A colour for capture `nonce`. Hues advance by the golden angle, so
 * consecutive captures are as far apart as two hues can be -- a stale frame
 * showing the previous capture's probe cannot be mistaken for a fresh one.
 * Saturated and mid-lightness on purpose: never white, never black, never grey,
 * because those are exactly the colours an unpainted or half-painted frame
 * produces on its own.
 */
export function probeColour(nonce) {
  const hue = (Math.abs(Number(nonce) || 0) * 137.508) % 360
  return hslToRgb(hue, 0.72, 0.5)
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation
  const section = hue / 60
  const second = chroma * (1 - Math.abs((section % 2) - 1))
  const [r, g, b] = section < 1 ? [chroma, second, 0]
    : section < 2 ? [second, chroma, 0]
      : section < 3 ? [0, chroma, second]
        : section < 4 ? [0, second, chroma]
          : section < 5 ? [second, 0, chroma]
            : [chroma, 0, second]
  const match = lightness - (chroma / 2)
  return [r, g, b].map(value => Math.round((value + match) * 255))
}

/** The script that plants (or recolours) the probe. Returns the colour it
 *  painted, so the caller can prove the DOM agrees before reading pixels. */
export function plantProbeScript(nonce) {
  const [r, g, b] = probeColour(nonce)
  return `(() => {
  let probe = document.getElementById(${JSON.stringify(PROBE_ID)})
  if (!probe) {
    probe = document.createElement('div')
    probe.id = ${JSON.stringify(PROBE_ID)}
    probe.setAttribute('aria-hidden', 'true')
    document.body.appendChild(probe)
  }
  probe.style.cssText = 'position:fixed;left:0;top:0;margin:0;padding:0;border:0;'
    + 'width:${PROBE_CSS_SIZE}px;height:${PROBE_CSS_SIZE}px;pointer-events:none;'
    + 'z-index:2147483647;opacity:1;transform:none;filter:none;mix-blend-mode:normal;'
    + 'background-color:rgb(${r},${g},${b});'
  return getComputedStyle(probe).backgroundColor
})()`
}

/** Take the probe back out, so every DOM reading after a capture is taken on
 *  the page as it ships. */
export function removeProbeScript() {
  return `(() => { const probe = document.getElementById(${JSON.stringify(PROBE_ID)})
  if (probe) probe.remove()
  return !document.getElementById(${JSON.stringify(PROBE_ID)}) })()`
}

/** Two animation frames, so the plant is composited before the shot is asked
 *  for. Not proof on its own -- the probe check below is the proof -- but it is
 *  what makes the first attempt usually enough. */
export const PAINT_SETTLED = `new Promise(resolve => requestAnimationFrame(
  () => requestAnimationFrame(() => resolve(true))))`

/* ------------------------------------------------------------------ *
 * reading a captured frame
 * ------------------------------------------------------------------ */

/**
 * Turn a NativeImage into a frame whose geometry is derived from the BUFFER,
 * never from what the page or the image says about itself.
 *
 * Measured in this repo (tools/ring-capture-main.cjs): an offscreen page
 * reports devicePixelRatio 1 while its backing buffer is genuinely 2x, and
 * getSize()'s units differ between the offscreen and windowed paths. Believing
 * either cost a run where every sample landed at half its intended position.
 * The buffer's own pixel count against the reported box is the one statement
 * that is true in both modes.
 */
export function frameOf(image) {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const pixels = bitmap.length / 4
  if (!size.width || !size.height || !pixels) {
    return { bitmap, width: 0, height: 0, scale: 1, reported: size }
  }
  const scale = Math.sqrt(pixels / (size.width * size.height))
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.round(pixels / width)
  return { bitmap, width, height, scale, reported: size }
}

/** Read one pixel by CSS coordinate, through whatever scale the buffer turned
 *  out to have. Electron's toBitmap() is BGRA; this returns [r, g, b]. */
export function pixelAt(frame, cssX, cssY) {
  const x = Math.min(frame.width - 1, Math.max(0, Math.round(cssX * frame.scale)))
  const y = Math.min(frame.height - 1, Math.max(0, Math.round(cssY * frame.scale)))
  const index = ((y * frame.width) + x) * 4
  if (index < 0 || index + 2 >= frame.bitmap.length) return null
  return [frame.bitmap[index + 2], frame.bitmap[index + 1], frame.bitmap[index]]
}

export function colourDistance(a, b) {
  if (!a || !b) return Infinity
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/**
 * The scale a frame is ACTUALLY at, from the page's own viewport width.
 *
 * Measured 2026-08-23: an offscreen capture of a 900x700 window came back
 * 1241x966 while the page reported devicePixelRatio 1 -- the display is at
 * 137.5%, the page cannot see it, and getSize() reported the DEVICE size, so a
 * scale derived from getSize() alone comes out 1 and every CSS coordinate after
 * the first few dozen pixels lands somewhere else. capturePage() captures the
 * viewport, so frame width over CSS viewport width is the one ratio that is
 * true on any machine.
 */
export function withViewport(frame, { innerWidth, innerHeight } = {}) {
  if (!innerWidth || !frame.width) return frame
  const scale = frame.width / innerWidth
  return { ...frame, scale, cssWidth: innerWidth, cssHeight: innerHeight ?? null }
}

/**
 * Read the probe WITHOUT needing to know the scale. The swatch is at least
 * PROBE_CSS_SIZE device pixels on a side for any scale a desktop produces, so a
 * few pixels in from the corner is inside it either way; the modal colour of a
 * small block rather than one pixel, so an antialiased edge cannot decide it.
 */
export function readProbePixel(frame) {
  if (!frame || !frame.width || !frame.height) return null
  const counts = new Map()
  for (let y = 3; y <= 9; y += 1) {
    for (let x = 3; x <= 9; x += 1) {
      if (x >= frame.width || y >= frame.height) continue
      const at = ((y * frame.width) + x) * 4
      if (at + 2 >= frame.bitmap.length) continue
      const colour = [frame.bitmap[at + 2], frame.bitmap[at + 1], frame.bitmap[at]]
      const key = colour.join(',')
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  let best = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; best = key }
  }
  return best === null ? null : best.split(',').map(Number)
}

/**
 * Find a point the DOM will vouch for: a spot where one element paints one
 * opaque colour across at least a 12px neighbourhood, so the captured pixel
 * there can be compared with what the page says should be there.
 *
 * This is the general form of the check preview-browser-drive already makes for
 * its theme screenshots, and it is stronger than a fixed coordinate: a fixed
 * (8,8) reading is right until somebody puts a header in the corner, and it is
 * meaningless the moment the freshness probe sits there.
 */
export function domAgreementScript({ margin = PROBE_EXCLUSION_PX, step = 40 } = {}) {
  return `(() => {
  const solid = element => {
    if (!element) return null
    const style = getComputedStyle(element)
    if (style.backgroundImage !== 'none') return null
    const match = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(style.backgroundColor)
    if (!match) return null
    if (match[4] !== undefined && Number(match[4]) < 0.999) return null
    if (Number(style.opacity) < 0.999) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const width = document.documentElement.clientWidth
  const height = document.documentElement.clientHeight
  const viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight,
                     clientWidth: width, clientHeight: height }
  /* TWO PASSES, and the first one is the page's own background. A caller
     checking that a screenshot named theme-tan shows the tan theme needs a
     point where the BODY's colour is what paints; any other solid element
     proves the picture matches the DOM but says nothing about the theme. */
  for (const bodyOnly of [true, false]) {
    for (let y = ${margin}; y < height - 8; y += ${step}) {
      for (let x = ${margin}; x < width - 8; x += ${step}) {
        const element = document.elementFromPoint(x, y)
        if (bodyOnly && element !== document.body && element !== document.documentElement) continue
        const colour = solid(element)
        if (!colour) continue
        const neighbours = [[x - 6, y - 6], [x + 6, y - 6], [x - 6, y + 6], [x + 6, y + 6]]
          .map(point => document.elementFromPoint(point[0], point[1]))
        if (neighbours.some(node => node !== element)) continue
        return { x, y, rgb: colour, tag: element.tagName, onBody: bodyOnly,
                 className: String(element.className || '').slice(0, 40), ...viewport }
      }
    }
  }
  return { x: null, y: null, rgb: null, onBody: false, ...viewport }
})()`
}

/**
 * What is actually in this frame. Sampled on a stride so a 1920x1080 capture at
 * 2x (8.3 million pixels) costs a few milliseconds rather than a second, and
 * the number of pixels ACTUALLY read is reported -- a reading that sampled
 * nothing must not be able to look like a reading of a rich frame.
 */
export function describeFrame(frame, { maxSamples = 200_000, delta = EVIDENCE_THRESHOLDS.informativeDelta } = {}) {
  const pixels = frame.width * frame.height
  if (!pixels || !frame.bitmap || frame.bitmap.length < 4) {
    return { sampled: 0, distinctColours: 0, modalShare: 0, informativeShare: 0, modal: null }
  }
  const stride = Math.max(1, Math.floor(pixels / maxSamples))
  /* The probe's own swatch is NOT content. Counting it was measured to lift a
     genuinely blank capture to seven distinct colours against a floor of eight. */
  const exclude = {
    x: Math.min(PROBE_EXCLUSION_PX, Math.floor(frame.width / 4)),
    y: Math.min(PROBE_EXCLUSION_PX, Math.floor(frame.height / 4)),
  }
  const inProbeCorner = index => {
    const x = index % frame.width
    return x < exclude.x && Math.floor(index / frame.width) < exclude.y
  }
  const counts = new Map()
  let sampled = 0
  for (let index = 0; index < pixels; index += stride) {
    const at = index * 4
    if (at + 3 >= frame.bitmap.length) break
    if (inProbeCorner(index)) continue
    const b = frame.bitmap[at]
    const g = frame.bitmap[at + 1]
    const r = frame.bitmap[at + 2]
    const alpha = frame.bitmap[at + 3]
    /* A fully transparent buffer is the shape an unpainted offscreen frame
       arrives in. Folding alpha into the key rather than ignoring it keeps
       "transparent" from being counted as a colour a page chose. */
    const key = (((alpha < 8 ? 0 : (r >> 3) + 1) << 12) | ((g >> 3) << 6) | (b >> 3))
    counts.set(key, (counts.get(key) || 0) + 1)
    sampled += 1
  }
  let modalKey = null
  let modalCount = 0
  for (const [key, count] of counts) {
    if (count > modalCount) { modalCount = count; modalKey = key }
  }
  const modal = modalKey === null ? null : [
    ((modalKey >> 12) & 0x3f) === 0 ? -1 : ((((modalKey >> 12) & 0x3f) - 1) << 3),
    ((modalKey >> 6) & 0x3f) << 3,
    (modalKey & 0x3f) << 3,
  ]
  let informative = 0
  for (let index = 0; index < pixels; index += stride) {
    const at = index * 4
    if (at + 3 >= frame.bitmap.length) break
    if (inProbeCorner(index)) continue
    const here = [frame.bitmap[at + 2], frame.bitmap[at + 1], frame.bitmap[at]]
    if (modal && modal[0] >= 0 && colourDistance(here, modal) > delta) informative += 1
    else if (modal && modal[0] < 0 && frame.bitmap[at + 3] >= 8) informative += 1
  }
  return {
    sampled,
    stride,
    distinctColours: counts.size,
    modal,
    modalShare: sampled ? modalCount / sampled : 0,
    informativeShare: sampled ? informative / sampled : 0,
  }
}

/**
 * The verdict. `truthful` is the only field a driver may treat as a pass, and
 * it is false unless the frame is BOTH non-blank AND provably of this moment.
 *
 * verdict: 'evidence' | 'blank' | 'stale' | 'empty'
 */
export function assessCapture(frame, { nonce, thresholds = EVIDENCE_THRESHOLDS } = {}) {
  const stats = describeFrame(frame, { delta: thresholds.informativeDelta })
  const expected = probeColour(nonce)
  const previous = probeColour(Number(nonce) - 1)
  const found = readProbePixel(frame)
  const off = colourDistance(found, expected)
  const fresh = off <= thresholds.probeTolerance
  const probe = {
    nonce,
    expected,
    found,
    off: Number.isFinite(off) ? off : null,
    fresh,
    matchesPrevious: colourDistance(found, previous) <= thresholds.probeTolerance,
  }

  if (!frame || !frame.width || !frame.height || stats.sampled === 0) {
    return {
      truthful: false,
      verdict: 'empty',
      why: `the capture has no pixels at all (${frame && frame.width}x${frame && frame.height}, `
        + `${stats.sampled} sampled) -- nothing was measured, which is a failure and never a pass`,
      stats,
      probe,
    }
  }

  /* Blankness is asked FIRST and independently of the probe, because a fresh
     picture of nothing is still not evidence. */
  if (stats.distinctColours < thresholds.minDistinctColours
    || stats.informativeShare < thresholds.minInformativeShare) {
    return {
      truthful: false,
      verdict: 'blank',
      why: `the capture is blank or near-blank: ${stats.distinctColours} distinct colours `
        + `(floor ${thresholds.minDistinctColours}) and ${(stats.informativeShare * 100).toFixed(3)}% of `
        + `${stats.sampled} sampled pixels differ from its own modal colour (floor `
        + `${(thresholds.minInformativeShare * 100).toFixed(3)}%). A window that painted nothing captures `
        + 'exactly like this, so this frame proves nothing about the page.',
      stats,
      probe,
    }
  }

  if (!fresh) {
    return {
      truthful: false,
      verdict: 'stale',
      why: probe.matchesPrevious
        ? `the capture is STALE: its freshness probe still shows capture ${Number(nonce) - 1}'s colour `
          + `${JSON.stringify(previous)} rather than ${JSON.stringify(expected)}. This frame is a picture of `
          + 'an earlier instant -- the defect that made a screenshot named theme-tan show the white theme.'
        : `the capture does not show this capture's freshness probe: expected ${JSON.stringify(expected)} at `
          + `the top-left ${PROBE_CSS_SIZE}px, found ${JSON.stringify(found)} (off by ${probe.off}). The frame `
          + 'cannot be shown to be of this moment, so it is not evidence.',
      stats,
      probe,
    }
  }

  return {
    truthful: true,
    verdict: 'evidence',
    why: `${stats.distinctColours} distinct colours, ${(stats.informativeShare * 100).toFixed(1)}% of `
      + `${stats.sampled} sampled pixels painted, freshness probe ${nonce} matched within ${probe.off}`,
    stats,
    probe,
  }
}

/* ------------------------------------------------------------------ *
 * the capture itself
 * ------------------------------------------------------------------ */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* Every await that reaches into a browser gets a bound. An unbounded one turns
   a wedged renderer into a harness that never returns and reports nothing at
   all -- which reads to whoever is watching stdout as a run still going well. */
function bounded(promise, ms, label) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not return within ${ms}ms`)), ms) }),
  ])
}

/* This is deliberately not `empty`. `empty` is a fact learned from a frame
   that was successfully read; an exception means the machine did not complete
   that measurement. Keep the operational code as data for the report while
   giving code-less throws (and our timeout) one stable, explicit code. */
export const CAPTURE_COULD_NOT_TELL = 'CAPTURE_COULD_NOT_TELL'

function couldNotTell(action, error) {
  const detail = error && error.message || String(error)
  return {
    truthful: false,
    verdict: 'unavailable',
    code: CAPTURE_COULD_NOT_TELL,
    causeCode: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null,
    why: `${action}: ${detail}. The machine could not tell; this is NOT claiming that the capture or page is absent or empty.`,
    stats: null,
    probe: null,
  }
}

/**
 * Take a capture that can be believed, or say why it cannot be.
 *
 * `contents` is an Electron webContents (duck-typed, so the tests can drive it
 * with a fake): executeJavaScript, capturePage, and optionally invalidate.
 *
 * EACH ATTEMPT USES A NEW NONCE. That is not cosmetic: it means a frame that is
 * one repaint behind shows the PREVIOUS attempt's probe colour and is named
 * 'stale' rather than merely "wrong", which is the difference between knowing
 * the compositor is lagging and guessing.
 *
 * It NEVER throws for a bad frame and never returns a frame silently. The
 * caller gets { verdict, image, frame, attempts } and is expected to turn
 * verdict.truthful into an assertion -- a capture is evidence, and evidence
 * that cannot be trusted is a failing check, not a missing file.
 */
export async function captureTruthfully(
  contents,
  { nonce, attempts = 4, settleMs = 140, invalidate = true, captureTimeoutMs = 10_000 } = {},
) {
  let last = null
  let image = null
  let frame = null
  let used = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const thisNonce = Number(nonce) + attempt
    used = attempt + 1
    /* Cleared per attempt, so a later failure can never hand the caller an
       earlier attempt's frame beside a verdict that describes this one. */
    image = null
    frame = null
    let painted = null
    try {
      painted = await bounded(contents.executeJavaScript(plantProbeScript(thisNonce)), 15_000, 'planting the probe')
      await bounded(contents.executeJavaScript(PAINT_SETTLED), 15_000, 'waiting for a paint')
    } catch (error) {
      last = couldNotTell('the page would not accept the freshness probe', error)
      continue
    }
    /* Offscreen rendering composites on demand; without this the first frame
       after a change is not composited yet (measured in this repo by
       tools/ring-capture-main.cjs, which invalidates before every shot). */
    if (invalidate && typeof contents.invalidate === 'function') {
      try { contents.invalidate() } catch { /* a windowed contents may not need it */ }
    }
    await sleep(settleMs)
    try {
      /* BOUNDED. capturePage() goes through Chromium's viz compositor, which
         has wedged and has thrown UnknownVizError mid-run in this repository
         before; an unbounded await there turns one flaky screenshot into a
         harness that never returns and reports nothing at all. */
      image = await bounded(contents.capturePage(), captureTimeoutMs, 'capturePage()')
    } catch (error) {
      last = couldNotTell('capturePage() failed', error)
      await sleep(250)
      continue
    }
    try {
      /* A successful capturePage() call does not guarantee that Electron can
         read the returned NativeImage. Keep bitmap conversion inside the same
         failure boundary as capturePage(), or a toBitmap()/getSize() failure
         rejects the whole helper and leaves its probe in the page. */
      frame = frameOf(image)
      last = assessCapture(frame, { nonce: thisNonce })
    } catch (error) {
      image = null
      frame = null
      last = couldNotTell('the captured image could not be read', error)
      await sleep(250)
      continue
    }
    last.painted = painted
    if (last.truthful) break
    await sleep(200)
  }
  try { await bounded(contents.executeJavaScript(removeProbeScript()), 10_000, 'removing the probe') }
  catch { /* the page is going away anyway */ }
  return { verdict: last, image, frame, attempts: used }
}
